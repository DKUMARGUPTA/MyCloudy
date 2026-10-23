/**
 * PRE-BUILD smoke test for Set viewer preferences (56th tool, PRD §8.5).
 *
 * The worker is pure pdf-lib (no canvas, no pdf.js), so bun runs the
 * REAL worker module with a self/postMessage shim — not a copy of the
 * logic. Every case loads the produced bytes back with pdf-lib and
 * asserts the catalog entries structurally.
 *
 * Run: bun scripts/smoke-viewer-prefs.ts
 */
import { PDFArray, PDFDocument, PDFName, PDFNumber } from "pdf-lib";

import { hasExistingSignature } from "../tools/digital-signature/model";

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
};
workerGlobal.postMessage = (msg: unknown) => {
  inbox.push(msg as Posted);
};
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;

/* ---- tiny File stand-in (worker only calls .arrayBuffer + .name) ---- */
class FakeFile {
  name: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array) {
    this.name = name;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
}

interface RunOutcome {
  result: (Posted & { type: "result" }) | null;
  error: (Posted & { type: "error" }) | null;
  outputs: { name: string; blob: { arrayBuffer(): Promise<ArrayBuffer> } }[];
}

async function runWorker(
  file: FakeFile,
  options: Record<string, string | number | boolean>
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files: [file], options },
  });
  // The worker is fully synchronous-ish per message but awaits — poll
  // until the terminal message lands.
  for (let i = 0; i < 500; i += 1) {
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

async function reload(outcome: RunOutcome): Promise<PDFDocument> {
  if (!outcome.result) throw new Error("no result message");
  const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  return PDFDocument.load(bytes, { throwOnInvalidObject: false });
}

function catalogValue(doc: PDFDocument, key: string): string | null {
  const value = doc.catalog.lookup(PDFName.of(key));
  return value === undefined ? null : value.toString();
}

function openActionParts(doc: PDFDocument): string[] {
  const dest = doc.catalog.lookup(PDFName.of("OpenAction")) as
    | PDFArray
    | undefined;
  if (!dest) return [];
  const parts: string[] = [];
  for (let i = 0; i < dest.size(); i += 1) {
    const item = dest.lookup(i);
    parts.push(item === null || item === undefined ? "null" : item.toString());
  }
  return parts;
}

/**
 * pdf-lib getters fall back to false for missing keys, so "untouched"
 * has to be checked against the raw dict entry.
 */
function prefIsSet(doc: PDFDocument, key: string): boolean {
  const vp = doc.catalog.getOrCreateViewerPreferences();
  return vp.dict.lookup(PDFName.of(key)) !== undefined;
}

async function main(): Promise<void> {
  await import("../tools/set-pdf-viewer-preferences/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  /* ---- source fixture: 3 pages, distinctive widths ---- */
  const src = await PDFDocument.create();
  src.addPage([100, 200]);
  src.addPage([210, 300]);
  src.addPage([320, 440]);
  const srcBytes = await src.save();

  /* 1. Full battery — every option set at once. */
  {
    const outcome = await runWorker(new FakeFile("demo.pdf", srcBytes), {
      layout: "TwoColumnLeft",
      pageMode: "FullScreen",
      exitFsMode: "UseOutlines",
      zoom: "150",
      startPage: 2,
      showTitle: "on",
      hideToolbar: "on",
      hideMenubar: "on",
      hideWindowUI: "on",
      fitWindow: "on",
      centerWindow: "on",
    });
    assert(outcome.error === null, "battery: no error", outcome.error);
    const doc = await reload(outcome);
    assertEqual(catalogValue(doc, "PageLayout"), "/TwoColumnLeft", "battery: PageLayout");
    assertEqual(catalogValue(doc, "PageMode"), "/FullScreen", "battery: PageMode");
    const vp = doc.catalog.getOrCreateViewerPreferences();
    assertEqual(vp.getHideToolbar(), true, "battery: HideToolbar");
    assertEqual(vp.getHideMenubar(), true, "battery: HideMenubar");
    assertEqual(vp.getHideWindowUI(), true, "battery: HideWindowUI");
    assertEqual(vp.getFitWindow(), true, "battery: FitWindow");
    assertEqual(vp.getCenterWindow(), true, "battery: CenterWindow");
    assertEqual(vp.getDisplayDocTitle(), true, "battery: DisplayDocTitle");
    assertEqual(vp.getNonFullScreenPageMode(), "UseOutlines", "battery: NonFullScreenPageMode");
    const parts = openActionParts(doc);
    // [page-2-ref, /XYZ, null, null, 1.5]
    assertEqual(parts.length, 5, "battery: OpenAction arity");
    assertEqual(parts[1], "/XYZ", "battery: OpenAction dest type");
    assertEqual(parts[2], "null", "battery: OpenAction left null");
    assertEqual(parts[3], "null", "battery: OpenAction top null");
    assertEqual(Number(parts[4]), 1.5, "battery: OpenAction zoom 150%");
    // The page entry resolves to the page dict — page 2 is the 210×300 one.
    assert(
      parts[0].includes("/MediaBox [ 0 0 210 300 ]"),
      "battery: OpenAction points at page 2 (210×300)",
      { openActionPage: parts[0] }
    );
    assertEqual(
      (outcome.result?.detail as Record<string, unknown>)?.pages,
      3,
      "battery: result detail pages"
    );
    assert(
      outcome.outputs[0].name === "demo-viewersettings.pdf",
      "battery: output name",
      outcome.outputs[0].name
    );
  }

  /* 2. All defaults — nothing must be written at all. */
  {
    const outcome = await runWorker(new FakeFile("clean.pdf", srcBytes), {
      layout: "keep",
      pageMode: "keep",
      zoom: "keep",
      startPage: 1,
      showTitle: "keep",
      hideToolbar: "keep",
      hideMenubar: "keep",
      hideWindowUI: "keep",
      fitWindow: "keep",
      centerWindow: "keep",
    });
    assert(outcome.error === null, "defaults: no error", outcome.error);
    const doc = await reload(outcome);
    assertEqual(catalogValue(doc, "PageLayout"), null, "defaults: no PageLayout");
    assertEqual(catalogValue(doc, "PageMode"), null, "defaults: no PageMode");
    assertEqual(catalogValue(doc, "OpenAction"), null, "defaults: no OpenAction");
    assertEqual(catalogValue(doc, "ViewerPreferences"), null, "defaults: no ViewerPreferences dict");
    assertEqual(doc.getPageCount(), 3, "defaults: page count preserved");
  }

  /* 3. Zoom only — nothing else touched. */
  {
    const outcome = await runWorker(new FakeFile("z.pdf", srcBytes), {
      zoom: "fitWidth",
      startPage: 1,
    });
    const doc = await reload(outcome);
    const parts = openActionParts(doc);
    assertEqual(parts.length, 3, "zoom-only: /FitH arity");
    assertEqual(parts[1], "/FitH", "zoom-only: dest type");
    assertEqual(parts[2], "null", "zoom-only: top null");
    // Page 1 is the 100×200 one.
    assert(
      parts[0].includes("/MediaBox [ 0 0 100 200 ]"),
      "zoom-only: OpenAction points at page 1 (100×200)",
      { openActionPage: parts[0] }
    );
    assertEqual(catalogValue(doc, "PageLayout"), null, "zoom-only: layout untouched");
    assertEqual(catalogValue(doc, "ViewerPreferences"), null, "zoom-only: prefs untouched");
  }

  /* 4. Fit-page zoom. */
  {
    const outcome = await runWorker(new FakeFile("f.pdf", srcBytes), {
      zoom: "fitPage",
      startPage: 1,
    });
    const doc = await reload(outcome);
    const parts = openActionParts(doc);
    assertEqual(parts.length, 2, "fit-page: /Fit arity");
    assertEqual(parts[1], "/Fit", "fit-page: dest type");
  }

  /* 5. Start page only (zoom keep) — page jump, zoom null. */
  {
    const outcome = await runWorker(new FakeFile("p.pdf", srcBytes), {
      zoom: "keep",
      startPage: 3,
    });
    const doc = await reload(outcome);
    const parts = openActionParts(doc);
    assertEqual(parts.length, 5, "start-page: /XYZ arity");
    assertEqual(parts[1], "/XYZ", "start-page: dest type");
    assertEqual(parts[4], "null", "start-page: zoom null");
    assert(
      parts[0].includes("/MediaBox [ 0 0 320 440 ]"),
      "start-page: OpenAction points at page 3 (320×440)",
      { openActionPage: parts[0] }
    );
  }

  /* 6. Explicit "off" writes false (not skip). */
  {
    const outcome = await runWorker(new FakeFile("off.pdf", srcBytes), {
      showTitle: "off",
      hideToolbar: "off",
      hideMenubar: "keep",
    });
    const doc = await reload(outcome);
    const vp = doc.catalog.getOrCreateViewerPreferences();
    assertEqual(vp.getDisplayDocTitle(), false, "off: DisplayDocTitle false");
    assertEqual(vp.getHideToolbar(), false, "off: HideToolbar false");
    assert(
      !prefIsSet(doc, "HideMenubar"),
      "off: HideMenubar untouched (key absent from dict)",
      { raw: vp.dict.lookup(PDFName.of("HideMenubar"))?.toString() }
    );
  }

  /* 7. Start page clamps to the last page. */
  {
    const outcome = await runWorker(new FakeFile("c.pdf", srcBytes), {
      zoom: "100",
      startPage: 99,
    });
    const doc = await reload(outcome);
    const parts = openActionParts(doc);
    assert(
      parts[0].includes("/MediaBox [ 0 0 320 440 ]"),
      "clamp: page 99 on a 3-page doc opens the last page (320×440)",
      { openActionPage: parts[0] }
    );
    assertEqual(Number(parts[4]), 1, "clamp: zoom still 100%");
  }

  /* 8. Fullscreen without an exit choice — defaults to UseNone. */
  {
    const outcome = await runWorker(new FakeFile("fs.pdf", srcBytes), {
      pageMode: "FullScreen",
    });
    const doc = await reload(outcome);
    assertEqual(catalogValue(doc, "PageMode"), "/FullScreen", "fs: PageMode");
    const vp = doc.catalog.getOrCreateViewerPreferences();
    assertEqual(vp.getNonFullScreenPageMode(), "UseNone", "fs: exit defaults to UseNone");
  }

  /* 9. Unknown values are ignored like "keep" (defensive whitelist). */
  {
    const outcome = await runWorker(new FakeFile("w.pdf", srcBytes), {
      layout: "ThreeColumnMiddle",
      pageMode: "UsePrinters",
      zoom: "400",
      showTitle: "yes",
      exitFsMode: "UseOC",
      startPage: 1,
    });
    const doc = await reload(outcome);
    assertEqual(catalogValue(doc, "PageLayout"), null, "whitelist: layout ignored");
    assertEqual(catalogValue(doc, "PageMode"), null, "whitelist: pageMode ignored");
    assertEqual(catalogValue(doc, "OpenAction"), null, "whitelist: no OpenAction");
    assertEqual(catalogValue(doc, "ViewerPreferences"), null, "whitelist: prefs ignored");
  }

  /* 10. Garbage bytes → honest error, not a crash. */
  {
    const outcome = await runWorker(
      new FakeFile("bad.pdf", new TextEncoder().encode("this is not a pdf")),
      { zoom: "100" }
    );
    assert(outcome.result === null, "garbage: no result", outcome.result);
    assertEqual(outcome.error?.code, "tool.errorCorrupt", "garbage: error code");
  }

  /* 11. Pre-existing values are REPLACED (not duplicated). */
  {
    const preset = await PDFDocument.load(srcBytes);
    preset.catalog.set(PDFName.of("PageLayout"), PDFName.of("SinglePage"));
    const presetBytes = await preset.save();
    const outcome = await runWorker(new FakeFile("r.pdf", presetBytes), {
      layout: "OneColumn",
    });
    const doc = await reload(outcome);
    assertEqual(catalogValue(doc, "PageLayout"), "/OneColumn", "replace: old layout replaced");
  }

  /* 12. Cryptographically signed input → honest refusal (re-saving
   *     through pdf-lib would silently break the existing signature). */
  {
    const signed = await PDFDocument.create();
    signed.addPage([300, 200]);
    // A real-looking PPKLite signature dictionary. Saved WITHOUT object
    // streams — real signed PDFs always carry the sig dict as plain
    // bytes (the house digital-signature tool saves the same way), so
    // the latin1 scan in hasExistingSignature sees /SubFilter /adbe.pkcs7.
    signed.context.register(
      signed.context.obj({
        Type: "Sig",
        Filter: "Adobe.PPKLite",
        SubFilter: "adbe.pkcs7.detached",
        ByteRange: [0, 100, 200, 8],
        Contents: "00",
      })
    );
    const signedBytes = await signed.save({ useObjectStreams: false });
    assert(
      hasExistingSignature(signedBytes),
      "signed fixture: hasExistingSignature sees the sig dict"
    );
    const outcome = await runWorker(new FakeFile("sig.pdf", signedBytes), {
      zoom: "100",
    });
    assert(outcome.result === null, "signed: no result", outcome.result);
    assertEqual(
      outcome.error?.code,
      "tool.errorAlreadySigned",
      "signed: honest error code"
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
