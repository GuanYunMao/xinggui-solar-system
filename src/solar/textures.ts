import * as THREE from "three";
import type { Body } from "./data";

/**
 * 程序化贴图：全部在运行时用 canvas 逐像素生成，不依赖任何图片资源。
 *
 * 关键教训（v1.1.0 重写）：决定「像不像行星」的是噪声的周期数，不是分辨率。
 * 旧版在 u 方向铺了 GRID*3 = 192 个格子再叠 5 层倍频，512 宽的贴图上一格只有
 * 2~3 像素 —— 大陆做成了撒胡椒面，地球看着像一团乱麻。
 * 现在大陆尺度用 cycles=3（绕球一圈只有 3 个起伏），细节交给倍频去补。
 */

const cache = new Map<string, THREE.CanvasTexture>();

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sampler = (u: number, v: number, cycles: number, octaves?: number) => number;

const smoothT = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * 值噪声 + 分形叠加。
 *
 * 这里最容易搞错的一件事：`cycles` 是「绕球一圈有几个格子」，不是「格子总数」。
 * 旧版写的是 u * GRID * c，格点间距只有零点几像素，等于白噪声 —— 这就是贴图
 * 一团乱麻的真正原因。现在格点索引直接对周期取模，天然无缝环绕，
 * cycles=3 就是绕球一圈 3 个起伏，格点间距约 170 像素。
 */
function makeSampler(seed: number): Sampler {
  const hash = (ix: number, iy: number, salt: number) => {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(salt, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const wrap = (i: number, period: number) => ((i % period) + period) % period;

  return (u, v, cycles, octaves = 5) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let cells = Math.max(1, Math.round(cycles));
    let salt = seed;

    for (let o = 0; o < octaves; o++) {
      // v 只覆盖半个球面，纵向格数减半，避免特征被纵向拉长一倍
      const rows = Math.max(1, Math.round(cells / 2));
      const x = u * cells;
      const y = v * rows;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const tx = smoothT(x - x0);
      const ty = smoothT(y - y0);

      const h00 = hash(wrap(x0, cells), wrap(y0, rows), salt);
      const h10 = hash(wrap(x0 + 1, cells), wrap(y0, rows), salt);
      const h01 = hash(wrap(x0, cells), wrap(y0 + 1, rows), salt);
      const h11 = hash(wrap(x0 + 1, cells), wrap(y0 + 1, rows), salt);

      const top = h00 + (h10 - h00) * tx;
      const bottom = h01 + (h11 - h01) * tx;
      sum += amp * (top + (bottom - top) * ty);

      norm += amp;
      amp *= 0.5;
      cells *= 2;
      salt += 101;
    }
    return sum / norm;
  };
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function canvasTexture(w: number, h: number, paint: (data: Uint8ClampedArray, w: number, h: number) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const image = ctx.createImageData(w, h);
  paint(image.data, w, h);
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function setPx(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, a = 255) {
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = a;
}

// —— 陨石坑 ——
type Crater = { u: number; v: number; rad: number; depth: number };

function makeCraters(seed: number, count: number): Crater[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    u: rand(),
    v: 0.1 + rand() * 0.8,
    rad: 0.05 + rand() * 0.13,
    depth: 0.5 + rand() * 0.5,
  }));
}

/** 坑壁亮、坑内暗，边缘柔和 —— 硬边会让整颗星看起来像麻子。 */
function craterShade(craters: Crater[], u: number, v: number) {
  let delta = 0;
  for (const c of craters) {
    let du = Math.abs(u - c.u);
    if (du > 0.5) du = 1 - du;
    const dv = (v - c.v) * 0.5;
    const d = Math.hypot(du, dv);
    if (d > c.rad) continue;
    const t = d / c.rad;
    delta += t < 0.72 ? -16 * c.depth * (1 - t / 0.72) : 18 * c.depth * (1 - (t - 0.72) / 0.28);
  }
  return delta;
}

