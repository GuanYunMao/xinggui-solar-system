// 观察位·可复现试玩夹具。当前目标版本：v1.3.0（play-<version> 目录随 package.json 走）。
//
// 用法：node scripts/play.mjs
//       XG_EDGE=... / XG_RELEASE=...  同 verify.mjs
//
// 三条硬规矩（别破）：
//  1. **fail-fast**：某步走不通就停，stderr 写「哪一步 / 期望 / 实际」，退出码 1。
//  2. **不许 sleep 冒充等待**：只等条件（__solarReady / ?body= / 相机收敛 / 门提示的 data-lit /
//     黑幕 opacity / N 帧 rAF）。唯一的"时间窗"是测惯性（必须按毫秒量），那里用 explicit
//     waitForTimeout 是**测量本身**，不是等待就绪，注释里标了 why。
//  3. **不改 src/**：玩家视角，看见 bug 记录不修。
//
// ── v1.3.0 相对上一版新增/变化的可测面 ──────────────────────────────────────
//  · 门三条从「摸过控件」改成「可判定的观察」（t19，判据在 observe.ts）：
//      time   = 月球进地球本影那一刻它正被玩家选中 → eclipseEntry + selectedId==="moon" + source!=="url"
//      target = 盯着水星跑满一整圈（累积 8.2 模拟秒 ≈ 8× 下 20.8 实秒）→ mercuryWatchSeconds ≥ period
//      layer  = 名称与轨道都不在时，还**在画布上点得中**一颗行星 → layerGateWitnessed 要求 source==="canvas"
//    面板每行带 data-gate-hint / data-lit，右侧写「✓ 已完成 / 未完成」（ModeBadge.tsx:271-284）；
//    解锁那一刻弹 .gate-celebrate（2600ms，ModeBadge.tsx:106-114/377）。
//  · 实境 HUD 从「只有徽标」变成 RealHud：回沙盘 / 距离读数 / 地球取景 / 月球取景（Hud.tsx:381-460）。
//  · 真轨道（开普勒 + J2000）：实境天体含冥王星、哈雷（systems.ts:240-280），
//    探针 __solarKepler / __solarOrbitPlanes / __solarOrbitFrames。
//
// ── 本版新增的两个测量原语 ──────────────────────────────────────────────────
//  · pngMeanLum(buf)：解 PNG（zlib inflate + unfilter），5×5 网格各取 8×8 求亮度。
//    为什么要自己解：上一版判「黑屏」只能靠眼睛看截图；这一版要回答"从 3 个控件到 7 个
//    控件到底有没有让画面变亮"，需要一个可复算的数字。不用 ?diag=1 + readPixels，
//    是因为那会改掉玩家真正走的那条 URL。
//  · wheelProbe / dragProbe：滚轮快慢与惯性、拖拽跨极点，都靠 __solarCamera 的读数算，
//    不靠截图。

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = process.env.XG_RELEASE ? path.resolve(process.env.XG_RELEASE) : path.join(root, "release");
const SITE = path.join(RELEASE, "site");
const EDGE = process.env.XG_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.XG_PLAY_PORT ?? 4181);

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
/*
 * 版本从「被玩的那份产物」来，不是从工作区 package.json 来。
 * 原因：工作区可能已经在开发下一版（实测 package.json 已是 1.3.1-snap.1，而我们要玩的是 tag v1.3.0
 * 的构建）。用 XG_RELEASE 指过去时，版本号必须跟着产物走，否则 run.json 会张冠李戴。
 * 取值优先级：XG_VERSION > 产物 bundle 里抓到的版本串 > 工作区 package.json。
 */
