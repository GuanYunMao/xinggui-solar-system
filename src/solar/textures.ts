import * as THREE from "three";
import type { Body } from "./data";
import earthDayUrl from "./assets/earth-day.jpg";
import moonUrl from "./assets/moon.jpg";

/**
 * 贴图来源分两类：
 *
 * 1. 真实摄影贴图（地球、月球）—— 程序化噪声再怎么调也不像真实星球，
 *    这两颗直接用 NASA Blue Marble / LRO 的公有领域影像，经 scripts/bake-textures.mjs
 *    烘到 1024×512 / 512×256 再压 JPEG。**这两张的尺寸不由本文件的预算管**。
 * 2. 程序化贴图（其余行星与云层）—— 运行时逐像素生成。
 *
 * ## 为什么是「按屏幕占幅定尺寸 + 分帧生成」
 *
 * 原来的写法是 `radius > 0.4 ? 512×256 : 256×128`，在 React 首次 render 里同步跑完，
 * 实测 12 张 + 云层 = 1,114,112 像素逐像素，主线程一次阻塞 380–500 ms（本机基线见
 * 任务报告）。而首屏（总览机位）里最大的木星只有约 19 px 半径 —— 那 1.1 MP 里
 * 绝大部分是给"用户此刻还看不见的放大视图"付的钱。
 *
 * 两刀，各切各的：
 *   A. **按占幅定尺寸**（textureBudget）：一张贴图该多大，取决于「这颗星最大能占
 *      多少设备像素」。档位是设备的属性，占幅是视距的属性，两者正交 —— 一颗能
 *      放大到占满屏的天体，在任何设备上都要那张大图，但**只有在它被放大时**才要。
 *      所以预算随相机每帧重算，只升不降。
 *   B. **分帧生成**（本文件下半部分）：真正的像素循环按 5 ms 一片排队跑，
 *      每片都在下一帧 rAF 里，首屏不再有一个 400 ms 的黑洞。
 *      代价是首帧到贴图就绪之间天体是纯色（占位色 = data.ts 的 swatch）。
 *      总览机位下木星直径 38 px、卫星不到 2 px，这段时间肉眼看不出来。
 *
 * 什么情况会推翻它：如果哪天相机允许把一颗卫星拉到占满屏（例如新增自由飞行），
 * 预算会自己升到 2048，那时该担心的不是首屏而是「放大瞬间重新生成」的可见弹跳；
 * 那时要补的是「升档前先用低档撑着 + 交叉淡入」，不是把预算写死。
 */

// ——— 贴图预算 ————————————————————————————————————————————————

/** 一张程序化贴图的最小宽度。再小连「这是颗有纹理的球」都保不住。 */
export const TEX_MIN_WIDTH = 128;
/** 上限。2048×1024 = 8 MB 显存，是「占满 1080p 屏」这一档的天花板。 */
export const TEX_MAX_WIDTH = 2048;

/**
 * 每个屏幕像素给多少纹素（赤道方向、半球的平均口径）。
 *
 * 推导：球面赤道半球（180° = π 弧度）横跨圆盘。圆盘半径 r_px 时，圆盘中心附近的
 * 屏幕像素/弧度 = r_px（x = r_px·sinθ，θ=0 处导数就是 r_px），所以半球对应的屏幕
 * 跨度 = π·r_px = π·D/2；贴图在赤道方向给半球 W/2 个纹素。于是
 *
 *     纹素/像素 = (W/2) ÷ (π·D/2) = W / (π·D)
 *
 * 1:1 锐利要求 W = π·D ≈ 3.14·D。本项目现役观感的口径是 **0.5**（W ≈ 1.57·D）：
 * 实测按 512 宽画的木星在聚焦档（D≈320 CSS px）已经不觉得糊，再上一档只是多烧
 * 首屏时间。这条是审美判断，不是物理，改它之前请用截图对，不要只对数字。
 */
const TEXELS_PER_SCREEN_PX = 0.5;

export type TextureSize = { width: number; height: number };

function pow2Nearest(x: number) {
  return 2 ** Math.round(Math.log2(Math.max(1, x)));
}

/**
 * 贴图预算：给定「这颗星在屏幕上最大能占多少**设备像素**（直径）」，
 * 返回该用的贴图尺寸（等距圆柱，宽:高 = 2:1，宽取 2 的幂）。
 *
 * 设备像素 = CSS 像素 × dpr：视网膜屏上同一颗球有更多物理像素要糊，纹理也跟着涨，
 * 否则 dpr 一高就是把「0.5 纹素/像素」偷偷降成 0.3。
 *
 * 取值表（0.5 纹素/像素口径）：
 *   D_device   ideal W=1.57D   取 2 的幂
 *        20         31            128（下限）
 *        80        126            128
 *       160        251            256
 *       320        503            512
 *       686       1077           1024
 *      1300       2041           2048（上限）
 *
 * `texCap` 是**设备档位**给的上限（quality.ts 的 Tier.texCap）：占幅决定「该多大」，
 * 档位只回答「这台机器最多给多大」。两者别混 —— 按档位一刀切会让好设备聚焦行星时也糊，
 * 而按占幅不限档又会让弱机在放大那一下重新生成一张用不上的大图。
 */
export function textureBudget(maxScreenPx: number, texCap: number = TEX_MAX_WIDTH): TextureSize {
  const safe = Number.isFinite(maxScreenPx) ? Math.max(0, maxScreenPx) : 0;
  const ideal = Math.PI * safe * TEXELS_PER_SCREEN_PX;
  const cap = Number.isFinite(texCap) ? Math.max(TEX_MIN_WIDTH, texCap) : TEX_MAX_WIDTH;
  const width = Math.min(cap, Math.max(TEX_MIN_WIDTH, pow2Nearest(ideal)));
  return { width, height: width / 2 };
}

// ——— 真实摄影贴图 ————————————————————————————————————————————

const fileCache = new Map<string, THREE.Texture>();

function loadFileTexture(url: string) {
  const hit = fileCache.get(url);
  if (hit) return hit;
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  fileCache.set(url, tex);
  return tex;
}

