/**
 * Smoke: epub-to-pdf (RB3-a — the 75th tool) — EPUB ebooks → PDF,
 * 100% on-device.
 *
 * House conventions: REAL fixtures built by the tool's own sample
 * builder (fflate zipSync, mimetype first + stored per OCF; the PNG
 * cover is built here with node:zlib because the model must stay
 * worker-pure), node:zlib as the UNZIP oracle (NOT fflate —
 * inflateRawSync for the raw-deflate entries fflate writes), real
 * renders through the worker's exact render.ts (font recipe + cover
 * embed + metadata calls replicated verbatim), parse-level font asserts
 * on reload, relative imports without .ts, process.exit at the end.
 *
 * Run: bun scripts/smoke-epub-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateRawSync, inflateSync, deflateSync } from "node:zlib";

import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8, type Zippable } from "fflate";

import {
  buildSampleEpub,
  chapterWordFor,
  estimatePages,
  EpubParseError,
  MAX_CHAPTERS,
  needsNoto,
  outputBaseName,
  parseEpub,
  stats,
  titleNeedsNoto,
  tocTitleFor,
  type ParsedEpub,
} from "../tools/epub-to-pdf/model";
import {
  drawEpubPdf,
  type EpubFontSet,
  type EpubRenderReport,
} from "../tools/epub-to-pdf/render";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
}

/**
 * node:zlib ZIP oracle — walks the local file headers and inflates
 * every entry itself (fflate writes RAW deflate, hence inflateRawSync).
 */
function readZipWithZlib(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes);
  const out: ZipEntry[] = [];
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      out.push({ name, method, data: raw });
    } else if (method === 8) {
      out.push({ name, method, data: inflateRawSync(raw) });
    } else {
      throw new Error(`unsupported zip method ${method}`);
    }
    off = dataStart + compSize;
  }
  if (out.length === 0) throw new Error("no zip entries parsed");
  return out;
}

function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString("latin1");
    } catch {
      /* non-flate stream (font) */
    }
    idx = e + 9;
  }
  return out;
}

/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

/** Every text-drawing op in a decoded content stream (folios count too). */
function countTj(stream: string): number {
  return (stream.match(/Tj(?![A-Za-z])/g) ?? []).length;
}

/** Decoded per-page content streams (pdf-lib's own decoder, not fflate). */
function pageStreamTexts(pdfDoc: PDFDocument): string[] {
  return pdfDoc.getPages().map((page: PDFPage) => {
    const contents = page.node.Contents();
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFRawStream) {
      streams.push(contents);
    } else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = contents.lookup(i);
        if (s instanceof PDFRawStream) streams.push(s);
      }
    }
    let out = "";
    for (const s of streams) {
      try {
        out += `${Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")}\n`;
      } catch {
        /* non-flate stream */
      }
    }
    return out;
  });
}

/* ---- the PNG cover: a hand-built REAL 32×48 8-bit RGB PNG ---- */

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makeCoverPng(): Uint8Array {
  const w = 32;
  const h = 48;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 (truecolor RGB)
  const raw = new Uint8Array((w * 3 + 1) * h);
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[off++] = 0x2a;
      raw[off++] = 0x5f;
      raw[off++] = 0x9e;
    }
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = new Uint8Array(sig.length + 25 + 12 + idat.length + 12);
  let pos = 0;
  out.set(sig, pos);
  pos += sig.length;
  out.set(pngChunk("IHDR", ihdr), pos);
  pos += 25;
  out.set(pngChunk("IDAT", idat), pos);
  pos += 12 + idat.length;
  out.set(pngChunk("IEND", new Uint8Array(0)), pos);
  return out;
}

const coverPng = makeCoverPng();
const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/* ---- the worker's exact font recipe + render + metadata sequence ---- */

function enFontSet(pdfDoc: PDFDocument): EpubFontSet {
  const cache = new Map<string, PDFFont>();
  const key = (b: boolean, i: boolean, m: boolean): string =>
    `${b ? "B" : ""}${i ? "I" : ""}${m ? "M" : ""}`;
  return {
    isNoto: false,
    resolve(bold, italic, mono) {
      const k = key(bold, italic, mono);
      const hit = cache.get(k);
      if (hit) return hit;
      let font: PDFFont;
      if (mono) {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
              ? StandardFonts.CourierBold
              : italic
                ? StandardFonts.CourierOblique
                : StandardFonts.Courier
        );
      } else {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.HelveticaBoldOblique
            : bold
              ? StandardFonts.HelveticaBold
              : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica
        );
      }
      cache.set(k, font);
      return font;
    },
  };
}

