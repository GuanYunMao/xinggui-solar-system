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
 *   bit   0–11  槽位点亮位（12 个，与面板上一圈 12 格一一对应）
 *   bit      12  已解锁位（和「亮满 3 个」是冗余信息，但它让「只亮了 2 个」也能带走）
 *   bit  13–16  schema 版本号（当前 1）
 *   bit  17–23  保留，必须为 0
 *
 *   XG1-ABCDE-FG
 *   └┬┘ └─┬─┘ └┬┘
 *    │    │    └── 校验：CRC-8(poly 0x07, init 0x00) 覆盖 3 个载荷字节，
 *    │    │           低 5 bit 一字符 + 高 3 bit 一字符 = 完整 8 bit
 *    │    └────── 载荷 5 字符 = 25 bit，只取低 24 bit（最高位必须为 0）
 *    └────────── 前缀 + 版本字面量（解析时也按字符处理，所以跟着一起规范化）
 */

export const GATE_SLOTS = [
  "time",
  "target",
  "layer",
  "scale",
  "orbit",
  "clock",
  "signal",
  "eclipse",
  "drift",
  "echo",
  "void",
  "trail",
] as const;

export type GateSlot = (typeof GATE_SLOTS)[number];

/** 亮满几个点算解锁。改这个数等于改游戏规则，要同步 CHANGELOG。 */
export const GATE_REQUIRED = 3;

export const GATE_VERSION = 1;

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

  const slots = GATE_SLOTS.filter((_, index) => (payload & (1 << index)) !== 0);
  /*
   * bit 12 一概不读（t20）。老版本发出的码里可能带着它，这里**忽略**而不是报错：
   * 解码的结论必须和 UI 的判定同源 —— 都是「亮了几格 >= GATE_REQUIRED」。
   * 于是 `XG1-00C00-S7` 这种「0 槽位 + 已解锁」的旧码，进来就是 0/3，
   * 不会再让面板一边说 0/3、一边说「校准已完成」。
   */
  return { ok: true, slots: [...slots], unlocked: slots.length >= GATE_REQUIRED };
}

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
