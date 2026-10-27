import { parsePageSpec } from "@/lib/workers/protocol";
import {
  buildHeadingContext,
  headingLevelFor,
  type HeadingContext,
} from "../pdf-to-markdown/md-build";

/**
 * PDF → open-formats extraction core (Task b5-c) — the shared pipeline
 * the worker and the smoke both run: pdf.js getTextContent items →
 * styled pieces → visual lines → paragraphs with bold/italic runs.
 *
 * The extraction recipe is the pdf-to-word / pdf-to-markdown one
 * (pieces grouped into visual lines by baseline tolerance, x-sorted,
 * quarter-font gap spaces), EXTENDED with the two things those tools
 * honestly lack and open formats want:
 *   - run-level bold/italic from pdf.js's fontName heuristic
 *     ("Helvetica-Bold" → bold, "…Oblique/Italic" → italic; embedded
 *     subset names like "g_d0_f1" carry no weight — those runs stay
 *     plain, honestly);
 *   - heading levels 1-2 via the SHARED document-wide font-size
 *     clustering (buildHeadingContext / headingLevelFor from
 *     pdf-to-markdown — the proven heading brain, not a reinvention).
 *
 * Paragraph splitting is the y-gap heuristic of buildSegments: tight
 * baselines with similar sizes merge (wrapped lines), a clear vertical
 * gap starts a new paragraph, hyphenated line endings rejoin. List
 * markers stay literal text (the pdf-to-word "• " honesty, one step
 * simpler: they are already in the extracted words).
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** pdf.js getTextContent item slice the extraction reads. */
export interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  /** pdf.js font tag ("g_d0_f1") — the bold/italic lookup key. */
  fontName?: unknown;
}

/** One styled fragment of text (one paragraph-level run after merge). */
export interface ExtractedRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** A paragraph: runs + an optional heading level (1-2, ODT only). */
export interface ExtractedParagraph {
  runs: ExtractedRun[];
  /** Present (1 or 2) when font-size clustering flagged a heading. */
  heading?: number;
}

/** One PDF page's paragraphs, in reading order. */
export interface ExtractedPage {
  paragraphs: ExtractedParagraph[];
}

/** The whole extracted document (one output file's content). */
export interface ExtractedDoc {
  pages: ExtractedPage[];
  /** First heading's text (capped), or null when no headings exist. */
  title: string | null;
}

/** Resolved style of one pdf.js font tag. */
export interface PdfFontFlags {
  bold: boolean;
  italic: boolean;
}

/** Structural slice of pdf.js's page — enough for text extraction. */
export interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  /**
   * Optional because pdf.js exposes run bold/italic ONLY through the
   * operator-list pass (fonts are sent as common objects there — the
   * text-extraction pass never sends them). When present it is called
   * first purely for that side effect.
   */
  getOperatorList?(): Promise<unknown>;
  /** Font common objects: tag → { bold, italic } after getOperatorList. */
  readonly commonObjs?: { get(id: string): unknown };
  cleanup(): void;
}

/** Structural slice of pdf.js's document. */
export interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  cleanup(): void;
}

/**
 * Document opener injection: the worker passes the self-hosted pdf.js
 * (fake-worker mode + DOM shim); the smoke test passes the npm legacy
 * build — the extraction core below runs identically in both.
 */
export type OpenPdfDoc = (data: Uint8Array) => Promise<PdfDocLike>;

/** Typed run error — the worker message handler maps it 1:1 to i18n. */
export class PdfToOdtError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "PdfToOdtError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ExtractProgress {
  /** 0-100 within this file's extraction phase. */
  pct: number;
  /** 1-based page just extracted. */
  page: number;
  /** Selected page count. */
  pages: number;
}

/* ------------------------------------------------------------------ */
/* Font-name heuristics                                                */
/* ------------------------------------------------------------------ */

/** Font names whose weight reads as bold (Word/PDF naming families). */
export function isBoldFontName(fontName: string): boolean {
  return /bold|black|heavy/i.test(fontName);
}

/** Font names whose slant reads as italic (incl. PostScript "Oblique"). */
export function isItalicFontName(fontName: string): boolean {
  return /italic|oblique/i.test(fontName);
}

/**
 * Resolves the page's font tags → bold/italic flags.
 *
 * pdf.js's TextItem.fontName is a generated tag ("g_d0_f1"), not the
 * real face — and getTextContent alone never exports the font objects
 * carrying the flags. The recipe: call getOperatorList() first (its
 * side effect sends every font as a common object with pdf.js's own
 * resolved bold/italic), then map each distinct tag through
 * page.commonObjs. Anything unresolved degrades to the font-name
 * string heuristic — honest plain runs, never a crash.
 */
