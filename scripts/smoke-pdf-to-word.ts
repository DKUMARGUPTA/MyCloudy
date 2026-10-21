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
 *
 * Run: bun scripts/smoke-pdf-to-word.ts   (exit code = failures)
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildDocx,
  docxStats,
  extractTextBlocks,
  parseRun,
  sanitizeRunText,
  xmlEscape,
  DOCX_MIME,
  MAX_PARAGRAPHS,
  MAX_RUN_CHARS,
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
      model.blocks[0]?.runs[0]?.text === "Hello world",
      model.blocks[0]
    );
    check(
      "tight same-style pieces merge into one run",
      (model.blocks[0]?.runs.length ?? 0) === 1
    );
  }
  {
    // Adjacent pieces without a gap join without a space.
    const model = extractTextBlocks([
      [item("Hel", 72, 100, 10, { width: 15 }), item("lo", 87, 100, 10, { width: 10 })],
    ]);
    check(
      "zero gap joins with no space",
      model.blocks[0]?.runs[0]?.text === "Hello",
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
      model.blocks[0]?.runs[0]?.text === "Some parts are for the team.",
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
      (model.blocks[0]?.runs ?? [])
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
        model.blocks[0]?.runs[0]?.text === "this is a long example of hyphenation.",
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
      (model.blocks[0]?.runs ?? [])
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
      model.blocks[0]?.headingLevel === 1,
      model.blocks[0]
    );
    check(
      "second tier → Heading2",
      model.blocks.find((b) => b.runs.some((r) => r.text === "Sub Heading Here"))
        ?.headingLevel === 2
    );
    check(
      "body size stays body",
      model.blocks.find((b) => b.runs.some((r) => /body text/.test(r.text)))
        ?.headingLevel === undefined
    );
    check("docxStats counts headings", docxStats(model).headings === 2, docxStats(model));

    const flat = extractTextBlocks([page], { headings: false });
    check(
      "headings switch off → all plain paragraphs",
      flat.blocks.every((b) => b.headingLevel === undefined)
    );
  }
  {
    // A tier needs >= 6 chars — a stray large glyph is not a heading.
    const model = extractTextBlocks([
      [item("¶", 72, 720, 30), item("normal body text here", 72, 680, 11)],
    ]);
    check(
      "tiny heading tier is ignored",
      model.blocks[0]?.headingLevel === undefined && model.blocks.length === 2,
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
    const runs = model.blocks[0]?.runs ?? [];
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
    const runs = model.blocks[0]?.runs ?? [];
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
      (model.blocks[0]?.runs[0]?.text.length ?? 0) === MAX_RUN_CHARS
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
        model.blocks[0]?.runs[0]?.text === "survives",
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

async function part2(): Promise<void> {
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
    model.blocks[6]?.headingLevel === 2 &&
      model.blocks[6]?.runs[0]?.text === "Second Page Heading",
    model.blocks[6]
  );
  check(
    "two-line body merged into one paragraph",
    (model.blocks[1]?.runs ?? [])
      .map((r) => r.text)
      .join("") ===
      "This report covers the first quarter of the year. Numbers improved across every region listed.",
    model.blocks[1]
  );
  const mixedRuns = model.blocks[2]?.runs ?? [];
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
  check(
    "Hindi paragraph survives extraction (glyph order accepted)",
    hindiBlock !== undefined &&
      typeof hindiBlock.runs[0]?.text === "string" &&
      (hindiBlock.runs[0].text.includes("प्रिया") ||
        hindiBlock.runs[0].text.includes("िप्रया")) &&
      hindiBlock.runs[0].text.includes("श"),
    hindiBlock
  );
  check(
    "Hindi 14pt line stays body (below the two heading tiers)",
    hindiBlock?.headingLevel === undefined
  );

  /* ---- the docx round-trip ---- */
  const docx = buildDocx(model, {
    pageBreaks: true,
    title: model.blocks[0]?.runs[0]?.text ?? "",
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
    noHeadings.blocks.every((b) => b.headingLevel === undefined)
  );
  const noBreaks = new TextDecoder().decode(
    unzipSync(buildDocx(model, { pageBreaks: false }))["word/document.xml"]
  );
  check(
    "page breaks off → no w:br in the docx",
    !noBreaks.includes('w:type="page"')
  );
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

async function main(): Promise<void> {
  part1();
  await part2();
  part3();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
