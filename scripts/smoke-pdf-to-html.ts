/**
 * PRE-BUILD smoke test for PDF → HTML (RB4-b). Locks the pure model
 * AND the real pdf.js path before browser QA:
 *
 *  1. MODEL (pure, headless): escapeHtml + sanitizeRunText vectors,
 *     px math (pt × 96/72), y-proximity line grouping, gap→space
 *     insertion, paragraph breaks (gap + size-change), dehyphenation,
 *     heading tiers (largest = h1, next = h2, switch off = plain),
 *     bold + italic from fontName + styleMap override, list markers
 *     (bullet / ordered / dash), list continuation, heading-tier
 *     lines never list items, empty middle page, clamps, garbage
 *     items, lang detection, docStats/layoutLineCount.
 *  2. BUILD SHAPE (flow, synthetic): doctype first, charset meta,
 *     escaped <title>, h1/h2, <strong>/<em>, &amp;-escaping, one
 *     <section> per page, page-number markers on/off, custom page
 *     word, empty-page note, generator meta, well-formedness.
 *  3. REAL FIXTURE (pdf-lib + pdf.js legacy, in-process): a 3-page
 *     PDF is built for real — 22 pt bold title, 11 pt body, a mid-line
 *     BOLD run, a mid-line OBLIQUE (italic) run, an XML-hostile line
 *     (& < > " '), bullet + ordered lists, a second page with a 16 pt
 *     heading, and a Hindi Devanagari page with the self-hosted Noto
 *     subset — then extracted through pdf.js getTextContent,
 *     style-enriched by the worker's own buildFontStyleMap (Tf-order
 *     correlation), run through extractDocument + buildHtml, and the
 *     OUTPUT is asserted: <title> from the PDF metadata, h1 carries
 *     the biggest-font line, text needles (EN + Hindi UTF-8),
 *     &amp;-escaping, <strong>/<em>, <ul>/<ol>/<li>, sections per page.
 *  4. LAYOUT MODE (real fixture): per-page <section>s with the EXACT
 *     px dims (612×792 pt → 816.00×1056.00 px), .ln divs at exact
 *     left/top/font-size (pt × 96/72, 0.8 em ascent), 13 positioned
 *     lines, Hindi present, page markers.
 *  5. PAGE RANGE subset: pages "1" → only page 1's content and one
 *     section; "2-3" → pages 2-3 only.
 *  6. coerceRunOptions + outputBaseName vectors (.pdf → .html,
 *     unsafe chars, Hindi names, EN/HI fallbacks).
 *  7. REJECTION vectors: an @cantoo-encrypted PDF (pdf.js demands a
 *     password) → tool.errorEncrypted; garbage bytes → corrupt.
 *  8. WIRING: registry enabled, TOOL_CONFIGS route, TOOL_SURFACES
 *     map, i18n en/hi parity + every phtml.* key used by the surface
 *     resolves in BOTH catalogs.
 *
 * Run: bun scripts/smoke-pdf-to-html.ts   (exit code = failures)
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  ASCENT_EM,
  buildHtml,
  coerceRunOptions,
  docStats,
  escapeHtml,
  extractDocument,
  layoutLineCount,
  MAX_BLOCKS,
  MAX_LAYOUT_LINES,
  MAX_RUN_CHARS,
  outputBaseName,
  pdfErrorMessageToCode,
  px,
  sanitizeRunText,
  type PdfTextItemInput,
  type PageInput,
} from "../tools/pdf-to-html/model";
import { parsePageSpec } from "../src/lib/workers/protocol";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 400) : ""
    );
  }
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Minimal HTML well-formedness: balanced tags, quoted attrs, no raw <
 * in text (doctype, comments and self-closed voids tolerated).
 */
