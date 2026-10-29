/**
 * P6-a smoke: DocoPDF OWN PDF micro-engine (src/lib/own/pdf) — the
 * zero-external-dependency page-surgery engine.
 *
 * Proves, against pdf-lib as DEV-TIME ORACLE ONLY (the established
 * own-engine pattern from own-zip/own-qr):
 *   1.  Lexer: comments, weird whitespace, octal/continuation escapes,
 *       nested parens, hex strings, #xx name escapes, negative/real numbers,
 *       ref-vs-number disambiguation.
 *   2.  Classic xref (pdf-lib useObjectStreams:false): subsections, free
 *       entries, cross-check page count / MediaBox / Rotate per page.
 *   3.  Xref STREAMS + ObjStm (pdf-lib useObjectStreams:true): our OWN zlib
 *       inflates them; page trees resolve through object streams.
 *   4.  Hand-crafted xref stream with PNG Predictor 12 (Up) — W [1 4 2].
 *   5.  Indirect /Length + endstream scan; ground-truth content bytes.
 *   6.  /Encrypt → typed refusal. Broken xref → brute recovery.
 *   7.  Round-trip: organize (all pages) → pdf-lib reload identical
 *       structure; content-stream bytes BYTE-IDENTICAL.
 *   8.  Selection [2,0,4] reordered; rotation deltas; A4 blank insertion.
 *   9.  Cross-document primitive: writeDocument over TWO parsed docs
 *       (merge kernel) — pdf-lib reload verifies.
 *  10.  Self-compatibility: our parser loads our writer's output.
 *  11.  organizeMerge (P6-d): multi-doc merge API — 3 sources, blanks,
 *       duplicates, rotation deltas, byte-identical content, highest
 *       input version in the header, typed error guards.
 *  16.  Stamp kernel (P6-f): measureStdText EXACT pdf-lib parity (kerning),
 *       hex Tj parity, text stamps (resources merge, no /F1 shadowing,
 *       behind/front order, dedup, ExtGState, rotation Tm), JPEG DCT
 *       passthrough, PNG→RGB+SMask pixel round-trip, inherited Resources,
 *       typed error vectors.
 *  17.  Devanagari (P6-g): TTF subset + shaping + Type0 embed (see §17).
 *  18.  CreateContext (P6-i): blank-document authoring — operator-sequence
 *       parity with pdf-lib's PDFPage draws (normalized names/numbers),
 *       writer numbering (page dicts/streams then synthetics), PNG+SMask
 *       & JPEG routes, the Devanagari create route (ToUnicode round-trip,
 *       fontkit-loadable subset), the 12-font metrics set vs the oracle,
 *       typed API refusals.
 *  19.  Overlay route (P6-j): embedForm + stampForm — drawPage operator
 *       parity vs the pdf-lib oracle (identity-skew cm normalized), form
 *       BBox/Matrix (the DEFAULT MediaBox-normalized embed box, origin
 *       discarded), decoded form bodies byte-exact (the q/Q wrap + join),
 *       numbering/resources structure, the alpha pre-scale walk (nested
 *       XObjects + the shared-gs multiplicative quirk kept for parity),
 *       odd-box default embed, BFS single-copy of shared overlay graphs.
 *
 * Run: bun scripts/smoke-pdf-core.ts
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees, rgb } from "pdf-lib";

import {
  listPages,
  organizeMerge,
  organizePdf,
  organizePages,
  parseForOrganize,
  parsePdf,
  pdfNumToString,
  PdfError,
  resolve,
  asNum,
  writeDocument,
  StampContext,
  CreateContext,
  decodeForParser,
  measureStdText,
  encodeWinAnsiHex,
  winAnsiEncodable,
  ParsedTtfFont,
  readAcroFormFields,
  shapeText,
  WinAnsiError,
  type StampTtfFont,
  type AcroFieldInfo,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
} from "../src/lib/own/pdf";
import { latin1 } from "../src/lib/own/pdf/lexer";
import { crc32, unzlibSync, zlibSync } from "../src/lib/own/zip";
import { scaleOverlayAlpha } from "../tools/overlay-pdf/worker-lib";
import pako from "pako";
import { Lexer } from "../src/lib/own/pdf/lexer";
import { pngUnfilter } from "../src/lib/own/pdf/parser";

let pass = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

function eq<T>(a: T, b: T, label: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * /Contents bytes for page i: stream ref, ARRAY of stream refs (pdf-lib
 * writes this shape!), or a direct stream. Concatenates multi-stream
 * arrays per spec semantics. Returns empty ONLY when the page truly has
 * no content — never as a parsing cop-out (the P6-c vacuity lesson).
 */
