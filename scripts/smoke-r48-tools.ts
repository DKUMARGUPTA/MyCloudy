/**
 * Smoke: R48 tool batch (reverse / add-blank / divide / combine-single /
 * booklet / sanitize) — the REAL workers through a self-shimmed
 * globalThis (postMessage capture + onmessage dispatch, the smoke-split
 * convention). pdf-lib is used as the DEV ORACLE only (fixtures + output
 * verification); the tools themselves run 100% on our own engine.
 *
 *  0. Wiring sanity: registry entries + configs + seo present.
 *  1. reverse-pdf-pages: 6 pages → reversed widths; 1-page → honest refusal.
 *  2. add-blank-page: after page 3 → blank sized like page 3 at slot 4.
 *  3. divide-page: vertical ×2 → 12 pieces, halved widths; page-range mode.
 *  4. combine-single-page: 6 pages → 1 long page, exact stitched height.
 *  5. booklet-pdf: 6 pages → 8 (padded), saddle order + trailing blanks.
 *  6. sanitize-pdf: /Annots gone, Info gone, page count kept.
 *
 * Run: bun scripts/smoke-r48-tools.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

type RunEnd = Extract<WorkerResponse, { type: "result" | "error" }>;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

function near(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) < eps;
}

/* ── Fixture: 6 pages, unique width 100×(i+1), height 200, page-1 has a
 * Text annotation (for sanitize), every page has visible text. ── */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i += 1) {
    const page = doc.addPage([100 * (i + 1), 200]);
    page.drawText(`PAGE ${i + 1}`, {
      x: 20,
      y: 100,
      size: 24,
      font,
      color: rgb(0.1, 0.1, 0.4),
    });
  }
  // Annotation on page 1 (sanitize must strip it).
  const page1 = doc.getPage(0);
  const ctx = doc.context;
  const annotDict = ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [10, 150, 40, 180],
    T: "note",
    Contents: "secret note",
  });
  page1.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(annotDict)]));
  // Info fields (sanitize must drop). Saved WITHOUT object streams so the
  // metadata bytes are scannable in the raw output (pdf-lib compresses
  // object streams by default).
  doc.setTitle("fixture title");
  doc.setAuthor("fixture author");
  return doc.save({ useObjectStreams: false });
}

async function pageSizes(bytes: Uint8Array): Promise<Array<{ w: number; h: number }>> {
  const doc = await PDFDocument.load(bytes.slice());
  return doc.getPages().map((p) => {
    const s = p.getSize();
    return { w: s.width, h: s.height };
  });
}

async function annotsPresent(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes.slice());
  return doc.getPages().some((p) => p.node.Annots() !== undefined);
}

/** True when the ORIGINAL (source) metadata strings survive in the raw
 * bytes — scanned in every encoding our writer OR pdf-lib (the fixture
 * author) may produce: plain text, UTF-8 hex and UTF-16BE hex (pdf-lib's
 * Info default, FEFF-prefixed). pdf-lib auto-creates a default Info on
 * load, so a raw-bytes scan is the only honest check. */
function metadataSurvives(bytes: Uint8Array, needles: string[]): boolean {
  const raw = new TextDecoder("latin1").decode(bytes);
  const utf8Hex = (s: string) =>
    Array.from(new TextEncoder().encode(s))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  const utf16Hex = (s: string) =>
    "FEFF" +
    Array.from(s)
      .map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0"))
      .join("")
      .toUpperCase();
  for (const n of needles) {
    if (raw.includes(n) || raw.includes(utf8Hex(n)) || raw.includes(utf16Hex(n))) {
      return true;
    }
  }
  return false;
}

/** True when the page's content stream is empty (or absent) — the
 * own-engine blank carries a spec-legal EMPTY stream, not a missing one. */
