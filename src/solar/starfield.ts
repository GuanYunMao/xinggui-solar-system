import * as THREE from "three";

/**
 * 星空：银河带 + 星等/色温分层 + 极慢整体漂移。
 *
 * 物理前提（写在最前面，免得后人"优化"掉）：**恒星在太阳系尺度内没有视差**。
 * 所以这一整片天空挂在跟随相机的 group 上（见 SolarCanvas 的 Stars）：相机怎么飞，
 * 星点在世界里的相对位置都不变 —— 天空不动才是对的。它缺的从来不是运动，是**层次**：
 * 改造前 2800 个同尺寸白点均匀撒一层，看起来就是一张贴图。
 *
 * 三个做法都在这里（不引资产，全部 shader/生成器）：
 *  1. 银河带：一个低多边形天球 + 顶点着色器里算的大尺度噪声带（片元只做插值，不跑噪声）。
 *     为什么不做逐像素噪声：这台机构的验收是 SwiftShader 软件光栅，全屏 fbm 是几毫秒级的
 *     填充成本；顶点着色器 2048 个顶点算一次，片元只剩一次 mix。
 *  2. 星等与色温：按幂律分布抽星等（暗星压倒性多），颜色沿「蓝 → 白 → 暖黄」取，
 *     亮度同时体现在尺寸和颜色上。星点在无穷远，所以尺寸不再随深度缩放（物理上也对）。
 *  3. 漂移：整片天空 0.01°/s 绕银道极慢转（转一圈 10 小时），加极轻的闪烁。
 *
 * 亮度预算：星空是背景，不能抢天体。实测判据见 t32 交付（星空区域的均值 ≤ 背景 4 倍）。
 *
 * ⚠ **1.4.0 的前置项（t59 实测发现，不要当冗余删掉）**：这一层只在**沙盘**挂。
 * `REAL_SYSTEM.look` 继承 `REAL_PROTO` 的 `decor: false`（systems.ts），所以**实境根本没有星空**。
 * 1.3.x 看不出来（实境相机钉在地月附近，视野里总有天体）；**1.4.0 是自由飞 —— 飞离地月之后
 * 外面就是全黑**。实境要挂星空，得先解决"米制量级 vs 天球半径"这件事（见 REAL_PROTO 的注释：
 * decor 关掉的原因是几何体都建在几十到几百世界单位，米制下量级不对），不是把 decor 翻成 true 就行。
 */

/** 银道面法线（世界坐标）。故意不贴黄道：斜着穿过去才看得出"这是银河，不是轨道面"。 */
export const GALACTIC_NORMAL = new THREE.Vector3(0.5, 0.78, -0.38).normalize();

/** 漂移速度：0.01°/s —— 转一圈 10 小时。 */
export const SKY_DRIFT_RAD_PER_S = (0.01 * Math.PI) / 180;

/** 天球半径：要在沙盘 far（≈983）以内，并且比任何场景内容都远。 */
export const SKY_RADIUS = 820;

/** 星点所在半径（相对天空球心）。同样在 far 以内。 */
const STAR_RADIUS = 700;

/**
 * 银河带的整体亮度。
 *
 * 这个数是**实测调出来的**，不是推出来的：加法混合发生在 sRGB 编码后的缓冲里，
 * 片元输出的 alpha 乘的是编码后的颜色，所以"线性空间估算 0.016 应该够"是错的 ——
 * 实测那个值只让背景从 8.94 抬到 9.9（不到 1/255）。
 *
 * t59 三轮实测（同一探针、同一机位、0.5° 一档中位数；背景 = 直方图 lum<20 最多档 = 9）：
 *  0.28 → 带心/背景 3.55×、星空均值/背景 1.89×（FWHM 15.5° 时）
 *  0.40 → 带心/背景 **4.62×**、星空均值/背景 **2.36×**（t32 的"区域均值 ≤ 4×"仍有余量，
 *         但**峰值侧已经越过 4×** —— 这条预算按 captain 的口径可以突破，前提是报超出多少、
 *         并证明前景可辨性没退化：见 PR 里的"盘面对比环"那一项）。
 * 改它之前先截图量一遍，别照着线性公式算。
 */
export const BAND_OPACITY = 0.36;

/** 星点：位置固定在天球上，尺寸是角尺寸（不随深度变） */
export const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    /*
     * t59：银河暗尘带也要吸**星**。尘是吸收，挡的是"后面的所有光" —— 只压带子那一项压不出暗缝：
     * 实测只改带子的尘深度（0.55→0.15）时，带心只比两侧暗 4.6%，肉眼不可见 ——
     * 因为 70% 的星都收在带里，而星是加法混合、完全不理会尘。所以这里按同一条银纬给星点乘透过率。
     * 银道面法线写死成 GALACTIC_NORMAL 的同一组数（两层用同一个方向；天球漂移时一起转）。
     */
    vec3 gd = normalize(position);
    float glat = dot(gd, normalize(vec3(0.5, 0.78, -0.38)));
    float gdust = smoothstep(0.0, 0.09, abs(glat));
    vColor = aColor * (0.16 + 0.84 * gdust);
    vPhase = aPhase;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 无穷远的星：角尺寸固定，gl_PointSize 不除深度（改造前除 -mv.z，一缩放星星就变大）
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * mv;
  }
`;

export const STAR_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    float a = smoothstep(0.5, 0.12, d);
    if (a < 0.02) discard;
    // 极轻的闪烁：±8%，周期彼此错开（vPhase）
    float tw = 0.92 + 0.08 * sin(uTime * 0.5 + vPhase);
    gl_FragColor = vec4(vColor, a * tw);
  }
`;

