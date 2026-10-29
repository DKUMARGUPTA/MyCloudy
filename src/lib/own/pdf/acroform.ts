/**
 * DocoPDF own PDF micro-engine — the AcroForm READER (P6-p).
 *
 * The mirror of the P6-o builder: walks an EXISTING /AcroForm field tree
 * (catalog → /AcroForm → /Fields → terminals) and reports every terminal
 * field the way pdf-lib's PDFForm.getFields() sees it — kind, fully
 * qualified name, flags, value, options, widgets (with pages + on-values).
 * Semantics were verified line-by-line against pdf-lib 1.17.1
 * (cjs/core/acroform/*, cjs/api/form/*):
 *
 *  - non-terminal classification: any /Kids entry carrying /T (utils.js
 *    isNonTerminalAcroField) → recurse; terminals are visited;
 *  - /FT, /Ff and /V are INHERITABLE through /Parent (PDFAcroField.getIn-
 *    heritableAttribute ascends); /T, /MaxLen and /DA are own-dict entries;
 *  - kind: /Tx text, /Ch combo(131072)?dropdown:optionlist, /Btn pushbutton
 *    (65536, checked FIRST like pdf-lib) ? radio (32768) : checkbox, /Sig
 *    signature; terminals with an unknown /FT are skipped (pdf-lib's
 *    convertToPDFField drops them from getFields());
 *  - widgets: /Kids → the kids (a terminal's kids never carry /T); no /Kids
 *    → the merged field dict IS its own widget (PDFAcroTerminal.getWidgets);
 *  - page mapping: widget /P ref num → listPages refs; fallback: scan each
 *    page's /Annots for the widget's object number; else page 0;
 *  - checkbox checked: /V === the first widget's /AP /N state key ≠ "Off".
 *
 * The file also carries the shared flatten placement math (applyAffine /
 * axialAlignedBounds / composeAppearanceTransform — the pdf.js core/
 * annotation.js getTransformMatrix port that the legacy pdf-lib flatten
 * tool authored; ported VERBATIM so the own-engine flatten tool and the
 * legacy one place appearances identically).
 */

import {
  asArr,
  asDict,
  asNum,
  type PdfObj,
} from "./objects";
import { resolve, type ParsedPdf } from "./parser";
import { latin1 } from "./lexer";
import { listPages } from "./document";

/* ─── shared text-string decode (PDF spec §7.9.2.2) ──────────────────────── */

/** UTF-16BE with the FEFF BOM, else PDFDocEncoding≈latin1 (pdf-lib
 * PDFString.decodeText). The same decoder make-pdf-fillable carried. */
export function decodeTextString(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < b.length; i += 2) {
      out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    }
    return out;
  }
  return latin1(b, 0, b.length);
}

/**
 * Thrown by StampContext.setSourceTextField/setSourceChoice when the text
 * cannot be encoded in the WinAnsi default appearance font (Helvetica) and
 * no embedded TTF was supplied — the parity of pdf-lib's save-time
 * font.encodeText throw. IMPORTANT contract for the fill worker: the /V
 * value IS already written on the field dict when this throws; the fallback
 * is ctx.setNeedAppearances() so the VIEWER regenerates the appearance.
 */
export class WinAnsiError extends Error {
  readonly fieldName: string;
  constructor(fieldName: string, text: string) {
    const hex = text.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
    super(
      `field "${fieldName}" needs a non-WinAnsi appearance (U+${hex ?? "?"}) — ` +
        `pass an embedded TTF or set /NeedAppearances`,
    );
    this.name = "WinAnsiError";
    this.fieldName = fieldName;
  }
}

/* ─── shared flatten placement (pdf.js getTransformMatrix, verbatim port) ── */

