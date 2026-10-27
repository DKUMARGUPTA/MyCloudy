/**
 * PDF → HTML engine (TOOLS-B1-c) — pure, bun-testable, no DOM.
 *
 * Pipeline (PRD §7.9 "PDF to HTML", text-based PDFs only):
 *   raw pdf.js text items → pieces (pdf-to-txt's proven collector)
 *   → visual lines (baseline clustering + gap-aware space insertion)
 *   → blocks (headings by font-size clustering, paragraphs by vertical
 *     gap, bullet/numbered lists, <pre> for widely-spaced runs)
 *   → ONE self-contained .html document (inline CSS only, no external
 *     resources, prints nicely).
 *
 * SECURITY: every piece of user text goes through escapeHtml() before it
 * touches the output — &, <, >, " and ' are entity-escaped, and control
 * characters are stripped (stripControls) because they are invalid in HTML.
 *
 * iOS-safe (worklog lesson IOS-COMPAT): no String.prototype.matchAll /
 * replaceAll, no regex lookbehind, no Object.hasOwn / structuredClone —
 * split/join and plain exec/test only.
 *
 * Honest limits: no OCR (a page without a text layer contributes nothing —
 * the worker fails the whole file with tool.errorNoText, same as pdf-to-txt),
 * no image extraction (text-only v1), and multi-column layouts degrade to
 * reading order (like pdf-to-txt flow).
 */
import type { OptionValues } from "@/lib/tools/config-types";
import {
  collectPieces,
  pageCharCount,
  type RawTextItem,
  type TextPiece,
} from "../pdf-to-txt/text-layout";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One visual line, with the widest internal gap kept as a signal. */
export interface HtmlLine {
  /** Gap-normalized text (single spaces). */
  text: string;
  /** Wide gaps kept as proportional spaces — the <pre> rendering. */
  preText: string;
  /** Baseline y in PDF space (grows upward, lines come top-first). */
  y: number;
  size: number;
  /** Widest internal gap ÷ font size (the <pre> detector). */
  maxGapRatio: number;
}

export type HtmlBlockKind = "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "pre";

/** One semantic element of the output document. */
export interface HtmlBlock {
  kind: HtmlBlockKind;
  /** Paragraph / heading / pre text (already flow-joined). */
  text: string;
  /** List item texts, markers stripped (ul/ol only). */
  items: string[];
}

/** One page's raw pdf.js text items, with its 1-based label. */
export interface HtmlPageInput {
  pageNumber: number;
  items: RawTextItem[];
}

export interface HtmlDocOptions {
  /** <title> fallback when the document has no heading (file base name). */
  title?: string;
  /** Insert `<hr>` + a small page label between pages (multi-page only). */
  pageMarks?: boolean;
}

export interface HtmlOutOptions {
  pages: string;
  pageMarks: boolean;
}

/* ------------------------------------------------------------------ */
/* Escaping (CRITICAL — user content goes into HTML)                   */
/* ------------------------------------------------------------------ */

/**
 * HTML text/attribute escaping. `&` first so nothing double-escapes;
 * split/join (not replaceAll) per the iOS-compat rule.
 */
export function escapeHtml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

/** Removes C0 control chars (keeps \t \n \r) + DEL — invalid in HTML. */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/* ------------------------------------------------------------------ */
/* Pieces → lines                                                      */
/* ------------------------------------------------------------------ */

/** Gap (in font sizes) that marks a line as "widely spaced" (pre candidate). */
const PRE_GAP = 1.4;
/** Monospace advance used to rebuild wide gaps as spaces (0.6 em). */
const MONO_ADVANCE = 0.6;
/** Word-space threshold, same as pdf-to-txt (a quarter font). */
const SPACE_GAP = 0.25;

