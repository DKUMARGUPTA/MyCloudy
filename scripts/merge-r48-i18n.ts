/**
 * R48 merge: adds `tool.errorNothingToDo` (shared by reverse-pdf-pages,
 * booklet-pdf, combine-single-page and sanitize-pdf — the honest "nothing
 * to do" refusal) to both catalogs. Idempotent re-runs.
 * Run: bun scripts/merge-r48-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch = {
  en: {
    errorNothingToDo:
      "There's nothing to do for this file — try a document with more pages, or pick at least one option.",
  },
  hi: {
    errorNothingToDo:
      "इस फ़ाइल के लिए कुछ करना नहीं है — ज़्यादा पेज वाला दस्तावेज़ लें, या कम से कम एक विकल्प चुनें।",
  },
};

const leafKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      out.push(...leafKeys(v as Record<string, unknown>, key));
    } else {
      out.push(key);
    }
  }
  return out.sort();
};

console.log(`before: en=${leafKeys(en).length} hi=${leafKeys(hi).length}`);

for (const [key, value] of Object.entries(patch.en)) {
  if (en.tool[key] !== undefined) {
    console.log(`= tool.${key} already present (skipped)`);
    continue;
  }
  en.tool[key] = value;
  hi.tool[key] = patch.hi[key];
  console.log(`+ tool.${key} (en+hi)`);
}

const afterEn = leafKeys(en);
const afterHi = leafKeys(hi);
if (JSON.stringify(afterEn) !== JSON.stringify(afterHi)) {
  console.error("✗ whole-catalog parity broken");
  process.exit(1);
}
writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`after: en=${afterEn.length} hi=${afterHi.length} — parity OK`);
