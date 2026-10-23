import * as THREE from "three";

/**
 * 屏幕空间拾取。
 *
 * 为什么不走 raycast：1:1 实境下地球在全景里只有 0.0015 px，天体的三角面在
 * 射线看来根本不存在；沙盘里靠一个「透明球壳」当热区也不行 —— 那是世界空间
 * 尺寸（`max(radius*2.4, 0.12)`），换个单位体系就变成 0.12 米，等于没有。
 * 屏幕空间判定的好处是它对单位、比例、模式完全无感：只认投影结果。
 *
 * 本模块不依赖 React，只依赖 three 的数学类型，方便单测与复用。
 */

/** 44 CSS px 触控直径的一半。低于这个值手指点不中。 */
export const HOT_RADIUS_CSS = 22;

export type PickBody = {
  id: string;
  /** 世界坐标（沙盘是世界单位，实境是米；本模块不关心单位） */
  world: THREE.Vector3;
  radius: number;
  /** 环带的内外半径，同样是与 radius 同一单位的世界长度 */
  rings?: { inner: number; outer: number };
};

export type PickCandidate = {
  id: string;
  /** CSS 像素 */
  x: number;
  y: number;
  /** 视觉半径（CSS 像素），画面上能看到多大的圆盘 */
  radiusPx: number;
  /** 环带投影半径；没有环就是 0 */
  ringInnerPx: number;
  ringOuterPx: number;
  /** 相机到天体中心的距离 */
  depth: number;
};

/** 透视相机的像素焦距：视口高一半 ÷ tan(vfov/2)。 */
export function focalPx(height: number, fovDeg: number) {
  return height / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * 把天体投影成屏幕候选。
 * 相机背后的天体直接剔除 —— `Vector3.project` 对 w<0 会翻符号，
 * 不先判一次的话，背后的天体会「镜像」到画面上，成为幽灵热区。
 */
export function projectCandidates(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  bodies: readonly PickBody[],
): PickCandidate[] {
  const focal = focalPx(height, camera.fov);
  camera.getWorldDirection(_fwd);
  const out: PickCandidate[] = [];

  for (const body of bodies) {
    _v.copy(body.world).sub(camera.position);
    const depth = _v.length();
    if (depth <= 1e-9) continue;
    if (_v.dot(_fwd) <= 0) continue; // 相机背后

    _v.copy(body.world).project(camera);
    const radiusPx = (focal * body.radius) / depth;
    out.push({
      id: body.id,
      x: (_v.x * 0.5 + 0.5) * width,
      y: (-_v.y * 0.5 + 0.5) * height,
      radiusPx,
      ringInnerPx: body.rings ? (focal * body.rings.inner) / depth : 0,
      ringOuterPx: body.rings ? (focal * body.rings.outer) / depth : 0,
      depth,
    });
  }
  return out;
}

/**
 * 命中层级。0 = 视盘内，0.5 = 环带内，1 = 热区内，null = 没命中。
 *
 * 「看得见的边界优先于看不见的扩边」——所以视盘 0 赢过热区 1，
 * 而环带 0.5 输给本体、赢过邻近卫星的隐形热区（土星环 vs 土卫六就靠这条）。
 */
export function tierOf(c: PickCandidate, px: number, py: number): 0 | 0.5 | 1 | null {
  const d = Math.hypot(px - c.x, py - c.y);
  if (d <= c.radiusPx) return 0;
  if (c.ringOuterPx > 0 && d >= c.ringInnerPx && d <= c.ringOuterPx) return 0.5;
  if (d <= Math.max(HOT_RADIUS_CSS, c.radiusPx)) return 1;
  return null;
}

/**
 * 歧义全序（t8 §4 定稿，照做不自创）：
 *   tier 升序 → 屏距升序 → 视觉半径降序 → 深度升序 → id 升序
 * 最后两级只为了让结果**确定**，不是审美：同一输入必须恒返回同一个 id，
 * 否则验收断言会间歇性飘。
 */
export function resolvePick(candidates: readonly PickCandidate[], px: number, py: number): string | null {
  let best: { c: PickCandidate; tier: number; d: number } | null = null;
  for (const c of candidates) {
    const tier = tierOf(c, px, py);
    if (tier === null) continue;
    const d = Math.hypot(px - c.x, py - c.y);
    if (
      best === null ||
      tier < best.tier ||
      (tier === best.tier &&
        (d < best.d ||
          (d === best.d &&
            (c.radiusPx > best.c.radiusPx ||
              (c.radiusPx === best.c.radiusPx &&
                (c.depth < best.c.depth ||
                  (c.depth === best.c.depth && c.id < best.c.id)))))))
    ) {
      best = { c, tier, d };
    }
  }
  return best ? best.c.id : null;
}

/** 按 id 找候选，测试与调试用。 */
export function candidateOf(candidates: readonly PickCandidate[], id: string) {
  return candidates.find((c) => c.id === id) ?? null;
}
