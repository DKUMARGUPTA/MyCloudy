/**
 * PRE-BUILD smoke test for Annotate PDF (59th tool, PRD §8.2 "Highlight /
 * Underline / Strike" + "Sticky note / Comment" — editor core reuse).
 *
 * Part 1 (model, pure): display↔pdf transforms for all four /Rotate
 * values, the pdf.js text-piece harvest, the drag→quads word-snapping
 * machinery (vertical/horizontal intersection rules, per-line run
 * merging), the scanned-page fallback, factories, the wire-blob
 * sanitizer and the history semantics.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim. A source PDF is annotated with a highlight (2
 * quads), an underline, a strikeout, a fallback square and a Hindi
 * sticky note; the produced bytes are RELOADED with pdf-lib and the
 * annotation dictionaries are asserted at parse level: /Subtype values,
 * /QuadPoints geometry, /CA opacity, /BS zero border, /Contents decoded
 * from PDFHexString (Devanagari round trip) and the /Rect clamping —
 * plus the honest error codes for corrupt input.
 *
 * Run: bun scripts/smoke-annotate-pdf.ts
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { Annotation, MarkupAnno, Quad } from "../tools/annotate-pdf/model";

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

function near(a: number, b: number, eps = 0.15): boolean {
  return Math.abs(a - b) <= eps;
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
  options: Record<string, string | number | boolean>
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files: [file], options },
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

async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("Hello highlight world", { x: 72, y: 700, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  p0.drawText("Second line of text", { x: 72, y: 670, size: 12, font });
  doc.addPage([612, 792]);
  return doc.save();
}

/** A user-space quad from an axis-aligned box (Acrobat BL/BR/TR/TL). */
function quad(x0: number, y0: number, x1: number, y1: number): Quad {
  return { x1: x0, y1: y0, x2: x1, y2: y0, x3: x1, y3: y1, x4: x0, y4: y1 };
}

