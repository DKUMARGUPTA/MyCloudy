/**
 * P12 integration merge: tool-maintenance empty-state keys (tool-view
 * gating when an admin disables a tool). Additive + parity-verifying.
 * Run: bun scripts/merge-p12b-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch: Record<string, Record<"en" | "hi", string>> = {
  "tool.maintenanceTitle": {
    en: "Temporarily unavailable",
    hi: "अस्थायी रूप से अनुपलब्ध",
  },
  "tool.maintenanceDesc": {
    en: "This tool is under maintenance right now. Please check back in a little while.",
    hi: "यह टूल अभी रखरखाव में है। कृपया थोड़ी देर बाद फिर आएँ।",
  },
};

for (const [dotted, values] of Object.entries(patch)) {
  const [section, key] = dotted.split(".");
  if (typeof en[section]?.[key] !== "undefined") {
    throw new Error(`en.${dotted} already exists — refusing to clobber`);
  }
  if (typeof hi[section]?.[key] !== "undefined") {
    throw new Error(`hi.${dotted} already exists — refusing to clobber`);
  }
  en[section][key] = values.en;
  hi[section][key] = values.hi;
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

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`P12b i18n merged: +${Object.keys(patch).length} → ${enLeaves.length} = ${hiLeaves.length}`);
