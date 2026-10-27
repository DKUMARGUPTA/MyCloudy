import { zipSync, type Zippable } from "fflate";

import type { ExtractedDoc, ExtractedPage } from "./extract";
import { escapeXml, stripInvalidXmlChars } from "./odt-emit";

/**
 * EPUB 3 emitter (Task b5-c) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * An .epub is a ZIP (an OCF container) around one OPF package. This
 * module emits the minimal VALID EPUB 3 structure:
 *
 *   mimetype                 — "application/epub+zip", FIRST and STORED
 *                              (level 0 — the OCF spec requirement,
 *                              the same rule as ODF's mimetype part)
 *   META-INF/container.xml   — points at OEBPS/content.opf
 *   OEBPS/content.opf        — package/version 3.0: metadata (dc:title,
 *                              dc:language, a deterministic
 *                              dc:identifier, the mandatory
 *                              dcterms:modified), manifest (nav +
 *                              every chapter) and a spine covering
 *                              every chapter
 *   OEBPS/nav.xhtml         — the EPUB 3 navigation document
 *                              (epub:type="toc") listing the chapters
 *   OEBPS/chapter-N.xhtml    — one XHTML content document per PDF
 *                              page: body of <p> elements with
 *                              xhtml-escaped text (headings flatten
 *                              to paragraphs — the honest v1)
 *
 * Structural validity is the contract (the epub-to-pdf round-trip is a
 * separate sibling's job): zip entry order, the stored mimetype, a
 * well-formed container.xml, every manifest id referenced by the
 * spine, and chapter text that survives entity unescaping.
 *
 * SECURITY: user text goes through the SAME escapeXml /
 * stripInvalidXmlChars pair as the ODT emitter (& first, no
 * double-escape, no raw <script in any part).
 *
 * iOS-safe (worklog IOS-COMPAT): split/join only, no matchAll /
 * replaceAll, no lookbehind, no Object.hasOwn / structuredClone.
 */

export const EPUB_MIMETYPE = "application/epub+zip";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Deterministic dcterms:modified (fixed epoch — byte-stable output). */
const DCTERMS_MODIFIED = "2020-01-01T00:00:00Z";

function xmlText(text: string): string {
  return escapeXml(stripInvalidXmlChars(text));
}

/* ------------------------------------------------------------------ */
/* Language + deterministic identifier                                  */
/* ------------------------------------------------------------------ */

/** True when any character is Devanagari (Hindi, Marathi…). */
export function containsDevanagari(doc: ExtractedDoc): boolean {
  for (const page of doc.pages) {
    for (const paragraph of page.paragraphs) {
      for (const run of paragraph.runs) {
        for (let i = 0; i < run.text.length; i += 1) {
          const cp = run.text.charCodeAt(i);
          if (cp >= 0x0900 && cp <= 0x097f) return true;
        }
      }
    }
  }
  return false;
}

/** FNV-1a 32-bit (Math.imul keeps the multiply exact in JS). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Deterministic dc:identifier: same document + title → same urn, run
 * after run (the byte-determinism lesson from the powerpoint smoke).
 */
export function epubIdentifier(doc: ExtractedDoc, title: string): string {
  let chapters = 0;
  let paragraphs = 0;
  for (const page of doc.pages) {
    if (page.paragraphs.length > 0) chapters += 1;
    paragraphs += page.paragraphs.length;
  }
  const seed = `${title}|${chapters}|${paragraphs}|${doc.pages.length}`;
  return `urn:mycloudy:epub:${fnv1a(seed)}`;
}

/* ------------------------------------------------------------------ */
/* The parts                                                           */
/* ------------------------------------------------------------------ */

export function buildContainerXml(): string {
  return [
    XML_DECL,
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    "<rootfiles>",
    ' <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    "</rootfiles>",
    "</container>",
    "",
  ].join("\n");
}

/** Pages that carry any paragraph become chapters (empty pages skip). */
function chapterPages(doc: ExtractedDoc): ExtractedPage[] {
  return doc.pages.filter(
    (page) =>
      page.paragraphs.filter((paragraph) =>
        paragraph.runs.some((run) => run.text.trim().length > 0)
      ).length > 0
  );
}

