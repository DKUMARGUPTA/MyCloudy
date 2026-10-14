/**
 * Copy from PDF — pure block engine (no pdf.js imports, bun-testable).
 *
 * Everything works in DISPLAY space: y grows downward, x rightward, units
 * are points at viewport scale 1 (the pdf.js `convertToViewportPoint`
 * output). One consistent space lets the surface overlay, the worker
 * extraction and the smoke test share every function below.
 *
 * Pipeline (PRD §7.1 "Copy from PDF"):
 *   pieces → visual lines (baseline grouping) → paragraph blocks
 *   blocks → plain text / Markdown / CSV for the clipboard.
 *
 * Honest scope: rotated pages and multi-column layouts degrade to
 * reading order — the goal is clean copy-paste, not a layout engine.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One positioned text run on the page (display space, y down). */
export interface DisplayPiece {
  str: string;
  /** Left edge of the run. */
  x: number;
  /** Baseline-ish y of the run (min piece y of the line it starts). */
  y: number;
  /** Right edge of the run. */
  xEnd: number;
  /** Font size (hypot of the text-matrix scale). */
  size: number;
}

/** A gap-separated cell inside a line — the CSV column candidate. */
export interface LineCell {
  text: string;
  x: number;
  xEnd: number;
}

/** One visual line (display space). */
export interface DisplayLine {
  text: string;
  x: number;
  xEnd: number;
  y: number;
  size: number;
  cells: LineCell[];
}

export type BlockKind = "heading" | "bullet" | "para";

/** A clickable, paragraph-sized chunk of the page. */
export interface TextBlock {
  id: string;
  kind: BlockKind;
  /** 0-based page index (CSV row grouping + selection order). */
  page: number;
  lines: DisplayLine[];
  /** Flow-joined text (dehyphenated). */
  text: string;
  /** Display-space bbox (overlay position). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** First line's font size — heading detection input. */
  size: number;
}

/* ------------------------------------------------------------------ */
/* Pieces → lines                                                      */
/* ------------------------------------------------------------------ */

/** Gap (fraction of font size) that splits CSV cells in a line. */
const CELL_GAP = 1.4;
/** Gap that inserts a plain space inside a cell. */
const SPACE_GAP = 0.25;
/** Column gap: a horizontal gap this wide splits the LINE itself, so
 *  side-by-side columns stay separately selectable; CSV rebuilds table
 *  rows by grouping the pieces that share a baseline again. */
const COLUMN_GAP = 3;

/**
 * Groups pieces into visual lines: same line while the y stays within
 * half a font height (absorbs sub/superscripts and rounding). Inside a
 * line a space is inserted where the horizontal gap exceeds a quarter
 * font; a gap beyond CELL_GAP fonts starts a new CSV cell; a gap beyond
 * COLUMN_GAP fonts is a column break — the line itself splits there so
 * two-column layouts never glue together.
 */
export function buildLines(pieces: DisplayPiece[]): DisplayLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x);

  const groups: DisplayPiece[][] = [];
  let current: DisplayPiece[] = [sorted[0]];
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

  const lines: DisplayLine[] = [];
  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const size = group[0].size;
    const cells: LineCell[] = [];
    let cellText = "";
    let cellX = ordered[0].x;
    let cellEnd = ordered[0].x;
    let endX: number | null = null;

    const flushCell = (): void => {
      cells.push({
        text: cellText.replace(/\s+$/, ""),
        x: cellX,
        xEnd: cellEnd,
      });
      cellText = "";
    };

    for (const piece of ordered) {
      if (endX !== null && piece.x > endX) {
        const gap = piece.x - endX;
        if (gap > size * CELL_GAP) {
          flushCell();
          cellX = piece.x;
        } else if (gap > size * SPACE_GAP && !cellText.endsWith(" ")) {
          cellText += " ";
        }
      }
      cellText += piece.str;
      cellEnd = Math.max(cellEnd, piece.x + (piece.xEnd - piece.x));
      endX = Math.max(endX ?? 0, piece.xEnd);
    }
    flushCell();

    // Column breaks: cell runs separated by a COLUMN_GAP split into
    // separate lines that share the baseline (y). Reading order stays
    // top→bottom, left→right; CSV re-groups them into table rows.
    let run: LineCell[] = [];
    let runY = group[0].y;
    const emit = (): void => {
      if (run.length === 0) return;
      const text = run
        .map((cell) => cell.text)
        .join("  ")
        .replace(/\s+$/, "");
      lines.push({
        text,
        x: run[0].x,
        xEnd: run[run.length - 1].xEnd,
        y: runY,
        size,
        cells: run,
      });
      run = [];
    };
    for (const cell of cells) {
      if (run.length > 0 && cell.x - run[run.length - 1].xEnd > size * COLUMN_GAP) {
        emit();
      }
      run.push(cell);
    }
    emit();
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Lines → blocks                                                      */
/* ------------------------------------------------------------------ */

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/** Bullet markers that turn a block into a Markdown list item. */
const BULLET_RE = /^[\s]*[•●○▪‣◦·▪►»*+\-–—]\s+/;

