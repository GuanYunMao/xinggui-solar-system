import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simClock } from "./clock";
import { EARTH_PERIOD, isMoon, type Body } from "./data";
import { useSim } from "./store";
import { useSystem } from "./system-context";
import { tightenClipPlanes } from "./systems";
import { cloudTexture, glowTexture, textureFor } from "./textures";

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
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vPos;
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    if (texel.a < 0.05) discard;
    vec3 N = normalize(vN);
    // 太阳在世界原点，投到观察空间再算方向（同样避开大数相减）
    vec3 sunView = (viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 L = normalize(sunView - vPos);
    float shade = clamp(dot(N, L) * 0.62 + 0.38, 0.08, 1.0);
    vec3 V = normalize(-vPos);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = texel.rgb * shade + texel.rgb * rim * 0.16;
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
    float fres = pow(0.62 - dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0)), 2.1);
    float a = clamp(fres, 0.0, 1.0) * uOpacity;
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

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    vColor = aColor;
    vPhase = aPhase;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * (920.0 / max(1.0, -mv.z)), 1.0, 5.5);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    float a = smoothstep(0.5, 0.12, d);
    if (a < 0.02) discard;
    float tw = 0.84 + 0.16 * sin(uTime * 0.65 + vPhase);
    gl_FragColor = vec4(vColor, a * tw);
  }
