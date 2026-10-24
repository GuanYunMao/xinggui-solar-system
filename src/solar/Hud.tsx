import { ChevronRight, Clock, Layers, LocateFixed, Orbit, Pause, Play, Sparkles, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ModeBadge } from "./ModeBadge";
import { OrbitGlyph } from "./BrandMark";
import { APP_ERA_NAME, versionLabel } from "./brand";
import type { Body } from "./data";
import { bindSettingsPersistence, DAYS_PER_YEAR, daysPerRealSecond, daysOf, loadSettings, SECONDS_PER_SIM_SECOND, useSim } from "./store";
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
  return (
    <>
      <HudHeader trailing={<Epoch />} />
      {/* 芯片行是「9 个可去的天体」的导航台 —— 只有沙盘有这个语义 */}
      <Chips />
      <Moons />
      <div className="relative min-h-0 flex-1">
        <SandboxCard compact={compact} />
        <EmptyHint />
      </div>
      <Dock compact={compact} />
    </>
  );
}

/* ────────────────────────────── 实境：航行仪表 ────────────────────────────── */

function RealHud() {
  return (
    <>
      {/*
        实境不显示模拟历，因为**时间在那里不前进**：推进只有一处生产端（SolarCanvas 的
        Simulation 每帧先看 `look.freezesTime`，为真就不调 `advanceSim`），而实境的 look
        把它设成 true —— 所以模拟历会停在进入实境的那一刻，既不涨也不归零。
        停住的数字和坏掉的钟看起来一模一样，所以这里不是"隐藏 Epoch"，是 **Epoch 不在树里**。
      */}
      <HudHeader />
      <div className="relative min-h-0 flex-1">
        <RealCard />
      </div>
    </>
  );
}

/* ────────────────────────────── 共用：抬头 ────────────────────────────── */

/** 左上 = 图标 + 代际名 + 版本号，**不放全名**（全名唯一的家是启动页，见 App.tsx）。 */
function HudHeader({ trailing }: { trailing?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-3 px-4 pt-4 md:px-6 md:pt-6">
      <div className="sky-title flex min-w-0 items-center gap-2.5">
        <h1 className="flex items-center gap-2">
          <OrbitGlyph className="size-8 shrink-0 text-fg" />
          <span className="text-base leading-none tracking-[0.2em] text-muted">{APP_ERA_NAME}</span>
        </h1>
        <span className="eyebrow text-[11px] text-subtle">{versionLabel(__APP_VERSION__)}</span>
      </div>
      {/*
        右侧单行：模式徽标 + （沙盘的）模拟历。徽标占的是「区划」的位置，
        绝不下放到底栏——底栏 grid-cols-5 已满，而且底栏是玩具区（暂停/图层）。
      */}
      <div className="pointer-events-auto flex shrink-0 items-center gap-2">
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
    <>
      <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
      <div className="sky-title flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="hidden text-xs text-muted sm:inline">{paused ? "已暂停" : "模拟历"}</span>
        <p className="text-lg tabular-nums text-fg">{formatEpoch(days)}</p>
      </div>
    </>
  );
}

/* ────────────────────────────── 共用：选择器 ────────────────────────────── */

