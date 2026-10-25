/**
 * 月食的几何判据 —— 门·time 的唯一判据（1.3.4）。
 *
 * 旧判据是 `daysOf(next) >= DAYS_PER_YEAR`（store.ts 里那行），它测的其实是**钟面读数**：
 * 界面「设定时刻 → +1 年」一步就能把读数从第 0 天推到第 365.25 天，门当场亮 —— 玩家没等过一年。
 * 现在判的是画面上真会发生的事：**月球的圆面有没有和地球本影的圆面相交**，
 * 以及 t13 追加的那半句：**进入本影那一刻月球被选中**（没有那半句，零输入也会亮，见 timeGateWitnessed）。
 *
 * 本文件是纯函数：没有 three.js、没有 store、没有 window/localStorage。
 * 输入三个球的位置与半径（加一个"选中了谁"的字符串），输出一次判定；同一份输入永远同一个结论。
 * 唯一的依赖是 data.ts 的数值（半径 / 轨道半径 / 周期 / 相位），一个都不在这里重写。
 *
 * ── 本影锥从数据现算，不另存常量 ───────────────────────────────
 *   s        = (R_sun − R_earth) / |earth − sun|        本影锥斜率（沙盘数据下 = 3.04 / 15.2 = 0.2）
 *   r(d)     = (R_earth − s·d) / √(1 − s²)              轴距 d 处的本影半径
 *
 * 精确内公切线与 data.ts（月球那段注释）的近似式只差一个常数因子：
 * 近似式 `0.76 − 1.95 × 0.2 = 0.37`；精确式给 0.3776，比值 1/√(1−0.2²) = 1.0206。
 * 判据取精确式：它在锥尖 d = R_earth / s = 3.8 处恰好归零，和近似式同一个零点 ——
 * 也就是说这个修正**不引入第二个魔数**，只是把"锥面"当成锥面而不是弦。
 *
 * ── 什么情况会推翻这个判据 ─────────────────────────────────────
 *  1. **沙盘不再共面**（system-context.tsx 的 `look.flatOrbits` 改 false，或 SolarCanvas 的
 *     `inc` 分支换写法）→ `sandboxEclipseGeometry` 必须同步，否则判据算的是屏幕上没有的几何。
 *     今天两种口径都命中（data.ts 算过：倾角偏移 0.17 < 本影 0.37，每次冲日都进影），
 *     所以这个坑现在不咬人；一旦地月距/半径/倾角改了，第一个咬的就是这里。
 *  2. **轨道参数化改口径**（SolarCanvas 的 Simulation 从正圆换成六根数）→ 同上，几何要重对齐。
 *  3. **地月之外多一颗绕地球的天体**：本文件写死只看 `BODY_BY_ID.moon`。
 *  4. **判定口径从"偏食接触"改成"全食"**：门会晚亮 2·R_moon / 相对角速度 ≈ 0.19 模拟秒
 *     （全食判据是 margin ≥ 2·R_moon，见 EclipseVerdict.total）。
 *  5. **月食频率高到不用看也会亮**：实测 8× 下每 7.54 实秒一次、每次 0.75 实秒
 *     （模拟侧：进入 0.7515 / 脱离 1.0455 / 下一次进入 3.7225，周期 2.971 模拟秒）。
 *     t13 已经挡掉最便宜的那一半（要求"进入那一刻月球被选中"）；还剩下的那一半是
 *     "选中了但没在看画面"，要相机 / 视锥信息，属渲染域，1.4.0 再谈。
 */

import { BODY_BY_ID } from "./data.ts";

/** 三维点。刻意不用 three 的 Vector3：本文件要能被 node 直接 import（见 scripts/gate-predicate.test.mjs）。 */
export type Point3 = { x: number; y: number; z: number };

/** 一个参与遮挡的球：球心 + 半径。 */
export type ShadowSphere = { center: Point3; radius: number };

