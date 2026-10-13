/**
 * Redact PDF engine (PRD §8.4 "Redact" — PURE module, bun-testable).
 *
 * Security model (the heart of this tool):
 * - Marks are rectangles stored as fractions of the page DISPLAY box (what
 *   the user sees, pdf.js rotation applied) — the same model Sign uses for
 *   placements, so preview, worker and output agree by construction.
 * - The worker FLATTENS every marked page: render → paint opaque boxes →
 *   replace the page with a JPEG-only page inside a fresh document. The
 *   original content streams, annotations and form values of marked pages
 *   are never copied, so the redacted text cannot be recovered by copy,
 *   search, text extraction or stream archaeology.
 *
 * Nothing here touches the DOM or pdf.js — the surface feeds raw pdf.js text
 * items in, the worker feeds marks + render output out.
 */

/** Why a mark exists — preset patterns, custom text, or hand-drawn. */
export type RedactKind = "aadhaar" | "pan" | "phone" | "email" | "text" | "manual";

/** One redaction rectangle on one page (display fractions, 0..1). */
export interface RedactMark {
  id: string;
  /** 0-based page index. */
  page: number;
  /** Left / top / width / height as fractions of the DISPLAY box. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: RedactKind;
  /** Matched text ("" for manual boxes) — shown in the UI only. */
  label: string;
  /** Unchecked marks are kept for re-toggling but ignored by the worker. */
  enabled: boolean;
}

/** Hard cap per document — keeps the options payload sane. */
export const MAX_MARKS = 600;

const KINDS: readonly RedactKind[] = [
  "aadhaar",
  "pan",
  "phone",
  "email",
  "text",
  "manual",
];

/* ------------------------------------------------------------------ */
/* Sensitive-text patterns                                             */
/* ------------------------------------------------------------------ */

/** Patterns the "Find" card can scan for (Indian document staples). */
export const PATTERN_IDS = ["aadhaar", "pan", "phone", "email"] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

/**
 * Each regex is anchored against neighbours with look-arounds so a match is
 * never a fragment of a longer token (a 16-digit order id must not light up
 * as an Aadhaar). Separators allow spaces and hyphens, the two shapes the
 * real documents use.
 */
const PATTERN_REGEX: Record<PatternId, RegExp> = {
  // 12 digits: 1234 5678 9012 / 1234-5678-9012 / 123456789012
  aadhaar: /(?<![0-9])[0-9]{4}[ \-]?[0-9]{4}[ \-]?[0-9]{4}(?![0-9])/g,
  // PAN: ABCDE1234F
  pan: /(?<![A-Z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Z0-9])/g,
  // Indian mobile: 98765 43210 / 9876543210 / +91 98765 43210 / 91-9876543210
  phone:
    /(?<![0-9])(?:\+?91[ \-]?)?(?:[6-9][0-9]{9}|[6-9][0-9]{4}[ \-][0-9]{5})(?![0-9])/g,
  // Email
  email:
    /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
};

/** All non-overlapping matches of one pattern in a joined line string. */
export function regexMatches(
  line: string,
  pattern: PatternId
): { start: number; end: number; text: string }[] {
  const re = PATTERN_REGEX[pattern];
  re.lastIndex = 0;
  const hits: { start: number; end: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (m[0].length === 0) re.lastIndex += 1; // never trip on empty matches
  }
  return hits;
}

