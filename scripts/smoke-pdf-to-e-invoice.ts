/**
 * PRE-BUILD smoke test for PDF → e-invoice (RB5-c / RB5-FIN-c). Locks the
 * pure model, the CII (Factur-X / ZUGFeRD) summarizer and the REAL
 * on-device worker path before browser QA:
 *
 *  1. GSTIN — the official mod-36 checksum: a known-good real-world
 *     GSTIN, the smoke's own computed one, invalid-checksum / wrong
 *     length / format vectors, and the seller-then-buyer sniff.
 *  2. CURRENCY — symbol → ISO sniff (₹/€/$/£/¥), explicit ISO codes at
 *     high, the ambiguous "Rs." at low, honest misses.
 *  3. DATES — findDates across ≥6 format families (ISO, DD/MM/YYYY,
 *     DD-MM-YYYY, DD.MM.YYYY, DD-MMM-YYYY, full month, MMM DD, YYYY),
 *     invalid day/month/year rejections, labelled issue vs due dates
 *     (English AND Hindi), bare-date honesty.
 *  4. INVOICE NUMBER — labelled patterns (EN + Hindi), the canonical
 *     "Invoice #X" shape, stop-word and date-value rejections.
 *  5. TOTALS — the tie-break rules: LAST match wins, the
 *     largest-number sanity (a smaller later line drops to low), the
 *     grand<subtotal contradiction, qty/items noise lines.
 *  6. TAX LINES + LINE ITEMS — CGST/IGST/VAT rows with rates and
 *     amounts, greedy item rows, tax/total lines blocked, the 40-item
 *     cap.
 *  7. CONFIDENCE GRADING + LINE GROUPING — strong/labeled/loose chips
 *     with and without separators; the pinned pdf-to-word lesson (a
 *     whitespace-only pdf.js item is EXACTLY ONE space), gap→space,
 *     y-proximity splits, page/index provenance, the 4000-line cap.
 *  8. THE TINY XML PARSER — declarations, comments, DOCTYPE, CDATA,
 *     entities, self-closing tags, prefixed attributes, tolerant
 *     closes, oversize refusal, the accessors.
 *  9. CII SUMMARIZER — a real namespace-correct CrossIndustryInvoice
 *     built in-script (rsm/ram/udt prefixes, ExchangedDocumentContext,
 *     ExchangedDocument ID + IssueDateTime + TypeCode 380,
 *     SupplyChainTradeTransaction with the header Agreement / Delivery
 *     / Settlement, MonetarySummation, TradeTax, two
 *     IncludedSupplyChainTradeLineItems): field mapping with evidence
 *     snippets, BilledQuantity read from SpecifiedLineTradeDelivery,
 *     due date from SpecifiedTradePaymentTerms, the same file in
 *     default-namespace and custom-prefix variants (localName
 *     tolerance), and the honest non-CII / null cases.
 * 10. INVOICE JSON — the download body for both paths.
 * 11. WORKER-BOUNDARY COERCIONS — parseRunOptions, outputBaseName,
 *     sanitizeAttachmentName, looksLikeXml, pickXmlAttachment ranking,
 *     classifyError.
 * 12. REAL E2E PATH A — a PDF built with pdf-lib + attach() carrying
 *     the CII XML as "factur-x.xml", driven through the worker's own
 *     runWithPdfjs (pdf.js legacy in-process): pdf.js's
 *     getAttachments() DOES see pdf-lib attach()'d files
 *     (probe-verified) — the XML round-trips byte-exact and every
 *     field is summarized with its evidence.
 * 13. REAL E2E PATH A, /AF-only — the name tree deleted from the
 *     catalog (pdf.js then sees nothing) and the @cantoo /AF walk
 *     rescues the attachment: foundVia "af-walk".
 * 14. REAL E2E PATH B — a visual invoice PDF drawn with pdf-lib +
 *     fontkit Noto (₹ needs a font that carries it): "Invoice
 *     #INV-2026-042", "Date: 14/02/2026", "Total: ₹ 18,450.00",
 *     "GSTIN: <computed valid checksum>" → the worker extracts the
 *     text, groups lines and sniffs every field — values, confidences
 *     and source snippets asserted one by one.
 * 15. ERROR TAXONOMY (E2E) — @cantoo AES-256-encrypted →
 *     tool.errorEncrypted; garbage bytes → tool.errorCorrupt; a blank
 *     page (no XML, no text) → the honest peinv.errorNoInvoice; a
 *     3-page file under a 2-page cap reports truncated honestly.
 * 16. WIRING SANITY — config shape, registry def, i18n en/hi leaf
 *     parity, every referenced peinv.* key resolves (and none unused),
 *     worker source honesty (the pdf.js buffer copy, updateMetadata
 *     false, the peinv error code).
 *
 * Run: bun scripts/smoke-pdf-to-e-invoice.ts   (exit code = failures)
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDFDict,
  PDFDocument as CantooPDF,
  PDFName,
} from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  amountsIn,
  attrOf,
  buildInvoiceJson,
  childEl,
  classifyError,
  confidenceOf,
  currencySniff,
  dateSniff,
  decodeCiiDate,
  findAll,
  findDates,
  findEl,
  gstinChecksum,
  gstinSniff,
  gstinValidate,
  invoiceNumberSniff,
  lineItemsSniff,
  linesFromItems,
  localName,
  looksLikeXml,
  MAX_LINE_ITEMS,
  MAX_LINES,
  outputBaseName,
  parseRunOptions,
  parseXml,
  pickXmlAttachment,
  sanitizeAttachmentName,
  sniffInvoice,
  summarizeCii,
  taxLinesSniff,
  textOf,
  totalsSniff,
  vatSniff,
  XML_MAX_BYTES,
  type PdfTextItemInput,
  type RawAttachmentLike,
  type TextLine,
} from "../tools/pdf-to-e-invoice/model";
import { FIELD_KEYS } from "../tools/pdf-to-e-invoice/types";
import type {
  FieldHit,
  InvoiceSummary,
  PdfToEInvoiceDetail,
} from "../tools/pdf-to-e-invoice/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import type { PdfjsLike } from "../tools/pdf-to-e-invoice/worker";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 400) : ""
    );
  }
}

/** Single-line TextLine factory for the pure sniffers. */
function mkLines(...texts: string[]): TextLine[] {
  return texts.map((text, index) => ({ text, page: 1, index }));
}

/** Synthetic pdf.js item (the pdf-to-markdown smoke's factory shape). */
function item(
  str: string,
  x: number,
  y: number,
  size: number,
  width?: number
): PdfTextItemInput {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: width ?? str.length * size * 0.5,
  };
}

/** First ISO date in a text (null when none) — terse vector helper. */
function firstDate(text: string): string | null {
  return findDates(text)[0]?.iso ?? null;
}

/* ================================================================== */
console.log("── 1. GSTIN format + mod-36 checksum ────────────────────");
/* ================================================================== */

