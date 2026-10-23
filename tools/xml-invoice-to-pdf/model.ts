/**
 * XML e-invoice to PDF (RB5-d — 87th tool) — PURE model. No DOM globals at
 * runtime, no pdf-lib, no worker APIs: the same parseCii feeds the surface's
 * live parse report AND the worker's render, so the chips can never
 * disagree with the PDF.
 *
 *  - parseXmlDocument: a dependency-free, namespace-tolerant XML tree
 *    builder (comments, CDATA, DOCTYPE, PIs, entities, self-closing).
 *    DOMParser is NOT available in bun (and only optionally in workers),
 *    so the tool ships its own; parseXmlText prefers the browser's real
 *    DOMParser when it exists and falls back to this one — both produce
 *    the same XmlElem shape.
 *  - parseCii: rsm:CrossIndustryInvoice → ParsedInvoice. Missing nodes
 *    become parse ISSUES, never throws — the renderer draws what exists.
 *    Local-name matching only ("rsm:ID", "ID", "x:ID" are all "ID"), so
 *    ZUGFeRD 1.0 (:10), 2.x / Factur-X (:100) and XRechnung all read.
 *  - needsNoto / isWinAnsi: pure-WinAnsi content → non-embedded base-14
 *    Helvetica; ANY Devanagari (or ₹) switches those RUNS to the
 *    self-hosted Noto Sans Devanagari (render.ts splits mixed strings).
 *  - Layout planning: tableColumns + computeRows + planHeader + planBuyer
 *    with an injected `measure(text, size, bold)` — pagination is decided
 *    here, ink is decided in render.ts.
 *
 * Honest limits (mirrored in config.ts): UBL 2.1 (Invoice/CreditNote root)
 * is detected and rejected with a clear error; notes render as small
 * footer text only; embedded attachments (Factur-X PDF/A-3 parts) are
 * ignored; 80 line items max, 10 MB XML max.
 */

import type {
  InvoiceLabelMap,
  InvoiceLine,
  ParsedInvoice,
  ParseIssue,
  PartyAddress,
  PartyInfo,
  TaxSummary,
  XmlElem,
  XmlParseResult,
} from "./types";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the worker + surface)                         */
/* ------------------------------------------------------------------ */

export const MAX_LINES = 80; // rendered rows — more are omitted with a note
export const MAX_XML_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_TEXT = 300; // per parsed text field
export const MAX_NOTES = 6; // IncludedNote elements read
export const MAX_NOTE_CHARS = 1200; // total note characters rendered
export const MAX_TAX_RATES = 8; // header ApplicableTradeTax rows
export const MAX_TAX_IDS = 2; // party tax registrations rendered

/* ------------------------------------------------------------------ */
/* Shared geometry (render.ts replays these exact numbers)              */
/* ------------------------------------------------------------------ */

export const GEO = {
  margin: 40,
  fs: 9,
  lh: 12.6,
  fsBig: 11.25,
  fsTitle: 18,
  fsSmall: 8,
  lhSmall: 11,
  pad: 4.5,
  /** reserved band at the bottom of every page for "Page N / M". */
  footerReserve: 24,
  /** gap after the header's accent rule. */
  headerGap: 10,
  /** gap after the buyer block. */
  buyerGap: 12,
  tableHeaderH: 4.5 * 2 + 12.6,
  noCol: 24,
  qtyCol: 64,
  taxCol: 40,
  amtCol: 80,
  /** totals block width (right column). */
  totalsW: 210,
} as const;

/* ------------------------------------------------------------------ */
/* XML parser (bun-safe, namespace-tolerant)                            */
/* ------------------------------------------------------------------ */

const WS_RE = /\s/;

function isWs(ch: string): boolean {
  return WS_RE.test(ch);
}

function localPart(name: string): string {
  const at = name.indexOf(":");
  return at >= 0 ? name.slice(at + 1) : name;
}

