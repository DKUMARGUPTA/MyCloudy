/**
 * Stable cache key for a workspace File — same content → same key, so
 * re-adding or reordering a file never re-rasterises its SVG twin.
 * (Split into its own module so the pure-model surface tests stay light.)
 */
export function svgRasterKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}
