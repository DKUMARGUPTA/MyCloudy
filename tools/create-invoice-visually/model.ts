/**
 * Create invoice visually — pure model (RB5-a). No DOM, no storage, no
 * pdf-lib: the same helpers feed the designer preview, the honesty
 * readouts and the PDF renderer (render.ts consumes the command list
 * produced here, so the preview geometry and the PDF geometry share
 * ONE math).
 *
 *  - coordinates: canvas px @ 96 dpi on fixed A4 portrait; PDF pt =
 *    px × 72/96 (PT_PER_PX = 0.75, exact). The sheet is drawn at a CSS
 *    scale — what you drag is what prints.
 *  - snap: x/y (and resize w/h) snap to an 8 pt grid — snapped in PT
 *    space, so the PDF positions are exact multiples of 8 pt.
 *  - table math: amount = round2(qty × rate), subtotal = Σ amounts,
 *    tax = round2(subtotal × pct / 100), total = subtotal + tax. One
 *    tax % for the whole invoice — this tool is the free-layout
 *    complement to the GST-specific create-invoice, not a clone.
 *  - buildCommands: layout → pure draw commands (every text/image/
 *    rect/line with exact pt coordinates, top-left origin). render.ts
 *    only EXECUTES them; alignment and word-wrap are fully resolved
 *    here through the injected measure (defaults to approxMeasure,
 *    the create-resume Helvetica-flavoured approximation).
 *  - parseCanvasRun: the worker-boundary parser (parseResumeRun
 *    pattern) — clamp arrays, strip control chars, dedupe ids, cap
 *    every length, drop non-raster logos — so a tampered payload can
 *    never reach the renderer as a wrong type.
 *  - needsNoto: ANY drawn string outside WinAnsi (₹, हिंदी…) → the
 *    renderer must embed the self-hosted Noto Sans Devanagari subset;
 *    pure-EN documents use base-14 Helvetica with no font embedded.
 */

import {
  CANVAS_H_PX,
  CANVAS_W_PX,
  PT_PER_PX,
  PX_PER_PT,
  type CanvasAlign,
  type CanvasElement,
  type CanvasRun,
  type InvoiceCanvasDoc,
  type LogoElement,
  type TableElement,
  type TextElement,
  type TotalsElement,
  type TableRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the editor inputs and the parser)            */
/* ------------------------------------------------------------------ */

export const MAX_ELEMENTS = 40;
export const MAX_ITEMS = 30;
export const MAX_TEXT_LEN = 2000;
export const MAX_LINE_LEN = 200;
export const MAX_IMG_DATAURL = 1_500_000; // ~1.5 MB base64
export const MIN_FONT = 6;
export const MAX_FONT = 36;
export const MIN_W_PX = 40; // ~30 pt minimum element width
export const MIN_H_PX = 20;
export const MAX_TAX_PCT = 50;

/** The one grid everything snaps to (PDF points). */
export const SNAP_PT = 8;

export const CURRENCIES: readonly string[] = ["₹", "$", "€", "£", ""];

export const DEFAULT_TEXT_COLOR = "#111111";
export const MUTED_TEXT_COLOR = "#555555";
export const FOOTER_TEXT_COLOR = "#777777";
export const TABLE_HEADER_BG = "#e9ede9";
export const TABLE_BORDER = "#b9c0bb";
export const TOTALS_RULE = "#333333";

/** Line advance for multi-line text (matches the preview line-height). */
export const TEXT_LINE = 1.35;
/** First baseline sits one em below the element top (CSS-line-height
 *  1.35 + Helvetica ascent ≈ 1.0 em — preview and PDF agree here). */
export const FIRST_BASELINE = 1.0;
/** Vertical baseline placement inside table/totals rows. */
export const ROW_BASELINE = 0.35;
export const TABLE_ROW = 1.9;
export const TABLE_HEADER = 2.0;
export const TOTALS_ROW = 1.7;
export const CELL_PAD = 4;

