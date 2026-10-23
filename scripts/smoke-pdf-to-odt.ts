/**
 * Smoke: pdf-to-odt (RB4-d) — PDF → OpenDocument Text, 100% on-device.
 *
 * House conventions: real fixtures built with pdf-lib, text extracted
 * through pdfjs-dist/legacy (in-process, the smoke-pdf-to-word
 * recipe), node:zlib inflateRawSync local-header walk as the
 * independent ZIP oracle (NOT fflate — and the walk preserves entry
 * order, so "mimetype FIRST + STORED" is provable), local imports
 * without .ts, process.exit at the end.
 *
 *  1. Pure helpers — xmlEscape, fixDevanagariVisual, docTitleFrom,
 *     coerceRunOptions tamper vectors, outputBaseName vectors,
 *     odtStats.
 *  2. Synthetic extraction — heading rank ladder (six tiers →
 *     outline levels 1-6), paragraph merge, bold/italic run splits,
 *     pageMarks with an honest empty page.
 *  3. REAL fixture — a 4-page PDF (EN title/size hierarchy + bold/
 *     italic runs + XML-hostile text + an empty page + a Hindi
 *     Devanagari page) built with pdf-lib, extracted through pdf.js
 *     getTextContent, enriched with the worker's own buildFontStyleMap.
 *  4. Package structure — the node:zlib oracle walks the zipSync
 *     output: mimetype FIRST and STORED, container/manifest/content/
 *     styles/meta present; content.xml carries text:h outline-levels
 *     for the heading ranks, text:p paragraphs, text:span with the
 *     automatic styles T1/T2/T3, dc:title from the PDF info, escaped
 *     hostile text, Hindi needles as UTF-8.
 *  5. THE ROUND-TRIP — the mirror tool's parseOdt (odt-to-pdf) READS
 *     the generated .odt: kind text, 12 blocks, heading levels 1/2/3,
 *     bold/italic runs resolved through the T1/T2 parent-style
 *     chains, merged paragraph text, hostile text decoded, Hindi
 *     intact. The strongest oracle available: our output must satisfy
 *     the mirror's parser.
 *  6. Page-range subset — "1, 4" → only those pages in the package.
 *  7. Per-page switch — four outputs, the empty page an honest
 *     one-paragraph document, each round-trips through parseOdt.
 *  8. Rejection vectors — an @cantoo-encrypted PDF (pdf.js asks for a
 *     password) → tool.errorEncrypted; garbage bytes → tool.errorCorrupt.
 *  9. Wiring + i18n — config/registry/configs/surfaces routed, worker
 *     naming pattern, en/hi key parity, every referenced podt.* key
 *     resolves.
 *
 * Run: bun scripts/smoke-pdf-to-odt.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildOdt,
  coerceRunOptions,
  docTitleFrom,
  extractOdtBlocks,
  fixDevanagariVisual,
  ODT_MIME,
  odtStats,
  outputBaseName,
  pageBlocksOf,
  pdfErrorMessageToCode,
  xmlEscape,
  type OdtBlock,
  type PdfTextItemInput,
} from "../tools/pdf-to-odt/model";
import { parseOdt, type OdfTextBlock } from "../tools/odt-to-pdf/model";
import { parsePageSpec } from "../src/lib/workers/protocol";

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

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
}

/**
 * node:zlib ZIP oracle — walks the local file headers IN ORDER and
 * inflates every entry itself (fflate writes RAW deflate, hence
 * inflateRawSync). Order is preserved, so "mimetype first" is testable.
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

function text(bytes: Uint8Array | Buffer | undefined): string {
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
  opts: { width?: number; fontName?: string; bold?: boolean; italic?: boolean } = {}
): PdfTextItemInput {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: opts.width ?? str.length * size * 0.5,
    fontName: opts.fontName ?? "F",
    bold: opts.bold,
    italic: opts.italic,
  };
}

/** Table blocks carry rows, not runs — runtime-safe mirror accessors. */
const runsOf = (
  b: OdfTextBlock | undefined
): readonly { text: string; bold: boolean; italic: boolean }[] =>
  b && b.kind !== "table" ? b.runs : [];
const textOf = (b: OdfTextBlock | undefined): string =>
  runsOf(b)
    .map((r) => r.text)
    .join("");

const joined = (blocks: readonly OdfTextBlock[]): string =>
  blocks.map((b) => textOf(b)).join(" ");

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
  "fixDevanagariVisual repairs a pre-base matra",
  fixDevanagariVisual("िप्रया शर्मा") === "प्रिया शर्मा"
);
check("fixDevanagariVisual leaves plain text", fixDevanagariVisual("hello नमस्ते") === "hello नमस्ते");

