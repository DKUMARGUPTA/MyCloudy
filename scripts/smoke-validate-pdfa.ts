/**
 * Smoke: validate-pdfa (RB7-FIN-b2 — the 97th tool, view category) —
 * the honest on-device PDF/A conformance checker (veraPDF-inspired
 * subset).
 *
 * House conventions (smoke-verify-pdf-signatures / smoke-request-signature):
 * relative imports WITHOUT .ts, plain check() helper, every check counted,
 * process.exit(0) when 0 failed.
 *
 *  1. Units — toLatin, sniffPdfBytes (2 KB window), MAX_INPUT_BYTES,
 *     parsePdfValue (dicts/arrays/refs/numbers/strings/names/bool/null,
 *     escapes, depth cap), normalizeDeclaredLevel, resolveLevel (the
 *     auto-detect honesty core), parseXmp (attribute + element forms,
 *     dc:title/dc:creator/pdf:Producer/pdf:Keywords, junk, out-of-range
 *     parts), scanContentStream (Tf/k/K tokens, strings skipped, inline
 *     images skipped), outputBaseName, parseRun (label filter + the
 *     ≤ 64-char key cap).
 *  2. Error gates — > 64 MB → errTooBig, no %PDF- magic → errNotPdf,
 *     magic-but-no-catalog → errCorrupt.
 *  3. GOOD fixtures — the green archive (pdf-lib + Noto FontFile2 embed +
 *     low-level XMP stamp pdfaid:part 2/B + dc:title + mirrored /Info +
 *     OutputIntent with an ICC stream): every per-check verdict pinned;
 *     auto-detect; the fully-tagged variant (MarkInfo/Lang/StructTree /Alt
 *     → all three advisory UA rows green); the object-stream save (the
 *     regression for the ObjStm pair-whitespace fix); the appended
 *     duplicate catalog (linear-scan LAST-wins, healthy xref).
 *  4. Fonts vectors — unembedded Helvetica: pass at -1b (standard-14
 *     exemption), fail at -2b (+ the honest pdfaid:part mismatch), auto;
 *     13 pages (the pagesLabel cap); fonts used INSIDE a Form XObject.
 *  5. Colour — k/K operators; /DeviceCMYK + DefaultCMYK resources; image
 *     /SMask fails -1b and passes -2b; ExtGState ca + soft-mask; form
 *     transparency group; /FunctionType 4 (Shading + Pattern) with the
 *     FunctionType-2 negative; the cyclic Function depth guard.
 *  6. Forbidden — /Encrypt stub; /Names/JavaScript; a /JS annotation
 *     action; a /Launch action chained via /Next; /OpenAction dict
 *     (fail) vs destination name (pass); /AF filespec (fail -1b/-2b,
 *     allowed -3b, auto-detected 3b); a RichMedia annotation; the cyclic
 *     /Next action depth guard.
 *  7. XMP honesty — no /Metadata; junk metadata text; /Metadata as a
 *     direct dict; /Metadata ref to a non-stream; part mismatch;
 *     conformance "A" (level-a structure rules fail then pass); part 9
 *     (auto assumes, declared mismatches).
 *  8. Recovery — a corrupted startxref offset: honest recoveryUsed +
 *     reason, every check still runs, the report's recovery lines.
 *  9. buildReportText — English fallback (header, level lines for
 *     declared/auto-detected/assumed/mismatch, summary, groups, FONTS
 *     USED + UNEMBEDDED FONTS, honesty footer, determinism) + the Hindi
 *     labels from the tool catalog.
 * 10. The REAL worker (self-shimmed globalThis): green run (output name/
 *     mime, detail counts, progress 15/40/80/92, report text), the level
 *     round-trip via options.run, Hindi labels, non-PDF, too-big,
 *     corrupt, no-file, garbage options.run, non-run messages ignored.
 * 11. i18n parity + key resolution (NOTE the prefix length: "vpa." is 4
 *     characters — slice(4)) + REPORT_KEYS extraction + model label-key
 *     coverage + wiring (configs/surfaces/registry + the PDF/UA name
 *     honesty).
 *
 * Run: bun scripts/smoke-validate-pdfa.ts
 */
import { readFileSync } from "node:fs";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFObject, PDFPage, PDFString } from "pdf-lib";

import {
  MAX_INPUT_BYTES,
  PdfaError,
  REPORT_LABELS_EN,
  analyzePdfa,
  buildReportText,
  normalizeDeclaredLevel,
  outputBaseName,
  parsePdfValue,
  parseRun,
  parseXmp,
  resolveLevel,
  scanContentStream,
  sniffPdfBytes,
  toLatin,
} from "../tools/validate-pdfa/model";
import type { PdfaReport } from "../tools/validate-pdfa/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import toolI18n from "../tools/validate-pdfa/i18n.json";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function latin1BytesOf(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function statusOf(r: PdfaReport, id: string): string {
  return r.checks.find((c) => c.id === id)?.status ?? `?${id}`;
}
function detailOf(r: PdfaReport, id: string): string {
  return r.checks.find((c) => c.id === id)?.detail ?? "";
}
function pagesOf(r: PdfaReport, id: string): number[] {
  return r.checks.find((c) => c.id === id)?.pages ?? [];
}