/** Case-insensitive literal terms (one per line of the custom textarea). */
export function termMatches(
  line: string,
  terms: string[]
): { start: number; end: number; text: string }[] {
  const hits: { start: number; end: number; text: string }[] = [];
  const hay = line.toLocaleLowerCase("en-IN");
  for (const term of terms) {
    if (term.length === 0) continue;
    const needle = term.toLocaleLowerCase("en-IN");
    let at = hay.indexOf(needle);
    while (at !== -1) {
      hits.push({
        start: at,
        end: at + term.length,
        text: line.slice(at, at + term.length),
      });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  // Overlapping hits for different terms are fine — same text redacted twice.
  return hits.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* pdf.js text items → lines with piece coverage                       */
/* ------------------------------------------------------------------ */

/** A positioned run of text in PDF user space. */
export interface TextPiece {
  str: string;
  /** Baseline start (user space). */
  x: number;
  y: number;
  /** Advance width (user space points). */
  w: number;
  /** Vertical font scale (user space points). */
  size: number;
  /** Normalised advance direction (handles rotated glyph runs). */
  dirX: number;
  dirY: number;
}

/** A line segment keeps the piece that produced it (for box mapping). */
export interface LineSegment {
  text: string;
  piece: TextPiece;
}

/** Visual line: joined text + the pieces that produced each part. */
export interface TextLine {
  text: string;
  segments: LineSegment[];
}

/**
 * Normalises raw pdf.js text items into pieces. Items without usable
 * geometry are skipped defensively — a match we cannot place is a match we
 * cannot redact, and half-guessed boxes are worse than none.
 */
export function buildPieces(items: unknown[]): TextPiece[] {
  const pieces: TextPiece[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const str = (item as { str?: unknown }).str;
    const transform = (item as { transform?: unknown }).transform;
    if (typeof str !== "string" || str.length === 0) continue;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const a = Number(transform[0]) || 0;
    const b = Number(transform[1]) || 0;
    const c = Number(transform[2]) || 0;
    const d = Number(transform[3]) || 0;
    const e = Number(transform[4]);
    const f = Number(transform[5]);
    if (!Number.isFinite(e) || !Number.isFinite(f)) continue;
    const len = Math.hypot(a, b);
    if (len <= 0) continue;
    const size = Math.hypot(c, d);
    const w = Number((item as { width?: unknown }).width) || 0;
    pieces.push({
      str,
      x: e,
      y: f,
      w,
      size: size > 0 ? size : Math.abs(len),
      dirX: a / len,
      dirY: b / len,
    });
  }
  return pieces;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** User-space glyph box of a piece (descenders and ascenders included). */
export function pieceUserBox(piece: TextPiece): Rect {
  // "Up" = advance rotated 90° counter-clockwise in user space (y-up).
  const upX = -piece.dirY;
  const upY = piece.dirX;
  const bx = piece.x;
  const by = piece.y;
  const dx = piece.dirX * piece.w;
  const dy = piece.dirY * piece.w;
  const down = -0.26 * piece.size; // below the baseline (descenders)
  const up = 0.9 * piece.size; // above it (caps, marks, matras)
  const xs = [
    bx + upX * down,
    bx + upX * up,
    bx + upX * down + dx,
    bx + upX * up + dx,
  ];
  const ys = [
    by + upY * down,
    by + upY * up,
    by + upY * down + dy,
    by + upY * up + dy,
  ];
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/**
 * Groups pieces into visual lines (baseline within half a font height,
 * pdf-to-txt's proven heuristic) and joins them with coverage-preserving
 * segments: a synthetic space is appended to the PREVIOUS piece's text
 * wherever the gap exceeds a quarter font, so character offsets in the
 * joined string always map back to a real piece.
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
    const segments: LineSegment[] = [];
    let endX: number | null = null;
    for (const piece of ordered) {
      let text = piece.str;
      if (
        endX !== null &&
        piece.x - endX > piece.size * 0.25 &&
        !text.startsWith(" ")
      ) {
        text = ` ${text}`;
      }
      segments.push({ text, piece });
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    return {
      text: segments
        .map((s) => s.text)
        .join("")
        .replace(/\s+$/, ""),
      segments,
    };
  });
}

/** Union of rectangles (null for an empty list). */
export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x0);
    y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x1);
    y1 = Math.max(y1, r.y1);
  }
  return { x0, y0, x1, y1 };
}

/** Pieces whose segments cover [start, end) of the joined line text. */
export function piecesForRange(
  line: TextLine,
  start: number,
  end: number
): TextPiece[] {
  const picked: TextPiece[] = [];
  let offset = 0;
  for (const segment of line.segments) {
    const sStart = offset;
    const sEnd = offset + segment.text.length;
    if (sEnd > start && sStart < end) picked.push(segment.piece);
    offset = sEnd;
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* User space → display fractions                                      */
/* ------------------------------------------------------------------ */

/** pdf.js viewport transform (6 numbers) — user space → display (y down). */
export type Transform6 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Applies an affine transform to a point. */
export function applyTransform(
  m: Transform6,
  x: number,
  y: number
): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

/** Maps a user-space rect through the viewport transform (bbox of corners). */
export function userRectToDisplay(rect: Rect, m: Transform6): Rect {
  const corners = [
    applyTransform(m, rect.x0, rect.y0),
    applyTransform(m, rect.x1, rect.y0),
    applyTransform(m, rect.x0, rect.y1),
    applyTransform(m, rect.x1, rect.y1),
  ];
  return {
    x0: Math.min(...corners.map((c) => c.x)),
    y0: Math.min(...corners.map((c) => c.y)),
    x1: Math.max(...corners.map((c) => c.x)),
    y1: Math.max(...corners.map((c) => c.y)),
  };
}

/** Display rect + padding (px) → clamped display fractions. */
export function displayRectToFraction(
  rect: Rect,
  dispW: number,
  dispH: number,
  padPx: number
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(1, dispW);
  const h = Math.max(1, dispH);
  const x0 = Math.min(Math.max((rect.x0 - padPx) / w, 0), 1);
  const y0 = Math.min(Math.max((rect.y0 - padPx) / h, 0), 1);
  const x1 = Math.min(Math.max((rect.x1 + padPx) / w, 0), 1);
  const y1 = Math.min(Math.max((rect.y1 + padPx) / h, 0), 1);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.max(x1 - Math.min(x0, x1), 0.004),
    h: Math.max(y1 - Math.min(y0, y1), 0.006),
  };
}

/* ------------------------------------------------------------------ */
/* Mark parsing (worker-side defensive re-validation)                   */
/* ------------------------------------------------------------------ */

function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Parses the "m:<fileId>" option back into marks. Every field is clamped,
 * unknown kinds are dropped, duplicates removed and the total capped at
 * MAX_MARKS — a hostile/legacy payload can never make the worker draw
 * outside the page or loop forever.
 */
export function parseRedactMarks(raw: unknown): RedactMark[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const marks: RedactMark[] = [];
  const seen = new Set<string>();
  for (const entry of data.slice(0, MAX_MARKS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (id.length === 0 || id.length > 40 || seen.has(id)) continue;
    const page = Number(rec.page);
    if (!Number.isInteger(page) || page < 0 || page > 20000) continue;
    const kind = rec.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as RedactKind)) {
      continue;
    }
    const x = clamp01(rec.x, 0);
    const y = clamp01(rec.y, 0);
    const w = Math.min(clamp01(rec.w, 0), 1 - x + 0.05);
    const h = Math.min(clamp01(rec.h, 0), 1 - y + 0.05);
    if (w < 0.004 || h < 0.006) continue;
    const label = typeof rec.label === "string" ? rec.label.slice(0, 64) : "";
    seen.add(id);
    marks.push({
      id,
      page,
      x,
      y,
      w,
      h,
      kind: kind as RedactMark["kind"],
      label,
      enabled: rec.enabled === true,
    });
  }
  return marks;
}

/** Marks enabled and on a valid page for a pageCount-page document. */
export function activeMarks(
  marks: RedactMark[],
  pageCount: number
): RedactMark[] {
  return marks.filter((m) => m.enabled && m.page >= 0 && m.page < pageCount);
}

/** Marks (any state) shown for one page. */
export function marksOnPage(
  marks: RedactMark[],
  pageIndex: number
): RedactMark[] {
  return marks.filter((m) => m.page === pageIndex);
}

/** Pages that have at least one ENABLED mark (strip badges). */
export function markedPages(marks: RedactMark[]): Set<number> {
  const set = new Set<number>();
  for (const m of marks) if (m.enabled) set.add(m.page);
  return set;
}

/** Redaction box colour option → canvas fill style. */
export function boxColor(value: unknown): string {
  return value === "white" ? "#ffffff" : "#000000";
}

/** Flatten DPI option → points, clamped to the three shipped presets. */
export function flattenDpi(value: unknown): number {
  const n = Number(value);
  if (n === 96 || n === 150 || n === 300) return n;
  return 150;
}
