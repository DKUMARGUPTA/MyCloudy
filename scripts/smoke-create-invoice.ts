/**
 * PRE-BUILD smoke test for the Create invoice tool (P3-INVOICE, the
 * 64th tool). Proves the ZERO-MISTAKE core with hand-computed vectors
 * before the tool is trusted:
 *
 *  1. MATH (model.ts): paise-integer engine — line amounts, per-item
 *     discounts (dp %, net line totals, global discount on the discounted
 *     subtotal, net-based pro-rata), CGST/SGST vs IGST split, standard-
 *     family tax, round-off delta, advance clamp, and the amount-in-words
 *     for ₹ Crore/Lakh AND $ Billion/Million systems. Every expected
 *     number below was computed BY HAND from the GST rules, then written
 *     down before running (no self-fulfilling assertions).
 *  1b. ROW AFFORDANCES: duplicateItems (copy-after-row, MAX_ITEMS cap,
 *     no aliasing) + the dp/duplicate parser-boundary round-trips.
 *  2. VALIDATION: GSTIN checksum (valid + corrupted), invoice-number
 *     bumping (trailing digit group, width-preserving), April–March
 *     financial-year prefix, next-number memory, the five GST warnings.
 *  3. PDF (render.ts): drives the worker's EXACT drawing code with the
 *     self-hosted Noto font read from disk — vector PDF builds, starts
 *     with %PDF, page count ≥ 1, reloads cleanly, contains the QR when
 *     UPI is set, paginates with many items, and a corrupted payload
 *     (bad image, bad block order, unknown type) still renders instead
 *     of crashing (the parser coerces).
 *
 * Run: bun scripts/smoke-create-invoice.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  calc,
  bump,
  duplicateItems,
  fy,
  gstOK,
  nextNo,
  parseInvoiceRun,
  Q,
  upiPayload,
  words,
  warnings,
  type InvoiceItem,
  type InvoiceState,
} from "../tools/create-invoice/model";
import { drawInvoice } from "../tools/create-invoice/render";
import { BLOCK_KEYS } from "../tools/create-invoice/model";

let failures = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
  }
}

function baseState(over: Partial<InvoiceState> = {}): InvoiceState {
  return {
    ty: "gst-invoice",
    cur: "INR",
    biz: {
      name: "Test Traders",
      addr: "12 Market Road\nMumbai 400001",
      gstin: "",
      state: "27",
      phone: "",
      email: "",
      bank: "",
      upi: "",
      logo: "",
      sig: "",
    },
    cli: { name: "Client Co", addr: "", gstin: "", state: "" },
    pos: "",
    no: "INV/25-26/001",
    date: "2025-06-01",
    due: "2025-06-16",
    valid: "",
    dMode: "%",
    d: "",
    tr: "",
    ro: true,
    adv: "",
    st: "",
    notes: "",
    terms: "",
    xv: ["", "", ""],
    items: [{ d: "Widget", h: "1001", q: "1", r: "100", g: "18", dp: "" }],
    ...over,
  };
}

console.log("── 1. Money math ─────────────────────────────────────");

/* Vector A — GST intra-state (27→27), 10% discount, round-off ON.
 * Hand-computed:
 *   A: 2 × ₹100.50        = 20100 p
 *   B: 1 × ₹33.335 → P=3334 = 3334 p (33.335×100 = 3333.5 → round 3334)
 *   sub = 23434
 *   disc 10% = 2343
 *   share A = R(2343×20100/23434) = R(2009.53) = 2010, share B = 333 (rest)
 *   tbA = 18090, tbB = 3001, Σtb = 21091 = sub − disc ✓
 *   intra 18%: cgA=sgA=R(18090×18/200)=1628, cgB=sgB=R(3001×18/200)=270
 *   cg = sg = 1898, ig = 0
 *   grand = 21091 + 1898 + 1898 = 24887 → round-off → 24900 (delta +13)
 */
{
  const s = baseState({
    biz: { ...baseState().biz, state: "27" },
    pos: "27",
    d: "10",
    items: [
      { d: "A", h: "", q: "2", r: "100.50", g: "18", dp: "" },
      { d: "B", h: "", q: "1", r: "33.335", g: "18", dp: "" },
    ],
  });
  const c = calc(s);
  eq(c.L[0].amt, 20100, "A: line amount paise");
  eq(c.L[1].amt, 3334, "B: 33.335 → 3334 paise (toFixed+round guard)");
  eq(c.sub, 23434, "subtotal");
  eq(c.disc, 2343, "10% discount");
  eq(c.L[0].tb, 18090, "A taxable (pro-rata share 2010)");
  eq(c.L[1].tb, 3001, "B taxable (last-item remainder 333)");
  eq(
    c.L.reduce((a, l) => a + (l.amt - l.tb), 0),
    c.disc,
    "Σ discount shares == discount EXACTLY"
  );
  eq(c.tb, 21091, "Σ taxable == sub − disc");
  eq(c.intra, true, "27→27 intra-state");
  eq(c.cg, 1898, "CGST total");
  eq(c.sg, 1898, "SGST total");
  eq(c.ig, 0, "IGST zero (intra)");
  eq(c.tot, 24900, "round-off total 24887 → 24900");
  eq(c.ro, 13, "round-off delta +13");
  eq(
    words(c.tot, "INR"),
    "Rupees Two Hundred Forty Nine Only",
    "words(24900)"
  );
}

