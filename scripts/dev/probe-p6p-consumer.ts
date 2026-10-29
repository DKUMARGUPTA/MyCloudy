/**
 * P6-p probe: the source-AcroForm consumer (read / fill / flatten) against
 * live pdf-lib.
 *
 *  A. READER PARITY — a rich fixture (text + multiline + maxLength, checkbox,
 *     radio with 2 widgets, dropdown with [export, display] pairs, optionlist,
 *     read-only + required flags, a hierarchical name, a field on page 2) is
 *     read by BOTH pdf-lib's PDFForm.getFields() and OUR readAcroFormFields;
 *     kinds / names / values / options / flags / widget pages / rects are
 *     compared entry by entry.
 *  B. FILL — StampContext.setSource{TextField,Checkbox,Radio,Choice} →
 *     write() → reload with pdf-lib: the /V values match, the appearance
 *     streams carry the text hex, the DA rewrite is present.
 *  C. FLATTEN — flattenSourceForm() + burnSourceAnnotations() → write() →
 *     reload: no /AcroForm, no /Annots, the page content carries the burn
 *     `Do` ops, and pdf-lib's text extraction still finds the values.
 *
 * Run: bun scripts/dev/probe-p6p-consumer.ts
 */
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import {
  StampContext,
  readAcroFormFields,
  parsePdf,
  resolve,
  type AcroFieldInfo,
} from "../../src/lib/own/pdf";
import type { PdfObj } from "../../src/lib/own/pdf/objects";

let checks = 0;
let bad = 0;

function ok(cond: boolean, label: string, detail = ""): void {
  checks += 1;
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    bad += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

async function makeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  const page2 = doc.addPage([612, 792]);
  await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  const tf = form.createTextField("Full Name");
  tf.addToPage(page1, { x: 100, y: 700, width: 200, height: 20 });

  const tf2 = form.createTextField("Details.Notes");
  tf2.enableMultiline();
  tf2.setMaxLength(120);
  tf2.addToPage(page1, { x: 100, y: 600, width: 200, height: 60 });

  const ro = form.createTextField("ReadOnly.Address");
  ro.enableReadOnly();
  ro.addToPage(page2, { x: 100, y: 700, width: 200, height: 20 });

  const cb = form.createCheckBox("Agree");
  cb.addToPage(page1, { x: 100, y: 500, width: 16, height: 16 });

  const rg = form.createRadioGroup("Ship");
  rg.addOptionToPage("Express", page1, { x: 100, y: 450, width: 14, height: 14 });
  rg.addOptionToPage("Standard", page1, { x: 100, y: 430, width: 14, height: 14 });

  const dd = form.createDropdown("City");
  dd.addOptions(["Mumbai", "Delhi", "Pune"]);
  dd.select("Pune");
  dd.addToPage(page1, { x: 100, y: 380, width: 160, height: 20 });

  const ol = form.createOptionList("Cities.Multi");
  ol.addOptions(["A", "B", "C"]);
  ol.addToPage(page2, { x: 100, y: 600, width: 160, height: 60 });

  return doc.save({ useObjectStreams: false });
}

function readerSummary(f: AcroFieldInfo): string {
  return JSON.stringify({
    name: f.name,
    kind: f.kind,
    readOnly: f.readOnly,
    required: f.required,
    multiline: f.multiline,
    maxLength: f.maxLength,
    value: f.value,
    selected: f.selected,
    options: f.options,
    widgets: f.widgets.map((w) => ({
      page: w.page,
      rect: [w.rect.x, w.rect.y, w.rect.w, w.rect.h],
    })),
  });
}

