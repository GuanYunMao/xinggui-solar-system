import { BODIES } from "./data";

const KEY = "xinggui-visited-v1";

/** 记录玩家点开过的天体，用来在挑战里显示探索进度。 */
export function loadVisited(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function markVisited(id: string) {
  if (typeof window === "undefined") return;
  const visited = loadVisited();
  if (visited.has(id)) return;
  visited.add(id);
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...visited]));
  } catch {
    /* ignore quota */
  }
}

export const TOTAL_BODIES = BODIES.length;
