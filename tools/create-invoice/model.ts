/**
 * Create invoice — pure model (P3-INVOICE).
 *
 * Ported EXACTLY from the user's standalone invoice-generator
 * (upload/invoice-generator.zip → assets/app.js, the CORE block),
 * because that engine was already correct: every money value is an
 * integer number of paise/cents (P), every intermediate is rounded with
 * the double-guard R(x) = Math.round(+x.toFixed(6)) (kills binary-float
 * drift like 0.535*100 → 53.49999…), discounts are distributed pro-rata
 * with the LAST item absorbing the rounding remainder (Σ shares == the
 * discount exactly), CGST/SGST split at rt/2 with the same rounding, and
 * the round-off delta is reported separately. The smoke script
 * (scripts/smoke-create-invoice.ts) re-proves all of this with vectors.
 *
 * Also owns: number → words (INR Crore/Lakh system vs Billion/Million),
 * the GSTIN checksum (base-36, official algorithm), invoice-number
 * bumping (trailing digit group, width-preserving), the April–March
 * financial-year prefix, GST compliance warnings and the worker-boundary
 * parser/serializer. PURE: no DOM, no storage, no imports beyond types.ts.
 */

import type { InvoiceCurrency, InvoiceTypeDef, InvoiceTypeId } from "./types";
import { INVOICE_TYPES } from "./types";

/* ------------------------------------------------------------------ */
/* Money primitives (exact port)                                        */
/* ------------------------------------------------------------------ */

/**
 * Round to the nearest integer after clamping float noise at 6 decimals.
 * `Math.round(2.5)` = 3 but `Math.round(53.499999999)` must be 53 → the
 * toFixed(6) step guarantees the intended half-up on clean decimals.
 */
export const R = (x: number): number => Math.round(Number(x.toFixed(6)));

/** Parse a user string into integer paise/cents ("" → 0, garbage → 0). */
export const P = (v: string): number => R((parseFloat(v) || 0) * 100);

/* ------------------------------------------------------------------ */
/* State shape (mirrors the standalone app's `S`)                       */
/* ------------------------------------------------------------------ */

export interface InvoiceItem {
  /** Description (multi-line allowed). */
  d: string;
  /** HSN / SAC code (GST family only). */
  h: string;
  /** Quantity (free-form numeric string — printed verbatim). */
  q: string;
  /** Rate as a decimal string. */
  r: string;
  /** Per-item GST % (GST family only). */
  g: string;
}

export interface InvoiceBiz {
  name: string;
  addr: string;
  gstin: string;
  state: string;
  phone: string;
  email: string;
  bank: string;
  upi: string;
  /** PNG data-URL, ≤300 px wide (resize happens in the surface). */
  logo: string;
  /** PNG data-URL signature. */
  sig: string;
}

export interface InvoiceCli {
  name: string;
  addr: string;
  gstin: string;
  state: string;
}

export interface InvoiceState {
  ty: InvoiceTypeId;
  cur: InvoiceCurrency;
  biz: InvoiceBiz;
  cli: InvoiceCli;
  /** Place of supply (GST state code). */
  pos: string;
  no: string;
  /** ISO yyyy-mm-dd strings. */
  date: string;
  due: string;
  valid: string;
  /** Discount mode: "%" of subtotal or "f" flat amount. */
  dMode: "%" | "f";
  /** Discount value (string). */
  d: string;
  /** Single tax % for the standard family. */
  tr: string;
  /** Round the grand total to a whole currency unit. */
  ro: boolean;
  /** Advance / amount received (string). */
  adv: string;
  /** Payment-status stamp text ("PAID", "" …). */
  st: string;
  notes: string;
  terms: string;
  /** Up to 3 type-specific extra header values. */
  xv: [string, string, string];
  items: InvoiceItem[];
}

export function typeDef(ty: string): InvoiceTypeDef {
  return (
    INVOICE_TYPES[ty as InvoiceTypeId] ?? INVOICE_TYPES["gst-invoice"]
  );
}

/* ------------------------------------------------------------------ */
/* The calculation (exact port of calc())                              */
/* ------------------------------------------------------------------ */

