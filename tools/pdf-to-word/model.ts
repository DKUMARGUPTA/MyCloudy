import { zipSync } from "fflate";

import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF → Word model (RB1-b, the 68th tool) — 100% pure TypeScript:
 * no DOM, no pdf.js, no pdf-lib. The extraction takes PLAIN text-item
 * arrays (the shape pdf.js getTextContent emits) so the smoke can drive
 * it headless, and the docx builder emits a valid minimal .docx (OOXML
 * packaged with fflate zipSync — the house office-conversion recipe).
 *
 * Pipeline (all in this file):
 *  1. collectPieces — coerce + position-tag the raw pdf.js items.
 *  2. buildLines — group by y-proximity (half a font height), order by
 *     x, insert spaces at horizontal gaps (pdf.js emits one item per
 *     Tj operator without carrying spaces — the pdf-to-txt recipe).
 *  3. Paragraphs — a baseline gap noticeably larger than one line
 *     height, or a font-size change, starts a new paragraph; hyphenated
 *     line endings merge back (dehyphenation before a lowercase letter).
 *  4. Headings — font-size clusters: the document's body size is the
 *     char-weighted mode; sizes clearly above it form tiers; the largest
 *     tier becomes Heading1 (title), the next Heading2. Only the top
 *     two tiers are headings — anything smaller stays body text.
 *  5. Bold — kept from the item's fontName (when a real font name is
 *     visible, e.g. "Helvetica-Bold") and from the worker's font-table
 *     enrichment (pdf.js 4.x reports internal ids like "g_d0_f3", so
 *     the worker correlates them with the PDF's own font resources).
 *
 * HONEST limits (mirrored in the FAQ copy): text + structure only.
 * Images, columns and tables come out as a plain text flow; scanned
 * pages need OCR first (the worker fails with tool.errorNoText).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * One raw pdf.js text item — deliberately loose (unknown fields) so the
 * same coercion runs at the worker boundary and in headless tests.
 */
export interface PdfTextItemInput {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
  /** Worker enrichment: bold flag resolved from the PDF's font table. */
  bold?: unknown;
}

/** One styled run inside a paragraph. */
export interface DocxRun {
  text: string;
  bold: boolean;
  sizePt: number;
}

/** One paragraph block. headingLevel is only set when detected + enabled. */
export interface DocxBlock {
  kind: "para";
  runs: DocxRun[];
  headingLevel?: 1 | 2;
}

/** The document model the docx builder consumes. */
export interface WordDocModel {
  blocks: DocxBlock[];
  /** Block index each PDF page starts at (length == page count). */
  pageMarks: number[];
}

/** Worker-boundary options, coerced by parseRun. */
export interface PdfToWordRunOptions {
  headings: boolean;
  pageBreaks: boolean;
  locale: "en" | "hi";
  /** Localized fallback word for the output name ("document"/"दस्तावेज़"). */
  fileWord: string;
}

/** Run summary the surface shows (extends the shared protocol detail). */
export interface PdfToWordDetail extends RunDetail {
  paragraphs?: number;
  headings?: number;
}

/** Clamps — docstring promises, enforced in code. */
export const MAX_PARAGRAPHS = 2000;
export const MAX_RUN_CHARS = 500;
/** Heading tiers need at least this many chars to count as a real tier. */
const TIER_MIN_CHARS = 6;
/** A size must exceed the body size by this ratio AND this many points. */
const HEADING_RATIO = 1.18;
const HEADING_ABS_PT = 1.5;
/** Line-grouping + paragraph-gap tolerances (fractions of font size). */
const LINE_Y_TOL = 0.5;
const SPACE_GAP = 0.25;
const PARAGRAPH_GAP = 1.7;
/** Relative size change that always starts a new paragraph. */
const SIZE_CHANGE = 0.15;

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Letter class that keeps its script intact across a line break
 * (no regex property escapes — the house iOS-safe rule). */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";
const SCRIPT_END_RE = new RegExp(`[${SCRIPT}]-$`);
const LOWER_START_RE = new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]");

/** Font names that read as bold (real names only — "Helvetica-Bold" etc.). */
const BOLD_NAME_RE = /(bold|black|heavy|demi|semib)/i;

/* ------------------------------------------------------------------ */
/* Text hygiene                                                        */
/* ------------------------------------------------------------------ */

/** XML-escape for text and attribute content: & < > " ' */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips C0/C1 control characters (whitespace controls normalise to a
 * plain space) — every run text passes through here before the XML.
 */
