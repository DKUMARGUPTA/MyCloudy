/**
 * R52 merge: adds the 3 new error keys used by the R52 tool batch
 * (pdfs-to-zip / rotate-custom / view-metadata / change-permissions) to
 * both catalogs. Idempotent re-runs.
 * Run: bun scripts/merge-r52-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch = {
  en: {
    errorPageTooLarge:
      "Rotating that page would exceed the PDF size limit — rotate a smaller page or split the file first.",
    errorOwnerPwShort:
      "The owner password needs at least 6 characters — or leave it empty.",
    errorPwChars:
      "AES-128 can't carry that password — use basic letters and digits, or switch to AES-256.",
  },
  hi: {
    errorPageTooLarge:
      "वह पेज घुमाने पर PDF की साइज़-सीमा पार हो जाती है — छोटा पेज घुमाएँ या पहले फ़ाइल स्प्लिट करें।",
    errorOwnerPwShort:
      "ओनर पासवर्ड कम से कम 6 अक्षरों का चाहिए — या ख़ाली छोड़ दें।",
    errorPwChars:
      "AES-128 वह पासवर्ड नहीं ले सकता — सादे अक्षर/अंक रखें, या AES-256 चुनें।",
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
