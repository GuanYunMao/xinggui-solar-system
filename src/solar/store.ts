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
};

function clampSpeed(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(8, Math.max(0.2, value));
}

/**
 * 模拟钟的历元：`simSeconds = 0` 对应这个日历时刻（J2000.0，天文惯用历元）。
 *
 * ⚠ 本项目的轨道相位是手调的，**没有按真实星历标定**：这个历元只决定
 * `setSimTime(Date)` 怎么换算成秒，不代表"2000-01-01 那天行星真在那个位置"。
 * 要真日历，得先把 data.ts 的 phase / period 换成 JPL 的初值 —— 那是另一件事。
 */
export const SIM_EPOCH_MS = Date.UTC(2000, 0, 1, 12);

/** 模拟秒 → HUD 的「第 N 日」（压缩时间轴：EARTH_PERIOD 秒 = 365.25 日）。 */
export function daysOf(simSeconds: number) {
  return (simSeconds / EARTH_PERIOD) * 365.25;
}

/**
 * HUD 历法写回的节流。
 *
 * 为什么需要它：`simSeconds` 每帧都变，而 Hud 读的是 `state.days`。如果每帧都写 days，
 * HUD 会每帧重渲染；改造前是 0.25 s 写一次，这里保持同一个刷新率。
 * 放模块级而不是 state：它只是节流用的时间戳，不是任何 UI 的真相。
 */
let lastDaysWrite = 0;

type GateSlice = {
  gateLit: GateSlot[];
  gateUnlocked: boolean;
  gateUnlockedAt: number | null;
  gateSeen: number;
  /** 最近一次写盘失败：只用来在面板上说一句真话，**不参与判定**。 */
  gatePersistFailed: boolean;
};

