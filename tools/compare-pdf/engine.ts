import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Compare PDFs — pure engine (PRD §8.5: "Two PDFs (Original, Revised).
 * Side-by-side (sync scroll), Overlay (red/green diff), Text-diff list;
 * sensitivity, ignore whitespace/case, page mapping, change list jump").
 *
 * Zero runtime imports — the interactive surface (live pairing + word diff
 * + overlay pixels), the report worker and the bun smoke script all share
 * this module, so the semantics are pinned BEFORE any UI exists:
 *
 *   resolveCompareOptions  option normalization (defensive, worker-side too)
 *   prepareText            whitespace collapse + honest case folding
 *   bigramSimilarity       order-aware-ish page similarity (0..1)
 *   pairPages              position pairing OR DP "smart" alignment
 *   classifyPair           equal / similar / different / added / removed
 *   wordDiff               prefix/suffix trim + bounded LCS word diff
 *   groupHunks             git-style change hunks with context words
 *   pixelDiff              red/green/purple overlay + changed ratio
 *   buildReportLines       the worker's report text sections
 *   classifyCompareError   pdf.js error → i18n key
 *
 * Option contract (the surface owns every input — search-pdf precedent;
 * the schema options array stays empty and the worker re-normalizes):
 *   sensitivity       "low" | "medium" | "high"   (default "medium")
 *   ignoreCase        boolean                     (default true)
 *   ignoreWhitespace  boolean                     (default true)
 *   pageMapping       "position" | "smart"         (default "smart")
 */

import type { RawTextItem } from "../search-pdf/engine";

export { joinPageText } from "../search-pdf/engine";
export type { RawTextItem } from "../search-pdf/engine";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export const CMP_IDS = {
  sensitivity: "sensitivity",
  ignoreCase: "ignoreCase",
  ignoreWhitespace: "ignoreWhitespace",
  pageMapping: "pageMapping",
} as const;

export type Sensitivity = "low" | "medium" | "high";
export type PageMapping = "position" | "smart";

export interface CompareOptions {
  sensitivity: Sensitivity;
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
  mapping: PageMapping;
}

export function resolveCompareOptions(
  options: OptionValues
): CompareOptions {
  const sensitivity = options[CMP_IDS.sensitivity];
  const mapping = options[CMP_IDS.pageMapping];
  return {
    sensitivity:
      sensitivity === "low" || sensitivity === "high" ? sensitivity : "medium",
    ignoreCase: options[CMP_IDS.ignoreCase] !== false,
    ignoreWhitespace: options[CMP_IDS.ignoreWhitespace] !== false,
    mapping: mapping === "position" ? "position" : "smart",
  };
}

/**
 * Sensitivity → per-pixel channel-delta threshold (0..765). Higher
 * sensitivity flags SMALLER pixel differences → lower threshold.
 */
export const PIXEL_THRESHOLD: Record<Sensitivity, number> = {
  low: 96,
  medium: 48,
  high: 20,
};

/** Similarity at or above this → pages count as "equal". */
export const SIM_EQUAL_AT: Record<Sensitivity, number> = {
  low: 0.99,
  medium: 0.995,
  high: 0.9985,
};

/** Similarity at or above this (but below equal) → "similar". */
export const SIM_SIMILAR_AT: Record<Sensitivity, number> = {
  low: 0.72,
  medium: 0.85,
  high: 0.92,
};

/* ------------------------------------------------------------------ */
/* Text preparation                                                    */
/* ------------------------------------------------------------------ */

export interface TextPrepOptions {
  ignoreCase: boolean;
  ignoreWhitespace: boolean;
}

/**
 * Normalize page text for comparison:
 *  - ignoreWhitespace → collapse ALL whitespace runs to single spaces and
 *    trim (line breaks vs spaces stop mattering);
 *  - ignoreCase → lowercase, BUT only when folding keeps the length (the
 *    İ-style expansion would silently misalign — we skip folding instead,
 *    same honest fallback as the search matcher).
 */
export function prepareText(
  text: string,
  opts: TextPrepOptions
): string {
  let out = text;
  if (opts.ignoreWhitespace) {
    out = out.replace(/\s+/g, " ").trim();
  }
  if (opts.ignoreCase) {
    const folded = out.toLowerCase();
    if (folded.length === out.length) out = folded;
  }
  return out;
}

/** Bigram set of a prepared text ("" → empty set). */
function bigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  if (text.length === 1) out.add(text);
  return out;
}