// ——— 噪声 ————————————————————————————————————————————————————

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

function setPx(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, a = 255) {
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = a;
}

// ——— 逐行画笔 ————————————————————————————————————————————————

/**
 * 一行一段的画笔：`(data, y0, y1)` 只画 [y0, y1) 这几行。
 *
 * 为什么是这个形状：分帧生成要能在任意行边界停下来、下一帧接着跑。噪声采样器、
 * 陨石坑表这类「一次性预计算」放在 makeXxx 里（每张图只跑一次），
 * 每行的像素公式与改造前逐字相同 —— 画面不变是硬要求，重构不许顺手调参。
 */
type RowPaint = (data: Uint8ClampedArray, y0: number, y1: number) => void;

/** 把两个画笔串起来（欧罗巴 = 岩石底 + 冰裂缝）。两段都只读写本行像素，可安全分帧。 */
function chain(a: RowPaint, b: RowPaint): RowPaint {
  return (data, y0, y1) => {
    a(data, y0, y1);
    b(data, y0, y1);
  };
}

// —— 陨石坑 ——
type Crater = { u: number; v: number; rad: number; depth: number };

function makeCraters(seed: number, count: number, radMin = 0.05, radSpan = 0.13): Crater[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    u: rand(),
    v: 0.1 + rand() * 0.8,
    rad: radMin + rand() * radSpan,
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
  w: number,
  h: number,
  opts: {
    seed: number;
    base: [number, number, number];
    alt: [number, number, number];
    craters?: number;
    capSize?: number;
    capColor?: [number, number, number];
    /**
     * 大尺度暗区强度（t43，火星专用）：火星近看最显眼的不是陨石坑，是
     * 大流沙暗区（Syrtis Major 那一片）。用 2 周期的低频噪声压暗，贴脸时有明暗分区。
     */
    maria?: number;
  },
): RowPaint {
  const broad = makeSampler(opts.seed);
  const fine = makeSampler(opts.seed + 7);
  const hits = opts.craters ? makeCraters(opts.seed + 3, opts.craters) : [];

  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 3); // 大尺度明暗分区
        const f = fine(u, v, 16, 4); // 细微颗粒
        let albedo = clamp01(n * 0.75 + 0.14 + (f - 0.5) * 0.2);

        // 大流沙暗区（t43）：只在火星这类传了 maria 的星球上生效
        if (opts.maria) {
          const mar = broad(u + 0.37, v * 1.0, 2);
          if (mar < 0.52) albedo = clamp01(albedo - (0.52 - mar) * opts.maria);
        }

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
          // 极冠边缘用噪声打碎（t43）：真实火星极冠不是一刀切的圆边
          const jitter = (fine(u, v, 40, 2) - 0.5) * 0.04;
          const edge = 1 - opts.capSize + jitter;
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
  };
}

/**
 * 程序化地球。**现在没有任何路径会走到它** —— 地球在 acquirePlanetTexture 里
 * 就换成摄影贴图返回了，这份画笔在整条链路上是孤儿（改造前同样是孤儿）。
 *
 * 留着的理由不是"以后可能有用"，是它是这个项目里**唯一一份"噪声画出来的地球"**：
 * 调贴图参数时拿它和 earth-day.jpg 并排看，能立刻判断"像不像行星"这件事是不是
 * 噪声周期数的问题。删了以后要对比就得回 git 里翻。
 * 哪天确认不需要这个参照物，就连 makeBodyPainter 的 earth 分支一起删，别只删一半。
 */
function paintEarth(w: number, h: number): RowPaint {
  const land = makeSampler(11);
  const detail = makeSampler(29);

  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
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
  };
}

// —— 水星（t9）：和月球「灰 + 暗海」必须一眼分开 ——

type RayCrater = { u: number; v: number; rad: number; rays: number; phase: number };

function makeRayCraters(seed: number, count: number): RayCrater[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    u: rand(),
    v: 0.16 + rand() * 0.68,
    rad: 0.018 + rand() * 0.026,
    rays: 10 + Math.floor(rand() * 9),
    phase: rand() * Math.PI * 2,
  }));
}

/**
 * 水星（t9）。
 *
 * 不能继续用 `paintRocky` 的默认色：水星和月球在缩略图里都是「灰色 + 坑」，
 * 而月球用的是真照片（有暗海、偏冷灰），程序化的水星只会像一颗"没拍好的月亮"。
 * 真实水星最容易一眼认出的两件事：整体偏暖的灰、以及少数大撞击坑拖出的**亮射纹**
 * （Hokusai 那种横跨半颗星的放射状亮条）。
 *
 * 坑的半径比 `paintRocky` 小得多（0.012–0.062）：0.18 半径的软边坑贴脸看就是一圈
 * 半透明气泡（旧版实测如此），水星要的是"麻点 + 少量大坑"。
 * 射纹从 6 个坑放射，3.2 倍坑径内衰减；太亮/太长会变成"星芒"，所以强度只给 34。
 */
function paintMercury(w: number, h: number): RowPaint {
  const broad = makeSampler(104);
  const fine = makeSampler(111);
  const rays = makeRayCraters(117, 4);
  const hits = makeCraters(121, 150, 0.006, 0.022);

  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 3);
        const f = fine(u, v, 22, 4);
        let albedo = clamp01(n * 0.7 + 0.18 + (f - 0.5) * 0.22);
        // 大尺度反照率分区：水星对比比月球温和，压暗只做 0.55 的强度
        const low = broad(u + 0.41, v, 2);
        if (low < 0.48) albedo = clamp01(albedo - (0.48 - low) * 0.55);

        let r = mix(90, 200, albedo);
        let g = mix(84, 190, albedo);
        let b = mix(74, 170, albedo);

        const delta = craterShade(hits, u, v);
        r += delta;
        g += delta;
        b += delta;

        for (const rc of rays) {
          let du = u - rc.u;
          if (du > 0.5) du -= 1;
          else if (du < -0.5) du += 1;
          // v 覆盖 180°、u 覆盖 360°：乘 2 才是球面上的等距
          const dv = (v - rc.v) * 2;
          const dist = Math.hypot(du, dv);
          const outer = rc.rad * 2.4;
          if (dist > outer) continue;
          const ang = Math.atan2(dv, du);
          const streak = Math.pow(
            0.5 + 0.5 * Math.sin(ang * rc.rays + rc.phase + (f - 0.5) * 1.6),
            12,
          );
          const fade = smoothstep(outer, rc.rad * 0.9, dist);
          const k = streak * fade * 26;
          r += k;
          g += k * 0.98;
          b += k * 0.92;
          // 坑缘亮环：射纹的"源头"要亮，否则看着像凭空刷上去的条纹
          const halo = (1 - smoothstep(rc.rad * 0.9, rc.rad * 1.5, dist)) * 6;
          r += halo;
          g += halo * 0.98;
          b += halo * 0.92;
        }

        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

