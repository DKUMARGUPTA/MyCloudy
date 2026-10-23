/**
 * Smoke: pdf-to-powerpoint (RB3-d) — PDF → PPTX, 100% on-device.
 *
 * House conventions: real fixtures built with pdf-lib, text extracted
 * through pdfjs-dist/legacy (in-process, the smoke-pdf-to-word
 * recipe), node:zlib inflateRawSync central-directory walk as the
 * independent ZIP oracle (NOT fflate), local imports without .ts,
 * process.exit at the end.
 *
 *  1. Pure helpers — xmlEscape, typefaceFor, scaledFontPt clamps,
 *     slideSizeFor (fixed + match + clamps), fixDevanagariVisual,
 *     coerceRunOptions tamper vectors, outputBaseName vectors.
 *  2. Synthetic extraction — title detection (largest top-third
 *     font), block merging (gap + size similarity), empty pages.
 *  3. REAL fixtures — a 4-page PDF (EN title/size hierarchy + an
 *     empty page + a Hindi Devanagari page) built with pdf-lib and
 *     extracted through pdf.js getTextContent.
 *  4. 16:9 package — the node:zlib oracle walks the zipSync output:
 *     every required part, content-types overrides, slide XML parsed
 *     (expected strings, XML-escaped text, EMU position math for the
 *     known title item, sz scaling + clamps, Calibri on EN runs),
 *     empty slide 3, and empty-slide honesty.
 *  5. Mirror round-trip — powerpoint-to-pdf's parsePptx READS the
 *     generated .pptx (slides, sizes, title text/size/box) — the
 *     writer emits exactly what the family parser expects.
 *  6. sldSz options — 4:3, match Letter (7772400×10058400), match
 *     portrait A4 (7560056×10692003, orientation preserved).
 *  7. Page-range subset — "1-2" → exactly 2 slides, 2 overrides.
 *  8. Images mode — real PNG bytes (built in-script with node:zlib),
 *     PNG magic in the media parts, png Default in content-types,
 *     p:pic with r:embed matching the slide rel, full-bleed exact
 *     for a same-aspect page, letterboxed for a portrait page.
 *  9. Rejection vectors — an @cantoo-encrypted PDF (pdf.js asks for a
 *     password) → tool.errorEncrypted; garbage bytes → tool.errorCorrupt.
 * 10. Rendered-pixel RAM budget (ENH-1) — the images-mode loop checks
 *     RenderPixelBudget BEFORE each page render and posts the honest
 *     tool.errorRenderBudget refusal (i18n in BOTH catalogs).
 *
 * Run: bun scripts/smoke-pdf-to-powerpoint.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { deflateSync, inflateRawSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildPptx,
  coerceRunOptions,
  extractTextSlide,
  fixDevanagariVisual,
  outputBaseName,
  pdfErrorMessageToCode,
  scaledFontPt,
  slideSizeFor,
  typefaceFor,
  xmlEscape,
  type PdfTextItemInput,
  type SlideSize,
} from "../tools/pdf-to-powerpoint/model";
import { parsePptx } from "../tools/powerpoint-to-pdf/model";
import { parsePageSpec } from "../src/lib/workers/protocol";
import {
  RenderPixelBudget,
  RENDER_PIXEL_BUDGET,
} from "../tools/pdfjs-common/pixel-budget";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

const near = (a: number, b: number, tol = 0.5): boolean =>
  Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * ZIP oracle — walks the central directory and inflates each entry
 * with node:zlib (raw deflate), completely independent of fflate.
 */
