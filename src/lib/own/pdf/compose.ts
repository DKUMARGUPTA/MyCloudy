/**
 * DocoPDF own PDF micro-engine — page composer (P6-h, the N-up route).
 *
 * Embeds source pages as Form XObjects (pdf-lib `embedPage` parity: BBox =
 * the page's crop box, Matrix translating the box origin to (0,0), decoded
 * content streams joined with newlines and wrapped in q/Q, Resources
 * resolved own-or-inherited) and authors brand-new sheet pages that draw
 * those forms through `q · translate · rotate · scale · /PgN Do · Q`
 * sequences (pdf-lib `drawPage` operator parity).
 *
 * The forms are SOURCE-ANCHORED synthetics in the writer: their /Resources
 * refs remap through the source document's copy map and the referenced
 * graphs (fonts, nested XObjects…) are BFS-copied exactly once per source
 * object — a font shared by two embedded pages is still written once.
 */

import { type PdfPageInfo } from "./document";
import { flateImageBytes } from "./images";
import {
  arr,
  newDict,
  newref,
  num,
  type PdfObj,
} from "./objects";
import {
  decodeForParser,
  PdfError,
  resolve,
  type ParsedPdf,
} from "./parser";
import { parseForOrganize, type OrganizeSource } from "./ops";
import { writeDocument, type WritePage, type WriteSynthetic } from "./writer";

/** Handle for one embedded source page (pass the `key` into sheet ops). */
export interface ComposedForm {
  /** The page's UNROTATED crop dims (pdf-lib embedPage width/height). */
  width: number;
  height: number;
  /** Resource name for `/… Do` operators on sheets that draw this form. */
  key: string;
}

/** One embeddable page form's material (pdf-lib PDFPageEmbedder parity). */
export interface PageFormEmbed {
  /** Flate-wrapped content bytes (the q/Q-wrapped decoded streams). */
  content: Uint8Array;
  /** The /BBox array entries. */
  bbox: [number, number, number, number];
  /** The /Matrix entries (origin-adjusted translate). */
  matrix: [number, number, number, number, number, number];
  /** Own-or-inherited Resources value (ref or dict); undefined → empty. */
  resources: PdfObj | undefined;
}

/**
 * The pdf-lib `PDFPageEmbedder` pipeline for ONE page's content + box, shared
 * by ComposeContext.embedPage (explicit crop rect) and StampContext.embedForm
 * (the DEFAULT MediaBox-normalized embed — pdf-lib's `fullPageBoundingBox`
 * discards the media origin, so `box` is {0, 0, W, H} there).
 *
 * Content bytes are pdf-lib byte-exact: `PDFPageLeaf.normalize` wraps the
 * (copied) page's content streams with push/pop graphics-state streams, then
 * `decodeContents` merges them with a newline after EVERY entry — so the
 * body is `q\n` `\n` …streams… `\n` `Q\n` `\n`.
 */
export function pageFormEmbed(
  doc: ParsedPdf,
  page: PdfPageInfo,
  box: { left: number; bottom: number; right: number; top: number },
): PageFormEmbed {
  const contents = page.dict.get("Contents");
  if (contents === undefined) {
    throw new PdfError("corrupt", "embedPage: page has no /Contents");
  }
  const resolvedContents = resolve(doc, contents);
  const streams: Array<PdfObj & { k: "stream" }> = [];
  if (resolvedContents?.k === "stream") {
    streams.push(resolvedContents);
  } else if (resolvedContents?.k === "arr") {
    for (const item of resolvedContents.items) {
      const stream = resolve(doc, item);
      if (stream?.k === "stream") streams.push(stream);
    }
  }
  if (streams.length === 0) {
    throw new PdfError("corrupt", "embedPage: no decodable content streams");
  }
  // The wrap streams carry their own trailing newline, and every entry gets
  // a join newline after it — exactly how pdf-lib's merge produces the body.
  const decoded: Uint8Array[] = [ENC.encode("q\n"), ENC.encode("\n")];
  for (const stream of streams) {
    decoded.push(decodeForParser(stream.raw, stream.m));
    decoded.push(ENC.encode("\n"));
  }
  decoded.push(ENC.encode("Q\n"), ENC.encode("\n"));
  return {
    content: flateImageBytes(mergeBytes(decoded)),
    bbox: [box.left, box.bottom, box.right, box.top],
    matrix: [1, 0, 0, 1, -box.left, -box.bottom],
    resources: page.resources,
  };
}

