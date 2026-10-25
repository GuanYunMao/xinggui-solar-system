# 验证基线 — 1.3.4 动工前的现状快照

> 2026-10-25，`release/site`，Edge 1280×720 + 390×844，仓库 `1.3.3-snap.1`（git HEAD `efd2f1e`）。
> 本文件只钉现状：**没改任何断言**，也没动 `scripts/`。下面每个数字都能用第 6 节的两条命令复现。

## 0 结论

| 项 | 实测 |
| --- | --- |
| pass 条数 | **26**（`results.length === 26`，`failures: []`） |
| 退出码 | **0** |
| 总耗时 | **211.8 s**（脚本自报）/ 212.4 s（墙钟）；带计时副本复跑 216.6 s |
| 主产物 | `release/site/assets/index-DlE11WtS.js`，1 461 944 B，sha256 `5B2584AB1935020A553A4976D17B2ED2B1C08770F45B6163DE8C52330FACDDC4`（**已被覆盖**，见 0.1） |
| 单文件版 | `release/巡星.html`，1 510 716 B，sha256 `55723AF6B862DCCB03DB21CF722D7FC99937CF65212FCEC0543AF940A3783FED`（**已被覆盖**） |
| 样式 | `release/site/assets/style-BdsY_PSo.css`，47 963 B，sha256 `1833523C71DC821E8325D76A4E54EBA2A74E07FE646AA6A331EDE0FE1B6C3E10`（**已被覆盖**） |
| 站点入口 | `release/site/index.html`，1 076 B，sha256 `F2235E04A9D817C1EA45CE524E416F0E98C0C78A642BEE71992BA03C5B780DB4` |
| 归档 | `runs/2026-10-25T10-26-20-336Z__assets_index-DlE11WtS.js__software(swiftshader).json` |
| 源码状态 | 构建与运行期间工作树干净，唯一未跟踪文件是 `PLAN.md`；HEAD `efd2f1e`（2026-10-25 17:06 +0800） |
| 构建 | `npm run build` 退出码 0，vite 报 7.20 s（2191 modules） |

产物名与 09:06 那次归档（`index-DlE11WtS.js`）一致，说明这份 release 是同一份源码构建出来的。

### 0.1 这份基线属于哪个构建（别拿它和磁盘上的现在比）

构建与两次全量运行（10:22Z–10:30Z 之间连着跑两次）用的是**同一个** `release/`，产物名 `index-DlE11WtS.js`，两次都是 26 条全绿、退出码 0。

**定稿时 `release/` 已经被另一次构建覆盖**（本地 18:31:12，新产物 `index-B5vieLsf.js` 1 461 966 B / `style-C2-AwfAC.css` 48 001 B / `巡星.html` 1 510 776 B）。同时工作树里出现了未提交的 1.3.4 改动：`src/solar/gate.ts`、`src/solar/store.ts`、`src/App.tsx`、`src/solar/ModeBadge.tsx`、`src/styles.css`、`CHANGELOG.md`、`scripts/check-shape.mjs`，以及新增的 `scripts/check-spec-1.4.mjs`、`scripts/gate-predicate.test.mjs`、`src/solar/observe.ts`（按定稿那一刻的 `git status` 抄的，之后还会变）。

所以：**比对新旧一律看 build 名**（`index-DlE11WtS.js` = 本基线），别看目录 mtime；现在直接重跑 verify 验的是新构建，不是这份基线。要重跑这份基线，得用 git 回到 `efd2f1e` 重新 build，再用 `XG_RELEASE` 指向那份冻结目录。

## 1 跑法与判定来源

```bash
npm run build            # vite build + scripts/package-release.mjs
node scripts/verify.mjs  # 全量约 211 s，中途别杀
```

判定只读两处：`results[]` 里每条 `pass` 名，以及 `failures[]` 的字符串前缀。`failures` 为空 → 退出码 0；有任何一条 → 退出码 1；`XG_ONLY` 过滤后 0 条被跑 → 退出码 2（"0 条不是全过，是没验"）。