function isWhitespace(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

/**
 * Groups pieces into visual lines exactly like pdf-to-txt's buildLines
 * (baseline within half a font height), but keeps the widest internal
 * gap ratio as a signal. Two gap carriers exist because pdf.js emits
 * BOTH shapes:
 *  - a whitespace-only item whose WIDTH covers the gap (pdf-lib output,
 *    seen in the smoke), and
 *  - a plain x jump between items (other producers).
 */
export function buildLinesWithGaps(pieces: TextPiece[]): HtmlLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
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

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const size = group[0].size;
    let text = "";
    let preText = "";
    let endX: number | null = null;
    let maxGapRatio = 0;

    for (const piece of ordered) {
      if (isWhitespace(piece.str)) {
        // A whitespace item: its width IS the gap it covers.
        if (endX !== null && piece.w > 0) {
          const ratio = piece.w / size;
          if (ratio > maxGapRatio) maxGapRatio = ratio;
          preText += " ".repeat(
            Math.max(1, Math.round(piece.w / (size * MONO_ADVANCE)))
          );
        } else {
          preText += " ";
        }
        if (!text.endsWith(" ")) text += " ";
        endX = Math.max(endX ?? 0, piece.x + piece.w);
        continue;
      }

      if (endX !== null && piece.x > endX) {
        const gap = piece.x - endX;
        const ratio = gap / size;
        if (ratio > maxGapRatio) maxGapRatio = ratio;
        if (ratio > SPACE_GAP) {
          if (!text.endsWith(" ")) text += " ";
          preText += " ".repeat(
            Math.max(1, Math.round(gap / (size * MONO_ADVANCE)))
          );
        }
      }
      text += piece.str;
      preText += piece.str;
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }

    return {
      text: stripControls(text.replace(/\s+$/, "")),
      preText: stripControls(preText.replace(/[ \t]+$/, "")),
      y: group[0].y,
      size,
      maxGapRatio,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Lines → blocks                                                      */
/* ------------------------------------------------------------------ */

/** Bullet markers (the copy-from-pdf set). */
export const BULLET_RE = /^[ \t]*[•●○▪‣◦·►»*+\-–—][ ]+/;
/** "1." / "1)" style numbering (a space after the marker is required). */
export const NUMBERED_RE = /^[ \t]*\d{1,3}[.)][ ]+/;

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";
const HYPHEN_END_RE = new RegExp(`[${SCRIPT}]-$`);
const LOWER_START_RE = new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]");

