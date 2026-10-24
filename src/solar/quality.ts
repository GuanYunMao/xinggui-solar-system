import { useSyncExternalStore } from "react";

/**
 * 设备档位与自适应（1.2.0）。
 *
 * 结论先行：**1.2.0 的性能差异来自"每帧画多少像素"和"贴图生成多少像素"，不是几何。**
 * 实测几何 61,216 三角 / 52 draw call，任何 GPU 都不在乎；而画布像素（手机 624×1350 vs
 * 视网膜电脑 2048×1152，2.8 倍）和程序化贴图的生成量才是真成本。所以档位只调两个旋钮：
 *
 *   1. `dprCap` —— 画布的设备像素上限（每帧要光栅的像素数）；
 *   2. `texCap` —— 程序化贴图的宽度上限（启动与放大时要逐像素生成的数量）。
 *
 * 它的消费者只有两处：`<Canvas dpr={[1, dprCap]}>` 与 `textures.textureBudget(px, texCap)`。
 * 天体的**占幅**决定贴图该多大（视距属性），档位只给它一个上限（设备属性）——
 * 这两件事别混：按档位一刀切会让"聚焦一颗行星"在好设备上也糊。
 *
 * 为什么不用 `hardwareConcurrency` / `deviceMemory` 分档：实测两档都是 14 / 32，零区分力。
 * 唯一有区分力的信号是 `(pointer: coarse)` + 视口宽。GPU 字符串**只进诊断日志，绝不参与分档**
 * （同一张显卡在不同驱动/省电策略下差别很大，而它又最容易骗过基准测试）。
 */

export type TierId = 0 | 1 | 2 | 3;

export type Tier = {
  id: TierId;
  name: string;
  /** 程序化贴图宽度上限（textures.textureBudget 的 cap） */
  texCap: number;
  /** 画布 dpr 上限 */
  dprCap: number;
};

/**
 * 档位表。
 *
 * T2 是**桌面起手档**：它的 texCap 1024 恰好等于现役观感在聚焦档实际用到的尺寸
 * （聚焦一颗行星的圆盘约 320 CSS px × dpr 1.6 ≈ 512 设备像素 → budget 804 → 取 1024），
 * 所以桌面默认观感一个像素都没降；T3 留给"把一颗星拉到占满屏"的情况。
 * T0 是手机起手档：dpr 1.25 是红线（手机不得低于它），texCap 256 只影响放大后的清晰度，
 * 总览档本来就全在 128 的下限上，一分钱都省不下来也不该省。
 */
export const TIERS: readonly Tier[] = [
  { id: 0, name: "省电", texCap: 256, dprCap: 1.25 },
  { id: 1, name: "平衡", texCap: 512, dprCap: 1.6 },
  { id: 2, name: "高清", texCap: 1024, dprCap: 1.6 },
  { id: 3, name: "视网膜", texCap: 2048, dprCap: 1.6 },
];

/**
 * 自适应阈值。
 *
 * ⚠ **全部未验证**：数值来自 SwiftShader 软件光栅的推演（这台机构的验收夹具）与 t11 的
 * 「26ms 稳态上限」，没有任何真机校准。改之前按 t11 的口径量一遍相对基线，别用绝对毫秒拍脑袋。
 *
 * 设计取向：**抖动的降级比不降级更伤体验**。所以升级要"一直很快"（60 帧 p95 ≤ 12ms），
 * 降级要"一直很慢且连续两轮"（120 帧 p95 ≥ 26ms，轮与轮之间还有 30 帧采样间隔），
 * 冷却 3s，全程最多变 4 次 —— 一次会话里档位翻来覆去是比低一档难看得多的 bug。
 */
export const QUALITY_HYSTERESIS = {
  /** 跳过首屏：贴图生成与首编译都在这一段，不能拿它判设备 */
  warmupFrames: 60,
  /** 升级判据窗口（帧） */
  upWindow: 60,
  /** 降级判据窗口（帧） */
  downWindow: 120,
  /** 降级要连续几轮坏帧（每轮隔着 sampleEvery 帧） */
  downRounds: 2,
  /** 窗口内 p95 ≤ 它就升档（ms） */
  upP95Ms: 12,
  /** 窗口内 p95 ≥ 它就降档（ms） */
  downP95Ms: 26,
  /** 两次变化之间的最小间隔（ms） */
  cooldownMs: 3000,
  /** 一次会话里最多变化几次 */
  maxChanges: 4,
  /** 每多少帧评估一次 */
  sampleEvery: 30,
} as const;