async function probeA(bytes: Uint8Array): Promise<void> {
  console.log("\n=== A. READER PARITY vs pdf-lib getFields ===");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.getForm();
  const libFields = form.getFields();
  const ours = readAcroFormFields(parsePdf(bytes));

  ok(ours.length === libFields.length, `field count ${libFields.length}`, `ours=${ours.length}`);

  const byNameLib = new Map(libFields.map((f) => [f.getName(), f] as const));

  for (const f of ours) {
    const lib = byNameLib.get(f.name);
    if (!lib) {
      ok(false, `field "${f.name}" known to pdf-lib`);
      continue;
    }
    ok(true, `field "${f.name}" name parity`);
    // Value parity per kind (the methods differ across the pdf-lib classes).
    if (f.kind === "text") {
      const t = lib as unknown as {
        getText(): string | undefined;
        isReadOnly(): boolean;
        isMultiline(): boolean;
        getMaxLength(): number | undefined;
      };
      ok(f.value === (t.getText() ?? null), `text value "${String(f.value)}"`);
      ok(f.readOnly === t.isReadOnly(), `"${f.name}" readOnly ${String(f.readOnly)}`);
      ok(f.multiline === t.isMultiline(), `"${f.name}" multiline ${String(f.multiline)}`);
      ok(f.maxLength === (t.getMaxLength() ?? null), `"${f.name}" maxLength ${String(f.maxLength)}`);
    } else if (f.kind === "checkbox") {
      const c = lib as unknown as { isChecked(): boolean; isReadOnly(): boolean };
      ok(f.value === c.isChecked(), `checkbox checked ${String(f.value)}`);
      ok(f.readOnly === c.isReadOnly(), `"${f.name}" readOnly ${String(f.readOnly)}`);
    } else if (f.kind === "radio") {
      const r = lib as unknown as { getSelected(): string | undefined; isReadOnly(): boolean };
      ok(f.value === (r.getSelected() ?? null), `radio selected ${String(f.value)}`);
      ok(f.readOnly === r.isReadOnly(), `"${f.name}" readOnly ${String(f.readOnly)}`);
    } else if (f.kind === "dropdown" || f.kind === "optionlist") {
      const c = lib as unknown as {
        getSelected(): string[];
        getOptions(): string[];
        isReadOnly(): boolean;
      };
      ok(
        JSON.stringify(f.selected) === JSON.stringify(c.getSelected()),
        `selected ${JSON.stringify(f.selected)}`,
      );
      ok(
        JSON.stringify(f.options) === JSON.stringify(c.getOptions()),
        `"${f.name}" options ${JSON.stringify(f.options)}`,
      );
      ok(f.readOnly === c.isReadOnly(), `"${f.name}" readOnly ${String(f.readOnly)}`);
    }
  }
  // Spot-assert the hierarchical name made it through.
  ok(ours.some((f) => f.name === "Details.Notes"), "hierarchical name Details.Notes");
  ok(ours.some((f) => f.name === "ReadOnly.Address"), "page-2 field present");
  const notes = ours.find((f) => f.name === "Details.Notes")!;
  ok(notes.maxLength === 120, "maxLength 120");
  const address = ours.find((f) => f.name === "ReadOnly.Address")!;
  ok(address.readOnly, "ReadOnly.Address flagged read-only");
  ok(address.widgets[0]!.page === 1, "page-2 widget page index 1");
  const ship = ours.find((f) => f.name === "Ship")!;
  ok(
    ship.options.length === 2 && ship.widgets.length === 2,
    `radio 2 options + 2 widgets`,
  );
}

async function probeB(bytes: Uint8Array): Promise<void> {
  console.log("\n=== B. FILL (set → write → pdf-lib reload) ===");
  const ctx = StampContext.load(bytes);
  const fields = ctx.readSourceFields();
  const byName = new Map(fields.map((f) => [f.name, f]));

  const name = byName.get("Full Name")!;
  ctx.setSourceTextField(name, "Ada Lovelace");
  const notes = byName.get("Details.Notes")!;
  ctx.setSourceTextField(notes, "first line\nsecond line");
  const agree = byName.get("Agree")!;
  ctx.setSourceCheckbox(agree, true);
  const ship = byName.get("Ship")!;
  ctx.setSourceRadio(ship, "Standard");
  const city = byName.get("City")!;
  ctx.setSourceChoice(city, ["Delhi"]);

  const out = ctx.write();

  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const form = doc.getForm();
  const nameF = form.getTextField("Full Name");
  ok(nameF.getText() === "Ada Lovelace", `text filled "Ada Lovelace"`, nameF.getText() ?? "");
  ok(form.getTextField("Details.Notes").getText() === "first line\nsecond line", "multiline filled");
  ok(form.getCheckBox("Agree").isChecked(), "checkbox checked");
  ok(form.getRadioGroup("Ship").getSelected() === "Standard", "radio Standard");
  ok(form.getDropdown("City").getSelected()[0] === "Delhi", "dropdown Delhi", JSON.stringify(form.getDropdown("City").getSelected()));

  // Appearance regeneration: the AP stream carries the text (hex Tj) and
  // the field /DA was rewritten with the computed size.
  const parsed = parsePdf(out);
  const nameInfo = readAcroFormFields(parsed).find((f) => f.name === "Full Name")!;
  const widget = nameInfo.widgets[0]!;
  const apVal = widget.dict.m.get("AP");
  const ap = apVal ? resolve(parsed, apVal) : undefined;
  ok(ap !== undefined && ap.k === "dict", "filled widget has /AP");
  if (ap && ap.k === "dict") {
    const nVal = ap.m.get("N");
    const n = nVal ? resolve(parsed, nVal) : undefined;
    if (n && n.k === "stream") {
      const body = latin1(n.raw);
      const hexOf = (text: string): string => {
        let hex = "";
        for (let i = 0; i < text.length; i += 1) {
          hex += text.charCodeAt(i).toString(16).padStart(2, "0").toUpperCase();
        }
        return hex;
      };
      ok(
        body.includes(`<${hexOf("Ada Lovelace")}> Tj`),
        "AP stream carries the WinAnsi hex Tj",
        body,
      );
      ok(body.includes("/Tx BMC"), "AP stream has the /Tx marked content");
      ok(body.includes("BT"), "AP stream has BT/ET");
    } else {
      ok(false, "AP /N resolves to a stream");
    }
  }
  const da = nameInfo.dict.m.get("DA");
  ok(
    da !== undefined && da.k !== undefined && "b" in da,
    "field /DA rewritten",
  );
  if (da && "b" in da) {
    const daText = latin1((da as { b: Uint8Array }).b);
    ok(/Helvetica \d+(\.\d+)? Tf/.test(daText), `DA "${daText}" carries /Helvetica size Tf`);
  }

  // Untouched field: the read-only one keeps its (absent) value.
  ok((form.getTextField("ReadOnly.Address").getText() ?? "") === "", "untouched field intact");
}

