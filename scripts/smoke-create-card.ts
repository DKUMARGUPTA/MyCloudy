/**
 * PRE-BUILD smoke test for Create card (63rd tool, PRD "Card").
 *
 * Part 1 (model, pure): mm→pt exactness for every format + orientation,
 * fold panel EXACT halves (fold line at W/2, both halves cover the
 * sheet), sheet sequence (flat/fold × merge rows), template defs (8,
 * unique ids, valid hex, bg files on disk, non-empty defaults in BOTH
 * locales), colour math (sanitize/luminance/ink), the RFC-4180 CSV
 * parser battery (quotes, "" escapes, embedded commas/newlines, CRLF,
 * lone CR, BOM, trailing empty line, header-only, unterminated quote,
 * 200-row cap, 2 MB cap), {{column}} merge + validation (order-stable,
 * case-sensitive, non-matching forms untouched), word-wrap with a FAKE
 * measurer (exact line arrays, char-breaking of over-long words incl.
 * Devanagari, explicit \n, blank paragraphs, no line over width),
 * truncate-with-ellipsis (binary search), headline shrink-to-fit (first
 * fitting size, min clamp, termination), message ellipsis overflow, the
 * wire option parser (garbage JSON → defaults, every clamp) and the
 * localized output names.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim + a sharp-backed OffscreenCanvas /
 * createImageBitmap raster backend + a fetch wrapper that resolves the
 * same-origin "/card-templates/…" URLs onto the real public/ directory
 * (so the actual template JPEGs load). Verified end to end: option
 * parse → backdrop fetch → photo decode → drawCardSheet → pdf-lib
 * embedJpg → result Blob. PDFs are re-opened with pdf-lib: %PDF-/%%EOF
 * magic, page count = computeSheets (flat ×N, fold 2×N), exact page
 * dims, embedded JPEG XObjects, real-backdrop pixels painted, the
 * gradient FALLBACK when the background file is missing, the photo slot
 * pixel-diff, merge rows landing in the right sheet pairs (via the
 * recorded text ops), jpg/png quick formats and the honest error paths
 * (unknown CSV column, 201 rows, unterminated quote).
 *
 * Run: bun scripts/smoke-create-card.ts
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

import {
  BLANK_BACKGROUNDS,
  CSV_MAX_CHARS,
  MAX_CSV_ROWS,
  PT_PER_MM,
  PX_PER_PT,
  TEMPLATES,
  CARD_FORMATS,
  computeSheets,
  CsvError,
  DEFAULT_CARD_OPTION,
  DEFAULT_TEMPLATE_ID,
  defaultTextsFor,
  hexLuminance,
  inkHex,
  isTemplateId,
  mergeText,
  mergedTextsFor,
  outputBaseName,
  pagePixelSize,
  pagePtSize,
  parseCardOption,
  parseCsv,
  sanitizeHexColor,
  serializeCard,
  sheetPanelsPt,
  templateById,
  TEXT_FIELD_LIMITS,
  TEXT_FIELD_ORDER,
  validatePlaceholders,
  wrapText,
  fitHeadline,
  layoutMessage,
  truncateWithEllipsis,
  coverCrop,
  type CardOption,
  type CardTexts,
} from "../tools/create-card/model";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string, detail?: unknown): void {
  failed += 1;
  console.log(`FAIL ${message}`);
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

function assert(condition: boolean, message: string, detail?: unknown): void {
  if (condition) pass(message);
  else fail(message, detail);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(message);
  else fail(message, { actual, expected });
}

const ROOT = process.cwd();

/* ================================================================== */
/* Part 1 — the pure model                                             */
/* ================================================================== */

