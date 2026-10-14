/**
 * Pure output-name helpers for the image converter worker — kept free
 * of worker globals so scripts/smoke-imgconv.ts can verify them.
 */

/** Base name for outputs: strip ANY extension, sanitize for download. */
export function sanitizeBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120) || "image"
  );
}

/**
 * Stable output name: base.ext, base-2.ext, base-3.ext … on collisions
 * (two photos from different folders can share a file name).
 * `used` is mutated (per-base counter), matching the worker loop.
 */
export function allocateOutputName(
  base: string,
  ext: string,
  used: Map<string, number>
): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? `${base}.${ext}` : `${base}-${seen + 1}.${ext}`;
}