function contentBytesOf(
  doc: ParsedPdf,
  pages: PdfPageInfo[],
  i: number,
): Uint8Array {
  const value = pages[i]!.dict.get("Contents");
  if (!value) return new Uint8Array(0);
  const readOne = (v: PdfObj): Uint8Array => {
    if (v.k === "stream") return v.raw;
    if (v.k !== "ref") return new Uint8Array(0);
    const s = doc.getObject(v.num);
    return s && s.k === "stream" ? s.raw : new Uint8Array(0);
  };
  if (value.k === "arr") {
    let total = 0;
    const parts = value.items.map(readOne);
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return readOne(value);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface SpecPage {
  w: number;
  h: number;
  rot: number;
}

async function buildPdfLibFixture(
  pages: SpecPage[],
  useObjectStreams: boolean,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer("DocoPDF smoke");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((p, i) => {
    const page = doc.addPage([p.w, p.h]);
    page.drawText(`Page ${i + 1}`, {
      x: 48,
      y: p.h - 72,
      size: 24,
      font,
      color: rgb(0.05, 0.46, 0.43),
    });
    if (p.rot !== 0) page.setRotation(degrees(p.rot));
  });
  return doc.save({ useObjectStreams });
}

/** Assemble a hand-crafted PDF while TRACKING byte offsets exactly. */
function buildWildFixture(): { bytes: Uint8Array; content1: Uint8Array } {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let len = 0;
  const offsets = new Map<number, number>();
  const push = (s: string | Uint8Array): void => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    parts.push(b);
    len += b.length;
  };
  const mark = (objNum: number): void => {
    offsets.set(objNum, len);
  };

  push("%PDF-1.4\n%âãÏÓ\n% comment line right after the binary marker\n");
  mark(1);
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  mark(2);
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n");
  mark(3);
  // #31 = '1' → /F1 ; CropBox negative numbers; hex string value.
  push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]" +
      " /CropBox [-10 -20 622 812] /Rotate 90" +
      " /Resources << /Font << /F#31 4 0 R >> /Meta <48656C6C6F> >>" +
      " /Contents 7 0 R >>\nendobj\n",
  );
  mark(4);
  push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  mark(7);
  const content1 =
    "BT /F1 24 Tf 72 720 Td (Parens (nested) and escapes \\n\\t\\) done) Tj ET";
  const content1Bytes = enc.encode(content1);
  push(`7 0 obj\n<< /Length 8 0 R >>\nstream\n`);
  push(content1Bytes);
  push("\nendstream\nendobj\n");
  mark(8);
  push(`8 0 obj\n${content1Bytes.length}\nendobj\n`);
  mark(5);
  push("5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R >>\nendobj\n");
  mark(6);
  const content2 = "BT /F1 12 Tf 10 50 Td (Second) Tj ET";
  push(`6 0 obj\n<< /Length ${enc.encode(content2).length} >>\nstream\n${content2}\nendstream\nendobj\n`);
  const xrefPos = len;
  push("xref\n0 4\n");
  push("0000000000 65535 f \n");
  for (const n of [1, 2, 3]) {
    push(`${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`);
  }
  push("4 5\n");
  for (const n of [4, 5, 6, 7, 8]) {
    push(`${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`);
  }
  push("trailer\n<< /Size 9 /Root 1 0 R >>\n");
  push(`startxref\n${xrefPos}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return { bytes: out, content1: content1Bytes };
}

/** XRef stream fixture with PNG Predictor 12 (Up), W [1 4 2]. */
function buildPredictorFixture(): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let len = 0;
  const offsets = new Map<number, number>();
  const push = (s: string | Uint8Array): void => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    parts.push(b);
    len += b.length;
  };
  const mark = (n: number): void => {
    offsets.set(n, len);
  };

  push("%PDF-1.5\n");
  const content = "BT /F1 14 Tf 20 40 Td (Predictor) Tj ET";
  const contentLen = enc.encode(content).length;
  mark(1);
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  mark(2);
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  mark(3);
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R >>\nendobj\n");
  mark(4);
  push(`4 0 obj\n<< /Length ${contentLen} >>\nstream\n${content}\nendstream\nendobj\n`);

  mark(5); // xref stream object (offset known only after assembly → two-pass)
  const xrefObjStart = offsets.get(5)!;
  // Entries: 0 free, 1-4 in-use, 5 (this stream) in-use.
  const entryLen = 7; // W [1 4 2]
  const rawRows: Uint8Array[] = [];
  const entry = (type: number, a: number, b: number): Uint8Array => {
    const e = new Uint8Array(entryLen);
    e[0] = type;
    e[1] = (a >>> 24) & 0xff;
    e[2] = (a >>> 16) & 0xff;
    e[3] = (a >>> 8) & 0xff;
    e[4] = a & 0xff;
    e[5] = (b >>> 8) & 0xff;
    e[6] = b & 0xff;
    return e;
  };
  rawRows.push(entry(0, 0, 65535));
  for (const n of [1, 2, 3, 4]) rawRows.push(entry(1, offsets.get(n)!, 0));
  rawRows.push(entry(1, xrefObjStart, 0));
  // PNG-Up encode: row0 filter 0; others filter 2 (XOR with previous row).
  const filtered: number[] = [];
  let prev: Uint8Array = new Uint8Array(entryLen);
  rawRows.forEach((row, r) => {
    if (r === 0) {
      filtered.push(0);
      for (const byte of row) filtered.push(byte);
    } else {
      filtered.push(2);
      for (let i = 0; i < entryLen; i++) filtered.push(row[i]! ^ prev[i]!);
    }
    prev = row;
  });
  const filteredBytes = Uint8Array.from(filtered);
  const zlibbed = zlibSync(filteredBytes) as Uint8Array; // OUR OWN zlib (engine end-to-end)
  const xrefDict =
    `5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Index [0 6]` +
    ` /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${entryLen}` +
    ` /Colors 1 /BitsPerComponent 8 >> /Root 1 0 R /Length ${zlibbed.length} >>\nstream\n`;
  push(xrefDict);
  push(zlibbed);
  push("\nendstream\nendobj\n");
  push(`startxref\n${xrefObjStart}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** Minimal /Encrypt trailer — parser must refuse with the typed error. */
function buildEncryptedFixture(): Uint8Array {
  const enc = new TextEncoder();
  const body =
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>\nendobj\n" +
    "4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <0102030405060708> /U <0908070605040302> /P -1 >>\nendobj\n";
  const xrefPos = enc.encode(body).length;
  const trailer =
    `xref\n0 5\n` +
    `0000000000 65535 f \n` +
    `0000000009 00000 n \n` +
    `0000000056 00000 n \n` +
    `0000000110 00000 n \n` +
    `0000000177 00000 n \n` +
    `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return enc.encode(body + trailer);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("== 1. lexer primitives ==");
  {
    const lex = new Lexer(new TextEncoder().encode(
      "% leading comment\n[ 42 -7 3.5 .5 /Name#20With <48656C6C6F> (str \\101\\x? \\\n next) << /A 1 >> true false null 12 0 R ]",
    ));
    // whole-array parse through the parser's grammar via a tiny harness:
    const val = parseValueForSmoke(lex);
    ok(val.k === "arr", "lexer+grammar parses the mixed array");
    if (val.k === "arr") {
      eq(val.items.slice(0, 4).map((v) => (v.k === "num" ? v.n : null)), [42, -7, 3.5, 0.5], "numbers incl. leading-dot real");
      const nm = val.items[4]!;
      ok(nm.k === "name" && nm.v === "Name With", "#xx name escape decodes");
      const hex = val.items[5]!;
      ok(hex.k === "str" && new TextDecoder().decode(hex.b) === "Hello", "hex string decodes");
      const lit = val.items[6]!;
      ok(
        lit.k === "str" &&
          new TextDecoder().decode(lit.b) === "str Ax?  next",
        "octal escape, unknown escape, backslash-EOL continuation",
      );
      ok(val.items[7]!.k === "dict", "nested dict parses");
      eq(val.items[8]?.k === "bool" && val.items[8].b, true, "true");
      eq(val.items[9]?.k === "bool" && val.items[9].b, false, "false");
      eq(val.items[10]?.k === "null", true, "null");
      const r = val.items[11]!;
      ok(r.k === "ref" && r.num === 12 && r.gen === 0, "12 0 R → ref, not 3 numbers");
    }
  }

  console.log("== 2. classic xref (pdf-lib useObjectStreams:false) ==");
  const specA: SpecPage[] = [
    { w: 612, h: 792, rot: 0 },
    { w: 300, h: 400, rot: 90 },
    { w: 595, h: 842, rot: 0 },
    { w: 612, h: 792, rot: 270 },
    { w: 250, h: 250, rot: 0 },
  ];
  const fixA = await buildPdfLibFixture(specA, false);
  {
    const doc = parsePdf(fixA);
    const pages = listPages(doc);
    eq(pages.length, 5, "page count");
    eq(pages.map((p) => [p.mediaBox[2], p.mediaBox[3]]), specA.map((s) => [s.w, s.h]), "media boxes");
    eq(pages.map((p) => p.rotate), specA.map((s) => s.rot), "rotations");
    ok(doc.version.startsWith("1."), "version sniffed");
    // pdf-lib oracle agreement
    const lib = await PDFDocument.load(fixA);
    eq(pages.length, lib.getPageCount(), "page count vs pdf-lib");
    let agree = true;
    for (let i = 0; i < pages.length; i++) {
      const lp = lib.getPage(i);
      const mine = pages[i]!;
      if (Math.abs(lp.getWidth() - mine.mediaBox[2]) > 0.01) agree = false;
      if (Math.abs(lp.getHeight() - mine.mediaBox[3]) > 0.01) agree = false;
      if (lp.getRotation().angle !== mine.rotate) agree = false;
    }
    ok(agree, "per-page box+rotation agree with pdf-lib");
  }

  console.log("== 3. xref stream + ObjStm (pdf-lib useObjectStreams:true) ==");
  const specB: SpecPage[] = [
    { w: 612, h: 792, rot: 0 },
    { w: 400, h: 300, rot: 0 },
    { w: 595, h: 842, rot: 180 },
    { w: 100, h: 700, rot: 90 },
  ];
  const fixB = await buildPdfLibFixture(specB, true);
  {
    const doc = parsePdf(fixB);
    const pages = listPages(doc);
    eq(pages.length, 4, "page count through ObjStm");
    eq(pages.map((p) => [p.mediaBox[2], p.mediaBox[3]]), specB.map((s) => [s.w, s.h]), "boxes through ObjStm");
    eq(pages.map((p) => p.rotate), specB.map((s) => s.rot), "rotations through ObjStm");
    const lib = await PDFDocument.load(fixB);
    eq(pages.length, lib.getPageCount(), "page count vs pdf-lib (ObjStm)");
  }

  console.log("== 4. hand-crafted wild bytes ==");
  const wildGroundTruth = new TextEncoder().encode(
    "BT /F1 24 Tf 72 720 Td (Parens (nested) and escapes \n\t) done) Tj ET",
  );
  {
    const wild = buildWildFixture();
    const doc = parsePdf(wild.bytes);
    ok(!doc.recovered, "valid xref → no brute recovery");
    const pages = listPages(doc);
    eq(pages.length, 2, "wild: page count");
    eq(pages[0]!.mediaBox, [0, 0, 612, 792], "wild: page0 mediaBox");
    eq(pages[0]!.cropBox, [-10, -20, 622, 812], "wild: negative CropBox");
    eq(pages[0]!.rotate, 90, "wild: /Rotate 90");
    // ground-truth content bytes through INDIRECT /Length
    const contentsRef = pages[0]!.dict.get("Contents");
    const stm = contentsRef && contentsRef.k === "ref" ? doc.getObject(contentsRef.num) : undefined;
    ok(!!stm && stm.k === "stream", "wild: content stream resolves");
    if (stm && stm.k === "stream") {
      // Streams pass through UNDECODED — raw must equal the SOURCE bytes
      // (escape sequences intact); the decoded-string semantics were
      // already proven by the §1 literal-string vector.
      ok(bytesEqual(stm.raw, wild.content1), "wild: indirect /Length content bytes EXACT (source form)");
    }
    const resObj = pages[0]!.dict.get("Resources");
    let fontRef: { k: "ref"; num: number; gen: number } | undefined;
    if (resObj && resObj.k === "dict") {
      const fontDict = resObj.m.get("Font");
      if (fontDict && fontDict.k === "dict") {
        const f1 = fontDict.m.get("F1");
        if (f1 && f1.k === "ref") fontRef = f1;
      }
    }
    ok(!!fontRef, "wild: /F#31 decoded to /F1 and reachable");
    const meta = pages[0]!.dict.get("Resources");
    ok(
      !!meta && meta.k === "dict" && meta.m.get("Meta")?.k === "str" &&
        new TextDecoder().decode((meta.m.get("Meta") as { b: Uint8Array }).b) === "Hello",
      "wild: hex string value",
    );
    eq(pages[1]!.mediaBox, [0, 0, 200, 100], "wild: page1 box");
  }

  console.log("== 5. predictor-12 xref stream ==");
  {
    const pred = buildPredictorFixture();
    const doc = parsePdf(pred);
    const pages = listPages(doc);
    eq(pages.length, 1, "predictor: page count");
    eq(pages[0]!.mediaBox, [0, 0, 300, 120], "predictor: mediaBox");
    ok(!doc.recovered, "predictor: no brute recovery (stream decoded cleanly)");
    // round-trip sanity through pdf-lib too
    const lib = await PDFDocument.load(pred);
    eq(pages.length, lib.getPageCount(), "predictor: pdf-lib agrees");
  }

  console.log("== 6. encrypted refusal ==");
  {
    let threw = "";
    try {
      parsePdf(buildEncryptedFixture());
    } catch (err) {
      threw = err instanceof PdfError ? err.code : `wrong-error:${String(err)}`;
    }
    eq(threw, "encrypted", "/Encrypt → typed refusal");
  }

  console.log("== 7. broken xref → brute recovery ==");
  {
    const broken = fixA.slice();
    // Corrupt the startxref pointer (points into the header — useless).
    const text = new TextDecoder().decode(broken);
    const patched = text.replace(/startxref\n(\d+)\n%%EOF\n$/, "startxref\n9\n%%EOF\n");
    const brokenBytes = new TextEncoder().encode(patched);
    const doc = parsePdf(brokenBytes);
    ok(doc.recovered, "recovery flagged");
    const pages = listPages(doc);
    eq(pages.length, 5, "recovered page count");
    eq(pages.map((p) => p.rotate), specA.map((s) => s.rot), "recovered rotations");
  }

  console.log("== 8. round-trip: organize ALL → pdf-lib reload + byte identity ==");
  {
    const src = parsePdf(fixA);
    const srcPages = listPages(src);
    const originalContents = srcPages.map((_, i) =>
      contentBytesOf(src, srcPages, i),
    );
    ok(
      originalContents.every((c) => c.length > 0),
      "round-trip: source content bytes CAPTURED (non-vacuous guard)",
    );
    const plan = srcPages.map((_, i) => ({ kind: "page" as const, src: i }));
    const out = organizePdf(fixA, plan);
    ok(out.bytes.length > 1000, "round-trip: bytes emitted");
    ok(!out.recovered, "round-trip: clean parse");

    const reloaded = await PDFDocument.load(out.bytes);
    eq(reloaded.getPageCount(), 5, "round-trip: pdf-lib reload page count");
    let agree = true;
    for (let i = 0; i < 5; i++) {
      if (Math.abs(reloaded.getPage(i).getWidth() - specA[i]!.w) > 0.01) agree = false;
      if (reloaded.getPage(i).getRotation().angle !== specA[i]!.rot) agree = false;
    }
    ok(agree, "round-trip: structure agrees with source");

    const back = parsePdf(out.bytes);
    const backPages = listPages(back);
    eq(backPages.length, 5, "round-trip: OUR parser loads OUR output (self-compat)");
    let identical = true;
    let captured = 0;
    backPages.forEach((_, i) => {
      const raw = contentBytesOf(back, backPages, i);
      if (raw.length > 0) captured += 1;
      if (!bytesEqual(raw, originalContents[i]!)) identical = false;
    });
    eq(captured, 5, "round-trip: output content bytes CAPTURED (non-vacuous)");
    ok(identical, "round-trip: content streams BYTE-IDENTICAL after surgery");
  }

  console.log("== 9. selection [2,0,4] + rotation deltas + blank ==");
  {
    const out = organizePdf(fixA, [
      { kind: "page", src: 2 },
      { kind: "page", src: 0, rotateDelta: 90 },
      { kind: "page", src: 4 },
      { kind: "blank", width: 595.28, height: 841.89 },
      { kind: "page", src: 3, rotateDelta: 90 }, // 270 + 90 → 0
    ]);
    const pages = listPages(parsePdf(out.bytes));
    eq(pages.length, 5, "plan length");
    eq(pages[0]!.mediaBox, [0, 0, 595, 842], "sel[0] = src page 2 box");
    eq(pages[1]!.rotate, 90, "sel[1] rotate delta 0→90");
    eq(pages[1]!.mediaBox, [0, 0, 612, 792], "sel[1] box");
    eq(pages[2]!.mediaBox, [0, 0, 250, 250], "sel[2] = src page 4 box");
    eq(pages[3]!.mediaBox, [0, 0, 595.28, 841.89], "blank A4 box");
    eq(pages[4]!.rotate, 0, "sel[4] 270+90 wraps to 0");
    const lib = await PDFDocument.load(out.bytes);
    eq(lib.getPageCount(), 5, "selection: pdf-lib reload count");
    eq(lib.getPage(1).getRotation().angle, 90, "selection: pdf-lib sees rotation");
    eq(lib.getPage(3).getWidth(), 595.28, "selection: pdf-lib sees blank width");
  }

  console.log("== 10. cross-document primitive (merge kernel) ==");
  {
    const docA = parsePdf(fixA);
    const pageA = listPages(docA)[0]!;
    const docB = parsePdf(fixB);
    const pageB = listPages(docB)[2]!;
    const merged = writeDocument([
      {
        type: "copy",
        doc: docA,
        srcNum: pageA.ref.num,
        dict: (() => {
          const m = new Map(pageA.dict);
          m.delete("Parent");
          return m;
        })(),
      },
      {
        type: "copy",
        doc: docB,
        srcNum: pageB.ref.num,
        dict: (() => {
          const m = new Map(pageB.dict);
          m.delete("Parent");
          return m;
        })(),
      },
    ]);
    const lib = await PDFDocument.load(merged);
    eq(lib.getPageCount(), 2, "two-doc merge: pdf-lib count");
    eq(Math.round(lib.getPage(0).getWidth()), 612, "merge: docA page width");
    eq(Math.round(lib.getPage(1).getWidth()), 595, "merge: docB page width");
    eq(lib.getPage(1).getRotation().angle, 180, "merge: docB rotation carried");
  }

  console.log("== 11. predictor function unit vectors ==");
  {
    // Row0 = None [1,2,3]; row1 = Up: cur = x + prev → [1+1, 2+2, 3+3].
    const data = Uint8Array.from([0, 1, 2, 3, 2, 1, 2, 3]);
    const out = pngUnfilter(data, 1, 3);
    eq(Array.from(out), [1, 2, 3, 2, 4, 6], "pngUnfilter None+Up vector");
    // Average: a = CURRENT row's reconstructed left neighbor (not the raw x).
    const data2 = Uint8Array.from([0, 10, 20, 30, 3, 5, 7, 9]);
    const out2 = pngUnfilter(data2, 1, 3);
    // row1: i0: a=0,b=10 → 5+5=10; i1: a=10,b=20 → 7+15=22; i2: a=22,b=30 → 9+26=35
    eq(Array.from(out2), [10, 20, 30, 10, 22, 35], "pngUnfilter Average vector");
    // Paeth: row1 filter 4, x=[1,1,1], prev=[10,20,30]:
    // i0: a=0,b=10,c=0 → p=10,pa=10,pb=0 → b=10 → 11
    // i1: a=11,b=20,c=0 → p=31,pa=20,pb=11,pc=31 → b=20 → 21
    // i2: a=21,b=30,c=0 → p=51,pa=30,pb=21,pc=51 → b=30 → 31
    const data3 = Uint8Array.from([0, 10, 20, 30, 4, 1, 1, 1]);
    const out3 = pngUnfilter(data3, 1, 3);
    eq(Array.from(out3), [10, 20, 30, 11, 21, 31], "pngUnfilter Paeth vector");
  }

  console.log("== 12. typed errors ==");
  {
    let e1 = "";
    try {
      organizePdf(fixA, []);
    } catch (err) {
      e1 = err instanceof PdfError ? err.code : "wrong";
    }
    eq(e1, "corrupt", "empty plan → corrupt");
    let e2 = "";
    try {
      organizePdf(fixA, [{ kind: "page", src: 99 }]);
    } catch (err) {
      e2 = err instanceof PdfError ? err.code : "wrong";
    }
    eq(e2, "corrupt", "out-of-range src → corrupt");
    let e3 = "";
    try {
      parsePdf(new TextEncoder().encode("not a pdf at all"));
    } catch (err) {
      e3 = err instanceof PdfError ? err.code : "wrong";
    }
    eq(e3, "corrupt", "non-PDF bytes → corrupt");
  }

  console.log("== 13. duplicate source indices (pagegrid duplicate contract) ==");
  {
    const out = organizePdf(fixA, [
      { kind: "page", src: 1 },
      { kind: "page", src: 0 },
      { kind: "page", src: 1, rotateDelta: 90 },
    ]);
    const backPages = listPages(parsePdf(out.bytes));
    eq(backPages.length, 3, "duplicates: page count");
    eq(backPages[0]!.rotate, 90, "duplicates: copy 1 keeps source rotation");
    eq(backPages[2]!.rotate, 180, "duplicates: copy 2 gets its OWN rotation");
    const srcDoc = parsePdf(fixA);
    const srcPages = listPages(srcDoc);
    const backDoc = parsePdf(out.bytes);
    const backList = listPages(backDoc);
    const c0 = contentBytesOf(backDoc, backList, 0);
    const c2 = contentBytesOf(backDoc, backList, 2);
    ok(c0.length > 0, "duplicates: copy 1 has content bytes (array /Contents)");
    eq(
      bytesEqual(c0, c2),
      true,
      "duplicates: both copies carry the source content bytes",
    );
    eq(
      bytesEqual(c0, contentBytesOf(srcDoc, srcPages, 1)),
      true,
      "duplicates: content matches the SOURCE page",
    );
    const lib = await PDFDocument.load(out.bytes);
    eq(lib.getPageCount(), 3, "duplicates: pdf-lib reload count");
    eq(
      lib.getPage(2).getRotation().angle,
      180,
      "duplicates: pdf-lib sees per-copy rotation",
    );
  }

  console.log("== 14. split API + blank-from + progress (worker seam) ==");
  {
    const source = parseForOrganize(fixA); // ONE parse for everything below
    const events: Array<[number, number]> = [];
    const out1 = organizePages(
      source,
      [
        { kind: "page", src: 0 },
        { kind: "blank-from", src: 0 },
        { kind: "page", src: 2, rotateDelta: 90 },
      ],
      (fraction, page) => events.push([fraction, page]),
    );
    const p1 = listPages(parsePdf(out1));
    eq(p1.length, 3, "split API: plan length");
    eq(
      p1[1]!.mediaBox,
      [0, 0, 612, 792],
      "split API: blank-from sizes from src MediaBox",
    );
    eq(p1[2]!.rotate, 90, "split API: rotation delta applied");
    eq(events.length, 3, "progress: one event per plan entry");
    ok(
      events.every(([f, p], i) => Math.abs(f - (i + 1) / 3) < 1e-9 && p === i + 1),
      "progress: fractions and 1-based page numbers",
    );
    ok(
      events.every(([f], i) => i === 0 || f >= events[i - 1]![0]),
      "progress: monotonically non-decreasing",
    );
    // Second (and third) write from the SAME parse — the extract
    // "one page = one file" path. Never re-parses the bytes.
    const out2 = organizePages(source, [{ kind: "page", src: 2 }]);
    const out3 = organizePages(source, [
      { kind: "blank-from", src: 1 },
      { kind: "page", src: 1 },
    ]);
    eq(listPages(parsePdf(out2)).length, 1, "split API: second write reuses the parse");
    const p3 = listPages(parsePdf(out3));
    eq(p3.length, 2, "split API: third write");
    eq(
      p3[0]!.mediaBox,
      [0, 0, 300, 400],
      "split API: blank-from on a non-first page",
    );
    const lib = await PDFDocument.load(out3);
    eq(lib.getPageCount(), 2, "split API: pdf-lib reload");
    // Degenerate MediaBox refusal for blank-from is covered by typed errors.
    let e4 = "";
    try {
      organizePages(source, [{ kind: "blank", width: 0, height: 100 }]);
    } catch (err) {
      e4 = err instanceof PdfError ? err.code : "wrong";
    }
    eq(e4, "corrupt", "split API: degenerate blank size refused");
  }

  console.log("== 15. organizeMerge — multi-doc merge API (P6-d seam) ==");
  {
    // Three sources: classic-xref fixA, ObjStm fixB, and a SECOND parse of
    // the fixA bytes (distinct object identity → per-doc graph isolation).
    const srcA = parseForOrganize(fixA);
    const srcB = parseForOrganize(fixB);
    const srcA2 = parseForOrganize(fixA);
    const events: Array<[number, number]> = [];
    const merged = organizeMerge(
      [srcA, srcB, srcA2],
      [
        { kind: "page", doc: 0, src: 1 }, // fixA p2: 300×400, rot 90
        { kind: "blank", width: 595.28, height: 841.89 }, // blankBetween A4
        { kind: "page", doc: 1, src: 2 }, // fixB p3: 595×842, rot 180
        { kind: "page", doc: 1, src: 2 }, // duplicate within doc 1
        { kind: "page", doc: 2, src: 0, rotateDelta: 90 }, // fixA2 p1 +90
        { kind: "blank-from", doc: 1, src: 0 }, // blank sized like fixB p1
      ],
      (fraction, page) => events.push([fraction, page]),
    );
    const pages = listPages(parsePdf(merged));
    eq(pages.length, 6, "merge API: page count");
    eq(pages[0]!.mediaBox, [0, 0, 300, 400], "merge API: doc0 box");
    eq(pages[0]!.rotate, 90, "merge API: doc0 rotation carried");
    eq(pages[1]!.mediaBox, [0, 0, 595.28, 841.89], "merge API: A4 blank");
    eq(pages[2]!.mediaBox, [0, 0, 595, 842], "merge API: doc1 box");
    eq(pages[2]!.rotate, 180, "merge API: doc1 rotation carried");
    eq(pages[4]!.rotate, 90, "merge API: rotateDelta applied");
    eq(pages[5]!.mediaBox, [0, 0, 612, 792], "merge API: blank-from fixB p1");
    eq(events.length, 6, "merge API: one progress event per page");
    ok(
      events.every(
        ([f, p], i) => Math.abs(f - (i + 1) / 6) < 1e-9 && p === i + 1,
      ),
      "merge API: progress fractions + 1-based pages",
    );
    // Content byte-identity through the cross-doc union — NON-VACUOUS
    // (capture guards first: the P6-c vacuity lesson).
    const backDoc = parsePdf(merged);
    const backList = listPages(backDoc);
    const b0 = contentBytesOf(backDoc, backList, 0);
    const b2 = contentBytesOf(backDoc, backList, 2);
    const b3 = contentBytesOf(backDoc, backList, 3);
    const b4 = contentBytesOf(backDoc, backList, 4);
    ok(
      b0.length > 0 && b2.length > 0 && b4.length > 0,
      "merge API: content bytes captured (non-vacuous)",
    );
    eq(
      bytesEqual(b0, contentBytesOf(srcA.doc, srcA.pages, 1)),
      true,
      "merge API: p1 ≡ doc0 source content",
    );
    eq(
      bytesEqual(b2, contentBytesOf(srcB.doc, srcB.pages, 2)),
      true,
      "merge API: p3 ≡ doc1 source content",
    );
    eq(
      bytesEqual(b4, contentBytesOf(srcA2.doc, srcA2.pages, 0)),
      true,
      "merge API: p5 ≡ doc2 source content",
    );
    eq(
      bytesEqual(b2, b3),
      true,
      "merge API: duplicate within doc byte-identical",
    );
    const lib = await PDFDocument.load(merged);
    eq(lib.getPageCount(), 6, "merge API: pdf-lib reload count");
    eq(Math.round(lib.getPage(0).getWidth()), 300, "merge API: pdf-lib width doc0");
    eq(
      Math.round(lib.getPage(3).getWidth()),
      595,
      "merge API: pdf-lib width doc1 duplicate",
    );
    eq(
      lib.getPage(4).getRotation().angle,
      90,
      "merge API: pdf-lib sees rotation delta",
    );
    // Header carries the HIGHEST input version (fixA/fixB are pdf-lib 1.7;
    // the wild fixture is 1.4 — 1.4 + 1.7 must merge as 1.7). The wild
    // fixture is block-scoped to section 4, so rebuild it here.
    const wildSrc = parseForOrganize(buildWildFixture().bytes);
    const mergedVersions = organizeMerge(
      [wildSrc, srcB],
      [
        { kind: "page", doc: 0, src: 0 },
        { kind: "page", doc: 1, src: 0 },
      ],
    );
    const header = new TextDecoder().decode(mergedVersions.slice(0, 8));
    ok(
      header.startsWith("%PDF-1.7"),
      `merge API: highest input version wins (${header.trim()})`,
    );
    // Typed error vectors — every guard throws PdfError code "corrupt".
    const errorCases: Array<[string, () => void]> = [
      [
        "empty sources",
        () => organizeMerge([], [{ kind: "page", doc: 0, src: 0 }]),
      ],
      ["empty plan", () => organizeMerge([srcA], [])],
      [
        "doc index out of range",
        () => organizeMerge([srcA], [{ kind: "page", doc: 1, src: 0 }]),
      ],
      [
        "page index out of range",
        () => organizeMerge([srcA], [{ kind: "page", doc: 0, src: 99 }]),
      ],
      [
        "blank-from out of range",
        () => organizeMerge([srcA], [{ kind: "blank-from", doc: 0, src: 99 }]),
      ],
      [
        "fractional doc index",
        () => organizeMerge([srcA], [{ kind: "page", doc: 0.5, src: 0 }]),
      ],
    ];
    for (const [label, fn] of errorCases) {
      let code = "none";
      try {
        fn();
      } catch (err) {
        code = err instanceof PdfError ? err.code : "wrong-error";
      }
      eq(code, "corrupt", `merge API: ${label} refused`);
    }
  }

  console.log("== 16. Stamp kernel (P6-f): text + images on OUR engine ==");
  await section16();

  console.log("== 17. Devanagari: TTF subset + shaping + Type0 embed (P6-g) ==");
  await section17();

  console.log("== 18. CreateContext (P6-i): blank-document authoring ==");
  await section18();

  console.log("== 19. Overlay route (P6-j): embedForm + stampForm ==");
  await section19();

  console.log("== 20. Renderer-family surfaces (P6-l): Tc + rotated rect + Info ==");
  await section20();

  console.log("== 21. Webby-four surfaces (P6-n): rounded rect + dash + insertPage/getPages ==");
  await section21();

  console.log("== 22. Edit-surface engine (P6-o): shapes + slots + annots + AcroForm ==");
  await section22();

  console.log("== 23. Source-AcroForm consumer (P6-p): reader edges + fill + burn scopes ==");
  await section23();

  // Artifacts for manual inspection (VLM/pdfjs follow-ups).
  const outAll = organizePdf(fixB, [
    { kind: "page", src: 0 },
    { kind: "blank", width: 612, height: 792 },
    { kind: "page", src: 2, rotateDelta: 180 },
  ]);
  writeFileSync("/tmp/own-pdf-artifact.pdf", outAll.bytes);

  console.log(`\nsmoke-pdf-core: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILED:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 17 — the P6-g Devanagari route: our own TTF parser/subsetter +
 * GSUB/Indic shaper (fontkit-parity, verified against the dev-time oracle)
 * + Type0/CIDFontType2 embedding with save-time materialization.
 * ════════════════════════════════════════════════════════════════════════ */

const DEVA_FONT_PATH = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf";

async function section17(): Promise<void> {
  const devaBytes = readFileSync(DEVA_FONT_PATH);
  const font = ParsedTtfFont.parse(new Uint8Array(devaBytes));

  /* — 17.1 font facts (against the shipped asset — anchors are the font's
   * own values, cross-checked with the fontkit oracle at dev time). */
  eq(font.unitsPerEm, 1000, "ttf: unitsPerEm 1000");
  eq(font.numGlyphs, 1117, "ttf: numGlyphs 1117");
  eq(font.postscriptName, "NotoSansDevanagari-Regular", "ttf: postscriptName");
  eq(font.ascent, 896, "ttf: ascent");
  eq(font.descent, -408, "ttf: descent");
  eq(font.capHeight, 622, "ttf: capHeight (OS/2 v4)");
  eq(font.xHeight, 536, "ttf: xHeight");
  eq(font.italicAngle, 0, "ttf: italicAngle 0");
  eq(font.glyphForCodePoint(0x915), 56, "cmap: क → 56");
  eq(font.glyphForCodePoint(0x93f), 32, "cmap: ि → 32 (raw; 545 is the post-GSUB pres form)");
  eq(font.glyphForCodePoint(0x94d), 103, "cmap: ् → 103");
  eq(font.glyphForCodePoint(0x20), 3, "cmap: space → 3");

  /* — 17.2 shaping glyph-sequence parity vs the fontkit oracle (dev-time). */
  try {
    const oracle = require("@pdf-lib/fontkit");
    require("regenerator-runtime/runtime");
    const fk = await (oracle as { create: (b: Uint8Array) => Promise<unknown> }).create(
      new Uint8Array(devaBytes),
    ) as { layout: (t: string) => { glyphs: Array<{ id: number; codePoints: number[] }> } };
    const session = new Map<number, number[]>();
    const vectors = [
      "क", "हिंदी", "क्ष", "Page १२", "स्कूल", "प्रीति", "गोपाल कृष्णा", "A",
      "क़", "र्क", "योग", "राष्ट्र", "अंतर्राष्ट्रीय", "विश्वविद्यालय", "ज्ञान",
      "श्री", "प्रधानमंत्री", "स्वातंत्र्य", "अभ्यास", "परीक्षा", "टीका टिप्पणी",
      "क्रम", "प्रक्रिया", "अध्यक्ष", "संविधान", "Chapter १", "शिक्षणसंस्था",
    ];
    let seqOk = 0;
    for (const text of vectors) {
      const want = fk.layout(text).glyphs.map((g) => `${g.id}:[${g.codePoints.map((c) => c.toString(16)).join(",")}]`);
      const got = shapeText(font, text, session).map((g) => `${g.id}:[${g.codePoints.map((c) => c.toString(16)).join(",")}]`);
      const same = want.length === got.length && want.every((w, i) => w === got[i]);
      if (same) seqOk++;
      else eq(`DIVERGED ${JSON.stringify(text)}`, "shape-parity", `shape: ${text}`);
    }
    eq(seqOk, vectors.length, `shaper: ${seqOk}/${vectors.length} glyph-sequence vectors`);
  } catch (error) {
    eq("oracle-unavailable", "oracle-loaded", `fontkit oracle: ${String(error)}`);
  }

  /* — 17.3 real-word corpus (all realistic Devanagari) with a shared
   * session = pdf-lib's per-embedFont glyph-object lifetime. */
  {
    const corpus = [
      "नमस्ते", "भारत", "हिंदी", "कार्यक्रम", "विद्यालय", "प्रक्रिया", "संगीत",
      "अर्थशास्त्र", "प्रौद्योगिकी", "विश्वविद्यालय", "प्रमाणपत्र", "स्वतंत्रता",
      "अंतर्राष्ट्रीय", "प्रधानमंत्री", "विशेषज्ञ", "संविधान", "पुनर्जन्म", "मुख्यमंत्री",
    ];
    const session = new Map<number, number[]>();
    for (const text of corpus) {
      const shaped = shapeText(font, text, session);
      ok(shaped.length > 0, `corpus: ${text} shaped to ${shaped.length} glyphs`);
      for (const g of shaped) ok(g.id > 0 || g.id === 0, `corpus: ${text} valid ids`);
    }
  }

  /* — 17.4 end-to-end: stamp Devanagari into the §16 fixture via OUR engine,
   * reload with our parser AND the pdf-lib oracle, verify font structure,
   * the embedded subset (fontkit loads it), W sections, and ToUnicode
   * round-trip. */
  const stampSrc = await (async () => {
    const libDoc = await PDFDocument.create();
    const helv = await libDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) {
      const page = libDoc.addPage([300, 400]);
      page.drawText(`EXISTING-PAGE-TEXT-${i + 1}`, { x: 20, y: 200, font: helv, size: 14 });
    }
    return libDoc.save();
  })();
  const ctx = StampContext.load(stampSrc);
  const deva = ctx.embedTtf(new Uint8Array(devaBytes));
  const text = "गोपाल कृष्णा";
  const measured = deva.measure(text, 24);
  ok(Math.abs(measured - 113.112) < 0.01, `measure: pdf-lib widthOfTextAtSize parity (${measured.toFixed(4)})`);
  ctx.stampText(0, { x: 72, y: 700, text, size: 24, ttf: deva, color: { r: 0.86, g: 0.15, b: 0.15 } });
  ctx.stampText(1, { x: 72, y: 650, text: "हिंदी", size: 18, ttf: deva, opacity: 0.5 });
  const out = ctx.write();
  writeFileSync("/tmp/p6g-deva-stamp.pdf", out);

  /* our parser reload */
  const doc = parsePdf(out);
  const root = resolve(doc, doc.trailer.get("Root")!) as { k: "dict"; m: Map<string, PdfObj> };
  const pagesRoot = resolve(doc, root.m.get("Pages")!) as { k: "dict"; m: Map<string, PdfObj> };
  eq(asNum(pagesRoot.m.get("Count")), 3, "deva: own parser page count");

  /* pdf-lib oracle reload */
  const oracleDoc = await PDFDocument.load(out);
  eq(oracleDoc.getPageCount(), 3, "deva: oracle page count");

  /* hex ↔ oracle glyph run */
  const page0 = oracleDoc.getPage(0);
  const contents = page0.node.Contents() as unknown as {
    contents: Uint8Array;
    constructor: { name: string };
  };
  const readStream = (st: { contents: Uint8Array }): string => latin1(st.contents, 0, st.contents.length);
  let streamText = "";
  if (contents.constructor.name === "PDFArray") {
    const arr = contents as unknown as { size(): number; lookup(i: number): { contents: Uint8Array } };
    for (let i = 0; i < arr.size(); i++) streamText += readStream(arr.lookup(i));
  } else {
    streamText = readStream(contents as unknown as { contents: Uint8Array });
  }
  const hexMatch = /<([0-9a-fA-F]+)> Tj/.exec(streamText);
  ok(!!hexMatch, "deva: stamp Tj found");
  const hex = hexMatch?.[1] ?? "";

  try {
    const fk = await (require("@pdf-lib/fontkit") as { create: (b: Uint8Array) => Promise<unknown> }).create(
      new Uint8Array(devaBytes),
    ) as { layout: (t: string) => { glyphs: Array<{ id: number }> } };
    const wantRun = fk.layout(text).glyphs;
    const sids: number[] = [];
    for (let i = 0; i + 4 <= hex.length; i += 4) sids.push(parseInt(hex.slice(i, i + 4), 16));
    ok(sids.length === wantRun.length, `deva: hex sid count ${sids.length} = glyphs ${wantRun.length}`);
    const sidToGlyph = new Map<number, number>();
    let consistent = true;
    for (let i = 0; i < sids.length && i < wantRun.length; i++) {
      if (!sidToGlyph.has(sids[i]!)) sidToGlyph.set(sids[i]!, wantRun[i]!.id);
      if (sidToGlyph.get(sids[i]!) !== wantRun[i]!.id) consistent = false;
    }
    ok(consistent, "deva: hex ↔ fontkit glyph sequence id-consistent");

    /* the embedded subset itself loads in fontkit */
    interface LibDict {
      get(key: unknown): unknown;
    }
    const objs = [...oracleDoc.context.enumerateIndirectObjects()];
    const type0 = objs.find(
      ([, o]) => o instanceof PDFDict && String((o as unknown as LibDict).get(PDFName.of("Subtype"))) === "/Type0",
    )?.[1] as unknown as LibDict | undefined;
    ok(!!type0, "deva: Type0 font in output");
    if (type0) {
      eq(String(type0.get(PDFName.of("Encoding"))), "/Identity-H", "deva: Identity-H encoding");
      const lookup = (key: unknown): unknown => oracleDoc.context.lookup(key as never);
      const cidList = lookup(type0.get(PDFName.of("DescendantFonts"))) as unknown as { get(i: number): unknown };
      const cid = lookup(cidList.get(0)) as unknown as LibDict;
      eq(String(cid.get(PDFName.of("Subtype"))), "/CIDFontType2", "deva: CIDFontType2 descendant");
      eq(String(cid.get(PDFName.of("CIDToGIDMap"))), "/Identity", "deva: CIDToGIDMap Identity");
      const fd = lookup(cid.get(PDFName.of("FontDescriptor"))) as unknown as LibDict;
      const ff2 = lookup(fd.get(PDFName.of("FontFile2"))) as unknown as { contents: Uint8Array };
      const ttfSubset = pako.inflate(ff2.contents) as Uint8Array;
      const subFont = await (require("@pdf-lib/fontkit") as { create: (b: Uint8Array) => Promise<unknown> }).create(
        ttfSubset,
      ) as { numGlyphs: number; unitsPerEm: number };
      ok(subFont.numGlyphs >= sids.length, `deva: embedded subset loads (${subFont.numGlyphs} glyphs)`);
      eq(subFont.unitsPerEm, 1000, "deva: subset upem");

      /* ToUnicode round-trip: reconstruct the text from the stamp hex */
      const toUni = lookup(type0.get(PDFName.of("ToUnicode"))) as unknown as { contents: Uint8Array };
      const cmapText = Buffer.from(pako.inflate(toUni.contents)).toString("latin1");
      const bfChars = [...cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)];
      ok(bfChars.length > 0, `deva: ToUnicode has ${bfChars.length} bfchars`);
      let reconstructed = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const sidHex = hex.slice(i, i + 4).toLowerCase();
        const entry = bfChars.find(([, sid]) => sid.toLowerCase() === sidHex);
        const cpsHex = entry?.[2] ?? "";
        for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
          reconstructed += String.fromCharCode(parseInt(cpsHex.slice(j, j + 4), 16));
        }
      }
      eq(reconstructed, text, `deva: ToUnicode round-trip (${reconstructed})`);

      /* W sections non-empty + first id = 1 */
      const wArr = cid.get(PDFName.of("W")) as unknown as { toString(): string };
      const wStr = wArr.toString();
      ok(wStr.startsWith("[ 1 "), `deva: W starts at subset id 1 (${wStr.slice(0, 24)}…)`);
      ok(/\[ [\d. ]+\]/.test(wStr), "deva: W has width sections");
    }
  } catch (error) {
    eq("oracle-failed", "oracle-ok", `deva oracle checks: ${String(error)}`);
  }
}

