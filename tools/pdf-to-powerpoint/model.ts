import { strToU8, zipSync, type Zippable } from "@/lib/own/zip";

import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF → PowerPoint model (RB3-d). PURE TypeScript: no pdf.js, no DOM,
 * no pdf-lib — the smoke drives every export headless in bun, and the
 * worker feeds it real pdf.js text items + page viewports.
 *
 * Pipeline (all in this file):
 *  1. collectPieces — coerce + position-tag the raw pdf.js items (the
 *     pdf-to-word recipe: whitespace-only items become exactly ONE
 *     space piece, per-item splits keep their edge spaces).
 *  2. buildLines — group items into visual lines (same baseline y
 *     within half a font height); within a line the pieces are ordered
 *     by x and joined into runs, with a space inserted wherever the
 *     horizontal gap exceeds a quarter of the font size (pdf.js emits
 *     one item per Tj without carrying spaces).
 *  3. buildBlocks — lines merge into text blocks on y-proximity
 *     (baseline gap ≤ 1.7 × font size) AND font-size similarity
 *     (≤ 25% change) — a title above body never glues to its body.
 *  4. Title detection — the largest font size among blocks whose first
 *     line sits in the TOP THIRD of the page; ties go to the topmost.
 *     The winning block becomes its own bold title shape.
 *  5. Layout mapping — page pt → slide EMU. Slide sizes: "16:9"
 *     (12192000×6858000), "4:3" (9144000×6858000) or "match page"
 *     (page pt × 12700, orientation-aware). Every page is CONTAIN-FIT
 *     into the slide (scale = min(slideW/pageW, slideH/pageH)) and
 *     centered when the aspects differ, so no content ever lands off
 *     the slide. Font size × scale, clamped 8–96 pt (a:p sz is
 *     hundredths). One text box (p:sp + p:txBody) per block, one a:p
 *     per line, body width = the remaining column width (block x →
 *     page content right edge).
 *  6. Font naming — PPTX does NOT embed fonts: each run references a
 *     typeface by name. Devanagari text → "Noto Sans Devanagari"
 *     (a:latin + a:ea + a:cs), everything else → "Calibri". This is
 *     the honest advantage over PDF export: हिंदी needs no font bytes.
 *  7. buildPptx — a REAL minimal Office Open XML package via fflate
 *     zipSync (the pdf-to-excel writer recipe): [Content_Types].xml,
 *     _rels/.rels, ppt/presentation.xml (+ rels), slideMaster + rels +
 *     theme, slideLayout + rels, one slideN.xml (+ rels) per page,
 *     optional ppt/media/imageN.png for page-images mode, docProps
 *     core.xml + app.xml (creator "DocoPDF"). NO external pptx
 *     library — and the parts are shaped exactly for the mirror tool
 *     powerpoint-to-pdf's parsePptx to read back (the smoke proves it).
 *
 * Honest limits (mirrored in config.ts + the surface):
 *  - text mode carries TEXT ONLY: vector art, fills, images and
 *    tables come out as plain text boxes at approximated positions;
 *  - page-images mode renders each page as one full-bleed PNG —
 *    pixel-exact look, nothing editable;
 *  - scanned pages in text mode produce empty slides (never a fake
 *    failure) — counted honestly in the run detail.
 */

/* ------------------------------------------------------------------ */
/* Hard caps                                                            */
/* ------------------------------------------------------------------ */

export const MAX_SLIDES = 100;
export const MAX_BOXES_PER_SLIDE = 200;
export const MAX_LINES_PER_BOX = 200;
export const MAX_RUN_TEXT = 2_000;

/** a:rPr @sz bounds in pt (hundredths on the wire). */
export const MIN_FONT_PT = 8;
export const MAX_FONT_PT = 96;

/** ECMA-376 slide-side ceiling: 51206400 EMU = 4032 pt. */
const MAX_EMU = 51206400;
/** Never emit a sliver shape: minimum box extent in EMU (~0.9 mm). */
const MIN_EXT_EMU = 35720;

/** 914400 EMU = one inch — the "match page" floor. */
const MIN_SLIDE_EMU = 914400;

/** Fraction of the font size the ascender covers (Helvetica ≈ 0.718,
 *  most UI fonts ≈ 0.75 — a good middle for box-top placement). */