/** Attribute lookup by local name — "unitCode" also matches "ram:unitCode". */
export function attrValue(el: XmlElem | null, localName: string): string {
  if (!el) return "";
  const exact = el.attrs[localName];
  if (exact !== undefined) return exact;
  const suffix = ":" + localName;
  for (const key of Object.keys(el.attrs)) {
    if (key.endsWith(suffix)) return el.attrs[key] ?? "";
  }
  return "";
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z#][a-zA-Z0-9]*);/g, (m, inner) => {
    if (inner === "amp") return "&";
    if (inner === "lt") return "<";
    if (inner === "gt") return ">";
    if (inner === "quot") return '"';
    if (inner === "apos") return "'";
    if (inner.length > 2 && inner[1] === "x") {
      const cp = Number.parseInt(inner.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (inner.startsWith("#")) {
      const cp = Number.parseInt(inner.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return m; // unknown entity — kept literal (CDATA covers exotic text)
  });
}

interface MutableElem {
  localName: string;
  children: MutableElem[];
  ownText: string;
  attrs: Record<string, string>;
}

/** Bottom-up textContent (DOM semantics: own text + descendants). */
function freezeText(node: MutableElem): XmlElem {
  let text = node.ownText;
  const children = node.children.map((c) => freezeText(c));
  for (const c of children) text += c.textContent;
  return {
    localName: node.localName,
    children,
    textContent: text,
    attrs: node.attrs,
  };
}

/**
 * Parse an XML string into the minimal XmlElem tree. Strict enough that
 * real files parse and garbage fails honestly:
 *  - first non-whitespace char must be "<" → else "not-xml";
 *  - comments, CDATA, `<?…?>` PIs and `<!DOCTYPE …[…]>` are skipped;
 *  - close tags must match their open tag (qualified names);
 *  - one root element; only whitespace may follow it.
 */
export function parseXmlDocument(xml: string): XmlParseResult {
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const n = src.length;
  let i = 0;
  while (i < n && isWs(src[i] ?? "")) i += 1;
  if (i >= n || src[i] !== "<") return { ok: false, reason: "not-xml" };

  const stack: { name: string; node: MutableElem }[] = [];
  let root: MutableElem | null = null;
  let rootClosed = false;
  const malformed = { ok: false as const, reason: "malformed" as const };

  const readName = (): string => {
    const start = i;
    while (i < n && !/[\s/>]/.test(src[i] ?? "")) i += 1;
    return src.slice(start, i);
  };
  const skipWs = (): void => {
    while (i < n && isWs(src[i] ?? "")) i += 1;
  };

  while (i < n) {
    const ch = src[i];
    if (ch !== "<") {
      // text run — belongs to the innermost open element
      const start = i;
      while (i < n && src[i] !== "<") i += 1;
      const text = decodeEntities(src.slice(start, i));
      const top = stack[stack.length - 1];
      if (top) top.node.ownText += text;
      else if (text.trim() !== "") return malformed; // text outside the root
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) return malformed;
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) return malformed;
      const top = stack[stack.length - 1];
      if (top) top.node.ownText += src.slice(i + 9, end); // raw — no entities
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) return malformed;
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE (with optional internal subset […]) — skipped entirely
      i += 2;
      let depth = 0;
      while (i < n) {
        const c = src[i];
        if (c === "[") depth += 1;
        else if (c === "]") depth = Math.max(0, depth - 1);
        else if (c === ">" && depth === 0) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (src.startsWith("</", i)) {
      i += 2;
      skipWs();
      const name = readName();
      skipWs();
      if (i >= n || src[i] !== ">" || name === "") return malformed;
      i += 1;
      const top = stack.pop();
      if (!top || top.name !== name) return malformed;
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    // open tag
    i += 1;
    const name = readName();
    if (name === "" || /[<>&]/.test(name)) return malformed;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    for (;;) {
      skipWs();
      if (i >= n) return malformed;
      const c = src[i];
      if (c === ">") {
        i += 1;
        break;
      }
      if (c === "/") {
        if (!src.startsWith("/>", i)) return malformed;
        selfClose = true;
        i += 2;
        break;
      }
      const aStart = i;
      while (i < n && !/[\s=/>]/.test(src[i] ?? "")) i += 1;
      const aName = src.slice(aStart, i);
      if (aName === "") return malformed;
      skipWs();
      let aVal = "";
      if (src[i] === "=") {
        i += 1;
        skipWs();
        const q = src[i];
        if (q === '"' || q === "'") {
          i += 1;
          const vStart = i;
          while (i < n && src[i] !== q) i += 1;
          if (i >= n) return malformed;
          aVal = decodeEntities(src.slice(vStart, i));
          i += 1;
        } else {
          const vStart = i;
          while (i < n && !/[\s/>]/.test(src[i] ?? "")) i += 1;
          aVal = decodeEntities(src.slice(vStart, i));
        }
      }
      if (attrs[aName] === undefined) attrs[aName] = aVal;
    }
    const node: MutableElem = { localName: localPart(name), children: [], ownText: "", attrs };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.node.children.push(node);
    } else {
      if (root !== null || rootClosed) return malformed; // second root
      root = node;
    }
    if (!selfClose) stack.push({ name, node });
    else if (stack.length === 0) rootClosed = true;
  }

  if (stack.length > 0) return malformed; // unclosed elements
  if (!root) return malformed; // only prolog — no document element
  if (!rootClosed) return malformed;
  return { ok: true, root: freezeText(root) };
}

/**
 * The WORKER's parse entry. Prefers the browser's real DOMParser when the
 * global exists (module workers in modern Chromium), otherwise the
 * self-contained parser above (bun smokes, older engines). Both paths
 * produce the same XmlElem tree, so parseCii cannot tell them apart.
 */
export function parseXmlText(xml: string): XmlParseResult {
  const ctor = (globalThis as { DOMParser?: unknown }).DOMParser;
  if (typeof ctor === "function") {
    try {
      const doc = new (ctor as new () => DOMParser)().parseFromString(xml, "text/xml");
      const errors = doc.getElementsByTagName("parsererror");
      const rootEl = doc.documentElement;
      if (errors.length > 0 || !rootEl) return { ok: false, reason: "malformed" };
      return { ok: true, root: domToXmlElem(rootEl) };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  return parseXmlDocument(xml);
}

/** Convert a real DOMParser document element into our XmlElem shape. */
export function domToXmlElem(el: Element): XmlElem {
  const children: XmlElem[] = [];
  for (let i = 0; i < el.children.length; i += 1) {
    const c = el.children[i];
    if (c) children.push(domToXmlElem(c));
  }
  const attrs: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i += 1) {
    const a = el.attributes[i];
    if (a) attrs[a.name] = a.value;
  }
  return {
    localName: el.localName,
    children,
    textContent: el.textContent ?? "",
    attrs,
  };
}

/** Cheap sniff: something that could be XML (leading "<" + tag-ish char). */
export function looksLikeXml(text: string): boolean {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  while (i < src.length && isWs(src[i] ?? "")) i += 1;
  if (i >= src.length || src[i] !== "<") return false;
  return i + 1 < src.length && /[!?a-zA-Z_]/.test(src[i + 1] ?? "");
}

/** Root-level classification (after a successful parse). */
export function classifyRoot(root: XmlElem): "xinv.errUbl" | "xinv.errNotCii" | null {
  if (root.localName === "CrossIndustryInvoice") return null;
  // UBL 2.1 document roots — honestly unsupported, detected up front.
  if (root.localName === "Invoice" || root.localName === "CreditNote") {
    return "xinv.errUbl";
  }
  return "xinv.errNotCii";
}

/** Full classification for the worker's error paths (null = good to go). */
export function classifyXmlError(text: string, parsed: XmlParseResult): string | null {
  if (!looksLikeXml(text)) return "xinv.errNotXml";
  if (!parsed.ok) {
    return parsed.reason === "not-xml" ? "xinv.errNotXml" : "xinv.errMalformed";
  }
  return classifyRoot(parsed.root);
}

/* ------------------------------------------------------------------ */
/* WinAnsi / Devanagari detection (house recipe)                        */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiChar(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WINANSI_EXTRA.has(code);
}

export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (!isWinAnsiChar(s.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * True when a code point is covered by the Noto Sans Devanagari face but
 * NOT by WinAnsi: the Devanagari block, the U+20B9 rupee sign and the
 * ZWJ/ZWNJ joiners (zero-width, but they must ride the Noto run).
 */
export function needsNotoChar(code: number): boolean {
  return (
    (code >= 0x0900 && code <= 0x097f) ||
    code === 0x20b9 ||
    code === 0x200c ||
    code === 0x200d
  );
}

/** Does this string contain a run that must be drawn with Noto? */
export function needsNoto(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (!isWinAnsiChar(c) && needsNotoChar(c)) return true;
  }
  return false;
}

/**
 * Draw-safe text: strip controls (keep the \n/\t the layout consumes),
 * replace scripts neither font covers (CJK, Thai …) with "?" — honest,
 * visible, and it keeps the Helvetica encode from ever throwing — and
 * apply the pinned word-to-pdf lesson: ASCII double quotes are dropped
 * from strings that contain Devanagari (Noto subset CMaps inject stray
 * quotes there). Capped at `max` with a real ellipsis.
 */
export function sanitizeText(s: string, max = MAX_TEXT): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 9) {
      out += ch;
      continue;
    }
    if (code < 32 || code === 0x7f) continue;
    if (!isWinAnsiChar(code) && !needsNotoChar(code)) {
      out += "?";
      continue;
    }
    out += ch;
  }
  const deva = /[\u0900-\u097f]/.test(out);
  if (deva) out = out.split('"').join("");
  if (out.length > max) out = out.slice(0, max - 1) + "…";
  return out;
}