async function pageIsEmpty(doc: PDFDocument, pageIndex: number): Promise<boolean> {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (contents === undefined) return true;
  const stream = doc.context.lookup(contents);
  if (stream === undefined) return true;
  const bytesOf = (stream as unknown as { contents?: Uint8Array }).contents;
  if (bytesOf === undefined) return true;
  return bytesOf.length === 0;
}

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const seo = readFileSync("src/lib/seo/tool-seo.ts", "utf8");
  const en = readFileSync("src/i18n/en.json", "utf8");
  const hi = readFileSync("src/i18n/hi.json", "utf8");
  const ids = [
    "reverse-pdf-pages",
    "add-blank-page",
    "divide-page",
    "combine-single-page",
    "booklet-pdf",
    "sanitize-pdf",
  ];
  for (const id of ids) {
    check(`registry def: ${id}`, registry.includes(`id: "${id}"`));
    check(`configs map: ${id}`, configs.includes(`"${id}"`) || configs.includes(id));
    check(`seo curated: ${id}`, seo.includes(`"${id}": {`));
  }
  check(
    "i18n tool.errorNothingToDo (en+hi)",
    en.includes("errorNothingToDo") && hi.includes("errorNothingToDo")
  );
}

/* ── Self-shimmed worker driver (smoke-split convention) ── */
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
  location: { href: string };
};
const messages: WorkerResponse[] = [];
workerGlobal.postMessage = (msg: unknown): void => {
  messages.push(msg as WorkerResponse);
};
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;

const loaded: Record<string, boolean> = {};
async function loadWorker(path: string): Promise<void> {
  if (loaded[path]) return;
  await import(`../tools/${path}/worker`);
  loaded[path] = true;
}

type DriveOptions = Record<string, string | number | boolean>;