// —— 气态巨行星的条带 ——
function paintBands(
  w: number,
  h: number,
  colors: number[][],
  opts: {
    seed: number;
    freq: number;
    turbulence?: number;
    spot?: { u: number; v: number; rx: number; ry: number; color: number[] };
  },
): RowPaint {
  const turb = makeSampler(opts.seed);
  const swirl = makeSampler(opts.seed + 5);
  const strength = opts.turbulence ?? 1;

  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
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
  };
}

// —— 气态巨行星的细节版画笔（t43） ——

/**
 * 大红斑这类斑点：外圈色 → 内核色 → 内部纬向条纹，边界被噪声扰动。
 * 旧版是一个平涂椭圆 + smoothstep 边，贴脸看就是"一坨"。
 */
type GasGiantSpot = {
  u: number;
  v: number;
  rx: number;
  ry: number;
  /** 外圈（边缘）颜色 */
  rim: [number, number, number];
  /** 内核颜色 */
  core: [number, number, number];
  /** 边界扰动强度（0 = 光滑椭圆，0.5 左右像真的涡旋） */
  warp: number;
};

/**
 * 木星/土星专用的细节版画笔。
 *
 * 为什么不让 `paintBands` 改通用：金星/天王/海王/土卫六在总览档只需要"带子就够了"，
 * 换画笔会连带改掉它们的观感（t43 只要三颗）。木星/土星的问题也不是"带子不够"，
 * 是点选后相机会飞到贴脸，那里能看出三件事：
 *   1. 条带是纯正弦：等宽、边界柔、没有纬向剪切；
 *   2. 细节只有 3 octave 低频噪声：近看是一片平滑过渡，没有纤维；
 *   3. 大红斑是一个平涂椭圆：一坨。
 * 所以这个画笔把「结构」和「细节」拆开：
 *   - 结构：两组频率的条带叠加（主带 7~11 条 + 细带 33~44 条），并用低频噪声做纬向整体位移；
 *   - 细节：噪声在**经向**拉长（u 乘 8 再采样 = 8 倍 x 频率、y 不变）= 沿纬向铺开的云带纤维；
 *     u 乘整数倍不破坏环绕接缝（周期仍是整数格）。
 *   - 斑点：三层叠加 + 边界噪声 + 内部纬向条纹。
 *
 * 成本：每像素 4 次噪声（比旧版多约一倍）。贴图是分帧生成的（pump 每帧 6ms），
 * 变慢只体现在"聚焦升档多花几帧"，不占首屏 —— 实测见 t43 交付。
 */
