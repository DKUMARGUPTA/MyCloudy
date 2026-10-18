/**
 * P8.4 smoke — form fields in the Edit PDF editor.
 *
 * Part 1 (model, pure): the FieldObj sanitizer (type fallbacks, checkbox
 * squaring, dropdown option cleaning + value gating, name fallback),
 * suggestFieldName/takenFieldNames, makeField factory and the
 * duplicateObject rename.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with the
 * self/postMessage + fetch shims (smoke-edit-pdf precedent). Cases:
 * the full field battery exported onto a 3-page source (text + multiline +
 * checkbox + dropdown + 2-radio group + a drawn text object + hidden
 * field), verified with pdf-lib's own form API — types, names, required
 * flags, default values, multiline flag, checkbox checked, dropdown
 * options/selection, radio group options and widget annotations on the
 * page. Plus: dedupe against an EXISTING field name in the source,
 * Devanagari default text honestly skipped, and a field-less passthrough
 * that must NOT grow an /AcroForm.
 *
 * Run: bun scripts/smoke-edit-pdf-forms.ts
 */
import { readFileSync } from "node:fs";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
} from "pdf-lib";
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

async function makeSourcePdf(withExisting = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Source form", { x: 48, y: 780, size: 14, font });
  if (withExisting) {
    const form = doc.getForm();
    const existing = form.createTextField("Email");
    existing.addToPage(page, { x: 200, y: 700, width: 200, height: 20 });
  }
  return doc.save();
}

