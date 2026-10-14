import type { OptionValues } from "@/lib/tools/config-types";

import {
  blockScript,
  findUnsupportedCodePoint,
  MM_TO_PT,
  PAGE_SIZES,
  PageFlow,
  planLineGroup,
  wrapRuns,
  type FontSpec,
  type MeasureRun,
  type PageGeometry,
  type PageSizeId,
  type PositionedTextRun,
  type ScriptFont,
  type WrapRun,
} from "./text-layout";

/**
 * Plain text → PDF engine (PRD §8.6) — PURE. The worker decodes files, loads
 * the fonts and draws; everything here is plain math on plain data so
 * scripts/smoke-txt2pdf.ts can verify it headlessly with bun BEFORE the
 * worker ships (the P3.3 lesson: prove the engine, then build on it).
 *
 * Layout modes:
 * - "reflow":   paragraphs (blank-line-separated blocks) are re-wrapped to
 *               the page width — clean reading typography.
 * - "preserve": every source line stays its own line (indent kept, blank
 *               lines kept); only overlong lines wrap (continuation keeps
 *               the original indent).
 *
 * Font strategy: per BLOCK — any character beyond WinAnsi upgrades the whole
 * paragraph to the embedded Noto font (see text-layout.ts).
 */

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface TxtOptions {
  pageSize: PageSizeId;
  /** Body font size in pt (8–24). */
  fontSize: number;
  /** Line-height multiplier (1.15–2.0). */
  lineHeight: number;
  /** Page margin in mm (10–40). */
  margin: number;
  mode: "reflow" | "preserve";
}

function clampNumber(
  value: unknown,
  lo: number,
  hi: number,
  fallback: number
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Coerces raw panel values into typed, clamped options. */
export function resolveTxtOptions(values: OptionValues): TxtOptions {
  return {
    pageSize: values.pageSize === "letter" ? "letter" : "a4",
    fontSize: clampNumber(values.fontSize, 8, 24, 11),
    lineHeight: clampNumber(values.lineHeight, 1.15, 2, 1.5),
    margin: clampNumber(values.margin, 10, 40, 20),
    mode: values.mode === "preserve" ? "preserve" : "reflow",
  };
}

/* ------------------------------------------------------------------ */
/* Decoding + binary sniff (pure — the worker hands over raw bytes)    */
/* ------------------------------------------------------------------ */

export type TextFileVerdict =
  | { kind: "ok"; text: string }
  | { kind: "binary" }
  | { kind: "empty" }
  | { kind: "unsupported"; codePoint: number };

const SNIFF_WINDOW = 4096;

/**
 * Decodes UTF-8 (BOM stripped, malformed sequences tolerated) and sniffs
 * for binary content: a NUL byte in the first 4 KB or >10% U+FFFD
 * replacement chars in the first 4 KB, plus an explicit %PDF- magic.
 */
export function readTextFile(bytes: Uint8Array): TextFileVerdict {
  if (bytes.length >= 4) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic === "%PDF") return { kind: "binary" };
  }
  const windowEnd = Math.min(bytes.length, SNIFF_WINDOW);
  for (let i = 0; i < windowEnd; i += 1) {
    if (bytes[i] === 0x00) return { kind: "binary" };
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(bytes);
  const head = decoded.slice(0, SNIFF_WINDOW);
  let replacements = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head.charCodeAt(i) === 0xfffd) replacements += 1;
  }
  if (head.length > 0 && replacements / head.length > 0.1) {
    return { kind: "binary" };
  }
  const text = decoded.replace(/^\ufeff/, "");
  if (text.replace(/\s/g, "").length === 0) return { kind: "empty" };
  const unsupported = findUnsupportedCodePoint(text);
  if (unsupported !== null) {
    return { kind: "unsupported", codePoint: unsupported };
  }
  return { kind: "ok", text };
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * BOM → gone, CRLF/CR → LF, tabs → 4 spaces (preserve-mode indentation
 * survives as spaces), other C0 controls dropped (incl. FF page breaks —
 * an honest v1 omission), zero-width no-break spaces removed.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/g, "");
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const SANS_REGULAR: FontSpec = { family: "sans", bold: false, italic: false };
/** Vertical gap between reflow paragraphs (fraction of one line advance). */
const PARAGRAPH_GAP_RATIO = 0.5;

