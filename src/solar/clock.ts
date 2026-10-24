import { useSim } from "./store";

/**
 * 模拟时间的**派生读数**（唯一真值是 `store.simSeconds`）。
 *
 * 改造前这里是一个自己累加的单例 `{ time: 0 }`：Simulation 每帧往里写、SunSurface 每帧读，
 * 而 Simulation 自己还留着一份 `useRef` —— "时间"于是有两份真值，实境的冻结又只发生在
 * 消费端（`spec.unit === "meter" ? 0 : t`），在实境待多久、回沙盘模拟历就跳多久。
 *
 * 现在这里没有任何状态：只是把 store 的读数转出来，给那些"在 useFrame 里要时间、
 * 但不该因为时间变化而重渲染"的消费方用（目前只有太阳表面的 uTime）。
 * 还留这个文件而不是直接读 store：把"读时间"收在一处，将来加时间尺/历元只改这里。
 */
export function simTimeNow(): number {
  return useSim.getState().simSeconds;
}