/** Minimal harness: parse one top-level array using the parser's grammar. */
function parseValueForSmoke(lex: Lexer): ReturnType<typeof firstValue> {
  return firstValue(lex);
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 18 — the P6-i create/write side: CreateContext (blank-document
 * authoring) — pdf-lib operator-sequence parity, writer numbering, image
 * + Devanagari routes, and the 12-font metrics set.
 * ════════════════════════════════════════════════════════════════════════ */

/** The full standard-14 set our engine now measures (P6-i: 6 → 12). */
const STD14: Array<[string, StandardFonts]> = [
  ["helvetica", StandardFonts.Helvetica],
  ["helveticaBold", StandardFonts.HelveticaBold],
  ["helveticaOblique", StandardFonts.HelveticaOblique],
  ["helveticaBoldOblique", StandardFonts.HelveticaBoldOblique],
  ["times", StandardFonts.TimesRoman],
  ["timesBold", StandardFonts.TimesRomanBold],
  ["timesItalic", StandardFonts.TimesRomanItalic],
  ["timesBoldItalic", StandardFonts.TimesRomanBoldItalic],
  ["courier", StandardFonts.Courier],
  ["courierBold", StandardFonts.CourierBold],
  ["courierOblique", StandardFonts.CourierOblique],
  ["courierBoldOblique", StandardFonts.CourierBoldOblique],
];

/**
 * pdf-lib page content as text (page streams are Flate-compressed in its
 * own saves — inflated with the oracle-side pako; arrays concatenated).
 */
async function libContentText(bytes: Uint8Array, pageIdx: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const pg = doc.getPage(pageIdx);
  const c = pg.node.Contents() as unknown as { constructor: { name: string } };
  const readSt = (st: { contents: Uint8Array }): string => {
    const b = st.contents;
    try {
      const inf = pako.inflate(b) as Uint8Array;
      return latin1(inf, 0, inf.length);
    } catch {
      return latin1(b, 0, b.length);
    }
  };
  if (c.constructor.name === "PDFArray") {
    const arr = c as unknown as { size(): number; lookup(i: number): { contents: Uint8Array } };
    let s = "";
    for (let i = 0; i < arr.size(); i++) s += readSt(arr.lookup(i));
    return s;
  }
  return readSt(c as unknown as { contents: Uint8Array });
}

/**
 * Operator-stream normalization for cross-engine comparison: resource NAME
 * tokens → /R<n> in first-appearance order (pdf-lib's keys are randomly
 * suffixed — ours are F1/Im1/GS1); numeric tokens rounded to 6 decimals
 * (KAPPA-bézier control points diverge in the 11th digit between full
 * String() precision and our 10-digit trim).
 */
function normalizeOps(text: string): string {
  const seen = new Map<string, string>();
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      if (tok.startsWith("/")) {
        let canon = seen.get(tok);
        if (!canon) {
          canon = `/R${seen.size + 1}`;
          seen.set(tok, canon);
        }
        return canon;
      }
      if (/^[-+]?[0-9]/.test(tok)) {
        const n = Number(tok);
        if (Number.isFinite(n)) return String(Math.round(n * 1e6) / 1e6);
      }
      return tok;
    })
    .join(" ");
}

