/**
 * P3-FORM merge: inserts the NEW "form" + "tpl" sections
 * (create-fillable-pdf-form, 65th tool) into the shared catalogs.
 * Verifies perfect en↔hi parity (both within the part and the whole
 * catalogs), refuses clobbering, cross-checks that every i18n key
 * referenced by templates.ts (nameKey/descKey/key/labelKey/optionKeys)
 * AND every "form.*" key referenced by surface.tsx exists in BOTH
 * languages, then rewrites src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-form-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

import { TEMPLATES } from "../tools/create-fillable-pdf-form/templates";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/create-fillable-pdf-form/i18n.json`, "utf8")
);

const sections = ["form", "tpl"] as const;

for (const section of sections) {
  const enPatch = part.en?.[section] ?? {};
  const hiPatch = part.hi?.[section] ?? {};

  const flatEn = Object.keys(enPatch).sort();
  const flatHi = Object.keys(hiPatch).sort();
  if (JSON.stringify(flatEn) !== JSON.stringify(flatHi)) {
    const enOnly = flatEn.filter((k) => !(k in hiPatch));
    const hiOnly = flatHi.filter((k) => !(k in enPatch));
    throw new Error(
      `create-fillable-pdf-form ${section}: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
    );
  }

  if (section in en || section in hi) {
    throw new Error(`section "${section}" already exists — refusing to clobber`);
  }

  en[section] = enPatch;
  hi[section] = hiPatch;
}

/* ---- cross-check 1: every key referenced by templates.ts ---- */
// The tpl section is NESTED (tpl.leave.name → en.tpl.leave.name — the app's
// t() walks dotted paths), so the check must descend instead of a flat `in`.
function hasDotted(obj: unknown, dotted: string): boolean {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (
      cur !== null &&
      typeof cur === "object" &&
      part in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return typeof cur === "string";
}
const templateKeys: string[] = [];
for (const tpl of TEMPLATES) {
  templateKeys.push(tpl.nameKey, tpl.descKey);
  for (const page of tpl.pages) {
    for (const el of page.elements) {
      if ("name" in el) {
        if (el.labelKey) templateKeys.push(el.labelKey);
        if (el.optionKeys) templateKeys.push(...el.optionKeys);
      } else if (el.key) {
        templateKeys.push(el.key);
      }
    }
  }
}
const missingTpl = templateKeys.filter(
  (key) =>
    !key.startsWith("tpl.") ||
    !hasDotted(hi.tpl, key.slice(4)) ||
    !hasDotted(en.tpl, key.slice(4))
);
if (missingTpl.length > 0) {
  throw new Error(
    `templates.ts references keys missing from BOTH languages: ${[
      ...new Set(missingTpl),
    ].join(", ")}`
  );
}

/* ---- cross-check 2: every "form.*" key referenced by surface.tsx ---- */
const surface = readFileSync(
  `${root}tools/create-fillable-pdf-form/surface.tsx`,
  "utf8"
);
const surfaceKeys = [
  ...new Set(
    [...surface.matchAll(/t\("form\.([a-zA-Z0-9]+)"/g)].map((m) => m[1])
  ),
];
const missingSurface = surfaceKeys.filter(
  (key) => !(key in en.form) || !(key in hi.form)
);
if (missingSurface.length > 0) {
  throw new Error(
    `surface.tsx references form.* keys missing from BOTH languages: ${missingSurface.join(", ")}`
  );
}

/* ---- whole-catalog parity ---- */
const enAll = Object.keys(en).sort();
const hiAll = Object.keys(hi).sort();
if (JSON.stringify(enAll) !== JSON.stringify(hiAll)) {
  throw new Error("catalog section drift after merge");
}
const enFlat = Object.keys(en).flatMap((s) => Object.keys(en[s])).length;
const hiFlat = Object.keys(hi).flatMap((s) => Object.keys(hi[s])).length;
if (enFlat !== hiFlat) {
  throw new Error(`catalog key parity broken: en ${enFlat} vs hi ${hiFlat}`);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `create-fillable-pdf-form i18n merged: +${Object.keys(en.form).length} form + ${Object.keys(en.tpl).length} tpl keys ×2 (templates.ts cross-check: ${new Set(templateKeys).size} keys, surface.tsx: ${surfaceKeys.length} keys), parity ${enFlat} = ${hiFlat} OK`
);
