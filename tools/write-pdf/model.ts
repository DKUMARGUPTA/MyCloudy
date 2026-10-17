/**
 * Write PDF — PURE document model + pagination engine (PRD §8 "Write PDF":
 * rich text editor with headings, bold/italic/underline, lists, tables,
 * images, page breaks, header/footer, page numbers, Hindi fonts, live page
 * preview, export PDF).
 *
 * The SAME engine lays out pages for BOTH consumers, so the preview is the
 * output (WYSIWYG by construction):
 *   - the surface's live preview: a canvas `measureText` MeasureRun
 *     (Helvetica/Arial, Times New Roman, Courier New are metric-compatible
 *     browser faces for the pdf-lib standard-14 fonts; the self-hosted
 *     Noto Sans Devanagari TTF is registered as a preview FontFace so its
 *     widths are exact), and
 *   - the export worker: real pdf-lib `widthOfTextAtSize` fonts.
 *
 * Text shaping follows the shared txt-to-pdf recipe (blockScript: any
 * non-WinAnsi block renders entirely through the embedded Noto font so
 * mixed Hindi/English paragraphs stay consistent — documented v1 rule).
 * Everything here is pure and headlessly testable (P3.3 lesson).
 */

import {
  BASELINE_RATIO,
  PageFlow,
  blockScript,
  planLineGroup,
  positionRuns,
  wrapRuns,
  type FontSpec,
  type MeasureRun,
  type ScriptFont,
  type WrapRun,
} from "../txt-to-pdf/text-layout";

/* ------------------------------------------------------------------ */
/* Document model (wire format)                                        */
/* ------------------------------------------------------------------ */

export type WFamily = "sans" | "serif" | "mono";
export type WAlign = "left" | "center" | "right";
export type WTextKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "quote";

/** One inline styled fragment. Family/size live on the BLOCK; runs carry
 *  only the Word-style toggles + colour so the wire stays small. */
export interface WRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

interface WBlockBase {
  id: string;
}

export interface WTextBlock extends WBlockBase {
  kind: WTextKind;
  runs: WRun[];
  align: WAlign;
  family: WFamily;
  /** Paragraph size override (pt) — headings keep their preset size. */
  size?: number;
}

export interface WTableBlock extends WBlockBase {
  kind: "table";
  rows: string[][];
  header: boolean;
}

export interface WImageBlock extends WBlockBase {
  kind: "image";
  assetKey: string;
  scale: 0.25 | 0.5 | 0.75 | 1;
  align: WAlign;
}

export interface WHrBlock extends WBlockBase {
  kind: "hr";
}

export interface WBreakBlock extends WBlockBase {
  kind: "pagebreak";
}

export type WBlock =
  | WTextBlock
  | WTableBlock
  | WImageBlock
  | WHrBlock
  | WBreakBlock;

export type WPageSize = "a4" | "letter" | "a5" | "legal";
export type WMargins = "normal" | "narrow" | "wide";
export type WPageNumbers = "none" | "center" | "right";

export interface WSetup {
  pageSize: WPageSize;
  landscape: boolean;
  margins: WMargins;
  headerText: string;
  footerText: string;
  pageNumbers: WPageNumbers;
  pageNumFormat: "n" | "nOfN";
  /** Locale-formatted {date} the surface injects (workers have no locale). */
  dateText: string;
}

export interface WDoc {
  title: string;
  setup: WSetup;
  blocks: WBlock[];
}

/* ------------------------------------------------------------------ */
/* Geometry + style presets                                            */
/* ------------------------------------------------------------------ */

export const W_PAGE_SIZES: Record<WPageSize, { width: number; height: number }> =
  {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
    a5: { width: 419.53, height: 595.28 },
    legal: { width: 612, height: 1008 },
  };

export const W_MARGINS: Record<WMargins, number> = {
  narrow: 36,
  normal: 72,
  wide: 108,
};

export interface WStyle {
  size: number;
  lineH: number;
  before: number;
  after: number;
  bold: boolean;
  italic: boolean;
}

