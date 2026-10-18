/**
 * Create invoice — the 39-template catalog (P3-INVOICE).
 *
 * Ported EXACTLY from the user's standalone invoice-generator
 * (upload/invoice-generator.zip → assets/types.js), with one deliberate
 * change for proper DocoPDF integration: every display label that the
 * original kept as a raw English string (type names, sheet titles, extra
 * header fields, column labels, bill-to labels, default terms) is now an
 * i18n KEY resolved through the app catalog (section "invoice"). In the
 * standalone app those strings bypassed the translator and stayed English
 * even in the Hindi UI — here every one of them has a real हिंदी string,
 * so the Hindi invoice is fully Hindi. The DATA (prefixes, families, flags,
 * group order) is untouched — the numbering, tax behaviour and warnings
 * reproduce the original byte-for-byte.
 *
 * Pure data — no imports, no DOM, no storage. Shared by the surface
 * (form + live preview), the worker (PDF render) and the smoke script.
 */

/* ------------------------------------------------------------------ */
/* Catalog types                                                       */
/* ------------------------------------------------------------------ */

/** What the date column under the invoice number shows. */
export type InvoiceDateKind = "due" | "valid" | "none";

/** Tax family: "gst" = India GST columns (HSN, per-item GST %). */
export type InvoiceFamily = "gst" | "std";

export interface InvoiceTypeDef {
  /** Type name i18n key (invoice.ty-<slug>) for the dropdown. */
  readonly n: string;
  readonly fam: InvoiceFamily;
  /** Sheet title i18n key (invoice.tt-<slug>) — merged EN + हिंदी title. */
  readonly ttl: string;
  /** Invoice-number prefix (e.g. "INV", "CN"). */
  readonly pf: string;
  /** Up to 3 extra header fields — i18n keys; "" hides the slot. */
  readonly x?: readonly [string, string, string];
  /** Goods document → the ₹50,000 e-way bill warning applies. */
  readonly gd?: true;
  /** Default terms i18n key (applied while the user has not typed any). */
  readonly tm?: string;
  readonly dt: InvoiceDateKind;
  /** No tax columns at all (receipts, bill of supply, challan). */
  readonly nt?: true;
  /** No prices (delivery challan) — qty + description only. */
  readonly np?: true;
  /** Bill-to label i18n key override (default invoice.bt "Bill to"). */
  readonly bl?: string;
  /** Qty column label i18n key override (default invoice.qty). */
  readonly ql?: string;
  /** Rate column label i18n key override (default invoice.rate). */
  readonly rl?: string;
  /** Description label i18n key override (default invoice.desc). */
  readonly dl?: string;
  /** Payment-status stamp printed rotated on the sheet ("PAID"…). */
  readonly st?: string;
}

/* ------------------------------------------------------------------ */
/* The 39 types (order = the original catalog order)                   */
/* ------------------------------------------------------------------ */

