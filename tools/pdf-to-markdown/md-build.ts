import {
  collectPieces,
  type RawTextItem,
  type TextPiece,
} from "../pdf-to-txt/text-layout";

export type { RawTextItem, TextPiece };

/**
 * PDF → Markdown engine (PRD §8.6) — PURE, bun-testable, iOS-safe
 * (no matchAll/replaceAll, no lookbehind, no Object.hasOwn — the
 * IOS-COMPAT lesson applies to worker code directly).
 *
 * Pipeline (the copy-from-pdf block recipe in PDF space, y up):
 *   pdf.js items → pieces (../pdf-to-txt/text-layout) → visual lines
 *   → segments (paragraphs / list items / heading runs)
 *   → blocks with heading levels from per-document font-size clustering
 *   → Markdown text.
 *
 * Honest limits (documented in the tool FAQ): bold-only or caps-only
 * headings are not detected (font weight is not in the piece model);
 * scanned pages have no text layer at all (the worker reports
 * tool.errorNoText — no OCR here); tables and multi-column layouts
 * degrade to reading order.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One reconstructed visual line (PDF space: y up, points). */
export interface MdLine {
  text: string;
  /** Left edge of the line (bullet-indent detection for wrapped items). */
  x: number;
  /** Baseline anchor of the line. */
  y: number;
  /** Font size of the longest piece (heading detection input). */
  size: number;
}

/** Segment kinds while walking the lines. */
type SegmentKind = "para" | "list" | "heading";

interface MdSegment {
  kind: SegmentKind;
  lines: MdLine[];
  /** List marker of the FIRST line (headings/paras carry none). */
  marker: { type: "bullet" } | { type: "number"; num: string } | null;
}

/** Rendered Markdown block. */
export interface MdBlock {
  kind: "heading" | "bullet" | "numbered" | "para";
  /** Heading level 1-6 (headings only). */
  level?: number;
  /** Source number of an ordered item ("1", "2", …). */
  num?: string;
  text: string;
}

/** Resolved tool options (worker consumes OptionValues). */
export interface MdOutOptions {
  /** Font-size heading detection on/off. */
  headings: boolean;
  /** `---` horizontal rules between pages. */
  pageRules: boolean;
}

/** Per-document heading map: body size + size clusters → levels. */
export interface HeadingContext {
  /** Length-weighted median font size of the document. */
  body: number;
  /** Distinct heading sizes (desc) with their assigned levels (1-6). */
  clusters: { size: number; level: number }[];
}

/* ------------------------------------------------------------------ */
/* Option coercion                                                      */
/* ------------------------------------------------------------------ */

export function resolveMdOutOptions(
  options: Record<string, unknown>
): MdOutOptions {
  return {
    headings: options.headings !== false,
    pageRules: options.pageRules === true,
  };
}

/* ------------------------------------------------------------------ */
/* Pieces → lines                                                       */
/* ------------------------------------------------------------------ */

/**
 * Groups pieces into visual lines (the pdf-to-txt recipe: baseline within
 * half a font height, x-sorted, quarter-font gap spaces) while also
 * tracking the left edge and the longest piece's font size.
 */
export function buildMdLines(pieces: TextPiece[]): MdLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [sorted[0] as TextPiece];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i] as TextPiece;
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * 0.5);
    }
  }
  groups.push(current);

  const lines: MdLine[] = [];
  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let size = ordered[0].size;
    let longest = ordered[0].str.length;
    let text = "";
    let endX: number | null = null;
    for (const piece of ordered) {
      if (piece.str.length > longest) {
        longest = piece.str.length;
        size = piece.size;
      }
      if (
        endX !== null &&
        piece.x - endX > size * 0.25 &&
        !text.endsWith(" ")
      ) {
        text += " ";
      }
      text += piece.str;
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    lines.push({
      text: text.replace(/\s+$/, ""),
      x: ordered[0].x,
      y: group[0].y,
      size,
    });
  }
  return lines;
}

/** Raw pdf.js text items → visual lines in one step. */
export function pageLines(items: RawTextItem[]): MdLine[] {
  return buildMdLines(collectPieces(items));
}

/**
 * Non-whitespace character count of a page's raw items — the honest
 * "is this a scan?" signal (0 → no text layer, the pdf-to-txt recipe).
 */
