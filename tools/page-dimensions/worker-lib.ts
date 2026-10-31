/**
 * Page dimensions analyzer (P1-d / R53) — PURE module, no DOM/worker
 * imports, so the smoke battery exercises exactly what ships.
 *
 * Read-only: every page's visible box (CropBox, MediaBox fallback — the
 * same materialized values listPages computes), classified by orientation
 * and matched against the standard paper sizes (±2pt tolerance), grouped
 * for the mixed-size summary, and rendered as a TXT sheet or JSON.
 */

import type { PdfPageInfo } from "@/lib/own/pdf";

export type DimUnit = "pt" | "mm" | "in";

export interface PageDimRow {
  page: number;
  /** Visible width in points. */
  widthPt: number;
  /** Visible height in points. */
  heightPt: number;
  orientation: "portrait" | "landscape" | "square";
  /** Standard size name ("A4", "Letter"…) or null when unrecognized. */
  sizeName: string | null;
}

export interface DimGroup {
  key: string;
  widthPt: number;
  heightPt: number;
  sizeName: string | null;
  orientation: "portrait" | "landscape" | "square";
  pages: number[];
}

export interface DimReport {
  rows: PageDimRow[];
  groups: DimGroup[];
  mixed: boolean;
  dominant: DimGroup | null;
}

/** Standard paper sizes in points (portrait). ±2pt match tolerance. */
const PAPER_SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: "A3", w: 841.89, h: 1190.55 },
  { name: "A4", w: 595.28, h: 841.89 },
  { name: "A5", w: 419.53, h: 595.28 },
  { name: "A6", w: 297.64, h: 419.53 },
  { name: "B4", w: 708.66, h: 1000.63 },
  { name: "B5", w: 498.9, h: 708.66 },
  { name: "Letter", w: 612, h: 792 },
  { name: "Legal", w: 612, h: 1008 },
  { name: "Tabloid", w: 792, h: 1224 },
  { name: "Statement", w: 396, h: 612 },
  { name: "Executive", w: 521.86, h: 756 },
];

const MATCH_TOLERANCE = 2;

export function matchPaperSize(
  widthPt: number,
  heightPt: number,
): string | null {
  const short = Math.min(widthPt, heightPt);
  const long = Math.max(widthPt, heightPt);
  for (const size of PAPER_SIZES) {
    if (
      Math.abs(short - size.w) <= MATCH_TOLERANCE &&
      Math.abs(long - size.h) <= MATCH_TOLERANCE
    ) {
      return size.name;
    }
  }
  return null;
}

export function classifyOrientation(
  widthPt: number,
  heightPt: number,
): "portrait" | "landscape" | "square" {
  if (Math.abs(widthPt - heightPt) <= 0.5) return "square";
  return widthPt > heightPt ? "landscape" : "portrait";
}

const PT_PER_MM = 25.4 / 72;
const PT_PER_IN = 1 / 72;