export const INVOICE_TYPES = {
  "gst-invoice": {
    n: "ty-gst-invoice",
    fam: "gst",
    ttl: "tt-gst-invoice",
    pf: "INV",
    x: ["xl-po", "xl-vehicle", "xl-rev-charge"],
    gd: true,
    tm: "tm-due15",
    dt: "due",
  },
  "bill-of-supply": {
    n: "ty-bill-of-supply",
    fam: "gst",
    ttl: "tt-bill-of-supply",
    pf: "BOS",
    nt: true,
    tm: "tm-bos",
    dt: "none",
  },
  "export-invoice": {
    n: "ty-export-invoice",
    fam: "gst",
    ttl: "tt-export-invoice",
    pf: "EXP",
    x: ["xl-country-dest", "xl-port-loading", "xl-lut"],
    tm: "tm-export",
    dt: "due",
  },
  "credit-note": {
    n: "ty-credit-note",
    fam: "gst",
    ttl: "tt-credit-note",
    pf: "CN",
    x: ["xl-orig-no", "xl-orig-date", "xl-reason"],
    dt: "none",
  },
  "debit-note": {
    n: "ty-debit-note",
    fam: "gst",
    ttl: "tt-debit-note",
    pf: "DN",
    x: ["xl-orig-no", "xl-orig-date", "xl-reason"],
    dt: "none",
  },
  "delivery-challan": {
    n: "ty-delivery-challan",
    fam: "gst",
    ttl: "tt-delivery-challan",
    pf: "DC",
    x: ["xl-vehicle", "xl-transporter", "xl-transport-reason"],
    np: true,
    nt: true,
    dt: "none",
  },
  "retail-invoice": {
    n: "ty-retail-invoice",
    fam: "gst",
    ttl: "tt-retail-invoice",
    pf: "RI",
    gd: true,
    dt: "none",
  },
  "service-invoice": {
    n: "ty-service-invoice",
    fam: "gst",
    ttl: "tt-service-invoice",
    pf: "SI",
    x: ["xl-service-period", "xl-po-work", ""],
    dl: "dl-service-desc",
    dt: "due",
  },
  "pharmacy-bill": {
    n: "ty-pharmacy-bill",
    fam: "gst",
    ttl: "tt-pharmacy-bill",
    pf: "PB",
    x: ["xl-doctor", "xl-patient", "xl-batch"],
    dt: "none",
    dl: "dl-medicine",
  },
  "cash-memo": {
    n: "ty-cash-memo",
    fam: "std",
    ttl: "tt-cash-memo",
    pf: "CM",
    dt: "none",
    st: "PAID",
  },
  "proforma-invoice": {
    n: "ty-proforma-invoice",
    fam: "std",
    ttl: "tt-proforma-invoice",
    pf: "PI",
    x: ["xl-po", "xl-pay-terms", "xl-delivery-date"],
    dt: "valid",
    tm: "tm-proforma",
  },
  quotation: {
    n: "ty-quotation",
    fam: "std",
    ttl: "tt-quotation",
    pf: "QT",
    x: ["xl-enquiry", "xl-delivery-time", "xl-pay-terms"],
    dt: "valid",
    tm: "tm-quotation",
  },
  estimate: {
    n: "ty-estimate",
    fam: "std",
    ttl: "tt-estimate",
    pf: "EST",
    x: ["xl-job-project", "xl-expected-start", ""],
    dt: "valid",
    tm: "tm-estimate",
  },
  "purchase-order": {
    n: "ty-purchase-order",
    fam: "std",
    ttl: "tt-purchase-order",
    pf: "PO",
    x: ["xl-delivery-date", "xl-ship-to", "xl-pay-terms"],
    dt: "none",
    bl: "bl-vendor",
    tm: "tm-po",
  },
  "payment-receipt": {
    n: "ty-payment-receipt",
    fam: "std",
    ttl: "tt-payment-receipt",
    pf: "RC",
    x: ["xl-pay-mode", "xl-utr", "xl-towards"],
    nt: true,
    dt: "none",
    st: "PAID",
    bl: "bl-recv-from",
  },
  "rent-receipt": {
    n: "ty-rent-receipt",
    fam: "std",
    ttl: "tt-rent-receipt",
    pf: "RR",
    x: ["xl-property", "xl-rent-month", "xl-pay-mode"],
    nt: true,
    dt: "none",
    st: "PAID",
    bl: "bl-recv-tenant",
    dl: "dl-rent",
  },
  "tuition-fee-receipt": {
    n: "ty-tuition-fee-receipt",
    fam: "std",
    ttl: "tt-tuition-fee-receipt",
    pf: "FR",
    x: ["xl-student", "xl-class", "xl-month-term"],
    nt: true,
    dt: "none",
    st: "PAID",
    bl: "bl-recv-from",
    dl: "dl-fee-head",
  },
  "simple-invoice": {
    n: "ty-simple-invoice",
    fam: "std",
    ttl: "tt-simple-invoice",
    pf: "INV",
    x: ["xl-po", "", ""],
    dt: "due",
  },
  "free-invoice-template": {
    n: "ty-free-invoice-template",
    fam: "std",
    ttl: "tt-free-invoice-template",
    pf: "INV",
    x: ["xl-po", "", ""],
    dt: "due",
  },
  "commercial-invoice": {
    n: "ty-commercial-invoice",
    fam: "std",
    ttl: "tt-commercial-invoice",
    pf: "CI",
    x: ["xl-incoterms", "xl-country-origin", "xl-port-dest"],
    dt: "due",
  },
  "recurring-invoice": {
    n: "ty-recurring-invoice",
    fam: "std",
    ttl: "tt-recurring-invoice",
    pf: "REC",
    x: ["xl-billing-period", "xl-plan", "xl-next-inv"],
    ql: "qty-mth",
    rl: "rate-mth",
    dl: "dl-subscription",
    dt: "due",
  },
  "freelance-invoice": {
    n: "ty-freelance-invoice",
    fam: "std",
    ttl: "tt-freelance-invoice",
    pf: "FL",
    x: ["xl-project", "xl-client-po", ""],
    dl: "dl-project-service",
    dt: "due",
  },
  "hourly-invoice": {
    n: "ty-hourly-invoice",
    fam: "std",
    ttl: "tt-hourly-invoice",
    pf: "HR",
    x: ["xl-project", "xl-billing-period", ""],
    ql: "qty-hrs",
    rl: "rate-hr",
    dl: "desc-task",
    dt: "due",
  },
  "consulting-invoice": {
    n: "ty-consulting-invoice",
    fam: "std",
    ttl: "tt-consulting-invoice",
    pf: "CO",
    x: ["xl-engagement", "xl-period", "xl-po"],
    ql: "qty-hrs",
    rl: "rate-hr",
    dl: "dl-service",
    dt: "due",
  },
  "web-design-invoice": {
    n: "ty-web-design-invoice",
    fam: "std",
    ttl: "tt-web-design-invoice",
    pf: "WD",
    x: ["xl-project", "xl-site-url", "xl-milestone"],
    dl: "dl-deliverable",
    dt: "due",
  },
  "software-development-invoice": {
    n: "ty-software-development-invoice",
    fam: "std",
    ttl: "tt-software-development-invoice",
    pf: "SD",
    x: ["xl-project-sprint", "xl-billing-period", "xl-po"],
    ql: "qty-hrs",
    rl: "rate-hr",
    dl: "desc-task",
    dt: "due",
  },
  "photography-invoice": {
    n: "ty-photography-invoice",
    fam: "std",
    ttl: "tt-photography-invoice",
    pf: "PH",
    x: ["xl-shoot-date", "xl-location", "xl-delivery-date"],
    dl: "dl-service",
    dt: "due",
  },
  "legal-invoice": {
    n: "ty-legal-invoice",
    fam: "std",
    ttl: "tt-legal-invoice",
    pf: "LG",
    x: ["xl-matter", "xl-court", "xl-client-file"],
    ql: "qty-hrs",
    rl: "rate-hr",
    dl: "dl-legal-service",
    dt: "due",
  },
  "professional-fees-invoice": {
    n: "ty-professional-fees-invoice",
    fam: "std",
    ttl: "tt-professional-fees-invoice",
    pf: "PF",
    x: ["xl-engagement", "xl-period", ""],
    dl: "dl-professional-service",
    dt: "due",
  },
  "contractor-invoice": {
    n: "ty-contractor-invoice",
    fam: "std",
    ttl: "tt-contractor-invoice",
    pf: "CT",
    x: ["xl-job-site", "xl-work-order", "xl-work-pct"],
    dl: "dl-work-material",
    dt: "due",
  },
  "repair-service-invoice": {
    n: "ty-repair-service-invoice",
    fam: "std",
    ttl: "tt-repair-service-invoice",
    pf: "RS",
    x: ["xl-job-card", "xl-technician", "xl-warranty"],
    dl: "dl-part-service",
    dt: "due",
  },
  "car-repair-invoice": {
    n: "ty-car-repair-invoice",
    fam: "std",
    ttl: "tt-car-repair-invoice",
    pf: "CR",
    x: ["xl-vehicle", "xl-make-model", "xl-odometer"],
    dl: "dl-part-labour",
    dt: "due",
  },
  "cleaning-invoice": {
    n: "ty-cleaning-invoice",
    fam: "std",
    ttl: "tt-cleaning-invoice",
    pf: "CL",
    x: ["xl-service-location", "xl-service-date", "xl-team"],
    ql: "qty-hrs",
    rl: "rate-hr",
    dl: "dl-service",
    dt: "due",
  },
  "interior-design-invoice": {
    n: "ty-interior-design-invoice",
    fam: "std",
    ttl: "tt-interior-design-invoice",
    pf: "ID",
    x: ["xl-project-site", "xl-design-stage", "xl-work-order"],
    ql: "qty-sqft",
    rl: "rate-sqft",
    dl: "dl-work-stage",
    dt: "due",
  },
  "taxi-invoice": {
    n: "ty-taxi-invoice",
    fam: "std",
    ttl: "tt-taxi-invoice",
    pf: "TX",
    x: ["xl-vehicle", "xl-pickup-drop", "xl-trip-date"],
    ql: "qty-km",
    rl: "rate-km",
    dl: "dl-trip-charge",
    dt: "due",
  },
  "transport-invoice": {
    n: "ty-transport-invoice",
    fam: "std",
    ttl: "tt-transport-invoice",
    pf: "TR",
    x: ["xl-lr-gr", "xl-vehicle", "xl-from-to"],
    dl: "dl-freight-charge",
    dt: "due",
  },
  "hotel-invoice": {
    n: "ty-hotel-invoice",
    fam: "std",
    ttl: "tt-hotel-invoice",
    pf: "HT",
    x: ["xl-checkin", "xl-checkout", "xl-guest-room"],
    ql: "qty-night",
    rl: "rate-night",
    dl: "dl-room-service",
    dt: "due",
  },
  "restaurant-bill": {
    n: "ty-restaurant-bill",
    fam: "std",
    ttl: "tt-restaurant-bill",
    pf: "RB",
    x: ["xl-table", "xl-waiter", ""],
    dt: "none",
    dl: "dl-item",
  },
  "medical-bill": {
    n: "ty-medical-bill",
    fam: "std",
    ttl: "tt-medical-bill",
    pf: "MB",
    x: ["xl-patient", "xl-patient-id", "xl-doctor"],
    dt: "none",
    dl: "dl-service-test",
  },
} as const satisfies Record<string, InvoiceTypeDef>;

