// 贴图与探针体检：打印程序化贴图的实际像素预算 + __solarProbe() 的 NaN 哨兵情况。
//
// 用法:
//   node scripts/texture-report.mjs              # 沙盘（默认视图）
//   node scripts/texture-report.mjs "?proto=1"   # 实境原型（太阳在相机背后，用来验 NaN 哨兵）
//
// 用途：scripts/README.md 里那些「启动档 106,496 px」「聚焦后 794,624 px」「proto 3 条里 1 条 NaN」
// 都用这条命令复测，不接受口头数字。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// 和 verify.mjs 同一套覆盖：验冻结快照时用 XG_RELEASE 指过去
const RELEASE = process.env.XG_RELEASE ? path.resolve(process.env.XG_RELEASE) : path.join(root, "release");
const SITE = path.join(RELEASE, "site");
const EDGE =
  process.env.XG_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4199;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function startServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const body = await readFile(path.join(SITE, rel));
      res.writeHead(200, { "content-type": MIME[path.extname(rel)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

let server;
let port = PORT;
for (let i = 0; i < 20; i++) {
  try {
    server = await startServer(PORT + i);
    port = PORT + i;
    break;
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
  }
}
if (!server) throw new Error(`端口 ${PORT}–${PORT + 19} 都被占用`);

const query = process.argv[2] ?? "";
const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const tex = () => page.evaluate(() => window.__solarTextures?.() ?? null);
const fmt = (r) =>
  r
    ? `pending=${r.pending} total=${r.totalPixels} [${
        r.items
          .map((i) => `${i.id}:${i.width}x${i.height}`)
          .filter((s, i, a) => a.indexOf(s) === i) // 同尺寸的折叠显示
          .join(" ")}]`
    : "（无 __solarTextures 钩子）";

const probeStats = () =>
  page.evaluate(() => {
    const all = window.__solarProbe?.() ?? [];
    const nan = all.filter((b) => Number.isNaN(b.x)).map((b) => b.id);
    return { count: all.length, nanCount: nan.length, nanIds: nan };
  });

await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: "load" });
await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });

console.log(`目标: ${query || "（沙盘默认视图）"}`);
console.log("就绪瞬间  :", fmt(await tex()));
await page.waitForTimeout(4000);
console.log("稳态 4s 后:", fmt(await tex()));
console.log("探针      :", JSON.stringify(await probeStats()));

// 聚焦地球再量一次：预算「只升不降」，聚到近处会升档
const chip = await page.locator("#chip-earth").count();
if (chip) {
  await page.locator("#chip-earth").click();
  await page.waitForTimeout(2500);
  console.log("聚焦地球后:", fmt(await tex()));
  console.log("探针      :", JSON.stringify(await probeStats()));
}

console.log("页面报错  :", errors.length ? errors : "none");
await browser.close();
server.close();