/** Every string the renderer can draw, for the single font decision. */
export function collectDrawnText(inv: ParsedInvoice, labels: InvoiceLabelMap): string {
  const parts: string[] = [];
  for (const v of Object.values(labels)) parts.push(v);
  const party = (p: PartyInfo): void => {
    parts.push(p.name, p.tradingName, p.id, p.phone, p.email, p.uri);
    parts.push(p.taxIds.join(" "));
    parts.push(
      p.address.line1,
      p.address.line2,
      p.address.line3,
      p.address.city,
      p.address.postcode,
      p.address.country,
      p.address.subdivision
    );
  };
  party(inv.seller);
  party(inv.buyer);
  parts.push(
    inv.meta.number,
    inv.meta.typeCode,
    inv.meta.issueDate,
    inv.meta.dueDate,
    inv.meta.deliveryDate,
    inv.meta.currency,
    inv.meta.buyerReference,
    inv.meta.notes.join(" ")
  );
  parts.push(inv.payment.reference, inv.payment.iban, inv.payment.accountName, inv.payment.bic, inv.payment.meansCode);
  for (const t of inv.taxes) parts.push(String(t.rate ?? ""), t.category);
  parts.push(
    String(inv.totals.lineTotal ?? ""),
    String(inv.totals.chargeTotal ?? ""),
    String(inv.totals.allowanceTotal ?? ""),
    String(inv.totals.taxBasisTotal ?? ""),
    String(inv.totals.taxTotal ?? ""),
    String(inv.totals.grandTotal ?? ""),
    String(inv.totals.prepaid ?? ""),
    String(inv.totals.duePayable ?? "")
  );
  for (const l of inv.lines) {
    parts.push(l.lineId, l.name, l.description, l.sellerAssignedId, l.unitCode);
    parts.push(String(l.quantity ?? ""), String(l.netAmount ?? ""), String(l.unitPrice ?? ""), String(l.taxRate ?? ""), l.taxCategory);
  }
  return parts.join("\n");
}

