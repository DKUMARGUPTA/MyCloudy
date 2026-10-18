/**
 * PRE-BUILD smoke test for Create PDF (61st tool, PRD §7.3 — blank / lined /
 * grid / dotted / Cornell / weekly-planner paper).
 *
 * Part 1 (model, pure): the sanitizer's clamps + defaults, the page
 * geometry for all four paper sizes and both orientations, exact line /
 * grid / dot spacing math, everything-inside-the-margins guards, the
 * Cornell cue-column + summary-strip proportions, the planner's 7 day rows
 * (+ Hindi labels/needNoto) and the localized output naming.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim (+ a fetch shim serving the self-hosted Devanagari
 * TTF from public/). Runs: Hindi weekly planner (Noto path), lined Letter
 * landscape ×3 pages, dot grid (drawEllipse curve ops), Cornell ×2 pages —
 * every output is RELOADED with pdf-lib and asserted at parse level (page
 * count, page size, inflated content-stream line/curve/Tj ops, Type0 font
 * for the Devanagari subset) — plus the honest error codes for corrupt
 * input.
 *
 * Run: bun scripts/smoke-create-pdf.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";

import {
  C_DAY_NAMES,
  C_GRID_SIZES,
  C_LINE_SPACING,
  C_PAGE_SIZES,
  cOutputName,
  DEFAULT_C_SPEC,
  maxPagesFor,
  planPages,
  sanitizeCSpec,
  type CSpec,
} from "../tools/create-pdf/model";

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

function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

function spec(over: Partial<CSpec>): CSpec {
  return { ...DEFAULT_C_SPEC, ...over };
}

/* ------------------------------------------------------------------ */
/* Part 1 — pure model                                                 */
/* ------------------------------------------------------------------ */

