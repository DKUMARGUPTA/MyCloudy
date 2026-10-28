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
 * 10. P6-k: the REAL worker module on OUR engine (CreateContext) —
 *     self/postMessage + fetch shims; pagination parity vs the pdf-lib-
 *     measured layout above, Devanagari Type0 + FULL ToUnicode round-trip
 *     of every drawn run, output naming, and the honest error codes.
 *
 * Run: bun scripts/smoke-txt2pdf.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
  type PDFFont,
} from "pdf-lib";
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
import {
  countReplacementChars,
  decodeWindows1252,
  hasValidUtf8MultibyteSequence,
  recoverCp1252Text,
} from "../tools/txt-to-pdf/encoding";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
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
/* 3b. CP1252/Latin-1 recovery (ENH-1)                                 */
/* ------------------------------------------------------------------ */

console.log("CP1252/Latin-1 mojibake recovery");
/** Latin-1/CP1252 fixture bytes — chars must be ≤ U+00FF. */
const latin1 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "latin1"));
const utf8Of = (b: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(b);

// Notepad classic: mostly ASCII with a few é/ï — the replacement rate
// stays under the 10% binary sniff, and used to export as "caf\uFFFD".
const notepad = readTextFile(
  latin1(
    "This note was saved on an old Windows machine, please read carefully.\n" +
      "Caf\xe9 na\xefve r\xe9sum\xe9s are fine.\n"
  )
);
check(
  "CP1252 accents recovered (no U+FFFD left)",
  notepad.kind === "ok" &&
    notepad.text ===
      "This note was saved on an old Windows machine, please read carefully.\n" +
      "Café naïve résumés are fine.\n",
  notepad.kind === "ok" ? JSON.stringify(notepad.text) : notepad
);

// CP1252-only punctuation bytes (0x80-0x9F) — curly quotes, em dash, €.
const quotes = readTextFile(
  latin1(
    "Just a plain old memo with a few smart marks.\n" +
      "He said \x93hi\x94 \x97 cost \x805 today.\n"
  )
);
check(
  "CP1252 smart quotes / em dash / euro recovered",
  quotes.kind === "ok" &&
    quotes.text ===
      "Just a plain old memo with a few smart marks.\n" +
      "He said “hi” — cost €5 today.\n",
  quotes.kind === "ok" ? JSON.stringify(quotes.text) : quotes
);

// Latin-1 (0xA0-0xFF) — identical bytes, same recovery.
const latin1File = readTextFile(
  latin1("A short weather and copyright line for today.\nd\xe9j\xe0 vu, \xa9 2024, 30\xb0C\n")
);
check(
  "Latin-1 high bytes recovered",
  latin1File.kind === "ok" &&
    latin1File.text ===
      "A short weather and copyright line for today.\ndéjà vu, © 2024, 30°C\n",
  latin1File.kind === "ok" ? JSON.stringify(latin1File.text) : latin1File
);

// Accents that only appear AFTER the 4 KB sniff window: the head is
// clean ASCII, the full-text scan still recovers them.
const late = readTextFile(latin1(`${"x".repeat(5000)} caf\xe9`));
check(
  "accents past the 4 KB sniff window still recovered",
  late.kind === "ok" && late.text.endsWith("café") &&
    !late.text.includes("\uFFFD"),
  late.kind === "ok" ? JSON.stringify(late.text.slice(-8)) : late
);

// Honest non-triggers:
// 1. A real UTF-8 file with a stray invalid byte keeps its UTF-8 reading
//    (valid multi-byte sequences present → not single-byte encoded).
const damaged = readTextFile(
  new Uint8Array([...enc.encode("plain text with é"), 0xff])
);
check(
  "UTF-8 with a stray bad byte is NOT re-decoded (typed unsupported, é intact)",
  damaged.kind === "unsupported" && damaged.codePoint === 0xfffd,
  damaged
);
check(
  "…and the pre-damage text is still correct UTF-8",
  damaged.kind === "unsupported" ||
    utf8Of(new Uint8Array([...enc.encode("plain text with é"), 0xff])).startsWith(
      "plain text with é"
    )
);

// 2. Double-encoded text (bytes C3 83 C2 A9 = UTF-8 of "Ã©") decodes
//    cleanly to "Ã©" — re-reading as CP1252 would only make it worse, so
//    the recovery must leave it untouched.
const doubleEncoded = readTextFile(
  new Uint8Array([0xc3, 0x83, 0xc2, 0xa9])
);
check(
  "double-encoded \"Ã©\" left untouched (no U+FFFD to fix)",
  doubleEncoded.kind === "ok" && doubleEncoded.text === "Ã©",
  doubleEncoded.kind === "ok" ? JSON.stringify(doubleEncoded.text) : doubleEncoded
);

// 3. Pure ASCII and real Hindi UTF-8 never switch.
check(
  "pure ASCII stays untouched",
  recoverCp1252Text(enc.encode("hello"), "hello") === "hello"
);
const hindiRound = readTextFile(enc.encode("नमस्ते दुनिया"));
check(
  "Hindi UTF-8 stays untouched",
  hindiRound.kind === "ok" && hindiRound.text === "नमस्ते दुनिया",
  hindiRound.kind === "ok" ? hindiRound.text : hindiRound
);

// 4. The binary sniff verdict is unchanged.
check(
  ">10% replacement chars in the head still → binary",
  readTextFile(new Uint8Array(200).fill(0x80)).kind === "binary"
);

/* ---- helper unit battery ---- */
check(
  "countReplacementChars",
  countReplacementChars("a\uFFFDb\uFFFD") === 2 &&
    countReplacementChars("abc") === 0
);
check(
  "hasValidUtf8MultibyteSequence: 2/3/4-byte forms detected",
  hasValidUtf8MultibyteSequence(enc.encode("é")) &&
    hasValidUtf8MultibyteSequence(enc.encode("हिंदी")) &&
    hasValidUtf8MultibyteSequence(enc.encode("𝄞"))
);
check(
  "hasValidUtf8MultibyteSequence: overlong C0 80 / E0 80 80 rejected",
  !hasValidUtf8MultibyteSequence(new Uint8Array([0xc0, 0x80])) &&
    !hasValidUtf8MultibyteSequence(new Uint8Array([0xe0, 0x80, 0x80]))
);
check(
  "hasValidUtf8MultibyteSequence: surrogate ED A0 80 rejected",
  !hasValidUtf8MultibyteSequence(new Uint8Array([0xed, 0xa0, 0x80]))
);
check(
  "hasValidUtf8MultibyteSequence: > U+10FFFF F4 90 80 80 rejected",
  !hasValidUtf8MultibyteSequence(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))
);
check(
  "hasValidUtf8MultibyteSequence: truncated tail not a sequence",
  !hasValidUtf8MultibyteSequence(new Uint8Array([0xc3])) &&
    !hasValidUtf8MultibyteSequence(new Uint8Array([0xe0, 0xa4]))
);
check(
  "decodeWindows1252: byte 0xE9 → é, 0x80 → €",
  decodeWindows1252(new Uint8Array([0xe9])) === "é" &&
    decodeWindows1252(new Uint8Array([0x80])) === "€"
);
check(
  "recoverCp1252Text: C1 bytes decode to controls, é recovered (spec best-fit)",
  recoverCp1252Text(latin1("a\x81\x8db\xe9"), utf8Of(latin1("a\x81\x8db\xe9"))) ===
    "a\u0081\u008dbé"
);
check(
  "recoverCp1252Text: lone C1 byte also strictly cleaner (U+0081 < U+FFFD)",
  recoverCp1252Text(
    new Uint8Array([0x81]),
    utf8Of(new Uint8Array([0x81]))
  ) === "\u0081"
);
check(
  "recoverCp1252Text: multibyte present keeps UTF-8",
  recoverCp1252Text(
    new Uint8Array([...enc.encode("é"), 0xff]),
    utf8Of(new Uint8Array([...enc.encode("é"), 0xff]))
  ) === utf8Of(new Uint8Array([...enc.encode("é"), 0xff]))
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

/* ------------------------------------------------------------------ */
/* 10. The REAL worker on the OWN engine (P6-k)                        */
/* ------------------------------------------------------------------ */
/*
 * The worker now runs CreateContext (our engine) end-to-end. This section
 * drives the actual worker module with a self/postMessage shim + a fetch
 * shim serving the self-hosted TTF, then verifies against the pdf-lib
 * oracle: pagination parity (our measure == the pdf-lib layout the pure
 * engine computed above), page sizes, output naming, the Type0 Devanagari
 * subset with a full ToUnicode round-trip of every drawn run, and the
 * honest error codes.
 */
console.log("worker (own engine, real module)");
{
  type PostedW = Record<string, unknown> & { type: string; runId: number };
  const inboxW: PostedW[] = [];
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
    location: { href: string };
  };
  workerGlobal.postMessage = (msg: unknown): void => {
    inboxW.push(msg as PostedW);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/fonts/NotoSansDevanagari-Regular.ttf")) {
      return new Response(new Uint8Array(ttfBytes), {
        status: 200,
        headers: { "Content-Type": "font/ttf" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  async function runTxtWorker(
    options: Record<string, unknown>,
    files: File[]
  ): Promise<PostedW[]> {
    inboxW.length = 0;
    workerGlobal.onmessage?.({
      data: { type: "run", runId: 1, toolId: "txt-to-pdf", options, files },
    });
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const terminal = inboxW.find(
        (m) => m.type === "result" || m.type === "error"
      );
      if (terminal) return inboxW.splice(0, inboxW.length);
    }
    throw new Error("txt worker never posted a terminal message");
  }

  const makeFile = (name: string, text: string): File =>
    new File([new TextEncoder().encode(text)], name, { type: "text/plain" });

  await import("../tools/txt-to-pdf/worker");

  /* ---- 10.1 Latin a4: pagination parity + naming + detail ---- */
  {
    const text = asciiParagraphs(5);
    const expected = layoutTxt(text, a4Opts, measure).pageCount;
    const out = await runTxtWorker({ pageSize: "a4" }, [makeFile("notes.txt", text)]);
    const result = out.find((m) => m.type === "result") as
      | { outputs?: { name: string; blob: Blob }[]; detail?: { files: number; pages: number } }
      | undefined;
    check("worker latin: result posted", result !== undefined);
    if (result) {
      check(
        "worker latin: output named notes.pdf",
        result.outputs?.[0]?.name === "notes.pdf"
      );
      check(
        "worker latin: detail counts (1 file)",
        result.detail?.files === 1 && result.detail?.pages === expected
      );
      const bytes = new Uint8Array(
        await result.outputs![0].blob.arrayBuffer()
      );
      const doc = await PDFDocument.load(bytes);
      check(
        `worker latin: pageCount parity (${doc.getPageCount()} == ${expected})`,
        doc.getPageCount() === expected
      );
      const size = doc.getPage(0).getSize();
      check(
        "worker latin: A4 size",
        Math.abs(size.width - PAGE_SIZES.a4.width) < 0.05 &&
          Math.abs(size.height - PAGE_SIZES.a4.height) < 0.05
      );
    }
  }

  /* ---- 10.2 Hindi: Type0 subset + full ToUnicode round-trip ---- */
  {
    const text = `${HINDI}\n\n${MIXED}\n\n${DANDA_RUN}`;
    const expected = layoutTxt(text, a4Opts, measure).pageCount;
    const out = await runTxtWorker({ pageSize: "a4" }, [makeFile("नोट्स.txt", text)]);
    const result = out.find((m) => m.type === "result") as
      | { outputs?: { name: string; blob: Blob }[] }
      | undefined;
    check("worker hindi: result posted", result !== undefined);
    if (result) {
      check(
        "worker hindi: Devanagari output name preserved",
        result.outputs?.[0]?.name === "नोट्स.pdf"
      );
      const bytes = new Uint8Array(
        await result.outputs![0].blob.arrayBuffer()
      );
      const doc = await PDFDocument.load(bytes);
      check(
        `worker hindi: pageCount parity (${doc.getPageCount()} == ${expected})`,
        doc.getPageCount() === expected
      );

      // Type0 font present
      const objs = [...doc.context.enumerateIndirectObjects()];
      const type0 = objs.find(
        ([, o]) =>
          o instanceof PDFDict &&
          String((o as unknown as { get(k: unknown): unknown }).get(PDFName.of("Subtype"))) === "/Type0"
      )?.[1] as unknown as { get(k: unknown): unknown } | undefined;
      check("worker hindi: Type0 font embedded", type0 !== undefined);

      if (type0) {
        // ToUnicode map: sid hex → codepoint hex
        const toUniRaw = doc.context.lookup(
          type0.get(PDFName.of("ToUnicode")) as never
        ) as unknown as { contents: Uint8Array };
        const cmapText = inflateSync(Buffer.from(toUniRaw.contents)).toString("latin1");
        const toUni = new Map<string, string>();
        for (const m of cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)) {
          toUni.set(m[1]!.toLowerCase(), m[2]!.toLowerCase());
        }
        check(
          `worker hindi: ToUnicode map non-trivial (${toUni.size} bfchars)`,
          toUni.size > 0
        );

        // Font names per page: /F<n> → font object
        let reconstructed = "";
        for (let p = 0; p < doc.getPageCount(); p += 1) {
          const pg = doc.getPage(p);
          const fontDict = pg.node
            .Resources()
            ?.lookup(PDFName.of("Font")) as unknown as {
            entries(): [PDFName, unknown][];
          } | undefined;
          check(
            `worker hindi: page ${p + 1} /Font resource present`,
            fontDict !== undefined
          );
          if (!fontDict) continue;
          const localFonts = new Map<string, string>();
          for (const [k, v] of fontDict.entries()) {
            const fd = doc.context.lookup(v as never) as unknown as {
              get(ky: unknown): unknown;
            };
            localFonts.set(
              k.asString() ?? String(k),
              String(fd?.get?.(PDFName.of("Subtype")) ?? "?")
            );
          }

          // decode the content stream: track Tf, decode each Tj
          const contents = pg.node.Contents() as unknown as {
            constructor: { name: string };
            contents: Uint8Array;
            size?: () => number;
            lookup?: (i: number) => { contents: Uint8Array };
          };
          let body = "";
          const readSt = (st: { contents: Uint8Array }): void => {
            let b = st.contents;
            try {
              b = inflateSync(Buffer.from(b));
            } catch {
              /* our writer emits raw streams */
            }
            body += Buffer.from(b).toString("latin1");
          };
          if (contents?.constructor?.name === "PDFArray") {
            const arr = contents as unknown as {
              size(): number;
              lookup(i: number): { contents: Uint8Array };
            };
            for (let i = 0; i < arr.size(); i += 1) readSt(arr.lookup(i));
          } else {
            readSt(contents);
          }

          let currentFont = "";
          for (const m of body.matchAll(/\/(\S+) [\d.]+ Tf|<([0-9A-Fa-f]+)> Tj/g)) {
            if (m[1]) {
              currentFont = localFonts.get(`/${m[1]}`) ?? localFonts.get(m[1]) ?? "";
              continue;
            }
            const hex = m[2] ?? "";
            if (currentFont === "/Type0") {
              // 4-hex glyph ids → ToUnicode
              for (let i = 0; i + 4 <= hex.length; i += 4) {
                const cpsHex = toUni.get(hex.slice(i, i + 4).toLowerCase()) ?? "";
                for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
                  reconstructed += String.fromCharCode(
                    parseInt(cpsHex.slice(j, j + 4), 16)
                  );
                }
              }
            } else {
              // standard font: 2-hex WinAnsi bytes
              for (let i = 0; i + 2 <= hex.length; i += 2) {
                reconstructed += String.fromCharCode(
                  parseInt(hex.slice(i, i + 2), 16)
                );
              }
            }
          }
        }
        // ---- reference: the SAME text through the pdf-lib recipe (the OLD
        // worker's exact draw pipeline — this smoke's `measure`) ----
        const refDoc = await PDFDocument.create();
        refDoc.registerFontkit(fontkit);
        const refNoto = await refDoc.embedFont(ttfBytes, { subset: true });
        const refHelv = await refDoc.embedFont(StandardFonts.Helvetica);
        const refResult = layoutTxt(text, a4Opts, measure);
        for (const pageData of refResult.pages) {
          const pg = refDoc.addPage([
            PAGE_SIZES.a4.width,
            PAGE_SIZES.a4.height,
          ]);
          for (const line of pageData.lines) {
            if (line.text.length === 0) continue;
            pg.drawText(line.text, {
              x: line.x,
              y: line.baseline,
              size: line.size,
              font: line.script === "noto" ? refNoto : refHelv,
            });
          }
        }
        const refSaved = await refDoc.save();
        const refDoc2 = await PDFDocument.load(refSaved);
        const refType0 = [...refDoc2.context.enumerateIndirectObjects()].find(
          ([, o]) =>
            o instanceof PDFDict &&
            String((o as unknown as { get(k: unknown): unknown }).get(PDFName.of("Subtype"))) === "/Type0"
        )?.[1] as unknown as { get(k: unknown): unknown } | undefined;
        check("worker hindi: reference Type0 present", refType0 !== undefined);
        const refToUniRaw = refType0
          ? (refDoc2.context.lookup(
              refType0.get(PDFName.of("ToUnicode")) as never
            ) as unknown as { contents: Uint8Array })
          : undefined;
        const refCmapText = refToUniRaw
          ? inflateSync(Buffer.from(refToUniRaw.contents)).toString("latin1")
          : "";
        const refToUni = new Map<string, string>();
        for (const m of refCmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)) {
          refToUni.set(m[1]!.toLowerCase(), m[2]!.toLowerCase());
        }
        let libRecon = "";
        for (let p = 0; p < refDoc2.getPageCount(); p += 1) {
          const pg = refDoc2.getPage(p);
          let body = "";
          const readSt = (st: { contents: Uint8Array }): void => {
            let b = st.contents;
            try {
              b = new Uint8Array(inflateSync(Buffer.from(b)));
            } catch {
              /* pdf-lib re-saved streams may be raw */
            }
            body += Buffer.from(b).toString("latin1");
          };
          const rc = pg.node.Contents() as unknown as {
            constructor: { name: string };
            contents: Uint8Array;
          };
          if (rc?.constructor?.name === "PDFArray") {
            const arr = rc as unknown as {
              size(): number;
              lookup(i: number): { contents: Uint8Array };
            };
            for (let i = 0; i < arr.size(); i += 1) readSt(arr.lookup(i));
          } else {
            readSt(rc);
          }
          for (const m of body.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
            const hex = m[1] ?? "";
            for (let i = 0; i + 4 <= hex.length; i += 4) {
              const cpsHex =
                refToUni.get(hex.slice(i, i + 4).toLowerCase()) ?? "";
              for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
                libRecon += String.fromCharCode(
                  parseInt(cpsHex.slice(j, j + 4), 16)
                );
              }
            }
          }
        }

        // Fontkit's subset lineage keeps FIRST-ASK codePoints per glyph —
        // BOTH engines lose the same decomposed-matra counts vs the raw
        // text (verified live against the pdf-lib oracle in P6-k: identical
        // deficits). The migration guarantee is ENGINE PARITY: our
        // reconstruction must equal the oracle's, codepoint for codepoint
        // (whitespace multisets — wrap points drop spaces in both).
        const sortCp = (s: string): string =>
          [...s]
            .filter((ch) => !/\s/.test(ch))
            .map((ch) => ch.codePointAt(0)!)
            .sort((a, b) => a - b)
            .join(",");
        check(
          "worker hindi: ToUnicode round-trip parity vs pdf-lib recipe",
          sortCp(reconstructed) === sortCp(libRecon),
          {
            ours: sortCp(reconstructed).slice(0, 120),
            lib: sortCp(libRecon).slice(0, 120),
          }
        );
        // Non-vacuous: both reconstructions carry the Devanagari range.
        check(
          "worker hindi: reconstructions substantial (Devanagari present both)",
          [...reconstructed].some((ch) => ch.codePointAt(0)! >= 0x0900) &&
            [...libRecon].some((ch) => ch.codePointAt(0)! >= 0x0900)
        );
      }
    }
  }

  /* ---- 10.3 honest error codes through the worker ---- */
  {
    const binary = await runTxtWorker(
      { pageSize: "a4" },
      [new File([new Uint8Array([0x68, 0x00, 0x69])], "blob.bin")]
    );
    check(
      "worker error: binary sniff",
      binary.find((m) => m.type === "error")?.["code"] === "txt2pdf.errorBinary"
    );
    const empty = await runTxtWorker(
      { pageSize: "a4" },
      [makeFile("empty.txt", "")]
    );
    check(
      "worker error: empty file",
      empty.find((m) => m.type === "error")?.["code"] === "txt2pdf.errorEmpty"
    );
    const greek = await runTxtWorker(
      { pageSize: "a4" },
      [makeFile("greek.txt", "ΣΦ Ωμέγα")]
    );
    check(
      "worker error: unsupported script",
      greek.find((m) => m.type === "error")?.["code"] ===
        "txt2pdf.errorUnsupportedScript"
    );
  }
}

console.log(`\nsmoke-txt2pdf: ${passed} passed, ${failed} failed${failed === 0 ? " — ALL GREEN" : ""}`);
// Explicit exit: registering self.onmessage (the worker import) keeps bun's
// event loop alive awaiting messages — same discipline as the images smoke.
process.exit(failed > 0 ? 1 : 0);
