import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GATE_REQUIRED, encodeGate, type GateSlot } from "./gate";
import { isGateUnlocked, useSim } from "./store";

/**
 * 模式徽标：一个控件两用 —— 现在在哪个视图 + 唯一的入口（t8 §2）。
 *
 * ## 锁态必须靠文字和配色表达，点击必须有反馈（t2 定，**别改回去**）
 *
 * 未解锁时用**次级配色 + 「未对齐」小标签**表达锁态，但按钮**照常可点**，
 * 点开只给一个只读面板，进不去实境。
 *
 * **不要给这个按钮加 `disabled`，也不要加 `aria-disabled`。** 第一版加了 aria-disabled，
 * 结果是同一个事实被两边同时承认：读屏念「不可用」，Playwright 判成 not enabled 拒绝点击
 * （实测 30s 超时点不动）。「点了没反应」于是从**一个 bug** 变成**一个语义上的既定事实**
 * —— 测试和辅助技术都会替这堵墙作证，谁也不会再报它。这是最坏的失败模式：
 * 缺陷不再是缺陷，而是规格。锁态交给文字与颜色说，点击永远要有回执。
 *
 * 为什么未解锁时不点名「实境」：点名就等于清单第一行。面板第一次打开只说"还没对齐"，
 * 解锁那一刻名字才出现。
 *
 * 为什么面板可以点外面关、Esc 关：它是浮层不是页面，浮层的常识行为缺一条就会被记成 bug。
 */

/**
 * 实境渲染已接通（t16）：`App` 让 `SystemProvider` 跟着 store 的 `mode` 走，
 * 相机侧由 `<MeterCamera>` 接管（渲染层按 spec 的 `look.camera` 二选一挂载），
 * 所以徽标解锁后就是可用的分段控件。
 * 这条开关留着当**总闸**：哪天实境要临时下线，翻回 false 即可，不用拆 UI。
 */
const REAL_READY = true;

/**
 * 文案占位。**整块待换**，不要在组件里再加字——加字就是第二份真相。
 *
 * 交接给文案负责人时看 `// TODO(copy)`：带这个标记的是**新 key**（narrator 的 53 条表里没有），
 * 需要补进表；不带标记的是从 t5 表里来的，改值即可。
 * 一个 grep 就能拿到全集：`rg "TODO\(copy\)" src/solar/ModeBadge.tsx`
 */
const COPY = {
  // —— t5 表里已有的 key（改值即可，不用新增）——
  badgeSandbox: "沙盘", // mode.badge.sandbox
  badgeReal: "实境", // mode.badge.real
  lockedTag: "未对齐", // gate.entry.locked
  toggleAria: "切换视图", // mode.entry.toggle
  // 锁态只可能出现在沙盘（硬门在 sandbox→real 上），所以这句可以写死「沙盘」；
  // 哪天出现「锁态 + 实境」的组合，这里要拆成模板，别硬改字。
  lockedAria: "沙盘 · 未对齐，打开校准面板", // gate.badge.lockedAria
  panelTitle: "校准", // gate.panel.title
  panelLede: "当前为压缩视图。真实视图待校准归档。", // gate.panel.lede
  panelLedeRevealed: "校准已归档。真实视图可用。", // gate.panel.lede.revealed
  // 注意：t2 的 gate.unlock.line（旧稿那条一句话开启语，已随 t46 换成日志体）目前**没有渲染点**——
  // 它属于「三点全实时面板换形态」那一刻，那个形态还没做。将来做的时候，
  // lede.revealed 要让位给它，否则同一句话会在一屏里出现两遍。
  dotsAria: "校准进度", // gate.dots.aria（数值由 aria-valuenow 念，label 不重复数字）
  codeLabel: "进度码", // gate.panel.codeLabel
  copyAction: "复制", // gate.copy.action
  copyOk: "已复制", // gate.copy.ok
  copyFallback: "已选中，手动复制", // gate.copy.fallback（桌面按 Ctrl+C，所以不能写"长按"）
  importLabel: "旧进度码", // gate.panel.importLabel
  importAction: "恢复", // gate.import.action
  importOk: "已读入", // gate.import.ok（"已恢复"在 added=0 时是假话，故意不用）
  importFail: "码无效，核对后重填", // gate.import.fail
  importVersion: "这个码来自别的版本。", // TODO(copy) gate.import.version（唯一"核对"解决不了的错，单独一句）
  saveWarn: "这次能进，下次未必记得住。", // gate.save.warn（writeGate 失败时）
  // —— t28：三条门从「摸过控件」改成「可判定的观察」——
  // t46：整组改成**航行日志腔**（B）：无人称、仪器记录口吻、术语精确（公转/距日/名称/轨道
  // 与卡片、底栏同名），提示保留动作所以仍然可执行。
  hintTime: "时间 · 推进一年", // gate.hint.time（判定：daysOf(simSeconds) ≥ 365.25）
  hintTarget: "轨道 · 锁定公转最短者", // gate.hint.target（判定：最后选中水星；术语「公转」同卡片）
  hintLayer: "图层 · 关闭名称与轨道", // gate.hint.layer（判定：两者同时为 false；术语同底栏）
  // 记录体：无人称、不表扬、不替玩家念长篇；「归档」= 观测被记下，不是考试通过
  celebrateLine: "日志 · 三次校准已归档。距日愈远，公转愈缓。", // gate.celebrate
  // —— 非文案：格式样例，不翻译、不进表 ——
  importPlaceholder: "XG1-ABCDE-FG",
};

