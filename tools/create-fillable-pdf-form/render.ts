/**
 * Create fillable PDF form — the OWN-ENGINE builder (P6-u port of the
 * P3-FORM pdf-lib renderer; the P6-o builder + P6-p reader complete the
 * family).
 *
 * One StampContext write over an engine-authored blank scaffold:
 *
 *  - SCAFFOLD: N blank A4 pages authored through CreateContext (the
 *    engine's own create path — a valid minimal PDF, immediately parsed
 *    by StampContext.load; the scaffold carries nothing of its own).
 *  - PRINTED pass (heading / text / divider / box + every field LABEL)
 *    stamps through the ONE embedded font — the self-hosted Noto Sans
 *    Devanagari — so ₹ + हिंदी + Latin all print (create-invoice
 *    pattern). Static text wraps with the SAME pure wrapText the live
 *    preview uses, so what you see is what prints. Bold = the
 *    create-invoice double-stroke trick (no bold face embedded).
 *  - FIELDS are real AcroForm widgets (StampContext's P6-o builder,
 *    pdf-lib PDFForm parity) added AFTER the printed pass; element order
 *    = tab order. Required → /Ff bit 2, maxLength → /MaxLen.
 *  - NUMBER fields get /AA /F + /K with the Adobe-documented
 *    AFNumber_Format/AFNumber_Keystroke (2 decimals, no currency in the
 *    JS — the ₹ prefix / % suffix are printed static text beside the
 *    box, per the pinned honest-scope decision).
 *  - DATE fields get AFDate_FormatEx/AFDate_KeystrokeEx("dd/mm/yyyy").
 *    These AF* functions are the Adobe-documented standard: universally
 *    supported in Acrobat/Reader; other viewers ignore them gracefully
 *    (the form still fills).
 *  - CALCULATED fields (compileRules targets) get an /AA /C JavaScript
 *    action and the AcroForm /CO array lists them in topological order
 *    (dependencies first) — ISO 32000-1 §12.6.4.
 *  - NeedAppearances is set true so every viewer regenerates field
 *    appearances after JavaScript-driven value changes.
 *  - Info (Title / Creator / CreationDate) authored through setInfo —
 *    the stamp writer otherwise emits no Info (copyPages-class
 *    contract); the values ride pdf-lib-encoded (UTF-16BE hex text,
 *    literal D: dates).
 */

import {
  CreateContext,
  StampContext,
  pdfInfoDate,
  pdfInfoText,
  type StampTextField,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  boxRect,
  compileRules,
  exportValueFor,
  asciiSafe,
  isFieldEl,
  lineHeight,
  PAGE_H_PX,
  PAGE_W_PT,
  PAGE_H_PT,
  PT_PER_PX,
  pxToPtRect,
  radioRows,
  wrapText,
  type FieldEl,
  type FormDoc,
  type StaticEl,
} from "./model";

/* ------------------------------------------------------------------ */
/* Adobe-documented format/keystroke scripts (ISO 32000-1 §12.6.4.2)  */
/* ------------------------------------------------------------------ */

export const AF_NUMBER_FORMAT =
  'AFNumber_Format(2, 0, 0, 0, "", false);';
export const AF_NUMBER_KEYSTROKE =
  'AFNumber_Keystroke(2, 0, 0, 0, "", false);';
export const AF_DATE_FORMAT = 'AFDate_FormatEx("dd/mm/yyyy");';
export const AF_DATE_KEYSTROKE = 'AFDate_KeystrokeEx("dd/mm/yyyy");';

const COL_TEXT = { r: 0.067, g: 0.067, b: 0.067 };
const COL_RULE = { r: 0.55, g: 0.57, b: 0.6 };
const COL_FIELD_BORDER = { r: 0.62, g: 0.65, b: 0.7 };
const COL_CHECK_BORDER = { r: 0.45, g: 0.49, b: 0.55 };

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export interface FormBuildReport {
  pages: number;
  statics: number;
  fields: number;
  calcFields: number;
}

/* ------------------------------------------------------------------ */
/* px-space text helpers (y from TOP in px; PDF y grows UP)             */
/* ------------------------------------------------------------------ */

function drawTextPx(
  ctx: StampContext,
  slot: number,
  font: StampTtfFont,
  text: string,
  xPx: number,
  topPx: number,
  fsPx: number,
  opts: { bold?: boolean; color?: { r: number; g: number; b: number } } = {}
): void {
  if (text === "") return;
  const size = fsPx * PT_PER_PX;
  const y = (PAGE_H_PX - topPx - fsPx) * PT_PER_PX;
  const x = xPx * PT_PER_PX;
  const color = opts.color ?? COL_TEXT;
  ctx.stampText(slot, { x, y, text, size, ttf: font, color });
  if (opts.bold) {
    // No bold face embedded — the create-invoice double-stroke trick.
    ctx.stampText(slot, {
      x: x + 0.3,
      y: y - 0.3,
      text,
      size,
      ttf: font,
      color,
    });
  }
}

