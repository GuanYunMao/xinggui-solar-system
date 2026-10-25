import { ChevronDown, Copy, Download, Radio } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GATE_REQUIRED, encodeGate, type GateSlot } from "./gate";
import { isGateUnlocked, useSim } from "./store";

/** 实境入口总闸；锁态按钮始终可点，点击后必须给出校准面板作为回执。 */
const REAL_READY = true;

const COPY = {
  badgeSandbox: "沙盘",
  badgeReal: "实境",
  lockedTag: "未对齐",
  toggleAria: "切换视图",
  lockedAria: "沙盘 · 未对齐，打开校准面板",
  panelTitle: "校准",
  panelLede: "当前为压缩视图。真实视图待校准归档。",
  panelLedeRevealed: "校准已归档。真实视图可用。",
  dotsAria: "校准进度",
  codeLabel: "进度码",
  copyAction: "复制",
  copyOk: "已复制",
  copyFallback: "已选中，手动复制",
  importLabel: "旧进度码",
  importAction: "恢复",
  importOk: "已读入",
  importFail: "码无效，核对后重填",
  importVersion: "这个码来自别的版本。",
  saveWarn: "这次能进，下次未必记得住。",
  /*
   * 三条校准提示：写玩家在画面上看得见的现象。不写操作指令，也不写判定内部的量。
   *
   * 每条对的是哪件看得见的事（t34 逐条实测过）：
   *  - time：月球走进地球本影、那一刻它被玩家选中。不写选中会让人手缩镜头白等 15 秒（t18）。
   *  - target：**选中水星后画面里是一张盘面，不是整条轨道**。实测机位 2.8 wu、盘面半径
   *    128.5 px（直径约 257 px），可视宽约 2.15 wu，而轨道半径 8.6 wu —— 玩家看到的是
   *    明暗一圈圈走，所以写「明暗走完一轮」。t28 那句讲轨道的话描述的是画面外的东西，撤掉。
   *  - layer：两层都不在时，**在画布上**点中一颗行星才算（点芯片不算：芯片行常驻印着名字，
   *    对着名字点等于对着答案点，t33）。所以写「画面上点得中」而不是「选得中」。
   *
   * 三条的关系写进 hintRules（不分先后 / 第二条别换目标 / 8× 与 1× 各要多久）：
   * 前半截是 t33 的归零规则（换成别的天体才清零，同一颗再点一次不清），
   * 后半截是速度前提 —— 同一件事在 1× 上要 166 秒，不写玩家会以为坏了。
   */
  hintTime: "月球进影子时，它正被选中",
  hintTarget: "选中水星，看它明暗走完一轮",
  hintLayer: "名称与轨道都不在，画面上点得中",
  hintRules: "三条不分先后；第二条盯住水星别换，8× 约 20.8 秒、1× 约 166 秒。",
  celebrateLine: "日志 · 三次校准已归档。距日愈远，公转愈缓。",
  importPlaceholder: "XG1-ABCDE-FG",
};

const CELEBRATE_MS = 2600;
const CTA_HINT_MS = 1500;

