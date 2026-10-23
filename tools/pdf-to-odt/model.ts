import { strToU8, zipSync } from "fflate";

/**
 * PDF → OpenDocument Text model (RB4-d). PURE TypeScript: no pdf.js, no
 * pdf-lib, no DOM — the smoke drives every export headless in bun, and
 * the worker feeds the model real pdf.js text items + a font-table
 * style map. This file is the mirror of tools/odt-to-pdf/model.ts: the
 * package buildOdt writes is EXACTLY the package parseOdt reads
 * (mimetype first + stored, META-INF/container.xml + manifest, content.xml
 * with office:body/office:text/text:h/text:p/text:span, styles.xml with
 * the common styles the mirror resolves through parent-style chains).
 *
 * Pipeline (all in this file):
 *  1. collectPieces — coerce + position-tag the raw pdf.js items (the
 *     pdf-to-word recipe, + italic: whitespace-only items become
 *     exactly ONE space piece, per-item splits keep their edge spaces).
 *  2. buildLines — group by y-proximity (half a font height), order by
 *     x, insert spaces at horizontal gaps, merge same-style neighbours
 *     and repair visual-order Devanagari matras (pdf-to-powerpoint's
 *     fixDevanagariVisual — pdf-lib/Noto glyph streams extract with
 *     "िप्रया" instead of "प्रिया"; ODT is plain UTF-8 XML, so the
 *     logical order is what a word processor needs).
 *  3. linesToBlocks — paragraphs: a baseline gap noticeably larger than
 *     one line height, or a font-size change, starts a new paragraph;
 *     hyphenated line endings merge back (dehyphenation).
 *  4. Headings — font-size rank: the document's body size is the
 *     char-weighted mode; sizes clearly above it form tiers; the tiers
 *     map to text:outline-level 1-6 (largest tier = level 1) — up to
 *     SIX levels, not the two the .docx writer keeps, because ODT
 *     consumers render the full heading ladder natively.
 *  5. buildOdt — a REAL minimal OpenDocument package via fflate
 *     zipSync: mimetype FIRST and STORED (level 0, the ODF rule),
 *     META-INF/container.xml (OCF-style locator at content.xml),
 *     content.xml (office:meta dc:title + meta:generator "DocoPDF",
 *     automatic styles T1/T2/T3, office:body/office:text),
 *     styles.xml (Standard / Text_20_Body / Heading_20_1-6 common
 *     styles + Bold_20_Span / Italic_20_Span / BoldItalic_20_Span —
 *     the exact names the mirror's parser resolves), META-INF/manifest.xml
 *     and meta.xml. Bold/italic runs are written as text:span with the
 *     automatic styles T1 (bold) / T2 (italic) / T3 (both), each
 *     chaining to its common style via style:parent-style-name — the
 *     same pattern the mirror's own sample builder uses.
 *
 * HONEST limits (mirrored in config.ts + the surface): text + structure
 * only. The ODT reflows — it opens and edits cleanly in LibreOffice,
 * Word and Google Docs, but it is NOT pixel-identical to the PDF.
 * Images, columns and tables come out as a plain text flow; scanned
 * pages need the OCR tool first (the worker fails tool.errorNoText).
 * Devanagari needs no font embedding — an honest ODT advantage: the
 * package is UTF-8 XML, the reader picks its own fonts.
 */

/* ------------------------------------------------------------------ */
/* Hard caps                                                            */
/* ------------------------------------------------------------------ */

/** Whole-document block cap (paragraphs + headings). */
export const MAX_PARAGRAPHS = 2000;
/** One run is clamped to this many characters. */
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
/** text:h outline levels are 1-6 (ODF bound, not the docx writer's 2). */
export const MAX_HEADING_LEVEL = 6;
/** Emitted style sizes live inside the mirror parser's 4-72 pt window. */
const MIN_STYLE_PT = 6;
const MAX_STYLE_PT = 72;

export const ODT_MIME = "application/vnd.oasis.opendocument.text";

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
  /** Worker enrichment: bold resolved from the PDF's font table. */
  bold?: unknown;
  /** Worker enrichment: italic resolved from the PDF's font table. */
  italic?: unknown;
}

