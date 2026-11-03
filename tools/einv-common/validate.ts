/**
 * e-invoice validation engine (P12-EINVOICE — validate-e-invoice, and the
 * same reader the two build tools' surfaces use for their live previews).
 *
 * Honest scope: this is a CORE-RULE checker that runs entirely on-device —
 *   • PDF container: embedded XML present, /AF associated, filename,
 *     XMP fx: fields, PDF/A-3 declaration, AFRelationship
 *   • XML structure: dialect, guideline profile
 *   • EN 16931 core fields: number, dates, type code, ISO 4217 currency,
 *     parties, per-line qty/price/name
 *   • the arithmetic: line nets, per-category sums, basis, tax total,
 *     grand total, payable (the five xinv checks, plus per-line and
 *     per-category detail)
 *
 * It is NOT the full 55-business-rule EN 16931 schematron and it never
 * phones a schema server — the surface says so plainly.
 */

import { PDFDocument, decodePDFRawStream, PDFArray, PDFName, PDFStream } from "@cantoo/pdf-lib";

import { parseXml, descendant, type XmlNode } from "../xml-invoice-to-pdf/xml";
import { parseEInvoice, type EInvoice } from "../xml-invoice-to-pdf/engine";
import { ISO_CURRENCIES } from "./model";
import { GUIDELINE_PROFILES, LEVEL_TO_GUIDELINE } from "./cii";

export const FX_NS = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";
export const PDFAID_NS = "http://www.aiim.org/pdfa/ns/id/";

export type EInvSeverity = "error" | "warn" | "ok";

export interface EInvFinding {
  /** Stable i18n id — einv.f<Id> / detail einv.f<Id>D. */
  id: string;
  severity: EInvSeverity;
  /** Interpolation params for the i18n strings. */
  params?: Record<string, string | number>;
}

export interface EInvAttachmentInfo {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
  afRelationship: string;
}

export interface EInvPdfInfo {
  pages: number;
  attachments: EInvAttachmentInfo[];
  /** The /AF names (associated files), when present. */
  afNames: string[];
  xmp: string | null;
  fx: {
    documentType?: string;
    documentFileName?: string;
    version?: string;
    conformanceLevel?: string;
  };
  pdfaid: { part?: string; conformance?: string };
}

export interface EInvReport {
  inputKind: "pdf" | "xml";
  /** Dialect of the embedded/loaded XML (when it parsed). */
  dialect?: "UBL" | "CII";
  /** Profile declared by the XML guideline (when present). */
  profile?: string;
  /** Attachment the XML was read from (PDF input). */
  xmlName?: string;
  /** Parsed invoice (when the XML parsed). */
  inv: EInvoice | null;
  findings: EInvFinding[];
  errors: number;
  warnings: number;
}

/* ------------------------------------------------------------------ */
/* PDF inspection                                                       */
/* ------------------------------------------------------------------ */

function attr(node: XmlNode, name: string): string {
  return node.attrList.find((a) => a.name === name)?.value ?? "";
}

/** Namespace-agnostic descendant search (first match by local name). */
function descendantByName(node: XmlNode, name: string): XmlNode | undefined {
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = descendantByName(c, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** fx:/pdfaid: values may be child ELEMENTS or rdf:Description ATTRIBUTES. */
function xmpField(root: XmlNode, ns: string, name: string): string | undefined {
  const el = descendant(root, ns, name);
  if (el !== undefined && el.text.trim() !== "") return el.text.trim();
  const flat = root.attrList.find((a) => a.ns === ns && a.name === name)?.value;
  if (flat !== undefined && flat.trim() !== "") return flat.trim();
  return undefined;
}

function parseXmp(xmp: string): EInvPdfInfo["fx"] & { pdfaid: EInvPdfInfo["pdfaid"] } {
  try {
    const root = parseXml(new TextEncoder().encode(xmp));
    return {
      documentType: xmpField(root, FX_NS, "DocumentType"),
      documentFileName: xmpField(root, FX_NS, "DocumentFileName"),
      version: xmpField(root, FX_NS, "Version"),
      conformanceLevel: xmpField(root, FX_NS, "ConformanceLevel"),
      pdfaid: {
        part: xmpField(root, PDFAID_NS, "part"),
        conformance: xmpField(root, PDFAID_NS, "conformance"),
      },
    };
  } catch {
    return { pdfaid: {} };
  }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

export async function inspectPdfEInvoice(
  bytes: Uint8Array
): Promise<EInvPdfInfo> {
  let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/encrypted/i.test(message)) throw new Error("einv.errorEncrypted");
    throw new Error("einv.errorNotPdf");
  }

  const attachments: EInvAttachmentInfo[] = doc
    .getAttachments()
    .map((a) => ({
      name: a.name,
      bytes: a.data,
      mimeType: a.mimeType ?? "",
      afRelationship:
        typeof a.afRelationship === "string" ? a.afRelationship : "",
    }));

  // /AF names (the associated-file array — what PDF/A-3 readers look at).
  const afNames: string[] = [];
  const af = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  if (af !== undefined) {
    for (let i = 0; i < af.size(); i += 1) {
      const spec = af.lookup(i);
      if (typeof spec === "object" && spec !== null && "get" in spec) {
        try {
          const f = (spec as { get?: (k: PDFName) => unknown }).get?.(
            PDFName.of("F")
          );
          if (
            f !== undefined &&
            f !== null &&
            typeof (f as { decodeText?: () => string }).decodeText === "function"
          ) {
            afNames.push((f as { decodeText: () => string }).decodeText());
          }
        } catch {
          /* skip unreadable spec entries */
        }
      }
    }
  }

  // XMP packet (the catalog /Metadata stream).
  let xmp: string | null = null;
  try {
    const meta = doc.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream);
    if (meta !== undefined) {
      xmp = new TextDecoder("utf-8").decode(
        decodePDFRawStream(meta as Parameters<typeof decodePDFRawStream>[0]).decode()
      );
    }
  } catch {
    xmp = null;
  }

  const parsedXmp = xmp !== null ? parseXmp(xmp) : { pdfaid: {} };

  return {
    pages: doc.getPageCount(),
    attachments,
    afNames,
    xmp,
    fx: {
      documentType: parsedXmp.documentType,
      documentFileName: parsedXmp.documentFileName,
      version: parsedXmp.version,
      conformanceLevel: parsedXmp.conformanceLevel,
    },
    pdfaid: parsedXmp.pdfaid,
  };
}

