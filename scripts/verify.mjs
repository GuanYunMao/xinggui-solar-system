// 真实浏览器验收：桌面 + 手机两个视口 + 交互 + 单文件版本。
// 用系统自带 Edge（playwright-core 不下载 Chromium），软件光栅化跑 WebGL。
// 判定标准：画布真的渲染（window.__solarReady）、控制台零报错、无横向溢出。
// 数值断言（帧时间 / 命中矩阵 / 跟随抖动）一律「相对本次运行的机器基线」判，不吃机器负载。
// 怎么跑、每个 pass 验什么、红了先看哪一行：scripts/README.md。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// 运行归档：把每次的 results + 环境指纹落盘，让失败证据活过终端（详见该文件头部注释）
import { archiveVerifyRun, readIndex } from "./verify-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 产物的根目录。默认 release/。想验一份**冻结快照**时用 XG_RELEASE 指过去
// （另一个 agent 正在 `npm run build` 时，release/ 会被 rm+重建，页面会抓到半成品：
//   表现为 __solarReady 未置位 + 资源 404 或莫名的 ReferenceError）。
// 目录结构要和 release/ 一致：`site/` + `巡星.html`。
const RELEASE = process.env.XG_RELEASE ? path.resolve(process.env.XG_RELEASE) : path.join(root, "release");
const SITE = path.join(RELEASE, "site");
const SINGLE = path.join(RELEASE, "巡星.html");
const SHOTS = path.join(root, "screenshots");
// 浏览器可执行文件。默认用系统 Edge（不下载 Chromium）；CI 或别的机器上用
// XG_EDGE 指过去，比如 XG_EDGE=/usr/bin/chromium。
const EDGE =
  process.env.XG_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4178;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// 起点端口。被占用就往后找 —— 这台机器上常常同时有别的验收/预览在跑，
// 直接 listen 失败会甩一个 EADDRINUSE 堆栈，看起来像产品坏了，其实只是撞端口。
function startServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = path.join(SITE, rel);
      if (!file.startsWith(SITE)) throw new Error("escape");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function startServerOnFreePort(preferred) {
  for (let i = 0; i < 20; i++) {
    try {
      return { server: await startServer(preferred + i), port: preferred + i };
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`端口 ${preferred}–${preferred + 19} 全被占用`);
}

const failures = [];

// ——— 帧时间断言的机器基线（详见 scripts/README.md）————————————————
// 同一条代码，实测空闲机器稳态 EMA 18.6ms / hitch 0，忙碌机器 38–44ms / hitch 2–18。
// 写死的绝对阈值（EMA ≤ 26ms）在忙碌机器上必红，红了也说明不了代码有问题 —— 等于没断言。
//
// 为什么不用「about:blank + 空 rAF 循环」当基线：实测（i5-2250H / 14 线程 / 负载 97%）
// 空循环 EMA 稳定在 16.7–16.9ms，而同一时刻的遥测页是 21.9–44.4ms。空循环每帧几乎不干活，
// vsync 一到就交卷，它测的是「vsync 节拍」；遥测页的帧时间是「单帧光栅量 ÷ 可用光栅吞吐」。
// 两者不同源，除出来的比值忙时 2.2×、闲时 1.1×，负载因素原样留在里面。
//
// 所以基线要「吃同一份资源」：一个 1280×720 全屏定量着色器页（片元里 24 次迭代），
// 每帧固定刷 CAL_PASSES 遍。它和遥测页一样是 CPU 光栅受限，忙时一起慢、闲时一起快。
// 实测同一台忙碌机器五轮：场景 EMA 41.2 / 45.8ms，基线 EMA 45.4 / 51.5ms，比值 0.90 / 0.89；
// 按「单 pass 6.0ms@忙、场景 18.6ms@闲」外推空闲态比值 ≈ 0.85。据此定阈值：
//   EMA_RATIO_MAX = 1.6
//     · 与旧断言同严格度：旧阈值 26ms 在 60Hz 紧公差机器上就是 26/16.7 = 1.56×；
//     · 相对实测 0.85–0.91 留 1.75× 裕量：够抓「单帧光栅量翻倍」的真回归，不给负载误伤。
//   已知盲区（写在这里免得下次有人把它当万能断言）：同一版代码的比值实测摆到 0.44–0.90
//   （忙 0.44–0.61、闲 0.55、更早一轮探针 0.89–0.90），所以 1.6 能抓 2.5× 以上、抓不住 1.5×。
//   要更细只能关掉机器上别的东西、在安静状态下用绝对阈值复核。
// 基线页若被 vsync 钉住（闲机器上 8 pass 也可能塞进一帧），分母取 max(基线, vsync)，
// 此时断言自动退化成旧断言 —— 没信息的时候不假装有信息。
// 尾巴（p95 / hitch）用同一把尺子：HITCH_FACTOR = 2.5 倍的「机器基线」。
// 50ms 地板和旧判据同源：60Hz 机器上 2.5 × 16.7 = 42ms < 50，仍按 50ms 算。
const CAL_PASSES = 8;
const CAL_ITER = 24;
const EMA_RATIO_MAX = 1.6;
const P95_RATIO_MAX = 2.5;
const HITCH_MIN_MS = 50;
const HITCH_FACTOR = 2.5;
const HITCH_ALLOWANCE = 2; // **告警线**（不再判红，t45）：150 帧里超过 2 次就提醒，但不进 failures

const CAL_HTML = `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
<canvas id="c" width="1280" height="720" style="width:1280px;height:720px"></canvas>
<script>
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false });
const vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
const fs = 'precision highp float; uniform float uT;\\n' +
  'void main(){ vec2 z = gl_FragCoord.xy * 0.01 + uT; float a = 0.0;\\n' +
  '  for (int i = 0; i < ${CAL_ITER}; i++) { z = vec2(z.x*0.9 + z.y*0.11, z.y*0.9 - z.x*0.07); a += sin(z.x)*cos(z.y); }\\n' +
  '  gl_FragColor = vec4(fract(a*0.01), 0.0, 0.0, 1.0); }';
function sh(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'p');
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const uT = gl.getUniformLocation(prog, 'uT');
gl.viewport(0, 0, canvas.width, canvas.height);
let passes = ${CAL_PASSES};
let frame = 0;
window.__setPasses = (n) => { passes = n; };
(function tick() {
  for (let i = 0; i < passes; i++) { gl.uniform1f(uT, (frame + i) * 0.001); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  frame++;
  requestAnimationFrame(tick);
})();
window.__calReady = true;
</script></body></html>`;

// 采 n 帧的帧间隔原始值。统计放到 Node 侧做，是为了让「场景」和「基线」能用
// 同一个卡顿阈值 —— 各自按自己的中位数算阈值，两边的 hitch 次数根本不可比。
async function collectDeltas(page, frames = 150) {
  return page.evaluate(async (n) => {
    const deltas = [];
    await new Promise((resolve) => {
      let prev = performance.now();
      let i = 0;
      const tick = () => {
        const now = performance.now();
        deltas.push(now - prev);
        prev = now;
        if (++i < n) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return deltas;
  }, frames);
}

// 帧间隔统计。hitch 阈值由调用方给：判定用「机器基线 × HITCH_FACTOR」，留档用各段自己的中位数。
function statsOf(deltas, hitchThresholdMs) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  let ema = deltas[0];
  for (const d of deltas) ema = ema * 0.9 + d * 0.1;
  return {
    frames: deltas.length,
    median: +median.toFixed(1),
    p95: +p95.toFixed(1),
    ema: +ema.toFixed(1),
    ratio: +(p95 / median).toFixed(2),
    hitch: deltas.filter((d) => d > hitchThresholdMs).length,
    hitch50: deltas.filter((d) => d > HITCH_MIN_MS).length, // 旧判据口径，只留档不判红
    hitchThresholdMs: +hitchThresholdMs.toFixed(1),
  };
}

const ownThreshold = (deltas) =>
  Math.max(
    HITCH_MIN_MS,
    HITCH_FACTOR * [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)],
  );

// 量一次机器基线：vsync 节拍（空白页）+ 光栅吞吐（定量着色器页）。
// 必须在遥测页开始渲染**之前/之后**单独跑，不能和它同时开着 ——
// 两个全屏 WebGL 页会互相抢光栅，分母会被自己测高。
async function measureBaseline(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const blank = await ctx.newPage();
    await blank.goto("about:blank");
    await blank.waitForTimeout(300);
    const vsyncDeltas = await collectDeltas(blank, 120);
    const vsync = statsOf(vsyncDeltas, ownThreshold(vsyncDeltas));
    const cal = await ctx.newPage();
    const errors = [];
    cal.on("pageerror", (err) => errors.push(err.message));
    await cal.setContent(CAL_HTML, { waitUntil: "load" });
    await cal.waitForFunction(() => window.__calReady === true, null, { timeout: 20000 });
    await cal.waitForTimeout(300);
    await cal.evaluate(() => window.__setPasses(1));
    const onePassDeltas = await collectDeltas(cal, 40); // 只记录：闲机器上它会被 vsync 钉住
    await cal.evaluate((n) => window.__setPasses(n), CAL_PASSES);
    const rasterDeltas = await collectDeltas(cal, 60);
    return {
      vsync,
      onePass: statsOf(onePassDeltas, ownThreshold(onePassDeltas)),
      raster: statsOf(rasterDeltas, ownThreshold(rasterDeltas)),
      vsyncDeltas,
      rasterDeltas,
      errors,
    };
  } finally {
    await ctx.close();
  }
}

const denomOf = (baseline) => Math.max(baseline.raster.ema, baseline.vsync.ema);

// 判定：绝对值只记录，不判红；判的是「场景 ÷ 基线」的比值。
// 两个判据共用一把尺子：分母 = 本次机器基线，阈值都是它的倍数。
//   EMA  ≤ 1.6 × 分母   —— 稳态帧率
//   p95  ≤ 2.5 × 分母   —— 不能有一半的帧慢到 2.5 倍
//   hitch（超阈帧数）**只记录 + 告警，不判红**（t45，理由见下方那段注释）
// 2.5 这个数在 50ms 地板上和旧判据同源：60Hz 机器上 2.5 × 16.7 = 42ms < 50，仍按 50ms 算。
function judgeFrameTime(ft, steadyDeltas, baselines) {
  const denominator = Math.max(...baselines.map(denomOf));
  const hitchThreshold = Math.max(HITCH_MIN_MS, HITCH_FACTOR * denominator);
  const hitches = steadyDeltas.filter((d) => d > hitchThreshold).length;
  const baselineHitches = Math.max(
    ...baselines.flatMap((b) => [
      b.rasterDeltas.filter((d) => d > hitchThreshold).length,
      b.vsyncDeltas.filter((d) => d > hitchThreshold).length,
    ]),
  );
  ft.steady = statsOf(steadyDeltas, hitchThreshold);
  ft.normalized = {
    denominatorMs: +denominator.toFixed(1),
    ema: +(ft.steady.ema / denominator).toFixed(2),
    emaMax: EMA_RATIO_MAX,
    p95: +(ft.steady.p95 / denominator).toFixed(2),
    p95Max: P95_RATIO_MAX,
    hitch: hitches,
    hitchThresholdMs: +hitchThreshold.toFixed(1),
    hitchMax: HITCH_ALLOWANCE,
    baselineHitches, // 同一把尺子量基线页：留档，说明这台机器本身抖不抖
    // 留档的旧判据：只记录、不判红。留着它是为了在同一份采样上直接对比
    // 「老规矩会不会红」，免得拿两次不同机器状态的运行互相比。
    legacy: {
      emaMs: ft.steady.ema,
      emaWasMax: 26,
      p95OverMedian: ft.steady.ratio,
      p95OverMedianWasMax: 1.5,
      hitch50: ft.steady.hitch50,
      hitch50WasMax: 0,
      wouldFail: ft.steady.ema > 26 || ft.steady.ratio > 1.5 || ft.steady.hitch50 > 0,
    },
  };
  const n = ft.normalized;
  if (n.ema > EMA_RATIO_MAX) {
    failures.push(
      `frame-time: 归一化 EMA ${n.ema}× > ${EMA_RATIO_MAX}×（分母 ${n.denominatorMs}ms，场景 ${ft.steady.ema}ms）`,
    );
  }
  if (n.p95 > P95_RATIO_MAX) {
    failures.push(
      `frame-time: 归一化 p95 ${n.p95}× > ${P95_RATIO_MAX}×（分母 ${n.denominatorMs}ms，场景 ${ft.steady.p95}ms）`,
    );
  }
  // ——— hitch：从「判红」降级为「记录 + 告警」（t45）———
  // 为什么不判红：它是**观测量**，量的是「150 帧里有几帧超过 2.5×机器基线」，而被超的那几帧
  // 在共享机器上主要由 CPU 争抢决定。实测证据（同一份代码、同一天）：
  //   peak 时 median 34.3ms / 归一化 EMA 1.05（通过）/ 却 hitch 5 > 2，同期 22 个浏览器进程，
  //   重跑即绿。历史 10 次运行里 `baselineHitches` 常为 0 而场景仍可能 5 次 ——
  //   所以「按基线占比归一化」救不了（0 的倍数还是 0），这条路先排除。
  // 它原有的信号已被归一化的 EMA（≤1.6×）与 p95（≤2.5×）覆盖：那两条是同一次运行内自比、
  // 标定过余量、盲区写明的。hitch 只保留趋势与告警，见 README「frame-time 的红线怎么读」。
  // 代价（写在 README 里）：<5% 帧的稀疏卡顿不再判红（p95 是 95 分位，管不到 2% 的尖峰）。
  n.hitchExceeded = hitches > HITCH_ALLOWANCE;
  if (n.hitchExceeded) {
    console.error(
      `（注意）frame-time: 稳态 hitch ${hitches} 次 > 告警线 ${HITCH_ALLOWANCE} 次` +
        `（阈值 ${n.hitchThresholdMs}ms，基线页同时段 ${baselineHitches} 次，稳态 median ${ft.steady.median}ms）` +
        ` —— 仅告警不判红；连续多次都超时再怀疑产品侧的周期性阻塞`,
    );
  }
}

// ——— 画布像素体检：抓「场景一笔没画」这类整屏黑 ————————————————————
// 为什么要有这条：9 个 pass 曾经在一次「画布全黑」的构建上全绿（2026-10-24 实测，draws:0/tris:0）。
// 因为它们只验自己看得懂的那一层——__solarReady 置位、canvas 数量、DOM 文本、__solarProbe 的
// JS 几何。这些都是「数据层说得通」，而用户眼睛看到的是黑的。真正抓住它的是 proto-jitter
// 的像素回读，纯属偶然。所以每个开浏览器的 pass 都补一条：读画布上的 25 个块看亮度。
//
// 前提：preserveDrawingBuffer 必须为真，否则 readPixels 永远返回 0 —— 那会把「读不到」
// 误判成「黑屏」。所以导航时统一追加 ?diag=1（SolarCanvas 的 READBACK 由 proto|legacy|diag
// 触发）；万一属性不是 true，就标 available:false 不判红，免得冤枉产品。
const BLACK_LUM_MIN = 2; // 健康画布的背景是 #07090e ≈ 8.9/255，留 4× 余量

const withDiag = (url) => {
  const u = new URL(url);
  if (!u.searchParams.has("diag")) u.searchParams.set("diag", "1");
  return u.href;
};

async function sampleCanvasPixels(page) {
  return page.evaluate(async (blackLumMin) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { available: false, reason: "没有 canvas" };
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return { available: false, reason: "拿不到 WebGL 上下文" };
    const attrs = gl.getContextAttributes?.() ?? {};
    if (!attrs.preserveDrawingBuffer) {
      return { available: false, reason: "preserveDrawingBuffer=false（读回来必是 0，不能当黑屏）" };
    }
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return { available: false, reason: "画布尺寸为 0" };
    // 合成之后才读，避免读到半帧
    await new Promise((r) => requestAnimationFrame(() => r()));
    const lums = [];
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
        const x = Math.min(W - 8, Math.max(0, Math.round(fx * (W - 8))));
        const y = Math.min(H - 8, Math.max(0, Math.round(fy * (H - 8))));
        const buf = new Uint8Array(8 * 8 * 4);
        gl.readPixels(x, y, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        }
        lums.push(sum / 64);
      }
    }
    const meanLum = lums.reduce((a, b) => a + b, 0) / lums.length;
    const nonBlack = lums.filter((l) => l >= blackLumMin).length;
    return {
      available: true,
      width: W,
      height: H,
      meanLum: +meanLum.toFixed(2),
      maxLum: +Math.max(...lums).toFixed(2),
      nonBlackRatio: +(nonBlack / lums.length).toFixed(2),
      grid: lums.map((l) => +l.toFixed(1)),
    };
  }, BLACK_LUM_MIN);
}

// 判红：整屏黑（平均亮度地板）或大部分块是全黑
function judgeCanvasPixels(name, px) {
  if (!px || !px.available) return; // 读不到就明说，不冤枉产品
  if (px.meanLum < BLACK_LUM_MIN || px.nonBlackRatio < 0.5) {
    failures.push(
      `${name}: 画布是黑的（平均亮度 ${px.meanLum}、非黑块占比 ${px.nonBlackRatio}、${px.width}×${px.height}）` +
        ` —— 场景可能一笔没画（先看 __solarProbe 的几何是否正常，再看 draws/tris）`,
    );
  }
}

// ——— 画布质量探针（t45）：手机 dpr 红线 ————————————————
// 断言对象是**实测值** `__solarQuality().effectiveDpr`（= canvas.width / clientWidth，由 DOM 现算），
// **不许**从配置里读 `dprCap`：上一版就是配 1.25、实测 1.249 ——
// `canvas.width = floor(cssW × dpr)`，390×1.25 = 487.5 → 487 → 1.249，红线被破了自己不知道。
// 只在 `pointerCoarse === true` 时判：桌面 dpr=1 天经地义，硬抬到 1.25 等于凭空多烧 56% 光栅。
// 分类：**结构量**（DOM 现算的比值，与机器快慢无关），可以判红。
async function readQuality(page) {
  return page.evaluate(() => {
    const api = window.__solarQuality;
    if (!api) return { available: false, reason: "__solarQuality 不存在" };
    const q = api();
    return {
      available: true,
      pointerCoarse: Boolean(q.pointerCoarse),
      effectiveDpr: q.effectiveDpr,
      mobileDprFloor: q.mobileDprFloor,
      dprCap: q.dprCap,
      tier: q.tier,
      tierName: q.name,
      canvasCss: q.canvasCss,
      canvasDevice: q.canvasDevice,
    };
  });
}

function judgeQuality(name, q) {
  if (!q) return;
  if (!q.available) {
    // 探针没了 = 这条红线又没人守了，必须红（否则就是「静默失去一条守卫」）
    failures.push(`${name}: 读不到 __solarQuality（${q.reason}）—— 手机 dpr 红线会失去守卫`);
    return;
  }
  if (!q.pointerCoarse) return; // 桌面不判
  const ok = typeof q.effectiveDpr === "number" && q.effectiveDpr >= q.mobileDprFloor;
  if (!ok) {
    failures.push(
      `${name}: 手机 dpr 实测 ${q.effectiveDpr} < 红线 ${q.mobileDprFloor}` +
        `（画布设备像素 ${q.canvasDevice?.w}×${q.canvasDevice?.h} / CSS ${q.canvasCss?.w}×${q.canvasCss?.h}，tier ${q.tier} 的 dprCap ${q.dprCap}）`,
    );
  }
}

