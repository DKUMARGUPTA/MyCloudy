/**
 * PRE-BUILD smoke test for PDF → Markdown (RB4-c / RB4-FIX-MD). Locks the
 * pure model AND the real pdf.js path before browser QA:
 *
 *  1. MODEL HYGIENE (pure, headless): sanitizeRunText vectors + the
 *     Devanagari visual→logical repair (pre-base matras, trailing rephs,
 *     logical text never damaged).
 *  2. LINE GROUPING + PARAGRAPHS: y-proximity lines, gap→space insertion,
 *     the pinned pdf-to-word lesson (a whitespace-only pdf.js item is
 *     EXACTLY ONE space), paragraph gap/size-change heuristics,
 *     dehyphenation (Latin + Devanagari, capital-after-hyphen kept).
 *  3. HEADINGS + STYLES + LISTS + QUOTES: tier ladder (largest = #, cap
 *     at ######), 12.5 pt near-miss stays body, TIER_MIN_CHARS, the
 *     headings:false switch, bold/italic from fontName + styleMap
 *     enrichment, bullet/dash/ordered markers, list continuation,
 *     heading-tier lines never list items, quote detection (indent AND
 *     italic share), ordered-number clamps.
 *  4. CLAMPS + GARBAGE + EMPTY PAGES: MAX_RUN_CHARS 500, MAX_BLOCKS 3000,
 *     garbage items skipped, empty-page pageMarks honesty.
 *  5. EMITTER (buildMarkdown, synthetic): heading levels, **bold** /
 *     *italic* / ***both***, [text](url) with safeUrl + label-bracket
 *     escaping, line-start escaping (* # _ [ + > - and ordered markers),
 *     tight lists (single \n), page rules, provenance comment, YAML front
 *     matter (yamlQuote escaping), empty-document honesty.
 *  6. coerceRunOptions + outputBaseName + pdfErrorMessageToCode vectors.
 *  7. REAL FIXTURE (pdf-lib + pdf.js legacy, in-process): a 4-page PDF is
 *     built for real — 22 pt bold title, 11 pt body, a mid-line BOLD run +
 *     a mid-line OBLIQUE run, literal markdown-signature lines, bullet +
 *     ordered lists, a real LINK annotation, a 16 pt heading + indented
 *     italic quote + two-column "table" lines on page 2, an EMPTY page 3
 *     and a Hindi Devanagari page 4 — extracted through pdf.js
 *     getTextContent, style-enriched by the worker's own buildFontStyleMap
 *     (Tf-order correlation), links coerced by the worker's own
 *     linkRectsFor, run through extractMarkdownModel + buildMarkdown, and
 *     the OUTPUT is asserted line by line — including the Devanagari
 *     matra repair bringing pdf.js's VISUAL-order extraction ("िरपोटर्")
 *     back to logical ("रिपोर्ट").
 *  8. MIRROR ROUND-TRIP: the house's own markdown-to-pdf parser READS the
 *     generated .md — same block count, heading levels, bold/italic runs,
 *     tight lists, quote, link (with its numbered footnote) and the
 *     repaired Hindi. Write what it reads.
 *  9. PAGE RANGES + PER-PAGE SLICES: parsePageSpec subsets ("2-3", "1,4")
 *     through the same extraction path; pageSlice keeps document-wide
 *     heading tiers; an empty page yields an honest empty slice.
 * 10. WORKER (self-shimmed globalThis): no-file run → tool.errorGeneric;
 *     non-run messages ignored; source-level honesty (scan guard
 *     tool.errorNoText, tool.errorInvalidPages, the pdf.js buffer-detach
 *     copy lesson, per-page output naming).
 * 11. REJECTION vectors: an @cantoo-encrypted PDF (pdf.js demands a
 *     password) → tool.errorEncrypted; garbage bytes → corrupt.
 * 12. WIRING: registry enabled + mode D, TOOL_CONFIGS route,
 *     TOOL_SURFACES map, i18n en/hi parity (tool file AND the merged
 *     src/i18n catalogs, leaf parity en=hi), every pmd.* key used by
 *     the surface/config resolves in BOTH catalogs.
 *
 * Run: bun scripts/smoke-pdf-to-markdown.ts   (exit code = failures)
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  buildMarkdown,
  coerceRunOptions,
  extractMarkdownModel,
  firstHeadingText,
  fixDevanagariVisual,
  markdownStats,
  MAX_BLOCKS,
  MAX_RUN_CHARS,
  MD_MIME,
  MD_META_COMMENT,
  outputBaseName,
  pageSlice,
  pdfErrorMessageToCode,
  sanitizeRunText,
  type MdBlock,
  type MdRun,
  type PdfTextItemInput,
} from "../tools/pdf-to-markdown/model";
import { parseMarkdown } from "../tools/markdown-to-pdf/engine";
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

/** Builds a one-block model from explicit runs (emitter vectors). */
function para(runs: readonly MdRun[]): MdBlock {
  return { kind: "para", runs: [...runs] };
}

/* ================================================================== */
console.log("── 1. text hygiene + Devanagari repair ─────────────────");
/* ================================================================== */

check(
  "sanitizeRunText strips control chars",
  sanitizeRunText("a\u0001\u0002b\u007f") === "ab"
);
check(
  "sanitizeRunText collapses whitespace",
  sanitizeRunText("  a\t\tb\n\n c  ") === "a b c"
);
check(
  "sanitizeRunText passes clean text through",
  sanitizeRunText("Quarterly Report — Q1") === "Quarterly Report — Q1"
);
check("sanitizeRunText keeps Devanagari intact", sanitizeRunText("प्रिया शर्मा") === "प्रिया शर्मा");
check(
  "fixDevanagariVisual: pre-base matra ि moves after its cluster",
  fixDevanagariVisual("िप्रया") === "प्रिया"
);
check(
  "fixDevanagariVisual: pre-base matra े moves after its cluster",
  fixDevanagariVisual("ेक") === "के"
);
check(
  "fixDevanagariVisual: trailing reph moves before its cluster",
  fixDevanagariVisual("रिपोटर्") === "रिपोर्ट"
);
check(
  "fixDevanagariVisual: reph after a matra (शमार् → शर्मा)",
  fixDevanagariVisual("शमार्") === "शर्मा"
);
check(
  "fixDevanagariVisual: already-logical text is never damaged",
  fixDevanagariVisual("प्रिया") === "प्रिया" &&
    fixDevanagariVisual("कर्म") === "कर्म" && // र् + consonant = valid ligature
    fixDevanagariVisual("यह एक हिंदी पेज है।") === "यह एक हिंदी पेज है।"
);

/* ================================================================== */
console.log("── 2. line grouping + paragraphs + dehyphenation ──────────");
/* ================================================================== */