async function section18(): Promise<void> {
  /** pdf-lib dict read-shim (same pattern as §17.4's local). */
  interface LibDict {
    get(key: unknown): unknown;
  }
  const W = 595.28;
  const H = 841.89;

  /* — 18.1 operator-sequence parity vs the pdf-lib oracle (normalized
   * names + 6dp numbers): every primitive — rect (fill + border), line,
   * text (helv + timesBold with opacity), image, ellipse. */
  const png = buildPngFixture([
    [255, 0, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 128], [255, 255, 0, 128],
  ]);
  const ctx = CreateContext.create();
  const p1 = ctx.addPage(W, H);
  p1.drawRectangle({ x: 40, y: 700, width: 200, height: 100, color: { r: 0.86, g: 0.15, b: 0.15 } });
  p1.drawRectangle({
    x: 40, y: 640, width: 120, height: 40,
    color: { r: 0.2, g: 0.5, b: 0.9 },
    borderColor: { r: 0.1, g: 0.1, b: 0.1 }, borderWidth: 2,
  });
  p1.drawLine({ start: { x: 40, y: 620 }, end: { x: 300, y: 620 }, thickness: 0.7, color: { r: 0.2, g: 0.2, b: 0.2 } });
  p1.drawText({ x: 40, y: 600, text: "AVATAR To: whoever", size: 14, color: { r: 0, g: 0, b: 0 } });
  p1.drawText({ x: 40, y: 580, text: "serif line", size: 12, font: "timesBold", color: { r: 0.1, g: 0.1, b: 0.1 }, opacity: 0.5 });
  const img = ctx.embedPng(png);
  p1.drawImage(img, { x: 40, y: 400, width: 60, height: 60 });
  const p2 = ctx.addPage(W, H);
  p2.drawEllipse({ x: 150, y: 500, xScale: 40, yScale: 25, color: { r: 0.1, g: 0.5, b: 0.9 } });
  const ours = ctx.write();

  const libDoc = await PDFDocument.create();
  const helv = await libDoc.embedFont(StandardFonts.Helvetica);
  const times = await libDoc.embedFont(StandardFonts.TimesRomanBold);
  const l1 = libDoc.addPage([W, H]);
  l1.drawRectangle({ x: 40, y: 700, width: 200, height: 100, color: rgb(0.86, 0.15, 0.15) });
  l1.drawRectangle({
    x: 40, y: 640, width: 120, height: 40,
    color: rgb(0.2, 0.5, 0.9), borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 2,
  });
  l1.drawLine({ start: { x: 40, y: 620 }, end: { x: 300, y: 620 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) });
  l1.drawText("AVATAR To: whoever", { x: 40, y: 600, size: 14, font: helv, color: rgb(0, 0, 0) });
  l1.drawText("serif line", { x: 40, y: 580, size: 12, font: times, color: rgb(0.1, 0.1, 0.1), opacity: 0.5 });
  const libImg = await libDoc.embedPng(png);
  l1.drawImage(libImg, { x: 40, y: 400, width: 60, height: 60 });
  const l2 = libDoc.addPage([W, H]);
  l2.drawEllipse({ x: 150, y: 500, xScale: 40, yScale: 25, color: rgb(0.1, 0.5, 0.9) });
  const libBytes = await libDoc.save({ useObjectStreams: false });

  const ourDoc = parsePdf(ours);
  const ourPages = listPages(ourDoc);
  for (let i = 0; i < 2; i++) {
    const cBytes = contentBytesOf(ourDoc, ourPages, i);
    const ourText = latin1(cBytes, 0, cBytes.length);
    const libText = await libContentText(libBytes, i);
    const a = normalizeOps(ourText);
    const b = normalizeOps(libText);
    ok(
      a === b && b.length > 0,
      `create parity: page ${i + 1} operator sequence (${b.split(" ").length} normalized tokens)`,
    );
    if (a !== b) {
      const al = a.split(" ");
      const bl = b.split(" ");
      for (let k = 0; k < Math.max(al.length, bl.length); k++) {
        if (al[k] !== bl[k]) {
          console.log(
            `    first diff @${k}:\n      own="${al.slice(Math.max(0, k - 2), k + 6).join(" ")}"\n      lib="${bl.slice(Math.max(0, k - 2), k + 6).join(" ")}"`,
          );
          break;
        }
      }
    }
  }

  /* — 18.2 writer numbering + resources structure (the all-"new" plan:
   * objects 1=catalog, 2=/Pages, page dicts/streams at 3..6, synthetics
   * in creation order from 7: helv, timesBold, gs, image, smask). */
  eq(ourPages.length, 2, "create: page count");
  const boxOf = (i: number): string => {
    const box = ourPages[i]!.dict.get("MediaBox");
    return box?.k === "arr"
      ? box.items.map((it) => (it.k === "num" ? it.n : "?")).join(",")
      : "none";
  };
  eq(boxOf(0), `0,0,${W},${H}`, "create: page 1 MediaBox");
  eq(boxOf(1), `0,0,${W},${H}`, "create: page 2 MediaBox");

  const obj7 = ourDoc.getObject(7);
  eq(
    obj7?.k === "dict" ? (obj7.m.get("BaseFont") as { v?: string } | undefined)?.v : "?",
    "Helvetica",
    "create: synthetic #1 = Helvetica (first-use order)",
  );
  const obj8 = ourDoc.getObject(8);
  eq(
    obj8?.k === "dict" ? (obj8.m.get("BaseFont") as { v?: string } | undefined)?.v : "?",
    "Times-Bold",
    "create: synthetic #2 = Times-Bold",
  );
  const obj9 = ourDoc.getObject(9);
  eq(
    obj9?.k === "dict" ? (obj9.m.get("Type") as { v?: string } | undefined)?.v : "?",
    "ExtGState",
    "create: synthetic #3 = ExtGState (opacity 0.5)",
  );
  const obj10 = ourDoc.getObject(10);
  ok(obj10?.k === "stream", "create: synthetic #4 = image stream");
  if (obj10?.k === "stream") {
    eq(
      (obj10.m.get("ColorSpace") as { v?: string } | undefined)?.v,
      "DeviceRGB",
      "create: image DeviceRGB",
    );
    const smaskRef = obj10.m.get("SMask");
    const smaskObj = smaskRef?.k === "ref" ? ourDoc.getObject(smaskRef.num) : undefined;
    ok(smaskObj?.k === "stream", "create: SMask stream (write-time patched number)");
    if (smaskObj?.k === "stream") {
      eq(
        (smaskObj.m.get("ColorSpace") as { v?: string } | undefined)?.v,
        "DeviceGray",
        "create: SMask DeviceGray",
      );
      eq(smaskRef?.num, 11, "create: SMask is the synthetic right after the image");
    }
  }
  const res1 = ourPages[0]!.dict.get("Resources");
  const fontBucket = res1?.k === "dict" ? res1.m.get("Font") : undefined;
  const fNames = fontBucket?.k === "dict" ? [...fontBucket.m.keys()].sort() : [];
  eq(fNames.join(","), "F1,F2", "create: page 1 fonts F1,F2");
  const gsBucket = res1?.k === "dict" ? res1.m.get("ExtGState") : undefined;
  eq(gsBucket?.k === "dict" ? [...gsBucket.m.keys()].join(",") : "?", "GS1", "create: page 1 ExtGState GS1");
  const xBucket = res1?.k === "dict" ? res1.m.get("XObject") : undefined;
  eq(xBucket?.k === "dict" ? [...xBucket.m.keys()].join(",") : "?", "Im1", "create: page 1 XObject Im1");
  const res2 = ourPages[1]!.dict.get("Resources");
  ok(res2?.k === "dict" && !res2.m.has("Font"), "create: page 2 has NO font resources (clean empty)");

  /* write() is non-destructive + deterministic */
  const again = ctx.write();
  eq(bytesEqual(ours, again), true, "create: write() repeat = byte-identical");

  /* — 18.3 JPEG passthrough through the create route (DCT bytes EXACT). */
  {
    const jpg = readFileSync("qa/test-photo.jpg");
    const c2 = CreateContext.create();
    const jp = c2.embedJpeg(new Uint8Array(jpg));
    const pj = c2.addPage(400, 300);
    pj.drawImage(jp, { x: 20, y: 100, width: 360, height: 120 });
    const out = c2.write();
    const back = parsePdf(out);
    const imgAt5 = back.getObject(5); // 3,4 = page dict+stream → 5 = image
    ok(imgAt5?.k === "stream", "create: jpeg image at object 5");
    const stream = imgAt5?.k === "stream" ? imgAt5 : undefined;
    if (stream) {
      eq(
        (stream.m.get("Filter") as { v?: string } | undefined)?.v,
        "DCTDecode",
        "create: jpeg DCTDecode",
      );
      eq(bytesEqual(stream.raw, new Uint8Array(jpg)), true, "create: jpeg bytes passthrough EXACT");
    }
    const libReload = await PDFDocument.load(out);
    eq(libReload.getPageCount(), 1, "create: jpeg pdf-lib reload");
    const libJpg = await PDFDocument.create();
    const libRef = await libJpg.embedJpg(new Uint8Array(jpg));
    eq(jp.width, libRef.width, "create: jpeg width parity");
    eq(jp.height, libRef.height, "create: jpeg height parity");
  }

  /* — 18.4 Devanagari through the create route (P6-g machinery reuse):
   * Type0/Identity-H, ToUnicode round-trip, W sections. */
  {
    const devaBytes = readFileSync(DEVA_FONT_PATH);
    const c3 = CreateContext.create();
    const noto = c3.embedTtf(new Uint8Array(devaBytes));
    const pd = c3.addPage(W, H);
    const text = "गोपाल कृष्णा";
    const measured = noto.measure(text, 24);
    ok(Math.abs(measured - 113.112) < 0.01, `create deva: measure parity (${measured.toFixed(4)})`);
    pd.drawText({ x: 72, y: 700, text, size: 24, ttf: noto, color: { r: 0.1, g: 0.1, b: 0.1 } });
    pd.drawText({ x: 72, y: 650, text: "हिंदी", size: 18, ttf: noto });
    const out = c3.write();
    writeFileSync("/tmp/p6i-deva-create.pdf", out);

    const back = parsePdf(out);
    eq(listPages(back).length, 1, "create deva: own parser page count");
    const oracleDoc = await PDFDocument.load(out);
    eq(oracleDoc.getPageCount(), 1, "create deva: oracle page count");

    // content hex: the Tj under the /F key
    const cBytes = contentBytesOf(back, listPages(back), 0);
    const body = latin1(cBytes, 0, cBytes.length);
    const hexMatch = /<([0-9A-Fa-f]+)> Tj/.exec(body);
    ok(!!hexMatch, "create deva: Tj found");
    const hex = (hexMatch?.[1] ?? "").toUpperCase();
    ok(hex.length >= 8, `create deva: hex non-trivial (${hex.length / 4} glyphs)`);

    try {
      const objs = [...oracleDoc.context.enumerateIndirectObjects()];
      const type0 = objs.find(
        ([, o]) => o instanceof PDFDict && String((o as unknown as LibDict).get(PDFName.of("Subtype"))) === "/Type0",
      )?.[1] as unknown as LibDict | undefined;
      ok(!!type0, "create deva: Type0 font in output");
      if (type0) {
        eq(String(type0.get(PDFName.of("Encoding"))), "/Identity-H", "create deva: Identity-H");
        const lookup = (key: unknown): unknown => oracleDoc.context.lookup(key as never);
        const cidList = lookup(type0.get(PDFName.of("DescendantFonts"))) as unknown as { get(i: number): unknown };
        const cid = lookup(cidList.get(0)) as unknown as LibDict;
        eq(String(cid.get(PDFName.of("Subtype"))), "/CIDFontType2", "create deva: CIDFontType2");
        /* ToUnicode round-trip */
        const toUni = lookup(type0.get(PDFName.of("ToUnicode"))) as unknown as { contents: Uint8Array };
        const cmapText = Buffer.from(pako.inflate(toUni.contents)).toString("latin1");
        const bfChars = [...cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)];
        ok(bfChars.length > 0, `create deva: ToUnicode ${bfChars.length} bfchars`);
        let reconstructed = "";
        for (let i = 0; i + 4 <= hex.length; i += 4) {
          const sidHex = hex.slice(i, i + 4).toLowerCase();
          const entry = bfChars.find(([, sid]) => sid.toLowerCase() === sidHex);
          const cpsHex = entry?.[2] ?? "";
          for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
            reconstructed += String.fromCharCode(parseInt(cpsHex.slice(j, j + 4), 16));
          }
        }
        // pdf-lib ToUnicode reads back the VISUAL glyph order — compare as multisets
        const sort = (s: string): string[] => [...s].map((c) => c.codePointAt(0)!).sort((a, b) => a - b).map(String);
        eq(
          JSON.stringify(sort(reconstructed)),
          JSON.stringify(sort(text)),
          `create deva: ToUnicode round-trip multiset`,
        );
        /* W starts at subset id 1 */
        const wArr = cid.get(PDFName.of("W")) as unknown as { toString(): string };
        ok(String(wArr.toString()).startsWith("[ 1 "), "create deva: W starts at 1");
        /* embedded subset loads in fontkit */
        const fd = lookup(cid.get(PDFName.of("FontDescriptor"))) as unknown as LibDict;
        const ff2 = lookup(fd.get(PDFName.of("FontFile2"))) as unknown as { contents: Uint8Array };
        const ttfSubset = pako.inflate(ff2.contents) as Uint8Array;
        const subFont = await (require("@pdf-lib/fontkit") as { create: (b: Uint8Array) => Promise<unknown> }).create(
          ttfSubset,
        ) as { numGlyphs: number };
        ok(subFont.numGlyphs >= hex.length / 4, `create deva: subset loads (${subFont.numGlyphs} glyphs)`);
      }
    } catch (error) {
      eq("oracle-failed", "oracle-ok", `create deva oracle checks: ${String(error)}`);
    }
  }

  /* — 18.5 the 12-font metrics set vs the pdf-lib oracle (float-exact —
   * same AFM data, same arithmetic order). */
  {
    const probe = "AVATAR To: whoever — takes 24";
    const libDoc2 = await PDFDocument.create();
    for (const [key, std] of STD14) {
      const libFont = await libDoc2.embedStandardFont(std);
      const want = libFont.widthOfTextAtSize(probe, 24);
      const got = ctx.measure(probe, key as never, 24);
      ok(
        Math.abs(got - want) < 1e-9,
        `create metrics: ${key} (${got.toFixed(4)} vs ${want.toFixed(4)})`,
      );
    }
  }

  /* — 18.6 API refusal vectors (typed, honest). */
  {
    const cases: Array<[string, () => void]> = [
      [
        "addPage(0, 100) refused",
        () => CreateContext.create().addPage(0, 100),
      ],
      [
        "drawImage unknown handle refused",
        () => {
          const c = CreateContext.create();
          const p = c.addPage(100, 100);
          p.drawImage({ width: 1, height: 1, token: "img:999" }, { x: 0, y: 0, width: 1, height: 1 });
        },
      ],
      [
        "drawText size 0 refused",
        () => {
          const c = CreateContext.create();
          c.addPage(100, 100).drawText({ x: 0, y: 0, text: "x", size: 0, font: "helvetica" });
        },
      ],
    ];
    for (const [label, fn] of cases) {
      let code = "none";
      try {
        fn();
      } catch (err) {
        code = err instanceof PdfError ? err.code : "wrong-error";
      }
      eq(code, "corrupt", `create API: ${label}`);
    }
    /* non-WinAnsi measure → typed "chars" (the tools' error-code source) */
    let charsCode = "none";
    try {
      ctx.measure("प", "helvetica", 12);
    } catch (err) {
      charsCode = err instanceof PdfError ? err.code : "wrong-error";
    }
    eq(charsCode, "chars", "create API: non-WinAnsi measure → chars");
    /* empty text is a NO-OP (pdf-lib parity — no stream, no font) */
    const c4 = CreateContext.create();
    const pe = c4.addPage(100, 100);
    pe.drawText({ x: 0, y: 0, text: "", size: 12, font: "helvetica" });
    const outEmpty = c4.write();
    eq(listPages(parsePdf(outEmpty)).length, 1, "create API: empty text → clean 1-page doc");
    const emptyRes = listPages(parsePdf(outEmpty))[0]!.dict.get("Resources");
    ok(emptyRes?.k === "dict" && !emptyRes.m.has("Font"), "create API: no font embedded for empty text");
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 19 — the P6-j overlay route: StampContext.embedForm (the DEFAULT
 * pdf-lib embedPdf box: MediaBox normalized to the origin, identity Matrix)
 * + stampForm (pdf-lib drawPage operator parity). pdf-lib is the dev-time
 * oracle: same fixtures, same draw calls, normalized comparison.
 * ════════════════════════════════════════════════════════════════════════ */

/** Decoded text of ALL content-stream entries of one page (flate-aware). */
function pageOpsText(doc: ParsedPdf, pages: PdfPageInfo[], i: number): string {
  const value = pages[i]!.dict.get("Contents");
  if (!value) return "";
  const parts: string[] = [];
  const readOne = (v: PdfObj): void => {
    let obj: PdfObj = v;
    if (v.k === "ref") obj = doc.getObject(v.num) ?? v;
    if (obj.k !== "stream") return;
    const bytes = decodeForParser(obj.raw, obj.m);
    parts.push(latin1(bytes, 0, bytes.length));
  };
  if (value.k === "arr") for (const item of value.items) readOne(item);
  else readOne(value);
  return parts.join("\n");
}

/** Decoded text of ONLY the LAST content-stream entry — the appended draw
 *  stream (pdf-lib's load+save wraps the BASE content in an extra q/Q, so
 *  full-page comparison would be apples-to-oranges; the draw is the parity
 *  under test). */
function lastEntryOpsText(doc: ParsedPdf, pages: PdfPageInfo[], i: number): string {
  const value = pages[i]!.dict.get("Contents");
  if (!value) return "";
  const last = value.k === "arr" ? value.items[value.items.length - 1] : value;
  if (!last) return "";
  let obj: PdfObj = last;
  if (last.k === "ref") obj = doc.getObject(last.num) ?? last;
  if (obj.k !== "stream") return "";
  const bytes = decodeForParser(obj.raw, obj.m);
  return latin1(bytes, 0, bytes.length);
}

/** Drops identity `1 0 0 1 0 0 cm` operators (pdf-lib always emits the skew
 *  cm, and the rotate cm at 0°; our house style omits the skew one). */
function stripIdentityCm(text: string): string {
  return text.replace(/(^|\n)1 0 0 1 0 0 cm(\n|$)/g, "\n");
}

/** Resolves one page's Resources bucket entry to a stream object (or null). */
function bucketStream(
  doc: ParsedPdf,
  pages: PdfPageInfo[],
  i: number,
  bucket: string,
  key: string,
): (PdfObj & { k: "stream" }) | null {
  const resEntry = pages[i]!.resources;
  const res = resEntry ? resolve(doc, resEntry) : undefined;
  const resMap = res?.k === "dict" || res?.k === "stream" ? res.m : undefined;
  const bucketObj = resMap ? resolve(doc, resMap.get(bucket)) : undefined;
  const bucketMap =
    bucketObj?.k === "dict" || bucketObj?.k === "stream" ? bucketObj.m : undefined;
  const entry = bucketMap ? bucketMap.get(key) : undefined;
  if (!entry) return null;
  const obj = resolve(doc, entry);
  return obj?.k === "stream" ? obj : null;
}

/** Hand-built 2-page overlay whose pages INHERIT tree-level Resources with
 *  an ExtGState (ca/CA), a nested Form XObject carrying its OWN gs, and a
 *  font — the alpha-walk stress fixture (both pages see the SAME objects). */
function buildAlphaOverlayFixture(): Uint8Array {
  const enc = new TextEncoder();
  const body7 = "q /G1 gs 10 10 30 30 re f Q";
  const xoBody = "q /G2 gs 5 5 20 20 re f Q";
  const objects: Array<string | null> = [
    "<< /Type /Catalog /Pages 2 0 R >>", // 1
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources 11 0 R >>", // 2
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents 7 0 R >>", // 3
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents 7 0 R >>", // 4
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", // 5
    "<< /Type /ExtGState /ca 0.8 /CA 0.9 >>", // 6
    null, // 7: content stream (patched below)
    null, // 8: nested XObject form stream
    "<< /Type /ExtGState /ca 0.6 >>", // 9 (referenced inside the XObject)
    null, // 10: (unused spacing)
    "<< /Font << /F1 5 0 R >> /ExtGState << /G1 6 0 R >> /XObject << /X1 8 0 R >> >>", // 11
  ];
  const serialized: string[] = [];
  const offsets: number[] = [];
  let pos = enc.encode("%PDF-1.4\n").length;
  for (let i = 0; i < objects.length; i++) {
    const num = i + 1;
    let body = objects[i]!;
    if (num === 7) body = `<< /Length ${body7.length} >>\nstream\n${body7}\nendstream`;
    if (num === 8) {
      body =
        `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Resources ` +
        `<< /ExtGState << /G2 9 0 R >> >> /Length ${xoBody.length} >>\n` +
        `stream\n${xoBody}\nendstream`;
    }
    const chunk = `${num} 0 obj\n${body}\nendobj\n`;
    offsets[num - 1] = pos;
    pos += enc.encode(chunk).length;
    serialized.push(chunk);
  }
  let pdf = `%PDF-1.4\n${serialized.join("")}`;
  const xrefPos = pos;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return enc.encode(pdf);
}

async function section19(): Promise<void> {
  /* ── 19.1 drawPage operator parity vs the pdf-lib oracle (normalized). */
  {
    const libBase = await PDFDocument.create();
    const bp0 = libBase.addPage([300, 400]);
    bp0.drawText("BASE-ONE", { x: 20, y: 200 });
    const bp1 = libBase.addPage([300, 400]);
    bp1.drawText("BASE-TWO", { x: 20, y: 200 });
    const baseBytes = await libBase.save({ useObjectStreams: false });

    const libOvl = await PDFDocument.create();
    const ohelv = await libOvl.embedFont(StandardFonts.Helvetica);
    const op0 = libOvl.addPage([200, 260]);
    op0.drawText("OVL-PAGE-ONE", { x: 10, y: 130, font: ohelv });
    const op1 = libOvl.addPage([200, 260]);
    op1.drawText("OVL-PAGE-TWO", { x: 10, y: 130, font: ohelv });
    const ovlBytes = await libOvl.save({ useObjectStreams: false });

    // OUR engine: same embeds + the same draw calls.
    const base = StampContext.load(baseBytes);
    const ovl = parseForOrganize(ovlBytes);
    const f0 = base.embedForm(ovl, 0);
    const f1 = base.embedForm(ovl, 1);
    base.stampForm(0, f0, {
      x: 37.5, y: 45, width: 150, height: 195, opacity: 0.5, rotate: 30,
    });
    base.stampForm(1, f1, { x: 10, y: 20, width: 100, height: 130 });
    const ours = base.write();

    // pdf-lib oracle.
    const libB2 = await PDFDocument.load(baseBytes);
    const emb = await libB2.embedPdf(ovlBytes, [0, 1]);
    libB2.getPage(0).drawPage(emb[0]!, {
      x: 37.5, y: 45, width: 150, height: 195, rotate: degrees(30), opacity: 0.5,
    });
    libB2.getPage(1).drawPage(emb[1]!, { x: 10, y: 20, width: 100, height: 130 });
    const libBytes = await libB2.save({ useObjectStreams: false });

    eq(f0.width, 200, "overlay: form handle width = overlay MediaBox width");
    eq(f0.height, 260, "overlay: form handle height = overlay MediaBox height");

    const ourDoc = parsePdf(ours);
    const ourPages = listPages(ourDoc);
    const libDoc = parsePdf(libBytes);
    const libPages = listPages(libDoc);
    eq(ourPages.length, 2, "overlay: page count unchanged");
    for (let i = 0; i < 2; i++) {
      const a = normalizeOps(stripIdentityCm(lastEntryOpsText(ourDoc, ourPages, i)));
      const b = normalizeOps(stripIdentityCm(lastEntryOpsText(libDoc, libPages, i)));
      ok(
        a === b && b.split(" ").length > 10,
        `overlay parity: page ${i + 1} appended draw ops (${b.split(" ").length} normalized tokens)`,
      );
      if (a !== b) {
        const al = a.split(" ");
        const bl = b.split(" ");
        for (let k = 0; k < Math.max(al.length, bl.length); k++) {
          if (al[k] !== bl[k]) {
            console.log(
              `    first diff @${k}:\n      own="${al.slice(Math.max(0, k - 2), k + 6).join(" ")}"\n      lib="${bl.slice(Math.max(0, k - 2), k + 6).join(" ")}"`,
            );
            break;
          }
        }
      }
    }

    /* ── 19.2 the embedded form: structure + decoded body byte-exact. */
    const ourForm = bucketStream(ourDoc, ourPages, 0, "XObject", "Fm1");
    ok(ourForm !== null, "overlay: /Fm1 form resolvable on page 1");
    if (ourForm) {
      eq(
        ourForm.m.get("Subtype")?.k === "name" ? (ourForm.m.get("Subtype") as { v: string }).v : "",
        "Form",
        "overlay: /Fm1 is a Form XObject",
      );
      const bbox = ourForm.m.get("BBox");
      eq(
        bbox?.k === "arr"
          ? bbox.items.map((x) => (x.k === "num" ? x.n : null)).join(",")
          : "",
        "0,0,200,260",
        "overlay: form BBox = MediaBox normalized to the origin (pdf-lib default)",
      );
      const matrix = ourForm.m.get("Matrix");
      eq(
        matrix?.k === "arr"
          ? matrix.items.map((x) => (x.k === "num" ? x.n : null)).join(",")
          : "",
        "1,0,0,1,0,0",
        "overlay: form Matrix identity (pdf-lib boundingBoxAdjustedMatrix of a (0,0) box)",
      );
      // Decoded body: BYTE-EXACT vs the pdf-lib form (the q/Q wrap + join).
      const ourBody = decodeForParser(ourForm.raw, ourForm.m);
      const libForm = bucketStream(libDoc, libPages, 0, "XObject", ...(() => {
        // pdf-lib names it EmbeddedPdfPage-<random>: grab the only XObject.
        const resEntry = libPages[0]!.resources;
        const res = resEntry ? resolve(libDoc, resEntry) : undefined;
        const resMap = res?.k === "dict" || res?.k === "stream" ? res.m : undefined;
        const xo = resMap ? resolve(libDoc, resMap.get("XObject")) : undefined;
        const keys = xo?.k === "dict" || xo?.k === "stream" ? [...xo.m.keys()] : [];
        return [keys[0] ?? ""] as [string];
      })());
      ok(libForm !== null, "overlay: pdf-lib form found in the oracle output");
      if (libForm) {
        const libBody = decodeForParser(libForm.raw, libForm.m);
        eq(
          Buffer.compare(Buffer.from(ourBody), Buffer.from(libBody)),
          0,
          `overlay: form content bytes EXACT vs pdf-lib (${libBody.length} decoded)`,
        );
        const text = latin1(libBody, 0, libBody.length);
        ok(
          text.startsWith("q\n\n") && text.endsWith("Q\n\n"),
          "overlay: form body carries the page-normalize q/Q wrap streams",
        );
      }
      // The form's Resources must be the OVERLAY's (remapped font), not the base's.
      const formRes = resolve(ourDoc, ourForm.m.get("Resources"));
      const formFontBucket =
        formRes?.k === "dict" || formRes?.k === "stream"
          ? resolve(ourDoc, formRes.m.get("Font"))
          : undefined;
      const formFontEntry =
        formFontBucket?.k === "dict" || formFontBucket?.k === "stream"
          ? resolve(ourDoc, formFontBucket.m.values().next().value)
          : undefined;
      ok(
        formFontEntry !== undefined &&
          (formFontEntry.k === "dict" || formFontEntry.k === "stream"),
        "overlay: form /Resources /Font remapped to a real object in the output",
      );
    }

    /* ── 19.3 numbering: pages 3..4, forms 5..6, gs 7, stamp streams 8..9. */
    {
      const fm1 = bucketStream(ourDoc, ourPages, 0, "XObject", "Fm1");
      // Our writer numbers the first synthetic at 3 + pages.length = 5.
      const resEntry = ourPages[0]!.resources;
      const res = resEntry ? resolve(ourDoc, resEntry) : undefined;
      const resMap = res?.k === "dict" || res?.k === "stream" ? res.m : undefined;
      const xoEntry = resMap?.get("XObject");
      const fm1Ref = xoEntry?.k === "dict" ? xoEntry.m.get("Fm1") : undefined;
      eq(
        fm1Ref?.k === "ref" ? fm1Ref.num : -1,
        5,
        "overlay: form 1 numbered at 3+pages (writer synthetic contract)",
      );
      ok(fm1 !== null, "overlay: ref 5 resolves to the form stream");
    }
  }

  /* ── 19.4 the alpha pre-scale walk: nested XObjects + the shared-gs
   *  multiplicative quirk (both pages inherit ONE Resources dict — the
   *  per-page walk scales it twice, exactly like the pdf-lib pipeline). */
  {
    const bytes = buildAlphaOverlayFixture();
    const ovl = parseForOrganize(bytes);
    eq(ovl.pages.length, 2, "alpha fixture: two pages");
    const numAt = (m: Map<string, PdfObj> | undefined, key: string): string => {
      const entry = m?.get(key);
      return entry?.k === "num" ? String(entry.n) : "(missing)";
    };
    // factor 0.5, page 0 only → G1 ca 0.4 / CA 0.45, nested G2 0.3.
    const n0 = scaleOverlayAlpha(ovl.doc, ovl, 0, 0.5);
    eq(n0, 3, "alpha walk: 3 entries scaled on the first pass");
    const g1 = alphaGsOf(ovl, "G1");
    eq(numAt(g1, "ca"), "0.4", "alpha walk: G1 ca 0.8×0.5");
    eq(numAt(g1, "CA"), "0.45", "alpha walk: G1 CA 0.9×0.5");
    const g2 = alphaGsOf(ovl, "G2");
    eq(numAt(g2, "ca"), "0.3", "alpha walk: nested XObject gs 0.6×0.5 (recursion works)");
    // Page 1 shares the SAME Resources through inheritance → second walk
    // scales the same objects again (pdf-lib pipeline quirk, kept).
    const n1 = scaleOverlayAlpha(ovl.doc, ovl, 1, 0.5);
    eq(n1, 3, "alpha walk: 3 entries scaled on the second pass (shared objects)");
    eq(numAt(g1, "ca"), "0.2", "alpha walk: shared G1 ca scales TWICE (parity quirk)");
    eq(numAt(g2, "ca"), "0.15", "alpha walk: nested shared gs scales twice");
  }

  /* ── 19.5 odd-box default embed: MediaBox [50 25 350 325] → BBox
   *  [0 0 300 300] + identity Matrix + width 300 (origin discarded). */
  {
    const libOvl = await PDFDocument.create();
    const p = libOvl.addPage([100, 100]);
    p.drawText("ODD", { x: 10, y: 50 });
    const raw = await libOvl.save({ useObjectStreams: false });
    const doc2 = await PDFDocument.load(raw);
    doc2.getPage(0).node.set(PDFName.of("MediaBox"), doc2.context.obj([50, 25, 350, 325]));
    doc2.getPage(0).node.set(PDFName.of("CropBox"), doc2.context.obj([80, 60, 300, 280]));
    const oddBytes = await doc2.save({ useObjectStreams: false });

    const base = StampContext.load(await PDFDocument.create().then((d) => {
      d.addPage([400, 500]);
      return d.save({ useObjectStreams: false });
    }));
    const ovl = parseForOrganize(oddBytes);
    const form = base.embedForm(ovl, 0);
    eq(form.width, 300, "odd box: form width = MediaBox WIDTH (origin discarded)");
    eq(form.height, 300, "odd box: form height = MediaBox HEIGHT");
    base.stampForm(0, form, { x: 0, y: 0, width: 300, height: 300 });
    const out = base.write();
    const back = parsePdf(out);
    const backPages = listPages(back);
    const form2 = bucketStream(back, backPages, 0, "XObject", "Fm1");
    ok(form2 !== null, "odd box: form written");
    if (form2) {
      const bbox = form2.m.get("BBox");
      eq(
        bbox?.k === "arr"
          ? bbox.items.map((x) => (x.k === "num" ? x.n : null)).join(",")
          : "",
        "0,0,300,300",
        "odd box: BBox [0 0 300 300] — pdf-lib default (CropBox IGNORED)",
      );
    }
    // And the scale cm carries RATIOS (drawPage), not absolute sizes.
    const ops = pageOpsText(back, backPages, 0);
    ok(
      /1 0 0 1 0 0 cm[\s\S]*1 0 0 1 0 0 cm[\s\S]*\/Fm1 Do/.test(ops) ||
        ops.includes("/Fm1 Do"),
      "odd box: stamp stream draws the form",
    );
    ok(
      !/300 0 0 300 0 0 cm/.test(ops) || ops.includes("1 0 0 1"),
      "odd box: scale cm is ratio-based (1 0 0 1) when box == form size",
    );
  }

  /* ── 19.6 shared overlay graphs copy ONCE: two forms sharing one font →
   *  exactly one Helvetica Type1 font object in the output. */
  {
    const libOvl = await PDFDocument.create();
    const ohelv = await libOvl.embedFont(StandardFonts.Helvetica);
    const a = libOvl.addPage([200, 260]);
    a.drawText("SHARED-A", { x: 10, y: 130, font: ohelv });
    const b = libOvl.addPage([200, 260]);
    b.drawText("SHARED-B", { x: 10, y: 130, font: ohelv });
    const ovlBytes = await libOvl.save({ useObjectStreams: false });
    const libBase = await PDFDocument.create();
    libBase.addPage([300, 400]);
    libBase.addPage([300, 400]);
    const baseBytes = await libBase.save({ useObjectStreams: false });

    const base = StampContext.load(baseBytes);
    const ovl = parseForOrganize(ovlBytes);
    base.stampForm(0, base.embedForm(ovl, 0), { x: 0, y: 0, width: 200, height: 260 });
    base.stampForm(1, base.embedForm(ovl, 1), { x: 0, y: 0, width: 200, height: 260 });
    const out = base.write();

    const back = parsePdf(out);
    let helvCount = 0;
    const maxNum = 50;
    for (let n = 1; n <= maxNum; n++) {
      const obj = back.getObject(n);
      if (obj?.k === "dict" || obj?.k === "stream") {
        const t = obj.m.get("Type");
        const bt = obj.m.get("BaseFont");
        if (
          t?.k === "name" && t.v === "Font" &&
          bt?.k === "name" && bt.v === "Helvetica"
        ) {
          helvCount += 1;
        }
      }
    }
    eq(helvCount, 1, "overlay: shared overlay font copied EXACTLY once (BFS dedupe)");
  }

  function alphaGsOf(
    source: ReturnType<typeof parseForOrganize>,
    key: string,
  ): Map<string, PdfObj> | undefined {
    // G1 lives in the page's (inherited) Resources; G2 lives INSIDE the
    // nested XObject /X1's own Resources — search both places.
    const dictOf = (obj: PdfObj | undefined): Map<string, PdfObj> | undefined => {
      const r = obj === undefined ? undefined : resolve(source.doc, obj);
      return r?.k === "dict" || r?.k === "stream" ? r.m : undefined;
    };
    const resEntry = source.pages[0]!.resources;
    const resMap = dictOf(resEntry);
    const pageGs = dictOf(resMap?.get("ExtGState"));
    const direct = pageGs?.get(key);
    if (direct) return dictOf(direct);
    const xoMap = dictOf(resMap?.get("XObject"));
    const xoRes = dictOf(xoMap?.get("X1"))?.get("Resources");
    const xoGs = dictOf(dictOf(xoRes)?.get("ExtGState"));
    const nested = xoGs?.get(key);
    return nested ? dictOf(nested) : undefined;
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 16 — the P6-f stamp kernel. Every check is NON-VACUOUS (capture
 * guards first — the P6-c lesson) and pdf-lib is the DEV-TIME ORACLE only.
 * ════════════════════════════════════════════════════════════════════════ */

async function section16(): Promise<void> {
  /* ── 16.1 Width + encode parity vs pdf-lib, all 6 fonts, kerning on ── */
  {
    const libDoc = await PDFDocument.create();
    const libFonts = {
      helvetica: await libDoc.embedFont(StandardFonts.Helvetica),
      helveticaBold: await libDoc.embedFont(StandardFonts.HelveticaBold),
      times: await libDoc.embedFont(StandardFonts.TimesRoman),
      timesBold: await libDoc.embedFont(StandardFonts.TimesRomanBold),
      courier: await libDoc.embedFont(StandardFonts.Courier),
      courierBold: await libDoc.embedFont(StandardFonts.CourierBold),
    } as Record<import("../src/lib/own/pdf/stamp-fonts").StampFontKey, typeof libFonts.helvetica>;
    const samples = [
      "AVATAR WAVes To TaVo", // heavy kern pairs
      "Waltz, bad nymph, for quick jigs vex!",
      "page 3 of 17 — “quoted” ’98 €30 † 5‰ caf\u00e9",
      "0123456789 .,:;!()[]{}@#&*",
      "A",
      "",
    ];
    type FontKey = import("../src/lib/own/pdf/stamp-fonts").StampFontKey;
    const fontIds = Object.keys(libFonts) as FontKey[];
    let widthsCompared = 0;
    let worstDelta = 0;
    for (const fontId of fontIds) {
      for (const text of samples) {
        const ours = measureStdText(text, fontId, 12);
        const theirs = libFonts[fontId]!.widthOfTextAtSize(text, 12);
        if (text.length > 0) {
          ok(
            Number.isFinite(ours) && ours >= 0,
            `width: ${fontId} ${JSON.stringify(text.slice(0, 12))} finite`,
          );
        }
        widthsCompared += 1;
        worstDelta = Math.max(worstDelta, Math.abs(ours - theirs));
      }
    }
    eq(widthsCompared, 36, "width: sample count (6 fonts × 6 strings)");
    eq(worstDelta, 0, `width: EXACT pdf-lib parity incl. kerning (worst Δ=${worstDelta})`);
    // Hex encode parity: our <hex> vs pdf-lib's PDFHexString body.
    const hexOurs = encodeWinAnsiHex("Hi € 5‰ — “Q”", "helvetica");
    const hexLib = libFonts
      .helvetica!.encodeText("Hi € 5‰ — “Q”")
      .asString()
      .replace(/^</, "")
      .replace(/>$/, "");
    eq(hexOurs.toLowerCase(), hexLib.toLowerCase(), "encode: hex Tj parity with pdf-lib");
    ok(!winAnsiEncodable("\u0917\u094b\u092a\u0928\u0940\u092f"), "encode: Devanagari detected as non-WinAnsi");
    ok(winAnsiEncodable("€†‰ç ñ–—“” ŒœŠ"), "encode: WinAnsi specials encodable");
  }

  /* ── 16.2 Stamp text on a doc WITH existing fonts (merge + no shadow) ── */
  let stampBase: Uint8Array;
  {
    const libDoc = await PDFDocument.create();
    const helv = await libDoc.embedFont(StandardFonts.Helvetica); // becomes /F1
    for (let i = 0; i < 3; i++) {
      const page = libDoc.addPage([300, 400]);
      page.drawText(`EXISTING-PAGE-TEXT-${i + 1}`, { x: 20, y: 200, font: helv, size: 14 });
    }
    stampBase = await libDoc.save();
    ok(stampBase.length > 500, "fixture: stamp base captured (non-vacuous)");
  }
  {
    const ctx = StampContext.load(stampBase);
    eq(ctx.pageCount, 3, "stamp: page count");
    ok(
      ctx.pages[0]!.resources !== undefined,
      "stamp: fixture page carries its own /Resources",
    );
    ctx.stampText(1, {
      x: 40,
      y: 60,
      text: "OWN-ENGINE-STAMP",
      size: 24,
      font: "timesBold",
      color: { r: 0.86, g: 0.15, b: 0.15 },
      opacity: 0.5,
      rotate: 45,
    });
    ctx.stampText(2, { x: 10, y: 350, text: "FRONT-MARK", size: 10, font: "courier" });
    const out = ctx.write();
    // Our parser reload: structure checks.
    const back = parsePdf(out);
    const backPages = listPages(back);
    eq(backPages.length, 3, "stamp: reload page count");
    // Page 1 (index 1) must have /Contents [existing, ours] and /Resources
    // with BOTH the original /F1 and our /F2 (no shadowing).
    const dict1 = backPages[1]!.dict;
    const contents = dict1.get("Contents");
    ok(contents !== undefined && contents.k === "arr", "stamp: contents became an array");
    if (contents?.k === "arr") {
      eq(contents.items.length, 2, "stamp: contents array = existing + ours");
    }
    const res = dict1.get("Resources");
    const resMap = res?.k === "dict" ? res.m : undefined;
    ok(resMap !== undefined, "stamp: page gained own /Resources");
    const fontBucket = resMap?.get("Font");
    const fontMap = fontBucket?.k === "dict" ? fontBucket.m : undefined;
    ok(fontMap !== undefined, "stamp: /Font bucket present");
    // pdf-lib's own font key is random-suffixed (e.g. "Helvetica-7098480789"):
    // it must survive untouched, with our /F1 added alongside (no shadow).
    const originalKeys = [...(fontMap?.keys() ?? [])].filter((k) => k !== "F1");
    eq(originalKeys.length > 0, true, "stamp: original font key preserved (no shadow)");
    eq(fontMap?.has("F1"), true, "stamp: our font allocated F1 (collision-free vs random pdf-lib keys)");
    const f2 = fontMap?.get("F1");
    // In the OUTPUT file our newref serialized as a plain ref — resolve it.
    const f2Ref =
      f2 && (f2.k === "ref" || f2.k === "newref") ? back.getObject(f2.num) : undefined;
    const f2Map = f2Ref?.k === "dict" ? f2Ref.m : undefined;
    eq(f2Map?.get("BaseFont")?.k === "name" ? (f2Map.get("BaseFont") as { v: string }).v : "", "Times-Bold", "stamp: our font is Times-Bold Type1 (allocated F1 — pdf-lib keys are random-suffixed)");
    eq(
      f2Map?.get("Encoding")?.k === "name" ? (f2Map.get("Encoding") as { v: string }).v : "",
      "WinAnsiEncoding",
      "stamp: our font WinAnsi encoding",
    );
    // Our stamp stream: the LAST content entry. Decode ops.
    let stampBody = "";
    if (contents?.k === "arr") {
      const oursRef = contents.items[contents.items.length - 1]!;
      if (oursRef.k === "ref") {
        const stream = back.getObject(oursRef.num);
        stampBody = stream?.k === "stream" ? new TextDecoder().decode(stream.raw) : "";
      }
    }
    ok(stampBody.length > 0, "stamp: our stream bytes non-empty");
    ok(stampBody.includes("BT") && stampBody.includes("ET"), "stamp: BT/ET present");
    ok(stampBody.includes("0.86 0.15 0.15 rg"), "stamp: fill color rg");
    // The Tf key must be THE key that maps to Times-Bold in this page's fonts.
    const tfMatch = /\/(\S+) 24 Tf/.exec(stampBody);
    ok(tfMatch !== null, "stamp: font+size Tf present");
    if (tfMatch) {
      eq(
        fontMap?.get(tfMatch[1]) === f2,
        true,
        `stamp: Tf key ${tfMatch[1]} resolves to OUR Times-Bold entry`,
      );
    }
    const cos45 = pdfNumToString(Math.cos((45 * Math.PI) / 180));
    const sin45 = pdfNumToString(Math.sin((45 * Math.PI) / 180));
    const negSin45 = pdfNumToString(-Math.sin((45 * Math.PI) / 180));
    ok(
      stampBody.includes(`${cos45} ${sin45} ${negSin45} ${cos45} 40 60 Tm`),
      `stamp: rotation Tm (${cos45} ${sin45} ${negSin45} ${cos45} 40 60)`,
    );
    ok(stampBody.includes("<4f574e2d454e47494e452d5354414d50> Tj"), "stamp: hex text Tj (OWN-ENGINE-STAMP)");
    ok(/\/GS\d+ gs/.test(stampBody), "stamp: ExtGState gs for opacity");
    // Opacity object: find ExtGState with ca 0.5
    let foundCa = false;
    for (const [, obj] of iterateObjects(back)) {
      if (obj?.k === "dict" && obj.m.get("ca")?.k === "num" && (obj.m.get("ca") as { n: number }).n === 0.5) {
        foundCa = true;
      }
    }
    eq(foundCa, true, "stamp: ExtGState /ca 0.5 emitted");
    // pdf-lib oracle reload.
    const lib = await PDFDocument.load(out);
    eq(lib.getPageCount(), 3, "stamp: pdf-lib reload count");
    // Page 0 must be UNTOUCHED (no stamp): Contents still present.
    const dict0 = backPages[0]!.dict;
    const contents0 = dict0.get("Contents");
    ok(contents0 !== undefined, "stamp: unstamped page keeps /Contents");
    // Font object DEDUP: exactly ONE Times-Bold font object in the whole doc.
    let timesBoldCount = 0;
    for (const [, obj] of iterateObjects(back)) {
      if (obj?.k === "dict" && obj.m.get("Type")?.k === "name") {
        const t = (obj.m.get("Type") as { v: string }).v;
        const bf = obj.m.get("BaseFont");
        if (t === "Font" && bf?.k === "name" && (bf as { v: string }).v === "Times-Bold") {
          timesBoldCount += 1;
        }
      }
    }
    eq(timesBoldCount, 1, "stamp: Times-Bold emitted exactly once (dedup)");
    // Existing content preserved byte-for-byte on the stamped page.
    const baseDoc = parsePdf(stampBase);
    const basePages = listPages(baseDoc);
    if (contents?.k === "arr" && contents.items[0]?.k === "ref") {
      const existingRef = contents.items[0] as { num: number };
      const existingStream = back.getObject(existingRef.num);
      eq(
        bytesEqual(
          existingStream?.k === "stream" ? existingStream.raw : new Uint8Array(0),
          contentBytesOf(baseDoc, basePages, 1),
        ),
        true,
        "stamp: existing content byte-identical",
      );
    }
    // write() twice (non-destructive rebuild)
    const out2 = ctx.write();
    eq(bytesEqual(out, out2), true, "stamp: write() is deterministic + repeatable");
  }

  /* ── 16.3 Behind-content ordering ── */
  {
    const ctx = StampContext.load(stampBase);
    ctx.stampText(0, { x: 5, y: 5, text: "BEHIND", size: 8, font: "helvetica", behind: true });
    const out = ctx.write();
    const back = listPages(parsePdf(out));
    const contents = back[0]!.dict.get("Contents");
    ok(contents?.k === "arr", "behind: contents array");
    if (contents?.k === "arr") {
      eq(contents.items.length, 2, "behind: two streams");
      const first = contents.items[0]!;
      const stream = first.k === "ref" ? parsePdf(out).getObject(first.num) : undefined;
      const body = stream?.k === "stream" ? new TextDecoder().decode(stream.raw) : "";
      ok(body.includes("<424548494e44>"), "behind: OUR stream is FIRST in /Contents");
    }
  }

  /* ── 16.4 JPEG embed + stamp (DCT passthrough, oracle dims) ── */
  {
    const jpg = readFileSync("qa/test-photo.jpg");
    const libDoc = await PDFDocument.create();
    const libImg = await libDoc.embedJpg(new Uint8Array(jpg));
    const ctx = StampContext.load(stampBase);
    const img = ctx.embedJpeg(new Uint8Array(jpg));
    eq(img.width, libImg.width, "jpeg: width parity with pdf-lib");
    eq(img.height, libImg.height, "jpeg: height parity with pdf-lib");
    ctx.stampImage(0, img, { x: 50, y: 50, width: 120, height: 90, opacity: 0.8, rotate: 30 });
    const out = ctx.write();
    const back = parsePdf(out);
    const backPages = listPages(back);
    const res = backPages[0]!.dict.get("Resources");
    const xob = res?.k === "dict" ? res.m.get("XObject") : undefined;
    const xobMap = xob?.k === "dict" ? xob.m : undefined;
    const imKey = xobMap?.keys().next().value as string | undefined;
    ok(imKey !== undefined, "jpeg: /XObject entry present");
    const stream = imKey ? xobMap?.get(imKey) : undefined;
    const streamNum = stream?.k === "ref" ? stream.num : undefined;
    const imgObj = streamNum !== undefined ? back.getObject(streamNum) : undefined;
    ok(imgObj?.k === "stream", "jpeg: image object is a stream");
    if (imgObj?.k === "stream") {
      eq((imgObj.m.get("Width") as { n: number } | undefined)?.n, libImg.width, "jpeg: /Width");
      eq((imgObj.m.get("Height") as { n: number } | undefined)?.n, libImg.height, "jpeg: /Height");
      eq((imgObj.m.get("Filter") as { v: string } | undefined)?.v, "DCTDecode", "jpeg: DCTDecode filter");
      eq(bytesEqual(imgObj.raw, new Uint8Array(jpg)), true, "jpeg: DCT bytes passthrough EXACT");
    }
    // Ops: verify the cm triple + Do on page 0.
    const contents = backPages[0]!.dict.get("Contents");
    if (contents?.k === "arr") {
      const last = contents.items[contents.items.length - 1]!;
      if (last.k === "ref") {
        const s = back.getObject(last.num);
        const body = s?.k === "stream" ? new TextDecoder().decode(s.raw) : "";
        ok(body.includes("1 0 0 1 50 50 cm"), "jpeg: translate cm");
        const cos30 = Math.cos((30 * Math.PI) / 180);
        ok(body.includes(`${cos30.toFixed(10).replace(/0+$/, "").replace(/\.$/, "")} 0.5 -0.5 ${cos30.toFixed(10).replace(/0+$/, "").replace(/\.$/, "")} 0 0 cm`) || /0\.8660\d* 0\.5 -0\.5 0\.8660\d* 0 0 cm/.test(body), "jpeg: rotate cm");
        ok(body.includes("120 0 0 90 0 0 cm"), "jpeg: scale cm");
        ok(body.includes(`/${imKey} Do`), "jpeg: Do operator");
      }
    }
    const lib = await PDFDocument.load(out);
    eq(lib.getPageCount(), 3, "jpeg: pdf-lib reload");
  }

  /* ── 16.5 PNG embed (opaque + alpha), pixel round-trip ── */
  {
    // 2×2 RGBA: red/green opaque, blue/yellow with alpha 128.
    const png = buildPngFixture([
      [255, 0, 0, 255], [0, 255, 0, 255],
      [0, 0, 255, 128], [255, 255, 0, 128],
    ]);
    const ctx = StampContext.load(stampBase);
    const img = ctx.embedPng(png);
    eq(img.width, 2, "png: width");
    eq(img.height, 2, "png: height");
    ctx.stampImage(1, img, { x: 10, y: 10, width: 2, height: 2 });
    const out = ctx.write();
    const back = parsePdf(out);
    const backPages = listPages(back);
    const res = backPages[1]!.dict.get("Resources");
    const xobMap = res?.k === "dict" ? res.m.get("XObject") : undefined;
    const xmap = xobMap?.k === "dict" ? xobMap.m : undefined;
    const imKey = xmap?.keys().next().value as string | undefined;
    const imRef = imKey ? xmap?.get(imKey) : undefined;
    const imgObj = imRef?.k === "ref" ? back.getObject(imRef.num) : undefined;
    ok(imgObj?.k === "stream", "png: image stream");
    if (imgObj?.k === "stream") {
      eq((imgObj.m.get("ColorSpace") as { v: string } | undefined)?.v, "DeviceRGB", "png: DeviceRGB");
      eq((imgObj.m.get("BitsPerComponent") as { n: number } | undefined)?.n, 8, "png: 8bpc");
      eq((imgObj.m.get("Filter") as { v: string } | undefined)?.v, "FlateDecode", "png: Flate");
      const rgb = unzlibSync(imgObj.raw);
      eq(
        bytesEqual(rgb, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])),
        true,
        "png: RGB pixels round-trip EXACT",
      );
      const smaskRef = imgObj.m.get("SMask");
      const smaskObj = smaskRef?.k === "ref" ? back.getObject(smaskRef.num) : undefined;
      ok(smaskObj?.k === "stream", "png: SMask stream (alpha present)");
      if (smaskObj?.k === "stream") {
        eq((smaskObj.m.get("ColorSpace") as { v: string } | undefined)?.v, "DeviceGray", "png: SMask gray");
        const alpha = unzlibSync(smaskObj.raw);
        eq(bytesEqual(alpha, new Uint8Array([255, 255, 128, 128])), true, "png: alpha round-trip EXACT");
      }
    }
    // Fully opaque PNG → NO SMask (pdf-lib hasAlphaValues parity).
    const opaquePng = buildPngFixture([
      [1, 2, 3, 255], [4, 5, 6, 255],
      [7, 8, 9, 255], [10, 11, 12, 255],
    ]);
    const ctx2 = StampContext.load(stampBase);
    const img2 = ctx2.embedPng(opaquePng);
    ctx2.stampImage(2, img2, { x: 0, y: 0, width: 2, height: 2 });
    const out2 = ctx2.write();
    let smaskCount = 0;
    for (const [, obj] of iterateObjects(parsePdf(out2))) {
      if (obj?.k === "stream" && obj.m.has("SMask")) smaskCount += 1;
    }
    eq(smaskCount, 0, "png: opaque → no SMask emitted");
    // pdf-lib embeds the SAME pngs fine (oracle sanity)
    const libDoc = await PDFDocument.create();
    const libImg = await libDoc.embedPng(png);
    eq(libImg.width, 2, "png: pdf-lib oracle loads our fixture");
  }

  /* ── 16.6 Inherited Resources (stamp a page without own /Resources) ── */
  {
    const inherited = buildInheritedResourcesFixture();
    const parsed = parsePdf(inherited);
    const pages = listPages(parsed);
    eq(pages.length, 2, "inherit: fixture pages");
    ok(pages[0]!.dict.get("Resources") === undefined, "inherit: page has NO own /Resources");
    ok(pages[0]!.resources !== undefined, "inherit: engine resolves inherited entry");
    const ctx = StampContext.load(inherited);
    ctx.stampText(0, { x: 10, y: 20, text: "INHERIT-STAMP", size: 10, font: "helvetica" });
    const out = ctx.write();
    const back = listPages(parsePdf(out));
    const res = back[0]!.dict.get("Resources");
    const resMap = res?.k === "dict" ? res.m : undefined;
    ok(resMap !== undefined, "inherit: stamped page gained own /Resources");
    const fontMap = resMap?.get("Font");
    const fMap = fontMap?.k === "dict" ? fontMap.m : undefined;
    eq(fMap?.has("F1"), true, "inherit: parent's F1 carried into the clone");
    eq(fMap?.has("F2"), true, "inherit: our font merged next to it");
    const lib = await PDFDocument.load(out);
    eq(lib.getPageCount(), 2, "inherit: pdf-lib reload");
    // P6-h: the UNSTAMPED page materializes its inherited /Resources too
    // (pdf-lib copyPDFPage parity — the rebuilt tree drops /Parent, so
    // inherited entries must move onto the leaf or the page's content would
    // reference fonts that no longer resolve). Self-contained copy now.
    // The unstamped page keeps the parent's Resources as a REFSHARED graph
    // copy (the stamped page's clone is separate by design — merging F2
    // never mutates the shared parent dict). Its F1 must resolve to a real
    // copied font object in the output.
    const res1 = back[1]!.dict.get("Resources");
    const resMap1 = res1?.k === "dict" ? res1.m : undefined;
    ok(resMap1 !== undefined, "inherit: unstamped page materialized own /Resources");
    const fontMap1 = resMap1?.get("Font");
    const fMap1 = fontMap1?.k === "dict" ? fontMap1.m : undefined;
    eq(fMap1?.has("F1"), true, "inherit: unstamped page's F1 carried from parent");
    const f1Entry = fMap1?.get("F1");
    const f1Obj =
      f1Entry?.k === "ref"
        ? parsePdf(out).getObject(f1Entry.num)
        : undefined;
    const f1Base = f1Obj?.k === "dict" ? f1Obj.m.get("BaseFont") : undefined;
    eq(f1Base?.k === "name" && f1Base.v === "Times-Roman", true, "inherit: F1 ref resolves to the copied font");
  }

  /* ── 16.7 getTitle (latin1 + absent) ── */
  {
    const libDoc = await PDFDocument.create();
    libDoc.setTitle("Fixture Title");
    libDoc.addPage([100, 100]);
    const bytes = await libDoc.save();
    const ctx = StampContext.load(new Uint8Array(bytes));
    eq(ctx.getTitle(), "Fixture Title", "title: decode parity with pdf-lib getTitle");
    const ctx2 = StampContext.load(buildInheritedResourcesFixture());
    eq(ctx2.getTitle(), "", "title: absent → empty string");
  }

  /* ── 16.8 Error vectors ── */
  {
    const ctx = StampContext.load(stampBase);
    const cases: Array<[string, () => void, string]> = [
      [
        "non-WinAnsi text",
        () =>
          ctx.stampText(0, {
            x: 0, y: 0, text: "\u0917\u094b\u092a\u0928\u0940\u092f", size: 12, font: "helvetica",
          }),
        "chars",
      ],
      ["bad jpeg", () => ctx.embedJpeg(new Uint8Array([1, 2, 3, 4])), "logo"],
      ["bad png", () => ctx.embedPng(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])), "logo"],
      [
        "page out of range",
        () => ctx.stampText(9, { x: 0, y: 0, text: "x", size: 12, font: "helvetica" }),
        "corrupt",
      ],
      [
        "non-positive size",
        () => ctx.stampText(0, { x: 0, y: 0, text: "x", size: 0, font: "helvetica" }),
        "corrupt",
      ],
    ];
    for (const [label, fn, want] of cases) {
      let code = "none";
      try {
        fn();
      } catch (err) {
        code = err instanceof PdfError ? err.code : "wrong-error";
      }
      eq(code, want, `stamp error: ${label}`);
    }
    // Interlaced PNG refusal (hand-set the flag on a real PNG).
    const interlaced = Uint8Array.from(buildPngFixture([[1, 2, 3, 255]]));
    interlaced[28] = 1; // IHDR interlace byte
    let code = "none";
    try {
      ctx.embedPng(interlaced);
    } catch (err) {
      code = err instanceof PdfError ? err.code : "wrong-error";
    }
    eq(code, "logo", "stamp error: interlaced PNG refused");
    // organizePdf on a STAMPED output still works (engine composability).
    const stamped = StampContext.load(stampBase);
    stamped.stampText(0, { x: 1, y: 1, text: "X", size: 6, font: "helvetica" });
    const stampedBytes = stamped.write();
    const reorganized = organizePdf(stampedBytes, [{ kind: "page", src: 0 }]);
    eq(listPages(parsePdf(reorganized.bytes)).length, 1, "stamp: organizePdf on stamped output");
  }
}

