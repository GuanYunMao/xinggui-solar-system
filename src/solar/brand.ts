/**
 * 品牌名与版本号的唯一出处（HUD 侧）。
 *
 * **「巡星·未至之境」是一整个名字，非必要不得拆开。**
 * 它只出现在启动页 / about / 品牌物料；HUD 顶部放不下（7 字 × text-3xl ≈ 210px，
 * 320 宽屏左栏只有 167px），所以 HUD 用「图标 + 代际名」占位。
 *
 * 规矩（1 代际内有效）：
 *  - HUD 顶部 = 图标 + 代际名（测绘 / 远征），不含全名。
 *  - 版本号只显示 X.Y.Z，`-snap.N` 是给开发者看的快照号，玩家不需要读。
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

/** HUD 角落的版本标签：`v1.0.8`（不带快照号）。 */
export function versionLabel(raw: string): string {
  return `v${shortVersion(raw)}`;
}
