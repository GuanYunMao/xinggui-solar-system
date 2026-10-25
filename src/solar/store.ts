import { create } from "zustand";
import {
  GATE_REQUIRED,
  canonicalSlots,
  decodeGate,
  encodeGate,
  isUnlocked,
  readGate,
  writeGate,
  type GateFailure,
  type GateSlot,
} from "./gate";
import { EARTH_PERIOD } from "./data";
import {
  accumulateTargetWatch,
  layerGateWitnessed,
  targetGateWitnessed,
  targetWatchAfterSelect,
  timeGateWitnessed,
  type GateWatch,
  type SelectionSource,
} from "./observe";

const KEY = "xinggui-settings-v1";

/** 模式切换的动画锁超时：rAF 在后台标签页会暂停，动画回调可能永远不来。 */
export const SWITCH_TIMEOUT_MS = 1500;

export type Mode = "sandbox" | "real";
export type Switching = null | "toReal" | "toSandbox";

type Settings = {
  speed?: number;
  showLabels?: boolean;
  showOrbits?: boolean;
  showTrails?: boolean;
  /**
   * HUD chrome（顶部天体行 + 底栏）空闲自动收起（t12）。
   *
   * 默认开：用户原话是「鼠标不移动到上面时，它缩起来，防止挡住界面」。
   * 但**必须留一个能关的口**——自动收起一旦被当成 bug，就会有人找不到按钮；
   * 关掉之后两处 chrome 常显，行为退回 1.2.1。
   */
  hudAutoHide?: boolean;
};

