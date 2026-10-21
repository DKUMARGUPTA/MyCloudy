/**
 * RB2 merge: inserts the NEW sections for the 4 office-conversion tools
 * (powerpoint-to-pdf / odt-to-pdf / rtf-to-pdf / html-to-pdf — tools
 * 71–74) into the shared catalogs. Verifies perfect en↔hi parity (both
 * within each part and the whole catalogs), refuses clobbering existing
 * sections, then rewrites src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-rb2-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const parts: Array<{ file: string; section: string }> = [
  { file: "powerpoint-to-pdf", section: "ppt" },
  { file: "odt-to-pdf", section: "odt" },
  { file: "rtf-to-pdf", section: "rtfp" },
  { file: "html-to-pdf", section: "html" },
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

const beforeEn = leafKeys(en).length;
const beforeHi = leafKeys(hi).length;
console.log(`before: en=${beforeEn} hi=${beforeHi}`);

for (const { file, section } of parts) {
  const part = JSON.parse(
    readFileSync(`${root}tools/${file}/i18n.json`, "utf8")
  );

  const enPatch = part.en?.[section] ?? {};
  const hiPatch = part.hi?.[section] ?? {};

  const enKeys = leafKeys(enPatch);
  const hiKeys = leafKeys(hiPatch);

  if (JSON.stringify(enKeys) !== JSON.stringify(hiKeys)) {
    const enOnly = enKeys.filter((k) => !hiKeys.includes(k));
    const hiOnly = hiKeys.filter((k) => !enKeys.includes(k));
    console.error(
      `✗ ${file}: en/hi leaf mismatch in section "${section}" (en-only: ${JSON.stringify(enOnly)}, hi-only: ${JSON.stringify(hiOnly)})`
    );
    process.exit(1);
  }

  if (en[section] !== undefined || hi[section] !== undefined) {
    console.error(
      `✗ ${file}: section "${section}" already exists in the catalog (refusing to clobber)`
    );
    process.exit(1);
  }

  en[section] = enPatch;
  hi[section] = hiPatch;
  console.log(
    `+ ${file}: section "${section}" (${enKeys.length} leaves ×2)`
  );
}

const afterEn = leafKeys(en);
const afterHi = leafKeys(hi);
if (JSON.stringify(afterEn) !== JSON.stringify(afterHi)) {
  const enOnly = afterEn.filter((k) => !afterHi.includes(k));
  const hiOnly = afterHi.filter((k) => !afterEn.includes(k));
  console.error(
    `✗ whole-catalog parity broken (en-only: ${JSON.stringify(enOnly.slice(0, 10))}, hi-only: ${JSON.stringify(hiOnly.slice(0, 10))})`
  );
  process.exit(1);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");

console.log(
  `after: en=${afterEn.length} hi=${afterHi.length} — parity OK, catalogs written`
);