function paintGasGiant(
  w: number,
  h: number,
  cfg: {
    seed: number;
    /** 纬向色带：主带在两组色之间往返 */
    belts: [number, number, number][];
    /** 主带：绕球一圈几条起伏 */
    bandFreq: number;
    /** 细带：叠在主带上的二级结构 */
    fineBandFreq: number;
    /** 纬向整体位移强度（大涡旋） */
    shear: number;
    /** 纤维细节强度 */
    filaments: number;
    /**
     * 条带相位的低频扰动（t9）：旧值 0.3，木星要压到 0.12 —— 0.3 会让整条色带
     * 上下扭成"大理石纹"，而真实木星的带子几乎笔直，只在带边界有细碎湍流。
     * 不传就保持旧值（土星先用 0.3）。
     */
    phaseNoise?: number;
    spots?: GasGiantSpot[];
  },
): RowPaint {
  const eddy = makeSampler(cfg.seed);
  const mid = makeSampler(cfg.seed + 11);
  const fiber = makeSampler(cfg.seed + 23);
  const grain = makeSampler(cfg.seed + 31);

  return (data, y0, y1) => {
    const n = cfg.belts.length;
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const e = eddy(u, v, 4); // 大涡旋
        const m = mid(u, v, 14); // 中尺度扰动
        const f = fiber(u * 8, v, 26, 3); // 纬向纤维
        const g2 = grain(u * 3, v, 60, 2); // 高频细纹

        // 1) 结构：两组条带 + 纬向整体位移
        //    位移只取低频（e/m），高频噪声留在"细节"里 —— 让色带边界保持连贯，
        //    否则贴脸看是一锅乱麻（t43 第一版就是 0.18 的位移 + 大颗粒，调回 0.07/小颗粒）
        const warp = (e - 0.5) * 0.13 * cfg.shear;
        const pn = cfg.phaseNoise ?? 0.3;
        // 相位扰动用**很低**的频率（m 只占 pn）：木星的色带大体是笔直的，
        // 只在带边缘有起伏；0.9~1.3 会把它画成大理石纹（t43 前两版就是）
        const bandMain = Math.sin((v + warp) * cfg.bandFreq * Math.PI * 2 + m * pn) * 0.5 + 0.5;
        const bandFine = Math.sin((v + warp * 1.7) * cfg.fineBandFreq * Math.PI * 2 + m * pn * 0.73) * 0.5 + 0.5;
        const banded = bandMain * 0.74 + bandFine * 0.26;

        // 2) 细节：纤维只轻微扰动色带位置，主要作用是带内暗丝
        const fib = (f - 0.5) * cfg.filaments;
        const pos = clamp01(banded + fib * 0.04) * (n - 1);
        const i0 = Math.floor(pos);
        const t = pos - i0;
        const c0 = cfg.belts[Math.min(n - 1, i0)]!;
        const c1 = cfg.belts[Math.min(n - 1, i0 + 1)]!;
        let r = mix(c0[0], c1[0], t);
        let g = mix(c0[1], c1[1], t);
        let b = mix(c0[2], c1[2], t);

        // 中尺度亮暗 + 高频细纹：贴脸时能看出"云在流"，退到总览又自然糊掉
        const tex = (m - 0.5) * 6 + (g2 - 0.5) * 3.5 * cfg.filaments;
        r += tex;
        g += tex * 0.97;
        b += tex * 0.92;

        // 3) 斑点：淡色领圈 → 橙红边缘 → 暗内核 + 边界噪声 + 内部纬向条纹（t9 三件）
        if (cfg.spots) {
          for (const sp of cfg.spots) {
            const du = (u - sp.u) / sp.rx + (m - 0.5) * sp.warp;
            const dv = (v - sp.v) / sp.ry + (e - 0.5) * sp.warp;
            const d = Math.hypot(du, dv);
            if (d >= 1.55) continue;
            /*
             * 淡色领圈（t9 引入，t37 收尾）：真实大红斑外围有一圈比色带更亮的浅色边，
             * 它是"有形的斑"和"一坨渐变"在低分辨率下最可分的那一条。
             *
             * t37 实测：旧写法 `mix(r, 238, collar * 0.5)` 只混 50%，领圈渲染出来
             * R176/G116/B89，比旁边的亮带 R204/G177/B148 还暗 —— "淡"读不出来。
             * **只改一个变量**：混合系数 0.5 → 1.0（颜色不动），领圈变成实心的浅奶油环。
             */
            const collar = smoothstep(1.55, 1.08, d) * (1 - smoothstep(1.1, 0.9, d));
            if (collar > 0.002) {
              r = mix(r, 238, collar);
              g = mix(g, 224, collar);
              b = mix(b, 198, collar);
            }
            // 边界收紧（旧 1.12/0.72）：闭口更清楚，低分辨率下不糊成一圈光
            const rim = smoothstep(1.04, 0.86, d);
            // 内核阈值 0.24 → 0.42（任务书指定的第二步）：暗核从"一个点"扩成"一小片"
            const core = smoothstep(0.78, 0.42, d);
            const edge = (g2 - 0.5) * 16 * core;
            r = mix(r, sp.rim[0] + edge, rim * 0.7);
            g = mix(g, sp.rim[1] + edge * 0.8, rim * 0.7);
            b = mix(b, sp.rim[2] + edge * 0.7, rim * 0.7);
            r = mix(r, sp.core[0], core);
            g = mix(g, sp.core[1], core);
            b = mix(b, sp.core[2], core);
            // 斑内的纬向条纹：大红斑不是一块平涂
            const stripe = Math.sin((v - sp.v) * 140 + g2 * 6) * 8 * core;
            r += stripe;
            g += stripe * 0.7;
            b += stripe * 0.6;
          }
        }

        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/**
 * 海王星（t9）。
 *
 * 旧版是三色平带 + 一个 0.05×0.035 的平涂椭圆暗斑：和天王星（浅青、几乎无特征）
 * 在缩略图里就是"两颗蓝色的球"。要给一眼能认出的三件：
 *   1. 深蓝底 + 赤道略亮的纬向层次（极区更暗）；
 *   2. 纬向暗带（现在这一代海王星最稳定的结构，不是一个大暗斑）；
 *   3. 几条东西向拉长的白色甲烷卷云 + 中纬度零星的**小暗斑**。
 *
 * ⚠ 不画 1989 年旅行者 2 号那个"大暗斑"（Great Dark Spot）：到 1994 年哈勃就找不到了，
 * 它是历史特征，不是现在这颗海王星的样子。这里的小暗斑是"近年观测确实有、但不持久"的
 * 那种（2023 年韦布还在南半球拍到过）。用户这一轮要的是**真实场景**，别画已经不存在的特征。
 *
 * 卷云用「u 低频 × v 高频」的噪声切，保证是横条而不是雪花；u 乘整数倍，接缝仍然连续。
 */
function paintNeptune(w: number, h: number): RowPaint {
  const band = makeSampler(131);
  const cloud = makeSampler(137);

  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      const lat = v * 2 - 1;
      const eq = 1 - Math.min(1, Math.abs(lat));
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = band(u, v, 3);
        const b = 0.5 + 0.5 * Math.sin((v + (n - 0.5) * 0.02) * Math.PI * 2 * 8.5 + n * 0.8);

        // 深蓝 → 天蓝：赤道亮、极区暗，再叠 ±0.35 的纬向带纹
        let r = mix(20, 66, eq * 0.55 + b * 0.35);
        let g = mix(38, 116, eq * 0.55 + b * 0.35);
        let bl = mix(112, 220, eq * 0.55 + b * 0.35);

        // 白色甲烷卷云：横向拉长（u 2 周期 × v 14 层），只在中低纬出现
        const streak = cloud(u * 2, v * 14, 5, 3);
        const latMask =
          smoothstep(0.1, 0.32, Math.abs(lat)) * (1 - smoothstep(0.82, 0.95, Math.abs(lat)));
        const white = smoothstep(0.6, 0.76, streak) * latMask * 0.8;
        r = mix(r, 214, white);
        g = mix(g, 232, white);
        bl = mix(bl, 255, white);

        /*
         * 零星星暗斑（不是 1989 年那个大暗斑）：三个小椭圆，位置照近年观测的分布
         * （南半球中纬 + 一条北半球中纬）。每个由低频噪声给一点边界扰动，别画成几何椭圆。
         */
        for (const sp of NEPTUNE_SPOTS) {
          const du = (u - sp.u) / sp.rx + (n - 0.5) * 0.25;
          const dv = (v - sp.v) / sp.ry + (b - 0.5) * 0.25;
          const d = Math.hypot(du, dv);
          if (d > 1.2) continue;
          const rim = smoothstep(1.15, 0.95, d);
          const core = smoothstep(0.9, 0.4, d);
          r = mix(r, 34, rim * 0.55);
          g = mix(g, 62, rim * 0.55);
          bl = mix(bl, 160, rim * 0.55);
          r = mix(r, 14, core * 0.8);
          g = mix(g, 28, core * 0.8);
          bl = mix(bl, 88, core * 0.8);
          // 暗斑旁边常常挂一条亮云（真实海王星最容易被认出的细节）
          const cu = (u - (sp.u + 0.018)) / (sp.rx * 1.6);
          const cv = (v - (sp.v + sp.ry * 1.35)) / (sp.ry * 0.45);
          const comp = smoothstep(1, 0.45, Math.hypot(cu, cv)) * 0.85;
          r = mix(r, 226, comp);
          g = mix(g, 240, comp);
          bl = mix(bl, 255, comp);
        }

        setPx(data, (y * w + x) * 4, r, g, bl);
      }
    }
  };
}

