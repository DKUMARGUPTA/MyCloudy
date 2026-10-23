/**
 * Smoke: create-electronic-invoice (RB5-b) — Factur-X attachment + XMP
 * embedder, 100% on-device.
 *
 * House conventions: REAL fixtures built in-script (a 2-page pdf-lib PDF;
 * a PDF/A-marked variant with an /OutputIntents + a pdfaid XMP), the REAL
 * worker driven in-process through the self/postMessage shim (smoke-pdf-
 * to-markdown pattern), node:zlib as the inflate oracle for the embedded
 * file stream, an INDEPENDENT mini XML well-formedness parser (smoke-side
 * oracle — no code shared with the model), pdf.js getAttachments() as the
 * reader-level attachment check, and process.exit at the end.
 *
 * Run: bun scripts/smoke-create-electronic-invoice.ts
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import type { PDFRef } from "pdf-lib";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  FX_NAMESPACE,
  buildXmpPacket,
  classifyCeiError,
  fmtMoney,
  normalizeLevel,
  sampleXmlFromForm,
  validateCiiShape,
} from "../tools/create-electronic-invoice/model";
import {
  FACTUR_X_FILENAME,
  type CeiDetail,
  type SampleInvoiceForm,
} from "../tools/create-electronic-invoice/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/** pdf-lib emits text as literal or hex tokens — the house needle match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

/* ------------------------------------------------------------------ */
/* Smoke-side oracles (INDEPENDENT of the model — that's the point)     */
/* ------------------------------------------------------------------ */

interface XmlResult {
  ok: boolean;
  error: string;
}

/** Stack-based well-formedness checker: PI/comment/DOCTYPE/CDATA aware. */
function xmlWellFormed(source: string): XmlResult {
  let s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  s = s.replace(/<\?[\s\S]*?\?>/g, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<!DOCTYPE[\s\S]*?>/g, "");
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "CDATA");
  const stack: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt === -1) break;
    if (s.startsWith("</", lt)) {
      const gt = s.indexOf(">", lt);
      if (gt === -1) return { ok: false, error: "unterminated close tag" };
      const name = s.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (top !== name) {
        return {
          ok: false,
          error: `mismatch </${name}> closes <${top ?? "nothing"}>`,
        };
      }
      i = gt + 1;
      continue;
    }
    let gt = -1;
    let quote = "";
    for (let j = lt + 1; j < n; j += 1) {
      const c = s.charAt(j);
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === ">") {
        gt = j;
        break;
      }
    }
    if (gt === -1) return { ok: false, error: "unterminated tag" };
    if (quote !== "") return { ok: false, error: "unclosed attr quote" };
    let inner = s.slice(lt + 1, gt);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^[A-Za-z_:][\w.:-]*/.exec(inner);
    if (!nameMatch) return { ok: false, error: "bad tag name" };
    if (!selfClosing) stack.push(nameMatch[0]);
    i = gt + 1;
  }
  if (stack.length > 0) {
    return { ok: false, error: `unclosed <${stack[stack.length - 1]}>` };
  }
  return { ok: true, error: "" };
}

/** Content of `<tag…>text</tag>` (first occurrence from `from`). */
function tagText(source: string, tag: string, from = 0): string {
  const open = source.indexOf(`<${tag}`, from);
  if (open === -1) return "";
  const openEnd = source.indexOf(">", open);
  if (openEnd === -1) return "";
  if (source.charAt(openEnd - 1) === "/") return "";
  const close = source.indexOf(`</${tag}>`, openEnd);
  if (close === -1) return "";
  return source.slice(openEnd + 1, close).trim();
}

/** Counts `<tag` open tags (not closes). */
function countOpen(source: string, tag: string): number {
  let count = 0;
  const needle = `<${tag}`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    const after = source.charAt(at + needle.length);
    if (after === "" || after === ">" || after === "/" || after === " " ||
      after === "\t" || after === "\n" || after === "\r") {
      count += 1;
    }
    at = source.indexOf(needle, at + 1);
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* The self shim + the REAL worker import                               */
/* ------------------------------------------------------------------ */

const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
const captured: unknown[] = [];
let settleRun: ((msg: unknown) => void) | null = null;
workerGlobal.postMessage = (msg: unknown): void => {
  captured.push(msg);
  const type = (msg as { type?: string } | null)?.type;
  if ((type === "result" || type === "error") && settleRun) {
    const settle = settleRun;
    settleRun = null;
    settle(msg);
  }
};
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;

/* The worker module import — shim must be installed FIRST. */
await import("../tools/create-electronic-invoice/worker");

interface WorkerFile {
  name: string;
  blob: Blob;
}

/** Drives the real worker's onmessage; resolves on result/error. */
function driveWorker(
  files: WorkerFile[],
  options: Record<string, unknown>,
  runId: number
): Promise<unknown> {
  const fileObjects = files.map(
    (f) => new File([f.blob], f.name, { type: "application/octet-stream" })
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker drive timeout")),
      30_000
    );
    settleRun = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    workerGlobal.onmessage?.({
      data: {
        type: "run",
        runId,
        toolId: "create-electronic-invoice",
        options,
        files: fileObjects,
      },
    });
  });
}