export function pageCharCount(items: RawTextItem[]): number {
  let count = 0;
  for (const piece of collectPieces(items)) {
    count += piece.str.replace(/\s/g, "").length;
  }
  return count;
}

/**
 * Worker-side scan decision: a file whose selected pages yield ZERO
 * selectable characters is a scan (or image-only export) — map it to
 * the same honest error code the PDF→Text tool uses. No OCR here.
 */
export function mdRunErrorCode(totalChars: number): "tool.errorNoText" | null {
  return totalChars === 0 ? "tool.errorNoText" : null;
}

/* ------------------------------------------------------------------ */
/* Heading context (per-document size clustering)                      */
/* ------------------------------------------------------------------ */

/** Ratio at/below which a line is body text, not a heading candidate. */
const HEADING_RATIO = 1.18;
/** Sizes within this fraction of a bigger size merge into one cluster. */
const CLUSTER_TOL = 0.06;
/** Heading candidate line length cap (long lines are body text). */
const HEADING_MAX_CHARS = 100;

/** Length-weighted median font size (the copy-from-pdf bodySize recipe). */
export function bodyFontSize(lines: MdLine[]): number {
  const weighted: number[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;
    const weight = Math.min(8, text.length);
    for (let i = 0; i < weight; i += 1) weighted.push(line.size);
  }
  if (weighted.length === 0) return 0;
  const sorted = [...weighted].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Conservative level floor for a body-size ratio (h1 needs real size). */
function ratioLevel(ratio: number): number {
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.4) return 2;
  return 3;
}

/**
 * Builds the document-wide heading map. Distinct candidate sizes (font
 * sizes ≥ body × 1.18 on short lines) form clusters, biggest first; each
 * cluster's level is the HIGHER of (previous level + 1, ratio floor),
 * capped at 6 — so the biggest text is `#`, smaller sizes step down, and
 * a document whose biggest text is barely above body stays h3, never a
 * fake h1.
 */
export function buildHeadingContext(pages: MdLine[][]): HeadingContext {
  const all: MdLine[] = [];
  for (const lines of pages) {
    for (const line of lines) all.push(line);
  }
  const body = bodyFontSize(all) || (all.length > 0 ? all[0].size : 11);
  const ctx: HeadingContext = { body, clusters: [] };
  if (body <= 0) return ctx;

  const sizes: number[] = [];
  for (const line of all) {
    if (line.size < body * HEADING_RATIO) continue;
    const trimmed = line.text.trim();
    if (trimmed.length === 0 || trimmed.length > HEADING_MAX_CHARS) continue;
    sizes.push(line.size);
  }
  sizes.sort((a, b) => b - a);

  for (const size of sizes) {
    const last =
      ctx.clusters.length > 0
        ? ctx.clusters[ctx.clusters.length - 1]
        : undefined;
    if (last !== undefined && size >= last.size * (1 - CLUSTER_TOL)) {
      continue; // same cluster as the previous (slightly smaller) size
    }
    const prevLevel = last === undefined ? 0 : last.level;
    const level = Math.min(
      6,
      Math.max(1, Math.max(prevLevel + 1, ratioLevel(size / body)))
    );
    ctx.clusters.push({ size, level });
  }
  return ctx;
}