interface FormEntry {
  pageIndex: number;
  /** Flate-wrapped content bytes (built at embed time, stable). */
  content: Uint8Array;
  /** Form dict entries that depend on the page's view box. */
  bbox: [number, number, number, number];
  /** Own-or-inherited Resources value (ref or dict); undefined → empty. */
  resources: PdfObj | undefined;
  /** First-embed order (stable resource name + write numbering). */
  order: number;
  /** Assigned at write() once the sheet count fixes the numbering. */
  number: number;
}

interface SheetEntry {
  width: number;
  height: number;
  ops: Uint8Array;
  /** Page indices of the forms this sheet draws (drives its /Resources). */
  formPages: readonly number[];
}

const ENC = new TextEncoder();

export class ComposeContext {
  readonly pageCount: number;
  /** Read-only source page facts (boxes/rotation) for placement math. */
  readonly pages: readonly PdfPageInfo[];

  private readonly source: OrganizeSource;
  private readonly sheets: SheetEntry[] = [];
  /** pageIndex → form, in first-embed order (stable numbering). */
  private readonly forms = new Map<number, FormEntry>();

  private constructor(source: OrganizeSource) {
    this.source = source;
    this.pageCount = source.pages.length;
    this.pages = source.pages;
  }

  /** Parse a document for composing. Throws typed "encrypted"/"corrupt". */
  static load(bytes: Uint8Array): ComposeContext {
    return new ComposeContext(parseForOrganize(bytes));
  }

  /** The parsed source document (raw access for callers that need it). */
  get doc(): ParsedPdf {
    return this.source.doc;
  }