async function main(): Promise<void> {
  /* ---- Part 1: the pure model ---- */
  const model = await import("../tools/edit-pdf/model");

  // sanitize: plain text field survives with every property intact.
  const sanitizedText = model.sanitizeObject(
    {
      ...model.makeField(0, { x: 10, y: 20, w: 180, h: 22 }, new Set()),
      name: "Full Name",
      value: "Ravi Kumar",
      required: true,
    },
    1,
    new Set()
  );
  assert(
    sanitizedText?.kind === "field" &&
      sanitizedText.fieldType === "text" &&
      sanitizedText.name === "Full Name" &&
      sanitizedText.value === "Ravi Kumar" &&
      sanitizedText.required === true,
    "sanitize: text field intact",
    sanitizedText
  );

  // sanitize: garbage fieldType falls back to "text".
  const badType = model.sanitizeObject(
    { ...model.makeField(0, { x: 1, y: 1, w: 10, h: 10 }, new Set()), fieldType: "spinner" },
    1,
    new Set()
  );
  assert(
    badType?.kind === "field" && badType.fieldType === "text",
    "sanitize: garbage fieldType → text",
    badType
  );

  // sanitize: empty name falls back to "Field".
  const noName = model.sanitizeObject(
    { ...model.makeField(0, { x: 1, y: 1, w: 10, h: 10 }, new Set()), name: "   " },
    1,
    new Set()
  );
  assert(noName?.kind === "field" && noName.name === "Field", "sanitize: empty name → Field", noName);

  // sanitize: checkbox squares the rect.
  const box = model.sanitizeObject(
    {
      ...model.makeField(
        0,
        { x: 5, y: 5, w: 80, h: 24 },
        new Set(),
        { fieldType: "checkbox", value: "on" }
      ),
    },
    1,
    new Set()
  );
  assert(
    box?.kind === "field" &&
      box.fieldType === "checkbox" &&
      box.w === box.h &&
      box.w === 24 &&
      box.value === "on",
    "sanitize: checkbox squared + checked value kept",
    box
  );

  // sanitize: dropdown options deduped/trimmed/capped, stray value cleared.
  const drop = model.sanitizeObject(
    {
      ...model.makeField(0, { x: 5, y: 5, w: 160, h: 20 }, new Set(), {
        fieldType: "dropdown",
      }),
      options: [" Yes ", "Yes", "", "No", "Maybe", "Maybe"],
      value: "Sometimes",
    },
    1,
    new Set()
  );
  assert(
    drop?.kind === "field" &&
      JSON.stringify(drop.options) === JSON.stringify(["Yes", "No", "Maybe"]) &&
      drop.value === "",
    "sanitize: dropdown options cleaned + unknown default cleared",
    drop
  );

  // sanitize: dropdown value kept when it matches an option.
  const drop2 = model.sanitizeObject(
    {
      ...model.makeField(0, { x: 5, y: 5, w: 160, h: 20 }, new Set(), {
        fieldType: "dropdown",
      }),
      options: ["Yes", "No"],
      value: "No",
    },
    1,
    new Set()
  );
  assert(
    drop2?.kind === "field" && drop2.value === "No",
    "sanitize: dropdown matching default kept"
  );

  // name suggestion + taken set.
  const taken = new Set<string>();
  assertEqual(model.suggestFieldName(taken), "Field", "suggest: first name");
  taken.add("Field");
  assertEqual(model.suggestFieldName(taken), "Field 2", "suggest: second name");
  taken.add("Field 2");
  assertEqual(model.suggestFieldName(taken), "Field 3", "suggest: third name");

  // takenFieldNames collects only field names.
  const objects: EditorObject[] = [
    model.makeText(0, { x: 1, y: 1, w: 50, h: 20 }),
    { ...model.makeField(0, { x: 1, y: 60, w: 100, h: 20 }, new Set()), name: "A" },
    { ...model.makeField(0, { x: 1, y: 90, w: 100, h: 20 }, new Set()), name: "B" },
    { ...model.makeField(0, { x: 1, y: 120, w: 100, h: 20 }, new Set()), name: "  " },
  ];
  const names = model.takenFieldNames(objects);
  assert(
    names.size === 2 && names.has("A") && names.has("B"),
    "takenFieldNames: field names only, blanks skipped",
    [...names]
  );

  // makeField: default type + unique naming via taken.
  const f1 = model.makeField(0, { x: 1, y: 1, w: 160, h: 20 }, taken);
  assert(
    f1.kind === "field" && f1.fieldType === "text" && f1.name === "Field 3",
    "makeField: defaults to text + next suggested name",
    f1
  );

  // makeField: radio square.
  const radio = model.makeField(
    0,
    { x: 1, y: 1, w: 40, h: 18 },
    new Set(),
    { fieldType: "radio" }
  );
  assert(
    radio.kind === "field" && radio.w === radio.h && radio.w === 18,
    "makeField: radio squared",
    radio
  );

  // duplicateObject renames the copy (non-radio).
  const dupSource = objects[1];
  const dupSourceName = dupSource.kind === "field" ? dupSource.name : "";
  assert(
    dupSourceName === "A",
    "dup fixture is the field named A"
  );
  const dup = model.duplicateObject(objects, objects[1].id);
  assert(
    dup.copy?.kind === "field" &&
      dup.copy.name !== dupSourceName &&
      dup.copy.name.length > 0,
    "duplicateObject: field copy gets a fresh name",
    dup.copy
  );

  // sanitizeObjects drops hidden fields.
  const hiddenDrop = model.sanitizeObjects(
    [
      { ...model.makeField(0, { x: 1, y: 1, w: 60, h: 20 }, new Set()), hidden: true },
      model.makeText(0, { x: 1, y: 60, w: 60, h: 20 }),
    ],
    1,
    new Set()
  );
  assertEqual(
    hiddenDrop.filter((o) => o.kind === "field").length,
    0,
    "sanitizeObjects: hidden fields dropped"
  );

  /* ---- Part 2: the worker (real module) ---- */
  await import("../tools/edit-pdf/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const source = new FakeFile("form-base.pdf", await makeSourcePdf());

  // Full battery: every field flavour + a drawn text object.
  const fieldObjs: EditorObject[] = [
    {
      ...model.makeField(0, { x: 48, y: 720, w: 240, h: 22 }, new Set()),
      name: "Full Name",
      value: "Ravi Kumar",
      required: true,
    },
    {
      ...model.makeField(0, { x: 48, y: 640, w: 300, h: 70 }, new Set(), {
        fieldType: "multiline",
      }),
      name: "Address",
      value: "12 MG Road",
    },
    {
      ...model.makeField(
        0,
        { x: 48, y: 600, w: 30, h: 30 },
        new Set(),
        { fieldType: "checkbox" }
      ),
      name: "Subscribe",
      value: "on",
      required: true,
    },
    {
      ...model.makeField(0, { x: 48, y: 550, w: 160, h: 22 }, new Set(), {
        fieldType: "dropdown",
      }),
      name: "City",
      options: ["Delhi", "Mumbai", "Jaipur"],
      value: "Jaipur",
    },
    {
      ...model.makeField(0, { x: 300, y: 540, w: 16, h: 16 }, new Set(), {
        fieldType: "radio",
      }),
      name: "Plan",
      value: "Basic",
    },
    {
      ...model.makeField(0, { x: 300, y: 500, w: 16, h: 16 }, new Set(), {
        fieldType: "radio",
      }),
      name: "Plan",
      value: "Pro",
    },
    model.makeText(0, { x: 48, y: 780, w: 300, h: 30 }),
    // dropped: hidden
    {
      ...model.makeField(0, { x: 1, y: 1, w: 60, h: 20 }, new Set()),
      hidden: true,
    },
  ];
  const blob = {
    objects: fieldObjs,
    pageViews: VIEWS.map((v) => ({ ...v })),
    assetOrder: [],
  };
  const outcome = await runWorker(source, {
    ekey: "f1",
    "e:f1": JSON.stringify(blob),
  });
  assert(outcome.error === null, "battery: no error", outcome.error);
  assert(outcome.result !== null, "battery: result posted");
  if (outcome.result) {
    assertEqual(outcome.result.detail?.fields, 6, "battery: fields added (hidden dropped)");
    assertEqual(outcome.result.detail?.objects, 7, "battery: object count incl. fields");
  }

  const outBytes = await outcomeBytes(outcome);
  const reloaded = await PDFDocument.load(outBytes, {
    throwOnInvalidObject: false,
  });
  const form = reloaded.getForm();
  const fields = form.getFields();
  // 5 AcroForm FIELDS: 2 radio objects collapse into ONE group field.
  assertEqual(fields.length, 5, "battery: 5 AcroForm fields (radio pair = 1 group)");

  const byName = new Map(fields.map((f) => [f.getName(), f]));

  const nameField = form.getTextField("Full Name");
  assert(nameField !== undefined, "text field exists");
  if (nameField) {
    assertEqual(nameField.getText(), "Ravi Kumar", "text field default value");
    assert(nameField.isRequired(), "text field required flag");
    assert(nameField.isMultiline() === false, "text field single-line");
  }

  const addrField = form.getTextField("Address");
  assert(addrField !== undefined, "multiline field exists");
  if (addrField) {
    assert(addrField.isMultiline(), "multiline flag set");
    assertEqual(addrField.getText(), "12 MG Road", "multiline default value");
  }

  const check = form.getCheckBox("Subscribe");
  assert(check !== undefined, "checkbox exists");
  if (check) {
    assert(check.isChecked(), "checkbox checked by default");
    assert(check.isRequired(), "checkbox required flag");
  }

  const city = form.getDropdown("City");
  assert(city !== undefined, "dropdown exists");
  if (city) {
    assertEqual(
      city.getOptions().join("|"),
      "Delhi|Mumbai|Jaipur",
      "dropdown options"
    );
    assertEqual(city.getSelected()[0], "Jaipur", "dropdown default selection");
  }

  const plan = form.getRadioGroup("Plan");
  assert(plan !== undefined, "radio group exists (2 objects → 1 group)");
  if (plan) {
    assertEqual(
      plan.getOptions().join("|"),
      "Basic|Pro",
      "radio group export values"
    );
  }

  // Widget annotations actually ride the page (7 objects → 6 widgets).
  const page0 = reloaded.getPages()[0];
  const annots = page0.node.Annots();
  const widgetCount = annots instanceof PDFArray ? annots.size() : 0;
  assertEqual(widgetCount, 6, "6 widget annotations on the page");

  // The drawn text object is still there (page content grows).
  assert(
    byName.size === 5,
    "no stray fields",
    [...byName.keys()]
  );

  /* ---- dedupe against an EXISTING source field ---- */
  const withExisting = new FakeFile(
    "has-email.pdf",
    await makeSourcePdf(true)
  );
  const clash = await runWorker(withExisting, {
    ekey: "f2",
    "e:f2": JSON.stringify({
      objects: [
        {
          ...model.makeField(0, { x: 48, y: 720, w: 200, h: 20 }, new Set()),
          name: "Email",
        },
      ],
      pageViews: VIEWS.map((v) => ({ ...v })),
      assetOrder: [],
    }),
  });
  assert(clash.error === null, "dedupe: no error", clash.error);
  const clashBytes = await outcomeBytes(clash);
  const clashDoc = await PDFDocument.load(clashBytes);
  const clashNames = clashDoc
    .getForm()
    .getFields()
    .map((f) => f.getName())
    .sort();
  assertEqual(clashNames, ["Email", "Email 2"], "existing name → Email 2");

  /* ---- Devanagari default value honestly skipped ---- */
  const deva = await runWorker(source, {
    ekey: "f3",
    "e:f3": JSON.stringify({
      objects: [
        {
          ...model.makeField(0, { x: 48, y: 700, w: 200, h: 20 }, new Set()),
          name: "नाम",
          value: "रवि",
        },
      ],
      pageViews: VIEWS.map((v) => ({ ...v })),
      assetOrder: [],
    }),
  });
  assert(deva.error === null, "deva value: no error (field survives)", deva.error);
  const devaBytes = await outcomeBytes(deva);
  const devaDoc = await PDFDocument.load(devaBytes);
  const devaFields = devaDoc.getForm().getFields();
  assertEqual(devaFields.length, 1, "deva value: field created");
  if (devaFields.length === 1) {
    assert(
      (devaDoc.getForm().getTextField(devaFields[0].getName()).getText() ?? "") ===
        "",
      "deva value: unencodable default skipped honestly"
    );
  }

  /* ---- field-less passthrough must NOT grow an /AcroForm ---- */
  const plain = await runWorker(source, {
    ekey: "f4",
    "e:f4": JSON.stringify({
      objects: [
        model.makeText(0, { x: 48, y: 400, w: 200, h: 24 }),
      ],
      pageViews: VIEWS.map((v) => ({ ...v })),
      assetOrder: [],
    }),
  });
  assert(plain.error === null, "passthrough: no error", plain.error);
  const plainBytes = await outcomeBytes(plain);
  const plainDoc = await PDFDocument.load(plainBytes);
  assert(
    plainDoc.catalog.lookup(PDFName.of("AcroForm")) === undefined,
    "passthrough: no /AcroForm created"
  );

  /* ---- report ---- */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