export function buildFontFlags(
  page: PdfPageLike,
  items: RawTextItem[]
): Map<string, PdfFontFlags> {
  const flags = new Map<string, PdfFontFlags>();
  for (const item of items) {
    if (typeof item.fontName !== "string" || item.fontName.length === 0) {
      continue;
    }
    const tag = item.fontName;
    if (flags.has(tag)) continue;
    let bold = isBoldFontName(tag);
    let italic = isItalicFontName(tag);
    if (page.commonObjs !== undefined) {
      try {
        const font = page.commonObjs.get(tag) as
          | { bold?: unknown; italic?: unknown }
          | null;
        if (font !== null && typeof font === "object") {
          if (typeof font.bold === "boolean") bold = font.bold;
          if (typeof font.italic === "boolean") italic = font.italic;
        }
      } catch {
        // tag not resolved yet — the string heuristic stays
      }
    }
    flags.set(tag, { bold, italic });
  }
  return flags;
}

/* ------------------------------------------------------------------ */
/* Pieces → styled lines (the pdf-to-word recipe + style flags)        */
/* ------------------------------------------------------------------ */

/** One positioned text piece with its font-derived style. */
export interface StyledPiece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  bold: boolean;
  italic: boolean;
}

/** One visual line: MdLine-compatible fields (heading clustering) + runs. */
export interface StyledLine {
  text: string;
  x: number;
  y: number;
  /** Font size of the longest piece (heading detection input). */
  size: number;
  /** Style-merged runs of the line, in x order. */
  runs: ExtractedRun[];
}

/** Collects the page's text pieces, filtered and position-tagged. */
export function collectStyledPieces(
  items: RawTextItem[],
  fontFlags?: Map<string, PdfFontFlags>
): StyledPiece[] {
  const pieces: StyledPiece[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Font height (vertical scale of the text matrix) drives every
    // spacing tolerance below — one number adapts to any font size.
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const fontName = typeof item.fontName === "string" ? item.fontName : "";
    const resolved = fontFlags?.get(fontName);
    const w = Number(item.width) || 0;
    pieces.push({
      str: item.str,
      x,
      y,
      w,
      size: size > 0 ? size : 10,
      bold: resolved !== undefined ? resolved.bold : isBoldFontName(fontName),
      italic:
        resolved !== undefined ? resolved.italic : isItalicFontName(fontName),
    });
  }
  return pieces;
}

/** Trims trailing whitespace off a line's run atoms (in place). */
function trimRunTail(atoms: ExtractedRun[]): void {
  while (atoms.length > 0) {
    const last = atoms[atoms.length - 1] as ExtractedRun;
    if (last.text.trim().length > 0) {
      last.text = last.text.replace(/[ \t]+$/, "");
      break;
    }
    atoms.pop();
  }
}

/**
 * Groups pieces into visual lines (the pdf-to-word buildMdLines recipe:
 * baseline within half a font height, x-sorted, quarter-font gap spaces)
 * while keeping run boundaries: pieces merge into atoms, atoms with the
 * same bold/italic merge into runs.
 */
