import { ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Clock, Layers, LocateFixed, Orbit, Pause, Play, Sparkles, Tag } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { ModeBadge } from "./ModeBadge";
import { OrbitGlyph } from "./BrandMark";
import { APP_ERA_NAME, compressionLine, formatDistanceMeters, snapshotTag, versionLabel } from "./brand";
import type { Body } from "./data";
import { bindSettingsPersistence, DAYS_PER_SIM_SECOND, DAYS_PER_YEAR, daysPerRealSecond, daysOf, isGateUnlocked, loadSettings, SECONDS_PER_SIM_SECOND, useSim } from "./store";
import { useSystem } from "./system-context";

/**
 * HUD 的结构（R5 重构后，1.2.0 加了设备密度）：
 *
 *   Hud                     ← 唯一的模式判断点（模式只在这里读一次、分一次支）
 *   ├─ SandboxHud           ← 导航台：芯片行 + 卫星行 + 详情卡 + 底栏
 *   │   ├─ HudHeader trailing={<Epoch/>}
 *   │   ├─ Chips（窄屏带渐隐提示）/ Moons
 *   │   └─ SandboxCard（窄屏三档手柄）| EmptyHint
 *   │   └─ Dock（窄屏 3 键 + 图层浮层 / 宽屏 5 键）
 *   └─ RealHud              ← 航行仪表：只有品牌 + 徽标 + 详情卡
 *       ├─ HudHeader
 *       └─ RealCard
 *
 * 关键取舍：**「实境里不显示某样东西」不再是运行时条件，而是那个组件不在树里。**
 * 密度同理：窄屏的差异长成**不同的组件分支**（3 键 + 浮层），不是给 5 键加 `hidden`。
 * 所以 1.2.0 加设备维度时，每个模式内部各分一层，互不干扰。
 */

/**
 * 窄屏判定：**跟宽度走，不跟指针类型走**。
 * 密度是"装不装得下"的问题，不是"有没有手指"的问题——外接键盘的平板仍然装不下 5 个键加文字。
 * 640px 与 Tailwind 的 `sm` 同界，所以这里的判断与 CSS 里的 `sm:` 不会打架。
 * 用 matchMedia 而不是一次性读 innerWidth：转屏/拖动窗口会触发 change，密度随之重算（t39 第 4 条）。
 */
function useCompact() {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = () => setCompact(mq.matches);
    onChange(); // 首帧后再对齐一次，避免挂载期间窗口已经变过
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

/* ─────────────────── t12：chrome（顶部天体行 + 底栏）的空闲收起 ─────────────────── */

/**
 * 用户原话：「顶上那一排星球可点击按钮做成一个可以伸缩的开关——鼠标不移动到上面时，
 * 它缩起来，防止挡住界面；包括界面底下的操作台。」
 *
 * 两条独立状态（顶部 / 底栏），同一套规则：
 *
 *  - **桌面（指针精细）**：指针离开该区域 `CHROME_IDLE_MS` 后收起；指针移回（矩形命中）或点把手展开。
 *    计时器**只在真的发生过 pointermove 之后才上膛**——页面刚打开、自动化夹具直接
 *    `locator("#chip-earth").click()` 时，芯片必须还在（否则既有 pass 会集体超时）。
 *  - **窄屏（触屏没有 hover）**：轻点空白收起、点把手展开。**绝不靠 hover 隐藏**：
 *    手指没有 hover，按 hover 做等于永久隐藏。
 *  - 浮层开着（`data-overlay-open`）、指针按着、键盘焦点在该区域里 → 一律不收起。
 *  - `hudAutoHide` 关掉 → 两处常显（把手不渲染），行为退回 1.2.1。
 *
 * N 取值（2.0s）的依据，别凭手感改：面板入场 `panel-in` 是 400ms，芯片
 * `scrollIntoView` 平滑滚动约 300ms；N 必须大于这两者之和的 2 倍，否则会「边看边收」。
 * 下限：< 1.5s 时读模拟历/找芯片的途中就会闪。上限：> 3s 用户会以为界面坏了、开始乱点。
 * 2s 正好落在中间，且给「指针停着不动」留了一段不短的可读时间。
 *
 * 为什么用 window 级 pointermove + 矩形命中，而不是 `onPointerEnter`：
 * HUD 根是 `pointer-events-none`，收起的条本身**不该吃点击**（那是画布的选择热区，
 * 见 t11 的命中矩阵）。矩形判定让「移回就展开」照样成立，而点击仍然漏给画布。
 */
const CHROME_IDLE_MS = 2000;

type ChromeApi = {
  /** 顶部天体行（含卫星行）是否收起 */
  top: boolean;
  /** 底栏是否收起 */
  dock: boolean;
  topRef: RefObject<HTMLDivElement | null>;
  dockRef: RefObject<HTMLDivElement | null>;
  expandTop: () => void;
  expandDock: () => void;
  collapseTop: () => void;
  collapseDock: () => void;
};

const ChromeContext = createContext<ChromeApi | null>(null);
const useChrome = () => useContext(ChromeContext);

/** 浮层开着时禁止自动收起：图层浮层、设定时刻、校准面板都挂 `data-overlay-open`。 */
const overlayOpen = () =>
  typeof document !== "undefined" && Boolean(document.querySelector('[data-overlay-open="true"]'));

function useChromeState({ compact, autoHide }: { compact: boolean; autoHide: boolean }): ChromeApi {
  const [top, setTop] = useState(false);
  const [dock, setDock] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  // 关掉自动收起 → 两处常显（并把已经收起的展开）
  useEffect(() => {
    if (autoHide) return;
    setTop(false);
    setDock(false);
  }, [autoHide]);

  useEffect(() => {
    if (!autoHide || compact) return;
    const timers = { top: 0, dock: 0 };
    let pressing = false;
    let touched = false; // 只有真的移动过指针才上膛（见上面「计时器只在 pointermove 后」）
    const inside = (ref: RefObject<HTMLDivElement | null>, x: number, y: number) => {
      const r = ref.current?.getBoundingClientRect();
      return Boolean(r && r.width > 0 && r.height > 0 && x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4);
    };
    const focusInside = (ref: RefObject<HTMLDivElement | null>) => {
      const active = document.activeElement;
      if (!ref.current || !active || !ref.current.contains(active)) return false;
      /*
       * 只有**键盘给的焦点**才拦住收起。鼠标点过的按钮也留焦点，但 Chromium 不把它算
       * `:focus-visible`（t11 实测：纯鼠标点击后 matches 为 false）；若按 `contains` 一刀切，
       * 「点一下芯片 → 鼠标移开」就永远不收起——正好把这个功能最主力的场景弄废。
       * 键盘 Tab 进来时 `focusin` 会把该区展开，所以这里放行是安全的。
       */
      return typeof active.matches === "function" && active.matches(":focus-visible");
    };
    const arm = (key: "top" | "dock", ref: RefObject<HTMLDivElement | null>, collapse: (v: boolean) => void) => {
      window.clearTimeout(timers[key]);
      timers[key] = window.setTimeout(() => {
        if (!touched || pressing || overlayOpen() || focusInside(ref)) return;
        collapse(true);
      }, CHROME_IDLE_MS);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return; // 触屏不参与 hover 收起
      touched = true;
      if (inside(topRef, event.clientX, event.clientY)) {
        window.clearTimeout(timers.top);
        setTop(false);
      } else {
        arm("top", topRef, setTop);
      }
      if (inside(dockRef, event.clientX, event.clientY)) {
        window.clearTimeout(timers.dock);
        setDock(false);
      } else {
        arm("dock", dockRef, setDock);
      }
    };
    const onDown = () => {
      pressing = true;
    };
    const onUp = () => {
      pressing = false;
    };
    // 指针在窗口外抬起（拖出窗口）时不能永远"按着"：cancel 与 up 同义
    const onCancel = () => {
      pressing = false;
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && topRef.current?.contains(target)) setTop(false);
      if (target && dockRef.current?.contains(target)) setDock(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      window.clearTimeout(timers.top);
      window.clearTimeout(timers.dock);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, [autoHide, compact]);

  /*
   * 窄屏：轻点空白收起。三个坑要一起绕开：
   *  1. 画布上的 tap 会先走 PickLayer 选中 —— 所以延到下一拍看「选中态变没变」，
   *     变了说明点的是天体，不是空白（不收起）；
   *  2. 拖动转视角不是轻点 —— 位移 > 8px 一律不算；
   *  3. **按下那一刻浮层开着**的这一次轻点，只负责关浮层。浮层自己会在 pointerdown 关掉，
   *     等到 pointerup 再判 `overlayOpen()` 已经是 false 了 —— 不加这条，一边关浮层一边把
   *     chrome 收掉，一次轻点干两件事。
   */
  useEffect(() => {
    if (!autoHide || !compact) return;
    let x0 = 0;
    let y0 = 0;
    let overlayAtDown = false;
    const onDown = (event: PointerEvent) => {
      x0 = event.clientX;
      y0 = event.clientY;
      overlayAtDown = overlayOpen();
    };
    const onUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - x0, event.clientY - y0) > 8) return;
      if (overlayAtDown || overlayOpen()) return;
      const target = event.target as Element | null;
      // chrome 自己的空白（标题条、抬头、底栏内边距）不算"空白"：在那里轻点不该把它收掉
      if (target?.closest("[data-hud-chrome], button, input, textarea, select, article, [data-overlay-open]")) return;
      const before = useSim.getState().selectedId;
      window.setTimeout(() => {
        if (useSim.getState().selectedId !== before) return;
        if (overlayOpen()) return;
        setTop(true);
        setDock(true);
      }, 0);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
    };
  }, [autoHide, compact]);

  return {
    top,
    dock,
    topRef,
    dockRef,
    expandTop: () => setTop(false),
    expandDock: () => setDock(false),
    collapseTop: () => setTop(true),
    collapseDock: () => setDock(true),
  };
}