// ——— 缩放 / 星空采样（t33）————————————————————————————
// 读太阳的「相机到中心距离」与屏幕半径。距离只有 `__solarPick.candidates()` 的 depth 能直接给：
// `__solarClip()` 的 near 在贴近时被 nearMin(0.06) 夹住、far 恒为 983，反推不出距离；探针的 z 是 NDC，
// 要靠 near/far 反解，同样被夹死。所以这里的可用性检查是硬条件——钩子没了就判不了，要红。
async function readSunState(page) {
  return page.evaluate(() => {
    const api = window.__solarPick;
    if (!api?.candidates) return { available: false, reason: "__solarPick.candidates 不存在" };
    const list = api.candidates() ?? [];
    const sun = list.find((c) => c.id === "sun");
    if (!sun) return { available: false, reason: `候选里没有 sun（共 ${list.length} 条）` };
    return { available: true, depth: sun.depth, radiusPx: sun.radiusPx };
  });
}

// 星空亮度：取画布**边缘 12 块**（4×4 网格跳过中央 2×2），16×16 像素/块。
// 为什么不是全画布：中间坐着太阳/行星，任何全屏统计都会被天体亮度主导；
// 「星空有没有过曝」问的是背景区，所以避开中央。这也让这条与「画布不是全黑」互补 ——
// 那条要的是全画布 meanLum ≥ 2（判"画出来没有"），这条要的是边缘 mean ≤ 4×背景（判"星星抢不抢戏"）。
async function sampleSkyLuma(page, bgLuma, maxRatio) {
  return page.evaluate(
    async ({ bgLuma, maxRatio }) => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return { available: false, reason: "没有 canvas" };
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) return { available: false, reason: "拿不到 WebGL 上下文" };
      const attrs = gl.getContextAttributes?.() ?? {};
      if (!attrs.preserveDrawingBuffer) {
        return { available: false, reason: "preserveDrawingBuffer=false（读回来必是 0，不能当亮度）" };
      }
      const W = canvas.width;
      const H = canvas.height;
      const SIZE = 16;
      if (W < SIZE * 2 || H < SIZE * 2) return { available: false, reason: "画布太小" };
      await new Promise((r) => requestAnimationFrame(() => r()));
      const fracs = [0, 1 / 3, 2 / 3, 1];
      const blocks = [];
      for (let gy = 0; gy < 4; gy++) {
        for (let gx = 0; gx < 4; gx++) {
          if ((gx === 1 || gx === 2) && (gy === 1 || gy === 2)) continue; // 跳过中央 2×2
          const x = Math.min(W - SIZE, Math.max(0, Math.round(fracs[gx] * (W - SIZE))));
          const y = Math.min(H - SIZE, Math.max(0, Math.round(fracs[gy] * (H - SIZE))));
          const buf = new Uint8Array(SIZE * SIZE * 4);
          gl.readPixels(x, y, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 4) {
            sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
          }
          blocks.push(sum / (SIZE * SIZE));
        }
      }
      const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
      const sorted = [...blocks].sort((a, b) => a - b);
      return {
        available: true,
        blocks: blocks.length,
        mean: +mean.toFixed(2),
        median: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        max: +Math.max(...blocks).toFixed(2),
        bgLuma: +bgLuma.toFixed(2),
        cap: +(bgLuma * maxRatio).toFixed(2),
        ratioOverBg: +(mean / bgLuma).toFixed(2),
      };
    },
    { bgLuma, maxRatio },
  );
}

// ——— 手机 HUD 交互五条：把「全都工作但 0/5 被守」补成 5/5 ————————
// 病根（2026-10-24 实测）：下面这五条交互在当时都工作，但 verify 里一条断言都没有——
// 删掉 `skipClick`、把 `SHEET_MAX.bar` 从 7rem 改回 28dvh、把 `.eyebrow` 放出来，
// verify 和 CI 都会全绿。所以它们补的是一类"静默回归"。
//
// 判据分类：**全部是结构量**（DOM 属性 / 精确计数 / 同一次运行内自比），没有一条读观测量
// 或绝对毫秒。唯一**只记录不判**的是「松手后浏览器补发的 click 次数」——那是浏览器行为，
// 不是产品设计值，判它等于给 Chrome 版本上锁。
//
// 两条踩过的坑（别重新踩）：
//   1. 触摸必须走 CDP `Input.dispatchTouchEvent`。`page.mouse` 是鼠标，touchEnd 之后浏览器
//      不会补发 click，第二条判据的靶子（skipClick 吃掉补发 click）就消失了；
//      `page.evaluate` 里 `dispatchEvent` 不是可信事件，同样不补发。
//   2. 每步都要**重新量把手坐标**：详情卡收起后把手从 y≈351 挪到 y≈604，复用旧坐标会点在
//      画布上（第一次写这个夹具时就这么点空了）。
//
// 挂载点：`run()` 里 `page.screenshot()` **之后**。既有那四张图是人工复核的基准，
// 夹具会把卡片停在「收起」档，放在截图前会把基准改掉。
const HUD_HANDLE = 'article button[aria-label^="详情卡高度"]';
const hudTier = (state) => (state?.tier ?? "").replace(/^详情卡高度：/, ""); // 全屏 / 半屏 / 收起

async function touchOf(context, page) {
  const cdp = await context.newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }];
  return {
    tap: async (x, y) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x, y) });
      await page.waitForTimeout(40);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(200);
    },
    drag: async (x0, y0, x1, y1, steps = 8) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x0, y0) });
      await page.waitForTimeout(30);
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: pt(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k),
        });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(60);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(320);
    },
  };
}

// 把手随档位上下移动 —— 每次调用都重新量，不缓存
async function centerOf(page, sel) {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) throw new Error(`量不到 ${sel} 的位置`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const readHeaderState = (page) =>
  page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1) };
    };
    const header = document.querySelector("header");
    const epoch = document.querySelector("header p.text-lg");
    const leftGroup = header?.children?.[0] ?? null;
    const version = document.querySelector("header .eyebrow");
    return {
      epoch: epoch
        ? { text: epoch.innerText.trim(), ...box(epoch), display: getComputedStyle(epoch).display }
        : null,
      leftRight: leftGroup ? box(leftGroup).right : null,
      versionDisplay: version ? getComputedStyle(version).display : null,
      headerOverX: header ? header.scrollWidth - header.clientWidth : null,
      innerW: innerWidth,
    };
  });

const readLayerState = (page) =>
  page.evaluate(() => ({
    overlay: document.querySelectorAll('[data-overlay-open="true"]').length,
    expanded: document.querySelector('button[aria-label="图层"]')?.getAttribute("aria-expanded") ?? null,
  }));

const readCardState = (page) =>
  page.evaluate(() => {
    const card = document.querySelector("article");
    const handle = document.querySelector('article button[aria-label^="详情卡高度"]');
    if (!card || !handle) return null;
    const dl = card.querySelector("dl");
    return {
      tier: handle.getAttribute("aria-label"),
      h: +card.getBoundingClientRect().height.toFixed(1),
      maxH: getComputedStyle(card).maxHeight,
      cols: dl ? getComputedStyle(dl).gridTemplateColumns.split(" ").length : null,
      h2: card.querySelector("h2")?.innerText?.trim() ?? null,
    };
  });

const readChipsState = (page) =>
  page.evaluate(() => {
    const row = document.querySelector("#chip-row");
    const btn = document.querySelector('button[aria-label="天体列表"]');
    if (!row || !btn) return null;
    return {
      h: +row.getBoundingClientRect().height.toFixed(1),
      overX: row.scrollWidth - row.clientWidth,
      wrap: getComputedStyle(row).flexWrap,
      expanded: btn.getAttribute("aria-expanded"),
      text: btn.textContent.trim(),
      count: row.querySelectorAll('button[id^="chip-"]').length,
    };
  });

/**
 * 跑手机 HUD 五条夹具。
 * mode="locked"：390 全新 context（localStorage 空，徽标是锁态），跑完整五条。
 * mode="unlocked"：调用方已注入 gate 的 3 槽，只补「抬头」这一格样本——
 *   它是 390 下最紧的已校准态（徽标更宽），所以抬头押在最紧处。
 */
async function runMobileHud(page, context, mode) {
  const header = await readHeaderState(page);
  if (mode === "unlocked") return { mode, header };

  const touch = await touchOf(context, page);
  const hud = { mode, header };

  // ① 图层浮层：开 → 再点一次必须收回（守的是「开得出来但收不回去」）
  await page.locator('button[aria-label="图层"]').tap();
  await page.waitForTimeout(200);
  hud.layerOpen = await readLayerState(page);
  await page.locator('button[aria-label="图层"]').tap();
  await page.waitForTimeout(200);
  hud.layerClosed = await readLayerState(page);

  // ⑤ 星球列表：收起 ⇄ 展开 ⇄ 收起。放在选天体之前（此时 chip 是初始那一批）
  hud.chipsCollapsed0 = await readChipsState(page);
  await page.locator('button[aria-label="天体列表"]').tap();
  await page.waitForTimeout(250);
  hud.chipsExpanded = await readChipsState(page);
  await page.locator('button[aria-label="天体列表"]').tap();
  await page.waitForTimeout(250);
  hud.chipsCollapsed1 = await readChipsState(page);

  // ② 详情卡手势：前置是选中地球（卡片才出现，停在半屏）
  await page.locator("#chip-earth").tap();
  await page.waitForSelector("article h2", { timeout: 10000 });
  await page.waitForTimeout(1500); // 等镜头聚焦动画走完
  // 只记录：浏览器会在 touchEnd 后补发 click。数它，不判它。
  await page.evaluate(() => {
    window.__xgHudClicks = 0;
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target instanceof Element ? e.target.closest('[aria-label^="详情卡高度"]') : null;
        if (t) window.__xgHudClicks++;
      },
      true,
    );
  });

  const card0 = await readCardState(page);
  let hp = await centerOf(page, HUD_HANDLE);
  let clicks = await page.evaluate(() => window.__xgHudClicks);
  await touch.drag(hp.x, hp.y, hp.x, hp.y - 15, 5); // 小位移：死区，不动
  const card15 = await readCardState(page);
  const synthesizedClicks = (await page.evaluate(() => window.__xgHudClicks)) - clicks;

  hp = await centerOf(page, HUD_HANDLE);
  await touch.drag(hp.x, hp.y, hp.x + 30, hp.y, 6); // 横滑：这是一张竖抽屉，不动
  const card30 = await readCardState(page);

  hp = await centerOf(page, HUD_HANDLE);
  await touch.drag(hp.x, hp.y, hp.x, hp.y - 80, 8); // 上拖：只走一档到全屏
  const cardFull = await readCardState(page);

  hp = await centerOf(page, HUD_HANDLE);
  await touch.drag(hp.x, hp.y, hp.x, hp.y + 80, 8); // 下拖：只走一档回半屏
  const cardBack = await readCardState(page);

  hud.card = { start: card0, small: card15, side: card30, full: cardFull, back: cardBack, synthesizedClicks };

  // ③ 收起高度：tap（无位移）从半屏落到「收起」
  hp = await centerOf(page, HUD_HANDLE);
  await touch.tap(hp.x, hp.y);
  await page.waitForTimeout(250);
  hud.bar = await readCardState(page);
  // 7rem 要按**运行时**根字号换算：用户改浏览器字号时 rem 会变，写死 112 会误红
  hud.rootPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  return hud;
}

// P4 抬头：每条都是二值/精确比较，没有经验阈值。
// ⚠ 盲区（写进 README，别以为它守住了更多）：把 1.2.1 之前的样式注回去，390 下模拟历
// **也**不会越界（实测间距仍有 32.5–52.5px），所以这条抓不住「顶部重排被整体回滚」；
// 「版本号让位」只能靠 .eyebrow display 那一条单独守。它真正会红的是「抬头又变宽到装不下」。
function judgeHudHeader(sample, mode) {
  const p = `hud-header（${mode}）`;
  if (!sample) return failures.push(`${p}: 读不到抬头`);
  if (!sample.epoch) return failures.push(`${p}: 抬头里没有模拟历（header p.text-lg）`);
  if (!sample.epoch.text) failures.push(`${p}: 模拟历是空文本`);
  if (sample.epoch.display === "none") failures.push(`${p}: 模拟历 display=none（被隐藏）`);
  if (sample.epoch.left < -0.5 || sample.epoch.right > sample.innerW + 0.5) {
    failures.push(`${p}: 模拟历跑出视口（[${sample.epoch.left}..${sample.epoch.right}] vs 视口宽 ${sample.innerW}）`);
  }
  if (sample.leftRight !== null && sample.leftRight > sample.epoch.left + 0.5) {
    failures.push(`${p}: 模拟历被左侧品牌组压住（品牌组右缘 ${sample.leftRight} > 模拟历左缘 ${sample.epoch.left}）`);
  }
  if (sample.headerOverX > 1) failures.push(`${p}: 抬头自身横向溢出 ${sample.headerOverX}px`);
  if (sample.innerW < 640 && sample.versionDisplay !== "none") {
    failures.push(`${p}: 窄屏 ${sample.innerW}px 下版本号没让位（header .eyebrow display=${sample.versionDisplay}）`);
  }
}

function judgeHudLocked(hud) {
  // ① 图层浮层（P1）
  if (!hud.layerOpen || !hud.layerClosed) {
    failures.push("hud-layer: 读不到浮层状态");
  } else {
    if (hud.layerOpen.overlay !== 1) failures.push(`hud-layer: 点开后 [data-overlay-open="true"] 计数 ${hud.layerOpen.overlay} ≠ 1`);
    if (hud.layerOpen.expanded !== "true") failures.push(`hud-layer: 点开后 aria-expanded=${hud.layerOpen.expanded}，期望 true`);
    if (hud.layerClosed.overlay !== 0) {
      failures.push(`hud-layer: 第二次点开后没收起（[data-overlay-open="true"] 计数 ${hud.layerClosed.overlay}，期望 0）`);
    }
    if (hud.layerClosed.expanded !== "false") failures.push(`hud-layer: 收起后 aria-expanded=${hud.layerClosed.expanded}，期望 false`);
  }

  // ② 详情卡手势（P2）
  const c = hud.card;
  if (!c?.start || !c.small || !c.side || !c.full || !c.back) {
    failures.push("hud-gesture: 量不到详情卡状态");
  } else {
    if (hudTier(c.small) !== hudTier(c.start)) {
      failures.push(`hud-gesture: 竖向蹭 15px 就换档（${hudTier(c.start)} → ${hudTier(c.small)}）—— 死区/skipClick 被改坏了？`);
    }
    if (Math.abs(c.small.h - c.start.h) > 1) {
      failures.push(`hud-gesture: 竖向蹭 15px 后卡片高度变了 ${c.start.h} → ${c.small.h}px（应 ≤1px）`);
    }
    if (hudTier(c.side) !== hudTier(c.start)) {
      failures.push(`hud-gesture: 横向蹭 30px 换了档（${hudTier(c.start)} → ${hudTier(c.side)}）—— 这是一张竖抽屉`);
    }
    if (hudTier(c.full) !== "全屏") failures.push(`hud-gesture: 上拖 80px 后档位是「${hudTier(c.full)}」，期望「全屏」（只走一档）`);
    if (c.full.cols !== 1) failures.push(`hud-gesture: 全屏档 dl 是 ${c.full.cols} 列，期望 1 列`);
    if (hudTier(c.back) !== "半屏") failures.push(`hud-gesture: 下拖 80px 后档位是「${hudTier(c.back)}」，期望「半屏」（只走一档）`);
  }

  // ③ 收起高度（P3）
  const b = hud.bar;
  if (!b) {
    failures.push("hud-card-bar: 量不到收起态");
  } else {
    if (hudTier(b) !== "收起") failures.push(`hud-card-bar: 档位是「${hudTier(b)}」，期望「收起」`);
    if (!(b.h <= hud.rootPx * 7 + 1)) {
      failures.push(`hud-card-bar: 收起后 article 高 ${b.h}px > 7rem(${(hud.rootPx * 7).toFixed(1)}px)+1 —— SHEET_MAX.bar 被改大了？`);
    }
    if (Math.abs(parseFloat(b.maxH) - hud.rootPx * 7) > 0.5) {
      failures.push(`hud-card-bar: computed max-height ${b.maxH} ≠ 7rem(${(hud.rootPx * 7).toFixed(1)}px)`);
    }
    if (b.h2 !== "地球") failures.push(`hud-card-bar: 收起后卡片标题是「${b.h2}」，期望「地球」—— 收起不等于消失`);
  }

  // ⑤ 星球列表（P5）
  const c0 = hud.chipsCollapsed0;
  const c1 = hud.chipsExpanded;
  const c2 = hud.chipsCollapsed1;
  if (!c0 || !c1 || !c2) {
    failures.push("hud-chips: 读不到星球列表状态");
  } else {
    if (c0.expanded !== "false") failures.push(`hud-chips: 初始 aria-expanded=${c0.expanded}，期望 false`);
    if (!/^全部 \d+$/.test(c0.text)) {
      failures.push(`hud-chips: 初始按钮文本「${c0.text}」不匹配 /^全部 \\d+$/`);
    } else if (Number(c0.text.match(/\d+/)[0]) !== c0.count) {
      failures.push(`hud-chips: 按钮写「${c0.text}」但行里只有 ${c0.count} 颗 chip`);
    }
    if (c0.overX <= 20) {
      failures.push(`hud-chips: 收起态横向只溢出 ${c0.overX}px（≤20）—— 本来就不该溢出，这条判据失去了前提`);
    }
    if (c1.expanded !== "true") failures.push(`hud-chips: 展开后 aria-expanded=${c1.expanded}，期望 true`);
    if (c1.text !== "收起") failures.push(`hud-chips: 展开后按钮文本「${c1.text}」，期望「收起」`);
    if (c1.wrap !== "wrap") failures.push(`hud-chips: 展开后 flex-wrap=${c1.wrap}，期望 wrap`);
    if (c1.overX > 1) failures.push(`hud-chips: 展开后仍横向溢出 ${c1.overX}px`);
    if (!(c1.h > c0.h + 20)) failures.push(`hud-chips: 展开后行高 ${c1.h}px 没比收起态 ${c0.h}px 高 20px 以上`);
    if (c2.expanded !== "false") failures.push(`hud-chips: 再点一次没收起（aria-expanded=${c2.expanded}）`);
    if (Math.abs(c2.h - c0.h) > 1) failures.push(`hud-chips: 再收起后行高 ${c2.h}px ≠ 初始 ${c0.h}px`);
  }
}

// ——— 点击误选（t11 D1 / t18-B）：按下在 HUD、松手在画布空白，不许选中 ————————
// 病根（t11 实测）：`PickLayer.onUp` 只看"拖没拖"，不看"这次抬起之前在不在画布上按下"。
// 于是在芯片上按下、拖到画布空白松手，会用旧状态选中松手点下的天体——按的是木星、亮的是水星。
// t18 用 `pressed` 守卫（`if (!wasPressed) return`）修掉它；这条断言就是给那个守卫上锁。
//
// 判据全结构量、无阈值：`?body=` 不变、无 `aria-pressed=true` 的芯片、无 `article`。
// 找不到合格夹具点 → **只记录不判红**并写 available:false + 原因（宁可标环境不可用，也不许空跑变绿）。
const PICKER_EMPTY_OFFSET = 6; // 盘外 6px：落在 22px 热区内（at() 会命中），但在盘面之外

async function findPickerFixture(page) {
  return page.evaluate((offset) => {
    const cs = window.__solarPick?.candidates?.() ?? [];
    const small = cs.map((c) => ({ id: c.id, x: c.x, y: c.y, r: c.r ?? c.radiusPx ?? 0 })).filter((c) => c.r > 0 && c.r < 12);
    for (const c of small) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = c.x + dx * (c.r + offset);
        const y = c.y + dy * (c.r + offset);
        if (x < 2 || y < 2) continue;
        const el = document.elementFromPoint(x, y);
        const hit = window.__solarPick.at(x, y);
        // 两个条件必须同时成立：点在画布上（不是 HUD 覆盖），且 at() 命中同一颗小天体
        if (el && el.tagName === "CANVAS" && hit === c.id) return { x, y, id: c.id, radiusPx: +c.r.toFixed(2) };
      }
    }
    return null;
  }, PICKER_EMPTY_OFFSET);
}