export const W_STYLES: Record<WTextKind, WStyle> = {
  p: { size: 11, lineH: 1.5, before: 4, after: 6, bold: false, italic: false },
  h1: { size: 22, lineH: 1.32, before: 18, after: 8, bold: true, italic: false },
  h2: { size: 17, lineH: 1.35, before: 14, after: 6, bold: true, italic: false },
  h3: { size: 14, lineH: 1.4, before: 12, after: 5, bold: true, italic: false },
  bullet: {
    size: 11,
    lineH: 1.5,
    before: 2,
    after: 2,
    bold: false,
    italic: false,
  },
  numbered: {
    size: 11,
    lineH: 1.5,
    before: 2,
    after: 2,
    bold: false,
    italic: false,
  },
  quote: {
    size: 11,
    lineH: 1.55,
    before: 8,
    after: 8,
    bold: false,
    italic: true,
  },
};

/** Quote indents both sides; the bar sits in the left gutter. */
export const QUOTE_INDENT = 18;
export const QUOTE_BAR_W = 2.5;
export const QUOTE_BAR_GAP = 10;
export const LIST_INDENT = 16;
export const LIST_MARKER_GUTTER = 16;
export const TABLE_FONT_SIZE = 9.5;
export const TABLE_LINE_H = 1.35;
export const TABLE_PAD_H = 5;
export const TABLE_PAD_V = 3;
export const TABLE_COL_MIN = 34;

export const COLOR_TEXT = "#1a1a1f";
export const COLOR_MUTED = "#64748b";
export const COLOR_QUOTE = "#475569";
export const COLOR_BAR = "#94a3b8";
export const COLOR_RULE = "#cbd5e1";
export const COLOR_TABLE_BORDER = "#b6bfcc";
export const COLOR_TABLE_HEADER_BG = "#f1f5f9";

/** Header/footer typography. */
export const HF_SIZE = 9;
export const HF_TOP_BASELINE_OFFSET = 34;
export const HF_BOTTOM_BASELINE = 26;

/* ------------------------------------------------------------------ */
/* Sanitizer (never trust the blob)                                    */
/* ------------------------------------------------------------------ */

const MAX_BLOCKS = 1500;
const MAX_RUNS_PER_BLOCK = 300;
const MAX_TEXT_CHARS = 30_000;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLS = 10;
const MAX_IMAGES = 40;

const PAGE_SIZE_KEYS: readonly WPageSize[] = ["a4", "letter", "a5", "legal"];
const MARGIN_KEYS: readonly WMargins[] = ["normal", "narrow", "wide"];
const PN_KEYS: readonly WPageNumbers[] = ["none", "center", "right"];
const FAMILY_KEYS: readonly WFamily[] = ["sans", "serif", "mono"];
const ALIGN_KEYS: readonly WAlign[] = ["left", "center", "right"];
const TEXT_KIND_KEYS: readonly WTextKind[] = [
  "p",
  "h1",
  "h2",
  "h3",
  "bullet",
  "numbered",
  "quote",
];
const SCALES: readonly number[] = [0.25, 0.5, 0.75, 1];

function one<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    ""
  );
  return cleaned.slice(0, max);
}

/** Valid #rrggbb colour or undefined (model default ink). */
function cleanColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

export interface SanitizeResult {
  doc: WDoc;
  /** Blocks/runs/images silently dropped (the surface never sends garbage —
   *  this is the honest backstop for a corrupted blob). */
  dropped: number;
}

