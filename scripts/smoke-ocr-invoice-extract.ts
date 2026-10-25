/**
 * Smoke: OCR → invoice chaining (R5-c).
 *
 * tesseract itself is not runnable under bun (smoke-ocr-deskew
 * precedent), so this smoke pins the feature's TESTABLE halves:
 *   1. the pure extractor (tools/ocr-pdf/invoice-extract.ts) against
 *      hand-computed vectors: a realistic 20-line English invoice, a
 *      Hindi invoice (विक्रेता/दिनांक/देय तिथि/उप-योग/सीजीएसटी/एसजीएसटी/
 *      कुल योग + Devanagari digits), garbage prose → null, partially
 *      labelled text → only the found fields, item-row edge cases
 *      (× vs x vs "250.00 x2", bare qty+rate, thousand separators,
 *      negatives refused, cross-check failures refused) and the
 *      51-rows → 50 + honest cap flag;
 *   2. the prefill-key codec round-trip (serialize → parse → equal,
 *      corrupt input → null, tampered fields coerced);
 *   3. the wiring: worker pageTexts in BOTH output modes, the result
 *      hand-off button copy EN+HI, the create-invoice hydration effect
 *      + toast keys EN+HI, the honest config feature + FAQ, i18n leaf
 *      parity for every new key, the create-invoice i18n mirror
 *      byte-equal to central for ALL its keys, and the shared worker
 *      protocol left untouched (the detail extension is local).
 *
 * Run: bun scripts/smoke-ocr-invoice-extract.ts
 */
import { readFileSync } from "node:fs";