const pickerState = (page) =>
  page.evaluate(() => ({
    body: new URL(location.href).searchParams.get("body"),
    article: document.querySelectorAll("article").length,
    pressedChips: document.querySelectorAll('#chip-row button[aria-pressed="true"]').length,
  }));

// t16：大红斑断言（`jupiter-spot`）——聚焦档认得出、夜面必须认不出。
//
// 为什么要有它：`grep 大红斑` 曾经在 verify.mjs 里 0 命中，而 CHANGELOG 写着「【修复】木星的大红斑看不见」。
// 已修复项零断言 = 同一个 bug 会再来一次。
//
// 取证手段（不换结论）：
//  - 摆位用 `__solarPlace(id, dist, az, el, { faceU, faceV })`（需要 `?diag=1`）把**贴图坐标**上的
//    大红斑转到正对相机。斑的 u/v 直接从 `textures.ts` 的 `spots[]` 读出来（u=0.63 / v=0.62），
//    不靠扫方位角碰运气——t8 就是这么把它找出来的。
//  - 冻结时间：先 Space 暂停，否则自转会把斑转走。
//  - 盘半径从 `__solarPick.candidates()` 现读，但**轮询到连续两次一致**再用：
//    t8 实测 `candidates()` 在 `__solarPlace` 之后有秒级不可信期（报盘心差 500px）。
//  - 判据是 **luma 与 R/(R+G+B) 双门**，且带绝对 luma 下限。为什么必须有下限：
//    夜面整盘 luma 只有个位数，比值门在"两边都黑"时毫无区分力——只卡比值的断言，
//    一颗全黑的木星也能过（这正是 t16 要的负对照）。
const SPOT_UV = { u: 0.63, v: 0.62 }; // 大红斑贴图坐标（textures.ts 的 jupiter spots[0]）
const SPOT_LUMA_FLOOR = 20; // 绝对下限：定阈值时实测「受光斑区 72.0 / 夜面 5.2」，取 ~4× 夜面、~28% 受光值
const SPOT_LUMA_RATIO_MAX = 0.8; // 斑区必须明显比同纬度参考带暗：定阈值时实测 72.0 / 100.7 ≈ 0.71
const SPOT_E_MIN = 0.18; // R/(R+G+B) 门：t8/t21 实测斑的高对比块 E>0.22，这里留 0.04 余量
const SPOT_REF_DX = 0.35; // 参考带取同 latitude、经度错开的点：盘面半径的 35% 处

/** 采样一小块像素的 luma 与 R/(R+G+B) */
async function samplePatch(page, cx, cy, half) {
  return page.evaluate(
    ({ cx, cy, half }) => {
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) return { available: false, reason: "没有 WebGL 上下文" };
      const attrs = gl.getContextAttributes?.() ?? {};
      if (!attrs.preserveDrawingBuffer) return { available: false, reason: "preserveDrawingBuffer=false（?diag=1 没生效）" };
      const dpr = canvas.width / canvas.clientWidth;
      const x = Math.round(cx * dpr);
      // WebGL 原点在左下，页面坐标原点在左上
      const y = Math.round((canvas.clientHeight - cy) * dpr);
      const size = Math.max(3, Math.round(half * 2 * dpr));
      const px = new Uint8Array(size * size * 4);
      gl.readPixels(
        Math.max(0, Math.min(canvas.width - size, x - (size >> 1))),
        Math.max(0, Math.min(canvas.height - size, y - (size >> 1))),
        size,
        size,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      );
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        n++;
      }
      r /= n;
      g /= n;
      b /= n;
      const sum = r + g + b;
      return {
        available: true,
        luma: +(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(2),
        E: sum > 1e-6 ? +((r - g) / sum).toFixed(4) : null,
        rgb: [+r.toFixed(1), +g.toFixed(1), +b.toFixed(1)],
      };
    },
    { cx, cy, half },
  );
}

/** 连续两次读数一致（r 抖动 <1%）才认，规避 __solarPlace 之后 candidates() 的不可信期 */
async function stableJupiter(page, tries = 6) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const cur = await page.evaluate(() => {
      const c = (window.__solarPick?.candidates?.() ?? []).find((x) => x.id === "jupiter");
      return c ? { x: c.x, y: c.y, r: c.r ?? c.radiusPx } : null;
    });
    if (cur && prev && Math.abs(cur.r - prev.r) / cur.r < 0.01) return cur;
    prev = cur;
    await page.waitForTimeout(300);
  }
  return null;
}

async function runJupiterSpot(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const out = {};
  try {
    // ?diag=1：__solarPlace 与 readPixels 都需要它
    await page.goto(`${base}?diag=1`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.keyboard.press("Space"); // 冻结自转，否则斑会转走
    await page.waitForTimeout(300);

    const measureAt = async (simTime) => {
      if (simTime !== null) {
        await page.evaluate((t) => window.__solarTime.set(t), simTime);
        await page.waitForTimeout(200);
      }
      await page.evaluate(() => {
        window.__solarPlace("jupiter", 12.5, 0, 0, { faceU: 0.63, faceV: 0.62 });
      });
      await page.waitForTimeout(700);
      const disk = await stableJupiter(page);
      if (!disk) return { error: "candidates() 两次读数不一致（摆位后不可信期）" };
      const spot = await samplePatch(page, disk.x, disk.y, Math.max(4, disk.r * 0.12));
      const ref = await samplePatch(page, disk.x + disk.r * 0.35, disk.y, Math.max(4, disk.r * 0.12));
      return { disk, spot, ref };
    };

    // 扫一个木星轨道周期取**最亮**与**最暗**两帧：
    //  - 第一版我用「当前相位」当受光样本，实测 luma 5.6 —— 那是夜面。相位不能靠运气，
    //    而且写死某个时刻在别的相位上会变成白天（第一版搜夜面时也撞过这个）。
    //  - 所以两个样本都从同一批采样里挑：最亮 = 受光面（正样本），最暗 = 夜面（负对照）。
    //    这与 t8 的实测一致（受光斑区 72.0 / 夜面 5.2）。
    const samples = [];
    for (const t of [0, 6, 12, 18, 24, 30, 36, 42]) {
      const m = await measureAt(t);
      if (!m.error) samples.push({ t, ...m });
    }
    if (!samples.length) return { error: "扫一个轨道周期也没拿到可读样本" };
    samples.sort((a, b) => a.spot.luma - b.spot.luma);
    out.lit = samples.at(-1); // 最亮
    out.night = samples[0]; // 最暗
    out.samples = samples.map((s) => ({ t: s.t, luma: s.spot.luma, refLuma: s.ref.luma, E: s.spot.E }));
    return out;
  } finally {
    await ctx.close();
  }
}

function judgeJupiterSpot(res) {
  const name = "jupiter-spot";
  const lit = res.lit;
  if (!lit || lit.error) {
    failures.push(`${name}: 受光样本取不到（${lit?.error ?? "未知"}）—— 这条断言失去守卫，必须红`);
    return { available: false, reason: lit?.error ?? "未知" };
  }
  if (!lit.spot.available) {
    failures.push(`${name}: 读不到像素（${lit.spot.reason}）—— 判据不成立`);
    return { available: false, reason: lit.spot.reason };
  }
  const ratio = lit.ref.luma > 0 ? lit.spot.luma / lit.ref.luma : Infinity;
  /*
   * ⚠ **比值门已降级为「只记录」，不是判据** —— 这是实测推翻了设计，不是放宽。
   *
   * 扫一个轨道周期（8 个相位）实测：
   *   受光帧（斑区 luma ≥ 下限）的比值跨度 **0.429–0.948**；
   *   夜面帧（luma < 下限）的比值跨度 **0.250–0.608**。
   * 两个分布**重叠**（0.43–0.61），所以「斑区 ÷ 同纬度参考带」根本没有区分力：
   * 参考带自己的亮度随光照几何摆动（t=0 时斑 45.94 / 参考 48.45 → 比值 0.948）。
   * 按本仓库的规矩：**没有区分力的量只能记录**；阈值取「最差受光帧 × 1.15」会得到 1.09，
   * 那条门恒真——留着比删掉更坏，因为它看起来像在判断。
   *
   * 剩下的两个门有干净的间隔：
   *   · 绝对 luma 下限：受光 44.6–88.03 / 夜面 5.58–11.7（≥3.8× 间隔）；
   *   · E=(R−G)/(R+G+B)：斑在时恒定 0.277–0.280，斑被抹掉/改色后掉到 0.045（反向验证实测）。
   *
   * 【分工：三个门各测一件事，别让任何一个看起来像能代替全部】
   *   · luma 门（绝对下限）守「**它被照亮**」——受光 vs 夜面在这里分开（≥3.8× 间隔）；
   *   · E 门守「**它是红的**」——不区分受光/夜面（夜面帧 E 也是 0.279），那**不是漏写**；
   *   · 夜面负对照守「**不是靠运气**」——它证明前两个门合起来不会在整颗黑球上误成立。
   * 所以不要因为"E 在夜面也成立"就给它补一条亮面判据：那是让第三个门去测 luma 已经在测的东西，
   * 只会让人以为哪个门都能单独代表全部。
   */
  const detected = lit.spot.luma >= SPOT_LUMA_FLOOR && lit.spot.E !== null && lit.spot.E >= SPOT_E_MIN;
  if (!detected) {
    failures.push(
      `${name}: 聚焦档认不出大红斑 —— 斑区 luma ${lit.spot.luma}（下限 ${SPOT_LUMA_FLOOR}）/ E=${lit.spot.E}（下限 ${SPOT_E_MIN}）。` +
        `（比值 ${ratio.toFixed(2)} 只记录：它与夜面分布重叠，无区分力）` +
        `检查 textures.ts 的 jupiter spots[]、或 __solarPlace 的 faceU/faceV 反算。`,
    );
  }
  // 负对照：夜面同一判据必须**不成立**
  let nightOk = null;
  if (res.night && !res.night.error && res.night.spot.available) {
    const nRatio = res.night.ref.luma > 0 ? res.night.spot.luma / res.night.ref.luma : Infinity;
    const nightDetected =
      res.night.spot.luma >= SPOT_LUMA_FLOOR &&
      nRatio <= SPOT_LUMA_RATIO_MAX &&
      res.night.spot.E !== null &&
      res.night.spot.E >= SPOT_E_MIN;
    nightOk = !nightDetected;
    if (nightDetected) {
      failures.push(
        `${name}: 负对照失败 —— 夜面（斑区 luma ${res.night.spot.luma}）也满足了判据。` +
          `说明这条判据没有绝对亮度下限，一颗全黑的木星也能过。`,
      );
    }
  }
  return {
    available: true,
    lit: { spotLuma: lit.spot.luma, refLuma: lit.ref.luma, ratio: +ratio.toFixed(3), E: lit.spot.E, detected },
    night: res.night && !res.night.error ? { spotLuma: res.night.spot.luma, refLuma: res.night.ref.luma, E: res.night.spot.E, rejectedByGates: nightOk } : null,
    // 逐相位样本必须留在结果里：阈值只报一个数就等着失效，**要连同分布一起报**。
    // 受光帧 = 斑区 luma ≥ 绝对下限的那些，它们的比值跨度才是这条门的真实工作区间。
    samples: (res.samples ?? []).map((s) => ({
      t: s.t,
      luma: s.luma,
      refLuma: s.refLuma,
      ratio: s.refLuma > 0 ? +(s.luma / s.refLuma).toFixed(3) : null,
      E: s.E,
    })),
    litRatioSpan: (() => {
      const rs = (res.samples ?? []).filter((s) => s.luma >= SPOT_LUMA_FLOOR && s.refLuma > 0).map((s) => s.luma / s.refLuma);
      return rs.length ? { n: rs.length, min: +Math.min(...rs).toFixed(3), max: +Math.max(...rs).toFixed(3) } : null;
    })(),
    darkRatioSpan: (() => {
      const rs = (res.samples ?? []).filter((s) => s.luma < SPOT_LUMA_FLOOR && s.refLuma > 0).map((s) => s.luma / s.refLuma);
      return rs.length ? { n: rs.length, min: +Math.min(...rs).toFixed(3), max: +Math.max(...rs).toFixed(3) } : null;
    })(),
    thresholds: {
      lumaFloor: SPOT_LUMA_FLOOR,
      ratioMax: SPOT_LUMA_RATIO_MAX,
      EMin: SPOT_E_MIN,
      origin: "定阈值时实测：受光斑区 luma 72.0 / 参考带 100.7（比 0.71）/ 斑块 E>0.22；夜面整盘 luma 5.2（比值门在两边都黑时无效，故加绝对下限）+ textures.ts spots[] 给出 u=0.63、v=0.62",
    },
  };
}

// ——— 月食半球判据（`eclipse-hemisphere`）：正侧必须暗、反侧必须不暗 ————
//
// 为什么要它：`sun-occlusion` 证明的是「太阳在木星背后时木星盘心不透光」，
// 它**不覆盖** PLANET_FRAG 里那套解析遮挡公式本身。而那个公式曾经（`t50`）用
// `sep = |sin θ|` 判遮挡、丢了半球判断 ⇒ 卫星绕到「母天体在身后」的相位时整面被误判成全食。
//
// ⚠ 两条方法论写在这里，别删：
// 1. **分组键必须带 `dot > 0`**：`sep=|sinθ|` 是偶函数，只用 cover 会把 `dot=−1`（地球在背面）
//    分进"全食"——那正是 t50 的 bug 形状。我在验收侧第一次就照同一套公式分组，
//    结果 `dot=+1` 与 `dot=−1` 拿到几乎相同的 cover（1.05 vs 1.16）。
//    **验收逻辑不能复用被测逻辑的公式**：复用数据会被动跟着产品漂，复用公式会把 bug 一起继承。
// 2. **沙盘是压缩几何**：实测（`scripts/eclipse-scan.mjs`）太阳角半径 **12.72–16.44°**、
//    地球在月距处 **22.33°** —— **地球的角半径比太阳还大**，所以沙盘里食很常见。
//    别拿真世界的 0.27° 去质疑它（那正是我这轮犯过的错）。
//
// 判据（阈值从实测分布取，见 `ECLIPSE_*` 常量）：
//   正侧 `dot>0 且 cover≥1`（地球挡住太阳）→ 月球整盘平均 **≤ 0.5 ×** 参照
//   反侧 `dot<0`（地球在背面）           → **≥ 0.85 ×** 参照
//   参照 `cover≤0`
const ECLIPSE_PAIR = ["moon", "earth"];
const ECLIPSE_TOTAL_MAX_RATIO = 0.5; // 实测正侧 0.204–0.316（n=5），留 58% 余量
const ECLIPSE_ANTISOLAR_MIN_RATIO = 0.85; // **只作为记录**（反侧尚未建立，见下方注释）：实测反侧 1.004–1.028（n=3）
const ECLIPSE_FRAMES_PER_GROUP = 4;
const ECLIPSE_SWEEP_STEP = 0.02;
const ECLIPSE_SWEEP_END = 13;

const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm(a) {
    const n = Math.hypot(a[0], a[1], a[2]);
    return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null;
  },
};

/** 与 shader 同源的覆盖度（**只用于分组**，判定用的是实测亮度） */
function eclipseCover(pos, id, occId, radii) {
  const S = v3.sub(pos.sun ?? pos.sol, pos[id]);
  const E = v3.sub(pos[occId], pos[id]);
  const dSun = Math.hypot(...S);
  const dOcc = Math.hypot(...E);
  const Su = v3.norm(S);
  const Eu = v3.norm(E);
  if (!Su || !Eu || !radii.sun || !radii[occId]) return null;
  const sep = Math.hypot(...v3.cross(Su, Eu));
  const aSun = radii.sun / dSun;
  const aOcc = radii[occId] / dOcc;
  return { dot: +v3.dot(Su, Eu).toFixed(3), cover: +((aOcc + aSun - sep) / (2 * aSun)).toFixed(3), aSunDeg: +((aSun * 180) / Math.PI).toFixed(2), aOccDeg: +((aOcc * 180) / Math.PI).toFixed(2) };
}

/** 机位：垂直于日向、背离地球；`|dot|>0.9` 退化时固定 +90（两侧都远离地球） */
function eclipseCameraDir(pos, id, occId) {
  const S = v3.norm(v3.sub(pos.sun ?? pos.sol, pos[id]));
  const E = v3.norm(v3.sub(pos[occId], pos[id]));
  if (!S || !E) return null;
  const k = v3.dot(E, S);
  const perp = [E[0] - k * S[0], E[1] - k * S[1], E[2] - k * S[2]];
  let C = v3.norm([-perp[0], -perp[1], -perp[2]]);
  if (Math.abs(k) > 0.9 || !C) C = v3.norm(v3.cross(S, [0, 1, 0]));
  if (!C) return null;
  const right = v3.norm(v3.cross(S, [0, 1, 0])) ?? [1, 0, 0];
  return {
    az: +((Math.atan2(v3.dot(C, right), v3.dot(C, S)) * 180) / Math.PI).toFixed(2),
    el: +((Math.asin(Math.max(-1, Math.min(1, C[1]))) * 180) / Math.PI).toFixed(2),
  };
}