/** Bold/italic the worker's font-table pass resolved for one pdf.js id. */
export interface FontStyleInfo {
  bold: boolean;
  italic: boolean;
}

/** One styled run inside a block. */
export interface OdtRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** source font size in pt (0.5 buckets) — body/headings style hint. */
  sizePt: number;
}

/** One paragraph block; headingLevel is set for detected heading tiers. */
export interface OdtBlock {
  kind: "para";
  runs: OdtRun[];
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}

/** The document model the ODT builder consumes. */
export interface OdtDocModel {
  blocks: OdtBlock[];
  /** Block index each source page starts at (length == page count —
   *  empty pages keep their mark so per-page splitting stays aligned). */
  pageMarks: number[];
  /** Detected body font size (pt) — drives the Text Body style. */
  bodyPt: number;
  /** outline level (1-6) → detected heading size (pt). */
  headingPt: ReadonlyMap<number, number>;
}

/** Style context for buildOdt (derived once per document). */
export interface OdtStyleInfo {
  bodyPt: number;
  headingPt: ReadonlyMap<number, number>;
}

/** Worker-boundary options, coerced by coerceRunOptions. */
export interface PdfToOdtRunOptions {
  /** page-range spec ("all" | "1-3, 5") — parsed against numPages. */
  pages: string;
  /** one .odt per page instead of a single .odt. */
  perPage: boolean;
  locale: "en" | "hi";
  /** Localized fallback word for the output name. */
  fileWord: string;
}

/* ------------------------------------------------------------------ */
/* Text hygiene                                                        */
/* ------------------------------------------------------------------ */

/** XML-escape for text and attribute content: & < > " ' */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
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

/** Font names that read as bold (real names only — "Helvetica-Bold"). */
const BOLD_NAME_RE = /(bold|black|heavy|demi|semib)/i;
/** Font names that read as italic ("Helvetica-Oblique", "Times-Italic"). */
const ITALIC_NAME_RE = /(italic|oblique)/i;

/* ------------------------------------------------------------------ */
/* Devanagari visual→logical repair (pdf-to-powerpoint copy)           */
/* ------------------------------------------------------------------ */

/* pdf.js concatenates per-glyph ToUnicode in stream order, and shaping
 * puts the three PRE-base matras (ि े ै) BEFORE their base cluster —
 * so text drawn from shaped glyph streams (pdf-lib/Noto, many cheap
 * generators) extracts with "िप्रया" instead of "प्रिया". The inverse
 * move is only applied where it is PROVABLY visual: the matra starts
 * the run, or follows anything that can never end a logical syllable
 * (space, vowel, another sign, virama, Latin…). After a plain
 * CONSONANT the reading is ambiguous and is left untouched — OCR-style
 * logical text is never damaged. */

const DEV_PRE_MATRA = new Set(["\u093F", "\u0947", "\u0948"]); // ि े ै
const DEV_VIRAMA = "\u094D";
const DEV_NUKTA = "\u093C";

function isDevConsonant(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095f) ||
    c === 0x0979 || c === 0x097a
  );
}

/** Greedy match of a base/conjunct cluster: C (nukta?) (virama C (nukta?))*. */
function matchDevCluster(text: string, i: number): string | null {
  let j = i;
  if (!isDevConsonant(text[j])) return null;
  j += 1;
  if (text[j] === DEV_NUKTA) j += 1;
  for (;;) {
    if (text[j] !== DEV_VIRAMA || !isDevConsonant(text[j + 1])) break;
    j += 2;
    if (text[j] === DEV_NUKTA) j += 1;
  }
  return text.slice(i, j);
}

