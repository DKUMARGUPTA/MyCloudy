/**
 * Duplex-collate plan builder (P1-d / R53) — PURE module, no DOM/worker
 * imports, so the smoke battery exercises exactly what ships.
 *
 * A duplex scan without a duplex-capable scanner produces TWO blocks: every
 * FRONT (odd pages 1, 3, 5…) followed by every BACK — and how the BACKS are
 * ordered depends on the physical flip:
 *
 *   short-edge flip (calendar, top-over): backs read in order 2, 4, 6…
 *   long-edge  flip (book, left-over):    backs reversed  …6, 4, 2
 *
 * The plan interleaves fronts and their matching backs so the output reads
 * 1, 2, 3, 4… again. Everything is plain index math over the organize plan
 * (page copies are byte-exact; blanks reuse the source page's MediaBox).
 */

export type DuplexLayout = "fronts-first" | "backs-first";
export type DuplexFlip = "short-edge" | "long-edge";

export interface DuplexOptions {
  layout: DuplexLayout;
  flip: DuplexFlip;
  /** Append a blank back when the last sheet's back was never scanned. */
  padBlank: boolean;
}

/** One plan entry: copy source page `src`, or a blank sized like `likeSrc`. */
export type DuplexPlanEntry =
  | { kind: "page"; src: number }
  | { kind: "blank"; likeSrc: number };

export interface DuplexPlan {
  plan: DuplexPlanEntry[];
  /** False when the plan is the identity permutation with no blanks. */
  changed: boolean;
  /** How many blank backs were padded (0 or 1). */
  blanks: number;
}

const LAYOUTS = new Set<DuplexLayout>(["fronts-first", "backs-first"]);
const FLIPS = new Set<DuplexFlip>(["short-edge", "long-edge"]);

export function normalizeDuplexOptions(raw: {
  layout?: unknown;
  flip?: unknown;
  padBlank?: unknown;
}): DuplexOptions {
  const layout =
    typeof raw.layout === "string" && LAYOUTS.has(raw.layout as DuplexLayout)
      ? (raw.layout as DuplexLayout)
      : "fronts-first";
  const flip =
    typeof raw.flip === "string" && FLIPS.has(raw.flip as DuplexFlip)
      ? (raw.flip as DuplexFlip)
      : "long-edge";
  const padBlank = raw.padBlank === true;
  return { layout, flip, padBlank };
}

/**
 * Builds the interleave plan. `pageCount` >= 1. Fronts are the larger half
 * when the count is odd (the last front has no scanned back — optionally
 * padded with a blank sized like it).
 */
export function buildDuplexPlan(
  pageCount: number,
  opts: DuplexOptions,
): DuplexPlan {
  const n = Math.floor(pageCount);
  if (!Number.isFinite(n) || n < 1) {
    return { plan: [], changed: false, blanks: 0 };
  }

  // Block split: fronts = ceil(n/2) sheets, backs = floor(n/2).
  const frontCount = Math.ceil(n / 2);
  const backCount = n - frontCount;

  // fronts-block / backs-block are the file indices each block occupies.
  const frontBlockStart = opts.layout === "fronts-first" ? 0 : backCount;
  const backBlockStart = opts.layout === "fronts-first" ? frontCount : 0;

  const plan: DuplexPlanEntry[] = [];
  for (let sheet = 0; sheet < frontCount; sheet += 1) {
    // The front of this sheet (reading order: sheet 0 = page 1).
    plan.push({ kind: "page", src: frontBlockStart + sheet });

    // The matching back: short-edge keeps block order, long-edge reverses.
    const backIndex =
      opts.flip === "long-edge" ? backCount - 1 - sheet : sheet;
    if (backIndex >= 0 && backIndex < backCount) {
      plan.push({ kind: "page", src: backBlockStart + backIndex });
    } else if (opts.padBlank) {
      // Odd page count: the last sheet's back is missing — pad it.
      plan.push({ kind: "blank", likeSrc: frontBlockStart + sheet });
    }
  }

  // Identity check: a 1–2 page file (or a pathological equal arrangement)
  // produces the same order — the honest refusal beats a fake output.
  const isIdentity =
    plan.length === n && plan.every((e, i) => e.kind === "page" && e.src === i);

  const blanks = plan.length - n;
  return { plan, changed: !isIdentity, blanks: blanks > 0 ? blanks : 0 };
}
