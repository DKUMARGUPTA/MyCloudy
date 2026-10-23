/**
 * XML e-invoice to PDF renderer (RB5-d — 87th tool) — the vector sheet
 * painter. Extracted from worker.ts so the smoke script (and any future
 * surface re-use) drives the EXACT drawing code in bun: same geometry,
 * same pagination, same split-run font logic.
 *
 * Layout model (A4 595.28 × 841.89 / Letter 612 × 792, 40 pt margins):
 *  - page 1: seller masthead (left) + "INVOICE" + number/date/type (right)
 *    over an accent rule, then the buyer block with reference meta;
 *  - line-item table: # | Item (name + SKU/description) | Qty (+unit)
 *    | Tax % | Amount — hairline rows, header row repeated on every page;
 *  - continuation pages repeat the full header;
 *  - totals (per-rate tax, grand total, Paid, Amount due bold) + payment
 *    refs + notes-as-small-footer live ONLY on the last page;
 *  - "Page N / M" centered in the bottom margin band of every page.
 *
 * FONTS — the split-run recipe: every string is split into WinAnsi and
 * Devanagari runs. Latin-only invoices use the base-14 Helvetica family
 * and embed NOTHING; any Devanagari (or ₹) run switches to the embedded
 * Noto Sans Devanagari subset for exactly those runs — mixed EN+HI
 * strings render with both faces in one line (create-invoice /
 * create-resume needsNoto precedent). Noto ships Regular only, so bold
 * Devanagari honestly falls back to the regular weight.
 */

import { rgb, type PDFDocument, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

import type {
  InvoiceLabelMap,
  ParsedInvoice,
  RenderOptions,
} from "./types";
import {
  GEO,
  MAX_LINES,
  MAX_NOTE_CHARS,
  computeRows,
  currencyFmt,
  formatRate,
  isWinAnsiChar,
  needsNotoChar,
  paymentMeansLabel,
  planBuyer,
  planHeader,
  sanitizeText,
  wrapText,
  type BuyerPlan,
  type HeaderPlan,
  type MeasureFn,
  type PlannedRow,
  type RowsPlan,
  type TableCols,
} from "./model";

/* ------------------------------------------------------------------ */
/* Palette + page sizes                                                 */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const COL_ACCENT = rgb(0.043, 0.42, 0.302); // #0b6b4d (create-invoice default)
const COL_HEADER_BG = rgb(0.933, 0.949, 0.925);
const COL_ROW_LINE = rgb(0.89, 0.902, 0.878);
const COL_MUTED = rgb(0.333, 0.333, 0.333);
const COL_TEXT = rgb(0.067, 0.067, 0.067);
const COL_AMBER_BG = rgb(0.996, 0.976, 0.902);
const COL_AMBER_TX = rgb(0.545, 0.4, 0.05);

/** The font bundle the worker embeds before calling in. */
export interface RenderFonts {
  base: PDFFont;
  bold: PDFFont;
  /** null on the pure-WinAnsi path (nothing embedded). */
  deva: PDFFont | null;
}

export interface RenderReport {
  pages: number;
  lines: number;
  truncated: boolean;
  fontPath: "standard" | "devanagari";
}

/* ------------------------------------------------------------------ */
/* Split-run text (mixed EN + हिंदी in one string)                      */
/* ------------------------------------------------------------------ */

export interface TextRun {
  text: string;
  /** true → must be drawn with the Devanagari face. */
  deva: boolean;
}

export function splitTextRuns(s: string): TextRun[] {
  const runs: TextRun[] = [];
  let cur = "";
  let curDeva = false;
  let started = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const deva = !isWinAnsiChar(code) && needsNotoChar(code);
    if (!started) {
      cur = ch;
      curDeva = deva;
      started = true;
    } else if (deva === curDeva) {
      cur += ch;
    } else {
      runs.push({ text: cur, deva: curDeva });
      cur = ch;
      curDeva = deva;
    }
  }
  if (started) runs.push({ text: cur, deva: curDeva });
  return runs;
}

/** Chars Helvetica cannot encode are honestly downgraded to "?" — this
 *  keeps the standard-font encodeText from ever throwing. */
function baseRunSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    out += isWinAnsiChar(ch.codePointAt(0) ?? 0) ? ch : "?";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sheet painter                                                        */
/* ------------------------------------------------------------------ */

interface TextOpts {
  bold?: boolean;
  color?: RGB;
  right?: number;
  center?: [number, number];
}

class Sheet {
  readonly doc: PDFDocument;
  readonly fonts: RenderFonts;
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly bottom: number;
  page: PDFPage;
  y: number;

  constructor(doc: PDFDocument, fonts: RenderFonts, pageW: number, pageH: number) {
    this.doc = doc;
    this.fonts = fonts;
    this.pageW = pageW;
    this.pageH = pageH;
    this.margin = GEO.margin;
    this.bottom = GEO.margin + GEO.footerReserve;
    this.page = doc.addPage([pageW, pageH]);
    this.y = pageH - this.margin;
  }

  newPage(): void {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.y = this.pageH - this.margin;
  }

  ensure(need: number): void {
    if (this.y - need < this.bottom) this.newPage();
  }

  private fontFor(run: TextRun, bold: boolean): PDFFont {
    if (run.deva && this.fonts.deva) return this.fonts.deva;
    return bold ? this.fonts.bold : this.fonts.base;
  }

  private runText(run: TextRun): string {
    if (run.deva && this.fonts.deva) return run.text;
    return baseRunSafe(run.text);
  }

  /** measure + draw share this exact per-run decomposition. */
  measure(text: string, size: number, bold = false): number {
    let w = 0;
    for (const run of splitTextRuns(text)) {
      w += this.fontFor(run, bold).widthOfTextAtSize(this.runText(run), size);
    }
    return w;
  }

  // size MUST be annotated `: number` — GEO.fs is an as-const literal, and
  // a defaulted parameter would otherwise infer the non-widening type 9
  // (every caller passing 8 / 11.25 / a plain number then fails TS2345).
  text(s: string, x: number, yTop: number, size: number = GEO.fs, opts: TextOpts = {}): void {
    if (!s) return;
    const runs = splitTextRuns(s);
    const color = opts.color ?? COL_TEXT;
    let width = 0;
    for (const run of runs) {
      width += this.fontFor(run, opts.bold === true).widthOfTextAtSize(this.runText(run), size);
    }
    let tx = x;
    if (opts.right !== undefined) tx = opts.right - width;
    if (opts.center) {
      const [l, r] = opts.center;
      tx = (l + r - width) / 2;
    }
    const baseline = yTop - size;
    for (const run of runs) {
      const text = this.runText(run);
      const font = this.fontFor(run, opts.bold === true);
      this.page.drawText(text, { x: tx, y: baseline, size, font, color });
      tx += font.widthOfTextAtSize(text, size);
    }
  }

  line(x1: number, y: number, x2: number, color: RGB, width: number): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: width, color });
  }
}

/* ------------------------------------------------------------------ */
/* Section painters (replay the model's planned heights exactly)        */
/* ------------------------------------------------------------------ */

interface Ctx {
  sheet: Sheet;
  labels: InvoiceLabelMap;
  right: number;
  contentW: number;
  measure: MeasureFn;
}

function labelOf(labels: InvoiceLabelMap, key: string, fallback = ""): string {
  return labels[key] ?? fallback;
}

