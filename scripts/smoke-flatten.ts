/**
 * PRE-BUILD smoke test for the Flatten PDF tool (P4.1, PRD §8.4).
 * Locks the engine behaviors the worker depends on BEFORE browser QA:
 *
 *  1. composeAppearanceTransform math (pdf.js getTransformMatrix parity):
 *     identity, offset, scale, matrix-composed, flipped /Matrix stamps,
 *     90°-rotated /Matrix, degenerate bbox fallback, composeAffine algebra.
 *  2. Fixture with (a) a text-annotation carrying a hand-built appearance
 *     XObject (red box, BBox [0 0 100 30], Rect [50 600 150 630]),
 *     (b) a stamp with a flipped /Matrix, (c) a state-dict /AP /N + /AS,
 *     (d) a no-/BBox appearance (pdf.js unit-box fallback burn), plus skip
 *     cases (no AP, hidden) and a filled AcroForm text field. flattenDocument
 *     must burn exactly the burnable ones, flatten the field, and DELETE
 *     /Annots.
 *  3. Structural verification of the saved output: /Annots gone, form has
 *     zero fields, the page content stream carries the burn operators
 *     (q … cm /FxFlatten… Do Q — exact cm numbers pinned), and the page
 *     /Resources /XObject resolves to the appearance streams.
 *  4. VISUAL parity via pdf.js + @napi-rs/canvas (bun runs it): the page
 *     renders identically before (annotation layer) and after (burned
 *     content) — red box, flipped-matrix stamp and field value all sample
 *     at the same pixels; whole-page diff within anti-aliasing tolerance.
 *  5. Error paths: already-flat → report.nothingToDo (normal usage,
 *     NOT an error — the worker passes the input through); a widget whose
 *     /AP /N is a direct (unregistered) stream → FlattenFormsError;
 *     encrypted input → tool.errorEncrypted classification.
 *  6. WORKER E2E (self/postMessage shim, web-optimize recipe): a flat
 *     input SUCCEEDS — exactly one result, output bytes byte-identical
 *     to the input (passthrough, no re-save churn), detail.nothingFlattened
 *     true; an annotated input still burns + saves (control).
 *
 * Run: bun scripts/smoke-flatten.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";

import {
  FlattenFormsError,
  applyAffine,
  axialAlignedBounds,
  classifyFlattenError,
  composeAffine,
  composeAppearanceTransform,
  flattenDocument,
  type Affine,
} from "../tools/flatten-pdf/engine";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string): void {
  failed += 1;
  console.error(`FAIL ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message} (expected ${b}, got ${a})`);
}

function near(actual: number, expected: number, message: string): void {
  assert(
    Math.abs(actual - expected) < 1e-9,
    `${message} (expected ${expected}, got ${actual})`
  );
}

function enc(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* 1. Transform math                                                    */
/* ------------------------------------------------------------------ */