function part1(): void {
  /* ---- exact geometry: mm → pt ---- */
  assert(Math.abs(PT_PER_MM - 72 / 25.4) < 1e-12, "PT_PER_MM is the exact factor");
  assertEqual(PX_PER_PT, 2, "PX_PER_PT = 2 (collage policy)");

  const A6W = 105 * PT_PER_MM;
  const A6H = 148 * PT_PER_MM;
  const a6 = pagePtSize("flat-a6", "portrait");
  assert(Math.abs(a6.w - A6W) < 1e-9 && Math.abs(a6.h - A6H) < 1e-9, "A6 portrait exact pt", a6);
  assert(Math.abs(A6W - 297.64) < 0.01 && Math.abs(A6H - 419.53) < 0.01, "A6 ≈ 297.64×419.53 pt");

  const a6l = pagePtSize("flat-a6", "landscape");
  assert(Math.abs(a6l.w - A6H) < 1e-9 && Math.abs(a6l.h - A6W) < 1e-9, "A6 landscape swaps");

  const a5 = pagePtSize("flat-a5", "portrait");
  assert(
    Math.abs(a5.w - 148 * PT_PER_MM) < 1e-9 && Math.abs(a5.h - 210 * PT_PER_MM) < 1e-9,
    "A5 portrait exact pt (419.53×595.28)",
    a5
  );

  // 4×6 is inches in disguise: exactly 288×432 pt.
  const pc = pagePtSize("flat-4x6", "portrait");
  assert(
    Math.abs(pc.w - 288) < 1e-9 && Math.abs(pc.h - 432) < 1e-9,
    "4×6 postcard = exactly 288×432 pt",
    pc
  );

  // fold-a4 is ALWAYS the landscape sheet, both orientation inputs.
  const foldP = pagePtSize("fold-a4", "portrait");
  const foldL = pagePtSize("fold-a4", "landscape");
  assert(
    Math.abs(foldP.w - 297 * PT_PER_MM) < 1e-9 &&
      Math.abs(foldP.h - 210 * PT_PER_MM) < 1e-9,
    "fold-a4 portrait input = landscape sheet (841.89×595.28)",
    foldP
  );
  assertEqual(foldP, foldL, "fold-a4 ignores the orientation switch");
  assert(Math.abs(foldP.w - 841.89) < 0.01, "A4 landscape width ≈ 841.89 pt");

  const px = pagePixelSize("flat-a6", "portrait");
  assertEqual(px, { w: 595, h: 839 }, "A6 pixel canvas = round(pt × 2)");
  const foldPx = pagePixelSize("fold-a4", "portrait");
  assertEqual(foldPx, { w: 1684, h: 1191 }, "fold A4 pixel canvas");

  /* ---- fold panels are EXACT halves ---- */
  for (const kind of ["fold-outside", "fold-inside"] as const) {
    const panels = sheetPanelsPt("fold-a4", "portrait", kind);
    assertEqual(panels.length, 2, `${kind}: two panels`);
    const [left, right] = panels;
    assert(left.x === 0 && left.y === 0, `${kind}: left panel at origin`);
    assert(
      Math.abs(left.w - foldP.w / 2) < 1e-9 && Math.abs(right.w - foldP.w / 2) < 1e-9,
      `${kind}: fold line exactly at W/2`
    );
    assert(Math.abs(left.x + left.w - right.x) < 1e-9, `${kind}: panels are adjacent`);
    assert(
      Math.abs(left.h - foldP.h) < 1e-9 && Math.abs(right.h - foldP.h) < 1e-9,
      `${kind}: both halves cover the full height`
    );
    assert(right.x === foldP.w / 2, `${kind}: right panel starts at the fold`);
  }
  const flatPanels = sheetPanelsPt("flat-a5", "landscape", "flat");
  assertEqual(flatPanels.length, 1, "flat: single panel");
  assert(
    flatPanels[0].x === 0 &&
      flatPanels[0].y === 0 &&
      Math.abs(flatPanels[0].w - a5.h) < 1e-9 &&
      Math.abs(flatPanels[0].h - a5.w) < 1e-9,
    "flat: panel is the whole page"
  );

  /* ---- sheet sequence ---- */
  const flat1 = computeSheets("flat-a6", 1);
  assertEqual(flat1.map((s) => s.kind), ["flat"], "flat × 1 row = 1 sheet");
  const flat3 = computeSheets("flat-a5", 3);
  assertEqual(
    flat3.map((s) => s.kind),
    ["flat", "flat", "flat"],
    "flat × 3 rows = 3 sheets"
  );
  assertEqual(flat3.map((s) => s.rowIndex), [0, 1, 2], "flat rows in order");
  const fold1 = computeSheets("fold-a4", 1);
  assertEqual(
    fold1.map((s) => s.kind),
    ["fold-outside", "fold-inside"],
    "fold × 1 row = outside then inside"
  );
  const fold2 = computeSheets("fold-a4", 2);
  assertEqual(
    fold2.map((s) => `${s.kind}#${s.rowIndex}`),
    ["fold-outside#0", "fold-inside#0", "fold-outside#1", "fold-inside#1"],
    "fold × 2 rows = per-card outside+inside pairs"
  );
  assertEqual(computeSheets("flat-a6", 0).length, 1, "0 rows → single card (max(1, n))");
  assertEqual(computeSheets("fold-a4", -3).length, 2, "negative rows clamp to 1");

  /* ---- template defs ---- */
  assertEqual(TEMPLATES.length, 8, "8 templates shipped");
  const ids = TEMPLATES.map((tpl) => tpl.id);
  assertEqual(new Set(ids).size, 8, "template ids unique");
  assertEqual(
    ids,
    ["diwali", "holi", "rakhi", "newyear", "birthday", "wedding", "thankyou", "blank"],
    "template ids (7 designed + blank)"
  );
  for (const tpl of TEMPLATES) {
    const problems: string[] = [];
    if (!tpl.label.en || !tpl.label.hi) problems.push("label");
    if (!/^#[0-9a-fA-F]{6}$/.test(tpl.ink)) problems.push("ink");
    if (!/^#[0-9a-fA-F]{6}$/.test(tpl.accent)) problems.push("accent");
    if (!Array.isArray(tpl.palette) || tpl.palette.length !== 2) problems.push("palette");
    else {
      for (const hex of tpl.palette) {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) problems.push("palette-hex");
      }
    }
    for (const locale of ["en", "hi"] as const) {
      for (const field of TEXT_FIELD_ORDER) {
        if (typeof tpl.defaults[locale][field] !== "string" || tpl.defaults[locale][field] === "") {
          problems.push(`defaults.${locale}.${field}`);
        }
      }
    }
    assert(problems.length === 0, `template ${tpl.id}: defs valid`, problems);
  }
  const blank = templateById("blank");
  assert(blank.bg === null, "blank template has no background image");
  for (const tpl of TEMPLATES) {
    if (tpl.bg === null) continue;
    const file = path.join(ROOT, "public", tpl.bg.replace(/^\//, ""));
    assert(existsSync(file), `template ${tpl.id}: bg file exists (${tpl.bg})`);
    const size = existsSync(file) ? statSync(file).size : 0;
    assert(size > 10_000, `template ${tpl.id}: bg is a real JPEG (${size} B)`, size);
  }
  assert(templateById("nope").id === DEFAULT_TEMPLATE_ID, "templateById: unknown → default");
  assert(isTemplateId("diwali") && !isTemplateId("nope"), "isTemplateId");
  const defaultsCopy = defaultTextsFor("diwali", "hi");
  defaultsCopy.headline = "MUTATED";
  assert(
    templateById("diwali").defaults.hi.headline !== "MUTATED",
    "defaultTextsFor returns a fresh object"
  );

  /* ---- colours ---- */
  assertEqual(sanitizeHexColor("#ABCDEF"), "#abcdef", "sanitize keeps valid hex (lowercased)");
  assertEqual(sanitizeHexColor("  #A1B2C3 ", "#ffffff"), "#a1b2c3", "sanitize trims");
  assertEqual(sanitizeHexColor("blue", "#ffffff"), "#ffffff", "sanitize garbage → fallback");
  assertEqual(sanitizeHexColor(42, "#f5f1ea"), "#f5f1ea", "sanitize non-string → fallback");
  assert(Math.abs(hexLuminance("#ffffff") - 1) < 1e-9, "luminance white = 1");
  assert(Math.abs(hexLuminance("#000000") - 0) < 1e-9, "luminance black = 0");
  assertEqual(inkHex("#ffffff"), "#1c1917", "light background → dark ink");
  assertEqual(inkHex("#1c1917"), "#faf9f7", "dark background → light ink");
  assertEqual(BLANK_BACKGROUNDS.length, 5, "blank background swatches shipped");

  /* ---- CSV parser battery (RFC-4180) ---- */
  assertEqual(parseCsv("a,b\n1,2"), { columns: ["a", "b"], rows: [["1", "2"]] }, "csv: basic");
  assertEqual(parseCsv('a\n"x,y"'), { columns: ["a"], rows: [["x,y"]] }, "csv: quoted comma");
  assertEqual(
    parseCsv('a\n"l1\nl2"'),
    { columns: ["a"], rows: [["l1\nl2"]] },
    "csv: embedded newline inside quotes"
  );
  assertEqual(
    parseCsv('a\n"say ""hi"""'),
    { columns: ["a"], rows: [['say "hi"']] },
    'csv: "" escapes a literal quote'
  );
  assertEqual(
    parseCsv("a,b\r\n1,2\r\n"),
    { columns: ["a", "b"], rows: [["1", "2"]] },
    "csv: CRLF + trailing empty skipped"
  );
  assertEqual(
    parseCsv("a,b\r1,2"),
    { columns: ["a", "b"], rows: [["1", "2"]] },
    "csv: lone CR"
  );
  assertEqual(
    parseCsv("\uFEFFa,b\n1,2"),
    { columns: ["a", "b"], rows: [["1", "2"]] },
    "csv: BOM stripped"
  );
  assertEqual(
    parseCsv("a,b\n1,2\n\n"),
    { columns: ["a", "b"], rows: [["1", "2"]] },
    "csv: ONE trailing empty line skipped"
  );
  assertEqual(parseCsv("a\n1\n2"), { columns: ["a"], rows: [["1"], ["2"]] }, "csv: single column");
  assertEqual(parseCsv("a,b"), { columns: ["a", "b"], rows: [] }, "csv: header-only → no merge");
  assertEqual(parseCsv(""), { columns: [], rows: [] }, "csv: empty text");
  assertEqual(parseCsv('a\n" x "'), { columns: ["a"], rows: [[" x "]] }, "csv: spaces preserved in quotes");
  assertEqual(
    parseCsv("a ,b\n1,2").columns,
    ["a ", "b"],
    "csv: column names NOT trimmed (case/spacing exact)"
  );

  try {
    parseCsv('a\n"unterminated');
    fail("csv: unterminated quote should throw");
  } catch (error) {
    assert(
      error instanceof CsvError && error.code === "card.errorCsvQuote",
      "csv: unterminated quote → card.errorCsvQuote",
      error
    );
  }
  const long = "a\n" + Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `r${i}`).join("\n");
  try {
    parseCsv(long);
    fail("csv: 201 rows should throw");
  } catch (error) {
    assert(
      error instanceof CsvError && error.code === "card.errorCsvRows",
      "csv: 201 rows → card.errorCsvRows",
      error
    );
  }
  assertEqual(MAX_CSV_ROWS, 200, "csv row cap is 200 (documented)");
  try {
    parseCsv("a\n" + "z".repeat(CSV_MAX_CHARS + 10));
    fail("csv: oversized text should throw");
  } catch (error) {
    assert(
      error instanceof CsvError && error.code === "card.errorCsvSize",
      "csv: > 2 MB chars → card.errorCsvSize",
      error
    );
  }

  /* ---- {{column}} merge + validation ---- */
  const columns = ["name", "city"];
  const row = ["Ravi", "Pune"];
  assertEqual(mergeText("Dear {{name}} of {{city}}", row, columns), "Dear Ravi of Pune", "merge: two placeholders");
  assertEqual(mergeText("Dear {{name}} {{name}}", row, columns), "Dear Ravi Ravi", "merge: same column twice");
  assertEqual(mergeText("Hi {{unknown}}", row, columns), "Hi {{unknown}}", "merge: unknown stays literal");
  assertEqual(mergeText("{{}} {{ name}} {{name }}", row, columns), "{{}} {{ name}} {{name }}", "merge: non-matching forms untouched");
  assertEqual(mergeText("A {{Name}}", row, columns), "A {{Name}}", "merge: case-sensitive");
  assertEqual(mergeText("{{city}}", ["Ravi", ""], columns), "", "merge: empty value → empty string");
  assertEqual(mergeText("{{name}}", ["Ravi"], ["name", "name"]), "Ravi", "merge: first matching column wins");
  const shortRow = ["Ravi"];
  assertEqual(mergeText("{{city}}", shortRow, columns), "", "merge: missing row field → empty");

  const base: CardTexts = {
    to: "For: {{name}}",
    headline: "Greetings",
    sub: "from {{city}}",
    message: "Dear {{name}}, welcome to {{city}}!",
    venue: "{{city}}",
    from: "{{bogus}} and {{name}}",
  };
  const merged = mergedTextsFor(base, row, columns);
  assertEqual(merged.to, "For: Ravi", "mergedTextsFor: to merged");
  assertEqual(merged.sub, "from Pune", "mergedTextsFor: sub merged");
  assertEqual(merged.message, "Dear Ravi, welcome to Pune!", "mergedTextsFor: message merged");
  assertEqual(merged.from, "{{bogus}} and Ravi", "mergedTextsFor: unknown stays literal");
  assertEqual(mergedTextsFor(base, null, columns), base, "mergedTextsFor: null row → base texts");

  assertEqual(
    validatePlaceholders(base, columns),
    ["bogus"],
    "validate: collects the unknown column only"
  );
  const orderProbe: CardTexts = {
    to: "{{z}}",
    headline: "{{y}}",
    sub: "{{x}}",
    message: "{{z}} again",
    venue: "",
    from: "{{a}}",
  };
  assertEqual(
    validatePlaceholders(orderProbe, []),
    ["z", "y", "x", "a"],
    "validate: field order is stable + deduped (first appearance)"
  );
  assertEqual(validatePlaceholders(base, ["name", "city", "bogus"]), [], "validate: clean merge → empty list");

  /* ---- word wrap (fake measurer: width = codepoints × 10) ---- */
  const measure = (text: string): number => [...text].length * 10;
  assertEqual(wrapText("aa bb cc", 50, measure), ["aa bb", "cc"], "wrap: basic budget");
  assertEqual(wrapText("abcdefghij", 50, measure), ["abcde", "fghij"], "wrap: over-long word breaks char-wise");
  assertEqual(
    wrapText("aaaaaaaaaa bb", 50, measure),
    ["aaaaa", "aaaaa", "bb"],
    "wrap: char-broken word lets the next word start fresh"
  );
  assertEqual(wrapText("aa\nbb", 100, measure), ["aa", "bb"], "wrap: explicit \\n is a hard break");
  assertEqual(wrapText("aa   bb", 100, measure), ["aa bb"], "wrap: runs of spaces collapse");
  assertEqual(wrapText("   \n  ", 100, measure), [], "wrap: whitespace-only → zero lines");
  assertEqual(wrapText("", 100, measure), [], "wrap: empty string → zero lines");
  assertEqual(wrapText("aa\n\nbb", 100, measure), ["aa", "", "bb"], "wrap: blank paragraph between text kept");
  assertEqual(wrapText("\n\naa\n\n", 100, measure), ["aa"], "wrap: edge blank paragraphs dropped");
  assertEqual(
    wrapText("ढालूलंबीहिंदीपंक्ति", 100, measure),
    ["ढालूलंबीहि", "ंदीपंक्ति"],
    "wrap: Devanagari long word breaks by code point"
  );
  assertEqual(wrapText(123 as unknown as string, 100, measure), [], "wrap: non-string → zero lines");
  assertEqual(wrapText("aa bb", 0, measure), [], "wrap: zero width → zero lines");
  for (const [text, width] of [
    ["The quick brown fox jumps over the lazy dog", 70],
    ["supercalifragilisticexpialidocious-and-then-some-more", 120],
    ["a\nbb\ncccccccccccccccccccc\ndd", 60],
    ["हिंदी text मिलाकर wrap करो", 80],
  ] as [string, number][]) {
    const lines = wrapText(text, width, measure);
    assert(
      lines.every((line) => line === "" || measure(line) <= width),
      `wrap: no line over width (${text.slice(0, 18)}… @${width})`,
      lines.map((line) => `${line} (${measure(line)})`)
    );
  }

  /* ---- truncate with ellipsis (binary search) ---- */
  assertEqual(truncateWithEllipsis("abcdef", 100, measure), "abcdef…", "trunc: fits whole + …");
  assertEqual(truncateWithEllipsis("abcdefghij", 50, measure), "abcd…", "trunc: binary-search prefix");
  assertEqual(truncateWithEllipsis("", 50, measure), "", "trunc: empty → empty");
  assertEqual(truncateWithEllipsis("abcdef", 5, measure), "…", "trunc: nothing fits → bare ellipsis");

  /* ---- headline shrink-to-fit (fake measurer: cp × size × 0.5) ---- */
  const measureAt = (text: string, sizePt: number): number =>
    [...text].length * sizePt * 0.5;
  const fit = fitHeadline("x".repeat(30), {
    baseSizePt: 30,
    minSizePt: 14,
    stepPt: 2,
    maxWidthPt: 200,
    maxLines: 2,
    lineHeightRatio: 1.15,
    maxHeightPt: 100,
  }, measureAt);
  assertEqual(fit.sizePt, 26, "fitHeadline: FIRST size that fits (26)");
  assertEqual(fit.lines.length, 2, "fitHeadline: wrapped to 2 lines");
  assert(fit.overflowed === false, "fitHeadline: not overflowed");
  const unfit = fitHeadline("x".repeat(30), {
    baseSizePt: 30,
    minSizePt: 14,
    stepPt: 2,
    maxWidthPt: 200,
    maxLines: 1,
    lineHeightRatio: 1.15,
    maxHeightPt: 1000,
  }, measureAt);
  assert(unfit.overflowed === true, "fitHeadline: unsatisfiable flags overflow");
  assertEqual(unfit.sizePt, 14, "fitHeadline: keeps the minimum size");
  assert(unfit.lines.length >= 1, "fitHeadline: never truncates lines (all kept)");
  const terminator = fitHeadline("x".repeat(50), {
    baseSizePt: 5000,
    minSizePt: 1,
    stepPt: 1,
    maxWidthPt: 200,
    maxLines: 2,
    lineHeightRatio: 1.15,
    maxHeightPt: 100,
  }, measureAt);
  assert(terminator.sizePt >= 1, "fitHeadline: huge base terminates (iteration cap)");
  const emptyFit = fitHeadline("   ", {
    baseSizePt: 30,
    minSizePt: 14,
    stepPt: 2,
    maxWidthPt: 200,
    maxLines: 2,
    lineHeightRatio: 1.15,
    maxHeightPt: 100,
  }, measureAt);
  assertEqual(emptyFit.lines, [], "fitHeadline: blank text → no lines");
  assert(emptyFit.overflowed === false, "fitHeadline: blank text not overflowed");

  /* ---- message layout (fixed size + honest ellipsis) ---- */
  const measureMsg = (text: string, sizePt: number): number => [...text].length * sizePt;
  const msg = layoutMessage("aaaa bbbb cccc dddd", {
    fontPt: 10,
    lineHeightRatio: 2,
    maxWidthPt: 100,
    maxHeightPt: 45,
  }, measureMsg);
  assertEqual(msg.lines, ["aaaa bbbb", "cccc dddd"], "message: wraps at the fixed size");
  assert(msg.overflowed === false, "message: fits the height budget");
  const cut = layoutMessage("aaaa bbbb cccc dddd", {
    fontPt: 10,
    lineHeightRatio: 2,
    maxWidthPt: 100,
    maxHeightPt: 39,
  }, measureMsg);
  assertEqual(cut.lines.length, 1, "message: overflow keeps only the fitting lines");
  assert(cut.lines[0].endsWith("…"), "message: last kept line ends with an ellipsis", cut.lines[0]);
  assert(cut.overflowed === true, "message: overflow flagged");
  assertEqual(layoutMessage("  ", {
    fontPt: 10,
    lineHeightRatio: 2,
    maxWidthPt: 100,
    maxHeightPt: 40,
  }, measureMsg).lines, [], "message: blank → no lines");

  /* ---- wire option parser ---- */
  assertEqual(
    parseCardOption(undefined, 0).template,
    DEFAULT_TEMPLATE_ID,
    "option: missing → default template"
  );
  assertEqual(
    parseCardOption("nonsense{{{", 0).format,
    "flat-a6",
    "option: garbage JSON → defaults"
  );
  const clamped = parseCardOption(
    JSON.stringify({
      template: "nope",
      format: "a3",
      orientation: "diagonal",
      exportFormat: "gif",
      locale: "fr",
      background: "not-a-color",
      photoIndex: 99,
      texts: { headline: "x".repeat(500), to: "a\u0007b" },
      csvName: "bad\u001f" + "n".repeat(200),
    }),
    3
  );
  assert(clamped.template === DEFAULT_TEMPLATE_ID, "option: unknown template → default");
  assert(clamped.format === "flat-a6" && clamped.orientation === "portrait", "option: enum fallbacks");
  assert(clamped.exportFormat === "pdf" && clamped.locale === "en", "option: format/locale fallbacks");
  assert(clamped.background === "#ffffff", "option: invalid hex → white");
  assertEqual(clamped.photoIndex, 2, "option: photoIndex clamps into [0, fileCount)");
  assertEqual(parseCardOption("{}", 0).photoIndex, null, "option: no files → photoIndex null");
  assertEqual(
    parseCardOption(JSON.stringify({ photoIndex: -5 }), 3).photoIndex,
    0,
    "option: negative photoIndex clamps to 0"
  );
  assertEqual(
    clamped.texts.headline.length,
    TEXT_FIELD_LIMITS.headline,
    "option: headline clamped to its budget"
  );
  assertEqual(clamped.texts.to, "ab", "option: control characters stripped (\\n kept)");
  assert(clamped.csvName.length <= 120, "option: csvName clamped to 120", clamped.csvName.length);
  const bigCsv = parseCardOption(
    JSON.stringify({ csvText: "z".repeat(CSV_MAX_CHARS + 100) }),
    0
  );
  assertEqual(bigCsv.csvText.length, CSV_MAX_CHARS, "option: csvText capped at 2 MB chars");

  // Round trip: serialize → parse is lossless for valid data.
  const original = {
    ...DEFAULT_CARD_OPTION,
    texts: defaultTextsFor("holi", "hi"),
    csvText: "name\nरवि\nमीरा",
    photoIndex: null,
  };
  const round = parseCardOption(serializeCard(original), 0);
  assertEqual(round, original, "option: serialize → parse round trip is lossless");

  /* ---- output names ---- */
  assertEqual(outputBaseName("en", "pdf", 1), "card.pdf", "name: en single");
  assertEqual(outputBaseName("en", "pdf", 3), "cards.pdf", "name: en merge plural");
  assertEqual(outputBaseName("hi", "pdf", 1), "कार्ड.pdf", "name: hi single");
  assertEqual(outputBaseName("hi", "jpg", 5), "कार्ड.jpg", "name: hi jpg merge (कार्ड stays)");

  /* ---- cover crop (collage math) ---- */
  const crop = coverCrop(100, 100, 50, 100);
  assert(
    Math.abs(crop.sx - 25) < 1e-9 && Math.abs(crop.sw - 50) < 1e-9 && crop.sy === 0,
    "coverCrop: square → centered half-width crop",
    crop
  );
  assertEqual(
    coverCrop(0, 100, 50, 100),
    { sx: 0, sy: 0, sw: 0, sh: 0 },
    "coverCrop: degenerate source → zero rect"
  );

  assertEqual(CARD_FORMATS.length, 4, "4 card formats shipped");
}

/* ================================================================== */
/* Part 2 — the real worker (shimmed raster backend)                    */
/* ================================================================== */

/* ---- sharp-backed canvas shim (collage recipe + gradients) ---- */

type ShimOp =
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: unknown;
      tx: number;
      ty: number;
      rotDeg: number;
    }
  | {
      kind: "path";
      d: string;
      fill: unknown;
      tx: number;
      ty: number;
      rotDeg: number;
    }
  | {
      kind: "text";
      text: string;
      x: number;
      y: number;
      font: string;
      fill: unknown;
      align: string;
      baseline: string;
      tx: number;
      ty: number;
      rotDeg: number;
    }
  | {
      kind: "image";
      source: ShimBitmap | ShimCanvas;
      args: number[];
      tx: number;
      ty: number;
      rotDeg: number;
    };

interface ShimBitmap {
  width: number;
  height: number;
  _raw: Buffer;
  close(): void;
}

function isShimBitmap(source: ShimBitmap | ShimCanvas): source is ShimBitmap {
  return "_raw" in source;
}

/** SVG-safe colour string: gradients render as their first stop. */
function svgColorOf(fill: unknown): string {
  if (fill instanceof GradientFill) return fill.stops[0]?.color ?? "#000000";
  return typeof fill === "string" ? fill : "#000000";
}

class GradientFill {
  stops: { color: string }[] = [];
  addColorStop(_pos: number, color: string): void {
    this.stops.push({ color });
  }
}

function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 16;
}