check(
  "docTitleFrom takes the info Title",
  docTitleFrom({ Title: "Falcon Quarterly Report" }, "fallback") ===
    "Falcon Quarterly Report"
);
check(
  "docTitleFrom falls back on a blank Title",
  docTitleFrom({ Title: "   " }, "First Heading") === "First Heading"
);
check(
  "docTitleFrom falls back on a missing info object",
  docTitleFrom(null, "First Heading") === "First Heading" &&
    docTitleFrom(undefined, "H") === "H"
);
check(
  "docTitleFrom clamps to 120 chars",
  docTitleFrom({ Title: "x".repeat(300) }, "f").length === 120
);

/* ---------------- coerceRunOptions tamper vectors ---------------- */
{
  const defaults = coerceRunOptions({});
  check(
    "empty options → honest defaults",
    defaults.pages === "all" &&
      defaults.perPage === false &&
      defaults.locale === "en" &&
      defaults.fileWord === "",
    defaults
  );
  const full = coerceRunOptions({
    pages: "1-3, 5",
    perPage: true,
    locale: "hi",
    fileWord: "दस्तावेज़",
  });
  check(
    "every field honoured",
    full.pages === "1-3, 5" &&
      full.perPage === true &&
      full.locale === "hi" &&
      full.fileWord === "दस्तावेज़"
  );
  const garbage = coerceRunOptions({
    pages: 42,
    perPage: "yes",
    locale: "fr",
    fileWord: 7,
  });
  check(
    "wrong types degrade to defaults",
    garbage.pages === "all" &&
      garbage.perPage === false &&
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
  "outputBaseName strips .pdf",
  outputBaseName("My Report.pdf", "en", "") === "My Report"
);
check(
  "outputBaseName replaces path-unsafe chars",
  outputBaseName('we/ird*name?.pdf', "en", "") === "we_ird_name_"
);
check(
  "outputBaseName keeps Devanagari",
  outputBaseName("रिपोर्ट final.pdf", "en", "") === "रिपोर्ट final"
);
check(
  "outputBaseName drops a trailing dot run",
  outputBaseName("draft...pdf", "en", "") === "draft"
);
check(
  "outputBaseName empty → localized word",
  outputBaseName(".pdf", "hi", "दस्तावेज़") === "दस्तावेज़" &&
    outputBaseName("", "en", "document") === "document"
);
check(
  "outputBaseName blank fileWord → hard fallback",
  outputBaseName("", "hi", "") === "दस्तावेज़" &&
    outputBaseName("", "en", "") === "document"
);
check(
  "outputBaseName clamps to 120 chars",
  outputBaseName(`${"y".repeat(200)}.pdf`, "en", "").length === 120
);

/* ---------------- odtStats ---------------- */
{
  const blocks: OdtBlock[] = [
    { kind: "para", runs: [{ text: "a", bold: false, italic: false, sizePt: 11 }] },
    {
      kind: "para",
      runs: [{ text: "b", bold: true, italic: false, sizePt: 22 }],
      headingLevel: 1,
    },
  ];
  const stats = odtStats(blocks);
  check(
    "odtStats counts paragraphs + headings",
    stats.paragraphs === 2 && stats.headings === 1,
    stats
  );
}

/* ================================================================== */
console.log("── 2. synthetic extraction (heading ladder / runs / marks) ─");
/* ================================================================== */
{
  // Six clearly-ranked sizes → outline levels 1-6, body 10pt. Gaps
  // exceed 1.7× the previous line's size so every tier stays its own
  // paragraph even where the size-change rule alone is not enough.
  const page = [
    item("Tier One Heading", 72, 720, 32, { width: 200 }),
    item("Tier Two Heading", 72, 688, 24, { width: 170 }),
    item("Tier Three Heading", 72, 655, 19, { width: 160 }),
    item("Tier Four Heading", 72, 622, 15.5, { width: 150 }),
    item("Tier Five Heading", 72, 594, 13.5, { width: 150 }),
    item("Tier Six Heading", 72, 566, 12.5, { width: 150 }),
    item("body line one joins", 72, 530, 10),
    item("body line two joins", 72, 516, 10),
    item("separate paragraph", 72, 470, 10),
  ];
  const model = extractOdtBlocks([page]);
  const levels = model.blocks.map((b) => b.headingLevel ?? 0);
  check(
    "six ranked tiers → outline levels 1-6",
    levels.slice(0, 6).join(",") === "1,2,3,4,5,6",
    levels
  );
  check("body stays body (no heading on 10pt)", levels.slice(6).join(",") === "0,0", levels);
  check(
    "two tight body lines merge into one paragraph",
    model.blocks.length === 8,
    model.blocks.length
  );
  check(
    "merged body text exact",
    model.blocks[6]?.runs.map((r) => r.text).join("") ===
      "body line one joins body line two joins",
    model.blocks[6]
  );
  check(
    "pageMarks: one mark for the single page",
    model.pageMarks.length === 1 && model.pageMarks[0] === 0
  );
  check(
    "headingPt maps all six levels to their tier sizes",
    [...model.headingPt.entries()].map(([l, s]) => `${l}:${s}`).join(",") ===
      "1:32,2:24,3:19,4:15.5,5:13.5,6:12.5",
    [...model.headingPt.entries()]
  );
  check("bodyPt detected as the char-weighted mode", model.bodyPt === 10, model.bodyPt);
}
{
  // An empty page between two text pages keeps its mark.
  const model = extractOdtBlocks([
    [item("First page body", 72, 700, 11)],
    [],
    [item("Third page body", 72, 700, 11)],
  ]);
  check(
    "empty pages keep their page mark",
    model.pageMarks.length === 3 &&
      model.pageMarks[0] === 0 &&
      model.pageMarks[1] === 1 &&
      model.pageMarks[2] === 1,
    model.pageMarks
  );
  check(
    "pageBlocksOf splits at the marks (empty middle)",
    pageBlocksOf(model, 0).length === 1 &&
      pageBlocksOf(model, 1).length === 0 &&
      pageBlocksOf(model, 2).length === 1
  );
  check(
    "pageBlocksOf out-of-range → empty",
    pageBlocksOf(model, 3).length === 0 && pageBlocksOf(model, -1).length === 0
  );
}
{
  // Same baseline, different styles → one line, three runs.
  const model = extractOdtBlocks([
    [
      item("plain bit", 72, 700, 11),
      item("bold bit", 140, 700, 11, { bold: true }),
      item("italic bit", 200, 700, 11, { italic: true }),
    ],
  ]);
  const runs = model.blocks[0]?.runs ?? [];
  check("style changes split runs", runs.length === 3, runs.map((r) => r.text));
  check(
    "run styles detected",
    runs[0]?.bold === false &&
      runs[0]?.italic === false &&
      runs[1]?.bold === true &&
      runs[2]?.italic === true,
    runs
  );
}

/* ================================================================== */
console.log("── 3. real fixture: pdf-lib build → pdf.js extract ──────");
/* ================================================================== */

const notoBytes = new Uint8Array(
  readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  )
);

