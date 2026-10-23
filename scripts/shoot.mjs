// 逐颗星聚焦拍照，用来肉眼检查贴图。
// 用法: npm run shoot            → 全部拍一遍
//       npm run shoot -- earth mars
// 靠 ?body= 深链选星，所以连卫星也能拍（卫星没有芯片按钮）。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SITE = path.join(root, "release", "site");
const SHOTS = path.join(root, "screenshots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4180;

const ALL = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "io", "europa", "saturn", "titan", "uranus", "neptune"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
// 星球会自转公转，等多久决定拍到的是白天面还是夜面；默认 1.8 秒，可用 SHOOT_WAIT 调
const WAIT = Number(process.env.SHOOT_WAIT ?? 1800);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(SITE, pathname === "/" ? "index.html" : pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  s.listen(PORT, "127.0.0.1", () => resolve(s));
});

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const page = await (
  await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

for (const id of wanted) {
  await page.goto(`http://127.0.0.1:${PORT}/?body=${id}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(WAIT); // 等镜头聚焦动画走完，同时等星球转到受光面
  // 裁掉 HUD，只留星球（桌面端卡片在右侧，裁剪区避开它）
  await page.screenshot({
    path: path.join(SHOTS, `body-${id}.png`),
    clip: { x: 330, y: 180, width: 520, height: 520 },
  });
  console.log(`  ${id} ✓`);
}

console.log(`\n拍了 ${wanted.length} 颗，页面报错 ${errors.length} 条`);
await browser.close();
server.close();
