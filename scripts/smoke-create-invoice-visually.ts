/**
 * Smoke: create-invoice-visually (RB5-a / RB5-FIN-a) — the WYSIWYG A4
 * invoice designer: pure model vectors + parser hardening + REAL vector
 * PDF renders (pdf-lib reload + pdf.js extraction) + the worker E2E
 * through a self-shimmed globalThis.
 *
 * House conventions (smoke-create-resume / smoke-publisher-to-pdf base):
 * relative imports WITHOUT .ts (TS5097), regenerator-runtime first
 * (pdf.js), plain check() helper + section banners, node:zlib inflate
 * oracle for content streams, process.exit(fail > 0 ? 1 : 0).
 *
 *  1. Geometry — PT_PER_PX / pxToPt / ptToPx / snapPt / snapPx (the
 *     8 pt grid) + canvas↔A4 dimension round-trip.
 *  2. Text hygiene + ids + WinAnsi (isWinAnsiText, cleanText/cleanLine).
 *  3. Measure + wrap — approxMeasure classes, wrapText vectors with an
 *     exact monospace measure (deterministic boundary math).
 *  4. Table math — round2 epsilon, rowAmount, computeTotals (subtotal →
 *     single tax % → total, always derived), num/group2/formatMoney/
 *     formatQty/formatPct.
 *  5. defaults — EN + हिंदी starter layout (8 elements, 3 items, 18%,
 *     ₹, date injection, grid-aligned x/y, title/totals right-edge
 *     alignment).
 *  6. Element ops — move/resize (snap + page clamp), updateElement
 *     immutability, bringForward/sendBackward, deleteElement.
 *  7. buildCommands — layout → the pure command list with EXACT pt
 *     coordinates (canvas px × 72/96): text baselines/align, table
 *     header/rows/borders/columns, totals rows + the bold rule, the
 *     empty logo slot, allDrawnText, needsNoto (₹ / Devanagari flips).
 *  8. parseCanvasRun hardening — garbage, round-trip, clamps (elements/
 *     items/tax/size/coords/colour/align), id dedupe, data-URL policy
 *     (SVG kept — the RENDERER rejects it honestly — oversize/webp-ish
 *     dropped), label key/value caps.
 *  9. Output name sanitization + serialize/deserialize round-trip.
 * 10. Error taxonomy — classifyError vectors (incl. the corrupt-raster
 *     fix: pdf-lib's "The input is not a PNG file!" → civ.errLogo).
 * 11. REAL render E2E — EN-only ($ → base-14 Helvetica, nothing
 *     embedded) and Hindi (शर्मा ट्रेडिंग → self-hosted Noto subset,
 *     FontFile2 + Identity-H), a raw-bytes 8×6 PNG logo, page size
 *     595.28×841.89, pdf.js needles + exact placement geometry (the
 *     y-flip and the right-align math), metadata with
 *     updateMetadata:false (the pinned producer lesson), and the honest
 *     rejection renders (SVG / webp / corrupt PNG). Devanagari is
 *     asserted through STABLE substrings — pdf.js extracts fontkit
 *     output in VISUAL glyph order (probe-verified: "शर्मा ट्रेडिंग"
 *     extracts as "शमार् ट्रेिडंग" — reph trails, pre-base ि leads).
 * 12. Worker E2E — the real worker.ts driven through the self-shimmed
 *     globalThis (postMessage/location/self + fetch serving the local
 *     Noto TTF, the smoke-publisher-to-pdf recipe): Hindi + EN + garbage
 *     canvas + SVG rejection, progress pcts, output naming, detail
 *     fields (pages/objects/images/elementCount/fontsEmbedded).
 * 13. Config + i18n sanity — config.ts shape, tool i18n.json en/hi leaf
 *     parity (60), every referenced civ.* key resolves in both
 *     languages, classifyError codes resolve, tool.errorGeneric/
 *     errorTitle present in the shared catalogs.
 *
 * Run: bun scripts/smoke-create-invoice-visually.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  allDrawnText,
  approxMeasure,
  bringForward,
  buildCommands,
  classifyError,
  cleanLine,
  cleanText,
  computeTotals,
  CURRENCIES,
  DEFAULT_LABELS,
  defaults,
  deleteElement,
  elementHeightPx,
  formatMoney,
  formatPct,
  formatQty,
  group2,
  isWinAnsiText,
  MAX_ELEMENTS,
  MAX_FONT,
  MAX_IMG_DATAURL,
  MAX_ITEMS,
  MAX_TAX_PCT,
  MIN_FONT,
  MIN_W_PX,
  moveElement,
  needsNoto,
  newId,
  num,
  outputName,
  parseCanvasRun,
  resizeElement,
  round2,
  rowAmount,
  sendBackward,
  snapPx,
  snapPt,
  tableCols,
  tableHeightPx,
  textHeightPx,
  textLines,
  updateElement,
  wrapText,
  type DrawCommand,
  type MeasureFn,
} from "../tools/create-invoice-visually/model";
import { renderCanvasPdf } from "../tools/create-invoice-visually/render";
import {
  CANVAS_H_PX,
  CANVAS_W_PX,
  deserializeCanvas,
  PAGE_A4,
  PT_PER_PX,
  PX_PER_PT,
  serializeCanvas,
  type CanvasRun,
  type InvoiceCanvasDoc,
  type LogoElement,
  type TableElement,
  type TextElement,
  type TableRow,
} from "../tools/create-invoice-visually/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/** Deep equality check (JSON compare — house eq style). */
function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected }
  );
}

/** Float closeness (exact ×0.75 math still drifts at 1e-13). */
function near(
  label: string,
  actual: number,
  expected: number,
  eps = 1e-9
): void {
  check(label, Math.abs(actual - expected) <= eps, {
    actual,
    expected,
    eps,
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Exact monospace measure: every char = size/2 pt (deterministic wrap). */
const mono: MeasureFn = (text, size) => text.length * size * 0.5;

/** node:zlib inflate oracle over the PDF content streams. */
function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start += 1;
    if (raw[start] === "\n") start += 1;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString(
        "latin1"
      );
    } catch {
      /* not a flate stream (e.g. embedded font) — skip */
    }
    idx = e + 9;
  }
  return out;
}