`results` 的顺序就是执行顺序，26 条全部在这里（第 2 节的序号与它一致）。

## 2 26 条逐条清单

耗时列的来源见 6.2：它是"相邻两次 `results.push` 的墙钟差"，所以**同一次页面加载里成组产出的条目显示 0.0 s**，成本记在组首条上。

| # | pass | 测什么（判据，带本次实测值） | 类别 | 耗时 s |
| --- | --- | --- | --- | --- |
| 1 | `desktop` | 1280×720 首屏：`__solarReady` 置位、控制台 0 报错、`canvas === 1`、`overflowX ≤ 1px`、点「地球」后卡片 `selected === "地球"`、画布 25 块像素 `meanLum ≥ 2` 且非黑块 ≥ 50%（实测 18.62） | 结构 + 像素地板 | 7.0 |
| 2 | `mobile` | 390×844 @3x：同上四项（不点选）+ `__solarQuality().effectiveDpr ≥ mobileDprFloor`（实测 1.279 ≥ 1.25）；探针缺失判红。**同一加载里产出下面 4 条 hud 的原始测量** | 结构 + 数值 | 11.6 |
| 3 | `hud-layer` | 点「图层」：`[data-overlay-open="true"]` 计数 1、`aria-expanded` `true`；再点一次 → 0 与 `false` | 结构量（精确计数） | 0.0 |
| 4 | `hud-gesture` | 详情卡把手：竖蹭 15px 不换档且卡片高差 ≤ 1px；横滑 30px 不换档；上拖 80px **只走一档**到「全屏」且 `dl` 列数 === 1；下拖 80px 只回一档「半屏」 | 结构量 | 0.0 |
| 5 | `hud-card-bar` | tap 到「收起」档：`article` 高 ≤ 7rem + 1px、computed `max-height` = 7rem ± 0.5、标题仍「地球」 | 结构量 | 0.0 |
| 6 | `hud-chips` | 星球列表收起⇄展开⇄收起：`aria-expanded` 三态；按钮文本 `/^全部 \d+$/` 且数字 **等于同行 chip 数**；收起态横向溢出 > 20px（判据前提）；展开后 `flex-wrap === "wrap"`、溢出 ≤ 1px、行高比收起态高 > 20px；再收起行高回到 ±1px | 结构量（同次自比） | 0.0 |
| 7 | `mobile-selected` | 手机视口 + 点选：`selected === "地球"`、dpr 红线、抬头「已校准」态样本（供 `hud-header`） | 结构量 | 4.7 |
| 8 | `hud-header` | 模拟历：非空、`display ≠ none`、左右都在视口内、不被左侧品牌组压住；`header.scrollWidth - clientWidth ≤ 1px`；视口 < 640px 时 `.eyebrow` 必须 `display === "none"`。两格样本（锁态 / 已校准） | 结构量（几何 + 二值） | 0.0 |
| 9 | `single-file` | `release/巡星.html` 走 `file://`：ready、0 报错、`canvas === 1`、无横向溢出、画布非全黑 | 结构 + 像素地板 | 2.4 |
| 10 | `pointer-misselection` | Space 冻结；找「小天体盘外 6px、`elementFromPoint === CANVAS`、`__solarPick.at()` 命中同一 id」的点 → 按住 `#chip-jupiter` 拖过去松手 → `?body=` 不变、`aria-pressed=true` 芯片数不增、`article` 不增。两条对照：点地球必须出卡片、画布拖 40px 不许选 | 结构量（无阈值） | 4.7 |
| 11 | `orbit-planes` | 三个模拟时刻读世界偏移 → 沙盘 8 行星轨道法向量两两夹角 **< 0.01°**（实测 0.000）；实境 `?proto=1` 月球法向量对黄道倾角 **5.145° ± 0.5**（实测 5.099） | 数值（几何） | 3.9 |
| 12 | `jupiter-spot` | `?diag=1` + Space + `__solarPlace` 把斑转到正对相机；扫 8 个相位取最亮/最暗帧：受光斑区 `luma ≥ 20` 且 `E=(R−G)/(R+G+B) ≥ 0.18`（实测 88.03 / 0.2775）；夜面同一判据**必须不成立**（实测 5.58）。比值门只记录 | 数值 + 像素 | 13.3 |
| 13 | `hud-autohide` | 跑默认配置：两块 `[data-hud-chrome]` 各 1、初始展开、指针进场景 5000ms 内收起（`#chip-row`=0、`range`=0、`header` 仍在、把手出现）、回顶部/底栏各自展开、负对照（浮层开着静置 2600ms 不收）、Escape 后再静置能收、收起的 chrome **不许吃点击**（`elementFromPoint === CANVAS`） | 结构量（DOM 计数 + 属性） | 10.5 |
| 14 | `hud-wheel` | 指针压在 `#chip-earth` 上滚 4 格：`d0 ∈ 4.8 ± 0.01`（实测 4.8）→ `d1 > 4.8`（实测 11.1794）；`elementFromPoint` 前后各读一次都必须是 `BUTTON#chip-earth` | 结构量 + 方向 | 5.1 |
| 15 | `eclipse-hemisphere` | `moon:earth` 扫 13 模拟单位：正侧组（`dot > 0` 且 `cover ≥ 1`）最亮一帧比值 **≤ 0.5**（实测 0.291）；反侧组（`dot < 0`，实采 dot ≤ −0.99）最暗一帧比值 **≥ 0.85**（实测 0.991）；参照/正侧/反侧三组各至少采到 2 帧（每组目标 4 帧），不足即红 | 数值 + 像素 | 40.3 |
| 16 | `tidal-lock` | 6 颗 `locked: true` 卫星：t=1 与 t=1.35 两个时刻「近地面朝向」与「指向母天体」夹角之差 **< 1°**（月球 0.166°，其余 5 颗 0.000°）；缺探针/缺卫星判红 | 数值（几何） | 2.2 |
| 17 | `card-scroll` | 指针压在详情卡可滚正文上逐格滚：未到底的每一格 `\|ΔdistTarget\| ≤ 0.01`；到底后那一格允许交回场景，但幅度必须在画布单格的 **0.65–1.35×**；两类样本缺一类即判红 | 数值（同次自比） | 4.8 |
| 18 | `frame-time` | 稳态 150 帧：归一化 EMA **≤ 1.6×**（实测 0.67，分母 40.2ms）、归一化 p95 **≤ 2.5×**（实测 0.68）；hitch 只告警不判红；启动段只记录 | 归一化观测量 | 17.7 |
| 19 | `hit-matrix` | `__solarProbe()` 天体数 **=== 15**（判）；屏幕重叠对数**只记录**（实测 24，注释明令禁止给它加阈值） | 结构量（计数） | 0.0 |
| 20 | `follow-jitter` | 点地球后等相机 settled（连续两次 `depth` 相对差 < 0.1%），再采 90 帧目标屏幕位置峰峰值 **< 0.5px**（实测 0）；未 settled **判红**（不是跳过） | 数值 | 3.7 |
| 21 | `proto-real` | `?proto=1`：探针天体数 **=== 3**、地球钉在屏幕中心偏移 **≤ 1px**（实测 0）、画布非全黑（实测 12.02） | 数值 + 像素地板 | 9.0 |
| 22 | `proto-jitter` | 像素回读 120 帧：现代顶点路径 p10–p90 **< 0.35px**（实测 0.081）；legacy 对照必须 > 3× 现代且 > 0.2px，否则按「对照失效」判红 | 数值（归一化） | 13.5 |
| 23 | `zoom-budget` | 从 home 连发 wheel：缩到太阳 3R 的格数 **≤ 15**（实测 11；单次间隔 > 300ms 按环境抖动不判红）；最深视距 **≥ 1.2R × 0.995**（实测 1.221R）；画布边缘 12 块星空平均亮度 **≤ 背景 8.94 × 4 = 35.74**（实测 18.56） | 数值 + 归一化观测 | 7.4 |
| 24 | `sun-occlusion` | 跟随木星并把太阳摆到木星盘面中心：本轮未对齐**直接红**（对齐率另留档）；对齐后木星投影中心 24×24 平均亮度 **≤ 60**（实测 13.05，Δ 26.4px） | 结构量 + 像素 | 3.8 |
| 25 | `boot-stage` | 默认 + `?bootstage=1\|2\|3` 四格：`ready` 必须置位、四格天体数都 **=== 15**、默认路径 ready 时 belt 已挂、`?bootstage=3` belt 已挂、1/2 不许有 belt；`elapsedMs`/长任务**只记录** | 半结构量 | 5.9 |
| 26 | `camera-clearance` | 跟随月球 ≥ 3 个周期：第 2 周期起「相机到地心距离」min **≥ 1.0**（实测 1.717；第 1 周期 0.954 只记录）、稳态不许进任何天体内（实测 0）；过渡段三相位（+0 / +0.85 / +1.70 模拟秒）「距离 ÷ 半径」最小 **≥ 1.0**（实测 1.12） | 数值（几何） | 29.1 |

