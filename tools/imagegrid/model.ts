/**
 * ImageGrid shared model (PRD §8.6 "Images to PDF") — pure data + ops used
 * by BOTH the interactive surface (main thread) and the worker, so the
 * serialized option the worker receives is always the exact edited state.
 *
 * An entry points at its source file index and carries a rotation delta in
 * quarter turns (0/90/180/270). Serialize format (same compactness idea as
 * the PageGrid model): JSON array of [source, rotation] tuples.
 */

export interface ImageEntry {
  uid: string;
  /** Index into the workspace `files` array. */
  source: number;
  /** Cumulative quarter-turn rotation (0/90/180/270, clockwise). */
  rotation: number;
}

export type ImageGridOption = string;

let uidSeq = 0;
function nextUid(): string {
  uidSeq += 1;
  return `ig-${Date.now().toString(36)}-${uidSeq}`;
}

/** Natural order — one entry per file, no rotation. */
export function createInitialImageGrid(fileCount: number): ImageEntry[] {
  return Array.from({ length: fileCount }, (_, source) => ({
    uid: nextUid(),
    source,
    rotation: 0,
  }));
}

export function serializeImageGrid(entries: ImageEntry[]): ImageGridOption {
  return JSON.stringify(entries.map((entry) => [entry.source, entry.rotation]));
}

/**
 * Parses the "images" option (or falls back to the natural order when the
 * value is missing/empty — the initial state before any edit). Returns null
 * only for structurally invalid data (safety net behind the CTA gate).
 */
export function parseImageGridOption(
  value: unknown,
  fileCount: number
): ImageEntry[] | null {
  if (value === undefined || value === null || value === "") {
    return createInitialImageGrid(fileCount);
  }
  if (typeof value !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const entries: ImageEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [source, rotation] = item;
    if (
      typeof source !== "number" ||
      !Number.isInteger(source) ||
      source < 0 ||
      source >= fileCount
    ) {
      return null;
    }
    if (
      typeof rotation !== "number" ||
      ![0, 90, 180, 270].includes(rotation)
    ) {
      return null;
    }
    entries.push({ uid: nextUid(), source, rotation });
  }
  return entries;
}

/* ------------------------------ pure ops ------------------------------ */

function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

export function rotateImageEntries(
  entries: ImageEntry[],
  indices: number[],
  delta: number
): ImageEntry[] {
  const targets = new Set(indices);
  return entries.map((entry, index) =>
    targets.has(index)
      ? { ...entry, rotation: normalizeRotation(entry.rotation + delta) }
      : entry
  );
}

export function deleteImageEntries(
  entries: ImageEntry[],
  indices: number[]
): ImageEntry[] {
  const targets = new Set(indices);
  return entries.filter((_, index) => !targets.has(index));
}

export function moveImageEntry(
  entries: ImageEntry[],
  from: number,
  to: number
): ImageEntry[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= entries.length ||
    to >= entries.length
  ) {
    return entries;
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * A→Z by the source file's name — the classic "IMG_101, IMG_100, IMG_102"
 * fixer. Numeric-aware, case-insensitive; ties keep the current order.
 */
export function sortEntriesByFileName(
  entries: ImageEntry[],
  fileNameOf: (source: number) => string
): ImageEntry[] {
  return [...entries].sort(
    (a, b) =>
      fileNameOf(a.source).localeCompare(fileNameOf(b.source), undefined, {
        numeric: true,
        sensitivity: "base",
      })
  );
}

/**
 * Reconciles the edited list against the live workspace files: keeps
 * existing entries for still-known sources (order + rotation preserved),
 * and appends entries for newly added files at the end. When files shrink,
 * entries are rebuilt defensively for still-valid sources.
 */
export function reconcileImageGrid(
  entries: ImageEntry[],
  fileCount: number,
  previousCount: number
): ImageEntry[] {
  if (fileCount === previousCount) return entries;
  const next: ImageEntry[] = [];
  const seen = new Set<number>();
  if (fileCount < previousCount) {
    // Keep order, drop vanished sources, then backfill any gaps.
    for (const entry of entries) {
      if (entry.source < fileCount && !seen.has(entry.source)) {
        next.push(entry);
        seen.add(entry.source);
      }
    }
  } else {
    for (const entry of entries) {
      if (!seen.has(entry.source)) {
        next.push(entry);
        seen.add(entry.source);
      }
    }
  }
  for (let source = 0; source < fileCount; source += 1) {
    if (!seen.has(source)) {
      next.push({ uid: nextUid(), source, rotation: 0 });
    }
  }
  return next;
}

/** Stats for the summary line / CTA copy. */
export function imageGridStats(entries: ImageEntry[]): {
  images: number;
  rotated: number;
} {
  let rotated = 0;
  for (const entry of entries) {
    if (entry.rotation !== 0) rotated += 1;
  }
  return { images: entries.length, rotated };
}
