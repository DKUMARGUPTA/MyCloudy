import { unzipSync } from "fflate";

/**
 * DOCX parser (Task b3-c) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * A .docx is an OOXML package: a ZIP whose parts are XML documents. This
 * module opens the package with fflate's unzipSync (the same library the
 * app zips with) and parses the two parts word-to-pdf needs:
 *
 *   word/document.xml  — walked with a simple tag scanner (a stack, NOT
 *                        regex-across-tags: document.xml can be 10 MB+).
 *                        Collects one entry per <w:p> paragraph: its
 *                        <w:pStyle w:val="…"/> and the joined text of its
 *                        <w:t> runs (xml:space="preserve" respected,
 *                        <w:br/> → "\n", <w:tab/> → 4 spaces, entities
 *                        unescaped).
 *   word/styles.xml    — Heading1/2/3 + Title definitions (half-point
 *                        sizes → pt, bold, outlineLvl) when present;
 *                        sensible defaults otherwise.
 *
 * V1 honesty (stated in the tool FAQ): numbering.xml is NOT parsed —
 * ListParagraph items render with a "• " bullet unless their text
 * already carries a literal marker; images, tables (their text IS kept,
 * their grid is not), columns, footnotes and comments are not rendered.
 *
 * Robustness: the scanner never throws on malformed XML — stray closing
 * tags are ignored (depth counters), unclosed paragraphs are flushed at
 * EOF. Structural problems (not a zip, no [Content_Types].xml, no
 * word/document.xml, non-UTF-8 parts) throw DocxParseError, which the
 * worker maps to the honest tool.errorCorrupt.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — single-pass
 * String.replace, split/join and plain exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

/**
 * The XML 1.0 predefined entities + numeric character references,
 * matched in ONE pass so "&amp;lt;" decodes to the literal "&lt;"
 * (never double-unescaped).
 */
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7});/g;

/** Decodes the five XML entities + &#NNN; / &#xHH; references. */
export function unescapeXml(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (_match: string, body: string): string => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10
        );
        if (
          !Number.isFinite(code) ||
          code < 0x20 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return "\uFFFD";
        }
        return String.fromCodePoint(code);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* The tag scanner (stack-driven, single pass)                         */
/* ------------------------------------------------------------------ */

export interface XmlTagEvent {
  /** Element name WITH its namespace prefix ("w:p", "w:t"). */
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

const TAG_NAME_RE = /^[A-Za-z_:][\w.:-]*/;
const ATTR_RE = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Minimal event scanner over one XML document. `onText` receives the
 * character data between tags plus a `raw` flag (true inside CDATA,
 * where entities must NOT be decoded). Malformed markup degrades
 * gracefully instead of throwing — this is a repair-tolerant reader.
 */
export function scanXmlTags(
  xml: string,
  onTag: (tag: XmlTagEvent) => void,
  onText: (text: string, raw: boolean) => void
): void {
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      // Trailing text after the last tag — belongs to the still-open
      // element (an unclosed <w:t> tail); the handler drops it when
      // nothing is open.
      onText(xml.slice(i), false);
      break;
    }
    if (lt > i) onText(xml.slice(i, lt), false);
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end === -1 ? len : end;
      onText(xml.slice(lt + 9, stop), true);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE and friends — skipped whole
      const end = xml.indexOf(">", lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }
    // Find the tag's ">" while respecting quoted attribute values
    // (an unescaped ">" is legal inside a quoted attribute).
    let j = lt + 1;
    let quote = "";
    while (j < len) {
      const ch = xml[j];
      if (quote !== "") {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }
    if (j >= len) break; // unterminated tag at EOF — stop
    let inner = xml.slice(lt + 1, j);
    i = j + 1;
    const closing = inner.startsWith("/");
    if (closing) inner = inner.slice(1);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = TAG_NAME_RE.exec(inner);
    if (nameMatch === null) continue; // not a tag — skip it
    const name = nameMatch[0];
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTR_RE.exec(inner)) !== null) {
      attrs[match[1]] = unescapeXml(
        match[2] !== undefined ? match[2] : (match[3] ?? "")
      );
    }
    onTag({ name, attrs, closing, selfClosing });
  }
}

/* ------------------------------------------------------------------ */
/* word/document.xml → paragraphs                                      */
/* ------------------------------------------------------------------ */

/** One paragraph: its style id (or null) and its joined run text. */
export interface WordParagraph {
  /** The <w:pStyle w:val="…"/> value — "Heading1", "Title",
   * "ListParagraph", a custom id, or null for unstyled paragraphs. */
  style: string | null;
  /** Run texts joined; <w:br/> → "\n", <w:tab/> → 4 spaces. */
  text: string;
}

/**
 * Walks document.xml and collects every paragraph. Depth counters
 * (not a single cursor) make the walk robust to textboxes and stray
 * closes: a nested <w:p> (textboxes) becomes its own paragraph.
 */
