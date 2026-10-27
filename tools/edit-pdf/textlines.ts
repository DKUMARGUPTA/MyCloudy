"use client";

/**
 * Edit PDF — main-thread text-line extraction.
 *
 * pdf.js getTextContent gives text items in USER space; a viewport at
 * scale 1 with the page's /Rotate + the editor's extra rotation maps
 * them into DISPLAY space — the exact space every editor object lives
 * in. Each item becomes one EdTextLine (a display-space box + its
 * string) that linesToQuads intersects with the user's selection drag
 * (sub-phase 2: highlight / underline / strike).
 *
 * Sub-phase 3 adds getEditableLines: the same runs grouped into VISUAL
 * lines (same baseline) with their font info. The real font name and
 * bold/italic flags come from the render pipeline's commonObjs — after
 * a page render those are loaded; if some are still missing we run
 * getOperatorList once (it populates them) and cache the result.
 *
 * Vertical / rotated-in-place text is skipped honestly (the quad math
 * is horizontal-only — rare scans of typeset pages are unaffected).
 */

import type { EdEditLine, EdFontRun, EdTextLine } from "./model";
import { groupEditLines } from "./model";
import { getLoadedDoc } from "./render";

/** Fraction of the font height above the baseline (cap + a bit of headroom). */
const ASCENT_FRAC = 0.85;
/** Fraction below the baseline (descender room) — the two add up to the box. */
const DESCENT_FRAC = 0.3;
/** Display advance may tilt at most this much before we call it vertical. */
const MAX_TILT_RATIO = 0.25;

const cache = new WeakMap<File, Map<string, EdTextLine[]>>();
const editCache = new WeakMap<File, Map<string, EdEditLine[]>>();

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
}

interface TextStyle {
  fontFamily?: unknown;
}

/** What commonObjs gives us for a loaded font (see FontFaceObject). */
interface FontFaceLike {
  name?: unknown;
  bold?: unknown;
  italic?: unknown;
  black?: unknown;
}

interface CommonObjsLike {
  has(objId: string): boolean;
  get(objId: string): unknown;
}

/**
 * Ensure the page's fonts are loaded into commonObjs (the render pipeline
 * usually did this already); getOperatorList is the one guaranteed pass.
 */
async function ensureFontsLoaded(
  page: { commonObjs: CommonObjsLike; getOperatorList: () => Promise<unknown> } & Record<string, unknown>,
  fontIds: string[]
): Promise<void> {
  const missing = fontIds.filter((id) => !page.commonObjs.has(id));
  if (missing.length === 0) return;
  try {
    await page.getOperatorList();
  } catch {
    // Best-effort — font names just stay empty and matching degrades
    // to the generic cssFamily.
  }
}

function readFontFace(commonObjs: CommonObjsLike, id: string): FontFaceLike {
  if (!commonObjs.has(id)) return {};
  try {
    return (commonObjs.get(id) ?? {}) as FontFaceLike;
  } catch {
    return {};
  }
}

