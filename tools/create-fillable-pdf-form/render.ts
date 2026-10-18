/**
 * Create fillable PDF form — the pdf-lib builder (P3-FORM).
 *
 * Extracted from worker.ts so the smoke script (and any future re-use)
 * can drive the EXACT export code in bun: same geometry, same AcroForm
 * construction, same calculation actions. The worker owns fonts +
 * protocol; this file owns every point of ink and every field object.
 *
 *  - STATIC elements (heading / text / divider / box) and every printed
 *    LABEL print through the ONE embedded font — the self-hosted Noto
 *    Sans Devanagari — so ₹ + हिंदी + Latin all print (create-invoice
 *    pattern). Static text wraps with the SAME pure wrapText the live
 *    preview uses, so what you see is what prints.
 *  - FIELDS are real AcroForm widgets (pdf-lib form API) added AFTER the
 *    printed pass so widgets sit on top; element order = tab order.
 *    Required → /Ff bit 2 (enableRequired), maxLength → setMaxLength.
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
 *    (dependencies first) — ISO 32000-1 §12.6.4, built with pdf-lib's
 *    low-level dict API.
 *  - NeedAppearances is set true so every viewer regenerates field
 *    appearances after JavaScript-driven value changes.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFString,
  rgb,
} from "pdf-lib";
import type { PDFField, PDFFont, PDFPage } from "pdf-lib";

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

const COL_TEXT = rgb(0.067, 0.067, 0.067);
const COL_RULE = rgb(0.55, 0.57, 0.6);
const COL_FIELD_BORDER = rgb(0.62, 0.65, 0.7);
const COL_CHECK_BORDER = rgb(0.45, 0.49, 0.55);

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
  page: PDFPage,
  font: PDFFont,
  text: string,
  xPx: number,
  topPx: number,
  fsPx: number,
  opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}
): void {
  if (text === "") return;
  const size = fsPx * PT_PER_PX;
  const y = (PAGE_H_PX - topPx - fsPx) * PT_PER_PX;
  const x = xPx * PT_PER_PX;
  const color = opts.color ?? COL_TEXT;
  page.drawText(text, { x, y, size, font, color });
  if (opts.bold) {
    // No bold face embedded — the create-invoice double-stroke trick.
    page.drawText(text, { x: x + 0.3, y: y - 0.3, size, font, color });
  }
}

/** Baseline-centred text for a row of height `rowH` at `topPx`. */
function drawCenteredPx(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xPx: number,
  topPx: number,
  rowH: number,
  fsPx: number
): void {
  const top = topPx + (rowH - fsPx) / 2;
  drawTextPx(page, font, text, xPx, top, fsPx);
}

/* ------------------------------------------------------------------ */
/* Static pass (printed ink — everything that is not a widget)         */
/* ------------------------------------------------------------------ */

