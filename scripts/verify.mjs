// 真实浏览器验收：桌面 + 手机两个视口 + 交互 + 单文件版本。
// 用系统自带 Edge（playwright-core 不下载 Chromium），软件光栅化跑 WebGL。
// 判定标准：画布真的渲染（window.__solarReady）、控制台零报错、无横向溢出。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(root, "release", "site");
const SINGLE = path.join(root, "release", "星轨.html");
const SHOTS = path.join(root, "screenshots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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

function startServer() {
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
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const failures = [];

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
const server = await startServer();
const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});

const base = `http://127.0.0.1:${PORT}/`;
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
  const numCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const numPage = await numCtx.newPage();
  const numErrors = [];
  numPage.on("pageerror", (e) => numErrors.push(e.message));
  numPage.on("console", (m) => m.type() === "error" && numErrors.push(m.text()));
  try {
    await numPage.goto(base, { waitUntil: "load" });
    await numPage.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });

    // A1 帧时间：分两段采。rAF 被 vsync 钉在 60 Hz，median 没有判别力，
    //    有判别力的是 EMA 上限、p95/median 比、以及 hitch 次数。
    //    启动段单列不判（首屏要逐像素生成 7 张行星贴图，必然有阻塞），
    //    稳态段才断言 —— 混在一起测会把一次性成本当成持续缺陷。
    const sampleFrames = async () =>
      numPage.evaluate(async () => {
        const deltas = [];
        await new Promise((resolve) => {
          let prev = performance.now();
          let n = 0;
          const tick = () => {
            const now = performance.now();
            deltas.push(now - prev);
            prev = now;
            if (++n < 150) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        const sorted = [...deltas].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        let ema = deltas[0];
        for (const d of deltas) ema = ema * 0.9 + d * 0.1;
        return {
          median: +median.toFixed(1),
          p95: +p95.toFixed(1),
          ema: +ema.toFixed(1),
          ratio: +(p95 / median).toFixed(2),
          hitch: deltas.filter((d) => d > 50).length,
        };
      });

    const startup = await sampleFrames();
    await numPage.waitForTimeout(2500); // 让贴图与几何生成完
    const steady = await sampleFrames();
    results.push({ pass: "frame-time", startup, steady });
    if (steady.ema > 26) failures.push(`frame-time: 稳态 EMA ${steady.ema}ms > 26ms`);
    if (steady.ratio > 1.5) failures.push(`frame-time: 稳态 p95/median ${steady.ratio} > 1.5`);
    if (steady.hitch > 0) failures.push(`frame-time: 稳态 hitch ${steady.hitch} 次`);

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
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify({ results, failures }, null, 2));
console.log(failures.length ? `\n✗ ${failures.length} 项未通过` : "\n✓ 全部通过");
process.exit(failures.length ? 1 : 0);