/* ── 时间控件：物理速率 + 对数档位 ── */

/**
 * 对数刻度的档位（t46）：0.05 → 8 共 8 档，相邻比值 2~2.5。
 *
 * 为什么必须对数：线性刻度下 0.05–0.5 这一段只占滑条 6%，手指根本分不出来；
 * 对数刻度把每一"倍"给到同样宽度，低速段才有可用分辨率。
 * 用固定档位而不是连续值：读数要说人话，连续值只会给出「1 秒 = 4.13 天」这种数字。
 */
const SPEED_STOPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 4, 8] as const;
const SPEED_MAX = SPEED_STOPS[SPEED_STOPS.length - 1]!;

/** 从实际速度反推档位下标（按对数距离取最近）——这样 store 夹过的值也能落到正确档上。 */
function stopIndexOf(speed: number) {
  const target = Math.log(Math.max(speed, 1e-6));
  let best = 0;
  let bestDist = Infinity;
  SPEED_STOPS.forEach((stop, index) => {
    const dist = Math.abs(Math.log(stop) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

/**
 * 单位阶梯：**取"装得下它的最大单位"**（值是 1 起步），不是"超过下一单位的 1.5 倍才换"。
 *
 * 为什么改口径：按 1.5 倍阈值时，1 天 = 86400 秒 < 36 小时，于是「×1」被显示成
 * 「1 秒 = 24 小时」—— 数字对、单位错，而且和 t44 定的「1.0× = 1 秒 = 1 天」直接打架。
 * 现在 1 天会落在「天」档：86400 ≥ 86400。
 */
const UNIT_LADDER = [
  { unit: "秒", seconds: 1 },
  { unit: "分钟", seconds: 60 },
  { unit: "小时", seconds: 3600 },
  { unit: "天", seconds: 86400 },
  { unit: "年", seconds: 365.25 * 86400 },
] as const;

/** 1 位小数就够；≥100 时连小数都不给，读数不该比刻度更精确。 */
function trimNumber(value: number) {
  if (value >= 100) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 一秒真实时间过去多久。返回 `{ value, unit }`，由调用点拼成「1 秒 = 1 天」。
 *
 * 入参是 store 的 `daysPerRealSecond(speed)`（每**实**秒推进多少模拟日）——
 * 换算全在 store 里，HUD 只负责选单位。**这里不要再乘 speed、也不要再碰 daysOf**：
 * t44 之前这两条路差 20.3 倍（"每模拟秒" vs "每实秒"）。
 */
function formatRate(daysPerRealSecond: number): { value: string; unit: string } {
  const seconds = Math.max(daysPerRealSecond, 0) * 86400;
  let step: (typeof UNIT_LADDER)[number] = UNIT_LADDER[0];
  for (const entry of UNIT_LADDER) if (seconds >= entry.seconds) step = entry;
  return { value: trimNumber(seconds / step.seconds), unit: step.unit };
}

function formatMultiplier(speed: number) {
  return `×${Number(speed.toFixed(2))}`;
}

/**
 * 历法读数（t44 定案）。
 *
 * 口径：内部保留小数（`simSeconds` 本来就是浮点），显示层 `年 = floor(days / DAYS_PER_YEAR)`、
 * `日 = floor(days % DAYS_PER_YEAR) + 1` —— 日是**1 起算**的"年内第几日"，所以 t=0 显示「第 1 日」。
 * 年长从 store 取（现在是 365.25），HUD 不再写死 365：写死会立刻出现两套历法。
 */
function splitEpoch(days: number) {
  const safe = Math.max(0, days);
  /*
   * EPS 是**显示用的舍入保护**，不是时间精度：连续 +1 年 四次之后 `days` 会带浮点误差
   * （实测 1925.2499999999998，而 1925.25 % 365.25 = 98.9999999999998），
   * 直接 floor 会显示成「5 年 99 日」——比实际的 100 日少一天。
   * 1e-6 天 ≈ 0.086 模拟秒，玩家不可能察觉，但足以把 98.999… 抬回 99。
   */
  const EPS = 1e-6;
  const years = Math.floor(safe / DAYS_PER_YEAR + EPS);
  return { years, day: Math.floor((safe % DAYS_PER_YEAR) + EPS) + 1 };
}

function formatEpoch(days: number) {
  const { years, day } = splitEpoch(days);
  if (years <= 0) return `第 ${day} 日`;
  return `${years} 年 ${day} 日`;
}

export function Hud() {
  // —— 唯一的模式判断点（R5：以前这里有 8 个 `!inReal &&` 分支，现在只剩这一次读取 + 一次分支）——
  const real = useSim((state) => state.mode === "real");

  useHudBootstrap();
  useHudKeyboard(real);
  useKeepChipVisible();

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      {real ? <RealHud /> : <SandboxHud />}
    </div>
  );
}

/* ────────────────────────────── 沙盘：导航台 ────────────────────────────── */

function SandboxHud() {
  const compact = useCompact();
  const autoHide = useSim((state) => state.hudAutoHide);
  const chrome = useChromeState({ compact, autoHide });
  return (
    <ChromeContext.Provider value={chrome}>
      {/* 顶部区：抬头 + 天体行 + 卫星行。收起时这些不进树，只剩把手（见 Chips） */}
      <div ref={chrome.topRef} data-hud-chrome="top" className="shrink-0">
        <HudHeader trailing={<Epoch />} />
        {/* 芯片行是「9 个可去的天体」的导航台 —— 只有沙盘有这个语义 */}
        <Chips compact={compact} />
        <Moons />
      </div>
      <div className="relative min-h-0 flex-1">
        <SandboxCard compact={compact} />
        <EmptyHint />
      </div>
      <div ref={chrome.dockRef} data-hud-chrome="dock" className="shrink-0">
        <Dock compact={compact} />
      </div>
    </ChromeContext.Provider>
  );
}

/* ────────────────────────────── 实境：航行仪表 ────────────────────────────── */

/**
 * 实境最小控件（t22）——只有三样，别加戏：
 *
 *  1. 常显的「回沙盘」出口（抬头右侧，不藏进卡片）：Esc 一直能回去，但玩家不知道；
 *  2. 距离读数：相机到**当前取景目标**的距离，m / km / 万 km 自动换档；
 *  3. 地 / 月 取景切换：`frameEarthMoon` 那一片视野能给的最大动作就是在这两颗之间换。
 *
 * 时间推进 / 暂停 / 速度 / 图层**一律不在实境出现**：那里的时间冻结是 1.1.5 专门修过的
 * 行为（"实境模式下模拟时间停止推进"），加回任何一条都是回滚一个已修的 bug。
 *
 * 黑幕：`App.tsx` 进实境的头 240ms 是不透明且吃指针的。HUD 在 z-10，比黑幕（z-[2]）高，
 * 所以这组控件会被黑幕"盖不住" —— 由 `data-real-veil` + `.real-controls` 的 CSS
 * 在那一瞬间把指针关掉（见 styles.css），不去绕过既有机制。
 */
function RealHud() {
  return (
    <>
      {/*
        实境不显示模拟历，因为**时间在那里不前进**：推进只有一处生产端（SolarCanvas 的
        Simulation 每帧先看 `look.freezesTime`，为真就不调 `advanceSim`），而实境的 look
        把它设成 true —— 所以模拟历会停在进入实境的那一刻，既不涨也不归零。
        停住的数字和坏掉的钟看起来一模一样，所以这里不是"隐藏 Epoch"，是 **Epoch 不在树里**。
      */}
      <HudHeader trailing={<RealExitKey />} />
      <RealInstruments />
      <div className="relative min-h-0 flex-1">
        <RealCard />
      </div>
    </>
  );
}

/** 常显出口。点一次 = `setMode("sandbox")`，和 Esc 走同一条路（选中态与 ?body= 由它维护）。 */
function RealExitKey() {
  const setMode = useSim((state) => state.setMode);
  return (
    <button
      type="button"
      className="hud-btn real-controls inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-sm text-fg md:h-8"
      aria-label="回沙盘"
      onClick={() => setMode("sandbox")}
    >
      <ArrowLeft className="size-4" aria-hidden />
      <span>回沙盘</span>
    </button>
  );
}

/** 距离读数 + 地/月取景切换。读数来源是 `realDistanceM`（t23 的 MeterCamera 喂，10Hz）。 */
function RealInstruments() {
  const distance = useSim((state) => state.realDistanceM);
  const focus = useSim((state) => state.realFocus);
  const setFocus = useSim((state) => state.setRealFocus);
  /*
   * 三个取景：wide（地月同框，默认）/ earth / moon。两个按钮，再点当前目标回落 wide。
   *
   * **标签必须写明自己是"取景目标"**（t22 修）：卡片跟的是 `selectedId`（选中的天体），
   * 距离跟的是 `realFocus`（取景目标）—— 两个数据源本身没错，错的是标签不说自己是哪个源。
   * 切到月球时卡片可能还写着「地球」，所以距离行只写「距月球 / 距地球 / 距地月中点」，
   * 不写「到月球」这种会被读成"你正在看的那颗"的措辞。
   */
  const targetName = focus === "moon" ? "月球" : focus === "earth" ? "地球" : "地月中点";
  const option = (value: "earth" | "moon", label: string) => (
    <button
      key={value}
      type="button"
      className={`hud-btn inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs md:h-8 ${
        focus === value ? "border-accent bg-accent text-accent-fg" : "border-line bg-elevated text-fg"
      }`}
      aria-label={`${label}取景`}
      aria-pressed={focus === value}
      onClick={() => setFocus(value)}
    >
      {label}
    </button>
  );
  return (
    <div
      className="real-controls real-instruments pointer-events-auto mt-1 flex items-center justify-between gap-2 px-4 md:mt-2 md:px-6"
      data-real-focus={focus}
    >
      <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted">
        <span className="hidden shrink-0 font-mono text-[10px] tracking-widest text-subtle sm:inline">RANGE</span>
        <span data-real-distance={formatDistanceMeters(distance)} className="real-distance shrink-0 text-sm tabular-nums text-fg">
          {formatDistanceMeters(distance)}
        </span>
        <span className="min-w-0 truncate text-subtle">距{targetName}</span>
      </p>
      <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="取景目标">
        {option("earth", "地球")}
        {option("moon", "月球")}
      </div>
    </div>
  );
}

/* ────────────────────────────── 共用：抬头 ────────────────────────────── */

/**
 * 抬头。信息只有三层，从主到次：
 *
 *   品牌行（图标 + 代际名，版本号宽屏才出）   →   模式徽标   →   模拟历
 *
 * 窄屏的取舍：**版本号让位，模拟历不让**。版本号是给开发者看的一次性信息，
 * 模拟历是玩家一直在读的量；两者都要位置时，先砍前者。
 * 徽标与历法是同一层（区划 + 读数），所以放在同一个右侧容器里，中间只隔一条细线。
 */
function HudHeader({ trailing }: { trailing?: ReactNode }) {
  return (
    <header className="hud-header flex items-center justify-between gap-2 px-4 pt-3 md:gap-3 md:px-6 md:pt-6">
      <div className="brand-lockup sky-title flex min-w-0 items-center gap-2.5">
        <div className="brand-emblem">
          <OrbitGlyph className="size-7 shrink-0 md:size-8" />
        </div>
        <h1 className="min-w-0">
          <span className="brand-era">
            {APP_ERA_NAME}
            <span className="brand-code">XG—01</span>
          </span>
          <span className="brand-subtitle block">SOLAR CARTOGRAPHY</span>
        </h1>
        <span className="eyebrow hidden text-[10px] text-subtle sm:inline">{versionLabel(__APP_VERSION__)}</span>
      </div>
      <div className="hud-header-actions pointer-events-auto flex shrink-0 items-center gap-1.5 md:gap-3">
        <ModeBadge />
        {trailing}
      </div>
    </header>
  );
}

/** 模拟历（沙盘专用，所以它只被 SandboxHud 引用）。 */
function Epoch() {
  const paused = useSim((state) => state.paused);
  const days = useSim((state) => state.days);
  return (
    <div className="epoch-readout sky-title shrink-0 whitespace-nowrap" data-paused={paused ? "true" : "false"}>
      <span className="epoch-label">{paused ? "HOLD / 已暂停" : "T+ / 模拟历"}</span>
      <p className="text-lg tabular-nums text-fg">{formatEpoch(days)}</p>
    </div>
  );
}

/* ────────────────────────────── 共用：选择器 ────────────────────────────── */

function Chips({ compact }: { compact: boolean }) {
  const selectedId = useSim((state) => state.selectedId);
  const select = useSim((state) => state.select);
  const { byId, chips } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  const rowRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const [open, setOpen] = useState(false);
  const expanded = compact ? open : true;
  const chrome = useChrome();

  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  }, []);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const id = useSim.getState().selectedId;
    if (!id) return;
    document.getElementById(`chip-${id}`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [expanded]);

  if (chrome?.top) {
    return (
      <div className="body-nav relative">
        <div className="px-4 pb-1 md:px-6">
          <button
            type="button"
            className="hud-btn chrome-in pointer-events-auto inline-flex h-11 items-center gap-2 border px-3 text-sm text-fg md:h-9 md:text-xs"
            aria-label="展开天体列表"
            aria-expanded={false}
            onClick={chrome.expandTop}
          >
            <span className="tracking-[0.15em] text-muted">NAV / 天体</span>
            <span className="max-w-[8rem] truncate">{selected ? selected.name : "未选择"}</span>
            <span className="font-mono text-[10px] text-subtle">{String(chips.length).padStart(2, "0")}</span>
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="body-nav relative">
      <div className="nav-caption pointer-events-none flex items-center justify-between gap-2 px-4 pb-1 md:px-6">
        {compact ? (
          <p className="flex min-w-0 items-baseline gap-2 text-xs text-subtle">
            <span className="tracking-[0.15em] text-muted">NAV / 天体</span>
            <span className="truncate font-sans text-fg">{selected ? selected.name : "未锁定"}</span>
          </p>
        ) : (
          <span>NAV / 天体索引</span>
        )}
        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          {!compact && <span>01—{String(chips.length).padStart(2, "0")}</span>}
          {compact && (
            <button
              type="button"
              className="hud-btn inline-flex h-8 shrink-0 items-center gap-1 border px-2.5 text-xs text-muted"
              aria-label="天体列表"
              aria-expanded={open}
              onClick={() => setOpen((previous) => !previous)}
            >
              {expanded ? "收起" : `全部 ${chips.length}`}
              <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="hud-btn inline-flex h-8 shrink-0 items-center justify-center gap-1 border px-2 text-xs text-muted"
            aria-label="收起天体列表"
            aria-expanded={true}
            title="收起天体索引"
            onClick={() => {
              setOpen(false);
              chrome?.collapseTop();
            }}
          >
            <ChevronUp className="size-3.5" aria-hidden />
            <span className="hidden md:inline">收起</span>
          </button>
        </div>
      </div>

      <div
        ref={rowRef}
        id="chip-row"
        data-label-occluder={compact && open ? "true" : undefined}
        className={
          expanded
            ? "chip-row pointer-events-auto flex flex-wrap gap-1.5 px-4 pb-1 md:gap-2 md:px-6"
            : "chip-row pointer-events-auto flex gap-2 overflow-x-auto px-4 pb-1 md:px-6"
        }
      >
        {chips.map((body, index) => {
          const moonOfThis = selected?.parent === body.id && selected.parent !== "sun";
          const active = selectedId === body.id || moonOfThis;
          return (
            <button
              key={body.id}
              id={`chip-${body.id}`}
              type="button"
              className="hud-btn inline-flex h-11 shrink-0 items-center gap-2 border px-3 text-sm"
              aria-pressed={active}
              onClick={() => {
                select(body.id);
                if (compact) setOpen(false);
              }}
            >
              <span className="size-1.5 rounded-full" style={{ backgroundColor: body.swatch }} aria-hidden />
              <span className="chip-index" aria-hidden>{String(index + 1).padStart(2, "0")}</span>
              <span>{body.name}</span>
            </button>
          );
        })}
      </div>
      {edge.right && !expanded && (
        <div data-fade="right" className="pointer-events-none absolute inset-y-0 right-0 z-[1] flex w-12 items-center justify-end pr-1">
          <ChevronRight className="size-4 text-muted" aria-hidden />
          <span className="sr-only">右侧尚有天体，横向滑动展开</span>
        </div>
      )}
      {edge.left && !expanded && (
        <div data-fade="left" className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-8" />
      )}
    </div>
  );
}

/**
 * 卫星行：卫星在三维场景里太小，靠手点很难命中；选中母行星时把它的卫星排成一行。
 * 注意 chips 是「无 parent 或 parent 是太阳」的天体，不是卫星，别让它变成「太阳的卫星」。
 */
function Moons() {
  const selectedId = useSim((state) => state.selectedId);
  const select = useSim((state) => state.select);
  const { byId, byParent } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  const group = selected
    ? selected.parent && selected.parent !== "sun"
      ? byId[selected.parent]
      : selected
    : undefined;
  const moons = group && group.id !== "sun" ? (byParent.get(group.id) ?? []) : [];
  const chrome = useChrome();
  if (moons.length === 0) return null;
  // 顶部收起时卫星行跟着一起收（它是同一块 chrome，不能留半行悬在那儿）
  if (chrome?.top) return null;
  return (
    <div className="chip-row pointer-events-auto mt-1 flex gap-2 overflow-x-auto px-4 pb-1 md:px-6">
      <span className="inline-flex h-9 shrink-0 items-center text-xs text-subtle">
        {group?.name}的卫星
      </span>
      {moons.map((moon) => (
        <button
          key={moon.id}
          id={`chip-${moon.id}`}
          type="button"
          className={`hud-btn inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-xs ${
            selectedId === moon.id
              ? "border-accent bg-accent text-accent-fg"
              : "border-line bg-elevated text-fg"
          }`}
          aria-pressed={selectedId === moon.id}
          onClick={() => select(moon.id)}
        >
          <span className="size-1.5 rounded-full" style={{ backgroundColor: moon.swatch }} />
          {moon.name}
        </button>
      ))}
    </div>
  );
}

/* ────────────────────────────── 共用：详情卡 ────────────────────────────── */

/**
 * t28：未解锁时，每颗天体的卡片底部给一句**观察线索**（答案藏在卡片里）。
 * t46：整组改成**航行日志腔（B）**里的"未结条目"——仍是提问（提问是这个门的骨架，
 * 不是讲课），但无人称、术语与卡片一致（公转 / 自转 / 自转轴 / 绕地一周），
 * 不用「它跑了」这种拟人。解锁后整段不渲染。
 */
const CARD_CLUES: Record<string, string> = {
  sun: "太阳不动，行星皆动。为何？",
  mercury: "水星公转一周，多久？",
  venus: "金星自转一周，长于其公转？",
  earth: "一年是多久？",
  mars: "火星公转，为何慢于地球？",
  jupiter: "木星公转，为何慢于火星？",
  saturn: "土星公转一周，几年？",
  uranus: "天王星自转轴，为何近乎躺倒？",
  neptune: "海王星最远，公转最慢？",
  moon: "月球绕地一周，多久？",
  default: "公转一周，多久？",
};

/**
 * 卡片外壳。手机端是底部抽屉（原来贴在顶部，选中行星时正好盖住星球）；
 * 竖屏时镜头会把星球抬到上半屏。
 *
 * 结构是「手柄 + 滚动区」两层，**手柄在滚动区外面**：
 * 一开始把手柄做成 `sticky top-0` 放在滚动区里，滚动时正文会从手柄上方的内边距条里露出来
 * （实测：卡片顶部能看到被裁掉半行字）。手柄挪出来以后，正文只在自己的框里滚。
 * 宽屏（`md:`）那张卡没有手柄，只有滚动区 —— 视觉与 1.1.0 完全一致（`p-4` 从 article 挪到了
 * 滚动区里，渲染结果相同）。
 */
function CardShell({
  id,
  maxHeight,
  sheetStop,
  dragging = false,
  handle,
  onBodyClick,
  children,
}: {
  id: string;
  maxHeight?: string;
  sheetStop?: SheetStop;
  dragging?: boolean;
  handle?: ReactNode;
  /** 窄屏：点卡片本体也能开合。桌面不传，避免和「返回总览」抢点击。 */
  onBodyClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <article
      key={id}
      style={maxHeight ? { maxHeight } : undefined}
      data-sheet-stop={sheetStop}
      data-label-occluder="true"
      data-dragging={dragging ? "true" : undefined}
      className="panel-in pointer-events-auto absolute inset-x-3 bottom-3 flex max-h-[44dvh] flex-col overflow-hidden border md:inset-x-auto md:top-4 md:right-6 md:bottom-auto md:w-80"
    >
      {handle}
      <div className="min-h-0 flex-1 overflow-y-auto p-4" onClick={onBodyClick}>
        {children}
      </div>
    </article>
  );
}

function CardHead({ body, close, note }: { body: Body; close: ReactNode; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="card-catalog">
          <span>{body.kind}</span>
          <span className="text-subtle">/ {body.id.toUpperCase()}</span>
          {note && <span className="text-subtle">· {note}</span>}
        </p>
        <h2 className="font-display mt-1 text-xl leading-tight text-fg md:text-2xl">{body.name}</h2>
      </div>
      {close}
    </div>
  );
}

function CardBody({ body, stackFacts = false }: { body: Body; stackFacts?: boolean }) {
  return (
    <>
      <p className="mt-3 text-[13px] leading-6 text-muted">{body.blurb}</p>
      <dl className={`mt-3 grid ${stackFacts ? "grid-cols-1" : "grid-cols-2"}`}>
        {body.facts.map((fact) => (
          <div key={fact.label} className="px-3 py-2">
            <dt className="text-xs text-muted">{fact.label}</dt>
            <dd className="mt-1 text-sm text-fg tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** 手机端抽屉上的关闭键；`className` 由两侧分别决定是否在桌面隐藏。 */
function CloseButton({ className = "" }: { className?: string }) {
  const requestReset = useSim((state) => state.requestReset);
  return (
    <button
      type="button"
      className={`hud-btn -mr-1 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-subtle ${className}`}
      aria-label="关闭详情"
      onClick={requestReset}
    >
      ✕
    </button>
  );
}

/* ── 详情卡的三档高度（窄屏） ── */

type SheetStop = "bar" | "half" | "full";
const SHEET_STOPS: SheetStop[] = ["bar", "half", "full"];
/**
 * 收起态只保留 28px 手柄与一行名称，实际内容约 70px；正文、事实与按钮全部退出布局。
 * 7rem 只是 max-height 与拖档位，不会把标题条强行撑高。镜头读取的是真实面板边界。
 */
const SHEET_MAX: Record<SheetStop, string> = { bar: "7rem", half: "44dvh", full: "76dvh" };
/** 手柄的读屏文本。视觉上只有一个握把条 —— 握把条不需要翻译，读屏需要一句话。 */
const SHEET_LABEL: Record<SheetStop, string> = { bar: "收起", half: "半屏", full: "全屏" };

/**
 * **换档的最小位移**。手指在把手上蹭出来的几像素不算拖拽 —— 那只是点击时的手抖。
 * 低于这个值：位移一律不跟手，松手当点击处理。
 */
const DRAG_COMMIT_PX = 40;
/**
 * **不算点击的位移**。超过它就不是点击了：松手后浏览器补的那个 `click` 要被吃掉。
 * 少了这一条，30px 的横向"蹭"仍然会走 `onClick` → 卡片凭空换一档，
 * 也就是用户报的"轻轻一动就跳走"（实测第一版：15px 就把半屏收成了标题条）。
 */
const TAP_SLOP_PX = 5;

/**
 * 详情卡抽屉的三档高度。
 *
 * 为什么用 `maxHeight` 而不是 `height`：档位是**上限**，不是硬高，内容少的天体不该撑出一片空白。
 * 由此带来一个必须处理的后果：内容装不满时，更大的档位可能渲染出和上一档一样的高度。
 * 390×844 实测：每个天体的卡片内容都是 351 px，而「半屏」上限 44dvh = 371 px ——
 * 如果「全屏」只是把上限提到 76dvh，按下去画面一点不变。**留一个按了没反应的档位，
 * 比少一个档位更糟**，所以「全屏」不只是变高：它把四格事实改成单列（阅读模式）。
 *
 * 手势（t53 第 8 条）三档分明：
 *  - 位移 < `TAP_SLOP_PX`：点击，收起 ⇄ 展开；
 *  - 位移 ≥ `TAP_SLOP_PX` 但 < `DRAG_COMMIT_PX`：什么都不做（**并吃掉 click**）；
 *  - 竖向位移 ≥ `DRAG_COMMIT_PX`：跟手，松手换一档。
 * 横向拖拽不换档：这是一张竖着收放的抽屉，横着蹭没有对应动作。
 */
function CardHandle({
  stop,
  onTap,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  stop: SheetStop;
  onTap: () => void;
  onDragStart: (x: number, y: number, height: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`详情卡高度：${SHEET_LABEL[stop]}`}
      aria-expanded={stop !== "bar"}
      className="sheet-handle hud-btn flex h-11 w-full shrink-0 touch-none items-center justify-center"
      onPointerDown={(event) => {
        const article = event.currentTarget.closest("article");
        onDragStart(event.clientX, event.clientY, article?.getBoundingClientRect().height ?? 0);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => onDragMove(event.clientX, event.clientY)}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onClick={onTap}
    >
      <span className="sheet-grip" aria-hidden />
      <span className="sheet-stop-label" aria-hidden>{stop === "bar" ? "展开详情" : `${SHEET_LABEL[stop]} / 拖动换档`}</span>
    </button>
  );
}

function SandboxCard({ compact }: { compact: boolean }) {
  const selectedId = useSim((state) => state.selectedId);
  const requestReset = useSim((state) => state.requestReset);
  const unlocked = useSim((state) => isGateUnlocked(state));
  const { byId } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  // t55：时间压缩标注（沙盘专有；实境卡片本来就是模型值，加这句自相矛盾）
  const compression = selected
    ? compressionLine(selected, { daysPerSimSecond: DAYS_PER_SIM_SECOND, daysPerYear: DAYS_PER_YEAR })
    : null;
  /*
   * 开合状态**按天体记**（t13）：同一颗再次选中时保持上次的开合。
   *
   * 记录活在这个组件里 —— 它在沙盘内一直挂着（没选中时只是 return null），
   * 切到实境才卸载。跨模式丢状态可以接受（那时卡片本来就不在），
   * 跨天体串状态不行（看木星时收起，切换回地球不该继承"收起"）。
   */
  const [stopByBody, setStopByBody] = useState<Record<string, SheetStop>>({});
  const [collapsedByBody, setCollapsedByBody] = useState<Record<string, boolean>>({});
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ x0: number; y0: number; h0: number; active: boolean } | null>(null);  /**
   * 拖完松手时浏览器还会补一个 click。不挡掉的话"拖动换档"和"点击切换"会连着触发两次，
   * 手感是"松手后又自己跳了一档"。所以拖过就吃掉紧随其后的那一次 click。
   */
  const skipClick = useRef(false);

  const bodyId = selected?.id ?? "";
  /** 当前天体的档位（没记录过 = 半屏）。 */
  const stop: SheetStop = stopByBody[bodyId] ?? "half";
  const setStop = (next: SheetStop) => setStopByBody((prev) => ({ ...prev, [bodyId]: next }));
  /** 宽屏收起态，同样按天体记。默认展开。 */
  const desktopCollapsed = collapsedByBody[bodyId] ?? false;
  const setDesktopCollapsed = (value: boolean) => setCollapsedByBody((prev) => ({ ...prev, [bodyId]: value }));

  /*
   * 窄屏：点卡片本体也能开合（t13）。手指很难精准戳中那根 44px 的把手，
   * 那就让整张卡都算把手 —— 点文字、点空白都行；**按钮/链接不算**（返回总览、✕）。
   * 拖过（换档/滚动）之后的合成 click 不吃这一下：那会变成"一滚动就收起"。
   */
  const onBodyTap = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!compact) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select")) return;
    if (skipClick.current) {
      skipClick.current = false;
      return;
    }
    setStop(stop === "bar" ? "half" : "bar");
  };

  /** 档位上限换算成像素：rem 按根字号，dvh 按视口高。 */
  const capPx = (s: SheetStop) => {
    const raw = SHEET_MAX[s];
    const n = parseFloat(raw);
    if (raw.endsWith("rem")) {
      const root = typeof window !== "undefined" ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 16;
      return n * root;
    }
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    return (n / 100) * vh;
  };

  if (!selected) return null;

  /*
   * 宽屏收起态（t13）：一条窄栏，保留「色点 + kind + 名称」。
   * 它和展开态同一位置（top-4 right-6 w-80），所以收起时画面右侧只少了一条，
   * 不会跳位置。点它展开。
   */
  if (!compact && desktopCollapsed) {
    return (
      <button
        type="button"
        className="panel-in pointer-events-auto absolute top-4 right-6 flex w-80 items-center gap-2.5 rounded-xl border border-line bg-elevated px-3 py-2 text-left"
        data-label-occluder="true"
        aria-label={`展开${selected.name}详情`}
        aria-expanded={false}
        onClick={() => setDesktopCollapsed(false)}
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: selected.swatch }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] leading-none text-muted">{selected.kind}</span>
          <span className="font-display mt-1 block truncate text-base leading-tight text-fg">{selected.name}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-subtle" aria-hidden />
      </button>
    );
  }

  return (
    <CardShell
      id={selected.id}
      maxHeight={compact ? (dragPx === null ? SHEET_MAX[stop] : `${dragPx}px`) : undefined}
      sheetStop={compact ? stop : undefined}
      dragging={compact && dragPx !== null}
      onBodyClick={compact ? onBodyTap : undefined}
      handle={
        compact ? (
          <CardHandle
            stop={stop}
            onTap={() => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              drag.current = null;
              setDragPx(null);
              // 点击只做一件事：收起 ⇄ 展开。不是"循环三档"——
              // 轻点一下把卡片从半屏跳到全屏，是用户没要求的位移。
              setStop(stop === "bar" ? "half" : "bar");
            }}
            onDragStart={(x, y, height) => {
              skipClick.current = false;
              drag.current = { x0: x, y0: y, h0: height, active: false };
            }}
            onDragMove={(x, y) => {
              const d = drag.current;
              if (!d) return;
              const dy = d.y0 - y; // 往上拖 = 变高
              // 只要离开"点击"的容差，这一次手势就不该在松手后变成 click
              if (Math.abs(dy) >= TAP_SLOP_PX || Math.abs(x - d.x0) >= TAP_SLOP_PX) skipClick.current = true;
              if (!d.active) {
                // 死区：竖向没到 DRAG_COMMIT_PX 就一动不动。横向怎么蹭都不换档（这是一张竖抽屉）。
                if (Math.abs(dy) < DRAG_COMMIT_PX) return;
                d.active = true;
              }
              setDragPx(Math.min(Math.max(d.h0 + dy, capPx("bar")), window.innerHeight * 0.9));
            }}
            onDragEnd={() => {
              const d = drag.current;
              drag.current = null;
              if (!d) {
                setDragPx(null);
                return;
              }
              if (!d.active) {
                setDragPx(null);
                return; // 死区内的轻蹭回到原档，不触发第二次点击换档
              }
              const height = dragPx ?? d.h0;
              const delta = height - d.h0;
              const index = SHEET_STOPS.indexOf(stop);
              // 方向直接取本次手势，不再拿内容高度和档位上限猜；短内容也不会误判。
              const direction = delta >= 0 ? 1 : -1;
              const next = SHEET_STOPS[Math.min(SHEET_STOPS.length - 1, Math.max(0, index + direction))]!;
              setStop(next);
              setDragPx(null);
            }}
          />
        ) : (
          /* 宽屏：卡片顶部一条 28px 的收起条（"抓手"）。鼠标目标小一点没关系，它整条都是按钮 */
          <button
            type="button"
            className="hud-btn flex h-7 w-full shrink-0 items-center justify-center gap-1 rounded-t-xl bg-elevated text-[11px] text-subtle"
            aria-label="收起详情卡"
            aria-expanded={true}
            onClick={() => setDesktopCollapsed(true)}
          >
            <ChevronUp className="size-3.5" aria-hidden />
            收起
          </button>
        )
      }
    >
      {/* 沙盘的 ✕ 只在手机出现：桌面端下面那颗「返回总览」就是出口 */}
      <CardHead body={selected} close={<CloseButton className="md:hidden" />} />
      {/* 全屏档把事实改成单列：这是"全屏"真正做的事，不然它只是和半屏一样高 */}
      <CardBody body={selected} stackFacts={compact && stop === "full"} />
      {/*
        t55：时间压缩那一行 —— 逐天体现算，不写全局系数（两条律：公转 0.04–37.8、自转 13–174）。
        取不到就整行不渲染（太阳只有自转；实境样本不在参考表里）。
        时间尺度从 store 取，原样传进纯函数；brand.ts 保持运行时零 import，Node 能直接单测。

        **位置：紧跟在事实表后面，不是卡片最底部。** 实测 1280 下卡片内容已比可视区高 110px，
        放最底部（免责声明之后）时它落在折叠线下方、不滚动就看不见 —— 标注看不见就白标。
      */}
      {compression && (
        <p data-compression={compression} className="mt-2 text-[11px] leading-snug text-subtle">
          {compression}
        </p>
      )}
      {/* t28：未解锁时给一句观察线索；解锁后整段不渲染（它的作用是点火，不是常驻文案） */}
      {!unlocked && (
        <p
          data-card-clue
          className="mt-3 rounded-md border border-line bg-bg px-3 py-2 text-xs leading-relaxed text-subtle"
        >
          {CARD_CLUES[selected.id] ?? CARD_CLUES.default}
        </p>
      )}
      {/* 「做过压缩」是沙盘的免责声明 —— 实境恰恰没有压缩，所以这句只活在这里 */}
      <p className="mt-3 hidden text-xs leading-relaxed text-subtle md:block">
        大小与轨道间距做过压缩，方便同屏观看。卡片上的数字仍是真实资料。
      </p>
      <button
        type="button"
        className="return-overview hud-btn mt-3 h-10 w-full border text-sm md:mt-4"
        onClick={requestReset}
      >
        返回总览
      </button>
    </CardShell>
  );
}

function RealCard() {
  const selectedId = useSim((state) => state.selectedId);
  const { byId } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  if (!selected) return null;
  return (
    <CardShell id={selected.id}>
      <CardHead body={selected} close={<CloseButton />} note="选中的天体" />
      <CardBody body={selected} />
    </CardShell>
  );
}

function EmptyHint() {
  const selectedId = useSim((state) => state.selectedId);
  if (selectedId) return null;
  return (
    <p className="empty-guide sky-title pointer-events-none absolute bottom-4 left-6 hidden max-w-sm text-sm md:block">
      <span className="mb-1 block font-mono text-[9px] tracking-[0.18em] text-subtle">NAVIGATION / 自由观测</span>
      拖拽旋转 · 滚轮缩放 · 点选天体后跟随
    </p>
  );
}

/* ────────────────────────────── 沙盘：底栏 ────────────────────────────── */

/**
 * 两个布局共用的键。抽出来是为了让"3 键"和"5 键"两套布局**不会各自漂**——
 * 暂停与总览在两个布局里必须长得一模一样，否则玩家换个窗口宽度就得重新认按钮。
 */
function PauseKey({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md bg-accent text-sm text-accent-fg"
      aria-label={paused ? "继续模拟" : "暂停模拟"}
      aria-pressed={paused}
      onClick={onToggle}
    >
      {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
      {/* t12：窄屏也出字（原来 `hidden sm:inline`，390 下只剩 `| |`，第一次拿手机的人猜不出来） */}
      <span>{paused ? "继续" : "暂停"}</span>
    </button>
  );
}

function OverviewKey({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      className="hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border border-line text-sm text-fg"
      aria-label="返回总览"
      onClick={onReset}
    >
      <LocateFixed className="size-4" />
      <span>总览</span>
    </button>
  );
}

/** 宽屏 5 键里的图层开关（窄屏把它们搬进浮层，长相换成整行）。 */
function LayerKey({ label, pressed, onToggle, icon }: { label: string; pressed: boolean; onToggle: () => void; icon: ReactNode }) {
  return (
    <button
      type="button"
      className={`hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
        pressed ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
      }`}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/* ── 设定时刻（t49）：把 store 的 `setSimTime` 接到界面上 ── */

/**
 * 年长与月长都取 store 的（t44 定案：`DAYS_PER_YEAR = 365.25`）。
 * HUD 不写死 365 —— 写死就会和 `formatEpoch` / `daysOf` 分成两套历法，
 * 而"两套历法"在玩家眼里就是"这游戏算错了"。
 *
 * 一步「月」= `DAYS_PER_YEAR / 12` = 30.4375 天：它是"十二个月的年"里的那个月，
 * 不是日历月 —— 真要日历月，得先有真日历（见 store 里 SIM_EPOCH_MS 那段警告）。
 */
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;
/** 一年里最后一个"年内第几日"：floor(365.25 % 365.25) 最大只能到 364，+1 得 365。 */
const DAYS_PER_YEAR_LAST_DAY = Math.floor(DAYS_PER_YEAR);

/** 模拟日 → 模拟秒。用 store 导出的换算，**不重写压缩常数**。 */
function simSecondsOfDays(days: number) {
  return days * SECONDS_PER_SIM_SECOND;
}

/** 相对拨动的步长（天）。负数往回拨，但不许早于历元。 */
const TIME_STEPS = [
  { label: "-1 年", days: -DAYS_PER_YEAR },
  { label: "-1 月", days: -DAYS_PER_MONTH },
  { label: "-1 天", days: -1 },
  { label: "+1 天", days: 1 },
  { label: "+1 月", days: DAYS_PER_MONTH },
  { label: "+1 年", days: DAYS_PER_YEAR },
] as const;

/**
 * 「设定时刻」。入口是底栏速度行右侧那颗时计键 —— 时间的两件事（跑多快、从哪里开始）
 * 放在同一行，是仪表台的习惯：同一量纲的控件相邻，换一行找就是另一件事了。
 *
 * 两种拨法：
 *  - **绝对**：填「年 / 日」再「应用」。年月日这套就是 HUD 模拟历自己的格式，
 *    `splitEpoch` 与 `formatEpoch` 共用 365 天年长，所以填什么、显示什么一致。
 *  - **相对**：±1 天 / ±1 月 / ±1 年，一步一次、立刻生效，不用确认。
 *
 * 不给早于历元的时刻：读数只会显示「第 N 日」，负数会被显示层夹成 0 —— 那是在撒谎。
 */
function TimeSetter({ disabled }: { disabled: boolean }) {
  const days = useSim((state) => state.days);
  const setSimTime = useSim((state) => state.setSimTime);
  const [open, setOpen] = useState(false);
  const [draftYear, setDraftYear] = useState("0");
  const [draftDay, setDraftDay] = useState("1");
  /** 用户改过输入框之前，字段跟着时钟走；改过之后就不许再被覆盖（否则打到一半的字被抹掉）。 */
  const [edited, setEdited] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 触发键自己也要算"里面"。否则：pointerdown 落在时计键上 → 外面的监听先把它关掉 →
   * 紧接着的 click 又把它打开 —— 表现为"再点一次关不掉"。同一类 bug 见 Dock 的图层浮层。
   */
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 面板开着、用户还没动手时，把「当前」同步进输入框：仪表上的数字该是活的钟，不是快照。
  useEffect(() => {
    if (!open || edited) return;
    const now = splitEpoch(days);
    setDraftYear(String(now.years));
    setDraftDay(String(now.day));
  }, [open, edited, days]);

  // 切换模式期间禁「拨时间」：相机正在换系统，此时改时间等于在动画中途换片场
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      // 触发键不算"外面"：它自己会 toggle，两边都动就会互相抵消
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const jumpTo = (targetDays: number) => {
    setSimTime(simSecondsOfDays(Math.max(0, targetDays)));
  };

  const bump = (deltaDays: number) => {
    // 相对拨动用 store 里的精确 simSeconds，不用被节流过的 days（那最多差 0.25 秒）
    jumpTo(daysOf(useSim.getState().simSeconds) + deltaDays);
  };

  const applyDraft = () => {
    const years = Math.min(9999, Math.max(0, Math.floor(Number(draftYear) || 1)));
    // 日是 1 起算的"年内第几日"（与 splitEpoch / formatEpoch 同一口径），所以落回天数时要 -1
    const day = Math.min(DAYS_PER_YEAR_LAST_DAY, Math.max(1, Math.floor(Number(draftDay) || 1)));
    jumpTo(years * DAYS_PER_YEAR + (day - 1));
    setEdited(false); // 应用完回到跟随模式：下一个读数由时钟接管
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`hud-btn inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border ${
          open ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
        } ${disabled ? "opacity-40" : ""}`}
        aria-label="设定时刻"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (!open) setEdited(false); // 每次打开都从"跟随时钟"开始
          setOpen((prev) => !prev);
        }}
      >
        <Clock className="size-4" />
      </button>

      {open && (
        <div
          ref={panelRef}
          data-overlay-open="true"
          role="dialog"
          aria-label="设定时刻"
          className="panel-in absolute right-2 bottom-full z-20 mb-2 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-elevated p-2"
        >
          <p className="px-1 text-xs text-muted">设定时刻</p>
          <p className="px-1 pb-2 text-sm tabular-nums text-fg">当前 {formatEpoch(days)}</p>
          <div className="flex items-end gap-1.5">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              年
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={draftYear}
                onChange={(event) => {
                  setEdited(true);
                  setDraftYear(event.target.value);
                }}
                className="hud-btn h-11 w-full rounded-md border border-line bg-bg px-2 text-sm tabular-nums text-fg"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              日
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={DAYS_PER_YEAR_LAST_DAY}
                step={1}
                value={draftDay}
                onChange={(event) => {
                  setEdited(true);
                  setDraftDay(event.target.value);
                }}
                className="hud-btn h-11 w-full rounded-md border border-line bg-bg px-2 text-sm tabular-nums text-fg"
              />
            </label>
            <button
              type="button"
              className="hud-btn h-11 shrink-0 rounded-md bg-accent px-3 text-sm text-accent-fg"
              onClick={applyDraft}
            >
              应用
            </button>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {TIME_STEPS.map((step) => (
              <button
                key={step.label}
                type="button"
                className="hud-btn h-11 rounded-md border border-line text-sm tabular-nums text-fg"
                onClick={() => bump(step.days)}
              >
                {step.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 底栏只在沙盘。四样东西各有理由：
 * - 速度滑条 / 暂停：实境的模拟时间不前进（look.freezesTime = true，推进在生产端被跳过），
 *   滑它、按它都没有可见变化（等于坏键）；
 * - 名称 / 轨道 / 尾迹：这三样是沙盘的**地图符号**，真实比例下并不存在一条看得见的轨道线，
 *   尾迹/星空/小行星带在实境的 look 里也整体关着（decor / orbitLines = false）；
 * - 总览：实境没有"总览"这个去处。
 * 实境回去的路径只有两条，且都永远可见：徽标的分段控件、Esc。
 *
 * **窄屏（<640px）3 键**：暂停 / 图层 / 总览。三个图层开关搬进「图层」浮层 ——
 * 390 宽下 5 个键每个只有 68px，图标密到手指分不开，而且它们是低频操作（第一次认识之后
 * 大多只用来确认"我关的是哪一层"）。暂停与总览是高频且紧急的，必须一眼看见。
 */
function Dock({ compact }: { compact: boolean }) {
  const paused = useSim((state) => state.paused);
  const speed = useSim((state) => state.speed);
  const showLabels = useSim((state) => state.showLabels);
  const showOrbits = useSim((state) => state.showOrbits);
  const showTrails = useSim((state) => state.showTrails);
  const togglePaused = useSim((state) => state.togglePaused);
  const setSpeed = useSim((state) => state.setSpeed);
  const toggleLabels = useSim((state) => state.toggleLabels);
  const toggleOrbits = useSim((state) => state.toggleOrbits);
  const toggleTrails = useSim((state) => state.toggleTrails);
  const requestReset = useSim((state) => state.requestReset);
  // t12：自动收起的开关（持久化在 settings 里，见 store 的 hudAutoHide）
  const autoHide = useSim((state) => state.hudAutoHide);
  const toggleAutoHide = useSim((state) => state.toggleHudAutoHide);
  const chrome = useChrome();
  /** 切换模式期间禁拨时间（相机正在换系统，此时改时间等于在动画中途换片场）。 */
  const switching = useSim((state) => state.switching);
  const [layerOpen, setLayerOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  /**
   * 「图层」键自己也算"里面"。
   *
   * 第 10 条 bug 的根因就在这里：外面的监听在 **pointerdown** 关浮层，
   * 而触发键的 **click** 稍后才把 `layerOpen` 翻成 true —— 一次点击里一关一开，
   * 净效果是"再点一次关不掉"。让触发键走"外面"的判定外面去，它自己负责 toggle。
   */
  const layerBtnRef = useRef<HTMLButtonElement>(null);

  // 宽度跨过 640px 时直接收起浮层：3 键布局不在了，浮层没有锚点
  useEffect(() => {
    if (!compact) setLayerOpen(false);
  }, [compact]);

  // 浮层是浮层：点外面关、Esc 关（Esc 那条用 data-overlay-open 让全局键盘先让路）
  useEffect(() => {
    if (!layerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sheetRef.current?.contains(target)) return;
      if (layerBtnRef.current?.contains(target)) return;
      setLayerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") setLayerOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [layerOpen]);

  const layers: { id: string; label: string; pressed: boolean; onToggle: () => void; icon: ReactNode }[] = [
    { id: "labels", label: "名称", pressed: showLabels, onToggle: toggleLabels, icon: <Tag className="size-4" /> },
    { id: "orbits", label: "轨道", pressed: showOrbits, onToggle: toggleOrbits, icon: <Orbit className="size-4" /> },
    { id: "trails", label: "尾迹", pressed: showTrails, onToggle: toggleTrails, icon: <Sparkles className="size-4" /> },
  ];

  /*
   * 读数：玩家读的是「这一秒里过去了多久」，倍率只是内部量，缩到第二行。
   * 用 store 的 `daysPerRealSecond(speed)`（每**实**秒推进多少模拟日）——
   * 不是 `daysOf(1) * speed`，那是"每模拟秒多少天"，t44 改基准后两者差 20.3 倍。
   */
  const rate = formatRate(daysPerRealSecond(speed));

  /*
   * t12：快照号在窄屏的去处。
   * 抬头在 320 下只剩 23.4px 余量（t5 ④ 实测），`snap.10` 要 ~52px，塞进抬头就会把模拟历挤掉；
   * 所以窄屏（<640，抬头那个 `.eyebrow` 本来就是 `hidden sm:inline`）把快照号放到**底栏**：
   * 展开态与收起态的细条里各有一份，任何时刻都看得见。正式版没有后缀 → 两处都不渲染，
   * 1.2.1 的抬头布局一个像素都不变。
   */
  const versionTag = snapshotTag(__APP_VERSION__);

  /*
   * 收起态（t12）：底栏缩成一条**可发现的细条**，不是消失。
   * 高度：窄屏 h-11（44px，手指点得中）+ py-1；宽屏 h-8（鼠标）。
   * 读数留下来 —— 它是"时间在跑"的唯一常显证据，藏掉会让人以为卡死。
   */
  if (chrome?.dock) {
    return (
      <footer className="hud-dock is-collapsed pointer-events-auto relative px-3">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="hud-btn chrome-in-dock inline-flex h-10 items-center gap-2 border px-3 text-xs text-muted"
            aria-label="展开操作台"
            aria-expanded={false}
            onClick={chrome.expandDock}
          >
            <ChevronUp className="size-4" aria-hidden />
            <span>操作台</span>
            <span className="dock-rate tabular-nums text-subtle">1 秒 = {rate.value} {rate.unit}</span>
          </button>
          {versionTag && <span data-version-tag className="shrink-0 font-mono text-[9px] text-subtle">{versionTag}</span>}
        </div>
      </footer>
    );
  }

  return (
    <footer className="hud-dock pointer-events-auto relative px-3 pt-3 md:px-6">
      <div className="speed-row flex items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <span className="w-10 shrink-0 text-sm text-muted">速度</span>
          <input
            className="speed-range min-w-0 flex-1"
            type="range"
            min={0}
            max={SPEED_STOPS.length - 1}
            step={1}
            value={stopIndexOf(speed)}
            aria-valuemin={SPEED_STOPS[0]}
            aria-valuemax={SPEED_MAX}
            aria-valuenow={speed}
            aria-valuetext={`1 秒 = ${rate.value} ${rate.unit}`}
            aria-label="模拟速度"
            onChange={(event) => setSpeed(SPEED_STOPS[Number(event.target.value)] ?? speed)}
          />
        </label>
        <span className="dock-rate flex w-20 shrink-0 flex-col items-end justify-center leading-tight">
          <span className="text-xs tabular-nums text-fg">1 秒 = {rate.value} {rate.unit}</span>
          <span className="text-[10px] tabular-nums text-subtle">{formatMultiplier(speed)}</span>
        </span>
        <TimeSetter disabled={switching !== null} />
        <button
          type="button"
          className="hud-btn inline-flex h-10 w-9 shrink-0 items-center justify-center border text-muted"
          aria-label="收起操作台"
          aria-expanded={true}
          title="收起操作台"
          onClick={() => {
            setLayerOpen(false);
            chrome?.collapseDock();
          }}
        >
          <ChevronDown className="size-4" aria-hidden />
        </button>
      </div>

      {compact ? (
        <>
          <div className="dock-controls mt-1 grid grid-cols-3 gap-1.5">
            <PauseKey paused={paused} onToggle={togglePaused} />
            <button
              ref={layerBtnRef}
              type="button"
              className="hud-btn inline-flex h-11 items-center justify-center gap-2 border text-sm text-fg"
              aria-label="图层"
              aria-expanded={layerOpen}
              aria-haspopup="dialog"
              onClick={() => setLayerOpen((previous) => !previous)}
            >
              <Layers className="size-4" aria-hidden />
              <span>图层</span>
            </button>
            <OverviewKey onReset={requestReset} />
          </div>

          {layerOpen && (
            <div
              ref={sheetRef}
              data-overlay-open="true"
              role="dialog"
              aria-label="图层开关"
              className="panel-in absolute inset-x-3 bottom-full z-20 mb-2 grid gap-1.5 p-2"
            >
              <p className="px-2 pb-1 font-mono text-[9px] tracking-[0.16em] text-subtle">VIS / 显示与界面</p>
              {layers.map((layer) => (
                <button
                  key={layer.id}
                  type="button"
                  id={`layer-${layer.id}`}
                  className="hud-btn inline-flex h-11 items-center gap-2 border px-3 text-sm text-fg"
                  aria-label={layer.label}
                  aria-pressed={layer.pressed}
                  onClick={layer.onToggle}
                >
                  {layer.icon}
                  <span>{layer.label}</span>
                  <span className="ml-auto font-mono text-[9px] text-subtle">{layer.pressed ? "ON" : "OFF"}</span>
                </button>
              ))}
              <button
                type="button"
                className="hud-btn mt-1 inline-flex h-10 items-center gap-2 border-t border-line px-3 text-xs text-muted"
                aria-pressed={autoHide}
                aria-label={`自动收起${autoHide ? "已开" : "已关"}`}
                onClick={toggleAutoHide}
              >
                空闲时收起界面
                <span className={`ml-auto font-mono text-[10px] ${autoHide ? "text-fg" : "text-subtle"}`}>{autoHide ? "ON" : "OFF"}</span>
              </button>
            </div>
          )}

          <div className="dock-meta mt-1 flex h-4 items-center justify-between gap-2 px-1">
            <span>AUTO HUD / {autoHide ? "ON" : "OFF"}</span>
            {versionTag && <span data-version-tag>{versionTag}</span>}
          </div>
        </>
      ) : (
        <div className="dock-controls mt-1 grid grid-cols-5 gap-1.5">
          <PauseKey paused={paused} onToggle={togglePaused} />
          {layers.map((layer) => (
            <LayerKey key={layer.id} label={layer.label} pressed={layer.pressed} onToggle={layer.onToggle} icon={layer.icon} />
          ))}
          <OverviewKey onReset={requestReset} />
        </div>
      )}

      {!compact && (
        <div className="dock-meta mt-2 flex items-center justify-between gap-3">
          <p>空格 暂停 · ESC 总览 · L 名称 · O 轨道 · T 尾迹 · 1—9 选天体</p>
          <button
            type="button"
            className="hud-btn inline-flex h-6 shrink-0 items-center gap-1 border px-2 text-[10px] text-muted"
            aria-pressed={autoHide}
            aria-label={`自动收起${autoHide ? "已开" : "已关"}`}
            onClick={toggleAutoHide}
          >
            自动收起
            <span className={autoHide ? "text-fg" : "text-subtle"}>{autoHide ? "开" : "关"}</span>
          </button>
        </div>
      )}
    </footer>
  );
}

/* ────────────────────────────── 副作用（hooks） ────────────────────────────── */

function useHudBootstrap() {
  useEffect(() => {
    useSim.getState().hydrate(loadSettings());
    // 进度独立一个键、独立一次读取：存储挂了只丢记忆，不丢「这次能不能进」。
    useSim.getState().hydrateGate();
    return bindSettingsPersistence();
  }, []);
}

/**
 * 键盘矩阵。
 * 沙盘：空格暂停 / L 名称 / O 轨道 / T 尾迹 / 1–9 选行星 / Esc 回总览。
 * 实境：只有 Esc = 回沙盘（t2 §6.5 定的语义）；其余键在那里全都不成立
 *      （没有芯片行、没有图层开关、时间也冻着）。
 */
function useHudKeyboard(real: boolean) {
  const { chips } = useSystem();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.code === "Space") {
        if (tag === "BUTTON" || real) return;
        event.preventDefault();
        useSim.getState().togglePaused();
      } else if (event.code === "Escape") {
        // 浮层开着时 Esc 先关浮层（浮层自己的监听负责），别顺手把镜头拉回总览
        if (document.querySelector('[data-overlay-open="true"]')) return;
        if (real) useSim.getState().setMode("sandbox");
        else useSim.getState().requestReset();
      } else if (real) {
        return;
      } else if (event.key === "l" || event.key === "L") {
        useSim.getState().toggleLabels();
      } else if (event.key === "o" || event.key === "O") {
        useSim.getState().toggleOrbits();
      } else if (event.key === "t" || event.key === "T") {
        useSim.getState().toggleTrails();
      } else if (/^[1-9]$/.test(event.key)) {
        // 1–9 直接跳到对应行星，比横着找芯片快
        const body = chips[Number(event.key) - 1];
        if (body) useSim.getState().select(body.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chips, real]);
}

/** 选中态变化时把对应芯片滚进视野（实境里没有芯片，getElementById 返回空，天然空转）。 */
function useKeepChipVisible() {
  const selectedId = useSim((state) => state.selectedId);
  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(`chip-${selectedId}`)?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [selectedId]);
}