function drawStatic(
  page: PDFPage,
  font: PDFFont,
  el: StaticEl
): void {
  if (el.kind === "divider") {
    const yMid = (el.y + el.h / 2) * PT_PER_PX;
    page.drawLine({
      start: { x: el.x * PT_PER_PX, y: yMid },
      end: { x: (el.x + el.w) * PT_PER_PX, y: yMid },
      thickness: 0.75,
      color: COL_RULE,
    });
    return;
  }
  if (el.kind === "box") {
    const r = pxToPtRect(el);
    page.drawRectangle({
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
    (s, size) => font.widthOfTextAtSize(s, size)
  );
  const lh = lineHeight(el.fs);
  lines.forEach((line, i) => {
    drawTextPx(page, font, line, el.x, el.y + i * lh, el.fs, {
      bold: el.kind === "heading",
    });
  });
}

/** Field label + number decorations + radio option labels. */
function drawFieldPrint(
  page: PDFPage,
  font: PDFFont,
  el: FieldEl
): void {
  if (el.label) {
    drawTextPx(page, font, el.label, el.x, el.y, el.fs);
  }
  if (el.kind === "radio") {
    const rows = radioRows(el);
    const circle = rows[0]?.circle ?? 12;
    el.options.forEach((opt, i) => {
      const row = rows[i];
      if (!row) return;
      drawCenteredPx(
        page,
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
      const wPx =
        font.widthOfTextAtSize("\u20b9", el.fs * PT_PER_PX) / PT_PER_PX;
      drawCenteredPx(
        page,
        font,
        "\u20b9",
        Math.max(2, el.x - wPx - 4),
        box.y,
        box.h,
        el.fs
      );
    } else {
      drawCenteredPx(page, font, "%", el.x + el.w + 4, box.y, box.h, el.fs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Additional-action dictionaries (pdf-lib low-level)                  */
/* ------------------------------------------------------------------ */

function jsActionDict(doc: PDFDocument, js: string): PDFDict {
  const d = PDFDict.withContext(doc.context);
  d.set(PDFName.of("Type"), PDFName.of("Action"));
  d.set(PDFName.of("S"), PDFName.of("JavaScript"));
  d.set(PDFName.of("JS"), PDFString.of(js));
  return d;
}

/** Merge-set the /AA entries {C, F, K} on a field's terminal dict. */
function setAdditionalActions(
  doc: PDFDocument,
  field: { acroField: { dict: PDFDict } },
  entries: { C?: string; F?: string; K?: string }
): void {
  if (!entries.C && !entries.F && !entries.K) return;
  const aa = PDFDict.withContext(doc.context);
  if (entries.C) aa.set(PDFName.of("C"), jsActionDict(doc, entries.C));
  if (entries.F) aa.set(PDFName.of("F"), jsActionDict(doc, entries.F));
  if (entries.K) aa.set(PDFName.of("K"), jsActionDict(doc, entries.K));
  field.acroField.dict.set(PDFName.of("AA"), aa);
}

/* ------------------------------------------------------------------ */
/* The builder                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the whole fillable PDF into `doc` (pages added as needed).
 * `font` must already be embedded in `doc` (the worker loads the
 * self-hosted Noto Sans Devanagari; tests read it from disk).
 */
export function drawFormPdf(
  doc: PDFDocument,
  font: PDFFont,
  form: FormDoc
): FormBuildReport {
  const acroForm = doc.getForm();
  const pages = form.pages.map(() => doc.addPage([PAGE_W_PT, PAGE_H_PT]));

  let staticCount = 0;
  let fieldCount = 0;

  /* ---- printed pass (statics + labels; widgets go on top later) ---- */
  form.pages.forEach((page, pi) => {
    const pdfPage = pages[pi];
    for (const el of page.elements) {
      if (isFieldEl(el)) {
        drawFieldPrint(pdfPage, font, el);
      } else {
        drawStatic(pdfPage, font, el);
        staticCount += 1;
      }
    }
  });

  /* ---- widget pass (element order = tab order) ---- */
  const taken = new Set<string>();
  const byName = new Map<string, PDFField>();
  form.pages.forEach((page, pi) => {
    const pdfPage = pages[pi];
    for (const el of page.elements) {
      if (!isFieldEl(el)) continue;
      const name = uniqueNameLocal(el.name, taken);
      const r = pxToPtRect(boxRect(el));
      if (el.kind === "checkbox") {
        const box = acroForm.createCheckBox(name);
        if (el.required) box.enableRequired();
        box.addToPage(pdfPage, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_CHECK_BORDER,
        });
        byName.set(name, box);
      } else if (el.kind === "radio") {
        const group = acroForm.createRadioGroup(name);
        if (el.required) group.enableRequired();
        const rows = radioRows(el);
        const used = new Set<string>();
        el.options.forEach((opt, i) => {
          const row = rows[i];
          if (!row) return;
          let ev = exportValueFor(opt, i);
          while (used.has(ev)) ev = ev + "_x";
          used.add(ev);
          group.addOptionToPage(ev, pdfPage, {
            x: el.x * PT_PER_PX,
            y: (PAGE_H_PX - row.cy - row.circle) * PT_PER_PX,
            width: row.circle * PT_PER_PX,
            height: row.circle * PT_PER_PX,
          });
        });
        byName.set(name, group);
      } else if (el.kind === "dropdown") {
        const drop = acroForm.createDropdown(name);
        if (el.required) drop.enableRequired();
        const values: string[] = [];
        el.options.forEach((opt, i) => {
          const clean = asciiSafe(opt);
          values.push(clean !== "" ? clean : `Option ${i + 1}`);
        });
        if (values.length > 0) drop.addOptions(values);
        drop.addToPage(pdfPage, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_FIELD_BORDER,
          backgroundColor: rgb(1, 1, 1),
        });
        byName.set(name, drop);
      } else {
        // text | multiline | number | date → PDFTextField
        const field = acroForm.createTextField(name);
        if (el.kind === "multiline") field.enableMultiline();
        if (el.required) field.enableRequired();
        if ((el.kind === "text" || el.kind === "multiline") && el.maxLength > 0) {
          field.setMaxLength(Math.round(el.maxLength));
        }
        field.addToPage(pdfPage, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          borderWidth: 1,
          borderColor: COL_FIELD_BORDER,
          backgroundColor: rgb(1, 1, 1),
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
        setAdditionalActions(doc, field, {
          F: AF_NUMBER_FORMAT,
          K: AF_NUMBER_KEYSTROKE,
        });
      }
    } else if (el.kind === "date") {
      const field = byName.get(el.name);
      if (field) {
        setAdditionalActions(doc, field, {
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
      const existing = field.acroField.dict.get(PDFName.of("AA"));
      // Rebuild the /AA so C joins any existing F/K entries.
      const f = existing instanceof PDFDict ? existing.get(PDFName.of("F")) : undefined;
      const k = existing instanceof PDFDict ? existing.get(PDFName.of("K")) : undefined;
      const jsF = f instanceof PDFDict ? f.get(PDFName.of("JS")) : undefined;
      const jsK = k instanceof PDFDict ? k.get(PDFName.of("JS")) : undefined;
      setAdditionalActions(doc, field, {
        C: cr.js,
        F: jsF instanceof PDFString ? jsF.asString() : undefined,
        K: jsK instanceof PDFString ? jsK.asString() : undefined,
      });
      calcFields += 1;
    }
    const co = PDFArray.withContext(doc.context);
    for (const cr of calc.compiled) {
      const field = byName.get(cr.target);
      if (field) co.push(field.ref);
    }
    if (co.size() > 0) {
      acroForm.acroForm.dict.set(PDFName.of("CO"), co);
    }
  }

  /* ---- compatibility: let every viewer regenerate appearances ---- */
  acroForm.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);

  doc.setTitle(form.title || "Fillable form");
  doc.setCreator("DocoPDF");
  doc.setCreationDate(new Date());

  return {
    pages: pages.length,
    statics: staticCount,
    fields: fieldCount,
    calcFields,
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