/** Fallback labels so bare runs (smoke, drafts) render sanely. */
export const DEFAULT_LABELS: Record<string, string> = {
  desc: "Description",
  qty: "Qty",
  rate: "Rate",
  amount: "Amount",
  subtotal: "Subtotal",
  tax: "Tax",
  total: "Total",
};

const AC_RE = /^#[0-9a-fA-F]{6}$/;
/** Raster data URLs pass through; the RENDERER rejects SVG honestly
 *  (typed error → civ.errSvg) instead of silently skipping the logo. */
const DATAURL_RE = /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/;

/* ------------------------------------------------------------------ */
/* Text hygiene + ids                                                   */
/* ------------------------------------------------------------------ */

/** Strips C0/C1 controls (except \n) and caps the length. */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(0, max);
}

/** cleanText + collapses \n (single-line fields). */
export function cleanLine(v: unknown, max: number): string {
  return cleanText(String(v ?? "").replace(/\n/g, " "), max).trim();
}

let idSeq = 0;
/** Stable-enough element/row ids (time + counter; deduped at the boundary). */
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* WinAnsi / font pick (create-resume recipe, re-derived)               */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
    0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
  ]
);

/** true when every char is encodable in WinAnsi (CP1252) minus controls. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Geometry — snapping, clamping, conversions                           */
/* ------------------------------------------------------------------ */

export const pxToPt = (px: number): number => px * PT_PER_PX;
export const ptToPx = (pt: number): number => pt * PX_PER_PT;

/** Snaps a pt value to the 8 pt grid. */
export function snapPt(v: number): number {
  return Math.round(v / SNAP_PT) * SNAP_PT;
}

/** Snaps a canvas px value so its PT position lands on the 8 pt grid. */
export function snapPx(px: number): number {
  return snapPt(px * PT_PER_PX) / PT_PER_PX;
}

const clampN = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ */
/* Measure + wrap (ONE math for preview badges and the PDF)             */
/* ------------------------------------------------------------------ */

export type MeasureFn = (
  text: string,
  size: number,
  bold?: boolean
) => number;

const NARROW = new Set("iljt.,:;'!|()[]{}fIrI/\\-\" ".split(""));
const WIDE = new Set("mwMW@%&".split(""));

/**
 * Helvetica-flavoured approximation (per-char class widths, thousandths
 * of an em — the create-resume recipe, bold widened ~6%). Deterministic
 * and dependency-free; production replaces it with the real embedded
 * font metrics via buildCommands' measure parameter.
 */
export function approxMeasure(text: string, size: number, bold = false): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      if (NARROW.has(c)) units += 0.29;
      else if (WIDE.has(c)) units += 0.82;
      else if (c >= "A" && c <= "Z") units += 0.68;
      else if (c >= "0" && c <= "9") units += 0.56;
      else units += 0.52;
    } else {
      units += 0.62; // Devanagari and other scripts — honest average
    }
  }
  return units * size * (bold ? 1.06 : 1);
}

/**
 * Word-wrap honouring explicit \n lines. Never returns []; a single
 * word wider than the box draws wide (documented honestly — the FAQ
 * says keep a little slack; there is no silent glyph-crushing).
 */