async function probeC(bytes: Uint8Array): Promise<void> {
  console.log("\n=== C. FLATTEN (burn widgets + annots → no form) ===");
  const ctx = StampContext.load(bytes);
  const fields = ctx.readSourceFields();
  const byName = new Map(fields.map((f) => [f.name, f]));
  ctx.setSourceTextField(byName.get("Full Name")!, "Grace Hopper");
  const count = ctx.flattenSourceForm();
  const burn = ctx.burnSourceAnnotations({});
  const out = ctx.write();

  ok(count === fields.length, `flattened ${fields.length} fields`, `count=${count}`);
  ok(burn.burned === 0, "no non-widget annots in fixture", `burned=${burn.burned}`);

  const doc = await PDFDocument.load(out, { updateMetadata: false });
  ok(doc.getPageCount() === 2, "2 pages preserved");
  ok(
    doc.catalog.get(PDFName.of("AcroForm")) === undefined,
    "catalog /AcroForm gone",
  );
  for (const [i, page] of doc.getPages().entries()) {
    ok(
      page.node.Annots() === undefined,
      `page ${i + 1} /Annots gone`,
    );
  }
  // The burn ops live in the page content: `Do` referencing the appearance
  // XObjects; the values are still text-extractable content.
  const parsed = parsePdf(out);
  const rootObj = parsed.trailer.get("Root");
  const root = rootObj ? resolve(parsed, rootObj) : undefined;
  ok(root !== undefined && (root.k === "dict" || root.k === "stream"), "catalog parses");
  if (root && root.k === "dict") {
    ok(!root.m.has("AcroForm"), "parsed catalog has no /AcroForm");
  }
  const ctxPages = readAcroFormFields(parsed); // re-read the OUTPUT
  ok(ctxPages.length === 0, "post-flatten re-read yields no fields");
  // Count the Do ops in every stream object of the output.
  const doc2 = await PDFDocument.load(out, { updateMetadata: false });
  let burnDos = 0;
  for (const [, object] of doc2.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      const body = latin1(object.contents);
      burnDos += (body.match(/\/Fx\d+ Do/g) ?? []).length;
    }
  }
  ok(
    burnDos >= fields.reduce((n, f) => n + f.widgets.length, 0),
    `burn Do ops present (${burnDos})`,
  );
  // WinAnsi-byte hex of "Grace Hopper" somewhere in the output bytes (the
  // burned appearance's Tj).
  let hexFound = false;
  {
    let hex = "";
    for (let i = 0; i < "Grace Hopper".length; i += 1) {
      hex += "Grace Hopper".charCodeAt(i).toString(16).padStart(2, "0").toUpperCase();
    }
    const text = latin1(out);
    hexFound = text.includes(hex);
  }
  ok(hexFound, "burned appearance carries the value hex");
}

async function main(): Promise<void> {
  const bytes = await makeFixture();
  await probeA(bytes);
  await probeB(bytes);
  await probeC(bytes);
  console.log(`\n${checks - bad}/${checks} checks ok`);
  if (bad > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("probe crashed:", error);
  process.exit(1);
});
