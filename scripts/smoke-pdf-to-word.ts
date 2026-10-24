/**
 * PRE-BUILD smoke test for PDF → Word (RB1-b, the 68th tool — rebuilt).
 * Locks the pure model AND the real pdf.js path before browser QA:
 *
 *  1. MODEL (pure, headless):
 *     xmlEscape + sanitizeRunText vectors, y-proximity line grouping,
 *     gap→space insertion, paragraph breaks (gap + size-change),
 *     dehyphenation, heading tiers (largest = H1, next = H2, switch
 *     off = plain), bold from fontName + boldMap override, run char
 *     clamp, paragraph clamp, control-char hygiene, garbage items.
 *  2. REAL FIXTURE (pdf-lib + pdf.js legacy, in-process):
 *     a 2-page PDF is built for real — 22 pt bold title, 11 pt body,
 *     a mid-line BOLD run, an XML-hostile line (& < > " '), and a
 *     Hindi line "प्रिया शर्मा" with the self-hosted Noto subset —
 *     then extracted through pdf.js getTextContent, bold-enriched by
 *     the worker's own buildFontBoldMap (Tf-order correlation), run
 *     through extractTextBlocks + buildDocx, and the OUTPUT docx is
 *     unzipped (fflate unzipSync) and asserted: valid zip, all 7 parts,
 *     [Content_Types].xml declares wordprocessingml, document.xml
 *     parses (own tokenizer) and contains the extracted strings
 *     XML-escaped, w:b for the bold run, exactly one w:br type="page"
 *     for 2 pages, w:pStyle Heading1/Heading2, Hindi round-trip.
 *  3. parseRun tamper vectors: garbage JSON, wrong types, clamps.
 *  4. §10 TABLE RECONSTRUCTION: column-cluster unit vectors, 3×4 table
 *     → exact cells, two tables split by a paragraph, honest fallbacks
 *     (single columnar line / mismatched counts / paragraph-gap break),
 *     real OOXML w:tbl + tblGrid + borders + escaping in buildDocx,
 *     page-break-before-table, ZERO-REGRESSION byte-identity on the
 *     table-free real fixture, and the EN+HI wiring locks. Also writes
 *     public/qa/audit5-pdf2word-tables.pdf (real pdf-lib table page) and
 *     runs the full pdf.js → model → docx path on it.
 *
 * Run: bun scripts/smoke-pdf-to-word.ts   (exit code = failures)
 */
