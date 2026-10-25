import { useEffect, useState } from "react";
import { Hud } from "./solar/Hud";
import { SolarCanvas } from "./solar/SolarCanvas";
import { BODY_BY_ID } from "./solar/data";
import { markVisited } from "./solar/progress";
import { APP_FULL_NAME } from "./solar/brand";
import { OrbitGlyph } from "./solar/BrandMark";
import { useSim } from "./solar/store";
import { SystemProvider } from "./solar/system-context";
import { REAL_PROTO, REAL_SYSTEM } from "./solar/systems";

/**
 * 壳层组件：与 Grok 原工程的 `src/routes/index.tsx` 逐行对应，
 * 只去掉路由包装（createFileRoute），并给 h-dvh 加了一条 100vh 兜底。
 */
const PROTO = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("proto") === "1";

/**
 * 退出原型（t20）。
 *
 * `?proto=1` 是发布物的一部分（参数名在 bundle 里可读），原来它把整个 HUD 卸掉，
 * 进去之后**只能改地址栏才出得来** —— 一条分享链接就能把人关在原型里。后门可以留，
 * 陷阱不能留。这里做的事只有一件：把 `proto` 参数摘掉再重新加载
 * （必须 reload：SystemProvider 的 spec 在挂载时定，热换会留下半个原型）。
 */