export interface InvoiceLine extends InvoiceItem {
  /** Line amount = R(qty × rate) in paise. */
  amt: number;
  /** Taxable base = amt − pro-rata discount share. */
  tb: number;
  /** Applied tax rate % (0 for no-tax types). */
  rt: number;
  cg: number;
  sg: number;
  ig: number;
  t: number;
}

export interface InvoiceCalc {
  /** Lines enriched with amounts (order preserved). */
  L: InvoiceLine[];
  /** GST family (HSN, per-item rates, CGST/SGST/IGST split). */
  g: boolean;
  /** No-tax type (bill of supply, receipts, challan). */
  nt: boolean;
  /** No-price type (delivery challan). */
  np: boolean;
  /** Σ line amounts. */
  sub: number;
  /** Discount actually applied (clamped to [0, sub]). */
  disc: number;
  /** Σ taxable bases after discount. */
  tb: number;
  cg: number;
  sg: number;
  ig: number;
  /** Standard-family tax total. */
  tx: number;
  /** Round-off delta (tot − grand). */
  ro: number;
  /** Grand total. */
  tot: number;
  /** Same-state supply (CGST+SGST) — blank states count as intra. */
  intra: boolean;
  /** Advance applied (clamped to [0, tot]). */
  adv: number;
  /** Balance due = tot − adv. */
  bal: number;
}

export function calc(s: InvoiceState): InvoiceCalc {
  const def = typeDef(s.ty);
  const g = def.fam === "gst";
  const nt = def.nt === true;
  const np = def.np === true;

  const L: InvoiceLine[] = s.items.map((i) => ({
    ...i,
    amt: R((parseFloat(i.q) || 0) * P(i.r)),
  }));
  const sub = L.reduce((a, l) => a + l.amt, 0);
  const dv = parseFloat(s.d) || 0;
  const disc = Math.max(
    0,
    Math.min(
      sub,
      s.dMode === "%" ? R((sub * Math.min(dv, 100)) / 100) : P(dv)
    )
  );
  const intra = !s.biz.state || !s.pos || s.biz.state === s.pos;

  let rem = disc;
  let tb = 0;
  let cg = 0;
  let sg = 0;
  let ig = 0;
  let tx = 0;
  L.forEach((l, k) => {
    const sh =
      k === L.length - 1 ? rem : R((disc * l.amt) / (sub || 1));
    rem -= sh;
    l.tb = l.amt - sh;
    const rt = nt
      ? 0
      : g
        ? parseFloat(l.g) || 0
        : parseFloat(s.tr) || 0;
    l.rt = rt;
    l.cg = l.sg = l.ig = l.t = 0;
    if (!g) l.t = R((l.tb * rt) / 100);
    else if (intra) l.cg = l.sg = R((l.tb * rt) / 200);
    else l.ig = R((l.tb * rt) / 100);
    tb += l.tb;
    cg += l.cg;
    sg += l.sg;
    ig += l.ig;
    tx += l.t;
  });

  const gr = tb + cg + sg + ig + tx;
  const tot = s.ro ? R(gr / 100) * 100 : gr;
  const adv = Math.min(P(s.adv), tot);
  return {
    L,
    g,
    nt,
    np,
    sub,
    disc,
    tb,
    cg,
    sg,
    ig,
    tx,
    ro: tot - gr,
    tot,
    intra,
    adv,
    bal: tot - adv,
  };
}

/* ------------------------------------------------------------------ */
/* Number → words (exact port)                                         */
/* ------------------------------------------------------------------ */

const ON = "|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen".split(
  "|"
);
const TN = "||Twenty|Thirty|Forty|Fifty|Sixty|Seventy|Eighty|Ninety".split("|");

const w2 = (n: number): string =>
  n < 20 ? ON[n] : TN[(n / 10) | 0] + (n % 10 ? " " + ON[n % 10] : "");
const w3 = (n: number): string =>
  (n > 99 ? ON[(n / 100) | 0] + " Hundred" + (n % 100 ? " " : "") : "") +
  (n % 100 ? w2(n % 100) : "");

const CN: Record<InvoiceCurrency, [string, string]> = {
  INR: ["Rupees", "Paise"],
  USD: ["Dollars", "Cents"],
  EUR: ["Euros", "Cents"],
  GBP: ["Pounds", "Pence"],
};