export function wrapText(
  text: string,
  maxW: number,
  size: number,
  measure: MeasureFn = approxMeasure,
  bold = false
): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (measure(next, size, bold) <= maxWptSafe(maxW) || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

function maxWptSafe(maxW: number): number {
  return Number.isFinite(maxW) && maxW > 0 ? maxW : Infinity;
}

/* ------------------------------------------------------------------ */
/* Table math — the invoice domain core (money NEVER from the screen)   */
/* ------------------------------------------------------------------ */

/** round2 with an epsilon so 0.1 + 0.2 style drift never survives. */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** Line amount — always derived, never hand-typed. */
export function rowAmount(row: Pick<TableRow, "qty" | "rate">): number {
  return round2(num(row.qty) * num(row.rate));
}

export interface InvoiceTotals {
  rowAmounts: number[];
  subtotal: number;
  tax: number;
  total: number;
}

/** Subtotal → tax % → grand total, recomputed everywhere from items. */
export function computeTotals(
  items: readonly TableRow[],
  taxPct: number
): InvoiceTotals {
  const rowAmounts = items.map(rowAmount);
  let subtotal = 0;
  for (const a of rowAmounts) subtotal += a;
  subtotal = round2(subtotal);
  const tax = round2((subtotal * num(taxPct)) / 100);
  return { rowAmounts, subtotal, tax, total: round2(subtotal + tax) };
}

/** Numeric coercion for qty/rate/tax inputs ("" / NaN → 0). */
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** Thousands-grouped fixed-2 money ("15,000.00"). */
export function group2(v: number): string {
  const [int, frac] = v.toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** Money string: symbol + space + grouped amount. Empty symbol = bare. */
export function formatMoney(v: number, currency: string): string {
  const amount = group2(v);
  return currency ? `${currency} ${amount}` : amount;
}

/** Qty keeps up to 3 decimals, trailing zeros trimmed ("3", "2.5"). */
export function formatQty(v: number): string {
  const n = num(v);
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(3)));
}

/** Tax percentage label value ("18", "4.5"). */
export function formatPct(v: number): string {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/* ------------------------------------------------------------------ */
/* Derived element geometry (heights are never stored — always honest)  */
/* ------------------------------------------------------------------ */

export function textLines(
  el: TextElement,
  measure: MeasureFn = approxMeasure
): string[] {
  return wrapText(el.text, pxToPt(el.w), el.size, measure, el.bold);
}

/** Text element height in canvas px (lines × 1.35 × size). */
export function textHeightPx(
  el: TextElement,
  measure: MeasureFn = approxMeasure
): number {
  return textLines(el, measure).length * el.size * TEXT_LINE * PX_PER_PT;
}

/** Table height in px: header + one row per item. */
export function tableHeightPx(el: TableElement, items: readonly TableRow[]): number {
  return (
    (Math.round(el.size * TABLE_HEADER) +
      items.length * Math.round(el.size * TABLE_ROW)) *
    PX_PER_PT
  );
}

/** Totals height in px: subtotal + tax + total rows. */
export function totalsHeightPx(el: TotalsElement): number {
  return 3 * Math.round(el.size * TOTALS_ROW) * PX_PER_PT;
}

/** Height of any element in canvas px (logo carries its own h). */
export function elementHeightPx(
  el: CanvasElement,
  items: readonly TableRow[],
  measure: MeasureFn = approxMeasure
): number {
  switch (el.kind) {
    case "text":
      return textHeightPx(el, measure);
    case "logo":
      return el.h;
    case "table":
      return tableHeightPx(el, items);
    case "totals":
      return totalsHeightPx(el);
  }
}

/* ------------------------------------------------------------------ */
/* Pure element operations (the surface calls these — never free mutation) */
/* ------------------------------------------------------------------ */

/**
 * Move an element: snap x/y to the 8 pt grid, then clamp fully inside
 * the fixed A4 canvas. Returns a NEW doc (or the same one when the id
 * is unknown).
 */
export function moveElement(
  doc: InvoiceCanvasDoc,
  id: string,
  xPx: number,
  yPx: number,
  measure: MeasureFn = approxMeasure
): InvoiceCanvasDoc {
  const el = doc.elements.find((e) => e.id === id);
  if (!el) return doc;
  const h = elementHeightPx(el, doc.items, measure);
  const x = clampN(
    snapPx(xPx),
    0,
    Math.max(0, CANVAS_W_PX - el.w)
  );
  const y = clampN(snapPx(yPx), 0, Math.max(0, CANVAS_H_PX - h));
  return updateElement(doc, id, { x, y });
}

/**
 * Resizable-lite: width for everything (height derives), width + height
 * for the logo. Snapped to the same 8 pt grid, clamped to the page.
 */
export function resizeElement(
  doc: InvoiceCanvasDoc,
  id: string,
  wPx: number,
  hPx?: number
): InvoiceCanvasDoc {
  const el = doc.elements.find((e) => e.id === id);
  if (!el) return doc;
  const w = clampN(snapPx(wPx), MIN_W_PX, CANVAS_W_PX);
  const patch: ElementPatch = { w };
  if (el.kind === "logo" && hPx !== undefined) {
    patch.h = clampN(snapPx(hPx), MIN_H_PX, CANVAS_H_PX);
  }
  return updateElement(doc, id, patch);
}

/**
 * Any-field patch for updateElement (every element field except id/kind
 * — the surface patches text styles, positions and sources through it).
 */
export interface ElementPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: CanvasAlign;
  src?: string;
}