const ASCENT = 0.75;
/** Line advance multiplier (PowerPoint single spacing ≈ 1.2). */
const LINE_LEADING = 1.22;

export const EMU_PER_PT = 12700;

/* Fixed slide sizes (EMU) — the PowerPoint widescreen / standard sizes. */
export const SLIDE_16_9 = { cx: 12192000, cy: 6858000 } as const;
export const SLIDE_4_3 = { cx: 9144000, cy: 6858000 } as const;

/* Line/block tolerances (fractions of the font size). */
const LINE_Y_TOL = 0.5;
const SPACE_GAP = 0.25;
const BLOCK_GAP = 1.7;
const BLOCK_SIZE_TOL = 0.25;

export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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
}

/** One styled run inside a slide text box. */
export interface SlideRun {
  text: string;
  /** scaled + clamped (8–96) font size in pt. */
  sizePt: number;
  bold: boolean;
  /** "Calibri" | "Noto Sans Devanagari" (referenced by name — PPTX
   *  never embeds font bytes). */
  typeface: string;
}

/** One visual line → one a:p. */
export interface SlidePara {
  runs: SlideRun[];
}

/** One text box (p:sp with p:txBody), geometry in EMU. */
export interface SlideBox {
  x: number;
  y: number;
  cx: number;
  cy: number;
  paras: SlidePara[];
  isTitle: boolean;
}

/** One converted page. */
export interface SlidePage {
  boxes: SlideBox[];
  /** true when the source page had no selectable text (scan). */
  empty: boolean;
}

/** Run summary the surface shows (extends the shared protocol detail). */
export interface PdfToPptDetail extends RunDetail {
  emptySlides?: number;
}

export type SlideSizeOption = "16-9" | "4-3" | "match";
export type RenderMode = "text" | "images";

/** Worker-boundary options, coerced by coerceRunOptions. */
export interface P2PptRunOptions {
  mode: RenderMode;
  slideSize: SlideSizeOption;
  /** page-range spec ("all" | "1-3, 5") — parsed against numPages. */
  pages: string;
  locale: "en" | "hi";
  /** Localized fallback word for the output name. */
  fileWord: string;
}

/* ------------------------------------------------------------------ */
/* WinAnsi / Devanagari helpers (family copies)                        */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const DEVA_RE = /[\u0900-\u097F]/;

/**
 * true when every char is encodable in WinAnsi (CP1252) minus controls.
 * Not a font-encoding question here — the PPTX is UTF-8 XML; it only
 * decides WHICH typeface name a run should reference.
 */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x09) continue;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** The typeface a run references: Devanagari → the Noto face,
 *  everything else → Calibri (no embedding, just the name). */
export function typefaceFor(text: string): string {
  return !isWinAnsiText(text) && DEVA_RE.test(text)
    ? "Noto Sans Devanagari"
    : "Calibri";
}

/** Font names that read as bold (real names only). */
const BOLD_NAME_RE = /(bold|black|heavy|demi|semib)/i;

/* ------------------------------------------------------------------ */
/* Devanagari visual→logical repair (pdf-to-excel copy)                 */
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
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** XML-escape text content and drop XML-1.0-invalid controls. */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Strips C0/C1 controls, collapses whitespace to single spaces. */
export function sanitizeRunText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 28 && code <= 32) out += " ";
    else if (code < 32 || (code >= 127 && code <= 159)) continue;
    else out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** EMU extent: finite → clamped to [0, MAX_EMU], else 0. */
function emu(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_EMU, Math.round(v)));
}

/** EMU offset: clamped to ±MAX_EMU (shapes may start above/left). */
function emuOff(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-MAX_EMU, Math.min(MAX_EMU, Math.round(v)));
}

/* ------------------------------------------------------------------ */
/* Slide size resolution                                               */
/* ------------------------------------------------------------------ */

export interface SlideSize {
  cx: number;
  cy: number;
}

/**
 * "16-9" → 12192000×6858000, "4-3" → 9144000×6858000, "match" → the
 * page's own points × 12700 (orientation-aware: a portrait page gets a
 * portrait slide), clamped to [1 inch, 4032 pt] per side.
 */
