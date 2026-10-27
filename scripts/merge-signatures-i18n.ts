/**
 * P9-F6A-UI merge: inserts the NEW "dsig" + "vsig" sections (digital-
 * signature, #95 + verify-pdf-signatures, #97) into the shared catalogs.
 * Verifies perfect en↔hi parity — within both parts and the whole
 * catalogs (recursive leaf count, the 2823-baseline method) — refuses
 * clobbering, checks the required howKeys/needFile contract, cross-checks
 * that every "dsig.*" literal referenced by the surface exists in BOTH
 * languages (vsig has no surface — its literals live in the config's
 * howKeys, covered by the required list), then rewrites
 * src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-signatures-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const parts = [
  { section: "dsig", file: "tools/digital-signature/i18n.json" },
  { section: "vsig", file: "tools/verify-pdf-signatures/i18n.json" },
] as const;

/* ---- part parity + clobber refusal ---- */
for (const { section, file } of parts) {
  const part = JSON.parse(readFileSync(`${root}${file}`, "utf8"));
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
  if (flatEn.length === 0) {
    throw new Error(`${section}: empty section — nothing to merge`);
  }
  en[section] = enPatch;
  hi[section] = hiPatch;
}

/* ---- required keys contract (both configs' howKeys + the run-block keys) ---- */
const required = [
  "dsig.how1",
  "dsig.how2",
  "dsig.how3",
  "vsig.how1",
  "vsig.how2",
  "vsig.how3",
  "dsig.needFile",
  "dsig.needCert",
];
const missingRequired = required.filter((key) => {
  const [section, leaf] = key.split(".");
  return !(leaf in en[section]) || !(leaf in hi[section]);
});
if (missingRequired.length > 0) {
  throw new Error(`required keys missing: ${missingRequired.join(", ")}`);
}

/* ---- every "dsig.*" literal in the new surface ---- */
const sources = ["tools/digital-signature/surface.tsx"];
const literals = new Set<string>();
for (const rel of sources) {
  const src = readFileSync(`${root}${rel}`, "utf8");
  for (const m of src.matchAll(/"dsig\.([a-zA-Z0-9]+)"/g)) {
    literals.add(m[1]);
  }
}
const missing = [...literals].filter(
  (key) => !(key in en.dsig) || !(key in hi.dsig)
);
if (missing.length > 0) {
  throw new Error(
    `surface references dsig.* keys missing from BOTH languages: ${missing.join(", ")}`
  );
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
  `signature i18n merged: +${Object.keys(en.dsig).length} dsig keys and ` +
    `+${Object.keys(en.vsig).length} vsig keys ×2 ` +
    `(required: ${required.length}, surface literals: ${literals.size}), ` +
    `parity ${enLeaves} = ${hiLeaves} OK`
);
