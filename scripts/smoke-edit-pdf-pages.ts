/**
 * PRE-BUILD smoke test for Edit PDF page operations (R12 — delete /
 * reorder / duplicate inside the flagship editor).
 *
 * Part 1 (model, pure): src normalisation, identity detection, the move
 * permutation, view splice/move/duplicate guards and the object remaps.
 *
 * Part 2 (drafts, pure): schema v2 round-trips (with page plan), v1
 * acceptance (objects only), malformed-plan rejection.
 *
 * Part 3 (page-plan, REAL pdf-lib): the exact shipping tree surgery —
 * reorder keeps AcroForm fields alive, delete drops pages, duplicates
 * are DISTINCT page nodes (no aliasing), the output re-opens cleanly.
 *
 * Part 4 (worker, REAL module): a page-ops blob through the actual
 * worker — plan applied, objects land on the moved pages, identity
 * blobs keep today's untouched path.
 *
 * Part 5 (wiring): source locks for the surface/parts/worker/i18n
 * integration + EN/HI key parity.
 *
 * Run: bun scripts/smoke-edit-pdf-pages.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { PageView } from "../tools/edit-pdf/model";

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
  options: Record<string, string>
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId: "smoke",
      files: [file],
      options,
      assets: [],
    },
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

/** Page text content (inflated), for operator/word assertions. */
async function pageText(
  page: import("pdf-lib").PDFPage
): Promise<string> {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((r) => page.doc.context.lookup(r) as PDFRawStream)
    : [contents as unknown as PDFRawStream];
  let text = "";
  for (const stream of streams) {
    try {
      text += latin1(inflateSync(stream.contents));
    } catch {
      text += latin1(stream.contents);
    }
  }
  return text;
}

function hexWord(word: string): string {
  return Buffer.from(word, "latin1").toString("hex").toUpperCase();
}

/** Source PDF: 4 pages, DISTINCT heights (100 + i*10) so the plan's
 * landing spots are measurable, plus distinct text per page. */
async function makeHeightsPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i += 1) {
    const page = doc.addPage([300, 100 + i * 10]);
    page.drawText(`SRCPAGE${i + 1}`, { x: 20, y: 40, size: 12, font });
  }
  return doc.save();
}

function view(src: number): PageView {
  return { x0: 0, y0: 0, x1: 300, y1: 100 + src * 10, rotate: 0, src };
}

