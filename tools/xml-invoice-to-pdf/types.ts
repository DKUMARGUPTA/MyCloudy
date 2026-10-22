/**
 * XML e-invoice to PDF (RB5-d — the 87th tool) — the document model.
 *
 * Input: a CII (rsm:CrossIndustryInvoice) XML file — the UN/CEFACT Cross
 * Industry Invoice dialect used by Factur-X / ZUGFeRD 1.0 + 2.x and many
 * e-invoicing rails. The parser is namespace-tolerant by construction:
 * it matches LOCAL names (rsm:ID, ID, x:ID all resolve to "ID"), so every
 * CII version URN (:10, :100, XRechnung …) reads the same.
 *
 * This file is types + pure constants only. model.ts owns the parsing and
 * layout planning, render.ts owns every point of ink, worker.ts the run
 * protocol, surface.tsx the bilingual UI. No DOM, no pdf-lib, no storage
 * imports here — the same model feeds the live parse report in the surface
 * AND the worker's render, so the preview can never disagree with the PDF.
 */

import type { RunDetail } from "@/lib/workers/protocol";

/* ------------------------------------------------------------------ */
/* Minimal structural XML node                                          */
/* ------------------------------------------------------------------ */

/**
 * The tiny XML shape every consumer below agrees on. Produced by
 * `parseXmlDocument` (our own bun-safe parser) and by `domToXmlElem`
 * (the browser DOMParser path) — structurally identical, so parseCii
 * never cares which parser built the tree.
 */
export interface XmlElem {
  /** local name — namespace/prefix agnostic ("rsm:ID" → "ID"). */
  readonly localName: string;
  /** element children only (text lives in `textContent`). */
  readonly children: readonly XmlElem[];
  /** concatenated text of the whole subtree (DOM textContent semantics). */
  readonly textContent: string;
  /** attributes by qualified name; lookups match the local suffix. */
  readonly attrs: Readonly<Record<string, string>>;
}

export type XmlParseFailure = "not-xml" | "malformed";

export type XmlParseResult =
  | { ok: true; root: XmlElem }
  | { ok: false; reason: XmlParseFailure };

/* ------------------------------------------------------------------ */
/* Parties / lines / taxes / totals                                     */
/* ------------------------------------------------------------------ */

export interface PartyAddress {
  line1: string;
  line2: string;
  line3: string;
  city: string;
  postcode: string;
  country: string;
  subdivision: string;
}

export interface PartyInfo {
  name: string;
  /** direct ram:ID or SpecifiedLegalOrganization/ID. */
  id: string;
  /** SpecifiedLegalOrganization/TradingBusinessName (e.g. the Latin
   * transliteration next to a Devanagari seller name). */
  tradingName: string;
  /** SpecifiedTaxRegistration/ID values (GSTIN / VAT no). */
  taxIds: string[];
  phone: string;
  email: string;
  /** URIUniversalCommunication/URIID (often an e-invoice mailbox). */
  uri: string;
  address: PartyAddress;
}

export interface InvoiceLine {
  /** AssociatedDocumentLineDocument/LineID. */
  lineId: string;
  name: string;
  description: string;
  sellerAssignedId: string;
  quantity: number | null;
  /** BilledQuantity@unitCode (C62, HUR, KGM …). */
  unitCode: string;
  /** SpecifiedLineTradeSettlementLineMonetarySummation/LineTotalAmount. */
  netAmount: number | null;
  /** NetPriceProductTradePrice/ChargeAmount. */
  unitPrice: number | null;
  taxRate: number | null;
  taxCategory: string;
}

export interface TaxSummary {
  /** ApplicableTradeTax/RateApplicablePercent (null when absent). */
  rate: number | null;
  category: string;
  basis: number | null;
  amount: number | null;
}

export interface InvoiceTotals {
  lineTotal: number | null;
  chargeTotal: number | null;
  allowanceTotal: number | null;
  taxBasisTotal: number | null;
  taxTotal: number | null;
  grandTotal: number | null;
  /** TotalPrepaidAmount — rendered as the "Paid" line. */
  prepaid: number | null;
  /** DuePayableAmount — rendered bold as "Amount due". */
  duePayable: number | null;
}

export interface InvoiceMeta {
  number: string;
  typeCode: string;
  /** human-formatted issue date ("15 Mar 2026") or the raw string. */
  issueDate: string;
  /** human-formatted due date (payment terms) or "". */
  dueDate: string;
  /** human-formatted delivery date or "". */
  deliveryDate: string;
  currency: string;
  buyerReference: string;
  /** ExchangedDocument/IncludedNote/Content — rendered as small footer
   * text only, never as body sections (honest scope). */
  notes: string[];
}

export interface PaymentInfo {
  reference: string;
  /** SpecifiedTradeSettlementPaymentMeans/TypeCode. */
  meansCode: string;
  iban: string;
  accountName: string;
  bic: string;
}

/* ------------------------------------------------------------------ */
/* Parse issues (what was missing — surfaced, never fatal)              */
/* ------------------------------------------------------------------ */

export type ParseIssueCode =
  | "missNumber"
  | "missDate"
  | "missType"
  | "missCurrency"
  | "missSellerName"
  | "missSellerAddr"
  | "missBuyerName"
  | "missBuyerAddr"
  | "missLines"
  | "missLineAmount"
  | "missTax"
  | "missTotals"
  | "missPayment"
  | "lineCap";

export interface ParseIssue {
  code: ParseIssueCode;
}

export interface ParsedInvoice {
  meta: InvoiceMeta;
  seller: PartyInfo;
  buyer: PartyInfo;
  lines: InvoiceLine[];
  taxes: TaxSummary[];
  totals: InvoiceTotals;
  payment: PaymentInfo;
  issues: ParseIssue[];
  /** true when the XML carried more line items than the render cap. */
  truncated: boolean;
  /** total line items found in the XML (before the cap). */
  totalLineCount: number;
}

/* ------------------------------------------------------------------ */
/* Run options + result detail                                          */
/* ------------------------------------------------------------------ */

export type PageKind = "a4" | "letter";

/** Pre-resolved display labels (the surface's t()) shipped with the run —
 *  the create-invoice recipe: the PDF text matches the UI language. */
export type InvoiceLabelMap = Record<string, string>;

export interface RenderOptions {
  pageSize: PageKind;
  labels: InvoiceLabelMap;
}

/**
 * Local structural extension of the shared RunDetail (protocol.ts is not
 * touched — the fields ride the same message, additive like every RB
 * batch's per-tool detail). Surfaces read them through this type.
 */
export interface XinvRunDetail extends RunDetail {
  /** line items rendered into the PDF. */
  lines?: number;
  /** total line items found in the XML (before the 80-row cap). */
  totalLines?: number;
  /** parse issues (i18n keys) surfaced in the result view. */
  issueKeys?: string[];
  /** which font path ran — "standard" (no embed) or "devanagari". */
  fontPath?: "standard" | "devanagari";
  /** row cap hit — a truncation note was printed. */
  truncated?: boolean;
}
