/**
 * PRE-BUILD smoke test for Edit PDF page CROP (R15 — the last organize op
 * in the flagship editor).
 *
 * Part 1 (model, pure): validCropShape / sanitizeCrop (clamp + minimum +
 * degenerate), effectiveView (the box override every transform pivots
 * through), viewCrop, cropSignature, cropPageViews (set / reset / no-op /
 * out-of-range), normalizeViews (crop kept or dropped, raw never leaks),
 * crops riding duplicate + move.
 *
 * Part 2 (worker, REAL module): the setCropBox pass —
 *   - identity plan + one cropped slot writes /CropBox on that page only;
 *   - a text object INSIDE the crop draws at its user coords; a text
 *     object fully OUTSIDE the crop ships without its bg rectangle
 *     (clampToPage → null on the effective view — the WYSIWYG rule);
 *   - stale pre-R15 blobs (no crop field) keep the source's own box
 *     untouched (zero-regression trust mask);
 *   - garbage crops (strings / NaN / inverted / sub-minimum) never write
 *     /CropBox and never kill the run;
 *   - duplicates carry their own crop;
 *   - crop + rotation land together (/Rotate AND /CropBox);
 *   - the truncated flag bounds the crop loop to the plan (tail safe);
 *   - result detail counts cropped pages.
 *
 * Part 3 (wiring): source locks for surface/parts/worker/thumbnails/
 * drafts/model/i18n integration + EN/HI key + placeholder parity.
 *
 * Run: bun scripts/smoke-edit-crop.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees } from "pdf-lib";
import type { CropRect, PageView } from "../tools/edit-pdf/model";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
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
  // P6-o: normalize HEX PAYLOADS to uppercase (engine lowercase, pdf-lib
  // uppercase — operators stay case-sensitive).
  return text.replace(/<([0-9A-Fa-f\s]+)>/g, (m) => m.toUpperCase());
}

function hexWord(word: string): string {
  return Buffer.from(word, "latin1").toString("hex").toUpperCase();
}

/** Raw /CropBox numbers of a page (undefined when the page ships none). */
function cropBoxOf(
  page: import("pdf-lib").PDFPage
): number[] | undefined {
  const box = page.node.lookupMaybe(PDFName.of("CropBox"), PDFArray);
  if (box === undefined) return undefined;
  return box.asArray().map((n) => {
    const num = n as unknown as { asNumber(): number };
    return num.asNumber();
  });
}

/** Source PDF: 3 pages, DISTINCT heights (100 + i*10) + text markers. */
async function makeHeightsPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    const page = doc.addPage([300, 100 + i * 10]);
    page.drawText(`SRCPAGE${i + 1}`, { x: 20, y: 40, size: 12, font });
  }
  return doc.save();
}

function view(
  src: number,
  height: number,
  crop?: CropRect
): PageView {
  return {
    x0: 0,
    y0: 0,
    x1: 300,
    y1: height,
    rotate: 0,
    src,
    srcRotate: 0,
    ...(crop ? { crop } : {}),
  };
}