/** The single font decision (powerpoint-to-pdf pattern: labels included). */
export function invoiceNeedsNoto(inv: ParsedInvoice, labels: InvoiceLabelMap): boolean {
  return (
    needsNoto(collectDrawnText(inv, labels)) ||
    needsNoto(currencySymbol(inv.meta.currency))
  );
}

/* ------------------------------------------------------------------ */
/* Code maps (units, document types, payment means)                     */
/* ------------------------------------------------------------------ */

/** Common UN/ECE Rec. 20 unit codes (subset — the rest show their raw code). */
const UNIT_LABELS: Record<string, string> = {
  C62: "piece",
  EA: "each",
  HUR: "hour",
  DAY: "day",
  MON: "month",
  ANN: "year",
  KGM: "kg",
  GRM: "g",
  MTR: "m",
  CMT: "cm",
  MMT: "mm",
  KMT: "km",
  LTR: "l",
  MTQ: "m³",
  CMQ: "cm³",
  MTK: "m²",
  KWH: "kWh",
  P1: "%",
  TNE: "t",
  SET: "set",
  NAR: "number",
};

/** "C62" → "piece"; unknown codes return themselves (the invoice's own unit). */
export function unitCodeLabel(code: string): string {
  const c = code.trim().toUpperCase();
  if (c === "") return "";
  return UNIT_LABELS[c] ?? c;
}

/** UNTDID 1001 subset (the codes that actually matter on invoices). */
const TYPE_LABELS: Record<string, string> = {
  "325": "Proforma invoice",
  "380": "Invoice",
  "381": "Credit note",
  "382": "Debit note",
  "383": "Corrected invoice",
  "384": "Prepayment invoice",
};

export function invoiceTypeLabel(code: string): string {
  return TYPE_LABELS[code] ?? "";
}

export function knownTypeCode(code: string): boolean {
  return TYPE_LABELS[code] !== undefined;
}

/** UNTB 4461 subset — payment means type codes. */
const MEANS_LABELS: Record<string, string> = {
  "30": "Credit transfer",
  "48": "Bank card",
  "49": "Direct debit",
  "58": "SEPA credit transfer",
  "59": "SEPA direct debit",
  "97": "Payment between partners",
};

export function paymentMeansLabel(code: string): string {
  const c = code.trim();
  return c === "" ? "" : MEANS_LABELS[c] ?? c;
}

/* ------------------------------------------------------------------ */
/* Currency + quantity + date formatting                                */
/* ------------------------------------------------------------------ */

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CHF: "CHF",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  AED: "AED",
};

/** "₹" for INR, "$" for USD …; unknown ISO codes return themselves. */
export function currencySymbol(code: string): string {
  const c = code.trim().toUpperCase();
  return CURRENCY_SYMBOLS[c] ?? c;
}

/** Indian grouping (1,23,456.78) or international (1,234,567.89). */
export function groupNumber(value: number, style: "in" | "int"): string {
  // toFixed(6) guard kills binary-float drift (create-invoice's R()).
  const cents = Math.round(Number((value * 100).toFixed(6)));
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, "0");
  let grouped: string;
  if (style === "in" && whole.length > 3) {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = rest + "," + last3;
  } else {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return sign + grouped + "." + frac;
}

/** "₹ 2,60,000.00" / "$ 1,234.56" / "AUD 98.00"; null → "". */
export function currencyFmt(amount: number | null, code: string): string {
  if (amount === null || !Number.isFinite(amount)) return "";
  const grouped = groupNumber(Math.abs(amount), code.trim().toUpperCase() === "INR" ? "in" : "int");
  const sym = currencySymbol(code);
  return (amount < 0 ? "-" : "") + sym + "\u00a0" + grouped;
}

/** "40 piece" / "160 hour" / "2.5 kg" — unknown units show their raw code. */
export function formatQty(q: number | null, unitCode: string): string {
  if (q === null || !Number.isFinite(q)) return "";
  const qty = Number.isInteger(q) ? String(q) : String(q).replace(/0+$/, "").replace(/\.$/, "");
  const label = unitCodeLabel(unitCode);
  return label === "" ? qty : qty + " " + label;
}

/** Rate for totals rows: 18 → "18%", 4.5 → "4.5%", 0 → "0%". */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "";
  const t = String(Number(rate.toFixed(2)));
  return t + "%";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * CII date (DateTimeString, format 102 = CCYYMMDD) → "15 Mar 2026".
 * Anything else (other formats, invalid dates) is returned as-is —
 * honest rather than guessed.
 */
export function formatCiiDate(raw: string, format?: string): string {
  const digits = raw.trim();
  if ((format ?? "102") === "102" && /^\d{8}$/.test(digits)) {
    const y = Number(digits.slice(0, 4));
    const m = Number(digits.slice(4, 6));
    const d = Number(digits.slice(6, 8));
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return d + " " + (MONTHS[m - 1] ?? "") + " " + y;
    }
  }
  return digits;
}

/* ------------------------------------------------------------------ */
/* CII traversal helpers                                                */
/* ------------------------------------------------------------------ */

function child(el: XmlElem | null, name: string): XmlElem | null {
  if (!el) return null;
  for (const c of el.children) {
    if (c.localName === name) return c;
  }
  return null;
}

function childAll(el: XmlElem | null, name: string): XmlElem[] {
  if (!el) return [];
  return el.children.filter((c) => c.localName === name);
}