/** Dump every indirect object (parse level — object streams defeated). */
function objDump(doc: PDFDocument): string {
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/* ---- a REAL tiny PNG built from raw bytes (IHDR + IDAT + IEND) ----- */

function crc32(bytes: Uint8Array): number {
  let c = 0;
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8×6 RGB gradient PNG — a real, valid raster logo built from bytes. */
function tinyPng(w: number, h: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = new Uint8Array(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < w; x += 1) {
      raw[p] = Math.round((x * 255) / Math.max(1, w - 1));
      raw[p + 1] = 0x88;
      raw[p + 2] = Math.round((y * 255) / Math.max(1, h - 1));
      p += 3;
    }
  }
  const parts = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

const logoPngUrl = `data:image/png;base64,${Buffer.from(
  tinyPng(8, 6)
).toString("base64")}`;

/** pdf.js in-process extraction (smoke-pdf-to-odt recipe). */
interface ItemLike {
  str: string;
  width: number;
  transform: number[];
}

async function pdfjsItems(bytes: Uint8Array): Promise<ItemLike[]> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  try {
    const content = await page.getTextContent();
    return content.items as unknown as ItemLike[];
  } finally {
    page.cleanup();
    await pdf.cleanup();
    await task.destroy();
  }
}

const flat = (items: ItemLike[]): string => items.map((i) => i.str).join("");

const textsOf = (cmds: DrawCommand[]) =>
  cmds.filter((c): c is Extract<DrawCommand, { op: "text" }> => c.op === "text");
/** Non-null: every lookup below is immediately followed by a length/presence
 *  check where it matters; a crash on a missing command fails the run. */
const findText = (cmds: DrawCommand[], s: string) =>
  textsOf(cmds).find((c) => c.text === s)!;

/** pt → canvas px helper (the surface builds elements in px). */
const px = (pt: number): number => pt * PX_PER_PT;

/* ================================================================== */
console.log("── 1. Geometry: px↔pt, the 8 pt grid ────────────────────");
{
  eq("PT_PER_PX is exactly 72/96", PT_PER_PX, 0.75);
  eq("PX_PER_PT is exactly 96/72", PX_PER_PT, 4 / 3);
  eq("A4 page spec", PAGE_A4, { wPt: 595.28, hPt: 841.89 });
  near("canvas width in pt == A4 wPt", CANVAS_W_PX * PT_PER_PX, 595.28, 1e-9);
  near("canvas height in pt == A4 hPt", CANVAS_H_PX * PT_PER_PX, 841.89, 1e-9);
  const pxToPt = (v: number) => v * PT_PER_PX; // local mirror of the model's
  eq("px→pt: 448px = 336pt (×0.75 exact)", pxToPt(448), 336);
  eq("pt→px: 336pt = 448px (×4/3 exact)", px(336), 448);
  eq("px→pt: 128px = 96pt", pxToPt(128), 96);

  eq("snapPt(0) = 0", snapPt(0), 0);
  eq("snapPt(7.9) = 8 (below half rounds up)", snapPt(7.9), 8);
  eq("snapPt(8.1) = 8", snapPt(8.1), 8);
  eq("snapPt(12) = 16 (half rounds away from zero)", snapPt(12), 16);
  eq("snapPt(-3) = 0", snapPt(-3), 0);
  eq("snapPt(-5) = -8", snapPt(-5), -8);
  eq("snapPx(100) = 96 (75pt → 72pt grid → 96px)", snapPx(100), 96);
  eq("snapPx(60) = 64 (45pt → 48pt grid → 64px)", snapPx(60), 64);
  near(
    "snapPx keeps an on-grid px fixed",
    snapPx(42.666666666666664),
    42.666666666666664
  );
  check(
    "snapPx output is always grid-aligned in pt",
    [3, 17, 44.5, 100.1, 777.7].every(
      (v) => Math.abs((snapPx(v) * PT_PER_PX) / 8 - Math.round((snapPx(v) * PT_PER_PX) / 8)) < 1e-9
    )
  );
}

console.log("── 2. Text hygiene + ids + WinAnsi ──────────────────────");
{
  eq("cleanText strips C0 (except \\n) + DEL + C1", cleanText("a\u0000b\u0007c\u007fd\u009fe", 100), "abcde");
  eq("cleanText keeps \\n (hard breaks are data)", cleanText("a\nb", 100), "a\nb");
  eq("cleanText strips tabs (only \\n survives)", cleanText("a\tb", 100), "ab");
  eq("cleanText caps length", cleanText("x".repeat(300), 200).length, 200);
  eq("cleanLine joins with space + trims", cleanLine("  a\nb  ", 100), "a b");
  eq("cleanLine strips the tab entirely", cleanLine("a\tb", 100), "ab");
  const idA = newId("t");
  const idB = newId("t");
  check("newId: prefix + unique", idA.startsWith("t") && idB.startsWith("t") && idA !== idB, [idA, idB]);

  eq("isWinAnsiText: ASCII passes", isWinAnsiText("Hello World 123"), true);
  eq("isWinAnsiText: CP1252 high bytes pass", isWinAnsiText(" café ñ"), true);
  eq("isWinAnsiText: CP1252 extras pass (– — ‘ ’ “ ” • €)", isWinAnsiText("Hello • – — ‘’ “” €"), true);
  eq("isWinAnsiText: Devanagari fails", isWinAnsiText("हिन्दी"), false);
  eq("isWinAnsiText: ₹ fails (→ Noto)", isWinAnsiText("₹"), false);
  eq("isWinAnsiText: Ā (U+0100) fails", isWinAnsiText("\u0100"), false);
}

console.log("── 3. Measure + wrap (mono measure: exact math) ─────────");
{
  near("approxMeasure: narrow class (iljt)", approxMeasure("iljt", 10), 11.6, 1e-9);
  near("approxMeasure: wide class (mw)", approxMeasure("mw", 10), 16.4, 1e-9);
  near("approxMeasure: caps", approxMeasure("AB", 10), 13.6, 1e-9);
  near("approxMeasure: digits", approxMeasure("12", 10), 11.2, 1e-9);
  near("approxMeasure: Devanagari average 0.62em per code point", approxMeasure("हिन्दी", 10), 37.2, 1e-9);
  near("approxMeasure: bold widens 6%", approxMeasure("iljt", 10, true), 12.296, 1e-9);
  near("mono measure sanity", mono("Hello", 10), 25, 1e-12);

  eq(
    "wrapText: 80pt box, 5pt/char → break before the 4th word",
    wrapText("aaaa bbbb cccc dddd", 80, 10, mono),
    ["aaaa bbbb cccc", "dddd"]
  );
  eq("wrapText: explicit \\n lines survive", wrapText("a\n\nb", 80, 10, mono), ["a", "", "b"]);
  eq("wrapText: empty text → ['']", wrapText("", 80, 10, mono), [""]);
  eq(
    "wrapText: single over-wide word draws wide (honest, no crushing)",
    wrapText("a".repeat(31), 30, 10, mono).length,
    1
  );
  eq(
    "wrapText: exact fit stays one line (<= boundary)",
    wrapText("a".repeat(16), 80, 10, mono),
    ["a".repeat(16)]
  );
}

console.log("── 4. Table math — money is never trusted from the screen ─");
{
  eq("round2: 0.1+0.2 drift killed", round2(0.1 + 0.2), 0.3);
  eq("round2: 1.005 → 1.01 (the EPSILON case)", round2(1.005), 1.01);
  eq("round2: 2.675 → 2.68", round2(2.675), 2.68);
  eq("rowAmount: 1 × 15000", rowAmount({ qty: 1, rate: 15000 }), 15000);
  eq("rowAmount: 3 × 750", rowAmount({ qty: 3, rate: 750 }), 2250);
  eq("rowAmount: 0.333 × 100 → 33.3", rowAmount({ qty: 0.333, rate: 100 }), 33.3);

  const t = computeTotals(
    [
      { id: "i1", desc: "Website design", qty: 1, rate: 15000 },
      { id: "i2", desc: "Hosting", qty: 3, rate: 750 },
    ],
    18
  );
  eq("computeTotals: subtotal", t.subtotal, 17250);
  eq("computeTotals: 18% tax", t.tax, 3105);
  eq("computeTotals: grand total", t.total, 20355);
  eq("computeTotals: row amounts", t.rowAmounts, [15000, 2250]);
  const drift = computeTotals(
    [1, 2, 3].map((i) => ({ id: `x${i}`, desc: "d", qty: 0.333, rate: 100 })),
    18
  );
  eq("computeTotals: 3 × 33.3 → 99.9 (no float drift)", drift.subtotal, 99.9);
  eq("computeTotals: tax on 99.9", drift.tax, 17.98);
  eq("computeTotals: empty invoice", computeTotals([], 18), {
    rowAmounts: [],
    subtotal: 0,
    tax: 0,
    total: 0,
  });
  eq("computeTotals: fractional pct", computeTotals(
    [{ id: "i", desc: "d", qty: 1, rate: 17250 }],
    4.5
  ).tax, 776.25);

  eq("num: '' → 0", num(""), 0);
  eq("num: 'abc' → 0", num("abc"), 0);
  eq("num: null → 0", num(null), 0);
  eq("num: '42.5' → 42.5", num("42.5"), 42.5);

  eq("group2: 15000", group2(15000), "15,000.00");
  eq("group2: 20355", group2(20355), "20,355.00");
  eq("group2: 0", group2(0), "0.00");
  eq("group2: 1234567.891 truncates (not rounds) the 3rd decimal", group2(1234567.891), "1,234,567.89");
  eq("group2: 999.999 carries", group2(999.999), "1,000.00");
  eq("formatMoney: symbol + space + grouped", formatMoney(17250, "$"), "$ 17,250.00");
  eq("formatMoney: empty symbol = bare", formatMoney(17250, ""), "17,250.00");
  eq("formatQty: integer", formatQty(3), "3");
  eq("formatQty: 2.5", formatQty(2.5), "2.5");
  eq("formatQty: 2.25", formatQty(2.25), "2.25");
  eq("formatQty: 3 decimals max (1.23456)", formatQty(1.23456), "1.235");
  eq("formatPct: integer", formatPct(18), "18");
  eq("formatPct: 4.5", formatPct(4.5), "4.5");
  eq("formatPct: 12.345 → 2dp", formatPct(12.345), "12.35");
  eq("formatPct: 0", formatPct(0), "0");
}

console.log("── 5. defaults — the pre-placed A4 layout ───────────────");
{
  const en = defaults("en", new Date(2026, 9, 22, 10, 30));
  eq("defaults: 8 starter elements", en.elements.length, 8);
  eq(
    "defaults: kinds (logo, 5 text, table, totals)",
    en.elements.map((e) => e.kind).sort(),
    ["logo", "table", "text", "text", "text", "text", "text", "totals"]
  );
  eq("defaults: 3 sample items", en.items.length, 3);
  eq("defaults: 18% tax", en.taxPct, 18);
  eq("defaults: ₹ currency", en.currency, "₹");
  eq("defaults: doc number", en.docNumber, "INV-001");
  const docline = en.elements.find((e) => e.id === "docline");
  eq(
    "defaults: docline carries the injected date",
    (docline as { text: string } | undefined)?.text,
    "Invoice No: INV-001\nDate: 2026-10-22"
  );
  const title = en.elements.find((e) => e.id === "title");
  eq("defaults: EN title", (title as { text: string } | undefined)?.text, "INVOICE");

  const hi = defaults("hi", new Date(2026, 9, 22));
  eq(
    "defaults: HI title",
    (hi.elements.find((e) => e.id === "title") as { text: string } | undefined)?.text,
    "इनवॉइस"
  );
  check(
    "defaults: HI company text is Devanagari",
    ((hi.elements.find((e) => e.id === "company") as { text: string } | undefined)?.text ?? "").includes("मेरी कंपनी")
  );
  eq("defaults: HI item desc", hi.items[0].desc, "वेबसाइट डिज़ाइन");

  // x/y live on the 8 pt grid (except totals, whose RIGHT edge aligns with
  // the title block instead — the deliberate right-rail at 555pt).
  const gridAligned = en.elements
    .filter((e) => e.id !== "totals")
    .every((e) => {
      const gx = e.x * PT_PER_PX;
      const gy = e.y * PT_PER_PX;
      return (
        Math.abs(gx - Math.round(gx / 8) * 8) < 1e-6 &&
        Math.abs(gy - Math.round(gy / 8) * 8) < 1e-6
      );
    });
  check("defaults: x/y snap-aligned to the 8 pt grid (7 of 8)", gridAligned);
  const titleEl = en.elements.find((e) => e.id === "title")!;
  const totalsEl = en.elements.find((e) => e.id === "totals")!;
  near(
    "defaults: title right rail at 555pt",
    (titleEl.x + titleEl.w) * PT_PER_PX,
    555,
    1e-6
  );
  near(
    "defaults: totals right edge joins the same rail",
    (totalsEl.x + totalsEl.w) * PT_PER_PX,
    555,
    1e-6
  );
  check(
    "defaults: needsNoto — ₹ alone flips the font",
    needsNoto({ d: en, labels: {}, locale: "en" }),
    true
  );
}

console.log("── 6. Element ops — snap, clamp, immutability ────────────");
{
  const doc = defaults("en", new Date(2026, 9, 22));
  const moved = moveElement(doc, "logo", 60, 40);
  const logo = moved.elements.find((e) => e.id === "logo")!;
  near("move: snapped x = 64px (48pt grid)", logo.x, 64, 1e-9);
  near("move: snapped y = 42.667px (32pt grid)", logo.y, 42.666666666666664, 1e-9);
  near("move: x lands on the 8pt grid", logo.x * PT_PER_PX, 48, 1e-9);
  near("move: y lands on the 8pt grid", logo.y * PT_PER_PX, 32, 1e-9);

  const clamped = moveElement(doc, "logo", 100000, 100000);
  const cLogo = clamped.elements.find((e) => e.id === "logo")!;
  near("move: x clamped inside the page", cLogo.x, CANVAS_W_PX - 128, 1e-9);
  near("move: y clamped inside the page", cLogo.y, CANVAS_H_PX - 64, 1e-9);
  const same = moveElement(doc, "no-such-id", 1, 1);
  check("move: unknown id → same doc object", same === doc);

  const resized = resizeElement(doc, "company", 100);
  near("resize: w snapped 100px → 96px (72pt grid)", resized.elements.find((e) => e.id === "company")!.w, 96, 1e-9);
  const tiny = resizeElement(doc, "company", 1);
  eq("resize: below MIN_W_PX clamps up", tiny.elements.find((e) => e.id === "company")!.w, MIN_W_PX);
  const logoResized = resizeElement(doc, "logo", 200, 30);
  const lr = logoResized.elements.find((e) => e.id === "logo")! as LogoElement;
  near("resize: logo w snapped (152pt grid)", lr.w * PT_PER_PX, 152, 1e-6);
  near("resize: logo h snapped (24pt grid)", lr.h * PT_PER_PX, 24, 1e-6);
  const textNoH = resizeElement(doc, "company", 200, 999);
  check(
    "resize: text elements never gain an h",
    !("h" in textNoH.elements.find((e) => e.id === "company")!),
    textNoH.elements.find((e) => e.id === "company")
  );

  const updated = updateElement(doc, "title", { text: "BILL" });
  eq("updateElement: field patched", (updated.elements.find((e) => e.id === "title") as { text: string }).text, "BILL");
  eq("updateElement: original untouched (immutable)", (doc.elements.find((e) => e.id === "title") as { text: string }).text, "INVOICE");
  eq("updateElement: array length kept", updated.elements.length, 8);

  const abc = defaults("en", new Date(2026, 9, 22));
  abc.elements = [
    { kind: "text", id: "a", x: 0, y: 0, w: 100, text: "a", size: 10, bold: false, italic: false, color: "#111111", align: "left" },
    { kind: "text", id: "b", x: 0, y: 0, w: 100, text: "b", size: 10, bold: false, italic: false, color: "#111111", align: "left" },
    { kind: "text", id: "c", x: 0, y: 0, w: 100, text: "c", size: 10, bold: false, italic: false, color: "#111111", align: "left" },
  ];
  eq("bringForward: swap with next", bringForward(abc, "b").elements.map((e) => e.id), ["a", "c", "b"]);
  eq("sendBackward: swap with previous", sendBackward(abc, "c").elements.map((e) => e.id), ["a", "c", "b"]);
  check("bringForward: last stays (same doc ref)", bringForward(abc, "c") === abc);
  check("sendBackward: first stays (same doc ref)", sendBackward(abc, "a") === abc);
  eq("deleteElement: removes", deleteElement(abc, "b").elements.map((e) => e.id), ["a", "c"]);

  const heights = defaults("en", new Date(2026, 9, 22));
  const table = heights.elements.find((e) => e.kind === "table") as TableElement;
  const totalsH = heights.elements.find((e) => e.kind === "totals")!;
  near(
    "tableHeightPx: header 18pt + 3 rows × 17pt",
    tableHeightPx(table, heights.items),
    (18 + 3 * 17) * PX_PER_PT,
    1e-9
  );
  near("totalsHeightPx: 3 × 15pt", elementHeightPx(totalsH, []), 60, 1e-9);
  near(
    "elementHeightPx: logo carries its own h",
    elementHeightPx(heights.elements.find((e) => e.kind === "logo")!, []),
    64,
    1e-9
  );
  const twoLine = { kind: "text", id: "t", x: 48, y: 64, w: px(80), text: "aaaa bbbb cccc dddd", size: 10, bold: false, italic: false, color: "#111111", align: "left" } as const;
  eq("textLines (mono): 2 lines", textLines(twoLine, mono), ["aaaa bbbb cccc", "dddd"]);
  near("textHeightPx: 2 × 10pt × 1.35 × 4/3", textHeightPx(twoLine, mono), 36, 1e-9);
}

console.log("── 7. buildCommands — layout → pure draw list (pt) ───────");
{
  const pureDoc: InvoiceCanvasDoc = {
    elements: [
      { kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src: "" },
      { kind: "text", id: "t1", x: px(48), y: px(32), w: px(280),
        text: "Hello canvas", size: 10, bold: false, italic: false, color: "#111111", align: "left" },
      { kind: "text", id: "t2", x: px(36), y: px(48), w: px(80),
        text: "aaaa bbbb cccc dddd", size: 10, bold: false, italic: false, color: "#111111", align: "left" },
      { kind: "text", id: "t3", x: px(48), y: px(32), w: px(280),
        text: "Hello", size: 10, bold: false, italic: false, color: "#111111", align: "center" },
      { kind: "text", id: "t4", x: px(48), y: px(32), w: px(280),
        text: "Hello", size: 10, bold: false, italic: false, color: "#111111", align: "right" },
      { kind: "table", id: "tb", x: px(48), y: px(80), w: px(366), size: 9 },
      { kind: "totals", id: "tt", x: px(331), y: px(368), w: px(224), size: 9 },
    ],
    items: [
      { id: "i1", desc: "Website design", qty: 1, rate: 15000 },
      { id: "i2", desc: "Hosting", qty: 3, rate: 750 },
    ],
    taxPct: 18,
    currency: "$",
    docNumber: "PURE-1",
  };
  const run: CanvasRun = { d: pureDoc, labels: {}, locale: "en" };
  const cmds = buildCommands(run, mono);

  // exact conversion: element px → PDF pt (×72/96)
  const t1 = findText(cmds, "Hello canvas");
  near("text: left x = pxToPt(64px) = 48pt", t1.x, 48, 1e-9);
  near("text: first baseline = yTop + size×1.0 = 42pt", t1.y, 42, 1e-9);
  const l1 = findText(cmds, "aaaa bbbb cccc");
  const l2 = findText(cmds, "dddd");
  near("text: line 0 baseline", l1.y, 58, 1e-9);
  near("text: line 1 baseline (size×1.35 advance)", l2.y, 71.5, 1e-9);
  near("text: center x = x + (w − tw)/2", findText(cmds, "Hello").x, 175.5, 1e-9);
  // right-align shares the last "Hello" — assert via both t3/t4 presence:
  const hellos = textsOf(cmds).filter((c) => c.text === "Hello");
  eq("text: center + right both present", hellos.length, 2);
  near("text: right x = x + w − tw (303pt)", hellos[1].x, 303, 1e-9);
  eq("text: empty lines are skipped, \\n lines counted", textsOf(cmds).filter((c) => c.text === "").length, 0);

  // table geometry
  const cols = tableCols(48, 366);
  near("tableCols: desc left edge (+4pt pad)", cols.descX, 52, 1e-9);
  near("tableCols: qty right anchor (62%)", cols.qtyR, 274.92, 1e-9);
  near("tableCols: rate right anchor (80%)", cols.rateR, 340.8, 1e-9);
  near("tableCols: amount right anchor (w−4)", cols.amtR, 410, 1e-9);

  const rect = cmds.find((c): c is Extract<DrawCommand, { op: "rect" }> => c.op === "rect")!;
  near("table: header rect x", rect.x, 48, 1e-9);
  near("table: header rect y", rect.y, 80, 1e-9);
  near("table: header rect w", rect.w, 366, 1e-9);
  eq("table: header rect h = round(9×2.0)", rect.h, 18);
  eq("table: header rect fill", rect.color, "#e9ede9");
  const desc = findText(cmds, "Description");
  near("table: desc label at left pad", desc.x, 52, 1e-9);
  near("table: header baseline = yTop + h/2 + 9×0.35", desc.y, 92.15, 1e-9);
  near("table: Qty label right-aligned to 62% anchor", findText(cmds, "Qty").x, 261.42, 1e-9);
  near("table: Rate label right-aligned to 80% anchor", findText(cmds, "Rate").x, 322.8, 1e-9);
  near("table: Amount label right-aligned to w−4", findText(cmds, "Amount").x, 383, 1e-9);
  const wd = findText(cmds, "Website design");
  near("table: row 0 desc x", wd.x, 52, 1e-9);
  near("table: row 0 baseline", wd.y, 109.65, 1e-9);
  near("table: row 0 qty right-aligned", findText(cmds, "1").x, 270.42, 1e-9);
  near("table: row 0 rate (bare, no symbol)", findText(cmds, "15,000.00").x, 300.3, 1e-9);
  near("table: row 0 amount (with symbol)", findText(cmds, "$ 15,000.00").x, 360.5, 1e-9);
  near("table: row 1 amount", findText(cmds, "$ 2,250.00").x, 365, 1e-9);
  const lines = cmds.filter((c): c is Extract<DrawCommand, { op: "line" }> => c.op === "line");
  const rowRules = lines.filter((l) => l.width === 0.5);
  eq("table: one 0.5pt rule per body row", rowRules.length, 2);
  near("table: row 0 rule at top + 17pt", rowRules[0].y1, 115, 1e-9);
  near("table: row 1 rule at bottom", rowRules[1].y1, 132, 1e-9);
  const borders = lines.filter((l) => l.width === 0.75);
  eq("table: 4 border lines (top/bottom/left/right)", borders.length, 4);
  check(
    "table: outer border spans yTop..yTop+18+2×17",
    borders.every((b) => (b.y1 === 80 || b.y1 === 132) && (b.y2 === 80 || b.y2 === 132)),
    borders.map((b) => [b.x1, b.y1, b.x2, b.y2])
  );

  // totals geometry
  const rule = lines.find((l) => l.width === 1)!;
  near("totals: bold rule above the total row", rule.y1, 396, 1e-9);
  near("totals: rule spans the block width", rule.x2 - rule.x1, 224, 1e-6);
  eq("totals: rule colour", rule.color, "#333333");
  near("totals: subtotal label x", findText(cmds, "Subtotal").x, 331, 1e-9);
  near("totals: subtotal value right-aligned", findText(cmds, "$ 17,250.00").x, 505.5, 1e-9);
  near("totals: tax row keeps the pct in its label", findText(cmds, "Tax (18%)").y, 393.65, 1e-9);
  near("totals: total value right-aligned", findText(cmds, "$ 20,355.00").x, 505.5, 1e-9);
  eq("totals: muted rows use #555555", findText(cmds, "Subtotal").color, "#555555");
  eq("totals: bold total uses #111111", findText(cmds, "Total").color, "#111111");
  check("totals: bold flag only on the grand total", findText(cmds, "Total").bold && !findText(cmds, "Subtotal").bold);

  // the empty logo slot draws NOTHING (designer-only placeholder)
  eq("logo: empty src → no image command", cmds.filter((c) => c.op === "image").length, 0);
  eq("commands: exact count (5 text + 19 table + 7 totals)", cmds.length, 31);
  eq(
    "allDrawnText: every text command surfaced (5 + 4 header + 8 body + 6 totals)",
    allDrawnText(run).length,
    23
  );
  check(
    "allDrawnText: money strings present",
    ["$ 15,000.00", "$ 17,250.00", "Tax (18%)", "$ 20,355.00"].every((s) =>
      allDrawnText(run).includes(s)
    )
  );

  // needsNoto — the font pick
  check("needsNoto: pure-EN $ document → helvetica", !needsNoto(run));
  check("needsNoto: ₹ currency flips to Noto", needsNoto({ ...run, d: { ...pureDoc, currency: "₹" } }));
  check(
    "needsNoto: Devanagari item desc flips to Noto",
    needsNoto({
      ...run,
      d: { ...pureDoc, items: [{ id: "i", desc: "वेब सेवा", qty: 1, rate: 10 }] },
    })
  );
  check(
    "needsNoto: Devanagari LABEL flips to Noto (labels are drawn)",
    needsNoto({ ...run, labels: { desc: "विवरण" } })
  );
  check("needsNoto: empty doc → helvetica", !needsNoto({ d: { elements: [], items: [], taxPct: 0, currency: "$", docNumber: "" }, labels: {}, locale: "en" }));
  eq("DEFAULT_LABELS: the 7 drawn keys", Object.keys(DEFAULT_LABELS).sort(), ["amount", "desc", "qty", "rate", "subtotal", "tax", "total"]);
  eq("CURRENCIES: ₹ $ € £ and bare", CURRENCIES, ["₹", "$", "€", "£", ""]);
}

console.log("── 8. parseCanvasRun — the worker boundary ───────────────");
{
  const garbage = parseCanvasRun("not json {{{");
  eq("garbage: no elements", garbage.d.elements.length, 0);
  eq("garbage: no items", garbage.d.items.length, 0);
  eq("garbage: locale en", garbage.locale, "en");
  eq("garbage: no labels", garbage.labels, {});
  eq("garbage: currency falls back to ₹", garbage.d.currency, "₹");

  const hiDoc = defaults("hi", new Date(2026, 9, 22));
  const rt = parseCanvasRun(
    serializeCanvas({ d: hiDoc, labels: { desc: "विवरण" }, locale: "hi" })
  );
  eq("round-trip: locale hi", rt.locale, "hi");
  eq("round-trip: 8 elements", rt.d.elements.length, 8);
  eq("round-trip: 3 items", rt.d.items.length, 3);
  eq("round-trip: taxPct", rt.d.taxPct, 18);
  eq("round-trip: docNumber", rt.d.docNumber, "INV-001");
  eq("round-trip: label kept", rt.labels.desc, "विवरण");

  const el = (over: Record<string, unknown>): Record<string, unknown> => ({
    kind: "text", id: "x", x: 0, y: 0, w: 100, text: "t", size: 10,
    bold: false, italic: false, color: "#111111", align: "left", ...over,
  });
  const many = Array.from({ length: 45 }, (_, i) => el({ id: `e${i}` }));
  const tampered = parseCanvasRun(
    JSON.stringify({
      d: {
        elements: [
          el({ id: "dup" }),
          el({ id: "dup" }),
          el({ id: "off", x: -50, y: 1e9, w: 5, size: 99, color: "red", align: "justify", text: "a\u0000b" }),
          { kind: "polygon", id: "p", x: 0, y: 0, w: 10 },
          ...many,
        ],
        items: [
          ...Array.from({ length: 35 }, (_, i) => ({ id: `i${i}`, desc: `d${i}`, qty: 1, rate: 2 })),
          { id: "neg", desc: "bad \u0007 control", qty: -3, rate: 2e12 },
          { id: "str", desc: "x", qty: "5", rate: "7.5" },
        ],
        taxPct: 75,
        currency: "USD",
        docNumber: "x".repeat(80),
      },
      labels: { fileWord: "ok", notAString: 42, aVeryLongKeyNameIndeed: "x", long: "y".repeat(90) },
      locale: "fr",
    })
  );
  eq("clamp: 49 elements → 40 sliced, unknown kind dropped → 39", tampered.d.elements.length, MAX_ELEMENTS - 1);
  const ids = tampered.d.elements.map((e) => e.id);
  eq("clamp: ids deduped", new Set(ids).size, ids.length);
  const off = tampered.d.elements.find((e) => e.id === "off")! as TextElement;
  near("clamp: x ≥ 0", off.x, 0, 1e-9);
  near("clamp: y ≤ CANVAS_H", off.y, CANVAS_H_PX, 1e-9);
  eq("clamp: w ≥ MIN_W_PX", off.w, MIN_W_PX);
  eq("clamp: font size ≤ 36", off.size, MAX_FONT);
  eq("clamp: bad colour → #111111", off.color, "#111111");
  eq("clamp: bad align → left", off.align, "left");
  eq("clamp: control chars stripped from text", off.text, "ab");
  check("clamp: unknown kind dropped (polygon gone)", !ids.includes("p"));
  eq("clamp: items ≤ 30", tampered.d.items.length, MAX_ITEMS);
  eq("clamp: qty/rate clamped to [0, 1e9]", [
    tampered.d.items.some((r) => r.qty < 0),
    tampered.d.items.some((r) => r.rate > 1e9),
  ], [false, false]);
  const strRow = parseCanvasRun(
    JSON.stringify({ d: { items: [{ id: "s", desc: "x", qty: "5", rate: "7.5" }] } })
  ).d.items[0];
  eq("coerce: string numbers become numbers", [strRow.qty, strRow.rate], [5, 7.5]);
  eq("clamp: taxPct ≤ 50", tampered.d.taxPct, MAX_TAX_PCT);
  eq("clamp: unknown currency → ₹", tampered.d.currency, "₹");
  eq("clamp: docNumber capped at 40", tampered.d.docNumber.length, 40);
  eq("labels: good key kept", tampered.labels.fileWord, "ok");
  check("labels: non-string value dropped", !("notAString" in tampered.labels));
  check("labels: >16 char key dropped", !("aVeryLongKeyNameIndeed" in tampered.labels));
  eq("labels: value capped at 80", tampered.labels.long.length, 80);
  eq("locale: unknown → en", tampered.locale, "en");

  const sizeEdge = parseCanvasRun(
    JSON.stringify({ d: { elements: [el({ id: "a", size: 1 }), el({ id: "b", size: "8" })] } })
  );
  eq("coerce: size 1 → MIN_FONT 6", (sizeEdge.d.elements[0] as TextElement).size, MIN_FONT);
  eq("coerce: string size '8' → 8", (sizeEdge.d.elements[1] as TextElement).size, 8);
  const taxEdge = parseCanvasRun(JSON.stringify({ d: { taxPct: -5 } }));
  eq("coerce: negative tax → 0", taxEdge.d.taxPct, 0);

  // data-URL policy (SVG is KEPT — the renderer rejects it honestly)
  const srcOf = (src: string): string =>
    (
      parseCanvasRun(
        JSON.stringify({
          d: { elements: [{ kind: "logo", id: "l", x: 0, y: 0, w: 100, h: 50, src }] },
        })
      ).d.elements[0] as LogoElement
    ).src;
  eq("src: valid PNG data URL kept", srcOf("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  eq("src: SVG data URL kept (renderer's typed rejection)", srcOf("data:image/svg+xml;base64,PHN2Zw=="), "data:image/svg+xml;base64,PHN2Zw==");
  eq("src: space in base64 dropped", srcOf("data:image/png;base64,A A"), "");
  eq("src: non-image data URL dropped", srcOf("data:application/pdf;base64,AAAA"), "");
  eq("src: bare http URL dropped", srcOf("http://x/y.png"), "");
  eq(
    "src: > 1.5 MB data URL dropped",
    srcOf(`data:image/png;base64,${"A".repeat(MAX_IMG_DATAURL - 21)}`),
    ""
  );
  eq(
    "src: at-cap data URL kept",
    srcOf(`data:image/png;base64,${"A".repeat(MAX_IMG_DATAURL - 22)}`).length,
    MAX_IMG_DATAURL
  );
}

console.log("── 9. Output name + serialize/deserialize ────────────────");
{
  const doc = (docNumber: string): InvoiceCanvasDoc => ({
    elements: [], items: [], taxPct: 18, currency: "₹", docNumber,
  });
  eq("outputName: doc number wins", outputName(doc("INV-42")), "INV-42");
  eq("outputName: path chars stripped, spaces → hyphens", outputName(doc("My/Invoice: 2026?")), "MyInvoice-2026");
  eq("outputName: runs of spaces collapse", outputName(doc("a b  c")), "a-b-c");
  eq("outputName: Devanagari survives", outputName(doc("बिल ४२")), "बिल-४२");
  eq("outputName: blank → invoice-YYYY-MM-DD", outputName(doc("  "), new Date(2026, 9, 22)), "invoice-2026-10-22");
  eq("outputName: only-unsafe chars → date fallback", outputName(doc("///"), new Date(2026, 0, 5)), "invoice-2026-01-05");
  eq("outputName: docNumber capped at 40 by cleanLine", outputName(doc("x".repeat(80))).length, 40);

  const run: CanvasRun = {
    d: defaults("hi", new Date(2026, 9, 22)),
    labels: { desc: "विवरण" },
    locale: "hi",
  };
  const wire = serializeCanvas(run);
  eq("serialize: JSON round-trip is lossless", JSON.parse(wire), run);
  eq("serialize: deterministic", serializeCanvas(run), wire);
  const back = deserializeCanvas(wire);
  check("deserialize: round-trip deep-equal", back !== null && JSON.stringify(back) === JSON.stringify(run));
  eq("deserialize: 'not json' → null", deserializeCanvas("not json"), null);
  eq("deserialize: scalar JSON → null", deserializeCanvas("123"), null);
  eq("deserialize: missing labels → null", deserializeCanvas(JSON.stringify({ d: run.d })), null);
  eq("deserialize: non-object labels → null", deserializeCanvas(JSON.stringify({ d: run.d, labels: 5 })), null);
  eq(
    "deserialize: unknown element kind → null",
    deserializeCanvas(
      JSON.stringify({ d: { elements: [{ kind: "polygon", id: "p", x: 0, y: 0, w: 1 }], items: [], taxPct: 0, currency: "$", docNumber: "" }, labels: {}, locale: "en" })
    ),
    null
  );
  eq(
    "deserialize: element missing w → null",
    deserializeCanvas(
      JSON.stringify({ d: { elements: [{ kind: "text", id: "t", x: 0, y: 0 }], items: [], taxPct: 0, currency: "$", docNumber: "" }, labels: {}, locale: "en" })
    ),
    null
  );
  check(
    "deserialize→parseCanvasRun: the draft-restore chain is stable",
    (() => {
      const restored = deserializeCanvas(wire);
      return restored !== null && parseCanvasRun(serializeCanvas(restored)).d.elements.length === 8;
    })()
  );
}

console.log("── 10. Error taxonomy (classifyError) ────────────────────");
{
  eq("classifyError: SVG logo → civ.errSvg", classifyError(new Error("logo-svg-not-supported")), "civ.errSvg");
  eq("classifyError: regex is case-insensitive", classifyError(new Error("LOGO-SVG bad")), "civ.errSvg");
  eq("classifyError: decode failure → civ.errLogo", classifyError(new Error("logo-decode-failed")), "civ.errLogo");
  eq("classifyError: anything else → the house generic key", classifyError(new Error("boom")), "tool.errorGeneric");
  eq("classifyError: non-Error values", classifyError(42), "tool.errorGeneric");
  // pdf-lib's own corrupt-raster messages map to the GENERIC key at the
  // classify level — the RENDER layer (embedLogo) translates them to the
  // typed "logo-decode-failed" before classifyError ever sees them, which
  // the E2E corrupt-PNG check below proves end to end (the RB5-FIN-a fix).
  eq(
    "classifyError: untranslated pdf-lib messages stay generic (render layer owns the translation)",
    classifyError(new Error("The input is not a PNG file!")),
    "tool.errorGeneric"
  );
}

console.log("── 11. REAL render E2E (renderCanvasPdf + pdf.js) ────────");
{
  const items: TableRow[] = [
    { id: "i1", desc: "Website design", qty: 1, rate: 15000 },
    { id: "i2", desc: "Hosting (3 months)", qty: 3, rate: 750 },
  ];
  const hindiItems: TableRow[] = [
    { id: "h1", desc: "वेब सेवा", qty: 1, rate: 15000 },
    { id: "h2", desc: "Hosting (3 months)", qty: 3, rate: 750 },
  ];

  const enRun: CanvasRun = {
    d: {
      elements: [
        { kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src: logoPngUrl },
        { kind: "text", id: "ta", x: px(40), y: px(96), w: px(280),
          text: "Sharma Trading\nNew Delhi 110001", size: 9.5, bold: false, italic: false, color: "#111111", align: "left" },
        { kind: "text", id: "tb", x: px(336), y: px(32), w: px(219),
          text: "INVOICE\nNo: T-101", size: 14, bold: true, italic: false, color: "#111111", align: "right" },
        { kind: "table", id: "tb2", x: px(40), y: px(288), w: px(515), size: 9 },
        { kind: "totals", id: "tt", x: px(331), y: px(368), w: px(224), size: 9 },
      ],
      items,
      taxPct: 18,
      currency: "$",
      docNumber: "INV-9",
    },
    labels: {},
    locale: "en",
  };
  const en = await renderCanvasPdf(enRun);
  check("EN: %PDF magic", en.bytes[0] === 0x25 && en.bytes[1] === 0x50, en.bytes.length);
  check(`EN: size sane (${en.bytes.length} B)`, en.bytes.length > 1500);
  eq("EN: report font = helvetica", en.report.font, "helvetica");
  eq("EN: report images = 1 (the PNG logo)", en.report.images, 1);
  eq("EN: report elementCount = 5", en.report.elementCount, 5);
  eq("EN: report commandCount = 31 (logo 1 + 4 text + 19 table + 7 totals)", en.report.commandCount, 31);

  // updateMetadata:false — pdf-lib's load() otherwise stamps its own
  // producer over the file's (the pinned smoke-epub recipe).
  const enPdf = await PDFDocument.load(en.bytes, { updateMetadata: false });
  eq("EN: exactly 1 page (fixed A4, honest scope)", enPdf.getPageCount(), 1);
  const enSize = enPdf.getPage(0).getSize();
  near("EN: A4 width 595.28pt", enSize.width, 595.28, 0.05);
  near("EN: A4 height 841.89pt", enSize.height, 841.89, 0.05);
  eq("EN: producer MyCloudy", enPdf.getProducer(), "MyCloudy");
  eq("EN: creator MyCloudy", enPdf.getCreator(), "MyCloudy");
  eq("EN: title = doc number", enPdf.getTitle(), "INV-9");
  const enDump = objDump(enPdf);
  check("EN: base-14 Helvetica referenced", enDump.includes("Helvetica"));
  check("EN: NOTHING embedded (no FontFile2)", !enDump.includes("FontFile2"));
  check("EN: logo is a real XObject image", /\/Subtype \/Image/.test(enDump));
  check("EN: source PNG dims carried (/Width 8)", /\/Width 8\b/.test(enDump));
  check("EN: source PNG dims carried (/Height 6)", /\/Height 6\b/.test(enDump));
  const enStream = inflatedText(en.bytes);
  check("EN: real Do draw operator for the logo", /\/[A-Za-z][\w-]*\s+Do\b/.test(enStream));
  check("EN: no NaN geometry anywhere", !enStream.includes("NaN"));

  const enItems = await pdfjsItems(en.bytes);
  const enFlat = flat(enItems);
  const enNeedles = [
    "Sharma Trading", "New Delhi 110001", "INVOICE", "No: T-101",
    "Description", "Qty", "Rate", "Amount",
    "Website design", "Hosting (3 months)",
    "$ 15,000.00", "$ 2,250.00", "$ 17,250.00", "Tax (18%)", "$ 3,105.00", "$ 20,355.00",
  ];
  for (const n of enNeedles) {
    check(`EN pdf.js: "${n}" extracted`, enFlat.includes(n), enFlat.slice(0, 120));
  }
  const inv = enItems.find((i) => i.str === "INVOICE");
  check("EN: INVOICE item found", inv !== undefined);
  // The renderer right-aligns with pdf-lib's OWN Helvetica-Bold metrics —
  // measure them here with the exact same face (probe: pdf-lib 56.868pt
  // vs pdf.js's re-measured 57.568pt — pdf.js drifts ~1% on non-embedded
  // standard-14 fonts, so assert the POSITION exactly, the edge loosely).
  const probeDoc = await PDFDocument.create();
  const helvBold = probeDoc.embedStandardFont(StandardFonts.HelveticaBold);
  if (inv) {
    near(
      "EN: right-align x = 555 − Helvetica-Bold(\"INVOICE\", 14)",
      inv.transform[4],
      555 - helvBold.widthOfTextAtSize("INVOICE", 14),
      0.05
    );
    near("EN: right-align edge ≈ 555pt (pdf.js std-14 width drift)", inv.transform[4] + inv.width, 555, 1.5);
    near("EN: baseline y = 841.89 − (32 + 14×1.0) = 795.89pt", inv.transform[5], 795.89, 0.2);
  }
  const no = enItems.find((i) => i.str === "No: T-101");
  if (no) {
    near("EN: 1.35 line advance for line 2", no.transform[5], 841.89 - (32 + 14 * 2.35), 0.3);
    near(
      "EN: line 2 right-align x = 555 − Helvetica-Bold(\"No: T-101\", 14)",
      no.transform[4],
      555 - helvBold.widthOfTextAtSize("No: T-101", 14),
      0.05
    );
  }
  const wd = enItems.find((i) => i.str === "Website design");
  check("EN: table row item found", wd !== undefined);
  if (wd) {
    near("EN: table desc x = 40pt + 4pt pad", wd.transform[4], 44, 0.1);
    near("EN: table row baseline y (probe-verified)", wd.transform[5], 524.24, 0.2);
  }
  const rate = enItems.find((i) => i.str === "15,000.00");
  if (rate) {
    // right edge asserted via pdf-lib's face (pdf.js's own width drifts on
    // standard-14 — see the INVOICE comment above)
    const helv = probeDoc.embedStandardFont(StandardFonts.Helvetica);
    near(
      "EN: rate column right edge = 80% anchor 452pt",
      rate.transform[4] + helv.widthOfTextAtSize("15,000.00", 9),
      452,
      0.1
    );
  }

  // ---- the Hindi run: शर्मा ट्रेडिंग + ₹ ---------------------------
  const hiRun: CanvasRun = {
    d: {
      elements: [
        { kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src: logoPngUrl },
        { kind: "text", id: "ta", x: px(40), y: px(40), w: px(240),
          text: "शर्मा ट्रेडिंग", size: 12, bold: false, italic: false, color: "#111111", align: "left" },
        { kind: "text", id: "tb", x: px(336), y: px(32), w: px(219),
          text: "INVOICE\nNo: T-101", size: 14, bold: true, italic: false, color: "#111111", align: "right" },
        { kind: "table", id: "tb2", x: px(40), y: px(288), w: px(515), size: 9 },
        { kind: "totals", id: "tt", x: px(331), y: px(368), w: px(224), size: 9 },
      ],
      items: hindiItems,
      taxPct: 18,
      currency: "₹",
      docNumber: "T-101",
    },
    labels: {},
    locale: "hi",
  };
  const hi = await renderCanvasPdf(hiRun, { notoBytes });
  check("HI: %PDF magic", hi.bytes[0] === 0x25 && hi.bytes[1] === 0x50, hi.bytes.length);
  eq("HI: report font = noto (subset embedded)", hi.report.font, "noto");
  eq("HI: report images = 1", hi.report.images, 1);
  eq("HI: report commandCount = 30 (1 fewer EN line than the EN run)", hi.report.commandCount, 30);
  const hiPdf = await PDFDocument.load(hi.bytes, { updateMetadata: false });
  eq("HI: exactly 1 page", hiPdf.getPageCount(), 1);
  const hiSize = hiPdf.getPage(0).getSize();
  near("HI: A4 width", hiSize.width, 595.28, 0.05);
  near("HI: A4 height", hiSize.height, 841.89, 0.05);
  eq("HI: title = doc number", hiPdf.getTitle(), "T-101");
  const hiDump = objDump(hiPdf);
  check("HI: Noto subset embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI: no NaN geometry", !inflatedText(hi.bytes).includes("NaN"));

  const hiItems = await pdfjsItems(hi.bytes);
  const hiFlat = flat(hiItems);
  // STABLE substrings only (the fontkit visual-order lesson, probe-
  // verified: "शर्मा ट्रेडिंग" extracts as "शमार् ट्रेिडंग" — reph र्
  // trails, pre-base ि leads). Assert the pieces, not the logical order.
  check("HI pdf.js: stable Devanagari item desc (वेब सेवा)", hiFlat.includes("वेब सेवा"), hiFlat.slice(0, 80));
  for (const ch of ["श", "म", "ट", "ड", "ग"]) {
    check(`HI pdf.js: consonant ${ch} survives extraction`, hiFlat.includes(ch));
  }
  // Visual-order evidence (probe-verified code points): शर्मा → श म ा र ्
  // (the reph र् TRAILS मा) and ट्रे → ट ् र े (the half-form ट् PRECEDES
  // र). Both reordering facts are asserted on their own extracted forms.
  eq("HI pdf.js: शर्मा reph extracts as the trailing pair र्", hiFlat.split("र्").length - 1, 1);
  check("HI pdf.js: ट्र extracts as the half-form ट् + र (्र)", hiFlat.includes("्र"));
  check(
    "HI pdf.js: visual-order extraction documented (logical शर्मा NOT in the text layer)",
    !hiFlat.includes("शर्मा"),
    hiFlat.slice(0, 40)
  );
  check("HI pdf.js: Devanagari items present", hiItems.some((i) => /[\u0900-\u097F]/.test(i.str)));
  for (const n of ["INVOICE", "No: T-101", "Tax (18%)", "₹ 17,250.00", "₹ 3,105.00", "₹ 20,355.00", "Hosting (3 months)"]) {
    check(`HI pdf.js: "${n}" extracted`, hiFlat.includes(n), hiFlat.slice(0, 120));
  }
  const hiInv = hiItems.find((i) => i.str === "INVOICE");
  if (hiInv) {
    near("HI: right-align edge still 555pt (Noto metrics)", hiInv.transform[4] + hiInv.width, 555, 0.5);
    near("HI: baseline y = 795.89pt", hiInv.transform[5], 795.89, 0.2);
  }

  // ---- honest rejection renders ------------------------------------
  const logoOnly = (src: string): CanvasRun => ({
    d: {
      elements: [{ kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src }],
      items: [], taxPct: 0, currency: "$", docNumber: "X",
    },
    labels: {},
    locale: "en",
  });
  let svgMsg = "";
  try {
    await renderCanvasPdf(logoOnly("data:image/svg+xml;base64,PHN2Zy8+"));
  } catch (e) {
    svgMsg = e instanceof Error ? e.message : String(e);
  }
  eq("render: SVG logo throws the typed error", svgMsg, "logo-svg-not-supported");
  eq("render: SVG classified to civ.errSvg", classifyError(new Error(svgMsg)), "civ.errSvg");

  let webpMsg = "";
  try {
    await renderCanvasPdf(logoOnly("data:image/webp;base64,AAAA"));
  } catch (e) {
    webpMsg = e instanceof Error ? e.message : String(e);
  }
  eq("render: webp logo throws the typed error", webpMsg, "logo-decode-failed");

  let corruptMsg = "";
  try {
    await renderCanvasPdf(logoOnly("data:image/png;base64,AAAA"));
  } catch (e) {
    corruptMsg = e instanceof Error ? e.message : String(e);
  }
  eq(
    "render: corrupt PNG maps to the typed logo error (RB5-FIN-a fix — pdf-lib's own message used to leak through)",
    corruptMsg,
    "logo-decode-failed"
  );

  // the EN run's own logo renders — prove the tiny raw-byte PNG is valid
  check("render: the raw-byte 8×6 PNG really embedded (EN run)", en.report.images === 1);
}

console.log("── 12. Worker E2E (self-shimmed globalThis) ──────────────");
{
  const messages: WorkerResponse[] = [];
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  // the worker fetches the self-hosted Noto TTF from this origin — serve
  // the local file so the exact loadStampFonts path runs headless
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(notoBytes)) as typeof fetch;
  await import("../tools/create-invoice-visually/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    canvas: string
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: { type: "run", runId, toolId: "create-invoice-visually", options: { canvas }, files: [] } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  // Hindi run — the fetch-shimmed Noto path
  const hiDoc = defaults("hi", new Date(2026, 9, 22));
  hiDoc.elements = [
    { kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src: logoPngUrl },
    { kind: "text", id: "ta", x: px(40), y: px(40), w: px(240),
      text: "शर्मा ट्रेडिंग", size: 12, bold: false, italic: false, color: "#111111", align: "left" },
    { kind: "text", id: "tb", x: px(336), y: px(32), w: px(219),
      text: "INVOICE\nNo: T-101", size: 14, bold: true, italic: false, color: "#111111", align: "right" },
    { kind: "table", id: "tb2", x: px(40), y: px(288), w: px(515), size: 9 },
    { kind: "totals", id: "tt", x: px(331), y: px(368), w: px(224), size: 9 },
  ];
  hiDoc.items = [
    { id: "h1", desc: "वेब सेवा", qty: 1, rate: 15000 },
    { id: "h2", desc: "Hosting (3 months)", qty: 3, rate: 750 },
  ];
  hiDoc.docNumber = "T-101";
  hiDoc.currency = "₹";
  const hiRes = await drive(
    501,
    serializeCanvas({ d: hiDoc, labels: {}, locale: "hi" })
  );
  check("worker HI: result", hiRes.type === "result", hiRes);
  if (hiRes.type === "result") {
    // the worker's additive CanvasRunDetail fields (worker.ts — the RB1
    // protocol-extension precedent: RunDetail +elementCount/+fontsEmbedded)
    const detail = hiRes.detail as
      | { pages?: number; objects?: number; images?: number; elementCount?: number; fontsEmbedded?: string }
      | undefined;
    const out = hiRes.outputs[0];
    eq("worker HI: output name T-101.pdf", out.name, "T-101.pdf");
    eq("worker HI: pdf mime", out.mime, "application/pdf");
    const outBytes = new Uint8Array(await out.blob.arrayBuffer());
    check("worker HI: %PDF magic", outBytes[0] === 0x25 && outBytes[1] === 0x50);
    const reloaded = await PDFDocument.load(outBytes, { updateMetadata: false });
    eq("worker HI: 1 page", reloaded.getPageCount(), 1);
    check("worker HI: Noto FontFile2 embedded (fetch shim served the TTF)", objDump(reloaded).includes("FontFile2"));
    eq("worker HI: detail.pages = 1", detail?.pages, 1);
    eq("worker HI: detail.objects = 30 commands", detail?.objects, 30);
    eq("worker HI: detail.images = 1", detail?.images, 1);
    eq("worker HI: detail.elementCount = 5", detail?.elementCount, 5);
    eq("worker HI: detail.fontsEmbedded = noto", detail?.fontsEmbedded, "noto");
    eq("worker HI: producer MyCloudy", reloaded.getProducer(), "MyCloudy");
  }

  // EN-only run — nothing embedded + the date-fallback file name
  const enDoc = defaults("en", new Date(2026, 9, 22));
  enDoc.elements = enDoc.elements.map((e) =>
    e.kind === "logo" ? { ...e, src: logoPngUrl } : e
  );
  enDoc.currency = "$";
  enDoc.docNumber = "";
  enDoc.items = [
    { id: "i1", desc: "Website design", qty: 1, rate: 15000 },
    { id: "i2", desc: "Hosting (3 months)", qty: 3, rate: 750 },
  ];
  const enRes = await drive(
    502,
    serializeCanvas({ d: enDoc, labels: {}, locale: "en" })
  );
  check("worker EN: result", enRes.type === "result", enRes);
  if (enRes.type === "result") {
    const detail = enRes.detail as
      | { pages?: number; objects?: number; images?: number; elementCount?: number; fontsEmbedded?: string }
      | undefined;
    const now = new Date();
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const expected = `invoice-${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}.pdf`;
    eq("worker EN: blank doc number → invoice-<date>.pdf", enRes.outputs[0].name, expected);
    const outBytes = new Uint8Array(await enRes.outputs[0].blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes, { updateMetadata: false });
    check("worker EN: nothing embedded", !objDump(reloaded).includes("FontFile2"));
    eq("worker EN: detail.fontsEmbedded = helvetica", detail?.fontsEmbedded, "helvetica");
    eq("worker EN: detail.images = 1 (defaults logo slot now filled)", detail?.images, 1);
    eq("worker EN: detail.pages = 1", detail?.pages, 1);
  }

  // garbage canvas — the honest blank one-page result (not an error)
  const blank = await drive(503, "not json {{{");
  check("worker blank: still a result (honest empty page)", blank.type === "result", blank);
  if (blank.type === "result") {
    const detail = blank.detail as
      | { pages?: number; objects?: number; images?: number; elementCount?: number; fontsEmbedded?: string }
      | undefined;
    eq("worker blank: elementCount 0", detail?.elementCount, 0);
    eq("worker blank: objects 0", detail?.objects, 0);
    eq("worker blank: pages 1", detail?.pages, 1);
    eq("worker blank: fontsEmbedded helvetica", detail?.fontsEmbedded, "helvetica");
    const outBytes = new Uint8Array(await blank.outputs[0].blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    eq("worker blank: reloads as a valid 1-page PDF", reloaded.getPageCount(), 1);
  }

  // SVG rejection — the typed error path end to end
  const svgDoc = defaults("en", new Date(2026, 9, 22));
  svgDoc.elements = [
    { kind: "logo", id: "lg", x: px(40), y: px(32), w: px(96), h: px(48), src: "data:image/svg+xml;base64,PHN2Zy8+" },
  ];
  const svgRes = await drive(504, serializeCanvas({ d: svgDoc, labels: {}, locale: "en" }));
  check("worker SVG: error", svgRes.type === "error", svgRes);
  if (svgRes.type === "error") {
    eq("worker SVG: code civ.errSvg", svgRes.code, "civ.errSvg");
    eq("worker SVG: detail carries the raw message", svgRes.detail, "logo-svg-not-supported");
  }

  const pcts = messages
    .filter((m): m is Extract<WorkerResponse, { type: "progress" }> => m.type === "progress")
    .map((m) => m.pct);
  check(
    "worker: progress pcts 20/45/85 posted",
    pcts.includes(20) && pcts.includes(45) && pcts.includes(85),
    pcts
  );
}

console.log("── 13. Config + i18n sanity ─────────────────────────────");
{
  const configSrc = readFileSync("tools/create-invoice-visually/config.ts", "utf8");
  check("config: toolId", configSrc.includes('toolId: "create-invoice-visually"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind pdf", configSrc.includes('outputKind: "pdf"'));
  check("config: no file inputs (0/0)", configSrc.includes("minFiles: 0") && configSrc.includes("maxFiles: 0"));
  check("config: empty options array (designer IS the surface)", configSrc.includes("options: []"));
  check("config: howKeys are civ.*", configSrc.includes('"civ.how1"'));
  check(
    "config: chains to view-pdf + compress-pdf",
    configSrc.includes('"view-pdf"') && configSrc.includes('"compress-pdf"')
  );
  check("config: full-width landing surface", configSrc.includes("fullWidthSurface: true") && configSrc.includes("landingSurface: true"));

  const toolI18n = JSON.parse(
    readFileSync("tools/create-invoice-visually/i18n.json", "utf8")
  ) as { en: { civ: Record<string, string> }; hi: { civ: Record<string, string> } };
  const enKeys = Object.keys(toolI18n.en.civ).sort();
  const hiKeys = Object.keys(toolI18n.hi.civ).sort();
  eq("i18n: en/hi leaf parity", enKeys, hiKeys);
  eq("i18n: 60 leaves per language", enKeys.length, 60);

  const sources = [
    "tools/create-invoice-visually/surface.tsx",
    "tools/create-invoice-visually/config.ts",
    "tools/create-invoice-visually/worker.ts",
    "tools/create-invoice-visually/model.ts",
    "tools/create-invoice-visually/render.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/civ\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  check("i18n: some civ.* keys referenced", referenced.size >= 30, [...referenced].length);
  for (const key of referenced) {
    const short = key.slice("civ.".length);
    check(`i18n: "${key}" resolves in en + hi`, short in toolI18n.en.civ && short in toolI18n.hi.civ);
  }
  for (const code of ["errSvg", "errLogo"]) {
    check(
      `i18n: classifyError key civ.${code} resolves in both languages`,
      code in toolI18n.en.civ && code in toolI18n.hi.civ
    );
  }
  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool: Record<string, string>;
  };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    tool: Record<string, string>;
  };
  check(
    "i18n: shared tool.errorGeneric + tool.errorTitle exist (the fallback the surface shows)",
    "errorGeneric" in catEn.tool && "errorTitle" in catEn.tool &&
      "errorGeneric" in catHi.tool && "errorTitle" in catHi.tool
  );
}

/* ------------------------------------------------------------------ */
console.log(
  `\ncreate-invoice-visually smoke: ${pass} passed, ${fail} failed` +
    (fail ? `\n  ${failures.join("\n  ")}` : "")
);
process.exit(fail > 0 ? 1 : 0);
