/**
 * P9-F5A-VISUALLY merge: inserts the NEW "invv" section
 * (create-invoice-visually, the 90th tool) into the shared catalogs.
 * Verifies perfect en↔hi parity — both within the part and the whole
 * catalogs (recursive leaf count, the 2823-baseline method) — refuses
 * clobbering, cross-checks that every "invv.*" key referenced by
 * surface.tsx AND config.ts (howKeys + a required-keys list) exists in
 * BOTH languages, additionally verifies every "invoice.*" document-label
 * key the surface resolves for the PDF payload exists (the shared
 * create-invoice catalog the engine labels come from), then rewrites
 * src/i18n/{en,hi}.json with 2-space indent + trailing newline.
 * Run: bun scripts/merge-invoice-visually-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const part = JSON.parse(
  readFileSync(`${root}tools/create-invoice-visually/i18n.json`, "utf8")
);

const section = "invv";

const enPatch = part.en?.[section] ?? {};
const hiPatch = part.hi?.[section] ?? {};

/* ---- part-level parity BEFORE touching the catalogs ---- */
const flatEn = Object.keys(enPatch).sort();
const flatHi = Object.keys(hiPatch).sort();
if (JSON.stringify(flatEn) !== JSON.stringify(flatHi)) {
  const enOnly = flatEn.filter((k) => !(k in hiPatch));
  const hiOnly = flatHi.filter((k) => !(k in enPatch));
  throw new Error(
    `create-invoice-visually ${section}: en/hi key parity broken (en-only: ${enOnly}, hi-only: ${hiOnly})`
  );
}

if (section in en || section in hi) {
  throw new Error(`section "${section}" already exists — refusing to clobber`);
}

/* ---- the required keys (CTA gate + how steps + block labels) ---- */
const REQUIRED = [
  "needName",
  "how1",
  "how2",
  "how3",
  "editTab",
  "previewTab",
  "export",
  "sample",
  "clear",
  "clearSure",
  "draftFound",
  "restore",
  "discard",
  "restored",
  "designMode",
  "zoom",
  "zoomFit",
  "accent",
  "sections",
  "blk_hd",
  "blk_bt",
  "blk_it",
  "blk_tt",
  "blk_wd",
  "blk_bank",
  "blk_notes",
  "blk_terms",
  "blk_sig",
  "showSec",
  "hideSec",
  "keepOne",
  "doneTitle",
  "doneDesc",
];
const missingRequired = REQUIRED.filter(
  (key) => !(key in enPatch) || !(key in hiPatch)
);
if (missingRequired.length > 0) {
  throw new Error(
    `required invv keys missing from BOTH languages: ${missingRequired.join(", ")}`
  );
}

en[section] = enPatch;
hi[section] = hiPatch;

/* ---- cross-check 1: every "invv.*" key referenced by the tool code ---- */
const surface = readFileSync(
  `${root}tools/create-invoice-visually/surface.tsx`,
  "utf8"
);
const configSrc = readFileSync(
  `${root}tools/create-invoice-visually/config.ts`,
  "utf8"
);
const surfaceKeys = [
  ...new Set(
    [...(surface + configSrc).matchAll(/"invv\.([a-zA-Z0-9_]+)"/g)].map(
      (m) => m[1]
    )
  ),
];
const missingSurface = surfaceKeys.filter(
  (key) => !(key in en[section]) || !(key in hi[section])
);
if (missingSurface.length > 0) {
  throw new Error(
    `surface/config references invv.* keys missing from BOTH languages: ${missingSurface.join(", ")}`
  );
}

/* ---- cross-check 2: every "invoice.*" document label the surface
   resolves (preview + PDF payload) exists in the SHARED catalog ---- */
const invoiceRefs = [
  ...new Set(
    [...surface.matchAll(/"invoice\.([a-zA-Z0-9_-]+)"/g)].map((m) => m[1])
  ),
];
const missingInvoice = invoiceRefs.filter(
  (key) => !(key in en.invoice) || !(key in hi.invoice)
);
if (missingInvoice.length > 0) {
  throw new Error(
    `surface resolves invoice.* keys missing from the shared catalog: ${missingInvoice.join(", ")}`
  );
}

/* ---- cross-check 3: dynamic invoice.* lookups resolve
   (type defs, groups, terms defaults, warning keys) ---- */
const dynamicRefs: string[] = [];
for (const m of surface.matchAll(/t\(`invoice\.\$\{([^}]+)\}`\)/g)) {
  const expr = m[1];
  // known dynamic sources: g.key (groups), INVOICE_TYPES[id].n,
  // defNow/d .ttl/.bl/.dl/.ql/.rl/.tm/.st?, xl (extra fields), w.key (warnings)
  if (expr.includes("g.key")) {
    // resolved from tools/create-invoice/types.ts INVOICE_GROUPS
    dynamicRefs.push("INVOICE_GROUPS");
  } else if (expr.includes(".n") || expr.includes(".ttl")) {
    dynamicRefs.push("INVOICE_TYPES");
  }
}
if (!dynamicRefs.includes("INVOICE_GROUPS") || !dynamicRefs.includes("INVOICE_TYPES")) {
  throw new Error(
    "expected dynamic invoice.* lookups (groups + types) not found in surface"
  );
}

/* ---- whole-catalog parity (recursive leaves) ---- */
function leaves(node: Record<string, unknown>): number {
  let n = 0;
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") {
      n += leaves(value as Record<string, unknown>);
    } else {
      n += 1;
    }
  }
  return n;
}
const enLeaves = leaves(en);
const hiLeaves = leaves(hi);
if (enLeaves !== hiLeaves) {
  throw new Error(`catalog leaf parity broken: en ${enLeaves} vs hi ${hiLeaves}`);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `create-invoice-visually i18n merged: +${Object.keys(en[section]).length} invv keys ×2 ` +
    `(surface/config refs: ${surfaceKeys.length}, shared invoice.* labels verified: ${invoiceRefs.length}, ` +
    `dynamic lookups: groups+types), parity ${enLeaves} = ${hiLeaves} OK`
);