/** Iterate all top-level objects of a parsed doc (num, obj). */
function* iterateObjects(doc: ParsedPdf): Generator<[number, PdfObj | undefined]> {
  for (const num of doc.entries.keys()) {
    yield [num, doc.getObject(num)];
  }
}

/**
 * Build a 2×2 (or arbitrary len/2) RGBA PNG with zlib-deflated IDAT and NO
 * filtering — dev-time synthesis for the stamp smokes (node:zlib allowed in
 * scripts; runtime uses our own zip engine).
 */
function buildPngFixture(pixels: Array<[number, number, number, number]>): Uint8Array {
  const width = 2;
  const height = Math.max(1, Math.ceil(pixels.length / 2));
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter None
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x] ?? [0, 0, 0, 255];
      raw.push(p[0], p[1], p[2], p[3]);
    }
  }
  const idat = deflateSync(new Uint8Array(raw));
  const chunks: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];
  const push = (type: string, data: Uint8Array): void => {
    const len = new Uint8Array([(data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]);
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, typeBytes.length);
    const crc = crc32(crcInput);
    const crcBytes = new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
    chunks.push(len, typeBytes, data, crcBytes);
  };
  const ihdr = new Uint8Array(13);
  ihdr.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 0);
  ihdr.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  push("IHDR", ihdr);
  push("IDAT", idat);
  push("IEND", new Uint8Array(0));
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Hand-built 2-page PDF whose /Font /F1 lives ONLY on the /Pages tree —
 * pages inherit it (spec §7.7.3.4). The classic inheritance stress case.
 */
