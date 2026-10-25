/**
 * 解锁门（彩蛋）的槽位表、短码编解码、持久化。
 *
 * 三条铁律（t2 / t8 定的，动之前先读）：
 *  1. **判定当场算**：`isUnlocked()` 只看内存里的 lit / unlocked，永远不读 localStorage。
 *  2. **持久化只做记忆**：读写失败（file:// / 隐私模式 / 配额满）只丢「下次记得」，
 *     不丢「这次能进」。progress.ts 已经吞掉异常，这里不能再依赖它。
 *  3. **短码不防伪也不需要防**：它不是权限，是把「我摸过这几个控件」搬个家。
 *     能开控制台的人直接改 localStorage 就行，短码只给不会开控制台的人一条正路。
 *
 * 短码布局（24 bit 载荷 + 8 bit 校验，Crockford Base32，无 I / L / O / U）：
 *
 *   bit   0–2   槽位点亮位（3 个，顺序 = GATE_SLOTS 的顺序）
 *   bit   3–12  保留，必须为 0（1.3.4 之前这里装着 12 槽位的其余 9 个）
 *   bit  13–16  schema 版本号（当前 2）
 *   bit  17–23  保留，必须为 0
 *
 *   XG1-ABCDE-FG
 *   └┬┘ └─┬─┘ └┬┘
 *    │    │    └── 校验：CRC-8(poly 0x07, init 0x00) 覆盖 3 个载荷字节，
 *    │    │           低 5 bit 一字符 + 高 3 bit 一字符 = 完整 8 bit
 *    │    └────── 载荷 5 字符 = 25 bit，只取低 24 bit（最高位必须为 0）
 *    └────────── 前缀 + 版本字面量（解析时也按字符处理，所以跟着一起规范化）
 */

/**
 * 槽位表 = **store 里真有 hitGate 调用的那几个**（1.3.4 从 12 收到 3）。
 *
 * 旧表 12 个槽位里，"scale / orbit / clock / signal / eclipse / drift / echo / void / trail"
 * 这 9 个没有任何写入点 —— 它们在界面上是 12 个点里永远不亮的 9 个，玩家把能做的都做了
 * 也只到 3/3，剩下的只能靠猜或者开控制台。槽位表是**可达性**的声明，不是愿望清单。
 *
 * 加槽位的规矩：先在 store 里写出一个能失败的判定（命中者不是"点了就给"），
 * 再加进来。scripts/gate-predicate.test.mjs 会数 store.ts 里的 `hitGate("…")` 调用，
 * 表里多一个没有调用点的槽位，断言直接红。
 */
export const GATE_SLOTS = ["time", "target", "layer"] as const;

export type GateSlot = (typeof GATE_SLOTS)[number];

/** 亮满几个点算解锁。改这个数等于改游戏规则，要同步 CHANGELOG。 */
export const GATE_REQUIRED = 3;

/**
 * 短码的 schema 版本（1.3.4 起 = 2）。
 *
 * 为什么升版而不是"尽量把老码解出来"：槽位表从 12 收到 3，老码的 bit 3–11 里每一位
 * 都**曾经**是一个有名字的槽位，现在没有对应物。硬解它就只剩两条路——
 *  ① 悄悄把那几位丢掉：一个写着「3 格已归档」的老码进来，面板显示 1/3，没人知道为什么；
 *  ② 把 bit 12 的"已解锁"位重新读回来：t20 已经判过死刑（冗余位能造出自我矛盾的态）。
 * 两条都会让"一个事实一个来源"破掉。所以老码一律 `version` 失败，界面会明说
 * 「这个码来自别的版本。」——这是能听懂的真话，不是"码无效"。
 *
 * 老玩家的进度不受影响：本机存档（GATE_KEY）里的 `unlockedAt` 仍然作数，
 * 见 `readGate` / store 的 `hydrateGate` —— 铁律 2、铁律 1 都没动。
 */