// —— 岩石 / 类地星球 ——
function paintRocky(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: {
    seed: number;
    base: [number, number, number];
    alt: [number, number, number];
    craters?: number;
    capSize?: number;
    capColor?: [number, number, number];
  },
) {
  const broad = makeSampler(opts.seed);
  const fine = makeSampler(opts.seed + 7);
  const hits = opts.craters ? makeCraters(opts.seed + 3, opts.craters) : [];

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = broad(u, v, 3); // 大尺度明暗分区
      const f = fine(u, v, 16, 4); // 细微颗粒
      const albedo = clamp01(n * 0.75 + 0.14 + (f - 0.5) * 0.2);

      let r = mix(opts.base[0], opts.alt[0], albedo);
      let g = mix(opts.base[1], opts.alt[1], albedo);
      let b = mix(opts.base[2], opts.alt[2], albedo);

      if (hits.length) {
        const delta = craterShade(hits, u, v);
        r += delta;
        g += delta;
        b += delta;
      }

      if (opts.capSize && opts.capColor) {
        const lat = Math.abs(v * 2 - 1);
        const edge = 1 - opts.capSize;
        const k = smoothstep(edge, edge + 0.06, lat);
        if (k > 0) {
          const cap = opts.capColor;
          r = mix(r, cap[0], k);
          g = mix(g, cap[1], k);
          b = mix(b, cap[2], k);
        }
      }

      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

function paintEarth(data: Uint8ClampedArray, w: number, h: number) {
  const land = makeSampler(11);
  const detail = makeSampler(29);

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const lat = Math.abs(v * 2 - 1); // 0 赤道 → 1 极点
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = land(u, v, 3); // 大陆轮廓（绕球 3 个起伏）
      const d = detail(u, v, 18, 4); // 细节
      const iceEdge = 0.845 - (d - 0.5) * 0.07;

      let r: number;
      let g: number;
      let b: number;

      if (lat > iceEdge) {
        // 极冠：略带蓝的白，边缘柔和
        const k = smoothstep(iceEdge, iceEdge + 0.07, lat);
        r = mix(230, 246, k) + (d - 0.5) * 8;
        g = mix(238, 250, k) + (d - 0.5) * 6;
        b = mix(244, 253, k);
      } else if (n > 0.56 + (d - 0.5) * 0.05) {
        // 陆地：热带深绿 → 中纬荒漠 → 高纬苔原
        const aridBand = 1 - Math.min(1, Math.abs(lat - 0.32) / 0.22);
        const arid = clamp01(aridBand * 0.6 + (d - 0.5) * 0.4);
        const green = [62, 108, 58];
        const forest = [36, 82, 50];
        const desert = [180, 152, 100];
        const tundra = [112, 112, 92];

        const cold = smoothstep(0.52, 0.78, lat);
        r = mix(mix(green[0]!, forest[0]!, d), desert[0]!, arid * (1 - cold));
        g = mix(mix(green[1]!, forest[1]!, d), desert[1]!, arid * (1 - cold));
        b = mix(mix(green[2]!, forest[2]!, d), desert[2]!, arid * (1 - cold));
        r = mix(r, tundra[0]!, cold);
        g = mix(g, tundra[1]!, cold);
        b = mix(b, tundra[2]!, cold);

        // 海岸细沙带
        if (n < 0.573) {
          const sand = smoothstep(0.573, 0.56, n) * 0.5;
          r = mix(r, 196, sand);
          g = mix(g, 178, sand);
          b = mix(b, 128, sand);
        }
      } else {
        // 海洋：近岸浅青 → 深海藏蓝
        const depth = clamp01((0.56 - n) / 0.2);
        r = mix(30, 10, depth) + (d - 0.5) * 10;
        g = mix(126, 46, depth) + (d - 0.5) * 14;
        b = mix(172, 106, depth) + (d - 0.5) * 16;
      }

      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

// —— 气态巨行星的条带 ——
function paintBands(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  colors: number[][],
  opts: {
    seed: number;
    freq: number;
    turbulence?: number;
    spot?: { u: number; v: number; rx: number; ry: number; color: number[] };
  },
) {
  const turb = makeSampler(opts.seed);
  const swirl = makeSampler(opts.seed + 5);
  const strength = opts.turbulence ?? 1;

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = turb(u, v, 3);
      const fine = swirl(u, v, 18, 3);
      // 条带被低频噪声推着走，形成大涡旋
      const shifted = v + (n - 0.5) * 0.05 * strength;
      const band = Math.sin(shifted * opts.freq + n * 1.6) * 0.5 + 0.5;

      const pos = band * (colors.length - 1);
      const i0 = Math.floor(pos);
      const t = pos - i0;
      const c0 = colors[Math.min(colors.length - 1, i0)]!;
      const c1 = colors[Math.min(colors.length - 1, i0 + 1)]!;
      let r = mix(c0[0]!, c1[0]!, t);
      let g = mix(c0[1]!, c1[1]!, t);
      let b = mix(c0[2]!, c1[2]!, t);

      const streak = (fine - 0.5) * 14 * strength;
      r += streak;
      g += streak;
      b += streak;

      if (opts.spot) {
        const du = (u - opts.spot.u) / opts.spot.rx;
        const dv = (v - opts.spot.v) / opts.spot.ry;
        const d2 = du * du + dv * dv;
        if (d2 < 1) {
          const k = smoothstep(1, 0.2, d2);
          r = mix(r, opts.spot.color[0]!, k);
          g = mix(g, opts.spot.color[1]!, k);
          b = mix(b, opts.spot.color[2]!, k);
        }
      }

      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

/** 木卫二那种冰壳裂缝：细而分岔的暗红纹路。 */
function paintIceCracks(data: Uint8ClampedArray, w: number, h: number, seed: number) {
  const warp = makeSampler(seed);
  const tint = [150, 106, 84];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const wu = warp(u, v, 4);
      const wv = warp(u + 0.37, v + 0.11, 4);
      const a = Math.abs(Math.sin((u * 9 + wu * 3.1) * Math.PI * 2));
      const b = Math.abs(Math.sin((v * 7 + wv * 2.7) * Math.PI * 2 + 1.7));
      const crack = Math.min(a, b);
      if (crack < 0.06) {
        const k = (1 - crack / 0.06) * 0.5;
        const i = (y * w + x) * 4;
        data[i] = mix(data[i]!, tint[0]!, k);
        data[i + 1] = mix(data[i + 1]!, tint[1]!, k);
        data[i + 2] = mix(data[i + 2]!, tint[2]!, k);
      }
    }
  }
}

function paintBody(body: Body, data: Uint8ClampedArray, w: number, h: number) {
  switch (body.texture) {
    case "mercury":
      paintRocky(data, w, h, { seed: 4, base: [104, 102, 98], alt: [186, 181, 172], craters: 40 });
      break;
    case "venus":
      paintBands(
        data,
        w,
        h,
        [
          [226, 196, 132],
          [204, 168, 104],
          [238, 214, 158],
          [214, 178, 112],
        ],
        { seed: 18, freq: 26, turbulence: 2.4 },
      );
      break;
    case "earth":
      paintEarth(data, w, h);
      break;
    case "mars":
      paintRocky(data, w, h, {
        seed: 21,
        base: [116, 56, 38],
        alt: [198, 118, 76],
        craters: 22,
        capSize: 0.14,
        capColor: [232, 226, 218],
      });
      break;
    case "jupiter":
      paintBands(
        data,
        w,
        h,
        [
          [226, 208, 184],
          [176, 130, 92],
          [238, 222, 200],
          [146, 100, 72],
          [206, 178, 146],
          [186, 148, 112],
        ],
        {
          seed: 6,
          freq: 46,
          turbulence: 1.6,
          spot: { u: 0.63, v: 0.63, rx: 0.085, ry: 0.05, color: [166, 72, 54] },
        },
      );
      break;
    case "saturn":
      paintBands(
        data,
        w,
        h,
        [
          [236, 216, 176],
          [214, 188, 142],
          [242, 226, 194],
          [200, 172, 128],
        ],
        { seed: 8, freq: 34, turbulence: 1.2 },
      );
      break;
    case "uranus":
      paintBands(
        data,
        w,
        h,
        [
          [166, 216, 212],
          [184, 228, 224],
          [152, 200, 198],
        ],
        { seed: 12, freq: 12, turbulence: 0.5 },
      );
      break;
    case "neptune":
      paintBands(
        data,
        w,
        h,
        [
          [40, 76, 176],
          [58, 104, 200],
          [30, 62, 152],
        ],
        {
          seed: 15,
          freq: 18,
          turbulence: 0.9,
          spot: { u: 0.4, v: 0.44, rx: 0.05, ry: 0.035, color: [20, 38, 96] },
        },
      );
      break;
    case "moon":
      paintRocky(data, w, h, { seed: 33, base: [92, 92, 90], alt: [196, 192, 184], craters: 46 });
      break;
    case "io":
      paintRocky(data, w, h, { seed: 41, base: [176, 120, 40], alt: [232, 206, 96], craters: 16 });
      break;
    case "europa":
      paintRocky(data, w, h, { seed: 52, base: [196, 196, 186], alt: [232, 235, 230], craters: 6 });
      paintIceCracks(data, w, h, 57);
      break;
    case "ganymede":
      paintRocky(data, w, h, { seed: 61, base: [96, 86, 74], alt: [176, 162, 140], craters: 24 });
      break;
    case "callisto":
      paintRocky(data, w, h, { seed: 70, base: [58, 54, 50], alt: [128, 120, 110], craters: 48 });
      break;
    case "titan":
      paintBands(
        data,
        w,
        h,
        [
          [212, 154, 74],
          [196, 132, 60],
          [226, 178, 100],
        ],
        { seed: 80, freq: 10, turbulence: 0.6 },
      );
      break;
    default:
      paintRocky(data, w, h, { seed: 1, base: [110, 110, 110], alt: [176, 176, 176] });
  }
}

export function textureFor(body: Body) {
  const hit = cache.get(body.id);
  if (hit) return hit;
  const large = body.radius > 0.4;
  const tex = canvasTexture(large ? 512 : 256, large ? 256 : 128, (data, w, h) => paintBody(body, data, w, h));
  cache.set(body.id, tex);
  return tex;
}

/** 云层：成团成带，而不是满屏噪点。 */
export function cloudTexture() {
  const hit = cache.get("clouds");
  if (hit) return hit;
  const sample = makeSampler(71);
  const band = makeSampler(83);
  const tex = canvasTexture(512, 256, (data, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1);
      const lat = Math.abs(v * 2 - 1);
      // 云带集中在中低纬，赤道和极地偏薄
      const belt = 1 - smoothstep(0.05, 0.32, Math.abs(lat - 0.28)) * 0.45;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = sample(u, v, 4) * 0.65 + band(u, v, 8, 4) * 0.35;
        const a = smoothstep(0.52, 0.72, n) * 235 * belt;
        setPx(data, (y * w + x) * 4, 240, 245, 250, a);
      }
    }
  });
  cache.set("clouds", tex);
  return tex;
}

export function glowTexture() {
  const hit = cache.get("glow");
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  g.addColorStop(0, "rgba(255, 236, 206, 0.95)");
  g.addColorStop(0.18, "rgba(255, 186, 90, 0.45)");
  g.addColorStop(0.42, "rgba(255, 140, 50, 0.12)");
  g.addColorStop(1, "rgba(255, 120, 40, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cache.set("glow", tex);
  return tex;
}
