import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GATE_REQUIRED, encodeGate } from "./gate";
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

/** 实境渲染还没接通（engineer 的 1:1 摆位 + RealHud）。接通后翻真，徽标自动变分段控件。 */
const REAL_READY = false;

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
  panelTitle: "校准", // gate.panel.title
  panelLede: "有另一种看法，还没对齐。", // gate.panel.lede
  panelLedeRevealed: "对齐了。另一种看法在右边。", // gate.panel.lede.revealed
  // —— TODO(copy) 新增 key：t5 的 53 条表里没有，需要补进表 ——
  dotsAria: "已对齐的格数", // TODO(copy) gate.dots.aria（无障碍：三个点没有名字，所以要一句替代描述）
  codeLabel: "带走进度", // TODO(copy) gate.panel.codeLabel
  copyAction: "复制", // TODO(copy) gate.copy.action
  copyOk: "已复制", // TODO(copy) gate.copy.ok
  copyFallback: "已选中，长按复制", // TODO(copy) gate.copy.fallback（file:// 下 clipboard 被拒时的退路）
  importLabel: "有旧进度？", // TODO(copy) gate.panel.importLabel
  importAction: "读入", // TODO(copy) gate.import.action
  importOk: "已读入", // TODO(copy) gate.import.ok
  importFail: "这个码不对", // TODO(copy) gate.import.fail
  // —— 非文案：格式样例，不翻译、不进表 ——
  importPlaceholder: "XG1-ABCDE-FG",
  // —— 临时：REAL_READY 翻真当天删，不进口径表 ——
  unreachable: "实境还没接通", // TODO(temp) 删于 REAL_READY=true
};

export function ModeBadge() {
  const mode = useSim((state) => state.mode);
  const switching = useSim((state) => state.switching);
  const setMode = useSim((state) => state.setMode);
  const gateLit = useSim((state) => state.gateLit);
  const gateUnlocked = useSim((state) => state.gateUnlocked);
  const unlocked = isGateUnlocked({ gateLit, gateUnlocked });
  // 派生而不是读存储：gateLit 一变就重算，同一个进度永远得到同一个码。
  const code = encodeGate(gateLit, unlocked);

  const [open, setOpen] = useState(false);
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);

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
      setStatus(COPY.importOk);
      setDraft("");
    } else {
      setStatus(COPY.importFail);
    }
  };

  const segment = (target: typeof mode, label: string) => (
    <button
      key={target}
      type="button"
      className={`hud-btn inline-flex h-7 items-center rounded-full px-2.5 text-xs ${
        mode === target ? "bg-accent text-accent-fg" : "text-muted"
      }`}
      aria-pressed={mode === target}
      disabled={Boolean(switching)}
      onClick={() => setMode(target)}
    >
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="pointer-events-auto relative shrink-0">
      {unlocked && REAL_READY ? (
        <div
          className="flex h-8 items-center rounded-full border border-line bg-elevated p-0.5"
          role="group"
          aria-label={COPY.toggleAria}
        >
          {segment("sandbox", COPY.badgeSandbox)}
          {segment("real", COPY.badgeReal)}
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
          aria-label={unlocked ? COPY.toggleAria : `${COPY.badgeSandbox} · ${COPY.lockedTag}`}
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
          <p className="text-xs leading-relaxed text-muted">
            {unlocked ? COPY.panelLedeRevealed : COPY.panelLede}
          </p>

          <div className="mt-2 flex items-center gap-1.5" aria-label={COPY.dotsAria}>
            {Array.from({ length: GATE_REQUIRED }, (_, index) => (
              <span
                key={index}
                className={`size-2 rounded-full ${
                  index < gateLit.length ? "bg-accent" : "border border-line"
                }`}
              />
            ))}
          </div>

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

          {unlocked && !REAL_READY && (
            <p className="mt-3 border-t border-line pt-2 text-xs text-subtle">{COPY.unreachable}</p>
          )}
        </div>
      )}
    </div>
  );
}