/**
 * The 4-page fixture (612×792 Letter): EN title/size hierarchy (22/16/14
 * + 11 body), bold/italic runs on one line, XML-hostile text, page 2
 * body, page 3 EMPTY (scan stand-in), page 4 Hindi Devanagari.
 */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Falcon Quarterly Report");
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

  const page1 = doc.addPage([612, 792]);
  page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
  page1.drawText("Falcon Division Results", { x: 72, y: 692, size: 16, font: bold });
  page1.drawText("Regional performance detail", { x: 72, y: 662, size: 14, font: helv });
  page1.drawText("This report covers the first quarter.", {
    x: 72,
    y: 628,
    size: 11,
    font: helv,
  });
  page1.drawText("Numbers improved across every region.", {
    x: 72,
    y: 614,
    size: 11,
    font: helv,
  });
  page1.drawText("A later section with a clear gap.", {
    x: 72,
    y: 556,
    size: 11,
    font: helv,
  });
  page1.drawText("Plain start, then", { x: 72, y: 518, size: 11, font: helv });
  page1.drawText("bold words,", { x: 178, y: 518, size: 11, font: bold });
  page1.drawText("italic tail ends here.", { x: 283, y: 518, size: 11, font: ital });
  page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", {
    x: 72,
    y: 478,
    size: 11,
    font: helv,
  });

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Second Page Heading", { x: 72, y: 720, size: 16, font: bold });
  page2.drawText("Page two carries the summary and closing notes.", {
    x: 72,
    y: 680,
    size: 11,
    font: helv,
  });
  page2.drawText("The final figures land within the expected band.", {
    x: 72,
    y: 666,
    size: 11,
    font: helv,
  });

  const page3 = doc.addPage([612, 792]); // deliberately empty (a scan stand-in)

  const page4 = doc.addPage([612, 792]);
  page4.drawText("त्रैमासिक रिपोर्ट", { x: 72, y: 720, size: 22, font: noto });
  page4.drawText("प्रिया शर्मा की टीम", { x: 72, y: 684, size: 14, font: noto });
  page4.drawText("यह रिपोर्ट आपके डिवाइस पर बनती है।", {
    x: 72,
    y: 644,
    size: 11,
    font: noto,
  });

  return new Uint8Array(await doc.save());
}

async function extractFixture(bytes: Uint8Array): Promise<PdfTextItemInput[][]> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const pages: PdfTextItemInput[][] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      pages.push(content.items as PdfTextItemInput[]);
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return pages;
}