function drawHeader(c: Ctx, plan: HeaderPlan, pageW: number): void {
  const { sheet } = c;
  const M = sheet.margin;
  const startY = sheet.y;
  let yL = startY - 2;
  for (const s of plan.left) {
    sheet.text(s.text, M, yL, s.size, {
      bold: s.bold === true,
      color: s.muted === true ? COL_MUTED : COL_TEXT,
    });
    yL -= s.h;
  }
  let yR = startY - 2;
  // title (right-aligned, accent) — the size the planner settled on
  let titleSize = GEO.fsTitle;
  const maxTitleW = c.contentW * 0.45;
  while (titleSize > GEO.fs && c.measure(plan.title, titleSize, true) > maxTitleW) {
    titleSize -= 1;
  }
  sheet.text(plan.title, 0, yR, titleSize, {
    bold: true,
    color: COL_ACCENT,
    right: c.right,
  });
  yR -= titleSize + 4;
  for (const row of plan.right) {
    const valueW = c.measure(row.value, GEO.fs, row.valueBold === true);
    sheet.text(row.label, 0, yR, GEO.fs, { right: c.right - valueW - 3 });
    sheet.text(row.value, 0, yR, GEO.fs, {
      right: c.right,
      bold: row.valueBold === true,
    });
    yR -= GEO.lh;
  }
  sheet.y = startY - plan.height;
  sheet.line(M, sheet.y + 2, pageW - M, COL_ACCENT, 1.125);
  sheet.y -= GEO.headerGap;
}

function drawBuyer(c: Ctx, plan: BuyerPlan): void {
  const { sheet } = c;
  const M = sheet.margin;
  const startY = sheet.y;
  let yL = startY - 2;
  for (const s of plan.left) {
    sheet.text(s.text, M, yL, s.size, {
      bold: s.bold === true,
      color: s.muted === true ? COL_MUTED : COL_TEXT,
    });
    yL -= s.h;
  }
  let yR = startY - 2;
  for (const row of plan.right) {
    const valueW = c.measure(row.value, GEO.fs);
    sheet.text(row.label, 0, yR, GEO.fs, { right: c.right - valueW - 3, color: COL_MUTED });
    sheet.text(row.value, 0, yR, GEO.fs, { right: c.right });
    yR -= GEO.lh;
  }
  sheet.y = startY - plan.height;
}

/** Centered split-run text on an arbitrary page (the footer stamp). */
function drawCentered(
  page: PDFPage,
  pageW: number,
  text: string,
  y: number,
  size: number,
  fonts: RenderFonts,
  color: RGB
): void {
  const runs = splitTextRuns(text);
  let width = 0;
  for (const run of runs) {
    const safe = run.deva && fonts.deva ? run.text : baseRunSafe(run.text);
    const font = run.deva && fonts.deva ? fonts.deva : fonts.base;
    width += font.widthOfTextAtSize(safe, size);
  }
  let x = (pageW - width) / 2;
  for (const run of runs) {
    const safe = run.deva && fonts.deva ? run.text : baseRunSafe(run.text);
    const font = run.deva && fonts.deva ? fonts.deva : fonts.base;
    page.drawText(safe, { x, y, size, font, color });
    x += font.widthOfTextAtSize(safe, size);
  }
}

function colX(cols: TableCols, pageLeft: number): number[] {
  const xs = [pageLeft, pageLeft + cols.no];
  xs.push(xs[1] + cols.item);
  xs.push(xs[2] + cols.qty);
  if (cols.showTax) xs.push(xs[3] + cols.tax);
  return xs;
}

function drawTableHeader(c: Ctx, cols: TableCols): void {
  const { sheet } = c;
  const M = sheet.margin;
  const h = GEO.tableHeaderH;
  const labels = c.labels;
  sheet.page.drawRectangle({
    x: M,
    y: sheet.y - h,
    width: c.contentW,
    height: h,
    color: COL_HEADER_BG,
  });
  const xs = colX(cols, M);
  const cells: [string, number, number, "l" | "r"][] = [
    [labelOf(labels, "colNo", "#"), xs[0] ?? 0, cols.no, "l"],
    [labelOf(labels, "colItem", "Item"), xs[1] ?? 0, cols.item, "l"],
    [labelOf(labels, "colQty", "Qty"), xs[2] ?? 0, cols.qty, "r"],
  ];
  if (cols.showTax) {
    cells.push([labelOf(labels, "colTax", "Tax"), xs[3] ?? 0, cols.tax, "r"]);
    cells.push([
      labelOf(labels, "colAmount", "Amount"),
      xs[4] ?? 0,
      cols.amount,
      "r",
    ]);
  } else {
    cells.push([
      labelOf(labels, "colAmount", "Amount"),
      xs[3] ?? 0,
      cols.amount,
      "r",
    ]);
  }
  for (const [text, x, w, align] of cells) {
    sheet.text(text, x + GEO.pad, sheet.y - GEO.pad, GEO.fs, {
      bold: true,
      right: align === "r" ? x + w - GEO.pad : undefined,
    });
  }
  sheet.line(M, sheet.y - h, M + c.contentW, COL_ACCENT, 1.125);
  sheet.y -= h;
}

