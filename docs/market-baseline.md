# 市场基线：观测、发现与时间机制的横评

> 采证时间 **2026-10-25**。当天在本机取不到一手来源的，一律标「未核实」；数字照抄来源，不换算、不补齐。
> 证据分级：**官方页**（商店页 / 官网 / 应用商店原文）／**玩家一手**（Steam 与应用商店的实名评价，带发布日期）／**二手**（Wikipedia 等）／**未核实**。
> **行号漂移**：文中的 `文件:行` 针对 `HEAD efd2f1e` + 2026-10-25 晚间工作树；1.3.4 合入后行号会动，引用前先 `git grep` 核一次。
> 玩家差评取的是 Steam 商店页的「最有帮助的差评」第一页（top-rated negative），这是有偏样本：骂得早、骂得响的排在前面，不能当比例读。应用商店评价取 Apple 公开的 RSS 最新页（Star Walk 2 `id892279069`、Sky Guide `id576588894`），同样有偏。
> 本文只写市场。引用自家代码只为说明「这一版该删什么」落在哪一行，不评价实现好坏。

## 0 一页判断

**15 个天体、1:1 比例、无战斗无资源无建造，这个规格市面上没有人当商业游戏做成过。** 做成的两类都不是这个形态：一类是工具（SpaceEngine / Celestia / Stellarium），一类是把「知道」当成唯一进度的短篇（Outer Wilds）。另外两个靠规模撑（Elite Dangerous / No Man's Sky），天体数不是 15。

这份横评里能站住的撑时长机制有三种，彼此不兼容：

- **知识闭包**：Outer Wilds，22 分钟循环，飞船日志按地点或关系网组织、只显示已发现的内容（Wikipedia，2019）。
- **规模与署名**：Elite Dangerous，4000 亿系统里已编目 0.0489%，奖励是信用点和名字（Wikipedia，2026-06-17 数据）。
- **实时事件**：Star Walk 2 与 Sky Guide，用「今晚可见」清单和「ISS 过境」通知把人叫回来（App Store 官方页，2026-10-25 抓取）。

1.3.4 最该动的一刀不在机制，在文案：`ModeBadge.tsx:39-41` 三条提示把答案写在了脸上。

## 1 轴一：1:1 真实太阳系怎么被玩家接受

### 1.1 SpaceEngine（2010 起，2019 上 Steam）

**把玩家的动作定义成什么。** 搜索、飞行、拨时间。2010-06 首次公开发布，2017-08 前免费，2019-06 起在 Steam 卖 0.990 beta（Wikipedia；Steam 商店页日期 2019-06-11）。官方描述原话是「a 1:1 scale science-based Universe simulator」，短描述写「the world's first science-based photorealistic interactive 3D planetarium」（Steam 商店页）。玩家基本就做四件事：按参数筛天体、以任意方向和速度旅行、前后拨时间、把位置存成 location；外加一个内建 wiki，可以给天体写自定义名字和描述（Wikipedia）。飞行模拟器还在 alpha，只有虚构飞船（Wikipedia）。

**奖励是什么。** 没有奖励，只有「它真的在那儿，而且算得对」。能被当成奖励的只有导出：玩家 2022-05-07 的差评说，免费时代能导出 1024 以上的天空盒，上 Steam 后要买 Pro DLC 才能导出（Steam 差评）。

**玩家骂它什么。** 骂的全是工程与商业，这 10 条「最有帮助的差评」里没有一条骂「没得玩」：2019-10-31 骂 Steam 版一上线就崩；2020-03-29 骂 VR 完全不可用（2080 Ti 上水面帧率 10–20）；2022-05-07 骂功能被挪进 Pro DLC；2023-12-30 骂飞近了贴图退回二十年前；2023-08-18 与 2025-10-03 骂开发公司的人事风波（Steam 差评，日期为评价发布日期）。这条差评结构说明：1:1 天空本身不挨骂，挨骂的都是它周围的东西。它是工具，不是游戏。

