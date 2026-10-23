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
src/solar/          游戏本体（6 个文件，与原工程 SHA256 一致）
src/App.tsx         入口壳（原 src/routes/index.tsx，去掉路由包装）
src/main.tsx        挂载
src/styles.css      样式（仅字体栈改成系统字体）
index.html          页面壳
public/             图标 + manifest
scripts/package-release.mjs   打包出「单文件」和「静态站点」两份
```

游戏本体全部在这 6 个文件里，改游戏只改它们：

```
solar/data.ts          天体数据、文案、事实卡片
solar/textures.ts      程序化贴图（canvas 逐像素生成，没有图片资源）
solar/SolarCanvas.tsx  3D 场景、着色器、镜头跟随
solar/Hud.tsx          界面、速度条、芯片、键位
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
```

`npm run build` 会生成两份东西：

- `release/site/` —— 静态站点，丢到任何静态托管就能有网址
- `release/星轨.html` —— 单个自包含 HTML，双击即玩

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
把单文件挂到 `latest` 这个 release 的 `xinggui.html` 上。不需要本地打包再手动传。

**本机推送需要走代理**（直连 GitHub 会 TLS 中断）。仓库的 local config 里已经写死了：

```bash
git config http.proxy http://127.0.0.1:7890   # 换网络后要么改这个，要么删掉
git push
```

---

## 与原版的全部差异（都在壳层）

| # | 改动 | 位置 | 为什么 |
| --- | --- | --- | --- |
| 1 | TanStack Start / nitro / SSR → 纯 Vite SPA | 工程根 | 去掉服务端，才能当静态文件跑 |
| 2 | 删除 Grok PWA 注入、预览桥、auth、数据库 | 全部移除 | 与本游戏无关，且把应用绑在平台上 |
| 3 | Google Fonts 外链 → 系统字体栈 | `styles.css` 2 行 | 国内常被墙、离线会卡 2–5 秒；系统字体即开即用 |
| 4 | `h-dvh` → `h-screen` + `100dvh` 兜底 | `App.tsx` 1 行 | 老 iOS 不认 `dvh` 时不会变成 0 高度 |
| 5 | 新增 manifest / 图标 / 单文件打包脚本 | `public/`、`scripts/` | 手机上能装到桌面 |

`src/solar/` 六个文件的 SHA256 与原工程完全一致：
天体数据、贴图算法、着色器、镜头逻辑、HUD 文案、键位、存档格式，**一个字都没动**。

---

## 已知边界

- 需要 WebGL（2016 年之后的设备基本都有）；不支持时会白屏，控制台报 context 错误
- 单文件版本「添加到主屏幕」不可用（manifest 需要 http/https），托管版本可以
- 存档只在**同源**下通用：单文件版和托管版是各自独立的存档（速度、名称/轨道开关）
- iPhone 上首次打开全屏游戏，下拉刷新可能误触；装到主屏幕后没有这个问题
