// 用真实浏览器验证一个单文件 HTML 是否真的能跑。
// 用法: npm run check -- <文件路径> [用于字节比对的参考文件]
//       npm run check              → 不传参数时默认验本地刚构建的那份 release/巡星.html
//                                    （以前不带参数只打印用法再退出 2，导致 `npm run check` 是空跑）
//
// 为什么要单独验下载回来的文件：本地构建和 CI 构建会因打包器平台差异
// 差几十字节（Tailwind 候选类扫描），所以"我本地验过了"不等于"你下载的那份能跑"。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEFAULT_TARGET = path.join(import.meta.dirname, "..", "release", "巡星.html");
const explicit = Boolean(process.argv[2]);
const target = process.argv[2] ?? DEFAULT_TARGET;
const ref = process.argv[3];
if (!explicit) {
  if (!existsSync(target)) {
    console.error(`找不到 ${target}，先跑 npm run build（或显式传文件：npm run check -- <文件>）`);
    process.exit(2);
  }
  console.log(`（未指定文件，默认验本地构建产物：${target}）`);
}

if (ref) {
  const [a, b] = await Promise.all([readFile(ref), readFile(target)]);
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const from = Math.max(0, i - 50);
  const clip = (buf) => buf.subarray(from, from + 120).toString("utf8").replace(/\s+/g, " ");
  console.log(`参考 ${a.length} 字节 / 目标 ${b.length} 字节，首个差异 offset=${i}`);
  console.log(`  参考: …${clip(a)}…`);
  console.log(`  目标: …${clip(b)}…\n`);
}

const errors = [];
const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`file:///${path.resolve(target).replace(/\\/g, "/")}`, {
  waitUntil: "load",
  timeout: 30000,
});
let ready = false;
try {
  await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
  ready = true;
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(import.meta.dirname, "..", "screenshots", "checked.png") });
} catch {
  /* 下方统一报告 */
}

console.log(`画布渲染=${ready}  控制台报错=${errors.length} 条`);
for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
await browser.close();
process.exit(ready && errors.length === 0 ? 0 : 1);