### 1.2 Celestia（2001）

**把玩家的动作定义成什么。** 演示与扩展。2001 年由 Chris Laurel 创建，1.6.4 及以前带 118,322 颗 Hipparcos 恒星，1.7.0 并入 Tycho-2 与 Gaia 数据后超过 200 万颗；玩家写 CEL / CELX 脚本、装扩展包，社区扩展超过 80 GB（Wikipedia）。时间可拨到前后 20 亿年，轨道只在今前后几千年内准确（Wikipedia）。

**奖励是什么。** 教学与演示价值：NASA 与 ESA 用它做科普和外联，法国 CNES 2016 年改出 VTS Timeloop 给多个航天机构用（Wikipedia）。没有进度、没有记录、没有目标。

**玩家骂它什么。** 官方记录下来的问题是「停更」与「不模拟」：2013 年停止开发（最后一次正式版 2011），2016 年底重启，到 2026 年仍是 1.7.0 beta；不模拟引力，近地天体不会被地球偏折；默认包里没有变星、超新星、黑洞、星云；飞船模型老旧（Wikipedia 的 Limitations 段）。2001–2017 年 SourceForge 记录约 1200 万次下载，但**玩家一手评价未取得**（Celestia 不在 Steam，2026-10-25 用 Steam 搜索无结果），所以「为什么卸」这一格标**未核实**。

### 1.3 Orbiter（2000）

**把玩家的动作定义成什么。** 手动飞完一次任务。2000-11-27 发布，最新版 Orbiter 2024 于 2024-12-31 发布，作者 Martin Schweiger 宣布转为 MIT 开源（Wikipedia）。行星位置用 VSOP87，地月用 ELP2000，只做 n 体牛顿力学；默认能开的真飞船只有航天飞机亚特兰蒂斯号，另有虚构的 Delta-Glider 一类；对接、会合与回收卫星、在轨造空间站都支持（Wikipedia）。

**奖励是什么。** 对接成功本身。它被当教学工具用，作者的原话动机是「让学物理概念变得好玩」（Wikipedia）。没有货币、没有等级、没有收集。

**玩家骂它什么。** 可核实的硬缺陷：2024 版之前默认没有声音，要装 OrbiterSound / XRSound；除对接端口外没有碰撞检测；不能星际旅行，10 万颗恒星只用于显示（Wikipedia）。学习曲线陡是社区共识，但**本机取不到带日期的玩家一手评价，标未核实**。

### 1.4 Universe Sandbox（2008 起，Steam 2015）

**把玩家的动作定义成什么。** 改参数，看后果。2008-05 出第一版；Legacy 在 Steam 是 2011-04-29；现在的 Universe Sandbox 在 Steam 是 2015-08-24，2018-12 从 Universe Sandbox² 改名（Wikipedia；Steam 商店页）。能改质量、密度、半径、自转、成分，能撞、能烧掉海洋、能做地形改造，2018-11-15 起支持 Steam Workshop 分享（Wikipedia）。

**奖励是什么。** 后果本身。Legacy 的商店页分类里有 Steam 成就；现在这一版的分类里没有成就，只有 Workshop 与 Early Access 标签（Steam 商店页，2026-10-25 抓取）。

**玩家骂它什么。** 骂的是「看完了」：2024-06-16 的差评原话「除非你是金鱼，否则很快就能看完所有有意思的东西，炸过几十颗行星之后长得都一样」；2023-05-12 骂碰撞从发售到现在没变，还是两个光滑球合并再贴一层焦痕；2021-02-26 骂「发售六年还在 Early Access，而且更糟」——EA 状态到 2026-10-25 还在，商店页的类型仍挂着 Early Access；2018-11-05 骂模拟精度不行（双星轨道算歪、宜居带算不准）；2025-03-11 骂 VR 被砍掉（Steam 差评，日期为评价发布日期）。

