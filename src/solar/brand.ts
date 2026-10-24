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
