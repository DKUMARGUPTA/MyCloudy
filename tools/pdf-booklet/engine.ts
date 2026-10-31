import type { OptionValues } from "@/lib/tools/config-types";

/**
 * PDF booklet (PHASE-1 Batch A): saddle-stitch imposition — rearrange
 * pages onto landscape sheets (2 per side) so that printing duplex
 * (flip on short edge), stacking and folding down the middle yields a
 * booklet with pages in reading order.
 *
 * Pure planning math (no engine imports), smoke-testable without a Worker.
 */

export const BKL_IDS = {
  paper: "paper",
  margin: "margin",
  gap: "gap",
  pages: "pages",
} as const;

export type BklPaper = "a4" | "letter" | "a3" | "tabloid" | "legal";

export const BKL_PAPERS: Record<BklPaper, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
  a3: { w: 841.89, h: 1190.55 },
  tabloid: { w: 792, h: 1224 },
  legal: { w: 612, h: 1008 },
};

/** Millimetres → points. */
export const MM_TO_PT = 72 / 25.4;

export const BKL_MM_MIN = 0;
export const BKL_MM_MAX = 30;

export interface BklOptions {
  paper: BklPaper;
  marginMm: number;
  gapMm: number;
  pages: string;
}

export const BKL_DEFAULTS: BklOptions = {
  paper: "a4",
  marginMm: 0,
  gapMm: 0,
  pages: "all",
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveBklOptions(values: OptionValues): BklOptions {
  const paperRaw = values[BKL_IDS.paper];
  const marginRaw = Number(values[BKL_IDS.margin]);
  const gapRaw = Number(values[BKL_IDS.gap]);
  return {
    paper:
      paperRaw === "letter" || paperRaw === "a3" || paperRaw === "tabloid" || paperRaw === "legal"
        ? paperRaw
        : "a4",
    marginMm: clamp(
      Number.isFinite(marginRaw) ? marginRaw : BKL_DEFAULTS.marginMm,
      BKL_MM_MIN,
      BKL_MM_MAX
    ),
    gapMm: clamp(
      Number.isFinite(gapRaw) ? gapRaw : BKL_DEFAULTS.gapMm,
      BKL_MM_MIN,
      BKL_MM_MAX
    ),
    pages:
      typeof values[BKL_IDS.pages] === "string"
        ? (values[BKL_IDS.pages] as string)
        : BKL_DEFAULTS.pages,
  };
}

/** One output SIDE: the two 1-based booklet page slots (-1 = blank pad). */
export interface BklSide {
  left: number;
  right: number;
}

/**
 * Saddle-stitch imposition order. `pageCount` pages (1-based reading
 * order) become pageCount rounded UP to a multiple of 4; the result is
 * pageCount/2 sides (front+back pairs per sheet), each side carrying two
 * half-size portrait slots.
 *
 * Worked example (8 pages): [8,1] [2,7] [6,3] [4,5] — the classic
 * imposition every print shop uses. Verified in smoke-booklet.
 */
export function bookletSides(pageCount: number): BklSide[] {
  const n =
    pageCount < 1
      ? 4
      : pageCount % 4 === 0
        ? pageCount
        : pageCount + (4 - (pageCount % 4));
  const sides: BklSide[] = [];
  for (let k = 0; k < n / 2; k += 1) {
    if (k % 2 === 0) {
      // Front side of sheet k/2: [N-k, k+1]
      sides.push({ left: n - k, right: k + 1 });
    } else {
      // Back side: [k+1, N-k]
      sides.push({ left: k + 1, right: n - k });
    }
  }
  return sides;
}

/** One slot's placement on a LANDSCAPE sheet (points). */
export interface BklSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BklSheetGeometry {
  width: number;
  height: number;
  left: BklSlot;
  right: BklSlot;
}

/**
 * Landscape sheet + the two portrait slots. The paper's PORTRAIT page
 * size halves across the landscape width: a side of A4 paper carries two
 * A5-portrait-ish slots.
 */
export function sheetGeometry(
  paper: BklPaper,
  marginMm: number,
  gapMm: number
): BklSheetGeometry {
  const base = BKL_PAPERS[paper];
  const width = base.h; // landscape
  const height = base.w;
  const margin = marginMm * MM_TO_PT;
  const gap = gapMm * MM_TO_PT;
  const slotW = (width - 2 * margin - gap) / 2;
  const slotH = height - 2 * margin;
  return {
    width,
    height,
    left: { x: margin, y: margin, w: slotW, h: slotH },
    right: { x: margin + slotW + gap, y: margin, w: slotW, h: slotH },
  };
}