{
  const prefix = "27ABCDE1234F1Z";
  const checkChar = gstinChecksum(prefix);
  check(
    "gstinChecksum computes a base-36 check character for the 14-char prefix",
    typeof checkChar === "string" && checkChar.length === 1 && /[0-9A-Z]/.test(checkChar),
    checkChar
  );
  const computed = prefix + (checkChar ?? "");
  check(
    "the smoke's own computed GSTIN validates (checksum ok)",
    gstinValidate(computed).ok === true &&
      gstinValidate(computed).reason === "ok",
    gstinValidate(computed)
  );
  check(
    "known real-world GSTIN 27AAPFU0939F1ZV passes the checksum",
    gstinValidate("27AAPFU0939F1ZV").ok === true
  );
  check(
    "wrong check character → checksum reason",
    gstinValidate(prefix + ((checkChar === "5" ? "0" : "5")).toString())
      .reason === "checksum"
  );
  check(
    "14 chars → length reason",
    gstinValidate(prefix).reason === "length"
  );
  check(
    "16 chars → length reason",
    gstinValidate(`${prefix}05`).reason === "length"
  );
  check(
    "lowercase letters → format reason",
    gstinValidate("27abcde1234f1z5").reason === "format"
  );
  check(
    "letters where digits belong → format reason",
    gstinValidate("27ABCDEFGH1F1Z5").reason === "format"
  );
  check(
    "gstinChecksum: non-base-36 char → null",
    gstinChecksum("27ABCDE1234F1!") === null
  );
  check("gstinChecksum: wrong length → null", gstinChecksum("abc") === null);

  const twoDistinct = gstinSniff(
    mkLines("GSTIN: 27AAPFU0939F1ZV", "Buyer GSTIN: 29AAACR5055K1Z3")
  );
  check(
    "gstinSniff: first GSTIN → seller, second distinct → buyer (both high)",
    twoDistinct.seller?.value === "27AAPFU0939F1ZV" &&
      twoDistinct.seller.confidence === "high" &&
      twoDistinct.buyer?.value === "29AAACR5055K1Z3" &&
      twoDistinct.buyer.confidence === "high",
    twoDistinct
  );
  const sameTwice = gstinSniff(
    mkLines("GSTIN: 27AAPFU0939F1ZV", "GSTIN again: 27AAPFU0939F1ZV")
  );
  check(
    "gstinSniff: a repeated GSTIN never becomes the buyer",
    sameTwice.seller?.value === "27AAPFU0939F1ZV" && sameTwice.buyer === null
  );
  const broken = gstinSniff(mkLines("GSTIN: 27ABCDE1234F1Z5"));
  check(
    "gstinSniff: a checksum-failing GSTIN is still reported (low)",
    broken.seller?.value === "27ABCDE1234F1Z5" &&
      broken.seller.confidence === "low",
    broken
  );
  check("gstinSniff: no GSTIN anywhere → both null", gstinSniff(mkLines("no ids")).seller === null);
}

/* ================================================================== */
console.log("── 2. currency sniff (symbol → ISO) ─────────────────────");
/* ================================================================== */

{
  const cur = (text: string): [string, string] | null => {
    const hit = currencySniff(mkLines(text));
    return hit === null ? null : [hit.value, hit.confidence];
  };
  check("₹ → INR (medium)", cur("Total: ₹ 18,450.00")?.[0] === "INR" && cur("Total: ₹ 18,450.00")?.[1] === "medium");
  check("€ → EUR (medium)", cur("Price: € 9,99")?.[0] === "EUR" && cur("Price: € 9,99")?.[1] === "medium");
  check("$ → USD (medium)", cur("Total: $ 450.00")?.[0] === "USD" && cur("Total: $ 450.00")?.[1] === "medium");
  check("£ → GBP (medium)", cur("Amount: £ 75.00")?.[0] === "GBP" && cur("Amount: £ 75.00")?.[1] === "medium");
  check("¥ → JPY (medium)", cur("Subtotal: ¥ 3,000")?.[0] === "JPY" && cur("Subtotal: ¥ 3,000")?.[1] === "medium");
  check(
    "an explicit ISO code near a number wins at high",
    cur("Amount in EUR 1,234.56")?.[0] === "EUR" && cur("Amount in EUR 1,234.56")?.[1] === "high"
  );
  check(
    "trailing ISO code (… USD 20) is also high",
    cur("Grand total USD 20")?.[0] === "USD" && cur("Grand total USD 20")?.[1] === "high"
  );
  check(
    "the ambiguous \"Rs.\" spelling stays low",
    cur("Rs. 500 only")?.[0] === "INR" && cur("Rs. 500 only")?.[1] === "low"
  );
  check(
    "no currency evidence → null (never guessed)",
    currencySniff(mkLines("no money words here")) === null
  );
  const vat = vatSniff(mkLines("VAT ID: DE123456789"));
  check(
    "vatSniff: labelled EU VAT id (medium, evidence line)",
    vat?.value === "DE123456789" && vat?.confidence === "medium",
    vat
  );
  check(
    "vatSniff: a label with no value → null",
    vatSniff(mkLines("VAT: see the reverse side for details")) === null
  );
}

/* ================================================================== */
console.log("── 3. dates: findDates families + labelled sniffing ──────");
/* ================================================================== */

{
  check("ISO YYYY-MM-DD", firstDate("2026-02-14") === "2026-02-14");
  check("DD/MM/YYYY", firstDate("14/02/2026") === "2026-02-14");
  check("DD-MM-YYYY", firstDate("14-02-2026") === "2026-02-14");
  check("DD.MM.YYYY", firstDate("5.6.2026") === "2026-06-05");
  check("DD MMM YYYY", firstDate("14 Feb 2026") === "2026-02-14");
  check("DD full-month YYYY", firstDate("14 February 2026") === "2026-02-14");
  check("DD-MMM-YYYY", firstDate("14-Sep-2026") === "2026-09-14");
  check("MMM DD, YYYY", firstDate("Feb 14, 2026") === "2026-02-14");
  check("full month, no comma", firstDate("February 14 2026") === "2026-02-14");
  check("\"Sept\" spelling maps to 9", firstDate("Sept 5, 2026") === "2026-09-05");
  check("invalid day 32 → rejected", firstDate("32/01/2026") === null);
  check("invalid month 13 → rejected", firstDate("14/13/2026") === null);
  check("year 1899 → out of range", firstDate("14/02/1899") === null);
  check("2-digit year → no match (honest)", firstDate("14/02/26") === null);
  check(
    "two dates in one line, both normalized in order",
    JSON.stringify(findDates("From 01/02/2026 to 15/03/2026").map((d) => d.iso)) ===
      '["2026-02-01","2026-03-15"]'
  );

  const labelled = dateSniff(mkLines("Date: 14/02/2026"));
  check(
    "labelled issue date (medium, evidence line)",
    labelled.issue?.value === "2026-02-14" &&
      labelled.issue.confidence === "medium" &&
      labelled.issue.snippet === "Date: 14/02/2026" &&
      labelled.due === null,
    labelled
  );
  const dueOnly = dateSniff(mkLines("Due Date: 14/03/2026"));
  check(
    "a due-date line never feeds issue at medium (falls back low)",
    dueOnly.due?.value === "2026-03-14" &&
      dueOnly.due.confidence === "medium" &&
      dueOnly.issue?.value === "2026-03-14" &&
      dueOnly.issue.confidence === "low",
    dueOnly
  );
  const hindi = dateSniff(mkLines("दिनांक: 14/02/2026"));
  check(
    "Hindi दिनांक label → medium issue date",
    hindi.issue?.value === "2026-02-14" && hindi.issue.confidence === "medium",
    hindi
  );
  const both = dateSniff(
    mkLines("Invoice date: 01 Mar 2026", "Payment due 31 Mar 2026")
  );
  check(
    "issue + due from separate labelled lines",
    both.issue?.value === "2026-03-01" &&
      both.issue.confidence === "medium" &&
      both.due?.value === "2026-03-31" &&
      both.due.confidence === "medium",
    both
  );
  const bare = dateSniff(mkLines("14/02/2026"));
  check(
    "a bare date is reported low, never overclaimed",
    bare.issue?.value === "2026-02-14" && bare.issue.confidence === "low",
    bare
  );
  const none = dateSniff(mkLines("no dates at all"));
  check("no dates → issue and due both null", none.issue === null && none.due === null);
}

/* ================================================================== */
console.log("── 4. invoice-number patterns ────────────────────────────");
/* ================================================================== */

{
  const inv = (text: string): [string, string] | null => {
    const hit = invoiceNumberSniff(mkLines(text));
    return hit === null ? null : [hit.value, hit.confidence];
  };
  check(
    "\"Invoice No: 123\" → 123 (high)",
    inv("Invoice No: 123")?.[0] === "123" && inv("Invoice No: 123")?.[1] === "high"
  );
  check(
    "\"Invoice #INV-2026-042\" → INV-2026-042 (high)",
    inv("Invoice #INV-2026-042")?.[0] === "INV-2026-042" &&
      inv("Invoice #INV-2026-042")?.[1] === "high"
  );
  check(
    "\"Invoice No. 2026/07\" keeps the slash",
    inv("Invoice No. 2026/07")?.[0] === "2026/07" && inv("Invoice No. 2026/07")?.[1] === "high"
  );
  check(
    "Hindi \"इनवॉइस नंबर: AB-12\" → AB-12 (high)",
    inv("इनवॉइस नंबर: AB-12")?.[0] === "AB-12" && inv("इनवॉइस नंबर: AB-12")?.[1] === "high"
  );
  check(
    "\"Invoice Date: …\" never yields a number (stop word)",
    invoiceNumberSniff(mkLines("Invoice Date: 14/02/2026")) === null
  );
  check(
    "a date-shaped value is rejected as an invoice number",
    invoiceNumberSniff(mkLines("Invoice No. 2026-04-14")) === null
  );
  check(
    "no invoice word → null (nothing fished)",
    invoiceNumberSniff(mkLines("Receipt AB-99 thanks")) === null
  );
}