export function parseDocumentXml(xml: string): WordParagraph[] {
  const paragraphs: WordParagraph[] = [];
  const paraStack: { style: string | null; parts: string[] }[] = [];
  let pDepth = 0; // open <w:p> elements
  let rDepth = 0; // open <w:r> elements
  let tDepth = 0; // open <w:t> elements
  let preserve = false; // xml:space of the CURRENT <w:t>

  const finishTop = (): void => {
    const top = paraStack.pop();
    if (top === undefined) return;
    paragraphs.push({ style: top.style, text: top.parts.join("") });
  };

  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "w:t") {
          if (tDepth > 0) tDepth -= 1;
        } else if (tag.name === "w:r") {
          if (rDepth > 0) rDepth -= 1;
        } else if (tag.name === "w:p") {
          if (pDepth > 0) {
            pDepth -= 1;
            finishTop();
          }
        }
        return;
      }
      if (tag.selfClosing) {
        if (tag.name === "w:p") {
          // <w:p/> — a genuinely empty paragraph
          paragraphs.push({ style: null, text: "" });
          return;
        }
        const top = paraStack[paraStack.length - 1];
        if (top === undefined) return;
        if (tag.name === "w:pStyle") {
          const val = tag.attrs["w:val"];
          if (typeof val === "string" && val.length > 0) top.style = val;
        } else if (tag.name === "w:br") {
          if (rDepth > 0) top.parts.push("\n");
        } else if (tag.name === "w:tab") {
          if (rDepth > 0) top.parts.push("    ");
        }
        return;
      }
      if (tag.name === "w:p") {
        pDepth += 1;
        paraStack.push({ style: null, parts: [] });
      } else if (tag.name === "w:r") {
        rDepth += 1;
      } else if (tag.name === "w:t") {
        tDepth += 1;
        preserve = tag.attrs["xml:space"] === "preserve";
      }
    },
    (text, raw) => {
      if (tDepth === 0) return; // only text inside <w:t> counts
      const top = paraStack[paraStack.length - 1];
      if (top === undefined) return;
      if (raw) {
        top.parts.push(text); // CDATA — entities are literal here
      } else if (preserve) {
        top.parts.push(unescapeXml(text));
      } else {
        // Without xml:space="preserve" Word trims the run's edges.
        top.parts.push(unescapeXml(text).trim());
      }
    }
  );
  // Flush paragraphs left open by a truncated/malformed tail.
  while (paraStack.length > 0) finishTop();
  return paragraphs;
}

/* ------------------------------------------------------------------ */
/* word/styles.xml → the style table                                    */
/* ------------------------------------------------------------------ */

/** What the renderer needs to know about one paragraph style. */
export interface WordStyleInfo {
  /** Explicit <w:sz> in half-points → pt (undefined = use defaults). */
  sizePt?: number;
  bold?: boolean;
  /** <w:outlineLvl w:val="N"/> (0-based), when the style carries one. */
  outlineLvl?: number;
}

export type WordStyleTable = Map<string, WordStyleInfo>;

/**
 * Parses the paragraph styles word-to-pdf understands: Heading1/2/3,
 * Title and any custom style that declares a size, bold or an outline
 * level. basedOn chains are NOT followed (v1 honesty — explicit
 * definitions only, defaults fill the gaps).
 */
export function parseStylesXml(xml: string): WordStyleTable {
  const table: WordStyleTable = new Map();
  let currentId: string | null = null;
  let current: WordStyleInfo = {};
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "w:style" && currentId !== null) {
          table.set(currentId, current);
          currentId = null;
        }
        return;
      }
      if (tag.name === "w:style") {
        if (tag.selfClosing) return;
        const id = tag.attrs["w:styleId"];
        currentId = typeof id === "string" && id.length > 0 ? id : null;
        current = {};
        return;
      }
      if (currentId === null) return;
      if (tag.name === "w:sz" || tag.name === "w:szCs") {
        const halfPoints = Number(tag.attrs["w:val"]);
        if (
          Number.isFinite(halfPoints) &&
          halfPoints > 0 &&
          current.sizePt === undefined
        ) {
          current.sizePt = halfPoints / 2;
        }
      } else if (tag.name === "w:b") {
        current.bold = true;
      } else if (tag.name === "w:outlineLvl") {
        const lvl = Number(tag.attrs["w:val"]);
        if (Number.isFinite(lvl) && lvl >= 0) current.outlineLvl = lvl;
      }
    },
    () => {
      /* styles.xml text content is irrelevant */
    }
  );
  if (currentId !== null) table.set(currentId, current); // unclosed tail
  return table;
}

/* ------------------------------------------------------------------ */
/* Classification (paragraphs + styles → render blocks)                */
/* ------------------------------------------------------------------ */

/** The markdown-to-pdf heading ladder (pt) — the render-side defaults. */
export const DEFAULT_HEADING_SIZES_PT: readonly [number, number, number] = [
  22, 18, 15,
];
/** Default Title size when styles.xml has none (pt). */
export const DEFAULT_TITLE_SIZE_PT = 26;