async function main(): Promise<void> {
  /* ================= Part 1: the pure model ================= */
  const model = await import("../tools/edit-pdf/model");

  // normalizeViews
  const stale = [{ x0: 0, y0: 0, x1: 100, y1: 100, rotate: 0 }] as PageView[];
  assertEqual(
    model.normalizeViews(stale, 1).map((v) => v.src),
    [0],
    "normalizeViews: stale view (no src) → identity"
  );
  assertEqual(
    model.normalizeViews(
      [
        { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: -5 },
        { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: Number.NaN },
        { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: Number.POSITIVE_INFINITY },
      ] as PageView[],
      3
    ).map((v) => v.src),
    [0, 1, 2],
    "normalizeViews: garbage srcs → identity"
  );
  assertEqual(
    model.normalizeViews(
      [
        { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: 1 },
        { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: 7 },
      ] as PageView[],
      2
    ).map((v) => v.src),
    [1, 1],
    "normalizeViews: out-of-range src clamped into the document"
  );

  // isIdentityOrder
  assert(
    model.isIdentityOrder([view(0), view(1), view(2)], 3),
    "isIdentityOrder: identity true"
  );
  assert(model.isIdentityOrder([], 5), "isIdentityOrder: empty true");
  assert(
    model.isIdentityOrder([view(0), view(1)], 5),
    "isIdentityOrder: truncated (fewer views) true — tail stays untouched"
  );
  assert(
    !model.isIdentityOrder([view(1), view(0)], 2),
    "isIdentityOrder: swap false"
  );
  assert(
    !model.isIdentityOrder([view(0)], 1) === false &&
      !model.isIdentityOrder([view(0), view(1), view(1)], 2),
    "isIdentityOrder: duplicate false"
  );
  assert(
    !model.isIdentityOrder(
      [view(0), view(1), view(2), view(3), view(3)],
      4
    ),
    "isIdentityOrder: more views than sources false"
  );

  // movePermutation (old→new position; forward: from+1..to shift down,
  // backward: to..from-1 shift up)
  assertEqual(
    model.movePermutation(1, 3, 5),
    [0, 3, 1, 2, 4],
    "movePermutation: forward 1→3"
  );
  assertEqual(
    model.movePermutation(4, 0, 5),
    [1, 2, 3, 4, 0],
    "movePermutation: backward 4→0"
  );
  assertEqual(
    model.movePermutation(2, 2, 5),
    [0, 1, 2, 3, 4],
    "movePermutation: no-op identity"
  );
  assertEqual(
    model.movePermutation(-1, 3, 5),
    [0, 1, 2, 3, 4],
    "movePermutation: out-of-bounds identity"
  );

  // movePageViews / deletePageViews / duplicatePageViews
  const four = [view(0), view(1), view(2), view(3)];
  assertEqual(
    model.movePageViews(four, 1, 3).map((v) => v.src),
    [0, 2, 3, 1],
    "movePageViews: forward move"
  );
  assertEqual(
    model.movePageViews(four, 3, 0).map((v) => v.src),
    [3, 0, 1, 2],
    "movePageViews: backward move"
  );
  assert(
    model.movePageViews(four, 0, 9) === four,
    "movePageViews: out-of-bounds returns the same array (no-op)"
  );
  assertEqual(
    model.deletePageViews(four, 1).map((v) => v.src),
    [0, 2, 3],
    "deletePageViews: splice"
  );
  assert(
    model.deletePageViews([view(0)], 0).length === 1,
    "deletePageViews: last page guarded (never empties the workspace)"
  );
  const single = [view(0)];
  assert(
    model.deletePageViews(single, 0) === single,
    "deletePageViews: guarded no-op returns the SAME array reference"
  );
  const dup = model.duplicatePageViews(four, 1);
  assertEqual(
    dup.map((v) => v.src),
    [0, 1, 1, 2, 3],
    "duplicatePageViews: copy lands at pos+1 with the same src"
  );

  // object remaps
  const obj = (page: number) => ({ id: `o${page}`, page } as unknown as {
    id: string;
    page: number;
  });
  const objs = [obj(0), obj(1), obj(2), obj(3)] as unknown as import("../tools/edit-pdf/model").EditorObject[];
  assertEqual(
    model
      .remapObjectsForPageOp(objs, 1, "delete")
      .map((o) => (o as { page: number }).page),
    [0, 1, 2],
    "remapObjectsForPageOp delete: objects on the page dropped, above shift down"
  );
  assertEqual(
    model
      .remapObjectsForPageOp(objs, 1, "duplicate")
      .map((o) => (o as { page: number }).page),
    [0, 1, 3, 4],
    "remapObjectsForPageOp duplicate: above shift up, page itself NOT cloned"
  );
  assertEqual(
    model
      .remapObjectsByPermutation(objs, model.movePermutation(1, 3, 4))
      .map((o) => (o as { page: number }).page),
    [0, 3, 1, 2],
    "remapObjectsByPermutation: follows the permutation"
  );

  // workspacePositionsForSrc
  assertEqual(
    model.workspacePositionsForSrc([view(0), view(1), view(1), view(2)], 1),
    [1, 2],
    "workspacePositionsForSrc: duplicated src → both positions"
  );
  assertEqual(
    model.workspacePositionsForSrc([view(0)], 3),
    [],
    "workspacePositionsForSrc: missing → []"
  );

  /* ================= Part 2: drafts v2 ================= */
  const drafts = await import("../tools/edit-pdf/drafts");

  const views = [view(0), view(2), view(2)];
  const encoded = drafts.encodeDraft(
    [obj(0), obj(1)] as never,
    1,
    1.5,
    views as never
  );
  const decoded = drafts.decodeDraft(encoded, Date.now() + 1000);
  assert(decoded !== null, "draft v2 roundtrip: decodes");
  assertEqual(decoded?.v, 2, "draft v2 roundtrip: version");
  assertEqual(
    (decoded?.pageViews ?? []).map((v) => v.src),
    [0, 2, 2],
    "draft v2 roundtrip: page plan survives"
  );
  const encodedNoPlan = drafts.encodeDraft([obj(0)] as never, 0, 1);
  const decodedNoPlan = drafts.decodeDraft(
    encodedNoPlan,
    Date.now() + 1000
  );
  assert(decodedNoPlan?.pageViews === undefined, "draft: no plan → no key");
  const v1 = JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    objects: [obj(0)],
    page: 0,
    zoom: 1,
  });
  const decodedV1 = drafts.decodeDraft(v1, Date.now() + 1000);
  assert(decodedV1 !== null, "draft v1: still accepted (objects only)");
  assert(decodedV1?.pageViews === undefined, "draft v1: no views");
  const malformed = JSON.stringify({
    v: 2,
    savedAt: Date.now(),
    objects: [obj(0)],
    page: 0,
    zoom: 1,
    pageViews: [{ x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0 }],
  });
  assert(
    drafts.decodeDraft(malformed, Date.now() + 1000) === null,
    "draft v2: malformed plan (missing src) → null, never resumed"
  );
  const negative = JSON.stringify({
    v: 2,
    savedAt: Date.now(),
    objects: [obj(0)],
    page: 0,
    zoom: 1,
    pageViews: [
      { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 0, src: -1 },
    ],
  });
  assert(
    drafts.decodeDraft(negative, Date.now() + 1000) === null,
    "draft v2: negative src → null"
  );

  /* ================= Part 3: page-plan surgery (REAL pdf-lib) ===== */
  const pagePlan = await import("../tools/edit-pdf/page-plan");

  const heights = await makeHeightsPdf();

  // 3a. reorder [2,0,1,3]
  {
    const doc = await PDFDocument.load(heights);
    const originalPages = doc.getPages();
    const out = await pagePlan.applyPagePlan(
      doc,
      originalPages,
      [view(2), view(0), view(1), view(3)]
    );
    assertEqual(out.length, 4, "plan reorder: output page count");
    assertEqual(
      out.map((p) => p.getHeight()),
      [120, 100, 110, 130],
      "plan reorder: pages land in the planned order (heights identify)"
    );
    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    assertEqual(
      reloaded.getPages().map((p) => p.getHeight()),
      [120, 100, 110, 130],
      "plan reorder: saved file keeps the order"
    );
    assert(
      reloaded.getPages().every((p) => p.getWidth() === 300),
      "plan reorder: geometry intact"
    );
  }

  // 3b. delete + reorder [3,0] (sources 1,2 dropped)
  {
    const doc = await PDFDocument.load(heights);
    const out = await pagePlan.applyPagePlan(doc, doc.getPages(), [
      view(3),
      view(0),
    ]);
    assertEqual(out.length, 2, "plan delete: page count");
    assertEqual(
      out.map((p) => p.getHeight()),
      [130, 100],
      "plan delete: only kept sources remain"
    );
    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    assertEqual(reloaded.getPageCount(), 2, "plan delete: saved count");
  }

  // 3c. duplicate [0,0,0] — distinct nodes, no aliasing
  {
    const doc = await PDFDocument.load(heights);
    const out = await pagePlan.applyPagePlan(doc, doc.getPages(), [
      view(0),
      view(0),
      view(0),
    ]);
    assertEqual(out.length, 3, "plan duplicate: page count");
    assert(
      out[0] !== out[1] && out[1] !== out[2] && out[0] !== out[2],
      "plan duplicate: every copy is a DISTINCT page node (no aliasing)"
    );
    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    assertEqual(reloaded.getPageCount(), 3, "plan duplicate: saved count");
    assert(
      reloaded.getPages().every((p) => p.getHeight() === 100),
      "plan duplicate: all copies carry the source geometry"
    );
    // Writing through one copy must not leak into another: draw on copy 1
    // only, then count SRCPAGE1 occurrences across pages.
    const font = await reloaded.embedFont(StandardFonts.Helvetica);
    reloaded.getPages()[1].drawText("MARKER", { x: 10, y: 10, size: 8, font });
    const resaved = await reloaded.save();
    const again = await PDFDocument.load(resaved);
    let markerPages = 0;
    for (const page of again.getPages()) {
      if ((await pageText(page)).includes(hexWord("MARKER"))) markerPages += 1;
    }
    assertEqual(markerPages, 1, "plan duplicate: draw lands on ONE page only");
  }

  // 3d. AcroForm survival through a reorder
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([300, 200]);
    doc.addPage([300, 200]);
    p1.drawText("Form page", { x: 20, y: 150, size: 12, font });
    const form = doc.getForm();
    const field = form.createTextField("keepme");
    field.setText("hello");
    field.addToPage(p1, { x: 40, y: 80, width: 120, height: 20 });
    const bytes = await doc.save();

    const doc2 = await PDFDocument.load(bytes);
    const out = await pagePlan.applyPagePlan(doc2, doc2.getPages(), [
      { src: 1, x0: 0, y0: 0, x1: 300, y1: 200, rotate: 0 },
      { src: 0, x0: 0, y0: 0, x1: 300, y1: 200, rotate: 0 },
    ] as PageView[]);
    assertEqual(out.length, 2, "acroform: reordered count");
    const saved = await doc2.save();
    const reloaded = await PDFDocument.load(saved);
    const fields = reloaded.getForm().getFields();
    assertEqual(fields.length, 1, "acroform: field survives the reorder");
    assertEqual(fields[0]?.getName(), "keepme", "acroform: field name kept");
  }

  /* ================= Part 4: worker (REAL module) ================= */
  await import("../tools/edit-pdf/worker");

  const srcFile = new FakeFile("pages-doc.pdf", await makeHeightsPdf());
  const blob = (objects: unknown[], viewsIn: PageView[]): string =>
    JSON.stringify({ objects, pageViews: viewsIn, assetOrder: [] });

  // 4a. page-ops plan through the worker: reorder [1,3] + text objects on
  // both slots — the output must have 2 pages, first showing SRCPAGE2,
  // second SRCPAGE4, and the drawn markers on the right pages.
  {
    const objects = [
      {
        id: "t1",
        kind: "text",
        page: 0,
        x: 40,
        y: 40,
        w: 120,
        h: 16,
        text: "Zero slot",
        size: 12,
        font: "helvetica",
        bold: false,
        italic: false,
        color: "#111111",
        align: "left",
        opacity: 1,
        hidden: false,
        locked: false,
      },
      {
        id: "t2",
        kind: "text",
        page: 1,
        x: 40,
        y: 40,
        w: 120,
        h: 16,
        text: "One slot",
        size: 12,
        font: "helvetica",
        bold: false,
        italic: false,
        color: "#111111",
        align: "left",
        opacity: 1,
        hidden: false,
        locked: false,
      },
    ];
    const outcome = await runWorker(srcFile, {
      ekey: "pages-doc",
      "e:pages-doc": blob(objects, [view(1), view(3)]),
    });
    assert(outcome.error === null, "worker plan: no error", outcome.error);
    assert(outcome.result !== null, "worker plan: result posted");
    const outBytes = new Uint8Array(
      await outcome.outputs[0].blob.arrayBuffer()
    );
    const reloaded = await PDFDocument.load(outBytes);
    assertEqual(reloaded.getPageCount(), 2, "worker plan: output page count");
    assertEqual(
      reloaded.getPages().map((p) => p.getHeight()),
      [110, 130],
      "worker plan: reordered heights (src 1 then src 3)"
    );
    const textP0 = await pageText(reloaded.getPages()[0]);
    const textP1 = await pageText(reloaded.getPages()[1]);
    assert(
      textP0.includes(hexWord("SRCPAGE2")),
      "worker plan: slot 0 shows source page 2"
    );
    assert(
      textP1.includes(hexWord("SRCPAGE4")),
      "worker plan: slot 1 shows source page 4"
    );
    assert(
      textP0.includes(hexWord("Zero slot")),
      "worker plan: object for slot 0 drawn on slot 0"
    );
    assert(
      textP1.includes(hexWord("One slot")),
      "worker plan: object for slot 1 drawn on slot 1"
    );
  }

  // 4b. identity blob — today's untouched path (all 4 pages, first-view
  // geometry) with no objects.
  {
    const outcome = await runWorker(srcFile, {
      ekey: "pages-doc",
      "e:pages-doc": blob([], [view(0), view(1), view(2), view(3)]),
    });
    assert(outcome.error === null, "worker identity: no error", outcome.error);
    const outBytes = new Uint8Array(
      await outcome.outputs[0].blob.arrayBuffer()
    );
    const reloaded = await PDFDocument.load(outBytes);
    assertEqual(reloaded.getPageCount(), 4, "worker identity: all pages kept");
    assertEqual(
      reloaded.getPages().map((p) => p.getHeight()),
      [100, 110, 120, 130],
      "worker identity: original order"
    );
  }

  // 4c. delete-only plan [0,1,2] — object bound for a deleted page is
  // dropped honestly (sanitize clamps to the workspace count).
  {
    const objects = [
      {
        id: "gone",
        kind: "text",
        page: 3,
        x: 40,
        y: 40,
        w: 120,
        h: 16,
        text: "Should vanish",
        size: 12,
        font: "helvetica",
        bold: false,
        italic: false,
        color: "#111111",
        align: "left",
        opacity: 1,
        hidden: false,
        locked: false,
      },
    ];
    const outcome = await runWorker(srcFile, {
      ekey: "pages-doc",
      "e:pages-doc": blob(objects, [view(0), view(1), view(2)]),
    });
    assert(outcome.error === null, "worker delete: no error", outcome.error);
    const outBytes = new Uint8Array(
      await outcome.outputs[0].blob.arrayBuffer()
    );
    const reloaded = await PDFDocument.load(outBytes);
    assertEqual(reloaded.getPageCount(), 3, "worker delete: page count");
    let anyVanished = false;
    for (const page of reloaded.getPages()) {
      if ((await pageText(page)).includes(hexWord("Should vanish"))) {
        anyVanished = true;
      }
    }
    assert(!anyVanished, "worker delete: object on the deleted page dropped");
  }

  // 4d. tampered blob: > MAX_WORKSPACE_PAGES views → honest corrupt refusal
  {
    const huge = Array.from({ length: 2001 }, (_, i) => view(Math.min(i, 3)));
    const outcome = await runWorker(srcFile, {
      ekey: "pages-doc",
      "e:pages-doc": blob([], huge),
    });
    assert(
      outcome.error?.code === "tool.errorCorrupt",
      "worker tamper: oversized plan refused",
      outcome.error
    );
  }

  /* ================= Part 5: wiring locks ================= */
  const surfaceSrc = readFileSync("tools/edit-pdf/surface.tsx", "utf8");
  const partsSrc = readFileSync("tools/edit-pdf/editor-parts.tsx", "utf8");
  const workerSrc = readFileSync("tools/edit-pdf/worker.ts", "utf8");

  assert(
    workerSrc.includes('from "./page-plan"') &&
      workerSrc.includes("applyPagePlan"),
    "wiring: worker uses the shared page-plan module"
  );
  assert(
    workerSrc.includes("MAX_WORKSPACE_PAGES"),
    "wiring: worker keeps the workspace cap guard"
  );
  assert(
    workerSrc.includes("isIdentityOrder(planViews, srcCount)"),
    "wiring: worker identity gate before surgery"
  );
  assert(
    surfaceSrc.includes("JSON.stringify({ o: objectsRef.current, v: viewsRef.current })"),
    "wiring: history snapshots carry objects AND views"
  );
  assert(
    surfaceSrc.includes("const applyPageOp =") &&
      surfaceSrc.includes("const deletePage =") &&
      surfaceSrc.includes("const movePage =") &&
      surfaceSrc.includes("const duplicatePage ="),
    "wiring: page-op handlers present"
  );
  assert(
    surfaceSrc.includes("pageViews[selectedPage]?.src ?? selectedPage") === false &&
      surfaceSrc.includes("viewsRef.current[selectedPage]?.src ?? selectedPage"),
    "wiring: preview render goes through the slot's SOURCE page"
  );
  assert(
    surfaceSrc.includes("planKey"),
    "wiring: plan fingerprint drives re-renders"
  );
  assert(
    surfaceSrc.includes("workspacePositionsForSrc(pageViews, line.page)"),
    "wiring: find&replace applies to every slot showing the source"
  );
  assert(
    surfaceSrc.includes("harvestPageText(file, src)") &&
      surfaceSrc.includes("pieceCacheRef.current.get(src)"),
    "wiring: edit-text harvest keyed by source page"
  );
  assert(
    surfaceSrc.includes("encodeDraft(") &&
      surfaceSrc.includes("viewsRef.current\n        )"),
    "wiring: autosave carries the page plan"
  );
  assert(
    surfaceSrc.includes("<EditorPageStrip"),
    "wiring: the editor uses EditorPageStrip"
  );
  assert(
    surfaceSrc.includes("opsDisabled={truncated}"),
    "wiring: truncated (>500p) documents disable page ops"
  );
  assert(
    partsSrc.includes("export function EditorPageStrip") &&
      partsSrc.includes("useSortable({ id: slot })"),
    "wiring: sortable thumbnails"
  );
  assert(
    partsSrc.includes("horizontalListSortingStrategy"),
    "wiring: horizontal drag strategy"
  );
  assert(
    surfaceSrc.includes("onMove={movePage}") &&
      surfaceSrc.includes("onDelete={deletePage}") &&
      surfaceSrc.includes("onDuplicate={duplicatePage}"),
    "wiring: the strip gets all three page-op handlers"
  );
  assert(
    (partsSrc.match(/className="size-11 rounded-btn/g) ?? []).length >= 4,
    "wiring: ops buttons meet 44px at every breakpoint"
  );
  assert(
    partsSrc.includes("opsDisabled || pageCount <= 1"),
    "wiring: delete guarded on the last page"
  );
  assert(
    partsSrc.includes("sortableKeyboardCoordinates"),
    "wiring: keyboard sensor for a11y drags"
  );

  /* ---- i18n: the 15 new keys exist in BOTH languages ---- */
  const i18n = JSON.parse(
    readFileSync("tools/edit-pdf/i18n.json", "utf8")
  ) as Record<string, Record<string, Record<string, string>>>;
  const needed = [
    "pageDeletedToast",
    "pageDuplicatedToast",
    "pagesLabel",
    "pagesHint",
    "pagesOpsLabel",
    "pageMoveLeft",
    "pageMoveRight",
    "pageDuplicate",
    "pageDelete",
    "pagesDisabledTruncated",
    "pagesLockedCap",
    "pagesLastPage",
    "stripLabel",
    "stripPageLabel",
    "stripMovedTitle",
  ];
  for (const key of needed) {
    const en = i18n.en?.editPdf?.[key];
    const hi = i18n.hi?.editPdf?.[key];
    assert(
      typeof en === "string" && en.length > 0,
      `i18n en: editPdf.${key}`
    );
    assert(
      typeof hi === "string" && hi.length > 0,
      `i18n hi: editPdf.${key}`
    );
  }
  const devRe = /[\u0900-\u097F]/;
  assert(
    devRe.test(i18n.hi.editPdf.pagesLabel ?? ""),
    "i18n hi: real Devanagari in pagesLabel"
  );
  assert(
    (i18n.hi.editPdf.pageMoveLeft ?? "").includes("{page}") &&
      (i18n.en.editPdf.pageMoveLeft ?? "").includes("{page}"),
    "i18n: ICU page param present in both languages"
  );

  // global parity: identical key sets in en and hi
  const enKeys = Object.keys(i18n.en.editPdf).sort();
  const hiKeys = Object.keys(i18n.hi.editPdf).sort();
  assertEqual(enKeys, hiKeys, "i18n: en/hi key parity for editPdf");

  console.log(
    `\nsmoke-edit-pdf-pages: ${passed} passed, ${failed} failed`
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