type State = {
  tier: TierId;
  /** 当前档位的触发原因（起手原因或最近一次变化的原因） */
  reason: string;
  /** 已经变化过几次 */
  changes: number;
  /** 钉住：不再自适应（`?tier=` / `?quality=off` / `?diag=1`） */
  frozen: boolean;
  /** 自适应是否在工作（= !frozen && !disabled） */
  auto: boolean;
  /** 完全不分流（`?quality=off`）：档位固定 T2，只有它关掉 texCap/dprCap 的上限作用 */
  disabled: boolean;
  frames: number;
  /** 诊断用：GPU 字符串。**不参与分档** */
  gpu: string | null;
  history: { at: number; from: TierId; to: TierId; why: string }[];
};

const samples: number[] = [];
let lastEvalAt = 0;
let lastChangeAt = 0;
let badRounds = 0;
let warmupFrames: number = QUALITY_HYSTERESIS.warmupFrames;

/** 让 URL 覆盖能改单条阈值（`?warmup=`），其余保持具名常量 */
function readOverrides() {
  const out = {
    forced: null as TierId | null,
    disabled: false,
    frozen: false,
    notes: [] as string[],
  };
  if (typeof window === "undefined") return out;
  const sp = new URLSearchParams(window.location.search);
  const raw = sp.get("tier");
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 3) {
      out.forced = n as TierId;
      out.frozen = true;
      out.notes.push(`[quality] ?tier=${n} → 强制 T${n}（自适应关闭）`);
    } else {
      out.notes.push(`[quality] ?tier=${raw} 无效（只接受 0..3），忽略`);
    }
  }
  if (sp.get("quality") === "off") {
    out.disabled = true;
    out.frozen = true;
    out.notes.push("[quality] ?quality=off → 完全不分流（T2，自适应关闭）");
  }
  if (sp.has("diag")) {
    out.frozen = true;
    out.notes.push("[quality] ?diag=1 → 档位钉在起手档（诊断要可复现，不跟着帧时间漂）");
  }
  // 注意：`Number(sp.get("warmup"))` 在"没这个参数"时是 `Number(null) = 0`，
  // 会被当成合法的 0 帧 warmup 把首屏也算进来 —— 必须先 has() 再取值。
  if (sp.has("warmup")) {
    const warm = Number(sp.get("warmup"));
    if (Number.isFinite(warm) && warm >= 0) {
      warmupFrames = warm;
      if (typeof console !== "undefined") console.log(`[quality] ?warmup=${warm} → warmupFrames=${warm}`);
    } else if (typeof console !== "undefined") {
      console.log(`[quality] ?warmup=${sp.get("warmup")} 无效（要 ≥0 的数），用默认 ${QUALITY_HYSTERESIS.warmupFrames}`);
    }
  }
  return out;
}

/** 分档：只看指针类型 + 视口宽。两个信号都在 CSS 像素空间，与设备像素密度无关。 */
function detect(): { tier: TierId; reason: string } {
  if (typeof window === "undefined") return { tier: 2, reason: "无 window（服务端/测试环境）→ 桌面档" };
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const width = window.innerWidth;
  if (coarse && width <= 500) return { tier: 0, reason: `(pointer: coarse) + 视口 ${width}px ≤ 500 → 手机档起手` };
  if (coarse) return { tier: 2, reason: `(pointer: coarse) 但视口 ${width}px > 500 → 桌面档起手` };
  return { tier: 2, reason: `fine pointer（视口 ${width}px）→ 桌面档起手` };
}

const overrides = readOverrides();
const start = detect();
const state: State = {
  tier: overrides.forced ?? (overrides.disabled ? 2 : start.tier),
  reason: overrides.forced !== null ? `?tier=${overrides.forced} 强制` : overrides.disabled ? "?quality=off" : start.reason,
  changes: 0,
  frozen: overrides.frozen,
  auto: !overrides.frozen,
  disabled: overrides.disabled,
  frames: 0,
  gpu: null,
  history: [],
};

if (typeof console !== "undefined") {
  for (const line of overrides.notes) console.log(line);
  console.log(`[quality] 起手 T${state.tier}「${TIERS[state.tier].name}」：${state.reason}`);
}

const subs = new Set<() => void>();

function notify() {
  for (const fn of subs) {
    try {
      fn();
    } catch {
      /* 订阅者崩了不该把档位系统带崩 */
    }
  }
}

