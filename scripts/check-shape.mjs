#!/usr/bin/env node
/**
 * 形状判据（shape guard）—— 防「同一个概念长出第二份真相」。
 *
 * ⚠ 定位：**形状判据是门卫，行为判据才是裁判，两层别混成一层报。**
 *   形状判据只能证明「这个写法只出现在这里」，证明不了「它算出来的数是对的」。
 *   典型反例（critic 点破的）：把 `tan(asin(R/d))` 改成 `tan(asin(R/d)/2)`，
 *   本文件第 1 条的计数不变、依旧全绿，而所有点击热区静默腰斩。
 *   所以第 1 条真正的护栏是行为断言（同帧 `__solarProbe()[i].radiusPx` 对
 *   `__solarPick.candidates()[i].radiusPx`，差 < 1e-6；外加 t17 的四个构造点：
 *   土星环空白点 / 月球盘内 / 地球盘内 / 相机背后）。那层排在 t33 之后做，不在本文件里。
 *
 * 判定语义（三条，缺一条就会被当成摆设）：
 *   1. **命中 0 不是通过，是判据失效** → 打 `VACUOUS`。重构把符号删干净之后，
 *      「数它还有几处」这种判据会真空变绿：将来用新名字复现同一份双真相，它照样全绿。
 *      VACUOUS **不算失败**（退出码仍 0），理由见下。
 *   2. **删除类判据必须能被证明会红** → `--selftest` 在临时副本里故意重引入一个副本，
 *      断言对应判据确实变红。跑不通的护栏不算护栏。
 *   3. **扫描范围是显式清单，不是递归 glob**：`src/copy/**`、`dist/`、`release/` 里的
 *      字符串会污染计数，第一次跑就有人把脚本关掉。清单漂移由 meta 判据兜。
 *
 * VACUOUS 为什么不判红：重构之后 #3/#4/#5/#6 在当前代码上必然命中 0，判红会让这条命令
 * 永远红——本仓库有过先例（帧时间写死 `EMA ≤ 26ms`，忙机器天天红，红到没人看）。
 * 所以 vacuous 打警告 + 计入汇总，靠 `--selftest` 保它的命。
 *
 * 用法：
 *   node scripts/check-shape.mjs             # 六条 + 清单完整性
 *   node scripts/check-shape.mjs --selftest  # 额外证明每条判据都有牙齿（临时副本，几秒钟）
 *   node scripts/check-shape.mjs --dump <文件>  # 维护用：打印该文件每一行的代码/注释分类结果
 *                                            # （怀疑注释判定误判时，先用它看一眼）
 *
 * 退出码：0 = 无失败（可能含 VACUOUS）；1 = 有 FAIL，或 --selftest 没通过。
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * 显式扫描清单（不递归）。新增 src 文件时**必须**加进来，
 * 否则 meta 判据会红——它就是在防「新文件悄悄逃出扫描范围」。
 */
const SCAN_FILES = [
  "src/App.tsx",
  "src/env.d.ts",
  "src/main.tsx",
  "src/solar/BrandMark.tsx",
  "src/solar/Hud.tsx",
  "src/solar/ModeBadge.tsx",
  "src/solar/SolarCanvas.tsx",
  "src/solar/brand.ts",
  "src/solar/clock.ts",
  "src/solar/data.ts",
  "src/solar/gate.ts",
  "src/solar/pick.ts",
  "src/solar/progress.ts",
  "src/solar/quality.ts",
  "src/solar/starfield.ts",
  "src/solar/store.ts",
  "src/solar/system-context.tsx",
  "src/solar/systems.ts",
  "src/solar/textures.ts",
];

/** 用于「清单漂移」检测的目录（只看这一层的 .ts/.tsx，不递归） */
const SCAN_DIRS = ["src", "src/solar"];