export type InvoiceTypeId = keyof typeof INVOICE_TYPES;

export const INVOICE_TYPE_IDS = Object.keys(
  INVOICE_TYPES
) as readonly InvoiceTypeId[];

/* ------------------------------------------------------------------ */
/* Groups (dropdown optgroups — original order)                       */
/* ------------------------------------------------------------------ */

export const INVOICE_GROUPS: readonly {
  /** Optgroup label i18n key (invoice.gr-<n>). */
  key: string;
  ids: readonly InvoiceTypeId[];
}[] = [
  {
    key: "gr-gst",
    ids: [
      "gst-invoice",
      "bill-of-supply",
      "export-invoice",
      "credit-note",
      "debit-note",
      "delivery-challan",
      "retail-invoice",
      "service-invoice",
      "pharmacy-bill",
      "cash-memo",
    ],
  },
  {
    key: "gr-quotes",
    ids: [
      "proforma-invoice",
      "quotation",
      "estimate",
      "purchase-order",
      "payment-receipt",
      "rent-receipt",
      "tuition-fee-receipt",
    ],
  },
  {
    key: "gr-general",
    ids: [
      "simple-invoice",
      "free-invoice-template",
      "commercial-invoice",
      "recurring-invoice",
    ],
  },
  {
    key: "gr-freelance",
    ids: [
      "freelance-invoice",
      "hourly-invoice",
      "consulting-invoice",
      "web-design-invoice",
      "software-development-invoice",
      "photography-invoice",
      "legal-invoice",
      "professional-fees-invoice",
    ],
  },
  {
    key: "gr-trades",
    ids: [
      "contractor-invoice",
      "repair-service-invoice",
      "car-repair-invoice",
      "cleaning-invoice",
      "interior-design-invoice",
    ],
  },
  {
    key: "gr-travel",
    ids: [
      "taxi-invoice",
      "transport-invoice",
      "hotel-invoice",
      "restaurant-bill",
      "medical-bill",
    ],
  },
];

