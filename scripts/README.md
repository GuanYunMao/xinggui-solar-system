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
产物目录默认 `release/`，用 `XG_RELEASE` 可以指到一份冻结快照（结构要一致：`site/` + `巡星.html`），
见下节「别和别人的构建撞车」。

## 9 个 pass 各验什么

| pass | 验什么 | 判据 | 红了先看哪 |
| --- | --- | --- | --- |
| `desktop` | 1280×720：画布起来、恰好 1 个 canvas、无横向溢出、点「地球」后卡片标题是「地球」、**画布不是全黑** | 结构性 + 像素 | `results[]` 里该条的 `errors` / `overflowX` / `selected` / `canvasPixels` |
| `mobile` | 390×844 @3x 触屏视口同上（不点选） | 结构性 + 像素 | 同上 |
| `mobile-selected` | 手机视口 + 点选 | 结构性 + 像素 | 同上 |
| `single-file` | `release/巡星.html` 用 `file://` 直接打开（单文件版资源没漏）、**画布不是全黑** | 结构性 + 像素 | 该条 `errors`；漏资源会在控制台报 404 |
| `frame-time` | 稳态帧时间相对**本次运行的机器基线**的比值 | **数值** | `results[frame-time].normalized`，见下节 |
| `hit-matrix` | 探针投影出 15 个天体；重叠对只记录不判 | **数值** | 大于/小于 15 说明数据层漏天体，不是渲染问题 |
| `follow-jitter` | 选中地球后 90 帧，目标屏幕位置峰峰值 < 0.5px | **数值** | 抖动说明相机跟随里混进了逐帧噪声 |
| `proto-real` | `?proto=1` 真实单位原型：3 个天体、地球钉在屏幕中心 ≤ 1px、**画布不是全黑** | **数值** + 像素 | 偏移说明相机/投影没对齐 |
| `proto-jitter` | 像素回读对比 modern 与 legacy 顶点路径的 float32 量化抖动（p10–p90 / 120 帧） | **数值** | 见下节「proto-jitter 的维护契约」 |

数值断言一共 5 条，但**只有 `frame-time` 会因为「这台机器现在忙」而变红**。
其余四条量的是几何量（投影坐标、像素偏移），和帧率无关，慢机器上数字一样。

**画布像素体检**（`desktop` / `mobile` / `mobile-selected` / `single-file` / `proto-real` 都有）
见下节「画布像素体检（抓整屏黑）」——它抓的是「数据层全对、眼睛看到一片黑」这类回归。

## 画布像素体检（抓整屏黑）

**为什么要有这条**：2026-10-24 实测过一次「画布全黑但 8 条 pass 全绿」——`__solarReady` 置位、
canvas 数量对、DOM 文本对、`__solarProbe()` 的几何也对（`draws: 0, tris: 0`，一笔没提交）。
因为那些断言只验「数据层说得通」这一层，而用户眼睛看到的是黑的。当时真正抓住它的是
`proto-jitter` 的像素回读，纯属偶然。所以现在每个开浏览器的 pass 都带一条像素体检。

怎么验：读画布上 **25 个 8×8 块**（四角 + 中心），算平均亮度与非黑块占比。

- 判红条件：`meanLum < 2` **或** `nonBlackRatio < 0.5`
- 阈值标定（合成画布实测，两个方向都验过）：
  - 产品背景色 `#07090e` → `meanLum 8.94`、`nonBlackRatio 1.0` → **判绿**（4.5× 余量）
  - 纯黑 → `0 / 0` → 判红
- **前提**：`preserveDrawingBuffer` 必须为真，否则 `readPixels` 永远返回 0，会把「读不到」
  误判成「黑屏」。所以这几个 pass 的 URL 统一追加 `?diag=1`（`SolarCanvas` 的 `READBACK`
  由 `proto|legacy|diag` 触发）；万一属性不是 true，结果是 `available: false` + `reason`，
  **不判红**（宁可说测不了，也不冤枉产品）。
- `frame-time` 所在的数值页**故意不加** `diag`：`preserveDrawingBuffer` 会让每帧多一次拷贝，
  污染帧时间测量。那一页的「黑屏」由 `proto-jitter` 的像素回读兜底。

红了先看这条的 `canvasPixels`：`meanLum: 0` + `nonBlackRatio: 0` 就是整屏黑。
顺序是——先确认 `__solarProbe()` 的几何是否正常（正常说明数据层没坏，是渲染没画），
再看渲染器有没有提交（`?proto=1&diag=1` 的 `[proto]` 日志里 `draws`/`tris`）。