### 1.5 轴一判读

**结论**：1:1 太阳系不是玩法。这四家里三家是工具，唯一像沙盘游戏的 Universe Sandbox 被玩家用「看腻」结账，而它的卖点是破坏，不是真实轨道。

**依据**：SpaceEngine 这 10 条差评里没有一条骂「没得玩」，骂的是崩溃、VR、贴图、公司（Steam 差评，2019–2025）。Orbiter 的时长来自操作难度，天体只是场地（Wikipedia，2024 版）。Celestia 的 1200 万次下载没有变成玩家留存，2013 停更、2016 才重启，这段空档被写进 Wikipedia 的词条开头（Wikipedia，2001–2017 下载量）。Universe Sandbox 的「很快就能看完所有有意思的东西」是它自己的玩家写在差评里的（2024-06-16）。

**这一版该删什么**：1.3.4 不要用「更真实」当卖点。沙盘按 README 的三层分工本来就对真实让位，往「更真」推半步是两头不靠。门面板上任何「集齐才解锁」的表达都要删，理由在轴二判读里。

## 2 轴二：发现／扫描作为唯一进度

### 2.1 Elite Dangerous（2014-12-16 发售）

**把玩家的动作定义成什么。** 扫描与测绘。游戏是 1:1 的银河系，约 4000 亿个恒星系统（Wikipedia）。2018-12-11 的 Beyond Chapter Four（3.3）把探索整体重做：加入全谱扫描（FSS）与行星探测器，行星表面要靠发射探测器测绘（Wikipedia 记该次更新的内容；Frontier 官方补丁说明本机取不到，见第 7 节）。玩家通常仍把那个模块叫 DSS（Detailed Surface Scanner）——**这个叫法的官方文案、以及首次发现与首次测绘标签（First Discovered / First Mapped）的赔付公式都未核实**；标签挂在名字上、给信用点，是本机取到的玩家叙述里对它的描述。

**奖励是什么。** 信用点加名字。规模数据能说明这套奖励撑了多久：到 2026-06-17，195,463,043 个系统被编目，占银河 0.0489%，其中 97,728,089 个被玩家亲自探索过（Wikipedia）。十年下来，万分之五。

**玩家骂它什么。** 骂 grind 与停更：2021-06-15 的差评说「2019 年 Frontier 基本放弃了这个游戏，主力去做 Odyssey」；2023-10-16 说「grind 会到不可忍受的地步，目标是买一艘航母，攒了 20 亿信用点」；2025-11-11 说「十年了，社区自己做工具补官方从没做的 QOL」；2022-05-13 说社区讨论区被删帖（Steam 差评，日期为评价发布日期）。

### 2.2 Outer Wilds（2019-05-28，PC 与 Xbox 首发；Steam 页写 2020-06-18）

**把玩家的动作定义成什么。** 读与到。太阳系卡在 22 分钟的时间循环里，太阳每次超新星爆发就把一切重置；玩家带不走任何物品，唯一带得走的是飞船电脑上的数据，按地点或按关系网组织（Wikipedia）。Nomai 文字要靠翻译工具读，读到的对话本身构成解谜路径。

**奖励是什么。** 知识。Wikipedia 引设计说明的原话是「学到新东西是玩家得到的唯一反馈」（2019）。为了让这句话成立，写作被拆成一串小谜题，让「知道得更多」这件事发生得比「解开一个大谜」更频繁（Wikipedia）。

**玩家骂它什么。** 骂的是它的代价：2023-08-18 骂晕动症，二十分钟就难受；2021-05-28 的原话是「每隔 22 分钟，你就得先玩一次越来越难的登月着陆，才能回到冒险部分」；2023-06-07 说「做得很好，但不是给我玩的」；2021-11-21 说没有引导、不知道从哪开始（Steam 差评，日期为评价发布日期）。