const fixture = await buildFixture();
check("fixture built (starts with %PDF)", fixture[0] === 0x25 && fixture.length > 500);

const pages = await extractFixture(fixture);
check("pdf.js read all 4 pages", pages.length === 4);
check("page 3 has no text items", (pages[2] ?? []).length === 0);
const flat4 = pages[3] ?? [];
const allText4 = flat4
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "Hindi page extracted with Devanagari",
  /[\u0900-\u097F]/.test(allText4) && allText4.includes("की टीम")
);
const flat1 = pages[0] ?? [];
const allText1 = flat1
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "raw page-1 extraction sees title, body, styled runs, hostile text",
  allText1.includes("Quarterly Report") &&
    allText1.includes("Numbers improved") &&
    allText1.includes("bold words,") &&
    allText1.includes("italic tail") &&
    allText1.includes("Q1 < Q2"),
  allText1.slice(0, 200)
);

/* ---- the worker's own bold/italic enrichment (self shim first) ---- */
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (): void => undefined;
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
const { buildFontStyleMap } = await import("../tools/pdf-to-odt/worker");

const styleMap = await buildFontStyleMap(fixture, pages);
const boldItem = flat1.find(
  (i) => typeof i.str === "string" && i.str === "bold words,"
);
const italicItem = flat1.find(
  (i) => typeof i.str === "string" && i.str === "italic tail ends here."
);
const bodyItem = flat1.find(
  (i) => typeof i.str === "string" && i.str.startsWith("This report covers")
);
check(
  "buildFontStyleMap resolves the bold run's pdf.js id to bold",
  boldItem !== undefined &&
    styleMap.get(String(boldItem.fontName))?.bold === true,
  { map: [...styleMap.entries()] }
);
check(
  "buildFontStyleMap resolves the italic run's id to italic",
  italicItem !== undefined &&
    styleMap.get(String(italicItem.fontName))?.italic === true
);
check(
  "body font stays plain (neither bold nor italic)",
  bodyItem !== undefined &&
    styleMap.get(String(bodyItem.fontName))?.bold === false &&
    styleMap.get(String(bodyItem.fontName))?.italic === false
);

/* ---- the model on the REAL extracted items ---- */
const model = extractOdtBlocks(pages, { styleMap });
const stats = odtStats(model.blocks);
check("12 blocks detected (7 + 2 + 0 + 3)", stats.paragraphs === 12, stats);
check("6 headings detected (2×H1, 2×H2, 2×H3)", stats.headings === 6, stats);
check(
  "pageMarks cover every page (empty page 3 keeps its mark)",
  model.pageMarks.length === 4 &&
    model.pageMarks[0] === 0 &&
    model.pageMarks[1] === 7 &&
    model.pageMarks[2] === 9 &&
    model.pageMarks[3] === 9,
  model.pageMarks
);
check(
  "tier ladder: 22→1, 16→2, 14→3",
  [...model.headingPt.entries()].map(([l, s]) => `${l}:${s}`).join(",") ===
    "1:22,2:16,3:14",
  [...model.headingPt.entries()]
);
check("bodyPt is the 11pt mode", model.bodyPt === 11, model.bodyPt);

const b = model.blocks;
check(
  "H1 title detected on page 1",
  b[0]?.headingLevel === 1 &&
    b[0]?.runs[0]?.text === "Quarterly Report" &&
    b[0]?.runs[0]?.bold === true,
  b[0]
);
check("H2 section detected", b[1]?.headingLevel === 2 && b[1]?.runs[0]?.text === "Falcon Division Results", b[1]);
check("H3 sub-section detected", b[2]?.headingLevel === 3 && b[2]?.runs[0]?.text === "Regional performance detail", b[2]);
check(
  "two-line body merged into one paragraph",
  (b[3]?.runs ?? []).map((r) => r.text).join("") ===
    "This report covers the first quarter. Numbers improved across every region.",
  b[3]
);
check(
  "styled paragraph keeps three runs with flags",
  b[5]?.runs.length === 3 &&
    b[5]?.runs[0]?.bold === false &&
    b[5]?.runs[1]?.bold === true &&
    (b[5]?.runs[1]?.text ?? "").trim() === "bold words," &&
    b[5]?.runs[2]?.italic === true &&
    (b[5]?.runs[2]?.text ?? "").trim() === "italic tail ends here.",
  b[5]
);
check(
  "page-2 H2 + merged body",
  b[7]?.headingLevel === 2 &&
    b[7]?.runs[0]?.text === "Second Page Heading" &&
    (b[8]?.runs ?? []).map((r) => r.text).join("") ===
      "Page two carries the summary and closing notes. The final figures land within the expected band.",
  b[8]
);
check(
  "Hindi H1 + H3 + body",
  b[9]?.headingLevel === 1 &&
    (b[9]?.runs ?? []).map((r) => r.text).join("").includes("त्रैमासिक") &&
    b[10]?.headingLevel === 3 &&
    (b[10]?.runs ?? []).map((r) => r.text).join("").includes("प्रिया शर्मा") &&
    (b[11]?.runs ?? []).map((r) => r.text).join("").includes("यह रिपोर्ट"),
  [b[9], b[10], b[11]]
);
check(
  "matra repaired in the model (logical order)",
  (b[9]?.runs ?? []).map((r) => r.text).join("").includes("त्रैमासिक") &&
    !(b[9]?.runs ?? []).map((r) => r.text).join("").includes("मािसक")
);