/** 供 useSyncExternalStore 用：返回**原始值**，快照稳定 */
export function subscribeQuality(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function getQualityTier(): TierId {
  return state.tier;
}

export function tierOf(id: TierId = state.tier): Tier {
  return TIERS[id] ?? TIERS[2];
}

/** 当前档位的贴图宽度上限（textures.textureBudget 的 cap） */
export function texCap(): number {
  return tierOf().texCap;
}

/** 当前档位的画布 dpr 上限 */
export function dprCap(): number {
  return tierOf().dprCap;
}

/** r3f 里拿当前档位（tier 变化会触发重渲染，Canvas 的 dpr prop 才是真生效点） */
export function useQualityTier(): Tier {
  const id = useSyncExternalStore(subscribeQuality, getQualityTier, getQualityTier);
  return tierOf(id);
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function change(to: TierId, why: string) {
  const from = state.tier;
  if (from === to) return;
  state.tier = to;
  state.reason = why;
  state.changes++;
  lastChangeAt = performance.now();
  state.history.push({ at: Math.round(lastChangeAt), from, to, why });
  if (state.history.length > 8) state.history.shift();
  badRounds = 0;
  if (typeof console !== "undefined") {
    console.log(`[quality] T${from}「${TIERS[from].name}」→ T${to}「${TIERS[to].name}」：${why}`);
  }
  notify();
}

/**
 * 每帧喂一次帧间隔（ms）。由 SolarCanvas 的 Simulation 调用 —— 它已经每帧跑，且拿到的
 * `delta` 就是 r3f 的真实帧间隔（含渲染），不用另起一个 rAF 循环去猜。
 */
export function noteFrame(dtMs: number) {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return;
  state.frames++;
  if (state.frames <= warmupFrames) return;
  samples.push(dtMs);
  if (samples.length > QUALITY_HYSTERESIS.downWindow) samples.shift();
  if (!state.auto || state.changes >= QUALITY_HYSTERESIS.maxChanges) return;
  if (state.frames % QUALITY_HYSTERESIS.sampleEvery !== 0) return;
  if (samples.length < QUALITY_HYSTERESIS.upWindow) return;
  const now = performance.now();
  if (now - lastChangeAt < QUALITY_HYSTERESIS.cooldownMs) return;
  lastEvalAt = now;

  const upSlice = [...samples.slice(-QUALITY_HYSTERESIS.upWindow)].sort((a, b) => a - b);
  const upP95 = percentile(upSlice, 0.95);
  if (upP95 <= QUALITY_HYSTERESIS.upP95Ms && state.tier < 3) {
    change((state.tier + 1) as TierId, `近 ${QUALITY_HYSTERESIS.upWindow} 帧 p95=${upP95.toFixed(1)}ms ≤ ${QUALITY_HYSTERESIS.upP95Ms}ms`);
    return;
  }
  if (samples.length >= QUALITY_HYSTERESIS.downWindow) {
    const downSlice = [...samples].sort((a, b) => a - b);
    const downP95 = percentile(downSlice, 0.95);
    if (downP95 >= QUALITY_HYSTERESIS.downP95Ms && state.tier > 0) {
      badRounds++;
      if (badRounds >= QUALITY_HYSTERESIS.downRounds) {
        change(
          (state.tier - 1) as TierId,
          `近 ${QUALITY_HYSTERESIS.downWindow} 帧 p95=${downP95.toFixed(1)}ms ≥ ${QUALITY_HYSTERESIS.downP95Ms}ms（连续 ${badRounds} 轮）`,
        );
      }
    } else {
      badRounds = 0;
    }
  }
}

/** 诊断用：记下 GPU 字符串（只进报告与日志，**不参与分档**） */
export function noteGpu(renderer: string) {
  state.gpu = renderer;
  if (typeof console !== "undefined") console.log(`[quality] gpu（仅诊断）: ${renderer}`);
}

/** `window.__solarQuality()` 的内容 */
export function qualityReport() {
  const t = tierOf();
  return {
    tier: state.tier,
    name: t.name,
    texCap: t.texCap,
    dprCap: t.dprCap,
    reason: state.reason,
    changes: state.changes,
    auto: state.auto,
    frozen: state.frozen,
    disabled: state.disabled,
    frames: state.frames,
    gpu: state.gpu,
    history: state.history,
    lastEvalAt: Math.round(lastEvalAt),
    thresholds: { ...QUALITY_HYSTERESIS, warmupFrames },
  };
}

/** 把探针挂到 window（由 SolarCanvas 的探针总装处调用） */
export function installQualityProbe() {
  if (typeof window === "undefined") return;
  (window as unknown as { __solarQuality?: () => ReturnType<typeof qualityReport> }).__solarQuality = qualityReport;
}
