# 验收怎么跑

```bash
npm run build          # 先出 release/（verify 验的是构建产物，不是 dev server）
npm run verify         # = node scripts/verify.mjs
```

`verify.mjs` 起一个临时静态服务器指向 `release/site`，用系统 Edge（不下载 Chromium）开真浏览器，
软件光栅化（swiftshader）跑 WebGL，把结果打成一坨 JSON，最后一行是结论：

- `"failures": []` + `✓ 全部通过` → 退出码 0
- 任何一条红 → 退出码 1，`failures` 里每条都以 **pass 名 + 冒号** 开头，按前缀就能定位

端口默认 4178，被占用会自动往后找（4179、4180…），并打印一行提示。
浏览器路径默认 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，
换机器用环境变量 `XG_EDGE` 指过去（`XG_EDGE=/usr/bin/chromium node scripts/verify.mjs`）。

## 9 个 pass 各验什么

| pass | 验什么 | 判据 | 红了先看哪 |
| --- | --- | --- | --- |
| `desktop` | 1280×720：画布起来、恰好 1 个 canvas、无横向溢出、点「地球」后卡片标题是「地球」 | 结构性 | `results[]` 里该条的 `errors` / `overflowX` / `selected` |
| `mobile` | 390×844 @3x 触屏视口同上（不点选） | 结构性 | 同上 |
| `mobile-selected` | 手机视口 + 点选 | 结构性 | 同上 |
| `single-file` | `release/星轨.html` 用 `file://` 直接打开（单文件版资源没漏） | 结构性 | 该条 `errors`；漏资源会在控制台报 404 |
| `frame-time` | 稳态帧时间相对**本次运行的机器基线**的比值 | **数值** | `results[frame-time].normalized`，见下节 |
| `hit-matrix` | 探针投影出 15 个天体；重叠对只记录不判 | **数值** | 大于/小于 15 说明数据层漏天体，不是渲染问题 |
| `follow-jitter` | 选中地球后 90 帧，目标屏幕位置峰峰值 < 0.5px | **数值** | 抖动说明相机跟随里混进了逐帧噪声 |
| `proto-real` | `?proto=1` 真实单位原型：3 个天体、地球钉在屏幕中心 ≤ 1px | **数值** | 偏移说明相机/投影没对齐 |
| `proto-jitter` | 像素回读对比 modern 与 legacy 顶点路径的 float32 量化抖动 | **数值** | `modern.pp ≥ 0.7px` 或 `legacy ≤ modern×1.4`（对照失效） |

数值断言一共 5 条，但**只有 `frame-time` 会因为「这台机器现在忙」而变红**。
其余四条量的是几何量（投影坐标、像素偏移），和帧率无关，慢机器上数字一样。

## frame-time 的红线怎么读

判的不是绝对毫秒，是比值：

```
normalized.ema = steady.ema ÷ denominatorMs    阈值 1.6
normalized.p95 = steady.p95 ÷ denominatorMs    阈值 2.2
hitch          相对量：> max(50ms, 2.5 × 本次中位数)，预算 = 基线 hitch + 1
```

`denominatorMs` 取两次基线里较大的那个：一次在遥测页**开起来之前**测，一次在**关掉之后**测。
基线本身是两件事：

- `vsync`：`about:blank` 空 rAF 循环 → 这台机器当前的 vsync 节拍（本地实测 8.3–16.9ms 都出现过）
- `raster`：1280×720 全屏定量着色器页，每帧固定 8 个 pass → 当前可用光栅吞吐

分母 = `max(raster.ema, vsync.ema)`。空循环那一路是**兜底**：闲机器上 8 个 pass 可能塞进一帧、
被 vsync 钉住，这时断言自动退化成「场景 ≤ 1.6 × vsync」——没信息的时候不假装有信息。

红了先按这个顺序看：

1. `baseline.before.raster.ema` 和 `baseline.after.raster.ema` 差得远吗（比如 40 vs 20）？
   差得远 = 采样这段里机器状态变了，先重跑，别急着改代码。
2. `normalized.ema` 是多少？1.6 出头可能是真毛刺，**1.8 以上且两次基线接近**才是真回归
   （单帧光栅量真涨了，比如有人往每帧里塞了贴图重建）。
3. `steady.ema`（绝对 ms）和 `legacy.wouldFail` 只是留档：`wouldFail: true` 但全绿是**正常**的，
   它记录「旧规矩在同样这份采样上会红」，用来对比，不参与判定。

阈值 1.6 的来历写在 `verify.mjs` 顶部注释里：旧断言 `EMA ≤ 26ms` 在 60Hz 机器上等于
26/16.7 = 1.56×，新阈值取 1.6 保持同等严格度，而实测场景÷基线在忙闲两态都是 0.85–0.91，
留有 1.75× 裕量。

## CI 与本地差异

**先说清楚：CI 现在不跑 verify。** `.github/workflows/build.yml` 只做 `npm run build`
+ 确认 `release/星轨.html` 产出 + 上传/发布。所以验收目前是「本机 / 发版前手动」的动作。
（要让 CI 接 verify，得给 runner 装 Edge 或用 `XG_EDGE` 指向 chromium，并接受它比本地慢一档。）

真接进来时要知道的四件事：

- **都是软件光栅**：CI runner 没独显，WebGL 走 llvmpipe/swiftshader；本地 Edge 也被强制
  `--use-angle=swiftshader`。两边同一类渲染路径，这是「基线比值」能跨机器迁移的前提。
- **rAF 都被 vsync 钉住**：CI 是虚拟显示器，基本恒定 60Hz（16.7ms）；本地这块面板实测
  出现过 10.3 / 16.7 / 8.3ms 三种中位数（高刷/动态刷新）。所以任何「默认 60Hz」的绝对阈值
  在本地都会失真——这也是 frame-time 不许写死 ms 的直接原因。
- **CI 更慢但更稳，本地更快但会被别的进程抢**。基线法两边都能吃；反过来，写死绝对阈值
  在两边都会误判（CI 偏红、本地偏绿）。
- **同机并行会互相污染**：两台 verify 同时跑时，双方的全屏 WebGL 会互抢光栅，
  `frame-time` 的分母会把对方的开销算成「机器基」。要干净数字就串行跑（端口不会撞，CPU 会）。

## 截图

截图落 `screenshots/`（已在 `.gitignore` 里，别提交）。每个 pass 一张，
`proto-jitter` 两张（modern / legacy 对照）。红了先看图，往往一眼就看出是画布黑屏还是布局塌了。