function textOf(el: XmlElem | null, max = MAX_TEXT): string {
  return el ? sanitizeText(el.textContent.trim(), max) : "";
}

function childText(parent: XmlElem | null, name: string, max = MAX_TEXT): string {
  return textOf(child(parent, name), max);
}

function num(el: XmlElem | null): number | null {
  if (!el) return null;
  const t = el.textContent.trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function ciiDate(el: XmlElem | null): string {
  if (!el) return "";
  const s = child(el, "DateTimeString");
  return formatCiiDate(s ? s.textContent.trim() : el.textContent.trim(), s ? attrValue(s, "format") : "102");
}

/* ------------------------------------------------------------------ */
/* parseCii — the CII reader (missing nodes → issues, never throws)     */
/* ------------------------------------------------------------------ */

function emptyAddress(): PartyAddress {
  return { line1: "", line2: "", line3: "", city: "", postcode: "", country: "", subdivision: "" };
}

function parseAddress(el: XmlElem | null): PartyAddress {
  const a = child(el, "PostalTradeAddress") ?? el;
  return {
    line1: childText(a, "LineOne", 120),
    line2: childText(a, "LineTwo", 120),
    line3: childText(a, "LineThree", 120),
    city: childText(a, "CityName", 80),
    postcode: childText(a, "PostcodeCode", 20),
    country: childText(a, "CountryID", 2),
    subdivision: childText(a, "CountrySubdivisionName", 60),
  };
}

function hasAddress(a: PartyAddress): boolean {
  return Boolean(a.line1 || a.line2 || a.line3 || a.city || a.postcode || a.country);
}

function parseParty(el: XmlElem | null): PartyInfo {
  const party = el;
  const org = child(party, "SpecifiedLegalOrganization");
  const contact = child(party, "DefinedTradeContact");
  const taxIds = childAll(party, "SpecifiedTaxRegistration")
    .map((r) => textOf(child(r, "ID"), 40))
    .filter(Boolean)
    .slice(0, MAX_TAX_IDS);
  return {
    name: childText(party, "Name", 200),
    id: childText(org, "ID", 40) || childText(party, "ID", 40),
    tradingName: childText(org, "TradingBusinessName", 160),
    taxIds,
    phone: childText(child(contact, "TelephoneUniversalCommunication"), "CompleteNumber", 40),
    email: childText(child(contact, "EmailURIUniversalCommunication"), "URIID", 120),
    uri: childText(child(party, "URIUniversalCommunication"), "URIID", 160),
    address: parseAddress(party),
  };
}

function parseLine(el: XmlElem | null, issues: ParseIssue[]): InvoiceLine {
  const doc = child(el, "AssociatedDocumentLineDocument");
  const product = child(el, "SpecifiedTradeProduct");
  const agreement = child(el, "SpecifiedLineTradeAgreement");
  const delivery = child(el, "SpecifiedLineTradeDelivery");
  const settlement = child(el, "SpecifiedLineTradeSettlement");
  const qtyEl = child(delivery, "BilledQuantity");
  const amount = num(
    child(child(settlement, "SpecifiedTradeSettlementLineMonetarySummation"), "LineTotalAmount")
  );
  if (amount === null) issues.push({ code: "missLineAmount" });
  return {
    lineId: childText(doc, "LineID", 12),
    name: childText(product, "Name", 200),
    description: childText(product, "Description", 500),
    sellerAssignedId: childText(product, "SellerAssignedID", 40),
    quantity: num(qtyEl),
    unitCode: sanitizeText(attrValue(qtyEl, "unitCode"), 8).toUpperCase(),
    netAmount: amount,
    unitPrice: num(child(child(agreement, "NetPriceProductTradePrice"), "ChargeAmount")),
    taxRate: num(child(child(settlement, "ApplicableTradeTax"), "RateApplicablePercent")),
    taxCategory: childText(child(settlement, "ApplicableTradeTax"), "CategoryCode", 8),
  };
}

function parseTax(el: XmlElem | null): TaxSummary {
  return {
    rate: num(child(el, "RateApplicablePercent")),
    category: childText(el, "CategoryCode", 8),
    basis: num(child(el, "BasisAmount")),
    amount: num(child(el, "CalculatedAmount")),
  };
}

function parseTotals(el: XmlElem | null): ParsedInvoice["totals"] {
  const n2 = (name: string): number | null => num(child(el, name));
  return {
    lineTotal: n2("LineTotalAmount"),
    chargeTotal: n2("ChargeTotalAmount"),
    allowanceTotal: n2("AllowanceTotalAmount"),
    taxBasisTotal: n2("TaxBasisTotalAmount"),
    taxTotal: n2("TaxTotalAmount"),
    grandTotal: n2("GrandTotalAmount"),
    prepaid: n2("TotalPrepaidAmount"),
    duePayable: n2("DuePayableAmount"),
  };
}

/**
 * Read a CII tree into the ParsedInvoice model. Namespace-tolerant
 * (local names only), defensive on every field (missing → ""/null with an
 * issue note, never a throw): the renderer draws whatever exists.
 */
export function parseCii(root: XmlElem): ParsedInvoice {
  const issues: ParseIssue[] = [];
  const docEl = child(root, "ExchangedDocument");
  const tx = child(root, "SupplyChainTradeTransaction");
  const agreement = child(tx, "ApplicableHeaderTradeAgreement");
  const headerDelivery = child(tx, "ApplicableHeaderTradeDelivery");
  const settlement = child(tx, "ApplicableHeaderTradeSettlement");
  const means = child(settlement, "SpecifiedTradeSettlementPaymentMeans");
  const account = child(means, "PayeePartyCreditorFinancialAccount");
  const bank = child(means, "PayeeSpecifiedCreditorFinancialInstitution");

  const meta: ParsedInvoice["meta"] = {
    number: childText(docEl, "ID", 40),
    typeCode: childText(docEl, "TypeCode", 6),
    issueDate: ciiDate(child(docEl, "IssueDateTime")),
    dueDate: ciiDate(child(child(settlement, "SpecifiedTradePaymentTerms"), "DueDateDateTime")),
    deliveryDate: ciiDate(
      child(child(headerDelivery, "ActualDeliverySupplyChainEvent"), "OccurrenceDateTime")
    ),
    currency: childText(settlement, "InvoiceCurrencyCode", 8).toUpperCase(),
    buyerReference: childText(agreement, "BuyerReference", 80),
    notes: childAll(docEl, "IncludedNote")
      .map((note) => textOf(child(note, "Content"), 600))
      .filter(Boolean)
      .slice(0, MAX_NOTES),
  };

  if (meta.number === "") issues.push({ code: "missNumber" });
  if (meta.issueDate === "") issues.push({ code: "missDate" });
  if (meta.typeCode === "") issues.push({ code: "missType" });
  if (meta.currency === "") issues.push({ code: "missCurrency" });

  const seller = parseParty(child(agreement, "SellerTradeParty"));
  const buyer = parseParty(child(agreement, "BuyerTradeParty"));
  if (seller.name === "" && seller.tradingName === "") issues.push({ code: "missSellerName" });
  if (!hasAddress(seller.address)) issues.push({ code: "missSellerAddr" });
  if (buyer.name === "") issues.push({ code: "missBuyerName" });
  if (!hasAddress(buyer.address)) issues.push({ code: "missBuyerAddr" });

  const allLines = childAll(tx, "IncludedSupplyChainTradeLineItem");
  const totalLineCount = allLines.length;
  const capped = allLines.slice(0, MAX_LINES);
  const lines = capped.map((l) => parseLine(l, issues));
  if (totalLineCount === 0) issues.push({ code: "missLines" });
  const truncated = totalLineCount > MAX_LINES;
  if (truncated) issues.push({ code: "lineCap" });

  const taxes = childAll(settlement, "ApplicableTradeTax")
    .slice(0, MAX_TAX_RATES)
    .map((t) => parseTax(t));
  if (taxes.length === 0) issues.push({ code: "missTax" });

  const totals = parseTotals(child(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation"));
  if (totals.grandTotal === null && totals.lineTotal === null) {
    issues.push({ code: "missTotals" });
  }

  const payment: ParsedInvoice["payment"] = {
    reference: childText(settlement, "PaymentReference", 80),
    meansCode: childText(means, "TypeCode", 6),
    iban: childText(account, "IBANID", 40),
    accountName: childText(account, "AccountName", 120),
    bic: childText(bank, "BICID", 20),
  };
  if (payment.reference === "" && payment.iban === "") {
    issues.push({ code: "missPayment" });
  }

  return {
    meta,
    seller,
    buyer,
    lines,
    taxes,
    totals,
    payment,
    issues,
    truncated,
    totalLineCount,
  };
}

/** True when nothing renderable was found at all (worker → honest error). */
export function invoiceIsEmpty(inv: ParsedInvoice): boolean {
  return (
    inv.seller.name === "" &&
    inv.buyer.name === "" &&
    inv.lines.length === 0 &&
    inv.totals.grandTotal === null
  );
}

/* ------------------------------------------------------------------ */
/* Output name                                                          */
/* ------------------------------------------------------------------ */

function sanitizeFileToken(s: string, max: number): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, max)
    .replace(/[-. ]+$/g, "");
}

/** "invoice-<ExchangedDocument/ID>.pdf" — sanitized, honest fallbacks. */
export function outputPdfName(invoiceNumber: string, fileWord: string): string {
  const token =
    sanitizeFileToken(invoiceNumber.trim(), 60) ||
    sanitizeFileToken(fileWord.trim(), 40) ||
    "document";
  return `invoice-${token}.pdf`;
}

/* ------------------------------------------------------------------ */
/* Label map coercion (the worker boundary)                             */
/* ------------------------------------------------------------------ */

/** Parse the serialized `labels` option — every value sanitized for draw. */
export function parseInvoiceLabels(raw: string): InvoiceLabelMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const out: InvoiceLabelMap = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= 24) {
        out[k] = sanitizeText(v, 200);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Layout planning (pure — `measure` is injected by render.ts)          */
/* ------------------------------------------------------------------ */

export type MeasureFn = (text: string, size: number, bold?: boolean) => number;

/** Word-wrap honouring explicit \n; a single over-long word overflows. */
export function wrapText(
  text: string,
  width: number,
  size: number,
  measure: MeasureFn,
  maxLines = 99
): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line === "" ? word : line + " " + word;
      if (line === "" || measure(next, size) <= width) {
        line = next;
      } else {
        out.push(line);
        line = word;
        if (out.length >= maxLines) return out;
      }
    }
    if (out.length >= maxLines) return out;
    if (line !== "") out.push(line);
  }
  return out.length > 0 ? out.slice(0, maxLines) : [];
}