function parseColor(fill: unknown): { r: number; g: number; b: number; alpha: number } {
  if (fill instanceof GradientFill) {
    const first = fill.stops[0]?.color ?? "#000000";
    return parseColor(first);
  }
  if (typeof fill !== "string") return { r: 0, g: 0, b: 0, alpha: 1 };
  const hex = /^#([0-9a-fA-F]{6})$/.exec(fill.trim());
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }
  const rgba = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\)/.exec(fill);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return { r: 0, g: 0, b: 0, alpha: 1 };
}

class ShimCtx {
  canvas: ShimCanvas;
  fillStyle: unknown = "#000000";
  strokeStyle: unknown = "#000000";
  lineWidth = 1;
  font = "16px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality: "high" | "low" | "medium" = "high";
  private stack: { tx: number; ty: number; rotDeg: number }[] = [];
  private state = { tx: 0, ty: 0, rotDeg: 0 };
  private path: string[] = [];

  constructor(canvas: ShimCanvas) {
    this.canvas = canvas;
  }

  save(): void {
    this.stack.push({ ...this.state });
  }

  restore(): void {
    const prev = this.stack.pop();
    if (prev) this.state = prev;
  }

  translate(x: number, y: number): void {
    this.state.tx += x;
    this.state.ty += y;
  }