export interface TxtLayoutResult {
  pages: { lines: PositionedTextRun[] }[];
  pageCount: number;
  lineCount: number;
}

/**
 * Lays the whole document out: wraps, paginates (orphan/widow aware) and
 * positions every line. Draw-ready — the worker only maps `script` to a
 * pdf-lib font and paints.
 */
export function layoutTxt(
  source: string,
  options: TxtOptions,
  measure: MeasureRun
): TxtLayoutResult {
  const text = normalizeText(source);
  const size = PAGE_SIZES[options.pageSize];
  const marginPt = options.margin * MM_TO_PT;
  const geometry: PageGeometry = {
    pageW: size.width,
    pageH: size.height,
    marginLeft: marginPt,
    marginRight: marginPt,
    marginTop: marginPt,
    marginBottom: marginPt,
  };
  const advance = options.fontSize * options.lineHeight;
  const flow = new PageFlow(geometry);
  const pages: PositionedTextRun[][] = [[]];
  const ensurePage = (index: number): PositionedTextRun[] => {
    while (pages.length <= index) pages.push([]);
    return pages[index];
  };

  let lineCount = 0;
  let firstBlock = true;

  /** Wraps one block and places its lines with orphan/widow protection. */
  const placeGroup = (
    runText: string,
    x: number,
    maxWidth: number
  ): void => {
    const script = blockScript(runText);
    const wrapped = wrapRuns([{ text: runText, spec: SANS_REGULAR }], {
      maxWidth,
      size: options.fontSize,
      script,
      measure,
    });
    if (wrapped.length === 0) return;
    const placements = planLineGroup(
      flow,
      wrapped.length,
      advance,
      options.fontSize
    );
    for (let i = 0; i < placements.length; i += 1) {
      const place = placements[i];
      const page = ensurePage(place.pageIndex);
      const runs: PositionedTextRun[] = [];
      let cx = x;
      for (const run of wrapped[i]) {
        if (run.text.length === 0) continue;
        runs.push({
          text: run.text,
          x: cx,
          baseline: place.baseline,
          size: options.fontSize,
          spec: SANS_REGULAR,
          script,
        });
        cx += measure(run.text, SANS_REGULAR, options.fontSize, script);
      }
      page.push(...runs);
      lineCount += 1;
    }
  };

  if (options.mode === "reflow") {
    const paragraphs = text.split(/\n{2,}/);
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.replace(/[ ]+$/gm, "").trim();
      if (trimmed.length === 0) continue;
      if (!firstBlock) flow.consumeGap(advance * PARAGRAPH_GAP_RATIO);
      placeGroup(trimmed, geometry.marginLeft, flow.contentWidth);
      firstBlock = false;
    }
  } else {
    const sourceLines = text.split("\n");
    for (const sourceLine of sourceLines) {
      if (sourceLine.trim().length === 0) {
        // blank line — never at the top of a fresh page (dropped there)
        if (!flow.pageHasContent) continue;
        flow.consume(advance);
        lineCount += 1;
        continue;
      }
      const indentMatch = /^[ ]*/.exec(sourceLine);
      const indent = indentMatch ? indentMatch[0] : "";
      const body = sourceLine.slice(indent.length).replace(/[ ]+$/, "");
      if (body.length === 0) continue;
      // The line's leading spaces become a left offset; wrapped
      // continuation lines share it, so indented blocks stay indented.
      const indentWidth = measure(
        indent,
        SANS_REGULAR,
        options.fontSize,
        "std"
      );
      placeGroup(
        body,
        geometry.marginLeft + indentWidth,
        Math.max(24, flow.contentWidth - indentWidth)
      );
      firstBlock = false;
    }
  }

  return {
    pages: pages.map((lines) => ({ lines })),
    pageCount: pages.length,
    lineCount,
  };
}

/** Exposed for smoke tests (indent math lives inside layoutTxt). */
export function measureIndent(
  indent: string,
  size: number,
  measure: MeasureRun
): number {
  return measure(indent, SANS_REGULAR, size, "std");
}

/** Shared run type re-export (the smoke scripts build fixtures with it). */
export type { WrapRun };