### 2.3 No Man's Sky（2016-08）

**把玩家的动作定义成什么。** 扫描、上传、命名。扫星球、扫动植物、扫基地都能换成单位（货币）；首次发现可以上传到 The Atlas，拿额外单位，名字挂给所有玩家看，命名有内容过滤（Wikipedia）。宇宙规模是 1.8×10¹⁹ 颗行星（Wikipedia 写 18 quintillion）。

**奖励是什么。** 单位、署名、生存与建造。署名是社交奖励：别人能看见你起的名字。

**玩家骂它什么。** 2016-08-15 的差评就一句「一英里宽，一英寸深」；2016-08-24 骂「这不是宇宙，行星根本不绕恒星，卫星也不绕行星」；2016-11-22 骂「36 小时，什么都试过了，nothing to show for it」；2016 年两名玩家在同一个星球同一个坐标上互相看不见，尽管其中一人是靠对方挂在地表发现上的用户名认出来的（Wikipedia 记载的 2016 年事件）——署名系统在那一刻归零（Steam 差评，日期为评价发布日期）。

### 2.4 轴二判读

**结论**：发现能不能当唯一进度，取决于两件事——记录是否只由玩家行为产生、记录是否在本地就成立。ED 和 NMS 都把奖励接到服务器与货币上，结果一个被骂 grind，一个被当成笑话；Outer Wilds 把记录放进玩家脑子和本地日志，撑住了，但只够一次。

**依据**：Outer Wilds 的日志按地点或关系网组织、只记录已发现的内容（Wikipedia，2019）；NMS 的 36 小时差评要的是「show for it」；ED 的 0.0489% 说明规模本身不产生意义，只产生距离。

**这一版该删什么**：

- **删「提示即答案」。** `ModeBadge.tsx:39-41` 三条提示现在直接写答案：「月球进过地球的影子」「一年绕太阳最多圈的那颗」「名称与轨道都不在，还认得出谁」。Outer Wilds 的日志按地点或关系网组织、只显示已发现的内容；Star Walk 2 的「Visible Tonight」能给清单，是因为它不承担进度。把提示改成现象（玩家看到什么），答案留给玩家自己撞上。
- **删凑数的槽位。** 1.3.4 已经落地：`gate.ts:27` 的注释写着「1.3.4 从 12 收到 3」，现表 `GATE_SLOTS` 只有 time / target / layer（`gate.ts:37`），旧表里 scale / orbit / clock / signal / eclipse / drift / echo / void / trail 九个没有写入点（`gate.ts:29-31`）。多出来的 9 格会让玩家去找九个不存在的任务。Universe Sandbox 的「六年还在 EA」和 Celestia 的「停更」说明：看起来还有内容但没有，比明说没有更招骂（Steam 差评 2021-02-26；Wikipedia）。
- **删「按一次 +1 年就点亮」。** 1.3.4 已落地：`store.ts:415` 现在是 `eclipseWitnessed(s.simSeconds, next)`，要自然走到日食月食才亮；旧实现是 `daysOf(next) >= DAYS_PER_YEAR` 就点亮（PLAN §0 实测「按一次 +1 年从第 0 天跳到第 365.25 天」）。市面没有一个被玩家认可的发现机制是「按一次按钮就给」：ED 要玩家自己发射探测器（2018-12-11 更新），Outer Wilds 要玩家在正确时刻到场。
- **删「深链算访问」。** `App.tsx:123` 在状态订阅里 `markVisited`，`App.tsx:136` 的深链选择走同一条路——打开一个链接就等于「观察过」。NMS 的教训是记录必须由玩家行为产生；URL 不是行为。

## 3 轴三：观星 App 的观测入口

### 3.1 Star Walk 2（2014）

