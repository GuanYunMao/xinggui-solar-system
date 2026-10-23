import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 版本号只有 package.json 一个源，界面和 CI 都从它取
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// 纯静态前端：没有任何服务端、数据库或运行时注入。
// base: "./" 让构建产物可以从任意子目录（甚至本地文件夹）直接打开。
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
