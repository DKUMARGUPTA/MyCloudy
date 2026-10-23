/**
 * RB7 merge (the FINAL batch): inserts the pa (pdf-to-pdfa) + vpa
 * (validate-pdfa) sections into the shared catalogs. Idempotent re-runs.
 * Run: bun scripts/merge-rb7-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const parts: Array<{ file: string; section: string }> = [
  { file: "pdf-to-pdfa", section: "pa" },
  { file: "validate-pdfa", section: "vpa" },
];

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

for (const { file, section } of parts) {
  const part = JSON.parse(readFileSync(`${root}tools/${file}/i18n.json`, "utf8"));
  const enPatch = part.en?.[section] ?? {};
  const hiPatch = part.hi?.[section] ?? {};
  const enKeys = leafKeys(enPatch);
  const hiKeys = leafKeys(hiPatch);
  if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
    console.error(`✗ ${file}: en/hi leaf mismatch in "${section}"`);
    process.exit(1);
  }
  if (en[section] !== undefined || hi[section] !== undefined) {
    console.log(`= ${file}: "${section}" already present (skipped)`);
    continue;
  }
  en[section] = enPatch;
  hi[section] = hiPatch;
  console.log(`+ ${file}: "${section}" (${enKeys.length} leaves ×2)`);
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