**把玩家的动作定义成什么。** 举起来、对天空、看清单。App Store 页面自述「BEST OF 2014」，主打实时星图、3D 星座、Time machine、AR 模式，功能列表里有一条就叫「Visible Tonight」（App Store 页，2026-10-25 抓取）。「今晚能看什么」是给你一份清单；「它现在在哪」是举手机对准。

**奖励是什么。** 认出来，加一条知识卡，加一次天象提醒。App Store 页把「What's new」天文新闻也列成功能。

**玩家骂它什么。** 骂精度与收费：2026-02-06 的 1 星说它把纽约的月亮升起算成早上 7 点，同一条里说 SkySafari 和 Stellarium 都对；2026-10-14 收到「今晚满月」的通知，那天不是满月；2025-11-03 骂通知提前两天说满月；2026-02-28 骂买了 Star Walk 2 又要买 Pro；2026-02-27 骂改版把「日出日落对照」从一页拆散；2025-09-03 骂罗盘对不上，做了 8 字校准也没用（App Store 评价，日期为评价发布日期）。

### 3.2 Sky Guide（2012）

**把玩家的动作定义成什么。** 举起来认东西，等通知。App Store 页面自述拿过「App Store Best of 2012」与「Rewind 2011」；功能是 AR 识别、Time Machine、按月历推送日月食与流星雨、以及 ISS 过境通知（App Store 页，2026-10-25 抓取）。「今晚能看什么」在这里不是清单，是一条通知：ISS 要来了、今晚有食。

**奖励是什么。** 赶上天象。通知到得准，那一刻就成立；不准，整个产品失信。

**玩家骂它什么。** 2026-07-01 的 1 星说方位角偏了 30°，并强调手机罗盘校准过；2026-08-13 说 ISS 通知来了，但位置差了半个天；2026-08-03 骂满屏都是肉眼看不见的星；2026-07-09 骂「不停弹升级」；2026-08-12 与 2026-08-13 骂从买断改成订阅（App Store 评价，日期为评价发布日期）。

### 3.3 Stellarium（桌面，GPL）

**把玩家的动作定义成什么。** 打开就是此刻此地的天空。官网原话是「shows a realistic sky in 3D, just like what you see with the naked eye, binoculars or a telescope」；插件系统覆盖人造卫星、目镜模拟、望远镜控制、食模拟（stellarium.org，2026-10-25 抓取）。2025-03 发布的 25.1 首次接入 Gaia DR3，暗到 21 等的恒星用 Gaia 编号（Wikipedia）。「今晚能看什么」在这里没有入口：你把时间和地点拨到今晚，自己看；「它现在在哪」靠搜索加方位网格，不做 AR。

**奖励是什么。** 没有奖励。它是参考工具，用户是「查一下」「确认一下」。

**玩家骂它什么。** 可核实的只有一条产品线问题：移动端是另一个产品（Stellarium Mobile），功能少于桌面（Wikipedia）。桌面版入口密、学习成本高是常见说法，但**没有带日期的玩家一手评价，标未核实**。2001 年起始也未核实（Wikipedia 摘要未含此句，只能确认 2006 年 0.7.1 拿过 Les Trophées du Libre 教育类金奖）。

### 3.4 轴三判读

**结论**：「今晚能看什么」和「它现在在哪」是两个不同的入口，不能合成一个。清单负责前者，定位与通知负责后者；两者一旦失准，产品立刻掉到 1 星。

**依据**：Sky Guide 的 30° 方位偏差（2026-07-01）与 ISS 通知偏半天（2026-08-13）；Star Walk 2 的月亮时间算错（2026-02-06）与满月通知错日（2026-10-14、2025-11-03）。这两个产品都不是被「内容不够」骂倒的，是被「报错位置」骂倒的。

**这一版该删什么**：不要在门面板上做清单。星图与记录可以列「已经发生过的现象」，不能列「接下来该看什么」——后者就是作业。

## 4 时间机制：三种用法（横评补充）

