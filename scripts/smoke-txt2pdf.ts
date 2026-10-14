/**
 * PRE-BUILD smoke test for the Text → PDF tool (P4.1). Proves the pure
 * layout engine + the worker's exact font pipeline with bun BEFORE the tool
 * goes live (the P3.3 lesson — prove the engine, then build on it):
 *
 *  1. Real measuring: pdf-lib StandardFonts.Helvetica + the self-hosted
 *     NotoSansDevanagari TTF via @pdf-lib/fontkit (subset: true) — the same
 *     recipe tools/stamp-common/worker-lib.ts uses in the worker.
 *  2. readTextFile verdicts: ok / binary (NUL byte, %PDF- magic, >10% U+FFFD)
 *     / empty / unsupported-script (typed), UTF-8 BOM stripped.
 *  3. Reflow + preserve layout: every emitted line RE-MEASURED against the
 *     content width; soft newlines join with a space (never glue words);
 *     overlong words hard-split cluster-safe (no line starts with a
 *     Devanagari matra); danda is a wrap opportunity; Devanagari blocks all
 *     render through the embedded font; indented preserve lines keep their
 *     indent.
 *  4. Pagination: page count grows with volume, no empty trailing page,
 *     orphan + widow protection inside planLineGroup (the keep-together
 *     the engine promises).
 *  5. Worker draw recipe: drawText per positioned run → save → reload →
 *     page count + page sizes match the pageSize option (a4 + letter).
 *
 * Run: bun scripts/smoke-txt2pdf.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";

import {
  MM_TO_PT,
  PAGE_SIZES,
  PageFlow,
  outputBaseName,
  planLineGroup,
  type MeasureRun,
  type PageGeometry,
  type PositionedTextRun,
  type ScriptFont,
} from "../tools/txt-to-pdf/text-layout";
import {
  layoutTxt,
  normalizeText,
  readTextFile,
  resolveTxtOptions,
  type TxtLayoutResult,
  type TxtOptions,
} from "../tools/txt-to-pdf/engine";

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
/* Real font measuring (the worker's exact recipe)                     */
/* ------------------------------------------------------------------ */

const TTF_PATH = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf";

const measureDoc = await PDFDocument.create();
measureDoc.registerFontkit(fontkit);
const ttfBytes = new Uint8Array(await readFile(TTF_PATH));
const noto = await measureDoc.embedFont(ttfBytes, { subset: true });
const helv = await measureDoc.embedFont(StandardFonts.Helvetica);

const fontOf = (script: ScriptFont): PDFFont =>
  script === "noto" ? noto : helv;
const measure: MeasureRun = (text, _spec, size, script) =>
  fontOf(script).widthOfTextAtSize(text, size);

/** Groups a page's flat run list into visual lines (same baseline). */
function groupLines(runs: PositionedTextRun[]): PositionedTextRun[][] {
  const byBaseline = new Map<number, PositionedTextRun[]>();
  for (const run of runs) {
    const key = Math.round(run.baseline * 100);
    const list = byBaseline.get(key);
    if (list) list.push(run);
    else byBaseline.set(key, [run]);
  }
  return [...byBaseline.values()].map((list) =>
    [...list].sort((a, b) => a.x - b.x)
  );
}

/** Reading-ordered lines of a whole result (page asc, baseline desc). */
function allLines(result: TxtLayoutResult): PositionedTextRun[][] {
  const out: PositionedTextRun[][] = [];
  for (const page of result.pages) out.push(...groupLines(page.lines));
  return out;
}

const lineText = (runs: PositionedTextRun[]): string =>
  runs.map((run) => run.text).join("");

const lineWidth = (runs: PositionedTextRun[]): number =>
  runs.reduce(
    (sum, run) => sum + fontOf(run.script).widthOfTextAtSize(run.text, run.size),
    0
  );

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const WORDS =
  "the quick brown fox jumps over a lazy dog while reading plain text files in bright daylight".split(
    " "
  );

function asciiParagraphs(count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const words: string[] = [];
    for (let j = 0; j < 40; j += 1) {
      words.push(WORDS[(i * 13 + j * 7) % WORDS.length]);
    }
    out.push(words.join(" "));
  }
  return out.join("\n\n");
}

const HINDI =
  "भारत एक विशाल और विविध देश है। यहाँ सैकड़ों भाषाएँ बोली जाती हैं, जिनमें हिंदी सबसे अधिक प्रचलित है। देवनागरी लिपि अपनी शिरोरेखा के लिए जानी जाती है, और इसमें लिखा गया टेक्स्ट पढ़ने में सरल लगता है। हर वाक्य के अंत में पूर्ण विराम आता है, जिसे दंड कहते हैं।";
