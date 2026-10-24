import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simTimeNow } from "./clock";
import { isMoon, type Body } from "./data";
import { useSim } from "./store";
import { useSystem } from "./system-context";
import { HOT_RADIUS_CSS, focalPx, halfSpanAt, projectCandidates, resolvePick, type PickBody } from "./pick";
import { farFloorFor, frameEarthMoon, tightenClipPlanes, type VisibleBody } from "./systems";
import {
  BAND_FRAG,
  BAND_OPACITY,
  BAND_VERT,
  GALACTIC_NORMAL,
  SKY_DRIFT_RAD_PER_S,
  SKY_RADIUS,
  STAR_FRAG,
  STAR_VERT,
  createStarGeometry,
} from "./starfield";
import { acquireCloudTexture, acquirePlanetTexture, glowTexture, textureReport } from "./textures";
import { installQualityProbe, noteFrame, noteGpu, texCap, useQualityTier } from "./quality";

declare global {
  interface Window {
    __solarReady?: boolean;
  }
}

type Registry = {
  groups: Map<string, THREE.Group>;
  spins: Map<string, THREE.Group>;
  clouds: Map<string, THREE.Group>;
  belt: THREE.Group | null;
};

const RegistryContext = createContext<Registry | null>(null);

/**
 * 从 registry 里读出「必须可见集合」—— `farFloorFor` 的输入（R7）。
 *
 * 为什么这段留在渲染层而不进 systems.ts：世界坐标只有 registry 知道。两个相机
 * （沙盘 / 米制）都走这一个取数口，far 的下界才不会"米制传、沙盘不传"。
 */
function visibleExtents(reg: Registry, bodies: readonly Body[]): VisibleBody[] {
  const p = new THREE.Vector3();
  const out: VisibleBody[] = [];
  for (const b of bodies) {
    const g = reg.groups.get(b.id);
    if (!g) continue;
    g.getWorldPosition(p);
    out.push({ id: b.id, x: p.x, y: p.y, z: p.z, radius: b.radius });
  }
  return out;
}

function useRegistry() {
  const value = useContext(RegistryContext);
  if (!value) throw new Error("missing registry");
  return value;
}

/**
 * 拖拽 / 点选的区分。触屏上转完视角松手会落一个 click 到星球上，
 * 原来会顺手把镜头拽到那颗星 —— 位移超过阈值就当拖拽，不选。
 */
const dragGuard = { moved: false, x: 0, y: 0, active: false };
const DRAG_THRESHOLD = 6;

/**
 * 诊断开关。?diag=1 时每 20 帧把「相机在哪 / 天体在哪 / 裁剪面 / NDC」打到控制台。
 * 黑屏这类问题只能靠数字定案：这三种成因（相机没到位、天体没到位、被裁剪）在
 * 屏幕上都表现为一片黑，只有这四组数能区分开。
 */
const DIAG =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("diag");

/**
 * 像素回读开关。WebGL 默认不保留绘制缓冲，readPixels 只能在渲染当帧内读；
 * 打开 preserveDrawingBuffer 才能在任意时刻读帧。只在原型/对照/诊断模式下开，
 * 默认路径（沙盘）一个字节都不变。
 */
const READBACK =
  typeof window !== "undefined" &&
  ["proto", "legacy", "diag"].some((k) => new URLSearchParams(window.location.search).has(k));

/**
 * `?proto=1` 是**抖动测量的专用机位**（正面受光 + 慢摆），不是产品取景。
 * 实地模式（store.mode === "real"，不带这个参数）用 frameEarthMoon 的地月取景。
 * 两者挂的是同一台 <MeterCamera>，但机位语义不同（夹具要正对受光面、实地要地月同框），
 * 所以取景路径必须分开 —— 不是两个"分支"，是同一组件里的两条取景语义。
 */
const PROTO_HARNESS =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("proto") === "1";

/** ?legacy=1：把行星顶点着色器切回"世界坐标过 float32 再减相机"的旧写法，作为抖动对照。 */
const LEGACY_SHADER =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("legacy") === "1";

/**
 * 原型相机到地球的距离（米）。默认 2.5e7。
 *
 * 这个默认值是从取景反推的，不是拍的：地球在 720p 上的投影半径
 * = f·tan(asin(R/d))，f=937.8。d=1e7 时半径 776 px，而画面角方向只到
 * 734 px（1280×720 的对角半径）—— 四个角全被地球吃掉，截图是一片洋面，
 * 连"这是一颗球"都看不出来。d=2.5e7 时半径 247 px，四边留黑，整颗球在画面里。
 *
 * 抖动测量不用这个默认值，用 ?dist=1.2e7（圆盘左右缘刚好还在画面内，f/视距 最大）。
 */
const PROTO_DIST = (() => {
  const raw = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dist");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2.5e7;
})();

/** ?still=1：相机完全钉死。用来量"测量本身的噪声底"，不参与正常断言。 */
const STILL =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("still") === "1";

const VARYINGS = `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vPos;
`;

const PLANET_VERT_MODERN = /* glsl */ `
  ${VARYINGS}
  void main() {
    vUv = uv;
    // 用 modelViewMatrix 而不是 modelMatrix*viewMatrix：
    // 后者要在 shader 里做大数相减（世界坐标 ~1e11 m），float32 只剩约 16 km 精度，
    // 1:1 实境下地球会抖 2.5 px。modelViewMatrix 是 CPU 侧用 double 预乘的，
    // 减完相机位置才降成 float32，抖动消失。
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPos = mv.xyz;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * 对照用的旧写法（?legacy=1）。除了 gl_Position 的算法之外与上面逐字相同，
 * 所以两者画面差异只可能来自顶点位置的 float32 量化，不该有别的东西混进来。
 */
const PLANET_VERT_LEGACY = /* glsl */ `
  ${VARYINGS}
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    vPos = mv.xyz;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const PLANET_VERT = LEGACY_SHADER ? PLANET_VERT_LEGACY : PLANET_VERT_MODERN;

/** 复用同一个 Y 轴向量，避免每帧 new Vector3（原型分支里每帧都会用到）。 */
const Y_AXIS = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/** 取一个与给定单位向量垂直的轴（优先用世界 Y，退化时用世界 X）。 */
function perpAxis(dir: THREE.Vector3) {
  return Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : Y_AXIS;
}

const PLANET_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunCenter;   // 观察空间里的太阳中心
  uniform float uSunRadius;
  uniform vec3 uOcc[4];      // 近亲遮挡体（母天体 / 自己的卫星），观察空间
  uniform float uOccR[4];
  uniform int uOccCount;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vPos;

  /*
   * 日食/月食的**解析遮挡**（t47）。逐片元问一句：从这个点射向太阳的射线，有没有被球体挡住？
   *
   * 为什么不用 shadow map：参与者全是球体对球体，解析解没有分辨率、没有 biasing、
   * 也不需要一张额外的深度图；代价是一次无分支的小循环。
   *
   * 为什么不用 asin/acos：那是每片元 2 次反三角 × 4 个遮挡体。这里全部换成小角近似
   *   - 角半径 ≈ R / d（太阳 3.8/15 ≈ 0.25 rad，误差 ~2%；月球 0.2/1.95 ≈ 0.1 rad，误差 <0.2%）
   *   - 两方向的夹角 ≈ |cross(u, v)|（= sin 角度）
   * 覆盖率 = 遮挡圆盘与太阳圆盘的重叠比例，用线性近似 (aOcc + aSun − sep) / (2·aSun)：
   * sep ≥ aOcc+aSun 无遮挡、sep ≤ aOcc−aSun 全食，中间线性过渡 = 半影。
   */
  float eclipseCoverage(vec3 P) {
    vec3 toSun = uSunCenter - P;
    float dSun = length(toSun);
    if (dSun < 1e-4) return 0.0;
    vec3 sunDir = toSun / dSun;
    float aSun = max(uSunRadius / dSun, 1e-5);
    float cover = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= uOccCount) break;
      vec3 toOcc = uOcc[i] - P;
      float dOcc = length(toOcc);
      if (dOcc < uOccR[i] + 1e-4) continue; // 点在遮挡体内部：交给相机钳制，不算食
      float aOcc = uOccR[i] / dOcc;
      float sep = length(cross(sunDir, toOcc / dOcc));
      cover = max(cover, clamp((aOcc + aSun - sep) / (2.0 * aSun), 0.0, 1.0));
    }
    return cover;
  }

  void main() {
    vec4 texel = texture2D(uMap, vUv);
    if (texel.a < 0.05) discard;
    vec3 N = normalize(vN);
    // 太阳在世界原点，投到观察空间再算方向（同样避开大数相减）
    vec3 sunView = (viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 L = normalize(sunView - vPos);
    // 本影里直射光归零，只留一点环境光；半影按覆盖率线性衰减
    float direct = 1.0 - eclipseCoverage(vPos);
    float shade = clamp(dot(N, L) * 0.62 * direct + 0.38 * (0.22 + 0.78 * direct), 0.06, 1.0);
    vec3 V = normalize(-vPos);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = texel.rgb * shade + texel.rgb * rim * 0.16 * direct;
    gl_FragColor = vec4(col, texel.a);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vPos;
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    if (texel.a < 0.02) discard;
    vec3 N = normalize(vN);
    vec3 sunView = (viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float ndl = dot(N, normalize(sunView - vPos));
    // 云要用自己的一套明暗：套行星那套的话，背光侧半透明的白云会被压成灰黑脏斑。
    // 夜侧直接淡出，露出地表，而不是糊一层灰。
    float shade = clamp(ndl * 0.62 + 0.42, 0.28, 1.0);
    float alpha = texel.a * 0.92 * smoothstep(-0.02, 0.3, ndl);
    gl_FragColor = vec4(vec3(0.98, 0.99, 1.0) * shade, alpha);
  }
`;

const SUN_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SUN_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i);
    float n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash(i + vec3(1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }
  float fbm(vec3 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 2.8);
      a *= 0.5;
    }
    return s;
  }
  void main() {
    vec3 p = normalize(vWorld) * 3.4;
    float t = uTime * 0.12;
    float n = fbm(p + vec3(t, t * 0.25, -t * 0.4));
    float n2 = fbm(p * 2.2 - vec3(t * 0.55, 0.0, t * 0.2));
    vec3 hot = vec3(1.0, 0.96, 0.84);
    vec3 mid = vec3(1.0, 0.68, 0.26);
    vec3 deep = vec3(0.86, 0.28, 0.06);
    vec3 col = mix(deep, mid, smoothstep(0.28, 0.72, n));
    col = mix(col, hot, smoothstep(0.55, 0.92, n2));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SHELL_VERT = /* glsl */ `
  varying vec3 vNormalV;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHELL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormalV;
  void main() {
    /*
     * 大气/日冕的边缘衰减（t51 重写）。
     *
     * 旧版：pow(0.62 - dot(N, view), 2.1)。BackSide 壳上法线是背向的，dot 基本为正，
     * 这个式子只在"贴到接近 90°"的极窄一带里才大于 0 —— 结果是**一条硬边塑料圈**：
     * 内缘突然亮起、外缘在壳的轮廓处被一刀切断，中间几乎没有渐变。
     *
     * 现在改成按**屏幕半径**衰减：r = 0 在盘心、1 在壳缘，
     * 天体表面（r = uInner）处最亮，向外 pow(1 - t, 2.4) 衰减到 0 —— 近似平方衰减。
     * 为什么用 |dot(N, view)| 反算而不是传顶点：球面在正交性上 r = sqrt(1 - cos²)，
     * 比新加一个 varying 便宜，而且缩放后仍然成立（壳是等比缩放的球）。
     *
     * 只改曲线，不降 uOpacity —— 降不透明度会把日冕一起压淡（同一条链路）。
     */
    float c = dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0));
    float r = sqrt(max(0.0, 1.0 - c * c));
    /*
     * core 里 c **不能取绝对值**：BackSide 壳上可见片元的法线是背向的，dot 为负，
     * 原来的 0.62 - c 于是变成 0.62 + |c| —— 那正是它宽度合适的原因。
     * 第一版我"顺手"加了 abs，带宽直接掉到 1/5（实测 82.8 → 23.4），这条记在这里。
     */
    /*
     * 两段相乘，各修一个毛病：
     *
     *  1. core = 原来的菲涅尔形状（盘缘最亮、向内快速消失）。它的宽度是对的，
     *     改前之所以像塑料圈，是它在**壳缘**（r = 1）还留着 0.34 的亮度，
     *     于是几何边界处一刀切成 0 —— 硬边就来自这一刀。
     *  2. taper 就是补这一刀：在壳缘最后 20% 的带子里把亮度平滑收到 0。
     *     叠加之后从盘面到太空是一条连续曲线，而日冕（同一条 shader、uInner 0.645）
     *     也一起变软，不需要单独调它的不透明度。
     *
     * 试过更"教科书"的写法 pow(1 - t, 1.5)（t 从盘缘到壳缘），实测反而更糟：
     * 半程就掉到 10%，图上只剩贴边一条细线 —— 因为背向壳的可见带比想象中窄。
     */
    float core = pow(max(0.62 - c, 0.0), 2.1);
    /*
     * 壳缘收口：可见带落在 |c| ∈ [0, 0.45]（c = 0 是壳的轮廓，c ≈ 0.45 是天体盘缘），
     * 所以让 alpha 在 |c| < 0.18（带子的最外 16%）里平滑归零 —— 只削那一刀，不动带宽。
     * 这是第 5 版才开始用的写法：前几版用屏幕半径 r 做 smoothstep，实测每次都把
     * 整条带子压窄（82.8 → 49.7 → 33），因为插值后的 r 和我推的几何值对不上。
     */
    float edge = smoothstep(0.0, 0.18, abs(c));
    float a = clamp(core, 0.0, 1.0) * edge * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

const RING_VERT = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    vLocal = position.xy;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vLocal;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    float r = length(vLocal);
    float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
    float bands = 0.28 + 0.72 * abs(sin(t * 52.0));
    float fine = 0.72 + 0.28 * sin(t * 180.0);
    float gap = smoothstep(0.0, 0.01, abs(t - 0.62) - 0.012);
    float alpha = bands * fine * gap;
    if (alpha < 0.18) discard;
    vec3 N = normalize(vNormalW);
    vec3 L = normalize(-vWorld);
    float shade = clamp(abs(dot(N, L)) * 0.55 + 0.45, 0.35, 1.0);
    gl_FragColor = vec4(uColor * shade, alpha);
  }
