/**
 * EPUB to PDF (RB3-a — the 75th tool) — pure model. No DOM, no
 * DOMParser (workers have none), no pdf-lib, no node APIs: the same
 * parseEpub feeds the surface's live book summary AND the worker's
 * render path, so the preview numbers can never disagree with the
 * output.
 *
 *  - parseEpub(bytes): an EPUB is an OCF ZIP (mimetype =
 *    "application/epub+zip" as the FIRST STORED entry). fflate
 *    unzipSync → META-INF/container.xml → rootfile (the OPF, possibly
 *    nested in subdirs) → manifest (id → href + media-type) + spine
 *    (itemref order = chapter order). Hrefs resolve against the OPF's
 *    own directory with ../ climbs and URL-encoding handled.
 *  - Spine is followed through XHTML/HTML items only; images, fonts,
 *    CSS and NCXs are skipped with honest accounting (`skipped`).
 *    Chapters parse with html-to-pdf's own parser + boundary coercion
 *    (headings, paragraphs, bold/italic/underline runs, nested lists,
 *    quotes, <pre>, tables — the html-to-pdf scope, nothing more).
 *  - TOC: EPUB 3 nav.xhtml (nav[epub:type=toc] anchors) or EPUB 2
 *    toc.ncx (navMap/navPoint labels) — used for chapter titles and
 *    shown in the surface summary.
 *  - Cover: manifest item with properties="cover-image" OR
 *    meta[name=cover] → PNG/JPG only (sniffed by media-type or magic
 *    bytes); anything else (GIF/SVG covers) is honestly not carried.
 *  - DRM: META-INF/encryption.xml → rejected outright (Adobe DRM
 *    books and font-obfuscated packages both live there; neither can
 *    be read honestly on-device).
 *  - needsNoto / isWinAnsiText (html-to-pdf's helper): pure-WinAnsi
 *    books render with non-embedded base-14 Helvetica; ANY non-WinAnsi
 *    char (Devanagari, ₹ …) switches to the Noto Sans Devanagari
 *    subset (fontkit) — decided per-document, once.
 *
 * Honest limits (mirrored in config.ts): CSS styling is not applied
 * (reflow, not facsimile), fixed-layout EPUBs are rendered as ordinary
 * reflowable text, and the optional TOC page carries exact page
 * numbers because chapters always start on a fresh page. CHAPTER
 * IMAGES (audit R4-a): a paragraph that is only one <img> embeds its
 * resolved zip part (PNG/JPG, ≤ MAX_EPUB_IMAGES) at that spot —
 * remote http(s) srcs, missing parts and other formats keep the honest
 * alt text and are counted in imagesSkipped; inline images stay alt
 * text exactly as before.
 */

import { unzipSync, zipSync, strToU8, type Unzipped, type Zippable } from "fflate";

import {
  decodeHtmlBytes,
  estimatePages as htmlEstimatePages,
  isWinAnsiText,
  needsNoto as htmlNeedsNoto,
  parseHtml,
  parseHtmlRun,
  tokenizeHtml,
  type HtmlTokenHandlers,
  type ParsedHtml,
} from "../html-to-pdf/model";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the boundary parser + the FAQ)                 */
/* ------------------------------------------------------------------ */

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_CHAPTERS = 500;
export const MAX_TOTAL_BLOCKS = 60_000;
export const MAX_TOC_ENTRIES = 2_000;
export const MAX_TITLE_TEXT = 300;
export const MAX_AUTHOR_TEXT = 300;
/** Chapter images carried into the PDF (audit R4-a) — beyond is an
 * honest skip, never a silent drop. */
export const MAX_EPUB_IMAGES = 50;

/** Worker/surface input gate: 20 MB of EPUB package. */
export function inputTooLarge(byteLength: number): boolean {
  return byteLength > MAX_INPUT_BYTES;
}

/* ------------------------------------------------------------------ */
/* Doc model                                                            */
/* ------------------------------------------------------------------ */

/** One spine chapter: its zip path, resolved title and parsed body. */
export interface EpubChapter {
  /** normalized zip path, e.g. "OEBPS/text/ch1.xhtml" */
  href: string;
  /** nav/ncx label, else the first heading's text, else "" (render
   * falls back to the localized "Chapter N"). */
  title: string;
  /** html-to-pdf's typed IR of the chapter body. */
  doc: ParsedHtml;
}

export interface EpubTocEntry {
  title: string;
  /** normalized zip path the entry points at (fragment stripped). */
  href: string;
}

export interface EpubCover {
  bytes: Uint8Array;
  kind: "png" | "jpg";
}

/** One resolvable chapter image (audit R4-a): a zip member that a
 * chapter <img> points at and the renderer can embed. */
export interface EpubImageRef {
  /** normalized zip path, e.g. "OEBPS/images/plot.png" */
  path: string;
  kind: "png" | "jpg";
}

