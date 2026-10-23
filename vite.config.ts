import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 纯静态前端：没有任何服务端、数据库或运行时注入。
// base: "./" 让构建产物可以从任意子目录（甚至本地文件夹）直接打开。
export default defineConfig({
  base: "./",
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), react()],
  server: { host: "0.0.0.0", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    target: "es2020",
    // 单入口、单分块，方便打进一个 HTML 文件里。
    cssCodeSplit: false,
    rolldownOptions: {
      output: { codeSplitting: false },
    },
    chunkSizeWarningLimit: 2000,
  },
});