/* ---- document title from the PDF's info dictionary ---- */
{
  const metaTask = getDocument({ data: fixture.slice(), useSystemFonts: true });
  const metaDoc = await metaTask.promise;
  const meta = await metaDoc.getMetadata();
  check(
    "pdf.js reads the info Title",
    (meta.info as { Title?: unknown })?.Title === "Falcon Quarterly Report",
    (meta.info as { Title?: unknown })?.Title
  );
  check(
    "docTitleFrom picks the info Title over the heading fallback",
    docTitleFrom(meta.info, "Quarterly Report") === "Falcon Quarterly Report"
  );
  await metaTask.destroy();
}

/* ================================================================== */
console.log("── 4. package structure via the node:zlib ZIP oracle ───────");
/* ================================================================== */

const style = { bodyPt: model.bodyPt, headingPt: model.headingPt };
const odt = buildOdt(model.blocks, { ...style, title: "Falcon Quarterly Report" });

check("output is a zip (PK magic)", odt[0] === 0x50 && odt[1] === 0x4b);
check("local magic PK\\x03\\x04", odt[2] === 0x03 && odt[3] === 0x04);

let entries: ZipEntry[];
try {
  entries = readZipWithZlib(odt);
} catch (error) {
  entries = [];
  check("oracle walks the archive", false, String(error));
}

/* (a) ODF packaging rules */
const first = entries[0];
check(
  "mimetype is the FIRST entry",
  first?.name === "mimetype",
  entries.map((e) => e.name)
);
check("mimetype is STORED (method 0)", first?.method === 0);
check(
  "mimetype carries the ODT media type",
  text(first?.data) === ODT_MIME &&
    ODT_MIME === "application/vnd.oasis.opendocument.text",
  text(first?.data)
);
const names = entries.map((e) => e.name);
for (const part of [
  "META-INF/container.xml",
  "META-INF/manifest.xml",
  "content.xml",
  "styles.xml",
  "meta.xml",
]) {
  check(`zip entry ${part}`, names.includes(part));
}
check("no stray entries", entries.length === 6, names);

/* (b) container + manifest */
const container = text(
  entries.find((e) => e.name === "META-INF/container.xml")?.data
);
check(
  "container locates content.xml with the ODT media type",
  container.includes('full-path="content.xml"') &&
    container.includes(ODT_MIME)
);
check("container is well-formed", xmlWellFormed(container));
const manifest = text(
  entries.find((e) => e.name === "META-INF/manifest.xml")?.data
);
check(
  "manifest lists every part (incl. container + meta)",
  manifest.includes('manifest:full-path="/"') &&
    manifest.includes('manifest:full-path="META-INF/container.xml"') &&
    manifest.includes('manifest:full-path="content.xml"') &&
    manifest.includes('manifest:full-path="styles.xml"') &&
    manifest.includes('manifest:full-path="meta.xml"')
);
check(
  "manifest root media-type is the ODT type",
  manifest.includes(`manifest:media-type="${ODT_MIME}"`)
);
check("manifest is well-formed", xmlWellFormed(manifest));

