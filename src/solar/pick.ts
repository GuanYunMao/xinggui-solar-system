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
  /** 环带的内外半径，与 radius 同一单位 */
  rings?: { inner: number; outer: number };
  /** 环平面的世界单位法线。给了它，环带才会按真实的斜视椭圆判定 */
  ringNormal?: THREE.Vector3;
};

export type PickCandidate = {
  id: string;
  /** CSS 像素 */
  x: number;
  y: number;
  /** 视觉半径（CSS 像素），画面上能看到多大的圆盘 */
  radiusPx: number;
  /** 环带：屏幕空间中「世界单位 → 像素」的两根基向量，缺省时全 0 表示没有环 */
  ringUx: number;
  ringUy: number;
  ringVx: number;
  ringVy: number;
  ringInner: number;
  ringOuter: number;
  /** 相机到天体中心的距离 */
  depth: number;
};

/**
 * fov 约定的**唯一编码点**：tan(垂直半视角)。
 *
 * 为什么单独立这一行：全仓有四个地方要用这条约定 —— 拾取器算焦距、渲染器算贴图 LOD、
 * 标签层算投影、竖屏取景算"距离 d 处的半高"。它们以前各写一份 `Math.tan((fov*PI)/360)`，
 * 谁改约定（比如从竖直 fov 换成水平 fov）都得记得改四处；现在只在这里改。
 * `scripts/check-shape.mjs` 第 1 条就是拦"SolarCanvas 里再长出一份"的。
 */
const tanHalfFov = (fovDeg: number) => Math.tan((fovDeg * Math.PI) / 360);

/** 透视相机的像素焦距：视口高一半 ÷ tan(vfov/2)。 */
export function focalPx(height: number, fovDeg: number) {
  return height / 2 / tanHalfFov(fovDeg);
}

/**
 * 距离 `dist` 处、竖直方向一屏覆盖的半高（世界单位）—— 就是 focalPx 的反解。
 *
 * 消费者：竖屏取景时把镜头目标下移 `0.55 × 半高`（让星球被顶到上半屏、别被底部详情卡压住）。
 * 它不是"算焦距"，但换的是同一条约定，所以必须和 focalPx 同源 —— 否则改 fov 约定时
 * 这里会安静地算错一个取景偏移（不崩、只是星球位置不对），比报错更难查。
 */
export function halfSpanAt(dist: number, fovDeg: number) {
  return dist * tanHalfFov(fovDeg);
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();

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
    const ndcX = _v.x;
    const ndcY = _v.y;
    /*
     * 视觉半径用切线，不是小角近似：
     * 小角近似 focal·R/d 在 R/d 大时严重偏小。100 km 高度那天 R/d = 0.985，
     * 近似给 0.985·focal，真实是 tan(asin(0.985))·focal = 5.7 倍 ——
     * 表现就是"只有圆盘内侧 17% 半径的地方点得中"。
     */
    const ratio = Math.min(1, body.radius / depth);
    const radiusPx = focal * Math.tan(Math.asin(ratio));

    let ringUx = 0;
    let ringUy = 0;
    let ringVx = 0;
    let ringVy = 0;
    if (body.rings && body.ringNormal) {
      // 环平面内的两根正交单位轴（取哪两根无所谓：带区判定只用到 a²+b²）
      _n.copy(body.ringNormal).normalize();
      _u.set(0, 1, 0);
      if (Math.abs(_n.dot(_u)) > 0.9) _u.set(1, 0, 0);
      _u.crossVectors(_n, _u).normalize();
      _w.crossVectors(_n, _u).normalize();
      /*
       * 不要用「焦距/深度」的导数当线性化：那等价于假设天体在画面正中心，
       * 一到边缘（土星在 (751,505)）误差就大到把椭圆方向算歪。
       * 直接投影环平面两个基向量的**端点**（长度取环外径），
       * 得到的 2×2 映射在这两点上是精确的，中间是仿射近似 —— 够用且稳。
       */
      const eps = body.rings.outer;
      const toScreen = (vec: THREE.Vector3) => {
        _p.copy(body.world).addScaledVector(vec, eps).project(camera);
        return { x: ((_p.x - ndcX) * 0.5 * width) / eps, y: (-(_p.y - ndcY) * 0.5 * height) / eps };
      };
      const su = toScreen(_u);
      const sv = toScreen(_w);
      ringUx = su.x;
      ringUy = su.y;
      ringVx = sv.x;
      ringVy = sv.y;
    }

    out.push({
      id: body.id,
      x: (_v.x * 0.5 + 0.5) * width,
      y: (-_v.y * 0.5 + 0.5) * height,
      radiusPx,
      ringUx,
      ringUy,
      ringVx,
      ringVy,
      ringInner: body.rings?.inner ?? 0,
      ringOuter: body.rings?.outer ?? 0,
      depth,
    });
  }
  return out;
}

/** 点是否落在环带的斜视椭圆投影里；退化（几乎侧看）时返回 false。 */
function inRingEllipse(c: PickCandidate, ox: number, oy: number): boolean {
  if (!(c.ringOuter > 0)) return false;
  const det = c.ringUx * c.ringVy - c.ringUy * c.ringVx;
  // 行列式趋零 = 环平面几乎与视线平行，投影退化成一条线，没有可点面积
  const scale = Math.hypot(c.ringUx, c.ringUy) * Math.hypot(c.ringVx, c.ringVy);
  if (!(scale > 0) || Math.abs(det) < scale * 1e-4) return false;
  const a = (ox * c.ringVy - oy * c.ringVx) / det;
  const b = (c.ringUx * oy - c.ringUy * ox) / det;
  const r = Math.hypot(a, b);
  return r >= c.ringInner && r <= c.ringOuter;
}

/**
 * 命中层级。0 = 视盘内，0.5 = 环带内，1 = 热区内，null = 没命中。
 *
 * 「看得见的边界优先于看不见的扩边」——所以视盘 0 赢过热区 1，
 * 而环带 0.5 输给本体、赢过邻近卫星的隐形热区（土星环 vs 土卫六就靠这条）。
 *
 * 环带必须按**斜视椭圆**判：环平面倾角 26.7°（土星）或 97.8°（天王星）时，
 * 正圆判定会把整片天空和邻近卫星的热区一起吞掉 —— 实测"土星中心上方 200px 的
 * 纯黑天区点下去会选中土星"。
 */
export function tierOf(c: PickCandidate, px: number, py: number): 0 | 0.5 | 1 | null {
  const ox = px - c.x;
  const oy = py - c.y;
  const d = Math.hypot(ox, oy);
  if (d <= c.radiusPx) return 0;
  if (inRingEllipse(c, ox, oy)) return 0.5;
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
