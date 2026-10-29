/**
 * DocoPDF own PDF micro-engine — the stamp kernel (P6-f).
 *
 * Stamps text (base-14 standard fonts, WinAnsi) and images (JPEG passthrough,
 * PNG decoded to RGB+SMask) onto chosen pages of ONE parsed document, then
 * writes through the shared writer — 100% our code, zero pdf-lib.
 *
 * Content-stream operator sequences mirror pdf-lib's drawText/drawImage
 * exactly (q /GS gs BT rg Tf Tm <hex> Tj ET Q and the translate/rotate/scale
 * cm triple) so outputs are drop-in comparable against the legacy engine:
 *
 *   drawText:  q [gs] BT r g b rg /F1 size Tf cos sin -sin cos x y Tm <hex> Tj ET Q
 *   drawImage: q [gs] 1 0 0 1 x y cm cos sin -sin cos 0 0 cm w 0 0 h 0 0 cm /Im0 Do Q
 *   drawForm:  q [gs] 1 0 0 1 x y cm cos sin -sin cos 0 0 cm xScale 0 0 yScale 0 0 cm /Fm1 Do Q
 *             (P6-j — pdf-lib drawPage: the scale cm carries RATIOs; the gs
 *              carries BOTH ca and CA, the overlay worker's patched state)
 *
 * "Behind content" is native here: the stamp stream is PREPENDED to the
 * page's /Contents array (pdf-lib had to append-then-move; we build the
 * final array directly). Resource names are allocated per page against the
 * existing entries (no /F1 shadowing), fonts/ExtGStates are deduplicated
 * across the whole document, and the effective (inherited-or-own) Resources
 * dict is resolved, cloned and merged so nothing else on the page breaks.
 *
 * Per-page behind/front: ONE flag per page (last call wins) — the stamp tools
 * use a single mode per run.
 *
 * P6-j adds the overlay route: embedForm() embeds a page of ANOTHER parsed
 * document as a source-anchored Form XObject (pdf-lib's default embedPdf
 * box), and stampForm() draws it with pdf-lib drawPage parity. The overlay
 * document's referenced graphs (fonts, nested XObjects) are BFS-copied
 * exactly once per source object by the shared writer.
 */

import { parseForOrganize, type OrganizeSource } from "./ops";
import { pageFormEmbed } from "./compose";
import { latin1 } from "./lexer";
import {
  type PdfObj,
  arr,
  asDict,
  cloneDict,
  lstr,
  newDict,
  num,
  newref,
  pdfNumToString,
} from "./objects";
import { PdfError, resolve, type ParsedPdf } from "./parser";
import {
  encodeWinAnsiHex,
  measureStdText,
  type StampFontKey,
} from "./stamp-fonts";
import { decodePng, flateImageBytes, parseJpeg } from "./images";
import { ParsedTtfFont, TtfSubsetter } from "./font-ttf";
import { shapeText } from "./shape-deva";
import {
  listPages,
  materializeInheritable,
  type PdfPageInfo,
} from "./document";
import { writeDocument, type WritePage, type WriteSynthetic } from "./writer";

export interface StampTextOptions {
  /** Baseline-left x in PDF user space (pdf-lib semantics). */
  x: number;
  /** Baseline y in PDF user space. */
  y: number;
  text: string;
  size: number;
  /** Standard-font key (required unless `ttf` is provided). */
  font?: StampFontKey;
  /** 0..1 RGB. Default black (pdf-lib's default fontColor). */
  color?: { r: number; g: number; b: number };
  /** 0..1; omit for fully opaque (no ExtGState emitted — pdf-lib parity). */
  opacity?: number;
  /** Degrees counter-clockwise. Default 0. */
  rotate?: number;
  /** Draw UNDER the existing content (watermark "behind"). Default false. */
  behind?: boolean;
}

export interface StampImageOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1; omit for fully opaque. */
  opacity?: number;
  /** Degrees counter-clockwise. Default 0. */
  rotate?: number;
  behind?: boolean;
}

/** An embedded image handle — pass to stampImage(). */
export interface StampImage {
  readonly width: number;
  readonly height: number;
}

/** An embedded TrueType (Type0/CIDFontType2 subset) font handle (P6-g). */
export interface StampTtfFont {
  /** pdf-lib CustomFontEmbedder.widthOfTextAtSize parity (float-exact). */
  measure(text: string, size: number): number;
  /** pdf-lib CustomFontEmbedder.heightOfFontAtSize parity (P6-o — the
   * edit-pdf baseline math; `descender` defaults true like pdf-lib). */
  heightAtSize(size: number, options?: { descender?: boolean }): number;
  /** @internal — shaped subset-id hex; records glyphs for embedding. */
  encodeHex(text: string): string;
}

/** An embedded PAGE form handle (P6-j, the overlay route) — pass to
 * stampForm(). width/height are the page's MediaBox dims (pdf-lib's default
 * `embedPdf` box: media origin discarded). */
export interface StampForm {
  readonly width: number;
  readonly height: number;
}

/** Draw options for an embedded page form (pdf-lib drawPage parity). */
export interface StampFormOptions {
  /** Draw-box origin (pdf-lib rotates around this point). */
  x: number;
  y: number;
  /** Draw-box size; the form is scaled by width/form.width ratios. */
  width: number;
  height: number;
  /** 0..1; omit for fully opaque (no ExtGState emitted). */
  opacity?: number;
  /** Degrees counter-clockwise. Default 0. */
  rotate?: number;
  /** Draw UNDER the existing content. Default false. */
  behind?: boolean;
}

/* ─── P6-o: shape stamping (pdf-lib drawRectangle/drawEllipse/drawLine) ──── */

/** 0..1 RGB (same shape everywhere else in the engine). */
export interface StampRgb {
  r: number;
  g: number;
  b: number;
}

export interface StampRectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: StampRgb;
  borderColor?: StampRgb;
  /** Default 1 (pdf-lib drawRectangle). */
  borderWidth?: number;
  /** Fill opacity → /ca. */
  opacity?: number;
  /** Stroke opacity → /CA (both ride ONE merged ExtGState). */
  borderOpacity?: number;
  /** e.g. [4, 3] → "[4 3] 0 d" after the width op. */
  borderDashArray?: number[];
  /** Degrees counter-clockwise (rotates around x,y like pdf-lib). */
  rotate?: number;
  behind?: boolean;
}

export interface StampEllipseOptions {
  /** Ellipse CENTER (pdf-lib drawEllipse semantics). */
  x: number;
  y: number;
  xScale: number;
  yScale: number;
  color?: StampRgb;
  borderColor?: StampRgb;
  /** Default 1 (pdf-lib drawEllipse). */
  borderWidth?: number;
  opacity?: number;
  borderOpacity?: number;
  borderDashArray?: number[];
  behind?: boolean;
}

export interface StampLineOptions {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Default 1 (pdf-lib drawLine). */
  thickness?: number;
  color?: StampRgb;
  /** Stroke opacity → /CA ONLY (pdf-lib maybeEmbedGraphicsState
   * (borderOpacity) — no /ca on lines). */
  opacity?: number;
  /** 0..2 → "n J" BETWEEN the double moveTo (pdf-lib quirk). */
  lineCap?: number;
  dashArray?: number[];
  behind?: boolean;
}

/* ─── P6-o: slot plans (the edit surface's page surgery) ─────────────────── */

/** One OUTPUT slot: source page (0-based), duplicates allowed, plus
 * own-dict overrides on the copied page (edit-pdf's R13 /Rotate rewrite
 * and R15 /CropBox window). */
export interface StampSlot {
  src: number;
  /** Applied AFTER materializeInheritable — explicit entries win. */
  set?: Array<[string, PdfObj]>;
}

/* ─── P6-o: AcroForm builder (pdf-lib PDFForm parity) ───────────────────── */

/** Widget chrome — the pdf-lib addToPage options the tools pass. */
export interface StampFieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Default 1 (pdf-lib createWidget). */
  borderWidth?: number;
  borderColor?: StampRgb;
}

export interface StampTextField {
  enableMultiline(): StampTextField;
  enableRequired(): StampTextField;
  setText(text: string): StampTextField;
  addToSlot(slot: number, rect: StampFieldRect): void;
}

export interface StampCheckBox {
  check(): StampCheckBox;
  enableRequired(): StampCheckBox;
  addToSlot(slot: number, rect: StampFieldRect): void;
}

export interface StampDropdown {
  addOptions(...options: string[]): StampDropdown;
  select(value: string): StampDropdown;
  enableRequired(): StampDropdown;
  addToSlot(slot: number, rect: StampFieldRect): void;
}

export interface StampRadioGroup {
  enableRequired(): StampRadioGroup;
  addOptionToSlot(slot: number, option: string, rect: StampFieldRect): void;
}

/** One form field under construction (P6-o — internal bookkeeping). */
interface StampFormField {
  num: number;
  kind: "text" | "checkbox" | "dropdown" | "radio";
  /** Lives in synthetics — mutated until write(). */
  dict: PdfObj & { k: "dict" };
  required: boolean;
  multiline: boolean;
  value: string | undefined;
  options: string[];
  selected: string | undefined;
  optValues: string[];
  widgets: StampFormWidget[];
}

interface StampFormWidget {
  slot: number;
  borderWidth: number;
  borderColor: StampRgb;
  width: number;
  height: number;
  /** true → radio (ellipse family), else checkbox. */
  radio?: boolean;
  /** [N] for text/dropdown; [N-on, N-off, D-on, D-off] for buttons. */
  apStreams: Array<PdfObj & { k: "stream" }>;
}

/** One embedded TTF's reserved objects + accumulated state (all mutable so
 * the subset/W/ToUnicode materialize at write() time — pdf-lib embeds lazily
 * at save() the same way). */