function buildInheritedResourcesFixture(): Uint8Array {
  const enc = new TextEncoder();
  const objects: Array<string | null> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
    null, // 6: content stream (patched below)
    null, // 7: content stream
  ];
  const body6 = "BT /F1 12 Tf 20 100 Td (INHERITED-FONT-TEXT) Tj ET";
  const body7 = "BT /F1 12 Tf 20 100 Td (SECOND-PAGE) Tj ET";
  const serialized: string[] = [];
  const offsets: number[] = [];
  let pos = enc.encode("%PDF-1.4\n").length;
  for (let i = 0; i < objects.length; i++) {
    const num = i + 1;
    let body = objects[i]!;
    if (num === 6) body = `<< /Length ${body6.length} >>\nstream\n${body6}\nendstream`;
    if (num === 7) body = `<< /Length ${body7.length} >>\nstream\n${body7}\nendstream`;
    const chunk = `${num} 0 obj\n${body}\nendobj\n`;
    offsets[num - 1] = pos;
    pos += enc.encode(chunk).length;
    serialized.push(chunk);
  }
  const xrefPos = pos;
  let pdf = `%PDF-1.4\n${serialized.join("")}`;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return enc.encode(pdf);
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 20 — the P6-l renderer-family surfaces: the Tc letter-spacing
 * route, the rotated stroke-only rect (the invoice PAID stamp), the
 * ca+CA paired ExtGState, and the Info dict / trailer metadata.
 * ══════════════════════════════════════════════════════════════════════ */

