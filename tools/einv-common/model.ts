/**
 * Shared e-invoice FORM model (P12-EINVOICE — the create-electronic-invoice /
 * pdf-to-e-invoice / validate-e-invoice family).
 *
 * A deliberately lean invoice: only the fields the EN 16931 core needs
 * (seller, buyer, dates, currency, lines with one tax rate each, one
 * payment account, one note). Everything the user types is a string —
 * the surface validates, `compute()` does the money maths in integer
 * minor units (the create-invoice paise pattern) so the preview, the
 * CII XML and the rendered PDF can never disagree.
 *
 * Pure TypeScript: identical in the surface (validation preview), the
 * worker (XML + PDF build) and bun (smoke).
 */

export interface EInvPartyForm {
  name: string;
  street: string;
  street2: string;
  city: string;
  postcode: string;
  country: string;
  taxId: string;
  taxScheme: "VA" | "IN";
  email: string;
}

export interface EInvLineForm {
  key: string;
  desc: string;
  qty: string;
  unit: string;
  price: string;
  rate: string;
}

export type EInvTypeCode = "380" | "381" | "383";

export interface EInvFormState {
  number: string;
  type: EInvTypeCode;
  issue: string;
  due: string;
  currency: string;
  seller: EInvPartyForm;
  buyer: EInvPartyForm;
  lines: EInvLineForm[];
  iban: string;
  accountName: string;
  upi: string;
  notes: string;
}

export const EINV_MAX_LINES = 300;

/** UN/ECE Recommendation 20 unit codes we offer (label keys live in i18n). */
export const EINV_UNITS: { code: string; key: string }[] = [
  { code: "C62", key: "einv.unitPcs" },
  { code: "HUR", key: "einv.unitHour" },
  { code: "KGM", key: "einv.unitKg" },
  { code: "GRM", key: "einv.unitG" },
  { code: "MTR", key: "einv.unitM" },
  { code: "MTK", key: "einv.unitM2" },
  { code: "MTQ", key: "einv.unitM3" },
  { code: "LTR", key: "einv.unitL" },
  { code: "DZN", key: "einv.unitDozen" },
  { code: "BX", key: "einv.unitBox" },
  { code: "PK", key: "einv.unitPack" },
  { code: "SET", key: "einv.unitSet" },
  { code: "DAY", key: "einv.unitDay" },
  { code: "MON", key: "einv.unitMonth" },
];

export const EINV_CURRENCIES: string[] = [
  "INR",
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "AED",
  "AUD",
  "CAD",
  "SGD",
  "JPY",
];

/** ISO 4217 active currency codes (validation only — no network). */
export const ISO_CURRENCIES = new Set<string>([
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT",
  "BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD","CAD",
  "CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD",
  "EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ",
  "GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD",
  "JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR",
  "LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR",
  "MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN",
  "PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR",
  "SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB",
  "TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS",
  "VES","VND","VUV","WST","XAF","XCD","XOF","XPF","YER","ZAR","ZMW","ZWL",
]);

let keySeq = 0;
export function lineKey(): string {
  keySeq += 1;
  return `l${Date.now().toString(36)}${keySeq}`;
}

export function defaultForm(): EInvFormState {
  return {
    number: "",
    type: "380",
    issue: "",
    due: "",
    currency: "INR",
    seller: {
      name: "",
      street: "",
      street2: "",
      city: "",
      postcode: "",
      country: "IN",
      taxId: "",
      taxScheme: "IN",
      email: "",
    },
    buyer: {
      name: "",
      street: "",
      street2: "",
      city: "",
      postcode: "",
      country: "IN",
      taxId: "",
      taxScheme: "IN",
      email: "",
    },
    lines: [{ key: lineKey(), desc: "", qty: "1", unit: "C62", price: "", rate: "18" }],
    iban: "",
    accountName: "",
    upi: "",
    notes: "",
  };
}

/* ------------------------------------------------------------------ */
/* Coercion (worker side) — never trust the options JSON                */
/* ------------------------------------------------------------------ */

const MAX_TEXT = 400;