export function ModeBadge() {
  const mode = useSim((state) => state.mode);
  const switching = useSim((state) => state.switching);
  const setMode = useSim((state) => state.setMode);
  const gateLit = useSim((state) => state.gateLit);
  const gateUnlocked = useSim((state) => state.gateUnlocked);
  const unlocked = isGateUnlocked({ gateLit, gateUnlocked });
  const persistFailed = useSim((state) => state.gatePersistFailed);
  const code = encodeGate(gateLit, unlocked);
  const filled = Math.min(gateLit.length, GATE_REQUIRED);
  const overflow = Math.max(0, gateLit.length - GATE_REQUIRED);

  const [open, setOpen] = useState(false);
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [ctaHint, setCtaHint] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const ctaTimer = useRef<number | null>(null);
  const wasUnlocked = useRef(unlocked);

  useEffect(() => {
    if (unlocked && !wasUnlocked.current) {
      wasUnlocked.current = true;
      setCelebrate(true);
      const celebrateTimer = window.setTimeout(() => {
        setCelebrate(false);
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
    setOpen((previous) => {
      if (!previous) useSim.getState().bumpGateSeen();
      return !previous;
    });
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeNote(COPY.copyOk);
    } catch {
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
      setStatus(result.added > 0 ? `${COPY.importOk} +${result.added}` : COPY.importOk);
      setDraft("");
    } else {
      setStatus(result.reason === "version" ? COPY.importVersion : COPY.importFail);
    }
  };

  const segment = (target: typeof mode, label: string, highlight = false) => (
    <button
      key={target}
      type="button"
      className={`hud-btn mode-segment inline-flex items-center justify-center px-2.5 text-muted ${highlight ? "gate-cta" : ""}`}
      aria-pressed={mode === target}
      disabled={Boolean(switching)}
      data-cta-hint={highlight ? "true" : undefined}
      onClick={() => setMode(target)}
    >
      {label}
    </button>
  );

  const hints: { slot: GateSlot; label: string }[] = [
    { slot: "time", label: COPY.hintTime },
    { slot: "target", label: COPY.hintTarget },
    { slot: "layer", label: COPY.hintLayer },
  ];

  return (
    <div ref={rootRef} className="pointer-events-auto relative shrink-0">
      {unlocked && REAL_READY ? (
        <div className="mode-switch flex items-center p-0.5" role="group" aria-label={COPY.toggleAria}>
          {segment("sandbox", COPY.badgeSandbox)}
          {segment("real", COPY.badgeReal, ctaHint)}
          <button
            key="panel"
            type="button"
            className="hud-btn mode-panel-trigger ml-0.5 inline-flex size-6 items-center justify-center text-subtle"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={COPY.panelTitle}
            onClick={togglePanel}
          >
            <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="hud-btn mode-locked inline-flex items-center gap-1.5 pr-1.5 pl-2.5 text-muted"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={unlocked ? COPY.toggleAria : COPY.lockedAria}
          onClick={togglePanel}
        >
          <Radio className="size-3 text-subtle" aria-hidden />
          <span>{mode === "real" ? COPY.badgeReal : COPY.badgeSandbox}</span>
          {!unlocked && <span className="mode-locked-tag">{COPY.lockedTag}</span>}
          <ChevronDown className={`size-3 shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      )}

      {open && (
        <section
          data-overlay-open="true"
          role="dialog"
          aria-label={COPY.panelTitle}
          className="calibration-panel panel-in absolute top-full right-0 z-30 mt-2"
        >
          <header className="calibration-head flex items-start justify-between gap-4">
            <div>
              <p className="calibration-kicker">CAL / OBSERVATION LOG</p>
              <h2 className="calibration-title">观测校准</h2>
            </div>
            <p className="calibration-count" aria-hidden>
              {String(filled).padStart(2, "0")}
              <span className="ml-1 text-xs text-subtle">/ {String(GATE_REQUIRED).padStart(2, "0")}</span>
            </p>
          </header>

          <div className="calibration-body">
            <p className="text-xs leading-relaxed text-muted">{unlocked ? COPY.panelLedeRevealed : COPY.panelLede}</p>

            <div
              className="mt-3 flex items-center gap-3"
              role="progressbar"
              aria-label={COPY.dotsAria}
              aria-valuemin={0}
              aria-valuemax={GATE_REQUIRED}
              aria-valuenow={filled}
            >
              <div className="calibration-progress" aria-hidden>
                <span style={{ width: `${(filled / GATE_REQUIRED) * 100}%` }} />
              </div>
              <span className="font-mono text-[10px] text-subtle">
                {filled}/{GATE_REQUIRED}{overflow > 0 ? ` +${overflow}` : ""}
              </span>
            </div>

            <ul className="mt-3 text-xs">
              {hints.map((hint, index) => {
                const lit = gateLit.includes(hint.slot);
                return (
                  <li
                    key={hint.slot}
                    data-gate-hint={hint.slot}
                    data-lit={lit ? "true" : "false"}
                    className={`gate-hint flex items-center gap-2 ${lit ? "text-fg" : "text-subtle"}`}
                  >
                    <span className="gate-hint-index">{String(index + 1).padStart(2, "0")}</span>
                    <span>{hint.label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] tracking-wider">
                      {lit ? "已归档" : "待观测"}
                    </span>
                  </li>
                );
              })}
            </ul>

            {/* t34：三条的关系（不分先后 / 第二条别换目标 / 两个速度档各要多久）。会折行，不用单行。 */}
            <p data-gate-rules className="mt-2 text-[11px] leading-relaxed text-subtle">
              {COPY.hintRules}
            </p>

            {persistFailed && <p className="mt-3 text-xs leading-relaxed text-muted">{COPY.saveWarn}</p>}

            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] tracking-[0.14em] text-subtle">{COPY.codeLabel}</p>
                <button type="button" className="hud-btn inline-flex h-7 items-center gap-1.5 border border-line px-2 text-[11px] text-fg" onClick={copyCode}>
                  <Copy className="size-3" aria-hidden />
                  {COPY.copyAction}
                </button>
              </div>
              <code ref={codeRef} className="gate-code mt-2 block px-2.5 py-2 text-xs tracking-wider select-all">
                {code}
              </code>
              {codeNote && <p className="mt-1.5 text-[11px] text-subtle">{codeNote}</p>}
            </div>

            <form className="mt-3" onSubmit={submitCode}>
              <label className="text-[10px] tracking-[0.14em] text-subtle" htmlFor="gate-code-input">
                {COPY.importLabel}
              </label>
              <div className="mt-2 flex gap-1.5">
                <input
                  id="gate-code-input"
                  className="h-9 min-w-0 flex-1 border px-2.5 text-xs tracking-wider"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={16}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={COPY.importPlaceholder}
                />
                <button type="submit" className="hud-btn inline-flex h-9 shrink-0 items-center gap-1.5 border border-line px-2.5 text-xs text-fg">
                  <Download className="size-3" aria-hidden />
                  {COPY.importAction}
                </button>
              </div>
              {status && <p role="status" className="mt-1.5 text-[11px] text-subtle">{status}</p>}
            </form>
          </div>
        </section>
      )}

      {celebrate && (
        <div role="status" aria-live="polite" className="gate-celebrate pointer-events-none z-40">
          <p className="calibration-kicker">SYSTEM / LOG UPDATED</p>
          <div className="gate-orbit-line mt-2" aria-hidden>
            <span className="gate-node" />
            <span className="gate-node" />
            <span className="gate-node" />
          </div>
          <p className="mt-2 text-center text-sm leading-relaxed text-fg">{COPY.celebrateLine}</p>
        </div>
      )}
    </div>
  );
}