async function main(): Promise<void> {
  /* ---- Part 1: the pure model ---- */
  const model = await import("../tools/annotate-pdf/model");

  const views = [
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 0 },
    { x0: 20, y0: 10, x1: 632, y1: 802, rotate: 90 },
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 180 },
    { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 270 },
  ];

  // Display ↔ pdf roundtrips for all four rotations.
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

  // pdf.js item harvest: viewport transform for an unrotated page
  // (y flip: [1 0 0 -1 0 792]).
  const pieces = model.piecesFromItems(
    [1, 0, 0, -1, 0, 792],
    [
      { str: "Hello", transform: [12, 0, 0, 12, 72, 700], width: 30, height: 12 },
      { str: "   ", transform: [12, 0, 0, 12, 102, 700], width: 0, height: 12 },
      { str: "world", transform: [12, 0, 0, 12, 104, 700], width: 28, height: 12 },
      { str: "", transform: [12, 0, 0, 12, 140, 700], width: 10, height: 12 },
      { str: "junk", transform: "nope", width: 10, height: 12 },
      { str: "lower", transform: [12, 0, 0, 12, 72, 650], width: 26, height: 12 },
    ]
  );
  assertEqual(pieces.length, 3, "harvest keeps real runs only");
  assertEqual(pieces[0], { x: 72, xEnd: 102, baseline: 92, h: 12, str: "Hello" }, "first piece mapped");
  assertEqual(pieces[1], { x: 104, xEnd: 132, baseline: 92, h: 12, str: "world" }, "second piece mapped");
  assertEqual(pieces[2].baseline, 142, "second line baseline");

  // Drag intersection rules.
  const line1 = { x: 72, xEnd: 102, baseline: 92, h: 12, str: "Hello" };
  const line2 = { x: 104, xEnd: 132, baseline: 92, h: 12, str: "world" };
  const line3 = { x: 72, xEnd: 132, baseline: 142, h: 12, str: "lower" };
  const hit = model.piecesInDrag([line1, line2, line3], { x: 70, y: 84, w: 40, h: 8 });
  assertEqual(hit.map((p) => p.str), ["Hello", "world"], "drag picks the band's line");
  const miss = model.piecesInDrag([line1, line3], { x: 70, y: 130, w: 40, h: 8 });
  assertEqual(miss.length, 1, "drag skips the other line");
  const grazing = model.piecesInDrag(
    [{ x: 300, xEnd: 360, baseline: 92, h: 12, str: "far" }],
    { x: 70, y: 84, w: 40, h: 8 }
  );
  assertEqual(grazing.length, 0, "no horizontal overlap = no hit");
  const contained = model.piecesInDrag(
    [{ x: 80, xEnd: 90, baseline: 92, h: 12, str: "in" }],
    { x: 70, y: 84, w: 40, h: 8 }
  );
  assertEqual(contained.length, 1, "fully contained piece hits");

  // Drag → markup on rotate 0 (word snapping + merged run + excerpt).
  const mk0 = model.buildMarkupFromDrag(
    0,
    { x: 70, y: 83, w: 70, h: 10 },
    [line1, line2, line3],
    views[0],
    "highlight",
    "#fdd835",
    0.45,
    1234
  );
  assert(mk0 !== null, "markup built");
  if (mk0) {
    assertEqual(mk0.quads.length, 1, "adjacent pieces merge into one run");
    const q = mk0.quads[0];
    assert(
      near(q.x1, 72) && near(q.x2, 132) && near(q.x3, 132) && near(q.x4, 72),
      "run quad x span",
      q
    );
    // Display band: top = 92 - 0.8*12 = 82.4, bottom = 92 + 0.22*12 = 94.64
    // → user y: 792 - 94.64 = 697.36 .. 792 - 82.4 = 709.6
    assert(near(q.y1, 697.4) && near(q.y3, 709.6), "run quad y flip", q);
    assertEqual(mk0.text, "Hello world", "excerpt joins runs");
    assertEqual(mk0.fallback, false, "text markup is not a fallback");
    assert(
      near(mk0.rect.x, 72) && near(mk0.rect.y, 697.4) && near(mk0.rect.w, 60),
      "union rect from quads",
      mk0.rect
    );
  }

  // Drag → markup on rotate 90 (display x↔user y swap).
  const mk90 = model.buildMarkupFromDrag(
    0,
    { x: 70, y: 83, w: 70, h: 10 },
    [line1, line2],
    views[1],
    "underline",
    "#ef5350",
    0.45,
    1234
  );
  assert(mk90 !== null, "rot90 markup built");
  if (mk90) {
    const q = mk90.quads[0];
    // displayToPdfPoint(dx, dy) = (dy + x0, dx + y0) with x0=20, y0=10:
    // user x = display y (82.4..94.64) + 20, user y = display x (72..132) + 10
    assert(near(q.x1, 102.4) && near(q.x3, 114.6), "rot90 quad user x", q);
    assert(near(q.y1, 82) && near(q.y3, 142), "rot90 quad user y", q);
  }

  // Scanned page: no pieces → translucent-box fallback.
  const fb = model.buildMarkupFromDrag(
    1,
    { x: 100, y: 200, w: 220, h: 60 },
    [],
    views[0],
    "highlight",
    "#26a69a",
    0.5,
    1234
  );
  assert(fb !== null && fb.fallback === true, "scanned drag becomes fallback");
  if (fb) {
    assertEqual(fb.quads.length, 0, "fallback carries no quads");
    assert(
      near(fb.rect.x, 100) && near(fb.rect.y, 792 - 260) && near(fb.rect.w, 220),
      "fallback rect display→pdf",
      fb.rect
    );
  }

  // Stray tiny drags never survive.
  assert(
    model.buildMarkupFromDrag(0, { x: 10, y: 10, w: 1, h: 1 }, [line1], views[0], "strikeout", "#000000", 0.5, 1) ===
      null,
    "tiny drag dropped"
  );

  // Sticky note anchor.
  const note = model.makeNote(1, 100, 200, views[0], "#ec407a", 5678);
  assertEqual(note.x, 100, "note user x");
  assertEqual(note.y, 592, "note user y (flipped)");
  const back = model.noteDisplayPoint(note, views[0]);
  assert(near(back.x, 100) && near(back.y, 200), "note display roundtrip", back);

  // Sanitizer: clamps + drops.
  const goodQuad = quad(100, 600, 200, 620);
  const sanitized = model.sanitizeAnnotations(
    [
      {
        id: "h1",
        page: 0,
        kind: "highlight",
        color: "#fdd835",
        opacity: 0.45,
        quads: [goodQuad],
        rect: model.quadsToRect([goodQuad], views[0]),
        text: "kept excerpt",
        fallback: false,
        at: 1,
      },
      { id: "n1", page: 1, kind: "note", color: "#ec407a", x: 50, y: 60, text: "नमस्ते", at: 2 },
      { id: "n2", page: 1, kind: "note", color: "#ec407a", x: 50, y: 60, text: "   ", at: 3 },
      { id: "junk", kind: "nope", page: 0 },
      {
        id: "q0",
        page: 99,
        kind: "underline",
        color: "#ef5350",
        opacity: 0.45,
        quads: [],
        rect: { x: 1, y: 1, w: 10, h: 10 },
        text: "",
        fallback: false,
        at: 4,
      },
      {
        id: "f1",
        page: 99,
        kind: "highlight",
        color: "not-a-color",
        opacity: 9,
        quads: [],
        rect: { x: 1, y: 1, w: 10, h: 10 },
        text: "",
        fallback: true,
        at: 5,
      },
    ],
    2
  );
  assertEqual(sanitized.length, 3, "sanitize drops junk/empty/quadless");
  assertEqual(sanitized[1].text, "नमस्ते", "hindi note text kept");
  const clamped = sanitized[2];
  assert(clamped.page === 1, "page 99 clamped to last page", clamped);
  if (clamped.kind === "highlight") {
    assertEqual(clamped.color, model.DEFAULT_COLOR, "garbage color falls back");
    assert(clamped.opacity <= 0.8, "opacity clamped", clamped.opacity);
  }

  // History.
  const undone = model.undoStep(["a"], [], "current");
  assertEqual(undone.snapshot, "a", "undo pops");
  assertEqual(undone.future[0], "current", "undo future");
  const redone = model.redoStep(undone.past, undone.future, undone.snapshot ?? "");
  assertEqual(redone.snapshot, "current", "redo pops");
  assertEqual(redone.past[redone.past.length - 1], "a", "redo pushes current");

  // Colours.
  assertEqual(model.hexToRgb("#ff0000"), { r: 1, g: 0, b: 0 }, "hex red");
  assertEqual(model.hexToRgb("garbage"), { r: 1, g: 1, b: 1 }, "hex garbage → white");

  /* ---- Part 2: the worker (real module) ---- */
  await import("../tools/annotate-pdf/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const source = new FakeFile("letter.pdf", await makeSourcePdf());

  // A full battery: highlight (2 quads) + underline + strikeout +
  // fallback square on page 1, Hindi sticky note on page 2, and two
  // garbage annos that must be dropped.
  const hq1 = quad(72, 695, 140, 712);
  const hq2 = quad(72, 665, 110, 682);
  const uq = quad(72, 630, 150, 648);
  const sq = quad(72, 595, 150, 613);
  const annos: Annotation[] = [
    {
      id: "h1",
      page: 0,
      kind: "highlight",
      color: "#fdd835",
      opacity: 0.45,
      quads: [hq1, hq2],
      rect: model.quadsToRect([hq1, hq2], views[0]),
      text: "Highlight excerpt",
      fallback: false,
      at: 1700000000000,
    },
    {
      id: "u1",
      page: 0,
      kind: "underline",
      color: "#ef5350",
      opacity: 0.45,
      quads: [uq],
      rect: model.quadsToRect([uq], views[0]),
      text: "Underlined words",
      fallback: false,
      at: 1700000000001,
    },
    {
      id: "s1",
      page: 0,
      kind: "strikeout",
      color: "#66bb6a",
      opacity: 0.45,
      quads: [sq],
      rect: model.quadsToRect([sq], views[0]),
      text: "Struck words",
      fallback: false,
      at: 1700000000002,
    },
    {
      id: "f1",
      page: 0,
      kind: "highlight",
      color: "#26a69a",
      opacity: 0.5,
      quads: [],
      rect: { x: 300, y: 400, w: 150, h: 60 },
      text: "",
      fallback: true,
      at: 1700000000003,
    },
    {
      id: "n1",
      page: 1,
      kind: "note",
      color: "#ec407a",
      x: 200,
      y: 700,
      text: "नमस्ते — यह टिप्पणी है",
      at: 1700000000004,
    },
    { id: "junk", kind: "freetext", page: 0 } as unknown as Annotation,
    { id: "n2", page: 1, kind: "note", color: "#ec407a", x: 10, y: 10, text: "", at: 1 } as unknown as Annotation,
  ];

  const outcome = await runWorker(source, {
    akey: "smoke",
    "a:smoke": JSON.stringify({ annos }),
  });
  assert(outcome.error === null, "full battery: no error", outcome.error);
  assert(outcome.result !== null, "full battery: result posted");
  if (outcome.result) {
    assertEqual(outcome.result.detail?.annotations, 4, "markup count (garbage dropped)");
    assertEqual(outcome.result.detail?.notes, 1, "note count");
    assertEqual(outcome.result.detail?.pages, 2, "page count kept");
    assert(outcome.outputs[0].name === "letter-annotated.pdf", "output name");
  }

  // Reload the produced bytes and assert the annotation dictionaries.
  const outBytes = await outcomeBytes(outcome);
  const reloaded = await PDFDocument.load(outBytes, {
    throwOnInvalidObject: false,
  });
  assertEqual(reloaded.getPageCount(), 2, "output pages");

  const annoDictsOf = (pageIdx: number): PDFDict[] => {
    const page = reloaded.getPages()[pageIdx];
    const arr = page.node.Annots();
    if (!arr) return [];
    return arr.asArray().map(
      (r) => page.doc.context.lookup(r) as PDFDict
    );
  };

  const page0 = annoDictsOf(0);
  const page1 = annoDictsOf(1);
  assertEqual(page0.length, 4, "page 1 annotation count");
  assertEqual(page1.length, 1, "page 2 annotation count");

  const subtypes = page0.map(
    (d) => d.lookup(PDFName.of("Subtype"))?.toString() ?? ""
  );
  assertEqual(
    subtypes.filter((s) => s === "/Highlight").length,
    1,
    "one Highlight subtype (the fallback is a separate /Square)"
  );
  assert(subtypes.includes("/Underline"), "underline subtype present");
  assert(subtypes.includes("/StrikeOut"), "strikeout subtype present");
  assert(subtypes.includes("/Square"), "scanned fallback square present");

  const highlight = page0.find(
    (d) => d.lookup(PDFName.of("Subtype"))?.toString() === "/Highlight"
  );
  assert(highlight !== undefined, "highlight dict found");
  if (highlight) {
    const quads = highlight.lookup(PDFName.of("QuadPoints")) as PDFArray;
    assertEqual(quads.size(), 16, "two quads × 8 numbers");
    const first = (quads.lookup(0) as PDFNumber).asNumber();
    assert(near(first, 72), "quad x1 carried", first);
    const rect = highlight.lookup(PDFName.of("Rect")) as PDFArray;
    assertEqual(rect.size(), 4, "/Rect has 4 entries");
    const ca = highlight.lookup(PDFName.of("CA")) as PDFNumber;
    assert(near(ca.asNumber(), 0.45, 0.001), "highlight /CA opacity");
    const contents = highlight.lookup(PDFName.of("Contents")) as PDFHexString;
    assertEqual(contents.decodeText(), "Highlight excerpt", "highlight excerpt /Contents");
    const m = highlight.lookup(PDFName.of("M"))?.toString() ?? "";
    assert(m.includes("D:2023"), "pdf date written", m);
  }

  const square = page0.find(
    (d) => d.lookup(PDFName.of("Subtype"))?.toString() === "/Square"
  );
  assert(square !== undefined, "square dict found");
  if (square) {
    const bs = square.lookup(PDFName.of("BS")) as PDFDict;
    assertEqual(
      (bs.lookup(PDFName.of("W")) as PDFNumber).asNumber(),
      0,
      "square zero border width"
    );
    const ca = square.lookup(PDFName.of("CA")) as PDFNumber;
    assert(near(ca.asNumber(), 0.5, 0.001), "square /CA opacity");
    const ic = square.lookup(PDFName.of("IC")) as PDFArray;
    assertEqual(ic.size(), 3, "square /IC interior colour");
    assert(
      near((ic.lookup(0) as PDFNumber).asNumber(), 0x26 / 255, 0.001),
      "square /IC red channel from #26a69a"
    );
  }

  const underline = page0.find(
    (d) => d.lookup(PDFName.of("Subtype"))?.toString() === "/Underline"
  );
  assert(underline !== undefined, "underline dict found");
  if (underline) {
    const quads = underline.lookup(PDFName.of("QuadPoints")) as PDFArray;
    assertEqual(quads.size(), 8, "underline one quad");
    assert(underline.lookup(PDFName.of("CA")) === undefined, "underline is full strength");
    const c = underline.lookup(PDFName.of("C")) as PDFArray;
    assert(
      near((c.lookup(0) as PDFNumber).asNumber(), 0xef / 255, 0.001),
      "underline stroke colour"
    );
  }

  const noteDict = page1[0];
  assert(noteDict !== undefined, "note dict found");
  if (noteDict) {
    assertEqual(
      noteDict.lookup(PDFName.of("Subtype"))?.toString(),
      "/Text",
      "sticky note subtype"
    );
    const contents = noteDict.lookup(PDFName.of("Contents")) as PDFHexString;
    assertEqual(
      contents.decodeText(),
      "नमस्ते — यह टिप्पणी है",
      "devanagari note /Contents round trip"
    );
    const rect = noteDict.lookup(PDFName.of("Rect")) as PDFArray;
    const r0 = (rect.lookup(0) as PDFNumber).asNumber();
    const r2 = (rect.lookup(2) as PDFNumber).asNumber();
    assert(near(r0, 189) && near(r2, 211), "note icon rect centred on (200,700)", { r0, r2 });
    assertEqual(
      noteDict.lookup(PDFName.of("Name"))?.toString(),
      "/Comment",
      "note icon name"
    );
  }

  /* ---- passthrough: zero annotations ---- */
  const plain = await runWorker(source, {
    akey: "p1",
    "a:p1": JSON.stringify({ annos: [] }),
  });
  assert(plain.error === null, "passthrough: no error", plain.error);
  if (plain.result) {
    assertEqual(plain.result.detail?.annotations, 0, "passthrough annotation count");
    assertEqual(plain.result.detail?.pages, 2, "passthrough pages");
  }

  /* ---- out-of-range page clamps to the last page ---- */
  const farQuad = quad(50, 500, 120, 520);
  const clampedRun = await runWorker(source, {
    akey: "p2",
    "a:p2": JSON.stringify({
      annos: [
        {
          id: "h9",
          page: 99,
          kind: "strikeout",
          color: "#ef5350",
          opacity: 0.4,
          quads: [farQuad],
          rect: model.quadsToRect([farQuad], views[0]),
          text: "clamped",
          fallback: false,
          at: 1,
        } as MarkupAnno,
      ],
    }),
  });
  assert(clampedRun.error === null, "clamped run: no error", clampedRun.error);
  const clampedOut = await outcomeBytes(clampedRun);
  const reloaded2 = await PDFDocument.load(clampedOut, {
    throwOnInvalidObject: false,
  });
  const p0 = reloaded2.getPages()[0].node.Annots();
  const p1 = reloaded2.getPages()[1].node.Annots();
  assert(
    p0 === undefined || p0.size() === 0,
    "page 1 carries no annotations",
    p0?.size()
  );
  assert(p1 !== undefined && p1.size() === 1, "page 99 clamped onto the last page");

  /* ---- corrupt source → honest error ---- */
  const corrupt = new FakeFile(
    "bad.pdf",
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x99, 0x99, 0x99])
  );
  const bad = await runWorker(corrupt, {
    akey: "p3",
    "a:p3": JSON.stringify({ annos: [] }),
  });
  assert(bad.error !== null, "corrupt: error posted");
  assertEqual(bad.error?.code, "tool.errorCorrupt", "corrupt error code");

  /* ---- summary ---- */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
