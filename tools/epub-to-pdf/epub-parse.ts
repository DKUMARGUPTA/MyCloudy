import { unzipSync } from "fflate";

import { scanXmlTags, unescapeXml } from "../word-to-pdf/docx-parse";
import { parseHtml, type HtmlBlock } from "../html-to-pdf/html-parse";

/**
 * EPUB parser (Task b5-a) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * An .epub is a ZIP: an (OCF) container whose first stored entry is the
 * mimetype, whose META-INF/container.xml points at the (OPF) package
 * file, and whose package lists xhtml documents in reading order. This
 * module opens the package with fflate's unzipSync (the same library the
 * app zips with) and walks the chain the spec prescribes:
 *
 *   META-INF/container.xml → <rootfile full-path="…/content.opf"> →
 *   <manifest> items (id → href + media-type) + <spine> itemrefs (the
 *   READING ORDER — spine, not manifest, decides the chapter sequence).
 *
 * Each spine document with an XHTML media-type is decoded with
 * TextDecoder (XML declaration + BOM aware, default UTF-8) and handed to
 * the SHARED tag-soup parser from ../html-to-pdf/html-parse.ts (the same
 * block model the html-to-pdf renderer consumes — headings, paragraphs,
 * nested lists, pre, quotes, rules). Chapters concatenate in spine order
 * into ONE flowing document; they are also recorded per chapter.
 *
 * V1 honesty (stated in the tool FAQ): text reflow only — images, cover
 * art and CSS are skipped (the html parser drops <img>/<svg> bodies and
 * ignores classes), so the words carry over, not the pictures.
 *
 * Robustness quirks handled: percent-encoded manifest hrefs
 * (decodeURIComponent inside try/catch), href fragments ("chap1.xhtml#s2"
 * → "chap1.xhtml"), "../" path segments resolved against the OPF's own
 * directory, spine idrefs missing from the manifest or the zip (skipped,
 * never crash), missing container.xml / package file → typed errors the
 * worker maps to honest i18n keys.
 *
 * iOS-safe (worklog lesson IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — split/join and plain
 * exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Public model                                                        */
/* ------------------------------------------------------------------ */

/** One spine document, already parsed to blocks. */
export interface EpubChapter {
  /** The RESOLVED zip path of the spine document. */
  href: string;
  blocks: HtmlBlock[];
}

export interface ParsedEpub {
  /** dc:title from the OPF metadata, when present. */
  title: string | null;
  /** dc:creator from the OPF metadata, when present. */
  author: string | null;
  /** All chapters' blocks concatenated in SPINE order (one flowing doc). */
  blocks: HtmlBlock[];
  /** Per-chapter blocks, spine order (empty chapters included honestly). */
  chapters: EpubChapter[];
}

/** Why a package could not be read as an epub. */
export type EpubParseFailure = "not-zip" | "no-container" | "no-package";

export class EpubParseError extends Error {
  readonly failure: EpubParseFailure;

  constructor(failure: EpubParseFailure) {
    super(failure);
    this.name = "EpubParseError";
    this.failure = failure;
  }
}

/* ------------------------------------------------------------------ */
/* Zip path plumbing                                                   */
/* ------------------------------------------------------------------ */

/** Element name → its local part ("dc:title" → "title"). */
function localName(name: string): string {
  const cut = name.indexOf(":");
  return cut === -1 ? name : name.slice(cut + 1);
}

/** Collapses ".", "..", duplicate and leading "/" segments of a zip path. */
function normalizeZipPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Resolves one manifest href against the OPF's directory:
 * strips the fragment, percent-decodes (try/catch — a stray "%" stays
 * raw), joins and normalizes. Exported for the smoke's unit checks.
 */
export function resolveZipPath(opfDir: string, href: string): string {
  const noFrag = href.split("#")[0];
  let decoded = noFrag;
  try {
    decoded = decodeURIComponent(noFrag);
  } catch {
    // malformed percent escape — keep the raw href (honest best effort)
  }
  let joined: string;
  if (decoded.startsWith("/")) {
    joined = decoded.slice(1); // zip-rooted href
  } else if (opfDir.length > 0) {
    joined = `${opfDir}/${decoded}`;
  } else {
    joined = decoded;
  }
  return normalizeZipPath(joined);
}

