import { useEffect, useState } from "react";
import { drawRound, type Question } from "./questions";
import { loadVisited, TOTAL_BODIES } from "./progress";

const ROUND = 8;
const BEST_KEY = "xinggui-quiz-best";

function loadBest() {
  try {
    return Number(window.localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * 星问：八道选择题的知识挑战。
 * 做小游戏而不是再加参数开关 —— 同类产品里真正把人留住的也是这类问答循环。
 */
export function Quiz({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [round, setRound] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [done, setDone] = useState(false);

  const start = () => {
    setRound(drawRound(ROUND));
    setIndex(0);
    setPicked(null);
    setScore(0);
    setDone(false);
  };

  useEffect(() => {
    if (!open) return;
    setBest(loadBest());
    start();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const question = round[index];
  const isLast = index === round.length - 1;
  const visited = loadVisited().size;

  const choose = (i: number) => {
    if (picked !== null || !question) return;
    setPicked(i);
    if (i === question.answer) setScore((s) => s + 1);
  };

  const next = () => {
    if (!question) return;
    const finalScore = score;
    if (isLast) {
      setDone(true);
      if (finalScore > best) {
        setBest(finalScore);
        try {
          window.localStorage.setItem(BEST_KEY, String(finalScore));
        } catch {
          /* ignore */
        }
      }
      return;
    }
    setIndex((i) => i + 1);
    setPicked(null);
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="星问挑战"
    >
      <div className="panel-in max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-xl border border-line bg-elevated p-5">
        {done ? (
          <div className="text-center">
            <p className="text-xs text-muted">本轮结束</p>
            <p className="font-display mt-2 text-5xl tabular-nums text-fg">
              {score}
              <span className="text-lg text-muted">/{round.length}</span>
            </p>
            <p className="mt-2 text-sm text-muted">最佳 {Math.max(best, score)} 分</p>

            <div className="mt-5 rounded-lg border border-line bg-bg px-4 py-3 text-left">
              <p className="text-xs text-muted">探索进度</p>
              <p className="mt-1 text-sm text-fg">
                已走过 {visited}/{TOTAL_BODIES} 个天体
              </p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(visited / TOTAL_BODIES) * 100}%` }}
                />
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="hud-btn h-11 flex-1 rounded-md bg-accent text-sm text-accent-fg"
                onClick={start}
              >
                再来一局
              </button>
              <button
                type="button"
                className="hud-btn h-11 flex-1 rounded-md border border-line text-sm text-fg"
                onClick={onClose}
              >
                返回星图
              </button>
            </div>
          </div>
        ) : question ? (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted">
                第 {index + 1} / {round.length} 题
              </p>
              <p className="text-xs tabular-nums text-muted">得分 {score}</p>
            </div>

            <h2 className="mt-3 text-lg leading-snug text-fg">{question.prompt}</h2>

            <div className="mt-4 flex flex-col gap-2">
              {question.options.map((option, i) => {
                const correct = i === question.answer;
                const chosen = i === picked;
                const revealed = picked !== null;
                const cls = !revealed
                  ? "border-line bg-bg text-fg"
                  : correct
                    ? "border-accent bg-accent text-accent-fg"
                    : chosen
                      ? "border-[#c96a5f] bg-bg text-[#e0a09a]"
                      : "border-line bg-bg text-subtle";
                return (
                  <button
                    key={option}
                    type="button"
                    className={`hud-btn min-h-11 rounded-md border px-4 py-2 text-left text-sm ${cls}`}
                    disabled={revealed}
                    onClick={() => choose(i)}
                  >
                    {option}
                  </button>
                );
              })}
            </div>

            {picked !== null && (
              <div className="panel-in mt-4 rounded-lg border border-line bg-bg px-4 py-3">
                <p className="text-xs text-muted">{picked === question.answer ? "答对了" : "再记一下"}</p>
                <p className="mt-1 text-sm leading-relaxed text-fg">{question.note}</p>
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="hud-btn h-11 flex-1 rounded-md border border-line text-sm text-muted"
                onClick={onClose}
              >
                退出
              </button>
              <button
                type="button"
                className="hud-btn h-11 flex-[2] rounded-md bg-accent text-sm text-accent-fg disabled:opacity-40"
                disabled={picked === null}
                onClick={next}
              >
                {isLast ? "看结果" : "下一题"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
