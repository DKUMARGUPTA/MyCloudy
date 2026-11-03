/**
 * Extract attachments worker-lib (P3-d) — PURE naming helpers,
 * smoke-drivable without a Worker.
 */

/** Filesystem-safe output name (path parts stripped, fallback kept). */
export function sanitizeAttachmentName(raw: string, index: number): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  // Only underscores/dots left = no usable name — honest fallback.
  if (/^[_.\s]*$/.test(cleaned) || cleaned.length === 0) {
    return `attachment-${index + 1}.bin`;
  }
  return cleaned.slice(0, 180);
}

/**
 * Makes an output name unique against the taken set: same stem gets
 * " (2)", " (3)"… before the extension. Two PDFs carrying the same
 * attachment name must both survive on disk.
 */
export function uniqueOutputName(raw: string, taken: Set<string>): string {
  if (!taken.has(raw)) {
    taken.add(raw);
    return raw;
  }
  const dot = raw.lastIndexOf(".");
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem}-${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}
