/**
 * P3-INVOICE merge: inserts the NEW "invoice" section (create-invoice,
 * 64th tool) into the shared catalogs. Verifies perfect en↔hi parity,
 * refuses clobbering, cross-checks every i18n key referenced by
 * tools/create-invoice/types.ts against BOTH catalogs (zero-mistake:
 * a typo'd key in the catalog can never reach the UI), then rewrites
 * src/i18n/{en,hi}.json.
 * Run: bun scripts/merge-invoice-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/create-invoice/i18n.json`, "utf8")
);

const section = "invoice";

const enPatch = part.en?.[section] ?? {};
const hiPatch = part.hi?.[section] ?? {};
if (
  JSON.stringify(Object.keys(enPatch).sort()) !==
  JSON.stringify(Object.keys(hiPatch).sort())
) {
  const enOnly = Object.keys(enPatch).filter((k) => !(k in hiPatch));
  const hiOnly = Object.keys(hiPatch).filter((k) => !(k in enPatch));
  throw new Error(
    `create-invoice: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
  );
}

if (section in en || section in hi) {
  throw new Error(`section "${section}" already exists — refusing to clobber`);
}

en[section] = enPatch;
hi[section] = hiPatch;

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

/* ---- cross-check: every key types.ts references must resolve -------- */
const { INVOICE_TYPES, INVOICE_GROUPS } = await import(
  `${root}tools/create-invoice/types.ts`
);

const referenced = new Set<string>();
for (const def of Object.values<any>(INVOICE_TYPES)) {
  referenced.add(def.n);
  referenced.add(def.ttl);
  for (const x of def.x ?? []) if (x) referenced.add(x);
  for (const k of [def.tm, def.bl, def.ql, def.rl, def.dl]) if (k) referenced.add(k);
}
for (const g of INVOICE_GROUPS) referenced.add(g.key);

const missing = [...referenced].filter(
  (k) => !(k in enPatch) || !(k in hiPatch)
);
if (missing.length) {
  throw new Error(
    `create-invoice: types.ts references keys missing from the catalog: ${missing.join(", ")}`
  );
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `create-invoice i18n merged: +${Object.keys(enPatch).length} keys ×2 (types.ts cross-check: ${referenced.size} referenced keys OK), parity ${enFlat} = ${hiFlat}`
);
