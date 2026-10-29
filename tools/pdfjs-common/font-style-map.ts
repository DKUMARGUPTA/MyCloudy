/**
 * pdf.js font-id → style enrichment on the OWN engine (P6-v).
 *
 * The four pdf-to-X extractors (word / odt / html / markdown) each carried
 * a near-identical private pdf-lib walk that correlated pdf.js's internal
 * font ids ("g_d0_f3") with the PDF's real /Font table to recover bold +
 * italic — pdf.js 4.x never reports the actual names. This module is the
 * ONE shared port of that walk onto our own engine (parsePdf + listPages +
 * decodeStreamBytes), preserving the proven correlation semantics:
 *
 *  - per page: distinct pdf.js item ids (first-appearance order) are
 *    zipped with the page's distinct /Font resource keys in first-Tf-use
 *    order (content-stream order, streams decoded through our own
 *    Flate/LZW/A85/RLE + predictors);
 *  - the keys are DEDUPED by the object they resolve to (pdf.js assigns
 *    one id per distinct font OBJECT, while pdf-lib-authored fixtures
 *    write a fresh resource key per drawText call — first key per object
 *    wins so both sides count the same things);
 *  - any mismatch (form XObjects, inherited resources, Type3) skips that
 *    page's enrichment — style degrades honestly to off;
 *  - a font's style reads from its BaseFont name (Type0 → the descendant
 *    CIDFont's name when the top lacks one) via the bold/italic regexes;
 *  - unreadable structure (or an encrypted doc — our parser refuses it)
 *    degrades the WHOLE map to empty, exactly like the pdf-lib load
 *    failure path did.
 *
 * Names arrive #HH-DECODED from our lexer (readName), so the Tf keys
 * captured from the RAW content stream are decoded the same way before
 * the resource-dict lookup — the engine's dict keys are decoded too.
 */

import {
  asDict,
  decodeStreamBytes,
  listPages,
  parsePdf,
  resolve,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";

/** BaseFont names that read as bold. */
const BOLD_BASEFONT_RE = /(bold|black|heavy|demi|semib)/i;
/** BaseFont names that read as italic. */
const ITALIC_BASEFONT_RE = /(italic|oblique)/i;

/** The style of one pdf.js font id. */
export interface FontStyleInfo {
  bold: boolean;
  italic: boolean;
}

/** Minimal structural shape of a pdf.js text item (duck-typed). */
export interface StyleMapTextItem {
  fontName?: unknown;
}
/** One page's items. */
export type StyleMapPage = readonly StyleMapTextItem[];

/* ------------------------------------------------------------------ */
/* Page facts (own engine)                                             */
/* ------------------------------------------------------------------ */

/** A dict-shaped value's map half (dict or stream), else undefined. */
function mapOf(obj: PdfObj | undefined): Map<string, PdfObj> | undefined {
  return obj && (obj.k === "dict" || obj.k === "stream") ? obj.m : undefined;
}

/** The /Font resource dict for a page, walking inherited resources. */
function fontResourcesFor(
  doc: ParsedPdf,
  node: Map<string, PdfObj>
): Map<string, PdfObj> | undefined {
  let current: Map<string, PdfObj> | undefined = node;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const resMap = mapOf(resolve(doc, current.get("Resources")));
    if (resMap !== undefined) {
      const fonts = mapOf(resolve(doc, resMap.get("Font")));
      if (fonts !== undefined) return fonts;
    }
    current = mapOf(resolve(doc, current.get("Parent")));
  }
  return undefined;
}

