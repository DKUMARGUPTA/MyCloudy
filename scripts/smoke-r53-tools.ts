/**
 * Smoke: R53 tool batch — P1-d page utils (duplex-collate /
 * remove-annotations / page-dimensions).
 *
 * The REAL workers through a self-shimmed globalThis (postMessage capture +
 * onmessage dispatch, the smoke-split convention). pdf-lib is the DEV ORACLE
 * only (fixtures + output verification); the tools run 100% on our own
 * engine.
 *
 *  0. Wiring sanity: registry entries + configs + seo; own-engine discipline
 *     (no pdf-lib imports in workers); tool counts 124 total / 123 live /
 *     3 deferred.
 *  1. duplex-collate: pure plan math for all 4 layout×flip combos + odd
 *     padBlank; worker E2E on a simulated 6-page duplex scan (distinct page
 *     widths prove the order — pdf-lib reload); 5-page + padBlank run;
 *     2-page identity refusal.
 *  2. remove-annotations: markup strip keeps Links (pdf-lib reload counts
 *     subtypes); form fixture survives with widgets OFF (AcroForm intact +
 *     field still there); widgets ON across all pages strips widgets AND
 *     nulls catalog /AcroForm; page-range targeting leaves page 2 untouched;
 *     all-switches-off refusal; nothing-matches refusal.
 *  3. page-dimensions: pure paper-size + orientation classification; worker
 *     TXT report on a mixed A4/Letter/custom-landscape fixture (names,
 *     mixed flag, dominant, mm numbers); JSON structure (groups, pages with
 *     pt+mm+in); includePages off; unit switching.
 *
 * Run: bun scripts/smoke-r53-tools.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  StandardFonts,
} from "pdf-lib";

import { buildDuplexPlan, normalizeDuplexOptions } from "../tools/duplex-collate/worker-lib";
import {
  buildDimReport,
  classifyOrientation,
  matchPaperSize,
} from "../tools/page-dimensions/worker-lib";
import { parsePdf, listPages } from "../src/lib/own/pdf";

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
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "",
    );
  }
}

function near(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) < eps;
}

async function endText(end: RunEnd): Promise<string> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0]!.blob as unknown as Blob;
  return await blob.text();
}

async function endBytes(end: RunEnd): Promise<Uint8Array> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0]!.blob as unknown as Blob;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/* ── Fixtures ── */

/**
 * Simulated duplex scan of a 6-page document: fronts (1,3,5) then
 * book-flipped backs (6,4,2). Every sheet has a DISTINCT width so the
 * output order is provable from page sizes alone (widths 110..160 pt).
 */