/** 判定一次月食需要的全部几何。三个球都在**同一个坐标系**里（沙盘是世界单位）。 */
export type EclipseGeometry = { sun: ShadowSphere; earth: ShadowSphere; moon: ShadowSphere };

/**
 * `none` = 没碰到本影；`partial` = 月球圆面与本影相交（月偏食，含只擦到边）；
 * `total` = 整个圆面都在本影里（月全食）。门只认 `none` 与否 —— 其余两种都是"看见了月食"。
 */
export type EclipsePhase = "none" | "partial" | "total";

export type EclipseVerdict = {
  phase: EclipsePhase;
  /** `phase !== "none"` 的简写：门的判据就看这一个布尔值。 */
  hit: boolean;
  /** 月球球心沿**背光轴**的距离（<= 0 = 还在太阳这一侧，谈不上进影）。 */
  axisDistance: number;
  /** 月球球心到影子轴的垂直距离。 */
  separation: number;
  /** 该轴距处的本影半径（<= 0 = 已越过本影锥尖，再远根本没有本影）。 */
  umbraRadius: number;
  /** 余量 = 本影半径 + 月球半径 − 垂距。> 0 才算碰到本影，0 是相切。 */
  margin: number;
};

const TAU = Math.PI * 2;

/**
 * 没命中时的返回值。四个数**原样带回**（`margin` 也是同一个公式
 * `本影半径 + 月球半径 − 垂距`，不是另一个算法）——
 * 判据在"没命中"这一侧也要能被断言读懂，否则断言只能读布尔值，
 * 边界两侧的余量就说不清是 +1e-9 还是 −0.2。
 */
function none(axisDistance: number, separation: number, umbraRadius: number, margin: number): EclipseVerdict {
  return { phase: "none", hit: false, axisDistance, separation, umbraRadius, margin };
}

/**
 * 本影锥斜率 s = (R_sun − R_earth) / D。
 * 沙盘数据（data.ts）下 = (3.8 − 0.76) / 15.2 = 0.2，与月球那段注释里的"本影锥斜率 0.2"同一个数。
 * D 退化（地球压在太阳上）时返回 NaN：调用方据此放弃判定，而不是拿 0 除以 0 得出一条假结论。
 */
export function umbraSlope(sunRadius: number, earthRadius: number, sunEarthDistance: number): number {
  if (!(sunEarthDistance > 0)) return Number.NaN;
  return (sunRadius - earthRadius) / sunEarthDistance;
}

/**
 * 轴距 d 处的本影半径（精确内公切线）。
 * `(R_earth − s·d)` 是"把锥面当弦"的近似；除以 √(1 − s²) 才是真正的锥面。
 * 两者在 d = R_earth/s（锥尖）处同时归零，所以这不是又一条近似，是同一个几何的精确解。
 */
export function umbraRadiusAtDistance(earthRadius: number, slope: number, axisDistance: number): number {
  const norm = Math.sqrt(Math.max(0, 1 - slope * slope));
  if (!(norm > 0)) return 0; // s ≥ 1：太阳没有比地球大，压根没有本影
  return (earthRadius - slope * axisDistance) / norm;
}

/**
 * 相切带（世界单位）。浮点算不出"正好相切"：同一条边界的两个算法最后一位就能差 3e-16，
 * 判据在边界上抖，玩家就会看到"门亮了/没亮"取决于哪一帧。所以相切**明确算没进影**，
 * 带宽 1e-12 世界单位 ≈ 1.7e-5 米（地球半径 12742 km 对 0.76 世界单位换算），
 * 比月球圆面（0.2）小 11 个数量级 —— 它只用来吞掉浮点噪声，不是一条物理容差。
 */
export const ECLIPSE_TANGENT_EPS = 1e-12;

