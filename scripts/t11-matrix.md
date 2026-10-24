# t11 命中矩阵 + 根因判定（实测，1.2.1 发布快照）

> 环境：`release/site` 冻结快照（1.2.1，`37259a8`；快照 `.tmp-t11-release` 测完已删）。桌面 1280×720 dpr1 鼠标；手机 390×844@3x touch（CDP `Input.dispatchTouchEvent`）。Edge + swiftshader。
> 夹具：`.tmp-t11-matrix.mjs`（24 点 + 手势）、`.tmp-t11-round2.mjs`（干净 G1 / shim）、`.tmp-t11-round3.mjs`（D2）、`.tmp-t11-matrix-paused.mjs`（暂停态矩阵）、`.tmp-t11-round5.mjs`（精确 G1）、`.tmp-t11-round6.mjs`（触屏缝隙）。
> 原始读数：`screenshots/t11-matrix.json`、`t11-matrix2.json`、`t11-matrix-paused.json`、`t11-d2.json`、`t11-round5.json`、`t11-touch-gap.json`。

## 0. 一句根因判定

**D1：`PickLayer.onUp` 只判「这一回合有没有拖动」，不判「这一回合是在哪儿按下的」。** 在一颗芯片/一个按钮上按下、把指针拖到画布空白处松手，拾取层会拿上一次画布交互留下的 `dragGuard.moved=false`，把**松手点**下的天体当成一次点选 → 弹卡片、对应芯片高亮、相机飞过去。

放大它的是 **D2：22px 热区与环带对鼠标也生效**（水星盘半径 3.19px，离盘心 9.2px 的空白点仍判命中）。D2 是触屏的承重件，**先不动**（按 captain 定的顺序：先修 D1，看用户还骂不骂）。

## 1. 命中矩阵（桌面 1280×720，暂停模拟，20 点）

暂停是为了让「pick 是谁」可复现（天体不动、坐标不漂）。`hit` = `document.elementFromPoint`；`pick` = `__solarPick.at(x,y)`；`sel` = `?body=` 的变化。

| # | 点位 | 坐标 | hit（谁吃点击） | pick | 点下去选中 |
| --- | --- | --- | --- | --- | --- |
| 1 | 左上角空白 | (12,12) | CANVAS | null | 不变 |
| 2 | 抬头左侧空白 | (4,28) | CANVAS | null | 不变 |
| 3 | 抬头中部空白 | (100,40) | CANVAS | null | 不变 |
| 4 | 徽标簇左侧 8px | (1025,28) | CANVAS | null | 不变 |
| 5 | 芯片行上方 6px（`mt-3` 带） | (300,62) | CANVAS | null | 不变 |
| 6 | 芯片行**缝隙**（两芯片之间） | (176,90) | `DIV#chip-row` | null | 不变（缝隙不漏给画布） |
| 7 | 芯片行下沿 2px | (300,118) | CANVAS | null | 不变 |
| 8 | 画布正中 | (640,300) | CANVAS | null | 不变 |
| 9 | 画布左侧 | (200,400) | CANVAS | null | 不变 |
| 10 | 卡片左外 36px | (900,370) | CANVAS | null | 不变 |
| 11 | 卡片内 4px | (940,370) | DIV（卡片） | null | 不变（卡片吃点击） |
| 12 | 卡片左边界外 1px | (935,370) | CANVAS | null | 不变 |
| 13 | 底栏暂停键中心 | (145,662) | SPAN（按钮内） | null | 暂停（正常） |
| 14 | 底栏内空白（padding 区） | (640,585) | FOOTER | null | 不变（底栏空白不漏） |
| 15 | 底栏上边界外 1px | (640,578) | CANVAS | null | 不变 |
| 16 | 右侧 10px 空白 | (1270,300) | CANVAS | null | 不变 |
| 17 | 底栏最底部 | (640,715) | FOOTER | null | 不变 |
| 18 | 左侧 30px | (30,300) | CANVAS | null | 不变 |
| 19 | 场景下部（卡片左边） | (640,500) | CANVAS | null* | 不变* |
| 20 | 芯片行与卡片之间 | (700,122) | DIV | null | 不变 |

\* 同一格在**未暂停**的那一轮命中过 `titan` 并选中了土卫六 —— 天体相位不同，同一坐标的 pick 会变。这条正好说明 D2 的性质：**「空白」不是一个固定坐标，而取决于那一刻有没有天体落在 22px 热区里**。

**矩阵的结论**：普通点击在 20 个空白/交界点上**没有一次误选**。也就是说用户看到的「点空白→芯片亮」不是「点一下就选」，而是**按下与抬起不在同一元素**时的那条路径（见 §2），或者点在了小天体的隐形热区里（见 §3）。

