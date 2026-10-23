/**
 * PRE-BUILD smoke test for Edit PDF (58th tool, PRD §8.2.1 — sub-phases
 * 8.1 shell + 8.2 objects + 8.5 export).
 *
 * Part 1 (model, pure): display↔pdf transforms for all four /Rotate
 * values, freehand normalisation, greedy word-wrap, z-order operations,
 * history semantics and the wire-blob sanitizer.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim (+ a fetch shim that serves the self-hosted
 * Devanagari TTF from public/). Every case reloads the produced bytes
 * with pdf-lib and asserts structure: page count, drawn-object detail
 * counts, text/image/shape operators in the file, asset pairing,
 * hidden-object dropping and the honest error codes.
 *
 * Run: bun scripts/smoke-edit-pdf.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import type { EditorObject, PageView } from "../tools/edit-pdf/model";
import {
  lockPdf,
  type LockRequest,
} from "../tools/lock-common/security";

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

/* ---- tiny File stand-in (worker calls .arrayBuffer/.name/.type) ---- */
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
  options: Record<string, string | number | boolean>,
  assets: FakeFile[] = []
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files: [file], options, assets },
  });
  for (let i = 0; i < 600; i += 1) {
    const terminal = inbox.find(
      (m) => m.type === "result" || m.type === "error"
    );
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

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** 1×1 red PNG (fixture for the image asset). */
function tinyRedPng(): Uint8Array {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Source page ${i + 1}`, {
      x: 48,
      y: 760,
      size: 14,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
  return doc.save();
}

async function main(): Promise<void> {
  /* ---- Part 1: the pure model ---- */
  const model = await import("../tools/edit-pdf/model");

  // Display ↔ pdf roundtrips for all four rotations.
  const views: PageView[] = [
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 0 },
    { x0: 20, y0: 10, x1: 632, y1: 802, rotate: 90 },
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 180 },
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 270 },
  ];
  for (const view of views) {
    const p = model.pdfToDisplayPoint(300, 400, view);
    const back = model.displayToPdfPoint(p.x, p.y, view);
    assert(
      Math.abs(back.x - 300) < 1e-9 && Math.abs(back.y - 400) < 1e-9,
      `point roundtrip rot=${view.rotate}`,
      { back }
    );
    const rect = { x: 40, y: 50, w: 200, h: 80 };
    const disp = model.pdfRectToDisplay(rect, view);
    const backRect = model.displayRectToPdf(disp, view);
    assert(
      Math.abs(backRect.x - 40) < 1e-6 &&
        Math.abs(backRect.y - 50) < 1e-6 &&
        Math.abs(backRect.w - 200) < 1e-6 &&
        Math.abs(backRect.h - 80) < 1e-6,
      `rect roundtrip rot=${view.rotate}`,
      { backRect }
    );
  }
  assertEqual(model.displaySize(views[1]), { w: 792, h: 612 }, "rot90 display size");

  // Freehand normalisation.
  const norm = model.normaliseDraw([
    { x: 10, y: 10 },
    { x: 110, y: 60 },
    { x: 60, y: 110 },
  ]);
  assert(norm !== null, "normaliseDraw returns result");
  if (norm) {
    assertEqual(norm.rect, { x: 10, y: 10, w: 100, h: 100 }, "draw bbox");
    assertEqual(norm.fracs[2], [0.5, 1], "draw point fraction");
  }
  assert(model.normaliseDraw([{ x: 1, y: 1 }, { x: 2, y: 2 }]) === null, "draw min points");

  // Greedy wrap + hard break (measure: 3 pt per character).
  const helv = (s: string): number => s.length * 3;
  const wrapped = model.wrapText("aaa bbb ccc ddd", 21, helv);
  assertEqual(wrapped, ["aaa bbb", "ccc ddd"], "greedy wrap");
  const hard = model.wrapText("abcdefghijkl", 21, helv);
  assertEqual(hard, ["abcdefg", "hijkl"], "hard-break overlong word");
  assertEqual(model.wrapText("", 21, helv), [""], "empty paragraph");

  // Z-order ops.
  const a = model.makeText(0, { x: 0, y: 0, w: 10, h: 10 });
  const b = model.makeShape(0, { x: 0, y: 0, w: 10, h: 10 }, "rect");
  const c = model.makeWhiteout(0, { x: 0, y: 0, w: 10, h: 10 });
  let list: EditorObject[] = [a, b, c];
  list = model.bringToFront(list, a.id);
  assertEqual(list.map((o) => o.id), [b.id, c.id, a.id], "bringToFront");
  list = model.sendToBack(list, a.id);
  assertEqual(list.map((o) => o.id), [a.id, b.id, c.id], "sendToBack");
  list = model.raiseOne(list, a.id);
  assertEqual(list.map((o) => o.id), [b.id, a.id, c.id], "raiseOne");
  list = model.lowerOne(list, c.id);
  assertEqual(list.map((o) => o.id), [b.id, c.id, a.id], "lowerOne");
  const dup = model.duplicateObject(list, b.id);
  assert(dup.copy !== null && dup.copy.id !== b.id, "duplicate has new id");
  assertEqual(dup.objects.length, 4, "duplicate grows list");

  // History.
  const s1 = model.pushSnapshot([], "a", []);
  assertEqual(s1.past.length, 1, "snapshot push");
  const undone = model.undoStep(s1.past, s1.future, "current");
  assertEqual(undone.snapshot, "a", "undo pops");
  assertEqual(undone.future[0], "current", "undo future");
  const redone = model.redoStep(undone.past, undone.future, undone.snapshot ?? "");
  assertEqual(redone.snapshot, "current", "redo pops");
  assertEqual(redone.past[redone.past.length - 1], undone.snapshot, "redo pushes current");

  // resizeRect with aspect lock.
  const resized = model.resizeRect(
    { x: 100, y: 100, w: 40, h: 20 },
    "se",
    200,
    200,
    6,
    true,
    2
  );
  assert(Math.abs(resized.w - resized.h * 2) < 1e-9, "aspect preserved");
  assert(resized.w >= 6 && resized.h >= 6, "resize min bound");

  // Sanitizer: clamps + drops.
  const assets = new Set(["k1"]);
  const sanitized = model.sanitizeObjects(
    [
      { ...model.makeText(0, { x: 1, y: 2, w: 30, h: 12 }), text: "hi" },
      { ...model.makeText(0, { x: 1, y: 2, w: 30, h: 12 }), hidden: true },
      { ...model.makeText(0, { x: 1, y: 2, w: 30, h: 12 }), page: 99 },
      { ...model.makeImage(0, { x: 1, y: 2, w: 30, h: 12 }, "missing") },
      { ...model.makeImage(0, { x: 1, y: 2, w: 30, h: 12 }, "k1") },
      { id: "junk", kind: "nope", page: 0, x: 0, y: 0, w: 1, h: 1 },
    ],
    3,
    assets
  );
  assertEqual(sanitized.length, 3, "sanitize drops hidden/garbage/missing asset");
  assertEqual(sanitized.find((o) => o.kind === "text" && o.page === 2) !== undefined, true, "page 99 clamped to last page");

  /* ---- Part 2: the worker (real module) ---- */
  await import("../tools/edit-pdf/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const source = new FakeFile("letter.pdf", await makeSourcePdf());

  // Blob + assetOrder for the full battery.
  const png = tinyRedPng();
  const pngFile = new FakeFile("photo.png", png, "image/png");
  const objects: EditorObject[] = [
    {
      ...model.makeText(0, { x: 60, y: 700, w: 300, h: 60 }),
      text: "Edited headline on the device",
      size: 18,
      bold: true,
      underline: true,
    },
    {
      ...model.makeText(0, { x: 60, y: 600, w: 220, h: 80 }),
      text: "नमस्ते दुनिया — यह हिंदी में है",
      font: "devanagari",
      size: 14,
      align: "center",
      bg: "#fef3c7",
    },
    {
      ...model.makeText(1, { x: 60, y: 700, w: 260, h: 40 }),
      text: "Italic times text",
      font: "times",
      italic: true,
    },
    model.makeShape(1, { x: 100, y: 400, w: 160, h: 90 }, "rect"),
    model.makeShape(1, { x: 300, y: 400, w: 120, h: 80 }, "ellipse"),
    { ...model.makeShape(1, { x: 100, y: 250, w: 200, h: 100 }, "line"), flip: true },
    model.makeShape(1, { x: 340, y: 250, w: 150, h: 70 }, "arrow"),
    {
      ...model.makeDraw(
        1,
        { x: 120, y: 120, w: 200, h: 80 },
        [
          [0, 0.5],
          [0.3, 0.1],
          [0.6, 0.9],
          [1, 0.4],
        ]
      ),
      stroke: "#0f766e",
    },
    { ...model.makeWhiteout(2, { x: 40, y: 700, w: 200, h: 30 }) },
    model.makeImage(2, { x: 380, y: 640, w: 120, h: 90 }, "k1"),
    // dropped: hidden
    { ...model.makeText(2, { x: 10, y: 10, w: 50, h: 20 }), hidden: true },
  ];
  const blob = {
    objects,
    pageViews: views.map((v) => ({ ...v })),
    assetOrder: ["k1"],
  };
  const outcome = await runWorker(source, {
    ekey: "f1",
    "e:f1": JSON.stringify(blob),
  }, [pngFile]);
  assert(outcome.error === null, "full battery: no error", outcome.error);
  assert(outcome.result !== null, "full battery: result posted");
  if (outcome.result) {
    assertEqual(outcome.result.detail?.objects, 10, "drawn object count (hidden dropped)");
    assertEqual(outcome.result.detail?.pages, 3, "page count kept");
    assertEqual(outcome.result.detail?.images, 1, "image embedded count");
    assert(outcome.outputs[0].name === "letter-edited.pdf", "output name");
  }

  const outBytes = await outcomeBytes(outcome);
  const reloaded = await PDFDocument.load(outBytes, {
    throwOnInvalidObject: false,
  });
  assertEqual(reloaded.getPageCount(), 3, "output pages");

  const raw = latin1(outBytes);
  assert(raw.includes("/Image"), "image XObject present");
  assert(raw.includes("/Subtype /Image") || raw.includes("/Subtype/Image"), "image dict");
  const sourceBytesLen = (await source.arrayBuffer()).byteLength;
  assert(outBytes.length > sourceBytesLen, "output grew with objects");

  // pdf-lib Flate-compresses content streams — inflate page 0's stream and
  // look for the text operators + our exact drawn words.
  const page0 = reloaded.getPages()[0];
  const contents = page0.node.Contents();
  const streams: PDFRawStream[] =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => page0.doc.context.lookup(r) as PDFRawStream)
      : [contents as unknown as PDFRawStream];
  let text0 = "";
  for (const stream of streams) {
    try {
      text0 += latin1(inflateSync(stream.contents));
    } catch {
      text0 += latin1(stream.contents);
    }
  }
  assert(text0.includes("Tj") || text0.includes("TJ"), "text operators present");
  // pdf-lib writes show-text operands as HEX strings — compare the hex form.
  const headlineHex = Buffer.from("Edited headline", "latin1")
    .toString("hex")
    .toUpperCase();
  assert(text0.includes(headlineHex), "bold text content drawn");

  // Devanagari subset: a Type0 (CID) font in page 0's resources.
  const fontsDict = page0.node
    .Resources()
    ?.lookup(PDFName.of("Font")) as PDFDict | undefined;
  let hasType0 = false;
  if (fontsDict) {
    for (const [, ref] of fontsDict.entries()) {
      const font = page0.doc.context.lookup(ref) as PDFDict | undefined;
      const sub = font?.lookup(PDFName.of("Subtype"))?.toString() ?? "";
      if (sub.includes("Type0")) hasType0 = true;
    }
  }
  assert(hasType0, "devanagari Type0 font embedded");

  /* ---- passthrough: zero objects = untouched content ---- */
  const plain = await runWorker(source, {
    ekey: "f2",
    "e:f2": JSON.stringify({
      objects: [],
      pageViews: [{ x0: 0, y0: 0, x1: 595.28, y1: 841.89, rotate: 0 }],
      assetOrder: [],
    }),
  });
  assert(plain.error === null, "passthrough: no error", plain.error);
  if (plain.result) {
    assertEqual(plain.result.detail?.objects, 0, "passthrough object count");
  }

  /* ---- corrupt source → honest error ---- */
  const corrupt = new FakeFile(
    "bad.pdf",
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x99, 0x99, 0x99])
  );
  const bad = await runWorker(corrupt, {
    ekey: "f3",
    "e:f3": JSON.stringify({ objects: [], pageViews: [], assetOrder: [] }),
  });
  assert(bad.error !== null, "corrupt: error posted");
  assertEqual(bad.error?.code, "tool.errorCorrupt", "corrupt error code");

  /* ---- encrypted source → honest refusal (FIX-1c regression) ---- */
  // Real AES-256 fixture (the lock-pdf engine). The worker loads with
  // ignoreEncryption:true, so without the isEncrypted guard it would
  // draw onto still-encrypted streams and re-save a corrupted file —
  // the UI gate is the only cover today; this keeps the worker honest.
  const lockReq = (over: Partial<LockRequest> = {}): LockRequest => ({
    userPw: "open123",
    ownerPw: "",
    alg: "aes256",
    permissions: {
      printing: true,
      copying: false,
      modifying: false,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
    },
    ...over,
  });
  const encryptedBytes = (await lockPdf(await makeSourcePdf(), lockReq())).bytes;
  const encRun = await runWorker(
    new FakeFile("locked.pdf", encryptedBytes),
    {
      ekey: "f4",
      "e:f4": JSON.stringify({ objects: [], pageViews: [], assetOrder: [] }),
    }
  );
  assert(encRun.result === null, "encrypted: no result/output emitted");
  assert(encRun.error !== null, "encrypted: error posted");
  assertEqual(
    encRun.error?.code,
    "tool.errorEncrypted",
    "encrypted error code (PDF_PASSWORD branch now reachable)"
  );

  // Owner-only variant (empty USER password): pdf.js opens it fine — the
  // surface stays usable — so the worker refusal is the only backstop.
  const ownerOnlyBytes = (
    await lockPdf(await makeSourcePdf(), lockReq({ userPw: "", ownerPw: "owner999" }))
  ).bytes;
  const ownerRun = await runWorker(
    new FakeFile("owner-only.pdf", ownerOnlyBytes),
    {
      ekey: "f5",
      "e:f5": JSON.stringify({ objects: [], pageViews: [], assetOrder: [] }),
    }
  );
  assert(ownerRun.result === null, "owner-only encrypted: no result emitted");
  assertEqual(
    ownerRun.error?.code,
    "tool.errorEncrypted",
    "owner-only encrypted error code"
  );

  /* ---- summary ---- */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
