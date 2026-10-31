import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Rotate PDF pages by a custom angle (PHASE-1 Batch B): 1-degree
 * arbitrary rotation — a 7° tilt fix for scanned pages that 90°
 * multiples can't straighten. Each page becomes a new sheet whose
 * dimensions are the ROTATED BOUNDING BOX (nothing is cropped).
 *
 * Pure math — smoke-testable without a Worker.
 */

export const RC_IDS = {
  angle: "angle",
  direction: "direction",
} as const;

export type RcDirection = "cw" | "ccw";

export interface RotateCustomOptions {
  /** Absolute degrees (1..179, never 0/180-multiples — those are the grid tool's job). */
  angle: number;
  direction: RcDirection;
}

export const ROTATE_CUSTOM_MIN = 1;
export const ROTATE_CUSTOM_MAX = 179;

export const RC_DEFAULTS: RotateCustomOptions = {
  angle: 7,
  direction: "cw",
};

export function resolveRotateCustomOptions(
  values: OptionValues
): RotateCustomOptions {
  const angleRaw = Number(values[RC_IDS.angle]);
  const angle =
    Number.isFinite(angleRaw) && angleRaw >= ROTATE_CUSTOM_MIN && angleRaw <= ROTATE_CUSTOM_MAX
      ? Math.round(angleRaw)
      : RC_DEFAULTS.angle;
  return {
    angle,
    direction: values[RC_IDS.direction] === "ccw" ? "ccw" : "cw",
  };
}

/** Counter-clockwise rotation used for the placement matrix. */
export function effectiveRotation(opts: RotateCustomOptions): number {
  return opts.direction === "cw" ? -opts.angle : opts.angle;
}

/** Rotated bounding-box dims for a page w×h at angle θ (degrees). */
export function rotatedDims(
  w: number,
  h: number,
  thetaDeg: number
): { w: number; h: number } {
  const t = (Math.abs(thetaDeg) * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    w: Math.abs(w * cos) + Math.abs(h * sin),
    h: Math.abs(w * sin) + Math.abs(h * cos),
  };
}

/**
 * Placement transform: the source page (form, drawn from its origin at
 * the placement translate) rotated by θ about the SHEET origin, centred.
 * Returns [tx, ty] for `1 0 0 1 tx ty cm` followed by the rotation matrix.
 *
 * Math: the form spans [0,w]×[0,h] pre-rotation. After rotation by θ the
 * axis-aligned bounding box is rotatedDims. Centring in the sheet means
 * the bbox min-corner sits at ((W-bw)/2, (H-bh)/2); the translate that
 * achieves it for rotation-about-origin is that offset minus the rotated
 * origin-corner of the form.
 */
export function placement(
  sheet: { w: number; h: number },
  page: { w: number; h: number },
  thetaDeg: number
): { tx: number; ty: number } {
  const t = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const corners: Array<[number, number]> = [
    [0, 0],
    [page.w, 0],
    [page.w, page.h],
    [0, page.h],
  ];
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of corners) {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
  }
  const bbox = rotatedDims(page.w, page.h, thetaDeg);
  const tx = (sheet.w - bbox.w) / 2 - minX;
  const ty = (sheet.h - bbox.h) / 2 - minY;
  return { tx, ty };
}