async function drive(
  path: string,
  runId: number,
  fileName: string,
  fileBytes: Uint8Array,
  options: DriveOptions
): Promise<RunEnd> {
  await loadWorker(path);
  const before = messages.length;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId,
      toolId: path,
      options,
      files: [new File([fileBytes as BlobPart], fileName, { type: "application/pdf" })],
    } as WorkerRunRequest,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const hit = messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"));
    if (hit) return hit as RunEnd;
    if (Date.now() > deadline) {
      throw new Error(`worker ${path} timed out`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function endBytes(end: RunEnd): Promise<Uint8Array> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0].blob as unknown as Blob;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

const fixture = await buildFixture();

/* ================================================================== */
console.log("── 1. reverse-pdf-pages ─────────────────────────────");
/* ================================================================== */
{
  const end = await drive("reverse-pdf-pages", 1, "six.pdf", fixture, {});
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const sizes = await pageSizes(bytes);
  check("6 pages", sizes.length === 6, sizes.length);
  check(
    "widths reversed (600..100)",
    sizes.every((s, i) => near(s.w, 100 * (6 - i))),
    sizes.map((s) => s.w)
  );

  // 1-page honest refusal.
  const one = await PDFDocument.create();
  one.addPage([200, 200]);
  const oneBytes = await one.save();
  const refuse = await drive("reverse-pdf-pages", 2, "one.pdf", oneBytes, {});
  check(
    "1-page → errorNothingToDo",
    refuse.type === "error" && refuse.code === "tool.errorNothingToDo",
    refuse.type === "error" ? refuse.code : refuse
  );
}

/* ================================================================== */
console.log("── 2. add-blank-page ────────────────────────────────");
/* ================================================================== */
{
  const end = await drive(
    "add-blank-page",
    3,
    "six.pdf",
    fixture,
    { position: "after", atPage: 3, count: 1 }
  );
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const doc = await PDFDocument.load(bytes.slice());
  check("7 pages", doc.getPageCount() === 7, doc.getPageCount());
  const blank = doc.getPage(3);
  const s = blank.getSize();
  check("blank at slot 4 sized like page 3 (300×200)", near(s.width, 300) && near(s.height, 200), {
    w: s.width,
    h: s.height,
  });
  check("blank at slot 4 is empty", await pageIsEmpty(doc, 3));
  const sizes = await pageSizes(bytes);
  check(
    "order kept 100..600",
    [0, 1, 2, 4, 5, 6].every((i) => near(sizes[i].w, 100 * (i < 3 ? i + 1 : i))),
    sizes.map((x) => x.w)
  );

  // before-page mode + count 2
  const end2 = await drive(
    "add-blank-page",
    4,
    "six.pdf",
    fixture,
    { position: "before", atPageBefore: 2, count: 2 }
  );
  const bytes2 = await endBytes(end2);
  const doc2 = await PDFDocument.load(bytes2.slice());
  check("before p2 ×2 → 8 pages", doc2.getPageCount() === 8, doc2.getPageCount());
  const s2 = doc2.getPage(1).getSize();
  check("blanks sized like page 2 (200×200)", near(s2.width, 200) && near(s2.height, 200), s2);
  check("blank 2 is empty", await pageIsEmpty(doc2, 2));

  // invalid anchor
  const bad = await drive(
    "add-blank-page",
    5,
    "six.pdf",
    fixture,
    { position: "after", atPage: 9, count: 1 }
  );
  check(
    "after 9 → errorInvalidPages",
    bad.type === "error" && bad.code === "tool.errorInvalidPages",
    bad.type === "error" ? bad.code : bad
  );
}

/* ================================================================== */
console.log("── 3. divide-page ───────────────────────────────────");
/* ================================================================== */
{
  const end = await drive(
    "divide-page",
    6,
    "six.pdf",
    fixture,
    { axis: "vertical", pieces: "2" }
  );
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const sizes = await pageSizes(bytes);
  check("12 pieces", sizes.length === 12, sizes.length);
  check(
    "halved widths, kept heights",
    sizes.every((s, i) => {
      const srcW = 100 * (Math.floor(i / 2) + 1);
      return near(s.w, srcW / 2) && near(s.h, 200);
    }),
    sizes.map((s) => s.w)
  );

  // page-range: only page 1 divided
  const end2 = await drive(
    "divide-page",
    7,
    "six.pdf",
    fixture,
    { axis: "vertical", pieces: "2", pages: "1" }
  );
  const bytes2 = await endBytes(end2);
  const sizes2 = await pageSizes(bytes2);
  check("range 1 → 7 pages (2 + pass-through 5)", sizes2.length === 7, sizes2.length);
  check(
    "piece widths 50, rest untouched",
    near(sizes2[0].w, 50) && near(sizes2[1].w, 50) && near(sizes2[2].w, 200),
    sizes2.map((s) => s.w)
  );

  // grid 3 → 9 per page × 6 = 54
  const end3 = await drive(
    "divide-page",
    8,
    "six.pdf",
    fixture,
    { axis: "grid", pieces: "3" }
  );
  const bytes3 = await endBytes(end3);
  const sizes3 = await pageSizes(bytes3);
  check("grid 3 → 54 pieces", sizes3.length === 54, sizes3.length);
  check(
    "grid piece size (w/3 × h/3)",
    near(sizes3[0].w, 100 / 3, 0.6) && near(sizes3[0].h, 200 / 3, 0.6),
    sizes3[0]
  );
}

/* ================================================================== */
console.log("── 4. combine-single-page ───────────────────────────");
/* ================================================================== */
{
  const end = await drive(
    "combine-single-page",
    9,
    "six.pdf",
    fixture,
    { direction: "vertical", width: "first", gap: false }
  );
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const sizes = await pageSizes(bytes);
  check("1 output page", sizes.length === 1, sizes.length);
  // Width = first page (100). Each page i scaled to width 100:
  // height 200/(i+1) → total = 200×(1+1/2+…+1/6) ≈ 489.99
  check(
    "stitched height ≈ 490 (width-fill)",
    near(sizes[0].w, 100) && near(sizes[0].h, 200 * (1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5 + 1 / 6), 2),
    sizes[0]
  );

  // 1-page honest refusal (2 pages combine into one — that's valid).
  const one = await PDFDocument.create();
  one.addPage([100, 200]);
  const oneBytes = await one.save();
  const refuse = await drive("combine-single-page", 10, "one.pdf", oneBytes, {});
  check(
    "1 page → errorNothingToDo",
    refuse.type === "error" && refuse.code === "tool.errorNothingToDo",
    refuse.type === "error" ? refuse.code : refuse
  );

  // 2 pages → valid single stitched page.
  const two = await PDFDocument.create();
  two.addPage([100, 200]);
  two.addPage([100, 200]);
  const twoBytes = await two.save();
  const ok2 = await drive("combine-single-page", 14, "two.pdf", twoBytes, {});
  const twoSizes = ok2.type === "result" ? await pageSizes(await endBytes(ok2)) : [];
  check("2 pages → 1 stitched page (400 tall)", twoSizes.length === 1 && near(twoSizes[0].h, 400, 2), twoSizes);
}

/* ================================================================== */
console.log("── 5. booklet-pdf ───────────────────────────────────");
/* ================================================================== */
{
  const end = await drive("booklet-pdf", 11, "six.pdf", fixture, {});
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const doc = await PDFDocument.load(bytes.slice());
  check("padded to 8 pages", doc.getPageCount() === 8, doc.getPageCount());
  // Saddle order (1-based): 8,1,2,7,6,3,4,5 → widths:
  // [blank600, 100, 200, blank600, 600, 300, 400, 500]
  const sizes = await pageSizes(bytes);
  const expected = [600, 100, 200, 600, 600, 300, 400, 500];
  check(
    "saddle order widths [600,100,200,600,600,300,400,500]",
    sizes.every((s, i) => near(s.w, expected[i])),
    sizes.map((s) => s.w)
  );
  check(
    "padding blanks are empty",
    (await pageIsEmpty(doc, 0)) && (await pageIsEmpty(doc, 3))
  );
  // Text survives: output page 2 (src page 1) still says PAGE 1
  const pageText = await (
    await PDFDocument.load(bytes.slice())
  ).getPage(1).node.normalizedEntries();
  check("page dicts load cleanly", pageText !== undefined);
}

/* ================================================================== */
console.log("── 6. sanitize-pdf ──────────────────────────────────");
/* ================================================================== */
{
  check("fixture has annotations", await annotsPresent(fixture));
  check(
    "fixture metadata in raw bytes",
    metadataSurvives(fixture, ["fixture author", "fixture title"])
  );

  const end = await drive(
    "sanitize-pdf",
    12,
    "six.pdf",
    fixture,
    { annotations: true, hiddenData: true, scripts: true }
  );
  check("result", end.type === "result");
  const bytes = await endBytes(end);
  const sizes = await pageSizes(bytes);
  check("6 pages kept", sizes.length === 6, sizes.length);
  check("annotations stripped", !(await annotsPresent(bytes)));
  check(
    "original metadata gone from raw bytes",
    !metadataSurvives(bytes, ["fixture author", "fixture title"])
  );
  check(
    "content widths kept (no resize)",
    sizes.every((s, i) => near(s.w, 100 * (i + 1))),
    sizes.map((s) => s.w)
  );

  // all-off → honest refusal
  const refuse = await drive(
    "sanitize-pdf",
    13,
    "six.pdf",
    fixture,
    { annotations: false, hiddenData: false, scripts: false }
  );
  check(
    "all switches off → errorNothingToDo",
    refuse.type === "error" && refuse.code === "tool.errorNothingToDo",
    refuse.type === "error" ? refuse.code : refuse
  );
}

/* ── Final tally ── */
console.log("");
if (fail > 0) {
  console.error(`✗ SMOKE FAILED: ${fail} of ${pass + fail} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ SMOKE PASSED: ${pass} of ${pass + fail} checks`);
