/**
 * PURE CBZ helpers (P3-c, R57) — entry filtering + natural page order.
 *
 * Comics are numbered files inside a ZIP. Readers expect:
 *   - only image entries (junk like __MACOSX/ and .DS_Store skipped)
 *   - NATURAL order — "page-2" before "page-10", folders grouping their
 *     own children — never raw byte-wise string order.
 *
 * Both functions are pure string logic: the smoke battery proves the
 * ordering on the classic tricky names.
 */

/** Image extensions a CBZ may legally contain (case-insensitive match). */
export const CBZ_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".psd",
  ".avif",
] as const;

export function hasImageExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return (CBZ_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** macOS/Windows archive junk + dotfiles — never comic pages. */
export function isJunkEntry(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return true;
  const lower = path.toLowerCase();
  return lower.startsWith("__macosx/") || lower.includes("/__macosx/");
}

/**
 * Natural (human) comparison: digit runs compare numerically, everything
 * else case-insensitively. Shorter number sorts first on value ties
 * ("2" before "02" is impossible to distinguish, so we keep the stable
 * shorter-first rule).
 */
export function naturalCompare(a: string, b: string): number {
  let ia = 0;
  let ib = 0;
  while (ia < a.length && ib < b.length) {
    const da = a.charCodeAt(ia);
    const db = b.charCodeAt(ib);
    const aDigit = da >= 48 && da <= 57;
    const bDigit = db >= 48 && db <= 57;
    if (aDigit && bDigit) {
      // read both number runs
      let ja = ia;
      while (ja < a.length && a.charCodeAt(ja) >= 48 && a.charCodeAt(ja) <= 57) ja += 1;
      let jb = ib;
      while (jb < b.length && b.charCodeAt(jb) >= 48 && b.charCodeAt(jb) <= 57) jb += 1;
      const na = a.slice(ia, ja);
      const nb = b.slice(ib, jb);
      // numeric compare without precision loss: strip leading zeros,
      // then by length, then digit-wise
      const ta = na.replace(/^0+/, "") || "0";
      const tb = nb.replace(/^0+/, "") || "0";
      if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
      ia = ja;
      ib = jb;
      continue;
    }
    const ca = a[ia]!.toLowerCase();
    const cb = b[ib]!.toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    ia += 1;
    ib += 1;
  }
  if (ia < a.length) return 1;
  if (ib < b.length) return -1;
  return 0;
}

/** Filter to image entries, drop junk, natural-sorted. */
export function filterAndSortImageEntries(paths: string[]): string[] {
  return paths
    .filter((p) => !isJunkEntry(p) && hasImageExtension(p))
    .sort(naturalCompare);
}