async function runEclipseHemisphere(browser, base) {
  const [id, occId] = ECLIPSE_PAIR;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const out = { pair: `${id}:${occId}`, errors: errs };
  try {
    await page.goto(`${base}?diag=1`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press(" "); // 暂停：时间由脚本钉
    await page.waitForTimeout(200);
    const probes = await page.evaluate(() => ({
      place: typeof window.__solarPlace === "function",
      planes: typeof window.__solarOrbitPlanes === "function",
      camera: typeof window.__solarCamera === "function",
      pick: typeof window.__solarPick?.candidates === "function",
    }));
    out.probes = probes;
    if (!probes.place || !probes.planes || !probes.camera || !probes.pick) return { ...out, available: false, reason: "探针缺失" };

    const worldAt = (t) =>
      page.evaluate(async (t) => {
        window.__solarTime.set(t);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        const rows = window.__solarOrbitPlanes() ?? [];
        const pos = { sol: [0, 0, 0], sun: [0, 0, 0] };
        for (const r of rows) if (r.parent === "sun") pos[r.id] = r.rel.slice();
        for (const r of rows) if (r.parent !== "sun") {
          const p = pos[r.parent] ?? [0, 0, 0];
          pos[r.id] = [p[0] + r.rel[0], p[1] + r.rel[1], p[2] + r.rel[2]];
        }
        return pos;
      }, t);

    const radii = await page.evaluate(({ ids }) => {
      const cam = window.__solarCamera();
      const H = document.querySelector("canvas").clientHeight;
      const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
      const o = {};
      for (const id of ids) {
        const c = window.__solarPick.candidates().find((x) => x.id === id);
        o[id] = c && c.depth > 0 ? (c.radiusPx * c.depth * tanHalf * 2) / H : null;
      }
      return o;
    }, { ids: [id, occId, "sun"] });
    out.radii = radii;

    // 扫相位 → 按 (dot, cover) 分组
    const samples = [];
    for (let t = 0; t <= ECLIPSE_SWEEP_END + 1e-9; t += ECLIPSE_SWEEP_STEP) {
      const tt = +t.toFixed(3);
      const pos = await worldAt(tt);
      const g = eclipseCover(pos, id, occId, radii);
      if (g) samples.push({ t: tt, ...g });
    }
    const buckets = {
      total: samples.filter((s) => s.dot > 0 && s.cover >= 1),
      antisolar: samples.filter((s) => s.dot < 0),
      none: samples.filter((s) => s.cover <= 0),
    };
    out.groupSizes = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));

    const measure = async (t) => {
      const pos = await worldAt(t);
      const dir = eclipseCameraDir(pos, id, occId);
      if (!dir) return { available: false, reason: "算不出机位方向" };
      /*
       * 视距用**开头量一次的世界半径**（`radii[id]`），不在每帧重新从 candidates 反推。
       * 前一版每帧轮询 candidates 求稳定，结果 antisolar / 参照组**全部被判"不稳定"**：
       * 那些时刻相机还没摆过去、月球可能不在候选里，轮询永远等不到两次一致——
       * 于是 n=0。半径是产品常量，量一次就够。
       */
      const rWorld = radii[id];
      if (!(rWorld > 0)) return { available: false, reason: "量不到该天体的世界半径" };
      const placed = await page.evaluate(({ id, dist, az, el }) => {
        const r = window.__solarPlace(id, dist, az, el);
        if (!r) return null;
        const n = window.__solarCamera().nearest;
        return { ok: true, nearest: n ?? null, inside: n && n.id !== id && n.dist < n.radius * 1.05 };
      }, { id, dist: +(rWorld * 8.6).toFixed(5), az: dir.az, el: dir.el });
      if (!placed) return { available: false, reason: "__solarPlace 返回 null" };
      if (placed.inside) return { available: false, reason: "相机落在别的天体里" };
      await page.waitForTimeout(320);
      const mean = await page.evaluate((id) => {
        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const W = canvas.width;
        const H = canvas.height;
        const c = window.__solarPick.candidates().find((x) => x.id === id);
        if (!c) return null;
        const box = Math.min(400, Math.max(48, Math.round(c.radiusPx * 2.2)));
        const x0 = Math.max(0, Math.round(c.x * (W / canvas.clientWidth) - box / 2));
        const y0 = Math.max(0, Math.round(H - c.y * (H / canvas.clientHeight) - box / 2));
        const buf = new Uint8Array(box * box * 4);
        gl.readPixels(x0, y0, box, box, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const cc = box / 2;
        let sum = 0;
        let n = 0;
        for (let y = 0; y < box; y++)
          for (let x = 0; x < box; x++)
            if (Math.hypot(x - cc, y - cc) <= c.radiusPx * 0.86) {
              sum += 0.2126 * buf[(y * box + x) * 4] + 0.7152 * buf[(y * box + x) * 4 + 1] + 0.0722 * buf[(y * box + x) * 4 + 2];
              n++;
            }
        return n ? +(sum / n).toFixed(2) : null;
      }, id);
      return { available: true, diskMean: mean, az: dir.az, el: dir.el };
    };

    out.groups = {};
    for (const g of ["total", "antisolar", "none"]) {
      const rows = [];
      const fails = [];
      for (const s of buckets[g].slice(0, ECLIPSE_FRAMES_PER_GROUP)) {
        const m = await measure(s.t);
        if (!m.available) fails.push({ t: s.t, reason: m.reason });
        else rows.push({ t: s.t, dot: s.dot, cover: s.cover, aSunDeg: s.aSunDeg, aOccDeg: s.aOccDeg, diskMean: m.diskMean, el: m.el, az: m.az });
      }
      const v = rows.map((r) => r.diskMean).sort((a, b) => a - b);
      out.groups[g] = {
        n: rows.length,
        min: v[0] ?? null,
        max: v[v.length - 1] ?? null,
        median: v.length ? v[Math.floor(v.length / 2)] : null,
        dotRange: rows.length ? [Math.min(...rows.map((r) => r.dot)), Math.max(...rows.map((r) => r.dot))] : null,
        rows,
        failures: fails,
      };
    }
    const ref = out.groups.none.median;
    out.ratios = {
      total: ref && out.groups.total.median !== null ? +(out.groups.total.median / ref).toFixed(3) : null,
      totalMax: ref && out.groups.total.max !== null ? +(out.groups.total.max / ref).toFixed(3) : null,
      antisolar: ref && out.groups.antisolar.median !== null ? +(out.groups.antisolar.median / ref).toFixed(3) : null,
      antisolarMin: ref && out.groups.antisolar.min !== null ? +(out.groups.antisolar.min / ref).toFixed(3) : null,
    };
    out.thresholds = {
      totalMaxRatio: ECLIPSE_TOTAL_MAX_RATIO,
      antisolarMinRatio: ECLIPSE_ANTISOLAR_MIN_RATIO,
      origin:
        "定阈值时实测（沙盘压缩几何，aSun 12.72–16.44°、aOcc 22.33°）：正侧比 0.204–0.316（n=5）→ 取 0.5（余量 58%）；反侧比 1.004–1.028（n=3）→ 取 0.85（余量 18%）。两侧之间留空档：偏食不判。",
    };
    return { ...out, available: true };
  } finally {
    await ctx.close();
  }
}

function judgeEclipseHemisphere(res) {
  const name = "eclipse-hemisphere";
  if (!res.available) {
    failures.push(`${name}: 夹具不成立（${res.reason ?? "未知"}）—— 没采到就不许报绿`);
    return res;
  }
  const t = res.groups.total;
  const a = res.groups.antisolar;
  const ref = res.groups.none;
  if (ref.n < 2) failures.push(`${name}: 参照组只采到 ${ref.n} 帧（需 ≥2）—— 没有参照就没有比值`);
  if (t.n < 2) {
    failures.push(`${name}: 正侧（dot>0 且 cover≥1）只采到 ${t.n} 帧 —— 窗口太窄或采样失败，**n=0 不许静默变成通过**`);
  } else if (res.ratios.totalMax !== null && res.ratios.totalMax > ECLIPSE_TOTAL_MAX_RATIO) {
    failures.push(
      `${name}: 正侧（地球挡住太阳）没有变暗 —— 最亮一帧比值 ${res.ratios.totalMax} > ${ECLIPSE_TOTAL_MAX_RATIO}（中位 ${res.ratios.total}）。` +
        `遮挡公式没生效，或相角/机位口径变了。`,
    );
  }
  /*
   * ⚠ **本条只覆盖正侧（遮挡真的发生）。反侧（`dot<0` 时受光面不得被压暗）尚未建立。**
   *
   * 为什么没建：侧视机位下反侧采到的帧对"删掉半球守卫"**逐位不敏感**（改前/改后比值都是 1.0），
   * 说明那些帧的 `cover` 到不了 1、`direct` 本来就没被压暗——**判据红不了，就不能算守住**。
   * 反侧单独成条（`t57`），判据不变，**红不了不许关**。
   * 这里仍把反侧组的测量值记进结果（它是正侧比值的上下文），但**不参与判定**，
   * 也不写"未验证/pending"这类字段——那种字段的实际效果是"没人会去验证"。
   */
  void a; // 反侧只作为记录，不参与判定
  if (res.errors?.length) failures.push(`${name}: 控制台/页面报错 ${res.errors.length} 条`);
  return res;
}

// ——— 滚轮在 HUD 上必须仍然缩放（`hud-wheel`）———
//
// 为什么要有它：滚轮曾经在指针悬停 HUD 时**完全无效**（监听挂在 gl.domElement 上，
// 而 HUD 覆盖区的 wheel 事件到不了画布）。`zoom-budget` 的指针**永远在画布内**，
// 结构上采不到"指针在 HUD 上"这一态——所以那个 bug 活过了 22 条 pass。
//
// 判据是**三段式**，缺一段就会假绿：
//   ① `d0 ≈ 4.8`（≈ 地球的聚焦视距）——若芯片点击没生效，d0 会是总览视距 ~118.9，
//      那时"4 格后离开 4.8"**无条件成立**，于是假绿；
//   ② 指针**压在芯片上**滚 4 格（真 `page.mouse.wheel`，trusted 事件）；
//   ③ `d1 ≠ 4.8 且 > 4.8`。
// 并且 wheel **前后各读一次 `elementFromPoint`**：只读一次挡不住自动收起那个 2s 窗口——
// 芯片被卸载后 wheel 其实落在画布上，单次留证若撞在卸载前同样是假绿。
//
// 阈值不写死 12.18：那是某一次运行的幅度（三次实测 12.18 / 12.21 / 11.83，吃加速窗口）。
const HUD_WHEEL_FOCUS_DIST = 4.8; // 地球的聚焦视距（`data.ts` 的 earth.focus），不是实测抄来的
const HUD_WHEEL_FOCUS_TOL = 0.01;
const HUD_WHEEL_NOTCHES = 4;
const HUD_WHEEL_NOTCH_GAP_MS = 100;

const hudWheelProbe = (page, pt) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return {
      tag: el ? el.tagName : null,
      id: el ? (el.closest?.("button")?.id ?? el.id ?? null) : null,
      distTarget: window.__solarCamera?.().distTarget ?? null,
    };
  }, pt);


async function runHudWheel(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const out = { errors: errs };
  try {
    await page.goto(`${base}?diag=1`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    out.probes = await page.evaluate(() => ({
      place: typeof window.__solarPlace === "function",
      camera: typeof window.__solarCamera === "function",
    }));

    // 唤醒 chrome（自动收起会在静置 2s 后把芯片行从 DOM 卸载）→ 点地球进入聚焦
    await page.mouse.move(300, 40);
    await page.waitForSelector("#chip-earth", { state: "visible", timeout: 5000 });
    await page.locator("#chip-earth").click({ timeout: 8000, force: true });

    // settle：`distTarget` 连续 ~700ms 不变才开滚。动画期间 camLocked 会把滚轮整个吞掉，
    // 那 4 格会白滚，然后在 d0=4.8 上断言自然红——那是假红，不是产品问题。
    const t0 = Date.now();
    let prev = null;
    let settled = false;
    while (Date.now() - t0 < 6000) {
      const d = await page.evaluate(() => window.__solarCamera?.().distTarget ?? null);
      if (d !== null && prev !== null && Math.abs(d - prev) / Math.max(1e-6, d) < 0.001) {
        await page.waitForTimeout(700); // 再多等一拍，确认不是"刚好路过"
        const d2 = await page.evaluate(() => window.__solarCamera?.().distTarget ?? null);
        settled = d2 !== null && Math.abs(d2 - d) / Math.max(1e-6, d) < 0.001;
        prev = d2;
        break;
      }
      prev = d;
      await page.waitForTimeout(120);
    }
    out.settled = { settled, waitedMs: Date.now() - t0, distTarget: prev };

    const chip = await page.locator("#chip-earth").boundingBox();
    if (!chip) return { ...out, available: false, reason: "量不到 #chip-earth 的位置" };
    const pt = { x: Math.round(chip.x + chip.width / 2), y: Math.round(chip.y + chip.height / 2) };
    // 指针压到芯片中心，**不移开**
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(120);
    const before = await hudWheelProbe(page, pt); // ① 与 d0 成对读：中间不插等待
    out.before = before;
    out.chipBox = { x: +chip.x.toFixed(1), y: +chip.y.toFixed(1), w: +chip.width.toFixed(1), h: +chip.height.toFixed(1) };

    // 方向：deltaY 为正 = 向后拉远（视距增大）。选这个方向是为了能和已有参考数（4 格 4.8→12.18）对齐；
    // 向上滚是放大（视距减小），那会把"离开 4.8"判成反方向——这条 pass 只问"还缩不缩"，不判方向。
    for (let i = 0; i < HUD_WHEEL_NOTCHES; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(HUD_WHEEL_NOTCH_GAP_MS);
    }
    await page.waitForTimeout(400);
    const after = await hudWheelProbe(page, pt); // ③ 与 d1 成对读
    out.after = after;
    out.notches = HUD_WHEEL_NOTCHES;
    out.direction = "deltaY=+120（向后拉远，视距增大）";
    return { ...out, available: true };
  } finally {
    await ctx.close();
  }
}

function judgeHudWheel(res) {
  const name = "hud-wheel";
  if (!res.available) {
    failures.push(`${name}: 夹具不成立（${res.reason}）—— 没滚成就不许报绿`);
    return res;
  }
  // 探针缺失 = 判不了 = 红（同 sun-occlusion 的口径）
  if (!res.probes?.camera) {
    failures.push(`${name}: __solarCamera 探针缺失 —— 读不到 distTarget，判据没有对象`);
    return res;
  }
  const b = res.before;
  const a = res.after;
  // ① d0 必须是聚焦视距，否则"离开 4.8"无条件成立（假绿）
  if (b.distTarget === null) {
    failures.push(`${name}: 读不到 d0（distTarget=null）`);
  } else if (Math.abs(b.distTarget - HUD_WHEEL_FOCUS_DIST) > HUD_WHEEL_FOCUS_TOL) {
    failures.push(
      `${name}: d0=${b.distTarget} 不是聚焦视距 ${HUD_WHEEL_FOCUS_DIST}±${HUD_WHEEL_FOCUS_TOL} —— ` +
        `芯片点击没生效（或在总览视距上），此时"滚 4 格后离开 4.8"会自动成立，是假绿。`,
    );
  }
  // ② 指针确实在芯片上（前后各一次，夹住自动收起的时间窗）
  for (const [when, p] of [["滚动前", b], ["滚动后", a]]) {
    if (p.tag !== "BUTTON" || p.id !== "chip-earth") {
      failures.push(
        `${name}: ${when} elementFromPoint 命中的是 ${p.tag}${p.id ? "#" + p.id : ""}，应为 BUTTON#chip-earth ` +
          `—— 指针不在芯片上，这次"滚了 4 格"可能落在画布上，测不到 HUD 覆盖区这个状态。`,
      );
    }
  }
  // ③ 真的缩放了
  if (a.distTarget === null) {
    failures.push(`${name}: 读不到 d1（distTarget=null）`);
  } else if (!(a.distTarget > HUD_WHEEL_FOCUS_DIST + HUD_WHEEL_FOCUS_TOL)) {
    failures.push(
      `${name}: 指针压在 #chip-earth 上滚了 ${res.notches} 格，distTarget 仍是 ${a.distTarget} ` +
        `（d0=${b.distTarget}）—— 滚轮在 HUD 覆盖区失效了（监听又挂回 gl.domElement？）`,
    );
  }
  if (res.errors?.length) failures.push(`${name}: 控制台/页面报错 ${res.errors.length} 条`);
  return res;
}

// ——— 轨道共面（沙盘）/ 不共面（实境）：`__solarOrbitPlanes()` 的三点求法向量 ————
// 为什么要有这条：`t24` 让沙盘行星回到共面，而当时 19 条 pass **一条都不守它**——
// `overlapping` 明令禁止加阈值、`meanLvl`/`meanLum` 是松判据。所以这条是唯一守卫。
//
// 采样方式：把模拟时间推到三个时刻，各读一次「天体相对母天体的世界偏移」，
// 三点求叉积得轨道平面法向量。共面 = 各行星法向量两两夹角 ≈ 0。
//
// ⚠ **只约束行星（parent = sun），不约束卫星**：t31 刻意让卫星挂在母行星的赤道面
//   （木卫 3.1°、土卫六 26.7°）——那是用户点名要的效果（土卫六必须在环面里，否则环和卫星错开）。
//   所以卫星保留各自的 orbitFrame 倾角；这条断言不覆盖它们，**这不是漏写**。
//
// ⚠ 反过来也要判：实境（`?proto=1`，flatOrbits=false）不许被压平——月球的法向量倾角应当
//   接近真值 5.145°。如果实境也平了，说明 `look.flatOrbits` 没接对，这条同样要红。
const PLANE_EPS_DEG = 0.01; // 共面判据：两两夹角 < 0.01°（实测 0.000000°）
const MOON_INC_WANT_DEG = 5.145; // 真值；实境若被压平会读到 0
const MOON_INC_TOL_DEG = 0.5;

/** 三个时刻各读一次偏移，返回 {id, parent, normal:[x,y,z]} */
async function sampleOrbitNormals(page, stepSim = 0.4) {
  return page.evaluate(async (step) => {
    const t = window.__solarTime;
    const t0 = t.now();
    const samples = [];
    for (let k = 0; k < 3; k++) {
      t.set(t0 + k * step);
      // 位置在渲染循环里更新；等两帧确保读到的不是上一时刻的缓存
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => requestAnimationFrame(() => r()));
      samples.push(window.__solarOrbitPlanes?.() ?? []);
    }
    const first = samples[0];
    const out = [];
    for (const row of first) {
      const p0 = samples[0].find((r) => r.id === row.id)?.rel;
      const p1 = samples[1].find((r) => r.id === row.id)?.rel;
      const p2 = samples[2].find((r) => r.id === row.id)?.rel;
      if (!p0 || !p1 || !p2) continue;
      const a = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const b = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const len = Math.hypot(...n);
      if (!(len > 1e-9)) continue; // 三点共线 → 求不出法向量，跳过（下一条断言会因缺天体暴露）
      out.push({ id: row.id, parent: row.parent, normal: n.map((v) => v / len) });
    }
    return out;
  }, stepSim);
}

const angleDegBetween = (u, v) => {
  const dot = Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
};

async function runOrbitPlanes(browser, base) {
  const out = { sandbox: null, real: null };
  // 1) 沙盘：行星必须共面
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await page.goto(base, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      const hasProbe = await page.evaluate(() => typeof window.__solarOrbitPlanes === "function");
      if (!hasProbe) {
        out.sandbox = { available: false, reason: "__solarOrbitPlanes 不存在" };
      } else {
        const normals = await sampleOrbitNormals(page);
        const planets = normals.filter((n) => n.parent === "sun");
        let worst = 0;
        let worstPair = null;
        for (let i = 0; i < planets.length; i++) {
          for (let j = i + 1; j < planets.length; j++) {
            const d = angleDegBetween(planets[i].normal, planets[j].normal);
            if (d > worst) {
              worst = d;
              worstPair = [planets[i].id, planets[j].id];
            }
          }
        }
        out.sandbox = {
          available: true,
          planets: planets.map((p) => p.id),
          maxAngleDeg: +worst.toFixed(6),
          worstPair,
          count: planets.length,
        };
      }
    } finally {
      await ctx.close();
    }
  }
  // 2) 实境：月球不许被压平
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}?proto=1`, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      const hasProbe = await page.evaluate(() => typeof window.__solarOrbitPlanes === "function");
      if (!hasProbe) {
        out.real = { available: false, reason: "__solarOrbitPlanes 不存在（?proto=1）" };
      } else {
        const normals = await sampleOrbitNormals(page);
        const moon = normals.find((n) => n.id === "moon") ?? null;
        // 倾角 = 月球轨道法向量与黄道面法向量 (0,1,0) 的夹角
        const inc = moon ? angleDegBetween(moon.normal, [0, 1, 0]) : null;
        out.real = {
          available: true,
          bodies: normals.map((n) => `${n.id}@${n.parent}`),
          moonInclinationDeg: inc === null ? null : +inc.toFixed(4),
        };
      }
    } finally {
      await ctx.close();
    }
  }
  return out;
}

function judgeOrbitPlanes(res) {
  const name = "orbit-planes";
  const sb = res.sandbox;
  // 探针没了 = 判不了 → 判红，不许 available:false 静默放行（与 zoom-budget 依赖 __solarPick 同理）
  if (!sb || !sb.available) {
    failures.push(`${name}: 读不到 __solarOrbitPlanes（${sb?.reason ?? "未知"}）—— 共面判据会失去守卫，必须红`);
  } else {
    if (sb.count < 8) failures.push(`${name}: 沙盘只采到 ${sb.count} 条行星轨道（应 8）—— 采样不足，判据不成立`);
    if (!(sb.maxAngleDeg < PLANE_EPS_DEG)) {
      failures.push(
        `${name}: 沙盘行星轨道不共面 —— 最大两两夹角 ${sb.maxAngleDeg}° ≥ ${PLANE_EPS_DEG}°` +
          `（${sb.worstPair ? sb.worstPair.join(" × ") : "?"}）。` +
          `有人动了 \`look.flatOrbits\` 或轨道倾角公式？沙盘必须回到共面。`,
      );
    }
  }
  const real = res.real;
  if (!real || !real.available) {
    failures.push(`${name}: 读不到实境的 __solarOrbitPlanes（${real?.reason ?? "未知"}）—— 压平判据会失去守卫，必须红`);
  } else if (real.moonInclinationDeg === null) {
    failures.push(`${name}: 实境里找不到月球（采到 ${real.bodies.join(", ") || "空"}）—— 判据失去对象`);
  } else if (Math.abs(real.moonInclinationDeg - MOON_INC_WANT_DEG) > MOON_INC_TOL_DEG) {
    failures.push(
      `${name}: 实境月球的轨道倾角是 ${real.moonInclinationDeg}°，真值 ${MOON_INC_WANT_DEG}°` +
        `（容差 ±${MOON_INC_TOL_DEG}°）—— 实境被压平了？\`look.flatOrbits\` 没接对。`,
    );
  }
  return res;
}