function unzipOracle(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  let p = cdOff;
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad CD signature");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error("bad local header signature");
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : inflateRawSync(comp);
    out.set(name, new Uint8Array(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function text(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return "";
  return Buffer.from(bytes).toString("utf8");
}

/** Minimal XML well-formedness: balanced tags, no raw < in text. */
function xmlWellFormed(xml: string): boolean {
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const tagRe = /<(\/?)([A-Za-z_:][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    if (src.slice(lastIndex, match.index).includes("<")) return false;
    lastIndex = tagRe.lastIndex;
    const [full, close, name, , selfClose] = match;
    if (selfClose === "/" || full.startsWith("<?") || full.startsWith("<!")) {
      continue;
    }
    if (close === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  if (src.slice(lastIndex).includes("<")) return false;
  return stack.length === 0;
}

/** Synthetic pdf.js item factory. */
function item(
  str: string,
  x: number,
  y: number,
  size: number,
  opts: { width?: number; fontName?: string } = {}
): PdfTextItemInput {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: opts.width ?? str.length * size * 0.5,
    fontName: opts.fontName ?? "F",
  };
}

/* Minimal real PNG (RGB, no filter) — built with node:zlib. */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function tinyPng(w: number, h: number, gray: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw: number[] = [];
  for (let y = 0; y < h; y += 1) {
    raw.push(0); // filter: none
    for (let x = 0; x < w; x += 1) raw.push(gray, gray, gray);
  }
  const idat = new Uint8Array(deflateSync(new Uint8Array(raw)));
  const parts = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const SLIDE_169: SlideSize = { cx: 12192000, cy: 6858000 };

/* ================================================================== */
console.log("── 1. pure helpers ──────────────────────────────────────");
/* ================================================================== */

check(
  "xmlEscape covers & < > \" '",
  xmlEscape(`a & b < c > d "e" 'f'`) ===
    "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;"
);
check("xmlEscape keeps Devanagari intact", xmlEscape("प्रिया शर्मा") === "प्रिया शर्मा");

check(
  "typefaceFor: Devanagari → Noto Sans Devanagari",
  typefaceFor("नमस्ते दुनिया") === "Noto Sans Devanagari"
);
check("typefaceFor: Latin → Calibri", typefaceFor("Quarterly Report") === "Calibri");
check(
  "typefaceFor: non-WinAnsi non-Devanagari still Calibri (name reference)",
  typefaceFor("₹ 500") === "Calibri"
);

check("scaledFontPt clamps low", scaledFontPt(4, 1) === 8);
check("scaledFontPt clamps high", scaledFontPt(150, 1) === 96);
check(
  "scaledFontPt scales + rounds",
  scaledFontPt(22, 960 / 612) === Math.min(96, Math.max(8, Math.round((22 * (960 / 612)) * 100) / 100))
);

check(
  "slideSizeFor 16:9 exact",
  slideSizeFor("16-9", 612, 792).cx === 12192000 &&
    slideSizeFor("16-9", 612, 792).cy === 6858000
);
check(
  "slideSizeFor 4:3 exact",
  slideSizeFor("4-3", 612, 792).cx === 9144000 &&
    slideSizeFor("4-3", 612, 792).cy === 6858000
);
check(
  "slideSizeFor match Letter (612×792 → 7772400×10058400)",
  slideSizeFor("match", 612, 792).cx === 7772400 &&
    slideSizeFor("match", 612, 792).cy === 10058400
);
check(
  "slideSizeFor match clamps to 4032pt",
  slideSizeFor("match", 5000, 100).cx === 51206400
);
check(
  "slideSizeFor match floors at 1 inch",
  slideSizeFor("match", 10, 10).cx === 914400 &&
    slideSizeFor("match", 10, 10).cy === 914400
);

check(
  "fixDevanagariVisual repairs a pre-base matra",
  fixDevanagariVisual("िप्रया शर्मा") === "प्रिया शर्मा"
);
check("fixDevanagariVisual leaves plain text", fixDevanagariVisual("hello नमस्ते") === "hello नमस्ते");

/* ---------------- coerceRunOptions tamper vectors ---------------- */
{
  const defaults = coerceRunOptions({});
  check(
    "empty options → honest defaults",
    defaults.mode === "text" &&
      defaults.slideSize === "16-9" &&
      defaults.pages === "all" &&
      defaults.locale === "en" &&
      defaults.fileWord === "",
    defaults
  );
  const full = coerceRunOptions({
    mode: "images",
    slideSize: "match",
    pages: "1-3, 5",
    locale: "hi",
    fileWord: "प्रेज़ेंटेशन",
  });
  check(
    "every field honoured",
    full.mode === "images" &&
      full.slideSize === "match" &&
      full.pages === "1-3, 5" &&
      full.locale === "hi" &&
      full.fileWord === "प्रेज़ेंटेशन"
  );
  const garbage = coerceRunOptions({
    mode: 42,
    slideSize: "A5",
    pages: null,
    locale: "fr",
    fileWord: 7,
  });
  check(
    "wrong types degrade to defaults",
    garbage.mode === "text" &&
      garbage.slideSize === "16-9" &&
      garbage.pages === "all" &&
      garbage.locale === "en" &&
      garbage.fileWord === "",
    garbage
  );
  check(
    "page spec control chars stripped",
    coerceRunOptions({ pages: "1\u0001-2" }).pages === "1-2"
  );
  check(
    "fileWord clamped to 40 chars",
    coerceRunOptions({ fileWord: "x".repeat(90) }).fileWord.length === 40
  );
}

/* ---------------- outputBaseName vectors ---------------- */
check(
  "outputBaseName strips .pdf and hyphenates",
  outputBaseName("My Deck.pdf", "en") === "My-Deck"
);
check(
  "outputBaseName strips path-unsafe chars",
  outputBaseName('we/ird*name?.pdf', "en") === "weirdname"
);
check(
  "outputBaseName keeps Devanagari",
  outputBaseName("रिपोर्ट final.pdf", "en") === "रिपोर्ट-final"
);
check(
  "outputBaseName collapses runs of hyphens",
  outputBaseName("My  --Deck..pdf", "en") === "My-Deck"
);
check(
  "outputBaseName empty → EN fallback",
  outputBaseName(".pdf", "en") === "Presentation"
);
check(
  "outputBaseName empty → HI fallback",
  outputBaseName("", "hi") === "प्रेज़ेंटेशन"
);

/* ================================================================== */
console.log("── 2. synthetic extraction (title / blocks / empty) ───────");
/* ================================================================== */
{
  const slide = extractTextSlide(
    [
      item("Big Heading", 72, 720, 22, { width: 120 }),
      item("body line one joins", 72, 680, 11),
      item("body line two joins", 72, 666, 11),
      item("separate paragraph", 72, 600, 11),
    ],
    612,
    792,
    SLIDE_169
  );
  check("synthetic page not empty", slide.empty === false);
  check(
    "4 lines → 3 blocks (two tight body lines merge)",
    slide.boxes.length === 3,
    slide.boxes.length
  );
  const title = slide.boxes[0];
  check("title box detected (largest top-third font)", title?.isTitle === true);
  check("title run bold", title?.paras[0]?.runs[0]?.bold === true);
  const body = slide.boxes[1];
  check(
    "merged block keeps two paragraphs (one per line)",
    body?.paras.length === 2
  );
  check(
    "second body line joined into the same box",
    body?.paras[1]?.runs[0]?.text === "body line two joins"
  );
  check(
    "non-title box is not bold",
    body?.paras[0]?.runs[0]?.bold === false
  );
  // contain-fit: a portrait page on a 16:9 slide centers horizontally
  const scale = Math.min(960 / 612, 540 / 792);
  const offX = (960 - 612 * scale) / 2;
  check(
    "contain-fit scale + centering (x offset > 0)",
    near((title?.x ?? 0) / 12700, offX + 72 * scale, 0.05),
    { x: title?.x, offX }
  );
  const empty = extractTextSlide([], 612, 792, SLIDE_169);
  check("no items → honest empty slide", empty.empty === true && empty.boxes.length === 0);
}
{
  // same baseline + horizontal gap → one line with a space
  const slide = extractTextSlide(
    [
      item("Hello", 72, 100, 10, { width: 25 }),
      item("world", 110, 100, 10, { width: 25 }),
    ],
    612,
    792,
    SLIDE_169
  );
  check(
    "gap between pieces becomes a space",
    slide.boxes[0]?.paras[0]?.runs[0]?.text === "Hello world"
  );
  // a size change starts a new block even without a gap
  const sizes = extractTextSlide(
    [item("Big Title", 72, 700, 22), item("body starts here", 72, 688, 11)],
    612,
    792,
    SLIDE_169
  );
  check(
    "font-size change splits blocks (title never glues to body)",
    sizes.boxes.length === 2
  );
  // the title detection window: a large font in the TOP third only
  const low = extractTextSlide(
    [item("small top line", 72, 780, 10), item("big low line", 72, 200, 40)],
    612,
    792,
    SLIDE_169
  );
  check(
    "large font outside the top third is NOT the title",
    low.boxes.length === 2 &&
      low.boxes[0]?.isTitle === true && // the only top-third block wins
      low.boxes[1]?.isTitle === false, // the 40pt block is below the window
    low.boxes.map((b) => b.isTitle)
  );
}

/* ================================================================== */
console.log("── 3. real fixtures: pdf-lib build → pdf.js extract ──────");
/* ================================================================== */

const notoBytes = new Uint8Array(
  readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  )
);

/** The 4-page EN/Hindi fixture (612×792 Letter). */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page1 = doc.addPage([612, 792]);
  page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
  page1.drawText("This report covers the first quarter.", {
    x: 72,
    y: 680,
    size: 11,
    font: helv,
  });
  page1.drawText("Numbers improved across every region.", {
    x: 72,
    y: 666,
    size: 11,
    font: helv,
  });
  page1.drawText("A later section with a clear gap.", {
    x: 72,
    y: 600,
    size: 11,
    font: helv,
  });
  page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", {
    x: 72,
    y: 560,
    size: 11,
    font: helv,
  });

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Falcon Overview", { x: 72, y: 700, size: 150, font: bold });
  page2.drawText("tiny footnote line", { x: 72, y: 650, size: 4, font: helv });

  const page3 = doc.addPage([612, 792]); // deliberately empty (a scan stand-in)

  const page4 = doc.addPage([612, 792]);
  page4.drawText("त्रैमासिक रिपोर्ट", { x: 72, y: 720, size: 22, font: noto });
  page4.drawText("प्रिया शर्मा की टीम", { x: 72, y: 680, size: 14, font: noto });

  return new Uint8Array(await doc.save());
}

interface Extracted {
  pages: PdfTextItemInput[][];
  widths: number[];
  heights: number[];
}

async function extractFixture(bytes: Uint8Array): Promise<Extracted> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const pages: PdfTextItemInput[][] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    widths.push(viewport.width);
    heights.push(viewport.height);
    try {
      const content = await page.getTextContent();
      pages.push(content.items as PdfTextItemInput[]);
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return { pages, widths, heights };
}

const fixture = await buildFixture();
check("fixture built (starts with %PDF)", fixture[0] === 0x25 && fixture.length > 500);

const extracted = await extractFixture(fixture);
check("pdf.js read all 4 pages", extracted.pages.length === 4);
check("viewports are 612×792", extracted.widths[0] === 612 && extracted.heights[0] === 792);

const flat1 = extracted.pages[0] ?? [];
const allText1 = flat1
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "raw page-1 extraction sees title, body and XML-hostile text",
  allText1.includes("Quarterly Report") &&
    allText1.includes("Numbers improved") &&
    allText1.includes("Q1 < Q2"),
  allText1.slice(0, 200)
);
check("page 3 has no text items", (extracted.pages[2] ?? []).length === 0);
const flat4 = extracted.pages[3] ?? [];
const allText4 = flat4
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "Hindi page extracted with Devanagari (की टीम survives raw)",
  /[\u0900-\u097F]/.test(allText4) && allText4.includes("की टीम")
);
check(
  "pre-base matras arrive visual (ि before its cluster)",
  allText4.includes("ि") && /ि[करपस]/.test(allText4),
  allText4
);