/* Vector B — inter-state IGST, flat discount, round-off ON.
 *   item 3 × ₹99.99 = 29997 p, flat ₹100 = 10000 p
 *   tb = 19997, ig = R(19997×12/100) = 2400
 *   grand = 22397 → 22400 (delta +3)
 */
{
  const s = baseState({
    biz: { ...baseState().biz, state: "27" },
    pos: "29",
    dMode: "f",
    d: "100",
    items: [{ d: "C", h: "", q: "3", r: "99.99", g: "12", dp: "" }],
  });
  const c = calc(s);
  eq(c.intra, false, "27→29 inter-state");
  eq(c.tb, 19997, "flat discount taxable");
  eq(c.ig, 2400, "IGST 12%");
  eq(c.cg, 0, "no CGST (inter)");
  eq(c.tot, 22400, "round-off 22397 → 22400");
  eq(c.ro, 3, "round-off delta +3");
}

/* Vector C — standard family, single tax rate, advance, no round-off delta.
 *   A: 5 × ₹20 = 10000 p, B: 2 × ₹150 = 30000 p, sub = 40000, tr 18%
 *   tA = 1800, tB = 5400, tx = 7200, grand = 47200 (already whole → ro 0)
 *   advance ₹100 → 10000 p, balance 37200
 */
{
  const s = baseState({
    ty: "simple-invoice",
    tr: "18",
    adv: "100",
    items: [
      { d: "X", h: "", q: "5", r: "20", g: "", dp: "" },
      { d: "Y", h: "", q: "2", r: "150", g: "", dp: "" },
    ],
  });
  const c = calc(s);
  eq(c.g, false, "standard family");
  eq(c.sub, 40000, "subtotal");
  eq(c.tx, 7200, "18% tax total");
  eq(c.tot, 47200, "grand (no round-off delta)");
  eq(c.ro, 0, "delta zero");
  eq(c.adv, 10000, "advance clamped correctly");
  eq(c.bal, 37200, "balance due");
  eq(
    words(c.tot, "INR"),
    "Rupees Four Hundred Seventy Two Only",
    "words(47200)"
  );
}

/* Vector D — paise in words, no round-off.
 *   1 × ₹10.55 @ 5% intra (blank pos → intra):
 *   tb = 1055, cg = sg = R(1055×5/200) = R(26.375) = 26
 *   grand = 1055 + 52 = 1107 → "Eleven and Seven Paise"
 */
{
  const s = baseState({
    ro: false,
    items: [{ d: "P", h: "", q: "1", r: "10.55", g: "5", dp: "" }],
  });
  const c = calc(s);
  eq(c.intra, true, "blank states count as intra (ported rule)");
  eq(c.cg, 26, "CGST R(26.375) = 26");
  eq(c.tot, 1107, "grand with paise");
  eq(
    words(c.tot, "INR"),
    "Rupees Eleven and Seven Paise Only",
    "words with paise"
  );
}

/* Vector E — pro-rata drift proof: 3 × 3333, flat ₹1 discount.
 *   shares R(100×3333/9999) = 33, 33, last = 34 → Σ 100 exact
 */
{
  const s = baseState({
    dMode: "f",
    d: "1",
    items: [1, 2, 3].map(() => ({ d: "E", h: "", q: "1", r: "33.33", g: "0", dp: "" })),
  });
  const c = calc(s);
  eq(c.sub, 9999, "3 × 3333 subtotal");
  eq(c.disc, 100, "flat ₹1");
  eq(c.L.map((l) => l.amt - l.tb), [33, 33, 34], "shares 33/33/34");
  eq(c.tb, 9899, "Σ taxable");
}

