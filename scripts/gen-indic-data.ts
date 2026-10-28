/**
 * DEV-TIME generator (P6-g): extracts the Unicode-classification DATA our own
 * Devanagari shaper needs from the installed @pdf-lib/fontkit, and rewrites it
 * as OUR committed data file (src/lib/own/pdf/indic-data.ts) — the exact same
 * dev-time-oracle pattern as scripts/gen-stamp-fonts.ts (P6-f).
 *
 * What gets extracted (facts from the Unicode database as compiled into fontkit):
 *   1. Indic category + position per codepoint (HarfBuzz's indic classification:
 *      consonant / independent vowel / matra / halant / joiner / … + visual
 *      position bits) — the exact values our shaper must see to reproduce
 *      fontkit's glyph sequences.
 *   2. Script classification (Common/Inherited/Unknown = skip, Devanagari,
 *      Latin, Greek, Cyrillic, other) for the runtime script detection that
 *      picks the shaper + GSUB langsys (mirrors fontkit's forString +
 *      selectScript fallback chain over THIS font's script list).
 *
 * Nothing from this script ships: the runtime uses only indic-data.ts.
 * Run: bun scripts/gen-indic-data.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "/home/z/my-project/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.js";
const PATCHED = "/home/z/my-project/scripts/dev/fontkit-patched.cjs";
const OUT = "/home/z/my-project/src/lib/own/pdf/indic-data.ts";

/* Patch a copy of the UMD bundle so the internal tries leak to globalThis. */
{
  let src = readFileSync(SOURCE, "utf8");
  const anchor = "return fontkit;\n\n})))";
  if (!src.includes(anchor)) throw new Error("UMD anchor not found");
  src = src.replace(
    anchor,
    `globalThis.__FONTKIT_INTERNALS = { indicTrie: trie$2, machine: indicMachine, unicodeTrie: trie, unicodeData: data };
  return fontkit;

})))`,
  );
  writeFileSync(PATCHED, src);
}
require(PATCHED);
require("regenerator-runtime/runtime");

interface Trie {
  get(cp: number): number;
}
const I = (globalThis as unknown as {
  __FONTKIT_INTERNALS: {
    indicTrie: Trie;
    machine: unknown;
    unicodeTrie: Trie;
    unicodeData: {
      categories: string[];
      scripts: string[];
      eaw: string[];
      combiningClasses: string[];
    };
  };
}).__FONTKIT_INTERNALS;

/* ── 1. Indic category + position ranges ── */
const CATS = [
  "X", "C", "V", "N", "H", "ZWNJ", "ZWJ", "M", "SM", "VD", "A",
  "Placeholder", "Dotted_Circle", "RS", "Coeng", "Repha", "Ra", "CM", "Symbol",
] as const;
const anchor = (cp: number, wantCat: string): void => {
  const got = CATS[I.indicTrie.get(cp) >> 8] ?? `?${I.indicTrie.get(cp) >> 8}`;
  if (got !== wantCat) throw new Error(`anchor U+${cp.toString(16)}: want ${wantCat} got ${got}`);
};
anchor(0x0915, "C"); // क
anchor(0x0930, "Ra"); // र
anchor(0x093f, "M"); // ि
anchor(0x094d, "H"); // ्
anchor(0x093c, "N"); // ़
anchor(0x0905, "V"); // अ
anchor(0x200d, "ZWJ");
anchor(0x200c, "ZWNJ");
anchor(0x0902, "SM"); // ं (stress-mark class in this data)
anchor(0x25cc, "Dotted_Circle");
anchor(0x0041, "X"); // A
anchor(0x0966, "Placeholder"); // ० (digits can carry matras)
anchor(0x0964, "X"); // । danda
anchor(0x0965, "X"); // ॥
console.log(
  "anchors OK; positions: क", 1 << (I.indicTrie.get(0x0915) & 0xff),
  "ि", 1 << (I.indicTrie.get(0x093f) & 0xff),
  "र", 1 << (I.indicTrie.get(0x0930) & 0xff),
  "A", 1 << (I.indicTrie.get(0x41) & 0xff),
);

const DEFAULT_VAL = I.indicTrie.get(0x41); // X + End — the non-Indic default
const indicRanges: Array<[number, number, number]> = [];
{
  let cur: { lo: number; hi: number; packed: number } | null = null;
  const flush = () => {
    if (cur) indicRanges.push([cur.lo, cur.hi, cur.packed]);
    cur = null;
  };
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const v = I.indicTrie.get(cp);
    if (v === DEFAULT_VAL) {
      flush();
      continue;
    }
    if (cur && cur.packed === v && cur.hi === cp - 1) cur.hi = cp;
    else {
      flush();
      cur = { lo: cp, hi: cp, packed: v };
    }
  }
  flush();
}
console.log("indic ranges:", indicRanges.length);