export const GATE_VERSION = 2;

/**
 * localStorage 的键名里那个 `v1` 是**历史**，不是 schema 版本 —— 别跟着 GATE_VERSION 改。
 * 改键名 = 读不到老存档 = 把已解锁的人打回锁态，而铁律 1/2 都不允许"记忆丢了"升级成"这次进不去"。
 */
export const GATE_KEY = "xinggui-gate-v1";

const PREFIX = "XG1";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAYLOAD_CHARS = 5;
const CHECK_CHARS = 2;
const BODY_LENGTH = PREFIX.length + PAYLOAD_CHARS + CHECK_CHARS;

export function isGateSlot(value: unknown): value is GateSlot {
  return typeof value === "string" && (GATE_SLOTS as readonly string[]).includes(value);
}

/** 按槽位表顺序排好 + 去重：保证同一份进度永远生成同一个码。 */
export function canonicalSlots(slots: readonly string[]): GateSlot[] {
  const set = new Set(slots.filter(isGateSlot));
  return GATE_SLOTS.filter((slot) => set.has(slot));
}

export function isUnlocked(state: { gateLit: readonly string[]; gateUnlocked: boolean }): boolean {
  return state.gateUnlocked || state.gateLit.length >= GATE_REQUIRED;
}

/** CRC-8/ATM：poly 0x07，init 0x00，不反射、不 xorout。 */
export function crc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function encodeChars(value: number, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += ALPHABET[(value >>> (i * 5)) & 31];
  return out;
}

function decodeChars(chars: string): number {
  let value = 0;
  for (let i = 0; i < chars.length; i++) {
    value += ALPHABET.indexOf(chars[i]!) * 2 ** (i * 5);
  }
  return value;
}

/**
 * 规范化：大写 → 剥掉所有非字母数字（连字符、空格、全角破折号都剥）
 * → Crockford 的宽容映射 I/L→1、O→0、U→V。
 * 手抄短码的人会在这些地方出错，与其报错不如认。
 */
