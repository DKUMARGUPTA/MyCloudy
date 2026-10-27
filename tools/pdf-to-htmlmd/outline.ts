/**
 * PDF → HTML / Markdown outline engine (P9 batch 2), shared by the
 * pdf-to-html and pdf-to-markdown workers.
 *
 * Builds on the proven pdf-to-txt text-layout primitives (line grouping,
 * paragraph flow) and adds document structure heuristics:
 *
 *   - body size = MEDIAN line height of the whole document (robust against
 *     a few giant headings skewing an average)
 *   - a line clearly larger than body → heading, bucketed into h1/h2/h3 by
 *     its ratio to the body size
 *   - bullet markers (•, -, ◦ …) and numbered starts ("1.", "3)", "(a)")
 *     → list items; consecutive items group into <ul>/<ol> in HTML and
 *     renumbered 1./- lists in Markdown
 *
 * All functions are pure and DOM-free, so the smoke test runs in Node/Bun.
 */

import {
  buildLines,
  collectPieces,
  type RawTextItem,
} from "../pdf-to-txt/text-layout";

/* ------------------------------ types ------------------------------ */

export type BlockKind = "h1" | "h2" | "h3" | "p" | "li";

export interface DocBlock {
  kind: BlockKind;
  text: string;
  /** For "li" blocks: the item came from a numbered pattern. */
  ordered: boolean;
}

export interface PageBlocks {
  /** 1-based page number in the source PDF. */
  pageNumber: number;
  blocks: DocBlock[];
}

/* --------------------------- heuristics --------------------------- */

/** Bullet markers pdf.js commonly emits for lists. */
const BULLET = /^[\u2022\u25AA\u25CF\u25E6\u2023\u00B7\u2043\u2212\u2013-]\s+/;

/** "1." "12)" "(a)" "(12)" style numbered starts. */
const ORDERED = /^(?:\d{1,3}[.)]|\([a-zA-Z0-9]{1,4}\))\s+/;

/** "IV." "ix)" — roman numbered starts. */
const ROMAN = /^[ivxlcdmIVXLCDM]{1,7}[.)]\s+/;

/**
 * Heading cut-offs relative to the body size, tuned to real Office
 * defaults (Word: body 11 / H3 12 / H2 14 / H1 16 / Title 28):
 *   h1 ≥ 2.0 (cover titles), h2 ≥ 1.42 (section heads), h3 ≥ 1.15
 * (subsections). Word H3 (1.09×) stays a paragraph — vectors in smoke.
 */
export const H1_RATIO = 2.0;
export const H2_RATIO = 1.42;
export const H3_RATIO = 1.15;

/** Lines this long are almost never headings (they're wrapped body text). */
const HEADING_MAX_CHARS = 120;

