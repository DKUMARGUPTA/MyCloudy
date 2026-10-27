/**
 * P9-F5B merge: inserts the NEW "einv" + "p2e" sections (create-electronic-
 * invoice, the 91st tool + pdf-to-e-invoice, the 92nd) into the shared
 * catalogs. Verifies perfect en↔hi parity — within both parts and the
 * whole catalogs (recursive leaf count, the 2823-baseline method) —
 * refuses clobbering, checks the required howKeys/needFile contract,
 * cross-checks that every "einv.*" / "p2e.*" literal referenced by
 * eiform.tsx + both surfaces exists in BOTH languages, then rewrites
 * src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-einvoice-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/create-electronic-invoice/i18n.json`, "utf8")
);

const SECTIONS = ["einv", "p2e"] as const;

/* ---- part parity + clobber refusal ---- */
for (const section of SECTIONS) {
  const enPatch = part.en?.[section] ?? {};
  const hiPatch = part.hi?.[section] ?? {};
  const flatEn = Object.keys(enPatch).sort();
  const flatHi = Object.keys(hiPatch).sort();
  if (JSON.stringify(flatEn) !== JSON.stringify(flatHi)) {
    const enOnly = flatEn.filter((k) => !(k in hiPatch));
    const hiOnly = flatHi.filter((k) => !(k in enPatch));
    throw new Error(
      `${section}: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
    );
  }
  if (section in en || section in hi) {
    throw new Error(`section "${section}" already exists — refusing to clobber`);
  }
  en[section] = enPatch;
  hi[section] = hiPatch;
}

/* ---- required keys contract (both configs' howKeys + the run-block key) ---- */
const required = [
  "einv.how1",
  "einv.how2",
  "einv.how3",
  "p2e.how1",
  "p2e.how2",
  "p2e.how3",
  "einv.needFile",
];
const missingRequired = required.filter(
  (key) => {
    const [section, leaf] = key.split(".");
    return !(leaf in en[section]) || !(leaf in hi[section]);
  }
);
if (missingRequired.length > 0) {
  throw new Error(`required keys missing: ${missingRequired.join(", ")}`);
}

/* ---- every "einv.*" / "p2e.*" literal in the new sources ---- */
const sources = [
  "tools/einvoice-common/eiform.tsx",
  "tools/create-electronic-invoice/surface.tsx",
  "tools/pdf-to-e-invoice/surface.tsx",
];
const literals = new Map<string, Set<string>>();
for (const section of SECTIONS) literals.set(section, new Set());
for (const rel of sources) {
  const src = readFileSync(`${root}${rel}`, "utf8");
  for (const section of SECTIONS) {
    for (const m of src.matchAll(new RegExp(`"${section}\\.([a-zA-Z0-9]+)"`, "g"))) {
      literals.get(section)?.add(m[1]);
    }
  }
}
for (const section of SECTIONS) {
  const missing = [...(literals.get(section) ?? [])].filter(
    (key) => !(key in en[section]) || !(key in hi[section])
  );
  if (missing.length > 0) {
    throw new Error(
      `sources reference ${section}.* keys missing from BOTH languages: ${missing.join(", ")}`
    );
  }
}

/* ---- whole-catalog parity (recursive leaves — the 2823 method) ---- */
function leaves(node: Record<string, unknown>): number {
  let n = 0;
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") {
      n += leaves(value as Record<string, unknown>);
    } else {
      n += 1;
    }
  }
  return n;
}
const enLeaves = leaves(en);
const hiLeaves = leaves(hi);
if (enLeaves !== hiLeaves) {
  throw new Error(`catalog leaf parity broken: en ${enLeaves} vs hi ${hiLeaves}`);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `e-invoice i18n merged: +${Object.keys(en.einv).length} einv keys and ` +
    `+${Object.keys(en.p2e).length} p2e keys ×2 ` +
    `(required: ${required.length}, source literals: einv ${literals.get("einv")?.size} + p2e ${literals.get("p2e")?.size}), ` +
    `parity ${enLeaves} = ${hiLeaves} OK`
);
