# 星轨 · 独立版

可交互的三维太阳系轨道仪。从 Grok App Builder 工作区里抽出来，**游戏本体一行没改**，只把外壳换成了普通静态网站。

---

## 为什么以前只能在 Grok 里打开

原工程是三层叠起来的：

| 层 | 内容 | 是否必要 |
| --- | --- | --- |
| 游戏 | `src/solar/`（three.js 场景 + HUD + 数据 + 程序化贴图） | **必要** |
| 外壳 | TanStack Start SSR、Vercel/nitro 服务端插件、`startup.sh`、预览桥 | 不需要 |
| 平台 | Grok PWA 注入（`<script src="grok.com/...">`）、auth、预览托管 | 不需要 |

游戏本身**零服务端调用**：贴图是运行时用 canvas 画的，数据写死在 `data.ts`，存档在 `localStorage`。
所以锁定的不是游戏，是外壳和托管。这次把外壳整个去掉，游戏原封不动搬出来。

---

## 目录

```
src/solar/          游戏本体
src/solar/assets/   地球与月球的真实贴图（NASA 公有领域，烘焙后共 ~120 KB）
src/App.tsx         入口壳（原 src/routes/index.tsx，去掉路由包装）
src/main.tsx        挂载
src/styles.css      样式（仅字体栈改成系统字体）
index.html          页面壳
public/             图标 + manifest
scripts/package-release.mjs   打包出「单文件」和「静态站点」两份
scripts/bake-textures.mjs     把原始行星贴图烘成合适尺寸
```

改游戏只改 `src/solar/`：

```
solar/data.ts          天体数据、文案、事实卡片
solar/textures.ts      贴图：地球/月球读真实影像，其余运行时逐像素生成
solar/SolarCanvas.tsx  3D 场景、着色器、镜头、尾迹
solar/Hud.tsx          界面、速度条、芯片、卫星行、键位
solar/Quiz.tsx         星问挑战（答题小游戏）
solar/questions.ts     题库 + 随机抽题
solar/progress.ts      已探索天体的本地记录
solar/store.ts         状态 + localStorage 存档
solar/clock.ts         共享时钟
```

---

## 命令

```bash
npm install
npm run dev        # 本机开发预览 http://localhost:5173
npm run build      # 产出 release/
npm run typecheck
npm run verify     # 桌面 + 手机视口 + 单文件，真实浏览器验收
npm run check -- <某个 html>   # 验证任意一份（比如从 GitHub 下载的）能不能跑
npm run shoot      # 逐颗星聚焦截图到 screenshots/body-*.png，肉眼查贴图
```

`npm run build` 会生成两份东西：

- `release/site/` —— 静态站点，丢到任何静态托管就能有网址
- `release/星轨.html` —— 单个自包含 HTML，双击即玩

`npm run check` 单列出来是有原因的：CI 在 Linux 上构建，产物和本机 Windows 的差几十字节
（Tailwind 扫描候选类名时平台差异，多一条没人用的规则，不会缺样式）。
所以「我本地验过了」不等于「你手机上那份能跑」，下载回来那份要单独验。

---

## 手机 + 电脑怎么玩

**方式 A · 单文件（最快，零成本）**
1. 电脑上双击 `release/星轨.html`，浏览器直接打开
2. 想上手机：把 `星轨.html` 发到微信「文件传输助手」→ 手机点开 → 选「用浏览器打开」

