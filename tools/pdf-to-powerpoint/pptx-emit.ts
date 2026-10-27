import { zipSync, type Zippable } from "fflate";

/**
 * PDF → PPTX engine (Task b3-b) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * A .pptx is a PresentationML package: a ZIP container whose parts are
 * XML documents plus the embedded JPEGs. This module emits the minimal
 * VALID part set for a deck of full-bleed page images (the honest v1:
 * real per-page text boxes need text positioning fidelity we can't
 * promise — each slide carries the rendered page as one picture):
 *
 *   [Content_Types].xml                    — content types for every part
 *   _rels/.rels                            — package → ppt/presentation.xml
 *   ppt/presentation.xml                   — slide list + sldSz from the
 *                                           FIRST page's point size (EMU:
 *                                           1pt = 12700 EMU), notesSz
 *   ppt/_rels/presentation.xml.rels        — master + every slide
 *   ppt/slideMasters/slideMaster1.xml      — white background, colour
 *                                           map, layout list (blank master)
 *   ppt/slideMasters/_rels/…               — master → layout + theme
 *   ppt/slideLayouts/slideLayout1.xml      — a blank layout (no
 *                                           placeholders — slides carry
 *                                           only the page picture)
 *   ppt/slideLayouts/_rels/…               — layout → master
 *   ppt/theme/theme1.xml                   — minimal complete theme
 *                                           (clr/font/fmt schemes —
 *                                           PowerPoint's strict master
 *                                           relationship expects it)
 *   ppt/slides/slideN.xml                  — one <p:pic> at off 0,0 with
 *                                           ext = the page's EMU size,
 *                                           blipFill r:embed rId1
 *   ppt/slides/_rels/slideN.xml.rels       — slide → ../media/imageN.jpg
 *   ppt/media/imageN.jpg                   — the rendered page JPEG
 *
 * Sizes: the EMU (English Metric Unit) is 1/914400 inch = 1/12700 pt;
 * every page's visible point size (pdf.js viewport at scale 1) maps to
 * the slide picture's extent, so the picture is full-bleed and the
 * pixel raster underneath (rendered at the chosen DPI) just adds
 * sharpness. The presentation-level sldSz follows the FIRST page —
 * later pages with a different aspect keep their own extents (PowerPoint
 * simply shows them larger/smaller than the slide box).
 *
 * SECURITY (the docx-emit/html-emit lesson, same rigor): the only user
 * content in any part is the source file name inside a cNvPr descr
 * attribute — it goes through escapeXml() (& < > " ', & FIRST, no
 * double-escape) after stripInvalidXmlChars(). Output is UTF-8
 * (TextEncoder); ASCII part names need no ZIP name flags.
 *
 * iOS-safe (worklog IOS-COMPAT): no String.prototype.matchAll /
 * replaceAll, no regex lookbehind, no Object.hasOwn / structuredClone —
 * split/join and plain exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One slide's payload: the rendered page JPEG + its point size. */
export interface PptxPageImage {
  /** JPEG bytes (SOI…EOI) — embedded verbatim as ppt/media/imageN.jpg. */
  jpeg: Uint8Array;
  /** Visible page width in PDF points (pdf.js viewport at scale 1). */
  widthPt: number;
  /** Visible page height in PDF points. */
  heightPt: number;
}

/** Optional package metadata (the source file name for descr). */
export interface PptxBuildMeta {
  sourceName?: string;
}

/** Resolved tool options (the worker consumes OptionValues). */
export interface PptxOutOptions {
  dpi: number;
  quality: number;
  pages: string;
}

/* ------------------------------------------------------------------ */
/* EMU math (1pt = 12700 EMU — ECMA-376 Part 1 §20.1.3)                */
/* ------------------------------------------------------------------ */

/** Points → EMU, rounded to the nearest integer (never fractional). */
export function ptToEmu(pt: number): number {
  return Math.round(pt * 12700);
}

/* ------------------------------------------------------------------ */
/* Escaping (CRITICAL — user content goes into XML attributes)         */
/* ------------------------------------------------------------------ */

/**
 * XML text/attribute escaping. `&` first so nothing double-escapes;
 * split/join (not replaceAll) per the iOS-compat rule. Attribute
 * values need " and ' escaped as well as text nodes need < > &.
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
 * except \t \n \r, plus DEL) — they would make PowerPoint reject the
 * file ("needs repair").
 */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/* ------------------------------------------------------------------ */
/* Namespaces + shared fragments                                       */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_PKG_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";

/** Relationship types used by this package (rId order documented below). */
const REL = {
  officeDocument: `${NS_R}/officeDocument`,
  slideMaster: `${NS_R}/slideMaster`,
  slideLayout: `${NS_R}/slideLayout`,
  slide: `${NS_R}/slide`,
  theme: `${NS_R}/theme`,
  image: `${NS_R}/image`,
} as const;

/** Content types used by this package. */
const CT = {
  presentation:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  slideMaster:
    "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  slideLayout:
    "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
} as const;