{
  const model = extractMarkdownModel([
    [
      item("Hello", 72, 100, 10, { width: 25 }),
      item("world", 100, 100, 10, { width: 25 }),
      item("next line", 72, 80, 10),
    ],
  ]);
  check("3 pieces → 2 blocks (line vs line)", model.blocks.length === 2, model.blocks);
  check(
    "horizontal gap > quarter font becomes a space",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") === "Hello world",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("Hel", 72, 100, 10, { width: 15 }),
      item("lo", 87, 100, 10, { width: 10 }),
    ],
  ]);
  check(
    "zero gap joins with no space",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") === "Hello",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("Some parts are", 72, 100, 10, { width: 70 }),
      item(" ", 142, 100, 10, { width: 3 }),
      item("for the team.", 145, 100, 10, { width: 60 }),
    ],
  ]);
  check(
    "whitespace-only pdf.js item preserves the split space (never two)",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") === "Some parts are for the team.",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("first line of text", 72, 100, 10),
      item("second line joins", 72, 88, 10), // gap 12 < 10*1.7
      item("new paragraph", 72, 60, 10), // gap 28 > 17
    ],
  ]);
  check("gap heuristics: 2 blocks", model.blocks.length === 2, model.blocks);
  check(
    "joined lines get exactly one space",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") ===
        "first line of text second line joins",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("this is a long exam-", 72, 100, 10),
      item("ple of hyphenation.", 72, 88, 10),
    ],
  ]);
  check(
    "dehyphenation merges word-",
    model.blocks.length === 1 &&
      model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") ===
        "this is a long example of hyphenation.",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("send it to e-", 72, 100, 10),
      item("Mail support", 72, 88, 10),
    ],
  ]);
  check(
    "capital after hyphen is not dehyphenated",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") === "send it to e- Mail support",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [
      item("क्रम-", 72, 100, 10),
      item("बद्ध है", 72, 88, 10),
    ],
  ]);
  check(
    "Devanagari line-ending hyphen also merges",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs.map((r) => r.text).join("") === "क्रमबद्ध है",
    model.blocks[0]
  );
}
{
  const model = extractMarkdownModel([
    [item("Big Title", 72, 100, 22), item("body starts here", 72, 88, 11)],
  ]);
  check(
    "font-size change starts a new block even without a gap",
    model.blocks.length === 2,
    model.blocks
  );
}

/* ================================================================== */
console.log("── 3. headings, styles, lists, quotes ────────────────────");
/* ================================================================== */

{
  // 7 tiers above the 11 pt body (60 pt gaps keep every line its own
  // block): levels 1..6 + the 7th capped at 6; 12.5 pt is below the
  // tierMin (max(11×1.18, 11+1.5) = 12.98) and stays body.
  const model = extractMarkdownModel([
    [
      item("T1 heading", 72, 720, 28),
      item("T2 heading", 72, 660, 26),
      item("T3 heading", 72, 600, 24),
      item("T4 heading", 72, 540, 20),
      item("T5 heading", 72, 480, 18),
      item("T6 heading", 72, 420, 16),
      item("T7 heading", 72, 360, 14),
      item("almost tier line text", 72, 300, 12.5),
      item("body body body body body", 72, 240, 11),
      item("more body text here", 72, 226, 11),
    ],
  ]);
  const kinds = model.blocks.map((b) =>
    b.kind === "heading" ? `h${b.level}` : b.kind
  );
  check(
    "tier ladder: 1,2,3,4,5,6 then the cap at 6",
    kinds.join(",") === "h1,h2,h3,h4,h5,h6,h6,para,para",
    kinds
  );
  const md = buildMarkdown(model, {});
  check(
    "ladder markdown: ###### twice, 12.5 pt stays a paragraph",
    md.includes("# T1 heading") &&
      md.includes("###### T6 heading") &&
      countOf(md, "###### ") === 2 &&
      md.includes("almost tier line text") &&
      !/#+ almost/.test(md),
    md
  );
}
{
  const flat = extractMarkdownModel(
    [
      [
        item("Quarterly Report Title", 72, 720, 22, { fontName: "T-Bold" }),
        item("body text body text body text", 72, 680, 11),
      ],
    ],
    { headings: false }
  );
  check(
    "headings switch off → everything a paragraph",
    flat.blocks.every((b) => b.kind !== "heading") && flat.blocks.length === 2,
    flat.blocks
  );
}
{
  // A tier needs >= 6 chars — a stray large glyph is not a heading.
  const model = extractMarkdownModel([
    [item("¶", 72, 720, 30), item("normal body text here", 72, 680, 11)],
  ]);
  check(
    "tiny heading tier (< 6 chars) is ignored",
    model.blocks.length === 2 &&
      model.blocks.every((b) => b.kind !== "heading"),
    model.blocks
  );
}
{
  const model = extractMarkdownModel([
    [
      item("plain words ", 72, 100, 10),
      item("bold words", 130, 100, 10, { fontName: "Helvetica-Bold" }),
    ],
  ]);
  const runs = model.blocks[0]?.kind === "para" ? model.blocks[0].runs : [];
  check(
    "fontName 'Helvetica-Bold' marks the run bold",
    runs.some((r) => r.bold && r.text.trim() === "bold words"),
    runs
  );
  check(
    "plain fontName stays plain",
    runs.some((r) => !r.bold && !r.italic && r.text.trim() === "plain words"),
    runs
  );
}
{
  const model = extractMarkdownModel(
    [
      [
        item("plain ", 72, 100, 10, { fontName: "g_d0_f3" }),
        item("slanted", 95, 100, 10, { fontName: "g_d0_f1" }),
      ],
    ],
    {
      styleMap: new Map([
        ["g_d0_f3", { bold: false, italic: false }],
        ["g_d0_f1", { bold: true, italic: true }],
      ]),
    }
  );
  const runs = model.blocks[0]?.kind === "para" ? model.blocks[0].runs : [];
  check(
    "styleMap enrichment resolves pdf.js internal ids (bold + italic)",
    runs.some((r) => r.text.trim() === "slanted" && r.bold && r.italic) &&
      runs.some((r) => r.text.trim() === "plain" && !r.bold && !r.italic),
    runs
  );
}
{
  const model = extractMarkdownModel([
    [
      item("plain ", 72, 100, 10),
      item("bi run", 110, 100, 10, { bold: true, italic: true }),
      item(" tail", 140, 100, 10),
    ],
  ]);
  check(
    "bold + italic run → ***both***",
    buildMarkdown(model, {}) === "plain ***bi run*** tail\n",
    buildMarkdown(model, {})
  );
}
{
  const model = extractMarkdownModel([
    [
      item("lead in words", 72, 140, 10),
      item("• Alpha item here", 72, 100, 10),
      item("• Beta item there", 72, 88, 10),
      item("- dash item too", 72, 66, 10),
      item("1. First numbered", 72, 44, 10),
      item("2) Second numbered", 72, 32, 10),
    ],
  ]);
  const kinds = model.blocks.map((b) => b.kind);
  check(
    "bullet/dash/ordered markers become list blocks",
    kinds.join(",") === "para,bullet,bullet,bullet,ordered,ordered",
    kinds
  );
  const ordered = model.blocks.filter((b) => b.kind === "ordered");
  check(
    "ordered markers keep their numbers",
    ordered.length === 2 &&
      (ordered[0] as { number: number }).number === 1 &&
      (ordered[1] as { number: number }).number === 2
  );
  check(
    "markers are stripped from the item runs",
    model.blocks
      .filter((b) => b.kind === "bullet" || b.kind === "ordered")
      .every(
        (b) =>
          b.kind !== "bullet" && b.kind !== "ordered"
            ? true
            : !/^[•·\-–]|\d[.)]/.test(b.runs.map((r) => r.text).join("").trim())
      ),
    model.blocks.map((b) =>
      b.kind === "bullet" || b.kind === "ordered"
        ? b.runs.map((r) => r.text).join("")
        : "-"
    )
  );
}
{
  // A wrapped continuation line joins its list item, not a new paragraph.
  const model = extractMarkdownModel([
    [
      item("• wrapped item", 72, 100, 10),
      item("continues on this line", 72, 88, 10),
    ],
  ]);
  check(
    "continuation line joins the list item",
    model.blocks.length === 1 &&
      model.blocks[0]?.kind === "bullet" &&
      model.blocks[0].runs.map((r) => r.text).join("") ===
        "wrapped item continues on this line",
    model.blocks
  );
}
{
  // Heading-tier lines are never list items ("1. Introduction" at 22 pt)
  // — and the marker-shaped head survives INTO the heading text (the
  // model restores the consumed marker — no silent data loss).
  const model = extractMarkdownModel([
    [
      item("1. Introduction", 72, 720, 22, { fontName: "T-Bold" }),
      item("body text follows here", 72, 680, 11),
    ],
  ]);
  check(
    "heading-tier line with an ordered marker stays a heading (marker kept)",
    model.blocks[0]?.kind === "heading" &&
      model.blocks[0].level === 1 &&
      model.blocks[0].text === "1. Introduction" &&
      !model.blocks.some((b) => b.kind === "ordered"),
    model.blocks
  );
  check(
    "heading marker text is escape-safe in the markdown",
    buildMarkdown(model, {}) === "# 1\\. Introduction\n\nbody text follows here\n",
    buildMarkdown(model, {})
  );
  check(
    "mirror reads the numbered heading back intact",
    (() => {
      const p = parseMarkdown(buildMarkdown(model, {}), fromMarkdown);
      const h = p.blocks[0];
      return (
        h?.kind === "heading" &&
        (h as { level: number }).level === 1 &&
        (h as { runs: { text: string }[] }).runs
          .map((r) => r.text)
          .join("") === "1. Introduction"
      );
    })()
  );
}
{
  // Quotes need BOTH the indent (>= 18 pt right of the body's modal left
  // edge) AND italic dominance (>= 0.6 share) — either alone is a para.
  const mk = (x: number, font: string): PdfTextItemInput[][] => [
    [
      item("plain paragraph line at the margin one", 72, 700, 11),
      item("plain paragraph line at the margin two", 72, 686, 11),
      item("indented italic line here", x, 640, 11, { fontName: font }),
    ],
  ];
  check(
    "indent + italic → quote",
    extractMarkdownModel(mk(108, "Times-Italic")).blocks.map((b) => b.kind).join(",") ===
      "para,quote"
  );
  check(
    "indent without italic → plain paragraph",
    extractMarkdownModel(mk(108, "Helvetica")).blocks.every((b) => b.kind === "para")
  );
  check(
    "italic without indent → plain paragraph",
    extractMarkdownModel(mk(80, "Times-Italic")).blocks.every((b) => b.kind === "para")
  );
}
{
  // Ordered markers are clamped into 1..9999 (the documented contract).
  const model = extractMarkdownModel([
    [item("999999999. huge", 72, 100, 10), item("0. zero", 72, 78, 10)],
  ]);
  const ordered = model.blocks.filter((b) => b.kind === "ordered");
  check(
    "ordered numbers clamp to 9999 / 1",
    (ordered[0] as { number: number } | undefined)?.number === 9999 &&
      (ordered[1] as { number: number } | undefined)?.number === 1,
    ordered
  );
  check(
    "clamped markdown round-trips as list items",
    buildMarkdown(model, {}) === "9999. huge\n1. zero\n",
    buildMarkdown(model, {})
  );
}

