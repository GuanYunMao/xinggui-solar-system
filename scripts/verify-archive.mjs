// verify 运行归档：把每次 `npm run verify` 的整份 results + 环境指纹落盘，让失败证据活过终端。
//
// 为什么要它：`sun-occlusion` 的 centerBoxLum / aligned 只活在一条消息里——全仓 `*.json` 搜它 0 命中，
// 于是「这条判据从哪一版开始不对外」回答不了，只能靠记性。归档之后，这个问题 = 一条 Select-String。
//
// 设计上的三条硬约束（都是这轮踩出来的）：
//   1. **归档失败绝不能让 verify 变红。** 测量工具不该吃被测结果的账，所以调用方用 try/catch 包住。
//   2. **索引字段固定。** index.jsonl 每行一条摘要，字段名不许随手改——它就是"用 Select-String 查历史"的接口。
//   3. **保留策略写死并自动清旧。** 不写保留策略，一年之后就是几百 MB 垃圾。
//
// 用法：
//   node scripts/verify-archive.mjs --list        # 看历史索引
//   node scripts/verify-archive.mjs --selftest    # 离线自测（不开浏览器）
//   （verify.mjs 内部调用 archiveVerifyRun()）
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
export const DEFAULT_DIR = path.join(ROOT, "runs");
export const INDEX_NAME = "index.jsonl";
/** 保留策略：最近 40 次 / 最近 30 天，先到先清。写死在这里，不做成环境变量（可调 = 会长成没人记得的旋钮）。 */
export const KEEP_RUNS = 40;
export const KEEP_DAYS = 30;

/** 索引行的字段是**固定契约**：加字段可以，改名/删字段会悄悄废掉所有历史查询。 */
export const INDEX_FIELDS = [
  "at",
  "build",
  "raster",
  "passes",
  "failures",
  "failureNames",
  "knownBugs",
  "viewports",
  "file",
];

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

/**
 * 写一份归档。**不吞异常**：调用方（verify.mjs）负责 try/catch，这样"归档坏了"和"判据红了"
 * 在日志里永远是两件事，不会混成一条。
 */
export function archiveVerifyRun({ results, failures, meta = {}, dir = process.env.XG_ARCHIVE_DIR || DEFAULT_DIR }) {
  if (!Array.isArray(results)) throw new Error("results 必须是数组（归档入参错误）");
  mkdirSync(dir, { recursive: true });
  const at = meta.at ?? new Date().toISOString();
  const build = meta.build ?? "unknown";
  const raster = meta.raster ?? "unknown";
  const passes = results.length;
  const failureNames = failures.map((f) => String(f).split(":")[0].trim());
  // 哪些 pass 这轮「没对齐 / 没准备好」：sun-occlusion 这类对齐失败按设计不判红，
  // 但**连续多次未对齐**就说明判据已经失去判断力——所以把状态记进索引，下一次运行才能数连续次数。
  const unaligned = results.filter((r) => r && r.aligned === false).map((r) => r.pass);
  const knownBugs = results
    .map((r) => r?.knownBug)
    .filter(Boolean)
    .map((k) => `${k.knownBug}@${k.minBody ?? "?"}:${k.minDist ?? "?"}`);
  const viewports = [
    ...new Set(
      results
        .map((r) => (r?.url ? "?" : null))
        .filter(Boolean),
    ),
  ];

  const name = `${stamp(new Date(at))}__${String(build).replace(/[^\w.-]/g, "_")}__${raster}.json`;
  const file = path.join(dir, name);
  if (existsSync(file)) throw new Error(`归档文件已存在，拒绝覆盖：${name}`); // 同一次运行不许互相盖掉

  writeFileSync(
    file,
    JSON.stringify({ meta: { ...meta, at, build, raster }, results, failures }, null, 2),
    "utf8",
  );

  const entry = { at, build, raster, passes, failures: failures.length, failureNames, knownBugs, viewports, unaligned, file: name };
  appendFileSync(path.join(dir, INDEX_NAME), JSON.stringify(entry) + "\n", "utf8");

  const pruned = pruneRuns(dir);
  return { file, index: path.join(dir, INDEX_NAME), entry, pruned };
}

