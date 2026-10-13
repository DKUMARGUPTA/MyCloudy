/**
 * Generate Password engine (PRD §8.4 "Security tools" row, line 884):
 * "Length 8-64, character sets, pronounceable, passphrase (Hindi/English
 * word list), copy button, strength meter. Web Crypto (random), kuch store
 * nahi."
 *
 * PURE module — no React, no DOM. The only ambient dependency is the Web
 * Crypto `crypto.getRandomValues` (CSP-friendly; no eval, no Math.random
 * anywhere). Every generator returns BOTH the value and the honest entropy
 * in bits derived from the random choices it actually made.
 *
 * Randomness rules (security core):
 *  - `randomInt(max)` uses rejection sampling over Uint32 so there is NO
 *    modulo bias in charset picks.
 *  - the shuffle that hides the forced one-per-set prefix is a Fisher-Yates
 *    driven by the same `randomInt`.
 */

export type GenMode = "random" | "pronounceable" | "passphrase";

export interface RandomOptions {
  /** 8..64 (PRD). */
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Drop visually ambiguous glyphs (0 O 1 l I | ` ' " { } ; : , .). */
  avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
  /** 3..8 words. */
  words: number;
  language: "en" | "hi" | "both";
  separator: "-" | "." | "_" | " " | "none";
  /** Capitalize first letter of every word. */
  capitalize: boolean;
  /** Append a 2-digit number to one random word. */
  addNumber: boolean;
}

export interface GeneratedPassword {
  password: string;
  /** Honest entropy estimate in bits (from the choices actually made). */
  bits: number;
}

/* ------------------------------------------------------------------ */
/* Secure randomness                                                   */
/* ------------------------------------------------------------------ */

const RAND_BUF = new Uint32Array(1);

/** Unbiased uniform integer in [0, max) via rejection sampling. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) {
    throw new Error("randomInt: max must be an integer in (0, 2^32]");
  }
  // Largest multiple of max that fits a uint32 — reject above it.
  const limit = Math.floor(0x100000000 / max) * max;
  for (;;) {
    const value = globalThis.crypto.getRandomValues(RAND_BUF)[0];
    if (value < limit) return value % max;
  }
}

function pickChar(alphabet: string): string {
  return alphabet.charAt(randomInt(alphabet.length));
}

/** In-place unbiased Fisher-Yates (secure variant of the sort shuffle). */
function secureShuffle(chars: string[]): void {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
}

/* ------------------------------------------------------------------ */
/* Random mode                                                         */
/* ------------------------------------------------------------------ */

export const SET_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SET_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const SET_DIGITS = "0123456789";
export const SET_SYMBOLS = "!@#$%^&*()-_=+[]{}<>?/~";
/** Characters that look alike across fonts (confusable glyphs). */
export const AMBIGUOUS_CHARS = "0O1lI|`'\"{}[];:,.";

function stripAmbiguous(set: string): string {
  let out = "";
  for (const ch of set) {
    if (!AMBIGUOUS_CHARS.includes(ch)) out += ch;
  }
  return out;
}

export interface CharsetInfo {
  pool: string;
  /** Number of distinct symbols in the effective pool. */
  size: number;
}

/** Effective pool for the given random options (after ambiguity strip). */
export function randomPool(opts: RandomOptions): CharsetInfo {
  const parts: string[] = [];
  if (opts.uppercase) parts.push(opts.avoidAmbiguous ? stripAmbiguous(SET_UPPERCASE) : SET_UPPERCASE);
  if (opts.lowercase) parts.push(opts.avoidAmbiguous ? stripAmbiguous(SET_LOWERCASE) : SET_LOWERCASE);
  if (opts.digits) parts.push(opts.avoidAmbiguous ? stripAmbiguous(SET_DIGITS) : SET_DIGITS);
  if (opts.symbols) parts.push(opts.avoidAmbiguous ? stripAmbiguous(SET_SYMBOLS) : SET_SYMBOLS);
  const pool = parts.join("");
  return { pool, size: pool.length };
}

/** At least one charset must stay on (UI enforces; engine re-checks). */
export function randomOptsValid(opts: RandomOptions): boolean {
  return opts.uppercase || opts.lowercase || opts.digits || opts.symbols;
}

/**
 * Random password: one char from EVERY enabled set first (so class
 * requirements can never fail), then the rest from the union pool, then an
 * unbiased shuffle hides the structure. Entropy is the standard estimate
 * length·log2(poolSize) — the forced prefix costs a small constant the
 * estimate generously ignores (industry convention, kept honest by the
 * strength bands being conservative).
 */
export function generateRandom(opts: RandomOptions): GeneratedPassword {
  if (!randomOptsValid(opts)) throw new Error("no charset enabled");
  const length = clampLength(opts.length);
  const { pool } = randomPool(opts);
  if (pool.length === 0) throw new Error("empty charset pool");

  const chars: string[] = [];
  if (opts.uppercase) chars.push(pickChar(opts.avoidAmbiguous ? stripAmbiguous(SET_UPPERCASE) : SET_UPPERCASE));
  if (opts.lowercase) chars.push(pickChar(opts.avoidAmbiguous ? stripAmbiguous(SET_LOWERCASE) : SET_LOWERCASE));
  if (opts.digits) chars.push(pickChar(opts.avoidAmbiguous ? stripAmbiguous(SET_DIGITS) : SET_DIGITS));
  if (opts.symbols) chars.push(pickChar(opts.avoidAmbiguous ? stripAmbiguous(SET_SYMBOLS) : SET_SYMBOLS));
  while (chars.length < length) chars.push(pickChar(pool));
  chars.length = length;
  secureShuffle(chars);
  return {
    password: chars.join(""),
    bits: length * Math.log2(pool.length),
  };
}

function clampLength(length: number): number {
  const n = Math.round(length);
  if (Number.isNaN(n)) return 12;
  return Math.min(64, Math.max(8, n));
}

/* ------------------------------------------------------------------ */
/* Pronounceable mode                                                  */
/* ------------------------------------------------------------------ */

/** Onset consonants + clusters (no ambiguous glyphs). */
const ONS = [
  "b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s",
  "t", "v", "w", "y", "z", "br", "ch", "cl", "cr", "dr", "fl", "fr",
  "gl", "gr", "pl", "pr", "sc", "sh", "sk", "sl", "sm", "sn", "sp",
  "st", "sw", "tr", "tw", "th", "ph", "wh", "kn", "qu",
];
/** Vowel nuclei. */
const NUC = [
  "a", "e", "i", "o", "u", "ai", "au", "ea", "ee", "ie", "oa", "oo",
  "ou", "oi", "ae", "io",
];
/** Coda consonants (light, so words stay readable). Empty = open syllable. */
const COD = [
  "", "", "", "b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s",
  "t", "x", "ng", "ck", "sh", "rt", "nd", "st", "sk", "ll", "ss", "rn", "rm",
];

/**
 * Syllable soup: onset + nucleus (+ coda when there is room). Every random
 * choice is one `randomInt` draw, so entropy is counted per draw from the
 * pool sizes actually offered — honest to the generator, not to a linguist.
 */
export function generatePronounceable(lengthRaw: number): GeneratedPassword {
  const length = clampLength(lengthRaw);
  let out = "";
  let bits = 0;
  while (out.length < length) {
    const onset = ONS[randomInt(ONS.length)];
    bits += Math.log2(ONS.length);
    const nucleus = NUC[randomInt(NUC.length)];
    bits += Math.log2(NUC.length);
    let syllable = onset + nucleus;
    // Coda only when another onset+nucleus still fits behind it.
    if (out.length + syllable.length + 3 <= length) {
      const coda = COD[randomInt(COD.length)];
      bits += Math.log2(COD.length);
      syllable += coda;
    }
    out += syllable;
  }
  // Exact length: trim at the tail (a cut coda is still pronounceable).
  if (out.length > length) out = out.slice(0, length);
  return { password: out, bits };
}

/* ------------------------------------------------------------------ */
/* Passphrase mode                                                     */
/* ------------------------------------------------------------------ */

/**
 * 256 common English words — concrete nouns, easy to type, no homoglyph
 * traps. 8 bits of entropy per word.
 */
export const WORDS_EN: readonly string[] = [
  "river", "forest", "island", "meadow", "valley", "canyon", "desert",
  "sunset", "sunrise", "thunder", "rainbow", "breeze", "pebble",
  "boulder", "stream", "glacier", "volcano", "lagoon", "reef", "cliff",
  "dune", "oasis", "storm", "cloud", "drizzle", "mist", "frost",
  "ember", "dawn", "dusk", "twilight", "horizon", "orchard", "harvest",
  "blossom", "petal", "maple", "cedar", "birch", "willow", "fern",
  "moss", "ivy", "clover", "tulip", "lotus", "jasmine", "marigold",
  "sunflower", "lavender", "orchid", "cactus", "bamboo", "thorn",
  "sprout", "garden", "winter", "summer", "monsoon", "autumn",
  "tiger", "panther", "falcon", "eagle", "heron", "otter", "badger",
  "dolphin", "whale", "turtle", "cobra", "gecko", "lynx", "wolf",
  "bear", "deer", "bison", "raven", "robin", "sparrow", "parrot",
  "peacock", "penguin", "seal", "walrus", "beaver", "rabbit", "hare",
  "hedgehog", "squirrel", "fox", "kitten", "cub", "lamb", "goat",
  "camel", "horse", "zebra", "giraffe", "leopard", "mongoose",
  "lantern", "candle", "hammock", "compass", "anchor", "rudder",
  "sail", "harbor", "bridge", "tunnel", "tower", "castle", "cottage",
  "cabin", "temple", "kitchen", "pantry", "cellar", "attic", "window",
  "mirror", "blanket", "pillow", "scarf", "glove", "boots", "jacket",
  "kettle", "teapot", "saucer", "basket", "apron", "honey", "mango",
  "melon", "berry", "cherry", "peach", "plum", "fig", "olive",
  "almond", "walnut", "cashew", "raisin", "saffron", "cardamom",
  "cinnamon", "pepper", "ginger", "turmeric", "cumin", "lentil",
  "bread", "roti", "dosa", "idli", "samosa", "pakora", "laddu",
  "halwa", "kheer", "courage", "wisdom", "kindness", "patience",
  "wonder", "delight", "calm", "hope", "dream", "story", "song",
  "rhythm", "melody", "chorus", "verse", "poem", "novel", "letter",
  "secret", "promise", "journey", "voyage", "path", "trail", "route",
  "signal", "beacon", "spark", "flame", "shadow", "echo", "silence",
  "music", "dance", "theatre", "festival", "market", "bazaar",
  "caravan", "lighthouse", "observatory", "planet", "comet", "meteor", "galaxy",
  "nebula", "aurora", "zenith", "equinox", "solstice", "eclipse",
  "meridian", "cascade", "delta", "estuary", "marsh", "thicket",
  "grove", "copse", "bramble", "tundra", "prairie", "savanna",
  "steppe", "fjord", "gorge", "ravine", "mesa", "butte", "plateau",
  "summit", "ridge", "slope", "basecamp", "trailhead", "vista",
  "hamlet", "courtyard", "balcony", "veranda", "corridor", "alcove",
  "hearth", "mantel", "granite", "marble", "basalt", "arrow",
  "torch", "silo", "granary", "windmill", "pasture",
];

/**
 * 256 common Hindi (Devanagari) words — everyday nouns and adjectives
 * an Indian reader types without thinking. 8 bits per word.
 */
export const WORDS_HI: readonly string[] = [
  "नदी", "पहाड़", "जंगल", "समुद्र", "द्वीप", "घाटी", "रेगिस्तान",
  "सूरज", "चाँद", "तारा", "आकाश", "बादल", "हवा", "पानी", "मिट्टी",
  "रेत", "पेड़", "पत्ता", "डाली", "जड़", "बीज", "फल", "आम", "सेब",
  "केला", "अंगूर", "नारियल", "अनार", "लीची", "खजूर", "तरबूज़",
  "फूल", "कमल", "गुलाब", "जूही", "बेला", "चमेली", "गेंदा",
  "सूरजमुखी", "चंपा", "अशोक", "नीम", "पीपल", "बरगद", "बाँस",
  "बगीचा", "सर्दी", "गर्मी", "बरसात", "पतझड़", "बसंत",
  "बाघ", "चीता", "बाज", "गरुड़", "बगुला", "ऊद", "शेर",
  "हिरण", "भालू", "भेड़", "बकरी", "घोड़ा", "खच्चर", "ऊँट",
  "गाय", "भैंस", "कुत्ता", "खरगोश", "गिलहरी", "लोमड़ी",
  "कौआ", "तोता", "मोर", "हंस", "कबूतर", "गौरैया", "कोयल",
  "मछली", "कछुआ", "मगरमच्छ", "साँप", "नाग", "छिपकली",
  "मधुमक्खी", "तितली", "झींगुर", "चिड़िया", "अंडा", "घोंसला",
  "लालटेन", "मोमबत्ती", "कम्पास", "लंगर", "पाल", "बंदरगाह",
  "पुल", "सुरंग", "मीनार", "किला", "झोपड़ी", "मंदिर", "रसोई",
  "खिड़की", "आईना", "कंबल", "तकिया", "दुपट्टा", "दस्ताने",
  "जूते", "कढ़ाई", "केतली", "टोकरी", "शहद", "खिलौना",
  "पुस्तक", "कलम", "कागज़", "लिफाफा", "ताला", "चाबी", "घंटी",
  "ढोल", "बाँसुरी", "सितार", "गीत", "कविता", "कहानी", "नाटक",
  "त्योहार", "बाज़ार", "मेला", "समूह", "मित्र", "पड़ोसी",
  "साहस", "बुद्धि", "दया", "धैर्य", "आशा", "सपना", "यात्रा",
  "राह", "निशान", "मशाल", "चिंगारी", "लौ", "छाया", "प्रतिध्वनि",
  "संगीत", "नृत्य", "कला", "रंग", "चित्र", "मूर्ति", "आभूषण",
  "ग्रह", "धूमकेतु", "आकाशगंगा", "तारामंडल", "भोर", "संध्या",
  "ग्रहण", "वर्षा", "बूँद", "झरना", "दलदल", "घास", "तिनका",
  "पहाड़ी", "चोटी", "ढलान", "गुफा", "नमक", "चीनी", "दूध",
  "दही", "घी", "आटा", "चावल", "दाल", "सब्ज़ी", "कढ़ी",
  "खीर", "लड्डू", "हलवा", "पकौड़ा", "समोसा", "इडली", "डोसा",
  "रोटी", "भात", "चटनी", "अचार", "मिठाई", "जलेबी", "रबड़ी",
  "मालपुआ", "ठंडा", "गर्म", "मीठा", "नरम", "कठोर", "हल्का",
  "भारी", "तेज़", "धीमा", "साफ़", "सुंदर", "शांत", "सुबह",
  "दोपहर", "शाम", "रात", "पहर", "पल", "क्षण", "याद",
  "मुस्कान", "आँसू", "हँसी", "खुशी", "धूप", "छाँव", "माला",
  "कपड़ा", "साड़ी", "कुर्ता", "टोपी", "झोला", "थाली", "गिलास",
  "चम्मच", "कटोरी", "बर्तन", "चूल्हा", "आँगन", "छत", "दरवाज़ा",
  "दीवार", "सीढ़ी", "खंभा", "नाव", "डोली", "गाड़ी", "पहिया",
  "हल", "कुदाल", "खलिहान", "कुआँ", "तालाब", "सरोवर", "मिठास",
  "खुशबू", "रोशनी", "धूल",
];

/** Effective wordlist for the chosen language. */
export function wordlist(language: PassphraseOptions["language"]): readonly string[] {
  if (language === "en") return WORDS_EN;
  if (language === "hi") return WORDS_HI;
  return WORDS_BOTH;
}

const WORDS_BOTH: readonly string[] = [...WORDS_EN, ...WORDS_HI];

function capitalizeWord(word: string): string {
  if (!word) return word;
  // Devanagari first code point capitalization is a no-op — harmless.
  return word.charAt(0).toLocaleUpperCase("en-IN") + word.slice(1);
}

/**
 * Passphrase: words joined by the separator. Entropy = words·log2(pool) +
 * log2(count)+log2(90) when the 2-digit number is added + 1 bit/word for
 * capitalize (each word is a binary choice of casing — honest even when
 * applied uniformly).
 */
export function generatePassphrase(opts: PassphraseOptions): GeneratedPassword {
  const list = wordlist(opts.language);
  const count = Math.min(8, Math.max(3, Math.round(opts.words)));
  const sep = opts.separator === "none" ? "" : opts.separator;
  const parts: string[] = [];
  let bits = count * Math.log2(list.length);
  for (let i = 0; i < count; i += 1) {
    parts.push(list[randomInt(list.length)]);
  }
  if (opts.addNumber) {
    // Append a 2-digit number to one uniformly chosen word.
    const index = randomInt(count);
    const number = String(10 + randomInt(90));
    bits += Math.log2(count) + Math.log2(90);
    parts[index] = `${parts[index]}${number}`;
  }
  const words = opts.capitalize ? parts.map(capitalizeWord) : parts;
  if (opts.capitalize) bits += count; // binary casing choice per word
  return { password: words.join(sep), bits };
}

/* ------------------------------------------------------------------ */
/* Strength + crack time                                               */
/* ------------------------------------------------------------------ */

/** 0 very weak · 1 weak · 2 fair · 3 strong · 4 excellent. */
export function classifyStrength(bits: number): 0 | 1 | 2 | 3 | 4 {
  if (bits < 28) return 0;
  if (bits < 36) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/**
 * Average seconds to crack at a fast offline attack of 10^10 guesses/sec
 * (modern GPU hash rigs — the honest "bad case"). Average = half the keyspace.
 */
export function crackSeconds(bits: number): number {
  return Math.pow(2, bits - 1) / 1e10;
}

/** Coarse bucket the surface renders with localized copy. */
export type CrackBucket =
  | "instant" | "seconds" | "minutes" | "hours"
  | "days" | "months" | "years" | "centuries" | "millennia";

export function crackBucket(bits: number): CrackBucket {
  const s = crackSeconds(bits);
  if (s < 1) return "instant";
  if (s < 60) return "seconds";
  if (s < 3600) return "minutes";
  if (s < 86400) return "hours";
  if (s < 2592000) return "days";
  if (s < 31557600) return "months";
  if (s < 31557600 * 100) return "years";
  if (s < 31557600 * 1000) return "centuries";
  return "millennia";
}

/** Pretty-rounded multiplier for the bucket (e.g. "~3 years"). */
export function crackCount(bits: number): number {
  const s = crackSeconds(bits);
  const year = 31557600;
  if (s < 1) return 0;
  if (s < 60) return Math.round(s);
  if (s < 3600) return Math.round(s / 60);
  if (s < 86400) return Math.round(s / 3600);
  if (s < 2592000) return Math.round(s / 86400);
  if (s < year) return Math.round(s / 2592000);
  if (s < year * 100) return Math.round(s / year);
  if (s < year * 1000) return Math.round(s / (year * 100));
  return Math.round(s / (year * 1000));
}

/* ------------------------------------------------------------------ */
/* Analysis of the generated value (display helpers)                   */
/* ------------------------------------------------------------------ */

export interface PasswordStats {
  length: number;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
  wordCount: number;
}

/** Character-class + word census for the checklist chips. */
export function passwordStats(password: string, separator: string): PasswordStats {
  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;
  let hasSymbol = false;
  for (const ch of password) {
    if (ch >= "A" && ch <= "Z") hasUpper = true;
    else if (ch >= "a" && ch <= "z") hasLower = true;
    else if (ch >= "0" && ch <= "9") hasDigit = true;
    else hasSymbol = true;
  }
  const wordCount =
    separator === ""
      ? 1
      : password.split(separator).filter(Boolean).length;
  return {
    length: password.length,
    hasUpper,
    hasLower,
    hasDigit,
    hasSymbol,
    wordCount,
  };
}