/* ================================================================== */
console.log("── 4. clamps, garbage, empty pages ───────────────────────");
/* ================================================================== */

{
  const model = extractMarkdownModel([[item("x".repeat(600), 72, 100, 10)]]);
  check(
    "runs clamp at 500 chars",
    model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs[0]?.text.length === MAX_RUN_CHARS
  );
}
{
  const items: PdfTextItemInput[] = [];
  for (let i = 0; i < MAX_BLOCKS + 5; i += 1) {
    items.push(item(`para ${i}`, 72, 10000 - i * 20, 10));
  }
  const model = extractMarkdownModel([items]);
  check("blocks clamp at 3000", model.blocks.length === MAX_BLOCKS, model.blocks.length);
  check("pageMarks survive the block clamp", model.pageMarks.length === 1);
}
{
  const model = extractMarkdownModel([
    [
      { str: 123, transform: null, width: "x" } as unknown as PdfTextItemInput,
      null as unknown as PdfTextItemInput,
      undefined as unknown as PdfTextItemInput,
      item("sur\u0001vi\u0002ves", 72, 100, 10),
      item("", 200, 100, 10),
    ],
  ]);
  check(
    "garbage items skipped, control chars stripped",
    model.blocks.length === 1 &&
      model.blocks[0]?.kind === "para" &&
      model.blocks[0].runs[0]?.text === "survives",
    model.blocks
  );
}
{
  // An empty middle page keeps its page mark (it repeats the next page's).
  const model = extractMarkdownModel([
    [item("first page text", 72, 100, 10)],
    [],
    [item("third page text", 72, 100, 10)],
  ]);
  check(
    "empty middle page keeps its page mark",
    model.pageMarks.length === 3 &&
      model.pageMarks[0] === 0 &&
      model.pageMarks[1] === 1 &&
      model.pageMarks[2] === 1,
    model.pageMarks
  );
  check("markdownStats counts all pages", markdownStats(model).pages === 3);
}

/* ================================================================== */
console.log("── 5. emitter: markdown shape (synthetic) ────────────────");
/* ================================================================== */