/** The OPF's own directory ("OEBPS/content.opf" → "OEBPS"). */
function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/* ------------------------------------------------------------------ */
/* XML part decoding (declaration + BOM aware)                         */
/* ------------------------------------------------------------------ */

/**
 * Decodes one zip XML part. The encoding comes from the BOM when there
 * is one, else from the XML declaration's encoding="…" pseudo-attribute
 * (scanned ASCII-safely over the head bytes), defaulting to UTF-8 the
 * way the XML spec says. Exported for the smoke's unit checks.
 */
export function decodeXmlPart(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes);
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes);
    }
  }
  const headLen = Math.min(bytes.length, 512);
  let head = "";
  for (let i = 0; i < headLen; i += 1) {
    head += String.fromCharCode(bytes[i]);
  }
  const decl = /encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  let text: string;
  if (decl !== null) {
    try {
      text = new TextDecoder(decl[1]).decode(bytes);
    } catch {
      // unsupported label (TextDecoder throws RangeError) — fall back
      text = new TextDecoder("utf-8").decode(bytes);
    }
  } else {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return text.replace(/^\ufeff/, "");
}

/* ------------------------------------------------------------------ */
/* container.xml → the package path                                     */
/* ------------------------------------------------------------------ */

/**
 * META-INF/container.xml → the first <rootfile full-path="…"> (the OCF
 * spec's primary rootfile — real epubs have exactly one). The path is
 * percent-decoded + normalized like every other href. Null when the
 * container carries no usable rootfile.
 */
function findRootfilePath(containerXml: string): string | null {
  let found: string | null = null;
  scanXmlTags(
    containerXml,
    (tag) => {
      if (found !== null || tag.closing) return;
      if (localName(tag.name) !== "rootfile") return;
      const raw = tag.attrs["full-path"];
      if (raw === undefined || raw.length === 0) return;
      const fp = resolveZipPath("", raw);
      if (fp.length > 0) found = fp;
    },
    () => {
      /* container.xml carries no text we need */
    }
  );
  return found;
}

/* ------------------------------------------------------------------ */
/* The OPF (package) — manifest + spine + dc metadata                   */
/* ------------------------------------------------------------------ */

interface OpfManifestItem {
  href: string;
  mediaType: string;
}

interface OpfContents {
  title: string | null;
  author: string | null;
  /** id → item (href still raw at this stage). */
  manifest: Map<string, OpfManifestItem>;
  /** Spine itemref idrefs, in READING ORDER. */
  spine: string[];
}

/**
 * Parses one OPF document with the shared stack scanner. dc:title /
 * dc:creator are captured from <metadata> (first of each wins — real
 * files occasionally repeat creators); <item> builds the manifest;
 * <itemref idref="…"> builds the spine. Malformed markup degrades to
 * what could be read, never throws.
 */
function parseOpf(opfXml: string): OpfContents {
  const out: OpfContents = {
    title: null,
    author: null,
    manifest: new Map(),
    spine: [],
  };
  /** Element the metadata text currently belongs to ("title"/"creator"). */
  let capturing: string | null = null;
  let captureText = "";

  scanXmlTags(
    opfXml,
    (tag) => {
      const ln = localName(tag.name);
      if (tag.closing) {
        if (capturing !== null && capturing === ln) {
          const value = captureText.trim();
          if (value.length > 0) {
            if (ln === "title" && out.title === null) out.title = value;
            else if (ln === "creator" && out.author === null) {
              out.author = value;
            }
          }
          capturing = null;
          captureText = "";
        }
        return;
      }
      if (ln === "item") {
        const id = tag.attrs["id"];
        const href = tag.attrs["href"];
        const mediaType = tag.attrs["media-type"];
        if (id !== undefined && href !== undefined && id.length > 0) {
          if (!out.manifest.has(id)) {
            out.manifest.set(id, { href, mediaType: mediaType ?? "" });
          }
        }
        return;
      }
      if (ln === "itemref") {
        const idref = tag.attrs["idref"];
        if (idref !== undefined && idref.length > 0) {
          out.spine.push(idref);
        }
        return;
      }
      // dc metadata capture (first of each wins; EPUB 3 refines live in
      // <meta>, which never shares a local name with these two)
      if (capturing === null && (ln === "title" || ln === "creator")) {
        capturing = ln;
        captureText = "";
      }
    },
    (text, raw) => {
      // character data inside <dc:title>/<dc:creator> still carries its
      // entities — decode them the XML way (CDATA never does)
      if (capturing !== null) captureText += raw ? text : unescapeXml(text);
    }
  );
  return out;
}