/** Immutably patch one element (same id, same kind — patch is trusted
 *  internally; the worker boundary re-validates everything anyway). */
export function updateElement(
  doc: InvoiceCanvasDoc,
  id: string,
  patch: ElementPatch
): InvoiceCanvasDoc {
  return {
    ...doc,
    elements: doc.elements.map((el) =>
      el.id === id ? ({ ...el, ...patch } as CanvasElement) : el
    ),
  };
}

/** Swap an element with its next neighbour (paint order forward). */
export function bringForward(
  doc: InvoiceCanvasDoc,
  id: string
): InvoiceCanvasDoc {
  const idx = doc.elements.findIndex((e) => e.id === id);
  if (idx < 0 || idx === doc.elements.length - 1) return doc;
  const elements = [...doc.elements];
  [elements[idx], elements[idx + 1]] = [elements[idx + 1], elements[idx]];
  return { ...doc, elements };
}

/** Swap an element with its previous neighbour (paint order backward). */
export function sendBackward(
  doc: InvoiceCanvasDoc,
  id: string
): InvoiceCanvasDoc {
  const idx = doc.elements.findIndex((e) => e.id === id);
  if (idx <= 0) return doc;
  const elements = [...doc.elements];
  [elements[idx], elements[idx - 1]] = [elements[idx - 1], elements[idx]];
  return { ...doc, elements };
}

/** Remove one element (items/tax data survives in the editor). */
export function deleteElement(
  doc: InvoiceCanvasDoc,
  id: string
): InvoiceCanvasDoc {
  return { ...doc, elements: doc.elements.filter((e) => e.id !== id) };
}

/* ------------------------------------------------------------------ */
/* Draw commands — the pure layout → PDF plan (top-left origin, pt)     */
/* ------------------------------------------------------------------ */

export type DrawCommand =
  | {
      op: "text";
      /** Resolved left edge of the FIRST glyph (align already applied). */
      x: number;
      /** BASELINE pt from the page top. */
      y: number;
      text: string;
      size: number;
      bold: boolean;
      italic: boolean;
      color: string;
    }
  | { op: "rect"; x: number; y: number; w: number; h: number; color: string }
  | {
      op: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      width: number;
    }
  | { op: "image"; x: number; y: number; w: number; h: number; src: string };

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Table column anchors (pt, right edges for the numeric columns). */
export function tableCols(x: number, w: number) {
  return {
    descX: x + CELL_PAD,
    qtyR: x + w * 0.62,
    rateR: x + w * 0.8,
    amtR: x + w - CELL_PAD,
  };
}

/**
 * Layout → the complete, ordered draw list. Every coordinate is an
 * exact PDF pt value derived from the element's canvas px (×0.75);
 * alignment, wrapping and the money strings are fully resolved here,
 * so render.ts executes blind. `measure` defaults to approxMeasure —
 * the worker passes the REAL embedded-font metrics before calling.
 */