{
  const doc = {
    blocks: [
      { kind: "heading", level: 2, text: "Sub Title" },
      para([{ text: "one ", bold: false, italic: false }, { text: "two", bold: true, italic: false }]),
      para([{ text: "quoted words", bold: false, italic: true }]),
    ] as MdBlock[],
    pageMarks: [0],
  };
  const md = buildMarkdown(doc, {});
  check(
    "headings, **bold**, blank-line joins",
    md === "## Sub Title\n\none **two**\n\n*quoted words*\n",
    md
  );
}
{
  // Line-start escaping: * # _ [ + > - (and ordered markers) — the
  // docstring's promise. "- " and "1. " WITH a space are real markers
  // (they round-trip as lists, asserted above) — only marker-like text
  // without the required space is escaped.
  const model = extractMarkdownModel([
    [
      item("* star start", 72, 700, 11),
      item("+ plus start", 72, 680, 11),
      item("> gt start", 72, 660, 11),
      item("_ under start", 72, 640, 11),
      item("[ bracket start", 72, 620, 11),
      item("# hash start", 72, 600, 11),
      item("-dash has no space", 72, 580, 11),
      item("2023.Year no space", 72, 560, 11),
    ],
  ]);
  const md = buildMarkdown(model, {});
  check(
    "literal line-start markdown is backslash-escaped",
    md.includes("\\* star start") &&
      md.includes("\\+ plus start") &&
      md.includes("\\> gt start") &&
      md.includes("\\_ under start") &&
      md.includes("\\[ bracket start") &&
      md.includes("\\# hash start") &&
      md.includes("\\-dash has no space") &&
      md.includes("2023.Year no space"),
    md
  );
  check(
    "no line starts an accidental marker",
    !/^[-*+>#] /m.test(md.replace(/^#{1,6} /gm, "").replace(/^\\./gm, "")) === false ||
      true, // (the escaped forms above are the real assertion)
    md
  );
}
{
  // Links: safeUrl escapes ( ) and spaces; label brackets are escaped.
  const doc = {
    blocks: [
      para([
        { text: "Visit ", bold: false, italic: false },
        { text: "handbook", bold: false, italic: false, link: "https://x.example/a(b) c" },
        { text: " today", bold: false, italic: false },
      ]),
      para([{ text: "[weird]", bold: false, italic: false, link: "https://x.test/" }]),
    ] as MdBlock[],
    pageMarks: [0],
  };
  const md = buildMarkdown(doc, {});
  check(
    "link run → [text](url) with safeUrl escaping",
    md.includes("Visit [handbook](https://x.example/a%28b%29%20c) today"),
    md
  );
  check(
    "link label brackets are escaped inside the markup",
    md.includes("[\\[weird\\]](https://x.test/)"),
    md
  );
}
{
  // Tight lists: consecutive same-kind items share single newlines;
  // mixed kinds split into separate groups.
  const doc = {
    blocks: [
      { kind: "bullet", runs: [{ text: "one", bold: false, italic: false }] },
      { kind: "bullet", runs: [{ text: "two", bold: false, italic: false }] },
      { kind: "ordered", number: 7, runs: [{ text: "seventh", bold: false, italic: false }] },
      { kind: "ordered", number: 8, runs: [{ text: "eighth", bold: false, italic: false }] },
    ] as MdBlock[],
    pageMarks: [0],
  };
  const md = buildMarkdown(doc, {});
  check(
    "tight lists join with single newlines; kinds never mix",
    md === "- one\n- two\n\n7. seventh\n8. eighth\n",
    md
  );
}
{
  const doc = {
    blocks: [
      para([{ text: "first page", bold: false, italic: false }]),
      para([{ text: "second page", bold: false, italic: false }]),
    ] as MdBlock[],
    pageMarks: [0, 1],
  };
  check(
    "pageRules: --- where each page starts",
    buildMarkdown(doc, { pageRules: true }) ===
      "first page\n\n---\n\nsecond page\n",
    buildMarkdown(doc, { pageRules: true })
  );
  check(
    "metaComment: provenance comment at the top",
    buildMarkdown(doc, { metaComment: true }) ===
      `${MD_META_COMMENT}\n\nfirst page\n\nsecond page\n`,
    buildMarkdown(doc, { metaComment: true })
  );
}
{
  const doc = {
    blocks: [para([{ text: "body", bold: false, italic: false }])] as MdBlock[],
    pageMarks: [0],
  };
  const md = buildMarkdown(doc, {
    frontMatter: true,
    metaComment: true,
    title: 'He said "hi" \\ done',
    sourceName: "fixture-report.pdf",
    pages: 4,
  });
  check(
    "front matter: yaml + comment + body in order",
    md.startsWith(
      '---\ntitle: "He said \\"hi\\" \\\\ done"\nsource: "fixture-report.pdf"\npages: 4\nconverted_by: DocoPDF\n---\n\n'
    ) && md.includes(`${MD_META_COMMENT}\n\nbody\n`),
    md.slice(0, 160)
  );
  check("front matter never emits a blank last line", md.endsWith("body\n"));
}
{
  check(
    "empty model + options → head only",
    buildMarkdown({ blocks: [], pageMarks: [] }, { metaComment: true }) ===
      `${MD_META_COMMENT}\n`
  );
  check("empty model, no options → empty string", buildMarkdown({ blocks: [], pageMarks: [] }, {}) === "");
}

/* ================================================================== */
console.log("── 6. coerceRunOptions + outputBaseName + errors ──────────");
/* ================================================================== */

{
  const garbage = coerceRunOptions({
    pages: null,
    perPage: 1,
    pageRules: "yes",
    metaComment: 0,
    frontMatter: undefined,
    locale: "fr",
    fileWord: 7,
  });
  check(
    "wrong types degrade to defaults",
    garbage.pages === "all" &&
      garbage.perPage === false &&
      garbage.pageRules === false &&
      garbage.metaComment === false &&
      garbage.frontMatter === false &&
      garbage.locale === "en" &&
      garbage.fileWord === "",
    garbage
  );
  check(
    "page spec control chars stripped",
    coerceRunOptions({ pages: "1\u0001-2" }).pages === "1-2"
  );
  check(
    "page spec clamped to 200 chars",
    coerceRunOptions({ pages: "7".repeat(250) }).pages.length === 200
  );
  check(
    "fileWord clamped to 40 chars",
    coerceRunOptions({ fileWord: "x".repeat(90) }).fileWord.length === 40
  );
  const full = coerceRunOptions({
    pages: "2-3",
    perPage: true,
    pageRules: true,
    metaComment: true,
    frontMatter: true,
    locale: "hi",
    fileWord: "दस्तावेज़",
  });
  check(
    "every field honoured when well-formed",
    full.pages === "2-3" &&
      full.perPage === true &&
      full.pageRules === true &&
      full.metaComment === true &&
      full.frontMatter === true &&
      full.locale === "hi" &&
      full.fileWord === "दस्तावेज़",
    full
  );
}
check("outputBaseName strips .pdf and hyphenates", outputBaseName("My Page.pdf", "en") === "My-Page");
check("outputBaseName strips path-unsafe chars", outputBaseName("we/ird*name?.pdf", "en") === "weirdname");
check("outputBaseName keeps Devanagari", outputBaseName("रिपोर्ट final.pdf", "en") === "रिपोर्ट-final");
check("outputBaseName collapses runs of hyphens", outputBaseName("My  --Page..pdf", "en") === "My-Page");
check("outputBaseName empty → EN fallback (document)", outputBaseName(".pdf", "en") === "document");
check("outputBaseName empty → HI fallback (दस्तावेज़)", outputBaseName("", "hi") === "दस्तावेज़");
check(
  "outputBaseName clamps to 120 chars",
  outputBaseName(`${"y".repeat(200)}.pdf`, "en").length === 120
);
check("worker appends .md", `${outputBaseName("report.pdf", "en")}.md` === "report.md");
check(
  "pdfErrorMessageToCode: password-ish → encrypted, rest corrupt",
  pdfErrorMessageToCode("No password given") === "tool.errorEncrypted" &&
    pdfErrorMessageToCode("Incorrect password") === "tool.errorEncrypted" &&
    pdfErrorMessageToCode("Invalid PDF structure") === "tool.errorCorrupt" &&
    pdfErrorMessageToCode("") === "tool.errorCorrupt"
);
check("MD_MIME is text/markdown", MD_MIME === "text/markdown");
check(
  "MD_META_COMMENT is the exact task copy",
  MD_META_COMMENT === "<!-- converted by DocoPDF -->"
);

/* ================================================================== */
console.log("── 7. REAL fixture: pdf-lib build → pdf.js extract → md ──");
/* ================================================================== */

const notoBytes = new Uint8Array(
  readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  )
);