export function buildStyledLines(pieces: StyledPiece[]): StyledLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: StyledPiece[][] = [];
  let current: StyledPiece[] = [sorted[0] as StyledPiece];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i] as StyledPiece;
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * 0.5);
    }
  }
  groups.push(current);

  const lines: StyledLine[] = [];
  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let size = ordered[0].size;
    let longest = ordered[0].str.length;
    let text = "";
    let endX: number | null = null;
    const atoms: ExtractedRun[] = [];
    for (const piece of ordered) {
      if (piece.str.length > longest) {
        longest = piece.str.length;
        size = piece.size;
      }
      if (
        endX !== null &&
        piece.x - endX > size * 0.25 &&
        !text.endsWith(" ") &&
        !piece.str.startsWith(" ")
      ) {
        // The bridging space joins the style of the piece before the
        // gap (or the upcoming piece on a fresh line) — spaces carry
        // no visible weight, so the choice is rendering-neutral.
        // (The startsWith guard prevents a double space when the next
        // piece already opens with its own whitespace — a real-text
        // bug the run-split smoke check caught.)
        const prev = atoms[atoms.length - 1];
        atoms.push({
          text: " ",
          bold: prev !== undefined ? prev.bold : piece.bold,
          italic: prev !== undefined ? prev.italic : piece.italic,
        });
        text += " ";
      }
      atoms.push({
        text: piece.str,
        bold: piece.bold,
        italic: piece.italic,
      });
      text += piece.str;
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    trimRunTail(atoms);
    // Merge adjacent atoms of the same style into runs.
    const runs: ExtractedRun[] = [];
    for (const atom of atoms) {
      if (atom.text.length === 0) continue;
      const last = runs[runs.length - 1];
      if (
        last !== undefined &&
        last.bold === atom.bold &&
        last.italic === atom.italic
      ) {
        last.text += atom.text;
      } else {
        runs.push({ text: atom.text, bold: atom.bold, italic: atom.italic });
      }
    }
    if (runs.length === 0) continue;
    lines.push({
      text: text.replace(/[ \t]+$/, ""),
      x: ordered[0].x,
      y: group[0].y,
      size,
      runs,
    });
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Lines → paragraphs (the buildSegments para rules + headings)        */
/* ------------------------------------------------------------------ */

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/** Dehyphenation probe: "exam-" + "ple" merges (the pdf-to-word recipe). */
function dehyphenate(buf: string, next: string): boolean {
  return (
    new RegExp(`[${SCRIPT}]-$`).test(buf) &&
    new RegExp("^[a-z\\u0900-\\u097f\\u00df-\\u00ff]").test(next)
  );
}

/** Heading candidate line length cap (long lines are body text). */
const HEADING_MAX_CHARS = 100;

/** Open formats carry two heading levels; deeper clusters flatten to 2. */
function clampHeadingLevel(level: number): number {
  return Math.min(2, Math.max(1, level));
}

/** Accumulator while walking a page's lines. */
interface ParaAcc {
  kind: "para" | "heading";
  level: number;
  lines: StyledLine[];
}

/** Joins one accumulator's lines into style-merged runs. */
function finalizeParagraph(acc: ParaAcc): ExtractedParagraph | null {
  const atoms: ExtractedRun[] = [];
  let prevText = "";
  for (let i = 0; i < acc.lines.length; i += 1) {
    const lineRuns = (acc.lines[i] as StyledLine).runs.filter(
      (run) => run.text.length > 0
    );
    if (lineRuns.length === 0) continue;
    if (i === 0) {
      for (const run of lineRuns) {
        atoms.push({ text: run.text, bold: run.bold, italic: run.italic });
        prevText += run.text;
      }
      continue;
    }
    const first = lineRuns[0] as ExtractedRun;
    if (dehyphenate(prevText, first.text)) {
      // Drop the hyphen from the last non-empty atom, then join tight.
      for (let a = atoms.length - 1; a >= 0; a -= 1) {
        const atom = atoms[a] as ExtractedRun;
        if (atom.text.length > 0) {
          atom.text = atom.text.slice(0, -1);
          break;
        }
      }
      atoms.push({ text: first.text, bold: first.bold, italic: first.italic });
    } else {
      atoms.push({
        text: " ",
        bold: first.bold,
        italic: first.italic,
      });
      for (const run of lineRuns) {
        atoms.push({ text: run.text, bold: run.bold, italic: run.italic });
      }
    }
    for (const run of lineRuns) prevText += run.text;
  }
  // Merge adjacent same-style atoms (dehyphenation may re-split styles).
  const merged: ExtractedRun[] = [];
  for (const atom of atoms) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.bold === atom.bold &&
      last.italic === atom.italic
    ) {
      last.text += atom.text;
    } else {
      merged.push({ text: atom.text, bold: atom.bold, italic: atom.italic });
    }
  }
  const runs = merged.filter((run) => run.text.length > 0);
  const text = runs.map((run) => run.text).join("");
  if (text.trim().length === 0) return null;
  if (acc.kind === "heading") {
    return { runs, heading: clampHeadingLevel(acc.level) };
  }
  return { runs };
}

/**
 * Walks a page's visual lines and cuts paragraphs: heading lines form
 * their own (wrapped headings merge, the buildSegments rule), body
 * lines merge while the baseline gap stays tight and the size band is
 * similar, everything else starts a new paragraph.
 */
export function paragraphsFromLines(
  lines: StyledLine[],
  ctx: HeadingContext
): ExtractedParagraph[] {
  const accs: ParaAcc[] = [];
  let prevY: number | null = null;
  let prevSize = 10;

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) continue;

    const level = headingLevelFor(ctx, line.size);
    const isHeading =
      level >= 1 &&
      trimmed.length > 0 &&
      trimmed.length <= HEADING_MAX_CHARS;

    const tail = accs.length > 0 ? accs[accs.length - 1] : undefined;
    const gap = prevY === null ? Number.POSITIVE_INFINITY : prevY - line.y;
    const tight = gap <= Math.max(1.5, prevSize * 1.75);

    if (isHeading) {
      const head = tail === undefined ? undefined : tail.lines[0];
      if (
        tail !== undefined &&
        tail.kind === "heading" &&
        tail.level === clampHeadingLevel(level) &&
        head !== undefined &&
        tail.lines.length < 3 &&
        Math.abs(head.size - line.size) <= line.size * 0.15 &&
        tight
      ) {
        tail.lines.push(line);
      } else {
        accs.push({
          kind: "heading",
          level: clampHeadingLevel(level),
          lines: [line],
        });
      }
      prevY = line.y;
      prevSize = line.size;
      continue;
    }

    if (tail !== undefined && tail.kind === "para" && tight) {
      const head = tail.lines[0];
      if (
        head !== undefined &&
        tail.lines.length < 30 &&
        gap <= prevSize * 1.7 &&
        Math.max(head.size, line.size) / Math.min(head.size, line.size) <= 1.35
      ) {
        tail.lines.push(line);
        prevY = line.y;
        prevSize = line.size;
        continue;
      }
    }

    accs.push({ kind: "para", level: 0, lines: [line] });
    prevY = line.y;
    prevSize = line.size;
  }

  const paragraphs: ExtractedParagraph[] = [];
  for (const acc of accs) {
    const paragraph = finalizeParagraph(acc);
    if (paragraph !== null) paragraphs.push(paragraph);
  }
  return paragraphs;
}

