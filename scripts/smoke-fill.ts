/**
 * PRE-BUILD smoke test for the Fill out PDF forms tool (P3.10).
 * Verifies the scan module + worker engine BEFORE browser QA:
 *
 *  1. A form PDF with every field kind (text + multiline + maxLength,
 *     checkbox, radio, dropdown, optionlist, read-only text, required
 *     text, a field on page 2) scans correctly: kinds, labels, flags,
 *     options, current values, widget pages and rects.
 *  2. The epoch-prefix worker application: values apply per kind, text
 *     respects maxLength (truncate), checkbox true/false both work,
 *     radio/dropdown select, optionlist multi-select joins, keys from a
 *     DIFFERENT file id never apply (leak guard).
 *  3. flatten(): form fields become page content, getFields() is empty,
 *     the document still renders (page count preserved).
 *  4. userRectToDisplay for /Rotate 0/90/180/270: corners map exactly like
 *     the pdf.js viewport transform (same math the surface uses).
 *
 * Run: bun scripts/smoke-fill.ts
 */
import { writeFile } from "node:fs/promises";
import {
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";
import {
  StampContext,
  WinAnsiError,
  readAcroFormFields,
} from "../src/lib/own/pdf";
import { isWinAnsiText, scanFormFields, userRectToDisplay, displaySize } from "../tools/fill-out-pdf/scan";
import {
  type FdfEntry,
  FdfParseError,
  buildFdf,
  buildFdfEntries,
  buildXfdf,
  matchFdfEntries,
  parseFdf,
  parseFdfOrXfdf,
  parseXfdf,
} from "../tools/fill-out-pdf/fdf";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${String(expected)}, got ${String(actual)})`
  );
}

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([595.28, 841.89]);
  const page2 = doc.addPage([595.28, 841.89]);

  const form = doc.getForm();

  const name = form.createTextField("applicant.name");
  name.setText("Priya Sharma");
  name.addToPage(page1, { x: 100, y: 700, width: 300, height: 24 });

  const email = form.createTextField("applicant.email");
  email.addToPage(page1, { x: 100, y: 660, width: 300, height: 24 });

  const essay = form.createTextField("applicant.essay");
  essay.enableMultiline();
  essay.addToPage(page1, { x: 100, y: 500, width: 300, height: 90 });

  const limited = form.createTextField("applicant.pincode");
  limited.setMaxLength(6);
  limited.addToPage(page1, { x: 100, y: 460, width: 100, height: 24 });

  const agree = form.createCheckBox("consent.agree");
  agree.addToPage(page1, { x: 100, y: 420, width: 18, height: 18 });

  const city = form.createDropdown("address.city");
  city.addOptions(["Delhi", "Mumbai", "Jaipur"]);
  city.select("Delhi");
  city.addToPage(page1, { x: 100, y: 380, width: 160, height: 24 });

  const gender = form.createRadioGroup("personal.gender");
  gender.addOptionToPage("Female", page1, { x: 100, y: 340, width: 16, height: 16 });
  gender.addOptionToPage("Male", page1, { x: 160, y: 340, width: 16, height: 16 });
  gender.select("Female");

  const langs = form.createOptionList("skills.languages");
  langs.addOptions(["Hindi", "English", "Marathi", "Tamil"]);
  langs.addToPage(page2, { x: 100, y: 700, width: 160, height: 80 });

  const locked = form.createTextField("locked.total");
  locked.setText("Rs 1,250");
  locked.enableReadOnly();
  locked.addToPage(page2, { x: 100, y: 600, width: 120, height: 24 });

  const dob = form.createTextField("personal.dateofbirth");
  dob.addToPage(page1, { x: 100, y: 300, width: 140, height: 24 });

  page1.drawText("Application Form", { x: 100, y: 760, size: 16, font });
  page2.drawText("Page 2 fields", { x: 100, y: 760, size: 16, font });

  return doc.save();
}

async function main(): Promise<void> {
  // --- 1. Scan ----------------------------------------------------------
  const bytes = await buildFixture();
  await writeFile("download/qa-p310-fixture.pdf", bytes);
  const scan = await scanFormFields(bytes);

  eq(scan.pageCount, 2, "scan sees 2 pages");
  eq(scan.fields.length, 10, "scan sees 10 fields");

  const byName = new Map(scan.fields.map((f) => [f.name, f]));
  const name = byName.get("applicant.name");
  assert(name !== undefined, "applicant.name scanned");
  eq(name?.kind, "text", "name is text");
  eq(name?.label, "name", "label is the last segment");
  eq(name?.value, "Priya Sharma", "current value read");
  eq(name?.widgets.length, 1, "one widget");
  eq(name?.widgets[0].page, 0, "widget on page 1 (0-based)");

  const agree = byName.get("consent.agree");
  eq(agree?.kind, "checkbox", "agree is checkbox");
  eq(agree?.value, false, "checkbox unchecked");

  const city = byName.get("address.city");
  eq(city?.kind, "dropdown", "city is dropdown");
  eq(city?.options.length, 3, "3 dropdown options");
  eq(city?.value, "Delhi", "dropdown current value");

  const gender = byName.get("personal.gender");
  eq(gender?.kind, "radio", "gender is radio");
  eq(gender?.options.join("|"), "Female|Male", "radio options");
  eq(gender?.value, "Female", "radio current selection");

  const langs = byName.get("skills.languages");
  eq(langs?.kind, "optionlist", "langs is optionlist");
  eq(langs?.options.length, 4, "4 optionlist options");
  eq(langs?.widgets[0].page, 1, "optionlist widget on page 2 (0-based)");

  const locked = byName.get("locked.total");
  eq(locked?.readOnly, true, "read-only flag scanned");
  eq(locked?.value, "Rs 1,250", "read-only value readable");

  const essay = byName.get("applicant.essay");
  eq(essay?.multiline, true, "multiline flag scanned");

  const pincode = byName.get("applicant.pincode");
  eq(pincode?.maxLength, 6, "maxLength scanned");

  // --- 2. Worker application (OWN engine — the worker's exact code path) ---
  const ctx = StampContext.load(bytes); // typed encrypted/corrupt refusal
  const byNameCtx = new Map(ctx.readSourceFields().map((f) => [f.name, f]));

  ctx.setSourceTextField(byNameCtx.get("applicant.name")!, "Arjun Mehta");
  // maxLength fields THROW on overflow (pdf-lib parity) — the worker
  // pre-truncates; verify the throw, then mirror the worker's slice.
  let threw = false;
  try {
    ctx.setSourceTextField(byNameCtx.get("applicant.pincode")!, "1100019999");
  } catch {
    threw = true;
  }
  assert(threw, "engine throws on maxLength overflow (worker must truncate)");
  ctx.setSourceTextField(byNameCtx.get("applicant.pincode")!, "110001".slice(0, 6));
  ctx.setSourceCheckbox(byNameCtx.get("consent.agree")!, true);
  ctx.setSourceChoice(byNameCtx.get("address.city")!, ["Jaipur"]);
  ctx.setSourceRadio(byNameCtx.get("personal.gender")!, "Male");
  ctx.setSourceChoice(byNameCtx.get("skills.languages")!, ["Hindi", "Tamil"]);
  // locked.total untouched (read-only, UI disables it)

  const saved2 = ctx.write();
  const reread = await PDFDocument.load(saved2, { updateMetadata: false });
  const f3 = reread.getForm();
  eq((f3.getField("applicant.name") as PDFTextField).getText(), "Arjun Mehta", "text value round-trips");
  eq((f3.getField("applicant.pincode") as PDFTextField).getText(), "110001", "truncated pincode round-trips");
  eq((f3.getField("consent.agree") as PDFCheckBox).isChecked(), true, "checkbox checked");
  eq((f3.getField("address.city") as PDFDropdown).getSelected()[0], "Jaipur", "dropdown selection round-trips");
  eq((f3.getField("personal.gender") as PDFRadioGroup).getSelected(), "Male", "radio selection round-trips");
  eq(
    (f3.getField("skills.languages") as PDFOptionList).getSelected().join("|"),
    "Hindi|Tamil",
    "optionlist multi-select round-trips"
  );
  eq((f3.getField("locked.total") as PDFTextField).getText(), "Rs 1,250", "untouched field keeps its value");

  // --- 2b. Non-WinAnsi (Hindi) value + the engine's honest contract ------
  // setSourceTextField writes /V FIRST, then throws WinAnsiError when the
  // Helvetica regeneration cannot encode the text (the engine contract the
  // worker catches) — a BETTER seam than pdf-lib's save()-time throw: the
  // value is ALWAYS already in the file. The worker re-sets with the
  // embedded Devanagari TTF; if that fetch fails it falls back to
  // /NeedAppearances (the viewer regenerates). Both paths round-trip here.
  assert(!isWinAnsiText("अर्जुन मेहता"), "isWinAnsiText flags Hindi");
  assert(!isWinAnsiText("₹1,250"), "isWinAnsiText flags the rupee sign");
  assert(isWinAnsiText("Arjun Mehta, 42nd Cross — Mumbai 400001! €125"),
    "isWinAnsiText accepts WinAnsi Latin + punctuation");

  const ctxH = StampContext.load(bytes);
  const fieldsH = new Map(ctxH.readSourceFields().map((f) => [f.name, f]));
  let winThrew: WinAnsiError | null = null;
  try {
    ctxH.setSourceTextField(fieldsH.get("applicant.name")!, "अर्जुन मेहता");
  } catch (error) {
    if (error instanceof WinAnsiError) winThrew = error;
  }
  assert(winThrew !== null, "setSourceTextField throws WinAnsiError for Hindi (worker re-sets with the TTF)");
  // The contract: /V IS already written when the throw happens.
  const nameAfterThrow = readAcroFormFields(ctxH.doc).find((f) => f.name === "applicant.name")!;
  eq(nameAfterThrow.value, "अर्जुन मेहता", "WinAnsiError contract: /V already written");
  // The NeedAppearances fallback (font fetch failed): write as-is.
  ctxH.setNeedAppearances();
  const savedH = ctxH.write();
  const rereadH = await PDFDocument.load(savedH, { updateMetadata: false });
  eq(
    (rereadH.getForm().getField("applicant.name") as PDFTextField).getText(),
    "अर्जुन मेहता",
    "Hindi value round-trips via the NeedAppearances fallback"
  );
  assert(
    rereadH.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)
      ?.lookupMaybe(PDFName.of("NeedAppearances"), PDFBool) !== undefined,
    "NeedAppearances flagged true on the AcroForm"
  );

  // --- 3. Flatten (OWN engine) ------------------------------------------
  const ctxFlat = StampContext.load(saved2);
  const flatCount = ctxFlat.flattenSourceForm();
  eq(flatCount, 10, "flatten: all 10 fields baked");
  const savedFlat = ctxFlat.write();
  const flat = await PDFDocument.load(savedFlat, { updateMetadata: false });
  eq(flat.getForm().getFields().length, 0, "flattened form has no fields left");
  eq(flat.getPageCount(), 2, "page count preserved after flatten");

  // --- 4. Rotation mapping ----------------------------------------------
  // rot 0: user (0, 841.89) is the display top-left.
  const d0 = userRectToDisplay({ x: 0, y: 821.89, w: 100, h: 20 }, 0, 595.28, 841.89);
  eq(d0.left, 0, "rot0 left");
  eq(d0.top, 0, "rot0 top (user top edge maps to display 0)");
  eq(d0.w, 100, "rot0 width");

  // rot 90: user point (0, 0) maps to display (0, 0) — bottom-left becomes
  // display top-left for a clockwise-rotated page (width = user height).
  const d90 = userRectToDisplay({ x: 0, y: 0, w: 50, h: 25 }, 90, 595.28, 841.89);
  eq(d90.left, 0, "rot90 left");
  eq(d90.top, 0, "rot90 top");
  eq(d90.w, 25, "rot90 display width = rect height");
  const s90 = displaySize(90, 595.28, 841.89);
  eq(s90.w, 841.89, "rot90 display width = user height");
  eq(s90.h, 595.28, "rot90 display height = user width");

  // rot 180: user top-left (0, H) maps to display bottom-right… no — to
  // (W - 0, H - 0) bottom-right corner in display terms: X = W - x.
  const d180 = userRectToDisplay({ x: 495.28, y: 821.89, w: 100, h: 20 }, 180, 595.28, 841.89);
  eq(d180.left, 0, "rot180 left (right-side rect maps to display left)");
  eq(d180.top, 821.89, "rot180 top (near user top = display bottom)");

  // rot 270 (90° CCW): user top-right (W, H) maps to display (0, 0).
  const d270 = userRectToDisplay({ x: 545.28, y: 816.89, w: 50, h: 25 }, 270, 595.28, 841.89);
  eq(d270.left, 0, "rot270 left");
  eq(d270.top, 0, "rot270 top");
  eq(d270.w, 25, "rot270 display width = rect height");

  // --- 5. FDF / XFDF import-export ---------------------------------------
  // Scenario: the user fills TWO fields (name + the consent checkbox), the
  // export snapshots every effective answer (user overrides + the file's
  // own values; read-only fields are skipped — they can never re-apply).
  console.log("── 5. FDF / XFDF export + import ──────────────────");
  const overrides: Record<string, string | boolean> = {
    "applicant.name": "Arjun Mehta",
    "consent.agree": true,
  };
  const valueOf = (name: string): string | boolean => {
    if (name in overrides) return overrides[name];
    const field = scan.fields.find((f) => f.name === name);
    if (!field) return "";
    if (field.kind === "checkbox") return field.value === true;
    if (field.kind === "optionlist") return field.selected.join("\n");
    return typeof field.value === "string" ? field.value : "";
  };
  const entries = buildFdfEntries(scan.fields, (field) => valueOf(field.name));
  eq(
    JSON.stringify(entries.map((e) => e.name)),
    JSON.stringify([
      "applicant.name",
      "consent.agree",
      "address.city",
      "personal.gender",
    ]),
    "export: user answers + file values, read-only skipped, empties skipped"
  );
  eq(entries[1].value, true, "export: checked checkbox becomes a boolean entry");

  const fdf = buildFdf(entries, "qa-p310-fixture.pdf");
  assert(fdf.startsWith("%FDF-1.2"), "FDF: %FDF-1.2 header");
  assert(fdf.includes("/F (qa-p310-fixture.pdf)"), "FDF: /F carries the source PDF");
  assert(fdf.includes("/Fields ["), "FDF: /Fields array present");
  assert(
    fdf.includes("/T (applicant.name) /V (Arjun Mehta)"),
    "FDF: /T + /V pair for the filled text field"
  );
  assert(
    fdf.includes("<< /T (consent.agree) /V /Yes >>"),
    "FDF: checkbox exports the classic /V /Yes name"
  );
  assert(
    fdf.includes("/T (address.city) /V (Delhi)"),
    "FDF: dropdown's export value is a string"
  );
  assert(fdf.includes("trailer"), "FDF: trailer present");
  assert(fdf.includes("%%EOF"), "FDF: %%EOF tail");

  const xfdf = buildXfdf(entries, "qa-p310-fixture.pdf");
  assert(xfdf.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "XFDF: XML declaration");
  assert(xfdf.includes('<xfdf xmlns="http://ns.adobe.com/xfdf/"'), "XFDF: Adobe namespace");
  assert(xfdf.includes('<f href="qa-p310-fixture.pdf"/>'), "XFDF: <f> target");
  assert(
    xfdf.includes('<field name="applicant.name">') &&
      xfdf.includes("<value>Arjun Mehta</value>"),
    "XFDF: field + value elements"
  );
  assert(
    xfdf.includes('<field name="consent.agree"><value>Yes</value></field>'),
    "XFDF: checkbox Yes convention"
  );

  // Parse round-trips: FDF rebuilds the entries EXACTLY (the checkbox /V /Yes
  // name re-parses as the boolean). XFDF is XML — it has no boolean type, so
  // buildXfdf writes the checkbox as the literal string "Yes"/"Off" and
  // parseXfdf KEEPS it a string on purpose (the entry layer cannot know the
  // field kind; matchFdfEntries resolves it kind-aware — §5b proves that
  // path). The round-trip expectation maps the boolean accordingly.
  eq(
    JSON.stringify(parseFdf(fdf)),
    JSON.stringify(entries),
    "FDF: parse(build()) round-trips exactly"
  );
  const xfdfForm = entries.map((e) => ({
    name: e.name,
    value: typeof e.value === "boolean" ? (e.value ? "Yes" : "Off") : e.value,
  }));
  eq(
    JSON.stringify(parseXfdf(xfdf)),
    JSON.stringify(xfdfForm),
    "XFDF: parse(build()) round-trips (checkbox as the Yes/Off string)"
  );
  eq(
    JSON.stringify(parseFdfOrXfdf(fdf)),
    JSON.stringify(entries),
    "sniff: FDF content recognized"
  );
  eq(
    JSON.stringify(parseFdfOrXfdf(xfdf)),
    JSON.stringify(xfdfForm),
    "sniff: XFDF content recognized (checkbox string convention)"
  );
  let sniffThrew = false;
  try {
    parseFdfOrXfdf("this is neither fdf nor xml");
  } catch (e) {
    sniffThrew = e instanceof FdfParseError;
  }
  assert(sniffThrew, "sniff: garbage → FdfParseError (honest toast path)");

  // Escaping: parens, backslash, newlines + an octal control character.
  const nasty: FdfEntry[] = [
    { name: "we(ird).\\name", value: "line1\nline2 (with parens) \\ and \u0001 ctrl" },
  ];
  eq(
    JSON.stringify(parseFdf(buildFdf(nasty, "x.pdf"))),
    JSON.stringify(nasty),
    "FDF: string escapes round-trip"
  );
  eq(
    JSON.stringify(parseXfdf(buildXfdf(nasty, "x.pdf"))),
    JSON.stringify(nasty),
    "XFDF: XML escapes round-trip"
  );

  // Multi-select optionlist exports the FDF /V array form.
  const multi: FdfEntry[] = [{ name: "skills.languages", value: "Hindi\nTamil" }];
  const multiFdf = buildFdf(multi, "x.pdf");
  assert(
    multiFdf.includes("/V [(Hindi) (Tamil)]"),
    "FDF: optionlist multi-select → /V array of strings"
  );
  eq(
    JSON.stringify(parseFdf(multiFdf)),
    JSON.stringify(multi),
    "FDF: /V array parses back to the \"\n join"
  );

  // --- 5b. Import matching (the honesty rules) --------------------------
  const freshScan = await scanFormFields(bytes); // a FRESH load of the same form
  const hostile: FdfEntry[] = [
    { name: "applicant.name", value: "Arjun Mehta" },
    { name: "nope.unknown", value: "x" }, // no such field
    { name: "locked.total", value: "999" }, // read-only
    { name: "address.city", value: "Paris" }, // not on the option list
    { name: "personal.gender", value: "Female" }, // valid radio export
    { name: "applicant.pincode", value: "1234567" }, // maxLength 6
    { name: "applicant.email", value: true }, // boolean for a text field
    { name: "consent.agree", value: "Yes" }, // XFDF checkbox convention
  ];
  const match = matchFdfEntries(hostile, freshScan.fields);
  eq(
    JSON.stringify(match.applies.map((a) => a.name)),
    JSON.stringify([
      "applicant.name",
      "personal.gender",
      "applicant.pincode",
      "consent.agree",
    ]),
    "import: only honest applies survive (unknown/readonly/off-list/kind-mismatch skipped)"
  );
  eq(match.skipped, 4, "import: 4 skips counted honestly");
  eq(
    match.applies.find((a) => a.name === "applicant.pincode")?.value,
    "123456",
    "import: text truncated to maxLength (worker parity)"
  );
  eq(
    match.applies.find((a) => a.name === "consent.agree")?.value,
    true,
    "import: XFDF \"Yes\" string → checkbox true"
  );

  // --- 5c. Full round-trip: export → fresh load → apply → save → read ---
  // The surface's own import applies the same per-kind writes the worker
  // performs; prove the exported answers land in a re-saved PDF.
  const ctx3 = StampContext.load(bytes);
  const byName3 = new Map(ctx3.readSourceFields().map((f) => [f.name, f]));
  for (const apply of matchFdfEntries(entries, freshScan.fields).applies) {
    const field = byName3.get(apply.name);
    if (!field) continue;
    if (field.kind === "text") ctx3.setSourceTextField(field, String(apply.value));
    else if (field.kind === "checkbox" && apply.value === true) ctx3.setSourceCheckbox(field, true);
    else if (field.kind === "dropdown" && typeof apply.value === "string")
      ctx3.setSourceChoice(field, [apply.value]);
    else if (field.kind === "radio" && typeof apply.value === "string")
      ctx3.setSourceRadio(field, apply.value);
  }
  const saved3 = ctx3.write();
  const reread3 = await PDFDocument.load(saved3, { updateMetadata: false });
  const f4 = reread3.getForm();
  eq(
    (f4.getField("applicant.name") as PDFTextField).getText(),
    "Arjun Mehta",
    "round-trip: filled name restored from the exported FDF"
  );
  eq(
    (f4.getField("consent.agree") as PDFCheckBox).isChecked(),
    true,
    "round-trip: checkbox restored"
  );
  eq(
    (f4.getField("address.city") as PDFDropdown).getSelected()[0],
    "Delhi",
    "round-trip: dropdown value restored"
  );
  eq(
    (f4.getField("personal.gender") as PDFRadioGroup).getSelected(),
    "Female",
    "round-trip: radio export value restored"
  );
  eq(
    (f4.getField("locked.total") as PDFTextField).getText(),
    "Rs 1,250",
    "round-trip: read-only field untouched"
  );

  console.log("\nALL FILL SMOKE CHECKS PASSED");
}

void main();