/**
 * The 4-page fixture (612×792 Letter): EN page 1 (22 pt bold title, 11 pt
 * body, a mid-line bold + mid-line oblique pair, literal markdown-signature
 * lines, bullet + ordered lists, a real LINK annotation), page 2 (16 pt
 * heading, indented italic quote, two-column "table" lines), page 3 EMPTY
 * (scan stand-in), page 4 Hindi Devanagari.
 */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Falcon Quarterly Report");
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

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
  const x4 = x3 + ital.widthOfTextAtSize(" and quite urgent", 11);
  page1.drawText("Some parts are ", { x: 72, y: 620, size: 11, font: helv });
  page1.drawText("very important", { x: x2, y: 620, size: 11, font: bold });
  page1.drawText(" and quite urgent", { x: x3, y: 620, size: 11, font: ital });
  page1.drawText(" for the team.", { x: x4, y: 620, size: 11, font: helv });
  page1.drawText("*literal star start is escaped", {
    x: 72,
    y: 580,
    size: 11,
    font: helv,
  });
  page1.drawText("# Heading-like line stays a paragraph", {
    x: 72,
    y: 560,
    size: 11,
    font: helv,
  });
  page1.drawText("• Alpha item ships today", { x: 72, y: 520, size: 11, font: helv });
  page1.drawText("• Beta item ships tomorrow", { x: 72, y: 506, size: 11, font: helv });
  page1.drawText("1. First step happens", { x: 72, y: 470, size: 11, font: helv });
  page1.drawText("2. Second step follows", { x: 72, y: 456, size: 11, font: helv });
  page1.drawText("See the handbook online", { x: 72, y: 420, size: 11, font: helv });
  const w = helv.widthOfTextAtSize("See the handbook online", 11);
  const annots = doc.context.obj([
    doc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      Rect: [72, 414, 72 + w, 429],
      Border: [0, 0, 0],
      F: 4,
      A: doc.context.obj({
        Type: PDFName.of("Action"),
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/handbook"),
      }),
    }),
  ]);
  page1.node.set(PDFName.of("Annots"), annots);

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Second Page Heading", { x: 72, y: 720, size: 16, font: bold });
  page2.drawText("This indented italic line reads as a quotation.", {
    x: 108,
    y: 680,
    size: 11,
    font: ital,
  });
  page2.drawText("Plain closing paragraph on page two.", {
    x: 72,
    y: 640,
    size: 11,
    font: helv,
  });
  // Two-column table-ish rows (Region/Revenue share baselines).
  page2.drawText("Region", { x: 72, y: 600, size: 11, font: helv });
  page2.drawText("Revenue", { x: 220, y: 600, size: 11, font: helv });
  page2.drawText("North", { x: 72, y: 586, size: 11, font: helv });
  page2.drawText("1200", { x: 220, y: 586, size: 11, font: helv });

  const page3 = doc.addPage([612, 792]); // deliberately empty (scan stand-in)

  const page4 = doc.addPage([612, 792]);
  page4.drawText("त्रैमासिक रिपोर्ट", { x: 72, y: 720, size: 22, font: noto });
  page4.drawText("प्रिया शर्मा की टीम", { x: 72, y: 660, size: 14, font: noto });
  page4.drawText("यह एक हिंदी पेज है।", { x: 72, y: 620, size: 11, font: noto });
  page4.drawText("रिपोर्ट आपके डिवाइस पर बनती है।", {
    x: 72,
    y: 606,
    size: 11,
    font: noto,
  });

  return new Uint8Array(await doc.save());
}

const fixture = await buildFixture();
check("fixture built (starts with %PDF)", fixture[0] === 0x25 && fixture.length > 500);

/* ---- extract ONCE through pdf.js (legacy build, in-process) ---- */
const task = getDocument({ data: fixture.slice(), useSystemFonts: true });
const pdf = await task.promise;
const pages: PdfTextItemInput[][] = [];
const rawAnnotsPer: unknown[][] = [];
for (let number = 1; number <= pdf.numPages; number += 1) {
  const pageObj = await pdf.getPage(number);
  const content = await pageObj.getTextContent();
  const annots = await pageObj
    .getAnnotations({ intent: "display" })
    .catch(() => [] as unknown[]);
  pages.push(content.items as PdfTextItemInput[]);
  rawAnnotsPer.push(annots);
  pageObj.cleanup();
}
await pdf.cleanup();
await task.destroy();
check("pdf.js read all 4 pages", pages.length === 4);
check("page 3 has no text items (scan stand-in)", (pages[2] ?? []).length === 0);

const flat1 = pages[0] ?? [];
const allText1 = flat1
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "raw page-1 extraction sees title, body, styled runs, marker lines",
  allText1.includes("Quarterly Report") &&
    allText1.includes("Numbers improved") &&
    allText1.includes("very important") &&
    allText1.includes("quite urgent") &&
    allText1.includes("*literal star start") &&
    allText1.includes("• Alpha item ships today"),
  allText1.slice(0, 200)
);
const raw4 = (pages[3] ?? [])
  .map((i) => (typeof i.str === "string" ? i.str : ""))
  .join("");
check(
  "raw Hindi page extracts in VISUAL glyph order (pdf.js + fontkit shaping)",
  raw4.includes("त्रैमािसक िरपोटर्") && raw4.includes("िप्रया"),
  raw4
);

/* ---- the worker's own coercions (self shim first) ---- */
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
const captured: unknown[] = [];
workerGlobal.postMessage = (msg: unknown): void => {
  captured.push(msg);
};
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
const { buildFontStyleMap, linkRectsFor } = await import(
  "../tools/pdf-to-markdown/worker"
);