function str(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function partyOf(value: unknown, fallback: EInvPartyForm): EInvPartyForm {
  if (typeof value !== "object" || value === null) return fallback;
  const v = value as Record<string, unknown>;
  return {
    name: str(v.name),
    street: str(v.street, 160),
    street2: str(v.street2, 160),
    city: str(v.city, 80),
    postcode: str(v.postcode, 16),
    country: str(v.country, 2).toUpperCase(),
    taxId: str(v.taxId, 32),
    taxScheme: v.taxScheme === "VA" ? "VA" : "IN",
    email: str(v.email, 120),
  };
}

/** Clamp + normalize the surface's serialized form (worker + smoke input). */
export function coerceForm(value: unknown): EInvFormState {
  const base = defaultForm();
  if (typeof value !== "object" || value === null) return base;
  const v = value as Record<string, unknown>;

  const linesRaw = Array.isArray(v.lines) ? v.lines : [];
  const lines: EInvLineForm[] = linesRaw
    .slice(0, EINV_MAX_LINES)
    .map((raw) => {
      const l = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const unit = EINV_UNITS.some((u) => u.code === str(l.unit, 8)) ? str(l.unit, 8) : "C62";
      return {
        key: str(l.key, 24) || lineKey(),
        desc: str(l.desc, 300),
        qty: str(l.qty, 24),
        unit,
        price: str(l.price, 24),
        rate: str(l.rate, 12),
      };
    });
  if (lines.length === 0) {
    lines.push({ key: lineKey(), desc: "", qty: "1", unit: "C62", price: "", rate: "18" });
  }

  const type =
    v.type === "381" || v.type === "383" ? (v.type as EInvTypeCode) : "380";

  return {
    number: str(v.number, 64),
    type,
    issue: str(v.issue, 10),
    due: str(v.due, 10),
    currency: str(v.currency, 8).toUpperCase() || "INR",
    seller: partyOf(v.seller, base.seller),
    buyer: partyOf(v.buyer, base.buyer),
    lines,
    iban: str(v.iban, 42).replace(/\s+/g, "").toUpperCase(),
    accountName: str(v.accountName, 80),
    upi: str(v.upi, 80),
    notes: str(v.notes, 600),
  };
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                      */
/* ------------------------------------------------------------------ */

/** Strict decimal ("12", "12.5", ".5"); returns null when invalid. */
export function parseAmount(value: string): number | null {
  const t = value.trim();
  if (t === "") return null;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

/* ------------------------------------------------------------------ */
/* The money maths — integer minor units, never FP-drift                */
/* ------------------------------------------------------------------ */

export interface EInvLineComputed {
  index: number;
  desc: string;
  qty: number;
  unit: string;
  price: number;
  rate: number;
  /** Minor units (paise/cents): round(qty × price). */
  net: number;
}

export interface EInvTaxComputed {
  rate: number;
  /** Minor units of the category basis. */
  basis: number;
  /** Minor units of the category tax. */
  tax: number;
}

export interface EInvComputed {
  lines: EInvLineComputed[];
  taxes: EInvTaxComputed[];
  /** Minor units. */
  lineTotal: number;
  taxTotal: number;
  grand: number;
  decimals: number;
}

function minor(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / 1;
}

/** Compute everything from the FORM (unit: minor units). */
export function computeForm(form: EInvFormState): EInvComputed {
  const decimals = form.currency === "JPY" ? 0 : 2;
  const lines: EInvLineComputed[] = [];
  for (let i = 0; i < form.lines.length; i += 1) {
    const l = form.lines[i];
    const qty = parseAmount(l.qty) ?? Number.NaN;
    const price = parseAmount(l.price) ?? Number.NaN;
    const rate = parseAmount(l.rate) ?? Number.NaN;
    if (!Number.isFinite(qty) || !Number.isFinite(price) || !Number.isFinite(rate)) continue;
    if (l.desc.trim() === "" || qty <= 0 || price < 0 || rate < 0 || rate > 100) continue;
    const net = minor(qty * price, decimals);
    lines.push({
      index: i,
      desc: l.desc.trim(),
      qty,
      unit: l.unit,
      price,
      rate,
      net,
    });
  }

  // Group by rate (integer basis sums, then one tax per rate).
  const byRate = new Map<number, number>();
  for (const l of lines) {
    byRate.set(l.rate, (byRate.get(l.rate) ?? 0) + l.net);
  }
  const taxes: EInvTaxComputed[] = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, basis]) => ({
      rate,
      basis,
      tax: Math.round((basis * rate) / 100),
    }));

  const lineTotal = lines.reduce((a, l) => a + l.net, 0);
  const taxTotal = taxes.reduce((a, t) => a + t.tax, 0);
  return { lines, taxes, lineTotal, taxTotal, grand: lineTotal + taxTotal, decimals };
}

/* ------------------------------------------------------------------ */
/* Form-level validation (surface preview + run gate)                    */
/* ------------------------------------------------------------------ */

export type EInvFormIssue =
  | "number"
  | "date"
  | "dueOrder"
  | "sellerName"
  | "buyerName"
  | "currency"
  | "country"
  | "noLines"
  | "line"
  | "taxIdMissing";

export interface EInvFormReport {
  issues: EInvFormIssue[];
  /** Line indices with a fillable problem (empty desc / bad qty / bad price). */
  lineIssues: number[];
  valid: boolean;
  /** Advice that does not block the run. */
  warnings: EInvFormIssue[];
}

export function validateForm(form: EInvFormState): EInvFormReport {
  const issues: EInvFormIssue[] = [];
  const warnings: EInvFormIssue[] = [];
  const lineIssues: number[] = [];

  if (form.number.trim() === "") issues.push("number");
  if (!isValidDate(form.issue)) issues.push("date");
  if (form.due.trim() !== "" && isValidDate(form.due) && form.due < form.issue) {
    warnings.push("dueOrder");
  }
  if (form.seller.name.trim() === "") issues.push("sellerName");
  if (form.buyer.name.trim() === "") issues.push("buyerName");
  if (!/^[A-Z]{3}$/.test(form.currency) || !ISO_CURRENCIES.has(form.currency)) {
    issues.push("currency");
  }
  for (const p of [form.seller, form.buyer]) {
    if (p.country !== "" && !/^[A-Z]{2}$/.test(p.country)) issues.push("country");
  }

  const computed = computeForm(form);
  if (computed.lines.length === 0) {
    issues.push("noLines");
  } else if (computed.lines.length !== form.lines.length) {
    issues.push("line");
    for (let i = 0; i < form.lines.length; i += 1) {
      const l = form.lines[i];
      const qty = parseAmount(l.qty);
      const price = parseAmount(l.price);
      const rate = parseAmount(l.rate);
      if (
        l.desc.trim() === "" ||
        qty === null ||
        qty <= 0 ||
        price === null ||
        price < 0 ||
        rate === null ||
        rate < 0 ||
        rate > 100
      ) {
        lineIssues.push(i);
      }
    }
  }

  if (
    form.seller.taxId.trim() === "" &&
    computed.taxes.some((t) => t.rate > 0)
  ) {
    warnings.push("taxIdMissing");
  }

  return { issues, lineIssues, valid: issues.length === 0, warnings };
}