/* ================================================================== */
console.log("── 5. amounts + totals tie-break rules ───────────────────");
/* ================================================================== */

{
  check(
    "amountsIn: ₹ amount with grouping",
    JSON.stringify(amountsIn("Total: ₹ 18,450.00")) === '["18,450.00"]'
  );
  check(
    "amountsIn: bare numbers, leftmost→rightmost",
    JSON.stringify(amountsIn("100 - 200")) === '["100","200"]'
  );
  check("amountsIn: no numbers → []", amountsIn("none here").length === 0);

  const lastWins = totalsSniff(mkLines("Total: 100.00", "Total: 250.00"));
  check(
    "totals: LAST total-class line wins (medium)",
    lastWins.grandTotal?.value === "250.00" && lastWins.grandTotal.confidence === "medium",
    lastWins
  );
  const contradiction = totalsSniff(mkLines("Total: 500.00", "Total: 300.00"));
  check(
    "totals: a smaller later total drops to low (verify!)",
    contradiction.grandTotal?.value === "300.00" &&
      contradiction.grandTotal.confidence === "low",
    contradiction
  );
  const grandBelowSub = totalsSniff(
    mkLines("Sub Total: 900.00", "Total: 100.00")
  );
  check(
    "totals: grand < subtotal is flagged low",
    grandBelowSub.grandTotal?.value === "100.00" &&
      grandBelowSub.grandTotal.confidence === "low" &&
      grandBelowSub.lineTotal?.value === "900.00",
    grandBelowSub
  );
  const noise = totalsSniff(mkLines("Total quantity items 42"));
  check(
    "totals: qty/items noise lines never feed a total",
    noise.grandTotal === null,
    noise
  );
  const pair = totalsSniff(
    mkLines("Sub Total: 1,000.00", "Grand Total: 1,180.00")
  );
  check(
    "totals: subtotal + grand total, both medium",
    pair.lineTotal?.value === "1,000.00" &&
      pair.lineTotal.confidence === "medium" &&
      pair.grandTotal?.value === "1,180.00" &&
      pair.grandTotal.confidence === "medium",
    pair
  );
}

/* ================================================================== */
console.log("── 6. tax lines + greedy line items ──────────────────────");
/* ================================================================== */

{
  const cgst = taxLinesSniff(mkLines("CGST 9%: ₹ 81.00"));
  check(
    "tax line: CGST rate + amount + evidence",
    cgst.length === 1 &&
      cgst[0]?.type === "CGST" &&
      cgst[0]?.rate === "9" &&
      cgst[0]?.amount === "81.00" &&
      cgst[0]?.sourceSnippet === "CGST 9%: ₹ 81.00",
    cgst
  );
  const vat = taxLinesSniff(mkLines("VAT 20% 45.00"));
  check(
    "tax line: VAT rate + amount",
    vat.length === 1 && vat[0]?.type === "VAT" && vat[0]?.rate === "20" && vat[0]?.amount === "45.00",
    vat
  );
  const rateOnly = taxLinesSniff(mkLines("GST @ 18%"));
  check(
    "tax line: rate without an amount is honest (empty amount)",
    rateOnly.length === 1 && rateOnly[0]?.type === "GST" && rateOnly[0]?.rate === "18" && rateOnly[0]?.amount === "",
    rateOnly
  );
  check(
    "tax line: no rate → not a tax hit",
    taxLinesSniff(mkLines("VAT registration applies")).length === 0
  );

  const row = lineItemsSniff(
    mkLines("Steel bracket heavy duty 2 1,200.00 2,400.00")
  );
  check(
    "line item: description + qty + unit price + amount",
    row.length === 1 &&
      row[0]?.description === "Steel bracket heavy duty" &&
      row[0]?.qty === "2" &&
      row[0]?.unitPrice === "1200.00" &&
      row[0]?.amount === "2400.00",
    row
  );
  check(
    "line items: tax summary lines are blocked",
    lineItemsSniff(mkLines("IGST 18%: ₹ 2,814.41")).length === 0
  );
  check(
    "line items: total lines are blocked",
    lineItemsSniff(mkLines("Sub Total: ₹ 15,635.59")).length === 0
  );
  const capRows: TextLine[] = Array.from({ length: 60 }, (_, i) => ({
    text: `Widget model ${i + 1} 2 10.00 20.00`,
    page: 1,
    index: i,
  }));
  check(
    "line items: capped at MAX_LINE_ITEMS",
    lineItemsSniff(capRows).length === MAX_LINE_ITEMS
  );
}

/* ================================================================== */
console.log("── 7. confidence grading + line grouping ────────────────");
/* ================================================================== */

{
  check(
    "confidence: strong pattern + separator → high",
    confidenceOf("Invoice No: 123", "strong") === "high"
  );
  check(
    "confidence: strong pattern without separator → medium",
    confidenceOf("Invoice 123", "strong") === "medium"
  );
  check(
    "confidence: labeled + separator → medium",
    confidenceOf("Date: 14/02/2026", "labeled") === "medium"
  );
  check(
    "confidence: labeled without separator → low",
    confidenceOf("Dated 14 Feb", "labeled") === "low"
  );
  check(
    "confidence: loose never upgrades past low",
    confidenceOf("Invoice No: 123", "loose") === "low"
  );

  const gap = linesFromItems([
    [
      item("Hello", 72, 100, 10, 25),
      item("world", 100, 100, 10, 25),
    ],
  ]);
  check(
    "line grouping: a horizontal gap becomes exactly one space",
    gap.length === 1 && gap[0]?.text === "Hello world",
    gap
  );
  const joined = linesFromItems([
    [
      item("Hel", 72, 100, 10, 15),
      item("lo", 87, 100, 10, 10),
    ],
  ]);
  check(
    "line grouping: zero gap joins with no space",
    joined.length === 1 && joined[0]?.text === "Hello",
    joined
  );
  const spaced = linesFromItems([
    [
      item("Some", 72, 100, 10, 20),
      item(" ", 92, 100, 10, 2),
      item("text", 95, 100, 10, 20),
    ],
  ]);
  check(
    "line grouping: a whitespace-only pdf.js item is EXACTLY ONE space",
    spaced.length === 1 && spaced[0]?.text === "Some text",
    spaced
  );
  const pages = linesFromItems([
    [item("line one", 72, 100, 10), item("line two", 72, 88, 10)],
    [item("page two text", 72, 100, 10)],
  ]);
  check(
    "line grouping: y split + page/index provenance",
    pages.length === 3 &&
      pages[0]?.page === 1 && pages[0]?.index === 0 &&
      pages[1]?.page === 1 && pages[1]?.index === 1 &&
      pages[2]?.page === 2 && pages[2]?.index === 0,
    pages
  );
  const nearY = linesFromItems([
    [item("a", 72, 100, 10), item("b", 74, 100, 10)],
  ]);
  check(
    "line grouping: y within half a font height joins one line",
    nearY.length === 1 && nearY[0]?.text === "ab",
    nearY
  );
  const many: PdfTextItemInput[] = [];
  for (let i = 0; i < MAX_LINES + 200; i += 1) {
    many.push(item(`row ${i}`, 72, 800 - 6 * i, 10));
  }
  check(
    "line grouping: MAX_LINES honesty cap",
    linesFromItems([many]).length === MAX_LINES
  );
}

/* ================================================================== */
console.log("── 8. the tiny XML parser + accessors ────────────────────");
/* ================================================================== */