export function slideSizeFor(
  option: SlideSizeOption,
  pageW: number,
  pageH: number
): SlideSize {
  if (option === "4-3") return { cx: SLIDE_4_3.cx, cy: SLIDE_4_3.cy };
  if (option !== "match") return { cx: SLIDE_16_9.cx, cy: SLIDE_16_9.cy };
  const w = Number.isFinite(pageW) ? pageW : 612;
  const h = Number.isFinite(pageH) ? pageH : 792;
  return {
    cx: Math.max(MIN_SLIDE_EMU, Math.min(MAX_EMU, Math.round(w * EMU_PER_PT))),
    cy: Math.max(MIN_SLIDE_EMU, Math.min(MAX_EMU, Math.round(h * EMU_PER_PT))),
  };
}

/** presentation.xml @type for a given sldSz. */
function slideSizeType(size: SlideSize, option: SlideSizeOption): string {
  if (option === "16-9" && size.cx === SLIDE_16_9.cx && size.cy === SLIDE_16_9.cy) {
    return ' type="screen16x9"';
  }
  if (option === "4-3" && size.cx === SLIDE_4_3.cx && size.cy === SLIDE_4_3.cy) {
    return ' type="screen4x3"';
  }
  return ' type="custom"';
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

/** Coerces one page of raw pdf.js items into position-tagged pieces. */
function collectPieces(items: readonly PdfTextItemInput[]): Piece[] {
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
    const bold = fontName.length > 0 && BOLD_NAME_RE.test(fontName);
    // sanitizeRunText trims the ends — but pdf.js drops its own split
    // items exactly there (whitespace-only items carry the visual
    // spaces). The raw item's edge whitespace is restored as a single
    // space; a whitespace-only item becomes exactly ONE space piece
    // (never two glued ends — the RB1 lesson).
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

interface LineRun {
  text: string;
  bold: boolean;
  size: number;
  typeface: string;
}

interface Line {
  runs: LineRun[];
  /** baseline y in PDF points (grows up the page). */
  y: number;
  /** leftmost piece start. */
  x: number;
  /** rightmost piece end. */
  endX: number;
  /** line font size (max piece size, 0.5 pt buckets). */
  size: number;
}

/** Rounded font size (0.5 pt buckets) for stable comparisons. */
function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/** Groups pieces into visual lines with styled runs. */
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
    let x = ordered[0]?.x ?? 0;
    let endX = x;
    let size = 0;
    const runs: LineRun[] = [];
    let lastEnd: number | null = null;
    for (const piece of ordered) {
      x = Math.min(x, piece.x);
      endX = Math.max(endX, piece.x + piece.w);
      size = Math.max(size, piece.size);
      const typeface = typefaceFor(piece.text);
      const last = runs[runs.length - 1];
      if (
        lastEnd !== null &&
        piece.x - lastEnd > piece.size * SPACE_GAP &&
        !last?.text.endsWith(" ")
      ) {
        // pdf.js items carry no spaces — a real gap becomes one.
        if (last) last.text += " ";
        else
          runs.push({
            text: " ",
            bold: piece.bold,
            size: roundSize(piece.size),
            typeface,
          });
      }
      if (
        last &&
        last.bold === piece.bold &&
        last.size === roundSize(piece.size) &&
        last.typeface === typeface
      ) {
        last.text += piece.text;
      } else {
        runs.push({
          text: piece.text,
          bold: piece.bold,
          size: roundSize(piece.size),
          typeface,
        });
      }
      lastEnd = Math.max(lastEnd ?? 0, piece.x + piece.w);
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
        prev.size === run.size &&
        prev.typeface === run.typeface
      ) {
        prev.text += run.text;
      } else {
        merged.push({ ...run, text: fixDevanagariVisual(run.text) });
      }
    }
    return {
      runs: merged.filter((run) => run.text.trim().length > 0),
      y: group[0]?.y ?? 0,
      x,
      endX,
      size: roundSize(size),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 3-4. Blocks + title detection                                        */
/* ------------------------------------------------------------------ */

interface Block {
  lines: Line[];
  x: number;
  endX: number;
  /** dominant (char-weighted, 0.5 pt buckets) size. */
  size: number;
}

/** Char-weighted dominant size of a block. */
function dominantSize(lines: readonly Line[]): number {
  let weighted = 0;
  let total = 0;
  for (const line of lines) {
    weighted += line.size * line.runs.reduce((n, r) => n + r.text.length, 0);
    total += line.runs.reduce((n, r) => n + r.text.length, 0);
  }
  if (total === 0) return 10;
  return Math.round((weighted / total) * 2) / 2;
}

/** Merges lines into blocks: y-proximity + font-size similarity. */
function buildBlocks(lines: readonly Line[]): Block[] {
  const blocks: Block[] = [];
  let current: Line[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  const flush = (): void => {
    if (current.length === 0) return;
    blocks.push({
      lines: current,
      x: Math.min(...current.map((line) => line.x)),
      endX: Math.max(...current.map((line) => line.endX)),
      size: dominantSize(current),
    });
    current = [];
  };

  // lines arrive top-of-page first (y descends).
  for (const line of lines) {
    if (line.runs.length === 0) continue;
    if (current.length === 0) {
      current = [line];
    } else if (prevY !== null && prevY - line.y > BLOCK_GAP * Math.max(prevSize, line.size)) {
      // clear vertical gap → new block
      flush();
      current = [line];
    } else if (
      Math.abs(line.size - prevSize) >
      Math.max(1.5, prevSize * BLOCK_SIZE_TOL)
    ) {
      // font-size change (title above body) → new block
      flush();
      current = [line];
    } else {
      current.push(line);
    }
    prevY = line.y;
    prevSize = line.size;
  }
  flush();
  return blocks;
}

/** Title = the largest dominant font among blocks whose first line sits
 *  in the top third of the page (ties → the topmost); −1 when none. */
export function detectTitleIndex(
  blocks: readonly { lines: Line[]; size: number }[],
  pageH: number
): number {
  const topThird = pageH * (2 / 3);
  let best = -1;
  let bestSize = -1;
  let bestY = -Infinity;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    const first = block.lines[0];
    const chars = block.lines.reduce(
      (n, line) => n + line.runs.reduce((m, r) => m + r.text.trim().length, 0),
      0
    );
    if (!first || chars < 3) continue;
    if (first.y < topThird) continue; // not in the top third
    if (
      block.size > bestSize ||
      (block.size === bestSize && first.y > bestY)
    ) {
      best = i;
      bestSize = block.size;
      bestY = first.y;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 5. Layout mapping — page pt → slide EMU                              */
/* ------------------------------------------------------------------ */

/** Contain-fit scale + centering offsets (pt space). */
export function fitTransform(
  pageW: number,
  pageH: number,
  slide: SlideSize
): { scale: number; offX: number; offY: number } {
  const slideW = slide.cx / EMU_PER_PT;
  const slideH = slide.cy / EMU_PER_PT;
  const w = pageW > 0 ? pageW : 1;
  const h = pageH > 0 ? pageH : 1;
  const scale = Math.min(slideW / w, slideH / h);
  return {
    scale,
    offX: (slideW - w * scale) / 2,
    offY: (slideH - h * scale) / 2,
  };
}

/** Scaled + clamped font size in pt (8–96, the pptx family clamp). */
export function scaledFontPt(sizePt: number, scale: number): number {
  const v = sizePt * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, Math.round(v * 100) / 100));
}

/**
 * Converts one page of raw pdf.js items into a slide of positioned
 * text boxes. Pure: the same function feeds the smoke and the worker.
 */
export function extractTextSlide(
  items: readonly PdfTextItemInput[],
  pageW: number,
  pageH: number,
  slide: SlideSize
): SlidePage {
  const pieces = collectPieces(items);
  if (pieces.length === 0) return { boxes: [], empty: true };
  const lines = buildLines(pieces).filter((line) => line.runs.length > 0);
  if (lines.length === 0) return { boxes: [], empty: true };

  const blocks = buildBlocks(lines);
  const titleIndex = detectTitleIndex(blocks, pageH);
  const { scale, offX, offY } = fitTransform(pageW, pageH, slide);

  // body width = the remaining column width: block x → the page's
  // content right edge (never narrower than the block's own text).
  let contentRight = Math.min(pageW - 18, pageW * 0.9);
  for (const block of blocks) {
    if (block.endX > contentRight) contentRight = block.endX;
  }

  const boxes: SlideBox[] = [];
  for (let bi = 0; bi < blocks.length && boxes.length < MAX_BOXES_PER_SLIDE; bi += 1) {
    const block = blocks[bi];
    if (!block) continue;
    const first = block.lines[0] as Line;
    const isTitle = bi === titleIndex;

    const boxX = emuOff((offX + block.x * scale) * EMU_PER_PT);
    // box top = the first line's ascender top (PDF y is the baseline,
    // growing up; EMU grows down from the slide origin).
    const boxY = emuOff(
      (offY + (pageH - (first.y + first.size * ASCENT)) * scale) * EMU_PER_PT
    );
    const widthPt = Math.max(block.endX - block.x, contentRight - block.x, 12);
    const boxCx = Math.max(MIN_EXT_EMU, emu(widthPt * scale * EMU_PER_PT));
    const heightPt = block.lines.reduce(
      (sum, line) => sum + line.size * LINE_LEADING,
      0
    );
    const boxCy = Math.max(
      MIN_EXT_EMU,
      emu(Math.max(heightPt * scale, first.size * 1.1) * EMU_PER_PT)
    );

    const paras: SlidePara[] = [];
    for (const line of block.lines) {
      if (paras.length >= MAX_LINES_PER_BOX) break;
      const runs: SlideRun[] = [];
      for (const run of line.runs) {
        const text = run.text.slice(0, MAX_RUN_TEXT);
        if (text.trim().length === 0) continue;
        runs.push({
          text,
          sizePt: scaledFontPt(run.size, scale),
          bold: run.bold || isTitle,
          typeface: run.typeface,
        });
      }
      if (runs.length > 0) paras.push({ runs });
    }
    if (paras.length === 0) continue;
    boxes.push({ x: boxX, y: boxY, cx: boxCx, cy: boxCy, paras, isTitle });
  }

  return { boxes, empty: false };
}

/* ------------------------------------------------------------------ */
/* 6-7. PPTX package writer (fflate OOXML — minimal valid)            */
/* ------------------------------------------------------------------ */

const XMLNS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const RT_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const RT_SLIDE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RT_SLIDE_LAYOUT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const RT_SLIDE_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const RT_THEME =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";
const RT_IMAGE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const RT_CORE_PROPERTIES =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const RT_EXTENDED_PROPERTIES =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";

const CT_PRESENTATION =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const CT_SLIDE_MASTER =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const CT_SLIDE_LAYOUT =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
const CT_SLIDE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_THEME = "application/vnd.openxmlformats-officedocument.theme+xml";

function rel(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
}

function relsXml(entries: string[]): string {
  return (
    `${XML_DECL}` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    entries.join("") +
    "</Relationships>"
  );
}

/** sz hundredths, clamped to the 8–96 pt family range. */
function szHundredths(sizePt: number): number {
  const pt = Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, sizePt));
  return Math.round(pt * 100);
}

function runXml(run: SlideRun): string {
  const sz = szHundredths(run.sizePt);
  const lang = run.typeface === "Noto Sans Devanagari" ? "hi-IN" : "en-US";
  const rPr =
    `<a:rPr lang="${lang}" dirty="0" sz="${sz}"` +
    (run.bold ? ' b="1"' : "") +
    ">" +
    `<a:latin typeface="${run.typeface}"/>` +
    `<a:ea typeface="${run.typeface}"/>` +
    `<a:cs typeface="${run.typeface}"/>` +
    "</a:rPr>";
  return `<a:r>${rPr}<a:t xml:space="preserve">${xmlEscape(run.text)}</a:t></a:r>`;
}

function boxXml(box: SlideBox, id: number): string {
  const nv =
    `<p:nvSpPr><p:cNvPr id="${id}" name="${box.isTitle ? "Title" : "Text"} ${id}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>';
  const spPr =
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
    `<a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>';
  const paras = box.paras
    .map((para) => `<a:p>${para.runs.map(runXml).join("")}</a:p>`)
    .join("");
  const txBody =
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/>` +
    `<a:lstStyle/>${paras}</p:txBody>`;
  return `<p:sp>${nv}${spPr}${txBody}</p:sp>`;
}

/** Full-bleed (contain-fit, centered) page picture. */
function picXml(
  id: number,
  embed: string,
  x: number,
  y: number,
  cx: number,
  cy: number
): string {
  const nv =
    `<p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>';
  const blip = `<p:blipFill><a:blip r:embed="${embed}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
  const spPr =
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>';
  return `<p:pic>${nv}${blip}${spPr}</p:pic>`;
}

function spTreeOpen(size: SlideSize, children: string): string {
  return (
    "<p:spTree>" +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${size.cx}" cy="${size.cy}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${size.cx}" cy="${size.cy}"/></a:xfrm></p:grpSpPr>` +
    children +
    "</p:spTree>"
  );
}

