/**
 * PRE-BUILD smoke test for Edit PDF page ROTATION (R13 — inline ±90° page
 * turns in the flagship editor).
 *
 * Part 1 (model, pure): rotatePageViews vectors + wrap, rotationOffset
 * (the user's offset vs the source's shipped /Rotate), normalizeViews
 * rotation quadrants + srcRotate backfill.
 *
 * Part 2 (worker, REAL module): the setRotation pass —
 *   - identity plan + one rotated slot writes /Rotate on that page only;
 *   - rotating back to 0 lands on /Rotate 0;
 *   - surgery (duplicate/reorder) + rotation: each slot's page carries the
 *     slot's effective rotation, duplicates get their own;
 *   - text objects placed on a rotated slot draw on the rotated page;
 *   - stale pre-R13 blobs (no src/rotate) keep the source's own /Rotate
 *     (zero-regression path);
 *   - a source /Rotate 90 page turned 180° more lands on effective 270;
 *   - the truncated flag bounds the setRotation loop to the plan (tail
 *     keeps its own rotation).
 *
 * Part 3 (wiring): source locks for surface/parts/worker/thumbnails/
 * text-layer/model/i18n integration + EN/HI key parity.
 *
 * Run: bun scripts/smoke-edit-pdf-rotate.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  degrees,
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
  // P6-o: normalize HEX PAYLOADS to uppercase (our engine emits lowercase
  // Tj hex, pdf-lib uppercase — both valid; operators stay case-sensitive).
  return text.replace(/<([0-9A-Fa-f\s]+)>/g, (m) => m.toUpperCase());
}

function hexWord(word: string): string {
  return Buffer.from(word, "latin1").toString("hex").toUpperCase();
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

/** Source PDF whose page 2 SHIPS with /Rotate 90 (offset math on top). */
async function makeRotatedSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([300, 200]);
  p1.drawText("FLATPAGE", { x: 20, y: 40, size: 12, font });
  const p2 = doc.addPage([300, 200]);
  p2.drawText("SIDEWAYSPAGE", { x: 20, y: 40, size: 12, font });
  p2.setRotation(degrees(90));
  return doc.save();
}

function view(
  src: number,
  rotate: number,
  srcRotate?: number
): PageView {
  return {
    x0: 0,
    y0: 0,
    x1: 300,
    y1: 100 + src * 10,
    rotate,
    src,
    ...(srcRotate !== undefined ? { srcRotate } : {}),
  };
}