## 探针契约（`__solarProbe()` / `__solarTextures()`）

`__solarProbe()` 返回的**条数 = 当前挂载的天体数**（沙盘 15、`?proto=1` 3），
**不是**「画面里能看到的数量」。

**相机背后的天体返回 NaN 哨兵**：`x/y/z = NaN`、`radiusPx = 0`。
这是**有意设计，不是 bug**——拾取器那边把背后的天体剔掉（点不中、也不该出手型），
但探针保留一条记录，因为 `hit-matrix` 数 15、`proto-real` 数 3 这两条断言都建在
「条数 = 挂载数」上。更关键的是**不编造镜像坐标**：`project()` 在 z<0 时会翻符号把
背后的天体镜像回画面，看着在屏幕上、点了却没反应 —— 那正是 t13 修掉的幽灵热区。

实测（`node scripts/texture-report.mjs`，加 `"?proto=1"` 参数换模式）：

| 场景 | 条数 | NaN 条数 | 是哪些 |
| --- | --- | --- | --- |
| 沙盘默认视图 | 15 | 0 | — |
| 沙盘聚焦地球后 | 15 | 6 | 示例 sun / mercury / mars / saturn / titan / neptune —— **具体哪几颗随相机状态变**，别当不变量 |
| `?proto=1` | 3 | 1 | sun（真的在相机背后） |

**看 verify 输出时有个坑**：`JSON.stringify(NaN)` 是 `null`，所以 results 里 `"x": null`
表示「这颗没有屏幕位置」，不是「探针坏了」。`hit-matrix` 的配对统计天然不受影响 ——
`NaN < 44` 恒为 false，NaN 条目不会进配对。

代码位置：`src/solar/SolarCanvas.tsx:1599-1607`（`Select-String -Path src/solar/SolarCanvas.tsx
-Pattern 'Number\.NaN, y: Number\.NaN' | Measure-Object` → 1）。

## 贴图预算与首屏（frame-time 为什么单列启动段）

1.1.2 之前是 `radius > 0.4 ? 512×256 : 256×128`，在 React 首次 render 里同步跑完：
**12 张 + 云层 = 1,114,112 px**，主线程一次阻塞 **380–500 ms**（注记在 `textures.ts:16-19`）。
现在切成两刀：`textureBudget()` 按屏幕占幅定尺寸（0.5 纹素/像素，128–2048 取 2 的幂，
见 `TEXELS_PER_SCREEN_PX`），像素循环按 `CHUNK_MS = 5` 分帧排队，每片落在下一帧 rAF 里。

实测（本机 1280×720，`node scripts/texture-report.mjs`）：

| 时刻 | `totalPixels` | 说明 |
| --- | --- | --- |
| `__solarReady` 瞬间 | **13** | 13 张全是 1×1 占位色，`pending=13`，首帧不阻塞 |
| 稳态总览位（~4s） | **106,496** | 13 × 128×64（`TEX_MIN_WIDTH` 档），`pending=0` |
| 聚焦地球后 | **≈0.79–0.82 M** | 两次实测 794,624 / 819,200，**不是定值** |

最后一行不稳定是设计使然：预算「只升不降」，聚焦动画期间谁上过屏就按谁的占幅升档，
两次运行的相机轨迹略有差别，升上去的档位就不同（`venus` 会到 1024×512、`clouds` 512×256）。
所以**别拿这个数当断言**；要断言就断 `pending` 归零、且每张不超过 `TEX_MAX_WIDTH` 档。

`?proto=1` 下 `__solarTextures()` 返回空列表（原型不生成程序化贴图），像素预算只对沙盘有意义。

这也是 `frame-time` **单列启动段、只判稳态**的原因：首帧要跑几何首建 + 13 张贴图排队，
一次性成本混进稳态，等于把「刹车」算成「车重」。

## frame-time 的红线怎么读

判的不是绝对毫秒，是比值。三个判据共用一把尺子：分母 = 本次机器基线。

```
normalized.ema  = steady.ema ÷ denominatorMs   阈值 1.6
normalized.p95  = steady.p95 ÷ denominatorMs   阈值 2.5
hitch：超过 max(50ms, 2.5 × denominatorMs) 的帧，150 帧里最多允许 2 次
```

`denominatorMs` 取两次基线里较大的那个：一次在遥测页**开起来之前**测，一次在**关掉之后**测。
基线本身是两件事：

- `vsync`：`about:blank` 空 rAF 循环 → 这台机器当前的 vsync 节拍（本地实测 8.3–16.9ms 都出现过）
- `raster`：1280×720 全屏定量着色器页，每帧固定 8 个 pass → 当前可用光栅吞吐

