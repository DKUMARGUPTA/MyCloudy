import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF → Markdown model (RB4-c) — 100% pure TypeScript: no DOM, no pdf.js,
 * no pdf-lib. The extraction takes PLAIN text-item arrays (the shape pdf.js
 * getTextContent emits) plus optional link-annotation rects, so the smoke
 * can drive it headless, and the emitter produces clean Markdown that the
 * house's own markdown-to-pdf parser understands (the mirror rule: write
 * what it reads — headings #..######, **bold**, *italic*, - bullets,
 * 1. ordered items, > quotes, [text](url) links, --- thematic breaks).
 *
 * Pipeline (adapted from pdf-to-word, the extraction layer of record):
 *  1. collectPieces — coerce + position-tag the raw pdf.js items; bold /
 *     italic resolved from the item, the worker's font-table enrichment
 *     (pdf.js 4.x reports internal ids like "g_d0_f3") or the font name;
 *     pieces covered by a link-annotation rect carry that URL.
 *  2. buildLines — group by y-proximity (half a font height), order by x,
 *     insert spaces at horizontal gaps (pdf.js emits one item per Tj
 *     operator without carrying spaces — the pinned pdf-to-word lesson:
 *     a whitespace-only item is EXACTLY ONE space, never two glued).
 *  3. Lines → blocks — a line starting with a bullet glyph (•, -, …) or
 *     a "1." / "2)" number becomes a LIST ITEM (never merged with the
 *     previous block); tight non-marker lines continue an item or soft-
 *     wrap-join a paragraph (a baseline gap noticeably larger than one
 *     line height, or a font-size change, starts a new block; hyphenated
 *     line endings merge back before a lowercase letter).
 *  4. Headings — font-size clusters: the document's body size is the
 *     char-weighted mode; sizes clearly above it form tiers, largest
 *     first; tier i becomes heading level i+1, capped at ######. Heading
 *     text is emitted PLAIN (no bold or italic markers inside —
 *     anchor-friendly).
 *  5. Block quotes — only when visually distinct: the block starts
 *     ≥ QUOTE_INDENT_PT right of the document's modal left edge AND is
 *     italic-dominant. Honest: no indent/italics → plain paragraph.
 *  6. Emission — blocks joined with \n\n; consecutive same-kind list
 *     items share a single \n; optional "---" between PDF pages; optional
 *     "<!-- converted by DocoPDF -->" comment; optional YAML front
 *     matter. Literal line-start markdown (* # _ [ + > - and ordered
 *     markers) is backslash-escaped; HTML entities are NEVER used (raw
 *     UTF-8 — Hindi passes through, with the visual→logical Devanagari
 *     matra repair from pdf-to-powerpoint).
 *
 * HONEST limits (mirrored in the FAQ copy): text + structure only.
 * Tables are NOT converted (point at pdf-to-excel), images are skipped,
 * two-column pages come out as a line-by-line text flow (rows of both
 * columns may join), scanned pages need the OCR tool first (the worker
 * fails with tool.errorNoText).
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
  /** Worker enrichment: italic flag resolved from the PDF's font table. */
  italic?: unknown;
}

/** A link annotation rect on one page (PDF user space, y bottom-up). */
export interface MdLinkRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  url: string;
}

/** The style enrichment the worker resolves per pdf.js internal font id. */
export interface MdFontStyle {
  bold: boolean;
  italic: boolean;
}

/** One styled run inside a paragraph/list item. */
export interface MdRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Set when a link-annotation rect covers this run's text. */
  link?: string;
}

/** One output block. */
export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "para"; runs: MdRun[] }
  | { kind: "quote"; runs: MdRun[] }
  | { kind: "bullet"; runs: MdRun[] }
  | { kind: "ordered"; number: number; runs: MdRun[] };

/** The document model the Markdown builder consumes. */
export interface MdDocModel {
  blocks: MdBlock[];
  /** Block index each PDF page starts at (length == page count; an
   * empty page repeats the next page's mark). */
  pageMarks: number[];
}