  rotate(radians: number): void {
    this.state.rotDeg = (this.state.rotDeg + Math.round((radians * 180) / Math.PI)) % 360;
  }

  createLinearGradient(): GradientFill {
    return new GradientFill();
  }

  /* Path recording: fill() rasterizes the accumulated path as SVG
     (rounded-rect frames etc.); arcTo is approximated line+arc. */
  beginPath(): void {
    this.path = [];
  }

  moveTo(x: number, y: number): void {
    this.path.push(`M${x} ${y}`);
  }

  lineTo(x: number, y: number): void {
    this.path.push(`L${x} ${y}`);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.path.push(`L${x1} ${y1}`);
    this.path.push(`A${radius} ${radius} 0 0 1 ${x2} ${y2}`);
  }

  closePath(): void {
    this.path.push("Z");
  }

  clip(): void {
    // Rounded clips are cosmetic — pixel fidelity is QA'd in-browser.
    this.path = [];
  }

  fill(): void {
    if (this.path.length > 0) {
      this.canvas.ops.push({
        kind: "path",
        d: this.path.join(" "),
        fill: this.fillStyle,
        ...this.state,
      });
    }
    this.path = [];
  }

  stroke(): void {
    // Hairlines are cosmetic.
    this.path = [];
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.canvas.ops.push({
      kind: "rect",
      x,
      y,
      w,
      h,
      fill: this.fillStyle,
      ...this.state,
    });
  }

