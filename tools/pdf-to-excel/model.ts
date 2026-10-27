import { zipSync, strToU8, type Zippable } from "@/lib/own/zip";

/**
 * PDF → Excel model (RB1-d — the 70th tool). PURE TypeScript: no pdfjs,
 * no DOM, no imports beyond our own ZIP engine — the smoke script drives
 * every export headless in bun.
 *
 * Two extractors, both honest rule-based geometry:
 *   A. extractRuledGrid (P5 "table rebuild") — pages that DRAW their
 *      table hand their operator-list line/rect geometry to a lattice
 *      reader; cells are exact (see the ruled-table lattice block).
 *   B. extractGrid — text items cluster into y-bands and chain-merged
 *      x-starts (the classic fallback):
 *   1. rows    — text items cluster into y-bands (baseline within half a
 *                font height, the pdf-to-txt recipe);
 *   2. columns — unique x-starts are chain-merged within a tolerance
 *                (8 pt) into column anchors, then anchors that never
 *                share a row merge too (right-aligned numeric columns
 *                get one logical column instead of one per value width);
 *   3. cells   — items assigned to (row, column); wide gaps inside a
 *                cell insert a space (pdf.js emits per-Tj pieces without
 *                carrying spaces);
 *   4. wraps   — a tightly-spaced line whose columns are a PROPER subset
 *                of the row above joins those cells (wrapped cell text
 *                becomes one cell); equal sets never merge, so dense
 *                tables and plain text pages stay row-per-line.
 *
 * Limits (clamped in buildXlsx): 20 sheets, 500 rows, 60 columns.
 */

/* ------------------------------ limits ------------------------------ */

export const MAX_SHEETS = 20;
export const MAX_ROWS_PER_SHEET = 500;
export const MAX_COLS_PER_SHEET = 60;

/** Adjacent x-starts closer than this (pt) share one column anchor. */
export const COL_MERGE_TOL = 8;
/** A continuation line within this factor of the font size joins the cell above. */
export const WRAP_GAP_FACTOR = 1.6;

/** Baseline tolerance for one visual row (× font size, min 1.5pt). */
const ROW_TOL_FACTOR = 0.5;
/** Horizontal gap inside a cell (× font size) that inserts a space. */
const CELL_SPACE_FACTOR = 0.25;

/* ------------------------------- types ------------------------------- */

/** One positioned text piece — pdf.js text item reduced to geometry.
 *  x/y are the PDF-space baseline start (y grows UP the page). */
export interface GridTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

export interface GridExtractOptions {
  /** x-start cluster tolerance in pt (default 8). */
  colTol?: number;
  /** wrap-join gap factor (default 1.6). */
  wrapGapFactor?: number;
}

/** Coerce pdf.js `getTextContent().items` into grid items (pure, defensive). */
export function gridItemsFromRaw(items: Iterable<unknown>): GridTextItem[] {
  const out: GridTextItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const str = (raw as { str?: unknown }).str;
    if (typeof str !== "string" || str.trim().length === 0) continue;
    const transform = (raw as { transform?: unknown }).transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const w = Number((raw as { width?: unknown }).width) || 0;
    out.push({ str, x, y, w, size: size > 0 ? size : 10 });
  }
  return out;
}

/* --------------------------- column helpers -------------------------- */

/* Devanagari visual→logical repair. pdf.js concatenates per-glyph
 * ToUnicode in stream order, and shaping puts the three PRE-base
 * matras (ि े ै) BEFORE their base cluster — so text drawn from shaped
 * glyph streams (pdf-lib/Noto, many cheap generators) extracts with
 * "िप्रया" instead of "प्रिया". The inverse move is only applied where
 * it is PROVABLY visual: the matra starts the run, or follows anything
 * that can never end a logical syllable (space, vowel, another sign,
 * virama, Latin…). After a plain CONSONANT the reading is ambiguous
 * ("म ि स् त" could be logical "मेस्त" or visual "नमस्ते" mid-word) and
 * is left untouched — OCR-style logical text is never damaged. */

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