/** Run summary the surface shows (reuses the shared protocol detail). */
export interface PdfToMarkdownDetail extends RunDetail {
  paragraphs?: number;
  headings?: number;
}

/** Extraction options (worker boundary + headless tests). */
export interface ExtractOptions {
  styleMap?: ReadonlyMap<string, MdFontStyle>;
  /** Link rects per page, aligned with the pages array. */
  links?: readonly MdLinkRect[][];
  /** Heading detection (switch off = everything stays a paragraph). */
  headings?: boolean;
}

/** Clamps — docstring promises, enforced in code. */
export const MAX_BLOCKS = 3000;
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
/** Relative size change that always starts a new block. */
const SIZE_CHANGE = 0.15;
/** A quote must start this far right of the body's left edge. */
const QUOTE_INDENT_PT = 18;
/** Share of italic chars for a block to read as a quote (with the indent). */
const QUOTE_ITALIC_SHARE = 0.6;
/** Link-rect hit slack (pt) around a piece's centre. */
const LINK_SLACK = 1.5;

export const MD_MIME = "text/markdown";
/** The optional provenance comment (exact task copy). */
export const MD_META_COMMENT = "<!-- converted by DocoPDF -->";

/** Letter class that keeps its script intact across a line break
 * (no regex property escapes — the house iOS-safe rule). */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";
const SCRIPT_END_RE = new RegExp(`[${SCRIPT}]-$`);
const LOWER_START_RE = new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]");

/** Font names that read as bold (real names only — "Helvetica-Bold"). */
const BOLD_NAME_RE = /(bold|black|heavy|demi|semib)/i;
/** Font names that read as italic ("Helvetica-Oblique", "Times-Italic"). */
const ITALIC_NAME_RE = /(italic|oblique|kursiv)/i;

/** Bullet glyphs a PDF line may start with (marker + whitespace). */
const BULLET_FIRST_RE = /^[•▪◦●‣·○∙▸]\s+/;
/** ASCII hyphen / en dash as a bullet (em-dash excluded: dialogue). */
const BULLET_DASH_RE = /^[-–]\s+/;
/** "1." / "2)" ordered markers (1-9 digits — CommonMark's own limit). */
const ORDERED_RE = /^(\d{1,9})[.)]\s+/;

/* ------------------------------------------------------------------ */
/* Text hygiene                                                        */
/* ------------------------------------------------------------------ */

/**
 * Strips C0/C1 control characters (whitespace controls normalise to a
 * plain space) — every run text passes through here before the model.
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
  link?: string;
}

interface LineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  link?: string;
}

interface LineMarker {
  kind: "bullet" | "ordered";
  number?: number;
  /** The literal marker text consumed from the line's head (restored
   * into heading-tier blocks — "1. Introduction" must not lose its "1. "). */
  raw?: string;
}

interface Line {
  runs: LineRun[];
  y: number;
  size: number;
  /** Left edge of the line's first piece (quote detection). */
  x0: number;
  /** Char share of italic runs (quote detection). */
  italicShare: number;
  marker: LineMarker | null;
}

/** Rounded font size (0.5 pt buckets) for stable run comparisons. */
function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/** The link whose rect covers a piece's centre (1.5 pt slack). */
function linkForPiece(
  x: number,
  y: number,
  w: number,
  size: number,
  links: readonly MdLinkRect[] | undefined
): string | undefined {
  if (links === undefined || links.length === 0) return undefined;
  const cx = x + w / 2;
  const cy = y + size * 0.45;
  for (const link of links) {
    if (
      cx >= link.x1 - LINK_SLACK &&
      cx <= link.x2 + LINK_SLACK &&
      cy >= link.y1 - LINK_SLACK &&
      cy <= link.y2 + LINK_SLACK
    ) {
      return link.url;
    }
  }
  return undefined;
}

