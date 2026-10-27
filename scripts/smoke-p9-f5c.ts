/**
 * P9 batch 5 (orchestrator part) smoke: xml-invoice-to-pdf + validate-e-invoice
 * worker logic. The validate worker's XML extraction (raw + Flate via
 * DecompressionStream) runs under Bun (Bun implements DecompressionStream).
 * Run: bun scripts/smoke-p9-f5c.ts
 */
import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";

import { calc } from "../tools/create-invoice/model";
import { buildCiiXml } from "../tools/einvoice-common/cii";
import { attachXmlToPdf } from "../tools/einvoice-common/embed";
import { parseInvoiceXml, validateEInvoiceXml } from "../tools/einvoice-common/parse";
import { sampleState } from "./sample-invoice";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("xml-invoice-to-pdf payload contract");

// The surface builds options.inv = JSON.stringify({ s }) — verify the
// create-invoice worker's parseInvoiceRun path accepts it with the
// parser-produced state.
const s = sampleState();
const xml = buildCiiXml(s, calc(s));
const parsed = parseInvoiceXml(xml);
const invOption = JSON.stringify({ s: parsed.state });
const { parseInvoiceRun } = await import("../tools/create-invoice/model");
const run = parseInvoiceRun(invOption);
check("surface payload → engine run", run.s.biz.name === s.biz.name && run.s.items.length === 3);
check("engine renders non-empty calc", calc(run.s).sub > 0);

// 60-item truncation contract (the surface slices before stringify).
const many = { ...parsed.state, items: [...parsed.state.items, ...Array.from({ length: 70 }, (_, i) => ({ d: `Bulk ${i}`, h: "", q: "1", r: "10", g: "18" }))] };
const truncated = { ...many, items: many.items.slice(0, 60) };
const runT = parseInvoiceRun(JSON.stringify({ s: truncated }));
check("truncation at 60 items", runT.s.items.length === 60);

console.log("validate-e-invoice extraction");

/* Build a PDF with (a) our uncompressed attachment and (b) a Flate one. */
const base = await PDFDocument.create();
base.addPage([595, 842]);
const baseBytes = await base.save();

const attached = await attachXmlToPdf(baseBytes, xml, "factur-x.xml");

// --- Mirror of the worker's extractor (same code path, verbatim logic) ---
function toLatin1(bytes: Uint8Array): string {
  const CHUNK = 65536;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!DS) return null;
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DS("deflate"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}
function toUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
function isEInvoiceXml(text: string): boolean {
  return /<\?xml|^<rsm:|^<([\w.-]+:)?CrossIndustryInvoice/.test(text.trimStart()) || /CrossIndustryInvoice|<([\w.-]+:)?Invoice[\s>]/.test(text);
}
async function extractEmbeddedXml(raw: string, bytes: Uint8Array): Promise<{ xml: string; name: string } | null> {
  let at = 0;
  for (;;) {
    const dictAt = raw.indexOf("/EmbeddedFile", at);
    if (dictAt === -1) break;
    const streamAt = raw.indexOf("stream", dictAt);
    const endAt = raw.indexOf("endstream", streamAt);
    if (streamAt === -1 || endAt === -1) break;
    let dataStart = streamAt + "stream".length;
    if (raw[dataStart] === "\r") dataStart += 1;
    if (raw[dataStart] === "\n") dataStart += 1;
    let dataEnd = endAt;
    if (raw[dataEnd - 1] === "\n") dataEnd -= 1;
    if (raw[dataEnd - 1] === "\r") dataEnd -= 1;
    if (dataEnd <= dataStart) { at = endAt + 10; continue; }
    const chunk = bytes.subarray(dataStart, dataEnd);
    const asText = toUtf8(chunk);
    if (isEInvoiceXml(asText)) {
      const literal = raw.match(/\/F\s*\(([^()]{1,120}\.xml)\)/i);
      return { xml: asText, name: literal?.[1] ?? "embedded.xml" };
    }
    const inflated = await inflate(chunk);
    if (inflated !== null) {
      const text = toUtf8(inflated);
      if (isEInvoiceXml(text)) return { xml: text, name: "embedded.xml" };
    }
    at = endAt + 10;
  }
  return null;
}

const raw = toLatin1(attached.bytes);
const found = await extractEmbeddedXml(raw, attached.bytes);
check("uncompressed attachment extracted", found !== null);
check("attachment name from filespec", found?.name === "factur-x.xml");
check("extracted xml valid", found !== null && validateEInvoiceXml(found.xml).failed === 0);
check("extracted xml round-trips", found !== null && parseInvoiceXml(found.xml).state.no === s.no);

/* Flate-compressed attachment: craft a PDF manually with a compressed stream. */
const zlibXml = deflateSync(Buffer.from(xml, "utf8"));
const flatPdf =
  `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n` +
  `<< /Type /Filespec /F (factur-x.xml) /EF << /F 3 0 R >> >>\nendobj\n` +
  `3 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${zlibXml.length} >>\nstream\n`;
const flatTail = `\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`;
const flatBytes = new Uint8Array(flatPdf.length + zlibXml.length + flatTail.length);
flatBytes.set(new TextEncoder().encode(flatPdf), 0);
flatBytes.set(zlibXml, flatPdf.length);
flatBytes.set(new TextEncoder().encode(flatTail), flatPdf.length + zlibXml.length);
const rawFlat = toLatin1(flatBytes);
const foundFlat = await extractEmbeddedXml(rawFlat, flatBytes);
check("flate attachment extracted", foundFlat !== null);
check("flate xml round-trips", foundFlat !== null && parseInvoiceXml(foundFlat.xml).state.no === s.no);

/* Plain PDF → honest null. */
const rawPlain = toLatin1(baseBytes);
check("plain pdf → no xml found", (await extractEmbeddedXml(rawPlain, baseBytes)) === null);

/* Non-PDF non-XML garbage → the worker's isEInvoiceXml rejects. */
check("garbage text rejected", isEInvoiceXml("hello world") === false);

/* Standalone XML validates. */
const v = validateEInvoiceXml(xml);
check("standalone xml: all core checks pass", v.failed === 0, JSON.stringify(v.checks.filter((c) => c.status !== "pass")));

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
