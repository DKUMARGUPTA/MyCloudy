import { pdfNumToString } from "@/lib/own/pdf";
import { placement, rotatedDims } from "../rotate-custom/engine";
import { SKEW_MIN_ANGLE, SKEW_MAX_ANGLE } from "../ocr-pdf/engine";

/**
 * Deskew PDF (PHASE-7): auto-detect the baseline tilt of every page and
 * straighten it — VECTORS, never pixels. Detection (the raster probe)
 * reuses the ocr-pdf Hough-lite projection-profile engine; the fix is a
 * Form-XObject rotation on our own ComposeContext, so text and line art
 * keep their full quality (the same trick as rotate-custom, but about
 * the page CENTRE so the sheet keeps its size).
 *
 * Angle convention (inherited from ocr-pdf detectSkewAngle): a POSITIVE
 * detected angle means the content is tilted CLOCKWISE on screen (right
 * edge lower) — the classic scanner tilt. Straightening = a visual
 * counter-clockwise rotation by that angle = PDF-space rotation of +A.
 */

export const DESKEW_IDS = {
  pages: "pages",
  sizing: "sizing",
} as const;

export type DeskewSizing = "keep" | "grow";

export const DESKEW_DEFAULTS = {
  pages: "all",
  sizing: "keep" as DeskewSizing,
};

export interface DeskewOptions {
  pages: string;
  sizing: DeskewSizing;
}

export function resolveDeskewOptions(values: Record<string, unknown>): DeskewOptions {
  const sizing = values[DESKEW_IDS.sizing] === "grow" ? "grow" : "keep";
  const pagesRaw = values[DESKEW_IDS.pages];
  const pages =
    typeof pagesRaw === "string" && pagesRaw.trim().length > 0
      ? pagesRaw.trim()
      : DESKEW_DEFAULTS.pages;
  return { pages, sizing };
}

/**
 * Gate a raw detection into a correction we are willing to apply:
 * 0 when the angle is inside the noise band, beyond the sane skew bound,
 * or the detector had too few agreeing strips (samples <= 1).
 */
export function correctionFromDetection(
  angle: number,
  samples: number
): number {
  if (!Number.isFinite(angle)) return 0;
  if (samples < 2) return 0;
  if (Math.abs(angle) < SKEW_MIN_ANGLE) return 0;
  if (Math.abs(angle) > SKEW_MAX_ANGLE) return 0;
  return Math.round(angle * 100) / 100;
}

/** 90°-step /Rotate value normalised into 0 | 90 | 180 | 270. */
export function rotateNorm(rotate: number): 0 | 90 | 180 | 270 {
  return ((((Math.round(rotate / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

export interface DeskewSheet {
  /** Sheet (output page) size in points. */
  w: number;
  h: number;
  /** Raw content-stream ops — the caller's ComposeContext sheet body. */
  ops: string;
}

/**
 * Ops for one deskewed sheet. `correction` is the SIGNED detected angle
 * (ocr-pdf convention: positive = content tilted clockwise on screen).
 * A correction of 0 yields the identity 1:1 placement (byte-stable with
 * organize's straight draw).
 *
 * "keep" (default): the sheet keeps the page's visual size and the form
 * rotates about its centre — the classic deskew behaviour (scans carry
 * margins, the few clipped corner pixels belong to the tilt, not to
 * content).
 *
 * "grow": rotate-custom's bounding-box growth — nothing clips at all,
 * the sheet grows to the rotated bbox.
 */
export function deskewSheetOps(
  form: { key: string; width: number; height: number },
  page: { w: number; h: number; rotate: number },
  correction: number,
  sizing: DeskewSizing
): DeskewSheet {
  const norm = rotateNorm(page.rotate);
  const swap = norm === 90 || norm === 270;
  const effW = swap ? page.h : page.w;
  const effH = swap ? page.w : page.h;

  // Identity ONLY for already-upright pages: the plain organise-style
  // draw on a same-size sheet. Pages carrying a /Rotate norm keep the
  // centre-rotation path below (totalTheta = norm alone draws them
  // 1:1-visual, bbox fits the sheet EXACTLY at 90/270).
  if (correction === 0 && norm === 0) {
    return {
      w: effW,
      h: effH,
      ops: `q\n/${form.key} Do\nQ`,
    };
  }

  // PDF-space rotation: visual CCW by `correction` = +correction in PDF
  // degrees (ocr-pdf's positive-CW-tilt convention straightens CCW).
  const theta = correction;
  const totalTheta = theta + norm;

  if (sizing === "grow") {
    const dims = rotatedDims(effW, effH, theta);
    const t = placement(dims, { w: form.width, h: form.height }, totalTheta);
    const rad = (totalTheta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      w: dims.w,
      h: dims.h,
      ops: [
        "q",
        `1 0 0 1 ${pdfNumToString(t.tx)} ${pdfNumToString(t.ty)} cm`,
        `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
        `/${form.key} Do`,
        "Q",
      ].join("\n"),
    };
  }

  // "keep": rotate about the form centre, sheet keeps the visual size.
  const rad = (totalTheta * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = effW / 2;
  const cy = effH / 2;
  return {
    w: effW,
    h: effH,
    ops: [
      "q",
      `1 0 0 1 ${pdfNumToString(cx)} ${pdfNumToString(cy)} cm`,
      `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
      `1 0 0 1 ${pdfNumToString(-form.width / 2)} ${pdfNumToString(-form.height / 2)} cm`,
      `/${form.key} Do`,
      "Q",
    ].join("\n"),
  };
}