合计 200.6 s，另有 **16.0 s 未归属**（浏览器启动、端口、环境读数那两次 PowerShell 调用、收尾打印 JSON）。两项相加 = 216.6 s，与计时副本自报的总耗时一致。

## 3 软断言清单（1.3.4 会从这里漏）

判"软"用三条尺子，比"只判元素存在"更细一点：**缺了也绿**、**只记录不判**、**地板宽到看不出退化**。每条给加固建议，这一轮一律不改。

### 3.1 C 类：采样缺失就放行 —— 真正的假绿通道（3 条）

| # | 条目 | 现状 | 加固建议 |
| --- | --- | --- | --- |
| C1 | `pointer-misselection` | 找不到「盘外 6px + `at()` 命中同一 id」的夹具点 → `available: false` 只记录，**不判红**（`verify.mjs:1944`） | `available: false` 直接进 `failures`。理由：画布上必然存在小天体，找不到只能是夹具/探针坏了，这与 `sun-occlusion` 判"未对齐即红"是同一类。HUD 一改布局，这条最容易静默失效 |
| C2 | `zoom-budget` 星空亮度 | `sky.available === false` 只 `console.error`（`verify.mjs:2834`） | 探针读不到 → 判红，跟同一条里 `readSunState` 缺失判红的口径对齐 |
| C3 | `camera-clearance` 周期覆盖 | `simSpan < 2.9` 周期只 `console.error`（`verify.mjs:3272`） | 采不到 3 个周期就判红：判据本身就是"3 个周期里持续正确"，采样不足等于没判。参考 `follow-jitter` 的 `settled:false` 已从"跳过"改成判红（`verify.mjs:2517`），那是先例 |