/** Baseline-centred text for a row of height `rowH` at `topPx`. */
function drawCenteredPx(
  ctx: StampContext,
  slot: number,
  font: StampTtfFont,
  text: string,
  xPx: number,
  topPx: number,
  rowH: number,
  fsPx: number
): void {
  const top = topPx + (rowH - fsPx) / 2;
  drawTextPx(ctx, slot, font, text, xPx, top, fsPx);
}

/* ------------------------------------------------------------------ */
/* Static pass (printed ink — everything that is not a widget)         */
/* ------------------------------------------------------------------ */

function drawStatic(
  ctx: StampContext,
  slot: number,
  font: StampTtfFont,
  el: StaticEl
): void {
  if (el.kind === "divider") {
    const yMid = (el.y + el.h / 2) * PT_PER_PX;
    ctx.stampLine(slot, {
      start: { x: el.x * PT_PER_PX, y: yMid },
      end: { x: (el.x + el.w) * PT_PER_PX, y: yMid },
      thickness: 0.75,
      color: COL_RULE,
    });
    return;
  }
  if (el.kind === "box") {
    const r = pxToPtRect(el);
    ctx.stampRect(slot, {
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      borderColor: COL_RULE,
      borderWidth: 1,
    });
    return;
  }
  // heading / text — wrap with the SAME pure algorithm as the preview.
  const lines = wrapText(
    el.text,
    el.w * PT_PER_PX,
    el.fs * PT_PER_PX,
    (s, size) => font.measure(s, size)
  );
  const lh = lineHeight(el.fs);
  lines.forEach((line, i) => {
    drawTextPx(ctx, slot, font, line, el.x, el.y + i * lh, el.fs, {
      bold: el.kind === "heading",
    });
  });
}