**方式 B · 托管（手机体验最好，可安装）**
1. 打开 [app.netlify.com/drop](https://app.netlify.com/drop)，把 `release/site` 文件夹拖进去
2. 拿到网址，手机浏览器打开
3. iOS：分享 → 添加到主屏幕；Android：菜单 → 安装应用
   装完后全屏运行、没有地址栏，和原生应用一样

方法 B 的网址不依赖 Grok，也不依赖这台电脑，随时随地能开。

---

## 以后怎么更新

**改游戏 → 重新打包 → 重新上传。没有第二层要同步。**

```bash
# 1. 改 src/solar/ 里的东西
# 2. 打包
npm run build
# 3. 重新上传 release/site（或重新发 release/星轨.html）
```

之所以不会变成「补丁堆」：游戏代码和外壳是分离的，`src/solar/` 里没有任何一处 import 到外壳或平台。
换框架、换托管、换样式，都不动游戏；改游戏，也不动外面。

建议第一件事先建个版本库，之后每次更新都有 diff 可查：

---

## 版本库

源码在 GitHub：[GuanYunMao/xinggui-solar-system](https://github.com/GuanYunMao/xinggui-solar-system)（public）

**只提交源码。** `node_modules`（283 MB）、`dist/`、`release/`、`screenshots/` 都在 `.gitignore` 里。
提交进 git 历史的东西很难再弄出来，所以别在网页上整文件夹上传——只走 `git push`。

**手机上的固定下载地址**（每次 push 自动更新，收藏这一个就够）：

```
https://github.com/GuanYunMao/xinggui-solar-system/releases/latest/download/xinggui.html
```

构建设在 `.github/workflows/build.yml`：push 到 `main` → `npm ci` → `npm run build` →
按 `package.json` 的版本号打 `v<版本>` 的 tag 并发布 `xinggui.html`。不需要本地打包再手动传。
下载地址写作 `releases/latest/...`，所以**跨版本不变**。

**本机推送需要走代理**（直连 GitHub 会 TLS 中断）。仓库的 local config 里已经写死了：

```bash
git config http.proxy http://127.0.0.1:7890   # 换网络后要么改这个，要么删掉
git push
```

---

## 版本规则

第一位 **MAJOR**：跨越整个大代际 · 第二位 **MINOR**：普通改动 · 第三位 **PATCH**：修小 bug

版本号只有一个源：`package.json` 的 `version`。界面左上角显示的版本、CI 打的 tag、
release 名字都从它取。每次改动都写进 [CHANGELOG.md](CHANGELOG.md)。

---

## 与原版的差异

### 壳层（1.0.0 起）

| # | 改动 | 位置 | 为什么 |
| --- | --- | --- | --- |
| 1 | TanStack Start / nitro / SSR → 纯 Vite SPA | 工程根 | 去掉服务端，才能当静态文件跑 |
| 2 | 删除 Grok PWA 注入、预览桥、auth、数据库 | 全部移除 | 与本游戏无关，且把应用绑在平台上 |
| 3 | Google Fonts 外链 → 系统字体栈 | `styles.css` 2 行 | 国内常被墙、离线会卡 2–5 秒；系统字体即开即用 |
| 4 | `h-dvh` → `h-screen` + `100dvh` 兜底 | `App.tsx` 1 行 | 老 iOS 不认 `dvh` 时不会变成 0 高度 |
| 5 | 新增 manifest / 图标 / 单文件打包脚本 | `public/`、`scripts/` | 手机上能装到桌面 |

**1.0.0 时 `src/solar/` 六个文件与原工程 SHA256 逐个一致** —— 从 Grok 抽出来的那一步，
游戏本体一个字没动。从 1.1.0 开始改的是贴图、镜头和 HUD，见 CHANGELOG。

### 游戏本体（1.1.0 起）

| 文件 | 改了什么 |
| --- | --- |
| `solar/textures.ts` | 重写：噪声格点周期修正、陨石坑、气态行星条带、冰壳裂缝；地球与月球改用真实影像 |
| `solar/SolarCanvas.tsx` | 首次摆位与聚焦动画挪进帧循环；竖屏镜头抬升；云层独立着色器；拖动误触防护；行星尾迹；卫星透明命中球 |
| `solar/Hud.tsx` | 手机端详情卡改底部抽屉；卫星芯片行；1–9 键选行星；显示版本号 |
| `solar/Quiz.tsx` / `questions.ts` / `progress.ts` | 新增：星问挑战与探索进度 |
| `solar/store.ts` | 新增尾迹开关（含存档） |
| `solar/data.ts` / `clock.ts` | **未改动** |

---

## 已知边界

- 需要 WebGL（2016 年之后的设备基本都有）；不支持时会白屏，控制台报 context 错误
- 单文件版本「添加到主屏幕」不可用（manifest 需要 http/https），托管版本可以
- 存档只在**同源**下通用：单文件版和托管版是各自独立的存档（速度、名称/轨道开关）
- iPhone 上首次打开全屏游戏，下拉刷新可能误触；装到主屏幕后没有这个问题
