import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Combine to a single page (PHASE-1 Batch A): place EVERY selected page
 * of a PDF onto ONE output sheet in a grid — the whole document as a
 * single "contact sheet" page. The inverse of N-up's many-sheets output:
 * the result is always exactly one page.
 *
 * Pure placement math (no engine imports) — the same planning pattern as
 * tools/pages-per-sheet/engine.ts, smoke-testable without a Worker.
 */

export const CSP_IDS = {
  paper: "paper",
  orientation: "orientation",
  columns: "columns",
  margin: "margin",
  gap: "gap",
  pages: "pages",
} as const;

export type CspPaper = "a4" | "letter" | "legal" | "match";
export type CspOrientation = "auto" | "portrait" | "landscape";

/** Auto-columns sentinel (schema uses 0 = auto). */
export const CSP_AUTO_COLUMNS = 0;

/** Millimetres → points. */
export const MM_TO_PT = 72 / 25.4;

export const Csp_PAPERS: Record<Exclude<CspPaper, "match">, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
  legal: { w: 612, h: 1008 },
};

export const CSP_MM_MIN = 0;
export const CSP_MM_MAX = 30;
export const CSP_COLUMNS_MIN = 1;
export const CSP_COLUMNS_MAX = 12;

export interface CspOptions {
  paper: CspPaper;
  orientation: CspOrientation;
  columns: number;
  marginMm: number;
  gapMm: number;
  pages: string;
}

export const CSP_DEFAULTS: CspOptions = {
  paper: "a4",
  orientation: "auto",
  columns: CSP_AUTO_COLUMNS,
  marginMm: 6,
  gapMm: 4,
  pages: "all",
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveCspOptions(values: OptionValues): CspOptions {
  const paperRaw = values[CSP_IDS.paper];
  const orientRaw = values[CSP_IDS.orientation];
  const colsRaw = Number(values[CSP_IDS.columns]);
  const marginRaw = Number(values[CSP_IDS.margin]);
  const gapRaw = Number(values[CSP_IDS.gap]);
  return {
    paper:
      paperRaw === "letter" || paperRaw === "legal" || paperRaw === "match"
        ? paperRaw
        : "a4",
    orientation:
      orientRaw === "portrait" || orientRaw === "landscape"
        ? orientRaw
        : "auto",
    columns:
      Number.isFinite(colsRaw) && colsRaw >= CSP_COLUMNS_MIN
        ? Math.floor(clamp(colsRaw, CSP_COLUMNS_MIN, CSP_COLUMNS_MAX))
        : CSP_AUTO_COLUMNS,
    marginMm: clamp(
      Number.isFinite(marginRaw) ? marginRaw : CSP_DEFAULTS.marginMm,
      CSP_MM_MIN,
      CSP_MM_MAX
    ),
    gapMm: clamp(
      Number.isFinite(gapRaw) ? gapRaw : CSP_DEFAULTS.gapMm,
      CSP_MM_MIN,
      CSP_MM_MAX
    ),
    pages:
      typeof values[CSP_IDS.pages] === "string"
        ? (values[CSP_IDS.pages] as string)
        : CSP_DEFAULTS.pages,
  };
}

/** One cell placement on the sheet (points, origin bottom-left). */
export interface CspCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CspSheetPlan {
  width: number;
  height: number;
  cells: CspCell[];
  columns: number;
  rows: number;
}

/**
 * Plan the single sheet: auto columns (square-ish grid), paper size,
 * orientation (auto picks the shape that wastes less area), margins and
 * gaps. `pageCount` is the number of selected pages to place.
 */
export function planSheet(
  pageCount: number,
  opts: CspOptions,
  firstPageSize: { w: number; h: number } | null
): CspSheetPlan {
  const count = Math.max(1, pageCount);
  const columns =
    opts.columns === CSP_AUTO_COLUMNS
      ? Math.max(1, Math.ceil(Math.sqrt(count)))
      : opts.columns;
  const rows = Math.max(1, Math.ceil(count / columns));

  let baseW: number;
  let baseH: number;
  if (opts.paper === "match") {
    if (firstPageSize && firstPageSize.w > 0 && firstPageSize.h > 0) {
      baseW = firstPageSize.w;
      baseH = firstPageSize.h;
    } else {
      baseW = Csp_PAPERS.a4.w;
      baseH = Csp_PAPERS.a4.h;
    }
  } else {
    baseW = Csp_PAPERS[opts.paper].w;
    baseH = Csp_PAPERS[opts.paper].h;
  }

  // Auto orientation: portrait grids (rows >= columns) fit portrait
  // paper better; wide grids fit landscape.
  let swap = opts.orientation === "landscape";
  if (opts.orientation === "auto") {
    swap = columns > rows;
  }
  const width = swap ? baseH : baseW;
  const height = swap ? baseW : baseH;

  const margin = opts.marginMm * MM_TO_PT;
  const gap = opts.gapMm * MM_TO_PT;
  const innerW = Math.max(1, width - 2 * margin - (columns - 1) * gap);
  const innerH = Math.max(1, height - 2 * margin - (rows - 1) * gap);
  const cellW = innerW / columns;
  const cellH = innerH / rows;

  const cells: CspCell[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    cells.push({
      x: margin + col * (cellW + gap),
      // Row 0 at the TOP of the sheet.
      y: height - margin - (row + 1) * cellH - row * gap,
      w: cellW,
      h: cellH,
    });
  }

  return { width, height, cells, columns, rows };
}