interface TtfEntry {
  font: ParsedTtfFont;
  subsetter: TtfSubsetter;
  /** Shared glyph-object memory across shapeText calls (fontkit semantics). */
  session: Map<number, number[]>;
  /** subset id → codePoints (first ask — the shared-glyph value pdf-lib reads). */
  cpsBySid: Map<number, number[]>;
  scale: number;
  token: string;
  type0Num: number;
  cidDict: Map<string, PdfObj>;
  fileStream: PdfObj & { k: "stream"; raw: Uint8Array };
  cmapStream: PdfObj & { k: "stream"; raw: Uint8Array };
}

interface FontEntry {
  num: number;
  token: string;
}

interface ImageEntry {
  num: number;
  token: string;
  width: number;
  height: number;
}

interface GsEntry {
  num: number;
  token: string;
}

interface FormEntry {
  num: number;
  token: string;
  width: number;
  height: number;
}

const ENC = new TextEncoder();

/** latin1 encode (PDFDocEncoding for CIDSystemInfo strings / CMap text). */
const LATIN1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
const LATIN1_ENCODE = LATIN1;

/**
 * ONE parsed document + accumulated stamps. Build with load(); stamp pages;
 * write() as often as needed (write is non-destructive — the page plan is
 * rebuilt from the layers on every call, and stamping more in between works).
 */
export class StampContext {
  readonly pageCount: number;
  /** Read-only page facts (boxes/rotation) for placement math. */
  readonly pages: readonly PdfPageInfo[];

  private readonly source: OrganizeSource;
  /** P6-j: synthetics may be source-anchored (overlay forms). */
  private readonly synthetics: WriteSynthetic[] = [];
  private nextNum: number;
  /** P6-o: slot plan (edit surface surgery) — null = identity. */
  private slots: StampSlot[] | null = null;
  /** P6-o: appended annotation refs per SLOT (annotate + form widgets). */
  private readonly slotAnnots = new Map<number, PdfObj[]>();
  /** P6-o: the AcroForm builder's fields (see the forms section below). */
  private readonly formFields: StampFormField[] = [];
  private acroFormNum: number | null = null;
  private acroFormDict: PdfObj & { k: "dict" } | null = null;
  /** P6-o-b: passthrough /AcroForm number (null = none; undefined = unresolved). */
  private sourceAcroPassthroughNum: number | null | undefined = undefined;
  private formFontNum: number | null = null;
  private readonly fonts = new Map<StampFontKey, FontEntry>();
  private readonly images = new Map<StampImage, ImageEntry>();
  /** Embedded page forms (P6-j), by their unique handle. */
  private readonly forms = new Map<StampForm, FormEntry>();
  private readonly gsStates = new Map<string, GsEntry>();
  /** The ca?-flavored CA? pair states (P6-o shapes — pdf-lib merged gs). */
  private readonly gsPairStates = new Map<string, GsEntry>();
  /** The ca+CA flavor (pdf-lib drawPage + the overlay worker's CA patch). */
  private readonly gsBothStates = new Map<string, GsEntry>();
  /** ops fragments per page; [0] is the "front"/"behind" marker. */
  private layers: (string[] | undefined)[] = [];
  /** page → reserved stamp-stream object number. */
  private readonly streamNums = new Map<number, number>();
  /** page → index into synthetics of that stream object. */
  private readonly streamIndex = new Map<number, number>();
  /** The one embedded TTF (the stamp tools embed exactly one per run). */
  private ttf: TtfEntry | null = null;
  /** `${pageIndex}:${category}:${token}` → local resource name. */
  private readonly localKeys = new Map<string, string>();

  private constructor(source: OrganizeSource) {
    this.source = source;
    this.pageCount = source.pages.length;
    this.pages = source.pages;
    this.nextNum = 3 + this.pageCount;
    this.layers = new Array<string[] | undefined>(this.pageCount);
  }
  /** Parse a document for stamping. Throws typed "encrypted"/"corrupt". */
  static load(bytes: Uint8Array): StampContext {
    return new StampContext(parseForOrganize(bytes));
  }

  /** The parsed document (for callers needing raw access). */
  get doc(): ParsedPdf {
    return this.source.doc;
  }

