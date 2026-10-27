/**
 * P11 UI/UX overhaul merge: adds the new hero stats-row keys and the
 * footer made-in/version keys into the EXISTING "hero" and "footer"
 * sections (additive-only — refuses to overwrite existing keys, refuses
 * duplicate runs, verifies en↔hi leaf parity on both the patch and the
 * whole catalogs after merge).
 * Run: bun scripts/merge-p11-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

/* ---- the P11 patch (additive to existing sections) ---- */
const patch: Record<string, Record<"en" | "hi", string>> = {
  "hero.statTools": { en: "Tools", hi: "टूल्स" },
  "hero.statCategories": { en: "Categories", hi: "श्रेणियाँ" },
  "hero.statLanguages": { en: "Languages", hi: "भाषाएँ" },
  "hero.statOnDevice": { en: "On-device", hi: "डिवाइस पर" },
  "hero.statAriaLabel": {
    en: "Key facts at a glance",
    hi: "एक नज़र में मुख्य बातें",
  },
  "footer.madeIn": {
    en: "Proudly made in India",
    hi: "गर्व से, भारत में बना",
  },
  "footer.versionLabel": { en: "Version", hi: "संस्करण" },
};

/* ---- key-by-key additive merge with clobber refusal ---- */
for (const [dotted, values] of Object.entries(patch)) {
  const [section, key] = dotted.split(".");
  if (!en[section] || !hi[section]) {
    throw new Error(`section "${section}" missing in one catalog`);
  }
  if (typeof en[section][key] !== "undefined") {
    throw new Error(`en.${dotted} already exists — refusing to clobber`);
  }
  if (typeof hi[section][key] !== "undefined") {
    throw new Error(`hi.${dotted} already exists — refusing to clobber`);
  }
  en[section][key] = values.en;
  hi[section][key] = values.hi;
}

/* ---- whole-catalog parity (recursive leaf count) ---- */
function leaves(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? leaves(v).map((x) => `${k}.${x}`) : [k]
  );
}
const enLeaves = leaves(en).sort();
const hiLeaves = leaves(hi).sort();
if (enLeaves.length !== hiLeaves.length) {
  throw new Error(
    `parity broken after merge: en=${enLeaves.length} hi=${hiLeaves.length}`
  );
}
for (let i = 0; i < enLeaves.length; i++) {
  if (enLeaves[i] !== hiLeaves[i]) {
    throw new Error(`parity key mismatch: ${enLeaves[i]} vs ${hiLeaves[i]}`);
  }
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`P11 i18n merged: ${enLeaves.length} = ${hiLeaves.length} leaves OK`);