/** 银河带：顶点着色器算大尺度带 + 噪声结团，片元只插值 */
export const BAND_VERT = /* glsl */ `
  uniform vec3 uNormal;
  varying vec3 vColor;
  varying float vGlow;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }
  float fbm(vec3 p) {
    float s = 0.0;
    float a = 0.5;
    // t59 颗粒维：3 → 4 个 octave。第 4 档的格子 ≈ 2°（dir·3.1 再乘 2.07³），
    // 正好填掉 42° fov 下"一片糊"的那一段；只加一档、权重照旧递减，不改总幅度。
    for (int i = 0; i < 4; i++) {
      s += a * vnoise(p);
      p = p * 2.07 + 11.3;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 dir = normalize(position);
    // 银纬（对带法线的投影）决定带的截面：高斯，σ=0.14（t59 第二维：实测 FWHM 11.9° → 15.5°）。
    // 为什么是 0.14 而不是观感微调：真实银河亮带的 FWHM 是 15–20°，σ=0.10 时只有 11.9° —— 这是事实偏差。
    // 放宽不改峰值（lat=0 处恒为 1），只把 ±5–12° 的肩部抬起来；峰值亮度一个数都没动（亮度是另一维）。
    float lat = dot(dir, uNormal);
    float band = exp(-lat * lat / (2.0 * 0.14 * 0.14));
    // 暗尘带：正中间切一条，免得带子像一根荧光管。
    // t59 实测：只加深这一项（0.55→0.15）带心也只比两侧暗 **4.6%**，肉眼看不出来 ——
    // 因为带里 70% 的星是加法混合、不理会尘；真正的暗缝得让尘连星一起吸（见 STAR_VERT）。
    // 这一维（尘）在两层用的是同一组 abs(lat) 阈值（0.09 ≈ 5.2°），所以缝在两层的边缘对得上。
    float dust = smoothstep(0.0, 0.09, abs(lat));
    float clouds = fbm(dir * 3.1);
    float clumps = fbm(dir * 7.9 + 13.7);
    // 带的亮度 = 截面 × 云团 × 尘带，再轻微调制
    float glow = band * (0.28 + 0.72 * smoothstep(0.22, 0.78, clouds)) * (0.22 + 0.78 * dust);
    glow *= 0.72 + 0.28 * clumps;
    vGlow = glow;
    // 色温：冷蓝为核心（银河星族更蓝），暖黄在云团处
    vColor = mix(vec3(0.60, 0.68, 0.86), vec3(0.92, 0.86, 0.72), smoothstep(0.35, 0.8, clouds) * 0.65);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const BAND_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vGlow;
  void main() {
    gl_FragColor = vec4(vColor, vGlow * uOpacity);
  }
`;

/**
 * 生成星点几何。
 *
 * 星等：亮度 b = 1 − u^2.6（u 均匀）→ 绝大多数暗、少数亮，这是肉眼看到的样子；
 * 色温：白为主，两端各约 45% 权重往蓝/黄偏；尺寸与颜色都随亮度走。
 * 分布：70% 收进银河带（银纬高斯 + 拒绝采样），30% 全天均匀（晕星）。
 */
export function createStarGeometry(count = 2800): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  let s = 7;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const n = GALACTIC_NORMAL;
  const bandCount = Math.round(count * 0.7);

  const randomDir = () => {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    return [r * Math.cos(th), u, r * Math.sin(th)] as const;
  };

  for (let i = 0; i < count; i++) {
    let d = randomDir();
    if (i < bandCount) {
      // 往带里收：银纬越靠近 0 越容易被接受（拒绝采样，每颗星阈值不同 → 平滑的密度梯度）
      const limit = 0.42 * (0.35 + rand() * 0.65);
      for (let tries = 0; tries < 8; tries++) {
        const lat = Math.asin(Math.max(-1, Math.min(1, d[0] * n.x + d[1] * n.y + d[2] * n.z)));
        if (Math.abs(lat) < limit) break;
        d = randomDir();
      }
    }
    positions[i * 3] = d[0] * STAR_RADIUS;
    positions[i * 3 + 1] = d[1] * STAR_RADIUS;
    positions[i * 3 + 2] = d[2] * STAR_RADIUS;

    // 星等 → 亮度（幂律：暗星压倒性多）
    const bright = 1 - Math.pow(rand(), 2.6);
    sizes[i] = 1.0 + 3.4 * Math.pow(bright, 1.7);
    // 色温：白为主，两端各偏蓝/偏黄
    const t = rand();
    let r = 0.96;
    let g = 0.97;
    let b = 1.0;
    if (t > 0.55) {
      const k = (t - 0.55) / 0.45;
      r += (1.0 - r) * k;
      g += (0.88 - g) * k;
      b += (0.72 - b) * k;
    } else if (t < 0.45) {
      const k = (0.45 - t) / 0.45;
      r += (0.74 - r) * k;
      g += (0.84 - g) * k;
      b += (1.0 - b) * k;
    }
    // 暗星连颜色一起淡下去（正常混合下就是"更暗的像素"）
    const dim = 0.42 + 0.58 * bright;
    colors[i * 3] = r * dim;
    colors[i * 3 + 1] = g * dim;
    colors[i * 3 + 2] = b * dim;
    phases[i] = rand() * Math.PI * 2;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  g.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  return g;
}
