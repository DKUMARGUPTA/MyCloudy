/**
 * DocoPDF own PDF micro-engine — blank-document authoring (P6-i).
 *
 * CreateContext is the create/write side's counterpart of StampContext:
 * where the stamp kernel annotates a PARSED document, this one authors a
 * FRESH one from nothing — the pdf-lib `PDFDocument.create() + addPage +
 * draw*` surface, 100% our code through the shared writer.
 *
 * Content-stream operator sequences mirror pdf-lib's PDFPage draw calls
 * exactly, so authored pages can be pixel-diffed against pdf-lib's oracle:
 *
 *   drawText:      q [gs] BT r g b rg /F size Tf 24 TL cos sin -sin cos x y Tm
 *                  <HEX> Tj T* ET Q   (drawLinesOfText shape: TL + trailing
 *                  T* are pdf-lib's; hex is UPPERcase like its toHexString)
 *   drawLine:      q r g b RG th w [dash] 0 d x1 y1 m x1 y1 m x2 y2 l S Q
 *                  (pdf-lib emits moveTo TWICE — the duplicate is kept for
 *                  parity; [dash] is the lineDashArray, [] when absent)
 *   drawRoundedRect (P6-n, pdf-lib's drawSvgPath rounded-rect shape):
 *                  q 1 0 0 1 x yTop cm 1 0 0 1 0 0 cm 1 0 0 -1 0 0 cm
 *                  [rg] [RG] [w] [] 0 d  r 0 m w−r 0 l <κarc> c … h f|S|B Q
 *                  (translate + rotate-identity + the SVG y-flip; the four
 *                  quarter-arc béziers use the drawEllipse κ)
 *   drawRectangle: q r g b rg bw w [] 0 d x y cm 1 0 0 1 0 0 cm 1 0 0 1 0 0 cm
 *                  0 0 m 0 h l w h l w 0 l h f|S|B Q
 *                  (translate + rotate-0 + skew-0 cm triplet; the identity
 *                  matrices are emitted exactly like pdf-lib's always-emit
 *                  operators)
 *   drawEllipse:   q r g b rg bw w [] 0 d q m c c c c Q f|S|B Q
 *                  (KAPPA-bézier ellipse — the inner q/Q pair around the
 *                  path is pdf-lib's drawEllipsePath quirk, preserved)
 *   drawImage:     q [gs] x y cm cos sin -sin cos 0 0 cm w 0 0 h 0 0 cm
 *                  1 0 0 1 0 0 cm /Im Do Q
 *                  (translate, rotate, scale, skew-0 — pdf-lib's order)
 *
 * Numbering contract (mirrors the writer): objects 1=catalog, 2=/Pages, then
 * each page takes TWO objects (dict + stream), then the synthetics in
 * creation order. The page count isn't known while fonts/images embed, so
 * every cross-synthetic reference is a MUTABLE newref patched to its final
 * number at write() time — the same lazy-materialization discipline the
 * stamp kernel uses for its TTF objects.
 *
 * Standard fonts: the full set of 12 WinAnsi standard-14s (Helvetica ×4,
 * Times ×4, Courier ×4) from the generated metrics; Unicode routes through
 * embedTtf (the P6-g Devanagari machinery: OUR shaper → OUR subsetter →
 * Type0/CIDFontType2 + ToUnicode, materialized at write time).
 */

import {
  type PdfObj,
  hstr,
  lstr,
  newDict,
  newref,
  num,
  pdfNumToString,
} from "./objects";
import { PdfError } from "./parser";
import { decodePng, flateImageBytes, parseJpeg } from "./images";
import {
  encodeWinAnsiHex,
  measureStdText,
  type StampFontKey,
} from "./stamp-fonts";
import { ParsedTtfFont, TtfSubsetter } from "./font-ttf";
import { shapeText } from "./shape-deva";
import type { StampTtfFont } from "./stamp";
import { writeDocument, type WriteProgress } from "./writer";

/* ─── public option types (the pdf-lib subset the tools use) ─────────────── */

export interface CreateTextOptions {
  /** Baseline-left x in PDF user space (pdf-lib semantics). */
  x: number;
  /** Baseline y. */
  y: number;
  text: string;
  size: number;
  /** Standard-font key (required unless `ttf` is provided). */
  font?: StampFontKey;
  /** Embedded TrueType route (Devanagari). */
  ttf?: StampTtfFont;
  /** 0..1 RGB. Default black (pdf-lib's default fontColor). */
  color?: { r: number; g: number; b: number };
  /** 0..1; omit for fully opaque (no ExtGState — pdf-lib parity). */
  opacity?: number;
  /** Degrees counter-clockwise. Default 0. */
  rotate?: number;
  /** Text leading (the TL op — pdf-lib page default 24). */
  lineHeight?: number;
  /**
   * Letter spacing in pt (the Tc operator — P6-l, the resume's tracked
   * headings). When set, the operator group mirrors pdf-lib's raw
   * pushOperators shape (q / BT / rg / Tf / Tc / Td / Tj / ET / Q — no
   * TL/T*, Td instead of Tm) so the tracked text stays ONE contiguous
   * literal and extractors read the whole word.
   */
  characterSpacing?: number;
}

export interface CreateRectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill color; give borderColor instead for a stroke-only rect. */
  color?: { r: number; g: number; b: number };
  borderColor?: { r: number; g: number; b: number };
  /** Default 0 (pdf-lib's drawRectangle default). */
  borderWidth?: number;
  opacity?: number;
  /** Stroke opacity (the /CA gs key — P6-l, the invoice's PAID stamp). */
  borderOpacity?: number;
  /** Degrees counter-clockwise about (x,y) — pdf-lib's rotate (P6-l). */
  rotate?: number;
  /** Dash pattern for the border — pdf-lib's borderDashArray (P6-x,
   * passport-photo's dashed cut guides). Emitted as `[a b] 0 d` in place
   * of the default solid `[] 0 d` reset; absent → solid. */
  borderDashArray?: number[];
}

