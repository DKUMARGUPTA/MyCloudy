import { formatMoneyCents, type Einvoice } from "../einvoice-common/cii";

/**
 * Validate e-invoice — the rule engine (Task b6-b2). PURE: no DOM, no
 * worker APIs, no filesystem — the same functions run in the tool worker
 * (browser) and under bun in the smoke.
 *
 * Two rule families, one report:
 *
 *   XML rules (1-10) run on the PARSED invoice (the shared
 *   einvoice-common/cii model — integer cents, calendar-checked dates).
 *   When the XML did not parse, rule 1 FAILs and rules 2-10 SKIP with a
 *   "no XML" note — one honest failure instead of ten noise ones.
 *
 *   PDF raw-byte rules (11-14) scan the raw bytes (latin1) plus every
 *   Flate stream the runtime can inflate: /EmbeddedFile, the /AF
 *   association with its /AFRelationship, the Factur-X XMP extension
 *   (fx:DocumentType / fx:DocumentFileName) and the pdfaid
 *   identification CLAIM (reported as claimed — never verified here;
 *   verapDF-class tools verify, MyCloudy does not pretend to).
 *
 * HONESTY (the house rule): SKIP means "not checked, and here is why" —
 * a missing value, a UBL-scoped rule, an attachment without a PDF/A
 * claim (legal ZUGFeRD usage), or a metadata stream this environment
 * could not decompress. FAIL means we looked and it is wrong. The
 * report footer says plainly that this is NOT a full EN 16931 XSD
 * schema validation.
 *
 * zlib: Flate streams are inflated through an injectable inflater whose
 * default is node:zlib via process.getBuiltinModule when the runtime
 * provides it (bun/node — the smokes; the pinned B3 lesson: the system
 * zlib, never a zip library). Browsers have no zlib builtin and no
 * static import is made, so the raw scan alone runs there — which
 * covers the uncompressed metadata streams and dictionary objects
 * every mainstream producer
 * writes (pdf-lib, Acrobat and the FNFE reference implementations all
 * keep the filespec/catalog/XMP uncompressed; PDF/A even requires it).
 *
 * MONEY: every amount in the model is INTEGER CENTS already (the shared
 * parser's rule) — the checks below only add and subtract integers.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — indexOf, split/join
 * and plain exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One checked rule's outcome. */
export interface RuleResult {
  /** Stable rule id (e.g. "xml-totals-arithmetic"). */
  id: string;
  status: "pass" | "fail" | "skip";
  /** Human title, shown on the numbered report line. */
  title: string;
  /** One-line explanation: the values seen, or why it skipped. */
  detail: string;
}

/** Summary counts derived from a rule list. */
export interface ReportCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/** The sentinel rule id for the worker's no-e-invoice hard fail. */
export const NO_EINVOICE_RULE_ID = "pdf-xml-attachment";

/** The rule ids in report order (the smoke pins this exact ladder). */
export const XML_RULE_IDS = [
  "xml-parseable",
  "xml-profile",
  "xml-document-id",
  "xml-type-code",
  "xml-issue-date",
  "xml-currency",
  "xml-parties",
  "xml-totals-arithmetic",
  "xml-line-sums",
  "xml-vat-id",
] as const;

export const PDF_RULE_IDS = [
  "pdf-embedded-file",
  "pdf-af-association",
  "pdf-xmp-metadata",
  "pdf-pdfaid-claim",
] as const;

/** "not checked" for every rule that needs the parsed XML. */
function skipNoXml(id: string, title: string): RuleResult {
  return {
    id,
    status: "skip",
    title,
    detail: "not checked — the e-invoice XML could not be parsed",
  };
}

/* ------------------------------------------------------------------ */
/* XML rules 1-10                                                      */
/* ------------------------------------------------------------------ */