/**
 * 1-based column index → spreadsheet reference letters: 1→A, 26→Z,
 * 27→AA, 702→ZZ, 16384→XFD. Returns "" for out-of-range input.
 */
export function colName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 16384) return "";
  let name = "";
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** XML-escape text and drop XML-1.0-invalid control characters. */
export function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Pure numbers ("42", "-3.5", "+7", "0.5") become Excel numeric cells;
 * anything else — leading zeros ("007" codes), thousands separators,
 * percentages, mixed text — stays text, honestly.
 */
const NUMERIC_RE = /^[+-]?(0|[1-9]\d*)(\.\d+)?$/;

export function numericValue(text: string): number | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 15) return null;
  if (!NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Excel sheet names: ≤31 chars, no []:*?/\, no leading/trailing
 *  apostrophe; duplicates get a numeric suffix (case-insensitive). */
export function sanitizeSheetName(
  raw: string,
  used: Set<string> = new Set()
): string {
  let name = raw
    .replace(/[\\/:*?[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "");
  if (name.length === 0) name = "Sheet";
  name = name.slice(0, 31);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* --------------------------- shared sanitize -------------------------- */

/** Clean GridTextItems into sortable pieces (shared by both extractors). */
function sanitizePieces(items: GridTextItem[]): Piece[] {
  const pieces: Piece[] = [];
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    const str = item.str.replace(/\s+/g, " ").trim();
    if (str.length === 0) continue;
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = Number.isFinite(Number(item?.w)) ? Math.max(0, Number(item.w)) : 0;
    const sizeRaw = Number(item?.size);
    pieces.push({ str, x, y, w, size: sizeRaw > 0 ? sizeRaw : 10 });
  }
  return pieces;
}

/* ----------------------------- extractGrid ---------------------------- */

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/** A column anchor plus the x-range of everything merged into it. */
interface ColumnCluster {
  lo: number;
  hi: number;
  anchor: number;
}

/** A fully assembled visual row (before wrap-joining). */
interface GridRowRaw {
  y: number;
  size: number;
  cols: number[];
  cells: string[];
  hasText: boolean[];
}

/**
 * The core: cluster text items into rows (y-bands) and columns (x
 * clusters with a gap threshold), producing a rectangular grid. See the
 * header comment for the exact rules and their honest limits.
 */
export function extractGrid(
  items: GridTextItem[],
  options: GridExtractOptions = {}
): string[][] {
  const colTol = options.colTol ?? COL_MERGE_TOL;
  const wrapGapFactor = options.wrapGapFactor ?? WRAP_GAP_FACTOR;

  /* -- sanitize: collapse whitespace, drop empty/insane geometry -- */
  const pieces = sanitizePieces(items);
  if (pieces.length === 0) return [];

  /* -- 1. visual rows: y-bands, top of the page first (PDF y is up) -- */
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Piece[][] = [];
  let current: Piece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * ROW_TOL_FACTOR);
  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * ROW_TOL_FACTOR);
    }
  }
  groups.push(current);

  /* -- 2. column anchors: unique x-starts, chain-merged within colTol -- */
  const xs = [...new Set(pieces.map((p) => p.x))].sort((a, b) => a - b);
  const clusters: ColumnCluster[] = [];
  let lo = xs[0];
  let hi = xs[0];
  for (let i = 1; i <= xs.length; i += 1) {
    if (i < xs.length && xs[i] - hi < colTol) {
      hi = xs[i];
      continue;
    }
    clusters.push({ lo, hi, anchor: (lo + hi) / 2 });
    if (i < xs.length) {
      lo = xs[i];
      hi = xs[i];
    }
  }

  /* -- 2b. co-occurrence refinement: adjacent anchors that never share
   *    a row are ONE logical column (right-aligned numbers, centered
   *    headers over ragged value widths). Iterate to a fixpoint. -- */
  function clusterOf(x: number): number {
    let idx = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      if (clusters[i].lo <= x) idx = i;
      else break;
    }
    return idx;
  }
  for (;;) {
    const sets = groups.map(
      (group) => new Set(group.map((piece) => clusterOf(piece.x)))
    );
    let mergedPair = false;
    for (let i = 0; i + 1 < clusters.length && !mergedPair; i += 1) {
      const coOccurs = sets.some((set) => set.has(i) && set.has(i + 1));
      if (!coOccurs) {
        const a = clusters[i];
        const b = clusters[i + 1];
        clusters.splice(i, 2, {
          lo: a.lo,
          hi: b.hi,
          anchor: (a.anchor + b.anchor) / 2,
        });
        mergedPair = true;
      }
    }
    if (!mergedPair) break;
  }
  const columnCount = clusters.length;

  /* -- 3. assemble rows: assign pieces to (row, column), join cell
   *    pieces with a space wherever the horizontal gap exceeds a
   *    quarter of the font size (the pdf-to-txt rule) -- */
  const rowsRaw: GridRowRaw[] = groups.map((group) => {
    const byX = [...group].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    const hasText: boolean[] = [];
    const ends: number[] = [];
    let rowSize = 10;
    for (const piece of byX) {
      rowSize = Math.max(rowSize, piece.size);
      const col = clusterOf(piece.x);
      const end = ends[col];
      let text = cells[col] ?? "";
      if (text.length > 0 && piece.x - end > rowSize * CELL_SPACE_FACTOR) {
        text += " ";
      }
      cells[col] = text + piece.str;
      hasText[col] = true;
      ends[col] = Math.max(end ?? 0, piece.x + piece.w);
    }
    return {
      y: group[0].y,
      size: rowSize,
      cols: hasText.reduce<number[]>((list, has, i) => {
        if (has) list.push(i);
        return list;
      }, []),
      cells,
      hasText,
    };
  });

  /* -- 4. wrapped continuations: a tight line (gap ≤ wrapGapFactor ×
   *    size) whose columns are a PROPER subset of the open row above
   *    joins those cells. Equal sets never merge (dense table rows and
   *    plain text pages stay one row per line). -- */
  interface OpenRow extends GridRowRaw {
    lastY: number;
    union: Set<number>;
  }
  const merged: OpenRow[] = [];
  for (const row of rowsRaw) {
    const open = merged[merged.length - 1];
    if (open) {
      const gap = open.lastY - row.y;
      const tight =
        gap >= 0 && gap <= wrapGapFactor * Math.max(open.size, row.size);
      const properSubset =
        row.cols.length < open.union.size &&
        row.cols.every((c) => open.union.has(c));
      if (tight && properSubset) {
        for (const col of row.cols) {
          open.cells[col] = open.cells[col]
            ? `${open.cells[col]} ${row.cells[col]}`
            : row.cells[col];
        }
        for (const col of row.cols) open.union.add(col);
        open.lastY = row.y;
        continue;
      }
    }
    merged.push({ ...row, lastY: row.y, union: new Set(row.cols) });
  }

  /* -- 5. rectangular output: pad every row to the column count and
   *    repair visual-ordered Devanagari matras in each finished cell -- */
  return merged.map((row) =>
    Array.from({ length: columnCount }, (_, i) =>
      row.hasText[i]
        ? fixDevanagariVisual((row.cells[i] ?? "").trim())
        : ""
    )
  );
}