function drawRow(c: Ctx, row: PlannedRow, cols: TableCols): void {
  const { sheet } = c;
  const M = sheet.margin;
  const xs = colX(cols, M);
  const itemX = (xs[1] ?? 0) + GEO.pad;
  const rowTop = sheet.y;
  let ly = rowTop - GEO.pad;
  for (const nl of row.nameLines) {
    sheet.text(nl, itemX, ly, GEO.fs);
    ly -= GEO.lh;
  }
  for (const sl of row.subLines) {
    sheet.text(sl, itemX, ly, GEO.fs, { color: COL_MUTED });
    ly -= GEO.lh;
  }
  sheet.text(String(row.no), (xs[0] ?? 0) + GEO.pad, rowTop - GEO.pad, GEO.fs, {
    color: COL_MUTED,
  });
  sheet.text(row.qty, 0, rowTop - GEO.pad, GEO.fs, {
    right: (xs[2] ?? 0) - GEO.pad,
  });
  if (cols.showTax) {
    sheet.text(row.tax, 0, rowTop - GEO.pad, GEO.fs, {
      right: (xs[3] ?? 0) - GEO.pad,
      color: COL_MUTED,
    });
    sheet.text(row.amount, 0, rowTop - GEO.pad, GEO.fs, {
      right: c.right - GEO.pad,
    });
  } else {
    sheet.text(row.amount, 0, rowTop - GEO.pad, GEO.fs, {
      right: c.right - GEO.pad,
    });
  }
  sheet.line(M, rowTop - row.height, c.right, COL_ROW_LINE, 0.75);
  sheet.y = rowTop - row.height;
}

interface TotalsRow {
  label: string;
  value: string;
  strong?: boolean;
}

function buildTotalsRows(inv: ParsedInvoice, labels: InvoiceLabelMap): TotalsRow[] {
  const l = (key: string, fallback = ""): string => labelOf(labels, key, fallback);
  const t = inv.totals;
  const cur = inv.meta.currency;
  const rows: TotalsRow[] = [];
  if (t.lineTotal !== null) rows.push({ label: l("sub", "Subtotal"), value: currencyFmt(t.lineTotal, cur) });
  if (t.chargeTotal !== null && t.chargeTotal !== 0) {
    rows.push({ label: l("charges", "Charges"), value: currencyFmt(t.chargeTotal, cur) });
  }
  if (t.allowanceTotal !== null && t.allowanceTotal !== 0) {
    rows.push({ label: l("allowances", "Allowances"), value: currencyFmt(t.allowanceTotal, cur) });
  }
  if (t.taxBasisTotal !== null) {
    rows.push({ label: l("taxBasis", "Taxable value"), value: currencyFmt(t.taxBasisTotal, cur) });
  }
  for (const tax of inv.taxes) {
    const rate = formatRate(tax.rate);
    const cat = tax.category !== "" ? " (" + tax.category + ")" : "";
    rows.push({
      label: l("tax", "Tax") + (rate !== "" ? " " + rate : "") + cat,
      value: currencyFmt(tax.amount, cur),
    });
  }
  if (t.taxTotal !== null) {
    rows.push({ label: l("taxTotal", "Total tax"), value: currencyFmt(t.taxTotal, cur) });
  }
  if (t.grandTotal !== null) {
    rows.push({ label: l("total", "Total"), value: currencyFmt(t.grandTotal, cur), strong: true });
  }
  if (t.prepaid !== null && t.prepaid !== 0) {
    rows.push({
      label: l("paid", "Paid"),
      value: "-" + currencyFmt(t.prepaid, cur),
    });
  }
  if (t.duePayable !== null) {
    rows.push({ label: l("due", "Amount due"), value: currencyFmt(t.duePayable, cur), strong: true });
  }
  return rows;
}

