import { useEffect, useState } from "react";
import { Hud } from "./solar/Hud";
import { SolarCanvas } from "./solar/SolarCanvas";
import { BODY_BY_ID } from "./solar/data";
import { markVisited } from "./solar/progress";
import { useSim } from "./solar/store";
import { SystemProvider } from "./solar/system-context";

/**
 * 壳层组件：与 Grok 原工程的 `src/routes/index.tsx` 逐行对应，
 * 只去掉路由包装（createFileRoute），并给 h-dvh 加了一条 100vh 兜底。
 */
export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  // 可分享的深链：?body=earth 打开就聚焦地球，选中什么就把什么写回地址栏。
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("body");
    if (id && BODY_BY_ID[id]) useSim.getState().select(id);

    return useSim.subscribe((state, prev) => {
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
    <SystemProvider>
      <main className="relative h-screen w-full overflow-hidden bg-bg text-fg" style={{ height: "100dvh" }}>
        <div className="sky absolute inset-0" aria-hidden />
        <p className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-muted">
          正在展开星图
        </p>
        <div className="absolute inset-0 z-0 overflow-hidden" role="img" aria-label="太阳系三维场景">
          {ready ? <SolarCanvas /> : null}
        </div>
        <div className="vignette pointer-events-none absolute inset-0 z-[1]" aria-hidden />
        <Hud />
      </main>
    </SystemProvider>
  );
}