function checkTransformMath(): void {
  const I: Affine = [1, 0, 0, 1, 0, 0];

  eq(
    composeAppearanceTransform([50, 600, 150, 630], [50, 600, 150, 630], null),
    [1, 0, 0, 1, 0, 0],
    "identity: bbox == rect, no matrix"
  );

  eq(
    composeAppearanceTransform([50, 600, 150, 630], [0, 0, 100, 30], null),
    [1, 0, 0, 1, 50, 600],
    "offset bbox maps unit-translation to rect corner"
  );

  eq(
    composeAppearanceTransform([50, 600, 150, 630], [0, 0, 200, 60], null),
    [0.5, 0, 0, 0.5, 50, 600],
    "double-size bbox scales by 0.5"
  );

  eq(
    composeAppearanceTransform([50, 600, 150, 630], [10, 20, 110, 50], null),
    [1, 0, 0, 1, 40, 580],
    "bbox with own offset translates inside the rect"
  );

  // A flipped /Matrix (stamps) must not change the placement when the
  // flipped bbox still covers the same area…
  eq(
    composeAppearanceTransform(
      [200, 500, 300, 530],
      [0, 0, 100, 30],
      [1, 0, 0, -1, 0, 30]
    ),
    [1, 0, 0, 1, 200, 500],
    "flipped-Y /Matrix keeps the unit placement"
  );
  // …but must flip the appearance INSIDE the rect: the composed total
  // (placement ∘ matrix) maps the bbox's (0,0) corner onto the rect's
  // top-left (200, 530).
  const flipTotal = composeAffine(
    composeAppearanceTransform(
      [200, 500, 300, 530],
      [0, 0, 100, 30],
      [1, 0, 0, -1, 0, 30]
    ),
    [1, 0, 0, -1, 0, 30]
  );
  const flippedOrigin = applyAffine(flipTotal, [0, 0]);
  near(flippedOrigin[0], 200, "flipped stamp: bbox (0,0) → rect x1");
  near(flippedOrigin[1], 530, "flipped stamp: bbox (0,0) → rect y2 (flip)");

  eq(
    composeAppearanceTransform(
      [50, 600, 150, 630],
      [0, 0, 100, 30],
      [1, 0, 0, 1, 10, 20]
    ),
    [1, 0, 0, 1, 40, 580],
    "translated /Matrix shifts the placement"
  );

  // 90° rotation matrix: bbox [0 0 100 30] maps to bounds [-30 0 0 100].
  eq(
    axialAlignedBounds([0, 0, 100, 30], [0, 1, -1, 0, 0, 0]),
    [-30, 0, 0, 100],
    "axialAlignedBounds with 90° /Matrix"
  );
  const rotated = composeAppearanceTransform(
    [50, 600, 150, 630],
    [0, 0, 100, 30],
    [0, 1, -1, 0, 0, 0]
  );
  near(rotated[0], 100 / 30, "rotated /Matrix: sx = rectW / boundsW");
  near(rotated[3], 30 / 100, "rotated /Matrix: sy = rectH / boundsH");
  near(rotated[4], 50 + 30 * (100 / 30), "rotated /Matrix: e = rx - minX·sx");
  near(rotated[5], 600, "rotated /Matrix: f = ry - minY·sy");

  eq(
    composeAppearanceTransform([50, 600, 150, 630], [5, 5, 5, 30], null),
    [1, 0, 0, 1, 50, 600],
    "degenerate bbox → translate-to-corner fallback"
  );

  eq(composeAffine(I, [2, 0, 0, 2, 10, 10]), [2, 0, 0, 2, 10, 10], "compose: identity left");
  eq(
    composeAffine([2, 0, 0, 2, 10, 10], [0.5, 0, 0, 0.5, -5, -5]),
    [1, 0, 0, 1, 0, 0],
    "compose: inverse pair cancels"
  );
  // Composition order: applyAffine(compose(A, B)) === applyAffine(A, applyAffine(B)).
  const A: Affine = [1.2, 0.1, -0.2, 0.9, 3, -4];
  const B: Affine = [0.8, -0.05, 0.3, 1.1, -7, 2];
  const viaCompose = applyAffine(composeAffine(A, B), [3.5, -2.25]);
  const viaSteps = applyAffine(A, applyAffine(B, [3.5, -2.25]));
  near(viaCompose[0], viaSteps[0], "compose order: x");
  near(viaCompose[1], viaSteps[1], "compose order: y");
}

/* ------------------------------------------------------------------ */
/* 2. Fixture                                                           */
/* ------------------------------------------------------------------ */

function formXObject(
  doc: PDFDocument,
  bbox: [number, number, number, number] | null,
  matrix: number[] | null,
  paint: string
): PDFRawStream {
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Form",
    ...(bbox === null ? {} : { BBox: bbox }),
    ...(matrix === null ? {} : { Matrix: matrix }),
    Resources: {},
  });
  return PDFRawStream.of(dict, enc(paint));
}

interface Fixture {
  bytes: Uint8Array;
  doc: PDFDocument;
}