/**
 * 一次月食判定。**纯几何**：不读钟、不读存档、不看谁点过什么。
 *
 * 边界口径（三处都写死，改任一处都要回来改这里和断言）：
 *  - 相切（margin ≤ 1e-12）算**没进影**。边界点归"没看见"，
 *    否则判据会在浮点的 ±1 ulp 上抖，而玩家看到的是"擦着边过去"。
 *  - `axisDistance <= 0` 一律算没进影：月球在太阳这一侧是新月，地球挡不到它。
 *  - 输入退化（三球重合、半径非正）算**没看见**：宁可漏判一次，也不要让门在一堆 NaN 上点亮。
 */
export function lunarEclipse(geometry: EclipseGeometry): EclipseVerdict {
  const { sun, earth, moon } = geometry;
  const ex = earth.center.x - sun.center.x;
  const ey = earth.center.y - sun.center.y;
  const ez = earth.center.z - sun.center.z;
  const sunEarth = Math.sqrt(ex * ex + ey * ey + ez * ez);
  // 退化输入：三个数都是 0（"不知道"），不拿 NaN 去参与任何比较
  if (!(sunEarth > 0) || !(earth.radius > 0) || !(moon.radius > 0)) return none(0, 0, 0, 0);

  // 背光轴：从太阳指向地球的方向。影子沿它延伸。
  const ux = ex / sunEarth;
  const uy = ey / sunEarth;
  const uz = ez / sunEarth;

  const rx = moon.center.x - earth.center.x;
  const ry = moon.center.y - earth.center.y;
  const rz = moon.center.z - earth.center.z;
  const axisDistance = rx * ux + ry * uy + rz * uz;
  // 垂距用 |r|² − (r·u)² 算，不用 acos：月球几乎压在轴上时 acos 会丢精度（sep ~ 1e-9 那一段）
  const separation = Math.sqrt(Math.max(0, rx * rx + ry * ry + rz * rz - axisDistance * axisDistance));

  const slope = umbraSlope(sun.radius, earth.radius, sunEarth);
  const umbraRadius = umbraRadiusAtDistance(earth.radius, slope, axisDistance);
  const margin = umbraRadius + moon.radius - separation;

  if (!(axisDistance > 0) || !(umbraRadius > 0) || !(margin > ECLIPSE_TANGENT_EPS)) {
    return none(axisDistance, separation, umbraRadius, margin);
  }
  // 全食：sep + R_moon ≤ r ⇔ margin ≥ 2·R_moon。等号算全食（整个圆面刚好装满本影）
  const phase: EclipsePhase = margin >= moon.radius * 2 ? "total" : "partial";
  return { phase, hit: true, axisDistance, separation, umbraRadius, margin };
}

/**
 * 沙盘在 `t`（模拟秒）时刻的三球几何。
 *
 * 公式与 `SolarCanvas.tsx` 的 Simulation **逐字对齐**，那里是屏幕上位置的真值：
 *
 *   轨道角 θ = t / period · 2π + phase
 *   本体系位置 (cos θ · R,  sin(inc) · sin θ · R,  cos(inc) · sin θ · R)
 *
 * 两处口径的来源，都写在别处，这里只引用不改写：
 *  - 沙盘 `look.flatOrbits = true`（system-context.tsx 的 SOL_SYSTEM）⇒ `inc = 0`，所有轨道共面；
 *    共面就是"几何被挤没了"的那一半：月球每次冲日都精确落在影子轴上。
 *  - 月球 `orbitFrame: "ecliptic"`（data.ts）⇒ 它挂在母天体**倾角层外面**，
 *    地球的 23.4° 自转轴不带着它斜；太阳在地心（orbitRadius = 0，组位置不写）。
 */
export const SANDBOX_FLAT_ORBITS = true;