/** Move provably-visual pre-base matras and dangling rephs to logical order. */
export function fixDevanagariVisual(text: string): string {
  let needsMatra = false;
  let needsReph = false;
  for (let i = 0; i < text.length; i += 1) {
    if (DEV_PRE_MATRA.has(text[i] as string)) needsMatra = true;
    if (text[i] === DEV_RA && text[i + 1] === DEV_VIRAMA) needsReph = true;
  }
  if (!needsMatra && !needsReph) return text;

  let out = text;

  if (needsMatra) {
    // Pre-base matras: shaping renders ि े ै BEFORE their cluster, so
    // they extract one position early. Only provably-visual cases move
    // (the matra starts the run or follows something that can never
    // end a logical syllable); after a plain consonant the reading is
    // ambiguous and is left untouched.
    let acc = "";
    let prev = "";
    let i = 0;
    while (i < out.length) {
      const ch = out[i] as string;
      if (DEV_PRE_MATRA.has(ch)) {
        const cluster = matchDevCluster(out, i + 1);
        const ambiguous =
          isDevConsonant(prev) || prev === DEV_NUKTA; // logical reading exists
        if (cluster !== null && !ambiguous) {
          acc += cluster + ch;
          prev = cluster[cluster.length - 1] as string;
          i += 1 + cluster.length;
          continue;
        }
      }
      acc += ch;
      prev = ch;
      i += 1;
    }
    out = acc;
  }

  if (needsReph) out = fixDevReph(out);
  return out;
}

/** Post-syllable signs a visual reph may trail behind. */
const DEV_POST_MARK = new Set([
  "\u093E", "\u093F", "\u0940", "\u0941", "\u0942", "\u0943", "\u0944",
  "\u0945", "\u0946", "\u0947", "\u0948", "\u0949", "\u094A", "\u094B",
  "\u094C", "\u0901", "\u0902", "\u0903", "\u093C", "\u0962", "\u0963",
]);
const DEV_RA = "\u0930";

/**
 * Move a provably-visual reph back in front of its cluster. Shaping
 * puts the syllable-final र ् AFTER the base consonant and its matras
 * ("रिपोटर्" for रिपोर्ट) — a dead consonant that dangles before a
 * non-consonant (end, space, punctuation, Latin, digits, signs) can
 * never be logical, so those cases are provably visual. A र ् directly
 * followed by a consonant is the valid logical ligature form and is
 * never touched, so OCR-style logical text is never damaged.
 */
function fixDevReph(text: string): string {
  let out = text;
  for (let i = 0; i + 1 < out.length; i += 1) {
    if (out[i] !== DEV_RA || out[i + 1] !== DEV_VIRAMA) continue;
    const after = i + 2 < out.length ? (out[i + 2] as string) : undefined;
    if (after !== undefined && (isDevConsonant(after) || after === DEV_VIRAMA)) {
      continue;
    }
    // Provably visual: walk back over post-syllable signs, expect one
    // base consonant, and splice the reph in front of it.
    let j = i - 1;
    while (j >= 0 && DEV_POST_MARK.has(out[j] as string)) j -= 1;
    if (j < 0 || !isDevConsonant(out[j])) continue; // nothing to attach to
    out =
      out.slice(0, j) +
      DEV_RA +
      DEV_VIRAMA +
      out.slice(j, i) +
      out.slice(i + 2);
    i = j + 1; // the moved pair now precedes a consonant — never re-fires
  }
  return out;
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
  italic: boolean;
}

interface LineRun {
  text: string;
  bold: boolean;
  italic: boolean;
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
  styleMap: ReadonlyMap<string, FontStyleInfo> | undefined
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
    const known = styleMap?.get(fontName);
    const bold =
      item.bold === true ||
      known?.bold === true ||
      (fontName.length > 0 && BOLD_NAME_RE.test(fontName));
    const italic =
      item.italic === true ||
      known?.italic === true ||
      (fontName.length > 0 && ITALIC_NAME_RE.test(fontName));
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
      italic,
    });
  }
  return pieces;
}

