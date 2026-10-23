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
const SITE = path.join(root, "release", "site");
const SINGLE = path.join(root, "release", "星轨.html");
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
// 基线页若被 vsync 钉住（闲机器上 8 pass 也可能塞进一帧），分母取 max(基线, vsync)，
// 此时断言自动退化成旧断言 —— 没信息的时候不假装有信息。
const CAL_PASSES = 8;
const CAL_ITER = 24;
const EMA_RATIO_MAX = 1.6;
const P95_RATIO_MAX = 2.2;
const HITCH_MIN_MS = 50;
const HITCH_FACTOR = 2.5;

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

// 采 n 帧的帧间隔，返回中位数/p95/EMA/hitch。
// hitch 用「相对本次运行自己的中位数」定义：机器整体慢一档时，一条 55ms 的帧
// 在 40ms 中位数的机器上不算事故，在 16.7ms 的机器上才算 —— 这是它能在忙机器上复现的前提。
async function sampleIntervals(page, frames = 150) {
  return page.evaluate(
    async ({ frames, hitchMinMs, hitchFactor }) => {
      const deltas = [];
      await new Promise((resolve) => {
        let prev = performance.now();
        let n = 0;
        const tick = () => {
          const now = performance.now();
          deltas.push(now - prev);
          prev = now;
          if (++n < frames) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = [...deltas].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      let ema = deltas[0];
      for (const d of deltas) ema = ema * 0.9 + d * 0.1;
      const limit = Math.max(hitchMinMs, hitchFactor * median);
      return {
        frames: deltas.length,
        median: +median.toFixed(1),
        p95: +p95.toFixed(1),
        ema: +ema.toFixed(1),
        ratio: +(p95 / median).toFixed(2),
        hitch: deltas.filter((d) => d > limit).length,
        hitch50: deltas.filter((d) => d > hitchMinMs).length, // 旧判据的口径，只留档不判红
        hitchLimitMs: +limit.toFixed(1),
      };
    },
    { frames, hitchMinMs: HITCH_MIN_MS, hitchFactor: HITCH_FACTOR },
  );
}

// 量一次机器基线：vsync 节拍（空白页）+ 光栅吞吐（定量着色器页）。
// 必须在遥测页开始渲染**之前/之后**单独跑，不能和它同时开着 ——
// 两个全屏 WebGL 页会互相抢光栅，分母会被自己测高。
async function measureBaseline(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const blank = await ctx.newPage();
    await blank.goto("about:blank");
    await blank.waitForTimeout(300);
    const vsync = await sampleIntervals(blank, 120);

    const cal = await ctx.newPage();
    const errors = [];
    cal.on("pageerror", (err) => errors.push(err.message));
    await cal.setContent(CAL_HTML, { waitUntil: "load" });
    await cal.waitForFunction(() => window.__calReady === true, null, { timeout: 20000 });
    await cal.waitForTimeout(300);
    await cal.evaluate(() => window.__setPasses(1));
    const onePass = await sampleIntervals(cal, 40); // 只记录：闲机器上它会被 vsync 钉住
    await cal.evaluate((n) => window.__setPasses(n), CAL_PASSES);
    const raster = await sampleIntervals(cal, 60);
    return { vsync, onePass, raster, errors };
  } finally {
    await ctx.close();
  }
}

const denomOf = (baseline) => Math.max(baseline.raster.ema, baseline.vsync.ema);

// 判定：绝对值只记录，不判红；判的是「场景 ÷ 基线」的比值。
function judgeFrameTime(ft, baselines) {
  const denominator = Math.max(...baselines.map(denomOf));
  const hitchBudget =
    Math.max(...baselines.map((b) => Math.max(b.raster.hitch, b.vsync.hitch))) + 1;
  ft.normalized = {
    denominatorMs: +denominator.toFixed(1),
    ema: +(ft.steady.ema / denominator).toFixed(2),
    emaMax: EMA_RATIO_MAX,
    p95: +(ft.steady.p95 / denominator).toFixed(2),
    p95Max: P95_RATIO_MAX,
    hitch: ft.steady.hitch,
    hitchBudget,
    // 留档的旧判据：只记录、不判红。留着它是为了在同一份采样上直接对比
    // 「老规矩会不会红」，免得拿两次不同机器状态的运行互相比。
    legacy: {
      emaMs: ft.steady.ema,
      emaWasMax: 26,
      p95OverMedian: ft.steady.ratio,
      p95OverMedianWasMax: 1.5,
      hitch50: ft.steady.hitch50,
      hitch50WasMax: 0,
      wouldFail:
        ft.steady.ema > 26 || ft.steady.ratio > 1.5 || ft.steady.hitch50 > 0,
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
  if (n.hitch > hitchBudget) {
    failures.push(`frame-time: 稳态 hitch ${n.hitch} 次 > 预算 ${hitchBudget} 次`);
  }
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
    await page.goto(spec.url, { waitUntil: "load", timeout: 30000 });
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

    await page.screenshot({ path: path.join(SHOTS, `${spec.name}.png`) });
  } catch (err) {
    errors.push(`fatal: ${err.message}`);
  }
  await context.close();

  if (!result.solarReady) failures.push(`${spec.name}: 画布没起来（__solarReady 未置位）`);
  if (errors.length) failures.push(`${spec.name}: 控制台/页面报错 ${errors.length} 条`);
  if (result.canvas !== 1) failures.push(`${spec.name}: canvas 数量 ${result.canvas} ≠ 1`);
  if (result.overflowX > 1) failures.push(`${spec.name}: 横向溢出 ${result.overflowX}px`);
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

    // A1 帧时间：分两段采。启动段单列不判（首屏要逐像素生成 7 张行星贴图，必然有阻塞），
    //    稳态段才断言 —— 混在一起测会把一次性成本当成持续缺陷。
    //    判定见 judgeFrameTime：绝对 ms 只记录，判的是「场景 ÷ 本次机器基线」的比值。
    const startup = await sampleIntervals(numPage);
    await numPage.waitForTimeout(2500); // 让贴图与几何生成完
    const steady = await sampleIntervals(numPage);
    frameTime = { pass: "frame-time", passesPerFrame: CAL_PASSES, startup, steady };
    results.push(frameTime); // 引用入列：后面补上 baseline / normalized 会一起落进 JSON

    // A2 命中矩阵：投影 15 个天体，数屏幕距离 < 44 px 的重叠对
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
    results.push({ pass: "hit-matrix", bodies: hits.count, overlapping: hits.pairs.length, pairs: hits.pairs.slice(0, 6) });
    if (hits.count !== 15) failures.push(`hit-matrix: 探针只返回 ${hits.count} 个天体，应为 15`);

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
  if (frameTime && frameTime.steady && baselines.length) {
    frameTime.baseline = {
      passesPerFrame: CAL_PASSES,
      before: baselineA,
      after: baselineB,
      denominatorMs: +Math.max(...baselines.map(denomOf)).toFixed(1),
    };
    judgeFrameTime(frameTime, baselines);
  } else if (frameTime && frameTime.steady) {
    failures.push("frame-time: 两次机器基线都测失败，无法归一化判定");
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
    await protoPage.screenshot({ path: path.join(SHOTS, "proto-real.png") });
    results.push({ pass: "proto-real", ...proto, errors: protoErrors });
    if (proto.bodies !== 3) failures.push(`proto-real: 原型应有 3 个天体，实际 ${proto.bodies}`);
    if (proto.centerOffsetPx > 1) failures.push(`proto-real: 地球没钉在屏幕中心，偏移 ${proto.centerOffsetPx}px`);
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
  // 视口 1920×1080、相机距离 1.2e7 m：圆盘左右缘都还在画面内，f/视距 也最大。
  const jitterCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const jitterPage = await jitterCtx.newPage();
  const jitterErrors = [];
  jitterPage.on("pageerror", (e) => jitterErrors.push(e.message));
  jitterPage.on("console", (m) => m.type() === "error" && jitterErrors.push(m.text()));
  const sampleJitter = async (query) => {
    await jitterPage.goto(`${base}${query}`, { waitUntil: "load" });
    await jitterPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
    await jitterPage.waitForTimeout(1500);
    return jitterPage.evaluate(async () => {
      const out = [];
      let frames = 0;
      let bad = 0;
      const want = 60;
      while (out.length < want && frames < want * 4) {
        await new Promise((r) => requestAnimationFrame(r));
        frames++;
        const p = window.__solarPixels?.();
        if (p && Number.isFinite(p.x)) out.push(p.x);
        else bad++;
      }
      if (!out.length) return { samples: 0, bad };
      const pp = Math.max(...out) - Math.min(...out);
      return { samples: out.length, bad, pp: +pp.toFixed(3), x0: +out[0].toFixed(2) };
    });
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
      if (modern.pp >= 0.35) failures.push(`proto-jitter: 现代路径峰峰 ${modern.pp}px 未低于 0.35px`);
      if (legacy.pp <= modern.pp * 3 || legacy.pp <= 0.4) {
        failures.push(
          `proto-jitter: legacy 峰峰 ${legacy.pp}px 未显著高于现代 ${modern.pp}px（需 >3× 且 >0.4px）—— 对照失效，断言就没意义`,
        );
      }
    }
    if (jitterErrors.length) failures.push(`proto-jitter: 报错 ${jitterErrors.length} 条`);
  } catch (err) {
    failures.push(`proto-jitter: ${err.message}`);
  }
  await jitterCtx.close();
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify({ results, failures }, null, 2));
console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : "\n✓ 全部通过");
process.exit(failures.length ? 1 : 0);