/** Column plan: # | Item (flex) | Qty | Tax? | Amount. */
export interface TableCols {
  no: number;
  item: number;
  qty: number;
  tax: number;
  amount: number;
  showTax: boolean;
}

export function tableColumns(contentW: number, showTax: boolean): TableCols {
  const { noCol, qtyCol, taxCol, amtCol } = GEO;
  const fixed = noCol + qtyCol + amtCol + (showTax ? taxCol : 0);
  return {
    no: noCol,
    item: contentW - fixed,
    qty: qtyCol,
    tax: showTax ? taxCol : 0,
    amount: amtCol,
    showTax,
  };
}

/** One planned table row (all text pre-wrapped, height pre-computed). */
export interface PlannedRow {
  no: number;
  nameLines: string[];
  subLines: string[];
  qty: string;
  tax: string;
  amount: string;
  height: number;
}

export interface RowCtx {
  contentW: number;
  measure: MeasureFn;
  /** ISO currency code for the per-line amounts (from InvoiceCurrencyCode). */
  currency: string;
  /** y space for rows on page 1 (after header + buyer + table header). */
  firstAvail: number;
  /** y space on continuation pages (after repeated header + table header). */
  contAvail: number;
  /** rows rendered max (MAX_LINES). */
  rowCap: number;
}

