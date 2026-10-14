/**
 * One-shot merge of the P4.1 per-tool i18n sections into the shared
 * catalogs (the P3.14 imgconv/lock/... precedent). Verifies PERFECT
 * en↔hi parity per tool + no key clobbering, then rewrites
 * src/i18n/{en,hi}.json atomically.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOOLS = [
  "pages-per-sheet",
  "halve-pdf-pages",
  "flatten-pdf",
  "rasterize-pdf",
  "extract-images",
  "search-pdf",
  "txt-to-pdf",
  "markdown-to-pdf",
];

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

let added = 0;
for (const tool of TOOLS) {
  const part = JSON.parse(
    readFileSync(`${root}tools/${tool}/i18n.json`, "utf8")
  );
  const sections = Object.keys(part.en);
  const hiSections = Object.keys(part.hi);
  if (JSON.stringify(sections) !== JSON.stringify(hiSections)) {
    throw new Error(`${tool}: en/hi section mismatch`);
  }
  for (const section of sections) {
    const enKeys = Object.keys(part.en[section]).sort();
    const hiKeys = Object.keys(part.hi[section]).sort();
    if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
      throw new Error(
        `${tool}/${section}: key parity broken\n  en:${enKeys}\n  hi:${hiKeys}`
      );
    }
    if (section in en || section in hi) {
      throw new Error(`${tool}/${section}: section already exists in catalog`);
    }
    en[section] = part.en[section];
    hi[section] = part.hi[section];
    added += enKeys.length;
    console.log(`  + ${section} (${enKeys.length} keys) from ${tool}`);
  }
}

// Whole-catalog parity re-check.
const enAll = Object.keys(en).sort();
const hiAll = Object.keys(hi).sort();
if (JSON.stringify(enAll) !== JSON.stringify(hiAll)) {
  throw new Error("catalog section drift after merge");
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`merged ${added} keys across ${TOOLS.length} tools — OK`);
