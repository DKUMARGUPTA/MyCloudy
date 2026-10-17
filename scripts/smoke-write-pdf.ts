/**
 * PRE-BUILD smoke test for Write PDF (60th tool, PRD §8 "Write PDF").
 *
 * Part 1 (model, pure): the sanitizer's clamps/drops, script detection,
 * word counting, asset ordering, output naming, and the pagination
 * engine with a deterministic monospace measure — page breaks, empty
 * paragraphs, quote bars, list markers, table row splitting + borders,
 * image clamping, keep-with-next headings, underlines and the
 * header/footer/{page} stamping.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim (+ a fetch shim serving the self-hosted
 * Devanagari TTF from public/). Full battery: mixed doc (headings,
 * bold/underline runs, Devanagari paragraph, lists, quote, table, image,
 * page break, header/footer/page numbers) → output reloaded with
 * pdf-lib: page count, page size, text Tj ops, embedded image XObject,
 * Type0 font for the Devanagari subset, detail counts — plus the honest
 * error codes (empty doc, corrupt JSON, missing image asset).
 *
 * Run: bun scripts/smoke-write-pdf.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";

import {
  W_PAGE_SIZES,
  assetOrderOf,
  countWords,
  docNeedNoto,
  layoutDoc,
  sanitizeWDoc,
  wOutputName,
  type WBlock,
  type WDoc,
} from "../tools/write-pdf/model";
import { buildTemplate } from "../tools/write-pdf/templates";

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

/* ------------------------------------------------------------------ */
/* Part 1 — pure model                                                 */
/* ------------------------------------------------------------------ */

/** Deterministic measure: every glyph = size × 0.5pt, spaces too. */
const monoMeasure = (
  text: string,
  _spec: { family: string; bold: boolean; italic: boolean },
  size: number
): number => text.length * size * 0.5;

function textBlock(
  kind: WBlock extends never ? never : string,
  text: string,
  extra: Record<string, unknown> = {}
): WBlock {
  return {
    id: `b${Math.random().toString(36).slice(2, 8)}`,
    kind,
    runs: text.length === 0 ? [] : [{ text }],
    align: "left",
    family: "sans",
    ...extra,
  } as WBlock;
}

function makeDoc(blocks: WBlock[], overrides: Record<string, unknown> = {}): WDoc {
  return {
    title: "Test doc",
    setup: {
      pageSize: "a4",
      landscape: false,
      margins: "normal",
      headerText: "",
      footerText: "",
      pageNumbers: "none",
      pageNumFormat: "n",
      dateText: "17/10/2026",
    },
    blocks,
    ...overrides,
  } as WDoc;
}

const A4 = W_PAGE_SIZES.a4;