/* ------------------------- ruled-table lattice ------------------------ */

/**
 * P5 "table rebuild": when a page DRAWS its table (real rule lines —
 * invoices, statements, bank PDFs), the exact grid is read from those
 * borders instead of guessing columns from text alignment. The operator
 * list (pdf.js `getOperatorList`) is parsed into axis-aligned segments
 * with a save/restore/transform CTM tracker, clustered into a lattice,
 * and text items are dropped into the exact cells. Pages without ruling
 * (or an incoherent lattice) fall back to extractGrid — the probe and
 * the worker always use the same order, so the preview is the output.
 *
 * Honest limits: one dominant lattice per page is supported; multiple
 * bordered structures on one page usually fail the occupancy check and
 * fall back; text that spills outside the ruled region is re-clustered
 * as plain rows above/below the table.
 */

/** The pdf.js OPS codes this parser understands (injected, never imported). */
export interface LatticeOps {
  constructPath: number;
  save: number;
  restore: number;
  transform: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
}

/** Horizontal segment (y = its level, x1 < x2 after ordering). */
export interface HSegment {
  y: number;
  x1: number;
  x2: number;
}

/** Vertical segment (x = its level, y1 < y2 after ordering). */
export interface VSegment {
  x: number;
  y1: number;
  y2: number;
}

