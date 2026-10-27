/**
 * xml-invoice-to-pdf — the e-invoice engine (P10).
 *
 * Reads the two e-invoice dialects used across the world —
 *
 *   • UBL 2.1  (urn:oasis:names:specification:ubl)  — Peppol, EU BIS,
 *     India IRP e-invoices, export invoices;
 *   • CII D16B (urn:un:unece:uncefact)  — Factur-X / ZUGFeRD (DE/EU),
 *     Cross-Industry-Invoice.
 *
 * — into ONE model. The design principle that matters: THE XML IS
 * AUTHORITATIVE. Every amount is carried through VERBATIM (source
 * string + number); nothing is recomputed, so the PDF can only ever
 * show what the file says. What the engine ADDS is verification: it
 * cross-checks the totals the file claims against the lines it lists
 * (Σ lines vs line total, basis arithmetic, Σ VAT breakdown vs tax
 * total, grand total, payable) and reports each as pass/fail — the
 * same five checks the surface previews and the sheet prints.
 *
 * Pure: no DOM, no storage, no worker APIs — runs identically in the
 * surface (drop preview), the worker (render) and the bun smoke.
 */

import { parseXml, type XmlNode } from "./xml";
import { child, children, textOf } from "./xml";

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

const MAX_LINES = 2000;
const MAX_TEXT = 2000;
const MAX_NOTES = 20;
/** Tolerance for the consistency checks (half a minor unit). */
const TOL = 0.005;

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function clampText(v: string, max = MAX_TEXT): string {
  return v.length > max ? v.slice(0, max) : v;
}

