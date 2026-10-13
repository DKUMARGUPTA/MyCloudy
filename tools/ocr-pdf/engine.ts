/**
 * OCR engine — pure helpers for the ocr-pdf worker (PRD §8.4 "PDF OCR").
 *
 * Everything here is string/number math with zero DOM dependencies, so
 * the bun smoke tests can probe text probing and assembly directly (the
 * worker owns the impure canvas/tesseract half, mirroring the
 * compress-pdf engine/worker split).
 */

/** Joins one file's page texts into the final .txt body. */
export function joinTxtPages(
  pageTexts: string[],
  pageNumbers: number[],
  markPages: boolean
): string {
  const mark = markPages && pageTexts.length > 1;
  return pageTexts
    .map((text, i) =>
      mark
        ? `${i === 0 ? "" : "\n\n"}───── Page ${pageNumbers[i] + 1} ─────\n${text}`
        : text
    )
    .join(mark ? "" : "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Count of non-whitespace characters (probe + "did we find anything"). */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n += 1;
  }
  return n;
}

/**
 * Quick pass-through text for pages that already carry selectable text
 * when the OCR tool is used in text mode: joins pdf.js text items with
 * single spaces. Deliberately simpler than pdf-to-txt's flow builder —
 * the OCR tool's job here is completeness, not typography.
 */
export function joinTextItems(
  items: { str?: unknown }[],
  minChars: number
): { text: string; chars: number } {
  let text = "";
  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str.length === 0) continue;
    if (text.length > 0 && !text.endsWith(" ")) text += " ";
    text += str;
  }
  text = text.replace(/\s+/g, " ").trim();
  return { text, chars: countChars(text) >= minChars ? countChars(text) : 0 };
}
