// 真实浏览器验收：桌面 + 手机两个视口 + 交互 + 单文件版本。
// 用系统自带 Edge（playwright-core 不下载 Chromium），软件光栅化跑 WebGL。
// 判定标准：画布真的渲染（window.__solarReady）、控制台零报错、无横向溢出。
// 数值断言（帧时间 / 命中矩阵 / 跟随抖动）一律「相对本次运行的机器基线」判，不吃机器负载。
// 怎么跑、每个 pass 验什么、红了先看哪一行：scripts/README.md。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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
    // ?diag=1：只为打开 preserveDrawingBuffer（画布像素体检要用），不改产品行为
    await page.goto(withDiag(spec.url), { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    result.solarReady = true;
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
const results = [];
try {
  results.push(
    await run(browser, {
      name: "desktop",
      url: base,
      viewport: { width: 1280, height: 720 },
      interact: true,
      expectSelected: "地球",
    }),
  );
  results.push(
    await run(browser, {
      name: "mobile",
      url: base,
      viewport: { width: 390, height: 844 },
      dpr: 3,
      isMobile: true,
      hasTouch: true,
    }),
  );
  results.push(
    await run(browser, {
      name: "mobile-selected",
      url: base,
      viewport: { width: 390, height: 844 },
      dpr: 3,
      isMobile: true,
      hasTouch: true,
      interact: true,
      expectSelected: "地球",
    }),
  );
  results.push(
    await run(browser, {
      name: "single-file",
      url: pathToFileURL(SINGLE).href,
      viewport: { width: 1280, height: 720 },
    }),
  );
  // ——— 数值断言（批判位指出的验收夹具缺失，这里补上）———
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
    await numPage.waitForTimeout(1500);
    const jitter = await numPage.evaluate(async () => {
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
    results.push({ pass: "follow-jitter", ...jitter });
    // 沙盘里本来就该是亚百分之一像素；1:1 实境接入后这条才有咬合力（那时会到 2.5 px）
    if (jitter.px >= 0.5) failures.push(`follow-jitter: 目标屏幕抖动 ${jitter.px}px ≥ 0.5px`);
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
  //    与机器性能无关（不读帧时间、不读像素）。但**依赖输入节奏**：产品的加速窗口是
  //    ZOOM_ACCEL_WINDOW_MS=400ms，夹具用 20ms 连发，这个节奏由夹具控制而不是机器状态。
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
  const SUN_RADIUS_WORLD = 3.8; // src/solar/data.ts 的 sun.radius（TEAM.md:16：天体数值改动须 captain 批）
  const ZOOM_TARGET_RATIO = 3; // 「太阳占画面约一半」的设计目标：视距 = 3R
  const ZOOM_STEP_BUDGET = 15; // 设计预算：≤15 次 wheel 必须到位（改前约 80 格 / 改后实测 11 格）
  const NO_CLIP_RATIO = 1.2; // 相机到太阳中心 ≥ 1.2R 才算没穿模
  const ZOOM_MAX_STEPS = 20; // 预算之外再给几步，够判定「超预算」即可
  const ZOOM_GAP_MS = 20; // 夹具的连发节奏（< 产品加速窗口 400ms，才会触发加速）
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
  const SUN_JUP_ALIGN_PX = 12; // 太阳中心落进木星盘面中心的判据（盘半径 r≈171px，很宽松）
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
      // 闭环把太阳拖到木星盘面中心（两轴分别自适应符号与步长）。
      // 拖动量由**实测屏幕坐标**算出来，所以换视口/换 dpr 仍然成立。
      const sign = { x: 1, y: 1 };
      const prevAbs = { x: Infinity, y: Infinity };
      let aligned = false;
      let finalState = null;
      for (let iter = 0; iter < 26; iter++) {
        const st = await candidatesOf(page, ["jupiter", "sun"]);
        finalState = st;
        if (!st.jupiter) break;
        if (!st.sun) {
          // 太阳在相机背后（拾取器剔除）：先绕一大步把它找回来
          await page.mouse.move(640, 400);
          await page.mouse.down();
          await page.mouse.move(640 + 200 * sign.x, 400, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(140);
          continue;
        }
        const dx = st.sun.x - st.jupiter.x;
        const dy = st.sun.y - st.jupiter.y;
        if (Math.hypot(dx, dy) < SUN_JUP_ALIGN_PX && st.sun.d > st.jupiter.d) {
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
        const sx = Math.abs(dx) > 6 ? Math.max(-260, Math.min(260, -dx * 0.55 * sign.x)) : 0;
        const sy = Math.abs(dy) > 6 ? Math.max(-260, Math.min(260, -dy * 0.55 * sign.y)) : 0;
        await page.mouse.move(640, 400);
        await page.mouse.down();
        await page.mouse.move(640 + sx, 400 + sy, { steps: 12 });
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
        // 没对齐就不判：这条判据只在「太阳正被木星挡住」时有意义，
        // 对齐失败时判红等于把夹具自己的收敛问题算成产品回归（记下来，别静默通过）
        console.error(`（注意）sun-occlusion: 未对齐（Δ=${deltaPx}px, sunBehind=${sunBehind}），本轮不判红，中心亮度记录 ${lum}`);
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
      // 按**模拟时间**跑满一个公转周期，不按帧数：
      // 无 vsync 时 rAF 能飙到上千帧/秒（实测 260 帧只推进 0.24 个模拟单位，而同一段代码
      // 在 60fps 下 260 帧走 4.33 个单位）。按帧数采样会让"跑满一个周期"变成随缘。
      const series = await page.evaluate(async () => {
        const out = [];
        const t = window.__solarTime;
        const t0 = t.now();
        const wall0 = performance.now();
        while (out.length < 3000) {
          await new Promise((r) => requestAnimationFrame(r));
          const cs = window.__solarPick?.candidates?.() ?? [];
          const earth = cs.find((c) => c.id === "earth");
          out.push({ d: earth ? earth.depth : null, t: t.now() - t0 });
          if (t.now() - t0 >= 2.6 || performance.now() - wall0 > 25000) break; // ≥ 一个周期 / 或超时
        }
        return out;
      });
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
      const clearance = {
        pass: "camera-clearance",
        moonChip: hasMoonChip,
        frames: series.length,
        simSpan: +simSpan.toFixed(2), // 应 ≥2.55（一个公转周期）
        moonRadiusPx: before.moon?.r ?? null,
        moonDepth: before.moon?.d ?? null,
        earthDepthMin: minDepth === null ? null : +minDepth.toFixed(3),
        earthDepthMax: depths.length ? +Math.max(...depths).toFixed(3) : null,
        jumpMaxPerFrame: jumpPerFrame.length ? +Math.max(...jumpPerFrame).toFixed(4) : null,
        jumpP95PerFrame: +(sortedJ[Math.floor(sortedJ.length * 0.95)] ?? 0).toFixed(4),
        jumpMedianPerFrame: +medianJ.toFixed(4),
        jumpMaxPerSimUnit: jumpPerSim.length ? +Math.max(...jumpPerSim).toFixed(4) : null, // 与帧率无关
        insideEarth: minDepth === null ? null : minDepth < EARTH_RADIUS_WORLD,
        clampLine: +(EARTH_RADIUS_WORLD * 1.35).toFixed(3), // 产品当前的钳制半径（SolarCanvas clampOutsideParent）
        note: "只测量不判红：t47 落地后再定阈值；jumpMaxPerSimUnit 是换算到同一模拟时间尺度的跳变",
      };
      results.push(clearance);
      if (!hasMoonChip) console.error("（注意）camera-clearance: 选中地球后没有 chip-moon，测的是未聚焦状态");
      if (series.length < 10) console.error("（注意）camera-clearance: 没采到样本");
      else if (clearance.simSpan < 2.5) {
        console.error(`（注意）camera-clearance: 只推进了 ${clearance.simSpan} 个模拟单位（不足一个周期），基线不完整`);
      } else if (clearance.insideEarth) {
        // 虽然"只测量"，但「相机进到地球内部」是硬伤（画面上整颗地球会消失），记成失败更诚实
        failures.push(
          `camera-clearance: 跟随月球时相机进到地球内部（地心距离 ${clearance.earthDepthMin} < 半径 ${EARTH_RADIUS_WORLD}）`,
        );
      }
    } catch (err) {
      failures.push(`camera-clearance: ${err.message}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify({ results, failures }, null, 2));
console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : "\n✓ 全部通过");
process.exit(failures.length ? 1 : 0);
