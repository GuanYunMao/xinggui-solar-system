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
import { MOON_MU, MU_SUN, periodDays, type OrbitalElements } from "./kepler";

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
  /**
   * 观感/行为声明。**必填**：漏写是类型错误（`tsc` 直接炸），没有默认值可继承。
   *
   * 别在这里加回"缺省就按沙盘"的兜底 —— 那种兜底活过一次（`SANDBOX_LOOK`，t31 删除），
   * 它让"谁忘了声明"变成静默错误，还让"沙盘长什么样"出现两份互不校验的真相。
   * 新增系统就在它自己的 spec 里把八个开关写全，缺一个都由类型系统拦住。
   */
  look: SystemLook;
  bodies: Body[];
};

/** 现在的太阳系（压缩比例），供沙盘使用 */
export type { Body };

/**
 * 最小验证原型：太阳 / 地球 / 月球 + 冥王星 / 哈雷两个样本，全部真实数值、单位是米。
 *
 * t14 起**实境用六根数 + 开普勒解**（沙盘不动，仍然是正圆示意图）。
 * 数据来源：
 *  - 太阳/地球/月球半径：NASA Fact Sheet；
 *  - 地球/月球根数：J2000 标准平均根数；
 *  - 冥王星/哈雷：JPL Small-Body Database（SBDB）的 osculating elements，
 *    用返回的 `n` 换算到 J2000（`M0 = M_epoch + n·(JD2000 − JD_epoch)`）。
 *    任务书里的旧值（冥王星 39.48/0.249/17.16、哈雷 17.8/0.967/162.3）与 JPL 现值
 *    差 0.3% 量级，这里一律用 JPL（源）并在 t14 报告里留记录。
 *
 * **周期不在数据里手写**：`period` 由 `periodDays(elements)` 现算（开普勒第三定律，
 * 全局系数 μ_sun / μ_earth 在 kepler.ts），卡片里的"公转"也由同一个数格式化，
 * 保证"卡片 = 模型"且模型只认 `a`。
 */
const AU = 1.496e11;
const deg = (d: number) => (d * Math.PI) / 180;

const elements = (
  a: number,
  e: number,
  i: number,
  om: number,
  w: number,
  M0: number,
  mu: number,
): OrbitalElements => ({ a, e, i: deg(i), om: deg(om), w: deg(w), M0: deg(M0), mu });

/** 地球（日心、黄道 J2000）。 */
const EARTH_ELEMENTS = elements(
  1.00000011 * AU,
  0.0167086,
  0.00005,
  -11.26064,
  114.20783,
  357.52911,
  MU_SUN,
);
/** 月球（地心、黄道 J2000；a = 384,399 km）。 */
const MOON_ELEMENTS = elements(3.84399e8, 0.0549, 5.145, 125.08, 318.15, 134.963, MOON_MU);
/** 冥王星（JPL SBDB，换算到 J2000）。 */
const PLUTO_ELEMENTS = elements(
  39.58862938517124 * AU,
  0.2518378778576892,
  17.14771140999114,
  110.2923840543057,
  113.7090015158565,
  14.7741,
  MU_SUN,
);
/** 哈雷（JPL SBDB，换算到 J2000；i = 162° → 逆行）。 */
const HALLEY_ELEMENTS = elements(
  17.92863504856923 * AU,
  0.9679359956953211,
  162.1905300439129,
  59.09894720612437,
  112.2414314637764,
  65.9012,
  MU_SUN,
);

/** 卡片里的"公转"：从模型周期直接格式化（t14 口径 A：卡片描述的是玩家看的这台模型）。 */
function periodFact(el: OrbitalElements): { label: string; value: string } {
  const d = periodDays(el);
  return d >= 365.25 * 2
    ? { label: "公转", value: `${(d / 365.25).toFixed(1)} 年` }
    : { label: "公转", value: `${d.toFixed(2)} 日` };
}

/**
 * 产品实境的地月三体（t14）：六根数 → 开普勒解（见 SolarCanvas 的 Simulation）。
 *
 * ⚠ **不要把它复用到 `?proto=1` 的测量夹具上**（见下面的 REAL_PROTO_BODIES）：
 * proto-jitter 的基线依赖旧圆轨道的贴图相位；t14 实测换成根数后 modern p10–p90
 * 从 0.073px 涨到 2.756px，夹具失去区分力（那是相位变化，不是浮点回归）。
 */