### 3.2 D 类：地板宽到看不出退化（5 条共用一条判据）

| # | 条目 | 现状 | 加固建议 |
| --- | --- | --- | --- |
| D1 | `desktop` / `mobile` / `mobile-selected` / `single-file` / `proto-real` 的"画布不是全黑" | 25 块像素 `meanLum ≥ 2`、非黑块 ≥ 50%（`verify.mjs:308`、`360`）。健康值 18.62 / 12.02，余量 **6–9×**。整屏暗 80% 仍然绿 | 二选一：①地板抬到实测的一半（≥ 9），并写明"从此地面亮度变化会误红"；②加一条同次运行内自比 —— 背景色由 `#07090e` 现算（已有 `SKY_BG_LUMA` 的先例），判"画布均值 ≥ 背景 × 0.8"。别写成绝对值 |

### 3.3 B 类：明示只记录（6 条）

| # | 条目 | 现状 | 加固建议 |
| --- | --- | --- | --- |
| B1 | `hit-matrix.overlapping` | 12–24 随相位浮动，注释写成"禁止加阈值"（`verify.mjs:2454`） | 别加。**改加**一条没人守的：15 颗天体在 `__solarPick.candidates()` 里的屏幕半径都必须 > 0（半径 0 = 投影失败，现在这态活得过整轮） |
| B2 | `jupiter-spot` 比值门 | 受光 0.429–0.948 与夜面 0.250–0.608 重叠，无区分力，已降级为记录 | 不加回去。补的是"位置"：现在只验 luma 与 E，斑转到哪就在哪判，没有"斑该出现在盘面哪个象限"的判据 |
| B3 | `hud-autohide.collapsedAtMs` | 只记录，不判 ==2000（`setTimeout` 只能迟到） | 保持。补一条往返：收起后用**点击**（不是 pointermove）展开把手，现在只测了指针唤醒 |
| B4 | `frame-time.hitch` | 只告警（`HITCH_ALLOWANCE = 2`） | 保持。归一化 EMA/p95 已经覆盖 |
| B5 | `boot-stage.elapsedMs` / `lt*` | 长任务只记录 | 保持（没有稳定负载口径，写死就是重犯 26ms 的错） |
| B6 | `camera-clearance.jump*` | 单帧跳变只记录 | 可做归一化：`jumpMaxPerFrame ÷ jumpMedianPerFrame` ≥ 20× 判红。同次运行内自比，不吃机器负载 |

