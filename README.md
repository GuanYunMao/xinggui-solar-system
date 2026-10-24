# 巡星·未至之境

可交互的三维太阳系。一个自包含的 HTML 文件，双击就在浏览器里跑，不需要服务端。

同一份场景有两种看法：**沙盘**（压缩比例的轨道仪，看结构）和**实境**（1:1 米制比例、地月取景，看尺度）。两者之间隔着三条校准动作，做完才能进实境。

## 现在到哪了

| | |
| --- | --- |
| 线上正式版 | **1.1.6**（`releases/latest` 指向它） |
| 开发中 | **1.2.0**（当前快照 `1.2.0-snap.14`，只出 Actions artifact，不占正式号） |
| 产物 | `release/巡星.html`（单文件）、`release/site/`（静态站点） |

固定下载地址，跨版本不变：

```
https://github.com/GuanYunMao/xinggui-solar-system/releases/latest/download/xinggui.html
```

`xinggui.html` 这个资产名是承诺，地址已经被人收藏过，改了就 404。本地中间产物叫 `release/巡星.html`（中文名好发出去），CI 在发布前 `cp` 成 `xinggui.html` 再上传。

## 现在能做什么

| 能力 | 说明 | 线上版本 |
| --- | --- | --- |
| 沙盘模式 | 压缩比例的太阳系全景。芯片行选天体，名称 / 轨道 / 尾迹可单独开关，卫星排成一行 | 1.0 |
| 实境模式 | 1:1 米制，相机由 `frameEarthMoon` 每帧解析摆位，只有地月这一片视野 | 1.1.0 |
| 三条校准门 | 时间 / 目标 / 图层各一条，三条都摸过才解锁实境 | 1.1.0 |
| 解锁短码 | `XG1-XXXXX-XX`，进度编进 12 位载荷 + CRC-8 + Crockford Base32，换设备能带走 | 1.1.0 |
| 屏幕空间拾取 | 判定只认投影结果，不认单位与比例。总览档里木卫一的圆盘半径只有 0.5（390×844）/ 0.9（1280×720）像素，仍然点得中 | 1.1.1 |
| 星空 | 银河带 + 星等与色温分层。恒星在太阳系尺度内没有视差，所以星空是一层零视差的背景 | 1.2.0 |
| 时间可调 | 速度 8 档对数刻度（0.05×–8×），读数写成「1 秒 = N 天」；可拨到任意时刻（绝对年/日，或 ±1 天/月/年） | 1.2.0 |
| 设备分流 | 按指针类型与视口分档，只调两个旋钮：画布 dpr 上限、程序化贴图宽度上限；档位随帧时间自适应，有上限也有冷却 | 1.2.0 |
| 日食月食 | 遮挡按解析计算，不靠几何体相交 | 1.2.0 |
| 两份产物 | 单文件 HTML（离线、发文件即玩）与静态站点（能装到主屏幕、全屏无地址栏） | 1.0 |

## 现在没做到的事

这一节比上面那节重要。

- **实境相机是解析机位，不能自由飞。** 它每帧由 `frameEarthMoon` 独占摆放，不接 OrbitControls。在实境里拖动、缩放没有反应，这是设计如此，不是坏了。
- **沙盘轨道是共面正圆。** 偏心率、倾角、近日点进动都不体现在画出来的轨道形状上；压缩比例优先保证"一眼看全"。
- **食的次数比真实频繁。** 天体半径和轨道半径不是同一个压缩比例，月球与太阳的角径比和真实不符，所以遮挡发生的频率偏高。
- **首帧有固定开销。** 首次进入要编译着色器并逐像素生成程序化贴图，低端机第一秒会掉帧。自适应逻辑跳过预热期，但启动那一下躲不掉。
- **贴图只有地球和月球是真实影像**（NASA 公有领域，`src/solar/assets/`，共约 120 KB），其余全是运行时逐像素生成的。
- **没有声音。**
- **2 代际的图鉴还没做。** `progress.ts` 只在记录访问过的天体，界面上不展示。
- **存档不跨源。** 单文件版和托管版是两个来源，各有各的存档（速度、图层开关、门进度分开写）。
- **没有 WebGL 就是白屏**，控制台报 context 错误，没有降级方案。

## 怎么跑

### 直接玩

下载 `xinggui.html`，双击。手机的话把文件发到微信「文件传输助手」，在手机上用浏览器打开即可。

想装到主屏幕（iOS：分享 → 添加到主屏幕；Android：菜单 → 安装应用），要用托管版：把 `release/site/` 拖进任意静态托管，拿到网址打开。单文件版不行，manifest 需要 http/https。

