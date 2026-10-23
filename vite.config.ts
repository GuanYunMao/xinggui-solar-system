import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 版本号只有 package.json 一个源，界面和 CI 都从它取
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// 品牌名只有这一处字面量。为什么不放 package.json：那里的 `name` 是技术标识
// （`xinggui`，npm/仓库/发布 asset 都靠它），拿它当显示名会把两件事绑死。
// 消费方（src/solar/brand.ts）从这两个常量读，HUD 里不该出现第二处硬编码。
//
// ⚠ 全名**不带空格**：用户给的写法、品牌图里都是 `巡星·未至之境`。
//   带 ` · ` 的那种写法只用于「发布名」里做分隔：`巡星 1.0.11 · 修复实境浮点`
//   —— 那是名字与版本/摘要之间的分隔符，不是名字本身的一部分。
const APP_NAME = "巡星·未至之境"; // 全名：一整个名字，非必要不拆、不加空格
const APP_SHORT_NAME = "巡星"; // 短名：单文件产物名、手机桌面标题、窄屏占位

// 纯静态前端：没有任何服务端、数据库或运行时注入。
// base: "./" 让构建产物可以从任意子目录（甚至本地文件夹）直接打开。
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_NAME__: JSON.stringify(APP_NAME),
    __APP_SHORT_NAME__: JSON.stringify(APP_SHORT_NAME),
  },
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), react()],
  server: { host: "0.0.0.0", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    target: "es2020",
    // 真实行星贴图（地球/月球，约 120KB）必须内联进 JS，
    // 否则单文件版本还要额外带 assets 目录，双击就不完整了。
    assetsInlineLimit: 4 * 1024 * 1024,
    // 单入口、单分块，方便打进一个 HTML 文件里。
    cssCodeSplit: false,
    rolldownOptions: {
      output: { codeSplitting: false },
    },
    chunkSizeWarningLimit: 2000,
  },
});
