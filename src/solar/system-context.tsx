/**
 * 系统上下文：把「唯一的太阳系」变成「当前这一个星系」。
 *
 * 这是 1.1.0 地基里最关键的一块——`SolarCanvas` 里所有 `BODIES` 直接 import
 * 都会在切星系那天变成硬编码。接完线之后，渲染层只认 context，不认模块常量。
 *
 * 用法：
 *   <SystemProvider value={REAL_PROTO}>  ...整个场景...  </SystemProvider>
 *   const { bodies, byId, byParent } = useSystem();
 *
 * 迁移顺序（每次只改一处、每处都能独立验证）：
 *   1. Simulation 的 BODIES 遍历
 *   2. Trails 的 BODIES.filter
 *   3. Probe 的 BODIES 遍历
 *   4. Scene 的 BODY_BY_ID.sun
 *   5. BodyNode 的 childrenOf(body.id)
 *   6. Hud 的 BODY_BY_ID / CHIP_BODIES / childrenOf
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { BODIES, type Body } from "./data";
import type { SystemSpec } from "./systems";

type SystemValue = {
  spec: SystemSpec;
  bodies: Body[];
  byId: Record<string, Body>;
  byParent: Map<string, Body[]>;
  /** 主芯片行用的天体：没有 parent 或 parent 是恒星 */
  chips: Body[];
};

const SOL_SYSTEM: SystemSpec = {
  id: "sol",
  name: "太阳系",
  unit: "worldUnit",
  bodies: BODIES,
};

function buildValue(spec: SystemSpec): SystemValue {
  const byId: Record<string, Body> = Object.fromEntries(spec.bodies.map((b) => [b.id, b]));
  const byParent = new Map<string, Body[]>();
  for (const b of spec.bodies) {
    if (!b.parent) continue;
    const list = byParent.get(b.parent) ?? [];
    list.push(b);
    byParent.set(b.parent, list);
  }
  const chips = spec.bodies.filter((b) => !b.parent || b.parent === "sun");
  return { spec, bodies: spec.bodies, byId, byParent, chips };
}

const SystemContext = createContext<SystemValue | null>(null);

export function SystemProvider({ value, children }: { value?: SystemSpec; children: ReactNode }) {
  const spec = value ?? SOL_SYSTEM;
  const built = useMemo(() => buildValue(spec), [spec]);
  return <SystemContext.Provider value={built}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemValue {
  const value = useContext(SystemContext);
  if (!value) throw new Error("useSystem 必须在 SystemProvider 内使用");
  return value;
}

/** 给还没有接线的旧代码兜底：拿不到 context 时回落到当前太阳系 */
export const DEFAULT_SYSTEM = SOL_SYSTEM;