/** Heading level for a font size, 0 when the size is not a cluster. */
export function headingLevelFor(ctx: HeadingContext, size: number): number {
  for (const cluster of ctx.clusters) {
    if (size >= cluster.size * (1 - CLUSTER_TOL)) return cluster.level;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Line markers                                                          */
/* ------------------------------------------------------------------ */

/** Bullet markers that make a line a Markdown list item. */
export const BULLET_RE = /^[ \t]*[•●○▪‣◦·►»*+\-–—][ \t]+/;
/** Ordered-item markers (kept verbatim in the output). */
export const ORDERED_RE = /^[ \t]*(\d{1,3})[.)][ \t]+/;

/* ------------------------------------------------------------------ */
/* Lines → segments                                                     */
/* ------------------------------------------------------------------ */

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/** Dehyphenation probe: "exam-" + "ple" merges (pdf-to-txt recipe). */
function dehyphenate(buf: string, next: string): boolean {
  return (
    new RegExp(`[${SCRIPT}]-$`).test(buf) &&
    new RegExp("^[a-z\\u0900-\\u097f\\u00df-\\u00ff]").test(next)
  );
}

/** Flow-joins a segment's lines into one string (marker already stripped). */
function joinSegment(texts: string[]): string {
  let buf = "";
  for (const raw of texts) {
    const text = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (text.length === 0) continue;
    if (buf.length === 0) {
      buf = text;
    } else if (dehyphenate(buf, text)) {
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
  }
  return buf;
}

function markerOf(
  line: MdLine,
  body: number
): { type: "bullet" } | { type: "number"; num: string } | null {
  // A heading-sized line ("1. Introduction" in 16pt) is a heading, not
  // a list — size wins over the marker shape.
  if (line.size >= body * HEADING_RATIO) return null;
  const ordered = ORDERED_RE.exec(line.text);
  if (ordered !== null) {
    return { type: "number", num: ordered[1] ?? "1" };
  }
  if (BULLET_RE.test(line.text)) return { type: "bullet" };
  return null;
}

function isHeadingLine(line: MdLine, body: number): boolean {
  const trimmed = line.text.trim();
  return (
    line.size >= body * HEADING_RATIO &&
    trimmed.length > 0 &&
    trimmed.length <= HEADING_MAX_CHARS
  );
}

/**
 * Walks the page's lines top→bottom and cuts segments: every bullet /
 * ordered marker starts a new item, headings start their own (wrapped
 * heading lines merge), paragraph lines join while the baseline gap
 * stays tight and the font size is similar.
 */
export function buildSegments(
  lines: MdLine[],
  body: number,
  detectHeadings: boolean
): MdSegment[] {
  const segments: MdSegment[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  const last = (): MdSegment | null =>
    segments.length > 0 ? segments[segments.length - 1] ?? null : null;

  for (const line of lines) {
    if (line.text.trim().length === 0) continue;

    const marker = markerOf(line, body);
    const heading = detectHeadings && isHeadingLine(line, body);
    const tail = last();
    const gap = prevY === null ? Number.POSITIVE_INFINITY : prevY - line.y;
    const tight = gap <= Math.max(1.5, prevSize * 1.75);

    if (marker !== null) {
      segments.push({ kind: "list", lines: [line], marker });
      prevY = line.y;
      prevSize = line.size;
      continue;
    }

    if (heading) {
      // Wrapped heading: same size band, tight leading → same heading.
      const head = tail === null ? null : tail.lines[0];
      if (
        tail !== null &&
        tail.kind === "heading" &&
        head !== null &&
        tail.lines.length < 3 &&
        Math.abs(head.size - line.size) <= line.size * 0.15 &&
        tight
      ) {
        tail.lines.push(line);
      } else {
        segments.push({ kind: "heading", lines: [line], marker: null });
      }
      prevY = line.y;
      prevSize = line.size;
      continue;
    }

    if (tail !== null && tail.kind === "list" && tight) {
      // Wrapped list item: indented past the marker, similar size band.
      const head = tail.lines[0];
      if (
        head !== undefined &&
        line.x >= head.x + head.size * 0.4 &&
        Math.max(head.size, line.size) /
          Math.min(head.size, line.size) <=
          1.35
      ) {
        tail.lines.push(line);
        prevY = line.y;
        prevSize = line.size;
        continue;
      }
    }

    const head = tail === null ? null : tail.lines[0];
    const continuesPara =
      tail !== null &&
      head !== null &&
      tail.kind === "para" &&
      tail.lines.length < 30 &&
      gap <= prevSize * 1.7 &&
      Math.max(head.size, line.size) / Math.min(head.size, line.size) <= 1.35;

    if (continuesPara && tail !== null) {
      tail.lines.push(line);
    } else {
      segments.push({ kind: "para", lines: [line], marker: null });
    }
    prevY = line.y;
    prevSize = line.size;
  }

  return segments;
}

/* ------------------------------------------------------------------ */
/* Markdown escaping                                                    */
/* ------------------------------------------------------------------ */

/** Chars that must be backslash-escaped anywhere in text. */
const ESCAPE_ANYWHERE = "\\`*_[]<";
/** Chars that only matter at the start of a rendered line. */
const ESCAPE_LINE_START = "#>-+=~";

/**
 * Escapes Markdown syntax characters in extracted text. A char-loop
 * (iOS-safe, no replaceAll): backslash first, so a literal "a\*b" in
 * the PDF becomes "a\\\*b" — which renders back as the original
 * "a\*b". Escapes it did not create are never doubled.
 */
export function escapeMdText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    out += text[i];
    i += 1;
  }
  let first = true;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      out += "\\\\";
    } else if (ESCAPE_ANYWHERE.indexOf(ch) !== -1) {
      out += "\\" + ch;
    } else if (first && ESCAPE_LINE_START.indexOf(ch) !== -1) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    first = false;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Segments → blocks → Markdown                                        */
/* ------------------------------------------------------------------ */

/** Segments → typed Markdown blocks. */
export function buildBlocks(
  segments: MdSegment[],
  ctx: HeadingContext,
  opts: MdOutOptions
): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const segment of segments) {
    const first = segment.lines[0] as MdLine;
    const texts: string[] = [];
    if (segment.marker !== null) {
      let head = first.text;
      head =
        segment.marker.type === "bullet"
          ? head.replace(BULLET_RE, "")
          : head.replace(ORDERED_RE, "");
      texts.push(head);
      for (let i = 1; i < segment.lines.length; i += 1) {
        texts.push((segment.lines[i] as MdLine).text);
      }
    } else {
      for (const line of segment.lines) texts.push(line.text);
    }
    const text = joinSegment(texts);
    if (text.trim().length === 0) continue;

    if (segment.kind === "heading" && opts.headings) {
      const level = headingLevelFor(ctx, first.size);
      if (level >= 1) {
        blocks.push({ kind: "heading", level, text });
        continue;
      }
    }

    if (segment.kind === "list" && segment.marker !== null) {
      if (segment.marker.type === "bullet") {
        blocks.push({ kind: "bullet", text });
      } else {
        blocks.push({ kind: "numbered", num: segment.marker.num, text });
      }
      continue;
    }

    blocks.push({ kind: "para", text });
  }
  return blocks;
}