`;

function homeVector(width: number, height: number, out: THREE.Vector3) {
  if (height > width) out.set(0, 86, 172);
  else out.set(0, 40, 112);
  return out;
}

function applyHome(camera: THREE.PerspectiveCamera, width: number, height: number) {
  const portrait = height > width;
  camera.fov = portrait ? 56 : 42;
  homeVector(width, height, camera.position);
  camera.near = 0.06;
  camera.far = 2400;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function Stars() {
  const mat = useMemo(
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
  const geo = useMemo(() => {
    const count = 2800;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    let s = 7;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    for (let i = 0; i < count; i++) {
      const disk = i > 1800;
      let x: number;
      let y: number;
      let z: number;
      if (disk) {
        const a = rand() * Math.PI * 2;
        const rad = 180 + rand() * 260;
        const lift = (rand() - 0.5) * 26 * rand();
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad * 0.72;
        y = lift + z * 0.35;
      } else {
        const u = rand();
        const v = rand();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = 360 + rand() * 90;
        x = r * Math.sin(phi) * Math.cos(theta);
        y = r * Math.cos(phi);
        z = r * Math.sin(phi) * Math.sin(theta);
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      const warm = rand() > 0.92;
      const cool = rand() < 0.08;
      colors[i * 3] = warm ? 1 : cool ? 0.72 : 0.82 + rand() * 0.18;
      colors[i * 3 + 1] = warm ? 0.9 : cool ? 0.84 : 0.86 + rand() * 0.1;
      colors[i * 3 + 2] = warm ? 0.72 : cool ? 1 : 0.9 + rand() * 0.08;
      sizes[i] = disk ? 1.1 + rand() * 1.4 : 1.3 + rand() * 2.2;
      phases[i] = rand() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    return g;
  }, []);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  useFrame((state) => {
    mat.uniforms.uTime!.value = state.clock.elapsedTime;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

function Simulation() {
  const reg = useRegistry();
  // 星系从 context 读：默认还是现在这套太阳系，换星系时这里自动跟着换
  const { bodies, spec } = useSystem();
  const time = useRef(0);
  const acc = useRef(0);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 0.1);
    const state = useSim.getState();
    if (!state.paused) time.current += delta * state.speed;
    const t = spec.unit === "meter" ? 0 : time.current;
    simClock.time = t;
    // 实境原型只验证相机与深度精度，不自转也不公转：
    // 地球在 1e7 m 处占屏幕近半，自转会把贴图暗区（深海）转进转出"偏离背景"的遮罩，
    // 公转会带着月球在画面里乱飞，两者都能把圆盘质心拖出 10~18 px —— 那是纹理和
    // 别的天体在动，不是渲染在抖。要让 float32 量化暴露出来，靠相机自己的径向呼吸
    // 就够了（±3% × 1.3e7 m = ±3.9e5 m，约 24 个 16384 m 的量化格）。
    const spinOn = spec.unit !== "meter";
    for (const body of bodies) {
      const group = reg.groups.get(body.id);
      if (group && body.orbitRadius > 0) {
        const angle = (t / body.period) * Math.PI * 2 + body.phase;
        const lx = Math.cos(angle) * body.orbitRadius;
        const lz = Math.sin(angle) * body.orbitRadius;
        group.position.set(lx, Math.sin(body.inclination) * lz, Math.cos(body.inclination) * lz);
      }
      const spin = reg.spins.get(body.id);
      if (spin && spinOn) {
        const rate = body.locked ? (Math.PI * 2) / body.period : body.spin;
        spin.rotation.y = t * rate;
      }
      const clouds = reg.clouds.get(body.id);
      if (clouds && spinOn) clouds.rotation.y = t * body.spin * 1.35;
    }
    if (reg.belt) reg.belt.rotation.y = t * 0.015;
    acc.current += delta;
    if (acc.current > 0.25) {
      acc.current = 0;
      const days = (t / EARTH_PERIOD) * 365.25;
      if (Math.abs(days - useSim.getState().days) > 0.2) useSim.getState().setDays(days);
    }
    if (!window.__solarReady) window.__solarReady = true;
  }, -3);
  return null;
}

function OrbitPath({ body, selected }: { body: Body; selected: boolean }) {
  const line = useMemo(() => {
    const pts: number[] = [];
    const n = 180;
    for (let i = 0; i <= n; i++) {
      const angle = (i / n) * Math.PI * 2;
      const lx = Math.cos(angle) * body.orbitRadius;
      const lz = Math.sin(angle) * body.orbitRadius;
      pts.push(lx, Math.sin(body.inclination) * lz, Math.cos(body.inclination) * lz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    geo.computeBoundingSphere();
    const mat = new THREE.LineBasicMaterial({
      color: selected ? "#e8edf4" : "#8b97a8",
      transparent: true,
      opacity: selected ? 0.9 : isMoon(body) ? 0.22 : 0.32,
    });
    const mesh = new THREE.Line(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }, [body, selected]);
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

function Rings({ body, onPick }: { body: Body; onPick: (e: ThreeEvent<PointerEvent>) => void }) {
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
    <mesh rotation={[Math.PI / 2, 0, 0]} material={mat} onClick={onPick} onPointerOver={setPointer} onPointerOut={clearPointer}>
      <ringGeometry args={[rings.inner, rings.outer, 160]} />
    </mesh>
  );
}

function setPointer(e: ThreeEvent<PointerEvent>) {
  e.stopPropagation();
  document.body.style.cursor = "pointer";
}

function clearPointer() {
  document.body.style.cursor = "";
}

function SunSurface({ body, onPick }: { body: Body; onPick: (e: ThreeEvent<PointerEvent>) => void }) {
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
      depthTest: false,
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
    mat.uniforms.uTime!.value = simClock.time;
  });
  return (
    <group>
      <primitive object={sprite} />
      <mesh material={mat} onClick={onPick} onPointerOver={setPointer} onPointerOut={clearPointer}>
        <sphereGeometry args={[body.radius, 64, 48]} />
      </mesh>
      <mesh material={shell} scale={1.55} raycast={() => null}>
        <sphereGeometry args={[body.radius, 40, 28]} />
      </mesh>
    </group>
  );
}

function PlanetSurface({ body, onPick }: { body: Body; onPick: (e: ThreeEvent<PointerEvent>) => void }) {
  const reg = useRegistry();
  const map = useMemo(() => textureFor(body), [body]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        toneMapped: false,
        uniforms: { uMap: { value: map } },
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
      }),
    [map],
  );
  // 实境原型里不挂云层：它是半径 1.02× 的半透明壳，片元按 alpha discard，轮廓是碎的。
  // 像素回读找"背景→圆盘"边缘时会锁在云斑而不是球面轮廓上，
  // 实测把现代路径的残余噪声从 0.1 px 抬到 0.6 px，正好盖住要测的东西。
  const clouds = body.texture === "earth" && useSystem().spec.unit !== "meter";
  const cloudMat = useMemo(() => {
    if (!clouds) return null;
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uMap: { value: cloudTexture() } },
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
    });
  }, [clouds]);
  useEffect(
    () => () => {
      mat.dispose();
      cloudMat?.dispose();
    },
    [mat, cloudMat],
  );
  /*
   * 实境原型（米）下把球面细分拉高。原因不是好看，是测量：
   * 屏幕上的轮廓是一个多面体而不是圆，弦高 = r·(1−cos(π/N))。
   * N=56、r=530 px 时弦高 0.83 px，相机一转，哪一圈顶点落在轮廓上就在换，
   * 轮廓的亚像素形状跟着抖 —— 这个抖动（实测 0.4 px）和要测的 float32 抖动
   * （同视距下 1.2 px）是同一个量级，会直接盖住信号。
   * 拉到 128 段后弦高降到 0.16 px，信噪比才够。
   */
  const hiFi = useSystem().spec.unit === "meter";
  const seg = hiFi ? 128 : body.radius > 1.4 ? 56 : body.radius > 0.4 ? 40 : 24;
  return (
    <>
      <mesh material={mat} onClick={onPick} onPointerOver={setPointer} onPointerOut={clearPointer}>
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

function SelectionRing({ radius }: { radius: number }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
      <torusGeometry args={[radius * 1.72, Math.max(0.012, radius * 0.03), 8, 72]} />
      <meshBasicMaterial color="#e8edf4" transparent opacity={0.78} />
    </mesh>
  );
}

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
  const labelOn = selected || (showLabels && !isMoon(body));
  const onPick = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (dragGuard.moved) return;
    useSim.getState().select(body.id);
  };
  const labelY = body.texture === "sun" ? body.radius * 2.15 : body.radius * 1.85;
  return (
    <group
      ref={(node) => {
        if (node) reg.groups.set(body.id, node);
        else reg.groups.delete(body.id);
      }}
    >
      {selected && <SelectionRing radius={body.radius} />}
      {labelOn && (
        <HtmlLabel y={labelY} name={body.name} selected={selected} />
      )}
      <group rotation={[0, 0, body.obliquity]}>
        <group
          ref={(node) => {
            if (node) reg.spins.set(body.id, node);
            else reg.spins.delete(body.id);
          }}
        >
          {body.texture === "sun" ? <SunSurface body={body} onPick={onPick} /> : <PlanetSurface body={body} onPick={onPick} />}
        </group>
        <Rings body={body} onPick={onPick} />
      </group>
      {/* 卫星太小，手指点不中；套一个透明的可点击球壳放大命中区域 */}
      {body.radius < 0.35 && (
        <mesh onClick={onPick} onPointerOver={setPointer} onPointerOut={clearPointer}>
          <sphereGeometry args={[Math.max(body.radius * 2.4, 0.12), 10, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
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

function HtmlLabel({ y, name, selected }: { y: number; name: string; selected: boolean }) {
  return (
    <Html position={[0, y, 0]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
      <span className={selected ? "star-label is-selected" : "star-label"}>{name}</span>
    </Html>
  );
}

function Asteroids() {
  const reg = useRegistry();
  const mesh = useRef<THREE.InstancedMesh>(null);
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
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false });
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

function CameraRig({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const { byId, spec } = useSystem();
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const gl = useThree((state) => state.gl);
  const reg = useRegistry();
  const selectedId = useSim((state) => state.selectedId);
  const resetToken = useSim((state) => state.resetToken);
  /*
   * 模式切换锁（store 层由 t12 立的 switching，1500ms 兜底）。
   * 禁拖拽/缩放只能在渲染层做 —— controls 在这儿，HUD 那边碰不到。
   * 释放点按 store 的契约走：finishSwitch() 由渲染层在相机动画结束时调用，
   * 是 `switching` 的唯一释放点（超时兜底在 store 里，不归这里管）。
   */
  const switching = useSim((state) => state.switching);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // 用 state 而不是 ref：r3f 首帧尺寸是 0，摆好相机会发生在之后的一次渲染，
  // 注意力放在 ref 上时聚焦 effect 的依赖永远不变，等于永不重跑（深链就白选了）。
  const [posed, setPosed] = useState(false);
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
      sunDir: new THREE.Vector3(),
      camDir: new THREE.Vector3(),
    }),
    [],
  );

  // 首次摆位放在帧循环里做（见 useFrame）。放 layout effect 里不可靠：
  // <OrbitControls> 排在 CameraRig 之后挂载，此时 ref 还是 null，
  // 而尺寸之后不再变化的话这个 effect 也不会重跑 —— posed 永远是 false，
  // 深链选中了却永远不聚焦，就是这么来的。

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
  const appliedKey = useRef<string | null>(null);

  const startFocus = (controls: OrbitControlsImpl, id: string | null) => {
    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const offset = fromPos.clone().sub(fromTarget);
    const fromDist = Math.max(offset.length(), 0.001);
    offset.multiplyScalar(1 / fromDist);
    const body = id ? byId[id] : undefined;
    anim.current = {
      t: 0,
      dur: reduced ? 0.01 : 0.95,
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
  };

  /*
   * 切换结束（switching → null）时把控制权还回去。
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
      c.enableRotate = true;
      c.enableZoom = true;
    }
  }, [switching, controlsRef]);

  useFrame((_, raw) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // 实境原型（?proto=1）：相机绕地球缓慢公转且始终看向它。
    // 地球的世界坐标是 1.5e11 米量级，相机离它 1e7 米 —— 这个比例的减法
    // 只要发生在 float32 里就会抖。地球被 lookAt 钉在屏幕中心，
    // 屏幕上任何偏移都只可能来自精度误差，这就是抖动断言量的东西。
    if (spec.unit === "meter") {
      const earth = reg.groups.get("earth");
      if (earth) {
        // 原型模式下相机由这里独占：OrbitControls 每帧 update() 会把相机拉回它自己的
        // 球坐标状态，必须关掉，否则手动摆放的机位会被覆盖。
        controls.enabled = false;
        earth.getWorldPosition(scratch.dest);
        const dist = PROTO_DIST;

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
        tightenClipPlanes(camera as THREE.PerspectiveCamera, dist);

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
      }
      return;
    }

    // 每帧按焦点距离收窄 near/far：固定值在 1:1 下不可能覆盖 4.87e9 的跨度
    tightenClipPlanes(
      camera as THREE.PerspectiveCamera,
      camera.position.distanceTo(controls.target),
    );

    /*
     * 模式切换期间禁用拖拽/缩放。放在每帧最前面强制写一次，是因为 drei 的
     * <OrbitControls> 会在自身重渲染时按 props 把开关刷回默认值，只在 useEffect
     * 里设一次会被它盖掉。动画结束处的恢复也改成看 switching，两处不会互相提前开锁。
     */
    if (switching) {
      controls.enableRotate = false;
      controls.enableZoom = false;
    }

    // 首次摆位：等控件和尺寸都就绪，在这里做才不会错过头
    if (!posed && sizeRef.current.width >= 2 && camera instanceof THREE.PerspectiveCamera) {
      applyHome(camera, sizeRef.current.width, sizeRef.current.height);
      controls.target.set(0, 0, 0);
      controls.update();
      setPosed(true);
    }

    // 选中变化（点芯片 / 深链 / 返回总览）→ 起一次聚焦动画
    const key = `${wantId.current ?? ""}|${wantReset.current}`;
    if (posed && appliedKey.current !== key) {
      const initial = appliedKey.current === null && wantId.current === null;
      appliedKey.current = key;
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
          const halfHeight = current.toDist * Math.tan((fov * Math.PI) / 360);
          scratch.dest.y -= halfHeight * 0.55;
        }
        scratch.target.lerpVectors(current.fromTarget, scratch.dest, u);
        const dist = THREE.MathUtils.lerp(current.fromDist, current.toDist, u);
        scratch.pos.copy(scratch.target).addScaledVector(current.dir, dist);
      }
      controls.target.copy(scratch.target);
      camera.position.copy(scratch.pos);
      if (u >= 1) {
        anim.current = null;
        /*
         * 恢复控制权时看 switching：切换动画刚走完但 store 还没放锁的那一帧，
         * 这里要是无脑写 true，就会出现"锁还没放、人已经能拖"的窗口。
         * 顺带按 store 的契约在这里放锁 —— finishSwitch 是 switching 的唯一释放点，
         * 超时兜底在 store 里（1500ms），不归这里。
         */
        const stillSwitching = useSim.getState().switching !== null;
        controls.enableRotate = !stillSwitching;
        controls.enableZoom = !stillSwitching;
        if (stillSwitching) useSim.getState().finishSwitch();
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
  }, -2);

  return null;
}

/**
 * 验收探针：把 15 个天体的屏幕投影暴露成纯函数，供 verify.mjs 做数值断言
 * （命中矩阵、跟随抖动）。只读、无副作用，生产环境也就是多挂一个全局函数。
 */
function Probe() {
  const reg = useRegistry();
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const gl = useThree((state) => state.gl);
  const { bodies } = useSystem();

  useEffect(() => {
    const v = new THREE.Vector3();
    const probe = () => {
      const projected: { id: string; x: number; y: number; z: number; radiusPx: number }[] = [];
      for (const body of bodies) {
        const group = reg.groups.get(body.id);
        if (!group) continue;
        group.getWorldPosition(v);
        const distance = camera.position.distanceTo(v);
        v.project(camera);
        // 屏幕半径：透视相机的像素焦距 = 视口高一半 / tan(fov/2)
        const persp = camera as THREE.PerspectiveCamera;
        const focal = size.height / 2 / Math.tan((persp.fov * Math.PI) / 360);
        projected.push({
          id: body.id,
          x: (v.x * 0.5 + 0.5) * size.width,
          y: (-v.y * 0.5 + 0.5) * size.height,
          z: v.z,
          radiusPx: distance > 0 ? (body.radius / distance) * focal : 0,
        });
      }
      return projected;
    };
    (window as unknown as { __solarProbe?: typeof probe }).__solarProbe = probe;

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
    };
  }, [reg, camera, gl, bodies, size.height, size.width]);

  return null;
}

function Scene() {
  const showOrbits = useSim((state) => state.showOrbits);
  const showLabels = useSim((state) => state.showLabels);
  const selectedId = useSim((state) => state.selectedId);
  const registry = useRef<Registry>({
    groups: new Map(),
    spins: new Map(),
    clouds: new Map(),
    belt: null,
  });
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { byId, spec } = useSystem();
  const sun = byId.sun;
  if (!sun) return null;
  /*
   * 实境原型（米）下不挂沙盘装饰：星空、小行星带、尾迹的几何体都建在
   * 「离原点几十到几百」这个量级上，而原型里那个量级是"几十米"。
   * 更麻烦的是尾迹——它记录的是世界坐标（~1.5e11 m）且 frustumCulled=false，
   * 在 float32 下大数相减会把它画到屏幕上任意位置，像素回读的亮斑质心
   * 会被它拖走 10~18 px（proto 与 legacy 同样漂移，就是这个东西干的）。
   */
  const decor = spec.unit !== "meter";
  return (
    <RegistryContext.Provider value={registry.current}>
      {decor && <Stars />}
      <Probe />
      <Simulation />
      <BodyNode
        body={sun}
        showOrbits={showOrbits && decor}
        showLabels={showLabels && decor}
        selectedId={selectedId}
      />
      {decor && <Asteroids />}
      {decor && <Trails />}
      <CameraRig controlsRef={controlsRef} />
      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableDamping
        dampingFactor={0.09}
        rotateSpeed={0.55}
        zoomSpeed={0.7}
        minDistance={1.15}
        maxDistance={280}
        minPolarAngle={0.02}
        maxPolarAngle={Math.PI - 0.02}
      />
    </RegistryContext.Provider>
  );
}

export function SolarCanvas() {
  return (
    <Canvas
      className="space-canvas"
      dpr={[1, 1.6]}
      camera={{ position: [0, 40, 112], fov: 42, near: 0.06, far: 2400 }}
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