export function buildCommands(
  run: CanvasRun,
  measure: MeasureFn = approxMeasure
): DrawCommand[] {
  const cmds: DrawCommand[] = [];
  const d = run.d;
  const l = (k: string): string =>
    run.labels[k] ?? DEFAULT_LABELS[k] ?? "";

  for (const el of d.elements) {
    switch (el.kind) {
      case "text": {
        const x = pxToPt(el.x);
        const yTop = pxToPt(el.y);
        const w = pxToPt(el.w);
        const lines = textLines(el, measure);
        lines.forEach((line, k) => {
          if (line === "") return;
          const tw = measure(line, el.size, el.bold);
          let tx = x;
          if (el.align === "center") tx = x + (w - tw) / 2;
          else if (el.align === "right") tx = x + w - tw;
          cmds.push({
            op: "text",
            x: r2(tx),
            y: r2(yTop + el.size * (FIRST_BASELINE + k * TEXT_LINE)),
            text: line,
            size: el.size,
            bold: el.bold,
            italic: el.italic,
            color: el.color,
          });
        });
        break;
      }
      case "logo": {
        if (!el.src) break; // empty slot — draws nothing, honestly
        cmds.push({
          op: "image",
          x: r2(pxToPt(el.x)),
          y: r2(pxToPt(el.y)),
          w: r2(pxToPt(el.w)),
          h: r2(pxToPt(el.h)),
          src: el.src,
        });
        break;
      }
      case "table": {
        const x = pxToPt(el.x);
        const yTop = pxToPt(el.y);
        const w = pxToPt(el.w);
        const size = el.size;
        const headerH = Math.round(size * TABLE_HEADER);
        const rowH = Math.round(size * TABLE_ROW);
        const cols = tableCols(x, w);
        // header background + bold labels
        cmds.push({ op: "rect", x: r2(x), y: r2(yTop), w: r2(w), h: headerH, color: TABLE_HEADER_BG });
        const hb = yTop + headerH / 2 + size * ROW_BASELINE;
        const header: { text: string; at: number; right: boolean }[] = [
          { text: l("desc"), at: cols.descX, right: false },
          { text: l("qty"), at: cols.qtyR, right: true },
          { text: l("rate"), at: cols.rateR, right: true },
          { text: l("amount"), at: cols.amtR, right: true },
        ];
        for (const cell of header) {
          cmds.push({
            op: "text",
            x: r2(cell.right ? cell.at - measure(cell.text, size, true) : cell.at),
            y: r2(hb),
            text: cell.text,
            size,
            bold: true,
            italic: false,
            color: DEFAULT_TEXT_COLOR,
          });
        }
        // body rows (amounts derived, never trusted from the screen)
        d.items.forEach((row, i) => {
          const top = yTop + headerH + i * rowH;
          const bl = top + rowH / 2 + size * ROW_BASELINE;
          cmds.push({
            op: "text",
            x: r2(cols.descX),
            y: r2(bl),
            text: row.desc,
            size,
            bold: false,
            italic: false,
            color: DEFAULT_TEXT_COLOR,
          });
          const nums: { text: string; at: number }[] = [
            { text: formatQty(row.qty), at: cols.qtyR },
            { text: formatMoney(row.rate, ""), at: cols.rateR },
            { text: formatMoney(rowAmount(row), d.currency), at: cols.amtR },
          ];
          for (const cell of nums) {
            cmds.push({
              op: "text",
              x: r2(cell.at - measure(cell.text, size, false)),
              y: r2(bl),
              text: cell.text,
              size,
              bold: false,
              italic: false,
              color: DEFAULT_TEXT_COLOR,
            });
          }
          cmds.push({
            op: "line",
            x1: r2(x),
            y1: r2(top + rowH),
            x2: r2(x + w),
            y2: r2(top + rowH),
            color: TABLE_BORDER,
            width: 0.5,
          });
        });
        // outer border
        const th = headerH + d.items.length * rowH;
        const b = yTop + th;
        cmds.push(
          { op: "line", x1: r2(x), y1: r2(yTop), x2: r2(x + w), y2: r2(yTop), color: TABLE_BORDER, width: 0.75 },
          { op: "line", x1: r2(x), y1: r2(b), x2: r2(x + w), y2: r2(b), color: TABLE_BORDER, width: 0.75 },
          { op: "line", x1: r2(x), y1: r2(yTop), x2: r2(x), y2: r2(b), color: TABLE_BORDER, width: 0.75 },
          { op: "line", x1: r2(x + w), y1: r2(yTop), x2: r2(x + w), y2: r2(b), color: TABLE_BORDER, width: 0.75 }
        );
        break;
      }
      case "totals": {
        const x = pxToPt(el.x);
        const yTop = pxToPt(el.y);
        const w = pxToPt(el.w);
        const size = el.size;
        const rowH = Math.round(size * TOTALS_ROW);
        const t = computeTotals(d.items, d.taxPct);
        const rows: { label: string; value: string; bold: boolean }[] = [
          { label: l("subtotal"), value: formatMoney(t.subtotal, d.currency), bold: false },
          { label: `${l("tax")} (${formatPct(d.taxPct)}%)`, value: formatMoney(t.tax, d.currency), bold: false },
          { label: l("total"), value: formatMoney(t.total, d.currency), bold: true },
        ];
        rows.forEach((row, i) => {
          const top = yTop + i * rowH;
          const bl = top + rowH / 2 + size * ROW_BASELINE;
          if (row.bold) {
            cmds.push({
              op: "line",
              x1: r2(x),
              y1: r2(top - 2),
              x2: r2(x + w),
              y2: r2(top - 2),
              color: TOTALS_RULE,
              width: 1,
            });
          }
          cmds.push({
            op: "text",
            x: r2(x),
            y: r2(bl),
            text: row.label,
            size,
            bold: row.bold,
            italic: false,
            color: row.bold ? DEFAULT_TEXT_COLOR : MUTED_TEXT_COLOR,
          });
          cmds.push({
            op: "text",
            x: r2(x + w - measure(row.value, size, row.bold)),
            y: r2(bl),
            text: row.value,
            size,
            bold: row.bold,
            italic: false,
            color: row.bold ? DEFAULT_TEXT_COLOR : MUTED_TEXT_COLOR,
          });
        });
        break;
      }
    }
  }
  return cmds;
}

