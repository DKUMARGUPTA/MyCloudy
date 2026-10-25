/**
 * PRE-BUILD smoke test for Edit PDF P8.3 — existing-text editing
 * (whiteout + replace, font matching) + find & replace.
 *
 * Part 1 (model, pure): the font-matching table (subset prefixes,
 * standard-14 exactness, class fallbacks, Devanagari detection), piece
 * cover-rect math, the whiteout+retype builders for all rotations, line
 * grouping, find & replace planning (literal, case toggle, multiple
 * occurrences), substitution ranges, and the ink/background pixel pickers.
 *
 * Part 2 (worker, REAL module): a source page with known text at a known
 * baseline gets a replacement pair built from a simulated harvested piece;
 * the output is reloaded with pdf-lib and byte-audited (zlib-inflated
 * content): the cover fill `1 1 1 rg` draws BEFORE the retype hex Tj, the
 * retype lands at the ORIGINAL baseline (±2pt), and the original text
 * remains in the file (covered, not removed — the honest model).
 *
 * Run: bun scripts/smoke-edit-pdf-text.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { EditorObject, HarvestPiece, PageView, PieceLine } from "../tools/edit-pdf/model";

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

/** R6-a section helpers (message-first shapes, ocr-invoice smoke style). */
function check(message: string, ok: boolean): void {
  if (ok) pass(message);
  else fail(message);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  assertEqual(actual, expected, label);
}

/* ---- self shim: capture the worker's postMessage traffic ---- */
type Posted = Record<string, unknown> & { type: string; runId: string };
const inbox: Posted[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (msg: unknown): void => {
  inbox.push(msg as Posted);
};
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;

/* ---- fetch shim: serve the self-hosted Devanagari font ---- */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const url = typeof input === "string" ? input : String(input);
  if (url.endsWith("/fonts/NotoSansDevanagari-Regular.ttf")) {
    const bytes = readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "font/ttf" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

/* ---- tiny File stand-in ---- */
class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "application/pdf") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
}

interface RunOutcome {
  result: (Posted & { type: "result"; detail?: Record<string, unknown> }) | null;
  error: (Posted & { type: "error"; code?: string }) | null;
  outputs: { name: string; blob: { arrayBuffer(): Promise<ArrayBuffer> } }[];
}

