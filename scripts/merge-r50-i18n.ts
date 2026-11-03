/**
 * R50 merge: adds the 5 new error keys used by the R50 tool batch
 * (bates-numbering / add-stamps / background-color / remove-blank-pages /
 * alternate-merge / add-page-labels) to both catalogs. Idempotent re-runs.
 * Run: bun scripts/merge-r50-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch = {
  en: {
    errorCustomTextEmpty:
      "Custom text is empty — type your stamp word, or pick a preset.",
    errorBadHex:
      "That hex color doesn't look right — use 6 digits, e.g. FFF3C4.",
    errorNeedTwoFiles:
      "This tool needs exactly two PDFs — add the second file first.",
    errorNoBlankFound:
      "No blank pages were found — this document is already clean.",
    errorAllBlank:
      "Every page in this document is blank — there would be nothing left to keep.",
  },
  hi: {
    errorCustomTextEmpty:
      "अपना टेक्स्ट ख़ाली है — अपना शब्द लिखें, या कोई प्रीसेट चुनें।",
    errorBadHex:
      "यह हेक्स रंग सही नहीं लगता — 6 अंक लिखें, जैसे FFF3C4।",
    errorNeedTwoFiles:
      "इस टूल को ठीक दो PDF चाहिए — पहले दूसरी फ़ाइल जोड़ें।",
    errorNoBlankFound:
      "कोई ख़ाली पेज नहीं मिला — यह दस्तावेज़ पहले से साफ़ है।",
    errorAllBlank:
      "इस दस्तावेज़ के सभी पेज ख़ाली हैं — बचाने के लिए कुछ बचता ही नहीं।",
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
  hi.tool[key] = patch.hi[key as keyof typeof patch.hi];
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