/** text slide part. */
function slideXml(size: SlideSize, page: SlidePage): string {
  const boxes = page.boxes.map((box, i) => boxXml(box, i + 2)).join("");
  return (
    `${XML_DECL}<p:sld ${XMLNS}><p:cSld>` +
    spTreeOpen(size, boxes) +
    "</p:cSld></p:sld>"
  );
}

/** image slide part (one centered contain-fit picture). */
function slideImageXml(size: SlideSize, aspect: number, embed: string): string {
  const slideAspect = size.cx / size.cy;
  let cx = size.cx;
  let cy = size.cy;
  if (aspect > slideAspect) cy = Math.round(size.cx / aspect);
  else cx = Math.round(size.cy * aspect);
  const x = Math.round((size.cx - cx) / 2);
  const y = Math.round((size.cy - cy) / 2);
  return (
    `${XML_DECL}<p:sld ${XMLNS}><p:cSld>` +
    spTreeOpen(size, picXml(2, embed, x, y, cx, cy)) +
    "</p:cSld></p:sld>"
  );
}

/** The minimal valid theme the mirror tool's parser accepts (the
 *  powerpoint-to-pdf buildSamplePptx theme, verbatim). */
function themeXml(): string {
  return (
    `${XML_DECL}` +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="M">' +
    '<a:themeElements><a:clrScheme name="M"><a:dk1><a:sysClr val="windowText"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="M"><a:majorFont><a:latin typeface=""/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface=""/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
  );
}