async function main(): Promise<void> {
  /* ================= Part 1: the pure model ================= */
  const model = await import("../tools/edit-pdf/model");
  const BOX = { x0: 0, y0: 0, x1: 300, y1: 120 };

  // validCropShape — shape only, no box context
  assertEqual(
    model.validCropShape({ x0: 10, y0: 20, x1: 100, y1: 90 }),
    { x0: 10, y0: 20, x1: 100, y1: 90 },
    "model: validCropShape keeps a sane rect"
  );
  assertEqual(
    model.validCropShape({ x0: 100, y0: 90, x1: 10, y1: 20 }),
    { x0: 10, y0: 20, x1: 100, y1: 90 },
    "model: validCropShape sorts an inverted rect"
  );
  assert(
    model.validCropShape(undefined) === undefined &&
      model.validCropShape(null) === undefined &&
      model.validCropShape("big") === undefined &&
      model.validCropShape({ x0: NaN, y0: 0, x1: 10, y1: 10 }) === undefined &&
      model.validCropShape({ x0: 5, y0: 5, x1: 5, y1: 10 }) === undefined,
    "model: validCropShape rejects garbage / zero-area"
  );

  // sanitizeCrop — clamp into the box + minimum size
  assertEqual(
    model.sanitizeCrop({ x0: -40, y0: -10, x1: 900, y1: 500 }, BOX),
    { x0: 0, y0: 0, x1: 300, y1: 120 },
    "model: sanitizeCrop clamps into the view box"
  );
  assert(
    model.sanitizeCrop({ x0: 0, y0: 0, x1: 10, y1: 100 }, BOX) === undefined,
    "model: sanitizeCrop drops a sub-minimum width"
  );
  assert(
    model.sanitizeCrop({ x0: 290, y0: 0, x1: 300, y1: 100 }, BOX) === undefined,
    "model: sanitizeCrop drops a crop narrowed by the clamp"
  );

  // effectiveView — the box override
  const cropped = view(1, 110, { x0: 30, y0: 40, x1: 200, y1: 100 });
  assertEqual(
    model.effectiveView(cropped),
    { x0: 30, y0: 40, x1: 200, y1: 100, rotate: 0, src: 1, srcRotate: 0, crop: { x0: 30, y0: 40, x1: 200, y1: 100 } },
    "model: effectiveView merges the crop into the box"
  );
  const plain = view(0, 100);
  assert(model.effectiveView(plain) === plain, "model: effectiveView is ref-stable without a crop");
  assert(
    model.viewCrop(cropped) !== undefined && model.viewCrop(plain) === undefined,
    "model: viewCrop reads the sanitized crop"
  );
  assertEqual(
    model.cropSignature(cropped),
    "c30:40:200:100",
    "model: cropSignature formats the fingerprint part"
  );
  assertEqual(model.cropSignature(plain), "-", "model: cropSignature is '-' when uncropped");
  assertEqual(
    model.cropSignature(view(1, 110, { x0: -5, y0: 0, x1: 999, y1: 60 })),
    "c0:0:300:60",
    "model: cropSignature reflects the SANITIZED crop"
  );
  // displaySize through the effective view (the transform pivot)
  assertEqual(
    model.displaySize(model.effectiveView(cropped)),
    { w: 170, h: 60 },
    "model: displaySize honours the effective (cropped) view"
  );
  assertEqual(
    model.displaySize(model.effectiveView(view(1, 110, { x0: 0, y0: 0, x1: 60, y1: 60 }))),
    { w: 60, h: 60 },
    "model: displaySize rotation swap still applies (0° here keeps w/h)"
  );

  // cropPageViews — set / reset / no-ops
  const views = [view(0, 100), view(1, 110), view(2, 120)];
  const set = model.cropPageViews(views, 1, { x0: 10, y0: 10, x1: 250, y1: 100 });
  assert(set !== views, "model: cropPageViews returns a new array on set");
  assert(set[0] === views[0] && set[2] === views[2], "model: untouched slots keep their refs");
  assertEqual(
    model.cropPageViews(set, 1, null) ?? "nullish",
    views,
    "model: cropPageViews reset restores the original views"
  );
  assert(
    model.cropPageViews(views, 1, { x0: 0, y0: 0, x1: 5, y1: 100 }) === views,
    "model: sub-minimum crop is a no-op (tampered caller)"
  );
  assert(
    model.cropPageViews(views, -1, { x0: 10, y0: 10, x1: 250, y1: 100 }) === views &&
      model.cropPageViews(views, 9, { x0: 10, y0: 10, x1: 250, y1: 100 }) === views,
    "model: out-of-range slots are no-ops"
  );
  assert(
    model.cropPageViews(views, 0, null) === views,
    "model: resetting an uncropped slot is a no-op"
  );

  // normalizeViews — crop kept or dropped; raw never leaks
  const normalized = model.normalizeViews(
    [
      view(0, 100, { x0: 20, y0: 10, x1: 260, y1: 90 }),
      { ...view(1, 110), crop: "junk" as unknown as CropRect },
      { ...view(2, 120), crop: { x0: 0, y0: 0, x1: 3, y1: 100 } },
    ],
    3
  );
  assertEqual(
    normalized[0].crop,
    { x0: 20, y0: 10, x1: 260, y1: 90 },
    "model: normalizeViews keeps a valid crop"
  );
  assert(
    normalized[1].crop === undefined && normalized[2].crop === undefined,
    "model: normalizeViews drops garbage + sub-minimum crops"
  );

  // crops ride duplicate + move (same as rotation semantics)
  const dup = model.duplicatePageViews(set, 1);
  assertEqual(
    dup[2]?.crop ?? null,
    set[1]?.crop ?? null,
    "model: a duplicated slot carries its crop"
  );
  const moved = model.movePageViews(dup, 1, 0);
  assertEqual(
    moved[0]?.crop ?? null,
    set[1]?.crop ?? null,
    "model: a moved slot carries its crop"
  );

  /* ================= Part 2: the real worker ================= */
  await import("../tools/edit-pdf/worker");
  const srcBytes = await makeHeightsPdf();

  const blobOf = (
    objects: unknown[],
    pageViews: unknown[],
    truncated = false
  ): Record<string, string> => ({
    "e:k": JSON.stringify({
      objects,
      pageViews,
      truncated,
      assetOrder: [],
    }),
    ekey: "k",
  });

  const textView = (
    page: number,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string
  ) => ({
    id: `t${page}-${x}`,
    page,
    x,
    y,
    w,
    h,
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "text",
    text,
    font: "helvetica",
    size: 12,
    color: "#111827",
    bold: false,
    italic: false,
    underline: false,
    align: "left",
    bg: "#ffffff",
  });

  // W1: identity plan + one cropped slot → /CropBox on that page ONLY.
  {
    const file = new FakeFile("w1.pdf", srcBytes);
    const crop = { x0: 30, y0: 20, x1: 240, y1: 100 };
    const out = await runWorker(file, blobOf([], [
      view(0, 100),
      view(1, 110, crop),
      view(2, 120),
    ]));
    assert(out.error === null, "W1: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const pages = saved.getPages();
    assertEqual(pages.length, 3, "W1: identity plan keeps all pages");
    assert(
      cropBoxOf(pages[0]) === undefined && cropBoxOf(pages[2]) === undefined,
      "W1: uncropped pages ship NO /CropBox"
    );
    assertEqual(
      cropBoxOf(pages[1]),
      [30, 20, 240, 100],
      "W1: cropped page writes /CropBox [x y x+w y+h] exactly"
    );
    assertEqual(
      out.result?.detail?.cropped,
      1,
      "W1: result detail counts one cropped page"
    );
  }

  // W2: objects vs the crop — inside draws at user coords; outside text
  // ships without its bg rectangle (clampToPage null on the effective view).
  {
    const file = new FakeFile("w2.pdf", srcBytes);
    const crop = { x0: 50, y0: 30, x1: 250, y1: 95 };
    const out = await runWorker(file, blobOf(
      [
        textView(0, 60, 40, 120, 20, "INSIDEWORD"),
        textView(0, 260, 40, 30, 20, "OUTSIDE"),
        // Straddles the crop's right edge (x 230..290, crop ends 250):
        // clampToPage must narrow it to 230..250 (w=20).
        textView(0, 230, 40, 60, 20, "EDGE"),
      ],
      [view(0, 100, crop)]
    ));
    assert(out.error === null, "W2: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const page = saved.getPage(0);
    const text = await pageText(page);
    // Text INSIDE the crop draws; its bg path lands at the clamped rect.
    assert(
      text.includes(hexWord("INSIDEWORD")),
      "W2: inside-crop text drawn (glyph-level hex)"
    );
    // pdf-lib draws rectangles as translated paths: "1 0 0 1 x y cm" +
    // "0 0 m 0 h l w h l w 0 l h f" — assert the exact geometry.
    assert(
      text.includes("1 0 0 1 60 40 cm") &&
        text.includes("0 0 m\n0 20 l\n120 20 l\n120 0 l\nh\nf"),
      "W2: the inside bg rectangle draws at its user rect (fully inside the crop)",
      { text: text.slice(0, 400) }
    );
    // The straddling bg is clamped to the crop's right edge: 230..250 (w 20).
    assert(
      text.includes("1 0 0 1 230 40 cm") &&
        text.includes("0 0 m\n0 20 l\n20 20 l\n20 0 l\nh\nf"),
      "W2: a bg straddling the crop edge is CLAMPED to the crop (w 60→20)",
      { text: text.slice(0, 400) }
    );
    // The fully-outside text ships words (viewers clip at /CropBox) but
    // NO bg path anchored at 260 — the WYSIWYG rule.
    assert(
      !text.includes("1 0 0 1 260 40 cm"),
      "W2: the outside-crop bg rectangle is dropped (clampToPage null)"
    );
  }

  // W3: stale pre-R15 blob (no crop field) — /CropBox never written.
  {
    const file = new FakeFile("w3.pdf", srcBytes);
    const out = await runWorker(file, blobOf(
      [textView(0, 20, 40, 100, 20, "STALEBG")],
      [
        { x0: 0, y0: 0, x1: 300, y1: 100, rotate: 0, src: 0 },
        { x0: 0, y0: 0, x1: 300, y1: 110, rotate: 0, src: 1 },
      ]
    ));
    assert(out.error === null, "W3: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    assert(
      saved.getPages().every((p) => cropBoxOf(p) === undefined),
      "W3: stale blob writes no /CropBox anywhere (trust mask)"
    );
    assertEqual(
      out.result?.detail?.cropped,
      undefined,
      "W3: detail omits the cropped count"
    );
  }

  // W4: garbage crops — never write /CropBox, never kill the run.
  {
    const file = new FakeFile("w4.pdf", srcBytes);
    const out = await runWorker(file, blobOf([], [
      { ...view(0, 100), crop: { x0: "a", y0: 0, x1: 100, y1: 90 } as unknown as CropRect },
      { ...view(1, 110), crop: { x0: 0, y0: NaN, x1: 100, y1: 90 } as unknown as CropRect },
      { ...view(2, 120), crop: { x0: 5, y0: 5, x1: 8, y1: 90 } },
    ]));
    assert(out.error === null, "W4: garbage crops never crash the run");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    assert(
      saved.getPages().every((p) => cropBoxOf(p) === undefined),
      "W4: garbage crops write no /CropBox"
    );
  }

  // W5: duplicates carry their OWN crop (per-slot, like rotation).
  {
    const file = new FakeFile("w5.pdf", srcBytes);
    const cropA = { x0: 10, y0: 10, x1: 200, y1: 90 };
    const cropB = { x0: 60, y0: 20, x1: 280, y1: 100 };
    const out = await runWorker(file, blobOf([], [
      view(0, 100, cropA),
      view(0, 100, cropB),
      view(1, 110),
    ]));
    assert(out.error === null, "W5: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const pages = saved.getPages();
    assertEqual(pages.length, 3, "W5: duplicate plan yields 3 pages");
    assertEqual(cropBoxOf(pages[0]), [10, 10, 200, 90], "W5: slot 0 keeps crop A");
    assertEqual(cropBoxOf(pages[1]), [60, 20, 280, 100], "W5: duplicate slot carries its own crop B");
    assert(cropBoxOf(pages[2]) === undefined, "W5: untouched slot ships no crop box");
  }

  // W6: crop + rotation on the same slot — /Rotate AND /CropBox both land.
  {
    const file = new FakeFile("w6.pdf", srcBytes);
    const out = await runWorker(file, blobOf([], [
      view(0, 100),
      { ...view(1, 110, { x0: 20, y0: 15, x1: 220, y1: 95 }), rotate: 90, srcRotate: 0 },
    ]));
    assert(out.error === null, "W6: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const pages = saved.getPages();
    assertEqual(pages[1].getRotation().angle, 90, "W6: rotation lands");
    assertEqual(
      cropBoxOf(pages[1]),
      [20, 15, 220, 95],
      "W6: crop lands in USER space (rotation-independent)"
    );
  }

  // W7: crop rides the reorder (slot 2 moved to front).
  {
    const file = new FakeFile("w7.pdf", srcBytes);
    const out = await runWorker(file, blobOf([], [
      view(2, 120, { x0: 15, y0: 12, x1: 250, y1: 105 }),
      view(0, 100),
      view(1, 110),
    ]));
    assert(out.error === null, "W7: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const pages = saved.getPages();
    const text0 = await pageText(pages[0]);
    assert(
      text0.includes(hexWord("SRCPAGE3")),
      "W7: reordered page 0 shows source page 3"
    );
    assertEqual(
      cropBoxOf(pages[0]),
      [15, 12, 250, 105],
      "W7: the crop follows its slot through the reorder"
    );
    assertEqual(
      pages[0].getSize().height,
      120,
      "W7: surgery moved the 120pt page to slot 0"
    );
  }

  // W8: truncated workspace — the crop loop is bounded by the plan; the
  // untouched tail keeps whatever box it shipped.
  {
    const file = new FakeFile("w8.pdf", srcBytes);
    const out = await runWorker(file, blobOf(
      [textView(0, 20, 40, 100, 20, "TAILSAFE")],
      [{ ...view(0, 100, { x0: 10, y0: 10, x1: 200, y1: 90 }) }],
      true
    ));
    assert(out.error === null, "W8: run succeeds");
    const saved = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer())
    );
    const pages = saved.getPages();
    assertEqual(pages.length, 3, "W8: truncated flag keeps the tail pages");
    assertEqual(cropBoxOf(pages[0]), [10, 10, 200, 90], "W8: the planned slot keeps its crop");
    assert(
      cropBoxOf(pages[1]) === undefined && cropBoxOf(pages[2]) === undefined,
      "W8: the untouched tail ships no crop box"
    );
  }

  /* ================= Part 3: wiring locks ================= */
  const surface = readFileSync("tools/edit-pdf/surface.tsx", "utf8");
  const parts = readFileSync("tools/edit-pdf/editor-parts.tsx", "utf8");
  const worker = readFileSync("tools/edit-pdf/worker.ts", "utf8");
  const thumbs = readFileSync("src/lib/pdf/thumbnails.ts", "utf8");
  const drafts = readFileSync("tools/edit-pdf/drafts.ts", "utf8");
  const modelSrc = readFileSync("tools/edit-pdf/model.ts", "utf8");
  const i18nTool = JSON.parse(readFileSync("tools/edit-pdf/i18n.json", "utf8"));

  // model wiring
  assert(
    modelSrc.includes("export function effectiveView") &&
      modelSrc.includes("export function cropPageViews") &&
      modelSrc.includes("export function sanitizeCrop") &&
      modelSrc.includes("export function validCropShape") &&
      modelSrc.includes("export const MIN_CROP_PT"),
    "wiring: model exports the R15 crop surface"
  );

  // surface wiring
  assert(
    surface.includes("@${cropSignature(v)}"),
    "wiring: planKey fingerprint carries the crop signature"
  );
  assert(
    surface.includes("effectiveView(pageViews[selectedPage])"),
    "wiring: currentView is the effective (cropped) view"
  );
  assert(
    surface.includes("const crop = viewCrop(view);") &&
      surface.includes("...(crop ? { crop } : {})"),
    "wiring: preview render passes the crop to pdf.js"
  );
  assert(
    surface.includes("getPdfPagePixelSize(file, 1, src, rotation, crop)"),
    "wiring: preview pixel size is crop-aware"
  );
  assert(
    surface.includes("cropPageViews(views, pos, crop)"),
    "wiring: cropPage commits through cropPageViews"
  );
  assert(
    surface.includes("<CropOverlay") && surface.includes("onApply={applyCropFromDisplay}"),
    "wiring: the canvas renders the CropOverlay"
  );
  assert(
    surface.includes("cropMode={cropMode && canvasReady}") &&
      surface.includes("onToggleCrop={toggleCropMode}"),
    "wiring: strip receives crop mode + toggle"
  );
  assert(
    surface.includes("setCropMode(false);") &&
      surface.includes("t(\"editPdf.cropHint\")"),
    "wiring: crop mode exits on apply/reset + hint line"
  );

  // editor-parts wiring
  assert(
    parts.includes("const CROP_HANDLES"),
    "wiring: CropOverlay has the 8 handles"
  );
  assert(
    parts.includes("aria-pressed={cropMode}") &&
      /t\("editPdf\.pageCrop"/.test(parts),
    "wiring: the Crop button is labelled + stateful"
  );
  assert(
    parts.includes("function cropOfSig(") &&
      parts.includes("part.split(\"@\")"),
    "wiring: strip parses the 3-part fingerprint"
  );
  assert(
    /item\.cropSig === cropSig/.test(parts),
    "wiring: thumbnail cache is crop-keyed"
  );
  assert(
    parts.includes("stripCroppedTitle"),
    "wiring: cropped slots wear the emerald badge"
  );
  assert(
    /size-11 -translate-x-1\/2/.test(parts),
    "wiring: crop handles are 44px touch targets"
  );

  // worker wiring
  const pagePlanSrc = readFileSync("tools/edit-pdf/page-plan.ts", "utf8");
  assert(
    pagePlanSrc.includes('"CropBox"') && worker.includes("applySlotSets"),
    "wiring: worker writes /CropBox per slot (via the shared page-plan set builder)"
  );
  assert(
    worker.includes("cropExplicit"),
    "wiring: worker trust-masks crop writes (stale blobs safe)"
  );
  assert(
    worker.includes("view: effectiveView(views[p])"),
    "wiring: the draw ctx pivots through the effective view"
  );

  // thumbnails wiring
  assert(
    thumbs.includes("crop?: RenderCrop") &&
      thumbs.includes("convertToViewportRectangle"),
    "wiring: renderPdfThumbnail renders crop windows rotation-aware"
  );
  assert(
    /getPdfPagePixelSize\([\s\S]{0,260}crop\?: RenderCrop/.test(thumbs),
    "wiring: getPdfPagePixelSize accepts a crop"
  );

  // drafts wiring
  assert(
    drafts.includes("validCropShape(view.crop)"),
    "wiring: drafts pass the crop through the shape guard"
  );

  // i18n parity + presence in BOTH stores
  const keys = [
    "pageCrop",
    "cropModeLabel",
    "cropHint",
    "cropApply",
    "cropReset",
    "cropCancel",
    "cropSize",
    "pageCroppedToast",
    "cropResetToast",
    "stripCroppedTitle",
  ];
  for (const k of keys) {
    assert(
      typeof i18nTool.en.editPdf[k] === "string" &&
        i18nTool.en.editPdf[k].length > 0,
      `i18n: tool en editPdf.${k}`
    );
    assert(
      typeof i18nTool.hi.editPdf[k] === "string" &&
        i18nTool.hi.editPdf[k].length > 0,
      `i18n: tool hi editPdf.${k}`
    );
  }
  for (const locale of ["en", "hi"]) {
    const master = JSON.parse(readFileSync(`src/i18n/${locale}.json`, "utf8"));
    for (const k of keys) {
      assert(
        typeof master.editPdf?.[k] === "string",
        `i18n: master ${locale} editPdf.${k}`
      );
    }
  }
  // Placeholder parity for parameterised strings
  const params = (s: string): string =>
    [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of ["pageCrop", "cropSize", "pageCroppedToast", "cropResetToast"]) {
    assertEqual(
      params(i18nTool.hi.editPdf[k]),
      params(i18nTool.en.editPdf[k]),
      `i18n: placeholder parity editPdf.${k}`
    );
  }
  // The tool i18n and the master catalogs carry identical key sets.
  assertEqual(
    Object.keys(i18nTool.en.editPdf).sort().join(","),
    Object.keys(i18nTool.hi.editPdf).sort().join(","),
    "i18n: tool en/hi editPdf key sets identical"
  );
  const masterEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const masterHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  assertEqual(
    Object.keys(masterEn.editPdf).sort().join(","),
    Object.keys(masterHi.editPdf).sort().join(","),
    "i18n: master en/hi editPdf key sets identical"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  // Explicit exit: the worker import chain leaves a pending handle that
  // would keep the event loop alive (the R13 lesson).
  process.exit(failed > 0 ? 1 : 0);
}

void main();