### 3.4 A 类：只判"在"，不判"对"（4 条）

| # | 条目 | 现状 | 加固建议 |
| --- | --- | --- | --- |
| A1 | `hud-header` 模拟历 | 只判非空 + `display` + 几何位置，**不判文本内容**（`verify.mjs:675`） | 加格式判据：`/^第\s*\d+\s*日$/`，再把解析出的数字与 `__solarTime.now()` 对比（同一时刻两次读数差 ≤ 1）。改历法措辞会被这条看见 |
| A2 | `hud-chips` 数量 | 按钮写的数字必须等于**同行 chip 数** —— 两边都从 DOM 来，槽位表整体改小/改大仍绿（`verify.mjs:750`） | 给 chip 数一个独立来源：沙盘 15 颗天体 → 收起态 9 颗是有意过滤，把这个 9 的理由写成断言（例如"过滤掉卫星后剩 9 颗"），而不是让它自证 |
| A3 | `hud-layer` / `hud-gesture` / `hud-card-bar` | `aria-expanded`/`aria-pressed` 二值 + 同次自比 | 这三条本身可接受（结构量的正确定义）。缺的是"浮层打开时滚轮归谁"这类交互交叉项，1.3.4 不铺 |
| A4 | `hud-wheel` 幅度 | 只判 `d1 > 4.8 + 0.01`，没有最小幅度（`verify.mjs:1708`） | 加下限：`d1 ≥ 4.8 × 1.05`，或复用 `card-scroll` 的"画布单格 1.155×"口径。现在把滚轮灵敏度砍到 1%，这条仍绿 |

## 4 1.3.4 最可能假绿的 6 条（按风险排）

1. **解锁流程本身：0 条覆盖。** 26 条里没有一条从「设定时刻 → +1 年 → 水星 → 关名称 → 关轨道」走到解锁。解锁态是 `init script` 预置 localStorage 造出来的（`verify.mjs:2167` 的 `hud: "unlocked"`）。门谓词从"按一次 +1 年跳到第 365.25 天"换成几何谓词之后，**没有任何一条 pass 会红**。1.3.4 的 `unlock-flow` 断言是这一版唯一的止血点。
2. **`hud-chips`：槽位表 12 → 实际可达。** 判据只有"按钮数字 == DOM chip 数"（当前 9 == 9），那 12 个槽位里哪些不可达，没有任何 pass 在判。把不可达的删掉，这条从头到尾不动。
3. **`hud-header`：模拟历只判非空。** 三条提示改现象、历法措辞调整，这里一律看不见。加上"三条提示"本身没有任何 pass 在读它们的文案，1.3.4 的文案改动等于零断言。
4. **画布像素地板（5 条共用）。** 改文案、改布局把亮度从 18.62 压到 5，仍然 ≥ 2，仍然绿。
5. **`pointer-misselection` 的夹具放行分支。** 改 HUD 让"盘外 6px"那个点不可达（比如 chip 行变高、遮住盘面），它会以 `available: false` 绿着退出 —— 看上去"误选没发生"，其实根本没测。
6. **深链 / `progress.ts`：0 条覆盖。** `pointer-misselection` 只读"`?body=` 没变"，不读"什么时候该写、写进去之后谁读"。1.3.4 的"深链不记访问"改动没有断言接得住。