/** Every string buildCommands can draw (font-pick + honesty readouts). */
export function allDrawnText(run: CanvasRun): string[] {
  return buildCommands(run)
    .filter((c) => c.op === "text")
    .map((c) => (c as { text: string }).text);
}

/**
 * true → embed the self-hosted Noto Sans Devanagari (fontkit subset);
 * false → pure-WinAnsi content, base-14 Helvetica, NO font embedded.
 * "₹" is NOT WinAnsi — an EN invoice priced in ₹ honestly needs Noto.
 */
export function needsNoto(run: CanvasRun): boolean {
  return allDrawnText(run).some((s) => !isWinAnsiText(s));
}

/* ------------------------------------------------------------------ */
/* Defaults — the pre-placed A4 layout (all on the 8 pt grid)           */
/* ------------------------------------------------------------------ */

function todayStr(now?: Date): string {
  const d = now ?? new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The starter document: logo slot, company, title, number/date line,
 * bill-to, items table, totals and footer notes — every block a
 * movable element, every x/y an 8 pt grid position.
 */
export function defaults(locale: "en" | "hi" = "en", now?: Date): InvoiceCanvasDoc {
  const hi = locale === "hi";
  const p = ptToPx;
  const el = (base: Omit<TextElement, "kind">): TextElement => ({ kind: "text", ...base });
  const elements: CanvasElement[] = [
    {
      kind: "logo",
      id: "logo",
      x: p(40),
      y: p(32),
      w: p(96),
      h: p(48),
      src: "",
    },
    el({
      id: "company",
      x: p(40),
      y: p(96),
      w: p(280),
      text: hi
        ? "मेरी कंपनी\nगली पता, शहर 000000\n+91 90000 00000\nhello@mycompany.in"
        : "My Company\nStreet Address, City 000000\n+91 90000 00000\nhello@mycompany.in",
      size: 9.5,
      bold: false,
      italic: false,
      color: DEFAULT_TEXT_COLOR,
      align: "left",
    }),
    el({
      id: "title",
      x: p(336),
      y: p(32),
      w: p(219),
      text: hi ? "इनवॉइस" : "INVOICE",
      size: 20,
      bold: true,
      italic: false,
      color: DEFAULT_TEXT_COLOR,
      align: "right",
    }),
    el({
      id: "docline",
      x: p(336),
      y: p(72),
      w: p(219),
      text: hi
        ? `इनवॉइस नं.: INV-001\nदिनांक: ${todayStr(now)}`
        : `Invoice No: INV-001\nDate: ${todayStr(now)}`,
      size: 9,
      bold: false,
      italic: false,
      color: MUTED_TEXT_COLOR,
      align: "right",
    }),
    el({
      id: "billto",
      x: p(40),
      y: p(192),
      w: p(260),
      text: hi
        ? "बिल स्वीकारकर्ता\nग्राहक का नाम\nग्राहक का पता\nclient@email.com"
        : "Bill To\nClient Name\nClient Address\nclient@email.com",
      size: 9.5,
      bold: false,
      italic: false,
      color: DEFAULT_TEXT_COLOR,
      align: "left",
    }),
    { kind: "table", id: "table", x: p(40), y: p(288), w: p(515), size: 9 },
    { kind: "totals", id: "totals", x: p(331), y: p(368), w: p(224), size: 9 },
    el({
      id: "footer",
      x: p(40),
      y: p(768),
      w: p(515),
      text: hi
        ? "आपके व्यापार के लिए धन्यवाद!\nभुगतान अवधि: 15 दिन।"
        : "Thank you for your business!\nPayment terms: Net 15 days.",
      size: 8,
      bold: false,
      italic: false,
      color: FOOTER_TEXT_COLOR,
      align: "left",
    }),
  ];
  const items: TableRow[] = hi
    ? [
        { id: "i1", desc: "वेबसाइट डिज़ाइन", qty: 1, rate: 15000 },
        { id: "i2", desc: "होस्टिंग (3 महीने)", qty: 3, rate: 750 },
        { id: "i3", desc: "प्रशिक्षण सत्र", qty: 2, rate: 2500 },
      ]
    : [
        { id: "i1", desc: "Website design", qty: 1, rate: 15000 },
        { id: "i2", desc: "Hosting (3 months)", qty: 3, rate: 750 },
        { id: "i3", desc: "Training session", qty: 2, rate: 2500 },
      ];
  return {
    elements,
    items,
    taxPct: 18,
    currency: "₹",
    docNumber: "INV-001",
  };
}

/* ------------------------------------------------------------------ */
/* Worker boundary — parseCanvasRun (full defensive coercion)           */
/* ------------------------------------------------------------------ */

function coerceAlign(v: unknown): CanvasAlign {
  return v === "center" || v === "right" ? v : "left";
}

function coerceColor(v: unknown, fallback: string): string {
  return typeof v === "string" && AC_RE.test(v) ? v : fallback;
}

function coerceSize(v: unknown): number {
  return clampN(num(v), MIN_FONT, MAX_FONT);
}

function coerceSrc(v: unknown): string {
  if (typeof v !== "string") return "";
  if (v.length > MAX_IMG_DATAURL) return "";
  return DATAURL_RE.test(v) ? v : "";
}

function coerceElement(v: unknown, id: string): CanvasElement | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const x = clampN(num(o.x), 0, CANVAS_W_PX);
  const y = clampN(num(o.y), 0, CANVAS_H_PX);
  const w = clampN(num(o.w), MIN_W_PX, CANVAS_W_PX);
  switch (o.kind) {
    case "text":
      return {
        kind: "text",
        id,
        x,
        y,
        w,
        text: cleanText(o.text, MAX_TEXT_LEN),
        size: coerceSize(o.size),
        bold: o.bold === true,
        italic: o.italic === true,
        color: coerceColor(o.color, DEFAULT_TEXT_COLOR),
        align: coerceAlign(o.align),
      };
    case "logo": {
      const el: LogoElement = {
        kind: "logo",
        id,
        x,
        y,
        w,
        h: clampN(num(o.h), MIN_H_PX, CANVAS_H_PX),
        src: coerceSrc(o.src),
      };
      return el;
    }
    case "table":
      return { kind: "table", id, x, y, w, size: coerceSize(o.size) };
    case "totals":
      return { kind: "totals", id, x, y, w, size: coerceSize(o.size) };
    default:
      return null; // unknown kinds are dropped (worker-boundary contract)
  }
}