function Chips() {
  const selectedId = useSim((state) => state.selectedId);
  const select = useSim((state) => state.select);
  const { byId, chips } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  const rowRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  /*
   * 渐隐提示：判据是**真的溢出了没有**，不是"宽度小于某个数"。
   * 390 宽下 9 颗只露 5.4 颗，右侧必须告诉人还有东西；1280 宽下没溢出，两层遮罩都不出现。
   * 判据跟实际滚动位置走，所以滑到最右时右箭头自动消失、滑回来左箭头自动出现。
   */
  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure); // 转屏、窗口拉伸、字体变化都会走到这里
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  return (
    <div className="relative">
      <div
        ref={rowRef}
        id="chip-row"
        className="chip-row pointer-events-auto mt-3 flex gap-2 overflow-x-auto px-4 pb-1 md:px-6"
      >
        {chips.map((body) => {
          const moonOfThis = selected?.parent === body.id && selected.parent !== "sun";
          const active = selectedId === body.id || moonOfThis;
          return (
            <button
              key={body.id}
              id={`chip-${body.id}`}
              type="button"
              className={`hud-btn inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${
                active ? "border-accent bg-accent text-accent-fg" : "border-line bg-elevated text-fg"
              }`}
              aria-pressed={active}
              onClick={() => select(body.id)}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: body.swatch }} />
              {body.name}
            </button>
          );
        })}
      </div>
      {/* 右侧：还有天体没展开。箭头 + 渐隐同时给，因为"隐约看到半颗"和"知道还有东西"是两件事 */}
      {edge.right && (
        <div
          data-fade="right"
          className="pointer-events-none absolute inset-y-0 right-0 z-[1] flex w-12 items-center justify-end bg-gradient-to-l from-black/80 via-black/40 to-transparent pr-1"
        >
          <ChevronRight className="size-4 text-muted" aria-hidden />
          <span className="sr-only">右侧尚有天体，横向滑动展开</span>
        </div>
      )}
      {/* 左侧：已经滑开了，反向同款，但不要箭头（箭头会让人以为这是"前进"） */}
      {edge.left && (
        <div
          data-fade="left"
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-8 bg-gradient-to-r from-black/80 via-black/40 to-transparent"
        />
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
  if (moons.length === 0) return null;
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
  handle,
  children,
}: {
  id: string;
  maxHeight?: string;
  handle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      key={id}
      style={maxHeight ? { maxHeight } : undefined}
      className="panel-in pointer-events-auto absolute inset-x-3 bottom-3 flex max-h-[44dvh] flex-col overflow-hidden rounded-xl border border-line bg-elevated md:inset-x-auto md:top-4 md:right-6 md:bottom-4 md:max-h-none md:w-80"
    >
      {handle}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </article>
  );
}

function CardHead({ body, close }: { body: Body; close: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-xs text-muted">{body.kind}</p>
        <h2 className="font-display mt-1 text-xl leading-tight text-fg md:text-2xl">{body.name}</h2>
      </div>
      {close}
    </div>
  );
}