async function runWorker(
  file: FakeFile,
  options: Record<string, string | number | boolean>
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files: [file], options, assets: [] },
  });
  for (let i = 0; i < 600; i += 1) {
    const terminal = inbox.find((m) => m.type === "result" || m.type === "error");
    if (terminal) {
      await new Promise((r) => setTimeout(r, 0));
      const result =
        (inbox.find((m) => m.type === "result") as RunOutcome["result"]) ?? null;
      const error =
        (inbox.find((m) => m.type === "error") as RunOutcome["error"]) ?? null;
      const outputs = (result?.outputs as RunOutcome["outputs"]) ?? [];
      return { result, error, outputs };
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("worker never posted a terminal message");
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function hexOf(text: string): string {
  return Buffer.from(text, "latin1").toString("hex").toUpperCase();
}

async function main(): Promise<void> {
  /* ---- Part 1: the pure model (P8.3 battery) ---- */
  const model = await import("../tools/edit-pdf/model");

  // --- Font matching table -------------------------------------------------
  let m = model.matchFont("Helvetica", {});
  assertEqual(
    { font: m.font, bold: m.bold, italic: m.italic, exact: m.exact },
    { font: "helvetica", bold: false, italic: false, exact: true },
    "match: Helvetica exact"
  );
  m = model.matchFont("Helvetica-Bold", {});
  assertEqual(
    { font: m.font, bold: m.bold, exact: m.exact },
    { font: "helvetica", bold: true, exact: true },
    "match: Helvetica-Bold exact+bold"
  );
  m = model.matchFont("ABCDEF+ArialMT", {});
  assertEqual(
    { font: m.font, exact: m.exact, original: m.original },
    { font: "helvetica", exact: false, original: "ABCDEF+ArialMT" },
    "match: subset Arial → closest helvetica"
  );
  m = model.matchFont("TimesNewRomanPSMT", {});
  assertEqual(
    { font: m.font, exact: m.exact },
    { font: "times", exact: false },
    "match: TimesNewRomanPSMT → closest times"
  );
  m = model.matchFont("Times-BoldItalic", {});
  assertEqual(
    { font: m.font, bold: m.bold, italic: m.italic, exact: m.exact },
    { font: "times", bold: true, italic: true, exact: true },
    "match: Times-BoldItalic standard-14 exact"
  );
  m = model.matchFont("CourierNewPS-BoldItalicMT", {});
  assertEqual(
    { font: m.font, bold: m.bold, italic: m.italic, exact: m.exact },
    { font: "courier", bold: true, italic: true, exact: false },
    "match: CourierNew subset → closest courier"
  );
  m = model.matchFont("BAAAAA+NotoSansDevanagari", { hasDeva: true });
  assertEqual(
    { font: m.font, exact: m.exact },
    { font: "devanagari", exact: true },
    "match: subset Noto Devanagari → exact"
  );
  m = model.matchFont("Mangal", { hasDeva: true });
  assertEqual(
    { font: m.font, exact: m.exact },
    { font: "devanagari", exact: false },
    "match: Mangal + Devanagari text → devanagari closest"
  );
  m = model.matchFont("Calibri", {});
  assertEqual(m.font, "helvetica", "match: Calibri → helvetica");
  m = model.matchFont("", { cssFamily: "monospace" });
  assertEqual(
    { font: m.font, exact: m.exact },
    { font: "courier", exact: false },
    "match: no name + mono css → courier"
  );
  m = model.matchFont("UnknownX", { mono: true });
  assertEqual(m.font, "courier", "match: unknown + mono flag → courier");
  m = model.matchFont("UnknownX", { serif: true });
  assertEqual(m.font, "times", "match: unknown + serif flag → times");
  m = model.matchFont("Helvetica-Bold", { bold: false });
  assertEqual(m.bold, false, "match: pdf.js bold flag overrides the name");
  m = model.matchFont("Helvetica", { bold: true });
  assertEqual(m.bold, true, "match: pdf.js bold flag true wins");
  m = model.matchFont("FancySerifFace", {});
  assertEqual(m.font, "times", "match: name contains serif → times");
  m = model.matchFont("FancySansFace", {});
  assertEqual(m.font, "helvetica", "match: name contains sans → helvetica");
  m = model.matchFont("NotoSansMono", {});
  assertEqual(m.font, "courier", "match: NotoSansMono → courier");

  // --- Piece cover rect ----------------------------------------------------
  const r1 = model.pieceRect({ x: 100, xEnd: 200, baseline: 300, h: 12 });
  assert(Math.abs(r1.y - (300 - 0.85 * 12 - 1.5)) < 1e-9, "pieceRect top");
  assert(Math.abs(r1.h - (1.1 * 12 + 3)) < 1e-9, "pieceRect height");
  assertEqual(r1.x, 99, "pieceRect x pad");
  assertEqual(r1.w, 102, "pieceRect width pad");
  const r2 = model.pieceRect({ x: 100, xEnd: 101, baseline: 300, h: 4 });
  assertEqual(r2.w, 8, "pieceRect min width");
  assertEqual(r2.h, 10, "pieceRect min height");

  // --- Replace builders (piece + line) --------------------------------------
  const piece: HarvestPiece = {
    index: 0,
    x: 100,
    xEnd: 200,
    baseline: 700,
    h: 12,
    str: "Hello",
    font: model.matchFont("Helvetica-Bold", {}),
  };
  const view0: PageView = { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 0 };
  const pair = model.buildReplacePieceObjects(0, view0, piece, "#f5f0e8", "#123456");
  assertEqual(pair.cover.kind, "whiteout", "builder cover kind");
  assertEqual(pair.cover.fill, "#f5f0e8", "builder cover fill = sampled bg");
  assertEqual(pair.text.kind, "text", "builder text kind");
  assertEqual(
    {
      text: pair.text.text,
      font: pair.text.font,
      size: pair.text.size,
      bold: pair.text.bold,
      color: pair.text.color,
      align: pair.text.align,
    },
    {
      text: "Hello",
      font: "helvetica",
      size: 12,
      bold: true,
      color: "#123456",
      align: "left",
    },
    "builder text carries the font match"
  );
  // rot0 geometry: display top = 700 - 11.7 → pdf y = 792 - 688.3 - 16.2
  assert(Math.abs(pair.cover.y - (792 - (700 - 0.85 * 12 - 1.5) - (1.1 * 12 + 3))) < 1e-6, "builder rot0 cover y");
  assertEqual(pair.cover.page, 0, "builder page");

  const view90: PageView = { x0: 20, y0: 10, x1: 632, y1: 802, rotate: 90 };
  const pair90 = model.buildReplacePieceObjects(3, view90, piece, "#ffffff", "#000000");
  // display rect {x:99, y:688.3, w:102, h:16.2} → user space via the 90° map.
  const expectX = 10 + 688.3; // x = dy + y0
  const expectY = 99 + 20 - 102 + 102; // min over corners → see below
  const c1 = { x: 688.3 + 20, y: 99 + 10 };
  const c2 = { x: 688.3 + 16.2 + 20, y: 99 + 102 + 10 };
  assert(
    Math.abs(pair90.cover.x - Math.min(c1.x, c2.x)) < 1e-6 &&
      Math.abs(pair90.cover.y - Math.min(c1.y, c2.y)) < 1e-6,
    "builder rot90 cover origin",
    { got: { x: pair90.cover.x, y: pair90.cover.y }, c1, c2 }
  );
  assert(
    Math.abs(pair90.cover.w - Math.abs(c1.x - c2.x)) < 1e-6 &&
      Math.abs(pair90.cover.h - Math.abs(c1.y - c2.y)) < 1e-6,
    "builder rot90 cover size",
    { got: { w: pair90.cover.w, h: pair90.cover.h } }
  );
  void expectX;
  void expectY;
  assertEqual(pair90.cover.page, 3, "builder page passthrough");

  // The builders' output survives the wire sanitizer.
  const sanitizedPair = model.sanitizeObjects(
    [pair.cover, pair.text, pair90.cover],
    4,
    new Set<string>()
  );
  assertEqual(sanitizedPair.length, 3, "builder output passes sanitizer");

  // --- Line grouping ---------------------------------------------------------
  const pagePieces: HarvestPiece[] = [
    { index: 0, x: 58, xEnd: 120, baseline: 100, h: 10, str: "world", font: model.matchFont("Helvetica", {}) },
    { index: 1, x: 10, xEnd: 50, baseline: 100, h: 10, str: "Hello", font: model.matchFont("Helvetica", {}) },
    { index: 2, x: 10, xEnd: 60, baseline: 200, h: 10, str: "Second line", font: model.matchFont("Helvetica", {}) },
    { index: 3, x: 300, xEnd: 400, baseline: 100, h: 10, str: "far", font: model.matchFont("Helvetica", {}) },
    { index: 4, x: 12, xEnd: 22, baseline: 104, h: 10, str: "x", font: model.matchFont("Helvetica", {}) },
  ];
  const lines = model.groupPiecesIntoLines(0, pagePieces);
  // x-sorted: [1](10-50), [0](58-120) gap 8 ≤ 12 → one line; [4] baseline 104
  // within 4.5 of 100 joins too; [3] far → own line; [2] own line.
  assertEqual(lines.length, 3, "line grouping count");
  assertEqual(lines[0].text, "Hello x world", "line text joined in x order with spaces");
  assertEqual(lines[0].pieces.sort((a, b) => a - b), [1, 0, 4].sort((a, b) => a - b), "line piece indices");
  assertEqual(lines[0].page, 0, "line page stamp");

  // --- Find & replace planning -------------------------------------------------
  const flines: PieceLine[] = [
    {
      page: 0,
      pieces: [0],
      text: "Cat hat mat",
      x: 0,
      xEnd: 60,
      baseline: 100,
      h: 10,
    },
    {
      page: 1,
      pieces: [1],
      text: "hat Hat HAT",
      x: 0,
      xEnd: 60,
      baseline: 100,
      h: 10,
    },
  ];
  const matches = model.planLineReplacements(flines, "hat", false);
  assertEqual(matches.length, 4, "fr: case-insensitive occurrences");
  assertEqual(
    matches.map((x) => `${x.page}:${x.line}:${x.start}`).join(","),
    "0:0:4,1:1:0,1:1:4,1:1:8",
    "fr: occurrence offsets"
  );
  const cased = model.planLineReplacements(flines, "hat", true);
  assertEqual(cased.length, 2, "fr: matchCase narrows");
  assertEqual(model.planLineReplacements(flines, "", false).length, 0, "fr: empty query");

  // --- Substitution ---------------------------------------------------------
  assertEqual(
    model.substituteOccurrences("Cat hat mat", [{ start: 4, end: 7 }], "log"),
    "Cat log mat",
    "substitute: single"
  );
  assertEqual(
    model.substituteOccurrences("Cat hat mat", [{ start: 0, end: 3 }, { start: 8, end: 11 }], "X"),
    "X hat X",
    "substitute: multiple"
  );
  assertEqual(
    model.substituteOccurrences("Cat hat mat", [], "X"),
    "Cat hat mat",
    "substitute: no ranges unchanged"
  );
  assertEqual(
    model.substituteOccurrences("aaaa", [{ start: 0, end: 3 }, { start: 1, end: 4 }], "b"),
    "ba",
    "substitute: overlapping ranges guarded"
  );
  assertEqual(
    model.substituteOccurrences("a.c", [{ start: 0, end: 1 }], "$&.*[x]"),
    "$&.*[x].c",
    "substitute: literal (regex metacharacters safe)"
  );

  // --- Line builder ---------------------------------------------------------
  const twoPieceLine: PieceLine = {
    page: 1,
    pieces: [0, 1],
    text: "Hello world",
    x: 10,
    xEnd: 120,
    baseline: 100,
    h: 10,
  };
  const linePagePieces: HarvestPiece[] = [
    { index: 0, x: 10, xEnd: 50, baseline: 100, h: 10, str: "Hello", font: model.matchFont("Helvetica", {}) },
    { index: 1, x: 58, xEnd: 120, baseline: 100, h: 14, str: "world", font: model.matchFont("Times-Bold", {}) },
  ];
  const linePair = model.buildReplaceLineObjects(
    1,
    view0,
    twoPieceLine,
    linePagePieces,
    "Hello friend",
    "#ffffff",
    "#111111"
  );
  assertEqual(linePair.text.text, "Hello friend", "line builder substituted text");
  assertEqual(
    { font: linePair.text.font, size: linePair.text.size, bold: linePair.text.bold },
    { font: "times", size: 14, bold: true },
    "line builder dominant font (largest em)"
  );
  assertEqual(linePair.cover.page, 1, "line builder page");
  // Union cover: x 9 → 121 (piece pads), y from pieceRect tops.
  assert(Math.abs(linePair.cover.x - 9) < 1e-6, "line builder cover union x");

  // --- Ink / background pickers ----------------------------------------------
  const white = [255, 255, 255, 255];
  const black = [17, 24, 39, 255];
  const pixels = [
    ...white, ...white, ...white, ...white, ...white, ...white,
    ...black, ...black, ...black, ...black,
  ];
  const ink = model.pickInkFromPixels(pixels, 1);
  assert(ink !== null && Math.abs(ink.r - 17) < 2, "ink: dark cluster on light bg", ink);
  const inkDark = model.pickInkFromPixels(
    [...black, ...black, ...black, ...black, ...black, ...white, ...white],
    0.05
  );
  assert(
    inkDark !== null && Math.abs(inkDark.r - 255) < 2,
    "ink: bright cluster on dark bg",
    inkDark
  );
  assert(
    model.pickInkFromPixels([...white, ...white, ...white, ...white], 1) === null,
    "ink: weak contrast → null"
  );
  assert(
    model.pickInkFromPixels([...white, ...black], 1) === null,
    "ink: too few pixels → null"
  );
  const med = model.medianRgb([
    ...[10, 20, 30, 255], ...[10, 20, 30, 255], ...[200, 210, 220, 255],
    ...[10, 20, 30, 255], ...[10, 20, 30, 255],
  ]);
  assertEqual(med, { r: 10, g: 20, b: 30 }, "median: majority channel wins");
  assertEqual(model.rgbToHex(17, 24, 39), "#111827", "rgbToHex");
  assert(Math.abs(model.luminance(255, 255, 255) - 1) < 1e-9, "luminance white");
  assert(Math.abs(model.luminance(0, 0, 0)) < 1e-9, "luminance black");

  /* ---- Part 2: the worker (real module) — replacement e2e ---- */
  await import("../tools/edit-pdf/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  // Source: one page, "Original Alpha Beta" at (48, 760), Helvetica 14.
  const src = await PDFDocument.create();
  const srcFont = await src.embedFont(StandardFonts.Helvetica);
  const srcPage = src.addPage([595.28, 841.89]);
  srcPage.drawText("Original Alpha Beta", {
    x: 48,
    y: 760,
    size: 14,
    font: srcFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  const source = new FakeFile("letter.pdf", await src.save());

  // Simulated harvest of that draw: baseline display y = 841.89 - 760,
  // advance ≈ widthOfTextAtSize("Original Alpha Beta", 14).
  const originalText = "Original Alpha Beta";
  const adv = srcFont.widthOfTextAtSize(originalText, 14);
  const harvested: HarvestPiece = {
    index: 0,
    x: 48,
    xEnd: 48 + adv,
    baseline: 841.89 - 760,
    h: 14,
    str: originalText,
    font: model.matchFont("Helvetica", {}),
  };
  const e2eView: PageView = { x0: 0, y0: 0, x1: 595.28, y1: 841.89, rotate: 0 };
  const e2ePair = model.buildReplacePieceObjects(0, e2eView, harvested, "#ffffff", "#111827");
  // The user edits the retyped words:
  const replacedText = { ...e2ePair.text, text: "Retyped words" };
  const e2eObjects: EditorObject[] = [e2ePair.cover, replacedText];

  const outcome = await runWorker(source, {
    ekey: "f1",
    "e:f1": JSON.stringify({
      objects: e2eObjects,
      pageViews: [e2eView],
      assetOrder: [],
    }),
  });
  assert(outcome.error === null, "e2e: no error", outcome.error);
  assert(outcome.result !== null, "e2e: result posted");
  if (outcome.result) {
    assertEqual(outcome.result.detail?.objects, 2, "e2e: cover + text drawn");
    assertEqual(outcome.result.detail?.pages, 1, "e2e: page count kept");
    assert(outcome.outputs[0].name === "letter-edited.pdf", "e2e: output name");
  }

  const outBytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  const reloaded = await PDFDocument.load(outBytes, { throwOnInvalidObject: false });
  assertEqual(reloaded.getPageCount(), 1, "e2e: single page");

  // Inflate the page content stream(s).
  const page = reloaded.getPages()[0];
  const contents = page.node.Contents();
  const streams: PDFRawStream[] =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => page.doc.context.lookup(r) as PDFRawStream)
      : [contents as unknown as PDFRawStream];
  let text0 = "";
  for (const stream of streams) {
    try {
      text0 += latin1(inflateSync(stream.contents));
    } catch {
      text0 += latin1(stream.contents);
    }
  }

  const originalHex = hexOf(originalText);
  const retypeHex = hexOf("Retyped words");
  assert(text0.includes(originalHex), "e2e: original text still present (covered, not removed)");
  assert(text0.includes(retypeHex), "e2e: retype text drawn");

  // The white cover must draw BEFORE the retype (z-order = array order).
  const coverIdx = text0.indexOf("1 1 1 rg");
  const retypeIdx = text0.indexOf(retypeHex);
  assert(coverIdx >= 0, "e2e: white cover fill op present");
  assert(coverIdx < retypeIdx, "e2e: cover draws before the retype", { coverIdx, retypeIdx });

  // The retype lands at the ORIGINAL baseline (±2pt): inspect the Tm right
  // before the retype hex (the window may end with the "<" opener).
  const before = text0.slice(Math.max(0, retypeIdx - 200), retypeIdx);
  const tmHits = before.match(/-?[\d.]+ -?[\d.]+ Tm/g);
  assert(tmHits !== null && tmHits.length > 0, "e2e: text matrix found before the retype", before.slice(-80));
  if (tmHits) {
    const nums = tmHits[tmHits.length - 1].split(" ");
    const y = Number(nums[1]);
    assert(Math.abs(y - 760) <= 2, "e2e: retype baseline ≈ original", { y, want: 760 });
    const x = Number(nums[0]);
    assert(Math.abs(x - (48 + 3)) <= 2, "e2e: retype x ≈ original + pad", { x });
  }

  /* ---- Part 3 (R6-a): Edit Text first-class — model + wiring locks ---- */
  // FONT_OPTIONS ids (order locked — the export z-order and the floating
  // bar's select both follow it) + the floating mini-toolbar + mobile
  // promotion + OCR hand-off, as regex locks on the real sources.
  const R6_KEYS = [
    "toolEditTextShort",
    "editBarLabel",
    "sizeDecrease",
    "sizeIncrease",
    "hintEditReady",
    "noTextOcrCta",
    "ocrHandoffToast",
    "firstHint",
  ] as const;

  // --- Model: FONT_OPTIONS ids + size caps ---------------------------------
  assertEqual(
    model.FONT_OPTIONS.map((f) => f.id),
    ["helvetica", "times", "courier", "devanagari"],
    "r6: FONT_OPTIONS ids incl. devanagari (order locked)"
  );
  assertEqual(
    (model.sanitizeObject(
      { ...model.makeText(0, { x: 0, y: 0, w: 40, h: 20 }), size: 999 },
      1,
      new Set()
    ) as unknown as { size: number }).size,
    200,
    "r6: text size clamps to 200 (floating bar stepper obeys the same cap)"
  );
  assertEqual(
    (model.sanitizeObject(
      { ...model.makeText(0, { x: 0, y: 0, w: 40, h: 20 }), size: 1 },
      1,
      new Set()
    ) as unknown as { size: number }).size,
    4,
    "r6: text size clamps to 4"
  );

  const read = (rel: string): string => readFileSync(rel, "utf8");
  const parts = read("tools/edit-pdf/editor-parts.tsx");
  const surfaceSrc = read("tools/edit-pdf/surface.tsx");

  // --- Mobile toolbar promotion --------------------------------------------
  const mobileBlock = parts.match(/const MOBILE_TOOLS[\s\S]*?\n\];/)?.[0] ?? "";
  assert(
    /const MOBILE_TOOLS/.test(parts) && mobileBlock.includes('id: "edittext"'),
    "r6: MOBILE_TOOLS contains edittext (promoted out of the More sheet)"
  );
  assertEqual(
    (mobileBlock.match(/id: "(?:select|edittext|text|draw|sign|image)"/g) ?? []).map(
      (s) => s.slice(5, -1)
    ),
    ["select", "edittext", "text", "draw", "sign", "image"],
    "r6: MOBILE_TOOLS order = select, edittext, text, draw, sign, image"
  );
  assert(
    mobileBlock.includes("editPdf.toolEditTextShort"),
    "r6: edittext mobile entry uses the compact short label"
  );
  const moreBlock = parts.match(/const MORE_TOOLS[\s\S]*?\n\];/)?.[0] ?? "";
  assert(
    moreBlock.length > 0 && !moreBlock.includes('id: "edittext"'),
    "r6: MORE_TOOLS no longer duplicates edittext"
  );
  // 6 buttons × 44px + 5 gaps × 4px + 2 × 6px padding fits a 360px screen.
  assert(
    (mobileBlock.match(/id: "/g) ?? []).length === 6,
    "r6: MOBILE_TOOLS has exactly 6 entries (360px fit: 6×44 + gaps + padding = 308px)"
  );

  // --- Floating mini-toolbar (TextEditBar) ----------------------------------
  const barStart = parts.indexOf("// Floating text-edit mini-toolbar");
  const barEnd = parts.indexOf("export function FindReplaceDialog");
  const barBlock = barStart >= 0 && barEnd > barStart
    ? parts.slice(barStart, barEnd)
    : "";
  assert(barBlock.length > 0, "r6: TextEditBar component exists");
  assert(
    /pointer-events-none absolute inset-x-0 z-40/.test(barBlock) &&
      /pointer-events-auto/.test(barBlock),
    "r6: bar wrapper is pointer-events-none (canvas gestures pass), bar itself clickable"
  );
  assert(
    /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/.test(barBlock),
    "r6: bar stops pointer propagation (overlay marquee/deselect never fires from a bar tap)"
  );
  assert(
    /<SelectTrigger[\s\S]*?aria-label=\{t\("editPdf\.font"\)\}/.test(barBlock) &&
      /FONT_OPTIONS\.map/.test(barBlock) &&
      /onValueChange=\{\(v\) => onPatch\(\{ font: v as TextObj\["font"\] \}\)\}/.test(barBlock),
    "r6: bar font select = same FONT_OPTIONS + same onPatch path as the sidebar"
  );
  assert(
    /size: clampSize\(obj\.size - 1\)/.test(barBlock) &&
      /size: clampSize\(obj\.size \+ 1\)/.test(barBlock) &&
      /clampN\(Math\.round\(n\), 4, 200\)/.test(barBlock) &&
      /type="number"/.test(barBlock),
    "r6: bar size stepper (− / numeric / +) clamps to the 4..200 caps"
  );
  assert(
    /BAR_SWATCHES\.map/.test(barBlock) &&
      /onPatch\(\{ color: hex \}\)/.test(barBlock) &&
      /type="color"/.test(barBlock),
    "r6: bar colour swatch popover (8 presets + custom picker) patches color"
  );
  assert(
    /onPatch\(\{ bold: !obj\.bold \}\)/.test(barBlock) &&
      /aria-pressed=\{obj\.bold\}/.test(barBlock),
    "r6: bar bold toggle patches bold"
  );
  assert(
    /const ALIGN_CYCLE/.test(barBlock) &&
      /onPatch\(\{ align: ALIGN_CYCLE\[obj\.align\] \}\)/.test(barBlock) &&
      /left: "center"/.test(barBlock) &&
      /center: "right"/.test(barBlock) &&
      /right: "left"/.test(barBlock),
    "r6: bar alignment cycles left → center → right"
  );
  assert(
    /aria-label=\{t\("editPdf\.delete"\)\}/.test(barBlock) &&
      /onClick=\{onDelete\}/.test(barBlock),
    "r6: bar delete button present (undoable, same semantics as the sidebar)"
  );
  assert(
    /aria-label=\{t\("editPdf\.sizeDecrease"\)\}/.test(barBlock) &&
      /aria-label=\{t\("editPdf\.sizeIncrease"\)\}/.test(barBlock) &&
      /aria-label=\{t\("editPdf\.editBarLabel"\)\}/.test(barBlock),
    "r6: bar aria-labels come from i18n (editBarLabel + size steppers)"
  );
  assert(
    /pointer-coarse:size-11/.test(barBlock),
    "r6: bar touch targets are 44px on coarse pointers"
  );
  // R6-a geometry guarantees: single row (no wrap → stable height) with
  // horizontal overflow on narrow pages, and the flip-below anchor fed by
  // the inline textarea's LIVE measured height (wrapping grows it past the
  // object rect — a rect-only anchor covered the second line on phones).
  assert(
    /flex-nowrap/.test(barBlock) &&
      /overflow-x-auto/.test(barBlock) &&
      !/flex-wrap/.test(barBlock),
    "r6: bar stays one row (nowrap + horizontal scroll — no 2-row wrap)"
  );
  assert(
    /editBoxRef\?: React\.RefObject<HTMLTextAreaElement \| null>/.test(barBlock) &&
      /ResizeObserver\(measure\)/.test(barBlock) &&
      /liveBottomPt = rect\.y \+ Math\.max\(rect\.h, liveH \/ safeScale\)/.test(barBlock) &&
      /const above = fitsAbove \|\| !fitsBelow/.test(barBlock),
    "r6: bar flip-below anchor uses the textarea's live height (never covers the caret)"
  );
  assert(
    /editBoxRef=\{textAreaRef\}/.test(surfaceSrc),
    "r6: surface hands the real textarea ref to the bar (live measurement)"
  );
  // R6-c hardening: the observer must survive a textarea NODE REPLACEMENT
  // (React re-created the node while the bar stayed mounted — the old
  // observer went silent and liveH froze at a stale height). The bar now
  // re-syncs the observed element every frame it is mounted.
  assert(
    /el !== observed/.test(barBlock) &&
      /requestAnimationFrame\(tick\)/.test(barBlock) &&
      /observer\?\.disconnect\(\)/.test(barBlock),
    "r6c: bar re-syncs the observed textarea element per frame (node-replacement proof)"
  );
  // R6-c hardening: the editing textarea auto-grows with its content — a
  // plain textarea kept its default 2-row height and spilled text below
  // the white box (and fed the anchor a stale height).
  assert(
    /el\.style\.height = "auto"/.test(surfaceSrc) &&
      /el\.style\.height = `\$\{el\.scrollHeight\}px`/.test(surfaceSrc) &&
      /\[editingId, objects, renderScale\]/.test(surfaceSrc),
    "r6c: editing textarea auto-grows with content (height auto → scrollHeight)"
  );

  // --- Surface wiring (same state, no fork) ---------------------------------
  assert(
    /\n  TextEditBar,/.test(surfaceSrc) && /<TextEditBar/.test(surfaceSrc),
    "r6: surface imports and renders TextEditBar"
  );
  assert(
    /onPatch=\{\(patch\) => patchObject\(editing\.id, patch\)\}/.test(surfaceSrc) &&
      /onDelete=\{\(\) => removeObject\(editing\.id\)\}/.test(surfaceSrc),
    "r6: bar handlers = the same patchObject/removeObject path as the sidebar"
  );
  assert(
    /editing\.kind === "text" \? \(\(\) => \{/.test(surfaceSrc) &&
      /<TextEditBar[\s\S]*?obj=\{editing\}/.test(surfaceSrc),
    "r6: bar only renders while a text object is being inline-edited"
  );
  assert(
    /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}[\s\S]{0,400}spellCheck=\{false\}/.test(
      surfaceSrc
    ),
    "r6: inline textarea stops pointer propagation (taps inside keep the edit alive)"
  );

  // --- edittext mode hint chip + empty-state OCR CTA ------------------------
  assert(
    /tool === "edittext" && piecesState === "ready" && !editHintDismissed/.test(
      surfaceSrc
    ) &&
      /t\("editPdf\.hintEditReady"\)/.test(surfaceSrc) &&
      /setEditHintDismissed\(true\)/.test(surfaceSrc),
    "r6: ready-state hint chip is dismissible and i18n-fed"
  );
  assert(
    /tool === "edittext" && piecesState === "empty"/.test(surfaceSrc) &&
      /onClick=\{handOffToOcr\}/.test(surfaceSrc) &&
      /t\("editPdf\.noTextOcrCta"\)/.test(surfaceSrc),
    "r6: empty state (scan) carries the Run-OCR-first primary CTA"
  );
  assert(
    /import \{ setChainHandoff \} from "@\/lib\/tools\/chain";/.test(surfaceSrc) &&
      /setChainHandoff\(\{/.test(surfaceSrc) &&
      /fromToolId: "edit-pdf"/.test(surfaceSrc) &&
      /navigateToHash\(ROUTES\.tool\("ocr-pdf"\)\)/.test(surfaceSrc),
    "r6: CTA hands the File to ocr-pdf via the real chain bridge (no fake handoff)"
  );
  assert(
    /t\("editPdf\.ocrHandoffToast"\)/.test(surfaceSrc),
    "r6: hand-off tells the user honestly where the file went"
  );

  // --- One-time first-open hint (D) ------------------------------------------
  assert(
    /FIRST_HINT_KEY = "dp_editpdf_first_hint_v1"/.test(surfaceSrc) &&
      /t\("editPdf\.firstHint"\)/.test(surfaceSrc) &&
      /onClick=\{dismissFirstHint\}/.test(surfaceSrc),
    "r6: one-time Edit-text discoverability hint (localStorage flag)"
  );

  // --- i18n: 8 new keys in all 4 places (central en/hi + mirror en/hi) ------
  const catEn = JSON.parse(read("src/i18n/en.json")) as {
    editPdf: Record<string, string>;
  };
  const catHi = JSON.parse(read("src/i18n/hi.json")) as { editPdf: Record<string, string> };
  const mirror = JSON.parse(read("tools/edit-pdf/i18n.json")) as {
    en: { editPdf: Record<string, string> };
    hi: { editPdf: Record<string, string> };
  };
  for (const key of R6_KEYS) {
    eq(
      `editPdf.${key} EN mirror byte-equal to central`,
      mirror.en.editPdf[key],
      catEn.editPdf[key]
    );
    eq(
      `editPdf.${key} HI mirror byte-equal to central`,
      mirror.hi.editPdf[key],
      catHi.editPdf[key]
    );
    check(
      `editPdf.${key} HI is a real Hindi translation`,
      /[\u0900-\u097F]/.test(String(catHi.editPdf[key])) &&
        catHi.editPdf[key] !== catEn.editPdf[key]
    );
  }
  eq(
    "editPdf.noTextOcrCta EN pinned",
    catEn.editPdf.noTextOcrCta,
    "Run OCR first"
  );
  eq(
    "editPdf.toolEditTextShort EN pinned",
    catEn.editPdf.toolEditTextShort,
    "Edit text"
  );
  // Whole-catalog leaf parity — both sides grew by ≥ 8 (4366 + 8); no exact
  // pin so parallel rounds adding other tools' keys cannot false-fail this.
  function leaves6(d: unknown): number {
    let n = 0;
    for (const v of Object.values(d as Record<string, unknown>)) {
      n += typeof v === "object" && v !== null ? leaves6(v) : 1;
    }
    return n;
  }
  const enLeaves6 = leaves6(JSON.parse(read("src/i18n/en.json")));
  const hiLeaves6 = leaves6(JSON.parse(read("src/i18n/hi.json")));
  assert(
    enLeaves6 === hiLeaves6 && enLeaves6 >= 4374,
    `r6: central catalogs leaf parity ${enLeaves6} = ${hiLeaves6} (≥ 4366 + 8 new)`
  );

  /* ---- summary ---- */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
