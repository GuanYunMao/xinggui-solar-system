#!/usr/bin/env node
/**
 * 1.4.0 规格检查器：`docs/spec-1.4.md` 缺任一段、缺任一个数、或**算错一个数**就 exit 1。
 *
 * 三类判据，缺一类这个脚本就只是 grep：
 *   1. 结构   —— 四个决策段在，每段有结论 / 数字 / 推翻条件；
 *   2. 在场   —— 每段的必填数字与该写的标识逐条命中；
 *   3. 算术   —— 自己解析 §3.3 的用时表，按 t = 12·ln(起点/终点) 逐行重算。
 *
 * 第 3 类是 t7 驳回来的重点：旧版「30.3 s」是混用两个目标算出来的，而旧脚本只判
 * 「这段有没有这个字符串」，所以它全绿通过了。现在凡是能被算出来的数都由脚本重算：
 * 用时表、往返、冥王星圆盘半径、标签深度、阈值/噪声底比值。**错的数靠算术被抓，不靠人眼。**
 *
 * 三种跑法：
 *   node scripts/check-spec-1.4.mjs              检查 docs/spec-1.4.md
 *   node scripts/check-spec-1.4.mjs <path>       检查别的文件
 *   node scripts/check-spec-1.4.mjs --selftest   反向自检：四份改坏的副本必须都红
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = path.join(root, "docs", "spec-1.4.md");

/** 飞行速度模型的唯一常数：τ = 12 s，v = 视距 / τ。改它就要改整张用时表。 */
const TAU_S = 12;
/** 算术复算容差：表里写的数按 1% 判。超了就是算错或抄错。 */
const ARITH_TOL = 0.01;

/**
 * 每个决策段必填的数字/标识。
 *
 * 选词原则：一条 token 对应规格里的一条**判断**，不是对应一个好看的数。
 * 混着纯数字（`72.3 s`）、单位量（`6.3e-5 px`）、带出处的标识（`system-context.tsx`）：
 * 前者防「结论写了但没算」，后者防「数字对但落不了地」。改规格时两边一起改。
 */
const DECISIONS = [
  {
    id: 1,
    title: "实境星空层",
    tokens: [
      { label: "天球半径 = far / 1.2", token: "far / 1.2" },
      { label: "沙盘 far 983.04 与复现值 819.2", token: "983.04" },
      { label: "复现值 819.2（与 820 差 0.0976%）", token: "819.2" },
      { label: "1e16 m 下顶点方向误差 6.3e-5 px", token: "6.3e-5 px" },
      { label: "星点内存 89.6 KB / 天球 36,864 三角", token: "36,864" },
      { label: "第三处定义点在 system-context.tsx", token: "system-context.tsx" },
      { label: "REAL_SYSTEM 必须显式 sky: true（spread 会静默继承 false）", token: "sky: true" },
      { label: "探针要能读到 mounted.stars", token: "mounted.stars" },
    ],
  },
  {
    id: 2,
    title: "飞行",
    tokens: [
      { label: "动词三拍之一：选目标", token: "选目标" },
      { label: "动词三拍之二：推进", token: "推进" },
      { label: "动词三拍之三：到达", token: "到达" },
      { label: "速度模型 v = max(视距 / 12, 1e4)", token: "/ 12" },
      { label: "地月单程（当前历元）72.3 s", token: "72.3 s" },
      { label: "地月单程（近侧极限）65.3 s", token: "65.3" },
      { label: "地球→冥王星 181.1 s", token: "181.1" },
      { label: "真实档地月往返 8.14 日（对照，不是玩家路径）", token: "8.14 日" },
      { label: "真实档地球→灶神星 1.09 年", token: "1.09 年" },
      { label: "计时探针 __solarFlight()", token: "__solarFlight" },
    ],
  },
  {
    id: 3,
    title: "连续缩放验收",
    tokens: [
      { label: "抖动阈值 0.35 px（与 proto-jitter 同一套）", token: "0.35 px" },
      { label: "0.35 是噪声底 0.067 的 5.2 倍", token: "5.2 倍" },
      { label: "0.35 是旧注释 0.081 的 4.3 倍", token: "4.3 倍" },
      { label: "帧率下限 30 fps", token: "30 fps" },
      { label: "帧间隔闸 p95 ≤ 33.3 ms", token: "33.3 ms" },
      { label: "真机型号 Intel Arc 130T", token: "Arc 130T" },
      { label: "120 帧窗口", token: "120 帧" },
      { label: "最近视距 1.2 R = 7.645e6 m", token: "7.645e6" },
      { label: "缩放跨度 6.12 个量级", token: "6.12" },
      { label: "停稳判据 ZOOM_SETTLE_LOG", token: "ZOOM_SETTLE_LOG" },
      { label: "真机帧率产物 runs/fps-1.4.0-*.json", token: "fps-1.4.0" },
      { label: "夹具点专用常数：dist=1.8e7 底是 6.1 倍", token: "1.8e7" },
    ],
  },
  {
    id: 4,
    title: "冥王星与哈雷",
    tokens: [
      { label: "冥王星 focus 改到 1.2e7", token: "1.2e7" },
      { label: "改前圆盘 0.74 px（等于没有）", token: "0.74 px" },
      { label: "改后圆盘 93.3 px", token: "93.3" },
      { label: "哈雷 focus 下 0.0103 px", token: "0.0103 px" },
      { label: "标签 maxDepth 5.76e8", token: "5.76e8" },
      { label: "哈雷数据保留、只从 build 摘", token: "HALLEY_ELEMENTS" },
      { label: "逆行轨道 162.19°", token: "162.19" },
      { label: "冥王星探针 __solarFocus()", token: "__solarFocus" },
    ],
  },
];

