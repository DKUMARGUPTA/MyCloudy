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
  measureStdText,
  encodeWinAnsiHex,
  winAnsiEncodable,
  ParsedTtfFont,
  shapeText,
  type StampTtfFont,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
} from "../src/lib/own/pdf";
import { latin1 } from "../src/lib/own/pdf/lexer";
import { crc32, unzlibSync, zlibSync } from "../src/lib/own/zip";
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
    // The untouched page 1 still has no own /Resources (inherits from parent).
    eq(back[1]!.dict.get("Resources"), undefined, "inherit: unstamped page untouched");
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

main().catch((err) => {
  console.error("SMOKE CRASH:", err);
  process.exit(1);
});