/** Coerces one page of raw pdf.js items into position-tagged pieces. */
function collectPieces(
  items: readonly PdfTextItemInput[],
  styleMap: ReadonlyMap<string, MdFontStyle> | undefined,
  links: readonly MdLinkRect[] | undefined
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
    const enriched = fontName.length > 0 ? styleMap?.get(fontName) : undefined;
    const bold =
      item.bold === true ||
      enriched?.bold === true ||
      (fontName.length > 0 && BOLD_NAME_RE.test(fontName));
    const italic =
      item.italic === true ||
      enriched?.italic === true ||
      (fontName.length > 0 && ITALIC_NAME_RE.test(fontName));
    // sanitizeRunText trims the ends — but pdf.js drops its own split
    // items exactly there (it also emits whitespace-ONLY items for the
    // visual spaces it splits away). The raw item's leading/trailing
    // whitespace is restored as a single space; a whitespace-only item
    // becomes exactly ONE space piece (the pinned pdf-to-word lesson:
    // " " + "" + " " would double every visual space).
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
      link: linkForPiece(x, y, w, size > 0 ? size : 10, links),
    });
  }
  return pieces;
}

/** Detects and strips a leading list marker from a line's runs. */
function stripListMarker(runs: LineRun[]): LineMarker | null {
  const joined = runs.map((run) => run.text).join("");
  let length = 0;
  let marker: LineMarker | null = null;
  const ordered = ORDERED_RE.exec(joined);
  if (ordered !== null) {
    marker = {
      kind: "ordered",
      number: Number.parseInt(ordered[1], 10),
      raw: ordered[0],
    };
    length = ordered[0].length;
  } else {
    const bullet = BULLET_FIRST_RE.exec(joined) ?? BULLET_DASH_RE.exec(joined);
    if (bullet !== null) {
      marker = { kind: "bullet", raw: bullet[0] };
      length = bullet[0].length;
    }
  }
  if (marker === null) return null;
  // Remove the marker's chars from the head of the runs.
  let remaining = length;
  for (const run of runs) {
    if (remaining <= 0) break;
    if (run.text.length <= remaining) {
      remaining -= run.text.length;
      run.text = "";
    } else {
      run.text = run.text.slice(remaining);
      remaining = 0;
    }
  }
  return marker;
}