export function sanitizeRunText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 28 && code <= 32)) {
      out += " ";
    } else if (code < 32 || (code >= 127 && code <= 159)) {
      continue; // pure control noise — dropped
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Half-point XML value for w:sz (docx sizes are 1/2 pt), clamped 4-100 pt. */
function halfPoints(sizePt: number): number {
  return Math.min(200, Math.max(8, Math.round(sizePt * 2)));
}

/* ------------------------------------------------------------------ */
/* 1-2. Pieces and lines                                               */
/* ------------------------------------------------------------------ */

interface Piece {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
  bold: boolean;
}

interface LineRun {
  text: string;
  bold: boolean;
  size: number;
}

interface Line {
  runs: LineRun[];
  y: number;
  size: number;
}

/** Rounded font size (0.5 pt buckets) for stable run comparisons. */
function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/** Coerces one page of raw pdf.js items into position-tagged pieces. */
function collectPieces(
  items: readonly PdfTextItemInput[],
  boldMap: ReadonlyMap<string, boolean> | undefined
): Piece[] {
  const pieces: Piece[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const str = typeof item.str === "string" ? item.str : "";
    if (str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const w = Number(item.width) || 0;
    const fontName = typeof item.fontName === "string" ? item.fontName : "";
    const bold =
      item.bold === true ||
      (boldMap !== undefined && boldMap.get(fontName) === true) ||
      (fontName.length > 0 && BOLD_NAME_RE.test(fontName));
    // sanitizeRunText trims the ends — but pdf.js drops its own split
    // items exactly there (it also emits whitespace-ONLY items for the
    // visual spaces it splits away). The raw item's leading/trailing
    // whitespace is restored as a single space; a whitespace-only item
    // becomes exactly ONE space piece (not two glued ends — the smoke
    // proved pdf.js emits per-space items, and " " + "" + " " would
    // double every one of them).
    const text = sanitizeRunText(str);
    const glued =
      text.length > 0
        ? (/^\s/.test(str) ? " " : "") +
          text +
          (/\s$/.test(str) ? " " : "")
        : " ";
    if (glued.length === 0) continue;
    pieces.push({
      text: glued,
      x,
      y,
      w,
      size: size > 0 ? size : 10,
      bold,
    });
  }
  return pieces;
}

/** Groups pieces into visual lines with bold-aware runs. */
function buildLines(pieces: Piece[]): Line[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: Piece[][] = [];
  let current: Piece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * LINE_Y_TOL);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * LINE_Y_TOL);
    }
  }
  groups.push(current);

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const size = group[0].size;
    const runs: LineRun[] = [];
    let endX: number | null = null;
    for (const piece of ordered) {
      const last = runs[runs.length - 1];
      if (
        endX !== null &&
        piece.x - endX > size * SPACE_GAP &&
        !last?.text.endsWith(" ")
      ) {
        // pdf.js items carry no spaces — a real gap becomes one.
        if (last) last.text += " ";
        else runs.push({ text: " ", bold: piece.bold, size });
      }
      if (last && last.bold === piece.bold && last.size === roundSize(piece.size)) {
        last.text += piece.text;
      } else {
        runs.push({
          text: piece.text,
          bold: piece.bold,
          size: roundSize(piece.size),
        });
      }
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    // Merge identical-style neighbours created by the space glue above.
    const merged: LineRun[] = [];
    for (const run of runs) {
      const prev = merged[merged.length - 1];
      if (prev && prev.bold === run.bold && prev.size === run.size) {
        prev.text += run.text;
      } else {
        merged.push(run);
      }
    }
    return { runs: merged, y: group[0].y, size };
  });
}

/* ------------------------------------------------------------------ */
/* 3. Paragraphs                                                       */
/* ------------------------------------------------------------------ */

/** Char-weighted dominant size of a paragraph (rounded to 0.5 pt). */
function dominantSize(runs: readonly DocxRun[]): number {
  let weighted = 0;
  let total = 0;
  for (const run of runs) {
    weighted += run.sizePt * run.text.length;
    total += run.text.length;
  }
  if (total === 0) return 10;
  return Math.round((weighted / total) * 2) / 2;
}

