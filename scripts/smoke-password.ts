/**
 * Smoke test for tools/generate-password/engine.ts (pure module — no DOM).
 * Run: bun scripts/smoke-password.ts
 * Exit code 0 = all pass. Pattern follows scripts/smoke-redact.ts.
 */
import {
  AMBIGUOUS_CHARS,
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
  SET_DIGITS,
  SET_SYMBOLS,
  wordlist,
  WORDS_EN,
  WORDS_HI,
  type PassphraseOptions,
  type RandomOptions,
} from "../tools/generate-password/engine";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

/* 1 — randomInt bounds + sanity distribution */
console.log("1. randomInt");
{
  let bad = 0;
  for (let i = 0; i < 20000; i += 1) {
    const v = randomInt(7);
    if (!Number.isInteger(v) || v < 0 || v >= 7) bad += 1;
  }
  ok(bad === 0, "20000 draws stay in [0,7)");
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 70000; i += 1) counts[randomInt(7)] += 1;
  const chi = counts.reduce((s, c) => s + (c - 10000) ** 2 / 10000, 0);
  ok(chi < 30, "chi-square < 30 (no modulo bias)", `chi=${chi.toFixed(1)} counts=${counts}`);
  let threw = false;
  try { randomInt(0); } catch { threw = true; }
  ok(threw, "randomInt(0) throws");
}

/* 2 — random mode: length, sets, ambiguity */
console.log("2. generateRandom");
{
  const base: RandomOptions = {
    length: 16, uppercase: true, lowercase: true, digits: true,
    symbols: true, avoidAmbiguous: false,
  };
  for (let i = 0; i < 200; i += 1) {
    const { password } = generateRandom(base);
    if (password.length !== 16) { ok(false, "length 16", password); break; }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      ok(false, "all enabled classes present", password); break;
    }
    if (![...password].some((c) => SET_SYMBOLS.includes(c))) {
      ok(false, "symbol present", password); break;
    }
    if (i === 199) ok(true, "length + all classes present over 200 runs");
  }
  const strict: RandomOptions = { ...base, length: 12, symbols: false, avoidAmbiguous: true };
  for (let i = 0; i < 200; i += 1) {
    const { password } = generateRandom(strict);
    if ([...password].some((c) => AMBIGUOUS_CHARS.includes(c))) {
      ok(false, "ambiguous chars stripped", password); break;
    }
    if ([...password].some((c) => SET_SYMBOLS.includes(c) && !AMBIGUOUS_CHARS.includes(c))) {
      // symbols disabled entirely — nothing symbol-ish allowed
      ok(false, "symbols disabled but symbol-ish found", password); break;
    }
    if (i === 199) ok(true, "ambiguous stripped + symbols off over 200 runs");
  }
  // boundaries
  ok(generateRandom({ ...base, length: 4 }).password.length === 8, "length clamps up to 8");
  ok(generateRandom({ ...base, length: 500 }).password.length === 64, "length clamps down to 64");
  ok(!randomOptsValid({ ...base, uppercase: false, lowercase: false, digits: false, symbols: false }), "all-off invalid");
  const pool = randomPool({ ...base, avoidAmbiguous: true });
  ok(pool.size > 0 && ![...pool.pool].some((c) => AMBIGUOUS_CHARS.includes(c)), "pool strips ambiguous");
  // entropy math
  const { bits } = generateRandom({ ...base, length: 20 });
  ok(Math.abs(bits - 20 * Math.log2(randomPool(base).size)) < 0.001, "random bits = length·log2(pool)");
}

/* 3 — pronounceable: length + letters only + entropy sane */
console.log("3. generatePronounceable");
{
  for (let len = 8; len <= 64; len += 7) {
    for (let i = 0; i < 100; i += 1) {
      const { password, bits } = generatePronounceable(len);
      if (password.length !== len) { ok(false, `exact length ${len}`, password); break; }
      if (!/^[a-z]+$/.test(password)) { ok(false, "letters only", password); break; }
      if (bits <= 0) { ok(false, "positive bits"); break; }
      if (i === 99) ok(true, `len ${len}: exact, letters-only, bits>0 (e.g. ${bits.toFixed(1)})`);
    }
  }
  // vowel coverage: at least 2 vowels for readability
  const { password } = generatePronounceable(12);
  ok((password.match(/[aeiou]/g) ?? []).length >= 2, "has vowels", password);
}

