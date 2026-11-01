/**
 * PHASE-3 batch 4 merge: inserts the pl / j2p / x2p / b2p / c2d error
 * sections into the shared catalogs. Idempotent.
 * Run: bun scripts/merge-p3b4-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const sections: string[] = ["pl"];

const part = JSON.parse(
  readFileSync(`${root}tools/pdf-layers/i18n.json`, "utf8")
);

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

for (const section of sections) {
  const enPatch = part.en?.[section] ?? {};
  const hiPatch = part.hi?.[section] ?? {};
  const enKeys = leafKeys(enPatch);
  const hiKeys = leafKeys(hiPatch);
  if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
    console.error(`✗ ${section}: en/hi leaf mismatch`);
    console.error(`  en: ${JSON.stringify(enKeys)}`);
    console.error(`  hi: ${JSON.stringify(hiKeys)}`);
    process.exit(1);
  }
  if (en[section] !== undefined || hi[section] !== undefined) {
    console.log(`= "${section}" already present (skipped)`);
    continue;
  }
  en[section] = enPatch;
  hi[section] = hiPatch;
  console.log(`+ "${section}" (${enKeys.length} leaves ×2)`);
}

writeFileSync(`${root}src/i18n/en.json`, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(`${root}src/i18n/hi.json`, `${JSON.stringify(hi, null, 2)}\n`);
console.log(`after: en=${leafKeys(en).length} hi=${leafKeys(hi).length}`);