export interface RowsPlan {
  cols: TableCols;
  pages: PlannedRow[][];
  shown: number;
  total: number;
  truncated: boolean;
}

function buildRow(
  line: InvoiceLine,
  no: number,
  cols: TableCols,
  measure: MeasureFn,
  currency: string,
  maxLines: number
): PlannedRow {
  const itemW = cols.item - 2 * GEO.pad;
  const name = line.name !== "" ? line.name : line.sellerAssignedId;
  const nameLines = name !== "" ? wrapText(name, itemW, GEO.fs, measure, 3) : [];
  const sub: string[] = [];
  if (line.name !== "" && line.sellerAssignedId !== "") sub.push(line.sellerAssignedId);
  if (line.description !== "") sub.push(line.description);
  const subWanted = sub.length > 0 ? wrapText(sub.join("\n"), itemW, GEO.fs, measure, 5) : [];
  const budget = Math.max(1, maxLines - nameLines.length);
  const subLines = subWanted.slice(0, Math.max(0, budget));
  const lineCount = Math.max(1, nameLines.length + subLines.length);
  return {
    no,
    nameLines,
    subLines,
    qty: formatQty(line.quantity, line.unitCode),
    tax: line.taxRate === null ? "" : formatRate(line.taxRate),
    amount: currencyFmt(line.netAmount, currency),
    height: lineCount * GEO.lh + 2 * GEO.pad,
  };
}

/**
 * Row pagination: fills page 1 with `firstAvail` height, then breaks to
 * fresh pages of `contAvail`. A row that alone cannot fit a fresh page
 * has its wrapped lines clamped so the table can never overflow the page.
 */
export function computeRows(lines: readonly InvoiceLine[], ctx: RowCtx): RowsPlan {
  const showTax = lines.some((l) => l.taxRate !== null);
  const cols = tableColumns(ctx.contentW, showTax);
  const total = lines.length;
  const cap = Math.max(0, Math.min(ctx.rowCap, total));
  const pages: PlannedRow[][] = [[]];
  let avail = ctx.firstAvail;
  let shown = 0;
  for (let idx = 0; idx < cap; idx += 1) {
    const line = lines[idx];
    if (!line) continue;
    const page = pages[pages.length - 1] ?? [];
    const freshCap = Math.max(
      1,
      Math.floor((avail - 2 * GEO.pad) / GEO.lh)
    );
    const row = buildRow(line, shown + 1, cols, ctx.measure, ctx.currency, Math.max(1, freshCap));
    if (page.length > 0 && row.height > avail) {
      pages.push([]);
      avail = ctx.contAvail;
    }
    const target = pages[pages.length - 1];
    if (target) target.push(row);
    avail -= row.height;
    shown += 1;
  }
  return {
    cols,
    pages: pages.filter((p) => p.length > 0),
    shown,
    total,
    truncated: total > cap,
  };
}

/* ------------------------------------------------------------------ */
/* Header + buyer planning (heights the renderer replays exactly)       */
/* ------------------------------------------------------------------ */

export interface SheetLine {
  text: string;
  size: number;
  h: number;
  bold?: boolean;
  muted?: boolean;
}

export interface HeaderPlan {
  left: SheetLine[];
  right: { label: string; value: string; valueBold?: boolean }[];
  title: string;
  height: number;
}

function pushSellerLine(left: SheetLine[], text: string): void {
  if (text === "") return;
  left.push({ text, size: GEO.fs, h: GEO.lh, muted: true });
}

