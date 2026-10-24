/**
 * 开普勒轨道（t14）：六根数 → 位置，纯函数、不依赖 three、不依赖渲染层。
 *
 * 单位约定：长度**米**、时间**秒**、角度**弧度**。
 * 坐标系：黄道坐标系，J2000.0 春分点为 +X，黄道北极 +Z。
 * 历元：`simSeconds = 0` ↔ J2000.0（与 store 的 `SIM_EPOCH` 同源）；这一刻的
 * 平近点角就是 `M0`，之后 `M = M0 + n·t`。
 *
 * **全局只有一个时间系数**：周期由 `T = 2π√(a³/μ)` 导出，`μ` 取父天体的
 * GM（太阳用 `MU_SUN`；月球用地球 GM 加质量比，见 `MOON_MU`）。
 * 任何天体都不许手写自己的周期 —— `realBody()` 在数据层就用这个函数算，
 * 这样"周期"与"a"只有一份真相。
 */

/** 太阳的 GM（m³/s²），IAU 2015 / JPL DE440。 */
export const MU_SUN = 1.32712440018e20;
/** 地球的 GM（m³/s²），IAU 2015。 */
export const MU_EARTH = 3.986004418e14;
/** 月球质量 / 地球质量（两体公式里用 1 + m/M）。 */
export const MOON_MASS_RATIO = 1 / 81.3006;
/** 地月两体的 μ（绕共同质心）。 */
export const MOON_MU = MU_EARTH * (1 + MOON_MASS_RATIO);

/** 光速（m/s）。日心坐标下用不到，留着给以后的光行时修正。 */
export const C_LIGHT = 2.99792458e8;

export type OrbitalElements = {
  /** 半长轴（米） */
  a: number;
  /** 偏心率 */
  e: number;
  /** 轨道倾角（弧度），对黄道 */
  i: number;
  /** 升交点黄经（弧度） */
  om: number;
  /** 近日点幅角（弧度） */
  w: number;
  /** J2000 平近点角（弧度） */
  M0: number;
  /** 父天体的 GM（m³/s²）；月球是 `MOON_MU`，日心天体是 `MU_SUN` */
  mu: number;
};

/** 平运动 n（弧度/秒）。 */
export function meanMotion(el: OrbitalElements): number {
  return Math.sqrt(el.mu / (el.a * el.a * el.a));
}

/** 周期（秒）。这就是"开普勒第三定律"的唯一实现。 */
export function periodSeconds(el: OrbitalElements): number {
  return 2 * Math.PI * Math.sqrt((el.a * el.a * el.a) / el.mu);
}

/** 周期（天），给卡片与周期一致性表用。 */
export function periodDays(el: OrbitalElements): number {
  return periodSeconds(el) / 86400;
}

/**
 * 解开普勒方程 `E − e·sinE = M`（牛顿迭代）。
 *
 * 初值 `E₀ = M + e·sinM`：e→0.97（哈雷）时从 M 直接起步会慢，这个初值把迭代
 * 压到 8 次以内（实测 maxIter=8、残差 8.9e-16，见 t14 报告）。
 * 判据用步长（`|ΔE| < 1e-13`），不用函数值 —— 近抛物线轨道上 |f| 的尺度不可靠。
 */
export function solveKepler(M: number, e: number): number {
  const m = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = m + e * Math.sin(m);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** 偏近点角 E（弧度）。 */
export function eccentricAnomaly(el: OrbitalElements, tSeconds: number): number {
  return solveKepler(el.M0 + meanMotion(el) * tSeconds, el.e);
}

/**
 * 六根数 → 父天体坐标系里的位置（米）。
 *
 * 变换顺序（标准写法）：轨道平面内 (r·cosν, r·sinν)，先绕 Z 转近日点幅角 ω，
 * 再绕 X 转倾角 i，最后绕 Z 转升交点黄经 Ω。
 */
export function positionFromElements(
  el: OrbitalElements,
  tSeconds: number,
): { x: number; y: number; z: number } {
  const E = eccentricAnomaly(el, tSeconds);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = el.a * (1 - el.e * cosE);
  // 真近点角（用半角公式，避免 acos 在 e→1 时的精度损失）
  const nu = 2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
  const u = el.w + nu; // 升交点起算的纬向角
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(el.om);
  const sinO = Math.sin(el.om);
  const cosI = Math.cos(el.i);
  const sinI = Math.sin(el.i);
  return {
    x: r * (cosO * cosU - sinO * sinU * cosI),
    y: r * (sinO * cosU + cosO * sinU * cosI),
    z: r * (sinU * sinI),
  };
}

/**
 * 轨道线采样：按**偏近点角 E** 等分（不是按平近点角 M）。
 *
 * 为什么按 E：等 ΔE 在椭圆上的点间距变化最小；按 M 等分会在近日点附近把点挤成
 * 一坨、远日点拉得很稀。`OrbitPath` 的淡出参数也用 E，保证"淡出带贴着天体"。
 */
export function orbitPoints(el: OrbitalElements, segments: number): number[] {
  const pts: number[] = [];
  const cosO = Math.cos(el.om);
  const sinO = Math.sin(el.om);
  const cosI = Math.cos(el.i);
  const sinI = Math.sin(el.i);
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * Math.PI * 2;
    const r = el.a * (1 - el.e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
    const u = el.w + nu;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);
    pts.push(
      r * (cosO * cosU - sinO * sinU * cosI),
      r * (sinO * cosU + cosO * sinU * cosI),
      r * (sinU * sinI),
    );
  }
  return pts;
}
