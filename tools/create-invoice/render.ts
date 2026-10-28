/**
 * Create invoice PDF renderer (P3-INVOICE) — the vector sheet painter.
 *
 * Extracted from worker.ts so the smoke script (and any future surface
 * re-use) can drive the EXACT drawing code in bun: same geometry, same
 * section renderers, same pagination. The worker owns fonts + protocol;
 * this file owns every point of ink.
 *
 * Geometry is the standalone app's sheet CSS translated 1:1 from CSS px
 * (@96 dpi → pt ×0.75) and mm (×72/25.4): 12 px body = 9 pt, 1.4 line
 * height, 24 px title = 18 pt, 6 px cell padding = 4.5 pt, 270 px
 * totals block = 202.5 pt, margins 14 mm. What you preview is what
 * prints.
 */

import type {
  CreateContext,
  CreateImage,
  CreatePage,
  StampTtfFont,
} from "@/lib/own/pdf";
import { create as ownQrCreate } from "@/lib/own/qr";

import {
  calc,
  fd,
  formatMoney,
  Q,
  typeDef,
  upiPayload,
  words,
  type InvoiceCalc,
  type InvoiceRun,
} from "./model";
import {
  CURRENCY_SYMBOLS,
  currencyLocale,
  gstStateName,
} from "./types";

/* ------------------------------------------------------------------ */
/* Geometry (CSS px @96 dpi → pt ×0.75; mm → pt ×72/25.4)              */
/* ------------------------------------------------------------------ */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = (14 * 72) / 25.4; // 14 mm margins
const RIGHT = PAGE_W - M;
const CW = PAGE_W - 2 * M;

const FS = 9; // 12 px body
const LH = 12.6; // 1.4 line height
const FS_BIG = 11.25; // 15 px (business name / total row)
const FS_TITLE = 18; // 24 px sheet title
const FS_STAMP = 16.5; // 22 px stamp
const PAD = 4.5; // 6 px cell padding
const TT_W = 202.5; // 270 px totals block
const LOGO_MAX_W = 135; // 180 px
const LOGO_MAX_H = 42; // 56 px
const SIG_MAX_W = 135;
const SIG_MAX_H = 36; // 48 px
const SIG_LINE_W = 127.5; // 170 px
const QR_BOX = 80; // 96 px + quiet zone, vector

const COL_HEADER_BG = rgb(0.933, 0.949, 0.925); // #eef2ec
const COL_ROW_LINE = rgb(0.89, 0.902, 0.878); // #e3e6e0
const COL_MUTED = rgb(0.333, 0.333, 0.333); // #555
const COL_TEXT = rgb(0.067, 0.067, 0.067); // #111

/** 0..1 RGB — the pdf-lib color shape, kept so every annotation stands. */
function rgb(r: number, g: number, b: number): { r: number; g: number; b: number } {
  return { r, g, b };
}