export interface ParsedEpub {
  /** dc:title (first non-empty). */
  title: string;
  /** dc:creator values joined with ", " (capped). */
  author: string;
  /** dc:language (e.g. "en", "hi"). */
  language: string;
  /** spine order, XHTML only, empties dropped. */
  chapters: EpubChapter[];
  /** nav.xhtml / toc.ncx entries in document order (capped). */
  toc: EpubTocEntry[];
  /** PNG/JPG cover bytes when detected, else null. */
  cover: EpubCover | null;
  /** chapter images that resolve to zip parts, in document order (≤
   * MAX_EPUB_IMAGES — audit R4-a). */
  images: EpubImageRef[];
  /** <img> elements found but honestly not carried (remote http(s)
   * srcs, missing/unsupported parts, over the cap). */
  imagesSkipped: number;
  /** spine items honestly not followed (images, fonts, CSS, NCX…). */
  skipped: number;
  /** true when a hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Error codes (the worker maps them to i18n keys "epub.<code>")        */
/* ------------------------------------------------------------------ */

export type EpubErrorCode =
  | "errNotZip"
  | "errCorrupt"
  | "errDrm"
  | "errNoMimetype"
  | "errNoContainer"
  | "errNoOpf"
  | "errNoSpine"
  | "errEmpty";

export class EpubParseError extends Error {
  readonly code: EpubErrorCode;
  constructor(code: EpubErrorCode) {
    super(code);
    this.code = code;
    this.name = "EpubParseError";
  }
}

/* ------------------------------------------------------------------ */
/* ZIP magic sniffing (shared by the surface DropZone + the worker)     */
/* ------------------------------------------------------------------ */

/** ZIP local-file magic "PK\x03\x04" — what an .epub must start with. */
export function isZipBytes(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  );
}

/**
 * Any ZIP signature (local-file, spanning, end-of-central-directory) —
 * used inside parseEpub so an EOCD-only empty archive flows to the
 * missing-mimetype check instead of a wrong "not a zip" claim.
 */
function hasZipSignature(head: Uint8Array): boolean {
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return false;
  const kind = (head[2] << 8) | head[3];
  return kind === 0x0304 || kind === 0x0506 || kind === 0x0708;
}

/* ------------------------------------------------------------------ */
/* Zip path handling                                                     */
/* ------------------------------------------------------------------ */