/** The empty group-shape properties every spTree starts with. */
const SPTREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** Root element attributes with all three namespaces (slide-family parts). */
function rootAttrs(): string {
  return `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
}

/* ------------------------------------------------------------------ */
/* [Content_Types].xml                                                 */
/* ------------------------------------------------------------------ */

/**
 * Defaults for rels/xml/jpg (media are .jpg), Overrides for the
 * presentation, master, layout, theme and every slide.
 */
export function contentTypesXml(slideCount: number): string {
  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT.presentation}"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT.slideMaster}"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT.slideLayout}"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT.theme}"/>`,
  ];
  for (let i = 1; i <= slideCount; i += 1) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="${CT.slide}"/>`
    );
  }
  return [
    XML_DECL,
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    overrides.join(""),
    "</Types>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* _rels/.rels + presentation                                          */
/* ------------------------------------------------------------------ */

/** Package-level: the one officeDocument relationship. */
const ROOT_RELS_XML = [
  XML_DECL,
  `<Relationships xmlns="${NS_PKG_REL}">`,
  `<Relationship Id="rId1" Type="${REL.officeDocument}" Target="ppt/presentation.xml"/>`,
  "</Relationships>",
  "",
].join("\n");

/**
 * ppt/presentation.xml — master id 2147483648 (0x80000000, PowerPoint's
 * own convention), slide ids from 256, sldSz from the FIRST page in EMU,
 * the standard 7.5×10in portrait notesSz.
 */
export function presentationXml(
  slideCount: number,
  slideW: number,
  slideH: number
): string {
  const slideIds: string[] = [];
  for (let i = 1; i <= slideCount; i += 1) {
    slideIds.push(`<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`);
  }
  return [
    XML_DECL,
    `<p:presentation ${rootAttrs()}>`,
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
    `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>`,
    `<p:sldSz cx="${slideW}" cy="${slideH}"/>`,
    '<p:notesSz cx="6858000" cy="9144000"/>',
    "</p:presentation>",
    "",
  ].join("\n");
}

/** rId1 → master, rId2… → the slides (the ids presentation.xml uses). */
export function presentationRelsXml(slideCount: number): string {
  const rels: string[] = [
    `<Relationship Id="rId1" Type="${REL.slideMaster}" Target="slideMasters/slideMaster1.xml"/>`,
  ];
  for (let i = 1; i <= slideCount; i += 1) {
    rels.push(
      `<Relationship Id="rId${i + 1}" Type="${REL.slide}" Target="slides/slide${i}.xml"/>`
    );
  }
  return [
    XML_DECL,
    `<Relationships xmlns="${NS_PKG_REL}">`,
    rels.join(""),
    "</Relationships>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Slides                                                              */
/* ------------------------------------------------------------------ */

/**
 * One slide: the single full-bleed <p:pic> of the rendered page.
 * off is 0,0 and ext is the page's own EMU size (so a page whose
 * aspect differs from sldSz still renders at true page proportions).
 * The source file name rides along in the picture's descr attribute —
 * escaped (the only user content in the package).
 */
export function slideXml(
  page: PptxPageImage,
  pageNumber: number,
  sourceName?: string
): string {
  const cx = ptToEmu(page.widthPt);
  const cy = ptToEmu(page.heightPt);
  const name = `Page ${pageNumber}`;
  const descr =
    sourceName === undefined || sourceName.length === 0
      ? name
      : `Page ${pageNumber} of ${sourceName}`;
  return [
    XML_DECL,
    `<p:sld ${rootAttrs()}>`,
    "<p:cSld><p:spTree>",
    SPTREE_HEAD,
    "<p:pic><p:nvPicPr>",
    `<p:cNvPr id="2" name="${escapeXml(name)}" descr="${escapeXml(
      stripInvalidXmlChars(descr)
    )}"/>`,
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>',
    "<p:nvPr/></p:nvPicPr>",
    '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>',
    "<p:spPr>",
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    "</p:spPr></p:pic>",
    "</p:spTree></p:cSld>",
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
    "</p:sld>",
    "",
  ].join("\n");
}