### 本地开发

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 产出 release/（单文件 + 静态站点）
npm run typecheck  # tsc --noEmit
npm run verify     # 真实浏览器验收
npm run check      # 验单文件产物 + 形状判据
npm run shoot      # 逐颗星聚焦截图，肉眼查贴图
```

| 命令 | 做什么 |
| --- | --- |
| `npm run dev` | Vite 开发服务，监听 0.0.0.0，手机同网可直接开 |
| `npm run build` | `vite build` 后由 `scripts/package-release.mjs` 打出单文件与站点两份 |
| `npm run verify` | 开系统自带的 Edge（`playwright-core`，不下载 Chromium），跑桌面视口、手机视口、单文件、画布像素体检、帧时间、命中矩阵等 |
| `npm run check` | 不传参时验本地刚构建的 `release/巡星.html`；`npm run check -- <某份 html> [参考文件]` 验任意一份（比如从 GitHub 下载回来的），顺带跑 `check-shape.mjs` 的形状判据 |
| `npm run check:shape` | 只跑形状判据：同一概念不允许长出第二份真相 |
| `npm run shoot` | 把每颗天体聚焦后截图到 `screenshots/`（该目录不进 git） |

`npm run check` 单独存在是有原因的：CI 在 Linux 构建，产物和本机 Windows 的差几十字节（Tailwind 扫描候选类名时的平台差异，多一条没人用的规则，不会缺样式）。所以「本地验过了」不等于「你下载的那份能跑」。

### 调试与深链

都是 URL 参数，不改代码：

| 参数 | 作用 |
| --- | --- |
| `?body=earth` | 打开就聚焦该天体；选中什么会写回地址栏，链接可分享 |
| `?gate=XG1-…` | 读入解锁短码，读一次就从地址栏删掉 |
| `?tier=0..3` | 强制画质档位，自适应关闭 |
| `?quality=off` | 完全不分流 |
| `?diag` | 诊断模式：档位钉住，画布可回读 |
| `?proto=1` | 米制原型，绕过 store 里的模式 |
| `?still=1` | 静态渲染，截图用 |

## 目录

```
src/solar/
  data.ts            天体数据、文案、事实卡片
  systems.ts         系统声明（单位 / 观感 / 天体）与相机取景、裁剪面
  system-context.tsx 当前系统的注入与读取
  SolarCanvas.tsx    3D 场景、着色器、相机（MeterCamera / SandboxCamera）、尾迹
  pick.ts            屏幕空间拾取
  Hud.tsx            两种模式的 HUD：芯片、详情卡、底栏、时间与图层控件
  ModeBadge.tsx      模式徽标与校准面板
  gate.ts            校准门的位编码、短码编解码
  store.ts           状态、存档、门进度、模式切换
  quality.ts         设备分档与自适应
  textures.ts        贴图：地球/月球读真实影像，其余运行时生成
  starfield.ts       星空
  clock.ts           时间读数的转发
  brand.ts          名字与版本号；BrandMark.tsx 图标
src/App.tsx          入口壳（深链、黑幕、原型出口）
src/main.tsx         挂载
src/styles.css       样式
index.html           页面壳
public/              图标与 manifest
scripts/             构建、打包、验收、截图（详见 scripts/README.md）
```

改游戏基本只动 `src/solar/`。这一层不 import 外壳，换框架、换托管、换样式都不影响它。

## 命名口径

| 用在哪 | 写法 | 例 |
| --- | --- | --- |
| 全名（启动页 / about / `<title>` / 描述 / 品牌物料） | **`巡星·未至之境`，中间不加空格** | `<title>巡星·未至之境</title>` |
| 短名（HUD 占位、手机桌面标题、本地产物名） | `巡星` | `release/巡星.html` |
| 发布名（GitHub release 标题） | 名字 + 版本 + ` · ` + 摘要 | `巡星 1.1.6 · 修复实境浮点` |
| 技术标识（npm 包名 / 仓库名 / release asset） | ASCII，**永不翻译** | `xinggui` / `xinggui-solar-system` / `xinggui.html` |

**` · ` 只出现在发布名里当分隔符**，用来隔开「名字」和「版本/摘要」；名字本身上下文中写 `巡星·未至之境`（无空格）。

名字的字面量现在有两处：`vite.config.ts` 的 `APP_NAME` / `APP_SHORT_NAME`（经 `__APP_NAME__` / `__APP_SHORT_NAME__` 注入），以及 `src/solar/brand.ts`。后者顶部留了 TODO，等消费常量落地后再合并成一处。

## 版本与发布

版本号只有一个来源：`package.json` 的 `version`。界面左上角的版本、CI 打的 tag、release 标题都从它取，改版本就是改这一处。

| 号 | 含义 | 发布方式 |
| --- | --- | --- |
| `X.0.0` | 代际（测绘 → 远征） | release + latest |
| `1.X.0` | 结构性 / 能力变化 | release + latest |
| `1.0.X` | bug 与小改动混编 | release + latest |
| `1.0.X-snap.N` | 随手改的小东西，不占正式号 | 只出 Actions artifact，不建 release |

CI 在 `.github/workflows/build.yml`：push 到 `main` → `npm ci` → `npm run build` → 按 `package.json` 的版本号打 `v<版本>` tag、用 `releaseNote` 拼标题、上传 `xinggui.html`。不需要本地打包再手动传。版本历史见 [CHANGELOG.md](CHANGELOG.md) 与 GitHub Releases。

本机推 GitHub 要走代理，直连会 TLS 中断：

```bash
git config http.proxy http://127.0.0.1:7890   # 换网络后要么改这个，要么删掉
git push
```

只提交源码。`node_modules/`、`dist/`、`release/`、`screenshots/` 都在 `.gitignore` 里。

## 运行要求与已知边界

- 需要 WebGL，2016 年之后的设备基本都有。
- 单文件版本不能「添加到主屏幕」（manifest 需要 http/https），托管版本可以。
- iPhone 上首次全屏打开时下拉可能误触刷新，装到主屏幕后没有这个问题。
- 竖屏下镜头会把天体抬到上半屏，详情卡是底部抽屉（窄屏可分三档高度，宽屏是右侧固定栏）。

## 工程沿革

最早在 Grok App Builder 的工作区里，套着 TanStack Start SSR、平台注入与预览桥。游戏本身零服务端：贴图运行时画，数据写死在 `data.ts`，存档在 `localStorage`。所以把它抽出来的成本只在壳层，游戏一行没改。现在是一个纯 Vite SPA，配一个单文件打包脚本。
