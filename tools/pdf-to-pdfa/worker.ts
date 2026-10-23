import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHeader,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFStream,
  PDFString,
} from "pdf-lib";
import type { PDFRef } from "pdf-lib";
import { unzlibSync, zlibSync } from "fflate";

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
 *
 * The conversion pipeline (types.ts §"the honest conversion pipeline"):
 *
 *  1. gate: empty / oversize / non-PDF / encrypted inputs are rejected
 *     before anything is touched (pdf-lib loads with ignoreEncryption:
 *     false — an /Encrypt dictionary throws, and PDF/A forbids it);
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
 *  7. save WITHOUT object streams (flat xref — the -b honest layout),
 *     then the plain-text change report.
 *
 * Output: <base>-pdfa-<level>.pdf + <base>-pdfa-<level>-report.txt.
 *
 * Error mapping:
 *   pa.errEmptyFile / pa.errTooLarge / pa.errNotPdf   the input gates
 *   tool.errorEncrypted                               /Encrypt present
 *   pa.errTransparency                                soft masks/alpha on -1b
 *   pa.errUnembeddableFonts                           non-standard-14 unembedded
 *   pa.errConvertFailed                               the save itself failed
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

const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/** A resolvable indirect-object key (pdf-lib's own LookupKey shape). */
type RawKey = PDFRef | PDFObject | undefined;

/**
 * Resolves a stream-valued resource to its PDFRawStream (lookupMaybe has
 * no PDFRawStream overload — PDFStream is the closest, then narrowed).
 */