export function formatDim(valuePt: number, unit: DimUnit): string {
  if (unit === "pt") return `${round(valuePt)} pt`;
  if (unit === "in") return `${(valuePt * PT_PER_IN).toFixed(2)} in`;
  return `${(valuePt * PT_PER_MM).toFixed(1)} mm`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function buildDimReport(pages: PdfPageInfo[]): DimReport {
  const rows: PageDimRow[] = pages.map((page, index) => {
    // CropBox is the VISIBLE box; listPages defaults it to MediaBox.
    const [x0, y0, x1, y1] = page.cropBox;
    const widthPt = x1 - x0;
    const heightPt = y1 - y0;
    return {
      page: index + 1,
      widthPt,
      heightPt,
      orientation: classifyOrientation(widthPt, heightPt),
      sizeName: matchPaperSize(widthPt, heightPt),
    };
  });

  // Group identical visible sizes (2-decimal point rounding as the key).
  const groupMap = new Map<string, DimGroup>();
  for (const row of rows) {
    const key = `${row.widthPt.toFixed(2)}×${row.heightPt.toFixed(2)}`;
    let group = groupMap.get(key);
    if (group === undefined) {
      group = {
        key,
        widthPt: row.widthPt,
        heightPt: row.heightPt,
        sizeName: row.sizeName,
        orientation: row.orientation,
        pages: [],
      };
      groupMap.set(key, group);
    }
    group.pages.push(row.page);
  }
  const groups = [...groupMap.values()].sort(
    (a, b) => b.pages.length - a.pages.length || a.pages[0] - b.pages[0],
  );

  return {
    rows,
    groups,
    mixed: groups.length > 1,
    dominant: groups.length > 0 ? groups[0] : null,
  };
}

export interface DimReportOptions {
  format: "txt" | "json";
  unit: DimUnit;
  includePages: boolean;
  fileName: string;
}

export function renderDimReport(
  report: DimReport,
  opts: DimReportOptions,
): string {
  if (opts.format === "json") {
    return renderJson(report, opts);
  }
  return renderTxt(report, opts);
}

function renderTxt(report: DimReport, opts: DimReportOptions): string {
  const u = opts.unit;
  const lines: string[] = [];
  lines.push("PAGE DIMENSIONS REPORT");
  lines.push("======================");
  lines.push(`File: ${opts.fileName}`);
  lines.push(`Pages: ${report.rows.length}`);
  lines.push("");

  lines.push("SUMMARY");
  if (report.dominant === null) {
    lines.push("  No pages found.");
  } else {
    const d = report.dominant;
    const label =
      d.sizeName !== null
        ? `${d.sizeName} ${d.orientation}`
        : `${d.orientation}`;
    lines.push(
      `  Unique sizes: ${report.groups.length}${report.mixed ? " (mixed)" : " (uniform)"}`,
    );
    lines.push(
      `  Dominant: ${label} — ${formatDim(d.widthPt, u)} × ${formatDim(d.heightPt, u)} — ${d.pages.length} of ${report.rows.length} pages`,
    );
    for (const g of report.groups.slice(1)) {
      const gl =
        g.sizeName !== null ? `${g.sizeName} ${g.orientation}` : g.orientation;
      lines.push(
        `  Also: ${gl} — ${formatDim(g.widthPt, u)} × ${formatDim(g.heightPt, u)} — ${g.pages.length} page${g.pages.length > 1 ? "s" : ""} (${summarizePages(g.pages)})`,
      );
    }
  }
  lines.push("");

  if (opts.includePages) {
    lines.push("PAGES");
    for (const row of report.rows) {
      const name =
        row.sizeName !== null ? ` — ${row.sizeName}` : "";
      lines.push(
        `  Page ${row.page}: ${formatDim(row.widthPt, u)} × ${formatDim(row.heightPt, u)} — ${row.orientation}${name}`,
      );
    }
  } else {
    lines.push("(Per-page list off — summary only.)");
  }
  lines.push("");
  return lines.join("\n");
}

function summarizePages(pages: number[]): string {
  // Compact "1, 3-5" runs for the also-present groups.
  const parts: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i += 1) {
    const cur = pages[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(", ");
}

function renderJson(report: DimReport, opts: DimReportOptions): string {
  return JSON.stringify(
    {
      file: opts.fileName,
      pageCount: report.rows.length,
      uniqueSizes: report.groups.length,
      mixed: report.mixed,
      dominant: report.dominant
        ? {
            sizeName: report.dominant.sizeName,
            orientation: report.dominant.orientation,
            widthPt: round2(report.dominant.widthPt),
            heightPt: round2(report.dominant.heightPt),
            pages: report.dominant.pages.length,
          }
        : null,
      groups: report.groups.map((g) => ({
        sizeName: g.sizeName,
        orientation: g.orientation,
        widthPt: round2(g.widthPt),
        heightPt: round2(g.heightPt),
        pages: g.pages,
      })),
      pages: opts.includePages
        ? report.rows.map((row) => ({
            page: row.page,
            widthPt: round2(row.widthPt),
            heightPt: round2(row.heightPt),
            widthMm: round3(row.widthPt * PT_PER_MM),
            heightMm: round3(row.heightPt * PT_PER_MM),
            widthIn: round3(row.widthPt * PT_PER_IN),
            heightIn: round3(row.heightPt * PT_PER_IN),
            orientation: row.orientation,
            sizeName: row.sizeName,
          }))
        : undefined,
    },
    null,
    2,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