分母 = `max(raster.ema, vsync.ema)`。空循环那一路是**兜底**：闲机器上 8 个 pass 可能塞进一帧、
被 vsync 钉住，这时断言自动退化成「场景 ≤ 1.6 × vsync」——没信息的时候不假装有信息。
p95 和 hitch 共用 `2.5 × 分母` 这个常数，和旧判据同源：60Hz 机器上 2.5 × 16.7 = 42ms < 50，
所以 hitch 仍按 50ms 地板算。

红了先按这个顺序看：

1. `baseline.before.raster.ema` 和 `baseline.after.raster.ema` 差得远吗（比如 40 vs 20）？
   差得远 = 采样这段里机器状态变了，先重跑，别急着改代码。
2. `normalized.ema` 是多少？1.6 出头可能是真毛刺，**1.8 以上且两次基线接近**才是真回归
   （单帧光栅量真涨了，比如有人往每帧里塞了贴图重建）。
3. `steady.ema`（绝对 ms）和 `legacy.wouldFail` 只是留档：`wouldFail: true` 但全绿是**正常**的，
   它记录「旧规矩在同样这份采样上会红」，用来对比，不参与判定。
4. `normalized.baselineHitches`：同一把尺子量基线页。它也不为 0 说明这台机器本身在抖，
   此时的 hitch 结论不作数。

阈值 1.6 的来历写在 `verify.mjs` 顶部注释里：旧断言 `EMA ≤ 26ms` 在 60Hz 机器上等于
26/16.7 = 1.56×，新阈值取 1.6 保持同等严格度。

**这条断言的已知盲区（别指望它能抓小回归）**：实测「场景÷基线」在同一个代码版本上
摆到 0.44–0.90（忙时 0.44–0.61、加压 0.48、闲时 0.55；更早一轮探针里到过 0.90）。
阈值 1.6 意味着：**能抓住 2.5× 以上的持续光栅量回归，抓不住 1.5× 的**——那是噪声。
要比「两倍以内」更细的结论，只能关掉机器上别的东西、在安静状态下用绝对阈值复核，
不要指望这条相对断言。什么时候它会被推翻：如果哪天场景÷基线稳定收敛到 0.6±0.05
（比如把基线页成本调到跟空闲场景成本接近），阈值就该往 1.0 收，那时它能抓到 1.6× 的回归。

## proto-jitter 的维护契约

这条 pass 有四个**非显然依赖**，动任何一个都会**静默失效**——不报错，只是测不出东西。
（同样的说明也写在 `verify.mjs` 那段注释里，改代码前两边对一遍。）

1. **断言值绑当前实测，且绑估计量**：`modern.pp < 0.35`、`legacy.pp > 3 × modern.pp`、`legacy.pp > 0.2`。
   估计量是 **p10–p90 / 120 帧**（2026-10 从 max−min / 60 帧换过来的：max−min 只由两个离群点决定，
   测的是运气）。换后三次连续实测：modern 0.073–0.079、legacy 0.408–0.474，比值 5.2–6.5×。
   `max−min` 的口径仍输出在 `ppFull` 里（0.13–0.15 / 0.66–0.87），只留档不判定。
   ⚠ **legacy 下限从 0.4 挪到 0.2 是跟着估计量换算的，不是放宽**：0.4 是按 max−min 定的，
   换 p10–p90 后整体数值下移约 40%，0.4 离实测最小值只剩 2%，必然误红；0.2 保留了原来
   「约 2× 余量」的设计意图，真正负责区分的是 `3×` 那条。**再换估计量时，三个阈值要一起换算。**
2. **视口必须钉死 1920×1080，且 `dist = 1.2e7`**。这个距离是反解出来的：再近，圆盘左右缘
   出画面就测不到边缘；再远，f/视距 变小、信号被噪声吃掉。
3. **背景色不能写死** `#07090e`：输出色空间是 sRGB，`setClearColor` 的值会先转线性（实测落在
   8.94 亮度），采样器是从四角 4×4 块**实测**背景的。
4. **原型里必须关掉云层壳**（`spec.unit !== "meter"` 那个条件）**并冻结自转/公转**。
   那个 1.02× 半透明壳会把圆盘轮廓偏移 8px、噪声从 0.1 抬到 0.6px；自转会把贴图暗区
   转进转出遮罩，实测拉动质心 10–18px。开着任意一条，这条断言就废。