async function buildFixture(): Promise<Fixture> {
  const doc = await PDFDocument.create();
  doc.setTitle("Flatten smoke fixture");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Flatten smoke base page", { x: 72, y: 740, size: 14, font });

  const context = doc.context;
  const addAnnot = (
    annot: Record<string, unknown>,
    ap: PDFRawStream | null
  ): void => {
    const apRef = ap === null ? null : context.register(ap);
    const dict = context.obj({
      Type: "Annot",
      ...annot,
      ...(apRef === null ? {} : { AP: { N: apRef } }),
    });
    page.node.addAnnot(context.register(dict));
  };

  // A — burnable: red box appearance, bbox equals the rect's size.
  addAnnot(
    { Subtype: "Square", Rect: [50, 600, 150, 630], F: 4 },
    formXObject(doc, [0, 0, 100, 30], null, "1 0 0 rg 0 0 100 30 re f")
  );

  // E — burnable with a flipped /Matrix: blue box.
  addAnnot(
    { Subtype: "Stamp", Rect: [200, 500, 300, 530], F: 4 },
    formXObject(
      doc,
      [0, 0, 100, 30],
      [1, 0, 0, -1, 0, 30],
      "0 0 1 rg 0 0 100 30 re f"
    )
  );

  // B — skipped: no /AP at all (a "content-only" FreeText).
  addAnnot(
    { Subtype: "FreeText", Rect: [400, 500, 500, 530], F: 4, Contents: "hello" },
    null
  );

  // C — burned via the pdf.js unit-box fallback: the appearance has no
  // /BBox (malformed per PDF 32000-1 §8.10.1) yet pdf.js renders it clipped
  // to a [0 0 1 1] box scaled onto the rect — the flatten must keep that.
  const bboxless = formXObject(doc, null, null, "0 1 0 rg 0 0 100 30 re f");
  addAnnot({ Subtype: "Square", Rect: [50, 400, 150, 430], F: 4 }, bboxless);

  // D — skipped: hidden flag (F bit 2).
  addAnnot(
    { Subtype: "Square", Rect: [200, 400, 300, 430], F: 2 },
    formXObject(doc, [0, 0, 100, 30], null, "0 1 0 rg 0 0 100 30 re f")
  );

  // F — burnable from a state dict: /AS selects the green "Yes" state.
  const yesRef = context.register(
    formXObject(doc, [0, 0, 100, 30], null, "0 1 0 rg 0 0 100 30 re f")
  );
  const offRef = context.register(
    formXObject(doc, [0, 0, 100, 30], null, "0.5 0.5 0.5 rg 0 0 100 30 re f")
  );
  const stateDict = context.obj({ Yes: yesRef, Off: offRef });
  const annotF = context.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [350, 600, 450, 630],
    F: 4,
    AS: "Yes",
    AP: { N: stateDict },
  });
  page.node.addAnnot(context.register(annotF));

  // G — burnable via a DIRECT (unregistered) /N stream.
  const direct = formXObject(doc, [0, 0, 100, 30], null, "0 1 1 rg 0 0 100 30 re f");
  const annotG = context.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [350, 500, 450, 530],
    F: 4,
    AP: { N: direct },
  });
  page.node.addAnnot(context.register(annotG));

  // A filled AcroForm text field on the same page.
  const form = doc.getForm();
  const field = form.createTextField("smoke.name");
  field.setText("Priya Sharma");
  field.addToPage(page, { x: 100, y: 700, width: 300, height: 24 });

  const bytes = await doc.save();
  return { bytes, doc };
}

/* ------------------------------------------------------------------ */
/* 4. pdf.js rendering (bun + @napi-rs/canvas)                          */
/* ------------------------------------------------------------------ */

interface RenderedPage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function renderPage(
  bytes: Uint8Array,
  pageNumber: number,
  scale: number
): Promise<RenderedPage> {
  const canvasMod = await import("@napi-rs/canvas");
  (globalThis as Record<string, unknown>).Path2D = canvasMod.Path2D;
  (globalThis as Record<string, unknown>).Image = canvasMod.Image;
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = canvasMod.createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  page.cleanup();
  await doc.cleanup();
  return { data: img.data, width: canvas.width, height: canvas.height };
}

