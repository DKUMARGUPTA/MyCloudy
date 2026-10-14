/**
 * PRE-BUILD smoke test for the Markdown → PDF tool (P4.1). Proves the pure
 * mdast → block model + the shared layout engine + the worker's full draw
 * recipe with bun (the P3.3 lesson — prove the engine, then build on it):
 *
 *  1. parseMarkdown (mdast-util-from-markdown@2.0.2): headings h1-h6,
 *     bold/italic/inline-code, ordered + nested lists, multi-line code with
 *     a blank interior line, blockquote (with a nested list inside),
 *     thematicBreak, links (+ reference links), images as honest [alt]
 *     text, unresolved image references as literals, block html skipped,
 *     hard breaks kept, soft breaks joined with a space.
 *  2. layoutMd geometry with REAL pdf-lib fonts (Helvetica family, Courier,
 *     embedded Noto Devanagari — the stamp-common pipeline): every run
 *     re-measured against the content box, markers, code backgrounds, quote
 *     bars, rules, link footnotes + Links section, warm theme flag.
 *  3. Pagination: a 300+ line document spans multiple pages, page count
 *     grows, no empty trailing page, headings never the last line of a page
 *     (swept across every page-boundary alignment), ≤3-line code blocks
 *     never split.
 *  4. Worker draw recipe → save → reload → page count + sizes match the
 *     pageSize option (a4 + letter, warm + clean).
 *
 * Run: bun scripts/smoke-md2pdf.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";

import {
  MM_TO_PT,
  PAGE_SIZES,
  type FontSpec,
  type MeasureRun,
  type PositionedTextRun,
  type ScriptFont,
} from "../tools/txt-to-pdf/text-layout";
import {
  layoutMd,
  parseMarkdown,
  resolveMdOptions,
  type MdLayoutResult,
  type MdOptions,
  type ParsedMarkdown,
} from "../tools/markdown-to-pdf/engine";
import { fromMarkdown } from "mdast-util-from-markdown";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* Font set — the worker's exact loading + selection logic             */
/* ------------------------------------------------------------------ */

interface FontSet {
  helv: PDFFont;
  helvBold: PDFFont;
  helvOblique: PDFFont;
  helvBoldOblique: PDFFont;
  courier: PDFFont;
  courierBold: PDFFont;
  noto: PDFFont;
}

const TTF_PATH = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf";

async function makeFontSet(doc: PDFDocument): Promise<FontSet> {
  doc.registerFontkit(fontkit);
  const ttfBytes = new Uint8Array(await readFile(TTF_PATH));
  return {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    helvBold: await doc.embedFont(StandardFonts.HelveticaBold),
    helvOblique: await doc.embedFont(StandardFonts.HelveticaOblique),
    helvBoldOblique: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    courier: await doc.embedFont(StandardFonts.Courier),
    courierBold: await doc.embedFont(StandardFonts.CourierBold),
    noto: await doc.embedFont(ttfBytes, { subset: true }),
  };
}

function fontFor(set: FontSet, spec: FontSpec, script: ScriptFont): PDFFont {
  if (script === "noto") return set.noto;
  if (spec.family === "mono") return spec.bold ? set.courierBold : set.courier;
  if (spec.bold && spec.italic) return set.helvBoldOblique;
  if (spec.bold) return set.helvBold;
  if (spec.italic) return set.helvOblique;
  return set.helv;
}

const measureDoc = await PDFDocument.create();
const measureFonts = await makeFontSet(measureDoc);
const measure: MeasureRun = (text, spec, size, script) =>
  fontFor(measureFonts, spec, script).widthOfTextAtSize(text, size);

const runWidth = (run: PositionedTextRun): number =>
  fontFor(measureFonts, run.spec, run.script).widthOfTextAtSize(run.text, run.size);

/* ------------------------------------------------------------------ */
/* Fixtures (markdown STRINGS)                                         */
/* ------------------------------------------------------------------ */

