/**
 * 系统数据层：把「唯一的太阳系」与「任意一个星系」分开的起点。
 *
 * 1.1.0 的最小验证原型只会用到 REAL_PROTO 里的三个天体 —— 它存在的意义不是好看，
 * 是回答一个工程问题：同一台相机能不能从 78 AU 连续推到 100 km 而不抖。
 *
 * 单位约定：沙盘用压缩后的世界单位（现状），实境原型用**米**。
 * 位置一律在 JS 里用 double 存，只有相机相对之后才转 float32 进 GPU。
 */

import type { Body } from "./data";

export type SystemSpec = {
  id: string;
  name: string;
  /** 单位：沙盘是压缩世界单位，实境是米 */
  unit: "worldUnit" | "meter";
  bodies: Body[];
};

/** 现在的太阳系（压缩比例），供沙盘使用 */
export type { Body };

/**
 * 最小验证原型：太阳 / 地球 / 月球，全部真实数值、单位是米。
 * 数据来源：NASA Fact Sheet（太阳半径 695,700 km、地球 6,371 km、月球 1,737.4 km）。
 * 轨道用圆轨道近似 —— 原型只验证相机与深度精度，不验证开普勒解。
 */
export const REAL_PROTO_BODIES: Body[] = [
  {
    id: "sun",
    name: "太阳",
    kind: "恒星 · G2V",
    blurb: "真实单位原型，仅用于验证相机与深度精度。",
    radius: 6.957e8,
    orbitRadius: 0,
    period: 1,
    phase: 0,
    inclination: 0,
    obliquity: 0,
    spin: 0.08,
    focus: 6.957e9,
    swatch: "#f0c27a",
    texture: "sun",
    facts: [{ label: "半径", value: "695,700 km" }],
  },
  {
    id: "earth",
    name: "地球",
    kind: "类地行星",
    blurb: "真实单位原型。1 AU = 1.496e11 m。",
    radius: 6.371e6,
    orbitRadius: 1.496e11,
    period: 18,
    phase: 0,
    inclination: 0,
    obliquity: 0.408,
    spin: 0.95,
    parent: "sun",
    focus: 3e7,
    swatch: "#6aa2d8",
    texture: "earth",
    facts: [{ label: "轨道", value: "1.496e11 m" }],
  },
  {
    id: "moon",
    name: "月球",
    kind: "天然卫星",
    blurb: "真实单位原型。地月距离 3.844e8 m。",
    radius: 1.7374e6,
    orbitRadius: 3.844e8,
    period: 2.55,
    phase: 0.6,
    inclination: 0.089,
    obliquity: 0.117,
    spin: 0,
    locked: true,
    parent: "earth",
    focus: 1e7,
    swatch: "#c5c1b8",
    texture: "moon",
    facts: [{ label: "地月距离", value: "3.844e5 km" }],
  },
];

/** 真实单位原型系统 */
export const REAL_PROTO: SystemSpec = {
  id: "real-proto",
  name: "实境原型",
  unit: "meter",
  bodies: REAL_PROTO_BODIES,
};

/**
 * 相机 near/far 的每帧收窄（t7 定稿）。固定值不可能成立：
 * 全景档需要 4.87e9 的跨度，而 100 km 高度档只要 2.7e3。
 * 这里只依赖焦点距离 d，把跨度压到 4096× 以内。
 */
export function tightenClipPlanes(
  camera: { near: number; far: number; updateProjectionMatrix: () => void },
  distance: number,
  farFloor = 0,
) {
  const d = Math.max(distance, 1e-6);
  const near = Math.min(Math.max(d / 4096, 0.05), d / 1.25);
  /*
   * farFloor：系统里最远那颗天体到相机的距离（含体型余量）。
   *
   * 没有它就会出现「实境里只画得出一颗地球」：d=2.5e7 时 near=6104，
   * 视距上界 16384·near = 1.0e8，而月球在 3.6e8、太阳在 1.5e11 —— 两颗都在
   * 远平面之外，被视锥剔除，从来没渲染过。探针只算屏幕投影、不看 near/far，
   * 所以「返回 3 个天体」证明不了它们画出来了。
   *
   * 代价：跨度超出 2^24 的深度预算后，远处天体之间的**深度排序**不可靠。
   * 实境里天体彼此不重叠，这个代价可以接受；将来若要渲染互相遮挡的远景，
   * 再上对数深度（那需要给 5 个手写着色器补 logdepthbuf chunk）。
   */
  const far = Math.max(1.25 * d, 16384 * near, farFloor);
  // 只在变化超过 5% 时更新，避免每帧重算投影矩阵
  if (Math.abs(camera.near - near) > near * 0.05 || Math.abs(camera.far - far) > far * 0.05) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

/**
 * 实地取景：把地球和月球同时框进画面。
 *
 * 为什么不是"系统全景"：实境要的是「航行仪表」—— 你得看得见脚下那颗球，
 * 也得看得见同框的邻居。系统全景（2.4× 外缘 = 7.2e11 m）里地球是亚像素，
 * 那等于没有实境。
 *
 * 几何约束摆在这儿：地月间距 3.844e8 m 是地球半径的 60 倍，任何一帧同时装下
 * 两颗球，地球最多只有整幅宽度的 1/120。所以取景距离按地月间距反推，
 * 而不是按地球大小：d = sep / tan(fov*0.4) ≈ 1.75·sep 时，两球夹角约 32°，
 * 塞进 42° 垂直视场还有余量；此时地球约 18 px、月球约 5 px，都认得出来。
 *
 * **与时间无关**：只用「地月连线」和「日向」两个几何量，绝不出现时钟 ——
 * t9 的黑屏就是拿 performance.now() 转方位角、与地球公转同速造成的。
 */
export function frameEarthMoon(
  earth: { x: number; y: number; z: number },
  moon: { x: number; y: number; z: number } | null,
  earthRadius: number,
): { target: [number, number, number]; dir: [number, number, number]; dist: number } {
  const target: [number, number, number] = moon
    ? [(earth.x + moon.x) / 2, (earth.y + moon.y) / 2, (earth.z + moon.z) / 2]
    : [earth.x, earth.y, earth.z];

  // 站在日向一侧：太阳在相机背后，地球和月球都正面受光。
  // 地球在原点附近公转，所以「地心→太阳」就是 −earth 方向。
  const len = Math.hypot(earth.x, earth.y, earth.z) || 1;
  let dx = -earth.x / len;
  let dy = -earth.y / len;
  let dz = -earth.z / len;

  const sep = moon ? Math.hypot(moon.x - earth.x, moon.y - earth.y, moon.z - earth.z) : 0;
  const dist = sep > 0 ? Math.max(sep * 1.75, earthRadius * 8) : earthRadius * 8;

  // 抬 12° 俯视，避免完全正对显得扁
  dy += 0.2126;
  const n = Math.hypot(dx, dy, dz) || 1;
  return { target, dir: [dx / n, dy / n, dz / n], dist };
}
