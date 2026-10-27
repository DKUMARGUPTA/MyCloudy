import { zipSync, type Zippable } from "fflate";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  buildBlocks,
  buildHeadingContext,
  buildSegments,
  pageCharCount,
  pageLines,
  type HeadingContext,
  type MdBlock,
  type MdLine,
  type RawTextItem,
} from "../pdf-to-markdown/md-build";

/**
 * PDF → DOCX engine (Task 2-b) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * A .docx is an OOXML package: a ZIP container whose parts are XML
 * documents. This module reuses the pdf-to-markdown extraction core
 * (pieces → visual lines → document-wide font-size heading clustering →
 * segments) and emits the minimal VALID part set:
 *
 *   [Content_Types].xml              — content types for every part
 *   _rels/.rels                       — package → word/document.xml
 *   word/document.xml                 — the body: one <w:p> per block,
 *                                       headings via Heading1/2/3 styles,
 *                                       lists as "List Paragraph" + literal
 *                                       "• " / "N. " prefixes (v1), ends
 *                                       with the mandatory <w:sectPr>
 *   word/_rels/document.xml.rels       — document → word/styles.xml
 *   word/styles.xml                   — Normal/Title/Heading1-3/
 *                                       ListParagraph definitions
 *
 * SECURITY (the html-emit lesson, same rigor): every piece of user text
 * goes through escapeXml() before it touches document.xml — & < > " '
 * are entity-escaped with & FIRST (no double-escape), and characters
 * that are invalid in XML 1.0 are stripped. The output is UTF-8
 * (TextEncoder), Devanagari passes through verbatim.
 *
 * iOS-safe (worklog IOS-COMPAT): no String.prototype.matchAll /
 * replaceAll, no regex lookbehind, no Object.hasOwn / structuredClone —
 * split/join and plain exec/test only.
 *
 * Honest limits (documented in the tool FAQ): text-only v1 — no images,
 * no tables, no multi-column reconstruction; heading levels are a
 * font-size heuristic capped at Heading3; bold-only or caps-only
 * headings at body size stay paragraphs.
 */

/* Re-exports: the extraction core this engine is built on. */
export { buildHeadingContext, pageCharCount, pageLines };
export type { RawTextItem };

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type WordBlockKind = "heading" | "para" | "bullet" | "numbered";

/** One paragraph-level element of the output document. */
export interface WordBlock {
  kind: WordBlockKind;
  /** Heading level 1-3 (headings only; deeper PDF levels clamp to 3). */
  level?: number;
  /** Source number of an ordered item ("1", "2", … — numbered only). */
  num?: string;
  text: string;
}

/** Resolved tool options (the worker consumes OptionValues). */
export interface WordOutOptions {
  pages: string;
}

/** Option normalization for the worker (and the smoke). */
export function resolveWordOptions(options: OptionValues): WordOutOptions {
  return { pages: typeof options.pages === "string" ? options.pages : "all" };
}

/* ------------------------------------------------------------------ */
/* Escaping (CRITICAL — user content goes into XML)                    */
/* ------------------------------------------------------------------ */

/**
 * XML text escaping. `&` first so nothing double-escapes; split/join
 * (not replaceAll) per the iOS-compat rule. The five XML 1.0 predefined
 * entities cover every character an attacker (or a quirky PDF) can put
 * inside <w:t>.
 */
export function escapeXml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

/**
 * Removes characters that are invalid in XML 1.0 documents (C0 controls
 * except \t \n \r, plus DEL) — they would make Word reject the file.
 */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/* ------------------------------------------------------------------ */
/* md-blocks → word-blocks                                              */
/* ------------------------------------------------------------------ */

/** Heading levels deeper than 3 flatten onto Heading3 (honest v1 cap). */
function clampLevel(level: number | undefined): number {
  return Math.min(3, Math.max(1, level ?? 1));
}

/** Maps the shared MdBlock model onto the docx paragraph model. */
export function mdBlocksToWordBlocks(blocks: MdBlock[]): WordBlock[] {
  const out: WordBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      out.push({ kind: "heading", level: clampLevel(block.level), text: block.text });
    } else if (block.kind === "bullet") {
      out.push({ kind: "bullet", text: block.text });
    } else if (block.kind === "numbered") {
      out.push({ kind: "numbered", num: block.num ?? "1", text: block.text });
    } else {
      out.push({ kind: "para", text: block.text });
    }
  }
  return out;
}

/**
 * One page's visual lines → word blocks (headings resolved against the
 * DOCUMENT-wide heading context built by buildHeadingContext).
 */
export function linesToWordBlocks(
  lines: MdLine[],
  ctx: HeadingContext
): WordBlock[] {
  const segments = buildSegments(lines, ctx.body, true);
  const mdBlocks = buildBlocks(segments, ctx, {
    headings: true,
    pageRules: false,
  });
  return mdBlocksToWordBlocks(mdBlocks);
}