  /**
   * P6-o: install the SLOT plan — the edit surface's page surgery as pure
   * data (src duplicates, removals by omission, reorder, per-slot
   * /Rotate//CropBox overrides). Must be called BEFORE any stamping; the
   * identity default (no plan) keeps every existing caller byte-identical.
   * Stamps/annots are keyed by SLOT index afterwards.
   */
  setSlotPlan(plan: StampSlot[]): void {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new PdfError("corrupt", "slot plan must be a non-empty array");
    }
    if (plan.length > 200_000) {
      throw new PdfError("corrupt", "slot plan exceeds sanity cap");
    }
    for (const slot of plan) {
      if (
        !Number.isInteger(slot.src) || slot.src < 0 ||
        slot.src >= this.pageCount
      ) {
        throw new PdfError("corrupt", `slot src ${slot.src} out of range`);
      }
    }
    this.slots = plan;
    this.nextNum = 3 + plan.length;
    this.layers = new Array<string[] | undefined>(plan.length);
    this.localKeys.clear();
    this.streamNums.clear();
    this.streamIndex.clear();
  }

  /** Output slot count (P6-o; identity plans = the page count). */
  get slotCount(): number {
    return this.slots ? this.slots.length : this.pageCount;
  }

  /**
   * P6-o: append a self-contained annotation object to a slot's page
   * /Annots (the annotate-pdf route). The dict may reference other
   * appendAnnot objects via newref(). Existing source /Annots are kept
   * (ours go LAST, matching pdf-lib's addAnnot).
   */
  appendAnnot(slot: number, dict: PdfObj): void {
    this.page(slot); // range check
    if (dict.k !== "dict") {
      throw new PdfError("corrupt", "appendAnnot: dict object required");
    }
    const objNum = this.reserve();
    const synthetic: PdfObj = { k: "dict", m: dict.m };
    this.synthetics.push(synthetic);
    let list = this.slotAnnots.get(slot);
    if (!list) {
      list = [];
      this.slotAnnots.set(slot, list);
    }
    list.push(newref(objNum));
  }

  /**
   * Document /Title via the trailer /Info (UTF-16BE or PDFDocEncoding-ish
   * latin1), "" when absent — the {title} variable source in the stamp tools.
   */
  getTitle(): string {
    const infoObj = this.source.doc.trailer.get("Info");
    const info = infoObj ? resolve(this.source.doc, infoObj) : undefined;
    const titleObj =
      info && (info.k === "dict" || info.k === "stream")
        ? info.m.get("Title")
        : undefined;
    if (!titleObj || titleObj.k !== "str") return "";
    return decodePdfText(titleObj.b);
  }

  /** pdf-lib-identical width of `text` in a standard font (kerning included). */
  measure(text: string, font: StampFontKey, size: number): number {
    return measureStdText(text, font, size);
  }

  /** Embed a JPEG (DCT passthrough). Returns the reusable draw handle. */
  embedJpeg(bytes: Uint8Array): StampImage {
    const info = parseJpeg(bytes);
    const objNum = this.reserve();
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
    this.synthetics.push({ k: "stream", m: dict.m, raw: info.bytes });
    return this.registerImage(info.width, info.height, objNum);
  }

  /** Embed a PNG (decoded to DeviceRGB 8bpc + optional alpha SMask). */
  embedPng(bytes: Uint8Array): StampImage {
    const png = decodePng(bytes);
    const imageNum = this.reserve();
    let smaskNum: number | undefined;
    if (png.alpha !== undefined) {
      smaskNum = this.reserve();
    }
    const dict = newDict([
      ["Type", { k: "name", v: "XObject" }],
      ["Subtype", { k: "name", v: "Image" }],
      ["Width", num(png.width)],
      ["Height", num(png.height)],
      ["ColorSpace", { k: "name", v: "DeviceRGB" }],
      ["BitsPerComponent", num(8)],
      ["Filter", { k: "name", v: "FlateDecode" }],
      ...(smaskNum !== undefined
        ? [["SMask" as const, newref(smaskNum)] as [string, PdfObj]]
        : []),
    ]);
    this.synthetics.push({
      k: "stream",
      m: dict.m,
      raw: flateImageBytes(png.rgb),
    });
    if (png.alpha !== undefined && smaskNum !== undefined) {
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
    }
    return this.registerImage(png.width, png.height, imageNum);
  }

  /**
   * Embed a TrueType font for Unicode text stamps (P6-g — the Devanagari
   * route). Shapes through OUR GSUB/Indic shaper (fontkit-parity, verified
   * in smoke-pdf-core), includes glyphs into a fontkit-parity subset, and
   * materializes the Type0/CIDFontType2/FontDescriptor/FontFile2/ToUnicode
   * objects at write() time — pdf-lib's lazy save-time embedding mirrored
   * exactly (W sections, first-write-wins ToUnicode lineage and all).
   */
  embedTtf(bytes: Uint8Array): StampTtfFont {
    if (this.ttf) throw new PdfError("corrupt", "only one embedded TTF per StampContext");
    const font = ParsedTtfFont.parse(bytes); // throws typed "chars"
    const subsetter = new TtfSubsetter(font);
    const type0Num = this.reserve();
    const cidNum = this.reserve();
    const fdNum = this.reserve();
    const fileNum = this.reserve();
    const cmapNum = this.reserve();

    const baseName = font.postscriptName || "Font";
    const scale = 1000 / font.unitsPerEm;

    this.synthetics.push(
      newDict([
        ["Type", { k: "name", v: "Font" }],
        ["Subtype", { k: "name", v: "Type0" }],
        ["BaseFont", { k: "name", v: baseName }],
        ["Encoding", { k: "name", v: "Identity-H" }],
        ["DescendantFonts", { k: "arr", items: [newref(cidNum)] }],
        ["ToUnicode", newref(cmapNum)],
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
      ["FontDescriptor", newref(fdNum)],
      ["W", { k: "arr", items: [] }], // materialized at write()
    ]);
    this.synthetics.push(cidDict);

    // pdf-lib deriveFontFlags: symbolic + (post.isFixedPitch) + (serif class
    // 1..7) + (script class 10) + (head macStyle italic).
    let flags = 4; // symbolic (bit 3)
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
        ["FontFile2", newref(fileNum)],
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
      token: "ttf:1",
      type0Num,
      cidDict: cidDict.m,
      fileStream,
      cmapStream,
    };
    this.ttf = entry;

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
        // pdf-lib CustomFontEmbedder.heightOfFontAtSize: yTop − yBottom in
        // 1000-units, minus |descent| when the descender is excluded.
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

  /** Stamp one text run onto a page. Throws typed "chars" on non-WinAnsi
   * text (standard-font path). The `ttf` path shapes through the embedded
   * TrueType font instead (P6-g — the Devanagari route). */
  stampText(pageIndex: number, opts: StampTextOptions & { ttf?: StampTtfFont }): void {
    this.page(pageIndex);
    if (opts.text.length === 0) return;
    if (typeof opts.size !== "number" || !Number.isFinite(opts.size) || opts.size <= 0) {
      throw new PdfError("corrupt", "stamp text size must be positive");
    }
    if (opts.ttf) {
      this.stampTtfText(pageIndex, opts as StampTextOptions & { ttf: StampTtfFont });
      return;
    }
    const fontKey = opts.font ?? "helvetica";
    const font = this.ensureFont(fontKey);
    const hex = encodeWinAnsiHex(opts.text, fontKey); // throws "chars" parity
    const key = this.resourceKey(pageIndex, "Font", font.token, "F");
    const gs = opts.opacity !== undefined ? this.ensureGs(opts.opacity) : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;

    const color = opts.color ?? { r: 0, g: 0, b: 0 };
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const ops: string[] = [
      "q",
      ...(gsKey ? [`/${gsKey} gs`] : []),
      "BT",
      `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`,
      `/${key} ${pdfNumToString(opts.size)} Tf`,
      `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} Tm`,
      `<${hex}> Tj`,
      "ET",
      "Q",
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /** The TTF text path — same operator sequence, Identity-H subset CIDs. */
  private stampTtfText(pageIndex: number, opts: StampTextOptions & { ttf: StampTtfFont }): void {
    const entry = this.ttf;
    if (!entry) throw new PdfError("corrupt", "stampTtfText: no embedded TTF");
    const hex = opts.ttf.encodeHex(opts.text);
    const key = this.resourceKey(pageIndex, "Font", entry.token, "F");
    const gs = opts.opacity !== undefined ? this.ensureGs(opts.opacity) : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;

    const color = opts.color ?? { r: 0, g: 0, b: 0 };
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const ops: string[] = [
      "q",
      ...(gsKey ? [`/${gsKey} gs`] : []),
      "BT",
      `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} rg`,
      `/${key} ${pdfNumToString(opts.size)} Tf`,
      `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} Tm`,
      `<${hex}> Tj`,
      "ET",
      "Q",
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /** Stamp an embedded image onto a page. */
  stampImage(pageIndex: number, image: StampImage, opts: StampImageOptions): void {
    const entry = this.images.get(image);
    if (!entry) {
      throw new PdfError("corrupt", "stampImage: unknown image handle");
    }
    this.page(pageIndex);
    if (
      typeof opts.width !== "number" || typeof opts.height !== "number" ||
      !Number.isFinite(opts.width) || !Number.isFinite(opts.height) ||
      opts.width <= 0 || opts.height <= 0
    ) {
      throw new PdfError("corrupt", "stamp image box must be positive");
    }
    const key = this.resourceKey(pageIndex, "XObject", entry.token, "Im");
    const gs = opts.opacity !== undefined ? this.ensureGs(opts.opacity) : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;

    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const ops: string[] = [
      "q",
      ...(gsKey ? [`/${gsKey} gs`] : []),
      `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} cm`,
      `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
      `${pdfNumToString(opts.width)} 0 0 ${pdfNumToString(opts.height)} 0 0 cm`,
      `/${key} Do`,
      "Q",
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /**
   * Embed ONE page of ANOTHER document as a Form XObject (P6-j — the
   * overlay route). Mirrors pdf-lib's DEFAULT `embedPdf` box: BBox =
   * [0, 0, mediaW, mediaH] (the MediaBox dims, origin discarded), identity
   * Matrix, q/Q-wrapped decoded contents, Resources own-or-inherited. The
   * form rides as a SOURCE-ANCHORED synthetic: its /Resources refs remap
   * through the overlay document's copy map and the referenced graphs
   * (fonts, nested XObjects…) are BFS-copied exactly once per source object.
   */
  embedForm(source: OrganizeSource, pageIndex: number): StampForm {
    const page = source.pages[pageIndex];
    if (!page) {
      throw new PdfError(
        "corrupt",
        `embedForm: page index ${pageIndex} out of range`,
      );
    }
    const [mx0, my0, mx1, my1] = page.mediaBox;
    const width = mx1 - mx0;
    const height = my1 - my0;
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 || width > 14_400 || height > 14_400
    ) {
      throw new PdfError("corrupt", "embedForm: page has an unusable MediaBox");
    }
    const embed = pageFormEmbed(source.doc, page, {
      left: 0,
      bottom: 0,
      right: width,
      top: height,
    });
    const objNum = this.reserve();
    this.synthetics.push({
      sourceDoc: source.doc,
      obj: {
        k: "stream",
        m: new Map<string, PdfObj>([
          ["Type", { k: "name", v: "XObject" }],
          ["Subtype", { k: "name", v: "Form" }],
          ["FormType", num(1)],
          ["BBox", arr(num(0), num(0), num(width), num(height))],
          // Identity — the default box already sits at the origin.
          ["Matrix", arr(num(1), num(0), num(0), num(1), num(0), num(0))],
          ["Resources", embed.resources ?? { k: "dict", m: new Map() }],
          ["Filter", { k: "name", v: "FlateDecode" }],
        ]),
        raw: embed.content,
      },
    });
    const handle: StampForm = { width, height };
    this.forms.set(handle, {
      num: objNum,
      token: `form:${objNum}`,
      width,
      height,
    });
    return handle;
  }

  /** Draw an embedded page form onto a page (pdf-lib drawPage parity). */
  stampForm(pageIndex: number, form: StampForm, opts: StampFormOptions): void {
    const entry = this.forms.get(form);
    if (!entry) {
      throw new PdfError("corrupt", "stampForm: unknown form handle");
    }
    this.page(pageIndex);
    if (
      typeof opts.width !== "number" || typeof opts.height !== "number" ||
      !Number.isFinite(opts.width) || !Number.isFinite(opts.height) ||
      opts.width <= 0 || opts.height <= 0
    ) {
      throw new PdfError("corrupt", "stamp form box must be positive");
    }
    const key = this.resourceKey(pageIndex, "XObject", entry.token, "Fm");
    // pdf-lib drawPage: the draw box scales the form by RATIOS
    // (width / embeddedPage.width), unlike drawImage's absolute w/h.
    const gs = opts.opacity !== undefined ? this.ensureGsBoth(opts.opacity) : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;

    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const ops: string[] = [
      "q",
      ...(gsKey ? [`/${gsKey} gs`] : []),
      `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} cm`,
      `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
      `${pdfNumToString(opts.width / entry.width)} 0 0 ${pdfNumToString(opts.height / entry.height)} 0 0 cm`,
      `/${key} Do`,
      "Q",
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /* ─── P6-o: shape stamping (pdf-lib drawRectangle/drawEllipse/drawLine
   * operator parity — the sequences were probed live against pdf-lib and
   * are §22-pinned in smoke-pdf-core) ─────────────────────────────────── */

  /** pdf-lib drawRectangle: q [gs] [rg] [RG] w [dash] translate-cm
   * [rotate-cm] [skew-0 cm] 0 0 m 0 h l w h l w 0 l h f|S|B Q. */
  stampRect(pageIndex: number, opts: StampRectOptions): void {
    this.page(pageIndex);
    if (
      !Number.isFinite(opts.x) || !Number.isFinite(opts.y) ||
      !Number.isFinite(opts.width) || !Number.isFinite(opts.height) ||
      opts.width <= 0 || opts.height <= 0
    ) {
      throw new PdfError("corrupt", "stamp rect box must be positive");
    }
    const color = opts.color;
    const borderColor = opts.borderColor;
    if (!color && !borderColor) {
      // pdf-lib defaults the fill to black when neither color is given.
      return this.stampRect(pageIndex, { ...opts, color: { r: 0, g: 0, b: 0 } });
    }
    // ONE merged ExtGState {ca?, CA?} — only the defined keys.
    const gs =
      opts.opacity !== undefined || opts.borderOpacity !== undefined
        ? this.ensureGsPair(opts.opacity, opts.borderOpacity)
        : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;
    const borderWidth = opts.borderWidth ?? 0; // pdf-lib default (probed)
    const w = pdfNumToString(opts.width);
    const h = pdfNumToString(opts.height);
    const dash =
      opts.borderDashArray && opts.borderDashArray.length > 0
        ? `[${opts.borderDashArray.map((v) => pdfNumToString(v)).join(" ")}] 0 d`
        : "[] 0 d";
    const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ops: string[] = [
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
      dash,
      `1 0 0 1 ${pdfNumToString(opts.x)} ${pdfNumToString(opts.y)} cm`,
      opts.rotate !== undefined && opts.rotate !== 0
        ? `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`
        : "1 0 0 1 0 0 cm",
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
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /** pdf-lib drawEllipse: q [gs] [rg] [RG] w [dash] q m c c c c Q f|S|B Q
   * (the inner q/Q pair is drawEllipsePath's quirk, preserved). x/y = the
   * ellipse CENTER (one radius above/left of the path origin). */
  stampEllipse(pageIndex: number, opts: StampEllipseOptions): void {
    this.page(pageIndex);
    if (
      !Number.isFinite(opts.x) || !Number.isFinite(opts.y) ||
      !Number.isFinite(opts.xScale) || !Number.isFinite(opts.yScale) ||
      opts.xScale <= 0 || opts.yScale <= 0
    ) {
      throw new PdfError("corrupt", "stamp ellipse scales must be positive");
    }
    const color = opts.color;
    const borderColor = opts.borderColor;
    if (!color && !borderColor) {
      return this.stampEllipse(pageIndex, { ...opts, color: { r: 0, g: 0, b: 0 } });
    }
    const gs =
      opts.opacity !== undefined || opts.borderOpacity !== undefined
        ? this.ensureGsPair(opts.opacity, opts.borderOpacity)
        : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;
    const borderWidth = opts.borderWidth ?? 0; // pdf-lib default (probed)
    const dash =
      opts.borderDashArray && opts.borderDashArray.length > 0
        ? `[${opts.borderDashArray.map((v) => pdfNumToString(v)).join(" ")}] 0 d`
        : "[] 0 d";
    // drawEllipsePath's translated frame: box origin is one radius
    // left/below the center.
    const x = opts.x - opts.xScale;
    const y = opts.y - opts.yScale;
    const ox = opts.xScale * KAPPA;
    const oy = opts.yScale * KAPPA;
    const xe = x + opts.xScale * 2;
    const ye = y + opts.yScale * 2;
    const xm = x + opts.xScale;
    const ym = y + opts.yScale;
    const ops: string[] = [
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
      dash,
      "q", // drawEllipsePath wraps the path in its own q/Q
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
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /** pdf-lib drawLine: q [gs] [RG] th w [dash] m [J] m l S Q — the moveTo
   * is emitted TWICE with the lineCap BETWEEN them (api/operations.js). */
  stampLine(pageIndex: number, opts: StampLineOptions): void {
    this.page(pageIndex);
    for (const p of [opts.start, opts.end]) {
      if (
        !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      ) {
        throw new PdfError("corrupt", "stamp line endpoints must be finite");
      }
    }
    const color = opts.color ?? { r: 0, g: 0, b: 0 };
    const thickness = opts.thickness ?? 1;
    // drawLine opacity → maybeEmbedGraphicsState({borderOpacity}) → CA only.
    const gs = opts.opacity !== undefined ? this.ensureGsPair(undefined, opts.opacity) : undefined;
    const gsKey = gs ? this.resourceKey(pageIndex, "ExtGState", gs.token, "GS") : undefined;
    const dash =
      opts.dashArray && opts.dashArray.length > 0
        ? `[${opts.dashArray.map((v) => pdfNumToString(v)).join(" ")}] 0 d`
        : "[] 0 d";
    const ops: string[] = [
      "q",
      ...(gsKey ? [`/${gsKey} gs`] : []),
      `${pdfNumToString(color.r)} ${pdfNumToString(color.g)} ${pdfNumToString(color.b)} RG`,
      `${pdfNumToString(thickness)} w`,
      dash,
      `${pdfNumToString(opts.start.x)} ${pdfNumToString(opts.start.y)} m`,
      ...(opts.lineCap !== undefined ? [`${pdfNumToString(opts.lineCap)} J`] : []),
      `${pdfNumToString(opts.start.x)} ${pdfNumToString(opts.start.y)} m`,
      `${pdfNumToString(opts.end.x)} ${pdfNumToString(opts.end.y)} l`,
      "S",
      "Q",
    ];
    this.pushOps(pageIndex, ops.join("\n"), opts.behind === true);
  }

  /* ─── P6-o: AcroForm builder (pdf-lib PDFForm parity) ────────────────────
   * Object graph probed live against pdf-lib (scripts/dev/probe-p6o-*):
   * field dicts (/FT /T /DA /Ff /V /Opt /Kids), widget annots (/Rect with
   * the bw/2 expansion, /MK /BG-white /R 0 /BC, /BS /W, /F 4, /P, /Parent,
   * /AS, /AP), appearance Form XObjects (rotateInPlace ×2 + drawTextField /
   * drawCheckBox / drawRadioButton op sequences), the DA font-size loop
   * (computeFontSize with heightAtSize-including-descender × 1.2), and the
   * catalog /AcroForm << /Fields [...] >>. Radio on-states are named by the
   * /Opt index ("/0", "/1" — the addWidgetWithOpt quirk). Appearance
   * streams carry the pdf-lib op sequences UNCOMPRESSED (the engine's
   * classic-xref honest scope — pdf-lib flates them; readers accept both).
   */

  createTextField(name: string): StampTextField {
    const entry = this.newFormField("text", name);
    const handle: StampTextField = {
      enableMultiline: () => {
        entry.multiline = true;
        return handle;
      },
      enableRequired: () => {
        entry.required = true;
        return handle;
      },
      setText: (text: string) => {
        entry.value = text;
        return handle;
      },
      addToSlot: (slot: number, rect: StampFieldRect) => {
        this.addFormWidget(entry, slot, rect);
      },
    };
    return handle;
  }

  createCheckBox(name: string): StampCheckBox {
    const entry = this.newFormField("checkbox", name);
    entry.dict.m.set(
      "DA",
      lstr(LATIN1("0 0 0 rg\n/dummy__noop 0 Tf")),
    );
    const handle: StampCheckBox = {
      check: () => {
        entry.dict.m.set("V", { k: "name", v: "Yes" });
        return handle;
      },
      enableRequired: () => {
        entry.required = true;
        // pdf-lib writes the flag immediately (acroField.setFlagTo).
        entry.dict.m.set("Ff", num(2));
        return handle;
      },
      addToSlot: (slot: number, rect: StampFieldRect) => {
        this.addFormWidget(entry, slot, rect);
      },
    };
    return handle;
  }

  createDropdown(name: string): StampDropdown {
    const entry = this.newFormField("dropdown", name);
    entry.dict.m.set("Ff", num(131072)); // combo box (pdf-lib createDropdown)
    const handle: StampDropdown = {
      addOptions: (...options: string[]) => {
        entry.options.push(...options);
        return handle;
      },
      select: (value: string) => {
        entry.selected = value;
        return handle;
      },
      enableRequired: () => {
        entry.required = true;
        return handle;
      },
      addToSlot: (slot: number, rect: StampFieldRect) => {
        this.addFormWidget(entry, slot, rect);
      },
    };
    return handle;
  }

  createRadioGroup(name: string): StampRadioGroup {
    const entry = this.newFormField("radio", name);
    entry.dict.m.set("Ff", num(32768)); // radio (pdf-lib createRadioGroup)
    const handle: StampRadioGroup = {
      enableRequired: () => {
        entry.required = true;
        // Radio Ff: 32768 | required 2.
        entry.dict.m.set("Ff", num(32768 | (entry.required ? 2 : 0)));
        return handle;
      },
      addOptionToSlot: (slot: number, option: string, rect: StampFieldRect) => {
        // addWidgetWithOpt: the /Opt export value is a UTF-16 hex string and
        // the on-state NAME is its INDEX (PDFName.of(String(optIdx))). The
        // dummy /DA appears with the first widget (pdf-lib sets it in the
        // appearance provider at addToPage time).
        if (entry.widgets.length === 0) {
          entry.dict.m.set("DA", lstr(LATIN1("0 0 0 rg\n/dummy__noop 0 Tf")));
        }
        entry.optValues.push(option);
        let opt = entry.dict.m.get("Opt");
        if (!opt || opt.k !== "arr") {
          opt = { k: "arr", items: [] };
          entry.dict.m.set("Opt", opt);
        }
        opt.items.push({ k: "hstr", b: pdfTextBytes(option) });
        this.addFormWidget(entry, slot, rect);
      },
    };
    return handle;
  }

  /** Reserve the field dict + AcroForm skeleton shared by every flavour. */
  private newFormField(
    kind: "text" | "checkbox" | "dropdown" | "radio",
    name: string,
  ): StampFormField {
    if (typeof name !== "string" || name.length === 0) {
      throw new PdfError("corrupt", "form field name must be a non-empty string");
    }
    if (this.acroFormNum === null) {
      this.acroFormNum = this.reserve();
      const fieldsArr: PdfObj = { k: "arr", items: [] };
      // P6-o-a: when the SOURCE document already carries an /AcroForm
      // (make-pdf-fillable run on its own output, Acrobat-authored forms),
      // pdf-lib's addField pushes into the EXISTING /Fields array — mirror
      // that by seeding ours with the source's items and cloning its other
      // entries. The dict is SOURCE-ANCHORED so the old field refs remap
      // through the writer's reachable-graph renumber (without the anchor
      // the entire existing form would be dropped from the output).
      const source = this.sourceAcroForm();
      const pairs: Array<[string, PdfObj]> = [];
      if (source) {
        const fieldsEntry = source.m.get("Fields");
        const fieldsVal =
          fieldsEntry && fieldsEntry.k === "ref"
            ? resolve(this.source.doc, fieldsEntry)
            : fieldsEntry;
        if (fieldsVal && fieldsVal.k === "arr") {
          for (const item of fieldsVal.items) fieldsArr.items.push(item);
        }
        for (const [key, value] of source.m) {
          if (key !== "Fields") pairs.push([key, value]);
        }
      }
      pairs.push(["Fields", fieldsArr]);
      this.acroFormDict = newDict(pairs);
      if (source) {
        this.synthetics.push({ sourceDoc: this.source.doc, obj: this.acroFormDict });
      } else {
        this.synthetics.push(this.acroFormDict);
      }
    }
    const fieldNum = this.reserve();
    const dict = newDict([
      ["FT", { k: "name", v: FORM_FT[kind] }],
      ["Kids", { k: "arr", items: [] }],
      ["T", { k: "hstr", b: pdfTextBytes(name) }],
    ]);
    this.synthetics.push(dict);
    const entry: StampFormField = {
      num: fieldNum,
      kind,
      dict,
      required: false,
      multiline: false,
      value: undefined,
      options: [],
      selected: undefined,
      optValues: [],
      widgets: [],
    };
    this.formFields.push(entry);
    const fields = this.acroFormDict!.m.get("Fields");
    if (fields && fields.k === "arr") fields.items.push(newref(fieldNum));
    return entry;
  }

  /** Build one widget annot + its appearance streams for a field. */
  private addFormWidget(
    entry: StampFormField,
    slot: number,
    rect: StampFieldRect,
  ): void {
    this.page(slot); // range check
    if (
      !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
      rect.width <= 0 || rect.height <= 0
    ) {
      throw new PdfError("corrupt", "form field box must be positive");
    }
    const borderWidth = rect.borderWidth ?? 1;
    const borderColor = rect.borderColor ?? { r: 0, g: 0, b: 0 };
    // Widget /Rect — the border expands it by bw/2 on every side.
    const x0 = rect.x - borderWidth / 2;
    const y0 = rect.y - borderWidth / 2;
    const width = rect.width + borderWidth;
    const height = rect.height + borderWidth;

    const isStateless = entry.kind === "text" || entry.kind === "dropdown";
    // P6-o ordering fix: the shared /Helvetica form font must be reserved
    // AND pushed BEFORE the AP streams — side effects inside the stream
    // dict literal would push it mid-order and shift every later number.
    const formFontNum = isStateless ? this.ensureFormFont() : null;
    const stateCount = isStateless ? 1 : 4; // N(+D) × on/off
    const apNums: number[] = [];
    const apStreams: Array<PdfObj & { k: "stream" }> = [];
    for (let i = 0; i < stateCount; i += 1) {
      const streamObjNum = this.reserve();
      apNums.push(streamObjNum);
      const stream: PdfObj & { k: "stream" } = {
        k: "stream",
        m: new Map<string, PdfObj>([
          ["BBox", arr(num(0), num(0), num(width), num(height))],
          ["Matrix", arr(num(1), num(0), num(0), num(1), num(0), num(0))],
          ["Type", { k: "name", v: "XObject" }],
          ["Subtype", { k: "name", v: "Form" }],
          ...(isStateless
            ? ([["Resources", newDict([["Font", newDict([["Helvetica", newref(formFontNum!)]])]])]] as Array<[string, PdfObj]>)
            : []),
        ]),
        raw: new Uint8Array(0),
      };
      this.synthetics.push(stream);
      apStreams.push(stream);
    }

    // The /AP shape: stateless → /N <ref>; button → /N + /D state dicts.
    let ap: PdfObj;
    if (isStateless) {
      ap = newDict([["N", newref(apNums[0]!)]]);
    } else {
      const onName =
        entry.kind === "radio" ? String(entry.optValues.length - 1) : "Yes";
      ap = newDict([
        [
          "N",
          newDict([
            [onName, newref(apNums[0]!)],
            ["Off", newref(apNums[1]!)],
          ]),
        ],
        [
          "D",
          newDict([
            [onName, newref(apNums[2]!)],
            ["Off", newref(apNums[3]!)],
          ]),
        ],
      ]);
    }

    const widgetNum = this.reserve();
    const widget = newDict([
      ["Type", { k: "name", v: "Annot" }],
      ["Subtype", { k: "name", v: "Widget" }],
      [
        "Rect",
        arr(num(x0), num(y0), num(x0 + width), num(y0 + height)),
      ],
      ["Parent", newref(entry.num)],
      ["P", newref(3 + slot)], // all-copy plan: slot s = object 3+s
      [
        "MK",
        newDict([
          ["BG", arr(num(1), num(1), num(1))],
          ["R", num(0)],
          ["BC", arr(num(borderColor.r), num(borderColor.g), num(borderColor.b))],
        ]),
      ],
      ["BS", newDict([["W", num(borderWidth)]])],
      ["F", num(4)],
      ...(isStateless ? [] : ([["AS", { k: "name", v: "Off" }]] as Array<[string, PdfObj]>)),
      ["AP", ap],
    ]);
    this.synthetics.push(widget);

    const kids = entry.dict.m.get("Kids");
    if (kids && kids.k === "arr") kids.items.push(newref(widgetNum));
    let list = this.slotAnnots.get(slot);
    if (!list) {
      list = [];
      this.slotAnnots.set(slot, list);
    }
    list.push(newref(widgetNum));

    entry.widgets.push({
      slot,
      borderWidth,
      borderColor,
      width,
      height,
      radio: entry.kind === "radio",
      apStreams,
    });

    // Button appearance streams are text-free — materialize them NOW.
    if (!isStateless) {
      this.fillButtonAppearances(entry.widgets[entry.widgets.length - 1]!);
    }
  }

  /**
   * The SOURCE catalog's /AcroForm dict (if any) — the builder-merge source
   * (P6-o-a). Accepts a plain dict or a stream's dict half; refs inside the
   * returned entries are resolved by the writer via the source anchor.
   */
  private sourceAcroForm(): (PdfObj & { k: "dict" }) | undefined {
    const rootObj = this.source.doc.trailer.get("Root");
    const root = rootObj ? resolve(this.source.doc, rootObj) : undefined;
    if (!root || (root.k !== "dict" && root.k !== "stream")) return undefined;
    const afObj = root.m.get("AcroForm");
    if (afObj === undefined) return undefined;
    const af = resolve(this.source.doc, afObj);
    if (!af || (af.k !== "dict" && af.k !== "stream")) return undefined;
    return { k: "dict", m: af.m };
  }

  /**
   * P6-o-b (edit-pdf): carry a SOURCE /AcroForm through a field-less run.
   * Pushes the source dict (clone-wrapped, never mutated) as a
   * SOURCE-ANCHORED synthetic — its /Fields refs remap through the writer's
   * copy map and the whole field graph rides the output's reachable set.
   * Cached so repeated write() calls reference ONE object. Returns the
   * output object number, or null when the source ships no /AcroForm
   * (formless docs stay byte-identical — no catalog entry, no synthetic).
   */
  private passthroughSourceAcroForm(): number | null {
    if (this.sourceAcroPassthroughNum !== undefined) {
      return this.sourceAcroPassthroughNum;
    }
    const source = this.sourceAcroForm();
    if (!source) {
      this.sourceAcroPassthroughNum = null;
      return null;
    }
    const num = this.reserve();
    this.synthetics.push({ sourceDoc: this.source.doc, obj: source });
    this.sourceAcroPassthroughNum = num;
    return num;
  }

  /** The shared /Helvetica resource for text-bearing appearance streams. */
  private ensureFormFont(): number {
    if (this.formFontNum === null) {
      this.formFontNum = this.reserve();
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "Font" }],
          ["Subtype", { k: "name", v: "Type1" }],
          ["BaseFont", { k: "name", v: "Helvetica" }],
          ["Encoding", { k: "name", v: "WinAnsiEncoding" }],
        ]),
      );
    }
    return this.formFontNum;
  }

  /** pdf-lib drawTextField on a widget — the exact probed op sequence. */
  private fillTextAppearance(
    stream: PdfObj & { k: "stream" },
    chrome: { borderWidth: number; borderColor: StampRgb; width: number; height: number },
    text: string,
    multiline: boolean,
  ): { fontSize: number } {
    const borderWidth = chrome.borderWidth;
    const borderColor = chrome.borderColor;
    const padding = 1;
    const bounds = {
      x: borderWidth + padding,
      y: borderWidth + padding,
      width: chrome.width - (borderWidth + padding) * 2,
      height: chrome.height - (borderWidth + padding) * 2,
    };
    const layout = multiline
      ? layoutMultilineHelv(text, bounds)
      : layoutSinglelineHelv(text, bounds);
    const ops: string[] = [
      "1 0 0 1 0 0 cm", // rotateInPlace(0): translate(0,0)
      "1 0 0 1 0 0 cm", // rotateInPlace(0): rotateDegrees(0)
      "q",
      "q",
      "1 1 1 rg",
      `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
      `${pdfNumToString(borderWidth)} w`,
      "[] 0 d",
      `1 0 0 1 ${pdfNumToString(borderWidth / 2)} ${pdfNumToString(borderWidth / 2)} cm`,
      "1 0 0 1 0 0 cm",
      "1 0 0 1 0 0 cm",
      "0 0 m",
      `0 ${pdfNumToString(chrome.height - borderWidth)} l`,
      `${pdfNumToString(chrome.width - borderWidth)} ${pdfNumToString(chrome.height - borderWidth)} l`,
      `${pdfNumToString(chrome.width - borderWidth)} 0 l`,
      "h",
      // pdf-lib drawRectangle paint: color && borderWidth → B, color → f.
      borderWidth > 0 ? "B" : "f",
      "Q",
    ];
    // Clip area — pdf-lib drawTextField: x + bw/2 + padding where x = bw/2
    // (the provider's passed origin), i.e. clip = borderWidth + padding; the
    // clip box is inset from the PASSED width (widget − bw).
    const clipX = borderWidth + padding;
    const clipY = borderWidth + padding;
    const clipW = (chrome.width - borderWidth) - (borderWidth / 2 + padding) * 2;
    const clipH = (chrome.height - borderWidth) - (borderWidth / 2 + padding) * 2;
    ops.push(
      `${pdfNumToString(clipX)} ${pdfNumToString(clipY)} m`,
      `${pdfNumToString(clipX)} ${pdfNumToString(clipY + clipH)} l`,
      `${pdfNumToString(clipX + clipW)} ${pdfNumToString(clipY + clipH)} l`,
      `${pdfNumToString(clipX + clipW)} ${pdfNumToString(clipY)} l`,
      "h",
      "W",
      "n",
      "/Tx BMC",
      "q",
      "BT",
      "0 0 0 rg",
      `/Helvetica ${layout.fontSize} Tf`,
    );
    for (const line of layout.lines) {
      ops.push(`1 0 0 1 ${pdfNumToString(line.x)} ${pdfNumToString(line.y)} Tm`);
      // pdf-lib showText hex is UPPERCASE (toHexStringOfMinLength).
      ops.push(`<${encodeWinAnsiHex(line.text, "helvetica").toUpperCase()}> Tj`);
    }
    ops.push("ET", "Q", "EMC", "Q");
    const raw = ENC.encode(ops.join("\n"));
    stream.raw = raw;
    stream.m.set("Length", num(raw.length));
    return { fontSize: layout.fontSize };
  }

  /** pdf-lib drawCheckBox / drawRadioButton appearance streams. */
  private fillButtonAppearances(widget: StampFormWidget): void {
    const { borderWidth, borderColor, width, height } = widget;
    // The provider passes x = bw/2, y = bw/2, w/h = rect − bw (the outline
    // box) and the ellipse CENTER at the box midpoint (width/2, height/2
    // of the WIDGET rect — inner.x + inner.width/2 == width/2).
    const inner = {
      width: width - borderWidth,
      height: height - borderWidth,
    };
    const isRadio = widget.radio === true;
    const outlineScale = Math.min(inner.width, inner.height) / 2;
    const cx = width / 2;
    const cy = height / 2;
    const streams = widget.apStreams;
    for (let i = 0; i < streams.length; i += 1) {
      const down = i >= 2; // [N-on, N-off, D-on, D-off]
      const on = i % 2 === 0;
      const ops: string[] = [
        "1 0 0 1 0 0 cm",
        "1 0 0 1 0 0 cm",
      ];
      const outline = isRadio
        ? ellipseOps(cx, cy, outlineScale, borderColor, borderWidth)
        : rectOps(borderWidth / 2, borderWidth / 2, inner.width, inner.height, borderColor, borderWidth);
      if (on) {
        ops.push("q", ...outline);
        if (isRadio) {
          ops.push(...dotOps(cx, cy, outlineScale * 0.45));
        } else {
          ops.push(...checkMarkOps(inner.width, inner.height));
        }
        ops.push("Q");
      } else {
        ops.push(...outline);
      }
      // Down state: same shapes, darkened background (×0.8).
      if (down) {
        const idx = ops.indexOf("1 1 1 rg");
        if (idx >= 0) ops[idx] = "0.8 0.8 0.8 rg";
      }
      const raw = ENC.encode(ops.join("\n"));
      streams[i]!.raw = raw;
      streams[i]!.m.set("Length", num(raw.length));
    }
  }

  /**
   * Write-time appearance materialization for TEXT-BEARING fields (the
   * final setText/select values — pdf-lib refreshes at save() the same
   * way) + the /Ff flags + /Opt /V on dropdowns.
   */
  private finalizeFormAppearances(): void {
    for (const entry of this.formFields) {
      if (entry.kind === "checkbox" || entry.kind === "radio") continue;
      // /Ff: dropdown combo 131072 | text multiline 4096 | required 2.
      let ff = entry.kind === "dropdown" ? 131072 : 0;
      if (entry.kind === "text" && entry.multiline) ff |= 4096;
      if (entry.required) ff |= 2;
      // pdf-lib's setText WRITES /Ff (even 0) on text fields — mirror it.
      if (ff !== 0 || entry.value !== undefined) {
        entry.dict.m.set("Ff", num(ff));
      } else {
        entry.dict.m.delete("Ff");
      }
      // Value + options.
      if (entry.kind === "text" && entry.value !== undefined) {
        entry.dict.m.set("V", { k: "hstr", b: pdfTextBytes(entry.value) });
      }
      if (entry.kind === "dropdown") {
        entry.dict.m.set(
          "Opt",
          {
            k: "arr",
            items: entry.options.map((o) => ({
              k: "arr" as const,
              items: [
                { k: "hstr" as const, b: pdfTextBytes(o) },
                { k: "hstr" as const, b: pdfTextBytes(o) },
              ],
            })),
          },
        );
        if (entry.selected !== undefined && entry.options.includes(entry.selected)) {
          entry.dict.m.set("V", { k: "hstr", b: pdfTextBytes(entry.selected) });
        }
      }
      const text =
        entry.kind === "dropdown" ? entry.selected ?? "" : entry.value ?? "";
      for (const widget of entry.widgets) {
        const { fontSize } = this.fillTextAppearance(
          widget.apStreams[0]!,
          widget,
          text,
          entry.kind === "text" && entry.multiline,
        );
        entry.dict.m.set(
          "DA",
          lstr(LATIN1(`0 0 0 rg\n/Helvetica ${fontSize} Tf`)),
        );
        break; // one DA per field (pdf-lib uses the first widget's layout)
      }
    }
  }

  /** Write the stamped document. Non-destructive: the page plan is rebuilt
   * from the accumulated layers, so callers may stamp more and write again.
   *
   * P6-o: iterates SLOTS (identity plan = one slot per source page);
   * appends appendAnnot()/form-widget refs to the slot's /Annots; attaches
   * the /AcroForm to the catalog when form fields were created.
   */
  write(onPage?: (fraction: number, page: number) => void): Uint8Array {
    this.finalizeLayers();
    this.finalizeTtfs();
    this.finalizeFormAppearances();
    const count = this.slotCount;
    const pages: WritePage[] = [];
    for (let slot = 0; slot < count; slot += 1) {
      const page = this.source.pages[this.slotSrc(slot)]!;
      const dict = cloneDict(page.dict, { drop: ["Parent"] });
      // P6-h: pages relying on tree inheritance must not lose their
      // boxes/rotation/resources just because we rebuilt the page tree.
      materializeInheritable(dict, page);
      // P6-o: slot set overrides (edit-pdf R13 /Rotate, R15 /CropBox) —
      // applied AFTER materialize, explicit entries win.
      const set = this.slots?.[slot]?.set;
      if (set !== undefined) {
        for (const [key, value] of set) dict.set(key, value);
      }
      const layer = this.layers[slot];
      if (layer !== undefined && layer.length >= 2) {
        // /Contents: our stream goes FIRST (behind) or LAST (front).
        const existing = existingContents(page.dict);
        const ours: PdfObj = newref(this.streamNums.get(slot)!);
        dict.set(
          "Contents",
          layer[0] === "behind"
            ? { k: "arr", items: [ours, ...existing] }
            : { k: "arr", items: [...existing, ours] },
        );
        // /Resources: resolve (inherited-or-own) → clone → merge our entries.
        dict.set("Resources", this.mergedResources(slot));
      }
      // P6-o: appended annots ride AFTER the source's own /Annots.
      const annots = this.slotAnnots.get(slot);
      if (annots !== undefined && annots.length > 0) {
        const existing = dict.get("Annots");
        const base =
          existing && existing.k === "arr"
            ? [...existing.items]
            : existing
              ? [existing]
              : [];
        dict.set("Annots", { k: "arr", items: [...base, ...annots] });
      }
      pages.push({
        type: "copy" as const,
        doc: this.source.doc,
        srcNum: page.ref.num,
        dict,
      });
    }
    // P6-o: the AcroForm catalog entry (only when fields were created —
    // passthrough docs stay byte-identical to the pre-P6-o engine).
    let catalogExtras: Array<[string, PdfObj]> | undefined;
    if (this.acroFormNum !== null) {
      catalogExtras = [["AcroForm", newref(this.acroFormNum)]];
    } else {
      // P6-o-b (edit-pdf): a SOURCE /AcroForm also rides when no fields
      // were created — pdf-lib's load+save parity (reordering or stamping
      // a form-bearing document must not silently strip its fields). The
      // merged path is newFormField's; this is the untouched passthrough.
      const passthroughNum = this.passthroughSourceAcroForm();
      if (passthroughNum !== null) {
        catalogExtras = [["AcroForm", newref(passthroughNum)]];
      }
    }
    return writeDocument(
      pages,
      this.source.doc.version,
      onPage,
      this.synthetics,
      undefined,
      catalogExtras,
    );
  }

  /* ─── internals ──────────────────────────────────────────────────────── */

  /** Source page index behind a SLOT (identity when no plan installed). */
  private slotSrc(slot: number): number {
    return this.slots ? this.slots[slot]!.src : slot;
  }

  private page(slot: number): PdfPageInfo {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotCount) {
      throw new PdfError("corrupt", `page index ${slot} out of range`);
    }
    return this.source.pages[this.slotSrc(slot)]!;
  }

  private reserve(): number {
    return this.nextNum++;
  }

  private registerImage(width: number, height: number, objNum: number): StampImage {
    const handle: StampImage = { width, height };
    this.images.set(handle, { num: objNum, token: `img${objNum}`, width, height });
    return handle;
  }

  private ensureFont(font: StampFontKey): FontEntry {
    let entry = this.fonts.get(font);
    if (!entry) {
      const objNum = this.reserve();
      const base = BASE_FONT_NAME[font];
      if (!base) throw new PdfError("corrupt", `unknown standard font ${font}`);
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "Font" }],
          ["Subtype", { k: "name", v: "Type1" }],
          ["BaseFont", { k: "name", v: base }],
          ["Encoding", { k: "name", v: "WinAnsiEncoding" }],
        ]),
      );
      entry = { num: objNum, token: `font:${font}` };
      this.fonts.set(font, entry);
    }
    return entry;
  }

  private ensureGs(opacity: number): GsEntry {
    const value = Math.min(1, Math.max(0, opacity));
    const rounded = value.toFixed(4);
    let entry = this.gsStates.get(rounded);
    if (!entry) {
      const objNum = this.reserve();
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "ExtGState" }],
          ["ca", num(value)],
        ]),
      );
      entry = { num: objNum, token: `gs:${rounded}` };
      this.gsStates.set(rounded, entry);
    }
    return entry;
  }

  /**
   * P6-o: the merged {ca?, CA?} ExtGState — pdf-lib's
   * maybeEmbedGraphicsState({opacity, borderOpacity}) for the shape ops:
   * ONE dict with only the defined keys, deduplicated per flavor.
   */
  private ensureGsPair(ca?: number, caOpacity?: number): GsEntry {
    const key =
      `${ca !== undefined ? Math.min(1, Math.max(0, ca)).toFixed(4) : "-"}` +
      `:${caOpacity !== undefined ? Math.min(1, Math.max(0, caOpacity)).toFixed(4) : "-"}`;
    let entry = this.gsPairStates.get(key);
    if (!entry) {
      const objNum = this.reserve();
      const m = new Map<string, PdfObj>([["Type", { k: "name", v: "ExtGState" }]]);
      if (ca !== undefined) m.set("ca", num(Math.min(1, Math.max(0, ca))));
      if (caOpacity !== undefined) m.set("CA", num(Math.min(1, Math.max(0, caOpacity))));
      this.synthetics.push({ k: "dict", m });
      entry = { num: objNum, token: `gsp:${key}` };
      this.gsPairStates.set(key, entry);
    }
    return entry;
  }

  /**
   * The ca+CA ExtGState (P6-j): pdf-lib's drawPage(opacity) injects `ca`
   * only, and the overlay worker patches `CA` onto it so stroke content
   * dims too — this is that patched state, emitted once (deduplicated
   * across pages, like every stamp resource).
   */
  private ensureGsBoth(opacity: number): GsEntry {
    const value = Math.min(1, Math.max(0, opacity));
    const rounded = value.toFixed(4);
    let entry = this.gsBothStates.get(rounded);
    if (!entry) {
      const objNum = this.reserve();
      this.synthetics.push(
        newDict([
          ["Type", { k: "name", v: "ExtGState" }],
          ["ca", num(value)],
          ["CA", num(value)],
        ]),
      );
      entry = { num: objNum, token: `gsb:${rounded}` };
      this.gsBothStates.set(rounded, entry);
    }
    return entry;
  }

  /**
   * Local resource name for a global token on one page: picks the first free
   * `/F<n>`-style name that does not collide with the page's existing entries
   * in that category, then remembers it (stable across writes).
   */
  private resourceKey(
    pageIndex: number,
    category: "Font" | "XObject" | "ExtGState",
    token: string,
    prefix: string,
  ): string {
    const cacheKey = `${pageIndex}:${category}:${token}`;
    const cached = this.localKeys.get(cacheKey);
    if (cached) return cached;
    const bucketMap = asDict(asDict(this.effectiveResources(pageIndex))?.get(category));
    const taken = new Set<string>(bucketMap ? bucketMap.keys() : []);
    // P6-o FIX: names allocated in THIS run for other tokens on the same
    // page are taken too — two different ExtGState flavors must never share
    // /GS1 (the shape-stamping parity smoke caught the overwrite).
    const pagePrefix = `${pageIndex}:`;
    for (const [ck, name] of this.localKeys) {
      if (ck.startsWith(pagePrefix)) taken.add(name);
    }
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n += 1;
    const key = `${prefix}${n}`;
    this.localKeys.set(cacheKey, key);
    return key;
  }

  /** The page's effective Resources dict map — resolving refs + inheritance. */
  private effectiveResources(slot: number): PdfObj | undefined {
    const entry = this.source.pages[this.slotSrc(slot)]!.resources;
    if (entry === undefined) return undefined;
    const resolved = resolve(this.source.doc, entry);
    if (!resolved) return undefined;
    if (resolved.k === "dict") return resolved;
    if (resolved.k === "stream") return { k: "dict", m: resolved.m };
    return undefined;
  }

  /** Merged (cloned + our entries) Resources dict object for a stamped page. */
  private mergedResources(pageIndex: number): PdfObj {
    const base = asDict(this.effectiveResources(pageIndex));
    const merged = base ? new Map<string, PdfObj>(base) : new Map<string, PdfObj>();
    const prefix = `${pageIndex}:`;
    for (const category of ["Font", "XObject", "ExtGState"] as const) {
      const allocs: Array<[string, number]> = [];
      for (const [cacheKey, localName] of this.localKeys) {
        if (!cacheKey.startsWith(`${prefix}${category}:`)) continue;
        const token = cacheKey.slice(`${prefix}${category}:`.length);
        const num = this.numForToken(category, token);
        if (num !== undefined) allocs.push([localName, num]);
      }
      if (allocs.length === 0) continue;
      const bucketBase = asDict(merged.get(category));
      const bucket = bucketBase
        ? new Map<string, PdfObj>(bucketBase)
        : new Map<string, PdfObj>();
      for (const [localName, num] of allocs) bucket.set(localName, newref(num));
      merged.set(category, { k: "dict", m: bucket });
    }
    return { k: "dict", m: merged };
  }

  private numForToken(category: string, token: string): number | undefined {
    if (category === "Font") {
      if (token.startsWith("ttf:")) return this.ttf?.type0Num;
      const fontKey = token.slice("font:".length) as StampFontKey;
      return this.fonts.get(fontKey)?.num;
    }
    if (category === "ExtGState") {
      if (token.startsWith("gsb:")) {
        return this.gsBothStates.get(token.slice("gsb:".length))?.num;
      }
      return this.gsStates.get(token.slice("gs:".length))?.num;
    }
    if (token.startsWith("form:")) {
      for (const entry of this.forms.values()) {
        if (entry.token === token) return entry.num;
      }
      return undefined;
    }
    for (const entry of this.images.values()) {
      if (entry.token === token) return entry.num;
    }
    return undefined;
  }

  private pushOps(pageIndex: number, ops: string, behind: boolean): void {
    let layer = this.layers[pageIndex];
    if (!layer) {
      layer = ["front"];
      this.layers[pageIndex] = layer;
    }
    if (behind) layer[0] = "behind";
    layer.push(ops);
  }

  /** Reserve (once) the stamp content stream object number for page i. */
  private streamNumFor(pageIndex: number): number {
    let n = this.streamNums.get(pageIndex);
    if (n === undefined) {
      n = this.reserve();
      this.streamNums.set(pageIndex, n);
      this.streamIndex.set(pageIndex, this.synthetics.length);
      this.synthetics.push({
        k: "stream",
        m: new Map<string, PdfObj>([["Length", { k: "num", n: 0 }]]),
        raw: new Uint8Array(0),
      });
    }
    return n;
  }

  /**
   * Materialize the embedded TTF's late-bound objects: the subset font
   * bytes (FontFile2, FlateDecode), the ToUnicode CMap, and the W array —
   * with ALL encoded glyphs, exactly as pdf-lib's save-time embedding sees
   * them. Idempotent (write may run multiple times).
   */
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

    /* ToUnicode — pdf-lib createCmap: one bfchar per encoded subset glyph,
     * the shared-glyph (first-ask) codePoints; multiple-sub products carry
     * empty codePoints → "<>" line, byte-parity with the oracle. */
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
    const cmapBytes = LATIN1_ENCODE(cmapText);
    const cmapFlated = flateImageBytes(cmapBytes);
    entry.cmapStream.raw = cmapFlated;
    entry.cmapStream.m.set("Length", num(cmapFlated.length));
  }

  /**
   * Materialize every page's layer bytes into its reserved stream object.
   * Runs at write() time so /Length and the bytes are exact.
   */
  private finalizeLayers(): void {
    for (let i = 0; i < this.slotCount; i++) {
      const layer = this.layers[i];
      if (!layer || layer.length < 2) continue;
      this.streamNumFor(i); // ensure reserved (idempotent)
      const index = this.streamIndex.get(i)!;
      const body = layer.slice(1).join("\n");
      const raw = ENC.encode(body);
      this.synthetics[index] = {
        k: "stream",
        m: new Map<string, PdfObj>([["Length", { k: "num", n: raw.length }]]),
        raw,
      };
    }
  }
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

/** pdf-lib's KAPPA (drawEllipsePath / drawCheckMark arcs). */
const KAPPA = (4.0 * (Math.sqrt(2.0) - 1.0)) / 3.0;

/** Field-type /FT names. */
const FORM_FT = {
  text: "Tx",
  checkbox: "Btn",
  dropdown: "Ch",
  radio: "Btn",
} as const;

/** PDFHexString.fromText — UTF-16BE with the FEFF BOM. */
function pdfTextBytes(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c >> 8;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}

/* ─── pdf-lib text layout (api/text/layout.js, byte-exact) ───────────── */

/** Helvetica metrics pdf-lib reads via fontkit (probed):
 * ascent 718, descent −207 → heightAtSize WITH descender = 0.925×size,
 * without = 0.718×size. */
const HELV_ASCENT = 718;
const HELV_DESCENT = 207;

function helvWidth(text: string, size: number): number {
  return measureStdText(text, "helvetica", size);
}

/** pdf-lib cleanText: tab/NEL/LS/PS → four spaces; backspace/vtab dropped. */
function cleanTextPdf(text: string): string {
  return text.replace(/\t|\u0085|\u2028|\u2029/g, "    ").replace(/[\b\v]/g, "");
}

/** pdf-lib mergeLines: line-break chars → single space. */
function mergeLinesPdf(text: string): string {
  return text.replace(/[\n\f\r\u000B]/g, " ");
}

function lineSplitPdf(text: string): string[] {
  return text.split(/[\n\f\r\u000B]/);
}

/** pdf-lib computeFontSize — the DA font-size loop, Helvetica, no
 * caller-provided size (our tools never pass one). */
function computeFontSizeHelv(
  lines: string[],
  bounds: { width: number; height: number },
  multiline: boolean,
): number {
  let fontSize = 4;
  while (fontSize < 500) {
    let linesUsed = 0;
    for (const line of lines) {
      linesUsed += 1;
      const words = line.split(" ");
      let spaceInLineRemaining = bounds.width;
      for (let idx = 0; idx < words.length; idx += 1) {
        const isLastWord = idx === words.length - 1;
        const word = isLastWord ? words[idx]! : `${words[idx]} `;
        const widthOfWord = helvWidth(word, fontSize);
        spaceInLineRemaining -= widthOfWord;
        if (spaceInLineRemaining <= 0) {
          linesUsed += 1;
          spaceInLineRemaining = bounds.width - widthOfWord;
        }
      }
    }
    if (!multiline && linesUsed > lines.length) return fontSize - 1;
    const height = (fontSize * (HELV_ASCENT + HELV_DESCENT)) / 1000;
    const lineHeight = height + height * 0.2;
    const totalHeight = lineHeight * linesUsed;
    if (totalHeight > Math.abs(bounds.height)) return fontSize - 1;
    fontSize += 1;
  }
  return fontSize;
}

/** pdf-lib lastIndexOfWhitespace (index AFTER the break, undefined→0). */
function lastIndexOfWhitespace(line: string): number | undefined {
  for (let idx = line.length; idx > 0; idx -= 1) {
    if (/\s/.test(line[idx] ?? "")) return idx;
  }
  return undefined;
}

/** pdf-lib splitOutLines — fit one line by backing off to the last
 * whitespace boundary. */
function splitOutLines(
  input: string,
  maxWidth: number,
  fontSize: number,
): { line: string; width: number; remainder: string | undefined } {
  let lastWhitespaceIdx = input.length;
  while (lastWhitespaceIdx > 0) {
    const line = input.substring(0, lastWhitespaceIdx);
    const width = helvWidth(line, fontSize);
    if (width < maxWidth) {
      const remainder = input.substring(lastWhitespaceIdx) || undefined;
      return { line, width, remainder };
    }
    lastWhitespaceIdx = lastIndexOfWhitespace(line) ?? 0;
  }
  return {
    line: input,
    width: helvWidth(input, fontSize),
    remainder: undefined,
  };
}

function layoutSinglelineHelv(
  text: string,
  bounds: { x: number; y: number; width: number; height: number },
): { fontSize: number; lines: Array<{ text: string; x: number; y: number }> } {
  const line = mergeLinesPdf(cleanTextPdf(text));
  const fontSize = computeFontSizeHelv([line], bounds, false);
  const height = (fontSize * HELV_ASCENT) / 1000;
  const y = bounds.y + (bounds.height / 2 - height / 2);
  return { fontSize, lines: [{ text: line, x: bounds.x, y }] };
}

function layoutMultilineHelv(
  text: string,
  bounds: { x: number; y: number; width: number; height: number },
): { fontSize: number; lines: Array<{ text: string; x: number; y: number }> } {
  const rawLines = lineSplitPdf(cleanTextPdf(text));
  const fontSize = computeFontSizeHelv(rawLines, bounds, true);
  const height = (fontSize * (HELV_ASCENT + HELV_DESCENT)) / 1000;
  const lineHeight = height + height * 0.2;
  const lines: Array<{ text: string; x: number; y: number }> = [];
  let y = bounds.y + bounds.height;
  for (const raw of rawLines) {
    let prevRemainder: string | undefined = raw;
    while (prevRemainder !== undefined) {
      const { line, width, remainder } = splitOutLines(prevRemainder, bounds.width, fontSize);
      y -= lineHeight;
      lines.push({ text: line, x: bounds.x, y });
      prevRemainder = remainder?.trim();
    }
  }
  return { fontSize, lines };
}

/* ─── button appearance fragments (pdf-lib operations.js shapes) ─────── */

/** drawRectangle inside an appearance stream (bg white, border chrome). */
function rectOps(
  x: number,
  y: number,
  width: number,
  height: number,
  borderColor: StampRgb,
  borderWidth: number,
): string[] {
  return [
    "q",
    "1 1 1 rg",
    `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
    `${pdfNumToString(borderWidth)} w`,
    "[] 0 d",
    `1 0 0 1 ${pdfNumToString(x)} ${pdfNumToString(y)} cm`,
    "1 0 0 1 0 0 cm",
    "1 0 0 1 0 0 cm",
    "0 0 m",
    `0 ${pdfNumToString(height)} l`,
    `${pdfNumToString(width)} ${pdfNumToString(height)} l`,
    `${pdfNumToString(width)} 0 l`,
    "h",
    "B",
    "Q",
  ];
}

/** drawEllipse inside an appearance stream (radio outline). */
function ellipseOps(
  cx: number,
  cy: number,
  scale: number,
  borderColor: StampRgb,
  borderWidth: number,
): string[] {
  // drawEllipse x/y = CENTER; drawEllipsePath subtracts the radii.
  const x = cx - scale;
  const y = cy - scale;
  const ox = scale * KAPPA;
  const oy = scale * KAPPA;
  const xe = x + scale * 2;
  const ye = y + scale * 2;
  const xm = x + scale;
  const ym = y + scale;
  return [
    "q",
    "1 1 1 rg",
    `${pdfNumToString(borderColor.r)} ${pdfNumToString(borderColor.g)} ${pdfNumToString(borderColor.b)} RG`,
    `${pdfNumToString(borderWidth)} w`,
    "[] 0 d",
    "q",
    `${pdfNumToString(x)} ${pdfNumToString(ym)} m`,
    `${pdfNumToString(x)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xm - ox)} ${pdfNumToString(y)} ${pdfNumToString(xm)} ${pdfNumToString(y)} c`,
    `${pdfNumToString(xm + ox)} ${pdfNumToString(y)} ${pdfNumToString(xe)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xe)} ${pdfNumToString(ym)} c`,
    `${pdfNumToString(xe)} ${pdfNumToString(ym + oy)} ${pdfNumToString(xm + ox)} ${pdfNumToString(ye)} ${pdfNumToString(xm)} ${pdfNumToString(ye)} c`,
    `${pdfNumToString(xm - ox)} ${pdfNumToString(ye)} ${pdfNumToString(x)} ${pdfNumToString(ym + oy)} ${pdfNumToString(x)} ${pdfNumToString(ym)} c`,
    "Q",
    "B",
    "Q",
  ];
}

/** The radio dot (0.45× outline scale, black fill). */
function dotOps(cx: number, cy: number, scale: number): string[] {
  const x = cx - scale;
  const y = cy - scale;
  const ox = scale * KAPPA;
  const oy = scale * KAPPA;
  const xe = x + scale * 2;
  const ye = y + scale * 2;
  const xm = x + scale;
  const ym = y + scale;
  return [
    "q",
    "0 0 0 rg",
    "0 w",
    "[] 0 d",
    "q",
    `${pdfNumToString(x)} ${pdfNumToString(ym)} m`,
    `${pdfNumToString(x)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xm - ox)} ${pdfNumToString(y)} ${pdfNumToString(xm)} ${pdfNumToString(y)} c`,
    `${pdfNumToString(xm + ox)} ${pdfNumToString(y)} ${pdfNumToString(xe)} ${pdfNumToString(ym - oy)} ${pdfNumToString(xe)} ${pdfNumToString(ym)} c`,
    `${pdfNumToString(xe)} ${pdfNumToString(ym + oy)} ${pdfNumToString(xm + ox)} ${pdfNumToString(ye)} ${pdfNumToString(xm)} ${pdfNumToString(ye)} c`,
    `${pdfNumToString(xm - ox)} ${pdfNumToString(ye)} ${pdfNumToString(x)} ${pdfNumToString(ym + oy)} ${pdfNumToString(x)} ${pdfNumToString(ym)} c`,
    "Q",
    "f",
    "Q",
  ];
}

/** drawCheckMark — the three-point check with the right-angle constraint
 * (the Joel Walker unit-space formula, exactly as pdf-lib). */
function checkMarkOps(width: number, height: number): string[] {
  const size = Math.min(width, height) / 2;
  const p2x = -1 + 0.75;
  const p2y = -1 + 0.51;
  const p3y = 1 - 0.525;
  const p3x = 1 - 0.31;
  const p1x = -1 + 0.325;
  const p1y = -((p1x - p2x) * (p3x - p2x)) / (p3y - p2y) + p2y;
  return [
    "q",
    "0 0 0 RG",
    "1.5 w",
    `1 0 0 1 ${pdfNumToString(width / 2)} ${pdfNumToString(height / 2)} cm`,
    `${pdfNumToString(p1x * size)} ${pdfNumToString(p1y * size)} m`,
    `${pdfNumToString(p2x * size)} ${pdfNumToString(p2y * size)} l`,
    `${pdfNumToString(p3x * size)} ${pdfNumToString(p3y * size)} l`,
    "S",
    "Q",
  ];
}

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

/** /Contents value → array of its stream entries (missing → []). */
function existingContents(dict: Map<string, PdfObj>): PdfObj[] {
  const contents = dict.get("Contents");
  if (!contents) return [];
  if (contents.k === "arr") return contents.items;
  return [contents];
}

/** PDF text string decode: UTF-16BE with BOM, else PDFDocEncoding≈latin1. */
function decodePdfText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < b.length; i += 2) {
      out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    }
    return out;
  }
  return latin1(b, 0, b.length);
}