/** Parse a decimal amount string; null when not a plain number. */
function num(s: string): number | null {
  const t = s.trim();
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Decimals shown for a currency (2 standard; 0 for JPY/KRW style). */
function currencyDecimals(code: string): number {
  return code === "JPY" || code === "KRW" || code === "VND" ? 0 : 2;
}

/** Smallest number of decimals any amount in the file carries. */
function sourceDecimals(raw: string): number {
  const dot = raw.indexOf(".");
  return dot < 0 ? 2 : Math.max(2, Math.min(4, raw.length - dot - 1));
}

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export type EInvoiceFormat = "UBL" | "CII";
export type EInvoiceKind =
  | "invoice"
  | "credit-note"
  | "debit-note"
  | "proforma"
  | "other";

export interface EParty {
  name: string;
  /** Address lines (street, city, region, country) — pre-joined. */
  lines: string[];
  /** Tax registration (VAT ID, GSTIN as written in the file). */
  taxId: string;
  /** Tax scheme as written ("VAT", "GST", "IN"…). */
  taxScheme: string;
  gstin: string;
  email: string;
  phone: string;
}

export interface ELine {
  id: string;
  name: string;
  note: string;
  /** Seller-assigned id / GTIN / classification codes for the sub-line. */
  ids: string[];
  /** Quantity as written ("3", "2.5"). */
  qtyText: string;
  qty: number | null;
  /** UN/ECE rec 20 unit code ("EA", "KGM", "HUR"…), "" when absent. */
  unit: string;
  /** Net unit price as written. */
  priceText: string;
  price: number | null;
  /** VAT/GST rate % applying to this line (null = not stated). */
  vatRate: number | null;
  /** Tax category code ("S", "Z", "E", "AE", "K", "G", "O"). */
  category: string;
  /** Line amount — VERBATIM from the XML. */
  amount: number;
  amountText: string;
}

export interface ETax {
  rate: number | null;
  category: string;
  /** Net basis this rate applies to. */
  basis: number | null;
  amount: number;
}

export interface EPayment {
  meansCode: string;
  accountName: string;
  accountId: string;
  upi: string;
}

export type ECheckKey = "lines" | "basis" | "taxSum" | "grand" | "payable";

export interface ECheck {
  key: ECheckKey;
  ok: boolean;
}

export interface EInvoice {
  format: EInvoiceFormat;
  kind: EInvoiceKind;
  /** Raw document type code ("380", "381"…), "" when absent. */
  typeCode: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  buyerReference: string;
  orderReference: string;
  seller: EParty;
  buyer: EParty;
  lines: ELine[];
  /** Document-level VAT/GST breakdown. */
  taxes: ETax[];
  /** Every total below is VERBATIM (as written) — null = absent. */
  lineTotal: number | null;
  allowance: number | null;
  charge: number | null;
  taxBasis: number | null;
  taxTotal: number | null;
  rounding: number | null;
  grandTotal: number | null;
  prepaid: number | null;
  payable: number | null;
  payment: EPayment;
  notes: string[];
  terms: string;
  /** Internal consistency checks (the tool's honest value-add). */
  checks: ECheck[];
  /** An Indian GST invoice (a GSTIN was found on either party). */
  gst: boolean;
  /** Decimals used to display amounts (≥ 2). */
  decimals: number;
}

/* ------------------------------------------------------------------ */
/* Dialect plumbing                                                    */
/* ------------------------------------------------------------------ */

const isUblNs = (ns: string): boolean =>
  ns.startsWith("urn:oasis:names:specification:ubl");
const isUnNs = (ns: string): boolean =>
  ns.startsWith("urn:un:unece:uncefact");

interface Dialect {
  /** Child lookup by local name within the dialect family. */
  el: (node: XmlNode, name: string) => XmlNode | undefined;
  all: (node: XmlNode, name: string) => XmlNode[];
  txt: (node: XmlNode, name: string) => string;
}

function dialectFor(root: XmlNode): Dialect | null {
  if (isUblNs(root.ns)) {
    return {
      el: (n, name) => n.children.find((c) => isUblNs(c.ns) && c.name === name),
      all: (n, name) => n.children.filter((c) => isUblNs(c.ns) && c.name === name),
      txt: (n, name) => {
        const c = n.children.find((x) => isUblNs(x.ns) && x.name === name);
        return c ? c.text.trim() : "";
      },
    };
  }
  if (isUnNs(root.ns)) {
    return {
      el: (n, name) => n.children.find((c) => isUnNs(c.ns) && c.name === name),
      all: (n, name) => n.children.filter((c) => isUnNs(c.ns) && c.name === name),
      txt: (n, name) => {
        const c = n.children.find((x) => isUnNs(x.ns) && x.name === name);
        return c ? c.text.trim() : "";
      },
    };
  }
  return null;
}

/** yyyymmdd (CII format 102) → yyyy-mm-dd; other formats pass through. */
function normalizeDate(raw: string, format?: string): string {
  const t = raw.trim();
  if (format === "102" && /^\d{8}$/.test(t)) {
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return t;
}

const KIND_BY_CODE: Record<string, EInvoiceKind> = {
  "380": "invoice",
  "381": "credit-note",
  "382": "invoice",
  "383": "debit-note",
  "384": "invoice",
  "385": "proforma",
  "386": "proforma",
  "389": "invoice",
  "326": "other",
};

/* ------------------------------------------------------------------ */
/* Party assembly (shared shape, dialect-specific paths)                */
/* ------------------------------------------------------------------ */

interface PartyPaths {
  nameNode: XmlNode | undefined;
  addressNode: XmlNode | undefined;
  taxNodes: XmlNode[];
  contactNode: XmlNode | undefined;
  endpointId: string;
  endpointScheme: string;
  identifications: { id: string; scheme: string }[];
}

function partyFrom(d: Dialect, paths: PartyPaths): EParty {
  // Name: legal registration first, trading name second.
  let name = "";
  if (paths.nameNode !== undefined) {
    const legal = d.el(paths.nameNode, "PartyLegalEntity") ??
      d.el(paths.nameNode, "SpecifiedLegalOrganization");
    if (legal !== undefined) name = d.txt(legal, "RegistrationName");
    if (name === "") name = d.txt(paths.nameNode, "Name");
    if (name === "") {
      const pn = d.el(paths.nameNode, "PartyName");
      if (pn !== undefined) name = d.txt(pn, "Name");
    }
    if (name === "") {
      const trade = d.el(paths.nameNode, "SpecifiedLegalOrganization");
      if (trade !== undefined) name = d.txt(trade, "TradingBusinessName");
    }
  }

  // Address.
  const lines: string[] = [];
  const a = paths.addressNode;
  if (a !== undefined) {
    for (const key of ["StreetName", "LineOne", "AdditionalStreetName", "LineTwo", "LineThree"]) {
      const v = d.txt(a, key);
      if (v !== "") lines.push(clampText(v, 160));
    }
    const city = d.txt(a, "CityName");
    const zip = d.txt(a, "PostalZone") || d.txt(a, "PostcodeCode");
    if (city !== "" || zip !== "") lines.push([city, zip].filter(Boolean).join(" "));
    const region = d.txt(a, "CountrySubentity") || d.txt(a, "CountrySubDivisionName");
    if (region !== "") lines.push(clampText(region, 80));
    const countryNode = d.el(a, "Country");
    const country =
      countryNode !== undefined
        ? d.txt(countryNode, "Name") || d.txt(countryNode, "IdentificationCode")
        : d.txt(a, "CountryID");
    if (country !== "") lines.push(country.toUpperCase() === country ? country : country);
  }

  // Tax ids: prefer a GSTIN anywhere, else the first registration.
  let taxId = "";
  let taxScheme = "";
  let gstin = "";
  for (const t of paths.taxNodes) {
    const id = d.txt(t, "CompanyID") || d.txt(t, "ID");
    if (id === "") continue;
    // CII carries schemeID on the ID CHILD (ram:ID schemeID="VA"); UBL uses
    // the TaxScheme child; older writers put it on the registration itself.
    const idNode = d.el(t, "ID");
    const taxSchemeNode = d.el(t, "TaxScheme");
    const scheme =
      d.txt(t, "Scheme") ||
      t.attrList.find((x) => x.name === "schemeID")?.value ||
      idNode?.attrList.find((x) => x.name === "schemeID")?.value ||
      (taxSchemeNode !== undefined ? d.txt(taxSchemeNode, "ID") : "");
    if (GSTIN_RE.test(id) && gstin === "") {
      gstin = id;
      taxId = id;
      taxScheme = "GST";
      break;
    }
    if (taxId === "") {
      taxId = id;
      taxScheme = scheme;
    }
  }
  if (gstin === "") {
    for (const ident of paths.identifications) {
      if (GSTIN_RE.test(ident.id)) {
        gstin = ident.id;
        taxId = ident.id;
        taxScheme = "GST";
        break;
      }
    }
  }

  // Contact.
  let email = "";
  let phone = "";
  const c = paths.contactNode;
  if (c !== undefined) {
    phone = d.txt(c, "Telephone") ||
      d.txt(d.el(c, "TelephoneUniversalCommunication") ?? c, "CompleteNumber");
    email = d.txt(c, "ElectronicMail") ||
      d.txt(d.el(c, "EmailURIUniversalCommunication") ?? c, "URIID");
  }
  // UBL endpoint (Indian e-invoices carry UPI here).
  if (email === "" && paths.endpointId !== "" && paths.endpointScheme === "EM") {
    email = paths.endpointId;
  }
  if (phone === "" && paths.endpointId !== "" && paths.endpointScheme === "Phone") {
    phone = paths.endpointId;
  }

  return {
    name: clampText(name, 200),
    lines,
    taxId,
    taxScheme,
    gstin,
    email: clampText(email, 120),
    phone: clampText(phone, 40),
  };
}

/* ------------------------------------------------------------------ */
/* The parse driver                                                      */
/* ------------------------------------------------------------------ */

export function parseEInvoice(bytes: Uint8Array): EInvoice {
  const root = parseXml(bytes);

  const isUbl =
    isUblNs(root.ns) && (root.name === "Invoice" || root.name === "CreditNote");
  const isCii = isUnNs(root.ns) && root.name === "CrossIndustryInvoice";
  if (!isUbl && !isCii) throw new Error("xinv.errorNotInvoice");

  const d = dialectFor(root)!;

  if (isUbl) return parseUbl(root, d, root.name === "CreditNote");
  return parseCii(root, d);
}

/* ------------------------------ UBL ------------------------------- */

function parseUbl(root: XmlNode, d: Dialect, isCreditNote: boolean): EInvoice {
  const number = clampText(d.txt(root, "ID"), 64);
  const typeCode = d.txt(root, isCreditNote ? "CreditNoteTypeCode" : "InvoiceTypeCode");

  // Note list (cbc:Note can repeat).
  const notes = d
    .all(root, "Note")
    .map((n) => clampText(n.text.trim(), 600))
    .filter(Boolean)
    .slice(0, MAX_NOTES);

  // ---- Parties.
  const supplier = d.el(root, "AccountingSupplierParty");
  const customer = d.el(root, "AccountingCustomerParty");
  const sellerParty = supplier !== undefined ? d.el(supplier, "Party") : undefined;
  const buyerParty = customer !== undefined ? d.el(customer, "Party") : undefined;

  const partyPaths = (p: XmlNode | undefined): PartyPaths => {
    if (p === undefined) {
      return {
        nameNode: undefined,
        addressNode: undefined,
        taxNodes: [],
        contactNode: undefined,
        endpointId: "",
        endpointScheme: "",
        identifications: [],
      };
    }
    const endpoint = d.el(p, "EndpointID");
    return {
      nameNode: p,
      addressNode: d.el(p, "PostalAddress"),
      taxNodes: d.all(p, "PartyTaxScheme"),
      contactNode: d.el(p, "Contact"),
      endpointId: endpoint !== undefined ? endpoint.text.trim() : "",
      endpointScheme:
        endpoint?.attrList.find((x) => x.name === "schemeID")?.value ?? "",
      identifications: d
        .all(p, "PartyIdentification")
        .map((pi) => {
          const idNode = d.el(pi, "ID");
          return {
            id: idNode !== undefined ? idNode.text.trim() : "",
            scheme:
              idNode?.attrList.find((x) => x.name === "schemeID")?.value ?? "",
          };
        })
        .filter((x) => x.id !== ""),
    };
  };

  const seller = partyFrom(d, partyPaths(sellerParty));
  const buyer = partyFrom(d, partyPaths(buyerParty));

  // ---- Lines.
  const lineNodes = d.all(root, isCreditNote ? "CreditNoteLine" : "InvoiceLine");
  const lines: ELine[] = lineNodes.slice(0, MAX_LINES).map((ln) => {
    const item = d.el(ln, "Item");
    const price = d.el(ln, "Price");
    let vatRate: number | null = null;
    let category = "";
    const lineTaxTotal = d.el(ln, "TaxTotal");
    if (lineTaxTotal !== undefined) {
      const sub = d.el(lineTaxTotal, "TaxSubtotal");
      if (sub !== undefined) {
        vatRate = num(d.txt(sub, "Percent"));
        const cat = d.el(sub, "TaxCategory");
        if (cat !== undefined) category = d.txt(cat, "ID");
      }
    }
    if (vatRate === null && item !== undefined) {
      const classified = d.el(item, "ClassifiedTaxCategory");
      if (classified !== undefined) {
        vatRate = num(d.txt(classified, "Percent"));
        category = category || d.txt(classified, "ID");
      }
    }
    const ids: string[] = [];
    if (item !== undefined) {
      const sellerId = d.el(item, "SellersItemIdentification");
      const sid = sellerId !== undefined ? d.txt(sellerId, "ID") : "";
      if (sid !== "") ids.push(sid);
      const stdId = d.el(item, "StandardItemIdentification");
      const gid = stdId !== undefined ? d.txt(stdId, "ID") : "";
      if (gid !== "") ids.push(gid);
      const commodity = d.el(item, "CommodityClassification");
      const hsn =
        commodity !== undefined ? d.txt(commodity, "ItemClassificationCode") : "";
      if (hsn !== "") ids.push(hsn);
    }
    const qtyNode =
      d.el(ln, isCreditNote ? "CreditedQuantity" : "InvoicedQuantity") ??
      d.el(ln, "InvoicedQuantity") ??
      d.el(ln, "BilledQuantity");
    const amountText = d.txt(ln, "LineExtensionAmount");
    return {
      id: clampText(d.txt(ln, "ID"), 16),
      name: clampText(item !== undefined ? d.txt(item, "Name") : "", 300),
      note: clampText(d.txt(ln, "Note"), 400),
      ids: ids.map((x) => clampText(x, 40)).slice(0, 4),
      qtyText: qtyNode !== undefined ? qtyNode.text.trim() : "",
      qty: qtyNode !== undefined ? num(qtyNode.text) : null,
      unit: qtyNode?.attrList.find((x) => x.name === "unitCode")?.value ?? "",
      priceText: price !== undefined ? d.txt(price, "PriceAmount") : "",
      price: price !== undefined ? num(d.txt(price, "PriceAmount")) : null,
      vatRate,
      category,
      amount: num(amountText) ?? 0,
      amountText,
    };
  });

  // ---- Totals + tax breakdown.
  const legal = d.el(root, "LegalMonetaryTotal");
  // Take the FIRST TaxTotal without currencyID (document currency).
  const taxTotalNode = d
    .all(root, "TaxTotal")
    .find((t) => !t.attrList.some((x) => x.name === "currencyID")) ??
    d.all(root, "TaxTotal")[0];
  const taxes: ETax[] = [];
  if (taxTotalNode !== undefined) {
    for (const sub of d.all(taxTotalNode, "TaxSubtotal")) {
      const cat = d.el(sub, "TaxCategory");
      taxes.push({
        rate: num(d.txt(sub, "Percent")),
        category: cat !== undefined ? d.txt(cat, "ID") : "",
        basis: num(d.txt(sub, "TaxableAmount")),
        amount: num(d.txt(sub, "TaxAmount")) ?? 0,
      });
    }
  }

  const means = d.el(root, "PaymentMeans");
  const finAccount = means !== undefined ? d.el(means, "PayeeFinancialAccount") : undefined;
  const termsNode = d.el(root, "PaymentTerms");
  const endpointUbl = d.el(sellerParty ?? root, "EndpointID");
  const upi =
    endpointUbl?.attrList.find((x) => x.name === "schemeID")?.value === "UPI"
      ? endpointUbl.text.trim()
      : "";

  const invoice: EInvoice = {
    format: "UBL",
    kind: KIND_BY_CODE[typeCode] ?? "invoice",
    typeCode,
    number,
    issueDate: normalizeDate(d.txt(root, "IssueDate")),
    dueDate: normalizeDate(d.txt(root, "DueDate")),
    currency: clampText(
      d.txt(root, "DocumentCurrencyCode") || d.txt(root, "TaxCurrencyCode"),
      3
    ).toUpperCase(),
    buyerReference: clampText(d.txt(root, "BuyerReference"), 120),
    orderReference: clampText(
      d.txt(d.el(root, "OrderReference") ?? root, "ID"),
      64
    ),
    seller,
    buyer,
    lines,
    taxes,
    lineTotal: legal !== undefined ? num(d.txt(legal, "LineExtensionAmount")) : null,
    allowance: legal !== undefined ? num(d.txt(legal, "AllowanceTotalAmount")) : null,
    charge: legal !== undefined ? num(d.txt(legal, "ChargeTotalAmount")) : null,
    taxBasis: legal !== undefined ? num(d.txt(legal, "TaxExclusiveAmount")) : null,
    taxTotal: taxTotalNode !== undefined ? num(d.txt(taxTotalNode, "TaxAmount")) : null,
    rounding: legal !== undefined ? num(d.txt(legal, "PayableRoundingAmount")) : null,
    grandTotal: legal !== undefined ? num(d.txt(legal, "TaxInclusiveAmount")) : null,
    prepaid: legal !== undefined ? num(d.txt(legal, "PrepaidAmount")) : null,
    payable: legal !== undefined ? num(d.txt(legal, "PayableAmount")) : null,
    payment: {
      meansCode: means !== undefined ? d.txt(means, "PaymentMeansCode") : "",
      accountName: finAccount !== undefined ? d.txt(finAccount, "Name") : "",
      accountId: finAccount !== undefined ? d.txt(finAccount, "ID") : "",
      upi,
    },
    notes,
    terms: clampText(termsNode !== undefined ? d.txt(termsNode, "Note") : "", 800),
    checks: [],
    gst: seller.gstin !== "" || buyer.gstin !== "",
    decimals: 2,
  };
  return finish(invoice);
}

/* ------------------------------ CII ------------------------------- */

function parseCii(root: XmlNode, d: Dialect): EInvoice {
  const doc = d.el(root, "ExchangedDocument") ?? root;
  const txn = d.el(root, "SupplyChainTradeTransaction") ?? root;
  const agreement =
    d.el(txn, "ApplicableHeaderTradeAgreement") ??
    d.el(root, "ApplicableHeaderTradeAgreement");
  const settlement =
    d.el(txn, "ApplicableHeaderTradeSettlement") ??
    d.el(root, "ApplicableHeaderTradeSettlement");

  const number = clampText(d.txt(doc, "ID"), 64);
  const typeCode = d.txt(doc, "TypeCode");
  const dateNode = d.el(doc, "IssueDateTime");
  const issueDateStr = d.el(dateNode ?? doc, "DateTimeString");
  const issueDate = normalizeDate(
    issueDateStr !== undefined ? issueDateStr.text.trim() : "",
    issueDateStr?.attrList.find((x) => x.name === "format")?.value
  );

  const notes: string[] = [];
  for (const inc of d.all(doc, "IncludedNote")) {
    const v = clampText(d.txt(inc, "Content"), 600);
    if (v !== "") notes.push(v);
  }

  // ---- Parties.
  const partyPaths = (name: string): PartyPaths => {
    const p = agreement !== undefined ? d.el(agreement, name) : undefined;
    return {
      nameNode: p,
      addressNode: p !== undefined ? d.el(p, "PostalTradeAddress") : undefined,
      taxNodes: p !== undefined ? d.all(p, "SpecifiedTaxRegistration") : [],
      contactNode: p !== undefined ? d.el(p, "DefinedTradeContact") : undefined,
      endpointId: "",
      endpointScheme: "",
      identifications: [],
    };
  };
  const seller = partyFrom(d, partyPaths("SellerTradeParty"));
  const buyer = partyFrom(d, partyPaths("BuyerTradeParty"));

  // ---- Lines.
  const lines: ELine[] = d
    .all(txn, "IncludedSupplyChainTradeLineItem")
    .slice(0, MAX_LINES)
    .map((li) => {
      const lineDoc = d.el(li, "AssociatedDocumentLineDocument");
      const product = d.el(li, "SpecifiedTradeProduct");
      const lineAgr = d.el(li, "SpecifiedLineTradeAgreement");
      const lineSet = d.el(li, "SpecifiedLineTradeSettlement");
      const lineSum =
        lineSet !== undefined
          ? d.el(lineSet, "SpecifiedTradeSettlementLineMonetarySummation")
          : undefined;

      let vatRate: number | null = null;
      let category = "";
      if (lineSet !== undefined) {
        const tt = d.el(lineSet, "ApplicableTradeTax");
        if (tt !== undefined) {
          vatRate = num(d.txt(tt, "RateApplicablePercent"));
          category = d.txt(tt, "CategoryCode");
        }
      }

      const ids: string[] = [];
      if (product !== undefined) {
        const sid = d.txt(product, "SellerAssignedID");
        if (sid !== "") ids.push(sid);
        const gidNode = d.el(product, "GlobalID");
        if (gidNode !== undefined && gidNode.text.trim() !== "") {
          ids.push(gidNode.text.trim());
        }
        const classNode = d.el(product, "DesignatedProductClassification");
        if (classNode !== undefined) {
          const code = d.txt(classNode, "ClassCode");
          if (code !== "") ids.push(code);
        }
      }

      const qtyNode =
        d.el(li, "InvoicedQuantity") ??
        d.el(li, "BilledQuantity") ??
        // CII D16B carries the quantity inside the delivery term.
        d.el(d.el(li, "SpecifiedLineTradeDelivery") ?? li, "BilledQuantity") ??
        d.el(d.el(li, "SpecifiedLineTradeDelivery") ?? li, "InvoicedQuantity");
      const priceNode =
        lineAgr !== undefined
          ? // CII D16B / Factur-X: NetPriceProductTradePrice; older writers
            // (and our own P10 fixtures) ship the truncated NetPriceProductPrice.
            (d.el(lineAgr, "NetPriceProductTradePrice") ??
              d.el(lineAgr, "NetPriceProductPrice"))
          : undefined;
      const amountText = lineSum !== undefined ? d.txt(lineSum, "LineTotalAmount") : "";

      return {
        id: clampText(lineDoc !== undefined ? d.txt(lineDoc, "LineID") : "", 16),
        name: clampText(product !== undefined ? d.txt(product, "Name") : "", 300),
        note: clampText(
          lineDoc !== undefined ? d.txt(lineDoc, "IncludedNote") : "",
          400
        ),
        ids: ids.map((x) => clampText(x, 40)).slice(0, 4),
        qtyText: qtyNode !== undefined ? qtyNode.text.trim() : "",
        qty: qtyNode !== undefined ? num(qtyNode.text) : null,
        unit: qtyNode?.attrList.find((x) => x.name === "unitCode")?.value ?? "",
        priceText: priceNode !== undefined ? d.txt(priceNode, "ChargeAmount") : "",
        price: priceNode !== undefined ? num(d.txt(priceNode, "ChargeAmount")) : null,
        vatRate,
        category,
        amount: num(amountText) ?? 0,
        amountText,
      };
    });

  // ---- Taxes + totals.
  const taxes: ETax[] = [];
  if (settlement !== undefined) {
    for (const tt of d.all(settlement, "ApplicableTradeTax")) {
      taxes.push({
        rate: num(d.txt(tt, "RateApplicablePercent")),
        category: d.txt(tt, "CategoryCode"),
        basis: num(d.txt(tt, "BasisAmount")),
        amount: num(d.txt(tt, "CalculatedAmount")) ?? 0,
      });
    }
  }

  const summ =
    settlement !== undefined
      ? d.el(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation")
      : undefined;
  const t = (name: string): number | null =>
    summ !== undefined ? num(d.txt(summ, name)) : null;

  const means =
    settlement !== undefined
      ? d.el(settlement, "SpecifiedTradeSettlementPaymentMeans")
      : undefined;
  const finAccount =
    means !== undefined ? d.el(means, "PayeePartyCreditorFinancialAccount") : undefined;
  const termsNode =
    settlement !== undefined ? d.el(settlement, "SpecifiedTradePaymentTerms") : undefined;
  const dueNode =
    termsNode !== undefined ? d.el(termsNode, "DueDateDateTime") : undefined;
  const dueDateStr = d.el(dueNode ?? termsNode ?? root, "DateTimeString");

  const invoice: EInvoice = {
    format: "CII",
    kind: KIND_BY_CODE[typeCode] ?? "invoice",
    typeCode,
    number,
    issueDate,
    dueDate: normalizeDate(
      dueDateStr !== undefined ? dueDateStr.text.trim() : "",
      dueDateStr?.attrList.find((x) => x.name === "format")?.value
    ),
    currency: clampText(
      settlement !== undefined ? d.txt(settlement, "InvoiceCurrencyCode") : "",
      3
    ).toUpperCase(),
    buyerReference: clampText(
      agreement !== undefined ? d.txt(agreement, "BuyerReference") : "",
      120
    ),
    orderReference: "",
    seller,
    buyer,
    lines,
    taxes,
    lineTotal: t("LineTotalAmount"),
    allowance: t("AllowanceTotalAmount"),
    charge: t("ChargeTotalAmount"),
    taxBasis: t("TaxBasisTotalAmount"),
    taxTotal: t("TaxTotalAmount"),
    rounding: t("RoundingAmount"),
    grandTotal: t("GrandTotalAmount"),
    prepaid: t("TotalPrepaidAmount"),
    // D16B / Factur-X name is DuePayableAmount; older writers (and the P10
    // fixtures) use TotalAmountDueForPayment — read both, prefer neither.
    payable: t("DuePayableAmount") ?? t("TotalAmountDueForPayment"),
    payment: {
      meansCode: means !== undefined ? d.txt(means, "TypeCode") : "",
      accountName: finAccount !== undefined ? d.txt(finAccount, "AccountName") : "",
      accountId:
        finAccount !== undefined
          ? d.txt(finAccount, "IBANID") || d.txt(finAccount, "ProprietaryID")
          : "",
      upi: "",
    },
    notes,
    terms: clampText(termsNode !== undefined ? d.txt(termsNode, "Description") : "", 800),
    checks: [],
    gst: seller.gstin !== "" || buyer.gstin !== "",
    decimals: 2,
  };
  return finish(invoice);
}

/* ------------------------------------------------------------------ */
/* Shared finishing: derived totals + the consistency checks            */
/* ------------------------------------------------------------------ */

function finish(inv: EInvoice): EInvoice {
  // Derive what the file omitted (a missing total is NOT an error —
  // only a WRONG total is; the checks below compare claimed vs listed).
  const sumLines = inv.lines.reduce((a, l) => a + l.amount, 0);
  const lineTotal = inv.lineTotal ?? sumLines;
  const allowance = inv.allowance ?? 0;
  const charge = inv.charge ?? 0;
  const taxBasis = inv.taxBasis ?? lineTotal - allowance + charge;
  const taxSum = inv.taxes.reduce((a, x) => a + x.amount, 0);
  const taxTotal = inv.taxTotal ?? (inv.taxes.length ? taxSum : 0);
  const rounding = inv.rounding ?? 0;
  const grandTotal = inv.grandTotal ?? taxBasis + taxTotal + rounding;
  const prepaid = inv.prepaid ?? 0;
  const payable = inv.payable ?? grandTotal - prepaid;

  const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOL;

  const checks: ECheck[] = [
    { key: "lines", ok: near(sumLines, lineTotal) },
    { key: "basis", ok: near(lineTotal - allowance + charge, taxBasis) },
    {
      key: "taxSum",
      ok: inv.taxes.length === 0 || inv.taxTotal === null || near(taxSum, taxTotal),
    },
    { key: "grand", ok: near(taxBasis + taxTotal + rounding, grandTotal) },
    {
      key: "payable",
      ok: inv.payable === null || near(grandTotal - prepaid, payable),
    },
  ];

  const decimals = (() => {
    let d = currencyDecimals(inv.currency);
    for (const raw of [
      inv.payable,
      inv.grandTotal,
      inv.taxTotal,
      inv.lineTotal,
    ]) {
      if (raw !== null) d = Math.max(d, sourceDecimals(String(raw)));
    }
    return d;
  })();

  return {
    ...inv,
    lineTotal,
    allowance,
    charge,
    taxBasis,
    taxTotal,
    rounding,
    grandTotal,
    prepaid,
    payable,
    checks,
    decimals,
  };
}

/* ------------------------------------------------------------------ */
/* Money + unit formatting (shared by the surface preview and the PDF)  */
/* ------------------------------------------------------------------ */

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** "1,23,456.78 ₹" — INR uses en-IN grouping, everything else en-US. */
export function formatAmount(inv: EInvoice, value: number, locale?: string): string {
  const loc = locale ?? (inv.currency === "INR" ? "en-IN" : "en-US");
  const n = value.toLocaleString(loc, {
    minimumFractionDigits: inv.decimals,
    maximumFractionDigits: inv.decimals,
  });
  const sym = CURRENCY_SYMBOL[inv.currency] ?? inv.currency;
  return inv.currency === "INR" || inv.currency === "USD"
    ? `${sym}${n}`
    : `${n} ${sym}`;
}

/** Percent for tax rates: 19 → "19%", 19.5 → "19.5%". */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Number(rate.toFixed(4))}%`;
}

/** Quantity with a readable unit code suffix. */
const UNITS: Record<string, string> = {
  EA: "pcs",
  C62: "pcs",
  HUR: "h",
  KGM: "kg",
  MTR: "m",
  LTR: "l",
  DAY: "days",
  MON: "months",
  BOX: "box",
  PK: "pack",
  SET: "set",
  ONE: "unit",
};

export function formatQty(line: ELine): string {
  if (line.qtyText === "") return "—";
  const unit = line.unit !== "" ? UNITS[line.unit.toUpperCase()] ?? line.unit : "";
  return unit !== "" ? `${line.qtyText} ${unit}` : line.qtyText;
}

/** Output file base name: sanitized invoice number, else "e-invoice". */
export function outputBaseName(inv: EInvoice): string {
  const base = (inv.number || "e-invoice")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "e-invoice";
}