function drawTotals(c: Ctx, rows: TotalsRow[]): void {
  const { sheet } = c;
  const height = rows.reduce((acc, r) => acc + (r.strong ? 21 : 17.1), 0) + 12;
  sheet.ensure(height);
  let y = sheet.y - 9;
  const labelRight = c.right - 96;
  for (const row of rows) {
    const h = row.strong ? 21 : 17.1;
    y -= h;
    sheet.text(row.label, 0, y + 2, row.strong ? GEO.fsBig : GEO.fs, {
      right: labelRight,
      bold: row.strong === true,
    });
    sheet.text(row.value, 0, y + 2, row.strong ? GEO.fsBig : GEO.fs, {
      right: c.right,
      bold: row.strong === true,
    });
    if (row.strong) {
      sheet.line(c.right - GEO.totalsW, y + h, c.right, COL_ACCENT, 1.125);
    }
  }
  sheet.y = y - 4;
}

function drawPayment(c: Ctx, inv: ParsedInvoice): void {
  const { sheet } = c;
  const p = inv.payment;
  const l = (key: string, fallback = ""): string => labelOf(c.labels, key, fallback);
  const lines: string[] = [];
  if (p.reference !== "") lines.push(l("payRef", "Payment reference") + ": " + p.reference);
  const means = paymentMeansLabel(p.meansCode);
  if (means !== "") lines.push(l("means", "Method") + ": " + means);
  if (p.iban !== "") lines.push(l("iban", "IBAN") + ": " + p.iban);
  if (p.accountName !== "") lines.push(l("account", "Account") + ": " + p.accountName);
  if (p.bic !== "") lines.push(l("bic", "BIC") + ": " + p.bic);
  if (lines.length === 0) return;
  const title = l("payment", "Payment");
  sheet.ensure((title ? 1 : 0) * GEO.lh + lines.length * GEO.lh + 10);
  let y = sheet.y - 8;
  if (title) {
    sheet.text(title, sheet.margin, y - 2, GEO.fs, { color: COL_MUTED });
    y -= GEO.lh;
  }
  for (const line of lines) {
    sheet.text(line, sheet.margin, y - 2, GEO.fs);
    y -= GEO.lh;
  }
  sheet.y = y - 2;
}

/** Notes render as small muted footer text ONLY (honest scope). */
function drawNotes(c: Ctx, inv: ParsedInvoice): void {
  const { sheet } = c;
  if (inv.meta.notes.length === 0) return;
  const title = labelOf(c.labels, "notes", "Notes");
  const joined = sanitizeText(inv.meta.notes.join("  ·  "), MAX_NOTE_CHARS);
  const lines = wrapText(joined, c.contentW, GEO.fsSmall, c.measure, 10);
  sheet.ensure((title ? 1 : 0) * GEO.lhSmall + lines.length * GEO.lhSmall + 10);
  let y = sheet.y - 8;
  if (title) {
    sheet.text(title, sheet.margin, y - 2, GEO.fsSmall, { color: COL_MUTED });
    y -= GEO.lhSmall;
  }
  for (const line of lines) {
    sheet.text(line, sheet.margin, y - 2, GEO.fsSmall, { color: COL_MUTED });
    y -= GEO.lhSmall;
  }
  sheet.y = y - 2;
}