手机 390×844@3x（touch）：

| # | 点位 | 坐标 | elementFromPoint | 实际点击目标 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 21 | 抬头左侧空白 | (60,20) | CANVAS | CANVAS | 不变 |
| 22 | 芯片行缝隙 | (168,110) | `DIV#chip-row` | **`BUTTON#chip-venus`** | **选中金星** |
| 23 | 卡片上沿外 8px | (195,343) | CANVAS | CANVAS | 不变 |
| 24 | 底栏按钮间隙 | (195,787) | FOOTER | FOOTER | 不变 |

**#22 是触屏独有的**：缝隙（mercury 右缘 164、venus 左缘 172）正中 168，`elementFromPoint` 是行 div，但**pointerdown 的目标就是 `chip-venus`** —— Chromium 的 touch adjustment（点击目标微调）把缝隙里的 tap 重定向到了最近的 clickable，click 的 clientX 也被改写成 175。桌面鼠标没有这个行为（矩阵 #6 命中行 div、无选中）。

## 2. D1：手势复现（修复前 / D1 shim 投影修复后）

**修复前**（`.tmp-t11-round5.mjs`，暂停态，可复现）：

1. 按在 `#chip-jupiter` 中心 (434,90)（pointerdown 目标是芯片里的 `SPAN`）；
2. 拖动到 (685,374) —— 水星盘心外 **9.2px** 的纯空白（水星盘半径 3.19px，该点 `__solarPick.at() = "mercury"`、`elementFromPoint = CANVAS`）；
3. 松手。

结果：`?body=mercury`、卡片「水星」、`chip-mercury` 高亮、相机飞向水星。**按下的芯片是木星，亮起来的是水星** —— 这就是用户说的「点空白/划过界面，旁边的芯片亮起来」。事件日志：`pointerdown@SPAN(434,90) → focusin@chip-jupiter → pointerup@CANVAS(685,374) → click@MAIN(685,374)`。

**D1 shim**（运行时把「抬起目标=画布 且 按下目标≠画布」的 pointerup 拦掉，等价于 `onUp` 里加 `if (!dragGuard.active) return`）：同一手势 → `?body=null`、无卡片、无高亮、`shim.blocked=1`；对照：正常点 `#chip-earth` 仍然选中地球。

**同一组点的对比**：`t11-g1-before.png`（选中土星：卡片「土星」+ 芯片「土星」高亮 + 相机已飞）↔ `t11-g1-after.png`（同一手势加 shim：总览原样、无卡片、无芯片高亮）。两图同一视口、同一产物、同一手势，只差 D1 shim。

补充证据：`switching` 期间这条路被 `onUp` 里的 `if (useSim.getState().switching) return;` 挡住（`.tmp-t11-round2.mjs` 的 E 组：点地球后 120ms 立刻做同一手势 → 仍是 earth）。**第一轮我没复现出来，就是被它遮蔽的**——复现这条 bug 必须先等相机静止。

## 3. D2：22px 热区 + 环带（放大器，先不动）

| 量 | 实测 |
| --- | --- |
| `HOT_RADIUS_CSS` | 22（不区分 pointer type，`pick.ts:15`） |
| 水星盘半径 | 3.19px；点离盘心 **9.2px** 的空白 → `at()=mercury`，点下去真的选中「水星」 |
| 金星盘半径 | 6.15px；点离盘心 **12.1px** 的空白 → 选中「金星」 |
| 土卫六盘半径 | 1.98px；热区边缘 = 22px ≈ **11 倍**盘半径 |
| 土星环热区最远 | 盘心外 **50px**（`ringOuter=4.35` 世界单位；环内任意点都判 tier 0.5） |

平点空白就选中（不需要任何拖动）——`t11-d2.json` 的 `d2Clicks`：8 个点全部 `selected` 命中。

## 4. 另外三条候选：逐条实测结论

| 候选 | 实测 | 结论 |
| --- | --- | --- |
| (b) `.hud-btn:active` 卡住 | 在 `chip-earth` 上按下 → 拖到 `chip-venus` 松手：按下期间 `transform: matrix(0.980168,…)`（:active 正常），松手后 `transform: none`；click 落在 `DIV#chip-row`，没有选中 | **排除**（只影响按下瞬间，不留残留、不产生选中） |
| (c) 抬手的合成 click 落到相邻控件 | 桌面鼠标：上述跨芯片手势的 click 落在行 div（down/up 的共同祖先），不触发任何芯片；触屏：只有 §1 #22 那种 **touch adjustment** 重定向（不是 click 合成时序） | **桌面排除**；触屏是另一条（见 #22） |
| (d) `:focus-visible` 误留 | 纯鼠标：点芯片后 `activeElement=chip-earth`、`matches(':focus-visible')=false`、`outline: none`；Tab 后为 true（正常） | **排除**（但见下） |

