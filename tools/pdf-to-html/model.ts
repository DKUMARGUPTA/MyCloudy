import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF → HTML model (RB4-b). PURE TypeScript: no DOM, no pdf.js, no
 * pdf-lib — the smoke drives every export headless in bun, and the
 * worker feeds it real pdf.js text items + page viewports.
 *
 * Extraction core (adapted from pdf-to-word, the proven recipe):
 *  1. collectPieces — coerce + position-tag the raw pdf.js items
 *     (whitespace-only items become exactly ONE space piece;
 *     per-item splits keep their edge spaces).
 *  2. buildLines — group by y-proximity (half a font height), order
 *     by x, insert spaces at horizontal gaps (pdf.js emits one item
 *     per Tj without carrying spaces).
 *  3. Paragraphs — a baseline gap noticeably larger than one line
 *     height, or a font-size change, starts a new paragraph;
 *     hyphenated line endings merge back.
 *  4. Headings — font-size clusters: the body size is the
 *     char-weighted mode; sizes clearly above it form tiers; the
 *     largest tier becomes h1, the next h2 (only the top two —
 *     anything smaller stays body text, the honest pdf-to-word rule).
 *  5. Lists — conservative marker detection on the assembled line
 *     text (•, ·, -, – bullets and "1." / "1)" ordered markers);
 *     heading-tier lines are NEVER list items, and a wrapped line
 *     after a marker joins that same list item.
 *  6. Bold + italic — from the item's fontName and the worker's
 *     font-table enrichment (pdf.js 4.x reports internal ids like
 *     "g_d0_f3", so the worker correlates them with the PDF's own
 *     /Font resources; the id → {bold, italic} map is fed back here).
 *
 * Output builder — ONE self-contained .html: <!doctype html>,
 * <meta charset="utf-8">, <title> from the PDF metadata (resolved by
 * the worker), minimal embedded CSS (system font stack, max-width
 * article layout in flow mode), semantic tags (h1/h2/p/strong/em/
 * ul/ol/li), text as UTF-8 HTML with proper escaping. Hindi needs NO
 * font embedding — plain UTF-8 in the browser is the advantage over
 * PDF, documented honestly everywhere.
 *
 * Two honest modes:
 *  - "flow" (default) — reflowed semantic HTML: clean, responsive,
 *    readable on any screen; positions/columns/images do not survive.
 *  - "layout" — per-page absolutely-positioned divs (px positions =
 *    PDF pt × 96/72; per-page container with the exact page size):
 *    looks like the pages; the baseline uses a standard 0.8 em
 *    ascent approximation and text never rewraps.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * One raw pdf.js text item — deliberately loose (unknown fields) so
 * the same coercion runs at the worker boundary and in headless tests.
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

/** Bold + italic pair resolved per pdf.js font id (worker enrichment). */
export interface FontStyle {
  bold: boolean;
  italic: boolean;
}

/** One styled run inside a paragraph or list item. */
export interface HtmlRun {
  text: string;
  bold: boolean;
  italic: boolean;
  sizePt: number;
}

/** Flow-mode block: a paragraph (optionally a detected heading tier). */
export interface ParaBlock {
  kind: "para";
  runs: HtmlRun[];
  headingLevel?: 1 | 2;
}

/** Flow-mode block: one list item (grouped by adjacency at render). */
export interface ListBlock {
  kind: "list";
  list: "ul" | "ol";
  runs: HtmlRun[];
}

export type HtmlBlock = ParaBlock | ListBlock;

/** One visual line with its geometry (pt, pdf.js coordinates). */
export interface DocLine {
  runs: HtmlRun[];
  /** Left edge of the line's first piece (pt from page left). */
  x: number;
  /** Baseline y as pdf.js reports it (pt from page BOTTOM). */
  baseline: number;
  /** Char-weighted dominant font size (pt). */
  size: number;
}

/** Per-page extraction result (geometry + lines). */
export interface PageLines {
  pageNo: number;
  widthPt: number;
  heightPt: number;
  lines: DocLine[];
}

/** One page of raw input (worker assembles this per selected page). */
export interface PageInput {
  pageNo: number;
  widthPt: number;
  heightPt: number;
  items: readonly PdfTextItemInput[];
}

/** The extracted document both builders consume. */
export interface ExtractedDocument {
  pages: PageLines[];
  blocks: HtmlBlock[];
  /** Block index each page's blocks start at (-1 when a page has none). */
  pageStarts: number[];
  bodySize: number;
}

