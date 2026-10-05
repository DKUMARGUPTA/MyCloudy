/**
 * PageGrid family — pure shared model (PRD §8.1 "Rotate / Rearrange /
 * Remove / Extract (Page-grid family)").
 *
 * One data structure describes the edited document for ALL four tools:
 * an ordered list of page entries, each pointing at its source page in the
 * original PDF (or a blank), plus a rotation delta. The GridSurface edits
 * this list with undoable operations; the shared worker rebuilds the
 * output PDF from the serialized list. Same module on both sides — the
 * panel preview and the worker output can never disagree.
 *
 * Presets (PRD): "rotate" (all/selected/odd/even rotate buttons + live
 * thumbnail rotation), "rearrange" (drag reorder), "remove" (selection or
 * "2,5-7" + auto blank-page detect), "extract" (new PDF from selection,
 * optional one-page-per-file).
 */

/** One editable page in the grid. `source` is a 0-based index in the original PDF (-1 = blank page). */
export interface GridPage {
  /** Client-only stable identity (dnd keys); NOT serialized. */
  uid: number;
  source: number;
  /** Cumulative rotation delta in degrees, applied on top of the source page's own /Rotate. */
  rotation: number;
}

export type GridPreset = "rotate" | "rearrange" | "remove" | "extract";

/** Above this page count the grid renders virtualized rows (drag off). */
export const VIRTUALIZE_ABOVE = 150;

/** Thumbnail render size (px, longest side) — zoom-independent, CSS scales. */
const THUMB_MAX_DIM = 160;

export function gridThumbMaxDim(): number {
  return THUMB_MAX_DIM;
}

let uidSeq = 0;

function nextUid(): number {
  uidSeq += 1;
  return uidSeq;
}

/** Fresh grid for a document: every source page once, in order. */
export function createInitialGrid(pageCount: number): GridPage[] {
  const pages: GridPage[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    pages.push({ uid: nextUid(), source: i, rotation: 0 });
  }
  return pages;
}