/** Blocks → Markdown with tight lists and blank-line separation. */
export function blocksToMarkdown(blocks: MdBlock[]): string {
  let out = "";
  let prevKind: MdBlock["kind"] | null = null;
  for (const block of blocks) {
    let rendered: string;
    if (block.kind === "heading") {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      rendered = "######".slice(0, level) + " " + escapeMdText(block.text);
    } else if (block.kind === "bullet") {
      rendered = "- " + escapeMdText(block.text);
    } else if (block.kind === "numbered") {
      rendered = (block.num ?? "1") + ". " + escapeMdText(block.text);
    } else {
      rendered = escapeMdText(block.text);
    }
    if (rendered.trim().length === 0) continue;
    // Same-kind list neighbours stay on consecutive lines (tight list);
    // everything else gets a blank line so paragraphs never glue.
    const tight = prevKind !== null && prevKind === block.kind &&
      (block.kind === "bullet" || block.kind === "numbered");
    if (out.length === 0) {
      out = rendered;
    } else {
      out += tight ? "\n" + rendered : "\n\n" + rendered;
    }
    prevKind = block.kind;
  }
  return out;
}

/** One page's raw items → Markdown (extraction + conversion in one call). */
export function pageMarkdown(
  items: RawTextItem[],
  ctx: HeadingContext,
  opts: MdOutOptions
): string {
  return pageMarkdownFromLines(pageLines(items), ctx, opts);
}

/** One page's lines → Markdown. */
export function pageMarkdownFromLines(
  lines: MdLine[],
  ctx: HeadingContext,
  opts: MdOutOptions
): string {
  const segments = buildSegments(lines, ctx.body, opts.headings);
  const blocks = buildBlocks(segments, ctx, opts);
  return blocksToMarkdown(blocks);
}

/* ------------------------------------------------------------------ */
/* Page joining                                                         */
/* ------------------------------------------------------------------ */

/**
 * Joins per-page Markdown chunks. Empty pages contribute nothing;
 * `pageRules` separates the remaining pages with `---` thematic breaks.
 */
export function joinPages(chunks: string[], pageRules: boolean): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  return parts
    .join(pageRules ? "\n\n---\n\n" : "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