export interface CreateLineOptions {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Default 1 (pdf-lib's drawLine default). */
  thickness?: number;
  /** Default black (pdf-lib adds rgb(0,0,0) when color is absent). */
  color?: { r: number; g: number; b: number };
  opacity?: number;
  /** Dash pattern — pdf-lib's lineDashArray (P6-n, the html dashed
   * borders): emitted as `[a b] 0 d` AFTER the width op; absent → the
   * usual `[] 0 d` reset. */
  dashArray?: number[];
}

/** Rounded rectangle (P6-n — pdf-lib's drawSvgPath rounded-rect shape,
 * html-to-pdf's border-radius boxes). y grows DOWN from `yTop`, so the
 * caller passes the box's TOP edge in PDF space exactly like pdf-lib's
 * drawSvgPath `{x, y}` + the engine's internal y-flip. */
export interface CreateRoundedRectOptions {
  x: number;
  /** TOP edge y in PDF user space (the translate origin, pre-flip). */
  yTop: number;
  width: number;
  height: number;
  radius: number;
  color?: { r: number; g: number; b: number };
  borderColor?: { r: number; g: number; b: number };
  borderWidth?: number;
}

export interface CreateEllipseOptions {
  /** Center x. */
  x: number;
  /** Center y. */
  y: number;
  xScale: number;
  yScale: number;
  color?: { r: number; g: number; b: number };
  borderColor?: { r: number; g: number; b: number };
  borderWidth?: number;
  opacity?: number;
}

export interface CreateImageOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  rotate?: number;
}

/**
 * An embedded image handle — pass to CreatePage.drawImage().
 * `token` is internal (identifies the XObject across write()s).
 */
export interface CreateImage {
  readonly width: number;
  readonly height: number;
  /** @internal — `img:<synthetic index>`. */
  readonly token: string;
}

/* ─── internal records ──────────────────────────────────────────────────── */

interface CreatedPageRec {
  width: number;
  height: number;
  /** Operator lines (joined "\n" at write time). */
  ops: string[];
  /** Global token → local resource name (per-page, per-prefix sequential). */
  local: Map<string, string>;
}

/** A token's bucket + synthetic slot (numbers assigned at write()). */
interface TokenInfo {
  category: "Font" | "XObject" | "ExtGState";
  synIndex: number;
}

/** The embedded TTF's reserved synthetics + mutable late-bound state. */
interface TtfEntry {
  font: ParsedTtfFont;
  subsetter: TtfSubsetter;
  /** Shared glyph-object memory across shapeText calls (fontkit semantics). */
  session: Map<number, number[]>;
  /** subset id → codePoints (first ask — the shared-glyph value). */
  cpsBySid: Map<number, number[]>;
  scale: number;
  cidIndex: number;
  fdIndex: number;
  fileIndex: number;
  cmapIndex: number;
  /** Mutable refs patched at write() (numbers = 3 + 2*pages + synIndex). */
  cidRef: PdfObj & { k: "newref" };
  fdRef: PdfObj & { k: "newref" };
  fileRef: PdfObj & { k: "newref" };
  cmapRef: PdfObj & { k: "newref" };
  cidDict: Map<string, PdfObj>;
  fileStream: PdfObj & { k: "stream"; raw: Uint8Array };
  cmapStream: PdfObj & { k: "stream"; raw: Uint8Array };
}

const ENC = new TextEncoder();

/** latin1 encode (CIDSystemInfo strings / CMap text). */
const LATIN1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/**
 * pdf-lib's Info-string encoding: UTF-16BE bytes with the FEFF BOM (its
 * PDFHexString.fromText, UPPERCASE hex) — the `hstr` kind serializes those
 * bytes exactly like pdf-lib's setProducer/setCreator/setTitle/setAuthor
 * output (probed: even pure-ASCII "DocoPDF" rides as <FEFF0044…>).
 */