/** The whole doc → OEBPS/content.opf. */
export function buildOpfXml(
  doc: ExtractedDoc,
  title: string,
  language: string,
  identifier: string
): string {
  const chapters = chapterPages(doc);
  const manifest: string[] = [
    '  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  ];
  const spine: string[] = [];
  for (let i = 0; i < chapters.length; i += 1) {
    manifest.push(
      `  <item id="ch${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    );
    spine.push(`  <itemref idref="ch${i + 1}"/>`);
  }
  return [
    XML_DECL,
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `  <dc:identifier id="pub-id">${xmlText(identifier)}</dc:identifier>`,
    `  <dc:title>${xmlText(title)}</dc:title>`,
    `  <dc:language>${xmlText(language)}</dc:language>`,
    `  <meta property="dcterms:modified">${DCTERMS_MODIFIED}</meta>`,
    "</metadata>",
    "<manifest>",
    ...manifest,
    "</manifest>",
    "<spine>",
    ...spine,
    "</spine>",
    "</package>",
    "",
  ].join("\n");
}

/** The whole doc → OEBPS/nav.xhtml (the EPUB 3 TOC document). */
export function buildNavXml(doc: ExtractedDoc, title: string): string {
  const chapters = chapterPages(doc);
  const items: string[] = [];
  for (let i = 0; i < chapters.length; i += 1) {
    items.push(
      `   <li><a href="chapter-${i + 1}.xhtml">Chapter ${i + 1}</a></li>`
    );
  }
  return [
    XML_DECL,
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
    "<head>",
    `  <title>${xmlText(title)}</title>`,
    "</head>",
    "<body>",
    ' <nav epub:type="toc">',
    `  <h1>${xmlText(title)}</h1>`,
    "  <ol>",
    ...items,
    "  </ol>",
    " </nav>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** One page → its chapter XHTML body paragraphs. */
function chapterParagraphXml(page: ExtractedPage): string[] {
  const parts: string[] = [];
  for (const paragraph of page.paragraphs) {
    const text = paragraph.runs
      .map((run) => run.text)
      .join("")
      .trim();
    if (text.length === 0) continue;
    parts.push(`  <p>${xmlText(text)}</p>`);
  }
  return parts;
}

/** One page → its OEBPS/chapter-N.xhtml. */
export function buildChapterXml(page: ExtractedPage, index: number): string {
  return [
    XML_DECL,
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    `  <title>Chapter ${index}</title>`,
    "</head>",
    "<body>",
    ...chapterParagraphXml(page),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The package (ZIP)                                                   */
/* ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/**
 * The extracted document → the .epub package bytes. mimetype is the
 * FIRST entry and STORED (level 0, the OCF rule); every other part
 * deflates at level 6. The output is byte-deterministic for the same
 * doc + title (fixed dcterms:modified + hashed identifier).
 */
export function emitEpub(doc: ExtractedDoc, title: string): Uint8Array {
  const safeTitle =
    title.trim().length > 0 ? title.trim().slice(0, 120) : "Converted document";
  const language = containsDevanagari(doc) ? "hi" : "en";
  const identifier = epubIdentifier(doc, safeTitle);
  const chapters = chapterPages(doc);

  const entries: Zippable = {
    mimetype: [utf8.encode(EPUB_MIMETYPE), { level: 0 }],
    "META-INF/container.xml": utf8.encode(buildContainerXml()),
    "OEBPS/content.opf": utf8.encode(
      buildOpfXml(doc, safeTitle, language, identifier)
    ),
    "OEBPS/nav.xhtml": utf8.encode(buildNavXml(doc, safeTitle)),
  };
  for (let i = 0; i < chapters.length; i += 1) {
    entries[`OEBPS/chapter-${i + 1}.xhtml`] = utf8.encode(
      buildChapterXml(chapters[i] as ExtractedPage, i + 1)
    );
  }
  return zipSync(entries, { level: 6 });
}