/* (c) content.xml */
const content = text(entries.find((e) => e.name === "content.xml")?.data);
check("content.xml is well-formed", xmlWellFormed(content));
check(
  "dc:title from the PDF info",
  content.includes("<dc:title>Falcon Quarterly Report</dc:title>")
);
check(
  "meta:generator DocoPDF",
  content.includes("<meta:generator>DocoPDF</meta:generator>")
);
check(
  "automatic styles T1/T2/T3 with parent chains",
  content.includes(
    '<style:style style:name="T1" style:family="text" style:parent-style-name="Bold_20_Span"/>'
  ) &&
    content.includes(
      '<style:style style:name="T2" style:family="text" style:parent-style-name="Italic_20_Span"/>'
    ) &&
    content.includes(
      '<style:style style:name="T3" style:family="text" style:parent-style-name="BoldItalic_20_Span"/>'
    )
);
check(
  "text:h outline-level 1 for the title tier",
  content.includes(
    '<text:h text:style-name="Heading_20_1" text:outline-level="1">Quarterly Report</text:h>'
  )
);
check(
  "text:h outline-level 2 for the section tier",
  content.includes(
    '<text:h text:style-name="Heading_20_2" text:outline-level="2">Falcon Division Results</text:h>'
  )
);
check(
  "text:h outline-level 3 for the sub-section tier",
  content.includes(
    '<text:h text:style-name="Heading_20_3" text:outline-level="3">Regional performance detail</text:h>'
  )
);
check(
  "paragraphs are text:p with the Text_20_Body style",
  content.includes('<text:p text:style-name="Text_20_Body">This report covers')
);
check(
  "bold run wrapped in the T1 automatic style",
  content.includes('<text:span text:style-name="T1">bold words,</text:span>')
);
check(
  "italic run wrapped in the T2 automatic style",
  content.includes(
    '<text:span text:style-name="T2">italic tail ends here.</text:span>'
  )
);
check(
  "XML-hostile text escaped",
  content.includes("revenue &amp; costs") &&
    content.includes("Q1 &lt; Q2 &gt; targets.")
);
check(
  "Hindi survives as UTF-8 (matra repaired)",
  content.includes("त्रैमासिक") &&
    content.includes("प्रिया शर्मा की टीम") &&
    content.includes("डिवाइस") &&
    !content.includes("मािसक")
);
check(
  "page-2 heading + body present",
  content.includes("Second Page Heading") &&
    content.includes("The final figures land within the expected band.")
);

/* (d) styles.xml */
const stylesPart = text(entries.find((e) => e.name === "styles.xml")?.data);
check("styles.xml is well-formed", xmlWellFormed(stylesPart));
check(
  "Text_20_Body carries the detected body size",
  stylesPart.includes(
    '<style:style style:name="Text_20_Body" style:family="paragraph" style:parent-style-name="Standard" style:class="text">' +
      '<style:text-properties fo:font-size="11pt"/></style:style>'
  )
);
check(
  "Heading styles carry tier sizes + bold",
  stylesPart.includes('style:name="Heading_20_1"') &&
    stylesPart.includes('fo:font-size="22pt"') &&
    stylesPart.includes('style:name="Heading_20_2"') &&
    stylesPart.includes('fo:font-size="16pt"') &&
    stylesPart.includes('style:name="Heading_20_3"') &&
    stylesPart.includes('fo:font-size="14pt"') &&
    stylesPart.includes('fo:font-weight="bold"')
);
check(
  "common character styles the T1/T2/T3 chains resolve",
  stylesPart.includes('style:name="Bold_20_Span"') &&
    stylesPart.includes('style:name="Italic_20_Span"') &&
    stylesPart.includes('style:name="BoldItalic_20_Span"')
);
check(
  "only detected heading levels emitted (1-3, not 4-6)",
  !stylesPart.includes("Heading_20_4") && !stylesPart.includes("Heading_20_5") && !stylesPart.includes("Heading_20_6")
);

/* (e) meta.xml */
const metaPart = text(entries.find((e) => e.name === "meta.xml")?.data);
check("meta.xml is well-formed", xmlWellFormed(metaPart));
check(
  "meta.xml carries the same dc:title + generator",
  metaPart.includes("<dc:title>Falcon Quarterly Report</dc:title>") &&
    metaPart.includes("<meta:generator>DocoPDF</meta:generator>")
);