/** Normalizes "a/./b/../c" → "a/c"; backslashes become slashes. */
export function normalizeZipPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Decodes %20-style hrefs (malformed ones pass through). */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Resolves a (possibly relative, possibly ../-climbing, possibly
 * #fragment-carrying) OPF/nav/ncx href against the referencing file's
 * directory, returning the normalized zip path.
 */
export function resolveZipPath(baseDir: string, href: string): string {
  const noFrag = href.split("#")[0] ?? "";
  if (noFrag === "") return "";
  const decoded = decodeHref(noFrag);
  if (decoded.includes("://")) return ""; // remote href — never a zip member
  if (decoded.startsWith("/")) return normalizeZipPath(decoded);
  return normalizeZipPath(`${baseDir}/${decoded}`);
}

/**
 * Zip member lookup: exact key first, then a case-insensitive unique
 * match (some packaging tools write different case than the OPF).
 */
export function lookupEntry(files: Unzipped, path: string): Uint8Array | undefined {
  const direct = files[path];
  if (direct !== undefined) return direct;
  const lower = path.toLowerCase();
  let hit: Uint8Array | undefined;
  for (const key of Object.keys(files)) {
    if (key.toLowerCase() === lower) {
      if (hit !== undefined) return undefined; // ambiguous — treat as miss
      hit = files[key];
    }
  }
  return hit;
}

/* ------------------------------------------------------------------ */
/* XML scanning (html-to-pdf's tokenizer: tags + attrs + entities)      */
/* ------------------------------------------------------------------ */

interface OpfItem {
  href: string;
  mediaType: string;
  properties: string[];
}

interface OpfData {
  title: string;
  author: string;
  language: string;
  manifest: Map<string, OpfItem>;
  spineIds: string[];
  spineTocId: string;
  metaCoverId: string;
}

/** META-INF/container.xml → the OPF path (OEBPS media-type preferred). */
function parseContainerXml(xml: string): string {
  let preferred = "";
  let fallback = "";
  const h: HtmlTokenHandlers = {
    open: (name, attrs) => {
      if (name === "rootfile") {
        const full = String(attrs["full-path"] ?? "").trim();
        if (full === "" || preferred !== "") return;
        const media = String(attrs["media-type"] ?? "").trim();
        if (media === "application/oebps-package+xml") {
          preferred = full;
        } else if (fallback === "") {
          fallback = full;
        }
      }
    },
    close: () => undefined,
    text: () => undefined,
  };
  try {
    tokenizeHtml(xml, h);
  } catch {
    return "";
  }
  return preferred || fallback;
}

/** whitespace-split helper for the properties attribute. */
function propList(v: string | undefined): string[] {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** OPF (package document) → metadata + manifest + spine order. */
function parseOpf(xml: string): OpfData | null {
  const data: OpfData = {
    title: "",
    author: "",
    language: "",
    manifest: new Map(),
    spineIds: [],
    spineTocId: "",
    metaCoverId: "",
  };
  const stack: string[] = [];
  let sawPackage = false;
  let inMetadata = false;
  let inManifest = false;
  let inSpine = false;
  let textBuf = "";
  let textTarget: "title" | "creator" | "language" | null = null;
  const creators: string[] = [];

  const h: HtmlTokenHandlers = {
    open: (name, attrs, selfClosing) => {
      if (!selfClosing) stack.push(name);
      const top = stack[stack.length - 1];
      switch (name) {
        case "package":
          sawPackage = true;
          break;
        case "metadata":
          inMetadata = true;
          break;
        case "manifest":
          inManifest = true;
          break;
        case "spine":
          inSpine = true;
          data.spineTocId = String(attrs.toc ?? "").trim();
          break;
        default:
          break;
      }
      if (inMetadata && !selfClosing && stack.length > 1) {
        if (top === "dc:title") {
          textTarget = "title";
          textBuf = "";
        } else if (top === "dc:creator") {
          textTarget = "creator";
          textBuf = "";
        } else if (top === "dc:language") {
          textTarget = "language";
          textBuf = "";
        }
      }
      if (inManifest && name === "item") {
        const id = String(attrs.id ?? "").trim();
        if (id !== "") {
          data.manifest.set(id, {
            href: String(attrs.href ?? "").trim(),
            mediaType: String(attrs["media-type"] ?? "").trim().toLowerCase(),
            properties: propList(attrs.properties),
          });
        }
      }
      if (inSpine && name === "itemref") {
        const idref = String(attrs.idref ?? "").trim();
        if (idref !== "") data.spineIds.push(idref);
      }
      if (inMetadata && name === "meta") {
        const metaName = String(attrs.name ?? "").trim().toLowerCase();
        if (metaName === "cover") {
          data.metaCoverId = String(attrs.content ?? "").trim();
        }
      }
    },
    close: (name) => {
      const k = stack.lastIndexOf(name);
      if (k < 0) return;
      stack.length = k;
      switch (name) {
        case "metadata":
          inMetadata = false;
          break;
        case "manifest":
          inManifest = false;
          break;
        case "spine":
          inSpine = false;
          break;
        case "dc:title":
          if (textTarget === "title" && data.title === "") {
            data.title = textBuf.trim().slice(0, MAX_TITLE_TEXT);
          }
          textTarget = null;
          break;
        case "dc:creator":
          if (textTarget === "creator") {
            const v = textBuf.trim().slice(0, MAX_AUTHOR_TEXT);
            if (v !== "" && creators.length < 5) creators.push(v);
          }
          textTarget = null;
          break;
        case "dc:language":
          if (textTarget === "language" && data.language === "") {
            data.language = textBuf.trim().slice(0, 12);
          }
          textTarget = null;
          break;
        default:
          break;
      }
    },
    text: (value) => {
      if (textTarget !== null && value !== "") textBuf += value;
    },
  };
  try {
    tokenizeHtml(xml, h);
  } catch {
    return null;
  }
  if (!sawPackage) return null;
  data.author = creators.join(", ").slice(0, MAX_AUTHOR_TEXT);
  return data;
}

/** EPUB 3 nav.xhtml → TOC entries (anchors inside nav[epub:type=toc]). */
function parseNavDoc(xml: string, baseDir: string): EpubTocEntry[] {
  const tocEntries: EpubTocEntry[] = [];
  const firstNavEntries: EpubTocEntry[] = [];
  const stack: string[] = [];
  let tocNavDepth = -1; // stack depth where the toc nav opened
  let firstNavDepth = -1;
  let firstNavClosed = false;
  let pending: { href: string; text: string } | null = null;

  const h: HtmlTokenHandlers = {
    open: (name, attrs, selfClosing) => {
      if (!selfClosing) stack.push(name);
      const depth = stack.length;
      if (name === "nav" && !selfClosing) {
        const types = propList(attrs["epub:type"]);
        if (types.includes("toc") && tocNavDepth === -1) {
          tocNavDepth = depth;
        } else if (firstNavDepth === -1 && !firstNavClosed) {
          firstNavDepth = depth;
        }
      }
      if (name === "a" && !selfClosing) {
        const insideToc = tocNavDepth !== -1 && depth > tocNavDepth;
        const insideFirst =
          tocNavDepth === -1 && firstNavDepth !== -1 && depth > firstNavDepth;
        if (insideToc || insideFirst) {
          pending = { href: String(attrs.href ?? ""), text: "" };
        }
      }
    },
    close: (name) => {
      const k = stack.lastIndexOf(name);
      if (k < 0) return;
      stack.length = k;
      if (name === "a" && pending !== null) {
        const title = pending.text.replace(/\s+/g, " ").trim().slice(0, 200);
        const href = resolveZipPath(baseDir, pending.href);
        if (title !== "" && href !== "") {
          if (tocNavDepth !== -1 && k >= tocNavDepth) {
            if (tocEntries.length < MAX_TOC_ENTRIES) {
              tocEntries.push({ title, href });
            }
          } else if (
            firstNavDepth !== -1 &&
            firstNavEntries.length < MAX_TOC_ENTRIES
          ) {
            firstNavEntries.push({ title, href });
          }
        }
        pending = null;
        return;
      }
      if (name === "nav") {
        if (tocNavDepth !== -1 && k < tocNavDepth) {
          tocNavDepth = -1; // the toc nav itself closed
        } else if (firstNavDepth !== -1 && k < firstNavDepth) {
          firstNavDepth = -1;
          firstNavClosed = true;
        }
      }
    },
    text: (value) => {
      if (pending !== null && value !== "") pending.text += value;
    },
  };
  try {
    tokenizeHtml(xml, h);
  } catch {
    /* tolerate — the caller treats an unparsable nav as no TOC */
  }
  return tocEntries.length > 0 ? tocEntries : firstNavEntries;
}

/** EPUB 2 toc.ncx → TOC entries (navMap navPoint labels, flattened). */
function parseNcxDoc(xml: string, baseDir: string): EpubTocEntry[] {
  const entries: EpubTocEntry[] = [];
  const stack: string[] = [];
  let inNavLabel = false;
  let labelBuf = "";
  const pending: { title: string; href: string }[] = [];

  const h: HtmlTokenHandlers = {
    open: (name, attrs, selfClosing) => {
      if (!selfClosing) stack.push(name);
      switch (name) {
        case "navpoint":
          pending.push({ title: "", href: "" });
          break;
        case "navlabel":
          inNavLabel = true;
          labelBuf = "";
          break;
        case "content":
          if (pending.length > 0) {
            pending[pending.length - 1].href = resolveZipPath(
              baseDir,
              String(attrs.src ?? "")
            );
          }
          break;
        default:
          break;
      }
    },
    close: (name) => {
      const k = stack.lastIndexOf(name);
      if (k < 0) return;
      stack.length = k;
      switch (name) {
        case "navlabel":
          inNavLabel = false;
          break;
        case "text":
          if (inNavLabel && pending.length > 0) {
            pending[pending.length - 1].title = labelBuf
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200);
            labelBuf = "";
          }
          break;
        case "navpoint": {
          const done = pending.pop();
          if (
            done &&
            done.title !== "" &&
            done.href !== "" &&
            entries.length < MAX_TOC_ENTRIES
          ) {
            entries.push({ title: done.title, href: done.href });
          }
          break;
        }
        default:
          break;
      }
    },
    text: (value) => {
      if (inNavLabel && value !== "") labelBuf += value;
    },
  };
  try {
    tokenizeHtml(xml, h);
  } catch {
    /* tolerate — the caller treats an unparsable NCX as no TOC */
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Chapter titles + covers                                               */
/* ------------------------------------------------------------------ */

function firstHeadingText(doc: ParsedHtml): string {
  for (const b of doc.blocks) {
    if (b.kind === "heading") {
      const t = b.runs
        .map((r) => r.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      if (t !== "") return t;
    }
    if (b.kind === "para") break; // heading must lead the chapter
  }
  return "";
}

export function sniffImageKind(
  mediaType: string,
  bytes: Uint8Array
): "png" | "jpg" | null {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "jpg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpg";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Chapter images (audit R4-a)                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolves every <img> the html parser recorded on its [alt] runs
 * (HtmlRun.img) against the book's zip parts. A paragraph that is only
 * one such run embeds its image later (render); remote http(s)/data
 * srcs, missing parts and non-PNG/JPG bytes keep the honest alt text
 * and count as skips. Runs carry the RESOLVED zip path (or undefined)
 * so the worker can key its embed map by path. Pure (no DOM, no embed).
 */
function resolveChapterImages(
  doc: ParsedHtml,
  files: Unzipped,
  chapterDir: string,
  into: Map<string, EpubImageRef>,
  state: { skipped: number; truncated: boolean }
): void {
  for (const block of doc.blocks) {
    if (
      block.kind !== "para" &&
      block.kind !== "heading" &&
      block.kind !== "quote" &&
      block.kind !== "list-item"
    ) {
      continue;
    }
    for (const run of block.runs) {
      if (run.img === undefined) continue;
      const src = run.img;
      if (/^(https?:|data:|blob:)/i.test(src) || src.includes("://")) {
        // remote — never fetched (on-device promise)
        run.img = undefined;
        state.skipped += 1;
        continue;
      }
      const path = resolveZipPath(chapterDir, src);
      const bytes = path === "" ? undefined : lookupEntry(files, path);
      const kind = bytes === undefined ? null : sniffImageKind("", bytes);
      if (bytes === undefined || bytes.length === 0 || kind === null) {
        run.img = undefined;
        state.skipped += 1;
        continue;
      }
      if (into.has(path)) {
        run.img = path; // same part shared across chapters — one embed
        continue;
      }
      if (into.size >= MAX_EPUB_IMAGES) {
        state.truncated = true;
        run.img = undefined;
        state.skipped += 1;
        continue;
      }
      into.set(path, { path, kind });
      run.img = path;
    }
  }
}

/* ------------------------------------------------------------------ */
/* parseEpub                                                            */
/* ------------------------------------------------------------------ */

/**
 * Parses an EPUB 2.0 / 3.0 package from raw bytes. Throws EpubParseError
 * with an honest code for everything that is not a readable reflowable
 * book (non-ZIP, corrupt archive, DRM/encryption, missing mimetype,
 * missing container.xml, missing OPF, empty spine, no readable text).
 */
export function parseEpub(bytes: Uint8Array): ParsedEpub {
  if (!hasZipSignature(bytes.subarray(0, 4))) {
    throw new EpubParseError("errNotZip");
  }
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubParseError("errCorrupt");
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });

  if (files["META-INF/encryption.xml"] !== undefined) {
    throw new EpubParseError("errDrm");
  }

  const mimeBytes = files["mimetype"];
  if (
    mimeBytes === undefined ||
    mimeBytes.length === 0 ||
    !decoder.decode(mimeBytes).includes("application/epub+zip")
  ) {
    throw new EpubParseError("errNoMimetype");
  }

  const containerBytes = files["META-INF/container.xml"];
  if (containerBytes === undefined || containerBytes.length === 0) {
    throw new EpubParseError("errNoContainer");
  }
  const opfPath = normalizeZipPath(
    parseContainerXml(decoder.decode(containerBytes))
  );
  if (opfPath === "") {
    throw new EpubParseError("errNoContainer");
  }
  const opfBytes = lookupEntry(files, opfPath);
  if (opfBytes === undefined || opfBytes.length === 0) {
    throw new EpubParseError("errNoOpf");
  }
  const opf = parseOpf(decoder.decode(opfBytes));
  if (opf === null) {
    throw new EpubParseError("errNoOpf");
  }
  const opfDir = dirOf(opfPath);

  // resolve the spine — unknown idrefs are skipped honestly
  const spineItems: OpfItem[] = [];
  let skipped = 0;
  for (const id of opf.spineIds) {
    const item = opf.manifest.get(id);
    if (item === undefined) {
      skipped += 1;
      continue;
    }
    spineItems.push(item);
  }
  if (spineItems.length === 0) {
    throw new EpubParseError("errNoSpine");
  }

  // TOC document: EPUB 3 nav (properties=nav) or EPUB 2 NCX
  // (spine@toc, else any dtbncx+xml manifest item).
  let toc: EpubTocEntry[] = [];
  const allItems = [...opf.manifest.values()];
  for (const item of allItems) {
    if (item.properties.includes("nav")) {
      const navPath = resolveZipPath(opfDir, item.href);
      const navBytes = lookupEntry(files, navPath);
      if (navBytes !== undefined && navBytes.length > 0) {
        toc = parseNavDoc(decodeHtmlBytes(navBytes), dirOf(navPath));
        if (toc.length > 0) break;
      }
    }
  }
  if (toc.length === 0) {
    let ncxItem: OpfItem | undefined = opf.manifest.get(opf.spineTocId);
    if (ncxItem === undefined) {
      ncxItem = allItems.find(
        (it) => it.mediaType === "application/x-dtbncx+xml"
      );
    }
    if (ncxItem !== undefined) {
      const ncxPath = resolveZipPath(opfDir, ncxItem.href);
      const ncxBytes = lookupEntry(files, ncxPath);
      if (ncxBytes !== undefined && ncxBytes.length > 0) {
        toc = parseNcxDoc(decoder.decode(ncxBytes), dirOf(ncxPath));
      }
    }
  }

  const titleByPath = new Map<string, string>();
  for (const entry of toc) {
    if (entry.href !== "" && !titleByPath.has(entry.href)) {
      titleByPath.set(entry.href, entry.title);
    }
  }

  // follow the spine — XHTML/HTML only, empties dropped, caps honest
  const chapters: EpubChapter[] = [];
  let truncated = false;
  let totalBlocks = 0;
  const imageRefs = new Map<string, EpubImageRef>();
  const imageState = { skipped: 0, truncated: false };
  const isHtmlItem = (item: OpfItem): boolean => {
    if (
      item.mediaType === "application/xhtml+xml" ||
      item.mediaType === "text/html"
    ) {
      return true;
    }
    if (item.mediaType !== "") return false;
    return /\.(xhtml|html|htm)$/i.test(item.href);
  };
  for (const item of spineItems) {
    if (!isHtmlItem(item)) {
      skipped += 1;
      continue;
    }
    if (chapters.length >= MAX_CHAPTERS) {
      truncated = true;
      break;
    }
    const href = resolveZipPath(opfDir, item.href);
    const docBytes = href === "" ? undefined : lookupEntry(files, href);
    if (docBytes === undefined || docBytes.length === 0) {
      skipped += 1;
      continue;
    }
    // html-to-pdf's parser + its boundary coercion (tampered or
    // oversized chapter bodies clamp here, exactly like the html tool)
    const doc = parseHtmlRun(
      JSON.stringify(parseHtml(decodeHtmlBytes(docBytes)))
    );
    // chapter <img> resolution (audit R4-a): runs carry the resolved
    // zip path or drop it honestly; skips + refs accumulate book-wide
    resolveChapterImages(doc, files, dirOf(href), imageRefs, imageState);
    if (doc.blocks.length === 0) {
      skipped += 1;
      continue;
    }
    totalBlocks += doc.blocks.length;
    if (totalBlocks > MAX_TOTAL_BLOCKS) {
      truncated = true;
      break;
    }
    const tocTitle = titleByPath.get(href) ?? "";
    chapters.push({
      href,
      title: tocTitle !== "" ? tocTitle : firstHeadingText(doc),
      doc,
    });
  }
  if (chapters.length === 0) {
    throw new EpubParseError("errEmpty");
  }

  // cover: properties="cover-image" (EPUB 3) OR meta[name=cover] (EPUB 2)
  let cover: EpubCover | null = null;
  const tryCover = (item: OpfItem | undefined): void => {
    if (item === undefined || cover !== null) return;
    const bytes = lookupEntry(files, resolveZipPath(opfDir, item.href));
    if (bytes === undefined || bytes.length === 0) return;
    const kind = sniffImageKind(item.mediaType, bytes);
    if (kind !== null) cover = { bytes, kind };
  };
  tryCover(allItems.find((it) => it.properties.includes("cover-image")));
  tryCover(opf.manifest.get(opf.metaCoverId));

  return {
    title: opf.title,
    author: opf.author,
    language: opf.language,
    chapters,
    toc,
    cover,
    images: [...imageRefs.values()],
    imagesSkipped: imageState.skipped,
    skipped,
    truncated: truncated || imageState.truncated,
  };
}

/* ------------------------------------------------------------------ */
/* stats / estimatePages — honest numbers for the live summary           */
/* ------------------------------------------------------------------ */

export interface EpubStats {
  chapters: number;
  words: number;
  blocks: number;
  tocEntries: number;
  hasCover: boolean;
  /** resolvable chapter images (audit R4-a). */
  images: number;
  imagesSkipped: number;
  skipped: number;
  truncated: boolean;
}

const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function stats(book: ParsedEpub): EpubStats {
  let words = 0;
  let blocks = 0;
  for (const ch of book.chapters) {
    blocks += ch.doc.blocks.length;
    for (const b of ch.doc.blocks) {
      if (b.kind === "pre") {
        words += countWords(b.text);
      } else if (b.kind === "table") {
        for (const row of b.grid) {
          for (const cell of row) words += countWords(cell);
        }
      } else if (b.kind !== "rule") {
        for (const r of b.runs) words += countWords(r.text);
      }
    }
  }
  return {
    chapters: book.chapters.length,
    words,
    blocks,
    tocEntries: book.toc.length,
    hasCover: book.cover !== null,
    images: book.images.length,
    imagesSkipped: book.imagesSkipped,
    skipped: book.skipped,
    truncated: book.truncated,
  };
}

/** true when any chapter body needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(book: ParsedEpub): boolean {
  for (const ch of book.chapters) {
    if (htmlNeedsNoto(ch.doc)) return true;
  }
  return false;
}

/** Chapter/toc titles drawn into the PDF count toward the font pick. */
export function titleNeedsNoto(s: string): boolean {
  return !isWinAnsiText(s);
}

/**
 * Pure-math page estimate (the surface badge): the per-chapter
 * html-to-pdf estimate + one cover page + one TOC page.
 */
export function estimatePages(book: ParsedEpub, baseFontSize = 11): number {
  let total = 0;
  for (const ch of book.chapters) {
    total += htmlEstimatePages(ch.doc, baseFontSize);
  }
  if (book.cover !== null) total += 1;
  total += 1; // the optional TOC page
  return total;
}

/* ------------------------------------------------------------------ */
/* Localized words (the worker passes these into the render)            */
/* ------------------------------------------------------------------ */

export function tocTitleFor(lang: "en" | "hi"): string {
  return lang === "hi" ? "विषय-सूची" : "Contents";
}

export function chapterWordFor(lang: "en" | "hi"): string {
  return lang === "hi" ? "अध्याय" : "Chapter";
}

/* ------------------------------------------------------------------ */
/* Output file name                                                     */
/* ------------------------------------------------------------------ */

/**
 * Base name for the download: the book's dc:title when available, else
 * the input file's name; a blank result falls back to the localized
 * word ("Ebook" / "ईबुक"). Unicode survives; path separators and
 * unsafe chars do not. No extension is appended here.
 */
export function outputBaseName(name: string, lang: "en" | "hi"): string {
  const fallback = lang === "hi" ? "ईबुक" : "Ebook";
  const base = String(name)
    .replace(/\.[^.]{1,12}$/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base.length > 0 ? base : fallback;
}

/* ------------------------------------------------------------------ */
/* Realistic sample (the smoke fixture) — the cover PNG is supplied by  */
/* the caller because it needs zlib (the model must stay worker-pure).  */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const XHTML_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

function xhtml(lang: string, title: string, body: string): string {
  return (
    XML_DECL +
    XHTML_DOCTYPE +
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">` +
    `<head><title>${title}</title></head><body>` +
    body +
    "</body></html>"
  );
}

function sampleContainer(opfPath: string): string {
  return (
    XML_DECL +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    "<rootfiles>" +
    `<rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>` +
    "</rootfiles></container>"
  );
}

function manifestItem(
  id: string,
  href: string,
  mediaType: string,
  properties = ""
): string {
  const props = properties === "" ? "" : ` properties="${properties}"`;
  return `<item id="${id}" href="${href}" media-type="${mediaType}"${props}/>`;
}

export interface BuildSampleEpubOpts {
  hindi?: boolean;
  /** EPUB 2 toc.ncx instead of the EPUB 3 nav document. */
  ncx?: boolean;
  /** raw PNG bytes for OEBPS/images/cover.png (cover-image property). */
  cover?: Uint8Array;
  /** raw PNG bytes for OEBPS/images/plot.png — when set, chapter 1
   * gains a block-level <p><img src="../images/plot.png"> (the ../ climb
   * from OEBPS/text/ is exercised) and chapter 3 a remote-src <img> that
   * must stay honest alt text (audit R4-a image-embedding vectors). */
  chapterImage?: Uint8Array;
}

/**
 * A REAL minimal EPUB (OCF): mimetype FIRST + STORED (level 0),
 * META-INF/container.xml, an OPF nested in OEBPS/ (so href resolution
 * and ../ climbs are exercised), an EPUB 3 nav.xhtml (or EPUB 2
 * toc.ncx), 3 chapters — one rich (headings/bold/italic/lists), one
 * long multi-page, one with a table + pre — plus, when cover bytes are
 * supplied, a cover image that ALSO sits in the spine (skipped
 * honestly) and one URL-encoded href (chapter%20two).
 */
export function buildSampleEpub(opts: BuildSampleEpubOpts = {}): Uint8Array {
  const hindi = opts.hindi === true;
  const useNcx = opts.ncx === true;
  const chapterImage = opts.chapterImage;
  const opfPath = "OEBPS/content.opf";

  const ch1Title = hindi ? "यात्रा की शुरुआत" : "The Journey Begins";
  const ch2Title = hindi ? "लंबा अध्याय" : "The Long Road";
  const ch3Title = hindi ? "तालिकाएँ" : "Ledgers and Notes";
  const bookTitle = hindi ? "बाज़ का इतिहास" : "The Falcon Chronicle";
  const bookAuthor = hindi ? "प्रिया शर्मा" : "Ananya Verma";
  const bookLang = hindi ? "hi" : "en";

  const ch1Body = hindi
    ? `<h1>${ch1Title}</h1>
<p>यह पहला अध्याय है जिसमें <b>बोल्ड</b> और <i>इटैलिक</i> टेक्स्ट आता है।</p>
<h2>उपशीर्षक</h2>
<ul><li>पहली मद</li><li>दूसरी मद</li></ul>
<p>अंत में एक <a href="ch2.xhtml">लिंक</a> अगले अध्याय की ओर।</p>`
    : `<h1>${ch1Title}</h1>
<p>The first chapter mixes <b>bold spans</b> with <i>italic ones</i> and plain text &amp; entities.</p>
<h2>A subheading</h2>
<ul><li>First bullet</li><li>Second bullet with <b>bold</b></li></ul>
<blockquote><p>A quoted line from the margins.</p></blockquote>
<p>Ends with a <a href="ch2.xhtml">link</a> to the next chapter.</p>`;

  const longParas = hindi
    ? Array.from(
        { length: 26 },
        (_, i) =>
          `<p>यह लंबे अध्याय का अनुच्छेद ${i} है, जिसमें काफ़ी शब्द हैं ताकि पेज भर जाए और पेज बँटना दिखे।</p>`
      ).join("\n")
    : Array.from(
        { length: 26 },
        (_, i) =>
          `<p>This is paragraph ${i} of the long chapter, carrying several words of body text so the page fills up and real pagination happens in the output.</p>`
      ).join("\n");
  const ch2Body = `<h1>${ch2Title}</h1>\n${longParas}`;

  const ch3Body = hindi
    ? `<h1>${ch3Title}</h1>
<table><tr><th>क्षेत्र</th><th>मान</th></tr><tr><td>उत्तर</td><td>120</td></tr></table>
<pre>पंक्ति एक
पंक्ति दो</pre>${
        chapterImage
          ? '\n<p><img src="https://example.com/remote-plot.png" alt="रिमोट तस्वीर"/></p>'
          : ""
      }`
    : `<h1>${ch3Title}</h1>
<table><tr><th>Region</th><th>Value</th></tr><tr><td>North</td><td>120</td></tr><tr><td>South</td><td>80</td></tr></table>
<pre>ledger line one
ledger line two   kept</pre>
<p>After the table.</p>${
        chapterImage
          ? '\n<p><img src="https://example.com/remote-plot.png" alt="Remote picture"/></p>'
          : ""
      }`;
  const ch1WithImage =
    chapterImage === undefined
      ? ch1Body
      : `${ch1Body}\n<p><img src="../images/plot.png" alt="Plot diagram"/></p>`;

  // nav/ncx TOC — both documents sit at the zip ROOT, so their hrefs
  // are relative to the root ("OEBPS/text/…"), exercising the ../
  // climb from the OPF's own directory separately. The EPUB 3 variant
  // puts the anchors in nav.xhtml (properties="nav"); the EPUB 2
  // variant leaves nav.xhtml a plain spine page and puts the labels in
  // toc.ncx (found via spine@toc).
  const navXml =
    XML_DECL +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    "<head><title>Contents</title></head><body>" +
    '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' +
    `<li><a href="OEBPS/text/ch1.xhtml">${ch1Title}</a></li>` +
    `<li><a href="OEBPS/text/chapter%20two.xhtml">${ch2Title}</a></li>` +
    `<li><a href="OEBPS/text/ch3.xhtml">${ch3Title}</a></li>` +
    "</ol></nav>" +
    '<nav epub:type="landmarks" hidden="hidden"><ol><li><a href="OEBPS/text/ch1.xhtml" epub:type="bodymatter">Start</a></li></ol></nav>' +
    "</body></html>";
  const ncxXml =
    XML_DECL +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
    '<head><meta name="dtb:uid" content="urn:uuid:falcon-sample"/></head>' +
    `<docTitle><text>${bookTitle}</text></docTitle>` +
    "<navMap>" +
    `<navPoint id="np1" playOrder="1"><navLabel><text>${ch1Title}</text></navLabel><content src="OEBPS/text/ch1.xhtml"/></navPoint>` +
    `<navPoint id="np2" playOrder="2"><navLabel><text>${ch2Title}</text></navLabel><content src="OEBPS/text/chapter%20two.xhtml"/></navPoint>` +
    `<navPoint id="np3" playOrder="3"><navLabel><text>${ch3Title}</text></navLabel><content src="OEBPS/text/ch3.xhtml"/></navPoint>` +
    "</navMap></ncx>";

  const manifest = [
    manifestItem(
      "nav",
      "../nav.xhtml",
      "application/xhtml+xml",
      useNcx ? "" : "nav"
    ),
    manifestItem("ncx", "../toc.ncx", "application/x-dtbncx+xml"),
    manifestItem("ch1", "text/ch1.xhtml", "application/xhtml+xml"),
    manifestItem("ch2", "text/chapter%20two.xhtml", "application/xhtml+xml"),
    manifestItem(
      "ch3",
      "text/ch3.xhtml",
      "application/xhtml+xml"
    ),
    // EPUB 3 finds the cover via properties="cover-image"; the EPUB 2
    // fixture relies on <meta name="cover"> instead.
    manifestItem("cover-img", "images/cover.png", "image/png", useNcx ? "" : "cover-image"),
    manifestItem("css", "style.css", "text/css"),
  ];
  const spine = [
    '<itemref idref="cover-img"/>', // image in the spine — skipped honestly
    '<itemref idref="nav"/>', // nav in the spine (a real EPUB 3 habit)
    '<itemref idref="ch1"/>',
    '<itemref idref="ch2"/>',
    '<itemref idref="ch3"/>',
  ];
  const opf =
    XML_DECL +
    '<package xmlns="http://www.idpf.org/2007/opf" version="' +
    (useNcx ? "2.0" : "3.0") +
    '" unique-identifier="uid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">' +
    `<dc:title>${bookTitle}</dc:title>` +
    `<dc:creator>${bookAuthor}</dc:creator>` +
    `<dc:language>${bookLang}</dc:language>` +
    '<dc:identifier id="uid">urn:uuid:falcon-sample</dc:identifier>' +
    (useNcx ? '<meta name="cover" content="cover-img"/>' : "") +
    "</metadata>" +
    "<manifest>" +
    manifest.join("") +
    "</manifest>" +
    '<spine toc="ncx">' +
    spine.join("") +
    "</spine>" +
    "</package>";

  const entries: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [strToU8(sampleContainer(opfPath)), { level: 6 }],
    "nav.xhtml": [
      strToU8(
        useNcx
          ? xhtml(bookLang, bookTitle, "<p>Table of contents page.</p>")
          : navXml
      ),
      { level: 6 },
    ],
    "toc.ncx": [strToU8(ncxXml), { level: 6 }],
    "OEBPS/content.opf": [strToU8(opf), { level: 6 }],
    "OEBPS/text/ch1.xhtml": [strToU8(xhtml(bookLang, ch1Title, ch1WithImage)), { level: 6 }],
    "OEBPS/text/chapter two.xhtml": [strToU8(xhtml(bookLang, ch2Title, ch2Body)), { level: 6 }],
    "OEBPS/text/ch3.xhtml": [strToU8(xhtml(bookLang, ch3Title, ch3Body)), { level: 6 }],
    "OEBPS/style.css": [strToU8("body { font-family: serif; }"), { level: 6 }],
  };
  if (opts.cover !== undefined) {
    entries["OEBPS/images/cover.png"] = [opts.cover, { level: 6 }];
  }
  if (opts.chapterImage !== undefined) {
    entries["OEBPS/images/plot.png"] = [opts.chapterImage, { level: 6 }];
  }
  return zipSync(entries);
}