/** Merges a page's lines into paragraph blocks (runs preserved). */
function linesToBlocks(lines: readonly Line[]): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  let runs: LineRun[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  const flush = (): void => {
    if (runs.length === 0) return;
    const cleaned = runs
      .map((run) => ({
        text: run.text.slice(0, MAX_RUN_CHARS),
        bold: run.bold,
        sizePt: run.size,
      }))
      .filter((run) => run.text.trim().length > 0);
    if (cleaned.length > 0) blocks.push({ kind: "para", runs: cleaned });
    runs = [];
  };

  for (const line of lines) {
    if (line.runs.length === 0) continue;
    if (runs.length === 0) {
      runs = line.runs.map((run) => ({ ...run }));
    } else if (prevY !== null && prevY - line.y > prevSize * PARAGRAPH_GAP) {
      // Clear vertical gap → paragraph break.
      flush();
      runs = line.runs.map((run) => ({ ...run }));
    } else if (
      Math.abs(line.size - prevSize) / Math.max(prevSize, 1) >
      SIZE_CHANGE
    ) {
      // Font-size change (title above body) → never merge across it.
      flush();
      runs = line.runs.map((run) => ({ ...run }));
    } else if (
      SCRIPT_END_RE.test(runs[runs.length - 1]?.text ?? "") &&
      LOWER_START_RE.test(line.runs[0]?.text ?? "")
    ) {
      // Dehyphenate: "exam-" + "ple" → "example".
      const last = runs[runs.length - 1];
      const first = line.runs[0];
      last.text = last.text.slice(0, -1);
      if (first.bold === last.bold && first.size === last.size) {
        last.text += first.text;
        runs.push(...line.runs.slice(1).map((run) => ({ ...run })));
      } else {
        runs.push(...line.runs.map((run) => ({ ...run })));
      }
    } else {
      const last = runs[runs.length - 1];
      if (last && !last.text.endsWith(" ")) last.text += " ";
      runs.push(...line.runs.map((run) => ({ ...run })));
    }
    prevY = line.y;
    prevSize = line.size;
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 4-5. extractTextBlocks                                              */
/* ------------------------------------------------------------------ */

export interface ExtractOptions {
  boldMap?: ReadonlyMap<string, boolean>;
  /** Heading detection (surface switch). Default: on. */
  headings?: boolean;
}

export function extractTextBlocks(
  pages: readonly PdfTextItemInput[][],
  opts: ExtractOptions = {}
): WordDocModel {
  const headingsOn = opts.headings !== false;

  // Pass 1 — everything as lines, plus the char-weighted body size.
  const pageLines: Line[][] = [];
  const sizeWeight = new Map<number, number>();
  for (const items of pages) {
    const lines = buildLines(collectPieces(items, opts.boldMap)).filter(
      (line) => line.runs.length > 0
    );
    pageLines.push(lines);
    for (const line of lines) {
      for (const run of line.runs) {
        const key = Math.round(run.size * 2) / 2;
        sizeWeight.set(key, (sizeWeight.get(key) ?? 0) + run.text.length);
      }
    }
  }

  let bodySize = 11;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeight) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bodySize = size;
    }
  }

  // Heading tiers: distinct sizes clearly above the body size, largest
  // first. Only the top two tiers become Heading1 / Heading2.
  const tierMin = Math.max(
    bodySize * HEADING_RATIO,
    bodySize + HEADING_ABS_PT
  );
  const tiers: number[] = [];
  for (const size of sizeWeight.keys()) {
    if (size >= tierMin && (sizeWeight.get(size) ?? 0) >= TIER_MIN_CHARS) {
      tiers.push(size);
    }
  }
  tiers.sort((a, b) => b - a);
  const headingSize = tiers.length > 0 ? new Map<number, 1 | 2>() : null;
  if (headingSize) {
    headingSize.set(tiers[0], 1);
    if (tiers.length > 1) headingSize.set(tiers[1], 2);
  }

  // Pass 2 — paragraphs + page marks.
  const blocks: DocxBlock[] = [];
  const pageMarks: number[] = [];
  for (const lines of pageLines) {
    const pageBlocks = linesToBlocks(lines);
    for (const block of pageBlocks) {
      if (headingSize && headingsOn) {
        const level = headingSize.get(dominantSize(block.runs));
        if (level !== undefined) block.headingLevel = level;
      }
      blocks.push(block);
    }
    if (pageBlocks.length > 0) pageMarks.push(blocks.length - pageBlocks.length);
  }

  // Clamp: pages whose blocks fell past the cap contribute no mark
  // (their content was cut — the summary reflects that honestly).
  const cappedBlocks = blocks.slice(0, MAX_PARAGRAPHS);
  const cappedMarks = pageMarks.filter((mark) => mark < cappedBlocks.length);

  return { blocks: cappedBlocks, pageMarks: cappedMarks };
}

/* ------------------------------------------------------------------ */
/* Docx builder (fflate OOXML — minimal valid Word package)            */
/* ------------------------------------------------------------------ */