function CardBody({ body, stackFacts = false }: { body: Body; stackFacts?: boolean }) {
  return (
    <>
      <p className="mt-2 text-sm leading-relaxed text-fg">{body.blurb}</p>
      <dl className={`mt-3 grid gap-2 md:gap-3 ${stackFacts ? "grid-cols-1" : "grid-cols-2"}`}>
        {body.facts.map((fact) => (
          <div key={fact.label} className="rounded-md bg-bg px-3 py-2">
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

type SheetStop = "peek" | "half" | "full";
const SHEET_STOPS: SheetStop[] = ["peek", "half", "full"];
const SHEET_MAX: Record<SheetStop, string> = { peek: "28dvh", half: "44dvh", full: "76dvh" };
/** 手柄的读屏文本。视觉上只有一个握把条 —— 握把条不需要翻译，读屏需要一句话。 */
const SHEET_LABEL: Record<SheetStop, string> = { peek: "收起", half: "半屏", full: "全屏" };

/**
 * 详情卡抽屉的三档高度。
 *
 * 为什么用 `maxHeight` 而不是 `height`：档位是**上限**，不是硬高，内容少的天体不该撑出一片空白。
 * 由此带来一个必须处理的后果：内容装不满时，更大的档位可能渲染出和上一档一样的高度。
 * 390×844 实测：每个天体的卡片内容都是 351 px，而「半屏」上限 44dvh = 371 px ——
 * 如果「全屏」只是把上限提到 76dvh，按下去画面一点不变。**留一个按了没反应的档位，
 * 比少一个档位更糟**，所以「全屏」不只是变高：它把四格事实改成单列（阅读模式），
 * 多出来的空间用来换可读性，而不是换空白。这样三档在任何视口下渲染高度都不同。
 *
 * 拖动手感：跟手期间用像素，松手吸附到最近的一档；只点不拖则循环到下一档。
 */
function CardHandle({
  stop,
  onCycle,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  stop: SheetStop;
  onCycle: () => void;
  onDragStart: (clientY: number, height: number) => void;
  onDragMove: (clientY: number) => void;
  onDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`详情卡高度：${SHEET_LABEL[stop]}`}
      aria-expanded={stop !== "peek"}
      className="hud-btn flex h-11 w-full shrink-0 items-center justify-center rounded-t-xl bg-elevated"
      onPointerDown={(event) => {
        const article = event.currentTarget.closest("article");
        onDragStart(event.clientY, article?.getBoundingClientRect().height ?? 0);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => onDragMove(event.clientY)}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onClick={onCycle}
    >
      <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
    </button>
  );
}

function SandboxCard({ compact }: { compact: boolean }) {
  const selectedId = useSim((state) => state.selectedId);
  const requestReset = useSim((state) => state.requestReset);
  const { byId } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  const [stop, setStop] = useState<SheetStop>("half");
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);
  /**
   * 拖完松手时浏览器还会补一个 click。不挡掉的话"拖动吸附"和"点击循环"会连着触发两次，
   * 手感是"松手后又自己跳了一档"。所以拖过就吃掉紧随其后的那一次 click。
   */
  const skipClick = useRef(false);

  const renderedH = (s: SheetStop) =>
    (parseFloat(SHEET_MAX[s]) / 100) * (typeof window !== "undefined" ? window.innerHeight : 800);

  if (!selected) return null;
  return (
    <CardShell
      id={selected.id}
      maxHeight={compact ? (dragPx === null ? SHEET_MAX[stop] : `${dragPx}px`) : undefined}
      handle={
        compact ? (
          <CardHandle
            stop={stop}
            onCycle={() => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              drag.current = null;
              setDragPx(null);
              setStop((prev) => SHEET_STOPS[(SHEET_STOPS.indexOf(prev) + 1) % SHEET_STOPS.length]!);
            }}
            onDragStart={(clientY, height) => {
              skipClick.current = false;
              drag.current = { y0: clientY, h0: height, moved: false };
            }}
            onDragMove={(clientY) => {
              const d = drag.current;
              if (!d) return;
              const dy = d.y0 - clientY; // 往上拖 = 变高
              if (Math.abs(dy) > 4) d.moved = true;
              if (d.moved) setDragPx(Math.min(Math.max(d.h0 + dy, 120), window.innerHeight * 0.9));
            }}
            onDragEnd={() => {
              const d = drag.current;
              drag.current = null;
              if (!d) return;
              if (!d.moved) return; // 没拖动 = 交给 onClick 循环
              skipClick.current = true;
              const height = dragPx ?? d.h0;
              let best: SheetStop = stop;
              let bestDist = Infinity;
              for (const candidate of SHEET_STOPS) {
                const dist = Math.abs(renderedH(candidate) - height);
                if (dist < bestDist) {
                  bestDist = dist;
                  best = candidate;
                }
              }
              setStop(best);
              setDragPx(null);
            }}
          />
        ) : undefined
      }
    >
      {/* 沙盘的 ✕ 只在手机出现：桌面端下面那颗「返回总览」就是出口 */}
      <CardHead body={selected} close={<CloseButton className="md:hidden" />} />
      {/* 全屏档把事实改成单列：这是"全屏"真正做的事，不然它只是和半屏一样高 */}
      <CardBody body={selected} stackFacts={compact && stop === "full"} />
      {/* 「做过压缩」是沙盘的免责声明 —— 实境恰恰没有压缩，所以这句只活在这里 */}
      <p className="mt-3 hidden text-xs leading-relaxed text-subtle md:block">
        大小与轨道间距做过压缩，方便同屏观看。卡片上的数字仍是真实资料。
      </p>
      <button
        type="button"
        className="hud-btn mt-3 h-11 w-full rounded-md border border-line text-sm text-fg md:mt-4"
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
      {/* 实境没有「总览」这个去处（相机被钉在地球上），所以 ✕ 在桌面端也必须常显 */}
      <CardHead body={selected} close={<CloseButton />} />
      <CardBody body={selected} />
    </CardShell>
  );
}

function EmptyHint() {
  const selectedId = useSim((state) => state.selectedId);
  if (selectedId) return null;
  return (
    <p className="sky-title pointer-events-none absolute bottom-4 left-6 hidden max-w-sm text-sm text-muted md:block">
      拖拽旋转，滚轮缩放。点选行星后，镜头会平滑聚焦并跟着它走。
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
      <span className="hidden sm:inline">{paused ? "继续" : "暂停"}</span>
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
      <span className="hidden sm:inline">总览</span>
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
      <span className="hidden sm:inline">{label}</span>
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
      if (panelRef.current && !panelRef.current.contains(target)) setOpen(false);
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
  /** 切换模式期间禁拨时间（相机正在换系统，此时改时间等于在动画中途换片场）。 */
  const switching = useSim((state) => state.switching);
  const [layerOpen, setLayerOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // 宽度跨过 640px 时直接收起浮层：3 键布局不在了，浮层没有锚点
  useEffect(() => {
    if (!compact) setLayerOpen(false);
  }, [compact]);

  // 浮层是浮层：点外面关、Esc 关（Esc 那条用 data-overlay-open 让全局键盘先让路）
  useEffect(() => {
    if (!layerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sheetRef.current && !sheetRef.current.contains(target)) setLayerOpen(false);
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

  return (
    <footer className="hud-dock pointer-events-auto relative border-t border-line bg-elevated px-3 pt-3 md:px-6">
      {/*
        速度 + 时刻：两个控件同属"时间"这一量纲，放在同一行。
        滑条值 = 档位下标，回读时从实际速度反推 —— store 把 0.05 夹成 0.2 时，旋钮会退回
        0.2 那一档，而不是停在一个不存在的档上假装能到。
        读数在 label 外面：label 里放按钮会让"点读数"顺带触发滑条。
      */}
      <div className="flex items-center gap-3">
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
        <span className="flex w-20 shrink-0 flex-col items-end justify-center leading-tight">
          <span className="text-xs tabular-nums text-fg">
            1 秒 = {rate.value} {rate.unit}
          </span>
          <span className="text-[10px] tabular-nums text-subtle">{formatMultiplier(speed)}</span>
        </span>
        <TimeSetter disabled={switching !== null} />
      </div>

      {compact ? (
        <>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            <PauseKey paused={paused} onToggle={togglePaused} />
            <button
              type="button"
              className={`hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
                layerOpen ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
              }`}
              aria-label="图层"
              aria-expanded={layerOpen}
              aria-haspopup="dialog"
              onClick={() => setLayerOpen((prev) => !prev)}
            >
              <Layers className="size-4" />
              <span className="hidden sm:inline">图层</span>
            </button>
            <OverviewKey onReset={requestReset} />
          </div>

          {layerOpen && (
            <div
              ref={sheetRef}
              data-overlay-open="true"
              role="dialog"
              aria-label="图层开关"
              className="panel-in absolute inset-x-3 bottom-full z-20 mb-2 grid gap-1.5 rounded-xl border border-line bg-elevated p-2 shadow-lg"
            >
              {layers.map((layer) => (
                <button
                  key={layer.id}
                  type="button"
                  id={`layer-${layer.id}`}
                  className={`hud-btn inline-flex h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                    layer.pressed ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
                  }`}
                  aria-label={layer.label}
                  aria-pressed={layer.pressed}
                  onClick={layer.onToggle}
                >
                  {layer.icon}
                  <span>{layer.label}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="mt-1 grid grid-cols-5 gap-1.5">
          <PauseKey paused={paused} onToggle={togglePaused} />
          {layers.map((layer) => (
            <LayerKey
              key={layer.id}
              label={layer.label}
              pressed={layer.pressed}
              onToggle={layer.onToggle}
              icon={layer.icon}
            />
          ))}
          <OverviewKey onReset={requestReset} />
        </div>
      )}

      <p className="mt-2 hidden text-xs text-subtle md:block">
        空格暂停 · Esc 返回总览 · L 名称 · O 轨道 · T 尾迹 · 1–9 选行星
      </p>
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