/** Length-weighted median font size of a page (the "body" size). */
export function bodyTextSize(lines: HtmlLine[]): number {
  const sizes: number[] = [];
  for (const line of lines) {
    const length = line.text.trim().length;
    if (length === 0) continue;
    const weight = Math.min(8, length);
    for (let i = 0; i < weight; i += 1) sizes.push(line.size);
  }
  if (sizes.length === 0) return 0;
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface ListMarker {
  kind: "ul" | "ol";
  text: string;
}

/** Bullet/numbered marker detection; null when the line is neither. */
export function detectListMarker(lineText: string): ListMarker | null {
  const bullet = BULLET_RE.exec(lineText);
  if (bullet !== null) {
    const rest = lineText.slice(bullet[0].length).trim();
    return rest.length > 0 ? { kind: "ul", text: rest } : null;
  }
  const numbered = NUMBERED_RE.exec(lineText);
  if (numbered !== null) {
    const rest = lineText.slice(numbered[0].length).trim();
    return rest.length > 0 ? { kind: "ol", text: rest } : null;
  }
  return null;
}

/**
 * Flow-joins a line run into one paragraph string: hyphenated endings
 * merge with the next line (the hyphen drops only before a lowercase
 * letter, so a genuine "e-Mail" survives), everything else space-joins.
 */
function joinParaText(lines: HtmlLine[]): string {
  let buf = "";
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;
    if (buf.length === 0) {
      buf = text;
    } else if (HYPHEN_END_RE.test(buf) && LOWER_START_RE.test(text)) {
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
  }
  return buf;
}

/** Can `line` extend the paragraph that currently ends at `prev`? */
function canJoinPara(prev: HtmlLine, line: HtmlLine): boolean {
  const gap = prev.y - line.y; // PDF space: y descends down the page
  if (gap > prev.size * 1.7) return false; // clear vertical gap
  const lo = Math.min(prev.size, line.size);
  const hi = Math.max(prev.size, line.size);
  if (lo <= 0 || hi / lo > 1.35) return false; // font-size jump
  return true;
}

function makeParaBlock(
  lines: HtmlLine[],
  body: number,
  maxSize: number
): HtmlBlock {
  const first = lines[0];
  const text = joinParaText(lines);

  // <pre>: a tightly-led run where (almost) every line has a wide
  // internal gap — aligned/monospace layout → keep the spacing verbatim.
  let wide = 0;
  for (const line of lines) {
    if (line.maxGapRatio >= PRE_GAP) wide += 1;
  }
  if (lines.length >= 2 && wide >= Math.ceil((lines.length * 2) / 3)) {
    return {
      kind: "pre",
      text: lines.map((line) => line.preText).join("\n"),
      items: [],
    };
  }

  // Heading: short, few lines, clearly bigger than the body text.
  if (lines.length <= 2 && first.size >= body * 1.22 && text.length <= 90) {
    if (first.size >= body * 1.7 || first.size >= maxSize * 0.95) {
      return { kind: "h1", text, items: [] };
    }
    if (first.size >= body * 1.35) {
      return { kind: "h2", text, items: [] };
    }
    return { kind: "h3", text, items: [] };
  }
  return { kind: "p", text, items: [] };
}

/** One page's raw pdf.js items → semantic blocks, reading order. */
export function pageToBlocks(items: RawTextItem[]): HtmlBlock[] {
  const pieces = collectPieces(items);
  if (pieces.length === 0) return [];
  const lines = buildLinesWithGaps(pieces).filter(
    (line) => line.text.trim().length > 0
  );
  if (lines.length === 0) return [];

  const body = bodyTextSize(lines) || lines[0].size;
  let maxSize = 0;
  for (const line of lines) {
    if (line.size > maxSize) maxSize = line.size;
  }

  const blocks: HtmlBlock[] = [];
  let paraBuf: HtmlLine[] = [];
  let listKind: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushPara = (): void => {
    if (paraBuf.length === 0) return;
    blocks.push(makeParaBlock(paraBuf, body, maxSize));
    paraBuf = [];
  };
  const flushList = (): void => {
    if (listKind === null) return;
    blocks.push({ kind: listKind, text: "", items: listItems });
    listKind = null;
    listItems = [];
  };

  for (const line of lines) {
    const marker = detectListMarker(line.text);
    if (marker !== null) {
      // A list line always starts its own item; consecutive items of the
      // same kind share one list element.
      flushPara();
      if (listKind === marker.kind) {
        listItems.push(marker.text);
      } else {
        flushList();
        listKind = marker.kind;
        listItems = [marker.text];
      }
      continue;
    }
    flushList();
    if (
      paraBuf.length > 0 &&
      canJoinPara(paraBuf[paraBuf.length - 1], line)
    ) {
      paraBuf.push(line);
    } else {
      flushPara();
      paraBuf = [line];
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Blocks → HTML                                                       */
/* ------------------------------------------------------------------ */

/** Majority script of the extracted text → the <html lang> value. */
function docLanguage(blocks: HtmlBlock[]): string {
  let deva = 0;
  let latin = 0;
  for (const block of blocks) {
    const texts =
      block.kind === "ul" || block.kind === "ol" ? block.items : [block.text];
    for (const text of texts) {
      const d = text.match(/[\u0900-\u097F]/g);
      if (d !== null) deva += d.length;
      const l = text.match(/[A-Za-z]/g);
      if (l !== null) latin += l.length;
    }
  }
  return deva > latin ? "hi" : "en";
}

/** Blocks → the HTML <main> contents (every text escaped). */
export function blocksToBodyHtml(blocks: HtmlBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "ul" || block.kind === "ol") {
      const rows = block.items
        .filter((item) => item.trim().length > 0)
        .map((item) => `  <li>${escapeHtml(item)}</li>`);
      if (rows.length === 0) continue;
      parts.push(`<${block.kind}>\n${rows.join("\n")}\n</${block.kind}>`);
    } else if (block.kind === "pre") {
      parts.push(`<pre>${escapeHtml(block.text)}</pre>`);
    } else {
      parts.push(`<${block.kind}>${escapeHtml(block.text)}</${block.kind}>`);
    }
  }
  return parts.join("\n\n");
}

/**
 * The whole inline stylesheet. Self-contained by design: no web fonts,
 * no external resources; warm paper neutrals; print rules make each
 * page marker a real printer page break.
 */
const HTML_CSS = [
  "*,*::before,*::after{box-sizing:border-box}",
  "body{margin:0;background:#fafaf9;color:#1c1917;font-family:Georgia,'Times New Roman','Noto Serif Devanagari',serif;font-size:17px;line-height:1.65;overflow-wrap:break-word}",
  "main{max-width:44em;margin:0 auto;padding:2.5rem 1.25rem 4rem;background:#fff;min-height:100vh}",
  "h1,h2,h3{line-height:1.25;margin:1.6em 0 .55em}",
  "h1{font-size:2em}",
  "h2{font-size:1.45em}",
  "h3{font-size:1.2em}",
  "p{margin:0 0 1em}",
  "ul,ol{margin:0 0 1em;padding-left:1.6em}",
  "li{margin:.25em 0}",
  "pre{font-family:'Courier New',Courier,monospace;font-size:.85em;line-height:1.5;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:.8em 1em;margin:0 0 1em;white-space:pre-wrap;overflow-x:auto}",
  "hr.page-break{border:0;border-top:2px solid #e7e5e4;margin:2.75rem 0 .9rem}",
  "p.page-label{color:#78716c;font-size:.72rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;margin:0 0 2rem}",
  "@media print{body{background:#fff;font-size:11pt}main{max-width:none;padding:0}hr.page-break{page-break-before:always;border:0;margin:0}p.page-label{margin:0 0 1rem}pre{white-space:pre}}",
].join("\n");

/**
 * Pages → ONE complete, self-contained HTML document. Proper doctype,
 * UTF-8 + viewport meta, inline CSS, semantic blocks, optional page
 * markers between pages (only when more than one page has content).
 */
export function pagesToHtmlDocument(
  pages: HtmlPageInput[],
  options: HtmlDocOptions
): string {
  const bodyParts: string[] = [];
  const allBlocks: HtmlBlock[] = [];
  let contentStarted = false;

  for (const page of pages) {
    const blocks = pageToBlocks(page.items);
    if (blocks.length === 0) continue;
    for (const block of blocks) allBlocks.push(block);
    if (options.pageMarks === true && pages.length > 1 && contentStarted) {
      bodyParts.push(
        `<hr class="page-break">\n<p class="page-label">Page ${page.pageNumber}</p>`
      );
    }
    bodyParts.push(blocksToBodyHtml(blocks));
    contentStarted = true;
  }

  // <title>: the first heading is the best name; fall back to the file
  // name, then "Document". Escaped like any other text.
  let title = "";
  for (const block of allBlocks) {
    if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
      title = block.text;
      break;
    }
  }
  if (title.length === 0 && typeof options.title === "string") {
    title = options.title.trim();
  }
  if (title.length === 0) title = "Document";

  const lang = docLanguage(allBlocks);

  return [
    "<!DOCTYPE html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="DocoPDF">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    HTML_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    bodyParts.length > 0 ? bodyParts.join("\n\n") : "",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Option normalization for the worker (and the smoke). */
export function resolveHtmlOptions(options: OptionValues): HtmlOutOptions {
  const pages = typeof options.pages === "string" ? options.pages : "all";
  return { pages, pageMarks: options.pageMarks === true };
}

/** Re-exported for the worker's no-text decision (pdf-to-txt semantics). */
export { pageCharCount };