// ——— 注释 / 代码分离 ———————————————————————————————————
/**
 * 把源码切成「每行的代码片段」与「每行的注释片段」。
 *
 * 规则（够用就好，不追求完美）：
 *  - 行注释 `//` 到行尾算注释；块注释 `/* … *\/` 之内算注释（可跨行）。
 *  - 字符串 `'…'` / `"…"` / 模板 `` `…` `` 的**内容按代码计**（保守：宁可多报）。
 *    模板里的 `${…}` 按代码计（它确实是代码）。
 *  - 已知误判（本仓库目前不触发，但换代码后要重看）：
 *    a) 正则字面量里的 `//` 或 `/*`（如 `/\/\//`）会被当成注释起点 → 该行后半段误判为注释；
 *    b) JSX 文本节点、`String.raw` 内容按代码计；
 *    c) 跨行字符串（模板除外）在 TS 里非法，不会出现；
 *    d) 字符串里出现被删符号（如 `"lookOf"`）会被计入代码命中——这是有意的，
 *       一个引用已删符号的字符串同样可疑。
 */
function classify(text) {
  const lines = [{ code: "", comment: "" }];
  let line = 0;
  let i = 0;
  /** 状态栈：{ type: "code", brace } | { type: "tpl" } | { type: "sq"|"dq" } | { type: "line" } | { type: "block" } */
  const stack = [{ type: "code", brace: 0 }];
  const top = () => stack[stack.length - 1];
  const put = (ch, isComment) => {
    const L = lines[line];
    if (isComment) L.comment += ch;
    else L.code += ch;
  };

  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    const cur = top();

    if (ch === "\n") {
      lines.push({ code: "", comment: "" });
      line++;
      if (cur.type === "line") stack.pop();
      i++;
      continue;
    }
    if (cur.type === "line") {
      put(ch, true);
      i++;
      continue;
    }
    if (cur.type === "block") {
      if (ch === "*" && nx === "/") {
        put("*/", true);
        i += 2;
        stack.pop();
        continue;
      }
      put(ch, true);
      i++;
      continue;
    }
    if (cur.type === "sq" || cur.type === "dq") {
      const quote = cur.type === "sq" ? "'" : '"';
      if (ch === "\\") {
        put(ch + (nx ?? ""), false);
        i += 2;
        continue;
      }
      if (ch === quote) {
        put(ch, false);
        i++;
        stack.pop();
        continue;
      }
      put(ch, false);
      i++;
      continue;
    }
    if (cur.type === "tpl") {
      if (ch === "\\") {
        put(ch + (nx ?? ""), false);
        i += 2;
        continue;
      }
      if (ch === "`") {
        put(ch, false);
        i++;
        stack.pop();
        continue;
      }
      if (ch === "$" && nx === "{") {
        put("${", false);
        i += 2;
        stack.push({ type: "code", brace: 0 });
        continue;
      }
      put(ch, false);
      i++;
      continue;
    }

    // 代码态
    if (ch === "/" && nx === "/") {
      stack.push({ type: "line" });
      put("//", true);
      i += 2;
      continue;
    }
    if (ch === "/" && nx === "*") {
      stack.push({ type: "block" });
      put("/*", true);
      i += 2;
      continue;
    }
    if (ch === "'") {
      stack.push({ type: "sq" });
      put(ch, false);
      i++;
      continue;
    }
    if (ch === '"') {
      stack.push({ type: "dq" });
      put(ch, false);
      i++;
      continue;
    }
    if (ch === "`") {
      stack.push({ type: "tpl" });
      put(ch, false);
      i++;
      continue;
    }
    if (ch === "{") {
      cur.brace++;
      put(ch, false);
      i++;
      continue;
    }
    if (ch === "}") {
      if (cur.brace === 0 && stack.length > 1 && stack[stack.length - 2].type === "tpl") {
        stack.pop(); // 结束 ${…}，回到模板正文
        put(ch, false);
        i++;
        continue;
      }
      cur.brace--;
      put(ch, false);
      i++;
      continue;
    }
    put(ch, false);
    i++;
  }
  return lines;
}