export function sandboxEclipseGeometry(t: number): EclipseGeometry {
  const sun = BODY_BY_ID.sun;
  const earth = BODY_BY_ID.earth;
  const moon = BODY_BY_ID.moon;

  const earthAngle = (t / earth.period) * TAU + earth.phase;
  const earthX = Math.cos(earthAngle) * earth.orbitRadius;
  const earthZ = Math.sin(earthAngle) * earth.orbitRadius;

  const moonAngle = (t / moon.period) * TAU + moon.phase;
  const localX = Math.cos(moonAngle) * moon.orbitRadius;
  const localZ = Math.sin(moonAngle) * moon.orbitRadius;
  const inc = SANDBOX_FLAT_ORBITS ? 0 : moon.inclination;

  return {
    sun: { center: { x: 0, y: 0, z: 0 }, radius: sun.radius },
    earth: { center: { x: earthX, y: 0, z: earthZ }, radius: earth.radius },
    moon: {
      center: {
        x: earthX + localX,
        y: Math.sin(inc) * localZ,
        z: earthZ + Math.cos(inc) * localZ,
      },
      radius: moon.radius,
    },
  };
}

export function sandboxEclipse(t: number): EclipseVerdict {
  return lunarEclipse(sandboxEclipseGeometry(t));
}

/**
 * 采样步长（模拟秒）。实测食长 0.294 模拟秒（进入 0.7515 → 脱离 1.0455），
 * 步长取它六分之一：一段月食至少被 5 个采样点穿过。
 */
export const ECLIPSE_SAMPLE_STEP = 0.05;

/**
 * 一段推进里第一次"进入本影"的模拟时刻；这段里没有进入就返回 `null`。
 *
 * 与 `eclipseWitnessed` 同一套采样（那条函数的判据就是它 `!== null`）。
 * 单独把时刻交出来，是为了让门·time 的判据能说清楚"哪一帧算目击"，断言也能钉住那个数字。
 *
 * **返回的是"第一个判为在影里的采样点"，不是解析解**：精度 = 跨度 / 采样数。
 * 一帧的跨度（8× 下 0.0066）⇒ 采样数 1、精度就是一帧；跨度 0.7 模拟秒 ⇒ 步长 0.05。
 * 别拿它当亚帧计时器，它的用途是"这次是不是目击"，不是测时刻。
 *
 * 什么情况会推翻它：
 *  - **单帧跨度超过半个食长（≈0.147 模拟秒）**：采样可能跨过整段月食。今天 8× 下每帧
 *    0.0066 模拟秒（0.0167 实秒 × 0.394 模拟秒/实秒），留了 22 倍余量；
 *    把 SPEED_MAX 抬到 100× 之前先回来看这条。
 *  - **采样上限 16**：跨度超过 0.8 模拟秒时步长被拉大（0.8 / 16 = 0.05 正好是步长，
 *    再大就粗了）。这一档只有人为调 advanceSim(大 dt) 才会出现，连续推进永远到不了。
 */
export function eclipseEntry(fromSimSeconds: number, toSimSeconds: number): number | null {
  if (!Number.isFinite(fromSimSeconds) || !Number.isFinite(toSimSeconds)) return null;
  if (!(toSimSeconds > fromSimSeconds)) return null;

  const span = toSimSeconds - fromSimSeconds;
  const samples = Math.min(16, Math.max(1, Math.ceil(span / ECLIPSE_SAMPLE_STEP)));
  let inside = sandboxEclipse(fromSimSeconds).hit;
  for (let i = 1; i <= samples; i++) {
    const t = fromSimSeconds + (span * i) / samples;
    const now = sandboxEclipse(t).hit;
    if (now && !inside) return t;
    inside = now;
  }
  return null;
}

/**
 * 一段推进里有没有"目击到进入本影"。`from` 是上一帧的模拟时间，`to` 是这一帧的。
 *
 * **判"进入"而不是"在里面"**：跳变（setSimTime）之后的第一帧就可能落在影里，
 * 那时"在里面"会把一次跳当成目击。要求相邻两次采样从外到内，跳变就制造不出这个事件
 * （跳变不经过本函数 —— 见 store 的 setSimTime / advanceSim 分工）。
 *
 * 采样余量与推翻条件在 `eclipseEntry` 里写着，这里不重写一遍。
 */
export function eclipseWitnessed(fromSimSeconds: number, toSimSeconds: number): boolean {
  return eclipseEntry(fromSimSeconds, toSimSeconds) !== null;
}