/** 庆祝层时长（t28：三点连成轨道线）。 */
const CELEBRATE_MS = 2600;
/**
 * 实境入口的自证高亮时长（t54）：**只出现一次**，到点无条件回常态。
 * 观察位实测：解锁后实境段位 44×28、底色 transparent、`animationName=null` —— 可点但零提示。
 */
const CTA_HINT_MS = 1500;

export function ModeBadge() {
  const mode = useSim((state) => state.mode);
  const switching = useSim((state) => state.switching);
  const setMode = useSim((state) => state.setMode);
  const gateLit = useSim((state) => state.gateLit);
  const gateUnlocked = useSim((state) => state.gateUnlocked);
  const unlocked = isGateUnlocked({ gateLit, gateUnlocked });
  const persistFailed = useSim((state) => state.gatePersistFailed);
  // 派生而不是读存储：gateLit 一变就重算，同一个进度永远得到同一个码。
  const code = encodeGate(gateLit, unlocked);
  // 点数跟「本次要求」走；超出要求的部分（追加彩蛋、没上调要求时）走 +N 角标。
  // 夹住之后 aria-valuenow 永远 ≤ aria-valuemax，无障碍不会念出非法数字。
  const filled = Math.min(gateLit.length, GATE_REQUIRED);
  const overflow = Math.max(0, gateLit.length - GATE_REQUIRED);

  const [open, setOpen] = useState(false);
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  /**
   * t28：解锁那一刻只播一次「三点连成轨道线」。**纯 CSS 动画**，这里只负责
   * 开/关一个状态 —— 不起 rAF、不每帧写 DOM（正在量微卡顿，面板不许进帧预算）。
   * 2600ms 到点自动收起；`prefers-reduced-motion` 时动画静止但文案照样出现。
   *
   * t54：庆祝层退场时，实境入口再来一次 1.5s 的**自证高亮**（观察位的头条：
   * 解锁后 `realMentions=1 / hintMentions=0 / animationName=null`，入口可点却零提示）。
   * 同样只是开关一个状态，动画全在 CSS：`transform / filter / opacity`，不动布局。
   */
  const [celebrate, setCelebrate] = useState(false);
  const [ctaHint, setCtaHint] = useState(false);
  const ctaTimer = useRef<number | null>(null);
  const wasUnlocked = useRef(unlocked);
  useEffect(() => {
    if (unlocked && !wasUnlocked.current) {
      wasUnlocked.current = true;
      setCelebrate(true);
      const celebrateTimer = window.setTimeout(() => {
        setCelebrate(false);
        // 庆祝层退场的那一拍开始指路：1.5s 后无条件回到常态（不许常驻动画）
        setCtaHint(true);
        ctaTimer.current = window.setTimeout(() => {
          setCtaHint(false);
          ctaTimer.current = null;
        }, CTA_HINT_MS);
      }, CELEBRATE_MS);
      return () => {
        window.clearTimeout(celebrateTimer);
        if (ctaTimer.current) window.clearTimeout(ctaTimer.current);
      };
    }
    wasUnlocked.current = unlocked;
    return undefined;
  }, [unlocked]);
  /** 三条门各自的方向提示（面板只给方向，答案在卡片里）。 */
  const hints: { slot: GateSlot; label: string }[] = [
    { slot: "time", label: COPY.hintTime },
    { slot: "target", label: COPY.hintTarget },
    { slot: "layer", label: COPY.hintLayer },
  ];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCodeNote(null);
      setStatus(null);
    }
  }, [open]);

  const togglePanel = () => {
    setOpen((prev) => {
      if (!prev) useSim.getState().bumpGateSeen();
      return !prev;
    });
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeNote(COPY.copyOk);
    } catch {
      // file:// 下 clipboard 常被浏览器直接拒：退化成选中文本，让玩家自己长按。
      const node = codeRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCodeNote(COPY.copyFallback);
    }
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const result = useSim.getState().restoreGateCode(draft);
    if (result.ok) {
      // added === 0 是读自己码的常见情况：只说「已读入」，绝不暗示进度变多。
      setStatus(result.added > 0 ? `${COPY.importOk} +${result.added}` : COPY.importOk);
      setDraft("");
    } else {
      // version 是唯一「核对」永远解决不了的错，单独给一句，否则玩家会一直重抄。
      setStatus(result.reason === "version" ? COPY.importVersion : COPY.importFail);
    }
  };

  const segment = (target: typeof mode, label: string, highlight = false) => (
    <button
      key={target}
      type="button"
      className={`hud-btn inline-flex h-7 items-center rounded-full px-2.5 text-xs ${
        mode === target ? "bg-accent text-accent-fg" : "text-muted"
      } ${highlight ? "gate-cta" : ""}`}
      aria-pressed={mode === target}
      disabled={Boolean(switching)}
      data-cta-hint={highlight ? "true" : undefined}
      onClick={() => setMode(target)}
    >
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="pointer-events-auto relative shrink-0">
      {unlocked && REAL_READY ? (
        /*
          解锁后是「两段 + 一个折角」：两段切模式，折角开面板。
          折角必须留着——面板里有进度码的导出/读入，那是换设备唯一的搬家通道；
          如果解锁后徽标变成纯分段控件，那条通道就在解锁的一瞬间消失了。
        */
        <div
          className="flex h-8 items-center rounded-full border border-line bg-elevated p-0.5"
          role="group"
          aria-label={COPY.toggleAria}
        >
          {segment("sandbox", COPY.badgeSandbox)}
          {segment("real", COPY.badgeReal, ctaHint)}
          {/*
            key 必须给：上面两段是带 key 的（segment 里 key={target}），这个折角如果没 key，
            同一个 children 列表里就混了「带 key」和「不带 key」两种身份。React 在两支之间
            切换（锁态单按钮 ↔ 解锁分段）时按身份做插入/删除，混着来就会去删一个它以为还在的
            旧节点 —— 实测报 `removeChild: not a child of this node`（页面没崩，但控制台有错）。
          */}
          <button
            key="panel"
            type="button"
            className="hud-btn ml-0.5 inline-flex size-6 items-center justify-center rounded-full text-subtle"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={COPY.panelTitle}
            onClick={togglePanel}
          >
            <ChevronDown className={`size-3.5 shrink-0 ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      ) : (
        /*
          未解锁时**故意不加 disabled / aria-disabled**：这个按钮必须点得动（点开只读面板）。
          加了它，读屏会念「不可用」、Playwright 会判 not enabled 拒绝点击（实测 30s 超时），
          「点了没反应」就从 bug 升级成规格——测试和辅助技术一起替这堵墙作证。
          锁态只由「未对齐」标签 + text-muted 表达，点击永远有回执（面板展开的动效）。
        */
        <button
          type="button"
          className={`hud-btn inline-flex h-8 items-center gap-1 rounded-full border border-line bg-elevated pr-1.5 pl-2.5 text-xs ${
            unlocked ? "text-fg" : "text-muted"
          }`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={unlocked ? COPY.toggleAria : COPY.lockedAria}
          onClick={togglePanel}
        >
          {mode === "real" ? COPY.badgeReal : COPY.badgeSandbox}
          {!unlocked && <span className="text-subtle">{COPY.lockedTag}</span>}
          <ChevronDown className={`size-3.5 shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {open && (
        <div
          data-overlay-open="true"
          role="dialog"
          aria-label={COPY.panelTitle}
          className="panel-in absolute top-full right-0 z-20 mt-2 w-72 rounded-xl border border-line bg-elevated p-3 shadow-lg"
        >
          <div className="gate-panel">
            <div className="gate-glow">
              <p className="text-xs leading-relaxed text-muted">
                {unlocked ? COPY.panelLedeRevealed : COPY.panelLede}
              </p>
              {/* 三条门的方向提示：只给"做什么"，不给答案（答案在卡片里） */}
              <ul className="mt-2 grid gap-1 text-xs">
                {hints.map((hint) => {
                  const lit = gateLit.includes(hint.slot);
                  return (
                    <li
                      key={hint.slot}
                      data-gate-hint={hint.slot}
                      data-lit={lit ? "true" : "false"}
                      className={`flex items-center gap-2 ${lit ? "text-fg" : "text-subtle"}`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${lit ? "bg-accent" : "border border-line"}`}
                        aria-hidden
                      />
                      <span>{hint.label}</span>
                      {/* 一眼看出"记下没记下"：日志腔用「已归档 / 待观测」，不用游戏化套话 */}
                      <span className="ml-auto shrink-0 text-[10px]">{lit ? "✓ 已归档" : "待观测"}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            {/* 点光粒：纯 CSS 的 transform/opacity，不占帧预算 */}
            <span className="gate-mote gate-mote-a" aria-hidden />
            <span className="gate-mote gate-mote-b" aria-hidden />
            <span className="gate-mote gate-mote-c" aria-hidden />
          </div>

          {/*
            点数是「本次校准要求几格」，所以跟 GATE_REQUIRED，不跟 GATE_SLOTS（12 槽是短码的容量）。
            将来追加彩蛋只有两条合法路径：
              ① 上调 GATE_REQUIRED（点自然变多）；
              ② 不上调 —— 多出来的点亮数走下面的 +N 角标。
            两条路都不会出现「码里亮着 N 个、界面上没有位置」。
            数值一律夹在 [0, GATE_REQUIRED]，这样 aria-valuenow 永远合法（无障碍不写假数字）。
          */}
          <div
            className="mt-2 flex items-center gap-1.5"
            role="progressbar"
            aria-label={COPY.dotsAria}
            aria-valuemin={0}
            aria-valuemax={GATE_REQUIRED}
            aria-valuenow={filled}
          >
            {Array.from({ length: GATE_REQUIRED }, (_, index) => (
              <span
                key={index}
                className={`size-2 rounded-full ${index < filled ? "bg-accent" : "border border-line"}`}
              />
            ))}
            {overflow > 0 && (
              <span className="text-[10px] leading-none tabular-nums text-subtle">+{overflow}</span>
            )}
          </div>

          {/* 写盘失败时说一句真话：进度没丢，只是没记住。等金色 token 落地后这里可以换 text-gold。 */}
          {persistFailed && (
            <p className="mt-2 text-xs leading-relaxed text-muted">{COPY.saveWarn}</p>
          )}

          <div className="mt-3">
            <p className="text-xs text-muted">{COPY.codeLabel}</p>
            <code
              ref={codeRef}
              className="mt-1 block rounded-md bg-bg px-2 py-1.5 font-mono text-xs tracking-wider text-fg select-all"
            >
              {code}
            </code>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                className="hud-btn inline-flex h-8 items-center rounded-md border border-line px-2 text-xs text-fg"
                onClick={copyCode}
              >
                {COPY.copyAction}
              </button>
              {codeNote && <span className="text-xs text-subtle">{codeNote}</span>}
            </div>
          </div>

          <form className="mt-3" onSubmit={submitCode}>
            <label className="text-xs text-muted" htmlFor="gate-code-input">
              {COPY.importLabel}
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                id="gate-code-input"
                className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs tracking-wider text-fg"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={16}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder={COPY.importPlaceholder}
              />
              <button
                type="submit"
                className="hud-btn inline-flex h-8 shrink-0 items-center rounded-md border border-line px-2 text-xs text-fg"
              >
                {COPY.importAction}
              </button>
            </div>
            {status && <p className="mt-1 text-xs text-subtle">{status}</p>}
          </form>
        </div>
      )}

      {/* t28：解锁那一刻——三个点连成一条轨道线，一句话把两条观察接起来。纯 CSS，2600ms 自收 */}
      {celebrate && (
        <div
          role="status"
          aria-live="polite"
          className="gate-celebrate pointer-events-none absolute top-full right-0 z-30 mt-2 w-72 rounded-xl border border-accent bg-elevated p-4"
        >
          <div className="gate-orbit-line" aria-hidden>
            <span className="gate-node" />
            <span className="gate-node" />
            <span className="gate-node" />
          </div>
          <p className="mt-3 text-center text-sm leading-relaxed text-fg">{COPY.celebrateLine}</p>
        </div>
      )}
    </div>
  );
}