/**
 * Paise → "Rupees One Crore … and Fifty Paise Only".
 * INR uses the Crore/Lakh/Thousand system; others Billion/Million.
 */
export function words(p: number, cur: InvoiceCurrency): string {
  let n = Math.floor(p / 100);
  const c = p % 100;
  const o: string[] = [];
  const groups: readonly [number, string][] =
    cur === "INR"
      ? [
          [1e7, "Crore"],
          [1e5, "Lakh"],
          [1e3, "Thousand"],
        ]
      : [
          [1e9, "Billion"],
          [1e6, "Million"],
          [1e3, "Thousand"],
        ];
  for (const [v, name] of groups) {
    if (n >= v) {
      o.push(w3(Math.floor(n / v)) + " " + name);
      n %= v;
    }
  }
  if (n || !o.length) o.push(n ? w3(n) : "Zero");
  return (
    CN[cur][0] +
    " " +
    o.join(" ") +
    (c ? " and " + w2(c) + " " + CN[cur][1] : "") +
    " Only"
  );
}

/* ------------------------------------------------------------------ */
/* GSTIN checksum (exact port)                                         */
/* ------------------------------------------------------------------ */

const AL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Official GSTIN mod-36 checksum (15th char). */
export function gstOK(g: string): boolean {
  if (!GSTIN_RE.test(g)) return false;
  let s = 0;
  for (let i = 0; i < 14; i++) {
    const v = AL.indexOf(g[i]) * (i % 2 ? 2 : 1);
    s += Math.floor(v / 36) + (v % 36);
  }
  return AL[(36 - (s % 36)) % 36] === g[14];
}

/* ------------------------------------------------------------------ */
/* Invoice numbering (exact port)                                      */
/* ------------------------------------------------------------------ */

/**
 * Increment the trailing digit group, preserving its width:
 * "INV/25-26/009" → "INV/25-26/010", "A-9" → "A-10".
 * No digits at all (or empty) → "INV-001".
 */
export function bump(s: string): string {
  return s && /\d/.test(s)
    ? s.replace(/(\d+)(?!.*\d)/, (m) =>
        String(Number(m) + 1).padStart(m.length, "0")
      )
    : "INV-001";
}

/** April–March financial year from an ISO date: "2025-06-01" → "25-26". */
export function fy(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return String(start).slice(2) + "-" + String(start + 1).slice(2);
}

/**
 * Next number for a type: bump the last saved number for THIS type, else
 * the fresh prefix form — GST family "INV/25-26/001", standard "INV-001".
 */
export function nextNo(
  ty: InvoiceTypeId,
  date: string,
  last: Record<string, string> | undefined
): string {
  const def = typeDef(ty);
  const l = last?.[ty];
  return l
    ? bump(l)
    : def.pf + (def.fam === "gst" ? "/" + fy(date) + "/" : "-") + "001";
}

/* ------------------------------------------------------------------ */
/* Dates (exact port)                                                  */
/* ------------------------------------------------------------------ */

/** Local today as ISO yyyy-mm-dd (timezone-safe). */
export function today(): string {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 6e4)
    .toISOString()
    .slice(0, 10);
}

/** Today + n days as ISO yyyy-mm-dd. */
export function plus(n: number): string {
  const x = new Date();
  x.setDate(x.getDate() + n);
  return new Date(x.getTime() - x.getTimezoneOffset() * 6e4)
    .toISOString()
    .slice(0, 10);
}

/** ISO yyyy-mm-dd → dd/mm/yyyy for the sheet. */
export function fd(d: string): string {
  return d ? d.split("-").reverse().join("/") : "";
}

/* ------------------------------------------------------------------ */
/* GST compliance warnings (exact port)                                 */
/* ------------------------------------------------------------------ */

/** Warning i18n keys + item context — the surface joins them with t(). */
export interface InvoiceWarning {
  key: string;
  /** 1-based item number for item-scoped warnings. */
  item?: number;
}

/** GST rates that do NOT trigger the "unusual rate" warning. */
export const OK_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