/** PLAN 第 6 节的禁词表。规格自己也要过语气闸。 */
const BANNED = [
  "仿佛",
  "不禁",
  "让我们",
  "值得注意的是",
  "总而言之",
  "综上所述",
  "如同",
  "无声地",
  "悄然",
  "交织",
  "涟漪",
  "命运的齿轮",
  "星辰大海",
  "在这个",
];

const MARKERS = [
  { label: "结论段", token: "**结论：**" },
  { label: "数字段", token: "**数字：**" },
  { label: "推翻条件", token: "**推翻条件：**" },
];

/** 把文档切成 `## N 决策 M 标题` 段。返回 Map<决策号, 正文>。 */
function splitDecisions(text) {
  const out = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n"));
    buf = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const head = /^##\s+(\d+)\s+决策\s+(\d+)/.exec(line);
    if (/^##\s+/.test(line)) {
      flush();
      current = head ? Number(head[2]) : null;
      continue;
    }
    if (current !== null) buf.push(line);
  }
  flush();
  return out;
}

/**
 * 解析 §3.3 的用时表。行格式故意收窄，别的表不会被误读：
 *   | 目标 | 4.805e8 m | 7.6452e6 m | 49.7 s | ±10% |
 * 只认「起点终点都是科学计数法 + 单位 m、用时是十进制 + 单位 s」的行。
 */
function parseFlightTable(text) {
  const at = text.indexOf("### 3.3");
  if (at < 0) return { rows: [], reason: "找不到 §3.3 的子节标题" };
  const rest = text.slice(at);
  const next = rest.indexOf("\n### ", 5);
  const block = next > 0 ? rest.slice(0, next) : rest;
  const rows = [];
  const re = /^\|([^|]+)\|\s*([0-9.]+e[+-]?[0-9]+)\s*m\s*\|\s*([0-9.]+e[+-]?[0-9]+)\s*m\s*\|\s*([0-9.]+)\s*s\s*\|/;
  for (const line of block.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    rows.push({ name: m[1].trim(), start: Number(m[2]), end: Number(m[3]), stated: Number(m[4]) });
  }
  return { rows, reason: rows.length ? "" : "§3.3 里一行用时表都没解析到" };
}

/**
 * 算术复算。每一行独立判：表里写的用时必须等于 12·ln(起点/终点)，容差 1%。
 *
 * 这一条就是为「30.3 s」那种数准备的：混用目标算出来的数，在表里永远对不上公式，
 * 而纯字符串检查看不出来——30.3 只是个"正常数字"。
 */