export function sanitizeWDoc(input: unknown): SanitizeResult {
  let dropped = 0;
  const raw = (input ?? {}) as Partial<WDoc>;
  const setupRaw = (raw.setup ?? {}) as Partial<WSetup>;

  const setup: WSetup = {
    pageSize: one(setupRaw.pageSize, PAGE_SIZE_KEYS, "a4"),
    landscape: setupRaw.landscape === true,
    margins: one(setupRaw.margins, MARGIN_KEYS, "normal"),
    headerText: cleanText(setupRaw.headerText, 300),
    footerText: cleanText(setupRaw.footerText, 300),
    pageNumbers: one(setupRaw.pageNumbers, PN_KEYS, "none"),
    pageNumFormat: setupRaw.pageNumFormat === "nOfN" ? "nOfN" : "n",
    dateText: cleanText(setupRaw.dateText, 40),
  };

  const rawBlocks = Array.isArray(raw.blocks)
    ? (raw.blocks.slice(0, MAX_BLOCKS) as unknown[])
    : [];
  const blocks: WBlock[] = [];
  let imageCount = 0;

  for (const item of rawBlocks) {
    const block = (item ?? {}) as Record<string, unknown>;
    const id = cleanText(block.id, 60) || `b${blocks.length + 1}`;
    if (typeof block.kind !== "string") {
      dropped += 1;
      continue;
    }
    if (TEXT_KIND_KEYS.includes(block.kind as WTextKind)) {
      const runsRaw = Array.isArray(block.runs) ? block.runs : [];
      if (runsRaw.length > MAX_RUNS_PER_BLOCK) {
        dropped += runsRaw.length - MAX_RUNS_PER_BLOCK;
      }
      const runs: WRun[] = [];
      let chars = 0;
      for (const runRaw of runsRaw.slice(0, MAX_RUNS_PER_BLOCK)) {
        const run = (runRaw ?? {}) as Partial<WRun>;
        const text = cleanText(run.text, MAX_TEXT_CHARS);
        if (text.length === 0) continue;
        chars += text.length;
        if (chars > MAX_TEXT_CHARS) {
          dropped += 1;
          break;
        }
        runs.push({
          text,
          bold: run.bold === true,
          italic: run.italic === true,
          underline: run.underline === true,
          color: cleanColor(run.color),
        });
      }
      const size =
        block.kind === "p" && typeof block.size === "number"
          ? Math.max(7, Math.min(28, Math.round(block.size)))
          : undefined;
      blocks.push({
        id,
        kind: block.kind as WTextKind,
        runs,
        align: one(block.align, ALIGN_KEYS, "left"),
        family: one(block.family, FAMILY_KEYS, "sans"),
        ...(size !== undefined ? { size } : {}),
      });
      continue;
    }
    if (block.kind === "table") {
      const rowsRaw = Array.isArray(block.rows) ? block.rows : [];
      if (rowsRaw.length > MAX_TABLE_ROWS) {
        dropped += rowsRaw.length - MAX_TABLE_ROWS;
      }
      const rows: string[][] = [];
      let cols = 0;
      for (const rowRaw of rowsRaw.slice(0, MAX_TABLE_ROWS)) {
        const cellsRaw = Array.isArray(rowRaw) ? rowRaw : [];
        cols = Math.max(cols, cellsRaw.length);
        rows.push(
          cellsRaw.slice(0, MAX_TABLE_COLS).map((cell) => cleanText(cell, 2000))
        );
      }
      if (cols > MAX_TABLE_COLS) dropped += cols - MAX_TABLE_COLS;
      cols = Math.min(cols, MAX_TABLE_COLS);
      for (const row of rows) {
        while (row.length < cols) row.push("");
      }
      if (rows.length === 0 || cols === 0) {
        dropped += 1;
        continue;
      }
      blocks.push({
        id,
        kind: "table",
        rows,
        header: block.header !== false,
      });
      continue;
    }
    if (block.kind === "image") {
      if (imageCount >= MAX_IMAGES) {
        dropped += 1;
        continue;
      }
      const assetKey = cleanText(block.assetKey, 60);
      if (assetKey.length === 0) {
        dropped += 1;
        continue;
      }
      imageCount += 1;
      const scale = SCALES.includes(Number(block.scale))
        ? (Number(block.scale) as WImageBlock["scale"])
        : 0.75;
      blocks.push({
        id,
        kind: "image",
        assetKey,
        scale,
        align: one(block.align, ALIGN_KEYS, "center"),
      });
      continue;
    }
    if (block.kind === "hr" || block.kind === "pagebreak") {
      blocks.push({ id, kind: block.kind });
      continue;
    }
    dropped += 1;
  }

  const title = cleanText(raw.title, 120).replace(/\s+/g, " ").trim() || "document";
  return { doc: { title, setup, blocks }, dropped };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function runsText(runs: WRun[]): string {
  let out = "";
  for (const run of runs) out += run.text;
  return out;
}

/** True when any text character forces the Noto upgrade. */
export function docNeedNoto(doc: WDoc): boolean {
  for (const block of doc.blocks) {
    if (block.kind === "table") {
      for (const row of block.rows) {
        for (const cell of row) {
          if (blockScript(cell) === "noto") return true;
        }
      }
      continue;
    }
    if (
      block.kind === "hr" ||
      block.kind === "pagebreak" ||
      block.kind === "image"
    ) {
      continue;
    }
    if (blockScript(runsText(block.runs)) === "noto") return true;
  }
  return (
    blockScript(doc.setup.headerText) === "noto" ||
    blockScript(doc.setup.footerText) === "noto"
  );
}

export function countWords(doc: WDoc): number {
  let words = 0;
  const count = (text: string): void => {
    for (const part of text.split(/\s+/)) {
      if (part.trim().length > 0) words += 1;
    }
  };
  for (const block of doc.blocks) {
    if (block.kind === "table") {
      for (const row of block.rows) for (const cell of row) count(cell);
      continue;
    }
    if (
      block.kind === "hr" ||
      block.kind === "pagebreak" ||
      block.kind === "image"
    ) {
      continue;
    }
    count(runsText(block.runs));
  }
  return words;
}

/** Unique image asset keys in document order (worker pairing contract). */
export function assetOrderOf(doc: WDoc): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const block of doc.blocks) {
    if (block.kind === "image" && !seen.has(block.assetKey)) {
      seen.add(block.assetKey);
      order.push(block.assetKey);
    }
  }
  return order;
}