**当成查询参数。** SpaceEngine 能前后拨时间并保存 location（Wikipedia）；Celestia 可拨到前后 20 亿年，轨道只在今前后几千年内有效（Wikipedia）；Stellarium、Star Walk 2、Sky Guide 都有时间滑块或 Time Machine（stellarium.org；App Store 页）。这类产品里时间不承担进度，只承担「那一刻是什么样」。玩家骂的是拨到的时刻不准：Star Walk 2 把纽约的月亮升起算错（2026-02-06），满月通知错日（2026-10-14、2025-11-03）。

**当成硬约束。** Outer Wilds 把时间做成关卡结构：22 分钟一轮，太阳超新星爆发就重置，玩家带不走任何物品（Wikipedia）。玩家骂的正是这条约束的执行成本：每一轮都要重新着陆一次（2021-05-28 差评）。

**当成持久世界的背景。** Elite Dangerous 的银河按 UTC 实时运行，2014 年开局对应游戏内 3300 年（Wikipedia）。时间不制造紧迫感，只制造距离与刷新周期；玩家骂的是停更与刷，不是时间走得太快（2021-06-15、2023-10-16 差评）。

**判读**：巡星现在的时间可调（8 档对数刻度、0.05×–8×）属于第一类，是查询参数。1.3.4 如果继续拿「把时间拨到某一天」当解锁动作，就是让玩家用滑块答题——市面三个观星 App 的时间滑块都不承担进度，只承担「看那一刻」。门·时间必须换成现象谓词（PLAN 已定：自然走过一年且命中月食才亮），不能停在「拨到某一天」。

## 5 结论：只有 15 个天体、1:1、无战斗无资源无建造，有人做成过吗

**结论**：没有。按这个规格做成商业游戏的，市面上一个都没有。最接近的五种形态，各自缺一条：

- **SpaceEngine**：1:1 与无战斗成立，但天文体量是 10¹⁰ 秒差距级（边长 100 亿秒差距、约 326 亿光年的立方体，130,000+ 真实天体加程序生成，Wikipedia），时长靠生成与搜索，不靠 15 个天体。差评骂崩溃、VR、贴图，不骂「没得玩」。
- **Celestia**：工具。2001–2017 约 1200 万次下载，没有「时长」这回事；2013 停更后被写成缺点。
- **Orbiter**：1:1 与无战斗成立，时长靠操作难度（手动发射、对接），天体只是场地。
- **Outer Wilds**：约 10 个可去天体、无战斗、无资源，是最接近的一个；但比例是玩具尺度（玩家自己的说法「a toy-sized solar system」，2021-11-21 差评），靠 22 分钟循环加知识网撑，一次性。一条差评（Steam 显示 9 月 9 日，当年）说 6.1 小时拿到 14/31 个成就，没有第二个循环。
- **ED / NMS**：靠规模（4000 亿／1.8×10¹⁹）与货币或署名奖励撑，天体数不是 15。

**做成的那几个靠什么撑住时长**：Outer Wilds 靠知识闭包，代价是一次性；ED 靠规模加署名，代价是 grind 与停更后被骂；NMS 靠命名上传加生存建造，代价是「36 小时 nothing to show」；SpaceEngine 与 Celestia 不做时长，它们做的是查阅。

**这一版该删什么**：把「15 个天体」当卖点的话术删掉。这个规格本身在市场里没有成功先例，能卖的是「怎么观察」和「观察到之后留下什么」，不是「有几颗」。1.3.4 的门、文案、断言都按这条排：先保证「玩家自己看见了一个现象」，再谈解锁。

## 6 对 1.4–1.6 的三条硬推论