/** 海王星的小暗斑（u, v, 半宽, 半高）。不是大暗斑；见 paintNeptune 的注释。 */
const NEPTUNE_SPOTS = [
  { u: 0.38, v: 0.63, rx: 0.028, ry: 0.016 },
  { u: 0.69, v: 0.4, rx: 0.022, ry: 0.012 },
  { u: 0.14, v: 0.34, rx: 0.018, ry: 0.01 },
];

/** 木卫二那种冰壳裂缝：细而分岔的暗红纹路。 */function paintIceCracks(w: number, h: number, seed: number): RowPaint {
  const warp = makeSampler(seed);
  const tint = [150, 106, 84];
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
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
  };
}

// —— 五颗卫星（t9）：判据是「聚焦档能指出两个特征」——

/**
 * 木卫一（t9）：硫黄斑杂色 + 火山暗点。
 * Io 几乎没有撞击坑（旧版用 paintRocky 16 个坑是错的），表面是硫与二氧化硫霜：
 * 黄橙底 + 大块白霜 + 橙褐斑，再点 7 个近黑的火山口（Pele、Loki 那种）。
 */
function paintIo(w: number, h: number): RowPaint {
  const broad = makeSampler(151);
  const fine = makeSampler(157);
  const rand = mulberry32(163);
  const volcanoes = Array.from({ length: 7 }, () => ({
    u: rand(),
    v: 0.18 + rand() * 0.64,
    r: 0.012 + rand() * 0.02,
  }));
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 3);
        const m = broad(u + 0.37, v + 0.11, 6);
        const f = fine(u, v, 24, 4);
        // 硫黄：黄 → 橙 → 橙褐；白霜用 m 的高值区切
        let r = mix(196, 244, n * 0.8 + f * 0.2);
        let g = mix(128, 210, n * 0.7 + f * 0.3);
        let b = mix(34, 96, n * 0.6 + f * 0.4);
        const frost = smoothstep(0.62, 0.78, m + (f - 0.5) * 0.2) * 0.85;
        r = mix(r, 238, frost);
        g = mix(g, 240, frost);
        b = mix(b, 226, frost);
        const brown = smoothstep(0.7, 0.9, m);
        r = mix(r, 168, brown * 0.5);
        g = mix(g, 96, brown * 0.5);
        b = mix(b, 46, brown * 0.5);
        for (const vo of volcanoes) {
          let du = u - vo.u;
          if (du > 0.5) du -= 1;
          else if (du < -0.5) du += 1;
          const dv = (v - vo.v) * 2;
          const d = Math.hypot(du, dv) / vo.r;
          if (d > 1.6) continue;
          const core = smoothstep(1.2, 0.5, d);
          const halo = smoothstep(1.6, 0.9, d) * 0.3;
          r = mix(r, 58, core);
          g = mix(g, 34, core);
          b = mix(b, 24, core);
          r = mix(r, 120, halo);
          g = mix(g, 70, halo);
          b = mix(b, 34, halo);
        }
        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/** 木卫二（t9）：冰壳裂纹 + 少坑（和木卫三分开的关键）。 */
function paintEuropa(w: number, h: number): RowPaint {
  const broad = makeSampler(167);
  const warp = makeSampler(173);
  const hits = makeCraters(179, 5, 0.015, 0.03);
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 3);
        const f = broad(u + 0.29, v + 0.13, 16);
        // 冰壳：近白微蓝，只有很轻的明暗
        let r = mix(204, 242, n * 0.7 + f * 0.3);
        let g = mix(212, 246, n * 0.7 + f * 0.3);
        let b = mix(220, 250, n * 0.7 + f * 0.3);
        const delta = craterShade(hits, u, v);
        r += delta;
        g += delta;
        b += delta;
        // 两套线纹：长、细、红褐；用 u/v 两个方向的 sin(n+noise) 取零交叉
        const wu = warp(u, v, 4);
        const wv = warp(u + 0.37, v + 0.11, 4);
        const a = Math.abs(Math.sin((u * 7 + wu * 4.2) * Math.PI * 2));
        const bb = Math.abs(Math.sin((v * 5 + wv * 3.6) * Math.PI * 2 + 1.1));
        const c = Math.abs(Math.sin((u * 11 - v * 6 + wu * 5.0) * Math.PI * 2));
        const crack = Math.min(a, bb, c);
        if (crack < 0.05) {
          const k = (1 - crack / 0.05) * 0.55;
          r = mix(r, 150, k);
          g = mix(g, 112, k);
          b = mix(b, 92, k);
        }
        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/** 木卫三（t9）：大小斑 + 沟槽（暗的古老地体 + 亮的沟槽地体）。 */