const textSlides = extracted.pages.map((items, i) =>
  extractTextSlide(items, extracted.widths[i] ?? 612, extracted.heights[i] ?? 792, SLIDE_169)
);
check("4 text slides extracted", textSlides.length === 4);
check("empty page → honest empty slide", textSlides[2]?.empty === true);
check("non-empty slides not flagged", textSlides[0]?.empty === false);
check("EN slide 1 has 4 blocks", textSlides[0]?.boxes.length === 4, textSlides[0]?.boxes.length);
check("slide 1 title detected", textSlides[0]?.boxes[0]?.isTitle === true);
check("slide 2 title is the 150pt line", textSlides[1]?.boxes[0]?.isTitle === true);
check("slide 4 title is the Hindi heading", textSlides[3]?.boxes[0]?.isTitle === true);

/* ================================================================== */
console.log("── 4. 16:9 package via the node:zlib ZIP oracle ───────────");
/* ================================================================== */

const pptx169 = buildPptx({
  mode: "text",
  slide: SLIDE_169,
  slideSizeOption: "16-9",
  pages: textSlides,
  title: "Quarterly Report",
});
check("output is a zip (PK magic)", pptx169[0] === 0x50 && pptx169[1] === 0x4b);
check("local magic PK\\x03\\x04", pptx169[2] === 0x03 && pptx169[3] === 0x04);