async function buildDuplexScanFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // scanOrder[i] = which ORIGINAL page number sits at scan position i.
  const scanOrder = [1, 3, 5, 6, 4, 2];
  for (const original of scanOrder) {
    const page = doc.addPage([100 + original * 10, 300]);
    page.drawText(`P${original}`, { x: 20, y: 150, size: 24, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** Same scan shape but 5 pages (odd — last front has no scanned back). */
async function buildOddDuplexScanFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const scanOrder = [1, 3, 5, 4, 2];
  for (const original of scanOrder) {
    const page = doc.addPage([100 + original * 10, 300]);
    page.drawText(`P${original}`, { x: 20, y: 150, size: 24, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** 2 pages — every combination is the identity, must refuse. */
async function buildTwoPageFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText("ONE", { x: 20, y: 200, size: 20, font });
  doc.addPage([300, 400]).drawText("TWO", { x: 20, y: 200, size: 20, font });
  return doc.save({ useObjectStreams: false });
}

/**
 * 2 pages: page 1 carries a Text (comment) + Square (drawing) + Link annot;
 * page 2 carries a Text annot. Used for markup/links/pages-spec checks.
 */
async function buildAnnotatedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const mkAnnot = (subtype: string, rect: number[]) =>
    doc.context.obj({
      Type: "Annot",
      Subtype: subtype,
      Rect: rect,
      Border: [0, 0, 1],
      C: [1, 0, 0],
    });

  const p1 = doc.addPage([400, 300]);
  p1.drawText("PAGE ONE", { x: 20, y: 150, size: 24, font });
  const a1 = doc.context.register(mkAnnot("Text", [20, 250, 120, 290]));
  const a2 = doc.context.register(mkAnnot("Square", [150, 250, 300, 290]));
  const a3 = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [20, 20, 200, 60],
      Border: [0, 0, 1],
      A: { Type: "Action", S: "URI", URI: "https://example.com/x" },
    }),
  );
  p1.node.set(PDFName.of("Annots"), doc.context.obj([a1, a2, a3]));

  const p2 = doc.addPage([400, 300]);
  p2.drawText("PAGE TWO", { x: 20, y: 150, size: 24, font });
  const b1 = doc.context.register(mkAnnot("Text", [20, 250, 120, 290]));
  p2.node.set(PDFName.of("Annots"), doc.context.obj([b1]));
  return doc.save({ useObjectStreams: false });
}

/** 1 page with a live AcroForm text field (widget) PLUS a Text comment. */
async function buildFormFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([500, 400]);
  page.drawText("FORM", { x: 20, y: 350, size: 18, font });
  const form = doc.getForm();
  const field = form.createTextField("patient.name");
  field.setText("Ramesh");
  field.addToPage(page, { x: 50, y: 280, width: 300, height: 24 });
  // A review comment too, so the default run has markup to strip.
  const comment = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [20, 30, 120, 70],
      Border: [0, 0, 1],
      C: [1, 0, 0],
    }),
  );
  page.node.set(
    PDFName.of("Annots"),
    doc.context.obj([...(page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []), comment]),
  );
  return doc.save({ useObjectStreams: false });
}

/** Mixed sizes: A4 ×2, Letter ×1, custom landscape 900×500 ×1. */
async function buildMixedSizesFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: Array<[number, number]> = [
    [595.28, 841.89],
    [595.28, 841.89],
    [612, 792],
    [900, 500],
  ];
  let n = 1;
  for (const [w, h] of sizes) {
    doc.addPage([w, h]).drawText(`PAGE ${n}`, { x: 40, y: h - 60, size: 16, font });
    n += 1;
  }
  return doc.save({ useObjectStreams: false });
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

interface DriveFile {
  name: string;
  bytes: Uint8Array;
}

