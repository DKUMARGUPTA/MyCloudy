/**
 * PDF text-layout helpers shared by pdf-to-txt and the OCR tools
 * (copy-from-pdf). Pure functions over pdf.js `getTextContent` items —
 * no DOM, Node-testable.
 *
 * Two layouts (PRD §8.6):
 *  - "flow":  lines merged into paragraphs (gap heuristics + dehyphenation)
 *  - "lines": one output line per visual line on the page
 */

export interface TextPiece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

export interface TextLine {
  text: string;
  y: number;
  size: number;
}

export interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/** Collects the page's text pieces, filtered and position-tagged. */
export function collectPieces(items: RawTextItem[]): TextPiece[] {
  const pieces: TextPiece[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Font height (vertical scale of the text matrix) drives every spacing
    // tolerance below — one number adapts the heuristics to any font size.
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const w = Number(item.width) || 0;
    pieces.push({ str: item.str, x, y, w, size: size > 0 ? size : 10 });
  }
  return pieces;
}

/**
 * Groups pieces into visual lines: same line while the baseline stays within
 * half a font height (absorbs sub/superscripts and rounding). Inside a line
 * a space is inserted wherever the horizontal gap exceeds a quarter font —
 * pdf.js emits separate items per Tj operator without carrying spaces.
 */
export function buildLines(pieces: TextPiece[]): TextLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
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

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const size = group[0].size;
    let text = "";
    let endX: number | null = null;
    for (const piece of ordered) {
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
    return { text: text.replace(/\s+$/, ""), y: group[0].y, size };
  });
}

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/**
 * Flow layout: joins lines into paragraphs. A baseline gap noticeably larger
 * than one line height starts a new paragraph; hyphenated line endings merge
 * with the next line (the hyphen is dropped only before a lowercase letter,
 * so a genuine "e-Mail" at line end stays intact before a capital).
 */
export function joinFlow(lines: TextLine[]): string {
  const paragraphs: string[] = [];
  let buf = "";
  let prevY: number | null = null;
  let prevSize = 10;

  for (const line of lines) {
    const text = line.text;
    if (text.length === 0) continue;

    if (buf.length === 0) {
      buf = text;
    } else if (prevY !== null && prevY - line.y > prevSize * 1.7) {
      // Clear vertical gap → paragraph break.
      paragraphs.push(buf);
      buf = text;
    } else if (
      new RegExp(`[${SCRIPT}]-$`).test(buf) &&
      new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]").test(text)
    ) {
      // Dehyphenate: "exam-" + "ple" → "example".
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
    prevY = line.y;
    prevSize = line.size;
  }
  if (buf.length > 0) paragraphs.push(buf);

  return paragraphs.join("\n\n");
}

/** Lines layout: every visual line verbatim, one per row. */
export function joinLines(lines: TextLine[]): string {
  return lines
    .filter((line) => line.text.length > 0)
    .map((line) => line.text)
    .join("\n");
}

export type TextLayoutMode = "flow" | "lines";

/** Page text in the requested layout. */
export function pageText(items: RawTextItem[], layout: TextLayoutMode): string {
  const lines = buildLines(collectPieces(items));
  return layout === "lines" ? joinLines(lines) : joinFlow(lines);
}

/**
 * Number of non-whitespace characters on the page — the "is this page a
 * scan?" signal (0 → no selectable text at all).
 */
export function pageCharCount(items: RawTextItem[]): number {
  let count = 0;
  for (const piece of collectPieces(items)) {
    count += piece.str.replace(/\s/g, "").length;
  }
  return count;
}