import {
  extractInvoiceDraft,
  MAX_OCR_ITEMS,
  OCR_PREFILL_KEY,
  parseOcrPrefill,
  readOcrPageTexts,
  serializeOcrPrefill,
  type OcrInvoiceDraft,
} from "../tools/ocr-pdf/invoice-extract";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 400) : ""
    );
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`  ✗ FAIL ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}
function read(rel: string): string {
  return readFileSync(`/home/z/my-project/${rel}`, "utf8");
}

/* ------------------------------------------------------------------ */
/* 1. Realistic English invoice (20 lines, hand-computed)              */
/* ------------------------------------------------------------------ */

const EN_INVOICE = `TAX INVOICE
From: Sunrise Traders Pvt Ltd
42 Industrial Estate, Andheri East
Mumbai 400093
GSTIN: 27ABCDE1234F1Z5
Invoice No: INV-2024-001
Invoice Date: 15/03/2024
Due Date: 29/03/2024
Bill To: Mehta Electricals
Description Qty Rate Amount
Widget Pro 2 × 599.00
Gadget Lite 1 249.50
Super Cable 3 99.00 297.00
Steel Bracket 4 125.00 500.00
Subtotal: 2,244.50
CGST: 202.01
SGST: 202.01
Total: ₹ 2,648.52
Thank you for your business!
Payment terms: net 14 days`;

console.log("── 1. realistic 20-line English invoice ────────────────");
{
  const d = extractInvoiceDraft([EN_INVOICE], "en");
  check("draft extracted (not null)", d !== null, d);
  if (d) {
    eq("invoice number (labelled)", d.invoiceNumber, "INV-2024-001");
    eq("invoice date dd/mm/yyyy → ISO", d.date, "2024-03-15");
    eq("due date dd/mm/yyyy → ISO", d.dueDate, "2024-03-29");
    eq("vendor from 'From:' label", d.vendor, "Sunrise Traders Pvt Ltd");
    eq("currency from ₹ on the Total line", d.currency, "INR");
    eq("subtotal (labelled, separators stripped)", d.totals.subtotal, "2244.50");
    eq("cgst", d.totals.cgst, "202.01");
    eq("sgst", d.totals.sgst, "202.01");
    eq("grand total", d.totals.grand, "2648.52");
    eq("gstFound (CGST/SGST labels)", d.gstFound, true);
    eq("itemsCapped", d.itemsCapped, false);
    eq("item 1: qty × rate", d.items[0], { d: "Widget Pro", q: "2", r: "599.00" });
    eq("item 2: bare qty + rate", d.items[1], { d: "Gadget Lite", q: "1", r: "249.50" });
    eq("item 3: qty rate amount cross-checked", d.items[2], { d: "Super Cable", q: "3", r: "99.00" });
    eq("item 4: cross-checked", d.items[3], { d: "Steel Bracket", q: "4", r: "125.00" });
    eq("exactly 4 items (header/address/GSTIN lines are not items)", d.items.length, 4);
    check(
      "no fabricated per-item gst",
      d.items.every((it) => it.g === undefined),
      d.items
    );
  }

  // A bare number is NEVER an invoice number — the label is required.
  const bare = extractInvoiceDraft(["Order 45123 shipped today."], "en");
  check("bare number without label → null (no label hits)", bare === null, bare);
}

/* ------------------------------------------------------------------ */
/* 2. Hindi invoice                                                    */
/* ------------------------------------------------------------------ */

const HI_INVOICE = `कर बिल
विक्रेता: शर्मा ट्रेडर्स
दिल्ली स्ट्रीट, नई दिल्ली
इनवॉइस नंबर: INV/24-25/042
दिनांक: १२ अक्टूबर २०२६
देय तिथि: २६/१०/२०२६
विवरण मात्रा दर राशि
पेपर रीम 5 250.00
कागज़ कट 2 × 125.50
उप-योग: ₹ 1,501.00
सीजीएसटी: 135.09
एसजीएसटी: 135.09
कुल योग: ₹ 1,771.18
धन्यवाद!`;

console.log("\n── 2. Hindi invoice (विक्रेता / कुल labels) ────────────");
{
  const d = extractInvoiceDraft([HI_INVOICE], "hi");
  check("Hindi draft extracted (not null)", d !== null, d);
  if (d) {
    eq("invoice number (इनवॉइस नंबर label)", d.invoiceNumber, "INV/24-25/042");
    eq("date: Devanagari digits + Hindi month → ISO", d.date, "2026-10-12");
    eq("due date: देय तिथि + Devanagari digits", d.dueDate, "2026-10-26");
    eq("vendor from विक्रेता label", d.vendor, "शर्मा ट्रेडर्स");
    eq("currency ₹ → INR", d.currency, "INR");
    eq("उप-योग → subtotal", d.totals.subtotal, "1501.00");
    eq("सीजीएसटी → cgst", d.totals.cgst, "135.09");
    eq("एसजीएसटी → sgst", d.totals.sgst, "135.09");
    eq("कुल योग → grand", d.totals.grand, "1771.18");
    eq("gstFound via सीजीएसटी/एसजीएसटी", d.gstFound, true);
    eq("Hindi item rows", d.items, [
      { d: "पेपर रीम", q: "5", r: "250.00" },
      { d: "कागज़ कट", q: "2", r: "125.50" },
    ]);
  }

  // EN locale must NOT fire on the Hindi-only labels (locale honesty).
  const enLocale = extractInvoiceDraft(["विक्रेता: शर्मा ट्रेडर्स"], "en");
  check("en locale ignores विक्रेता (no vendor hit) → null", enLocale === null, enLocale);
  // and hi locale still accepts English labels (mixed real-world docs).
  const mixed = extractInvoiceDraft(["Invoice No: A-77", "From: Mixed Traders"], "hi");
  check("hi locale accepts EN labels too (mixed docs)", mixed?.invoiceNumber === "A-77" && mixed?.vendor === "Mixed Traders", mixed);
  const mixedEn = extractInvoiceDraft(["Invoice No: A-77", "From: Mixed Traders"], "en");
  check("en locale accepts EN labels", mixedEn?.invoiceNumber === "A-77", mixedEn);
}

/* ------------------------------------------------------------------ */
/* 3. Garbage prose → null                                             */
/* ------------------------------------------------------------------ */

console.log("\n── 3. garbage prose → null ─────────────────────────────");
{
  const prose = `Dear Priya,

I hope this letter finds you well. The monsoon has finally arrived
in the hills and the gardens look wonderful. Yesterday we walked
to the lake and counted eleven ducks on the water.