function checkArithmetic(text, ok, bad) {
  const { rows, reason } = parseFlightTable(text);
  if (!rows.length) {
    bad("§3.3 用时表可解析", reason);
    return;
  }
  ok("§3.3 用时表可解析", `${rows.length} 行`);

  let worst = 0;
  for (const r of rows) {
    if (!(r.start > 0) || !(r.end > 0) || !(r.end < r.start)) {
      bad(`用时表行「${r.name}」距离合法`, `起点 ${r.start} / 终点 ${r.end} 不构成一次接近`);
      continue;
    }
    const want = TAU_S * Math.log(r.start / r.end);
    const err = Math.abs(want - r.stated) / want;
    worst = Math.max(worst, err);
    if (err > ARITH_TOL) {
      bad(
        `用时表行「${r.name}」复算`,
        `${TAU_S}·ln(${r.start}/${r.end}) = ${want.toFixed(2)} s，表里写 ${r.stated} s（差 ${(err * 100).toFixed(1)}%）——起点或终点混用了？`,
      );
    }
  }
  if (!worst) worst = 0;
  ok("§3.3 全部用时行复算一致", `最大偏差 ${(worst * 100).toFixed(2)}%`);

  // 往返 = 2 × 单程：月球两行是单程的上下界，往返带的上下界必须是它们的 2 倍。
  const moons = rows.filter((r) => r.name.includes("月球"));
  if (moons.length < 2) {
    bad("地月往返可复算", `月球行只有 ${moons.length} 条，算不出单程上下界`);
  } else {
    const times = moons.map((r) => TAU_S * Math.log(r.start / r.end));
    const lo = 2 * Math.min(...times);
    const hi = 2 * Math.max(...times);
    const hasLo = text.includes(lo.toFixed(1));
    const hasHi = text.includes(hi.toFixed(1));
    if (hasLo && hasHi) ok("地月往返 = 2 × 单程", `${lo.toFixed(1)} / ${hi.toFixed(1)} s 都在文里`);
    else
      bad(
        "地月往返 = 2 × 单程",
        `复算得 ${lo.toFixed(1)} / ${hi.toFixed(1)} s，文里${hasLo ? "" : "缺下界"}${hasHi ? "" : "缺上界"}`,
      );
  }

  // 冥王星圆盘半径：focal(42°/720 行) × tan(asin(R/d))。
  const focal = 720 / 2 / Math.tan((21 * Math.PI) / 180);
  const plutoPx = focal * Math.tan(Math.asin(1.1883e6 / 1.2e7));
  if (text.includes(plutoPx.toFixed(1))) ok("冥王星圆盘半径复算", `${plutoPx.toFixed(1)} px 在文里`);
  else bad("冥王星圆盘半径复算", `算得 ${plutoPx.toFixed(1)} px，文里没有这个数`);

  // 标签最大可见深度：max(focus×48, radius×200)。
  const depth = Math.max(1.2e7 * 48, 1.1883e6 * 200);
  if (text.includes(depth.toExponential(2).replace("e+", "e"))) ok("标签深度复算", "5.76e8 在文里");
  else bad("标签深度复算", `算得 ${depth.toExponential(2)}，文里没有`);

  // 阈值与噪声底的比值：0.35 / 0.067 = 5.2，0.35 / 0.081 = 4.3。
  const r1 = (0.35 / 0.067).toFixed(1);
  const r2 = (0.35 / 0.081).toFixed(1);
  if (text.includes(`${r1} 倍`) && text.includes(`${r2} 倍`)) ok("阈值/噪声底比值复算", `${r1} 与 ${r2} 都在文里`);
  else bad("阈值/噪声底比值复算", `算得 ${r1} / ${r2} 倍，文里对不上`);
}

/** 纯函数：检查一段文本，返回 {checks, failures}。 */
function check(text) {
  const checks = [];
  const failures = [];
  const ok = (label, evidence = "") => checks.push({ ok: true, label, evidence });
  const bad = (label, evidence = "") => {
    checks.push({ ok: false, label, evidence });
    failures.push(evidence ? `${label}：${evidence}` : label);
  };

  const sections = splitDecisions(text);

  for (const d of DECISIONS) {
    const body = sections.get(d.id);
    if (!body) {
      bad(`决策 ${d.id} 段存在`, `没找到标题形如「## N 决策 ${d.id} …」的小节`);
      continue;
    }
    ok(`决策 ${d.id} 段存在`, d.title);

    for (const m of MARKERS) {
      if (body.includes(m.token)) ok(`决策 ${d.id} 有${m.label}`);
      else bad(`决策 ${d.id} 有${m.label}`, `缺标记 ${m.token}`);
    }
    for (const t of d.tokens) {
      if (body.includes(t.token)) ok(`决策 ${d.id} 数字：${t.label}`);
      else bad(`决策 ${d.id} 数字：${t.label}`, `段内找不到「${t.token}」`);
    }
  }

  // 行号基准（t7 第 12 条）：没有这一行，文里的行号引用就是不可复核的。
  const hasTreeNote = /行号基准/.test(text) && /git\s+[0-9a-f]{7}/.test(text);
  if (hasTreeNote) ok("行号引用有 tree 基准", "文首记了 git rev");
  else bad("行号引用有 tree 基准", "文首缺「行号基准：git <rev> + 工作树」");

  checkArithmetic(text, ok, bad);

  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const w of BANNED) if (lines[i].includes(w)) hits.push(`第 ${i + 1} 行「${w}」`);
  }
  if (hits.length) bad("禁词表", hits.slice(0, 6).join("，") + (hits.length > 6 ? ` 等 ${hits.length} 处` : ""));
  else ok("禁词表", `0 命中（${BANNED.length} 个词）`);

  const softHits = ["建议进一步评估", "有待观察", "视情况而定"].filter((s) => text.includes(s));
  if (softHits.length) bad("决策必须定死", softHits.map((s) => `出现免责句式「${s}」`).join("，"));
  else ok("免责句式", "0 命中");

  return { checks, failures };
}