/* ================================================================== */
console.log("── 5. THE ROUND-TRIP (odt-to-pdf parseOdt reads it) ───────");
/* ================================================================== */
{
  const mirror = parseOdt(odt);
  check("mirror sees a text document", mirror.kind === "text");
  if (mirror.kind === "text") {
    check(
      "mirror sees all 12 blocks, nothing truncated",
      mirror.blocks.length === 12 && mirror.truncated === false,
      { blocks: mirror.blocks.length, truncated: mirror.truncated }
    );
    const mb = mirror.blocks;
    check(
      "mirror reads the H1 title",
      mb[0]?.kind === "heading" && mb[0]?.level === 1 &&
        mb[0]?.runs.map((r) => r.text).join("") === "Quarterly Report",
      mb[0]
    );
    check(
      "mirror reads H2 + H3 (rank ladder survives)",
      mb[1]?.kind === "heading" && mb[1]?.level === 2 &&
        mb[2]?.kind === "heading" && mb[2]?.level === 3
    );
    check(
      "mirror reads the merged paragraph text",
      textOf(mb[3]) ===
        "This report covers the first quarter. Numbers improved across every region.",
      mb[3]
    );
    const styled = mb[5];
    check(
      "mirror resolves bold through the T1 parent chain",
      runsOf(styled).some((r) => r.text.includes("bold words,") && r.bold === true) === true,
      runsOf(styled).map((r) => ({ t: r.text, b: r.bold, i: r.italic }))
    );
    check(
      "mirror resolves italic through the T2 parent chain",
      runsOf(styled).some((r) => r.text.includes("italic tail") && r.italic === true) === true
    );
    check(
      "plain run stays unstyled in the mirror",
      runsOf(styled).some((r) => r.text.includes("Plain start") && r.bold === false && r.italic === false) === true
    );
    check(
      "mirror decodes the XML-hostile text",
      textOf(mb[6]) ===
        "Notes: revenue & costs, Q1 < Q2 > targets.",
      mb[6]
    );
    check(
      "mirror reads the Hindi H1 (matra-repaired UTF-8)",
      mb[9]?.kind === "heading" && mb[9]?.level === 1 &&
        mb[9]?.runs.map((r) => r.text).join("").includes("त्रैमासिक"),
      mb[9]
    );
    check(
      "mirror reads the Hindi H3 + body",
      mb[10]?.kind === "heading" && mb[10]?.level === 3 &&
        mb[10]?.runs.map((r) => r.text).join("").includes("प्रिया शर्मा की टीम") &&
        textOf(mb[11]).includes("यह रिपोर्ट आपके डिवाइस पर बनती है।"),
      [mb[10], mb[11]]
    );
    check(
      "joined mirror text carries every page",
      joined(mb).includes("Second Page Heading") &&
        joined(mb).includes("The final figures land within the expected band.")
    );
  }
}

/* ================================================================== */
console.log("── 6. page-range subset (\"1, 4\") ──────────────────────────");
/* ================================================================== */
{
  const spec = parsePageSpec("1, 4", 4);
  check("parsePageSpec 1, 4 → pages 1 and 4", spec !== null && spec.length === 2 && spec[0] === 0 && spec[1] === 3, spec);
  check("parsePageSpec rejects garbage", parsePageSpec("abc", 4) === null);

  const subset = extractOdtBlocks([pages[0] ?? [], pages[3] ?? []], { styleMap });
  const subsetOdt = buildOdt(subset.blocks, {
    bodyPt: subset.bodyPt,
    headingPt: subset.headingPt,
    title: "Falcon Quarterly Report",
  });
  const subEntries = readZipWithZlib(subsetOdt);
  const subContent = text(
    subEntries.find((e) => e.name === "content.xml")?.data
  );
  check(
    "subset: page-1 + Hindi page content only",
    subContent.includes("Quarterly Report") &&
      subContent.includes("त्रैमासिक") &&
      !subContent.includes("Second Page Heading")
  );
  check(
    "subset: still 6 parts, mimetype first + stored",
    subEntries.length === 6 && subEntries[0]?.name === "mimetype" && subEntries[0]?.method === 0
  );
  const subMirror = parseOdt(subsetOdt);
  check(
    "subset round-trips through the mirror",
    subMirror.kind === "text" &&
      (subMirror.kind === "text" ? subMirror.blocks.length === 10 : false),
    subMirror.kind === "text" ? subMirror.blocks.length : subMirror
  );
}

/* ================================================================== */
console.log("── 7. per-page switch → N outputs ───────────────────────");
/* ================================================================== */
{
  const outputs: Uint8Array[] = [];
  for (let i = 0; i < 4; i += 1) {
    outputs.push(
      buildOdt(pageBlocksOf(model, i), { ...style, title: "Falcon Quarterly Report" })
    );
  }
  check("per-page: four outputs", outputs.length === 4);

  const counts: number[] = [];
  let allRoundTrip = true;
  for (const out of outputs) {
    const parsed = parseOdt(out);
    if (parsed.kind !== "text") {
      allRoundTrip = false;
      counts.push(-1);
      continue;
    }
    counts.push(parsed.blocks.length);
  }
  check(
    "per-page round-trip: 7 / 2 / 1 / 3 blocks",
    allRoundTrip && counts.join(",") === "7,2,1,3",
    counts
  );
  const emptyPage = outputs[2];
  const emptyEntries = readZipWithZlib(emptyPage as Uint8Array);
  const emptyContent = text(emptyEntries.find((e) => e.name === "content.xml")?.data);
  check(
    "empty page → one honest empty paragraph (valid body)",
    emptyContent.includes('<text:p text:style-name="Text_20_Body"/>') &&
      parseOdt(emptyPage).kind === "text"
  );
  const page4Content = text(
    readZipWithZlib(outputs[3] as Uint8Array)
      .find((e) => e.name === "content.xml")
      ?.data
  );
  check(
    "per-page output 4 is the Hindi page alone",
    page4Content.includes("त्रैमासिक") && !page4Content.includes("Quarterly Report</text:h>")
  );

  // Worker-side naming pattern (the outputs the worker posts).
  const workerSrc = readFileSync("tools/pdf-to-odt/worker.ts", "utf8");
  check(
    "worker names per-page outputs base-pageN.odt",
    /-page\$\{\(pageNumbers\[i\] as number\) \+ 1\}\.odt/.test(workerSrc)
  );
  check(
    "worker posts N outputs in per-page mode",
    /opts\.perPage/.test(workerSrc) && /outputs\.push/.test(workerSrc)
  );
}