/** Field label + number decorations + radio option labels. */
function drawFieldPrint(
  ctx: StampContext,
  slot: number,
  font: StampTtfFont,
  el: FieldEl
): void {
  if (el.label) {
    drawTextPx(ctx, slot, font, el.label, el.x, el.y, el.fs);
  }
  if (el.kind === "radio") {
    const rows = radioRows(el);
    const circle = rows[0]?.circle ?? 12;
    el.options.forEach((opt, i) => {
      const row = rows[i];
      if (!row) return;
      drawCenteredPx(
        ctx,
        slot,
        font,
        opt,
        el.x + circle + 6,
        row.y,
        row.h,
        el.fs
      );
    });
  }
  if (el.kind === "number" && el.format !== "plain") {
    const box = boxRect(el);
    if (el.format === "rupee") {
      const wPx = font.measure("\u20b9", el.fs * PT_PER_PX) / PT_PER_PX;
      drawCenteredPx(
        ctx,
        slot,
        font,
        "\u20b9",
        Math.max(2, el.x - wPx - 4),
        box.y,
        box.h,
        el.fs
      );
    } else {
      drawCenteredPx(ctx, slot, font, "%", el.x + el.w + 4, box.y, box.h, el.fs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* The builder                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the whole fillable PDF on the OWN engine. `devaBytes` is the
 * self-hosted Noto Sans Devanagari TTF (the worker fetches it from this
 * origin; tests read it from disk) — the ONE embedded font every printed
 * element shares.
 */
export function buildFormPdf(
  form: FormDoc,
  devaBytes: Uint8Array
): { bytes: Uint8Array; report: FormBuildReport } {
  /* ---- scaffold: blank A4 pages through the engine's create path ---- */
  const pageCount = Math.max(1, form.pages.length);
  const blank = CreateContext.create();
  for (let i = 0; i < pageCount; i += 1) {
    blank.addPage(PAGE_W_PT, PAGE_H_PT);
  }
  const ctx = StampContext.load(blank.write());
  const font = ctx.embedTtf(devaBytes);

  let staticCount = 0;
  let fieldCount = 0;

  /* ---- printed pass (statics + labels; widgets go on top later) ---- */
  form.pages.forEach((page, pi) => {
    for (const el of page.elements) {
      if (isFieldEl(el)) {
        drawFieldPrint(ctx, pi, font, el);
      } else {
        drawStatic(ctx, pi, font, el);
        staticCount += 1;
      }
    }
  });

  /* ---- widget pass (element order = tab order) ---- */
  const taken = new Set<string>();
  const byName = new Map<string, StampTextField>();
  form.pages.forEach((page, pi) => {
    for (const el of page.elements) {
      if (!isFieldEl(el)) continue;
      const name = uniqueNameLocal(el.name, taken);
      const r = pxToPtRect(boxRect(el));
      if (el.kind === "checkbox") {
        const box = ctx.createCheckBox(name);
        if (el.required) box.enableRequired();
        box.addToSlot(pi, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_CHECK_BORDER,
        });
      } else if (el.kind === "radio") {
        const group = ctx.createRadioGroup(name);
        if (el.required) group.enableRequired();
        const rows = radioRows(el);
        const used = new Set<string>();
        el.options.forEach((opt, i) => {
          const row = rows[i];
          if (!row) return;
          let ev = exportValueFor(opt, i);
          while (used.has(ev)) ev = ev + "_x";
          used.add(ev);
          group.addOptionToSlot(pi, ev, {
            x: el.x * PT_PER_PX,
            y: (PAGE_H_PX - row.cy - row.circle) * PT_PER_PX,
            width: row.circle * PT_PER_PX,
            height: row.circle * PT_PER_PX,
          });
        });
      } else if (el.kind === "dropdown") {
        const drop = ctx.createDropdown(name);
        if (el.required) drop.enableRequired();
        const values: string[] = [];
        el.options.forEach((opt, i) => {
          const clean = asciiSafe(opt);
          values.push(clean !== "" ? clean : `Option ${i + 1}`);
        });
        if (values.length > 0) drop.addOptions(...values);
        drop.addToSlot(pi, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_FIELD_BORDER,
        });
      } else {
        // text | multiline | number | date → text field
        const field = ctx.createTextField(name);
        if (el.kind === "multiline") field.enableMultiline();
        if (el.required) field.enableRequired();
        if ((el.kind === "text" || el.kind === "multiline") && el.maxLength > 0) {
          field.setMaxLength(Math.round(el.maxLength));
        }
        field.addToSlot(pi, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_FIELD_BORDER,
        });
        byName.set(name, field);
      }
      fieldCount += 1;
    }
  });

  /* ---- format/keystroke actions on number + date fields ---- */
  for (const el of allFieldEls(form)) {
    if (el.kind === "number") {
      const field = byName.get(el.name);
      if (field) {
        field.setAdditionalActions({
          F: AF_NUMBER_FORMAT,
          K: AF_NUMBER_KEYSTROKE,
        });
      }
    } else if (el.kind === "date") {
      const field = byName.get(el.name);
      if (field) {
        field.setAdditionalActions({
          F: AF_DATE_FORMAT,
          K: AF_DATE_KEYSTROKE,
        });
      }
    }
  }

  /* ---- calculations: /AA /C per target + /CO in topo order ---- */
  const calc = compileRules(
    form.rules,
    allFieldEls(form).map((el) => ({ name: el.name, kind: el.kind }))
  );
  let calcFields = 0;
  if (calc.ok && calc.compiled.length > 0) {
    for (const cr of calc.compiled) {
      const field = byName.get(cr.target);
      if (!field) continue;
      // setAdditionalActions MERGES — an existing /F /K (the number
      // format/keystroke pair) rides through, /C joins them.
      field.setAdditionalActions({ C: cr.js });
      ctx.addCalculationField(field);
      calcFields += 1;
    }
  }

  /* ---- compatibility: let every viewer regenerate appearances ---- */
  if (fieldCount > 0) ctx.setNeedAppearances();

  /* ---- Info (Title / Creator / CreationDate — pdf-lib encodings) ---- */
  ctx.setInfo([
    ["Title", pdfInfoText(form.title || "Fillable form")],
    ["Creator", pdfInfoText("DocoPDF")],
    ["CreationDate", pdfInfoDate(new Date())],
  ]);

  return {
    bytes: ctx.write(),
    report: {
      pages: pageCount,
      statics: staticCount,
      fields: fieldCount,
      calcFields,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Small local helpers                                                 */
/* ------------------------------------------------------------------ */

function allFieldEls(form: FormDoc): FieldEl[] {
  const out: FieldEl[] = [];
  for (const page of form.pages) {
    for (const el of page.elements) if (isFieldEl(el)) out.push(el);
  }
  return out;
}

function uniqueNameLocal(base: string, taken: Set<string>): string {
  const clean = base.slice(0, 40) || "field";
  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${clean}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const stamped = `${clean}_${Date.now()}`;
  taken.add(stamped);
  return stamped;
}