function report({ checks, failures }, file) {
  console.log(`spec-1.4 检查：${path.relative(root, file) || file}`);
  const width = Math.max(...checks.map((c) => c.label.length), 8);
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`  ${mark} ${c.label.padEnd(width)} ${c.evidence ? `— ${c.evidence}` : ""}`.trimEnd());
  }
  console.log("");
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败（共 ${checks.length} 项）`);
    for (const f of failures) console.error(`  · ${f}`);
    return 1;
  }
  console.log(`✓ 全部通过（${checks.length} 项）`);
  return 0;
}

/**
 * 自检：四份反例必须都红。第四条（把用时改回 30.3）专门验算术复算真的在跑——
 * 它在字符串层面完全合法（30.3 是个正常数字），只有重算才抓得住。
 */
async function selftest(text) {
  const base = check(text);
  const problems = [];
  if (base.failures.length) {
    problems.push(`原文应当全绿，实际 ${base.failures.length} 项失败 —— 先修原文，再谈自检`);
    for (const f of base.failures) console.error(`  · ${f}`);
    console.error("✗ 自检失败");
    return 1;
  }

  const start = text.indexOf("## 4 决策 3");
  const end = text.indexOf("## 5 决策 4");
  const stripFromDecision2 = (t) => {
    const i = t.indexOf("## 3 决策 2");
    const j = t.indexOf("## 4 决策 3");
    if (i < 0 || j <= i) return t;
    return t.slice(0, i) + t.slice(i, j).replaceAll("72.3 s", "（自检抽掉的数）") + t.slice(j);
  };
  const mutations = [
    {
      name: "删掉整段决策 3",
      why: "缺段必须红",
      text:
        start >= 0 && end > start
          ? text.slice(0, start) + text.slice(end)
          : `${text}\n（原文里找不到决策 3 段，无法造这条反例）`,
    },
    {
      name: "只在决策 2 段里抽掉「72.3 s」",
      why: "段的数字不能靠别处凑",
      text: stripFromDecision2(text),
    },
    {
      name: "正文里塞一个禁词",
      why: "语气闸必须红",
      text: `${text}\n\n这段是临时加的：仿佛一切都对。\n`,
    },
    {
      name: "把月球那行的用时改回 30.3 s",
      why: "错的数必须被算术复算抓住",
      text: text.replace("| 72.3 s | ±10% |", "| 30.3 s | ±10% |"),
    },
  ];

  for (const m of mutations) {
    const r = check(m.text);
    if (r.failures.length === 0) problems.push(`反例「${m.name}」没有变红（${m.why}）—— 检查器漏了`);
    else console.log(`  ✓ 反例「${m.name}」按预期变红（${r.failures.length} 项）：${r.failures[0]}`);
  }

  console.log("");
  if (problems.length) {
    for (const p of problems) console.error(`  · ${p}`);
    console.error("✗ 自检失败");
    return 1;
  }
  console.log(`✓ 自检通过：原文绿，${mutations.length} 份反例全红`);
  return 0;
}

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_SPEC;
const wantSelftest = argv.includes("--selftest");

let text;
try {
  text = await readFile(target, "utf8");
} catch (err) {
  console.error(`✗ 读不到 ${target}：${err.message}`);
  console.error("  1.4.0 的四个决策必须落在 docs/spec-1.4.md 里，文档不在等于规格不存在。");
  process.exit(1);
}

if (wantSelftest) {
  console.log("spec-1.4 检查器自检（反例必须红）");
  process.exit(await selftest(text));
}

process.exit(report(check(text), target));