  fillText(text: string, x: number, y: number): void {
    this.canvas.ops.push({
      kind: "text",
      text,
      x,
      y,
      font: this.font,
      fill: this.fillStyle,
      align: this.textAlign,
      baseline: this.textBaseline,
      ...this.state,
    });
  }

  measureText(text: string): { width: number } {
    return { width: [...text].length * fontSizeOf(this.font) * 0.55 };
  }

  drawImage(source: ShimBitmap | ShimCanvas, ...args: number[]): void {
    this.canvas.ops.push({ kind: "image", source, args, ...this.state });
  }
}

const allCanvases: ShimCanvas[] = [];

class ShimCanvas {
  width: number;
  height: number;
  ops: ShimOp[] = [];
  private raw: Promise<Buffer> | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    allCanvases.push(this);
  }

  getContext(kind: string): ShimCtx | null {
    return kind === "2d" ? new ShimCtx(this) : null;
  }

  _ensureRaw(): Promise<Buffer> {
    if (!this.raw) this.raw = this._rasterize();
    return this.raw;
  }

  private async _rasterize(): Promise<Buffer> {
    let background = { r: 0, g: 0, b: 0, alpha: 0 };
    for (const op of this.ops) {
      if (
        op.kind === "rect" &&
        op.x === 0 && op.y === 0 &&
        Math.round(op.w) === this.width && Math.round(op.h) === this.height
      ) {
        background = parseColor(op.fill);
        break;
      }
    }
    const base = await sharp({
      create: {
        width: this.width,
        height: this.height,
        channels: 4,
        background,
      },
    })
      .raw()
      .toBuffer();

    const layers: sharp.OverlayOptions[] = [];
    for (const op of this.ops) {
      if (op.kind === "rect") {
        const svg = Buffer.from(
          `<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${Math.max(0, Math.round(op.x + op.tx))}" y="${Math.max(0, Math.round(op.y + op.ty))}" width="${Math.max(1, Math.round(op.w))}" height="${Math.max(1, Math.round(op.h))}" fill="${svgColorOf(op.fill)}" fill-opacity="${parseColor(op.fill).alpha}"/></svg>`
        );
        layers.push({ input: await sharp(svg).png().toBuffer() });
        continue;
      }
      if (op.kind === "path") {
        const svg = Buffer.from(
          `<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${op.tx} ${op.ty})"><path d="${op.d}" fill="${svgColorOf(op.fill)}" fill-opacity="${parseColor(op.fill).alpha}"/></g></svg>`
        );
        layers.push({ input: await sharp(svg).png().toBuffer() });
        continue;
      }
      if (op.kind === "text") {
        const size = fontSizeOf(op.font);
        const anchor =
          op.align === "center" ? "middle" : op.align === "right" || op.align === "end" ? "end" : "start";
        const dominant = op.baseline === "middle" ? "central" : "auto";
        const escaped = op.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const svg = Buffer.from(
          `<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg"><text x="${Math.max(0, Math.round(op.x + op.tx))}" y="${Math.max(0, Math.round(op.y + op.ty))}" font-family="sans-serif" font-size="${size}" fill="${svgColorOf(op.fill)}" text-anchor="${anchor}" dominant-baseline="${dominant}">${escaped}</text></svg>`
        );
        layers.push({ input: await sharp(svg).png().toBuffer() });
        continue;
      }
      // Image op — 9-arg cover-crop (the only form the card engine uses).
      const source = op.source;
      if (op.args.length < 5) continue;
      const sourceRaw = isShimBitmap(source) ? source._raw : await source._ensureRaw();
      const srcW = source.width;
      const srcH = source.height;
      const [sx, sy, sw, sh, dx, dy, dw, dh] = op.args;
      const region = await sharp(sourceRaw, {
        raw: { width: srcW, height: srcH, channels: 4 },
      })
        .extract({
          left: Math.max(0, Math.round(sx)),
          top: Math.max(0, Math.round(sy)),
          width: Math.max(1, Math.min(Math.round(sw), srcW - Math.max(0, Math.round(sx)))),
          height: Math.max(1, Math.min(Math.round(sh), srcH - Math.max(0, Math.round(sy)))),
        })
        .resize(Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)), { fit: "fill" })
        .png()
        .toBuffer();
      layers.push({ input: region, left: Math.round(dx + op.tx), top: Math.round(dy + op.ty) });
    }

    if (layers.length === 0) return base;
    return await sharp(base, {
      raw: { width: this.width, height: this.height, channels: 4 },
    })
      .composite(layers)
      .raw()
      .toBuffer();
  }

  async convertToBlob(options: { type: string; quality?: number }): Promise<Blob> {
    const raw = await this._ensureRaw();
    const pipeline = sharp(raw, {
      raw: { width: this.width, height: this.height, channels: 4 },
    });
    const bytes =
      options.type === "image/png"
        ? await pipeline.png().toBuffer()
        : await pipeline.jpeg({ quality: Math.round((options.quality ?? 0.92) * 100) }).toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: options.type });
  }
}