/* ── 2. Script classification ranges ── */
const unicodeData = I.unicodeData;
const scripts: string[] = unicodeData.scripts;
const bits = (n: number) => (Math.log2(n) + 1) | 0;
const SCRIPT_BITS = bits(scripts.length - 1);
const NUMBER_BITS = 10;
const EAW_BITS = bits(unicodeData.eaw.length - 1);
const COMBINING_BITS = bits(unicodeData.combiningClasses.length - 1);
const SCRIPT_SHIFT = EAW_BITS + NUMBER_BITS;
const SCRIPT_MASK = (1 << SCRIPT_BITS) - 1;
console.log("scripts:", scripts.length, "bits:", SCRIPT_BITS);

const scriptOf = (cp: number): string =>
  scripts[(I.unicodeTrie.get(cp) >> SCRIPT_SHIFT) & SCRIPT_MASK] ?? "?";
if (scriptOf(0x0915) !== "Devanagari") throw new Error("deva anchor failed");
if (scriptOf(0x41) !== "Latin") throw new Error("latin anchor failed");
if (scriptOf(0x30) !== "Common") throw new Error("digit anchor failed");

const CLS_SKIP = 0;
const CLS_DEVA = 1;
const CLS_LATN = 2;
const CLS_GREK = 3;
const CLS_CYRL = 4;
const CLS_RTL = 6;
const RTL_SCRIPT_NAMES = new Set([
  "Arabic", "Hebrew", "Syriac", "Thaana", "Cypriot", "Kharoshthi",
  "Phoenician", "Nko", "Lydian", "Avestan", "Imperial_Aramaic",
  "Inscriptional_Pahlavi", "Inscriptional_Parthian", "Old_South_Arabian",
  "Old_Turkic", "Samaritan", "Mandaic", "Meroitic_Cursive",
  "Meroitic_Hieroglyphs", "Manichaean", "Mende_Kikakui", "Nabataean",
  "Old_North_Arabian", "Palmyrene", "Psalter_Pahlavi",
]);
const clsOf = (cp: number): number => {
  const s = scriptOf(cp);
  if (s === "Common" || s === "Inherited" || s === "Unknown") return CLS_SKIP;
  if (s === "Devanagari") return CLS_DEVA;
  if (s === "Latin") return CLS_LATN;
  if (s === "Greek") return CLS_GREK;
  if (s === "Cyrillic") return CLS_CYRL;
  if (RTL_SCRIPT_NAMES.has(s)) return CLS_RTL;
  return -1; // other → DFLT fallback at runtime
};

const scriptRanges: Array<[number, number, number]> = [];
{
  let cur: { lo: number; hi: number; cls: number } | null = null;
  const flush = () => {
    if (cur && cur.cls !== -1) scriptRanges.push([cur.lo, cur.hi, cur.cls]);
    cur = null;
  };
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const cls = clsOf(cp);
    if (cur && cur.cls === cls && cur.hi === cp - 1) cur.hi = cp;
    else {
      flush();
      cur = { lo: cp, hi: cp, cls };
    }
  }
  flush();
}
console.log("script ranges:", scriptRanges.length);

/* ── 3. Split-matra decompositions (IndicShaper.assignFeatures tables) ── */
const pako = (await import("pako")).default;
const useDataMatch = /base64DeflatedUseData = "([^"]+)"/.exec(
  readFileSync(SOURCE.replace("fontkit.umd.js", "fontkit.es.js"), "utf8"),
);
if (!useDataMatch) throw new Error("useData blob not found");
const useData = JSON.parse(
  Buffer.from(
    pako.inflate(new Uint8Array(Buffer.from(useDataMatch[1]!, "base64"))) as Uint8Array,
  ).toString("utf8"),
) as { decompositions: Record<string, number[]> };
const decompositions: Array<[number, number[]]> = Object.entries(
  useData.decompositions,
).map(([k, v]) => [Number(k), v]);
// fontkit's INDIC_DECOMPOSITIONS (Khmer split matras) come first in the lookup
// order — both tables are disjoint, so a plain merge preserves behavior.
const INDIC_DECOMPOSITIONS: Record<number, number[]> = {
  0x17be: [0x17c1, 0x17be],
  0x17bf: [0x17c1, 0x17bf],
  0x17c0: [0x17c1, 0x17c0],
  0x17c4: [0x17c1, 0x17c4],
  0x17c5: [0x17c1, 0x17c5],
};
for (const [k, v] of Object.entries(INDIC_DECOMPOSITIONS)) {
  if (!decompositions.some(([cp]) => cp === Number(k))) decompositions.push([Number(k), v]);
}
console.log("decompositions:", decompositions.length);

/* ── 4. Cf|Mn ranges (finalReordering's init-feature guard) ── */
const categories: string[] = unicodeData.categories;
const CATEGORY_BITS = bits(categories.length - 1);
// (COMBINING_BITS declared earlier)
const CATEGORY_SHIFT = COMBINING_BITS + SCRIPT_BITS + EAW_BITS + NUMBER_BITS;
const CATEGORY_MASK = (1 << CATEGORY_BITS) - 1;
const categoryOf = (cp: number): string =>
  categories[(I.unicodeTrie.get(cp) >> CATEGORY_SHIFT) & CATEGORY_MASK] ?? "?";