function asResult(msg: unknown): {
  outputs: { name: string; mime: string; blob: Blob }[];
  detail: CeiDetail;
} {
  const data = msg as {
    type: string;
    outputs: { name: string; mime: string; blob: Blob }[];
    detail: CeiDetail;
  };
  if (data.type !== "result") {
    throw new Error(`expected result, got ${JSON.stringify(msg).slice(0, 200)}`);
  }
  return { outputs: data.outputs, detail: data.detail };
}

function asError(msg: unknown): { code: string } {
  const data = msg as { type: string; code: string };
  if (data.type !== "error") {
    throw new Error(`expected error, got ${JSON.stringify(msg).slice(0, 200)}`);
  }
  return { code: data.code };
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function buildSourcePdf(
  pages: number,
  needle: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`${needle} - page ${p}`, { x: 40, y: 780, size: 14, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** A 2-page PDF that already carries an /OutputIntents entry. */
async function buildOutputIntentPdf(): Promise<Uint8Array> {
  const base = await buildSourcePdf(2, "OI fixture");
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const iccDict = PDFDict.withContext(doc.context);
  iccDict.set(PDFName.of("N"), doc.context.obj(4));
  const iccStream = PDFRawStream.of(
    iccDict,
    new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  );
  const iccRef = doc.context.register(iccStream);
  const oi = PDFDict.withContext(doc.context);
  oi.set(PDFName.of("Type"), PDFName.of("OutputIntent"));
  oi.set(PDFName.of("S"), PDFName.of("GTS_PDFA1"));
  oi.set(PDFName.of("OutputConditionIdentifier"), PDFString.of("sRGB IEC61966-2.1"));
  oi.set(PDFName.of("DestOutputProfile"), iccRef);
  const oiRef = doc.context.register(oi);
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([oiRef]));
  return doc.save({ useObjectStreams: false });
}

/** A 1-page PDF that already carries a pdfaid XMP /Metadata packet. */
async function buildPdfaidXmpPdf(): Promise<Uint8Array> {
  const base = await buildSourcePdf(1, "pdfaid fixture");
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const packet =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ` +
    `xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">` +
    `<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const dict = PDFDict.withContext(doc.context);
  dict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  dict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const stream = PDFRawStream.of(dict, new Uint8Array(Buffer.from(packet, "utf8")));
  const ref = doc.context.register(stream);
  doc.catalog.set(PDFName.of("Metadata"), ref);
  return doc.save({ useObjectStreams: false });
}

const SAMPLE_FORM: SampleInvoiceForm = {
  seller: "Acme Supplies GmbH",
  buyer: "Buyer Industries Ltd.",
  number: "RE-2026-042",
  date: "2026-01-15",
  currency: "EUR",
  taxRate: 18,
  items: [
    { name: "Widget assembly", qty: 2, unitPrice: 120 },
    { name: "Cable set", qty: 5, unitPrice: 12.5 },
    { name: "Spare screws", qty: 100, unitPrice: 0.2 },
  ],
};

const SAMPLE_XML = sampleXmlFromForm(SAMPLE_FORM);

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("── 1. normalizeLevel ─────────────────────────────────────");
  {
    check("EN 16931 passes through", normalizeLevel("EN 16931") === "EN 16931");
    check("MINIMUM passes through", normalizeLevel("MINIMUM") === "MINIMUM");
    check("BASIC passes through", normalizeLevel("BASIC") === "BASIC");
    check(
      "garbage → honest EN 16931 default",
      normalizeLevel("PDF/A-9 LOL") === "EN 16931",
      normalizeLevel("PDF/A-9 LOL")
    );
    check(
      "undefined → default (defensive)",
      normalizeLevel(undefined) === "EN 16931"
    );
  }

  console.log("\n── 2. buildXmpPacket (independent XML oracle) ────────────");
  {
    for (const level of ["EN 16931", "MINIMUM", "BASIC"] as const) {
      const packet = buildXmpPacket(level, "MyCloudy (mycloudy.in)");
      const parsed = xmlWellFormed(packet);
      check(
        `level ${level}: packet is well-formed XML (${parsed.error})`,
        parsed.ok,
        parsed
      );
      check(
        `level ${level}: fx:ConformanceLevel matches`,
        tagText(packet, "fx:ConformanceLevel") === level,
        tagText(packet, "fx:ConformanceLevel")
      );
    }
    const packet = buildXmpPacket("EN 16931", "MyCloudy (mycloudy.in)");
    check(
      "xpacket begin/end wrappers present",
      packet.includes('<?xpacket begin=""') && packet.includes('<?xpacket end="w"?>')
    );
    check(
      "x:xmpmeta + rdf:RDF skeleton present",
      packet.includes("<x:xmpmeta") && packet.includes("<rdf:RDF")
    );
    check(
      "rdf namespace is the real one",
      packet.includes('xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"')
    );
    check(
      `fx namespace is the official Factur-X urn`,
      packet.includes(`xmlns:fx="${FX_NAMESPACE}"`),
      FX_NAMESPACE
    );
    check("dc namespace declared", packet.includes('xmlns:dc="http://purl.org/dc/elements/1.1/"'));
    check("pdf namespace declared", packet.includes('xmlns:pdf="http://ns.adobe.com/pdf/1.3/"'));
    check("xmp namespace declared", packet.includes('xmlns:xmp="http://ns.adobe.com/xap/1.0/"'));
    check("fx:DocumentType is INVOICE", tagText(packet, "fx:DocumentType") === "INVOICE");
    check(
      "fx:DocumentFileName is factur-x.xml",
      tagText(packet, "fx:DocumentFileName") === FACTUR_X_FILENAME
    );
    check("fx:Version is 1.0", tagText(packet, "fx:Version") === "1.0");
    check("dc:format is application/pdf", tagText(packet, "dc:format") === "application/pdf");
    check(
      "pdf:Producer is the brand",
      tagText(packet, "pdf:Producer") === "MyCloudy (mycloudy.in)"
    );
    check(
      "xmp:CreatorTool is the brand",
      tagText(packet, "xmp:CreatorTool") === "MyCloudy (mycloudy.in)"
    );
    const escaped = buildXmpPacket("BASIC", 'Weird & "<Brand>"');
    const parsedEsc = xmlWellFormed(escaped);
    check(
      "XML-special producer chars are escaped (still well-formed)",
      parsedEsc.ok,
      parsedEsc
    );
    check(
      "escaped producer round-trips the ESCAPED text (entities intact)",
      tagText(escaped, "pdf:Producer") === "Weird &amp; &quot;&lt;Brand&gt;&quot;"
    );
    check(
      "garbage level inside the packet stays the normalized default",
      tagText(buildXmpPacket("nope", "x"), "fx:ConformanceLevel") === "EN 16931"
    );
  }

  console.log("\n── 3. sampleXmlFromForm (structure + math oracle) ────────");
  {
    const parsed = xmlWellFormed(SAMPLE_XML);
    check("sample is well-formed XML", parsed.ok, parsed);
    check(
      "root is rsm:CrossIndustryInvoice",
      countOpen(SAMPLE_XML, "rsm:CrossIndustryInvoice") === 1
    );
    check(
      "rsm/ram/udt namespaces declared",
      SAMPLE_XML.includes('xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"') &&
        SAMPLE_XML.includes('xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"') &&
        SAMPLE_XML.includes('xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"')
    );
    check(
      "guideline is EN 16931",
      tagText(SAMPLE_XML, "ram:ID") === "urn:cen.eu:en16931:2017",
      tagText(SAMPLE_XML, "ram:ID")
    );
    check(
      "invoice number is the ExchangedDocument ID (not the guideline)",
      validateCiiShape(SAMPLE_XML).invoiceId === "RE-2026-042",
      validateCiiShape(SAMPLE_XML).invoiceId
    );
    check("TypeCode is 380 (commercial invoice)", tagText(SAMPLE_XML, "ram:TypeCode") === "380");
    check(
      "issue date is format 102 CCYYMMDD",
      /format="102"/.test(SAMPLE_XML) &&
        tagText(SAMPLE_XML, "udt:DateTimeString") === "20260115"
    );
    check("3 line items emitted", countOpen(SAMPLE_XML, "ram:IncludedSupplyChainTradeLineItem") === 3);
    check("LineIDs are 1,2,3", (SAMPLE_XML.match(/<ram:LineID>(\d+)<\/ram:LineID>/g) ?? []).join(",") === "<ram:LineID>1</ram:LineID>,<ram:LineID>2</ram:LineID>,<ram:LineID>3</ram:LineID>");
    check(
      "seller name present",
      SAMPLE_XML.includes("<ram:Name>Acme Supplies GmbH</ram:Name>")
    );
    check(
      "buyer name present",
      SAMPLE_XML.includes("<ram:Name>Buyer Industries Ltd.</ram:Name>")
    );
    check("delivery element present (may be self-closing)", SAMPLE_XML.includes("ram:ApplicableHeaderTradeDelivery"));
    check("currency is EUR", tagText(SAMPLE_XML, "ram:InvoiceCurrencyCode") === "EUR");

    // Independent math oracle: recompute every total from the same inputs.
    const lineTotals = SAMPLE_FORM.items.map((i) => Math.round(i.qty * i.unitPrice * 100) / 100);
    const lineTotal = Math.round(lineTotals.reduce((a, b) => a + b, 0) * 100) / 100;
    const tax = Math.round((lineTotal * SAMPLE_FORM.taxRate) / 100 * 100) / 100;
    const grand = lineTotal + tax;
    check(
      "per-line LineTotalAmount values match qty × price",
      (SAMPLE_XML.match(/<ram:LineTotalAmount>([\d.]+)<\/ram:LineTotalAmount>/g) ?? [])
        .map((m) => m.replace(/[^\d.]/g, ""))
        .slice(0, 3)
        .join(",") === lineTotals.map((v) => fmtMoney(v)).join(","),
      SAMPLE_XML.match(/<ram:LineTotalAmount>([\d.]+)<\/ram:LineTotalAmount>/g)
    );
    const headerLineTotal = (SAMPLE_XML.match(/<ram:LineTotalAmount>([\d.]+)<\/ram:LineTotalAmount>/g) ?? []).map((m) => m.replace(/[^\d.]/g, ""));
    check("header LineTotalAmount == sum (last occurrence)", headerLineTotal[headerLineTotal.length - 1] === fmtMoney(lineTotal), headerLineTotal);
    check("BasisAmount == LineTotalAmount", tagText(SAMPLE_XML, "ram:BasisAmount") === fmtMoney(lineTotal));
    check("CalculatedAmount == round(basis × rate)", tagText(SAMPLE_XML, "ram:CalculatedAmount") === fmtMoney(tax));
    check("TaxBasisTotalAmount == sum", tagText(SAMPLE_XML, "ram:TaxBasisTotalAmount") === fmtMoney(lineTotal));
    check("TaxTotalAmount == tax (with currencyID)", /<ram:TaxTotalAmount currencyID="EUR">/.test(SAMPLE_XML) && tagText(SAMPLE_XML, "ram:TaxTotalAmount") === fmtMoney(tax));
    check("GrandTotalAmount == basis + tax", tagText(SAMPLE_XML, "ram:GrandTotalAmount") === fmtMoney(grand));
    check("DuePayableAmount == grand", tagText(SAMPLE_XML, "ram:DuePayableAmount") === fmtMoney(grand));
    check(
      "RateApplicablePercent == 18.00",
      tagText(SAMPLE_XML, "ram:RateApplicablePercent") === "18.00"
    );
    check(
      "standard rate → CategoryCode S",
      tagText(SAMPLE_XML, "ram:CategoryCode") === "S"
    );

    // Edge + coercion vectors.
    const one = sampleXmlFromForm({
      ...SAMPLE_FORM,
      items: [{ name: "Only item", qty: 1, unitPrice: 99.999 }],
    });
    check(
      "1 item: line total rounds to 100.00",
      tagText(one, "ram:LineTotalAmount") === "100.00" &&
        countOpen(one, "ram:IncludedSupplyChainTradeLineItem") === 1,
      tagText(one, "ram:LineTotalAmount")
    );
    const zero = sampleXmlFromForm({ ...SAMPLE_FORM, taxRate: 0 });
    check(
      "0% rate → zero-rated CategoryCode Z + 0.00 tax",
      tagText(zero, "ram:CategoryCode") === "Z" &&
        tagText(zero, "ram:CalculatedAmount") === "0.00",
      { cat: tagText(zero, "ram:CategoryCode"), tax: tagText(zero, "ram:CalculatedAmount") }
    );
    const esc = sampleXmlFromForm({
      ...SAMPLE_FORM,
      seller: 'Smith & Sons <GmbH> "HQ"',
      number: "A&B-1",
    });
    const escParsed = xmlWellFormed(esc);
    check("XML-special seller/number escaped → still well-formed", escParsed.ok, escParsed);
    check(
      "escaped values round-trip",
      esc.includes("<ram:Name>Smith &amp; Sons &lt;GmbH&gt; &quot;HQ&quot;</ram:Name>")
    );
    const clamped = sampleXmlFromForm({
      ...SAMPLE_FORM,
      items: [
        { name: "a", qty: 1, unitPrice: 1 },
        { name: "b", qty: 2, unitPrice: 2 },
        { name: "c", qty: 3, unitPrice: 3 },
        { name: "d", qty: 4, unitPrice: 4 },
      ],
    });
    check("4 items clamp to 3", countOpen(clamped, "ram:IncludedSupplyChainTradeLineItem") === 3);
    const empty = sampleXmlFromForm({
      seller: "",
      buyer: "",
      number: "",
      date: "not-a-date",
      currency: "XYZ",
      taxRate: Number.NaN,
      items: [],
    });
    check(
      "empty form → fallbacks (seller/number/EUR/18%/1 item/fallback date)",
      validateCiiShape(empty).invoiceId === "SAMPLE-1" &&
        empty.includes("<ram:Name>Sample Seller</ram:Name>") &&
        tagText(empty, "ram:InvoiceCurrencyCode") === "EUR" &&
        tagText(empty, "ram:RateApplicablePercent") === "18.00" &&
        tagText(empty, "udt:DateTimeString") === "20260101" &&
        countOpen(empty, "ram:IncludedSupplyChainTradeLineItem") === 1,
      {
        id: validateCiiShape(empty).invoiceId,
        cur: tagText(empty, "ram:InvoiceCurrencyCode"),
      }
    );
    const inr = sampleXmlFromForm({ ...SAMPLE_FORM, currency: "INR" });
    check("INR currency accepted", tagText(inr, "ram:InvoiceCurrencyCode") === "INR");
    check(
      "sample XML passes its own shape sniff (round-trip)",
      validateCiiShape(SAMPLE_XML).ok === true
    );
  }

  console.log("\n── 4. validateCiiShape ──────────────────────────────────");
  {
    const shape = validateCiiShape(SAMPLE_XML);
    check("full sample: ok + all markers", shape.ok && shape.rootOk && shape.contextOk && shape.settlementOk, shape);
    check("full sample: invoice id", shape.invoiceId === "RE-2026-042");
    check("full sample: currency", shape.currency === "EUR");
    check("full sample: line count 3", shape.lineCount === 3);

    const bom = validateCiiShape(`\uFEFF${SAMPLE_XML}`);
    check("BOM tolerated", bom.ok === true);

    const html = validateCiiShape("<html><body>no</body></html>");
    check("non-CII XML → rootOk false, ok false", !html.rootOk && !html.ok, html);

    const noSettlement = SAMPLE_XML.replace(/<ram:ApplicableHeaderTradeSettlement>[\s\S]*?<\/ram:ApplicableHeaderTradeSettlement>/, "");
    const shape2 = validateCiiShape(noSettlement);
    check(
      "missing settlement → ok false, root still ok (honest partial)",
      !shape2.ok && shape2.rootOk && !shape2.settlementOk,
      shape2
    );

    const noContext = SAMPLE_XML.replace(/<rsm:ExchangedDocumentContext>[\s\S]*?<\/rsm:ExchangedDocumentContext>/, "");
    const shape3 = validateCiiShape(noContext);
    check("missing context → contextOk false", shape3.ok === false && shape3.contextOk === false, shape3);

    check("empty string → all false", (() => {
      const s = validateCiiShape("");
      return !s.ok && !s.rootOk && !s.contextOk && !s.settlementOk;
    })());

    // Prefix-similar elements must NOT satisfy the root check.
    const tricky = `<rsm:CrossIndustryInvoiceTypo xmlns:rsm="urn:x"/>`;
    check(
      "near-miss root name rejected",
      validateCiiShape(tricky).rootOk === false
    );
    // A root that only appears in an attribute value is not an element.
    const attr = `<other root="<rsm:CrossIndustryInvoice">x</other>`;
    check(
        "root-looking attribute value rejected",
      validateCiiShape(attr).rootOk === false
    );
  }

  console.log("\n── 5. classifyCeiError ──────────────────────────────────");
  {
    check(
      "encrypted → tool.errorEncrypted",
      classifyCeiError(new Error("Input document to PDFDocument.load is encrypted")) === "tool.errorEncrypted"
    );
    check(
      "garbage → tool.errorCorrupt",
      classifyCeiError(new Error("Failed to parse")) === "tool.errorCorrupt"
    );
  }

  console.log("\n── 6. REAL E2E through the worker (self-shimmed) ───────");
  let outBytes: Uint8Array;
  {
    const srcPdf = await buildSourcePdf(2, "CEI E2E needle");
    const result = asResult(
      await driveWorker(
        [
          { name: "invoice-2026.pdf", blob: new Blob([srcPdf as BlobPart]) },
          { name: "data.xml", blob: new Blob([SAMPLE_XML], { type: "text/xml" }) },
        ],
        { level: "EN 16931" },
        101
      )
    );
    check("one output produced", result.outputs.length === 1, result.outputs.length);
    const out = result.outputs[0];
    check(
      "output name is <base>-facturx.pdf",
      out.name === "invoice-2026-facturx.pdf",
      out.name
    );
    check("output mime is application/pdf", out.mime === "application/pdf");
    outBytes = await blobBytes(out.blob);
    check("%PDF magic in the output", outBytes[0] === 0x25 && outBytes[1] === 0x50);

    const d = result.detail;
    check("pages preserved (2)", d.pages === 2, d.pages);
    check(
      "attachment name reported",
      d.attachmentName === FACTUR_X_FILENAME,
      d.attachmentName
    );
    check(
      "attachment bytes == XML byte length",
      d.attachmentBytes === new TextEncoder().encode(SAMPLE_XML).length,
      d.attachmentBytes
    );
    check("conformance level EN 16931 reported", d.conformanceLevel === "EN 16931");
    check("afPresent true (catalog /AF holds the Filespec)", d.afPresent === true);
    check("afRelationshipAlternative true", d.afRelationshipAlternative === true);
    check("xmpWritten true", d.xmpWritten === true);
    check("xmlShapeOk true", d.xmlShapeOk === true);
    check("xmlInvoiceId reported", d.xmlInvoiceId === "RE-2026-042");
    check("xmlCurrency reported", d.xmlCurrency === "EUR");
    check("xmlLineCount reported", d.xmlLineCount === 3);
    check("plain source: no output intent, no pdfaid", d.sourceOutputIntent === false && d.sourceXmpPdfaid === false, d);
    check(
      "beforeBytes == source size",
      d.beforeBytes === srcPdf.length,
      { before: d.beforeBytes, src: srcPdf.length }
    );
    check(
      "afterBytes == real output size",
      d.afterBytes === outBytes.length,
      { after: d.afterBytes, out: outBytes.length }
    );

    // Raw byte scan — object streams OFF, AF + AFRelationship + XMP visible.
    const raw = Buffer.from(outBytes).toString("latin1");
    check("no /ObjStm in the output (loose objects)", !raw.includes("/ObjStm"));
    check("/AF raw bytes present", raw.includes("/AF"));
    check("/AFRelationship /Alternative raw bytes present", raw.includes("/AFRelationship /Alternative"));
    check("XMP packet raw (uncompressed) present", raw.includes("x:xmpmeta") && raw.includes("fx:DocumentType"));
    check("no fake /Linearized flag ever", !raw.includes("/Linearized"));

    // Strict reload — parse-level asserts.
    const re = await PDFDocument.load(outBytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("strict reload: 2 pages", re.getPageCount() === 2);

    const af = re.catalog.lookup(PDFName.of("AF"), PDFArray);
    check("reload: catalog /AF array size 1", af !== undefined && af.size() === 1, af?.size());
    let filespec: PDFDict | null = null;
    if (af && af.size() === 1 && isRef(af.get(0))) {
      const fs = re.context.lookup(af.get(0) as PDFRef);
      if (fs instanceof PDFDict) filespec = fs;
    }
    check("reload: Filespec dict found via /AF", filespec !== null);
    if (filespec) {
      check(
        "Filespec /Type /Filespec",
        String(filespec.get(PDFName.of("Type"))) === "/Filespec"
      );
      check(
        "Filespec /AFRelationship /Alternative",
        String(filespec.get(PDFName.of("AFRelationship"))) === "/Alternative"
      );
      const f = filespec.get(PDFName.of("F"));
      check(
        "Filespec /F is the literal factur-x.xml",
        f instanceof PDFString && f.asString() === FACTUR_X_FILENAME
      );
      const uf = filespec.get(PDFName.of("UF"));
      check(
        "Filespec /UF decodes to factur-x.xml",
        uf instanceof PDFHexString && uf.decodeText() === FACTUR_X_FILENAME
      );
      const ef = filespec.get(PDFName.of("EF"));
      check("Filespec /EF present", ef instanceof PDFDict);
      if (ef instanceof PDFDict) {
        const fRef = ef.get(PDFName.of("F"));
        check("/EF /F is a ref", isRef(fRef));
        if (isRef(fRef)) {
          const emb = re.context.lookup(fRef);
          check("EmbeddedFile is a raw stream", emb instanceof PDFRawStream);
          if (emb instanceof PDFRawStream) {
            check(
              "EmbeddedFile /Type /EmbeddedFile",
              String(emb.dict.get(PDFName.of("Type"))) === "/EmbeddedFile"
            );
            check(
              "EmbeddedFile /Subtype is text/xml (PDF-escaped)",
              String(emb.dict.get(PDFName.of("Subtype"))) === "/text#2Fxml",
              String(emb.dict.get(PDFName.of("Subtype")))
            );
            const params = emb.dict.get(PDFName.of("Params"));
            const size =
              params instanceof PDFDict
                ? Number(String(params.get(PDFName.of("Size"))))
                : NaN;
            check(
              "EmbeddedFile /Params /Size == XML byte length",
              size === new TextEncoder().encode(SAMPLE_XML).length,
              size
            );
            // node:zlib inflate oracle — byte-identical XML round trip.
            const inflated = inflateSync(Buffer.from(emb.contents));
            check(
              "inflated attachment is byte-identical to the source XML",
              Buffer.compare(
                Buffer.from(inflated),
                Buffer.from(new TextEncoder().encode(SAMPLE_XML))
              ) === 0
            );
            check(
              "inflated XML passes its own shape sniff",
              validateCiiShape(new TextDecoder().decode(inflated)).ok
            );
          }
        }
      }
    }

    // /Metadata XMP stream.
    const metaRef = re.catalog.get(PDFName.of("Metadata"));
    check("catalog /Metadata present", isRef(metaRef));
    if (isRef(metaRef)) {
      const metaStream = re.context.lookup(metaRef);
      check("metadata is a raw stream (uncompressed)", metaStream instanceof PDFRawStream);
      if (metaStream instanceof PDFRawStream) {
        const xmp = new TextDecoder().decode(metaStream.contents);
        const parsedXmp = xmlWellFormed(xmp);
        check("output XMP is well-formed XML", parsedXmp.ok, parsedXmp);
        check("XMP declares the fx namespace", xmp.includes(`xmlns:fx="${FX_NAMESPACE}"`));
        check("XMP fx:DocumentType INVOICE", tagText(xmp, "fx:DocumentType") === "INVOICE");
        check("XMP fx:DocumentFileName", tagText(xmp, "fx:DocumentFileName") === FACTUR_X_FILENAME);
        check("XMP fx:Version 1.0", tagText(xmp, "fx:Version") === "1.0");
        check(
          "XMP fx:ConformanceLevel is the requested EN 16931",
          tagText(xmp, "fx:ConformanceLevel") === "EN 16931"
        );
        check("XMP pdf:Producer is MyCloudy", tagText(xmp, "pdf:Producer").includes("MyCloudy"));
        check("XMP has no pdfaid lies stamped", !xmp.includes("pdfaid"));
      }
    }

    // Page content survives: pdf-lib compresses content streams by default,
    // so the needles live INSIDE flate streams as hex tokens — inflate
    // every FlateDecode stream (the EmbeddedFile excluded) + the house
    // needle matcher (literal / exact hex token / bare hex sequence).
    let streamText = raw;
    for (const [, obj] of re.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.get(PDFName.of("Type")) === PDFName.of("EmbeddedFile")) continue;
      const filter = obj.dict.get(PDFName.of("Filter"));
      if (!(filter instanceof PDFName) || filter !== PDFName.of("FlateDecode")) continue;
      try {
        streamText += `\n${inflateSync(Buffer.from(obj.contents)).toString("latin1")}`;
      } catch {
        /* skip */
      }
    }
    check(
      "page text needles survive (page 1 + 2)",
      hasText(streamText, "CEI E2E needle - page 1") &&
        hasText(streamText, "CEI E2E needle - page 2")
    );

    // pdf.js — the reader-level attachment oracle.
    const task = getDocument({ data: outBytes.slice() });
    const pdf = await task.promise;
    try {
      const attachments = await pdf.getAttachments();
      const names = Object.keys(attachments);
      check("pdf.js getAttachments sees factur-x.xml", names.includes(FACTUR_X_FILENAME), names);
      const att = attachments[FACTUR_X_FILENAME] as { content?: Uint8Array } | undefined;
      check(
        "pdf.js attachment content matches the source XML bytes",
        att?.content !== undefined &&
          Buffer.compare(
            Buffer.from(att.content),
            Buffer.from(new TextEncoder().encode(SAMPLE_XML))
          ) === 0
      );
    } finally {
      await pdf.destroy();
      await task.destroy();
    }
  }

  console.log("\n── 7. level variants + robust input order ───────────────");
  {
    const srcPdf = await buildSourcePdf(1, "variant needle");
    for (const level of ["MINIMUM", "BASIC"] as const) {
      const result = asResult(
        await driveWorker(
          [
            { name: "v.pdf", blob: new Blob([srcPdf as BlobPart]) },
            { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
          ],
          { level },
          110 + level.length
        )
      );
      check(
        `level ${level}: detail reports it`,
        result.detail.conformanceLevel === level
      );
      const bytes = await blobBytes(result.outputs[0].blob);
      const re = await PDFDocument.load(bytes, { updateMetadata: false });
      const metaRef = re.catalog.get(PDFName.of("Metadata"));
      const stream = isRef(metaRef) ? re.context.lookup(metaRef) : null;
      const xmp =
        stream instanceof PDFRawStream
          ? new TextDecoder().decode(stream.contents)
          : "";
      check(
        `level ${level}: XMP ConformanceLevel matches`,
        tagText(xmp, "fx:ConformanceLevel") === level,
        tagText(xmp, "fx:ConformanceLevel")
      );
    }

    // XML FIRST, PDF SECOND — the worker classifies by content, not order.
    const flipped = asResult(
      await driveWorker(
        [
          { name: "factur-x.xml", blob: new Blob([SAMPLE_XML]) },
          { name: "invoice.pdf", blob: new Blob([srcPdf as BlobPart]) },
        ],
        {},
        120
      )
    );
    check(
      "XML-first order still works (content sniffing)",
      flipped.detail.attachmentName === FACTUR_X_FILENAME &&
        flipped.detail.pages === 1,
      flipped.detail
    );

    // A garbage level falls back to the honest default.
    const defaulted = asResult(
      await driveWorker(
        [
          { name: "v.pdf", blob: new Blob([srcPdf as BlobPart]) },
          { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
        ],
        { level: "SUPER-DUPER" },
        121
      )
    );
    check(
      "garbage level → EN 16931 default stamped",
      defaulted.detail.conformanceLevel === "EN 16931"
    );

    // BOM-prefixed XML file still accepted.
    const bommed = asResult(
      await driveWorker(
        [
          { name: "v.pdf", blob: new Blob([srcPdf as BlobPart]) },
          {
            name: "bom.xml",
            blob: new Blob([
              new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SAMPLE_XML)]),
            ]),
          },
        ],
        {},
        122
      )
    );
    check("BOM-prefixed XML accepted", bommed.detail.xmlShapeOk === true, bommed.detail);
  }

  console.log("\n── 8. honest source-PDF/A sniff (detail booleans) ───────");
  {
    const oiPdf = await buildOutputIntentPdf();
    const oiRun = asResult(
      await driveWorker(
        [
          { name: "oi.pdf", blob: new Blob([oiPdf as BlobPart]) },
          { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
        ],
        {},
        130
      )
    );
    check(
      "OutputIntents source → sourceOutputIntent true (honest report)",
      oiRun.detail.sourceOutputIntent === true,
      oiRun.detail
    );

    const pdfaidPdf = await buildPdfaidXmpPdf();
    const paidRun = asResult(
      await driveWorker(
        [
          { name: "paid.pdf", blob: new Blob([pdfaidPdf as BlobPart]) },
          { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
        ],
        {},
        131
      )
    );
    check(
      "pdfaid XMP source → sourceXmpPdfaid true",
      paidRun.detail.sourceXmpPdfaid === true,
      paidRun.detail
    );
    // The old pdfaid packet must be REPLACED by the Factur-X XMP (source
    // /Metadata is dropped object-level; no lying "this is PDF/A" markers
    // ride along into an output that is not PDF/A-3).
    const bytes = await blobBytes(paidRun.outputs[0].blob);
    const raw = Buffer.from(bytes).toString("latin1");
    check(
      "old pdfaid XMP replaced by the Factur-X packet",
      !raw.includes("pdfaid:part") && raw.includes("fx:DocumentType")
    );
  }

  console.log("\n── 9. rejection vectors ─────────────────────────────────");
  {
    const noFiles = asError(await driveWorker([], {}, 140));
    check("no files → tool.errorCorrupt (no PDF)", noFiles.code === "tool.errorCorrupt", noFiles);

    const garbage = new Uint8Array(2048);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = (i * 31 + 7) & 0xff;
    const noPdf = asError(
      await driveWorker(
        [
          { name: "junk.bin", blob: new Blob([garbage as BlobPart]) },
          { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
        ],
        {},
        141
      )
    );
    check("non-PDF first file → tool.errorCorrupt", noPdf.code === "tool.errorCorrupt", noPdf);

    const noXml = asError(
      await driveWorker(
        [
          {
            name: "ok.pdf",
            blob: new Blob([(await buildSourcePdf(1, "x")) as BlobPart]),
          },
          { name: "image.bin", blob: new Blob([garbage as BlobPart]) },
        ],
        {},
        142
      )
    );
    check("no XML → cei.errorNoXml", noXml.code === "cei.errorNoXml", noXml);

    const html = asError(
      await driveWorker(
        [
          {
            name: "ok.pdf",
            blob: new Blob([(await buildSourcePdf(1, "x")) as BlobPart]),
          },
          { name: "page.html", blob: new Blob(["<html><body>no</body></html>"]) },
        ],
        {},
        143
      )
    );
    check("non-CII XML root → cei.errorNotCii", html.code === "cei.errorNotCii", html);

    // Encrypted PDF (AES-256 via the @cantoo fork — lock-pdf engine family).
    const enc = await CantooPDF.create();
    enc.addPage([612, 792]);
    await enc.encrypt({
      userPassword: "secret-one",
      ownerPassword: "secret-two",
      algorithm: "AES-256",
    });
    const encBytes = new Uint8Array(await enc.save());
    const encRun = asError(
      await driveWorker(
        [
          { name: "locked.pdf", blob: new Blob([encBytes as BlobPart]) },
          { name: "x.xml", blob: new Blob([SAMPLE_XML]) },
        ],
        {},
        144
      )
    );
    check("encrypted PDF → tool.errorEncrypted", encRun.code === "tool.errorEncrypted", encRun);
  }

  console.log("\n── 10. source honesty (worker + config) ─────────────────");
  {
    const workerSrc = readFileSync("tools/create-electronic-invoice/worker.ts", "utf8");
    check(
      "worker saves with useObjectStreams: false (attachments + XMP loose)",
      /useObjectStreams:\s*false/.test(workerSrc)
    );
    check(
      "worker never positively claims producing PDF/A-3",
      !/to PDF\/A-3/i.test(workerSrc) && !/PDF\/A-3 compliant/i.test(workerSrc)
    );
    check(
      "worker patches /AFRelationship via the low-level API",
      /AFRelationship/.test(workerSrc) &&
        /PDFName\.of\("AFRelationship"\)/.test(workerSrc)
    );
    check(
      "worker passes afRelationship through attach (belt) AND patches (suspenders)",
      /afRelationship:\s*AFRelationship\.Alternative/.test(workerSrc)
    );
    check(
      "worker writes the XMP as a raw PDFRawStream",
      /PDFRawStream\.of/.test(workerSrc)
    );
    const configSrc = readFileSync("tools/create-electronic-invoice/config.ts", "utf8");
    check(
      "config FAQ says plainly: does NOT convert to PDF/A-3",
      /does NOT convert the PDF itself to PDF\/A-3|does NOT convert .* PDF\/A-3/i.test(configSrc)
    );
    check(
      "config FAQ points at PDF/A-3 sources for full compliance",
      /start from a PDF that is already PDF\/A-3/i.test(configSrc)
    );
    const i18nRaw = readFileSync("tools/create-electronic-invoice/i18n.json", "utf8");
    const i18n = JSON.parse(i18nRaw) as {
      en: { cei: Record<string, string> };
      hi: { cei: Record<string, string> };
    };
    const enKeys = Object.keys(i18n.en.cei).sort();
    const hiKeys = Object.keys(i18n.hi.cei).sort();
    check(
      "i18n en/hi leaf parity",
      JSON.stringify(enKeys) === JSON.stringify(hiKeys) && enKeys.length >= 40,
      { en: enKeys.length, hi: hiKeys.length }
    );
    // Every cei.* key the surface references must exist in BOTH catalogs —
    // catching BOTH t("cei.x") calls and bare string literals (the static
    // LEVEL_DESC_KEYS map). tool.* are shared keys that already live in the
    // main catalogs — every other tool uses them too.
    const surfaceSrc = readFileSync("tools/create-electronic-invoice/surface.tsx", "utf8");
    const used = [
      ...new Set(
        [...surfaceSrc.matchAll(/"((?:cei|tool)\.[a-zA-Z0-9]+)"/g)].map((m) => m[1])
      ),
    ];
    const leaf = (locale: "en" | "hi"): Record<string, string> =>
      i18n[locale].cei as Record<string, string>;
    const ceiUsed = used.filter((k) => k.startsWith("cei."));
    const missingEn = ceiUsed.filter((k) => !(k.slice(4) in leaf("en")));
    const missingHi = ceiUsed.filter((k) => !(k.slice(4) in leaf("hi")));
    check(
      "every cei.* key used by the surface resolves in both catalogs",
      ceiUsed.length >= 30 && missingEn.length === 0 && missingHi.length === 0,
      { missingEn, missingHi, ceiUsed: ceiUsed.length }
    );
    const workerCodes = ["cei.errorNoXml", "cei.errorNotCii"];
    check(
      "worker error codes exist in the leaf",
      workerCodes.every((k) => k.slice(4) in leaf("en") && k.slice(4) in leaf("hi"))
    );
  }

  console.log(
    `\n${pass} passed, ${fail} failed${fail > 0 ? ` — ${failures.join(" | ")}` : ""}`
  );
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().then(
  () => undefined,
  (error) => {
    console.error("SMOKE CRASHED", error);
    process.exit(1);
  }
);
