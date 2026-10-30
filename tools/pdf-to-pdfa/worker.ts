import { unzlibSync, zlibSync } from "@/lib/own/zip";
import {
  PdfError,
  arr,
  asArr,
  asDict,
  asName,
  asNum,
  catalogDict,
  decodeTextString,
  dget,
  hstr,
  listPages,
  lstr,
  name,
  newDict,
  num,
  parsePdf,
  ref,
  resolve,
  resolveTrailerRef,
  rewriteDocument,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
} from "@/lib/own/pdf";

import type { OptionValues } from "@/lib/tools/config-types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import {
  PA_CODES,
  STANDARD14_ASSETS,
  afmOf,
  afmWidthsBuiltin,
  afmWidthsWinAnsi,
  buildPdfaXmpPacket,
  buildReportText,
  buildSrgbIccProfile,
  isStandard14BaseFont,
  labelOf,
  latin1Of,
  normalizeContentStreamColors,
  parsePdfaRun,
  pdfaFileName,
  reportFileName,
  sniffIsPdf,
  type CsKind,
  type CsMap,
  type PdfaTarget,
} from "./model";
import { PDFA_TARGET_INFO } from "./types";
import type { PdfaChangeReport, PdfaDetail } from "./types";

/**
 * PDF to PDF/A worker (RB7-a, the 96th tool, optimize — 100% on-device).
 * OWN-ENGINE port (P6-v-b): the whole pipeline rides the own parser +
 * rewriteDocument seam — zero pdf-lib at runtime.
 *
 * The conversion pipeline (types.ts §"the honest conversion pipeline"):
 *
 *  1. gate: empty / oversize / non-PDF / encrypted inputs are rejected
 *     before anything is touched (parsePdf is strict — an /Encrypt
 *     dictionary refuses with the typed encrypted error, and PDF/A
 *     forbids it);
 *  2. transparency: soft masks + constant alpha are detected per page —
 *     PDF/A-1b forbids them, so the run is REJECTED (a naive flatten would
 *     silently alter rendering); -2b/-3b keep them and the report says so;
 *  3. fonts: every font USED by page content is audited — embedded ones
 *     pass through untouched, standard-14 stay unembedded for -1b (the
 *     spec's only font exception) and get a metric-compatible substitute
 *     program for -2b/-3b (self-hosted pdf.js assets, /FontFile2 for the
 *     Liberation TTFs, /FontFile3 /Type1C for the Foxit CFFs, /Widths
 *     rewritten from the canonical AFM), anything else → honest reject
 *     with the page list;
 *  4. colors: every page + Form XObject content stream is inflated and
 *     run through the model's tokenizer/normalizer (g/G/k/K + gray/CMYK
 *     cs/CS sc/scn → DeviceRGB), then re-deflated at level 9;
 *  5. forbidden content: /Names/JavaScript, /OpenAction +
 *     /AA dictionaries (JS/Launch/Sound/Movie/GoToR/GoToE/Rendition) and
 *     multimedia annotations are REMOVED (each counted); embedded files
 *     are dropped for -1b/-2b and kept + /AFRelationship-patched for -3b;
 *  6. metadata: a fresh XMP packet (dc:title from /Info + pdfaid:part +
 *     conformance B) becomes the catalog /Metadata; a REAL hand-rolled
 *     sRGB ICC v2.1 profile becomes the /DestOutputProfile of a
 *     /GTS_PDFA1 OutputIntent; a trailer /ID is ensured; the header is
 *     stamped %PDF-1.4 for -1b and %PDF-1.7 for -2b/-3b;
 *  7. rewrite WITHOUT object streams (flat xref — the -b honest layout),
 *     then the plain-text change report.
 *
 * Output: <base>-pdfa-<level>.pdf + <base>-pdfa-<level>-report.txt.
 *
 * Error mapping:
 *   pa.errEmptyFile / pa.errTooLarge / pa.errNotPdf   the input gates
 *   tool.errorEncrypted                               /Encrypt present
 *   pa.errTransparency                                soft masks/alpha on -1b
 *   pa.errUnembeddableFonts                           non-standard-14 unembedded
 *   pa.errConvertFailed                               the rewrite itself failed
 *   tool.errorCorrupt / tool.errorGeneric             load failure / no file
 */

const PRODUCER = "DocoPDF";

/** Action /S names forbidden in PDF/A at every level (types.ts §7). */
const FORBIDDEN_ACTIONS = new Set([
  "JS",
  "JavaScript",
  "Launch",
  "Sound",
  "Movie",
  "GoToR",
  "GoToE",
  "Rendition",
]);

/** Annotation subtypes that are multimedia (removed, not repaired). */
const MULTIMEDIA_SUBTYPES = new Set([
  "Screen",
  "Movie",
  "Sound",
  "RichMedia",
  "3D",
]);

/** Honest recursion cap for the form-XObject tree walk. */
const MAX_FORM_DEPTH = 24;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * latin1Of's byte-exact inverse: one byte per char (codes 0–255).
 * TextEncoder is UTF-8 — it would CORRUPT every high byte a content
 * stream legitimately carries outside the rewritten operator regions
 * (literal strings, preserved inline-image bodies). P6-v-b fix: the
 * re-encode is now byte-safe where the pdf-lib port round-tripped
 * through UTF-8.
 */
function latin1BytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** The dict of a dict-or-stream object (both carry an entry map). */
function mapOf(o: PdfObj | undefined): Map<string, PdfObj> | undefined {
  if (o === undefined) return undefined;
  return o.k === "dict" || o.k === "stream" ? o.m : undefined;
}

/* ------------------------------------------------------------------ */
/* Standard-14 asset loading (self-hosted, this origin)                */
/* ------------------------------------------------------------------ */

/**
 * Absolute URL for a public/ asset, resolved against the worker's REAL
 * base (the loadDevanagari recipe — Turbopack serves workers from blob:
 * URLs where a relative fetch throws "Failed to parse URL").
 */