/**
 * Page similarity 0..1 — Jaccard over character bigrams. Word order mostly
 * survives (bigrams cross word boundaries), exact equal texts score 1.
 */
export function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const gram of setA) {
    if (setB.has(gram)) shared += 1;
  }
  return shared / (setA.size + setB.size - shared);
}

/* ------------------------------------------------------------------ */
/* Page pairing                                                        */
/* ------------------------------------------------------------------ */

export type PairKind = "both" | "added" | "removed";

export interface PagePair {
  /** 1-based page in the original, or null when the original has no match. */
  a: number | null;
  /** 1-based page in the revised, or null when the revised has no match. */
  b: number | null;
  kind: PairKind;
}

/** Smart mapping is bounded — beyond this a×b cell budget, fall back. */
export const SMART_PAIR_CELLS = 40_000;

/**
 * Pair the pages of two documents.
 *
 * "position" pairs page i with page i; the surplus becomes added/removed.
 *
 * "smart" runs a Needleman–Wunsch alignment over page similarities:
 * matching costs (1 − sim), a gap costs 1 — so equal pages snap together
 * and a page inserted mid-document shifts the pairing instead of turning
 * every later page "different". Falls back to position beyond the cell
 * budget (returned via `smartFallback` on the plan, reported honestly).
 */
export interface PairPlan {
  pairs: PagePair[];
  smartFallback: boolean;
}

export function pairPages(
  aCount: number,
  bCount: number,
  similarityAt: (aIndex: number, bIndex: number) => number,
  mapping: PageMapping
): PairPlan {
  const shared = Math.min(aCount, bCount);
  const pairs: PagePair[] = [];
  if (mapping === "position" || aCount * bCount > SMART_PAIR_CELLS) {
    for (let i = 0; i < shared; i += 1) {
      pairs.push({ a: i + 1, b: i + 1, kind: "both" });
    }
    for (let i = shared; i < aCount; i += 1) {
      pairs.push({ a: i + 1, b: null, kind: "removed" });
    }
    for (let i = shared; i < bCount; i += 1) {
      pairs.push({ a: null, b: i + 1, kind: "added" });
    }
    return {
      pairs,
      smartFallback:
        mapping === "smart" && aCount * bCount > SMART_PAIR_CELLS,
    };
  }

  // DP over (aCount+1) x (bCount+1), Float32 for the cost matrix and a
  // separate direction matrix for backtracking (0 = diag, 1 = up, 2 = left).
  const width = bCount + 1;
  const cost = new Float32Array((aCount + 1) * width);
  for (let i = 0; i <= aCount; i += 1) cost[i * width] = i;
  for (let j = 0; j <= bCount; j += 1) cost[j] = j;
  const dir = new Uint8Array((aCount + 1) * width);
  for (let i = 1; i <= aCount; i += 1) {
    for (let j = 1; j <= bCount; j += 1) {
      const diag =
        cost[(i - 1) * width + (j - 1)] + (1 - similarityAt(i - 1, j - 1));
      const up = cost[(i - 1) * width + j] + 1;
      const left = cost[i * width + (j - 1)] + 1;
      if (diag <= up && diag <= left) {
        cost[i * width + j] = diag;
        dir[i * width + j] = 0;
      } else if (up <= left) {
        cost[i * width + j] = up;
        dir[i * width + j] = 1;
      } else {
        cost[i * width + j] = left;
        dir[i * width + j] = 2;
      }
    }
  }
  const collected: PagePair[] = [];
  let i = aCount;
  let j = bCount;
  while (i > 0 || j > 0) {
    const d = i > 0 && j > 0 ? dir[i * width + j] : i > 0 ? 1 : 2;
    if (d === 0) {
      collected.push({ a: i, b: j, kind: "both" });
      i -= 1;
      j -= 1;
    } else if (d === 1) {
      collected.push({ a: i, b: null, kind: "removed" });
      i -= 1;
    } else {
      collected.push({ a: null, b: j, kind: "added" });
      j -= 1;
    }
  }
  collected.reverse();
  return { pairs: collected, smartFallback: false };
}

