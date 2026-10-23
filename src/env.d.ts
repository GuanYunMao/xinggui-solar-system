/// <reference types="vite/client" />

// 由 vite.config.ts 注入，值取自 package.json 的 version
declare const __APP_VERSION__: string;

// 由 vite.config.ts 注入。全名与短名的唯一字面量在 vite.config.ts，
// 消费方见 src/solar/brand.ts（HUD 里不要再写第二处）。
/** 全名：`巡星·未至之境`（**不带空格**，` · ` 只作发布名的分隔符），一整个名字，非必要不拆 */
declare const __APP_NAME__: string;
/** 短名：`巡星`，用于单文件产物名、手机桌面标题、窄屏占位 */
declare const __APP_SHORT_NAME__: string;