/** Parses #rrggbb into pdf-lib-friendly 0..1 channels. */
export function parseHexColor(
  hex: string | undefined
): { r: number; g: number; b: number } {
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    };
  }
  return { r: 0.102, g: 0.102, b: 0.118 }; // COLOR_TEXT
}

/** Output filename for a doc title (mirrors outputBaseName hygiene). */
export function wOutputName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
  return `${base}.pdf`;
}

/* ------------------------------------------------------------------ */
/* Laid-out output (worker paints it; preview renders it as DOM)       */
/* ------------------------------------------------------------------ */

/** One absolutely positioned text fragment. */
export interface LPiece {
  text: string;
  x: number;
  baseline: number;
  size: number;
  spec: FontSpec;
  script: ScriptFont;
  color?: string;
  underline?: boolean;
}

/** A stroked line: underlines, the hr rule, table borders. */
export interface LLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  color: string;
}

/** A filled rect: quote bar, table header background. */
export interface LRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** An image placed on a page — index into the asset order. */
export interface LImage {
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
}

export interface WLaidPage {
  pieces: LPiece[];
  lines: LLine[];
  rects: LRect[];
  images: LImage[];
}

export interface WLaidResult {
  pages: WLaidPage[];
  words: number;
  images: number;
}

/* ------------------------------------------------------------------ */
/* The layout engine                                                   */
/* ------------------------------------------------------------------ */

export interface LayoutInput {
  doc: WDoc;
  /** Natural pixel sizes per assetKey (aspect truth); missing → skip. */
  imageSizes: Record<string, { w: number; h: number }>;
  measure: MeasureRun;
}

interface PageBox {
  pageW: number;
  pageH: number;
  margin: number;
  contentW: number;
}

const DEFAULT_SPEC: FontSpec = { family: "sans", bold: false, italic: false };

function blockFontSpec(block: WTextBlock, style: WStyle): FontSpec {
  return {
    family:
      block.family === "mono"
        ? "mono"
        : block.family === "serif"
          ? "serif"
          : "sans",
    bold: style.bold,
    italic: style.italic,
  };
}

function runsToWrapRuns(block: WTextBlock, style: WStyle): WrapRun[] {
  const spec = blockFontSpec(block, style);
  const out: WrapRun[] = [];
  for (const run of block.runs) {
    if (run.text.length === 0) continue;
    out.push({
      text: run.text,
      spec: {
        family: spec.family,
        bold: spec.bold || run.bold === true,
        italic: spec.italic || run.italic === true,
      },
      ...(run.color !== undefined ? { color: run.color } : {}),
      ...(run.underline === true ? { underline: true } : {}),
    });
  }
  return out;
}

