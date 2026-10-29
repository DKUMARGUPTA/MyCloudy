/**
 * P8.6 smoke — editor mobile polish round.
 *
 * Part 1 (model + drafts, pure): rotation normalization + anchor math
 * (center invariance), rotateDisplayPoint, rotated hit-testing, the snap
 * guide solver (page center/edge + other objects + threshold + nearest),
 * marquee multi-select intersection, unionRects, sanitize rotation garbage,
 * rotatable-kind gating, and the drafts wire format (key stability, schema
 * version reject, stale reject, empty reject, round-trip, image detection).
 *
 * Part 2 (worker, REAL module): a rotated battery (text 90°, rect 30°,
 * whiteout 45°, line 90°, arrow 45°) exported onto a real source PDF and
 * re-opened with pdf-lib; byte-audits prove the rotation reached the output:
 *  - rotated TEXT writes a rotation Tm matrix ("0 1 -1 0 x y Tm" at 90°)
 *  - a 90° RECT becomes the exact rotated-corner polygon from the anchor math
 *  - rotation 0 is the legacy path — byte-identical to an objects blob that
 *    omits the rotation key entirely (backward compat with stored drafts)
 *
 * Run: bun scripts/smoke-edit-pdf-mobile.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, PDFRawStream, PDFArray } from "pdf-lib";
import type { EditorObject, PageView } from "../tools/edit-pdf/model";

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

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
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
  result:
    | (Posted & { type: "result"; detail?: Record<string, unknown> })
    | null;
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

async function outcomeBytes(outcome: RunOutcome): Promise<Uint8Array> {
  if (!outcome.result) throw new Error("no result message");
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

const VIEWS: PageView[] = [
  { x0: 0, y0: 0, x1: 595.28, y1: 841.89, rotate: 0 },
];

async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("P8.6 mobile source", { x: 48, y: 780, size: 14, font });
  return doc.save();
}

/** Concatenates every content stream of page 0 (resolving PDFRefs,
 * inflating Flate blobs). */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (node instanceof PDFRawStream) {
      let raw: Buffer = Buffer.from(node.contents);
      try {
        raw = inflateSync(raw);
      } catch {
        /* not Flate — keep raw */
      }
      chunks.push(raw.toString("latin1"));
      return;
    }
    if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i += 1) walk(node.get(i));
      return;
    }
    // PDFRef → dereference through the context
    const maybeRef = node as { tag?: string; objectNumber?: number };
    if (
      maybeRef &&
      typeof maybeRef.objectNumber === "number" &&
      typeof maybeRef.tag === "string"
    ) {
      const resolved = doc.context.lookup(maybeRef as never);
      if (resolved && resolved !== node) walk(resolved);
      return;
    }
  };
  walk(page.node.Contents());
  return chunks.join("\n");
}