export interface AxisSegments {
  h: HSegment[];
  v: VSegment[];
}

/** Two coordinates off a curve op (consumed, ignored). */
const CURVE_COORDS: Record<string, number> = {
  curveTo: 6,
  curveTo2: 4,
  curveTo3: 4,
};

/** Affine matrix [a b c d e f] as pdf.js writes them. */
type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m × n (apply m AFTER n: device = m × n × point). */
function mulMat(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Axis-alignment tolerance for one segment after CTM mapping (pt). */
const AXIS_TOL = 1;

/**
 * Parse one page's pdf.js operator list into axis-aligned segments in
 * PDF user space. constructPath args = [pathOps, coords, minMax?]; the
 * coords are UNTRANSFORMED (the canvas CTM applies at replay time), so
 * save/restore/transform ops are tracked and applied here to land in
 * the same space as getTextContent items. Curves are consumed but never
 * contribute segments (table rules are straight); rectangles contribute
 * their four edges (filled rule-bars are the classic border form).
 */
export function axisSegmentsFromOperatorList(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: LatticeOps
): AxisSegments {
  const out: AxisSegments = { h: [], v: [] };
  const stack: Mat[] = [];
  let ctm: Mat = [...IDENTITY];

  const addSeg = (ax: number, ay: number, bx: number, by: number): void => {
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
    if (!Number.isFinite(bx) || !Number.isFinite(by)) return;
    if (Math.abs(ay - by) <= AXIS_TOL && Math.abs(ax - bx) > 0) {
      out.h.push({
        y: (ay + by) / 2,
        x1: Math.min(ax, bx),
        x2: Math.max(ax, bx),
      });
    } else if (Math.abs(ax - bx) <= AXIS_TOL && Math.abs(ay - by) > 0) {
      out.v.push({
        x: (ax + bx) / 2,
        y1: Math.min(ay, by),
        y2: Math.max(ay, by),
      });
    }
  };

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    if (fn === ops.save) {
      stack.push([...ctm] as Mat);
      continue;
    }
    if (fn === ops.restore) {
      const popped = stack.pop();
      if (popped) ctm = popped;
      continue;
    }
    if (fn === ops.transform) {
      const a = argsArray[i] as ArrayLike<number> | undefined;
      if (a && a.length >= 6) {
        const m: Mat = [
          Number(a[0]) || 0,
          Number(a[1]) || 0,
          Number(a[2]) || 0,
          Number(a[3]) || 0,
          Number(a[4]) || 0,
          Number(a[5]) || 0,
        ];
        ctm = mulMat(m, ctm);
      }
      continue;
    }
    if (fn !== ops.constructPath) continue;

    const args = argsArray[i];
    if (!Array.isArray(args)) continue;
    const pathOps = args[0] as ArrayLike<number> | undefined;
    const coords = args[1] as ArrayLike<number> | undefined;
    if (!pathOps || !coords) continue;

    let ci = 0;
    let curX = 0;
    let curY = 0;
    let hasCur = false;
    let startX = 0;
    let startY = 0;
    const applyCtm = (x: number, y: number): [number, number] => [
      ctm[0] * x + ctm[2] * y + ctm[4],
      ctm[1] * x + ctm[3] * y + ctm[5],
    ];

    for (let p = 0; p < pathOps.length; p += 1) {
      const op = pathOps[p];
      if (op === ops.moveTo) {
        const [x, y] = applyCtm(coords[ci] as number, coords[ci + 1] as number);
        ci += 2;
        curX = x;
        curY = y;
        startX = x;
        startY = y;
        hasCur = true;
      } else if (op === ops.lineTo) {
        const [x, y] = applyCtm(coords[ci] as number, coords[ci + 1] as number);
        ci += 2;
        if (hasCur) addSeg(curX, curY, x, y);
        curX = x;
        curY = y;
        hasCur = true;
      } else if (op === ops.rectangle) {
        const rx = coords[ci] as number;
        const ry = coords[ci + 1] as number;
        const rw = coords[ci + 2] as number;
        const rh = coords[ci + 3] as number;
        ci += 4;
        const [x1, y1] = applyCtm(rx, ry);
        const [x2, y2] = applyCtm(rx + rw, ry + rh);
        addSeg(x1, y1, x2, y1);
        addSeg(x1, y2, x2, y2);
        addSeg(x1, y1, x1, y2);
        addSeg(x2, y1, x2, y2);
        hasCur = false;
      } else if (op === ops.closePath) {
        if (hasCur) addSeg(curX, curY, startX, startY);
        hasCur = false;
      } else if (
        op === ops.curveTo ||
        op === ops.curveTo2 ||
        op === ops.curveTo3
      ) {
        ci +=
          op === ops.curveTo
            ? CURVE_COORDS.curveTo
            : op === ops.curveTo2
              ? CURVE_COORDS.curveTo2
              : CURVE_COORDS.curveTo3;
        hasCur = false;
      }
    }
  }
  return out;
}