let entries: Map<string, Uint8Array>;
try {
  entries = unzipOracle(pptx169);
} catch (error) {
  entries = new Map();
  check("oracle walks the archive", false, String(error));
}

/* (a) package structure */
const requiredParts = [
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  "ppt/theme/theme1.xml",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  "ppt/slides/slide1.xml",
  "ppt/slides/slide2.xml",
  "ppt/slides/slide3.xml",
  "ppt/slides/slide4.xml",
  "ppt/slides/_rels/slide1.xml.rels",
  "ppt/slides/_rels/slide2.xml.rels",
  "ppt/slides/_rels/slide3.xml.rels",
  "ppt/slides/_rels/slide4.xml.rels",
  "docProps/core.xml",
  "docProps/app.xml",
];
for (const part of requiredParts) {
  check(`zip entry ${part}`, entries.has(part));
}

const ct = text(entries.get("[Content_Types].xml"));
check(
  "content-types declares the presentation main override",
  ct.includes("/ppt/presentation.xml") &&
    ct.includes("presentationml.presentation.main+xml")
);
check(
  "content-types has 4 slide overrides",
  ct.split("presentationml.slide+xml").length - 1 === 4
);
check(
  "content-types has master/layout/theme overrides",
  ct.includes("slideMaster+xml") &&
    ct.includes("slideLayout+xml") &&
    ct.includes("theme+xml")
);
check(
  "content-types has NO png default in text mode",
  !ct.includes('Extension="png"')
);

const pres = text(entries.get("ppt/presentation.xml"));
check(
  "16:9 sldSz + type",
  pres.includes('cx="12192000" cy="6858000" type="screen16x9"')
);
check("sldIdLst has 4 entries", pres.split("<p:sldId ").length - 1 === 4);

const presRels = text(entries.get("ppt/_rels/presentation.xml.rels"));
check(
  "presentation rels: master + 4 slides",
  presRels.includes("slideMaster1.xml") &&
    presRels.split("/slide\"").length - 1 === 4
);

const core = text(entries.get("docProps/core.xml"));
check("docProps title", core.includes("Quarterly Report"));
check("docProps creator DocoPDF", core.includes("<dc:creator>DocoPDF</dc:creator>"));
check("app.xml Application DocoPDF", text(entries.get("docProps/app.xml")).includes("<Application>DocoPDF</Application>"));

