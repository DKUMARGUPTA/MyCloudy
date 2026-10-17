/**
 * One-shot merge of the annotate-pdf i18n section into the shared catalogs
 * (the merge-edit-pdf-i18n precedent): full-adds the "ann" section and
 * appends the result-chip key into the existing "result" section, with
 * perfect en↔hi parity and no key clobbering, then rewrites
 * src/i18n/{en,hi}.json atomically.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(readFileSync(`${root}tools/annotate-pdf/i18n.json`, "utf8"));

// 1. Full sections (everything except "result") must be new.
const sections = Object.keys(part.en).filter((s) => s !== "result");
const hiSections = Object.keys(part.hi).filter((s) => s !== "result");
if (JSON.stringify(sections) !== JSON.stringify(hiSections)) {
  throw new Error("annotate-pdf: en/hi section mismatch");
}
for (const section of sections) {
  const enKeys = Object.keys(part.en[section]).sort();
  const hiKeys = Object.keys(part.hi[section]).sort();
  if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
    throw new Error(
      `annotate-pdf/${section}: key parity broken\n  en:${enKeys}\n  hi:${hiKeys}`
    );
  }
  if (section in en || section in hi) {
    throw new Error(`annotate-pdf/${section}: section already exists in catalog`);
  }
  en[section] = part.en[section];
  hi[section] = part.hi[section];
  console.log(`  + ${section} (${enKeys.length} keys) from annotate-pdf`);
}

// 2. result-section key patch (the count chip).
const enPatch = part.en.result ?? {};
const hiPatch = part.hi.result ?? {};
if (
  JSON.stringify(Object.keys(enPatch).sort()) !==
  JSON.stringify(Object.keys(hiPatch).sort())
) {
  throw new Error("annotate-pdf/result: key parity broken");
}
for (const key of Object.keys(enPatch)) {
  if (key in en.result || key in hi.result) {
    throw new Error(`annotate-pdf/result.${key}: already exists in catalog`);
  }
  en.result[key] = enPatch[key];
  hi.result[key] = hiPatch[key];
  console.log(`  + result.${key} from annotate-pdf`);
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
  `annotate-pdf i18n merged: ${sections.length} section(s) + result patch, ${enFlat} = ${hiFlat} keys parity OK`
);