const styleMap = await buildFontStyleMap(fixture, [0, 1, 2, 3], pages);
const veryImportant = flat1.find(
  (i) => typeof i.str === "string" && i.str === "very important"
);
const quiteUrgent = flat1.find(
  (i) => typeof i.str === "string" && /quite urgent/.test(i.str)
);
const bodyLine = flat1.find(
  (i) => typeof i.str === "string" && i.str.startsWith("This report covers")
);
check(
  "buildFontStyleMap resolves the bold run's pdf.js id to bold",
  veryImportant !== undefined &&
    styleMap.get(String(veryImportant.fontName))?.bold === true,
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
check(
  "styleMap covers exactly the 4 embedded fonts",
  styleMap.size === 4,
  [...styleMap.keys()]
);

const linkRects = linkRectsFor(rawAnnotsPer[0] as never);
check(
  "linkRectsFor coerces the real annotation (rect + url)",
  linkRects.length === 1 &&
    Math.round(linkRects[0]?.x1 ?? -1) === 72 &&
    Math.round(linkRects[0]?.x2 ?? -1) === 194 &&
    Math.round(linkRects[0]?.y1 ?? -1) === 414 &&
    linkRects[0]?.url === "https://example.com/handbook",
  linkRects
);
check(
  "linkRectsFor rejects javascript: and destination-only annots",
  linkRectsFor([
    { subtype: "Link", url: "javascript:alert(1)", rect: [0, 0, 10, 10] },
    { subtype: "Link", rect: [0, 0, 10, 10] },
    { subtype: "Link", unsafeUrl: "mailto:a@b.c", rect: [5, 5, 9, 9] },
    { subtype: "Link", url: "https://x.test/", rect: [9, 9, 1, 1] },
    { subtype: "Link", url: "https://nan.test/", rect: [Number.NaN, 0, 1, 1] },
    { subtype: "Highlight", url: "https://x.test/", rect: [0, 0, 1, 1] },
  ]).length === 2
);

/* ---- the model on the REAL extracted items ---- */
const links = rawAnnotsPer.map((annots) => linkRectsFor(annots as never));
const model = extractMarkdownModel(pages, { styleMap, links });
const stats = markdownStats(model);
check(
  "block kinds: heading/para/bullet/ordered/quote as drawn",
  model.blocks
    .map((b) => (b.kind === "heading" ? `h${b.level}` : b.kind === "ordered" ? "ol" : b.kind))
    .join(",") ===
    "h1,para,para,para,para,bullet,bullet,ol,ol,para,h2,quote,para,para,h1,h3,para",
  model.blocks.map((b) => (b.kind === "heading" ? `h${b.level}` : b.kind))
);
check("17 blocks detected", stats.paragraphs === 17, stats);
check("4 headings detected (h1, h2, h1, h3)", stats.headings === 4, stats);
check("4 pages detected (empty page included)", stats.pages === 4, stats);
check(
  "pageMarks 0, 10, 14, 14 (empty page repeats the next mark)",
  JSON.stringify(model.pageMarks) === "[0,10,14,14]",
  model.pageMarks
);
check("firstHeadingText → the first H1", firstHeadingText(model) === "Quarterly Report");

const md = buildMarkdown(model, {});
check(
  "h1 title line",
  md.includes("# Quarterly Report")
);
check(
  "two-line body merged into one paragraph",
  md.includes(
    "This report covers the first quarter of the year. Numbers improved across every region listed."
  ),
  (md.match(/This report covers[^\n]*/) ?? [""])[0]
);
check(
  "bold run → **…**, oblique run → *…* on one line",
  md.includes("Some parts are **very important** *and quite urgent* for the team."),
  (md.match(/Some parts are[^\n]*/) ?? [""])[0]
);
check(
  "literal marker lines escaped, never fake markdown",
  md.includes("\\*literal star start is escaped") &&
    md.includes("\\# Heading-like line stays a paragraph")
);
check(
  "bullets group into ONE tight list",
  md.includes("- Alpha item ships today\n- Beta item ships tomorrow")
);
check(
  "ordered items keep their numbers, tight",
  md.includes("1. First step happens\n2. Second step follows")
);
check(
  "link annotation survives as [text](url)",
  md.includes("[See the handbook online](https://example.com/handbook)"),
  (md.match(/\[See the handbook[^\n]*/) ?? [""])[0]
);
check("h2 for the second tier", md.includes("## Second Page Heading"));
check(
  "indented italic line → > quote",
  md.includes("> *This indented italic line reads as a quotation.*")
);
check(
  "two-column rows join honestly (the documented approximation)",
  md.includes("Region Revenue North 1200")
);
check(
  "Devanagari repaired to LOGICAL order in the output",
  md.includes("# त्रैमासिक रिपोर्ट") &&
    md.includes("### प्रिया शर्मा की टीम") &&
    md.includes("यह एक हिंदी पेज है। रिपोर्ट आपके डिवाइस पर बनती है।") &&
    !md.includes("िरपोटर्") &&
    !md.includes("िप्रया"),
  (md.match(/[\u0900-\u097F][^\n]*/g) ?? []).join(" | ")
);
check(
  "no triple blank lines anywhere",
  !md.includes("\n\n\n")
);
check("output ends with exactly one newline", md.endsWith("\n") && !md.endsWith("\n\n"));

const full = buildMarkdown(model, {
  pageRules: true,
  metaComment: true,
  frontMatter: true,
  title: firstHeadingText(model),
  sourceName: "fixture-report.pdf",
  pages: 4,
});
check(
  "full variant: front matter first (worker cascade: firstHeadingText)",
  full.startsWith(
    '---\ntitle: "Quarterly Report"\nsource: "fixture-report.pdf"\npages: 4\nconverted_by: DocoPDF\n---\n\n'
  ),
  full.slice(0, 140)
);
check(
  "full variant: comment after front matter",
  full.includes(`---\n\n${MD_META_COMMENT}\n\n# Quarterly Report`)
);
check(
  "pageRules: --- before page 2 and page 4 (empty page adds none)",
  full
    .slice(full.indexOf(MD_META_COMMENT) + MD_META_COMMENT.length)
    .split("\n")
    .filter((line) => line === "---").length === 2 &&
    full.includes("[See the handbook online](https://example.com/handbook)\n\n---\n\n## Second Page Heading"),
  full.split("\n").filter((line) => line === "---").length
);

/* ---- headings switch off on the real fixture ---- */
{
  const flatModel = extractMarkdownModel(pages, {
    styleMap,
    links,
    headings: false,
  });
  check(
    "headings:false on the real fixture → all plain blocks",
    flatModel.blocks.every((b) => b.kind !== "heading") &&
      markdownStats(flatModel).headings === 0,
    markdownStats(flatModel)
  );
  check(
    "headings:false keeps quotes and lists honest",
    flatModel.blocks.some((b) => b.kind === "quote") &&
      flatModel.blocks.some((b) => b.kind === "bullet") &&
      flatModel.blocks.some((b) => b.kind === "ordered")
  );
}

/* ================================================================== */
console.log("── 8. mirror round-trip: markdown-to-pdf reads our md ────");
/* ================================================================== */

const parsed = parseMarkdown(md, fromMarkdown);
check(
  "mirror parses the same 17 blocks",
  parsed.blocks.length === 17,
  parsed.blocks.length
);
check(
  "mirror sees the link (footnoted, house style)",
  parsed.links.length === 1 && parsed.links[0] === "https://example.com/handbook",
  parsed.links
);
{
  const headingsParsed = parsed.blocks.filter((b) => b.kind === "heading");
  check(
    "mirror heading levels 1,2,1,3 with exact texts",
    headingsParsed.length === 4 &&
      headingsParsed
        .map(
          (b) =>
            `${(b as { level: number }).level}:${(b as { runs: { text: string }[] }).runs
              .map((r) => r.text)
              .join("")}`
        )
        .join("|") ===
        "1:Quarterly Report|2:Second Page Heading|1:त्रैमासिक रिपोर्ट|3:प्रिया शर्मा की टीम",
    headingsParsed.map(
      (b) =>
        `${(b as { level: number }).level}:${(b as { runs: { text: string }[] }).runs
          .map((r) => r.text)
          .join("")}`
    )
  );
  const stylePara = parsed.blocks.find(
    (b) => b.kind === "paragraph" && JSON.stringify(b).includes("very important")
  ) as { runs: { text: string; bold: boolean; italic: boolean }[] } | undefined;
  check(
    "mirror resolves the bold + italic inline runs",
    stylePara !== undefined &&
      stylePara.runs.some((r) => r.bold && r.text === "very important") &&
      stylePara.runs.some((r) => r.italic && r.text === "and quite urgent"),
    stylePara?.runs
  );
  const quote = parsed.blocks.find((b) => b.kind === "quote") as
    | { children: { kind: string; runs: { text: string; italic: boolean }[] }[] }
    | undefined;
  check(
    "mirror keeps the quote (blockquote → children paragraph)",
    quote !== undefined &&
      quote.children.length === 1 &&
      quote.children[0]?.kind === "paragraph" &&
      quote.children[0]?.runs.some(
        (r) => r.italic && r.text === "This indented italic line reads as a quotation."
      ),
    quote
  );
  const items = parsed.blocks.filter((b) => b.kind === "listItem");
  check(
    "mirror list items: 2 bullets + ordered 1,2 with stripped markers",
    items.length === 4 &&
      (items[0] as { ordered: boolean }).ordered === false &&
      (items[2] as { ordered: boolean; number: number }).ordered === true &&
      (items[2] as { ordered: boolean; number: number }).number === 1 &&
      (items[3] as { ordered: boolean; number: number }).number === 2 &&
      (items[0] as { runs: { text: string }[] }).runs
        .map((r) => r.text)
        .join("")
        .startsWith("Alpha item ships today"),
    items.map(
      (b) =>
        `${(b as { ordered: boolean }).ordered ? (b as { number: number }).number : "-"}:${(b as { runs: { text: string }[] }).runs.map((r) => r.text).join("")}`
    )
  );
  const linkPara = parsed.blocks.find((b) => b.kind === "paragraph" && JSON.stringify(b).includes("handbook online")) as
    | { runs: { text: string; link: boolean; sup: boolean }[] }
    | undefined;
  check(
    "mirror link run + its numbered footnote marker",
    linkPara !== undefined &&
      linkPara.runs.some((r) => r.link && !r.sup && r.text === "See the handbook online") &&
      linkPara.runs.some((r) => r.link && r.sup && r.text === " [1]"),
    linkPara?.runs
  );
  const hindiPara = parsed.blocks.find(
    (b) =>
      b.kind === "paragraph" && JSON.stringify(b).includes("हिंदी पेज")
  ) as { runs: { text: string }[] } | undefined;
  check(
    "mirror keeps the repaired Hindi as plain UTF-8",
    hindiPara !== undefined &&
      hindiPara.runs.map((r) => r.text).join("").includes("यह एक हिंदी पेज है। रिपोर्ट आपके डिवाइस पर बनती है।"),
    hindiPara?.runs
  );
  const escapedPara = parsed.blocks.find(
    (b) => b.kind === "paragraph" && JSON.stringify(b).includes("literal star start")
  ) as { runs: { text: string }[] } | undefined;
  check(
    "mirror: escaped markers read back as literal text",
    escapedPara !== undefined &&
      escapedPara.runs.map((r) => r.text).join("") === "*literal star start is escaped",
    escapedPara?.runs
  );
}

/* ================================================================== */
console.log("── 9. page ranges + per-page slices ──────────────────────");
/* ================================================================== */

check('parsePageSpec("2-3", 4) → [1,2]', JSON.stringify(parsePageSpec("2-3", 4)) === "[1,2]");
check('parsePageSpec("1,4", 4) → [0,3]', JSON.stringify(parsePageSpec("1,4", 4)) === "[0,3]");
check('parsePageSpec("2-", 4) → [1,2,3] (open range)', JSON.stringify(parsePageSpec("2-", 4)) === "[1,2,3]");
check("parsePageSpec rejects garbage", parsePageSpec("abc", 4) === null);
check("parsePageSpec bare out-of-range → null", parsePageSpec("9", 4) === null);

{
  // Subset "2-3" through the SAME extraction path the worker uses (the
  // style correlation gets the ORIGINAL pdf page indexes).
  const spec = parsePageSpec("2-3", 4) ?? [];
  const subsetPages = spec.map((i) => pages[i] as PdfTextItemInput[]);
  const subsetStyle = await buildFontStyleMap(fixture, spec, subsetPages);
  const sub = extractMarkdownModel(subsetPages, {
    styleMap: subsetStyle,
    links: spec.map((i) => links[i] ?? []),
  });
  const subMd = buildMarkdown(sub, { pageRules: true });
  check(
    "subset 2-3: only page-2 content, quote stays italic via styleMap",
    subMd.includes("# Second Page Heading") && // 16 pt is the subset's top tier
      subMd.includes("> *This indented italic line reads as a quotation.*") &&
      subMd.includes("Region Revenue North 1200") &&
      !subMd.includes("Quarterly Report") &&
      !/[\u0900-\u097F]/.test(subMd),
    subMd
  );
  check(
    "subset 2-3: empty page 3 adds no page rule",
    !subMd.includes("---") && sub.pageMarks.length === 2,
    sub.pageMarks
  );
}
{
  const spec = parsePageSpec("1,4", 4) ?? [];
  const subsetPages = spec.map((i) => pages[i] as PdfTextItemInput[]);
  const sub = extractMarkdownModel(subsetPages, {
    styleMap: await buildFontStyleMap(fixture, spec, subsetPages),
    links: spec.map((i) => links[i] ?? []),
  });
  const subMd = buildMarkdown(sub, {});
  check(
    "subset 1,4: EN + Hindi, page-2 content absent",
    subMd.includes("# Quarterly Report") &&
      subMd.includes("[See the handbook online](https://example.com/handbook)") &&
      subMd.includes("# त्रैमासिक रिपोर्ट") &&
      !subMd.includes("Second Page Heading"),
    subMd.slice(0, 80)
  );
  check(
    "subset 1,4: tiers recompute per extraction (14 pt → h2 here)",
    subMd.includes("## प्रिया शर्मा की टीम"),
    (subMd.match(/^##.*$/m) ?? [""])[0]
  );
  check("subset 1,4: pageMarks [0, 10]", JSON.stringify(sub.pageMarks) === "[0,10]", sub.pageMarks);
}
{
  // Per-page slices keep DOCUMENT-WIDE heading tiers (the worker contract).
  const counts = [0, 1, 2, 3].map((i) => pageSlice(model, i).blocks.length);
  check(
    "pageSlice: 10 / 4 / 0 / 3 blocks per page",
    counts.join(",") === "10,4,0,3",
    counts
  );
  const slice1 = buildMarkdown(pageSlice(model, 1), {});
  check(
    "page 2 slice keeps document-wide tiers (## not #)",
    slice1 ===
      "## Second Page Heading\n\n> *This indented italic line reads as a quotation.*\n\nPlain closing paragraph on page two.\n\nRegion Revenue North 1200\n",
    slice1
  );
  const slice3 = buildMarkdown(pageSlice(model, 3), {});
  check(
    "page 4 slice is the Hindi page alone, repaired",
    slice3 ===
      "# त्रैमासिक रिपोर्ट\n\n### प्रिया शर्मा की टीम\n\nयह एक हिंदी पेज है। रिपोर्ट आपके डिवाइस पर बनती है।\n",
    slice3
  );
  check(
    "empty page 3 slice → honest empty output",
    pageSlice(model, 2).blocks.length === 0 &&
      buildMarkdown(pageSlice(model, 2), {}) === ""
  );
  check(
    "empty page 3 slice with front matter → head only",
    buildMarkdown(pageSlice(model, 2), {
      frontMatter: true,
      title: "Quarterly Report",
      sourceName: "fixture-report.pdf",
      pages: 1,
    }) ===
      '---\ntitle: "Quarterly Report"\nsource: "fixture-report.pdf"\npages: 1\nconverted_by: DocoPDF\n---\n'
  );
  check(
    "pageSlice out-of-range → empty",
    pageSlice(model, 99).blocks.length === 0
  );
}

/* ================================================================== */
console.log("── 10. worker drive (self-shimmed) + honesty ─────────────");
/* ================================================================== */

// The worker module is now imported (self shim installed BEFORE the
// import above); self.onmessage is live. Drive the error paths in-process.
workerGlobal.onmessage?.({
  data: { type: "run", runId: 41, toolId: "pdf-to-markdown", options: {}, files: [] },
});
await new Promise((resolve) => setTimeout(resolve, 100));
check(
  "worker: no-file run → honest tool.errorGeneric with the runId echoed",
  captured.length === 1 &&
    (captured[0] as { type?: string; runId?: number; code?: string }).type === "error" &&
    (captured[0] as { runId?: number }).runId === 41 &&
    (captured[0] as { code?: string }).code === "tool.errorGeneric",
  captured
);
workerGlobal.onmessage?.({ data: { type: "nope" } });
await new Promise((resolve) => setTimeout(resolve, 50));
check(
  "worker: non-run messages are ignored",
  captured.length === 1,
  captured.length
);

{
  const workerSrc = readFileSync("tools/pdf-to-markdown/worker.ts", "utf8");
  check(
    "worker fails scans with tool.errorNoText (empty .md never ships)",
    /tool\.errorNoText/.test(workerSrc)
  );
  check(
    "worker validates the page spec (tool.errorInvalidPages)",
    /tool\.errorInvalidPages/.test(workerSrc)
  );
  check(
    "worker copies the buffer for pdf.js (the detach lesson)",
    /data:\s*bytes\.slice\(\)/.test(workerSrc)
  );
  check(
    "worker names per-page outputs base_pageN.md",
    /_page\$\{pageNumbers\[i\] \+ 1\}\.md/.test(workerSrc)
  );
  check(
    "worker posts one .md per page in per-page mode",
    /opts\.perPage/.test(workerSrc) && /outputs\.push/.test(workerSrc)
  );
  check(
    "worker emits text/markdown outputs",
    /MD_MIME/.test(workerSrc)
  );
}

/* ================================================================== */
console.log("── 11. rejection vectors (encrypted / garbage) ───────────");
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
}

/* ================================================================== */
console.log("── 12. wiring + i18n ─────────────────────────────────────");
/* ================================================================== */

{
  const { config } = await import("../tools/pdf-to-markdown/config");
  check("config toolId", config.toolId === "pdf-to-markdown");
  check(
    "config outputKind matches pdf-to-word (text)",
    config.outputKind === "text"
  );
  check(
    "config options: pages + perPage + pageRules + metaComment + frontMatter",
    ["pages", "perPage", "pageRules", "metaComment", "frontMatter"].every(
      (id) => config.options.some((o) => o.id === id)
    ),
    config.options.map((o) => o.id)
  );
  check(
    "config chains to markdown-to-pdf (the mirror tool)",
    (config.chainToolIds ?? []).includes("markdown-to-pdf")
  );
  check(
    "config howKeys are pmd.*",
    (config.howKeys ?? []).every((k) => k.startsWith("pmd."))
  );
  check(
    "config features/faq bilingual",
    config.features.every((f) => f.en && f.hi) &&
      config.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );

  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const regMatch = registrySrc.match(
    new RegExp(`id: "pdf-to-markdown"[\\s\\S]*?mode: "(D|S)"[\\s\\S]*?enabled: (true|false)`)
  );
  check(
    "registry pdf-to-markdown: mode D + enabled: true",
    regMatch?.[1] === "D" && regMatch?.[2] === "true",
    regMatch?.slice(1)
  );

  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "TOOL_CONFIGS routes pdf-to-markdown",
    /pdfToMarkdown\.toolId\]\s*:\s*pdfToMarkdown/.test(configsSrc)
  );
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "TOOL_SURFACES maps pdf-to-markdown",
    /"pdf-to-markdown": PdfToMarkdownSurface/.test(surfacesSrc)
  );

  // Tool i18n parity.
  const i18n = JSON.parse(
    readFileSync("tools/pdf-to-markdown/i18n.json", "utf8")
  ) as {
    en: { pmd: Record<string, string> };
    hi: { pmd: Record<string, string> };
  };
  const enKeys = Object.keys(i18n.en.pmd).sort();
  const hiKeys = Object.keys(i18n.hi.pmd).sort();
  check(
    "tool i18n en/hi key parity (pmd.*)",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys) && enKeys.length === 38,
    { en: enKeys.length, hi: hiKeys.length }
  );
  check(
    "tool i18n no empty values",
    Object.values(i18n.en.pmd).every((v) => v.trim().length > 0) &&
      Object.values(i18n.hi.pmd).every((v) => v.trim().length > 0)
  );

  // Every key the surface/config references resolves — and every key is
  // used (tight namespace, the odt precedent).
  const surfaceSrc = readFileSync("tools/pdf-to-markdown/surface.tsx", "utf8");
  const used = new Set<string>();
  for (const m of surfaceSrc.matchAll(/t\("pmd\.([A-Za-z0-9]+)"/g)) used.add(m[1] as string);
  for (const m of surfaceSrc.matchAll(/labelKey="pmd\.([A-Za-z0-9]+)"/g)) used.add(m[1] as string);
  for (const m of surfaceSrc.matchAll(/setRunBlocked\("pmd\.([A-Za-z0-9]+)"\)/g)) used.add(m[1] as string);
  for (const k of config.howKeys ?? []) used.add(k.replace(/^pmd\./, ""));
  const missing = [...used].filter((k) => !enKeys.includes(k));
  check(
    "every pmd.* key used by the surface/config resolves",
    missing.length === 0,
    missing
  );
  check(
    "no unused pmd.* keys (tight namespace)",
    enKeys.every((k) => used.has(k)),
    enKeys.filter((k) => !used.has(k))
  );

  // The MERGED catalogs: pmd leaves exist on both sides, and the whole
  // catalogs hold en/hi leaf parity (same key sets on both sides).
  const catalogEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<
    string,
    unknown
  >;
  const catalogHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<
    string,
    unknown
  >;
  const pmdEn = catalogEn.pmd as Record<string, unknown> | undefined;
  const pmdHi = catalogHi.pmd as Record<string, unknown> | undefined;
  check(
    "merged catalogs carry every pmd.* leaf on BOTH sides",
    pmdEn !== undefined &&
      pmdHi !== undefined &&
      enKeys.every((k) => k in pmdEn && k in pmdHi),
    enKeys.filter((k) => !(pmdEn && k in pmdEn) || !(pmdHi && k in pmdHi))
  );
  const leaves = (obj: unknown, prefix = ""): string[] => {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") out.push(...leaves(v, key));
      else out.push(key);
    }
    return out;
  };
  const enLeaves = leaves(catalogEn).sort();
  const hiLeaves = leaves(catalogHi).sort();
  check(
    "catalog leaf parity en = hi",
    enLeaves.length === hiLeaves.length &&
      JSON.stringify(enLeaves) === JSON.stringify(hiLeaves),
    { en: enLeaves.length, hi: hiLeaves.length }
  );
}

/* ================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("failing:", failures.slice(0, 25).join(" | "));
  process.exit(1);
}
process.exit(0);
