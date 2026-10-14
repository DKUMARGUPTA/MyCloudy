/**
 * Generate Password — smoke for the CURRENT engine API (PRD §8.4).
 *
 * Pure-engine checks, no React/DOM — Bun runs crypto.getRandomValues fine:
 *   - randomInt: bounds, rejection of junk args
 *   - randomPool: charset assembly + ambiguity strip
 *   - generateRandom: length clamp, one-char-per-set guarantee, pool
 *     membership, entropy formula, avoidAmbiguous purity
 *   - generatePronounceable: length clamp, alphabet membership
 *   - generatePassphrase: word counts, separators, capitalize, addNumber,
 *     wordlist membership (en/hi/both), entropy math
 *   - strength/crack helpers: band boundaries + bucket monotonicity
 *   - passwordStats: class census + word count
 *
 * Run: bun scripts/smoke-gpw.ts
 */
import {
  AMBIGUOUS_CHARS,
  SET_DIGITS,
  SET_SYMBOLS,
  WORDS_EN,
  WORDS_HI,
  classifyStrength,
  crackBucket,
  crackCount,
  crackSeconds,
  generatePassphrase,
  generatePronounceable,
  generateRandom,
  passwordStats,
  randomInt,
  randomOptsValid,
  randomPool,
  wordlist,
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

/* ---------------- randomInt ---------------- */
console.log("randomInt:");
let boundsOk = true;
for (let i = 0; i < 2000; i += 1) {
  const v = randomInt(7);
  if (!Number.isInteger(v) || v < 0 || v >= 7) boundsOk = false;
}
check("2000 draws stay in [0, 7)", boundsOk);
check("max 1 is always 0", randomInt(1) === 0);
let threw = false;
try {
  randomInt(0);
} catch {
  threw = true;
}
check("junk max 0 throws", threw);
threw = false;
try {
  randomInt(1.5);
} catch {
  threw = true;
}
check("fractional max throws", threw);

/* ---------------- randomPool + validity ---------------- */
console.log("randomPool / randomOptsValid:");
const fullPool = randomPool({
  length: 12,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
});
check(
  "full pool is the concatenation",
  fullPool.pool ===
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
      SET_SYMBOLS,
  `${fullPool.size} chars`
);
const cleanPool = randomPool({
  length: 12,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
});
let ambiguityLeak = false;
for (const ch of cleanPool.pool) {
  if (AMBIGUOUS_CHARS.includes(ch)) ambiguityLeak = true;
}
check("avoidAmbiguous strips every confusable", !ambiguityLeak);
check(
  "validity needs at least one set",
  randomOptsValid({
    length: 12,
    uppercase: false,
    lowercase: false,
    digits: false,
    symbols: false,
    avoidAmbiguous: false,
  }) === false
);

/* ---------------- generateRandom ---------------- */
console.log("generateRandom:");
const opts = {
  length: 16,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};
let membershipOk = true;
let classesOk = true;
let lengthOk = true;
let entropyOk = true;
for (let i = 0; i < 300; i += 1) {
  const { password, bits } = generateRandom(opts);
  if (password.length !== 16) lengthOk = false;
  const stats = passwordStats(password, "-");
  if (!stats.hasUpper || !stats.hasLower || !stats.hasDigit || !stats.hasSymbol)
    classesOk = false;
  const pool = fullPool.pool;
  for (const ch of password) if (!pool.includes(ch)) membershipOk = false;
  if (Math.abs(bits - 16 * Math.log2(fullPool.size)) > 1e-9) entropyOk = false;
}
check("length is exact over 300 runs", lengthOk);
check("one char from every enabled set over 300 runs", classesOk);
check("every char belongs to the pool", membershipOk);
check("entropy = length·log2(poolSize)", entropyOk);

const clampedLow = generateRandom({ ...opts, length: 2 });
const clampedHigh = generateRandom({ ...opts, length: 500 });
check("length clamps up to 8", clampedLow.password.length === 8);
check("length clamps down to 64", clampedHigh.password.length === 64);

const clean = generateRandom({ ...opts, length: 32, avoidAmbiguous: true });
let cleanOk = true;
for (const ch of clean.password) if (AMBIGUOUS_CHARS.includes(ch)) cleanOk = false;
check("avoidAmbiguous output has zero confusables", cleanOk);

let noSetThrew = false;
try {
  generateRandom({
    length: 12,
    uppercase: false,
    lowercase: false,
    digits: false,
    symbols: false,
    avoidAmbiguous: false,
  });
} catch {
  noSetThrew = true;
}
check("all sets off throws", noSetThrew);

const digitsOnly = generateRandom({
  length: 12,
  uppercase: false,
  lowercase: false,
  digits: true,
  symbols: false,
  avoidAmbiguous: false,
});
let digitsOk = true;
for (const ch of digitsOnly.password) if (!SET_DIGITS.includes(ch)) digitsOk = false;
check("digits-only output uses only digits", digitsOk);

/* ---------------- generatePronounceable ---------------- */
console.log("generatePronounceable:");
let pronLenOk = true;
let pronAlphaOk = true;
for (let i = 0; i < 300; i += 1) {
  const { password } = generatePronounceable(14);
  if (password.length !== 14) pronLenOk = false;
  if (!/^[a-z]+$/.test(password)) pronAlphaOk = false;
}
check("length exact over 300 runs", pronLenOk);
check("lowercase letters only", pronAlphaOk);
check(
  "clamps to 8 minimum",
  generatePronounceable(1).password.length === 8
);
check(
  "clamps to 64 maximum",
  generatePronounceable(500).password.length === 64
);
const pronBits = generatePronounceable(20).bits;
check("pronounceable entropy is positive and plausible", pronBits > 10 && pronBits < 200, `${pronBits.toFixed(1)} bits`);

/* ---------------- generatePassphrase ---------------- */
console.log("generatePassphrase:");
const pp = generatePassphrase({
  words: 5,
  language: "en",
  separator: "-",
  capitalize: false,
  addNumber: false,
});
const ppParts = pp.password.split("-");
check("en passphrase has 5 words", ppParts.length === 5, pp.password);
check(
  "every en word comes from the list",
  ppParts.every((w) => WORDS_EN.includes(w))
);
check(
  "entropy = 5·log2(256)",
  Math.abs(pp.bits - 5 * Math.log2(WORDS_EN.length)) < 1e-9,
  `${pp.bits.toFixed(2)} bits`
);

const ppCap = generatePassphrase({
  words: 4,
  language: "en",
  separator: ".",
  capitalize: true,
  addNumber: false,
});
check(
  "capitalize uppercases every word",
  ppCap.password
    .split(".")
    .every((w) => w.charAt(0) === w.charAt(0).toLocaleUpperCase("en-IN"))
);
check(
  "capitalize adds exactly 1 bit per word",
  Math.abs(
    ppCap.bits - (4 * Math.log2(WORDS_EN.length) + 4)
  ) < 1e-9
);

const ppNum = generatePassphrase({
  words: 4,
  language: "en",
  separator: "_",
  capitalize: false,
  addNumber: true,
});
check(
  "addNumber appends digits to exactly one word",
  ppNum.password.split("_").filter((w) => /\d/.test(w)).length === 1,
  ppNum.password
);
check(
  "addNumber entropy includes log2(count)+log2(90)",
  Math.abs(
    ppNum.bits -
      (4 * Math.log2(WORDS_EN.length) + Math.log2(4) + Math.log2(90))
  ) < 1e-9
);

const ppHi = generatePassphrase({
  words: 3,
  language: "hi",
  separator: " ",
  capitalize: false,
  addNumber: false,
});
check(
  "hi passphrase words come from the Hindi list",
  ppHi.password.split(" ").every((w) => WORDS_HI.includes(w)),
  ppHi.password
);
check(
  "hi entropy uses the Hindi pool size",
  Math.abs(ppHi.bits - 3 * Math.log2(WORDS_HI.length)) < 1e-9,
  `${WORDS_HI.length} words`
);

const ppBoth = generatePassphrase({
  words: 6,
  language: "both",
  separator: "none" as const,
  capitalize: false,
  addNumber: false,
});
const bothList = wordlist("both");
check(
  "both list = en + hi",
  bothList.length === WORDS_EN.length + WORDS_HI.length
);
check(
  "both passphrase entropy uses the union pool",
  Math.abs(ppBoth.bits - 6 * Math.log2(bothList.length)) < 1e-9
);
const ppCount = generatePassphrase({
  words: 99,
  language: "en",
  separator: "-",
  capitalize: false,
  addNumber: false,
});
check("word count clamps to 8", ppCount.password.split("-").length === 8);
const ppMin = generatePassphrase({
  words: 1,
  language: "en",
  separator: "-",
  capitalize: false,
  addNumber: false,
});
check("word count clamps up to 3", ppMin.password.split("-").length === 3);

/* ---------------- strength + crack ---------------- */
console.log("strength / crack:");
check("band boundaries", 
  classifyStrength(0) === 0 &&
  classifyStrength(27.9) === 0 &&
  classifyStrength(28) === 1 &&
  classifyStrength(35.9) === 1 &&
  classifyStrength(36) === 2 &&
  classifyStrength(59.9) === 2 &&
  classifyStrength(60) === 3 &&
  classifyStrength(79.9) === 3 &&
  classifyStrength(80) === 4
);
check(
  "crackSeconds = 2^(bits-1)/1e10",
  crackSeconds(40) === Math.pow(2, 39) / 1e10
);
check(
  "bucket ladder is monotone",
  crackBucket(10) === "instant" &&
  crackBucket(45) === "minutes" &&
  crackBucket(48) === "hours" &&
  crackBucket(60) === "years" &&
  crackBucket(70) === "millennia"
);
check("crackCount of tiny bits is 0", crackCount(5) === 0);
const CRACK_ORDER = [
  "instant", "seconds", "minutes", "hours",
  "days", "months", "years", "centuries", "millennia",
] as const;
let bucketMonotone = true;
let lastIdx = -1;
for (let b = 0; b <= 100; b += 5) {
  const idx = CRACK_ORDER.indexOf(crackBucket(b));
  if (idx < lastIdx) bucketMonotone = false;
  lastIdx = idx;
}
check("bucket order never regresses over 0..100 bits", bucketMonotone);
check(
  "crackCount grows within a bucket",
  crackCount(50) > crackCount(48) && crackCount(48) > crackCount(47)
);

/* ---------------- passwordStats ---------------- */
console.log("passwordStats:");
const stats = passwordStats("Alpha7-beta/gamma", "-");
check(
  "class census",
  stats.hasUpper && stats.hasLower && stats.hasDigit && stats.hasSymbol
);
check("length census", stats.length === 17);
check("word count splits on separator", stats.wordCount === 2);
const noSep = passwordStats("plainstring", "");
check("empty separator collapses to one word", noSep.wordCount === 1);

console.log(
  `\n${passed} passed, ${failed} failed${failed === 0 ? " — ALL GREEN" : ""}`
);
process.exit(failed === 0 ? 0 : 1);