function htmlWellFormed(html: string): boolean {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "");
  const tagRe =
    /<(\/?)([A-Za-z_:][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    if (src.slice(lastIndex, match.index).includes("<")) return false;
    lastIndex = tagRe.lastIndex;
    const [full, close, name, , selfClose] = match;
    if (selfClose === "/" || full.startsWith("<?") || full.startsWith("<!")) {
      continue;
    }
    if (close === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  if (src.slice(lastIndex).includes("<")) return false;
  return stack.length === 0;
}

/** Synthetic pdf.js item factory for the pure-model sections. */
function item(
  str: string,
  x: number,
  y: number,
  size: number,
  opts: { fontName?: string; bold?: boolean; italic?: boolean; width?: number } = {}
): PdfTextItemInput {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: opts.width ?? str.length * size * 0.5,
    fontName: opts.fontName ?? "F",
    bold: opts.bold,
    italic: opts.italic,
  };
}

function page(
  pageNo: number,
  items: readonly PdfTextItemInput[],
  widthPt = 612,
  heightPt = 792
): PageInput {
  return { pageNo, widthPt, heightPt, items };
}

/** Runs the extraction and returns the flow HTML for assertions. */
function flowHtml(
  pages: readonly PageInput[],
  title = "T",
  extra: { pageNumbers?: boolean; pageWord?: string; styleMap?: never } = {}
): string {
  const doc = extractDocument(pages, extra as never);
  return buildHtml(doc, {
    mode: "flow",
    pageNumbers: extra.pageNumbers === true,
    title,
    pageWord: extra.pageWord,
  });
}

/* ================================================================== */
console.log("── 1. model hygiene + px math ─────────────────────────────");
/* ================================================================== */

check(
  "escapeHtml covers & < > \" '",
  escapeHtml(`a & b < c > d "e" 'f'`) ===
    "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;"
);
check("escapeHtml keeps Devanagari intact", escapeHtml("प्रिया शर्मा") === "प्रिया शर्मा");
check("sanitizeRunText strips control chars", sanitizeRunText("a\u0001\u0002b\u007f") === "ab");
check(
  "sanitizeRunText collapses whitespace",
  sanitizeRunText("  a\t\tb\n\n c  ") === "a b c"
);
check(
  "sanitizeRunText passes clean text through",
  sanitizeRunText("Quarterly Report — Q1") === "Quarterly Report — Q1"
);
check("px: 612 pt → 816.00 px (pt × 96/72)", px(612) === "816.00");
check("px: 792 pt → 1056.00 px", px(792) === "1056.00");
check("px: 72 pt → 96.00 px", px(72) === "96.00");
check(
  "px: 22 pt → 29.33 px (2-decimal rounding)",
  px(22) === "29.33" && px(11) === "14.67"
);
check(
  "px: title top math — (792−720−0.8×22) pt → 72.53 px",
  px(792 - 720 - ASCENT_EM * 22) === "72.53"
);

/* ================================================================== */
console.log("── 2. line grouping + paragraphs + dehyphenation ──────────");
/* ================================================================== */

{
  const doc = extractDocument([
    page(1, [
      item("Hello", 72, 100, 10, { width: 25 }),
      item("world", 100, 100, 10, { width: 25 }),
      item("next line", 72, 80, 10),
    ]),
  ]);
  check("3 pieces → 2 paragraphs (line vs line)", doc.blocks.length === 2, doc.blocks);
  check(
    "horizontal gap > quarter font becomes a space",
    doc.blocks[0]?.kind === "para" && doc.blocks[0].runs[0]?.text === "Hello world",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("Hel", 72, 100, 10, { width: 15 }),
      item("lo", 87, 100, 10, { width: 10 }),
    ]),
  ]);
  check(
    "zero gap joins with no space",
    doc.blocks[0]?.kind === "para" && doc.blocks[0].runs[0]?.text === "Hello",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("Some parts are", 72, 100, 10, { width: 70 }),
      item(" ", 142, 100, 10, { width: 3 }),
      item("for the team.", 145, 100, 10, { width: 60 }),
    ]),
  ]);
  check(
    "whitespace-only pdf.js item preserves the split space",
    doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].runs[0]?.text === "Some parts are for the team.",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("first line of text", 72, 100, 10),
      item("second line joins", 72, 88, 10), // gap 12 < 10*1.7
      item("new paragraph", 72, 60, 10), // gap 28 > 17
    ]),
  ]);
  check("gap heuristics: 2 paragraphs", doc.blocks.length === 2, doc.blocks);
  check(
    "joined lines get exactly one space",
    doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].runs.map((r) => r.text).join("") ===
        "first line of text second line joins",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("this is a long exam-", 72, 100, 10),
      item("ple of hyphenation.", 72, 88, 10),
    ]),
  ]);
  check(
    "dehyphenation merges word-",
    doc.blocks.length === 1 &&
      doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].runs[0]?.text === "this is a long example of hyphenation.",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("send it to e-", 72, 100, 10),
      item("Mail support", 72, 88, 10),
    ]),
  ]);
  check(
    "capital after hyphen is not dehyphenated",
    doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].runs.map((r) => r.text).join("") === "send it to e- Mail support",
    doc.blocks[0]
  );
}
{
  const doc = extractDocument([
    page(1, [item("Big Title", 72, 100, 22), item("body starts here", 72, 88, 11)]),
  ]);
  check(
    "font-size change starts a new paragraph even without a gap",
    doc.blocks.length === 2,
    doc.blocks
  );
}

/* ================================================================== */
console.log("── 3. headings, bold/italic, lists ────────────────────────");
/* ================================================================== */