/* Vector F — words systems.
 * 123456789001 paise = 1234567890 rupees + 1 paisa:
 *   123 Crore + 45 Lakh + 67 Thousand + 890
 */
eq(
  words(123456789001, "INR"),
  "Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety and One Paise Only",
  "INR Crore/Lakh words"
);
eq(
  words(123456789, "USD"),
  "Dollars One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Cents Only",
  "USD Billion/Million words"
);
eq(words(0, "EUR"), "Euros Zero Only", "zero words");
eq(words(5, "GBP"), "Pounds Zero and Five Pence Only", "paise-only words");

/* Vector G — hostile qty/rate clamps (FIX-3): typed "-5" and pasted "1e999"
 * must coerce to 0 at the money boundary — never negative or ±Infinity
 * totals. HTML min="0" on the inputs is only a hint; the engine is the law.
 */
{
  const s = baseState({
    ro: false,
    items: [
      { d: "neg", h: "", q: "-5", r: "100", g: "0", dp: "" },
      { d: "inf-q", h: "", q: "1e999", r: "2", g: "0", dp: "" },
      { d: "inf-r", h: "", q: "2", r: "1e999", g: "0", dp: "" },
      { d: "nan", h: "", q: "abc", r: "xyz", g: "0", dp: "" },
      { d: "ok", h: "", q: "3", r: "50", g: "0", dp: "" },
    ],
  });
  const c = calc(s);
  eq(c.L.map((l) => l.amt), [0, 0, 0, 0, 15000], "hostile lines → 0, clean line keeps 15000 p");
  eq(c.sub, 15000, "subtotal stays finite");
  eq(c.tb, 15000, "taxable stays finite");
  eq(c.tot, 15000, "grand total finite (no -x / ±∞)");
  eq(
    Number.isFinite(c.tot) && Number.isFinite(c.bal) && Number.isFinite(c.ro),
    true,
    "every total Number.isFinite"
  );
}
{
  // Q primitive vectors (the coercion the smoke pins directly).
  eq(Q("-5"), 0, "Q(-5) → 0");
  eq(Q("1e999"), 0, "Q(1e999) → 0 (Infinity clamped)");
  eq(Q("-1e999"), 0, "Q(-1e999) → 0");
  eq(Q("abc"), 0, "Q(garbage) → 0");
  eq(Q(""), 0, "Q(empty) → 0");
  eq(Q("0"), 0, "Q(0) → 0");
  eq(Q("2.5"), 2.5, "Q(2.5) → 2.5 (fractional qty survives)");
  eq(Q("2.5 hrs"), 2.5, "Q(free-form suffix) → 2.5 (verbatim text, clamped math)");
  // Rounding semantics preserved: amt = R(qty × R(rate·100)) — rate still
  // quantizes to paise BEFORE the multiply (Vector A/B prove the clean path).
  const s = baseState({
    ro: false,
    items: [{ d: "B", h: "", q: "1", r: "33.335", g: "0", dp: "" }],
  });
  eq(calc(s).L[0].amt, 3334, "clamped path keeps Vector A's 33.335 → 3334 paise rounding");
}

/* Vector H — per-item discount + global discount combination.
 * Hand-computed (the documented order: per-item FIRST, then the global
 * discount on the subtotal of discounted line totals):
 *   A: 2 × ₹100.50, dp 10% → amt 20100, pd 2010, net 18090
 *   B: 1 × ₹33.335 → amt 3334, pd 0, net 3334
 *   sub (gross) = 23434, idisc = 2010, base = 21424
 *   global 10% = R(2142.4) = 2142
 *   share A = R(2142×18090/21424) = R(1808.66…) = 1809, B = 333 (remainder)
 *   tbA = 16281, tbB = 3001, Σ tb = 19282 = 21424 − 2142 ✓
 *   intra 18%: cgA=sgA=R(1465.29)=1465, cgB=sgB=R(270.09)=270 → cg=sg=1735
 *   grand = 19282 + 3470 = 22752 → round-off → 22800 (delta +48)
 */
{
  const s = baseState({
    biz: { ...baseState().biz, state: "27" },
    pos: "27",
    d: "10",
    items: [
      { d: "A", h: "", q: "2", r: "100.50", g: "18", dp: "10" },
      { d: "B", h: "", q: "1", r: "33.335", g: "18", dp: "" },
    ],
  });
  const c = calc(s);
  eq(c.L[0].amt, 20100, "H: gross line amount (rate × qty)");
  eq(c.L[0].pd, 2010, "H: per-item discount 10% of 20100");
  eq(c.L[0].net, 18090, "H: discounted line total");
  eq(c.L[1].net, 3334, "H: no dp → net == amt");
  eq(c.sub, 23434, "H: subtotal stays the GROSS Σ amt");
  eq(c.idisc, 2010, "H: item-discount total");
  eq(c.disc, 2142, "H: global 10% applies on the discounted subtotal 21424");
  eq(c.L[0].tb, 16281, "H: A taxable (pro-rata share 1809 over net)");
  eq(c.L[1].tb, 3001, "H: B taxable (last-item remainder 333)");
  eq(
    c.L.reduce((a, l) => a + (l.net - l.tb), 0),
    c.disc,
    "H: Σ global shares == global discount EXACTLY (net-based pro-rata)"
  );
  eq(c.tb, 19282, "H: Σ taxable == sub − idisc − disc");
  eq(c.cg, 1735, "H: CGST total");
  eq(c.sg, 1735, "H: SGST total");
  eq(c.tot, 22800, "H: round-off 22752 → 22800");
  eq(c.ro, 48, "H: round-off delta +48");
}

