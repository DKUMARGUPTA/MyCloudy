/**
 * Generate password engine (PRD §7.4 — Web Crypto) — PURE functions, no
 * DOM imports, so the whole module runs under `bun` for smoke tests.
 *
 * Randomness comes from Web Crypto (`crypto.getRandomValues`) with
 * rejection sampling, so every character is drawn uniformly from its
 * pool — no modulo bias, no Math.random anywhere.
 *
 * Three modes (registry copy: "Strong random or pronounceable passwords"):
 *  - random        : charset-driven, optionally one char per selected set
 *  - pronounceable : onset/vowel alternation (memorable, still random)
 *  - pin           : digits only
 */

export type GenMode = "random" | "pronounceable" | "pin";

export interface GenOptions {
  mode: GenMode;
  /** Character (or letter, or digit) count. Clamped per mode. */
  length: number;
  /** random: character sets. */
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** random: drop visually confusable characters (I l O o 0 1). */
  excludeAmbiguous: boolean;
  /** random: guarantee at least one char from every selected set. */
  requireEach: boolean;
  /** pronounceable: capitalize the first letter. */
  capitalize: boolean;
  /** pronounceable: append one random digit. */
  addDigit: boolean;
  /** pronounceable: append one random symbol. */
  addSymbol: boolean;
}

export const DEFAULT_GEN_OPTIONS: GenOptions = {
  mode: "random",
  length: 16,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
  requireEach: true,
  capitalize: true,
  addDigit: false,
  addSymbol: false,
};

/** Full character sets (quote/backslash/pipe kept out on purpose — passwords must survive every copy/paste and input field). */
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";

/** Visually confusable characters removed by `excludeAmbiguous`. */
const AMBIGUOUS = new Set(["I", "l", "O", "o", "0", "1"]);

/** Pronounceable pools: syllables alternate onset → vowel. */
const ONSETS = [
  "b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p",
  "r", "s", "t", "v", "w", "y", "z", "br", "cr", "dr", "fr",
  "gr", "pr", "tr", "bl", "cl", "fl", "gl", "pl", "sl", "ch",
  "sh", "th", "ph", "sc", "sk", "sm", "sn", "sp", "st", "sw",
];
const VOWELS = ["a", "e", "i", "o", "u"];

export const LENGTH_LIMITS: Record<GenMode, { min: number; max: number }> = {
  random: { min: 4, max: 128 },
  pronounceable: { min: 6, max: 64 },
  pin: { min: 3, max: 16 },
};

export function clampLength(mode: GenMode, length: number): number {
  const { min, max } = LENGTH_LIMITS[mode];
  if (!Number.isFinite(length)) return min;
  return Math.min(max, Math.max(min, Math.trunc(length)));
}

/**
 * Injectable randomness. Production uses Web Crypto; tests inject a
 * seeded LCG so every assertion below is deterministic.
 */
export interface SecureRandom {
  int(maxExclusive: number): number;
}

class CryptoRandom implements SecureRandom {
  int(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    // Rejection sampling keeps the modulo unbiased: values >= the last
    // full block are thrown away and re-drawn.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % maxExclusive;
    }
  }
}

export function cryptoRandom(): SecureRandom {
  return new CryptoRandom();
}

/** Character pools after the ambiguity filter, keyed by set. */
export function enabledPools(opts: GenOptions): string[] {
  const filter = (chars: string) =>
    opts.excludeAmbiguous
      ? [...chars].filter((c) => !AMBIGUOUS.has(c)).join("")
      : chars;
  const pools: string[] = [];
  if (opts.upper) pools.push(filter(UPPER));
  if (opts.lower) pools.push(filter(LOWER));
  if (opts.digits) pools.push(filter(DIGITS));
  if (opts.symbols) pools.push(filter(SYMBOLS));
  return pools.filter((pool) => pool.length > 0);
}

function pick(chars: string, rand: SecureRandom): string {
  return chars[rand.int(chars.length)] ?? chars[0];
}