/** All pages' lines → the document's word blocks, in reading order. */
export function pagesToWordBlocks(pages: MdLine[][]): WordBlock[] {
  const ctx = buildHeadingContext(pages);
  const out: WordBlock[] = [];
  for (const lines of pages) {
    for (const block of linesToWordBlocks(lines, ctx)) out.push(block);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* document.xml emission                                               */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** One run of text — xml:space="preserve" keeps Word from eating spaces. */
function textRunXml(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(
    stripInvalidXmlChars(text)
  )}</w:t></w:r>`;
}

/** One paragraph, optionally styled (Heading1-3 / ListParagraph). */
function paragraphXml(styleId: string | null, text: string): string {
  const pPr =
    styleId === null
      ? ""
      : `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`;
  return `<w:p>${pPr}${textRunXml(text)}</w:p>`;
}

/**
 * One word block → its <w:p> element. Bullets/numbered items use the
 * "List Paragraph" style with a literal "• " / "N. " prefix — the honest
 * v1 (real Word auto-numbering needs a numbering.xml part with abstract
 * numbering definitions; not worth faking badly).
 */
export function wordBlockToParagraph(block: WordBlock): string {
  if (block.kind === "heading") {
    return paragraphXml(`Heading${clampLevel(block.level)}`, block.text);
  }
  if (block.kind === "bullet") {
    return paragraphXml("ListParagraph", `\u2022 ${block.text}`);
  }
  if (block.kind === "numbered") {
    return paragraphXml("ListParagraph", `${block.num ?? "1"}. ${block.text}`);
  }
  return paragraphXml(null, block.text);
}

/** A4 portrait + sensible margins, in twips (1/1440 in). */
const SECT_PR_XML =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" ' +
  'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

/**
 * Word blocks → the complete word/document.xml. The body ends with the
 * mandatory <w:sectPr> (the LAST child of <w:body>, per OOXML).
 */
export function blocksToDocumentXml(blocks: WordBlock[]): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (block.text.trim().length === 0) continue;
    paragraphs.push(wordBlockToParagraph(block));
  }
  return [
    XML_DECL,
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body>",
    paragraphs.join(""),
    SECT_PR_XML,
    "</w:body>",
    "</w:document>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The other OOXML parts                                               */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES_XML = [
  XML_DECL,
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
  "</Types>",
  "",
].join("\n");

const ROOT_RELS_XML = [
  XML_DECL,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
  "</Relationships>",
  "",
].join("\n");

const DOC_RELS_XML = [
  XML_DECL,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  "</Relationships>",
  "",
].join("\n");

/**
 * word/styles.xml — Normal + Title + Heading1-3 + ListParagraph.
 *
 * Sizes are half-points (Word's own default ladder): Title 56 (28 pt),
 * Heading1 32 (16 pt), Heading2 26 (13 pt), Heading3 22 (11 pt); all
 * bold, no color override (default black). The built-in style NAMES
 * ("heading 1" … lowercase, with a space) are what make Word treat
 * these as real headings for navigation and TOCs — the pStyle ids stay
 * "Heading1"…, matching the reference documents Word itself writes.
 */
const STYLES_XML = [
  XML_DECL,
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  "<w:docDefaults>",
  "<w:rPrDefault><w:rPr>",
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>',
  '<w:sz w:val="22"/><w:szCs w:val="22"/>',
  "</w:rPr></w:rPrDefault>",
  "<w:pPrDefault><w:pPr>",
  '<w:spacing w:after="160" w:line="276" w:lineRule="auto"/>',
  "</w:pPr></w:pPrDefault>",
  "</w:docDefaults>",
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
  '<w:name w:val="Normal"/><w:qFormat/>',
  "</w:style>",
  '<w:style w:type="paragraph" w:styleId="Title">',
  '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>',
  '<w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>',
  '<w:rPr><w:b/><w:bCs/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>',
  "</w:style>",
  '<w:style w:type="paragraph" w:styleId="Heading1">',
  '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>',
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="80"/></w:pPr>',
  '<w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>',
  "</w:style>",
  '<w:style w:type="paragraph" w:styleId="Heading2">',
  '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>',
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60"/></w:pPr>',
  '<w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>',
  "</w:style>",
  '<w:style w:type="paragraph" w:styleId="Heading3">',
  '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>',
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="40"/></w:pPr>',
  '<w:rPr><w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>',
  "</w:style>",
  '<w:style w:type="paragraph" w:styleId="ListParagraph">',
  '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>',
  '<w:pPr><w:ind w:left="720"/></w:pPr>',
  "</w:style>",
  "</w:styles>",
  "",
].join("\n");

/* ------------------------------------------------------------------ */
/* The package (ZIP)                                                   */
/* ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/**
 * Word blocks → the .docx package bytes (fflate zipSync, the same
 * library and level the app's multi-output ZIP button uses). Filenames
 * are all ASCII so no ZIP name flags are needed; parts are UTF-8 XML.
 */
export function buildDocxBytes(blocks: WordBlock[]): Uint8Array {
  const entries: Zippable = {
    "[Content_Types].xml": utf8.encode(CONTENT_TYPES_XML),
    "_rels/.rels": utf8.encode(ROOT_RELS_XML),
    "word/document.xml": utf8.encode(blocksToDocumentXml(blocks)),
    "word/_rels/document.xml.rels": utf8.encode(DOC_RELS_XML),
    "word/styles.xml": utf8.encode(STYLES_XML),
  };
  return zipSync(entries, { level: 6 });
}

/** All pages' lines → .docx bytes in one call (extraction happened already). */
export function buildDocx(pages: MdLine[][]): Uint8Array {
  return buildDocxBytes(pagesToWordBlocks(pages));
}