/* ------------------------------------------------------------------ */
/* Title                                                               */
/* ------------------------------------------------------------------ */

/** Joined run text of a paragraph. */
export function extractedParagraphText(paragraph: ExtractedParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}

/** The first heading's text (capped at 120 chars), or null. */
export function docTitle(pages: ExtractedPage[]): string | null {
  for (const page of pages) {
    for (const paragraph of page.paragraphs) {
      if (paragraph.heading !== undefined) {
        const text = extractedParagraphText(paragraph).trim();
        if (text.length > 0) return text.slice(0, 120);
      }
    }
  }
  return null;
}

/** Non-whitespace character count of a page's raw items (the scan probe). */
export function pageCharCount(items: RawTextItem[]): number {
  let count = 0;
  for (const piece of collectStyledPieces(items)) {
    count += piece.str.replace(/\s/g, "").length;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* The pipeline (worker + smoke share this one function)                */
/* ------------------------------------------------------------------ */

export interface ExtractedDocWithMeta extends ExtractedDoc {
  /** Non-whitespace chars across all selected pages (the scan signal). */
  charCount: number;
}

/**
 * PDF bytes → the extracted document. Errors throw PdfToOdtError with
 * the i18n key the UI should show: corrupt/encrypted open, an
 * unparseable page spec (detail = the spec), and zero selectable text
 * (a scan — the honest noText refusal instead of an empty output).
 */
export async function extractPdfBlocks(
  data: Uint8Array,
  options: { pages?: string },
  openDoc: OpenPdfDoc,
  onProgress?: (progress: ExtractProgress) => void
): Promise<ExtractedDocWithMeta> {
  const pages = typeof options.pages === "string" ? options.pages : "all";

  let doc: PdfDocLike;
  try {
    doc = await openDoc(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PdfToOdtError(
      /password/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }

  const pageNumbers = parsePageSpec(pages, doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    doc.cleanup();
    throw new PdfToOdtError("tool.errorInvalidPages", pages);
  }

  // Pass 1 — raw items + the honest scan probe per selected page.
  // The operator-list pass runs FIRST on each page: pdf.js only
  // exports font objects (with its own resolved bold/italic flags)
  // through it — the text pass alone carries bare "g_d0_fN" tags.
  const perPageItems: RawTextItem[][] = [];
  const perPageFlags: Map<string, PdfFontFlags>[] = [];
  let charCount = 0;
  for (let i = 0; i < pageNumbers.length; i += 1) {
    const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
    const page = await doc.getPage(pageNumber);
    try {
      await page.getOperatorList?.();
    } catch {
      // font objects unavailable — bold/italic degrade honestly
    }
    const content = await page.getTextContent();
    const items = content.items as RawTextItem[];
    perPageFlags.push(buildFontFlags(page, items));
    page.cleanup();
    charCount += pageCharCount(items);
    perPageItems.push(items);
    onProgress?.({
      pct: 5 + Math.round(((i + 1) / pageNumbers.length) * 85),
      page: i + 1,
      pages: pageNumbers.length,
    });
  }
  doc.cleanup();

  // Scans have zero selectable text — fail honestly instead of
  // shipping an empty document (the OCR tool is the honest path).
  if (charCount === 0) {
    throw new PdfToOdtError("tool.errorNoText");
  }

  // Pass 2 — pure: lines, document-wide heading context, paragraphs.
  const perPageLines = perPageItems.map((items, i) =>
    buildStyledLines(collectStyledPieces(items, perPageFlags[i]))
  );
  const ctx = buildHeadingContext(perPageLines);
  const extractedPages = perPageLines.map((lines) => ({
    paragraphs: paragraphsFromLines(lines, ctx),
  }));

  return {
    pages: extractedPages,
    title: docTitle(extractedPages),
    charCount,
  };
}
