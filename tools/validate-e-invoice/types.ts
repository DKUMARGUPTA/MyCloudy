import type { RunDetail } from "@/lib/workers/protocol";

/**
 * Validate e-invoice (RB5-e) — types only, no logic.
 *
 * The honest contract (mirrored in the FAQ): this tool runs STRUCTURAL +
 * EN 16931-flavored SEMANTIC checks on a CII (Cross Industry Invoice)
 * document — either a raw .xml file or the Factur-X/ZUGFeRD XML embedded in
 * a PDF attachment. It is NOT a full XSD schema validation, NOT a
 * signature/e-seal verification, and NOT a complete business-rule
 * validation — the checklist below is the whole scope.
 *
 * The pipeline split (bun-testable model, worker-extracts/model-judges):
 *   worker: sniff input → (PDF: extract the embedded XML via pdf.js) →
 *           parseXml → takeCii → runChecks → report
 *   model:  everything pure above; zero DOM, zero pdf.js imports.
 */

/* ------------------------------------------------------------------ */
/* Checks + verdict                                                    */
/* ------------------------------------------------------------------ */

export type CheckStatus = "pass" | "warn" | "fail";

/** PASS / PASS WITH WARNINGS / FAIL — the aggregate verdict. */
export type Verdict = "pass" | "warnings" | "fail";

/**
 * One checklist row. `label` and (when it is a sentence) `note` are FULL
 * i18n keys ("vei.kRoot", "vei.nDateIso" …) — the surface resolves them
 * with t(), the .txt report builder resolves them through the
 * ReportLabels map; technical fragments (numbers, element names, line
 * indexes) always live in `expected` / `actual` and are shown raw.
 */
export interface Check {
  /** Stable check id ("root", "docDate", "sumLines" … — smoke vectors). */
  id: string;
  /** i18n key for the human label. */
  label: string;
  status: CheckStatus;
  /** What the rule wanted (raw display string, technical). */
  expected?: string;
  /** What the file actually has (raw display string, technical). */
  actual?: string;
  /** i18n key for the explanatory sentence (never free prose). */
  note?: string;
}

/**
 * The three headline totals (mini reconciliation table) plus the values
 * the three cross-check equations need — all display-ready strings,
 * computed ONCE in the model so the surface never re-parses decimals.
 */
export interface TotalsTriple {
  /** Σ of parseable line-level net amounts, 2 decimals ("" when none). */
  lineSum: string;
  /** Header LineTotalAmount as written ("" when absent). */
  lineTotal: string;
  /** TaxBasisTotalAmount as written ("" when absent). */
  taxBasis: string;
  /** Σ of parseable ApplicableTradeTax amounts, 2 decimals. */
  taxSum: string;
  /** tax basis + Σ tax, 2 decimals ("" when the basis is unknown). */
  taxBasisPlusTax: string;
  /** GrandTotalAmount as written ("" when absent). */
  grandTotal: string;
  /** TotalPrepaidAmount as written (null when absent). */
  prepaid: string | null;
  /** grand total − prepaid, 2 decimals ("" when grand is unknown). */
  grandMinusPrepaid: string;
  /** DuePayableAmount as written (null when absent). */
  due: string | null;
  /** InvoiceCurrencyCode as written (null when absent). */
  currency: string | null;
}

/** The whole validation result the surface renders + the report encodes. */
export interface ValidationReport {
  verdict: Verdict;
  checks: Check[];
  totals: TotalsTriple | null;
}

/* ------------------------------------------------------------------ */
/* The CII field map (the extraction contract — sibling CII tools       */
/* should read the SAME paths; namespace-tolerant by localName)        */
/* ------------------------------------------------------------------ */

/** One header-level ApplicableTradeTax entry (raw trimmed text). */
export interface CiiTaxEntry {
  /** ram:RateApplicablePercent — e.g. "18". */
  rate: string | null;
  /** ram:CategoryCode — S/Z/E/AE/K/G/O … */
  category: string | null;
  /** ram:CalculatedAmount — the tax amount. */
  amount: string | null;
}

/** One IncludedSupplyChainTradeLineItem (raw trimmed text). */
export interface CiiLine {
  /** …TradeProduct/ram:Name. */
  name: string | null;
  /** Line settlement …MonetarySummation/ram:LineTotalAmount (the net). */
  net: string | null;
}

