export const EARTH_PERIOD = 18;

export type Rgb = [number, number, number];

export type Body = {
  id: string;
  name: string;
  kind: string;
  blurb: string;
  radius: number;
  orbitRadius: number;
  period: number;
  phase: number;
  inclination: number;
  obliquity: number;
  /**
   * 自转角速度（弧度 / 模拟秒）。**沙盘里是显示速率，不是真实自转周期**（t51 核实并写下）：
   *
   *  - 真实周期换算过来会糊：地球 23.93 h 在"18 模拟秒 = 一年"的压缩下 = 0.049 模拟秒/圈，
   *    8× 档位上每 0.4 实秒转一圈 —— 一颗转成一片灰的球，没有信息量；
   *  - 现在这些值是**手调的观感速率**，彼此的比例大致贴合真实（地球/火星 1.056 vs 真实 1.028，
   *    差 2.7%），但**绝对周期比真实慢约 100×**（地球 0.95 ⇒ 134 显示日/圈 vs 真实 1 日）。
   *
   * 所以别再拿"23.93 h"去核这个数：要真周期，得先把整个时间压缩层（EARTH_PERIOD / 8× 档）
   * 一起改，那是产品决定，不是数据修正。
   *
   * **"周期相等"不是潮汐锁定**：锁定的天体（`locked: true`）的 `spin` 会被忽略，自转角由
   * **轨道角派生**（`π − 轨道角`，见 SolarCanvas 的 Simulation）。两条独立时钟即使周期相同，
   * 方向/相位一错，近地面就会漂 —— t51 之前月球每公转一圈正脸转两圈，就是这么来的。
   */
  spin: number;
  /** 潮汐锁定（t51）：自转由轨道角派生，`spin` 不参与。六颗卫星全是 true。 */
  locked?: boolean;
  parent?: string;
  /**
   * 卫星绕行的**参考面**（t31）。只对 `parent` 非空的卫星有意义：
   *  - `"equatorial"`：母行星赤道面（规则卫星：木卫一~四、土卫六）；
   *  - `"ecliptic"`：黄道面（月球 —— 它的 5.145° 是相对黄道，不是地球赤道）。
   * 渲染层按这个字段决定把卫星挂在母天体倾角层的里面还是外面；
   * **不要用"母天体倾角是否大于某个值"来猜**，那会把一件真实事实变成一条隐式规则。
   * 缺省按 `"ecliptic"`（t31 之前所有卫星都在这一层）。
   */
  orbitFrame?: "ecliptic" | "equatorial";
  /**
   * 六根数（t14，可选）。**只有实境的天体带它**：沙盘仍然是"正圆 + 示意图简化"（t24）。
   * 有 `elements` 时，位置由 `kepler.ts` 的开普勒解开，`orbitRadius/phase/period` 的
   * 正圆公式不再参与；`period` 仍然要在数据层填（由 `periodSeconds` 派生），
   * 因为旋转/淡出/探针都用它。单位与坐标系见 kepler.ts 顶部。
   */
  elements?: import("./kepler").OrbitalElements;
  /**
   * UI 标记（t14）：给"本体小到看不见"的天体用（哈雷彗核 5.5 km）。**这不是天体本体**，
   * 是星图软件式的注记点；渲染成固定屏幕尺寸的点，不随距离缩放。
   */
  marker?: { size: number; color: string };
  focus: number;
  swatch: string;
  texture:
    | "sun"
    | "mercury"
    | "venus"
    | "earth"
    | "mars"
    | "jupiter"
    | "saturn"
    | "uranus"
    | "neptune"
    | "moon"
    | "io"
    | "europa"
    | "ganymede"
    | "callisto"
    | "titan"
    /** t14：实境样本。画笔画不出来，走 textures.ts 的 default（程序化岩石），不新增资产 */
    | "pluto"
    | "halley";
  atmosphere?: { color: Rgb; opacity: number; scale: number };
  rings?: { inner: number; outer: number; color: Rgb };
  facts: { label: string; value: string }[];
};

const deg = (d: number) => (d * Math.PI) / 180;

