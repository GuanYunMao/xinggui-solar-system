// 从 public/favicon.svg 的几何尺寸生成 PWA / 主屏图标 PNG。
// 纯 Node 实现（zlib 编码 + 4×4 超采样抗锯齿），不依赖浏览器或图形库：
// 无头浏览器在受限环境里起不来，而图标只是几段圆和圆角矩形，手写光栅化更可靠。
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(root, "public");

// —— favicon.svg 里量出来的尺寸（viewBox 32×32）——
const VIEW = 32;
const BG = [0x07, 0x09, 0x0e];
const RING = [0xd5, 0xdb, 0xe3];
const DOT = [0xe8, 0xed, 0xf4];
const CORNER = 7;
const RING_C = [16, 17];
const RING_R = 8.5;
const RING_W = 0.85; // 线宽 1.7 的一半
const CORE_R = 1.35;
const MOON_C = [22.6, 11.2];
const MOON_R = 2.15;

function sdRoundRect(px, py, half, r) {
  const qx = Math.abs(px) - (half - r);
  const qy = Math.abs(py) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sample(x, y) {
  // 圆角矩形底：外部返回 null（透明）
  if (sdRoundRect(x - VIEW / 2, y - VIEW / 2, VIEW / 2, CORNER) > 0) return null;

  const dRing = Math.hypot(x - RING_C[0], y - RING_C[1]);
  if (Math.abs(dRing - RING_R) <= RING_W) return RING;
  if (dRing <= CORE_R) return DOT;
  if (Math.hypot(x - MOON_C[0], y - MOON_C[1]) <= MOON_R) return DOT;
  return BG;
}

function rasterize(size) {
  const SS = 4;
  const scale = size / VIEW;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / scale, (y + (sy + 0.5) / SS) / scale);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            hits++;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (hits === 0) continue; // 全透明
      // 预乘平均后再除以覆盖率，得到正确边缘色
      px[i] = Math.round(r / hits);
      px[i + 1] = Math.round(g / hits);
      px[i + 2] = Math.round(b / hits);
      px[i + 3] = Math.round((hits / n) * 255);
    }
  }
  return px;
}

// —— 最小 PNG 编码器（RGBA8）——
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const png = encodePng(size, rasterize(size));
  const out = path.join(PUBLIC, `icon-${size}.png`);
  await writeFile(out, png);
  console.log(`[icons] public/icon-${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
