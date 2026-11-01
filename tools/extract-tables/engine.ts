import type { GridTextItem } from "../pdf-to-excel/model";

/**
 * Extract tables (PHASE-7): find the DISTINCT tables inside a page and
 * hand each one out as a CSV grid.
 *
 * pdf-to-excel reads the WHOLE page as one grid (its job: a workbook
 * per page). This tool SEGMENTS: a page can carry two tables and a
 * paragraph between them — only the tabular runs leave as tables.
 *
 * Pipeline (pure, bun-smokeable — the pdf.js read is worker turf):
 *   1. rowsFromItems — y-band visual rows (the pdf-to-excel recipe:
 *      top-first, tolerance max(1.5, size·0.5)), each row split into
 *      CELLS wherever the x-gap between neighbours exceeds
 *      gapFactor·font-size.
 *   2. tableBlocks — consecutive TABULAR rows (≥2 cells) glue into a
 *      block; a paragraph row, a large vertical gap, or zero shared
 *      column anchors split blocks apart.
 *   3. gridForBlock — cell x-starts chain-merge into column anchors
 *      (8 pt), every row becomes string cells placed by nearest anchor.
 */

/** x-start anchor merge tolerance in pt (pdf-to-excel parity). */
export const ET_COL_TOL = 8;
/** Row y-band tolerance factor (pdf-to-excel ROW_TOL_FACTOR parity). */
export const ET_ROW_TOL_FACTOR = 0.5;
/** A gap between neighbours wider than this × font size splits cells. */
export const ET_WRAP_GAP_FACTOR = 1.6;
/** Vertical gap (× the block's observed row pitch) that separates two stacked tables. */
export const ET_BLOCK_GAP_FACTOR = 2.2;
/** Bootstrap split floor while a block has no pitch history (× font size). */
export const ET_BLOCK_GAP_BOOTSTRAP = 4;
/** Rows a tabular run needs before it counts as a table. */
export const ET_MIN_TABLE_ROWS = 2;
/** Text pieces per page beyond which the page is refused (sanity). */
export const ET_MAX_PIECES = 20_000;

export interface EtOptions {
  /** Cell-split gap factor (default 1.6). */
  gapFactor?: number;
  /** Column anchor merge tolerance in pt (default 8). */
  colTol?: number;
}

export interface RowCell {
  text: string;
  x0: number;
  x1: number;
}

export interface SegRow {
  /** Baseline y (PDF points, y-up). */
  y: number;
  /** Dominant font size of the row (pt). */
  size: number;
  cells: RowCell[];
}

export interface TableBlock {
  /** Visual rows, top of the page first. */
  rows: SegRow[];
  /** Column-anchored string grid (rows × columns). */
  grid: string[][];
}

interface Piece {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

function sanitizePieces(items: GridTextItem[]): Piece[] {
  const out: Piece[] = [];
  for (const item of items) {
    const text = item.str.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    if (
      !Number.isFinite(item.x) || !Number.isFinite(item.y) ||
      !Number.isFinite(item.w) || !Number.isFinite(item.size) ||
      item.size <= 0 || item.size > 400
    ) {
      continue;
    }
    out.push({ text, x: item.x, y: item.y, w: item.w, size: item.size });
  }
  return out;
}

/** Step 1 — visual rows with x-gap cell splitting. */
export function rowsFromItems(
  items: GridTextItem[],
  options: EtOptions = {}
): SegRow[] {
  const gapFactor = options.gapFactor ?? ET_WRAP_GAP_FACTOR;
  const pieces = sanitizePieces(items);
  if (pieces.length === 0) return [];

  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: SegRow[] = [];
  let current: Piece[] = [sorted[0]!];
  let groupY = sorted[0]!.y;
  let groupTol = Math.max(1.5, sorted[0]!.size * ET_ROW_TOL_FACTOR);

  const flush = (): void => {
    if (current.length === 0) return;
    const line = [...current].sort((a, b) => a.x - b.x);
    const size = line.reduce((m, p) => Math.max(m, p.size), 0);
    const cells: RowCell[] = [];
    for (const piece of line) {
      const prev = cells[cells.length - 1];
      if (prev && piece.x - prev.x1 > gapFactor * size) {
        // Wide gap → next column.
        cells.push({ text: piece.text, x0: piece.x, x1: piece.x + piece.w });
      } else if (prev) {
        // Same column (wrapped/spaced pieces) → join with one space.
        prev.text = `${prev.text} ${piece.text}`.trim();
        prev.x1 = Math.max(prev.x1, piece.x + piece.w);
      } else {
        cells.push({ text: piece.text, x0: piece.x, x1: piece.x + piece.w });
      }
    }
    rows.push({ y: groupY, size, cells });
    current = [];
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i]!;
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      flush();
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * ET_ROW_TOL_FACTOR);
    }
  }
  flush();
  return rows;
}