1. **飞行速度按通勤时间定，不按真实速度。** ED 把星系内巡航提到 2000+ 倍光速（Wikipedia），玩家骂的仍是刷（2023-10-16 差评）；Outer Wilds 一轮只有 22 分钟（Wikipedia），玩家自己把那个系统叫「a toy-sized solar system」，差评骂的是着陆操作，不是路远（2021-11-21、2021-05-28 差评）。1.4.0 的速度口径应当是「一顿饭之内能到下一个目标」，具体数值等渲染位给区间，但判据是时间，不是 m/s。
2. **1.5.0 观测累积的线索必须由已记录内容生成。** 一旦线索来自外部硬编码清单，就滑向 NMS 的 36 小时差评（2016-11-22）与 ED 的 grind（2023-10-16）。PLAN 已写死「记录不由玩家填」，市场这一侧给它补一条：线索也不能由开发者填。
3. **1.6.0 结局接受一次性。** Outer Wilds 有玩家在差评里写「I cleared it to the end, but it just didn't suit me」（2022-08-14，原文），没有任何市场证据表明「看完就结束」的作品能靠重复游玩续命。为了留存往结局后加清单，会把「测绘完成」变成作业。

## 7 未核实清单

| 项 | 为什么没核实 |
| --- | --- |
| ED 的 First Discovered / First Mapped 官方文案与赔付公式 | Frontier 论坛补丁页返回 202 空响应；Fandom 百科 403；Wayback 429。机制存在性按 Wikipedia（2018-12-11 探索重做）与玩家社区通行说法写，数值一律不写。 |
| Celestia / Orbiter 的玩家一手骂点 | 两者不在 Steam（2026-10-25 搜索无结果），没有可引用的实名评价；文中缺陷取自 Wikipedia 的 Limitations 段，属二手。 |
| Star Walk 2 / Sky Guide 的确切首发日 | App Store 页面只给「BEST OF 2014」「Best of 2012 / Rewind 2011」的自述，releaseDate 字段未取到。 |
| Stellarium 起始年 2001 | Wikipedia 摘要与正文摘录都没有这句；只核实到 2006 年获奖与 2025-03 的 25.1。 |
| SpaceEngine 真实天体数量 | 官方商店页写「billions upon billions」，Wikipedia 写「130,000+ real objects」，两个口径不同；文中采用后者并标二手。 |
| 各产品的日均／总游玩时长 | 未取到可引用的一手数据，全文不出现这类数字。 |

## 8 来源清单

