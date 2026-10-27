import { zipSync, type Zippable } from "fflate";

import type { ExtractedDoc, ExtractedParagraph } from "./extract";

/**
 * ODT emitter (Task b5-c) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * An .odt (OpenDocument Text) is a ZIP whose parts are XML documents.
 * This module emits the minimal VALID ODF package:
 *
 *   mimetype            — "application/vnd.oasis.opendocument.text",
 *                        FIRST and STORED (level 0) — the ODF spec
 *                        requirement (and what our own odt-to-pdf
 *                        reader verifies when it round-trips us)
 *   META-INF/manifest.xml — file-entry for /, content.xml, styles.xml,
 *                        meta.xml
 *   content.xml         — office:document-content → office:body →
 *                        office:text; headings as text:h with
 *                        text:outline-level 1-2, paragraphs as text:p,
 *                        styled runs as text:span pointing at the
 *                        automatic text styles (bold/italic/bold-italic)
 *                        declared in office:automatic-styles
 *   styles.xml          — Standard + named Heading_20_1/Heading_20_2
 *                        paragraph styles (outline levels + bold +
 *                        16pt/13pt sizes, LibreOffice's own ladder)
 *   meta.xml            — dc:title
 *
 * ROUND-TRIP CONTRACT: the output must parse back through OUR
 * parseOdtBytes (tools/odt-to-pdf/odt-parse) recovering every
 * paragraph text, run flag and heading level — that is smoke oracle #1.
 *
 * SECURITY (the docx-emit lesson): every piece of user text goes
 * through escapeXml() — & first so nothing double-escapes — and
 * characters invalid in XML 1.0 are stripped. Output is UTF-8,
 * Devanagari passes through verbatim.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — split/join only.
 */

export const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";

/* ------------------------------------------------------------------ */
/* Escaping (CRITICAL — user content goes into XML)                    */
/* ------------------------------------------------------------------ */

/**
 * XML text escaping. `&` first so nothing double-escapes; split/join
 * (not replaceAll) per the iOS-compat rule. The five XML 1.0
 * predefined entities cover everything a quirky PDF can inject.
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
 * Removes characters invalid in XML 1.0 (C0 controls except \t \n \r,
 * plus DEL) — they would make LibreOffice reject the file.
 */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Sanitizes + escapes one text payload. */
function xmlText(text: string): string {
  return escapeXml(stripInvalidXmlChars(text));
}

/* ------------------------------------------------------------------ */
/* content.xml                                                          */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Automatic text styles referenced by text:span runs. */
const AUTO_STYLES_XML = [
  "<office:automatic-styles>",
  '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
  '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>',
  '<style:style style:name="T3" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>',
  "</office:automatic-styles>",
].join("\n");

/** text:span style for a run's flags, or "" for a plain (bare) run. */
function spanStyleName(run: { bold: boolean; italic: boolean }): string {
  if (run.bold && run.italic) return "T3";
  if (run.bold) return "T1";
  if (run.italic) return "T2";
  return "";
}

/** One paragraph's runs → its XML children (text:span or bare text). */
function paragraphRunXml(paragraph: ExtractedParagraph): string {
  const parts: string[] = [];
  for (const run of paragraph.runs) {
    if (run.text.length === 0) continue;
    const style = spanStyleName(run);
    parts.push(
      style === ""
        ? xmlText(run.text)
        : `<text:span text:style-name="${style}">${xmlText(run.text)}</text:span>`
    );
  }
  return parts.join("");
}

/** One paragraph → text:h (with outline level) or text:p. */
export function paragraphXml(paragraph: ExtractedParagraph): string {
  const body = paragraphRunXml(paragraph);
  if (paragraph.heading !== undefined) {
    // Open formats carry a 2-level heading ladder; deeper levels clamp
    // (defense in depth — extract.ts clamps too, direct callers may not).
    const level = Math.min(2, Math.max(1, paragraph.heading));
    const style = level === 1 ? "Heading_20_1" : "Heading_20_2";
    return `<text:h text:style-name="${style}" text:outline-level="${level}">${body}</text:h>`;
  }
  return `<text:p>${body}</text:p>`;
}

/** The whole document → content.xml. */
export function buildContentXml(doc: ExtractedDoc): string {
  const paragraphs: string[] = [];
  for (const page of doc.pages) {
    for (const paragraph of page.paragraphs) {
      if (
        paragraph.runs.map((run) => run.text).join("").trim().length === 0
      ) {
        continue;
      }
      paragraphs.push(paragraphXml(paragraph));
    }
  }
  return [
    XML_DECL,
    '<office:document-content office:version="1.2" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">',
    AUTO_STYLES_XML,
    "<office:body>",
    "<office:text>",
    paragraphs.join("\n"),
    "</office:text>",
    "</office:body>",
    "</office:document-content>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* styles.xml                                                          */
/* ------------------------------------------------------------------ */

/**
 * Standard + the two named heading styles LibreOffice itself writes
 * (style:class="heading", outline levels, bold, 16pt/13pt — the ladder
 * our odt-to-pdf reader renders when styles.xml declares them).
 */
export function buildStylesXml(): string {
  return [
    XML_DECL,
    '<office:document-styles office:version="1.2" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">',
    "<office:styles>",
    '<style:style style:name="Standard" style:family="paragraph"/>',
    '<style:style style:name="Heading_20_1" style:family="paragraph" style:class="heading">',
    '<style:paragraph-properties text:outline-level="1" fo:margin-top="0.2in" fo:margin-bottom="0.08in"/>',
    '<style:text-properties fo:font-size="16pt" fo:font-weight="bold"/>',
    "</style:style>",
    '<style:style style:name="Heading_20_2" style:family="paragraph" style:class="heading">',
    '<style:paragraph-properties text:outline-level="2" fo:margin-top="0.17in" fo:margin-bottom="0.07in"/>',
    '<style:text-properties fo:font-size="13pt" fo:font-weight="bold"/>',
    "</style:style>",
    "</office:styles>",
    "</office:document-styles>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* meta.xml + manifest                                                 */
/* ------------------------------------------------------------------ */

export function buildMetaXml(title: string): string {
  return [
    XML_DECL,
    '<office:document-meta office:version="1.2" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<office:meta>",
    `<dc:title>${xmlText(title)}</dc:title>`,
    "</office:meta>",
    "</office:document-meta>",
    "",
  ].join("\n");
}

export function buildManifestXml(): string {
  return [
    XML_DECL,
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">',
    ` <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIMETYPE}"/>`,
    ' <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    ' <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    ' <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    "</manifest:manifest>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The package (ZIP)                                                   */
/* ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/**
 * The extracted document → the .odt package bytes.
 *
 * The ODF spec requirement our own reader (and LibreOffice) checks:
 * the mimetype part is the FIRST zip entry and it is STORED (level 0)
 * so the magic is readable without inflating. Everything else deflates
 * at level 6 (the app's ZIP button level).
 */
export function emitOdt(doc: ExtractedDoc, title: string): Uint8Array {
  const safeTitle =
    title.trim().length > 0 ? title.trim().slice(0, 120) : "Converted document";
  const entries: Zippable = {
    mimetype: [utf8.encode(ODT_MIMETYPE), { level: 0 }],
    "META-INF/manifest.xml": utf8.encode(buildManifestXml()),
    "content.xml": utf8.encode(buildContentXml(doc)),
    "styles.xml": utf8.encode(buildStylesXml()),
    "meta.xml": utf8.encode(buildMetaXml(safeTitle)),
  };
  return zipSync(entries, { level: 6 });
}
