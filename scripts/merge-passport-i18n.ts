/**
 * TOOLS-B1-d merge: inserts the NEW "passportPhoto" section (passport-photo
 * tool) into the shared catalogs. Verifies perfect en↔hi parity, refuses
 * clobbering, then rewrites src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-passport-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/passport-photo/i18n.json`, "utf8")
);

const section = "passportPhoto";

const enPatch = part.en?.[section] ?? {};
const hiPatch = part.hi?.[section] ?? {};
if (
  JSON.stringify(Object.keys(enPatch).sort()) !==
  JSON.stringify(Object.keys(hiPatch).sort())
) {
  const enOnly = Object.keys(enPatch).filter((k) => !(k in hiPatch));
  const hiOnly = Object.keys(hiPatch).filter((k) => !(k in enPatch));
  throw new Error(
    `passport-photo: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
  );
}

if (section in en || section in hi) {
  throw new Error(`section "${section}" already exists — refusing to clobber`);
}

en[section] = enPatch;
hi[section] = hiPatch;

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
  `passport-photo i18n merged: +${Object.keys(enPatch).length} keys ×2, parity ${enFlat} = ${hiFlat} OK`
);
