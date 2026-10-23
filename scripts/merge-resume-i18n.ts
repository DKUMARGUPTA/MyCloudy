/**
 * CR-66 merge: inserts the NEW "resume" section (create-resume, 66th
 * tool) into the shared catalogs. Verifies perfect en↔hi parity (both
 * within the part and the whole catalogs), refuses clobbering,
 * cross-checks that every "resume.*" key referenced by surface.tsx
 * (t() calls AND the static label maps) plus the config's howKeys
 * exists in BOTH languages, then rewrites src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-resume-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/create-resume/i18n.json`, "utf8")
);

const section = "resume";

const enPatch = part.en?.[section] ?? {};
const hiPatch = part.hi?.[section] ?? {};
if (
  JSON.stringify(Object.keys(enPatch).sort()) !==
  JSON.stringify(Object.keys(hiPatch).sort())
) {
  const enOnly = Object.keys(enPatch).filter((k) => !(k in hiPatch));
  const hiOnly = Object.keys(hiPatch).filter((k) => !(k in enPatch));
  throw new Error(
    `create-resume: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
  );
}

if (section in en || section in hi) {
  throw new Error(`section "${section}" already exists — refusing to clobber`);
}

/* ---- cross-check 1: every "resume.*" key referenced by surface.tsx ---- */
const surface = readFileSync(
  `${root}tools/create-resume/surface.tsx`,
  "utf8"
);
const surfaceKeys = [
  ...new Set(
    [...surface.matchAll(/"resume\.([a-zA-Z0-9]+)"/g)].map((m) => m[1])
  ),
];
const missingSurface = surfaceKeys.filter(
  (key) => !(key in enPatch) || !(key in hiPatch)
);
if (missingSurface.length > 0) {
  throw new Error(
    `surface.tsx references resume.* keys missing from BOTH languages: ${missingSurface.join(", ")}`
  );
}
const unusedPatch = Object.keys(enPatch).filter(
  (key) => !surfaceKeys.includes(key)
);

/* ---- cross-check 2: config howKeys exist ---- */
const howKeys = ["how1", "how2", "how3"];
const missingHow = howKeys.filter((k) => !(k in enPatch) || !(k in hiPatch));
if (missingHow.length > 0) {
  throw new Error(
    `config howKeys missing from BOTH languages: ${missingHow.join(", ")}`
  );
}

en[section] = enPatch;
hi[section] = hiPatch;

/* ---- whole-catalog parity ---- */
const enAll = Object.keys(en).sort();
const hiAll = Object.keys(hi).sort();
if (JSON.stringify(enAll) !== JSON.stringify(hiAll)) {
  throw new Error("catalog section drift after merge");
}
const enFlat = Object.keys(en).flatMap((s) => Object.keys(en[s])).length;
const hiFlat = Object.keys(hi).flatMap((s) => Object.keys(hi[s])).length;
if (enFlat !== hiFlat) {
  throw new Error(`catalog key parity broken: en ${enFlat} vs hi ${hiFlat}`);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `create-resume i18n merged: +${Object.keys(enPatch).length} keys ×2 (surface.tsx cross-check: ${surfaceKeys.length} keys${
    unusedPatch.length ? `, info: patch-only keys (toasts/labels): ${unusedPatch.join(", ")}` : ""
  }), parity ${enFlat} = ${hiFlat} OK`
);