interface RenderOpts {
  noto?: boolean;
  letter?: boolean;
  margin?: "normal" | "narrow" | "wide";
  toc?: boolean;
  cover?: boolean;
  pageNumbers?: boolean;
  hindiUi?: boolean;
}

/**
 * Mirrors the worker step for step: parse → font decision → cover
 * embed → drawEpubPdf → metadata (producer/creator/title/author) →
 * save. The parse itself runs on the fixture bytes like request.files.
 */
async function renderBook(
  epubBytes: Uint8Array,
  opts: RenderOpts = {}
): Promise<{ bytes: Uint8Array; report: EpubRenderReport; book: ParsedEpub }> {
  const book = parseEpub(epubBytes);
  const lang: "en" | "hi" = opts.hindiUi ? "hi" : "en";
  const pdfDoc = await PDFDocument.create();
  const wantNoto =
    opts.noto === true ||
    needsNoto(book) ||
    (lang === "hi" && (opts.toc !== false || book.chapters.some((c) => c.title === ""))) ||
    book.chapters.some((c) => titleNeedsNoto(c.title));
  let fonts: EpubFontSet;
  if (wantNoto) {
    pdfDoc.registerFontkit(fontkit);
    const noto = await pdfDoc.embedFont(notoBytes, { subset: true });
    fonts = { isNoto: true, resolve: () => noto };
  } else {
    fonts = enFontSet(pdfDoc);
  }
  let coverImage: PDFImage | null = null;
  if (opts.cover !== false && book.cover !== null) {
    try {
      coverImage =
        book.cover.kind === "png"
          ? await pdfDoc.embedPng(book.cover.bytes)
          : await pdfDoc.embedJpg(book.cover.bytes);
    } catch {
      coverImage = null;
    }
  }
  const report = drawEpubPdf(pdfDoc, fonts, book, coverImage, {
    pageSize: opts.letter ? "letter" : "a4",
    margin: opts.margin ?? "normal",
    baseFontSize: 11,
    includeToc: opts.toc !== false,
    includeCover: opts.cover !== false,
    pageNumbers: opts.pageNumbers !== false,
    tocTitle: tocTitleFor(lang),
    chapterWord: chapterWordFor(lang),
  });
  // the worker's metadata sequence, verbatim
  const baseName = outputBaseName(book.title || "f.epub", lang);
  pdfDoc.setProducer("MyCloudy");
  pdfDoc.setCreator("MyCloudy");
  pdfDoc.setTitle(baseName);
  if (book.author !== "") pdfDoc.setAuthor(book.author);
  pdfDoc.setCreationDate(new Date());
  const bytes = await pdfDoc.save();
  return { bytes, report, book };
}

function expectCode(label: string, bytes: Uint8Array, code: string): void {
  try {
    parseEpub(bytes);
    check(label, false, "no throw");
  } catch (error) {
    check(
      label,
      error instanceof EpubParseError && error.code === code,
      error instanceof Error ? error.message : error
    );
  }
}