/** Length-weighted median font size of a page (the "body" size). */
export function bodySize(lines: DisplayLine[]): number {
  const weighted = lines
    .filter((line) => line.text.trim().length > 0)
    .flatMap((line) => new Array(Math.min(8, line.text.length)).fill(line.size) as number[]);
  if (weighted.length === 0) return 0;
  const sorted = [...weighted].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function overlapFrac(a: DisplayLine, b: DisplayLine): number {
  const minW = Math.min(a.xEnd - a.x, b.xEnd - b.x);
  if (minW <= 0) return 0;
  const inter = Math.min(a.xEnd, b.xEnd) - Math.max(a.x, b.x);
  return Math.max(0, inter) / minW;
}

/**
 * Joins lines into paragraph blocks with a STREAMING open-block pass
 * (reading order, newest-first matching):
 *
 *  - a line continues the newest open block it fits — same column
 *    (≥ 25% horizontal overlap with the block's last line), tight
 *    leading (≤ 1.75 line heights) and a similar font size (± 35%);
 *  - bullet lines always start their own block (one list item = one
 *    selectable block); a wrapped bullet continuation is accepted only
 *    when indented past the bullet marker;
 *  - two-column pages keep one open block per column — side-by-side
 *    text never merges, and columns read left→right.
 */
export function buildBlocks(
  lines: DisplayLine[],
  prefix = "b",
  page = 0
): TextBlock[] {
  const usable = lines.filter((line) => line.text.trim().length > 0);
  if (usable.length === 0) return [];
  const body = bodySize(usable) || usable[0].size;

  const canJoin = (buf: DisplayLine[], line: DisplayLine): boolean => {
    const prev = buf[buf.length - 1];
    const gap = line.y - prev.y;
    if (
      !(
        gap >= -Math.max(1.5, prev.size * 0.6) &&
        gap <= prev.size * 1.75
      )
    ) {
      return false;
    }
    const sizeRatio =
      prev.size > 0
        ? Math.max(line.size, prev.size) / Math.min(line.size, prev.size)
        : 1;
    if (sizeRatio > 1.35) return false;
    if (overlapFrac(prev, line) < 0.25) return false;
    if (BULLET_RE.test(buf[0].text)) {
      // Wrapped bullet continuation: indented to the bullet's text.
      return line.x >= buf[0].x + prev.size * 0.4;
    }
    return true;
  };

  const open: DisplayLine[][] = [];
  for (const line of usable) {
    if (BULLET_RE.test(line.text)) {
      open.push([line]);
      continue;
    }
    let joined = false;
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (canJoin(open[i], line)) {
        open[i].push(line);
        joined = true;
        break;
      }
    }
    if (!joined) open.push([line]);
  }

  return open.map((lines, i) => makeBlock(lines, body, `${prefix}${i}`, page));
}