export function planHeader(
  inv: ParsedInvoice,
  labels: InvoiceLabelMap,
  contentW: number,
  measure: MeasureFn
): HeaderPlan {
  const l = (key: string, fallback = ""): string => labels[key] ?? fallback;
  const left: SheetLine[] = [];
  const seller = inv.seller;
  const sellerName = seller.name || seller.tradingName;
  if (sellerName !== "") {
    left.push({ text: sellerName, size: GEO.fsBig, h: GEO.fsBig + 4, bold: true });
  }
  if (seller.name !== "" && seller.tradingName !== "" && seller.tradingName !== seller.name) {
    pushSellerLine(left, seller.tradingName);
  }
  const a = seller.address;
  if (a.line1) pushSellerLine(left, a.line1);
  if (a.line2) pushSellerLine(left, a.line2);
  if (a.line3) pushSellerLine(left, a.line3);
  const cityLine = [a.postcode, a.city].filter(Boolean).join(" ");
  if (cityLine) pushSellerLine(left, cityLine);
  const regionLine = [a.subdivision, a.country].filter(Boolean).join(", ");
  if (regionLine) pushSellerLine(left, regionLine);
  const contact = [seller.phone, seller.email].filter(Boolean).join("  ·  ");
  if (contact) pushSellerLine(left, contact);
  for (const taxId of seller.taxIds) {
    pushSellerLine(left, l("taxId", "Tax ID") + ": " + taxId);
  }
  if (seller.id !== "") {
    pushSellerLine(left, l("regNo", "Reg. no.") + ": " + seller.id);
  }
  // defensive cap: the masthead never eats the page
  while (left.length > 8) left.pop();

  const right: { label: string; value: string; valueBold?: boolean }[] = [];
  if (inv.meta.number !== "") {
    right.push({ label: l("no", "No.") + ": ", value: inv.meta.number, valueBold: true });
  }
  if (inv.meta.issueDate !== "") {
    right.push({ label: l("date", "Date") + ": ", value: inv.meta.issueDate });
  }
  if (inv.meta.dueDate !== "") {
    right.push({ label: l("dueDate", "Due date") + ": ", value: inv.meta.dueDate });
  }
  if (inv.meta.currency !== "") {
    right.push({ label: l("currency", "Currency") + ": ", value: inv.meta.currency });
  }
  if (inv.meta.typeCode !== "" && !knownTypeCode(inv.meta.typeCode)) {
    right.push({ label: l("docType", "Type code") + ": ", value: inv.meta.typeCode });
  }

  const code = inv.meta.typeCode;
  const title =
    l("ttl" + code) ||
    invoiceTypeLabel(code).toUpperCase() ||
    l("ttl", "INVOICE");

  // measure-driven sanity: the title must fit the right half or it shrinks
  let titleSize = GEO.fsTitle;
  const maxTitleW = contentW * 0.45;
  while (titleSize > GEO.fs && measure(title, titleSize, true) > maxTitleW) {
    titleSize -= 1;
  }

  const leftH = left.reduce((acc, s) => acc + s.h, 0);
  const rightH = GEO.fsTitle + 6 + right.length * GEO.lh;
  return {
    left,
    right,
    title,
    height: Math.max(leftH, rightH) + 6,
  };
}

export interface BuyerPlan {
  left: SheetLine[];
  right: { label: string; value: string }[];
  height: number;
}

export function planBuyer(
  inv: ParsedInvoice,
  labels: InvoiceLabelMap,
  contentW: number,
  measure: MeasureFn
): BuyerPlan {
  const l = (key: string, fallback = ""): string => labels[key] ?? fallback;
  const buyer = inv.buyer;
  const left: SheetLine[] = [];
  const addr = [buyer.address.line1, buyer.address.line2, buyer.address.line3]
    .filter(Boolean)
    .join("\n");
  const cityLine = [buyer.address.postcode, buyer.address.city].filter(Boolean).join(" ");
  const regionLine = [buyer.address.subdivision, buyer.address.country].filter(Boolean).join(", ");
  const buyerText = [addr, cityLine, regionLine].filter(Boolean).join("\n");
  const buyerLines = buyerText !== "" ? wrapText(buyerText, contentW * 0.62, GEO.fs, measure, 6) : [];
  if (buyer.name !== "") {
    left.push({ text: l("billTo", "Bill to"), size: GEO.fs, h: GEO.lh, muted: true });
    left.push({ text: buyer.name, size: GEO.fs, h: GEO.lh + 2, bold: true });
  }
  for (const line of buyerLines) {
    left.push({ text: line, size: GEO.fs, h: GEO.lh });
  }
  for (const taxId of buyer.taxIds) {
    left.push({ text: l("taxId", "Tax ID") + ": " + taxId, size: GEO.fs, h: GEO.lh, muted: true });
  }

  const right: { label: string; value: string }[] = [];
  if (inv.meta.buyerReference !== "") {
    right.push({ label: l("yourRef", "Your reference") + ": ", value: inv.meta.buyerReference });
  }
  if (inv.meta.deliveryDate !== "") {
    right.push({ label: l("deliveryDate", "Delivery date") + ": ", value: inv.meta.deliveryDate });
  }
  const leftH = left.reduce((acc, s) => acc + s.h, 0);
  const rightH = right.length * GEO.lh;
  return {
    left,
    right,
    height: Math.max(leftH, rightH) + GEO.buyerGap,
  };
}
