import { loadPdfjs, PDF_DOC_PARAMS } from "@/lib/pdf/pdfjs";
import {
  type PatternId,
  type RedactKind,
  type RedactMark,
  type TextLine,
  type Transform6,
  buildLines,
  buildPieces,
  displayRectToFraction,
  piecesForRange,
  regexMatches,
  termMatches,
  unionRects,
  userRectToDisplay,
  pieceUserBox,
} from "./engine";

/**
 * Redact PDF text search (main thread).
 *
 * Extracts positioned text once per file with the self-hosted pdf.js (the
 * same module every preview uses — no second copy of the library) and turns
 * pattern/term hits into display-fraction marks the surface can render and
 * the worker can paint. The extraction is cached per File object (WeakMap),
 * so "Find" re-scans are instant and page flips never re-parse the file.
 */

/** One page's searchable text + display geometry. */
export interface PageText {
  pageIndex: number;
  lines: TextLine[];
  /** Display dims at scale 1, pdf.js rotation applied. */
  dispW: number;
  dispH: number;
  /** User-space → display-space transform (viewport, scale 1). */
  transform: Transform6;
}

/** Padding around a found run of text (display px, scale-1 units). */
const MATCH_PAD_PT = 2;

const cache = new WeakMap<File, Promise<PageText[]>>();

/** Extracts positioned text for every page (cached per File object). */
export function extractPageTexts(file: File): Promise<PageText[]> {
  const cached = cache.get(file);
  if (cached) return cached;
  const promise = (async (): Promise<PageText[]> => {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
    try {
      const pages: PageText[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        pages.push({
          pageIndex: i - 1,
          lines: buildLines(buildPieces(content.items as unknown[])),
          dispW: viewport.width,
          dispH: viewport.height,
          transform: viewport.transform as unknown as Transform6,
        });
        page.cleanup();
      }
      return pages;
    } finally {
      doc.cleanup();
    }
  })();
  cache.set(file, promise);
  // A failed extraction must not poison the cache for a retry.
  promise.catch(() => cache.delete(file));
  return promise;
}

/** Which scanners are active for a Find run. */
export interface FindOptions {
  aadhaar: boolean;
  pan: boolean;
  phone: boolean;
  email: boolean;
  /** Case-insensitive literal terms (blank lines ignored). */
  terms: string[];
}

let seq = 0;
const nextMatchId = (kind: RedactKind, page: number): string =>
  `${kind}p${page}n${(seq += 1).toString(36)}`;

/**
 * Scans the extracted pages and returns one enabled mark per hit. Boxes are
 * the union of the covering text pieces, padded, in display fractions —
 * exactly what the preview overlay and the worker's canvas share.
 */
export function findSensitiveMarks(
  pages: PageText[],
  options: FindOptions
): RedactMark[] {
  const patterns: PatternId[] = [];
  if (options.aadhaar) patterns.push("aadhaar");
  if (options.pan) patterns.push("pan");
  if (options.phone) patterns.push("phone");
  if (options.email) patterns.push("email");
  const terms = options.terms
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const marks: RedactMark[] = [];
  for (const page of pages) {
    for (const line of page.lines) {
      const hits: {
        kind: RedactKind;
        start: number;
        end: number;
        text: string;
      }[] = [];
      for (const pattern of patterns) {
        for (const hit of regexMatches(line.text, pattern)) {
          hits.push({ kind: pattern, ...hit });
        }
      }
      if (terms.length > 0) {
        for (const hit of termMatches(line.text, terms)) {
          hits.push({ kind: "text", ...hit });
        }
      }
      for (const hit of hits) {
        const box = unionRects(
          piecesForRange(line, hit.start, hit.end).map(pieceUserBox)
        );
        if (!box) continue;
        const display = userRectToDisplay(box, page.transform);
        const frac = displayRectToFraction(
          display,
          page.dispW,
          page.dispH,
          MATCH_PAD_PT
        );
        marks.push({
          id: nextMatchId(hit.kind, page.pageIndex),
          page: page.pageIndex,
          ...frac,
          kind: hit.kind,
          label: hit.text.trim(),
          enabled: true,
        });
      }
    }
    if (marks.length > 400) break; // cap pathological documents
  }
  return marks.slice(0, 400);
}

/** True when the file has no selectable text at all (a scan). */
export function hasNoText(pages: PageText[]): boolean {
  return pages.every(
    (p) =>
      p.lines.length === 0 ||
      p.lines.every((l) => l.text.trim().length === 0)
  );
}