/** Minimal XMP packet with the fields the checker scrapes. */
function xmpPacket(
  part: number | null,
  conf: string | null,
  opts: { title?: string; creator?: string; producer?: string; keywords?: string } = {}
): string {
  const desc: string[] = [];
  if (part !== null && conf !== null) {
    desc.push(
      `  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="${part}" pdfaid:conformance="${conf}"/>`
    );
  }
  const dcBits: string[] = [];
  if (opts.title !== undefined) {
    dcBits.push(
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${opts.title}</rdf:li></rdf:Alt></dc:title>`
    );
  }
  if (opts.creator !== undefined) {
    dcBits.push(`<dc:creator><rdf:Seq><rdf:li>${opts.creator}</rdf:li></rdf:Seq></dc:creator>`);
  }
  if (dcBits.length > 0) {
    desc.push(
      `  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n   ${dcBits.join("\n   ")}\n  </rdf:Description>`
    );
  }
  const pdfBits: string[] = [];
  if (opts.producer !== undefined) pdfBits.push(`<pdf:Producer>${opts.producer}</pdf:Producer>`);
  if (opts.keywords !== undefined) pdfBits.push(`<pdf:Keywords>${opts.keywords}</pdf:Keywords>`);
  if (pdfBits.length > 0) {
    desc.push(
      `  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n   ${pdfBits.join("\n   ")}\n  </rdf:Description>`
    );
  }
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${desc.join("\n")}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const NOTO = new Uint8Array(readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf"));

/** Low-level catalog /Metadata stamp (raw or Flate-compressed stream). */
function stampXmp(doc: PDFDocument, text: string, flate = false): void {
  const stream = flate
    ? doc.context.flateStream(text, { Type: "Metadata", Subtype: "XML" })
    : doc.context.stream(text, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
}

/** OutputIntent with a tiny (fake) ICC profile stream — presence is what is checked. */
function addOutputIntent(doc: PDFDocument): void {
  const icc = doc.context.stream(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]), { N: 4 });
  const oi = doc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: "sRGB IEC61966-2.1",
    DestOutputProfile: doc.context.register(icc),
  });
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([oi]));
}

/** Replaces a page's content + resources with raw streams/dicts. */
function setRawPage(
  doc: PDFDocument,
  content: string,
  resources: Record<string, unknown>
): PDFPage {
  const page = doc.addPage([595.28, 841.89]);
  const stream = doc.context.stream(content, {});
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  page.node.set(
    PDFName.of("Resources"),
    doc.context.obj(resources as never) as PDFObject
  );
  return page;
}

function show(
  label: string,
  bytes: Uint8Array,
  declared: Parameters<typeof analyzePdfa>[1]
): PdfaReport {
  const r = analyzePdfa(bytes, declared);
  console.log(
    `  [${label}] verdict=${r.verdict} eff=${r.effectiveLevel} checks=${r.checks.length}`
  );
  return r;
}

/* ================================================================== */
console.log("── 1. units: bytes, levels, XMP, content scanner ─────────");
/* ================================================================== */
{
  const latin = toLatin(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x41]));
  check(
    "toLatin: byte-faithful (one char per byte, 0x00–0xFF)",
    latin.length === 7 && latin.charCodeAt(0) === 0x25 && latin.charCodeAt(4) === 0xff && latin.charCodeAt(5) === 0 && latin.charCodeAt(6) === 0x41
  );
  const all = toLatin(new Uint8Array(256).map((_, i) => i));
  check(
    "toLatin: full 0–255 range round-trips",
    all.length === 256 && all.charCodeAt(255) === 255
  );

  check("sniffPdfBytes: magic at 0", sniffPdfBytes(latin1BytesOf("%PDF-1.7\nrest")));
  check(
    "sniffPdfBytes: garbage prefix still smells (offset 500 < 2 KB)",
    sniffPdfBytes(new Uint8Array(600).map((_, i) => (i === 500 ? 0x25 : i === 501 ? 0x50 : i === 502 ? 0x44 : i === 503 ? 0x46 : i === 504 ? 0x2d : 0x41)))
  );
  check(
    "sniffPdfBytes: magic beyond the 2 KB window is rejected (documented)",
    !sniffPdfBytes(new Uint8Array(3000).map((_, i) => (i === 2500 ? 0x25 : i === 2501 ? 0x50 : i === 2502 ? 0x44 : i === 2503 ? 0x46 : i === 2504 ? 0x2d : 0x41)))
  );
  check("sniffPdfBytes: plain text rejected", !sniffPdfBytes(latin1BytesOf("hello world")));
  check("sniffPdfBytes: empty rejected", !sniffPdfBytes(new Uint8Array(0)));
  check("MAX_INPUT_BYTES is the 64 MB gate", MAX_INPUT_BYTES === 64 * 1024 * 1024);
}

{
  const p = (s: string, at: number) => parsePdfValue(s, at);
  const d = p("<< /A 1 /B (x) /C /Name /D [1 2] >>", 0);
  check(
    "parsePdfValue: dict with mixed values",
    d !== null && d.v.k === "dict" && d.v.map.get("A")?.k === "num" && d.v.map.get("B")?.k === "str" && d.v.map.get("C")?.k === "name" && d.v.map.get("D")?.k === "arr" && d.v.map.get("D") !== undefined && d.v.map.get("D")!.k === "arr"
  );
  const r = p("5 0 R", 0);
  check("parsePdfValue: indirect reference", r !== null && r.v.k === "ref" && r.v.num === 5 && r.v.gen === 0);
  const n = p("5 0", 0);
  check("parsePdfValue: two numbers are NOT a ref", n !== null && n.v.k === "num" && n.v.num === 5);
  const neg = p("-3.5 +2 .5", 0);
  check("parsePdfValue: signed / bare-dot numbers", neg !== null && neg.v.k === "num" && neg.v.num === -3.5);
  const esc = p("(a\\nb\\101\\(x\\)b)", 0);
  check(
    "parsePdfValue: literal escapes (\\n, octal, parens)",
    esc !== null && esc.v.k === "str" && !esc.v.hex && esc.v.text === "a\nbA(x)b"
  );
  const hex = p("<41 42>", 0);
  check(
    "parsePdfValue: hex string keeps raw digits",
    hex !== null && hex.v.k === "str" && hex.v.hex && hex.v.text === "41 42"
  );
  const name = p("/A#42B", 0);
  check("parsePdfValue: name #xx escape decodes", name !== null && name.v.k === "name" && name.v.name === "ABB");
  const t = p("true false null", 0);
  check("parsePdfValue: true/false/null", t !== null && t.v.k === "bool" && t.v.v === true);
  check("parsePdfValue: junk returns null", p("<< /A", 0) === null);
  check(
    "parsePdfValue: unterminated string returns null",
    p("(abc", 0) === null
  );
  let deep = "";
  for (let i = 0; i < 70; i += 1) deep += "[";
  check("parsePdfValue: depth cap (> 64 → null)", p(deep, 0) === null);
  const ws = p("  \n<< /K /V >>", 0);
  check("parsePdfValue: leading whitespace + comments skipped", ws !== null && ws.v.k === "dict" && ws.v.map.get("K")?.k === "name");
}

{
  check("normalizeDeclaredLevel: exact", normalizeDeclaredLevel("1b") === "1b");
  check("normalizeDeclaredLevel: case + trim", normalizeDeclaredLevel(" 2B ") === "2b");
  check("normalizeDeclaredLevel: junk → auto", normalizeDeclaredLevel("9b") === "auto" && normalizeDeclaredLevel("") === "auto");

  const part2 = resolveLevel("auto", parseXmp(xmpPacket(2, "B", { title: "T" })));
  check(
    "resolveLevel: auto + part 2 → 2b, autoDetected, claim 2B",
    part2.effectiveLevel === "2b" && part2.detectedLevel === "2b" && part2.xmpClaim === "2B" && part2.autoDetected && !part2.conformanceA
  );
  const none = resolveLevel("auto", parseXmp("no part here"));
  check(
    "resolveLevel: auto + no identification → assumed 2b",
    none.effectiveLevel === "2b" && none.detectedLevel === null && none.xmpClaim === null && !none.autoDetected
  );
  const explicit = resolveLevel("3b", parseXmp(xmpPacket(1, "B")));
  check(
    "resolveLevel: explicit declaration wins, XMP kept for the mismatch line",
    explicit.effectiveLevel === "3b" && explicit.detectedLevel === "1b" && explicit.xmpClaim === "1B" && !explicit.autoDetected
  );
  const confA = resolveLevel("auto", parseXmp(xmpPacket(2, "A")));
  check("resolveLevel: XMP conformance A activates level-a rules", confA.conformanceA && confA.effectiveLevel === "2b");
}

{
  const attr = parseXmp(xmpPacket(2, "b", { title: "Attr Title", creator: "ACME", producer: "Prod 1.4", keywords: "a, b" }));
  check(
    "parseXmp: attribute form + dc/pdf fields",
    attr.part === 2 && attr.conformance === "B" && attr.dcTitle === "Attr Title" && attr.dcCreator === "ACME" && attr.producer === "Prod 1.4" && attr.keywords === "a, b"
  );
  const el = parseXmp(
    `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>A</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta>`
  );
  check("parseXmp: element form part + conformance", el.part === 1 && el.conformance === "A");
  const junk = parseXmp("this is not xmp");
  check(
    "parseXmp: junk → parseError, part null",
    junk.part === null && junk.conformance === null && junk.parseError === "no XMP/RDF structure recognized"
  );
  const zero = parseXmp(xmpPacket(0, "B"));
  const nine = parseXmp(xmpPacket(9, "B"));
  check("parseXmp: part 0 rejected, part 9 kept (resolveLevel decides)", zero.part === null && nine.part === 9);
  const entities = parseXmp(xmpPacket(2, "B", { title: "A &amp; B &lt;x&gt;" }));
  check("parseXmp: XML entities decoded in dc:title", entities.dcTitle === "A & B <x>");
}

{
  const budget = { left: 1_000_000 };
  const s1 = scanContentStream("BT /F1 12 Tf 72 720 Td (hi) Tj ET", budget);
  check("scanContentStream: /Name size Tf collected", s1.tfNames.has("F1"));
  const s2 = scanContentStream("0 0 0 1 k 100 100 50 50 re f", budget);
  check("scanContentStream: k operator → cmyk", s2.cmykOps);
  const s3 = scanContentStream("0 0 0 1 K 1 w 0 0 m", budget);
  check("scanContentStream: K (stroke) operator → cmyk", s3.cmykOps);
  const s4 = scanContentStream("(0 0 0 1 k) Tj (x) ' ", budget);
  check("scanContentStream: k inside a literal string is NOT an operator", !s4.cmykOps);
  const s5 = scanContentStream("<30203020302031> Tj", budget);
  check("scanContentStream: hex strings skipped, no phantom cmyk", !s5.cmykOps);
  const s6 = scanContentStream("BI\n/W 1\nID\nzz k zz\nEI\nq Q\n", budget);
  check("scanContentStream: inline image body skipped (k inside BI…EI ignored)", !s6.cmykOps);
  const s7 = scanContentStream("BI\n/W 1\nID\nzz\nEI\n0 0 0 1 k\n", budget);
  check("scanContentStream: k AFTER the inline image counts", s7.cmykOps);
  const s8 = scanContentStream("0 0 0 1 kx /F2 1 Tk", budget);
  check("scanContentStream: kx is not k (delimiter-bounded words)", !s8.cmykOps);
  const s9 = scanContentStream("/F1 12 Tf /F1 Tf", budget);
  check("scanContentStream: Tf needs a numeric size between", s9.tfNames.has("F1") && !s9.tfNames.has("F2"));
}

{
  check(
    "outputBaseName: .pdf stripped, spaces kept",
    outputBaseName("a b.pdf", "en") === "a b" && outputBaseName("Archive.PDF", "en") === "Archive"
  );
  check("outputBaseName: path chars sanitized", outputBaseName("x/y\\z:*.pdf", "en") === "x_y_z__");
  check("outputBaseName: empty → localized word", outputBaseName(".pdf", "hi") === "दस्तावेज़" && outputBaseName("", "en") === "document");
  check(
    "outputBaseName: 120-char cap",
    outputBaseName(`${"y".repeat(200)}.pdf`, "en").length === 120
  );

  const g1 = parseRun("{not even json");
  check(
    "parseRun: garbage JSON degrades to defaults",
    g1.level === "auto" && g1.locale === "en" && g1.fileWord === "" && Object.keys(g1.labels).length === 0
  );
  const g2 = parseRun('{"level":"1B","locale":"hi","fileWord":"दस्तावेज़"}');
  check("parseRun: level normalized + locale + fileWord", g2.level === "1b" && g2.locale === "hi" && g2.fileWord === "दस्तावेज़");
  const g3 = parseRun(
    '{"labels":{"vpa.title":"X","other.x":"no","vpa.bad-key":"no","vpa.ok2":"fine"}}'
  );
  check(
    "parseRun: label keys filtered (vpa.* alnum only)",
    g3.labels["vpa.title"] === "X" && g3.labels["vpa.ok2"] === "fine" && g3.labels["other.x"] === undefined && g3.labels["vpa.bad-key"] === undefined
  );
  const g4 = parseRun(`{"labels":{"vpa.${"x".repeat(200)}":"junk","vpa.title":"keep"}}`);
  check(
    "parseRun: 300-char junk label key rejected (≤ 64-char keys, the RB6-FIN-b2 cap)",
    Object.keys(g4.labels).length === 1 && g4.labels["vpa.title"] === "keep"
  );
  const g5 = parseRun(`{"labels":{"vpa.title":"${"z".repeat(300)}"}}`);
  check("parseRun: label values sliced to 240", g5.labels["vpa.title"]?.length === 240);
  const g6 = parseRun('"just a string"');
  check("parseRun: non-object run → defaults", g6.level === "auto" && g6.locale === "en");
}

/* ================================================================== */
console.log("── 2. error gates (the three fatal PdfaError codes) ───────");
/* ================================================================== */
{
  const huge = new Uint8Array(MAX_INPUT_BYTES + 1);
  huge.set(latin1BytesOf("%PDF-1.7\n"), 0);
  try {
    analyzePdfa(huge, "1b");
    check("gate: > 64 MB throws errTooBig", false);
  } catch (e) {
    check(
      "gate: > 64 MB throws errTooBig",
      e instanceof PdfaError && e.code === "errTooBig"
    );
  }
  try {
    analyzePdfa(latin1BytesOf("plain text, no pdf magic"), "1b");
    check("gate: no %PDF- throws errNotPdf", false);
  } catch (e) {
    check("gate: no %PDF- throws errNotPdf", e instanceof PdfaError && e.code === "errNotPdf");
  }
  const empty = new Uint8Array(0);
  try {
    analyzePdfa(empty, "1b");
    check("gate: empty input throws errNotPdf", false);
  } catch (e) {
    check("gate: empty input throws errNotPdf", e instanceof PdfaError && e.code === "errNotPdf");
  }
  const corrupt = new Uint8Array(120);
  corrupt.set(latin1BytesOf("%PDF-1.4\njunk bytes, no objects, no xref\n%%EOF\n"), 0);
  try {
    analyzePdfa(corrupt, "1b");
    check("gate: magic but nothing walkable throws errCorrupt", false);
  } catch (e) {
    check(
      "gate: magic but nothing walkable throws errCorrupt",
      e instanceof PdfaError && e.code === "errCorrupt" && (e as PdfaError).message.includes("no catalog")
    );
  }
}

/* ================================================================== */
console.log("── 3. GOOD fixtures (green archive + variants) ────────────");
/* ================================================================== */

interface GreenOpts {
  tagged?: boolean;
  objstm?: boolean;
  flateXmp?: boolean;
}
async function buildGreen(opts: GreenOpts = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Green Archive");
  doc.setAuthor("Probe Author");
  doc.setProducer("DocoPDF Test");
  doc.setCreator("DocoPDF Test");
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(NOTO, { subset: true });
  page.drawText("Green PDF/A smoke", { x: 50, y: 700, size: 14, font });
  stampXmp(
    doc,
    xmpPacket(2, "B", {
      title: "Green Archive",
      creator: "Probe Author",
      producer: "DocoPDF Test",
    }),
    opts.flateXmp === true
  );
  addOutputIntent(doc);
  if (opts.tagged === true) {
    doc.catalog.set(PDFName.of("MarkInfo"), doc.context.obj({ Marked: true }));
    doc.catalog.set(PDFName.of("Lang"), PDFString.of("en"));
    const tree = doc.context.obj({
      Type: "StructTreeRoot",
      K: [doc.context.obj({ Alt: "Green archive alt text" })],
    });
    doc.catalog.set(PDFName.of("StructTreeRoot"), doc.context.register(tree));
  }
  return new Uint8Array(
    await doc.save({ useObjectStreams: opts.objstm === true })
  );
}

const CHECK_IDS = [
  "xmp", "title", "fonts", "cmyk", "transparency", "psfunc", "encrypt",
  "js", "launch", "openaction", "embfiles", "multimedia", "oi",
  "structinfo", "mirror", "uamarked", "ualang", "uaalt",
];

const greenBytes = await buildGreen();
{
  const r = show("green@2b", greenBytes, "2b");
  check(
    "green: check ids in the model's emission order",
    JSON.stringify(r.checks.map((c) => c.id)) === JSON.stringify(CHECK_IDS)
  );
  check(
    "green: hard checks all pass, structinfo skipped, verdict COMPLIANT",
    ["xmp", "title", "fonts", "cmyk", "transparency", "psfunc", "encrypt", "js", "launch", "openaction", "embfiles", "multimedia", "oi", "mirror"].every((id) => statusOf(r, id) === "pass") &&
      statusOf(r, "structinfo") === "skip" && r.verdict === "pass"
  );
  check(
    "green: advisory UA rows fail/warn but never touch the verdict",
    statusOf(r, "uamarked") === "fail" && statusOf(r, "ualang") === "warn" && statusOf(r, "uaalt") === "fail" && r.verdict === "pass" &&
      r.checks.filter((c) => c.advisory === true).length === 3
  );
  check(
    "green: XMP identification",
    r.effectiveLevel === "2b" && r.detectedLevel === "2b" && r.xmpClaim === "2B" && !r.autoDetected && !r.conformanceA
  );
  check(
    "green: XMP scrape (part/conformance/dc:title/dc:creator/producer)",
    r.xmp.present && r.xmp.part === 2 && r.xmp.conformance === "B" && r.xmp.dcTitle === "Green Archive" && r.xmp.dcCreator === "Probe Author" && r.xmp.producer === "DocoPDF Test" && r.xmp.parseError === null
  );
  check("green: page count + healthy xref", r.pageCount === 1 && !r.recoveryUsed && r.recoveryReason === null);
  check("green: xmp check detail is the claim", detailOf(r, "xmp") === "2B");
  check("green: title detail", detailOf(r, "title") === "Green Archive");
  check(
    "green: one embedded Type0 FontFile2 font used on page 1",
    r.fonts.length === 1 &&
      r.fonts[0]!.name.startsWith("NotoSansDevanagari") &&
      r.fonts[0]!.subtype === "Type0" &&
      r.fonts[0]!.embedded &&
      !r.fonts[0]!.standard14 &&
      JSON.stringify(r.fonts[0]!.pages) === "[1]" &&
      detailOf(r, "fonts") === "1"
  );
  check("green: OutputIntent detail (ICC condition identifier)", detailOf(r, "oi") === "sRGB IEC61966-2.1");
  check("green: mirror passes (Title/Author/Producer mirrored in XMP)", detailOf(r, "mirror") === "" && statusOf(r, "mirror") === "pass");

  const auto = show("green@auto", greenBytes, "auto");
  check(
    "green auto: level auto-detected from XMP pdfaid:part",
    auto.effectiveLevel === "2b" && auto.detectedLevel === "2b" && auto.autoDetected && auto.declaredLevel === "auto" && auto.verdict === "pass"
  );
}

{
  const r = show("greenFull@2b", await buildGreen({ tagged: true }), "2b");
  check(
    "greenFull: fully tagged — all three advisory UA rows green",
    statusOf(r, "uamarked") === "pass" && statusOf(r, "ualang") === "pass" && statusOf(r, "uaalt") === "pass" &&
      detailOf(r, "ualang") === "en" && detailOf(r, "uaalt") === "1"
  );
  check(
    "greenFull: verdict pass with 0 warnings 0 failures (17 pass + 1 skip)",
    r.verdict === "pass" &&
      r.checks.filter((c) => c.status === "pass").length === 17 &&
      r.checks.filter((c) => c.status === "warn").length === 0 &&
      r.checks.filter((c) => c.status === "fail").length === 0 &&
      r.checks.filter((c) => c.status === "skip").length === 1
  );
}

{
  /* The object-stream regression: pdf-lib's default save packs the font
   * dicts + Info inside an /ObjStm — the model must expand them. */
  const r = show("objstm-green@2b", await buildGreen({ objstm: true }), "2b");
  check(
    "objstm: xref stream chain healthy (no dishonest recovery)",
    !r.recoveryUsed && r.recoveryReason === null
  );
  check(
    "objstm: catalog + fonts + /Info all resolved through the expansion",
    statusOf(r, "xmp") === "pass" && statusOf(r, "fonts") === "pass" && r.fonts.length === 1 && r.fonts[0]!.embedded && statusOf(r, "mirror") === "pass" && r.verdict === "pass"
  );
}

{
  /* Flate-compressed XMP metadata stream through the same doc. */
  const r = show("flate-xmp@auto", await buildGreen({ flateXmp: true }), "auto");
  check(
    "flate XMP: metadata stream inflated and parsed",
    statusOf(r, "xmp") === "pass" && r.xmp.part === 2 && r.detectedLevel === "2b" && statusOf(r, "title") === "pass" && detailOf(r, "title") === "Green Archive"
  );
}

{
  /* Appended duplicate catalog: the linear scan's LAST-wins semantics. */
  const s = toLatin(greenBytes);
  const catAt = s.indexOf("/Type /Catalog");
  const headEnd = s.lastIndexOf(" obj", catAt);
  const m = /(\d+) 0 obj\s*$/.exec(s.slice(0, headEnd + 4));
  const endAt = s.indexOf("endobj", catAt);
  const dictText = s.slice(headEnd + 4, endAt).trim();
  const appended =
    "\n" + `${m![1]} 0 obj\n` + dictText.replace("<<", "<< /Lang (en) ") + "\nendobj\n";
  const bytes = new Uint8Array(greenBytes.length + appended.length);
  bytes.set(greenBytes, 0);
  for (let i = 0; i < appended.length; i += 1) {
    bytes[greenBytes.length + i] = appended.charCodeAt(i) & 0xff;
  }
  const r = show("appended-catalog@2b", bytes, "2b");
  check(
    "lastWins: the appended catalog revision wins, healthy xref kept",
    statusOf(r, "ualang") === "pass" && detailOf(r, "ualang") === "en" && !r.recoveryUsed
  );
  check("lastWins: everything else stays green", r.verdict === "pass" && statusOf(r, "xmp") === "pass");
}

/* ================================================================== */
console.log("── 4. fonts vectors (std-14 exemption, forms, caps) ────────");
/* ================================================================== */

async function buildHelv(pagesN: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer("DocoPDF Test");
  stampXmp(doc, xmpPacket(1, "B", { title: "Helv", producer: "DocoPDF Test" }));
  for (let i = 0; i < pagesN; i += 1) {
    setRawPage(
      doc,
      `BT /F1 12 Tf 72 720 Td (page ${i + 1}) Tj ET`,
      { Font: { F1: doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }) } }
    );
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

{
  const helv = await buildHelv(1);
  const r1 = show("helv@1b", helv, "1b");
  check(
    "helv@1b: unembedded Helvetica passes via the standard-14 exemption",
    statusOf(r1, "fonts") === "pass" &&
      r1.fonts.length === 1 && r1.fonts[0]!.name === "Helvetica" && r1.fonts[0]!.subtype === "Type1" && !r1.fonts[0]!.embedded && r1.fonts[0]!.standard14
  );
  const r2 = show("helv@2b", helv, "2b");
  check(
    "helv@2b: same font FAILS (embedding required at -2b)",
    statusOf(r2, "fonts") === "fail" && JSON.stringify(pagesOf(r2, "fonts")) === "[1]" && detailOf(r2, "fonts") === "Helvetica (Type1) — 1"
  );
  check(
    "helv@2b: honest pdfaid:part mismatch reported (file claims 1B, target 2b)",
    statusOf(r2, "xmp") === "fail" && detailOf(r2, "xmp") === "pdfaid:part=1 (conformance B) — target 2b" && r2.detectedLevel === "1b" && r2.xmpClaim === "1B"
  );
  const r3 = show("helv@auto", helv, "auto");
  check(
    "helv@auto: auto-detects 1b from the XMP and applies the exemption",
    r3.effectiveLevel === "1b" && r3.autoDetected && statusOf(r3, "fonts") === "pass"
  );

  const r13 = show("helv13@1b", await buildHelv(13), "1b");
  check(
    "helv13: pagesLabel caps at 12 (+N) while check.pages keeps all 13",
    statusOf(r13, "fonts") === "pass" && pagesOf(r13, "fonts").length === 13 && detailOf(r13, "fonts").includes("+1") && r13.pageCount === 13
  );
}

{
  /* Form XObject: its own font resource + its own transparency group. */
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const formFont = doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" });
  const formRes = doc.context.obj({ Font: { F9: formFont } });
  const form = doc.context.stream("BT /F9 10 Tf 10 10 Td (form text) Tj ET", {
    Type: "XObject",
    Subtype: "Form",
    Resources: formRes,
    Group: { Type: "Group", S: "Transparency", CS: "DeviceRGB" },
  });
  const gs0 = doc.context.obj({ Type: "ExtGState", ca: 0.5, CA: 1 });
  const gs1 = doc.context.obj({ Type: "ExtGState", SMask: { Type: "Mask", G: 0, BC: [0] } });
  const page = doc.addPage([595.28, 841.89]);
  const content = doc.context.stream("q /GS0 gs /GS1 gs /Fm0 Do Q", {});
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
  page.node.set(
    PDFName.of("Resources"),
    doc.context.obj({
      ExtGState: { GS0: gs0, GS1: gs1 },
      XObject: { Fm0: doc.context.register(form) },
    })
  );
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r1 = show("form@1b", bytes, "1b");
  check(
    "form@1b: transparency (ExtGState ca/SMask + form group) fails -1b",
    statusOf(r1, "transparency") === "fail" && JSON.stringify(pagesOf(r1, "transparency")) === "[1]"
  );
  check(
    "form@1b: the form's own Courier font is collected (used INSIDE the form)",
    statusOf(r1, "fonts") === "pass" && r1.fonts.length === 1 && r1.fonts[0]!.name === "Courier" && r1.fonts[0]!.standard14
  );
  const r2 = show("form@2b", bytes, "2b");
  check(
    "form@2b: transparency allowed, unembedded Courier fails",
    statusOf(r2, "transparency") === "pass" && detailOf(r2, "transparency") === "1 page(s) — allowed at 2b" && statusOf(r2, "fonts") === "fail" && detailOf(r2, "fonts") === "Courier (Type1) — 1"
  );
}

/* ================================================================== */
console.log("── 5. colour vectors (CMYK, SMask, PS functions) ──────────");
/* ================================================================== */

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  setRawPage(doc, "0 0 0 1 k 100 100 200 200 re f 0 0 0 1 K 2 w 10 10 m 20 20 l S", {});
  const r = show("cmykOps@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "cmykOps: k/K operators fail with the pages",
    statusOf(r, "cmyk") === "fail" && JSON.stringify(pagesOf(r, "cmyk")) === "[1]" && detailOf(r, "cmyk") === "k/K operators — 1"
  );
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const img = doc.context.stream(new Uint8Array([0, 0, 0, 0]), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
    ColorSpace: "DeviceCMYK", BitsPerComponent: 8,
  });
  setRawPage(
    doc,
    "100 100 50 50 re f",
    {
      ColorSpace: { CS0: "DeviceCMYK", DefaultCMYK: "DeviceCMYK" },
      XObject: { Im0: doc.context.register(img) },
    }
  );
  const r = show("cmykRes@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "cmykRes: /DeviceCMYK + DefaultCMYK + CMYK image in resources (no operators)",
    statusOf(r, "cmyk") === "fail" && detailOf(r, "cmyk") === "/DeviceCMYK in resources — 1"
  );
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const smask = doc.context.stream(new Uint8Array([128]), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
    ColorSpace: "DeviceGray", BitsPerComponent: 8,
  });
  const img = doc.context.stream(new Uint8Array([255, 0, 0]), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
    ColorSpace: "DeviceRGB", BitsPerComponent: 8,
    SMask: doc.context.register(smask),
  });
  setRawPage(doc, "q 100 0 0 100 50 50 cm /Im0 Do Q", {
    XObject: { Im0: doc.context.register(img) },
  });
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r1 = show("smask@1b", bytes, "1b");
  check(
    "smask@1b: image /SMask fails PDF/A-1b",
    statusOf(r1, "transparency") === "fail" && detailOf(r1, "transparency").includes("/SMask")
  );
  const r2 = show("smask@2b", bytes, "2b");
  check(
    "smask@2b: transparency allowed with the honest note",
    statusOf(r2, "transparency") === "pass" && detailOf(r2, "transparency") === "1 page(s) — allowed at 2b"
  );
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const fn4 = doc.context.stream("{ pop }", {
    FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1],
  });
  const fn2 = doc.context.obj({ FunctionType: 2, C0: [0], C1: [1], N: 1 });
  const cyclic = doc.context.obj({ FunctionType: 2, C0: [0], C1: [1], N: 1 });
  const cyclicRef = doc.context.register(cyclic);
  cyclic.set(PDFName.of("Loop"), cyclicRef);
  const sh0 = doc.context.obj({
    ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 1, 1],
    Function: doc.context.register(fn4),
  });
  const pat0 = doc.context.obj({
    Type: "Pattern", PatternType: 2,
    Shading: { ShadingType: 3, ColorSpace: "DeviceRGB", Function: fn2 },
    MyFn: doc.context.register(fn4),
  });
  const sh1 = doc.context.obj({
    ShadingType: 3, ColorSpace: "DeviceRGB", Function: cyclicRef,
  });
  setRawPage(doc, "0 0 sh", {
    Shading: { Sh0: doc.context.register(sh0), Sh1: doc.context.register(sh1) },
    Pattern: { P0: doc.context.register(pat0) },
  });
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r = show("psfunc@2b", bytes, "2b");
  check(
    "psfunc: /FunctionType 4 in Shading + Pattern fails with pages",
    statusOf(r, "psfunc") === "fail" && JSON.stringify(pagesOf(r, "psfunc")) === "[1]" && detailOf(r, "psfunc") === "/FunctionType 4 — 1"
  );
  check(
    "psfunc: FunctionType 2 is NOT flagged (no false positive)",
    r.checks.filter((c) => c.id === "psfunc").length === 1
  );
  check(
    "psfunc: the cyclic /Function reference does not exhaust the stack (depth guard)",
    r.checks.length === CHECK_IDS.length
  );
}

/* ================================================================== */
console.log("── 6. forbidden content vectors ────────────────────────────");
/* ================================================================== */

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  setRawPage(doc, "100 100 50 50 re f", {});
  doc.catalog.set(PDFName.of("Encrypt"), doc.context.obj({ Filter: "Standard", V: 2 }));
  const r = show("encrypt@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check("encrypt: catalog /Encrypt stub fails", statusOf(r, "encrypt") === "fail");
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  setRawPage(doc, "100 100 50 50 re f", {});
  doc.catalog.set(
    PDFName.of("Names"),
    doc.context.obj({
      JavaScript: doc.context.obj({ Names: [PDFString.of("(app.alert(1);)")] }),
    })
  );
  const r = show("jsNames@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "jsNames: /Names/JavaScript fails with the honest detail",
    statusOf(r, "js") === "fail" && detailOf(r, "js").startsWith("/Names/JavaScript")
  );
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const jsAnnot = doc.context.obj({
    Type: "Annot", Subtype: "Widget", Rect: [10, 110, 100, 130],
    A: { S: "JavaScript", JS: PDFString.of("app.alert(1);") },
  });
  const jsKeyAnnot = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [10, 200, 100, 220],
    A: { S: "GoTo", JS: PDFString.of("sneaky") },
  });
  const cyclicAct = doc.context.obj({ S: "GoTo" });
  const cyclicRef = doc.context.register(cyclicAct);
  cyclicAct.set(PDFName.of("Next"), doc.context.obj([cyclicRef]));
  const launchChain = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [10, 140, 100, 160],
    A: cyclicRef,
  });
  const mm = doc.context.obj({ Type: "Annot", Subtype: "RichMedia", Rect: [10, 10, 100, 100] });
  const page = doc.addPage([595.28, 841.89]);
  const content = doc.context.stream("100 100 50 50 re f", {});
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
  page.node.set(PDFName.of("Resources"), doc.context.obj({}));
  page.node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      doc.context.register(jsAnnot),
      doc.context.register(jsKeyAnnot),
      doc.context.register(launchChain),
      doc.context.register(mm),
    ])
  );
  const r = show("annots@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "annots: /A /S /JavaScript action fails with the page",
    statusOf(r, "js") === "fail" && JSON.stringify(pagesOf(r, "js")) === "[1]" && detailOf(r, "js") === "/JS actions — 1"
  );
  check(
    "annots: a bare /JS key on a non-JS action is still JavaScript",
    r.checks.filter((c) => c.id === "js").length === 1 && statusOf(r, "js") === "fail"
  );
  check(
    "annots: RichMedia annotation fails multimedia with subtype + page",
    statusOf(r, "multimedia") === "fail" && JSON.stringify(pagesOf(r, "multimedia")) === "[1]" && detailOf(r, "multimedia") === "RichMedia — 1"
  );
  check(
    "annots: cyclic /Next chain does not exhaust the stack (depth guard) → no Launch found",
    statusOf(r, "launch") === "pass"
  );
}

{
  /* A real /Launch through the /Next chain + the plain /OpenAction forms. */
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  const launchAnnot = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [10, 140, 100, 160],
    A: { S: "GoTo", Next: [{ S: "Launch", F: PDFString.of("(calc.exe)") }] },
  });
  const page = doc.addPage([595.28, 841.89]);
  const content = doc.context.stream("100 100 50 50 re f", {});
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
  page.node.set(PDFName.of("Resources"), doc.context.obj({}));
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(launchAnnot)]));
  const r = show("launch@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "launch: /S /Launch chained via /Next fails with pages",
    statusOf(r, "launch") === "fail" && JSON.stringify(pagesOf(r, "launch")) === "[1]" && detailOf(r, "launch") === "/S /Launch — 1"
  );
}

{
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "B"));
  setRawPage(doc, "100 100 50 50 re f", {});
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "GoTo", D: [1, "Fit"] }));
  const r = show("openaction-dict@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "openaction: action-dictionary form fails",
    statusOf(r, "openaction") === "fail" && detailOf(r, "openaction") === "/OpenAction is an action dictionary, not a destination"
  );

  const doc2 = await PDFDocument.create();
  stampXmp(doc2, xmpPacket(2, "B"));
  setRawPage(doc2, "100 100 50 50 re f", {});
  doc2.catalog.set(PDFName.of("OpenAction"), PDFName.of("FitH"));
  const r2 = show("openaction-dest@2b", new Uint8Array(await doc2.save({ useObjectStreams: false })), "2b");
  check(
    "openaction: destination form passes",
    statusOf(r2, "openaction") === "pass"
  );
}

{
  /* /AF filespec with a REAL EmbeddedFile stream (the Factur-X shape). */
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(3, "B"));
  setRawPage(doc, "100 100 50 50 re f", {});
  const ef = doc.context.stream(new Uint8Array([104, 105]), {
    Type: "EmbeddedFile", Subtype: "text/plain",
  });
  const filespec = doc.context.obj({
    Type: "Filespec", F: PDFString.of("data.xml"), EF: { F: doc.context.register(ef) },
  });
  doc.catalog.set(PDFName.of("AF"), doc.context.obj([filespec]));
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r1 = show("af@1b", bytes, "1b");
  check(
    "af@1b: embedded files violate PDF/A-1b",
    statusOf(r1, "embfiles") === "fail" && detailOf(r1, "embfiles") === "/AF or /Names/EmbeddedFiles present — violates 1b"
  );
  const r2 = show("af@2b", bytes, "2b");
  check(
    "af@2b: embedded files violate PDF/A-2b",
    statusOf(r2, "embfiles") === "fail" && detailOf(r2, "embfiles") === "/AF or /Names/EmbeddedFiles present — violates 2b"
  );
  const r3 = show("af@3b", bytes, "3b");
  check(
    "af@3b: PDF/A-3b allows embedded files (how Factur-X works)",
    statusOf(r3, "embfiles") === "pass" && detailOf(r3, "embfiles") === "PDF/A-3 allows embedded files"
  );
  const r4 = show("af@auto", bytes, "auto");
  check(
    "af@auto: level 3b auto-detected from the XMP",
    r4.effectiveLevel === "3b" && r4.autoDetected && statusOf(r4, "embfiles") === "pass"
  );
}

/* ================================================================== */
console.log("── 7. XMP honesty vectors ──────────────────────────────────");
/* ================================================================== */

{
  const doc = await PDFDocument.create();
  setRawPage(doc, "100 100 50 50 re f", {});
  const r = show("noXmp@auto", new Uint8Array(await doc.save({ useObjectStreams: false })), "auto");
  check(
    "noXmp: xmp fails, title + mirror skipped, level assumed 2b",
    statusOf(r, "xmp") === "fail" && statusOf(r, "title") === "skip" && statusOf(r, "mirror") === "skip" &&
      r.effectiveLevel === "2b" && !r.autoDetected && r.detectedLevel === null && r.xmpClaim === null
  );
  check("noXmp: verdict fail (identification is mandatory)", r.verdict === "fail");
}

{
  const doc = await PDFDocument.create();
  setRawPage(doc, "100 100 50 50 re f", {});
  const junk = doc.context.stream("this is not xmp at all", { Type: "Metadata" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(junk));
  const r = show("xmp-junk@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "xmp-junk: present but unrecognizable → nXmpNoPart + parseError detail",
    statusOf(r, "xmp") === "fail" && detailOf(r, "xmp") === "no XMP/RDF structure recognized" && r.xmp.parseError === "no XMP/RDF structure recognized"
  );
  check(
    "xmp-junk: present-but-no-title → title warning (not skip)",
    statusOf(r, "title") === "warn"
  );
}

{
  const doc = await PDFDocument.create();
  setRawPage(doc, "100 100 50 50 re f", {});
  doc.catalog.set(PDFName.of("Metadata"), doc.context.obj({ Junk: 1 }));
  const r = show("xmp-direct@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "xmp-direct: /Metadata must be an indirect stream reference",
    statusOf(r, "xmp") === "fail" && detailOf(r, "xmp") === "catalog /Metadata is not an indirect stream reference"
  );
}

{
  const doc = await PDFDocument.create();
  setRawPage(doc, "100 100 50 50 re f", {});
  const plainDictRef = doc.context.register(doc.context.obj({ A: 1 }));
  doc.catalog.set(PDFName.of("Metadata"), plainDictRef);
  const r = show("xmp-nonstream@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "xmp-nonstream: ref to a non-stream object is honestly unreadable",
    statusOf(r, "xmp") === "fail" && detailOf(r, "xmp") === "metadata stream unreadable (absent / corrupted / non-Flate filter)"
  );
}

{
  const doc = await PDFDocument.create();
  setRawPage(doc, "100 100 50 50 re f", {});
  const part9 = doc.context.stream(xmpPacket(9, "B", { title: "Nine" }), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(part9));
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r1 = show("part9@auto", bytes, "auto");
  check(
    "part9@auto: no level mapped → assumed 2b, identification still passes (claim 9B)",
    r1.effectiveLevel === "2b" && r1.detectedLevel === null && !r1.autoDetected && statusOf(r1, "xmp") === "pass" && detailOf(r1, "xmp") === "9B"
  );
  const r2 = show("part9@2b", bytes, "2b");
  check(
    "part9@2b: declared level mismatches part 9 honestly",
    statusOf(r2, "xmp") === "fail" && detailOf(r2, "xmp") === "pdfaid:part=9 (conformance B) — target 2b"
  );
}

{
  const doc = await PDFDocument.create();
  doc.setTitle("Info Title");
  doc.setProducer("Info Producer");
  stampXmp(doc, xmpPacket(2, "B", { title: "XMP Title", producer: "XMP Producer" }));
  setRawPage(doc, "100 100 50 50 re f", {});
  const r = show("mirror-warn@2b", new Uint8Array(await doc.save({ useObjectStreams: false })), "2b");
  check(
    "mirror: differing /Info ↔ XMP values warn with both sides",
    statusOf(r, "mirror") === "warn" && detailOf(r, "mirror").includes('Title: "Info Title" ≠ "XMP Title"') && detailOf(r, "mirror").includes('Producer: "Info Producer" ≠ "XMP Producer"')
  );
}

{
  /* Conformance "A": the level-a structure rules activate. */
  const doc = await PDFDocument.create();
  stampXmp(doc, xmpPacket(2, "A", { title: "A doc" }));
  setRawPage(doc, "100 100 50 50 re f", {});
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const r1 = show("confA-bare@2b", bytes, "2b");
  check(
    "confA: XMP conformance letter vs -b target is a warning, not a failure",
    statusOf(r1, "xmp") === "warn" && detailOf(r1, "xmp") === "XMP conformance A vs target 2b" && r1.conformanceA
  );
  check(
    "confA: level-a rules activate → MarkInfo/StructTree required and failing",
    statusOf(r1, "structinfo") === "fail" && detailOf(r1, "structinfo") === "MarkInfo/Marked=false, StructTreeRoot=false"
  );
  const doc2 = await PDFDocument.load(bytes);
  doc2.catalog.set(PDFName.of("MarkInfo"), doc2.context.obj({ Marked: true }));
  const tree = doc2.context.obj({ Type: "StructTreeRoot", K: [doc2.context.obj({ Alt: "x" })] });
  doc2.catalog.set(PDFName.of("StructTreeRoot"), doc2.context.register(tree));
  const r2 = show("confA-tagged@2b", new Uint8Array(await doc2.save({ useObjectStreams: false })), "2b");
  check(
    "confA: with MarkInfo + StructTreeRoot the level-a check passes",
    statusOf(r2, "structinfo") === "pass" && detailOf(r2, "structinfo") === "MarkInfo/Marked=true, StructTreeRoot=true"
  );
}

/* ================================================================== */
console.log("── 8. xref recovery (the slightly-broken fixture) ─────────");
/* ================================================================== */
{
  const s = toLatin(greenBytes);
  const replaced = s.replace(/startxref\n(\d+)\n/, (_all, digits: string) =>
    `startxref\n${String(9).padStart(digits.length, "0")}\n`
  );
  if (replaced === s) {
    check("recovery: fixture built (startxref offset found)", false);
  } else {
    check("recovery: fixture built (startxref offset found)", true);
  }
  const bytes = new Uint8Array(replaced.length);
  for (let i = 0; i < replaced.length; i += 1) bytes[i] = replaced.charCodeAt(i) & 0xff;
  const r = show("broken-startxref@2b", bytes, "2b");
  check(
    "recovery: honest recoveryUsed + raw reason",
    r.recoveryUsed && r.recoveryReason === "offset 9 is neither xref table nor xref stream"
  );
  check(
    "recovery: the linear object scan still validates everything (verdict pass)",
    r.verdict === "pass" && statusOf(r, "xmp") === "pass" && statusOf(r, "fonts") === "pass" && r.pageCount === 1
  );
  check(
    "recovery: /Info unreachable without the trailer → mirror honestly passes",
    statusOf(r, "mirror") === "pass"
  );
  const text = buildReportText(r, { fileName: "broken.pdf", bytes: bytes.length }, {});
  check(
    "recovery: report carries both recovery lines",
    text.includes("xref: recovery (linear object scan)") &&
      text.includes("Recovery: offset 9 is neither xref table nor xref stream")
  );
}

/* ================================================================== */
console.log("── 9. buildReportText (EN fallback + HI labels) ────────────");
/* ================================================================== */
{
  const r = analyzePdfa(greenBytes, "2b");
  const meta = { fileName: "green.pdf", bytes: greenBytes.length };
  const text = buildReportText(r, meta, {});
  const lines = text.split("\n");
  check(
    "report: header banner",
    lines[0] === "=".repeat(64) && lines[1] === "DocoPDF — PDF/A conformance report (honest subset)" && lines[2] === "=".repeat(64)
  );
  check(
    "report: file line with humanized bytes",
    lines[3]!.startsWith(`File: green.pdf (${(greenBytes.length / 1024).toFixed(1)} KB)`)
  );
  check(
    "report: document line — declared level form",
    lines[4] === "Document: 1 pages · Level: 2B (declared)"
  );
  check("report: healthy xref line", lines[5] === "xref: ok");
  check(
    "report: summary + verdict",
    text.includes("SUMMARY: 14 passed, 1 warnings, 2 failed") && text.includes("VERDICT: COMPLIANT")
  );
  const groupLine = lines.find((l) => l.startsWith("── IDENTIFICATION ")) ?? "";
  check(
    "report: group headers padded to 66 with ─",
    groupLine.length === 66 && groupLine.startsWith("── IDENTIFICATION ") && groupLine.endsWith("─")
  );
  check(
    "report: check row format [PASS] + label",
    text.includes("  [PASS] XMP identification (pdfaid:part/conformance)")
  );
  check(
    "report: note + detail lines",
    text.includes("      dc:title is present in the XMP.") && text.includes("      (Green Archive)")
  );
  check(
    "report: skip rows say NOT REQUIRED",
    text.includes("  [NOT REQUIRED] MarkInfo / StructTreeRoot (level a)")
  );
  check(
    "report: FONTS USED section with the embedded font",
    text.includes("FONTS USED:") && /- NotoSansDevanagari[^\n]*\(Type0\) — embedded — pages: 1/.test(text)
  );
  check(
    "report: no UNEMBEDDED FONTS section when all are embedded",
    !text.includes("UNEMBEDDED FONTS:")
  );
  check(
    "report: honesty footer + on-device line (wrap-normalized)",
    text.includes("NOT CHECKED (honesty)") &&
      text
        .replace(/\s+/g, " ")
        .includes("The PDF/UA rows are advisory hints only (full PDF/UA validation is not performed).") &&
      text.endsWith("Generated on-device by DocoPDF — nothing was uploaded.\n")
  );
  check(
    "report: deterministic (no timestamps)",
    buildReportText(r, meta, {}) === text
  );

  /* level-line variants */
  const autoR = analyzePdfa(greenBytes, "auto");
  const autoText = buildReportText(autoR, meta, {});
  check(
    "report: auto-detected level line",
    autoText.includes("Level: 2B (auto-detected from XMP)")
  );
  const noXmpR = analyzePdfa(new Uint8Array(await (async () => {
    const doc = await PDFDocument.create();
    setRawPage(doc, "100 100 50 50 re f", {});
    return doc.save({ useObjectStreams: false });
  })()), "auto");
  check(
    "report: assumed level line when no XMP identification",
    buildReportText(noXmpR, meta, {}).includes("Level: 2B (assumed — no XMP identification)")
  );
  const helv = await buildHelv(1);
  const mismatchR = analyzePdfa(helv, "2b");
  check(
    "report: declared + XMP mismatch level line",
    buildReportText(mismatchR, meta, {}).includes("Level: 2B (declared; XMP 1B)")
  );

  /* the unembedded fonts section */
  const helvText = buildReportText(mismatchR, { fileName: "helv.pdf", bytes: helv.length }, {});
  check(
    "report: UNEMBEDDED FONTS section lists Helvetica",
    helvText.includes("UNEMBEDDED FONTS:") && helvText.includes("  - Helvetica (Type1) — pages: 1")
  );
  check(
    "report: failing checks carry their page references",
    helvText.includes("      pages: 1")
  );

  /* byte formatting */
  const tiny = buildReportText(noXmpR, { fileName: "t.pdf", bytes: 42 }, {});
  check("report: humanBytes — bytes under 1 KB", tiny.includes("File: t.pdf (42 B)"));

  /* Hindi labels from the tool catalog */
  const hiLeaves = (toolI18n as { hi: { vpa: Record<string, string> } }).hi.vpa;
  const hiLabels = Object.fromEntries(
    Object.entries(hiLeaves).map(([k, v]) => [`vpa.${k}`, v])
  );
  const hiText = buildReportText(r, meta, hiLabels);
  check(
    "report(HI): localized title + file + summary + verdict",
    hiText.includes("DocoPDF — PDF/A अनुरूपता रिपोर्ट (ईमानदार उपसमुच्चय)") &&
      hiText.includes("फ़ाइल: green.pdf") &&
      hiText.includes("सारांश: 14 पास, 1 चेतावनियाँ, 2 फ़ेल") &&
      hiText.includes("फ़ैसला: अनुरूप")
  );
  check(
    "report(HI): group header + skip word localized",
    hiText.includes("── पहचान ") && hiText.includes("[आवश्यक नहीं]")
  );

  /* the model's English fallback is report-styled (uppercase groups) by
   * design — labels passed from the surface (UI casing) always win. */
  check(
    "report: fallback group header is report-styled uppercase",
    text.includes("── COLOR & TRANSPARENCY ") && hiText.includes("── रंग और पारदर्शिता ")
  );
}

/* ================================================================== */
console.log("── 10. REAL worker E2E (self-shimmed) ─────────────────────");
/* ================================================================== */
{
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  await import("../tools/validate-pdfa/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "validate-pdfa",
        options,
        files,
      } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  const enLeaves = (toolI18n as { en: { vpa: Record<string, string> } }).en.vpa;
  const enLabels = Object.fromEntries(
    Object.entries(enLeaves).map(([k, v]) => [`vpa.${k}`, v])
  );
  const runPayload = JSON.stringify({ locale: "en", fileWord: "document", labels: enLabels });

  /* --- the green run --------------------------------------------------- */
  const greenRes = await drive(301, { run: runPayload }, [
    new File([greenBytes as BlobPart], "archive.pdf"),
  ]);
  check("worker: green result", greenRes.type === "result", greenRes);
  if (greenRes.type === "result") {
    check(
      "worker: output name + mime",
      greenRes.outputs.length === 1 &&
        greenRes.outputs[0]!.name === "archive-pdfa-report.txt" &&
        greenRes.outputs[0]!.mime === "text/plain;charset=utf-8"
    );
    const d = greenRes.detail as {
      files?: number;
      verdict?: string;
      checksPassed?: number;
      checksWarned?: number;
      checksFailed?: number;
      level?: string;
      declaredLevel?: string;
      detectedLevel?: string | null;
      recovered?: boolean;
    };
    check(
      "worker: green detail counts + auto-detect levels (no level in options.run)",
      d.files === 1 && d.verdict === "pass" && d.checksPassed === 14 && d.checksWarned === 1 && d.checksFailed === 2 &&
        d.level === "2b" && d.declaredLevel === "auto" && d.detectedLevel === "2b" && d.recovered === false
    );
    const report = (greenRes.detail as { report?: PdfaReport }).report;
    check(
      "worker: the full PdfaReport rides along for the surface",
      report !== undefined && report.checks.length === CHECK_IDS.length && report.verdict === "pass" && report.fonts.length === 1
    );
    const text = await greenRes.outputs[0]!.blob.text();
    check(
      "worker: report text (summary + verdict + fonts + honesty)",
      text.includes("SUMMARY: 14 passed, 1 warnings, 2 failed") &&
        text.includes("VERDICT: COMPLIANT") &&
        text.includes("FONTS USED:") &&
        text.includes("NOT CHECKED (honesty)")
    );
    const progresses = messages.filter(
      (m) => m.runId === 301 && m.type === "progress"
    ) as Extract<WorkerResponse, { type: "progress" }>[];
    check(
      "worker: progress beats 15/40/80/92 in order",
      JSON.stringify(progresses.map((p) => p.pct)) === JSON.stringify([15, 40, 80, 92]),
      progresses.map((p) => p.pct)
    );
    check(
      "worker: honest stages reading/processing/saving",
      ["reading", "processing", "saving"].every((s) => progresses.some((p) => p.stage === s))
    );
  }

  /* --- level round-trip through options.run (std-14 exemption live) ------ */
  const helvBytes = await buildHelv(1);
  const levelRes = await drive(
    302,
    { run: JSON.stringify({ locale: "en", level: "1b", fileWord: "document", labels: enLabels }) },
    [new File([helvBytes as BlobPart], "legacy.pdf")]
  );
  check("worker: level 1b via options.run → result", levelRes.type === "result");
  if (levelRes.type === "result") {
    const d = levelRes.detail as { level?: string; declaredLevel?: string; verdict?: string };
    check(
      "worker: declared level honored (1b + std-14 fonts pass)",
      d.level === "1b" && d.declaredLevel === "1b"
    );
    const text = await levelRes.outputs[0]!.blob.text();
    check(
      "worker: std-14 note in the report",
      text.includes("Only standard-14 fonts are unembedded, which PDF/A-1b allows.")
    );
  }

  /* --- Hindi labels through the worker ---------------------------------- */
  const hiLeaves = (toolI18n as { hi: { vpa: Record<string, string> } }).hi.vpa;
  const hiLabels = Object.fromEntries(
    Object.entries(hiLeaves).map(([k, v]) => [`vpa.${k}`, v])
  );
  const hiRes = await drive(
    303,
    { run: JSON.stringify({ locale: "hi", fileWord: "दस्तावेज़", labels: hiLabels }) },
    [new File([greenBytes as BlobPart], "archive.pdf")]
  );
  check("worker: Hindi run result", hiRes.type === "result");
  if (hiRes.type === "result") {
    const text = await hiRes.outputs[0]!.blob.text();
    check(
      "worker: Hindi report (title + summary + verdict)",
      text.includes("PDF/A अनुरूपता रिपोर्ट (ईमानदार उपसमुच्चय)") &&
        text.includes("सारांश: 14 पास, 1 चेतावनियाँ, 2 फ़ेल") &&
        text.includes("फ़ैसला: अनुरूप")
    );
  }

  /* --- rejection taxonomy ---------------------------------------------- */
  const notPdfRes = await drive(304, { run: runPayload }, [
    new File([latin1BytesOf("just some text, not a pdf") as BlobPart], "notes.txt"),
  ]);
  check(
    "worker: non-PDF → vpa.errNotPdf",
    notPdfRes.type === "error" && notPdfRes.code === "vpa.errNotPdf"
  );

  const corruptBytes = new Uint8Array(120);
  corruptBytes.set(latin1BytesOf("%PDF-1.4\njunk bytes, no objects\n%%EOF\n"), 0);
  const corruptRes = await drive(305, { run: runPayload }, [
    new File([corruptBytes as BlobPart], "broken.pdf"),
  ]);
  check(
    "worker: %PDF- but no catalog → tool.errorCorrupt",
    corruptRes.type === "error" && corruptRes.code === "tool.errorCorrupt"
  );

  const noFileRes = await drive(306, { run: runPayload }, []);
  check(
    "worker: no file → tool.errorGeneric",
    noFileRes.type === "error" && noFileRes.code === "tool.errorGeneric"
  );

  const huge = new Uint8Array(MAX_INPUT_BYTES + 1);
  huge.set(latin1BytesOf("%PDF-1.7\n"), 0);
  const tooBigRes = await drive(307, { run: runPayload }, [
    new File([huge as BlobPart], "huge.pdf"),
  ]);
  check(
    "worker: beyond the 64 MB gate → vpa.errTooBig",
    tooBigRes.type === "error" && tooBigRes.code === "vpa.errTooBig"
  );

  /* --- garbage options.run → the model's English fallback ---------------- */
  const garbageRes = await drive(308, { run: "{not even json" }, [
    new File([greenBytes as BlobPart], "archive.pdf"),
  ]);
  check("worker: garbage options.run still validates", garbageRes.type === "result");
  if (garbageRes.type === "result") {
    const d = garbageRes.detail as { declaredLevel?: string; level?: string };
    const text = await garbageRes.outputs[0]!.blob.text();
    check(
      "worker: fallback report is the model's English (auto level)",
      d.declaredLevel === "auto" && d.level === "2b" &&
        text.includes("PDF/A conformance report (honest subset)") &&
        text.includes("── COLOR & TRANSPARENCY ")
    );
  }

  /* --- onmessage honesty ------------------------------------------------- */
  const beforeCount = messages.length;
  workerGlobal.onmessage!({ data: { type: "definitely-not-run" } as never });
  await new Promise((r) => setTimeout(r, 150));
  check("worker: non-run messages ignored", messages.length === beforeCount);
}

/* ================================================================== */
console.log("── 11. i18n + config + wiring ─────────────────────────────");
/* ================================================================== */
{
  const enLeaves = (toolI18n as { en: { vpa: Record<string, string> } }).en.vpa;
  const hiLeaves = (toolI18n as { hi: { vpa: Record<string, string> } }).hi.vpa;
  const enKeys = Object.keys(enLeaves).sort();
  const hiKeys = Object.keys(hiLeaves).sort();
  check(
    "i18n: tool catalog en/hi key parity",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys),
    { en: enKeys.length, hi: hiKeys.length }
  );
  check("i18n: the vpa namespace is substantial", enKeys.length === 144, enKeys.length);
  check(
    "i18n: no empty values in either language",
    [...Object.values(enLeaves), ...Object.values(hiLeaves)].every(
      (v) => typeof v === "string" && v.trim().length > 0
    )
  );

  const surfaceSrc = readFileSync("tools/validate-pdfa/surface.tsx", "utf8");
  const configSrc = readFileSync("tools/validate-pdfa/config.ts", "utf8");
  const workerSrc = readFileSync("tools/validate-pdfa/worker.ts", "utf8");
  const modelSrc = readFileSync("tools/validate-pdfa/model.ts", "utf8");
  const sources = `${surfaceSrc}\n${configSrc}\n${workerSrc}\n${modelSrc}`;

  // every vpa.* referenced from the four tool sources resolves…
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/vpa\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  // …plus the REPORT_KEYS the surface serializes as `vpa.${k}` template keys.
  const rkMatch = /const REPORT_KEYS = \[([^]*?)\] as const;/.exec(surfaceSrc);
  const reportKeys =
    rkMatch === null ? [] : [...rkMatch[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  for (const k of reportKeys) referenced.add(`vpa.${k}`);
  // NOTE: the namespace prefix "vpa." is exactly 4 characters — slice(4)
  // (the RB6 slice bug lesson: count per namespace, "vps." was also 4).
  // "vpa.g" is the template PREFIX of `vpa.g${group…}` in buildReportText —
  // the real group keys (gIdentify…gUa) are covered by REPORT_KEYS.
  const missing = [...referenced].filter(
    (k) => k !== "vpa.g" && (!(k.slice(4) in enLeaves) || !(k.slice(4) in hiLeaves))
  );
  check(
    "i18n: every referenced vpa.* key resolves in both catalogs",
    referenced.size >= 145 && missing.length === 0,
    { missing, referenced: referenced.size }
  );
  check(
    "i18n: the 7 report group keys resolve (the vpa.g template artifact excluded)",
    ["gIdentify", "gFonts", "gColor", "gForbidden", "gStructure", "gMeta", "gUa"].every(
      (k) => `vpa.${k}` in enLeaves || k in enLeaves
    )
  );
  const unused = enKeys.filter((k) => !referenced.has(`vpa.${k}`));
  check("i18n: no unused leaves (tight namespace)", unused.length === 0, unused);
  check("i18n: REPORT_KEYS extracted from the surface (104 keys)", reportKeys.length === 104, reportKeys.length);
  check(
    "i18n: worker error codes have leaves",
    "errNotPdf" in enLeaves && "errTooBig" in enLeaves && "errNotPdf" in hiLeaves && "errTooBig" in hiLeaves
  );
  check(
    "i18n: how1–how3 present in both",
    ["how1", "how2", "how3"].every((k) => k in enLeaves && k in hiLeaves)
  );
  check(
    "i18n: the model's REPORT_LABELS_EN covers exactly the surface's REPORT_KEYS",
    Object.keys(REPORT_LABELS_EN).length === reportKeys.length &&
      reportKeys.every((k) => `vpa.${k}` in REPORT_LABELS_EN)
  );
  // The model's fallback English is deliberately report-styled (uppercase
  // group headers) while the UI catalog uses sentence case — both pinned:
  check(
    "i18n: model fallback values are report-styled by design (pinned, not drifted)",
    REPORT_LABELS_EN["vpa.title"] === "PDF/A conformance report (honest subset)" &&
      REPORT_LABELS_EN["vpa.gColor"] === "COLOR & TRANSPARENCY" &&
      REPORT_LABELS_EN["vpa.vPass"] === "COMPLIANT" &&
      REPORT_LABELS_EN["vpa.cSkip"] === "NOT REQUIRED"
  );

  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool: Record<string, string>;
  };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    tool: Record<string, string>;
  };
  check(
    "i18n: shared tool.error* exist in the central catalog (worker fallbacks)",
    ["errorCorrupt", "errorGeneric", "errorTitle"].every(
      (k) => k in catEn.tool && k in catHi.tool
    )
  );

  // ---- config.ts ------------------------------------------------------
  check("config: toolId", configSrc.includes('toolId: "validate-pdfa"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind text", configSrc.includes('outputKind: "text"'));
  check("config: exactly one file", configSrc.includes("maxFiles: 1") && configSrc.includes("minFiles: 1"));
  check("config: howKeys are vpa.*", configSrc.includes('"vpa.how1"') && configSrc.includes('"vpa.how3"'));
  check("config: no options (zero-option tool)", configSrc.includes("options: []"));
  check(
    "config: chain tools declared",
    configSrc.includes('"view-pdf"') && configSrc.includes('"verify-pdf-signatures"') && configSrc.includes('"repair-pdf"')
  );

  // ---- surface.tsx ----------------------------------------------------
  check(
    "surface: ships the run payload with localized labels",
    surfaceSrc.includes('onChange("run"') && surfaceSrc.includes("REPORT_KEYS.map")
  );
  check("surface: fflate stays worker-only (no ./model import)", !/from "\.\/model"/.test(surfaceSrc));
  check("surface: CTA gating via setRunBlocked", surfaceSrc.includes("setRunBlocked"));
  check("surface: local %PDF- sniff (repair-pdf rule)", surfaceSrc.includes("localPdfSniff"));

  // ---- worker.ts ------------------------------------------------------
  check("worker: only reacts to type run", workerSrc.includes('data?.type !== "run"'));
  check("worker: maps errCorrupt to tool.errorCorrupt", workerSrc.includes('"tool.errorCorrupt"'));
  check("worker: on-device report suffix", workerSrc.includes("-pdfa-report.txt"));

  // ---- wiring (the orchestrator's batch step — asserted as done here) --
  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "wiring: configs.ts imports + registers the tool config",
    configsSrc.includes('import { config as validatePdfa } from "../../../tools/validate-pdfa/config"') &&
      configsSrc.includes("[validatePdfa.toolId]: validatePdfa")
  );
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "wiring: surfaces.tsx imports + registers the surface",
    surfacesSrc.includes('import { ValidatePdfaSurface } from "../../../tools/validate-pdfa/surface"') &&
      surfacesSrc.includes('"validate-pdfa": ValidatePdfaSurface')
  );
  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const at = registrySrc.indexOf('id: "validate-pdfa"');
  const block = registrySrc.slice(at, at + 480);
  check(
    "wiring: registry def enabled + mode D + view category + accepts pdf",
    at >= 0 && block.includes("enabled: true") && block.includes('mode: "D"') &&
      block.includes('category: "view"') && block.includes('accepts: "pdf"')
  );
  check(
    "wiring: the PDF/UA name decision — name says PDF/UA, description says NOT full validation",
    block.includes("Check PDF/A & PDF/UA") && block.includes("not full PDF/UA validation")
  );
  check(
    "wiring: registry description mentions the honest subset + advisory hints",
    block.includes("advisory PDF/UA hints")
  );
}

/* ------------------------------------------------------------------ */
console.log(
  `\nvalidate-pdfa smoke: ${pass} passed, ${fail} failed${
    failures.length > 0 ? `\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}` : ""
  }`
);
process.exit(fail > 0 ? 1 : 0);