/** Pairing similarity matrix from prepared page texts (caches bigrams). */
export function buildPairSims(
  aTexts: string[],
  bTexts: string[],
  prep: TextPrepOptions
): number[][] {
  const gramsA = aTexts.map((t) => bigramSet(prepareText(t, prep)));
  const gramsB = bTexts.map((t) => bigramSet(prepareText(t, prep)));
  const out: number[][] = [];
  for (let i = 0; i < gramsA.length; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < gramsB.length; j += 1) {
      const setA = gramsA[i];
      const setB = gramsB[j];
      if (setA.size === 0 && setB.size === 0) {
        row.push(1);
        continue;
      }
      if (setA.size === 0 || setB.size === 0) {
        row.push(0);
        continue;
      }
      let shared = 0;
      for (const gram of setA) {
        if (setB.has(gram)) shared += 1;
      }
      row.push(shared / (setA.size + setB.size - shared));
    }
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pair classification                                                 */
/* ------------------------------------------------------------------ */

export type PairStatus =
  | "equal"
  | "similar"
  | "different"
  | "added"
  | "removed";

export function classifyPair(
  pair: PagePair,
  sim: number,
  sensitivity: Sensitivity
): PairStatus {
  if (pair.kind === "added") return "added";
  if (pair.kind === "removed") return "removed";
  if (sim >= SIM_EQUAL_AT[sensitivity]) return "equal";
  if (sim >= SIM_SIMILAR_AT[sensitivity]) return "similar";
  return "different";
}

/* ------------------------------------------------------------------ */
/* Word diff                                                           */
/* ------------------------------------------------------------------ */

export type DiffOpType = "same" | "del" | "add";

/** One diff run: raw tokens (original casing), never re-joined here. */
export interface DiffOp {
  type: DiffOpType;
  tokens: string[];
}

/** LCS DP cell budget — larger pages degrade to one big replace hunk. */
export const WORD_DIFF_CELLS = 2_500_000;

export interface WordDiffResult {
  ops: DiffOp[];
  /** False when the page was too large for the exact DP (one big hunk). */
  exact: boolean;
}

/** Whitespace split with empty-token filtering (whitespace-insensitive). */
export function tokenizeWords(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Word-level diff between two page texts. Tokens keep their original
 * casing for display; the diff keys are lowercased when `ignoreCase`.
 * Strategy: trim the common prefix/suffix, then exact LCS over the middle
 * when it fits the cell budget, else one honest whole-middle replace.
 */
export function wordDiff(
  aText: string,
  bText: string,
  prep: TextPrepOptions
): WordDiffResult {
  const aTokens = tokenizeWords(aText);
  const bTokens = tokenizeWords(bText);
  if (prep.ignoreCase) {
    const foldOk =
      aText.toLowerCase().length === aText.length &&
      bText.toLowerCase().length === bText.length;
    if (foldOk) {
      return diffTokens(
        aTokens.map((t) => t.toLowerCase()),
        bTokens.map((t) => t.toLowerCase()),
        aTokens,
        bTokens
      );
    }
  }
  return diffTokens(aTokens, bTokens, aTokens, bTokens);
}

function diffTokens(
  aKeys: string[],
  bKeys: string[],
  aDisplay: string[],
  bDisplay: string[]
): WordDiffResult {
  const n = aKeys.length;
  const m = bKeys.length;
  if (n === 0 && m === 0) return { ops: [], exact: true };
  if (n === 0) {
    return { ops: [{ type: "add", tokens: bDisplay.slice() }], exact: true };
  }
  if (m === 0) {
    return { ops: [{ type: "del", tokens: aDisplay.slice() }], exact: true };
  }

  // Common prefix.
  let start = 0;
  while (start < n && start < m && aKeys[start] === bKeys[start]) start += 1;
  // Common suffix (never overlapping the prefix).
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && aKeys[endA - 1] === bKeys[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops: DiffOp[] = [];
  if (start > 0) ops.push({ type: "same", tokens: aDisplay.slice(0, start) });
  const midN = endA - start;
  const midM = endB - start;

  if (midN === 0 && midM === 0) {
    // identical after trims
  } else if (midN === 0) {
    ops.push({ type: "add", tokens: bDisplay.slice(start, endB) });
  } else if (midM === 0) {
    ops.push({ type: "del", tokens: aDisplay.slice(start, endA) });
  } else if ((midN + 1) * (midM + 1) <= WORD_DIFF_CELLS) {
    // Classic LCS DP over the trimmed middle. dp is (midN+1) x (midM+1).
    const width = midM + 1;
    const dp = new Uint32Array((midN + 1) * width);
    for (let i = 1; i <= midN; i += 1) {
      const rowOff = i * width;
      const prevOff = rowOff - width;
      const aKey = aKeys[start + i - 1];
      for (let j = 1; j <= midM; j += 1) {
        dp[rowOff + j] =
          aKey === bKeys[start + j - 1]
            ? dp[prevOff + (j - 1)] + 1
            : Math.max(dp[prevOff + j], dp[rowOff + (j - 1)]);
      }
    }
    // Backtrack (collect backwards, then reverse).
    const midOps: DiffOp[] = [];
    let i = midN;
    let j = midM;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && aKeys[start + i - 1] === bKeys[start + j - 1]) {
        pushOp(midOps, "same", aDisplay[start + i - 1]);
        i -= 1;
        j -= 1;
      } else if (
        j === 0 ||
        (i > 0 && dp[(i - 1) * width + j] >= dp[i * width + (j - 1)])
      ) {
        pushOp(midOps, "del", aDisplay[start + i - 1]);
        i -= 1;
      } else {
        pushOp(midOps, "add", bDisplay[start + j - 1]);
        j -= 1;
      }
    }
    midOps.reverse();
    ops.push(...midOps);
  } else {
    // Too large for the exact DP — one honest big replace hunk.
    ops.push({ type: "del", tokens: aDisplay.slice(start, endA) });
    ops.push({ type: "add", tokens: bDisplay.slice(start, endB) });
    if (endA < n) ops.push({ type: "same", tokens: aDisplay.slice(endA) });
    return { ops, exact: false };
  }

  if (endA < n) ops.push({ type: "same", tokens: aDisplay.slice(endA) });
  return { ops: mergeAdjacent(ops), exact: true };
}

function pushOp(ops: DiffOp[], type: DiffOpType, token: string): void {
  const last = ops[ops.length - 1];
  if (last !== undefined && last.type === type) {
    last.tokens.push(token);
  } else {
    ops.push({ type, tokens: [token] });
  }
}

function mergeAdjacent(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last !== undefined && last.type === op.type) {
      last.tokens.push(...op.tokens);
    } else {
      out.push(op);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Change hunks                                                        */
/* ------------------------------------------------------------------ */

export type HunkKind = "add" | "del" | "change";

export interface TextHunk {
  kind: HunkKind;
  /** Context + removed + context, original casing ("" for pure additions). */
  before: string;
  /** Context + added + context, original casing ("" for pure deletions). */
  after: string;
}

export const HUNK_CONTEXT_WORDS = 4;
/** Gap of unchanged words that still merges two hunks into one. */
export const HUNK_MERGE_GAP = 8;
/** Honest cap shared by the surface list and the report. */
export const MAX_HUNKS = 400;

/**
 * Git-style hunks: every maximal del/add run becomes one hunk; runs
 * separated by ≤ HUNK_MERGE_GAP unchanged words merge; HUNK_CONTEXT_WORDS
 * of context surround each side (clamped to the page's edges).
 */
export function groupHunks(
  ops: DiffOp[],
  contextWords = HUNK_CONTEXT_WORDS,
  maxHunks = MAX_HUNKS
): TextHunk[] {
  // Flatten to per-token kinds first (grouping needs token granularity).
  const kinds: ("same" | "del" | "add")[] = [];
  const tokens: string[] = [];
  for (const op of ops) {
    for (const token of op.tokens) {
      kinds.push(op.type);
      tokens.push(token);
    }
  }
  const hunks: TextHunk[] = [];
  let i = 0;
  while (i < kinds.length) {
    if (hunks.length >= maxHunks) break; // honest cap, checked FIRST
    if (kinds[i] === "same") {
      i += 1;
      continue;
    }
    // Start of a change run — find where this run (plus any short gap and
    // the NEXT run) ends, merging across small unchanged gaps like git.
    let runEnd = i;
    for (;;) {
      while (runEnd < kinds.length && kinds[runEnd] !== "same") runEnd += 1;
      let gap = 0;
      while (
        runEnd + gap < kinds.length &&
        kinds[runEnd + gap] === "same"
      ) {
        gap += 1;
      }
      const moreChanges = runEnd + gap < kinds.length;
      if (moreChanges && gap <= HUNK_MERGE_GAP) {
        runEnd = runEnd + gap;
      } else {
        break;
      }
    }
    const left = Math.max(0, i - contextWords);
    const right = Math.min(tokens.length, runEnd + contextWords);
    const before: string[] = [];
    const after: string[] = [];
    let delCount = 0;
    let addCount = 0;
    for (let k = left; k < right; k += 1) {
      if (k < i || k >= runEnd) {
        // context token
        before.push(tokens[k]);
        after.push(tokens[k]);
      } else {
        if (kinds[k] === "del") {
          before.push(tokens[k]);
          delCount += 1;
        }
        if (kinds[k] === "add") {
          after.push(tokens[k]);
          addCount += 1;
        }
      }
    }
    const kind: HunkKind =
      delCount > 0 && addCount > 0 ? "change" : addCount > 0 ? "add" : "del";
    hunks.push({
      kind,
      // A pure addition shows one green line, a pure deletion one red —
      // context stays on the side that carries the change.
      before: kind === "add" ? "" : before.join(" "),
      after: kind === "del" ? "" : after.join(" "),
    });
    i = Math.max(runEnd, i + 1);
  }
  return hunks;
}

/** Word counts removed/added across a diff (true counts, not hunk-capped). */
export function diffWordStats(ops: DiffOp[]): {
  removed: number;
  added: number;
} {
  let removed = 0;
  let added = 0;
  for (const op of ops) {
    if (op.type === "del") removed += op.tokens.length;
    else if (op.type === "add") added += op.tokens.length;
  }
  return { removed, added };
}

/* ------------------------------------------------------------------ */
/* Pixel diff (overlay view + report images)                           */
/* ------------------------------------------------------------------ */

/** A pixel clearly carries content (ink) when r+g+b is below this. */
const INK_LUMA_MAX = 700; // out of 765

export interface PixelDiffOutcome {
  /** Fraction of pixels that differ (0..1). */
  changedRatio: number;
  /** Fraction of pixels with original-only ink. */
  removedRatio: number;
  /** Fraction of pixels with revised-only ink. */
  addedRatio: number;
  /** Fraction where both sides have ink but they differ. */
  modifiedRatio: number;
  /** RGBA overlay pixels (same length as the inputs). */
  out: Uint8ClampedArray;
}

/**
 * Red/green/purple overlay diff of two same-size RGBA buffers:
 *  - same (channel delta sum ≤ threshold) → white;
 *  - removed (ink only in A) → red;
 *  - added (ink only in B) → green;
 *  - modified (ink in both, but different) → purple;
 *  - both blank yet above threshold (anti-aliasing noise) → pale yellow.
 * `out` may alias `a` (the caller's render buffer) to save a copy.
 */
export function pixelDiff(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  threshold: number,
  out?: Uint8ClampedArray
): PixelDiffOutcome {
  if (a.length !== b.length) {
    throw new Error(`pixel-diff: length mismatch ${a.length} vs ${b.length}`);
  }
  const dst = out ?? new Uint8ClampedArray(a.length);
  let changed = 0;
  let removed = 0;
  let added = 0;
  let modified = 0;
  const total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const delta =
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
    if (delta <= threshold) {
      dst[i] = 255;
      dst[i + 1] = 255;
      dst[i + 2] = 255;
    } else {
      changed += 1;
      const inkA = a[i] + a[i + 1] + a[i + 2] < INK_LUMA_MAX;
      const inkB = b[i] + b[i + 1] + b[i + 2] < INK_LUMA_MAX;
      if (inkA && !inkB) {
        removed += 1;
        dst[i] = 222;
        dst[i + 1] = 52;
        dst[i + 2] = 52;
      } else if (!inkA && inkB) {
        added += 1;
        dst[i] = 40;
        dst[i + 1] = 160;
        dst[i + 2] = 80;
      } else if (inkA && inkB) {
        modified += 1;
        dst[i] = 148;
        dst[i + 1] = 84;
        dst[i + 2] = 200;
      } else {
        dst[i] = 255;
        dst[i + 1] = 235;
        dst[i + 2] = 130;
      }
    }
    dst[i + 3] = 255;
  }
  return {
    changedRatio: total > 0 ? changed / total : 0,
    removedRatio: total > 0 ? removed / total : 0,
    addedRatio: total > 0 ? added / total : 0,
    modifiedRatio: total > 0 ? modified / total : 0,
    out: dst,
  };
}

/* ------------------------------------------------------------------ */
/* Report lines (the worker writes English-only report pages — the    */
/* pinned rule is workers never know the locale)                      */
/* ------------------------------------------------------------------ */

export interface ReportPairLine {
  pairIndex: number;
  a: number | null;
  b: number | null;
  status: PairStatus;
  sim: number;
  removedWords: number;
  addedWords: number;
  changedRatio: number | null;
}

export interface ReportHunkLine {
  a: number | null;
  b: number | null;
  hunk: TextHunk;
}

export interface ReportContext {
  aName: string;
  bName: string;
  aPages: number;
  bPages: number;
  options: CompareOptions;
  pairs: ReportPairLine[];
  hunks: ReportHunkLine[];
  hunksCapped: boolean;
  imagesCapped: boolean;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.1 ? 2 : 1)}%`;
}

function statusLabel(status: PairStatus): string {
  switch (status) {
    case "equal":
      return "same";
    case "similar":
      return "minor change";
    case "different":
      return "changed";
    case "added":
      return "added in revised";
    case "removed":
      return "removed from original";
  }
}

/** Summary + pair table + change list as plain lines (the report body). */
export function buildReportLines(ctx: ReportContext): string[] {
  const lines: string[] = [];
  const counts = { equal: 0, similar: 0, different: 0, added: 0, removed: 0 };
  for (const pair of ctx.pairs) counts[pair.status] += 1;
  lines.push("SUMMARY");
  lines.push(
    `Original: ${ctx.aName} (${ctx.aPages} pages)`,
    `Revised: ${ctx.bName} (${ctx.bPages} pages)`,
    `Sensitivity: ${ctx.options.sensitivity} | ignore case: ${ctx.options.ignoreCase ? "yes" : "no"} | ignore whitespace: ${ctx.options.ignoreWhitespace ? "yes" : "no"} | page mapping: ${ctx.options.mapping}`
  );
  lines.push(
    `Page pairs: ${ctx.pairs.length} — ${counts.equal} same, ${counts.similar} minor, ${counts.different} changed, ${counts.added} added, ${counts.removed} removed`
  );
  if (ctx.pairs.length > 0 && counts.equal === ctx.pairs.length) {
    lines.push("", "The two PDFs are equivalent under these settings.");
  }
  lines.push("", "PAGE PAIRS");
  for (const pair of ctx.pairs) {
    const left = pair.a === null ? "  —" : `p${pair.a}`;
    const right = pair.b === null ? "—  " : `p${pair.b}`;
    const sim =
      pair.status === "equal" ||
      pair.status === "similar" ||
      pair.status === "different"
        ? ` ${Math.round(pair.sim * 100)}% alike`
        : "";
    const words =
      pair.removedWords > 0 || pair.addedWords > 0
        ? ` | words -${pair.removedWords}/+${pair.addedWords}`
        : "";
    const pixels =
      pair.changedRatio !== null
        ? ` | ${formatPercent(pair.changedRatio)} of pixels differ`
        : "";
    lines.push(
      `${String(pair.pairIndex + 1).padStart(2)}. ${left} vs ${right}: ${statusLabel(pair.status)}${sim}${words}${pixels}`
    );
  }
  if (ctx.hunks.length > 0) {
    lines.push("", "TEXT CHANGES");
    let lastA: number | null = -1;
    let lastB: number | null = -1;
    for (const item of ctx.hunks) {
      if (item.a !== lastA || item.b !== lastB) {
        if (lastA !== -1) lines.push("");
        const left = item.a === null ? "new page" : `page ${item.a}`;
        const right = item.b === null ? "removed page" : `page ${item.b}`;
        lines.push(left === right ? `[${left}]` : `[${left} vs ${right}]`);
        lastA = item.a;
        lastB = item.b;
      }
      if (item.hunk.kind === "add") {
        lines.push(`  + ${item.hunk.after}`);
      } else if (item.hunk.kind === "del") {
        lines.push(`  - ${item.hunk.before}`);
      } else {
        lines.push(`  - ${item.hunk.before}`);
        lines.push(`  + ${item.hunk.after}`);
      }
    }
  }
  const notes: string[] = [];
  if (ctx.hunksCapped) {
    notes.push(`text changes capped at the first ${MAX_HUNKS}`);
  }
  if (ctx.imagesCapped) {
    notes.push(
      "changed-page images capped — later pairs are in the PAGE PAIRS table only"
    );
  }
  if (notes.length > 0) {
    lines.push("", `NOTES: ${notes.join("; ")}`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/** pdf.js failure → the i18n key the shell toast shows (search-pdf family). */
export function classifyCompareError(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}