export function normalizeGate(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

/**
 * 编码。
 *
 * **bit 12 不再写**（t20）：它是「已解锁」的冗余位，而冗余位能造出自我矛盾的态 ——
 * `XG1-00C00-S7` = 0 个槽位 + 已解锁，导入后界面同时说「0/3」和「校准已完成」，
 * 点复制又把这个矛盾导出一遍（自传播）。
 * 解锁与否现在只由**槽位数**决定（`slots.length >= GATE_REQUIRED`），一个事实一个来源。
 * `unlocked` 参数保留是为了不改调用方签名，但它已经不影响输出。
 *
 * 1.3.4 又补一条：**bit 3–12 与 17–23 一个都不写**（只写 0–2 的槽位位和 13–16 的版本）。
 * 编码出的码解回来必须是最小读数，再导出还是同一个码 —— 否则"同一份进度两个码"，
 * 玩家抄哪个都像对的。
 */
export function encodeGate(lit: readonly string[], _unlocked: boolean, version = GATE_VERSION): string {
  let payload = 0;
  GATE_SLOTS.forEach((slot, index) => {
    if (lit.includes(slot)) payload |= 1 << index;
  });
  payload |= (version & 0xf) << 13;

  const bytes = [payload & 0xff, (payload >>> 8) & 0xff, (payload >>> 16) & 0xff];
  const check = crc8(bytes);
  return `${PREFIX}-${encodeChars(payload, PAYLOAD_CHARS)}-${ALPHABET[check & 31]}${ALPHABET[(check >>> 5) & 7]}`;
}

export type DecodeGateResult =
  | { ok: true; slots: GateSlot[]; unlocked: boolean }
  | { ok: false; reason: GateFailureReason };

export type GateFailureReason = "empty" | "length" | "prefix" | "alphabet" | "range" | "version" | "checksum";

/** 失败分支单独成型：store 的成功返回值带 `added`，不能和 decode 的成功分支混在一个联合里。 */
export type GateFailure = { ok: false; reason: GateFailureReason };

export function decodeGate(raw: string): DecodeGateResult {
  const normalized = normalizeGate(raw ?? "");
  if (!normalized) return { ok: false, reason: "empty" };
  if (normalized.length !== BODY_LENGTH) return { ok: false, reason: "length" };
  if (!normalized.startsWith(PREFIX)) return { ok: false, reason: "prefix" };
  for (const char of normalized) {
    if (!ALPHABET.includes(char)) return { ok: false, reason: "alphabet" };
  }

  const payload = decodeChars(normalized.slice(PREFIX.length, PREFIX.length + PAYLOAD_CHARS));
  // 5 个字符装得下 25 bit，载荷只认 24 bit：最高位被占用 = 这个码不是我们发的
  if (payload >= 2 ** 24) return { ok: false, reason: "range" };

  const version = (payload >>> 13) & 0xf;
  if (version !== GATE_VERSION) return { ok: false, reason: "version" };

  const checkChars = normalized.slice(PREFIX.length + PAYLOAD_CHARS);
  const low = ALPHABET.indexOf(checkChars[0]!);
  const high = ALPHABET.indexOf(checkChars[1]!);
  if (high > 7) return { ok: false, reason: "checksum" };
  const expected = crc8([payload & 0xff, (payload >>> 8) & 0xff, (payload >>> 16) & 0xff]);
  if (low + (high << 5) !== expected) return { ok: false, reason: "checksum" };

  /*
   * 保留位必须为 0（1.3.4）：槽位收到 3 个之后，bit 3–12（老槽位的残位 + t20 废止的解锁位）
   * 和 bit 17–23 都没有含义了。这里**拒收**而不是忽略。
   *
   * 为什么这次不学 t20 的"忽略"：t20 忽略 bit 12 是有前提的 —— 那时只有那一位会带脏，
   * 忽略它才能让「亮满 3 格」成为唯一事实来源。现在整个高位区间都不再有含义，
   * 忽略等于认下任意垃圾位：同一份进度会解出跟原码不同的新码（导出就变了个样）。
   *
   * 顺序放在校验之后：位翻转应该报 checksum，不该报 range —— 报错要指向真正的毛病。
   */
  const reserved = ((payload >>> 3) & 0x3ff) | (payload >>> 17);
  if (reserved !== 0) return { ok: false, reason: "range" };

  const slots = GATE_SLOTS.filter((_, index) => (payload & (1 << index)) !== 0);
  return { ok: true, slots: [...slots], unlocked: slots.length >= GATE_REQUIRED };
}

/**
 * 本机存档（`xinggui-gate-v1`）。**和短码是两个东西**：这里不校验、不防伪、不做版本拒绝，
 * 只做「下次记得」。所以老存档里那些已经不存在的槽位名（`eclipse` 等）会被
 * `canonicalSlots` 丢掉，而 `unlockedAt` 原样保留 —— 已解锁的人不会因为槽位表缩了就被打回锁态。
 */
export type GateRecord = {
  v: 1;
  lit: string[];
  unlockedAt?: number;
  seen?: number;
};

/** 读失败一律当「没有存档」。调用方必须能空手跑完整流程。 */
export function readGate(): GateRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GateRecord>;
    return {
      v: 1,
      lit: canonicalSlots(Array.isArray(parsed.lit) ? parsed.lit : []),
      unlockedAt: typeof parsed.unlockedAt === "number" ? parsed.unlockedAt : undefined,
      seen: typeof parsed.seen === "number" ? parsed.seen : undefined,
    };
  } catch {
    return null;
  }
}

/** 写失败返回 false：界面可以据此说「这次能进，下次未必记得住」，但不拦人。 */
export function writeGate(record: GateRecord): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(GATE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
