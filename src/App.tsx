import { useEffect, useState } from "react";
import { Hud } from "./solar/Hud";
import { SolarCanvas } from "./solar/SolarCanvas";

/**
 * 壳层组件：与 Grok 原工程的 `src/routes/index.tsx` 逐行对应，
 * 只去掉路由包装（createFileRoute），并给 h-dvh 加了一条 100vh 兜底。
 * 游戏本体全部在 `src/solar/` 里，与原版字节级一致。
 */
export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <main
      className="relative h-screen w-full overflow-hidden bg-bg text-fg"
      style={{ height: "100dvh" }}
    >
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
  );
}