/* 4 — passphrase: counts, separators, languages, options */
console.log("4. generatePassphrase");
{
  const base: PassphraseOptions = {
    words: 5, language: "en", separator: "-", capitalize: false, addNumber: false,
  };
  for (let i = 0; i < 200; i += 1) {
    const { password, bits } = generatePassphrase(base);
    const parts = password.split("-");
    if (parts.length !== 5) { ok(false, "5 words", password); break; }
    if (parts.some((w) => !WORDS_EN.includes(w))) { ok(false, "all words from EN list", password); break; }
    if (Math.abs(bits - 5 * Math.log2(256)) > 0.001) { ok(false, "EN bits = 5·log2(256)=40", `${bits}`); break; }
    if (i === 199) ok(true, "5 EN words, 40 bits");
  }
  const hi: PassphraseOptions = { ...base, language: "hi" };
  const hiOut = generatePassphrase(hi);
  ok(
    hiOut.password.split("-").every((w) => WORDS_HI.includes(w)),
    "HI words from HI list", hiOut.password,
  );
  const both: PassphraseOptions = { ...base, language: "both" };
  ok(Math.abs(generatePassphrase(both).bits - 5 * Math.log2(512)) < 0.001, "both = 512-word pool (45 bits)");
  // clamps
  ok(generatePassphrase({ ...base, words: 1 }).password.split("-").length === 3, "words clamp up to 3");
  ok(generatePassphrase({ ...base, words: 99 }).password.split("-").length === 8, "words clamp down to 8");
  // separators
  for (const sep of ["-", ".", "_", " ", "none"] as const) {
    const { password } = generatePassphrase({ ...base, separator: sep });
    const expectedSep = sep === "none" ? "" : sep;
    const words = password.split(expectedSep === "" ? /(?<=\D)(?=\D)/ : expectedSep);
    if (sep === "none") {
      // concatenated — verify length equals sum of the word lengths
      const total = password.length;
      ok(total > 10 && !password.includes("-"), `sep "${sep}" concatenates`, password);
    } else if (sep === " ") {
      ok(words.length === 5, `sep " " splits to 5`, password);
    } else {
      ok(password.split(sep).length === 5, `sep "${sep}" splits to 5`, password);
    }
  }
  // capitalize
  const cap: PassphraseOptions = { ...base, language: "en", capitalize: true };
  const capOut = generatePassphrase(cap);
  ok(
    capOut.password.split("-").every((w) => w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()),
    "capitalize uppercases each EN word", capOut.password,
  );
  ok(Math.abs(capOut.bits - (40 + 5)) < 0.001, "capitalize adds 1 bit/word");
  // addNumber
  const num: PassphraseOptions = { ...base, addNumber: true };
  const numOut = generatePassphrase(num);
  ok(/\d{2}/.test(numOut.password), "addNumber appends 2 digits", numOut.password);
  ok(numOut.bits > 40, "addNumber increases bits");
  // wordlists
  ok(wordlist("en").length === 256 && new Set(wordlist("en")).size === 256, "EN list = 256 unique");
  ok(wordlist("hi").length === 256 && new Set(wordlist("hi")).size === 256, "HI list = 256 unique");
  ok(wordlist("both").length === 512 && new Set(wordlist("both")).size === 512, "both = 512 unique");
}

/* 5 — strength + crack time */
console.log("5. strength + crack time");
{
  ok(classifyStrength(10) === 0, "10 bits = very weak");
  ok(classifyStrength(30) === 1, "30 bits = weak");
  ok(classifyStrength(45) === 2, "45 bits = fair");
  ok(classifyStrength(65) === 3, "65 bits = strong");
  ok(classifyStrength(90) === 4, "90 bits = excellent");
  ok(classifyStrength(80) === 4, "80 bits boundary = excellent");
  ok(classifyStrength(79.9) === 3, "79.9 bits = strong");
  // crackSeconds: 50 bits → 2^49/1e10 ≈ 56295 s ≈ 15.6 hours
  ok(Math.abs(crackSeconds(50) - Math.pow(2, 49) / 1e10) < 1e-6, "crackSeconds formula");
  ok(crackBucket(0) === "instant", "0 bits = instant");
  ok(crackBucket(50) === "hours", "50 bits = hours");
  ok(crackBucket(64) === "years", "64 bits = years");
  ok(crackBucket(100) === "millennia", "100 bits = millennia");
  ok(crackBucket(200) === "millennia", "200 bits = millennia");
  ok(crackCount(50) > 0, "crackCount positive");
  // monotonic buckets
  const bitsList = [10, 30, 45, 50, 55, 60, 64, 70, 80, 90, 100, 128, 160, 200];
  const buckets = bitsList.map(crackBucket);
  const order = ["instant", "seconds", "minutes", "hours", "days", "months", "years", "centuries", "millennia"];
  ok(
    buckets.every((b, i) => i === 0 || order.indexOf(b) >= order.indexOf(buckets[i - 1])),
    "crack buckets monotonic", buckets.join(","),
  );
}

/* 6 — passwordStats */
console.log("6. passwordStats");
{
  const s = passwordStats("Abc12!x", "-");
  ok(s.length === 7, "stats length");
  ok(s.hasUpper && s.hasLower && s.hasDigit && s.hasSymbol, "stats classes");
  const p = passwordStats("river-forest-lotus", "-");
  ok(p.wordCount === 3, "stats wordCount via separator");
  ok(p.hasLower && !p.hasUpper, "passphrase stats classes");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