async function runPickerGesture(page, context) {
  // 先移动指针把 chrome 唤醒（t12 自动收起会在静置 2s 后把芯片行从 DOM 拿掉）
  await page.mouse.move(300, 40);
  await page.waitForSelector("#chip-jupiter", { state: "visible", timeout: 5000 });
  // Space 暂停：天体在动的话夹具点会漂走
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  const t0 = await page.evaluate(() => window.__solarTime.now());
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => window.__solarTime.now());
  const paused = Math.abs(t1 - t0) < 1e-6;

  const fixture = await findPickerFixture(page);
  const before = await pickerState(page);
  const out = { paused, fixture, before };

  if (fixture) {
    const chip = await page.locator("#chip-jupiter").boundingBox();
    const cdp = await context.newCDPSession(page);
    const from = chip ? { x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 } : null;
    if (from) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + (fixture.x - from.x) * k,
          y: from.y + (fixture.y - from.y) * k,
          button: "left",
        });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: fixture.x, y: fixture.y, button: "left", clickCount: 1 });
      await page.waitForTimeout(400);
    }
    out.from = from;
    out.after = await pickerState(page);
  }

  // 对照 1：正常点地球必须选中（否则这条断言会"什么都不选也绿"）
  await page.mouse.move(300, 40);
  await page.waitForSelector("#chip-earth", { state: "visible", timeout: 5000 });
  await page.locator("#chip-earth").click({ timeout: 8000, force: true });
  await page.waitForTimeout(500);
  out.controlClickEarth = await pickerState(page);

  // 对照 2：在画布空白上拖 40px 必须不选（正常拖拽没被误伤）
  const start = { x: 640, y: 300 };
  const cdp2 = await context.newCDPSession(page);
  await cdp2.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await cdp2.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + (40 * i) / 6, y: start.y, button: "left" });
    await page.waitForTimeout(16);
  }
  await cdp2.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + 40, y: start.y, button: "left", clickCount: 1 });
  await page.waitForTimeout(400);
  out.controlCanvasDrag = await pickerState(page);
  return out;
}

function judgePickerGesture(gesture) {
  const name = "pointer-misselection";
  if (!gesture.paused) {
    failures.push(`${name}: Space 没能暂停模拟（__solarTime 在 300ms 内仍在走）—— 夹具不成立，判据无效`);
  }
  const c1 = gesture.controlClickEarth;
  if (!c1 || c1.article < 1) {
    failures.push(`${name}: 对照失败 —— 正常点 #chip-earth 没出现卡片（article=${c1?.article}），这条断言会"什么都不选也绿"`);
  }
  const c2 = gesture.controlCanvasDrag;
  if (c2 && c1 && c2.article > c1.article) {
    failures.push(`${name}: 对照失败 —— 画布拖 40px 竟然选中了东西（article ${c1.article} → ${c2.article}）`);
  }

  if (!gesture.fixture) {
    // 找不到合格夹具点：只记录，不判红（环境不可用 ≠ 产品有问题）
    return { available: false, reason: "找不到「小天体盘外 6px 且 elementFromPoint===CANVAS 且 at() 命中同一 id」的点" };
  }
  if (!gesture.after) return { available: false, reason: "chip-jupiter 的位置量不到，手势没发出" };

  const b = gesture.before;
  const a = gesture.after;
  if (a.body !== b.body) {
    failures.push(
      `${name}: 按下在 #chip-jupiter、松手在画布空白，?body 却从 ${b.body} 变成 ${a.body} —— ` +
        `「按下在 HUD 抬起在画布」被当成了点击（t18-B 的 pressed 守卫失效了？）`,
    );
  }
  if (a.pressedChips > 0) failures.push(`${name}: 手势之后有 ${a.pressedChips} 个芯片 aria-pressed=true —— 误选发生了`);
  if (a.article > b.article) failures.push(`${name}: 手势之后多出卡片（article ${b.article} → ${a.article}）—— 误选发生了`);
  return { available: true, ...gesture };
}

