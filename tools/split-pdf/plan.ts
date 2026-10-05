/**
 * Split PDF — shared plan logic (PRD §8.1, 7 modes).
 *
 * Pure functions only (no pdf-lib, no pdf.js, no DOM) so the SAME code runs
 * in the custom panel for the live preview ("N files banengi") and in the
 * tool worker for the authoritative split. Options travel the standard
 * worker protocol; bookmark cuts and blank pages are detected on the main
 * thread with pdf.js and passed in as plain arrays.
 */

export type SplitMode =
  | "range"
  | "everyN"
  | "bookmarks"
  | "size"
  | "visual"
  | "oddEven"
  | "blanks";

/** One parsed range item, 1-based inclusive, already clamped to the doc. */
export interface RangeItem {
  from: number;
  to: number;
}

/** One output part: 0-based page indices in output order. */
export interface SplitPart {
  pages: number[];
  /** Semantic label for the panel ("odd"/"even"); not used for file names. */
  label?: string;
}

export interface SplitPlan {
  parts: SplitPart[];
  /** True when part boundaries are estimates (size mode: refined in worker). */
  estimated: boolean;
}

export interface SplitPlanInput {
  mode: SplitMode;
  pageCount: number;
  fileSize: number;
  ranges: string;
  oneFilePerRange: boolean;
  everyN: number;
  maxSizeMb: number;
  /** Visual mode: 1-based page numbers a cut happens AFTER. */
  cutAfter: number[];
  /** Bookmarks mode: 1-based pages where a new part starts (bookmark dests). */
  bookmarkCuts: number[];
  /** Blanks mode: 1-based blank pages (detected, act as separators). */
  blankPages: number[];
}

/**
 * Parses a range list like "1-5, 8, 10-end" (PRD §8.1 mode 1).
 * Accepted item shapes: `N`, `N-M`, `N-` (to end), `end`, `10-end`.
 * Case-insensitive "end" = last page. Whitespace and commas both separate.
 * Returns null when nothing parses or the syntax is invalid.
 */
export function parseRangeList(
  spec: string,
  pageCount: number
): RangeItem[] | null {
  const trimmed = spec.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  const items: RangeItem[] = [];
  for (const raw of lower.split(/[,\s]+/)) {
    const part = raw.trim();
    if (part === "") continue;
    const match = /^(\d+|end)(?:\s*-\s*(\d+|end)?)?$/.exec(part);
    if (!match) return null;
    const resolve = (token: string | undefined): number | null => {
      if (token === undefined || token === "") return null;
      if (token === "end") return pageCount;
      const value = Number.parseInt(token, 10);
      return Number.isFinite(value) && value >= 1 ? value : null;
    };
    const start = resolve(match[1]);
    if (start === null) return null;
    const endRaw = match[2];
    const end =
      endRaw === undefined || endRaw === "" ? start : resolve(endRaw);
    if (end === null) return null;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    // Clamp into the document; fully out-of-range items are skipped silently
    // ("page 99" in a 10-page doc is a no-op, not an error — the PRD only
    // requires ranges to stay within the page count for validation).
    const lo = Math.max(1, from);
    const hi = Math.min(pageCount, to);
    if (lo > hi) continue;
    items.push({ from: lo, to: hi });
  }
  return items.length > 0 ? items : null;
}

/** True when any two range items share a page (PRD: "overlap warning"). */
export function rangesOverlap(items: RangeItem[]): boolean {
  const marks = new Set<number>();
  for (const item of items) {
    for (let page = item.from; page <= item.to; page += 1) {
      if (marks.has(page)) return true;
      marks.add(page);
    }
  }
  return false;
}

function chunksOf(pageCount: number, size: number): SplitPart[] {
  const parts: SplitPart[] = [];
  const step = Math.max(1, Math.min(pageCount, Math.floor(size) || 1));
  for (let start = 0; start < pageCount; start += step) {
    const pages: number[] = [];
    for (let p = start; p < Math.min(start + step, pageCount); p += 1) {
      pages.push(p);
    }
    parts.push({ pages });
  }
  return parts;
}

function partsFromCuts(pageCount: number, cutsAfter: number[]): SplitPart[] {
  // cutsAfter: 1-based page numbers a cut occurs AFTER (end of part).
  const valid = [...new Set(cutsAfter)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page < pageCount)
    .sort((a, b) => a - b);
  const parts: SplitPart[] = [];
  let start = 0; // 0-based
  for (const cut of valid) {
    const end = cut; // 0-based exclusive (cut after page `cut` = index cut-1)
    if (end > start) {
      const pages: number[] = [];
      for (let p = start; p < end; p += 1) pages.push(p);
      parts.push({ pages });
    }
    start = end;
  }
  if (start < pageCount) {
    const pages: number[] = [];
    for (let p = start; p < pageCount; p += 1) pages.push(p);
    parts.push({ pages });
  }
  return parts;
}