export const BODIES: Body[] = [
  {
    id: "sun",
    name: "太阳",
    kind: "恒星 · G2V",
    blurb: "太阳系的中心恒星，核心的氢聚变释放光和热，质量约占全系的 99.86%。",
    radius: 3.8,
    orbitRadius: 0,
    period: 1,
    phase: 0,
    inclination: 0,
    obliquity: 0.08,
    spin: 0.08,
    focus: 18,
    swatch: "#f0c27a",
    texture: "sun",
    facts: [
      { label: "直径", value: "139.2 万公里" },
      { label: "质量占比", value: "99.86%" },
      { label: "表面温度", value: "约 5,500 °C" },
      { label: "自转", value: "约 25 地球日" },
    ],
  },
  {
    id: "mercury",
    name: "水星",
    kind: "类地行星",
    blurb: "最靠近太阳的行星，表面布满撞击坑，几乎没有大气，昼夜温差极大。",
    radius: 0.38,
    orbitRadius: 8.6,
    period: 8.2,
    phase: 0.4,
    inclination: deg(7),
    obliquity: deg(0.03),
    spin: 0.12,
    parent: "sun",
    focus: 2.8,
    swatch: "#b7b1a6",
    texture: "mercury",
    facts: [
      { label: "距日", value: "0.39 AU" },
      { label: "公转", value: "88 地球日" },
      { label: "直径", value: "4,879 公里" },
      { label: "卫星", value: "0" },
    ],
  },
  {
    id: "venus",
    name: "金星",
    kind: "类地行星",
    blurb: "浓厚的二氧化碳大气造成失控温室，表面比水星更热，自转方向与多数行星相反。",
    radius: 0.72,
    orbitRadius: 11.6,
    period: 12.6,
    phase: 1.7,
    inclination: deg(3.4),
    obliquity: deg(177),
    spin: -0.04,
    parent: "sun",
    focus: 4.6,
    swatch: "#e3c98a",
    texture: "venus",
    atmosphere: { color: [0.95, 0.82, 0.55], opacity: 0.55, scale: 1.08 },
    facts: [
      { label: "距日", value: "0.72 AU" },
      { label: "公转", value: "225 地球日" },
      { label: "直径", value: "12,104 公里" },
      { label: "卫星", value: "0" },
    ],
  },
  {
    id: "earth",
    name: "地球",
    kind: "类地行星",
    blurb: "目前已知唯一拥有表面液态水与生命的行星，大气以氮和氧为主。",
    radius: 0.76,
    orbitRadius: 15.2,
    period: EARTH_PERIOD,
    phase: 2.5,
    inclination: 0,
    obliquity: deg(23.4),
    spin: 0.95,
    parent: "sun",
    focus: 4.8,
    swatch: "#6aa2d8",
    texture: "earth",
    atmosphere: { color: [0.55, 0.74, 1], opacity: 0.7, scale: 1.12 },
    facts: [
      { label: "距日", value: "1.00 AU" },
      { label: "公转", value: "365.25 日" },
      { label: "直径", value: "12,742 公里" },
      { label: "卫星", value: "1" },
    ],
  },
  {
    id: "moon",
    name: "月球",
    kind: "天然卫星",
    blurb: "地球唯一的天然卫星，潮汐锁定，永远以同一面朝向地球，也是潮汐的主要来源。",
    radius: 0.2,
    orbitRadius: 1.95,
    period: 2.55,
    phase: 0.6,
    /*
     * 倾角：真实值 5.145°（这里写 5.1）。**别为了"月食太频繁"去改它** —— t47 的实测：
     *
     *   沙盘地月距 1.95 世界单位 = 2.6 个地球半径（真实是 60 个）
     *   地球本影在月球轨道处的半径 ≈ 0.37（0.76 − 1.95 × 本影锥斜率 0.2）
     *   5.1° 倾角在冲日位置给出的偏移 = 1.95 × sin 5.1° ≈ 0.17
     *
     * 0.17 < 0.37，所以压缩比例下每次冲日都必然进影 —— 不是倾角设错，是几何被挤没了。
     * 实测（同一套公式扫 60 模拟秒）：倾角 5.1° 时月食总时长 14.96 s，倾角 0 时 15.14 s，
     * 几乎一样，再次说明倾角在这个尺度上救不了。
     *
     * 真实比例（米制 REAL_PROTO）：本影半径 ≈ 4.6e6 m、倾角偏移 ≈ 3.4e7 m，偏移是本影的 7 倍多，
     * 所以实境里月食本来就该很少 —— 同一个遮挡公式在那边算出的频率是对的。
     * 改地月距属于映射层的决定（t3），别在数据里偷偷动。
     */
    inclination: deg(5.1),
    obliquity: deg(6.7),
    spin: 0,
    locked: true,
    parent: "earth",
    /* 月球的 5.145° 是相对**黄道**的：它必须留在母天体倾角层外面，不跟地球赤道斜。 */
    orbitFrame: "ecliptic",
    focus: 1.7,
    swatch: "#c5c1b8",
    texture: "moon",
    facts: [
      { label: "距地", value: "38.4 万公里" },
      { label: "公转", value: "27.3 日" },
      { label: "直径", value: "3,474 公里" },
      { label: "引力", value: "地球的 1/6" },
    ],
  },
  {
    id: "mars",
    name: "火星",
    kind: "类地行星",
    blurb: "锈红色来自表面的氧化铁，拥有太阳系最高的火山奥林波斯山和巨大的峡谷。",
    radius: 0.52,
    orbitRadius: 19.4,
    period: 26,
    phase: 0.15,
    inclination: deg(1.85),
    obliquity: deg(25.2),
    spin: 0.9,
    parent: "sun",
    focus: 3.6,
    swatch: "#c4654a",
    texture: "mars",
    atmosphere: { color: [0.9, 0.55, 0.4], opacity: 0.35, scale: 1.07 },
    facts: [
      { label: "距日", value: "1.52 AU" },
      { label: "公转", value: "687 地球日" },
      { label: "直径", value: "6,779 公里" },
      { label: "卫星", value: "2" },
    ],
  },
  {
    id: "jupiter",
    name: "木星",
    kind: "气态巨行星",
    blurb: "太阳系最大的行星。大红斑是一场持续数百年的反气旋风暴，比地球还宽。",
    radius: 2.25,
    orbitRadius: 32,
    period: 46,
    phase: 3.6,
    inclination: deg(1.3),
    obliquity: deg(3.1),
    spin: 1.85,
    parent: "sun",
    focus: 12.5,
    swatch: "#d2b48c",
    texture: "jupiter",
    atmosphere: { color: [0.93, 0.82, 0.66], opacity: 0.28, scale: 1.05 },
    facts: [
      { label: "距日", value: "5.20 AU" },
      { label: "公转", value: "11.9 年" },
      { label: "直径", value: "13.98 万公里" },
      { label: "卫星", value: "95 颗以上" },
    ],
  },
  {
    id: "io",
    name: "木卫一",
    kind: "天然卫星",
    blurb: "伊俄，太阳系火山活动最剧烈的天体。轨道共振不断揉搓它的内部。",
    radius: 0.13,
    orbitRadius: 3.2,
    period: 3.3,
    phase: 0.2,
    inclination: deg(0.04),
    obliquity: 0,
    spin: 0,
    locked: true,
    parent: "jupiter",
    orbitFrame: "equatorial",
    focus: 1.45,
    swatch: "#e2c15a",
    texture: "io",
    facts: [
      { label: "母行星", value: "木星" },
      { label: "公转", value: "1.77 日" },
      { label: "直径", value: "3,643 公里" },
      { label: "特征", value: "活火山" },
    ],
  },
  {
    id: "europa",
    name: "木卫二",
    kind: "天然卫星",
    blurb: "欧罗巴，冰壳光滑、裂缝纵横，冰层之下可能存在全球性的咸水海洋。",
    radius: 0.11,
    orbitRadius: 3.9,
    period: 5.1,
    phase: 1.4,
    inclination: deg(0.47),
    obliquity: 0,
    spin: 0,
    locked: true,
    parent: "jupiter",
    orbitFrame: "equatorial",
    focus: 1.35,
    swatch: "#d5ddd8",
    texture: "europa",
    facts: [
      { label: "母行星", value: "木星" },
      { label: "公转", value: "3.55 日" },
      { label: "直径", value: "3,122 公里" },
      { label: "特征", value: "冰下海洋" },
    ],
  },
  {
    id: "ganymede",
    name: "木卫三",
    kind: "天然卫星",
    blurb: "伽倪墨得斯，太阳系最大的卫星，直径甚至超过水星，并拥有自己的磁场。",
    radius: 0.17,
    orbitRadius: 4.75,
    period: 7.8,
    phase: 2.4,
    inclination: deg(0.2),
    obliquity: 0,
    spin: 0,
    locked: true,
    parent: "jupiter",
    orbitFrame: "equatorial",
    focus: 1.6,
    swatch: "#9a8b78",
    texture: "ganymede",
    facts: [
      { label: "母行星", value: "木星" },
      { label: "公转", value: "7.15 日" },
      { label: "直径", value: "5,268 公里" },
      { label: "特征", value: "内禀磁场" },
    ],
  },
  {
    id: "callisto",
    name: "木卫四",
    kind: "天然卫星",
    blurb: "卡利斯托，表面古老、撞击坑密集，是四颗伽利略卫星中最外侧的一颗。",
    radius: 0.16,
    orbitRadius: 6.15,
    period: 12.5,
    phase: 4.1,
    inclination: deg(0.2),
    obliquity: 0,
    spin: 0,
    locked: true,
    parent: "jupiter",
    orbitFrame: "equatorial",
    focus: 1.55,
    swatch: "#6e675f",
    texture: "callisto",
    facts: [
      { label: "母行星", value: "木星" },
      { label: "公转", value: "16.7 日" },
      { label: "直径", value: "4,821 公里" },
      { label: "特征", value: "古老坑地" },
    ],
  },
  {
    id: "saturn",
    name: "土星",
    kind: "气态巨行星",
    blurb: "以冰与岩石碎块组成的环系著称。环很宽，厚度往往只有几十米。",
    radius: 1.9,
    orbitRadius: 42.5,
    period: 64,
    phase: 1.15,
    inclination: deg(2.5),
    obliquity: deg(26.7),
    spin: 1.65,
    parent: "sun",
    focus: 14.5,
    swatch: "#ead7a8",
    texture: "saturn",
    atmosphere: { color: [0.96, 0.9, 0.72], opacity: 0.25, scale: 1.05 },
    rings: { inner: 2.55, outer: 4.35, color: [0.9, 0.84, 0.7] },
    facts: [
      { label: "距日", value: "9.58 AU" },
      { label: "公转", value: "29.5 年" },
      { label: "直径", value: "11.65 万公里" },
      { label: "卫星", value: "140 颗以上" },
    ],
  },
  {
    id: "titan",
    name: "土卫六",
    kind: "天然卫星",
    blurb: "泰坦，拥有浓厚氮气大气，表面有液态甲烷与乙烷构成的湖泊。",
    radius: 0.17,
    orbitRadius: 5.35,
    period: 9.5,
    phase: 2.2,
    inclination: deg(0.3),
    obliquity: 0,
    spin: 0,
    locked: true,
    parent: "saturn",
    orbitFrame: "equatorial",
    focus: 1.7,
    swatch: "#e0b56a",
    texture: "titan",
    atmosphere: { color: [0.92, 0.72, 0.38], opacity: 0.55, scale: 1.16 },
    facts: [
      { label: "母行星", value: "土星" },
      { label: "公转", value: "16 日" },
      { label: "直径", value: "5,150 公里" },
      { label: "特征", value: "甲烷湖泊" },
    ],
  },
  {
    id: "uranus",
    name: "天王星",
    kind: "冰巨星",
    blurb: "自转轴几乎倒在公转轨道上，像一颗侧躺滚动的冰巨星，环也因此近乎竖直。",
    radius: 1.22,
    orbitRadius: 53,
    period: 92,
    phase: 4.3,
    inclination: deg(0.8),
    obliquity: deg(97.8),
    spin: 1.15,
    parent: "sun",
    focus: 8.2,
    swatch: "#9fdcd4",
    texture: "uranus",
    atmosphere: { color: [0.7, 0.95, 0.92], opacity: 0.4, scale: 1.08 },
    rings: { inner: 1.7, outer: 2.15, color: [0.7, 0.82, 0.84] },
    facts: [
      { label: "距日", value: "19.2 AU" },
      { label: "公转", value: "84 年" },
      { label: "直径", value: "5.07 万公里" },
      { label: "卫星", value: "28" },
    ],
  },
  {
    id: "neptune",
    name: "海王星",
    kind: "冰巨星",
    blurb: "最外侧的巨行星，深蓝色来自大气中的甲烷，风速可达每小时两千公里。",
    radius: 1.18,
    orbitRadius: 63,
    period: 118,
    phase: 2.85,
    inclination: deg(1.8),
    obliquity: deg(28.3),
    spin: 1.25,
    parent: "sun",
    focus: 7.8,
    swatch: "#3d5fbe",
    texture: "neptune",
    atmosphere: { color: [0.45, 0.62, 1], opacity: 0.45, scale: 1.08 },
    facts: [
      { label: "距日", value: "30.1 AU" },
      { label: "公转", value: "165 年" },
      { label: "直径", value: "4.92 万公里" },
      { label: "卫星", value: "16" },
    ],
  },
];

export const BODY_BY_ID: Record<string, Body> = Object.fromEntries(BODIES.map((body) => [body.id, body]));

export const CHIP_BODIES = BODIES.filter((body) => !body.parent || body.parent === "sun");

export function childrenOf(id: string) {
  return BODIES.filter((body) => body.parent === id);
}

export function isMoon(body: Body) {
  return Boolean(body.parent && body.parent !== "sun");
}