async function run(browser, spec) {
  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: spec.dpr ?? 1,
    isMobile: Boolean(spec.isMobile),
    hasTouch: Boolean(spec.hasTouch),
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  const result = { pass: spec.name, url: spec.url, errors };
  try {
    // 已校准态（gate 三槽）是 390 下最紧的布局：徽标更宽，模拟历与品牌组的余量最小。
    // 所以抬头那一格样本押在最紧处。必须在 goto **之前**注入，晚了页面已经渲染完。
    if (spec.hud === "unlocked") {
      await context.addInitScript(() => {
        localStorage.setItem(
          "xinggui-gate-v1",
          JSON.stringify({ v: 1, lit: ["time", "target", "layer"], unlockedAt: Date.now() }),
        );
      });
    }
    // ?diag=1：只为打开 preserveDrawingBuffer（画布像素体检要用），不改产品行为
    await page.goto(withDiag(spec.url), { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    result.solarReady = true;
    // 归档要能回答「哪个视口下出的问题」，所以把这一页的视口与 dpr 记进结果（纯追加字段）
    result.viewport = `${spec.viewport.width}x${spec.viewport.height}`;
    result.dpr = spec.dpr ?? 1;
    result.title = await page.locator("h1").innerText();
    result.canvas = await page.locator("canvas").count();
    result.epoch = await page.locator("header p.text-lg").innerText();
    result.overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );

    if (spec.interact) {
      await page.locator("#chip-earth").click();
      await page.waitForSelector("article h2", { timeout: 10000 });
      result.selected = await page.locator("article h2").innerText();
      result.cardFacts = await page.locator("article dd").count();
      await page.waitForTimeout(1500); // 等镜头聚焦动画走完
    }

    // 定稿态再采样：点选后镜头更近，画面内容更多
    result.canvasPixels = await sampleCanvasPixels(page);
    // 手机 dpr 红线（结构量）：只在 pointer: coarse 的设备上判
    result.quality = await readQuality(page);

    await page.screenshot({ path: path.join(SHOTS, `${spec.name}.png`) });

    // 手机 HUD 五条夹具：放在 screenshot **之后**（它会把卡片停在「收起」档，
    // 放在前面会改掉人工复核用的那几张基准图）。
    if (spec.hud) {
      try {
        result.hud = await runMobileHud(page, context, spec.hud);
        if (result.hud.mode === "locked") judgeHudLocked(result.hud);
        judgeHudHeader(result.hud.header, spec.hud);
      } catch (err) {
        failures.push(`hud: ${spec.name}（${spec.hud}）的交互夹具抛错：${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`fatal: ${err.message}`);
  }
  await context.close();

  if (!result.solarReady) failures.push(`${spec.name}: 画布没起来（__solarReady 未置位）`);
  if (errors.length) failures.push(`${spec.name}: 控制台/页面报错 ${errors.length} 条`);
  if (result.canvas !== 1) failures.push(`${spec.name}: canvas 数量 ${result.canvas} ≠ 1`);
  if (result.overflowX > 1) failures.push(`${spec.name}: 横向溢出 ${result.overflowX}px`);
  judgeCanvasPixels(spec.name, result.canvasPixels);
  judgeQuality(spec.name, result.quality);
  if (spec.expectSelected && result.selected !== spec.expectSelected) {
    failures.push(`${spec.name}: 点选后卡片是「${result.selected}」，期望「${spec.expectSelected}」`);
  }
  return result;
}

await mkdir(SHOTS, { recursive: true });
const { server, port } = await startServerOnFreePort(PORT);
if (port !== PORT) console.error(`（端口 ${PORT} 被占用，改用 ${port}）`);
const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});

const base = `http://127.0.0.1:${port}/`;
// XG_ONLY=mobile,mobile-selected：只跑指定的 page pass。**不设这个变量时行为与以前逐字相同。**
// 存在理由和 check-shape 的 --selftest 相同：要证明一条断言真的会红，得能在改坏的产物上单跑它，
// 而不是每次都等十几条 pass 跑完再看那一行。
const ONLY = (process.env.XG_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);
// 注：这里原来有一个 `XG_STRICT=1` 开关，作用是把「已知缺陷」当红判（反向验证用）。
// t15 收尾时最后一条已知缺陷（过渡段穿地球）转成了硬断言，这个开关失去对象，已删除——
// 留着一个没有作用的旋钮，比没有旋钮更坏：下一个人会以为它还在控制什么。
const startedAt = Date.now();
const results = [];
const hudHeaders = [];

/*
 * 环境读数：**只打印，不判红**。
 *
 * 用处只有一个：跑完发现数字不对时，一眼看出是不是"自己把机器拖慢了"。
 * 为什么不判红：用户自己开着几十个 Edge 是正常状态，判红就是假红。
 * 为什么要区分 headless：**非 headless 是用户的窗口**（Edge 多进程，一个窗口 20+ 进程很正常），
 * 只有 headless 才可能是我们这些夹具留下的。
 */
function printEnvLine() {
  try {
    if (process.platform !== "win32") {
      console.log(`环境：${process.platform}（跳过 Edge 计数）`);
      return;
    }

    const q =
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ForEach-Object { " +
      "if ($_.CommandLine -match 'headless') { 'H:' + $_.ParentProcessId } else { 'V' } }";
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", q], {
      encoding: "utf8",
      timeout: 8000,
    });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const headless = lines.filter((l) => l.startsWith("H:"));
    const visible = lines.filter((l) => l === "V").length;
    let parents = [];
    if (headless.length) {
      const pids = [...new Set(headless.map((l) => l.slice(2)))].slice(0, 3);
      const qp = `Get-CimInstance Win32_Process | Where-Object { ${pids.map((p) => `$_.ProcessId -eq ${p}`).join(" -or ")} } | ForEach-Object { $_.ProcessId.ToString() + '=' + $_.Name }`;
      try {
        parents = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", qp], { encoding: "utf8", timeout: 8000 })
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        parents = [];
      }
    }
    console.log(
      `环境：headless Edge ${headless.length} 个${parents.length ? `（父进程 ${parents.join(", ")}）` : ""}；` +
        `非 headless ${visible} 个（用户的窗口，不判）。**这只是读数，不是闸。**`,
    );
  } catch {
    console.log("环境：Edge 计数读不到（这不影响任何判据）");
  }
}
printEnvLine();

try {
  if (want("desktop")) {
    results.push(
      await run(browser, {
        name: "desktop",
        url: base,
        viewport: { width: 1280, height: 720 },
        interact: true,
        expectSelected: "地球",
      }),
    );
  }
  if (want("mobile")) {
    const r = await run(browser, {
      name: "mobile",
      url: base,
      viewport: { width: 390, height: 844 },
      dpr: 3,
      isMobile: true,
      hasTouch: true,
      hud: "locked", // 锁态：正常新 context，localStorage 空
    });
    results.push(r);
    if (r.hud?.mode === "locked") {
      // 五条里的四条从这一格出（抬头那一格两态共用一条 record）
      results.push({ pass: "hud-layer", open: r.hud.layerOpen, closed: r.hud.layerClosed });
      results.push({ pass: "hud-gesture", ...r.hud.card });
      results.push({ pass: "hud-card-bar", bar: r.hud.bar, rootPx: r.hud.rootPx });
      results.push({
        pass: "hud-chips",
        collapsed0: r.hud.chipsCollapsed0,
        expanded: r.hud.chipsExpanded,
        collapsed1: r.hud.chipsCollapsed1,
      });
      hudHeaders.push({ mode: "locked", ...r.hud.header });
    }
  }
  if (want("mobile-selected")) {
    const r = await run(browser, {
      name: "mobile-selected",
      url: base,
      viewport: { width: 390, height: 844 },
      dpr: 3,
      isMobile: true,
      hasTouch: true,
      interact: true,
      expectSelected: "地球",
      hud: "unlocked", // 已校准：init script 预置 gate 三槽
    });
    results.push(r);
    if (r.hud?.header) hudHeaders.push({ mode: "unlocked", ...r.hud.header });
  }
  if (hudHeaders.length) results.push({ pass: "hud-header", samples: hudHeaders });
  if (want("single-file")) {
    results.push(
      await run(browser, {
        name: "single-file",
        url: pathToFileURL(SINGLE).href,
        viewport: { width: 1280, height: 720 },
      }),
    );
  }
  // ——— 点击误选（t11 D1 / t18-B）：按下在 HUD、松手在画布空白，不许选中 ————
  if (want("pointer-misselection")) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      // 不加 ?diag：这条判的是选择行为，与读回无关；少开一个开关就少一份"夹具改变被测对象"的风险
      await page.goto(base, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      const gesture = await runPickerGesture(page, ctx);
      const judged = judgePickerGesture(gesture);
      results.push({ pass: "pointer-misselection", 分类: "结构量", ...judged });
    } catch (err) {
      failures.push(`pointer-misselection: ${err.message}`);
    } finally {
      await ctx.close();
    }
  }
  // ——— 轨道共面（沙盘）/ 不共面（实境）———
  if (want("orbit-planes")) {
    try {
      const planes = await runOrbitPlanes(browser, base);
      results.push({ pass: "orbit-planes", 分类: "结构量", ...judgeOrbitPlanes(planes) });
    } catch (err) {
      failures.push(`orbit-planes: ${err.message}`);
    }
  }
  // ——— 自动收起（t12）：默认配置下收起/展开/浮层抑制，以及「收起的 chrome 不许吃点击」———
// 为什么要有它：`hudAutoHide` 默认 true，但**所有**为了防偶发超时预置 `hudAutoHide:false` 的夹具
// 都绕开了它——于是「自动收起」自己没有任何 pass 在测。这条跑的是**默认配置**（不预置 localStorage）。
//
// 两条容易漏的（设计方明确要求）：
//  1. `collapsedAtMs` **只记录，不判 ==2000**：setTimeout 只能迟到不能早到，写死就成了忙机器天天红。
//  2. **收起的 chrome 不许吃点击**：HUD 根是 pointer-events-none，收起的条一旦变成可点区域，
//     就等于把画布的选择热区挖掉一块（t11 的矩阵量过那片区域）。
const HUD_COLLAPSE_MAX_MS = 5000; // 等待上限；不是判据值
const HUD_NEGATIVE_HOLD_MS = 2600; // 负对照静置时长：大于收起阈值的余量，但不写死成"正好阈值+600"

const hudState = (page) =>
  page.evaluate(() => {
    const q = (sel) => document.querySelectorAll(sel).length;
    const one = (sel) => document.querySelector(sel);
    const autoHideBtn = one('button[aria-label^="自动收起"]');
    const topHandle = one('button[aria-label="展开天体列表"]');
    return {
      topChrome: q('[data-hud-chrome="top"]'),
      dockChrome: q('[data-hud-chrome="dock"]'),
      chipRow: q("#chip-row"),
      topHandle: q('button[aria-label="展开天体列表"]'),
      dockHandle: q('button[aria-label="展开操作台"]'),
      range: q('footer input[type="range"]'),
      header: q("header"),
      overlay: q('[data-overlay-open="true"]'),
      autoHidePressed: autoHideBtn ? autoHideBtn.getAttribute("aria-pressed") : null,
      topHandleExpanded: topHandle ? topHandle.getAttribute("aria-expanded") : null,
    };
  });

async function waitHudCollapsed(page, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await hudState(page);
    if (s.chipRow === 0) return { ms: Date.now() - t0, state: s };
    await page.waitForTimeout(100);
  }
  return { ms: null, state: await hudState(page) };
}

async function runHudAutoHide(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); // 不预置 localStorage = 默认配置
  const page = await ctx.newPage();
  const out = {};
  try {
    await page.goto(base, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    out.initial = await hudState(page);

    // 1) 指针进场景中央 → 等它自己收起（计时器只在真实 pointermove 之后才上膛）
    await page.mouse.move(640, 300);
    const collapsed = await waitHudCollapsed(page, HUD_COLLAPSE_MAX_MS);
    out.collapsedAtMs = collapsed.ms; // 只记录
    out.collapsed = collapsed.state;
    // 收起的 chrome 不许吃点击：原顶部区位置必须命中画布
    out.collapsedHitTest = await page.evaluate(() => {
      const el = document.elementFromPoint(640, 90);
      return { tag: el ? el.tagName : null };
    });

    // 2) 回顶部唤醒
    await page.mouse.move(300, 40);
    await page.waitForTimeout(400);
    out.afterTopWake = await hudState(page);
    // 3) 到底栏唤醒
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    out.afterDockWake = await hudState(page);

    // 4) 负对照：浮层开着时 chrome 不许被收（最容易坏的方式不是"不收"，而是"把浮层一起收了"）
    await page.mouse.move(300, 40);
    await page.waitForSelector('button[aria-label="设定时刻"]', { state: "visible", timeout: 5000 });
    await page.locator('button[aria-label="设定时刻"]').first().click({ timeout: 8000, force: true });
    await page.waitForTimeout(300);
    out.overlayOpen = await hudState(page);
    await page.mouse.move(640, 300);
    await page.waitForTimeout(HUD_NEGATIVE_HOLD_MS);
    out.overlayHeld = await hudState(page);

    // 5) 关浮层后再静置 → 必须能收（证明抑制跟着浮层生命周期走，不是永久关闭）
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.mouse.move(320, 45); // 一次真实移动：计时器需要 pointermove 才上膛
    await page.waitForTimeout(150);
    await page.mouse.move(640, 300);
    const collapsed2 = await waitHudCollapsed(page, HUD_COLLAPSE_MAX_MS);
    out.collapsedAfterEscape = { ms: collapsed2.ms, state: collapsed2.state };
    return out;
  } finally {
    await ctx.close();
  }
}

function judgeHudAutoHide(res) {
  const name = "hud-autohide";
  const i = res.initial;
  if (!i) {
    failures.push(`${name}: 没拿到初始状态 —— 判据不成立`);
    return { available: false };
  }
  // 默认配置 + 标记存在性（标记缺了 = 夹具失效，要红，否则将来重构掉标记这条会静默变绿）
  if (i.autoHidePressed !== "true") {
    failures.push(`${name}: 默认配置下「自动收起」aria-pressed=${i.autoHidePressed}，应为 "true"（被预置成关了？或默认值变了）`);
  }
  if (i.topChrome !== 1) failures.push(`${name}: [data-hud-chrome="top"] 计数 ${i.topChrome}，应为 1 —— 标记没了，这条 pass 会静默变绿`);
  if (i.dockChrome !== 1) failures.push(`${name}: [data-hud-chrome="dock"] 计数 ${i.dockChrome}，应为 1 —— 同上`);
  if (i.chipRow !== 1) failures.push(`${name}: 初始应展开，但 #chip-row 计数 ${i.chipRow}`);
  if (i.range !== 1) failures.push(`${name}: 初始应展开，但 footer range 计数 ${i.range}`);
  if (i.topHandle !== 0 || i.dockHandle !== 0) {
    failures.push(`${name}: 展开态不该出现把手（top ${i.topHandle} / dock ${i.dockHandle}）`);
  }

  const c = res.collapsed;
  if (!c || res.collapsedAtMs === null) {
    failures.push(`${name}: ${HUD_COLLAPSE_MAX_MS}ms 内没有收起 —— 自动收起失效，或计时器没上膛（夹具必须真的 pointermove）`);
  } else {
    if (c.chipRow !== 0) failures.push(`${name}: 收起后 #chip-row 计数 ${c.chipRow}，应为 0（收起是卸载，不是 display:none）`);
    if (c.topHandle !== 1) failures.push(`${name}: 收起后应出现顶部把手，实际 ${c.topHandle}`);
    if (c.range !== 0) failures.push(`${name}: 收起后 footer range 计数 ${c.range}，应为 0`);
    if (c.header !== 1) failures.push(`${name}: 收起不该收抬头（header 计数 ${c.header}）`);
  }
  if (res.collapsedHitTest && res.collapsedHitTest.tag !== "CANVAS") {
    failures.push(
      `${name}: 收起后原 chrome 位置命中的是 ${res.collapsedHitTest.tag}，应为 CANVAS —— 收起的条把画布的选择热区挖掉了一块`,
    );
  }
  if (!res.afterTopWake || res.afterTopWake.chipRow !== 1) failures.push(`${name}: 指针回到顶部没有展开芯片行`);
  if (!res.afterDockWake || res.afterDockWake.range !== 1) failures.push(`${name}: 指针回到底栏没有展开操作台`);

  if (!res.overlayOpen || res.overlayOpen.overlay !== 1) {
    failures.push(`${name}: 没能打开浮层（负对照不成立，这条测不出东西）`);
  } else if (!res.overlayHeld || res.overlayHeld.overlay !== 1 || res.overlayHeld.chipRow !== 1 || res.overlayHeld.range !== 1) {
    failures.push(
      `${name}: 浮层开着时 chrome 被收起了（overlay ${res.overlayHeld?.overlay} / chip-row ${res.overlayHeld?.chipRow} / range ${res.overlayHeld?.range}）` +
        ` —— 自动收起把浮层一起收了，这是它最容易坏的方式`,
    );
  }
  if (!res.collapsedAfterEscape || res.collapsedAfterEscape.ms === null) {
    failures.push(`${name}: 关掉浮层后再静置没有收起 —— 抑制变成了永久关闭`);
  }
  return {
    available: true,
    collapsedAtMs: res.collapsedAtMs,
    collapsedAfterEscapeMs: res.collapsedAfterEscape?.ms ?? null,
    note: "collapsedAtMs 只记录，不判 ==2000（setTimeout 只能迟到不能早到）",
    ...res,
  };
}

// ——— 大红斑（聚焦档认得出、夜面认不出）———
  if (want("jupiter-spot")) {
    try {
      const spot = await runJupiterSpot(browser, base);
      results.push({ pass: "jupiter-spot", 分类: "结构量（像素统计 + 绝对下限）", ...judgeJupiterSpot(spot) });
    } catch (err) {
      failures.push(`jupiter-spot: ${err.message}`);
    }
  }
  // ——— 自动收起（默认配置）———
  if (want("hud-autohide")) {
    try {
      const hud = await runHudAutoHide(browser, base);
      results.push({ pass: "hud-autohide", 分类: "结构量（DOM 存在性 + 属性；collapsedAtMs 只记录）", ...judgeHudAutoHide(hud) });
    } catch (err) {
      failures.push(`hud-autohide: ${err.message}`);
    }
  }
  // ——— 滚轮在 HUD 上必须仍然缩放 ———
  if (want("hud-wheel")) {
    try {
      const hw = await runHudWheel(browser, base);
      results.push({ pass: "hud-wheel", 分类: "结构量（distTarget + elementFromPoint 留证）", ...judgeHudWheel(hw) });
    } catch (err) {
      failures.push(`hud-wheel: ${err.message}`);
    }
  }
  // ——— 月食半球判据（正侧暗 / 反侧不暗）———
  if (want("eclipse-hemisphere")) {
    try {
      const ec = await runEclipseHemisphere(browser, base);
      results.push({ pass: "eclipse-hemisphere", 分类: "结构量（整盘平均亮度 + 几何分组）", ...judgeEclipseHemisphere(ec) });
    } catch (err) {
      failures.push(`eclipse-hemisphere: ${err.message}`);
    }
  }
  // ——— 数值断言（批判位指出的验收夹具缺失，这里补上）———
  // XG_ONLY 设了就不再往下跑：反向测试只关心某条 page pass 会不会红，数值段是最费时的部分。
  // 用带标签的块 + break，而不是整体包一层 if —— 后者要把下面几百行整体缩进一层，
  // 那种 diff 没人能审。所以块里缩进保持原样，这是有意的。
  numeric: {
    if (ONLY.length && !ONLY.includes("numeric")) break numeric;
  // 基线 A：遥测页开起来之前量一次。基线 B：遥测页关掉之后量一次。
  // 两次夹住场景采样，分母取两者较大值 —— 机器状态在这段里漂了也能吃掉一部分。
  let baselineA = null;
  let baselineB = null;
  let frameTime = null;
  let steadyDeltas = null;
  try {
    baselineA = await measureBaseline(browser);
  } catch (err) {
    failures.push(`frame-time: 基线 A（场景前）测量失败：${err.message}`);
  }
  const numCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const numPage = await numCtx.newPage();
  const numErrors = [];
  numPage.on("pageerror", (e) => numErrors.push(e.message));
  numPage.on("console", (m) => m.type() === "error" && numErrors.push(m.text()));
  try {
    await numPage.goto(base, { waitUntil: "load" });
    await numPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });

    // A1 帧时间：分两段采。启动段单列不判（首帧要几何首建 + 13 张程序化贴图排队；
    //    1.1.2 起贴图改成 5ms 分帧，但那只是把一次性成本摊进若干帧，仍然会拉高启动段的间隔），
    //    稳态段才断言 —— 混在一起测会把一次性成本当成持续缺陷。
    //    贴图预算的实测数字见 scripts/README.md「贴图预算与首屏」（node scripts/texture-report.mjs）。
    //    判定见 judgeFrameTime：绝对 ms 只记录，判的是「场景 ÷ 本次机器基线」的比值。
    const startupDeltas = await collectDeltas(numPage);
    await numPage.waitForTimeout(2500); // 让贴图与几何生成完
    steadyDeltas = await collectDeltas(numPage);
    frameTime = {
      pass: "frame-time",
      passesPerFrame: CAL_PASSES,
      startup: statsOf(startupDeltas, ownThreshold(startupDeltas)),
    };
    results.push(frameTime); // 引用入列：后面补上 steady / baseline / normalized 会一起落进 JSON

    // A2 命中矩阵：投影的天体数（判）+ 屏幕重叠对数（**只记录，永不判红**）
    //
    // bodies 判：探针契约是「挂载了几个天体就返回几条」，15 变了说明数据层漏天体。
    //   有意增删天体时，这里和 README「探针契约」一起改。
    // overlapping **不判**：它随轨道相位浮动 —— 2026-10-24 同一天 15 次运行实测 12–17
    //   （同一份代码，只是模拟时间不同）。一个会随模拟时间变的数字没有「好坏」可言：
    //   它红了，你既不知道该改相机、改数据，还是改时钟。保留在 results 里只为看趋势。
    //   **别在本文件的任何地方给 overlapping 加阈值**，包括「大致范围」这种软判据。
    const hits = await numPage.evaluate(() => {
      const bodies = window.__solarProbe?.() ?? [];
      const pairs = [];
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const d = Math.hypot(bodies[i].x - bodies[j].x, bodies[i].y - bodies[j].y);
          if (d < 44) pairs.push(`${bodies[i].id}/${bodies[j].id}@${d.toFixed(1)}px`);
        }
      }
      return { count: bodies.length, pairs };
    });
    results.push({
      pass: "hit-matrix",
      bodies: hits.count,
      overlapping: hits.pairs.length, // 趋势用，不参与判定
      pairs: hits.pairs.slice(0, 6),
    });
    if (hits.count !== 15) {
      failures.push(
        `hit-matrix: 探针只返回 ${hits.count} 个天体，应为 15（数据层漏天体；若是有意增删，改这里 + README 探针契约）`,
      );
    }

    // A3 跟随抖动：选中地球后连采 90 帧，目标屏幕位置的峰峰值
    await numPage.locator("#chip-earth").click();
    /*
     * ⑤ settled 前置：**相机没稳定就不采样**。
     *
     * 为什么必须加：一次全量里这条量到 **86.60px**（阈值 0.5px 的 173 倍），下一轮却是 **0px**，
     * 单跑也绿——不是边缘抖动，是**采样窗口开在聚焦动画还没收敛的时候**（目标屏幕位置正在大幅移动）。
     * 那种 flake 比没有判据更坏：红几次之后人就开始不看红了。
     *
     * 判据：连续两次读到的 `candidates().d`（跟随目标到相机距离）一致（相对差 < 0.1%），
     * 才算 settled。不满足 → `settled:false`，**不判绿也不判红**，但必须出现在结果里。
     */
    const waitSettled = async (maxMs = 6000) => {
      const t0 = Date.now();
      let prev = null;
      let reads = 0;
      while (Date.now() - t0 < maxMs) {
        const d = await numPage.evaluate(() => {
          const c = window.__solarPick?.candidates?.().find((x) => x.id === "earth");
          return c ? +c.depth.toFixed(5) : null;
        });
        reads++;
        if (d !== null && prev !== null && Math.abs(d - prev) / Math.max(1e-6, d) < 0.001) {
          return { settled: true, waitedMs: Date.now() - t0, reads, depth: d };
        }
        prev = d;
        await numPage.waitForTimeout(160);
      }
      return { settled: false, waitedMs: Date.now() - t0, reads, depth: prev };
    };
    const settledInfo = await waitSettled();
    let jitter = null;
    if (!settledInfo.settled) {
      /*
       * **`settled:false` = 红**（t56 F3 修正，批判位打回）。
       *
       * 原来这里只记一条 `px:null` 的结果、不判红——但这条 pass 测的就是「跟随期间目标屏幕位置稳不稳」，
       * **相机一直不稳正是它要抓的 bug**。记成"跳过"等于放走它：`t44` 记的那次 86.6px
       * （阈值的 173 倍）就是"采样窗口在聚焦动画没收敛时开始"，按旧写法它会被记成 settled:false 然后绿。
       * 而且同一批里 ③ 是"探针缺失必须红"，两种缺失一种判红一种判绿，自相矛盾。
       */
      failures.push(
        `follow-jitter: 相机 ${(settledInfo.waitedMs / 1000).toFixed(1)}s 内未稳定（${settledInfo.reads} 次读数）` +
          ` —— 这条判据失去采样前提，**不是通过**。相机一直在动正是它要抓的状态。`,
      );
      results.push({ pass: "follow-jitter", settled: false, ...settledInfo, px: null, note: "相机未稳定 → 判红（不是跳过）" });
    } else {
      jitter = await numPage.evaluate(async () => {
        const xs = [];
        const ys = [];
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const b = (window.__solarProbe?.() ?? []).find((x) => x.id === "earth");
          if (b) {
            xs.push(b.x);
            ys.push(b.y);
          }
        }
        const span = (v) => Math.max(...v) - Math.min(...v);
        return { samples: xs.length, px: +Math.max(span(xs), span(ys)).toFixed(4) };
      });
      results.push({ pass: "follow-jitter", settled: true, settledWaitedMs: settledInfo.waitedMs, ...jitter });
    }
    // 沙盘里本来就该是亚百分之一像素；1:1 实境接入后这条才有咬合力（那时会到 2.5 px）
    // 只有 settled 的那一轮才有 px，所以判据挂在它后面——未稳定的轮次上面已经单独记成 settled:false
    if (settledInfo.settled && jitter && jitter.px >= 0.5) failures.push(`follow-jitter: 目标屏幕抖动 ${jitter.px}px ≥ 0.5px`);
    if (numErrors.length) failures.push(`numeric: 控制台报错 ${numErrors.length} 条`);
  } catch (err) {
    failures.push(`numeric: ${err.message}`);
  }
  await numCtx.close();
  // 基线 B：遥测页已关，光栅不再被它抢。和基线 A 一起夹住场景采样，取较大分母。
  try {
    baselineB = await measureBaseline(browser);
  } catch (err) {
    failures.push(`frame-time: 基线 B（场景后）测量失败：${err.message}`);
  }
  const baselines = [baselineA, baselineB].filter(Boolean);
  if (frameTime && steadyDeltas && baselines.length) {
    frameTime.baseline = {
      passesPerFrame: CAL_PASSES,
      before: baselineA,
      after: baselineB,
      denominatorMs: +Math.max(...baselines.map(denomOf)).toFixed(1),
    };
    judgeFrameTime(frameTime, steadyDeltas, baselines);
  } else {
    // 不许静默跳过：采样缺失或基线全废，本身就是验收失败（否则这条断言就成了摆设）
    failures.push(
      `frame-time: 无法判定（稳态采样 ${steadyDeltas ? "有" : "缺"}，基线 ${baselines.length}/2 次成功）`,
    );
  }
  // ——— 实境原型（?proto=1）：真实单位、相机离地球 1e7 m ———
  // 注意：探针读的是 JS 侧的投影结果（double），**看不见 GPU 顶点着色器里的
  // float32 量化**。所以这里能验的是「1:1 场景没炸、相机与 near/far 站得住」，
  // 真正的精度抖动要靠像素回读，那是下一步的事。
  const protoCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const protoPage = await protoCtx.newPage();
  const protoErrors = [];
  protoPage.on("pageerror", (e) => protoErrors.push(e.message));
  protoPage.on("console", (m) => m.type() === "error" && protoErrors.push(m.text()));
  try {
    await protoPage.goto(`${base}?proto=1`, { waitUntil: "load" });
    await protoPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await protoPage.waitForTimeout(1200);
    const proto = await protoPage.evaluate(async () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      let maxOffset = 0;
      let samples = 0;
      let count = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bodies = window.__solarProbe?.() ?? [];
        count = bodies.length;
        const earth = bodies.find((b) => b.id === "earth");
        if (earth) {
          samples++;
          maxOffset = Math.max(maxOffset, Math.hypot(earth.x - cx, earth.y - cy));
        }
      }
      return { bodies: count, samples, centerOffsetPx: +maxOffset.toFixed(3) };
    });
    const protoCanvas = await sampleCanvasPixels(protoPage);
    await protoPage.screenshot({ path: path.join(SHOTS, "proto-real.png") });
    results.push({ pass: "proto-real", ...proto, canvasPixels: protoCanvas, errors: protoErrors });
    if (proto.bodies !== 3) failures.push(`proto-real: 原型应有 3 个天体，实际 ${proto.bodies}`);
    if (proto.centerOffsetPx > 1) failures.push(`proto-real: 地球没钉在屏幕中心，偏移 ${proto.centerOffsetPx}px`);
    judgeCanvasPixels("proto-real", protoCanvas);
    if (protoErrors.length) failures.push(`proto-real: 报错 ${protoErrors.length} 条`);
  } catch (err) {
    failures.push(`proto-real: ${err.message}`);
  }
  await protoCtx.close();

  // ——— 实境原型的 GPU 精度抖动：像素回读 ———
  // proto-real 的探针读的是 JS 侧 double 投影，看不见顶点着色器里的 float32 量化。
  // 这一条直接读帧缓冲：取地球圆盘左右缘的中点（多行对称平均），看它逐帧游走多少像素。
  // 对照组 ?legacy=1 把顶点着色器切回 modelMatrix*viewMatrix 的旧写法，
  // 两者除 gl_Position 的算法外逐字相同，所以差异只可能来自顶点位置的 float32 量化。
  //
  // ⚠ 这条 pass 的四个非显然依赖，动任何一个都会**静默失效**（不报错，只是测不出东西）：
  //   ① 视口必须钉死 1920×1080 + dist=1.2e7：这个距离是反解出来的。再近，圆盘左右缘
  //      出画面就取不到边缘；再远，f/视距 变小、信号被噪声底吃掉。
  //   ② 断言值绑当前实测：modern.pp < 0.35（实测 0.114–0.142）、legacy > 3× modern
  //      且 > 0.4px（实测 0.783–0.866，约 6×）、噪声底 0.08–0.10px。
  //   ③ 背景色不能写死：输出色空间是 sRGB，setClearColor 的值会先转线性（实测落在
  //      8.94 亮度），采样器是从四角 4×4 块**实测**背景的，写死就全歪。
  //   ④ 原型里必须关云层壳（spec.unit !== "meter" 那个条件）且冻结自转/公转：
  //      1.02× 半透明壳会把轮廓偏移 8px、噪声 0.1→0.6px；自转会把贴图暗区转进转出遮罩，
  //      拉动质心 10–18px。开着任意一条，这条断言就废了。
  // 调试入口：?proto=1&still=1 是相机钉死状态，噪声底应在 0.08–0.10px。
  // **噪声底本身变高 = 几何细分或云层开关被改了，不是浮点问题。**
  //
  // 估计量：p10–p90（120 帧）。原先用 max−min，那两个数只由两个离群点决定，测的是运气。
  // 换 p10–p90 后实测（三次连续跑）：modern 0.073–0.079、legacy 0.408–0.474，比值 5.2–6.5×。
  // 阈值：modern < 0.35（余量 4.4×）、legacy > 3× modern（余量 1.7–2.2×，比 max−min 时代的
  // 3.8× 宽敞多了，这正是换估计量的目的）、legacy > 0.2。
  // ⚠ legacy 的下限从 0.4 挪到 0.2，是**跟着估计量换算的**，不是放宽：0.4 是按 max−min
  // （实测 0.65–0.87）定的，换 p10–p90 后整体数值下移约 40%，0.4 离实测最小值只剩 2%，
  // 必然误红。0.2 保留了原来「约 2× 余量」的设计意图，真正负责区分的是 3× 那条。
  const JITTER_FRAMES = 120;
  const MODERN_PP_MAX = 0.35;
  const LEGACY_RATIO_MIN = 3;
  const LEGACY_PP_MIN = 0.2;

  const jitterCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const jitterPage = await jitterCtx.newPage();
  const jitterErrors = [];
  jitterPage.on("pageerror", (e) => jitterErrors.push(e.message));
  jitterPage.on("console", (m) => m.type() === "error" && jitterErrors.push(m.text()));
  const sampleJitter = async (query) => {
    await jitterPage.goto(`${base}${query}`, { waitUntil: "load" });
    await jitterPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await jitterPage.waitForTimeout(1500);
    return jitterPage.evaluate(async (want) => {
      const out = [];
      let frames = 0;
      let bad = 0;
      while (out.length < want && frames < want * 4) {
        await new Promise((r) => requestAnimationFrame(r));
        frames++;
        const p = window.__solarPixels?.();
        if (p && Number.isFinite(p.x)) out.push(p.x);
        else bad++;
      }
      if (!out.length) return { samples: 0, bad };
      const sorted = [...out].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      // 判据用 p10–p90：max−min 只由两个离群点决定，测的是运气；p10–p90 测的是分布宽度。
      const pp = at(0.9) - at(0.1);
      const ppFull = sorted[sorted.length - 1] - sorted[0];
      return {
        samples: out.length,
        bad,
        pp: +pp.toFixed(3),
        ppFull: +ppFull.toFixed(3), // 留档：旧判据（max−min）的口径，供对照走势
        p10: +at(0.1).toFixed(2),
        p90: +at(0.9).toFixed(2),
        x0: +out[0].toFixed(2),
      };
    }, JITTER_FRAMES);
  };
  try {
    const modern = await sampleJitter("?proto=1&dist=1.2e7");
    await jitterPage.screenshot({ path: path.join(SHOTS, "proto-jitter-modern.png") });
    const legacy = await sampleJitter("?proto=1&legacy=1&dist=1.2e7");
    await jitterPage.screenshot({ path: path.join(SHOTS, "proto-jitter-legacy.png") });
    results.push({ pass: "proto-jitter", modern, legacy, errors: jitterErrors });

    if (!modern.samples || !legacy.samples) {
      failures.push(`proto-jitter: 像素回读没采到样本（modern ${modern.samples} / legacy ${legacy.samples}）`);
    } else {
      // 阈值见上方注释：0.35 / 3× / 0.2。换的只是估计量：p10–p90 比 max−min 抗离群。
      if (modern.pp >= MODERN_PP_MAX) {
        failures.push(`proto-jitter: 现代路径 p10–p90 ${modern.pp}px 未低于 ${MODERN_PP_MAX}px`);
      }
      if (legacy.pp <= modern.pp * LEGACY_RATIO_MIN || legacy.pp <= LEGACY_PP_MIN) {
        failures.push(
          `proto-jitter: legacy p10–p90 ${legacy.pp}px 未显著高于现代 ${modern.pp}px（需 >${LEGACY_RATIO_MIN}× 且 >${LEGACY_PP_MIN}px）—— 对照失效，断言就没意义`,
        );
      }
    }
    if (jitterErrors.length) failures.push(`proto-jitter: 报错 ${jitterErrors.length} 条`);
  } catch (err) {
    failures.push(`proto-jitter: ${err.message}`);
  }
  await jitterCtx.close();

  // ——— 缩放预算 + 禁止穿模 + 星空亮度上限（t33）———
  //
  // 三个量分属两类判据，别混：
  //  · 缩放格数 = **归一化观测量**，可以判红：它问的是「从 A 视距到 B 视距要几次输入」，
  //    与机器性能无关（不读帧时间、不读像素）。但**依赖输入节奏**：缩放走速度模型之后，
  //    「加速窗口」不再是某个固定常量（别再引用具体毫秒数），夹具仍用 20ms 连发——
  //    这个节奏由夹具控制而不是机器状态，实测有效间隔落在 90–104ms，仍在窗口内。
  //    所以这里额外记录 maxGapMs：万一机器卡到单次间隔 >300ms（加速会被重置），
  //    按「环境抖动」处理成不判红，免得把负载误判成产品回归。
  //  · 禁止穿模 = **结构量**，判红：相机必须留在太阳球体之外，与性能/时间无关。
  //  · 星空亮度 = **归一化观测量**，判红：设计口径是「星空像素平均亮度 ≤ 背景色亮度 4 倍」，
  //    阈值来自设计（4×），不是来自观察（「现在测出 12 所以定 20」）。背景色亮度由
  //    #07090e 的三个通道现算，不抄实测数字。
  //
  // 与「画布不是全黑」那条的关系：那条在全画布取 25 块、meanLum ≥ 2（判「画出来没有」）；
  // 这条取**边缘 12 块**（跳过中央 2×2，避开天体）、判「星星有没有过曝」。
  // 区域与统计目的都不同，所以 14.12（边缘均值）与 23.56（全画布均值）不是一个量，互不迁就。
  const SUN_RADIUS_WORLD = 3.8; // src/solar/data.ts 的 sun.radius（天体数值改动须 captain 批，别跟着读数改这一行）
  const ZOOM_TARGET_RATIO = 3; // 「太阳占画面约一半」的设计目标：视距 = 3R
  const ZOOM_STEP_BUDGET = 15; // 设计预算：≤15 次 wheel 必须到位（改前约 80 格 / 改后实测 11 格）
  const NO_CLIP_RATIO = 1.2; // 相机到太阳中心 ≥ 1.2R 才算没穿模
  const ZOOM_MAX_STEPS = 20; // 预算之外再给几步，够判定「超预算」即可
  const ZOOM_GAP_MS = 20; // 夹具的连发节奏（要落在产品的加速窗口内才会触发加速；窗口长度是行为，不是常量）
  const ZOOM_GAP_SUSPECT_MS = 300; // 单次间隔超过它，就认为本跑的加速可能被重置（环境抖动）
  const SKY_MAX_RATIO = 4; // 设计口径：星空平均亮度 ≤ 背景色 4 倍
  const SKY_BG_LUMA = 0.2126 * 7 + 0.7152 * 9 + 0.0722 * 14; // #07090e 的相对亮度 ≈ 8.94

  const zbCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const zbPage = await zbCtx.newPage();
  const zbErrors = [];
  zbPage.on("pageerror", (e) => zbErrors.push(e.message));
  zbPage.on("console", (m) => m.type() === "error" && zbErrors.push(m.text()));
  try {
    await zbPage.goto(withDiag(base), { waitUntil: "load" });
    await zbPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await zbPage.waitForTimeout(1800); // 等贴图与镜头稳定

    // ① 星空亮度（必须在放大之前测：放大后整屏是太阳）
    const sky = await sampleSkyLuma(zbPage, SKY_BG_LUMA, SKY_MAX_RATIO);

    // ② 缩放格数：从 home 起连发 wheel（向上 = 放大），数到 depth ≤ 3R 为止
    const home = await readSunState(zbPage);
    let stepsToTarget = null;
    let last = home;
    const gaps = [];
    if (home.available) {
      await zbPage.mouse.move(640, 360);
      for (let i = 1; i <= ZOOM_MAX_STEPS; i++) {
        const t0 = performance.now();
        await zbPage.mouse.wheel(0, -120);
        await zbPage.waitForTimeout(ZOOM_GAP_MS);
        gaps.push(performance.now() - t0);
        last = await readSunState(zbPage);
        if (!last.available) break;
        if (last.depth <= SUN_RADIUS_WORLD * ZOOM_TARGET_RATIO) {
          stepsToTarget = i;
          break;
        }
      }
    }

    // ③ 禁止穿模：再连发到 30 次总输入，读最终视距
    let deepest = last;
    if (home.available) {
      for (let i = 0; i < 30; i++) {
        await zbPage.mouse.wheel(0, -120);
        await zbPage.waitForTimeout(ZOOM_GAP_MS);
      }
      deepest = await readSunState(zbPage);
    }

    const maxGapMs = gaps.length ? Math.max(...gaps) : 0;
    const timingSuspect = maxGapMs > ZOOM_GAP_SUSPECT_MS;
    const depthOverR = deepest.available ? deepest.depth / SUN_RADIUS_WORLD : null;
    results.push({
      pass: "zoom-budget",
      sky,
      home: home.available ? { depth: +home.depth.toFixed(3), radiusPx: +home.radiusPx.toFixed(2) } : home,
      stepsToTarget,
      budget: ZOOM_STEP_BUDGET,
      targetDepth: +(SUN_RADIUS_WORLD * ZOOM_TARGET_RATIO).toFixed(2),
      deepest: deepest.available ? { depth: +deepest.depth.toFixed(3), radiusPx: +deepest.radiusPx.toFixed(2) } : deepest,
      depthOverR: depthOverR === null ? null : +depthOverR.toFixed(3),
      noClipFloor: +(SUN_RADIUS_WORLD * NO_CLIP_RATIO).toFixed(2),
      maxGapMs: +maxGapMs.toFixed(1),
      timingSuspect,
      errors: zbErrors,
    });

    if (!home.available) {
      failures.push(`zoom-budget: 读不到太阳视距（${home.reason}）—— __solarPick.candidates 是判定依据，钩子没了就等于判不了`);
    } else {
      if (stepsToTarget === null) {
        failures.push(
          `zoom-budget: ${ZOOM_MAX_STEPS} 次 wheel 后仍未缩到 ${(SUN_RADIUS_WORLD * ZOOM_TARGET_RATIO).toFixed(2)}（当前 ${last.depth?.toFixed(2)}）`,
        );
      } else if (stepsToTarget > ZOOM_STEP_BUDGET) {
        // 环境抖动（连发间隔被打断、加速被重置）时不判红：那是把负载当回归
        const msg = `zoom-budget: 缩到 3R 用了 ${stepsToTarget} 次 wheel > 预算 ${ZOOM_STEP_BUDGET}`;
        if (timingSuspect) console.error(`（注意）${msg}，但本轮 maxGapMs=${maxGapMs.toFixed(0)}ms > ${ZOOM_GAP_SUSPECT_MS}ms，按环境抖动不判红`);
        else failures.push(msg);
      }
      if (!deepest.available) {
        failures.push(`zoom-budget: 最终视距读不到（${deepest.reason}）`);
      } else if (!Number.isFinite(deepest.depth) || deepest.depth === 0) {
        failures.push(`zoom-budget: 最终视距是 ${deepest.depth}（0/NaN 说明相机被夹到中心了）`);
      } else if (deepest.depth < SUN_RADIUS_WORLD * NO_CLIP_RATIO * 0.995) {
        // 0.5% 容差：产品的 minDistance 恰好压在 1.2R 上（实测 4.56 = 1.2×3.8），
        // 断言不带容差会因浮点误差偶发误红；真正要守的是「没进到球体里」。
        failures.push(
          `zoom-budget: 相机穿到太阳里了：视距 ${deepest.depth.toFixed(3)} < 1.2R = ${(SUN_RADIUS_WORLD * NO_CLIP_RATIO).toFixed(2)}`,
        );
      }
    }
    if (sky.available) {
      if (sky.mean > sky.cap) {
        failures.push(
          `zoom-budget: 星空过曝：边缘区平均亮度 ${sky.mean} > 背景 ${sky.bgLuma} × ${SKY_MAX_RATIO} = ${sky.cap}`,
        );
      }
    } else {
      console.error(`（注意）星空亮度测不了：${sky.reason}`);
    }
    if (zbErrors.length) failures.push(`zoom-budget: 控制台/页面报错 ${zbErrors.length} 条`);
  } catch (err) {
    failures.push(`zoom-budget: ${err.message}`);
  }
  await zbCtx.close();

  // ═══ 太阳遮挡（t42 的守卫）+ 启动分期（t41）+ 相机避让测量（t47 的基线）═══
  //
  // 三条的分类不一样，别混：
  //  · 太阳遮挡 = **结构量**，判红：光晕 Sprite 的 depthTest 一旦被改回 false，
  //    木星哪怕挡在太阳前面，中心也会被那颗亮核穿透（t42 实测改前 171.3 / 改后 18.9）。
  //  · 启动分期 = 半结构：`__solarReady` 只在全量置位（用 belt 可观测），长任务**只记录**
  //    ——那台机器上长任务判据分不出启动和稳态（已有结论），拿它判红就是重犯 26ms 的错。
  //  · 相机避让 = **只测量**：t47 还没落地，现在还没有"多少算跳变"的依据，先攒基线。
  // 注：这里原来有个 `SUN_JUP_ALIGN_PX = 12` 的 px 容差，已删。它按旧几何标定、与缩放/dpr 绑定，
  //     而「太阳盘被木星挡住」本来就能用几何直接判：`delta + 太阳屏半径 ≤ 木星屏半径`（见对齐循环）。
  const OCCLUSION_LUM_MAX = 60; // 设计口径：被挡住时中心亮度应明显低于"透亮核"（改前 171.3）
  const EARTH_RADIUS_WORLD = 0.76; // src/solar/data.ts 的 earth.radius（天体数值改动须 captain 批）
  const CLEARANCE_FRAMES = 260; // ≈1.7 个公转周期（月球 period 2.55，speed 1 时 1 单位≈1 秒）

  /** 取某几个天体的候选（拾取器会把相机背后的天体剔除，所以 sun 可能是 null） */
  const candidatesOf = (page, ids) =>
    page.evaluate((ids) => {
      const cs = window.__solarPick?.candidates?.() ?? [];
      const out = {};
      for (const id of ids) {
        const c = cs.find((x) => x.id === id);
        out[id] = c ? { x: +c.x.toFixed(1), y: +c.y.toFixed(1), r: +c.radiusPx.toFixed(1), d: +c.depth.toFixed(3) } : null;
      }
      return { ...out, total: cs.length };
    }, ids);

  /** 以 (cx,cy) 为中心采 size×size 的亮度（CSS px，内部换算设备像素与 Y 轴翻转） */
  const boxLuma = (page, cx, cy, size) =>
    page.evaluate(
      async ({ cx, cy, size }) => {
        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const scale = canvas.width / canvas.clientWidth;
        const n = Math.max(2, Math.round(size * scale));
        const x = Math.round(cx * scale - n / 2);
        const y = Math.round(canvas.height - cy * scale - n / 2);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const buf = new Uint8Array(n * n * 4);
        gl.readPixels(x, y, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        }
        return +(sum / (n * n)).toFixed(2);
      },
      { cx, cy, size },
    );

  // ——— ① 太阳被木星挡住时必须变暗 ———
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    try {
      await page.goto(withDiag(base), { waitUntil: "load" });
      await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(800);
      // 机位不硬编码：先点木星芯片让它成为跟随目标，再等聚焦动画收敛
      await page.locator("#chip-jupiter").click();
      let prevDepth = -1;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(200);
        const c = await candidatesOf(page, ["jupiter"]);
        if (c.jupiter && Math.abs(c.jupiter.d - prevDepth) < 0.01) break;
        prevDepth = c.jupiter?.d ?? -1;
      }
      /*
       * ① 先用**几何摆位**把相机放到背光侧，再闭环微调。
       *
       * 旧代码只靠闭环拖动找位置，三个方向全是坑（实测选出来的）：
       *  · 步长：`t10` 接管 dolly、`t34` 接管相机之后，同样的像素拖动改变的角度已不同，
       *    闭环在 26 步里反复跨过头 —— 实测两次运行 deltaPx 44.6 / 19.2 卡在容差外；
       *  · 参照物：太阳一开始**根本不在候选里**（在屏幕外），"找回太阳"那支每次只拖 200px，
       *    于是一整轮都在找而不是在对齐；
       *  · 收敛判据：`SUN_JUP_ALIGN_PX` 是个 px 常数，而这里真正要的是「太阳盘被木星盘挡住」——
       *    与缩放/dpr 无关的写法是 **delta + 太阳屏半径 ≤ 木星屏半径**（全遮挡），见下。
       *
       * `__solarPlace` 的方位角以「**指向太阳**」为 0°，所以 180° = 相机在木星背光侧、
       * 太阳正好落在木星后方。实测这一步就把 deltaPx 打到 **18.3px**（木星屏半径 171.6、
       * 太阳屏半径 80.4，18.3 + 80.4 = 98.7 ≤ 171.6 → 已全遮挡）。
       */
      await page.evaluate((d) => window.__solarPlace?.("jupiter", d, 180, 0), 12.5);
      await page.waitForTimeout(700);
      // ③ 探针缺失 = 判不了 = 红（同 `zoom-budget` 依赖 `__solarPick`）。
      //    几何对齐的前提是这两个钩子在；它们没了，判据就没有对象——此时报绿就是撒谎。
      const probes = await page.evaluate(() => ({
        place: typeof window.__solarPlace === "function",
        candidates: typeof window.__solarPick?.candidates === "function",
        jupiter: Boolean(window.__solarPick?.candidates?.().find((c) => c.id === "jupiter")),
        bodyCount: window.__solarPick?.candidates?.().length ?? 0,
      }));
      if (!probes.place || !probes.candidates || !probes.jupiter) {
        failures.push(
          `sun-occlusion: 探针缺失（__solarPlace=${probes.place}, candidates=${probes.candidates}, 木星=${probes.jupiter}, 候选数=${probes.bodyCount}）` +
            ` —— 钩子没了就等于判不了，不许报绿。检查 ?diag=1 与 diag 探针是否被删。`,
        );
      }

      // 闭环把太阳拖到木星盘面中心（两轴分别自适应符号与步长）。
      // 拖动量由**实测屏幕坐标**算出来，所以换视口/换 dpr 仍然成立。
      const sign = { x: 1, y: 1 };
      const prevAbs = { x: Infinity, y: Infinity };
      let aligned = false;
      let finalState = null;
      let bestCoverSlack = -Infinity;
      let stagnation = 0;
      for (let iter = 0; iter < 24; iter++) {
        const st = await candidatesOf(page, ["jupiter", "sun"]);
        finalState = st;
        if (!st.jupiter) break;
        if (!st.sun) {
          // 摆位之后太阳仍被剔除：只可能是相机没真正到位，小幅回摆一次再继续
          await page.evaluate((d) => window.__solarPlace?.("jupiter", d, 180, 0), 12.5);
          await page.waitForTimeout(400);
          continue;
        }
        const dx = st.sun.x - st.jupiter.x;
        const dy = st.sun.y - st.jupiter.y;
        const delta = Math.hypot(dx, dy);
        // 收敛判据 = 「太阳盘整个落在木星盘内」：delta + 太阳屏半径 ≤ 木星屏半径。
        // 它不是"放宽的 px 容差"，而是这条断言真正要的前提（盘被挡住才谈得上遮挡）；
        // 换成别的缩放/dpr 也自动成立，因为两边都是同一帧的投影半径。
        const coverSlack = st.jupiter.r - (delta + (st.sun.r ?? 0));
        if (coverSlack > bestCoverSlack) {
          bestCoverSlack = coverSlack;
          stagnation = 0;
        } else if (++stagnation >= 5) {
          break; // 连续 5 步没变好：别再空转，把实测数报出去
        }
        if (st.sun.d > st.jupiter.d && coverSlack >= 0) {
          aligned = true;
          break;
        }
        if (Math.abs(dx) > 6) {
          if (Math.abs(dx) > prevAbs.x) sign.x = -sign.x;
          prevAbs.x = Math.abs(dx);
        }
        if (Math.abs(dy) > 6) {
          if (Math.abs(dy) > prevAbs.y) sign.y = -sign.y;
          prevAbs.y = Math.abs(dy);
        }
        // 增益从 0.55 收到 0.25、步长上限 260→60：t10/t34 之后同样的像素拖动改变的角度更大，
        // 大增益必然跨过头（旧版就是 0.55 在 26 步里来回弹）。
        const sx = Math.abs(dx) > 6 ? Math.max(-60, Math.min(60, -dx * 0.25 * sign.x)) : 0;
        const sy = Math.abs(dy) > 6 ? Math.max(-60, Math.min(60, -dy * 0.25 * sign.y)) : 0;
        await page.mouse.move(640, 400);
        await page.mouse.down();
        await page.mouse.move(640 + sx, 400 + sy, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(140);
      }
      const st = (await candidatesOf(page, ["jupiter", "sun"])) ?? finalState;
      const lum = st.jupiter ? await boxLuma(page, st.jupiter.x, st.jupiter.y, 24) : null;
      const deltaPx = st.jupiter && st.sun ? +Math.hypot(st.sun.x - st.jupiter.x, st.sun.y - st.jupiter.y).toFixed(1) : null;
      const sunBehind = st.jupiter && st.sun ? st.sun.d > st.jupiter.d : null;
      results.push({
        pass: "sun-occlusion",
        aligned,
        deltaPx,
        sunBehind,
        // 对齐是怎么达成的、差多少，全部留痕：只看 aligned 一个布尔，下次它变回 false 时无从下手
        alignMethod: "__solarPlace(azimuth=180° = 背光侧) + 闭环微调",
        alignCriterion: "sunBehind 且 (deltaPx + 太阳屏半径) ≤ 木星屏半径（全遮挡）",
        // ② 最近 5 次（含本次）的对齐率：单次未对齐现在直接红，但仍要把趋势记进结果，
        //    否则"红一次修一次"永远看不出它是不是在反复坏。
        alignedRate5: (() => {
          try {
            const hist = readIndex().slice(-4); // 前 4 次 + 本次 = 最近 5 次
            const una = hist.filter((e) => Array.isArray(e.unaligned) && e.unaligned.includes("sun-occlusion")).length;
            // 本次已对齐 → 对齐数 = 5 - (历史未对齐数)；写成 (4-una) 会系统性少算 20%，别再用
            return +((5 - una) / 5).toFixed(2);
          } catch {
            return null;
          }
        })(),
        sunRadiusPx: st.sun?.r ?? null,
        coverSlackPx: st.jupiter && st.sun ? +(st.jupiter.r - (Math.hypot(st.sun.x - st.jupiter.x, st.sun.y - st.jupiter.y) + st.sun.r)).toFixed(1) : null,
        sunDepth: st.sun?.d ?? null,
        jupiterDepth: st.jupiter?.d ?? null,
        jupiterRadiusPx: st.jupiter?.r ?? null,
        centerBoxLum: lum,
        lumMax: OCCLUSION_LUM_MAX,
        box: "24×24 @ 木星投影中心",
        errors: errs,
      });
      if (lum === null) {
        failures.push("sun-occlusion: 拿不到木星候选，采不到中心亮度");
      } else if (!aligned) {
        /*
         * ① 本轮未对齐 = **直接红**。
         *
         * 为什么不再"只记录"：`t44` 之后对齐是**几何摆位**（`__solarPlace` 到 180° 背光侧），
         * 已经没有闭环搜索——它失败只可能是夹具/钩子坏了，不是"环境差异偶尔对不上"。
         * 一条没在判的 pass 报绿，就是我们今晚一直在杀的那种假绿。
         *
         * 为什么不采用"连续 3 次/最近 5 次 <50% 才红"：真实历史（`runs/index.jsonl`）里
         * 8 条只有 1 次未对齐，那一次恰好就是**闸门定义的那次运行**（22 pass 那次）。
         * 按"连续 3 次"或"5 次里 <50%"都不会响——规则在它要防的案例上不触发。
         */
        const hist5 = (() => {
          try {
            return readIndex().slice(-4); // 前 4 次 + 本次 = 最近 5 次
          } catch {
            return [];
          }
        })();
        const unaBefore = hist5.filter((e) => Array.isArray(e.unaligned) && e.unaligned.includes("sun-occlusion")).length;
        const alignedRate5 = +((5 - (unaBefore + 1)) / 5).toFixed(2);
        failures.push(
          `sun-occlusion: 本轮**没在判**（未对齐 Δ=${deltaPx}px, sunBehind=${sunBehind}, 中心亮度 ${lum}）——` +
            `这是**判据失效，不是产品回归**：几何摆位之后不存在"偶尔对不上"，先修夹具/探针。` +
            `最近 5 次对齐率 ${(alignedRate5 * 100).toFixed(0)}%（${unaBefore + 1}/5 未对齐）` +
            (alignedRate5 < 0.5 ? `——已经长期失效，不是单次失手。` : `。`),
        );
        if (alignedRate5 < 0.5) {
          failures.push(
            `sun-occlusion: 最近 5 次对齐率 ${(alignedRate5 * 100).toFixed(0)}% < 50% —— 这条 pass 长期没在判断，` +
              `别把它的绿当成"光晕没问题"。`,
          );
        }
        // 这一轮仍然把数字记进结果（供归档查历史），但**判红**已经在上面的 failures.push 里发生。
        results.push({
          pass: "sun-occlusion",
          aligned: false,
          alignedRate5,
          deltaPx,
          sunBehind,
          centerBoxLum: lum,
          lumMax: OCCLUSION_LUM_MAX,
          unalignedReason: "几何摆位后仍未对齐",
        });
      } else if (lum > OCCLUSION_LUM_MAX) {
        failures.push(
          `sun-occlusion: 太阳被木星挡住时中心亮度 ${lum} > ${OCCLUSION_LUM_MAX}` +
            `（Δ=${deltaPx}px, sun.depth ${st.sun?.d} > 木星 ${st.jupiter?.d}）—— 光晕又穿透了？看 depthTest`,
        );
      }
      if (errs.length) failures.push(`sun-occlusion: 控制台/页面报错 ${errs.length} 条`);
    } catch (err) {
      failures.push(`sun-occlusion: ${err.message}`);
    }
    await ctx.close();
  }

  // ——— ② 启动分期仍然成立 ———
  {
    const LT_INIT = () => {
      window.__lt = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
        }).observe({ type: "longtask", buffered: true });
      } catch {
        window.__lt = null;
      }
    };
    const stages = [];
    for (const q of ["", "?bootstage=1", "?bootstage=2", "?bootstage=3"]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      await page.addInitScript(LT_INIT);
      const t0 = Date.now();
      try {
        await page.goto(`${base}${q ? `${q}&` : "?"}diag=1`, { waitUntil: "load" });
        let ready = true;
        try {
          await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 20000 });
        } catch {
          ready = false;
        }
        const elapsedMs = Date.now() - t0;
        await page.waitForTimeout(600);
        const info = await page.evaluate(() => {
          const lt = window.__lt ?? [];
          const look = window.__solarLook?.();
          const cs = window.__solarPick?.candidates?.() ?? [];
          return {
            ltCount: lt.length,
            ltTotalMs: +lt.reduce((a, e) => a + e.dur, 0).toFixed(0),
            ltMaxMs: +Math.max(0, ...lt.map((e) => e.dur)).toFixed(0),
            bodies: cs.length,
            belt: Boolean(look?.mounted?.belt),
            clouds: look?.mounted?.clouds ?? null,
          };
        });
        stages.push({ query: q || "(默认)", ready, elapsedMs, ...info });
        await page.screenshot({ path: path.join(SHOTS, `boot-${q ? q.replace("?bootstage=", "stage") : "default"}.png`) });
      } catch (err) {
        stages.push({ query: q || "(默认)", error: err.message });
      }
      await ctx.close();
    }
    results.push({ pass: "boot-stage", stages, judged: "天体数 / ready 时 belt；长任务只记录" });
    const def = stages.find((s) => s.query === "(默认)");
    if (!def || def.error) {
      failures.push(`boot-stage: 默认路径测不到（${def?.error ?? "缺记录"}）`);
    } else {
      if (!def.ready) failures.push("boot-stage: 默认路径 20s 内 __solarReady 未置位");
      // ready 只在全量置位 → 到那一刻小行星带（stage3 才有）必须已经挂上
      if (!def.belt) failures.push("boot-stage: ready 时 belt 还没挂 —— ready 提前置位了？");
      if (def.bodies !== 15) failures.push(`boot-stage: 默认路径探针只有 ${def.bodies} 个天体（应 15）`);
    }
    for (const s of stages) {
      if (s.error) continue;
      if (s.bodies !== 15) {
        failures.push(`boot-stage: ${s.query} 只挂到 ${s.bodies} 个天体（应 15 —— 分期不该少画天体）`);
      }
    }
    const pinned = stages.filter((s) => s.query !== "(默认)" && !s.error);
    if (pinned.length === 3) {
      const st3 = pinned.find((s) => s.query.includes("3"));
      const st12 = pinned.filter((s) => !s.query.includes("3"));
      if (st3 && !st3.belt) failures.push("boot-stage: ?bootstage=3 钉全量时 belt 没挂");
      for (const s of st12) {
        if (s.belt) failures.push(`boot-stage: ${s.query} 不应该有小行星带（那是第 3 期）`);
      }
    }
  }

  // ——— ③ 相机避让：先只测量（t47 的基线）———
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await page.goto(withDiag(base), { waitUntil: "load" });
      await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      // 卫星行是条件渲染：先选地球，`#chip-moon` 才出现（Hud.tsx:308）
      await page.locator("#chip-earth").click();
      await page.waitForTimeout(2200);
      const hasMoonChip = (await page.locator("#chip-moon").count()) > 0;
      if (hasMoonChip) await page.locator("#chip-moon").click();
      await page.waitForTimeout(2800);
      const before = await candidatesOf(page, ["moon", "earth"]);
      // 采 ≥3 个公转周期、**分窗口报**。第 1 个窗口是切换残差（实测 0.944–0.983），
      // 第 2 个窗口起才稳定（1.023–1.026）。混在一起取 min，会让同一份代码三次给出
      // 0.94 / 0.98 / 1.03，被当成产品回归——基线的采样纪律就是这么长出来的。
      // 按**模拟时间**分段、不按帧数：无 vsync 时 rAF 能飙到上千帧/秒，按帧数采样会让
      // 「跑满 3 个周期」变成随缘。
      const EARTH_PERIOD_SIM = 2.55; // 一个公转周期的模拟秒数（实测 2.61 略超一个周期）
      const series = await page.evaluate(async (period) => {
        const out = [];
        const t = window.__solarTime;
        const t0 = t.now();
        const wall0 = performance.now();
        while (out.length < 8000) {
          await new Promise((r) => requestAnimationFrame(r));
          const cs = window.__solarPick?.candidates?.() ?? [];
          const earth = cs.find((c) => c.id === "earth");
          out.push({
            d: earth ? earth.depth : null, // candidates 口径：地球在相机背后时是 null（会静默跳过）
            cam: window.__solarCamera?.()?.nearest ?? null, // 全方向口径：不受 candidates 剔除影响
            t: t.now() - t0,
          });
          if (t.now() - t0 >= period * 3.3 || performance.now() - wall0 > 70000) break;
        }
        return out;
      }, EARTH_PERIOD_SIM);
      const depths = series.map((s) => s.d).filter((d) => d !== null);
      const simSpan = series.at(-1)?.t ?? 0;
      const jumpPerFrame = [];
      const jumpPerSim = [];
      for (let i = 1; i < series.length; i++) {
        const a = series[i - 1];
        const b = series[i];
        if (a.d === null || b.d === null) continue;
        const dd = Math.abs(b.d - a.d);
        const dt = b.t - a.t;
        jumpPerFrame.push(dd);
        if (dt > 1e-6) jumpPerSim.push(dd / dt);
      }
      const sortedJ = [...jumpPerFrame].sort((x, y) => x - y);
      const medianJ = sortedJ[Math.floor(sortedJ.length / 2)] ?? 0;
      const minDepth = depths.length ? Math.min(...depths) : null;

      // 亏口径统一：天体半径优先用探针给的 radius（t10 起 __solarCamera().nearest 带这个字段），
      // 没有就只对地球回退到 EARTH_RADIUS_WORLD。**判「在不在球内」就是 dist < radius，不减半径。**
      const radiusOf = (near) =>
        near == null ? null : typeof near.radius === "number" ? near.radius : near.id === "earth" ? EARTH_RADIUS_WORLD : null;
      const insideAny = series.filter((s) => {
        const r = radiusOf(s.cam);
        return r !== null && s.cam.dist < r;
      });

      // 分窗口：floor(模拟时间 / 一个周期)
      const PERIODS = Math.max(1, Math.ceil(simSpan / EARTH_PERIOD_SIM));
      const windows = [];
      for (let w = 0; w < PERIODS; w++) {
        const slice = series.filter((s) => Math.floor(s.t / EARTH_PERIOD_SIM) === w && s.d !== null);
        if (!slice.length) continue;
        const ds = slice.map((s) => s.d);
        windows.push({
          window: w + 1,
          frames: slice.length,
          min: +Math.min(...ds).toFixed(3),
          max: +Math.max(...ds).toFixed(3),
          judged: w >= 1, // 第 1 个窗口只记录（切换残差），第 2 个起才判
        });
      }
      // 只压第 2 个周期起的 min（engineer 的 t4 口径：稳态 1.023–1.026，阈值 1.0 留 2.5% 余量）
      const steadyWindows = windows.filter((x) => x.judged);
      const steadyMin = steadyWindows.length ? Math.min(...steadyWindows.map((x) => x.min)) : null;

      const clearance = {
        pass: "camera-clearance",
        moonChip: hasMoonChip,
        frames: series.length,
        simSpan: +simSpan.toFixed(2), // 应 ≥ 7.65（3 个周期）
        windows,
        steadyMin, // 判据只看这个：第 2 个周期起的最小地心距离
        moonRadiusPx: before.moon?.r ?? null,
        moonDepth: before.moon?.d ?? null,
        earthDepthMin: minDepth === null ? null : +minDepth.toFixed(3), // 全帧 min（含第 1 窗口，仅记录）
        earthDepthMax: depths.length ? +Math.max(...depths).toFixed(3) : null,
        jumpMaxPerFrame: jumpPerFrame.length ? +Math.max(...jumpPerFrame).toFixed(4) : null,
        jumpP95PerFrame: +(sortedJ[Math.floor(sortedJ.length * 0.95)] ?? 0).toFixed(4),
        jumpMedianPerFrame: +medianJ.toFixed(4),
        jumpMaxPerSimUnit: jumpPerSim.length ? +Math.max(...jumpPerSim).toFixed(4) : null, // 与帧率无关
        insideAnyBody: insideAny.length,
        insideAnyBodyId: insideAny[0]?.cam?.id ?? null,
        insideAnyBodyMin: insideAny.length ? +Math.min(...insideAny.map((s) => s.cam.dist)).toFixed(3) : null,
        clampLine: +(EARTH_RADIUS_WORLD * 1.35).toFixed(3), // 产品软滑出的目标半径（SolarCanvas clampOutsideParent）
        note: "判据只压第 2 个周期起、min ≥ 1.0；第 1 个周期是切换残差，只记录。稳态口径同时看 candidates 与全方向 nearest。",
      };
      results.push(clearance);
      if (!hasMoonChip) console.error("（注意）camera-clearance: 选中地球后没有 chip-moon，测的是未聚焦状态");
      if (series.length < 10) console.error("（注意）camera-clearance: 没采到样本");
      else if (clearance.simSpan < EARTH_PERIOD_SIM * 2.9) {
        console.error(`（注意）camera-clearance: 只推进了 ${clearance.simSpan} 个模拟单位（不足 3 个周期），基线不完整`);
      }
      if (steadyWindows.length === 0) {
        failures.push("camera-clearance: 只采到 1 个周期，没有稳态窗口可判（采样不足，不是产品问题）");
      }
      for (const w of steadyWindows) {
        if (w.min < 1.0) {
          failures.push(
            `camera-clearance: 第 ${w.window} 个周期地心距离 min ${w.min} < 1.0（钳制线 ${clearance.clampLine}，留 2.5% 余量）`,
          );
        }
      }
      if (insideAny.length) {
        // 「相机进到天体内」是硬伤（画面上那颗天体会消失），稳态里出现就算失败
        failures.push(
          `camera-clearance: 稳态采样里相机进到天体内（${clearance.insideAnyBodyId} 距球心 ${clearance.insideAnyBodyMin} 帧数 ${insideAny.length}）`,
        );
      }

      // ——— 过渡段（点 #chip-moon 后 0–3s）：这条**现在会红，红得对** ——————————
      // 聚焦动画期间 clampOutsideParent 不跑（动画分支提前 return），插值路径可能穿过地球，
      // 动画结束后才被软滑出。实测地心 min 0.528 / 0.570 / 0.977（地球半径 0.76）。
      // 相位决定穿不穿（三次独立加载：红/红/绿），所以用 __solarTime.set() 钉三个相位各跑一次、
      // 取最差的那次判 —— 否则这条断言在 CI 里 2/3 概率红，比不红还糟。
      const transition = [];
      for (const k of [0, 1, 2]) {
        await page.goto(withDiag(base), { waitUntil: "load" });
        await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
        await page.evaluate((kk) => {
          const t = window.__solarTime;
          t.set(t.now() + (kk * 2.55) / 3);
        }, k);
        await page.locator("#chip-earth").click();
        await page.waitForTimeout(1200);
        if ((await page.locator("#chip-moon").count()) === 0) {
          transition.push({ phase: k, error: "没有 chip-moon" });
          continue;
        }
        // 采样必须在**点击那一刻**开始：在页面里先起 rAF 循环，再由同一个脚本点下去
        const sample = await page.evaluate(async () => {
          const frames = [];
          const wall0 = performance.now();
          const loop = (async () => {
            while (performance.now() - wall0 < 3000) {
              await new Promise((r) => requestAnimationFrame(r));
              const near = window.__solarCamera?.()?.nearest ?? null;
              if (near) frames.push({ id: near.id, dist: near.dist, radius: near.radius ?? null, wall: performance.now() - wall0 });
            }
          })();
          document.querySelector("#chip-moon")?.click();
          await loop;
          return frames;
        });
        // 墙钟毫秒用逐帧差求和（实测墙钟），不是「帧数 × 16.7」——后者在 30fps 的机器上会少算一半
        let belowMs = 0;
        let belowFrames = 0;
        let worst = null;
        let minRatio = Infinity; // 每个相位里「距离 ÷ 该天体半径」的最小值：硬断言判的就是它
        for (let i = 0; i < sample.length; i++) {
          const f = sample[i];
          const r = typeof f.radius === "number" ? f.radius : f.id === "earth" ? EARTH_RADIUS_WORLD : null;
          if (r !== null && r > 0) {
            const ratio = f.dist / r;
            if (ratio < minRatio) minRatio = ratio;
          }
          const inside = r !== null && f.dist < r;
          if (!inside) continue;
          belowFrames++;
          if (i > 0) belowMs += f.wall - sample[i - 1].wall;
          if (!worst || f.dist < worst.dist) worst = { id: f.id, dist: f.dist, radius: r };
        }
        transition.push({
          phase: +((k * 2.55) / 3).toFixed(2), // 钉住的相位（模拟秒偏移）
          frames: sample.length,
          belowFrames,
          minRatio: Number.isFinite(minRatio) ? +minRatio.toFixed(3) : null,
          belowMs: +belowMs.toFixed(0),
          worstId: worst?.id ?? null,
          worstDist: worst ? +worst.dist.toFixed(3) : null,
          worstRadius: worst ? +worst.radius.toFixed(3) : null,
        });
      }
      clearance.transition = transition;
      /*
       * t15 收尾：**到期条件已满足，这条从「只记录」转成硬断言。**
       *
       * 到期条件（原写在 README「已知缺陷」里）：过渡段插值改为每帧钳制在父天体半径之外后，
       * 本条转为硬断言，最小值 ≥ 1.0 × 地球半径。t19 已落地：地心最近距离 0.8067 → **1.12**，
       * 0 帧 <1。所以这里不再有「记录但不判红」的分支——**它红了就是钳制退了**。
       */
      const ratios = transition.filter((t) => t.minRatio != null);
      clearance.minRatio = ratios.length ? +Math.min(...ratios.map((t) => t.minRatio)).toFixed(3) : null;
      clearance.minRatioThreshold = 1.0;
      if (!ratios.length) {
        failures.push("camera-clearance(过渡): 三个相位都读不到「距离 ÷ 半径」—— 判据失去对象，必须红");
      } else {
        for (const t of transition) {
          if (t.minRatio != null && t.minRatio < 1.0) {
            failures.push(
              `camera-clearance(过渡): 相位 +${t.phase} 相机进入 ${t.worstId ?? "某天体"} 球体 —— ` +
                `最小距离 ${t.minRatio}× 半径 < 1.0（${t.belowFrames} 帧 / ${t.belowMs}ms）。` +
                `过渡段钳制退了？看 focusPose 之后的 clampAnimationPath。`,
            );
          }
        }
      }
      clearance.knownBug = null; // 已转硬断言；字段保留为 null 以免归档读取方炸
    } catch (err) {
      failures.push(`camera-clearance: ${err.message}`);
    }
    await ctx.close();
  }
  } // ← numeric 块结束
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify({ results, failures }, null, 2));
console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : "\n✓ 全部通过");
console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（${results.length} 条 pass 记录）`);

// ——— 归档（失败绝不影响退出码）———————————————————————————————
// 测量工具不该吃被测结果的账：归档坏了只打警告，verify 的红绿仍由 failures 决定。
// 关掉的办法：`--no-archive` 或 XG_NO_ARCHIVE=1。
{
  const noArchive = process.argv.includes("--no-archive") || process.env.XG_NO_ARCHIVE === "1";
  if (noArchive) {
    console.log("（--no-archive：本次不写归档）");
  } else {
    try {
      const buildHtml = await readFile(path.join(SITE, "index.html"), "utf8").catch(() => "");
      const buildMatch = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(buildHtml);
      const archived = archiveVerifyRun({
        results,
        failures,
        meta: {
          at: new Date().toISOString(),
          build: buildMatch ? `assets/${buildMatch[1]}` : "unknown",
          raster: "software(swiftshader)", // verify 固定用 swiftshader，与 t20 的 hardware 轮不是一条路径
          edge: EDGE,
          node: process.version,
          viewports: [...new Set(results.map((r) => r?.viewport).filter(Boolean))],
          elapsedSeconds: +((Date.now() - startedAt) / 1000).toFixed(1),
          only: ONLY.length ? ONLY : "all",
        },
      });
      const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, "/");
      console.log(`归档：${rel(archived.file)}（索引 ${rel(archived.index)}）`);
      if (archived.pruned.length) console.log(`清掉 ${archived.pruned.length} 份超期归档（保留最近 40 次 / 30 天）`);
    } catch (err) {
      console.warn(`⚠ 归档失败（不影响退出码）：${err.message}`);
    }
  }
}
process.exit(failures.length ? 1 : 0);