function paintGanymede(w: number, h: number): RowPaint {
  const broad = makeSampler(181);
  const groove = makeSampler(187);
  const hits = makeCraters(193, 46, 0.008, 0.03);
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 2);
        const f = broad(u + 0.41, v + 0.17, 12);
        // 大小斑：暗地体 (88,80,70) / 亮地体 (168,156,136)；交界比旧版更利
        const bright = smoothstep(0.49, 0.55, n + (f - 0.5) * 0.1);
        let r = mix(88, 168, bright);
        let g = mix(80, 156, bright);
        let b = mix(70, 136, bright);
        // 一块大的暗椭圆（Galileo Regio 那种），让"大小斑"在聚焦档一眼看得见
        {
          const du = (u - 0.28) / 0.2;
          const dv = (v - 0.42) / 0.12;
          const k = smoothstep(1.05, 0.5, Math.hypot(du, dv));
          r = mix(r, 74, k * 0.85);
          g = mix(g, 66, k * 0.85);
          b = mix(b, 58, k * 0.85);
        }
        // 沟槽：只在亮地体上出现，细密的平行暗纹
        const gw = groove(u, v, 6);
        const grooves = Math.pow(0.5 + 0.5 * Math.sin((u * 18 + v * 2 + gw * 1.4) * Math.PI * 2), 4);
        const gk = grooves * bright * 0.5;
        r -= gk * 40;
        g -= gk * 38;
        b -= gk * 34;
        const delta = craterShade(hits, u, v);
        r += delta;
        g += delta;
        b += delta;
        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/** 木卫四（t9）：密集亮坑 + 深色平原。 */
function paintCallisto(w: number, h: number): RowPaint {
  const broad = makeSampler(197);
  const hits = makeCraters(199, 120, 0.012, 0.05);
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = broad(u, v, 3);
        const f = broad(u + 0.33, v + 0.19, 18);
        // 深色平原：比旧版更暗，让亮坑跳出来
        let r = mix(52, 96, n * 0.7 + f * 0.3);
        let g = mix(48, 90, n * 0.7 + f * 0.3);
        let b = mix(44, 82, n * 0.7 + f * 0.3);
        const delta = craterShade(hits, u, v);
        r += delta;
        g += delta;
        b += delta;
        // 亮坑：坑心一个亮斑（Callisto 的坑大多是"亮碗"），外圈再压一圈淡淡的亮环
        for (const c of hits) {
          let du = u - c.u;
          if (du > 0.5) du -= 1;
          else if (du < -0.5) du += 1;
          const dv = (v - c.v) * 0.5;
          const d = Math.hypot(du, dv) / c.rad;
          if (d > 1.8) continue;
          const k = smoothstep(1, 0.35, d) * 0.6 * c.depth;
          r = mix(r, 212, k);
          g = mix(g, 202, k);
          b = mix(b, 186, k);
          const halo = (1 - smoothstep(c.rad * 1.0, c.rad * 1.8, Math.hypot(du, dv))) * 0.16;
          r = mix(r, 160, halo);
          g = mix(g, 152, halo);
          b = mix(b, 138, halo);
        }
        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/** 土卫六（t9）：橙色雾霾 + 暗色湖；没有地形细节（别画大陆）。 */
function paintTitan(w: number, h: number): RowPaint {
  const haze = makeSampler(211);
  const lakes = makeSampler(217);
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = y / (h - 1);
      const lat = v * 2 - 1;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const n = haze(u, v, 3);
        // 橙色雾霾：赤道略亮、极区略暗，只有极低幅度的带纹
        const eq = 1 - Math.min(1, Math.abs(lat));
        let r = mix(196, 238, eq * 0.55 + n * 0.3);
        let g = mix(126, 180, eq * 0.55 + n * 0.3);
        let b = mix(52, 92, eq * 0.55 + n * 0.3);
        // 暗色湖：只在北半球高纬（真实土卫六的湖泊集中在北极附近）
        const d = lakes(u * 3, v * 5, 4);
        const lake = smoothstep(0.66, 0.74, d) * smoothstep(0.55, 0.78, Math.abs(lat)) * 0.7;
        r = mix(r, 70, lake);
        g = mix(g, 52, lake);
        b = mix(b, 34, lake);
        setPx(data, (y * w + x) * 4, r, g, b);
      }
    }
  };
}