/** 清旧：按 mtime 先删超龄的，再按数量保留最新的 KEEP_RUNS 份。返回被删的文件名。 */
export function pruneRuns(dir = DEFAULT_DIR, { keepRuns = KEEP_RUNS, keepDays = KEEP_DAYS, now = Date.now() } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== INDEX_NAME)
    .map((f) => ({ f, mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  const cutoff = now - keepDays * 86400_000;
  for (let i = 0; i < files.length; i++) {
    const { f, mtime } = files[i];
    if (i >= keepRuns || mtime < cutoff) {
      rmSync(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}

/** 归档为什么必须存在：把索引读回来，问「某条判据从哪一版开始红」。 */
export function readIndex(dir = process.env.XG_ARCHIVE_DIR || DEFAULT_DIR) {
  const p = path.join(dir, INDEX_NAME);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ——— CLI ————————————————————————————————————————————————
const argv = process.argv.slice(2);

if (argv.includes("--list")) {
  const rows = readIndex();
  if (!rows.length) console.log("（还没有归档记录）");
  for (const r of rows) {
    console.log(`${r.at}  ${r.build}  ${r.raster}  ${r.passes} pass / ${r.failures} 失败  ${r.failureNames.join(",") || "-"}`);
  }
  process.exit(0);
}

if (argv.includes("--selftest")) {
  /*
   * 离线自测。规矩照这轮定的：**自证必须自己被证明会响**。
   * 所以除了"写成功了"，还要断言"该抛的时候真的抛"——只测成功路径的护栏等于没有护栏。
   */
  const dir = mkdtempSync(path.join(os.tmpdir(), "verify-archive-"));
  const fail = [];
  const ok = (cond, msg) => (cond ? console.log(`  ✓ ${msg}`) : (fail.push(msg), console.log(`  ✗ ${msg}`)));

  try {
    // at 要逐次给不同值：文件名由「时刻 + build + raster」组成，两次同 at 会命中覆盖保护（实测撞过）
    const synthetic = (marker, at) => ({
      results: [
        { pass: "desktop" },
        { pass: "sun-occlusion", knownBug: { knownBug: "transition-penetration", minBody: "earth", minDist: 0.66 } },
      ],
      failures: marker ? [`sun-occlusion: 对齐失败 deltaPx ${marker}`] : [],
      meta: { build: "index-TEST.js", raster: "software", at, marker },
    });

    const a = archiveVerifyRun({ ...synthetic("", "2026-10-24T00:00:00.000Z"), dir });
    ok(existsSync(a.file), "第一次归档：文件落地");
    const idx1 = readIndex(dir);
    ok(idx1.length === 1, "第一次归档：index 多了一行");
    ok(INDEX_FIELDS.every((k) => k in idx1[0]), "index 行字段齐全（固定契约）");
    ok(idx1[0].knownBugs.length === 1, "index 摘要里带上 knownBug（sun-occlusion 那类才不会丢）");

    const b = archiveVerifyRun({ ...synthetic("44.6", "2026-10-24T00:01:00.000Z"), dir });
    ok(existsSync(a.file) && existsSync(b.file), "连跑两次：两份都在，旧的不被覆盖");
    ok(readIndex(dir).length === 2, "连跑两次：index 两行");
    ok(readIndex(dir)[1].failureNames[0] === "sun-occlusion", "index 记录了失败判据名（可按前缀 Select-String）");

    // 覆盖保护：同一时刻重复归档必须抛，不许悄悄盖掉上一次的证据
    let dupThrew = false;
    try {
      archiveVerifyRun({ ...synthetic("", "2026-10-24T00:00:00.000Z"), dir });
    } catch {
      dupThrew = true;
    }
    ok(dupThrew, "同一时刻重复归档会抛（拒绝覆盖上一次的证据）");
    ok(readIndex(dir).length === 2, "被拒绝的那次没有污染 index");

    // 保留策略：造一份 400 天前的假文件，prune 必须把它清掉
    const old = path.join(dir, "1999-01-01-00-00-00-000Z__index-OLD.js__software.json");
    writeFileSync(old, "{}", "utf8");
    const oldMs = Date.now() / 1000 - 400 * 86400;
    utimesSync(old, oldMs, oldMs);
    const removed = pruneRuns(dir);
    ok(removed.includes(path.basename(old)), "保留策略：超龄文件被清掉");
    ok(readIndex(dir).length === 2, "保留策略：只清 run 文件，index 不动（历史不能丢）");

    // 该抛的时候必须抛：dir 指向一个文件而不是目录
    const notADir = path.join(dir, "not-a-dir");
    writeFileSync(notADir, "x", "utf8");
    let loud = false;
    try {
      archiveVerifyRun({ ...synthetic(""), dir: notADir });
    } catch {
      loud = true;
    }
    ok(loud, "写不进去时会抛（不静默吞掉——否则归档坏了没人知道）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(fail.length ? `\nselftest: ${fail.length} 项没通过 —— 归档器自己不可信` : "\nselftest: 归档器自测全绿");
  process.exit(fail.length ? 1 : 0);
}

// 直接运行且没给子命令：什么都不做，别误写
if (argv.length === 0) {
  console.log("verify-archive：由 verify.mjs 调用；单独用请看 --list / --selftest");
}