/* ═══════════════ 三条门的判据（t13 / t19） ═══════════════
 *
 * 三条门共用**一份**选中态读法（`GateWatch`），不要各写一份 —— 各写一份的后果是
 * "点出来的选中"和"URL 带出来的选中"在不同门上有不同的解释，玩家看到的是三套规则。
 *
 * 判据全部是纯函数：输入 store 里已经有的东西（选中了谁、这段推进的起止、图层开没开、
 * 已经看了多久），输出布尔值或新的累计值。没有 window、没有 store、没有相机。
 */

/**
 * 选中态读法。`selectedId` 是 store 的选中天体；`fromGesture` 说的是
 * **这次选中是不是玩家手势引起的**（URL 深链 `?body=moon` 也会设 selectedId，但那不是行为）。
 *
 * 为什么门必须看第二个字段：零交互走一条链接就能点亮，四把尺子第 1 条（能不能失败）当场不通过。
 * 谁决定 `fromGesture`：store 的 `select` 在**调用那一刻**看页面上有没有发生过指针/键盘/滚轮事件
 * （见 store.ts 的 gestureSeen）。这里只消费那个布尔，不再自己猜。
 */
export type GateWatch = { selectedId: string | null; fromGesture: boolean };

/**
 * 门·time 要玩家盯着看的那个天体（t13）。
 *
 * 为什么是月球：月食是月球上的可观测事件（它变暗、变红），跟着月球看才看得见。
 */
export const TIME_GATE_TARGET = "moon";

/**
 * 门·time 的完整判据（t13）：**这段推进里有一次"进入本影"，那一刻月球被玩家选中**。
 *
 * 为什么必须有后半句：`eclipseWitnessed` 只说"月食发生了"，不说"有人在看"。
 * 沙盘默认 8×，开局约 1.9 实秒就发生第一次月食 —— 只判几何的话，零输入的玩家会拿到
 * 一盏自己亮的灯，四把尺子第 1 条（能不能失败）当场不通过。选中是一次玩家动作，
 * 也确实是"跟着月球看"的前提（选中会带镜头过去）。
 *
 * 口径（三处都写死，改任一处都要回来改断言）：
 *  - 只看**进入那一帧**的选中态。进入之后再选中、或进入之后取消选中，都不改结论 ——
 *    前者是"没看着它进去"，后者是"已经看见了"，两种都不是误判。
 *  - 选中地球不算：`TIME_GATE_TARGET` 是月球，别把"选中母行星"当成"看着月球"。
 *  - `fromGesture` 为假（深链带出来的选中）不算：URL 不是行为。
 *
 * 什么情况会推翻它：
 *  - **选中了但没在看**（切窗口、面板盖住画面）：本判据不管，它只是"目击"的最弱一档。
 *    要管就得有相机 / 视锥信息，属渲染域，1.4.0 再谈。
 *  - **手势检测被自动化骗过**：`fromGesture` 的来源是"页面上出现过 pointerdown/keydown/wheel"，
 *    脚本模拟点击同样满足。要让门对夹具也严格，得让 App 的深链调用显式传来源标记。
 */
export function timeGateWitnessed(
  fromSimSeconds: number,
  toSimSeconds: number,
  watch: GateWatch,
): boolean {
  if (watch.selectedId !== TIME_GATE_TARGET || !watch.fromGesture) return false;
  return eclipseEntry(fromSimSeconds, toSimSeconds) !== null;
}

/** 门·target 要观察的天体：水星（沙盘模型里公转周期最短的那颗）。 */
export const TARGET_GATE_BODY = "mercury";