const F_HEADINGS =
  "# Heading one\n## Heading two\n### Heading three\n#### Heading four\n##### Heading five\n###### Heading six";
const F_STYLES =
  "This paragraph has **bold text**, *italic text*, `inline code`, and a plain tail.";
const F_LISTS = [
  "- alpha item",
  "- beta item",
  "  1. nested one",
  "  2. nested two",
  "- gamma item",
  "",
  "1. first ordered",
  "   - dash child",
  "2. second ordered",
  "3. third ordered",
].join("\n");
const F_CODE = [
  "```ts",
  "const a = 1;",
  "",
  "function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "```",
].join("\n");
const F_QUOTE =
  "> Quoted first line.\n> Quoted second line with more words.\n>\n> - quoted list item";
const F_RULE = "Above the rule.\n\n---\n\nBelow the rule.";
const F_LINK =
  "See the [DocoPDF page](https://example.com/doco) and the [reference link][ref] for more.\n\n[ref]: https://example.com/reference";
const F_IMAGE =
  "Before image.\n\n![A picture of a cat](https://example.com/cat.png)\n\nAfter image.";
const F_IMGREF = "Unresolved ![absent picture][nope] stays literal.";
const F_HTML =
  '<div class="raw">\n  <span>ignored block html</span>\n</div>\n\nParagraph after html.';
const F_SOFT = "first soft line\nsecond soft line";
const F_HARD = "hard one  \nhard two";
const F_DEVA =
  "## हिंदी शीर्षक\n\nयह एक हिंदी पैराग्राफ़ है। इसमें दंड (।) भी है और कुछ लंबी पंक्तियाँ भी होंगी ताकि रैपिंग दिखे। मिश्रित text भी आ सकता है।";

const COMBINED = [
  F_HEADINGS,
  F_STYLES,
  F_LISTS,
  F_CODE,
  F_QUOTE,
  F_RULE,
  F_LINK,
  F_IMAGE,
  F_IMGREF,
  F_HTML,
  F_SOFT,
  F_HARD,
  F_DEVA,
].join("\n\n");

const WORDS =
  "document section paragraph markdown layout engine heading list quote code block render page break".split(
    " "
  );

/** ~3 wrapped lines per paragraph (14 words × 3 repetitions). */
function bigDoc(paragraphs: number): string {
  const parts: string[] = ["# Generated document"];
  for (let i = 0; i < paragraphs; i += 1) {
    if (i > 0 && i % 12 === 0) parts.push(`## Section ${i}`);
    const words: string[] = [];
    for (let j = 0; j < 14; j += 1) {
      words.push(WORDS[(i * 7 + j * 5) % WORDS.length]);
    }
    const sentence = words.join(" ");
    parts.push(`${sentence} ${sentence} ${sentence}`);
  }
  return parts.join("\n\n");
}

/** ~3 wrapped lines per paragraph — used to sweep page-boundary alignments. */
function sweepPara(i: number): string {
  const words: string[] = [];
  for (let j = 0; j < 10; j += 1) {
    words.push(WORDS[(i * 3 + j * 7) % WORDS.length]);
  }
  const sentence = words.join(" ");
  return `${sentence} ${sentence} ${sentence}`;
}