const isTabular = (row: SegRow): boolean => row.cells.length >= 2;

/** Nearest-anchor placement grid for one block (anchors chain-merged). */
export function gridForBlock(
  rows: SegRow[],
  colTol: number = ET_COL_TOL
): string[][] {
  if (rows.length === 0) return [];

  // Column anchors: unique cell x0s, chain-merged within colTol.
  const starts = rows
    .flatMap((row) => row.cells.map((cell) => cell.x0))
    .sort((a, b) => a - b);
  const anchors: number[] = [];
  for (const x of starts) {
    const last = anchors[anchors.length - 1];
    if (last === undefined || x - last > colTol) anchors.push(x);
  }

  const grid: string[][] = [];
  for (const row of rows) {
    const cells = new Array<string>(anchors.length).fill("");
    for (const cell of row.cells) {
      // Anchor whose centre band is nearest this cell's start.
      let best = 0;
      let bestDist = Infinity;
      for (let a = 0; a < anchors.length; a += 1) {
        const dist = Math.abs(anchors[a]! - cell.x0);
        if (dist < bestDist) {
          bestDist = dist;
          best = a;
        }
      }
      cells[best] = cells[best]!.length === 0 ? cell.text : `${cells[best]} ${cell.text}`.trim();
    }
    grid.push(cells);
  }
  return grid;
}

/** Do two rows share at least one column anchor (within colTol)? */
function sharesAnchor(a: SegRow, b: SegRow, colTol: number): boolean {
  for (const ca of a.cells) {
    for (const cb of b.cells) {
      if (Math.abs(ca.x0 - cb.x0) <= colTol) return true;
    }
  }
  return false;
}

/** Step 2+3 — segment rows into table blocks with anchored grids. */
export function extractTables(
  items: GridTextItem[],
  options: EtOptions = {}
): TableBlock[] {
  const colTol = options.colTol ?? ET_COL_TOL;
  const rows = rowsFromItems(items, options);
  if (rows.length === 0) return [];

  const blocks: SegRow[][] = [];
  let current: SegRow[] = [];
  /** Running mean of intra-block row gaps (the block's pitch). */
  let pitchSum = 0;
  let pitchCount = 0;

  const flush = (): void => {
    if (current.length >= ET_MIN_TABLE_ROWS) blocks.push(current);
    current = [];
    pitchSum = 0;
    pitchCount = 0;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!isTabular(row)) {
      flush();
      continue;
    }
    const prev = current[current.length - 1];
    if (prev) {
      const gap = Math.abs(prev.y - row.y);
      const rowH = Math.max(prev.size, row.size);
      // Split rule: a gap far beyond the block's own rhythm means a
      // new table started. While there is no rhythm yet, only a
      // paragraph-sized gap (4× font) splits — airy tables survive.
      const limit =
        pitchCount === 0
          ? ET_BLOCK_GAP_BOOTSTRAP * rowH
          : ET_BLOCK_GAP_FACTOR * (pitchSum / pitchCount);
      if (gap > limit) {
        flush();
      } else if (
        !sharesAnchor(prev, row, colTol) &&
        prev.cells.length !== row.cells.length
      ) {
        // Adjacent tabular rows with nothing in common AND different
        // widths — a different table.
        flush();
      }
      if (current.length > 0) {
        pitchSum += gap;
        pitchCount += 1;
      }
    }
    current.push(row);
  }
  flush();

  return blocks.map((blockRows) => ({
    rows: blockRows,
    grid: gridForBlock(blockRows, colTol),
  }));
}