{
  // ---- sanitizer: defaults + clamps ----
  assertEqual(
    sanitizeCSpec(null),
    DEFAULT_C_SPEC,
    "sanitize: null → full defaults"
  );
  assertEqual(
    sanitizeCSpec({ template: "bogus", pageSize: "a3", orientation: "diagonal" })
      .template,
    "lined",
    "sanitize: unknown template → lined default"
  );
  assertEqual(
    sanitizeCSpec({ template: "lined", pages: 55 }).pages,
    50,
    "sanitize: 55 pages clamps to 50"
  );
  assertEqual(
    sanitizeCSpec({ template: "planner", pages: 20 }).pages,
    12,
    "sanitize: planner 20 pages clamps to 12"
  );
  assertEqual(
    sanitizeCSpec({ pages: "7" }).pages,
    7,
    "sanitize: numeric string coerces"
  );
  assertEqual(sanitizeCSpec({ pages: -3 }).pages, 1, "sanitize: negative → 1");
  assertEqual(sanitizeCSpec({ pages: "NaN!" }).pages, 1, "sanitize: garbage → 1");
  assertEqual(
    sanitizeCSpec({ marginLine: "yes" }).marginLine,
    true,
    "sanitize: non-bool keeps default"
  );
  assertEqual(
    maxPagesFor("planner"),
    12,
    "caps: planner max 12 (one week per page)"
  );
  assertEqual(maxPagesFor("lined"), 50, "caps: paper max 50");

  // ---- page geometry ----
  const a4p = planPages(spec({ pages: 1 }));
  assert(
    near(a4p.width, 595.28) && near(a4p.height, 841.89),
    "geometry: A4 portrait 595.28×841.89",
    { w: a4p.width, h: a4p.height }
  );
  const a4l = planPages(spec({ pages: 1, orientation: "landscape" }));
  assert(
    near(a4l.width, 841.89) && near(a4l.height, 595.28),
    "geometry: A4 landscape swaps w/h",
    { w: a4l.width, h: a4l.height }
  );
  assert(
    near(C_PAGE_SIZES.legal.width, 612) && near(C_PAGE_SIZES.legal.height, 1008),
    "geometry: legal 612×1008"
  );

  // ---- blank ----
  const blank = planPages(spec({ template: "blank", pages: 5 }));
  assertEqual(blank.pages.length, 5, "blank: 5 pages");
  for (const page of blank.pages) {
    assert(
      page.lines.length === 0 &&
        page.dots.length === 0 &&
        page.rects.length === 0 &&
        page.labels.length === 0,
      "blank: page carries no ops"
    );
  }

  // ---- lined ----
  const lined = planPages(
    spec({ template: "lined", pages: 1, marginLine: true })
  );
  const ruled = lined.pages[0].lines.filter(
    (l) => Math.abs(l.y2 - l.y1) < 0.5
  );
  const verticals = lined.pages[0].lines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5);
  assert(ruled.length > 30, "lined: college ruling generates rules", ruled.length);
  assert(
    near(ruled[0].y1, 72 + C_LINE_SPACING.college),
    "lined: first rule one spacing above the bottom margin",
    ruled[0].y1
  );
  let spacingExact = true;
  let insideMargins = true;
  for (let i = 0; i < ruled.length; i += 1) {
    if (i > 0 && !near(ruled[i].y1 - ruled[i - 1].y1, C_LINE_SPACING.college, 1e-6)) {
      spacingExact = false;
    }
    if (ruled[i].y1 < 72 - 0.01 || ruled[i].y1 > 841.89 - 72 + 0.01) insideMargins = false;
    if (!near(ruled[i].x1, 72) || !near(ruled[i].x2, 595.28 - 72)) insideMargins = false;
  }
  assert(spacingExact, "lined: every gap is exactly 7.1 mm");
  assert(insideMargins, "lined: rules stay inside the margins");
  assertEqual(verticals.length, 1, "lined: margin line is the only vertical");
  assert(
    near(verticals[0].x1, 72 + 24) && verticals[0].color === "#e05252",
    "lined: red margin rule at left + 24 pt",
    { x: verticals[0].x1, color: verticals[0].color }
  );
  const linedWide = planPages(
    spec({ template: "lined", pages: 1, lineSpacing: "wide", marginLine: false })
  );
  const ruledWide = linedWide.pages[0].lines.filter(
    (l) => Math.abs(l.y2 - l.y1) < 0.5
  );
  assert(
    near(ruledWide.length ? ruledWide[1].y1 - ruledWide[0].y1 : 0, C_LINE_SPACING.wide, 1e-6) &&
      ruledWide.length < ruled.length,
    "lined: wide spacing 8.7 mm → fewer rules"
  );
  assertEqual(
    linedWide.pages[0].lines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5).length,
    0,
    "lined: marginLine off removes the vertical"
  );

  // ---- grid ----
  const grid = planPages(spec({ template: "grid", pages: 1 }));
  const g = C_GRID_SIZES["5mm"];
  const gx = grid.pages[0].lines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5);
  const gy = grid.pages[0].lines.filter((l) => Math.abs(l.y2 - l.y1) < 0.5);
  assert(gx.length > 30 && gy.length > 45, "grid: 5 mm mesh generated", {
    v: gx.length,
    h: gy.length,
  });
  let gridExact = true;
  for (let i = 1; i < gx.length; i += 1) {
    if (!near(gx[i].x1 - gx[i - 1].x1, g, 1e-6)) gridExact = false;
  }
  for (let i = 1; i < gy.length; i += 1) {
    if (!near(gy[i].y1 - gy[i - 1].y1, g, 1e-6)) gridExact = false;
  }
  assert(gridExact, "grid: spacing exactly 5 mm on both axes");
  assert(
    gx.every((l) => l.x1 >= 72 - 0.01 && l.x1 <= 595.28 - 72 + 0.01) &&
      gy.every((l) => l.y1 >= 72 - 0.01 && l.y1 <= 841.89 - 72 + 0.01),
    "grid: lines stay inside the margins"
  );
  assert(
    near(gx[0].x1 - 72, (595.28 - 144 - gx.length * g + g) / 2, 0.02) ||
      near(gx[0].x1 - 72, (595.28 - 144 - (gx.length - 1) * g) / 2, 0.02),
    "grid: partial cell centred on the left edge",
    gx[0].x1 - 72
  );
  const grid25 = planPages(spec({ template: "grid", gridSize: "2.5mm" }));
  const gx25 = grid25.pages[0].lines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5);
  assert(
    near(gx25[1].x1 - gx25[0].x1, C_GRID_SIZES["2.5mm"], 1e-6) &&
      gx25.length > gx.length * 1.9,
    "grid: 2.5 mm option doubles the density"
  );

  // ---- dotted ----
  const dotted = planPages(spec({ template: "dotted", pages: 1 }));
  const dots = dotted.pages[0].dots;
  assert(dots.length > 1200, "dotted: 5 mm dot grid generated", dots.length);
  const byRow = new Map<number, number>();
  for (const dot of dots) {
    const key = Math.round(dot.y * 1000);
    byRow.set(key, (byRow.get(key) ?? 0) + 1);
  }
  const rows = [...byRow.values()];
  assert(
    rows.every((count) => count === rows[0]),
    "dotted: every row carries the same dot count"
  );
  assert(
    dots.every((d) => d.r === 0.75 && d.color === "#b7bec6"),
    "dotted: 0.75 pt gray dots"
  );
  const dotYs = [...byRow.keys()].sort((a, b) => a - b);
  let dotSpacingExact = true;
  for (let i = 1; i < Math.min(dotYs.length, 5); i += 1) {
    if (!near((dotYs[i] - dotYs[i - 1]) / 1000, 5 * (72 / 25.4), 0.01)) {
      dotSpacingExact = false;
    }
  }
  assert(dotSpacingExact, "dotted: row pitch exactly 5 mm");

  // ---- cornell ----
  const cornell = planPages(
    spec({ template: "cornell", pages: 1, marginLine: true, headerLine: true })
  );
  const cLines = cornell.pages[0].lines;
  const cVerticals = cLines.filter((l) => Math.abs(l.x2 - l.x1) < 0.5);
  const cHorizontals = cLines.filter((l) => Math.abs(l.y2 - l.y1) < 0.5);
  const contentW = 595.28 - 144;
  const expectedCue = Math.min(180, Math.round(contentW * 0.35));
  assert(
    near(cVerticals[0].x1, 72 + expectedCue),
    "cornell: cue divider at ~2.5 in (clamped to 35%)",
    { x: cVerticals[0].x1, expectedCue }
  );
  const expectedSummary = Math.min(144, Math.round((841.89 - 144) * 0.25));
  assert(
    cHorizontals.some((l) => near(l.y1, 72 + expectedSummary)),
    "cornell: summary strip at 25% height (capped 2 in)",
    cHorizontals.map((l) => l.y1)
  );
  assert(
    cHorizontals.some((l) => near(l.y1, 841.89 - 72 - 36)),
    "cornell: header line 0.5 in below the top margin"
  );
  const cornellOff = planPages(
    spec({ template: "cornell", headerLine: false, marginLine: false })
  );
  assertEqual(cornellOff.pages[0].lines.length, 2, "cornell: toggles strip to divider + summary");
  const cornellLegal = planPages(
    spec({ template: "cornell", pageSize: "legal", margin: "none" })
  );
  assert(
    near(
      cornellLegal.pages[0].lines.find((l) => Math.abs(l.x2 - l.x1) < 0.5)!.x1,
      180
    ),
    "cornell: full-width legal paper hits the 2.5 in cap"
  );

  // ---- planner ----
  const planner = planPages(spec({ template: "planner", pages: 1, locale: "en" }));
  const pPage = planner.pages[0];
  assertEqual(pPage.labels.length, 8, "planner: 7 day labels + notes label");
  assert(
    pPage.labels
      .slice(0, 7)
      .every((label, i) => label.text === C_DAY_NAMES.en[i] && label.font === "helv"),
    "planner: Monday..Sunday labels on helvetica"
  );
  assertEqual(pPage.labels[7].text, "Notes", "planner: notes area labelled");
  const separators = pPage.lines.filter((l) => l.color === "#6f7680");
  assertEqual(separators.length, 7, "planner: 7 row separators (7th = notes boundary)");
  const notesH = Math.min(110, Math.round((841.89 - 144) * 0.18));
  assert(
    near(separators[separators.length - 1].y1, 72 + notesH, 0.05),
    "planner: last separator opens the notes area",
    separators[separators.length - 1].y1
  );
  assert(
    pPage.lines.some((l) => l.color === "#cfd4da"),
    "planner: faint writing lines present"
  );
  assertEqual(planner.needNoto, false, "planner: en needs no Noto");
  const plannerHi = planPages(
    spec({ template: "planner", pages: 3, locale: "hi" })
  );
  assertEqual(plannerHi.needNoto, true, "planner: hi sets needNoto");
  assertEqual(plannerHi.pages.length, 3, "planner: 3 pages honoured");
  assert(
    plannerHi.pages[0].labels
      .slice(0, 7)
      .every((label, i) => label.text === C_DAY_NAMES.hi[i] && label.font === "noto"),
    "planner: सोमवार..रविवार labels on noto"
  );

  // ---- output names ----
  assertEqual(
    cOutputName(spec({ template: "planner", pageSize: "a4" })),
    "weekly-planner-a4.pdf",
    "name: weekly-planner-a4.pdf"
  );
  assertEqual(
    cOutputName(spec({ template: "lined", pageSize: "letter", orientation: "landscape" })),
    "lined-paper-letter-landscape.pdf",
    "name: lined-paper-letter-landscape.pdf"
  );
  assertEqual(
    cOutputName(spec({ template: "planner", pageSize: "a4", locale: "hi" })),
    "साप्ताहिक-प्लानर-a4.pdf",
    "name: Hindi localized base"
  );
}