/**
 * 一整圈 = 2π 轨道角要走多久。
 *
 * 沙盘是**正圆、角速度恒定**（SolarCanvas 的 `(t / period) · 2π + phase`，t24 定的），
 * 所以累积角 = 累积时间 × 2π / period ⇒ 满 2π 恰好就是满一个 `period`。
 * 水星的 period = 8.2 模拟秒，8× 下 = 8.2 / 0.39425 ≈ 20.8 实秒。
 *
 * 什么情况会推翻它（**换成椭圆或开普勒就必须回来改**）：
 *  - 角速度不再恒定（实境的六根数、或沙盘哪天换椭圆）⇒ "累积时间" 不等于 "累积角"，
 *    这里必须改成真的积分轨道角（`∫ dθ/dt dt`），否则门会按"时间"亮而不是按"转完一圈"亮。
 *  - 有人改了 `data.ts` 的 mercury.period：这里跟着变，注释里的 20.8 实秒要重算。
 */
export const TARGET_GATE_ORBIT_SECONDS = BODY_BY_ID[TARGET_GATE_BODY].period;

/**
 * 门·target 的累积器（纯函数）：**只看"水星被玩家选中"的那几段**。
 *
 * 返回新的累计模拟秒数：
 *  - 选中水星 + 玩家自己选的 + 时间在前进 ⇒ 累加 `dtSimSeconds`；
 *  - 选中别的天体、或这条选中是 URL 带出来的 ⇒ **归零**（换目标就是"没在看了"，从头来）；
 *  - 暂停 / 时间没前进（dt ≤ 0）⇒ 保留原值（暂停不该把已经看的时长作废）。
 *
 * 什么情况会推翻它：
 *  - **dt 是"模拟秒"，不是实秒**：传成实秒会让 8× 下的门亮得快 2.5 倍。
 *  - **选中的连续性是靠每帧调用维持的**：如果哪天 advanceSim 不再每帧调它（比如改成事件驱动），
 *    "换目标归零"就只在事件发生时生效，中间那些帧的归属要重新想。
 */
export function accumulateTargetWatch(
  previousSimSeconds: number,
  dtSimSeconds: number,
  watch: GateWatch,
): number {
  if (watch.selectedId !== TARGET_GATE_BODY || !watch.fromGesture) return 0;
  const previous = Number.isFinite(previousSimSeconds) ? Math.max(0, previousSimSeconds) : 0;
  if (!Number.isFinite(dtSimSeconds) || dtSimSeconds <= 0) return previous;
  return previous + dtSimSeconds;
}

/** 门·target：真的看水星跑满了一整圈（累积轨道角 ≥ 2π）。 */
export function targetGateWitnessed(watchedSimSeconds: number): boolean {
  return watchedSimSeconds >= TARGET_GATE_ORBIT_SECONDS;
}

/**
 * 门·layer：**名称与轨道都不在**，且这一次选中是玩家自己点的一颗**行星**。
 *
 * 为什么不是"关掉两个开关就亮"（t19 前的口径）：那是"摸过控件"。文案问的是
 * "名称与轨道都不在，还认得出谁" —— 认得出，是能在没有名字和轨道线的画面上选出那颗天体。
 * 所以判据点的是"关掉之后还选得中"，而开关本身一次都不算。
 *
 * 口径（三条都写死）：
 *  - 只认 `parent === "sun"` 的行星；太阳不算（不靠轨道线也认得出，它是中心那颗），
 *    卫星也不算（卫星行要先选中母行星才出现，那时门已经该亮了）。
 *  - 顺带：选中之后再把图层打开**不会撤销**已亮的格 —— 门只看点亮那一刻。
 *  - `fromGesture` 为假不算：`?body=earth` 这种链接带出来的选中不是行为
 *    （尤其是图层开关会被持久化，玩家早就关好了，光开链接就能白拿）。
 */
export function layerGateWitnessed(
  watch: GateWatch,
  labelsVisible: boolean,
  orbitsVisible: boolean,
): boolean {
  if (labelsVisible || orbitsVisible) return false;
  if (!watch.fromGesture) return false;
  const body = watch.selectedId === null ? undefined : BODY_BY_ID[watch.selectedId];
  return Boolean(body && body.parent === "sun");
}