async function main(): Promise<void> {
  /* ---- Part 1: the pure model ---- */
  const model = await import("../tools/edit-pdf/model");
  const drafts = await import("../tools/edit-pdf/drafts");

  // -- normalizeRotation -------------------------------------------------
  assertEqual(model.normalizeRotation(0), 0, "normalize: 0 → 0");
  assertEqual(model.normalizeRotation(360), 0, "normalize: 360 → 0");
  assertEqual(model.normalizeRotation(380), 20, "normalize: 380 → 20");
  assertEqual(model.normalizeRotation(-380), -20, "normalize: -380 → -20");
  assertEqual(model.normalizeRotation(270), -90, "normalize: 270 → -90");
  assertEqual(model.normalizeRotation(-180), 180, "normalize: -180 → 180");
  assertEqual(model.normalizeRotation(90.06), 90.1, "normalize: 0.1° granularity rounds");
  assertEqual(model.normalizeRotation(Number.NaN), 0, "normalize: NaN → 0");
  assertEqual(model.normalizeRotation(Number.POSITIVE_INFINITY), 0, "normalize: Infinity → 0");

  // -- rotationAnchor: center invariance ---------------------------------
  // pdf-lib draws from the anchor then rotates AROUND it, so a naive anchor
  // orbits the center. rotationAnchor must put the anchor at
  // C − R·(w/2, h/2), which pins the visual center for ANY angle.
  const rect = { x: 100, y: 200, w: 100, h: 50 };
  for (const deg of [15, 30, 45, 90, 123.4, 180, -67.5, -95]) {
    const anchor = model.rotationAnchor(rect, deg);
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    // Center of the drawn (rotated) rect = anchor + R·(w/2, h/2)
    const cx = anchor.x + cos * (rect.w / 2) - sin * (rect.h / 2);
    const cy = anchor.y + sin * (rect.w / 2) + cos * (rect.h / 2);
    assert(
      near(cx, rect.x + rect.w / 2) && near(cy, rect.y + rect.h / 2),
      `anchor: center pinned at ${deg}°`
    );
  }
  // At 0° the anchor is exactly the rect origin (legacy path).
  const anchor0 = model.rotationAnchor(rect, 0);
  assert(
    near(anchor0.x, rect.x) && near(anchor0.y, rect.y),
    "anchor: 0° = rect origin (legacy)"
  );

  // -- rotateDisplayPoint: 90° visual-CCW in y-DOWN space → right point
  // moves UP (screen CCW = math CW when y grows downward).
  const rp = model.rotateDisplayPoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
  assert(near(rp.x, 0, 1e-9) && near(rp.y, -10, 1e-9), "rotateDisplayPoint: 90° CCW (y-down)");
  const rp2 = model.rotateDisplayPoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 0);
  assert(near(rp2.x, 10) && near(rp2.y, 0), "rotateDisplayPoint: identity");

  // -- displayAngle --------------------------------------------------------
  assert(
    near(model.displayAngle({ x: 10, y: 0 }, { x: 0, y: 0 }), 0) &&
      near(model.displayAngle({ x: 0, y: -10 }, { x: 0, y: 0 }), 90),
    "displayAngle: axes (y-down display space)"
  );

  // -- hitRectRotated -------------------------------------------------------
  const disp = { x: 0, y: 0, w: 100, h: 100 };
  assert(
    model.hitRectRotated(disp, 45, 90, 10) === false,
    "hit: bbox corner outside the 45° diamond"
  );
  assert(
    model.hitRectRotated(disp, 45, 50, 50) === true,
    "hit: center inside the 45° diamond"
  );
  assert(
    model.hitRectRotated(disp, 45, 50, 5) === true,
    "hit: near-top inside the 45° diamond"
  );
  // 90° on a NON-square rect: footprint becomes x∈[25,75] — the original
  // left/right mid points fall outside, the vertical center strip stays in.
  const wide = { x: 0, y: 0, w: 100, h: 50 };
  assert(
    model.hitRectRotated(wide, 90, 90, 25) === false,
    "hit: 90° drops the original right-mid (rotated footprint is narrow)"
  );
  assert(
    model.hitRectRotated(wide, 90, 10, 25) === false,
    "hit: 90° drops the original left-mid"
  );
  assert(
    model.hitRectRotated(wide, 90, 50, 5) === true,
    "hit: 90° keeps the vertical center strip"
  );
  assert(
    model.hitRectRotated(disp, 0, 90, 90) === true,
    "hit: 0° falls back to axis-aligned"
  );

  // -- computeSnap ----------------------------------------------------------
  const page = { w: 595.28, h: 841.89 };
  // (a) proposed center 2pt off the page center → corrects + guides.
  const s1 = model.computeSnap(
    { x: page.w / 2 - 52, y: page.h / 2 - 27, w: 100, h: 50 },
    page,
    [],
    4
  );
  assert(near(s1.dx, 2) && near(s1.dy, 2), "snap: near page center corrects dx=dy=2", s1);
  assert(
    s1.guides.some((g) => g.axis === "x" && near(g.pos, page.w / 2)) &&
      s1.guides.some((g) => g.axis === "y" && near(g.pos, page.h / 2)),
    "snap: page-center guides engaged"
  );
  // (b) far away → no correction, no guides (page-center X is 297.64 —
  // keep clear of it in BOTH axes).
  const s2 = model.computeSnap({ x: 100, y: 500, w: 100, h: 50 }, page, [], 4);
  assert(s2.dx === 0 && s2.dy === 0 && s2.guides.length === 0, "snap: far → none", s2);
  // (c) snaps to ANOTHER object's right edge.
  const other = { x: 60, y: 60, w: 80, h: 40 };
  const s3 = model.computeSnap({ x: 138, y: 300, w: 100, h: 50 }, page, [other], 4);
  assert(near(s3.dx, 2) || near(s3.dx, -2) || s3.dx === 0 ? near(s3.dx, 2) : false, "snap: object edge dx=2", s3);
  assert(
    s3.guides.some((g) => g.axis === "x" && near(g.pos, 140)),
    "snap: object-edge guide at x=140"
  );
  // (d) exactly at threshold counts (<=).
  const s4 = model.computeSnap({ x: -4, y: 0, w: 100, h: 50 }, page, [], 4);
  assert(near(s4.dx, 4), "snap: at-threshold snaps (inclusive)");
  // (e) nearest target wins when two are in range.
  const s5 = model.computeSnap(
    { x: 57, y: 300, w: 100, h: 50 },
    page,
    [{ x: 60, y: 300, w: 10, h: 10 }],
    6
  );
  assert(near(s5.dx, 3), "snap: nearest candidate wins (dx=3)", s5);

  // -- marquee multi-select ---------------------------------------------------
  const objs: EditorObject[] = [
    { ...model.makeText(0, { x: 10, y: 10, w: 40, h: 20 }) },
    { ...model.makeShape(0, { x: 100, y: 100, w: 40, h: 40 }, "rect") },
    { ...model.makeShape(1, { x: 100, y: 100, w: 40, h: 40 }, "ellipse") },
    { ...model.makeText(0, { x: 500, y: 700, w: 40, h: 20 }), hidden: true } as EditorObject,
  ];
  // Marquee rect is DISPLAY space — user-space y flips through
  // pdfRectToDisplay (page height 841.89): user y=10 → display ~811.89,
  // user y=100 → display ~701.89. Cover the BOTTOM display band.
  const hit = model.marqueeSelection(objs, VIEWS[0], 0, {
    x: 0,
    y: 650,
    w: 200,
    h: 200,
  });
  assertEqual(
    hit.length,
    2,
    "marquee: 2 of page-0 visible objects intersect (page-1 + hidden excluded)"
  );
  const none = model.marqueeSelection(objs, VIEWS[0], 0, {
    x: 250,
    y: 250,
    w: 40,
    h: 40,
  });
  assertEqual(none.length, 0, "marquee: disjoint rect selects nothing");
  assert(
    model.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }) &&
      !model.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
    "rectsIntersect: touching edge does not count"
  );
  const u = model.unionRects([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 20, y: 5, w: 10, h: 10 },
  ]);
  assert(
    u !== null && near(u.x, 0) && near(u.y, 0) && near(u.w, 30) && near(u.h, 15),
    "unionRects: bbox"
  );
  assertEqual(model.unionRects([]), null, "unionRects: empty → null");

  // -- sanitize rotation garbage ---------------------------------------------
  const bad = model.sanitizeObject(
    { ...model.makeText(0, { x: 10, y: 10, w: 100, h: 24 }), rotation: "fast" as unknown as number },
    1,
    new Set()
  );
  assertEqual(bad?.rotation, 0, "sanitize: string rotation → 0");
  const big = model.sanitizeObject(
    { ...model.makeShape(0, { x: 10, y: 10, w: 40, h: 40 }, "rect"), rotation: 365 },
    1,
    new Set()
  );
  assertEqual(big?.rotation, 5, "sanitize: 365° → 5°");
  const nan = model.sanitizeObject(
    { ...model.makeShape(0, { x: 10, y: 10, w: 40, h: 40 }, "rect"), rotation: Number.NaN },
    1,
    new Set()
  );
  assertEqual(nan?.rotation, 0, "sanitize: NaN rotation → 0");

  // -- rotatable kinds ---------------------------------------------------------
  assert(
    model.isRotatable(model.makeText(0, { x: 0, y: 0, w: 10, h: 10 })) &&
      model.isRotatable(model.makeShape(0, { x: 0, y: 0, w: 10, h: 10 }, "rect")) &&
      model.isRotatable(model.makeShape(0, { x: 0, y: 0, w: 10, h: 10 }, "line")) &&
      model.isRotatable(model.makeWhiteout(0, { x: 0, y: 0, w: 10, h: 10 })),
    "isRotatable: text/rect/line/whiteout rotate"
  );
  assert(
    !model.isRotatable(model.makeShape(0, { x: 0, y: 0, w: 10, h: 10 }, "ellipse")),
    "isRotatable: ellipse honestly disabled"
  );
  assert(
    !model.isRotatable(model.makeField(0, { x: 0, y: 0, w: 60, h: 20 }, new Set())),
    "isRotatable: AcroForm fields honestly disabled"
  );

  // -- drafts wire format ---------------------------------------------------------
  const k1 = drafts.draftKeyFor("doc.pdf", 1234, 5678);
  const k2 = drafts.draftKeyFor("doc.pdf", 1234, 5678);
  const k3 = drafts.draftKeyFor("doc.pdf", 1235, 5678);
  assert(k1 === k2 && k1 !== k3 && k1.startsWith("d"), "draft key: stable + identity-sensitive");

  const objs2: EditorObject[] = [model.makeText(0, { x: 10, y: 10, w: 100, h: 24 })];
  const encoded = drafts.encodeDraft(objs2, 2, 1.5);
  const decoded = drafts.decodeDraft(encoded);
  assert(
    decoded !== null &&
      decoded.v === drafts.DRAFT_SCHEMA_VERSION &&
      decoded.objects.length === 1 &&
      decoded.objects[0].kind === "text" &&
      decoded.page === 2 &&
      near(decoded.zoom, 1.5),
    "draft: encode→decode round-trip"
  );
  assertEqual(
    drafts.decodeDraft(encoded.replace(/"v":\d+/, '"v":99')),
    null,
    "draft: wrong schema version → null"
  );
  assertEqual(drafts.decodeDraft("not json at all"), null, "draft: garbage → null");
  assertEqual(
    drafts.decodeDraft(JSON.stringify({ v: 1, savedAt: Date.now(), objects: [], page: 0, zoom: 1 })),
    null,
    "draft: empty objects → null"
  );
  assertEqual(
    drafts.decodeDraft(
      JSON.stringify({ v: 1, savedAt: Date.now() - drafts.DRAFT_MAX_AGE_MS - 1000, objects: objs2, page: 0, zoom: 1 })
    ),
    null,
    "draft: stale save → null"
  );
  assert(
    drafts.decodeDraft(
      JSON.stringify({ v: 1, savedAt: Date.now(), objects: objs2, page: -5, zoom: 99 })
    ) !== null,
    "draft: absurd page/zoom clamp instead of reject"
  );
  const zoomClamped = drafts.decodeDraft(
    JSON.stringify({ v: 1, savedAt: Date.now(), objects: objs2, page: -5, zoom: 99 })
  );
  assert(zoomClamped !== null && zoomClamped.page === 0 && near(zoomClamped.zoom, 3), "draft: page≥0, zoom≤3");
  assert(
    !drafts.draftHasImages(decoded!) &&
      drafts.draftHasImages({
        v: 1,
        savedAt: Date.now(),
        objects: [model.makeImage(0, { x: 0, y: 0, w: 10, h: 10 }, "a.png")],
        page: 0,
        zoom: 1,
      }),
    "draftHasImages: image detection"
  );

  /* ---- Part 2: the REAL worker ---- */
  await import("../tools/edit-pdf/worker");
  const source = new FakeFile("p86.pdf", await makeSourcePdf());

  // Battery: rotated objects only (text 90, rect 30, whiteout 45, line 90, arrow 45).
  const battery: EditorObject[] = [
    { ...model.makeText(0, { x: 60, y: 700, w: 200, h: 24 }), text: "Rotated", rotation: 90 },
    { ...model.makeShape(0, { x: 100, y: 200, w: 100, h: 50 }, "rect"), rotation: 30 },
    { ...model.makeWhiteout(0, { x: 300, y: 300, w: 80, h: 40 }), rotation: 45 },
    { ...model.makeShape(0, { x: 400, y: 100, w: 120, h: 40 }, "line"), rotation: 90 },
    { ...model.makeShape(0, { x: 400, y: 500, w: 120, h: 40 }, "arrow"), rotation: 45 },
  ];
  const blob = {
    objects: battery,
    pageViews: VIEWS.map((v) => ({ ...v })),
    assetOrder: [],
  };
  const outcome = await runWorker(source, {
    ekey: "f1",
    "e:f1": JSON.stringify(blob),
  });
  assert(outcome.error === null, "worker: rotated battery no error", outcome.error);
  assert(outcome.result !== null, "worker: result posted");
  if (outcome.result) {
    assertEqual(outcome.result.detail?.objects, 5, "worker: 5 objects exported");
  }
  const outBytes = await outcomeBytes(outcome);
  assert(
    outBytes.length > 800 &&
      outBytes[0] === 0x25 && outBytes[1] === 0x50 && outBytes[2] === 0x44 && outBytes[3] === 0x46,
    "worker: output is a real PDF"
  );
  const reloaded = await PDFDocument.load(outBytes, {
    throwOnInvalidObject: false,
  });
  assertEqual(reloaded.getPageCount(), 1, "worker: page count survives");

  // Byte-audit 1: 90° TEXT writes a rotation Tm matrix (pdf-lib writes
  // cos90 as a tiny float — match the structure, not literal zeros).
  const content = await contentOf(outBytes);
  assert(
    /[\d.e+-]+ 1 -1 [\d.e+-]+ [-\d.]+ [-\d.]+ Tm/.test(content),
    "byte-audit: 90° text Tm rotation matrix in stream"
  );
  // The SOURCE page text was drawn unrotated at (48, 780) → identity Tm.
  assert(
    content.includes("1 0 0 1 48 780 Tm"),
    "byte-audit: source text stays unrotated (identity Tm)"
  );

  // Byte-audit 2: the 30° RECT is emitted as anchor-translate cm +
  // rotation cm + LOCAL polygon (pdf-lib semantics). The translate must
  // equal the model's rotationAnchor math, and the 30° matrix components
  // must be present.
  const r90 = battery[1] as { x: number; y: number; w: number; h: number };
  const anchor30 = model.rotationAnchor(
    { x: r90.x, y: r90.y, w: r90.w, h: r90.h },
    30
  );
  let anchorFound = false;
  for (const m of content.matchAll(/1 0 0 1 (-?[\d.e+]+) (-?[\d.e+]+) cm/g)) {
    if (
      Math.abs(parseFloat(m[1]) - anchor30.x) < 0.02 &&
      Math.abs(parseFloat(m[2]) - anchor30.y) < 0.02
    ) {
      anchorFound = true;
    }
  }
  assert(anchorFound, "byte-audit: 30° rect translate = rotationAnchor math", {
    expected: anchor30,
  });
  // P6-o: the engine trims cos/sin to 10dp (0.5, not pdf-lib's float64
  // noise 0.49999999999999994) — rendering-identical, the §20.2-normalized
  // parity contract. Either form passes.
  assert(
    /(?:0\.8660254\d* 0\.4999999\d* -0\.4999999\d* 0\.8660254\d*|0\.8660254038 0\.5 -0\.5 0\.8660254038) 0 0 cm/.test(
      content
    ),
    "byte-audit: 30° rotation matrix components in stream"
  );
  assert(
    /0 0 m\s+0 50 l\s+100 50 l\s+100 0 l\s+h/.test(content),
    "byte-audit: 30° rect local polygon w=100 h=50"
  );
  assert(
    !content.includes("100 50 re"),
    "byte-audit: rotated rect is NOT the axis-aligned re op"
  );

  // Backward compat: rotation 0 must equal the legacy path (key omitted).
  const legacyObjects: EditorObject[] = [
    model.makeText(0, { x: 60, y: 700, w: 200, h: 24 }),
    model.makeShape(0, { x: 100, y: 200, w: 100, h: 50 }, "rect"),
  ];
  const zeroObjects = legacyObjects.map((o) => ({ ...o, rotation: 0 }));
  const legacyBlob = {
    objects: JSON.parse(
      JSON.stringify(legacyObjects, (k, v) => (k === "rotation" ? undefined : v))
    ),
    pageViews: VIEWS.map((v) => ({ ...v })),
    assetOrder: [],
  };
  const zeroBlob = {
    objects: zeroObjects,
    pageViews: VIEWS.map((v) => ({ ...v })),
    assetOrder: [],
  };
  const legacyOut = await runWorker(new FakeFile("p86.pdf", await makeSourcePdf()), {
    ekey: "f2",
    "e:f2": JSON.stringify(legacyBlob),
  });
  const zeroOut = await runWorker(new FakeFile("p86.pdf", await makeSourcePdf()), {
    ekey: "f3",
    "e:f3": JSON.stringify(zeroBlob),
  });
  const legacyBytes = await outcomeBytes(legacyOut);
  const zeroBytes = await outcomeBytes(zeroOut);
  assertEqual(
    zeroBytes.length,
    legacyBytes.length,
    "backward-compat: rotation 0 ≡ omitted key (byte length)"
  );
  assert(
    zeroBytes.every((b, i) => b === legacyBytes[i]),
    "backward-compat: rotation 0 byte-identical to legacy"
  );

  console.log(
    `\n${passed} passed, ${failed} failed${
      failed > 0 ? " — FIX BEFORE SHIPPING" : ""
    }`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("SMOKE CRASHED", err);
  process.exit(1);
});