const SP_TREE_EMPTY =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';

function slideMasterXml(): string {
  return (
    `${XML_DECL}` +
    `<p:sldMaster ${XMLNS}><p:cSld>${SP_TREE_EMPTY}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
  );
}

function slideLayoutXml(): string {
  return (
    `${XML_DECL}` +
    `<p:sldLayout ${XMLNS}><p:cSld name="Blank">${SP_TREE_EMPTY}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
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

export interface PptxBuildOptions {
  mode: RenderMode;
  /** presentation-level slide size (EMU) — sldSz. */
  slide: SlideSize;
  slideSizeOption: SlideSizeOption;
  /** PNG bytes per slide (images mode; length must equal slides). */
  images?: Uint8Array[];
  /** per-page aspect (w/h) for images mode full-bleed fitting. */
  imageAspects?: number[];
  /** per-page text slides (text mode). */
  pages?: SlidePage[];
  /** document title for docProps/core.xml. */
  title: string;
}

/**
 * Builds a valid minimal .pptx (Uint8Array) with fflate zipSync — the
 * OOXML writer recipe from pdf-to-excel: [Content_Types].xml with
 * per-part overrides (+ a png Default in images mode), _rels/.rels,
 * presentation + master + layout + theme chain, one slideN.xml (+rels)
 * per page and the docProps pair PowerPoint's strict loader expects.
 * Everything clamped to the caps above.
 */
export function buildPptx(opts: PptxBuildOptions): Uint8Array {
  let mode = opts.mode;
  let count =
    mode === "images"
      ? Math.min(MAX_SLIDES, opts.images?.length ?? 0)
      : Math.min(MAX_SLIDES, opts.pages?.length ?? 0);
  if (count === 0) {
    // an honest empty presentation (one blank slide) — never invalid
    mode = "text";
    count = 1;
  }
  const n = count;

  /* [Content_Types].xml */
  const ctParts = [
    XML_DECL,
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ];
  if (mode === "images") {
    ctParts.push('<Default Extension="png" ContentType="image/png"/>');
  }
  ctParts.push(
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT_PRESENTATION}"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT_SLIDE_MASTER}"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT_SLIDE_LAYOUT}"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT_THEME}"/>`
  );
  for (let i = 1; i <= n; i += 1) {
    ctParts.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="${CT_SLIDE}"/>`
    );
  }
  ctParts.push(
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>"
  );

  /* _rels/.rels */
  const rootRels = relsXml([
    rel("rId1", RT_OFFICE_DOCUMENT, "ppt/presentation.xml"),
    rel("rId2", RT_CORE_PROPERTIES, "docProps/core.xml"),
    rel("rId3", RT_EXTENDED_PROPERTIES, "docProps/app.xml"),
  ]);

  /* ppt/presentation.xml */
  const sldIds = Array.from(
    { length: n },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join("");
  const presentation =
    `${XML_DECL}` +
    `<p:presentation ${XMLNS}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${opts.slide.cx}" cy="${opts.slide.cy}"${slideSizeType(opts.slide, opts.slideSizeOption)}/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>";

  /* ppt/_rels/presentation.xml.rels */
  const presRels = relsXml([
    rel("rId1", RT_SLIDE_MASTER, "slideMasters/slideMaster1.xml"),
    ...Array.from(
      { length: n },
      (_, i) => rel(`rId${i + 2}`, RT_SLIDE, `slides/slide${i + 1}.xml`)
    ),
  ]);

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(ctParts.join("")),
    "_rels/.rels": strToU8(rootRels),
    "ppt/presentation.xml": strToU8(presentation),
    "ppt/_rels/presentation.xml.rels": strToU8(presRels),
    "ppt/slideMasters/slideMaster1.xml": strToU8(slideMasterXml()),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
      relsXml([
        rel("rId1", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml"),
        rel("rId2", RT_THEME, "../theme/theme1.xml"),
      ])
    ),
    "ppt/theme/theme1.xml": strToU8(themeXml()),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(slideLayoutXml()),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
      relsXml([rel("rId1", RT_SLIDE_MASTER, "../slideMasters/slideMaster1.xml")])
    ),
    "docProps/core.xml": strToU8(coreXml(opts.title)),
    "docProps/app.xml": strToU8(appXml()),
  };

  for (let i = 1; i <= n; i += 1) {
    if (mode === "images") {
      const image = opts.images?.[i - 1];
      const aspect = opts.imageAspects?.[i - 1];
      if (
        !image ||
        image.length === 0 ||
        typeof aspect !== "number" ||
        !Number.isFinite(aspect)
      ) {
        continue;
      }
      files[`ppt/slides/slide${i}.xml`] = strToU8(
        slideImageXml(opts.slide, aspect, "rId2")
      );
      files[`ppt/slides/_rels/slide${i}.xml.rels`] = strToU8(
        relsXml([
          rel("rId1", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml"),
          rel("rId2", RT_IMAGE, `../media/image${i}.png`),
        ])
      );
      files[`ppt/media/image${i}.png`] = image;
    } else {
      const page = opts.pages?.[i - 1] ?? { boxes: [], empty: true };
      files[`ppt/slides/slide${i}.xml`] = strToU8(slideXml(opts.slide, page));
      files[`ppt/slides/_rels/slide${i}.xml.rels`] = strToU8(
        relsXml([rel("rId1", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml")])
      );
    }
  }

  return zipSync(files as Zippable, { level: 6 });
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
): P2PptRunOptions {
  const str = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    mode: raw.mode === "images" ? "images" : "text",
    slideSize:
      raw.slideSize === "4-3" || raw.slideSize === "match"
        ? raw.slideSize
        : "16-9",
    pages: str(raw.pages, 200) || "all",
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
 * "My Deck.pdf" → "My-Deck" (spaces collapse to hyphens, path-unsafe
 * chars stripped, Devanagari survives); a nameless file falls back to
 * the localized word. The caller appends ".pptx".
 */
export function outputBaseName(fileName: string, lang: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return base || (lang === "hi" ? "प्रेज़ेंटेशन" : "Presentation");
}