/** Distinct /Font resource keys in first-Tf-use order (content stream). */
function tfOrderForPage(
  doc: ParsedPdf,
  node: Map<string, PdfObj>
): string[] {
  const chunks: Uint8Array[] = [];
  const push = (obj: PdfObj | undefined): void => {
    const value = obj === undefined ? undefined : resolve(doc, obj);
    if (value !== undefined && value.k === "stream") {
      try {
        chunks.push(decodeStreamBytes(value.raw, value.m));
      } catch {
        // undecodable chunk → skip it (the pdf-lib walk lost the whole
        // page here; per-chunk tolerance degrades more gracefully)
      }
    }
  };
  const contents = resolve(doc, node.get("Contents"));
  if (contents !== undefined && contents.k === "stream") {
    push(node.get("Contents"));
  } else if (contents !== undefined && contents.k === "arr") {
    for (const item of contents.items) push(item);
  }
  if (chunks.length === 0) return [];

  const text = new TextDecoder("latin1").decode(concat(chunks));
  const keys: string[] = [];
  const re = /\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // #HH escapes per the PDF name rules — our resource-dict keys arrive
    // decoded from the lexer, so decode the captured key to match.
    const key = match[1]!.replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Style of one font dict                                              */
/* ------------------------------------------------------------------ */

/** The BaseFont name of a font dict, Type0-descendant included. */
function baseFontName(doc: ParsedPdf, dict: Map<string, PdfObj>): string | null {
  const top = resolve(doc, dict.get("BaseFont"));
  if (top !== undefined && top.k === "name") return top.v;
  // Type0 wrapped fonts keep the real face in the descendant's name.
  const descendants = resolve(doc, dict.get("DescendantFonts"));
  if (descendants !== undefined && descendants.k === "arr" && descendants.items.length > 0) {
    const child = asDict(resolve(doc, descendants.items[0]));
    const childName = child === undefined ? undefined : resolve(doc, child.get("BaseFont"));
    if (childName !== undefined && childName.k === "name") return childName.v;
  }
  return null;
}

/** Bold/italic of one /Font resource value (ref or dict). */
function fontFaceStyle(doc: ParsedPdf, value: PdfObj): FontStyleInfo {
  const dict = asDict(resolve(doc, value));
  if (dict === undefined) return { bold: false, italic: false };
  const name = baseFontName(doc, dict);
  if (name === null) return { bold: false, italic: false };
  return {
    bold: BOLD_BASEFONT_RE.test(name),
    italic: ITALIC_BASEFONT_RE.test(name),
  };
}

/* ------------------------------------------------------------------ */
/* The correlation                                                     */
/* ------------------------------------------------------------------ */

async function buildStyleMap(
  bytes: Uint8Array,
  pageIndexes: readonly number[],
  pages: readonly StyleMapPage[]
): Promise<Map<string, FontStyleInfo>> {
  const result = new Map<string, FontStyleInfo>();
  let pdf: ParsedPdf;
  try {
    pdf = parsePdf(bytes);
  } catch {
    return result; // unreadable structure → no styles, honest degradation
  }
  try {
    const pageList = listPages(pdf);
    const pageCount = Math.min(pages.length, pageList.length);
    for (let entry = 0; entry < pageCount; entry += 1) {
      const pageIndex = pageIndexes[entry] ?? entry;
      if (pageIndex < 0 || pageIndex >= pageList.length) continue;

      // Distinct pdf.js font ids on this page, in first-appearance order.
      const ids: string[] = [];
      for (const item of pages[entry]) {
        const fn = typeof item?.fontName === "string" ? item.fontName : "";
        if (fn.length > 0 && !ids.includes(fn)) ids.push(fn);
      }
      if (ids.length === 0) continue;

      const node = pageList[pageIndex]!.dict;
      const keys = tfOrderForPage(pdf, node);
      const fonts = fontResourcesFor(pdf, node);
      if (fonts === undefined) continue;
      // Dedupe the keys by the object they resolve to (pdf.js assigns
      // one id per distinct font OBJECT, while pdf-lib writes a fresh
      // resource key per drawText call — first key per object wins).
      const seenRefs = new Set<string>();
      const seenDicts = new WeakSet<Map<string, PdfObj>>();
      const distinctKeys: string[] = [];
      for (const key of keys) {
        const value = fonts.get(key);
        if (value === undefined) continue; // dangling key
        if (value.k === "ref") {
          const id = `ref ${value.num} ${value.gen}`;
          if (seenRefs.has(id)) continue;
          seenRefs.add(id);
        } else if (value.k === "dict" || value.k === "stream") {
          if (seenDicts.has(value.m)) continue;
          seenDicts.add(value.m);
        } else {
          continue; // not a font dict/ref — skip, honest
        }
        distinctKeys.push(key);
      }
      if (distinctKeys.length !== ids.length) {
        continue; // mismatch (forms / weird streams) → skip, stay honest
      }
      for (let i = 0; i < ids.length; i += 1) {
        const value = fonts.get(distinctKeys[i]!);
        result.set(
          ids[i]!,
          value === undefined ? { bold: false, italic: false } : fontFaceStyle(pdf, value)
        );
      }
    }
  } catch {
    // Any surprise mid-walk keeps whatever was resolved so far.
  }
  return result;
}

/**
 * Maps pdf.js internal font ids → {bold, italic} for the whole document,
 * by correlating each entry's distinct ids (item order) with that entry's
 * ORIGINAL 0-based pdf.js page index (page ranges keep the correlation
 * true — pass one index per page entry). Exported for the smokes, which
 * drive the same enrichment on real fixtures.
 */
export function buildFontStyleMap(
  bytes: Uint8Array,
  pageIndexes: readonly number[],
  pages: readonly StyleMapPage[]
): Promise<Map<string, FontStyleInfo>>;

/** The all-pages form: entry i correlates with pdf.js page i. */
export function buildFontStyleMap(
  bytes: Uint8Array,
  pages: readonly StyleMapPage[]
): Promise<Map<string, FontStyleInfo>>;

export function buildFontStyleMap(
  bytes: Uint8Array,
  a: readonly number[] | readonly StyleMapPage[],
  b?: readonly StyleMapPage[]
): Promise<Map<string, FontStyleInfo>> {
  if (Array.isArray(a) && b !== undefined) {
    return buildStyleMap(bytes, a as readonly number[], b);
  }
  const pages = a as readonly StyleMapPage[];
  return buildStyleMap(
    bytes,
    pages.map((_page, index) => index),
    pages
  );
}

/**
 * Maps pdf.js internal font ids → bold for the whole document (the
 * pdf-to-word form — bold is all Word's OOXML run needs from this walk).
 */
export async function buildFontBoldMap(
  bytes: Uint8Array,
  pages: readonly StyleMapPage[]
): Promise<Map<string, boolean>> {
  const styles = await buildStyleMap(
    bytes,
    pages.map((_page, index) => index),
    pages
  );
  const result = new Map<string, boolean>();
  for (const [id, style] of styles) result.set(id, style.bold);
  return result;
}
