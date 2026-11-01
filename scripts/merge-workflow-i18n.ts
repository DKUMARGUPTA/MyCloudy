/**
 * PHASE-6 merge: inserts the wf (workflow-builder) section into the shared
 * catalogs. Idempotent. Run: bun scripts/merge-workflow-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/workflow-builder/i18n.json`, "utf8")
);
const enPatch = part.en?.wf ?? {};
const hiPatch = part.hi?.wf ?? {};

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

const enKeys = leafKeys(enPatch);
const hiKeys = leafKeys(hiPatch);
if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
  console.error("✗ workflow-builder: en/hi leaf mismatch in \"wf\"");
  console.error(`  en: ${JSON.stringify(enKeys)}`);
  console.error(`  hi: ${JSON.stringify(hiKeys)}`);
  process.exit(1);
}
if (en.wf !== undefined || hi.wf !== undefined) {
  console.log('= "wf" already present (skipped)');
  process.exit(0);
}
en.wf = enPatch;
hi.wf = hiPatch;

writeFileSync(`${root}src/i18n/en.json`, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(`${root}src/i18n/hi.json`, `${JSON.stringify(hi, null, 2)}\n`);

const afterEn = leafKeys(en).length;
const afterHi = leafKeys(hi).length;
console.log(`after: en=${afterEn} hi=${afterHi} (+${enKeys.length} wf.* keys)`);
if (afterEn !== afterHi) {
  console.error("✗ catalog parity broken");
  process.exit(1);
}
console.log("✓ wf section merged (en = hi)");
