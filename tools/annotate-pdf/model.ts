/**
 * Annotate PDF — PURE model (PRD §8.2 "Highlight / Underline / Strike" +
 * "Sticky note / Comment"; the priority queue's "editor core reuse" round).
 *
 * Everything here is framework-free and bun-testable:
 *  - the Annotation union (text-markup markups + sticky notes)
 *  - the PDF-user-space ↔ display-space transforms for all four /Rotate
 *    values (the make-pdf-fillable / edit-pdf mirrored-viewport recipe,
 *    copied here so the SURFACE never imports pdf-lib transitively)
 *  - text-piece harvesting from pdf.js text items (display space, works on
 *    rotated pages — the viewport matrix is applied directly, the P4.3
 *    "convertToViewportPoint returns an array" insight)
 *  - the drag-rect × text-pieces → QuadPoints machinery (word-snapping,
 *    per-line grouping, run merging) that makes highlights land on text
 *  - factories, wire-blob sanitising (never trust the blob) and the
 *    coalescing history helper (the edit-pdf snapshot semantics)
 *
 * Coordinate convention (same as edit-pdf): display space has y from the
 * top; PDF user space has y from the bottom. `page` is 0-based.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkupKind = "highlight" | "underline" | "strikeout";
export type AnnoKind = MarkupKind | "note";

/**
 * One highlight quadrilateral in PDF USER space, stored in the Acrobat
 * order (BL → BR → TR → TL, counterclockwise — what real files carry and
 * what every viewer builds its appearance from).
 */
export interface Quad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

export interface AnnoBase {
  id: string;
  page: number;
  color: string;
  at: number;
}

export interface MarkupAnno extends AnnoBase {
  kind: MarkupKind;
  opacity: number;
  /** Per-line quads; empty for the scanned-page fallback. */
  quads: Quad[];
  /** Union /Rect in user space. */
  rect: ObjRect;
  /** Excerpt of the marked text (for the comments list). */
  text: string;
  /** Scanned page (no text items): a filled square is used instead. */
  fallback: boolean;
}

export interface NoteAnno extends AnnoBase {
  kind: "note";
  /** User-space anchor point (the icon centres here). */
  x: number;
  y: number;
  text: string;
}

export type Annotation = MarkupAnno | NoteAnno;

export interface ObjRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// PageView + display transforms (pdf.js-mirrored, /Rotate-aware)
// ---------------------------------------------------------------------------

export interface PageView {
  /** pdf.js page.view: [x0, y0, x1, y1] of the CROP box, user space. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** /Rotate 0 | 90 | 180 | 270 (normalized). */
  rotate: number;
}

/** Display (visible) page size in points, /Rotate applied. */
export function displaySize(view: PageView): { w: number; h: number } {
  const uw = view.x1 - view.x0;
  const uh = view.y1 - view.y0;
  return view.rotate === 90 || view.rotate === 270
    ? { w: uh, h: uw }
    : { w: uw, h: uh };
}

/** User-space point → display point (y down, origin top-left). */
export function pdfToDisplayPoint(
  px: number,
  py: number,
  view: PageView
): { x: number; y: number } {
  switch (view.rotate) {
    case 90:
      return { x: py - view.y0, y: px - view.x0 };
    case 180:
      return { x: view.x1 - px, y: py - view.y0 };
    case 270:
      return { x: view.y1 - py, y: view.x1 - px };
    default:
      return { x: px - view.x0, y: view.y1 - py };
  }
}

/** Display point → user-space point (inverse of pdfToDisplayPoint). */
export function displayToPdfPoint(
  dx: number,
  dy: number,
  view: PageView
): { x: number; y: number } {
  switch (view.rotate) {
    case 90:
      return { x: dy + view.x0, y: dx + view.y0 };
    case 180:
      return { x: view.x1 - dx, y: view.y0 + dy };
    case 270:
      return { x: view.x1 - dy, y: view.y1 - dx };
    default:
      return { x: dx + view.x0, y: view.y1 - dy };
  }
}