/* Vector I — per-item discount edge cases.
 *   dp > 100 clamps to a full line discount; garbage/negative/∞ → 0;
 *   fractional dp works; a global flat discount clamps to the NET base.
 */
{
  const s = baseState({
    ro: false,
    items: [
      { d: "over", h: "", q: "1", r: "100", g: "0", dp: "150" },
      { d: "neg", h: "", q: "1", r: "100", g: "0", dp: "-5" },
      { d: "inf", h: "", q: "1", r: "100", g: "0", dp: "1e999" },
      { d: "junk", h: "", q: "1", r: "100", g: "0", dp: "abc" },
      { d: "frac", h: "", q: "1", r: "100", g: "0", dp: "12.5" },
    ],
  });
  const c = calc(s);
  eq(c.L.map((l) => l.pd), [10000, 0, 0, 0, 1250], "I: pd clamps/garbage/fractional");
  eq(c.L.map((l) => l.net), [0, 10000, 10000, 10000, 8750], "I: net line totals");
  eq(c.idisc, 11250, "I: idisc total");
  eq(c.sub, 50000, "I: gross subtotal");
  eq(c.tb, 38750, "I: Σ net == sub − idisc (no global discount)");
}
{
  // Flat global discount clamps to the per-item-discounted base, not gross.
  const s = baseState({
    ro: false,
    dMode: "f",
    d: "9000",
    items: [{ d: "clamp", h: "", q: "1", r: "100", g: "0", dp: "12.5" }],
  });
  const c = calc(s);
  eq(c.disc, 8750, "I: flat global clamps to net base 8750 (not gross 10000)");
  eq(c.tb, 0, "I: taxable hits exactly zero");
  eq(c.tot, 0, "I: total zero (no negative money)");
}

/* duplicateItems — the row copy affordance (pure, surface uses it verbatim). */
{
  const A: InvoiceItem = { d: "Widget", h: "1001", q: "2", r: "10", g: "18", dp: "5" };
  const B: InvoiceItem = { d: "Gadget", h: "", q: "1", r: "25", g: "18", dp: "" };
  eq(duplicateItems([A, B], 0).length, 3, "dup: inserts a row");
  eq(duplicateItems([A, B], 0)[1], A, "dup: copy carries every field (deep equal)");
  eq(duplicateItems([A, B], 0)[2], B, "dup: rows after it shift down one");
  eq(duplicateItems([A, B], 1)[2], B, "dup: duplicating the LAST row appends");
  eq(duplicateItems([A, B], -1).length, 2, "dup: negative index ignored");
  eq(duplicateItems([A, B], 7).length, 2, "dup: out-of-range index ignored");
  eq(
    duplicateItems(Array.from({ length: 200 }, () => A), 0).length,
    200,
    "dup: MAX_ITEMS cap blocks growth at 200"
  );
  eq(
    duplicateItems(Array.from({ length: 199 }, () => A), 100).length,
    200,
    "dup: below cap grows to exactly 200"
  );
  const mutated = duplicateItems([A], 0);
  mutated[1].d = "changed";
  eq(A.d, "Widget", "dup: the copy is a separate object (no aliasing)");
}

console.log("── 2. GSTIN + numbering + warnings ─────────────────────");

