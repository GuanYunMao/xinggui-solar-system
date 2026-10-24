/*
 * 解析遮挡（日食/月食）扫描夹具 —— `eclipse-hemisphere` pass 的取数工具。
 *
 * 为什么要有它：`sun-occlusion` 证明的是「太阳在木星背后时木星盘心不透光」，
 * 它**不覆盖** `PLANET_FRAG` 里那套解析遮挡公式本身。今晚的 bug 正好出在公式里：
 *   `sep = length(cross(sunDir, occDir))` 就是 |sin θ|，它在 θ=0°（遮挡体在前 = 真食）
 *   与 θ=180°（遮挡体在背面，物理上挡不住）**都等于 0**，缺一个 `dot(sunDir, occDir) > 0` 的半球判断。
 *
 * 用法（自己起静态服务，不依赖别人的 port）：
 *   node scripts/eclipse-scan.mjs                       # 默认 release/site，输出 .tmp-eclipse/scan.json
 *   XG_SITE=<dir> XG_OUT=<file> node scripts/eclipse-scan.mjs
 *   node scripts/eclipse-scan.mjs earth:moon io:jupiter  # 指定天体对
 *
 * 输出：每个「天体对 × 相位组」的 **min / max / 中位**（日下点 24×24 luma）与对参照组的比值。
 * ⚠ 分组**从实测 dot 推出来**，不从"我挑了哪几个时刻"推：产品轨道相位一变，
 *   按时刻分组会把一帧悄悄塞进错的组，而断言照样绿。
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EDGE = process.env.XG_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SITE = path.resolve(process.env.XG_SITE ?? "release/site");
const OUT = path.resolve(process.env.XG_OUT ?? ".tmp-eclipse/scan.json");
const PAIRS = process.argv.slice(2).filter((a) => a.includes(":")).length
  ? process.argv.slice(2).filter((a) => a.includes(":")).map((a) => a.split(":"))
  : [["earth", "moon"], ["io", "jupiter"], ["titan", "saturn"]];
const SWEEP_STEP = 0.02;
const SWEEP_END = 13;
const PER_GROUP = 6; // 每组至少 6 个时刻：一帧的比值没有分布，跟没有一样

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
const server = await new Promise((res, rej) => {
  const s = createServer(async (req, rep) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const body = await readFile(path.join(SITE, rel));
      rep.writeHead(200, { "content-type": MIME[path.extname(rel)] ?? "application/octet-stream" });
      rep.end(body);
    } catch {
      rep.writeHead(404).end("not found");
    }
  });
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => res(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}?diag=1`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);
await page.keyboard.press(" "); // 暂停：时间由脚本自己钉
await page.waitForTimeout(200);

/** 世界位置：用 `__solarOrbitPlanes()` 的相对偏移累加成绝对坐标（太阳在原点） */
const worldAt = (t) =>
  page.evaluate(async (t) => {
    window.__solarTime.set(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const rows = window.__solarOrbitPlanes();
    const pos = { sol: [0, 0, 0], sun: [0, 0, 0] };
    for (const r of rows) if (r.parent === "sun") pos[r.id] = r.rel.slice();
    for (const r of rows) if (r.parent !== "sun") {
      const p = pos[r.parent] ?? [0, 0, 0];
      pos[r.id] = [p[0] + r.rel[0], p[1] + r.rel[1], p[2] + r.rel[2]];
    }
    return pos;
  }, t);

const dotSunOcc = (pos, id, occId) => {
  const p = pos[id];
  const s = pos.sun ?? pos.sol;
  const o = pos[occId];
  if (!p || !o) return null;
  const a = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
  const b = [o[0] - p[0], o[1] - p[1], o[2] - p[2]];
  const na = Math.hypot(...a);
  const nb = Math.hypot(...b);
  if (na < 1e-9 || nb < 1e-9) return null;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
};

/**
 * 连续两次读数一致才认（半径抖动 <2%）。
 * 为什么必须：`__solarTime.set()` 跳时刻之后，`__solarPick.candidates()` 有秒级不可信期
 * （t8-F3 实测过盘心差 500px）。第一版夹具没等就拿来算盘半径 → 两次采样框住的范围不同
 * → 同一个日下点量出 3.1× 的差，看起来像产品 bug，其实是夹具在量不同的东西。
 */
const stableBody = async (id, tries = 8) => {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const cur = await page.evaluate((id) => {
      const c = window.__solarPick?.candidates?.().find((x) => x.id === id);
      const cam = window.__solarCamera?.();
      return c && cam ? { r: c.radiusPx, d: c.depth, fov: cam.fov } : null;
    }, id);
    if (cur && prev && Math.abs(cur.r - prev.r) / Math.max(1e-6, cur.r) < 0.02 && Math.abs(cur.d - prev.d) / Math.max(1e-6, cur.d) < 0.02) {
      return cur;
    }
    prev = cur;
    await page.waitForTimeout(250);
  }
  return null;
};