type SimStore = GateSlice & {
  paused: boolean;
  speed: number;
  showLabels: boolean;
  showOrbits: boolean;
  showTrails: boolean;
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
  togglePaused: () => void;
  setSpeed: (speed: number) => void;
  toggleLabels: () => void;
  toggleOrbits: () => void;
  toggleTrails: () => void;
  select: (id: string | null) => void;
  /** 唯一的时间推进点：每帧由 Simulation 调；`paused` 时自吞。 */
  advanceSim: (dt: number) => void;
  /**
   * 把模拟钟拨到某一时刻 —— 用户要的「时间以后要能改」的地基（本轮不做 UI）。
   * `number` = 模拟秒；`Date` = 以 `SIM_EPOCH_MS` 为 t=0 换算成秒。
   */
  setSimTime: (when: number | Date) => void;
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
  /*
   * 「看过三颗并且回得去」这一条要在两个时刻都判：
   * 第 3 次切换目标那一刻，以及按 Esc 回总览那一刻——顺序反过来也得算数。
   */
  const maybeHitTarget = () => {
    const s = get();
    if (s.gateLit.includes("target")) return;
    if (s.hops >= 3 && s.everReset) get().hitGate("target");
  };

  return {
  paused: false,
  speed: 1,
  showLabels: true,
  showOrbits: true,
  showTrails: true,
  selectedId: null,
  simSeconds: 0,
  days: 0,
  resetToken: 0,
  hops: 0,
  everReset: false,
  mode: "sandbox",
  switching: null,
  prevSpeed: 1,
  queuedSelectId: null,
  gateLit: [],
  gateUnlocked: false,
  gateUnlockedAt: null,
  gateSeen: 0,
  gatePersistFailed: false,

  // 切换中禁「暂停 / 调速」：这两个动作会和切换里写进去的 speed / paused 打架，
  // 与其让玩家看到自己刚拖的滑条被覆盖，不如直接不响应。
  togglePaused: () => {
    if (get().switching) return;
    set((s) => ({ paused: !s.paused }));
    // 门·time：碰过时间就算（暂停/继续都算一次"我动过时间了"）
    get().hitGate("time");
  },
  setSpeed: (speed) => {
    if (get().switching) return;
    const next = clampSpeed(speed);
    set({ speed: next });
    // 门·time：拖到两端才算。hydrate() 直接 set speed，不走这里，所以进游戏不会白送。
    if (next >= 4 || next <= 0.5) get().hitGate("time");
  },
  // 门·layer：关掉任意一层拐仗（名称/轨道/尾迹）就算；打开不算。
  toggleLabels: () => {
    set((s) => ({ showLabels: !s.showLabels }));
    if (!get().showLabels) get().hitGate("layer");
  },
  toggleOrbits: () => {
    set((s) => ({ showOrbits: !s.showOrbits }));
    if (!get().showOrbits) get().hitGate("layer");
  },
  toggleTrails: () => {
    set((s) => ({ showTrails: !s.showTrails }));
    if (!get().showTrails) get().hitGate("layer");
  },

  // 切换中禁「选择」：切模式那一刻发一个「场景里还不存在」的目标是 bug 温床。
  // 拦下来存一个，落定后再应用（只存一个，后到的覆盖先到的）。
  select: (selectedId) => {
    const s = get();
    if (s.switching) {
      if (selectedId) set({ queuedSelectId: selectedId });
      return;
    }
    if (selectedId && selectedId !== s.selectedId) {
      // 门·target：只数"真的换了目标"，同一颗点两次不算
      set({ selectedId, hops: s.hops + 1 });
      maybeHitTarget();
      return;
    }
    set({ selectedId });
  },
  /*
   * 时间推进：唯一的生产端。**实境的冻结不在这里**（store 不知道系统单位），
   * 由 Simulation 决定这一帧要不要调它 —— 冻结因此发生在生产端，而不是像改造前那样
   * 在消费端把时间读成 0（那会让"在实境待 5 分钟再回沙盘，模拟历凭空跳过 5 分钟"）。
   */
  advanceSim: (dt) => {
    const s = get();
    if (s.paused) return;
    const next = s.simSeconds + dt * s.speed;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastDaysWrite >= 250) {
      lastDaysWrite = now;
      const d = daysOf(next);
      if (Math.abs(d - s.days) > 0.2) {
        set({ simSeconds: next, days: d });
        return;
      }
    }
    set({ simSeconds: next });
  },

  setSimTime: (when) => {
    const seconds = typeof when === "number" ? when : (when.getTime() - SIM_EPOCH_MS) / 1000;
    // 非有限值一律不写：钟停着是"没反应"，写进去会让整条时间轴变 NaN，
    // 之后每个天体的位置、每个投影都是 NaN —— 那比不动难查一百倍。
    if (!Number.isFinite(seconds)) return;
    lastDaysWrite = 0; // 下一帧立刻把 HUD 对齐（否则最多迟 0.25 s）
    set({ simSeconds: seconds, days: daysOf(seconds) });
  },

  refocus: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  // 必须一次 set 同时改两个字段：分两次会让 CameraRig 在相邻两帧看到 key 变两次，
  // 起两次聚焦动画（SolarCanvas 的去重键是 `${selectedId}|${resetToken}`）。
  returnTo: (selectedId) => set((s) => ({ selectedId, resetToken: s.resetToken + 1 })),
  // 兼容老调用点（Hud 的 Esc / 关闭详情 / 返回总览 / 底栏总览）：语义一字未变。
  requestReset: () => {
    get().returnTo(null);
    set({ everReset: true });
    maybeHitTarget();
  },

  setMode: (mode) => {
    const s = get();
    if (s.switching || s.mode === mode) return;
    if (mode === "real") {
      // 硬门：没解锁就没有这个目的地。入口只会在 UI 层被禁用，这里再守一层。
      if (!isUnlocked(s)) return;
      set({ mode: "real", switching: "toReal", prevSpeed: s.speed, speed: 1, paused: false });
      armSwitchTimeout();
      return;
    }
    // 回沙盘：mode 与「目标回位」同一拍发出，全程只让 CameraRig 起一次动画。
    clearSwitchTimeout();
    set({
      mode: "sandbox",
      switching: "toSandbox",
      speed: s.prevSpeed || 1,
      selectedId: s.selectedId,
      resetToken: s.resetToken + 1,
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
      speed: clampSpeed(settings.speed ?? 1),
      showLabels: settings.showLabels ?? true,
      showOrbits: settings.showOrbits ?? true,
      showTrails: settings.showTrails ?? true,
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