const part1Passed = passed;
const part1Failed = failed;

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

async function runWorker(
  options: Record<string, unknown>
): Promise<Posted[]> {
  inbox.length = 0;
  workerGlobal.onmessage?.({
    data: { type: "run", runId: 1, toolId: "create-pdf", options, files: [] },
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

interface RunResult {
  name?: string;
  detail?: Record<string, unknown>;
  bytes?: Uint8Array;
}

async function runToResult(
  runSpec: CSpec
): Promise<{ result: RunResult | null; error: Posted | null; out: Posted[] }> {
  const out = await runWorker({ doc: JSON.stringify(runSpec) });
  const result = out.find((m) => m.type === "result") as
    | (Posted & { outputs: { name: string; blob: Blob }[]; detail?: Record<string, unknown> })
    | undefined;
  const error = (out.find((m) => m.type === "error") as Posted | null) ?? null;
  if (!result) return { result: null, error, out };
  const blob = result.outputs[0]?.blob;
  const bytes = blob
    ? new Uint8Array(await blob.arrayBuffer())
    : undefined;
  return {
    result: {
      name: result.outputs[0]?.name,
      detail: result.detail,
      bytes,
    },
    error,
    out,
  };
}

/** Inflates + concatenates every content stream of a page (P8.4 recipe). */
function readContent(pageIndex: number, reload: PDFDocument): string {
  const page = reload.getPage(pageIndex);
  const contents = page.node.Contents();
  let text = "";
  const pushStream = (stream: unknown): void => {
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
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      pushStream(contents.lookup(i));
    }
  } else {
    pushStream(contents);
  }
  return text;
}

function pageHasType0(pageIndex: number, reload: PDFDocument): boolean {
  const resources = reload.getPage(pageIndex).node.Resources();
  const fontRes = resources?.lookup(PDFName.of("Font"));
  if (!(fontRes instanceof PDFDict)) return false;
  for (const key of fontRes.keys()) {
    const font = fontRes.lookup(key);
    if (font instanceof PDFDict) {
      const sub = font.get(PDFName.of("Subtype"));
      if (String(sub) === "/Type0") return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  await import("../tools/create-pdf/worker");

  // ---- error: empty doc ----
  {
    const out = await runWorker({ doc: "" });
    const error = out.find((m) => m.type === "error");
    assert(error !== undefined, "worker: empty doc → error");
    assertEqual(error?.code, "tool.errorGeneric", "worker: empty doc code");
  }
  // ---- error: corrupt JSON ----
  {
    const out = await runWorker({ doc: "{not json" });
    const error = out.find((m) => m.type === "error");
    assertEqual(
      error?.code,
      "tool.errorGeneric",
      "worker: corrupt JSON → generic error"
    );
  }

  // ---- Hindi weekly planner (Noto path) ----
  {
    const { result, error } = await runToResult(
      spec({ template: "planner", pages: 1, locale: "hi" })
    );
    assert(result !== null, "worker: hi planner result", error);
    if (!result?.bytes) return;
    assertEqual(
      result.name,
      "साप्ताहिक-प्लानर-a4.pdf",
      "worker: Hindi planner output name"
    );
    assert(
      Buffer.from(result.bytes.subarray(0, 5)).toString("latin1") === "%PDF-",
      "worker: output is a PDF"
    );
    const reload = await PDFDocument.load(result.bytes);
    assertEqual(reload.getPageCount(), 1, "worker: planner page count");
    const size = reload.getPage(0).getSize();
    assert(
      near(size.width, 595.28) && near(size.height, 841.89),
      "worker: planner A4 portrait size",
      { width: size.width, height: size.height }
    );
    assert(
      pageHasType0(0, reload),
      "worker: Type0 (Noto subset) embedded for Devanagari labels"
    );
    const content = readContent(0, reload);
    assert(
      /[\d.]+ [\d.]+ m[\s]/.test(content) && /[\d.]+ [\d.]+ l[\s]/.test(content),
      "worker: planner content has line path ops"
    );
    assert(
      /<[0-9A-Fa-f]+>\s*Tj/.test(content),
      "worker: planner day labels drawn (hex Tj)"
    );
    assertEqual(result.detail?.pages, 1, "worker: planner detail pages");
  }

  // ---- lined Letter landscape ×3 ----
  {
    const { result, error } = await runToResult(
      spec({
        template: "lined",
        pageSize: "letter",
        orientation: "landscape",
        pages: 3,
        marginLine: true,
      })
    );
    assert(result !== null, "worker: lined letter landscape result", error);
    if (!result?.bytes) return;
    assertEqual(
      result.name,
      "lined-paper-letter-landscape.pdf",
      "worker: lined output name"
    );
    const reload = await PDFDocument.load(result.bytes);
    assertEqual(reload.getPageCount(), 3, "worker: lined 3 pages");
    const size = reload.getPage(0).getSize();
    assert(
      near(size.width, 792) && near(size.height, 612),
      "worker: letter landscape size",
      { width: size.width, height: size.height }
    );
    const content = readContent(0, reload);
    assert(
      /[\d.]+ [\d.]+ m[\s]/.test(content),
      "worker: lined content has path ops"
    );
    assert(
      !pageHasType0(0, reload),
      "worker: no Type0 for Latin-only template"
    );
    assertEqual(result.detail?.pages, 3, "worker: lined detail pages");
    const content3 = readContent(2, reload);
    assert(
      /[\d.]+ [\d.]+ m[\s]/.test(content3),
      "worker: every page painted (page 3 too)"
    );
  }

  // ---- dot grid (drawEllipse curve ops) ----
  {
    const { result, error } = await runToResult(
      spec({ template: "dotted", pages: 1, margin: "narrow" })
    );
    assert(result !== null, "worker: dot grid result", error);
    if (!result?.bytes) return;
    assertEqual(
      result.name,
      "dot-grid-paper-a4.pdf",
      "worker: dot grid output name"
    );
    const reload = await PDFDocument.load(result.bytes);
    const content = readContent(0, reload);
    assert(
      /c[\s]/.test(content) && /f[\s]/.test(content),
      "worker: dots painted as filled ellipse curves"
    );
    const curveCount = (content.match(/ c[\s]/g) ?? []).length;
    assert(
      curveCount > 3000,
      "worker: full 5 mm dot mesh drawn (4 curves per dot)",
      curveCount
    );
  }

  // ---- Cornell ×2 ----
  {
    const { result, error } = await runToResult(
      spec({ template: "cornell", pages: 2, headerLine: true, marginLine: false })
    );
    assert(result !== null, "worker: cornell result", error);
    if (!result?.bytes) return;
    const reload = await PDFDocument.load(result.bytes);
    assertEqual(reload.getPageCount(), 2, "worker: cornell 2 pages");
    const content = readContent(0, reload);
    assert(
      /[\d.]+ [\d.]+ m[\s]/.test(content),
      "worker: cornell structural lines drawn"
    );
    assertEqual(
      result.name,
      "cornell-notes-a4.pdf",
      "worker: cornell output name"
    );
  }

  // ---- blank 4 pages (valid but empty) ----
  {
    const { result, error } = await runToResult(
      spec({ template: "blank", pages: 4 })
    );
    assert(result !== null, "worker: blank result", error);
    if (!result?.bytes) return;
    const reload = await PDFDocument.load(result.bytes);
    assertEqual(reload.getPageCount(), 4, "worker: blank 4 pages");
    assertEqual(result.name, "blank-pages-a4.pdf", "worker: blank output name");
  }

  // ---- garbage spec tolerated (sanitizer in the worker) ----
  {
    const out = await runWorker({
      doc: JSON.stringify({ template: 42, pages: "lots", locale: "fr" }),
    });
    const result = out.find((m) => m.type === "result");
    assert(result !== undefined, "worker: garbage spec sanitized, run succeeds");
  }

  const total = passed;
  const totalFailed = failed;
  console.log(
    `\nPart 1 (pure model): ${part1Passed} passed, ${part1Failed} failed`
  );
  console.log(
    `Part 2 (real worker): ${total - part1Passed} passed, ${totalFailed - part1Failed} failed`
  );
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});