/* ================================================================== */
console.log("── 8. rejection vectors (encrypted / garbage) ──────────────");
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
console.log("── 9. wiring + i18n ──────────────────────────────────────");
/* ================================================================== */
{
  const { config } = await import("../tools/pdf-to-odt/config");
  check("config toolId", config.toolId === "pdf-to-odt");
  check(
    "config outputKind matches pdf-to-word (text)",
    config.outputKind === "text"
  );
  const optionIds = config.options.map((o) => o.id);
  check(
    "config options: pages + perPage",
    optionIds.includes("pages") && optionIds.includes("perPage"),
    optionIds
  );
  check(
    "config options kinds",
    config.options[0]?.kind === "pages" && config.options[1]?.kind === "switch"
  );
  check(
    "config chains to odt-to-pdf (the round-trip closes)",
    (config.chainToolIds ?? []).includes("odt-to-pdf")
  );
  check(
    "config features/faq bilingual",
    config.features.every((f) => f.en && f.hi) &&
      config.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );
  check(
    "config howKeys are podt.*",
    (config.howKeys ?? []).every((k) => k.startsWith("podt."))
  );

  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const regMatch = registrySrc.match(
    new RegExp(`id: "pdf-to-odt"[\\s\\S]*?mode: "(D|S)"[\\s\\S]*?enabled: (true|false)`)
  );
  check(
    "registry pdf-to-odt: mode D + enabled: true",
    regMatch?.[1] === "D" && regMatch?.[2] === "true",
    regMatch?.slice(1)
  );
  check(
    "registry honest name (no RTF/EPUB promise)",
    registrySrc.includes(`id: "pdf-to-odt"`) &&
      !/PDF to ODT \/ RTF \/ EPUB/.test(registrySrc)
  );

  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "TOOL_CONFIGS routes pdf-to-odt",
    /pdfToOdt\.toolId\]\s*:\s*pdfToOdt/.test(configsSrc)
  );
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "TOOL_SURFACES maps pdf-to-odt",
    /"pdf-to-odt": PdfToOdtSurface/.test(surfacesSrc)
  );

  // Worker honesty: scan guard + page-spec validation live in the worker.
  const workerSrc = readFileSync("tools/pdf-to-odt/worker.ts", "utf8");
  check(
    "worker fails scans with tool.errorNoText",
    /tool\.errorNoText/.test(workerSrc)
  );
  check(
    "worker validates the page spec (tool.errorInvalidPages)",
    /tool\.errorInvalidPages/.test(workerSrc)
  );

  // i18n parity + every referenced key resolves.
  const i18n = JSON.parse(
    readFileSync("tools/pdf-to-odt/i18n.json", "utf8")
  ) as { en: { podt: Record<string, string> }; hi: { podt: Record<string, string> } };
  const enKeys = Object.keys(i18n.en.podt).sort();
  const hiKeys = Object.keys(i18n.hi.podt).sort();
  check(
    "i18n en/hi key parity",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys),
    { en: enKeys.length, hi: hiKeys.length }
  );
  check("i18n key count", enKeys.length === 33, enKeys.length);

  const surfaceSrc = readFileSync("tools/pdf-to-odt/surface.tsx", "utf8");
  const used = new Set<string>();
  for (const m of surfaceSrc.matchAll(/t\("podt\.([A-Za-z0-9]+)"/g)) {
    used.add(m[1] as string);
  }
  for (const m of surfaceSrc.matchAll(/labelKey="podt\.([A-Za-z0-9]+)"/g)) {
    used.add(m[1] as string);
  }
  for (const m of surfaceSrc.matchAll(
    /setRunBlocked\("podt\.([A-Za-z0-9]+)"\)/g
  )) {
    used.add(m[1] as string);
  }
  for (const k of config.howKeys ?? []) {
    used.add(k.replace(/^podt\./, ""));
  }
  const missing = [...used].filter((k) => !enKeys.includes(k));
  check(
    "every podt.* key referenced by the surface resolves",
    missing.length === 0,
    missing
  );
  check(
    "no unused podt.* keys (tight namespace)",
    enKeys.every((k) => used.has(k)),
    enKeys.filter((k) => !used.has(k))
  );
}

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("failing:", failures.slice(0, 20).join(" | "));
}
process.exit(fail > 0 ? 1 : 0);