const REAL_SYSTEM_BASE: Body[] = [
  {
    id: "sun",
    name: "太阳",
    kind: "恒星 · G2V",
    blurb: "太阳系的中心恒星。实境里它是坐标原点，所有日心轨道都绕它解。",
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
    facts: [
      { label: "半径", value: "695,700 km" },
      { label: "质量占比", value: "99.86%" },
    ],
  },
  {
    id: "earth",
    name: "地球",
    kind: "类地行星",
    blurb: "日心轨道用 J2000 六根数，周期由开普勒第三定律从 a 导出。",
    radius: 6.371e6,
    orbitRadius: EARTH_ELEMENTS.a,
    period: periodDays(EARTH_ELEMENTS),
    phase: 0,
    inclination: EARTH_ELEMENTS.i,
    obliquity: 0.408,
    spin: 0.95,
    parent: "sun",
    focus: 3e7,
    swatch: "#6aa2d8",
    texture: "earth",
    elements: EARTH_ELEMENTS,
    facts: [
      periodFact(EARTH_ELEMENTS),
      { label: "轨道", value: "1.0000 AU" },
      { label: "偏心率", value: "0.0167" },
      { label: "直径", value: "12,742 km" },
    ],
  },
  {
    id: "moon",
    name: "月球",
    kind: "天然卫星",
    blurb: "地心轨道用 J2000 六根数（a = 384,399 km），周期同样由 a 导出。",
    radius: 1.7374e6,
    orbitRadius: MOON_ELEMENTS.a,
    period: periodDays(MOON_ELEMENTS),
    phase: 0,
    inclination: MOON_ELEMENTS.i,
    obliquity: 0.117,
    spin: 0,
    locked: true,
    parent: "earth",
    focus: 1e7,
    swatch: "#c5c1b8",
    texture: "moon",
    elements: MOON_ELEMENTS,
    facts: [
      periodFact(MOON_ELEMENTS),
      { label: "地月距离", value: "384,399 km" },
      { label: "倾角", value: "5.15°" },
      { label: "直径", value: "3,474 km" },
    ],
  },
];

/**
 * 产品实境（t14）：地月 + 冥王星 / 哈雷两个样本。
 *
 * 为什么和 `REAL_PROTO` 分两个 spec：
 *  - `?proto=1` 是**抖动测量夹具**，它的断言数"3 个天体"；产品实境多了两个样本，
 *    夹具不该跟着变（那会把测量夹具的契约推到另一条任务上）；
 *  - 夹具的 `look.orbitLines` 必须是 false（几何体在米制下的量级问题，见 REAL_PROTO 注释），
 *    而实境要真轨道线。
 * 两份 spec 共用 `REAL_PROTO_BODIES` 的三体数据，只多两条样本 + 一个开关。
 */
export const REAL_SYSTEM_BODIES: Body[] = [
  ...REAL_SYSTEM_BASE,
  {
    id: "pluto",
    name: "冥王星",
    kind: "矮行星 · 柯伊伯带",
    blurb: "实境样本：倾角 17.15°、偏心率 0.252，轨道明显穿出黄道面。",
    radius: 1.1883e6,
    orbitRadius: PLUTO_ELEMENTS.a,
    period: periodDays(PLUTO_ELEMENTS),
    phase: 0,
    inclination: PLUTO_ELEMENTS.i,
    obliquity: deg(122.5),
    spin: 0.03,
    parent: "sun",
    focus: 1.5e9,
    swatch: "#c8b6a2",
    texture: "pluto",
    elements: PLUTO_ELEMENTS,
    facts: [
      periodFact(PLUTO_ELEMENTS),
      { label: "半长轴", value: "39.59 AU" },
      { label: "偏心率", value: "0.2518" },
      { label: "倾角", value: "17.15°" },
      { label: "直径", value: "2,376.6 km" },
    ],
  },
  {
    id: "halley",
    name: "哈雷彗星",
    kind: "周期彗星 · 逆行",
    blurb: "实境样本：e=0.968、i=162°（逆行），近日点 0.575 AU。彗核只有 5.5 km，盘面上靠标记点定位。",
    radius: 5.5e3,
    orbitRadius: HALLEY_ELEMENTS.a,
    period: periodDays(HALLEY_ELEMENTS),
    phase: 0,
    inclination: HALLEY_ELEMENTS.i,
    obliquity: 0,
    spin: 0.2,
    parent: "sun",
    focus: 5e8,
    swatch: "#a8c0d8",
    texture: "halley",
    elements: HALLEY_ELEMENTS,
    /* 彗核在实境的任何视距下都是亚像素：这里是一个**UI 注记点**，不是天体本体。 */
    marker: { size: 6, color: "#e8f2ff" },
    facts: [
      periodFact(HALLEY_ELEMENTS),
      { label: "近日点", value: "0.575 AU" },
      { label: "倾角", value: "162.19°（逆行）" },
      { label: "彗核", value: "约 5.5 km" },
    ],
  },
];

/**
 * 三体原型（`?proto=1` 的测量夹具）：太阳 / 地球 / 月球，圆形近似，单位米。
 *
 * ⚠ **这是测量夹具，不是产品实境**，所以保留 t14 之前的圆轨道与相位：
 *  - proto-jitter 的 p10–p90 基线（modern 0.073px / legacy 0.434px）依赖"地球在 +X、
 *    可见贴图相位固定"；换成开普勒位置会改变相位（t14 实测 modern 0.073 → 2.756px，
 *    整条断言失去区分力 —— 那是相位变化，不是浮点回归）；
 *  - proto-real 的断言数"3 个天体"也在这里；产品实境是 REAL_SYSTEM_BODIES 的 5 个。
 * 产品实境（`mode === "real"`）用 REAL_SYSTEM，不读这套数据。
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
 * 产品实境（t14）：地月 + 冥王星 / 哈雷两个样本，轨道线打开。
 *
 * look 与 REAL_PROTO 只差 `orbitLines`：样本的看点就是轨道本身（冥王星穿黄道面、
 * 哈雷逆行），所以实境必须有轨道线；夹具（REAL_PROTO）保持关闭，避免影响既有的
 * proto-real / proto-jitter 测量契约。
 */
export const REAL_SYSTEM: SystemSpec = {
  id: "real",
  name: "实境",
  unit: "meter",
  look: { ...REAL_PROTO.look, orbitLines: true },
  bodies: REAL_SYSTEM_BODIES,
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