/** PDF rect (y from bottom) → display rect (y from top), /Rotate-aware. */
export function pdfRectToDisplay(rect: ObjRect, view: PageView): ObjRect {
  const corners = [
    pdfToDisplayPoint(rect.x, rect.y, view),
    pdfToDisplayPoint(rect.x + rect.w, rect.y + rect.h, view),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Display rect (y from top) → PDF rect (y from bottom), /Rotate-aware. */
export function displayRectToPdf(rect: ObjRect, view: PageView): ObjRect {
  const corners = [
    displayToPdfPoint(rect.x, rect.y, view),
    displayToPdfPoint(rect.x + rect.w, rect.y + rect.h, view),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Display rect of one user-space quad (rendering only). */
export function quadToDisplayRect(quad: Quad, view: PageView): ObjRect {
  const pts = [
    pdfToDisplayPoint(quad.x1, quad.y1, view),
    pdfToDisplayPoint(quad.x2, quad.y2, view),
    pdfToDisplayPoint(quad.x3, quad.y3, view),
    pdfToDisplayPoint(quad.x4, quad.y4, view),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------------------------------------------------------------------------
// Constants + clamps
// ---------------------------------------------------------------------------

/**
 * Ascent share of the em used for the quad band (slight overdraw, the
 * way real highlight appearances look).
 */
export const ASCENT = 0.8;
/** Descent share of the em. */
export const DESCENT = 0.22;
/** Quads per annotation cap (wire safety). */
export const MAX_QUADS = 64;
/** Annotations per document cap (wire safety). */
export const MAX_ANNOS = 2000;
/** Sticky-note icon size in user-space pt. */
export const NOTE_SIZE = 22;
/** Excerpt length kept for the comments list. */
export const EXCERPT_LEN = 140;
/** Anything under this (pt) never becomes an annotation from a drag. */
export const MIN_ANNO_PT = 3;

/** The classic preset highlighter colours (annotation CONTENT, not UI). */
export const COLOR_PRESETS: { id: string; hex: string }[] = [
  { id: "yellow", hex: "#fdd835" },
  { id: "green", hex: "#66bb6a" },
  { id: "red", hex: "#ef5350" },
  { id: "pink", hex: "#ec407a" },
  { id: "teal", hex: "#26a69a" },
];

export const DEFAULT_COLOR = "#fdd835";
export const DEFAULT_OPACITY = 0.45;

export function clampN(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function roundPt(n: number): number {
  return Math.round(n * 10) / 10;
}

/** #rgb / #rrggbb → 0–1 rgb components. White for garbage. */
export function hexToRgb(hex: string): {
  r: number;
  g: number;
  b: number;
} {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return { r: 1, g: 1, b: 1 };
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const num = Number.parseInt(h, 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

// ---------------------------------------------------------------------------
// Text pieces (pdf.js items → display space)
// ---------------------------------------------------------------------------

/**
 * A horizontal text run in DISPLAY space: x..xEnd is the advance, baseline
 * the display y of the text baseline (y grows down), h the font em in
 * display points.
 */
export interface TextPiece {
  x: number;
  xEnd: number;
  baseline: number;
  h: number;
  str: string;
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * pdf.js text items + the page viewport (scale 1) → display pieces. The
 * viewport matrix is applied directly (rotation + crop offsets handled by
 * pdf.js itself); runs whose advance collapses to ~zero display width
 * (vertical text) are skipped honestly.
 */
export function piecesFromItems(
  transform: number[],
  items: unknown[]
): TextPiece[] {
  const [ma, mb, mc, md, me, mf] = transform;
  if (
    !Number.isFinite(ma) ||
    !Number.isFinite(mb) ||
    !Number.isFinite(mc) ||
    !Number.isFinite(md) ||
    !Number.isFinite(me) ||
    !Number.isFinite(mf)
  ) {
    return [];
  }
  const apply = (x: number, y: number): { x: number; y: number } => ({
    x: ma * x + mc * y + me,
    y: mb * x + md * y + mf,
  });
  const out: TextPiece[] = [];
  for (const raw of items) {
    const item = raw as RawTextItem;
    if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
    const tr = item.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;
    const x0 = Number(tr[4]);
    const y0 = Number(tr[5]);
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
    const width = typeof item.width === "number" ? item.width : 0;
    const hRaw =
      typeof item.height === "number" && Math.abs(item.height) > 0
        ? Math.abs(item.height)
        : Math.abs(Number(tr[3])) || 10;
    const h = hRaw > 0 ? hRaw : 10;
    // Baseline start and the advance end one em below the baseline —
    // min/max over both mapped corners (harvestPieces recipe, P4.3).
    const s = apply(x0, y0);
    const e = apply(x0 + width, y0 - h);
    const x = Math.min(s.x, e.x);
    const xEnd = Math.max(s.x, e.x);
    if (xEnd - x <= 0.01) continue; // vertical / zero-width run
    out.push({ x, xEnd, baseline: s.y, h, str: item.str });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drag → quads (the word-snapping highlight machinery)
// ---------------------------------------------------------------------------

/**
 * Selects the pieces a display-space drag rectangle covers. A piece is
 * picked when the vertical bands overlap at least half of the smaller
 * band AND the horizontal overlap is meaningful (or it sits fully inside
 * the drag) — this is what makes drags "snap" to whole words.
 */
export function piecesInDrag(
  pieces: TextPiece[],
  drag: ObjRect
): TextPiece[] {
  const dy0 = drag.y;
  const dy1 = drag.y + drag.h;
  const dx0 = drag.x;
  const dx1 = drag.x + drag.w;
  const dragH = Math.max(drag.h, 0.5);
  const hits: TextPiece[] = [];
  for (const p of pieces) {
    const top = p.baseline - ASCENT * p.h;
    const bot = p.baseline + DESCENT * p.h;
    const vOverlap = Math.min(bot, dy1) - Math.max(top, dy0);
    if (vOverlap <= 0.5 * Math.min(p.h, dragH)) continue;
    const w = p.xEnd - p.x;
    if (p.x >= dx0 && p.xEnd <= dx1) {
      hits.push(p);
      continue;
    }
    const hOverlap = Math.min(p.xEnd, dx1) - Math.max(p.x, dx0);
    // Word snapping: a piece the drag reaches INTO (starts or ends inside
    // the band) joins the selection whole — the way real text selection
    // lights up entire words.
    const startsInside = p.x >= dx0 && p.x < dx1;
    const endsInside = p.xEnd > dx0 && p.xEnd <= dx1;
    if (hOverlap >= Math.max(2, 0.3 * w) || startsInside || endsInside) {
      hits.push(p);
    }
  }
  return hits;
}

interface RunGroup {
  xL: number;
  xR: number;
  baseline: number;
  h: number;
  text: string;
}

/** Groups hit pieces into per-line runs (baseline bucket + x merging). */
function groupRuns(hits: TextPiece[]): RunGroup[] {
  const buckets = new Map<string, TextPiece[]>();
  for (const p of hits) {
    const key = String(Math.round(p.baseline * 2) / 2);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }
  const groups: RunGroup[] = [];
  const keys = [...buckets.keys()].sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    const line = (buckets.get(key) as TextPiece[]).sort((a, b) => a.x - b.x);
    let run: RunGroup | null = null;
    for (const p of line) {
      if (run && p.x - run.xR <= Math.max(1, 0.4 * Math.max(run.h, p.h))) {
        const spaced = p.x - run.xR > 0.15 * p.h;
        run.xR = Math.max(run.xR, p.xEnd);
        run.h = Math.max(run.h, p.h);
        run.text += spaced ? ` ${p.str}` : p.str;
      } else {
        if (run) groups.push(run);
        run = { xL: p.x, xR: p.xEnd, baseline: p.baseline, h: p.h, text: p.str };
      }
    }
    if (run) groups.push(run);
  }
  return groups;
}

/** A display-space run band → user-space quad (Acrobat BL/BR/TR/TL). */
function runToQuad(run: RunGroup, view: PageView): Quad {
  const yTop = run.baseline - ASCENT * run.h;
  const yBot = run.baseline + DESCENT * run.h;
  const corners = [
    displayToPdfPoint(run.xL, yTop, view),
    displayToPdfPoint(run.xR, yTop, view),
    displayToPdfPoint(run.xR, yBot, view),
    displayToPdfPoint(run.xL, yBot, view),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x1: roundPt(minX),
    y1: roundPt(minY),
    x2: roundPt(maxX),
    y2: roundPt(minY),
    x3: roundPt(maxX),
    y3: roundPt(maxY),
    x4: roundPt(minX),
    y4: roundPt(maxY),
  };
}

/** Union rect of quads, clamped to the page crop box. */
export function quadsToRect(quads: Quad[], view: PageView): ObjRect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const q of quads) {
    xs.push(q.x1, q.x2, q.x3, q.x4);
    ys.push(q.y1, q.y2, q.y3, q.y4);
  }
  const x0 = Math.max(Math.min(...xs), view.x0);
  const y0 = Math.max(Math.min(...ys), view.y0);
  const x1 = Math.min(Math.max(...xs), view.x1);
  const y1 = Math.min(Math.max(...ys), view.y1);
  return {
    x: x0,
    y: y0,
    w: Math.max(MIN_ANNO_PT, x1 - x0),
    h: Math.max(MIN_ANNO_PT, y1 - y0),
  };
}

let annoSeq = 0;
/** Fresh annotation id (timestamp+seq — unique across the session). */
export function nextAnnoId(prefix = "a"): string {
  annoSeq += 1;
  return `${prefix}${Date.now().toString(36)}${annoSeq.toString(36)}`;
}

/**
 * Builds a text-markup annotation from a display-space drag. Returns the
 * annotation (flagging `fallback: true` for the scanned-page square when
 * no text pieces intersect), or null when the drag is too small to keep.
 */
export function buildMarkupFromDrag(
  page: number,
  drag: ObjRect,
  pieces: TextPiece[],
  view: PageView,
  kind: MarkupKind,
  color: string,
  opacity: number,
  at: number
): MarkupAnno | null {
  if (drag.w < MIN_ANNO_PT && drag.h < MIN_ANNO_PT) return null;
  const prefix =
    kind === "highlight" ? "h" : kind === "underline" ? "u" : "s";
  const base = {
    id: nextAnnoId(prefix),
    page,
    color,
    at,
  };
  const hits = piecesInDrag(pieces, drag);
  if (hits.length === 0) {
    const rect = clampRect(displayRectToPdf(drag, view), view);
    if (rect === null) return null;
    return { ...base, kind, opacity, quads: [], rect, text: "", fallback: true };
  }
  const groups = groupRuns(hits);
  const quads = groups.slice(0, MAX_QUADS).map((g) => runToQuad(g, view));
  if (quads.length === 0) return null;
  const text = groups
    .map((g) => g.text.trim())
    .filter((s) => s.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, EXCERPT_LEN);
  return {
    ...base,
    kind,
    opacity,
    quads,
    rect: quadsToRect(quads, view),
    text,
    fallback: false,
  };
}

/** A sticky note anchored at a display-space click point. */
export function makeNote(
  page: number,
  dispX: number,
  dispY: number,
  view: PageView,
  color: string,
  at: number
): NoteAnno {
  const p = displayToPdfPoint(dispX, dispY, view);
  return {
    id: nextAnnoId("n"),
    page,
    color,
    x: roundPt(p.x),
    y: roundPt(p.y),
    text: "",
    at,
    kind: "note",
  };
}

/** Clamps a user-space rect into the crop box; null when fully outside. */
export function clampRect(rect: ObjRect, view: PageView): ObjRect | null {
  const x0 = Math.max(rect.x, view.x0);
  const y0 = Math.max(rect.y, view.y0);
  const x1 = Math.min(rect.x + rect.w, view.x1);
  const y1 = Math.min(rect.y + rect.h, view.y1);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Display-space marker centre of a note. */
export function noteDisplayPoint(
  note: NoteAnno,
  view: PageView
): { x: number; y: number } {
  return pdfToDisplayPoint(note.x, note.y, view);
}

// ---------------------------------------------------------------------------
// History (snapshot stack — the edit-pdf semantics)
// ---------------------------------------------------------------------------

export const HISTORY_LIMIT = 120;

export function undoStep(
  past: string[],
  future: string[],
  current: string
): { past: string[]; future: string[]; snapshot: string | null } {
  if (past.length === 0) return { past, future, snapshot: null };
  const nextPast = [...past];
  const snapshot = nextPast.pop() as string;
  return { past: nextPast, future: [current, ...future], snapshot };
}

export function redoStep(
  past: string[],
  future: string[],
  current: string
): { past: string[]; future: string[]; snapshot: string | null } {
  if (future.length === 0) return { past, future, snapshot: null };
  const [snapshot, ...rest] = future;
  return { past: [...past, current], future: rest, snapshot };
}

// ---------------------------------------------------------------------------
// Wire-format sanitising (worker side — never trust the blob)
// ---------------------------------------------------------------------------

const MARKUP_KINDS: MarkupKind[] = ["highlight", "underline", "strikeout"];
const KINDS: AnnoKind[] = [...MARKUP_KINDS, "note"];

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function str(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function color(v: unknown, dflt: string): string {
  return typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)
    ? v
    : dflt;
}

function parseQuad(v: unknown): Quad | null {
  if (typeof v !== "object" || v === null) return null;
  const q = v as Record<string, unknown>;
  const out = [
    num(q.x1, NaN),
    num(q.y1, NaN),
    num(q.x2, NaN),
    num(q.y2, NaN),
    num(q.x3, NaN),
    num(q.y3, NaN),
    num(q.x4, NaN),
    num(q.y4, NaN),
  ];
  if (out.some((n) => !Number.isFinite(n))) return null;
  return {
    x1: out[0],
    y1: out[1],
    x2: out[2],
    y2: out[3],
    x3: out[4],
    y3: out[5],
    x4: out[6],
    y4: out[7],
  };
}

function rectOf(v: unknown): ObjRect {
  const r = (typeof v === "object" && v !== null ? v : {}) as {
    x?: unknown;
    y?: unknown;
    w?: unknown;
    h?: unknown;
  };
  return {
    x: num(r.x, 72),
    y: num(r.y, 72),
    w: Math.max(MIN_ANNO_PT, num(r.w, 40)),
    h: Math.max(MIN_ANNO_PT, num(r.h, 20)),
  };
}

/** Parses + clamps one raw annotation from the wire blob. null = drop it. */
export function sanitizeAnnotation(
  raw: unknown,
  pageCount: number
): Annotation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const kind = KINDS.includes(o.kind as AnnoKind) ? (o.kind as AnnoKind) : null;
  if (kind === null) return null;
  const page = Math.min(
    Math.max(0, Math.trunc(num(o.page, 0))),
    Math.max(0, pageCount - 1)
  );
  const base = {
    id: str(o.id, nextAnnoId("x")),
    page,
    color: color(o.color, DEFAULT_COLOR),
    at: num(o.at, 0),
  };
  if (kind === "note") {
    const text = str(o.text, "").slice(0, 400);
    if (text.trim().length === 0) return null;
    return { ...base, kind, text, x: num(o.x, 72), y: num(o.y, 72) };
  }
  const opacity = clampN(num(o.opacity, DEFAULT_OPACITY), 0.15, 0.8);
  if (bool(o.fallback, false)) {
    return {
      ...base,
      kind,
      opacity,
      quads: [],
      rect: rectOf(o.rect),
      text: "",
      fallback: true,
    };
  }
  const rawQuads = Array.isArray(o.quads) ? o.quads : [];
  const quads: Quad[] = [];
  for (const q of rawQuads) {
    const parsed = parseQuad(q);
    if (parsed) quads.push(parsed);
    if (quads.length >= MAX_QUADS) break;
  }
  if (quads.length === 0) return null;
  return {
    ...base,
    kind,
    opacity,
    quads,
    rect: rectOf(o.rect),
    text: str(o.text, "").slice(0, EXCERPT_LEN),
    fallback: false,
  };
}

/** Parses the full annotations array from the wire blob. */
export function sanitizeAnnotations(
  raw: unknown,
  pageCount: number
): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const out: Annotation[] = [];
  for (const item of raw.slice(0, MAX_ANNOS)) {
    const anno = sanitizeAnnotation(item, pageCount);
    if (anno !== null) out.push(anno);
  }
  return out;
}
