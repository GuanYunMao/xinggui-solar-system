import { create } from "zustand";
import {
  GATE_REQUIRED,
  canonicalSlots,
  decodeGate,
  encodeGate,
  isUnlocked,
  readGate,
  writeGate,
  type DecodeGateResult,
  type GateSlot,
} from "./gate";

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

type GateSlice = {
  gateLit: GateSlot[];
  gateUnlocked: boolean;
  gateUnlockedAt: number | null;
  gateSeen: number;
};

type SimStore = GateSlice & {
  paused: boolean;
  speed: number;
  showLabels: boolean;
  showOrbits: boolean;
  showTrails: boolean;
  selectedId: string | null;
  days: number;
  resetToken: number;
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
  setDays: (days: number) => void;
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
  restoreGateCode: (raw: string) => DecodeGateResult | { ok: true; added: number };
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

/** 持久化只做记忆：失败返回 false，界面可以提一句，但绝不拦人。 */
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

export const useSim = create<SimStore>((set, get) => ({
  paused: false,
  speed: 1,
  showLabels: true,
  showOrbits: true,
  showTrails: true,
  selectedId: null,
  days: 0,
  resetToken: 0,
  mode: "sandbox",
  switching: null,
  prevSpeed: 1,
  queuedSelectId: null,
  gateLit: [],
  gateUnlocked: false,
  gateUnlockedAt: null,
  gateSeen: 0,

  // 切换中禁「暂停 / 调速」：这两个动作会和切换里写进去的 speed / paused 打架，
  // 与其让玩家看到自己刚拖的滑条被覆盖，不如直接不响应。
  togglePaused: () => {
    if (get().switching) return;
    set((s) => ({ paused: !s.paused }));
  },
  setSpeed: (speed) => {
    if (get().switching) return;
    set({ speed: clampSpeed(speed) });
  },
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  toggleOrbits: () => set((s) => ({ showOrbits: !s.showOrbits })),
  toggleTrails: () => set((s) => ({ showTrails: !s.showTrails })),

  // 切换中禁「选择」：切模式那一刻发一个「场景里还不存在」的目标是 bug 温床。
  // 拦下来存一个，落定后再应用（只存一个，后到的覆盖先到的）。
  select: (selectedId) => {
    if (get().switching) {
      if (selectedId) set({ queuedSelectId: selectedId });
      return;
    }
    set({ selectedId });
  },
  setDays: (days) => set({ days }),

  refocus: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  // 必须一次 set 同时改两个字段：分两次会让 CameraRig 在相邻两帧看到 key 变两次，
  // 起两次聚焦动画（SolarCanvas 的去重键是 `${selectedId}|${resetToken}`）。
  returnTo: (selectedId) => set((s) => ({ selectedId, resetToken: s.resetToken + 1 })),
  // 兼容老调用点（Hud 的 Esc / 关闭详情 / 返回总览 / 底栏总览）：语义一字未变。
  requestReset: () => get().returnTo(null),

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
    set({ switching: null, queuedSelectId: null, ...(queued ? { selectedId: queued } : {}) });
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
    persistGate(get());
  },

  bumpGateSeen: () => {
    set((s) => ({ gateSeen: s.gateSeen + 1 }));
    persistGate(get());
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
    persistGate(get());
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
}));

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