function shuffle(chars: string[], rand: SecureRandom): void {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = rand.int(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
}

function generateRandom(opts: GenOptions, rand: SecureRandom): string {
  const pools = enabledPools(opts);
  if (pools.length === 0) return "";
  const length = clampLength("random", opts.length);
  // "One of each" needs at least one slot per selected set.
  const target = opts.requireEach ? Math.max(length, pools.length) : length;
  const all = pools.join("");
  const chars: string[] = [];
  if (opts.requireEach) {
    for (const pool of pools) chars.push(pick(pool, rand));
  }
  while (chars.length < target) chars.push(pick(all, rand));
  shuffle(chars, rand);
  return chars.join("");
}

function generatePronounceable(opts: GenOptions, rand: SecureRandom): string {
  const length = clampLength("pronounceable", opts.length);
  // Alternate onset → vowel until the letter budget is used up. A long
  // onset (2 letters) can overshoot by one — trimmed, never padded.
  let out = "";
  let useOnset = true;
  while (out.length < length) {
    const pool = useOnset ? ONSETS : VOWELS;
    out += pool[rand.int(pool.length)];
    useOnset = !useOnset;
  }
  out = out.slice(0, length);
  if (opts.addDigit) out += pick(DIGITS, rand);
  if (opts.addSymbol) out += pick(SYMBOLS, rand);
  return opts.capitalize ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

function generatePin(opts: GenOptions, rand: SecureRandom): string {
  const length = clampLength("pin", opts.length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += pick(DIGITS, rand);
  return out;
}

/** Generate one password from the options; "" means "no charset selected". */
export function generatePassword(
  opts: GenOptions,
  rand: SecureRandom = cryptoRandom()
): string {
  switch (opts.mode) {
    case "pronounceable":
      return generatePronounceable(opts, rand);
    case "pin":
      return generatePin(opts, rand);
    default:
      return generateRandom(opts, rand);
  }
}

/**
 * Honest entropy of the GENERATOR in bits (what an attacker who knows the
 * settings would have to brute-force), not the "password strength by
 * charset of the result" heuristic.
 */
export function entropyBits(opts: GenOptions): number {
  if (opts.mode === "pin") {
    return clampLength("pin", opts.length) * Math.log2(10);
  }
  if (opts.mode === "pronounceable") {
    const length = clampLength("pronounceable", opts.length);
    let bits = 0;
    let useOnset = true;
    for (let i = 0; i < length; i += 1) {
      bits += Math.log2(useOnset ? ONSETS.length : VOWELS.length);
      useOnset = !useOnset;
    }
    // Trailing extras: log2 of their first-choice positions is the honest
    // lower bound when an onset is trimmed — keep it exact for the extras.
    if (opts.addDigit) bits += Math.log2(10);
    if (opts.addSymbol) bits += Math.log2(SYMBOLS.length);
    return bits;
  }
  const pools = enabledPools(opts);
  if (pools.length === 0) return 0;
  const length = clampLength("random", opts.length);
  const target = opts.requireEach ? Math.max(length, pools.length) : length;
  const union = pools.join("").length;
  // Free choice from the union for every slot, minus the "forced one of
  // each" correction: each forced slot only carries its own pool's size.
  let bits = target * Math.log2(union);
  if (opts.requireEach) {
    for (const pool of pools) bits += Math.log2(pool.length / union);
  }
  return bits;
}

/**
 * Offline crack-time estimate in SECONDS — half the keyspace at a fast
 * rig rate of 100 billion guesses per second (bcrypt-less attacker).
 */
export const CRACK_GUESSES_PER_SECOND = 1e11;
export function crackSeconds(bits: number): number {
  return Math.pow(2, Math.max(0, bits) - 1) / CRACK_GUESSES_PER_SECOND;
}

/** Strength tiers drive the 4-segment meter + label. */
export type StrengthTier = "weak" | "fair" | "strong" | "excellent";

export function strengthTier(bits: number): StrengthTier {
  if (bits < 40) return "weak";
  if (bits < 60) return "fair";
  if (bits < 80) return "strong";
  return "excellent";
}

/** Segment count for the meter (1-4). */
export function tierSegments(tier: StrengthTier): number {
  return { weak: 1, fair: 2, strong: 3, excellent: 4 }[tier];
}
