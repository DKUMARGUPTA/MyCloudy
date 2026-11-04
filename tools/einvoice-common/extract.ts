/**
 * PDF invoice text → fields (P9 batch 5) — layout-free heuristics that
 * prefill the e-invoice form in pdf-to-e-invoice. NOT a parser: it
 * recognises the common Indian/international invoice vocabulary and
 * reports exactly what it found, so the user verifies before anything
 * is generated. Zero network, runs wherever the text lives.
 */

import type { InvoiceState } from "../create-invoice/model";
import { emptyInvoice } from "./blank";

export interface ExtractNote {
  field: string;
  found: string;
}

export interface ExtractResult {
  state: InvoiceState;
  notes: ExtractNote[];
  /** Non-empty when nothing at all was recognised. */
  empty: boolean;
}

const GSTIN_RE = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}[Z]{1}[0-9A-Z]{1})\b/g;
const DATE_RE =
  /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/i;
const MONEY_RE = /(?:₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const TOTAL_RE =
  /\b(?:grand\s+total|total\s+amount|amount\s+payable|net\s+payable|invoice\s+total|total)\b/i;
const INVNO_RE =
  /\b(?:invoice|inv|bill|tax\s+invoice)\s*(?:no|nr|number|#|:)[\s:.\-]*([A-Za-z0-9][A-Za-z0-9\/-]{1,24})\b/i;
const BUYER_RE = /\b(?:bill\s*to|billed\s*to|buyer|customer|consignee)\b\s*[:\-]?/i;
const SELLER_RE = /\b(?:from|seller|sold\s*by|bill\s*from|vendor)\b\s*[:\-]?/i;
const TAXP_RE = /\b(CGST|SGST|IGST)\b[^%]{0,12}(\d{1,2}(?:\.\d{1,2})?)\s*%/gi;

/** dd-mm-yyyy / dd/mm/yyyy / yyyy-mm-dd → ISO; "15 Oct 2024" too. */
function toIso(raw: string): string {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mon = raw.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})/);
  if (mon) {
    const mi = months.indexOf(mon[2].toLowerCase());
    if (mi >= 0) {
      const y = mon[3].length === 2 ? `20${mon[3]}` : mon[3];
      return `${y}-${String(mi + 1).padStart(2, "0")}-${mon[1].padStart(2, "0")}`;
    }
  }
  const d = raw.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (d) return `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
  const e = raw.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (e) {
    const y = e[3].length === 2 ? `20${e[3]}` : e[3];
    return `${y}-${e[2].padStart(2, "0")}-${e[1].padStart(2, "0")}`;
  }
  return "";
}

/**
 * Some PDF text layers emit every piece twice (fill + clip passes —
 * pdf.js shows it, poppler does not). A ≥8-char fragment repeated at the
 * END of a line is a rendering artefact, never real content: "INV-041INV-041"
 * → "INV-041". Short repeats (dates, phone digits) never split into two
 * ≥8 chunks, so they are left alone.
 */
function dedupeLine(line: string): string {
  return line.replace(/(.{8,}?)\1$/, "$1");
}

/** Extracts prefilled invoice fields from full-page texts (page order). */
export function extractInvoiceFields(pages: string[]): ExtractResult {
  const cleanPages = pages.map((p) =>
    p.split("\n").map(dedupeLine).join("\n")
  );
  const text = cleanPages.join("\n");
  const s = emptyInvoice();
  const notes: ExtractNote[] = [];

  /* Currency: strongest symbol wins; default INR. */
  if (/₹|Rs\.|INR/i.test(text)) s.cur = "INR";
  else if (/\$|USD/.test(text)) s.cur = "USD";
  else if (/€|EUR/.test(text)) s.cur = "EUR";
  else if (/£|GBP/.test(text)) s.cur = "GBP";

  /* GSTINs: first = seller, second = buyer (usual print order). */
  const gstins = [...text.matchAll(GSTIN_RE)].map((m) => m[1]);
  if (gstins.length >= 1) {
    s.biz.gstin = gstins[0];
    notes.push({ field: "Seller GSTIN", found: gstins[0] });
  }
  if (gstins.length >= 2) {
    s.cli.gstin = gstins[1];
    notes.push({ field: "Buyer GSTIN", found: gstins[1] });
  }

  /* Invoice number. */
  const invNo = text.match(INVNO_RE);
  if (invNo?.[1]) {
    s.no = invNo[1];
    notes.push({ field: "Invoice number", found: invNo[1] });
  }

  /* Date: first date-ish token on a line mentioning date. */
  const dateLine = cleanPages
    .flatMap((p) => p.split("\n"))
    .find((line) => /\bdate|dated\b/i.test(line) && DATE_RE.test(line));
  const dateHit = dateLine?.match(DATE_RE)?.[0];
  if (dateHit) {
    s.date = toIso(dateHit);
    if (s.date) notes.push({ field: "Invoice date", found: dateHit });
  }

  /* Total: the largest money value on a "total" line, else the largest. */
  const moneyLines = cleanPages
    .flatMap((p) => p.split("\n"))
    .filter((line) => TOTAL_RE.test(line));
  const totalCandidates: number[] = [];
  for (const line of moneyLines) {
    for (const m of line.matchAll(MONEY_RE)) {
      const v = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(v)) totalCandidates.push(v);
    }
  }
  if (totalCandidates.length > 0) {
    const grand = Math.max(...totalCandidates);
    s.d = "0";
    s.tr = "0";
    notes.push({
      field: "Grand total found",
      found: s.cur === "INR" ? `₹${grand.toFixed(2)}` : grand.toFixed(2),
    });
    // Park the total in the single-item placeholder — the surface shows
    // it as "1 item = grand total" and the user refines.
    s.items.push({
      d: "Items from the PDF (edit as needed)",
      h: "",
      q: "1",
      r: grand.toFixed(2),
      g: "0",
    });
  }

  /* Tax rate hints — CGST + SGST halves combine to the full GST rate. */
  const cg: number[] = [];
  const sg: number[] = [];
  const ig: number[] = [];
  for (const m of text.matchAll(TAXP_RE)) {
    const v = parseFloat(m[2]);
    if (!Number.isFinite(v)) continue;
    const kind = m[1].toUpperCase();
    if (kind === "CGST") cg.push(v);
    else if (kind === "SGST") sg.push(v);
    else ig.push(v);
  }
  let rate = 0;
  if (cg.length > 0 && sg.length > 0) {
    rate = Math.max(...cg) + Math.max(...sg);
  } else if (ig.length > 0) {
    rate = Math.max(...ig);
  } else if (cg.length > 0 || sg.length > 0) {
    rate = 2 * Math.max(...(cg.length > 0 ? cg : sg));
  }
  if (rate > 0) {
    s.tr = String(rate);
    notes.push({ field: "GST rate hint", found: `${rate}%` });
  }

  /* Party names: line right after a Bill To / Seller marker. */
  const lines = cleanPages
    .flatMap((p) => p.split("\n"))
    .map((l) => l.trim());
  const afterMarker = (re: RegExp): string => {
    const i = lines.findIndex((l) => re.test(l));
    if (i === -1) return "";
    const ok = (v: string): string => {
      const cleaned = v.replace(/^[#*:.\-–—\s]+/, "").slice(0, 80);
      return /^[A-Za-z\u0900-\u097F][\w .,&'()\-/]{1,79}$/.test(cleaned)
        ? cleaned
        : "";
    };
    // Prefer the marker's own line remainder (common: "Bill to Name…").
    const m = lines[i].match(re);
    if (m !== null && m.index !== undefined) {
      const same = ok(lines[i].slice(m.index + m[0].length));
      if (same !== "") return same;
    }
    return ok(lines[i + 1] ?? "");
  };
  const buyer = afterMarker(BUYER_RE);
  const seller = afterMarker(SELLER_RE);
  if (seller) {
    s.biz.name = seller;
    notes.push({ field: "Seller name", found: seller });
  }
  if (buyer) {
    s.cli.name = buyer;
    notes.push({ field: "Buyer name", found: buyer });
  }

  return {
    state: s,
    notes,
    empty: notes.length === 0,
  };
}
