import * as THREE from "three";
import type { Body } from "./data";

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

function makeFbm(seed: number) {
  const G = 64;
  const rand = mulberry32(seed);
  const grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (ix: number, iy: number) => {
    const x = ((ix % G) + G) % G;
    const y = ((iy % G) + G) % G;
    return grid[y * G + x] ?? 0;
  };
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const b = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return a * (1 - sy) + b * sy;
  };
  return (u: number, v: number, cycles: number) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let c = cycles;
    for (let o = 0; o < 5; o++) {
      sum += amp * sample(u * G * c, v * G * c);
      norm += amp;
      amp *= 0.5;
      c *= 2;
    }
    return sum / norm;
  };
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

function paintRocky(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  base: [number, number, number],
  alt: [number, number, number],
  seed: number,
  craters: number,
) {
  const fbm = makeFbm(seed);
  const rand = mulberry32(seed + 9);
  const hits = Array.from({ length: craters }, () => ({
    u: rand(),
    v: 0.12 + rand() * 0.76,
    rad: 0.012 + rand() * 0.04,
  }));
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = fbm(u, v, 3);
      let r = base[0] + (alt[0] - base[0]) * n;
      let g = base[1] + (alt[1] - base[1]) * n;
      let b = base[2] + (alt[2] - base[2]) * n;
      for (const hit of hits) {
        let du = Math.abs(u - hit.u);
        du = Math.min(du, 1 - du);
        const dv = (v - hit.v) * (h / w);
        const d = Math.hypot(du, dv);
        if (d < hit.rad) {
          const rim = d > hit.rad * 0.72 ? 28 : -22 * (1 - d / hit.rad);
          r += rim;
          g += rim;
          b += rim;
        }
      }
      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

function paintEarth(data: Uint8ClampedArray, w: number, h: number) {
  const land = makeFbm(11);
  const detail = makeFbm(29);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = land(u, v, 3);
      const d = detail(u, v, 5);
      const polar = Math.min(v, 1 - v);
      const ice = polar < 0.07 + d * 0.025;
      const shore = n > 0.5 && n < 0.535;
      let r: number;
      let g: number;
      let b: number;
      if (ice) {
        r = 214 + d * 24;
        g = 226 + d * 16;
        b = 232;
      } else if (n > 0.52) {
        const dry = d;
        r = shore ? 196 : 62 + dry * 110;
        g = shore ? 176 : 92 + (1 - dry) * 48;
        b = shore ? 110 : 46 + dry * 10;
      } else {
        r = 16 + n * 24;
        g = 58 + n * 46;
        b = 112 + n * 70;
      }
      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

function paintBands(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  colors: [number, number, number][],
  seed: number,
  freq: number,
  spot?: { u: number; v: number; rx: number; ry: number; color: [number, number, number] },
) {
  const fbm = makeFbm(seed);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = fbm(u, v, 2);
      const band = Math.sin(v * freq + n * 2.2) * 0.5 + 0.5;
      const idx = Math.min(colors.length - 1, Math.floor(band * colors.length));
      const next = Math.min(colors.length - 1, idx + 1);
      const t = band * colors.length - idx;
      const c0 = colors[idx] ?? colors[0]!;
      const c1 = colors[next] ?? c0;
      let r = c0[0] + (c1[0] - c0[0]) * t;
      let g = c0[1] + (c1[1] - c0[1]) * t;
      let b = c0[2] + (c1[2] - c0[2]) * t;
      if (spot) {
        const du = (u - spot.u) / spot.rx;
        const dv = (v - spot.v) / spot.ry;
        const d = du * du + dv * dv;
        if (d < 1) {
          const k = 1 - d;
          r = r * (1 - k) + spot.color[0] * k;
          g = g * (1 - k) + spot.color[1] * k;
          b = b * (1 - k) + spot.color[2] * k;
        }
      }
      setPx(data, (y * w + x) * 4, r, g, b);
    }
  }
}

function paintClouds(data: Uint8ClampedArray, w: number, h: number) {
  const fbm = makeFbm(71);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = fbm(u, v, 4);
      const a = n > 0.56 ? Math.min(255, (n - 0.56) * 700) : 0;
      setPx(data, (y * w + x) * 4, 236, 242, 248, a);
    }
  }
}

function paintBody(body: Body, data: Uint8ClampedArray, w: number, h: number) {
  switch (body.texture) {
    case "mercury":
      paintRocky(data, w, h, [138, 134, 128], [186, 180, 170], 4, 36);
      break;
    case "venus":
      paintBands(data, w, h, [
        [214, 186, 120],
        [232, 208, 150],
        [196, 164, 96],
        [226, 196, 132],
      ], 18, 18);
      break;
    case "earth":
      paintEarth(data, w, h);
      break;
    case "mars":
      paintRocky(data, w, h, [166, 78, 52], [120, 52, 36], 21, 18);
      for (let y = 0; y < h; y++) {
        const v = y / (h - 1);
        if (v < 0.08 || v > 0.92) {
          for (let x = 0; x < w; x++) setPx(data, (y * w + x) * 4, 228, 220, 210);
        }
      }
      break;
    case "jupiter":
      paintBands(
        data,
        w,
        h,
        [
          [214, 186, 150],
          [168, 124, 86],
          [226, 206, 176],
          [140, 98, 70],
          [206, 176, 140],
          [186, 150, 112],
        ],
        6,
        36,
        { u: 0.62, v: 0.62, rx: 0.09, ry: 0.055, color: [176, 78, 58] },
      );
      break;
    case "saturn":
      paintBands(data, w, h, [
        [230, 210, 170],
        [206, 184, 140],
        [236, 220, 186],
        [196, 170, 126],
      ], 8, 28);
      break;
    case "uranus":
      paintBands(data, w, h, [
        [168, 214, 208],
        [186, 226, 222],
        [150, 198, 196],
      ], 12, 10);
      break;
    case "neptune":
      paintBands(
        data,
        w,
        h,
        [
          [36, 70, 170],
          [52, 96, 196],
          [28, 58, 150],
          [70, 120, 210],
        ],
        15,
        16,
        { u: 0.35, v: 0.42, rx: 0.06, ry: 0.04, color: [20, 36, 90] },
      );
      break;
    case "moon":
      paintRocky(data, w, h, [168, 164, 156], [120, 118, 112], 33, 30);
      break;
    case "io":
      paintBands(data, w, h, [
        [230, 196, 70],
        [210, 120, 40],
        [240, 220, 140],
        [180, 70, 30],
      ], 41, 14);
      break;
    case "europa":
      paintRocky(data, w, h, [214, 220, 216], [170, 186, 190], 52, 4);
      break;
    case "ganymede":
      paintRocky(data, w, h, [150, 132, 112], [96, 86, 74], 61, 16);
      break;
    case "callisto":
      paintRocky(data, w, h, [92, 86, 78], [58, 54, 50], 70, 34);
      break;
    case "titan":
      paintBands(data, w, h, [
        [214, 156, 72],
        [196, 132, 58],
        [226, 176, 96],
      ], 80, 8);
      break;
    default:
      paintRocky(data, w, h, [140, 140, 140], [180, 180, 180], 1, 0);
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

export function cloudTexture() {
  const hit = cache.get("clouds");
  if (hit) return hit;
  const tex = canvasTexture(512, 256, (data, w, h) => paintClouds(data, w, h));
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
