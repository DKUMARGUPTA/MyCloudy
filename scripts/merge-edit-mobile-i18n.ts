/**
 * P8.6 merge: adds the mobile/multi-select/rotation/autosave keys into
 * the EXISTING "editPdf" section of the shared catalogs (the
 * merge-edit-forms precedent). Verifies perfect en↔hi parity, refuses
 * clobbering (existing keys must match verbatim, except the explicit
 * ALLOW_UPDATE whitelist for intentional copy changes), then rewrites
 * src/i18n/{en,hi}.json atomically.
 *
 * Run: bun scripts/merge-edit-mobile-i18n.ts
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
/** Keys whose copy intentionally changed in P8.6 (logged, not errors). */
const ALLOW_UPDATE = new Set(["hintSelect"]);
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
  } else {
    en[section][key] = enPatch[key];
    hi[section][key] = hiPatch[key];
    added += 1;
  }
}

for (const key of Object.keys(hiPatch)) {
  if (!(key in en[section])) {
    throw new Error(`hi-only key after merge: ${section}.${key}`);
  }
}

writeFileSync(`${root}src/i18n/en.json`, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(`${root}src/i18n/hi.json`, `${JSON.stringify(hi, null, 2)}\n`);

const enTotal = Object.keys(en).length;
const hiTotal = Object.keys(hi).length;
console.log(
  `edit-pdf mobile (P8.6): +${added} keys, ${verified} verified, ${updated} updated — catalogs ${enTotal}/${hiTotal} top-level sections`
);
