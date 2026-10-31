/**
 * PDF to JSON (P3-a / R55) — the PURE structured-document engine.
 *
 * Distinct from prepare-pdf-for-ai (RAG chunks): this is the developer /
 * data-interchange dump — the document as machine-readable structure.
 * Every page carries its geometry (width/height in PDF points, rotation),
 * its extracted text (flow or per-line), counts, and optionally the raw
 * text items with x/y positions and font sizes for people who want to do
 * their own layout analysis.
 *
 * 100% deterministic: the clock is injected (smoke passes a fixed value).
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

export interface JsonTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

export interface JsonPage {
  page: number;
  /** Page width in PDF points (viewport at scale 1). */
  width: number;
  /** Page height in PDF points (viewport at scale 1). */
  height: number;
  /** Page /Rotate value in degrees (0/90/180/270). */
  rotation: number;
  text: string;
  charCount: number;
  wordCount: number;
  /** Present when the caller asked for per-item geometry. */
  textItems?: JsonTextItem[];
}

export interface PdfJsonDoc {
  document: {
    fileName: string;
    fileSize: number;
    pageCount: number;
    charCount: number;
    wordCount: number;
    languageHint: string;
    exportedBy: string;
    exportedAt: string;
  };
  pages: JsonPage[];
}

export interface PdfJsonOptions {
  layout: "flow" | "lines";
  includeTextItems: boolean;
  fileName: string;
  fileSize: number;
  /** ISO timestamp — injected so smoke runs stay byte-deterministic. */
  now: string;
}

export const PDF_JSON_BY = "DocoPDF pdf-to-json";

/** Script-agnostic word count (matras stay attached — the R54 lesson). */
export function wordCount(text: string): number {
  const m = text.match(/[\p{L}\p{M}\p{N}]+/gu);
  return m ? m.length : 0;
}

/** Language hint from script ratios (en / hi / mixed / ""). */
export function languageHint(text: string): string {
  const sample = text.slice(0, 20_000);
  const letters = sample.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return "";
  let deva = 0;
  let latin = 0;
  for (const ch of letters) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097f) deva += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      latin += 1;
  }
  const total = letters.length;
  const devaRatio = deva / total;
  const latinRatio = latin / total;
  if (devaRatio >= 0.25 && latinRatio >= 0.25) return "mixed";
  if (devaRatio >= 0.25) return "hi";
  if (latinRatio >= 0.25) return "en";
  return "";
}

/**
 * Builds the structured document from extracted pages. Returns null when
 * no page carries selectable text (the honest scan refusal upstream).
 */
export function buildPdfJson(
  pages: JsonPage[],
  options: PdfJsonOptions,
): PdfJsonDoc | null {
  const withAnyText = pages.filter((p) => p.text.trim().length > 0);
  if (withAnyText.length === 0) return null;
  const fullText = pages.map((p) => p.text).join("\n\n");
  return {
    document: {
      fileName: options.fileName,
      fileSize: options.fileSize,
      pageCount: pages.length,
      charCount: fullText.replace(/\s/g, "").length,
      wordCount: wordCount(fullText),
      languageHint: languageHint(fullText),
      exportedBy: PDF_JSON_BY,
      exportedAt: options.now,
    },
    pages: options.includeTextItems
      ? pages
      : pages.map(({ textItems: _drop, ...rest }) => rest),
  };
}

/** Pretty 2-space JSON render with a trailing newline (file convention). */
export function renderPdfJson(doc: PdfJsonDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
