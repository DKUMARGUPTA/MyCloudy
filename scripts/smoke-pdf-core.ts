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
 *
 * Run: bun scripts/smoke-pdf-core.ts
 */

import { writeFileSync } from "node:fs";

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

import {
  listPages,
  organizeMerge,
  organizePdf,
  organizePages,
  parseForOrganize,
  parsePdf,
  PdfError,
  writeDocument,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
} from "../src/lib/own/pdf";
import { zlibSync } from "../src/lib/own/zip";
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

/** Minimal harness: parse one top-level array using the parser's grammar. */
function parseValueForSmoke(lex: Lexer): ReturnType<typeof firstValue> {
  return firstValue(lex);
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