const norm = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 机位方向：**垂直于日向、且背离地球** —— `C = −(E − (E·S)S)`。
 *
 * 为什么不是"日向一侧"：月食那天从月球朝太阳看，那条线**穿过地球**，相机落进球体、
 * 月球被 `candidates()` 剔除 → 该组 n=0。
 * 为什么不是"固定方位 90°"：`dot≈0` 时地球**恰在方位 90°**，相机照样撞地球，
 * 于是 fallback 抬到 el=25，**同一组混进两种相角**——组内差 2.6 倍（el0 55.5 / el25 145），
 * 差点让我把"反侧 0.988（好）"读成"0.38（坏）"。
 * 这个方向同时满足两件事：**相角恒定 90°（跨组可比）** 与 **永远背离地球（不撞）**。
 */
function cameraDir(pos, id, occId) {
  const S = norm(sub(pos.sun ?? pos.sol, pos[id]));
  const E = norm(sub(pos[occId], pos[id]));
  if (!S || !E) return null;
  const k = dot3(E, S);
  const perp = [E[0] - k * S[0], E[1] - k * S[1], E[2] - k * S[2]];
  let C = norm([-perp[0], -perp[1], -perp[2]]);
  /*
   * 退化情况必须显式处理：`|dot|` 接近 1 时地球几乎与日向共线，`perp≈0`，
   * "背离地球"这个方向**在数值上不稳定**——实测同一组里 az 在 +90/−90 之间乱跳，
   * 于是同一组混进两种观察侧，亮度差 43 vs 25。这时两个垂直方向都远离地球，
   * 直接取固定 +90（`right`），相角仍是 90°，跨组可比。
   */
  if (Math.abs(k) > 0.9 || !C) C = norm(cross(S, [0, 1, 0])) ?? null;
  if (!C) return null;
  // place() 的角度约定：azimuth 以「指向太阳」为 0°，right = S × up(0,1,0)，elevation 沿世界 Y
  const up = [0, 1, 0];
  const right = norm(cross(S, up)) ?? [1, 0, 0];
  const az = (Math.atan2(dot3(C, right), dot3(C, S)) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, C[1]))) * 180) / Math.PI;
  return { az: +az.toFixed(2), el: +el.toFixed(2), dot: +dot3(S, E).toFixed(3) };
}

/**
 * 与 shader **同源**的遮挡覆盖度（独立重算，不吃实现里的中间值）：
 *   sep  = |cross(单位日向, 单位遮挡体向)| = sin θ
 *   aSun = uSunRadius / dSun，aOcc = uOccR / dOcc（角半径）
 *   cover = (aOcc + aSun − sep) / (2·aSun)   ≥1 全食、0–1 偏食、≤0 无食
 * ⚠ 沙盘是**压缩几何**：`uSunRadius=3.8`、日距≈15 ⇒ 太阳角半径 ~14.5°，不是真世界的 0.27°。
 *   所以"dot=0.9（夹角 25.7°）"在沙盘里完全可能是一次真偏食——判"算不算食"必须用本模型的角半径。
 */