const MIXED =
  "The Hindi word for book is किताब, and for language it is भाषा। Both appear in everyday speech.";
const DANDA_RUN = "विद्या।".repeat(40);
const LONG_WORD = "ab".repeat(160);
const PRESERVE =
  "shopping list:\n    four apples\n    two loaves of bread\n\nnote to self, buy ink";

const a4Opts = resolveTxtOptions({ pageSize: "a4" });
const letterOpts = resolveTxtOptions({ pageSize: "letter" });
const A4_MARGIN = a4Opts.margin * MM_TO_PT;
const A4_CONTENT = PAGE_SIZES.a4.width - 2 * A4_MARGIN;

/* ------------------------------------------------------------------ */
/* 1. Fonts                                                            */
/* ------------------------------------------------------------------ */

console.log("fonts");
check(
  "Noto Devanagari embeds via fontkit (subset) and measures > 0",
  noto.widthOfTextAtSize("पृष्ठ ०१२३४५६७८९", 12) > 0
);
check(
  "Noto carries Latin glyphs too (mixed-script line measures > 0)",
  noto.widthOfTextAtSize("Page ५ of १०", 12) > 0
);
check("Helvetica measures > 0", helv.widthOfTextAtSize("Hello", 11) > 0);

/* ------------------------------------------------------------------ */
/* 2. Options                                                          */
/* ------------------------------------------------------------------ */

console.log("options");
const defaults = resolveTxtOptions({});
check(
  "defaults: a4 / 11pt / 1.5 line height / 20mm / reflow",
  defaults.pageSize === "a4" &&
    defaults.fontSize === 11 &&
    defaults.lineHeight === 1.5 &&
    defaults.margin === 20 &&
    defaults.mode === "reflow"
);
const clamped = resolveTxtOptions({
  pageSize: "letter",
  fontSize: 99,
  lineHeight: "1.9",
  margin: -5,
  mode: "preserve",
});
check(
  "clamps + coerces: letter / 24 / 1.9 / 10 / preserve",
  clamped.pageSize === "letter" &&
    clamped.fontSize === 24 &&
    clamped.lineHeight === 1.9 &&
    clamped.margin === 10 &&
    clamped.mode === "preserve"
);
const normalized = resolveTxtOptions({
  pageSize: "A4",
  mode: "nonsense",
});
check(
  "unknown values fall back: a4 / reflow",
  normalized.pageSize === "a4" && normalized.mode === "reflow"
);

/* ------------------------------------------------------------------ */
/* 3. readTextFile verdicts                                            */
/* ------------------------------------------------------------------ */

console.log("readTextFile (decode + binary sniff)");
const enc = new TextEncoder();
const okAscii = readTextFile(enc.encode("hello plain text\nsecond line\n"));
check(
  "plain ASCII → ok",
  okAscii.kind === "ok" && okAscii.kind === "ok" && okAscii.text.startsWith("hello")
);
check(
  "NUL byte in first 4 KB → binary",
  readTextFile(enc.encode("hello\x00world")).kind === "binary"
);
check(
  "%PDF- magic → binary",
  readTextFile(enc.encode("%PDF-1.7 fake")).kind === "binary"
);
check(
  ">10% replacement chars → binary",
  readTextFile(new Uint8Array(200).fill(0x80)).kind === "binary"
);
const bom = readTextFile(enc.encode("\uFEFFBOM text here"));
check(
  "UTF-8 BOM stripped",
  bom.kind === "ok" && bom.text === "BOM text here"
);
check(
  "whitespace-only file → empty",
  readTextFile(enc.encode("   \n\t\n  ")).kind === "empty"
);
const arabic = readTextFile(enc.encode("مرحبا بالعالم"));
check(
  "Arabic → typed unsupported verdict with the code point",
  arabic.kind === "unsupported" && arabic.codePoint === 0x0645
);

/* ------------------------------------------------------------------ */
/* 4. normalizeText                                                    */
/* ------------------------------------------------------------------ */

console.log("normalizeText");
check(
  "CRLF→LF, tab→4 spaces, C0 controls + U+FEFF dropped",
  normalizeText("a\r\nb\tc\u000b\u0007\ufeffd") === "a\nb    cd"
);

/* ------------------------------------------------------------------ */
/* 5. Reflow layout                                                    */
/* ------------------------------------------------------------------ */