/** 读一遍清单里的文件，返回 [{ file, lines }] */
function loadFiles(root, files) {
  return files.map((rel) => ({
    file: rel,
    lines: classify(readFileSync(path.join(root, rel), "utf8")),
  }));
}

/** 在某个「片段类型」上找命中：kind = "code" | "comment"。**每行最多算一次**（行命中，不是出现次数） */
function hitsIn(loaded, regex, kind) {
  const out = [];
  for (const { file, lines } of loaded) {
    lines.forEach((L, i) => {
      const seg = kind === "code" ? L.code : L.comment;
      if (!seg) return;
      const m = new RegExp(regex.source, regex.flags).exec(seg);
      if (!m) return;
      out.push({
        file,
        line: i + 1,
        text: seg.trim(),
        match: m[0],
        kind,
      });
    });
  }
  return out;
}

/**
 * 计算某个函数体的行范围，找不到返回 null。
 *
 * 为什么要括号感知：参数列表里的**类型字面量**本身就带花括号，例如
 * `camera: { near: number; far: number }`。只数花括号会在参数还没结束时
 * 就配平到 0，把函数体截成两行（这个坑我第一次写就踩了）。
 * 所以先跟踪圆括号深度，只在 `paren === 0` 处出现的 `{` 才算函数体开始。
 *
 * 已知限制：返回类型里带对象字面量（`): { a: number } {`）时，第一个
 * `paren === 0` 的 `{` 是返回类型而不是函数体 → 范围会偏短。本仓库不触发；
 * 真出现时 `--dump-fn` 一眼能看出来，改用显式行号区间即可。
 */