/**
 * The flat CII field map takeCii produces (parse ONCE, judge many):
 *
 *   root                     rsm:CrossIndustryInvoice (localName)
 *   hasContext               rsm:ExchangedDocumentContext present
 *   guideline                ExchangedDocumentContext/
 *                            GuidelineSpecifiedDocumentContextParameter/ID
 *   invoiceId                ExchangedDocument/ram:ID
 *   issueDate                ExchangedDocument/ram:IssueDateTime/
 *                            udt:DateTimeString (format 102 = YYYYMMDD)
 *   typeCode                 ExchangedDocument/ram:TypeCode (380/381/384…)
 *   seller                   SupplyChainTradeTransaction/
 *                            ApplicableHeaderTradeAgreement/
 *                            SellerTradeParty/ram:Name
 *   buyer                    …same parent…/BuyerTradeParty/ram:Name
 *   buyerReference           ApplicableHeaderTradeAgreement/ram:BuyerReference
 *   sellerHasAddress          SellerTradeParty/ram:PostalTradeAddress present
 *   buyerHasAddress          BuyerTradeParty/ram:PostalTradeAddress present
 *   currency                 ApplicableHeaderTradeSettlement/
 *                            ram:InvoiceCurrencyCode (ISO 4217)
 *   lines[]                  IncludedSupplyChainTradeLineItem
 *                            (name = …TradeProduct/ram:Name,
 *                             net = line …MonetarySummation/
 *                                    ram:LineTotalAmount)
 *   lineTotal                header …MonetarySummation/ram:LineTotalAmount
 *   taxBasis                 …/ram:TaxBasisTotalAmount
 *   taxes[]                  ApplicableHeaderTradeSettlement/
 *                            ApplicableTradeTax (rate/category/amount)
 *   grandTotal               …/ram:GrandTotalAmount
 *   prepaid                  …/ram:TotalPrepaidAmount
 *   due                      …/ram:DuePayableAmount
 *
 * All values are RAW trimmed text — parsing/judging is the check layer's
 * job, never the extractor's.
 */
export interface CiiFields {
  root: string | null;
  hasContext: boolean;
  guideline: string | null;
  invoiceId: string | null;
  issueDate: string | null;
  typeCode: string | null;
  seller: string | null;
  buyer: string | null;
  buyerReference: string | null;
  sellerHasAddress: boolean;
  buyerHasAddress: boolean;
  currency: string | null;
  lines: CiiLine[];
  lineTotal: string | null;
  taxBasis: string | null;
  taxes: CiiTaxEntry[];
  grandTotal: string | null;
  prepaid: string | null;
  due: string | null;
}

/** Input kind the magic-byte sniff detected. */
export type InputKind = "xml" | "pdf" | "unknown";

/**
 * The parsed-XML abstraction: one namespace-tolerant element node.
 * `name` is the localName (everything after the first colon), text is the
 * concatenated direct text (entities decoded, CDATA included).
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/* ------------------------------------------------------------------ */
/* Worker boundary                                                     */
/* ------------------------------------------------------------------ */

/**
 * Pre-resolved display strings for the .txt report (create-invoice
 * precedent: the surface passes its t() output through options.run so the
 * report matches the UI language; the model keeps an English fallback for
 * label-less runs). Keys are full i18n keys ("vei.kRoot"); values are the
 * resolved strings.
 */
export type ReportLabels = Record<string, string>;

/** Options payload the surface syncs (JSON in options.run). */
export interface RunOptions {
  locale: "en" | "hi";
  /** Localized fallback word for a nameless file. */
  fileWord: string;
  /** Resolved report strings (vei.* keys → text). */
  labels: ReportLabels;
}

/**
 * RunDetail extension for validate-e-invoice (the RB1/RB3-b additive
 * precedent; protocol.ts merges centrally in the orchestrator's wiring
 * round — this local interface is what the worker posts and the surface
 * reads).
 */
export interface ValidateDetail extends RunDetail {
  verdict?: Verdict;
  checksPassed?: number;
  checksWarned?: number;
  checksFailed?: number;
  /** IncludedSupplyChainTradeLineItem count. */
  lineCount?: number;
  inputMode?: InputKind;
  /** Embedded XML attachment name (PDF mode). */
  attachmentName?: string;
  /** XMP /ConformanceLevel claim (PDF mode, when parseable). */
  xmpClaim?: string;
  /** The full report the surface renders (checks + totals). */
  report?: ValidationReport;
}
