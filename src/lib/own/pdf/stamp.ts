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
 */

import { parseForOrganize, type OrganizeSource } from "./ops";
import { latin1 } from "./lexer";
import {
  type PdfObj,
  asDict,
  cloneDict,
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
import { writeDocument, type WritePage } from "./writer";

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
  /** @internal — shaped subset-id hex; records glyphs for embedding. */
  encodeHex(text: string): string;
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
  private readonly synthetics: PdfObj[] = [];
  private nextNum: number;
  private readonly fonts = new Map<StampFontKey, FontEntry>();
  private readonly images = new Map<StampImage, ImageEntry>();
  private readonly gsStates = new Map<string, GsEntry>();
  /** ops fragments per page; [0] is the "front"/"behind" marker. */
  private readonly layers: (string[] | undefined)[] = [];
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
   * Write the stamped document. Non-destructive: the page plan is rebuilt
   * from the accumulated layers, so callers may stamp more and write again.
   */
  write(onPage?: (fraction: number, page: number) => void): Uint8Array {
    this.finalizeLayers();
    this.finalizeTtfs();
    const pages: WritePage[] = this.source.pages.map((page, i) => {
      const layer = this.layers[i];
      if (layer === undefined || layer.length < 2) {
        const dict = cloneDict(page.dict, { drop: ["Parent"] });
        // P6-h: pages relying on tree inheritance must not lose their
        // boxes/rotation/resources just because we rebuilt the page tree.
        materializeInheritable(dict, page);
        return {
          type: "copy" as const,
          doc: this.source.doc,
          srcNum: page.ref.num,
          dict,
        };
      }
      const dict = cloneDict(page.dict, { drop: ["Parent"] });
      materializeInheritable(dict, page);
      // /Contents: our stream goes FIRST (behind) or LAST (front).
      const existing = existingContents(page.dict);
      const ours: PdfObj = newref(this.streamNums.get(i)!);
      dict.set(
        "Contents",
        layer[0] === "behind"
          ? { k: "arr", items: [ours, ...existing] }
          : { k: "arr", items: [...existing, ours] },
      );
      // /Resources: resolve (inherited-or-own) → clone → merge our entries.
      dict.set("Resources", this.mergedResources(i));
      return {
        type: "copy" as const,
        doc: this.source.doc,
        srcNum: page.ref.num,
        dict,
      };
    });
    return writeDocument(pages, this.source.doc.version, onPage, this.synthetics);
  }

  /* ─── internals ──────────────────────────────────────────────────────── */

  private page(pageIndex: number): PdfPageInfo {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new PdfError("corrupt", `page index ${pageIndex} out of range`);
    }
    return this.source.pages[pageIndex]!;
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
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n += 1;
    const key = `${prefix}${n}`;
    this.localKeys.set(cacheKey, key);
    return key;
  }

  /** The page's effective Resources dict map — resolving refs + inheritance. */
  private effectiveResources(pageIndex: number): PdfObj | undefined {
    const entry = this.source.pages[pageIndex]!.resources;
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
      return this.gsStates.get(token.slice("gs:".length))?.num;
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
    for (let i = 0; i < this.pageCount; i++) {
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

const BASE_FONT_NAME: Record<StampFontKey, string> = {
  helvetica: "Helvetica",
  helveticaBold: "Helvetica-Bold",
  times: "Times-Roman",
  timesBold: "Times-Bold",
  courier: "Courier",
  courierBold: "Courier-Bold",
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
