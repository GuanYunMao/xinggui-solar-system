import { LocateFixed, Orbit, Pause, Play, Sparkles, Tag } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { ModeBadge } from "./ModeBadge";
import { OrbitGlyph } from "./BrandMark";
import { APP_ERA_NAME, versionLabel } from "./brand";
import type { Body } from "./data";
import { bindSettingsPersistence, loadSettings, useSim } from "./store";
import { useSystem } from "./system-context";

/**
 * HUD 的结构（R5 重构后）：
 *
 *   Hud                     ← 唯一的模式判断点（模式只在这里读一次、分一次支）
 *   ├─ SandboxHud           ← 导航台：芯片行 + 卫星行 + 详情卡 + 底栏
 *   │   ├─ HudHeader trailing={<Epoch/>}
 *   │   ├─ Chips / Moons
 *   │   └─ SandboxCard | EmptyHint
 *   └─ RealHud              ← 航行仪表：只有品牌 + 徽标 + 详情卡
 *       ├─ HudHeader
 *       └─ RealCard
 *
 * 关键取舍：**「实境里不显示某样东西」不再是运行时条件，而是那个组件不在树里。**
 * 以前是"一套布局 + 八个例外"，1.2.0 一加手机/电脑分流，例外就会变成十六个以上。
 * 现在要加设备维度，只需在 SandboxHud/RealHud 内部再分一层，互不干扰。
 */

function formatSpeed(speed: number) {
  return `${speed.toFixed(1)}×`;
}

function formatEpoch(days: number) {
  const total = Math.max(0, Math.floor(days));
  const years = Math.floor(total / 365);
  const rest = total - years * 365;
  if (years <= 0) return `第 ${rest} 日`;
  return `${years} 年 ${rest} 日`;
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
  return (
    <>
      <HudHeader trailing={<Epoch />} />
      {/* 芯片行是「9 个可去的天体」的导航台 —— 只有沙盘有这个语义 */}
      <Chips />
      <Moons />
      <div className="relative min-h-0 flex-1">
        <SandboxCard />
        <EmptyHint />
      </div>
      <Dock />
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
  return (
    <div className="chip-row pointer-events-auto mt-3 flex gap-2 overflow-x-auto px-4 pb-1 md:px-6">
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
 * 竖屏时镜头会把星球抬到上半屏，配合这里每屏最多 44% 高度。
 */
function CardShell({ id, children }: { id: string; children: ReactNode }) {
  return (
    <article
      key={id}
      className="panel-in pointer-events-auto absolute inset-x-3 bottom-3 max-h-[44dvh] overflow-y-auto rounded-xl border border-line bg-elevated p-4 md:inset-x-auto md:top-4 md:right-6 md:bottom-4 md:max-h-none md:w-80"
    >
      {children}
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

function CardBody({ body }: { body: Body }) {
  return (
    <>
      <p className="mt-2 text-sm leading-relaxed text-fg">{body.blurb}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 md:gap-3">
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

function SandboxCard() {
  const selectedId = useSim((state) => state.selectedId);
  const requestReset = useSim((state) => state.requestReset);
  const { byId } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  if (!selected) return null;
  return (
    <CardShell id={selected.id}>
      {/* 沙盘的 ✕ 只在手机出现：桌面端下面那颗「返回总览」就是出口 */}
      <CardHead body={selected} close={<CloseButton className="md:hidden" />} />
      <CardBody body={selected} />
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
 * 底栏只在沙盘。四样东西各有理由：
 * - 速度滑条 / 暂停：实境的模拟时间不前进（look.freezesTime = true，推进在生产端被跳过），
 *   滑它、按它都没有可见变化（等于坏键）；
 * - 名称 / 轨道 / 尾迹：这三样是沙盘的**地图符号**，真实比例下并不存在一条看得见的轨道线，
 *   尾迹/星空/小行星带在实境的 look 里也整体关着（decor / orbitLines = false）；
 * - 总览：实境没有"总览"这个去处。
 * 实境回去的路径只有两条，且都永远可见：徽标的分段控件、Esc。
 */
function Dock() {
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
  return (
    <footer className="hud-dock pointer-events-auto border-t border-line bg-elevated px-3 pt-3 md:px-6">
      <label className="flex items-center gap-3">
        <span className="w-10 text-sm text-muted">速度</span>
        <input
          className="speed-range min-w-0 flex-1"
          type="range"
          min={0.2}
          max={8}
          step={0.1}
          value={speed}
          aria-valuemin={0.2}
          aria-valuemax={8}
          aria-valuenow={speed}
          aria-valuetext={formatSpeed(speed)}
          aria-label="模拟速度"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
        <span className="w-12 text-right text-sm tabular-nums text-fg">{formatSpeed(speed)}</span>
      </label>
      <div className="mt-1 grid grid-cols-5 gap-1.5">
        <button
          type="button"
          className="hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md bg-accent text-sm text-accent-fg"
          aria-label={paused ? "继续模拟" : "暂停模拟"}
          aria-pressed={paused}
          onClick={togglePaused}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          <span className="hidden sm:inline">{paused ? "继续" : "暂停"}</span>
        </button>
        <button
          type="button"
          className={`hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
            showLabels ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
          }`}
          aria-label="名称"
          aria-pressed={showLabels}
          onClick={toggleLabels}
        >
          <Tag className="size-4" />
          <span className="hidden sm:inline">名称</span>
        </button>
        <button
          type="button"
          className={`hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
            showOrbits ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
          }`}
          aria-label="轨道"
          aria-pressed={showOrbits}
          onClick={toggleOrbits}
        >
          <Orbit className="size-4" />
          <span className="hidden sm:inline">轨道</span>
        </button>
        <button
          type="button"
          className={`hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
            showTrails ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"
          }`}
          aria-label="尾迹"
          aria-pressed={showTrails}
          onClick={toggleTrails}
        >
          <Sparkles className="size-4" />
          <span className="hidden sm:inline">尾迹</span>
        </button>
        <button
          type="button"
          className="hud-btn inline-flex h-11 items-center justify-center gap-2 rounded-md border border-line text-sm text-fg"
          aria-label="返回总览"
          onClick={requestReset}
        >
          <LocateFixed className="size-4" />
          <span className="hidden sm:inline">总览</span>
        </button>
      </div>
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