/** An honest minimal package for rejection vectors. */
function makeEpub(
  parts: Record<string, string | Uint8Array>,
  opts: { omitMimetype?: boolean; mimetype?: string } = {}
): Uint8Array {
  const entries: Zippable = {};
  for (const [k, v] of Object.entries(parts)) {
    entries[k] = [typeof v === "string" ? strToU8(v) : v, { level: 6 }];
  }
  if (!opts.omitMimetype) {
    entries["mimetype"] = [
      strToU8(opts.mimetype ?? "application/epub+zip"),
      { level: 0 },
    ];
  }
  return zipSync(entries);
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const CONTAINER_OK =
  XML_DECL +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
  '<rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>' +
  "</rootfiles></container>";

function opfWith(body: string): string {
  return (
    XML_DECL +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    "<dc:title>Test</dc:title><dc:creator>Author</dc:creator><dc:language>en</dc:language>" +
    '<dc:identifier id="uid">urn:uuid:x</dc:identifier>' +
    "</metadata>" +
    body +
    "</package>"
  );
}

const OPF_ONE_CHAPTER = opfWith(
  "<manifest>" +
    '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    "</manifest>" +
    "<spine><itemref idref=\"c1\"/></spine>"
);
const CH1 = XML_DECL +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>' +
  "<h1>Chapter heading</h1><p>Body text.</p>" +
  "</body></html>";

/* ------------------------------------------------------------------ */
console.log("── 1. fixture + node:zlib ZIP oracle ─────────────────────");
{
  const epub = buildSampleEpub({ cover: coverPng });
  check(
    "fixture is a zip (PK\\x03\\x04)",
    epub[0] === 0x50 && epub[1] === 0x4b && epub[2] === 0x03 && epub[3] === 0x04
  );
  const entries = readZipWithZlib(epub);
  const first = entries[0];
  check("mimetype is the FIRST entry (OCF)", first?.name === "mimetype", entries.map((e) => e.name));
  check("mimetype is STORED (method 0)", first?.method === 0, first?.method);
  check(
    "mimetype content is application/epub+zip",
    first?.data.toString("utf8") === "application/epub+zip",
    first?.data.toString("utf8")
  );
  const names = entries.map((e) => e.name);
  check(
    "container.xml present",
    names.includes("META-INF/container.xml")
  );
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  check(
    "container.xml inflates with the OPF rootfile",
    container !== undefined &&
      container.data.toString("utf8").includes('full-path="OEBPS/content.opf"')
  );
  const opf = entries.find((e) => e.name === "OEBPS/content.opf");
  check(
    "OPF inflates with metadata + spine",
    opf !== undefined &&
      opf.data.toString("utf8").includes("<dc:title>") &&
      opf.data.toString("utf8").includes("<itemref")
  );
  check(
    "URL-encoded chapter entry present (chapter two.xhtml)",
    names.includes("OEBPS/text/chapter two.xhtml")
  );
  const cover = entries.find((e) => e.name === "OEBPS/images/cover.png");
  check(
    "cover PNG present with real magic",
    cover !== undefined &&
      cover.data.length > 50 &&
      cover.data[0] === 0x89 &&
      cover.data[1] === 0x50 &&
      cover.data[2] === 0x4e &&
      cover.data[3] === 0x47
  );
  // the hand-built PNG must be valid for pdf-lib (parsed here, drawn below)
  const probe = await PDFDocument.create();
  const embedded = await probe.embedPng(coverPng);
  check("cover PNG embeds via pdf-lib (32×48)", embedded.width === 32 && embedded.height === 48, `${embedded.width}x${embedded.height}`);
}

console.log("── 2. parseEpub: EPUB 3 nav fixture ───────────────────────");
{
  const book = parseEpub(buildSampleEpub({ cover: coverPng }));
  check("title from dc:title", book.title === "The Falcon Chronicle", book.title);
  check("author from dc:creator", book.author === "Ananya Verma", book.author);
  check("language from dc:language", book.language === "en", book.language);
  check("4 chapters (nav + 3)", book.chapters.length === 4, book.chapters.map((c) => c.href));
  check("1 spine item skipped (the cover image)", book.skipped === 1, book.skipped);
  check(
    "spine order (../ + %20 resolution)",
    book.chapters[0]?.href === "nav.xhtml" &&
      book.chapters[1]?.href === "OEBPS/text/ch1.xhtml" &&
      book.chapters[2]?.href === "OEBPS/text/chapter two.xhtml" &&
      book.chapters[3]?.href === "OEBPS/text/ch3.xhtml",
    book.chapters.map((c) => c.href)
  );
  check("nav TOC parsed (3 entries)", book.toc.length === 3, book.toc.map((e) => e.title));
  check(
    "toc hrefs resolve to zip paths",
    book.toc[0]?.href === "OEBPS/text/ch1.xhtml" &&
      book.toc[1]?.href === "OEBPS/text/chapter two.xhtml",
    book.toc.map((e) => e.href)
  );
  check(
    "chapter titles resolved from the TOC",
    book.chapters[1]?.title === "The Journey Begins" &&
      book.chapters[2]?.title === "The Long Road" &&
      book.chapters[3]?.title === "Ledgers and Notes",
    book.chapters.map((c) => c.title)
  );
  check(
    "nav chapter takes its title from the first heading",
    book.chapters[0]?.title === "Contents",
    book.chapters.map((c) => c.title)
  );

  const ch1 = book.chapters[1];
  check("ch1 heading parsed", ch1 !== undefined && ch1.doc.blocks[0]?.kind === "heading");
  check(
    "ch1 bold + italic + list + quote parsed",
    ch1 !== undefined &&
      JSON.stringify(ch1.doc.blocks).includes('"bold":true') &&
      JSON.stringify(ch1.doc.blocks).includes('"italic":true') &&
      ch1.doc.blocks.some((b) => b.kind === "list-item") &&
      ch1.doc.blocks.some((b) => b.kind === "quote")
  );
  const ch2 = book.chapters[2];
  check("ch2 is long (multi-page)", ch2 !== undefined && ch2.doc.blocks.length >= 20, ch2?.doc.blocks.length);
  const ch3 = book.chapters[3];
  check(
    "ch3 table + pre parsed",
    ch3 !== undefined &&
      ch3.doc.blocks.some((b) => b.kind === "table") &&
      ch3.doc.blocks.some((b) => b.kind === "pre")
  );
  check("cover detected as PNG", book.cover !== null && book.cover.kind === "png");
  check("needsNoto false for EN book", needsNoto(book) === false);
  const st = stats(book);
  check("stats: 4 chapters + cover", st.chapters === 4 && st.hasCover === true, st);
  check("stats: words counted", st.words > 120, st.words);
  check("stats: skipped honest", st.skipped === 1);
  check("estimatePages grows with the book", estimatePages(book) >= 5, estimatePages(book));
}

console.log("── 3. parseEpub: EPUB 2 ncx fixture (meta cover) ─────────");
{
  const book = parseEpub(buildSampleEpub({ cover: coverPng, ncx: true }));
  check("ncx TOC parsed (3 entries)", book.toc.length === 3, book.toc.map((e) => e.title));
  check(
    "ncx chapter titles resolve",
    book.chapters[1]?.title === "The Journey Begins" &&
      book.chapters[2]?.title === "The Long Road",
    book.chapters.map((c) => c.title)
  );
  check(
    "EPUB 2 cover via meta[name=cover]",
    book.cover !== null && book.cover.kind === "png"
  );
  check("4 chapters, 1 skipped", book.chapters.length === 4 && book.skipped === 1);
}

console.log("── 4. parseEpub: Hindi book ──────────────────────────────");
{
  const book = parseEpub(buildSampleEpub({ hindi: true, cover: coverPng }));
  check("Hindi title parsed", book.title === "बाज़ का इतिहास", book.title);
  check("Hindi author parsed", book.author === "प्रिया शर्मा", book.author);
  check("language hi", book.language === "hi", book.language);
  check(
    "Hindi chapter title from nav",
    book.chapters[1]?.title === "यात्रा की शुरुआत",
    book.chapters.map((c) => c.title)
  );
  check(
    "Hindi body run parsed (Devanagari)",
    JSON.stringify(book.chapters[1]?.doc.blocks).includes("बोल्ड")
  );
  check("needsNoto true for Devanagari", needsNoto(book) === true);
  check("titleNeedsNoto true for Hindi title", titleNeedsNoto("विषय-सूची") === true);
  check(
    "localized words",
    tocTitleFor("en") === "Contents" &&
      tocTitleFor("hi") === "विषय-सूची" &&
      chapterWordFor("en") === "Chapter" &&
      chapterWordFor("hi") === "अध्याय"
  );
}

console.log("── 5. caps + estimatePages ───────────────────────────────");
{
  const manyParts: Record<string, string> = {
    "META-INF/container.xml": CONTAINER_OK,
    "content.opf": opfWith(
      "<manifest>" +
        Array.from(
          { length: MAX_CHAPTERS + 6 },
          (_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`
        ).join("") +
        "</manifest><spine>" +
        Array.from({ length: MAX_CHAPTERS + 6 }, (_, i) => `<itemref idref="c${i}"/>`).join("") +
        "</spine>"
    ),
  };
  for (let i = 0; i < MAX_CHAPTERS + 6; i++) {
    manyParts[`c${i}.xhtml`] = CH1;
  }
  // c0 has no heading and no TOC entry → the honest "" title
  manyParts["c0.xhtml"] = XML_DECL + '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>No heading, just a paragraph.</p></body></html>';
  const book = parseEpub(makeEpub(manyParts));
  check("chapter cap honoured (500)", book.chapters.length === MAX_CHAPTERS, book.chapters.length);
  check("truncated flag set", book.truncated === true);
  check("skipped accounting clean", book.skipped === 0, book.skipped);
  check(
    "chapter without heading/TOC entry → empty title (render's \"Chapter N\" fallback)",
    book.chapters[0]?.title === "" && book.chapters[1]?.title === "Chapter heading",
    book.chapters.slice(0, 2).map((c) => c.title)
  );
  check("estimatePages large book", estimatePages(book) >= 300, estimatePages(book));
}

console.log("── 6. outputBaseName vectors ─────────────────────────────");
{
  check("strips .epub", outputBaseName("my-book.epub", "en") === "my-book");
  check("uses book title", outputBaseName("The Falcon Chronicle", "en") === "The Falcon Chronicle");
  check("fallback EN", outputBaseName("", "en") === "Ebook");
  check("fallback HI", outputBaseName("", "hi") === "ईबुक");
  check("Hindi title survives", outputBaseName("बाज़ का इतिहास.epub", "hi") === "बाज़ का इतिहास");
  check(
    "unsafe chars sanitized",
    outputBaseName('bad/name?.epub', "en") === "bad_name_",
    outputBaseName('bad/name?.epub', "en")
  );
  check("nameless with extension only", outputBaseName(".epub", "en") === "Ebook");
}

console.log("── 7. rejection vectors ──────────────────────────────────");
{
  expectCode("non-zip bytes → errNotZip", new Uint8Array([1, 2, 3, 4, 5]), "errNotZip");
  expectCode("plain text → errNotZip", strToU8("hello world, definitely not a zip"), "errNotZip");
  expectCode(
    "zip without mimetype → errNoMimetype",
    zipSync({ "META-INF/container.xml": strToU8(CONTAINER_OK) }),
    "errNoMimetype"
  );
  expectCode(
    "wrong mimetype (application/zip) → errNoMimetype",
    makeEpub(
      { "META-INF/container.xml": CONTAINER_OK, "content.opf": OPF_ONE_CHAPTER, "ch1.xhtml": CH1 },
      { mimetype: "application/zip" }
    ),
    "errNoMimetype"
  );
  expectCode("empty zip (EOCD only) → errNoMimetype", zipSync({}), "errNoMimetype");
  expectCode(
    "missing container.xml → errNoContainer",
    makeEpub({ "content.opf": OPF_ONE_CHAPTER, "ch1.xhtml": CH1 }),
    "errNoContainer"
  );
  expectCode(
    "container without rootfile → errNoContainer",
    makeEpub({
      "META-INF/container.xml":
        XML_DECL + '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles/></container>',
      "content.opf": OPF_ONE_CHAPTER,
      "ch1.xhtml": CH1,
    }),
    "errNoContainer"
  );
  expectCode(
    "rootfile missing from zip → errNoOpf",
    makeEpub({ "META-INF/container.xml": CONTAINER_OK, "ch1.xhtml": CH1 }),
    "errNoOpf"
  );
  expectCode(
    "OPF without package → errNoOpf",
    makeEpub({
      "META-INF/container.xml": CONTAINER_OK,
      "content.opf": XML_DECL + "<not-a-package/>",
      "ch1.xhtml": CH1,
    }),
    "errNoOpf"
  );
  expectCode(
    "empty spine → errNoSpine",
    makeEpub({
      "META-INF/container.xml": CONTAINER_OK,
      "content.opf": opfWith("<manifest><item id=\"c1\" href=\"ch1.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine/>"),
      "ch1.xhtml": CH1,
    }),
    "errNoSpine"
  );
  expectCode(
    "spine with only unknown idrefs → errNoSpine",
    makeEpub({
      "META-INF/container.xml": CONTAINER_OK,
      "content.opf": opfWith("<manifest><item id=\"c1\" href=\"ch1.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"missing\"/></spine>"),
      "ch1.xhtml": CH1,
    }),
    "errNoSpine"
  );
  expectCode(
    "all chapters empty → errEmpty",
    makeEpub({
      "META-INF/container.xml": CONTAINER_OK,
      "content.opf": OPF_ONE_CHAPTER,
      "ch1.xhtml": XML_DECL + '<html xmlns="http://www.w3.org/1999/xhtml"><body><div></div><script>var x = 1;</script></body></html>',
    }),
    "errEmpty"
  );
  expectCode(
    "DRM (encryption.xml) → errDrm",
    makeEpub({
      "META-INF/container.xml": CONTAINER_OK,
      "content.opf": OPF_ONE_CHAPTER,
      "ch1.xhtml": CH1,
      "META-INF/encryption.xml":
        XML_DECL + '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
    }),
    "errDrm"
  );
  expectCode(
    "truncated zip → errCorrupt",
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]),
    "errCorrupt"
  );
}

console.log("── 8. REAL renders (worker's exact render.ts) ────────────");
{
  const fixture = buildSampleEpub({ cover: coverPng });

  // ---- EN book: cover + TOC + page numbers, A4, normal margins ----
  const out = await renderBook(fixture);
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 4000, out.bytes.length);
  const reloaded = await PDFDocument.load(out.bytes);
  const size = reloaded.getPage(0).getSize();
  check("EN: A4 dims 595.28×841.89", Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `${size.width}x${size.height}`);
  check(
    "EN: report math (cover + toc + chapters)",
    out.report.coverPages === 1 &&
      out.report.tocPages === 1 &&
      out.report.pages === reloaded.getPageCount(),
    out.report
  );
  check(
    "EN: chapter starts = cover + toc + fresh pages",
    out.report.chapterStarts[0] === 2,
    out.report.chapterStarts
  );
  check(
    "EN: long chapter spans ≥ 2 pages",
    out.report.chapterStarts.length === 4 &&
      out.report.chapterStarts[3] - out.report.chapterStarts[2] >= 2,
    out.report.chapterStarts
  );

  const dump = [...reloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("EN: Helvetica, no embedded font", dump.includes("Helvetica") && !dump.includes("FontFile2"));
  check("EN: cover image XObject present", dump.includes("/Image"));

  const txt = inflatedText(out.bytes);
  const needles = [
    "Start", // chapter 0 (the nav page — landmarks link text)
    "The Journey Begins",
    "bold spans",
    "italic ones",
    "First bullet",
    "A quoted line",
    "This is paragraph 10 of the long chapter",
    "This is paragraph 25 of the long chapter",
    "Region",
    "ledger line one",
    "After the table.",
    "Contents", // the TOC page heading
    "The Long Road", // TOC entry
  ];
  for (const n of needles) {
    check(`EN: "${n}" selectable in stream`, hasText(txt, n));
  }
  check("EN: CSS never contributed", !hasText(txt, "font-family"));
  check("EN: no NaN geometry", !txt.includes("NaN"));

  // ---- folio exactness: page numbers add exactly (pages - cover) Tj ops
  const noNumbers = await renderBook(fixture, { pageNumbers: false });
  const pagesTexts = pageStreamTexts(reloaded);
  const noNumberDoc = await PDFDocument.load(noNumbers.bytes);
  const noNumberTexts = pageStreamTexts(noNumberDoc);
  const tjsOn = pagesTexts.reduce((sum, s) => sum + countTj(s), 0);
  const tjsOff = noNumberTexts.reduce((sum, s) => sum + countTj(s), 0);
  check(
    "EN: folios add exactly pages-1 text ops",
    tjsOn - tjsOff === out.report.pages - out.report.coverPages,
    { tjsOn, tjsOff, pages: out.report.pages }
  );
  check(
    "EN: folio on the last page equals the page count",
    (() => {
      const last = pagesTexts[pagesTexts.length - 1] ?? "";
      return hasText(last, String(out.report.pages));
    })(),
    out.report.pages
  );
  check(
    "EN: TOC page carries the first chapter's exact number",
    (() => {
      const tocPage = pagesTexts[1] ?? "";
      return hasText(tocPage, String(out.report.chapterStarts[1] + 1));
    })(),
    out.report.chapterStarts[1] + 1
  );

  // ---- TOC off: same chapters, exactly tocPages fewer pages ----
  const noToc = await renderBook(fixture, { toc: false });
  check(
    "EN: TOC off → the Contents page is gone, chapters start one page earlier",
    noToc.report.tocPages === 0 &&
      noToc.report.pages === out.report.pages - out.report.tocPages &&
      noToc.report.chapterStarts[0] === out.report.chapterStarts[0] - out.report.tocPages,
    { on: out.report, off: noToc.report }
  );
  const noTocDoc = await PDFDocument.load(noToc.bytes);
  const noTocTexts = pageStreamTexts(noTocDoc);
  const tocTexts = pagesTexts;
  check(
    "EN: TOC off → page 2 is the nav chapter, not a Contents page",
    hasText(noTocTexts[1] ?? "", "Start") && !hasText(tocTexts[1] ?? "", "Start"),
    { tocOff: (noTocTexts[1] ?? "").slice(0, 60), tocOn: (tocTexts[1] ?? "").slice(0, 60) }
  );

  // ---- cover off: one page less, no image XObject ----
  const noCover = await renderBook(fixture, { cover: false });
  const noCoverDoc = await PDFDocument.load(noCover.bytes);
  const noCoverDump = [...noCoverDoc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check(
    "EN: cover off → no image XObject, one page less",
    !noCoverDump.includes("/Image") &&
      noCover.report.pages === out.report.pages - 1 &&
      noCover.report.chapterStarts[0] === out.report.chapterStarts[0] - 1,
    noCover.report
  );

  // ---- metadata (the worker's exact sequence) ----
  const metaDoc = await PDFDocument.load(out.bytes, { updateMetadata: false });
  check("EN: PDF Title from dc:title", metaDoc.getTitle() === "The Falcon Chronicle", metaDoc.getTitle());
  check("EN: PDF Author from dc:creator", metaDoc.getAuthor() === "Ananya Verma", metaDoc.getAuthor());
  check(
    "EN: producer/creator MyCloudy",
    (metaDoc.getProducer() ?? "") === "MyCloudy" && (metaDoc.getCreator() ?? "") === "MyCloudy",
    { producer: metaDoc.getProducer(), creator: metaDoc.getCreator() }
  );

  // ---- Letter + margins ----
  const letterOut = await renderBook(fixture, { letter: true });
  const ls = (await PDFDocument.load(letterOut.bytes)).getPage(0).getSize();
  check("EN: Letter dims 612×792", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);
  const narrowOut = await renderBook(fixture, { margin: "narrow" });
  const wideOut = await renderBook(fixture, { margin: "wide" });
  check(
    "EN: margins order pages(narrow) ≤ pages(normal) ≤ pages(wide)",
    narrowOut.report.pages <= out.report.pages && out.report.pages <= wideOut.report.pages,
    { narrow: narrowOut.report.pages, normal: out.report.pages, wide: wideOut.report.pages }
  );
  check("EN: narrow + wide render valid PDFs", narrowOut.bytes[0] === 0x25 && wideOut.bytes[0] === 0x25);

  // ---- Hindi book: Noto subset for everything ----
  const hiFixture = buildSampleEpub({ hindi: true, cover: coverPng });
  const hiOut = await renderBook(hiFixture, { noto: true, hindiUi: true });
  check("HI: %PDF magic", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 4000, hiOut.bytes.length);
  const hiReloaded = await PDFDocument.load(hiOut.bytes, { updateMetadata: false });
  const hiDump = [...hiReloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("HI: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI: cover image XObject present", hiDump.includes("/Image"));
  check("HI: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));
  check(
    "HI: metadata Title/Author in Devanagari",
    hiReloaded.getTitle() === "बाज़ का इतिहास" && hiReloaded.getAuthor() === "प्रिया शर्मा",
    { title: hiReloaded.getTitle(), author: hiReloaded.getAuthor() }
  );
  check("HI: book parsed with 4 chapters", hiOut.book.chapters.length === 4);

  // ---- EPUB 2 (ncx) render: same pipeline, honest numbers ----
  const ncxFixture = buildSampleEpub({ cover: coverPng, ncx: true });
  const ncxOut = await renderBook(ncxFixture);
  check(
    "NCX: renders with cover + toc",
    ncxOut.bytes[0] === 0x25 &&
      ncxOut.report.coverPages === 1 &&
      ncxOut.report.tocPages === 1 &&
      hasText(inflatedText(ncxOut.bytes), "The Journey Begins"),
    ncxOut.report
  );
  const ncxReloaded = await PDFDocument.load(ncxOut.bytes);
  const ncxDump = [...ncxReloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("NCX: Helvetica, no embedded font", ncxDump.includes("Helvetica") && !ncxDump.includes("FontFile2"));
}

console.log(
  `\nepub-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