eq(gstOK("27AAPFU0939F1ZV"), true, "GSTIN checksum valid (hand-verified)");
eq(gstOK("27AAPFU0939F1ZW"), false, "corrupted check char rejected");
eq(gstOK("27AAPFU0939F1Z"), false, "14-char GSTIN rejected");
eq(gstOK("27aAPFU0939F1ZV"), false, "lowercase rejected (format)");

eq(bump("INV/25-26/009"), "INV/25-26/010", "bump trailing group");
eq(bump("A-9"), "A-10", "bump single digit");
eq(bump("A-099"), "A-100", "bump keeps width");
eq(bump(""), "INV-001", "bump empty → INV-001");
eq(bump("NO NUMBERS"), "INV-001", "bump no digits → INV-001");

eq(fy("2025-06-01"), "25-26", "FY June 2025");
eq(fy("2025-03-31"), "24-25", "FY March 2025");
eq(fy("2024-04-01"), "24-25", "FY April 2024");

eq(
  nextNo("gst-invoice", "2025-06-01", {}),
  "INV/25-26/001",
  "fresh GST number"
);
eq(nextNo("simple-invoice", "2025-06-01", {}), "INV-001", "fresh std number");
eq(
  nextNo("gst-invoice", "2025-06-01", { "gst-invoice": "INV/25-26/004" }),
  "INV/25-26/005",
  "bumped from memory"
);

{
  const s = baseState({
    no: "WAY TOO LONG NUMBER",
    biz: { ...baseState().biz, state: "29", gstin: "27AAPFU0939F1ZV" },
    items: [{ d: "Z", h: "123", q: "1", r: "60000", g: "15", dp: "" }],
  });
  const c = calc(s);
  const w = warnings(s, c);
  eq(w.some((x) => x.key === "wno"), true, "invoice-no format warning");
  eq(
    w.some((x) => x.key === "wh" && x.item === 1),
    true,
    "HSN digit warning #1"
  );
  eq(
    w.some((x) => x.key === "wr" && x.item === 1),
    true,
    "unusual GST rate warning #1"
  );
  eq(w.some((x) => x.key === "wst"), true, "GSTIN/state mismatch warning");
  eq(w.some((x) => x.key === "wew"), true, "₹50,000 e-way warning (goods)");
}

console.log("── 3. UPI payload + parser hardening ──────────────────");

eq(
  upiPayload("name@bank", "Test Traders", 24900, "INV/25-26/001"),
  "upi://pay?pa=name%40bank&pn=Test+Traders&am=249.00&cu=INR&tn=Invoice+INV%2F25-26%2F001",
  "UPI deep link"
);

{
  const raw = JSON.stringify({
    s: {
      ty: "UNKNOWN-TYPE",
      cur: "CHF",
      biz: { logo: "data:image/png;base64,AAAA", sig: "javascript:alert(1)" },
      items: [{ d: "ok", h: "12345", q: "1", r: "5", g: "18", dp: "0123456789" }],
    },
    ord: ["sig", "hd", "zzz", "bt", "it", "tt", "wd", "bank", "notes", "terms"],
    ac: "not-a-color",
    labels: { no: "Invoice no.", ttl: "Tax Invoice" },
  });
  const run = parseInvoiceRun(raw);
  eq(run.s.ty, "gst-invoice", "unknown type → gst-invoice");
  eq(run.s.cur, "INR", "unknown currency → INR");
  eq(run.s.biz.logo, "data:image/png;base64,AAAA", "well-formed dataURL prefix kept (render catches embed)");
  eq(run.s.biz.sig, "", "non-dataURL signature dropped");
  eq(run.ord, BLOCK_KEYS, "block order sanitized to the 9 keys");
  eq(run.ac, "#0b6b4d", "bad accent → default green");
  eq(run.s.items[0].h, "12345", "HSN length clamped to 16");
  eq(run.s.items[0].dp, "01234567", "per-item discount clamped to 8 chars");
}
{
  // dp round-trips through the serializer boundary (saved invoices,
  // worker payload, localStorage).
  const s = baseState({
    items: [{ d: "keep", h: "", q: "1", r: "10", g: "18", dp: "7.5" }],
  });
  const run = parseInvoiceRun(
    JSON.stringify({ s, ord: BLOCK_KEYS.slice(), ac: "#0b6b4d", labels: {} })
  );
  eq(run.s.items[0].dp, "7.5", "serialized dp survives the worker boundary");
  eq(calc(run.s).L[0].pd, 75, "serialized dp still computes (10 × 7.5%)");
  const legacy = parseInvoiceRun(
    JSON.stringify({
      s: { items: [{ d: "old", h: "", q: "1", r: "10", g: "18" }] },
      ord: [],
      ac: "#0b6b4d",
      labels: {},
    })
  );
  eq(legacy.s.items[0].dp, "", "dp-less legacy payload coerces to \"\"");
}