{
  check("localName strips the prefix", localName("rsm:ID") === "ID");
  check("localName passes unprefixed names through", localName("ID") === "ID");

  const decl = parseXml(
    '<?xml version="1.0" encoding="UTF-8"?><!-- top comment --><!DOCTYPE rsm:CrossIndustryInvoice><root a="1"><child>text</child><empty/><skip x="9" /></root>'
  );
  check(
    "parser: declaration + comment + DOCTYPE tolerated, children parsed",
    decl !== null &&
      decl.local === "root" &&
      decl.children.length === 3 &&
      decl.attrs["a"] === "1" &&
      textOf(childEl(decl, "child")) === "text" &&
      (childEl(decl, "empty")?.children.length ?? 1) === 0,
    decl
  );
  const entities = parseXml("<r>M&amp;M &lt;tag&gt; &#65;&#x42;</r>");
  check(
    "parser: named + numeric entities decoded",
    textOf(entities) === "M&M <tag> AB",
    textOf(entities)
  );
  const cdata = parseXml("<r><![CDATA[a < b & c]]></r>");
  check("parser: CDATA kept raw", textOf(cdata) === "a < b & c", textOf(cdata));
  const prefixedAttr = parseXml('<r xmlns:x="urn:u" x:id="7"><c>1</c></r>');
  check(
    "parser + attrOf: prefixed attributes match on the local name",
    attrOf(prefixedAttr, "id") === "7",
    prefixedAttr?.attrs
  );
  const nested = parseXml("<root><mid><deep>1</deep></mid></root>");
  check(
    "accessors: findEl searches descendants, childEl is direct-only",
    findEl(nested, "deep") !== null &&
      childEl(nested, "deep") === null &&
      findAll(nested, "mid").length === 1 &&
      textOf(null) === "",
    nested
  );
  const tolerant = parseXml("<a><b>loose</b></a>");
  check(
    "parser: tolerant close keeps the tree readable",
    tolerant !== null && textOf(childEl(tolerant, "b")) === "loose"
  );
  check("parser: empty source → null", parseXml("") === null);
  check("parser: no tags at all → null", parseXml("plain text only") === null);
  check(
    "parser: oversize source refused (XML_MAX_BYTES)",
    parseXml(`<r>${"a".repeat(XML_MAX_BYTES)}</r>`) === null
  );
  const mismatched = parseXml("<a><b></a>");
  check(
    "parser: an unmatched close pops to the matching open (never throws)",
    mismatched !== null && mismatched.local === "a",
    mismatched
  );
}

/* ================================================================== */
console.log("── 9. CII summarizer field mapping ───────────────────────");
/* ================================================================== */

/**
 * A namespace-correct Factur-X / ZUGFeRD CrossIndustryInvoice, built
 * in three prefix styles (standard rsm/ram/udt, default namespace,
 * custom prefixes) — the summarizer must read all three identically
 * (local-name matching only).
 */
function buildCii(style: "prefixed" | "default" | "custom"): string {
  const p =
    style === "prefixed"
      ? { r: "rsm:", a: "ram:", u: "udt:" }
      : style === "custom"
        ? { r: "q:", a: "w:", u: "d:" }
        : { r: "", a: "", u: "" };
  const ns =
    style === "prefixed"
      ? ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"'
      : style === "custom"
        ? ' xmlns:q="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:w="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:d="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"'
        : ' xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"';
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p.r}CrossIndustryInvoice${ns}>
  <${p.r}ExchangedDocumentContext>
    <${p.a}GuidelineSpecifiedDocumentContextParameter>
      <${p.a}ID>urn:factur-x.eu:1p0:minimum</${p.a}ID>
    </${p.a}GuidelineSpecifiedDocumentContextParameter>
  </${p.r}ExchangedDocumentContext>
  <${p.r}ExchangedDocument>
    <${p.a}ID>INV-2026-042</${p.a}ID>
    <${p.a}IssueDateTime><${p.u}DateTimeString format="102">20260214</${p.u}DateTimeString></${p.a}IssueDateTime>
    <${p.a}TypeCode>380</${p.a}TypeCode>
  </${p.r}ExchangedDocument>
  <${p.r}SupplyChainTradeTransaction>
    <${p.a}IncludedSupplyChainTradeLineItem>
      <${p.a}AssociatedDocumentLineDocument><${p.a}LineID>1</${p.a}LineID></${p.a}AssociatedDocumentLineDocument>
      <${p.a}SpecifiedTradeProduct><${p.a}Name>Consulting service hours</${p.a}Name></${p.a}SpecifiedTradeProduct>
      <${p.a}SpecifiedLineTradeAgreement><${p.a}NetPriceProductTradePrice><${p.a}ChargeAmount>150.00</${p.a}ChargeAmount></${p.a}NetPriceProductTradePrice></${p.a}SpecifiedLineTradeAgreement>
      <${p.a}SpecifiedLineTradeDelivery><${p.a}BilledQuantity unitCode="HUR">10.00</${p.a}BilledQuantity></${p.a}SpecifiedLineTradeDelivery>
      <${p.a}SpecifiedLineTradeSettlement><${p.a}SpecifiedTradeSettlementLineMonetarySummation><${p.a}LineTotalAmount>1500.00</${p.a}LineTotalAmount></${p.a}SpecifiedTradeSettlementLineMonetarySummation></${p.a}SpecifiedLineTradeSettlement>
    </${p.a}IncludedSupplyChainTradeLineItem>
    <${p.a}IncludedSupplyChainTradeLineItem>
      <${p.a}AssociatedDocumentLineDocument><${p.a}LineID>2</${p.a}LineID></${p.a}AssociatedDocumentLineDocument>
      <${p.a}SpecifiedLineTradeAgreement><${p.a}NetPriceProductTradePrice><${p.a}ChargeAmount>70.00</${p.a}ChargeAmount></${p.a}NetPriceProductTradePrice></${p.a}SpecifiedLineTradeAgreement>
      <${p.a}SpecifiedLineTradeDelivery><${p.a}BilledQuantity unitCode="HUR">5</${p.a}BilledQuantity></${p.a}SpecifiedLineTradeDelivery>
      <${p.a}SpecifiedLineTradeSettlement><${p.a}SpecifiedTradeSettlementLineMonetarySummation><${p.a}LineTotalAmount>350.00</${p.a}LineTotalAmount></${p.a}SpecifiedTradeSettlementLineMonetarySummation></${p.a}SpecifiedLineTradeSettlement>
    </${p.a}IncludedSupplyChainTradeLineItem>
    <${p.a}ApplicableHeaderTradeAgreement>
      <${p.a}SellerTradeParty>
        <${p.a}Name>Musterh&#228;ndler GmbH &amp; Co. KG</${p.a}Name>
        <${p.a}SpecifiedTaxRegistration><${p.a}ID schemeID="VA">DE123456789</${p.a}ID></${p.a}SpecifiedTaxRegistration>
      </${p.a}SellerTradeParty>
      <${p.a}BuyerTradeParty>
        <${p.a}Name>Musterkunde AG</${p.a}Name>
        <${p.a}SpecifiedTaxRegistration><${p.a}ID schemeID="VA">DE987654321</${p.a}ID></${p.a}SpecifiedTaxRegistration>
      </${p.a}BuyerTradeParty>
    </${p.a}ApplicableHeaderTradeAgreement>
    <${p.a}ApplicableHeaderTradeDelivery/>
    <${p.a}ApplicableHeaderTradeSettlement>
      <${p.a}InvoiceCurrencyCode>EUR</${p.a}InvoiceCurrencyCode>
      <${p.a}SpecifiedTradePaymentTerms><${p.a}DueDateDateTime><${p.u}DateTimeString format="102">20260316</${p.u}DateTimeString></${p.a}DueDateDateTime></${p.a}SpecifiedTradePaymentTerms>
      <${p.a}ApplicableTradeTax>
        <${p.a}TypeCode>VAT</${p.a}TypeCode>
        <${p.a}RateApplicablePercent>19.00</${p.a}RateApplicablePercent>
        <${p.a}CalculatedAmount>351.50</${p.a}CalculatedAmount>
        <${p.a}CategoryCode>S</${p.a}CategoryCode>
      </${p.a}ApplicableTradeTax>
      <${p.a}SpecifiedTradeSettlementHeaderMonetarySummation>
        <${p.a}LineTotalAmount>1850.00</${p.a}LineTotalAmount>
        <${p.a}TaxBasisTotalAmount>1850.00</${p.a}TaxBasisTotalAmount>
        <${p.a}GrandTotalAmount>2201.50</${p.a}GrandTotalAmount>
      </${p.a}SpecifiedTradeSettlementHeaderMonetarySummation>
    </${p.a}ApplicableHeaderTradeSettlement>
  </${p.r}SupplyChainTradeTransaction>