/**
 * Lays the whole document out. Blocks walk the shared PageFlow cursor:
 * text blocks wrap via wrapRuns and paginate with orphan/widow protection
 * (planLineGroup); tables place rows atomically (a row taller than a page
 * is placed anyway so layout always terminates); images clamp to the
 * content height; page breaks break pages. Header, footer and page numbers
 * are stamped per page once the count is known ({date}/{page}/{pages}
 * substitution).
 */
export function layoutDoc(input: LayoutInput): WLaidResult {
  const { doc, imageSizes, measure } = input;
  const setup = doc.setup;
  const base = W_PAGE_SIZES[setup.pageSize];
  const pageW = setup.landscape ? base.height : base.width;
  const pageH = setup.landscape ? base.width : base.height;
  const margin = W_MARGINS[setup.margins];
  const box: PageBox = {
    pageW,
    pageH,
    margin,
    contentW: pageW - 2 * margin,
  };

  const pages: WLaidPage[] = [];
  const newPage = (): WLaidPage => {
    const page: WLaidPage = { pieces: [], lines: [], rects: [], images: [] };
    pages.push(page);
    return page;
  };
  newPage();
  const flow = new PageFlow({
    pageW,
    pageH,
    marginLeft: margin,
    marginRight: margin,
    marginTop: margin,
    marginBottom: margin,
  });

  const words = countWords(doc);
  const assetIndex = new Map<string, number>();
  for (const key of assetOrderOf(doc)) assetIndex.set(key, assetIndex.size);
  let imagesPlaced = 0;

  /** Places one wrapped line's runs + underline strokes on a page. */
  const placeLine = (
    page: WLaidPage,
    lineRuns: WrapRun[],
    x: number,
    baseline: number,
    size: number,
    script: ScriptFont,
    fallbackColor?: string
  ): void => {
    let cursorX = x;
    for (const run of lineRuns) {
      const positioned = positionRuns(
        [run],
        cursorX,
        baseline,
        size,
        script,
        measure
      );
      const piece = positioned[0];
      if (piece) {
        page.pieces.push({
          text: piece.text,
          x: piece.x,
          baseline: piece.baseline,
          size: piece.size,
          spec: piece.spec,
          script,
          ...(piece.color !== undefined
            ? { color: piece.color }
            : fallbackColor !== undefined
              ? { color: fallbackColor }
              : {}),
        });
        const w = measure(piece.text, piece.spec, size, script);
        if (run.underline === true) {
          page.lines.push({
            x1: cursorX,
            y1: baseline - size * 0.16,
            x2: cursorX + w,
            y2: baseline - size * 0.16,
            w: Math.max(0.5, size * 0.055),
            color:
              piece.color ??
              fallbackColor ??
              COLOR_TEXT,
          });
        }
        cursorX += w;
      }
    }
  };

  for (let i = 0; i < doc.blocks.length; i += 1) {
    const block = doc.blocks[i];

    if (block.kind === "pagebreak") {
      flow.breakPage();
      if (flow.pageIndex >= pages.length) newPage();
      continue;
    }

    if (block.kind === "hr") {
      flow.consumeGap(10);
      if (flow.spaceLeft < 2 && flow.pageHasContent) {
        flow.breakPage();
        if (flow.pageIndex >= pages.length) newPage();
      }
      const y = flow.contentTopY() - 1;
      pages[flow.pageIndex].lines.push({
        x1: margin,
        y1: y,
        x2: pageW - margin,
        y2: y,
        w: 1,
        color: COLOR_RULE,
      });
      flow.consume(2);
      flow.consumeGap(10);
      continue;
    }

    if (block.kind === "image") {
      const size = imageSizes[block.assetKey];
      if (!size || size.w <= 0 || size.h <= 0) continue;
      const index = assetIndex.get(block.assetKey);
      if (index === undefined) continue;
      let w = box.contentW * block.scale;
      let h = (w * size.h) / size.w;
      if (h > flow.contentHeight) {
        h = flow.contentHeight;
        w = (h * size.w) / size.h;
      }
      flow.consumeGap(8);
      if (!flow.fits(h) && flow.pageHasContent) {
        flow.breakPage();
        if (flow.pageIndex >= pages.length) newPage();
      }
      const top = flow.contentTopY();
      const x =
        block.align === "center"
          ? margin + (box.contentW - w) / 2
          : block.align === "right"
            ? pageW - margin - w
            : margin;
      pages[flow.pageIndex].images.push({ x, y: top - h, w, h, index });
      imagesPlaced += 1;
      flow.consume(h);
      flow.consumeGap(8);
      continue;
    }

    if (block.kind === "table") {
      layoutTable(block, box, flow, pages, newPage, measure);
      continue;
    }

    // ---- text blocks ----
    const style = W_STYLES[block.kind];
    const size =
      block.kind === "p" && block.size !== undefined ? block.size : style.size;
    const advance = size * style.lineH;
    const script = blockScript(runsText(block.runs));
    const wrapList = runsToWrapRuns(block, style);

    // keep-with-next: a heading must not sit alone at a page bottom
    if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
      const next = doc.blocks[i + 1];
      let need = advance + style.after + 8;
      if (
        next &&
        (next.kind === "p" || next.kind === "bullet" || next.kind === "numbered")
      ) {
        const nextStyle = W_STYLES[next.kind];
        need += 2 * nextStyle.size * nextStyle.lineH;
      }
      if (flow.pageHasContent && !flow.fits(need)) {
        flow.breakPage();
        if (flow.pageIndex >= pages.length) newPage();
      }
    }

    const isQuote = block.kind === "quote";
    const isList = block.kind === "bullet" || block.kind === "numbered";
    const listLeft = margin + LIST_INDENT + LIST_MARKER_GUTTER;
    const wrapW =
      box.contentW -
      (isQuote ? QUOTE_INDENT * 2 : isList ? LIST_INDENT + LIST_MARKER_GUTTER : 0);
    const lines = wrapRuns(wrapList, {
      maxWidth: Math.max(40, wrapW),
      size,
      script,
      measure,
    });
    // An empty paragraph still consumes one line (honest blank line).
    const lineCount = Math.max(1, lines.length);

    flow.consumeGap(style.before);

    const textX = isQuote ? margin + QUOTE_INDENT : isList ? listLeft : margin;
    const fallbackColor = isQuote ? COLOR_QUOTE : undefined;

    const startXFor = (lineIndex: number): number => {
      if (block.align === "left" || isQuote || isList) return textX;
      const line = lines[Math.min(lineIndex, lines.length - 1)] ?? [];
      const lineWidth = line.reduce(
        (sum, run) => sum + measure(run.text, run.spec, size, script),
        0
      );
      if (block.align === "center") {
        const left = isQuote ? textX : margin;
        const width = isQuote ? wrapW : box.contentW;
        return left + (width - lineWidth) / 2;
      }
      const right = isQuote ? textX + wrapW : pageW - margin;
      return right - lineWidth;
    };

    const markerFor = (): LPiece | null => {
      if (block.kind === "bullet") {
        return {
          text: "•",
          x: margin + LIST_INDENT,
          baseline: 0,
          size,
          spec: DEFAULT_SPEC,
          script: "std",
        };
      }
      if (block.kind === "numbered") {
        let n = 1;
        for (let j = i - 1; j >= 0; j -= 1) {
          const prev = doc.blocks[j];
          if (prev.kind === "numbered") n += 1;
          else break;
        }
        const text = `${n}.`;
        const w = measure(text, DEFAULT_SPEC, size, "std");
        return {
          text,
          x: margin + LIST_INDENT + LIST_MARKER_GUTTER - 4 - w,
          baseline: 0,
          size,
          spec: DEFAULT_SPEC,
          script: "std",
        };
      }
      return null;
    };
    const marker = markerFor();

    const placements = planLineGroup(flow, lineCount, advance, size);
    for (let li = 0; li < lineCount; li += 1) {
      const placement = placements[li];
      const page = pages[placement.pageIndex] ?? newPage();
      const lineRuns = lines[li] ?? [];
      placeLine(
        page,
        lineRuns,
        startXFor(li),
        placement.baseline,
        size,
        script,
        fallbackColor
      );
      if (li === 0 && marker) {
        page.pieces.push({ ...marker, baseline: placement.baseline });
      }
    }

    // quote bar: per page fragment, from the fragment's first line top to
    // its last line's baseline + descent (pdf y-up coords)
    if (isQuote && placements.length > 0) {
      const byPage = new Map<number, typeof placements>();
      for (const placement of placements) {
        const list = byPage.get(placement.pageIndex) ?? [];
        list.push(placement);
        byPage.set(placement.pageIndex, list);
      }
      for (const [pageIndex, list] of byPage) {
        const firstTop = list[0].top;
        const lastBottom = list[list.length - 1].top + advance;
        const topYPdf = pageH - margin - firstTop;
        const bottomYPdf = pageH - margin - lastBottom;
        pages[pageIndex].rects.push({
          x: margin + QUOTE_BAR_GAP,
          y: bottomYPdf,
          w: QUOTE_BAR_W,
          h: Math.max(2, topYPdf - bottomYPdf),
          color: COLOR_BAR,
        });
      }
    }

    flow.consumeGap(style.after);
  }

  // ---- header / footer / page numbers ----
  const total = pages.length;
  const substitute = (text: string, page: number): string =>
    text
      .replace(/\{date\}/g, setup.dateText)
      .replace(/\{page\}/g, String(page + 1))
      .replace(/\{pages\}/g, String(total));

  for (let p = 0; p < total; p += 1) {
    const page = pages[p];
    const headerText = substitute(setup.headerText, p);
    if (headerText.trim().length > 0) {
      page.pieces.push({
        text: headerText.slice(0, 220),
        x: margin,
        baseline: pageH - HF_TOP_BASELINE_OFFSET,
        size: HF_SIZE,
        spec: DEFAULT_SPEC,
        script: blockScript(headerText),
        color: COLOR_MUTED,
      });
    }
    const footerText = substitute(setup.footerText, p);
    if (footerText.trim().length > 0) {
      page.pieces.push({
        text: footerText.slice(0, 220),
        x: margin,
        baseline: HF_BOTTOM_BASELINE,
        size: HF_SIZE,
        spec: DEFAULT_SPEC,
        script: blockScript(footerText),
        color: COLOR_MUTED,
      });
    }
    if (setup.pageNumbers !== "none") {
      const text =
        setup.pageNumFormat === "nOfN" ? `${p + 1} / ${total}` : `${p + 1}`;
      const w = measure(text, DEFAULT_SPEC, HF_SIZE, "std");
      const x =
        setup.pageNumbers === "center"
          ? margin + (box.contentW - w) / 2
          : pageW - margin - w;
      page.pieces.push({
        text,
        x,
        baseline: HF_BOTTOM_BASELINE,
        size: HF_SIZE,
        spec: DEFAULT_SPEC,
        script: "std",
        color: COLOR_MUTED,
      });
    }
  }

  return { pages, words, images: imagesPlaced };
}