console.log("── 4. Vector PDF render (worker's exact code) ──────────");

const fontBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function renderAndCheck(
  name: string,
  run: Parameters<typeof drawInvoice>[2],
  checks: (bytes: Uint8Array, doc: PDFDocument, pages: number) => void
): Promise<void> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  await drawInvoice(doc, font, run);
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  const pages = reloaded.getPageCount();
  eq(
    bytes.length > 1000 && bytes[0] === 0x25 && bytes[1] === 0x50,
    true,
    `${name}: %PDF magic + non-trivial size (${bytes.length} B)`
  );
  checks(bytes, reloaded, pages);
  console.log(`  ok  ${name}: ${pages} page(s), ${(bytes.length / 1024).toFixed(1)} KB`);
}

const LABELS: Record<string, string> = {
  no: "Invoice no.",
  date: "Date",
  due: "Due date",
  valid: "Valid until",
  pos: "Place of supply",
  bt: "Bill to",
  ttl: "Tax Invoice",
  desc: "Description",
  hsn: "HSN / SAC",
  qty: "Qty",
  rate: "Rate",
  tb: "Taxable value",
  gp: "GST %",
  amt: "Amount",
  sub: "Subtotal",
  disc2: "Discount",
  cg: "CGST",
  sg: "SGST",
  ig: "IGST",
  tx: "Tax",
  rof: "Round off",
  tot: "Total",
  wd: "Amount in words",
  for: "For",
  sig: "Authorised signatory",
  bank: "Bank details",
  notes: "Notes",
  terms: "Terms",
  adv: "Advance / amount received",
  bal: "Balance due",
};