export interface BuildDocxOptions {
  /** Emit w:br type="page" at the page marks (surface switch). */
  pageBreaks: boolean;
  /** Document title for docProps/core.xml (already plain text). */
  title?: string;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function runXml(run: DocxRun): string {
  const sz = halfPoints(run.sizePt);
  const rPr =
    `<w:rPr>${run.bold ? "<w:b/><w:bCs/>" : ""}` +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function paragraphXml(block: DocxBlock, pageBreak: boolean): string {
  const pPr =
    block.headingLevel === 1
      ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
      : block.headingLevel === 2
        ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
        : "";
  const breakRun = pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : "";
  const runs = block.runs.map(runXml).join("");
  return `<w:p>${pPr}${breakRun}${runs}</w:p>`;
}

function documentXml(doc: WordDocModel, opts: BuildDocxOptions): string {
  const marks = new Set(opts.pageBreaks ? doc.pageMarks.slice(1) : []);
  const body = doc.blocks
    .map((block, index) => paragraphXml(block, marks.has(index)))
    .join("");
  return (
    `${XML_DECL}` +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    "</w:body></w:document>"
  );
}

function contentTypesXml(): string {
  return (
    `${XML_DECL}` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ' +
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>"
  );
}

function rootRelsXml(): string {
  return (
    `${XML_DECL}` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="word/document.xml"/>' +
    '<Relationship Id="rId2" ' +
    'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
    'Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" ' +
    'Target="docProps/app.xml"/>' +
    "</Relationships>"
  );
}

function documentRelsXml(): string {
  return (
    `${XML_DECL}` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
    'Target="styles.xml"/>' +
    "</Relationships>"
  );
}

function stylesXml(): string {
  return (
    `${XML_DECL}` +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/>' +
    '<w:spacing w:before="240" w:after="120"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
    '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/>' +
    '<w:spacing w:before="200" w:after="100"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>' +
    "</w:styles>"
  );
}

function coreXml(title: string): string {
  const safe = xmlEscape(title.slice(0, 120).trim());
  return (
    `${XML_DECL}` +
    '<cp:coreProperties ' +
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${safe}</dc:title>` +
    "<dc:creator>DocoPDF</dc:creator>" +
    '<cp:lastModifiedBy>DocoPDF</cp:lastModifiedBy>' +
    "</cp:coreProperties>"
  );
}

function appXml(): string {
  return (
    `${XML_DECL}` +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    "<Application>DocoPDF</Application>" +
    "</Properties>"
  );
}

/**
 * Builds a valid minimal .docx (Uint8Array) from the document model:
 * [Content_Types].xml (with the wordprocessingml override), _rels/.rels,
 * word/document.xml, word/_rels/document.xml.rels, word/styles.xml and
 * the two docProps parts Word's strict loader expects.
 */
export function buildDocx(doc: WordDocModel, opts: BuildDocxOptions): Uint8Array {
  return zipSync(
    {
      "[Content_Types].xml": strBytes(contentTypesXml()),
      "_rels/.rels": strBytes(rootRelsXml()),
      "word/document.xml": strBytes(documentXml(doc, opts)),
      "word/_rels/document.xml.rels": strBytes(documentRelsXml()),
      "word/styles.xml": strBytes(stylesXml()),
      "docProps/core.xml": strBytes(coreXml(opts.title ?? "")),
      "docProps/app.xml": strBytes(appXml()),
    },
    { level: 6 }
  );
}

/** UTF-8 bytes (TextEncoder is available in workers and Node/bun alike). */
function strBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion                                            */
/* ------------------------------------------------------------------ */

/**
 * parseRun — the options payload the surface sends as options.run.
 * Garbage JSON (or a non-object) degrades to the defaults; only an
 * explicit false disables a switch; the locale must be exactly "hi";
 * the file word is sanitized + clamped. Paragraph/run clamps live in
 * extractTextBlocks (MAX_PARAGRAPHS / MAX_RUN_CHARS).
 */
export function parseRun(raw: string): PdfToWordRunOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    headings: o.headings !== false,
    pageBreaks: o.pageBreaks !== false,
    locale: o.locale === "hi" ? "hi" : "en",
    fileWord: sanitizeRunText(
      typeof o.fileWord === "string" ? o.fileWord.slice(0, 60) : ""
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Summary stats (surface result card)                                 */
/* ------------------------------------------------------------------ */

export function docxStats(doc: WordDocModel): PdfToWordDetail {
  let paragraphs = 0;
  let headings = 0;
  for (const block of doc.blocks) {
    paragraphs += 1;
    if (block.headingLevel !== undefined) headings += 1;
  }
  return { paragraphs, headings, pages: doc.pageMarks.length };
}