/** Rule 1 — XML parses, dialect detected. */
export function ruleXmlParseable(
  inv: Einvoice | null,
  parseError: string | null
): RuleResult {
  const id = "xml-parseable";
  const title = "XML parses — invoice dialect detected";
  if (inv !== null) {
    return {
      id,
      status: "pass",
      title,
      detail:
        inv.dialect === "CII"
          ? "Dialect: CII — UN/CEFACT Cross Industry Invoice (Factur-X / ZUGFeRD / XRechnung CII)"
          : "Dialect: UBL — OASIS UBL 2.1 Invoice",
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail:
      parseError !== null && parseError.length > 0
        ? `the embedded XML did not parse as an e-invoice: ${parseError}`
        : "the embedded XML did not parse as an e-invoice",
  };
}

/** The guideline URNs this validator recognizes (CII). */
export const RECOGNIZED_GUIDELINE_URNS: { urn: string; label: string }[] = [
  { urn: "urn:factur-x.eu:1p0:minimum", label: "Factur-X MINIMUM" },
  { urn: "urn:factur-x.eu:1p0:basicwl", label: "Factur-X BASIC WL" },
  { urn: "urn:factur-x.eu:1p0:basic", label: "Factur-X BASIC" },
  { urn: "urn:factur-x.eu:1p0:en16931", label: "Factur-X EN 16931" },
  { urn: "urn:factur-x.eu:1p0:extended", label: "Factur-X EXTENDED" },
  { urn: "urn:cen.eu:en16931:2017", label: "CEN EN 16931" },
];

/** Rule 2 — profile / guideline ID present and recognized (CII only). */
export function ruleProfile(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-profile";
  const title = "Profile / guideline ID present and recognized (CII)";
  if (inv === null) return skipNoXml(id, title);
  if (inv.dialect === "UBL") {
    return {
      id,
      status: "skip",
      title,
      detail:
        "UBL carries no profile in-document — schema validation not performed",
    };
  }
  if (inv.profileId === null || inv.profileId.trim().length === 0) {
    return {
      id,
      status: "fail",
      title,
      detail:
        "no guideline ID — CII needs GuidelineSpecifiedDocumentContextParameter/ID",
    };
  }
  const urn = inv.profileId.trim();
  const known = RECOGNIZED_GUIDELINE_URNS.find(
    (g) => g.urn === urn.toLowerCase()
  );
  if (known === undefined) {
    return {
      id,
      status: "fail",
      title,
      detail: `profile URN "${urn}" is not recognized — expected a Factur-X (minimum/basicwl/basic/en16931/extended) or urn:cen.eu:en16931:2017 profile`,
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `Profile: ${known.label} (${known.urn})`,
  };
}

/** Rule 3 — document number present (both dialects). */
export function ruleDocumentId(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-document-id";
  const title = "Document number present";
  if (inv === null) return skipNoXml(id, title);
  if (inv.id !== null && inv.id.trim().length > 0) {
    return {
      id,
      status: "pass",
      title,
      detail: `Document number: ${inv.id.trim()}`,
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail: "no document number — the invoice carries no ID",
  };
}

/** UNTDID 1001 invoice-family type codes (CII TypeCode). */
export const INVOICE_FAMILY_TYPE_CODES: { code: number; label: string }[] = [
  { code: 380, label: "commercial invoice" },
  { code: 381, label: "credit note" },
  { code: 383, label: "debit note" },
  { code: 384, label: "corrected invoice" },
  { code: 386, label: "prepayment invoice" },
  { code: 389, label: "self-billed invoice" },
];

/** Rule 4 — TypeCode in the invoice family (CII only). */
export function ruleTypeCode(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-type-code";
  const title = "Type code in the invoice family (CII)";
  if (inv === null) return skipNoXml(id, title);
  if (inv.dialect === "UBL") {
    return {
      id,
      status: "skip",
      title,
      detail: "CII-only rule — UBL documents are not checked here",
    };
  }
  if (inv.typeCode === null) {
    return {
      id,
      status: "fail",
      title,
      detail: "no TypeCode — the invoice carries no document type",
    };
  }
  const known = INVOICE_FAMILY_TYPE_CODES.find(
    (t) => t.code === inv.typeCode
  );
  if (known === undefined) {
    return {
      id,
      status: "fail",
      title,
      detail: `TypeCode ${inv.typeCode} is not in the invoice family (380/381/383/384/386/389)`,
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `TypeCode ${inv.typeCode} — ${known.label}`,
  };
}

/** Rule 5 — issue date is a real calendar date. */
export function ruleIssueDate(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-issue-date";
  const title = "Issue date is a real calendar date";
  if (inv === null) return skipNoXml(id, title);
  if (inv.issueDate !== null) {
    return {
      id,
      status: "pass",
      title,
      detail: `Issue date ${inv.issueDate} is a real calendar date (month 1-12, day checked against the month)`,
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail:
      "issue date is missing or not a real calendar date — expected CII format 102 (YYYYMMDD) or UBL ISO yyyy-mm-dd",
  };
}

const CURRENCY_SHAPE = /^[A-Z]{3}$/;

/** Rule 6 — currency is a 3-letter uppercase code. */
export function ruleCurrency(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-currency";
  const title = "Currency is a 3-letter uppercase code";
  if (inv === null) return skipNoXml(id, title);
  if (inv.currency === null || inv.currency.trim().length === 0) {
    return {
      id,
      status: "fail",
      title,
      detail: "no currency code in the invoice",
    };
  }
  if (!CURRENCY_SHAPE.test(inv.currency)) {
    return {
      id,
      status: "fail",
      title,
      detail: `currency "${inv.currency}" is not three uppercase letters (ISO 4217 codes are uppercase)`,
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `Currency: ${inv.currency}`,
  };
}

/** Rule 7 — seller and buyer named. */
export function ruleParties(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-parties";
  const title = "Seller and buyer are named";
  if (inv === null) return skipNoXml(id, title);
  const missing: string[] = [];
  if (inv.seller.name === null || inv.seller.name.trim().length === 0) {
    missing.push("seller name");
  }
  if (inv.buyer.name === null || inv.buyer.name.trim().length === 0) {
    missing.push("buyer name");
  }
  if (missing.length > 0) {
    return {
      id,
      status: "fail",
      title,
      detail: `missing: ${missing.join(" and ")}`,
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `Seller: ${inv.seller.name} / Buyer: ${inv.buyer.name}`,
  };
}

/** Rule 8 — totals arithmetic in integer cents. */
export function ruleTotalsArithmetic(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-totals-arithmetic";
  const title =
    "Totals arithmetic — tax basis + tax = grand total, due payable within grand total";
  if (inv === null) return skipNoXml(id, title);
  const t = inv.totals;
  if (
    t.taxBasis === null ||
    t.taxTotal === null ||
    t.grandTotal === null ||
    t.duePayable === null
  ) {
    const missing: string[] = [];
    if (t.taxBasis === null) missing.push("tax basis");
    if (t.taxTotal === null) missing.push("tax total");
    if (t.grandTotal === null) missing.push("grand total");
    if (t.duePayable === null) missing.push("due payable");
    return {
      id,
      status: "skip",
      title,
      detail: `cannot check — ${missing.join(", ")} missing from the XML`,
    };
  }
  const cur = inv.currency;
  const basis = t.taxBasis;
  const tax = t.taxTotal;
  const grand = t.grandTotal;
  const due = t.duePayable;
  const sum = basis + tax; // integer cents — never floats
  const problems: string[] = [];
  if (Math.abs(sum - grand) > 1) {
    problems.push(
      `${formatMoneyCents(basis, cur)} + ${formatMoneyCents(
        tax,
        cur
      )} = ${formatMoneyCents(sum, cur)} but the grand total is ${formatMoneyCents(
        grand,
        cur
      )} (off by ${formatMoneyCents(Math.abs(sum - grand), null)})`
    );
  }
  if (due > grand + 1) {
    problems.push(
      `due payable ${formatMoneyCents(
        due,
        cur
      )} exceeds the grand total ${formatMoneyCents(grand, cur)}`
    );
  }
  if (problems.length > 0) {
    return { id, status: "fail", title, detail: problems.join("; ") };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `${formatMoneyCents(basis, cur)} + ${formatMoneyCents(
      tax,
      cur
    )} = ${formatMoneyCents(
      grand,
      cur
    )}; due payable ${formatMoneyCents(
      due,
      cur
    )} stays within the grand total`,
  };
}

/** Rule 9 — line items sum to the tax basis. */
export function ruleLineSums(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-line-sums";
  const title = "Line items sum to the tax basis";
  if (inv === null) return skipNoXml(id, title);
  if (inv.lines.length === 0) {
    return {
      id,
      status: "skip",
      title,
      detail: "no line items in the XML (e.g. a Minimum profile) — nothing to sum",
    };
  }
  const withoutTotal = inv.lines.filter((l) => l.lineTotal === null).length;
  if (withoutTotal > 0) {
    return {
      id,
      status: "skip",
      title,
      detail: `cannot sum — ${withoutTotal} of ${inv.lines.length} line items carry no line total`,
    };
  }
  if (inv.totals.taxBasis === null) {
    return {
      id,
      status: "skip",
      title,
      detail: "no tax basis in the XML — nothing to compare the line sums against",
    };
  }
  let sum = 0; // integer cents
  for (const line of inv.lines) sum += line.lineTotal ?? 0;
  const basis = inv.totals.taxBasis;
  const n = inv.lines.length;
  const phrase = `${n} line item${n === 1 ? "" : "s"} sum${
    n === 1 ? "s" : ""
  } to`;
  if (Math.abs(sum - basis) > 1) {
    return {
      id,
      status: "fail",
      title,
      detail: `${phrase} ${formatMoneyCents(sum, inv.currency)} but the tax basis is ${formatMoneyCents(
        basis,
        inv.currency
      )} (off by ${formatMoneyCents(Math.abs(sum - basis), null)})`,
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `${phrase} ${formatMoneyCents(sum, inv.currency)} = the tax basis`,
  };
}

/** The loose EN 16931 VAT ID shape. */
export const VAT_ID_SHAPE = /^[A-Z]{2}[A-Z0-9]{2,13}$/;

/** Rule 10 — VAT ID format when present (loose check). */
export function ruleVatIdFormat(
  inv: Einvoice | null,
  _parseError: string | null
): RuleResult {
  const id = "xml-vat-id";
  const title = "VAT ID format (loose EN 16931 check)";
  if (inv === null) return skipNoXml(id, title);
  const ids: { party: string; value: string }[] = [];
  if (inv.seller.vatId !== null && inv.seller.vatId.trim().length > 0) {
    ids.push({ party: "seller", value: inv.seller.vatId.trim() });
  }
  if (inv.buyer.vatId !== null && inv.buyer.vatId.trim().length > 0) {
    ids.push({ party: "buyer", value: inv.buyer.vatId.trim() });
  }
  if (ids.length === 0) {
    return {
      id,
      status: "skip",
      title,
      detail: "no VAT ID in the XML — nothing to check (not every invoice carries one)",
    };
  }
  const bad = ids.filter((entry) => !VAT_ID_SHAPE.test(entry.value));
  if (bad.length > 0) {
    return {
      id,
      status: "fail",
      title,
      detail: bad
        .map(
          (entry) =>
            `${entry.party} VAT ID "${entry.value}" does not match the loose EN 16931 shape ^[A-Z]{2}[A-Z0-9]{2,13}$ (2 country letters, then 2-13 letters/digits)`
        )
        .join("; "),
    };
  }
  return {
    id,
    status: "pass",
    title,
    detail: `${ids
      .map((entry) => `${entry.party} ${entry.value}`)
      .join(
        ", "
      )} pass the loose EN 16931 shape check (2 country letters + 2-13 letters/digits)`,
  };
}

/** Rules 1-10 over the parsed invoice (one list, report order). */
export function runXmlRules(
  inv: Einvoice | null,
  parseError: string | null
): RuleResult[] {
  return [
    ruleXmlParseable(inv, parseError),
    ruleProfile(inv, parseError),
    ruleDocumentId(inv, parseError),
    ruleTypeCode(inv, parseError),
    ruleIssueDate(inv, parseError),
    ruleCurrency(inv, parseError),
    ruleParties(inv, parseError),
    ruleTotalsArithmetic(inv, parseError),
    ruleLineSums(inv, parseError),
    ruleVatIdFormat(inv, parseError),
  ];
}

/* ------------------------------------------------------------------ */
/* zlib injection + raw byte helpers                                    */
/* ------------------------------------------------------------------ */

/** Inflates one Flate stream, or null when it is not one. */
export type InflateStreamFn = (data: Uint8Array) => Uint8Array | null;

/**
 * The active inflater. Default: node:zlib via process.getBuiltinModule
 * when the runtime provides it (bun/node — the smokes). No static import
 * is made, so browser bundles never pull node:zlib in; there the raw
 * scan alone runs (see the module header for why that is enough).
 */
let inflateStream: InflateStreamFn | null = loadDefaultInflater();

function loadDefaultInflater(): InflateStreamFn | null {
  try {
    const proc = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown };
      }
    ).process;
    if (typeof proc?.getBuiltinModule === "function") {
      const zlib = proc.getBuiltinModule(
        "node:zlib"
      ) as { inflateSync?: (data: Uint8Array) => Uint8Array } | null;
      if (zlib !== null && typeof zlib.inflateSync === "function") {
        const inflateSync = zlib.inflateSync;
        return (data) => {
          try {
            return inflateSync(data);
          } catch {
            return null; // not a zlib stream — skip it, never crash
          }
        };
      }
    }
  } catch {
    /* no zlib builtin in this runtime */
  }
  return null;
}

/** Replaces the stream inflater (smoke tests inject / disable it). */
export function setStreamInflater(fn: InflateStreamFn | null): void {
  inflateStream = fn;
}

/** Whether a stream inflater is active right now. */
export function hasStreamInflater(): boolean {
  return inflateStream !== null;
}

/** Binary-safe latin1 decode (one character per byte). */
export function latin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    let part = "";
    for (let j = i; j < end; j += 1) {
      part += String.fromCharCode(bytes[j]);
    }
    parts.push(part);
  }
  return parts.join("");
}

/**
 * The B3 inflateScan pattern: walk every "stream...endstream" region of
 * the raw bytes and inflate the Flate ones, joining the latin1 text.
 * Empty string when no inflater is active (or no stream inflates).
 */
function inflateFlateStreams(bytes: Uint8Array, raw: string): string {
  const inflate = inflateStream;
  if (inflate === null) return "";
  let out = "";
  let idx = 0;
  for (;;) {
    const st = raw.indexOf("stream", idx);
    if (st === -1) break;
    const en = raw.indexOf("endstream", st);
    if (en === -1) break;
    let start = st + 6;
    while (start < en && (bytes[start] === 13 || bytes[start] === 10)) {
      start += 1;
    }
    let end = en;
    while (end > start && (bytes[end - 1] === 13 || bytes[end - 1] === 10)) {
      end -= 1;
    }
    if (end > start) {
      const data = inflate(bytes.subarray(start, end));
      if (data !== null) out += latin1(data);
    }
    idx = en + 9;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PDF raw-byte rules 11-14                                            */
/* ------------------------------------------------------------------ */

/** Rule 11 — /EmbeddedFile present in the raw structure. */
export function ruleEmbeddedFile(text: string): RuleResult {
  const id = "pdf-embedded-file";
  const title = "Embedded file stream present in the PDF";
  if (text.indexOf("/EmbeddedFile") !== -1) {
    return {
      id,
      status: "pass",
      title,
      detail: "an /EmbeddedFile stream is present in the raw PDF structure",
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail: "no /EmbeddedFile stream — the PDF carries no embedded file at all",
  };
}

/** Rule 12 — /AF association + /AFRelationship on the filespec. */
export function ruleAfAssociation(text: string): RuleResult {
  const id = "pdf-af-association";
  const title = "File associated with the document (/AF + /AFRelationship)";
  const hasAfArray = /\/AF\s*\[\s*\d/.test(text);
  const rel = /\/AFRelationship\s*\/([A-Za-z0-9]+)/.exec(text);
  if (hasAfArray && rel !== null) {
    return {
      id,
      status: "pass",
      title,
      detail: `the embedded file is associated via /AF and carries /AFRelationship /${rel[1]}`,
    };
  }
  if (hasAfArray) {
    return {
      id,
      status: "fail",
      title,
      detail:
        "files are associated via /AF but the filespec carries no /AFRelationship (Factur-X expects /Data)",
    };
  }
  if (rel !== null) {
    return {
      id,
      status: "fail",
      title,
      detail: `AFRelationship /${rel[1]} is set but there is no /AF array in the catalog — the file is not associated with the document`,
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail:
      "no /AF array in the catalog and no /AFRelationship — the embedded file is not associated with the document (Factur-X / ZUGFeRD require it)",
  };
}

/** What the XMP scan saw (shared by rules 13 and 14). */
export interface XmpScanResult {
  docType: string | null;
  docFileName: string | null;
  pdfaidPart: string | null;
  pdfaidConformance: string | null;
  /**
   * False only when a /Metadata stream exists, no marker was found in the
   * raw bytes AND no inflater is available (the stream may be compressed
   * and unread here — "not verified", never a guess).
   */
  metadataReadable: boolean;
}

/** Scans raw + inflated text for the Factur-X / pdfaid XMP markers. */
export function scanXmp(raw: string, inflated: string): XmpScanResult {
  const text = `${raw}\n${inflated}`;
  const docType = /<fx:DocumentType[^>]*>([^<]*)<\/fx:DocumentType>/.exec(text);
  const docFileName = /<fx:DocumentFileName[^>]*>([^<]*)<\/fx:DocumentFileName>/.exec(
    text
  );
  const part = /<pdfaid:part[^>]*>([^<]*)<\/pdfaid:part>/.exec(text);
  const conf = /<pdfaid:conformance[^>]*>([^<]*)<\/pdfaid:conformance>/.exec(text);
  const found =
    docType !== null || docFileName !== null || part !== null || conf !== null;
  const pick = (match: RegExpExecArray | null): string | null => {
    if (match === null) return null;
    const value = match[1].trim();
    return value.length > 0 ? value : null;
  };
  const hasMetadata = raw.indexOf("/Metadata") !== -1;
  return {
    docType: pick(docType),
    docFileName: pick(docFileName),
    pdfaidPart: pick(part),
    pdfaidConformance: pick(conf),
    metadataReadable:
      found || inflateStream !== null || !hasMetadata,
  };
}

/** Rule 13 — Factur-X XMP extension in the metadata. */
export function ruleXmpMetadata(
  scan: XmpScanResult,
  attachmentName: string | null
): RuleResult {
  const id = "pdf-xmp-metadata";
  const title = "Factur-X XMP extension in the metadata";
  if (scan.docType !== null || scan.docFileName !== null) {
    const parts: string[] = [];
    if (scan.docType !== null) parts.push(`fx:DocumentType ${scan.docType}`);
    if (scan.docFileName !== null) {
      parts.push(`fx:DocumentFileName ${scan.docFileName}`);
    }
    if (
      attachmentName !== null &&
      scan.docFileName !== null &&
      scan.docFileName !== attachmentName
    ) {
      parts.push(`(the embedded file is named ${attachmentName} — the names differ)`);
    }
    return { id, status: "pass", title, detail: parts.join(", ") };
  }
  if (!scan.metadataReadable) {
    return {
      id,
      status: "skip",
      title,
      detail:
        "a /Metadata stream exists but is compressed and this environment cannot decompress it — XMP not verified",
    };
  }
  return {
    id,
    status: "fail",
    title,
    detail:
      "no Factur-X XMP extension found (fx:DocumentType / fx:DocumentFileName absent from the metadata)",
  };
}

/** Rule 14 — the pdfaid identification claim. */
export function rulePdfaidClaim(scan: XmpScanResult): RuleResult {
  const id = "pdf-pdfaid-claim";
  const title = "PDF/A identification claim";
  if (scan.pdfaidPart !== null) {
    const conf =
      scan.pdfaidConformance !== null ? scan.pdfaidConformance : "?";
    return {
      id,
      status: "pass",
      title,
      detail: `PDF/A-${scan.pdfaidPart}${conf} identification claimed (pdfaid:part ${scan.pdfaidPart}, conformance ${conf}) — reported as claimed, not verified here`,
    };
  }
  if (!scan.metadataReadable) {
    return {
      id,
      status: "skip",
      title,
      detail: "PDF/A claim not checked — the metadata stream could not be read",
    };
  }
  return {
    id,
    status: "skip",
    title,
    detail:
      "no PDF/A identification claimed — an attachment without the claim is legal ZUGFeRD usage",
  };
}

/** Rules 11-14 over the raw PDF bytes (latin1 scan + Flate inflate). */
export function runPdfRules(
  pdfRaw: Uint8Array,
  attachmentName: string | null
): RuleResult[] {
  const raw = latin1(pdfRaw);
  const inflated = inflateFlateStreams(pdfRaw, raw);
  const both = `${raw}\n${inflated}`;
  const scan = scanXmp(raw, inflated);
  return [
    ruleEmbeddedFile(both),
    ruleAfAssociation(both),
    ruleXmpMetadata(scan, attachmentName),
    rulePdfaidClaim(scan),
  ];
}

/* ------------------------------------------------------------------ */
/* The no-e-invoice hard fail                                          */
/* ------------------------------------------------------------------ */

/**
 * The single hard FAIL for a PDF that carries no e-invoice XML: the
 * task-spec rule + honest hints about what WAS found (attachment names,
 * a raw /EmbeddedFile without an accessible entry, and what to do).
 */
export function noEinvoiceResult(
  pdfRaw: Uint8Array,
  foundAttachmentNames: string[]
): RuleResult {
  const hints: string[] = [];
  if (foundAttachmentNames.length > 0) {
    hints.push(
      `Attachments found: ${foundAttachmentNames.join(
        ", "
      )} — none is an e-invoice XML.`
    );
  } else {
    hints.push("No attachments were found in this PDF at all.");
  }
  if (latin1(pdfRaw).indexOf("/EmbeddedFile") !== -1) {
    hints.push(
      "The raw structure does mention an embedded file, but no accessible attachment entry carried an e-invoice XML (a missing embedded-files name tree can cause this)."
    );
  }
  hints.push(
    "Tip: attach the XML with Create electronic invoice, or double-check that this is the file you meant to send."
  );
  return {
    id: NO_EINVOICE_RULE_ID,
    status: "fail",
    title: "No embedded XML found — this PDF is not an e-invoice",
    detail: hints.join(" "),
  };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

/** Counts pass/fail/skip across a rule list. */
export function countResults(results: RuleResult[]): ReportCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "pass") passed += 1;
    else if (r.status === "fail") failed += 1;
    else skipped += 1;
  }
  return { passed, failed, skipped };
}

/** The three report verdicts. */
export type ReportVerdict = "valid" | "invalid" | "no-einvoice";

/**
 * VALID unless a rule failed; the no-e-invoice sentinel overrides with
 * its own verdict so a report-less PDF never reads as merely "invalid".
 */
export function reportVerdict(results: RuleResult[]): ReportVerdict {
  let anyFail = false;
  for (const r of results) {
    if (r.status !== "fail") continue;
    if (r.id === NO_EINVOICE_RULE_ID) return "no-einvoice";
    anyFail = true;
  }
  return anyFail ? "invalid" : "valid";
}

const VERDICT_TEXT: Record<ReportVerdict, string> = {
  "valid": "VALID — ready to send",
  "invalid": "INVALID — fix the errors below",
  "no-einvoice": "NO E-INVOICE FOUND",
};

/** The verdict sentence for a rule list (pinned by the smokes). */
export function verdictText(verdict: ReportVerdict): string {
  return VERDICT_TEXT[verdict];
}

/**
 * The readable text report: header with the file name, one numbered
 * PASS/FAIL/SKIP line per rule (detail indented beneath), the summary
 * counts line, the verdict and the honesty footer.
 */
export function formatReport(fileName: string, results: RuleResult[]): string {
  const counts = countResults(results);
  const verdict = reportVerdict(results);
  const lines: string[] = [];
  lines.push("MyCloudy — Validate e-invoice");
  lines.push(`File: ${fileName}`);
  lines.push("");
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    lines.push(
      `${String(i + 1).padStart(2, " ")}. [${r.status.toUpperCase()}] ${r.title}`
    );
    if (r.detail.length > 0) lines.push(`    ${r.detail}`);
  }
  lines.push("");
  lines.push(
    `Summary: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`
  );
  lines.push(`Verdict: ${VERDICT_TEXT[verdict]}`);
  lines.push("");
  lines.push(
    "Scope note: structural, arithmetic and attachment checks — not a full EN 16931 XSD schema validation. For deep schema checks use an IRP or verapDF-class tool."
  );
  lines.push("");
  return lines.join("\n");
}