/** Groups pieces into visual lines with bold/italic-aware runs. */
function buildLines(pieces: Piece[]): Line[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: Piece[][] = [];
  let current: Piece[] = [sorted[0] as Piece];
  let groupY = (sorted[0] as Piece).y;
  let groupTol = Math.max(1.5, (sorted[0] as Piece).size * LINE_Y_TOL);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i] as Piece;
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
    const size = (group[0] as Piece).size;
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
        else
          runs.push({
            text: " ",
            bold: piece.bold,
            italic: piece.italic,
            size,
          });
      }
      if (
        last &&
        last.bold === piece.bold &&
        last.italic === piece.italic &&
        last.size === roundSize(piece.size)
      ) {
        last.text += piece.text;
      } else {
        runs.push({
          text: piece.text,
          bold: piece.bold,
          italic: piece.italic,
          size: roundSize(piece.size),
        });
      }
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    // Merge identical-style neighbours created by the space glue, then
    // repair visual-ordered Devanagari matras per merged run (the fix
    // needs contiguous text — cluster + matra may straddle pieces).
    const merged: LineRun[] = [];
    for (const run of runs) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.bold === run.bold &&
        prev.italic === run.italic &&
        prev.size === run.size
      ) {
        prev.text += run.text;
      } else {
        merged.push({ ...run, text: fixDevanagariVisual(run.text) });
      }
    }
    return { runs: merged, y: (group[0] as Piece).y, size };
  });
}

/* ------------------------------------------------------------------ */
/* 3. Paragraphs                                                       */
/* ------------------------------------------------------------------ */

/** Letter class that keeps its script intact across a line break
 * (no regex property escapes — the house iOS-safe rule). */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";
const SCRIPT_END_RE = new RegExp(`[${SCRIPT}]-$`);
const LOWER_START_RE = new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]");