const BUNDLE_VERSION = await (async () => {
  try {
    const dir = path.join(RELEASE, "site", "assets");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
    if (!files.length) return null;
    // 只读前 2MB 够了：版本号在抬头常量附近，通常在包尾，所以读整份但限制单文件大小
    const js = await readFile(path.join(dir, files[0]), "utf8");
    const m = js.match(/"(1\.\d+\.\d+(?:-[a-z0-9.]+)?)"/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
})();
const VERSION = String(process.env.XG_VERSION || BUNDLE_VERSION || pkg.version);
/** 发版前构建（-snap/-rc/-beta）：结论只能当预演。定义必须早于任何使用点（踩过 TDZ）。 */
const PRERELEASE = /-(snap|rc|beta|alpha)\.?/i.test(VERSION);
const OUT = path.join(root, "screenshots", `play-${VERSION}`);

/** 产物指纹：报告里的"这一份到底是什么"必须能核对，不靠目录名。 */
const ARTIFACT = await (async () => {
  try {
    const dir = path.join(SITE, "assets");
    const files = await readdir(dir);
    const main = files.find((f) => f.endsWith(".js")) ?? null;
    if (!main) return { site: SITE, main: null };
    const buf = await readFile(path.join(dir, main));
    const zip = zlib.gzipSync(buf);
    return {
      site: SITE,
      main,
      bytes: buf.length,
      gzipBytes: zip.length,
      sha256: (await import("node:crypto")).createHash("sha256").update(buf).digest("hex"),
      bundleVersion: BUNDLE_VERSION,
      worktreePackageVersion: String(pkg.version),
      tag: process.env.XG_TAG ?? null,
    };
  } catch (err) {
    return { site: SITE, error: String(err?.message ?? err) };
  }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/* ────────────────────────────── 静态服务 ────────────────────────────── */

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

async function startOnFreePort(preferred) {
  for (let i = 0; i < 20; i++) {
    try {
      return { server: await startServer(preferred + i), port: preferred + i };
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`端口 ${preferred}–${preferred + 19} 全被占用`);
}

/* ────────────────────────────── PNG 亮度 ────────────────────────────── */

/** 解 8bit PNG（colorType 0/2/6）并返回 5×5 网格亮度统计。只看亮度，不重建图像。 */
function pngMeanLum(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`pngMeanLum: 只支持 8bit（实际 ${bitDepth}）`);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error(`pngMeanLum: 不支持的 colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let rp = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`pngMeanLum: 未知 filter ${filter}`);
      cur[x] = v;
    }
    prev = cur;
  }
  const lums = [];
  for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
    for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
      const x0 = Math.min(w - 8, Math.max(0, Math.round(fx * (w - 8))));
      const y0 = Math.min(h - 8, Math.max(0, Math.round(fy * (h - 8))));
      let sum = 0;
      for (let y = y0; y < y0 + 8; y++)
        for (let x = x0; x < x0 + 8; x++) {
          const i = (y * w + x) * ch;
          sum += 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
        }
      lums.push(sum / 64);
    }
  }
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  return {
    size: [w, h],
    meanLum: +mean.toFixed(2),
    maxLum: +Math.max(...lums).toFixed(2),
    nonBlackRatio: +(lums.filter((l) => l >= 2).length / lums.length).toFixed(2),
    grid: lums.map((l) => +l.toFixed(1)),
  };
}

/* ────────────────────────────── 条件等待 ────────────────────────────── */

class StepError extends Error {
  constructor(step, what, expected, actual) {
    super(`[${step}] ${what}`);
    this.step = step;
    this.what = what;
    this.expected = expected;
    this.actual = actual;
  }
}

async function until(page, step, what, predicate, arg, { timeout = 25000, expected, actual } = {}) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(predicate, arg, { timeout, polling: 100 });
  } catch {
    let got = "（没提供读数）";
    if (actual) {
      try {
        got = JSON.stringify(await page.evaluate(actual, arg));
      } catch (err) {
        got = `<读不到：${err.message}>`;
      }
    }
    throw new StepError(step, `${what} —— 等了 ${Date.now() - t0}ms 仍未满足`, expected, got);
  }
  return Date.now() - t0;
}

async function frames(page, n) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let seen = 0;
        const tick = () => (++seen >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

async function cameraSettled(page, step, { stable = 3, tol = 2e-3, timeout = 20000 } = {}) {
  const res = await page.evaluate(
    ({ stable, tol, timeout }) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        let prev = null;
        let hits = 0;
        let last = null;
        const tick = () => {
          const cam = window.__solarCamera ? window.__solarCamera() : null;
          last = cam;
          if (!cam || !cam.target) {
            prev = null;
            hits = 0;
          } else {
            const off = [cam.pos[0] - cam.target[0], cam.pos[1] - cam.target[1], cam.pos[2] - cam.target[2]];
            const len = Math.hypot(off[0], off[1], off[2]);
            if (prev && len > 0) {
              const d = Math.hypot(off[0] - prev[0], off[1] - prev[1], off[2] - prev[2]) / len;
              hits = d < tol ? hits + 1 : 0;
            }
            prev = off;
          }
          if (hits >= stable) return resolve({ ok: true, distTarget: last?.distTarget ?? null, ms: Math.round(performance.now() - t0) });
          if (performance.now() - t0 > timeout) return resolve({ ok: false, cam: last, ms: Math.round(performance.now() - t0) });
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { stable, tol, timeout },
  );
  if (!res.ok)
    throw new StepError(step, `相机没有收敛（等了 ${res.ms}ms）`, `偏移量变化率 < ${tol}`, JSON.stringify(res.cam));
  return res;
}

async function waitFocusStarted(page, id, { timeout = 6000 } = {}) {
  return page.evaluate(
    ({ id, timeout }) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        let prev = null;
        const read = () => {
          const p = window.__solarProbe ? window.__solarProbe().find((x) => x.id === id) : null;
          const cam = window.__solarCamera ? window.__solarCamera() : null;
          return { x: p && Number.isFinite(p.x) ? p.x : null, r: p ? p.radiusPx : 0, target: cam ? cam.target : null, dist: cam ? cam.distTarget : null };
        };
        const tick = () => {
          const now = read();
          if (prev && now.x !== null && prev.x !== null) {
            const moved = Math.abs(now.x - prev.x) > 4 || Math.abs(now.r - prev.r) / Math.max(1, prev.r) > 0.05;
            const tMoved =
              prev.target && now.target &&
              Math.abs(now.target[0] - prev.target[0]) + Math.abs(now.target[1] - prev.target[1]) + Math.abs(now.target[2] - prev.target[2]) > 1e-3;
            const dMoved = prev.dist !== null && now.dist !== null && Math.abs(now.dist - prev.dist) / Math.max(1e-6, prev.dist) > 0.02;
            if (moved || tMoved || dMoved) return resolve({ started: true, ms: Math.round(performance.now() - t0) });
          }
          prev = now;
          if (performance.now() - t0 > timeout) return resolve({ started: false, ms: Math.round(performance.now() - t0) });
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { id, timeout },
  );
}

async function focusCentered(page, step, id) {
  const res = await page.evaluate((target) => {
    const p = window.__solarProbe ? window.__solarProbe().find((x) => x.id === target) : null;
    const w = window.innerWidth;
    if (!p || !Number.isFinite(p.x)) return { ok: false, why: "no-projection", probe: p ?? null };
    const dx = Math.abs(p.x - w / 2);
    return { ok: dx <= w * 0.02, dx: Math.round(dx), limit: Math.round(w * 0.02), x: Math.round(p.x), radiusPx: Math.round(p.radiusPx) };
  }, id);
  if (!res.ok)
    throw new StepError(step, `聚焦 ${id} 之后它不在画面中心（${res.why ?? `偏 ${res.dx}px`}）`, "投影落在画布水平中心 ±2% 画宽", JSON.stringify(res));
  return res;
}

async function veilOpacity(page) {
  return page.evaluate(() => {
    const veil = [...document.querySelectorAll("main > div")].find((el) => {
      const cls = typeof el.className === "string" ? el.className : "";
      return cls.includes("bg-black") && cls.includes("z-[2]");
    });
    return veil ? Number(getComputedStyle(veil).opacity) : null;
  });
}

async function waitVeilLifted(page, step) {
  const res = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        let maxOpacity = -1;
        const tick = () => {
          const veil = [...document.querySelectorAll("main > div")].find((el) => {
            const cls = typeof el.className === "string" ? el.className : "";
            return cls.includes("bg-black") && cls.includes("z-[2]");
          });
          if (!veil) return resolve({ ok: false, reason: "no-veil", ms: Math.round(performance.now() - t0) });
          const o = Number(getComputedStyle(veil).opacity);
          if (Number.isFinite(o)) maxOpacity = Math.max(maxOpacity, o);
          if (o <= 0.01) return resolve({ ok: true, maxOpacity, ms: Math.round(performance.now() - t0) });
          if (performance.now() - t0 > 20000) return resolve({ ok: false, reason: "timeout", opacity: o, maxOpacity, ms: Math.round(performance.now() - t0) });
          requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  if (!res.ok) throw new StepError(step, `黑幕没有淡出（${res.reason}）`, "先进不透明再淡到 0", JSON.stringify(res));
  return res;
}

/* ────────────────────────────── 玩家动作 ────────────────────────────── */

const sel = {
  badgeLocked: 'button[aria-label*="未对齐"]',
  badgePanel: 'button[aria-haspopup="dialog"][aria-label="校准"]',
  panel: '[role="dialog"][aria-label="校准"]',
  dots: '[role="progressbar"][aria-label="校准进度"]',
  celebrate: ".gate-celebrate",
  overview: 'button[aria-label="返回总览"]',
  pause: 'button[aria-label="暂停模拟"]',
  resume: 'button[aria-label="继续模拟"]',
  timeTrigger: 'button[aria-label="设定时刻"]',
  timePanel: '[role="dialog"][aria-label="设定时刻"]',
  realSegment: '[role="group"][aria-label="切换视图"] button:text-is("实境")',
  exitReal: 'button[aria-label="回沙盘"]',
  dist: "[data-real-distance]",
  focusBox: "[data-real-focus]",
  earthFraming: 'button[aria-label="地球取景"]',
  moonFraming: 'button[aria-label="月球取景"]',
};

async function openCalibration(page, step) {
  const locked = await page.locator(sel.badgeLocked).count();
  if (locked) await page.locator(sel.badgeLocked).first().click();
  else await page.locator(sel.badgePanel).first().click();
  await until(page, step, "校准面板没打开", (s) => Boolean(document.querySelector(s)), sel.panel, {
    expected: "点徽标后出现 [role=dialog][aria-label=校准]",
    actual: (s) => ({ panelCount: document.querySelectorAll(s).length }),
  });
}

async function gateDots(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[role="progressbar"][aria-label="校准进度"]');
    return el ? Number(el.getAttribute("aria-valuenow")) : null;
  });
}

/** 面板三条提示的完成状态：data-gate-hint + data-lit + 右侧文字。 */
async function gateHints(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-gate-hint]")].map((el) => ({
      slot: el.getAttribute("data-gate-hint"),
      lit: el.getAttribute("data-lit") === "true",
      text: (el.textContent || "").trim(),
    })),
  );
}

/**
 * 门存档（产品自己写的 localStorage）：断言读它，不必为了看一格灯反复开关面板。
 * 键名是历史（v1），不是 schema 版本 —— 见 gate.ts 的 GATE_KEY 注释。
 */
async function gateLit(page) {
  return page.evaluate(() => {
    try {
      const raw = window.localStorage.getItem("xinggui-gate-v1");
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed?.lit) ? parsed.lit : [];
    } catch {
      return [];
    }
  });
}

/**
 * 画布点选夹具（t33）：挑一颗在屏幕上、离其他天体 ≥30px、且该点确实落在 canvas 上的行星。
 * 30px 让 22px 的拾取热区不互相重叠；elementFromPoint 保证别点到 HUD。
 */
async function canvasPickPlanet(page) {
  return page.evaluate(() => {
    const planets = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"];
    const bodies = window.__solarProbe?.() ?? [];
    let best = null;
    for (const b of bodies) {
      if (!planets.includes(b.id)) continue;
      if (!(Number.isFinite(b.x) && Number.isFinite(b.y))) continue;
      if (b.x < 2 || b.y < 2 || b.x > innerWidth - 2 || b.y > innerHeight - 2) continue;
      let nearest = Infinity;
      for (const o of bodies) {
        if (o.id === b.id) continue;
        nearest = Math.min(nearest, Math.hypot(o.x - b.x, o.y - b.y));
      }
      const el = document.elementFromPoint(b.x, b.y);
      if (!el || el.tagName !== "CANVAS") continue;
      if (nearest < 30) continue;
      if (!best || nearest > best.gap) best = { id: b.id, x: +b.x.toFixed(1), y: +b.y.toFixed(1), gap: +nearest.toFixed(1) };
    }
    return best;
  });
}

async function pickBody(page, step, id) {
  await ensureChips(page, step); // 顶部星球行会自己收起，先把它叫回来
  const chip = page.locator(`#chip-${id}`);
  if ((await chip.count()) === 0) {
    throw new StepError(step, `找不到 #chip-${id}`, "芯片行应有 chip-<bodyId>", JSON.stringify(await page.evaluate(() => ({ chips: [...document.querySelectorAll("[id^=chip-]")].map((e) => e.id) }))));
  }
  await chip.first().click();
  await until(page, step, `选中 ${id} 失败`, (t) => new URL(location.href).searchParams.get("body") === t, id, {
    expected: `?body=${id}`,
    actual: (t) => ({ body: new URL(location.href).searchParams.get("body"), pressed: document.querySelector(`#chip-${t}`)?.getAttribute("aria-pressed") ?? null }),
  });
}

async function realVisible(page) {
  return page.evaluate(() => {
    const live = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
    };
    const all = [...document.querySelectorAll('button, a, input, [role="button"], [role="slider"], [tabindex]')];
    return all.filter(live).map((el) => ({
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 16) || null,
      pressed: el.getAttribute("aria-pressed"),
      inCard: Boolean(el.closest("article")),
    }));
  });
}

async function readDist(page) {
  return page.evaluate(() => ({
    text: document.querySelector("[data-real-distance]")?.textContent?.trim() ?? null,
    focus: document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") ?? null,
    suffix: document.querySelector("[data-real-focus] .truncate")?.textContent?.trim() ?? null,
  }));
}

/**
 * v1.3.0 的**顶部星球行也会自己收起**（t12）：指针离开后整行从 DOM 里消失，只剩一个
 * 「展开天体列表」把手。第二次跑就栽在这里——聚焦完五颗星再回头点木星，`#chip-jupiter` 已经不在。
 * 真人同样要先点那个把手，所以夹具照做（这不是绕过，是复现）。
 */
async function ensureChips(page, step) {
  if ((await page.locator("#chip-row").count()) > 0) return;
  for (const label of ["展开天体列表", "天体列表"]) {
    const b = page.locator(`button[aria-label="${label}"]`);
    if ((await b.count()) > 0) {
      const t0 = Date.now();
      await b.first().click();
      chromeTally.chipsExpanded++;
      chromeTally.expandMs.push({ what: "chips", ms: Date.now() - t0, step });
      break;
    }
  }
  await until(page, step, "星球行没展开（顶部仍是收起态）", () => Boolean(document.getElementById("chip-row")), undefined, {
    expected: "展开后出现 #chip-row",
    actual: () => ({
      handles: [...document.querySelectorAll("header button")].map((b) => b.getAttribute("aria-label")).filter(Boolean),
      chips: [...document.querySelectorAll("[id^=chip-]")].map((e) => e.id),
    }),
  });
}

/**
 * v1.3.0 的底栏会自己收起（t12）：指针离开后缩成一条细条，按钮整个不在 DOM 里。
 * 想按暂停 / 图层 / 总览 / 时计，得先点那条「操作台」。**第一次跑就栽在这里**——
 * 聚焦完五颗星之后指针停在画布上，底栏已经缩了，于是 `button[aria-label="尾迹"]` 超时 30s。
 * 这不是夹具问题：真人也会遇到（想看图层，先得把操作台叫回来）。
 */
async function ensureDock(page, step) {
  const expand = page.locator('button[aria-label="展开操作台"]');
  if ((await expand.count()) > 0) {
    const t0 = Date.now();
    await expand.first().click();
    await frames(page, 3);
    chromeTally.dockExpanded++;
    chromeTally.expandMs.push({ what: "dock", ms: Date.now() - t0, step });
  }
  // 判据里的选择器必须当参数传进去：写成 () => document.querySelector(sel.overview) 会在页面里
  // 抛 "sel is not defined"（sel 是 Node 侧常量），表现是"等了 14ms 就红"——比超时更难看出问题。
  await until(page, step, "操作台没展开（底栏仍是收起态）", (s) => Boolean(document.querySelector(s)), sel.overview, {
    expected: '底栏展开后出现 button[aria-label="返回总览"]',
    actual: () => ({
      collapsed: Boolean(document.querySelector('button[aria-label="展开操作台"]')),
      buttons: [...document.querySelectorAll("footer button")].map((b) => b.getAttribute("aria-label")).filter(Boolean),
    }),
  });
}

/* ────────────────────────────── dump ────────────────────────────── */

async function dump(page, name, extra = {}, lum = null) {
  const data = await page.evaluate(() => {
    const safe = (fn) => {
      try {
        return fn();
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    };
    const attr = (s, a) => document.querySelector(s)?.getAttribute(a) ?? null;
    const dots = document.querySelector('[role="progressbar"][aria-label="校准进度"]');
    return {
      url: location.search,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      badge: attr("header button", "aria-label"),
      gate: {
        litDots: dots ? Number(dots.getAttribute("aria-valuenow")) : null,
        hints: [...document.querySelectorAll("[data-gate-hint]")].map((el) => ({ slot: el.getAttribute("data-gate-hint"), lit: el.getAttribute("data-lit") === "true" })),
        panelOpen: Boolean(document.querySelector('[role="dialog"][aria-label="校准"]')),
        celebrateText: (document.querySelector(".gate-celebrate")?.textContent || "").trim() || null,
      },
      selected: new URL(location.href).searchParams.get("body"),
      layers: { labels: attr('button[aria-label="名称"]', "aria-pressed"), orbits: attr('button[aria-label="轨道"]', "aria-pressed"), trails: attr('button[aria-label="尾迹"]', "aria-pressed") },
      real: {
        distance: (document.querySelector("[data-real-distance]")?.textContent || "").trim() || null,
        focus: attr("[data-real-focus]", "data-real-focus"),
        earthPressed: attr(sel_earth(), "aria-pressed"),
        moonPressed: attr(sel_moon(), "aria-pressed"),
      },
      probe: safe(() => window.__solarProbe?.() ?? null),
      pick: safe(() => (window.__solarPick ? { hotRadius: window.__solarPick.hotRadius, candidates: window.__solarPick.candidates() } : null)),
      quality: safe(() => window.__solarQuality?.() ?? null),
      time: safe(() => (window.__solarTime ? { now: window.__solarTime.now(), days: window.__solarTime.days() } : null)),
      camera: safe(() => window.__solarCamera?.() ?? null),
      clip: safe(() => window.__solarClip?.() ?? null),
      look: safe(() => window.__solarLook?.() ?? null),
      kepler: safe(() => window.__solarKepler?.() ?? null),
      orbitPlanes: safe(() => window.__solarOrbitPlanes?.() ?? null),
      orbitFrames: safe(() => (window.__solarOrbitFrames ? { has: true, type: typeof window.__solarOrbitFrames } : null)),
      belt: safe(() => window.__solarBelt?.() ?? null),
    };
    function sel_earth() { return 'button[aria-label="地球取景"]'; }
    function sel_moon() { return 'button[aria-label="月球取景"]'; }
  });
  const payload = { step: name, at: new Date().toISOString(), ...extra, lum, data };
  await writeFile(path.join(OUT, `${name}.json`), JSON.stringify(payload, null, 2), "utf8");
  return { data, lum };
}

/* ────────────────────────────── 一步 = 动作 + 截图 + 亮度 + dump ────────────────────────────── */

/** HUD 自动收起的"找回成本"账本：每次不得不点把手都记一笔。 */
const chromeTally = { dockExpanded: 0, chipsExpanded: 0, expandMs: [] };

const steps = [];
const consoleErrors = [];
const pageErrors = [];

async function run(page, name, label, body) {
  const t0 = Date.now();
  const extra = (await body()) ?? {};
  await frames(page, 2);
  const shot = `${name}.png`;
  const buf = await page.screenshot();
  await writeFile(path.join(OUT, shot), buf);
  const lum = pngMeanLum(buf);
  const ms = Date.now() - t0;
  if (name !== "01-overview") await dump(page, name, extra, lum);
  else await dump(page, name, extra, lum);
  steps.push({ id: name, label, ms, shot, meanLum: lum.meanLum, nonBlack: lum.nonBlackRatio });
  console.log(`  ✓ ${name.padEnd(24)} ${String(ms).padStart(6)}ms  亮${String(lum.meanLum).padStart(6)}  ${shot}`);
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const { server, port } = await startOnFreePort(PORT);
const base = `http://127.0.0.1:${port}`;
const startedAt = new Date();
if (PRERELEASE) {
  console.warn(`  ! 版本 ${VERSION} 是发版前构建（-snap/-rc）。这次跑出来的结论只能当预演，不能当发版结论。`);
}

const attach = (page) => {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err.message || err)));
  return page;
};

let browser = null;
let exitCode = 0;
/**
 * 版本守门（见顶部 PRERELEASE）：run.json 里把它写死、启动时大声念一遍，
 * 避免"报告写完时结论已经过期"这类事——让文件自己打脸，比写在报告里强。
 */
const report = { version: VERSION, prerelease: PRERELEASE, artifact: ARTIFACT, chromeTally, base, steps, consoleErrors, pageErrors };

try {
  browser = await chromium.launch({ executablePath: EDGE, args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"] });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = attach(await ctx.newPage());
  const tOpen = Date.now();
  await page.goto(`${base}/`, { waitUntil: "load" });
  await until(page, "01-overview", "画布没渲染出来", () => window.__solarReady === true, undefined, {
    timeout: 60000,
    expected: "window.__solarReady === true",
    actual: () => ({ ready: window.__solarReady ?? null, canvas: document.querySelectorAll("canvas").length }),
  });
  console.log(`  · 首帧就绪 ${Date.now() - tOpen}ms`);

  // 1. 首屏
  await run(page, "01-overview", "首屏总览", async () => {
    await frames(page, 6);
    return {};
  });

  // 2. 锁态面板：三行提示应当都在且全部「未完成」
  await run(page, "02-gate-hints-locked", "打开校准面板（三条观察，全未完成）", async () => {
    await openCalibration(page, "02-gate-hints-locked");
    const hints = await gateHints(page);
    if (hints.length !== 3) throw new StepError("02-gate-hints-locked", "面板里不是三行提示", "3 行 [data-gate-hint]", JSON.stringify(hints));
    if (hints.some((h) => h.lit)) throw new StepError("02-gate-hints-locked", "新装的游戏已经有观察点亮了", "三行 data-lit 全为 false", JSON.stringify(hints));
    return { hints };
  });

  // 3. 门·time：**跳年不亮**（t13/t19 口径），选中月球等进入本影才亮
  //    旧版这一步是「跳到第 2 年 → 断言 time 亮」—— 旧判据把"钟走过去了"当"你看着它走过去"，
  //    那正是 1.3.4 拆掉的东西。现在跳变不判：只有从外进影、且那一刻月球被玩家选中才判。
  await run(page, "03-gate-time", "门·time：跳年不亮，选中月球等本影", async () => {
    await page.keyboard.press("Escape"); // 关掉 step02 打开的面板
    await ensureDock(page, "03-gate-time");
    await page.locator(sel.timeTrigger).first().click();
    await until(page, "03-gate-time", "时计面板没打开", (s) => Boolean(document.querySelector(s)), sel.timePanel, {
      expected: '出现 [role=dialog][aria-label="设定时刻"]',
      actual: () => ({ panels: document.querySelectorAll('[role="dialog"]').length }),
    });
    const inputs = page.locator('input[type="number"]');
    await inputs.nth(0).fill("2");
    await inputs.nth(1).fill("1");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.keyboard.press("Escape");
    await until(page, "03-gate-time", "时间没跳到第 2 年", (e) => Math.abs(window.__solarTime.days() - e) < 0.5, 730.5, {
      expected: "days ≈ 730.5",
      actual: (e) => ({ days: window.__solarTime.days(), want: e }),
    });
    const afterJump = await gateLit(page);
    if (afterJump.includes("time")) {
      throw new StepError(
        "03-gate-time",
        `跳到第 2 年后 time 当场亮了（lit=${JSON.stringify(afterJump)}）—— 跳变不该算目击`,
        'lit 不含 "time"',
        JSON.stringify({ lit: afterJump, days: await page.evaluate(() => window.__solarTime.days()) }),
      );
    }
    // 选中地球 → 月球，等"进入本影"（8× 下下一次进影在几实秒内）
    await pickBody(page, "03-gate-time", "earth");
    await pickBody(page, "03-gate-time", "moon");
    const waited = await until(
      page,
      "03-gate-time",
      "选中月球 25s 内 time 仍未点亮",
      () => (JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || []).includes("time"),
      undefined,
      {
        timeout: 25000,
        expected: 'xinggui-gate-v1 的 lit 含 "time"',
        actual: () => ({
          lit: JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || [],
          sim: window.__solarTime.now(),
        }),
      },
    );
    return { lit: await gateLit(page), jumpLit: afterJump, waitedMs: waited, days: await page.evaluate(() => window.__solarTime.days()) };
  });

  // 4. 门·target（t19）：点一下不亮；盯着水星跑满一整圈（8.2 模拟秒 ≈ 8× 下 20.8 实秒）才亮
  await run(page, "04-gate-target", "门·target：盯水星跑满一整圈", async () => {
    const before = await gateLit(page);
    await pickBody(page, "04-gate-target", "mercury");
    const justClicked = await gateLit(page);
    if (justClicked.includes("target")) {
      throw new StepError(
        "04-gate-target",
        `点一次 #chip-mercury 就亮了 target（lit=${JSON.stringify(justClicked)}）—— 这一格又退回「点到就算」`,
        '点一次后 lit 不含 "target"',
        JSON.stringify({ before, justClicked }),
      );
    }
    const waited = await until(
      page,
      "04-gate-target",
      "盯着水星 35s 仍未点亮 target",
      () => (JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || []).includes("target"),
      undefined,
      {
        timeout: 35000,
        expected: 'lit 含 "target"（跑满一圈 8.2 模拟秒）',
        actual: () => ({
          lit: JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || [],
          sim: window.__solarTime.now(),
        }),
      },
    );
    return { lit: await gateLit(page), waitedMs: waited, litAfterClick: justClicked };
  });

  // 5. 门·layer（t19）：先关名称与轨道，**再点一颗行星**（太阳与卫星不算）
  await run(page, "05-gate-layer", "门·layer：关层后再选一颗行星", async () => {
    await page.keyboard.press("Escape");
    await ensureDock(page, "05-gate-layer");
    const before = await gateLit(page);
    if (before.includes("layer")) {
      throw new StepError("05-gate-layer", `进这一步前 layer 已经亮了（lit=${JSON.stringify(before)}）`, 'lit 不含 "layer"', JSON.stringify(before));
    }
    for (const label of ["名称", "轨道"]) {
      await page.locator(`button[aria-label="${label}"]`).first().click();
      await until(page, "05-gate-layer", `「${label}」没关掉`, (a) => document.querySelector(`button[aria-label="${a}"]`)?.getAttribute("aria-pressed") === "false", label, {
        expected: `「${label}」aria-pressed=false`,
        actual: (a) => ({ [a]: document.querySelector(`button[aria-label="${a}"]`)?.getAttribute("aria-pressed") ?? "按钮不在" }),
      });
    }
    // 只关开关不选天体：layer 不许亮（"摸过控件"不是判据）
    const justToggled = await gateLit(page);
    if (justToggled.includes("layer")) {
      throw new StepError(
        "05-gate-layer",
        `只关了名称与轨道（还没选天体）layer 就亮了（lit=${JSON.stringify(justToggled)}）—— 判据退回「摸过开关」`,
        'lit 不含 "layer"',
        JSON.stringify(justToggled),
      );
    }
    /*
     * 正例必须**画布点选**（t33）：layer 门只认 source === "canvas"——芯片行常驻印着名字，
     * 点芯片等于看着答案点。三步：回总览清掉 selectedId（否则点到已选中的那颗走 refocus()，
     * 不经 select）→ 用 __solarProbe 挑一颗在屏幕上、离其他天体 ≥30px 的行星 → 鼠标真点它的坐标。
     */
    await ensureDock(page, "05-gate-layer");
    await page.locator(sel.overview).first().click();
    await page.waitForTimeout(1800);
    const pick = await canvasPickPlanet(page);
    if (!pick) {
      throw new StepError("05-gate-layer", "画布上找不到「离其他天体 ≥30px 且该点落在 canvas 上」的行星", "≥1 个候选", JSON.stringify(await page.evaluate(() => window.__solarProbe?.() ?? [])));
    }
    await page.mouse.click(pick.x, pick.y);
    const waited = await until(
      page,
      "05-gate-layer",
      `关层后在画布上点 ${pick.id}（${pick.x},${pick.y}）8s 内 layer 仍未点亮`,
      () => (JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || []).includes("layer"),
      undefined,
      {
        timeout: 8000,
        expected: 'lit 含 "layer"',
        actual: () => ({ lit: JSON.parse(window.localStorage.getItem("xinggui-gate-v1") || "{}").lit || [] }),
      },
    );
    // 三条齐了 → 解锁瞬间会弹 .gate-celebrate（2600ms），马上开面板并截图
    const t0 = Date.now();
    await openCalibration(page, "05-gate-layer");
    const celeb = await page.evaluate(() => (document.querySelector(".gate-celebrate")?.textContent || "").trim() || null);
    const hints = await gateHints(page);
    if (hints.filter((h) => h.lit).length !== 3) throw new StepError("05-gate-layer", "三条都做完了却不是 3/3", "三条 data-lit 全 true", JSON.stringify(hints));
    return { hints, celebrateText: celeb, celebrateSeenMs: Date.now() - t0, waitedMs: waited, litAfterToggles: justToggled };
  });

  // 5b. 解锁之后：玩家怎么知道"实境"能进去了？
  //   这一版把 CTA 从庆祝语里去掉了（"要不要去看看真的"），入口只剩抬头那个分段控件里的
  //   「实境」两个字。所以这一步量的不是"能不能进"，而是**看不看得见可以进**：
  //   · 屏幕上"实境"这两个字一共出现几次、分别在哪儿；
  //   · 那个可点的段位有没有任何视觉提示（动画名 / 边框 / 颜色差）。
  //   全部用 DOM 读数，不靠我读代码想象。
  await run(page, "06-find-real-entry", "解锁后：找得到实境入口吗", async () => {
    await page.keyboard.press("Escape"); // 关面板，回到玩家真实的一屏
    await frames(page, 4);
    const probe = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.1;
      };
      const headerBtns = [...document.querySelectorAll("header button")].filter(vis).map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          label: el.getAttribute("aria-label") || (el.textContent || "").trim(),
          pressed: el.getAttribute("aria-pressed"),
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          animation: cs.animationName === "none" ? null : cs.animationName,
          // 段位和旁边那颗折角键的底色差，是"这个能点"的唯一视觉线索
          bg: cs.backgroundColor,
        };
      });
      const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      return {
        headerBtns,
        realMentions: (text.match(/实境/g) || []).length,
        hintMentions: (text.match(/真实视图|去看看真的|进入实境/g) || []).length,
        visibleTextHead: text.slice(0, 220),
      };
    });
    if (!probe.headerBtns.some((b) => b.label === "实境")) {
      throw new StepError("06-find-real-entry", "解锁后抬头里找不到「实境」这个可点段位", "header 里应有 aria/text = 实境 的按钮", JSON.stringify(probe));
    }
    return probe;
  });

  // 6. 聚焦五颗（沙盘腿）
  const focusPlan = [
    ["06-focus-sun", "sun"],
    ["07-focus-earth", "earth"],
    ["08-focus-moon", "moon"],
    ["09-focus-jupiter", "jupiter"],
    ["10-focus-saturn", "saturn"],
  ];
  for (const [id, body] of focusPlan) {
    await run(page, id, `聚焦 ${body}`, async () => {
      if (body === "moon") {
        await pickBody(page, id, "earth");
        await waitFocusStarted(page, "earth");
        await cameraSettled(page, id, { stable: 2, tol: 6e-3 });
      }
      await pickBody(page, id, body);
      const started = await waitFocusStarted(page, body);
      const settled = await cameraSettled(page, id);
      const centered = await focusCentered(page, id, body);
      return { focus: body, focusStarted: started.started, settleMs: settled.ms, centered, distTarget: settled.distTarget };
    });
  }

  // 7. 三层全关（尾迹也关）
  await run(page, "11-layers-all-off", "关掉三层：名称/轨道/尾迹", async () => {
    await ensureDock(page, "11-layers-all-off");
    for (const label of ["尾迹"]) {
      const btn = page.locator(`button[aria-label="${label}"]`);
      if ((await btn.getAttribute("aria-pressed")) === "true") {
        await btn.first().click();
        await until(page, "11-layers-all-off", `「${label}」没关掉`, (a) => document.querySelector(`button[aria-label="${a}"]`)?.getAttribute("aria-pressed") === "false", label, {
          expected: `「${label}」false`,
          actual: (a) => ({ [a]: document.querySelector(`button[aria-label="${a}"]`)?.getAttribute("aria-pressed") }),
        });
      }
    }
    await frames(page, 4);
    return {};
  });

  // 8. 回总览
  await run(page, "12-overview-again", "回总览", async () => {
    await ensureDock(page, "12-overview-again");
    await page.locator(sel.overview).first().click();
    await until(page, "12-overview-again", "返回总览没生效", () => new URL(location.href).searchParams.get("body") === null, undefined, {
      expected: "地址栏不带 ?body=",
      actual: () => ({ body: new URL(location.href).searchParams.get("body") }),
    });
    const settled = await cameraSettled(page, "12-overview-again");
    return { settleMs: settled.ms };
  });

  // 9. 拨时间绝对日期
  //    先暂停再拨：8× 下模拟钟每秒走 8 天，不停表的话"第 3 年第 1 日"这个断言会在等待期间
  //    自己漂走（上一版就是这么红的：想等 730.5，实际读到 1295.7）。
  await run(page, "13-time-absolute", "拨时间：第 3 年 第 1 日", async () => {
    await ensureDock(page, "13-time-absolute");
    await page.locator(sel.pause).first().click();
    await until(page, "13-time-absolute", "暂停没生效", () => Boolean(document.querySelector('button[aria-label="继续模拟"]')), undefined, {
      expected: "暂停后出现「继续模拟」",
      actual: () => ({ pause: document.querySelector('button[aria-label="暂停模拟"]')?.getAttribute("aria-pressed") ?? "按钮不在" }),
    });
    await page.locator(sel.timeTrigger).first().click();
    await until(page, "13-time-absolute", "时计面板没打开", (s) => Boolean(document.querySelector(s)), sel.timePanel, {
      expected: "设定时刻面板",
      actual: () => ({ panels: document.querySelectorAll('[role="dialog"]').length }),
    });
    const inputs = page.locator('input[type="number"]');
    await inputs.nth(0).fill("3");
    await inputs.nth(1).fill("1");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    const expect = 3 * 365.25;
    await until(page, "13-time-absolute", "绝对日期没生效", (e) => Math.abs(window.__solarTime.days() - e) < 0.5, expect, {
      expected: `days ≈ ${expect}（第 3 年 第 1 日）`,
      actual: (e) => ({ days: window.__solarTime.days(), want: e }),
    });
    await page.keyboard.press("Escape");
    const days = await page.evaluate(() => window.__solarTime.days());
    await page.locator(sel.resume).first().click(); // 恢复走时
    return { days, want: expect };
  });

  // 10. 滚轮：慢滚 vs 快滚 vs 松手惯性
  await run(page, "14-wheel", "滚轮：慢滚/快滚/惯性", async () => {
    const cx = 720;
    const cy = 450;
    const d = () => page.evaluate(() => window.__solarCamera?.().distTarget ?? null);
    await page.mouse.move(cx, cy);
    const base0 = await d();
    // 慢滚：单次一格
    await page.mouse.wheel(0, -120);
    await frames(page, 3);
    const slow1 = await d();
    // 惯性：松手后 300ms 的额外位移（这里必须按时间量，测的就是"松手之后还走多少"）
    await page.waitForTimeout(300);
    const slow2 = await d();
    // 快滚：6 次大 delta，间隔 ~25ms
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(25);
    }
    const fast1 = await d();
    await page.waitForTimeout(300);
    const fast2 = await d();
    const pct = (a, b) => (a && b ? +(((b - a) / a) * 100).toFixed(1) : null);
    return {
      base: base0,
      slow: { after: slow1, plus300ms: slow2, gainPct: pct(base0, slow1), inertiaPct: pct(slow1, slow2), totalPct: pct(base0, slow2) },
      fast: { after: fast1, plus300ms: fast2, inertiaPctFromBase: pct(base0, fast1), inertiaPct: pct(fast1, fast2), totalPct: pct(base0, fast2) },
    };
  });

  // 11. 镜头跨极点：垂直拖 10 次，看俯仰角序列与方位翻转
  await run(page, "15-drag-poles", "拖拽 10 次跨极点", async () => {
    const theta = () =>
      page.evaluate(() => {
        const c = window.__solarCamera?.();
        if (!c || !c.target) return null;
        const o = [c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]];
        const len = Math.hypot(...o) || 1;
        return { theta: +(Math.acos(o[1] / len) * 180 / Math.PI).toFixed(1), az: +(Math.atan2(o[2], o[0]) * 180 / Math.PI).toFixed(1) };
      });
    const seq = [];
    let crossings = 0;
    let prev = await theta();
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(720, 560);
      await page.mouse.down();
      await page.mouse.move(720, 240, { steps: 8 });
      await page.mouse.up();
      await frames(page, 4);
      const now = await theta();
      if (prev && now) {
        const dAz = Math.abs(((now.az - prev.az + 540) % 360) - 180);
        if (dAz > 90 || now.theta < 5) crossings++;
      }
      seq.push(now);
      prev = now;
    }
    return { seq, crossings, note: "跨极判据：单次拖拽后方位翻转 >90°，或俯仰角 <5°（贴极点）" };
  });

  // 12. 点击回执：再点一次已选中的天体会不会重取景
  //    上一版只量 distTarget，得到 dFar 83.37 → dAfter 83.45（差 0.08），看起来"没回执"。
  //    但 refocus() 可能只重新对准 target、不改距离 —— 所以这一版同时量 target 与屏幕投影。
  await run(page, "16-click-refocus", "再点一次已选中的星", async () => {
    await ensureChips(page, "16-click-refocus");
    await pickBody(page, "16-click-refocus", "jupiter");
    await cameraSettled(page, "16-click-refocus");
    const snap = () =>
      page.evaluate(() => {
        const c = window.__solarCamera();
        const p = window.__solarProbe().find((x) => x.id === "jupiter");
        return { d: c.distTarget, target: c.target, px: p && Number.isFinite(p.x) ? Math.round(p.x) : null, pr: p ? Math.round(p.radiusPx) : null };
      });
    const s0 = await snap();
    // 先把相机推远一点，让"重取景"有可见空间
    await page.mouse.move(720, 450);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 240);
    // ⚠ 必须等滚轮惯性停下来再比：上一版在惯性里取 sFar（87.36），点完读到 91.82，
    // 那 +4.5 是惯性余量，不是 refocus —— 差点被我写成"点击确实有回执"。
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          let last = null;
          const tick = () => {
            const d = window.__solarCamera().distTarget;
            if (last !== null && Math.abs(d - last) < 0.05) return resolve(true);
            last = d;
            if (performance.now() - t0 > 4000) return resolve(false);
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    const sFar = await snap();
    await ensureChips(page, "16-click-refocus");
    await page.locator("#chip-jupiter").first().click();
    await frames(page, 30);
    const sAfter = await snap();
    return { s0, sFar, sAfter, dChanged: Math.abs(sAfter.d - sFar.d) > 0.5, pxChanged: sAfter.px !== sFar.x };
  });

  // 13. 进实境：7 个控件 + 亮度
  await run(page, "17-real", "进实境（控件清单 + 亮度）", async () => {
    await page.locator(sel.realSegment).first().click();
    await until(page, "17-real", "进实境后芯片行还在", () => !document.getElementById("chip-row"), undefined, {
      expected: "实境 HUD 无 #chip-row",
      actual: () => ({ chipRow: Boolean(document.getElementById("chip-row")) }),
    });
    const veil = await waitVeilLifted(page, "17-real");
    await frames(page, 8);
    const controls = await realVisible(page);
    const dist = await readDist(page);
    return { veil, controls, controlCount: controls.length, dist, kepler: await page.evaluate(() => Boolean(window.__solarKepler)) };
  });

  // 14. 实境取景：地球 / 月球 / 回 wide
  await run(page, "18-real-earth", "实境取景：地球", async () => {
    await page.locator(sel.earthFraming).first().click();
    await until(page, "18-real-earth", "地球取景没生效", () => document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") === "earth", undefined, {
      expected: 'data-real-focus="earth"',
      actual: () => ({ focus: document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") }),
    });
    await frames(page, 10);
    return { dist: await readDist(page), controls: (await realVisible(page)).length };
  });
  await run(page, "19-real-moon", "实境取景：月球", async () => {
    await page.locator(sel.moonFraming).first().click();
    await until(page, "19-real-moon", "月球取景没生效", () => document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") === "moon", undefined, {
      expected: 'data-real-focus="moon"',
      actual: () => ({ focus: document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") }),
    });
    await frames(page, 10);
    return { dist: await readDist(page) };
  });

  // 15. 实境里点一颗星：卡片出来了吗
  //    第一版只判"卡片出现没"，结果 cardAppeared=false 而 ?body= 还是上一步的木星 —— 分不清是
  //    "点不中"还是"点中了但卡不渲染"（木星不在实境系统里，RealCard 会返回 null）。
  //    所以这里先用拾取器自己的 at(x,y) 问一句"这个点上你觉得是谁"，再点。
  await run(page, "20-real-card", "实境里点地球看卡片", async () => {
    // 先切到地球取景：月球取景下地球在屏幕外（y=977 > 900），点它等于点空气。
    // 上一版就是这么假的（cardAppeared:false，而 at() 说那个点是地球）。
    await page.locator(sel.earthFraming).first().click();
    await until(page, "20-real-card", "地球取景没生效", () => document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") === "earth", undefined, {
      expected: 'data-real-focus="earth"',
      actual: () => ({ focus: document.querySelector("[data-real-focus]")?.getAttribute("data-real-focus") }),
    });
    await frames(page, 8);
    const target = await page.evaluate(() => {
      const c = window.__solarPick ? window.__solarPick.candidates().find((x) => x.id === "earth") : null;
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return { missing: true, raw: c ?? null };
      return { x: Math.round(c.x), y: Math.round(c.y), radiusPx: Math.round(c.radiusPx) };
    });
    let clicked = { skipped: "地球没有有限坐标" };
    let atProbe = null;
    if (!target.missing) {
      atProbe = await page.evaluate((t) => {
        const api = window.__solarPick;
        return api ? { at: api.at(t.x, t.y), hot: api.hotRadius } : null;
      }, target);
      await page.mouse.click(target.x, target.y);
      clicked = await page.evaluate(async () => {
        const t0 = performance.now();
        while (performance.now() - t0 < 4000) {
          if (document.querySelector("article")) return { cardAppeared: true, ms: Math.round(performance.now() - t0) };
          await new Promise((r) => requestAnimationFrame(r));
        }
        return { cardAppeared: false, body: new URL(location.href).searchParams.get("body") };
      });
    }
    const inCard = (await realVisible(page)).filter((c) => c.inCard);
    return { target, atProbe, clicked, inCard };
  });

  // 16. 从实境回沙盘（点「回沙盘」这颗新按钮，不走 Esc）
  await run(page, "21-back-to-sandbox", "点「回沙盘」返回", async () => {
    await page.locator(sel.exitReal).first().click();
    await until(page, "21-back-to-sandbox", "「回沙盘」没把视图切回去", () => Boolean(document.getElementById("chip-row")), undefined, {
      expected: "沙盘 HUD 回来",
      actual: () => ({ mode: document.querySelector('[role="group"][aria-label="切换视图"] button[aria-pressed="true"]')?.textContent ?? null }),
    });
    const settled = await cameraSettled(page, "21-back-to-sandbox");
    return { settleMs: settled.ms };
  });

  // 17. 真轨道样本：冥王星 / 哈雷（在实境系统里）
  await run(page, "22-real-orbits", "实境里的冥王星 / 哈雷", async () => {
    await page.locator(sel.realSegment).first().click();
    await until(page, "22-real-orbits", "第二次进实境失败", () => !document.getElementById("chip-row"), undefined, {
      expected: "实境 HUD",
      actual: () => ({ chipRow: Boolean(document.getElementById("chip-row")) }),
    });
    await waitVeilLifted(page, "22-real-orbits");
    await frames(page, 6);
    const ids = await page.evaluate(() => (window.__solarProbe?.() ?? []).map((p) => ({ id: p.id, x: Number.isFinite(p.x) ? Math.round(p.x) : null, r: Math.round(p.radiusPx) })));
    const planes = await page.evaluate(() => (window.__solarOrbitPlanes ? window.__solarOrbitPlanes() : null));
    return { ids, planes };
  });

  const storageState = await ctx.storageState();
  await ctx.close();

  /* ——— 手机腿：390×844 @3 touch ——— */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState });
  const mpage = attach(await mctx.newPage());
  await mpage.goto(`${base}/`, { waitUntil: "load" });
  await until(mpage, "23-mobile-overview", "手机视口下画布没渲染", () => window.__solarReady === true, undefined, {
    timeout: 60000,
    expected: "window.__solarReady === true",
    actual: () => ({ ready: window.__solarReady ?? null }),
  });

  await run(mpage, "23-mobile-overview", "手机首屏 390×844@3", async () => {
    await frames(mpage, 6);
    return {};
  });

  await run(mpage, "24-mobile-real", "手机进实境（含亮度）", async () => {
    await mpage.locator(sel.realSegment).first().click();
    await until(mpage, "24-mobile-real", "手机端进实境失败", () => !document.getElementById("chip-row"), undefined, {
      expected: "实境 HUD",
      actual: () => ({ chipRow: Boolean(document.getElementById("chip-row")) }),
    });
    const veil = await waitVeilLifted(mpage, "24-mobile-real");
    await frames(mpage, 8);
    const controls = await realVisible(mpage);
    return { veil, controls, controlCount: controls.length, dist: await readDist(mpage) };
  });

  await mctx.close();
  report.elapsedMs = Date.now() - startedAt.valueOf();
  report.exitCode = 0;
} catch (err) {
  exitCode = 1;
  report.exitCode = 1;
  report.elapsedMs = Date.now() - startedAt.valueOf();
  if (err instanceof StepError) {
    console.error(`\n✗ 步骤 ${err.step} 走不通：${err.what}`);
    console.error(`  期望：${err.expected}`);
    console.error(`  实际：${err.actual}`);
  } else {
    console.error(`\n✗ 夹具自身崩了：${err?.stack || err}`);
  }
  report.failure = { step: err?.step ?? null, what: err?.what ?? String(err?.message ?? err) };
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* 关不掉也要写 report */
  }
  server.close();
  await writeFile(path.join(OUT, "run.json"), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), "utf8");
}

console.log(`\n产物目录：screenshots/play-${VERSION}/`);
console.log(`截图 ${steps.length} 张、dump ${steps.length} 份、页面报错 ${pageErrors.length}、控制台 error ${consoleErrors.length}`);
if (pageErrors.length) console.log(`  pageerror: ${pageErrors.slice(0, 4).join(" | ")}`);
if (consoleErrors.length) console.log(`  console:   ${consoleErrors.slice(0, 4).join(" | ")}`);
console.log(exitCode === 0 ? `全部 ${steps.length} 步走通。` : `走到第 ${steps.length} 步为止（见 stderr）。`);
process.exit(exitCode);