/** Run summary the surface shows (extends the shared protocol detail). */
export interface PdfToHtmlDetail extends RunDetail {
  paragraphs?: number;
  headings?: number;
}

/** Worker-boundary options, coerced by coerceRunOptions. */
export interface PdfToHtmlRunOptions {
  mode: "flow" | "layout";
  pageNumbers: boolean;
  pages: string;
  locale: "en" | "hi";
  /** Localized fallback word for the output name ("Webpage"/"वेबपेज"). */
  fileWord: string;
  /** Localized "Page" word for the output's markers + aria-labels. */
  pageWord?: string;
  /** Localized empty-page note for pages with no selectable text. */
  noTextWord?: string;
}

/** Clamps — docstring promises, enforced in code. */
export const MAX_BLOCKS = 2000;
export const MAX_RUN_CHARS = 500;
/** Layout mode caps the total absolutely-positioned lines. */
export const MAX_LAYOUT_LINES = 6000;
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

/** CSS px per PDF pt (the task-pinned 96/72 mapping). */
export const PT_TO_PX = 96 / 72;
/**
 * Standard ascent approximation used to place a line box so its
 * BASELINE lands on the PDF's own baseline (browsers expose no exact
 * ascent in CSS; 0.8 em is the accepted system-font approximation).
 */
export const ASCENT_EM = 0.8;

export const HTML_MIME = "text/html";

/** Letter class that keeps its script intact across a line break
 * (no regex property escapes — the house iOS-safe rule). */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";
const SCRIPT_END_RE = new RegExp(`[${SCRIPT}]-$`);
const LOWER_START_RE = new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]");

/** Font names that read as bold (real names only — "Helvetica-Bold"). */
const BOLD_NAME_RE = /(bold|black|heavy|demi|semib)/i;
/** Font names that read as italic/oblique ("Helvetica-Oblique"). */
const ITALIC_NAME_RE = /(italic|oblique)/i;

/** Conservative list markers on the ASSEMBLED line text. */
const BULLET_MARK_RE = /^[•·▪◦‣●○■▫]\s+/;
const ORDERED_MARK_RE = /^\d{1,3}[.)]\s+/;
const DASH_MARK_RE = /^[-–]\s+/;

/* ------------------------------------------------------------------ */
/* Text hygiene                                                        */
/* ------------------------------------------------------------------ */

/** HTML-escape for text and attribute content: & < > " ' */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips C0/C1 control characters (whitespace controls normalise to a
 * plain space) — every run text passes through here before the HTML.
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

/** pt → exact CSS px string (2 decimals, trailing zeros kept). */
export function px(pt: number): string {
  return (Math.round(pt * PT_TO_PX * 100) / 100).toFixed(2);
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

/** Rounded font size (0.5 pt buckets) for stable run comparisons. */
function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/** Coerces one page of raw pdf.js items into position-tagged pieces. */
function collectPieces(
  items: readonly PdfTextItemInput[],
  styleMap: ReadonlyMap<string, FontStyle> | undefined
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
    const style = styleMap?.get(fontName);
    const bold =
      item.bold === true ||
      style?.bold === true ||
      (fontName.length > 0 && BOLD_NAME_RE.test(fontName));
    const italic =
      item.italic === true ||
      style?.italic === true ||
      (fontName.length > 0 && ITALIC_NAME_RE.test(fontName));
    // sanitizeRunText trims the ends — but pdf.js drops its own split
    // items exactly there (it also emits whitespace-ONLY items for the
    // visual spaces it splits away). The raw item's leading/trailing
    // whitespace is restored as a single space; a whitespace-only item
    // becomes exactly ONE space piece (the pdf-to-word smoke proved
    // pdf.js emits per-space items).
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
function buildLines(pieces: Piece[]): DocLine[] {
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
    const runs: HtmlRun[] = [];
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
            sizePt: roundSize(piece.size),
          });
      }
      if (
        last &&
        last.bold === piece.bold &&
        last.italic === piece.italic &&
        last.sizePt === roundSize(piece.size)
      ) {
        last.text += piece.text;
      } else {
        runs.push({
          text: piece.text,
          bold: piece.bold,
          italic: piece.italic,
          sizePt: roundSize(piece.size),
        });
      }
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    // Merge identical-style neighbours created by the space glue above.
    const merged: HtmlRun[] = [];
    for (const run of runs) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.bold === run.bold &&
        prev.italic === run.italic &&
        prev.sizePt === run.sizePt
      ) {
        prev.text += run.text;
      } else {
        merged.push(run);
      }
    }
    return {
      runs: merged,
      x: ordered[0].x,
      baseline: group[0].y,
      size: dominantSize(merged),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Shared sizing helper                                                */
/* ------------------------------------------------------------------ */

/** Char-weighted dominant size of a run list (rounded to 0.5 pt). */
function dominantSize(
  runs: readonly { text: string; sizePt?: number; size?: number }[]
): number {
  let weighted = 0;
  let total = 0;
  for (const run of runs) {
    const size = run.sizePt ?? run.size ?? 10;
    weighted += size * run.text.length;
    total += run.text.length;
  }
  if (total === 0) return 10;
  return Math.round((weighted / total) * 2) / 2;
}

/* ------------------------------------------------------------------ */
/* 3-5. Paragraphs, headings, lists                                     */
/* ------------------------------------------------------------------ */

/** Strips the first `count` chars across the run list (marker removal). */
function stripLeadingChars(
  runs: readonly HtmlRun[],
  count: number
): HtmlRun[] {
  const out = runs.map((run) => ({ ...run }));
  let remaining = count;
  for (const run of out) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, run.text.length);
    run.text = run.text.slice(take);
    remaining -= take;
  }
  return out.filter((run) => run.text.length > 0);
}