console.log("reflow layout");
const asciiResult = layoutTxt(asciiParagraphs(30), a4Opts, measure);
const asciiLines = allLines(asciiResult);
check(
  `every ASCII line fits the content width (${asciiLines.length} lines re-measured)`,
  asciiLines.every((line) => lineWidth(line) <= A4_CONTENT + 0.5)
);
check(
  "no line starts with a space",
  asciiLines.every((line) => !lineText(line).startsWith(" "))
);
check(
  "every ASCII run stays on the built-in font (std)",
  asciiResult.pages
    .flatMap((page) => page.lines)
    .every((run) => run.script === "std")
);
const asciiJoined = asciiResult.pages
  .flatMap((page) => page.lines)
  .map((run) => run.text)
  .join("");
check(
  "no letters lost or gained (whitespace-stripped compare)",
  asciiJoined.replace(/\s+/g, "") === asciiParagraphs(30).replace(/\s+/g, "")
);

const softResult = layoutTxt("alpha bravo\ncharlie delta", a4Opts, measure);
const softLine = allLines(softResult);
check(
  "soft newline inside a paragraph joins with a space",
  softLine.length === 1 && lineText(softLine[0]) === "alpha bravo charlie delta"
);

const longResult = layoutTxt(`${LONG_WORD}\n\nAfter the long word.`, a4Opts, measure);
const longLines = allLines(longResult);
const longJoined = longLines.map(lineText).join("");
check(
  "overlong unbreakable word hard-splits, every chunk fits",
  longLines.length > 1 && longLines.every((line) => lineWidth(line) <= A4_CONTENT + 0.5)
);
check(
  "hard-split concatenation is identical to the source word",
  longJoined.startsWith(LONG_WORD)
);

const hindiResult = layoutTxt(HINDI, a4Opts, measure);
const hindiLines = allLines(hindiResult);
check(
  "Hindi paragraph: every run goes to the embedded font (noto)",
  hindiResult.pages
    .flatMap((page) => page.lines)
    .every((run) => run.script === "noto")
);
check(
  "Hindi paragraph: every line fits the content width",
  hindiLines.every((line) => lineWidth(line) <= A4_CONTENT + 0.5)
);

function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x0900 && cp <= 0x0903) ||
    (cp >= 0x093a && cp <= 0x094f) ||
    (cp >= 0x0951 && cp <= 0x0957) ||
    (cp >= 0x0962 && cp <= 0x0963)
  );
}
const notoStarts = [...hindiLines, ...allLines(layoutTxt(MIXED, a4Opts, measure))]
  .map((line) => line.length > 0 ? line[0].text[0] : "")
  .map((ch) => ch.charCodeAt(0));
check(
  "no line starts with a Devanagari combining mark (cluster-safe cuts)",
  notoStarts.every((cp) => !isCombiningMark(cp))
);

const mixedResult = layoutTxt(MIXED, a4Opts, measure);
const mixedRuns = mixedResult.pages.flatMap((page) => page.lines);
check(
  "mixed Latin + Devanagari block upgrades whole to one font (noto), no crash",
  mixedRuns.length > 0 &&
    mixedRuns.every((run) => run.script === "noto") &&
    allLines(mixedResult).every((line) => lineWidth(line) <= A4_CONTENT + 0.5)
);

const dandaResult = layoutTxt(DANDA_RUN, a4Opts, measure);
const dandaLines = allLines(dandaResult);
check(
  "danda without spaces is a wrap boundary (each line ends in ।)",
  dandaLines.length >= 2 && dandaLines.every((line) => lineText(line).endsWith("।"))
);

/* ------------------------------------------------------------------ */
/* 6. Preserve mode                                                    */
/* ------------------------------------------------------------------ */

console.log("preserve layout");
const presOpts = resolveTxtOptions({ mode: "preserve" });
const presResult = layoutTxt(PRESERVE, presOpts, measure);
const presLines = allLines(presResult);
const presStarts = new Set(presLines.map((line) => lineText(line).split(" ")[0]));
check(
  "preserve keeps line structure (each source line starts an output line)",
  ["shopping", "four", "two", "note"].every((word) => presStarts.has(word))
);
const indented = presLines.filter((line) => lineText(line).startsWith("four"));
check(
  "preserve keeps leading indentation as x offset",
  indented.length > 0 && indented[0][0].x >= A4_MARGIN + 4
);

/* ------------------------------------------------------------------ */
/* 7. Pagination                                                        */
/* ------------------------------------------------------------------ */

console.log("pagination");
const shortResult = layoutTxt("one small paragraph", a4Opts, measure);
const bigResult = layoutTxt(asciiParagraphs(300), a4Opts, measure);
const hugeResult = layoutTxt(asciiParagraphs(500), a4Opts, measure);
check(
  "short text is one page; volume grows the page count",
  shortResult.pageCount === 1 &&
    bigResult.pageCount >= 3 &&
    hugeResult.pageCount > bigResult.pageCount
);
check(
  "no empty trailing page (big + huge)",
  bigResult.pages[bigResult.pages.length - 1].lines.length > 0 &&
    hugeResult.pages[hugeResult.pages.length - 1].lines.length > 0
);