function sweepBody(count: number): string {
  return Array.from({ length: count }, (_, i) => sweepPara(i)).join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 1. parseMarkdown — the document model                                */
/* ------------------------------------------------------------------ */

console.log("parseMarkdown (model)");
const headingsParsed = parseMarkdown(F_HEADINGS, fromMarkdown);
check(
  "headings h1-h6 parse with levels 1..6 and text",
  headingsParsed.blocks.length === 6 &&
    headingsParsed.blocks.every(
      (block, i) =>
        block.kind === "heading" &&
        block.level === i + 1 &&
        block.runs.map((run) => run.text).join("") === `Heading ${["one", "two", "three", "four", "five", "six"][i]}`
    )
);

const stylesParsed = parseMarkdown(F_STYLES, fromMarkdown);
const stylesRuns =
  stylesParsed.blocks.length === 1 && stylesParsed.blocks[0].kind === "paragraph"
    ? stylesParsed.blocks[0].runs
    : [];
const findRun = (pred: (run: typeof stylesRuns[number]) => boolean): string =>
  stylesRuns.find(pred)?.text ?? "";
check(
  "bold / italic / inline code runs carry the right flags",
  findRun((run) => run.bold) === "bold text" &&
    findRun((run) => run.italic) === "italic text" &&
    findRun((run) => run.code) === "inline code"
);

const listsParsed = parseMarkdown(F_LISTS, fromMarkdown);
const listItems = listsParsed.blocks.filter((block) => block.kind === "listItem");
check(
  "ordered + unordered lists with nesting (depths, numbers)",
  listItems.length === 9 &&
    listItems.filter((block) => block.kind === "listItem" && !block.ordered)
      .length === 4 &&
    listsParsed.blocks.some(
      (block) =>
        block.kind === "listItem" && block.depth === 1 && block.ordered && block.number === 1
    ) &&
    listsParsed.blocks.some(
      (block) => block.kind === "listItem" && block.depth === 1 && !block.ordered
    )
);

const codeParsed = parseMarkdown(F_CODE, fromMarkdown);
const codeBlock = codeParsed.blocks.find((block) => block.kind === "code");
check(
  "code block keeps its lines (interior blank kept, trailing phantom dropped)",
  codeBlock !== undefined &&
    codeBlock.kind === "code" &&
    codeBlock.lines.length === 5 &&
    codeBlock.lines[1] === "" &&
    codeBlock.lines[3] === "  return `Hello, ${name}!`;"
);

const quoteParsed = parseMarkdown(F_QUOTE, fromMarkdown);
const quoteBlock = quoteParsed.blocks.find((block) => block.kind === "quote");
check(
  "blockquote wraps its children (paragraph + list item)",
  quoteBlock !== undefined &&
    quoteBlock.kind === "quote" &&
    quoteBlock.children.length === 2 &&
    quoteBlock.children.some(
      (child) => child.kind === "listItem" && child.runs.map((r) => r.text).join("").includes("quoted list item")
    )
);

const ruleParsed = parseMarkdown(F_RULE, fromMarkdown);
check(
  "thematicBreak becomes a rule block between paragraphs",
  ruleParsed.blocks.length === 3 &&
    ruleParsed.blocks[0].kind === "paragraph" &&
    ruleParsed.blocks[1].kind === "rule" &&
    ruleParsed.blocks[2].kind === "paragraph"
);

const linkParsed = parseMarkdown(F_LINK, fromMarkdown);
const linkRuns =
  linkParsed.blocks[0].kind === "paragraph" ? linkParsed.blocks[0].runs : [];
check(
  "links collect as numbered footnotes (+ reference links resolve)",
  linkParsed.links.length === 2 &&
    linkParsed.links[0] === "https://example.com/doco" &&
    linkParsed.links[1] === "https://example.com/reference" &&
    linkRuns.some((run) => run.link && run.text === "DocoPDF page") &&
    linkRuns.some((run) => run.link && run.sup && run.text === " [1]")
);

const imageParsed = parseMarkdown(F_IMAGE, fromMarkdown);
const imageRuns = imageParsed.blocks
  .filter((block) => block.kind === "paragraph")
  .flatMap((block) => (block.kind === "paragraph" ? block.runs : []));
check(
  "image renders its alt text honestly, no URL collected",
  imageRuns.some((run) => run.text === "[A picture of a cat]" && run.italic) &&
    imageParsed.links.length === 0
);

const imgRefParsed = parseMarkdown(F_IMGREF, fromMarkdown);
const imgRefRuns = imgRefParsed.blocks
  .filter((block) => block.kind === "paragraph")
  .flatMap((block) => (block.kind === "paragraph" ? block.runs : []));
check(
  "unresolved image reference stays literal (raw markdown shows through)",
  imgRefRuns.some((run) => run.text.includes("![absent picture][nope]")) &&
    imgRefParsed.links.length === 0
);

const htmlParsed = parseMarkdown(F_HTML, fromMarkdown);
const htmlJoined = htmlParsed.blocks
  .map((block) =>
    block.kind === "paragraph" || block.kind === "heading" || block.kind === "listItem"
      ? block.runs.map((run) => run.text).join("")
      : ""
  )
  .join("");
check(
  "raw html blocks are skipped (no text leaks)",
  !htmlJoined.includes("<div") &&
    !htmlJoined.includes("ignored block html") &&
    htmlParsed.blocks.length === 1
);

const hardParsed = parseMarkdown(F_HARD, fromMarkdown);
const hardRuns =
  hardParsed.blocks.length === 1 && hardParsed.blocks[0].kind === "paragraph"
    ? hardParsed.blocks[0].runs
    : [];
check(
  "hard break survives as its own \"\\n\" run",
  hardRuns.some((run) => run.text === "\n")
);

/* ------------------------------------------------------------------ */
/* 2. resolveMdOptions                                                */
/* ------------------------------------------------------------------ */

console.log("options");
const mdDefaults = resolveMdOptions({});
check(
  "defaults: a4 / 20mm / body 11 / mono 9 / clean",
  mdDefaults.pageSize === "a4" &&
    mdDefaults.margin === 20 &&
    mdDefaults.bodySize === 11 &&
    mdDefaults.monoSize === 9 &&
    mdDefaults.theme === "clean"
);
const mdCoerced = resolveMdOptions({
  pageSize: "letter",
  margin: "35",
  bodySize: "12",
  monoSize: "10",
  theme: "warm",
});
const mdClamped = resolveMdOptions({ margin: 99, bodySize: "13" });
check(
  "select values coerce (strings → numbers) and clamps apply",
  mdCoerced.pageSize === "letter" &&
    mdCoerced.margin === 35 &&
    mdCoerced.bodySize === 12 &&
    mdCoerced.monoSize === 10 &&
    mdCoerced.theme === "warm" &&
    mdClamped.margin === 40 &&
    mdClamped.bodySize === 11
);

/* ------------------------------------------------------------------ */
/* 3. layoutMd geometry (COMBINED fixture, real fonts)                */
/* ------------------------------------------------------------------ */

console.log("layoutMd geometry");
const optsA4 = resolveMdOptions({});
const combinedParsed: ParsedMarkdown = parseMarkdown(COMBINED, fromMarkdown);
const combined: MdLayoutResult = layoutMd(combinedParsed, optsA4, measure);

const A4 = PAGE_SIZES.a4;
const MARGIN = optsA4.margin * MM_TO_PT;
const RIGHT = MARGIN + (A4.width - 2 * MARGIN);
const allRuns: PositionedTextRun[] = combined.pages.flatMap((page) => page.runs);

check(
  `every run fits the content box horizontally (${allRuns.length} runs re-measured)`,
  allRuns.every(
    (run) =>
      run.x >= MARGIN - 0.75 &&
      run.x + runWidth(run) <= RIGHT + 0.75
  )
);
check(
  "every baseline sits inside the vertical content area",
  allRuns.every(
    (run) =>
      run.baseline >= MARGIN - 0.5 - run.size &&
      run.baseline <= A4.height - MARGIN + 0.5
  )
);

const h1Run = allRuns.find((run) => run.text === "Heading one");
const h6Run = allRuns.find((run) => run.text === "Heading six");
check(
  "h1 is 22pt bold; h6 is italic",
  h1Run !== undefined &&
    h1Run.size === 22 &&
    h1Run.spec.bold &&
    h6Run !== undefined &&
    h6Run.spec.italic
);

const inlineCodeRun = allRuns.find((run) => run.text === "inline code");
check(
  "inline code uses the mono family at body size",
  inlineCodeRun !== undefined &&
    inlineCodeRun.spec.family === "mono" &&
    Math.abs(inlineCodeRun.size - optsA4.bodySize) < 0.01
);

const codeRuns = allRuns.filter((run) => run.spec.family === "mono" && run.size === optsA4.monoSize);
const codeLineConst = codeRuns.find((run) => run.text.startsWith("const a"));
const codeLineReturn = codeRuns.find((run) => run.text.includes("return"));
check(
  "code block lines keep their indentation (x offsets differ)",
  codeLineConst !== undefined &&
    codeLineReturn !== undefined &&
    codeLineReturn.x > codeLineConst.x + 4
);

const bulletRuns = allRuns.filter((run) => run.text === "•");
const dashRuns = allRuns.filter((run) => run.text === "–");
const oneRuns = allRuns.filter((run) => run.text === "1.");
check(
  "list markers render: bullets, nested dash, numbers (nested indents deeper)",
  bulletRuns.length === 4 &&
    dashRuns.length === 1 &&
    oneRuns.length === 2 &&
    Math.abs(oneRuns[0].x - oneRuns[1].x) > 10
);

const codeBg = combined.pages.flatMap((page) => page.rects).filter((rect) => rect.kind === "codeBg");
check(
  "code block paints a background rect inside the page",
  codeBg.length >= 1 &&
    codeBg.every(
      (rect) =>
        rect.x >= MARGIN - 1 &&
        rect.x + rect.w <= RIGHT + 1 &&
        rect.y >= 0 &&
        rect.y + rect.h <= A4.height
    )
);

const quoteRuns = allRuns.filter((run) => run.text.startsWith("Quoted"));
const quoteBars = combined.pages.flatMap((page) => page.rects).filter((rect) => rect.kind === "quoteBar");
check(
  "blockquote: muted runs + a bar rect on the same page",
  quoteRuns.length >= 1 &&
    quoteRuns.every((run) => run.color === "muted") &&
    quoteBars.length >= 1 &&
    combined.pages.some(
      (page) =>
        page.runs.some((run) => run.text.startsWith("Quoted")) &&
        page.rects.some((rect) => rect.kind === "quoteBar")
    )
);

const rules = combined.pages.flatMap((page) => page.rects).filter((rect) => rect.kind === "rule");
check(
  "thematicBreak paints a full-width rule",
  rules.length === 1 && Math.abs(rules[0].w - (A4.width - 2 * MARGIN)) < 1
);

const linkRunsLayout = allRuns.filter((run) => run.color === "link");
check(
  "link text renders blue with a raised [n] marker",
  linkRunsLayout.some((run) => run.text === "DocoPDF page") &&
    allRuns.some((run) => run.sup === true && run.text === " [1]")
);

const linksHeadingRun = allRuns.find((run) => run.text === "Links");
const numberedLinkLine = allRuns.find(
  (run) => run.text.startsWith("1. ") || run.text === "1. "
);
check(
  "Links section: bold heading + numbered URL lines at the end",
  linksHeadingRun !== undefined &&
    linksHeadingRun.spec.bold &&
    numberedLinkLine !== undefined &&
    combined.linkCount === 2
);

const softRun = allRuns.find((run) => run.text.includes("first soft line"));
check(
  "soft line break joins with a space (never glues words)",
  softRun !== undefined && softRun.text.includes("first soft line second soft line")
);

const softBaselines = allRuns.filter((run) => run.text.startsWith("hard "));
check(
  "hard break forces two separate lines",
  softBaselines.length === 2 && softBaselines[0].baseline !== softBaselines[1].baseline
);

const devaRuns = allRuns.filter((run) => /[\u0900-\u097f]/.test(run.text));
check(
  "Devanagari heading + paragraph run through the embedded font (noto)",
  devaRuns.length >= 2 &&
    devaRuns.every(
      (run) => run.script === "noto" && run.x + runWidth(run) <= RIGHT + 0.75
    )
);

/* ------------------------------------------------------------------ */
/* 4. Pagination                                                        */
/* ------------------------------------------------------------------ */

console.log("pagination");
const HEAD_TEXTS = [
  "Heading one",
  "Heading two",
  "Heading three",
  "Heading four",
  "Heading five",
  "Heading six",
  "हिंदी शीर्षक",
  "Links",
  "Section 12",
];
function headingsNeverLast(result: MdLayoutResult): string | null {
  for (let p = 0; p < result.pages.length; p += 1) {
    const page = result.pages[p];
    for (const run of page.runs) {
      if (!run.spec.bold || run.spec.family !== "sans") continue;
      if (!HEAD_TEXTS.some((t) => run.text === t)) continue;
      const below = page.runs.find(
        (other) => other !== run && other.baseline < run.baseline - 2
      );
      if (!below) {
        return `"${run.text}" is the last line of page ${p + 1}`;
      }
    }
  }
  return null;
}
const bigParsed = parseMarkdown(bigDoc(100), fromMarkdown);
const big = layoutMd(bigParsed, optsA4, measure);
const biggerParsed = parseMarkdown(bigDoc(160), fromMarkdown);
const bigger = layoutMd(biggerParsed, optsA4, measure);
check(
  "300+ line document spans multiple pages, count grows, no empty trailing page",
  big.pages.length >= 3 &&
    bigger.pages.length > big.pages.length &&
    big.pages[big.pages.length - 1].runs.length > 0 &&
    bigger.pages[bigger.pages.length - 1].runs.length > 0
);
const combinedStranded = headingsNeverLast(combined);
check(
  "no heading is ever the last line of its page (combined + big docs)",
  combinedStranded === null && headingsNeverLast(big) === null,
  combinedStranded ?? ""
);

let codeSweeps = 0;
let codeSweptPages = 0;
let codeSplit: string | null = null;
for (let k = 8; k <= 80; k += 2) {
  const doc = `${sweepBody(k)}\n\n\`\`\`js\nlet x = 1;\nlet y = 2;\n\`\`\`\n\nAfter the block.`;
  const result = layoutMd(parseMarkdown(doc, fromMarkdown), optsA4, measure);
  const mono = result.pages
    .flatMap((page, index) => page.runs.map((run) => ({ run, index })))
    .filter((entry) => entry.run.spec.family === "mono");
  codeSweeps += 1;
  codeSweptPages = Math.max(codeSweptPages, result.pages.length);
  if (mono.length < 2 || new Set(mono.map((entry) => entry.index)).size !== 1) {
    codeSplit = `k=${k} split a 2-line code block`;
    break;
  }
}
check(
  `≤3-line code blocks never split across pages (${codeSweeps} boundary alignments swept)`,
  codeSplit === null && codeSweptPages >= 2,
  codeSplit ?? ""
);

let headingSweeps = 0;
let headingSweptPages = 0;
let headingStranded: string | null = null;
for (let k = 8; k <= 80; k += 2) {
  const doc = `${sweepBody(k)}\n\n## Tail heading\n\nTail paragraph body text here.`;
  const result = layoutMd(parseMarkdown(doc, fromMarkdown), optsA4, measure);
  const tail = result.pages
    .flatMap((page, index) => page.runs.map((run) => ({ run, index })))
    .find((entry) => entry.run.text === "Tail heading");
  headingSweeps += 1;
  headingSweptPages = Math.max(headingSweptPages, result.pages.length);
  if (!tail) {
    headingStranded = `k=${k} lost the heading`;
    break;
  }
  const page = result.pages[tail.index];
  const below = page.runs.find(
    (other) => other.text !== "Tail heading" && other.baseline < tail.run.baseline - 2
  );
  if (!below) {
    headingStranded = `k=${k} stranded the heading at a page bottom`;
    break;
  }
}
check(
  `headings keep with the next block at every boundary (${headingSweeps} alignments swept)`,
  headingStranded === null && headingSweptPages >= 2,
  headingStranded ?? ""
);

const warmOpts = resolveMdOptions({ theme: "warm" });
const warm = layoutMd(parseMarkdown(F_STYLES, fromMarkdown), warmOpts, measure);
check(
  "warm theme flags every page (clean flags none)",
  warm.pages.every((page) => page.warm) && combined.pages.every((page) => !page.warm)
);

/* ------------------------------------------------------------------ */
/* 5. Worker draw recipe → save → reload                               */
/* ------------------------------------------------------------------ */

console.log("render + reload (worker recipe)");
const COLORS = {
  text: rgb(0.1, 0.1, 0.12),
  muted: rgb(0.45, 0.45, 0.5),
  link: rgb(0.145, 0.388, 0.922),
  codeBgClean: rgb(0.92, 0.92, 0.92),
  codeBgWarm: rgb(0.945, 0.925, 0.88),
  quoteBar: rgb(0.72, 0.72, 0.76),
  rule: rgb(0.8, 0.8, 0.84),
  warmPage: rgb(1, 0.984, 0.949),
};

async function renderAndReload(
  name: string,
  mdOptions: MdOptions,
  outPath: string
): Promise<void> {
  const doc = await PDFDocument.create();
  const fonts = await makeFontSet(doc);
  const docMeasure: MeasureRun = (text, spec, size, script) =>
    fontFor(fonts, spec, script).widthOfTextAtSize(text, size);
  const parsed = parseMarkdown(COMBINED, fromMarkdown);
  const result = layoutMd(parsed, mdOptions, docMeasure);
  const size = PAGE_SIZES[mdOptions.pageSize];
  for (const draw of result.pages) {
    const page = doc.addPage([size.width, size.height]);
    if (draw.warm) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        color: COLORS.warmPage,
      });
    }
    for (const rect of draw.rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color:
          rect.kind === "codeBg"
            ? mdOptions.theme === "warm"
              ? COLORS.codeBgWarm
              : COLORS.codeBgClean
            : rect.kind === "quoteBar"
              ? COLORS.quoteBar
              : COLORS.rule,
      });
    }
    for (const run of draw.runs) {
      if (run.text.length === 0) continue;
      page.drawText(run.text, {
        x: run.x,
        y: run.baseline,
        size: run.size,
        font: fontFor(fonts, run.spec, run.script),
        color:
          run.color === "link"
            ? COLORS.link
            : run.color === "muted"
              ? COLORS.muted
              : COLORS.text,
      });
    }
  }
  const saved = await doc.save({ useObjectStreams: false });
  await writeFile(outPath, saved);
  const reloaded = await PDFDocument.load(await readFile(outPath), {
    updateMetadata: false,
  });
  const reloadedSize = reloaded.getPage(0).getSize();
  check(
    `${name}: reload keeps the page count (${result.pages.length})`,
    reloaded.getPageCount() === result.pages.length
  );
  check(
    `${name}: reload page size matches ${mdOptions.pageSize}`,
    Math.abs(reloadedSize.width - size.width) < 0.05 &&
      Math.abs(reloadedSize.height - size.height) < 0.05
  );
}

await renderAndReload(
  "warm a4",
  resolveMdOptions({ theme: "warm" }),
  "/home/z/my-project/download/qa-p41-md-warm.pdf"
);
await renderAndReload(
  "clean letter",
  resolveMdOptions({ pageSize: "letter" }),
  "/home/z/my-project/download/qa-p41-md-letter.pdf"
);

console.log(`\nsmoke-md2pdf: ${passed} passed, ${failed} failed${failed === 0 ? " — ALL GREEN" : ""}`);
if (failed > 0) process.exit(1);