function utf16beHexStr(text: string): PdfObj {
  const units: number[] = [0xfeff]; // BOM first — pdf-lib always prepends it
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i) ?? 0;
    if (c > 0xffff) {
      units.push(
        Math.floor((c - 0x10000) / 0x400) + 0xd800,
        ((c - 0x10000) % 0x400) + 0xdc00,
      );
      i += 1; // the low surrogate consumed a second UTF-16 code unit
    } else {
      units.push(c);
    }
  }
  const bytes = new Uint8Array(units.length * 2);
  for (let i = 0; i < units.length; i += 1) {
    bytes[i * 2] = (units[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = units[i]! & 0xff;
  }
  return hstr(bytes);
}

/**
 * pdf-lib's PDFDate: UTC calendar fields + timezone suffix (`Z` when the
 * offset is zero, else ±HH'mm'). Probed: setCreationDate(2026-10-28
 * 22:30:05) → `D:20261028223005Z`.
 */
function pdfDate(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  let tz = "Z";
  const offset = d.getTimezoneOffset();
  if (offset !== 0) {
    const sign = offset < 0 ? "+" : "-";
    const hours = Math.trunc(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    tz = `${sign}${p2(hours)}'${p2(minutes)}'`;
  }
  return (
    `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}${tz}`
  );
}

/** pdf-lib's KAPPA (drawEllipsePath). */
const KAPPA = (4.0 * (Math.sqrt(2.0) - 1.0)) / 3.0;

const BASE_FONT_NAME: Record<StampFontKey, string> = {
  helvetica: "Helvetica",
  helveticaBold: "Helvetica-Bold",
  helveticaOblique: "Helvetica-Oblique",
  helveticaBoldOblique: "Helvetica-BoldOblique",
  times: "Times-Roman",
  timesBold: "Times-Bold",
  timesItalic: "Times-Italic",
  timesBoldItalic: "Times-BoldItalic",
  courier: "Courier",
  courierBold: "Courier-Bold",
  courierOblique: "Courier-Oblique",
  courierBoldOblique: "Courier-BoldOblique",
};

/**
 * A fresh document under construction. Create → embed assets → addPage →
 * draw → write. Non-destructive: write() may be called repeatedly; drawing
 * more in between is picked up (mirrors StampContext's contract).
 */
export class CreateContext {
  private readonly pages: CreatedPageRec[] = [];
  private readonly synthetics: PdfObj[] = [];
  /** token → bucket + synthetic index. */
  private readonly tokens = new Map<string, TokenInfo>();
  private ttf: TtfEntry | null = null;
  /** Info-dict fields in CALL order (pdf-lib's insertion order parity). */
  private readonly infoFields = new Map<string, PdfObj>();

  private constructor() {}

  /** A new empty document (pdf-lib's PDFDocument.create()). */
  static create(): CreateContext {
    return new CreateContext();
  }

  /** Page count so far. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** Page facts for placement math. */
  pageAt(index: number): { width: number; height: number } {
    const rec = this.pages[index];
    if (!rec) throw new PdfError("corrupt", `page index ${index} out of range`);
    return { width: rec.width, height: rec.height };
  }

  /* ─── metadata (the Info dict — P6-l) ─────────────────────────────── */

  /**
   * Text values serialize as UPPERCASE UTF-16BE hex strings with a BOM —
   * exactly pdf-lib's setProducer/setCreator/setTitle/setAuthor encoding
   * (probed: even pure-ASCII "DocoPDF" rides as <FEFF0044…>). ModDate is
   * stamped at write() time (pdf-lib's save() updateMetadata behavior);
   * unlike pdf-lib we do NOT fabricate default Producer/Creator fields for
   * documents that never asked — the own engine brands nothing.
   */
  setProducer(v: string): void {
    this.infoFields.set("Producer", utf16beHexStr(v));
  }

  setCreator(v: string): void {
    this.infoFields.set("Creator", utf16beHexStr(v));
  }

  setTitle(v: string): void {
    this.infoFields.set("Title", utf16beHexStr(v));
  }

  setAuthor(v: string): void {
    this.infoFields.set("Author", utf16beHexStr(v));
  }

  /** CreationDate — pdf-lib's PDFDate: UTC fields + `Z` (or ±HH'mm'). */
  setCreationDate(d: Date): void {
    this.infoFields.set("CreationDate", lstr(LATIN1(pdfDate(d))));
  }

  /** pdf-lib-identical width of `text` in a standard font (kerning included). */
  measure(text: string, font: StampFontKey, size: number): number {
    return measureStdText(text, font, size);
  }

  /** Append a page. Returns the drawing handle. */
  addPage(width: number, height: number): CreatePage {
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0
    ) {
      throw new PdfError("corrupt", "page size must be positive");
    }
    const rec: CreatedPageRec = { width, height, ops: [], local: new Map() };
    this.pages.push(rec);
    return new CreatePageImpl(this, rec, this.pages.length - 1);
  }

  /**
   * Insert an empty page at `index` (pdf-lib's insertPage — P6-n, the
   * epub TOC pages that must land BETWEEN cover and chapters). Resources
   * are page-local and object numbers are assigned at write() time, so
   * splicing the recs array is the whole story.
   */
  insertPage(index: number, width: number, height: number): CreatePage {
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0
    ) {
      throw new PdfError("corrupt", "page size must be positive");
    }
    if (!Number.isInteger(index) || index < 0 || index > this.pages.length) {
      throw new PdfError("corrupt", `page index ${index} out of range`);
    }
    const rec: CreatedPageRec = { width, height, ops: [], local: new Map() };
    this.pages.splice(index, 0, rec);
    return new CreatePageImpl(this, rec, index);
  }

  /**
   * Drawing handles for every page so far, in final order (pdf-lib's
   * getPages — P6-n, the epub folio stamping pass that writes into pages
   * created earlier).
   */
  getPages(): CreatePage[] {
    return this.pages.map(
      (rec, index) => new CreatePageImpl(this, rec, index),
    );
  }

  /** Embed a JPEG (DCT passthrough). Returns the reusable draw handle. */
  embedJpeg(bytes: Uint8Array): CreateImage {
    const info = parseJpeg(bytes); // throws typed "logo"
    const dict = newDict([
      ["Type", { k: "name", v: "XObject" }],
      ["Subtype", { k: "name", v: "Image" }],
      ["Width", num(info.width)],
      ["Height", num(info.height)],
      ["ColorSpace", { k: "name", v: info.colorSpace }],
      ["BitsPerComponent", num(info.bitsPerComponent)],
      ["Filter", { k: "name", v: "DCTDecode" }],
    ]);
    if (info.colorSpace === "DeviceCMYK") {
      // pdf-lib's hedge: standalone CMYK JPEGs are usually stored inverted.
      dict.m.set(
        "Decode",
        { k: "arr", items: [num(1), num(0), num(1), num(0), num(1), num(0), num(1), num(0)] },
      );
    }
    return this.registerImage(info.width, info.height, dict.m, info.bytes);
  }

  /** Embed a PNG (decoded to DeviceRGB 8bpc + optional alpha SMask). */
  embedPng(bytes: Uint8Array): CreateImage {
    const png = decodePng(bytes); // throws typed "logo"
    /** SMask ref — numbered once the page count is known (write()). */
    const smaskRef: PdfObj & { k: "newref" } = { k: "newref", num: -1 };
    const dict = newDict([
      ["Type", { k: "name", v: "XObject" }],
      ["Subtype", { k: "name", v: "Image" }],
      ["Width", num(png.width)],
      ["Height", num(png.height)],
      ["ColorSpace", { k: "name", v: "DeviceRGB" }],
      ["BitsPerComponent", num(8)],
      ["Filter", { k: "name", v: "FlateDecode" }],
      ...(png.alpha !== undefined
        ? [["SMask" as const, smaskRef] as [string, PdfObj]]
        : []),
    ]);
    const handle = this.registerImage(
      png.width,
      png.height,
      dict.m,
      flateImageBytes(png.rgb),
    );
    if (png.alpha !== undefined) {
      // The SMask is the synthetic RIGHT AFTER the image XObject. Its final
      // number needs the page count, so we remember the RAW index here
      // (negative marker = unresolved) and patch at write() — see
      // patchSmasks(). The image sits at -(synIndex+1).
      const smaskIndex = this.synthetics.length;
      const smask = newDict([
        ["Type", { k: "name", v: "XObject" }],
        ["Subtype", { k: "name", v: "Image" }],
        ["Height", num(png.height)],
        ["Width", num(png.width)],
        ["BitsPerComponent", num(8)],
        ["ColorSpace", { k: "name", v: "DeviceGray" }],
        ["Filter", { k: "name", v: "FlateDecode" }],
        ["Decode", { k: "arr", items: [num(0), num(1)] }],
      ]);
      this.synthetics.push({
        k: "stream",
        m: smask.m,
        raw: flateImageBytes(png.alpha),
      });
      smaskRef.num = -(smaskIndex + 1); // unresolved marker
    }
    return handle;
  }

  /**
   * Embed a TrueType font for Unicode text (the Devanagari route — P6-g
   * machinery, materialized at write() exactly like pdf-lib's lazy
   * save-time embedding).
   */
  embedTtf(bytes: Uint8Array): StampTtfFont {
    if (this.ttf) throw new PdfError("corrupt", "only one embedded TTF per CreateContext");
    const font = ParsedTtfFont.parse(bytes); // throws typed "chars"
    const subsetter = new TtfSubsetter(font);
    const type0Index = this.synthetics.length;
    const cidIndex = type0Index + 1;
    const fdIndex = type0Index + 2;
    const fileIndex = type0Index + 3;
    const cmapIndex = type0Index + 4;

    const baseName = font.postscriptName || "Font";
    const scale = 1000 / font.unitsPerEm;

    const cidRef: PdfObj & { k: "newref" } = { k: "newref", num: 0 };
    const fdRef: PdfObj & { k: "newref" } = { k: "newref", num: 0 };
    const fileRef: PdfObj & { k: "newref" } = { k: "newref", num: 0 };
    const cmapRef: PdfObj & { k: "newref" } = { k: "newref", num: 0 };

    this.synthetics.push(
      newDict([
        ["Type", { k: "name", v: "Font" }],
        ["Subtype", { k: "name", v: "Type0" }],
        ["BaseFont", { k: "name", v: baseName }],
        ["Encoding", { k: "name", v: "Identity-H" }],
        ["DescendantFonts", { k: "arr", items: [cidRef] }],
        ["ToUnicode", cmapRef],
      ]),
    );

    const cidDict = newDict([
      ["Type", { k: "name", v: "Font" }],
      ["Subtype", { k: "name", v: "CIDFontType2" }],
      ["CIDToGIDMap", { k: "name", v: "Identity" }],
      ["BaseFont", { k: "name", v: baseName }],
      [
        "CIDSystemInfo",
        newDict([
          ["Registry", { k: "str", b: LATIN1("Adobe") }],
          ["Ordering", { k: "str", b: LATIN1("Identity") }],
          ["Supplement", num(0)],
        ]),
      ],
      ["FontDescriptor", fdRef],
      ["W", { k: "arr", items: [] }], // materialized at write()
    ]);
    this.synthetics.push(cidDict);

    // pdf-lib deriveFontFlags (symbolic + fixed-pitch + serif/script class + italic).
    let flags = 4;
    if (font.postIsFixedPitch) flags |= 1;
    if (font.os2FamilyClass >= 1 && font.os2FamilyClass <= 7) flags |= 2;
    if (font.os2FamilyClass === 10) flags |= 8;
    if (font.headMacStyleItalic) flags |= 64;

    this.synthetics.push(
      newDict([
        ["Type", { k: "name", v: "FontDescriptor" }],
        ["FontName", { k: "name", v: baseName }],
        ["Flags", num(flags)],
        [
          "FontBBox",
          {
            k: "arr",
            items: [
              num(font.bbox[0] * scale),
              num(font.bbox[1] * scale),
              num(font.bbox[2] * scale),
              num(font.bbox[3] * scale),
            ],
          },
        ],
        ["ItalicAngle", num(font.italicAngle)],
        ["Ascent", num(font.ascent * scale)],
        ["Descent", num(font.descent * scale)],
        ["CapHeight", num(font.capHeight * scale)],
        ["XHeight", num((font.xHeight || 0) * scale)],
        ["StemV", num(0)],
        ["FontFile2", fileRef],
      ]),
    );

    const fileStream: PdfObj & { k: "stream"; raw: Uint8Array } = {
      k: "stream",
      m: new Map<string, PdfObj>([
        ["Length", num(0)],
        ["Filter", { k: "name", v: "FlateDecode" }],
      ]),
      raw: new Uint8Array(0),
    };
    const cmapStream: PdfObj & { k: "stream"; raw: Uint8Array } = {
      k: "stream",
      m: new Map<string, PdfObj>([
        ["Length", num(0)],
        ["Filter", { k: "name", v: "FlateDecode" }],
      ]),
      raw: new Uint8Array(0),
    };
    this.synthetics.push(fileStream, cmapStream);

    const entry: TtfEntry = {
      font,
      subsetter,
      session: new Map<number, number[]>(),
      cpsBySid: new Map<number, number[]>(),
      scale,
      cidIndex,
      fdIndex,
      fileIndex,
      cmapIndex,
      cidRef,
      fdRef,
      fileRef,
      cmapRef,
      cidDict: cidDict.m,
      fileStream,
      cmapStream,
    };
    this.ttf = entry;
    this.tokens.set("ttf:1", { category: "Font", synIndex: type0Index });

    return {
      measure: (text, size) => {
        // pdf-lib CustomFontEmbedder.widthOfTextAtSize: Σ(advanceWidth ×
        // scale) × (size/1000) — float-exact arithmetic order.
        const glyphs = shapeText(font, text, entry.session);
        let totalWidth = 0;
        for (const g of glyphs) totalWidth += g.advanceWidth * entry.scale;
        return totalWidth * (size / 1000);
      },
      heightAtSize: (size, options) => {
        // pdf-lib CustomFontEmbedder.heightOfFontAtSize (P6-o — the
        // StampTtfFont interface contract, shared with the stamp kernel).
        const yTop = font.ascent * entry.scale;
        const yBottom = font.descent * entry.scale;
        let height = yTop - yBottom;
        if ((options?.descender ?? true) === false) {
          height -= Math.abs(font.descent * entry.scale) || 0;
        }
        return (height / 1000) * size;
      },
      encodeHex: (text) => {
        const glyphs = shapeText(font, text, entry.session);
        let hex = "";
        for (const g of glyphs) {
          const sid = subsetter.includeGlyph(g.id);
          if (!entry.cpsBySid.has(sid)) entry.cpsBySid.set(sid, g.codePoints);
          hex += sid.toString(16).padStart(4, "0");
        }
        return hex;
      },
    };
  }

  /**
   * Serialize. Objects: 1=catalog, 2=/Pages, then dict+stream per page,
   * then the synthetics in creation order, then the Info dict (when any
   * metadata was set) referenced from the trailer. Non-destructive.
   * ModDate is stamped here — pdf-lib's save(updateMetadata: true).
   */
  write(onPage?: WriteProgress): Uint8Array {
    this.finalizeTtfs();
    const base = 3 + 2 * this.pages.length;
    // Patch every synthetic-internal newref to its final number.
    const t = this.ttf;
    if (t) {
      t.cidRef.num = base + t.cidIndex;
      t.fdRef.num = base + t.fdIndex;
      t.fileRef.num = base + t.fileIndex;
      t.cmapRef.num = base + t.cmapIndex;
    }
    this.patchSmasks(base);

    const pages = this.pages.map((rec) => ({
      type: "new" as const,
      width: rec.width,
      height: rec.height,
      content: ENC.encode(rec.ops.join("\n")),
      resources: this.pageResources(rec, base),
    }));
    let info: PdfObj | undefined;
    if (this.infoFields.size > 0) {
      const m = new Map<string, PdfObj>(this.infoFields);
      m.set("ModDate", lstr(LATIN1(pdfDate(new Date()))));
      info = { k: "dict", m };
    }
    return writeDocument(pages, "1.7", onPage, this.synthetics, info);
  }

  /* ─── internals (used by CreatePage; @internal surface) ──────────────── */

  /** @internal — append one operator group to a page's stream. */
  push(rec: CreatedPageRec, ops: string): void {
    rec.ops.push(ops);
  }

  /**
   * @internal — local resource name for a global token on one page:
   * sequential per prefix (our authored pages start empty, so F1/Im1/GS1
   * are always free).
   */
  localKey(rec: CreatedPageRec, token: string, prefix: string): string {
    const cached = rec.local.get(token);
    if (cached) return cached;
    let n = 1;
    for (const name of rec.local.values()) {
      if (name.startsWith(prefix)) n += 1;
    }
    const key = `${prefix}${n}`;
    rec.local.set(token, key);
    return key;
  }

  /** @internal — ensure a standard-font token exists; returns it. */
  ensureFontToken(font: StampFontKey): string {
    const token = `std:${font}`;
    if (!this.tokens.has(token)) {
      const base = BASE_FONT_NAME[font];
      if (!base) throw new PdfError("corrupt", `unknown standard font ${font}`);
      this.tokens.set(token, {
        category: "Font",
        synIndex: this.synthetics.length,
      });
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "Font" }],
          ["Subtype", { k: "name", v: "Type1" }],
          ["BaseFont", { k: "name", v: base }],
          ["Encoding", { k: "name", v: "WinAnsiEncoding" }],
        ]),
      );
    }
    return token;
  }

  /** @internal — ensure an ExtGState token exists; returns it. */
  ensureGsToken(opacity: number): string {
    const value = Math.min(1, Math.max(0, opacity));
    const token = `gs:${value.toFixed(4)}`;
    if (!this.tokens.has(token)) {
      this.tokens.set(token, {
        category: "ExtGState",
        synIndex: this.synthetics.length,
      });
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "ExtGState" }],
          ["ca", num(value)],
        ]),
      );
    }
    return token;
  }

  /**
   * @internal — ensure a FILL+STROKE ExtGState exists (P6-l, the rotated
   * stamp rect): pdf-lib's maybeEmbedGraphicsState({opacity,
   * borderOpacity}) emits ONE dict carrying both keys (probed: {ca: 0,
   * CA: 0.55}). Only the defined values ride — a ca-only rect keeps the
   * single-key dict, so the existing ensureGsToken outputs stay stable.
   */
  ensureGsPairToken(ca: number | undefined, cA: number | undefined): string {
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    const caS = ca !== undefined ? clamp(ca).toFixed(4) : "-";
    const cAS = cA !== undefined ? clamp(cA).toFixed(4) : "-";
    const token = `gsp:${caS}:${cAS}`;
    if (!this.tokens.has(token)) {
      const pairs: Array<[string, PdfObj]> = [
        ["Type", { k: "name", v: "ExtGState" }],
      ];
      if (ca !== undefined) pairs.push(["ca", num(clamp(ca))]);
      if (cA !== undefined) pairs.push(["CA", num(clamp(cA))]);
      this.tokens.set(token, {
        category: "ExtGState",
        synIndex: this.synthetics.length,
      });
      this.synthetics.push(newDict(pairs));
    }
    return token;
  }

  /** @internal — does this token exist (drawImage handle validation)? */
  hasToken(token: string): boolean {
    return this.tokens.has(token);
  }

  /* ─── private helpers ─────────────────────────────────────────────────── */

  private registerImage(
    width: number,
    height: number,
    dict: Map<string, PdfObj>,
    raw: Uint8Array,
  ): CreateImage {
    const synIndex = this.synthetics.length;
    this.synthetics.push({ k: "stream", m: dict, raw });
    const token = `img:${synIndex}`;
    this.tokens.set(token, { category: "XObject", synIndex });
    return { width, height, token };
  }

  /** Resources dict for one authored page: local name → synthetic newref. */
  private pageResources(rec: CreatedPageRec, base: number): PdfObj {
    const buckets = new Map<string, Map<string, PdfObj>>();
    for (const [token, name] of rec.local) {
      const info = this.tokens.get(token);
      if (!info) continue;
      let bucket = buckets.get(info.category);
      if (!bucket) {
        bucket = new Map<string, PdfObj>();
        buckets.set(info.category, bucket);
      }
      bucket.set(name, newref(base + info.synIndex));
    }
    const m = new Map<string, PdfObj>();
    for (const [category, bucket] of buckets) {
      m.set(category, { k: "dict", m: bucket });
    }
    return { k: "dict", m };
  }

  /**
   * PNG SMask refs were recorded as NEGATIVE raw synthetic indices at embed
   * time (the page count wasn't known yet) — rewrite them as absolute
   * numbers now that base is fixed.
   */
  private patchSmasks(base: number): void {
    for (const obj of this.synthetics) {
      if (obj.k !== "stream") continue;
      const smask = obj.m.get("SMask");
      if (smask && smask.k === "newref" && smask.num < 0) {
        smask.num = base + (-smask.num - 1);
      }
    }
  }

  /** Materialize the embedded TTF's late-bound objects (idempotent). */
  private finalizeTtfs(): void {
    const entry = this.ttf;
    if (!entry) return;

    /* W — pdf-lib CustomFontEmbedder.computeWidths: sections of consecutive
     * subset ids [firstId, [w…]], breaking at gaps. */
    const sidCount = entry.subsetter.size - 1; // .notdef is subset id 0
    const wItems: PdfObj[] = [];
    if (sidCount > 0) {
      let section: PdfObj[] = [];
      let prevSid = 0;
      for (let sid = 1; sid <= sidCount; sid++) {
        const gid = entry.subsetter.sourceId(sid);
        const width = entry.font.advanceWidth(gid) * entry.scale;
        if (sid === 1) {
          wItems.push(num(1));
        } else if (sid !== prevSid + 1) {
          wItems.push({ k: "arr", items: section });
          wItems.push(num(sid));
          section = [];
        }
        section.push(num(width));
        prevSid = sid;
      }
      wItems.push({ k: "arr", items: section });
    }
    entry.cidDict.set("W", { k: "arr", items: wItems });

    /* FontFile2 — the subset bytes, FlateDecode (our own zlib). */
    const subsetBytes = entry.subsetter.encode();
    const flated = flateImageBytes(subsetBytes);
    entry.fileStream.raw = flated;
    entry.fileStream.m.set("Length", num(flated.length));

    /* ToUnicode — pdf-lib createCmap (first-ask codePoints, <> for
     * multi-sub products — byte-parity with the oracle). */
    let cmapBody = "";
    for (let sid = 1; sid <= sidCount; sid++) {
      const cps = entry.cpsBySid.get(sid) ?? [];
      let hex = "";
      for (const cp of cps) {
        if (cp <= 0xffff) {
          hex += cp.toString(16).padStart(4, "0");
        } else {
          const hs = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
          const ls = ((cp - 0x10000) % 0x400) + 0xdc00;
          hex += hs.toString(16).padStart(4, "0") + ls.toString(16).padStart(4, "0");
        }
      }
      cmapBody += `<${sid.toString(16).padStart(4, "0")}> <${hex}>\n`;
    }
    const cmapText =
      "/CIDInit /ProcSet findresource begin\n" +
      "12 dict begin\nbegincmap\n/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n" +
      "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n" +
      `${sidCount} beginbfchar\n${cmapBody}endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    const cmapBytes = LATIN1(cmapText);
    const cmapFlated = flateImageBytes(cmapBytes);
    entry.cmapStream.raw = cmapFlated;
    entry.cmapStream.m.set("Length", num(cmapFlated.length));
  }
}

/* ─── the page handle (pdf-lib PDFPage-shaped) ────────────────────────────── */

export interface CreatePage {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  drawText(opts: CreateTextOptions): void;
  drawRectangle(opts: CreateRectOptions): void;
  drawLine(opts: CreateLineOptions): void;
  drawRoundedRectangle(opts: CreateRoundedRectOptions): void;
  drawEllipse(opts: CreateEllipseOptions): void;
  drawImage(image: CreateImage, opts: CreateImageOptions): void;
}

class CreatePageImpl implements CreatePage {
  constructor(
    private readonly ctx: CreateContext,
    private readonly rec: CreatedPageRec,
    readonly index: number,
  ) {}

  get width(): number {
    return this.rec.width;
  }

  get height(): number {
    return this.rec.height;
  }

  drawText(opts: CreateTextOptions): void {
    if (opts.text.length === 0) return;
    if (typeof opts.size !== "number" || !Number.isFinite(opts.size) || opts.size <= 0) {
      throw new PdfError("corrupt", "drawText size must be positive");
    }
    const fontKey = opts.font ?? "helvetica";
    const token = opts.ttf ? "ttf:1" : this.ctx.ensureFontToken(fontKey);
    const hex = opts.ttf
      ? opts.ttf.encodeHex(opts.text)
      : encodeWinAnsiHex(opts.text, fontKey); // throws "chars" parity
    const key = this.ctx.localKey(this.rec, token, "F");
    const gs =
      opts.opacity !== undefined ? this.ctx.ensureGsToken(opts.opacity) : undefined;
    const gsKey = gs ? this.ctx.localKey(this.rec, gs, "GS") : undefined;

    const color = opts.color ?? { r: 0, g: 0, b: 0 };
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    if (opts.characterSpacing !== undefined) {
      // The Tc route (P6-l): pdf-lib's raw pushOperators shape — the old
      // create-resume Painter authored exactly this sequence through
      // setCharacterSpacing/moveText/showText, so tracked headings keep
      // their one-contiguous-literal contract (extractors read the whole
      // word). No TL/T*, Td instead of Tm.
      this.ctx.push(
        this.rec,
        [
          "q",
          ...(gsKey ? [`/${gsKey} gs`] : []),
          "BT",
          `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`,
          `/${key} ${pdfNumToString(opts.size)} Tf`,
          `${pdfNumToString(opts.characterSpacing)} Tc`,
          `${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} Td`,
          `<${hex.toUpperCase()}> Tj`,
          "ET",
          "Q",
        ].join("\n"),
      );
      return;
    }

    this.ctx.push(
      this.rec,
      [
        "q",
        ...(gsKey ? [`/${gsKey} gs`] : []),
        "BT",
        `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`,
        `/${key} ${pdfNumToString(opts.size)} Tf`,
        // pdf-lib's PDFPage.drawText goes through drawLinesOfText: a line-height
        // TL (page default 24) and a trailing T* even for one line. Emitted
        // here for exact operator parity with the oracle.
        `${pdfNumToString(opts.lineHeight ?? 24)} TL`,
        `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} Tm`,
        `<${hex.toUpperCase()}> Tj`,
        "T*",
        "ET",
        "Q",
      ].join("\n"),
    );
  }

  drawRectangle(opts: CreateRectOptions): void {
    const color = opts.color;
    const borderColor = opts.borderColor;
    if (!color && !borderColor) {
      // pdf-lib defaults the fill to black when neither color is given.
      return this.drawRectangle({ ...opts, color: { r: 0, g: 0, b: 0 } });
    }
    const hasBothOpacity =
      opts.opacity !== undefined || opts.borderOpacity !== undefined;
    const gs = hasBothOpacity
      ? this.ctx.ensureGsPairToken(opts.opacity, opts.borderOpacity)
      : undefined;
    const gsKey = gs ? this.ctx.localKey(this.rec, gs, "GS") : undefined;
    const borderWidth = opts.borderWidth ?? 0;
    const w = pdfNumToString(opts.width);
    const h = pdfNumToString(opts.height);
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.ctx.push(
      this.rec,
      [
        "q",
        ...(gsKey ? [`/${gsKey} gs`] : []),
        ...(color
          ? [`${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`]
          : []),
        ...(borderColor
          ? [
              `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
            ]
          : []),
        `${pdfNumToString(borderWidth)} w`,
        ...(opts.borderDashArray && opts.borderDashArray.length > 0
          ? [
              `[${opts.borderDashArray.map(pdfNumToString).join(" ")}] 0 d`,
            ]
          : ["[] 0 d"]),
        `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} cm`,
        `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
        "1 0 0 1 0 0 cm", // skew(0,0) — pdf-lib always emits the identity
        "0 0 m",
        `0 ${h} l`,
        `${w} ${h} l`,
        `${w} 0 l`,
        "h",
        color && borderWidth ? "B"
          : color ? "f"
            : borderColor ? "S"
              : "h",
        "Q",
      ].join("\n"),
    );
  }

  drawLine(opts: CreateLineOptions): void {
    const color = opts.color ?? { r: 0, g: 0, b: 0 };
    const thickness = opts.thickness ?? 1;
    const dash =
      opts.dashArray && opts.dashArray.length > 0
        ? `[${opts.dashArray.map((v) => pdfNumToString(v)).join(" ")}] 0 d`
        : "[] 0 d";
    this.ctx.push(
      this.rec,
      [
        "q",
        `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} RG`,
        `${pdfNumToString(thickness)} w`,
        dash,
        `${pdfNumToString(opts.start.x)} ${pdfNumToString(opts.start.y)} m`,
        // pdf-lib's drawLine emits moveTo TWICE (api/operations.js) — the
        // duplicate is preserved for parity with the oracle's streams.
        `${pdfNumToString(opts.start.x)} ${pdfNumToString(opts.start.y)} m`,
        `${pdfNumToString(opts.end.x)} ${pdfNumToString(opts.end.y)} l`,
        "S",
        "Q",
      ].join("\n"),
    );
  }

  drawRoundedRectangle(opts: CreateRoundedRectOptions): void {
    const color = opts.color;
    const borderColor = opts.borderColor;
    if (!color && !borderColor) {
      // pdf-lib's drawPath defaults the fill to black when neither is given.
      return this.drawRoundedRectangle({
        ...opts,
        color: { r: 0, g: 0, b: 0 },
      });
    }
    const borderWidth = opts.borderColor ? (opts.borderWidth ?? 1) : 0;
    const rr = Math.min(opts.radius, opts.width / 2, opts.height / 2);
    const w = opts.width;
    const h = opts.height;
    // Local SVG-space coordinates (y grows down from yTop — the translate
    // + y-flip cm pair below is exactly pdf-lib's drawSvgPath shape, probed:
    //   1 0 0 1 x yTop cm / 1 0 0 1 0 0 cm / 1 0 0 -1 0 0 cm
    // The four quarter-arc control points use the same κ as drawEllipse
    // (4/3·(√2−1) = 4/3·tan(π/8)); their positions were verified against
    // pdf-lib's arcToCubicCurves output for sweep-1 quarter arcs.
    const k = rr * KAPPA;
    const path: string[] = [];
    if (rr <= 0) {
      path.push(
        `0 0 m`,
        `${pdfNumToString(w)} 0 l`,
        `${pdfNumToString(w)} ${pdfNumToString(h)} l`,
        `0 ${pdfNumToString(h)} l`,
        "h",
      );
    } else {
      path.push(
        `${pdfNumToString(rr)} 0 m`,
        `${pdfNumToString(w - rr)} 0 l`,
        // TR arc: (w−r,0) → (w,r), controls (w−r+k,0) (w,r−k)
        `${pdfNumToString(w - rr + k)} 0 ${pdfNumToString(w)} ${pdfNumToString(rr - k)} ${pdfNumToString(w)} ${pdfNumToString(rr)} c`,
        `${pdfNumToString(w)} ${pdfNumToString(h - rr)} l`,
        // BR arc: (w,h−r) → (w−r,h), controls (w,h−r+k) (w−r+k,h)
        `${pdfNumToString(w)} ${pdfNumToString(h - rr + k)} ${pdfNumToString(w - rr + k)} ${pdfNumToString(h)} ${pdfNumToString(w - rr)} ${pdfNumToString(h)} c`,
        `${pdfNumToString(rr)} ${pdfNumToString(h)} l`,
        // BL arc: (r,h) → (0,h−r), controls (r−k,h) (0,h−r+k)
        `${pdfNumToString(rr - k)} ${pdfNumToString(h)} 0 ${pdfNumToString(h - rr + k)} 0 ${pdfNumToString(h - rr)} c`,
        `0 ${pdfNumToString(rr)} l`,
        // TL arc: (0,r) → (r,0), controls (0,r−k) (r−k,0)
        `0 ${pdfNumToString(rr - k)} ${pdfNumToString(rr - k)} 0 ${pdfNumToString(rr)} 0 c`,
        "h",
      );
    }
    this.ctx.push(
      this.rec,
      [
        "q",
        `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.yTop)} cm`,
        "1 0 0 1 0 0 cm", // rotate(0) — pdf-lib always emits the identity
        "1 0 0 -1 0 0 cm", // scale(1, −1) — the SVG y-flip
        ...(color
          ? [`${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`]
          : []),
        ...(borderColor
          ? [
              `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
              `${pdfNumToString(borderWidth)} w`,
            ]
          : []),
        "[] 0 d",
        ...path,
        color && borderColor ? "B"
          : color ? "f"
            : "S",
        "Q",
      ].join("\n"),
    );
  }

  drawEllipse(opts: CreateEllipseOptions): void {
    const color = opts.color;
    const borderColor = opts.borderColor;
    if (!color && !borderColor) {
      return this.drawEllipse({ ...opts, color: { r: 0, g: 0, b: 0 } });
    }
    const borderWidth = opts.borderWidth ?? 0;
    const gs =
      opts.opacity !== undefined ? this.ctx.ensureGsToken(opts.opacity) : undefined;
    const gsKey = gs ? this.ctx.localKey(this.rec, gs, "GS") : undefined;
    // drawEllipsePath's translated coordinate frame (pdf-lib operations.js):
    // the box origin is one radius left/below the center.
    const x = opts.x - opts.xScale;
    const y = opts.y - opts.yScale;
    const ox = opts.xScale * KAPPA;
    const oy = opts.yScale * KAPPA;
    const xe = x + opts.xScale * 2;
    const ye = y + opts.yScale * 2;
    const xm = x + opts.xScale;
    const ym = y + opts.yScale;
    this.ctx.push(
      this.rec,
      [
        "q",
        ...(gsKey ? [`/${gsKey} gs`] : []),
        ...(color
          ? [`${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`]
          : []),
        ...(borderColor
          ? [
              `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
            ]
          : []),
        `${pdfNumToString(borderWidth)} w`,
        "[] 0 d",
        "q", // pdf-lib's drawEllipsePath wraps the path in its own q/Q
        `${pdfNumToString(x)} ${pdfNumToString(ym)} m`,
        `${pdfNumToString(x)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xm - ox)} ${pdfNumToString(y)} ${pdfNumToString(xm)} ${pdfNumToString(y)} c`,
        `${pdfNumToString(xm + ox)} ${pdfNumToString(y)} ${pdfNumToString(xe)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xe)} ${pdfNumToString(ym)} c`,
        `${pdfNumToString(xe)} ${pdfNumToString(ym + oy)} ${pdfNumToString(xm + ox)} ${pdfNumToString(ye)} ${pdfNumToString(xm)} ${pdfNumToString(ye)} c`,
        `${pdfNumToString(xm - ox)} ${pdfNumToString(ye)} ${pdfNumToString(x)} ${pdfNumToString(ym + oy)} ${pdfNumToString(x)} ${pdfNumToString(ym)} c`,
        "Q",
        color && borderWidth ? "B"
          : color ? "f"
            : borderColor ? "S"
              : "h",
        "Q",
      ].join("\n"),
    );
  }

  drawImage(image: CreateImage, opts: CreateImageOptions): void {
    if (
      typeof opts.width !== "number" || typeof opts.height !== "number" ||
      !Number.isFinite(opts.width) || !Number.isFinite(opts.height) ||
      opts.width <= 0 || opts.height <= 0
    ) {
      throw new PdfError("corrupt", "drawImage box must be positive");
    }
    if (!image || !this.ctx.hasToken(image.token)) {
      throw new PdfError("corrupt", "drawImage: unknown image handle");
    }
    const key = this.ctx.localKey(this.rec, image.token, "Im");
    const gs =
      opts.opacity !== undefined ? this.ctx.ensureGsToken(opts.opacity) : undefined;
    const gsKey = gs ? this.ctx.localKey(this.rec, gs, "GS") : undefined;

    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    this.ctx.push(
      this.rec,
      [
        "q",
        ...(gsKey ? [`/${gsKey} gs`] : []),
        `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} cm`,
        `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
        `${pdfNumToString(opts.width)} 0 0 ${pdfNumToString(opts.height)} 0 0 cm`,
        "1 0 0 1 0 0 cm", // skew(0,0) — pdf-lib always emits the identity
        `/${key} Do`,
        "Q",
      ].join("\n"),
    );
  }
}