/* ---- global shims ---- */

type Posted = Record<string, unknown> & { type: string; runId: string };
const inbox: Posted[] = [];
const fetchCalls: string[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};

function installShims(): void {
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Posted);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    ShimCanvas as unknown as typeof OffscreenCanvas;
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (
    source: FakeFile | Blob | ShimCanvas
  ): Promise<ShimBitmap> => {
    if (source instanceof ShimCanvas) {
      const raw = await source._ensureRaw();
      return {
        width: source.width,
        height: source.height,
        _raw: raw,
        close(): void {
          /* no-op in the shim */
        },
      };
    }
    const bytes = Buffer.from(await source.arrayBuffer());
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      _raw: data,
      close(): void {
        /* no-op in the shim */
      },
    };
  };
  // fetch wrapper: resolve same-origin "/card-templates/…" onto the real
  // public/ directory (what the browser worker does via its origin).
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("/")) {
      fetchCalls.push(url);
      return realFetch(
        pathToFileURL(path.join(ROOT, "public", url.replace(/^\//, ""))).href,
        init
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

/* ---- fixtures + harness ---- */

class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "image/png") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
  slice(start: number, end: number): FakeFile {
    return new FakeFile(this.name, this.#bytes.slice(start, end), this.type);
  }
}

async function makePng(
  width: number,
  height: number,
  rgb: [number, number, number],
  label: string
): Promise<Uint8Array> {
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"/><text x="${width / 2}" y="${height / 2}" font-family="sans-serif" font-size="${Math.round(Math.min(width, height) / 6)}" fill="white" text-anchor="middle">${label}</text></svg>`
  );
  const bytes = await sharp(svg).png().toBuffer();
  return new Uint8Array(bytes);
}

interface RunOutcome {
  result: (Posted & { type: "result"; detail?: Record<string, unknown> }) | null;
  error: (Posted & { type: "error"; code?: string; detail?: string }) | null;
  outputs: { name: string; mime: string; blob: Blob }[];
  progress: number;
  canvasStart: number;
  canvasEnd: number;
}

async function runWorker(
  files: FakeFile[],
  options: Record<string, string | number | boolean>
): Promise<RunOutcome> {
  inbox.length = 0;
  const canvasStart = allCanvases.length;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files, options, assets: [] },
  });
  for (let i = 0; i < 5000; i += 1) {
    const terminal = inbox.find((m) => m.type === "result" || m.type === "error");
    if (terminal) {
      await new Promise((r) => setTimeout(r, 0));
      const result = (inbox.find((m) => m.type === "result") as RunOutcome["result"]) ?? null;
      const error = (inbox.find((m) => m.type === "error") as RunOutcome["error"]) ?? null;
      const outputs = (result?.outputs as RunOutcome["outputs"]) ?? [];
      return {
        result,
        error,
        outputs,
        progress: inbox.filter((m) => m.type === "progress").length,
        canvasStart,
        canvasEnd: allCanvases.length,
      };
    }
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("worker never posted a terminal message");
}

async function bytesOf(outcome: RunOutcome): Promise<Uint8Array> {
  if (!outcome.result) throw new Error("no result message");
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

/** Every DCTDecode image XObject, in object order. */
async function embeddedJpegs(pdfBytes: Uint8Array): Promise<Buffer[]> {
  const pdf = await PDFDocument.load(pdfBytes);
  const out: { num: number; bytes: Buffer }[] = [];
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const subtype = obj.dict.get(PDFName.of("Subtype"));
      const filter = obj.dict.get(PDFName.of("Filter"));
      if (String(subtype) === "/Image" && String(filter).includes("DCTDecode")) {
        out.push({ num: ref.objectNumber, bytes: Buffer.from(obj.contents) });
      }
    }
  }
  out.sort((a, b) => a.num - b.num);
  return out.map((entry) => entry.bytes);
}

