/**
 * 品牌名与版本号的唯一出处（HUD 侧）。
 *
 * **「巡星·未至之境」是一整个名字，非必要不得拆开。**
 * 它只出现在启动页 / about / 品牌物料；HUD 顶部放不下（7 字 × text-3xl ≈ 210px，
 * 320 宽屏左栏只有 167px），所以 HUD 用「图标 + 代际名」占位。
 *
 * 规矩（1 代际内有效）：
 *  - HUD 顶部 = 图标 + 代际名（测绘 / 远征），不含全名。
 *  - 版本号显示 X.Y.Z；**快照版的 `-snap.N` 必须一起显示**（t12 改）：用户要能自己确认
 *    「手机上装的是 snap.1 还是 snap.10」。旧的「玩家不需要读快照号」这条被推翻了——
 *    正式发版不出现快照号，所以它不会污染玩家；出现快照号的时候，恰恰是玩家最需要它的时候。
 *
 * TODO(verifier): vite.config.ts 的 `__APP_NAME__` / `__APP_SHORT_NAME__` 落地后，
 * 把这里的字面量换成消费常量——**只改这个文件**，HUD 里不要出现第二处硬编码。
 */

// 类型专用 import（Node 类型剥离后不产生运行时代码）：这个文件保持"运行时零 import"，
// `node .tmp-t55-compression-test.mjs` 才能直接 import 它做单测。
import type { Body } from "./data";

/** 全名：一整个名字，不拆。 */
export const APP_FULL_NAME = "巡星·未至之境";

/** HUD 顶部的代际名。2 代际换成「远征」。 */
export const APP_ERA_NAME = "测绘";

/** `1.0.8-snap.3` → `1.0.8`；认不出就原样返回，绝不抛。 */
export function shortVersion(raw: string): string {
  const match = /^(\d+\.\d+\.\d+)/.exec(raw ?? "");
  return match ? match[1]! : (raw ?? "");
}

/**
 * 快照号：`1.0.8-snap.3` → `snap.3`；正式版（没有 `-snap.N` 后缀）→ `null`。
 *
 * 只认**尾部**的 `-snap.N`：`1.0.8-snap.3` 是快照；`1.0.8-snap.3-beta` 这种没见过的写法
 * 宁可当正式版（不显示）也不猜——版本号是承诺，猜错比不显示更糟。
 * 认不出时返回 null 而不是抛：`versionLabel` 是界面上的一个角标，不该有能力弄崩 HUD。
 */
export function snapshotTag(raw: string): string | null {
  const match = /(?:^|[-+])snap\.(\d+)$/.exec((raw ?? "").trim());
  return match ? `snap.${match[1]}` : null;
}

/**
 * HUD 角落的版本标签。
 *
 *  - 正式版：`v1.0.8`
 *  - 快照版：`v1.0.8·snap.3`（含 `snap` 字样，`.3` 与 `.10` 一眼能分）
 *
 * 宽度预算（t5 实测，别超）：`v1.0.8·snap.10` 在 11px + 0.18em 字距下约 105px。
 * 桌面/390 的抬头余量够（390 锁态 113.4px、已校准 93.4px），**320 只有 23.4px**——
 * 所以窄屏不把它塞进抬头，改用 `snapshotTag` 放到底栏（见 Hud 的 Dock）。
 */
export function versionLabel(raw: string): string {
  const tag = snapshotTag(raw);
  return tag ? `v${shortVersion(raw)}·${tag}` : `v${shortVersion(raw)}`;
}

/**
 * 实境距离读数的单位换档（t22）：米 → m / km / 万 km。
 *
 * 放这里而不是塞进 Hud 的组件里：它是**纯函数**，Node 能直接 import 来测
 * （Hud.tsx 带 JSX，Node 进不去）。也别在组件里再写一份 —— 换档规则只该有一处。
 *
 * 口径：
 *  - `< 1000 m`      → 整数米（`637 m`）
 *  - `< 1e7 m`       → 公里；< 100 km 给 1 位小数，其余整数（`12.3 km` / `6371 km`）
 *  - `>= 1e7 m`      → 万公里；< 100 万 km 给 2 位，其余整数（`38.44 万 km`）
 *  - `null` / 非有限值 → `—`（**不是 0**：那是谎言，说明相机还没摆位）
 */
export function formatDistanceMeters(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return "—";
  const m = Math.max(0, meters);
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 1e7) {
    const km = m / 1000;
    return `${km < 100 ? km.toFixed(1) : Math.round(km)} km`;
  }
  const wan = m / 1e7;
  return `${wan < 100 ? wan.toFixed(2) : Math.round(wan)} 万 km`;
}