function lookupRawStream(
  doc: PDFDocument,
  raw: RawKey
): PDFRawStream | undefined {
  const stream = doc.context.lookupMaybe(raw, PDFStream);
  return stream instanceof PDFRawStream ? stream : undefined;
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
/* pdf-lib walk helpers                                                 */
/* ------------------------------------------------------------------ */

/** The page's /Resources, walking the /Parent chain (spec inheritance). */
function resourcesOf(doc: PDFDocument, node: PDFDict): PDFDict | undefined {
  let current: PDFDict | undefined = node;
  for (let hop = 0; current !== undefined && hop < 32; hop += 1) {
    const res = doc.context.lookupMaybe(
      current.get(PDFName.of("Resources")),
      PDFDict
    );
    if (res !== undefined) return res;
    const parent = doc.context.lookupMaybe(
      current.get(PDFName.of("Parent")),
      PDFDict
    );
    current = parent;
  }
  return undefined;
}

interface WalkState {
  /** Form XObjects already visited (cycle guard). */
  seenForms: Set<number>;
  /** Content stream refs (pages + forms). */
  streamRefs: PDFRef[];
}

/** Collects the page's content stream + every Form XObject, recursively. */
function walkPageStreams(
  doc: PDFDocument,
  pageNode: PDFDict,
  state: WalkState,
  depth: number
): void {
  if (depth > MAX_FORM_DEPTH) return;

  // /Contents: a single ref or an array of refs
  const contentsRaw = pageNode.get(PDFName.of("Contents"));
  if (isRef(contentsRaw)) {
    state.streamRefs.push(contentsRaw);
  } else {
    const arr = doc.context.lookupMaybe(contentsRaw, PDFArray);
    if (arr !== undefined) {
      for (let i = 0; i < arr.size(); i += 1) {
        const el = arr.get(i);
        if (isRef(el)) state.streamRefs.push(el);
      }
    }
  }

  const resources = resourcesOf(doc, pageNode);
  if (resources === undefined) return;
  const xobjs = doc.context.lookupMaybe(
    resources.get(PDFName.of("XObject")),
    PDFDict
  );
  if (xobjs === undefined) return;
  for (const [, value] of xobjs.entries()) {
    const stream = lookupRawStream(doc, value);
    if (stream === undefined) continue;
    if (stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) {
      continue;
    }
    const key = isRef(value)
      ? value.objectNumber
      : stream.dict.toString().length * 31 + stream.contents.length;
    if (state.seenForms.has(key)) continue;
    state.seenForms.add(key);
    // recurse into the form's own resources (nested forms + shared streams)
    walkPageStreams(doc, stream.dict, state, depth + 1);
    if (isRef(value)) state.streamRefs.push(value);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Transparency scan (reject -1b, report for -2b/-3b)                */
/* ------------------------------------------------------------------ */

interface TransparencyFindings {
  softMaskPages: number[];
  alphaPages: number[];
}

function scanTransparency(doc: PDFDocument): TransparencyFindings {
  const softMaskPages: number[] = [];
  const alphaPages: number[] = [];
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p]!;
    const resources = resourcesOf(doc, page.node);
    if (resources === undefined) continue;
    let softMask = false;
    let alpha = false;

    const gs = doc.context.lookupMaybe(
      resources.get(PDFName.of("ExtGState")),
      PDFDict
    );
    if (gs !== undefined) {
      for (const [, value] of gs.entries()) {
        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (dict === undefined) continue;
        const smask = dict.get(PDFName.of("SMask"));
        if (smask !== undefined && smask.toString() !== "/None") {
          softMask = true;
        }
        for (const key of ["ca", "CA"] as const) {
          const v = dict.get(PDFName.of(key));
          if (v instanceof PDFNumber && v.asNumber() < 1) alpha = true;
        }
      }
    }
    // images with a soft mask put transparency on the page too
    const xobjs = doc.context.lookupMaybe(
      resources.get(PDFName.of("XObject")),
      PDFDict
    );
    if (xobjs !== undefined) {
      for (const [, value] of xobjs.entries()) {
        const stream = lookupRawStream(doc, value);
        if (stream === undefined) continue;
        const smask = stream.dict.get(PDFName.of("SMask"));
        if (smask !== undefined && smask.toString() !== "/None") {
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
  /** Refs the substitution must patch (standard-14, deduped). */
  pending: { ref: PDFRef | null; dict: PDFDict; baseFont: string }[];
}

/** A font dict's FontDescriptor (Type0 → DescendantFonts' descriptor). */
function fontDescriptorOf(
  doc: PDFDocument,
  fontDict: PDFDict
): PDFDict | undefined {
  const direct = doc.context.lookupMaybe(
    fontDict.get(PDFName.of("FontDescriptor")),
    PDFDict
  );
  if (direct !== undefined) return direct;
  const descendants = doc.context.lookupMaybe(
    fontDict.get(PDFName.of("DescendantFonts")),
    PDFArray
  );
  if (descendants !== undefined && descendants.size() > 0) {
    const child = doc.context.lookupMaybe(descendants.get(0), PDFDict);
    if (child !== undefined) {
      return doc.context.lookupMaybe(
        child.get(PDFName.of("FontDescriptor")),
        PDFDict
      );
    }
  }
  return undefined;
}

function descriptorHasFile(descriptor: PDFDict | undefined): boolean {
  if (descriptor === undefined) return false;
  return (
    descriptor.get(PDFName.of("FontFile")) !== undefined ||
    descriptor.get(PDFName.of("FontFile2")) !== undefined ||
    descriptor.get(PDFName.of("FontFile3")) !== undefined
  );
}

/**
 * Collects every /Resources scope a page's content can draw from: the
 * page's own resources (with /Parent inheritance) plus the resources of
 * every Form XObject, recursively (a form can carry its own fonts).
 */
function resourceScopesOf(
  doc: PDFDocument,
  pageNode: PDFDict,
  seen: Set<number>,
  depth: number
): PDFDict[] {
  if (depth > MAX_FORM_DEPTH) return [];
  const scopes: PDFDict[] = [];
  const resources = resourcesOf(doc, pageNode);
  if (resources !== undefined) {
    scopes.push(resources);
    const xobjs = doc.context.lookupMaybe(
      resources.get(PDFName.of("XObject")),
      PDFDict
    );
    if (xobjs !== undefined) {
      for (const [, value] of xobjs.entries()) {
        const stream = lookupRawStream(doc, value);
        if (stream === undefined) continue;
        if (stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) {
          continue;
        }
        const key = isRef(value)
          ? value.objectNumber
          : stream.dict.toString().length * 31 + stream.contents.length;
        if (seen.has(key)) continue;
        seen.add(key);
        scopes.push(
          ...resourceScopesOf(doc, stream.dict, seen, depth + 1)
        );
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
function auditFonts(doc: PDFDocument): FontAudit {
  const audit: FontAudit = {
    embeddedPassed: 0,
    standardKept: 0,
    standardEmbedded: 0,
    notes: [],
    unembeddable: new Map(),
    pending: [],
  };
  const seen = new Map<number, { pageIndex: number }>();
  const pages = doc.getPages();

  for (let p = 0; p < pages.length; p += 1) {
    const scopes = resourceScopesOf(doc, pages[p]!.node, new Set(), 0);
    for (const resources of scopes) {
      const fonts = doc.context.lookupMaybe(
        resources.get(PDFName.of("Font")),
        PDFDict
      );
      if (fonts === undefined) continue;
      for (const [, value] of fonts.entries()) {
        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (dict === undefined) continue;
        const subtype = dict.get(PDFName.of("Subtype"));
        if (subtype === undefined) continue; // not a usable font — nothing draws
        const ref = isRef(value) ? value : null;
        if (ref !== null && seen.has(ref.objectNumber)) continue;
        if (ref !== null) seen.set(ref.objectNumber, { pageIndex: p });

        if (descriptorHasFile(fontDescriptorOf(doc, dict))) {
          audit.embeddedPassed += 1;
          continue;
        }
        const baseRaw = dict.get(PDFName.of("BaseFont"));
        const baseFont =
          rawBaseFontOf(baseRaw);
        if (baseFont === "") {
          pushUnembeddable(audit, "(unnamed font)", p);
          continue;
        }
        if (isStandard14BaseFont(baseFont)) {
          audit.pending.push({ ref, dict, baseFont });
        } else {
          pushUnembeddable(audit, baseFont, p);
        }
      }
    }
  }
  return audit;
}

/** PDFName.asString() keeps the leading "/" — every bare-name map/Set needs this. */
function bareNameOf(raw: unknown): string {
  return raw instanceof PDFName ? raw.asString().replace(/^\//, "") : "";
}

/** PDFName.asString() keeps the leading "/" — the standard-14 map is bare. */
function rawBaseFontOf(raw: unknown): string {
  if (raw instanceof PDFName) return raw.asString().replace(/^\//, "");
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
 */
async function embedStandard14(
  doc: PDFDocument,
  entry: { ref: PDFRef | null; dict: PDFDict; baseFont: string },
  fileRefs: Map<string, PDFRef>
): Promise<void> {
  const asset = STANDARD14_ASSETS[entry.baseFont];
  if (asset === undefined) return;
  const metrics = afmOf(entry.baseFont);
  if (metrics === null) return; // cannot happen (isStandard14BaseFont)

  const program = await loadFontAsset(asset.file);

  // the font-file stream is shared between fonts with the same base
  let fileRef = fileRefs.get(entry.baseFont);
  if (fileRef === undefined) {
    const fileDict = PDFDict.withContext(doc.context);
    if (asset.kind === "ttf") {
      fileDict.set(PDFName.of("Length1"), PDFNumber.of(program.length));
    } else {
      fileDict.set(
        PDFName.of("Subtype"),
        PDFName.of("Type1C")
      );
      fileDict.set(PDFName.of("Length1"), PDFNumber.of(program.length));
    }
    fileRef = doc.context.register(PDFRawStream.of(fileDict, program));
    fileRefs.set(entry.baseFont, fileRef);
  }

  const descriptor = PDFDict.withContext(doc.context);
  descriptor.set(PDFName.of("Type"), PDFName.of("FontDescriptor"));
  descriptor.set(PDFName.of("FontName"), PDFName.of(entry.baseFont));
  descriptor.set(
    PDFName.of("Flags"),
    PDFNumber.of(
      entry.baseFont === "Symbol" || entry.baseFont === "ZapfDingbats"
        ? 4 // symbolic — they keep their built-in encodings
        : 32 // nonsymbolic — WinAnsi/Standard via /Encoding
    )
  );
  const bbox = doc.context.obj(metrics.bbox);
  descriptor.set(PDFName.of("FontBBox"), bbox);
  descriptor.set(PDFName.of("ItalicAngle"), PDFNumber.of(metrics.italicAngle));
  if (metrics.ascender !== null) {
    descriptor.set(PDFName.of("Ascent"), PDFNumber.of(metrics.ascender));
  }
  if (metrics.descender !== null) {
    descriptor.set(PDFName.of("Descent"), PDFNumber.of(metrics.descender));
  }
  if (metrics.capHeight !== null) {
    descriptor.set(PDFName.of("CapHeight"), PDFNumber.of(metrics.capHeight));
  }
  if (metrics.xHeight !== null) {
    descriptor.set(PDFName.of("XHeight"), PDFNumber.of(metrics.xHeight));
  }
  descriptor.set(
    PDFName.of("StemV"),
    PDFNumber.of(metrics.stdVW > 0 ? metrics.stdVW : 80)
  );
  descriptor.set(
    PDFName.of(asset.kind === "ttf" ? "FontFile2" : "FontFile3"),
    fileRef
  );
  const descriptorRef = doc.context.register(descriptor);
  entry.dict.set(PDFName.of("FontDescriptor"), descriptorRef);

  // /Widths from the SAME canonical AFM (the substitute programs are
  // metric-compatible with it — that is their whole purpose).
  const isSymbolic =
    entry.baseFont === "Symbol" || entry.baseFont === "ZapfDingbats";
  const widths = isSymbolic
    ? afmWidthsBuiltin(entry.baseFont)
    : afmWidthsWinAnsi(entry.baseFont);
  const arr = PDFArray.withContext(doc.context);
  for (const w of widths.widths) arr.push(PDFNumber.of(w));
  entry.dict.set(PDFName.of("FirstChar"), PDFNumber.of(widths.first));
  entry.dict.set(PDFName.of("LastChar"), PDFNumber.of(widths.last));
  entry.dict.set(PDFName.of("Widths"), arr);
}

/* ------------------------------------------------------------------ */
/* 3. Color normalization (the model's normalizer over real streams)    */
/* ------------------------------------------------------------------ */

/** Classifies one resource /ColorSpace entry for the normalizer map. */
function csKindOfResource(
  doc: PDFDocument,
  value: RawKey
): CsKind | undefined {
  if (value instanceof PDFName) {
    switch (value.asString()) {
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
  if (value instanceof PDFArray || isRef(value)) {
    const arr = doc.context.lookupMaybe(value, PDFArray);
    if (arr === undefined || arr.size() < 1) return { special: "unknown" };
    const family = arr.get(0);
    const familyName =
      family instanceof PDFName ? family.asString() : String(family);
    if (familyName === "ICCBased") {
      const stream = lookupRawStream(doc, arr.get(1));
      const n = stream?.dict.get(PDFName.of("N"));
      if (n instanceof PDFNumber) {
        const count = n.asNumber();
        if (count === 1) return { comps: 1, rgb: false };
        if (count === 3) return { comps: 3, rgb: true };
        if (count === 4) return { comps: 4, rgb: false };
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

/** The page's resource colorspace map (page + inherited + form resources). */
function csMapForPage(doc: PDFDocument, pageNode: PDFDict): CsMap {
  const map: CsMap = {};
  const collect = (node: PDFDict, depth: number): void => {
    if (depth > MAX_FORM_DEPTH) return;
    const resources = resourcesOf(doc, node);
    if (resources === undefined) return;
    const spaces = doc.context.lookupMaybe(
      resources.get(PDFName.of("ColorSpace")),
      PDFDict
    );
    if (spaces !== undefined) {
      for (const [key, value] of spaces.entries()) {
        const kind = csKindOfResource(doc, value);
        if (kind !== undefined) map[key.asString()] = kind;
      }
    }
    const xobjs = doc.context.lookupMaybe(
      resources.get(PDFName.of("XObject")),
      PDFDict
    );
    if (xobjs !== undefined) {
      for (const [, value] of xobjs.entries()) {
        const stream = lookupRawStream(doc, value);
        if (stream === undefined) continue;
        if (stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) {
          continue;
        }
        collect(stream.dict, depth + 1);
      }
    }
  };
  collect(pageNode, 0);
  return map;
}

interface ColorsOutcome {
  report: PdfaChangeReport["colors"];
  pageNotes: string[];
}

/** Normalizes every page + form stream of the document (in place). */
function normalizeColors(
  doc: PDFDocument,
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
  };
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p]!;
    const state: WalkState = { seenForms: new Set(), streamRefs: [] };
    walkPageStreams(doc, page.node, state, 0);
    const csMap = csMapForPage(doc, page.node);

    // per-page tallies (the report's pageNotes name the page honestly)
    const pageTotals = {
      grayOps: 0,
      cmykOps: 0,
      csSwitches: 0,
      scOps: 0,
    };
    for (const ref of state.streamRefs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      outcome.report.streamsScanned += 1;

      const filter = stream.dict.get(PDFName.of("Filter"));
      const isFlate =
        filter instanceof PDFName && filter === PDFName.of("FlateDecode");
      let text: string;
      let reflate: boolean;
      if (isFlate) {
        try {
          text = latin1Of(unzlibSync(stream.contents));
          reflate = true;
        } catch {
          outcome.report.streamsSkipped += 1;
          continue;
        }
      } else if (filter === undefined) {
        text = latin1Of(stream.contents);
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
        ? zlibSync(new TextEncoder().encode(result.text), { level: 9 })
        : new TextEncoder().encode(result.text);
      doc.context.assign(ref, PDFRawStream.of(stream.dict, bytes));
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

/** Walks a name tree node, visiting every value slot. */
function walkNameTree(
  doc: PDFDocument,
  node: PDFDict,
  visit: (value: PDFObject) => void,
  depth: number
): void {
  if (depth > 32) return;
  const names = doc.context.lookupMaybe(node.get(PDFName.of("Names")), PDFArray);
  if (names !== undefined) {
    for (let i = 1; i < names.size(); i += 2) visit(names.get(i));
  }
  const kids = doc.context.lookupMaybe(node.get(PDFName.of("Kids")), PDFArray);
  if (kids !== undefined) {
    for (let i = 0; i < kids.size(); i += 1) {
      const kid = doc.context.lookupMaybe(kids.get(i), PDFDict);
      if (kid !== undefined) walkNameTree(doc, kid, visit, depth + 1);
    }
  }
}

/** Deletes a filespec + its EmbeddedFile streams from the context. */
function deleteFilespec(doc: PDFDocument, raw: RawKey): void {
  const ref = isRef(raw) ? raw : null;
  const dict = doc.context.lookupMaybe(raw, PDFDict);
  if (dict === undefined) return;
  const ef = doc.context.lookupMaybe(dict.get(PDFName.of("EF")), PDFDict);
  if (ef !== undefined) {
    for (const [, streamRaw] of ef.entries()) {
      if (isRef(streamRaw)) doc.context.delete(streamRaw);
    }
  }
  if (ref !== null) doc.context.delete(ref);
}

interface ActionOutcome {
  report: PdfaChangeReport["actions"];
}

/** Strips every forbidden construct (types.ts §7), in place. */
function stripForbiddenContent(doc: PDFDocument, target: PdfaTarget): ActionOutcome {
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

  // pdf-lib's attach() registers the SAME filespec in BOTH the
  // /Names/EmbeddedFiles tree and the catalog /AF array — count it once.
  const seenSpecs = new Set<number>();
  const specKeyOf = (raw: RawKey): number => (isRef(raw) ? raw.objectNumber : -1);

  // --- the /Names dictionary (JavaScript tree + EmbeddedFiles) --------
  const namesRaw = doc.catalog.get(PDFName.of("Names"));
  const names = doc.context.lookupMaybe(namesRaw, PDFDict);
  if (names !== undefined) {
    if (names.get(PDFName.of("JavaScript")) !== undefined) {
      names.delete(PDFName.of("JavaScript"));
      report.jsTreeStripped = true;
    }
    if (names.get(PDFName.of("EmbeddedFiles")) !== undefined) {
      const tree = doc.context.lookupMaybe(
        names.get(PDFName.of("EmbeddedFiles")),
        PDFDict
      );
      if (tree !== undefined) {
        if (target === "3b") {
          walkNameTree(
            doc,
            tree,
            (value) => {
              const key = specKeyOf(value);
              if (key >= 0 && seenSpecs.has(key)) return;
              if (key >= 0) seenSpecs.add(key);
              const spec = doc.context.lookupMaybe(value, PDFDict);
              if (spec === undefined) return;
              if (spec.get(PDFName.of("AFRelationship")) === undefined) {
                spec.set(
                  PDFName.of("AFRelationship"),
                  PDFName.of("Unspecified")
                );
              }
              report.embeddedFilesKept += 1;
            },
            0
          );
        } else {
          walkNameTree(
            doc,
            tree,
            (value) => {
              deleteFilespec(doc, value);
              report.embeddedFilesDropped += 1;
            },
            0
          );
          names.delete(PDFName.of("EmbeddedFiles"));
        }
      }
    }
    // drop the now-empty /Names shell
    if (names.entries().length === 0) doc.catalog.delete(PDFName.of("Names"));
  }

  // --- catalog /AF (Factur-X route) -----------------------------------
  const afRaw = doc.catalog.get(PDFName.of("AF"));
  if (afRaw !== undefined) {
    const visitSpec = (raw: RawKey): void => {
      const seenKey = specKeyOf(raw);
      if (seenKey >= 0 && seenSpecs.has(seenKey)) return;
      if (seenKey >= 0) seenSpecs.add(seenKey);
      const spec = doc.context.lookupMaybe(raw, PDFDict);
      if (spec === undefined) return;
      if (target === "3b") {
        if (spec.get(PDFName.of("AFRelationship")) === undefined) {
          spec.set(PDFName.of("AFRelationship"), PDFName.of("Unspecified"));
        }
        report.embeddedFilesKept += 1;
      } else {
        deleteFilespec(doc, raw);
        report.embeddedFilesDropped += 1;
      }
    };
    const afArr = doc.context.lookupMaybe(afRaw, PDFArray);
    if (afArr !== undefined) {
      for (let i = 0; i < afArr.size(); i += 1) visitSpec(afArr.get(i));
    } else {
      visitSpec(afRaw);
    }
    if (target !== "3b") doc.catalog.delete(PDFName.of("AF"));
  }

  // --- catalog /OpenAction (forbidden action types only) ---------------
  const oaRaw = doc.catalog.get(PDFName.of("OpenAction"));
  const openAction = doc.context.lookupMaybe(oaRaw, PDFDict);
  if (openAction !== undefined) {
    const s = openAction.get(PDFName.of("S"));
    const sName = bareNameOf(s);
    if (FORBIDDEN_ACTIONS.has(sName)) {
      doc.catalog.delete(PDFName.of("OpenAction"));
      report.openActionStripped.push(sName);
    }
  }

  // --- /AA additional-action dicts (catalog + pages) ---------------------
  if (doc.catalog.get(PDFName.of("AA")) !== undefined) {
    doc.catalog.delete(PDFName.of("AA"));
    report.aaStripped += 1;
  }
  for (const page of doc.getPages()) {
    if (page.node.get(PDFName.of("AA")) !== undefined) {
      page.node.delete(PDFName.of("AA"));
      report.aaStripped += 1;
    }
  }

  // --- annotations ------------------------------------------------------
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (annots === undefined) continue;
    for (let i = annots.size() - 1; i >= 0; i -= 1) {
      const raw = annots.get(i);
      const dict = doc.context.lookupMaybe(raw, PDFDict);
      if (dict === undefined) continue;
      const subtypeRaw = dict.get(PDFName.of("Subtype"));
      const subtype =
        bareNameOf(subtypeRaw);
      if (MULTIMEDIA_SUBTYPES.has(subtype)) {
        if (isRef(raw)) doc.context.delete(raw);
        annots.remove(i);
        report.annotsRemoved += 1;
        continue;
      }
      const actionRaw = dict.get(PDFName.of("A"));
      const action = doc.context.lookupMaybe(actionRaw, PDFDict);
      if (action !== undefined) {
        const s = action.get(PDFName.of("S"));
        const sName = bareNameOf(s);
        if (FORBIDDEN_ACTIONS.has(sName)) {
          dict.delete(PDFName.of("A"));
          report.annotActionsStripped += 1;
        }
      }
      if (
        subtype === "Widget" &&
        dict.get(PDFName.of("AP")) === undefined &&
        dict.get(PDFName.of("AS")) === undefined
      ) {
        report.annotsNoAp += 1;
      }
    }
    // pdf-lib materializes empty /Annots — drop the shell when unused
    if (annots.size() === 0) page.node.delete(PDFName.of("Annots"));
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

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt",
      detail: message.slice(0, 160),
    });
    return;
  }
  let pageCount: number;
  try {
    pageCount = doc.getPageCount();
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 16, stage: "processing" });

  // --- transparency (PDF/A-1b forbids it — reject before touching) ----
  const transparency = scanTransparency(doc);
  if (
    target === "1b" &&
    (transparency.softMaskPages.length > 0 || transparency.alphaPages.length > 0)
  ) {
    const pages = [...new Set([...transparency.softMaskPages, ...transparency.alphaPages])]
      .map((p) => p + 1)
      .sort((a, b) => a - b)
      .join(", ");
    post({
      type: "error",
      runId,
      code: PA_CODES.transparency,
      detail: pages,
    });
    return;
  }

  // --- fonts (audit first — a non-embeddable font is an honest reject) -
  const fontAudit = auditFonts(doc);
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
    const fileRefs = new Map<string, PDFRef>();
    for (const entry of fontAudit.pending) {
      try {
        await embedStandard14(doc, entry, fileRefs);
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
  const colors = normalizeColors(doc, locale, labels);

  post({ type: "progress", runId, pct: 66, stage: "processing" });

  // --- forbidden content --------------------------------------------------
  const actions = stripForbiddenContent(doc, target);

  post({ type: "progress", runId, pct: 76, stage: "processing" });

  // --- metadata: XMP + OutputIntent + trailer ID + header ----------------
  const infoDict = doc.context.lookupMaybe(
    doc.context.trailerInfo.Info as never,
    PDFDict
  );
  let docTitle = "";
  if (infoDict !== undefined) {
    const titleRaw = infoDict.get(PDFName.of("Title"));
    if (titleRaw instanceof PDFString) docTitle = titleRaw.asString();
    else if (titleRaw instanceof PDFHexString) docTitle = titleRaw.decodeText();
  }
  docTitle = docTitle.slice(0, 512);

  // fresh XMP (a source /Metadata stream is dropped object-level)
  const oldMeta = doc.catalog.get(PDFName.of("Metadata"));
  if (isRef(oldMeta)) doc.context.delete(oldMeta);
  const xmpDict = PDFDict.withContext(doc.context);
  xmpDict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  xmpDict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const xmpStream = PDFRawStream.of(
    xmpDict,
    new TextEncoder().encode(buildPdfaXmpPacket(target, docTitle, PRODUCER))
  );
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmpStream));

  // OutputIntent with the hand-rolled sRGB ICC v2.1 profile
  const icc = buildSrgbIccProfile();
  const iccDict = PDFDict.withContext(doc.context);
  iccDict.set(PDFName.of("N"), PDFNumber.of(3));
  const iccRef = doc.context.register(PDFRawStream.of(iccDict, icc));

  const intent = PDFDict.withContext(doc.context);
  intent.set(PDFName.of("Type"), PDFName.of("OutputIntent"));
  intent.set(PDFName.of("S"), PDFName.of("GTS_PDFA1"));
  intent.set(
    PDFName.of("OutputConditionIdentifier"),
    PDFString.of("sRGB IEC61966-2.1")
  );
  intent.set(
    PDFName.of("Info"),
    PDFString.of("sRGB IEC61966-2.1 (DocoPDF hand-rolled from IEC 61966-2-1)")
  );
  intent.set(PDFName.of("DestOutputProfile"), iccRef);
  const intents = PDFArray.withContext(doc.context);
  intents.push(doc.context.register(intent));
  doc.catalog.set(PDFName.of("OutputIntents"), intents);

  // trailer /ID (PDF/A requires one; overwrite any stale source ID)
  const idHex = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const idArray = PDFArray.withContext(doc.context);
  idArray.push(PDFHexString.of(idHex));
  idArray.push(PDFHexString.of(idHex));
  doc.context.trailerInfo.ID = idArray;

  // header: %PDF-1.4 for -1b (PDF 1.4-based), %PDF-1.7 for -2b/-3b
  doc.context.header = PDFHeader.forVersion(
    1,
    PDFA_TARGET_INFO[target].pdfVersion === "1.4" ? 4 : 7
  );

  post({ type: "progress", runId, pct: 88, stage: "saving" });

  let saved: Uint8Array;
  try {
    saved = new Uint8Array(await doc.save({ useObjectStreams: false }));
    // pdf-lib's PDFWriter hardcodes %PDF-1.7 (computeBufferSize) and ignores
    // context.header — patch the first 8 bytes for the PDF/A version rule
    // (%PDF-1.4 for -1b, %PDF-1.7 for -2b/-3b).
    const headerText = `%PDF-${PDFA_TARGET_INFO[target].pdfVersion}`;
    saved.set(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, headerText.charCodeAt(5), headerText.charCodeAt(6), headerText.charCodeAt(7)]),
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