import "regenerator-runtime/runtime";
import { readFileSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildDocx,
  docxStats,
  extractTextBlocks,
  medianCharWidth,
  parseRun,
  sanitizeRunText,
  splitIntoColumns,
  xmlEscape,
  DOCX_MIME,
  MAX_PARAGRAPHS,
  MAX_RUN_CHARS,
  TABLE_GAP_CHAR_WIDTHS,
  type DocxBlock,
  type DocxRun,
  type PdfTextItemInput,
  type PdfToWordDetail,
} from "../tools/pdf-to-word/model";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ FAIL: ${name}`);
    if (detail !== undefined) {
      console.error(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
  }
}

/** Minimal XML well-formedness: balanced tags, quoted attrs, no raw < in text. */
function xmlWellFormed(xml: string): boolean {
  // The prolog / comments / DOCTYPE are not elements — strip them so
  // the tag scanner only sees real tags (<?xml …?> has an illegal name).
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const tagRe = /<(\/?)([A-Za-z_:][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
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

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Paragraph narrowing for the DocxBlock union (table blocks have no runs). */
function paraRuns(block: DocxBlock | undefined): DocxRun[] {
  return block !== undefined && block.kind === "para" ? block.runs : [];
}

function paraHeading(block: DocxBlock | undefined): 1 | 2 | undefined {
  return block !== undefined && block.kind === "para"
    ? block.headingLevel
    : undefined;
}

/** Synthetic pdf.js item factory for the pure-model section. */
function item(
  str: string,
  x: number,
  y: number,
  size: number,
  opts: { fontName?: string; bold?: boolean; width?: number } = {}
): PdfTextItemInput {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: opts.width ?? str.length * size * 0.5,
    fontName: opts.fontName ?? "F",
    bold: opts.bold,
  };
}

/* ================================================================== */
/* Part 1 — the pure model                                             */
/* ================================================================== */

function part1(): void {
  console.log("1. xmlEscape + sanitizeRunText");

  check(
    "xmlEscape covers & < > \" '",
    xmlEscape(`a & b < c > d "e" 'f'`) ===
      "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;"
  );
  check(
    "xmlEscape keeps Devanagari intact",
    xmlEscape("प्रिया शर्मा") === "प्रिया शर्मा"
  );
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

  /* ---------------- line grouping ---------------- */
  console.log("2. line grouping by y-proximity");
  {
    const model = extractTextBlocks([
      [
        item("Hello", 72, 100, 10, { width: 25 }),
        item("world", 100, 100, 10, { width: 25 }),
        item("next line", 72, 80, 10),
      ],
    ]);
    check("3 pieces → 2 paragraphs (line vs line)", model.blocks.length === 2, model.blocks);
    check(
      "horizontal gap > quarter font becomes a space",
      paraRuns(model.blocks[0])[0]?.text === "Hello world",
      model.blocks[0]
    );
    check(
      "tight same-style pieces merge into one run",
      paraRuns(model.blocks[0]).length === 1
    );
  }
  {
    // Adjacent pieces without a gap join without a space.
    const model = extractTextBlocks([
      [item("Hel", 72, 100, 10, { width: 15 }), item("lo", 87, 100, 10, { width: 10 })],
    ]);
    check(
      "zero gap joins with no space",
      paraRuns(model.blocks[0])[0]?.text === "Hello",
      model.blocks[0]
    );
  }
  {
    // pdf.js split-space items keep the visual space (the trailing-space
    // restore): "Some parts are" + " " + "for the team.".
    const model = extractTextBlocks([
      [
        item("Some parts are", 72, 100, 10, { width: 70 }),
        item(" ", 142, 100, 10, { width: 3 }),
        item("for the team.", 145, 100, 10, { width: 60 }),
      ],
    ]);
    check(
      "whitespace-only pdf.js item preserves the split space",
      paraRuns(model.blocks[0])[0]?.text === "Some parts are for the team.",
      model.blocks[0]
    );
  }

  /* ---------------- paragraphs ---------------- */
  console.log("3. paragraph merging + dehyphenation");
  {
    const model = extractTextBlocks([
      [
        item("first line of text", 72, 100, 10),
        item("second line joins", 72, 88, 10), // gap 12 < 10*1.7
        item("new paragraph", 72, 60, 10), // gap 28 > 17
      ],
    ]);
    check("gap heuristics: 2 paragraphs", model.blocks.length === 2, model.blocks);
    check(
      "joined lines get exactly one space",
      paraRuns(model.blocks[0])
        .map((r) => r.text)
        .join("") === "first line of text second line joins",
      model.blocks[0]
    );
  }
  {
    const model = extractTextBlocks([
      [
        item("this is a long exam-", 72, 100, 10),
        item("ple of hyphenation.", 72, 88, 10),
      ],
    ]);
    check(
      "dehyphenation merges word-",
      model.blocks.length === 1 &&
        paraRuns(model.blocks[0])[0]?.text === "this is a long example of hyphenation.",
      model.blocks[0]
    );
  }
  {
    // Capital after the hyphen keeps it (e-Mail stays e-Mail).
    const model = extractTextBlocks([
      [
        item("send it to e-", 72, 100, 10),
        item("Mail support", 72, 88, 10),
      ],
    ]);
    check(
      "capital after hyphen is not dehyphenated",
      paraRuns(model.blocks[0])
        .map((r) => r.text)
        .join("") === "send it to e- Mail support",
      model.blocks[0]
    );
  }
  {
    const model = extractTextBlocks([
      [item("Big Title", 72, 100, 22), item("body starts here", 72, 88, 11)],
    ]);
    check(
      "font-size change starts a new paragraph even without a gap",
      model.blocks.length === 2,
      model.blocks
    );
  }

  /* ---------------- headings ---------------- */
  console.log("4. heading tiers");
  {
    const page: PdfTextItemInput[] = [
      item("Quarterly Report Title", 72, 720, 22, { fontName: "T-Bold" }),
      item("body text body text body text", 72, 680, 11),
      item("body text body text body text", 72, 666, 11),
      item("Sub Heading Here", 72, 620, 16, { fontName: "T-Bold" }),
      item("more body text follows here", 72, 580, 11),
    ];
    const model = extractTextBlocks([page]);
    check(
      "largest tier → Heading1",
      paraHeading(model.blocks[0]) === 1,
      model.blocks[0]
    );
    check(
      "second tier → Heading2",
      paraHeading(
        model.blocks.find((b) =>
          paraRuns(b).some((r) => r.text === "Sub Heading Here")
        )
      ) === 2
    );
    check(
      "body size stays body",
      paraHeading(
        model.blocks.find((b) =>
          paraRuns(b).some((r) => /body text/.test(r.text))
        )
      ) === undefined
    );
    check("docxStats counts headings", docxStats(model).headings === 2, docxStats(model));

    const flat = extractTextBlocks([page], { headings: false });
    check(
      "headings switch off → all plain paragraphs",
      flat.blocks.every((b) => paraHeading(b) === undefined)
    );
  }
  {
    // A tier needs >= 6 chars — a stray large glyph is not a heading.
    const model = extractTextBlocks([
      [item("¶", 72, 720, 30), item("normal body text here", 72, 680, 11)],
    ]);
    check(
      "tiny heading tier is ignored",
      paraHeading(model.blocks[0]) === undefined && model.blocks.length === 2,
      model.blocks
    );
  }

  /* ---------------- bold ---------------- */
  console.log("5. bold flags");
  {
    const model = extractTextBlocks([
      [
        item("plain words ", 72, 100, 10),
        item("bold words", 130, 100, 10, { fontName: "Helvetica-Bold" }),
      ],
    ]);
    const runs = paraRuns(model.blocks[0]);
    check(
      "fontName 'Helvetica-Bold' marks the run bold",
      runs.some((r) => r.bold && r.text === "bold words"),
      runs
    );
    check(
      "non-bold fontName stays plain",
      runs.some((r) => !r.bold && r.text.trim() === "plain words"),
      runs
    );
  }
  {
    // pdf.js internal ids never contain bold — the worker enrichment
    // (boldMap) is what resolves them in the real path.
    const model = extractTextBlocks(
      [
        [
          item("plain ", 72, 100, 10, { fontName: "g_d0_f3" }),
          item("rich", 95, 100, 10, { fontName: "g_d0_f1" }),
        ],
      ],
      { boldMap: new Map([["g_d0_f1", true]]) }
    );
    const runs = paraRuns(model.blocks[0]);
    check(
      "boldMap enrichment overrides internal ids",
      runs.some((r) => r.text.trim() === "rich" && r.bold) &&
        runs.some((r) => r.text.trim() === "plain" && !r.bold),
      runs
    );
  }

  /* ---------------- clamps + hygiene ---------------- */
  console.log("6. clamps and garbage");
  {
    const model = extractTextBlocks([
      [item("x".repeat(600), 72, 100, 10)],
    ]);
    check(
      "runs clamp at 500 chars",
      (paraRuns(model.blocks[0])[0]?.text.length ?? 0) === MAX_RUN_CHARS
    );
  }
  {
    const pages: PdfTextItemInput[][] = [[]];
    for (let i = 0; i < MAX_PARAGRAPHS + 5; i += 1) {
      pages[0].push(item(`para ${i}`, 72, 1000 - i * 20, 10));
    }
    const model = extractTextBlocks(pages);
    check(
      "paragraphs clamp at 2000",
      model.blocks.length === MAX_PARAGRAPHS,
      model.blocks.length
    );
  }
  {
    const model = extractTextBlocks([
      [
        { str: 123, transform: null, width: "x" },
        null,
        undefined,
        item("sur\u0001vi\u0002ves", 72, 100, 10),
        item("", 200, 100, 10),
      ] as unknown as PdfTextItemInput[],
    ]);
    check(
      "garbage items skipped, control chars stripped",
      model.blocks.length === 1 &&
        paraRuns(model.blocks[0])[0]?.text === "survives",
      model.blocks
    );
  }
  {
    const model = extractTextBlocks([[], [item("page two only", 72, 100, 10)]]);
    check(
      "empty page skipped, pageMarks start at the first real block",
      model.pageMarks.length === 1 && model.pageMarks[0] === 0,
      model.pageMarks
    );
  }

  /* ---------------- docx package (unit level) ---------------- */
  console.log("7. buildDocx package shape");
  {
    const model = extractTextBlocks([
      [
        item("Title & <Things>", 72, 100, 20, { fontName: "X-Bold" }),
        item('She said "ok"', 72, 80, 10),
        item("don't", 72, 68, 10),
      ],
    ]);
    const docx = buildDocx(model, { pageBreaks: false, title: "T & T" });
    check("output is a zip (PK magic)", docx[0] === 0x50 && docx[1] === 0x4b);
    const parts = unzipSync(docx);
    const names = Object.keys(parts);
    check(
      "all 7 parts present",
      names.length === 7 &&
        names.includes("[Content_Types].xml") &&
        names.includes("_rels/.rels") &&
        names.includes("word/document.xml") &&
        names.includes("word/_rels/document.xml.rels") &&
        names.includes("word/styles.xml") &&
        names.includes("docProps/core.xml") &&
        names.includes("docProps/app.xml"),
      names
    );
    const ct = new TextDecoder().decode(parts["[Content_Types].xml"]);
    check(
      "Content_Types declares the wordprocessingml override",
      ct.includes("/word/document.xml") &&
        ct.includes("wordprocessingml.document.main+xml")
    );
    const doc = new TextDecoder().decode(parts["word/document.xml"]);
    check(
      "document.xml is well-formed (own tokenizer)",
      xmlWellFormed(doc)
    );
    check(
      "text runs are XML-escaped",
      doc.includes("Title &amp; &lt;Things&gt;") &&
        doc.includes("She said &quot;ok&quot;") &&
        doc.includes("don&apos;t"),
      doc.slice(0, 400)
    );
    check("Heading1 style applied", doc.includes('<w:pStyle w:val="Heading1"/>'));
    check(
      "w:sz half-points for the 20 pt title",
      /<w:sz w:val="40"\/>/.test(doc)
    );
    check(
      "no page break when the switch is off",
      !doc.includes('w:type="page"')
    );
    const withBreaks = buildDocx(model, { pageBreaks: true, title: "T" });
    const doc2 = new TextDecoder().decode(
      unzipSync(withBreaks)["word/document.xml"]
    );
    check(
      "single-page model emits no break even when on",
      !doc2.includes('w:type="page"')
    );
    const twoPages = extractTextBlocks([
      [item("a", 72, 100, 10)],
      [item("b", 72, 100, 10)],
    ]);
    const doc3 = new TextDecoder().decode(
      unzipSync(buildDocx(twoPages, { pageBreaks: true }))["word/document.xml"]
    );
    check(
      "two pages emit exactly one w:br type=page",
      countOf(doc3, '<w:br w:type="page"/>') === 1
    );
    const core = new TextDecoder().decode(parts["docProps/core.xml"]);
    check("docProps/core carries the escaped title", core.includes("T &amp; T"));
    const styles = new TextDecoder().decode(parts["word/styles.xml"]);
    check(
      "styles.xml defines Heading1 + Heading2",
      styles.includes('w:styleId="Heading1"') &&
        styles.includes('w:styleId="Heading2"')
    );
  }
}

/* ================================================================== */
/* Part 2 — the real fixture through pdf.js + the worker's enrichment   */
/* ================================================================== */

async function part2(): Promise<{
  pages: PdfTextItemInput[][];
  boldMap: Map<string, boolean>;
}> {
  console.log("8. REAL fixture: pdf-lib build → pdf.js extract → docx");

  /* ---- build the 2-page PDF for real ---- */
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const notoBytes = readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  );
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

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
  // One visual line with a mid-line bold run — three separately placed
  // pieces exactly like real mixed-style text.
  const x2 = 72 + helv.widthOfTextAtSize("Some parts are ", 11);
  const x3 = x2 + bold.widthOfTextAtSize("very important", 11);
  page1.drawText("Some parts are ", { x: 72, y: 620, size: 11, font: helv });
  page1.drawText("very important", { x: x2, y: 620, size: 11, font: bold });
  page1.drawText(" for the team.", { x: x3, y: 620, size: 11, font: helv });
  page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", {
    x: 72,
    y: 580,
    size: 11,
    font: helv,
  });
  page1.drawText('She said "ok" and don\'t worry.', {
    x: 72,
    y: 540,
    size: 11,
    font: helv,
  });
  page1.drawText("प्रिया शर्मा", { x: 72, y: 490, size: 14, font: noto });

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Second Page Heading", { x: 72, y: 720, size: 16, font: bold });
  page2.drawText("Body text on page two continues here.", {
    x: 72,
    y: 680,
    size: 11,
    font: helv,
  });

  const fixture = await doc.save();
  const bytes = new Uint8Array(fixture);
  check("fixture built (starts with %PDF)", bytes[0] === 0x25 && fixture.length > 500);

  /* ---- extract through pdf.js (legacy build, in-process) ---- */
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const pages: PdfTextItemInput[][] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    page.cleanup();
    pages.push(content.items as PdfTextItemInput[]);
  }
  await pdf.cleanup();
  await task.destroy();
  check("pdf.js read both pages", pages.length === 2);

  const flat = (pages[0] ?? []).concat(pages[1] ?? []);
  const allText = flat
    .map((i) => (typeof i.str === "string" ? i.str : ""))
    .join("");
  check(
    "raw extraction sees title, body, bold run and Hindi",
    allText.includes("Quarterly Report") &&
      allText.includes("Numbers improved") &&
      allText.includes("very important") &&
      /[ऀ-ॿ]/.test(allText),
    allText.slice(0, 200)
  );

  /* ---- the worker's own bold enrichment (self shim first) ---- */
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
    location: { href: string };
  };
  workerGlobal.postMessage = (): void => undefined;
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  const { buildFontBoldMap } = await import("../tools/pdf-to-word/worker");

  const boldMap = await buildFontBoldMap(bytes, pages);
  const veryImportant = flat.find(
    (i) => typeof i.str === "string" && i.str === "very important"
  );
  const bodyLine = flat.find(
    (i) => typeof i.str === "string" && i.str.startsWith("This report covers")
  );
  check(
    "buildFontBoldMap resolves the bold run's pdf.js id to bold",
    veryImportant !== undefined &&
      boldMap.get(String(veryImportant.fontName)) === true,
    { map: [...boldMap.entries()], veryImportant }
  );
  check(
    "body font stays non-bold",
    bodyLine !== undefined &&
      boldMap.get(String(bodyLine.fontName)) === false
  );

  /* ---- the model on the REAL extracted items ---- */
  const model = extractTextBlocks(pages, { boldMap });
  const stats: PdfToWordDetail = docxStats(model);
  check("8 paragraphs detected", stats.paragraphs === 8, stats);
  check("2 pages detected", stats.pages === 2, stats);
  check("2 headings detected (H1 title + H2 page-2 heading)", stats.headings === 2, stats);
  check("pageMarks point at the right blocks", model.pageMarks[0] === 0 && model.pageMarks[1] === 6, model.pageMarks);
  check(
    "page-2 blocks start with the H2 heading",
    paraHeading(model.blocks[6]) === 2 &&
      paraRuns(model.blocks[6])[0]?.text === "Second Page Heading",
    model.blocks[6]
  );
  check(
    "two-line body merged into one paragraph",
    paraRuns(model.blocks[1])
      .map((r) => r.text)
      .join("") ===
      "This report covers the first quarter of the year. Numbers improved across every region listed.",
    model.blocks[1]
  );
  const mixedRuns = paraRuns(model.blocks[2]);
  check(
    "mixed line keeps three runs: plain, bold, plain",
    mixedRuns.length === 3 &&
      mixedRuns[0]?.text.trim() === "Some parts are" &&
      mixedRuns[1]?.text.trim() === "very important" &&
      mixedRuns[1]?.bold === true &&
      mixedRuns[2]?.text.trim() === "for the team." &&
      mixedRuns[2]?.bold === false,
    mixedRuns
  );
  const hindiBlock = model.blocks[5];
  const hindiRuns = paraRuns(hindiBlock);
  check(
    "Hindi paragraph survives extraction (glyph order accepted)",
    hindiBlock !== undefined &&
      typeof hindiRuns[0]?.text === "string" &&
      (hindiRuns[0].text.includes("प्रिया") ||
        hindiRuns[0].text.includes("िप्रया")) &&
      hindiRuns[0].text.includes("श"),
    hindiBlock
  );
  check(
    "Hindi 14pt line stays body (below the two heading tiers)",
    paraHeading(hindiBlock) === undefined
  );

  /* ---- the docx round-trip ---- */
  const docx = buildDocx(model, {
    pageBreaks: true,
    title: paraRuns(model.blocks[0])[0]?.text ?? "",
  });
  check("docx is a zip", docx[0] === 0x50 && docx[1] === 0x4b);
  const parts = unzipSync(docx);
  check(
    "all 7 parts present in the real output",
    Object.keys(parts).length === 7,
    Object.keys(parts)
  );
  const ct = new TextDecoder().decode(parts["[Content_Types].xml"]);
  check(
    "[Content_Types].xml declares wordprocessingml",
    ct.includes("wordprocessingml.document.main+xml") &&
      ct.includes("/word/document.xml")
  );
  const docXml = new TextDecoder().decode(parts["word/document.xml"]);
  check("document.xml well-formed", xmlWellFormed(docXml));
  check(
    "extracted strings present, XML-escaped",
    docXml.includes("Quarterly Report") &&
      docXml.includes("Numbers improved across every region listed.") &&
      docXml.includes("revenue &amp; costs") &&
      docXml.includes("Q1 &lt; Q2 &gt;") &&
      docXml.includes("&quot;ok&quot;") &&
      docXml.includes("don&apos;t")
  );
  check(
    "w:b present for the bold run",
    /<w:rPr><w:b\/><w:bCs\/><w:sz w:val="22"\/><w:szCs w:val="22"\/><\/w:rPr><w:t xml:space="preserve">very important ?<\/w:t>/.test(
      docXml
    ),
    (docXml.match(/.{0,80}very important/g) ?? []).join(" | ")
  );
  check(
    "exactly one page break for the 2-page doc",
    countOf(docXml, '<w:br w:type="page"/>') === 1
  );
  check(
    "page break sits inside page 2's first paragraph",
    /<w:p><w:pPr><w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:br w:type="page"\/><\/w:r>/.test(
      docXml
    )
  );
  check(
    "Heading1 + Heading2 styles used once each",
    countOf(docXml, '<w:pStyle w:val="Heading1"/>') === 1 &&
      countOf(docXml, '<w:pStyle w:val="Heading2"/>') === 1
  );
  check(
    "Hindi survives the docx round-trip (UTF-8, any glyph order)",
    docXml.includes("िप्रया") || docXml.includes("प्रिया"),
    (docXml.match(/[ऀ-ॿ][ऀ-ॿ\s]*[ऀ-ॿ]/g) ?? []).join(" | ")
  );
  const core = new TextDecoder().decode(parts["docProps/core.xml"]);
  check("docProps title is the extracted H1", core.includes("Quarterly Report"));

  /* ---- options honoured end-to-end ---- */
  const noHeadings = extractTextBlocks(pages, { boldMap, headings: false });
  check(
    "headings off → no pStyle in model output",
    noHeadings.blocks.every((b) => paraHeading(b) === undefined)
  );
  const noBreaks = new TextDecoder().decode(
    unzipSync(buildDocx(model, { pageBreaks: false }))["word/document.xml"]
  );
  check(
    "page breaks off → no w:br in the docx",
    !noBreaks.includes('w:type="page"')
  );
  return { pages, boldMap };
}

/* ================================================================== */
/* Part 3 — parseRun tamper vectors                                    */
/* ================================================================== */

function part3(): void {
  console.log("9. parseRun tamper vectors");

  const defaults = parseRun("{not json at all");
  check(
    "garbage JSON → honest defaults",
    defaults.headings === true &&
      defaults.pageBreaks === true &&
      defaults.locale === "en" &&
      defaults.fileWord === "",
    defaults
  );
  check("parseRun(JSON null) → defaults", parseRun("null").headings === true);
  check("parseRun(a number) → defaults", parseRun("42").pageBreaks === true);

  const full = parseRun(
    JSON.stringify({
      headings: false,
      pageBreaks: false,
      locale: "hi",
      fileWord: "दस्तावेज़",
    })
  );
  check(
    "every field honoured",
    full.headings === false &&
      full.pageBreaks === false &&
      full.locale === "hi" &&
      full.fileWord === "दस्तावेज़"
  );

  check(
    'headings "no" (string) is NOT false — stays on',
    parseRun('{"headings":"no"}').headings === true
  );
  check(
    "numbers are not false — stays on",
    parseRun('{"headings":0,"pageBreaks":0}').pageBreaks === true
  );
  check(
    'locale "fr" falls back to "en"',
    parseRun('{"locale":"fr"}').locale === "en"
  );
  check(
    "fileWord clamped to 60 chars",
    parseRun(JSON.stringify({ fileWord: "x".repeat(90) })).fileWord.length === 60
  );
  check(
    "fileWord control chars sanitized",
    parseRun(JSON.stringify({ fileWord: "a\u0001b\u0002" })).fileWord === "ab"
  );
  check(
    "non-string fileWord → empty",
    parseRun('{"fileWord":123}').fileWord === ""
  );
}

/* ================================================================== */
/* Part 4 — §10 table reconstruction                                   */
/* ================================================================== */

/** One synthetic table row: one pdf.js item per cell at fixed column x. */
function rowItems(
  row: readonly string[],
  xs: readonly number[],
  y: number,
  size: number
): PdfTextItemInput[] {
  const items: PdfTextItemInput[] = [];
  for (let i = 0; i < row.length; i += 1) {
    items.push(item(row[i] ?? "", xs[i] ?? 72, y, size));
  }
  return items;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function part4(real: {
  pages: PdfTextItemInput[][];
  boldMap: Map<string, boolean>;
}): Promise<void> {
  console.log("10. table reconstruction");

  /* ---- unit vectors: the column detector itself ---- */
  console.log("10a. column clustering units");
  check(
    "medianCharWidth = median of width/trimmed-chars",
    medianCharWidth(
      [
        { text: "abcde", x: 0, w: 30 },
        { text: "abcdefgh", x: 0, w: 40 },
        { text: "abc", x: 0, w: 21 },
      ],
      5
    ) === 6
  );
  check(
    "medianCharWidth averages the middle pair on even counts",
    medianCharWidth(
      [
        { text: "abcde", x: 0, w: 30 },
        { text: "abcdefgh", x: 0, w: 40 },
        { text: "abc", x: 0, w: 21 },
        { text: "ab", x: 0, w: 16 },
      ],
      5
    ) === 6.5
  );
  check("medianCharWidth falls back when no widths", medianCharWidth([], 4.2) === 4.2);
  {
    const clusters = splitIntoColumns(
      [
        { text: "Region", x: 72, w: 33 },
        { text: "Q1", x: 200, w: 11 },
        { text: "Change", x: 440, w: 34 },
      ],
      11
    );
    check(
      "clean gaps split 3 columns",
      clusters !== null && clusters.length === 3
    );
  }
  check(
    "tight gap (< 1.5 × median char width) stays one line",
    splitIntoColumns(
      [
        { text: "Hello", x: 72, w: 25 },
        { text: "world", x: 100, w: 25 },
      ],
      10
    ) === null
  );
  check(
    "whitespace-only pieces never count as a column",
    splitIntoColumns(
      [
        { text: "Region", x: 72, w: 33 },
        { text: " ", x: 200, w: 3 },
        { text: "95", x: 210, w: 11 },
      ],
      11
    ) !== null &&
      splitIntoColumns(
        [
          { text: "Region", x: 72, w: 33 },
          { text: " ", x: 200, w: 3 },
          { text: "95", x: 210, w: 11 },
        ],
        11
      )?.length === 2
  );
  check(
    "a whitespace-only line is not columnar",
    splitIntoColumns(
      [
        { text: " ", x: 72, w: 3 },
        { text: " ", x: 200, w: 3 },
      ],
      11
    ) === null
  );

  /* ---- (a) synthetic 3×4 table with clean column gaps ---- */
  console.log("10b. 3×4 synthetic table");
  const tableA: string[][] = [
    ["Region", "Q1", "Q2", "Change"],
    ["North", "120", "135", "+12.5%"],
    ["South", "95", "88", "-7.4%"],
  ];
  const xsA = [72, 200, 320, 440];
  const pageA: PdfTextItemInput[] = [
    ...rowItems(tableA[0] ?? [], xsA, 500, 11),
    ...rowItems(tableA[1] ?? [], xsA, 484, 11),
    ...rowItems(tableA[2] ?? [], xsA, 468, 11),
  ];
  const modelA = extractTextBlocks([pageA]);
  check(
    "(a) 3 matching columnar rows → exactly 1 table block",
    modelA.blocks.length === 1 && modelA.blocks[0]?.kind === "table",
    modelA.blocks
  );
  check(
    "(a) exact cell texts in reading order",
    modelA.blocks[0]?.kind === "table" &&
      JSON.stringify(modelA.blocks[0].rows) === JSON.stringify(tableA),
    modelA.blocks[0]
  );
  check(
    "(a) docxStats: 1 table, 0 paragraphs",
    docxStats(modelA).tables === 1 && docxStats(modelA).paragraphs === 0,
    docxStats(modelA)
  );
  {
    const off = extractTextBlocks([pageA], { tables: false });
    check(
      "(a) tables switch off → honest paragraph fallback, no table",
      docxStats(off).tables === 0 && off.blocks.every((b) => b.kind === "para"),
      off.blocks
    );
  }

  /* ---- (b) two tables separated by a paragraph line ---- */
  console.log("10c. two tables split by a paragraph");
  const tableB: string[][] = [
    ["Item", "Qty"],
    ["Pens", "12"],
  ];
  const tableC: string[][] = [
    ["A", "B", "C"],
    ["1", "2", "3"],
    ["4", "5", "6"],
  ];
  const pageB: PdfTextItemInput[] = [
    ...rowItems(tableB[0] ?? [], [72, 200], 500, 11),
    ...rowItems(tableB[1] ?? [], [72, 200], 484, 11),
    item("a plain sentence sits between the two tables", 72, 468, 11),
    ...rowItems(tableC[0] ?? [], [72, 200, 320], 452, 11),
    ...rowItems(tableC[1] ?? [], [72, 200, 320], 436, 11),
    ...rowItems(tableC[2] ?? [], [72, 200, 320], 420, 11),
  ];
  const modelB = extractTextBlocks([pageB]);
  check(
    "(b) blocks: table, para, table (order preserved)",
    modelB.blocks.length === 3 &&
      modelB.blocks[0]?.kind === "table" &&
      modelB.blocks[1]?.kind === "para" &&
      modelB.blocks[2]?.kind === "table",
    modelB.blocks
  );
  check(
    "(b) table 1 = 2×2, table 2 = 3×3 with exact cells",
    modelB.blocks[0]?.kind === "table" &&
      modelB.blocks[2]?.kind === "table" &&
      JSON.stringify(modelB.blocks[0].rows) === JSON.stringify(tableB) &&
      JSON.stringify(modelB.blocks[2].rows) === JSON.stringify(tableC),
    modelB.blocks
  );
  check(
    "(b) separator paragraph text survives between them",
    modelB.blocks[1]?.kind === "para" &&
      paraRuns(modelB.blocks[1])
        .map((r) => r.text)
        .join("") ===
        "a plain sentence sits between the two tables",
    modelB.blocks[1]
  );
  check("(b) docxStats tables=2", docxStats(modelB).tables === 2, docxStats(modelB));

  /* ---- honest fallbacks ---- */
  console.log("10d. honest fallbacks");
  {
    // (c) a single columnar line is never a table.
    const model = extractTextBlocks([
      [...rowItems(["Name", "Age", "City"], [72, 200, 320], 500, 11)],
    ]);
    check(
      "(c) single columnar line → paragraph fallback (no table)",
      model.blocks.length === 1 &&
        model.blocks[0]?.kind === "para" &&
        docxStats(model).tables === 0,
      model.blocks
    );
    check(
      "(c) the line keeps its gap-spaces as text",
      paraRuns(model.blocks[0])
        .map((r) => r.text)
        .join("") === "Name Age City",
      model.blocks[0]
    );
  }
  {
    // (d) cluster counts 2 then 3 — no fabricated merge, no table.
    const model = extractTextBlocks([
      [
        ...rowItems(["Code", "42"], [72, 200], 500, 11),
        ...rowItems(["A", "B", "C"], [72, 200, 320], 484, 11),
      ],
    ]);
    check(
      "(d) mismatched cluster counts → 0 tables",
      docxStats(model).tables === 0 && model.blocks.every((b) => b.kind === "para"),
      model.blocks
    );
    check(
      "(d) both lines stay in the paragraph flow",
      model.blocks.length === 1 &&
        paraRuns(model.blocks[0])
          .map((r) => r.text)
          .join("") === "Code 42 A B C",
      model.blocks[0]
    );
  }
  {
    // Extra honesty: a paragraph-sized vertical gap never glues rows.
    const model = extractTextBlocks([
      [
        ...rowItems(["North", "120"], [72, 200], 500, 11),
        ...rowItems(["South", "95"], [72, 200], 460, 11), // gap 40 > 11*1.7
      ],
    ]);
    check(
      "paragraph-gap break → no table across a vertical gap",
      docxStats(model).tables === 0 && model.blocks.every((b) => b.kind === "para"),
      model.blocks
    );
  }

  /* ---- (e) buildDocx emits real OOXML ---- */
  console.log("10e. OOXML table output");
  const docx = buildDocx(modelA, { pageBreaks: false, title: "T" });
  check("(e) output is a zip", docx[0] === 0x50 && docx[1] === 0x4b);
  const parts = unzipSync(docx);
  check(
    "(e) all 7 parts still present",
    Object.keys(parts).length === 7,
    Object.keys(parts)
  );
  const xml = new TextDecoder().decode(parts["word/document.xml"]);
  check("(e) document.xml well-formed with a table", xmlWellFormed(xml) && xml.includes("<w:tbl>"));
  check("(e) tblGrid has exactly one gridCol per column (4)", countOf(xml, "<w:gridCol") === 4);
  check(
    "(e) 3 rows / 12 cells",
    countOf(xml, "<w:tr>") === 3 && countOf(xml, "<w:tc>") === 12
  );
  check(
    "(e) tblW = 5000 pct (100% width)",
    xml.includes('<w:tblW w:w="5000" w:type="pct"/>')
  );
  check("(e) every cell carries tcBorders", countOf(xml, "<w:tcBorders>") === 12);
  check(
    "(e) thin single borders on the table frame + every cell edge",
    countOf(xml, 'w:val="single" w:sz="4"') === 6 + 12 * 4
  );
  {
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) =>
      Number(m[1])
    );
    check(
      "(e) grid columns split the 9638-twip content width",
      widths.length === 4 &&
        widths.reduce((a, b) => a + b, 0) === 9638 &&
        widths.every((w) => w === 2409 || w === 2410),
      widths
    );
  }
  check(
    "(e) all 12 exact cell texts present",
    tableA.every((row) => row.every((cell) => xml.includes(`>${cell}</w:t>`)))
  );
  check(
    "(e) anchor paragraph after the table (never merges two tables)",
    countOf(xml, "</w:tbl><w:p/>") === 1
  );
  check("(e) 10 pt cell runs", countOf(xml, '<w:sz w:val="20"/>') === 12);
  {
    // Cell text goes through xmlEscape like every other run.
    const escModel = extractTextBlocks([
      [
        ...rowItems(["R&D", "A&B"], [72, 200], 500, 11),
        ...rowItems(["x<y", "ok"], [72, 200], 484, 11),
      ],
    ]);
    const escXml = new TextDecoder().decode(
      unzipSync(buildDocx(escModel, { pageBreaks: false }))["word/document.xml"]
    );
    check(
      "(e) cell text is XML-escaped",
      escXml.includes("R&amp;D") &&
        escXml.includes("A&amp;B") &&
        escXml.includes("x&lt;y")
    );
  }
  {
    // A page whose first block is a table still gets its page break.
    const twoPage = extractTextBlocks([
      [item("para one", 72, 100, 10)],
      [
        ...rowItems(tableB[0] ?? [], [72, 200], 500, 11),
        ...rowItems(tableB[1] ?? [], [72, 200], 484, 11),
      ],
    ]);
    const twoXml = new TextDecoder().decode(
      unzipSync(buildDocx(twoPage, { pageBreaks: true }))["word/document.xml"]
    );
    check(
      "(e) page break emitted before a table-first page",
      twoXml.includes('<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:tbl>')
    );
  }

  /* ---- (f) zero-regression on the table-free real fixture ---- */
  console.log("10f. zero-regression (real fixture, table-free)");
  {
    const withTables = extractTextBlocks(real.pages, {
      boldMap: real.boldMap,
      tables: true,
    });
    const withoutTables = extractTextBlocks(real.pages, {
      boldMap: real.boldMap,
      tables: false,
    });
    check(
      "(f) the old fixture detects 0 tables",
      docxStats(withTables).tables === 0,
      docxStats(withTables)
    );
    check(
      "(f) detection on vs off → BYTE-IDENTICAL docx",
      bytesEqual(
        buildDocx(withTables, { pageBreaks: true, title: "T" }),
        buildDocx(withoutTables, { pageBreaks: true, title: "T" })
      )
    );
    check(
      "(f) no w:tbl in the real-fixture docx",
      !new TextDecoder().decode(
        unzipSync(buildDocx(withTables, { pageBreaks: true, title: "T" }))[
          "word/document.xml"
        ]
      ).includes("<w:tbl")
    );
  }

  /* ---- real QA fixture: pdf-lib table page → pdf.js → docx ---- */
  console.log("10g. real QA fixture (public/qa/audit5-pdf2word-tables.pdf)");
  {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([612, 792]);
    page.drawText("Regional Sales Report", { x: 72, y: 720, size: 18, font: bold });
    page.drawText("The table below shows quarterly revenue by region for the year.", {
      x: 72,
      y: 690,
      size: 11,
      font: helv,
    });
    const qaA: string[][] = [
      ["Region", "Q1", "Q2", "Change"],
      ["North", "120", "135", "+12.5%"],
      ["South", "95", "88", "-7.4%"],
      ["East", "77", "82", "+6.5%"],
      ["West", "150", "143", "-4.7%"],
    ];
    const qaXA = [72, 180, 300, 420];
    let y = 650;
    for (let r = 0; r < qaA.length; r += 1) {
      const row = qaA[r] ?? [];
      for (let c = 0; c < row.length; c += 1) {
        page.drawText(row[c] ?? "", {
          x: qaXA[c] ?? 72,
          y,
          size: 11,
          font: r === 0 ? bold : helv,
        });
      }
      y -= 16;
    }
    page.drawText("Notes: figures are in thousands of rupees.", {
      x: 72,
      y: 550,
      size: 11,
      font: helv,
    });
    const qaB: string[][] = [
      ["Item", "Qty", "Total"],
      ["Pens", "12", "240"],
      ["Pads", "5", "375"],
    ];
    let y2 = 500;
    for (const row of qaB) {
      for (let c = 0; c < row.length; c += 1) {
        page.drawText(row[c] ?? "", {
          x: [72, 220, 380][c] ?? 72,
          y: y2,
          size: 11,
          font: helv,
        });
      }
      y2 -= 16;
    }
    const bytes = new Uint8Array(await doc.save());
    writeFileSync(
      new URL("../public/qa/audit5-pdf2word-tables.pdf", import.meta.url),
      bytes
    );
    check("(g) QA fixture written to public/qa/", bytes.length > 1000, bytes.length);

    const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
    const pdf = await task.promise;
    const qaPage = await pdf.getPage(1);
    const content = await qaPage.getTextContent();
    qaPage.cleanup();
    await pdf.cleanup();
    await task.destroy();
    const qaModel = extractTextBlocks([content.items as PdfTextItemInput[]]);
    const qaStats = docxStats(qaModel);
    check(
      "(g) real extraction detects 2 tables",
      qaStats.tables === 2,
      qaStats
    );
    check(
      "(g) title heading + 3 paragraphs around them",
      qaStats.headings === 1 && qaStats.paragraphs === 3,
      qaStats
    );
    const qaTables = qaModel.blocks.filter((b) => b.kind === "table");
    check(
      "(g) table A cells exact (5×4) through real pdf.js",
      qaTables[0]?.kind === "table" &&
        JSON.stringify(qaTables[0].rows) === JSON.stringify(qaA),
      qaTables[0]
    );
    check(
      "(g) table B cells exact (3×3) through real pdf.js",
      qaTables[1]?.kind === "table" &&
        JSON.stringify(qaTables[1].rows) === JSON.stringify(qaB),
      qaTables[1]
    );
    const qaXml = new TextDecoder().decode(
      unzipSync(buildDocx(qaModel, { pageBreaks: true, title: "Regional Sales Report" }))[
        "word/document.xml"
      ]
    );
    check("(g) real docx carries 2 w:tbl + 7 gridCol", countOf(qaXml, "<w:tbl>") === 2 && countOf(qaXml, "<w:gridCol") === 7);
    check("(g) real docx well-formed", xmlWellFormed(qaXml));
  }

  /* ---- (h) wiring locks: config copy, surface, worker, i18n ---- */
  console.log("10h. wiring locks");
  {
    const configSrc = readFileSync(
      new URL("../tools/pdf-to-word/config.ts", import.meta.url),
      "utf8"
    );
    check(
      "(h) config FAQ 'Which PDFs benefit?' (EN) + honesty",
      /Which PDFs benefit from table detection\?/.test(configSrc) &&
        /never fabricates/.test(configSrc)
    );
    check(
      "(h) config FAQ Hindi question present",
      configSrc.includes("टेबल पहचान किन PDF पर काम करती है?")
    );
    check(
      "(h) config features mention bordered Word tables + counts",
      /real bordered Word tables/.test(configSrc) &&
        /headings and tables counted/.test(configSrc)
    );
    const surfaceSrc = readFileSync(
      new URL("../tools/pdf-to-word/surface.tsx", import.meta.url),
      "utf8"
    );
    check(
      "(h) surface: Detect tables switch + hint",
      /id="p2w-tables"/.test(surfaceSrc) &&
        surfaceSrc.includes('t("p2w.tablesLabel")') &&
        surfaceSrc.includes('t("p2w.tablesHint")')
    );
    check(
      "(h) surface: tables option passed to the worker payload",
      /tables,/.test(surfaceSrc) &&
        surfaceSrc.includes("tables: detail?.tables ?? 0")
    );
    check("(h) surface: tables chip in the summary card", surfaceSrc.includes('t("p2w.summaryTables"'));
    const workerSrc = readFileSync(
      new URL("../tools/pdf-to-word/worker.ts", import.meta.url),
      "utf8"
    );
    const modelSrc = readFileSync(
      new URL("../tools/pdf-to-word/model.ts", import.meta.url),
      "utf8"
    );
    check(
      "(h) worker: option coerced, passed and reported",
      /tables: o\.tables !== false/.test(modelSrc) &&
        /tables: opts\.tables/.test(workerSrc) &&
        /tables: stats\.tables/.test(workerSrc)
    );
    const enCat = JSON.parse(
      readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8")
    ) as { p2w: Record<string, string> };
    const hiCat = JSON.parse(
      readFileSync(new URL("../src/i18n/hi.json", import.meta.url), "utf8")
    ) as { p2w: Record<string, string> };
    const mirror = JSON.parse(
      readFileSync(new URL("../tools/pdf-to-word/i18n.json", import.meta.url), "utf8")
    ) as { en: { p2w: Record<string, string> }; hi: { p2w: Record<string, string> } };
    const newKeys = ["tablesLabel", "tablesHint", "summaryTables"];
    check(
      "(h) central en+hi carry the new keys",
      newKeys.every((k) => typeof enCat.p2w[k] === "string" && typeof hiCat.p2w[k] === "string")
    );
    check(
      "(h) chip label is a real plural in both locales",
      enCat.p2w.summaryTables ===
        "{count, plural, =1 {1 table} other {# tables}}" &&
        hiCat.p2w.summaryTables === "{count, plural, =1 {1 टेबल} other {# टेबल}}"
    );
    check(
      "(h) Hindi is a real translation, not a copy",
      hiCat.p2w.tablesLabel !== enCat.p2w.tablesLabel &&
        /[\u0900-\u097F]/.test(hiCat.p2w.tablesLabel) &&
        /[\u0900-\u097F]/.test(hiCat.p2w.tablesHint)
    );
    check(
      "(h) tool i18n mirror matches the central catalog byte-for-byte",
      newKeys.every(
        (k) =>
          mirror.en.p2w[k] === enCat.p2w[k] && mirror.hi.p2w[k] === hiCat.p2w[k]
      )
    );
    check(
      "(h) parseRun: tables default ON, explicit false honoured",
      parseRun("{}").tables === true &&
        parseRun('{"tables":false}').tables === false &&
        parseRun('{"tables":"no"}').tables === true
    );
  }
}

/* ================================================================== */

async function main(): Promise<void> {
  part1();
  const real = await part2();
  part3();
  await part4(real);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