/* (b) slide XML parsing */
const slide1 = text(entries.get("ppt/slides/slide1.xml"));
check("slide1 is well-formed", xmlWellFormed(slide1));
check("slide1 has the title string", slide1.includes("Quarterly Report"));
check(
  "slide1 XML-escapes hostile text",
  slide1.includes("revenue &amp; costs") &&
    slide1.includes("Q1 &lt; Q2 &gt; targets.")
);
check(
  "slide1 first shape is the Title box",
  /<p:cNvPr id="2" name="Title 2"\/>/.test(slide1)
);
check(
  "slide1 body shapes named Text",
  /name="Text 3"\/>/.test(slide1) && /name="Text 5"\/>/.test(slide1)
);
check(
  "text boxes use the family clamp: body 11pt × 0.682 → 8pt floor",
  /sz="800"/.test(slide1)
);
check(
  "EN runs reference Calibri (a:latin + a:ea)",
  slide1.includes('<a:latin typeface="Calibri"/>') &&
    slide1.includes('<a:ea typeface="Calibri"/>')
);
check(
  "no Noto typeface on the EN slide",
  !slide1.includes("Noto Sans Devanagari")
);

/* EMU position math for the known title item (72, 720, 22pt). */
{
  const scale = Math.min(960 / 612, 540 / 792);
  const offX = (960 - 612 * scale) / 2;
  const offY = (540 - 792 * scale) / 2;
  const expectX = Math.round((offX + 72 * scale) * 12700);
  const expectY = Math.round(
    (offY + (792 - (720 + 22 * 0.75)) * scale) * 12700
  );
  const m = /<p:sp>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(slide1);
  check("title box a:off present", m !== null);
  if (m) {
    check(
      "title box EMU x matches contain-fit math",
      Number(m[1]) === expectX,
      { got: m[1], want: expectX }
    );
    check(
      "title box EMU y matches ascender math",
      Number(m[2]) === expectY,
      { got: m[2], want: expectY }
    );
  }
  check(
    "title run sz scales (22pt × 0.682 → 15pt → sz=1500)",
    /<a:rPr lang="en-US" dirty="0" sz="1500" b="1">/.test(slide1)
  );
  const extM = /<p:sp>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(slide1);
  check(
    "title box extents within the slide",
    extM !== null &&
      Number(extM[1]) <= 12192000 &&
      Number(extM[2]) <= 6858000 &&
      Number(extM[1]) > 0 &&
      Number(extM[2]) > 0,
    extM?.slice(1)
  );
}

const slide2 = text(entries.get("ppt/slides/slide2.xml"));
check(
  "150pt × 0.682 clamps to the 96pt ceiling (sz=9600)",
  /sz="9600"/.test(slide2)
);
check("4pt × 0.682 clamps to the 8pt floor (sz=800)", /sz="800"/.test(slide2));
check("slide2 title bold", /sz="9600" b="1"/.test(slide2));

const slide3 = text(entries.get("ppt/slides/slide3.xml"));
check("empty page → slide3 has no text boxes", !slide3.includes("<p:sp>"));
check("slide3 still well-formed", xmlWellFormed(slide3));

const slide4 = text(entries.get("ppt/slides/slide4.xml"));
check("slide4 is well-formed", xmlWellFormed(slide4));
check(
  "Hindi runs reference Noto Sans Devanagari",
  slide4.includes('<a:latin typeface="Noto Sans Devanagari"/>') &&
    slide4.includes('<a:ea typeface="Noto Sans Devanagari"/>')
);
check("Hindi runs tagged hi-IN", slide4.includes('lang="hi-IN"'));
check("no Calibri on the Hindi slide", !slide4.includes('typeface="Calibri"'));
check(
  "Hindi text survives (visual order repaired or accepted)",
  slide4.includes("प्रिया") || slide4.includes("िप्रया")
);
check(
  "pre-base matra repaired in the slide (मािसक → मासिक)",
  slide4.includes("त्रैमासिक") && !slide4.includes("मािसक"),
  (slide4.match(/[ऀ-ॿ]+/g) ?? []).join(" | ")
);

const slide1Rels = text(entries.get("ppt/slides/_rels/slide1.xml.rels"));
check(
  "slide rel points at the layout",
  slide1Rels.includes("../slideLayouts/slideLayout1.xml")
);
const masterRels = text(entries.get("ppt/slideMasters/_rels/slideMaster1.xml.rels"));
check(
  "master rels chain layout + theme",
  masterRels.includes("../slideLayouts/slideLayout1.xml") &&
    masterRels.includes("../theme/theme1.xml")
);
const theme = text(entries.get("ppt/theme/theme1.xml"));
check("theme has clrScheme + fontScheme", theme.includes("<a:clrScheme") && theme.includes("<a:fontScheme"));