/** Media-types whose spine documents we render as XHTML. */
function isXhtmlMediaType(mediaType: string): boolean {
  const mt = mediaType.trim().toLowerCase();
  // EPUB 2/3 require application/xhtml+xml; a few real-world books
  // declare text/html on the same documents — both parse identically.
  return mt === "application/xhtml+xml" || mt === "text/html";
}

/* ------------------------------------------------------------------ */
/* The package reader                                                   */
/* ------------------------------------------------------------------ */

/**
 * bytes → the flowing document. Throws EpubParseError("not-zip") for a
 * non-zip, ("no-container") when META-INF/container.xml is missing or
 * unreadable, and ("no-package") when the container's rootfile (the
 * .opf) cannot be found or opened. Chapters that are missing from the
 * zip or carry a non-XHTML media-type are skipped, not fatal.
 */
export function parseEpubBytes(
  bytes: Uint8Array,
  onChapter?: (done: number, total: number) => void
): ParsedEpub {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new EpubParseError("not-zip");
  }

  // Normalized entry lookup: zip keys are usually already clean, but
  // "./OEBPS/x.xhtml" or "OEBPS/../x.xhtml" style keys do occur.
  const entries = new Map<string, Uint8Array>();
  for (const key of Object.keys(parts)) {
    const norm = normalizeZipPath(key);
    if (norm.length > 0 && !entries.has(norm)) entries.set(norm, parts[key]);
  }

  const containerBytes =
    parts["META-INF/container.xml"] ?? entries.get("META-INF/container.xml");
  if (containerBytes === undefined) {
    throw new EpubParseError("no-container");
  }
  const containerXml = decodeXmlPart(containerBytes);
  const opfPath = findRootfilePath(containerXml);
  if (opfPath === null) {
    throw new EpubParseError("no-package");
  }
  const opfBytes = entries.get(opfPath);
  if (opfBytes === undefined) {
    throw new EpubParseError("no-package");
  }
  const opf = parseOpf(decodeXmlPart(opfBytes));
  const opfDir = dirOf(opfPath);

  // Pre-compute the spine's renderable documents (spine order, not
  // manifest order, is the reading order — the spec's contract).
  const spineDocs: { href: string; raw: Uint8Array }[] = [];
  for (const idref of opf.spine) {
    const item = opf.manifest.get(idref);
    if (item === undefined) continue; // idref not in the manifest — skip
    if (!isXhtmlMediaType(item.mediaType)) continue; // css/image/nav — skip
    const href = resolveZipPath(opfDir, item.href);
    const docBytes = entries.get(href);
    if (docBytes === undefined) continue; // missing part — skip, no crash
    spineDocs.push({ href, raw: docBytes });
  }

  const chapters: EpubChapter[] = [];
  const blocks: HtmlBlock[] = [];
  for (let i = 0; i < spineDocs.length; i += 1) {
    const doc = spineDocs[i];
    const docBlocks = parseHtml(decodeXmlPart(doc.raw));
    chapters.push({ href: doc.href, blocks: docBlocks });
    for (const block of docBlocks) blocks.push(block);
    onChapter?.(i + 1, spineDocs.length);
  }

  return {
    title: opf.title,
    author: opf.author,
    blocks,
    chapters,
  };
}