const NO_RE = /^[A-Za-z0-9/-]{1,16}$/;
const HSN_RE = /^(\d{4}|\d{6}|\d{8})$/;

export function warnings(s: InvoiceState, c: InvoiceCalc): InvoiceWarning[] {
  const def = typeDef(s.ty);
  const W: InvoiceWarning[] = [];
  if (!c.g) return W;
  if (!NO_RE.test(s.no || "")) W.push({ key: "wno" });
  s.items.forEach((i, k) => {
    if (i.h && !HSN_RE.test(i.h))
      W.push({ key: "wh", item: k + 1 });
    if (
      !c.nt &&
      i.g !== "" &&
      !OK_GST_RATES.includes(Number(i.g))
    )
      W.push({ key: "wr", item: k + 1 });
  });
  if (s.biz.gstin && s.biz.state && s.biz.gstin.slice(0, 2) !== s.biz.state)
    W.push({ key: "wst" });
  if (!c.np && def.gd && c.tot > 5e6) W.push({ key: "wew" });
  return W;
}

/* ------------------------------------------------------------------ */
/* Money formatting (surface preview + worker PDF, identical recipe)    */
/* ------------------------------------------------------------------ */

/** Paise → "1,23,456.78" (en-IN grouping for INR). */
export function formatMoney(
  p: number,
  cur: InvoiceCurrency,
  locale?: string
): string {
  const loc = locale ?? (cur === "INR" ? "en-IN" : "en-US");
  return (p / 100).toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ------------------------------------------------------------------ */
/* Block order (sheet section drag-reorder)                             */
/* ------------------------------------------------------------------ */

export const BLOCK_KEYS = [
  "hd",
  "bt",
  "it",
  "tt",
  "wd",
  "bank",
  "notes",
  "terms",
  "sig",
] as const;

export type BlockKey = (typeof BLOCK_KEYS)[number];

export function sanitizeBlockOrder(ord: unknown): BlockKey[] {
  if (!Array.isArray(ord)) return BLOCK_KEYS.slice();
  const wanted = BLOCK_KEYS.filter((k) => ord.includes(k));
  const extra = ord.filter(
    (k): k is BlockKey =>
      typeof k === "string" &&
      (BLOCK_KEYS as readonly string[]).includes(k) &&
      !wanted.includes(k as BlockKey)
  );
  const out = [...wanted, ...extra];
  return out.length === BLOCK_KEYS.length ? out : BLOCK_KEYS.slice();
}

/* ------------------------------------------------------------------ */
/* Worker boundary: serialize + defensive parse                        */
/* ------------------------------------------------------------------ */

/** Hard caps mirrored from the standalone app (50 saved × sane sizes). */
export const MAX_ITEMS = 200;
export const MAX_IMG_DATAURL = 1_500_000; // ~1.5 MB base64
const DATAURL_PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function img(v: unknown): string {
  return typeof v === "string" &&
    v.length <= MAX_IMG_DATAURL &&
    (v === "" || DATAURL_PNG_RE.test(v))
    ? v
    : "";
}

function item(v: unknown): InvoiceItem {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    d: str(o.d, 2000),
    h: str(o.h, 16),
    q: str(o.q, 32),
    r: str(o.r, 32),
    g: str(o.g, 8),
  };
}

/**
 * Parse a serialized InvoiceState (used by the smoke script). Everything
 * untrusted is clamped/validated — a tampered payload can never reach the
 * PDF renderer as a wrong type, an oversized image or an unknown block
 * order. Unreadable JSON falls back to the gst-invoice defaults.
 */
export function parseInvoiceOption(raw: string): InvoiceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return coerceInvoiceState(parsed);
}

/** Output file name: invoice number (sanitized) or "invoice". */
export function outputBaseName(s: InvoiceState): string {
  const base = (s.no || "invoice").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "invoice";
}

/* ------------------------------------------------------------------ */
/* Worker run payload                                                  */
/* ------------------------------------------------------------------ */