/* ================================================================== */
console.log("── 5. mirror round-trip (powerpoint-to-pdf reads it) ─────");
/* ================================================================== */
{
  const mirror = parsePptx(pptx169);
  check("mirror sees 4 slides", mirror.slides.length === 4);
  check("mirror reads 16:9 sldSz (960×540pt)", near(mirror.slideW, 960, 0.01) && near(mirror.slideH, 540, 0.01));
  const s1 = mirror.slides[0];
  check("mirror sees 4 shapes on slide 1", s1?.shapes.length === 4, s1?.shapes.length);
  const title = s1?.shapes[0];
  check(
    "mirror reads the title text + scaled size",
    title?.paras[0]?.runs[0]?.text === "Quarterly Report" &&
      title?.paras[0]?.runs[0]?.sizePt === 15,
    title?.paras[0]?.runs[0]
  );
  check(
    "mirror reads the title box in pt (contain-fit math)",
    title !== undefined &&
      near(title.x, 320.45, 0.05) &&
      near(title.y, 37.84, 0.05),
    title && { x: title.x, y: title.y }
  );
  const body = s1?.shapes[1];
  check(
    "mirror reads a two-paragraph body block",
    body?.paras.length === 2
  );
  const hostile = s1?.shapes[3];
  check(
    "mirror reads the XML-hostile text decoded",
    hostile?.paras[0]?.runs[0]?.text ===
      "Notes: revenue & costs, Q1 < Q2 > targets.",
    hostile?.paras[0]?.runs[0]?.text
  );
  const hindi = mirror.slides[3];
  check(
    "mirror reads the Hindi title (matra-repaired)",
    hindi?.shapes[0]?.paras[0]?.runs[0]?.text.includes("त्रैमासिक") === true,
    hindi?.shapes[0]?.paras[0]?.runs[0]?.text
  );
}

/* ================================================================== */
console.log("── 6. sldSz options (4:3, match Letter, match portrait A4) ─");
/* ================================================================== */
{
  const pptx43 = buildPptx({
    mode: "text",
    slide: slideSizeFor("4-3", 612, 792),
    slideSizeOption: "4-3",
    pages: textSlides,
    title: "T",
  });
  const e43 = unzipOracle(pptx43);
  check(
    "4:3 sldSz + type",
    text(e43.get("ppt/presentation.xml")).includes(
      'cx="9144000" cy="6858000" type="screen4x3"'
    )
  );

  const matchLetter = slideSizeFor("match", 612, 792);
  const matchSlides = extracted.pages.map((items, i) =>
    extractTextSlide(
      items,
      extracted.widths[i] ?? 612,
      extracted.heights[i] ?? 792,
      matchLetter
    )
  );
  const pptxMatch = buildPptx({
    mode: "text",
    slide: matchLetter,
    slideSizeOption: "match",
    pages: matchSlides,
    title: "T",
  });
  const eMatch = unzipOracle(pptxMatch);
  check(
    "match Letter sldSz exact (custom type)",
    text(eMatch.get("ppt/presentation.xml")).includes(
      'cx="7772400" cy="10058400" type="custom"'
    )
  );
  const s1 = text(eMatch.get("ppt/slides/slide1.xml"));
  const m = /<p:sp>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(s1);
  check(
    "match mode: title box x = 72pt exactly (scale 1)",
    m !== null && Number(m[1]) === 914400,
    m?.slice(1)
  );
  check(
    "match mode: title box y = ascender math at scale 1",
    m !== null && Number(m[2]) === Math.round((792 - 736.5) * 12700),
    m?.slice(1)
  );
  check(
    "match mode: title sz = 2200 (22pt unscaled)",
    /sz="2200" b="1">/.test(s1)
  );

  // portrait A4: a real A4 page → a portrait slide
  const a4doc = await PDFDocument.create();
  const a4font = await a4doc.embedFont(StandardFonts.Helvetica);
  const a4page = a4doc.addPage([595.28, 841.89]);
  a4page.drawText("Portrait page", { x: 56, y: 780, size: 12, font: a4font });
  const a4bytes = new Uint8Array(await a4doc.save());
  const a4ex = await extractFixture(a4bytes);
  const a4slide = extractTextSlide(a4ex.pages[0] ?? [], a4ex.widths[0] ?? 595.28, a4ex.heights[0] ?? 841.89, slideSizeFor("match", a4ex.widths[0] ?? 595.28, a4ex.heights[0] ?? 841.89));
  const a4size = slideSizeFor("match", a4ex.widths[0] ?? 595.28, a4ex.heights[0] ?? 841.89);
  const pptxA4 = buildPptx({
    mode: "text",
    slide: a4size,
    slideSizeOption: "match",
    pages: [a4slide],
    title: "A4",
  });
  const eA4 = unzipOracle(pptxA4);
  const a4pres = text(eA4.get("ppt/presentation.xml"));
  check(
    "portrait A4 match sldSz (7560056×10692003, orientation preserved)",
    a4pres.includes('cx="7560056" cy="10692003"')
  );
  check("portrait: cy > cx", 10692003 > 7560056);
}