/** Shared run conversion: one pdf.js text item → a display-space run. */
async function displayRuns(
  file: File,
  srcIndex: number,
  extraRotation: number,
  withFonts: boolean
): Promise<{
  runs: EdFontRun[];
  markLines: EdTextLine[];
}> {
  const loaded = await getLoadedDoc(file);
  const page = (await loaded.doc.getPage(srcIndex + 1)) as unknown as {
    getViewport: (opts: { scale: number; rotation: number }) => { transform: number[] };
    getTextContent: () => Promise<{ items: unknown[]; styles?: unknown }>;
    rotate: number;
    cleanup: () => void;
    commonObjs: CommonObjsLike;
    getOperatorList: () => Promise<unknown>;
  };
  const viewport = page.getViewport({
    scale: 1,
    rotation: (page.rotate + extraRotation) as number,
  });
  const content = await page.getTextContent();
  const styles = (content.styles ?? {}) as Record<string, TextStyle>;
  const vt = viewport.transform as number[];
  const runs: EdFontRun[] = [];
  const fontKeys: string[] = [];
  const markLines: EdTextLine[] = [];

  for (const rawItem of content.items as RawTextItem[]) {
    if (typeof rawItem.str !== "string" || rawItem.str.length === 0) continue;
    const tr = rawItem.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;
    const x0 = Number(tr[4]);
    const y0 = Number(tr[5]);
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
    const width = typeof rawItem.width === "number" ? rawItem.width : 0;
    if (!(width > 0)) continue;

    // Text advance direction in USER space = the matrix's x-axis.
    const ax = Number(tr[0]) || 0;
    const ay = Number(tr[1]) || 0;
    const axisLen = Math.hypot(ax, ay);
    if (!(axisLen > 0)) continue;
    const ux = ax / axisLen;
    const uy = ay / axisLen;

    // Baseline start and end in DISPLAY space (viewport at scale 1 =
    // display points, y down — same space as every editor object).
    const sx = vt[0] * x0 + vt[2] * y0 + vt[4];
    const sy = vt[1] * x0 + vt[3] * y0 + vt[5];
    const exUser = x0 + width * ux;
    const eyUser = y0 + width * uy;
    const ex = vt[0] * exUser + vt[2] * eyUser + vt[4];
    const ey = vt[1] * exUser + vt[3] * eyUser + vt[5];

    const dx = ex - sx;
    const dy = ey - sy;
    if (Math.abs(dx) < 0.5) continue;
    if (Math.abs(dy) > Math.abs(dx) * MAX_TILT_RATIO) continue; // vertical text

    // Font size from the text matrix's y-axis magnitude (viewport-scale
    // independent — a rotation never changes lengths).
    const fontSize = Math.hypot(Number(tr[2]) || 0, Number(tr[3]) || 0);
    if (!(fontSize > 0.5)) continue;

    const left = Math.min(sx, ex);
    const right = Math.max(sx, ex);
    const ascent = fontSize * ASCENT_FRAC;
    const height = fontSize * (ASCENT_FRAC + DESCENT_FRAC);
    markLines.push({
      x: left,
      y: sy - ascent,
      w: right - left,
      h: height,
      str: rawItem.str,
    });

    const fontKey =
      typeof rawItem.fontName === "string" ? rawItem.fontName : "";
    fontKeys.push(fontKey);
    const style = fontKey !== "" ? styles[fontKey] : undefined;
    runs.push({
      x: left,
      y: sy - ascent,
      w: right - left,
      h: height,
      str: rawItem.str,
      baseline: sy,
      size: fontSize,
      cssFamily:
        typeof style?.fontFamily === "string" ? style.fontFamily : "",
      fontName: "",
      bold: false,
      italic: false,
      black: false,
    });
  }

  if (withFonts) {
    // The real font names + bold/italic flags live in the render
    // pipeline's commonObjs (populated by page render / operator list).
    const ids = Array.from(new Set(fontKeys.filter((id) => id !== "")));
    await ensureFontsLoaded(page, ids);
    for (let i = 0; i < runs.length; i += 1) {
      if (fontKeys[i] === "") continue;
      const face = readFontFace(page.commonObjs, fontKeys[i]);
      runs[i] = {
        ...runs[i],
        fontName: typeof face.name === "string" ? face.name : "",
        bold: face.bold === true,
        italic: face.italic === true,
        black: face.black === true,
      };
    }
  }
  page.cleanup();
  return { runs, markLines };
}

/**
 * Display-space text lines of one source page at a given extra rotation.
 * Cached per (file, src, rotation) — page turns and back are free.
 */
export async function getTextLines(
  file: File,
  srcIndex: number,
  extraRotation: number
): Promise<EdTextLine[]> {
  let byPage = cache.get(file);
  if (byPage === undefined) {
    byPage = new Map();
    cache.set(file, byPage);
  }
  const key = `${srcIndex}:${extraRotation}`;
  const hit = byPage.get(key);
  if (hit !== undefined) return hit;

  const { markLines } = await displayRuns(file, srcIndex, extraRotation, false);
  byPage.set(key, markLines);
  return markLines;
}

/**
 * Visual edit lines of one source page at a given extra rotation (sub-phase
 * 3 — the click-to-edit targets). Cached per (file, src, rotation).
 */
export async function getEditableLines(
  file: File,
  srcIndex: number,
  extraRotation: number
): Promise<EdEditLine[]> {
  let byPage = editCache.get(file);
  if (byPage === undefined) {
    byPage = new Map();
    editCache.set(file, byPage);
  }
  const key = `${srcIndex}:${extraRotation}`;
  const hit = byPage.get(key);
  if (hit !== undefined) return hit;

  const { runs } = await displayRuns(file, srcIndex, extraRotation, true);
  const lines = groupEditLines(runs);
  byPage.set(key, lines);
  return lines;
}