/** Conservative list marker on the assembled line text, if any. */
function listMarker(text: string): "ul" | "ol" | null {
  if (BULLET_MARK_RE.test(text)) return "ul";
  if (ORDERED_MARK_RE.test(text)) return "ol";
  if (DASH_MARK_RE.test(text)) return "ul";
  return null;
}

function markerLength(text: string, marker: "ul" | "ol"): number {
  const match =
    marker === "ol"
      ? ORDERED_MARK_RE.exec(text)
      : BULLET_MARK_RE.exec(text) ?? DASH_MARK_RE.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Merges a page's lines into flow blocks (paragraphs, headings and
 * list items; runs preserved). `headingSize` maps a dominant size to
 * its tier — lines at a heading tier are never list items.
 */
function linesToBlocks(
  lines: readonly DocLine[],
  headingSize: ReadonlyMap<number, 1 | 2> | null,
  headingsOn: boolean
): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  let runs: HtmlRun[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  const flush = (): void => {
    if (runs.length === 0) return;
    const cleaned = runs
      .map((run) => ({
        text: run.text.slice(0, MAX_RUN_CHARS),
        bold: run.bold,
        italic: run.italic,
        sizePt: run.sizePt,
      }))
      .filter((run) => run.text.trim().length > 0);
    if (cleaned.length > 0) blocks.push({ kind: "para", runs: cleaned });
    runs = [];
  };

  const flushList = (list: "ul" | "ol", lineRuns: readonly HtmlRun[]): void => {
    const cleaned = lineRuns
      .map((run) => ({
        text: run.text.slice(0, MAX_RUN_CHARS),
        bold: run.bold,
        italic: run.italic,
        sizePt: run.sizePt,
      }))
      .filter((run) => run.text.trim().length > 0);
    if (cleaned.length > 0) blocks.push({ kind: "list", list, runs: cleaned });
  };

  for (const line of lines) {
    if (line.runs.length === 0) continue;
    const text = line.runs.map((run) => run.text).join("");

    // Heading-tier line → always its own paragraph (marker ignored).
    const tier = headingSize !== null ? headingSize.get(line.size) : undefined;
    if (tier !== undefined && headingsOn) {
      flush();
      runs = line.runs.map((run) => ({ ...run }));
      flush();
      prevY = line.baseline;
      prevSize = line.size;
      continue;
    }

    // List marker → a new list item (or the first of a list).
    const marker = listMarker(text);
    if (marker !== null) {
      flush();
      flushList(
        marker,
        stripLeadingChars(
          line.runs.map((run) => ({ ...run })),
          markerLength(text, marker)
        )
      );
      prevY = line.baseline;
      prevSize = line.size;
      continue;
    }

    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock !== undefined && lastBlock.kind === "list") {
      // Continuation of a wrapped list item when the gap stays tight
      // and the size is unchanged — otherwise a new paragraph.
      if (
        prevY !== null &&
        prevY - line.baseline <= prevSize * PARAGRAPH_GAP &&
        Math.abs(line.size - prevSize) / Math.max(prevSize, 1) <= SIZE_CHANGE
      ) {
        lastBlock.runs.push(...line.runs.map((run) => ({ ...run })));
      } else {
        flush();
        runs = line.runs.map((run) => ({ ...run }));
        flush();
      }
      prevY = line.baseline;
      prevSize = line.size;
      continue;
    }

    if (runs.length === 0) {
      runs = line.runs.map((run) => ({ ...run }));
    } else if (
      prevY !== null &&
      prevY - line.baseline > prevSize * PARAGRAPH_GAP
    ) {
      // Clear vertical gap → paragraph break.
      flush();
      runs = line.runs.map((run) => ({ ...run }));
    } else if (
      Math.abs(line.size - prevSize) / Math.max(prevSize, 1) > SIZE_CHANGE
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
      if (
        first.bold === last.bold &&
        first.italic === last.italic &&
        first.sizePt === last.sizePt
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
    prevY = line.baseline;
    prevSize = line.size;
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* extractDocument                                                     */
/* ------------------------------------------------------------------ */

export interface ExtractOptions {
  styleMap?: ReadonlyMap<string, FontStyle>;
  /** Heading detection (surface switch). Default: on. */
  headings?: boolean;
}

export function extractDocument(
  pages: readonly PageInput[],
  opts: ExtractOptions = {}
): ExtractedDocument {
  const headingsOn = opts.headings !== false;

  // Pass 1 — everything as lines, plus the char-weighted body size.
  const pageLines: PageLines[] = [];
  const sizeWeight = new Map<number, number>();
  for (const page of pages) {
    const lines = buildLines(collectPieces(page.items, opts.styleMap)).filter(
      (line) => line.runs.length > 0
    );
    pageLines.push({
      pageNo: page.pageNo,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      lines,
    });
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
  // first. Only the top two tiers become h1 / h2.
  const tierMin = Math.max(bodySize * HEADING_RATIO, bodySize + HEADING_ABS_PT);
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

  // Pass 2 — flow blocks + per-page starts (a page with no text gets
  // -1; the builder then shows an honest empty marker).
  const blocks: HtmlBlock[] = [];
  const pageStarts: number[] = [];
  for (const page of pageLines) {
    const pageBlocks = linesToBlocks(page.lines, headingSize, headingsOn);
    pageStarts.push(pageBlocks.length > 0 ? blocks.length : -1);
    for (const block of pageBlocks) {
      if (headingSize && headingsOn && block.kind === "para") {
        const level = headingSize.get(dominantSize(block.runs));
        if (level !== undefined) block.headingLevel = level;
      }
      blocks.push(block);
    }
  }

  // Clamp: pages whose blocks fell past the cap contribute no start
  // marker (their content was cut — the summary reflects that honestly).
  const cappedBlocks = blocks.slice(0, MAX_BLOCKS);
  const cappedStarts = pageStarts.map((start) =>
    start < cappedBlocks.length ? start : -1
  );

  return {
    pages: pageLines,
    blocks: cappedBlocks,
    pageStarts: cappedStarts,
    bodySize,
  };
}

/* ------------------------------------------------------------------ */
/* Language detection (html lang attribute)                            */
/* ------------------------------------------------------------------ */

/** True share of Devanagari codepoints across all extracted text. */
export function devanagariShare(doc: ExtractedDocument): number {
  let deva = 0;
  let total = 0;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      for (const run of line.runs) {
        total += run.text.length;
        for (const ch of run.text) {
          const code = ch.codePointAt(0) ?? 0;
          if (code >= 0x0900 && code <= 0x097f) deva += 1;
        }
      }
    }
  }
  return total > 0 ? deva / total : 0;
}

/** Mostly-Devanagari documents get lang="hi"; everything else "en". */
export function detectDocLang(doc: ExtractedDocument): "en" | "hi" {
  return devanagariShare(doc) > 0.2 ? "hi" : "en";
}

/* ------------------------------------------------------------------ */
/* HTML builders                                                        */
/* ------------------------------------------------------------------ */

export interface BuildHtmlOptions {
  mode: "flow" | "layout";
  /** Visible "Page N" markers between sections (surface switch). */
  pageNumbers: boolean;
  /** Plain-text document title (metadata, first heading or file name). */
  title: string;
  /** Localized "Page" word for markers + aria-labels. */
  pageWord?: string;
  /** Localized empty-page note. */
  noTextWord?: string;
}

/** Shared minimal CSS (system stack, no external requests, tiny). */
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
:root{--ink:#18181b;--paper:#ffffff;--muted:#71717a;--bg:#f4f4f5}
@media (prefers-color-scheme:dark){:root{--ink:#e4e4e7;--paper:#1c1c1f;--muted:#a1a1aa;--bg:#0b0b0d}}
body{margin:0;background:var(--bg);color:var(--ink);line-height:1.6;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans","Noto Sans Devanagari",sans-serif}`;

const FLOW_CSS = `.doc{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.9em;line-height:1.25;margin:1.1em 0 .45em}
h2{font-size:1.45em;line-height:1.3;margin:1.35em 0 .4em}
p{margin:0 0 1em}
ul,ol{margin:0 0 1em;padding-left:1.5em}
li{margin:0 0 .35em}
.pgno{margin:0 0 1.25em;font-size:.72em;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.empty{color:var(--muted);font-style:italic}`;

const LAYOUT_CSS = `.pages{display:flex;flex-direction:column;align-items:center;gap:1.9rem;padding:1.9rem 1rem 3.5rem}
.pgno{margin:0 0 -.7rem;font-size:.72em;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.page{position:relative;background:var(--paper);box-shadow:0 2px 12px rgba(0,0,0,.22);overflow:hidden}
.ln{position:absolute;white-space:nowrap;line-height:1;margin:0}
.empty{position:absolute;left:1rem;top:1rem;margin:0;color:var(--muted);font-style:italic;font-size:.8em}`;

/** Runs → inline HTML (strong/em nesting; headings drop redundant bold). */
function runsHtml(runs: readonly HtmlRun[], skipBold: boolean): string {
  let out = "";
  for (const run of runs) {
    const text = escapeHtml(run.text);
    if (run.bold && run.italic) {
      out += `<strong><em>${text}</em></strong>`;
    } else if (run.bold && !skipBold) {
      out += `<strong>${text}</strong>`;
    } else if (run.italic) {
      out += `<em>${text}</em>`;
    } else {
      out += text;
    }
  }
  return out;
}

/** Flow blocks of one page slice → semantic HTML. */
function flowBlocksHtml(blocks: readonly HtmlBlock[]): string {
  let out = "";
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === "para") {
      const body = runsHtml(block.runs, block.headingLevel !== undefined);
      out +=
        block.headingLevel === 1
          ? `<h1>${body}</h1>`
          : block.headingLevel === 2
            ? `<h2>${body}</h2>`
            : `<p>${body}</p>`;
      i += 1;
      continue;
    }
    // List block — group consecutive items of the same list kind.
    const items: string[] = [];
    while (
      i < blocks.length &&
      blocks[i].kind === "list" &&
      blocks[i].list === block.list
    ) {
      items.push(`<li>${runsHtml(blocks[i].runs, false)}</li>`);
      i += 1;
    }
    out += `<${block.list}>${items.join("")}</${block.list}>`;
  }
  return out;
}

/** The flow body: one <section> per page inside a single article. */
function buildFlowBody(doc: ExtractedDocument, opts: BuildHtmlOptions): string {
  const pageWord = opts.pageWord ?? "Page";
  const noText = escapeHtml(
    opts.noTextWord ?? "No selectable text on this page"
  );
  let out = '<main class="doc"><article>';
  for (let i = 0; i < doc.pages.length; i += 1) {
    const start = doc.pageStarts[i] ?? -1;
    let end = doc.blocks.length;
    for (let j = i + 1; j < doc.pageStarts.length; j += 1) {
      const next = doc.pageStarts[j] ?? -1;
      if (next >= 0) {
        end = next;
        break;
      }
    }
    const slice = start >= 0 ? doc.blocks.slice(start, end) : [];
    const no = doc.pages[i].pageNo;
    out += `<section class="pg" data-page="${no}" aria-label="${escapeHtml(pageWord)} ${no}">`;
    if (opts.pageNumbers) {
      out += `<p class="pgno">${escapeHtml(pageWord)} ${no}</p>`;
    }
    if (slice.length === 0) {
      out += `<p class="empty">${noText}</p>`;
    } else {
      out += flowBlocksHtml(slice);
    }
    out += "</section>";
  }
  out += "</article></main>";
  return out;
}

/** The layout body: per-page exact-size containers, px-positioned lines. */
function buildLayoutBody(
  doc: ExtractedDocument,
  opts: BuildHtmlOptions
): string {
  const pageWord = opts.pageWord ?? "Page";
  const noText = escapeHtml(
    opts.noTextWord ?? "No selectable text on this page"
  );
  let out = '<main class="pages">';
  let emitted = 0;
  for (const page of doc.pages) {
    out += `<section class="page" data-page="${page.pageNo}" aria-label="${escapeHtml(pageWord)} ${page.pageNo}" style="width:${px(page.widthPt)}px;height:${px(page.heightPt)}px">`;
    if (page.lines.length === 0) {
      out += `<p class="empty">${noText}</p>`;
    } else {
      for (const line of page.lines) {
        if (emitted >= MAX_LAYOUT_LINES) break;
        // Baseline placement: the line box top sits one standard ascent
        // (0.8 em) above the PDF's own baseline — pt × 96/72 → px.
        const topPt = page.heightPt - line.baseline - ASCENT_EM * line.size;
        out += `<div class="ln" style="left:${px(line.x)}px;top:${px(topPt)}px;font-size:${px(line.size)}px">${runsHtml(line.runs, false)}</div>`;
        emitted += 1;
      }
    }
    out += "</section>";
    if (opts.pageNumbers) {
      out += `<p class="pgno">${escapeHtml(pageWord)} ${page.pageNo}</p>`;
    }
    if (emitted >= MAX_LAYOUT_LINES) break;
  }
  out += "</main>";
  return out;
}

/**
 * Builds the ONE self-contained .html document: doctype, charset meta,
 * viewport, generator, <title>, embedded CSS, and the mode's body.
 */
export function buildHtml(
  doc: ExtractedDocument,
  opts: BuildHtmlOptions
): string {
  const lang = detectDocLang(doc);
  const modeCss = opts.mode === "layout" ? LAYOUT_CSS : FLOW_CSS;
  const body =
    opts.mode === "layout"
      ? buildLayoutBody(doc, opts)
      : buildFlowBody(doc, opts);
  return (
    "<!doctype html>\n" +
    `<html lang="${lang}">\n` +
    "<head>\n" +
    '<meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    '<meta name="generator" content="MyCloudy"/>\n' +
    `<title>${escapeHtml(opts.title.slice(0, 120).trim())}</title>\n` +
    `<style>\n${BASE_CSS}\n${modeCss}\n</style>\n` +
    "</head>\n" +
    `<body class="${opts.mode}">\n` +
    body +
    "\n</body>\n" +
    "</html>\n" +
    "<!-- Converted from PDF by MyCloudy — 100% on-device -->\n"
  );
}

/* ------------------------------------------------------------------ */
/* Summary stats (surface result card)                                 */
/* ------------------------------------------------------------------ */

export function docStats(doc: ExtractedDocument): PdfToHtmlDetail {
  let paragraphs = 0;
  let headings = 0;
  for (const block of doc.blocks) {
    paragraphs += 1;
    if (block.kind === "para" && block.headingLevel !== undefined) {
      headings += 1;
    }
  }
  return { paragraphs, headings, pages: doc.pages.length };
}

/** Total positioned lines (layout mode's honest block count). */
export function layoutLineCount(doc: ExtractedDocument): number {
  let total = 0;
  for (const page of doc.pages) total += page.lines.length;
  return Math.min(total, MAX_LAYOUT_LINES);
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion + naming + error mapping                    */
/* ------------------------------------------------------------------ */

/**
 * coerceRunOptions — the options payload the surface/shell sends.
 * Garbage values degrade to the defaults; only an explicit true turns
 * the page-number switch on; the page spec must be a string; the
 * locale must be exactly "hi"; the file word is sanitized + clamped.
 */
export function coerceRunOptions(
  raw: Record<string, unknown>
): PdfToHtmlRunOptions {
  const str = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    mode: raw.mode === "layout" ? "layout" : "flow",
    pageNumbers: raw.pageNumbers === true,
    pages: str(raw.pages, 200) || "all",
    locale: raw.locale === "hi" ? "hi" : "en",
    fileWord: str(raw.fileWord, 40),
    pageWord: str(raw.pageWord, 16) || undefined,
    noTextWord: str(raw.noTextWord, 90) || undefined,
  };
}

/**
 * pdf.js failure message → honest i18n error code. Encrypted PDFs ask
 * for a password (PasswordException); everything unreadable is corrupt.
 */
export function pdfErrorMessageToCode(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}

/**
 * "My Page.pdf" → "My-Page" (spaces collapse to hyphens, path-unsafe
 * chars stripped, Devanagari survives); a nameless file falls back to
 * the localized word. The caller appends ".html".
 */
export function outputBaseName(fileName: string, lang: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return base || (lang === "hi" ? "वेबपेज" : "Webpage");
}
