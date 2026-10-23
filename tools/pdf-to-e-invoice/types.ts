import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF → e-invoice types (RB5-c) — the shared vocabulary of the model
 * (pure), the worker (on-device) and the surface (bilingual report).
 *
 * Two honest paths, never mixed:
 *
 *  Path A — the file carries an embedded Factur-X / ZUGFeRD CII XML
 *  attachment (the REAL e-invoice case). The XML is extracted verbatim
 *  and its structured fields are summarized; every field cites the
 *  element it came from. Confidence is "high" because the source is
 *  the machine-readable invoice itself.
 *
 *  Path B — plain visual invoice PDF, no XML (best-effort, clearly
 *  labeled): the text layer is read and fields are SNIFFED with
 *  conservative patterns. Every field carries a confidence chip and
 *  the exact text span it was read from; fields not found are shown
 *  as "not found" — nothing is ever guessed or fabricated.
 */

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

export type Confidence = "high" | "medium" | "low";

/* ------------------------------------------------------------------ */
/* Field hits                                                          */
/* ------------------------------------------------------------------ */

/**
 * One extracted field. `sourceSnippet` is the exact matched source
 * (Path B: the layout line; Path A: the XML element) so every value
 * can be verified by eye — no field is ever presented without its
 * evidence.
 */
export interface FieldHit {
  /** Stable machine key ("invoiceNumber", "grandTotal", …). */
  key: string;
  /** Canonical English label (JSON download; the surface renders bilingual labels via i18n). */
  label: string;
  /** The extracted value ("" never happens — missing fields live in `missingKeys`). */
  value: string;
  confidence: Confidence;
  /** The matched source text (trimmed, length-capped) — the evidence. */
  sourceSnippet: string;
  /** Path B: where in the extracted line list the match sits. */
  span?: { page: number; line: number };
}

/** One CII tax block (Path A) / one sniffed tax line (Path B). */
export interface TaxHit {
  /** "VAT" / "GST" / "CGST" … (Path A TypeCode, else sniffed label). */
  type: string;
  /** Rate as written ("18.00"); empty when the line had no rate. */
  rate: string;
  /** Tax amount as written; empty when only the rate was found. */
  amount: string;
  /** Evidence for the rate+amount pair. */
  sourceSnippet: string;
}

/** One line item (Path A: from IncludedSupplyChainTradeLineItem; Path B: greedy price rows). */
export interface InvoiceLineItem {
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
}

/* ------------------------------------------------------------------ */
/* The run summary (worker → surface, and the JSON download body)       */
/* ------------------------------------------------------------------ */

export interface InvoiceSummary {
  /** "A" = embedded XML, "B" = layout sniff (best-effort). */
  path: "A" | "B";
  /** Path A: the attachment file name we extracted ("factur-x.xml"). */
  attachmentName?: string;
  /** Path A: how the attachment was found ("pdfjs" name tree / "af-walk" raw catalog). */
  foundVia?: "pdfjs" | "af-walk";
  /** Path A: the CII root element was recognized ("CrossIndustryInvoice"). */
  ciiRecognized?: boolean;
  /** Fields found, in display order. */
  fields: FieldHit[];
  /** Core fields searched for but not found (rendered as "not found" — never fabricated). */
  missingKeys: string[];
  /** Tax blocks (rate + amount + evidence each). */
  taxes: TaxHit[];
  /** Line items (may be empty — honestly reported). */
  lineItems: InvoiceLineItem[];
  /** Pages actually read (Path B caps at MAX_PAGES). */
  pagesRead: number;
  /** Path B: text extraction hit the page or char cap. */
  truncated?: boolean;
}

/** The worker → surface run detail (additive fields flow through the
 *  protocol's RunDetail by structural subtyping — nothing shared is touched). */
export interface PdfToEInvoiceDetail extends RunDetail {
  /** "A" | "B" (mirrors summary.path for the standard result view). */
  ePath?: "A" | "B";
  /** Number of fields found (of the core set). */
  fieldsFound?: number;
  /** The full summary the surface renders (structured-clone-safe plain data). */
  summary?: InvoiceSummary;
}

/* ------------------------------------------------------------------ */
/* Run options                                                         */
/* ------------------------------------------------------------------ */

export interface PdfToEInvoiceRunOptions {
  locale: "en" | "hi";
  /** Localized fallback word for the output name. */
  fileWord: string;
  /** Max pages Path B reads (default MAX_PAGES). */
  maxPages: number;
}

/* ------------------------------------------------------------------ */
/* Field keys (stable — the surface maps peinv.field_<key> labels)     */
/* ------------------------------------------------------------------ */

export const FIELD_KEYS = [
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "sellerName",
  "buyerName",
  "sellerTaxId",
  "buyerTaxId",
  "lineCount",
  "lineTotal",
  "taxBasisTotal",
  "grandTotal",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** Canonical English label for a field key (JSON download). */
export const FIELD_LABELS: Record<string, string> = {
  invoiceNumber: "Invoice number",
  issueDate: "Issue date",
  dueDate: "Due date",
  currency: "Currency",
  sellerName: "Seller name",
  buyerName: "Buyer name",
  sellerTaxId: "Seller tax ID (GSTIN / VAT)",
  buyerTaxId: "Buyer tax ID (GSTIN / VAT)",
  lineCount: "Line items",
  lineTotal: "Line total",
  taxBasisTotal: "Tax basis total",
  grandTotal: "Grand total",
};