function hexColor(s: string) {
  const n = Number.parseInt(s.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || comma < 0) return null;
  try {
    const b64 = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(b64.length);
    for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sheet renderer                                                      */
/* ------------------------------------------------------------------ */

class Sheet {
  readonly doc: CreateContext;
  readonly font: StampTtfFont;
  readonly ac: ReturnType<typeof hexColor>;
  readonly labels: Record<string, string>;
  /** Page handles in creation order (the stamp draws on the FIRST). */
  readonly pages: CreatePage[] = [];
  page: CreatePage;
  /** y cursor — NEXT baseline top (PDF y grows up, we walk down). */
  y = PAGE_H - M;

  constructor(
    doc: CreateContext,
    font: StampTtfFont,
    accentHex: string,
    labels: Record<string, string>
  ) {
    this.doc = doc;
    this.font = font;
    this.ac = hexColor(accentHex);
    this.labels = labels;
    this.page = doc.addPage(PAGE_W, PAGE_H);
    this.pages.push(this.page);
  }

  /** The page the rotated stamp lands on (pdf-lib's doc.getPage(0)). */
  get firstPage(): CreatePage {
    return this.pages[0]!;
  }

  l(key: string): string {
    return this.labels[key] ?? "";
  }

  newPage(): void {
    this.page = this.doc.addPage(PAGE_W, PAGE_H);
    this.pages.push(this.page);
    this.y = PAGE_H - M;
  }

  /** Start a new page unless `need` points fit above the margin. */
  ensure(need: number): void {
    if (this.y - need < M) this.newPage();
  }

  w(text: string, size: number): number {
    return this.font.measure(text, size);
  }

  /** Word-wrap honouring explicit \n lines; never returns []. */
  wrap(text: string, width: number, size: number): string[] {
    const out: string[] = [];
    for (const para of String(text ?? "").split("\n")) {
      if (para === "") {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? line + " " + word : word;
        if (this.w(next, size) <= width || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out.length ? out : [""];
  }

  text(
    s: string,
    x: number,
    yTop: number,
    size = FS,
    opts: {
      color?: ReturnType<typeof rgb>;
      bold?: boolean;
      right?: number;
      center?: [number, number];
    } = {}
  ): void {
    if (!s) return;
    const color = opts.color ?? COL_TEXT;
    let tx = x;
    if (opts.right !== undefined) tx = opts.right - this.w(s, size);
    if (opts.center) {
      const [l, r] = opts.center;
      tx = (l + r - this.w(s, size)) / 2;
    }
    const baseline = yTop - size; // top-aligned like the DOM
    this.page.drawText({
      x: tx,
      y: baseline,
      text: s,
      size,
      color,
      ttf: this.font,
    });
    if (opts.bold) {
      this.page.drawText({
        x: tx + 0.3,
        y: baseline - 0.3,
        text: s,
        size,
        color,
        ttf: this.font,
      });
    }
  }

  line(
    x1: number,
    y: number,
    x2: number,
    color: ReturnType<typeof rgb>,
    width: number
  ): void {
    this.page.drawLine({
      start: { x: x1, y },
      end: { x: x2, y },
      thickness: width,
      color,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Section renderers (one per draggable block)                          */
/* ------------------------------------------------------------------ */

interface RenderDeps {
  sheet: Sheet;
  run: InvoiceRun;
  c: InvoiceCalc;
  money: (p: number) => string; // symbol + nbsp + formatted
  fmt: (p: number) => string;
}

async function renderHeader(d: RenderDeps): Promise<void> {
  const { sheet, run, c } = d;
  const s = run.s;
  const b = s.biz;
  const leftW = 300;
  const rightX = RIGHT - 190;
  let yLeft = sheet.y;
  let yRight = sheet.y;

  // Left: logo + business identity
  if (b.logo) {
    const bytes = dataUrlBytes(b.logo);
    if (bytes) {
      try {
        // SYNC on our engine — the old pdf-lib await trap (un-awaited
        // embed → NaN geometry → logos silently skipped) is gone by
        // construction.
        const img: CreateImage = sheet.doc.embedPng(bytes);
        const k = Math.min(
          LOGO_MAX_W / img.width,
          LOGO_MAX_H / img.height,
          1
        );
        const w = img.width * k;
        const h = img.height * k;
        sheet.page.drawImage(img, {
          x: M,
          y: yLeft - h,
          width: w,
          height: h,
        });
        yLeft -= h + 4.5;
      } catch {
        /* a broken logo never kills the export */
      }
    }
  }
  if (b.name) {
    sheet.text(b.name, M, yLeft - 3, FS_BIG, { bold: true });
    yLeft -= FS_BIG + 2;
  }
  const muted: string[] = [];
  if (b.addr) muted.push(...String(b.addr).split("\n"));
  if (b.phone) muted.push(b.phone);
  if (b.email) muted.push(b.email);
  if (c.g && b.gstin) muted.push("GSTIN: " + b.gstin);
  if (c.g && b.state)
    muted.push(
      gstStateName(b.state) + " (" + b.state + ")"
    );
  for (const m of muted) {
    sheet.text(m, M, yLeft - 2, FS, { color: COL_MUTED });
    yLeft -= LH;
  }

  // Right: title + invoice number + dates + extra fields
  const title = sheet.l("ttl");
  if (title) {
    sheet.text(title, rightX + 190, yRight, FS_TITLE, {
      bold: true,
      color: sheet.ac,
      right: RIGHT,
    });
    yRight += 4;
  }
  yRight -= FS_TITLE + 4;
  if (s.no) {
    sheet.text(sheet.l("no") + ": ", rightX, yRight, FS, { right: RIGHT - sheet.w(s.no, FS) - 1 });
    sheet.text(s.no, rightX, yRight, FS, { bold: true, right: RIGHT });
    yRight -= LH;
  }
  if (s.date) {
    sheet.text(sheet.l("date") + ": " + fd(s.date), rightX, yRight, FS, {
      right: RIGHT,
    });
    yRight -= LH;
  }
  const dateLabel =
    typeDef(s.ty).dt === "valid" ? sheet.l("valid") : sheet.l("due");
  const dateVal = typeDef(s.ty).dt === "valid" ? s.valid : s.due;
  if (typeDef(s.ty).dt !== "none" && dateVal) {
    sheet.text(dateLabel + ": " + fd(dateVal), rightX, yRight, FS, {
      right: RIGHT,
    });
    yRight -= LH;
  }
  for (let i = 0; i < 3; i++) {
    const label = sheet.l("x" + i);
    if (label && s.xv[i]) {
      sheet.text(label + ": " + s.xv[i], rightX, yRight, FS, {
        right: RIGHT,
      });
      yRight -= LH;
    }
  }

  sheet.y = Math.min(yLeft, yRight) - 12; // margin-bottom 16 px
}

function renderBillTo(d: RenderDeps): void {
  const { sheet, run, c } = d;
  const s = run.s;
  const cl = s.cli;
  let y = sheet.y;
  const label = sheet.l("bt");
  if (label) {
    sheet.text(label, M, y - 2, FS, { color: COL_MUTED });
    y -= LH;
  }
  if (cl.name) {
    sheet.text(cl.name, M, y - 2, FS, { bold: true });
    y -= LH;
  }
  if (cl.addr) {
    for (const m of String(cl.addr).split("\n")) {
      sheet.text(m, M, y - 2, FS);
      y -= LH;
    }
  }
  if (c.g && cl.gstin) {
    sheet.text("GSTIN: " + cl.gstin, M, y - 2, FS);
    y -= LH;
  }
  if (c.g && s.pos) {
    sheet.text(
      sheet.l("pos") + ": " + gstStateName(s.pos) + " (" + s.pos + ")",
      M,
      y - 2,
      FS
    );
    y -= LH;
  }
  sheet.y = y - 10.5; // margin-bottom 14 px
}

/** Items table — paginates row by row, header row repeated per page. */
function renderItems(d: RenderDeps): void {
  const { sheet, run, c } = d;
  const s = run.s;
  const def = typeDef(s.ty);

  // Column plan (pt): # | desc | hsn? | qty | rate? dp? | taxable? gst%? | amount?
  // The per-item discount % column appears ONLY when some line actually
  // carries one (keeps classic invoices pixel-identical).
  const cols: { key: string; w: number; align: "l" | "r" }[] = [
    { key: "#", w: 20, align: "l" },
  ];
  let fixed = 20;
  if (c.g) {
    fixed += 54;
    cols.push({ key: "hsn", w: 54, align: "l" });
  }
  fixed += 50;
  cols.push({ key: "qty", w: 50, align: "r" });
  if (!c.np) {
    fixed += 62;
    cols.push({ key: "rate", w: 62, align: "r" });
    if (c.L.some((l) => Q(l.dp) > 0)) {
      fixed += 34;
      cols.push({ key: "dp", w: 34, align: "r" });
    }
    if (c.g && !c.nt) {
      fixed += 60 + 34;
      cols.push({ key: "tb", w: 60, align: "r" });
      cols.push({ key: "gp", w: 34, align: "r" });
    } else {
      fixed += 62;
      cols.push({ key: "amt", w: 62, align: "r" });
    }
  }
  const descW = CW - fixed;
  cols.splice(1, 0, { key: "desc", w: descW, align: "l" });

  const colX = (i: number): number => {
    let x = M;
    for (let k = 0; k < i; k++) x += cols[k].w;
    return x;
  };
  const colRight = (i: number): number => colX(i) + cols[i].w - PAD;

  const drawHeaderRow = (): number => {
    const h = PAD * 2 + LH;
    sheet.page.drawRectangle({
      x: M,
      y: sheet.y - h,
      width: CW,
      height: h,
      color: COL_HEADER_BG,
    });
    cols.forEach((col, i) => {
      const label =
        col.key === "#"
          ? "#"
          : sheet.l(col.key === "desc" ? "desc" : col.key);
      sheet.text(label, colX(i) + PAD, sheet.y - PAD, FS, {
        bold: true,
        right: col.align === "r" ? colRight(i) : undefined,
      });
    });
    sheet.line(M, sheet.y - h, M + CW, sheet.ac, 1.125);
    sheet.y -= h;
    return h;
  };

  drawHeaderRow();

  for (const l of c.L) {
    const descLines = sheet.wrap(l.d || " ", descW - 2 * PAD, FS);
    const h = Math.max(1, descLines.length) * LH + PAD * 2;
    if (sheet.y - h < M) {
      sheet.newPage();
      drawHeaderRow();
    }
    const rowTop = sheet.y;
    let ci = 0;
    for (const col of cols) {
      const i = ci++;
      let val = "";
      if (col.key === "#") val = String(c.L.indexOf(l) + 1);
      else if (col.key === "desc") val = "";
      else if (col.key === "hsn") val = l.h;
      else if (col.key === "qty") val = String(l.q);
      else if (col.key === "rate") val = d.fmt(Math.round(Q(l.r) * 100));
      else if (col.key === "dp")
        val = Q(l.dp) > 0 ? `${String(l.dp).trim()}%` : "";
      else if (col.key === "tb") val = d.fmt(l.tb);
      else if (col.key === "gp") val = l.rt + "%";
      else if (col.key === "amt") val = d.fmt(l.net);
      if (val && col.key !== "desc") {
        sheet.text(String(val), colX(i) + PAD, rowTop - PAD, FS, {
          right: col.align === "r" ? colRight(i) : undefined,
        });
      }
    }
    if (col_descVisible(cols)) {
      descLines.forEach((tx, li) => {
        sheet.text(tx, colX(1) + PAD, rowTop - PAD - li * LH, FS);
      });
    }
    sheet.line(M, rowTop - h, M + CW, COL_ROW_LINE, 0.75);
    sheet.y = rowTop - h;
  }
  sheet.y -= 4;
}

function col_descVisible(cols: { key: string }[]): boolean {
  return cols.some((c) => c.key === "desc");
}

function renderTotals(d: RenderDeps): void {
  const { sheet, run, c } = d;
  const s = run.s;
  type Row = [string, string, boolean?];
  const rows: Row[] = [];
  rows.push([sheet.l("sub"), d.money(c.sub)]);
  if (c.idisc)
    rows.push([sheet.l("idisc"), "− " + d.money(c.idisc)]);
  if (c.disc) rows.push([sheet.l("disc2"), "− " + d.money(c.disc)]);
  if (!c.np) {
    if (c.g && !c.nt) {
      rows.push([sheet.l("tb"), d.money(c.tb)]);
      if (c.intra) {
        rows.push([sheet.l("cg"), d.money(c.cg)]);
        rows.push([sheet.l("sg"), d.money(c.sg)]);
      } else {
        rows.push([sheet.l("ig"), d.money(c.ig)]);
      }
    } else if (c.tx) {
      rows.push([
        sheet.l("tx") + " (" + (parseFloat(s.tr) || 0) + "%)",
        d.money(c.tx),
      ]);
    }
    if (c.ro) {
      rows.push([
        sheet.l("rof"),
        (c.ro < 0 ? "− " : "") + d.money(Math.abs(c.ro)),
      ]);
    }
  }
  rows.push([sheet.l("tot"), d.money(c.tot), true]);
  if (c.adv) {
    rows.push([sheet.l("adv"), "− " + d.money(c.adv)]);
    rows.push([sheet.l("bal"), d.money(c.bal), true]);
  }

  sheet.ensure(rows.length * 17.1 + 12);
  let y = sheet.y - 9; // margin 12 px
  const labelRight = RIGHT - 90;
  for (const [label, value, isTotal] of rows) {
    const h = isTotal ? 21 : 17.1;
    y -= h;
    sheet.text(label, M, y + 2, isTotal ? FS_BIG : FS, {
      right: labelRight,
      bold: isTotal,
    });
    sheet.text(value, RIGHT - PAD, y + 2, isTotal ? FS_BIG : FS, {
      right: RIGHT,
      bold: isTotal,
    });
    if (isTotal) {
      sheet.line(
        RIGHT - TT_W,
        y + h,
        RIGHT,
        sheet.ac,
        1.125
      );
    }
  }
  sheet.y = y - 4;
}

function renderWords(d: RenderDeps): void {
  const { sheet, run, c } = d;
  const label = sheet.l("wd");
  const text = words(c.tot, run.s.cur);
  const lines = sheet.wrap(
    label + ": " + text,
    CW,
    FS
  );
  sheet.ensure(lines.length * LH + 9);
  let y = sheet.y - 9;
  for (const line of lines) {
    y -= LH;
    if (line === lines[0] && label) {
      const splitAt = Math.min(
        line.length,
        label.length + 2
      );
      const head = line.slice(0, splitAt);
      const tail = line.slice(splitAt);
      sheet.text(head, M, y + 3, FS, { color: COL_MUTED });
      sheet.text(tail, M + sheet.w(head, FS), y + 3, FS, { bold: true });
    } else {
      sheet.text(line, M, y + 3, FS, { bold: true });
    }
  }
  sheet.y = y;
}

function renderBank(d: RenderDeps): void {
  const { sheet, run, c } = d;
  const s = run.s;
  const b = s.biz;
  const showQr = b.upi && s.cur === "INR" && !c.np;
  const textW = showQr ? CW - QR_BOX - 12 : CW;
  const bankLines = b.bank ? sheet.wrap(b.bank, textW, FS) : [];
  const label = sheet.l("bank");
  const h =
    (b.bank ? (label ? 1 : 0) + bankLines.length : 0) * LH +
    (b.upi && !showQr ? LH : 0) +
    10;
  sheet.ensure(Math.max(h, showQr ? QR_BOX : 0));
  let y = sheet.y - 7.5;
  if (b.bank || b.upi) {
    if (b.bank) {
      if (label) {
        sheet.text(label, M, y - 2, FS, { color: COL_MUTED });
        y -= LH;
      }
      for (const m of bankLines) {
        sheet.text(m, M, y - 2, FS);
        y -= LH;
      }
    }
    if (b.upi && !showQr) {
      sheet.text("UPI: " + b.upi, M, y - 2, FS);
      y -= LH;
    }
  }
  if (showQr) {
    drawUpiQr(d, sheet.y - 2);
  }
  sheet.y = Math.min(y, sheet.y - (showQr ? QR_BOX : 0)) - 4;
}

function drawUpiQr(d: RenderDeps, top: number): void {
  const { sheet, run, c } = d;
  const s = run.s;
  const payload = upiPayload(s.biz.upi, s.biz.name, c.bal, s.no);
  try {
    const qr = ownQrCreate(payload, { errorCorrectionLevel: "M" });
    const n = qr.size;
    const data = qr.data;
    const x0 = RIGHT - QR_BOX;
    const quiet = (QR_BOX - 72) / 2;
    const cell = 72 / n;
    sheet.page.drawRectangle({
      x: x0,
      y: top - QR_BOX,
      width: QR_BOX,
      height: QR_BOX,
      color: rgb(1, 1, 1),
      borderColor: COL_ROW_LINE,
      borderWidth: 0.5,
    });
    for (let r = 0; r < n; r++) {
      for (let cIdx = 0; cIdx < n; cIdx++) {
        if (data[r * n + cIdx]) {
          sheet.page.drawRectangle({
            x: x0 + quiet + cIdx * cell,
            y: top - quiet - (r + 1) * cell,
            width: cell + 0.02,
            height: cell + 0.02,
            color: rgb(0, 0, 0),
          });
        }
      }
    }
  } catch {
    /* a broken QR payload never kills the export */
  }
}

function renderNotes(d: RenderDeps): void {
  renderLabelBlock(d, "notes", d.run.s.notes);
}

function renderTerms(d: RenderDeps): void {
  renderLabelBlock(d, "terms", d.run.s.terms);
}

function renderLabelBlock(
  d: RenderDeps,
  labelKey: string,
  content: string
): void {
  const { sheet } = d;
  if (!content) {
    return;
  }
  const label = sheet.l(labelKey);
  const lines = sheet.wrap(content, CW, FS);
  sheet.ensure((label ? 1 : 0) * LH + lines.length * LH + 7.5);
  let y = sheet.y - 7.5;
  if (label) {
    sheet.text(label, M, y - 2, FS, { color: COL_MUTED });
    y -= LH;
  }
  for (const m of lines) {
    sheet.text(m, M, y - 2, FS);
    y -= LH;
  }
  sheet.y = y;
}

async function renderSignature(d: RenderDeps): Promise<void> {
  const { sheet, run } = d;
  const s = run.s;
  sheet.ensure(27 + 36 + 21);
  let y = sheet.y - 27; // margin-top 36 px
  const forLabel = sheet.l("for");
  const name = s.biz.name;
  const head = (forLabel ? forLabel + " " : "") + (name || "");
  if (head) {
    sheet.text(head, M, y - 2, FS, { right: RIGHT });
    if (name) {
      // bold the name part
      const nameStart = head.length - name.length;
      sheet.text(
        name,
        M + sheet.w(head.slice(0, nameStart), FS),
        y - 2,
        FS,
        { bold: true, right: RIGHT }
      );
    }
    y -= LH + 3;
  }
  if (s.biz.sig) {
    const bytes = dataUrlBytes(s.biz.sig);
    if (bytes) {
      try {
        // SYNC — see the logo note in renderHeader.
        const img: CreateImage = sheet.doc.embedPng(bytes);
        const k = Math.min(
          SIG_MAX_W / img.width,
          SIG_MAX_H / img.height,
          1
        );
        const w = img.width * k;
        const h = img.height * k;
        sheet.page.drawImage(img, {
          x: RIGHT - w,
          y: y - h,
          width: w,
          height: h,
        });
        y -= h + 3;
      } catch {
        /* broken signature never kills the export */
      }
    }
  } else {
    y -= 33; // 44 px blank signing space
  }
  sheet.line(RIGHT - SIG_LINE_W, y, RIGHT, rgb(0.067, 0.067, 0.067), 0.75);
  y -= 3;
  sheet.text(sheet.l("sig"), M, y - FS, FS, { right: RIGHT });
  sheet.y = y - FS;
}

/** The rotated PAID-style stamp, drawn on page 1 only (CSS: right 14 mm, top 34 mm). */
function renderStamp(d: RenderDeps): void {
  const { sheet, run } = d;
  if (!run.s.st) return;
  const text = run.s.st;
  const size = FS_STAMP;
  const tw = sheet.w(text, size);
  const padX = 9; // 12 px
  const padY = 4.5;
  const w = tw + padX * 2;
  const h = size + padY * 2;
  // CSS anchors the box 14 mm from the right, 34 mm from the top, rotated
  // about its centre — reproduce that centre, then derive the fixed anchor.
  const cx = PAGE_W - M - w / 2;
  const cy = PAGE_H - (34 * 72) / 25.4 - h / 2;
  const theta = (-12 * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const ax = cx - (cos * w) / 2 + (sin * h) / 2;
  const ay = cy - (sin * w) / 2 - (cos * h) / 2;
  const page = sheet.firstPage;
  page.drawRectangle({
    x: ax,
    y: ay,
    width: w,
    height: h,
    borderColor: sheet.ac,
    borderWidth: 2.25,
    rotate: -12,
    opacity: 0,
    borderOpacity: 0.55,
  });
  page.drawText({
    x: ax + padX,
    y: ay + padY,
    text,
    size,
    color: sheet.ac,
    rotate: -12,
    opacity: 0.55,
    ttf: sheet.font,
  });
}


/* ------------------------------------------------------------------ */
/* Section renderers (one per draggable block)                          */
/* ------------------------------------------------------------------ */

const SECTION_RENDERERS: Record<
  string,
  (d: RenderDeps) => void | Promise<void>
> = {
  hd: renderHeader,
  bt: renderBillTo,
  it: renderItems,
  tt: renderTotals,
  wd: renderWords,
  bank: renderBank,
  notes: renderNotes,
  terms: renderTerms,
  sig: renderSignature,
};

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Paint the whole invoice into `doc` (pages added as needed) and return
 * the computed calc (for smoke assertions). `font` must already be
 * embedded in `doc` (the worker loads the self-hosted Noto; tests read
 * it from disk).
 */
export async function drawInvoice(
  doc: CreateContext,
  font: StampTtfFont,
  run: InvoiceRun
): Promise<InvoiceCalc> {
  const c = calc(run.s);
  const sym = CURRENCY_SYMBOLS[run.s.cur];
  const loc = currencyLocale(run.s.cur);
  const deps: RenderDeps = {
    sheet: new Sheet(doc, font, run.ac, run.labels),
    run,
    c,
    fmt: (p) => formatMoney(p, run.s.cur, loc),
    money: (p) => sym + "\u00a0" + formatMoney(p, run.s.cur, loc),
  };
  for (const key of run.ord) {
    await SECTION_RENDERERS[key]?.(deps);
  }
  renderStamp(deps);
  doc.setTitle(run.s.no || "Invoice");
  if (run.s.biz.name) doc.setAuthor(run.s.biz.name);
  doc.setCreator("DocoPDF");
  doc.setCreationDate(new Date());
  return c;
}