function drawTruncationNote(c: Ctx, plan: RowsPlan, inv: ParsedInvoice): void {
  if (!(plan.truncated || inv.truncated)) return;
  const { sheet } = c;
  const l = (key: string, fallback = ""): string => labelOf(c.labels, key, fallback);
  const text =
    l("truncA", "Showing") +
    " " +
    plan.shown +
    " " +
    l("truncOf", "of") +
    " " +
    Math.max(plan.total, inv.totalLineCount) +
    " " +
    l("truncC", "line items — the rest were omitted.");
  const lines = wrapText(text, c.contentW - 16, GEO.fs, c.measure, 3);
  const h = lines.length * GEO.lh + 12;
  sheet.ensure(h + 6);
  const top = sheet.y - 6;
  sheet.page.drawRectangle({
    x: sheet.margin,
    y: top - h,
    width: c.contentW,
    height: h,
    color: COL_AMBER_BG,
  });
  let y = top - 6;
  for (const line of lines) {
    sheet.text(line, sheet.margin + 8, y, GEO.fs, { color: COL_AMBER_TX });
    y -= GEO.lh;
  }
  sheet.y = top - h - 4;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Paint the invoice into `doc` (pages added as needed). Fonts must already
 * be chosen: pure-WinAnsi content passes deva: null (base-14 only); any
 * Devanagari (or ₹) must come with the embedded Noto subset.
 */
export function drawParsedInvoice(
  doc: PDFDocument,
  fonts: RenderFonts,
  inv: ParsedInvoice,
  opts: RenderOptions
): RenderReport {
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize];
  const sheet = new Sheet(doc, fonts, pageW, pageH);
  const right = pageW - GEO.margin;
  const contentW = pageW - 2 * GEO.margin;
  const labels = opts.labels;
  const measure = (text: string, size: number, bold = false): number =>
    sheet.measure(text, size, bold);
  const c: Ctx = { sheet, labels, right, contentW, measure };

  // ---- page 1: header + buyer -------------------------------------
  const headerPlan = planHeader(inv, labels, contentW, measure);
  drawHeader(c, headerPlan, pageW);
  const buyerPlan = planBuyer(inv, labels, contentW, measure);
  drawBuyer(c, buyerPlan);

  // ---- items table (model owns the page breaks) -------------------
  const contentH = pageH - 2 * GEO.margin - GEO.footerReserve;
  const firstAvail = Math.max(
    GEO.tableHeaderH,
    contentH - headerPlan.height - GEO.headerGap - buyerPlan.height - GEO.tableHeaderH
  );
  const contAvail = Math.max(
    GEO.tableHeaderH,
    contentH - headerPlan.height - GEO.headerGap - GEO.tableHeaderH
  );
  const plan = computeRows(inv.lines, {
    contentW,
    measure,
    currency: inv.meta.currency,
    firstAvail,
    contAvail,
    rowCap: MAX_LINES,
  });

  if (plan.pages.length === 0) {
    drawTableHeader(c, plan.cols);
    sheet.text(labelOf(labels, "noItems", "(no line items)"), GEO.margin + GEO.pad, sheet.y - GEO.pad, GEO.fs, {
      color: COL_MUTED,
    });
    sheet.y -= GEO.tableHeaderH;
  } else {
    plan.pages.forEach((rows, pageIndex) => {
      if (pageIndex > 0) {
        sheet.newPage();
        drawHeader(c, headerPlan, pageW);
      }
      drawTableHeader(c, plan.cols);
      for (const row of rows) drawRow(c, row, plan.cols);
    });
  }

  // ---- totals + payment + notes: LAST page only --------------------
  const totalsRows = buildTotalsRows(inv, labels);
  if (totalsRows.length > 0) drawTotals(c, totalsRows);
  drawPayment(c, inv);
  drawNotes(c, inv);
  drawTruncationNote(c, plan, inv);

  // ---- page footers ("Page N / M") ---------------------------------
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const text = labelOf(labels, "page", "Page") + " " + (i + 1) + " / " + total;
    drawCentered(page, pageW, text, GEO.margin / 2 + 2, GEO.fsSmall, fonts, COL_MUTED);
  });

  // ---- document metadata -------------------------------------------
  doc.setProducer("DocoPDF");
  doc.setCreator("DocoPDF");
  doc.setTitle(
    sanitizeText(
      (inv.meta.number !== "" ? "Invoice " + inv.meta.number : labelOf(labels, "ttl", "Invoice")),
      120
    )
  );
  if (inv.seller.name !== "") doc.setAuthor(sanitizeText(inv.seller.name, 120));
  doc.setCreationDate(new Date());

  return {
    pages: doc.getPageCount(),
    lines: plan.shown,
    truncated: plan.truncated || inv.truncated,
    fontPath: fonts.deva !== null ? "devanagari" : "standard",
  };
}