function canvasTexts(canvas: ShimCanvas): string[] {
  return canvas.ops
    .filter((op): op is Extract<ShimOp, { kind: "text" }> => op.kind === "text")
    .map((op) => op.text);
}

async function pixelAt(
  jpeg: Buffer,
  x: number,
  y: number
): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(jpeg)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const index = (y * info.width + x) * channels;
  return { r: data[index], g: data[index + 1], b: data[index + 2] };
}

async function meanPixel(jpeg: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(jpeg)
    .resize(64, 64, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  const count = 64 * 64;
  for (let i = 0; i < count; i += 1) {
    r += data[i * info.channels];
    g += data[i * info.channels + 1];
    b += data[i * info.channels + 2];
  }
  return { r: r / count, g: g / count, b: b / count };
}

async function part2(): Promise<void> {
  installShims();
  await import("../tools/create-card/worker");
  const { clearBackdropCache } = await import("../tools/create-card/render");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const diwaliTexts = defaultTextsFor("diwali", "en");
  const photoFixture = new FakeFile("family.png", await makePng(320, 240, [200, 80, 40], "FAM"));

  /* ---- 1. flat A6 + diwali, no photo → 1-page PDF, real backdrop ---- */
  const run1 = await runWorker([], {
    card: serializeCard({
      template: "diwali",
      format: "flat-a6",
      orientation: "portrait",
      texts: diwaliTexts,
      photoIndex: null,
      background: "#ffffff",
      csvText: "",
      csvName: "",
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run1.error === null, "run 1: no error", run1.error);
  assert(run1.result !== null, "run 1: result posted");
  assert(run1.progress >= 2, "run 1: progress posted", run1.progress);
  assertEqual(run1.result?.detail?.pages, 1, "run 1: detail pages = 1");
  assertEqual(run1.outputs[0]?.name, "card.pdf", "run 1: output name card.pdf");

  const pdf1 = await bytesOf(run1);
  const head = Buffer.from(pdf1.slice(0, 5)).toString("latin1");
  const tail = Buffer.from(pdf1.slice(-32)).toString("latin1");
  assert(head.startsWith("%PDF-"), "run 1: PDF magic", head);
  assert(tail.trimEnd().endsWith("%%EOF"), "run 1: %%EOF", tail);

  const reopened1 = await PDFDocument.load(pdf1);
  assertEqual(reopened1.getPageCount(), 1, "run 1: single page");
  const page1 = reopened1.getPage(0);
  assert(
    Math.abs(page1.getWidth() - 105 * PT_PER_MM) < 0.05 &&
      Math.abs(page1.getHeight() - 148 * PT_PER_MM) < 0.05,
    "run 1: exact A6 portrait dims",
    { w: page1.getWidth(), h: page1.getHeight() }
  );
  const jpegs1 = await embeddedJpegs(pdf1);
  assertEqual(jpegs1.length, 1, "run 1: one JPEG XObject");
  assert(jpegs1[0][0] === 0xff && jpegs1[0][1] === 0xd8, "run 1: embedded bytes are real JPEG");
  assert(
    fetchCalls.includes("/card-templates/diwali.jpg"),
    "run 1: the real backdrop was fetched (same-origin)",
    fetchCalls
  );
  const bgPixel = await pixelAt(jpegs1[0], 4, 4);
  assert(
    bgPixel.r + bgPixel.g + bgPixel.b < 700,
    "run 1: backdrop painted (corner is not white)",
    bgPixel
  );

  /* ---- 2. fold-a4 + CSV merge 3 rows → 6 pages, rows in the right pairs ---- */
  const csv = "name,city\nRavi,Pune\nMeera,Delhi\nAditi,Agra";
  const mergeTexts: CardTexts = {
    ...diwaliTexts,
    to: "For: {{name}} of {{city}}",
    message: "Dear {{name}}, see you soon!",
  };
  const run2 = await runWorker([], {
    card: serializeCard({
      template: "wedding",
      format: "fold-a4",
      orientation: "portrait",
      texts: mergeTexts,
      photoIndex: null,
      background: "#ffffff",
      csvText: csv,
      csvName: "guests.csv",
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run2.error === null, "run 2: no error", run2.error);
  assertEqual(run2.result?.detail?.pages, 6, "run 2: detail pages = 6 (3 cards × 2 sides)");
  assertEqual(run2.outputs[0]?.name, "cards.pdf", "run 2: merge output name cards.pdf");
  const pdf2 = await bytesOf(run2);
  const reopened2 = await PDFDocument.load(pdf2);
  assertEqual(reopened2.getPageCount(), 6, "run 2: 6 pages in the PDF");
  for (let p = 0; p < 6; p += 1) {
    const page = reopened2.getPage(p);
    assert(
      Math.abs(page.getWidth() - 297 * PT_PER_MM) < 0.05 &&
        Math.abs(page.getHeight() - 210 * PT_PER_MM) < 0.05,
      `run 2: page ${p + 1} exact A4 landscape dims`,
      { w: page.getWidth(), h: page.getHeight() }
    );
  }
  const jpegs2 = await embeddedJpegs(pdf2);
  assertEqual(jpegs2.length, 6, "run 2: one JPEG XObject per page");
  // Sheet pairing: canvases are created in sheet order (outside, inside)×3.
  const run2Canvases = allCanvases.slice(run2.canvasStart, run2.canvasEnd);
  assertEqual(run2Canvases.length, 6, "run 2: 6 sheets rendered");
  const pairTexts = (index: number): string[] => canvasTexts(run2Canvases[index]);
  assert(
    pairTexts(0).some((text) => text.includes("Ravi")),
    "run 2: card 1 OUTSIDE carries row 1 (Ravi)"
  );
  assert(
    pairTexts(1).some((text) => text.includes("Dear Ravi")),
    "run 2: card 1 INSIDE carries the merged message (Dear Ravi)"
  );
  assert(
    pairTexts(2).some((text) => text.includes("Meera")) &&
      pairTexts(3).some((text) => text.includes("Dear Meera")),
    "run 2: card 2 pair carries Meera"
  );
  assert(
    pairTexts(4).some((text) => text.includes("Aditi")) &&
      pairTexts(5).some((text) => text.includes("Dear Aditi")),
    "run 2: card 3 pair carries Aditi"
  );
  assert(
    !pairTexts(0).some((text) => text.includes("Meera") || text.includes("Aditi")),
    "run 2: no row bleed between cards"
  );

  /* ---- 3. photo slot changes the pixels ---- */
  const noPhotoOption: CardOption = {
    template: "holi",
    format: "flat-a6",
    orientation: "portrait",
    texts: { ...defaultTextsFor("holi", "en") },
    photoIndex: null,
    background: "#ffffff",
    csvText: "",
    csvName: "",
    exportFormat: "pdf",
    locale: "en",
  };
  const run3a = await runWorker([], { card: serializeCard({ ...noPhotoOption }) });
  assert(run3a.error === null, "run 3a: no-photo run ok", run3a.error);
  const run3b = await runWorker([photoFixture], {
    card: serializeCard({ ...noPhotoOption, photoIndex: 0 }),
  });
  assert(run3b.error === null, "run 3b: photo run ok", run3b.error);
  const jpeg3a = (await embeddedJpegs(await bytesOf(run3a)))[0];
  const jpeg3b = (await embeddedJpegs(await bytesOf(run3b)))[0];
  const meanA = await meanPixel(jpeg3a);
  const meanB = await meanPixel(jpeg3b);
  const drift =
    Math.abs(meanA.r - meanB.r) + Math.abs(meanA.g - meanB.g) + Math.abs(meanA.b - meanB.b);
  assert(
    drift > 3,
    "run 3: the photo visibly changes the page (mean pixel drift)",
    { meanA, meanB, drift }
  );

  /* ---- 4. jpg + png quick formats + localized names ---- */
  const run4 = await runWorker([], {
    card: serializeCard({ ...noPhotoOption, exportFormat: "jpg", locale: "hi" }),
  });
  assert(run4.error === null, "run 4: jpg run ok", run4.error);
  assertEqual(run4.outputs[0]?.mime, "image/jpeg", "run 4: jpeg mime");
  assertEqual(run4.outputs[0]?.name, "कार्ड.jpg", "run 4: localized jpg name");
  const jpg = await bytesOf(run4);
  assert(jpg[0] === 0xff && jpg[1] === 0xd8, "run 4: JPEG magic FFD8");
  const jpgMeta = await sharp(Buffer.from(jpg)).metadata();
  assert(
    Math.abs((jpgMeta.width ?? 0) - 595) <= 1 && Math.abs((jpgMeta.height ?? 0) - 839) <= 1,
    "run 4: A6 pixel canvas size (2 px/pt)",
    { w: jpgMeta.width, h: jpgMeta.height }
  );

  const run5 = await runWorker([], {
    card: serializeCard({ ...noPhotoOption, exportFormat: "png" }),
  });
  assert(run5.error === null, "run 5: png run ok", run5.error);
  const png = await bytesOf(run5);
  assert(png[0] === 0x89 && png[1] === 0x50, "run 5: PNG magic 8950");
  assertEqual(run5.outputs[0]?.name, "card.png", "run 5: png output name");

  /* ---- 5. gradient fallback when the backdrop file is missing ---- */
  const diwaliDef = TEMPLATES.find((tpl) => tpl.id === "diwali");
  assert(diwaliDef !== undefined, "run 5 setup: diwali template found");
  const originalBg = diwaliDef!.bg;
  diwaliDef!.bg = "/card-templates/definitely-missing.jpg";
  clearBackdropCache();
  fetchCalls.length = 0;
  const run6 = await runWorker([], {
    card: serializeCard({
      ...noPhotoOption,
      template: "diwali",
      locale: "en",
      exportFormat: "pdf",
    }),
  });
  assert(run6.error === null, "run 6: missing backdrop does NOT kill the export", run6.error);
  assert(
    fetchCalls.includes("/card-templates/definitely-missing.jpg"),
    "run 6: the missing file was actually fetched",
    fetchCalls
  );
  const jpeg6 = (await embeddedJpegs(await bytesOf(run6)))[0];
  const corner6 = await pixelAt(jpeg6, 4, 4);
  // Gradient starts at palette[0] = #7c241c = (124, 36, 28).
  assert(
    Math.abs(corner6.r - 124) < 45 &&
      Math.abs(corner6.g - 36) < 45 &&
      Math.abs(corner6.b - 28) < 45,
    "run 6: gradient fallback painted (palette[0] at the corner)",
    corner6
  );
  assert(
    corner6.r + corner6.g + corner6.b < 700,
    "run 6: fallback is not white",
    corner6
  );
  diwaliDef!.bg = originalBg;
  clearBackdropCache();

  /* ---- 6. honest errors ---- */
  const run7 = await runWorker([], {
    card: serializeCard({
      ...noPhotoOption,
      csvText: "name\nRavi",
      texts: { ...noPhotoOption.texts, to: "{{who}} and {{wat}}" },
    }),
  });
  assertEqual(run7.error?.code, "card.errorCsvColumn", "run 7: unknown columns → card.errorCsvColumn");
  assert(
    (run7.error?.detail ?? "").includes("who") && (run7.error?.detail ?? "").includes("wat"),
    "run 7: the error lists every unknown column",
    run7.error?.detail
  );

  const manyRows = "name\n" + Array.from({ length: 201 }, (_, i) => `p${i}`).join("\n");
  const run8 = await runWorker([], {
    card: serializeCard({
      ...noPhotoOption,
      csvText: manyRows,
      texts: { ...noPhotoOption.texts, to: "{{name}}" },
    }),
  });
  assertEqual(run8.error?.code, "card.errorCsvRows", "run 8: 201 rows → card.errorCsvRows");

  const run9 = await runWorker([], {
    card: serializeCard({
      ...noPhotoOption,
      csvText: 'name\n"unterminated',
    }),
  });
  assertEqual(run9.error?.code, "card.errorCsvQuote", "run 9: unterminated quote → card.errorCsvQuote");

  /* ---- 7. garbage option JSON → defaults still export ---- */
  const run10 = await runWorker([photoFixture], { card: "nonsense{{{" });
  assert(run10.error === null, "run 10: garbage option still runs", run10.error);
  const pdf10 = await bytesOf(run10);
  const reopened10 = await PDFDocument.load(pdf10);
  assertEqual(reopened10.getPageCount(), 1, "run 10: default flat card = 1 page");
  const page10 = reopened10.getPage(0);
  assert(
    Math.abs(page10.getWidth() - 105 * PT_PER_MM) < 0.05,
    "run 10: default format A6 portrait",
    page10.getWidth()
  );

  /* ---- 8. blank template paints the user colour ---- */
  const run11 = await runWorker([], {
    card: serializeCard({
      ...noPhotoOption,
      template: "blank",
      background: "#3f6212",
    }),
  });
  assert(run11.error === null, "run 11: blank template run ok", run11.error);
  const jpeg11 = (await embeddedJpegs(await bytesOf(run11)))[0];
  const corner11 = await pixelAt(jpeg11, 4, 4);
  // #3f6212 = (63, 98, 18) — the flat panel fill starts at the exact colour.
  assert(
    Math.abs(corner11.r - 63) < 30 &&
      Math.abs(corner11.g - 98) < 30 &&
      Math.abs(corner11.b - 18) < 30,
    "run 11: blank background colour painted exactly",
    corner11
  );
}

async function main(): Promise<void> {
  part1();
  await part2();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