/* ────────────────────── 时间压缩标注（t55） ────────────────────── */

/**
 * 沙盘详情卡底部那行「时间压缩：公转 ×1.89 · 自转 ×18.1」的派生。
 *
 * 两条律、两把尺（t55 全表：`.tmp-t55/HANDOFF-designer.md`）：
 *  - **公转**：真实值从**卡片自己的「公转」字符串**取（88 地球日 / 365.25 日 / 11.9 年），
 *    所以标注与卡片永远同源，卡片改了它自动跟着变；
 *  - **自转**：锁定天体（`locked`）的自转由轨道角派生 ⇒ 倍数**恒等于**公转倍数；
 *    其余行星按 `2π/spin × 每天模拟日 ÷ |真实自转周期|`。
 *
 * **不存在统一压缩系数**（公转 0.04–37.8、自转 13–174，差两个量级），所以逐天体现算；
 * 写一个全局常数必错。取不到就给 null —— 宁可不标，也不标错数。
 *
 * 为什么时间尺度是**参数**而不是 import：brand.ts 必须保持"运行时零 import"，
 * Node 才能直接 import 它做单测（上面 formatDistanceMeters 的注释也写了这条）。
 * 两个常量仍只有一处定义（store.ts 的 DAYS_PER_YEAR / DAYS_PER_SIM_SECOND），
 * 调用点从那里取、原样传进来，不在这里再写一份 365.25。
 */
export type Compression = { orbit: number | null; spin: number | null };

/** 时间尺度：唯一出处是 store.ts，调用点传进来（别在这里写死）。 */
export type TimeScale = { daysPerSimSecond: number; daysPerYear: number };

/** 参考表：真实自转周期（天；正=顺行、负=逆行）。**照抄 t55 全表 1b，别自己换算。** */
const REAL_SPIN_DAYS: Record<string, number> = {
  sun: 25.38,
  mercury: 58.646,
  venus: -243.02,
  earth: 0.99727,
  mars: 1.02595,
  jupiter: 0.41354,
  saturn: 0.44401,
  uranus: -0.71833,
  neptune: 0.67125,
};

/** "88 地球日"→88；"365.25 日"→365.25；"11.9 年"→11.9×daysPerYear；解析失败 → null */
function parseCardDays(value: string | undefined, daysPerYear: number): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(地球日|日|年)\s*$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return match[2] === "年" ? n * daysPerYear : n;
}

/**
 * 两个倍数。六种边界全部退化到 `null`（**不显示 0 / Infinity / NaN**）：
 * 没有「公转」fact、卡片串解析失败、`period ≤ 0`、非锁定但 `spin === 0`、
 * 参考表里没有这颗天体、两者都取不到（整行不渲染）。
 */
export function deriveCompression(body: Body, scale: TimeScale): Compression {
  const periodOk = Number.isFinite(body.period) && body.period > 0;
  const cardDays = parseCardDays(
    body.facts.find((fact) => fact.label === "公转")?.value,
    scale.daysPerYear,
  );
  const orbit =
    periodOk && cardDays !== null ? (body.period * scale.daysPerSimSecond) / cardDays : null;

  let spin: number | null = null;
  if (body.locked) {
    spin = orbit;
  } else if (periodOk && body.spin !== 0) {
    const real = REAL_SPIN_DAYS[body.id];
    if (real !== undefined) {
      // 逆行（金星/天王星）：模型自转与真实自转同号，比值为正；取绝对值避免"负压缩"读成反向
      const modelDays = (Math.PI * 2 / body.spin) * scale.daysPerSimSecond;
      spin = Math.abs(modelDays / real);
    }
  }
  return { orbit, spin };
}

/** 倍数文案：<10 两位小数、≥10 一位（×1.89 / ×134.6 / ×0.04 / ×37.8） */
function formatMultiple(value: number): string {
  return `×${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
}

/** "公转 ×1.89 · 自转 ×18.1"；两段都取不到 → null */
export function formatCompression(c: Compression): string | null {
  const parts: string[] = [];
  if (c.orbit !== null) parts.push(`公转 ${formatMultiple(c.orbit)}`);
  if (c.spin !== null) parts.push(`自转 ${formatMultiple(c.spin)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** 卡片底部整行："时间压缩：公转 ×1.89 · 自转 ×18.1"；没有可标 → null（整行不渲染） */
export function compressionLine(body: Body, scale: TimeScale): string | null {
  const text = formatCompression(deriveCompression(body, scale));
  return text === null ? null : `时间压缩：${text}`;
}
