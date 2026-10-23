import type { RunDetail } from "@/lib/workers/protocol";

/**
 * create-electronic-invoice — shared types (RB5-b, PRD invoices family).
 *
 * Factur-X (== ZUGFeRD 2.x, the EU hybrid e-invoice standard): a PDF with
 * the machine-readable invoice embedded as `factur-x.xml` (CII,
 * rsm:CrossIndustryInvoice) via the PDF /AF associated-files mechanism, plus
 * an XMP block that declares the attachment.
 *
 * HONEST scope — this tool embeds a standards-shaped attachment + XMP. It
 * does NOT convert the PDF to PDF/A-3 (no ICC profile, no output intent,
 * no VeraPDF-grade validation). The FAQ says so plainly.
 */

/** The Factur-X attachment file name readers expect. */
export const FACTUR_X_FILENAME = "factur-x.xml";

/** Option ids on the run message (values flow through the surface). */
export const CEI_IDS = {
  /** XMP conformance level stamp: MINIMUM | BASIC | EN 16931. */
  level: "level",
} as const;

/** XMP conformance levels we can stamp (Factur-X 1.0 subset). */
export const CONFORMANCE_LEVELS = ["MINIMUM", "BASIC", "EN 16931"] as const;
export type ConformanceLevel = (typeof CONFORMANCE_LEVELS)[number];

/** Default level (what the sample XML generator emits, too). */
export const DEFAULT_LEVEL: ConformanceLevel = "EN 16931";

/** One line item of the sample-XML generator form. */
export interface SampleLineItem {
  name: string;
  qty: number;
  unitPrice: number;
}

/** The whole sample-XML generator form (small, 1-3 items). */
export interface SampleInvoiceForm {
  seller: string;
  buyer: string;
  number: string;
  /** ISO date (YYYY-MM-DD) — coerced to CII format 102 in the model. */
  date: string;
  currency: string;
  /** Percent, e.g. 18 → 18.00. */
  taxRate: number;
  items: SampleLineItem[];
}

/** Structural sniff of the supplied CII XML (model's DOM-free shape). */
export interface CiiShape {
  /** All three structural markers present. */
  ok: boolean;
  /** Root element is rsm:CrossIndustryInvoice. */
  rootOk: boolean;
  /** rsm:ExchangedDocumentContext present. */
  contextOk: boolean;
  /** ram:ApplicableHeaderTradeSettlement present. */
  settlementOk: boolean;
  /** ExchangedDocument/ID text ("" when absent). */
  invoiceId: string;
  /** InvoiceCurrencyCode text ("" when absent). */
  currency: string;
  /** IncludedSupplyChainTradeLineItem count. */
  lineCount: number;
}

/**
 * Run report for this tool. Extends the protocol RunDetail additively
 * (RB1 precedent — extra per-tool fields ride the same detail object;
 * the shared protocol file is owned by the orchestrator).
 */
export interface CeiDetail extends RunDetail {
  /** Attachment file name written into the Filespec (factur-x.xml). */
  attachmentName?: string;
  /** Byte length of the embedded XML (uncompressed). */
  attachmentBytes?: number;
  /** XMP conformance level stamped (MINIMUM | BASIC | EN 16931). */
  conformanceLevel?: string;
  /** Catalog /AF array present and holding the Filespec ref. */
  afPresent?: boolean;
  /** /AFRelationship /Alternative verified on the saved Filespec. */
  afRelationshipAlternative?: boolean;
  /** XMP /Metadata stream written to the catalog. */
  xmpWritten?: boolean;
  /** Structural sniff of the supplied XML was fully ok. */
  xmlShapeOk?: boolean;
  /** Invoice number sniffed from the XML. */
  xmlInvoiceId?: string;
  /** Currency sniffed from the XML. */
  xmlCurrency?: string;
  /** Line items counted in the XML. */
  xmlLineCount?: number;
  /** Source PDF carried an /OutputIntents entry (PDF/A marker). */
  sourceOutputIntent?: boolean;
  /** Source XMP carried pdfaid: markers (PDF/A marker). */
  sourceXmpPdfaid?: boolean;
}