function coerceItems(v: unknown): TableRow[] {
  if (!Array.isArray(v)) return [];
  const out: TableRow[] = [];
  for (const raw of v.slice(0, MAX_ITEMS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    out.push({
      id: "",
      desc: cleanLine(o.desc, MAX_LINE_LEN),
      qty: clampN(num(o.qty), 0, 1e9),
      rate: clampN(num(o.rate), 0, 1e9),
    });
  }
  return out.map((row, i) => ({ ...row, id: `r${i}` }));
}

/**
 * Parse the serialized `canvas` option / run payload. Everything
 * untrusted is clamped/validated — a tampered or stale payload can
 * never reach the renderer as a wrong type, an unknown kind, an
 * oversized image or an off-canvas element. Unreadable JSON falls
 * back to a fresh default document.
 */
export function parseCanvasRun(raw: string): CanvasRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;

  const labels: Record<string, string> = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= 16) labels[k] = v.slice(0, 80);
    }
  }

  const d = (typeof o.d === "object" && o.d !== null ? o.d : {}) as Record<
    string,
    unknown
  >;

  const seen = new Set<string>();
  const elements: CanvasElement[] = [];
  if (Array.isArray(d.elements)) {
    for (const raw of d.elements.slice(0, MAX_ELEMENTS)) {
      let id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : "";
      if (!id || seen.has(id)) id = newId("e");
      const el = coerceElement(raw, id);
      if (el) {
        seen.add(id);
        elements.push(el);
      }
    }
  }

  const currency =
    typeof d.currency === "string" && (CURRENCIES as readonly string[]).includes(d.currency)
      ? d.currency
      : "₹";

  return {
    d: {
      elements,
      items: coerceItems(d.items),
      taxPct: clampN(num(d.taxPct), 0, MAX_TAX_PCT),
      currency,
      docNumber: cleanLine(d.docNumber, 40),
    },
    labels,
    locale: o.locale === "hi" ? "hi" : "en",
  };
}

