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

/**
 * 一个系统的**观感 / 行为声明**（R3）。
 *
 * 为什么要有它：改造前这些开关全是 `spec.unit === "meter"` —— `unit` 只表示"长度单位是米
 * 还是世界单位"，却顺带管着七件事（冻结时间、自转、云层、细分、标签、装饰、相机）。
 * 2 代际要加第三个系统（星图：世界单位，但不该有自转/云层），`unit` 表达不了那个组合，
 * 漏一处就是"星图里行星在自转"这种荒谬 bug。现在每个开关只认这里的字段，`unit` 回到本职。
 *
 * **新增一个系统 = 只改数据**：写一份 SystemSpec（含 look），不碰渲染层的任何分支。
 * 各项可以独立组合，所以用布尔对象而不是 profile 字符串。
 */
export type SystemLook = {
  /** 天体自转、云层自转、小行星带转动（都挂在模拟时间轴上） */
  spins: boolean;
  /** 挂地球的云层壳（结构，不是旋转） */
  clouds: boolean;
  /** 天体名字标签 */
  labels: boolean;
  /** 装饰体：星空 / 小行星带 / 尾迹 */
  decor: boolean;
  /** 轨道线（还要叠 HUD 的 showOrbits 开关） */
  orbitLines: boolean;
  /** 冻结模拟时间推进（生产端不推进，见 SolarCanvas 的 Simulation） */
  freezesTime: boolean;
  /**
   * 球面细分提到 128 段。是**测量**需求不是画质需求：弦高 = r·(1−cos(π/N))，
   * N=56、r=530 px 时 0.83 px，会和要测的 float32 抖动（1.2 px）同量级。
   */
  refineGeometry: boolean;
  /** 用哪台相机：沙盘（OrbitControls）/ 米制（frameEarthMoon 独占） */
  camera: "sandbox" | "meter";
};

export type SystemSpec = {
  id: string;
  name: string;
  /** 单位：沙盘是压缩世界单位，实境是米。**只表示单位**，不当功能开关用（见 SystemLook）。 */
  unit: "worldUnit" | "meter";
  /** 观感/行为声明。**必填**：漏写会静默继承沙盘观感，那正是本文件要防的 bug。 */
  look: SystemLook;
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
  /*
   * 米制原型要的是"量得准"，不是"看得像"：每个 false 背后都有一条实测理由。
   *  - spins: 自转/公转会把贴图暗区（深海）转进转出像素回读的遮罩，质心被拖走 10~18 px；
   *  - clouds: 云层是 1.02× 半透明壳，轮廓会锁在云斑上（残余噪声 0.1 → 0.6 px）；
   *  - labels: 实境 HUD 没有芯片行，标签层也不该有；
   *  - decor / orbitLines: 几何体都建在"几十到几百"世界单位的量级，米制下量级不对；
   *    尾迹尤其致命（记录世界坐标 ~1.5e11 m 且 frustumCulled=false，会被画到屏幕任意位置）；
   *  - freezesTime: 时间是"进入那一刻"，推进发生在生产端（Simulation 不调 advanceSim）；
   *  - refineGeometry: 128 段，弦高 0.16 px，圆盘轮廓才不是多面体；
   *  - camera: 米制相机（frameEarthMoon 每帧独占，见 MeterCamera）。
   */
  look: {
    spins: false,
    clouds: false,
    labels: false,
    decor: false,
    orbitLines: false,
    freezesTime: true,
    refineGeometry: true,
    camera: "meter",
  },
  bodies: REAL_PROTO_BODIES,
};

/**
 * 一颗「必须可见」的天体：世界坐标 + 半径（含体型余量的口径写在 farFloorFor 里，
 * 不在调用点 —— 两个调用点各写一份才是 R7 说的问题）。
 */
export type VisibleBody = { id: string; x: number; y: number; z: number; radius: number };

/**
 * far 的下界：让「必须可见集合」整个落在远平面内（R7）。
 *
 * 为什么需要它：far 只按焦点距离算的话，远处天体会被远平面裁掉，而探针只算屏幕投影、
 * 看不出来（实境里曾经"只画得出地球"，探针仍老老实实返回 3 个天体）。
 * 沙盘以前不传 farFloor，靠「最远的东西（星场 450 + 海王星 63）< far 下限 819.2」
 * 这个数据巧合成立 —— 加一圈柯伊伯带就会静默裁掉。
 *
 * 为什么不把 body 循环塞进 tightenClipPlanes：那个函数是纯数学、可单独测；
 * 世界坐标要从渲染层的 registry 取，取完再交进来。这里只收位置和半径，不依赖 three。
 *
 * `pad` 是余量（默认 1.2）：保证球体整个在里面，而不是刚好切到轮廓。
 */
export function farFloorFor(
  visible: readonly VisibleBody[],
  camera: { x: number; y: number; z: number },
  pad = 1.2,
) {
  let floor = 0;
  for (const b of visible) {
    const dx = b.x - camera.x;
    const dy = b.y - camera.y;
    const dz = b.z - camera.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + b.radius * 4;
    if (d > floor) floor = d;
  }
  return floor * pad;
}

/**
 * 相机 near/far 的每帧收窄（t7 定稿）—— **相机裁剪面的唯一写入点**（R6）。
 *
 * Canvas 的 camera prop 与 applyHome 以前也写 near/far，但两处都是死配置：
 * 每帧这个函数都会覆盖它们，而首帧的渲染发生在 useFrame 之后 —— 那两处的 0.06/2400
 * 从来没有进过任何一帧画面。现在只剩这里写。
 *
 * `nearMin` 就是那两个老值里的 0.06：沙盘里离相机最近的东西也在 1.15 之外，
 * 近平面从 0.05 推到 0.06 不会裁掉任何可见物，换来的是更紧的深度跨度。
 *
 * 2400 **没有**变成 far 的下限：远端该看多远由「必须可见集合」决定（farFloorFor），
 * 而 2400 会把沙盘的 far 从 819.2 抬到 2400（深度跨度 16384:1 → 40000:1），
 * 换来一个今天用不上的远端余量 —— 那正是这个函数想避免的。要更远的兜底，
 * 传 farFloor，别写死一个上限。
 */
export function tightenClipPlanes(
  camera: { near: number; far: number; updateProjectionMatrix: () => void },
  distance: number,
  farFloor = 0,
  nearMin = 0.06,
) {
  const d = Math.max(distance, 1e-6);
  const near = Math.min(Math.max(d / 4096, nearMin), d / 1.25);
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