function clampSpeed(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

/**
 * 时间基准（t44，唯一的换算处）。
 *
 * 用户的原话是「1.0 倍的时候，速度是正常时间流逝的不知道多少倍了」—— 旧口径里 `1.0×`
 * 只是"没乘系数"：地球 18 秒一圈，等于 1 实秒 = 20.3 天 = 实时的 175 万倍。名字在骗人。
 *
 * 现在的定义：**`1.0×` = 1 实秒 = 1 模拟日 = 86,400 倍实时**。于是地球一圈 = 365.25 秒（约 6 分钟）。
 * 换算只有下面这一处：
 *
 *   simSeconds 每实秒 += speed × SECONDS_PER_SIM_SECOND
 *   SECONDS_PER_SIM_SECOND = EARTH_PERIOD / DAYS_PER_YEAR   （= 18 / 365.25 ≈ 0.04928）
 *
 * 为什么除的是 EARTH_PERIOD：沙盘的轨道周期（data.ts）是以「模拟秒」为单位的压缩量，
 * EARTH_PERIOD 秒 = 地球一圈 = 一年。要把"一年"摊到 365.25 秒实时上，就只能按这个比例缩。
 * 各天体的**相对**速度因此一点没变（木星 11.9 年、土星 29.5 年这些比例仍在 data.ts 里）。
 */
export const SECONDS_PER_DAY = 86400;

/**
 * 模拟历的年长：**365.25 天**（t44 定案）。
 *
 * 为什么不定成 365：项目对外说的是"真实太阳系"，而 `daysOf` 从 t28 起就用 365.25 把
 * 「EARTH_PERIOD 秒 = 一年」摊开。定成 365 会立刻出现两张皮：1 实秒推进的天数比 1 天多
 * 0.07%，一年差 0.25 天，一百年差 25 天 —— 现在看不出来，接真实星历那天一定打架。
 *
 * 代价是"日"不再是整数：内部一律保留小数（`simSeconds` 本来就是浮点），
 * **取整只发生在显示层**：年 = floor(days / DAYS_PER_YEAR)，日 = floor(days % DAYS_PER_YEAR) + 1。
 * 显示层（Hud）以前各写了一遍 365，现在应该只 import 这一个常量 —— 见 `daysPerYear()` 的注释。
 *
 * ⚠ 取整要带 epsilon（t49 实测踩到）：连按四次「+1 年」后 `days % 365.25 = 98.9999999999998`，
 * 直接 floor 得 98、显示成「第 99 日」，比实际少一天。显示层用 `EPS = 1e-6`（≈0.086 模拟秒）
 * 再 floor；store 这边如果将来导出 splitEpoch 之类的取整函数，也必须带上同一个 EPS。
 */
export const DAYS_PER_YEAR = 365.25;

/** 显示层取整用的 epsilon（天）：先加它再 floor，别让浮点误差偷走一天。 */
export const DAYS_EPSILON = 1e-6;

/** 一个模拟秒等于多少模拟日（= 1 / SECONDS_PER_SIM_SECOND 的倒数关系见下）。 */
export const DAYS_PER_SIM_SECOND = DAYS_PER_YEAR / EARTH_PERIOD;

/** 一实秒（speed = 1）推进多少模拟秒。 */
export const SECONDS_PER_SIM_SECOND = 1 / DAYS_PER_SIM_SECOND;

/** 滑条下限：1.0× = 1 天/秒，0.05× = 1.2 小时/秒（t44 从 0.2× 下探）。 */
export const SPEED_MIN = 0.05;
/** 滑条上限：8× = 8 天/秒。 */
export const SPEED_MAX = 8;

/**
 * 开局倍率：取档位顶端（8×）。理由见 initialState 里那段注释 —— 一句话：
 * 1× 在总览里看起来像卡死，而 20.29×（旧观感）不在档位里，硬设会让旋钮与读数打架。
 */
export const DEFAULT_SPEED = SPEED_MAX;

/** 年长（供显示层取整用，别再各写一个 365）。 */
export function daysPerYear() {
  return DAYS_PER_YEAR;
}

/** 一实秒推进多少个模拟日（1.0× 时恰好 = 1 天）。HUD 直接用它拼「1 秒 = N 天」。 */
export function daysPerRealSecond(speed = 1) {
  return DAYS_PER_SIM_SECOND * secondsPerRealSecond(speed);
}

/** 一实秒推进多少模拟秒（物理量，不是天数）。 */
export function secondsPerRealSecond(speed = 1) {
  return SECONDS_PER_SIM_SECOND * speed;
}

/** 地球绕一圈要多少实秒（= 一年 / 速率）—— 验收和 HUD 都用这一个口径。 */
export function earthLapSeconds(speed = 1) {
  return EARTH_PERIOD / secondsPerRealSecond(speed);
}

/**
 * 模拟钟的历元：`simSeconds = 0` 对应这个日历时刻（J2000.0，天文惯用历元）。
 *
 * ⚠ 本项目的轨道相位是手调的，**没有按真实星历标定**：这个历元只决定
 * `setSimTime(Date)` 怎么换算成秒，不代表"2000-01-01 那天行星真在那个位置"。
 * 要真日历，得先把 data.ts 的 phase / period 换成 JPL 的初值 —— 那是另一件事。
 */
export const SIM_EPOCH_MS = Date.UTC(2000, 0, 1, 12);

/**
 * 模拟秒 → HUD 的「第 N 日」。
 * 口径：EARTH_PERIOD 模拟秒 = 一个地球年 = `DAYS_PER_YEAR` 天（365.25）。
 * 这里只做换算，**不取整** —— 取整是显示层的事（见 DAYS_PER_YEAR 的注释）。
 */
export function daysOf(simSeconds: number) {
  return simSeconds * DAYS_PER_SIM_SECOND;
}

/**
 * 实境距离读数的节流（t22）：每 100ms 最多写一次 = 10Hz。
 *
 * 为什么放 store 而不是让每个调用方自己节流：`realDistanceM` 的消费者是 HUD，
 * 每帧写 = HUD 每帧重渲染（`days` 的 250ms 节流就是同一个教训）。口子只有一个，
 * 节流就只该有一处；`MeterCamera` 每帧调 `setRealDistance` 是安全的。
 */
const DISTANCE_MIN_GAP_MS = 100;
let lastDistanceWrite = 0;

/**
 * HUD 历法写回的节流。
 *
 * 为什么需要它：`simSeconds` 每帧都变，而 Hud 读的是 `state.days`。如果每帧都写 days，
 * HUD 会每帧重渲染；改造前是 0.25 s 写一次，这里保持同一个刷新率。
 * 放模块级而不是 state：它只是节流用的时间戳，不是任何 UI 的真相。
 */
let lastDaysWrite = 0;

/*
 * 选中的来源（t19 立、t33 细分，三条门共用）。
 *
 * 为什么需要它：URL 深链（`?body=moon`）也会调 `select`，把 selectedId 设出来 ——
 * 零交互就能点门（批判位实测 `?body=moon` 1.71 实秒白拿门·time）。而且芯片行常驻印着名字，
 * 点芯片同样算选中 —— 门·layer 要考"两层都不在还认不认得"，点芯片等于看着答案点。
 *
 * 所以 `select` 在**调用那一刻**读两个模块级事实：
 *  - `sawGesture`：页面上出现过指针/键盘/滚轮没有 —— 没有就是 URL 带出来的；
 *  - `lastInputOnCanvas`：最近一次输入落在画布（3D）还是别处（HUD 芯片/键盘/面板）。
 * 合成 observe.ts 的 `SelectionSource`：`"url"` / `"canvas"` / `"hud"`。
 *
 * 为什么是"最近一次输入"而不是让调用方传参：`select` 的调用方分布在 Hud / SolarCanvas / App
 * 三个作用域，让每个都传来源等于把同一件事抄三遍（抄一次漂一次）。输入事件在 window 捕获阶段
 * 先于 React 的 onClick 触发，所以读到的就是**这一下**的来源。
 *
 * 什么情况会推翻它：
 *  - **自动化/演示模式替玩家点**：Playwright 的 `locator.click()` 会真的发 pointerdown，
 *    所以夹具的点击算画布点选（这是对的）；`element.click()` 这种 DOM 直调不算。
 *  - **选中不是由输入直接触发的那些路**：`finishSwitch` 排队后的那次 select 发生在相机动画回调里，
 *    读到的是"上一次输入"（通常就是点芯片/点画布那一下）—— 这一档可以接受，因为排队的那次
 *    和触发它的是同一动作；真要求严格，得让调用方传来源。
 *  - **最干净的修法**是让 App 的深链调用传来源（`select(id, { source: "url" })`），
 *    那要改 `App.tsx`（外壳位作用域），这一版不做。
 */
let sawGesture = false;
/** 最近一次输入是否落在画布上（`<canvas>` 里面）。 */
let lastInputOnCanvas = false;

function notePointerDown(event: PointerEvent) {
  sawGesture = true;
  const target = event.target as Element | null;
  lastInputOnCanvas = Boolean(target?.closest?.("canvas"));
}

function noteKeyDown() {
  sawGesture = true;
  // 键盘选天体（1–9）不是画布点选
  lastInputOnCanvas = false;
}

function noteWheel() {
  sawGesture = true;
}

if (typeof window !== "undefined") {
  // 捕获阶段 + passive：先于 React 的 onClick / 画布自己的 pointerup 落地，且不拖慢滚动
  const capture = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", notePointerDown, capture);
  window.addEventListener("keydown", noteKeyDown, capture);
  window.addEventListener("wheel", noteWheel, { ...capture, once: true });
}

/** 只看不写：给断言一个稳定的读法（门判据自己读的是 state 里的 `selectionSource`）。 */
export function gestureSeen() {
  return sawGesture;
}

/** 这一下选中该算哪种来源。`select` 里调一次，别在别处重算。 */
function selectionSourceNow(): SelectionSource {
  if (!sawGesture) return "url";
  return lastInputOnCanvas ? "canvas" : "hud";
}

/** 三条门共用的选中态读法（判据本体在 observe.ts 的 GateWatch 上）。 */
function gateWatch(s: Pick<SimStore, "selectedId" | "selectionSource">): GateWatch {
  return { selectedId: s.selectedId, source: s.selectionSource };
}

type GateSlice = {
  gateLit: GateSlot[];
  gateUnlocked: boolean;
  gateUnlockedAt: number | null;
  gateSeen: number;
  /** 最近一次写盘失败：只用来在面板上说一句真话，**不参与判定**。 */
  gatePersistFailed: boolean;
  /** 当前这次选中的来源：`"url"` / `"canvas"` / `"hud"`（t19 立、t33 细分，三条门共用）。 */
  selectionSource: SelectionSource;
  /**
   * 门·target 的累积量（**模拟秒**，不是实秒）：只累计"水星被玩家选中"的那几段。
   * 0 = 刚开始看；≥ `TARGET_GATE_ORBIT_SECONDS`（水星一个 period，8.2 模拟秒）就算看完一圈。
   */
  mercuryWatchSeconds: number;
};

type SimStore = GateSlice & {
  paused: boolean;
  speed: number;
  showLabels: boolean;
  showOrbits: boolean;
  showTrails: boolean;
  /** 顶部天体行 / 底栏的空闲自动收起（t12）。关掉 = 常显。 */
  hudAutoHide: boolean;
  /**
   * 实境：当前取景目标（t22）。`frameEarthMoon` 那一片视野只能在地月之间换，
   * 三个状态对应验收要的三个取景：
   *  - `"wide"`  = 地月同框（默认，也是"再点一次当前目标"的回落）；
   *  - `"earth"` = 地球特写；
   *  - `"moon"`  = 月球。
   * **只表示"玩家想看的对象"**，相机怎么摆是渲染层的事（t23 让 MeterCamera 读它，
   * 并把相机到该目标的距离喂给 `realDistanceM`）。
   */
  realFocus: "wide" | "earth" | "moon";
  selectedId: string | null;
  /**
   * 模拟时间，**时间的唯一真值**（秒）。公转、自转、太阳 uTime、HUD 历法全部从它派生。
   * 推进只发生在一处：SolarCanvas 的 Simulation 每帧调 `advanceSim`。
   */
  simSeconds: number;
  /** HUD 历法的**显示缓存**：恒等于 `daysOf(simSeconds)`，节流写回，绝不单独推进。 */
  days: number;
  resetToken: number;
  /*
   * 解锁三条门的判定机器（t2 §1 定的条件，只活在本会话、不进存档）：
   *  - hops：真的换过几次目标（深链也算一次，但 URL 只有一个位置，刷不满 3 次）
   *  - everReset：有没有回过一次总览（"看过 3 个"和"回得去"是两件事）
   */
  hops: number;
  everReset: boolean;
  mode: Mode;
  switching: Switching;
  /** 进实境前的速度，回沙盘时恢复。 */
  prevSpeed: number;
  /** 切换中被拦下的选择，动画落定后再应用。 */
  queuedSelectId: string | null;
  /**
   * 实境：相机到**当前取景目标**的距离（米）。t22 开的口子，t23 的 MeterCamera 往里喂。
   *
   * `null` = 还没有可信读数（第一帧、相机没摆位、刚切模式）。界面必须把 null 当成
   * 「不知道」而不是 0 —— 0 会被格式化成「0 米」，那是谎言。
   */
  realDistanceM: number | null;
  /** 实境取景目标（t22）：地 / 月 两个按钮唯一的写入点；再点当前目标回落到地月同框。 */
  setRealFocus: (focus: "wide" | "earth" | "moon") => void;
  togglePaused: () => void;
  setSpeed: (speed: number) => void;
  toggleLabels: () => void;
  toggleOrbits: () => void;
  toggleTrails: () => void;
  /** t12：自动收起的开关（持久化，走 bindSettingsPersistence）。 */
  toggleHudAutoHide: () => void;
  select: (id: string | null) => void;
  /** 唯一的时间推进点：每帧由 Simulation 调；`paused` 时自吞。 */
  advanceSim: (dt: number) => void;
  /**
   * 把模拟钟拨到某一时刻 —— 用户要的「时间以后要能改」的地基（本轮不做 UI）。
   * `number` = 模拟秒；`Date` = 以 `SIM_EPOCH_MS` 为 t=0 换算成秒。
   */
  setSimTime: (when: number | Date) => void;
  /**
   * 实境距离读数（t22 开的口子，t23 的 MeterCamera 每帧调）。
   *
   * 三件事收在这一处，调用方不用各写一遍：
   *  - **10Hz 节流**：每帧调也只有 ~10 次/秒真的写进 store，否则 HUD 每帧重渲染
   *    （`days` 的 250ms 节流是同一个教训）；
   *  - **非有限值不写**：NaN / Infinity 一路污染到界面就没法查了；
   *  - **null 立即生效**：切模式 / 相机没摆位时立刻清空，不走节流。
   */
  setRealDistance: (meters: number | null) => void;
  /** 只重取景：不清目标。返回沙盘时要的就是这个。 */
  refocus: () => void;
  /** 原子地「设目标 + 重取景」，一次 set 只让 CameraRig 起一次动画。 */
  returnTo: (id: string | null) => void;
  requestReset: () => void;
  /** 模式切换的唯一入口（先只做 store 层能力，UI 等 RealHud 接通再放出来）。 */
  setMode: (mode: Mode) => void;
  /** 相机动画结束时由渲染层调用，是 `switching` 的唯一释放点。 */
  finishSwitch: () => void;
  hydrate: (settings: Settings) => void;
  hitGate: (slot: GateSlot) => void;
  bumpGateSeen: () => void;
  exportGateCode: () => string;
  restoreGateCode: (raw: string) => GateFailure | { ok: true; added: number };
  hydrateGate: () => void;
};

let switchTimer: number | null = null;

function armSwitchTimeout() {
  clearSwitchTimeout();
  if (typeof window === "undefined") return;
  switchTimer = window.setTimeout(() => {
    switchTimer = null;
    // 时间到就当动画结束：宁可提前放锁，也不要让界面永远锁死。
    useSim.getState().finishSwitch();
  }, SWITCH_TIMEOUT_MS);
}

function clearSwitchTimeout() {
  if (switchTimer === null) return;
  if (typeof window !== "undefined") window.clearTimeout(switchTimer);
  switchTimer = null;
}

/** 持久化只做记忆：失败返回 false，界面可以据此说一句真话，但绝不拦人。 */
function persistGate(state: GateSlice): boolean {
  return writeGate({
    v: 1,
    lit: state.gateLit,
    unlockedAt: state.gateUnlocked ? (state.gateUnlockedAt ?? Date.now()) : undefined,
    seen: state.gateSeen,
  });
}

function mergeSlots(current: readonly GateSlot[], incoming: readonly string[]): GateSlot[] {
  return canonicalSlots([...current, ...incoming]);
}

export const useSim = create<SimStore>((set, get) => {
  return {
  paused: false,
  /*
   * 默认倍率 = 8×（t44 补丁，captain 定：第一印象不能是"行星不动"）。
   *
   * 新口径下 1× = 365 秒绕地球一圈，直接开局会被当成卡死。旧版默认是 18 秒一圈，
   * 换成新口径是 20.29× —— 但 20 不在滑条档位里（0.05/0.1/0.2/0.5/1/2/4/8），
   * 硬设 20 会让旋钮停在 8、读数写 20，两者打架。所以取档位顶端的 8×（45.7 秒一圈）：
   * 旋钮在最右、读数写 ×8，玩家看到的仍是"在转"，只是比旧版慢 2.5 倍。
   * 要还原旧观感（20.29×）得给滑条加一档 20，那是 HUD 侧的改动，等 designer 点头。
   */
  speed: DEFAULT_SPEED,
  showLabels: true,
  showOrbits: true,
  showTrails: true,
  hudAutoHide: true,
  selectedId: null,
  simSeconds: 0,
  days: 0,
  resetToken: 0,
  hops: 0,
  everReset: false,
  mode: "sandbox",
  switching: null,
  prevSpeed: DEFAULT_SPEED,
  queuedSelectId: null,
  realDistanceM: null,
  realFocus: "wide",
  gateLit: [],
  gateUnlocked: false,
  gateUnlockedAt: null,
  gateSeen: 0,
  gatePersistFailed: false,
  selectionSource: "url",
  mercuryWatchSeconds: 0,

  // 切换中禁「暂停 / 调速」：这两个动作会和切换里写进去的 speed / paused 打架，
  // 与其让玩家看到自己刚拖的滑条被覆盖，不如直接不响应。
  togglePaused: () => {
    if (get().switching) return;
    set((s) => ({ paused: !s.paused }));
    // 注意：暂停/继续**不点门**（t28 起）。门·time 判的是沙盘里真发生的一次月食（1.3.4），
    // 暂停只是让钟不走 —— 它既不是月食，也不是"等了一年"。
  },
  setSpeed: (speed) => {
    if (get().switching) return;
    set({ speed: clampSpeed(speed) });
    // 同理：调速只是手段，门看的是 `advanceSim` 连续推进时发生的那次月食（与倍率无关，
    // 高倍率只是让它来得快，低倍率也不是"没等"）。
  },
  /*
   * 门·符号（t28 → t19 收紧 → t33 只认画布）：**名称与轨道都不在的时候，在画布上点得中一颗行星**才算。
   *
   * 旧口径（t28）是"同时关掉两层就亮"——那还是"摸过控件"：两个按钮各点一下，两下通关。
   * t19 起开关本身一次都不点门，判据搬到 `select` 里；t33 再收紧：只认**画布点选**，
   * 芯片行常驻印着名字，点芯片等于看着答案点（那是观察位 t29 判读出来的第二条硬伤）。
   * 尾迹始终不算：它不是导航符号，关掉它证明不了任何事。
   *
   * 这里只写判据检查什么，不抄界面提示的原文 —— 提示改过两轮，注释抄一次漂一次。
   */
  toggleLabels: () => {
    set((s) => ({ showLabels: !s.showLabels }));
  },
  toggleOrbits: () => {
    set((s) => ({ showOrbits: !s.showOrbits }));
  },
  toggleTrails: () => {
    // 尾迹不点门：它既不是时间也不是符号（t28）
    set((s) => ({ showTrails: !s.showTrails }));
  },
  // t12：自动收起的开关。不记门、不算进度——它是无障碍/习惯偏好，不是玩法。
  toggleHudAutoHide: () => set((s) => ({ hudAutoHide: !s.hudAutoHide })),

  // 切换中禁「选择」：切模式那一刻发一个「场景里还不存在」的目标是 bug 温床。
  // 拦下来存一个，落定后再应用（只存一个，后到的覆盖先到的）。
  select: (selectedId) => {
    const s = get();
    if (s.switching) {
      if (selectedId) set({ queuedSelectId: selectedId });
      return;
    }
    /*
     * 选中来源（t19 / t33）：**它决定三条门认不认这次选中**，也决定门·layer 认不认"点得中"。
     * 深链（App.tsx 的 `?body=`）也走这个函数，但它发生在任何输入之前 ⇒ `"url"`。
     *
     * 门·target 的累计**只在换目标时清零**（t33）：玩家"再点一下确认是这颗"不该白等，
     * 所以同一颗的重复选中保留已看的时长（规则本体在 observe.ts 的 `targetWatchAfterSelect`）。
     */
    const source = selectionSourceNow();
    const changed = selectedId !== s.selectedId;
    set({
      selectedId,
      hops: selectedId && changed ? s.hops + 1 : s.hops,
      selectionSource: source,
      mercuryWatchSeconds: targetWatchAfterSelect(s.mercuryWatchSeconds, s.selectedId, selectedId),
    });
    const after = get();
    /*
     * 门·符号（t19 / t33）：**名称与轨道都不在的时候，在画布上点得中一颗行星**。
     * 判据本体在 observe.ts 的 `layerGateWitnessed`（它自己要求 `source === "canvas"`）；
     * 这里只负责"在选中那一刻问一次"。开关本身一次都不点门（见 toggleLabels / toggleOrbits 的注释）。
     */
    if (layerGateWitnessed(gateWatch(after), after.showLabels, after.showOrbits)) after.hitGate("layer");
    /*
     * 门·规律（1.3.4 / t19）：**不再"选中水星就亮"**。
     * 旧口径（t28）是 `selectedId === "mercury"` 就 hitGate —— 批判位实测：点一下芯片、
     * 甚至按一下键盘 2 就通关，而卡片第一屏印着「公转 88 地球日」。那测的是"点到了"，
     * 不是"看见了它跑得最快"。现在要**盯着它跑完一整圈**，累计在 advanceSim 里做。
     * 注意：选中月球也不点门（t13）—— 它是门·time 的前置条件，不是判据。
     */
  },
  /*
   * 时间推进：唯一的生产端。**实境的冻结不在这里**（store 不知道系统单位），
   * 由 Simulation 决定这一帧要不要调它 —— 冻结因此发生在生产端，而不是像改造前那样
   * 在消费端把时间读成 0（那会让"在实境待 5 分钟再回沙盘，模拟历凭空跳过 5 分钟"）。
   */
  advanceSim: (dt) => {
    const s = get();
    if (s.paused) return;
    // 时间基准：`dt`（实秒）× speed × SECONDS_PER_SIM_SECOND（t44 定的 1.0× = 1 天/秒）
    const next = s.simSeconds + dt * s.speed * SECONDS_PER_SIM_SECOND;
    /*
     * 门·target 的累积（t19）：**和时钟同一拍写进 store**，不另开一次 set。
     * 只在"水星被玩家选中"时为真；换目标 / URL 带出来的选中一律归零（判据在 observe.ts）。
     * 已点亮就不再累加，省掉每帧的无谓状态变化。
     */
    const watched = s.gateLit.includes("target")
      ? 0
      : accumulateTargetWatch(s.mercuryWatchSeconds, next - s.simSeconds, gateWatch(s));
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    let wrote = false;
    if (now - lastDaysWrite >= 250) {
      lastDaysWrite = now;
      const d = daysOf(next);
      if (Math.abs(d - s.days) > 0.2) {
        set({ simSeconds: next, days: d, mercuryWatchSeconds: watched });
        wrote = true;
      }
    }
    if (!wrote) set({ simSeconds: next, mercuryWatchSeconds: watched });
    /*
     * 门·规律（t19）：**看水星跑满一整圈**才亮（累积轨道角 ≥ 2π）。
     * 卡片的「公转 88 地球日」让"谁最快"一眼可得，所以这一格不能只判"选中了水星"——
     * 要真的盯着它走完模型里的一个 period（8.2 模拟秒，8× 下约 20.8 实秒）。
     * 沙盘是正圆、角速度恒定 ⇒ 累积时间即累积角，换椭圆必须先改 observe.ts 的
     * `TARGET_GATE_ORBIT_SECONDS`（那里写了什么情况会推翻它）。
     */
    if (!s.gateLit.includes("target") && targetGateWitnessed(watched)) get().hitGate("target");
    /*
     * 门·时间（1.3.4，t13 补一条）：判据换成**月食 + 月球被玩家选中**，不再看钟面读数。
     *
     * 旧判据 `daysOf(next) >= DAYS_PER_YEAR` 只读钟：界面「设定时刻 → +1 年」一步就能把
     * 读数从第 0 天推到第 365.25 天，门当场亮 —— 它测的是"钟走过去了"，不是"你看着它走过去"。
     * 现在唯一的判据在 observe.ts：这段推进里有一次"月球进本影"，**且进入那一刻月球是选中的**。
     * 和钟读数无关，所以跳时间制造不出点亮：只有 `advanceSim` 这条连续推进的路径会调用它，
     * `setSimTime` 一次都不调（跳变不是目击）。
     *
     * 为什么判"进入"而不是"在里面"：跳变之后的第一帧可能正好落在影里，
     * "在里面"会把那次跳当成目击；`eclipseEntry` 要求采样从外到内。
     * 帧步长 8× 下 0.0066 模拟秒，食长 0.294 模拟秒 —— 一段月食被 40 多帧穿过。
     *
     * 为什么要"选中月球"（t13）：只判几何的话，8× 开局约 1.9 实秒就发生第一次月食，
     * 零输入的玩家白拿一盏灯 —— 四把尺子第 1 条（能不能失败）不通过。选中是一次玩家动作，
     * 也是"跟着月球看它变暗"的前提。t19 起还要求这条选中是**手势**引起的（深链不算）。
     */
    if (!s.gateLit.includes("time") && timeGateWitnessed(s.simSeconds, next, gateWatch(s))) get().hitGate("time");
  },

  setSimTime: (when) => {
    /*
     * 切换动画期间不许跳时间（t44）。`setSpeed` / `togglePaused` 早就守了这一条，
     * `setSimTime` 漏了 —— UI 层虽然 disable 了入口，但绕过 UI 直接调 store 就能在
     * 相机动画中途跳时间。锁定期间时间轴不该被动，跟"锁定期间不能改速度"同一个理由。
     */
    if (get().switching) return;
    const seconds = typeof when === "number" ? when : (when.getTime() - SIM_EPOCH_MS) / 1000;
    // 非有限值一律不写：钟停着是"没反应"，写进去会让整条时间轴变 NaN，
    // 之后每个天体的位置、每个投影都是 NaN —— 那比不动难查一百倍。
    if (!Number.isFinite(seconds)) return;
    lastDaysWrite = 0; // 下一帧立刻把 HUD 对齐（否则最多迟 0.25 s）
    set({ simSeconds: seconds, days: daysOf(seconds) });
  },

  setRealDistance: (meters) => {
    // null = 「不知道」：立即清空，不走节流（切模式时界面要立刻停止显示旧读数）
    if (meters === null) {
      lastDistanceWrite = 0;
      if (get().realDistanceM !== null) set({ realDistanceM: null });
      return;
    }
    // NaN / Infinity 一律不写：一路污染到界面就没法查了
    if (!Number.isFinite(meters)) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastDistanceWrite < DISTANCE_MIN_GAP_MS) return; // 10Hz
    lastDistanceWrite = now;
    set({ realDistanceM: meters });
  },

  // 实境取景目标：同一个手势里不会有并发写，直接 set；切模式时由 setMode 重置成 wide。
  // 再点当前目标 = 回落到「地月同框」（两个按钮、三个取景，验收要的那三个）。
  setRealFocus: (focus) => {
    const current = get().realFocus;
    if (focus !== "wide" && current === focus) {
      set({ realFocus: "wide", realDistanceM: null });
      return;
    }
    if (current === focus) return;
    // 换目标的那一刻旧距离就作废了：留着会让界面先显示「到月球的距离」再突然跳
    set({ realFocus: focus, realDistanceM: null });
  },

  refocus: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  // 必须一次 set 同时改两个字段：分两次会让 CameraRig 在相邻两帧看到 key 变两次，
  // 起两次聚焦动画（SolarCanvas 的去重键是 `${selectedId}|${resetToken}`）。
  returnTo: (selectedId) => set((s) => ({ selectedId, resetToken: s.resetToken + 1 })),
  // 兼容老调用点（Hud 的 Esc / 关闭详情 / 返回总览 / 底栏总览）：语义一字未变。
  requestReset: () => {
    get().returnTo(null);
    // 只留统计：`everReset` 不再参与门（t28 的门看的是"最后选中水星"）
    set({ everReset: true });
  },

  setMode: (mode) => {
    const s = get();
    if (s.switching || s.mode === mode) return;
    if (mode === "real") {
      // 硬门：没解锁就没有这个目的地。入口只会在 UI 层被禁用，这里再守一层。
      if (!isUnlocked(s)) return;
      // 切模式时清空距离读数：旧目标（沙盘的太阳）的距离喂给实境是假数
      // 进实境一律从"地球"开始：`frameEarthMoon` 默认就是地月同框，读数是到地球
      set({ mode: "real", switching: "toReal", prevSpeed: s.speed, speed: 1, paused: false, realDistanceM: null, realFocus: "wide" });
      armSwitchTimeout();
      return;
    }
    // 回沙盘：mode 与「目标回位」同一拍发出，全程只让 CameraRig 起一次动画。
    clearSwitchTimeout();
    set({
      mode: "sandbox",
      switching: "toSandbox",
      speed: s.prevSpeed || DEFAULT_SPEED,
      selectedId: s.selectedId,
      resetToken: s.resetToken + 1,
      realDistanceM: null,
    });
    armSwitchTimeout();
  },

  finishSwitch: () => {
    const s = get();
    if (!s.switching) return;
    clearSwitchTimeout();
    const queued = s.queuedSelectId;
    // 先把锁放掉，再走 select()：被拦下的那次选择必须和用户真点一下走同一条路，
    // 否则它不记 hops（`target` 门少一次）、不走切换守卫、也不触发 URL 订阅里的 markVisited。
    // 原来直接 set({selectedId}) 的写法会让「切换期间的那一次点击」凭空消失。
    set({ switching: null, queuedSelectId: null });
    if (queued) get().select(queued);
  },

  hydrate: (settings) =>
    set({
      speed: clampSpeed(settings.speed ?? DEFAULT_SPEED),
      showLabels: settings.showLabels ?? true,
      showOrbits: settings.showOrbits ?? true,
      showTrails: settings.showTrails ?? true,
      hudAutoHide: settings.hudAutoHide ?? true,
    }),

  hitGate: (slot) => {
    const s = get();
    if (s.gateLit.includes(slot)) return;
    const lit = mergeSlots(s.gateLit, [slot]);
    const unlockedNow = s.gateUnlocked || lit.length >= GATE_REQUIRED;
    set({
      gateLit: lit,
      gateUnlocked: unlockedNow,
      gateUnlockedAt: unlockedNow ? (s.gateUnlockedAt ?? Date.now()) : s.gateUnlockedAt,
    });
    // 写盘失败只影响「下次记不记得」，不拦人；但界面要说一句真话（gate.save.warn）。
    set({ gatePersistFailed: !persistGate(get()) });
  },

  bumpGateSeen: () => {
    set((s) => ({ gateSeen: s.gateSeen + 1 }));
    set({ gatePersistFailed: !persistGate(get()) });
  },

  exportGateCode: () => {
    const s = get();
    return encodeGate(s.gateLit, isUnlocked(s));
  },

  // 解析失败一律不改任何状态：宁可让玩家重抄一遍，也不能把已有进度洗掉。
  restoreGateCode: (raw) => {
    const parsed = decodeGate(raw);
    if (!parsed.ok) return parsed;
    const s = get();
    const lit = mergeSlots(s.gateLit, parsed.slots);
    const unlockedNow = s.gateUnlocked || parsed.unlocked || lit.length >= GATE_REQUIRED;
    set({
      gateLit: lit,
      gateUnlocked: unlockedNow,
      gateUnlockedAt: unlockedNow ? (s.gateUnlockedAt ?? Date.now()) : s.gateUnlockedAt,
    });
    set({ gatePersistFailed: !persistGate(get()) });
    return { ok: true, added: lit.length - s.gateLit.length };
  },

  // 只做并集，永不删：判定逻辑写坏了也不该把已解锁的人打回锁态。
  hydrateGate: () => {
    const record = readGate();
    if (!record) return;
    const s = get();
    const lit = mergeSlots(s.gateLit, record.lit);
    const unlockedNow = s.gateUnlocked || Boolean(record.unlockedAt) || lit.length >= GATE_REQUIRED;
    set({
      gateLit: lit,
      gateUnlocked: unlockedNow,
      gateUnlockedAt: s.gateUnlockedAt ?? record.unlockedAt ?? null,
      gateSeen: Math.max(s.gateSeen, record.seen ?? 0),
    });
  },
  };
});

/** 给组件用的派生读法：判定当场算，不碰存储。 */
export function isGateUnlocked(state: Pick<SimStore, "gateLit" | "gateUnlocked">) {
  return isUnlocked(state);
}

export function loadSettings(): Settings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Settings;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/** 目前只记偏好，不记进度：重置偏好不该顺手删掉解锁状态（那是 gate.ts 的键）。 */
export function bindSettingsPersistence() {
  let prev = "";
  return useSim.subscribe((state) => {
    const next = JSON.stringify({
      v: 1,
      speed: state.speed,
      showLabels: state.showLabels,
      showOrbits: state.showOrbits,
      showTrails: state.showTrails,
      hudAutoHide: state.hudAutoHide,
    });
    if (next === prev) return;
    prev = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* ignore quota */
    }
  });
}