/** Median of an array (empty → 10, a sane default body size). */
export function median(values: number[]): number {
  if (values.length === 0) return 10;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The document's body line height — median over every page's lines. */
export function documentBodySize(pages: RawTextItem[][]): number {
  const sizes: number[] = [];
  for (const items of pages) {
    for (const line of buildLines(collectPieces(items))) {
      if (line.text.trim().length > 0) sizes.push(line.size);
    }
  }
  return median(sizes);
}

/** Classifies one line into a heading level relative to the body size. */
function headingLevel(
  text: string,
  size: number,
  body: number
): BlockKind | null {
  if (text.length === 0 || text.length > HEADING_MAX_CHARS) return null;
  // A line ending in a comma is almost always wrapped body text, not a
  // heading — unless it is really big (cover pages do end with commas).
  if (/[,;]$/.test(text) && size < body * H2_RATIO) return null;
  const ratio = size / body;
  // Tiny epsilon absorbs float rounding (11.2/10 < 1.12 by 1e-17).
  const EPS = 1e-9;
  if (ratio >= H1_RATIO - EPS) return "h1";
  if (ratio >= H2_RATIO - EPS) return "h2";
  if (ratio >= H3_RATIO - EPS) return "h3";
  return null;
}

/** Splits a visual line into (marker, ordered?) + remainder. */
function splitListMarker(
  text: string
): { text: string; ordered: boolean } | null {
  if (BULLET.test(text)) {
    return { text: text.replace(BULLET, "").trim(), ordered: false };
  }
  if (ORDERED.test(text)) {
    return { text: text.replace(ORDERED, "").trim(), ordered: true };
  }
  if (ROMAN.test(text)) {
    return { text: text.replace(ROMAN, "").trim(), ordered: true };
  }
  return null;
}

/** Paragraph flow, identical maths to pdf-to-txt's joinFlow. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/**
 * One page's items → structured blocks (headings, list items, paragraphs
 * joined with gap heuristics + dehyphenation).
 */
export function outlinePage(items: RawTextItem[], body: number): DocBlock[] {
  const lines = buildLines(collectPieces(items));
  const blocks: DocBlock[] = [];
  let buf = "";
  let prevY: number | null = null;
  let prevSize = body;

  const flush = () => {
    if (buf.trim().length > 0) {
      blocks.push({ kind: "p", text: buf.trim(), ordered: false });
    }
    buf = "";
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;

    const heading = headingLevel(text, line.size, body);
    if (heading !== null) {
      flush();
      blocks.push({ kind: heading, text, ordered: false });
      prevY = null;
      continue;
    }

    const list = splitListMarker(text);
    if (list !== null && list.text.length > 0) {
      flush();
      blocks.push({ kind: "li", text: list.text, ordered: list.ordered });
      prevY = null;
      continue;
    }

    if (buf.length === 0) {
      buf = text;
    } else if (prevY !== null && prevY - line.y > prevSize * 1.7) {
      flush();
      buf = text;
    } else if (
      new RegExp(`[${SCRIPT}]-$`).test(buf) &&
      new RegExp("^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]").test(text)
    ) {
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
    prevY = line.y;
    prevSize = line.size;
  }
  flush();
  return blocks;
}

/* ------------------------------ HTML ------------------------------ */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Devanagari share above ~10% → the document reads as Hindi. */
export function detectHindi(pages: PageBlocks[]): boolean {
  let hindi = 0;
  let total = 0;
  outer: for (const page of pages) {
    for (const block of page.blocks) {
      for (const ch of block.text) {
        total += 1;
        if (ch >= "\u0900" && ch <= "\u097F") hindi += 1;
      }
      if (total > 4000) break outer;
    }
  }
  return total > 0 && hindi / total > 0.1;
}

const HTML_STYLE = `:root{color-scheme:light}
body{max-width:42rem;margin:2.5rem auto;padding:0 1.25rem;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1917;background:#fff}
h1,h2,h3{line-height:1.25;color:#0c0a09}
h1{font-size:1.8rem;margin:2.2rem 0 .9rem}
h2{font-size:1.4rem;margin:2rem 0 .7rem}
h3{font-size:1.15rem;margin:1.6rem 0 .5rem}
p{margin:.8rem 0}
ul,ol{padding-left:1.5rem;margin:.8rem 0}
li{margin:.25rem 0}
.page{border-left:3px solid #e7e5e4;padding-left:1.35rem;margin:2.4rem 0}
.pagenum{font-size:.72rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#78716c;margin:0 0 .6rem}`;

/** Renders one page's blocks as indented HTML (lists properly grouped). */
function pageHtml(page: PageBlocks, multi: boolean): string {
  const lines: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType !== null) {
      lines.push(`    </${listType}>`);
      listType = null;
    }
  };

  for (const block of page.blocks) {
    if (block.kind === "li") {
      const want: "ul" | "ol" = block.ordered ? "ol" : "ul";
      if (listType !== want) {
        closeList();
        lines.push(`    <${want}>`);
        listType = want;
      }
      lines.push(`      <li>${escapeHtml(block.text)}</li>`);
      continue;
    }
    closeList();
    if (block.kind === "p") {
      lines.push(`    <p>${escapeHtml(block.text)}</p>`);
    } else {
      lines.push(`    <${block.kind}>${escapeHtml(block.text)}</${block.kind}>`);
    }
  }
  closeList();

  if (!multi) return lines.join("\n");
  return [
    `  <section class="page" aria-label="Page ${page.pageNumber}">`,
    `    <p class="pagenum">Page ${page.pageNumber}</p>`,
    ...lines,
    `  </section>`,
  ].join("\n");
}

/** Renders all pages into one self-contained, valid HTML document. */
export function renderHtml(
  pages: PageBlocks[],
  title: string,
  lang: string
): string {
  const multi = pages.length > 1;
  const sections = pages.map((p) => pageHtml(p, multi)).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${HTML_STYLE}
</style>
</head>
<body>
${sections}
</body>
</html>
`;
}

/* ---------------------------- Markdown ---------------------------- */

/**
 * Escapes only the LEADING characters that Markdown would otherwise turn
 * into structure (#, >, -, +, "1." or a "---" rule). Inline emphasis
 * characters are left readable on purpose — escaping every * and _ makes
 * real documents unreadable, and FAQ documents the trade-off.
 */
export function escapeMarkdownLead(text: string): string {
  return text
    .replace(/^([#>+-])(\s|$)/, "\\$1$2")
    .replace(/^(\d{1,3})\.(\s|$)/, "$1\\.$2")
    .replace(/^(=+|-+)$/, (m) => `\\${m.charAt(0)}${m.slice(1)}`);
}

/** Renders all pages into one Markdown document. */
export function renderMarkdown(
  pages: PageBlocks[],
  pageBreaks: boolean
): string {
  const out: string[] = [];

  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0 && pageBreaks) out.push("---", "");

    let listOpen = false;
    let listOrdered = false;
    let counter = 0;

    const closeList = () => {
      listOpen = false;
      counter = 0;
      out.push("");
    };

    for (const block of page.blocks) {
      if (block.kind === "li") {
        if (!listOpen || listOrdered !== block.ordered) {
          if (listOpen) out.push("");
          listOpen = true;
          listOrdered = block.ordered;
          counter = 0;
        }
        counter += 1;
        out.push(
          block.ordered ? `${counter}. ${block.text}` : `- ${block.text}`
        );
        continue;
      }
      if (listOpen) closeList();

      if (block.kind === "p") {
        out.push(escapeMarkdownLead(block.text), "");
      } else {
        const level = Number(block.kind.slice(1));
        out.push(`${"#".repeat(level)} ${block.text}`, "");
      }
    }
    if (listOpen) closeList();
  });

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