调试入口：`?proto=1&still=1` 是相机钉死状态，噪声底应在 0.08–0.10px；
**如果噪声底本身变高，是几何细分或云层开关被改了，不是浮点问题。**

## CI 与本地差异

**先说清楚：CI 现在不跑 verify。** `.github/workflows/build.yml` 只做 `npm run build`
+ 确认 `release/巡星.html` 产出 + 上传/发布。所以验收目前是「本机 / 发版前手动」的动作。
（要让 CI 接 verify，得给 runner 装 Edge 或用 `XG_EDGE` 指向 chromium，并接受它比本地慢一档。）

真接进来时要知道的四件事：

- **都是软件光栅**：CI runner 没独显，WebGL 走 llvmpipe/swiftshader；本地 Edge 也被强制
  `--use-angle=swiftshader`。两边同一类渲染路径，这是「基线比值」能跨机器迁移的前提。
- **rAF 都被 vsync 钉住**：CI 是虚拟显示器，基本恒定 60Hz（16.7ms）；本地这块面板实测
  出现过 10.3 / 16.7 / 8.3ms 三种中位数（高刷/动态刷新）。所以任何「默认 60Hz」的绝对阈值
  在本地都会失真——这也是 frame-time 不许写死 ms 的直接原因。
- **CI 更慢但更稳，本地更快但会被别的进程抢**。基线法两边都能吃；反过来，写死绝对阈值
  在两边都会误判（CI 偏红、本地偏绿）。
- **同机并行**：并发构建和并发 verify 都会污染结果，见下面「别和别人的构建撞车」。

## 别和别人的构建撞车

`release/` 不是只读的：`npm run build` 会先 `rm -rf release/` 再整份重建，整个过程一两秒。
如果**别人正好在跑构建**，你的 verify 会抓到半成品，症状很有迷惑性：

- `画布没起来（__solarReady 未置位）` + `控制台 404`
- 或者干脆来个 `pageerror: XXX is not defined`（页面拿到的是上一版 index.html、加载的是新版 JS）
- **而且每次红的 pass 不一样**（这次 desktop、下次 mobile-selected）——这是撞车的指纹，
  不是产品 bug

判断方法：看 `release/site/index.html` 引用的 `assets/*.js` 是不是真的存在，以及
`release/site` 的时间戳是不是落在你这次运行的时间窗里。确认是撞车就**别改代码**，重跑。

要拿到确定性结果，先冻一份快照再验：

```bash
cp -r release .tmp-release-snap          # 快照（.gitignore 已忽略 .tmp-*）
XG_RELEASE=.tmp-release-snap npm run verify
rm -rf .tmp-release-snap
```

另外，**两台 verify 同时跑也会互相污染**：双方的全屏 WebGL 互抢光栅，
`frame-time` 的分母会把对方的开销算成「机器基」。端口不会撞（自动往后找），CPU 会。

## 截图

截图落 `screenshots/`（已在 `.gitignore` 里，别提交）。每个 pass 一张，
`proto-jitter` 两张（modern / legacy 对照）。红了先看图，往往一眼就看出是画布黑屏还是布局塌了。

## scripts/ 里哪些是长期工具，哪些该删

长期（进仓库、要维护）：

| 文件 | 干什么 |
| --- | --- |
| `verify.mjs` | 本文件说的那套验收 |
| `texture-report.mjs` | 贴图预算 + 探针体检：打印 `__solarTextures()` 的像素/排队数与 `__solarProbe()` 的 NaN 哨兵条数（`node scripts/texture-report.mjs "?proto=1"`） |
| `check-single-file.mjs` | 单文件版自检：资源是否真的内联、没有残留外链 |
| `bake-textures.mjs` | 预烘行星贴图到 `.texture-src/`（生成物，目录已 ignore） |
| `make-icons.mjs` | 生成 PWA 图标（`public/icon-*.png`） |
| `package-release.mjs` | 把 dist 打成 `release/site` + `release/巡星.html` |
| `shoot.mjs` | 纯截图脚本，出图用，不判红 |

该删（临时/诊断用，`.tmp-*` 与 `screenshots/` 都已在 `.gitignore` 里，但别留着占地）：

- `.tmp-*.mjs` / `.tmp-*.json`：一次性探针。用完就 `rm`。
- `screenshots/_*.mjs`、`screenshots/_*.png`：调试期留下的诊断脚本和中间图，不是交付物。
- 历史上误提交过 `.tmp-scan.mjs`，已删并加进 `.gitignore`；提 PR 前扫一眼 `git status`
  里有没有新的 `.tmp-*` 混进暂存区。