function makeFlow(contentHeight: number): PageFlow {
  const geometry: PageGeometry = {
    pageW: 200,
    pageH: contentHeight + 20,
    marginLeft: 10,
    marginRight: 10,
    marginTop: 10,
    marginBottom: 10,
  };
  return new PageFlow(geometry);
}

// Orphan (R1): 3 lines remain but exactly 1 fits → the whole group moves.
const orphanFlow = makeFlow(90);
orphanFlow.consume(70); // 20pt left = one line
const orphanPlan = planLineGroup(orphanFlow, 3, 20, 10);
check(
  "planLineGroup R1: a lone fitting line defers the whole group to the next page",
  orphanPlan.length === 3 &&
    orphanPlan.every((place) => place.pageIndex === 1) &&
    orphanFlow.pageCount === 2
);

// Widow (R2): 5 lines, cap 4 → one extra travels so ≥2 start the next page.
const widowFlow = makeFlow(90);
widowFlow.consume(10); // 80pt left = 4 lines
const widowPlan = planLineGroup(widowFlow, 5, 20, 10);
const onPage = (plan: typeof widowPlan, page: number): number =>
  plan.filter((place) => place.pageIndex === page).length;
check(
  "planLineGroup R2: the next page starts with ≥2 group lines",
  onPage(widowPlan, 0) === 3 && onPage(widowPlan, 1) === 2
);

/* ------------------------------------------------------------------ */
/* 8. Output naming                                                    */
/* ------------------------------------------------------------------ */

console.log("output naming");
const sanitizedName = outputBaseName("bad:name*");
check(
  "outputBaseName strips the last extension, sanitizes, caps, falls back",
  outputBaseName("notes.txt") === "notes" &&
    outputBaseName("archive.tar.gz") === "archive.tar" &&
    !/[\\/:*?"<>|]/.test(sanitizedName) &&
    outputBaseName("") === "document" &&
    outputBaseName(`${"x".repeat(200)}.txt`).length <= 120
);

/* ------------------------------------------------------------------ */
/* 9. Worker draw recipe → save → reload                               */
/* ------------------------------------------------------------------ */

console.log("render + reload (worker recipe)");
async function renderAndReload(
  name: string,
  text: string,
  opts: TxtOptions,
  outPath: string,
  useNoto: boolean
): Promise<void> {
  const doc = await PDFDocument.create();
  if (useNoto) doc.registerFontkit(fontkit);
  const notoF = useNoto
    ? await doc.embedFont(ttfBytes, { subset: true })
    : null;
  const helvF = await doc.embedFont(StandardFonts.Helvetica);
  const docMeasure: MeasureRun = (t, _spec, size, script) =>
    (script === "noto" && notoF ? notoF : helvF).widthOfTextAtSize(t, size);
  const result = layoutTxt(text, opts, docMeasure);
  const size = PAGE_SIZES[opts.pageSize];
  for (const pageData of result.pages) {
    const page = doc.addPage([size.width, size.height]);
    for (const line of pageData.lines) {
      if (line.text.length === 0) continue;
      page.drawText(line.text, {
        x: line.x,
        y: line.baseline,
        size: line.size,
        font: line.script === "noto" && notoF ? notoF : helvF,
        color: rgb(0.1, 0.1, 0.12),
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
    `${name}: reload keeps the page count (${result.pageCount})`,
    reloaded.getPageCount() === result.pageCount
  );
  check(
    `${name}: reload page size matches ${opts.pageSize}`,
    Math.abs(reloadedSize.width - size.width) < 0.05 &&
      Math.abs(reloadedSize.height - size.height) < 0.05
  );
}

await renderAndReload(
  "a4 Hindi+mixed",
  `${HINDI}\n\n${MIXED}\n\n${DANDA_RUN}`,
  a4Opts,
  "/home/z/my-project/download/qa-p41-txt-a4.pdf",
  true
);
await renderAndReload(
  "a4 preserve",
  PRESERVE,
  presOpts,
  "/home/z/my-project/download/qa-p41-txt-preserve.pdf",
  false
);
await renderAndReload(
  "letter Latin",
  asciiParagraphs(5),
  letterOpts,
  "/home/z/my-project/download/qa-p41-txt-letter.pdf",
  false
);

console.log(`\nsmoke-txt2pdf: ${passed} passed, ${failed} failed${failed === 0 ? " — ALL GREEN" : ""}`);
if (failed > 0) process.exit(1);