/* ------------------------------------------------------------------ */
/* Table layout                                                        */
/* ------------------------------------------------------------------ */

function layoutTable(
  block: WTableBlock,
  box: PageBox,
  flow: PageFlow,
  pages: WLaidPage[],
  newPage: () => WLaidPage,
  measure: MeasureRun
): void {
  const rows = block.rows;
  const cols = Math.max(...rows.map((row) => row.length));
  if (rows.length === 0 || cols === 0) return;

  flow.consumeGap(8);

  // column widths: max single-line content width per column (clamped),
  // then proportionally squeezed into the content box when overwide
  const scriptOf = (text: string): ScriptFont => blockScript(text);
  const colMax = new Array<number>(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < cols; c += 1) {
      const cell = row[c] ?? "";
      const w = measure(
        longestLine(cell),
        DEFAULT_SPEC,
        TABLE_FONT_SIZE,
        scriptOf(cell)
      );
      colMax[c] = Math.max(
        colMax[c],
        Math.min(w + 2 * TABLE_PAD_H, box.contentW)
      );
    }
  }
  const widths = colMax.map((w) => Math.max(w, TABLE_COL_MIN));
  let total = widths.reduce((sum, w) => sum + w, 0);
  if (total > box.contentW) {
    const minTotal = TABLE_COL_MIN * cols;
    const scale = (box.contentW - minTotal) / (total - minTotal);
    for (let c = 0; c < cols; c += 1) {
      widths[c] = TABLE_COL_MIN + (widths[c] - TABLE_COL_MIN) * scale;
    }
    total = box.contentW;
  }
  const xFor = (c: number): number => {
    let x = box.margin;
    for (let k = 0; k < c; k += 1) x += widths[k];
    return x;
  };

  const advance = TABLE_FONT_SIZE * TABLE_LINE_H;

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const cellLines: WrapRun[][][] = [];
    let maxLines = 1;
    for (let c = 0; c < cols; c += 1) {
      const cell = row[c] ?? "";
      const script = scriptOf(cell);
      const spec: FontSpec = {
        family: "sans",
        bold: block.header && r === 0,
        italic: false,
      };
      const lines = wrapRuns(
        cell.length === 0 ? [] : [{ text: cell, spec }],
        {
          maxWidth: Math.max(20, widths[c] - 2 * TABLE_PAD_H),
          size: TABLE_FONT_SIZE,
          script,
          measure,
        }
      );
      cellLines.push(lines);
      maxLines = Math.max(maxLines, lines.length);
    }
    const rowH = maxLines * advance + 2 * TABLE_PAD_V;

    let freshPage = false;
    if (!flow.fits(rowH) && flow.pageHasContent) {
      flow.breakPage();
      if (flow.pageIndex >= pages.length) newPage();
      freshPage = true;
    }
    const page = pages[flow.pageIndex];
    const top = flow.contentTopY();

    if (block.header && r === 0) {
      page.rects.push({
        x: xFor(0),
        y: top - rowH,
        w: total,
        h: rowH,
        color: COLOR_TABLE_HEADER_BG,
      });
    }

    // top border only for the first row / the first row after a page
    // break (rows below draw their own bottom border — no duplicates)
    if (r === 0 || freshPage) {
      page.lines.push({
        x1: xFor(0),
        y1: top,
        x2: xFor(0) + total,
        y2: top,
        w: 0.75,
        color: COLOR_TABLE_BORDER,
      });
    }
    page.lines.push({
      x1: xFor(0),
      y1: top - rowH,
      x2: xFor(0) + total,
      y2: top - rowH,
      w: 0.75,
      color: COLOR_TABLE_BORDER,
    });
    for (let c = 0; c <= cols; c += 1) {
      const x = c === cols ? xFor(cols - 1) + widths[cols - 1] : xFor(c);
      page.lines.push({
        x1: x,
        y1: top,
        x2: x,
        y2: top - rowH,
        w: 0.75,
        color: COLOR_TABLE_BORDER,
      });
    }

    for (let c = 0; c < cols; c += 1) {
      const lines = cellLines[c];
      const script = scriptOf(row[c] ?? "");
      const x = xFor(c) + TABLE_PAD_H;
      for (let li = 0; li < lines.length; li += 1) {
        const baseline =
          top - TABLE_PAD_V - li * advance - TABLE_FONT_SIZE * BASELINE_RATIO;
        let cursorX = x;
        for (const run of lines[li]) {
          const w = measure(run.text, run.spec, TABLE_FONT_SIZE, script);
          page.pieces.push({
            text: run.text,
            x: cursorX,
            baseline,
            size: TABLE_FONT_SIZE,
            spec: run.spec,
            script,
          });
          cursorX += w;
        }
      }
    }

    flow.consume(rowH);
  }
  flow.consumeGap(8);
}

function longestLine(cell: string): string {
  let best = "";
  for (const line of cell.split(/\n/)) {
    if (line.length > best.length) best = line;
  }
  return best;
}
