// 把公有领域的行星贴图烘成合适尺寸，写进 src/solar/assets/。
// 用法: node scripts/bake-textures.mjs
//
// 资源来源：three.js 仓库 examples/textures/planets/（NASA Visible Earth / Blue Marble，
// 公有领域）。烘焙本身用无头 Edge 的 canvas 缩放，不引第三方图像库。
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(root, ".texture-src");
const OUT = path.join(root, "src", "solar", "assets");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const BASE = "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets";
const JOBS = [
  { src: `${BASE}/earth_atmos_2048.jpg`, out: "earth-day.jpg", width: 1024, height: 512, quality: 0.82 },
  { src: `${BASE}/moon_1024.jpg`, out: "moon.jpg", width: 512, height: 256, quality: 0.82 },
];

await mkdir(CACHE, { recursive: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage();

for (const job of JOBS) {
  const cached = path.join(CACHE, path.basename(job.src));
  if (!existsSync(cached)) {
    const res = await fetch(job.src);
    if (!res.ok) throw new Error(`${job.src} → HTTP ${res.status}`);
    await writeFile(cached, Buffer.from(await res.arrayBuffer()));
  }
  const dataUri = `data:image/jpeg;base64,${(await readFile(cached)).toString("base64")}`;

  const encoded = await page.evaluate(
    async ({ dataUri, width, height, quality }) => {
      const img = new Image();
      img.src = dataUri;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", quality);
    },
    { dataUri, width: job.width, height: job.height, quality: job.quality },
  );

  const jpeg = Buffer.from(encoded.split(",")[1] ?? "", "base64");
  await writeFile(path.join(OUT, job.out), jpeg);
  console.log(
    `[bake] ${job.out}  ${job.width}×${job.height}  ${(jpeg.length / 1024).toFixed(0)} KB  ` +
      `(源 ${((await readFile(cached)).length / 1024).toFixed(0)} KB)`,
  );
}

await browser.close();