function exitProto() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("proto");
    window.location.assign(url.toString());
  } catch {
    // file:// 下改不了地址栏：至少把查询串清掉
    window.location.search = "";
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  /*
   * 系统跟着 store 的 mode 走（t16）：
   *  - `mode === "real"` → REAL_PROTO（米制三体）。相机不归这里管：渲染层按 spec 的
   *    `look.camera === "meter"` 挂 `<MeterCamera>`，机位由 `systems.frameEarthMoon` 按米算；
   *  - 其余 → 默认沙盘系统（压缩世界单位）。
   *  - `?proto=1` 仍然是**最高优先级**的后门：eagle-eye 调试要的是「不管 store 说什么，
   *    给我看原型」，所以它永远盖过 mode。
   * 换系统时 `buildValue` 以 spec 为 useMemo 依赖重算，`bodies` 数组换身份，
   * PickLayer / Simulation / Probe 的 effect 都会跟着重建（它们的依赖里都有 bodies/spec）。
   */
  const mode = useSim((state) => state.mode);
  const inReal = mode === "real";
  /*
   * t14：产品实境用 `REAL_SYSTEM`（地月 + 冥王星/哈雷，轨道线打开）；
   * `?proto=1` 仍然指向三体测量夹具 `REAL_PROTO` —— 它和产品实境是两份 spec，
   * 因为夹具的断言数"3 个天体"、且它必须关掉 orbitLines（见 systems.ts 的注释）。
   *
   * `?diag=1&system=real` 是**只在诊断下**的取景口：截图/验收要拍实境样本时，
   * 不必先走一遍解锁门槛。产品路径不读它（`DIAG` 为假时恒为 false）。
   */
  const DIAG_SYSTEM_REAL =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("diag") &&
    new URLSearchParams(window.location.search).get("system") === "real";
  const system = PROTO ? REAL_PROTO : inReal || DIAG_SYSTEM_REAL ? REAL_SYSTEM : undefined;

  useEffect(() => {
    setReady(true);
  }, []);

  // 原型模式下 Esc 也是出口（和那个按钮同一件事，两条路都能走）
  useEffect(() => {
    if (!PROTO) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Escape") exitProto();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
   * 同步置黑（t20）。目标：换系统的那一帧就已经是全黑，浏览器没有机会先画一帧新系统。
   *
   * 做法：黑幕在 `mode === "real"` 的**那次 commit 里**就是不透明的 ——
   * `veilLifted` 初值 false，直到 240ms 后 effect 才把它抬起来。
   * 注意顺序：切进实地的那一帧 `veilLifted` 还是 false，所以「黑」和「换系统」同帧；
   * 240ms 之后再淡出（`transition-opacity` 只挂在淡出那一支上），
   * 于是硬切被黑场盖住，露出时已经是摆好的实地画面。
   *
   * 为什么黑场在壳层而不是渲染层：渲染层原来有个 `dip()`（命令式 append 一层黑 div、
   * 再等一个 rAF 才把 opacity 设成 1），它是**假黑场** —— 换系统那次 commit 根本没被盖住，
   * 而 rAF 在后台标签页还不跑。那个函数已经删掉了，全项目只剩这里一份黑幕。
   * 至于 `switching` 锁的释放点，渲染层用的是 `releaseControls()`：`<MeterCamera>` 和
   * `<SandboxCamera>` 里各调一次。**这里不写行号** —— 上一版写的是一个具体行号，
   * 早就漂到 far 裁剪面的代码上去了；写函数名比写数字活得久。
   *
   * 只盖进实地、不盖回沙盘：回沙盘那 0.95s 是设计好的镜头回归，盖住就看不见路了。
   */
  const [veilLifted, setVeilLifted] = useState(false);
  useEffect(() => {
    if (!inReal) {
      setVeilLifted(false);
      return;
    }
    const timer = window.setTimeout(() => setVeilLifted(true), 240);
    return () => window.clearTimeout(timer);
  }, [inReal]);

  /*
   * 可分享的深链：?body=earth 打开就聚焦地球，选中什么就把什么写回地址栏。
   *
   * 顺序有讲究（t4）：**订阅先挂，select 后发**。原来反过来 —— 先 select 再 subscribe，
   * 于是 `?body=earth` 深链进来的那一次选择谁都没看见：「记访问 + 回写地址栏」只有订阅里
   * 那一段在做，`xinggui-visited-v1` 里永远不会有 earth（实测过，干净 profile 打开深链，
   * localStorage 是空的）。把订阅提到 select 前面就够了，不另补一份一次性记账 ——
   * 两份记账迟早在某条路径上分叉。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const unsubscribe = useSim.subscribe((state, prev) => {
      // 切换中禁写 URL：别让人复制到中间态的链接（落定后拦下的选择会再触发一次）
      if (state.switching) return;
      if (state.selectedId === prev.selectedId) return;
      if (state.selectedId) markVisited(state.selectedId);
      try {
        const url = new URL(window.location.href);
        if (state.selectedId) url.searchParams.set("body", state.selectedId);
        else url.searchParams.delete("body");
        window.history.replaceState(null, "", url);
      } catch {
        /* file:// 下部分浏览器不允许改地址栏，忽略即可 */
      }
    });

    // 订阅挂好之后再发这次 select：深链的那一下和用户真点一下走同一条路。
    const id = params.get("body");
    if (id && BODY_BY_ID[id]) useSim.getState().select(id);

    // ?gate=XG1-… 读入一次即删参数：读入是幂等的，但别在地址栏留一串码
    const gate = params.get("gate");
    if (gate && useSim.getState().restoreGateCode(gate).ok) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("gate");
        window.history.replaceState(null, "", url);
      } catch {
        /* file:// 下改不了地址栏，忽略 */
      }
    }

    return unsubscribe;
  }, []);

  return (
    <SystemProvider value={system}>
      {/*
        `data-real-veil`：进实境头 240ms 的黑幕是 `pointer-events-auto` 的，但 HUD 在 z-10、
        黑幕在 z-[2]，HUD 会"盖不住地"漏出来点得动。这个属性让 HUD 侧用 CSS 把
        `.real-controls` 的指针关掉（t22），不去绕过既有黑幕机制、也不改 z 序。
      */}
      <main
        className="relative h-screen w-full overflow-hidden bg-bg text-fg"
        style={{ height: "100dvh" }}
        data-real-veil={inReal && !veilLifted ? "1" : undefined}
      >
        <div className="sky absolute inset-0" aria-hidden />
        {/*
          启动页是全名唯一的家：「巡星·未至之境」是一整个名字，不拆开、不缩写，
          所以它不进水印、不进 HUD 角落，只在这里居中排开。
          不设 z-index：首帧画出后画布（z-0）会自然盖住它，等于自动退场。
        */}
        <div className="boot-screen pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <div className="boot-mark">
            <OrbitGlyph className="size-10" />
          </div>
          <p className="boot-title font-display leading-tight text-fg">{APP_FULL_NAME}</p>
          <p className="boot-code">SOLAR CARTOGRAPHY / XG—01</p>
          <p className="boot-status">正在展开星图</p>
        </div>
        <div className="absolute inset-0 z-0 overflow-hidden" role="img" aria-label="太阳系三维场景">
          {ready ? <SolarCanvas /> : null}
        </div>
        <div className="vignette pointer-events-none absolute inset-0 z-[1]" aria-hidden />
        {/*
          黑幕本体。三态：
          - 不在实境 → 透明（不挂 transition，免得回沙盘时还留着一层）；
          - 刚切实境（veilLifted=false）→ **完全不透明且无 transition**，所以这一帧就是黑的；
          - 240ms 后 veilLifted=true → 挂 transition 淡出，露出已经摆好的实地面画。
          挂载时机比 opacity 更重要：这个 div 一直在 DOM 里，只切 class，
          所以不存在"append 到 DOM 之后才等一帧变黑"的窗口（dip 的老毛病）。

          指针事件（t44 收尾）：**不透明期间吃掉指针**，淡出后立刻放开。
          为什么：进实境的相机没有过渡动画，`switching` 锁在第一帧就放掉了
          （见 SolarCanvas 的 MeterCamera），于是黑幕还盖着的那 ~220ms 里，
          HUD 是全活的 —— 玩家看得见一片黑，点下去却可能按到暂停/图层/时计。
          这一层由壳层负责，不去改渲染层的放锁时机。
        */}
        <div
          className={`absolute inset-0 z-[2] bg-black ${
            inReal
              ? veilLifted
                ? "pointer-events-none opacity-0 transition-opacity duration-200"
                : "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          aria-hidden
        />
        {PROTO ? (
          /*
            原型的出口（t20）。极简：一个角标按钮 + Esc，位置和 HUD 的徽标同一片区域，
            但它不是模式控件 —— 原型不是"另一种看法"，是工程脚手架。
            文案没有进 narrator 的表（它是调试面），所以就地写死并标 TODO(copy)。
          */
          <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
            <span className="eyebrow text-[11px] text-subtle">原型</span>
            <button
              type="button"
              className="hud-btn pointer-events-auto inline-flex h-8 items-center rounded-full border border-line bg-elevated px-3 text-xs text-fg"
              onClick={exitProto}
            >
              退出
            </button>
          </div>
        ) : (
          <Hud />
        )}
      </main>
    </SystemProvider>
  );
}
