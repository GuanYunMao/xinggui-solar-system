import { useEffect, useState } from "react";
import { Hud } from "./solar/Hud";
import { SolarCanvas } from "./solar/SolarCanvas";
import { BODY_BY_ID } from "./solar/data";
import { markVisited } from "./solar/progress";
import { APP_FULL_NAME } from "./solar/brand";
import { useSim } from "./solar/store";
import { SystemProvider } from "./solar/system-context";
import { REAL_PROTO } from "./solar/systems";

/**
 * 壳层组件：与 Grok 原工程的 `src/routes/index.tsx` 逐行对应，
 * 只去掉路由包装（createFileRoute），并给 h-dvh 加了一条 100vh 兜底。
 */
const PROTO = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("proto") === "1";

export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  // 可分享的深链：?body=earth 打开就聚焦地球，选中什么就把什么写回地址栏。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
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

    return useSim.subscribe((state, prev) => {
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
  }, []);

  return (
    <SystemProvider value={PROTO ? REAL_PROTO : undefined}>
      <main className="relative h-screen w-full overflow-hidden bg-bg text-fg" style={{ height: "100dvh" }}>
        <div className="sky absolute inset-0" aria-hidden />
        {/*
          启动页是全名唯一的家：「巡星·未至之境」是一整个名字，不拆开、不缩写，
          所以它不进水印、不进 HUD 角落，只在这里居中排开。
          不设 z-index：首帧画出后画布（z-0）会自然盖住它，等于自动退场。
        */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
          <p className="font-display text-4xl leading-none tracking-[0.06em] text-fg">{APP_FULL_NAME}</p>
          <p className="text-xs tracking-[0.3em] text-subtle">正在展开星图</p>
        </div>
        <div className="absolute inset-0 z-0 overflow-hidden" role="img" aria-label="太阳系三维场景">
          {ready ? <SolarCanvas /> : null}
        </div>
        <div className="vignette pointer-events-none absolute inset-0 z-[1]" aria-hidden />
        {PROTO ? null : <Hud />}
      </main>
    </SystemProvider>
  );
}