{
  const doc = extractDocument([
    page(1, [
      item("Quarterly Report Title", 72, 720, 22, { fontName: "T-Bold" }),
      item("body text body text body text", 72, 680, 11),
      item("body text body text body text", 72, 666, 11),
      item("Sub Heading Here", 72, 620, 16, { fontName: "T-Bold" }),
      item("more body text follows here", 72, 580, 11),
    ]),
  ]);
  check("largest tier → headingLevel 1", doc.blocks[0]?.kind === "para" && doc.blocks[0].headingLevel === 1);
  check(
    "second tier → headingLevel 2",
    doc.blocks.find(
      (b) => b.kind === "para" && b.runs.some((r) => r.text === "Sub Heading Here")
    )?.kind === "para" &&
      (doc.blocks.find(
        (b) => b.kind === "para" && b.runs.some((r) => r.text === "Sub Heading Here")
      ) as { headingLevel?: number }).headingLevel === 2
  );
  check(
    "body size stays body",
    (doc.blocks.find(
      (b) => b.kind === "para" && b.runs.some((r) => /body text/.test(r.text))
    ) as { headingLevel?: number }).headingLevel === undefined
  );
  check("docStats counts headings", docStats(doc).headings === 2, docStats(doc));
  check("docStats counts paragraphs + pages", docStats(doc).paragraphs === 5 && docStats(doc).pages === 1);

  const flat = extractDocument(
    [
      page(1, [
        item("Quarterly Report Title", 72, 720, 22, { fontName: "T-Bold" }),
        item("body text body text body text", 72, 680, 11),
      ]),
    ],
    { headings: false }
  );
  check(
    "headings switch off → all plain paragraphs",
    flat.blocks.every((b) => b.kind !== "para" || b.headingLevel === undefined)
  );
}
{
  // A tier needs >= 6 chars — a stray large glyph is not a heading.
  const doc = extractDocument([
    page(1, [item("¶", 72, 720, 30), item("normal body text here", 72, 680, 11)]),
  ]);
  check(
    "tiny heading tier is ignored",
    doc.blocks[0]?.kind === "para" && doc.blocks[0].headingLevel === undefined && doc.blocks.length === 2,
    doc.blocks
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("plain words ", 72, 100, 10),
      item("bold words", 130, 100, 10, { fontName: "Helvetica-Bold" }),
    ]),
  ]);
  const runs = doc.blocks[0]?.kind === "para" ? doc.blocks[0].runs : [];
  check(
    "fontName 'Helvetica-Bold' marks the run bold",
    runs.some((r) => r.bold && r.text.trim() === "bold words"),
    runs
  );
  check(
    "non-bold fontName stays plain",
    runs.some((r) => !r.bold && !r.italic && r.text.trim() === "plain words"),
    runs
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("plain ", 72, 100, 10, { fontName: "g_d0_f3" }),
      item("slanted", 95, 100, 10, { fontName: "g_d0_f1" }),
    ]),
  ], {
    styleMap: new Map([
      ["g_d0_f3", { bold: false, italic: false }],
      ["g_d0_f1", { bold: true, italic: true }],
    ]),
  });
  const runs = doc.blocks[0]?.kind === "para" ? doc.blocks[0].runs : [];
  check(
    "styleMap enrichment resolves internal ids (bold + italic)",
    runs.some((r) => r.text.trim() === "slanted" && r.bold && r.italic) &&
      runs.some((r) => r.text.trim() === "plain" && !r.bold && !r.italic),
    runs
  );
}
{
  const doc = extractDocument([
    page(1, [
      item("lead in words", 72, 140, 10),
      item("• Alpha item here", 72, 100, 10),
      item("• Beta item there", 72, 88, 10),
      item("- dash item too", 72, 66, 10),
      item("1. First numbered", 72, 44, 10),
      item("2) Second numbered", 72, 32, 10),
    ]),
  ]);
  const kinds = doc.blocks.map((b) => (b.kind === "list" ? b.list : "para"));
  check(
    "bullet/dash/ordered markers become list blocks",
    kinds.join(",") === "para,ul,ul,ul,ol,ol",
    kinds
  );
  check(
    "markers stripped from the item runs",
    doc.blocks.every((b, i) => {
      if (b.kind !== "list") return true;
      const text = b.runs.map((r) => r.text).join("");
      return !/^[•·\-–]|\d[.)]/.test(text.trim()) && text.length > 0 && i >= 0;
    }),
    doc.blocks.map((b) => (b.kind === "list" ? b.runs.map((r) => r.text).join("") : "-"))
  );
}
{
  // A wrapped continuation line joins its list item, not a new paragraph.
  const doc = extractDocument([
    page(1, [
      item("• wrapped item", 72, 100, 10),
      item("continues on this line", 72, 88, 10),
    ]),
  ]);
  check(
    "continuation line joins the list item",
    doc.blocks.length === 1 &&
      doc.blocks[0]?.kind === "list" &&
      doc.blocks[0].runs.map((r) => r.text).join("") ===
        "wrapped item continues on this line",
    doc.blocks
  );
}
{
  // Heading-tier lines are never list items ("1. Introduction" at 22 pt).
  const doc = extractDocument([
    page(1, [
      item("1. Introduction", 72, 720, 22, { fontName: "T-Bold" }),
      item("body text follows here", 72, 680, 11),
    ]),
  ]);
  check(
    "heading-tier line with an ordered marker stays a heading",
    doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].headingLevel === 1 &&
      !doc.blocks.some((b) => b.kind === "list"),
    doc.blocks
  );
}
{
  // 4-digit years are not ordered markers.
  const doc = extractDocument([
    page(1, [item("2023 was a very good year", 72, 100, 10)]),
  ]);
  check("4-digit year is not a list marker", !doc.blocks.some((b) => b.kind === "list"));
}

/* ================================================================== */
console.log("── 4. clamps, garbage, empty pages, lang, stats ───────────");
/* ================================================================== */