/** Normalizes a rotation delta to 0..359. */
export function normalizeRotation(rotation: number): number {
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/* ------------------------- serialization ------------------------- */

/**
 * Compact wire format: [[source, rotation], …]. Passed to the worker as a
 * plain option value (uids never leave the client).
 */
export function serializeGrid(pages: GridPage[]): string {
  const flat: [number, number][] = pages.map((page) => [
    page.source,
    normalizeRotation(page.rotation),
  ]);
  return JSON.stringify(flat);
}

/** Parses the wire format back. Returns null for anything malformed. */
export function parseGridOption(raw: unknown): GridPage[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const pages: GridPage[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const source = entry[0];
    const rotation = entry[1];
    if (typeof source !== "number" || typeof rotation !== "number") return null;
    if (!Number.isInteger(source) || source < -1) return null;
    pages.push({
      uid: nextUid(),
      source,
      rotation: normalizeRotation(rotation),
    });
  }
  return pages;
}

/** Parses a JSON number array option (e.g. the extract selection). */
export function parseNumberListOption(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: number[] = [];
    for (const item of parsed) {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 0) {
        return [];
      }
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

/* --------------------------- operations --------------------------- */
/* All pure: they return new arrays and never mutate their input. */

/** Adds a rotation delta to the given indices. */
export function rotateIndices(
  pages: GridPage[],
  indices: number[],
  delta: number
): GridPage[] {
  if (indices.length === 0) return pages;
  const touched = new Set(indices);
  return pages.map((page, index) =>
    touched.has(index)
      ? { ...page, rotation: normalizeRotation(page.rotation + delta) }
      : page
  );
}

/** Removes the given indices. */
export function deleteIndices(
  pages: GridPage[],
  indices: number[]
): GridPage[] {
  if (indices.length === 0) return pages;
  const touched = new Set(indices);
  return pages.filter((_, index) => !touched.has(index));
}

/** Duplicates each selected page right after itself (1,2,3 sel 2,3 → 1,2,2,3,3). */
export function duplicateIndices(
  pages: GridPage[],
  indices: number[]
): GridPage[] {
  if (indices.length === 0) return pages;
  const touched = new Set(indices);
  const out: GridPage[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    out.push(pages[index]);
    if (touched.has(index)) {
      out.push({ ...pages[index], uid: nextUid() });
    }
  }
  return out;
}

/**
 * Inserts one blank page after the last selected index (or at the end when
 * nothing is selected).
 */
export function insertBlankAfter(
  pages: GridPage[],
  indices: number[]
): GridPage[] {
  const at = indices.length > 0 ? Math.max(...indices) + 1 : pages.length;
  const out = [...pages];
  out.splice(at, 0, { uid: nextUid(), source: -1, rotation: 0 });
  return out;
}

/** Moves one entry (drag reorder). No-op when out of bounds. */
export function moveEntry(
  pages: GridPage[],
  from: number,
  to: number
): GridPage[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= pages.length ||
    to >= pages.length
  ) {
    return pages;
  }
  const out = [...pages];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/**
 * Moves the whole selection one slot left (-1) or right (+1) as a block.
 * Works for scattered selections too — the always-available reorder path
 * for virtualized (large) documents.
 */
export function moveSelectionByOne(
  pages: GridPage[],
  indices: number[],
  direction: -1 | 1
): GridPage[] {
  if (indices.length === 0) return pages;
  const touched = new Set(indices);
  const out = [...pages];
  if (direction === -1) {
    for (let index = 0; index < out.length; index += 1) {
      if (!touched.has(index)) continue;
      if (index === 0 || touched.has(index - 1)) continue;
      const [moved] = out.splice(index, 1);
      out.splice(index - 1, 0, moved);
    }
  } else {
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (!touched.has(index)) continue;
      if (index === out.length - 1 || touched.has(index + 1)) continue;
      const [moved] = out.splice(index, 1);
      out.splice(index + 1, 0, moved);
    }
  }
  return out;
}

/* ---------------------------- selection ---------------------------- */

/** 0-based indices of odd 1-based positions (PRD rotate preset scope). */
export function oddIndices(pages: GridPage[]): number[] {
  const out: number[] = [];
  for (let index = 0; index < pages.length; index += 2) out.push(index);
  return out;
}

/** 0-based indices of even 1-based positions. */
export function evenIndices(pages: GridPage[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < pages.length; index += 2) out.push(index);
  return out;
}

/**
 * Parses a page-range string ("1-3, 5") against the CURRENT page count and
 * returns 0-based grid indices, or null when invalid (PRD "range input").
 * Unlike the split parser this is strict: out-of-range is invalid.
 */
export function parseGridRange(
  text: string,
  pageCount: number
): number[] | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all" || trimmed === "*") {
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  const picked = new Set<number>();
  for (const partRaw of trimmed.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (part === "") continue;
    const match = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    const end = match[2] === undefined ? start : Number.parseInt(match[2], 10);
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from < 1 || to > pageCount) return null;
    for (let page = from; page <= to; page += 1) picked.add(page - 1);
  }
  if (picked.size === 0) return null;
  return [...picked].sort((a, b) => a - b);
}

/* ------------------------------ stats ------------------------------ */

export interface GridStats {
  total: number;
  rotated: number;
  blanks: number;
  removed: number;
}

/** Summary for the aside panel (pages out, removed, rotated, blanks). */
export function gridStats(pages: GridPage[], originalCount: number): GridStats {
  let rotated = 0;
  let blanks = 0;
  for (const page of pages) {
    if (page.rotation !== 0) rotated += 1;
    if (page.source === -1) blanks += 1;
  }
  const real = pages.length - blanks;
  const removed = Math.max(0, originalCount - real);
  return { total: pages.length, rotated, blanks, removed };
}