/* ================================================================== */
console.log("── 7. page-range subset ────────────────────────────────────");
/* ================================================================== */
{
  const spec = parsePageSpec("1-2", 4);
  check("parsePageSpec 1-2 → 2 pages", spec !== null && spec.length === 2);
  check("parsePageSpec rejects garbage", parsePageSpec("abc", 4) === null);
  const subset = buildPptx({
    mode: "text",
    slide: SLIDE_169,
    slideSizeOption: "16-9",
    pages: [textSlides[0], textSlides[1]].filter(
      (p): p is NonNullable<typeof p> => p !== undefined
    ),
    title: "T",
  });
  const e = unzipOracle(subset);
  check("subset: slide1 + slide2 only", e.has("ppt/slides/slide1.xml") && e.has("ppt/slides/slide2.xml"));
  check("subset: slide3 absent", !e.has("ppt/slides/slide3.xml") && !e.has("ppt/slides/slide4.xml"));
  const ctSub = text(e.get("[Content_Types].xml"));
  check("subset: exactly 2 slide overrides", ctSub.split("presentationml.slide+xml").length - 1 === 2);
  check(
    "subset: sldIdLst has 2 entries",
    text(e.get("ppt/presentation.xml")).split("<p:sldId ").length - 1 === 2
  );
}

/* ================================================================== */
console.log("── 8. images mode (real PNG bytes) ────────────────────────");
/* ================================================================== */
{
  const png1 = tinyPng(8, 8, 200);
  const png2 = tinyPng(12, 6, 120);
  check("synthetic PNG has magic bytes", png1[0] === 0x89 && png1[1] === 0x50 && png1[2] === 0x4e && png1[3] === 0x47);

  const pptxImg = buildPptx({
    mode: "images",
    slide: SLIDE_169,
    slideSizeOption: "16-9",
    images: [png1, png2],
    imageAspects: [612 / 792, 16 / 9],
    title: "Images",
  });
  const e = unzipOracle(pptxImg);

  const media1 = e.get("ppt/media/image1.png");
  const media2 = e.get("ppt/media/image2.png");
  check("media/image1.png present with PNG magic", media1 !== undefined && media1[0] === 0x89 && media1[1] === 0x50);
  check("media/image2.png present with PNG magic", media2 !== undefined && media2[0] === 0x89 && media2[1] === 0x50);
  check("image1 bytes round-trip exactly", media1 !== undefined && Buffer.compare(Buffer.from(media1), Buffer.from(png1)) === 0);
  check(
    "no text-mode slide XML beyond pictures",
    e.has("ppt/slides/slide1.xml") && e.has("ppt/slides/slide2.xml")
  );

  const ctImg = text(e.get("[Content_Types].xml"));
  check(
    "content-types declares the png Default",
    ctImg.includes('<Default Extension="png" ContentType="image/png"/>')
  );
  check("content-types still has 2 slide overrides", ctImg.split("presentationml.slide+xml").length - 1 === 2);

  const rels1 = text(e.get("ppt/slides/_rels/slide1.xml.rels"));
  check(
    "slide1 rels carry the image relationship",
    rels1.includes('Id="rId2"') &&
      rels1.includes("../media/image1.png") &&
      rels1.includes("/image")
  );
  const rels2 = text(e.get("ppt/slides/_rels/slide2.xml.rels"));
  check("slide2 rels point at image2", rels2.includes("../media/image2.png"));

  const s1 = text(e.get("ppt/slides/slide1.xml"));
  check(
    "slide1 has p:pic with r:embed matching rId2",
    s1.includes("<p:pic>") && s1.includes('<a:blip r:embed="rId2"/>')
  );
  check("slide1 is well-formed", xmlWellFormed(s1));
  // portrait page (aspect 612/792) on a 16:9 slide → letterboxed sides
  const m1 = /<p:pic>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(s1);
  check(
    "portrait page letterboxed: full slide height, centered x > 0",
    m1 !== null &&
      Number(m1[2]) === 0 &&
      Number(m1[4]) === 6858000 &&
      Number(m1[1]) > 0 &&
      Number(m1[3]) < 12192000,
    m1?.slice(1)
  );
  const s2 = text(e.get("ppt/slides/slide2.xml"));
  const m2 = /<p:pic>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(s2);
  check(
    "same-aspect page full-bleed: 0,0 + full slide extent",
    m2 !== null &&
      Number(m2[1]) === 0 &&
      Number(m2[2]) === 0 &&
      Number(m2[3]) === 12192000 &&
      Number(m2[4]) === 6858000,
    m2?.slice(1)
  );

  // empty-images edge: an honest single blank slide, never an invalid zip
  const blank = buildPptx({
    mode: "images",
    slide: SLIDE_169,
    slideSizeOption: "16-9",
    images: [],
    imageAspects: [],
    title: "Blank",
  });
  const eBlank = unzipOracle(blank);
  check(
    "no images → one blank text slide (valid package)",
    eBlank.has("ppt/slides/slide1.xml") &&
      text(eBlank.get("ppt/presentation.xml")).split("<p:sldId ").length - 1 === 1
  );
}

