import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simClock } from "./clock";
import { BODY_BY_ID, EARTH_PERIOD, isMoon, type Body } from "./data";
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

const PLANET_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vPos;
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
  const { bodies } = useSystem();
  const time = useRef(0);
  const acc = useRef(0);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 0.1);
    const state = useSim.getState();
    if (!state.paused) time.current += delta * state.speed;
    const t = time.current;
    simClock.time = t;
    for (const body of bodies) {
      const group = reg.groups.get(body.id);
      if (group && body.orbitRadius > 0) {
        const angle = (t / body.period) * Math.PI * 2 + body.phase;
        const lx = Math.cos(angle) * body.orbitRadius;
        const lz = Math.sin(angle) * body.orbitRadius;
        group.position.set(lx, Math.sin(body.inclination) * lz, Math.cos(body.inclination) * lz);
      }
      const spin = reg.spins.get(body.id);
      if (spin) {
        const rate = body.locked ? (Math.PI * 2) / body.period : body.spin;
        spin.rotation.y = t * rate;
      }
      const clouds = reg.clouds.get(body.id);
      if (clouds) clouds.rotation.y = t * body.spin * 1.35;
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
  const clouds = body.texture === "earth";
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
  const seg = body.radius > 1.4 ? 56 : body.radius > 0.4 ? 40 : 24;
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
            <sphereGeometry args={[body.radius * 1.02, 40, 28]} />
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
  const reg = useRegistry();
  const selectedId = useSim((state) => state.selectedId);
  const resetToken = useSim((state) => state.resetToken);
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
        // 球坐标状态，必须关掉，否则手动摆放的机位会被覆盖（表现就是一片黑）
        controls.enabled = false;
        earth.getWorldPosition(scratch.dest);
        const angle = performance.now() * 0.0003;
        const dist = 1e7;
        camera.position.set(
          scratch.dest.x + Math.cos(angle) * dist,
          scratch.dest.y + dist * 0.2,
          scratch.dest.z + Math.sin(angle) * dist,
        );
        controls.target.copy(scratch.dest);
        camera.lookAt(scratch.dest);
        tightenClipPlanes(camera as THREE.PerspectiveCamera, dist);
      }
      return;
    }

    // 每帧按焦点距离收窄 near/far：固定值在 1:1 下不可能覆盖 4.87e9 的跨度
    tightenClipPlanes(
      camera as THREE.PerspectiveCamera,
      camera.position.distanceTo(controls.target),
    );

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
        controls.enableRotate = true;
        controls.enableZoom = true;
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
    return () => {
      delete (window as unknown as { __solarProbe?: typeof probe }).__solarProbe;
    };
  }, [reg, camera, bodies, size.height, size.width]);

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
  const { byId } = useSystem();
  const sun = byId.sun;
  if (!sun) return null;
  return (
    <RegistryContext.Provider value={registry.current}>
      <Stars />
      <Probe />
      <Simulation />
      <BodyNode body={sun} showOrbits={showOrbits} showLabels={showLabels} selectedId={selectedId} />
      <Asteroids />
      <Trails />
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
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
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