/** Affine [a b c d e f] in PDF column-vector convention: p' = M·p. */
export type Affine = [number, number, number, number, number, number];
/** Axis-aligned rectangle [x1 y1 x2 y2] (any corner order). */
export type Quad = [number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

/** Applies an affine matrix to a point. */
export function applyAffine(
  m: Affine,
  point: [number, number]
): [number, number] {
  return [
    m[0] * point[0] + m[2] * point[1] + m[4],
    m[1] * point[0] + m[3] * point[1] + m[5],
  ];
}

/**
 * Composes two affines: `compose(outer, inner)` applies `inner` first, then
 * `outer` (the matrix product outer × inner — how PDF concatenates `cm`).
 */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * Axis-aligned bounds of a /BBox after the appearance /Matrix — pdf.js
 * Util.getAxialAlignedBoundingBox (all four corners transformed, then
 * min/max per axis).
 */
export function axialAlignedBounds(
  bbox: Quad,
  matrix: Affine | null
): Quad {
  const m = matrix ?? IDENTITY_AFFINE;
  const corners: [number, number][] = [
    applyAffine(m, [bbox[0], bbox[1]]),
    applyAffine(m, [bbox[2], bbox[3]]),
    applyAffine(m, [bbox[0], bbox[3]]),
    applyAffine(m, [bbox[2], bbox[1]]),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * The `cm` that places an appearance stream into its annotation rectangle:
 * pdf.js core/annotation.js getTransformMatrix, character for character.
 * The matrix-transformed BBox is scaled + translated onto the /Rect; a
 * degenerate (zero-width/height) transformed box falls back to a pure
 * translation to the rect's lower-left corner.
 */
export function composeAppearanceTransform(
  rect: Quad,
  bbox: Quad,
  matrix: Affine | null
): Affine {
  const [minX, minY, maxX, maxY] = axialAlignedBounds(bbox, matrix);
  if (minX === maxX || minY === maxY) {
    return [1, 0, 0, 1, rect[0], rect[1]];
  }
  const scaleX = (rect[2] - rect[0]) / (maxX - minX);
  const scaleY = (rect[3] - rect[1]) / (maxY - minY);
  return [
    scaleX,
    0,
    0,
    scaleY,
    rect[0] - minX * scaleX,
    rect[1] - minY * scaleY,
  ];
}

/* ─── the reader ─────────────────────────────────────────────────────────── */

export type AcroFieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "optionlist"
  | "signature"
  | "pushbutton";

export interface AcroWidgetInfo {
  /** 0-based SOURCE page index (the /P match, /Annots scan, or 0). */
  page: number;
  /** Normalized-positive widget /Rect (w = |x2−x1|, origin at the min corner). */
  rect: { x: number; y: number; w: number; h: number };
  /** Source object number of the widget dict (null for direct-dict widgets). */
  srcNum: number | null;
  /** The first /AP /N state-map key ≠ "Off" (checkbox/radio on-state). */
  onValue?: string;
  /** The LIVE widget dict — StampContext.setters mutate it in place. */
  dict: PdfObj & { k: "dict" };
}

export interface AcroFieldInfo {
  /** Fully qualified (dot-joined /T path; "" when every /T is missing). */
  name: string;
  kind: AcroFieldKind;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  /** /MaxLen (own dict, pdf-lib PDFAcroText.MaxLen is not inheritable). */
  maxLength: number | null;
  /**
   * text: the /V string (null when absent); checkbox: checked boolean;
   * radio/dropdown/optionlist: the first selected export string (null when
   * nothing is selected / /V is /Off).
   */
  value: string | boolean | null;
  /** The raw selection: radio/dropdown one entry, optionlist may hold many. */
  selected: string[];
  /** Display values (/Opt second element for [export, display] pairs). */
  options: string[];
  widgets: AcroWidgetInfo[];
  /** Source object number of the field dict (null for direct-dict fields). */
  fieldNum: number | null;
  /** The LIVE field dict — StampContext.setters mutate it in place. */
  dict: PdfObj & { k: "dict" };
}

/** /Ff bit values (pdf-lib core/acroform/flags.js — spec tables 221/226/228).
 * Bit POSITION n → value 2^(n-1): read-only = bit 1 (1), required = bit 2 (2). */
const FF_READ_ONLY = 1; // bit 1
const FF_REQUIRED = 1 << 1; // bit 2 = 2
const FF_MULTILINE = 1 << 12; // bit 13 = 4096
const FF_COMBO = 1 << 17; // bit 18 = 131072
const FF_RADIO = 1 << 15; // bit 16 = 32768
const FF_PUSH_BUTTON = 1 << 16; // bit 17 = 65536

const MAX_FIELD_DEPTH = 64;

interface WalkCtx {
  doc: ParsedPdf;
  out: AcroFieldInfo[];
  /** page ref num → page index (listPages is the authority). */
  pageByNum: Map<number, number>;
  /** pages' /Annots ref-nums → page index (the fallback scan). */
  annotsByNum: Map<number, number>;
}

/**
 * Every terminal field of the document's /AcroForm, in tree order — the
 * parity of pdf-lib PDFForm.getFields() (kinds, names, values, options,
 * widgets, pages). A document without /AcroForm (or with a non-array
 * /Fields, or a hostile tree) yields [] — this walk never throws.
 */
export function readAcroFormFields(doc: ParsedPdf): AcroFieldInfo[] {
  try {
    return readAcroFormFieldsInner(doc);
  } catch {
    return [];
  }
}

function readAcroFormFieldsInner(doc: ParsedPdf): AcroFieldInfo[] {
  const rootObj = doc.trailer.get("Root");
  const root = rootObj ? resolve(doc, rootObj) : undefined;
  const rootMap = root && (root.k === "dict" || root.k === "stream") ? root.m : undefined;
  if (!rootMap) return [];
  const acroObj = rootMap.get("AcroForm");
  if (acroObj === undefined) return [];
  const acro = resolve(doc, acroObj);
  const acroMap = acro && (acro.k === "dict" || acro.k === "stream") ? acro.m : undefined;
  if (!acroMap) return [];
  const fieldsObj = acroMap.get("Fields");
  const fieldsVal = fieldsObj ? resolve(doc, fieldsObj) : undefined;
  if (!fieldsVal || fieldsVal.k !== "arr") return [];

  const ctx: WalkCtx = {
    doc,
    out: [],
    pageByNum: new Map(),
    annotsByNum: new Map(),
  };
  // Page facts (listPages already succeeded for StampContext loads; the
  // standalone call wraps failures into empty maps → /Annots-free docs
  // still resolve widget pages via the /P refs we may see).
  try {
    const pages = listPages(doc);
    pages.forEach((p, i) => ctx.pageByNum.set(p.ref.num, i));
    pages.forEach((p, i) => {
      const annots = p.dict.get("Annots");
      const list = annots ? resolve(doc, annots) : undefined;
      if (list && list.k === "arr") {
        for (const item of list.items) {
          if (item.k === "ref" && !ctx.annotsByNum.has(item.num)) {
            ctx.annotsByNum.set(item.num, i);
          }
        }
      }
    });
  } catch {
    // unreadable page tree → every widget falls back to /P-matching or page 0
  }

  for (const fieldObj of fieldsVal.items) {
    const fieldRef = fieldObj.k === "ref" ? fieldObj : undefined;
    walkField(ctx, resolve(doc, fieldObj), fieldRef?.num ?? null, "", 0);
  }
  return ctx.out;
}

/** One /Fields tree node: non-terminal (any kid with /T) → recurse; else emit. */
function walkField(
  ctx: WalkCtx,
  obj: PdfObj | undefined,
  srcNum: number | null,
  parentName: string,
  depth: number,
): void {
  const dict = obj && (obj.k === "dict" || obj.k === "stream") ? obj.m : undefined;
  if (!dict || depth > MAX_FIELD_DEPTH) return;

  const partial = decodeT(dict.get("T"));
  const fqn = parentName ? `${parentName}.${partial}` : partial;

  // pdf-lib isNonTerminalAcroField: any /Kids entry carrying /T.
  const kidsVal = dict.get("Kids");
  const kidsArr = kidsVal ? resolve(ctx.doc, kidsVal) : undefined;
  const kids = kidsArr && kidsArr.k === "arr" ? kidsArr.items : undefined;
  let nonTerminal = false;
  if (kids) {
    for (const kid of kids) {
      const kidDict = asDict(resolve(ctx.doc, kid));
      if (kidDict !== undefined && kidDict.has("T")) {
        nonTerminal = true;
        break;
      }
    }
  }
  if (nonTerminal) {
    for (const kid of kids!) {
      const kidRef = kid.k === "ref" ? kid : undefined;
      walkField(ctx, resolve(ctx.doc, kid), kidRef?.num ?? null, fqn, depth + 1);
    }
    return;
  }

  const fieldObj2: PdfObj & { k: "dict" } = { k: "dict", m: dict };
  const info = readTerminal(ctx, fieldObj2, srcNum, fqn);
  if (info) ctx.out.push(info);
}

function readTerminal(
  ctx: WalkCtx,
  field: PdfObj & { k: "dict" },
  srcNum: number | null,
  fqn: string,
): AcroFieldInfo | null {
  // /FT is inheritable (a merged field's kids may carry it, hierarchical
  // forms put it above the terminal). Unknown → skip (pdf-lib getFields
  // drops those terminals).
  const ft = asNameLike(inheritable(ctx.doc, field.m, "FT"));
  const ff = asNum(inheritable(ctx.doc, field.m, "Ff")) ?? 0;

  let kind: AcroFieldKind | null = null;
  if (ft === "Tx") kind = "text";
  else if (ft === "Ch") kind = (ff & FF_COMBO) !== 0 ? "dropdown" : "optionlist";
  else if (ft === "Sig") kind = "signature";
  else if (ft === "Btn") {
    // pdf-lib order: pushbutton, then radio, else checkbox.
    kind =
      (ff & FF_PUSH_BUTTON) !== 0 ? "pushbutton"
        : (ff & FF_RADIO) !== 0 ? "radio"
          : "checkbox";
  }
  if (kind === null) return null;

  // Widgets: /Kids → the kids (terminals' kids never carry /T); NO kids or
  // an EMPTY /Kids array → the merged field dict is its own single widget
  // (pdf-lib PDFAcroTerminal.getWidgets: size() === 0 → the self-widget).
  const widgets: AcroWidgetInfo[] = [];
  const kidsVal = field.m.get("Kids");
  const kidsArr = kidsVal ? resolve(ctx.doc, kidsVal) : undefined;
  const kids =
    kidsArr && kidsArr.k === "arr" && kidsArr.items.length > 0
      ? kidsArr.items
      : undefined;
  if (kids) {
    for (const kid of kids) {
      const kidRef = kid.k === "ref" ? kid : undefined;
      const kidObj = resolve(ctx.doc, kid);
      const kidDict =
        kidObj && (kidObj.k === "dict" || kidObj.k === "stream") ? kidObj.m : undefined;
      if (!kidDict) continue;
      widgets.push(
        readWidget(ctx, { k: "dict", m: kidDict }, kidRef?.num ?? null),
      );
    }
  } else {
    widgets.push(readWidget(ctx, field, srcNum));
  }

  const valueObj = inheritable(ctx.doc, field.m, "V");
  const v = valueObj ? resolve(ctx.doc, valueObj) : undefined;

  // Options first — the radio value resolution maps through them.
  const options = readOptions(ctx, field.m, kind, widgets);

  let value: string | boolean | null = null;
  let selected: string[] = [];
  if (kind === "text") {
    if (v && (v.k === "str" || v.k === "hstr" || v.k === "lstr")) {
      value = decodeTextString(v.b);
    }
  } else if (kind === "checkbox") {
    const onValue = widgets[0]?.onValue;
    value =
      !!onValue && v?.k === "name" && v.v === onValue;
  } else if (kind === "radio") {
    if (v?.k === "name") {
      // `selected` carries the raw /V state (even "Off"); `value` follows
      // pdf-lib getSelected: the widget whose on-state IS /V maps to its
      // /Opt export value (pdf-lib's on-state names are the /Opt INDICES).
      selected = [v.v];
      if (v.v === "Off") {
        value = null;
      } else {
        const hit = widgets.findIndex((w) => w.onValue === v.v);
        value = hit >= 0 ? (options[hit] ?? v.v) : v.v;
      }
    }
  } else {
    // dropdown / optionlist: /V is a single string or an ARRAY of strings.
    const vals: string[] = [];
    if (v && (v.k === "str" || v.k === "hstr" || v.k === "lstr")) {
      vals.push(decodeTextString(v.b));
    } else if (v && v.k === "arr") {
      for (const item of v.items) {
        const it = resolve(ctx.doc, item);
        if (it && (it.k === "str" || it.k === "hstr" || it.k === "lstr")) {
          vals.push(decodeTextString(it.b));
        }
      }
    }
    selected = vals;
    value = vals.length > 0 ? (vals[0] as string) : null;
  }

  return {
    name: fqn,
    kind,
    readOnly: (ff & FF_READ_ONLY) !== 0,
    required: (ff & FF_REQUIRED) !== 0,
    multiline: (ff & FF_MULTILINE) !== 0,
    maxLength: asNum(field.m.get("MaxLen")) ?? null,
    value,
    selected,
    options,
    widgets,
    fieldNum: srcNum,
    dict: field,
  };
}

/** One widget annot: page, normalized /Rect, on-state. */
function readWidget(
  ctx: WalkCtx,
  widget: PdfObj & { k: "dict" },
  srcNum: number | null,
): AcroWidgetInfo {
  const m = widget.m;
  // /Rect → normalized positive box.
  const rectItems = asArr(resolve(ctx.doc, m.get("Rect")));
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  if (rectItems && rectItems.length === 4) {
    const n = rectItems.map(asNum);
    if (n.every((v) => v !== undefined && Number.isFinite(v))) {
      const x1 = n[0]!;
      const y1 = n[1]!;
      const x2 = n[2]!;
      const y2 = n[3]!;
      rect = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      };
    }
  }
  // Page: /P ref num against listPages, else the /Annots scan, else 0.
  let page = 0;
  const p = m.get("P");
  const pPage = p && p.k === "ref" ? ctx.pageByNum.get(p.num) : undefined;
  if (pPage !== undefined) page = pPage;
  else if (srcNum !== null) {
    const found = ctx.annotsByNum.get(srcNum);
    if (found !== undefined) page = found;
  }
  return {
    page,
    rect,
    srcNum,
    onValue: readOnValue(ctx, m),
    dict: widget,
  };
}

/** The first /AP /N state-map key ≠ "Off" (PDFWidgetAnnotation.getOnValue). */
function readOnValue(ctx: WalkCtx, widgetMap: Map<string, PdfObj>): string | undefined {
  const apVal = widgetMap.get("AP");
  const ap = apVal ? resolve(ctx.doc, apVal) : undefined;
  const apMap = ap && (ap.k === "dict" || ap.k === "stream") ? ap.m : undefined;
  if (!apMap) return undefined;
  const nVal = apMap.get("N");
  const n = nVal ? resolve(ctx.doc, nVal) : undefined;
  if (!n || n.k !== "dict") return undefined; // single-stream APs have no states
  for (const [key, value] of n.m) {
    if (key !== "Off" && value !== undefined) return key;
  }
  return undefined;
}

/**
 * /Opt for Ch kinds: display values — plain strings, or the SECOND element
 * of [export, display] pairs (pdf-lib PDFAcroChoice.getOptions). For radio
 * groups: the /Opt export values, falling back to the widget on-state names
 * (pdf-lib PDFRadioGroup.getOptions → getExportValues() ?? getOnValues()).
 */
function readOptions(
  ctx: WalkCtx,
  fieldMap: Map<string, PdfObj>,
  kind: AcroFieldKind,
  widgets: AcroWidgetInfo[],
): string[] {
  const out: string[] = [];
  const optVal = fieldMap.get("Opt");
  const opt = optVal ? resolve(ctx.doc, optVal) : undefined;
  if (opt && (opt.k === "str" || opt.k === "hstr" || opt.k === "lstr")) {
    out.push(decodeTextString(opt.b));
    return out;
  }
  if (opt && opt.k === "arr") {
    for (const item of opt.items) {
      const it = resolve(ctx.doc, item);
      if (it && (it.k === "str" || it.k === "hstr" || it.k === "lstr")) {
        out.push(decodeTextString(it.b));
      } else if (it && it.k === "arr") {
        // [export, display] pair → display (single-element → the export).
        const display = it.items.length > 1 ? it.items[1] : it.items[0];
        const d = display ? resolve(ctx.doc, display) : undefined;
        if (d && (d.k === "str" || d.k === "hstr" || d.k === "lstr")) {
          out.push(decodeTextString(d.b));
        }
      }
    }
  }
  if (out.length > 0 || kind !== "radio") return out;
  // Radio without /Opt: the on-state names ARE the options (pdf-lib's
  // getOnValues fallback — many real forms ship no /Opt at all).
  const seen = new Set<string>();
  for (const widget of widgets) {
    if (widget.onValue && !seen.has(widget.onValue)) seen.add(widget.onValue);
  }
  return [...seen];
}

/* ─── inheritable field attributes ──────────────────────────────────────── */

/** Ascends /Parent (pdf-lib getInheritableAttribute): own value first. */
function inheritable(
  doc: ParsedPdf,
  dict: Map<string, PdfObj>,
  key: string,
): PdfObj | undefined {
  let node: Map<string, PdfObj> | undefined = dict;
  for (let depth = 0; node && depth <= MAX_FIELD_DEPTH; depth += 1) {
    const own = node.get(key);
    if (own !== undefined) return own;
    const parent = node.get("Parent");
    const resolved = parent ? resolve(doc, parent) : undefined;
    node =
      resolved && (resolved.k === "dict" || resolved.k === "stream")
        ? resolved.m
        : undefined;
  }
  return undefined;
}

/* ─── /DA parsing (pdf-lib api/form/appearances.js) ──────────────────────── */

// Examples:
//   `/Helv 12 Tf` -> ['Helv', '12']
//   `/HeBo 8.00 Tf` -> ['HeBo', '8.00']
//   `/HeBo Tf` -> ['HeBo', undefined]
const TF_REGEX = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]*(\d*\.\d+|\d+)?[\0\t\n\f\r ]+Tf/;
// Examples:
//   `0.3 g` -> ['0.3', 'g']
//   `0.3 1 .3 rg` -> ['0.3', '1', '.3', 'rg']
//   `0.3 1 .3 0 k` -> ['0.3', '1', '.3', '0', 'k']
const COLOR_REGEX =
  /(\d*\.\d+|\d+)[\0\t\n\f\r ]*(\d*\.\d+|\d+)?[\0\t\n\f\r ]*(\d*\.\d+|\d+)?[\0\t\n\f\r ]*(\d*\.\d+|\d+)?[\0\t\n\f\r ]+(g|rg|k)/;

function lastMatch(text: string, regex: RegExp): RegExpExecArray | null {
  let found: RegExpExecArray | null = null;
  // Always global — without /g, exec() returns the same match forever and
  // this loop never terminates (the zero-width guard advances lastIndex).
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found = m;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return found;
}

/** Decoded /DA string of a dict (own entry only, pdf-lib DA()). */
export function readDaString(dict: Map<string, PdfObj> | undefined, doc: ParsedPdf): string {
  if (!dict) return "";
  const da = dict.get("DA");
  const v = da ? resolve(doc, da) : undefined;
  if (v && (v.k === "str" || v.k === "hstr" || v.k === "lstr")) {
    return decodeTextString(v.b);
  }
  return "";
}

/** pdf-lib getDefaultFontSize: the LAST `<font> <size> Tf` in the DA. */
export function parseDaFontSize(da: string): number | undefined {
  const m = lastMatch(da, TF_REGEX);
  if (!m) return undefined;
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : undefined;
}

/** pdf-lib getDefaultColor: the LAST color op in the DA, verbatim (e.g.
 * "0.3 1 .3 rg" / "0.5 g" / "0 0 0 1 k"); undefined when absent. */
export function parseDaColorOp(da: string): string | undefined {
  const m = lastMatch(da, COLOR_REGEX);
  return m ? m[0] : undefined;
}

/* ─── small shared reads ─────────────────────────────────────────────────── */

function decodeT(tObj: PdfObj | undefined): string {
  if (tObj && (tObj.k === "str" || tObj.k === "hstr" || tObj.k === "lstr")) {
    return decodeTextString(tObj.b);
  }
  return "";
}

function asNameLike(o: PdfObj | undefined): string | undefined {
  return o && o.k === "name" ? o.v : undefined;
}