/** Whether a PDF magic header opens the bytes. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/* ------------------------------------------------------------------ */
/* XML-level validation                                                 */
/* ------------------------------------------------------------------ */

const TYPE_CODES = new Set([
  "326", "331", "380", "381", "382", "383", "384", "385", "386", "387",
  "388", "389", "261", "262", "295", "296", "420", "456", "457", "458",
]);

/** All elements with a currencyID attribute — the raw walk for cross-checks. */
function currencyIdValues(root: XmlNode): string[] {
  const out: string[] = [];
  const walk = (n: XmlNode): void => {
    const v = attr(n, "currencyID");
    if (v !== "") out.push(v);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function guidelineOf(root: XmlNode): string {
  // CII: ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID
  // (prefix-agnostic — ram:/rsm: prefixes vary by writer).
  const g = descendantByName(root, "GuidelineSpecifiedDocumentContextParameter");
  if (g !== undefined) {
    const id = descendantByName(g, "ID");
    if (id !== undefined && id.text.trim() !== "") return id.text.trim();
  }
  // UBL: ProfileExtractionProcedure (rare); the UBL syntax itself is EN 16931.
  const pep = descendantByName(root, "ProfileExtractionProcedure");
  if (pep !== undefined && pep.text.trim() !== "") return pep.text.trim();
  return "";
}

function near(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/**
 * Validate a CII/UBL e-invoice XML (the embedded bytes or a raw .xml).
 * Never throws for CONTENT problems — everything becomes a finding.
 */
export function validateEInvoiceXml(
  bytes: Uint8Array,
  xmlName?: string
): EInvReport {
  const findings: EInvFinding[] = [];
  const add = (id: string, severity: EInvSeverity, params?: Record<string, string | number>): void => {
    findings.push({ id, severity, params });
  };

  let root: XmlNode;
  try {
    root = parseXml(bytes);
  } catch {
    add("XmlBroken", "error");
    return { inputKind: xmlName === undefined ? "xml" : "pdf", inv: null, findings, errors: 1, warnings: 0 };
  }

  let inv: EInvoice;
  try {
    inv = parseEInvoice(bytes);
  } catch {
    add("NotInvoice", "error");
    return {
      inputKind: xmlName === undefined ? "xml" : "pdf",
      inv: null,
      findings,
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: 0,
    };
  }

  const guideline = guidelineOf(root);
  const knownProfile = GUIDELINE_PROFILES[guideline];
  const profile = knownProfile ?? (inv.format === "UBL" ? "EN 16931" : undefined);

  if (guideline === "") {
    add("GuidelineMissing", "warn");
  } else if (knownProfile === undefined) {
    add("GuidelineUnknown", "warn", { id: guideline.slice(0, 80) });
  } else {
    add("GuidelineOk", "ok", { profile: knownProfile });
  }

  // ---- Core fields (BT-1..BT-16 subset).
  if (inv.number === "") add("NumberMissing", "error");
  if (inv.typeCode === "" || !TYPE_CODES.has(inv.typeCode)) {
    add("TypeCodeInvalid", "error", { code: inv.typeCode.slice(0, 12) || "—" });
  }
  if (inv.issueDate === "") {
    add("DateMissing", "error");
  } else if (!/^\d{4}-\d{2}-\d{2}/.test(inv.issueDate)) {
    add("DateInvalid", "error", { date: inv.issueDate.slice(0, 20) });
  }
  if (inv.dueDate !== "" && inv.issueDate !== "" && inv.dueDate < inv.issueDate) {
    add("DueOrder", "warn");
  }
  if (!/^[A-Z]{3}$/.test(inv.currency) || !ISO_CURRENCIES.has(inv.currency)) {
    add("CurrencyInvalid", "error", { code: inv.currency || "—" });
  }
  if (inv.seller.name === "") add("SellerMissing", "error");
  if (inv.buyer.name === "") add("BuyerMissing", "error");
  const addressSeverity: EInvSeverity =
    profile === undefined || profile === "EN 16931" || profile === "EXTENDED" ? "error" : "warn";
  if (inv.seller.lines.length === 0) add("SellerAddress", addressSeverity);
  if (
    inv.seller.taxId === "" &&
    inv.lines.some((l) => (l.vatRate ?? 0) > 0)
  ) {
    add("SellerTaxId", "warn");
  }

  // ---- Lines.
  let lineNetBad = 0;
  for (let i = 0; i < inv.lines.length; i += 1) {
    const l = inv.lines[i];
    const n = l.id || String(i + 1);
    if (l.qtyText === "") {
      add("LineQtyMissing", "error", { n });
    } else if (l.qty !== null && l.unit === "") {
      add("UnitCodeMissing", "warn", { n });
    }
    if (l.name === "") {
      add("LineNameMissing", "error", { n });
    }
    if (l.priceText === "" && l.qty !== null) {
      add("LinePriceMissing", "warn", { n });
    }
    if (l.qty !== null && l.price !== null && !near(l.qty * l.price, l.amount)) {
      lineNetBad += 1;
      if (lineNetBad <= 5) {
        add("LineNetMismatch", "error", {
          n,
          expected: fmt(l.qty * l.price),
          actual: fmt(l.amount),
        });
      }
    }
    if ((l.vatRate ?? 0) === 0 && l.category === "" && l.qty !== null) {
      add("ZeroRateCategory", "warn", { n });
    }
  }
  if (lineNetBad > 5) {
    add("LineNetMore", "error", { n: lineNetBad - 5 });
  }
  if (inv.lines.length === 0) add("NoLines", "error");

  // ---- Currency attribute consistency.
  const mismatches = currencyIdValues(root).filter((c) => c !== inv.currency);
  if (mismatches.length > 0) {
    add("CurrencyAttr", "error", { code: mismatches[0], expected: inv.currency });
  }

  // ---- VAT breakdown.
  const taxTotal = inv.taxTotal ?? 0;
  if (inv.taxes.length === 0 && taxTotal > 0) {
    add("BreakdownMissing", "error");
  }
  for (const t of inv.taxes) {
    const rate = t.rate ?? 0;
    const expectedBasis = inv.lines
      .filter((l) => (l.vatRate ?? 0) === rate)
      .reduce((a, l) => a + l.amount, 0);
    if (t.basis !== null && !near(expectedBasis, t.basis)) {
      add("CategorySum", "error", {
        rate: fmt(rate),
        expected: fmt(expectedBasis),
        actual: fmt(t.basis),
      });
    }
    if (t.basis !== null && !near((t.basis * rate) / 100, t.amount, 0.02)) {
      add("CategoryTax", "error", {
        rate: fmt(rate),
        expected: fmt((t.basis * rate) / 100),
        actual: fmt(t.amount),
      });
    }
  }

  // ---- The five totals checks (the xinv engine verdicts, spelled out).
  const byKey = new Map<string, boolean>(inv.checks.map((c) => [c.key, c.ok]));
  const checkIds: [key: string, id: string][] = [
    ["lines", "TotalsLines"],
    ["basis", "TotalsBasis"],
    ["taxSum", "TotalsTaxSum"],
    ["grand", "TotalsGrand"],
    ["payable", "TotalsPayable"],
  ];
  for (const [key, id] of checkIds) {
    if (byKey.get(key) === false) add(id, "error", { which: key });
  }
  if (inv.checks.every((c) => c.ok) && inv.lines.length > 0) {
    add("TotalsOk", "ok");
  }

  if (findings.filter((f) => f.severity === "error").length === 0) {
    add("CoreOk", "ok");
  }

  return {
    inputKind: xmlName === undefined ? "xml" : "pdf",
    dialect: inv.format,
    profile: knownProfile ?? (inv.format === "UBL" ? "EN 16931" : undefined),
    xmlName,
    inv,
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}

/* ------------------------------------------------------------------ */
/* PDF-level validation (container + XML combined)                      */
/* ------------------------------------------------------------------ */

const KNOWN_XML_NAMES = new Set(["factur-x.xml", "zugferd-invoice.xml"]);

/** Pick the e-invoice XML among the attachments. */
export function pickInvoiceXml(attachments: EInvAttachmentInfo[]): EInvAttachmentInfo | null {
  const byKnown = attachments.find((a) => KNOWN_XML_NAMES.has(a.name.toLowerCase()));
  if (byKnown !== undefined) return byKnown;
  return (
    attachments.find(
      (a) => a.name.toLowerCase().endsWith(".xml") && a.bytes.length > 20
    ) ?? null
  );
}

/**
 * Validate a hybrid PDF: container first, then the embedded XML, then the
 * cross-checks between the XMP metadata and the XML itself.
 */
export async function validateEInvoicePdf(bytes: Uint8Array): Promise<EInvReport> {
  const info = await inspectPdfEInvoice(bytes);
  const findings: EInvFinding[] = [];
  const add = (id: string, severity: EInvSeverity, params?: Record<string, string | number>): void => {
    findings.push({ id, severity, params });
  };

  const xml = pickInvoiceXml(info.attachments);
  if (xml === null) {
    add("NoXml", "error");
    if (info.attachments.length > 0) {
      add("OtherAttachments", "warn", {
        names: info.attachments.slice(0, 3).map((a) => a.name).join(", ").slice(0, 60),
      });
    }
    return {
      inputKind: "pdf",
      inv: null,
      findings,
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warn").length,
    };
  }
  add("XmlFound", "ok", { name: xml.name, kb: Math.max(1, Math.round(xml.bytes.length / 102.4) / 10) });

  // ---- Container-level checks.
  const lower = xml.name.toLowerCase();
  if (!KNOWN_XML_NAMES.has(lower)) {
    add("FileNameUnusual", "warn", { name: xml.name.slice(0, 40) });
  }
  if (info.afNames.length === 0 || !info.afNames.some((n) => n === xml.name)) {
    add("AfMissing", "error", { name: xml.name.slice(0, 40) });
  } else {
    add("AfOk", "ok");
  }
  if (xml.mimeType === "") {
    add("MimeMissing", "warn");
  }
  if (xml.afRelationship !== "" && xml.afRelationship !== "Alternative") {
    add("AfRelationship", "warn", { rel: xml.afRelationship.slice(0, 20) });
  }

  // ---- XMP checks.
  const fx = info.fx;
  if (fx.documentType === undefined && fx.documentFileName === undefined && fx.conformanceLevel === undefined) {
    add("XmpMissing", "error");
  } else {
    if (fx.documentType !== undefined && fx.documentType !== "INVOICE") {
      add("XmpDocType", "error", { type: fx.documentType.slice(0, 20) });
    }
    if (
      fx.documentFileName !== undefined &&
      fx.documentFileName !== xml.name
    ) {
      add("XmpFileName", "error", {
        declared: fx.documentFileName.slice(0, 40),
        actual: xml.name.slice(0, 40),
      });
    }
    if (fx.conformanceLevel !== undefined && !(fx.conformanceLevel in LEVEL_TO_GUIDELINE)) {
      add("XmpLevelUnknown", "warn", { level: fx.conformanceLevel.slice(0, 24) });
    }
  }
  if (info.pdfaid.part !== "3") {
    add("PdfaLevel", "warn", {
      part: info.pdfaid.part ?? "—",
      conformance: info.pdfaid.conformance ?? "—",
    });
  } else {
    add("PdfaOk", "ok", { conformance: info.pdfaid.conformance ?? "B" });
  }

  // ---- XML + cross-checks.
  const report = validateEInvoiceXml(xml.bytes, xml.name);
  for (const f of report.findings) findings.push(f);
  const profile = report.profile;

  // XMP ConformanceLevel vs the XML guideline URN.
  const level = fx.conformanceLevel;
  if (level !== undefined && level in LEVEL_TO_GUIDELINE && report.inv !== null) {
    const needed = LEVEL_TO_GUIDELINE[level];
    const okProfiles = new Set<string>([
      GUIDELINE_PROFILES[needed] ?? "",
      GUIDELINE_PROFILES[needed.replace("urn:factur-x.eu", "urn:zugferd.de")] ?? "",
    ]);
    if (profile !== undefined && !okProfiles.has(profile)) {
      add("LevelMismatch", "warn", {
        xmp: level,
        xml: profile,
      });
    }
  }

  return {
    inputKind: "pdf",
    dialect: report.dialect,
    profile,
    xmlName: xml.name,
    inv: report.inv,
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}

/** Entry: any input (PDF or XML). */
export async function validateEInvoiceInput(bytes: Uint8Array): Promise<EInvReport> {
  if (looksLikePdf(bytes)) return validateEInvoicePdf(bytes);
  return validateEInvoiceXml(bytes);
}