function makeBlock(
  lines: DisplayLine[],
  body: number,
  id: string,
  page: number
): TextBlock {
  const x = Math.min(...lines.map((line) => line.x));
  const xEnd = Math.max(...lines.map((line) => line.xEnd));
  const yTop = Math.min(...lines.map((line) => line.y));
  const yBottom = Math.max(...lines.map((line) => line.y)) + lines[0].size;
  const size = lines[0].size;
  const text = joinFlowLines(lines);
  const kind: BlockKind =
    lines.length <= 2 && size >= body * 1.22 && text.length <= 90 && !BULLET_RE.test(text)
      ? "heading"
      : BULLET_RE.test(text)
        ? "bullet"
        : "para";
  return {
    id,
    kind,
    page,
    lines,
    text,
    x,
    y: yTop,
    w: xEnd - x,
    h: Math.max(yBottom - yTop, size * 1.2),
    size,
  };
}

/**
 * Flow-joins a line run into one paragraph string: hyphenated endings
 * merge with the next line (the hyphen drops only before a lowercase
 * letter, so a genuine "e-Mail" survives), everything else space-joins.
 */
export function joinFlowLines(lines: DisplayLine[]): string {
  let buf = "";
  for (const line of lines) {
    const text = line.text;
    if (text.length === 0) continue;
    if (buf.length === 0) {
      buf = text;
    } else if (
      new RegExp(`[${SCRIPT}]-$`).test(buf) &&
      new RegExp(`^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]`).test(text)
    ) {
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
  }
  return buf;
}

/**
 * Page-level flow join: lines merged into paragraphs, a clear vertical
 * gap (> 1.7 line heights) starting a new paragraph. Used by the worker
 * for plain-text output (the pdf-to-txt recipe, display-space).
 */
export function linesToFlowText(lines: DisplayLine[]): string {
  const paragraphs: string[] = [];
  let buf = "";
  let prevY: number | null = null;
  let prevSize = 10;

  for (const line of lines) {
    if (line.text.length === 0) continue;
    if (buf.length === 0) {
      buf = line.text;
    } else if (prevY !== null && line.y - prevY > prevSize * 1.7) {
      paragraphs.push(buf);
      buf = line.text;
    } else if (
      new RegExp(`[${SCRIPT}]-$`).test(buf) &&
      new RegExp(`^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]`).test(line.text)
    ) {
      buf = buf.slice(0, -1) + line.text;
    } else {
      buf += " " + line.text;
    }
    prevY = line.y;
    prevSize = line.size;
  }
  if (buf.length > 0) paragraphs.push(buf);
  return paragraphs.join("\n\n");
}

/** Lines layout: every visual line verbatim, one per row. */
export function linesToVerbatim(lines: DisplayLine[]): string {
  return lines
    .filter((line) => line.text.length > 0)
    .map((line) => line.text)
    .join("\n");
}

/**
 * Plain OCR text (tesseract) → synthetic lines so the same flow/markdown
 * pipeline can run over recognized pages. Vertical rhythm is synthetic
 * — consecutive lines sit a tight 14pt apart (they merge into one
 * paragraph block), a blank OCR line adds a paragraph gap.
 */
export function textToLines(text: string): DisplayLine[] {
  const out: DisplayLine[] = [];
  let y = 0;
  let pendingBlank = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.length === 0) {
      pendingBlank = true;
      y += 14;
      continue;
    }
    if (pendingBlank) y += 16; // blank → paragraph gap (> 1.75 × 10pt)
    pendingBlank = false;
    out.push({
      text: trimmed,
      x: 0,
      xEnd: Math.max(1, trimmed.length * 5),
      y,
      size: 10,
      cells: [{ text: trimmed, x: 0, xEnd: Math.max(1, trimmed.length * 5) }],
    });
    y += 14;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Blocks → clipboard formats                                          */
/* ------------------------------------------------------------------ */

/** Plain text: paragraphs joined with blank lines. */
export function blocksToText(blocks: TextBlock[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Markdown: headings, bullets and paragraphs. */
export function blocksToMarkdown(blocks: TextBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      const ratio = block.size;
      // Level by absolute size (12–17pt → h3, 18–23 → h2, bigger → h1).
      const level = ratio >= 23 ? "# " : ratio >= 18 ? "## " : "### ";
      parts.push(level + block.text);
    } else if (block.kind === "bullet") {
      parts.push("- " + block.text.replace(BULLET_RE, ""));
    } else {
      parts.push(block.text);
    }
  }
  return parts.filter((text) => text.length > 0).join("\n\n");
}

/** RFC 4180 cell escaping. */
function csvCell(text: string): string {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * CSV: every visual line of the selection becomes a row; wide gaps
 * inside a line (> CELL_GAP fonts) split into columns, and lines that
 * share a page + baseline (a table row that column breaks split apart)
 * re-merge into one row, cells ordered left→right. Aligned text such
 * as tables lands in columns; prose stays one column.
 */
export function blocksToCsv(blocks: TextBlock[]): string {
  interface Row {
    page: number;
    y: number;
    cells: LineCell[];
  }
  const rows: Row[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      if (line.text.trim().length === 0) continue;
      const hit = rows.find(
        (row) => row.page === block.page && Math.abs(row.y - line.y) <= 1
      );
      if (hit) {
        hit.cells.push(...line.cells);
      } else {
        rows.push({ page: block.page, y: line.y, cells: [...line.cells] });
      }
    }
  }
  rows.sort((a, b) => a.page - b.page || a.y - b.y);
  return rows
    .map((row) => {
      const ordered = [...row.cells].sort((c1, c2) => c1.x - c2.x);
      return ordered.map((cell) => csvCell(cell.text)).join(",");
    })
    .join("\r\n");
}

export type CopyFormat = "text" | "markdown" | "csv";

export function selectionToOutput(
  blocks: TextBlock[],
  format: CopyFormat
): string {
  if (format === "markdown") return blocksToMarkdown(blocks);
  if (format === "csv") return blocksToCsv(blocks);
  return blocksToText(blocks);
}

/** Non-whitespace character count (honest "is anything here" probe). */
export function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/* ------------------------------------------------------------------ */
/* Raw pdf.js items → display pieces                                   */
/* ------------------------------------------------------------------ */

/** The pdf.js viewport surface the harvester needs (scale 1). */
export interface PageViewportLike {
  width: number;
  height: number;
  /** pdf.js PageViewport.transform — [a, b, c, d, e, f] matrix. */
  transform: number[];
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

/** Applies a pdf.js viewport transform (the Util.applyTransform math). */
function applyTransform(
  t: number[],
  x: number,
  y: number
): { x: number; y: number } {
  return {
    x: t[0] * x + t[2] * y + t[4],
    y: t[1] * x + t[3] * y + t[5],
  };
}

/**
 * Raw pdf.js text items → display-space pieces. The run's two corners
 * go through the viewport transform matrix, so /Rotate and crop offsets
 * are applied by pdf.js itself — main thread and worker share this.
 * (pdf.js `convertToViewportPoint` returns a bare ARRAY, so the matrix
 * is applied directly — fully typed, no runtime shape guessing.)
 */
export function harvestPieces(
  viewport: PageViewportLike,
  items: unknown[]
): DisplayPiece[] {
  const pieces: DisplayPiece[] = [];
  for (const rawItem of items) {
    const raw = rawItem as RawTextItem;
    if (typeof raw.str !== "string" || raw.str.length === 0) continue;
    const tr = raw.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;
    const x0 = Number(tr[4]);
    const y0 = Number(tr[5]);
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;

    const width = typeof raw.width === "number" ? raw.width : 0;
    const height =
      typeof raw.height === "number" && Math.abs(raw.height) > 0
        ? Math.abs(raw.height)
        : Math.abs(Number(tr[3])) || 10;
    const size = Math.hypot(Number(tr[1]) || 0, Number(tr[3]) || 0);

    const start = applyTransform(viewport.transform, x0, y0);
    const end = applyTransform(viewport.transform, x0 + width, y0 - height);
    const x = Math.min(start.x, end.x);
    const xEnd = Math.max(start.x, end.x);

    pieces.push({
      str: raw.str,
      x,
      y: start.y,
      xEnd,
      size: size > 0 ? size : 10,
    });
  }
  return pieces;
}