/**
 * Labels the SURFACE pre-resolves through the app i18n (t()) and ships
 * with the run, so the worker never re-resolves keys — the PDF text and
 * the live preview are guaranteed to say the same thing in the current
 * language. Required keys: no, date, due, valid, pos, bt (incl. the type's
 * bill-to override), ttl (type title), desc/qty/rate (incl. type
 * overrides), hsn, tb, gp, amt, sub, disc2, cg, sg, ig, tx, rof, tot, wd,
 * for, sig, bank, notes, terms, adv, bal, x0/x1/x2 (extra fields).
 */
export type InvoiceLabels = Record<string, string>;

export interface InvoiceRun {
  s: InvoiceState;
  ord: BlockKey[];
  /** Accent colour, "#rrggbb". */
  ac: string;
  labels: InvoiceLabels;
}

const AC_RE = /^#[0-9a-fA-F]{6}$/;

function coerceInvoiceState(v: unknown): InvoiceState {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const b = (typeof o.biz === "object" && o.biz !== null ? o.biz : {}) as Record<string, unknown>;
  const cl = (typeof o.cli === "object" && o.cli !== null ? o.cli : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? o.items.slice(0, MAX_ITEMS).map(item)
    : [];

  const ty = (
    typeof o.ty === "string" && o.ty in INVOICE_TYPES ? o.ty : "gst-invoice"
  ) as InvoiceTypeId;
  const cur = (
    ["INR", "USD", "EUR", "GBP"] as const
  ).includes(o.cur as InvoiceCurrency)
    ? (o.cur as InvoiceCurrency)
    : "INR";

  const xv = Array.isArray(o.xv) ? o.xv : [];
  return {
    ty,
    cur,
    biz: {
      name: str(b.name, 200),
      addr: str(b.addr, 600),
      gstin: str(b.gstin, 15).toUpperCase(),
      state: str(b.state, 2),
      phone: str(b.phone, 40),
      email: str(b.email, 120),
      bank: str(b.bank, 600),
      upi: str(b.upi, 120),
      logo: img(b.logo),
      sig: img(b.sig),
    },
    cli: {
      name: str(cl.name, 200),
      addr: str(cl.addr, 600),
      gstin: str(cl.gstin, 15).toUpperCase(),
      state: str(cl.state, 2),
    },
    pos: str(o.pos, 2),
    no: str(o.no, 32),
    date: str(o.date, 10),
    due: str(o.due, 10),
    valid: str(o.valid, 10),
    dMode: o.dMode === "f" ? "f" : "%",
    d: str(o.d, 32),
    tr: str(o.tr, 32),
    ro: o.ro === true,
    adv: str(o.adv, 32),
    st: str(o.st, 24),
    notes: str(o.notes, 2000),
    terms: str(o.terms, 2000),
    xv: [str(xv[0], 200), str(xv[1], 200), str(xv[2], 200)],
    items: items.length ? items : [item({})],
  };
}

/**
 * Parse the serialized `inv` option (the run wrapper) into a fully-coerced
 * payload. Everything untrusted is clamped/validated — a tampered payload
 * can never reach the PDF renderer as a wrong type, an oversized image or
 * an unknown block order. Unreadable JSON falls back to gst-invoice
 * defaults so the worker always produces a valid PDF.
 */
export function parseInvoiceRun(raw: string): InvoiceRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as
    Record<string, unknown>;
  const labels: InvoiceLabels = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= 16) labels[k] = v.slice(0, 300);
    }
  }
  const ac = typeof o.ac === "string" && AC_RE.test(o.ac) ? o.ac : "#0b6b4d";
  return {
    s: coerceInvoiceState(o.s),
    ord: sanitizeBlockOrder(o.ord),
    ac,
    labels,
  };
}

/* ------------------------------------------------------------------ */
/* UPI QR payload (exact port of the qr() call site)                    */
/* ------------------------------------------------------------------ */

/**
 * upi://pay?pa=…&pn=…&am=…&cu=INR&tn=… — the standard deep link every
 * UPI app understands. Amount in plain rupees (2 decimals).
 */
export function upiPayload(
  pa: string,
  pn: string,
  totPaise: number,
  no: string
): string {
  const params = new URLSearchParams({
    pa,
    pn: pn || "",
    am: (totPaise / 100).toFixed(2),
    cu: "INR",
    tn: "Invoice " + no,
  });
  return "upi://pay?" + params.toString();
}
