import {
  type FontMatch,
  type HarvestPiece,
  type ObjRect,
} from "../edit-pdf/model";

/**
 * Edit PDF text (PHASE-7, the focused typo-fixer): find a line of text
 * in the PDF, cover exactly its band, and retype it in place — the
 * cover+redraw engine of the full editor, distilled into a search →
 * replace flow with auto-fit sizing. Pure planning math; the worker
 * stamps on our own engine, the surface harvests via the editor's
 * pdf.js text layer.
 */

/** Padded band around the baseline (the editor's TEXT_PAD recipe). */
export const ETXT_PAD = 3;
/** Auto-fit floor: a replacement never shrinks below 40% of the line. */
export const ETXT_MIN_SCALE = 0.4;
/** Max edits per run (honest cap, mirrors the editor's F&R budget). */
export const ETXT_MAX_EDITS = 200;
/** Max replacement length per edit. */
export const ETXT_MAX_TEXT = 500;

export interface EditableLine {
  /** 0-based source page. */
  page: number;
  /** Baseline y in PDF USER space (y from bottom, y-up). */
  baseline: number;
  /** Line band in user space (union of the pieces' user rects). */
  user: ObjRect;
  /** Left x in USER space (anchor for the redrawn text). */
  x: number;
  /** Right xEnd in user space. */
  xEnd: number;
  /** Dominant font size (pt). */
  size: number;
  text: string;
  font: FontMatch;
}

/** Group harvested pieces into visual lines (the y-band recipe). */
export function groupLines(
  pieces: HarvestPiece[],
  page: number
): EditableLine[] {
  const usable = pieces.filter(
    (p) =>
      typeof p.str === "string" &&
      p.str.length > 0 &&
      Number.isFinite(p.userX) &&
      Number.isFinite(p.userBaseline) &&
      Number.isFinite(p.user.x) &&
      Number.isFinite(p.user.w) &&
      p.user.w > 0
  );
  if (usable.length === 0) return [];

  const sorted = [...usable].sort(
    (a, b) => b.userBaseline - a.userBaseline || a.userX - b.userX
  );
  const lines: EditableLine[] = [];
  let band: HarvestPiece[] = [sorted[0]!];
  let bandY = sorted[0]!.userBaseline;
  let tol = Math.max(1.5, sorted[0]!.h * 0.5);

  const flush = (): void => {
    if (band.length === 0) return;
    const inBand = [...band].sort((a, b) => a.userX - b.userX);
    const size = inBand.reduce((m, p) => Math.max(m, p.h), 0);
    let text = "";
    for (let i = 0; i < inBand.length; i += 1) {
      const piece = inBand[i]!;
      if (i > 0) {
        const prev = inBand[i - 1]!;
        text += piece.userX - (prev.userX + prev.user.w) > 0.25 * size ? " " : "";
      }
      text += piece.str;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of inBand) {
      minX = Math.min(minX, p.user.x);
      minY = Math.min(minY, p.user.y);
      maxX = Math.max(maxX, p.user.x + p.user.w);
      maxY = Math.max(maxY, p.user.y + p.user.h);
    }
    const user: ObjRect = {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    };
    lines.push({
      page,
      baseline: bandY,
      user,
      x: inBand[0]!.userX,
      xEnd:
        inBand[inBand.length - 1]!.userX +
        inBand[inBand.length - 1]!.user.w,
      size,
      text: text.replace(/\s+/g, " ").trim(),
      font: inBand[0]!.font,
    });
    band = [];
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i]!;
    if (Math.abs(piece.userBaseline - bandY) <= tol) {
      band.push(piece);
    } else {
      flush();
      band = [piece];
      bandY = piece.userBaseline;
      tol = Math.max(1.5, piece.h * 0.5);
    }
  }
  flush();
  return lines.filter((l) => l.text.length > 0);
}

/** Case-insensitive contains search over the harvested lines. */
export function findLines(
  lines: EditableLine[],
  query: string
): EditableLine[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return lines.filter((l) => l.text.toLowerCase().includes(q));
}

export interface EditOp {
  page: number;
  cover: ObjRect;
  /** Baseline-left anchor for the redrawn text. */
  x: number;
  y: number;
  size: number;
  text: string;
  font: FontMatch;
  /** Cover fill 0..1 RGB. */
  bg: { r: number; g: number; b: number };
}

export function buildEditOp(
  line: EditableLine,
  replacement: string,
  measure: (text: string, font: FontMatch, size: number) => number,
  bg: { r: number; g: number; b: number } = { r: 1, g: 1, b: 1 }
): EditOp {
  const pad = ETXT_PAD;
  const cover: ObjRect = {
    x: line.user.x - pad,
    y: line.user.y - pad * 0.5,
    w: line.user.w + pad * 2,
    h: line.user.h + pad,
  };
  // Auto-fit: the replacement never spills past the covered band.
  const availW = Math.max(8, cover.w - pad * 2);
  const text = replacement.replace(/\s+/g, " ").trim().slice(0, ETXT_MAX_TEXT);
  const natural = Math.max(1, measure(text, line.font, line.size));
  const scale = Math.min(1, availW / natural);
  const size = Math.max(
    Math.max(4, line.size * ETXT_MIN_SCALE),
    line.size * scale
  );
  return {
    page: line.page,
    cover,
    x: cover.x + pad,
    y: line.baseline,
    size,
    text,
    font: line.font,
    bg,
  };
}

/** Parse + validate the edits blob from the option values (honest caps). */
export function resolveEditOps(
  raw: unknown,
  pageCount: number
): EditOp[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EditOp[] = [];
  for (const v of parsed) {
    if (out.length >= ETXT_MAX_EDITS) break;
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const page = o["page"];
    const cover = o["cover"] as Record<string, unknown> | undefined;
    const x = o["x"];
    const y = o["y"];
    const size = o["size"];
    const text = o["text"];
    const font = o["font"] as Record<string, unknown> | undefined;
    const bg = o["bg"] as Record<string, unknown> | undefined;
    if (
      typeof page !== "number" || !Number.isInteger(page) ||
      page < 0 || page >= pageCount ||
      !cover || typeof cover["x"] !== "number" || typeof cover["y"] !== "number" ||
      typeof cover["w"] !== "number" || typeof cover["h"] !== "number" ||
      !Number.isFinite(cover["x"]) || !Number.isFinite(cover["y"]) ||
      !(cover["w"] > 0) || !(cover["h"] > 0) ||
      typeof x !== "number" || typeof y !== "number" ||
      typeof size !== "number" || !(size > 0) || size > 400 ||
      typeof text !== "string" || text.length === 0 || text.length > ETXT_MAX_TEXT ||
      !font || typeof font["font"] !== "string"
    ) {
      continue;
    }
    const bgRgb =
      bg && typeof bg["r"] === "number" && typeof bg["g"] === "number" && typeof bg["b"] === "number"
        ? { r: bg["r"], g: bg["g"], b: bg["b"] }
        : { r: 1, g: 1, b: 1 };
    out.push({
      page,
      cover: { x: cover["x"], y: cover["y"], w: cover["w"], h: cover["h"] },
      x,
      y,
      size,
      text,
      font: font as unknown as FontMatch,
      bg: bgRgb,
    });
  }
  return out;
}