/**
 * Computes the split plan for any mode. Returns null only for invalid range
 * syntax (worker surfaces `tool.errorInvalidPages`); modes with nothing to
 * do (e.g. no bookmarks) return an empty `parts` array and the caller
 * decides how to explain it.
 */
export function computeSplitPlan(input: SplitPlanInput): SplitPlan | null {
  const { mode, pageCount, fileSize } = input;
  if (pageCount < 1) return { parts: [], estimated: false };

  switch (mode) {
    case "range": {
      const items = parseRangeList(input.ranges, pageCount);
      if (items === null) return null;
      if (input.oneFilePerRange) {
        return {
          parts: items.map((item) => ({
            pages: rangeToIndices(item),
          })),
          estimated: false,
        };
      }
      // One file: union of all ranges, deduped, ascending.
      const picked = new Set<number>();
      for (const item of items) {
        for (const index of rangeToIndices(item)) picked.add(index);
      }
      return {
        parts: [{ pages: [...picked].sort((a, b) => a - b) }],
        estimated: false,
      };
    }

    case "everyN": {
      const n = Number(input.everyN);
      return { parts: chunksOf(pageCount, n), estimated: false };
    }

    case "bookmarks": {
      // Each top-level bookmark starts a part; pages before the first
      // bookmark form their own leading part.
      const starts = [...new Set(input.bookmarkCuts)]
        .filter(
          (page) => Number.isInteger(page) && page >= 1 && page <= pageCount
        )
        .sort((a, b) => a - b);
      const parts: SplitPart[] = [];
      let cursor = 1;
      for (const start of starts) {
        if (start > cursor) {
          const pages: number[] = [];
          for (let p = cursor; p < start; p += 1) pages.push(p - 1);
          if (pages.length > 0) parts.push({ pages });
        }
        cursor = Math.max(cursor, start);
      }
      if (cursor <= pageCount) {
        const pages: number[] = [];
        for (let p = cursor; p <= pageCount; p += 1) pages.push(p - 1);
        if (pages.length > 0) parts.push({ pages });
      }
      return { parts, estimated: false };
    }

    case "size": {
      // Estimate pages per part from the average page size; the worker
      // verifies with real saves and splits oversized parts further.
      const maxBytes =
        Math.max(0.1, Number(input.maxSizeMb) || 1) * 1024 * 1024;
      const avg = Math.max(1, fileSize / pageCount);
      const est = Math.floor((maxBytes * 0.92) / avg);
      return {
        parts: chunksOf(pageCount, Math.max(1, est)),
        estimated: true,
      };
    }

    case "visual": {
      return {
        parts: partsFromCuts(pageCount, input.cutAfter),
        estimated: false,
      };
    }

    case "oddEven": {
      const odd: number[] = [];
      const even: number[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        (page % 2 === 1 ? odd : even).push(page - 1);
      }
      const parts: SplitPart[] = [];
      if (odd.length > 0) parts.push({ pages: odd, label: "odd" });
      if (even.length > 0) parts.push({ pages: even, label: "even" });
      return { parts, estimated: false };
    }

    case "blanks": {
      // Blank pages act as separators: they are removed and each starts a
      // new part (PRD §8.1 mode 7 "blank page detect").
      const blanks = new Set(
        input.blankPages.filter(
          (page) => Number.isInteger(page) && page >= 1 && page <= pageCount
        )
      );
      const parts: SplitPart[] = [];
      let current: number[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        if (blanks.has(page)) {
          if (current.length > 0) parts.push({ pages: current });
          current = [];
          continue;
        }
        current.push(page - 1);
      }
      if (current.length > 0) parts.push({ pages: current });
      return { parts, estimated: false };
    }

    default:
      return { parts: [], estimated: false };
  }
}

function rangeToIndices(item: RangeItem): number[] {
  const pages: number[] = [];
  for (let page = item.from; page <= item.to; page += 1) pages.push(page - 1);
  return pages;
}

/**
 * Safely parses a JSON string option into a number array (worker + panel
 * both receive cut/bookmark/blank lists as JSON-encoded option values).
 */
export function parseNumberListOption(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value)
    );
  } catch {
    return [];
  }
}

/** File identity key used to keep detected lists tied to their file. */
export function fileKey(name: string, size: number): string {
  return `${name}|${size}`;
}