/** Groups pieces into visual lines with style- and link-aware runs. */
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
    const size = group[0]?.size ?? 10;
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
        else {
          runs.push({
            text: " ",
            bold: piece.bold,
            italic: piece.italic,
            size: roundSize(piece.size),
            link: piece.link,
          });
        }
      }
      const sameStyle =
        last !== undefined &&
        last.bold === piece.bold &&
        last.italic === piece.italic &&
        last.size === roundSize(piece.size) &&
        last.link === piece.link;
      if (sameStyle) {
        last.text += piece.text;
      } else {
        runs.push({
          text: piece.text,
          bold: piece.bold,
          italic: piece.italic,
          size: roundSize(piece.size),
          link: piece.link,
        });
      }
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    // Merge identical-style neighbours created by the space glue above.
    const merged: LineRun[] = [];
    for (const run of runs) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.bold === run.bold &&
        prev.italic === run.italic &&
        prev.size === run.size &&
        prev.link === run.link
      ) {
        prev.text += run.text;
      } else {
        merged.push({ ...run });
      }
    }
    const totalChars = merged.reduce(
      (sum, run) => sum + run.text.replace(/\s/g, "").length,
      0
    );
    const italicChars = merged.reduce(
      (sum, run) =>
        run.italic ? sum + run.text.replace(/\s/g, "").length : sum,
      0
    );
    const marker = stripListMarker(merged);
    return {
      runs: merged.filter((run) => run.text.length > 0),
      y: group[0]?.y ?? 0,
      size,
      x0: ordered[0]?.x ?? 0,
      italicShare: totalChars > 0 ? italicChars / totalChars : 0,
      marker,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 3. Lines → blocks                                                   */
/* ------------------------------------------------------------------ */

/** Char-weighted dominant size of a run list (rounded to 0.5 pt). */
function dominantSize(runs: readonly LineRun[]): number {
  let weighted = 0;
  let total = 0;
  for (const run of runs) {
    weighted += run.size * run.text.length;
    total += run.text.length;
  }
  if (total === 0) return 10;
  return Math.round((weighted / total) * 2) / 2;
}

/** Appends one line's runs to a growing block (dehyphenation aware). */
function appendLine(target: LineRun[], line: Line): void {
  if (target.length === 0) {
    target.push(...line.runs.map((run) => ({ ...run })));
    return;
  }
  if (
    SCRIPT_END_RE.test(target[target.length - 1]?.text ?? "") &&
    LOWER_START_RE.test(line.runs[0]?.text ?? "")
  ) {
    // Dehyphenate: "exam-" + "ple" → "example".
    const last = target[target.length - 1] as LineRun;
    const first = line.runs[0] as LineRun;
    last.text = last.text.slice(0, -1);
    if (
      first.bold === last.bold &&
      first.italic === last.italic &&
      first.size === last.size &&
      first.link === last.link
    ) {
      last.text += first.text;
      target.push(...line.runs.slice(1).map((run) => ({ ...run })));
    } else {
      target.push(...line.runs.map((run) => ({ ...run })));
    }
    return;
  }
  const last = target[target.length - 1];
  if (last && !last.text.endsWith(" ")) last.text += " ";
  target.push(...line.runs.map((run) => ({ ...run })));
}

interface RawBlock {
  runs: LineRun[];
  x0: number;
  italicShare: number;
  marker: LineMarker | null;
}

/** Merges one page's lines into blocks (paragraphs + list items). */
function linesToBlocks(lines: readonly Line[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let runs: LineRun[] = [];
  let x0 = 0;
  let italicChars = 0;
  let plainChars = 0;
  let marker: LineMarker | null = null;
  let prevY: number | null = null;
  let prevSize = 10;

  const flush = (): void => {
    if (runs.length === 0) return;
    const totalChars = italicChars + plainChars;
    blocks.push({
      runs: runs
        .map((run) => ({ ...run, text: run.text.slice(0, MAX_RUN_CHARS) }))
        .filter((run) => run.text.trim().length > 0),
      x0,
      italicShare: totalChars > 0 ? italicChars / totalChars : 0,
      marker,
    });
    runs = [];
    italicChars = 0;
    plainChars = 0;
    marker = null;
  };

  const start = (line: Line): void => {
    runs = line.runs.map((run) => ({ ...run }));
    x0 = line.x0;
    marker = line.marker;
    for (const run of runs) {
      const chars = run.text.replace(/\s/g, "").length;
      if (run.italic) italicChars += chars;
      else plainChars += chars;
    }
  };

  for (const line of lines) {
    if (line.runs.length === 0) continue;
    if (line.marker !== null) {
      // A marked line ALWAYS starts its own item — never merges with
      // the previous paragraph or item.
      flush();
      start(line);
    } else if (runs.length === 0) {
      start(line);
    } else {
      const gap = prevY !== null ? prevY - line.y : 0;
      const tight =
        gap <= prevSize * PARAGRAPH_GAP &&
        Math.abs(line.size - prevSize) / Math.max(prevSize, 1) <= SIZE_CHANGE;
      if (tight) {
        // Soft-wrap continuation: joins the paragraph or list item.
        appendLine(runs, line);
        for (const run of line.runs) {
          const chars = run.text.replace(/\s/g, "").length;
          if (run.italic) italicChars += chars;
          else plainChars += chars;
        }
      } else {
        flush();
        start(line);
      }
    }
    prevY = line.y;
    prevSize = line.size;
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 4-5. extractMarkdownModel                                            */
/* ------------------------------------------------------------------ */

export function extractMarkdownModel(
  pages: readonly PdfTextItemInput[][],
  opts: ExtractOptions = {}
): MdDocModel {
  const headingsOn = opts.headings !== false;

  // Pass 1 — everything as lines, plus the char-weighted body size and
  // the document's modal left edge (quote detection).
  const pageLines: Line[][] = [];
  const sizeWeight = new Map<number, number>();
  const leftWeight = new Map<number, number>();
  for (let index = 0; index < pages.length; index += 1) {
    const links = opts.links?.[index];
    const lines = buildLines(
      collectPieces(pages[index], opts.styleMap, links)
    ).filter((line) => line.runs.length > 0);
    pageLines.push(lines);
    for (const line of lines) {
      for (const run of line.runs) {
        const sizeKey = Math.round(run.size * 2) / 2;
        sizeWeight.set(sizeKey, (sizeWeight.get(sizeKey) ?? 0) + run.text.length);
      }
      const leftKey = Math.round(line.x0 * 2) / 2;
      leftWeight.set(
        leftKey,
        (leftWeight.get(leftKey) ?? 0) +
          line.runs.reduce((sum, run) => sum + run.text.trim().length, 0)
      );
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
  let bodyLeft = Number.NaN;
  let bestLeftWeight = -1;
  for (const [left, weight] of leftWeight) {
    if (weight > bestLeftWeight) {
      bestLeftWeight = weight;
      bodyLeft = left;
    }
  }

  // Heading tiers: distinct sizes clearly above the body size, largest
  // first. Tier i becomes level i+1, capped at 6 (######).
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
  const headingSize =
    headingsOn && tiers.length > 0
      ? new Map<number, 1 | 2 | 3 | 4 | 5 | 6>()
      : null;
  if (headingSize) {
    tiers.forEach((size, index) => {
      const level = Math.min(index + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      headingSize.set(size, level);
    });
  }

  // Pass 2 — blocks + page marks + classification. The mark is pushed
  // BEFORE the page's blocks, so every page (empty ones included) owns
  // the index its content starts at — pageSlice depends on that.
  const blocks: MdBlock[] = [];
  const pageMarks: number[] = [];
  for (const lines of pageLines) {
    pageMarks.push(blocks.length);
    const pageBlocks = linesToBlocks(lines);
    for (const raw of pageBlocks) {
      const level = headingSize?.get(dominantSize(raw.runs));
      if (level !== undefined) {
        // Heading: plain, anchor-friendly text (inline markers dropped).
        // A list-marker-shaped head ("1. Introduction" as a section
        // heading) is restored from the consumed marker — the heading must
        // keep saying what the page says.
        blocks.push({
          kind: "heading",
          level,
          text: fixDevanagariVisual(
            (raw.marker?.raw ?? "") +
              raw.runs
                .map((run) => run.text)
                .join("")
                .replace(/\s+/g, " ")
                .trim()
          ),
        });
      } else if (
        raw.marker === null &&
        Number.isFinite(bodyLeft) &&
        raw.x0 >= bodyLeft + QUOTE_INDENT_PT &&
        raw.italicShare >= QUOTE_ITALIC_SHARE
      ) {
        blocks.push({ kind: "quote", runs: runsOut(raw.runs) });
      } else if (raw.marker?.kind === "bullet") {
        blocks.push({ kind: "bullet", runs: runsOut(raw.runs) });
      } else if (raw.marker?.kind === "ordered") {
        blocks.push({
          kind: "ordered",
          number: Math.max(1, Math.min(9999, raw.marker.number ?? 1)),
          runs: runsOut(raw.runs),
        });
      } else {
        blocks.push({ kind: "para", runs: runsOut(raw.runs) });
      }
    }
  }

  return {
    blocks: blocks.slice(0, MAX_BLOCKS),
    pageMarks,
  };
}

/** Internal LineRun list → the exported MdRun shape (Devanagari repaired). */
function runsOut(runs: readonly LineRun[]): MdRun[] {
  const out: MdRun[] = [];
  for (const run of runs) {
    const text = fixDevanagariVisual(run.text);
    if (text.trim().length === 0) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.link === run.link
    ) {
      last.text += text;
    } else {
      out.push({ text, bold: run.bold, italic: run.italic, link: run.link });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Markdown emitter                                                    */
/* ------------------------------------------------------------------ */

export interface BuildMarkdownOptions {
  /** "---" thematic breaks between PDF pages (single-output mode). */
  pageRules?: boolean;
  /** "<!-- converted by DocoPDF -->" at the very top. */
  metaComment?: boolean;
  /** YAML front matter block at the very top (before the comment). */
  frontMatter?: boolean;
  /** Front-matter title (plain, already extracted). */
  title?: string;
  /** Front-matter source file name. */
  sourceName?: string;
  /** Front-matter page count. */
  pages?: number;
}

/**
 * Escapes a literal markdown-significant start: the task's * # _ [ set
 * plus + > - and ordered-list markers ("2023. Year" → "2023\. Year").
 * Mid-text characters are left alone — CommonMark needs marker chars to
 * be line-initial (and followed by space) to mean anything.
 */
function escapeLeading(text: string): string {
  if (text.length === 0) return text;
  const first = text[0] as string;
  if ("#*_+[>-".includes(first)) return `\\${text}`;
  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(text);
  if (ordered !== null) {
    const digits = ordered[1] as string;
    return `${digits}\\${text.slice(digits.length)}`;
  }
  return text;
}

/** Makes a URL safe for the (...) part of [text](url). */
function safeUrl(url: string): string {
  return url
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s/g, "%20");
}

/** YAML double-quoted scalar. */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200)}"`;
}

/** Renders a run list as one inline Markdown string. */
function inlineRuns(runs: readonly MdRun[]): string {
  let out = "";
  let pendingSpace = false;
  let emitted = false;
  let firstCore = true;
  for (const run of runs) {
    const core = run.text.replace(/\s+/g, " ").trim();
    if (core.length === 0) {
      if (emitted) pendingSpace = true;
      continue;
    }
    const leadSpace = /^\s/.test(run.text);
    const trailSpace = /\s$/.test(run.text);
    if (emitted && (pendingSpace || leadSpace)) out += " ";
    let body: string;
    if (run.link !== undefined) {
      // Our own [..](..) markup: escape the brackets inside the label.
      body = `[${core.replace(/([[\]])/g, "\\$1")}](${safeUrl(run.link)})`;
    } else {
      // Line-start escaping applies only to the first visible core —
      // our own emphasis/link markers wrap later ones anyway.
      body = firstCore ? escapeLeading(core) : core;
    }
    firstCore = false;
    const emphasis =
      run.bold && run.italic ? "***" : run.bold ? "**" : run.italic ? "*" : "";
    out += emphasis + body + emphasis;
    pendingSpace = trailSpace;
    emitted = true;
  }
  return out;
}

/** One block → its Markdown line. */
function blockLine(block: MdBlock): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${escapeLeading(block.text)}`;
    case "quote":
      return `> ${inlineRuns(block.runs)}`;
    case "bullet":
      return `- ${inlineRuns(block.runs)}`;
    case "ordered":
      return `${block.number}. ${inlineRuns(block.runs)}`;
    case "para":
      return inlineRuns(block.runs);
  }
}

/** True when two consecutive blocks belong to ONE list (single \n join). */
function sameList(a: MdBlock, b: MdBlock): boolean {
  if (a.kind === "bullet" && b.kind === "bullet") return true;
  if (a.kind === "ordered" && b.kind === "ordered") return true;
  return false;
}

/**
 * Builds the final Markdown document:
 *  - blocks joined with blank lines; consecutive same-kind list items
 *    share single newlines (a tight list);
 *  - optional "---" between PDF pages (single-output mode);
 *  - optional YAML front matter and provenance comment on top.
 */
export function buildMarkdown(
  doc: MdDocModel,
  opts: BuildMarkdownOptions = {}
): string {
  const groups: string[] = [];
  let current: string[] = [];
  let openBlock: MdBlock | null = null;

  const flushGroup = (): void => {
    if (current.length > 0) groups.push(current.join("\n"));
    current = [];
    openBlock = null;
  };

  const pageStarts = new Set(doc.pageMarks.slice(1));
  doc.blocks.forEach((block, index) => {
    if (opts.pageRules === true && pageStarts.has(index)) {
      flushGroup();
      groups.push("---");
    }
    if (openBlock !== null && sameList(openBlock, block)) {
      current.push(blockLine(block));
    } else {
      flushGroup();
      current.push(blockLine(block));
      openBlock = block;
    }
  });
  flushGroup();

  const body = groups.join("\n\n");

  let head = "";
  if (opts.frontMatter === true) {
    const title = (opts.title ?? "").replace(/\s+/g, " ").trim();
    const source = (opts.sourceName ?? "").replace(/\s+/g, " ").trim();
    head += "---\n";
    if (title.length > 0) head += `title: ${yamlQuote(title)}\n`;
    if (source.length > 0) head += `source: ${yamlQuote(source)}\n`;
    head += `pages: ${Math.max(1, opts.pages ?? doc.pageMarks.length)}\n`;
    head += "converted_by: DocoPDF\n---\n\n";
  }
  if (opts.metaComment === true) {
    head += `${MD_META_COMMENT}\n\n`;
  }

  if (body.length === 0) {
    return head.length > 0 ? `${head.trimEnd()}\n` : "";
  }
  return `${head}${body}\n`;
}

/**
 * Slices the model to a single page's blocks (per-page output mode).
 * Heading tiers stay document-wide — only the emitted blocks narrow.
 */
export function pageSlice(doc: MdDocModel, pageIndex: number): MdDocModel {
  const start = doc.pageMarks[pageIndex] ?? doc.blocks.length;
  const end =
    pageIndex + 1 < doc.pageMarks.length
      ? (doc.pageMarks[pageIndex + 1] as number)
      : doc.blocks.length;
  return {
    blocks: doc.blocks.slice(start, Math.max(start, end)),
    pageMarks: start < end ? [0] : [],
  };
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion                                            */
/* ------------------------------------------------------------------ */

/** Options the surface sends (option panel values + locale extras). */
export interface PdfToMarkdownRunOptions {
  pages: string;
  perPage: boolean;
  pageRules: boolean;
  metaComment: boolean;
  frontMatter: boolean;
  locale: "en" | "hi";
  /** Localized fallback word for the output name. */
  fileWord: string;
}

/**
 * coerceRunOptions — the options payload the surface/shell sends.
 * Garbage degrades to the defaults; only an explicit true enables a
 * switch; the locale must be exactly "hi"; the page spec is sanitized
 * and clamped; the file word is sanitized + clamped.
 */
export function coerceRunOptions(
  raw: Record<string, unknown>
): PdfToMarkdownRunOptions {
  const str = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    pages: str(raw.pages, 200) || "all",
    perPage: raw.perPage === true,
    pageRules: raw.pageRules === true,
    metaComment: raw.metaComment === true,
    frontMatter: raw.frontMatter === true,
    locale: raw.locale === "hi" ? "hi" : "en",
    fileWord: str(raw.fileWord, 40),
  };
}

/* ------------------------------------------------------------------ */
/* Error mapping + output naming + stats                                */
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
 * "My Notes.pdf" → "My-Notes" (spaces collapse to hyphens, path-unsafe
 * chars stripped, Devanagari survives); a nameless file falls back to
 * the localized word. The caller appends ".md".
 */
export function outputBaseName(fileName: string, lang: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return base || (lang === "hi" ? "दस्तावेज़" : "document");
}

/** Run summary for the surface result card (protocol-reusing). */
export function markdownStats(doc: MdDocModel): PdfToMarkdownDetail {
  let paragraphs = 0;
  let headings = 0;
  for (const block of doc.blocks) {
    paragraphs += 1;
    if (block.kind === "heading") headings += 1;
  }
  return { paragraphs, headings, pages: doc.pageMarks.length };
}

/** The best front-matter title: the first H1, else the first heading. */
export function firstHeadingText(doc: MdDocModel): string {
  let found: string = "";
  for (const block of doc.blocks) {
    if (block.kind !== "heading") continue;
    if (found.length === 0) found = block.text;
    if (block.level === 1) return block.text;
  }
  return found;
}
