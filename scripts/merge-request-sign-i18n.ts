/**
 * P9-F6B merge: inserts the NEW "rsign" section (request-signature, the
 * 96th tool) into the shared catalogs. Verifies perfect en↔hi parity —
 * within the part and the whole catalogs (recursive leaf count, the
 * 2823-baseline method) — refuses clobbering, checks the required
 * needFile/needName run-block contract, cross-checks that every "rsign.*"
 * literal referenced by the surface + recipient view exists in BOTH
 * languages, then rewrites src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-request-sign-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/request-signature/i18n.json`, "utf8")
);

const SECTION = "rsign";

/* ---- part parity + additive merge (clobber refusal) ---- */
{
  const enPatch = part.en?.[SECTION] ?? {};
  const hiPatch = part.hi?.[SECTION] ?? {};
  const flatEn = Object.keys(enPatch).sort();
  const flatHi = Object.keys(hiPatch).sort();
  if (JSON.stringify(flatEn) !== JSON.stringify(flatHi)) {
    const enOnly = flatEn.filter((k) => !(k in hiPatch));
    const hiOnly = flatHi.filter((k) => !(k in enPatch));
    throw new Error(
      `${SECTION}: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
    );
  }
  const existingEn = (en[SECTION] ?? {}) as Record<string, string>;
  const existingHi = (hi[SECTION] ?? {}) as Record<string, string>;
  // Re-runs may ADD keys but never CHANGE existing values (the clobber
  // guard — editing copy happens in the part file + this same check).
  for (const [k, v] of Object.entries(enPatch)) {
    if (k in existingEn && existingEn[k] !== v) {
      throw new Error(`refusing to change existing "${SECTION}.${k}" (en)`);
    }
  }
  for (const [k, v] of Object.entries(hiPatch)) {
    if (k in existingHi && existingHi[k] !== v) {
      throw new Error(`refusing to change existing "${SECTION}.${k}" (hi)`);
    }
  }
  en[SECTION] = { ...existingEn, ...enPatch };
  hi[SECTION] = { ...existingHi, ...hiPatch };
}

/* ---- required keys contract (the run-block keys) ---- */
const required = ["rsign.needFile", "rsign.needName"];
const missingRequired = required.filter((key) => {
  const leaf = key.split(".")[1];
  return !(leaf in en[SECTION]) || !(leaf in hi[SECTION]);
});
if (missingRequired.length > 0) {
  throw new Error(`required keys missing: ${missingRequired.join(", ")}`);
}

/* ---- every "rsign.*" literal in the new sources ---- */
const sources = [
  "tools/request-signature/surface.tsx",
  "tools/request-signature/recipient-view.tsx",
];
const literals = new Set<string>();
for (const rel of sources) {
  const src = readFileSync(`${root}${rel}`, "utf8");
  for (const m of src.matchAll(/"rsign\.([a-zA-Z0-9]+)"/g)) {
    literals.add(m[1]);
  }
}
const missing = [...literals].filter(
  (key) => !(key in en[SECTION]) || !(key in hi[SECTION])
);
if (missing.length > 0) {
  throw new Error(
    `sources reference ${SECTION}.* keys missing from BOTH languages: ${missing.join(", ")}`
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
  `request-sign i18n merged: +${Object.keys(en[SECTION]).length} ${SECTION} keys ×2 ` +
    `(required: ${required.length}, source literals: ${literals.size}), ` +
    `parity ${enLeaves} = ${hiLeaves} OK`
);