`;

/*
 * 沙盘 home 机位的**唯一出处**（R6）。位置 / 视场这两个数以前写在三处：
 * Canvas 的 camera prop、applyHome、homeVector —— 改一处忘一处就会"首帧和稳态不是一个机位"。
 * near/far 不在这里：那是相机的裁剪面，只由 systems.tightenClipPlanes 写。
 */
const HOME_POSE = {
  landscape: { position: [0, 40, 112] as [number, number, number], fov: 42 },
  portrait: { position: [0, 86, 172] as [number, number, number], fov: 56 },
};

function homePose(width: number, height: number) {
  return height > width ? HOME_POSE.portrait : HOME_POSE.landscape;
}

function homeVector(width: number, height: number, out: THREE.Vector3) {
  out.set(...homePose(width, height).position);
  return out;
}

function applyHome(camera: THREE.PerspectiveCamera, width: number, height: number) {
  const pose = homePose(width, height);
  camera.fov = pose.fov;
  camera.position.set(...pose.position);
  // near/far 不在这里写：唯一写入点是 tightenClipPlanes（它每帧、且在首帧渲染之前跑）
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * 星空（t32）：银河带 + 分层星点 + 极慢漂移。
 *
 * 为什么整片天空挂在一个**跟随相机**的 group 上：恒星在太阳系尺度内没有视差，
 * 相机怎么飞、星点的世界相对位置都不该变。改造前的星点撒在 180~450 世界单位处、
 * 不跟相机，所以镜头一动它们就整体平移（视差），看起来更像近处的灰而不是星空。
 * 现在：group.position 每帧跟相机，漂移只靠 group 自己的旋转。
 */
function Stars() {
  const camera = useThree((state) => state.camera);
  const starMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uTime: { value: 0 } },
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
      }),
    [],
  );
  const bandMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uNormal: { value: GALACTIC_NORMAL.clone() }, uOpacity: { value: BAND_OPACITY } },
        vertexShader: BAND_VERT,
        fragmentShader: BAND_FRAG,
      }),
    [],
  );
  const geo = useMemo(() => createStarGeometry(), []);
  // 天球只用来承载银河带：64×32 段足够让带子的亮度梯度平滑（噪声在顶点里算）
  const dome = useMemo(() => new THREE.SphereGeometry(SKY_RADIUS, 64, 32), []);
  const sky = useRef<THREE.Group>(null);
  useEffect(
    () => () => {
      geo.dispose();
      dome.dispose();
      starMat.dispose();
      bandMat.dispose();
    },
    [geo, dome, starMat, bandMat],
  );
  useFrame((state) => {
    const elapsed = state.clock.elapsedTime;
    starMat.uniforms.uTime!.value = elapsed;
    const g = sky.current;
    if (!g) return;
    // 天空跟着相机走（零视差）；漂移是天空自己的旋转，与相机无关
    g.position.copy(camera.position);
    g.rotation.y = elapsed * SKY_DRIFT_RAD_PER_S;
  });
  return (
    <group ref={sky}>
      <mesh geometry={dome} material={bandMat} raycast={() => null} frustumCulled={false} />
      <points geometry={geo} material={starMat} frustumCulled={false} />
    </group>
  );
}

function Simulation({ ready = true }: { ready?: boolean }) {
  const reg = useRegistry();
  // 星系从 context 读：默认还是现在这套太阳系，换星系时这里自动跟着换
  const { bodies, spec } = useSystem();
  // 观感/行为声明（R3）：这个系统要不要推进时间、要不要转，全看 look，不看 unit
  const look = spec.look;
  useFrame((_, raw) => {
    // 设备分流的唯一帧时间来源（1.2.0）：喂的是**未钳制**的 raw —— 钳过就看不见卡顿了
    noteFrame(raw * 1000);
    const delta = Math.min(raw, 0.1);
    /*
     * 时间只有一处推进（R4）：这一行是**唯一**的生产端；`look.freezesTime` 决定要不要推进。
     *
     * 改造前这件事写在消费端 —— 把米制系统的时间读成 0，生产端照跑，
     * 于是在实境待多久、回沙盘的模拟历就凭空跳过多久（实测在实境待 6.6 s → 模拟历 +174 日）。
     * 米制系统（实境 / ?proto=1）现在 freezesTime: true，时间就停在进入那一刻。
     */
    if (!look.freezesTime) useSim.getState().advanceSim(delta);
    /*
     * 其它一切都从这一份时间派生：公转、自转、云层、小行星带、太阳 uTime（clock.ts 的
     * simTimeNow）、HUD 历法（advanceSim 里写回 days）。这里不保留任何累加器 ——
     * 保留一个 useRef 就等于又开了一份真值。
     *
     * `look.spins` 管的是"这个系统的天体转不转"：冻结时间只让 t 不动（值停住），
     * 而"不写旋转"是另一件事 —— 星图那种系统时间照跑但不该转，两个开关必须分开。
     */
    const t = useSim.getState().simSeconds;
    for (const body of bodies) {
      const group = reg.groups.get(body.id);
      if (group && body.orbitRadius > 0) {
        const angle = (t / body.period) * Math.PI * 2 + body.phase;
        const lx = Math.cos(angle) * body.orbitRadius;
        const lz = Math.sin(angle) * body.orbitRadius;
        group.position.set(lx, Math.sin(body.inclination) * lz, Math.cos(body.inclination) * lz);
      }
      if (!look.spins) continue;
      const spin = reg.spins.get(body.id);
      if (spin) {
        const rate = body.locked ? (Math.PI * 2) / body.period : body.spin;
        spin.rotation.y = t * rate;
      }
      const clouds = reg.clouds.get(body.id);
      if (clouds) clouds.rotation.y = t * body.spin * 1.35;
    }
    if (look.spins && reg.belt) reg.belt.rotation.y = t * 0.015;
    // `ready` 要等启动分期挂满（第 3 期）：否则截图/验收可能拍到"还没有星空"的那一帧
    if (ready && !window.__solarReady) window.__solarReady = true;
  }, -3);
  return null;
}

function OrbitPath({ body, selected }: { body: Body; selected: boolean }) {
  /*
   * 轨道线不能穿过球面、也**不能出现可见的缺口**（t52 修正 t51 的回归）。
   *
   * 事实：`LineBasicMaterial` 默认 `depthTest: true`，球体不透明也写深度 —— 所以
   * "远侧被挡住 / 近侧可见"本来就已经成立。t51 想藏掉的其实是"近侧那半圈正好横穿盘面"，
   * 但它用 `setDrawRange` 硬切了一个缺口，玩家看到的是一条断线（回归）。
   *
   * 现在改成**逐顶点 alpha 淡出**（顶点色 vec4，alpha 参与混合）：
   * 环照常画整圈，只在天体参数位置两侧的淡出带里把 alpha 从 1 渐变到 0。
   * 为什么选这条而不是"按相机方向只处理近侧半圈"：后者要每帧判断"这段在不在近侧"，
   * 而环是天体自己的轨道、天体总在环上 —— 近侧判断会随相机抖动在阈值附近跳变，
   * 反而制造闪烁；alpha 淡出是纯连续的，没有判据可跳。
   * 代价：每帧重写 181 个顶点的 alpha（约 700 个 float），比 setDrawRange 贵一点点，
   * 但不需要新 shader program（t41 量过一个 program 首编译 20–40ms）。
   */
  const RING_SEGMENTS = 180;
  const line = useMemo(() => {
    const pts: number[] = [];
    const cols: number[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2;
      const lx = Math.cos(angle) * body.orbitRadius;
      const lz = Math.sin(angle) * body.orbitRadius;
      pts.push(lx, Math.sin(body.inclination) * lz, Math.cos(body.inclination) * lz);
      cols.push(1, 1, 1, 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    // itemSize 4 → three 自动开 USE_COLOR_ALPHA，vColor.a 参与片元输出
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
    geo.computeBoundingSphere();
    const mat = new THREE.LineBasicMaterial({
      color: selected ? "#e8edf4" : "#8b97a8",
      transparent: true,
      opacity: selected ? 0.9 : isMoon(body) ? 0.22 : 0.32,
      vertexColors: true,
      // 显式写出来：线要参与深度测试（被球体挡住）、但不写深度（避免遮挡后面的半透明）
      depthTest: true,
      depthWrite: false,
    });
    const mesh = new THREE.Line(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }, [body, selected]);
  // 淡出带（参数单位 = 角度/2π）：从 1.1 倍半径（贴面）到 1.6 倍半径（全亮）。
  // 带子必须窄：t51 的硬缺口看起来是"断线"，但带宽 2.2 倍半径又会让人以为线在半空中消失了。
  const fadeOuter = useMemo(
    () => Math.max(0.006, (body.radius * 1.6) / (body.orbitRadius * Math.PI * 2)),
    [body.radius, body.orbitRadius],
  );
  const fadeInner = fadeOuter * 0.69; // ≈ 1.1 倍半径处
  useFrame(() => {
    const attr = line.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    // 天体在环上的参数位置：与 Simulation 的相位公式同源（angle = t/period·2π + phase）
    const tParam = (((simTimeNow() / body.period + body.phase / (Math.PI * 2)) % 1) + 1) % 1;
    let changed = false;
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const p = i / RING_SEGMENTS;
      let d = Math.abs(p - tParam);
      if (d > 0.5) d = 1 - d; // 环是闭合的
      const t = Math.min(1, Math.max(0, (d - fadeInner) / Math.max(fadeOuter - fadeInner, 1e-6)));
      const a = t * t * (3 - 2 * t); // smoothstep：无折角，肉眼看不到"断开"
      if (Math.abs(arr[i * 4 + 3]! - a) > 0.01) {
        arr[i * 4 + 3] = a;
        changed = true;
      }
    }
    if (changed) attr.needsUpdate = true;
  });
  useEffect(
    () => () => {
      line.geometry.dispose();
      const material = line.material;
      if (!Array.isArray(material)) material.dispose();
    },
    [line],
  );
  return <primitive object={line} />;
}

function Atmosphere({ body }: { body: Body }) {
  const air = body.atmosphere;
  const mat = useMemo(() => {
    if (!air) return null;
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uColor: { value: new THREE.Vector3(air.color[0], air.color[1], air.color[2]) },
        uOpacity: { value: air.opacity },
      },
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
    });
  }, [air]);
  useEffect(() => () => mat?.dispose(), [mat]);
  if (!air || !mat) return null;
  return (
    <mesh scale={air.scale} raycast={() => null} material={mat}>
      <sphereGeometry args={[body.radius, 40, 28]} />
    </mesh>
  );
}

function Rings({ body }: { body: Body }) {
  const rings = body.rings;
  const mat = useMemo(() => {
    if (!rings) return null;
    return new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new THREE.Vector3(rings.color[0], rings.color[1], rings.color[2]) },
        uInner: { value: rings.inner },
        uOuter: { value: rings.outer },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
    });
  }, [rings]);
  useEffect(() => () => mat?.dispose(), [mat]);
  if (!rings || !mat) return null;
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} material={mat}>
      <ringGeometry args={[rings.inner, rings.outer, 160]} />
    </mesh>
  );
}

/*
 * 光标状态由 PickLayer 统一驱动（屏幕空间判定），不再由网格的 onPointerOver 触发。
 * 旧写法是逐 mesh 射线悬停：远处天体只有几像素，射线打不中 → 光标不出现，
 * 但点下去却有效（点击走的是 22px 热区）。"能点的范围"和"会变手型的范围"
 * 必须是同一个判定，否则就是这种时灵时不灵的错觉。
 */
function markPointer() {
  if (document.body.style.cursor !== "pointer") document.body.style.cursor = "pointer";
}

function clearPointer() {
  if (document.body.style.cursor) document.body.style.cursor = "";
}

function SunSurface({ body }: { body: Body }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        toneMapped: false,
        uniforms: { uTime: { value: 0 } },
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
      }),
    [],
  );
  const shell = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        uniforms: {
          uColor: { value: new THREE.Vector3(1, 0.72, 0.32) },
          uOpacity: { value: 0.95 },
        },
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
      }),
    [],
  );
  const sprite = useMemo(() => {
    const material = new THREE.SpriteMaterial({
      map: glowTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      /*
       * 必须 depthTest：这是日冕光晕层，尺寸 11× 太阳半径，中心正好压在太阳圆心。
       * 以前写 `depthTest: false`（"光晕永远盖在最上面"），结果**隔着木星也能看到那颗亮核** ——
       * 天体把它挡住时，深度测试是唯一能把它裁掉的东西。
       * 打开之后：盖住太阳本体的那部分被太阳球面自己挡掉（本来就该如此，那里是光球不是日冕），
       * 落在盘面之外的光晕照常透出；被前方天体挡住的整块也一起没了（t42 bug 1）。
       */
      depthTest: true,
      toneMapped: false,
      opacity: 0.72,
    });
    const s = new THREE.Sprite(material);
    s.scale.set(11, 11, 1);
    s.raycast = () => {};
    return s;
  }, []);
  useEffect(
    () => () => {
      mat.dispose();
      shell.dispose();
      sprite.material.dispose();
    },
    [mat, shell, sprite],
  );
  useFrame(() => {
    mat.uniforms.uTime!.value = simTimeNow();
  });
  return (
    <group>
      <primitive object={sprite} />
      <mesh material={mat}>
        <sphereGeometry args={[body.radius, 64, 48]} />
      </mesh>
      <mesh material={shell} scale={1.55} raycast={() => null}>
        <sphereGeometry args={[body.radius, 40, 28]} />
      </mesh>
    </group>
  );
}

function PlanetSurface({ body }: { body: Body }) {
  const reg = useRegistry();
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  // 观感声明（R3）：云层壳、球面细分都由 look 决定，不再看 unit
  const { spec } = useSystem();
  const look = spec.look;
  /*
   * 贴图不是 useMemo 里同步算出来的，而是一个有生命周期的句柄：
   * 拿到的第一张可能是 1×1 占位色（程序化贴图还没轮到）或摄影贴图，
   * 之后尺寸随「这颗星在屏幕上占多少设备像素」升档，好了走 onChange 换 uniform。
   * 预算与分帧的取舍写在 textures.ts 的 textureBudget / pump 注释里。
   */
  const map = useMemo(() => acquirePlanetTexture(body), [body]);
  /*
   * 解析遮挡的候选（t47）：**母天体 + 自己的卫星**。
   * 沙盘里会真的互相挡光的只有这几对（地球↔月球、木星↔四颗伽利略卫星、土星↔土卫六）；
   * 行星之间在压缩比例下几乎不可能挡上，所以不把 15 个天体全塞进 uniform ——
   * 每多一个候选就是每片元多一轮距离/cross 运算，SwiftShader 上那是实打实的填充成本。
   */
  const { byId, bodies } = useSystem();
  const occluders = useMemo(() => {
    const list: Body[] = [];
    const parent = body.parent ? byId[body.parent] : undefined;
    if (parent) list.push(parent);
    for (const b of bodies) if (b.parent === body.id) list.push(b);
    /*
     * ⚠ 太阳**不能**当遮挡体：每颗行星的 parent 都是太阳，而"太阳挡住太阳自己"
     * 在公式里会算出 cover = 1（两个圆盘同心）—— 第一次接上时整片行星全黑、
     * proto-real 的均值从 12.1 掉到 8.26、proto-jitter 直接采不到样本。
     * 恒星是光源，不是遮挡物，这里按 texture 标记排除（两个系统都标 "sun"）。
     */
    return list.filter((b) => b.id !== body.id && b.texture !== "sun").slice(0, 4);
  }, [body, byId, bodies]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        toneMapped: false,
        uniforms: {
          uMap: { value: map.texture },
          uSunCenter: { value: new THREE.Vector3() },
          uSunRadius: { value: 3.8 },
          uOcc: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
          uOccR: { value: [0, 0, 0, 0] as number[] },
          uOccCount: { value: 0 },
        },
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
      }),
    [map],
  );
  // 实境原型里不挂云层：它是半径 1.02× 的半透明壳，片元按 alpha discard，轮廓是碎的。
  // 像素回读找"背景→圆盘"边缘时会锁在云斑而不是球面轮廓上，
  // 实测把现代路径的残余噪声从 0.1 px 抬到 0.6 px，正好盖住要测的东西。
  const clouds = body.texture === "earth" && look.clouds;
  const cloudMap = useMemo(() => (clouds ? acquireCloudTexture() : null), [clouds]);
  const cloudMat = useMemo(() => {
    if (!cloudMap) return null;
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uMap: { value: cloudMap.texture } },
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
    });
  }, [cloudMap]);
  // 贴图升档时只换 uniform 的值，不重建材质、不触发 React 重渲染：
  // 材质住在这个组件的生命周期里，重建一次就丢一次 GPU 程序。
  useEffect(() => {
    const off = map.onChange((tex) => {
      mat.uniforms.uMap!.value = tex;
    });
    const offCloud = cloudMap
      ? cloudMap.onChange((tex) => {
          if (cloudMat) cloudMat.uniforms.uMap!.value = tex;
        })
      : () => {};
    return () => {
      off();
      offCloud();
    };
  }, [map, cloudMap, mat, cloudMat]);
  /*
   * 每 10 帧量一次屏幕占幅，把「这颗星此刻要多大贴图」告诉调度器（只升不降）。
   *
   * 为什么量实际投影、而不是按设备档位或固定视距查表：视距是相机自由度的函数
   * （总览 38 px 的木星，用户滚轮两下就能拉到占满屏），档位是静态的，
   * 用静态表必然二选一：要么首屏为没发生的放大付钱，要么放大后糊。
   */
  const tick = useRef(0);
  const planPos = useMemo(() => new THREE.Vector3(), []);
  /*
   * 每帧把遮挡体搬进**观察空间**（t47）：和 vPos 同一套坐标，片元里就不用做大数相减 ——
   * 实境（1e11 m）下这一步是必须的，否则 float32 会把遮挡体抖到别处去。
   */
  const occScratch = useMemo(() => ({ v: new THREE.Vector3(), sun: new THREE.Vector3() }), []);
  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const u = mat.uniforms;
    const inv = camera.matrixWorldInverse;
    // 太阳中心 = 世界原点
    u.uSunCenter!.value.copy(occScratch.sun.set(0, 0, 0)).applyMatrix4(inv);
    u.uSunRadius!.value = byId.sun?.radius ?? 3.8;
    let count = 0;
    for (const occ of occluders) {
      const g = reg.groups.get(occ.id);
      if (!g) continue;
      g.getWorldPosition(occScratch.v);
      occScratch.v.applyMatrix4(inv);
      (u.uOcc!.value as THREE.Vector3[])[count]!.copy(occScratch.v);
      (u.uOccR!.value as number[])[count] = occ.radius;
      count++;
    }
    u.uOccCount!.value = count;
  });
  useFrame(() => {
    const n = tick.current++;
    if (n !== 0 && n % 10 !== 0) return;
    const group = reg.groups.get(body.id);
    if (!group) return;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    group.getWorldPosition(planPos);
    const dist = camera.position.distanceTo(planPos);
    // 相机进到球体内部时这颗星本来就画不出来（正面被剔除），不必为它生成大图
    if (dist <= body.radius * 1.001) return;
    // 焦距与拾取器同源（pick.ts 的 focalPx）：贴图档位和点击热区必须按同一份投影算
    const focal = focalPx(size.height, camera.fov);
    const radiusCss = focal * Math.tan(Math.asin(Math.min(0.999, body.radius / dist)));
    // 贴图预算按**设备**像素算：视网膜屏上同一颗球有更多物理像素要糊
    const devicePx = Math.min(4096, 2 * radiusCss * gl.getPixelRatio());
    if (!Number.isFinite(devicePx)) return;
    // 占幅决定「该多大」，档位只封顶（quality.ts 的 texCap）——两件事别混
    const cap = texCap();
    map.plan(devicePx, cap);
    cloudMap?.plan(devicePx, cap);
  });
  useEffect(
    () => () => {
      mat.dispose();
      cloudMat?.dispose();
      map.release();
      cloudMap?.release();
    },
    [mat, cloudMat, map, cloudMap],
  );
  /*
   * 实境原型（米）下把球面细分拉高。原因不是好看，是测量：
   * 屏幕上的轮廓是一个多面体而不是圆，弦高 = r·(1−cos(π/N))。
   * N=56、r=530 px 时弦高 0.83 px，相机一转，哪一圈顶点落在轮廓上就在换，
   * 轮廓的亚像素形状跟着抖 —— 这个抖动（实测 0.4 px）和要测的 float32 抖动
   * （同视距下 1.2 px）是同一个量级，会直接盖住信号。
   * 拉到 128 段后弦高降到 0.16 px，信噪比才够。
   */
  const hiFi = look.refineGeometry;
  const seg = hiFi ? 128 : body.radius > 1.4 ? 56 : body.radius > 0.4 ? 40 : 24;
  return (
    <>
      <mesh material={mat}>
        <sphereGeometry args={[body.radius, seg, Math.max(16, Math.round(seg * 0.7))]} />
      </mesh>
      {cloudMat && (
        <group
          ref={(node) => {
            if (node) reg.clouds.set(body.id, node);
            else reg.clouds.delete(body.id);
          }}
        >
          <mesh material={cloudMat} raycast={() => null}>
            <sphereGeometry args={[body.radius * 1.02, hiFi ? 128 : 40, hiFi ? 64 : 28]} />
          </mesh>
        </group>
      )}
    </>
  );
}

/*
 * 这里原本有一个 `SelectionRing`：选中天体时在黄道面上画一个 torus
 * （半径 1.72×天体半径、管径 3%、72 段）。已删除。
 *
 * 判断它"不该存在"的理由，按分量排序：
 * 1. **它和真实行星环长得一样。** 木星被选中时那圈白环，与画面右上角天王星
 *    自带的真环（data.ts 里 uranus.rings）在几何上是同一个东西；土星更是自带
 *    两圈。一个"选中提示"长得像天体物理特征，是让玩家误读，不是提示。
 * 2. **它是冗余的。** 选中状态已经有三处在说：详情卡弹出、芯片行高亮、
 *    标签转强调色（`.star-label.is-selected`）。
 * 3. **它横切画面。** torus 固定在黄道面上，相机飞近后它必然以一个大椭圆
 *    穿过视野，看起来像场景里的几何而不是 UI。
 *
 * 所以不是"太粗太亮"的问题，是这个视觉语汇本身选错了：选择态应该用
 * 界面语汇（标签/卡片/芯片），不该用几何体。
 */

function BodyNode({
  body,
  showOrbits,
  showLabels,
  selectedId,
}: {
  body: Body;
  showOrbits: boolean;
  showLabels: boolean;
  selectedId: string | null;
}) {
  const reg = useRegistry();
  const { byParent } = useSystem();
  const kids = byParent.get(body.id) ?? [];
  const selected = selectedId === body.id;
  // 卫星标签只在被选中时出现：全显示的话木星四颗卫星的名字会叠成一团。
  // 卫星靠 HUD 里的卫星芯片行来选择/辨认。
  return (
    <group
      ref={(node) => {
        if (node) reg.groups.set(body.id, node);
        else reg.groups.delete(body.id);
      }}
    >
      <group rotation={[0, 0, body.obliquity]}>
        <group
          ref={(node) => {
            if (node) reg.spins.set(body.id, node);
            else reg.spins.delete(body.id);
          }}
        >
          {body.texture === "sun" ? <SunSurface body={body} /> : <PlanetSurface body={body} />}
        </group>
        <Rings body={body} />
      </group>
      {/* 热区已经挪到屏幕空间（见 pick.ts）：这里不再画那个世界空间的透明球壳 */}
      {body.texture !== "sun" && <Atmosphere body={body} />}
      {kids.map((kid) => (
        <group key={kid.id}>
          {showOrbits && <OrbitPath body={kid} selected={selectedId === kid.id} />}
          <BodyNode body={kid} showOrbits={showOrbits} showLabels={showLabels} selectedId={selectedId} />
        </group>
      ))}
    </group>
  );
}

/*
 * 标签层：自己管 DOM，不用 drei 的 <Html>。
 *
 * 为什么换掉：drei 的 <Html> 给每个标签开一个 React portal，切系统时 15 个标签
 * 在同一帧卸载，portal 的清理和 React 的 commit 抢同一个节点，抛
 * `removeChild: not a child of this node`。那是未捕获异常，会污染控制台，
 * 也就让"零控制台报错"这条验收不再可信。
 *
 * 这里改成一个常驻容器 + 一批常驻 span：React 只负责容器本身挂载一次，
 * 之后每帧直接写 transform。切系统时没有任何节点被卸载，也就没有可抢的东西。
 * 顺带省掉 15 个 portal 和它们的 context —— 这是净减，不是净增。
 */
type LabelNode = { el: HTMLSpanElement; text: string; selected: boolean };

function Labels() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const reg = useRegistry();
  const { bodies, spec } = useSystem();
  const look = spec.look;
  const showLabels = useSim((state) => state.showLabels);
  const selectedId = useSim((state) => state.selectedId);

  const host = useRef<HTMLDivElement | null>(null);
  const pool = useRef(new Map<string, LabelNode>());
  const world = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (!parent) return;
    const el = document.createElement("div");
    // z-index:1 —— 黑场覆盖层是 2，标号必须被它盖住
    el.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;contain:layout paint";
    el.dataset.labelLayer = "1";
    parent.appendChild(el);
    host.current = el;
    const nodes = pool.current;
    return () => {
      el.remove();
      host.current = null;
      nodes.clear();
    };
  }, [gl]);

  useFrame(() => {
    const el = host.current;
    if (!el) return;
    const persp = camera as THREE.PerspectiveCamera;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w < 2 || h < 2) return;
    // 标签投影的焦距与拾取器同源（pick.ts 的 focalPx）——以前这里自己写了一份
    const focal = focalPx(h, persp.fov);
    const nodes = pool.current;
    // baseOn = HUD 的开关 且 这个系统声明了 look.labels；选中的那颗不受它管（见下面 `on` 的
    // 定义），卫星则一律不给标签 —— 沙盘里会叠成一团
    const baseOn = showLabels && look.labels;

    /*
     * 先回收这一帧不在系统里的旧节点。
     * 切系统时 bodies 从 15 个变成 3 个，循环只遍历新 bodies，旧标签节点
     * 就永远留在容器里 —— 实境画面上会飘着"木星/海王星/土星"这些沙盘的名字。
     */
    const alive = new Set(bodies.map((b) => b.id));
    for (const [key, node] of nodes) {
      if (alive.has(key)) continue;
      node.el.remove();
      nodes.delete(key);
    }

    for (const body of bodies) {
      const group = reg.groups.get(body.id);
      const on = Boolean(group) && (selectedId === body.id || (baseOn && !isMoon(body)));
      const key = body.id;
      let node = nodes.get(key);
      if (!on) {
        if (node) node.el.style.display = "none";
        continue;
      }
      if (!node) {
        const span = document.createElement("span");
        span.className = "star-label";
        // .star-label 本身没有定位：以前是 drei 的 Html 外层容器负责绝对定位，
        // 现在直接给元素定位，transform 才是它的位移而不是偏移。
        span.style.cssText = "position:absolute;left:0;top:0;will-change:transform";
        el.appendChild(span);
        node = { el: span, text: "", selected: false };
        nodes.set(key, node);
      }
      const selected = selectedId === body.id;
      if (node.text !== body.name) {
        node.el.textContent = body.name;
        node.text = body.name;
      }
      if (node.selected !== selected) {
        node.el.className = selected ? "star-label is-selected" : "star-label";
        node.selected = selected;
      }
      group!.getWorldPosition(world);
      // 标签挂在球顶：偏移量随天体半径走，和以前 <Html position={[0, y, 0]}> 一致
      world.y += body.texture === "sun" ? body.radius * 2.15 : body.radius * 1.85;
      world.project(camera);
      const behind = world.z > 1;
      const x = (world.x * 0.5 + 0.5) * w;
      const y = (-world.y * 0.5 + 0.5) * h;
      if (behind || x < -200 || x > w + 200 || y < -80 || y > h + 80) {
        node.el.style.display = "none";
        continue;
      }
      node.el.style.display = "";
      node.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      // focal 只用来给将来的最小字号做参考，先留着免得未使用告警
      void focal;
    }
  });

  return null;
}

/**
 * 小行星带（t42 bug 2）。
 *
 * 压缩比例把互相不该碰的两件事挤到了一起：带子铺在 23.2~26.8，木星在 32、木卫四轨道 6.15 →
 * 木卫四的公转轨道内缘（25.85）正好从带子外缘扫过，石头就从卫星身上穿过去了。真实太阳系里
 * 小行星带 2.1–3.3 AU、木星 5.2 AU，根本不相交 —— 所以**不改物理，只让重叠不像穿模**。
 *
 * 选「按到最近天体的距离淡出」，不选另外两条方向：
 *  - 「局部挖洞（不生成）」做不到：带子整体在自转（0.015 rad/s），行星公转更快，洞必须在
 *    世界坐标里跟着行星走，静态洞是错的；而"动态挖洞"和"淡出"是同一份计算，淡出还不用重建几何。
 *  - 「压扁高度」治不了根：木卫四的轨道倾斜很小，本来就和带子几乎共面，压扁只会让重叠更整齐。
 *
 * 实现走 CPU 改实例矩阵（缩放到 0），**不新增 shader program** —— t41 量过：SwiftShader 上
 * 每个新 program 首编译 20–40ms，为一个视觉细节付这个启动成本不划算。
 * 每 2 帧算一次：带子自转 0.015 rad/s、行星角速度也慢，两帧的位移远小于淡出带宽（0.8~1.8）。
 */
const BELT_FADE = { near: 0.8, far: 1.8 } as const;

function Asteroids() {
  const reg = useRegistry();
  const { bodies } = useSystem();
  const mesh = useRef<THREE.InstancedMesh>(null);
  const fade = useRef(new Float32Array(520).fill(1));
  const tick = useRef(0);
  const rocks = useMemo(() => {
    let s = 99;
    const rand = () => {
      s = (s * 48271) % 2147483647;
      return (s - 1) / 2147483646;
    };
    return Array.from({ length: 520 }, () => {
      const angle = rand() * Math.PI * 2;
      const radius = 23.2 + rand() * 3.6;
      const tilt = (rand() - 0.5) * 0.22;
      const lx = Math.cos(angle) * radius;
      const lz = Math.sin(angle) * radius;
      return {
        x: lx,
        y: Math.sin(tilt) * lz * 0.35 + (rand() - 0.5) * 0.45,
        z: Math.cos(tilt) * lz,
        s: 0.035 + rand() * 0.07,
        rx: rand() * Math.PI,
        ry: rand() * Math.PI,
        rz: rand() * Math.PI,
        shade: 0.45 + rand() * 0.4,
      };
    });
  }, []);
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: "#ffffff" }), []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useLayoutEffect(() => {
    const current = mesh.current;
    if (!current) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    rocks.forEach((rock, index) => {
      dummy.position.set(rock.x, rock.y, rock.z);
      dummy.rotation.set(rock.rx, rock.ry, rock.rz);
      dummy.scale.setScalar(rock.s);
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);
      color.setRGB(rock.shade, rock.shade * 0.95, rock.shade * 0.86);
      current.setColorAt(index, color);
    });
    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor) current.instanceColor.needsUpdate = true;
  }, [rocks]);
  /*
   * 每 2 帧按「到最近天体的距离」把小行星缩到 0（=淡出），让石头不穿过行星与卫星。
   * 位置换算：带子整体只绕 Y 自转（Simulation 里写的 reg.belt.rotation.y），
   * 所以世界坐标 = 绕 Y 转 rot 后的局部坐标，不必每颗去 getWorldPosition。
   */
  const scratch = useMemo(
    () => ({
      dummy: new THREE.Object3D(),
      bodyPos: new THREE.Vector3(),
      pts: [] as { x: number; y: number; z: number; near: number; far: number }[],
    }),
    [],
  );
  useFrame(() => {
    const current = mesh.current;
    const belt = reg.belt;
    if (!current || !belt) return;
    if (tick.current++ % 2 !== 0) return;
    // 天体世界坐标 + 各自的淡出带宽（半径越大，清出的空域越大）
    const pts = scratch.pts;
    pts.length = 0;
    for (const b of bodies) {
      const g = reg.groups.get(b.id);
      if (!g) continue;
      g.getWorldPosition(scratch.bodyPos);
      const near = Math.max(BELT_FADE.near, b.radius * 1.2);
      const far = Math.max(BELT_FADE.far, b.radius * 2.6);
      pts.push({ x: scratch.bodyPos.x, y: scratch.bodyPos.y, z: scratch.bodyPos.z, near, far });
    }
    if (!pts.length) return;
    const rot = belt.rotation.y;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const fadeArr = fade.current;
    let changed = false;
    for (let i = 0; i < rocks.length; i++) {
      const rock = rocks[i]!;
      // 局部 (x,z) 绕 Y 转 rot → 世界
      const wx = rock.x * cos + rock.z * sin;
      const wz = -rock.x * sin + rock.z * cos;
      let k = 1;
      for (const p of pts) {
        const dx = wx - p.x;
        const dy = rock.y - p.y;
        const dz = wz - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < p.far) {
          const t = (d - p.near) / (p.far - p.near);
          const f = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
          if (f < k) k = f;
          if (k === 0) break;
        }
      }
      if (Math.abs(fadeArr[i]! - k) < 0.02) continue;
      fadeArr[i] = k;
      changed = true;
      scratch.dummy.position.set(rock.x, rock.y, rock.z);
      scratch.dummy.rotation.set(rock.rx, rock.ry, rock.rz);
      scratch.dummy.scale.setScalar(rock.s * k);
      scratch.dummy.updateMatrix();
      current.setMatrixAt(i, scratch.dummy.matrix);
    }
    if (changed) current.instanceMatrix.needsUpdate = true;
  });
  /*
   * 验收探针（t42 bug 2）：任意一颗小行星到任意天体的最近距离，以及当前淡出中的颗数。
   * 判据：改前最近距离 ~0.1（能穿进卫星），改后应 ≥ 最近天体自己的近带（约 0.8）。
   * 只有被点开时才现算，不参与每帧。
   */
  useEffect(() => {
    const probe = () => {
      const belt = reg.belt;
      if (!belt) return null;
      const rot = belt.rotation.y;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const pts: { x: number; y: number; z: number }[] = [];
      const pos = new THREE.Vector3();
      for (const b of bodies) {
        const g = reg.groups.get(b.id);
        if (!g) continue;
        g.getWorldPosition(pos);
        pts.push({ x: pos.x, y: pos.y, z: pos.z });
      }
      let min = Infinity;
      let minVisible = Infinity;
      let faded = 0;
      for (let i = 0; i < rocks.length; i++) {
        const rock = rocks[i]!;
        const wx = rock.x * cos + rock.z * sin;
        const wz = -rock.x * sin + rock.z * cos;
        let dRock = Infinity;
        for (const p of pts) {
          const dx = wx - p.x;
          const dy = rock.y - p.y;
          const dz = wz - p.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < dRock) dRock = d;
        }
        if (dRock < min) min = dRock;
        const k = fade.current[i]!;
        if (k < 0.99) faded++;
        // 判据看的是**看得见的**石头：淡到 0.5 以下的已经不构成"石头穿过星星"
        if (k > 0.5 && dRock < minVisible) minVisible = dRock;
      }
      return {
        count: rocks.length,
        minBodyDist: +min.toFixed(3),
        minVisibleBodyDist: Number.isFinite(minVisible) ? +minVisible.toFixed(3) : Infinity,
        faded,
      };
    };
    (window as unknown as { __solarBelt?: typeof probe }).__solarBelt = probe;
  }, [bodies, reg, rocks]);
  return (
    <group
      ref={(node) => {
        reg.belt = node;
      }}
    >
      <instancedMesh ref={mesh} args={[geometry, material, rocks.length]} frustumCulled={false} raycast={() => undefined}>
      </instancedMesh>
    </group>
  );
}

const TRAIL_POINTS = 90;

/**
 * 行星尾迹。调研了 13 个同类开源项目，没有一个把动态尾迹做进主线，
 * 但它对「看见公转」的帮助比静态轨道线大得多：轨道线是标尺，尾迹是走过的路。
 * 记录的是世界坐标，所以不会随行星自转打螺旋。
 */
function Trail({ id, color, visible }: { id: string; color: string; visible: boolean }) {
  const reg = useRegistry();
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    g.setDrawRange(0, 0);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.26, depthWrite: false });
    const l = new THREE.Line(g, m);
    l.frustumCulled = false;
    return l;
  }, [color]);
  const filled = useRef(0);
  const cursor = useMemo(() => new THREE.Vector3(), []);

  useEffect(
    () => () => {
      line.geometry.dispose();
      const material = line.material;
      if (!Array.isArray(material)) material.dispose();
    },
    [line],
  );

  // 关掉开关就清空，避免关着的时候攒出一条没意义的旧轨迹
  useEffect(() => {
    if (visible) return;
    filled.current = 0;
    line.geometry.setDrawRange(0, 0);
  }, [visible, line]);

  useFrame(() => {
    if (!visible) return;
    const obj = reg.groups.get(id);
    if (!obj) return;
    obj.getWorldPosition(cursor);
    const geometry = line.geometry;
    const attr = geometry.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;

    if (filled.current === 0) {
      arr[0] = cursor.x;
      arr[1] = cursor.y;
      arr[2] = cursor.z;
      filled.current = 1;
    } else {
      const i = (filled.current - 1) * 3;
      // 位移太小就不记点，否则 90 个点全堆在同一处，看着像一团
      const moved =
        Math.abs(arr[i]! - cursor.x) + Math.abs(arr[i + 1]! - cursor.y) + Math.abs(arr[i + 2]! - cursor.z);
      if (moved < 0.06) return;
      if (filled.current < TRAIL_POINTS) {
        arr[filled.current * 3] = cursor.x;
        arr[filled.current * 3 + 1] = cursor.y;
        arr[filled.current * 3 + 2] = cursor.z;
        filled.current += 1;
      } else {
        arr.copyWithin(0, 3);
        arr[(TRAIL_POINTS - 1) * 3] = cursor.x;
        arr[(TRAIL_POINTS - 1) * 3 + 1] = cursor.y;
        arr[(TRAIL_POINTS - 1) * 3 + 2] = cursor.z;
      }
    }
    attr.needsUpdate = true;
    geometry.setDrawRange(0, filled.current);
  });

  return <primitive object={line} />;
}

function Trails() {
  const showTrails = useSim((state) => state.showTrails);
  const { bodies } = useSystem();
  const planets = useMemo(() => bodies.filter((body) => body.parent === "sun" && body.orbitRadius > 0), [bodies]);
  return (
    <group>
      {planets.map((body) => (
        <Trail key={body.id} id={body.id} color={body.swatch} visible={showTrails} />
      ))}
    </group>
  );
}

/**
 * 控制权恢复的唯一入口。
 *
 * 调用点只有两个，都是「切换/动画刚结束」：
 *   1) 沙盘聚焦动画走到 u>=1（此时 store 可能已放锁，也可能自己顺手放）；
 *   2) switching 变成 null 那一下，而当前没有动画在跑（SandboxCamera 里的 effect）。
 *
 * 第 2 条就是 R9 要求显式化的那条不变式。旧代码把它隐含成「回沙盘必然伴随一次
 * resetToken 动画」—— 只要这个前提被打破（动画没起来、目标天体已不在系统里、
 * 回调被别的切换打断），controls.enabled 就再也没人打开，从实境回来视角永久拖不动。
 * store 的 armSwitchTimeout(1500ms) 保证 switching 一定回到 null，所以第 2 条一定可达。
 */
function releaseControls(controls: OrbitControlsImpl) {
  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enabled = true;
}

/** 「从实境切回沙盘」时占住 appliedKey 的哨兵：真实 key 永远是 `${id}|${token}`，撞不上。 */
const RETURNING_KEY = "←from-real";

/**
 * 米制相机（实境 / ?proto=1）：每帧独占相机，机位由 frameEarthMoon（或抖动夹具的固定机位）
 * 直接算出来，不接受用户拖拽 —— `controls.enabled` 每帧强制 false。
 *
 * 为什么必须是独立组件：它和沙盘那台 OrbitControls 相机是两套完全不同的东西，
 * 共享 anim/appliedKey 只会逼出「谁该把共享 ref 补写成真话」这类补丁。现在谁挂载谁负责，
 * 卸载就是卸载 —— 不存在跨模式的状态残留。（旧 CameraRig 里米制分支最后那两行
 * `appliedKey.current = …; appliedMode.current = mode;` 就是为此存在的。）
 */
function MeterCamera({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const { byId, spec } = useSystem();
  const reg = useRegistry();
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const switching = useSim((state) => state.switching);
  /** 放锁只做一次，避免每帧调 finishSwitch */
  const released = useRef(false);
  const diagTick = useRef(0);
  const scratch = useMemo(
    () => ({
      pos: new THREE.Vector3(),
      dest: new THREE.Vector3(),
      target: new THREE.Vector3(),
      sunDir: new THREE.Vector3(),
      camDir: new THREE.Vector3(),
    }),
    [],
  );

  useFrame(() => {
    /*
     * 米制相机的放锁点 —— **放在所有判空之前**（captain 裁定 b）。
     *
     * 释放只该看一件事：还在不在切换里。它不该看「地球这颗天体在不在」「控件就绪没」——
     * 凡是能跳过这一段的分支，都是潜在的永久锁死：今天 earth 一定存在，但切星系、改数据、
     * 或者哪天地球改了 id，这段被跳过之后 `finishSwitch` 就只剩 store 的 1500ms 超时兜底，
     * 界面会卡在"锁着"的状态。旧代码里这段写在 `if (!earth) return` 之后，是那个隐患的源头。
     *
     * 放锁时机不变：这台相机没有过渡动画，位置一旦摆好，「动画结束」就等于「这一帧」。
     * 在这里放锁是安全的：这支每帧都重写 camera.position，OrbitControls 就算被放开
     * 也挪不动相机，不存在"黑幕里被拖歪"的窗口。黑场由壳层负责。
     */
    if (switching === "toReal" && !released.current) {
      released.current = true;
      useSim.getState().finishSwitch();
    } else if (switching === null) {
      released.current = false;
    }

    const controls = controlsRef.current;
    if (!controls) return;
    const earth = reg.groups.get("earth");
    if (!earth) return;
    // 这台相机每帧独占相机：OrbitControls 每帧 update() 会把相机拉回它自己的球坐标状态，
    // 必须关掉，否则手动摆放的机位会被覆盖。
    controls.enabled = false;
    earth.getWorldPosition(scratch.dest);
    let dist = PROTO_DIST;

    /*
     * 机位必须落在「地球→太阳」这个方向上，不能挂在世界固定角上。
     * 之前的写法用 performance.now()*0.0003 转方位角，而地球公转角速度是
     * 2π/18 = 0.349 rad/s —— 两者几乎同速，方位差被锁死在 ~0。
     * 结果相机永远停在地球背光侧（实测 toSun·toCam = −0.98），
     * 片元着色器的 shade 地板 0.08 把整颗球压到 RGB(2,3,5)，
     * 比清屏色 #07090e 还暗 —— 画面全黑的真正原因就在这里，
     * 不是相机没到位、不是天体没到位、也不是被 near/far 裁掉。
     *
     * 现在：相机站在地球与太阳之间（相位角 0），整面受光；再抬 12° 俯视一点，
     * 相位角 12° 时最远端点的 dot(N,L) = −sin12° = −0.21，
     * shade 仍有 0.25，整个轮廓都亮 —— 像素回读的遮罩才能量到真正的圆盘，
     * 而不是"受光的那一块"。
     *
     * 运动：绕「日向轴」滚转 ±10° 做慢摆，再叠 ±1% 的径向呼吸。
     * 绕日向轴转的好处是与太阳的夹角恒定，受光区域一点不变；纯径向呼吸虽然
     * 也不改受光，但误差几乎全落在视线方向上，投影上扫不出横向位移（实测对照
     * 组只差 0.05 px），必须有横向的三维位移才能把 float32 量化扫出来。
     */
    scratch.sunDir.copy(scratch.dest).negate().normalize();
    if (PROTO_HARNESS) {
      scratch.camDir.copy(scratch.sunDir);
      scratch.camDir.applyAxisAngle(perpAxis(scratch.sunDir), 0.2126); // 抬 12° 俯视
      // 绕「日向轴」滚转 ±10°：与太阳的夹角恒定，受光区域完全不变，
      // 但相机在三维里扫一个锥面，float32 的量化误差才会在屏幕横向扫出来。
      // 只做径向呼吸的话，误差几乎全落在视线方向上，投影上根本看不见。
      scratch.camDir.applyAxisAngle(scratch.sunDir, 0.17 * Math.sin(performance.now() * 0.0016));
      const breath = 1 + 0.01 * Math.sin(performance.now() * 0.00314);
      camera.position.copy(scratch.dest).addScaledVector(scratch.camDir, STILL ? dist : dist * breath);
      controls.target.copy(scratch.dest);
      camera.lookAt(scratch.dest);
    } else {
      /*
       * 实地取景：地月同框，站在日向一侧（太阳在相机背后，两颗都正面受光）。
       * 之前这里用的是「系统外缘 2.4 倍」的全景位，地球在 7.2e11 m 外只是亚像素 ——
       * 那不是实境，是一张星图。取景距离的推导见 systems.frameEarthMoon。
       */
      const moon = reg.groups.get("moon");
      const earthR = byId.earth?.radius ?? 6.371e6;
      if (moon) moon.getWorldPosition(scratch.pos);
      const pose = frameEarthMoon(
        { x: scratch.dest.x, y: scratch.dest.y, z: scratch.dest.z },
        moon ? { x: scratch.pos.x, y: scratch.pos.y, z: scratch.pos.z } : null,
        earthR,
      );
      dist = pose.dist;
      scratch.target.set(pose.target[0], pose.target[1], pose.target[2]);
      scratch.camDir.set(pose.dir[0], pose.dir[1], pose.dir[2]);
      camera.position.copy(scratch.target).addScaledVector(scratch.camDir, dist);
      controls.target.copy(scratch.target);
      camera.lookAt(scratch.target);
    }

    /*
     * far 必须覆盖整个系统，不能只按"到焦点"算。
     * 之前 far = max(1.25·d, 16384·near)：d=2.5e7 时上界只有 1.0e8，
     * 而月球在 3.6e8、太阳在 1.5e11 —— 两颗都在远平面之外，被视锥剔除，
     * 从来没有渲染过。探针只算屏幕投影不看裁剪面，所以"返回 3 个天体"
     * 一直是对的，而画面里只有一颗地球。
     *
     * 「必须可见集合」怎么取、余量多少，现在由 systems.farFloorFor 统一（R7）：
     * 米制与沙盘两个调用点走同一个契约，不再是一个传、一个不传。
     */
    tightenClipPlanes(
      camera as THREE.PerspectiveCamera,
      dist,
      farFloorFor(visibleExtents(reg, spec.bodies), camera.position),
    );

    if (DIAG && diagTick.current++ % 20 === 0) {
      const persp = camera as THREE.PerspectiveCamera;
      const ndc = scratch.dest.clone().project(camera);
      // 太阳（原点）→地球 与 地球→相机 两个单位向量的点积：>0 表示看着昼半球
      const toSun = scratch.sunDir;
      const toCam = camera.position.clone().sub(scratch.dest).normalize();
      const lit = toSun.dot(toCam);
      const ctx = gl.getContext();
      const bw = gl.domElement.width;
      const bh = gl.domElement.height;
      const px = new Uint8Array(4);
      ctx.readPixels(bw >> 1, bh >> 1, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
      console.log(
        "[proto]",
        JSON.stringify({
          camToEarth: camera.position.distanceTo(scratch.dest).toExponential(3),
          near: persp.near.toExponential(3),
          far: persp.far.toExponential(3),
          ndc: [ndc.x, ndc.y, ndc.z].map((n) => +n.toFixed(4)),
          draws: gl.info.render.calls,
          tris: gl.info.render.triangles,
          litFace: +lit.toFixed(4),
          centerRGBA: Array.from(px),
          legacy: LEGACY_SHADER,
        }),
      );
    }
  }, -2);

  return null;
}

/**
 * 缩放手感（t32）。
 *
 * 为什么不是"把 zoomSpeed 调大"就完事：总览到太阳特写是 50 倍，
 * 一格 3.5%（旧值 0.95^0.7）要 67 格；一格 14% 要 ~19 格；再加连续滚动加速才能压到 12 格以内。
 * 加速必须有上限、且停手就回落 —— 否则一次猛滚会直接穿进太阳里。
 */
/** 基准：0.95^2.94 ≈ 0.86，即一格 14%。 */
const ZOOM_SPEED_BASE = 2.94;
/** 连续滚动时的倍率上限（≈23%/格）。再快就不是缩放了，是瞬移。 */
const ZOOM_BOOST_MAX = 1.7;
/** 两次 wheel 间隔小于它才算"连续滚动"。 */
const ZOOM_ACCEL_WINDOW_MS = 400;
/** 每多一格加多少倍率。 */
const ZOOM_BOOST_STEP = 0.16;
/** 停手这么久就复位（验收要求"几百毫秒内"）。 */
const ZOOM_RESET_MS = 320;
/** 距天体中心的最小距离基数（世界单位，改造前就是 1.15）。 */
const MIN_DISTANCE_BASE = 1.15;
/** 再乘天体半径：1.2×半径 = 贴着表面但不进去。太阳 3.8 → 4.56。 */
const MIN_DISTANCE_RADIUS_FACTOR = 1.2;
/**
 * 渐进逼近的两个参数（t47）：`resistance = clamp(gap / (hardMin × SPAN), MIN, 1)`。
 * SPAN = 3 表示"离底线还有 3 个 hardMin 时阻力才开始明显"；MIN = 0.12 是最后一格的步长下限
 * （14% × 0.12 ≈ 1.7%/格，≈0.08 世界单位）。两个数都是手感值，不是物理量。
 */
const SOFT_APPROACH_SPAN = 3;
const SOFT_APPROACH_MIN = 0.12;

/**
 * 距 `controls.target` 最近的那颗天体的半径。
 *
 * 用途：把 OrbitControls 的 `minDistance` 从固定 1.15 改成"跟着目标走"——
 * 目标是太阳时下限是 1.2×3.8 = 4.56，谁也别想滚进球里；目标是 0.2 半径的小卫星时
 * 下限仍是基数 1.15，它 1.7 的聚焦距离才进得去。t18 踩过的"maxDistance 与长距离动画互撞"
 * 是另一条：动画期间 controls.enabled=false，钳制根本不参与。
 */
function nearestBodyRadius(reg: Registry, bodies: readonly Body[], target: THREE.Vector3): number {
  const p = new THREE.Vector3();
  let best = Infinity;
  let radius = 0;
  for (const b of bodies) {
    const g = reg.groups.get(b.id);
    if (!g) continue;
    g.getWorldPosition(p);
    const d = p.distanceTo(target);
    if (d < best) {
      best = d;
      radius = b.radius;
    }
  }
  return radius;
}

/**
 * 沙盘相机：OrbitControls 那一套（首次摆位、聚焦动画、跟随天体、总览回位、竖屏视野）。
 *
 * 只在沙盘系统挂载 —— 切进米制时它整个卸载（见 Scene 里的三元）。这是 R2 拆分的核心：
 * 两套相机不再共享 anim / appliedKey，也就没有"米制分支每帧把共享 ref 补写成真话"的补丁
 * （旧 CameraRig 里那一行 `appliedKey.current = …|${mode}` 就是）。
 */
function SandboxCamera({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const { byId, bodies } = useSystem();
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const reg = useRegistry();
  const selectedId = useSim((state) => state.selectedId);
  const resetToken = useSim((state) => state.resetToken);
  /*
   * 模式切换锁（store 层由 t12 立的 switching，1500ms 兜底）。
   * 禁拖拽/缩放只能在渲染层做 —— controls 在这儿，HUD 那边碰不到。
   * 放锁（finishSwitch）按 store 的契约只在相机动画结束时调用；超时兜底在 store 里。
   */
  const switching = useSim((state) => state.switching);
  /*
   * 从实境切回来的那一刻：store 的 setMode("sandbox") 同一拍置 switching="toSandbox"、
   * bump resetToken。此时本组件才被挂载，但相机还停在米制机位上（1e7~1e11 m 量级），
   * 它不是「首次进场」—— 不能 applyHome 瞬切，而要像老代码那样从这里起一次回归动画。
   * 做法：posed 直接初始化成 true、appliedKey 占一个不可能等于当帧 key 的哨兵，
   * 让下面常规的 key 比对分支走 startFocus（这也让 initial 判定为 false）。
   */
  const returning = useRef(useSim.getState().switching === "toSandbox").current;

  /*
   * 缩放加速状态（见文件上方 ZOOM_* 常量）：wheel 事件只更新这两个 ref，
   * 真正的 zoomSpeed / minDistance 每帧写进 controls —— 这样 drei 重渲染把 props 刷回来也不怕。
   */
  const zoomBoost = useRef(1);
  const lastWheelAt = useRef(-1e9);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = () => {
      const now = performance.now();
      const gap = now - lastWheelAt.current;
      lastWheelAt.current = now;
      // 连续滚动：倍率 +0.16，封顶 1.7；停手后由 useFrame 里复位
      zoomBoost.current =
        gap < ZOOM_ACCEL_WINDOW_MS ? Math.min(ZOOM_BOOST_MAX, zoomBoost.current + ZOOM_BOOST_STEP) : 1;
    };
    // passive：只观察，不拦 OrbitControls 自己的 wheel 处理
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl]);

  /*
   * 这里原本有一个 `dip()`：命令式 append 一层黑 div，再等一个 rAF 才把 opacity 设成 1。
   * 已删除，两个理由都不是"没用了"：
   *  1. 它是假黑场 —— append 后要等下一帧才全黑，所以换系统那次 commit 根本没被盖住，
   *     critic 判的就是这一条。
   *  2. 壳层现在有真正的常驻黑幕（App.tsx 侧，黑的那一支不挂 transition，
   *     实测 opacity=1 覆盖 52→310ms）。两套并存，后人会以为 dip 还在起作用。
   * 跨模式切换的视觉现在完全由壳层负责；渲染层只负责把相机摆到位、按时放锁。
   */
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // 用 state 而不是 ref：r3f 首帧尺寸是 0，摆好相机会发生在之后的一次渲染，
  // 注意力放在 ref 上时聚焦 effect 的依赖永远不变，等于永不重跑（深链就白选了）。
  const [posed, setPosed] = useState(returning);
  const anim = useRef<{
    t: number;
    dur: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    dir: THREE.Vector3;
    fromDist: number;
    toDist: number;
    toId: string | null;
    home: boolean;
  } | null>(null);
  const followId = useRef<string | null>(null);
  const prevPlanet = useRef(new THREE.Vector3());
  const diagTick = useRef(0);
  const scratch = useMemo(
    () => ({
      target: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      dest: new THREE.Vector3(),
      home: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      delta: new THREE.Vector3(),
    }),
    [],
  );

  /*
   * 首次摆位放在帧循环里做（见 useFrame）。放 layout effect 里不可靠：
   * <OrbitControls> 排在相机组件之后挂载，此时 ref 还是 null，
   * 而尺寸之后不再变化的话这个 effect 也不会重跑 —— posed 永远是 false，
   * 深链选中了却永远不聚焦，就是这么来的。
   */

  // 横竖屏切换时视野没重算：转屏后 fov 还停在竖屏的 56°，全景被裁掉一圈。
  // 只在总览状态重排，跟随某颗行星时不动镜头（否则用户转个屏就被踢回全景）。
  const portraitRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const portrait = size.height > size.width;
    const prev = portraitRef.current;
    portraitRef.current = portrait;
    if (prev === null || prev === portrait) return;
    const controls = controlsRef.current;
    if (!controls || anim.current || followId.current) return;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    applyHome(camera, size.width, size.height);
    controls.target.set(0, 0, 0);
    controls.update();
  }, [camera, controlsRef, size.height, size.width]);

  // 聚焦动画的触发点放进 useFrame，而不是 useEffect：
  // r3f 首帧尺寸为 0，controls 和「相机摆好」的先后在 effect 里不可靠 —— 换个时序就
  // 静默失效（深链选中了却不聚焦，就是这么来的）。每帧都能拿到最新 controls，稳。
  const wantId = useRef<string | null>(selectedId);
  wantId.current = selectedId;
  const wantReset = useRef(resetToken);
  wantReset.current = resetToken;
  const appliedKey = useRef<string | null>(returning ? RETURNING_KEY : null);

  const startFocus = (controls: OrbitControlsImpl, id: string | null) => {
    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const offset = fromPos.clone().sub(fromTarget);
    const fromDist = Math.max(offset.length(), 0.001);
    offset.multiplyScalar(1 / fromDist);
    const body = id ? byId[id] : undefined;
    /*
     * 中途换目标时 dur 缩短（t55 B2）。fromPos/fromTarget 本来就取"此刻"，位置连续；
     * 卡顿来自 `t=0` + easeInOut 的起点速度为 0 —— 等于在切换那一帧把镜头刹停。
     * 这一段更短，让那次"顿一下"短到看不出来。
     */
    const continuing = anim.current !== null;
    anim.current = {
      t: 0,
      dur: reduced ? 0.01 : continuing ? 0.55 : 0.95,
      fromPos,
      fromTarget,
      dir: offset,
      fromDist,
      toDist: body?.focus ?? 1,
      toId: id,
      home: !id,
    };
    followId.current = null;
    controls.enableRotate = false;
    controls.enableZoom = false;
    /*
     * 动画期间必须连 `enabled` 一起关。
     * OrbitControls 有距离夹取（`minDistance` 从 1.15 起、按目标天体半径抬到 1.2×，`maxDistance=280`）：
     * 相机一旦被动画带到 1e11 量级（实地机位），它的 update() 每帧都会把相机拽回 280 单位，
     * 和动画互相拉扯，最后停在半路。关掉 enabled 等于整套控件静音 —— 米制相机和沙盘相机
     * 都这么做（两套组件各自管自己的动画）；代价是切回来之后必须记得还原，否则视角永久拖不动。
     */
    controls.enabled = false;
  };

  /*
   * 切换结束（switching → null）时把控制权还回去 —— 这是 R9 那条不变式的第 2 条路径，
   * 也是「无动画时的恢复分支」：不管回归动画有没有起来，store 的 1500ms 兜底一定会
   * 把 switching 落回 null，于是这里一定会跑到。
   * 有动画在跑的话不在这里抢：那种情况由动画结束处（u>=1 那一支）负责恢复，
   * 两处都以 switching 为条件，谁先到都不会提前开锁。
   */
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    if (switching) {
      c.enableRotate = false;
      c.enableZoom = false;
    } else if (!anim.current) {
      releaseControls(c);
    }
  }, [switching, controlsRef]);

  /** 这里原本有一个 `startSwitchPose`…已删除（见 MeterCamera 的注释）。 */

  useFrame((_, raw) => {
    const controls = controlsRef.current;
    if (!controls) return;

    /*
     * 米制（实境 / ?proto=1）的相机摆位不在这里 —— 它搬进了 <MeterCamera>。
     * 那个组件只在自己挂载时存在，本组件只负责沙盘；两套相机不再共享 anim/appliedKey，
     * 所以这里不需要再"把共享 ref 说成真话"（旧的 appliedKey/appliedMode.upkeep 就是这么来的）。
     */

    /*
     * 缩放（t32）：每帧把倍率和最小距离写回控件。必须写在 drei 的 controls.update() 之前 ——
     * 本回调是 -2 优先级，它的 update 是 0，所以这一帧就生效。
     *  - 倍率 = 基准 × 连续滚动加速；停手 320ms 后复位（验收要求"几百毫秒内"）；
     *  - 最小距离 = max(1.15, 最近天体半径 × 1.2)：滚到底也钻不进太阳里（1.2×3.8 = 4.56），
     *    而 0.2 半径的小卫星下限仍是 1.15、它 1.7 的聚焦距离进得去。
     */
    if (performance.now() - lastWheelAt.current > ZOOM_RESET_MS) zoomBoost.current = 1;
    /*
     * 渐进逼近（t47）：越靠近天体，每一格的**步长**越小。
     *
     * 先说失败过的一版：把 `minDistance` 写成 `hardMin + gap×0.75` 想让钳制面跟着距离收缩。
     * 实测无效 —— OrbitControls 的 dolly 是"半径 ×= scale 再 clamp 到 minDistance"，
     * 一旦被 clamp 就正好落在 minDistance 上，下一帧 gap 归零，还是硬墙（实测最后 12 格距离
     * 一点没变，全停在 5.374）。
     *
     * 现在改从**倍率**下手：靠近时把 zoomSpeed 线性压到 15%，步长随距离一起衰减，
     * 于是画面越来越近、越来越慢，最后一格只走 0.09 个单位然后停住 —— 没有一下"跳开"。
     * `minDistance` 仍然是硬底线（1.2×半径），它只负责"不许穿进去"，不再负责手感。
     */
    const hardMin = Math.max(
      MIN_DISTANCE_BASE,
      nearestBodyRadius(reg, bodies, controls.target) * MIN_DISTANCE_RADIUS_FACTOR,
    );
    const gap = camera.position.distanceTo(controls.target) - hardMin;
    const resistance = Math.min(1, Math.max(SOFT_APPROACH_MIN, gap / (hardMin * SOFT_APPROACH_SPAN)));
    controls.zoomSpeed = ZOOM_SPEED_BASE * zoomBoost.current * resistance;
    controls.minDistance = hardMin;

    /*
     * 每帧按焦点距离收窄 near/far。和米制相机走同一个契约（R7）：far 的下界由
     * 「必须可见集合」算出，而不是靠"沙盘里最远的东西（星场 450 / 海王星 63）刚好
     * 落在 far 下限 819.2 以内"这个数据巧合 —— 加一圈柯伊伯带时 far 会跟着长，
     * 不会再静默裁掉。
     */
    tightenClipPlanes(
      camera as THREE.PerspectiveCamera,
      camera.position.distanceTo(controls.target),
      farFloorFor(visibleExtents(reg, bodies), camera.position),
    );

    if (DIAG && diagTick.current++ % 30 === 0) {
      console.log(
        "[sandbox]",
        JSON.stringify({
          cam: camera.position.toArray().map((n) => +n.toFixed(1)),
          target: controls.target.toArray().map((n) => +n.toFixed(1)),
          anim: anim.current ? +anim.current.t.toFixed(2) : null,
          enabled: controls.enabled,
          key: appliedKey.current,
        }),
      );
    }

    /*
     * 模式切换期间禁用拖拽/缩放。放在每帧最前面强制写一次，是因为 drei 的
     * <OrbitControls> 会在自身重渲染时按 props 把开关刷回默认值，只在 useEffect
     * 里设一次会被它盖掉。
     */
    if (switching) {
      controls.enableRotate = false;
      controls.enableZoom = false;
    }

    /*
     * 不变式（R9，只在 ?diag=1 下检查）：不在切换里、也没有动画在跑时，控制权必须是开的。
     * 它把旧代码里"回沙盘必然伴随一次 resetToken 动画，所以动画结束处一定能把 enabled
     * 打开"这个隐含前提变成可观测的：谁把恢复路径弄断了，下一帧就会在控制台看到这行。
     */
    if (DIAG && switching === null && !anim.current && !controls.enabled) {
      console.warn("[cam] 控制权没恢复：无切换、无动画，但 controls.enabled=false");
    }

    // 首次摆位：等控件和尺寸都就绪，在这里做才不会错过头
    if (!posed && sizeRef.current.width >= 2 && camera instanceof THREE.PerspectiveCamera) {
      applyHome(camera, sizeRef.current.width, sizeRef.current.height);
      controls.target.set(0, 0, 0);
      controls.update();
      setPosed(true);
    }

    /*
     * 选中变化（点芯片 / 深链 / 返回总览 / refocus）→ 起一次镜头动画。
     *
     * key 里**没有 mode**：切模式会让整个组件卸载再重挂（见 Scene 里的三元），重挂时
     * appliedKey 要么是 null（首次进场 → 直接 applyHome，不起动画），要么是 RETURNING_KEY
     * （从实境回来 → 起回归动画）。两种情况都已经把"要不要起动画"决定完了，不需要
     * 再拿 mode 当去重键 —— 旧代码之所以需要，正是因为两套相机共用一个组件、共享 ref。
     */
    const key = `${wantId.current ?? ""}|${wantReset.current}`;
    if (posed && appliedKey.current !== key) {
      const initial = appliedKey.current === null;
      appliedKey.current = key;
      // 黑场已挪到壳层（渲染层的 dip 已删）：这里只负责相机。
      // 进实境不在这里起动画（那台相机是 MeterCamera 的事）；从实境切回来则是
      // appliedKey = RETURNING_KEY（不是 null），所以 initial=false，照常起飞回动画。
      if (!initial) startFocus(controls, wantId.current);
    }

    const delta = Math.min(raw, 0.1);
    const current = anim.current;
    if (current) {
      current.t += delta;
      const u = easeInOut(Math.min(1, current.t / current.dur));
      if (current.home) {
        homeVector(sizeRef.current.width, sizeRef.current.height, scratch.home);
        scratch.target.lerpVectors(current.fromTarget, scratch.origin, u);
        scratch.pos.lerpVectors(current.fromPos, scratch.home, u);
      } else {
        const obj = current.toId ? reg.groups.get(current.toId) : undefined;
        if (obj) obj.getWorldPosition(scratch.dest);
        else scratch.dest.set(0, 0, 0);
        // 竖屏时详情卡是底部抽屉：把镜头目标下移，星球就被顶到上半屏
        if (sizeRef.current.height > sizeRef.current.width) {
          const fov = (camera as THREE.PerspectiveCamera).fov ?? 56;
          // 半高 = focalPx 的反解，和拾取器/标签用同一条 fov 约定（pick.ts 的 halfSpanAt）
          const halfHeight = halfSpanAt(current.toDist, fov);
          scratch.dest.y -= halfHeight * 0.55;
        }
        scratch.target.lerpVectors(current.fromTarget, scratch.dest, u);
        /*
         * 距离用**对数**插值（t55 B2）。
         *
         * 根因：屏幕上星球的视觉大小 ∝ 1/dist。线性插值 118 → 4.8 时，前 90% 的时间
         * dist 只从 118 掉到 16（球几乎没变大），最后 10% 才从 16 冲到 4.8 ——
         * 观感就是「先转过去，再突然放大」。取对数后每帧的视觉放大倍率恒定，
         * 缩放和朝向（由 target 平移带来的转动）从头到尾同步。
         */
        const dist = Math.exp(
          THREE.MathUtils.lerp(
            Math.log(Math.max(current.fromDist, 1e-3)),
            Math.log(Math.max(current.toDist, 1e-3)),
            u,
          ),
        );
        scratch.pos.copy(scratch.target).addScaledVector(current.dir, dist);
      }
      controls.target.copy(scratch.target);
      camera.position.copy(scratch.pos);
      /*
       * 朝向必须跟着走。
       *
       * 之前漏了这一步，表现就是用户报的"点总览先飞进深空再瞬切回总览"：
       * 相机被搬到 home 位置，但四元数还停在原来的朝向 —— 镜头一边飞一边看着别处，
       * 屏幕上就是空天区；等动画结束 `controls.enabled` 恢复、drei 的 update() 跑一拍，
       * 朝向才被瞬间掰正，于是"瞬切"。
       *
       * 为什么以前没暴露：startFocus 在 t18 才把 `controls.enabled` 关掉（为了不让
       * OrbitControls 的 maxDistance=280 夹取和长距离动画打架）。以前 update() 每帧都跑，
       * 顺带把朝向对准了 target，这个缺失被掩盖着。
       *
       * 现在动画期间由我们独占相机，就由我们负责朝向 —— 位置和朝向同一个进度 u，
       * 结束那一刻不会再有"对齐"动作。
       */
      camera.lookAt(scratch.target);
      if (DIAG) {
        // 诊断：动画期间相机朝向是否跟着目标走。
        // angle 大 = 镜头在"一边飞一边看着别处"，那就是"先飞进深空再瞬切"的成因。
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        const toTarget = scratch.target.clone().sub(camera.position).normalize();
        const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, fwd.dot(toTarget)))));
        console.log(
          "[anim]",
          JSON.stringify({
            u: +u.toFixed(2),
            pos: camera.position.toArray().map((n) => +n.toFixed(1)),
            target: scratch.target.toArray().map((n) => +n.toFixed(1)),
            lookOffDeg: +angle.toFixed(1),
            enabled: controls.enabled,
          }),
        );
      }
      if (u >= 1) {
        anim.current = null;
        /*
         * 恢复控制权时看 switching：切换动画刚走完但 store 还没放锁的那一帧，
         * 这里要是无脑写 true，就会出现"锁还没放、人已经能拖"的窗口。
         * 顺带按 store 的契约在这里放锁 —— finishSwitch 是 switching 的唯一释放点，
         * 超时兜底在 store 里（1500ms），不归这里。
         */
        const stillSwitching = useSim.getState().switching !== null;
        if (stillSwitching) {
          // 动画先于放锁结束：保持静音，放锁后由 switching effect 的无动画分支恢复。
          controls.enableRotate = false;
          controls.enableZoom = false;
          controls.enabled = false;
          useSim.getState().finishSwitch();
        } else {
          releaseControls(controls);
        }
        if (!current.home && current.toId) {
          followId.current = current.toId;
          const obj = reg.groups.get(current.toId);
          if (obj) obj.getWorldPosition(prevPlanet.current);
        } else {
          followId.current = null;
        }
      }
      return;
    }
    const id = followId.current;
    if (!id) return;
    const obj = reg.groups.get(id);
    if (!obj) return;
    obj.getWorldPosition(scratch.dest);
    scratch.delta.copy(scratch.dest).sub(prevPlanet.current);
    if (scratch.delta.lengthSq() < 1e-10) return;
    camera.position.add(scratch.delta);
    controls.target.add(scratch.delta);
    prevPlanet.current.copy(scratch.dest);

    /*
     * 跟随卫星时要躲开母天体。
     * 月球的 focus 是 1.7，而地球半径 0.76、地月距离 1.95 —— 相机贴在月球
     * 「朝地球那一侧」时离地心只有 1.95−1.7 = 0.25，直接钻进地球内部；
     * 球面背面被剔除，画面上整颗地球消失，最多 2.5 秒必现。
     * 跟随逻辑只做平移，不避让，所以这里补一次最小距离钳制。
     */
    clampOutsideParent(id);
  }, -2);

  /**
   * 把相机从母天体的球体里**滑**出来（t47 改了连续性）。
   *
   * 旧实现：一帧之内 `position = 母天体中心 + 方向 × minDist` —— 位置瞬移，而且推的方向是
   * 径向的，相机从球心哪一侧进去就从哪一侧弹出来，看起来像镜头被顶了一下。
   *
   * 现在：目标点仍是「球面上最近的那个点」（那就是"投影到球面"），但每帧只朝它走 35%：
   * 连续几帧内相机沿球面滑出去，不瞬移。取值 0.35 ≈ 3 帧走完 97%，
   * 在跟随卫星（相机每帧被母天体带着平移）时既跟得上，又不会跳。
   */
  function clampOutsideParent(id: string) {
    const parentId = byId[id]?.parent;
    if (!parentId) return;
    const pg = reg.groups.get(parentId);
    const pb = byId[parentId];
    if (!pg || !pb) return;
    pg.getWorldPosition(scratch.pos);
    // 余量 1.35×半径：贴到球面上，但别让近平面切进去
    const minDist = pb.radius * 1.35;
    scratch.delta.copy(camera.position).sub(scratch.pos);
    const len = scratch.delta.length();
    if (len >= minDist) return;
    if (len < 1e-6) scratch.delta.set(0, 1, 0);
    else scratch.delta.multiplyScalar(1 / len);
    // 球面目标点（径向投影 = 球面上离相机最近的点）
    scratch.pos.addScaledVector(scratch.delta, minDist);
    // 每帧只走剩余距离的 35%：连续滑出，不瞬移
    camera.position.lerp(scratch.pos, 0.35);
  }

  return null;
}

/**
 * 验收探针：把天体在屏幕上的投影暴露成纯函数，供 verify.mjs 做数值断言
 * （命中矩阵、跟随抖动）。只读、无副作用，生产环境也就是多挂一个全局函数。
 *
 * **投影只有一份实现**：这里直接调 pick.ts 的 projectCandidates()，与用户真正
 * 能点中的判定同源。改造前这里自己算一份线性近似 `radiusPx = R/d · focal`，
 * 和拾取器的精确式 `focal · tan(asin(min(1, R/d)))` 漂移 —— 实测（1280×720）
 * `?proto=1&dist=1e7` 的地球 600.32 px vs 781.39 px（+30.2%）；相机进到球体里
 * （dist=6e6 < 地球半径）时旧式给 999.67 px，而真实投影半径是无穷（整个屏幕都是它），
 * 差了 16 个数量级。验收量的必须是"用户遇到的那套判定"，所以它只能有一份数学。
 * 顺带拿到与拾取器一致的「相机背后剔除」——见下面 NaN 那一支。
 */
function Probe({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const reg = useRegistry();
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const gl = useThree((state) => state.gl);
  const { bodies, spec } = useSystem();

  useEffect(() => {
    const v = new THREE.Vector3();
    const probe = () => {
      // 先按 PickLayer 的同一种取数方式收集世界坐标，再交给拾取器的投影
      const picks: PickBody[] = [];
      for (const body of bodies) {
        const group = reg.groups.get(body.id);
        if (!group) continue;
        group.getWorldPosition(v);
        picks.push({ id: body.id, world: v.clone(), radius: body.radius });
      }
      const candidates = projectCandidates(camera as THREE.PerspectiveCamera, size.width, size.height, picks);
      const byId = new Map(candidates.map((c) => [c.id, c]));

      const projected: { id: string; x: number; y: number; z: number; radiusPx: number }[] = [];
      for (const body of bodies) {
        const group = reg.groups.get(body.id);
        if (!group) continue;
        const c = byId.get(body.id);
        if (!c) {
          /*
           * 相机背后：拾取器剔除它（点不中、也不该出手型）。但 __solarProbe 的
           * 对外契约是「系统里挂载了几个天体就返回几条」—— verify 的 hit-matrix
           * 数 15、proto-real 数 3，两条断言都不许动。所以这里保留一条记录，
           * 用 NaN 明确表示「没有屏幕位置」，而不是编造一份镜像坐标：后者正是
           * t13 修掉的幽灵热区（背后的天体被 project() 翻符号镜像回画面，
           * 看起来在屏幕上、点了却没反应）。
           */
          projected.push({ id: body.id, x: Number.NaN, y: Number.NaN, z: Number.NaN, radiusPx: 0 });
          continue;
        }
        // z 只为保持对外字段形状（verify 只读 x/y/id），仍由 three 的 project() 得出；
        // 它不参与任何判定，所以不是第二份"判定数学"。
        group.getWorldPosition(v);
        v.project(camera);
        projected.push({ id: body.id, x: c.x, y: c.y, z: v.z, radiusPx: c.radiusPx });
      }
      return projected;
    };
    (window as unknown as { __solarProbe?: typeof probe }).__solarProbe = probe;
    /*
     * 裁剪面探针。`__solarProbe` 只算屏幕投影、不看 near/far，所以它能
     * 「返回 3 个天体」而画面上只有一颗地球 —— 那正是 t17 抓到的阻断项。
     * 这个钩子让验收能直接读 far，证明太阳/月球没有落在远平面之外。
     */
    const clip = () => {
      const p = camera as THREE.PerspectiveCamera;
      return { near: p.near, far: p.far };
    };
    (window as unknown as { __solarClip?: typeof clip }).__solarClip = clip;

    /*
     * 贴图预算探针：启动时每张程序化贴图多大、总像素多少、还有几个任务在排队。
     * 它要证明的是两件事 ——「启动期只付总览档的钱」和「放大后真的升了档」，
     * 不是"每个像素都对"（那要截图）。摄影贴图（地球/月球）不参与预算，不在报告里。
     */
    const textures = () => textureReport();
    (window as unknown as { __solarTextures?: typeof textures }).__solarTextures = textures;

    /*
     * 设备分流探针（1.2.0）：当前档位 / 触发原因 / 变化次数 / 阈值 / 历史。
     * GPU 字符串只在这条路径里露面（诊断用），**不参与分档** —— 分档只看指针类型 + 视口宽。
     */
    installQualityProbe();
    const renderer = gl.getContext().getParameter(gl.getContext().RENDERER);
    if (typeof renderer === "string") noteGpu(renderer);

    /*
     * 时间钩子（R4）：读模拟钟 / 拨模拟钟的稳定入口。
     * 真值在 store.simSeconds，这里只是转发、不持有任何状态 —— 将来的"改时间"UI
     * 直接调 store.setSimTime，这个钩子是给验收和现场排查用的（跟 __solarProbe 一路货）。
     */
    const timeApi = {
      /** 模拟秒（唯一真值） */
      now: () => useSim.getState().simSeconds,
      /** HUD 历法的显示缓存（= daysOf(simSeconds)） */
      days: () => useSim.getState().days,
      /** number = 模拟秒；Date = 以 SIM_EPOCH 为 t=0 换算 */
      set: (when: number | Date) => useSim.getState().setSimTime(when),
      /** 自转角度（弧度）：证明"自转也跟着同一份时间走"（= simSeconds × spin 速率） */
      spin: (id: string) => reg.spins.get(id)?.rotation.y ?? null,
    };
    (window as unknown as { __solarTime?: typeof timeApi }).__solarTime = timeApi;

    /*
     * 观感声明探针（R3）：当前系统实际生效的 look，外加"真的挂上了没"的旁证
     * （云层分组数量、小行星带在不在）。它是这一条重构的验收口径：
     * 换系统时只改数据，这里读到的组合应当自动跟着变，不需要任何代码分支。
     */
    const lookApi = () => ({
      ...spec.look,
      mounted: { clouds: reg.clouds.size, belt: Boolean(reg.belt) },
    });
    (window as unknown as { __solarLook?: typeof lookApi }).__solarLook = lookApi;

    /*
     * 相机探针（t47）：只读，但给的东西比"一个距离"多 —— 相机到 target、最近天体是谁/多远、
     * 相机自身位置与 fov。为什么必须加：`__solarClip` 只暴露 near/far，而用屏幕半径反推距离
     * 在 R/d > 0.707 时会饱和（asin 里 clamp 到 0.999999），5.37 以内永远测不准 ——
     * 验收"渐进逼近"时正是那一段。
     */
    const cameraApi = () => {
      const persp = camera as THREE.PerspectiveCamera;
      const target = controlsRef.current?.target ?? null;
      const p = new THREE.Vector3();
      let nearest: { id: string; dist: number } | null = null;
      for (const b of bodies) {
        const g = reg.groups.get(b.id);
        if (!g) continue;
        g.getWorldPosition(p);
        const d = camera.position.distanceTo(p);
        if (!nearest || d < nearest.dist) nearest = { id: b.id, dist: +d.toFixed(5) };
      }
      return {
        target: target ? [+target.x.toFixed(4), +target.y.toFixed(4), +target.z.toFixed(4)] : null,
        distTarget: target ? +camera.position.distanceTo(target).toFixed(5) : null,
        nearest,
        pos: [+camera.position.x.toFixed(4), +camera.position.y.toFixed(4), +camera.position.z.toFixed(4)],
        fov: persp.fov,
      };
    };
    (window as unknown as { __solarCamera?: typeof cameraApi }).__solarCamera = cameraApi;

    /*
     * 像素回读采样器：整个 draw buffer 读回来，用「与清屏色的偏差」当遮罩，
     * 算亮斑的水平质心。为什么不是别的做法：
     *
     *  - 不用亮度的绝对值：地球有昼夜面，片元着色器的 shade 地板是 0.08，
     *    夜面亮度比清屏色 #07090e 还低，绝对亮度阈值会把夜面判成背景。
     *    「偏离背景」这个判据对光照免疫，只认轮廓。
     *  - 不用单行扫描线找边缘：地球在 1e7 m 处直径约 1195 px，纵向早被视口裁掉了，
     *    单行只能保证找到左右边；而质心法对裁切免疫——纵向裁切是上下对称的，
     *    不会把水平质心带偏。
     *  - 不用 probe 的 JS 投影：探针算的是 double 结果，看不见顶点着色器里的
     *    float32 量化。这正是 t7 报的那个 2.51 px 抖动测不出来的原因。
     *
     * 返回 null 表示这一帧没有可分辨的亮斑（还没渲染 / 全黑），调用方应按失败处理。
     */
    const pixels = (radiusPx?: number) => {
      // 没开 preserveDrawingBuffer 时绘制缓冲在合成后即失效，读回来是空的。
      // 与其返回一个看似有效的假数据，不如直接说"这个模式下测不了"。
      if (!READBACK) return null;
      const ctx = gl.getContext();
      const W = gl.domElement.width;
      const H = gl.domElement.height;
      const buf = new Uint8Array(W * H * 4);
      ctx.readPixels(0, 0, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      /*
       * 背景色不能写死 #07090e。渲染器的 outputColorSpace 是 sRGB，setClearColor
       * 传进去的 sRGB 值会先转成线性工作空间再进缓冲。所以背景色从四个角落的
       * 4×4 块里量，量到什么算什么（实测 8.94）。
       */
      const lumAt = (x: number, y: number) => {
        const i = (y * W + x) * 4;
        return 0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!;
      };
      let bg = 0;
      let bgN = 0;
      for (const [ox, oy] of [
        [0, 0],
        [W - 4, 0],
        [0, H - 4],
        [W - 4, H - 4],
      ] as const) {
        for (let y = oy; y < oy + 4; y++) for (let x = ox; x < ox + 4; x++) bg += lumAt(x, y);
        bgN += 16;
      }
      bg /= bgN;
      const EPS = 1;

      /*
       * 为什么量「边缘」而不是「质心」：
       * 二值遮罩的质心会被"活到阈值以上"的面积带偏 —— 圆盘左缘那片深海
       * （线性反照率 0.003，乘上边缘 0.38 的 shade 后落在输出 8/255，正好等于背景 8.9）
       * 会整块掉出遮罩，质心因此系统性右移 0.6% 画宽，并且随相机滚转来回摆。
       * 实测：圆盘左右缘的中点稳定在 640，而质心在 648 —— 差 8 px。
       *
       * 边缘法对这件事免疫：只找"背景 → 圆盘"的那一次跃变。
       * 再用多行平均压噪声：float32 量化带来的位移是全画面相干的（每行一起动），
       * 纹理造成的边缘抖动是各行独立的，平均 9 行能压掉 sqrt(9)=3 倍。
       */
      const edgeAt = (y: number, fromLeft: boolean) => {
        const lum = (x: number) => lumAt(x, y);
        let x0 = -1;
        if (fromLeft) {
          for (let x = 2; x < W - 2; x++)
            if (lum(x) > bg + 6) {
              x0 = x;
              break;
            }
        } else {
          for (let x = W - 3; x > 1; x--)
            if (lum(x) > bg + 6) {
              x0 = x;
              break;
            }
        }
        if (x0 < 0) return null;
        // 局部峰值当参考，阈值取半高：边缘亮度随贴图变化，绝对阈值会跟着漂
        const a0 = fromLeft ? x0 : Math.max(0, x0 - 48);
        const a1 = fromLeft ? Math.min(W - 1, x0 + 48) : x0;
        let peak = -1;
        for (let x = a0; x <= a1; x++) peak = Math.max(peak, lum(x));
        if (peak < bg + 12) return null;
        const thr = bg + (peak - bg) * 0.5;
        // 左缘是「背景→圆盘」的上升沿，右缘是「圆盘→背景」的下降沿（内测在外侧），
        // 两边方向相反，判据必须分开写
        const lo = Math.max(1, x0 - 8);
        const hi = Math.min(W - 2, x0 + 8);
        for (let x = lo; x <= hi; x++) {
          const a = lum(x);
          const b = lum(x + 1);
          if (fromLeft && a < thr && b >= thr) return x + (thr - a) / (b - a);
          if (!fromLeft && a >= thr && b < thr) return x + (a - thr) / (a - b);
        }
        return null;
      };

      /*
       * 取左右两缘的中点，不取单边：
       * 单边位置 = 圆心 − 半径，而相机在径向呼吸（±1%），半径就有 ±6 px 的变化，
       * 单边量出来的"抖动"全是呼吸，跟浮点无关（实测单边 16 px）。
       * 中点对缩放免疫：两缘同步外扩/内收，中点不动。
       */
      let sumC = 0;
      let rows = 0;
      const radiusSamples: number[] = [];
      /*
       * 用「关于画面水平中线对称的两个行」取平均再求中点。
       * 球面是按纬度环细分的，非中心行的弦中点落在球轴投影上，而球轴在画面里
       * 会随相机滚转转动 —— 直接把 9 行中点一平均，会混进 0.4 px 的假抖动
       * （实测：相机钉死 0.075 px，滚转起来 0.41 px，差值全来自这一阶）。
       * 对称行对的球轴偏移大小相等方向相反，先配对平均就能把它消掉。
       */
      for (let k = 0; k <= 4; k++) {
        const off = Math.round((k * H) / 24);
        const ys = off === 0 ? [Math.round(H / 2)] : [Math.round(H / 2 - off), Math.round(H / 2 + off)];
        const mids: number[] = [];
        for (const y of ys) {
          if (y < 1 || y > H - 2) continue;
          const l = edgeAt(y, true);
          const r = edgeAt(y, false);
          if (l === null || r === null || r - l < W * 0.1) continue;
          mids.push((l + r) / 2);
          radiusSamples.push((r - l) / 2);
        }
        if (!mids.length) continue;
        sumC += mids.reduce((a, b) => a + b, 0) / mids.length;
        rows++;
      }
      if (!rows) {
        // 诊断：一行都没量到时把中间行的亮度剖面吐出来，避免"静默返回 null"查不动
        const yMid = Math.round(H / 2);
        const probeRow: number[] = [];
        for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 32))) probeRow.push(+lumAt(x, yMid).toFixed(1));
        return {
          x: Number.NaN,
          y: 0,
          rows: 0,
          width: W,
          height: H,
          bg: +bg.toFixed(2),
          pixels: 0,
          probeRow,
        } as never;
      }
      const centerX = sumC / rows;
      const radiusPxMeasured = radiusSamples.length
        ? radiusSamples.reduce((a, b) => a + b, 0) / radiusSamples.length
        : 0;

      // 兜底的全画面质心（诊断用，不参与断言）
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          if (Math.abs(lumAt(x, y) - bg) > EPS) {
            sx += x;
            sy += y;
            n++;
          }
        }
      }
      return {
        x: centerX,
        y: n ? sy / n : 0,
        rows,
        radiusPx: +radiusPxMeasured.toFixed(2),
        probeRadiusPx: radiusPx ?? null,
        pixels: n * 4,
        width: W,
        height: H,
        bg: +bg.toFixed(2),
      };
    };
    (window as unknown as { __solarPixels?: typeof pixels }).__solarPixels = pixels;

    return () => {
      delete (window as unknown as { __solarProbe?: typeof probe }).__solarProbe;
      delete (window as unknown as { __solarPixels?: typeof pixels }).__solarPixels;
      delete (window as unknown as { __solarClip?: typeof clip }).__solarClip;
      delete (window as unknown as { __solarTextures?: typeof textures }).__solarTextures;
      delete (window as unknown as { __solarTime?: typeof timeApi }).__solarTime;
      delete (window as unknown as { __solarLook?: typeof lookApi }).__solarLook;
      delete (window as unknown as { __solarCamera?: typeof cameraApi }).__solarCamera;
    };
  }, [reg, camera, gl, bodies, size.height, size.width, controlsRef]);

  return null;
}

/**
 * 屏幕空间拾取层。
 *
 * 天体身上已经没有任何 onClick —— 命中判断全在这里：指针抬起时把天体投影成
 * 屏幕候选，按 t8 §4 的全序选一个。好处是它对单位体系、比例 ρ、模式全无感，
 * 也不会像世界空间球壳那样在实境里退化成 0.12 米。
 *
 * 仍然是「点击时才算」，不是每帧算：15 次投影几微秒，没必要进帧循环。
 */
function PickLayer() {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const reg = useRegistry();
  const { bodies } = useSystem();

  useEffect(() => {
    const el = gl.domElement;
    const tmp = new THREE.Vector3();

    const collect = (): PickBody[] => {
      const out: PickBody[] = [];
      for (const b of bodies) {
        const g = reg.groups.get(b.id);
        if (!g) continue;
        g.getWorldPosition(tmp);
        out.push({
          id: b.id,
          world: tmp.clone(),
          radius: b.radius,
          rings: b.rings,
          /*
           * 环平面的世界法线。环几何在 XY 平面，mesh 再转 [π/2,0,0]，
           * 外层 group 再绕 Z 转 obliquity —— 合成结果就是下面这行。
           * 少了它，pick 只能把环当正圆环，斜视时会把整片天空和邻居的热区一起吞掉。
           */
          ringNormal: b.rings
            ? new THREE.Vector3(Math.sin(b.obliquity), -Math.cos(b.obliquity), 0)
            : undefined,
        });
      }
      return out;
    };

    const candidates = () => {
      const rect = el.getBoundingClientRect();
      return projectCandidates(camera as THREE.PerspectiveCamera, rect.width, rect.height, collect());
    };

    const onUp = (ev: PointerEvent) => {
      // 拖拽视角松手会落一个 pointerup，位移超过阈值就当没点（沿用 dragGuard）
      if (dragGuard.moved) return;
      // 切换动画期间不受理选择：store 会把选择排进 queuedSelectId，这里再挡一层
      if (useSim.getState().switching) return;
      const rect = el.getBoundingClientRect();
      const id = resolvePick(candidates(), ev.clientX - rect.left, ev.clientY - rect.top);
      if (id) useSim.getState().select(id);
    };

    el.addEventListener("pointerup", onUp);

    /*
     * 光标与点击共用同一个判定。
     *
     * 旧写法问题：光标由逐 mesh 的 `onPointerOver`（R3F 射线打真实网格）驱动，
     * 点击走屏幕空间的 22px 热区。远处天体只有一两像素，射线打不中 → 光标不出现，
     * 可是点下去照样选中 —— "能点的范围"和"会变手型的范围"不是同一个，用户看到的就是
     * 时灵时不灵。
     *
     * 现在：pointermove 只记坐标，真正的判定摊到下一个 rAF 里做一次。
     * 这样高频移动不会每个事件都投影一遍（15 个天体一次投影是微秒级，但没必要乘以事件率）。
     */
    let hoverX = 0;
    let hoverY = 0;
    let hoverRaf = 0;

    const runHover = () => {
      hoverRaf = 0;
      // 拖拽中不显示手型：那是在转视角，不是在瞄准
      if (dragGuard.active && dragGuard.moved) {
        clearPointer();
        return;
      }
      const id = resolvePick(candidates(), hoverX, hoverY);
      if (id) markPointer();
      else clearPointer();
    };

    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      hoverX = ev.clientX - rect.left;
      hoverY = ev.clientY - rect.top;
      if (dragGuard.active && dragGuard.moved) {
        if (hoverRaf) {
          cancelAnimationFrame(hoverRaf);
          hoverRaf = 0;
        }
        clearPointer();
        return;
      }
      if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
    };

    const onLeave = () => {
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      clearPointer();
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    // 验收钩子：坐标 → 命中 id、全量候选、热区半径
    const api = {
      at: (px: number, py: number) => resolvePick(candidates(), px, py),
      candidates,
      hotRadius: HOT_RADIUS_CSS,
    };
    (window as unknown as { __solarPick?: typeof api }).__solarPick = api;

    return () => {
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      delete (window as unknown as { __solarPick?: typeof api }).__solarPick;
    };
  }, [camera, gl, reg, bodies]);

  return null;
}

/*
 * ?trace=1：逐帧记录相机位置 / 目标 / 朝向偏差，用来做「相机层重构前后行为等价」的对照。
 *
 * 为什么不是 ?diag=1：diag 的沙盘遥测每 30 帧才打一次，米制分支只打「到地球多远」不打机位，
 * 拆组件那种逐帧比对根本不够用。这里只读、不改变任何相机行为，正常路径上一次分支就返回。
 *
 * `window.__camPhase` 由外部夹具在每次交互前写一个阶段标签（临时脚本里做的事），
 * trace 顺带记下来，比对时按阶段切片即可 —— 两次运行的动画帧数本来就不同，按索引硬对没意义。
 */
const TRACE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("trace");
const TRACE_LIMIT = 4096;

type CamTraceEntry = { ph: string; t: number; mode: string; p: number[]; tg: number[]; a: number };

function traceCam(mode: string, camera: THREE.Camera, target: THREE.Vector3 | null) {
  if (!TRACE) return;
  const w = window as unknown as { __camTrace?: CamTraceEntry[]; __camPhase?: string };
  const list = (w.__camTrace ??= []);
  if (list.length >= TRACE_LIMIT) return;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  let angle = 0;
  if (target) {
    const toTarget = target.clone().sub(camera.position).normalize();
    angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, fwd.dot(toTarget)))));
  }
  list.push({
    ph: w.__camPhase ?? "",
    t: +performance.now().toFixed(1),
    mode,
    p: [camera.position.x, camera.position.y, camera.position.z],
    tg: target ? [target.x, target.y, target.z] : [Number.NaN, Number.NaN, Number.NaN],
    a: +angle.toFixed(3),
  });
}

/**
 * 相机轨迹记录器。优先级 -1：排在相机组件（-2）之后跑，量到的是当帧最终机位。
 *
 * ⚠ **负数只影响回调顺序；正数会把渲染权一起拿走。** r3f 里任何 `useFrame(cb, priority > 0)`
 * 的订阅都会给 `internal.priority` 加一，而渲染循环只在它为零时才 `gl.render(...)` ——
 * 也就是"谁要手动渲染谁自己画"的开关，不是"谁先谁后"的排序参数。
 * （`@react-three/fiber/dist/events-e51d7528.esm.js:1312` 累加；`:17537` 判零。）
 * 我第一版在这里写了 `10`，结果整个场景一笔没画：相机数据、探针、贴图、HUD 全正常，
 * 屏幕上只有 HUD —— 正是 verifier 在 `?proto=1&diag=1` 里看到的 `draws: 0, tris: 0`，
 * 而当时 8 条 verify 全绿。诊断组件不该有拿走渲染权的权力，所以这里只允许 ≤0。
 * 改这个数字之前先想清楚：你在决定"谁来渲染这一帧"。
 */
function CamTrace({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const camera = useThree((state) => state.camera);
  const { spec } = useSystem();
  // 轨迹里的 mode 标签就是相机型号（sandbox / meter），不另造一套判断
  const cameraKind = spec.look.camera;
  useFrame(() => {
    traceCam(cameraKind, camera, controlsRef.current?.target ?? null);
  }, -1);
  return null;
}

/**
 * 启动分期（1.2.0 / t41）。
 *
 * 为什么：SwiftShader 上首帧要编译约 10 个 shader，实测一个长期任务 280~485ms；
 * `?proto=1`（不挂装饰、没有程序化贴图）同机启动段 0 次 >50ms 卡顿 —— 说明大头是
 * 装饰体的首编译，不是贴图（贴图 t24 已切到 106,496 px 并分帧）。
 *
 * 做法：**只改出现顺序，不删东西**。第 1 帧就有太阳、行星、轨道线、标签（用户看到的仍是
 * 完整太阳系），星空/银河带放第 2 帧，小行星带与尾迹放第 3 帧，把首编译摊到三帧。
 * 每帧一次的 rAF 推进，不做超时兜底：rAF 不跑说明页面根本不可见，那时推迟也无害。
 *
 * `?bootstage=1|2|3` 是诊断覆盖（1=只有太阳行星，2=加星空，3=全量=默认），
 * 用来量每一期各自的编译成本。
 */
/**
 * `?bootstage=1|2|3` 是诊断覆盖：**钉住**开局期数（不再往后长），用来量每一期各自的编译成本。
 * 不带参数时开局 1 期、随后每帧长一期。
 */
const BOOT_STAGE_FULL = 3;

function pinnedBootStage(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("bootstage");
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > BOOT_STAGE_FULL) {
    if (typeof console !== "undefined") console.log(`[boot] ?bootstage=${raw} 无效（1..${BOOT_STAGE_FULL}），走默认分期`);
    return null;
  }
  if (typeof console !== "undefined") console.log(`[boot] ?bootstage=${n} → 钉在第 ${n} 期（诊断用，不往后长）`);
  return n;
}

function Scene() {
  const showOrbits = useSim((state) => state.showOrbits);
  const showLabels = useSim((state) => state.showLabels);
  const selectedId = useSim((state) => state.selectedId);  const registry = useRef<Registry>({
    groups: new Map(),
    spins: new Map(),
    clouds: new Map(),
    belt: null,
  });
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const camera = useThree((state) => state.camera);
  const { byId, spec } = useSystem();
  // 观感声明（R3）：装饰、轨道线、标签、用哪台相机，全部由系统的 look 决定
  const look = spec.look;
  /*
   * 启动分期：开局先只有太阳/行星（stage 1），随后每帧加一期，把首编译摊开。
   * `?bootstage=` 可以钉住开局期数，量每一期的编译成本。
   */
  const pin = useRef(pinnedBootStage()).current;
  const [stage, setStage] = useState(() => pin ?? 1);
  useEffect(() => {
    if (pin !== null || stage >= BOOT_STAGE_FULL) return;
    const id = requestAnimationFrame(() => setStage((s) => Math.min(BOOT_STAGE_FULL, s + 1)));
    return () => cancelAnimationFrame(id);
  }, [pin, stage]);
  const sun = byId.sun;

  /*
   * `?diag=1` 专用：把相机摆到「某天体 + 距离 + 方位角」的机位（t47）。
   *
   * 为什么需要它：日食这类验收要一台"从晨昏线方向看日面"的机位，靠鼠标拖只能碰运气
   * （上一轮就栽在相机落在夜面）。但**这条能力不能进发布物**：默认路径里没有它，
   * 只有 `?diag=1` 才挂上，退出时删掉。摆位只改 camera.position 与 controls.target
   * （OrbitControls 每帧从 target 重新推导），所以 __solarReady / 探针都不受影响。
   *
   * 参数：place(id, dist, azimuthDeg, elevationDeg?)。
   *  - 方位角 0° = 从天体看向太阳的方向（相机站在天体朝日一侧，看得到受光面）；
   *  - 90° = 垂直那个方向的晨昏线侧。
   */
  useEffect(() => {
    if (!DIAG) return;
    const place = (id: string, dist: number, azimuthDeg: number, elevationDeg = 12) => {
      const g = registry.current.groups.get(id);
      const body = byId[id];
      const controls = controlsRef.current;
      if (!g || !body || !controls) return null;
      const center = new THREE.Vector3();
      g.getWorldPosition(center);
      // 天体 → 太阳 的方向（太阳在世界原点）
      const toSun = new THREE.Vector3().sub(center);
      if (toSun.lengthSq() < 1e-12) toSun.set(0, 0, 1);
      toSun.normalize();
      // 以 toSun 为 0° 方位，向上向量取世界 Y
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(toSun, up).normalize();
      if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
      const az = (azimuthDeg * Math.PI) / 180;
      const el = (elevationDeg * Math.PI) / 180;
      const dir = new THREE.Vector3()
        .addScaledVector(toSun, Math.cos(az) * Math.cos(el))
        .addScaledVector(right, Math.sin(az) * Math.cos(el))
        .addScaledVector(up, Math.sin(el))
        .normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      controls.target.copy(center);
      camera.lookAt(center);
      return { id, dist, azimuthDeg, elevationDeg, pos: camera.position.toArray().map((n) => +n.toFixed(3)) };
    };
    (window as unknown as { __solarPlace?: typeof place }).__solarPlace = place;
    return () => {
      delete (window as unknown as { __solarPlace?: typeof place }).__solarPlace;
    };
  }, [byId, camera]);

  if (!sun) return null;
  /*
   * 米制系统不挂沙盘装饰：星空、小行星带、尾迹的几何体都建在
   * 「离原点几十到几百」这个量级上，而米制系统里那个量级是"几十米"。
   * 更麻烦的是尾迹——它记录的是世界坐标（~1.5e11 m）且 frustumCulled=false，
   * 在 float32 下大数相减会把它画到屏幕上任意位置，像素回读的亮斑质心
   * 会被它拖走 10~18 px（proto 与 legacy 同样漂移，就是这个东西干的）。
   * 所以 REAL_PROTO 的 look.decor 是 false；这条判断不再看 unit。
   */
  return (
    <RegistryContext.Provider value={registry.current}>
      {/* 第 2 帧：星空 + 银河带（STAR / BAND 两个 program） */}
      {look.decor && stage >= 2 && <Stars />}
      <Probe controlsRef={controlsRef} />
      <PickLayer />
      <Labels />
      {/* ready 只有到全量才置位：验收与首帧截图看到的必须是完整场景（钉住期数时按期数算） */}
      <Simulation ready={pin !== null || stage >= BOOT_STAGE_FULL} />
      <BodyNode
        body={sun}
        showOrbits={showOrbits && look.orbitLines}
        showLabels={showLabels && look.labels}
        selectedId={selectedId}
      />
      {/* 第 3 帧：小行星带 + 尾迹（InstancedMesh / LineBasic 各自的 program） */}
      {look.decor && stage >= 3 && <Asteroids />}
      {look.decor && stage >= 3 && <Trails />}
      {/*
        相机由 look.camera 二选一挂载，不是运行时 if：米制与沙盘是两套完全不同的相机，
        同一时刻只有一台存在。这样切模式就等于「卸载一台 + 挂载另一台」，各自只在自己
        挂载时摆位 —— 不需要任何跨模式共享的状态，也就没有"谁该把 ref 补写成真话"。
        为什么不用 unit 判断：相机型号是「这个系统怎么被看」的属性，不是长度单位；
        2 代际的星图用世界单位，但它可能想要哪台相机是另一件事。
      */}
      {look.camera === "meter" ? (
        <MeterCamera controlsRef={controlsRef} />
      ) : (
        <SandboxCamera controlsRef={controlsRef} />
      )}
      <CamTrace controlsRef={controlsRef} />
      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableDamping
        dampingFactor={0.09}
        rotateSpeed={0.55}
        /*
         * zoomSpeed / minDistance 每帧由 SandboxCamera 重写（倍率要随连续滚动加速、
         * 最小距离要跟着目标天体半径走）。这里的值只是首帧的起点。
         * zoomToCursor：朝指针位置缩放，不用先把星球拖到画面中心再滚。
         */
        zoomSpeed={ZOOM_SPEED_BASE}
        zoomToCursor
        minDistance={MIN_DISTANCE_BASE}
        maxDistance={280}
        minPolarAngle={0.02}
        maxPolarAngle={Math.PI - 0.02}
      />
    </RegistryContext.Provider>
  );
}

export function SolarCanvas() {
  /*
   * 设备档位（1.2.0）：dpr 上限跟着档位走 —— 这是"每帧要光栅多少像素"的唯一旋钮。
   * 用 useSyncExternalStore 订阅：升/降档会让这里重渲染，r3f 才会真的 setDpr。
   * 红线：手机档 dprCap 1.25，任何档位都不会低于它（见 quality.ts 的 TIERS）。
   */
  const tier = useQualityTier();
  return (
    <Canvas
      className="space-canvas"
      dpr={[1, tier.dprCap]}
      /*
       * 只给它 home 的位置和视场，两个数都来自 HOME_POSE（唯一出处）。
       * 这里**不写 near/far**：那两笔是死配置 —— 首帧渲染发生在 useFrame 之后，
       * 而相机组件在 useFrame 里就已经把裁剪面算好了（systems.tightenClipPlanes）。
       */
      camera={{ position: HOME_POSE.landscape.position, fov: HOME_POSE.landscape.fov }}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: READBACK }}
      onPointerDown={(event) => {
        dragGuard.x = event.clientX;
        dragGuard.y = event.clientY;
        dragGuard.moved = false;
        dragGuard.active = true;
      }}
      onPointerMove={(event) => {
        if (!dragGuard.active || dragGuard.moved) return;
        if (Math.hypot(event.clientX - dragGuard.x, event.clientY - dragGuard.y) > DRAG_THRESHOLD) {
          dragGuard.moved = true;
        }
      }}
      onPointerUp={() => {
        dragGuard.active = false;
      }}
      onCreated={({ gl }) => {
        gl.setClearColor("#07090e", 1);
      }}
    >
      <Scene />
    </Canvas>
  );
}