</${p.r}CrossIndustryInvoice>`;
}

{
  const summary = summarizeCii(parseXml(buildCii("prefixed")));
  check(
    "CII: path A + root recognized",
    summary.path === "A" && summary.ciiRecognized === true
  );
  const values = new Map<string, string>(
    summary.fields.map((f) => [f.key, f.value])
  );
  check(
    "CII: all 12 fields mapped (ID, dates, currency, parties, tax ids, sums)",
    values.get("invoiceNumber") === "INV-2026-042" &&
      values.get("issueDate") === "2026-02-14" &&
      values.get("dueDate") === "2026-03-16" &&
      values.get("currency") === "EUR" &&
      values.get("sellerName") === "Musterhändler GmbH & Co. KG" &&
      values.get("buyerName") === "Musterkunde AG" &&
      values.get("sellerTaxId") === "DE123456789" &&
      values.get("buyerTaxId") === "DE987654321" &&
      values.get("lineCount") === "2" &&
      values.get("lineTotal") === "1850.00" &&
      values.get("taxBasisTotal") === "1850.00" &&
      values.get("grandTotal") === "2201.50",
    Object.fromEntries(values)
  );
  check(
    "CII: every field is high confidence with element evidence",
    summary.fields.length === 12 &&
      summary.fields.every((f) => f.confidence === "high") &&
      summary.fields.every((f) => f.sourceSnippet.length > 0) &&
      (summary.fields.find((f) => f.key === "invoiceNumber")?.sourceSnippet ===
        "<ram:ID>INV-2026-042</ram:ID>")
  );
  check(
    "CII: nothing is missing on the full sample",
    summary.missingKeys.length === 0,
    summary.missingKeys
  );
  check(
    "CII: taxes mapped (type, rate, amount, evidence)",
    summary.taxes.length === 1 &&
      summary.taxes[0]?.type === "VAT" &&
      summary.taxes[0]?.rate === "19.00" &&
      summary.taxes[0]?.amount === "351.50" &&
      summary.taxes[0]?.sourceSnippet.includes("type=VAT") &&
      summary.taxes[0]?.sourceSnippet.includes("rate=19.00"),
    summary.taxes
  );
  check(
    "CII: line items with BilledQuantity from SpecifiedLineTradeDelivery",
    summary.lineItems.length === 2 &&
      summary.lineItems[0]?.description === "Consulting service hours" &&
      summary.lineItems[0]?.qty === "10.00" &&
      summary.lineItems[0]?.unitPrice === "150.00" &&
      summary.lineItems[0]?.amount === "1500.00" &&
      summary.lineItems[1]?.description === "Line 2" &&
      summary.lineItems[1]?.qty === "5" &&
      summary.lineItems[1]?.amount === "350.00",
    summary.lineItems
  );

  const def = summarizeCii(parseXml(buildCii("default")));
  check(
    "CII: default-namespace variant reads the same (localName tolerance)",
    def.ciiRecognized === true &&
      new Map(def.fields.map((f) => [f.key, f.value])).get("invoiceNumber") ===
        "INV-2026-042" &&
      new Map(def.fields.map((f) => [f.key, f.value])).get("issueDate") ===
        "2026-02-14" &&
      new Map(def.fields.map((f) => [f.key, f.value])).get("grandTotal") ===
        "2201.50" &&
      def.lineItems[0]?.qty === "10.00",
    def.fields.map((f) => `${f.key}=${f.value}`)
  );
  const custom = summarizeCii(parseXml(buildCii("custom")));
  const customValues = new Map(custom.fields.map((f) => [f.key, f.value]));
  check(
    "CII: custom-prefix variant reads the same",
    customValues.get("sellerName") === "Musterhändler GmbH & Co. KG" &&
      customValues.get("buyerTaxId") === "DE987654321" &&
      customValues.get("dueDate") === "2026-03-16" &&
      customValues.get("lineCount") === "2" &&
      custom.missingKeys.length === 0,
    Object.fromEntries(customValues)
  );

  const notCii = summarizeCii(
    parseXml("<html><body><h1>Not an invoice</h1></body></html>")
  );
  check(
    "CII: a non-CII root is NOT recognized and reports every core field missing",
    notCii.ciiRecognized === false &&
      notCii.fields.length === 0 &&
      JSON.stringify([...notCii.missingKeys].sort()) ===
        JSON.stringify([...FIELD_KEYS].sort()),
    notCii.missingKeys
  );
  const nullDoc = summarizeCii(null);
  check(
    "CII: a null document is honest (no fields, all missing)",
    nullDoc.ciiRecognized === false &&
      nullDoc.fields.length === 0 &&
      nullDoc.missingKeys.length === FIELD_KEYS.length
  );

  check(
    "decodeCiiDate: format 102 (CCYYMMDD) → ISO",
    decodeCiiDate("20260214", "102") === "2026-02-14"
  );
  check(
    "decodeCiiDate: format 610 (CCYYMM) + passthrough",
    decodeCiiDate("202602", "610") === "2026-02" &&
      decodeCiiDate("2026-02-14", "") === "2026-02-14" &&
      decodeCiiDate("notadate", "102") === "notadate"
  );
}

/* ================================================================== */
console.log("── 10. invoice.json download body ────────────────────────");
/* ================================================================== */

{
  const summaryA = summarizeCii(parseXml(buildCii("prefixed")));
  summaryA.attachmentName = "factur-x.xml";
  summaryA.foundVia = "pdfjs";
  const jsonA = JSON.parse(buildInvoiceJson(summaryA, {})) as {
    extractedBy: string;
    extractionPath: string;
    attachment: string;
    ciiRecognized: boolean;
    fields: Record<string, { value: string; confidence: string; source: string }>;
    notFound: string[];
    taxes: { rate: string }[];
  };
  check(
    "json A: extractedBy DocoPDF + embedded-xml path + attachment",
    jsonA.extractedBy.includes("DocoPDF") &&
      jsonA.extractionPath === "embedded-xml" &&
      jsonA.attachment === "factur-x.xml" &&
      jsonA.ciiRecognized === true,
    jsonA
  );
  check(
    "json A: fields carry value + confidence + source evidence",
    jsonA.fields.invoiceNumber?.value === "INV-2026-042" &&
      jsonA.fields.invoiceNumber?.confidence === "high" &&
      jsonA.fields.invoiceNumber?.source.includes("<ram:ID>") &&
      jsonA.notFound.length === 0 &&
      jsonA.taxes[0]?.rate === "19.00"
  );

  const summaryB = sniffInvoice(
    mkLines("Invoice #T-1", "Date: 01/02/2026", "Total: ₹ 100.00"),
    1,
    false
  );
  const jsonB = JSON.parse(buildInvoiceJson(summaryB, { sourceName: "t.pdf" })) as {
    extractionPath: string;
    source: string;
    pagesRead: number;
    truncated: boolean;
    notice: string;
    fields: Record<string, { value: string }>;
  };
  check(
    "json B: best-effort path labeled, source + pages recorded",
    jsonB.extractionPath === "layout-sniff (best-effort — verify before use)" &&
      jsonB.source === "t.pdf" &&
      jsonB.pagesRead === 1 &&
      jsonB.truncated === false,
    jsonB
  );
  check(
    "json B: sniffed fields + verify-before-use notice",
    jsonB.fields.invoiceNumber?.value === "T-1" &&
      jsonB.fields.grandTotal?.value === "100.00" &&
      jsonB.notice.includes("verify before use")
  );
  const overridden = JSON.parse(
    buildInvoiceJson(summaryB, { notice: "custom notice" })
  ) as { notice: string };
  check("json B: notice override honored", overridden.notice === "custom notice");
}

/* ================================================================== */
console.log("── 11. worker-boundary coercions ─────────────────────────");
/* ================================================================== */

{
  check(
    "parseRunOptions: exact pass-through",
    JSON.stringify(parseRunOptions({ locale: "hi", fileWord: "इनवॉइस", maxPages: 5 })) ===
      '{"locale":"hi","fileWord":"इनवॉइस","maxPages":5}'
  );
  check(
    "parseRunOptions: defaults + cap + floor + locale coercion",
    JSON.stringify(parseRunOptions({})) ===
      '{"locale":"en","fileWord":"invoice","maxPages":20}' &&
      parseRunOptions({ maxPages: 999 }).maxPages === 20 &&
      parseRunOptions({ maxPages: 0 }).maxPages === 20 &&
      parseRunOptions({ maxPages: 2.7 }).maxPages === 2 &&
      parseRunOptions({ locale: "fr" }).locale === "en"
  );
  check(
    "parseRunOptions: control characters stripped from fileWord",
    parseRunOptions({ fileWord: "a\u0000b" }).fileWord === "ab"
  );

  check(
    "outputBaseName: pdf stripped, path-unsafe replaced, Devanagari kept",
    outputBaseName("Invoice 2026.pdf", "en", "invoice") === "Invoice 2026" &&
      outputBaseName("bad/name?:x.pdf", "en", "invoice") === "bad_name__x" &&
      outputBaseName("आधार.pdf", "hi", "bill") === "आधार"
  );
  check(
    "outputBaseName: empty falls back to the localized word",
    outputBaseName("  ", "en", "Bill") === "Bill" &&
      outputBaseName("", "hi", "") === "इनवॉइस" &&
      outputBaseName("", "en", "") === "invoice"
  );

  check(
    "sanitizeAttachmentName: path stripped, .xml enforced, fallback",
    sanitizeAttachmentName("dir/sub/factur-x.xml") === "factur-x.xml" &&
      sanitizeAttachmentName("zugferd-invoice") === "zugferd-invoice.xml" &&
      sanitizeAttachmentName("a\u20acb.xml") === "ab.xml" &&
      sanitizeAttachmentName("") === "factur-x.xml" &&
      sanitizeAttachmentName("../../etc/passwd") === "passwd.xml"
  );

  const xmlBytes = new TextEncoder().encode(
    '<?xml version="1.0"?><rsm:CrossIndustryInvoice/>'
  );
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check(
    "looksLikeXml: declaration, BOM + whitespace tolerated, binary rejected",
    looksLikeXml(xmlBytes) === true &&
      looksLikeXml(new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x0a, 0x3c, 0x72, 0x73, 0x6d, 0x3a])) === true &&
      looksLikeXml(new TextEncoder().encode("%PDF-1.7 binary junk")) === false &&
      looksLikeXml(new Uint8Array([0x3c, 0x72])) === false
  );
  const pick = (candidates: RawAttachmentLike[]): string | null =>
    pickXmlAttachment(candidates)?.name ?? null;
  check(
    "pickXmlAttachment: factur-x outranks zugferd outranks xrechnung",
    pick([
      { name: "notes.xml", bytes: xmlBytes },
      { name: "xrechnung-cii.xml", bytes: xmlBytes },
      { name: "zugferd-invoice.xml", bytes: xmlBytes },
      { name: "factur-x.xml", bytes: xmlBytes },
    ]) === "factur-x.xml" &&
      pick([{ name: "notes.xml", bytes: xmlBytes }, { name: "zugferd-invoice.xml", bytes: xmlBytes }]) ===
        "zugferd-invoice.xml" &&
      pick([{ name: "notes.xml", bytes: xmlBytes }, { name: "xrechnung.xml", bytes: xmlBytes }]) ===
        "xrechnung.xml"
  );
  check(
    "pickXmlAttachment: any .xml beats content-sniffed; non-XML never picked",
    pick([
      { name: "report.bin", bytes: xmlBytes },
      { name: "notes.xml", bytes: xmlBytes },
    ]) === "notes.xml" &&
      pick([{ name: "logo.png", bytes: pngBytes }]) === null &&
      pick([]) === null
  );

  check(
    "classifyError: password → errorEncrypted, anything else → errorCorrupt",
    classifyError("Password required to open the document") === "tool.errorEncrypted" &&
      classifyError("Invalid PDF structure") === "tool.errorCorrupt"
  );
}

/* ================================================================== */
console.log("── 12. REAL E2E Path A: pdf-lib attach() → worker ────────");
/* ================================================================== */

/* ---- the self shim FIRST, then the real worker module (house pattern) ---- */
const workerMessages: WorkerResponse[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (msg: unknown): void => {
  workerMessages.push(msg as WorkerResponse);
};
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
const {
  attachmentsFromPdfjs,
  runWithPdfjs,
} = await import("../tools/pdf-to-e-invoice/worker");

check(
  "worker: module loaded, onmessage registered",
  typeof workerGlobal.onmessage === "function"
);

{
  const xml = new TextEncoder().encode("<?xml version=\"1.0\"?><a/>");
  check(
    "attachmentsFromPdfjs: null / non-object → []",
    attachmentsFromPdfjs(null).length === 0 &&
      attachmentsFromPdfjs("nope").length === 0
  );
  const coerced = attachmentsFromPdfjs({
    named: { filename: "named.xml", content: xml },
    keyed: { content: xml },
    broken: { filename: "broken.xml", content: "not bytes" },
  });
  check(
    "attachmentsFromPdfjs: filename honored, key fallback, non-Uint8 dropped",
    coerced.length === 2 &&
      coerced[0]?.name === "named.xml" &&
      coerced[1]?.name === "keyed",
    coerced
  );
}

/** Drives the REAL worker pipeline in-process with pdf.js legacy. */
let driveCalls = 0;
async function drive(
  bytes: Uint8Array | null,
  name: string,
  opts: Record<string, unknown> = {}
): Promise<WorkerResponse> {
  const runId = 100 + driveCalls;
  driveCalls += 1;
  const files =
    bytes === null ? [] : [new File([bytes as BlobPart], name)];
  const before = workerMessages.length;
  await runWithPdfjs(
    {
      type: "run",
      runId,
      toolId: "pdf-to-e-invoice",
      options: { run: JSON.stringify(opts) },
      files,
    } as unknown as WorkerRunRequest,
    { getDocument } as unknown as PdfjsLike
  );
  const mine = workerMessages.slice(before).filter((m) => m.runId === runId);
  const done = mine.find((m) => m.type === "result" || m.type === "error");
  if (done === undefined) {
    throw new Error(`worker run ${runId} produced no result/error`);
  }
  return done;
}

/** Typed view of a result detail. */
function detailOf(res: WorkerResponse): PdfToEInvoiceDetail {
  if (res.type !== "result") throw new Error("not a result");
  return (res.detail ?? {}) as PdfToEInvoiceDetail;
}

const ciiText = buildCii("prefixed");
const ciiBytes = new TextEncoder().encode(ciiText);

{
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Invoice #INV-2026-042 (Factur-X PDF, embedded XML attached)", {
    x: 56,
    y: 780,
    size: 12,
    font: helv,
  });
  await doc.attach(ciiBytes, "factur-x.xml", {
    mimeType: "text/xml",
    description: "Factur-X Invoice",
    creationDate: new Date(2026, 1, 15),
    modificationDate: new Date(2026, 1, 15),
  });
  const bytesA = new Uint8Array(await doc.save());

  const res = await drive(bytesA, "sample-e-invoice.pdf");
  check(
    "E2E A: result posted (pdf.js sees the pdf-lib attachment — probe verdict)",
    res.type === "result",
    res.type === "error" ? res.code : "result"
  );
  if (res.type === "result") {
    const detail = detailOf(res);
    const summary = detail.summary;
    check(
      "E2E A: detail ePath A + foundVia pdfjs + attachment + CII recognized",
      detail.ePath === "A" &&
        summary?.path === "A" &&
        summary?.foundVia === "pdfjs" &&
        summary?.attachmentName === "factur-x.xml" &&
        summary?.ciiRecognized === true
    );
    check(
      "E2E A: all 12 fields found, nothing missing",
      detail.fieldsFound === 12 &&
        summary?.fields.length === 12 &&
        summary?.missingKeys.length === 0,
      { fieldsFound: detail.fieldsFound, missing: summary?.missingKeys }
    );
    const values = new Map<string, FieldHit>(
      (summary?.fields ?? []).map((f) => [f.key, f])
    );
    check(
      "E2E A: field values (invoice number, dates, currency, grand total)",
      values.get("invoiceNumber")?.value === "INV-2026-042" &&
        values.get("issueDate")?.value === "2026-02-14" &&
        values.get("dueDate")?.value === "2026-03-16" &&
        values.get("currency")?.value === "EUR" &&
        values.get("grandTotal")?.value === "2201.50",
      Object.fromEntries([...values].map(([k, f]) => [k, f.value]))
    );
    check(
      "E2E A: line items survive the round trip (qty from BilledQuantity)",
      summary?.lineItems.length === 2 &&
        summary.lineItems[0]?.qty === "10.00" &&
        summary.lineItems[1]?.qty === "5",
      summary?.lineItems
    );
    check(
      "E2E A: taxes summarized",
      summary?.taxes.length === 1 &&
        summary.taxes[0]?.type === "VAT" &&
        summary.taxes[0]?.amount === "351.50"
    );
    const out = res.outputs[0];
    check(
      "E2E A: output is factur-x.xml, application/xml",
      out?.name === "factur-x.xml" && out?.mime === "application/xml",
      out?.name
    );
    if (out) {
      const outBytes = new Uint8Array(await out.blob.arrayBuffer());
      check(
        "E2E A: the .xml round-trips BYTE-EXACT",
        outBytes.length === ciiBytes.length &&
          outBytes.every((b, i) => b === ciiBytes[i])
      );
    }
    const progress = workerMessages
      .filter((m) => m.type === "progress")
      .map((m) => (m as { pct: number; stage: string }).pct);
    const stages = workerMessages
      .filter((m) => m.type === "progress")
      .map((m) => (m as { stage: string }).stage);
    check(
      "E2E A: progress pcts 10/20/85 across reading/processing/saving",
      progress.includes(10) && progress.includes(20) && progress.includes(85) &&
        stages.includes("reading") && stages.includes("saving")
    );
    check(
      "E2E A: detail pages mirrors the document",
      detailOf(res).pages === 1
    );
  }

  /* ---------------- 13. /AF-only: the name tree is gone ------------ */
  console.log("── 13. REAL E2E Path A, /AF-only walk ─────────────────────");
  const afDoc = await CantooPDF.load(bytesA, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  (afDoc.catalog as unknown as PDFDict).delete(PDFName.of("Names"));
  const bytesAfOnly = new Uint8Array(await afDoc.save());
  {
    const probe = await getDocument({ data: bytesAfOnly.slice() }).promise;
    const seen = await probe.getAttachments();
    check(
      "AF-only fixture: pdf.js's name-tree read sees NOTHING (fallback genuinely needed)",
      seen === null || Object.keys(seen).length === 0,
      seen === null ? null : Object.keys(seen)
    );
    await probe.destroy();
  }
  const resAf = await drive(bytesAfOnly, "af-only.pdf");
  check(
    "E2E A (/AF-only): result via the raw catalog walk",
    resAf.type === "result",
    resAf.type === "error" ? resAf.code : "result"
  );
  if (resAf.type === "result") {
    const detail = detailOf(resAf);
    check(
      "E2E A (/AF-only): foundVia af-walk + same 12 fields",
      detail.summary?.foundVia === "af-walk" &&
        detail.summary?.attachmentName === "factur-x.xml" &&
        detail.fieldsFound === 12
    );
    const out = resAf.outputs[0];
    if (out) {
      const outBytes = new Uint8Array(await out.blob.arrayBuffer());
      check(
        "E2E A (/AF-only): the .xml still round-trips byte-exact",
        outBytes.length === ciiBytes.length &&
          outBytes.every((b, i) => b === ciiBytes[i])
      );
    }
  }
}

/* ================================================================== */
console.log("── 14. REAL E2E Path B: visual invoice sniff ──────────────");
/* ================================================================== */

{
  // A VALID-checksum GSTIN computed with the model's own validator.
  const prefix = "27ABCDE1234F1Z";
  const checkChar = gstinChecksum(prefix);
  check(
    "visual fixture: GSTIN check character computable",
    typeof checkChar === "string"
  );
  const validGstin = `${prefix}${checkChar ?? "0"}`;
  check(
    "visual fixture: the drawn GSTIN passes validation",
    gstinValidate(validGstin).ok === true,
    gstinValidate(validGstin)
  );

  const notoBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );
  const docB = await PDFDocument.create();
  docB.registerFontkit(fontkit);
  const noto = await docB.embedFont(notoBytes, { subset: true });
  const pageB = docB.addPage([595.28, 841.89]);
  const visual: [string, number][] = [
    ["Invoice #INV-2026-042", 780],
    ["Date: 14/02/2026", 756],
    ["Due Date: 14/03/2026", 740],
    [`GSTIN: ${validGstin}`, 724],
    ["Steel bracket heavy duty 2 1,200.00 2,400.00", 690],
    ["Sub Total: \u20B9 15,635.59", 660],
    ["IGST 18%: \u20B9 2,814.41", 644],
    ["Total: \u20B9 18,450.00", 620],
  ];
  for (const [text, y] of visual) {
    pageB.drawText(text, { x: 56, y, size: 11, font: noto });
  }
  const bytesB = new Uint8Array(await docB.save());

  const res = await drive(bytesB, "visual-invoice.pdf");
  check(
    "E2E B: result posted with ePath B",
    res.type === "result" && detailOf(res).ePath === "B",
    res.type === "error" ? res.code : "result"
  );
  if (res.type === "result") {
    const detail = detailOf(res);
    const summary: InvoiceSummary | undefined = detail.summary;
    const values = new Map<string, FieldHit>(
      (summary?.fields ?? []).map((f) => [f.key, f])
    );
    check(
      "E2E B: invoice number INV-2026-042, high, evidence = the drawn line",
      values.get("invoiceNumber")?.value === "INV-2026-042" &&
        values.get("invoiceNumber")?.confidence === "high" &&
        values.get("invoiceNumber")?.sourceSnippet === "Invoice #INV-2026-042" &&
        values.get("invoiceNumber")?.span?.page === 1 &&
        values.get("invoiceNumber")?.span?.line === 0,
      values.get("invoiceNumber")
    );
    check(
      "E2E B: issue date 2026-02-14 (medium) + due date 2026-03-14 (medium)",
      values.get("issueDate")?.value === "2026-02-14" &&
        values.get("issueDate")?.confidence === "medium" &&
        values.get("dueDate")?.value === "2026-03-14" &&
        values.get("dueDate")?.confidence === "medium",
      [values.get("issueDate"), values.get("dueDate")]
    );
    check(
      "E2E B: GSTIN seller tax id, high (checksum), evidence line",
      values.get("sellerTaxId")?.value === validGstin &&
        values.get("sellerTaxId")?.confidence === "high" &&
        values.get("sellerTaxId")?.sourceSnippet === `GSTIN: ${validGstin}`,
      values.get("sellerTaxId")
    );
    check(
      "E2E B: currency INR at medium, evidence = the first ₹ line",
      values.get("currency")?.value === "INR" &&
        values.get("currency")?.confidence === "medium" &&
        values.get("currency")?.sourceSnippet === "Sub Total: ₹ 15,635.59",
      values.get("currency")
    );
    check(
      "E2E B: line total + grand total with the tie-break applied",
      values.get("lineTotal")?.value === "15,635.59" &&
        values.get("lineTotal")?.confidence === "medium" &&
        values.get("grandTotal")?.value === "18,450.00" &&
        values.get("grandTotal")?.confidence === "medium" &&
        values.get("grandTotal")?.sourceSnippet === "Total: ₹ 18,450.00",
      [values.get("lineTotal"), values.get("grandTotal")]
    );
    check(
      "E2E B: one line item (the product row; the IGST row is blocked)",
      values.get("lineCount")?.value === "1" &&
        values.get("lineCount")?.confidence === "low" &&
        summary?.lineItems.length === 1 &&
        summary.lineItems[0]?.description === "Steel bracket heavy duty" &&
        summary.lineItems[0]?.qty === "2" &&
        summary.lineItems[0]?.unitPrice === "1200.00" &&
        summary.lineItems[0]?.amount === "2400.00",
      summary?.lineItems
    );
    check(
      "E2E B: the IGST tax line with rate + amount",
      summary?.taxes.length === 1 &&
        summary.taxes[0]?.type === "IGST" &&
        summary.taxes[0]?.rate === "18" &&
        summary.taxes[0]?.amount === "2,814.41" &&
        summary.taxes[0]?.sourceSnippet === "IGST 18%: ₹ 2,814.41",
      summary?.taxes
    );
    check(
      "E2E B: honest missing keys (buyer tax id, tax basis, party names)",
      JSON.stringify([...(summary?.missingKeys ?? [])].sort()) ===
        JSON.stringify(["buyerName", "buyerTaxId", "sellerName", "taxBasisTotal"]),
      summary?.missingKeys
    );
    check(
      "E2E B: detail counts (8 fields, 1 page)",
      detail.fieldsFound === 8 && detail.pages === 1 && detail.files === 1,
      { fieldsFound: detail.fieldsFound, pages: detail.pages }
    );
    const out = res.outputs[0];
    check(
      "E2E B: output name visual-invoice.json, application/json",
      out?.name === "visual-invoice.json" && out?.mime === "application/json",
      out?.name
    );
    if (out) {
      const body = JSON.parse(await out.blob.text()) as {
        extractionPath: string;
        source: string;
        fields: Record<string, { value: string; confidence: string }>;
        notFound: string[];
        taxes: { type: string }[];
      };
      check(
        "E2E B: invoice.json body is the honest best-effort summary",
        body.extractionPath === "layout-sniff (best-effort — verify before use)" &&
          body.source === "visual-invoice.pdf" &&
          body.fields.invoiceNumber?.value === "INV-2026-042" &&
          body.fields.sellerTaxId?.value === validGstin &&
          body.fields.sellerTaxId?.confidence === "high" &&
          body.notFound.includes("sellerName") &&
          body.taxes[0]?.type === "IGST",
        body
      );
    }
  }

  /* ---- 3 pages under a 2-page cap: the honest truncation report ---- */
  const docT = await PDFDocument.create();
  const helvT = await docT.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    const pg = docT.addPage([595.28, 841.89]);
    pg.drawText(`Invoice text block on page ${i + 1}`, {
      x: 56,
      y: 780,
      size: 11,
      font: helvT,
    });
  }
  const bytesT = new Uint8Array(await docT.save());
  const resT = await drive(bytesT, "truncated-read.pdf", { maxPages: 2 });
  check(
    "E2E B (cap): 3-page file under maxPages 2 → result with truncated honesty",
    resT.type === "result" &&
      detailOf(resT).summary?.pagesRead === 2 &&
      detailOf(resT).summary?.truncated === true,
    resT.type === "result" ? detailOf(resT).summary : resT
  );
}

/* ================================================================== */
console.log("── 15. error taxonomy (E2E, honest codes) ─────────────────");
/* ================================================================== */

{
  const noFile = await drive(null, "whatever.pdf");
  check(
    "error: no file → tool.errorGeneric",
    noFile.type === "error" && noFile.code === "tool.errorGeneric",
    noFile
  );

  const enc = await CantooPDF.create();
  enc.addPage([612, 792]);
  await enc.encrypt({
    userPassword: "secret-one",
    ownerPassword: "secret-two",
    algorithm: "AES-256",
    permissions: {
      printing: "highResolution",
      copying: true,
      modifying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
  const encBytes = new Uint8Array(await enc.save());
  const resEnc = await drive(encBytes, "locked.pdf");
  check(
    "error: AES-256-encrypted → tool.errorEncrypted",
    resEnc.type === "error" && resEnc.code === "tool.errorEncrypted",
    resEnc
  );

  const garbage = new Uint8Array(2048);
  for (let i = 0; i < garbage.length; i += 1) {
    garbage[i] = (i * 31 + 7) & 0xff;
  }
  const resGarbage = await drive(garbage, "garbage.pdf");
  check(
    "error: garbage bytes → tool.errorCorrupt",
    resGarbage.type === "error" && resGarbage.code === "tool.errorCorrupt",
    resGarbage
  );

  const docBlank = await PDFDocument.create();
  docBlank.addPage([595.28, 841.89]);
  const bytesBlank = new Uint8Array(await docBlank.save());
  const resBlank = await drive(bytesBlank, "scan-like.pdf");
  check(
    "error: no XML + no selectable text → peinv.errorNoInvoice (not corrupt)",
    resBlank.type === "error" && resBlank.code === "peinv.errorNoInvoice",
    resBlank
  );
  check(
    "error: the no-invoice error cites the file name",
    resBlank.type === "error" && resBlank.detail === "scan-like.pdf",
    resBlank.detail
  );

  const workerSrc = readFileSync("tools/pdf-to-e-invoice/worker.ts", "utf8");
  check(
    "worker honesty: pdf.js gets a COPY of the buffer (the detach lesson)",
    /data:\s*bytes\.slice\(\)/.test(workerSrc)
  );
  check(
    "worker honesty: the /AF walk loads with updateMetadata:false",
    /updateMetadata:\s*false/.test(workerSrc)
  );
  check(
    "worker honesty: the scan case posts peinv.errorNoInvoice",
    /peinv\.errorNoInvoice/.test(workerSrc)
  );
  check(
    "worker honesty: onmessage only reacts to type \"run\"",
    /data\?\.type\s*!==\s*"run"/.test(workerSrc)
  );
}

/* ================================================================== */
console.log("── 16. wiring sanity + i18n ───────────────────────────────");
/* ================================================================== */

{
  const { config } = await import("../tools/pdf-to-e-invoice/config");
  check("config: toolId", config.toolId === "pdf-to-e-invoice");
  check(
    "config: no options (attachments are document-level; fixed Path B cap)",
    config.options.length === 0
  );
  check(
    "config: howKeys are peinv.*",
    JSON.stringify(config.howKeys) ===
      '["peinv.how1","peinv.how2","peinv.how3"]'
  );
  check(
    "config: single PDF file, text output, landing surface",
    config.minFiles === 0 &&
      config.maxFiles === 1 &&
      config.outputKind === "text" &&
      config.landingSurface === true
  );
  check(
    "config: features + faq bilingual",
    config.features.every((f) => f.en.length > 0 && f.hi.length > 0) &&
      config.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );

  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  check(
    "registry: the pdf-to-e-invoice def exists (wiring lands with the batch)",
    /id:\s*"pdf-to-e-invoice"/.test(registrySrc)
  );

  const i18n = JSON.parse(
    readFileSync("tools/pdf-to-e-invoice/i18n.json", "utf8")
  ) as {
    en: { peinv: Record<string, string> };
    hi: { peinv: Record<string, string> };
  };
  const enKeys = Object.keys(i18n.en.peinv).sort();
  const hiKeys = Object.keys(i18n.hi.peinv).sort();
  check(
    "i18n: en/hi leaf parity (peinv.*)",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys) && enKeys.length === 54,
    { en: enKeys.length, hi: hiKeys.length }
  );
  check(
    "i18n: no empty values on either side",
    Object.values(i18n.en.peinv).every((v) => v.trim().length > 0) &&
      Object.values(i18n.hi.peinv).every((v) => v.trim().length > 0)
  );

  const surfaceSrc = readFileSync("tools/pdf-to-e-invoice/surface.tsx", "utf8");
  const used = new Set<string>();
  for (const m of surfaceSrc.matchAll(/t\("peinv\.([A-Za-z0-9]+)"/g)) {
    used.add(m[1] as string);
  }
  for (const m of surfaceSrc.matchAll(/labelKey="peinv\.([A-Za-z0-9]+)"/g)) {
    used.add(m[1] as string);
  }
  for (const m of surfaceSrc.matchAll(/setRunBlocked\("peinv\.([A-Za-z0-9]+)"\)/g)) {
    used.add(m[1] as string);
  }
  for (const k of config.howKeys ?? []) used.add(k.replace(/^peinv\./, ""));
  for (const k of FIELD_KEYS) used.add(`field_${k}`);
  used.add("errorNoInvoice"); // posted by the worker, rendered by the toast
  const missing = [...used].filter((k) => !enKeys.includes(k));
  check(
    "i18n: every peinv.* key used by the surface/config/worker resolves",
    missing.length === 0,
    missing
  );
  check(
    "i18n: no unused peinv.* keys (tight namespace)",
    enKeys.every((k) => used.has(k)),
    enKeys.filter((k) => !used.has(k))
  );
}

/* ================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("failing:", failures.slice(0, 25).join(" | "));
}
process.exit(failed > 0 ? 1 : 0);
