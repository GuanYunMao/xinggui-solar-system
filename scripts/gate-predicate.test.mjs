#!/usr/bin/env node
/**
 * 门·time 的判据断言（1.3.4）—— 直接 node 跑，不需要浏览器、不需要构建。
 *
 *   node scripts/gate-predicate.test.mjs
 *
 * 断两件事：
 *  ① **判据**：`src/solar/observe.ts` 的月食几何 —— 命中 / 未命中 / 掠食边界 三例，
 *     外加"本影锥是从 data.ts 现算的、不是拍出来的"这条数字关系；
 *  ② **槽位表**：`GATE_SLOTS` 只有 store 里真有 `hitGate("…")` 调用的槽位，
 *     短码 v2 往返、老 v1 码被明确拒收、保留位被拒收。
 *
 * 为什么这份脚本能 `import` TS：Node 24 的类型剥离 + 两个模块都只写"能被剥掉"的语法
 * （observe.ts 的 import 带 `.ts` 后缀，gate.ts 一个 import 都没有）。
 * store.ts 进不来（它 import "./gate" 这种无扩展名写法，Node 解析不了），
 * 所以"8× 自然推进点亮门"那一层在浏览器里验（见 t3 报告的实测），这里只验它依赖的算术。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ECLIPSE_SAMPLE_STEP,
  TARGET_GATE_ORBIT_SECONDS,
  TIME_GATE_TARGET,
  accumulateTargetWatch,
  eclipseEntry,
  eclipseWitnessed,
  layerGateWitnessed,
  lunarEclipse,
  sandboxEclipse,
  sandboxEclipseGeometry,
  targetGateWitnessed,
  timeGateWitnessed,
  umbraRadiusAtDistance,
  umbraSlope,
} from "../src/solar/observe.ts";
import {
  GATE_REQUIRED,
  GATE_SLOTS,
  GATE_VERSION,
  canonicalSlots,
  crc8,
  decodeGate,
  encodeGate,
  normalizeGate,
} from "../src/solar/gate.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
let bad = 0;
let total = 0;
const ok = (cond, msg) => {
  total++;
  if (!cond) bad++;
  console.log(`${cond ? "[ok]  " : "[FAIL]"} ${msg}`);
};
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}（实测 ${a} vs 期望 ${b} ±${tol}）`);

console.log(`\n=== ① 本影锥：从 data.ts 现算，不是拍的 ===\n`);
{
  const g = sandboxEclipseGeometry(0);
  const sunEarth = Math.hypot(g.earth.center.x - g.sun.center.x, g.earth.center.z - g.sun.center.z);
  const slope = umbraSlope(g.sun.radius, g.earth.radius, sunEarth);
  near(sunEarth, 15.2, 1e-9, "日地距（太阳在地心 + 地球轨道半径 15.2）");
  near(slope, 0.2, 1e-12, "本影锥斜率 = (R_sun − R_earth) / 日地距 = 3.04 / 15.2");

  const exact = umbraRadiusAtDistance(g.earth.radius, slope, 1.95);
  const linear = g.earth.radius - slope * 1.95;
  near(linear, 0.37, 1e-12, "data.ts 注释里的近似式 0.76 − 1.95×0.2");
  near(exact, 0.3776297, 1e-6, "精确内公切线在月球轨道处的本影半径");
  const ratio = exact / linear;
  near(ratio, 1 / Math.sqrt(1 - slope * slope), 1e-12, "两个式子的比值 = 1/√(1−s²)");
  near(ratio, 1.0206207, 1e-6, "比值数值（差 2%，不是新魔数，是同一几何）");
  near(umbraRadiusAtDistance(g.earth.radius, slope, g.earth.radius / slope), 0, 1e-12, "锥尖处本影半径归零（和近似式同一零点）");
}

console.log(`\n=== ② 命中：8× 自然推进那一次 ===\n`);
{
  // 扫描沙盘 8 模拟秒：进入 / 脱离 / 周期 / 食长（0.0005 步长，比判据自己的采样细 100 倍）
  const step = 0.0005;
  const entries = [];
  const exits = [];
  let prev = sandboxEclipse(0).hit;
  for (let t = step; t <= 8; t += step) {
    const now = sandboxEclipse(t).hit;
    if (now && !prev) entries.push(t);
    if (!now && prev) exits.push(t);
    prev = now;
  }
  ok(entries.length >= 3, `8 模拟秒里至少 3 次月食（实测 ${entries.length} 次）`);
  const first = entries[0];
  const firstExit = exits[0];
  const cycle = entries[1] - entries[0];
  const length = firstExit - first;
  near(first, 0.7515, 2e-3, "第一次进入本影的模拟时刻");
  near(length, 0.294, 3e-3, "食长（进入 → 脱离，模拟秒）");
  near(cycle, 2.971, 3e-3, "相邻两次月食的间隔（模拟秒）");

  // 影子轴上那一刻：月球正在地球背后（共面 ⇒ 垂距压到 0）
  const middle = (first + firstExit) / 2;
  const verdict = sandboxEclipse(middle);
  ok(verdict.hit, `食甚 t=${middle.toFixed(4)} 命中`);
  ok(verdict.phase === "total", `食甚判全食（实测算 ${verdict.phase}，垂距 ${verdict.separation.toExponential(2)}）`);
  ok(verdict.separation < 1e-2, `食甚垂距 < 0.01（实测 ${verdict.separation.toExponential(3)} —— 共面 ⇒ 每次冲日都精确落在影轴）`);
  ok(verdict.margin > 0, `食甚余量 > 0（实测 ${verdict.margin.toFixed(4)} 世界单位）`);

  // store 的那两行算术：advanceSim 连续推进 → eclipseWitnessed(first-1, ...) 应当命中
  ok(eclipseWitnessed(first - 0.01, first + 0.01), "跨过进入点的一段推进被判为目击");
  ok(!eclipseWitnessed(first - 0.5, first - 0.01), "食前那一段推进不算目击");
  ok(!eclipseWitnessed(first - 1, first - 0.5), "更早的一段也不算");

  // 8× 帧步长 vs 食长：判据能看见它的余量
  const simPerRealSecond = 8 * (18 / 365.25);
  const perFrame = simPerRealSecond * (1 / 60);
  near(simPerRealSecond, 0.39425, 1e-5, "8× 时 1 实秒推进的模拟秒数（8 × 18/365.25）");
  near(perFrame, 0.006571, 1e-6, "8× / 60fps 每帧推进的模拟秒数");
  ok(perFrame < length / 2, `帧步长 ${perFrame.toFixed(4)} 远小于半个食长 ${(length / 2).toFixed(4)}（留了 ${(length / 2 / perFrame).toFixed(0)} 倍余量）`);
  ok(ECLIPSE_SAMPLE_STEP < length / 4, `采样步长 ${ECLIPSE_SAMPLE_STEP} 小于四分之一食长`);
}

console.log(`\n=== ③ 未命中：三种"看着像但没有" ===\n`);
{
  // (a) 上弦/下弦位置：月球与背光轴成 90°，垂距 = 地月距
  const quadrature = lunarEclipse({
    sun: { center: { x: 0, y: 0, z: 0 }, radius: 3.8 },
    earth: { center: { x: 15.2, y: 0, z: 0 }, radius: 0.76 },
    moon: { center: { x: 15.2, y: 0, z: 1.95 }, radius: 0.2 },
  });
  ok(!quadrature.hit && quadrature.phase === "none", `弦月不进影（垂距 ${quadrature.separation.toFixed(3)} > 本影 ${quadrature.umbraRadius.toFixed(3)}）`);
  near(quadrature.axisDistance, 0, 1e-12, "弦月的轴向距离正好 0");

  // (b) 新月：在太阳这一侧，轴距为负 —— 就算垂距 0 也不是月食
  const newMoon = lunarEclipse({
    sun: { center: { x: 0, y: 0, z: 0 }, radius: 3.8 },
    earth: { center: { x: 15.2, y: 0, z: 0 }, radius: 0.76 },
    moon: { center: { x: 15.2 - 1.95, y: 0, z: 0 }, radius: 0.2 },
  });
  ok(!newMoon.hit, `新月（垂距 0、轴距 ${newMoon.axisDistance.toFixed(3)} < 0）不算进影`);

  // (c) 「+1 年」的落点：第 365.25 天 = 18 模拟秒，月球不在影里
  const landed = sandboxEclipse(18);
  ok(!landed.hit, `+1 年落点 t=18 未命中（垂距 ${landed.separation.toFixed(4)}，本影 ${landed.umbraRadius.toFixed(4)}）`);
  ok(!eclipseWitnessed(18, 18.02), "跳到 t=18 之后的头一帧不算目击（跳变制造不出'进入'）");
}

console.log(`\n=== ④ 掠食边界：相切算没进影 ===\n`);
{
  // 地月距处本影半径 + 月球半径 = 触到边界的垂距
  const slope = 0.2;
  const umbra = umbraRadiusAtDistance(0.76, slope, 1.95);
  const moonRadius = 0.2;
  const edge = umbra + moonRadius;
  const place = (separation) =>
    lunarEclipse({
      sun: { center: { x: 0, y: 0, z: 0 }, radius: 3.8 },
      earth: { center: { x: 15.2, y: 0, z: 0 }, radius: 0.76 },
      moon: { center: { x: 15.2 + 1.95, y: 0, z: separation }, radius: moonRadius },
    });

  const inside = place(edge - 1e-9);
  ok(inside.hit && inside.phase === "partial", `差 1e-9 在影内 → 偏食命中（余量 ${inside.margin.toExponential(2)}）`);
  const barely = place(edge - 1e-6);
  ok(barely.hit, `差 1e-6 在影内 → 命中（余量 ${barely.margin.toExponential(2)}）`);
  const tangent = place(edge);
  ok(!tangent.hit, `正好相切（余量 ${tangent.margin.toExponential(2)}，落在相切带 ±1e-12 内）→ 不算命中`);
  const outside = place(edge + 1e-9);
  ok(!outside.hit, `差 1e-9 在影外 → 未命中（余量 ${outside.margin.toExponential(2)}）`);
  ok(tangent.separation > tangent.umbraRadius, `相切时垂距在本影之外（${tangent.separation.toFixed(6)} > ${tangent.umbraRadius.toFixed(6)}）`);
}

console.log(`\n=== ⑤ 门·time 要「选中月球」才算（t13）===\n`);
{
  ok(TIME_GATE_TARGET === "moon", `门要看的天体 = ${TIME_GATE_TARGET}`);
  const watched = (selectedId) => ({ selectedId, fromGesture: true });
  const fromUrl = (selectedId) => ({ selectedId, fromGesture: false });

  // 同一段推进，只改"选中了谁"：这是 t13 修的那个洞的正面/反面
  // 真进入点是 18.5769（0.0005 步长扫出来的）；eclipseEntry 返回**第一个在影里的采样点**，
  // 0.7 的跨度 ⇒ 步长 0.05，所以它落在 [18.5769, 18.6270) 都算对。
  const entry = eclipseEntry(18, 18.7);
  ok(
    entry !== null && entry >= 18.5769 - 1e-6 && entry <= 18.5769 + 0.0505,
    `区间 [18, 18.7] 里第一次判为进影的采样点 t=${entry?.toFixed(4)}（真进入点 18.5769，步长 0.05）`,
  );
  const atEntry = entry === null ? null : sandboxEclipse(entry);
  ok(atEntry?.phase === "partial", `进入那一帧的相位 = ${atEntry?.phase}（刚接触，本就该是偏食）`);
  ok(timeGateWitnessed(18, 18.7, watched(null)) === false, "未选中任何人 → 门不亮（冷启动就是这个状态）");
  ok(timeGateWitnessed(18, 18.7, watched("earth")) === false, "选中地球而不是月球 → 门不亮（母行星不算“看着月球”）");
  ok(timeGateWitnessed(18, 18.7, watched("mercury")) === false, "选中别的天体 → 门不亮");
  ok(timeGateWitnessed(18, 18.7, watched(TIME_GATE_TARGET)) === true, "选中月球（手势）→ 门亮");
  ok(timeGateWitnessed(18, 18.7, fromUrl(TIME_GATE_TARGET)) === false, "选中月球但是 URL 带出来的 → 门不亮（t19：URL 不是行为）");

  // 冷启动那 10 实秒（8× ⇒ t ≈ 0 → 3.94）：几何上至少两次进入，但没人选中 ⇒ 不亮
  ok(sandboxEclipse(0.7515).hit && sandboxEclipse(3.7225).hit, "冷启动 10 实秒里月食发生两次（t=0.7515 / 3.7225）");
  ok(timeGateWitnessed(0, 3.94, watched(null)) === false, "同一段时间里没人选中 → 门保持未点亮（修的就是这个）");

  // 跳时不许回退：选中了月球，跳变后的第一帧仍然不亮（没有"进入"这段推进）
  ok(timeGateWitnessed(18, 18.02, watched(TIME_GATE_TARGET)) === false, "跳时后头一帧（已选中月球）→ 仍然不亮");

  // 已经在影里才选中：这一帧不算"进去"，要等下一次进入
  ok(sandboxEclipse(18.7).hit && timeGateWitnessed(18.65, 18.8, watched(TIME_GATE_TARGET)) === false,
    "影已经开始了才选中 → 不亮（只认“进入那一帧”，否则选中=白拿）");
}

console.log(`\n=== ⑥ 门·target：看水星跑完一整圈（t19）===\n`);
{
  // 阈值 = 水星的一个 period，也就是 2π 轨道角；沙盘是正圆、角速度恒定
  const orbitAngle = (t) => (t / 8.2) * Math.PI * 2 + 0.4; // 与 SolarCanvas 的 Simulation 同式（period 8.2 / phase 0.4）
  ok(Math.abs(TARGET_GATE_ORBIT_SECONDS - 8.2) < 1e-12, `一整圈 = 水星 period = ${TARGET_GATE_ORBIT_SECONDS} 模拟秒`);
  const swept = orbitAngle(TARGET_GATE_ORBIT_SECONDS) - orbitAngle(0);
  ok(Math.abs(swept - Math.PI * 2) < 1e-12, `这段时间恰好扫过 2π 轨道角（实测 ${swept.toFixed(12)}）`);
  const realSeconds = TARGET_GATE_ORBIT_SECONDS / (8 * (18 / 365.25));
  ok(realSeconds > 20 && realSeconds < 21.5, `8× 下需要看 ${realSeconds.toFixed(2)} 实秒（判据说"约 21 实秒"）`);

  const watch = (selectedId, fromGesture = true) => ({ selectedId, fromGesture });
  // 正例：水星被手势选中，时间在前进
  ok(accumulateTargetWatch(0, 4, watch("mercury")) === 4, "选中水星 + 手势 ⇒ 累积 4 模拟秒");
  const near = accumulateTargetWatch(8.1, 0.05, watch("mercury"));
  ok(Math.abs(near - 8.15) < 1e-9 && targetGateWitnessed(near) === false, `8.1 + 一帧 0.05 = ${near} → 还差一点，不亮`);
  ok(targetGateWitnessed(accumulateTargetWatch(near, 0.06, watch("mercury"))) === true, "再攒一帧越过 8.2 → 亮");
  // 反例：换目标 / URL 带出来 / 没选中
  ok(accumulateTargetWatch(6, 1, watch("venus")) === 0, "选中金星 ⇒ 归零（换目标就是没在看了）");
  ok(accumulateTargetWatch(6, 1, watch(null)) === 0, "没选中 ⇒ 归零");
  ok(accumulateTargetWatch(6, 1, watch("mercury", false)) === 0, "水星是 URL 带出来的选中 ⇒ 归零（?body=mercury 白拿不了）");
  // 暂停（dt ≤ 0）不作废已经看过的时长
  ok(accumulateTargetWatch(6, 0, watch("mercury")) === 6, "暂停一帧（dt=0）⇒ 保留 6，不清零");
  ok(accumulateTargetWatch(Number.NaN, 1, watch("mercury")) === 1, "上一帧的累计是 NaN ⇒ 当成 0 再加，不污染");
  // 阈值两侧
  ok(targetGateWitnessed(8.19) === false, "8.19 模拟秒（差一点）→ 不亮");
  ok(targetGateWitnessed(8.2) === true, "8.2 模拟秒（刚好一整圈）→ 亮");
  ok(targetGateWitnessed(0) === false && targetGateWitnessed(-3) === false, "0 和负数都不亮");
}

console.log(`\n=== ⑦ 门·layer：名称与轨道都不在，还选得中一颗行星（t19）===\n`);
{
  const watch = (selectedId, fromGesture = true) => ({ selectedId, fromGesture });
  ok(layerGateWitnessed(watch("mars"), false, false) === true, "两层都关 + 选中火星（手势）→ 亮");
  ok(layerGateWitnessed(watch("earth"), false, false) === true, "任意行星都行（地球）");
  ok(layerGateWitnessed(watch("mercury"), false, false) === true, "任意行星都行（水星）");
  ok(layerGateWitnessed(watch("mars"), true, false) === false, "名称还开着 → 不亮");
  ok(layerGateWitnessed(watch("mars"), false, true) === false, "轨道还开着 → 不亮");
  ok(layerGateWitnessed(watch("mars"), true, true) === false, "两层都开着 → 不亮");
  ok(layerGateWitnessed(watch("moon"), false, false) === false, "选中月球（卫星）不算 —— 卫星行本来就是靠母行星找出来的");
  ok(layerGateWitnessed(watch("sun"), false, false) === false, "太阳不算行星（它不靠轨道线也认得出）");
  ok(layerGateWitnessed(watch("mars", false), false, false) === false, "URL 带出来的选中不算（图层是持久化的，光开链接能白拿）");
  ok(layerGateWitnessed(watch(null), false, false) === false, "没选中 → 不亮");
  ok(layerGateWitnessed(watch("nope"), false, false) === false, "不存在的天体 id → 不亮，不炸");
}

console.log(`\n=== ⑧ 槽位表：只放可达的 ===\n`);{
  ok(GATE_SLOTS.length === 3, `槽位表 ${GATE_SLOTS.length} 个（期望 3）`);
  ok(
    JSON.stringify(GATE_SLOTS) === JSON.stringify(["time", "target", "layer"]),
    `槽位表内容 = ${JSON.stringify(GATE_SLOTS)}`,
  );
  ok(GATE_REQUIRED === 3, `解锁要求 ${GATE_REQUIRED} 格 = 全部可达格子`);
  ok(GATE_VERSION === 2, `短码 schema 版本 = ${GATE_VERSION}`);

  const storeText = readFileSync(path.join(ROOT, "src/solar/store.ts"), "utf8");
  const called = new Set([...storeText.matchAll(/hitGate\("([a-zA-Z]+)"\)/g)].map((m) => m[1]));
  ok(called.size > 0, `store.ts 里数到 ${called.size} 个不同的 hitGate 调用点：${[...called].join(" / ")}`);
  const missing = GATE_SLOTS.filter((slot) => !called.has(slot));
  ok(missing.length === 0, `槽位表里每一格都有写入点（缺：${missing.join(" / ") || "无"}）`);
  const orphan = [...called].filter((slot) => !GATE_SLOTS.includes(slot));
  ok(orphan.length === 0, `store 的每个 hitGate 调用都在槽位表里（多出：${orphan.join(" / ") || "无"}）`);

  // 子集往返：8 种组合，编码 → 解码 → 同一份槽位，unlocked 只由格数决定
  let roundTrip = 0;
  for (let mask = 0; mask < 1 << GATE_SLOTS.length; mask++) {
    const lit = GATE_SLOTS.filter((_, i) => mask & (1 << i));
    const code = encodeGate(lit, false);
    const back = decodeGate(code);
    const same = back.ok && JSON.stringify(back.slots) === JSON.stringify(canonicalSlots(lit));
    const unlockedOk = back.ok && back.unlocked === lit.length >= GATE_REQUIRED;
    if (same && unlockedOk) roundTrip++;
    else console.log(`        失败：${JSON.stringify(lit)} → ${code} → ${JSON.stringify(back)}`);
  }
  ok(roundTrip === 1 << GATE_SLOTS.length, `${roundTrip}/${1 << GATE_SLOTS.length} 种槽位组合往返一致`);

  ok(canonicalSlots(["time", "eclipse", "target"]).length === 2, "老槽位名 eclipse 被 canonicalSlots 丢掉（老存档/老码的残位不会复活）");

  // 老 v1 码：手搓一个（bits 0–11 是 12 槽位、version=1），必须报 version 而不是别的
  const v1Payload = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 13);
  const v1Check = crc8([v1Payload & 0xff, (v1Payload >>> 8) & 0xff, (v1Payload >>> 16) & 0xff]);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let payloadChars = "";
  for (let i = 0; i < 5; i++) payloadChars += alphabet[(v1Payload >>> (i * 5)) & 31];
  const v1Code = `XG1-${payloadChars}-${alphabet[v1Check & 31]}${alphabet[(v1Check >>> 5) & 7]}`;
  const v1Back = decodeGate(v1Code);
  ok(v1Back.ok === false && v1Back.reason === "version", `老的 12 槽短码 ${v1Code} → ${JSON.stringify(v1Back)}（明确说"来自别的版本"）`);
  ok(normalizeGate("xg1 " + payloadChars + " " + alphabet[v1Check & 31]) === `XG1${payloadChars}${alphabet[v1Check & 31]}`, "规范化照旧（大小写/空格/连字符）");

  // 保留位：bit 5 是 1.3.4 之前的老槽位位，现在必须拒收（哪怕校验是对的）
  const dirtyPayload = (1 << 0) | (1 << 5) | (GATE_VERSION << 13);
  const dirtyCheck = crc8([dirtyPayload & 0xff, (dirtyPayload >>> 8) & 0xff, (dirtyPayload >>> 16) & 0xff]);
  let dirtyChars = "";
  for (let i = 0; i < 5; i++) dirtyChars += alphabet[(dirtyPayload >>> (i * 5)) & 31];
  const dirtyCode = `XG1-${dirtyChars}-${alphabet[dirtyCheck & 31]}${alphabet[(dirtyCheck >>> 5) & 7]}`;
  const dirtyBack = decodeGate(dirtyCode);
  ok(dirtyBack.ok === false && dirtyBack.reason === "range", `保留位被置的码 ${dirtyCode} → ${JSON.stringify(dirtyBack)}`);

  // 校验先于保留位：拿一个**本版**的码翻掉校验字符，应当报 checksum（而不是 range/version）
  const goodCode = encodeGate([GATE_SLOTS[0], GATE_SLOTS[2]], false);
  const last = goodCode.at(-1);
  const bumped = alphabet[(alphabet.indexOf(last) + 1) & 31];
  const flippedBack = decodeGate(goodCode.slice(0, -1) + bumped);
  ok(
    flippedBack.ok === false && flippedBack.reason === "checksum",
    `本版码 ${goodCode} 把校验字符 ${last}→${bumped} → ${JSON.stringify(flippedBack)}`,
  );
}

console.log(`\n${bad === 0 ? `全部通过：${total} 条` : `失败 ${bad} 条 / 共 ${total} 条`}`);
process.exit(bad === 0 ? 0 : 1);