## 5 反面风险：文案耦合成误红

1.3.4 改文案时，下面这些是**硬编码字符串**，撞上会红，而且是"预期改动"造成的红。撞了先判断是哪一类，再决定改判据（改判据要单独说明理由，见 PLAN 制度 4）。

| 断言位置 | 硬字符串 |
| --- | --- |
| `desktop` / `mobile-selected` 的 `expectSelected` | `地球` |
| `hud-card-bar` | 标题 `地球` |
| `hud-chips` | `收起`、`/^全部 \d+$/` |
| `hud-gesture` / `hud-card-bar` 档位 | `aria-label` 前缀 `详情卡高度：`，档位 `全屏` / `半屏` / `收起` |
| `hud-layer` | `button[aria-label="图层"]` |
| `hud-autohide` | `button[aria-label^="自动收起"]`、`button[aria-label="展开天体列表"]`、`button[aria-label="展开操作台"]` |
| `hud-header` | `header p.text-lg`、`header .eyebrow` |

## 6 复现与核对

### 6.1 两条命令

```bash
npm run build
node scripts/verify.mjs     # 约 211 s；exit 0 = 26 条全过
```

第二次全量（216.6 s）在同样代码上跑，26 条同样全过，说明 +4.8 s 是机器噪声，不是产物差异。

### 6.2 耗时列怎么来的（临时副本，不在 `scripts/` 里）

`verify.mjs` 本身不记录每条的耗时，只有 `meta.elapsedSeconds` 一个总数。为了拿到分项，把 `scripts/verify.mjs` 原样复制成 `.tmp-t9-verify-timed.mjs`，只做 3 类与判据无关的改动（共 5 处文本替换）：

1. `./verify-archive.mjs` → `./scripts/verify-archive.mjs`（副本挪到项目根）；
2. `root` 从 `..` 改成副本所在目录；
3. 给 `results` 加一层 `push` 包裹，记录每次 push 的墙钟，收尾写进 `.tmp-t9-timings.json`。

断言代码一行未改，两份脚本的 `failures` 都是 `[]`。局限两条：同一次加载里成组产出的条目（`hud-layer`/`hud-gesture`/`hud-card-bar`/`hud-chips`/`hud-header`/`hit-matrix`）显示 0.0 s，成本归给组首条；`frame-time` 的机器基线 A 在它 push 之前、基线 B 在之后，所以它的 17.7 s 含基线 A 不含基线 B。

临时文件（跑完可删）：`.tmp-t9-patch.cjs`、`.tmp-t9-verify-timed.mjs`、`.tmp-t9-timings.cjs`、`.tmp-t9-timings.json`、`.tmp-t9-build.log`、`.tmp-t9-verify.log`、`.tmp-t9-verify-timed.log`。

### 6.3 别踩的两个坑

- 文中引了十来处 `verify.mjs` 行号。1.3.4 一旦往 `verify.mjs` 里加断言，这些行号会漂，改引用时别只改数字不看内容。
- `release/` 是共享产物目录：本轮实测撞上了一次 —— 我这一轮 10:30Z 结束，10:31Z `release/` 就被别人的 build 覆盖了。另一个人正在 `npm run build` 时，`rm` + 重建会让页面抓到半成品（`__solarReady` 不置位 + 资源 404）。要并行就用 `XG_RELEASE` 指一份冻结快照，并在结果里核对 build 名。