/** Char-weighted dominant size of a paragraph (rounded to 0.5 pt). */
function dominantSize(runs: readonly OdtRun[]): number {
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
function linesToBlocks(lines: readonly Line[]): OdtBlock[] {
  const blocks: OdtBlock[] = [];
  let runs: LineRun[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  const flush = (): void => {
    if (runs.length === 0) return;
    const cleaned = runs
      .map((run) => ({
        text: run.text.slice(0, MAX_RUN_CHARS),
        bold: run.bold,
        italic: run.italic,
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
      const last = runs[runs.length - 1] as LineRun;
      const first = line.runs[0] as LineRun;
      last.text = last.text.slice(0, -1);
      if (
        first.bold === last.bold &&
        first.italic === last.italic &&
        first.size === last.size
      ) {
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
/* 4. extractOdtBlocks                                                 */
/* ------------------------------------------------------------------ */

export interface ExtractOptions {
  /** pdf.js id → bold/italic (the worker's font-table enrichment). */
  styleMap?: ReadonlyMap<string, FontStyleInfo>;
}

/**
 * Converts raw pdf.js text items (one array per page) into the ODT
 * document model: paragraphs with bold/italic runs, headings ranked by
 * font-size tier (outline levels 1-6), and a page mark per page so the
 * worker can split "one file per page".
 */
export function extractOdtBlocks(
  pages: readonly PdfTextItemInput[][],
  opts: ExtractOptions = {}
): OdtDocModel {
  // Pass 1 — everything as lines, plus the char-weighted body size.
  const pageLines: Line[][] = [];
  const sizeWeight = new Map<number, number>();
  for (const items of pages) {
    const lines = buildLines(collectPieces(items, opts.styleMap)).filter(
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

  let bodyPt = 11;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeight) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bodyPt = size;
    }
  }

  // Heading tiers: distinct sizes clearly above the body size, largest
  // first. The tiers map to outline levels 1-6 (rank order).
  const tierMin = Math.max(bodyPt * HEADING_RATIO, bodyPt + HEADING_ABS_PT);
  const tiers: number[] = [];
  for (const size of sizeWeight.keys()) {
    if (size >= tierMin && (sizeWeight.get(size) ?? 0) >= TIER_MIN_CHARS) {
      tiers.push(size);
    }
  }
  tiers.sort((a, b) => b - a);
  const headingSize = new Map<number, 1 | 2 | 3 | 4 | 5 | 6>();
  const headingPt = new Map<number, number>();
  for (let i = 0; i < tiers.length && i < MAX_HEADING_LEVEL; i += 1) {
    const size = tiers[i] as number;
    headingSize.set(size, (i + 1) as 1 | 2 | 3 | 4 | 5 | 6);
    headingPt.set(i + 1, size);
  }

  // Pass 2 — paragraphs + a page mark for EVERY page (empty pages keep
  // theirs, so per-page splitting stays aligned with the page numbers).
  const blocks: OdtBlock[] = [];
  const pageMarks: number[] = [];
  for (const lines of pageLines) {
    pageMarks.push(blocks.length);
    const pageBlocks = linesToBlocks(lines);
    for (const block of pageBlocks) {
      const level = headingSize.get(dominantSize(block.runs));
      if (level !== undefined) block.headingLevel = level;
      blocks.push(block);
    }
  }

  // Clamp: pages whose blocks fell past the cap keep their (now empty)
  // page mark — per-page splits degrade to an honest empty paragraph.
  const capped = blocks.slice(0, MAX_PARAGRAPHS);

  return { blocks: capped, pageMarks, bodyPt, headingPt };
}

/* ------------------------------------------------------------------ */
/* ODT package writer (fflate — minimal valid OpenDocument)           */
/* ------------------------------------------------------------------ */

const OD_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Style size inside the mirror parser's readable 4-72 pt window. */
function clampStylePt(pt: number): number {
  const v = Number.isFinite(pt) ? pt : 12;
  return Math.min(MAX_STYLE_PT, Math.max(MIN_STYLE_PT, Math.round(v * 2) / 2));
}

/**
 * styles.xml — the common styles the mirror's parser resolves:
 * Standard (default paragraph), Text_20_Body (detected body size),
 * Heading_20_1..6 for the levels actually detected, and the three
 * character styles the automatic T1/T2/T3 chain through.
 */
function stylesXml(style: OdtStyleInfo): string {
  const body = clampStylePt(style.bodyPt);
  const headings = [...style.headingPt.entries()]
    .filter(([level]) => level >= 1 && level <= MAX_HEADING_LEVEL)
    .sort((a, b) => a[0] - b[0])
    .map(
      ([level, pt]) =>
        `<style:style style:name="Heading_20_${level}" ` +
        'style:family="paragraph" style:parent-style-name="Standard" ' +
        'style:next-style-name="Text_20_Body" style:class="text">' +
        `<style:text-properties fo:font-weight="bold" ` +
        `fo:font-size="${clampStylePt(pt)}pt"/></style:style>`
    )
    .join("");
  return (
    `${XML_DECL}` +
    `<office:document-styles ${OD_NS} office:version="1.3">` +
    "<office:styles>" +
    '<style:style style:name="Standard" style:family="paragraph" ' +
    'style:class="extra"/>' +
    '<style:style style:name="Text_20_Body" style:family="paragraph" ' +
    'style:parent-style-name="Standard" style:class="text">' +
    `<style:text-properties fo:font-size="${body}pt"/></style:style>` +
    headings +
    '<style:style style:name="Bold_20_Span" style:family="text">' +
    '<style:text-properties fo:font-weight="bold"/></style:style>' +
    '<style:style style:name="Italic_20_Span" style:family="text">' +
    '<style:text-properties fo:font-style="italic"/></style:style>' +
    '<style:style style:name="BoldItalic_20_Span" style:family="text">' +
    '<style:text-properties fo:font-weight="bold" ' +
    'fo:font-style="italic"/></style:style>' +
    "</office:styles>" +
    "</office:document-styles>"
  );
}

/**
 * meta.xml — the standard OpenDocument metadata part (dc:title from the
 * PDF's own info dictionary, meta:generator DocoPDF).
 */
function metaXml(title: string): string {
  return (
    `${XML_DECL}` +
    `<office:document-meta ${OD_NS} ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
    'office:version="1.3">' +
    "<office:meta>" +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    "<meta:generator>DocoPDF</meta:generator>" +
    "</office:meta>" +
    "</office:document-meta>"
  );
}

/** META-INF/manifest.xml — every part declared (the ODF locator). */
function manifestXml(): string {
  return (
    `${XML_DECL}` +
    '<manifest:manifest ' +
    'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ' +
    'manifest:version="1.3">' +
    '<manifest:file-entry manifest:full-path="/" ' +
    `manifest:version="1.3" manifest:media-type="${ODT_MIME}"/>` +
    '<manifest:file-entry manifest:full-path="META-INF/container.xml" ' +
    'manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" ' +
    'manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" ' +
    'manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" ' +
    'manifest:media-type="text/xml"/>' +
    "</manifest:manifest>"
  );
}

/**
 * META-INF/container.xml — an OASIS OCF-style locator pointing at
 * content.xml (the house package convention; ODF readers locate parts
 * through the mimetype + manifest, so this is a belt-and-braces part
 * that costs 15 lines and never conflicts).
 */
function containerXml(): string {
  return (
    `${XML_DECL}` +
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container:1.0">' +
    "<rootfiles>" +
    `<rootfile full-path="content.xml" media-type="${ODT_MIME}"/>` +
    "</rootfiles>" +
    "</container>"
  );
}

/**
 * One run → escaped text, wrapped in a T1/T2/T3 span when styled.
 * Boundary whitespace never enters a span: ODF collapses spaces at
 * span edges, so the spaces stay in the unstyled flow around it
 * ("<span>bold words,</span> " keeps the trailing space outside).
 */
function runXml(run: OdtRun): string {
  const leading = run.text.match(/^[ \t]*/)?.[0] ?? "";
  const trailing = run.text.match(/[ \t]*$/)?.[0] ?? "";
  const core = run.text.slice(
    leading.length,
    run.text.length - trailing.length
  );
  const style =
    run.bold && run.italic ? "T3" : run.bold ? "T1" : run.italic ? "T2" : "";
  if (style === "" || core === "") {
    return xmlEscape(run.text);
  }
  return (
    xmlEscape(leading) +
    `<text:span text:style-name="${style}">${xmlEscape(core)}</text:span>` +
    xmlEscape(trailing)
  );
}

function blockXml(block: OdtBlock): string {
  if (block.headingLevel !== undefined) {
    // Headings carry their weight through the Heading_20_N style in
    // styles.xml — runs inside are emitted PLAIN (a T1 span inside a
    // heading is redundant markup that renders double-bold).
    const plain = xmlEscape(block.runs.map((r) => r.text).join(""));
    return (
      `<text:h text:style-name="Heading_20_${block.headingLevel}" ` +
      `text:outline-level="${block.headingLevel}">${plain}</text:h>`
    );
  }
  const inner = block.runs.map(runXml).join("");
  return `<text:p text:style-name="Text_20_Body">${inner}</text:p>`;
}

/**
 * content.xml — office:meta (dc:title + meta:generator), the
 * automatic character styles T1/T2/T3 (each chaining to its common
 * style through style:parent-style-name — exactly the pattern the
 * odt-to-pdf parser resolves), and office:body/office:text.
 */
function contentXml(blocks: readonly OdtBlock[], title: string): string {
  // An empty page still gets one honest empty paragraph — the mirror
  // parser rejects a text body with zero blocks (errEmpty), and a
  // word processor needs at least one paragraph to click into.
  const body =
    blocks.length > 0
      ? blocks.map(blockXml).join("")
      : '<text:p text:style-name="Text_20_Body"/>';
  return (
    `${XML_DECL}` +
    `<office:document-content ${OD_NS} ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
    'office:version="1.3">' +
    "<office:meta>" +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    "<meta:generator>DocoPDF</meta:generator>" +
    "</office:meta>" +
    "<office:automatic-styles>" +
    '<style:style style:name="T1" style:family="text" ' +
    'style:parent-style-name="Bold_20_Span"/>' +
    '<style:style style:name="T2" style:family="text" ' +
    'style:parent-style-name="Italic_20_Span"/>' +
    '<style:style style:name="T3" style:family="text" ' +
    'style:parent-style-name="BoldItalic_20_Span"/>' +
    "</office:automatic-styles>" +
    "<office:body><office:text>" +
    body +
    "</office:text></office:body>" +
    "</office:document-content>"
  );
}

export interface BuildOdtOptions extends OdtStyleInfo {
  /** Document title (PDF info Title, or the first heading fallback). */
  title: string;
}

/**
 * Builds a valid minimal .odt (Uint8Array) with fflate zipSync. The
 * ODF packaging rules honoured exactly: mimetype is the FIRST entry
 * and STORED (level 0); container/manifest/content/styles/meta follow
 * compressed (level 6). UTF-8 throughout — Devanagari needs no font
 * embedding (readers pick their own), which keeps the file tiny.
 */
export function buildOdt(
  blocks: readonly OdtBlock[],
  opts: BuildOdtOptions
): Uint8Array {
  return zipSync(
    {
      mimetype: [strToU8(ODT_MIME), { level: 0 }],
      "META-INF/container.xml": strToU8(containerXml()),
      "META-INF/manifest.xml": strToU8(manifestXml()),
      "content.xml": strToU8(contentXml(blocks, opts.title)),
      "styles.xml": strToU8(
        stylesXml({ bodyPt: opts.bodyPt, headingPt: opts.headingPt })
      ),
      "meta.xml": strToU8(metaXml(opts.title)),
    },
    { level: 6 }
  );
}

/** The blocks of source page `index` (0-based; [] for empty pages). */
export function pageBlocksOf(model: OdtDocModel, index: number): OdtBlock[] {
  if (index < 0 || index >= model.pageMarks.length) return [];
  const start = model.pageMarks[index] as number;
  const end =
    index + 1 < model.pageMarks.length
      ? (model.pageMarks[index + 1] as number)
      : model.blocks.length;
  return model.blocks.slice(start, Math.max(start, end));
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion                                            */
/* ------------------------------------------------------------------ */

/**
 * coerceRunOptions — the options record the surface/shell sends.
 * Garbage values degrade to the defaults; unknown enum values fall
 * back honestly; the page spec is sanitized to a string; the file word
 * is control-char-stripped + clamped.
 */
export function coerceRunOptions(
  raw: Record<string, unknown>
): PdfToOdtRunOptions {
  const str = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    pages: str(raw.pages, 200) || "all",
    perPage: raw.perPage === true,
    locale: raw.locale === "hi" ? "hi" : "en",
    fileWord: str(raw.fileWord, 40),
  };
}

/* ------------------------------------------------------------------ */
/* Error mapping + output naming                                        */
/* ------------------------------------------------------------------ */

/**
 * pdf.js failure message → honest i18n error code. Encrypted PDFs ask
 * for a password (PasswordException); everything unreadable is corrupt.
 */
export function pdfErrorMessageToCode(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}

/**
 * "My Report.pdf" → "My Report" (path-unsafe chars become "_",
 * Devanagari survives); a nameless file falls back to the localized
 * word. The caller appends ".odt" (and "-pageN" in per-page mode).
 */
export function outputBaseName(
  fileName: string,
  lang: string,
  fileWord: string
): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120);
  if (base !== "") return base;
  if (fileWord !== "") return fileWord;
  return lang === "hi" ? "दस्तावेज़" : "document";
}

/**
 * Document title for dc:title: the PDF's own info dictionary wins;
 * a blank/missing Title falls back to the first heading's text.
 */
export function docTitleFrom(info: unknown, fallback: string): string {
  const title = (info as { Title?: unknown } | null | undefined)?.Title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim().slice(0, 120);
  }
  return fallback.trim().slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Summary stats (surface result card)                                  */
/* ------------------------------------------------------------------ */

export interface OdtStats {
  paragraphs: number;
  headings: number;
}

/** Blocks → the paragraphs/headings counts the result card shows. */
export function odtStats(blocks: readonly OdtBlock[]): OdtStats {
  let headings = 0;
  for (const block of blocks) {
    if (block.headingLevel !== undefined) headings += 1;
  }
  return { paragraphs: blocks.length, headings };
}