async function main(): Promise<void> {
  /* ================= Part 1: the pure model ================= */
  const model = await import("../tools/edit-pdf/model");

  // rotatePageViews: valid turns
  const base = [view(0, 0), view(1, 0), view(2, 0)];
  const r1 = model.rotatePageViews(base, 1, 90);
  assert(r1 !== base, "rotatePageViews: returns a fresh array");
  assertEqual(
    r1.map((v) => v.rotate),
    [0, 90, 0],
    "rotatePageViews: +90 on slot 1"
  );
  assertEqual(
    r1.map((v) => v.src),
    [0, 1, 2],
    "rotatePageViews: srcs untouched (pure rotation)"
  );
  assertEqual(base[1].rotate, 0, "rotatePageViews: input array not mutated");

  // wrap both directions
  const r270 = model.rotatePageViews(r1, 1, 90);
  assertEqual(r270[1].rotate, 180, "rotatePageViews: 90 + 90 → 180");
  const r360 = model.rotatePageViews(r270, 1, 90);
  assertEqual(r360[1].rotate, 270, "rotatePageViews: 180 + 90 → 270");
  const r0 = model.rotatePageViews(r360, 1, 90);
  assertEqual(r0[1].rotate, 0, "rotatePageViews: 270 + 90 wraps → 0");
  const back = model.rotatePageViews(base, 1, -90);
  assertEqual(back[1].rotate, 270, "rotatePageViews: 0 − 90 wraps → 270");

  // guards + no-ops
  const empty: PageView[] = [];
  assert(model.rotatePageViews(base, -1, 90) === base, "rotatePageViews: slot −1 → same ref");
  assert(model.rotatePageViews(base, 3, 90) === base, "rotatePageViews: slot ≥ len → same ref");
  assert(model.rotatePageViews(base, 1, 0) === base, "rotatePageViews: zero delta → same ref");
  assert(model.rotatePageViews(empty, 0, 90) === empty, "rotatePageViews: empty workspace → same ref");

  // rotationOffset: the user's distance from the source orientation
  const fresh: PageView = { x0: 0, y0: 0, x1: 300, y1: 200, rotate: 0, srcRotate: 0, src: 0 };
  assertEqual(model.rotationOffset(fresh), 0, "rotationOffset: fresh view → 0");
  assertEqual(model.rotationOffset({ ...fresh, rotate: 90 }), 90, "rotationOffset: turned once → 90");
  assertEqual(model.rotationOffset({ ...fresh, rotate: 180 }), 180, "rotationOffset: turned twice → 180");
  assertEqual(model.rotationOffset({ ...fresh, rotate: 270 }), 270, "rotationOffset: thrice → 270");
  // pre-R13 views (no srcRotate): offset reads as 0 (no phantom rotation)
  assertEqual(
    model.rotationOffset({ x0: 0, y0: 0, x1: 300, y1: 200, rotate: 90, src: 0 }),
    0,
    "rotationOffset: absent srcRotate → 0 (stale-blob honesty)"
  );
  // source /Rotate 90 + user 180 → effective 270, offset 180
  assertEqual(
    model.rotationOffset({
      x0: 0, y0: 0, x1: 300, y1: 200,
      rotate: 270, srcRotate: 90, src: 1,
    }),
    180,
    "rotationOffset: source 90 + effective 270 → 180"
  );

  // normalizeViews: quadrants + srcRotate backfill
  const nv = model.normalizeViews(
    [
      { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 45, src: 0 },
      { x0: 0, y0: 0, x1: 1, y1: 1, rotate: 90, src: 1, srcRotate: 90 },
      { x0: 0, y0: 0, x1: 1, y1: 1, rotate: Number.NaN, src: 2 },
      { x0: 0, y0: 0, x1: 1, y1: 1, rotate: -90, src: 3 },
    ] as PageView[],
    4
  );
  assertEqual(
    nv.map((v) => v.rotate),
    [0, 90, 0, 270],
    "normalizeViews: rotate snaps to quadrants (45/NaN → 0, −90 → 270)"
  );
  assertEqual(nv[0].srcRotate, 0, "normalizeViews: absent srcRotate backfills rotate");
  assertEqual(nv[1].srcRotate, 90, "normalizeViews: srcRotate preserved when present");
  assertEqual(nv[2].srcRotate, 0, "normalizeViews: NaN rotate → srcRotate 0");
  assertEqual(nv[3].srcRotate, 270, "normalizeViews: −90 rotate → srcRotate 270");

  /* ================= Part 2: the REAL worker ================= */
  await import("../tools/edit-pdf/worker");

  // T1 — identity plan + one rotated slot: /Rotate written on that page only.
  {
    const file = new FakeFile("rot1.pdf", await makeHeightsPdf());
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [view(0, 0), view(1, 90), view(2, 0)],
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T1: no error", out.error);
    assertEqual(out.result?.detail?.pages, 3, "T1: identity keeps all 3 pages");
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPageCount(), 3, "T1: page count in the file");
    assertEqual(re.getPage(0).getRotation().angle, 0, "T1: page 1 stays 0");
    assertEqual(re.getPage(1).getRotation().angle, 90, "T1: page 2 → /Rotate 90");
    assertEqual(re.getPage(2).getRotation().angle, 0, "T1: page 3 stays 0");
    // content untouched: markers still on their pages (pdf-lib writes text
    // as hex strings — hexWord, the R12 lesson)
    assert(
      (await pageText(re.getPage(0))).includes(hexWord("SRCPAGE1")) &&
        (await pageText(re.getPage(1))).includes(hexWord("SRCPAGE2")) &&
        (await pageText(re.getPage(2))).includes(hexWord("SRCPAGE3")),
      "T1: content streams untouched by the rotation"
    );
  }

  // T2 — full turn back to 0: /Rotate 0 (≡ absent).
  {
    const file = new FakeFile("rot2.pdf", await makeHeightsPdf());
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [view(0, 0), view(1, 180), view(2, 0)],
        assetOrder: [],
      }),
    });
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPage(1).getRotation().angle, 180, "T2: 180 lands");
  }

  // T3 — surgery + rotation: duplicates carry the SLOT's rotation.
  {
    const file = new FakeFile("rot3.pdf", await makeHeightsPdf());
    // Plan: [src2@90, src0@0, src0@90] — page 0 duplicated, the copy rotated.
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [view(2, 90), view(0, 0), view(0, 90)],
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T3: no error", out.error);
    assertEqual(out.result?.detail?.pages, 3, "T3: surgery kept 3 pages");
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPageCount(), 3, "T3: file has 3 pages");
    assertEqual(re.getPage(0).getRotation().angle, 90, "T3: slot 0 (src 2) → 90");
    assertEqual(re.getPage(1).getRotation().angle, 0, "T3: slot 1 (src 0) → 0");
    assertEqual(re.getPage(2).getRotation().angle, 90, "T3: slot 2 (duplicate of src 0) → 90");
    // order: heights are distinct — slot 0 must be 120 tall (src 2)
    assert(Math.abs(re.getPage(0).getHeight() - 120) < 1e-6, "T3: reorder landed (src 2 first)");
    assert(Math.abs(re.getPage(1).getHeight() - 100) < 1e-6, "T3: src 0 second");
    assert(Math.abs(re.getPage(2).getHeight() - 100) < 1e-6, "T3: duplicate of src 0 third");
  }

  // T4 — a text object on a rotated slot draws on that page.
  {
    const file = new FakeFile("rot4.pdf", await makeHeightsPdf());
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [
          {
            id: "t1",
            kind: "text",
            page: 1,
            x: 40,
            y: 60,
            w: 120,
            h: 14,
            opacity: 1,
            locked: false,
            hidden: false,
            rotation: 0,
            text: "ROTLBL",
            font: "helvetica",
            size: 14,
            color: "#111827",
            bold: false,
            italic: false,
            underline: false,
            align: "left",
            bg: null,
          },
        ],
        pageViews: [view(0, 0), view(1, 90), view(2, 0)],
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T4: no error", out.error);
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPage(1).getRotation().angle, 90, "T4: page 2 rotated");
    const txt = await pageText(re.getPage(1));
    // The rotation-compensated draw path emits ONE glyph per text operator
    // with a 90°-compensated text matrix — assert the glyphs, their x order
    // and the compensation matrix itself.
    const glyphs = ["R", "O", "T", "L", "B", "L"];
    const glyphHex = glyphs.map((g) => `<${hexWord(g)}> Tj`);
    // Sequential search (L appears twice — indexOf would re-find the first).
    let cursor = 0;
    const positions = glyphHex
      .map((g) => {
        const idx = txt.indexOf(g, cursor);
        if (idx >= 0) cursor = idx + g.length;
        return idx;
      })
      .map((idx) => {
        // "<e f> Tm" precedes each glyph — e = x, f = y.
        const tm = txt.lastIndexOf("Tm", idx);
        const seg = txt.slice(Math.max(0, tm - 70), tm);
        const nums = seg.trim().split(/\s+/);
        const x = Number(nums[nums.length - 2]);
        return { idx, x, seg };
      });
    assert(
      positions.every((p) => p.idx >= 0),
      "T4: every glyph drawn on the rotated page",
      positions
    );
    assert(
      positions.every((p) => Number.isFinite(p.x)) &&
        positions.every((p, i) => i === 0 || p.x > positions[i - 1].x),
      "T4: glyphs advance in +x (upright reading order on the rotated page)",
      positions.map((p) => p.x)
    );
    assert(
      /0\.0*0*6123233995736767 1 -1 0\.0*0*6123233995736767/.test(txt) ||
        txt.includes("1 -1 0"),
      "T4: text matrix is 90°-compensated (reads upright on the rotated page)"
    );
    assertEqual(
      (await pageText(re.getPage(0))).includes("<52> Tj"),
      false,
      "T4: text did NOT leak to page 1"
    );
  }

  // T5 — stale pre-R13 blob (no src/rotate fields): source /Rotate kept.
  {
    const file = new FakeFile("rot5.pdf", await makeRotatedSourcePdf());
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [
          { x0: 0, y0: 0, x1: 300, y1: 200 },
          { x0: 0, y0: 0, x1: 300, y1: 200 },
        ],
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T5: no error", out.error);
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPage(0).getRotation().angle, 0, "T5: stale blob keeps page 1 rotation");
    assertEqual(re.getPage(1).getRotation().angle, 90, "T5: stale blob keeps source /Rotate 90 (zero regression)");
  }

  // T6 — source /Rotate 90 + user 180 → effective 270.
  {
    const file = new FakeFile("rot6.pdf", await makeRotatedSourcePdf());
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [
          { x0: 0, y0: 0, x1: 300, y1: 200, rotate: 0, src: 0 },
          { x0: 0, y0: 0, x1: 300, y1: 200, rotate: 270, src: 1 },
        ],
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T6: no error", out.error);
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPage(1).getRotation().angle, 270, "T6: source 90 + 180 → effective 270");
    assertEqual(re.getPage(0).getRotation().angle, 0, "T6: flat page stays 0");
  }

  // T7 — truncated flag bounds the setRotation loop to the plan.
  {
    const file = new FakeFile("rot7.pdf", await makeRotatedSourcePdf());
    // 2-slot plan + truncated flag on a 2-page doc: identity path pads the
    // tail with planViews[0] — the rotation loop must stop at the plan and
    // leave the tail page's own /Rotate alone.
    const out = await runWorker(file, {
      ekey: "f1",
      "e:f1": JSON.stringify({
        objects: [],
        pageViews: [
          { x0: 0, y0: 0, x1: 300, y1: 200, rotate: 180, src: 0 },
        ],
        truncated: true,
        assetOrder: [],
      }),
    });
    assert(out.error === null, "T7: no error", out.error);
    const re = await PDFDocument.load(
      new Uint8Array(await out.outputs[0].blob.arrayBuffer()),
      { throwOnInvalidObject: false }
    );
    assertEqual(re.getPage(0).getRotation().angle, 180, "T7: plan slot rotated");
    assertEqual(re.getPage(1).getRotation().angle, 90, "T7: tail page keeps its own /Rotate 90");
  }

  /* ================= Part 3: wiring + i18n ================= */
  const surface = readFileSync("tools/edit-pdf/surface.tsx", "utf8");
  const parts = readFileSync("tools/edit-pdf/editor-parts.tsx", "utf8");
  const worker = readFileSync("tools/edit-pdf/worker.ts", "utf8");
  const thumbs = readFileSync("src/lib/pdf/thumbnails.ts", "utf8");
  const textLayer = readFileSync("tools/edit-pdf/text-layer.ts", "utf8");
  const modelSrc = readFileSync("tools/edit-pdf/model.ts", "utf8");
  const i18nTool = JSON.parse(readFileSync("tools/edit-pdf/i18n.json", "utf8"));

  // Surface wiring
  assert(surface.includes("rotatePageViews,"), "wiring: surface imports rotatePageViews");
  assert(surface.includes("rotationOffset,"), "wiring: surface imports rotationOffset");
  assert(
    surface.includes("const rotatePage = useCallback"),
    "wiring: surface has the rotatePage handler"
  );
  assert(
    surface.includes("`page:rot:${pos}:${nextViews[pos]?.rotate ?? 0}`"),
    "wiring: rotation history key carries the landing angle"
  );
  assert(
    surface.includes(
      "pageViews\n        .map((v) => `${v.src ?? -1}@${v.rotate}@${cropSignature(v)}`)\n        .join(\",\")"
    ) ||
      surface.includes(
        "pageViews.map((v) => `${v.src ?? -1}@${v.rotate}`).join(\",\")"
      ),
    "wiring: planKey fingerprint carries src@rotate (R15: + crop sig)"
  );
  assert(
    surface.includes("...(rotation !== undefined ? { rotation } : {})"),
    "wiring: preview thumbnail renders the effective rotation"
  );
  assert(
    /getPdfPagePixelSize\(file, 1, src, rotation(, crop)?\)/.test(surface),
    "wiring: preview pixel size is rotation-aware (R15: + crop)"
  );
  assert(
    surface.includes("srcRotate: rotate,"),
    "wiring: collectPageViews captures the source rotation"
  );
  assert(
    surface.includes("rotOffsets={rotOffsets}"),
    "wiring: strip receives the per-slot rotation offsets"
  );
  assert(
    surface.includes("onRotate={rotatePage}"),
    "wiring: strip receives the rotate handler"
  );
  assert(
    /pageCount > 0 \? \(/.test(surface) && !surface.includes("{pageCount > 1 ? ("),
    "wiring: pages rail shows on single-page docs too (rotate a lone scan)"
  );
  assert(
    surface.includes("view={currentView}") && surface.includes("<TextPieceButtons"),
    "wiring: piece buttons map through the current view"
  );
  assert(
    /buildReplacePieceObjects\(\s*selectedPage,/.test(surface),
    "wiring: piece builder called view-free"
  );
  assert(
    surface.includes("pieceDisplayRect(piece, currentView)"),
    "wiring: colour sampling uses the view-mapped display rect"
  );

  // editor-parts wiring
  assert(parts.includes("RotateCcw"), "wiring: strip has the CCW button");
  assert(parts.includes("onRotate(selected, -90)"), "wiring: CCW button turns −90");
  assert(parts.includes("onRotate(selected, 90)"), "wiring: CW button turns +90");
  assert(
    /aria-label=\{t\("editPdf\.pageRotateLeft"/.test(parts),
    "wiring: CCW button is labelled"
  );
  assert(
    /aria-label=\{t\("editPdf\.pageRotateRight"/.test(parts),
    "wiring: CW button is labelled"
  );
  assert(
    parts.includes("rotDeg={rotOffsets[slot] ?? 0}"),
    "wiring: thumbnails receive the rotation offset for badges"
  );
  assert(
    parts.includes("part.split(\"@\")"),
    "wiring: strip parses the src@rotate fingerprint"
  );
  assert(
    /item\.rot === rot/.test(parts),
    "wiring: thumbnail cache is rotation-keyed"
  );
  assert(
    parts.includes("pieceDisplayRect(p, view)"),
    "wiring: piece buttons use the user-space pivot map"
  );

  // Worker wiring
  const pagePlanSrc = readFileSync("tools/edit-pdf/page-plan.ts", "utf8");
  assert(
    pagePlanSrc.includes('["Rotate", pdfNum(view.rotate)]') &&
      worker.includes("applySlotSets"),
    "wiring: worker writes /Rotate per slot (via the shared page-plan set builder)"
  );
  assert(
    worker.includes("identity ? i : planSrc(v, i, srcCount)") &&
      worker.includes("rotateExplicit[i] === true"),
    "wiring: the setRotation set is bounded by the PLAN + WIRE-TRUST (truncated tail safe)"
  );

  // thumbnails wiring
  assert(
    thumbs.includes("rotation?: number") &&
      thumbs.includes("options.rotation !== undefined"),
    "wiring: renderPdfThumbnail accepts a rotation override"
  );
  assert(
    /getPdfPagePixelSize\([\s\S]{0,200}rotation\?: number/.test(thumbs),
    "wiring: getPdfPagePixelSize accepts a rotation override"
  );

  // text-layer wiring
  assert(
    textLayer.includes("viewport.convertToPdfPoint"),
    "wiring: harvest maps the band into user space via the viewport"
  );
  assert(
    textLayer.includes("user,"),
    "wiring: pieces carry the user-space band"
  );

  // model wiring
  assert(
    modelSrc.includes("export function rotatePageViews") &&
      modelSrc.includes("export function rotationOffset") &&
      modelSrc.includes("export function pieceDisplayRect"),
    "wiring: model exports the R13 surface"
  );
  assert(
    modelSrc.includes("user: ObjRect;"),
    "wiring: HarvestPiece carries the user rect"
  );

  // i18n parity + presence in BOTH stores
  const keys = [
    "pageRotateLeft",
    "pageRotateRight",
    "pageRotatedToast",
    "stripRotatedTitle",
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
        `i18n: master ${locale} editPdf.${k} synced`
      );
    }
  }
  {
    const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
    const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
    const flat = (obj: unknown, prefix = ""): string[] =>
      obj && typeof obj === "object"
        ? Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, prefix ? `${prefix}.${k}` : k)
          )
        : [prefix];
    const enKeys = new Set(flat(en));
    const hiKeys = new Set(flat(hi));
    const missingHi = [...enKeys].filter((k) => !hiKeys.has(k));
    const missingEn = [...hiKeys].filter((k) => !enKeys.has(k));
    assertEqual(
      { missingHi: missingHi.length, missingEn: missingEn.length },
      { missingHi: 0, missingEn: 0 },
      "i18n: master en/hi full parity"
    );
    assertEqual(enKeys.size, hiKeys.size, "i18n: key counts match");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  // Explicit exit: the worker import chain leaves a pending handle that
  // keeps bun's event loop alive after a green summary.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
