/**
 * P8.3 merge: adds the new edit-pdf keys (existing-text editing + find &
 * replace) into the EXISTING "editPdf" section of the shared catalogs
 * (the annotate-pdf result-patch precedent). Verifies perfect en↔hi
 * parity, refuses clobbering (existing keys must match verbatim), then
 * rewrites src/i18n/{en,hi}.json atomically.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(readFileSync(`${root}tools/edit-pdf/i18n.json`, "utf8"));

const section = "editPdf";

const enPatch = part.en?.[section] ?? {};
const hiPatch = part.hi?.[section] ?? {};
if (
  JSON.stringify(Object.keys(enPatch).sort()) !==
  JSON.stringify(Object.keys(hiPatch).sort())
) {
  throw new Error("edit-pdf: en/hi key parity broken in the patch");
}

let added = 0;
let verified = 0;
let updated = 0;
/** Keys whose copy intentionally changed in P8.3 (logged, not errors). */
const ALLOW_UPDATE = new Set(["how2"]);
for (const key of Object.keys(enPatch)) {
  if (!(section in en) || !(section in hi)) {
    throw new Error(`catalog missing the ${section} section`);
  }
  if (key in en[section] || key in hi[section]) {
    if (en[section][key] !== enPatch[key] || hi[section][key] !== hiPatch[key]) {
      if (!ALLOW_UPDATE.has(key)) {
        throw new Error(
          `${section}.${key}: exists with different value — refusing to clobber`
        );
      }
      en[section][key] = enPatch[key];
      hi[section][key] = hiPatch[key];
      updated += 1;
      console.log(`  ~ ${section}.${key} (intentional copy update)`);
      continue;
    }
    verified += 1;
    continue;
  }
  en[section][key] = enPatch[key];
  hi[section][key] = hiPatch[key];
  added += 1;
  console.log(`  + ${section}.${key}`);
}

// Whole-catalog parity re-check.
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
  `edit-pdf P8.3 i18n merged: +${added} keys, ${verified} unchanged, parity ${enFlat} = ${hiFlat} OK`
);