/** 按天体挑画笔。尺寸是参数：同一颗星在不同占幅下用同一套公式、不同分辨率。 */
function makeBodyPainter(body: Body, w: number, h: number): RowPaint {
  switch (body.texture) {
    case "mercury":
      // t9：暖灰 + 亮射纹 + 细麻点坑。和月球（摄影贴图：冷灰 + 暗海）必须一眼分开
      return paintMercury(w, h);
    case "venus":
      return paintBands(
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
    case "earth":
      return paintEarth(w, h);
    case "mars":
      // t43：加了大流沙暗区与打碎的极冠边缘（原来是一片均匀锈红 + 几个坑）
      return paintRocky(w, h, {
        seed: 21,
        base: [112, 52, 34],
        alt: [202, 122, 78],
        craters: 30,
        maria: 0.55,
        capSize: 0.14,
        capColor: [232, 226, 218],
      });
    case "jupiter":
      // t43：换细节版画笔（条带剪切 + 纬向纤维 + 三层大红斑）
      // t9：色带太"浪"（shear 1.6→0.35、phaseNoise 0.3→0.12、filaments 0.55→0.4）；
      //     八色按 NASA/ESA Hubble 参考图取色（离线取色，图不进产物）。
      return paintGasGiant(w, h, {
        seed: 6,
        /*
         * 八色取自 NASA/ESA 的 Hubble 木星影像（公有领域，仅离线取色，不进产物）：
         *   EZ 亮区 (450,430)-(600,460) → R214 G208 B189；白区 (500,460) → 243/237/223
         *   NEB 暗带 (500,380) → 171/122/92；SEB 中褐 (500,540) → 190/167/136
         *   奶油带 (500,340) → 243/243/251；南极灰褐 (500,780) → 144/137/129
         * 取色方法：940×940 原图按 (x,y) 8×8 块取均值；坐标与值见 t9 报告。
         * 与原八色相比：白更白（232→246）、褐更沉（170→150），中间两档保住，
         * 免得整盘又糊成一条褐。
         */
        belts: [
          [246, 242, 228],
          [150, 100, 72],
          [238, 226, 202],
          [176, 122, 88],
          [216, 196, 166],
          [184, 138, 104],
          [242, 232, 210],
          [162, 110, 80],
        ],
        bandFreq: 7.5,
        fineBandFreq: 22,
        shear: 0.35,
        filaments: 0.4,
        phaseNoise: 0.12,
        spots: [
          {
            // t56：尺度过一轮"看不见 → 看得见 → 回到真尺寸"的往返。
            //  t54 的 0.11/0.055 是"看不见"时的补偿（当时真正的问题是朝斑方位没算清）；
            //  t56 用 faceU 摆位能稳定看见之后，屏幕上宽约 330px ≈ 盘面 45%，
            //  而真实大红斑约占经度 1/6 —— 偏大一倍，所以收到 0.088/0.044。
            //  warp 0.3 保持：0.55 那版会被湍流抹成一团，看不出"斑"的形状。
            //  真实位置：南纬 22° 附近 → v ≈ 0.62。
            //  t9：rim 提到 (214,146,112)（任务书指定）；paintGasGiant 补了淡色领圈、
            //      收紧了边界、core 阈值 0.24→0.42。尺寸 0.088/0.044 不动。
            u: 0.63,
            v: 0.62,
            rx: 0.088,
            ry: 0.044,
            rim: [214, 146, 112],
            core: [146, 58, 40],
            warp: 0.3,
          },
        ],
      });
    case "saturn":
      // t43：土星的带子比木星细腻但对比更强；北极圈带一点冷色（真实土星极区偏蓝绿）
      return paintGasGiant(w, h, {
        seed: 8,
        belts: [
          [246, 230, 198],
          [214, 188, 146],
          [250, 238, 212],
          [198, 170, 128],
          [238, 216, 180],
          [206, 178, 136],
        ],
        bandFreq: 11,
        fineBandFreq: 44,
        shear: 0.9,
        filaments: 0.55,
      });
    case "uranus":
      return paintBands(
        w,
        h,
        [
          [166, 216, 212],
          [184, 228, 224],
          [152, 200, 198],
        ],
        { seed: 12, freq: 12, turbulence: 0.5 },
      );
    case "neptune":
      // t9：深蓝 + 纬向暗带 + 白色卷云 + 零星星暗斑（不画 1989 年的大暗斑，见 paintNeptune）
      return paintNeptune(w, h);
    case "moon":
      return paintRocky(w, h, { seed: 33, base: [92, 92, 90], alt: [196, 192, 184], craters: 46 });
    case "io":
      // t9：硫黄斑杂 + 白霜 + 火山暗点（Io 几乎没有撞击坑，旧版 16 个坑是错的）
      return paintIo(w, h);
    case "europa":
      // t9：冰壳裂纹 + 少坑（和木卫三分开的关键）
      return paintEuropa(w, h);
    case "ganymede":
      // t9：暗地体 / 亮沟槽地体 + 密集平行沟槽
      return paintGanymede(w, h);
    case "callisto":
      // t9：深色平原 + 密集亮坑
      return paintCallisto(w, h);
    case "titan":
      // t9：橙色雾霾（没有地形细节，别画大陆）+ 北极暗色湖
      return paintTitan(w, h);
    default:
      return paintRocky(w, h, { seed: 1, base: [110, 110, 110], alt: [176, 176, 176] });
  }
}

/** 云层：成团成带，而不是满屏噪点。 */
function makeCloudPainter(w: number, h: number): RowPaint {
  const sample = makeSampler(71);
  const band = makeSampler(83);
  return (data, y0, y1) => {
    for (let y = y0; y < y1; y++) {
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
  };
}

// ——— 分帧调度 ————————————————————————————————————————————————

/**
 * 每帧最多花在贴图上的时间。16.7 ms 一帧里给 5 ms 是保守值：
 * 剩下的预算要留给 WebGL 提交、React 和浏览器自己的活。真机跑不动时先降这个，
 * 别去降纹理质量 —— 那是把「一次性等待」换成「永久模糊」。
 */
const CHUNK_MS = 5;

type Job = {
  slot: Slot;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  paint: RowPaint;
  /** 已经画到第几行 */
  y: number;
  /** 每个切片画几行：宽图一行就够，窄图一次画几行，省掉 per-切片 的调度开销 */
  step: number;
};

const queue: Job[] = [];
let pumping = false;

function schedule() {
  if (pumping) return;
  pumping = true;
  requestAnimationFrame(pump);
}

function pump() {
  pumping = false;
  const deadline = performance.now() + CHUNK_MS;
  while (queue.length > 0) {
    const job = queue[0]!;
    const y1 = Math.min(job.height, job.y + job.step);
    job.paint(job.image.data, job.y, y1);
    job.y = y1;
    if (job.y >= job.height) {
      queue.shift();
      finish(job);
    }
    if (performance.now() >= deadline) break;
  }
  if (queue.length > 0) schedule();
}

function finish(job: Job) {
  const { slot, width } = job;
  job.ctx.putImageData(job.image, 0, 0);
  const tex = new THREE.CanvasTexture(job.canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  const old = slot.best;
  slot.best = tex;
  slot.bestWidth = width;
  slot.job = null;
  // 旧的那张（可能是更小的一档，也可能是 1×1 占位色）换下来就释放，
  // 但绝不能顺手把占位色也释放掉：它是同一个对象，释放了下次首帧就没兜底。
  if (old !== slot.placeholder) old.dispose();
  for (const fn of slot.subs) fn(tex);
}

function cancelJob(job: Job) {
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  if (job.slot.job === job) job.slot.job = null;
}

// ——— 对外句柄 ————————————————————————————————————————————————

/** 一张程序化贴图的生命周期句柄。一个天体/一层云一个，缓存跨组件挂载复用。 */
export type BodyTexture = {
  /** 当前可用的贴图：占位色 / 已完成的程序化贴图 / 摄影贴图 */
  readonly texture: THREE.Texture;
  /**
   * 告诉调度器「这颗星在屏幕上最大占多少设备像素（直径）」，以及设备档位允许的宽度上限。
   * 占幅决定该多大，`texCap` 只封顶；只升不降（降档不回收已经生成的大图，避免闪一下）。
   */
  plan(maxScreenPx: number, texCap?: number): void;
  /** 贴图升级完成时回调（升级后的那一张），返回取消订阅 */
  onChange(fn: (tex: THREE.Texture) => void): () => void;
  /** 组件卸载：退订并取消还没跑完的任务（已生成的贴图留在缓存里） */
  release(): void;
};

type Slot = {
  id: string;
  placeholder: THREE.Texture;
  best: THREE.Texture;
  /** 当前贴图的宽度；0 = 还是占位色 */
  bestWidth: number;
  painter: ((w: number, h: number) => RowPaint) | null;
  job: Job | null;
  subs: Set<(tex: THREE.Texture) => void>;
};

const slots = new Map<string, Slot>();

function flatTexture(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function enqueue(slot: Slot, need: TextureSize): Job {
  const canvas = document.createElement("canvas");
  canvas.width = need.width;
  canvas.height = need.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const image = ctx.createImageData(need.width, need.height);
  const paint = slot.painter!(need.width, need.height);
  const job: Job = {
    slot,
    width: need.width,
    height: need.height,
    canvas,
    ctx,
    image,
    paint,
    y: 0,
    // 单次切片最多约 2048 像素一行：宽图 1 行、128 宽的图 16 行，
    // 这样一次 job.paint 调用的开销恒定，5 ms 的预算才吃得准。
    step: Math.max(1, Math.floor(2048 / need.width)),
  };
  queue.push(job);
  // 大的先做：启动期 12 张 128 排队时，用户聚焦某颗星插进来的 512/1024 要插队。
  // 排序是稳定的（ES2019+），同宽按入队顺序。
  queue.sort((a, b) => b.width - a.width);
  schedule();
  return job;
}

function planSlot(slot: Slot, maxScreenPx: number, texCap: number) {
  if (!slot.painter) return;
  const need = textureBudget(maxScreenPx, texCap);
  if (need.width <= slot.bestWidth) return;
  if (slot.job) {
    // 已经在做更大的了：这次请求不需要排队
    if (slot.job.width >= need.width) return;
    // 在做更小的：作废重排。丢掉的那点行数比「先糊着再换大图」便宜。
    cancelJob(slot.job);
  }
  slot.job = enqueue(slot, need);
}

function handleOf(slot: Slot): BodyTexture {
  return {
    get texture() {
      return slot.best;
    },
    plan: (maxScreenPx, cap = TEX_MAX_WIDTH) => planSlot(slot, maxScreenPx, cap),
    onChange: (fn) => {
      slot.subs.add(fn);
      return () => {
        slot.subs.delete(fn);
      };
    },
    release: () => {
      slot.subs.clear();
      if (slot.job) cancelJob(slot.job);
    },
  };
}

function makeSlot(id: string, placeholder: THREE.Texture, painter: (w: number, h: number) => RowPaint): Slot {
  const slot: Slot = {
    id,
    placeholder,
    best: placeholder,
    bestWidth: 0,
    painter,
    job: null,
    subs: new Set(),
  };
  slots.set(id, slot);
  return slot;
}

/**
 * 取某个天体的贴图句柄。
 *
 * 地球/月球：摄影贴图，尺寸固定（1024×512 / 512×256），不参与预算 —— 那是
 * 「真实长什么样」的资产，改分辨率只会让它更糊，不会更快（JPEG 解码不走这条像素路径）。
 * 其余：占位色立即返回，真实贴图按 plan() 的预算分帧生成，好了走 onChange。
 */
export function acquirePlanetTexture(body: Body): BodyTexture {
  const photo = body.texture === "earth" ? earthDayUrl : body.texture === "moon" ? moonUrl : null;
  if (photo) {
    const tex = loadFileTexture(photo);
    return {
      texture: tex,
      plan: () => {},
      onChange: () => () => {},
      release: () => {},
    };
  }
  const hit = slots.get(body.id);
  if (hit) return handleOf(hit);
  return handleOf(makeSlot(body.id, flatTexture(body.swatch), (w, h) => makeBodyPainter(body, w, h)));
}

/**
 * 地球的云层壳。单独一张贴图，预算跟着地球的占幅走。
 * 占位色是全透明：云层壳的片元在 alpha < 0.02 时 discard，所以"没有云贴图"
 * 等于"这层壳暂时不画"，不会先糊一团白再跳变。
 */
export function acquireCloudTexture(): BodyTexture {
  const hit = slots.get("clouds");
  if (hit) return handleOf(hit);
  return handleOf(makeSlot("clouds", flatTexture(""), (w, h) => makeCloudPainter(w, h)));
}

/** 太阳的光晕：径向渐变，不是逐像素噪声，成本 <1 ms，留在同步路径里。 */
export function glowTexture() {
  const hit = slots.get("glow");
  if (hit) return hit.best;
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
  const slot: Slot = {
    id: "glow",
    placeholder: tex,
    best: tex,
    bestWidth: 256,
    painter: null,
    job: null,
    subs: new Set(),
  };
  slots.set("glow", slot);
  return tex;
}

/**
 * 验收探针：当前每张程序化贴图的实际尺寸 + 还有几个任务在排队。
 * 用来证明「启动期只生成总览档、聚焦后才升档」，以及预算没有越界。
 * 摄影贴图（地球/月球）与光晕不在报告里，它们不参与预算。
 */
export function textureReport() {
  const items: { id: string; width: number; height: number; pixels: number }[] = [];
  let totalPixels = 0;
  for (const slot of slots.values()) {
    if (slot.id === "glow") continue;
    const img = slot.best.image as { width?: number; height?: number } | undefined;
    const width = img?.width ?? 1;
    const height = img?.height ?? 1;
    const pixels = width * height;
    totalPixels += pixels;
    items.push({ id: slot.id, width, height, pixels });
  }
  return { pending: queue.length, totalPixels, items };
}