/** Cluster tolerance for joining near-equal rule levels (pt). Hairline
 *  rule-bars drawn as thin rectangles land 0.5–1 pt apart — real row
 *  spacing never comes that close (≥ font size + padding). */
const RULE_CLUSTER_TOL = 2.5;

/** A cluster of near-equal rule levels with its union extent. */
interface RuleCluster {
  level: number;
  lo: number;
  hi: number;
}

function clusterLevels(
  values: number[],
  extents: Array<[number, number]>
): RuleCluster[] {
  const order = values
    .map((level, i) => ({ level, i }))
    .sort((a, b) => a.level - b.level);
  const clusters: RuleCluster[] = [];
  let acc: number[] = [];
  let accExt: Array<[number, number]> = [];
  const flush = (): void => {
    if (acc.length === 0) return;
    const level = acc.reduce((s, v) => s + v, 0) / acc.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [a, b] of accExt) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    clusters.push({ level, lo, hi });
    acc = [];
    accExt = [];
  };
  for (const { level, i } of order) {
    const last = acc[acc.length - 1];
    if (last === undefined || Math.abs(level - last) <= RULE_CLUSTER_TOL) {
      acc.push(level);
      accExt.push(extents[i] as [number, number]);
    } else {
      flush();
      acc = [level];
      accExt = [extents[i] as [number, number]];
    }
  }
  flush();
  return clusters;
}

/** Minimum h/v cluster counts for a lattice (2 row-bands × 2 col-bands). */
const MIN_RULES = 3;
/** A column/row rule must span this share of the lattice's other axis. */
const SPAN_SHARE = 0.6;
/** Row/column bands must be this occupied to keep the lattice honest. */
const ROW_OCCUPANCY = 0.6;
const COL_OCCUPANCY = 0.5;

/** One ruled table cell's pieces before joining. */
interface CellPieces {
  y: number;
  x: number;
  w: number;
  size: number;
  str: string;
}