/** slideN.xml.rels — the picture relationship to this slide's media. */
export function slideRelsXml(imageNumber: number): string {
  return [
    XML_DECL,
    `<Relationships xmlns="${NS_PKG_REL}">`,
    `<Relationship Id="rId1" Type="${REL.image}" Target="../media/image${imageNumber}.jpg"/>`,
    "</Relationships>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Slide layout (blank) + slide master + theme                         */
/* ------------------------------------------------------------------ */

/** A blank layout: no placeholders — slides carry only page pictures. */
export const SLIDE_LAYOUT_XML = [
  XML_DECL,
  `<p:sldLayout ${rootAttrs()} type="blank" preserve="1">`,
  '<p:cSld name="Blank"><p:spTree>',
  SPTREE_HEAD,
  "</p:spTree></p:cSld>",
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
  "</p:sldLayout>",
  "",
].join("\n");

export const SLIDE_LAYOUT_RELS_XML = [
  XML_DECL,
  `<Relationships xmlns="${NS_PKG_REL}">`,
  `<Relationship Id="rId1" Type="${REL.slideMaster}" Target="../slideMasters/slideMaster1.xml"/>`,
  "</Relationships>",
  "",
].join("\n");

/**
 * A blank master: white background, the standard colour map, and the
 * layout list pointing at the blank layout (rId1 — same id the rels
 * below assign). No placeholder shapes: our slides never inherit text.
 */
export const SLIDE_MASTER_XML = [
  XML_DECL,
  `<p:sldMaster ${rootAttrs()}>`,
  "<p:cSld>",
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
  "<p:spTree>",
  SPTREE_HEAD,
  "</p:spTree>",
  "</p:cSld>",
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>',
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>',
  "</p:sldMaster>",
  "",
].join("\n");

/** rId1 → the blank layout, rId2 → the theme. */
export const SLIDE_MASTER_RELS_XML = [
  XML_DECL,
  `<Relationships xmlns="${NS_PKG_REL}">`,
  `<Relationship Id="rId1" Type="${REL.slideLayout}" Target="../slideLayouts/slideLayout1.xml"/>`,
  `<Relationship Id="rId2" Type="${REL.theme}" Target="../theme/theme1.xml"/>`,
  "</Relationships>",
  "",
].join("\n");

/**
 * A minimal but complete theme (DrawingML CT_BaseStyles): the clrScheme
 * (dk1/lt1/dk2/lt2 + 6 accents + hlink/folHlink — every slot the
 * master's clrMap names), a fontScheme with major/minor typefaces, and
 * a fmtScheme with the required 3-entry fill/line/effect/bgFill lists.
 * PowerPoint's strict master→theme relationship expects this part.
 */
export const THEME_XML = [
  XML_DECL,
  `<a:theme xmlns:a="${NS_A}" name="MyCloudy">`,
  "<a:themeElements>",
  '<a:clrScheme name="MyCloudy">',
  '<a:dk1><a:srgbClr val="000000"/></a:dk1>',
  '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>',
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2>',
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>',
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>',
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>',
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>',
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>',
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>',
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>',
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>',
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>',
  "</a:clrScheme>",
  '<a:fontScheme name="MyCloudy">',
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>',
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>',
  "</a:fontScheme>",
  '<a:fmtScheme name="MyCloudy">',
  "<a:fillStyleLst>",
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  "</a:fillStyleLst>",
  "<a:lnStyleLst>",
  '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  "</a:lnStyleLst>",
  "<a:effectStyleLst>",
  "<a:effectStyle><a:effectLst/></a:effectStyle>",
  "<a:effectStyle><a:effectLst/></a:effectStyle>",
  "<a:effectStyle><a:effectLst/></a:effectStyle>",
  "</a:effectStyleLst>",
  "<a:bgFillStyleLst>",
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  "</a:bgFillStyleLst>",
  "</a:fmtScheme>",
  "</a:themeElements>",
  "</a:theme>",
  "",
].join("\n");

/* ------------------------------------------------------------------ */
/* The package (ZIP)                                                   */
/* ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/** PowerPoint's widescreen default (13.333×7.5in) for the empty edge. */
const DEFAULT_SLIDE_EMU = { cx: 12192000, cy: 6858000 };

/**
 * Page images → the .pptx package bytes (fflate zipSync, level 6 — the
 * same library and level the app's multi-output ZIP button uses).
 *
 * rId map (fixed, matches the XML above): package rId1=presentation;
 * presentation rId1=master, rId2…=slides in order; slide rId1=its own
 * imageN.jpg; master rId1=layout + rId2=theme; layout rId1=master.
 */
export function buildPptxBytes(
  pages: PptxPageImage[],
  meta?: PptxBuildMeta
): Uint8Array {
  const slideW =
    pages.length > 0 ? ptToEmu(pages[0].widthPt) : DEFAULT_SLIDE_EMU.cx;
  const slideH =
    pages.length > 0 ? ptToEmu(pages[0].heightPt) : DEFAULT_SLIDE_EMU.cy;

  const entries: Zippable = {
    "[Content_Types].xml": utf8.encode(contentTypesXml(pages.length)),
    "_rels/.rels": utf8.encode(ROOT_RELS_XML),
    "ppt/presentation.xml": utf8.encode(
      presentationXml(pages.length, slideW, slideH)
    ),
    "ppt/_rels/presentation.xml.rels": utf8.encode(
      presentationRelsXml(pages.length)
    ),
    "ppt/slideMasters/slideMaster1.xml": utf8.encode(SLIDE_MASTER_XML),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": utf8.encode(
      SLIDE_MASTER_RELS_XML
    ),
    "ppt/slideLayouts/slideLayout1.xml": utf8.encode(SLIDE_LAYOUT_XML),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": utf8.encode(
      SLIDE_LAYOUT_RELS_XML
    ),
    "ppt/theme/theme1.xml": utf8.encode(THEME_XML),
  };
  for (let i = 0; i < pages.length; i += 1) {
    entries[`ppt/slides/slide${i + 1}.xml`] = utf8.encode(
      slideXml(pages[i], i + 1, meta?.sourceName)
    );
    entries[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = utf8.encode(
      slideRelsXml(i + 1)
    );
    entries[`ppt/media/image${i + 1}.jpg`] = pages[i].jpeg;
  }
  return zipSync(entries, { level: 6 });
}