const geometryOf = (pos, id, occId, radii) => {
  const S = sub(pos.sun ?? pos.sol, pos[id]);
  const E = sub(pos[occId], pos[id]);
  const dSun = Math.hypot(...S);
  const dOcc = Math.hypot(...E);
  const Su = norm(S);
  const Eu = norm(E);
  if (!Su || !Eu) return null;
  const sep = Math.hypot(...cross(Su, Eu));
  const aSun = radii.sun / dSun;
  const aOcc = radii[occId] / dOcc;
  const cover = (aOcc + aSun - sep) / (2 * aSun);
  return {
    dot: +dot3(Su, Eu).toFixed(3),
    sep: +sep.toFixed(4),
    aSunDeg: +((aSun * 180) / Math.PI).toFixed(2),
    aOccDeg: +((aOcc * 180) / Math.PI).toFixed(2),
    cover: +cover.toFixed(3),
    dSun: +dSun.toFixed(3),
    dOcc: +dOcc.toFixed(3),
  };
};
const sample = async (id, t, occId) => {
  const pos = await worldAt(t);
  const radii = await page.evaluate(({ ids }) => {
    const cam = window.__solarCamera();
    const canvas = document.querySelector("canvas");
    const H = canvas.clientHeight;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const out = {};
    for (const id of ids) {
      const c = window.__solarPick?.candidates?.().find((x) => x.id === id);
      out[id] = c && c.depth > 0 ? (c.radiusPx * c.depth * tanHalf * 2) / H : null;
    }
    return out;
  }, { ids: [id, occId, "sun"] });
  const geo = radii.sun != null && radii[occId] != null ? geometryOf(pos, id, occId, radii) : null;
  const dirInfo = cameraDir(pos, id, occId);
  if (!dirInfo) return { available: false, reason: "几何算不出机位方向（位置缺失）" };
  const stable = await stableBody(id);
  if (!stable) return { available: false, reason: "candidates() 两次读数不一致（跳时刻后的不可信期）" };
  const placed = await page.evaluate(({ id, rPx, depth, fov, az, el }) => {
    const canvas = document.querySelector("canvas");
    const H = canvas.clientHeight;
    const tanHalf = Math.tan((fov * Math.PI) / 360);
    const rWorld = (rPx * depth * tanHalf * 2) / H;
    if (!(rWorld > 0)) return null;
    const dist = +(rWorld * 8.6).toFixed(5);
    const r = window.__solarPlace(id, dist, az, el);
    if (!r) return null;
    const n = window.__solarCamera()?.nearest;
    const inside = n && n.id !== id && n.dist < n.radius * 1.05;
    return { ...r, elevationDeg: el, azimuthDeg: az, insideOther: inside ? { id: n.id, dist: n.dist, radius: n.radius } : null };
  }, { id, rPx: stable.r, depth: stable.d, fov: stable.fov, az: dirInfo.az, el: dirInfo.el });
  if (!placed) return { available: false, reason: "__solarPlace 返回 null（天体不在 registry 或相机未就绪）" };
  if (placed.insideOther) return { available: false, reason: `相机落在 ${placed.insideOther.id} 里`, ...placed };
  if (!placed) return { available: false, reason: "__solarPlace 返回 null（天体不在 registry 或相机未就绪）" };
  await page.waitForTimeout(320);
  const stable2 = await stableBody(id, 4);
  if (!stable2) return { available: false, reason: "摆位后 candidates() 仍不稳定" };
  const stat = await page.evaluate((targetId) => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const W = canvas.width;
    const H = canvas.height;
    const cam = window.__solarCamera();
    const c = window.__solarPick?.candidates?.().find((x) => x.id === targetId);
    if (!c) return { available: false, reason: "candidates 里没有该天体" };
    const rPx = c.radiusPx;
    const box = Math.min(400, Math.max(48, Math.round(rPx * 2.2)));
    const x0 = Math.max(0, Math.round(c.x * (W / canvas.clientWidth) - box / 2));
    const y0 = Math.max(0, Math.round(H - c.y * (H / canvas.clientHeight) - box / 2));
    const buf = new Uint8Array(box * box * 4);
    gl.readPixels(x0, y0, box, box, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const lum = new Float32Array(box * box);
    for (let i = 0; i < box * box; i++) lum[i] = 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
    const cc = box / 2;
    const inside = [];
    for (let y = 0; y < box; y++) for (let x = 0; x < box; x++) if (Math.hypot(x - cc, y - cc) <= rPx * 0.86) inside.push(y * box + x);
    const vals = inside.map((i) => lum[i]).sort((a, b) => a - b);
    // 整盘平均（不只是日下点窗口）：**月食是整盘变暗**，24×24 窗口看不见这种坏状态。
    // 这也是 t48⑥ 被实测否掉的地方：小天体遮大天体时影子只压住窗口一小块。
    let sum = 0;
    for (const i of inside) sum += lum[i];
    const n = inside.length;
    const nearest = cam.nearest;
    return {
      available: true,
      diskPx: +rPx.toFixed(1),
      median: vals.length ? +vals[Math.floor(vals.length / 2)].toFixed(2) : null,
      diskMean: +(sum / Math.max(1, n)).toFixed(2),
      insideOther: nearest && nearest.id !== targetId && nearest.dist < nearest.radius * 1.02 ? { id: nearest.id } : null,
    };
  }, id);
  return { placed, ...stat };
};