function functionRange(loaded, file, startRegex) {
  const target = loaded.find((f) => f.file === file);
  if (!target) return null;
  let start = -1;
  for (let i = 0; i < target.lines.length; i++) {
    if (startRegex.test(target.lines[i].code)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let paren = 0;
  let body = -1;
  let depth = 0;
  for (let i = start; i < target.lines.length; i++) {
    for (const ch of target.lines[i].code) {
      if (body < 0) {
        if (ch === "(") paren++;
        else if (ch === ")") paren--;
        else if (ch === "{" && paren === 0) {
          body = i;
          depth = 1;
        }
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return { start: start + 1, body: body + 1, end: i + 1 };
      }
    }
  }
  return { start: start + 1, body: body + 1, end: target.lines.length };
}

// ——— 六条判据 ————————————————————————————————————————
/**
 * 每条返回 { hits, observed, ok, raw }：
 *  - hits: 需要展示的命中（失败时逐条打印 文件:行号: 内容）
 *  - observed: 人看的当前值摘要
 *  - ok: true=通过 / false=失败（命中 0 由外层统一判 VACUOUS）
 *  - raw: **过滤前的原始命中数**。selftest 用它判断「注入后确实被数到了」——
 *    不能用 hits.length，因为有的判据在通过时只展示"坏的那部分"（如第 2 条只列函数外），
 *    注入后显示数反而会变小。这个坑我在 selftest 第一次跑就踩了。
 */
const CHECKS = [
  {
    id: 1,
    title: "焦距公式 Math.tan(...fov)",
    // 指向 tanHalfFov 而不是 focalPx：fov 约定现在收在 pick.ts 的 tanHalfFov 一行，
    // focalPx（焦距）与 halfSpanAt（它的反解）都只是调用者。判据逻辑只数「pick.ts 之外」，
    // 与命中落在哪一行无关；但 expect 文字必须说对 —— 否则下一个人看到「PASS 但命中不在
    // focalPx 里」会以为判据漏了（engineer2 在 t35 提的，采纳）。
    expect: "只在 src/solar/pick.ts 的 tanHalfFov（focalPx / halfSpanAt 的唯一 fov 约定点）",
    run(loaded) {
      const hits = hitsIn(loaded, /Math\.tan\([^)\n]*[fF]ov/, "code");
      const outside = hits.filter((h) => h.file !== "src/solar/pick.ts");
      return {
        hits: outside.length ? outside : hits,
        observed: `${hits.length} 处（pick.ts ${hits.length - outside.length}，其它 ${outside.length}）`,
        ok: outside.length === 0,
        raw: hits.length,
      };
    },
  },
  {
    id: 2,
    title: "camera.near / camera.far 的写入点",
    expect: "只在 src/solar/systems.ts 的 tightenClipPlanes 内",
    run(loaded) {
      const hits = hitsIn(loaded, /\bcamera\.(near|far)\s*=[^=]/, "code");
      const range = functionRange(loaded, "src/solar/systems.ts", /function\s+tightenClipPlanes/);
      const outside = hits.filter(
        (h) => !(h.file === "src/solar/systems.ts" && range && h.line >= range.start && h.line <= range.end),
      );
      return {
        hits: outside.length ? outside : hits,
        observed: `${hits.length} 处（函数内 ${hits.length - outside.length}，函数外 ${outside.length}）`,
        ok: outside.length === 0,
        raw: hits.length,
      };
    },
  },
  {
    id: 3,
    title: 'spec.unit === "meter" 在 SolarCanvas.tsx',
    expect: "≤ 2（R3 之后应为 0）",
    run(loaded) {
      const all = hitsIn(loaded, /\bspec\.unit\s*===/, "code");
      const hits = all.filter((h) => h.file === "src/solar/SolarCanvas.tsx");
      return { hits, observed: `${hits.length} 处`, ok: hits.length <= 2, raw: hits.length };
    },
  },
  {
    id: 4,
    title: "inReal 在 Hud.tsx",
    expect: "≤ 1（唯一的模式判断点）",
    run(loaded) {
      const all = hitsIn(loaded, /\binReal\b/, "code");
      const hits = all.filter((h) => h.file === "src/solar/Hud.tsx");
      return { hits, observed: `${hits.length} 处`, ok: hits.length <= 1, raw: hits.length };
    },
  },
  {
    id: 5,
    title: "simClock 在 src/",
    expect: "0（时钟已收进 simClock，不许再有第二处）",
    run(loaded) {
      const hits = hitsIn(loaded, /\bsimClock\b/, "code");
      return { hits, observed: `${hits.length} 处`, ok: hits.length === 0, raw: hits.length };
    },
  },
  {
    id: 6,
    title: "已删除符号（realPose / dip( / SANDBOX_LOOK / lookOf / startSwitchPose / appliedMode / switchReleased）",
    expect: "代码里 0；注释允许保留历史说明，但逐条列出",
    run(loaded) {
      const symbols = [
        ["realPose", /\brealPose\b/],
        ["dip(", /\bdip\s*\(/],
        ["SANDBOX_LOOK", /\bSANDBOX_LOOK\b/],
        ["lookOf", /\blookOf\b/],
        ["startSwitchPose", /\bstartSwitchPose\b/],
        ["appliedMode", /\bappliedMode\b/],
        ["switchReleased", /\bswitchReleased\b/],
      ];
      const codeHits = [];
      for (const [name, re] of symbols) {
        for (const h of hitsIn(loaded, re, "code")) codeHits.push({ ...h, symbol: name });
      }
      const commentHits = [];
      for (const [name, re] of symbols) {
        for (const h of hitsIn(loaded, re, "comment")) commentHits.push({ ...h, symbol: name });
      }
      return {
        hits: codeHits,
        extra: commentHits,
        observed: `代码 ${codeHits.length} 处 / 注释 ${commentHits.length} 处`,
        ok: codeHits.length === 0,
        raw: codeHits.length,
      };
    },
  },
  {
    id: 7,
    title: "压缩策略的四条比率（data.ts ↔ README 双向：代码改了红，故事改了也红）",
    // 为什么要有这条：README 里写着「太阳/地球画成 5:1，真实 109:1」「月球/地球 0.263（真值 0.273）」
    // 「月球角径只有太阳的 0.417，日面最多遮 17.4%」——这些是**叙事的一部分**，改一个数就是改故事。
    // 所以两边都要判：
    //   ① 从 data.ts 现算四个比率，与设计值比；
    //   ② 再去根 README.md 里找那四个 token（只认「数 + 单位」，不认整句——措辞可以改，数不许漂）。
    // 只做 ① 的话，判据守的是「代码没变味」；README 是手最容易动的那一份，必须一起守。
    // ±1% 的来历：文档里这四个数只印到 2–3 位有效数字（5:1 / 0.263 / 0.417 / 17.4%），
    // ±1% 就是「印出来的数按四舍五入换算回来」的误差上限，**不是观测容差**。
    // 要改精度就同时改这句话与 README 的印刷位数，别只动其中之一。
    // 口径：角径与遮挡都按「从地球轨道半径看太阳」算（angSun = atan(sunR / earthOrbit)）。
    // 将来若要做「从火星看日食」，这里是唯一要改的地方——它把观测者写死在算式里，不藏在注释里。
    // 占位：周期一致性（开普勒 T²∝a³ 在压缩比例下必然不成立）**不在这里判**，等行为断言那层。
    expect:
      "太阳/地球 5.0×、月球/地球 0.263、月球÷太阳角径 0.417、日面遮挡 17.4%（各 ±1%），且 README.md 里同样印着这四个数；周期一致性待行为断言",
    run(loaded) {
      const f = loaded.find((x) => x.file === "src/solar/data.ts");
      if (!f) {
        return { hits: [{ file: "src/solar/data.ts", line: 0, text: "读不到 data.ts，这条判不了" }], observed: "缺文件", ok: false, raw: 1 };
      }
      // classify() 把每行拆成 code/comment 两段，所以要先拼回文本再找常数
      const text = f.lines.map((l) => `${l.code ?? ""}${l.comment ?? ""}`).join("\n");
      const count = (id) => text.split(`id: "${id}"`).length - 1;
      const grab = (id, field) => {
        const at = text.indexOf(`id: "${id}"`);
        if (at < 0) return null;
        const seg = text.slice(at, at + 1500);
        const m = new RegExp(`\\b${field}:\\s*([0-9.]+)`).exec(seg);
        return m ? Number(m[1]) : null;
      };
      const sunR = grab("sun", "radius");
      const earthR = grab("earth", "radius");
      const moonR = grab("moon", "radius");
      const earthOrbit = grab("earth", "orbitRadius");
      const moonOrbit = grab("moon", "orbitRadius");
      const dupes = ["sun", "earth", "moon"].filter((id) => count(id) > 1);

      const rows = [];
      const dev = [];
      if (!sunR || !earthR || !moonR || !earthOrbit || !moonOrbit) {
        return { hits: [{ file: "src/solar/data.ts", line: 0, text: "取不到 sun/earth/moon 的 radius 或 orbitRadius" }], observed: "缺数据", ok: false, raw: 1 };
      }
      const ratio = (label, got, want, unit = "×") => {
        const off = Math.abs(got - want) / want;
        const text = `${label} = ${got.toFixed(4)}${unit}（设计 ${want}${unit}，偏差 ${(off * 100).toFixed(2)}%）`;
        rows.push({ file: "src/solar/data.ts", line: 0, text });
        if (off > 0.01) dev.push(text);
      };
      const angMoon = Math.atan(moonR / moonOrbit);
      const angSun = Math.atan(sunR / earthOrbit);
      ratio("太阳/地球 半径比", sunR / earthR, 5.0);
      ratio("月球/地球 半径比", moonR / earthR, 0.263);
      ratio("月球÷太阳 角径比（从地球看）", angMoon / angSun, 0.417);
      ratio("日面最大遮挡比例（角径比²）", (angMoon / angSun) ** 2, 0.174, "");
      for (const id of dupes) {
        dev.push(`data.ts 里 id: "${id}" 出现了 ${count(id)} 次 —— 同一个天体两份定义，比率会变成「取第一个」，必须删掉多余的`);
      }

      // ② 根 README 里那五个数：**找不到就红**。
      // 不写成「找不到就跳过」——那等于给一条会静默失效的判据，正是这份脚本一直在防的东西。
      // 只匹配「数 + 单位」这种最紧的 token，不匹配整句：措辞可以改，数不许漂。
      let md = "";
      try {
        md = readFileSync(path.join(ROOT, "README.md"), "utf8");
      } catch {
        md = "";
      }
      const docNums = [
        ["太阳/地球 5:1", "5:1"],
        ["太阳/地球 真值 109:1", "109:1"],
        ["月球/地球 0.263", "0.263"],
        ["月球/太阳 角径 0.417", "0.417"],
        ["日面遮挡 17.4%", "17.4%"],
      ];
      for (const [label, token] of docNums) {
        if (md.includes(token)) {
          rows.push({ file: "README.md", line: 0, text: `${label} = ${token}（README 里在）` });
        } else {
          dev.push(
            `README.md 里找不到「${label}」（${token}）—— 那句被改写或删掉了：要么恢复，要么同步改本判据（改数就两边一起改）`,
          );
        }
      }
      return {
        // 诊断语里已经指明是哪个文件，hits 的文件名跟着走——别把 README 的问题报成 data.ts
        hits: dev.length
          ? dev.map((text) => ({ file: text.startsWith("README.md") ? "README.md" : "src/solar/data.ts", line: 0, text }))
          : rows,
        observed: dev.length
          ? `${dev.length} 处偏离（四条比率 / 重复定义 / README 里的数）`
          : "四条比率与设计一致，README 里的五个数也都在（周期一致性未纳入，等行为断言那层）",
        ok: dev.length === 0,
        // raw 必须随「发现的东西」单调增长：selftest 用它证明「注入后真的被数到了」。
        // 只写 dev.length 会让「4 条比率 → 1 处偏离」在数值上变小，selftest 判成没红。
        raw: rows.length + dev.length + dupes.length,
      };
    },
  },
];

/** 清单漂移：src 下这一层出现的 .ts/.tsx 必须都在 SCAN_FILES 里，反之亦然 */
function checkManifest(loaded) {
  const problems = [];
  const listed = new Set(SCAN_FILES);
  for (const dir of SCAN_DIRS) {
    let entries = [];
    try {
      entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      problems.push({ file: dir, line: 0, text: "目录不存在" });
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (!listed.has(rel)) {
        problems.push({
          file: rel,
          line: 0,
          text: "src 里有文件不在 SCAN_FILES 清单中 → 把它加进 scripts/check-shape.mjs 的 SCAN_FILES 再重跑（否则六条判据都可能被它绕过去）",
        });
      }
    }
  }
  for (const rel of SCAN_FILES) {
    if (!listed.has(rel)) continue;
    if (!loaded.some((f) => f.file === rel)) problems.push({ file: rel, line: 0, text: "清单里的文件读不到" });
  }
  return { problems, observed: `${SCAN_FILES.length} 个文件 / 漂移 ${problems.length} 处`, ok: problems.length === 0 };
}

// ——— 跑一遍 ——————————————————————————————————————————
function runChecks(root, files) {
  const loaded = loadFiles(root, files);
  const results = CHECKS.map((c) => {
    const r = c.run(loaded);
    const status = !r.ok ? "FAIL" : r.hits.length === 0 ? "VACUOUS" : "PASS";
    return { check: c, ...r, status };
  });
  const manifest = checkManifest(loaded);
  return { results, manifest };
}

function printReport({ results, manifest }, { root }) {
  console.log(`形状判据 check-shape  (root: ${path.relative(process.cwd(), root) || "."})`);
  console.log("─".repeat(78));
  for (const r of results) {
    const c = r.check;
    console.log(`[${c.id}] ${c.title}`);
    console.log(`    命中=${r.observed} | 期望=${c.expect} | ${r.status}`);
    // 命中位置始终打印（PASS 也打）：判据是「只数 pick.ts 之外」这类相对规则，
    // 光看 PASS 不知道命中落在哪一行；不打印的话「PASS 但位置看着不对」只能靠猜。
    for (const h of r.hits) {
      console.log(`    ${r.status === "FAIL" ? "" : "ⓘ "}${h.file}:${h.line}: ${h.text}`);
    }
    if (r.extra?.length) {
      console.log(`    ⓘ 注释里还提到 ${r.extra.length} 处（史实说明，自行判断是否漏改）：`);
      for (const h of r.extra) console.log(`      ${h.file}:${h.line}: ${h.text}`);
    }
    if (r.status === "VACUOUS") {
      console.log("    ⓘ 命中 0 = 判据在当前代码上失效（不是通过），已由 --selftest 覆盖");
    }
  }
  console.log(`[清单] 扫描范围完整性`);
  console.log(`    命中=${manifest.observed} | 期望=清单与 src 完全一致 | ${manifest.ok ? "PASS" : "FAIL"}`);
  for (const p of manifest.problems) console.log(`    ${p.file}:${p.line}: ${p.text}`);

  const fail = results.filter((r) => r.status === "FAIL").length + (manifest.ok ? 0 : 1);
  const vac = results.filter((r) => r.status === "VACUOUS").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  console.log("─".repeat(78));
  console.log(`状态: ${results.map((r) => `${r.check.id}=${r.status}`).join(" ")} 清单=${manifest.ok ? "PASS" : "FAIL"}`);
  console.log(`结论: ${fail} 条失败 / ${pass} 条通过 / ${vac} 条 vacuous`);
  if (vac > 0) {
    console.log(`⚠ ${vac} 条 vacuous：判据在当前代码上必然命中 0，已失去区分力。`);
    console.log("  它们的牙齿由 `node scripts/check-shape.mjs --selftest` 证明（临时副本里注入副本，断言会红）。");
  }
  return fail;
}

// ——— --selftest：证明每条判据都有牙齿 ————————————————
/**
 * 在临时副本里故意重引入一份「第二真相」，断言对应判据确实变红。
 * 覆盖六条各一次（#3 允许 ≤2、#4 允许 ≤1，所以要注入到跨过阈值）。
 */
const SELFTEST_CASES = [
  {
    id: 1,
    file: "src/solar/SolarCanvas.tsx",
    inject: '\nconst __fakeFocal = (h: number, fov: number) => h / 2 / Math.tan((fov * Math.PI) / 360);\n',
  },
  {
    id: 2,
    file: "src/solar/pick.ts",
    inject: "\nfunction __fakeClip(camera: { near: number; far: number }) {\n  camera.near = 1;\n}\n",
  },
  {
    id: 3,
    file: "src/solar/SolarCanvas.tsx",
    inject:
      '\nconst __s1 = spec.unit === "meter";\nconst __s2 = spec.unit === "meter";\nconst __s3 = spec.unit === "meter";\n',
  },
  {
    id: 4,
    file: "src/solar/Hud.tsx",
    inject: "\nconst __i1 = inReal;\nconst __i2 = inReal;\n",
  },
  { id: 5, file: "src/solar/clock.ts", inject: "\nexport const simClock = () => 1;\n" },
  { id: 6, file: "src/solar/store.ts", inject: "\nexport const lookOf = () => null;\n" },
  {
    // 第 7 条的注入方式是「给地球加第二份定义」：既触发重复检测，又让四条比率变成「取第一个」。
    // 这正好是这条判据要防的那类事故——故事里的数被悄悄改一份。
    id: 7,
    file: "src/solar/data.ts",
    inject: '\n  { id: "earth", name: "地球二号", radius: 1.2, orbitRadius: 15.2, period: 18 },\n',
  },
];

function selftest() {
  const base = runChecks(ROOT, SCAN_FILES);
  console.log("\n".repeat(1) + "─".repeat(78));
  console.log("--selftest：在临时副本里注入「第二真相」，断言判据会红");
  let failures = 0;
  for (const test of SELFTEST_CASES) {
    const dir = mkdtempSync(path.join(tmpdir(), "check-shape-"));
    try {
      for (const rel of SCAN_FILES) {
        const src = path.join(ROOT, rel);
        const dst = path.join(dir, rel);
        mkdirSync(path.dirname(dst), { recursive: true });
        cpSync(src, dst);
      }
      const target = path.join(dir, test.file);
      writeFileSync(target, readFileSync(target, "utf8") + test.inject);
      const after = runChecks(dir, SCAN_FILES);
      const b = base.results.find((r) => r.check.id === test.id);
      const a = after.results.find((r) => r.check.id === test.id);
      // 两点都要成立：注入后被判红 + 原始命中数确实增加（证明脚本真数到了它）。
      // 不能用 hits.length 比较：第 2 条通过时只展示"函数外"的命中，注入后显示数反而变小。
      const grew = a.raw > b.raw;
      const flipped = a.status === "FAIL";
      const ok = flipped && grew;
      if (!ok) failures++;
      console.log(
        `  [${test.id}] 注入 ${test.file} → 注入前 raw=${b.raw}/${b.status}，注入后 raw=${a.raw}/${a.status}  ${
          ok ? "✓ 会红" : "✗ 注入后仍然没红（这条护栏是假的）"
        }`,
      );
      if (!ok && a.hits.length) console.log(`      首条命中: ${a.hits[0].file}:${a.hits[0].line}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log("─".repeat(78));
  // 分母从 CHECKS.length 现算：写死「6/6」在加判据那天就变成假话（这条自己踩过）。
  const total = CHECKS.length;
  console.log(
    failures === 0
      ? `selftest: ${total}/${total} 条判据注入后都会红 —— 护栏有效`
      : `selftest: ${failures} 条判据注入后没红 —— 这些护栏是假的，必须修`,
  );
  return failures;
}

// ——— main ——————————————————————————————————————————
const wantSelftest = process.argv.includes("--selftest");

// 维护用：把某个文件的「代码/注释」分类结果打出来（判断已知误判是否被触发）
const dumpAt = process.argv.indexOf("--dump");
if (dumpAt >= 0) {
  const rel = (process.argv[dumpAt + 1] ?? "").replace(/\\/g, "/");
  const loaded = loadFiles(ROOT, [rel]);
  if (!loaded.length) {
    console.error(`读不到 ${rel}`);
    process.exit(1);
  }
  loaded[0].lines.forEach((L, i) => {
    console.log(`${String(i + 1).padStart(4)} 代码|${L.code.trim()}${L.comment ? `   注释|${L.comment.trim()}` : ""}`);
  });
  process.exit(0);
}

// 维护用：打印某个函数的行范围（花括号配对的结果），排查第 2 条误判时用
const fnAt = process.argv.indexOf("--dump-fn");
if (fnAt >= 0) {
  const [rel, pat] = process.argv.slice(fnAt + 1, fnAt + 3);
  const loaded = loadFiles(ROOT, [(rel ?? "").replace(/\\/g, "/")]);
  const range = functionRange(loaded, (rel ?? "").replace(/\\/g, "/"), new RegExp(pat ?? ".", ""));
  console.log(`range=${JSON.stringify(range)}  (文件行数=${loaded[0]?.lines.length ?? 0})`);
  process.exit(0);
}

const report = runChecks(ROOT, SCAN_FILES);
const fail = printReport(report, { root: ROOT });
let exitCode = fail > 0 ? 1 : 0;
if (wantSelftest) {
  const selftestFail = selftest();
  if (selftestFail > 0) exitCode = 1;
}
process.exit(exitCode);