async function drive(
  path: string,
  runId: number,
  files: DriveFile[],
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
      files: files.map(
        (f) =>
          new File([f.bytes as BlobPart], f.name, { type: "application/pdf" })
      ),
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

function pageSrcs(plan: ReturnType<typeof buildDuplexPlan>["plan"]): string {
  return plan.map((e) => (e.kind === "page" ? e.src : "blank")).join(",");
}

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const seo = readFileSync("src/lib/seo/tool-seo.ts", "utf8");
  const ids = ["duplex-collate", "remove-annotations", "page-dimensions"];
  for (const id of ids) {
    check(`registry def: ${id}`, registry.includes(`id: "${id}"`));
    check(`configs map: ${id}`, configs.includes(id));
    check(`seo curated: ${id}`, seo.includes(`"${id}": {`));
  }
  for (const key of [
    "errorNothingToDo",
    "errorEncrypted",
    "errorCorrupt",
    "errorInvalidPages",
    "errorGeneric",
  ]) {
    const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
    const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
    check(
      `i18n: tool.${key} in en + hi`,
      en.tool?.[key] !== undefined && hi.tool?.[key] !== undefined,
    );
  }

  // Worker discipline: own engine only (no pdf-lib imports).
  for (const name of ids) {
    const src = readFileSync(join(import.meta.dir, `../tools/${name}/worker.ts`), "utf8");
    check(
      `${name}/worker.ts imports no pdf-lib (own engine only)`,
      !/(from\s+["'](?:@cantoo\/)?pdf-lib["']|import\(["'](?:@cantoo\/)?pdf-lib["']\))/.test(src),
    );
  }

  const { ALL_TOOLS } = await import("../src/lib/tools/registry");
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 124 total / 123 live / 1 deferred AI",
    ALL_TOOLS.length === 124 &&
      live === 123 &&
      JSON.stringify(deferred) ===
        JSON.stringify(["translate-pdf"]),
    { total: ALL_TOOLS.length, live, deferred },
  );
}

/* ================================================================== */
console.log("── 1. duplex-collate ─────────────────────────────────");
/* ================================================================== */
{
  // Pure plan math — 6-page scan, all 4 combos (expected src orders).
  const six = buildDuplexPlan(6, normalizeDuplexOptions({}));
  check(
    "plan: 6 fronts-first + long-edge → 0,5,1,4,2,3",
    pageSrcs(six.plan) === "0,5,1,4,2,3",
    pageSrcs(six.plan),
  );
  const short = buildDuplexPlan(6, normalizeDuplexOptions({ flip: "short-edge" }));
  check(
    "plan: 6 fronts-first + short-edge → 0,3,1,4,2,5",
    pageSrcs(short.plan) === "0,3,1,4,2,5",
    pageSrcs(short.plan),
  );
  const backsLong = buildDuplexPlan(6, normalizeDuplexOptions({ layout: "backs-first" }));
  check(
    "plan: 6 backs-first + long-edge → 3,2,4,1,5,0",
    pageSrcs(backsLong.plan) === "3,2,4,1,5,0",
    pageSrcs(backsLong.plan),
  );
  const backsShort = buildDuplexPlan(
    6,
    normalizeDuplexOptions({ layout: "backs-first", flip: "short-edge" }),
  );
  check(
    "plan: 6 backs-first + short-edge → 3,0,4,1,5,2",
    pageSrcs(backsShort.plan) === "3,0,4,1,5,2",
    pageSrcs(backsShort.plan),
  );

  // Odd page count with padBlank: 5-page scan [1,3,5,4,2] → 0,4,1,3,2,blank
  // (front1, back1=page2, front3, back2=page4, front5, padded blank).
  const odd = buildDuplexPlan(5, normalizeDuplexOptions({ padBlank: true }));
  check(
    "plan: 5 + padBlank → 0,4,1,3,2,blank",
    pageSrcs(odd.plan) === "0,4,1,3,2,blank" && odd.blanks === 1,
    pageSrcs(odd.plan),
  );
  const oddNoPad = buildDuplexPlan(5, normalizeDuplexOptions({}));
  check(
    "plan: 5 no pad → 0,4,1,3,2 (5 pages)",
    pageSrcs(oddNoPad.plan) === "0,4,1,3,2" && oddNoPad.plan.length === 5,
    pageSrcs(oddNoPad.plan),
  );
  const two = buildDuplexPlan(2, normalizeDuplexOptions({}));
  check("plan: 2 pages → identity (refuse)", two.changed === false);

  // Worker E2E: the simulated scan, default (fronts-first + long-edge).
  const scanBytes = await buildDuplexScanFixture();
  const end = await drive("duplex-collate", 101, [
    { name: "letter-scan.pdf", bytes: scanBytes },
  ], {});
  const out = await PDFDocument.load(await endBytes(end));
  check("worker: result is a PDF", end.type === "result");
  check("worker: 6 pages out", out.getPageCount() === 6, out.getPageCount());
  // Widths 110..160 ascending proves reading order 1..6.
  const widths = out.getPages().map((p) => p.getWidth());
  check(
    "worker: output order is 1,2,3,4,5,6 (ascending widths)",
    widths.join(",") === "110,120,130,140,150,160",
    widths.join(","),
  );
  check(
    "worker: result name -collated.pdf",
    end.type === "result" && end.outputs[0]!.name === "letter-scan-collated.pdf",
    end.type === "result" ? end.outputs[0]!.name : end.code,
  );

  // Odd scan + padBlank → 6 pages, last one blank (no text layer to check —
  // size matches the last front: width 160).
  const oddBytes = await buildOddDuplexScanFixture();
  const endOdd = await drive("duplex-collate", 102, [
    { name: "odd-scan.pdf", bytes: oddBytes },
  ], { padBlank: true });
  const outOdd = await PDFDocument.load(await endBytes(endOdd));
  const widthsOdd = outOdd.getPages().map((p) => p.getWidth());
  check(
    "worker: odd scan + padBlank → 6 pages, blank back of page 5",
    outOdd.getPageCount() === 6 && widthsOdd.join(",") === "110,120,130,140,150,150",
    widthsOdd.join(","),
  );

  // 2-page refusal.
  const twoBytes = await buildTwoPageFixture();
  const endTwo = await drive("duplex-collate", 103, [
    { name: "two.pdf", bytes: twoBytes },
  ], {});
  check(
    "worker: 2-page file → errorNothingToDo",
    endTwo.type === "error" && endTwo.code === "tool.errorNothingToDo",
    endTwo.type === "error" ? endTwo.code : "result",
  );
}

/* ================================================================== */
console.log("── 2. remove-annotations ─────────────────────────────");
/* ================================================================== */
{
  const fixtureBytes = await buildAnnotatedFixture();

  /** Subtype counts per page via the pdf-lib oracle. */
  const subtypesOf = async (
    bytes: Uint8Array,
    pageIndex: number,
  ): Promise<string[]> => {
    const doc = await PDFDocument.load(bytes);
    const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots === undefined) return [];
    const out: string[] = [];
    for (let i = 0; i < annots.size(); i += 1) {
      const dict = doc.context.lookup(annots.get(i), PDFDict);
      const st = dict?.get(PDFName.of("Subtype"));
      out.push(st ? st.toString().replace("/", "") : "?");
    }
    return out.sort();
  };

  // Default run: markup ON, links OFF, widgets OFF.
  const end = await drive("remove-annotations", 201, [
    { name: "review.pdf", bytes: fixtureBytes },
  ], {});
  const cleaned = await endBytes(end);
  check("worker: default run succeeds", end.type === "result");
  const p1 = await subtypesOf(cleaned, 0);
  const p2 = await subtypesOf(cleaned, 1);
  check(
    "worker: page 1 keeps ONLY the Link (Text+Square stripped)",
    JSON.stringify(p1) === JSON.stringify(["Link"]),
    p1,
  );
  check("worker: page 2 annots fully stripped", p2.length === 0, p2);

  // Links-only run: default keeps links → nothing matches → honest refusal.
  const endLinkKeep = await drive("remove-annotations", 202, [
    { name: "review.pdf", bytes: fixtureBytes },
  ], { markup: false, links: false, widgets: false });
  check(
    "worker: all switches off → errorNothingToDo",
    endLinkKeep.type === "error" && endLinkKeep.code === "tool.errorNothingToDo",
    endLinkKeep.type === "error" ? endLinkKeep.code : "result",
  );

  // Links removal: everything goes.
  const endLinks = await drive("remove-annotations", 203, [
    { name: "review.pdf", bytes: fixtureBytes },
  ], { links: true });
  const noLinks = await endBytes(endLinks);
  const p1NoLinks = await subtypesOf(noLinks, 0);
  check(
    "worker: links switch strips the Link too (page 1 empty)",
    p1NoLinks.length === 0,
    p1NoLinks,
  );

  // Page-range targeting: only page 1.
  const endRange = await drive("remove-annotations", 204, [
    { name: "review.pdf", bytes: fixtureBytes },
  ], { pages: "1" });
  const ranged = await endBytes(endRange);
  const r1 = await subtypesOf(ranged, 0);
  const r2 = await subtypesOf(ranged, 1);
  check(
    "worker: pages 1 only — page 1 cleaned, page 2 UNTOUCHED (Text kept)",
    JSON.stringify(r1) === JSON.stringify(["Link"]) &&
      JSON.stringify(r2) === JSON.stringify(["Text"]),
    { r1, r2 },
  );

  // Bad page spec.
  const endBad = await drive("remove-annotations", 205, [
    { name: "review.pdf", bytes: fixtureBytes },
  ], { pages: "abc" });
  check(
    "worker: bad page spec → errorInvalidPages",
    endBad.type === "error" && endBad.code === "tool.errorInvalidPages",
    endBad.type === "error" ? endBad.code : "result",
  );

  // Form fixture: default (widgets OFF) strips the comment but PRESERVES
  // the fillable form (widget + catalog AcroForm + value all intact).
  const formBytes = await buildFormFixture();
  const endFormKeep = await drive("remove-annotations", 206, [
    { name: "form.pdf", bytes: formBytes },
  ], {});
  const formKept = await endBytes(endFormKeep);
  const keptDoc = await PDFDocument.load(formKept);
  const keptAnnots = await subtypesOf(formKept, 0);
  check(
    "worker: default keeps form widgets (Widget present)",
    keptAnnots.includes("Widget"),
    keptAnnots,
  );
  const keptField = keptDoc.getForm().getTextField("patient.name");
  check(
    "worker: default keeps the field FILLABLE + value intact",
    keptField.getText() === "Ramesh",
    keptField.getText(),
  );

  // Form fixture: widgets ON (all pages) strips widgets + nulls /AcroForm.
  const endFormStrip = await drive("remove-annotations", 207, [
    { name: "form.pdf", bytes: formBytes },
  ], { widgets: true });
  const formStripped = await endBytes(endFormStrip);
  const stripDoc = await PDFDocument.load(formStripped);
  const stripAnnots = await subtypesOf(formStripped, 0);
  check(
    "worker: widgets ON strips the page widget",
    stripAnnots.filter((s) => s === "Widget").length === 0,
    stripAnnots,
  );
  const acro = stripDoc.catalog.get(PDFName.of("AcroForm"));
  check(
    "worker: widgets ON nulls catalog /AcroForm",
    acro === undefined || acro instanceof PDFNull,
    String(acro),
  );

  // No-annotation file with defaults → honest nothing-to-do.
  const plain = await buildTwoPageFixture();
  const endPlain = await drive("remove-annotations", 208, [
    { name: "plain.pdf", bytes: plain },
  ], {});
  check(
    "worker: annotation-free file → errorNothingToDo",
    endPlain.type === "error" && endPlain.code === "tool.errorNothingToDo",
    endPlain.type === "error" ? endPlain.code : "result",
  );
}