/**
 * Build the exact grid from a ruled lattice. Returns null when the page
 * does not carry a coherent ruled table (too few rules, rules that do
 * not span, or bands too empty — multiple boxes on one page usually
 * fail here and fall back to position clustering, honestly).
 */
export function extractRuledGrid(
  items: GridTextItem[],
  segs: AxisSegments
): string[][] | null {
  if (segs.h.length === 0 || segs.v.length === 0) return null;

  const pieces = sanitizePieces(items);
  if (pieces.length === 0) return null;

  /* cluster rules into levels (h: top-first, v: left-first) */
  const hAll = clusterLevels(
    segs.h.map((s) => s.y),
    segs.h.map((s): [number, number] => [s.x1, s.x2])
  ).sort((a, b) => b.level - a.level);
  const vAll = clusterLevels(
    segs.v.map((s) => s.x),
    segs.v.map((s): [number, number] => [s.y1, s.y2])
  ).sort((a, b) => a.level - b.level);
  if (hAll.length < MIN_RULES || vAll.length < MIN_RULES) return null;

  /* lattice bbox + span filter (a rule must cross most of the table) */
  const xL = vAll[0].level;
  const xR = vAll[vAll.length - 1].level;
  const yTop = hAll[0].level;
  const yBot = hAll[hAll.length - 1].level;
  const tableW = xR - xL;
  const tableH = yTop - yBot;
  if (tableW <= 0 || tableH <= 0) return null;

  const hRules = hAll.filter((c) => c.hi - c.lo >= SPAN_SHARE * tableW);
  const vRules = vAll.filter((c) => c.hi - c.lo >= SPAN_SHARE * tableH);
  if (hRules.length < MIN_RULES || vRules.length < MIN_RULES) return null;
  const hY = hRules.map((c) => c.level);
  const vX = vRules.map((c) => c.level);
  const rowBands = hY.length - 1;
  const colBands = vX.length - 1;

  /* assign pieces to cells (rows: baseline sits in its band — a baseline
   * ON a rule belongs to the row above it, glyphs grow up from it) */
  const cells: CellPieces[][][] = Array.from({ length: rowBands }, () =>
    Array.from({ length: colBands }, () => [] as CellPieces[])
  );
  const outPieces: Piece[] = [];
  for (const piece of pieces) {
    const cx = piece.x + piece.w / 2;
    let row = -1;
    for (let i = 0; i + 1 < hY.length && row < 0; i += 1) {
      if (hY[i] >= piece.y && piece.y >= hY[i + 1]) row = i;
    }
    let col = -1;
    for (let j = 0; j + 1 < vX.length && col < 0; j += 1) {
      if (vX[j] <= cx && cx <= vX[j + 1]) col = j;
    }
    if (row < 0 || col < 0) {
      outPieces.push(piece);
    } else {
      cells[row][col].push(piece);
    }
  }

  /* text height bands (for wrapped-line joining inside a cell) */
  const rowHasText = cells.map(
    (row) => row.some((cell) => cell.length > 0)
  );
  const colHasText = Array.from({ length: colBands }, (_, j) =>
    cells.some((row) => row[j].length > 0)
  );

  /* edge-prune empty bands (background rectangles wider/taller than the
   * table add phantom edge bands; real leading/trailing empty rows-cols
   * are vanishingly rare, inner ones always survive) */
  let r0 = 0;
  let r1 = rowBands;
  let c0 = 0;
  let c1 = colBands;
  while (r1 - r0 > 2 && !rowHasText[r0]) r0 += 1;
  while (r1 - r0 > 2 && !rowHasText[r1 - 1]) r1 -= 1;
  while (c1 - c0 > 2 && !colHasText[c0]) c0 += 1;
  while (c1 - c0 > 2 && !colHasText[c1 - 1]) c1 -= 1;

  const rowsTotal = r1 - r0;
  const colsTotal = c1 - c0;
  if (rowsTotal < 2 || colsTotal < 2) return null;

  /* occupancy: a lattice where most bands are empty is not one table
   * (two boxes on a page) — fall back instead of shipping a ragged union */
  const rowsFilled = rowHasText.slice(r0, r1).filter(Boolean).length;
  const colsFilled = colHasText.slice(c0, c1).filter(Boolean).length;
  if (rowsFilled / rowsTotal < ROW_OCCUPANCY) return null;
  if (colsFilled / colsTotal < COL_OCCUPANCY) return null;

  /* cell text: pieces sorted top-line-first then x; same-line gaps use
   * the pdf-to-txt space rule, a new line always inserts a space */
  const joinCell = (cell: CellPieces[]): string => {
    const sorted = [...cell].sort(
      (a, b) => b.y - a.y || a.x - b.x
    );
    let text = "";
    let lastEnd = 0;
    let lastY: number | null = null;
    for (const piece of sorted) {
      const size = piece.size > 0 ? piece.size : 10;
      const newLine =
        lastY !== null && Math.abs(piece.y - lastY) > Math.max(1.5, size * ROW_TOL_FACTOR);
      const gap =
        lastY !== null && !newLine && piece.x - lastEnd > size * CELL_SPACE_FACTOR;
      if (text.length > 0 && (newLine || gap)) text += " ";
      text += piece.str;
      lastEnd = piece.x + piece.w;
      lastY = piece.y;
    }
    return fixDevanagariVisual(text.trim());
  };

  const grid: string[][] = [];
  /* out-of-table text above the ruled region, in reading order */
  const above = outPieces.filter((p) => p.y > hY[0]);
  const below = outPieces.filter((p) => p.y <= hY[0]);
  if (above.length > 0) grid.push(...extractGrid(above));
  for (let i = r0; i < r1; i += 1) {
    grid.push(
      Array.from({ length: colsTotal }, (_, k) =>
        joinCell(cells[i][c0 + k] as CellPieces[])
      )
    );
  }
  if (below.length > 0) grid.push(...extractGrid(below));
  return grid;
}