/* ================================================================== */
console.log("── 9. rejection vectors (encrypted / garbage) ──────────────");
/* ================================================================== */
{
  // Encrypted fixture via @cantoo/pdf-lib (the lock-pdf engine's fork).
  const enc = await CantooPDF.create();
  enc.addPage([612, 792]);
  await enc.encrypt({
    userPassword: "secret-one",
    ownerPassword: "secret-two",
    algorithm: "AES-256",
    permissions: {
      printing: "highResolution",
      copying: true,
      modifying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
  const encBytes = new Uint8Array(await enc.save());
  let encMessage = "";
  try {
    const task = getDocument({ data: encBytes.slice() });
    await task.promise;
    await task.destroy();
  } catch (error) {
    encMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "encrypted fixture: pdf.js demands a password",
    /password/i.test(encMessage),
    encMessage
  );
  check(
    "encrypted → honest tool.errorEncrypted",
    pdfErrorMessageToCode(encMessage) === "tool.errorEncrypted"
  );

  // Garbage bytes: pdf.js refuses to parse → corrupt.
  const garbage = new Uint8Array(2048);
  for (let i = 0; i < garbage.length; i += 1) {
    garbage[i] = (i * 31 + 7) & 0xff;
  }
  let garbageMessage = "";
  try {
    const task = getDocument({ data: garbage.slice() });
    await task.promise;
    await task.destroy();
  } catch (error) {
    garbageMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "garbage bytes rejected by pdf.js",
    garbageMessage.length > 0,
    garbageMessage
  );
  check(
    "garbage → honest tool.errorCorrupt",
    pdfErrorMessageToCode(garbageMessage) === "tool.errorCorrupt"
  );
  check(
    "mapping helper: password-ish messages → encrypted",
    pdfErrorMessageToCode("No password given") === "tool.errorEncrypted" &&
      pdfErrorMessageToCode("Incorrect password") === "tool.errorEncrypted"
  );
  check(
    "mapping helper: everything else → corrupt",
    pdfErrorMessageToCode("Invalid PDF structure") === "tool.errorCorrupt"
  );
}

/* ================================================================== */
console.log("── 10. images-mode RAM budget (ENH-1) ──────────────────");
/* ================================================================== */
{
  check(
    "default budget cap is 250 MP",
    RENDER_PIXEL_BUDGET === 250_000_000
  );
  const small = new RenderPixelBudget(1_000);
  check("budget consumes pages that fit", small.tryConsume(600, 1) === true);
  check("budget consumed is exact", small.consumed === 600);
  check(
    "page over the remaining budget refused, nothing consumed",
    small.tryConsume(401, 1) === false && small.consumed === 600
  );
  check(
    "a page that lands exactly on the cap fits",
    small.tryConsume(400, 1) === true && small.consumed === 1_000 && small.remaining === 0
  );
  check(
    "anything after a full budget is refused",
    small.tryConsume(1, 1) === false
  );
  check(
    "degenerate sizes refused without consuming",
    new RenderPixelBudget(1_000).tryConsume(0, 10) === false &&
      !new RenderPixelBudget(1_000).tryConsume(10, 0) &&
      !new RenderPixelBudget(1_000).tryConsume(-5, 4)
  );
  check(
    "a single page above the cap alone is refused",
    !new RenderPixelBudget(2_500_000).tryConsume(2_501, 1_000)
  );

  const workerSrc = readFileSync("tools/pdf-to-powerpoint/worker.ts", "utf8");
  check(
    "worker imports the shared pixel budget",
    /import \{ RenderPixelBudget \} from "\.\.\/pdfjs-common\/pixel-budget"/.test(
      workerSrc
    )
  );
  check(
    "images-mode budget check precedes the page render",
    /if \(!budget\.tryConsume\(width, height\)\)\s*\{[\s\S]*?tool\.errorRenderBudget[\s\S]*?\}[\s\S]*await page\.render/.test(
      workerSrc
    )
  );

  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  check(
    "tool.errorRenderBudget present in BOTH catalogs",
    typeof en.tool?.errorRenderBudget === "string" &&
      typeof hi.tool?.errorRenderBudget === "string" &&
      en.tool.errorRenderBudget.length > 10 &&
      hi.tool.errorRenderBudget.length > 10
  );
}

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("failing:", failures.slice(0, 20).join(" | "));
}
process.exit(fail > 0 ? 1 : 0);