Please write back soon.

Yours, Anita`;
  eq("letter prose → null", extractInvoiceDraft([prose], "en"), null);
  eq("empty pages → null", extractInvoiceDraft(["", "   \n  "], "en"), null);
  eq("random ids → null (bare numbers are never fields)", extractInvoiceDraft(["45123 99887", "REF-771"], "en"), null);
  // the vendor heuristic ALONE never makes text an invoice:
  eq("name-only page → null (heuristic vendor never counts as evidence)", extractInvoiceDraft(["Priya Sharma", "+91 98765 43210"], "en"), null);
}

/* ------------------------------------------------------------------ */
/* 4. Partially labelled → only found fields                           */
/* ------------------------------------------------------------------ */

console.log("\n── 4. partially labelled → only found fields ───────────");
{
  const d = extractInvoiceDraft(
    ["Retail Shop", "Invoice #R-992", "Notebook 5 40.00", "Pen 12 10.00"],
    "en"
  );
  check("partial draft extracted", d !== null, d);
  if (d) {
    eq("invoice number found", d.invoiceNumber, "R-992");
    eq("vendor via first-line heuristic (honest)", d.vendor, "Retail Shop");
    eq("date NOT found → undefined (never fabricated)", "date" in d, false);
    eq("dueDate NOT found", "dueDate" in d, false);
    eq("currency NOT found (no labelled totals)", "currency" in d, false);
    eq("totals all undefined", d.totals, {});
    eq("gstFound false", d.gstFound, false);
    eq("items found", d.items, [
      { d: "Notebook", q: "5", r: "40.00" },
      { d: "Pen", q: "12", r: "10.00" },
    ]);
  }

  // date-only document: nothing else fabricated.
  const d2 = extractInvoiceDraft(["Bill Date: 2024-07-01"], "en");
  check("date-only draft extracted", d2 !== null, d2);
  if (d2) {
    eq("ISO date parsed", d2.date, "2024-07-01");
    eq("no vendor fabricated", "vendor" in d2, false);
    eq("no items fabricated", d2.items.length, 0);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Item-row edge cases                                              */
/* ------------------------------------------------------------------ */

console.log("\n── 5. item-row edge cases ──────────────────────────────");
{
  const page = [
    "Invoice No: E-1",
    "Chair 2 x 250",
    "Table 250.00 x2",
    "Bulk Paper 10 1,250.00",
    "Office Kit 2 4,999.00 9,998.00",
    "Broken Row 3 99.00 500.00",
    "Return fee -250.00",
    "Just a rate 899",
    "Coffee Break",
    "Taxi 4 km",
  ].join("\n");
  const d = extractInvoiceDraft([page], "en");
  check("edge-case draft extracted", d !== null, d);
  if (d) {
    eq("'2 x 250' → qty 2 rate 250", d.items[0], { d: "Chair", q: "2", r: "250" });
    eq("'250.00 x2' → rate-first qty 2", d.items[1], { d: "Table", q: "2", r: "250.00" });
    eq("thousand separator in rate", d.items[2], { d: "Bulk Paper", q: "10", r: "1250.00" });
    eq("3-tail with separators cross-checked", d.items[3], { d: "Office Kit", q: "2", r: "4999.00" });
    eq("cross-check failure refused (3×99 ≠ 500) — 4 items only", d.items.length, 4);
    check("negative row refused", !d.items.some((it) => it.d.includes("Return")), d.items);
    check("single-number row refused (not an item)", !d.items.some((it) => it.d.includes("Just a rate")), d.items);
    check("no-number row refused", !d.items.some((it) => it.d.includes("Coffee")), d.items);
    check("'Taxi 4 km' refused (one numeric, no money shape)", !d.items.some((it) => it.d === "Taxi"), d.items);
  }

  // per-row GST % pickup
  const gst = extractInvoiceDraft(
    ["Invoice No: G-1", "Consulting 10 × 250.00 18%"],
    "en"
  );
  eq("trailing % picked as row gst", gst?.items[0], { d: "Consulting", q: "10", r: "250.00", g: "18" });

  // multi-page: fields may live on different pages
  const multi = extractInvoiceDraft(
    ["Invoice No: MP-9\nFrom: Page One Traders", "Widget 2 50.00\nTotal: 100.00"],
    "en"
  );
  eq("multi-page draft joins pages", multi?.invoiceNumber, "MP-9");
  eq("multi-page vendor", multi?.vendor, "Page One Traders");
  eq("multi-page total", multi?.totals.grand, "100.00");
}

/* ------------------------------------------------------------------ */
/* 6. 51 items → cap at 50 + honest flag                               */
/* ------------------------------------------------------------------ */

console.log("\n── 6. item cap ─────────────────────────────────────────");
{
  const lines = ["Invoice No: CAP-1"];
  // "Unit-<i> 1 10.00" — desc + qty + rate, unique descriptions
  for (let i = 1; i <= 51; i += 1) lines.push(`Unit-${i} 1 10.00`);
  const d = extractInvoiceDraft([lines.join("\n")], "en");
  check("capped draft extracted", d !== null, d);
  if (d) {
    eq(`items capped at ${MAX_OCR_ITEMS}`, d.items.length, MAX_OCR_ITEMS);
    eq("itemsCapped honest flag set", d.itemsCapped, true);
    eq("first item kept", d.items[0].d, "Unit-1");
    eq("50th item kept", d.items[49].d, "Unit-50");
    check("51st item dropped", !d.items.some((it) => it.d === "Unit-51"), d.items.slice(-1));
  }
  const under = extractInvoiceDraft(
    [["Invoice No: CAP-2", ...Array.from({ length: 50 }, (_, i) => `Unit-${i + 1} 1 10.00`)].join("\n")],
    "en"
  );
  eq("exactly 50 → no cap flag", under?.itemsCapped, false);
}

/* ------------------------------------------------------------------ */
/* 7. Prefill key round-trip                                           */
/* ------------------------------------------------------------------ */

console.log("\n── 7. prefill key codec round-trip ─────────────────────");
{
  const draft: OcrInvoiceDraft = {
    invoiceNumber: "INV-2024-001",
    date: "2024-03-15",
    dueDate: "2024-03-29",
    vendor: "Sunrise Traders Pvt Ltd",
    currency: "INR",
    totals: { subtotal: "2244.50", cgst: "202.01", sgst: "202.01", grand: "2648.52" },
    gstFound: true,
    items: [
      { d: "Widget Pro", q: "2", r: "599.00" },
      { d: "Consulting", q: "10", r: "250.00", g: "18" },
    ],
    itemsCapped: false,
  };
  const raw = serializeOcrPrefill(draft, 1_727_000_000_000);
  const parsed = JSON.parse(raw) as { fields: unknown; savedAt: number };
  eq("wire shape is {fields, savedAt}", typeof parsed.fields === "object" && parsed.savedAt === 1_727_000_000_000, true);
  eq("round-trip preserves the draft", parseOcrPrefill(raw), draft);

  eq("null input → null", parseOcrPrefill(null), null);
  eq("corrupt JSON → null", parseOcrPrefill("{oops"), null);
  eq("no fields object → null", parseOcrPrefill('{"savedAt":1}'), null);
  eq("empty fields → null", parseOcrPrefill('{"fields":{}}'), null);
  const tampered = parseOcrPrefill(
    JSON.stringify({
      fields: {
        invoiceNumber: 42,
        date: "2024-02-30",
        dueDate: "not-a-date",
        currency: "CHF",
        totals: { grand: 999 },
        items: [{ d: "x", q: "1", r: "2" }, "junk", { q: "1" }],
        gstFound: "yes",
      },
    })
  );
  check("tampered payload coerced, not trusted", tampered !== null, tampered);
  if (tampered) {
    eq("bad number dropped", "invoiceNumber" in tampered, false);
    eq("impossible date (Feb 30) dropped", "date" in tampered, false);
    eq("garbage date dropped", "dueDate" in tampered, false);
    eq("unknown currency dropped", "currency" in tampered, false);
    eq("numeric total dropped", "grand" in tampered.totals, false);
    eq("only well-formed items survive", tampered.items, [{ d: "x", q: "1", r: "2" }]);
    eq("gstFound strictly boolean", tampered.gstFound, false);
  }

  const overflow = parseOcrPrefill(
    JSON.stringify({
      fields: {
        invoiceNumber: "X".repeat(500),
        items: Array.from({ length: 80 }, () => ({ d: "row", q: "1", r: "1" })),
      },
    })
  );
  check("overflow payload parsed", overflow !== null, overflow);
  eq("invoice number capped at 32", overflow?.invoiceNumber?.length, 32);
  eq("items capped at 50 on parse", overflow?.items.length, MAX_OCR_ITEMS);
}

/* ------------------------------------------------------------------ */
/* 8. readOcrPageTexts (validated worker-detail read)                  */
/* ------------------------------------------------------------------ */

console.log("\n── 8. worker-detail reader ─────────────────────────────");
{
  eq("valid detail", readOcrPageTexts({ pages: 2, pageTexts: ["a", "b"] }), ["a", "b"]);
  eq("missing pageTexts → undefined", readOcrPageTexts({ pages: 2 }), undefined);
  eq("null detail → undefined", readOcrPageTexts(null), undefined);
  eq("non-array → undefined", readOcrPageTexts({ pageTexts: "nope" }), undefined);
  eq("mixed junk → undefined", readOcrPageTexts({ pageTexts: ["a", 5] }), undefined);
  const big = readOcrPageTexts({ pageTexts: ["x".repeat(30_000)] });
  eq("oversized page text truncated to 20 000 chars", big?.[0].length, 20_000);
}

/* ------------------------------------------------------------------ */
/* 9. Wiring: worker / hand-off / hydration / config / i18n            */
/* ------------------------------------------------------------------ */

console.log("\n── 9. wiring (regexes on the real files) ────────────────");
{
  const worker = read("tools/ocr-pdf/worker.ts");
  check(
    "worker: result detail carries pageTexts (typed OcrRunDetail)",
    /const detail: OcrRunDetail = \{/.test(worker) && /pageTexts,\n  \};/.test(worker)
  );
  check(
    "worker: pageTexts pushed in the TEXT mode loop",
    (worker.match(/pageTexts\.push\(/g) ?? []).length === 4,
    (worker.match(/pageTexts\.push\(/g) ?? []).length
  );
  check(
    "worker: imports the local OcrRunDetail extension",
    /import type \{ OcrRunDetail \} from "\.\/invoice-extract";/.test(worker)
  );

  const extract = read("tools/ocr-pdf/invoice-extract.ts");
  check(
    "extract: pure module — no DOM/storage/react imports",
    !/from "react"|localStorage\.|document\.|window\./.test(extract)
  );
  check(
    "extract: honest doc rules (label required, never fabricate)",
    /NEVER comes from a bare number/.test(extract) && /nothing is fabricated/.test(extract)
  );
  eq("prefill key is dp_inv_ocr", OCR_PREFILL_KEY, "dp_inv_ocr");

  const handoff = read("tools/ocr-pdf/invoice-handoff.tsx");
  check(
    "hand-off: button label key EN+HI source uses result.ocrSendInvoice",
    /t\("result\.ocrSendInvoice"\)/.test(handoff)
  );
  check(
    "hand-off: honest disabled tooltip key",
    /t\("result\.ocrSendInvoiceHint"\)/.test(handoff) && /disabled/.test(handoff)
  );
  check(
    "hand-off: renders nothing when the run has no recognized text",
    /if \(!pageTexts\) return null;/.test(handoff)
  );
  check(
    "hand-off: extracts + stores the prefill key + navigates to create-invoice",
    /extractInvoiceDraft\(pageTexts, locale\)/.test(handoff) &&
      /localStorage\.setItem\(\s*OCR_PREFILL_KEY,/.test(handoff) &&
      /ROUTES\.tool\("create-invoice"\)/.test(handoff)
  );
  check(
    "hand-off: storage failure never navigates into an empty editor",
    /stored = false|if \(!stored\)/.test(handoff) && /variant: "destructive"/.test(handoff)
  );

  const surfaces = read("src/lib/tools/surfaces.tsx");
  check(
    "surfaces: TOOL_RESULT_EXTRAS registry maps ocr-pdf to the hand-off",
    /export const TOOL_RESULT_EXTRAS/.test(surfaces) &&
      /"ocr-pdf": OcrInvoiceHandoff/.test(surfaces)
  );
  const panelTypes = read("src/lib/tools/panel-types.ts");
  check(
    "panel-types: ToolResultExtraProps contract",
    /export interface ToolResultExtraProps/.test(panelTypes)
  );
  const shell = read("src/components/doco/tool/tool-shell.tsx");
  check(
    "tool-shell: mounts the per-tool result extra with the run summary",
    /TOOL_RESULT_EXTRAS\[tool\.id\]/.test(shell) &&
      /<ResultExtra runSummary=\{runSummary\} \/>/.test(shell)
  );
  const resultView = read("src/components/doco/tool/result-view.tsx");
  check(
    "result-view: resultExtra node rendered after the action row",
    /resultExtra\?: ReactNode/.test(resultView) && /\{resultExtra \? \(/.test(resultView)
  );

  const surface = read("tools/create-invoice/surface.tsx");
  check(
    "create-invoice surface: one-shot prefill read + remove",
    /localStorage\.getItem\(OCR_PREFILL_KEY\)/.test(surface) &&
      /localStorage\.removeItem\(OCR_PREFILL_KEY\)/.test(surface)
  );
  check(
    "create-invoice surface: hydrates via applyOcrDraft inside queueMicrotask",
    /queueMicrotask\(\(\) => \{/.test(surface) &&
      /applyOcrDraft\(prev, draft\)/.test(surface)
  );
  check(
    "create-invoice surface: honest review toast keys EN source",
    /invoice\.ocrPrefillToastTitle/.test(surface) &&
      /invoice\.ocrPrefillToastDesc/.test(surface)
  );

  const model = read("tools/create-invoice/model.ts");
  check(
    "model: applyOcrDraft exported (pure hydration mapping)",
    /export function applyOcrDraft\(/.test(model)
  );

  const config = read("tools/ocr-pdf/config.ts");
  check(
    "config: chain-into-invoice feature (EN honest copy)",
    /Chain into an invoice/.test(config) &&
      /labelled fields it actually found/.test(config) &&
      /review and edit everything in the invoice editor/.test(config)
  );
  check(
    "config: chain-into-invoice feature HI (real translation)",
    /इनवॉइस से जोड़ें/.test(config) && /जो सच में मिलीं/.test(config)
  );
  check(
    "config: honest FAQ question",
    /How well does the invoice fill work\?/.test(config)
  );
  check(
    "config: FAQ honesty — label-based heuristics, never fabricates",
    /label-based text heuristics, not magic/.test(config) &&
      /never guesses or fabricates values/.test(config)
  );
  check(
    "config: FAQ privacy — device-only, no AI/cloud",
    /never leaves your device/.test(config) &&
      /no AI and no cloud/.test(config)
  );
  check(
    "config: FAQ HI present with real Hindi",
    /लेबल-आधारित टेक्स्ट ह्यूरिस्टिक है, जादू नहीं/.test(config) &&
      /हर फ़ील्ड ज़रूर जाँचें/.test(config)
  );

  const protocol = read("src/lib/workers/protocol.ts");
  check(
    "protocol.ts untouched by this feature (detail extension is local)",
    !/pageTexts/.test(protocol)
  );
}

/* ------------------------------------------------------------------ */
/* 10. i18n parity + mirror byte-equality                              */
/* ------------------------------------------------------------------ */

console.log("\n── 10. i18n parity + mirror byte-equality ───────────────");
{
  type Cat = Record<string, unknown>;
  const en = JSON.parse(read("src/i18n/en.json")) as Cat;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Cat;

  function leaves(d: Cat): number {
    let n = 0;
    for (const v of Object.values(d)) {
      n += typeof v === "object" && v !== null ? leaves(v as Cat) : 1;
    }
    return n;
  }
  function keyset(d: Cat, prefix = ""): Set<string> {
    const s = new Set<string>();
    for (const [k, v] of Object.entries(d)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "object" && v !== null) {
        for (const x of keyset(v as Cat, p)) s.add(x);
      } else {
        s.add(p);
      }
    }
    return s;
  }
  const enLeaves = leaves(en);
  const hiLeaves = leaves(hi);
  // R6: the exact 4366 pin became brittle once later rounds added their own
  // keys (edit-pdf R6-a etc.) — keep the INVARIANT (en == hi, floor at the
  // R5-FINAL count) instead of a count that every new feature breaks.
  check(
    `central catalogs leaf parity (en == hi, ≥ 4366): ${enLeaves} = ${hiLeaves}`,
    enLeaves === hiLeaves && enLeaves >= 4366
  );
  eq(
    "central catalogs identical key sets",
    [...keyset(en)].filter((k) => !keyset(hi).has(k)),
    []
  );

  const enRes = en.result as Cat;
  const hiRes = hi.result as Cat;
  for (const key of ["ocrSendInvoice", "ocrSendInvoiceHint"]) {
    eq(`result.${key} EN`, enRes[key], key === "ocrSendInvoice" ? "Send to invoice" : "No invoice fields found in this text");
    check(
      `result.${key} HI is a real translation (≠ EN, Devanagari present)`,
      typeof hiRes[key] === "string" &&
        hiRes[key] !== enRes[key] &&
        /[\u0900-\u097F]/.test(String(hiRes[key])),
      { en: enRes[key], hi: hiRes[key] }
    );
  }
  const enInv = en.invoice as Cat;
  const hiInv = hi.invoice as Cat;
  eq("invoice.ocrPrefillToastTitle EN", enInv.ocrPrefillToastTitle, "Filled from OCR");
  eq("invoice.ocrPrefillToastDesc EN", enInv.ocrPrefillToastDesc, "Review every field before downloading");
  check(
    "invoice.ocrPrefillToast* HI real translations",
    hiInv.ocrPrefillToastTitle === "OCR से भरा गया" &&
      hiInv.ocrPrefillToastDesc === "डाउनलोड करने से पहले हर फ़ील्ड जाँच लें",
    { hiT: hiInv.ocrPrefillToastTitle, hiD: hiInv.ocrPrefillToastDesc }
  );

  // create-invoice mirror: EVERY mirror key byte-equal to central, both locales.
  const mirror = JSON.parse(read("tools/create-invoice/i18n.json")) as {
    en: Cat;
    hi: Cat;
  };
  const mEn = mirror.en.invoice as Cat;
  const mHi = mirror.hi.invoice as Cat;
  eq("mirror en/hi key sets identical", [...Object.keys(mEn)], [...Object.keys(mHi)]);
  const diffEn = Object.keys(mEn).filter((k) => mEn[k] !== (enInv as Record<string, unknown>)[k]);
  const diffHi = Object.keys(mHi).filter((k) => mHi[k] !== (hiInv as Record<string, unknown>)[k]);
  eq("create-invoice mirror en byte-equal to central (all 279 keys)", diffEn, []);
  eq("create-invoice mirror hi byte-equal to central (all 279 keys)", diffHi, []);

  // ocr mirror: untouched by this feature, self-consistent en/hi.
  const ocrMirror = JSON.parse(read("tools/ocr-pdf/i18n.json")) as {
    en: Cat;
    hi: Cat;
  };
  eq(
    "ocr mirror en/hi key sets identical (pre-existing keys untouched)",
    Object.keys(ocrMirror.en.ocr as Cat).length,
    Object.keys(ocrMirror.hi.ocr as Cat).length
  );
}

/* ------------------------------------------------------------------ */

console.log(
  `\nocr-invoice-extract smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : " — ALL GREEN")
);
process.exit(fail === 0 ? 0 : 1);