{
  const doc = extractDocument([page(1, [item("x".repeat(600), 72, 100, 10)])]);
  check(
    "runs clamp at 500 chars",
    doc.blocks[0]?.kind === "para" && doc.blocks[0].runs[0]?.text.length === MAX_RUN_CHARS
  );
}
{
  const items: PdfTextItemInput[] = [];
  for (let i = 0; i < MAX_BLOCKS + 5; i += 1) {
    items.push(item(`para ${i}`, 72, 10000 - i * 20, 10));
  }
  const doc = extractDocument([page(1, items)]);
  check("blocks clamp at 2000", doc.blocks.length === MAX_BLOCKS, doc.blocks.length);
}
{
  const doc = extractDocument([
    page(1, [
      { str: 123, transform: null, width: "x" } as unknown as PdfTextItemInput,
      null as unknown as PdfTextItemInput,
      undefined as unknown as PdfTextItemInput,
      item("sur\u0001vi\u0002ves", 72, 100, 10),
      item("", 200, 100, 10),
    ]),
  ]);
  check(
    "garbage items skipped, control chars stripped",
    doc.blocks.length === 1 &&
      doc.blocks[0]?.kind === "para" &&
      doc.blocks[0].runs[0]?.text === "survives",
    doc.blocks
  );
}
{
  // An empty middle page keeps its section with an honest empty note.
  const doc = extractDocument([
    page(1, [item("first page text", 72, 100, 10)]),
    page(2, []),
    page(3, [item("third page text", 72, 100, 10)]),
  ]);
  check("pageStarts: 0, -1, 1", JSON.stringify(doc.pageStarts) === "[0,-1,1]", doc.pageStarts);
  check("docStats counts all selected pages", docStats(doc).pages === 3);
  const html = buildHtml(doc, { mode: "flow", pageNumbers: false, title: "T" });
  check(
    "empty middle page shows the honest note",
    countOf(html, "<p class=\"empty\">") === 1 &&
      /data-page="2"[\s\S]*?<p class="empty">/.test(html),
    html.slice(html.indexOf("data-page=\"2\""), 200)
  );
  const layout = buildHtml(doc, { mode: "layout", pageNumbers: false, title: "T" });
  check(
    "layout keeps 3 sections; empty one has no lines",
    countOf(layout, "class=\"page\"") === 3 &&
      /data-page="2"[\s\S]*?class="empty"/.test(layout) &&
      countOf(layout, "<div class=\"ln\"") === 2,
    countOf(layout, "<div class=\"ln\"")
  );
}
{
  const en = extractDocument([page(1, [item("plain english body", 72, 100, 10)])]);
  const hi = extractDocument([
    page(1, [item("प्रिया शर्मा यहाँ लिखती है", 72, 100, 10)]),
  ]);
  check("lang detection: EN doc → en", buildHtml(en, { mode: "flow", pageNumbers: false, title: "T" }).includes('<html lang="en">'));
  check("lang detection: Hindi doc → hi", buildHtml(hi, { mode: "flow", pageNumbers: false, title: "T" }).includes('<html lang="hi">'));
  check("layoutLineCount counts positioned lines", layoutLineCount(hi) === 1);
}

/* ================================================================== */
console.log("── 5. build shape (flow, synthetic) ───────────────────────");
/* ================================================================== */

{
  const doc = extractDocument([
    page(1, [
      item("Title & <Things>", 72, 100, 20, { fontName: "X-Bold" }),
      item('She said "ok"', 72, 80, 10),
      item("don't", 72, 68, 10),
    ]),
    page(2, [item("second page", 72, 100, 10)]),
  ]);
  const html = buildHtml(doc, {
    mode: "flow",
    pageNumbers: false,
    title: "T & T",
  });
  check("starts with <!doctype html>", html.startsWith("<!doctype html>\n"));
  check("charset meta present", html.includes('<meta charset="utf-8"/>'));
  check("viewport meta present", html.includes('name="viewport"'));
  check("generator meta says MyCloudy", html.includes('name="generator" content="MyCloudy"'));
  check("title escaped", html.includes("<title>T &amp; T</title>"));
  check("body class flow", html.includes('<body class="flow">'));
  check("h1 with escaped content", html.includes("<h1>Title &amp; &lt;Things&gt;</h1>"));
  check("quote escaping", html.includes("She said &quot;ok&quot;"));
  check("apostrophe escaping", html.includes("don&apos;t"));
  check("one section per page", countOf(html, "<section class=\"pg\"") === 2);
  check(
    "sections carry data-page + aria-label",
    html.includes('data-page="1" aria-label="Page 1"') &&
      html.includes('data-page="2" aria-label="Page 2"')
  );
  check("no page-number markers by default", !html.includes("class=\"pgno\""));
  check("ends with </html> + on-device comment", html.trimEnd().endsWith("</html>"));
  check("well-formed (own tokenizer)", htmlWellFormed(html));

  const withNumbers = buildHtml(doc, {
    mode: "flow",
    pageNumbers: true,
    title: "T",
  });
  check(
    "page-number markers on → Page N on both pages",
    countOf(withNumbers, '<p class="pgno">Page 1</p>') === 1 &&
      countOf(withNumbers, '<p class="pgno">Page 2</p>') === 1
  );
  const hindiWord = buildHtml(doc, {
    mode: "flow",
    pageNumbers: true,
    title: "T",
    pageWord: "पृष्ठ",
  });
  check(
    "custom (localized) page word used in markers + labels",
    hindiWord.includes('<p class="pgno">पृष्ठ 1</p>') &&
      hindiWord.includes('aria-label="पृष्ठ 1"')
  );
}