**一条附带现象（不是缺陷）**：键盘→鼠标混用时，Chromium 会把随后的鼠标焦点算作 `:focus-visible` —— 按一次 Esc 再点芯片，`outline` 变成 `solid 2px rgb(231,237,245)`（`t11-focus-ring.png`）。这是 focus-visible 的既定启发式（最近一次输入是键盘），不是我们的样式问题；只在「键盘刚用过」时出现，且是外圈轮廓、不是「选中」填充。

## 5. 修复方案（跨领土，交 engineer）

**D1（一行 + 一个防御）**，`src/solar/SolarCanvas.tsx:2565-2573` 的 `onUp`：

```ts
const onUp = (ev: PointerEvent) => {
  if (ev.button !== 0) return;            // 右/中键不选
  if (!dragGuard.active || dragGuard.moved) return;  // ← 关键：抬起必须起始于画布
  if (useSim.getState().switching) return;
  …
};
```

为什么 `active` 就够：`dragGuard.active` 只在 `<Canvas onPointerDown>`（`SolarCanvas.tsx:2951-2955`）里置 true、在 `<Canvas onPointerUp>` 里置 false，**只有目标为画布的事件会动它**。按下在 HUD 上时它保持 false → 这条 pointerup 不选。

为什么不动 22px：它是触屏承重件（README「总览档木卫一圆盘只有 0.5px 仍点得中」就是靠它）。真要收，只能按 `(pointer: fine)` 分档，且要另做验收——不是这次。

## 6. 断言提案（交 verifier；结构量，可判红）

新增一条 pass（建议挂桌面 1280×720，与 `desktop` 同参数，独立 context 免污染）：

1. 打开 `base`，等 `__solarReady`，**按 Space 暂停**（否则天体在动，坐标会漂）；
2. 找夹具点：从 `__solarPick.candidates()` 里挑 `radiusPx < 12 && ringOuter === 0` 的天体，取距盘心 `radiusPx + 6` 的四向点，要求 `elementFromPoint === CANVAS` 且 `__solarPick.at(x,y) === 该 id`；
3. 手势：`#chip-jupiter` 中心 mouse down → 移到夹具点 → mouse up；
4. **判据（结构量，无阈值）**：`?body=` 与手势前相同、`#chip-row button[aria-pressed='true']` 为空、`article` 不存在；
5. **对照**（保证夹具本身没坏）：① 直接点 `#chip-earth` → `?body=earth`；② 画布上按下拖 40px 松手 → 不选；
6. 找不到夹具点时不判红，但要在 results 里写 `fixture: null`（像 `sun-occlusion` 的对齐失败那样），否则这条会静默变成空跑。

盲区：只覆盖「按下在芯片、抬起在空白」；不覆盖 D2（22px 热区是有意设计，判红会误伤触屏），也不覆盖触屏的 touch adjustment 重定向。

## 7. 命令与退出码

```
node .tmp-t11-matrix.mjs          exit 0   # 24 点矩阵 + G1/G2/G3/G5/G6（未暂停，取证用）
node .tmp-t11-round2.mjs          exit 0   # 干净 G1（选中 saturn）+ D1 shim（null）+ 焦点环
node .tmp-t11-round3.mjs          exit 0   # D2：水星 9.2px / 金星 12.1px / 土星环 50px
node .tmp-t11-matrix-paused.mjs   exit 0   # 暂停态矩阵（本文 §1 的数）
node .tmp-t11-round5.mjs          exit 0   # 精确 G1（松开在水星盘外空白 → 选中水星）+ shim → null
node .tmp-t11-round6.mjs          exit 0   # 触屏缝隙 #22（pointerdown 目标 = chip-venus）
git status --porcelain -- src     有 1 行：engineer 的 SolarCanvas（Probe.nearest.radius，t10），不是我的改动
```

## 8. 什么情况会推翻这份结论

- 如果 D1 修好后用户还说「点空白就亮」，那就不是 D1 单独造成的：先看是不是 D2（平点空白 → 选中 22px 内的小天体），再谈按指针类型分档。
- 如果 `onUp` 的 `active` 判断加上后出现「正常点星选不中」：说明有别处在画布外置 `dragGuard.active`，要查 `Canvas` 的 `onPointerDown` 是否被 HUD 元素的 pointer capture 抢走。
- 手机 #22 那条（缝隙 → 右边芯片）如果被认为是缺陷：它来自 Chromium 的 touch adjustment，HUD 侧只能靠加大芯片间距/加不可点的填充来缓解，删不掉。
