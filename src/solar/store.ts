import { create } from "zustand";

const KEY = "xinggui-settings-v1";

type Settings = {
  speed?: number;
  showLabels?: boolean;
  showOrbits?: boolean;
  showTrails?: boolean;
};

function clampSpeed(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(8, Math.max(0.2, value));
}

type SimStore = {
  paused: boolean;
  speed: number;
  showLabels: boolean;
  showOrbits: boolean;
  showTrails: boolean;
  selectedId: string | null;
  days: number;
  resetToken: number;
  togglePaused: () => void;
  setSpeed: (speed: number) => void;
  toggleLabels: () => void;
  toggleOrbits: () => void;
  toggleTrails: () => void;
  select: (id: string | null) => void;
  setDays: (days: number) => void;
  requestReset: () => void;
  hydrate: (settings: Settings) => void;
};

export const useSim = create<SimStore>((set) => ({
  paused: false,
  speed: 1,
  showLabels: true,
  showOrbits: true,
  showTrails: true,
  selectedId: null,
  days: 0,
  resetToken: 0,
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  setSpeed: (speed) => set({ speed: clampSpeed(speed) }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  toggleOrbits: () => set((s) => ({ showOrbits: !s.showOrbits })),
  toggleTrails: () => set((s) => ({ showTrails: !s.showTrails })),
  select: (selectedId) => set({ selectedId }),
  setDays: (days) => set({ days }),
  requestReset: () => set((s) => ({ selectedId: null, resetToken: s.resetToken + 1 })),
  hydrate: (settings) =>
    set({
      speed: clampSpeed(settings.speed ?? 1),
      showLabels: settings.showLabels ?? true,
      showOrbits: settings.showOrbits ?? true,
      showTrails: settings.showTrails ?? true,
    }),
}));

export function loadSettings(): Settings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Settings;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function bindSettingsPersistence() {
  let prev = "";
  return useSim.subscribe((state) => {
    const next = JSON.stringify({
      v: 1,
      speed: state.speed,
      showLabels: state.showLabels,
      showOrbits: state.showOrbits,
      showTrails: state.showTrails,
    });
    if (next === prev) return;
    prev = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* ignore quota */
    }
  });
}