/* ------------------------------------------------------------------ */
/* Output file name (unicode-safe, no regex property escapes)          */
/* ------------------------------------------------------------------ */

function safeNameChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code >= 0x80) return true; // Devanagari and every other script
  return /[A-Za-z0-9._-]/.test(c);
}

function sanitizeName(s: string): string {
  return s
    .split(/\s+/)
    .map((word) => [...word].filter((c) => safeNameChar(c)).join(""))
    .filter(Boolean)
    .join("-")
    .slice(0, 60);
}

/**
 * The user's doc number wins ("INV-42-2026"); otherwise
 * "invoice-YYYY-MM-DD". Unicode letters survive (Hindi numbers make
 * Hindi file names), path separators and symbols do not.
 */
export function outputName(doc: InvoiceCanvasDoc, now?: Date): string {
  const typed = sanitizeName(cleanLine(doc.docNumber, 40));
  if (typed) return typed;
  return `invoice-${todayStr(now)}`;
}

/* ------------------------------------------------------------------ */
/* Error taxonomy — Error → honest i18n key                             */
/* ------------------------------------------------------------------ */

/**
 * Maps a caught render error to the i18n key the UI shows. The SVG
 * logo rejection is explicit (the renderer embeds PNG/JPEG only);
 * everything else stays on the house generic key.
 */
export function classifyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/logo-svg/i.test(msg)) return "civ.errSvg";
  if (/logo-decode/i.test(msg)) return "civ.errLogo";
  return "tool.errorGeneric";
}