/* ------------------------------ buildXlsx ----------------------------- */

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface XlsxBuildOptions {
  /** Pure numbers become numeric cells (default true). */
  numericCells?: boolean;
  /** Row 1 of each sheet renders bold (default true). */
  boldHeader?: boolean;
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** One worksheet body — inline strings + explicit t="n" numeric cells. */
function sheetXml(
  rows: string[][],
  options: { numeric: boolean; bold: boolean }
): string {
  const parts: string[] = [
    XML_DECL,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    let rowOpen = false;
    for (let c = 0; c < row.length; c += 1) {
      const text = row[c];
      if (text.length === 0) continue;
      if (!rowOpen) {
        parts.push(`<row r="${r + 1}">`);
        rowOpen = true;
      }
      const ref = `${colName(c + 1)}${r + 1}`;
      const style = options.bold && r === 0 ? ` s="1"` : "";
      const number = options.numeric ? numericValue(text) : null;
      if (number !== null) {
        parts.push(`<c r="${ref}"${style} t="n"><v>${number}</v></c>`);
      } else {
        parts.push(
          `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
        );
      }
    }
    if (rowOpen) parts.push("</row>");
  }
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

/**
 * Build a minimal but VALID .xlsx (Office Open XML) package with our own
 * ZIP engine: [Content_Types].xml, _rels/.rels, xl/workbook.xml + its
 * rels, xl/styles.xml (default + bold named style) and one worksheet
 * per sheet. Everything is clamped to the limits above.
 */
export function buildXlsx(
  sheets: XlsxSheet[],
  options: XlsxBuildOptions = {}
): Uint8Array {
  const numeric = options.numericCells !== false;
  const bold = options.boldHeader !== false;

  const used = new Set<string>();
  const clamped = sheets
    .slice(0, MAX_SHEETS)
    .map((sheet) => ({
      name: sanitizeSheetName(sheet.name, used),
      rows: sheet.rows
        .slice(0, MAX_ROWS_PER_SHEET)
        .map((row) => row.slice(0, MAX_COLS_PER_SHEET)),
    }));
  if (clamped.length === 0) {
    clamped.push({ name: sanitizeSheetName("Sheet", used), rows: [] });
  }

  /* [Content_Types].xml */
  const ctParts = [
    XML_DECL,
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ];
  clamped.forEach((_, i) => {
    ctParts.push(
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  });
  ctParts.push("</Types>");

  /* _rels/.rels */
  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  /* xl/workbook.xml */
  const wbParts = [
    XML_DECL,
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
  ];
  clamped.forEach((sheet, i) => {
    wbParts.push(
      `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    );
  });
  wbParts.push("</sheets></workbook>");

  /* xl/_rels/workbook.xml.rels */
  const wbRelsParts = [
    XML_DECL,
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  ];
  clamped.forEach((_, i) => {
    wbRelsParts.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    );
  });
  wbRelsParts.push(
    `<Relationship Id="rId${clamped.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"
  );

  /* xl/styles.xml — Calibri 11 default + a bold style (xf 1) */
  const styles =
    XML_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(ctParts.join("")),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(wbParts.join("")),
    "xl/_rels/workbook.xml.rels": strToU8(wbRelsParts.join("")),
    "xl/styles.xml": strToU8(styles),
  };
  clamped.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      sheetXml(sheet.rows, { numeric, bold })
    );
  });

  return zipSync(files as Zippable, { level: 6 });
}

/* ------------------------------- run parse ---------------------------- */

export interface ExcelRunLabels {
  /** Output-name suffix ("spreadsheet" / "स्प्रेडशीट"). */
  fileWord: string;
  /** Per-page sheet prefix ("Page" / "पेज"). */
  pageWord: string;
  /** Fallback sheet title ("Sheet" / "शीट"). */
  sheetWord: string;
}

export interface ExcelRun {
  sheetMode: "single" | "perPage";
  numericCells: boolean;
  boldHeader: boolean;
  /** Read exact grids from drawn border lines when present (default). */
  ruled: boolean;
  locale: "en" | "hi";
  labels: ExcelRunLabels;
}

/**
 * Boundary coercion for the serialized `excel` option: a tampered or
 * stale payload can never reach the builder as a wrong type, an
 * oversized label or an unknown mode. Unreadable JSON → defaults.
 */
export function parseRun(raw: string): ExcelRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = (typeof parsed === "object" && parsed !== null
    ? parsed
    : {}) as Record<string, unknown>;
  const labelsIn = (typeof o.labels === "object" && o.labels !== null
    ? o.labels
    : {}) as Record<string, unknown>;
  const label = (value: unknown, max: number): string =>
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    sheetMode: o.sheetMode === "perPage" ? "perPage" : "single",
    numericCells: o.numericCells !== false,
    boldHeader: o.boldHeader !== false,
    ruled: o.ruled !== false,
    locale: o.locale === "hi" ? "hi" : "en",
    labels: {
      fileWord: label(labelsIn.fileWord, 40),
      pageWord: label(labelsIn.pageWord, 16) || "Page",
      sheetWord: label(labelsIn.sheetWord, 16) || "Sheet",
    },
  };
}

/* ------------------------------- naming ------------------------------- */

/** "Annual report.pdf" → "Annual-report" (unicode-safe, path-free). */
export function excelBaseName(fileName: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base;
}

/** Output name: base + localized "-spreadsheet" suffix + .xlsx. */
export function buildOutputName(base: string, fileWord: string): string {
  const parts = [base.trim(), fileWord.trim()]
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 60));
  const joined = parts.join("-").slice(0, 100);
  return `${joined || "spreadsheet"}.xlsx`;
}