function sample(
  img: RenderedPage,
  x: number,
  y: number
): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function colorName(px: [number, number, number]): string {
  const [r, g, b] = px;
  if (r > 200 && g < 90 && b < 90) return "red";
  if (r < 90 && g < 90 && b > 200) return "blue";
  if (r < 90 && g > 200 && b < 90) return "green";
  if (r < 90 && g > 180 && b > 180) return "cyan";
  if (r > 200 && g > 200 && b > 200) return "white";
  if (r < 90 && g < 90 && b < 90) return "dark";
  return "mixed";
}

function diffCount(
  a: RenderedPage,
  b: RenderedPage,
  tolerance = 16
): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > tolerance ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance
    ) {
      count += 1;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  checkTransformMath();

  const fixture = await buildFixture();
  await writeFile("download/qa-p41-flatten-fixture.pdf", fixture.bytes);

  // --- 2. flatten + report (OWN engine; pdf-lib is the fixture author) ---
  const { report, bytes: flat } = flattenDocument(fixture.bytes);
  eq(report.pages, 1, "report: single page");
  eq(report.fieldCount, 1, "report: one form field found");
  assert(report.annotationsBurned === 5, `report: 5 annotations burned (got ${report.annotationsBurned})`);
  // Skipped: no-/AP (B) + hidden (D). The OWN engine's form pass FILTERS
  // every widget + field ref out of /Annots before the annotation pass runs,
  // so there is no dangling widget ref to skip (the pdf-lib path left the
  // deleted object's ref listed — counted as its third skip). The no-/BBox
  // appearance (C) is NOT skipped: it burns through pdf.js's unit-box
  // fallback.
  assert(report.annotationsSkipped === 2, `report: 2 annotations skipped (got ${report.annotationsSkipped})`);

  await writeFile("download/qa-p41-flatten-output.pdf", flat);

  // --- 3. structural verification on a fresh reload ------------------
  const reloaded = await PDFDocument.load(flat, { updateMetadata: false });
  const page = reloaded.getPages()[0];

  assert(
    page.node.Annots() === undefined,
    "structural: /Annots entry removed from the page"
  );
  assert(
    page.node.get(PDFName.of("Annots")) === undefined,
    "structural: no raw /Annots key either"
  );
  assert(
    reloaded.catalog.get(PDFName.of("AcroForm")) === undefined,
    "structural: OWN engine drops the catalog /AcroForm entirely"
  );
  eq(
    reloaded.getForm().getFields().length,
    0,
    "structural: AcroForm has no fields left"
  );

  const resources = page.node.Resources();
  const xoDict = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  // The OWN engine registers every burn target under Fx<n> (resourceKey's
  // collision-free allocation): the 5 annotation appearances PLUS the
  // flattened field's widget appearance all ride the same bucket.
  const fxKeys =
    xoDict === undefined
      ? []
      : xoDict.keys().filter((k) => /^\/Fx\d+$/.test(k.asString()));
  assert(
    xoDict !== undefined && fxKeys.length === 6,
    `structural: 6 Fx<n> XObjects registered in page resources (got ${fxKeys.length} of ${xoDict?.keys().length ?? 0}: ${fxKeys.map((k) => k.asString()).join(", ")})`
  );
  let resolvedXObjects = 0;
  for (const key of fxKeys) {
    const value = xoDict!.get(key);
    const resolved = reloaded.context.lookup(value as PDFRef);
    if (
      resolved instanceof PDFRawStream &&
      resolved.dict.lookupMaybe(PDFName.of("Subtype"), PDFName) !== undefined
    ) {
      resolvedXObjects += 1;
    }
  }
  assert(
    resolvedXObjects === 6,
    `structural: all 6 registered names resolve to appearance XObjects (got ${resolvedXObjects})`
  );

  // The burn operators live in the LAST content stream.
  const contents = page.node.Contents();
  assert(contents !== undefined, "structural: page has contents");
  const lastStream =
    contents instanceof PDFArray
      ? contents.lookup(contents.size() - 1)
      : contents;
  if (
    lastStream === undefined ||
    !(lastStream instanceof PDFRawStream)
  ) {
    throw new Error(
      "structural: last content stream is a raw stream (reloaded doc)"
    );
  }
  const decoded = decodePDFRawStream(lastStream).decode();
  const contentText = new TextDecoder().decode(decoded);
  assert(
    /^q\n/m.test(contentText) && /\nQ\n?$/m.test(contentText),
    "structural: burn stream is wrapped in q…Q"
  );
  assert(
    contentText.includes("1 0 0 1 50 600 cm"),
    "structural: red box placed at its annotation rect"
  );
  assert(
    contentText.includes("1 0 0 1 200 500 cm"),
    "structural: flipped stamp placed at its annotation rect"
  );
  const doCount = (contentText.match(/ Do\n/g) ?? []).length;
  assert(doCount === 6, `structural: 6 Do operators in the burn stream — the widget burn + 5 annotation burns ride ONE appended stream (got ${doCount})`);
  assert(
    /\/Fx\d+ Do/.test(contentText),
    "structural: XObject name is an Fx<n> key"
  );

  // --- 4. visual parity (pdf.js before vs after) ----------------------
  const before = await renderPage(fixture.bytes, 1, 2);
  const after = await renderPage(flat, 1, 2);
  eq(after.width, before.width, "visual: same rendered width");
  eq(after.height, before.height, "visual: same rendered height");

  // User-space rect → display pixels at scale 2 (page height 792, y down).
  const px = (x: number, yUser: number): [number, number] => [
    Math.round(x * 2),
    Math.round((792 - yUser) * 2),
  ];

  const redC = px(100, 615);
  eq(colorName(sample(before, redC[0], redC[1])), "red", "visual: BEFORE renders the red annotation");
  eq(colorName(sample(after, redC[0], redC[1])), "red", "visual: AFTER keeps the red box burned in");

  const blueC = px(250, 515);
  eq(colorName(sample(before, blueC[0], blueC[1])), "blue", "visual: BEFORE renders the flipped stamp");
  eq(colorName(sample(after, blueC[0], blueC[1])), "blue", "visual: AFTER keeps the stamp via /Matrix composition");

  const greenC = px(400, 615);
  eq(colorName(sample(after, greenC[0], greenC[1])), "green", "visual: AFTER burns the /AS-selected state appearance");

  const cyanC = px(400, 515);
  eq(colorName(sample(after, cyanC[0], cyanC[1])), "cyan", "visual: AFTER burns the direct (unregistered) /N stream");

  // Field value still visible in both renders (dark pixels in the widget).
  let darkBefore = 0;
  let darkAfter = 0;
  for (let y = 100; y < 170; y += 1) {
    for (let x = 180; x < 840; x += 1) {
      if (colorName(sample(before, x, y)) === "dark") darkBefore += 1;
      if (colorName(sample(after, x, y)) === "dark") darkAfter += 1;
    }
  }
  assert(darkBefore > 40, `visual: field text renders BEFORE flatten (${darkBefore} dark px)`);
  assert(darkAfter > 40, `visual: field text renders AFTER flatten (${darkAfter} dark px)`);

  const diffs = diffCount(before, after);
  const total = before.width * before.height;
  assert(
    diffs >= 0 && diffs < total * 0.005,
    `visual: page diff within AA tolerance (${diffs}/${total} px)`
  );

  // --- 5. already-flat + error paths ------------------------------
  const plain = await PDFDocument.create();
  plain.addPage([300, 300]);
  const plainBytes = await plain.save();
  const { report: plainReport } = flattenDocument(plainBytes);
  assert(
    plainReport.nothingToDo === true,
    "already-flat: report.nothingToDo (normal usage, no throw)"
  );
  eq(plainReport.fieldCount, 0, "already-flat: no fields");
  eq(plainReport.annotationsBurned, 0, "already-flat: nothing burned");
  // The flatten fixture above must NOT be nothingToDo (real work).
  assert(
    report.nothingToDo === false,
    "annotated fixture: report.nothingToDo false (work was done)"
  );

  // Widget with a DIRECT /N appearance (not an indirect ref) — the OWN
  // engine's burnApTarget CLONES direct streams into source-anchored
  // synthetics, so what pdf-lib could not extract (its flatten threw
  // FlattenFormsError) now burns cleanly. A behavior UPGRADE locked here.
  const trickyBytes = await (async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    const f = d.getForm();
    const t = f.createTextField("tricky");
    t.setText("value");
    t.addToPage(p, { x: 50, y: 300, width: 200, height: 24 });
    const saved = await d.save();
    const re = await PDFDocument.load(saved, { updateMetadata: false });
    const field = re.getForm().getTextField("tricky");
    const widgetDict = field.acroField.getWidgets()[0].dict;
    widgetDict.set(
      PDFName.of("AP"),
      re.context.obj({
        N: formXObject(re, [0, 0, 100, 24], null, "0 0 0 rg 0 0 100 24 re f"),
      })
    );
    return re.save();
  })();
  {
    const { report: trickyReport, bytes: trickyFlat } =
      flattenDocument(trickyBytes);
    eq(trickyReport.fieldCount, 1, "direct-/N: field counted");
    const trickyReload = await PDFDocument.load(trickyFlat, {
      updateMetadata: false,
    });
    eq(
      trickyReload.getForm().getFields().length,
      0,
      "direct-/N: flattened (OWN engine clones the direct stream — no more FlattenFormsError)"
    );
    eq(
      trickyReload.getPages()[0].node.Annots(),
      undefined,
      "direct-/N: /Annots removed"
    );
  }

  // Encrypted input → the typed refusal maps to tool.errorEncrypted.
  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const encDoc = await CantooDoc.create();
  encDoc.addPage([300, 300]);
  encDoc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
  const encrypted = await encDoc.save({ useObjectStreams: false });
  try {
    flattenDocument(encrypted);
    fail("error: engine must refuse encrypted input");
  } catch (error) {
    eq(
      classifyFlattenError(error),
      "tool.errorEncrypted",
      "error: encrypted input → tool.errorEncrypted"
    );
  }

  // A page WITHOUT annotations must pass through the burn untouched.
  const multiBytes = await (async () => {
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    const p2 = d.addPage([200, 200]);
    const r = d.context.register(
      formXObject(d, [0, 0, 50, 20], null, "1 0 0 rg 0 0 50 20 re f")
    );
    const annot = d.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [50, 100, 100, 120],
      F: 4,
      AP: { N: r },
    });
    p2.node.addAnnot(d.context.register(annot));
    return d.save();
  })();
  const { report: multiReport, bytes: multiFlat } = flattenDocument(multiBytes);
  const multi = await PDFDocument.load(multiFlat, { updateMetadata: false });
  eq(
    multi.getPages()[0].node.Annots(),
    undefined,
    "multi-page: annotation-free page has no /Annots after burn"
  );
  assert(
    multi.getPages()[1].node.Annots() === undefined,
    "multi-page: second page /Annots removed"
  );
  eq(multiReport.annotationsBurned, 1, "multi-page: only the real annot burned");

  /* ------------------------------------------------------------------ */
  /* 6. worker E2E: nothing-to-flatten SUCCEEDS with the input passthrough */
  /* ------------------------------------------------------------------ */
  {
    const workerGlobal = globalThis as unknown as {
      postMessage: (msg: unknown) => void;
      onmessage: ((event: { data: unknown }) => void) | null;
    };
    const inbox: (Record<string, unknown> & { type: string })[] = [];
    workerGlobal.postMessage = (msg: unknown): void => {
      inbox.push(msg as Record<string, unknown> & { type: string });
    };
    (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
    await import("../tools/flatten-pdf/worker");
    assert(
      typeof workerGlobal.onmessage === "function",
      "worker: module loaded, onmessage registered"
    );

    const drive = async (runId: number, file: File): Promise<void> => {
      const before = inbox.length;
      workerGlobal.onmessage!({
        data: {
          type: "run",
          runId,
          toolId: "flatten-pdf",
          options: {},
          files: [file],
        },
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const terminal = inbox
          .slice(before)
          .some((m) => m.type === "result" || m.type === "error");
        if (terminal) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`worker run ${runId} did not finish`);
    };

    // Flat input: a plain single-page PDF with no fields, no annotations.
    const flatDoc = await PDFDocument.create();
    flatDoc.addPage([300, 300]);
    const flatBytes = await flatDoc.save();
    const flatFile = new File([flatBytes as BlobPart], "already-flat.pdf");
    await drive(7001, flatFile);

    const runMsgs = inbox.filter((m) => m.runId === 7001);
    const results = runMsgs.filter((m) => m.type === "result");
    const errors = runMsgs.filter((m) => m.type === "error");
    eq(results.length, 1, "worker flat run: exactly ONE result message");
    eq(errors.length, 0, "worker flat run: NO error (already-flat is normal usage)");
    const flatResult = results[0] as {
      outputs?: { name?: string; blob?: Blob }[];
      detail?: Record<string, unknown>;
    };
    eq(
      flatResult.detail?.nothingFlattened,
      true,
      "worker flat run: detail.nothingFlattened true"
    );
    eq(flatResult.detail?.pages, 1, "worker flat run: pages reported");
    eq(
      flatResult.outputs?.[0]?.name,
      "already-flat-flattened.pdf",
      "worker flat run: -flattened name kept"
    );
    const passedThrough = new Uint8Array(
      await (flatResult.outputs![0].blob as Blob).arrayBuffer()
    );
    assert(
      passedThrough.length === flatBytes.length &&
        passedThrough.every((b, i) => b === flatBytes[i]),
      "worker flat run: output is BYTE-IDENTICAL to the input (no re-save churn)"
    );

    // Control: the annotated fixture still burns + saves (not passthrough).
    const annotatedBytes = await readFile("download/qa-p41-flatten-fixture.pdf");
    await drive(7002, new File([annotatedBytes as BlobPart], "annotated.pdf"));
    const ctrlResults = inbox.filter(
      (m) => m.runId === 7002 && m.type === "result"
    );
    const ctrlErrors = inbox.filter(
      (m) => m.runId === 7002 && m.type === "error"
    );
    eq(ctrlResults.length, 1, "worker control: one result");
    eq(ctrlErrors.length, 0, "worker control: no error");
    const ctrl = ctrlResults[0] as { detail?: Record<string, unknown> };
    eq(
      ctrl.detail?.nothingFlattened,
      undefined,
      "worker control: nothingFlattened ABSENT for a real flatten"
    );
    assert(
      (ctrl.detail?.pages as number) === 1,
      "worker control: pages reported"
    );

    // i18n: the chip key exists in BOTH catalogs, the removed error key
    // exists in NEITHER (it is no longer posted by anything).
    const en = JSON.parse(
      new TextDecoder().decode(
        await readFile("src/i18n/en.json")
      )
    ) as { result?: Record<string, unknown>; flatten?: Record<string, unknown> };
    const hi = JSON.parse(
      new TextDecoder().decode(
        await readFile("src/i18n/hi.json")
      )
    ) as { result?: Record<string, unknown>; flatten?: Record<string, unknown> };
    assert(
      typeof en.result?.nothingFlattened === "string" &&
        typeof hi.result?.nothingFlattened === "string",
      "i18n: result.nothingFlattened in BOTH catalogs"
    );
    assert(
      en.flatten?.errorNothing === undefined &&
        hi.flatten?.errorNothing === undefined,
      "i18n: dead flatten.errorNothing removed from BOTH catalogs"
    );
  }

  console.log(
    `\nsmoke-flatten: ${passed}/${passed + failed} GREEN${failed > 0 ? ` (${failed} FAILED)` : ""}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("SMOKE CRASH", error);
  process.exit(1);
});