/** Total = 39 — the catalog the standalone app shipped with. */
export const INVOICE_TYPE_COUNT = INVOICE_TYPE_IDS.length;

/* ------------------------------------------------------------------ */
/* Indian GST state codes (GSTIN prefix + place-of-supply list)       */
/* ------------------------------------------------------------------ */

/**
 * Official GST state-code list, exactly as the standalone app shipped.
 * Deliberately English-only (also on हिंदी invoices): these are the
 * legal registration names used on GST documents.
 */
export const GST_STATES: readonly string[] = [
  "01 Jammu & Kashmir",
  "02 Himachal Pradesh",
  "03 Punjab",
  "04 Chandigarh",
  "05 Uttarakhand",
  "06 Haryana",
  "07 Delhi",
  "08 Rajasthan",
  "09 Uttar Pradesh",
  "10 Bihar",
  "11 Sikkim",
  "12 Arunachal Pradesh",
  "13 Nagaland",
  "14 Manipur",
  "15 Mizoram",
  "16 Tripura",
  "17 Meghalaya",
  "18 Assam",
  "19 West Bengal",
  "20 Jharkhand",
  "21 Odisha",
  "22 Chhattisgarh",
  "23 Madhya Pradesh",
  "24 Gujarat",
  "25 Daman & Diu (old code)",
  "26 Dadra & Nagar Haveli and Daman & Diu",
  "27 Maharashtra",
  "28 Andhra Pradesh (old code)",
  "29 Karnataka",
  "30 Goa",
  "31 Lakshadweep",
  "32 Kerala",
  "33 Tamil Nadu",
  "34 Puducherry",
  "35 Andaman & Nicobar Islands",
  "36 Telangana",
  "37 Andhra Pradesh",
  "38 Ladakh",
  "97 Other Territory",
];

/** "27 Maharashtra" → "Maharashtra"; unknown code → "". */
export function gstStateName(code: string): string {
  const hit = GST_STATES.find((s) => s.slice(0, 2) === code);
  return hit ? hit.slice(3) : "";
}

/* ------------------------------------------------------------------ */
/* Currencies                                                          */
/* ------------------------------------------------------------------ */

export const INVOICE_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

export const CURRENCY_SYMBOLS: Record<InvoiceCurrency, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Locale used for number formatting (Indian grouping for INR). */
export function currencyLocale(cur: InvoiceCurrency): string {
  return cur === "INR" ? "en-IN" : "en-US";
}