const out = { base: BASE, site: SITE, pairs: [], errors: [] };
for (const [id, occ] of PAIRS) {
  // ① 扫一个轨道周期，按**实测 dot** 归组
  // 半径先量一次（产品里是常量，但**从 candidates 反推**而不是抄常数表）
  const radii0 = await page.evaluate(({ ids }) => {
    const cam = window.__solarCamera();
    const H = document.querySelector("canvas").clientHeight;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const out = {};
    for (const id of ids) {
      const c = window.__solarPick?.candidates?.().find((x) => x.id === id);
      out[id] = c && c.depth > 0 ? (c.radiusPx * c.depth * tanHalf * 2) / H : null;
    }
    return out;
  }, { ids: [id, occ, "sun"] });

  /*
   * 分组用 **cover（与 shader 同源的遮挡覆盖度）**，不用 `dot` 拍阈值：
   *   cover ≥ 1 全食 / 0–1 偏食 / ≤ 0 无食。
   * 为什么：`dot=0.9` 在真世界是 25.7°（绝无食），在**沙盘压缩几何**里却是真偏食
   * （太阳角半径 ~14.5°，地球在月距处 ~22°）。用本模型的角半径算 cover，
   * 才分得清"该暗"与"不该暗"，也才谈得上阈值从分布取。
   */
  /*
   * 分组键（t53 定稿）：
   *   正侧 = `dot > 0 且 cover ≥ 1`   ← 必须带 dot>0！`sep=|sinθ|` 是偶函数，
   *                                     只用 cover 会把 `dot=−1`（地球在背面）分进"全食"，
   *                                     那正是 t50 的 bug 形状，验收侧也会犯（我犯过一次）。
   *   反侧 = `dot < 0`（不论 cover）  ← t50 的签字：背面不该变暗
   *   参照 = `cover ≤ 0`
   * 窗口窄是几何决定的 ⇒ 先粗扫找 `dot` 的局部极大/极小，再在极值附近 0.002 细扫凑够 n。
   */
  const coarse = [];
  for (let t = 0; t <= SWEEP_END + 1e-9; t += SWEEP_STEP) {
    const tt = +t.toFixed(3);
    const pos = await worldAt(tt);
    if (!radii0.sun || !radii0[occ]) continue;
    const g0 = geometryOf(pos, id, occ, radii0);
    if (g0) coarse.push({ t: tt, dot: g0.dot, cover: g0.cover, geo: g0 });
  }
  // 在 +1 / −1 附近各取 3 个极值窗口，用 0.002 细扫补样本
  const refineAround = async (center, span = 0.08, step = 0.002) => {
    const out = [];
    for (let dt = -span; dt <= span + 1e-9; dt += step) {
      const tt = +Math.max(0, center + dt).toFixed(3);
      const pos = await worldAt(tt);
      const g0 = radii0.sun && radii0[occ] ? geometryOf(pos, id, occ, radii0) : null;
      if (g0) out.push({ t: tt, dot: g0.dot, cover: g0.cover, geo: g0 });
    }
    return out;
  };
  const peaks = (arr, wantSign) =>
    arr
      .filter((r) => (wantSign > 0 ? r.dot > 0.9 : r.dot < -0.9))
      .sort((a, b) => (wantSign > 0 ? b.dot - a.dot : a.dot - b.dot))
      .slice(0, 3)
      .map((r) => r.t);
  const fine = [...coarse];
  for (const t0 of [...peaks(coarse, +1), ...peaks(coarse, -1)]) {
    try {
      fine.push(...(await refineAround(t0)));
    } catch {
      /* 细扫失败就只用粗扫样本，n 会小，下面会报出来 */
    }
  }
  const seen = new Set();
  const uniq = fine.filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true)));
  const buckets = {
    total: uniq.filter((r) => r.dot > 0 && r.cover >= 1),
    antisolar: uniq.filter((r) => r.dot < 0),
    none: uniq.filter((r) => r.cover <= 0),
  };
  const GROUP_LABEL = { total: "正侧(dot>0 且 cover≥1)", antisolar: "反侧(dot<0)", none: "参照(cover≤0)" };
  const pick = (arr) => {
    if (arr.length <= PER_GROUP) return arr;
    const step = (arr.length - 1) / (PER_GROUP - 1);
    return Array.from({ length: PER_GROUP }, (_, i) => arr[Math.round(i * step)]);
  };
  const rec = { pair: `${id}:${occ}`, groupLabels: GROUP_LABEL, groupSizes: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), groups: {} };
  for (const g of ["total", "antisolar", "none"]) {
    const chosen = pick(buckets[g]);
    const rows = [];
    const fails = [];
    for (const c of chosen) {
      const m = await sample(id, c.t, occ);
      if (!m.available) fails.push({ t: c.t, reason: m.reason || "unknown" });
      if (m.available) rows.push({ t: c.t, dot: c.dot, cover: c.cover, diskMean: m.diskMean, el: m.placed?.elevationDeg ?? null, az: m.placed?.azimuthDeg ?? null, geo: c.geo ?? null });
    }
    const v = rows.map((r) => r.diskMean).sort((a, b) => a - b);
    rec.groups[g] = {
      n: rows.length,
      min: v.length ? v[0] : null,
      max: v.length ? v[v.length - 1] : null,
      median: v.length ? v[Math.floor(v.length / 2)] : null,
      dotRange: rows.length ? [Math.min(...rows.map((r) => r.dot)), Math.max(...rows.map((r) => r.dot))] : null,
      rows,
      failures: fails,
    };
  }
  const zeroMed = rec.groups.none.median;
  for (const g of ["total", "antisolar"]) {
    const b = rec.groups[g];
    b.ratioToNone = {
      min: zeroMed && b.min !== null ? +(b.min / zeroMed).toFixed(3) : null,
      max: zeroMed && b.max !== null ? +(b.max / zeroMed).toFixed(3) : null,
      median: zeroMed && b.median !== null ? +(b.median / zeroMed).toFixed(3) : null,
    };
  }
  out.pairs.push(rec);
  console.log(
    `${rec.pair}  正侧 ${rec.groups.total.n}帧 [${rec.groups.total.min}–${rec.groups.total.max}] 中位 ${rec.groups.total.median}（对参照 ${JSON.stringify(rec.groups.total.ratioToNone)}）` +
      `  |  参照 ${rec.groups.none.n}帧 [${rec.groups.none.min}–${rec.groups.none.max}] 中位 ${rec.groups.none.median}` +
      `  |  反侧 ${rec.groups.antisolar.n}帧 [${rec.groups.antisolar.min}–${rec.groups.antisolar.max}] 中位 ${rec.groups.antisolar.median}（对参照 ${JSON.stringify(rec.groups.antisolar.ratioToNone)}）`,
  );
}
out.errors = errors.slice(0, 8);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("written", OUT);
await ctx.close();
await browser.close();
server.close();
