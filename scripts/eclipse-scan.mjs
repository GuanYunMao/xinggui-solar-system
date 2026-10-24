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

const sample = async (id, t) => {
  await worldAt(t);
  const stable = await stableBody(id);
  if (!stable) return { available: false, reason: "candidates() 两次读数不一致（跳时刻后的不可信期）" };
  /*
   * 机位：**方位角固定 90°**（垂直于「天体→太阳」），只在仰角上找不穿模的那一档。
   *
   * 为什么不是"日向一侧（azimuth 0°）"：月食时太阳在地球背后，从月球朝太阳看那条线
   * **穿过地球**——相机直接落进球体，`candidates()` 把月球剔除 → `zero`/`minus` 组 n=0。
   * 而固定 90° 侧视的好处是：**跨相位的相角恒定**（始终是半明半暗），三组之间可直接比；
   * 日食时那一半也进阴影，整盘平均照样掉下来。
   */
  const placed = await page.evaluate(({ id, rPx, depth, fov }) => {
    const canvas = document.querySelector("canvas");
    const H = canvas.clientHeight;
    const tanHalf = Math.tan((fov * Math.PI) / 360);
    const rWorld = (rPx * depth * tanHalf * 2) / H;
    if (!(rWorld > 0)) return null;
    const dist = +(rWorld * 8.6).toFixed(5);
    for (const el of [0, 25, -25, 45]) {
      const r = window.__solarPlace(id, dist, 90, el);
      if (!r) continue;
      const cam = window.__solarCamera();
      const n = cam?.nearest;
      const inside = n && n.id !== id && n.dist < n.radius * 1.05;
      if (!inside) return { ...r, elevationDeg: el, valid: true, nearest: n ?? null };
    }
    return { valid: false, reason: "绕月球摆一圈都落在别的天体里" };
  }, { id, rPx: stable.r, depth: stable.d, fov: stable.fov });
  if (!placed) return { available: false, reason: "__solarPlace 返回 null（天体不在 registry 或相机未就绪）" };
  if (!placed.valid) return { available: false, reason: placed.reason };
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
  const buckets = { plus: [], minus: [], zero: [] };
  for (let t = 0; t <= SWEEP_END + 1e-9; t += SWEEP_STEP) {
    const tt = +t.toFixed(3);
    const pos = await worldAt(tt);
    const d = dotSunOcc(pos, id, occ);
    if (d === null) continue;
    const g = d > 0.9 ? "plus" : d < -0.9 ? "minus" : Math.abs(d) < 0.1 ? "zero" : null;
    if (g) buckets[g].push({ t: tt, dot: +d.toFixed(3) });
  }
  const pick = (arr) => {
    if (arr.length <= PER_GROUP) return arr;
    const step = (arr.length - 1) / (PER_GROUP - 1);
    return Array.from({ length: PER_GROUP }, (_, i) => arr[Math.round(i * step)]);
  };
  const rec = { pair: `${id}:${occ}`, groups: {} };
  for (const g of ["plus", "zero", "minus"]) {
    const chosen = pick(buckets[g]);
    const rows = [];
    for (const c of chosen) {
      const m = await sample(id, c.t);
      if (m.available && !m.insideOther) rows.push({ t: c.t, dot: c.dot, diskMean: m.diskMean, el: m.placed?.elevationDeg ?? null });
    }
    const v = rows.map((r) => r.diskMean).sort((a, b) => a - b);
    rec.groups[g] = {
      n: rows.length,
      min: v.length ? v[0] : null,
      max: v.length ? v[v.length - 1] : null,
      median: v.length ? v[Math.floor(v.length / 2)] : null,
      rows,
    };
  }
  const zeroMed = rec.groups.zero.median;
  for (const g of ["plus", "minus"]) {
    const b = rec.groups[g];
    b.ratioToZero = {
      min: zeroMed && b.min !== null ? +(b.min / zeroMed).toFixed(3) : null,
      max: zeroMed && b.max !== null ? +(b.max / zeroMed).toFixed(3) : null,
      median: zeroMed && b.median !== null ? +(b.median / zeroMed).toFixed(3) : null,
    };
  }
  out.pairs.push(rec);
  console.log(
    `${rec.pair}  plus ${rec.groups.plus.n}帧 [${rec.groups.plus.min}–${rec.groups.plus.max}] 中位 ${rec.groups.plus.median}（对参照 ${JSON.stringify(rec.groups.plus.ratioToZero)}）` +
      `  |  minus ${rec.groups.minus.n}帧 [${rec.groups.minus.min}–${rec.groups.minus.max}] 中位 ${rec.groups.minus.median}（对参照 ${JSON.stringify(rec.groups.minus.ratioToZero)}）` +
      `  |  zero 中位 ${zeroMed}`,
  );
}
out.errors = errors.slice(0, 8);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("written", OUT);
await ctx.close();
await browser.close();
server.close();