function assetUrl(path: string): string {
  try {
    const viaLocation = new URL(path, self.location.href);
    if (
      viaLocation.protocol === "http:" ||
      viaLocation.protocol === "https:"
    ) {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — recover the origin from the blob URL
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

const fontAssetCache = new Map<string, Promise<Uint8Array>>();

/** Fetches one standard-font program once per worker lifetime. */
function loadFontAsset(path: string): Promise<Uint8Array> {
  const cached = fontAssetCache.get(path);
  if (cached) return cached;
  const promise = fetch(assetUrl(path))
    .then(async (res) => {
      if (!res.ok) throw new Error(`standard-font-fetch-${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })
    .catch((error: unknown) => {
      fontAssetCache.delete(path); // retry on the next run
      throw error;
    });
  fontAssetCache.set(path, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/* Own-engine walk helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * The node's /Resources, walking the /Parent chain (spec inheritance).
 * Works for page nodes AND Form XObject nodes (forms carry their own
 * /Resources directly; the /Parent lookup simply stops).
 */
function resourcesOf(
  doc: ParsedPdf,
  node: Map<string, PdfObj>
): Map<string, PdfObj> | undefined {
  let current: Map<string, PdfObj> | undefined = node;
  for (let hop = 0; current !== undefined && hop < 32; hop += 1) {
    const resRaw = current.get("Resources");
    const res = resRaw !== undefined ? resolve(doc, resRaw) : undefined;
    const resMap = mapOf(res);
    if (resMap !== undefined) return resMap;
    const parentRaw = current.get("Parent");
    const parent =
      parentRaw !== undefined ? resolve(doc, parentRaw) : undefined;
    current = mapOf(parent);
  }
  return undefined;
}

/** Resolves a resource value to a raw stream object (or undefined). */
function lookupStream(
  doc: ParsedPdf,
  raw: PdfObj | undefined
): Extract<PdfObj, { k: "stream" }> | undefined {
  const obj = resolve(doc, raw);
  return obj !== undefined && obj.k === "stream" ? obj : undefined;
}

interface WalkState {
  /** Form XObjects already visited (cycle guard). */
  seenForms: Set<number>;
  /** Content stream refs (pages + forms). */
  streamRefs: Array<{ num: number }>;
}

/** Collects the page's content stream + every Form XObject, recursively. */
function walkPageStreams(
  doc: ParsedPdf,
  pageNode: Map<string, PdfObj>,
  state: WalkState,
  depth: number
): void {
  if (depth > MAX_FORM_DEPTH) return;

  // /Contents: a single ref or an array of refs
  const contentsRaw = pageNode.get("Contents");
  if (contentsRaw !== undefined && contentsRaw.k === "ref") {
    state.streamRefs.push({ num: contentsRaw.num });
  } else {
    const contentsArr = asArr(resolve(doc, contentsRaw));
    if (contentsArr !== undefined) {
      for (const el of contentsArr) {
        if (el.k === "ref") state.streamRefs.push({ num: el.num });
      }
    }
  }

  const resources = resourcesOf(doc, pageNode);
  if (resources === undefined) return;
  const xobjs = asDict(resolve(doc, resources.get("XObject")));
  if (xobjs === undefined) return;
  for (const value of xobjs.values()) {
    const stream = lookupStream(doc, value);
    if (stream === undefined) continue;
    if (asName(stream.m.get("Subtype")) !== "Form") continue;
    const key =
      value.k === "ref"
        ? value.num
        : stream.m.size * 31 + stream.raw.length;
    if (state.seenForms.has(key)) continue;
    state.seenForms.add(key);
    // recurse into the form's own resources (nested forms + shared streams)
    walkPageStreams(doc, stream.m, state, depth + 1);
    if (value.k === "ref") state.streamRefs.push({ num: value.num });
  }
}

/* ------------------------------------------------------------------ */
/* 1. Transparency scan (reject -1b, report for -2b/-3b)                */
/* ------------------------------------------------------------------ */

interface TransparencyFindings {
  softMaskPages: number[];
  alphaPages: number[];
}

function scanTransparency(
  doc: ParsedPdf,
  pages: PdfPageInfo[]
): TransparencyFindings {
  const softMaskPages: number[] = [];
  const alphaPages: number[] = [];
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p]!;
    const resources = resourcesOf(doc, page.dict);
    if (resources === undefined) continue;
    let softMask = false;
    let alpha = false;

    const gs = asDict(resolve(doc, resources.get("ExtGState")));
    if (gs !== undefined) {
      for (const value of gs.values()) {
        const dict = asDict(resolve(doc, value));
        if (dict === undefined) continue;
        const smask = dict.get("SMask");
        if (smask !== undefined && asName(smask) !== "None") {
          softMask = true;
        }
        for (const key of ["ca", "CA"] as const) {
          const v = asNum(dict.get(key));
          if (v !== undefined && v < 1) alpha = true;
        }
      }
    }
    // images with a soft mask put transparency on the page too
    const xobjs = asDict(resolve(doc, resources.get("XObject")));
    if (xobjs !== undefined) {
      for (const value of xobjs.values()) {
        const stream = lookupStream(doc, value);
        if (stream === undefined) continue;
        const smask = stream.m.get("SMask");
        if (smask !== undefined && asName(smask) !== "None") {
          softMask = true;
        }
      }
    }
    if (softMask) softMaskPages.push(p);
    if (alpha) alphaPages.push(p);
  }
  return { softMaskPages, alphaPages };
}

/* ------------------------------------------------------------------ */
/* 2. Font audit + standard-14 substitution                             */
/* ------------------------------------------------------------------ */

interface FontAudit {
  /** Fonts already embedded (deduped by object number). */
  embeddedPassed: number;
  /** Standard-14 fonts kept unembedded (the -1b allowance). */
  standardKept: number;
  /** Standard-14 fonts a substitute program was embedded for. */
  standardEmbedded: number;
  /** Honest per-font substitution notes. */
  notes: string[];
  /** Non-embeddable fonts: base name → pages (0-based, unique). */
  unembeddable: Map<string, number[]>;
  /** Dicts the substitution must patch (standard-14, deduped). */
  pending: Array<{
    refNum: number | null;
    dict: Map<string, PdfObj>;
    baseFont: string;
  }>;
}

/** A font dict's FontDescriptor (Type0 → DescendantFonts' descriptor). */
function fontDescriptorOf(
  doc: ParsedPdf,
  fontDict: Map<string, PdfObj>
): Map<string, PdfObj> | undefined {
  const direct = asDict(resolve(doc, fontDict.get("FontDescriptor")));
  if (direct !== undefined) return direct;
  const descendants = asArr(resolve(doc, fontDict.get("DescendantFonts")));
  if (descendants !== undefined && descendants.length > 0) {
    const child = asDict(resolve(doc, descendants[0]));
    if (child !== undefined) {
      return asDict(resolve(doc, child.get("FontDescriptor")));
    }
  }
  return undefined;
}

function descriptorHasFile(descriptor: Map<string, PdfObj> | undefined): boolean {
  if (descriptor === undefined) return false;
  return (
    descriptor.get("FontFile") !== undefined ||
    descriptor.get("FontFile2") !== undefined ||
    descriptor.get("FontFile3") !== undefined
  );
}

/**
 * Collects every /Resources scope a page's content can draw from: the
 * page's own resources (with /Parent inheritance) plus the resources of
 * every Form XObject, recursively (a form can carry its own fonts).
 */
function resourceScopesOf(
  doc: ParsedPdf,
  pageNode: Map<string, PdfObj>,
  seen: Set<number>,
  depth: number
): Array<Map<string, PdfObj>> {
  if (depth > MAX_FORM_DEPTH) return [];
  const scopes: Array<Map<string, PdfObj>> = [];
  const resources = resourcesOf(doc, pageNode);
  if (resources !== undefined) {
    scopes.push(resources);
    const xobjs = asDict(resolve(doc, resources.get("XObject")));
    if (xobjs !== undefined) {
      for (const value of xobjs.values()) {
        const stream = lookupStream(doc, value);
        if (stream === undefined) continue;
        if (asName(stream.m.get("Subtype")) !== "Form") continue;
        const key =
          value.k === "ref"
            ? value.num
            : stream.m.size * 31 + stream.raw.length;
        if (seen.has(key)) continue;
        seen.add(key);
        scopes.push(...resourceScopesOf(doc, stream.m, seen, depth + 1));
      }
    }
  }
  return scopes;
}

/**
 * Audits the fonts of every resource scope (page + forms): embedded ones
 * pass, standard-14 pend substitution, anything else is an honest reject
 * with its page list. Resource PRESENCE counts as use — annotation /AP
 * streams and OCG content can reference a resource font with no plain Tf
 * in the page stream (the Ghostscript pdfa-device criterion).
 */
function auditFonts(doc: ParsedPdf, pages: PdfPageInfo[]): FontAudit {
  const audit: FontAudit = {
    embeddedPassed: 0,
    standardKept: 0,
    standardEmbedded: 0,
    notes: [],
    unembeddable: new Map(),
    pending: [],
  };
  const seen = new Set<number>();
  for (let p = 0; p < pages.length; p += 1) {
    const scopes = resourceScopesOf(doc, pages[p]!.dict, new Set(), 0);
    for (const resources of scopes) {
      const fonts = asDict(resolve(doc, resources.get("Font")));
      if (fonts === undefined) continue;
      for (const value of fonts.values()) {
        const dict = asDict(resolve(doc, value));
        if (dict === undefined) continue;
        const subtype = dict.get("Subtype");
        if (subtype === undefined) continue; // not a usable font — nothing draws
        const refNum = value.k === "ref" ? value.num : null;
        if (refNum !== null && seen.has(refNum)) continue;
        if (refNum !== null) seen.add(refNum);

        if (descriptorHasFile(fontDescriptorOf(doc, dict))) {
          audit.embeddedPassed += 1;
          continue;
        }
        const baseFont = rawBaseFontOf(dict.get("BaseFont"));
        if (baseFont === "") {
          pushUnembeddable(audit, "(unnamed font)", p);
          continue;
        }
        if (isStandard14BaseFont(baseFont)) {
          audit.pending.push({ refNum, dict, baseFont });
        } else {
          pushUnembeddable(audit, baseFont, p);
        }
      }
    }
  }
  return audit;
}

/** The BaseFont name, bare (own names carry no leading slash). */
function rawBaseFontOf(raw: PdfObj | undefined): string {
  const n = asName(raw);
  if (n !== undefined) return n;
  if (raw === undefined) return "";
  return String(raw).replace(/^\//, "");
}

function pushUnembeddable(
  audit: FontAudit,
  name: string,
  pageIndex: number
): void {
  const list = audit.unembeddable.get(name);
  if (list === undefined) {
    audit.unembeddable.set(name, [pageIndex]);
  } else if (!list.includes(pageIndex)) {
    list.push(pageIndex);
  }
}

/** The unembeddable-font rejection detail ("Font (p1, p2); …"). */
function unembeddableDetail(audit: FontAudit): string {
  return [...audit.unembeddable.entries()]
    .map(
      ([name, pages]) =>
        `${name} (p${pages.map((p) => p + 1).join(", p")})`
    )
    .join("; ")
    .slice(0, 300);
}

/**
 * Embeds the metric-compatible substitute program for one standard-14
 * font dict, IN PLACE: a fresh /FontDescriptor (canonical AFM metrics)
 * carrying /FontFile2 (Liberation TTFs) or /FontFile3 /Type1C (Foxit CFF
 * programs), and /Widths rewritten from the same AFM so the program and
 * the widths agree. Every resource ref survives — text strings keep
 * rendering with the same codes.
 *
 * The fresh objects ride rewriteDocument's extraObjects (numbered ABOVE
 * every source object); the font dict itself is patched in place, so the
 * rewrite serializes the patched graph.
 */
async function embedStandard14(
  entry: {
    refNum: number | null;
    dict: Map<string, PdfObj>;
    baseFont: string;
  },
  fileNums: Map<string, number>,
  extras: Array<{ num: number; obj: PdfObj }>,
  alloc: () => number
): Promise<void> {
  const asset = STANDARD14_ASSETS[entry.baseFont];
  if (asset === undefined) return;
  const metrics = afmOf(entry.baseFont);
  if (metrics === null) return; // cannot happen (isStandard14BaseFont)

  const program = await loadFontAsset(asset.file);

  // the font-file stream is shared between fonts with the same base
  let fileNum = fileNums.get(entry.baseFont);
  if (fileNum === undefined) {
    const fileDict = newDict();
    if (asset.kind === "ttf") {
      fileDict.m.set("Length1", num(program.length));
    } else {
      fileDict.m.set("Subtype", name("Type1C"));
      fileDict.m.set("Length1", num(program.length));
    }
    fileNum = alloc();
    extras.push({
      num: fileNum,
      obj: { k: "stream", m: fileDict.m, raw: program },
    });
    fileNums.set(entry.baseFont, fileNum);
  }

  const descriptor = newDict();
  descriptor.m.set("Type", name("FontDescriptor"));
  descriptor.m.set("FontName", name(entry.baseFont));
  descriptor.m.set(
    "Flags",
    num(
      entry.baseFont === "Symbol" || entry.baseFont === "ZapfDingbats"
        ? 4 // symbolic — they keep their built-in encodings
        : 32 // nonsymbolic — WinAnsi/Standard via /Encoding
    )
  );
  descriptor.m.set(
    "FontBBox",
    arr(...metrics.bbox.map((n) => num(n)))
  );
  descriptor.m.set("ItalicAngle", num(metrics.italicAngle));
  if (metrics.ascender !== null) {
    descriptor.m.set("Ascent", num(metrics.ascender));
  }
  if (metrics.descender !== null) {
    descriptor.m.set("Descent", num(metrics.descender));
  }
  if (metrics.capHeight !== null) {
    descriptor.m.set("CapHeight", num(metrics.capHeight));
  }
  if (metrics.xHeight !== null) {
    descriptor.m.set("XHeight", num(metrics.xHeight));
  }
  descriptor.m.set(
    "StemV",
    num(metrics.stdVW > 0 ? metrics.stdVW : 80)
  );
  descriptor.m.set(
    asset.kind === "ttf" ? "FontFile2" : "FontFile3",
    ref(fileNum)
  );
  const descriptorNum = alloc();
  extras.push({ num: descriptorNum, obj: descriptor });
  entry.dict.set("FontDescriptor", ref(descriptorNum));

  // /Widths from the SAME canonical AFM (the substitute programs are
  // metric-compatible with it — that is their whole purpose).
  const isSymbolic =
    entry.baseFont === "Symbol" || entry.baseFont === "ZapfDingbats";
  const widths = isSymbolic
    ? afmWidthsBuiltin(entry.baseFont)
    : afmWidthsWinAnsi(entry.baseFont);
  entry.dict.set("FirstChar", num(widths.first));
  entry.dict.set("LastChar", num(widths.last));
  entry.dict.set(
    "Widths",
    arr(...widths.widths.map((w) => num(w)))
  );
}

/* ------------------------------------------------------------------ */
/* 3. Color normalization (the model's normalizer over real streams)    */
/* ------------------------------------------------------------------ */

/** Classifies one resource /ColorSpace entry for the normalizer map. */
function csKindOfResource(
  doc: ParsedPdf,
  value: PdfObj | undefined
): CsKind | undefined {
  const nameV = asName(value);
  if (nameV !== undefined) {
    switch (nameV) {
      case "DeviceGray":
      case "G":
      case "CalGray":
        return { comps: 1, rgb: false };
      case "DeviceRGB":
      case "RGB":
      case "CalRGB":
        return { comps: 3, rgb: true };
      case "DeviceCMYK":
      case "CMYK":
        return { comps: 4, rgb: false };
      default:
        return undefined; // an unknown bare name — let csKindOf decide
    }
  }
  const valueArr = asArr(resolve(doc, value));
  if (valueArr !== undefined || value?.k === "ref") {
    if (valueArr === undefined || valueArr.length < 1) {
      return { special: "unknown" };
    }
    const familyName = asName(valueArr[0]) ?? String(valueArr[0]);
    if (familyName === "ICCBased") {
      const stream = lookupStream(doc, valueArr[1]);
      const n = asNum(stream?.m.get("N"));
      if (n !== undefined) {
        if (n === 1) return { comps: 1, rgb: false };
        if (n === 3) return { comps: 3, rgb: true };
        if (n === 4) return { comps: 4, rgb: false };
      }
      return { special: "unknown" };
    }
    if (familyName === "CalRGB") return { comps: 3, rgb: true };
    if (familyName === "CalGray") return { comps: 1, rgb: false };
    if (familyName === "Pattern") return { special: "pattern" };
    if (familyName === "Indexed" || familyName === "I") {
      return { special: "indexed" };
    }
    if (familyName === "Separation") return { special: "separation" };
    if (familyName === "DeviceN") return { special: "devicen" };
    if (familyName === "Lab") return { special: "lab" };
    return { special: "unknown" };
  }
  return undefined;
}

/**
 * The page's resource colorspace map (page + inherited + form resources).
 * KEYS ARE BARE names ("CS0") — the model tokenizer's name tokens strip
 * the leading slash, and the smoke's model vectors lock that contract.
 * (P6-v-b fix: the pdf-lib port built slash-prefixed keys via
 * PDFName.asString(), so named-resource spaces never matched and were
 * always classified "unknown".)
 */
function csMapForPage(doc: ParsedPdf, pageNode: Map<string, PdfObj>): CsMap {
  const map: CsMap = {};
  const collect = (node: Map<string, PdfObj>, depth: number): void => {
    if (depth > MAX_FORM_DEPTH) return;
    const resources = resourcesOf(doc, node);
    if (resources === undefined) return;
    const spaces = asDict(resolve(doc, resources.get("ColorSpace")));
    if (spaces !== undefined) {
      for (const [key, value] of spaces.entries()) {
        const kind = csKindOfResource(doc, value);
        if (kind !== undefined) map[key] = kind;
      }
    }
    const xobjs = asDict(resolve(doc, resources.get("XObject")));
    if (xobjs !== undefined) {
      for (const value of xobjs.values()) {
        const stream = lookupStream(doc, value);
        if (stream === undefined) continue;
        if (asName(stream.m.get("Subtype")) !== "Form") continue;
        collect(stream.m, depth + 1);
      }
    }
  };
  collect(pageNode, 0);
  return map;
}

interface ColorsOutcome {
  report: PdfaChangeReport["colors"];
  pageNotes: string[];
  /** Rewritten content streams, by object number (rewriteDocument seam). */
  replacements: Map<number, PdfObj>;
}

/**
 * Normalizes every page + form stream of the document. Rewritten streams
 * ride the rewriteDocument replacements map (the stream's own dict is
 * reused, so /Filter + /DecodeParms survive; the writer recomputes
 * /Length from the new raw bytes).
 */
function normalizeColors(
  doc: ParsedPdf,
  pages: PdfPageInfo[],
  locale: "en" | "hi",
  labels: Record<string, string>
): ColorsOutcome {
  const outcome: ColorsOutcome = {
    report: {
      streamsScanned: 0,
      streamsRewritten: 0,
      streamsSkipped: 0,
      pageNotes: [],
      totals: {
        grayOps: 0,
        cmykOps: 0,
        csSwitches: 0,
        scOps: 0,
        shadings: 0,
        inlineImages: 0,
      },
    },
    pageNotes: [],
    replacements: new Map<number, PdfObj>(),
  };
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p]!;
    const state: WalkState = { seenForms: new Set(), streamRefs: [] };
    walkPageStreams(doc, page.dict, state, 0);
    const csMap = csMapForPage(doc, page.dict);

    // per-page tallies (the report's pageNotes name the page honestly)
    const pageTotals = {
      grayOps: 0,
      cmykOps: 0,
      csSwitches: 0,
      scOps: 0,
    };
    for (const { num } of state.streamRefs) {
      const stream = doc.getObject(num);
      if (stream === undefined || stream.k !== "stream") continue;
      outcome.report.streamsScanned += 1;

      const filter = stream.m.get("Filter");
      const filterName = asName(filter);
      let text: string;
      let reflate: boolean;
      if (filterName === "FlateDecode") {
        try {
          text = latin1Of(unzlibSync(stream.raw));
          reflate = true;
        } catch {
          outcome.report.streamsSkipped += 1;
          continue;
        }
      } else if (filter === undefined) {
        text = latin1Of(stream.raw);
        reflate = false;
      } else {
        // DCT/JPX/LZW/… — out of honest scope for a rewrite
        outcome.report.streamsSkipped += 1;
        continue;
      }

      const result = normalizeContentStreamColors(text, csMap);
      const t = result.stats;
      outcome.report.totals.grayOps += t.grayOps;
      outcome.report.totals.cmykOps += t.cmykOps;
      outcome.report.totals.csSwitches += t.csSwitches;
      outcome.report.totals.scOps += t.scOps;
      outcome.report.totals.shadings += t.shadings;
      outcome.report.totals.inlineImages += t.inlineImages;
      pageTotals.grayOps += t.grayOps;
      pageTotals.cmykOps += t.cmykOps;
      pageTotals.csSwitches += t.csSwitches;
      pageTotals.scOps += t.scOps;
      if (!result.changed) continue;

      const bytes = reflate
        ? zlibSync(latin1BytesOf(result.text), { level: 9 })
        : latin1BytesOf(result.text);
      // same dict, new body — the writer recomputes /Length
      outcome.replacements.set(num, {
        k: "stream",
        m: stream.m,
        raw: bytes,
      });
      outcome.report.streamsRewritten += 1;
    }

    const touched =
      pageTotals.grayOps +
      pageTotals.cmykOps +
      pageTotals.csSwitches +
      pageTotals.scOps;
    if (touched > 0) {
      const parts: string[] = [];
      if (pageTotals.grayOps > 0) parts.push(`g/G ${pageTotals.grayOps}`);
      if (pageTotals.cmykOps > 0) parts.push(`k/K ${pageTotals.cmykOps}`);
      if (pageTotals.csSwitches > 0) parts.push(`cs/CS ${pageTotals.csSwitches}`);
      if (pageTotals.scOps > 0) parts.push(`sc/scn ${pageTotals.scOps}`);
      outcome.pageNotes.push(
        `${labelOf(locale, labels, "pageWord", locale === "hi" ? "पृष्ठ" : "Page")} ${p + 1}: ${parts.join(", ")} → DeviceRGB`
      );
    }
  }
  outcome.report.pageNotes = outcome.pageNotes;
  return outcome;
}

/* ------------------------------------------------------------------ */
/* 4. Forbidden content removal                                         */
/* ------------------------------------------------------------------ */

/**
 * Walks a name tree node, visiting every value slot. When `nodeNums` is
 * given, every visited node's object number is collected — the DROP
 * route deletes the whole emptied tree so the output carries no orphaned
 * nodes with dangling refs (P6-v-b: the rewrite's deletions, the
 * pdf-lib context.delete parity).
 */
function walkNameTree(
  doc: ParsedPdf,
  nodeRaw: PdfObj | undefined,
  visit: (value: PdfObj) => void,
  depth: number,
  nodeNums?: number[]
): void {
  if (depth > 32) return;
  if (nodeRaw !== undefined && nodeRaw.k === "ref") nodeNums?.push(nodeRaw.num);
  const node = mapOf(resolve(doc, nodeRaw));
  if (node === undefined) return;
  const names = asArr(resolve(doc, node.get("Names")));
  if (names !== undefined) {
    for (let i = 1; i < names.length; i += 2) visit(names[i]!);
  }
  const kids = asArr(resolve(doc, node.get("Kids")));
  if (kids !== undefined) {
    for (const kid of kids) walkNameTree(doc, kid, visit, depth + 1, nodeNums);
  }
}

/**
 * Deletes a filespec + its EmbeddedFile streams (object-level — the
 * rewrite omits them entirely).
 */
function deleteFilespec(
  doc: ParsedPdf,
  raw: PdfObj | undefined,
  deletions: Set<number>
): void {
  const dict = asDict(resolve(doc, raw));
  if (dict === undefined) return;
  const ef = asDict(resolve(doc, dict.get("EF")));
  if (ef !== undefined) {
    for (const streamRaw of ef.values()) {
      if (streamRaw.k === "ref") deletions.add(streamRaw.num);
    }
  }
  if (raw !== undefined && raw.k === "ref") deletions.add(raw.num);
}

interface ActionOutcome {
  report: PdfaChangeReport["actions"];
}

/**
 * Strips every forbidden construct (types.ts §7). In-place dict edits
 * ride the rewrite; object-level drops ride the deletions set.
 */
function stripForbiddenContent(
  doc: ParsedPdf,
  pages: PdfPageInfo[],
  target: PdfaTarget,
  deletions: Set<number>
): ActionOutcome {
  const report: PdfaChangeReport["actions"] = {
    jsTreeStripped: false,
    openActionStripped: [],
    aaStripped: 0,
    annotActionsStripped: 0,
    annotsRemoved: 0,
    annotsNoAp: 0,
    embeddedFilesDropped: 0,
    embeddedFilesKept: 0,
  };
  const catalog = catalogDict(doc);
  if (catalog === null) return { report };

  // pdf-lib's attach() registers the SAME filespec in BOTH the
  // /Names/EmbeddedFiles tree and the catalog /AF array — count it once.
  const seenSpecs = new Set<number>();

  // --- the /Names dictionary (JavaScript tree + EmbeddedFiles) --------
  const namesRaw = catalog.get("Names");
  const names = asDict(resolve(doc, namesRaw));
  if (names !== undefined) {
    if (names.has("JavaScript")) {
      names.delete("JavaScript");
      report.jsTreeStripped = true;
    }
    if (names.has("EmbeddedFiles")) {
      const treeRaw = names.get("EmbeddedFiles");
      const tree = mapOf(resolve(doc, treeRaw));
      if (tree !== undefined) {
        if (target === "3b") {
          walkNameTree(
            doc,
            treeRaw,
            (value) => {
              const key = value.k === "ref" ? value.num : -1;
              if (key >= 0 && seenSpecs.has(key)) return;
              if (key >= 0) seenSpecs.add(key);
              const spec = asDict(resolve(doc, value));
              if (spec === undefined) return;
              if (!spec.has("AFRelationship")) {
                spec.set("AFRelationship", name("Unspecified"));
              }
              report.embeddedFilesKept += 1;
            },
            0
          );
        } else {
          const treeNodeNums: number[] = [];
          walkNameTree(
            doc,
            treeRaw,
            (value) => {
              const key = value.k === "ref" ? value.num : -1;
              if (key >= 0 && seenSpecs.has(key)) return;
              if (key >= 0) seenSpecs.add(key);
              deleteFilespec(doc, value, deletions);
              report.embeddedFilesDropped += 1;
            },
            0,
            treeNodeNums
          );
          for (const n of treeNodeNums) deletions.add(n);
          names.delete("EmbeddedFiles");
        }
      }
    }
    // drop the now-empty /Names shell (object + catalog entry)
    if (names.size === 0) {
      if (namesRaw !== undefined && namesRaw.k === "ref") {
        deletions.add(namesRaw.num);
      }
      catalog.delete("Names");
    }
  }

  // --- catalog /AF (Factur-X route) -----------------------------------
  const afRaw = catalog.get("AF");
  if (afRaw !== undefined) {
    const visitSpec = (raw: PdfObj): void => {
      const seenKey = raw.k === "ref" ? raw.num : -1;
      if (seenKey >= 0 && seenSpecs.has(seenKey)) return;
      if (seenKey >= 0) seenSpecs.add(seenKey);
      const spec = asDict(resolve(doc, raw));
      if (spec === undefined) return;
      if (target === "3b") {
        if (!spec.has("AFRelationship")) {
          spec.set("AFRelationship", name("Unspecified"));
        }
        report.embeddedFilesKept += 1;
      } else {
        deleteFilespec(doc, raw, deletions);
        report.embeddedFilesDropped += 1;
      }
    };
    const afArr = asArr(resolve(doc, afRaw));
    if (afArr !== undefined) {
      for (const item of afArr) visitSpec(item);
    } else {
      visitSpec(afRaw);
    }
    if (target !== "3b") {
      if (afRaw.k === "ref") deletions.add(afRaw.num);
      catalog.delete("AF");
    }
  }

  // --- catalog /OpenAction (forbidden action types only) ---------------
  const openAction = asDict(resolve(doc, catalog.get("OpenAction")));
  if (openAction !== undefined) {
    const sName = asName(openAction.get("S")) ?? "";
    if (FORBIDDEN_ACTIONS.has(sName)) {
      catalog.delete("OpenAction");
      report.openActionStripped.push(sName);
    }
  }

  // --- /AA additional-action dicts (catalog + pages) ---------------------
  if (catalog.has("AA")) {
    catalog.delete("AA");
    report.aaStripped += 1;
  }
  for (const page of pages) {
    if (page.dict.has("AA")) {
      page.dict.delete("AA");
      report.aaStripped += 1;
    }
  }

  // --- annotations ------------------------------------------------------
  for (const page of pages) {
    const annotsRaw = page.dict.get("Annots");
    if (annotsRaw === undefined) continue;
    const annots = asArr(resolve(doc, annotsRaw));
    if (annots === undefined) continue;
    for (let i = annots.length - 1; i >= 0; i -= 1) {
      const raw = annots[i]!;
      const dict = asDict(resolve(doc, raw));
      if (dict === undefined) continue;
      const subtype = asName(dict.get("Subtype")) ?? "";
      if (MULTIMEDIA_SUBTYPES.has(subtype)) {
        if (raw.k === "ref") deletions.add(raw.num);
        annots.splice(i, 1);
        report.annotsRemoved += 1;
        continue;
      }
      const action = asDict(resolve(doc, dict.get("A")));
      if (action !== undefined) {
        const sName = asName(action.get("S")) ?? "";
        if (FORBIDDEN_ACTIONS.has(sName)) {
          dict.delete("A");
          report.annotActionsStripped += 1;
        }
      }
      if (
        subtype === "Widget" &&
        dict.get("AP") === undefined &&
        dict.get("AS") === undefined
      ) {
        report.annotsNoAp += 1;
      }
    }
    // drop the shell when nothing remains (the rewrite never materializes
    // an empty /Annots — the explicit delete keeps the output honest)
    if (annots.length === 0) page.dict.delete("Annots");
  }
  return { report };
}

/* ------------------------------------------------------------------ */
/* The run                                                              */
/* ------------------------------------------------------------------ */

function readTarget(options: OptionValues): unknown {
  return options["target"];
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const parsed = parsePdfaRun(readTarget(options), options["run"]);
  if (!parsed.ok) {
    post({ type: "error", runId, code: parsed.code });
    return;
  }
  const { target, locale, labels } = parsed.run;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  if (bytes.length === 0) {
    post({ type: "error", runId, code: PA_CODES.emptyFile });
    return;
  }
  if (bytes.length > 256 * 1024 * 1024) {
    post({ type: "error", runId, code: PA_CODES.tooLarge });
    return;
  }
  if (!sniffIsPdf(bytes)) {
    post({ type: "error", runId, code: PA_CODES.notPdf, detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });

  let doc: ParsedPdf;
  let pages: PdfPageInfo[];
  try {
    // strict: an /Encrypt dictionary refuses with the typed error
    // (PDF/A forbids it); broken structures refuse "corrupt".
    doc = parsePdf(bytes);
    pages = listPages(doc);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      post({ type: "error", runId, code: "tool.errorEncrypted" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: "tool.errorCorrupt",
      detail: message.slice(0, 160),
    });
    return;
  }
  const pageCount = pages.length;
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 16, stage: "processing" });

  const catalog = catalogDict(doc);
  if (catalog === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  // fresh objects ride extraObjects, numbered ABOVE every source object
  let nextNum = 0;
  for (const numKey of doc.entries.keys()) nextNum = Math.max(nextNum, numKey);
  nextNum += 1;
  const alloc = (): number => {
    const n = nextNum;
    nextNum += 1;
    return n;
  };
  const extras: Array<{ num: number; obj: PdfObj }> = [];
  const deletions = new Set<number>();

  // --- transparency (PDF/A-1b forbids it — reject before touching) ----
  const transparency = scanTransparency(doc, pages);
  if (
    target === "1b" &&
    (transparency.softMaskPages.length > 0 || transparency.alphaPages.length > 0)
  ) {
    const pagesList = [
      ...new Set([...transparency.softMaskPages, ...transparency.alphaPages]),
    ]
      .map((p) => p + 1)
      .sort((a, b) => a - b)
      .join(", ");
    post({
      type: "error",
      runId,
      code: PA_CODES.transparency,
      detail: pagesList,
    });
    return;
  }

  // --- fonts (audit first — a non-embeddable font is an honest reject) -
  const fontAudit = auditFonts(doc, pages);
  if (fontAudit.unembeddable.size > 0) {
    post({
      type: "error",
      runId,
      code: PA_CODES.unembeddableFonts,
      detail: unembeddableDetail(fontAudit),
    });
    return;
  }

  post({ type: "progress", runId, pct: 30, stage: "processing" });

  const fontReport: PdfaChangeReport["fonts"] = {
    embeddedPassed: fontAudit.embeddedPassed,
    standardKept: 0,
    standardEmbedded: 0,
    notes: [],
  };
  if (target === "1b") {
    fontReport.standardKept = fontAudit.pending.length;
    for (const entry of fontAudit.pending) {
      fontReport.notes.push(`${entry.baseFont} (unembedded, PDF/A-1b allowance)`);
    }
  } else {
    const fileNums = new Map<string, number>();
    for (const entry of fontAudit.pending) {
      try {
        await embedStandard14(entry, fileNums, extras, alloc);
        fontReport.standardEmbedded += 1;
        fontReport.notes.push(
          `${entry.baseFont} → ${STANDARD14_ASSETS[entry.baseFont]!.substitute} (metric-compatible substitute)`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        post({
          type: "error",
          runId,
          code: PA_CODES.convertFailed,
          detail: message.slice(0, 160),
        });
        return;
      }
    }
  }

  post({ type: "progress", runId, pct: 48, stage: "processing" });

  // --- colors -----------------------------------------------------------
  const colors = normalizeColors(doc, pages, locale, labels);

  post({ type: "progress", runId, pct: 66, stage: "processing" });

  // --- forbidden content --------------------------------------------------
  const actions = stripForbiddenContent(doc, pages, target, deletions);

  post({ type: "progress", runId, pct: 76, stage: "processing" });

  // --- metadata: XMP + OutputIntent + trailer ID + header ----------------
  const infoDict = asDict(
    resolveTrailerRef(doc, doc.trailer.get("Info"))
  );
  let docTitle = "";
  if (infoDict !== undefined) {
    const titleRaw = infoDict.get("Title");
    if (titleRaw !== undefined && titleRaw.k !== "ref") {
      const b =
        titleRaw.k === "str" || titleRaw.k === "lstr" || titleRaw.k === "hstr"
          ? titleRaw.b
          : undefined;
      if (b !== undefined) docTitle = decodeTextString(b);
    }
  }
  docTitle = docTitle.slice(0, 512);

  // fresh XMP (a source /Metadata stream is dropped object-level)
  const oldMeta = catalog.get("Metadata");
  if (oldMeta !== undefined && oldMeta.k === "ref") deletions.add(oldMeta.num);
  const xmpDict = newDict();
  xmpDict.m.set("Type", name("Metadata"));
  xmpDict.m.set("Subtype", name("XML"));
  const xmpNum = alloc();
  extras.push({
    num: xmpNum,
    obj: {
      k: "stream",
      m: xmpDict.m,
      raw: new TextEncoder().encode(
        buildPdfaXmpPacket(target, docTitle, PRODUCER)
      ),
    },
  });
  catalog.set("Metadata", ref(xmpNum));

  // OutputIntent with the hand-rolled sRGB ICC v2.1 profile
  const icc = buildSrgbIccProfile();
  const iccDict = newDict();
  iccDict.m.set("N", num(3));
  const iccNum = alloc();
  extras.push({
    num: iccNum,
    obj: { k: "stream", m: iccDict.m, raw: icc },
  });

  const intent = newDict();
  intent.m.set("Type", name("OutputIntent"));
  intent.m.set("S", name("GTS_PDFA1"));
  intent.m.set(
    "OutputConditionIdentifier",
    lstr(latin1BytesOf("sRGB IEC61966-2.1"))
  );
  intent.m.set(
    "Info",
    lstr(
      latin1BytesOf("sRGB IEC61966-2.1 (DocoPDF hand-rolled from IEC 61966-2.1)")
    )
  );
  intent.m.set("DestOutputProfile", ref(iccNum));
  const intentNum = alloc();
  extras.push({ num: intentNum, obj: intent });
  catalog.set("OutputIntents", arr(ref(intentNum)));

  // trailer /ID (PDF/A requires one; overwrite any stale source ID)
  const idHex = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  doc.trailer.set("ID", arr(hstr(latin1BytesOf(idHex)), hstr(latin1BytesOf(idHex))));

  post({ type: "progress", runId, pct: 88, stage: "saving" });

  let saved: Uint8Array;
  try {
    saved = rewriteDocument(doc, {
      deletions,
      replacements:
        colors.replacements.size > 0 ? colors.replacements : undefined,
      extraObjects: extras,
      objectStreams: false, // the -b flat xref layout (honest, verifiable)
    });
    // stamp the PDF/A version rule into the header: %PDF-1.4 for -1b
    // (PDF 1.4-based), %PDF-1.7 for -2b/-3b — the patch keeps source
    // headers honest regardless of the source's own version.
    const headerText = `%PDF-${PDFA_TARGET_INFO[target].pdfVersion}`;
    saved = new Uint8Array(saved);
    saved.set(
      new Uint8Array([
        0x25,
        0x50,
        0x44,
        0x46,
        0x2d,
        headerText.charCodeAt(5),
        headerText.charCodeAt(6),
        headerText.charCodeAt(7),
      ]),
      0
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: PA_CODES.convertFailed,
      detail: message.slice(0, 160),
    });
    return;
  }

  const notes: string[] = [];
  if (
    target !== "1b" &&
    (transparency.softMaskPages.length > 0 || transparency.alphaPages.length > 0)
  ) {
    // buildReportText's "Honest limits" section already names the pages —
    // this note only flags that they were KEPT (a -1b run never gets here).
    notes.push(`transparency kept (allowed at PDF/A-${target})`);
  }
  const changeReport: PdfaChangeReport = {
    target,
    pageCount,
    colors: colors.report,
    fonts: fontReport,
    actions: actions.report,
    transparency,
    docTitle,
    xmpWritten: true,
    outputIntentWritten: true,
    iccBytes: icc.length,
    idWritten: true,
    headerVersion: PDFA_TARGET_INFO[target].pdfVersion,
    notes,
  };

  const reportText = buildReportText(
    changeReport,
    { fileName: file.name, inputBytes: bytes.length, outputBytes: saved.length },
    locale,
    labels
  );

  const strippedCount =
    (actions.report.jsTreeStripped ? 1 : 0) +
    actions.report.openActionStripped.length +
    actions.report.aaStripped +
    actions.report.annotActionsStripped +
    actions.report.annotsRemoved +
    actions.report.embeddedFilesDropped;

  post({ type: "progress", runId, pct: 97, stage: "saving" });

  const detail: PdfaDetail = {
    files: 1,
    pages: pageCount,
    target,
    colorsConverted:
      colors.report.totals.grayOps +
      colors.report.totals.cmykOps +
      colors.report.totals.csSwitches +
      colors.report.totals.scOps,
    fontsEmbedded: fontReport.standardEmbedded,
    itemsStripped: strippedCount,
  };

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: pdfaFileName(file.name, target, locale),
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
      {
        name: reportFileName(file.name, target, locale),
        mime: "text/plain;charset=utf-8",
        blob: new Blob([reportText], { type: "text/plain;charset=utf-8" }),
      },
    ],
    detail,
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: "tool.errorGeneric",
      detail: message.slice(0, 160),
    });
  });
};
