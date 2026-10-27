/**
 * Compress-to-target-size ladder (PRD §7.5, "Iterative compress").
 *
 * The pure strategy: a fixed ladder of {quality, maxDim} rungs from gentle
 * to aggressive. Each attempt re-encodes the file's photos at a rung's
 * params; the FIRST rung whose output fits the target wins (best quality
 * that fits). If no rung fits, the smallest result is kept and reported
 * honestly. Both the target resolver and the search are pure and injectable
 * — scripts/smoke-compress-to-size.ts verifies every rule without a canvas.
 */

/** One compression attempt's parameters. */
export interface LadderRung {
  /** JPEG quality 0..1 for re-encoded photos. */
  quality: number;
  /** Cap for the longest image side, in pixels. */
  maxDim: number;
}

/**
 * Gentle → aggressive rungs. Starts at the compress "recommended" recipe,
 * passes through "strong", and keeps going for hard portals (50 KB upload
 * forms) down to the floor we still consider honest for photos (q0.08 /
 * 500px — below that a raster is mush and text should carry the file).
 */
export const TARGET_LADDER: readonly LadderRung[] = [
  { quality: 0.65, maxDim: 1600 },
  { quality: 0.55, maxDim: 1400 },
  { quality: 0.45, maxDim: 1200 },
  { quality: 0.36, maxDim: 1100 },
  { quality: 0.28, maxDim: 1000 },
  { quality: 0.22, maxDim: 900 },
  { quality: 0.17, maxDim: 820 },
  { quality: 0.13, maxDim: 740 },
  { quality: 0.10, maxDim: 660 },
  { quality: 0.08, maxDim: 560 },
  { quality: 0.08, maxDim: 500 },
];

/** Select values for the target preset (bytes as strings). */
export const TARGET_PRESET_BYTES = [
  "102400", // 100 KB
  "204800", // 200 KB
  "512000", // 500 KB
  "1048576", // 1 MB
] as const;

export const TARGET_MIN_KB = 20;
export const TARGET_MAX_KB = 51200; // 50 MB — bigger than any portal limit

const KB = 1024;

/**
 * Worker option values → target size in bytes. Preset values are exact
 * byte counts; "custom" reads the KB field (clamped to a sane range).
 * Falls back to 200 KB on unknown input.
 */
export function resolveTargetBytes(
  options: Record<string, unknown>
): number {
  const preset = String(options.target ?? "");
  if ((TARGET_PRESET_BYTES as readonly string[]).includes(preset)) {
    return Number(preset);
  }
  const kb = Math.round(Number(options.targetKb ?? 200));
  const clamped = Math.min(
    TARGET_MAX_KB,
    Math.max(TARGET_MIN_KB, Number.isFinite(kb) ? kb : 200)
  );
  return clamped * KB;
}

export interface LadderOutcome {
  /** Index of the winning rung (-1 when the ladder never ran). */
  rungIndex: number;
  /** Size the winning attempt achieved. */
  achievedBytes: number;
  /** True when achievedBytes ≤ target. */
  fitsTarget: boolean;
}

/**
 * Runs attempts rung by rung until one fits. `attempt` performs the heavy
 * work (re-encode photos at the rung's params, save) and returns the
 * achieved byte size; the caller owns the bytes via closure. Returns the
 * first fitting rung, or — when none fits — the SMALLEST attempt (index
 * tracked) with fitsTarget: false.
 */
export async function compressToTarget(
  targetBytes: number,
  attempt: (rung: LadderRung, rungIndex: number) => Promise<number>
): Promise<LadderOutcome> {
  let bestIndex = -1;
  let bestBytes = Number.POSITIVE_INFINITY;
  for (let index = 0; index < TARGET_LADDER.length; index += 1) {
    const achieved = await attempt(TARGET_LADDER[index], index);
    if (achieved <= targetBytes) {
      return { rungIndex: index, achievedBytes: achieved, fitsTarget: true };
    }
    if (achieved < bestBytes) {
      bestBytes = achieved;
      bestIndex = index;
    }
  }
  return {
    rungIndex: bestIndex,
    achievedBytes: Number.isFinite(bestBytes) ? bestBytes : 0,
    fitsTarget: false,
  };
}