/* ================================================================== */
console.log("── 6. coerceRunOptions + outputBaseName vectors ───────────");
/* ================================================================== */

{
  const garbage = coerceRunOptions({
    mode: 42,
    pageNumbers: "yes",
    pages: null,
    locale: "fr",
    fileWord: 7,
  });
  check(
    "wrong types degrade to defaults",
    garbage.mode === "flow" &&
      garbage.pageNumbers === false &&
      garbage.pages === "all" &&
      garbage.locale === "en" &&
      garbage.fileWord === "",
    garbage
  );
  check(
    "page spec control chars stripped",
    coerceRunOptions({ pages: "1\u0001-2" }).pages === "1-2"
  );
  check(
    "fileWord clamped to 40 chars",
    coerceRunOptions({ fileWord: "x".repeat(90) }).fileWord.length === 40
  );
  const full = coerceRunOptions({
    mode: "layout",
    pageNumbers: true,
    pages: "2-3",
    locale: "hi",
    fileWord: "वेबपेज",
    pageWord: "पृष्ठ",
    noTextWord: "कोई टेक्स्ट नहीं",
  });
  check(
    "every field honoured",
    full.mode === "layout" &&
      full.pageNumbers === true &&
      full.pages === "2-3" &&
      full.locale === "hi" &&
      full.fileWord === "वेबपेज" &&
      full.pageWord === "पृष्ठ" &&
      full.noTextWord === "कोई टेक्स्ट नहीं",
    full
  );
  check(
    "pageNumbers only an explicit true counts",
    coerceRunOptions({ pageNumbers: 1 }).pageNumbers === false
  );
}
check("outputBaseName strips .pdf and hyphenates", outputBaseName("My Page.pdf", "en") === "My-Page");
check("outputBaseName strips path-unsafe chars", outputBaseName("we/ird*name?.pdf", "en") === "weirdname");
check("outputBaseName keeps Devanagari", outputBaseName("रिपोर्ट final.pdf", "en") === "रिपोर्ट-final");
check("outputBaseName collapses runs of hyphens", outputBaseName("My  --Page..pdf", "en") === "My-Page");
check("outputBaseName empty → EN fallback (Webpage)", outputBaseName(".pdf", "en") === "Webpage");
check("outputBaseName empty → HI fallback (वेबपेज)", outputBaseName("", "hi") === "वेबपेज");
check("worker appends .html", `${outputBaseName("report.pdf", "en")}.html` === "report.html");

/* ================================================================== */
console.log("── 7. REAL fixture: pdf-lib build → pdf.js extract → html ─");
/* ================================================================== */

const notoBytes = new Uint8Array(
  readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  )
);

/** The 3-page EN/Hindi fixture (612×792 Letter, metadata title). */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Fixture Report Metadata");
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const page1 = doc.addPage([612, 792]);
  page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
  page1.drawText("This report covers the first quarter of the year.", {
    x: 72,
    y: 680,
    size: 11,
    font: helv,
  });
  page1.drawText("Numbers improved across every region listed.", {
    x: 72,
    y: 666,
    size: 11,
    font: helv,
  });
  // One visual line with a mid-line bold run AND a mid-line italic run.
  const x2 = 72 + helv.widthOfTextAtSize("Some parts are ", 11);
  const x3 = x2 + bold.widthOfTextAtSize("very important", 11);
  const x4 = x3 + oblique.widthOfTextAtSize(" and quite urgent", 11);
  page1.drawText("Some parts are ", { x: 72, y: 620, size: 11, font: helv });
  page1.drawText("very important", { x: x2, y: 620, size: 11, font: bold });
  page1.drawText(" and quite urgent", { x: x3, y: 620, size: 11, font: oblique });
  page1.drawText(" for the team.", { x: x4, y: 620, size: 11, font: helv });
  page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", {
    x: 72,
    y: 580,
    size: 11,
    font: helv,
  });
  page1.drawText("• Alpha item ships today", { x: 72, y: 540, size: 11, font: helv });
  page1.drawText("• Beta item ships tomorrow", { x: 72, y: 526, size: 11, font: helv });
  page1.drawText("1. First step happens", { x: 72, y: 490, size: 11, font: helv });
  page1.drawText("2. Second step follows", { x: 72, y: 476, size: 11, font: helv });

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Second Page Heading", { x: 72, y: 720, size: 16, font: bold });
  page2.drawText('She said "ok" and don\'t worry.', {
    x: 72,
    y: 680,
    size: 11,
    font: helv,
  });

  const page3 = doc.addPage([612, 792]);
  page3.drawText("प्रिया शर्मा", { x: 72, y: 720, size: 14, font: noto });
  page3.drawText("यह एक हिंदी पेज है", { x: 72, y: 690, size: 14, font: noto });

  return new Uint8Array(await doc.save());
}

const fixture = await buildFixture();
check("fixture built (starts with %PDF)", fixture[0] === 0x25 && fixture.length > 500);