if (categoryOf(0x200d) !== "Cf") throw new Error("zwj category anchor failed");
if (categoryOf(0x093c) !== "Mn") throw new Error("nukta category anchor failed");
const cfMnRanges: Array<[number, number]> = [];
{
  let cur: { lo: number; hi: number } | null = null;
  const flush = () => {
    if (cur) cfMnRanges.push([cur.lo, cur.hi]);
    cur = null;
  };
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const c = categoryOf(cp);
    const isCfMn = c === "Cf" || c === "Mn";
    if (isCfMn) {
      if (cur && cur.hi === cp - 1) cur.hi = cp;
      else {
        flush();
        cur = { lo: cp, hi: cp };
      }
    } else {
      flush();
    }
  }
  flush();
}
console.log("Cf|Mn ranges:", cfMnRanges.length);

/* ── Write the committed data file ── */
const fmt = (r: Array<[number, number, number]>): string =>
  r.map(([lo, hi, v]) => `  [${lo}, ${hi}, ${v}],`).join("\n");

const header = `/**
 * DocoPDF own PDF engine — Unicode classification data for the Devanagari
 * shaper (P6-g). GENERATED at dev time by scripts/gen-indic-data.ts from the
 * Unicode database values compiled into @pdf-lib/fontkit (the dev-time oracle
 * — same pattern as stamp-fonts-data.ts from P6-f). Do not edit by hand.
 *
 * Two tables:
 *   INDIC_PACKED — HarfBuzz Indic category (bit index, 0..18) + position (bit
 *     index, 0..15) per codepoint, as runs. Outside the runs → category X,
 *     position End (the trie's non-Indic default).
 *   SCRIPT_TABLE — script classification for first-script detection:
 *     0=skip (Common/Inherited/Unknown), 1=Devanagari, 2=Latin, 3=Greek,
 *     4=Cyrillic. Anything unlisted = other, which the runtime maps to the
 *     DFLT→dflt→latn GSUB fallback chain fontkit walks over this font's
 *     script list.
 */
`;

const body = `
/** packed = catIdx << 8 | posIdx runs; outside → the X/End default. */
const INDIC_PACKED: ReadonlyArray<readonly [number, number, number]> = [
${fmt(indicRanges)}
];

const INDIC_DEFAULT_PACKED = ${DEFAULT_VAL};

export function indicCatPos(codePoint: number): { cat: number; pos: number } {
  let lo = 0;
  let hi = INDIC_PACKED.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = INDIC_PACKED[mid]!;
    if (codePoint < run[0]) hi = mid - 1;
    else if (codePoint > run[1]) lo = mid + 1;
    else return { cat: run[2] >> 8, pos: run[2] & 0xff };
  }
  return { cat: INDIC_DEFAULT_PACKED >> 8, pos: INDIC_DEFAULT_PACKED & 0xff };
}

/** Split-matra decompositions applied before syllabification (IndicShaper). */
export const DECOMPOSITIONS: ReadonlyMap<number, readonly number[]> = new Map([
${decompositions.map(([cp, parts]) => `  [${cp}, [${parts.join(", ")}]],`).join("\n")}
]);

/** Script classes for first-meaningful-script detection. */
export const SCRIPT_SKIP = 0;
export const SCRIPT_DEVA = 1;
export const SCRIPT_LATN = 2;
export const SCRIPT_GREK = 3;
export const SCRIPT_CYRL = 4;
export const SCRIPT_OTHER = 5;
export const SCRIPT_RTL = 6;

const SCRIPT_TABLE: ReadonlyArray<readonly [number, number, number]> = [
${fmt(scriptRanges)}
];

export function scriptClass(codePoint: number): number {
  let lo = 0;
  let hi = SCRIPT_TABLE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = SCRIPT_TABLE[mid]!;
    if (codePoint < run[0]) hi = mid - 1;
    else if (codePoint > run[1]) lo = mid + 1;
    else return run[2];
  }
  return SCRIPT_OTHER;
}

/** True for Cf|Mn codepoints (the init-feature guard in finalReordering). */
const CF_MN: ReadonlyArray<readonly [number, number]> = [
${cfMnRanges.map(([lo, hi]) => `  [${lo}, ${hi}],`).join("\n")}
];

export function isCfOrMn(codePoint: number): boolean {
  let lo = 0;
  let hi = CF_MN.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = CF_MN[mid]!;
    if (codePoint < run[0]) hi = mid - 1;
    else if (codePoint > run[1]) lo = mid + 1;
    else return true;
  }
  return false;
}
`;

writeFileSync(OUT, header + body);
console.log("wrote", OUT, `(${indicRanges.length} indic runs, ${scriptRanges.length} script runs)`);