| 产品 | 用到的内容 | 来源 | 年份 | 级别 |
| --- | --- | --- | --- | --- |
| SpaceEngine | 1:1、程序生成、可写自定义名字、飞行模拟 alpha | [Wikipedia: SpaceEngine](https://en.wikipedia.org/wiki/SpaceEngine) | 2010/2019 | 二手 |
| SpaceEngine | 发布日期 2019-06-11、官方描述 | [Steam 商店页](https://store.steampowered.com/app/314650/) | 2019 | 官方 |
| SpaceEngine | 崩溃、VR、Pro DLC、贴图、公司风波 | [Steam 差评页](https://steamcommunity.com/app/314650/negativereviews/) | 2019–2025 | 玩家一手 |
| Celestia | 2001 创建、2013 停更、1200 万下载、80 GB 扩展、局限 | [Wikipedia: Celestia](https://en.wikipedia.org/wiki/Celestia) | 2001–2026 | 二手 |
| Orbiter | 2000-11-27、Orbiter 2024、无音效、无碰撞、VSOP87 | [Wikipedia: Orbiter (simulator)](https://en.wikipedia.org/wiki/Orbiter_(simulator)) | 2000–2024 | 二手 |
| Universe Sandbox | 2008 初版、2015 Steam、2018 改名、Workshop | [Wikipedia: Universe Sandbox](https://en.wikipedia.org/wiki/Universe_Sandbox) | 2008–2018 | 二手 |
| Universe Sandbox | 发行日期、Early Access 状态、商店描述、Workshop | [Steam 商店页](https://store.steampowered.com/app/230290/)、[Legacy 页](https://store.steampowered.com/app/72200/) | 2011/2015，状态核于 2026-10-25 | 官方 |
| Universe Sandbox | 看腻、碰撞没变、长期 EA、VR 被砍 | [Steam 差评页](https://steamcommunity.com/app/230290/negativereviews/) | 2018–2025 | 玩家一手 |
| Elite Dangerous | 2014-12-16 发售、4000 亿系统、2018-12-11 探索重做、0.0489% | [Wikipedia: Elite Dangerous](https://en.wikipedia.org/wiki/Elite_Dangerous) | 2014–2026 | 二手 |
| Elite Dangerous | Steam 日期 2015-04-02、超级巡航 2000+ 倍光速 | [Steam 商店页](https://store.steampowered.com/app/359320/) | 2015 | 官方 |
| Elite Dangerous | 停更、grind、社区补 QOL | [Steam 差评页](https://steamcommunity.com/app/359320/negativereviews/) | 2021–2025 | 玩家一手 |
| Outer Wilds | 22 分钟循环、日志按地点/关系网组织、「唯一反馈是学到东西」 | [Wikipedia: Outer Wilds](https://en.wikipedia.org/wiki/Outer_Wilds) | 2019 | 二手 |
| Outer Wilds | 晕动症、着陆重复、不适合 | [Steam 差评页](https://steamcommunity.com/app/753640/negativereviews/) | 2021–2023 | 玩家一手 |
| No Man's Sky | 1.8×10¹⁹ 行星、上传署名、命名过滤、2016 双人互不可见 | [Wikipedia: No Man's Sky](https://en.wikipedia.org/wiki/No_Man%27s_Sky) | 2016 | 二手 |
| No Man's Sky | 「一英里宽一英寸深」、36 小时 nothing to show | [Steam 差评页](https://steamcommunity.com/app/275850/negativereviews/) | 2016 | 玩家一手 |
| Star Walk 2 | Visible Tonight、Time machine、AR、BEST OF 2014 | [App Store 页](https://apps.apple.com/us/app/star-walk-2-stars-in-the-sky/id892279069) | 2014 | 官方 |
| Star Walk 2 | 精度漂移、通知错日、二次收费、改版 | [App Store 评价 RSS](https://itunes.apple.com/us/rss/customerreviews/page=1/id=892279069/sortBy=mostRecent/json) | 2024–2026 | 玩家一手 |
| Sky Guide | AR、ISS 通知、日历、Time Machine、Best of 2012 | [App Store 页](https://apps.apple.com/us/app/sky-guide/id576588894) | 2012 | 官方 |
| Sky Guide | 方位偏 30°、ISS 通知偏半天、订阅化、满屏暗星 | [App Store 评价 RSS](https://itunes.apple.com/us/rss/customerreviews/page=1/id=576588894/sortBy=mostRecent/json) | 2026 | 玩家一手 |
| Stellarium | 免费开源、插件、食模拟、移动端功能少、25.1 用 Gaia DR3 | [stellarium.org](https://stellarium.org/)、[Wikipedia](https://en.wikipedia.org/wiki/Stellarium_(software)) | 2006–2025 | 官方／二手 |

---

**自家代码引用位置**（不属市场证据，只标 1.3.4 的落点；行号核于 2026-10-25 晚工作树，`HEAD efd2f1e` 之后会漂）：`ModeBadge.tsx:39-41`（三条提示，仍是答案原文，1.3.4 的文案改动落在这里）、`gate.ts:27` / `gate.ts:37` / `gate.ts:42`（12→3 的注释、现表三项、必需 3 格）、`store.ts:347` / `:352` / `:379` / `:415`（四个 `hitGate` 调用点，其中 time 已换成 `eclipseWitnessed`）、`App.tsx:123` / `:135-136`（深链 select 进同一条访问记录路径）、`data.ts`（15 个天体 id）、`systems.ts:231`（实境当前只挂地月 + 冥王星 + 哈雷四个样本）。