/* ---- extract through pdf.js (legacy build, in-process) ---- */
const task = getDocument({ data: fixture.slice(), useSystemFonts: true });
const pdf = await task.promise;
const pages: PdfTextItemInput[][] = [];
const widths: number[] = [];
const heights: number[] = [];
for (let number = 1; number <= pdf.numPages; number += 1) {
  const pageObj = await pdf.getPage(number);
  const viewport = pageObj.getViewport({ scale: 1 });
  const content = await pageObj.getTextContent();
  pageObj.cleanup();
  pages.push(content.items as PdfTextItemInput[]);
  widths.push(viewport.width);
  heights.push(viewport.height);
}
const meta = await pdf.getMetadata();
const metaTitle = (meta as { info?: { Title?: unknown } }).info?.Title;
await pdf.cleanup();
await task.destroy();
check("pdf.js read 3 pages", pages.length === 3);
check(
  "metadata Title came through",
  metaTitle === "Fixture Report Metadata",
  metaTitle
);

const flat = (pages[0] ?? []).concat(pages[1] ?? [], pages[2] ?? []);
const allText = flat
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "raw extraction sees title, body, bold + oblique runs and Hindi",
  allText.includes("Quarterly Report") &&
    allText.includes("Numbers improved") &&
    allText.includes("very important") &&
    allText.includes("quite urgent") &&
    /[ऀ-ॿ]/.test(allText),
  allText.slice(0, 200)
);

/* ---- the worker's own style enrichment (self shim first) ---- */
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (): void => undefined;
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
const { buildFontStyleMap } = await import("../tools/pdf-to-html/worker");

const styleMap = await buildFontStyleMap(fixture, [0, 1, 2], pages);
const veryImportant = flat.find(
  (i) => typeof i.str === "string" && i.str === "very important"
);
const quiteUrgent = flat.find(
  (i) => typeof i.str === "string" && /quite urgent/.test(i.str)
);
const bodyLine = flat.find(
  (i) => typeof i.str === "string" && i.str.startsWith("This report covers")
);
check(
  "buildFontStyleMap resolves the bold run's pdf.js id",
  veryImportant !== undefined && styleMap.get(String(veryImportant.fontName))?.bold === true,
  { map: [...styleMap.entries()], veryImportant }
);
check(
  "buildFontStyleMap resolves the oblique run as italic (not bold)",
  quiteUrgent !== undefined &&
    styleMap.get(String(quiteUrgent.fontName))?.italic === true &&
    styleMap.get(String(quiteUrgent.fontName))?.bold === false,
  [...styleMap.entries()]
);
check(
  "body font stays plain",
  bodyLine !== undefined &&
    styleMap.get(String(bodyLine.fontName))?.bold === false &&
    styleMap.get(String(bodyLine.fontName))?.italic === false
);

/* ---- the model on the REAL extracted items ---- */
const inputs: PageInput[] = pages.map((items, i) => ({
  pageNo: i + 1,
  widthPt: widths[i],
  heightPt: heights[i],
  items,
}));
const docModel = extractDocument(inputs, { styleMap });
const stats = docStats(docModel);
check("fixture geometry is 612×792 pt", widths[0] === 612 && heights[0] === 792, [widths[0], heights[0]]);
check("12 flow blocks detected", stats.paragraphs === 12, stats);
check("2 headings detected (h1 title + h2 page-2 heading)", stats.headings === 2, stats);
check("3 pages detected", stats.pages === 3, stats);
check("pageStarts 0, 8, 10", JSON.stringify(docModel.pageStarts) === "[0,8,10]", docModel.pageStarts);

const html = buildHtml(docModel, {
  mode: "flow",
  pageNumbers: false,
  title: typeof metaTitle === "string" ? metaTitle : "",
});
check("real output starts with <!doctype html>", html.startsWith("<!doctype html>\n"));
check("real output has charset meta", html.includes('<meta charset="utf-8"/>'));
check("real output lang=en (mostly Latin)", html.includes('<html lang="en">'));
check("<title> is the PDF metadata title", html.includes("<title>Fixture Report Metadata</title>"));
check("h1 carries the biggest-font line", html.includes("<h1>Quarterly Report</h1>"));
check("h2 carries the second tier", html.includes("<h2>Second Page Heading</h2>"));
check(
  "two-line body merged into one paragraph",
  html.includes(
    "<p>This report covers the first quarter of the year. Numbers improved across every region listed.</p>"
  ),
  (html.match(/<p>This report[^<]*<\/p>/) ?? [""])[0]
);
check(
  "bold run → <strong>, oblique run → <em>",
  /Some parts are <strong>very important<\/strong><em> ?and quite urgent<\/em> for the team\./.test(
    html
  ),
  (html.match(/Some parts are.{0,120}/) ?? [""])[0]
);
check("& escaping in the real output", html.includes("revenue &amp; costs") && html.includes("Q1 &lt; Q2 &gt;"));
check("quote + apostrophe escaping", html.includes("She said &quot;ok&quot; and don&apos;t"));
check(
  "bullets group into ONE <ul>",
  html.includes("<ul><li>Alpha item ships today</li><li>Beta item ships tomorrow</li></ul>")
);
check(
  "ordered markers group into ONE <ol>",
  html.includes("<ol><li>First step happens</li><li>Second step follows</li></ol>")
);
check(
  "Hindi survives as plain UTF-8 (any glyph order)",
  (html.includes("प्रिया") || html.includes("िप्रया")) && /[ऀ-ॿ]/.test(html),
  (html.match(/[ऀ-ॿ][ऀ-ॿ\s]*[ऀ-ॿ]/g) ?? []).join(" | ")
);
check(
  "three page sections in order",
  countOf(html, "<section class=\"pg\"") === 3 &&
    html.indexOf('data-page="1"') < html.indexOf('data-page="2"') &&
    html.indexOf('data-page="2"') < html.indexOf('data-page="3"')
);
check("no page-number markers by default", !html.includes("class=\"pgno\""));
check("real flow output is well-formed", htmlWellFormed(html));