// ---- sanitizer ----
{
  const garbage = {
    title: "  My  Doc \u0000  ",
    setup: { pageSize: "bogus", margins: "huge", pageNumbers: "diagonal" },
    blocks: [
      { id: "a", kind: "p", runs: [{ text: "hello", color: "red" }], align: "sideways", family: "comic" },
      { id: "b", kind: "laser" },
      { id: "c", kind: "table", rows: [["a"], ["b"], ["c"]] },
      { id: "d", kind: "image", assetKey: "" },
      { id: "e", kind: "hr" },
    ],
  };
  const { doc, dropped } = sanitizeWDoc(garbage);
  assertEqual(doc.title, "My Doc", "sanitize: title cleaned");
  assertEqual(doc.setup.pageSize, "a4", "sanitize: bad page size → a4");
  assertEqual(doc.setup.margins, "normal", "sanitize: bad margins → normal");
  assertEqual(doc.setup.pageNumbers, "none", "sanitize: bad page numbers → none");
  assert(doc.blocks.length === 3, "sanitize: laser + empty-image dropped", {
    blocks: doc.blocks.map((b) => b.kind),
  });
  assertEqual(dropped, 2, "sanitize: drop count = 2");
  const p = doc.blocks[0];
  assert(
    p.kind === "p" && p.runs[0]?.color === undefined,
    "sanitize: invalid colour dropped"
  );
  assert(p.kind === "p" && p.align === "left", "sanitize: bad align → left");
  assert(p.kind === "p" && p.family === "sans", "sanitize: bad family → sans");
  const table = doc.blocks[1];
  assert(
    table.kind === "table" && table.rows.every((row) => row.length === 1),
    "sanitize: table rows normalised to widest"
  );
}
{
  const { doc } = sanitizeWDoc({
    title: "x",
    setup: {},
    blocks: [
      textBlock("p", "नमस्ते दुनिया"),
      textBlock("p", "hello"),
    ],
  });
  assert(docNeedNoto(doc) === true, "docNeedNoto: Devanagari → true");
  assert(
    docNeedNoto(makeDoc([textBlock("p", "plain latin")])) === false,
    "docNeedNoto: latin-only → false"
  );
  assertEqual(countWords(doc), 3, "countWords: 2 deva + 1 latin");
  assertEqual(countWords(makeDoc([])), 0, "countWords: empty doc");
}
{
  const doc = makeDoc([
    { id: "i1", kind: "image", assetKey: "k2", scale: 0.5, align: "center" },
    textBlock("p", "x"),
    { id: "i2", kind: "image", assetKey: "k2", scale: 0.5, align: "center" },
    { id: "i3", kind: "image", assetKey: "k1", scale: 1, align: "left" },
  ]);
  assertEqual(assetOrderOf(doc), ["k2", "k1"], "assetOrderOf: unique in order");
  assertEqual(wOutputName("My Report/2026 <final>"), "My Report_2026 _final_.pdf", "wOutputName hygiene");
  assertEqual(wOutputName("   "), "document.pdf", "wOutputName: blank fallback");
}

