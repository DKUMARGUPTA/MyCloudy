/**
 * PRE-BUILD smoke test for Make PDF fillable (PRD §8.2 "Make fillable").
 *
 * bun cannot run pdf.js, so this locks the PURE halves exactly like the
 * worker uses them:
 *
 *  1. Geometry: mergeLineSegments (dashed-underline merging + min-length
 *     filter), classifyRect (checkbox square / textbox / decoration),
 *     lineToSpecRect (lift math), labelForRect (left labels + checkbox
 *     above-labels + colon cleaning), uniqueName (dedup chain).
 *  2. Coordinate transforms: pdf↔display roundtrips for all four /Rotate
 *     values, plus the known pdf.js PageViewport table pins.
 *  3. buildFieldPdf end-to-end with pdf-lib: build a fixture form PDF
 *     (label text + underline), add fields, re-parse the output and
 *     verify the AcroForm — field count, types (text/multiline/checkbox),
 *     unique names, widget /Rect placement on the right page, and the
 *     existing-fields dedupe path.
 *
 * Run: bun scripts/smoke-make-fillable.ts
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, rgb } from "pdf-lib";

import {
  type FieldSpec,
  type LineSeg,
  type TextItemBox,
  buildFieldPdf,
  classifyRect,
  countExistingFields,
  displayRectToPdf,
  displaySize,
  labelForRect,
  lineToSpecRect,
  mergeLineSegments,
  pdfRectToDisplay,
  sanitizeSpecs,
  uniqueName,
} from "../tools/make-pdf-fillable/engine";

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

function near(a: number, b: number, message: string, tol = 1e-6): void {
  assert(Math.abs(a - b) < tol, `${message} (expected ${b}, got ${a})`);
}

// ---------------------------------------------------------------------------
// 1. mergeLineSegments
// ---------------------------------------------------------------------------
{
  const merged = mergeLineSegments([
    { x1: 100, x2: 140, y: 200 }, // dash 1
    { x1: 150, x2: 190, y: 200 }, // gap 10 < MERGE_GAP 14 → same field
    { x1: 250, x2: 290, y: 200 }, // gap 60 → separate (but <30? 40pt ok)
    { x1: 300, x2: 310, y: 200 }, // 10pt piece — merged into #3 → 80 total
    { x1: 10, x2: 25, y: 700 },   // 15pt < MIN 30 → dropped
  ] satisfies LineSeg[]);
  const y200 = merged.filter((s) => s.y === 200);
  eq(y200.length, 2, "merge: dashed underline merges into 2 fields");
  eq(
    y200.map((s) => [s.x1, s.x2]),
    [
      [100, 190],
      [250, 310],
    ],
    "merge: merged spans exact"
  );
  eq(
    merged.filter((s) => s.y === 700).length,
    0,
    "merge: sub-minimum decoration dropped"
  );
  // Baseline snapping: 1pt jitter rounds to the same 0.5 row.
  const jitter = mergeLineSegments([
    { x1: 0, x2: 100, y: 300 },
    { x1: 20, x2: 80, y: 300.4 },
  ]);
  eq(jitter.length, 1, "merge: 0.4pt baseline jitter snaps together");
}

// ---------------------------------------------------------------------------
// 2. classifyRect
// ---------------------------------------------------------------------------
assert(classifyRect(12, 12) === "checkbox", "classify: 12×12 square → checkbox");
assert(classifyRect(10, 14) === "checkbox", "classify: 10×14 → checkbox (squareish)");
assert(classifyRect(150, 20) === "textbox", "classify: 150×20 → textbox");
assert(classifyRect(595, 842) === null, "classify: full page → decoration");
assert(classifyRect(6, 6) === null, "classify: tiny mark → decoration");
assert(classifyRect(400, 300) === null, "classify: photo frame → decoration");
assert(classifyRect(30, 60) === null, "classify: tall narrow → decoration");

// ---------------------------------------------------------------------------
// 3. lineToSpecRect
// ---------------------------------------------------------------------------
{
  const r = lineToSpecRect({ x1: 50, x2: 250, y: 100 });
  near(r.x, 50, "lineRect: x at line start");
  near(r.w, 200, "lineRect: width = span");
  near(r.y, 102, "lineRect: y = line + 2pt lift");
  near(r.h, 16, "lineRect: height 16pt");
}

// ---------------------------------------------------------------------------
// 4. labelForRect
// ---------------------------------------------------------------------------
{
  const items: TextItemBox[] = [
    { str: "Full Name:", x1: 20, y1: 100, x2: 90, y2: 114 },
    { str: "far away", x1: 20, y1: 400, x2: 90, y2: 414 },
    { str: "• Email", x1: 20, y1: 150, x2: 80, y2: 164 },
  ];
  const nameR = labelForRect(
    { x: 100, y: 102, w: 200, h: 16 },
    items,
    "text"
  );
  eq(nameR, "Full Name", "label: left text wins, colon stripped");
  const emailR = labelForRect(
    { x: 100, y: 152, w: 200, h: 16 },
    items,
    "text"
  );
  eq(emailR, "Email", "label: leading bullet stripped");
  const none = labelForRect({ x: 100, y: 500, w: 200, h: 16 }, items, "text");
  eq(none, null, "label: no candidate → null");
  // Checkbox: label ABOVE the box.
  const cbItems: TextItemBox[] = [
    { str: "I agree", x1: 100, y1: 140, x2: 150, y2: 152 },
  ];
  const cb = labelForRect({ x: 105, y: 100, w: 14, h: 14 }, cbItems, "checkbox");
  eq(cb, "I agree", "label: checkbox reads the label above");
}

// ---------------------------------------------------------------------------
// 5. uniqueName
// ---------------------------------------------------------------------------
{
  const taken = new Set<string>(["Name"]);
  eq(uniqueName("Name", taken), "Name 2", "unique: first dup gets 2");
  eq(uniqueName("Name", taken), "Name 3", "unique: chain continues");
  eq(uniqueName("Address", taken), "Address", "unique: fresh name kept");
  eq(uniqueName("   ", taken).slice(0, 5), "Field", "unique: blank → Field");
}

// ---------------------------------------------------------------------------
// 6. Coordinate transforms (all 4 rotations + crop offset)
// ---------------------------------------------------------------------------
{
  const view = { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 0 };
  const disp = pdfRectToDisplay({ x: 100, y: 200, w: 150, h: 20 }, view);
  near(disp.x, 100, "rotate0: disp x = pdf x");
  near(disp.y, 792 - 200 - 20, "rotate0: disp y = pageH - pdfY - h");
  const back = displayRectToPdf(disp, view);
  near(back.x, 100, "rotate0: roundtrip x");
  near(back.y, 200, "rotate0: roundtrip y");
  near(back.w, 150, "rotate0: roundtrip w");
  near(back.h, 20, "rotate0: roundtrip h");

  const view90 = { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 90 };
  const size90 = displaySize(view90);
  eq(size90, { w: 792, h: 612 }, "rotate90: display size swapped");
  const d90 = pdfRectToDisplay({ x: 100, y: 200, w: 150, h: 20 }, view90);
  near(d90.x, 200, "rotate90: disp x = pdf y");
  near(d90.y, 100, "rotate90: disp y = pdf x");
  const b90 = displayRectToPdf(d90, view90);
  near(b90.x, 100, "rotate90: roundtrip x");
  near(b90.y, 200, "rotate90: roundtrip y");
  near(b90.w, 150, "rotate90: roundtrip w");
  near(b90.h, 20, "rotate90: roundtrip h");

  const view180 = { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 180 };
  const b180 = displayRectToPdf(
    pdfRectToDisplay({ x: 100, y: 200, w: 150, h: 20 }, view180),
    view180
  );
  near(b180.x, 100, "rotate180: roundtrip x");
  near(b180.y, 200, "rotate180: roundtrip y");
  near(b180.w, 150, "rotate180: roundtrip w");
  near(b180.h, 20, "rotate180: roundtrip h");

  const view270 = { x0: 0, y0: 0, x1: 612, y1: 792, rotate: 270 };
  const b270 = displayRectToPdf(
    pdfRectToDisplay({ x: 100, y: 200, w: 150, h: 20 }, view270),
    view270
  );
  near(b270.x, 100, "rotate270: roundtrip x");
  near(b270.y, 200, "rotate270: roundtrip y");
  near(b270.w, 150, "rotate270: roundtrip w");
  near(b270.h, 20, "rotate270: roundtrip h");

  // Crop offset: user-space origin shifted by the crop box.
  const cropped = { x0: 12, y0: 20, x1: 500, y1: 740, rotate: 0 };
  const dc = pdfRectToDisplay({ x: 100, y: 200, w: 150, h: 20 }, cropped);
  near(dc.x, 100 - 12, "crop: display x accounts for crop x0");
  near(dc.y, 740 - 200 - 20, "crop: display y accounts for crop y1");
}

// ---------------------------------------------------------------------------
// 7. buildFieldPdf end-to-end (pdf-lib)
// ---------------------------------------------------------------------------
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([612, 792]);
  page.drawText("Full Name:", { x: 40, y: 700, size: 12, font });
  page.drawLine({
    start: { x: 140, y: 697 },
    end: { x: 400, y: 697 },
    thickness: 1,
  });
  page.drawText("Email:", { x: 40, y: 650, size: 12, font });
  page.drawLine({
    start: { x: 140, y: 647 },
    end: { x: 400, y: 647 },
    thickness: 1,
  });
  // A checkbox-style square (outline).
  page.drawRectangle({
    x: 40,
    y: 600,
    width: 12,
    height: 12,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawText("I agree to the terms", { x: 60, y: 602, size: 10, font });
  return doc.save();
}

async function main(): Promise<void> {
  const fixture = await buildFixture();

  // Existing count on a fresh doc: 0.
  eq(await countExistingFields(fixture), 0, "build: fixture has no fields");

  const specs: FieldSpec[] = [
    { id: "a", page: 0, x: 140, y: 699, w: 260, h: 16, kind: "text", name: "Full Name", enabled: true },
    { id: "b", page: 0, x: 140, y: 649, w: 260, h: 16, kind: "text", name: "Email", enabled: true },
    { id: "c", page: 0, x: 40, y: 600, w: 12, h: 12, kind: "checkbox", name: "I agree to the terms", enabled: true },
    { id: "d", page: 0, x: 40, y: 500, w: 260, h: 80, kind: "multiline", name: "Notes", enabled: true },
    { id: "e", page: 0, x: 40, y: 450, w: 260, h: 16, kind: "text", name: "Full Name", enabled: true }, // dup name!
    { id: "f", page: 0, x: 40, y: 400, w: 260, h: 16, kind: "text", name: "disabled", enabled: false }, // skipped
    { id: "g", page: 5, x: 40, y: 400, w: 260, h: 16, kind: "text", name: "ghost", enabled: true }, // bad page
  ];

  const { bytes, report } = await buildFieldPdf(fixture, specs, {
    outlinedTextFields: false,
  });
  eq(report.fieldsAdded, 5, "build: 5 fields (disabled + bad-page dropped)");
  eq(report.textFields, 4, "build: 4 text fields (2 text + 1 multiline + dup)");
  eq(report.checkboxes, 1, "build: 1 checkbox");
  eq(report.pages, 1, "build: 1 page in report");

  // Verify the AcroForm on a fresh parse.
  const out = await PDFDocument.load(bytes);
  const form = out.getForm();
  const fields = form.getFields();
  eq(fields.length, 5, "parse: 5 fields in AcroForm");
  const names = fields.map((f) => f.getName()).sort();
  eq(
    names,
    ["Email", "Full Name", "Full Name 2", "I agree to the terms", "Notes"].sort(),
    "parse: unique names (dup became 'Full Name 2')"
  );
  const nameField = form.getTextField("Full Name");
  assert(nameField !== undefined, "parse: 'Full Name' is a text field");
  const notes = form.getTextField("Notes");
  assert(notes !== undefined, "parse: 'Notes' is a text field");
  assert(notes.isMultiline(), "parse: multiline flag set on Notes");
  assert(!nameField.isMultiline(), "parse: single-line flag on Full Name");
  assert(form.getCheckBox("I agree to the terms") !== undefined, "parse: checkbox exists");

  // Widget /Rect on the page for Full Name: x=140, y=699, w=260, h=16.
  const page = out.getPage(0);
  const annots = page.node.Annots();
  assert(annots !== undefined, "parse: page has widget annotations");
  const count = annots?.size() ?? 0;
  eq(count, 5, "parse: 5 widgets on page 0");
  let nameRect: number[] | null = null;
  for (let i = 0; i < count; i += 1) {
    const dict = annots?.lookup(i, PDFDict);
    // pdf-lib splits field (/T on the parent) from the page widget —
    // follow /Parent when the widget itself carries no name.
    const targets = [dict, dict?.lookup(PDFName.of("Parent"), PDFDict)];
    const rect = dict?.lookup(PDFName.of("Rect"), PDFArray);
    for (const owner of targets) {
      if (!owner) continue;
      const t = owner.lookup(PDFName.of("T"));
      if (!t) continue;
      // /T can be PDFString (asString) or PDFHexString (decodeText).
      const raw =
        typeof (t as unknown as { decodeText?: () => string }).decodeText ===
        "function"
          ? (t as unknown as { decodeText: () => string }).decodeText()
          : t.toString();
      if (raw.includes("Full Name") && !raw.includes("2") && rect) {
        nameRect = (rect.asArray() ?? []).map(
          (n) => (n as PDFNumber).asNumber()
        ) as number[];
      }
    }
  }
  assert(nameRect !== null, "parse: Full Name widget found");
  if (nameRect) {
    near(nameRect[0], 140, "parse: widget Rect.x = spec x");
    near(nameRect[1], 699, "parse: widget Rect.y = spec y");
    near(nameRect[2] - nameRect[0], 260, "parse: widget width = spec w");
    near(nameRect[3] - nameRect[1], 16, "parse: widget height = spec h");
  }

  // Existing-fields dedupe path: build AGAIN on the output.
  const again = await buildFieldPdf(
    bytes,
    [{ id: "z", page: 0, x: 50, y: 100, w: 200, h: 16, kind: "text", name: "Notes", enabled: true }],
    { outlinedTextFields: true }
  );
  const out2 = await PDFDocument.load(again.bytes);
  eq(out2.getForm().getFields().length, 6, "dedupe: 6 fields, no name clash");

  // sanitizeSpecs clamping: spec outside the page bounds.
  const clamped = sanitizeSpecs(
    [
      { id: "k", page: 0, x: 600, y: 780, w: 300, h: 40, kind: "text", name: "X", enabled: true },
      { id: "l", page: 0, x: 10, y: 10, w: 2, h: 2, kind: "text", name: "T", enabled: true },
    ],
    [{ x0: 0, y0: 0, x1: 612, y1: 792, rotate: 0 }]
  );
  eq(clamped.length, 1, "sanitize: tiny spec dropped");
  const k = clamped[0];
  eq(
    [Math.round(k.x), Math.round(k.y), Math.round(k.w), Math.round(k.h)],
    [600, 780, 12, 12],
    "sanitize: clamped into page bounds"
  );

  const total = passed + failed;
  console.log(`\nsmoke-make-fillable: ${passed}/${total} ${failed === 0 ? "GREEN" : "RED"}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