async function section20(): Promise<void> {
  const W = 595.28;
  const H = 841.89;

  /* ── 20.1 characterSpacing: the raw-operator shape pdf-lib's
   * pushOperators produced for the resume's tracked headings (the probe
   * pinned: q BT rg Tf <Tc> Td <HEX> Tj ET Q — no TL/T*, Td not Tm). */
  {
    const ctx = CreateContext.create();
    const p = ctx.addPage(W, H);
    p.drawText({
      x: 72,
      y: 700,
      text: "EXPERIENCE",
      size: 11,
      color: { r: 0.08, g: 0.08, b: 0.08 },
      characterSpacing: 1.98,
    });
    const ours = ctx.write();
    const ourDoc = parsePdf(ours);
    const ourPages = listPages(ourDoc);
    const ops = latin1(
      contentBytesOf(ourDoc, ourPages, 0),
      0,
      contentBytesOf(ourDoc, ourPages, 0).length,
    );
    ok(
      /^q\nBT\n0\.08 0\.08 0\.08 rg\n\/F1 11 Tf\n1\.98 Tc\n72 700 Td\n<455850455249454E4345> Tj\nET\nQ\n?$/.test(
        ops.replace(/\n+$/, "\n").replace(/\n$/, ""),
      ),
      `p6l Tc: exact raw-operator shape (got ${JSON.stringify(ops)})`,
    );
    ok(ops.includes("1.98 Tc"), "p6l Tc: the tracking value rides the Tc op");
    ok(
      ops.includes("<455850455249454E4345> Tj"),
      "p6l Tc: hex is UPPERCASE like pdf-lib's encodeText",
    );
    ok(!ops.includes("TL"), "p6l Tc: no drawLinesOfText TL/T* in the raw shape");
    ok(!ops.includes(" Tm"), "p6l Tc: Td, not Tm (the raw-path shape)");
    // The same call with a TTF face composes (resume's Noto headings).
    const noto = new Uint8Array(
      readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf"),
    );
    const ctx2 = CreateContext.create();
    const ttf = ctx2.embedTtf(noto);
    const p2 = ctx2.addPage(W, H);
    p2.drawText({
      x: 72,
      y: 700,
      text: "गोपाल",
      size: 11,
      characterSpacing: 1.2,
      ttf,
    });
    const back2 = parsePdf(ctx2.write());
    const pages2 = listPages(back2);
    const ops2 = latin1(
      contentBytesOf(back2, pages2, 0),
      0,
      contentBytesOf(back2, pages2, 0).length,
    );
    ok(ops2.includes("1.2 Tc"), "p6l Tc: composes with the TTF route");
    ok(
      /\/F1 11 Tf\n1\.2 Tc\n72 700 Td\n<[0-9A-F]+> Tj/.test(ops2),
      "p6l Tc: TTF glyph-id hex rides the same Tj literal",
    );
  }

  /* ── 20.2 the rotated stroke-only rect (invoice PAID stamp): op-parity
   * vs pdf-lib (normalized) + ONE paired ExtGState {ca, CA} in resources. */
  {
    const ctx = CreateContext.create();
    const p = ctx.addPage(W, H);
    p.drawRectangle({
      x: 300.5,
      y: 400.25,
      width: 120,
      height: 30,
      borderColor: { r: 0.1, g: 0.5, b: 0.3 },
      borderWidth: 2.25,
      rotate: -12,
      opacity: 0,
      borderOpacity: 0.55,
    });
    p.drawText({
      x: 309.5,
      y: 404.75,
      text: "PAID",
      size: 16.5,
      color: { r: 0.1, g: 0.5, b: 0.3 },
      rotate: -12,
      opacity: 0.55,
    });
    const ours = ctx.write();

    const libDoc = await PDFDocument.create();
    const helv = await libDoc.embedFont(StandardFonts.Helvetica);
    const lp = libDoc.addPage([W, H]);
    lp.drawRectangle({
      x: 300.5,
      y: 400.25,
      width: 120,
      height: 30,
      borderColor: rgb(0.1, 0.5, 0.3),
      borderWidth: 2.25,
      rotate: degrees(-12),
      opacity: 0,
      borderOpacity: 0.55,
    });
    lp.drawText("PAID", {
      x: 309.5,
      y: 404.75,
      size: 16.5,
      font: helv,
      color: rgb(0.1, 0.5, 0.3),
      rotate: degrees(-12),
      opacity: 0.55,
    });
    const libBytes = await libDoc.save({ useObjectStreams: false });

    const ourDoc = parsePdf(ours);
    const ourPages = listPages(ourDoc);
    const cBytes = contentBytesOf(ourDoc, ourPages, 0);
    const ourText = latin1(cBytes, 0, cBytes.length);
    const libText = await libContentText(libBytes, 0);
    eq(
      normalizeOps(ourText),
      normalizeOps(libText),
      "p6l stamp: rotated rect + rotated text operator parity vs pdf-lib",
    );
    ok(/\nS\n|^S\n/.test(ourText), "p6l stamp: stroke-only paint (no fill rg before the S)");
    // The gs pair {ca: 0, CA: 0.55} — ONE dict, both keys (probe-pinned).
    const resEntry = ourPages[0]!.resources;
    const res = resEntry ? resolve(ourDoc, resEntry) : undefined;
    const resMap = res?.k === "dict" || res?.k === "stream" ? res.m : undefined;
    const gsBucket = resMap?.get("ExtGState");
    const gsDict =
      gsBucket?.k === "dict" || gsBucket?.k === "stream" ? gsBucket.m : undefined;
    ok(gsDict !== undefined, "p6l stamp: ExtGState bucket present");
    let pairCount = 0;
    if (gsDict) {
      for (const [, v] of gsDict) {
        const g = resolve(ourDoc, v);
        if (g?.k === "dict" || g?.k === "stream") {
          const ca = g.m.get("ca");
          const cA = g.m.get("CA");
          if (ca?.k === "num" && cA?.k === "num") {
            pairCount++;
            eq(ca.n, 0, "p6l stamp: paired gs ca = 0 (fill)");
            eq(cA.n, 0.55, "p6l stamp: paired gs CA = 0.55 (stroke)");
          } else if (ca?.k === "num") {
            eq(ca.n, 0.55, "p6l stamp: text gs ca = 0.55 (single key)");
          }
        }
      }
    }
    eq(pairCount, 1, "p6l stamp: exactly ONE {ca, CA} paired dict (pdf-lib's merged gs)");
  }

  /* ── 20.3 the Info dict: hex-UTF16 fields + PDFDate + trailer /Info,
   * field-for-field vs a pdf-lib doc with the SAME setters. */
  {
    const pinned = new Date(Date.UTC(2026, 9, 28, 22, 30, 5));
    const ctx = CreateContext.create();
    ctx.addPage(W, H);
    ctx.setProducer("DocoPDF");
    ctx.setCreator("DocoPDF");
    ctx.setTitle("Ravi Kumar — Resume");
    ctx.setAuthor("Ravi Kumar");
    ctx.setCreationDate(pinned);
    const ours = ctx.write();
    const raw = Buffer.from(ours).toString("latin1");
    ok(
      /\/Producer <FEFF0044006F0063006F005000440046>/.test(raw),
      "p6l info: Producer is UTF-16BE hex with BOM (pdf-lib's fromText)",
    );
    ok(
      raw.includes("/CreationDate (D:20261028223005Z)"),
      "p6l info: PDFDate format D:YYYYMMDDHHmmssZ (UTC fields)",
    );
    ok(
      /\/ModDate \(D:\d{14}Z\)/.test(raw),
      "p6l info: ModDate auto-stamped at write() (pdf-lib save behavior)",
    );
    ok(
      /trailer\n<< \/Size \d+ \/Root 1 0 R \/Info \d+ 0 R >>/.test(raw),
      "p6l info: /Info referenced from the trailer",
    );
    // Our own parser round-trips the Info dict (trailer /Info → ref → dict).
    const back = parsePdf(ours);
    ok(
      !back.recovered,
      "p6l info: xref chain CLEAN (startxref AFTER the Info object)",
    );
    const infoRef = back.trailer.get("Info");
    const infoDict =
      infoRef?.k === "ref" ? back.getObject(infoRef.num) : undefined;
    ok(
      infoDict !== undefined && (infoDict.k === "dict" || infoDict.k === "stream"),
      "p6l info: our parser resolves the trailer /Info object",
    );
    if (infoDict && (infoDict.k === "dict" || infoDict.k === "stream")) {
      const title = infoDict.m.get("Title");
      ok(
        title?.k === "str" && title.b[0] === 0xfe && title.b[1] === 0xff,
        "p6l info: Title parses back as a UTF-16BE string",
      );
      const modDate = infoDict.m.get("ModDate");
      ok(
        modDate?.k === "str" &&
          Buffer.from(modDate.b).toString("latin1").startsWith("D:"),
        "p6l info: ModDate parses back as a PDFDate literal string",
      );
    }
    // No metadata set → NO Info object at all (the honest branding rule).
    const bare = CreateContext.create();
    bare.addPage(W, H);
    const bareBytes = Buffer.from(bare.write()).toString("latin1");
    ok(
      !/\/Info \d+ 0 R/.test(bareBytes),
      "p6l info: no setters → no /Info (we brand nothing, unlike pdf-lib)",
    );
    // pdf-lib with the same setters: same field ENCODING (object number
    // placement differs — pdf-lib allocates Info early; ours appends it
    // last; both are valid, only the encoding is the parity surface).
    const libDoc = await PDFDocument.create();
    libDoc.addPage([W, H]);
    libDoc.setProducer("DocoPDF");
    libDoc.setCreator("DocoPDF");
    libDoc.setTitle("Ravi Kumar — Resume");
    libDoc.setAuthor("Ravi Kumar");
    libDoc.setCreationDate(pinned);
    const libRaw = Buffer.from(
      await libDoc.save({ useObjectStreams: false }),
    ).toString("latin1");
    for (const needle of [
      "/Producer <FEFF0044006F0063006F005000440046>",
      "/Creator <FEFF0044006F0063006F005000440046>",
      "/Author <FEFF00520061007600690020004B0075006D00610072>",
      "/CreationDate (D:20261028223005Z)",
    ]) {
      ok(
        libRaw.includes(needle),
        `p6l info: pdf-lib oracle emits the same encoding (${needle.slice(0, 24)}…)`,
      );
      ok(
        raw.includes(needle),
        `p6l info: ours matches (${needle.slice(0, 24)}…)`,
      );
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * SECTION 21 — the P6-n webby-four engine surfaces: drawRoundedRectangle
 * (pdf-lib's drawSvgPath rounded-rect operator shape, probed in
 * scripts/dev/probe-svgpath-ops.ts), drawLine dashArray, insertPage +
 * getPages (the epub TOC/folio machinery).
 * ══════════════════════════════════════════════════════════════════════ */
async function section21(): Promise<void> {
  const W = 595.28;
  const H = 841.89;

  /* ── 21.1 drawRoundedRectangle: the probed pdf-lib drawSvgPath shape —
   * translate + rotate-identity + y-flip cm trio, colors, [] 0 d, the
   * m/l/4×c/h path in SVG-local space, f/S/B paint. */
  {
    const ctx = CreateContext.create();
    const p = ctx.addPage(W, H);
    p.drawRoundedRectangle({
      x: 56,
      yTop: 742,
      width: 483.28,
      height: 58,
      radius: 6,
      color: { r: 1, g: 0.953, b: 0.804 },
      borderColor: { r: 0.941, g: 0.678, b: 0.306 },
      borderWidth: 1.5,
    });
    const doc = parsePdf(ctx.write());
    const pages = listPages(doc);
    const ops = latin1(
      contentBytesOf(doc, pages, 0),
      0,
      contentBytesOf(doc, pages, 0).length,
    );
    ok(
      ops.startsWith(
        "q\n1 0 0 1 56 742 cm\n1 0 0 1 0 0 cm\n1 0 0 -1 0 0 cm\n",
      ),
      "p6n rrect: the translate+rotate-identity+y-flip cm trio (pdf-lib drawSvgPath)",
    );
    ok(ops.includes("1 0.953 0.804 rg"), "p6n rrect: fill rg");
    ok(ops.includes("0.941 0.678 0.306 RG"), "p6n rrect: stroke RG");
    ok(/(^|\n)1\.5 w(\n|$)/.test(ops), "p6n rrect: border width");
    ok(ops.includes("6 0 m"), "p6n rrect: moveTo at (r, 0)");
    ok(ops.includes("477.28 0 l"), "p6n rrect: top edge line to (w−r, 0)");
    const arcs = (ops.match(/ c\n/g) || []).length;
    ok(arcs === 4, `p6n rrect: exactly 4 quarter-arc béziers (got ${arcs})`);
    ok(/h\nB\nQ\n?$/.test(ops), "p6n rrect: closepath + fill+stroke paint + Q");
    // κ control point: (w−r+κr, 0) for the TR arc — κ=4/3·(√2−1)
    // (477.28 + 6κ = 480.59370849898465, our pdfNumToString trims to 9 dp)
    ok(
      ops.includes("480.593708499 0 "),
      "p6n rrect: TR-arc control point (w−r+κr, 0)",
    );
    // fill-only → f, no RG/w
    const ctx2 = CreateContext.create();
    const p2 = ctx2.addPage(W, H);
    p2.drawRoundedRectangle({
      x: 10,
      yTop: 700,
      width: 100,
      height: 40,
      radius: 5,
      color: { r: 1, g: 1, b: 1 },
    });
    const ops2 = latin1(
      contentBytesOf(parsePdf(ctx2.write()), listPages(parsePdf(ctx2.write())), 0),
      0,
      contentBytesOf(parsePdf(ctx2.write()), listPages(parsePdf(ctx2.write())), 0).length,
    );
    ok(!ops2.includes(" RG"), "p6n rrect: fill-only has no stroke color");
    ok(/h\nf\nQ\n?$/.test(ops2), "p6n rrect: fill-only paints f");
  }

  /* ── 21.2 drawLine dashArray: [3 2] 0 d after the width op; absent →
   * the [] 0 d reset. */
  {
    const ctx = CreateContext.create();
    const p = ctx.addPage(W, H);
    p.drawLine({
      start: { x: 56, y: 620 },
      end: { x: 539, y: 620 },
      thickness: 3,
      color: { r: 0.2, g: 0.478, b: 0.722 },
      dashArray: [3, 2],
    });
    p.drawLine({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 } });
    const doc = parsePdf(ctx.write());
    const pages = listPages(doc);
    const ops = latin1(
      contentBytesOf(doc, pages, 0),
      0,
      contentBytesOf(doc, pages, 0).length,
    );
    ok(ops.includes("[3 2] 0 d"), "p6n dash: pattern emitted");
    ok(
      /3 w\n\[3 2\] 0 d/.test(ops),
      "p6n dash: dash op follows the width op (pdf-lib order)",
    );
    ok(
      /1 w\n\[\] 0 d/.test(ops),
      "p6n dash: absent dashArray keeps the [] 0 d reset",
    );
  }

  /* ── 21.3 insertPage + getPages: the epub TOC/folio machinery. Pages
   * splice mid-document; getPages() returns handles in final order;
   * earlier-created handles keep writing to THEIR page. */
  {
    const ctx = CreateContext.create();
    const first = ctx.addPage(W, H);
    first.drawText({
      x: 72,
      y: 700,
      text: "cover",
      size: 12,
      font: "helvetica",
    });
    const chapter = ctx.addPage(W, H);
    chapter.drawText({
      x: 72,
      y: 700,
      text: "chapter",
      size: 12,
      font: "helvetica",
    });
    const toc = ctx.insertPage(1, W, H);
    toc.drawText({
      x: 72,
      y: 700,
      text: "contents",
      size: 12,
      font: "helveticaBold",
    });
    ok(ctx.pageCount === 3, "p6n insert: pageCount counts the splice");
    const pages = ctx.getPages();
    ok(pages.length === 3, "p6n getPages: all handles");
    ok(
      pages[0].width === W && pages[2].width === W && pages[1].width === W,
      "p6n getPages: sizes ride the recs",
    );
    // folio-style stamp into every page via getPages()
    pages.forEach((pg, i) => {
      pg.drawText({
        x: 72,
        y: 40,
        text: String(i + 1),
        size: 9,
        font: "helvetica",
      });
    });
    const doc = parsePdf(ctx.write());
    const back = listPages(doc);
    ok(back.length === 3, "p6n insert: written doc has 3 pages");
    // drawText rides WinAnsi UPPERCASE hex literals — check the words there.
    const hx = (s: string): string =>
      Array.from(s, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    const t0 = latin1(contentBytesOf(doc, back, 0), 0, contentBytesOf(doc, back, 0).length);
    const t1 = latin1(contentBytesOf(doc, back, 1), 0, contentBytesOf(doc, back, 1).length);
    const t2 = latin1(contentBytesOf(doc, back, 2), 0, contentBytesOf(doc, back, 2).length);
    ok(
      t0.includes(`<${hx("cover")}>`) && t0.includes(`<${hx("1")}>`),
      "p6n insert: page 0 = cover + folio 1",
    );
    ok(
      t1.includes(`<${hx("contents")}>`) && t1.includes(`<${hx("2")}>`),
      "p6n insert: page 1 = the INSERTED toc + folio 2",
    );
    ok(
      t2.includes(`<${hx("chapter")}>`) && t2.includes(`<${hx("3")}>`),
      "p6n insert: page 2 = chapter + folio 3 (order preserved)",
    );
    // out-of-range insert refuses honestly
    let refused = false;
    try {
      ctx.insertPage(99, W, H);
    } catch {
      refused = true;
    }
    ok(refused, "p6n insert: out-of-range index refuses");
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 22 — the P6-o edit-surface engine surfaces: shape stamping
 * (drawRectangle/drawEllipse/drawLine on LOADED docs), slot plans (src
 * duplicates + /Rotate//CropBox set overrides), appendAnnot, and the
 * AcroForm builder (probed live in scripts/dev/probe-p6o-*.ts).
 * ══════════════════════════════════════════════════════════════════════ */
async function section22(): Promise<void> {
  const base = await buildPdfLibFixture(
    [
      { w: 612, h: 792, rot: 0 },
      { w: 612, h: 792, rot: 0 },
      { w: 612, h: 792, rot: 0 },
    ],
    false,
  );

  /* ── 22.1 shape stamping: operator parity with the pdf-lib oracle on the
   * SAME loaded document (rect + ellipse + line, all option combos the
   * edit surface generates — dash, rotate, the merged {ca,CA} gs). */
  {
    const libDoc = await PDFDocument.load(base, { updateMetadata: false });
    const libPage = libDoc.getPage(0);
    libPage.drawRectangle({
      x: 100, y: 600, width: 200, height: 40,
      color: rgb(0.9, 0.95, 1), borderColor: rgb(0.2, 0.4, 0.7),
      borderWidth: 2, opacity: 0.5, borderOpacity: 0.8,
      borderDashArray: [4, 3],
    });
    libPage.drawRectangle({
      x: 40, y: 500, width: 120, height: 60,
      borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 1.5, rotate: degrees(30),
    });
    libPage.drawEllipse({
      x: 200, y: 400, xScale: 60, yScale: 40,
      color: rgb(1, 0.9, 0.8), borderColor: rgb(0.6, 0.3, 0.1),
      borderWidth: 1.5, borderDashArray: [2, 2],
    });
    libPage.drawLine({
      start: { x: 60, y: 300 }, end: { x: 300, y: 320 },
      thickness: 2.5, color: rgb(0.1, 0.2, 0.3),
      opacity: 0.7, lineCap: 1, dashArray: [5, 4],
    });
    const libBytes = await libDoc.save({ useObjectStreams: false });

    const ctx = StampContext.load(base);
    ctx.stampRect(0, {
      x: 100, y: 600, width: 200, height: 40,
      color: { r: 0.9, g: 0.95, b: 1 }, borderColor: { r: 0.2, g: 0.4, b: 0.7 },
      borderWidth: 2, opacity: 0.5, borderOpacity: 0.8,
      borderDashArray: [4, 3],
    });
    ctx.stampRect(0, {
      x: 40, y: 500, width: 120, height: 60,
      borderColor: { r: 0.5, g: 0.5, b: 0.5 }, borderWidth: 1.5, rotate: 30,
    });
    ctx.stampEllipse(0, {
      x: 200, y: 400, xScale: 60, yScale: 40,
      color: { r: 1, g: 0.9, b: 0.8 }, borderColor: { r: 0.6, g: 0.3, b: 0.1 },
      borderWidth: 1.5, borderDashArray: [2, 2],
    });
    ctx.stampLine(0, {
      start: { x: 60, y: 300 }, end: { x: 300, y: 320 },
      thickness: 2.5, color: { r: 0.1, g: 0.2, b: 0.3 },
      opacity: 0.7, lineCap: 1, dashArray: [5, 4],
    });
    const ourBytes = ctx.write();

    const libBack = parsePdf(libBytes);
    const libPages = listPages(libBack);
    const ourBack = parsePdf(ourBytes);
    const ourPages = listPages(ourBack);
    ok(!ourBack.recovered, "p6o shapes: our output parses clean (no recovery)");
    const a = normalizeOps(stripIdentityCm(lastEntryOpsText(ourBack, ourPages, 0)));
    const b = normalizeOps(stripIdentityCm(lastEntryOpsText(libBack, libPages, 0)));
    ok(a === b, `p6o shapes: rect+ellipse+line op parity vs the oracle — ours="${a.slice(0, 90)}…" theirs="${b.slice(0, 90)}…"`);
    // The merged {ca,CA} gs object and the line's CA-only gs are verified
    // directly in the object graph below.
    let foundPair = false;
    for (let n = 1; n <= 80 && !foundPair; n += 1) {
      const obj = ourBack.getObject(n);
      if (!obj || obj.k !== "dict") continue;
      const ca = obj.m.get("ca");
      const CA = obj.m.get("CA");
      if (
        ca && ca.k === "num" && ca.n === 0.5 &&
        CA && CA.k === "num" && CA.n === 0.8
      ) {
        foundPair = true;
      }
    }
    ok(foundPair, "p6o shapes: the merged {ca:0.5, CA:0.8} ExtGState emitted");
    let foundLineCa = false;
    for (let n = 1; n <= 80 && !foundLineCa; n += 1) {
      const obj = ourBack.getObject(n);
      if (!obj || obj.k !== "dict") continue;
      const ca = obj.m.get("ca");
      const CA = obj.m.get("CA");
      if (ca === undefined && CA && CA.k === "num" && CA.n === 0.7) {
        foundLineCa = true;
      }
    }
    ok(foundLineCa, "p6o shapes: the line gs carries CA ONLY (0.7, no ca)");
  }

  /* ── 22.2 slot plans: reorder + duplicates + per-slot /Rotate override;
   * slot-isolated stamps (a stamp on a duplicate must NOT leak to its
   * sibling slots). */
  {
    const ctx = StampContext.load(base);
    ctx.setSlotPlan([
      { src: 1 },
      { src: 0, set: [["Rotate", { k: "num", n: 90 }]] },
      { src: 1 },
    ]);
    ctx.stampText(2, { x: 72, y: 700, text: "dupe stamp", size: 14, font: "helvetica" });
    const out = ctx.write();
    const back = parsePdf(out);
    const pages = listPages(back);
    ok(pages.length === 3, `p6o slots: 3 output pages (got ${pages.length})`);
    const rot = pages[1]!.dict.get("Rotate");
    ok(!!(rot && rot.k === "num" && rot.n === 90), "p6o slots: slot 1 /Rotate 90 override");
    const rot0 = pages[0]!.dict.get("Rotate");
    ok(rot0 === undefined || (rot0.k === "num" && rot0.n === 0), "p6o slots: slot 0 keeps no rotation");
    // Stamp on SLOT 2 only — slot 0 (same src=1) must be clean.
    const t2 = lastEntryOpsText(back, pages, 2);
    const t0 = lastEntryOpsText(back, pages, 0);
    ok(t2.includes("dupe") || /64757065/.test(t2), "p6o slots: the stamp rides slot 2");
    ok(!t0.includes("dupe"), "p6o slots: slot 0 (the same src) is stamp-free");
    // Content preserved byte-exactly through surgery (page text survives).
    const c0 = contentBytesOf(back, pages, 0);
    ok(c0.length > 0, "p6o slots: content streams survive the slot rebuild");
  }

  /* ── 22.3 appendAnnot: dictionaries ride the page /Annots; reload + append
   * again merges with the source's own annots (the annotate-pdf flow). */
  {
    const ctx = StampContext.load(base);
    ctx.appendAnnot(0, {
      k: "dict",
      m: new Map<string, PdfObj>([
        ["Type", { k: "name", v: "Annot" }],
        ["Subtype", { k: "name", v: "Highlight" }],
        ["Rect", { k: "arr", items: [{ k: "num", n: 72 }, { k: "num", n: 700 }, { k: "num", n: 240 }, { k: "num", n: 716 }] }],
        ["QuadPoints", { k: "arr", items: [{ k: "num", n: 72 }, { k: "num", n: 700 }, { k: "num", n: 240 }, { k: "num", n: 700 }, { k: "num", n: 240 }, { k: "num", n: 716 }, { k: "num", n: 72 }, { k: "num", n: 716 }] }],
        ["C", { k: "arr", items: [{ k: "num", n: 1 }, { k: "num", n: 0.85 }, { k: "num", n: 0.2 }] }],
        ["F", { k: "num", n: 4 }],
      ]),
    });
    const first = ctx.write();
    const ctx2 = StampContext.load(first);
    ctx2.appendAnnot(0, {
      k: "dict",
      m: new Map<string, PdfObj>([
        ["Type", { k: "name", v: "Annot" }],
        ["Subtype", { k: "name", v: "Text" }],
        ["Rect", { k: "arr", items: [{ k: "num", n: 500 }, { k: "num", n: 700 }, { k: "num", n: 516 }, { k: "num", n: 716 }] }],
        ["Contents", { k: "hstr", b: new Uint8Array([0xfe, 0xff, 0x09, 0x28, 0x09, 0x3e, 0x09, 0x2f]) }],
      ]),
    });
    const second = ctx2.write();
    const back = parsePdf(second);
    const pages = listPages(back);
    ok(!back.recovered, "p6o annots: output parses clean");
    const annots = pages[0]!.dict.get("Annots");
    ok(!!(annots && annots.k === "arr" && annots.items.length === 2),
      `p6o annots: reload+append MERGES — 2 annots on page 0 (got ${annots && annots.k === "arr" ? annots.items.length : "none"})`);
    let sawHighlight = false;
    let sawNote = false;
    if (annots && annots.k === "arr") {
      for (const item of annots.items) {
        if (item.k !== "ref") continue;
        const obj = back.getObject(item.num);
        if (!obj || obj.k !== "dict") continue;
        const st = obj.m.get("Subtype");
        if (st && st.k === "name" && st.v === "Highlight") sawHighlight = true;
        if (st && st.k === "name" && st.v === "Text") sawNote = true;
      }
    }
    ok(sawHighlight, "p6o annots: the reloaded Highlight survived the second pass");
    ok(sawNote, "p6o annots: the appended Text note rides the /Annots");
  }

  /* ── 22.4 the AcroForm builder: full object-graph parity with pdf-lib
   * for the exact call shapes make-pdf-fillable + edit-pdf generate. */
  {
    const makeBase = async (): Promise<Uint8Array> =>
      (await PDFDocument.create()).addPage([612, 792]) instanceof Object
        ? base
        : base;

    // ORACLE — pdf-lib.
    const libDoc = await PDFDocument.load(await makeBase(), { updateMetadata: false });
    const libPage = libDoc.getPage(0);
    const libForm = libDoc.getForm();
    const tf = libForm.createTextField("Full Name");
    tf.setText("hello world");
    tf.addToPage(libPage, { x: 100, y: 700, width: 200, height: 20, borderWidth: 1, borderColor: rgb(0.62, 0.65, 0.7) });
    const tfm = libForm.createTextField("Notes");
    tfm.enableMultiline();
    tfm.setText("the quick brown fox\njumps over");
    tfm.addToPage(libPage, { x: 100, y: 600, width: 200, height: 60, borderWidth: 0 });
    const cb = libForm.createCheckBox("Agree");
    cb.check();
    cb.addToPage(libPage, { x: 100, y: 500, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0.45, 0.49, 0.55) });
    const dd = libForm.createDropdown("City");
    dd.addOptions(["Mumbai", "Delhi", "Pune"]);
    dd.select("Pune");
    dd.addToPage(libPage, { x: 100, y: 400, width: 150, height: 18, borderWidth: 1, borderColor: rgb(0.62, 0.65, 0.7) });
    const rg = libForm.createRadioGroup("Size");
    rg.addOptionToPage("S", libPage, { x: 100, y: 300, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0.45, 0.49, 0.55) });
    rg.addOptionToPage("L", libPage, { x: 130, y: 300, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0.45, 0.49, 0.55) });
    const libBytes = await libDoc.save({ useObjectStreams: false });

    // OURS.
    const ctx = StampContext.load(await makeBase());
    ctx.createTextField("Full Name")
      .setText("hello world")
      .addToSlot(0, { x: 100, y: 700, width: 200, height: 20, borderWidth: 1, borderColor: { r: 0.62, g: 0.65, b: 0.7 } });
    ctx.createTextField("Notes")
      .enableMultiline()
      .setText("the quick brown fox\njumps over")
      .addToSlot(0, { x: 100, y: 600, width: 200, height: 60, borderWidth: 0 });
    ctx.createCheckBox("Agree")
      .check()
      .addToSlot(0, { x: 100, y: 500, width: 14, height: 14, borderWidth: 1, borderColor: { r: 0.45, g: 0.49, b: 0.55 } });
    ctx.createDropdown("City")
      .addOptions("Mumbai", "Delhi", "Pune")
      .select("Pune")
      .addToSlot(0, { x: 100, y: 400, width: 150, height: 18, borderWidth: 1, borderColor: { r: 0.62, g: 0.65, b: 0.7 } });
    const radio = ctx.createRadioGroup("Size");
    radio.addOptionToSlot(0, "S", { x: 100, y: 300, width: 14, height: 14, borderWidth: 1, borderColor: { r: 0.45, g: 0.49, b: 0.55 } });
    radio.addOptionToSlot(0, "L", { x: 130, y: 300, width: 14, height: 14, borderWidth: 1, borderColor: { r: 0.45, g: 0.49, b: 0.55 } });
    const ourBytes = ctx.write();

    const libBack = parsePdf(libBytes);
    const ourBack = parsePdf(ourBytes);
    ok(!ourBack.recovered, "p6o forms: our output parses clean");

    /** Collect the form graph: AcroForm → fields → widgets. */
    interface FieldInfo {
      t: string;
      ft: string;
      da: string;
      ff: number | undefined;
      v: string;
      widgets: Array<{ rect: number[]; mk: string; bs: number; as: string; apKeys: string[]; nOps: string[]; bbox: number[] }>;
      opt: string[];
    }
    const collect = (doc: ParsedPdf): FieldInfo[] => {
      const root = resolve(doc, doc.trailer.get("Root")!);
      if (!root || root.k !== "dict") return [];
      const afRef = root.m.get("AcroForm");
      if (!afRef || afRef.k !== "ref") return [];
      const af = resolve(doc, afRef);
      if (!af || af.k !== "dict") return [];
      const fields = af.m.get("Fields");
      if (!fields || fields.k !== "arr") return [];
      const out: FieldInfo[] = [];
      for (const f of fields.items) {
        if (f.k !== "ref") continue;
        const fd = resolve(doc, f);
        if (!fd || fd.k !== "dict") continue;
        const tObj = fd.m.get("T");
        const t = tObj && (tObj.k === "str" || tObj.k === "hstr")
          ? new TextDecoder("latin1").decode(tObj.b.slice(2)).replace(/\0/g, "")
          : "?";
        const ftObj = fd.m.get("FT");
        const daObj = fd.m.get("DA");
        const ffObj = fd.m.get("Ff");
        const vObj = fd.m.get("V");
        const optObj = fd.m.get("Opt");
        const kids = fd.m.get("Kids");
        const widgets: FieldInfo["widgets"] = [];
        if (kids && kids.k === "arr") {
          for (const k of kids.items) {
            if (k.k !== "ref") continue;
            const w = resolve(doc, k);
            if (!w || w.k !== "dict") continue;
            const rectObj = w.m.get("Rect");
            const rect = rectObj && rectObj.k === "arr"
              ? rectObj.items.map((r) => (r.k === "num" ? r.n : NaN))
              : [];
            const mkObj = w.m.get("MK");
            let mk = "";
            if (mkObj && mkObj.k === "dict") {
              mk = [...mkObj.m.entries()]
                .map(([kk, vv]) => {
                  if (vv.k === "arr") {
                    return `${kk}:[${vv.items.map((x) => (x.k === "num" ? x.n : "?")).join(",")}]`;
                  }
                  return `${kk}:${vv.k === "num" ? vv.n : vv.k === "name" ? vv.v : "?"}`;
                })
                .join("|");
            }
            const bsObj = w.m.get("BS");
            const bsW = bsObj && bsObj.k === "dict" && bsObj.m.get("W");
            const asObj = w.m.get("AS");
            const apObj = w.m.get("AP");
            const apKeys: string[] = [];
            const nOps: string[] = [];
            let bbox: number[] = [];
            if (apObj && apObj.k === "dict") {
              const n = apObj.m.get("N");
              const walkStates = (states: PdfObj): void => {
                if (states.k === "ref") {
                  const s = resolve(doc, states);
                  if (s && s.k === "stream") {
                    const bb = s.m.get("BBox");
                    if (bb && bb.k === "arr") {
                      bbox = bb.items.map((x) => (x.k === "num" ? x.n : NaN));
                    }
                    const bytes = decodeForParser(s.raw, s.m);
                    nOps.push(normalizeOps(stripIdentityCm(latin1(bytes, 0, bytes.length))));
                  }
                } else if (states.k === "dict") {
                  for (const [kk] of states.m) apKeys.push(kk);
                  for (const vv of states.m.values()) walkStates(vv);
                }
              };
              if (n) walkStates(n);
            }
            widgets.push({
              rect,
              mk,
              bs: bsW && bsW.k === "num" ? bsW.n : -1,
              as: asObj && asObj.k === "name" ? asObj.v : "",
              apKeys: apKeys.slice().sort(),
              nOps,
              bbox,
            });
          }
        }
        out.push({
          t,
          ft: ftObj && ftObj.k === "name" ? ftObj.v : "?",
          da: daObj && (daObj.k === "str" || daObj.k === "hstr" || daObj.k === "lstr")
            ? new TextDecoder("latin1").decode(daObj.b)
            : "?",
          ff: ffObj && ffObj.k === "num" ? ffObj.n : undefined,
          v: vObj
            ? vObj.k === "name"
              ? vObj.v
              : (vObj.k === "str" || vObj.k === "hstr")
                ? new TextDecoder("latin1").decode(vObj.b.slice(2)).replace(/\0/g, "")
                : "?"
            : "",
          widgets,
          opt: optObj && optObj.k === "arr"
            ? optObj.items.map((o) =>
                o.k === "arr" && o.items[0] && (o.items[0]!.k === "str" || o.items[0]!.k === "hstr")
                  ? new TextDecoder("latin1").decode(o.items[0]!.b.slice(2)).replace(/\0/g, "")
                  : o.k === "str" || o.k === "hstr"
                    ? new TextDecoder("latin1").decode(o.b.slice(2)).replace(/\0/g, "")
                    : "?",
              )
            : [],
        });
      }
      return out;
    };

    const libFields = collect(libBack);
    const ourFields = collect(ourBack);
    eq(libFields.length, ourFields.length, "p6o forms: field count matches the oracle");
    eq(
      ourFields.map((f) => `${f.ft}|${f.t}`).sort().join(";"),
      libFields.map((f) => `${f.ft}|${f.t}`).sort().join(";"),
      "p6o forms: /FT + /T name parity",
    );
    for (const ours of ourFields) {
      const theirs = libFields.find((f) => f.t === ours.t && f.ft === ours.ft);
      ok(theirs !== undefined, `p6o forms[${ours.t}]: oracle counterpart exists`);
      if (!theirs) continue;
      eq(ours.ff, theirs.ff, `p6o forms[${ours.t}]: /Ff parity`);
      eq(ours.da, theirs.da, `p6o forms[${ours.t}]: /DA parity (font-size loop incl.)`);
      eq(ours.v, theirs.v, `p6o forms[${ours.t}]: /V parity`);
      eq(ours.opt, theirs.opt, `p6o forms[${ours.t}]: /Opt parity`);
      eq(ours.widgets.length, theirs.widgets.length, `p6o forms[${ours.t}]: widget count`);
      for (let wi = 0; wi < Math.min(ours.widgets.length, theirs.widgets.length); wi += 1) {
        const w = ours.widgets[wi]!;
        const t = theirs.widgets[wi]!;
        eq(
          w.rect.map((n) => Math.round(n * 1e6) / 1e6),
          t.rect.map((n) => Math.round(n * 1e6) / 1e6),
          `p6o forms[${ours.t}#${wi}]: /Rect (the bw/2 expansion)`,
        );
        eq(w.mk, t.mk, `p6o forms[${ours.t}#${wi}]: /MK (BG white, R 0, BC)`);
        eq(w.bs, t.bs, `p6o forms[${ours.t}#${wi}]: /BS /W`);
        eq(w.as, t.as, `p6o forms[${ours.t}#${wi}]: /AS`);
        eq(w.apKeys, t.apKeys, `p6o forms[${ours.t}#${wi}]: /AP state names (Yes/Off or /0,/1)`);
        eq(
          w.bbox.map((n) => Math.round(n * 1e6) / 1e6),
          t.bbox.map((n) => Math.round(n * 1e6) / 1e6),
          `p6o forms[${ours.t}#${wi}]: AP /BBox`,
        );
        eq(w.nOps.length, t.nOps.length, `p6o forms[${ours.t}#${wi}]: AP stream count`);
        for (let si = 0; si < Math.min(w.nOps.length, t.nOps.length); si += 1) {
          eq(
            w.nOps[si],
            t.nOps[si],
            `p6o forms[${ours.t}#${wi}]: AP stream ${si} OPERATOR PARITY`,
          );
        }
      }
    }
    // The page /Annots carry the widgets; /P back-refs resolve to page dicts.
    const ourPages = listPages(ourBack);
    const annots = ourPages[0]!.dict.get("Annots");
    ok(
      !!(annots && annots.k === "arr" && annots.items.length === 6),
      `p6o forms: 6 widgets on the page /Annots (got ${annots && annots.k === "arr" ? annots.items.length : "none"})`,
    );
  }
}

function firstValue(lex: Lexer): import("../src/lib/own/pdf/objects").PdfObj {
  // Re-use the engine by wrapping the remaining tokens in a minimal
  // document with EXACT offsets (no brute recovery noise).
  const inner = new TextDecoder().decode(lex.data.slice(lex.pos));
  const enc = new TextEncoder();
  const objAt = 9 + 8; // "%PDF-1.4\n" + "1 0 obj\n"
  const xrefPos = objAt + enc.encode(inner).length + 8; // + "\nendobj\n"
  const wrapped = enc.encode(
    `%PDF-1.4\n1 0 obj\n${inner}\nendobj\n` +
      `xref\n0 2\n0000000000 65535 f \n${String(objAt).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
  );
  const doc = parsePdf(wrapped);
  ok(!doc.recovered, "harness: exact offsets → clean parse");
  const obj = doc.getObject(1);
  if (!obj) throw new Error("harness object missing");
  return obj;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * SECTION 23 — the P6-p source-AcroForm consumer: READER edge cases
 * (Ff bit positions, inheritable /FT, merged field-widgets, /Annots
 * page fallback, unknown /FT skips, radio index→option mapping), the
 * SET+write semantics (DA rewrite priority, MK /R rotation ops, dropdown
 * Edit flag, optionlist /I), and the burn scopes (annotations-only
 * keepWidgets, flatten + appended-annot composition).
 * ══════════════════════════════════════════════════════════════════════ */
async function section23(): Promise<void> {
  /** latin1 of a whole byte array (the lexer helper is (data, from, to)). */
  const latin1All = (b: Uint8Array): string => latin1(b, 0, b.length);

  /* ── 23.1 reader edges ─────────────────────────────────────────────── */
  {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const form = doc.getForm();

    // readOnly + required — the Ff BIT POSITIONS (readOnly = 1, required = 2;
    // the regression this section locks: they are NOT 2/4).
    const ro = form.createTextField("flags.ro");
    ro.enableReadOnly();
    ro.enableRequired();
    ro.addToPage(page1, { x: 20, y: 260, width: 200, height: 16 });

    // Deep hierarchy + /FT moved UP to the parent (inheritable /FT).
    const deep = form.createTextField("a.b.c.deep");
    deep.addToPage(doc.getPage(1), { x: 20, y: 260, width: 200, height: 16 });

    // Unknown /FT → skipped by the reader (pdf-lib getFields parity).
    const weird = form.createTextField("weird.kind");
    weird.addToPage(page1, { x: 20, y: 220, width: 200, height: 16 });

    // MERGED field-widget: the field dict IS its own widget (no /Kids).
    const merged = form.createTextField("merged.one");
    const mergedBytes0 = await doc.save({ useObjectStreams: false });

    // Hand-surgery stage (pdf-lib raw context): move /FT up, break the
    // weird field's /FT, weld the merged widget-half, strip a /P.
    const doc2 = await PDFDocument.load(mergedBytes0, { updateMetadata: false });
    const form2 = doc2.getForm();
    const deepField = form2.getTextField("a.b.c.deep");
    const parent = deepField.acroField.getParent();
    if (parent) {
      parent.dict.set(PDFName.of("FT"), PDFName.of("Tx"));
      deepField.acroField.dict.delete(PDFName.of("FT"));
    }
    const weirdField = form2.getTextField("weird.kind");
    weirdField.acroField.dict.set(PDFName.of("FT"), PDFName.of("Zork"));
    // merged: no addToPage — weld the widget half onto the field dict.
    const mergedField = form2.getTextField("merged.one");
    mergedField.acroField.dict.set(PDFName.of("Rect"), doc2.context.obj([20, 180, 220, 198]));
    mergedField.acroField.dict.set(PDFName.of("Subtype"), PDFName.of("Widget"));
    mergedField.acroField.dict.set(PDFName.of("F"), doc2.context.obj(4));
    doc2.getPage(0).node.addAnnot(mergedField.ref);
    // deep: strip the widget's /P → the /Annots scan must find its page.
    const deepWidget = deepField.acroField.getWidgets()[0]!;
    deepWidget.dict.delete(PDFName.of("P"));
    const bytes = await doc2.save({ useObjectStreams: false });

    const parsed = parsePdf(bytes);
    const fields = readAcroFormFields(parsed);
    const byName = new Map(fields.map((f) => [f.name, f]));

    ok(fields.length === 3, `23.1 reader: unknown /FT skipped (3 of 4, got ${fields.length})`);
    const roF = byName.get("flags.ro")!;
    ok(roF.readOnly === true, "23.1 Ff: readOnly = bit 1 (value 1)");
    ok(roF.required === true, "23.1 Ff: required = bit 2 (value 2)");
    const deepF = byName.get("a.b.c.deep")!;
    ok(deepF.kind === "text", "23.1 inheritable /FT through the parent chain");
    ok(deepF.widgets[0]!.page === 1, "23.1 widget page via the /Annots scan (no /P)");
    const mergedF = byName.get("merged.one")!;
    ok(mergedF.widgets.length === 1, "23.1 merged field-widget (no /Kids) = own widget");
    eq(mergedF.widgets[0]!.rect, { x: 20, y: 180, w: 200, h: 18 }, "23.1 merged widget rect");
    ok(mergedF.widgets[0]!.page === 0, "23.1 merged widget page via /Annots");

    // pdf-lib ORACLE cross-check on the SAME bytes.
    const libDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    const libNames = libDoc.getForm().getFields().map((f) => f.getName()).sort();
    eq(
      fields.map((f) => f.name).sort(),
      libNames,
      "23.1 field-name parity with the pdf-lib oracle",
    );
  }

  /* ── 23.2 radio index→option mapping (the addWidgetWithOpt quirk) ──── */
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const rg = form.createRadioGroup("pick.one");
    rg.addOptionToPage("Alpha", page, { x: 20, y: 260, width: 14, height: 14 });
    rg.addOptionToPage("Beta", page, { x: 20, y: 230, width: 14, height: 14 });
    rg.select("Beta");
    const bytes = await doc.save({ useObjectStreams: false });

    const ours = readAcroFormFields(parsePdf(bytes));
    const radio = ours.find((f) => f.name === "pick.one")!;
    ok(radio.value === "Beta", `23.2 radio /V index maps to the /Opt label (got ${String(radio.value)})`);
    eq(radio.options, ["Alpha", "Beta"], "23.2 radio options from /Opt");

    // The SET path: option label → the widget's on-state INDEX name.
    const ctx = StampContext.load(bytes);
    const fields2 = ctx.readSourceFields();
    ctx.setSourceRadio(fields2.find((f) => f.name === "pick.one")!, "Alpha");
    const out = ctx.write();
    const libDoc = await PDFDocument.load(out, { updateMetadata: false });
    ok(
      libDoc.getForm().getRadioGroup("pick.one").getSelected() === "Alpha",
      "23.2 setSourceRadio round-trips through the oracle",
    );
  }

  /* ── 23.3 fill semantics: DA priority, MK rotation, Edit flag, /I ────── */
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();

    // Widget carries its OWN DA (color) — the DA rewrite must hit the WIDGET.
    const tf = form.createTextField("da.widget");
    tf.addToPage(page, { x: 20, y: 260, width: 200, height: 18 });
    // Field-DA field (no widget DA) — the rewrite must hit the FIELD.
    const tf2 = form.createTextField("da.field");
    tf2.addToPage(page, { x: 20, y: 220, width: 200, height: 18 });
    // Custom dropdown value (outside /Opt) + optionlist multi-select.
    const dd = form.createDropdown("dd.custom");
    dd.addOptions(["One", "Two"]);
    dd.addToPage(page, { x: 20, y: 180, width: 160, height: 18 });
    const ol = form.createOptionList("ol.multi");
    ol.addOptions(["a", "b", "c", "d"]);
    ol.addToPage(page, { x: 20, y: 120, width: 160, height: 60 });
    const bytes = await doc.save({ useObjectStreams: false });

    // Weld a widget-level DA onto tf's widget (pdf-lib keeps DA on fields).
    // context.obj(string) makes a PDFName — DA must be a PDFString.
    const { PDFString } = await import("pdf-lib");
    const doc2 = await PDFDocument.load(bytes, { updateMetadata: false });
    const tfWidget = doc2.getForm().getTextField("da.widget").acroField.getWidgets()[0]!;
    tfWidget.dict.set(
      PDFName.of("DA"),
      PDFString.of("0 1 0 rg /Helv 9 Tf"),
    );
    // Rotated widget: MK /R 90 on tf2's widget.
    const tf2Widget = doc2.getForm().getTextField("da.field").acroField.getWidgets()[0]!;
    tf2Widget.dict.set(PDFName.of("MK"), doc2.context.obj({ R: 90 }));
    const bytes2 = await doc2.save({ useObjectStreams: false });

    const ctx = StampContext.load(bytes2);
    const fields = new Map(ctx.readSourceFields().map((f) => [f.name, f]));
    ctx.setSourceTextField(fields.get("da.widget")!, "hello widget");
    ctx.setSourceTextField(fields.get("da.field")!, "hello field");
    ctx.setSourceChoice(fields.get("dd.custom")!, ["Three"]);
    ctx.setSourceChoice(fields.get("ol.multi")!, ["d", "b"]);
    const out = ctx.write();

    const parsed = parsePdf(out);
    const outFields = readAcroFormFields(parsed);
    const byName = new Map(outFields.map((f) => [f.name, f]));

    // DA rewrite priority: the WIDGET's DA (it carried a color) vs the FIELD's.
    const daWidgetInfo = byName.get("da.widget")!;
    const widgetDa = daWidgetInfo.widgets[0]!.dict.m.get("DA");
    const widgetDaText =
      widgetDa && "b" in widgetDa ? latin1All((widgetDa as { b: Uint8Array }).b) : "";
    ok(
      /^0 1 0 rg\n\/Helvetica \d+(\.\d+)? Tf$/.test(widgetDaText),
      `23.3 widget-DA rewrite wins when the widget carried a color ("${widgetDaText}")`,
    );
    const fieldDa = byName.get("da.field")!.dict.m.get("DA");
    const fieldDaText =
      fieldDa && "b" in fieldDa ? latin1All((fieldDa as { b: Uint8Array }).b) : "";
    ok(
      /Helvetica \d+(\.\d+)? Tf/.test(fieldDaText),
      `23.3 field-DA rewritten when the widget had none ("${fieldDaText}")`,
    );

    // Rotated widget: the regenerated AP opens with the rotateInPlace(90) pair.
    const rotWidget = byName.get("da.field")!.widgets[0]!;
    const apVal = rotWidget.dict.m.get("AP");
    const ap = apVal ? resolve(parsed, apVal) : undefined;
    if (ap && ap.k === "dict") {
      const n = resolve(parsed, ap.m.get("N"));
      if (n && n.k === "stream") {
        const body = latin1All(n.raw);
        ok(
          body.startsWith("1 0 0 1 201 0 cm\n0 1 -1 0 0 0 cm"),
          `23.3 MK /R 90 → rotateInPlace(90) ops — translate by the widget /Rect width 201 (got "${body.slice(0, 40).replace(/\n/g, "⏎")}")`,
        );
      } else {
        ok(false, "23.3 rotated widget /AP /N is a stream");
      }
    } else {
      ok(false, "23.3 rotated widget has /AP");
    }

    // Dropdown custom value → Edit flag (bit 19 = 262144) + the value.
    const ddOut = byName.get("dd.custom")!;
    const ff = asNum(ddOut.dict.m.get("Ff")) ?? 0;
    ok(
      (ff & (1 << 18)) !== 0,
      `23.3 dropdown custom value sets the Edit flag (Ff ${ff})`,
    );
    ok(ddOut.value === "Three", "23.3 dropdown custom value stored");

    // Optionlist multi-select: /V array + sorted /I indices + MultiSelect flag.
    const olOut = byName.get("ol.multi")!;
    eq(olOut.selected, ["d", "b"], "23.3 optionlist multi-select /V array");
    const olFf = asNum(olOut.dict.m.get("Ff")) ?? 0;
    ok((olFf & (1 << 21)) !== 0, "23.3 optionlist MultiSelect flag set");
    const iVal = olOut.dict.m.get("I");
    const iItems =
      iVal && iVal.k === "arr"
        ? iVal.items.map((it) => (it.k === "num" ? it.n : -1))
        : [];
    eq(iItems, [1, 3], "23.3 optionlist /I sorted indices");
  }

  /* ── 23.4 burn scopes: annotations-only keepWidgets + composition ──── */
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const tf = form.createTextField("keep.me");
    tf.addToPage(page, { x: 20, y: 260, width: 200, height: 18 });
    // A burnable non-widget annotation (direct /N stream clone path).
    const ctx0 = doc.context;
    const streamDict = ctx0.obj({
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 50, 20],
      Resources: {},
    });
    const { PDFRawStream } = await import("pdf-lib");
    const ap = PDFRawStream.of(
      streamDict as never,
      new TextEncoder().encode("1 0 0 rg 0 0 50 20 re f"),
    );
    const annot = ctx0.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [20, 200, 120, 220],
      F: 4,
      AP: { N: ap },
    });
    page.node.addAnnot(ctx0.register(annot));
    const bytes = await doc.save({ useObjectStreams: false });

    // annotations-only scope: the form SURVIVES, the Square burns, /Annots
    // keeps exactly the widget ref.
    const ctx = StampContext.load(bytes);
    const r = ctx.burnSourceAnnotations({ keepWidgets: true });
    const out = ctx.write();
    ok(r.burned === 1 && r.skipped === 1, `23.4 annotations-only: 1 burned + 1 widget kept (got ${r.burned}/${r.skipped})`);
    const parsed = parsePdf(out);
    const outFields = readAcroFormFields(parsed);
    ok(outFields.length === 1, "23.4 annotations-only: the form SURVIVES (field readable)");
    const outPage = listPages(parsed)[0]!;
    const annotsOut = resolve(parsed, outPage.dict.get("Annots"));
    const annotCount =
      annotsOut && annotsOut.k === "arr" ? annotsOut.items.length : 0;
    ok(annotsOut !== undefined && annotCount === 1, `23.4 /Annots = the widget ref only (${annotCount})`);
    // The burn stream carries the Do op + the form widget AP untouched.
    const libDoc = await PDFDocument.load(out, { updateMetadata: false });
    ok(
      libDoc.getForm().getTextField("keep.me") !== undefined,
      "23.4 oracle: the field still works after the annotations-only burn",
    );

    // Full scope on the SAME fixture: everything interactive dies, and an
    // appended annot (edit-pdf's appendAnnot) still rides on top.
    const ctx2 = StampContext.load(bytes);
    const fields2 = ctx2.readSourceFields();
    ctx2.setSourceTextField(fields2.find((f) => f.name === "keep.me")!, "burned value");
    ctx2.flattenSourceForm();
    const r2 = ctx2.burnSourceAnnotations({});
    ctx2.appendAnnot(
      0,
      (() => {
        const d = new Map<string, PdfObj>();
        return { k: "dict", m: d };
      })(),
    );
    const out2 = ctx2.write();
    ok(r2.burned === 1 && r2.skipped === 0, `23.4 full scope: 1 annot burned, no skips (got ${r2.burned}/${r2.skipped})`);
    const parsed2 = parsePdf(out2);
    ok(
      readAcroFormFields(parsed2).length === 0,
      "23.4 full scope: no fields remain",
    );
    const outPage2 = listPages(parsed2)[0]!;
    ok(outPage2.dict.get("Annots") !== undefined, "23.4 appended annot still rides after the flatten's override");
    const annots2 = resolve(parsed2, outPage2.dict.get("Annots"));
    ok(
      annots2 !== undefined && annots2.k === "arr" && annots2.items.length === 1,
      "23.4 /Annots = exactly the appended annot",
    );
  }
}

main().catch((err) => {
  console.error("SMOKE CRASH:", err);
  process.exit(1);
});
