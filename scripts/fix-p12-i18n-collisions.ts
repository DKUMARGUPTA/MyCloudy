/**
 * P12 collision fix: four keys were defined BOTH as label strings and as
 * parent objects of child keys (bugs.category vs bugs.category.bug etc.)
 * — JSON cannot hold both, so the label leaves were silently overwritten
 * by the child objects during merge-p12 (3344+148=3492 expected, 3488
 * observed = exactly the 4 lost leaves). Also adds auth.logout which the
 * header dropdown uses but no catalog had.
 *
 * Fix: introduce distinct *Label keys; component t() calls updated in the
 * same change. Additive + parity-verifying like every merge script.
 * Run: bun scripts/fix-p12-i18n-collisions.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch: Record<string, Record<"en" | "hi", string>> = {
  "bugs.categoryLabel": { en: "Type", hi: "प्रकार" },
  "bugs.severityLabel": { en: "Severity", hi: "गंभीरता" },
  "bugs.toolLabel": { en: "Tool (optional)", hi: "टूल (वैकल्पिक)" },
  "admin.ann.variantLabel": { en: "Style", hi: "शैली" },
  "auth.logout": { en: "Log out", hi: "लॉग आउट" },
};

for (const [dotted, values] of Object.entries(patch)) {
  const parts = dotted.split(".");
  const section = parts[0];
  if (typeof en[section] !== "object" || en[section] === null) {
    throw new Error(`section "${section}" missing in en`);
  }
  if (typeof hi[section] !== "object" || hi[section] === null) {
    throw new Error(`section "${section}" missing in hi`);
  }
  // Walk to the PARENT of the leaf (creates intermediate sections).
  let enNode: Record<string, unknown> = en[section];
  let hiNode: Record<string, unknown> = hi[section];
  for (let i = 1; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof enNode[k] !== "object" || enNode[k] === null) enNode[k] = {};
    if (typeof hiNode[k] !== "object" || hiNode[k] === null) hiNode[k] = {};
    enNode = enNode[k] as Record<string, unknown>;
    hiNode = hiNode[k] as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  if (typeof enNode[key] !== "undefined") {
    throw new Error(`en.${dotted} already exists — refusing to clobber`);
  }
  if (typeof hiNode[key] !== "undefined") {
    throw new Error(`hi.${dotted} already exists — refusing to clobber`);
  }
  enNode[key] = values.en;
  hiNode[key] = values.hi;
}

function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? leaves(v, prefix ? `${prefix}.${k}` : k)
      : [prefix ? `${prefix}.${k}` : k]
  );
}
const enLeaves = leaves(en).sort();
const hiLeaves = leaves(hi).sort();
if (enLeaves.length !== hiLeaves.length) {
  throw new Error(`parity broken: en=${enLeaves.length} hi=${hiLeaves.length}`);
}
for (let i = 0; i < enLeaves.length; i++) {
  if (enLeaves[i] !== hiLeaves[i]) {
    throw new Error(`parity key mismatch: ${enLeaves[i]} vs ${hiLeaves[i]}`);
  }
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`Collision fix merged: +${Object.keys(patch).length} → ${enLeaves.length} = ${hiLeaves.length} leaves (expect 3493)`);