/* ================================================================== */
console.log("── 3. page-dimensions ────────────────────────────────");
/* ================================================================== */
{
  // Pure classification.
  check("pure: A4 portrait", matchPaperSize(595.28, 841.89) === "A4");
  check("pure: Letter landscape", matchPaperSize(792, 612) === "Letter");
  check("pure: Legal", matchPaperSize(612, 1008) === "Legal");
  check("pure: A3", matchPaperSize(841.89, 1190.55) === "A3");
  check("pure: Tabloid", matchPaperSize(1224, 792) === "Tabloid");
  check("pure: custom → null", matchPaperSize(500, 700) === null);
  check("pure: near-miss within 2pt still A4", matchPaperSize(596, 840.5) === "A4");
  check("pure: orientation portrait", classifyOrientation(500, 700) === "portrait");
  check("pure: orientation landscape", classifyOrientation(700, 500) === "landscape");
  check("pure: orientation square", classifyOrientation(500, 500) === "square");

  // Worker TXT on the mixed fixture (default: mm).
  const mixedBytes = await buildMixedSizesFixture();
  const end = await drive("page-dimensions", 301, [
    { name: "mixed.pdf", bytes: mixedBytes },
  ], {});
  const txt = await endText(end);
  check("worker: TXT result", end.type === "result");
  check("worker: page count line", txt.includes("Pages: 4"));
  check("worker: mixed flag", txt.includes("3 (mixed)"));
  check("worker: dominant A4 with 2 of 4", txt.includes("Dominant: A4 portrait") && txt.includes("2 of 4 pages"));
  check("worker: A4 mm numbers", txt.includes("210.0 mm × 297.0 mm") || txt.includes("210.0 mm × 298.0 mm"), txt.split("\n").find((l) => l.includes("Dominant")));
  check("worker: Letter named", txt.includes("Letter"));
  check(
    "worker: custom landscape row in mm",
    /Page 4: 317\.5 mm × 176\.4 mm — landscape/.test(txt),
    txt.split("\n").find((l) => l.includes("Page 4")),
  );
  check("worker: per-page rows present", /Page 1:/.test(txt) && /Page 4:/.test(txt));
  check(
    "worker: result name -dimensions.txt",
    end.type === "result" && end.outputs[0]!.name === "mixed-dimensions.txt",
  );

  // JSON structure.
  const endJson = await drive("page-dimensions", 302, [
    { name: "mixed.pdf", bytes: mixedBytes },
  ], { format: "json" });
  const json = JSON.parse(await endText(endJson));
  check("json: pageCount 4", json.pageCount === 4);
  check("json: uniqueSizes 3 + mixed", json.uniqueSizes === 3 && json.mixed === true);
  check("json: dominant A4 × 2", json.dominant.sizeName === "A4" && json.dominant.pages === 2);
  check("json: groups sorted by count", json.groups[0].pages.length === 2 && json.groups[0].sizeName === "A4");
  check("json: page 1 mm ≈ 210 × 297", near(json.pages[0].widthMm, 210, 0.5) && near(json.pages[0].heightMm, 297, 0.6), json.pages[0]);
  check("json: page 1 in ≈ 8.27 × 11.69", near(json.pages[0].widthIn, 8.27, 0.02) && near(json.pages[0].heightIn, 11.69, 0.02));
  check("json: page 4 landscape custom", json.pages[3].orientation === "landscape" && json.pages[3].sizeName === null);
  check("json: page 3 Letter", json.pages[2].sizeName === "Letter");

  // includePages off.
  const endSummary = await drive("page-dimensions", 303, [
    { name: "mixed.pdf", bytes: mixedBytes },
  ], { includePages: false });
  const summary = await endText(endSummary);
  check("worker: includePages off — no per-page rows", !/Page 1:/.test(summary) && summary.includes("SUMMARY"));

  // Unit switching (pt + in).
  const endPt = await drive("page-dimensions", 304, [
    { name: "mixed.pdf", bytes: mixedBytes },
  ], { unit: "pt" });
  const txtPt = await endText(endPt);
  check("worker: pt unit shows point numbers", txtPt.includes("595.28 pt × 841.89 pt"), txtPt.split("\n").find((l) => l.includes("Dominant")));
  const endIn = await drive("page-dimensions", 305, [
    { name: "mixed.pdf", bytes: mixedBytes },
  ], { unit: "in" });
  const txtIn = await endText(endIn);
  check("worker: in unit shows inch numbers", txtIn.includes("8.27 in × 11.69 in"), txtIn.split("\n").find((l) => l.includes("Dominant")));

  // Read-only discipline: own engine parse of the output byte-identical input.
  const parsed = parsePdf(mixedBytes);
  const pages = listPages(parsed);
  const report = buildDimReport(pages);
  check("pure: buildDimReport groups = 3", report.groups.length === 3);
  check("pure: dominant pages [1,2]", JSON.stringify(report.dominant?.pages) === JSON.stringify([1, 2]));
}

/* ================================================================== */
console.log("");
console.log(`R53 smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
