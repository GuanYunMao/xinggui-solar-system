import { LocateFixed, Orbit, Pause, Play, Sparkles, Tag } from "lucide-react";
import { useEffect } from "react";
import { ModeBadge } from "./ModeBadge";
import { OrbitGlyph } from "./BrandMark";
import { APP_ERA_NAME, versionLabel } from "./brand";
import { bindSettingsPersistence, loadSettings, useSim } from "./store";
import { useSystem } from "./system-context";

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
  const paused = useSim((state) => state.paused);
  const speed = useSim((state) => state.speed);
  const showLabels = useSim((state) => state.showLabels);
  const showOrbits = useSim((state) => state.showOrbits);
  const showTrails = useSim((state) => state.showTrails);
  const selectedId = useSim((state) => state.selectedId);
  const days = useSim((state) => state.days);
  const togglePaused = useSim((state) => state.togglePaused);
  const setSpeed = useSim((state) => state.setSpeed);
  const toggleLabels = useSim((state) => state.toggleLabels);
  const toggleOrbits = useSim((state) => state.toggleOrbits);
  const toggleTrails = useSim((state) => state.toggleTrails);
  const select = useSim((state) => state.select);
  const requestReset = useSim((state) => state.requestReset);
  const { byId, byParent, chips } = useSystem();
  const selected = selectedId ? byId[selectedId] : undefined;
  // 卫星在三维场景里太小，靠手点很难命中；选中母行星时把它的卫星排成一行。
  // 注意 chips 是「无 parent 或 parent 是太阳」的天体，不是卫星，别让它变成「太阳的卫星」。
  const group = selected
    ? selected.parent && selected.parent !== "sun"
      ? byId[selected.parent]
      : selected
    : undefined;
  const moons = group && group.id !== "sun" ? (byParent.get(group.id) ?? []) : [];

  useEffect(() => {
    useSim.getState().hydrate(loadSettings());
    // 进度独立一个键、独立一次读取：存储挂了只丢记忆，不丢「这次能不能进」。
    useSim.getState().hydrateGate();
    return bindSettingsPersistence();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.code === "Space") {
        if (tag === "BUTTON") return;
        event.preventDefault();
        useSim.getState().togglePaused();
      } else if (event.code === "Escape") {
        // 浮层开着时 Esc 先关浮层（浮层自己的监听负责），别顺手把镜头拉回总览
        if (document.querySelector('[data-overlay-open="true"]')) return;
        useSim.getState().requestReset();
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
  }, [chips]);

  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(`chip-${selectedId}`)?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [selectedId]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 pt-4 md:px-6 md:pt-6">
        {/*
          左上 = 图标 + 代际名 + 版本号，**不放全名**：
          「巡星·未至之境」7 字在 text-3xl 下约 210px，320 宽屏左栏只有 167px，物理放不下。
          全名唯一的家是启动页（App.tsx），那里才有地方让它居中排开。
        */}
        <div className="sky-title flex min-w-0 items-center gap-2.5">
          <h1 className="flex items-center gap-2">
            <OrbitGlyph className="size-8 shrink-0 text-fg" />
            <span className="text-base leading-none tracking-[0.2em] text-muted">{APP_ERA_NAME}</span>
          </h1>
          <span className="eyebrow text-[11px] text-subtle">{versionLabel(__APP_VERSION__)}</span>
        </div>
        {/*
          右侧改成单行（原来是两行 40px）：模式徽标 + 分隔线 + 模拟历。
          徽标占的是「区划」的位置，绝不下放到底栏——底栏 grid-cols-5 已满，
          而且底栏是玩具区（暂停/图层），区划和玩具混层会让人找不到它。
        */}
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <ModeBadge />
          <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
          <div className="sky-title flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="hidden text-xs text-muted sm:inline">
              {paused ? "已暂停" : "模拟历"}
            </span>
            <p className="text-lg tabular-nums text-fg">{formatEpoch(days)}</p>
          </div>
        </div>
      </header>

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

      {moons.length > 0 && (
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
      )}

      <div className="relative min-h-0 flex-1">
        {/*
          手机端是底部抽屉（原来贴在顶部，选中行星时正好盖住星球）。
          竖屏时镜头会把星球抬到上半屏，配合这里每屏最多 44% 高度。
        */}
        {selected && (
          <article
            key={selected.id}
            className="panel-in pointer-events-auto absolute inset-x-3 bottom-3 max-h-[44dvh] overflow-y-auto rounded-xl border border-line bg-elevated p-4 md:inset-x-auto md:top-4 md:right-6 md:bottom-4 md:max-h-none md:w-80"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-muted">{selected.kind}</p>
                <h2 className="font-display mt-1 text-xl leading-tight text-fg md:text-2xl">
                  {selected.name}
                </h2>
              </div>
              <button
                type="button"
                className="hud-btn -mr-1 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-subtle md:hidden"
                aria-label="关闭详情"
                onClick={requestReset}
              >
                ✕
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-fg">{selected.blurb}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 md:gap-3">
              {selected.facts.map((fact) => (
                <div key={fact.label} className="rounded-md bg-bg px-3 py-2">
                  <dt className="text-xs text-muted">{fact.label}</dt>
                  <dd className="mt-1 text-sm text-fg tabular-nums">{fact.value}</dd>
                </div>
              ))}
            </dl>
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
          </article>
        )}
        {!selected && (
          <p className="sky-title pointer-events-none absolute bottom-4 left-6 hidden max-w-sm text-sm text-muted md:block">
            拖拽旋转，滚轮缩放。点选行星后，镜头会平滑聚焦并跟着它走。
          </p>
        )}
      </div>

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
    </div>
  );
}