// ---- layout: basics ----
{
  const laid = layoutDoc({
    doc: makeDoc([textBlock("h1", "Heading"), textBlock("p", "Body line")]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assertEqual(laid.pages.length, 1, "layout: short doc = 1 page");
  assert(
    laid.pages[0].pieces.some((p) => p.text === "Heading" && p.size === 22),
    "layout: h1 at 22pt"
  );
  assert(
    laid.pages[0].pieces.some((p) => p.text === "Body line"),
    "layout: paragraph piece"
  );
}
{
  // empty paragraph consumes one line
  const laid = layoutDoc({
    doc: makeDoc([textBlock("p", "")]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assertEqual(laid.pages[0].pieces.length, 0, "layout: empty paragraph emits no pieces");
  assert(
    laid.pages[0].pieces.length === 0,
    "layout: empty paragraph emits no pieces (page still exists)"
  );
}
{
  const laid = layoutDoc({
    doc: makeDoc([textBlock("p", "one"), { id: "x", kind: "pagebreak" }, textBlock("p", "two")]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assertEqual(laid.pages.length, 2, "layout: page break → 2 pages");
  assert(
    laid.pages[1].pieces.some((p) => p.text === "two"),
    "layout: content after break lands on page 2"
  );
}

// ---- layout: wrapping + pagination ----
{
  // A4 contentW = 451.28pt; 0.5pt/char/size → at size 11 each char = 5.5pt →
  // 82 chars/line. 500-char word → 7 lines.
  const long = "x".repeat(500);
  const laid = layoutDoc({
    doc: makeDoc([textBlock("p", long)]),
    imageSizes: {},
    measure: monoMeasure,
  });
  const p1 = laid.pages[0].pieces;
  const joined = p1.map((p) => p.text).join("");
  assertEqual(joined.length, 500, "layout: hard-split total chars preserved");
  assert(p1.length >= 6, "layout: long word hard-split into lines", {
    pieces: p1.length,
  });
}
{
  // many paragraphs → multi-page; every page non-empty
  const blocks: WBlock[] = [];
  for (let i = 0; i < 120; i += 1) {
    blocks.push(textBlock("p", `Paragraph ${i} ${"word ".repeat(30)}`));
  }
  const laid = layoutDoc({
    doc: makeDoc(blocks),
    imageSizes: {},
    measure: monoMeasure,
  });
  assert(laid.pages.length >= 2, "layout: 120 paragraphs paginate", {
    pages: laid.pages.length,
  });
  for (const page of laid.pages) {
    assert(
      page.pieces.length > 0 || page.rects.length > 0,
      "layout: no blank pages in flowing text"
    );
  }
}

// ---- layout: lists + quote + hr + underline ----
{
  const laid = layoutDoc({
    doc: makeDoc([
      textBlock("bullet", "bullet one"),
      textBlock("bullet", "bullet two"),
      textBlock("numbered", "first"),
      textBlock("numbered", "second"),
      textBlock("numbered", "third"),
    ]),
    imageSizes: {},
    measure: monoMeasure,
  });
  const texts = laid.pages[0].pieces.map((p) => p.text);
  assert(texts.includes("•"), "layout: bullet marker drawn");
  assert(texts.includes("1."), "layout: numbered marker 1.");
  assert(texts.includes("3."), "layout: consecutive numbered run counts 1..3");
}
{
  const laid = layoutDoc({
    doc: makeDoc([textBlock("quote", "quoted words")]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assert(laid.pages[0].rects.length === 1, "layout: quote bar rect emitted");
  const bar = laid.pages[0].rects[0];
  assert(bar !== undefined && bar.w === 2.5, "layout: quote bar width 2.5pt");
  assert(
    laid.pages[0].pieces.every((p) => p.x >= 72 + 18),
    "layout: quote pieces indented past the bar"
  );
}
{
  const laid = layoutDoc({
    doc: makeDoc([
      textBlock("p", "a"),
      { id: "hr", kind: "hr" },
      textBlock("p", "b"),
    ]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assert(
    laid.pages[0].lines.some((l) => l.color === "#cbd5e1"),
    "layout: hr rule line emitted"
  );
}
{
  const laid = layoutDoc({
    doc: makeDoc([
      {
        id: "u1",
        kind: "p",
        runs: [{ text: "underlined words", underline: true }],
        align: "left",
        family: "sans",
      },
    ]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assert(
    laid.pages[0].lines.some((l) => l.color === "#1a1a1f" && l.x2 > l.x1),
    "layout: underline stroke emitted under the run"
  );
}

// ---- layout: keep-with-next ----
{
  // fill a page almost to the bottom, then a heading + paragraph: the
  // heading must move to the next page with its content
  const blocks: WBlock[] = [];
  const contentH = A4.height - 144;
  const advance = 11 * 1.5;
  const linesThatFit = Math.floor(contentH / advance);
  const filler = Math.floor(linesThatFit / 2); // paragraphs of 2 lines each
  for (let i = 0; i < filler - 1; i += 1) {
    blocks.push(
      textBlock("p", "x".repeat(170)) // ~2 lines
    );
  }
  blocks.push(textBlock("h2", "Heading near bottom"));
  blocks.push(textBlock("p", "content that must follow"));
  const laid = layoutDoc({
    doc: makeDoc(blocks),
    imageSizes: {},
    measure: monoMeasure,
  });
  const lastPage = laid.pages[laid.pages.length - 1];
  const heading = lastPage.pieces.find((p) => p.text === "Heading near bottom");
  assert(heading !== undefined, "layout: heading on the last page");
  const headingPage = laid.pages.findIndex((page) =>
    page.pieces.some((p) => p.text === "Heading near bottom")
  );
  const followPage = laid.pages.findIndex((page) =>
    page.pieces.some((p) => p.text === "content that must follow")
  );
  assertEqual(headingPage, followPage, "layout: keep-with-next (heading + content same page)");
}

// ---- layout: tables ----
{
  const laid = layoutDoc({
    doc: makeDoc([
      {
        id: "t",
        kind: "table",
        header: true,
        rows: [
          ["Metric", "Value"],
          ["Users", "1200"],
          ["Files", "9400"],
        ],
      },
    ]),
    imageSizes: {},
    measure: monoMeasure,
  });
  const page = laid.pages[0];
  assert(
    page.rects.some((r) => r.color === "#f1f5f9"),
    "table: header background rect"
  );
  // borders: 3 rows → 1 top + 3 bottoms = 4 horizontal; verticals are
  // per-row (rows × (cols + 1)) — each row fragment owns its edges
  const horizontal = page.lines.filter((l) => Math.abs(l.y2 - l.y1) < 0.5);
  const vertical = page.lines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5);
  assertEqual(horizontal.length, 4, "table: 4 horizontal borders (3 rows)");
  assertEqual(vertical.length, 9, "table: 9 vertical borders (3 rows × 3)");
  const texts = page.pieces.map((p) => p.text);
  assert(texts.includes("Metric"), "table: header cell text");
  assert(texts.includes("9400"), "table: last cell text");
  assert(
    page.pieces.every((p) => p.size === 9.5),
    "table: cells at 9.5pt"
  );
}
{
  // table splits across pages, rows atomic
  const rows: string[][] = [["h1", "h2"]];
  for (let i = 0; i < 40; i += 1) rows.push([`row ${i} aaaa`, `row ${i} bbbb`]);
  const laid = layoutDoc({
    doc: makeDoc([{ id: "t", kind: "table", header: false, rows }]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assert(laid.pages.length >= 2, "table: 40 rows split across pages", {
    pages: laid.pages.length,
  });
  const texts = laid.pages.flatMap((p) => p.pieces.map((x) => x.text));
  assert(texts.includes("row 0 aaaa"), "table: first row present");
  assert(texts.includes("row 39 bbbb"), "table: last row present");
}

// ---- layout: images ----
{
  const laid = layoutDoc({
    doc: makeDoc([
      { id: "im", kind: "image", assetKey: "k1", scale: 1, align: "center" },
    ]),
    imageSizes: { k1: { w: 200, h: 100 } },
    measure: monoMeasure,
  });
  const image = laid.pages[0].images[0];
  assert(image !== undefined, "image: placed");
  if (image) {
    assertEqual(image.index, 0, "image: asset order index 0");
    const expectedW = A4.width - 144;
    assert(
      Math.abs(image.w - expectedW) < 0.01 && Math.abs(image.h - expectedW / 2) < 0.01,
      "image: full-width scale with aspect",
      { w: image.w, h: image.h }
    );
    assert(
      Math.abs(image.x - (72 + (expectedW - image.w) / 2)) < 0.01,
      "image: centred"
    );
  }
}
{
  // tall image clamps to content height
  const laid = layoutDoc({
    doc: makeDoc([
      { id: "im", kind: "image", assetKey: "k1", scale: 1, align: "center" },
    ]),
    imageSizes: { k1: { w: 100, h: 10000 } },
    measure: monoMeasure,
  });
  const image = laid.pages[0].images[0];
  assert(
    image !== undefined && image.h <= A4.height - 144 + 0.01,
    "image: clamped to content height"
  );
  // missing asset skipped entirely
  const laid2 = layoutDoc({
    doc: makeDoc([
      { id: "im", kind: "image", assetKey: "gone", scale: 1, align: "center" },
    ]),
    imageSizes: {},
    measure: monoMeasure,
  });
  assertEqual(laid2.pages[0].images.length, 0, "image: missing asset skipped");
}

// ---- layout: header/footer/page numbers ----
{
  const laid = layoutDoc({
    doc: makeDoc(
      [
        textBlock("p", "one"),
        { id: "x", kind: "pagebreak" },
        textBlock("p", "two"),
      ],
      {
        setup: {
          pageSize: "a4",
          landscape: false,
          margins: "normal",
          headerText: "Report — {date}",
          footerText: "Page {page} of {pages}",
          pageNumbers: "center",
          pageNumFormat: "nOfN",
          dateText: "17/10/2026",
        },
      }
    ),
    imageSizes: {},
    measure: monoMeasure,
  });
  assertEqual(laid.pages.length, 2, "hf: 2 pages");
  const header0 = laid.pages[0].pieces.find((p) => p.text === "Report — 17/10/2026");
  assert(header0 !== undefined, "hf: {date} substituted in header");
  assert(
    header0 !== undefined && Math.abs(header0.baseline - (A4.height - 34)) < 0.01,
    "hf: header baseline at pageH - 34"
  );
  assert(
    laid.pages[0].pieces.some((p) => p.text === "Page 1 of 2"),
    "hf: footer {page}/{pages} page 1"
  );
  assert(
    laid.pages[1].pieces.some((p) => p.text === "Page 2 of 2"),
    "hf: footer page 2"
  );
  assert(
    laid.pages[0].pieces.some((p) => p.text === "1 / 2"),
    "hf: centred page number nOfN"
  );
}

// ---- landscape + margins ----
{
  const laid = layoutDoc({
    doc: makeDoc([textBlock("p", "wide")], {
      setup: {
        pageSize: "a4",
        landscape: true,
        margins: "narrow",
        headerText: "",
        footerText: "",
        pageNumbers: "none",
        pageNumFormat: "n",
        dateText: "",
      },
    }),
    imageSizes: {},
    measure: monoMeasure,
  });
  const piece = laid.pages[0].pieces[0];
  assert(
    piece !== undefined && piece.x === 36,
    "landscape + narrow margins: x starts at 36"
  );
}

// ---- templates ----
{
  const report = buildTemplate("report", "17/10/2026");
  assert(
    report.blocks.some((b) => b.kind === "table") &&
      report.blocks.some((b) => b.kind === "pagebreak") &&
      report.blocks.some((b) => b.kind === "quote"),
    "template: report has table + pagebreak + quote"
  );
  const application = buildTemplate("application", "17/10/2026");
  assert(
    docNeedNoto(application) === true,
    "template: Hindi application needs Noto"
  );
  const letter = buildTemplate("letter", "17/10/2026");
  assert(
    letter.blocks.some((b) => b.kind === "p" && b.family === "serif"),
    "template: letter uses serif blocks"
  );
  const blank = buildTemplate("blank", "17/10/2026");
  assertEqual(blank.blocks.length, 1, "template: blank = 1 empty paragraph");
  assertEqual(blank.setup.dateText, "17/10/2026", "template: dateText injected");
}

console.log(`\nPart 1 (pure model): ${passed} passed, ${failed} failed`);

/* ------------------------------------------------------------------ */
/* Part 2 — the REAL worker module                                     */
/* ------------------------------------------------------------------ */

type Posted = Record<string, unknown> & { type: string; runId: number };
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

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const url = typeof input === "string" ? input : String(input);
  if (url.endsWith("/fonts/NotoSansDevanagari-Regular.ttf")) {
    const bytes = readFileSync(
      "public/fonts/NotoSansDevanagari-Regular.ttf"
    );
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "font/ttf" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function drainInbox(): Promise<Posted[]> {
  // the worker's async font fetch resolves on the microtask queue
  for (let i = 0; i < 40 && inbox.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return inbox.splice(0, inbox.length);
}

async function runWorker(
  options: Record<string, unknown>,
  files: File[]
): Promise<Posted[]> {
  inbox.length = 0;
  workerGlobal.onmessage?.({
    data: { type: "run", runId: 1, toolId: "write-pdf", options, files },
  });
  const out: Posted[] = [];
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    while (inbox.length > 0) {
      const msg = inbox.shift();
      if (msg) out.push(msg);
      const last = out[out.length - 1];
      if (last && (last.type === "result" || last.type === "error")) {
        return out;
      }
    }
  }
  return out;
}

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function pngFile(): File {
  const bytes = Buffer.from(PNG_1PX, "base64");
  return new File([bytes], "tiny.png", { type: "image/png" });
}

async function main(): Promise<void> {
  const part1Passed = passed;
  const part1Failed = failed;

  await import("../tools/write-pdf/worker");

  // ---- error: empty doc ----
  {
    const out = await runWorker({ doc: "" }, []);
    const error = out.find((m) => m.type === "error");
    assert(error !== undefined, "worker: empty doc → error");
    assertEqual(error?.code, "write.errorEmpty", "worker: empty doc code");
  }
  // ---- error: corrupt JSON ----
  {
    const out = await runWorker({ doc: "{not json" }, []);
    const error = out.find((m) => m.type === "error");
    assertEqual(error?.code, "tool.errorGeneric", "worker: corrupt JSON → generic");
  }
  // ---- error: missing image asset ----
  {
    const doc = makeDoc([
      { id: "im", kind: "image", assetKey: "k1", scale: 0.5, align: "center" },
    ]);
    const out = await runWorker({ doc: JSON.stringify(doc) }, []);
    const error = out.find((m) => m.type === "error");
    assertEqual(error?.code, "write.errorAssets", "worker: missing asset code");
  }

  // ---- full battery ----
  {
    const doc = makeDoc(
      [
        textBlock("h1", "SmokeTest Report"),
        {
          id: "bu1",
          kind: "p",
          runs: [
            { text: "bold and ", bold: true },
            { text: "underlined", underline: true },
          ],
          align: "left",
          family: "sans",
        },
        textBlock("p", "नमस्ते दुनिया — Devanagari block"),
        textBlock("bullet", "bullet item"),
        textBlock("numbered", "numbered item"),
        textBlock("quote", "a quoted line"),
        {
          id: "t",
          kind: "table",
          header: true,
          rows: [
            ["Metric", "Value"],
            ["Users", "1200"],
          ],
        },
        { id: "im", kind: "image", assetKey: "k1", scale: 0.5, align: "center" },
        { id: "pb", kind: "pagebreak" },
        textBlock("h2", "Second page"),
        textBlock("p", "After the break"),
      ],
      {
        title: "Smoke टेस्ट",
        setup: {
          pageSize: "a4",
          landscape: false,
          margins: "normal",
          headerText: "Header {date}",
          footerText: "Footer {page}/{pages}",
          pageNumbers: "right",
          pageNumFormat: "n",
          dateText: "17/10/2026",
        },
      }
    );
    const out = await runWorker({ doc: JSON.stringify(doc) }, [pngFile()]);
    const result = out.find((m) => m.type === "result") as
      | { outputs: { name: string; blob: Blob }[]; detail?: { pages?: number; words?: number; images?: number } }
      | undefined;
    assert(result !== undefined, "worker: full battery result", out.filter((m) => m.type === "error"));
    if (!result) return;
    assertEqual(
      result.outputs[0]?.name,
      "Smoke टेस्ट.pdf",
      "worker: output name from title"
    );
    const detail = result.detail ?? {};
    assertEqual(detail.pages, 2, "worker: detail pages = 2");
    assertEqual(detail.images, 1, "worker: detail images = 1");
    assert(
      (detail.words ?? 0) > 15,
      "worker: detail words counted",
      detail.words
    );

    const bytes = Buffer.from(
      await result.outputs[0].blob.arrayBuffer()
    );
    assert(
      bytes.subarray(0, 5).toString("latin1") === "%PDF-",
      "worker: output is a PDF"
    );

    const reload = await PDFDocument.load(new Uint8Array(bytes));
    assertEqual(reload.getPageCount(), 2, "worker: reload page count");
    // pdf-lib getPage is ZERO-based: page(0) = first page
    const size = reload.getPage(0).getSize();
    assert(
      Math.abs(size.width - 595.28) < 0.5 && Math.abs(size.height - 841.89) < 0.5,
      "worker: A4 page size",
      { width: size.width, height: size.height }
    );

    // page 1 content: text ops + heading hex + image XObject + Type0 font
    const page1 = reload.getPage(0);
    const resources = page1.node.Resources();
    const xobject = resources?.lookup(PDFName.of("XObject"));
    let hasImage = false;
    if (xobject instanceof PDFDict) {
      for (const key of xobject.keys()) {
        const stream = xobject.lookup(key);
        if (stream instanceof PDFStream) {
          const subtype = stream.dict.get(PDFName.of("Subtype"));
          if (String(subtype) === "/Image") hasImage = true;
        }
      }
    }
    assert(hasImage, "worker: image XObject embedded on page 1");

    const fontRes = resources?.lookup(PDFName.of("Font"));
    let hasType0 = false;
    if (fontRes instanceof PDFDict) {
      for (const key of fontRes.keys()) {
        const font = fontRes.lookup(key);
        if (font instanceof PDFDict) {
          // composite fonts: /Subtype /Type0 (the /Type is /Font for both)
          const sub = font.get(PDFName.of("Subtype"));
          if (String(sub) === "/Type0") hasType0 = true;
        }
      }
    }
    assert(hasType0, "worker: Type0 (Noto subset) font embedded for Devanagari");

    // text ops: inflate EVERY content stream (pdf-lib appends one per
    // draw call) and concatenate, then look for Tj with hex text
    const readContent = (pageIndex: number): string => {
      const page = reload.getPage(pageIndex);
      const contents = page.node.Contents();
      let text = "";
      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i += 1) {
          const stream: unknown = contents.lookup(i);
          if (
            stream &&
            typeof stream === "object" &&
            "contents" in (stream as { contents?: unknown })
          ) {
            const raw = (stream as { contents: Uint8Array }).contents;
            try {
              text += inflateSync(Buffer.from(raw)).toString("latin1");
            } catch {
              text += Buffer.from(raw).toString("latin1");
            }
          }
        }
      } else if (
        contents &&
        typeof contents === "object" &&
        "contents" in (contents as { contents?: unknown })
      ) {
        const raw = (contents as unknown as { contents: Uint8Array }).contents;
        try {
          text = inflateSync(Buffer.from(raw)).toString("latin1");
        } catch {
          text = Buffer.from(raw).toString("latin1");
        }
      }
      return text;
    };
    const contentText = readContent(0);
    assert(contentText.includes("Tj"), "worker: text drawing ops present");
    const headingHex = Buffer.from("SmokeTest Report").toString("hex").toUpperCase();
    assert(
      contentText.toUpperCase().includes(headingHex),
      "worker: heading text hex present in content stream"
    );
    const boldHex = Buffer.from("bold and ").toString("hex").toUpperCase();
    assert(
      contentText.toUpperCase().includes(boldHex),
      "worker: bold run text present"
    );
    // table border ops + header fill
    assert(/0\.75\s*w/.test(contentText) || / re/.test(contentText), "worker: table strokes/fills present");
    assert(
      /0\.945|0\.941/.test(contentText) || /1 1 1 rg/.test(contentText) || / sc/.test(contentText),
      "worker: some stroke/fill colour ops present"
    );

    // page 2: second heading + page number "2" + footer with {page}
    const content2 = readContent(1);
    const h2Hex = Buffer.from("Second page").toString("hex").toUpperCase();
    assert(
      content2.toUpperCase().includes(h2Hex),
      "worker: page-2 heading after break"
    );
    const footerHex = Buffer.from("Footer 2/2").toString("hex").toUpperCase();
    assert(
      content2.toUpperCase().includes(footerHex),
      "worker: footer {page}/{pages} substituted"
    );
    const headerHex = Buffer.from("Header 17/10/2026").toString("hex").toUpperCase();
    assert(
      content2.toUpperCase().includes(headerHex),
      "worker: header {date} substituted"
    );
  }

  // ---- sanitizer honesty: garbage inside JSON survives without crash ----
  {
    const out = await runWorker(
      {
        doc: JSON.stringify({
          title: "ok",
          setup: {},
          blocks: [
            { kind: "p", runs: [{ text: "keep" }] },
            { kind: "garbage" },
          ],
        }),
      },
      []
    );
    const result = out.find((m) => m.type === "result");
    assert(result !== undefined, "worker: garbage block dropped, run succeeds");
  }

  const total = passed;
  const totalFailed = failed;
  console.log(
    `\nPart 2 (real worker): ${total - part1Passed} passed, ${totalFailed - part1Failed} failed`
  );
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});