/** One renderable block of the document. */
export type WordDocBlock =
  | { kind: "title"; text: string; sizePt: number; bold: boolean }
  | {
      kind: "heading";
      level: 1 | 2 | 3;
      text: string;
      sizePt: number;
      bold: boolean;
    }
  | { kind: "listItem"; text: string }
  | { kind: "para"; text: string }
  | { kind: "spacer" };

const HEADING_STYLE_RE = /^heading([1-9])$/i;

function level1to3(level: number): 1 | 2 | 3 {
  return Math.min(3, Math.max(1, level)) as 1 | 2 | 3;
}

/**
 * True when the text already carries a literal list marker — pdf-to-word
 * writes "• " / "N. " prefixes into ListParagraph text, and doubling
 * them would lie about the source.
 */
export function hasListMarker(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  return /^[•·◦▪‣*\u2013-]\s/.test(t) || /^\d{1,3}[.)]\s/.test(t);
}

/**
 * Style + text → render blocks. Known ids first (Heading1-9, Title,
 * ListParagraph), then styles.xml lookups (explicit size, bold,
 * outlineLvl 0-2 → heading levels, deeper outline levels flatten
 * onto 3 like Heading4+ do). Everything else is a paragraph.
 */
export function classifyParagraphs(
  paragraphs: WordParagraph[],
  styles: WordStyleTable
): WordDocBlock[] {
  const blocks: WordDocBlock[] = [];
  for (const para of paragraphs) {
    if (para.text.trim().length === 0) {
      blocks.push({ kind: "spacer" });
      continue;
    }
    const styleId = para.style;
    const info = styleId === null ? undefined : styles.get(styleId);
    if (styleId !== null) {
      const headingMatch = HEADING_STYLE_RE.exec(styleId);
      if (headingMatch !== null) {
        const level = level1to3(Number.parseInt(headingMatch[1], 10));
        blocks.push({
          kind: "heading",
          level,
          text: para.text,
          sizePt: info?.sizePt ?? DEFAULT_HEADING_SIZES_PT[level - 1],
          bold: info?.bold ?? true,
        });
        continue;
      }
      if (styleId.toLowerCase() === "title") {
        blocks.push({
          kind: "title",
          text: para.text,
          sizePt: info?.sizePt ?? DEFAULT_TITLE_SIZE_PT,
          bold: info?.bold ?? true,
        });
        continue;
      }
      if (styleId.toLowerCase() === "listparagraph") {
        blocks.push({ kind: "listItem", text: para.text });
        continue;
      }
      if (info?.outlineLvl !== undefined) {
        const level = level1to3(info.outlineLvl + 1);
        blocks.push({
          kind: "heading",
          level,
          text: para.text,
          sizePt: info.sizePt ?? DEFAULT_HEADING_SIZES_PT[level - 1],
          bold: info.bold ?? true,
        });
        continue;
      }
    }
    blocks.push({ kind: "para", text: para.text });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* The package reader                                                   */
/* ------------------------------------------------------------------ */

/** Why a package could not be read as a .docx. */
export type DocxParseFailure = "not-zip" | "not-docx";

export class DocxParseError extends Error {
  readonly failure: DocxParseFailure;

  constructor(failure: DocxParseFailure) {
    super(failure);
    this.name = "DocxParseError";
    this.failure = failure;
  }
}

export interface ParsedDocx {
  paragraphs: WordParagraph[];
  styles: WordStyleTable;
  /** Non-whitespace characters across all paragraphs (the empty guard). */
  charCount: number;
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * bytes → paragraphs + styles. Throws DocxParseError("not-zip") for a
 * non-zip, DocxParseError("not-docx") for a zip without the OOXML
 * package skeleton ([Content_Types].xml + word/document.xml) or with
 * parts that are not strict UTF-8.
 */
export function parseDocxBytes(bytes: Uint8Array): ParsedDocx {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new DocxParseError("not-zip");
  }
  if (parts["[Content_Types].xml"] === undefined) {
    throw new DocxParseError("not-docx");
  }
  const documentBytes = parts["word/document.xml"];
  if (documentBytes === undefined) {
    throw new DocxParseError("not-docx");
  }
  const documentXml = decodeStrictUtf8(documentBytes);
  if (documentXml === null) {
    throw new DocxParseError("not-docx");
  }
  const paragraphs = parseDocumentXml(documentXml);
  let styles: WordStyleTable = new Map();
  const styleBytes = parts["word/styles.xml"];
  if (styleBytes !== undefined) {
    const stylesXml = decodeStrictUtf8(styleBytes);
    // A broken styles part degrades to defaults, not to a dead tool.
    if (stylesXml !== null) styles = parseStylesXml(stylesXml);
  }
  let charCount = 0;
  for (const para of paragraphs) {
    charCount += para.text.replace(/\s/g, "").length;
  }
  return { paragraphs, styles, charCount };
}