const htmlNumbers = buildHtml(docModel, {
  mode: "flow",
  pageNumbers: true,
  title: "Fixture Report Metadata",
});
check(
  "page markers on all 3 pages",
  countOf(htmlNumbers, '<p class="pgno">Page 1</p>') === 1 &&
    countOf(htmlNumbers, '<p class="pgno">Page 2</p>') === 1 &&
    countOf(htmlNumbers, '<p class="pgno">Page 3</p>') === 1
);

/* ---- title fallback: first h1 (worker cascade step 2) ---- */
{
  const h1 = docModel.blocks.find(
    (b) => b.kind === "para" && b.headingLevel === 1
  );
  const fallbackTitle = h1 ? h1.runs.map((r) => r.text).join("").trim() : "";
  const fallback = buildHtml(docModel, {
    mode: "flow",
    pageNumbers: false,
    title: fallbackTitle || "fallback",
  });
  check("title fallback: first h1 text reaches <title>", fallback.includes("<title>Quarterly Report</title>"));
}

/* ================================================================== */
console.log("── 8. LAYOUT mode: exact px geometry ──────────────────────");
/* ================================================================== */

const layout = buildHtml(docModel, {
  mode: "layout",
  pageNumbers: false,
  title: "Fixture Report Metadata",
});
check("layout body class", layout.includes('<body class="layout">'));
check(
  "per-page sections with EXACT px dims (612×792 pt → 816.00×1056.00 px)",
  countOf(layout, 'style="width:816.00px;height:1056.00px"') === 3,
  (layout.match(/style="width:[^"]+"/g) ?? []).join(" | ")
);
check(
  "13 positioned lines",
  countOf(layout, "<div class=\"ln\"") === 13,
  countOf(layout, "<div class=\"ln\"")
);
check(
  "title line at exact left/top/font-size (pt × 96/72, 0.8 em ascent)",
  /<div class="ln" style="left:96\.00px;top:72\.53px;font-size:29\.33px"><strong>Quarterly Report<\/strong><\/div>/.test(
    layout
  ),
  (layout.match(/.{0,120}Quarterly Report.{0,40}/s) ?? [""])[0]
);
check(
  "body line at exact left/top/font-size",
  /<div class="ln" style="left:96\.00px;top:137\.60px;font-size:14\.67px">This report covers/.test(
    layout
  ),
  (layout.match(/.{0,120}This report covers.{0,40}/s) ?? [""])[0]
);
check(
  "layout keeps bold + italic inline",
  layout.includes("<strong>very important</strong>") &&
    /<em> ?and quite urgent<\/em>/.test(layout)
);
check(
  "Hindi lines positioned on page 3",
  /data-page="3"[\s\S]*?<div class="ln"[\s\S]*?[ऀ-ॿ]/.test(layout)
);
check("layout: no page markers by default", !layout.includes("class=\"pgno\""));
check("layout output is well-formed", htmlWellFormed(layout));

const layoutNumbers = buildHtml(docModel, {
  mode: "layout",
  pageNumbers: true,
  title: "T",
});
check(
  "layout page markers present",
  countOf(layoutNumbers, '<p class="pgno">Page 2</p>') === 1
);
check("layoutLineCount === 13", layoutLineCount(docModel) === 13);

/* ================================================================== */
console.log("── 9. page-range subset (worker call shape) ───────────────");
/* ================================================================== */

const spec1 = parsePageSpec("1", 3);
check('parsePageSpec("1", 3) → [0]', JSON.stringify(spec1) === "[0]");
{
  const subset = extractDocument(
    (spec1 ?? []).map((i) => inputs[i]),
    { styleMap }
  );
  const sub = buildHtml(subset, { mode: "flow", pageNumbers: false, title: "T" });
  check("subset: one section, page 1 only", countOf(sub, "<section class=\"pg\"") === 1 && sub.includes('data-page="1"'));
  check("subset: page-1 needle present", sub.includes("Quarterly Report"));
  check("subset: page-2 + page-3 needles absent", !sub.includes("Second Page Heading") && !/[ऀ-ॿ]/.test(sub));

  const spec23 = parsePageSpec("2-3", 3);
  check('parsePageSpec("2-3", 3) → [1,2]', JSON.stringify(spec23) === "[1,2]");
  const tail = extractDocument((spec23 ?? []).map((i) => inputs[i]), {
    styleMap,
  });
  const tailHtml = buildHtml(tail, { mode: "flow", pageNumbers: false, title: "T" });
  check("subset 2-3: page-2 + Hindi present, page-1 absent", tailHtml.includes("Second Page Heading") && /[ऀ-ॿ]/.test(tailHtml) && !tailHtml.includes("Quarterly Report"));
  check(
    "subset 2-3: page numbers are the ORIGINAL pdf numbers",
    tailHtml.includes('data-page="2"') && tailHtml.includes('data-page="3"') && !tailHtml.includes('data-page="1"')
  );
}
check("parsePageSpec rejects garbage", parsePageSpec("abc", 4) === null);
check("parsePageSpec open range", JSON.stringify(parsePageSpec("2-", 3)) === "[1,2]");

/* ================================================================== */
console.log("── 10. rejection vectors (encrypted / garbage) ────────────");
/* ================================================================== */

{
  // Encrypted fixture via @cantoo/pdf-lib (the lock-pdf engine's fork).
  const enc = await CantooPDF.create();
  enc.addPage([612, 792]);
  await enc.encrypt({
    userPassword: "secret-one",
    ownerPassword: "secret-two",
    algorithm: "AES-256",
    permissions: {
      printing: "highResolution",
      copying: true,
      modifying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
  const encBytes = new Uint8Array(await enc.save());
  let encMessage = "";
  try {
    const t = getDocument({ data: encBytes.slice() });
    await t.promise;
    await t.destroy();
  } catch (error) {
    encMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "encrypted fixture: pdf.js demands a password",
    /password/i.test(encMessage),
    encMessage
  );
  check(
    "encrypted → honest tool.errorEncrypted",
    pdfErrorMessageToCode(encMessage) === "tool.errorEncrypted"
  );

  // Garbage bytes: pdf.js refuses to parse → corrupt.
  const garbage = new Uint8Array(2048);
  for (let i = 0; i < garbage.length; i += 1) {
    garbage[i] = (i * 31 + 7) & 0xff;
  }
  let garbageMessage = "";
  try {
    const t = getDocument({ data: garbage.slice() });
    await t.promise;
    await t.destroy();
  } catch (error) {
    garbageMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "garbage bytes rejected by pdf.js",
    garbageMessage.length > 0,
    garbageMessage
  );
  check(
    "garbage → honest tool.errorCorrupt",
    pdfErrorMessageToCode(garbageMessage) === "tool.errorCorrupt"
  );
  check(
    "mapping helper: password-ish messages → encrypted, rest corrupt",
    pdfErrorMessageToCode("No password given") === "tool.errorEncrypted" &&
      pdfErrorMessageToCode("Incorrect password") === "tool.errorEncrypted" &&
      pdfErrorMessageToCode("Invalid PDF structure") === "tool.errorCorrupt"
  );
}

/* ================================================================== */
console.log("── 11. wiring + i18n ──────────────────────────────────────");
/* ================================================================== */

{
  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const m = registrySrc.match(/id: "pdf-to-html"[\s\S]*?enabled: (true|false)/);
  check("registry pdf-to-html enabled: true", m?.[1] === "true");
  check(
    "registry pdf-to-html stays mode D (device-only)",
    /id: "pdf-to-html",\s*\n\s*category: "convert-from",\s*\n\s*mode: "D",/.test(registrySrc)
  );

  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "TOOL_CONFIGS routes pdf-to-html",
    /pdfToHtml\.toolId\]\s*:\s*pdfToHtml/.test(configsSrc)
  );

  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "TOOL_SURFACES maps pdf-to-html",
    /"pdf-to-html": PdfToHtmlSurface/.test(surfacesSrc)
  );

  const i18n = JSON.parse(
    readFileSync("tools/pdf-to-html/i18n.json", "utf8")
  ) as {
    en: { phtml: Record<string, string> };
    hi: { phtml: Record<string, string> };
  };
  const enKeys = Object.keys(i18n.en.phtml).sort();
  const hiKeys = Object.keys(i18n.hi.phtml).sort();
  check(
    "i18n en/hi key parity (phtml.*)",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys) && enKeys.length > 30,
    { en: enKeys.length, hi: hiKeys.length }
  );
  check(
    "i18n no empty values",
    Object.values(i18n.en.phtml).every((v) => v.trim().length > 0) &&
      Object.values(i18n.hi.phtml).every((v) => v.trim().length > 0)
  );

  const surfaceSrc = readFileSync("tools/pdf-to-html/surface.tsx", "utf8");
  const used = new Set<string>();
  for (const match of surfaceSrc.matchAll(/t\("(phtml\.[a-zA-Z0-9]+)"/g)) {
    used.add(match[1].slice("phtml.".length));
  }
  for (const key of ["how1", "how2", "how3"]) used.add(key);
  const missing = [...used].filter(
    (k) => !(k in i18n.en.phtml) || !(k in i18n.hi.phtml)
  );
  check(
    "every phtml.* key used by surface/config resolves in BOTH catalogs",
    missing.length === 0,
    missing
  );

  const configSrc = readFileSync("tools/pdf-to-html/config.ts", "utf8");
  check(
    "config toolId + accept .pdf via registry + outputKind text (pdf-to-word match)",
    /toolId: "pdf-to-html"/.test(configSrc) &&
      /outputKind: "text"/.test(configSrc)
  );
}

/* ================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
if (fail > 0) {
  console.error("failing:", failures.slice(0, 25).join(" | "));
  process.exit(1);
}
process.exit(0);