  private page(pageIndex: number): PdfPageInfo {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new PdfError("corrupt", `page index ${pageIndex} out of range`);
    }
    return this.pages[pageIndex]!;
  }

  /**
   * True when the page has a usable /Contents entry (a legal PDF page may
   * have none — such pages embed as empty cells instead of failing the run,
   * mirroring the pdf-lib worker's up-front hasContents probe).
   */
  hasContents(pageIndex: number): boolean {
    const contents = this.page(pageIndex).dict.get("Contents");
    if (contents === undefined) return false;
    const resolved = resolve(this.source.doc, contents);
    if (resolved === undefined || resolved.k === "null") return false;
    if (resolved.k === "stream") return true;
    if (resolved.k === "arr") {
      return resolved.items.some(
        (item) => resolve(this.source.doc, item)?.k === "stream",
      );
    }
    return false;
  }

  /**
   * Embed a source page as a Form XObject bounded by its crop box, decoded
   * + joined + re-flated (the exact pdf-lib PDFPageEmbedder pipeline: its
   * decodeContents walks the /Contents array — or single stream — decoding
   * each, joins with a newline, and saves through flateStream). Cached per
   * page: every sheet that draws the page reuses the SAME form object.
   */
  embedPage(pageIndex: number): ComposedForm {
    const page = this.page(pageIndex);
    const cached = this.forms.get(pageIndex);
    if (cached !== undefined) {
      return this.formHandle(cached);
    }
    const [x0, y0, x1, y1] = page.cropBox;
    const embed = pageFormEmbed(this.source.doc, page, {
      left: x0,
      bottom: y0,
      right: x1,
      top: y1,
    });
    const entry: FormEntry = {
      pageIndex,
      content: embed.content,
      bbox: embed.bbox,
      resources: embed.resources,
      order: this.forms.size,
      number: -1,
    };
    this.forms.set(pageIndex, entry);
    return this.formHandle(entry);
  }

  /**
   * Author one output sheet. `ops` is the raw content-stream text (the
   * caller composes `q … /PgN Do … Q` sequences with its own geometry);
   * `formPages` lists the source page indices whose forms the sheet draws
   * (those become the sheet's /Resources /XObject entries).
   */
  addSheet(
    width: number,
    height: number,
    ops: string,
    formPages: readonly number[],
  ): number {
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 ||
      width > 14_400 || height > 14_400
    ) {
      throw new PdfError("corrupt", "sheet size out of range");
    }
    for (const pageIndex of formPages) {
      if (!this.forms.has(pageIndex)) {
        throw new PdfError("corrupt", `addSheet: page ${pageIndex} not embedded`);
      }
    }
    this.sheets.push({
      width,
      height,
      ops: ENC.encode(ops),
      formPages,
    });
    return this.sheets.length;
  }

  /** Build the composed document (sheets + form XObjects + copied graphs). */
  write(
    onProgress?: (fraction: number, page: number) => void,
  ): Uint8Array {
    if (this.sheets.length === 0) {
      throw new PdfError("corrupt", "compose: no sheets added");
    }
    // Deterministic numbering mirrors the writer contract: 1 catalog, 2 pages
    // tree, then two objects per authored sheet, then one per form.
    let nextNumber = 3 + 2 * this.sheets.length;
    const formList: FormEntry[] = [];
    for (const entry of this.forms.values()) {
      entry.number = nextNumber++;
      formList.push(entry);
    }

    const pages: WritePage[] = this.sheets.map((sheet) => {
      const xobjects = new Map<string, PdfObj>();
      for (const pageIndex of sheet.formPages) {
        const entry = this.forms.get(pageIndex);
        if (entry !== undefined) {
          xobjects.set(this.keyOf(entry.order), newref(entry.number));
        }
      }
      const resources: PdfObj = xobjects.size > 0
        ? newDict([["XObject", { k: "dict", m: xobjects }]])
        : { k: "dict", m: new Map() };
      return {
        type: "new" as const,
        width: sheet.width,
        height: sheet.height,
        content: sheet.ops,
        resources,
      };
    });

    const synthetics: WriteSynthetic[] = formList.map((entry) => ({
      sourceDoc: this.source.doc,
      obj: this.formObject(entry),
    }));

    return writeDocument(pages, this.source.doc.version, onProgress, synthetics);
  }

  /* ─── internals ──────────────────────────────────────────────────── */

  private keyOf(embedOrder: number): string {
    return `Pg${embedOrder + 1}`;
  }

  private formHandle(entry: FormEntry): ComposedForm {
    return {
      width: entry.bbox[2] - entry.bbox[0],
      height: entry.bbox[3] - entry.bbox[1],
      key: this.keyOf(entry.order),
    };
  }

  /** The Form XObject object for one embedded page (pdf-lib parity). */
  private formObject(entry: FormEntry): PdfObj {
    const [x0, y0, x1, y1] = entry.bbox;
    const resources = entry.resources ?? { k: "dict", m: new Map() };
    const dict = newDict([
      ["Type", { k: "name", v: "XObject" }],
      ["Subtype", { k: "name", v: "Form" }],
      ["FormType", num(1)],
      ["BBox", arr(num(x0), num(y0), num(x1), num(y1))],
      // boundingBoxAdjustedMatrix: position the box origin at (0,0).
      ["Matrix", arr(num(1), num(0), num(0), num(1), num(-x0), num(-y0))],
      ["Resources", resources],
      ["Filter", { k: "name", v: "FlateDecode" }],
    ]);
    return { k: "stream", m: dict.m, raw: entry.content };
  }
}

function mergeBytes(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
