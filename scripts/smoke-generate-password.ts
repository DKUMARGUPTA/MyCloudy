/**
 * Generate password — PURE ENGINE smoke.
 *
 * Deterministic RandomSource (a simple xorshift32 stream) drives every
 * check, so failures are reproducible. Verifies:
 *   - word list: exactly 1024 unique words, 3-7 letters
 *   - randomInt: bounds + no modulo bias on a skewed alphabet (chi-square)
 *   - generateRandom: length, class membership, class guarantees,
 *     avoid-ambiguous filtering, all-classes-off defensive fallback
 *   - generatePin: digits only, length clamping
 *   - generatePassphrase: word count, separator, capitalization, digit
 *     insertion, every word from the list
 *   - entropyBits: known values (log2 math), strengthLevel thresholds,
 *     crackSeconds/crackUnit monotonicity
 *
 * Run: bun scripts/smoke-generate-password.ts
 */
import {
  AMBIGUOUS,
  DIGITS,
  LOWER,
  PIN_LENGTH_MAX,
  PIN_LENGTH_MIN,
  RANDOM_LENGTH_MAX,
  RANDOM_LENGTH_MIN,
  SYMBOLS,
  UPPER,
  WORD_LIST,
  WORD_ENTROPY_BITS,
  crackSeconds,
  crackUnit,
  entropyBits,
  generatePassphrase,
  generatePin,
  generateRandom,
  randomAlphabet,
  randomInt,
  shuffleInPlace,
  strengthLevel,
  type RandomSource,
} from "../tools/generate-password/engine";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Deterministic xorshift32 — reproducible "randomness" for the smoke. */
function makeRng(seed: number): RandomSource {
  let state = seed >>> 0 || 0x9e3779b9;
  return (byteCount: number): Uint8Array => {
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

const rng = makeRng(0x12345678);

function isSubsetOf(chars: string, alphabet: string): boolean {
  for (const ch of chars) if (!alphabet.includes(ch)) return false;
  return true;
}

/* ---------------- word list ---------------- */
console.log("word list:");
check("exactly 1024 words", WORD_LIST.length === 1024, String(WORD_LIST.length));
check("all unique", new Set(WORD_LIST).size === WORD_LIST.length);
check(
  "3-7 letters only",
  WORD_LIST.every((w) => /^[a-z]{3,7}$/.test(w))
);
check("word entropy constant is 10", WORD_ENTROPY_BITS === 10);

/* ---------------- randomInt ---------------- */
console.log("\nrandomInt:");
let inBounds = true;
for (let i = 0; i < 5000; i += 1) {
  const n = randomInt(97, rng);
  if (!Number.isInteger(n) || n < 0 || n >= 97) {
    inBounds = false;
    break;
  }
}
check("5000 draws stay within [0, 97)", inBounds);
check("max=1 always 0", randomInt(1, rng) === 0 && randomInt(1, rng) === 0);

// Modulo-bias probe: alphabet size 251 (prime, near a power boundary region
// that naive % would skew). 251*15 = 3765 < 256*... — rejection zone ~4.4%.
const counts = new Array<number>(251).fill(0);
for (let i = 0; i < 251 * 2000; i += 1) counts[randomInt(251, rng)] += 1;
const expected = 2000;
let chiSquare = 0;
for (const count of counts) {
  chiSquare += (count - expected) ** 2 / expected;
}
const degreesOfFreedom = 250;
check(
  "chi-square uniformity on 251 buckets (p > 0.001)",
  // Critical chi2 at p=0.001 for df=250 is ~323. Way below that = uniform.
  chiSquare < 323 && chiSquare > 150,
  `chi2=${chiSquare.toFixed(1)} (df=${degreesOfFreedom})`
);

// shuffle is a permutation
const before = [1, 2, 3, 4, 5, 6, 7, 8];
const shuffled = shuffleInPlace([...before], rng);
check(
  "shuffleInPlace keeps the multiset",
  shuffled.slice().sort((a, b) => a - b).join(",") === before.join(",")
);

/* ---------------- generateRandom ---------------- */
console.log("\ngenerateRandom:");
const allOn = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};
const pwd = generateRandom(allOn, rng);
check("length 20 as requested", pwd.length === 20, pwd);
check(
  "contains lower + upper + digit + symbol",
  /[a-z]/.test(pwd) && /[A-Z]/.test(pwd) && /[0-9]/.test(pwd) &&
    new RegExp(`[${SYMBOLS.replace(/[-^]/g, "\\$&")}]`).test(pwd)
);
const fullAlphabet = LOWER + UPPER + DIGITS + SYMBOLS;
check("every char is from the selected classes", isSubsetOf(pwd, fullAlphabet));

const ambiguousOff = generateRandom(
  { ...allOn, length: 64, avoidAmbiguous: true },
  rng
);
check("length 64 respected", ambiguousOff.length === 64);
check(
  "no ambiguous chars when requested",
  ![...ambiguousOff].some((ch) => AMBIGUOUS.has(ch)),
  ambiguousOff.slice(0, 24) + "…"
);

const digitsOnly = generateRandom(
  { ...allOn, length: 12, lower: false, upper: false, symbols: false },
  rng
);
check(
  "digits-only recipe yields only digits",
  /^[0-9]{12}$/.test(digitsOnly),
  digitsOnly
);
check(
  "digits-only recipe guarantees a digit",
  digitsOnly.length === 12 && isSubsetOf(digitsOnly, DIGITS)
);

// Class guarantee: 200 runs, every selected class must appear every time.
let guaranteeOk = true;
for (let i = 0; i < 200; i += 1) {
  const sample = generateRandom(
    { ...allOn, length: 8, avoidAmbiguous: true },
    rng
  );
  if (
    !/[a-z]/.test(sample) ||
    !/[A-Z]/.test(sample) ||
    !/[0-9]/.test(sample) ||
    !new RegExp(`[${SYMBOLS.replace(/[-^]/g, "\\$&")}]`).test(sample)
  ) {
    guaranteeOk = false;
    break;
  }
}
check("class guarantee holds across 200 short samples", guaranteeOk);

// Clamping: absurd lengths fall into range.
const tooShort = generateRandom({ ...allOn, length: 2 }, rng);
const tooLong = generateRandom({ ...allOn, length: 9999 }, rng);
check(
  "length clamped to [6, 64]",
  tooShort.length === RANDOM_LENGTH_MIN &&
    tooLong.length === RANDOM_LENGTH_MAX
);

// Defensive fallback: everything off still yields lowercase.
const noneOn = generateRandom(
  { ...allOn, length: 16, lower: false, upper: false, digits: false, symbols: false },
  rng
);
check(
  "all classes off falls back to lowercase",
  /^[a-z]{16}$/.test(noneOn)
);

// Distribution sanity: with digits-only, long run, all 10 digits appear.
const longDigits = generateRandom(
  { ...allOn, length: 64, lower: false, upper: false, symbols: false },
  rng
);
check(
  "all 10 digits appear in a 64-char digit run",
  new Set(longDigits).size === 10
);

// alphabet helper mirrors the class flags
check(
  "randomAlphabet composition matches flags",
  randomAlphabet(allOn) === fullAlphabet &&
    randomAlphabet({ ...allOn, upper: false, symbols: false }) ===
      LOWER + DIGITS
);

/* ---------------- PIN ---------------- */
console.log("\ngeneratePin:");
const pin = generatePin(6, rng);
check("6-digit PIN", /^[0-9]{6}$/.test(pin), pin);
check(
  "PIN clamped to [3, 12]",
  generatePin(1, rng).length === PIN_LENGTH_MIN &&
    generatePin(99, rng).length === PIN_LENGTH_MAX
);
let leadingZeroSeen = false;
for (let i = 0; i < 500; i += 1) {
  if (generatePin(6, rng)[0] === "0") {
    leadingZeroSeen = true;
    break;
  }
}
check("leading zeros are allowed (real PIN semantics)", leadingZeroSeen);

/* ---------------- passphrase ---------------- */
console.log("\ngeneratePassphrase:");
const phrase = generatePassphrase(
  {
    words: 5,
    separator: "dash",
    capitalize: true,
    includeNumber: true,
  },
  rng
);
const phraseParts = phrase.split("-");
check("5 words + 1 digit = 6 tokens", phraseParts.length === 6, phrase);
check(
  "capitalized words from the list",
  phraseParts.filter((p) => /[A-Z]/.test(p)).length >= 5
);
const lowercased = phraseParts
  .filter((p) => !/^[0-9]$/.test(p))
  .map((p) => p.toLowerCase());
check(
  "every word belongs to WORD_LIST",
  lowercased.every((w) => WORD_LIST.includes(w)),
  lowercased.join(" ")
);
check("exactly one single digit token",
  lowercased.length === 5 &&
    phraseParts.filter((p) => /^[0-9]$/.test(p)).length === 1
);

const spaced = generatePassphrase(
  { words: 4, separator: "space", capitalize: false, includeNumber: false },
  rng
);
const spacedParts = spaced.split(" ");
check("space separator + no caps + no number", spacedParts.length === 4, spaced);
check(
  "uncapitalized words",
  spacedParts.every((p) => p === p.toLowerCase() && /[a-z]/.test(p))
);

const glued = generatePassphrase(
  { words: 3, separator: "none", capitalize: false, includeNumber: false },
  rng
);
check("none separator produces a single glued token", /^[a-z]+$/.test(glued), glued);
check(
  "glued token is 3 concatenated list words",
  (() => {
    const set = new Set(WORD_LIST);
    // greedy prefix scan
    let rest = glued;
    let count = 0;
    while (rest.length > 0) {
      let matched = "";
      for (let len = 7; len >= 3; len -= 1) {
        const head = rest.slice(0, len);
        if (head.length === len && set.has(head)) {
          matched = head;
          break;
        }
      }
      if (!matched) return false;
      rest = rest.slice(matched.length);
      count += 1;
    }
    return count === 3;
  })()
);

const dotted = generatePassphrase(
  { words: 8, separator: "dot", capitalize: false, includeNumber: false },
  rng
);
check("8 words (max) with dots", dotted.split(".").length === 8);
check(
  "words clamped to [3, 8]",
  generatePassphrase(
    { words: 1, separator: "dash", capitalize: false, includeNumber: false },
    rng
  ).split("-").length === 3
);

/* ---------------- entropy + strength + crack ---------------- */
console.log("\nentropy / strength / crack time:");
// 16 chars over the full 26+26+10+13 = 75-char alphabet ≈ 99 bits
const fullBits = entropyBits("random", allOn);
check(
  "random entropy = length × log2(75) rounded",
  fullBits === Math.round(20 * Math.log2(75)),
  `${fullBits} bits`
);
// digits-only recipe
const digitBits = entropyBits("random", {
  ...allOn,
  lower: false,
  upper: false,
  symbols: false,
});
check("digits-only entropy = length × log2(10)", digitBits === Math.round(20 * Math.log2(10)));
// pin
check("pin entropy 6 = 20 bits (rounded)", entropyBits("pin", { length: 6 }) === 20);
// passphrase 4 words, no number: 40
check(
  "passphrase 4 words = 40 bits",
  entropyBits("passphrase", {
    words: 4,
    separator: "dash",
    capitalize: true,
    includeNumber: false,
  }) === 40
);
// with number: 40 + log2(10*5) = 40 + 6 = 46
const withNumber = entropyBits("passphrase", {
  words: 4,
  separator: "dash",
  capitalize: true,
  includeNumber: true,
});
check(
  "passphrase + digit adds log2(10×(words+1))",
  withNumber === 40 + Math.round(Math.log2(10 * 5)),
  `${withNumber} bits`
);

check(
  "strength thresholds 27/35/59/79",
  strengthLevel(27) === 0 &&
    strengthLevel(28) === 1 &&
    strengthLevel(35) === 1 &&
    strengthLevel(36) === 2 &&
    strengthLevel(59) === 2 &&
    strengthLevel(60) === 3 &&
    strengthLevel(79) === 3 &&
    strengthLevel(80) === 4
);

// crack time: 1e10/s, average = half the keyspace
check(
  "crackSeconds(40) ≈ 2^39/1e10",
  Math.abs(crackSeconds(40) - Math.pow(2, 39) / 1e10) < 1e-4
);
const u1 = crackUnit(crackSeconds(40));
check("40 bits is under a minute at 1e10/s (honest warning)", u1.key === "pw.unitSeconds", u1.key);
check("50 bits lands on hours", crackUnit(crackSeconds(50)).key === "pw.unitHours");
check("53 bits lands on days", crackUnit(crackSeconds(53)).key === "pw.unitDays");
const u2 = crackUnit(crackSeconds(20));
check("20 bits lands on seconds/minutes", u2.key === "pw.unitSeconds" || u2.key === "pw.unitMinutes", u2.key);
const u3 = crackUnit(crackSeconds(100));
check(
  "100 bits is at least billions of years",
  ["pw.unitBillionYears", "pw.unitTrillionYears", "pw.unitEternity"].includes(u3.key),
  u3.key
);
// monotonic: more bits never means less time
let monotonic = true;
let prev = 0;
for (let bits = 8; bits <= 128; bits += 4) {
  const seconds = crackSeconds(bits);
  if (seconds < prev) monotonic = false;
  prev = seconds;
}
check("crackSeconds monotonic in bits", monotonic);
// eternity cap for astronomic values
check(
  "512 bits → eternity unit",
  crackUnit(crackSeconds(512)).key === "pw.unitEternity"
);

console.log(
  `\n${passed} passed, ${failed} failed${failed === 0 ? " — ALL PASS" : ""}`
);
if (failed > 0) process.exit(1);