/* Full GST invoice: bank + UPI QR + stamp + notes + terms + Hindi labels. */
await renderAndCheck(
  "full GST invoice (UPI QR + PAID stamp)",
  {
    s: baseState({
      biz: {
        ...baseState().biz,
        gstin: "27AAPFU0939F1ZV",
        state: "27",
        bank: "HDFC Bank\nA/C 12345678\nIFSC HDFC0000123",
        upi: "test@upi",
      },
      pos: "27",
      d: "10",
      st: "PAID",
      notes: "Thank you for your business.",
      terms: "Payment due within 15 days of the invoice date.",
      items: [
        { d: "Consulting services\nPhase 1 + Phase 2", h: "998313", q: "10", r: "250", g: "18", dp: "" },
        { d: "Software licence", h: "8523", q: "2", r: "999.99", g: "18", dp: "" },
      ],
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#0b6b4d",
    labels: { ...LABELS, ttl: "टैक्स इनवॉइस" },
  },
  (_bytes, doc, pages) => {
    eq(pages, 1, "two-item invoice fits one page");
  }
);

/* Pagination: 120 long items must flow onto continuation pages. */
await renderAndCheck(
  "120-item invoice pagination",
  {
    s: baseState({
      items: Array.from({ length: 120 }, (_, i) => ({
        d: `Line item ${i + 1} with a fairly long description that wraps once or twice in the description column`,
        h: "1001",
        q: "1",
        r: "99",
        g: "18",
        dp: "",
      })),
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#0b6b4d",
    labels: LABELS,
  },
  (_bytes, _doc, pages) => {
    eq(pages >= 2, true, `many items paginate (${pages} pages)`);
  }
);

/* Hindi labels render through Noto (no crash, valid PDF). */
await renderAndCheck(
  "Hindi labels + ₹ amounts",
  {
    s: baseState({
      items: [{ d: "डिज़ाइन सेवा", h: "9983", q: "1", r: "1234.50", g: "18", dp: "" }],
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#7c2d12",
    labels: {
      ...LABELS,
      ttl: "टैक्स इनवॉइस",
      no: "इनवॉइस नं.",
      date: "दिनांक",
      due: "देय तिथि",
      bt: "बिल प्राप्तकर्ता",
      desc: "विवरण",
      qty: "मात्रा",
      rate: "दर",
      tb: "कर योग्य मूल्य",
      sub: "उप-योग",
      tot: "कुल योग",
      wd: "राशि शब्दों में",
      for: "कृते",
      sig: "अधिकृत हस्ताक्षरकर्ता",
    },
  },
  () => {
    /* reaching here without a font exception IS the assertion */
  }
);

/* No-price delivery challan (np: no totals, no words, no rate column). */
await renderAndCheck(
  "delivery challan (no prices)",
  {
    s: baseState({
      ty: "delivery-challan",
      items: [{ d: "Machine parts (20 boxes)", h: "8481", q: "20", r: "500", g: "18", dp: "" }],
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#0b6b4d",
    labels: LABELS,
  },
  () => {
    /* np path renders without totals — reaching here is the check */
  }
);

/* Per-item discount column + "Item discount" totals row (R3-c): the dp
 * column appears only when a line carries one, the line amount prints the
 * NET total, and the totals block gains the idisc row between Subtotal
 * and Discount. Draws without a font/geometry exception — that IS the
 * regression guard for the new column plan. */
await renderAndCheck(
  "per-item discount invoice (dp column + idisc row)",
  {
    s: baseState({
      biz: { ...baseState().biz, state: "27" },
      pos: "27",
      d: "10",
      items: [
        { d: "Bulk widgets", h: "1001", q: "2", r: "100.50", g: "18", dp: "10" },
        { d: "Licence", h: "8523", q: "1", r: "33.335", g: "18", dp: "" },
      ],
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#0b6b4d",
    labels: { ...LABELS, dp: "Disc %", idisc: "Item discount" },
  },
  (bytes, _doc, pages) => {
    eq(pages, 1, "dp-column invoice fits one page");
    eq(bytes.length > 1000, true, "dp-column invoice non-trivial");
  }
);

/* Logo + signature REALLY draw (the embedPng await regression guard):
   the un-awaited version embedded the XObjects but wrote a NaN cm
   matrix — this vector inflates the page content stream and asserts a
   real `Do` invocation with NO NaN anywhere in the operators. */
{
  const PX =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const run = {
    s: baseState({
      biz: { ...baseState().biz, logo: PX, sig: PX },
      pos: "27",
      items: [{ d: "item", h: "", q: "1", r: "100", g: "18", dp: "" }],
    }),
    ord: BLOCK_KEYS.slice(),
    ac: "#0b6b4d",
    labels: { ...LABELS },
  };
  await drawInvoice(doc, font, run);
  const bytes = await doc.save();
  const raw = Buffer.from(bytes).toString("latin1");
  const imageCount = (raw.match(/\/Subtype\s*\/Image/g) ?? []).length;
  eq(imageCount >= 2, true, "logo + sig: image XObjects embedded (2)");
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams: Uint8Array[] = [];
  const push = (x: unknown): void => {
    if (x && typeof x === "object" && "getContents" in (x as object)) {
      streams.push((x as { getContents: () => Uint8Array }).getContents());
    }
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) push(contents.lookup(i));
  } else {
    push(contents);
  }
  const ops = streams.map((s) => inflateSync(s).toString("latin1")).join("\n");
  eq(ops.includes(" Do") || ops.includes("Do\n") || ops.includes(" Q"), true, "logo + sig: XObject draw operators present");
  eq(ops.includes("NaN"), false, "logo + sig: cm matrix is FINITE (no NaN — the await regression)");
  eq(
    (ops.match(/\/[\w-]+\s+Do\b/g) ?? []).length >= 2,
    true,
    "logo + sig: BOTH images invoked with Do (pdf-lib names carry a hyphen)"
  );
}

/* ------------------------------------------------------------------ */
/* 5. OCR prefill hydration (R5-c): applyOcrDraft + the round-trip      */
/* ------------------------------------------------------------------ */

console.log("── 5. OCR prefill hydration (applyOcrDraft, R5-c) ──────");
{
  const { applyOcrDraft } = await import("../tools/create-invoice/model");
  const {
    extractInvoiceDraft,
    parseOcrPrefill,
    serializeOcrPrefill,
  } = await import("../tools/ocr-pdf/invoice-extract");

  // Full E2E chain on the R5-c reference invoice: recognized text →
  // extract → serialize → parse → apply onto a quotation-state editor.
  const text = [
    "TAX INVOICE",
    "From: Sunrise Traders Pvt Ltd",
    "Invoice No: INV-2024-001",
    "Invoice Date: 15/03/2024",
    "Due Date: 29/03/2024",
    "Widget Pro 2 × 599.00",
    "Gadget Lite 1 249.50",
    "Subtotal: 1,447.50",
    "CGST: 130.28",
    "Total: ₹ 1,577.78",
  ].join("\n");
  const draft = extractInvoiceDraft([text], "en");
  eq(draft !== null, true, "E2E: draft extracted");
  const parsed = parseOcrPrefill(serializeOcrPrefill(draft!, 42));
  eq(parsed, draft, "E2E: prefill codec round-trip");

  const base = baseState({ ty: "quotation", no: "QT-001" });
  const hydrated = applyOcrDraft(base, parsed!);
  eq(hydrated.biz.name, "Sunrise Traders Pvt Ltd", "vendor → business name");
  eq(hydrated.biz.addr, base.biz.addr, "other business fields survive the merge");
  eq(hydrated.no, "INV-2024-001", "invoice number set");
  eq(hydrated.date, "2024-03-15", "invoice date set (ISO)");
  eq(hydrated.due, "2024-03-29", "due date set (ISO)");
  eq(hydrated.cur, "INR", "currency set");
  eq(hydrated.ty, "gst-invoice", "GST/₹ evidence → gst-invoice type");
  eq(
    hydrated.items,
    [
      { d: "Widget Pro", h: "", q: "2", r: "599.00", g: "", dp: "" },
      { d: "Gadget Lite", h: "", q: "1", r: "249.50", g: "", dp: "" },
    ],
    "items mapped onto editor rows (h/dp empty, gst only when found)"
  );
  eq(hydrated.cli, base.cli, "client untouched (OCR never saw it)");
  // The hydrated state still calculates (integer paise engine intact).
  const c5 = calc(hydrated);
  eq(c5.sub, 144750, "hydrated items compute: 2×599 + 1×249.50 = 1447.50");

  // Foreign currency + no GST evidence → standard-family type.
  const usd = applyOcrDraft(
    baseState({ ty: "gst-invoice" }),
    { totals: {}, gstFound: false, items: [], itemsCapped: false, currency: "USD" }
  );
  eq(usd.ty, "simple-invoice", "USD totals → simple-invoice (standard family)");
  eq(usd.cur, "USD", "USD currency applied");

  // NO currency/GST evidence at all → the user's type stays untouched.
  const keep = applyOcrDraft(
    baseState({ ty: "quotation" }),
    { totals: {}, gstFound: false, items: [], itemsCapped: false, invoiceNumber: "X-1" }
  );
  eq(keep.ty, "quotation", "no family evidence → type unchanged");
  eq(keep.no, "X-1", "number still applied");

  // gstFound alone (no currency) also picks the GST invoice.
  const gstOnly = applyOcrDraft(
    baseState({ ty: "quotation" }),
    { totals: { cgst: "10" }, gstFound: true, items: [], itemsCapped: false }
  );
  eq(gstOnly.ty, "gst-invoice", "GST-labelled totals → gst-invoice (even without currency)");

  // No items found → rows untouched; per-row gst carried when present.
  const noItems = applyOcrDraft(
    baseState({ ty: "gst-invoice", items: [{ d: "kept", h: "", q: "3", r: "7", g: "5", dp: "" }] }),
    { totals: {}, gstFound: false, items: [], itemsCapped: false, invoiceNumber: "N-1" }
  );
  eq(noItems.items, [
    { d: "kept", h: "", q: "3", r: "7", g: "5", dp: "" },
  ], "empty draft items → editor rows kept");
  const withGst = applyOcrDraft(baseState({ ty: "gst-invoice" }), {
    totals: {},
    gstFound: true,
    items: [{ d: "Consulting", q: "10", r: "250.00", g: "18" }],
    itemsCapped: false,
  });
  eq(withGst.items[0].g, "18", "per-row gst carried into the editor");

  // The honest cap survives the whole boundary: 60 found rows → the
  // codec caps at 50, the mapping keeps the cap.
  const throughCodec = parseOcrPrefill(
    serializeOcrPrefill({
      totals: {},
      gstFound: false,
      items: Array.from({ length: 60 }, (_, i) => ({ d: `Row ${i}`, q: "1", r: "2" })),
      itemsCapped: true,
    })
  );
  eq(throughCodec?.items.length, 50, "parseOcrPrefill caps the list itself");
  eq(
    applyOcrDraft(baseState(), throughCodec!).items.length,
    50,
    "mapping keeps the codec's 50-row cap"
  );
}

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} FAILURE(S) — create-invoice smoke`);
  process.exit(1);
}
console.log("✓ create-invoice smoke: all vectors pass (math + PDF)");
