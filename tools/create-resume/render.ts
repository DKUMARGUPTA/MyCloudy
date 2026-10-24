/**
 * Create resume PDF renderer (CR-66) — the vector page painter.
 *
 * Extracted so the worker (and any future smoke script) can drive the
 * EXACT drawing code headless in bun: same geometry constants, same
 * wrapText, same pagination as the surface's estimatePageBreaks model.
 *
 * Templates:
 *  - classic — pure ATS: single column, Helvetica (base-14, NOT
 *    embedded) or the self-hosted Noto when any text is Devanagari,
 *    name 22 pt, section titles 11 pt CAPS over a hairline rule, no
 *    colours except near-black.
 *  - modern — accent rail on the left (~34% of the page width, full-
 *    bleed) carrying the photo + name + contact + skills; main column
 *    to the right with uppercase, letter-spaced (real PDF Tc operator)
 *    section headings.
 *  - compact — dense: 9.5 pt body, tighter leading, two-column skills
 *    block, thin accent rules, 2-page friendly.
 *
 * ATS contract: every glyph is REAL selectable text (drawText), bullets
 * are "• " text lines, no icons, no images-as-text. Letter-spacing is
 * only used by Modern's headings and only via the PDF text-state Tc
 * operator — the string stays one contiguous literal, so copy/search
 * still yields "EXPERIENCE", never "E X P E R I E N C E".
 * Photo is optional and only ever an image XObject.
 *
 * Fonts: pure-WinAnsi content → Helvetica/HelveticaBold (embedStandardFont
 * — zero bytes embedded, base-14). ANY non-WinAnsi char → the caller
 * passes the embedded Noto Sans Devanagari as `font` (fontkit subset),
 * boldFont null (the OFL face ships Regular only — hierarchy comes from
 * size and rules instead of synthetic bold, which keeps text extraction
 * single-copy for ATS).
 *
 * pdf-lib embeds are ASYNC — every embedJpg/embedPng is awaited (the
 * pinned INVOICE-LOGO-FIX lesson).
 */

import type { PDFDocument, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import {
  beginText,
  endText,
  moveText,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setFillingColor,
  setFontAndSize,
  showText,
  type RGB,
} from "pdf-lib";

import {
  atsBulletLine,
  atsContactLine,
  formatDateRange,
  geometryFor,
  HEADING_TRACK_RATIO,
  joinMeta,
  splitTwoColumns,
  wrapText,
  type ResumeGeometry,
} from "./model";
import type { ResumeRun, ResumeSection } from "./types";

/* ------------------------------------------------------------------ */
/* Palette                                                              */
/* ------------------------------------------------------------------ */

const COL_TEXT: RGB = rgb(0.08, 0.08, 0.08);
const COL_MUTED: RGB = rgb(0.33, 0.33, 0.33);
const COL_RULE: RGB = rgb(0.72, 0.72, 0.72);
const COL_FOOTER: RGB = rgb(0.45, 0.45, 0.45);
const COL_WHITE: RGB = rgb(1, 1, 1);

function hexColor(s: string): RGB {
  const n = Number.parseInt(s.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Perceived luminance of the accent → readable sidebar ink. */
function inkOn(bg: RGB): RGB {
  const l = 0.299 * bg.red + 0.587 * bg.green + 0.114 * bg.blue;
  return l > 0.6 ? COL_TEXT : COL_WHITE;
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || comma < 0) return null;
  try {
    const b64 = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(b64.length);
    for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Awaited photo embed — never throws (a broken photo skips, export lives). */
async function embedPhoto(
  pdfDoc: PDFDocument,
  dataUrl: string
): Promise<PDFImage | null> {
  const bytes = dataUrlBytes(dataUrl);
  if (!bytes) return null;
  try {
    if (/^data:image\/png/i.test(dataUrl)) {
      return await pdfDoc.embedPng(bytes);
    }
    return await pdfDoc.embedJpg(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Painter — page flow + text helpers                                   */
/* ------------------------------------------------------------------ */

interface TextOpts {
  bold?: boolean;
  color?: RGB;
  right?: number;
  center?: [number, number];
}

class Painter {
  readonly pdfDoc: PDFDocument;
  readonly font: PDFFont;
  readonly bold: PDFFont | null;
  readonly geo: ResumeGeometry;
  readonly run: ResumeRun;
  readonly accent: RGB;
  /** modern only — section headings draw with real Tc letter-spacing. */
  readonly tracked: boolean;
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  /** modern only — drawn on every new page (full-bleed rail). */
  chrome: ((page: PDFPage) => void) | null = null;

  constructor(
    pdfDoc: PDFDocument,
    font: PDFFont,
    bold: PDFFont | null,
    run: ResumeRun,
    accentHex: string
  ) {
    this.pdfDoc = pdfDoc;
    this.font = font;
    this.bold = bold;
    this.run = run;
    this.geo = geometryFor(run.d.template, run.d.pageSize);
    this.accent = hexColor(accentHex);
    this.tracked = run.d.template === "modern";
    this.newPage();
  }

  label(key: string, fallback: string): string {
    return this.run.labels[key] ?? fallback;
  }

  fontFor(bold: boolean): PDFFont {
    return bold && this.bold ? this.bold : this.font;
  }

  w(s: string, size: number, bold = false): number {
    return this.fontFor(bold).widthOfTextAtSize(s, size);
  }

  wrap(text: string, width: number, size: number, bold = false): string[] {
    const out: string[] = [];
    for (const para of wrapText(text, width, size, (t, sz, b) =>
      this.w(t, sz, b === true)
    )) {
      out.push(para);
    }
    return out.length ? out : [""];
  }

  newPage(): PDFPage {
    this.page = this.pdfDoc.addPage([this.geo.pageW, this.geo.pageH]);
    this.pages.push(this.page);
    this.y = this.geo.pageH - this.geo.margin;
    if (this.chrome) this.chrome(this.page);
    return this.page;
  }

  /** Page-break unless `need` points fit above the footer zone. */
  ensure(need: number): void {
    if (this.y - need < this.geo.bottom) this.newPage();
  }

  /** top-aligned like the DOM (baseline = yTop − size). */
  text(s: string, x: number, yTop: number, size: number, opts: TextOpts = {}): void {
    if (!s) return;
    const color = opts.color ?? COL_TEXT;
    let tx = x;
    if (opts.right !== undefined) tx = opts.right - this.w(s, size, opts.bold === true);
    if (opts.center) {
      const [l, r] = opts.center;
      tx = (l + r - this.w(s, size, opts.bold === true)) / 2;
    }
    this.page.drawText(s, {
      x: tx,
      y: yTop - size,
      size,
      font: this.fontFor(opts.bold === true),
      color,
    });
  }

  line(x1: number, y: number, x2: number, color: RGB, width: number): void {
    this.page.drawLine({
      start: { x: x1, y },
      end: { x: x2, y },
      thickness: width,
      color,
    });
  }

  /**
   * Letter-spaced text via the PDF text-state Tc operator (modern's
   * headings): one contiguous Tj literal — extractors read the whole
   * word, the renderer adds `tracking` pt after every glyph.
   */
  trackText(
    s: string,
    x: number,
    yTop: number,
    size: number,
    color: RGB,
    bold = false
  ): void {
    this.trackTextOn(this.page, s, x, yTop, size, color, bold);
  }

  trackTextOn(
    page: PDFPage,
    s: string,
    x: number,
    yTop: number,
    size: number,
    color: RGB,
    bold = false
  ): void {
    if (!s) return;
    const f = this.fontFor(bold);
    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setFillingColor(color),
      setFontAndSize(this.fontKeyFor(page, f), size),
      setCharacterSpacing(size * HEADING_TRACK_RATIO),
      moveText(x, yTop - size),
      showText(f.encodeText(s)),
      endText(),
      popGraphicsState()
    );
  }

  /**
   * Raw Tj text needs the font's RESOURCE key, not the PDFFont — pdf-lib
   * only wires that up inside drawText, so we register our own "Zt#
   * dictionary entry once per (page, font) and reuse it.
   */
  private fontKeys = new Map<PDFPage, Map<PDFFont, PDFName>>();
  private fontKeySeq = 0;

  private fontKeyFor(page: PDFPage, font: PDFFont): PDFName {
    let perPage = this.fontKeys.get(page);
    if (!perPage) {
      perPage = new Map();
      this.fontKeys.set(page, perPage);
    }
    const hit = perPage.get(font);
    if (hit) return hit;
    const key = PDFName.of(`Zt${this.fontKeySeq++}`);
    page.node.setFontDictionary(key, font.ref);
    perPage.set(font, key);
    return key;
  }
}

/* ------------------------------------------------------------------ */
/* Section title (11 pt caps + hairline rule)                           */
/* ------------------------------------------------------------------ */

function drawSectionTitle(
  p: Painter,
  s: ResumeSection,
  ruleColor: RGB
): void {
  const g = p.geo;
  p.ensure(g.title * 1.35 + 6 + g.lh); // title + at least one content line
  const title = s.title.toUpperCase();
  if (p.tracked) {
    p.trackText(title, g.x, p.y, g.title, COL_TEXT, true);
  } else {
    p.text(title, g.x, p.y, g.title, { bold: true });
  }
  p.y -= g.title + 4;
  p.line(g.x, p.y, g.x + g.w, ruleColor, 0.75);
  p.y -= 6 + g.lh * 0.45;
}

/* ------------------------------------------------------------------ */
/* Section content renderers (main column, all templates)              */
/* ------------------------------------------------------------------ */

function drawSummary(p: Painter, s: Extract<ResumeSection, { kind: "summary" }>): void {
  const g = p.geo;
  for (const ln of p.wrap(s.text, g.w, g.body)) {
    p.ensure(g.lh);
    p.text(ln, g.x, p.y, g.body);
    p.y -= g.lh;
  }
}

function drawExperience(
  p: Painter,
  s: Extract<ResumeSection, { kind: "experience" }>
): void {
  const g = p.geo;
  const present = p.label("present", "Present");
  for (const it of s.items) {
    const dateStr = formatDateRange(
      it.start,
      it.end,
      it.current,
      p.run.locale,
      present
    );
    p.ensure(g.lh * 2 + 4); // keep the title + first meta line together
    const dateW = dateStr ? p.w(dateStr, g.date) + 14 : 0;
    const roleLines = p.wrap(it.role, g.w - dateW, g.itemTitle, true);
    p.text(roleLines[0], g.x, p.y, g.itemTitle, { bold: true });
    if (dateStr)
      p.text(dateStr, g.x + g.w, p.y, g.date, {
        right: g.x + g.w,
        color: COL_MUTED,
      });
    p.y -= g.lh;
    for (let i = 1; i < roleLines.length; i++) {
      p.ensure(g.lh);
      p.text(roleLines[i], g.x, p.y, g.itemTitle, { bold: true });
      p.y -= g.lh;
    }
    const meta = joinMeta([it.company, it.location]);
    for (const ln of p.wrap(meta, g.w, g.small)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.small, { color: COL_MUTED });
      p.y -= g.lh;
    }
    p.y -= 2;
    for (const b of it.bullets) {
      for (const ln of p.wrap(atsBulletLine(b), g.w - g.bulletIndent, g.body)) {
        p.ensure(g.lh);
        p.text(ln, g.x + g.bulletIndent, p.y, g.body);
        p.y -= g.lh;
      }
    }
    p.y -= g.gapItem;
  }
}

function drawEducation(
  p: Painter,
  s: Extract<ResumeSection, { kind: "education" }>
): void {
  const g = p.geo;
  for (const it of s.items) {
    const dateStr = formatDateRange(it.start, it.end, false, p.run.locale, "");
    p.ensure(g.lh * 2); // degree + school line together
    const dateW = dateStr ? p.w(dateStr, g.date) + 14 : 0;
    const degLines = p.wrap(it.degree, g.w - dateW, g.itemTitle, true);
    p.text(degLines[0], g.x, p.y, g.itemTitle, { bold: true });
    if (dateStr)
      p.text(dateStr, g.x + g.w, p.y, g.date, {
        right: g.x + g.w,
        color: COL_MUTED,
      });
    p.y -= g.lh;
    for (let i = 1; i < degLines.length; i++) {
      p.ensure(g.lh);
      p.text(degLines[i], g.x, p.y, g.itemTitle, { bold: true });
      p.y -= g.lh;
    }
    const meta = joinMeta([it.school, it.location, it.grade]);
    for (const ln of p.wrap(meta, g.w, g.small)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.small, { color: COL_MUTED });
      p.y -= g.lh;
    }
    p.y -= g.gapItem;
  }
}

function drawSkills(
  p: Painter,
  s: Extract<ResumeSection, { kind: "skills" }>
): void {
  const g = p.geo;
  // R4-c: compact prints each group's items in TWO columns (split by
  // the pure model helper); classic keeps the single ATS line layout.
  const twoCol = p.run.d.template === "compact";
  for (const grp of s.groups) {
    if (grp.name) {
      p.ensure(g.lh);
      p.text(grp.name, g.x, p.y, g.body, { bold: true });
      p.y -= g.lh;
    }
    if (twoCol) {
      const [left, right] = splitTwoColumns(grp.items);
      const colW = (g.w - 8) / 2;
      const leftLines = p.wrap(left.join(" \u00b7 "), colW, g.body);
      const rightLines = p.wrap(right.join(" \u00b7 "), colW, g.body);
      const rows = Math.max(leftLines.length, rightLines.length);
      for (let i = 0; i < rows; i++) {
        p.ensure(g.lh);
        p.text(leftLines[i] ?? "", g.x, p.y, g.body);
        p.text(rightLines[i] ?? "", g.x + colW + 8, p.y, g.body);
        p.y -= g.lh;
      }
    } else {
      const items = grp.items.join(" \u00b7 ");
      for (const ln of p.wrap(items, g.w, g.body)) {
        p.ensure(g.lh);
        p.text(ln, g.x, p.y, g.body);
        p.y -= g.lh;
      }
    }
    p.y -= 2;
  }
}

function drawProjects(
  p: Painter,
  s: Extract<ResumeSection, { kind: "projects" }>,
  linkColor: RGB
): void {
  const g = p.geo;
  for (const it of s.items) {
    p.ensure(g.lh * 2);
    const linkW = it.link ? p.w(it.link, g.date) + 14 : 0;
    const nameLines = p.wrap(it.name, g.w - linkW, g.itemTitle, true);
    p.text(nameLines[0], g.x, p.y, g.itemTitle, { bold: true });
    if (it.link)
      p.text(it.link, g.x + g.w, p.y, g.date, {
        right: g.x + g.w,
        color: linkColor,
      });
    p.y -= g.lh;
    for (let i = 1; i < nameLines.length; i++) {
      p.ensure(g.lh);
      p.text(nameLines[i], g.x, p.y, g.itemTitle, { bold: true });
      p.y -= g.lh;
    }
    for (const ln of p.wrap(it.description, g.w, g.body)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.body);
      p.y -= g.lh;
    }
    p.y -= g.gapItem;
  }
}

function drawCertifications(
  p: Painter,
  s: Extract<ResumeSection, { kind: "certifications" }>
): void {
  const g = p.geo;
  for (const it of s.items) {
    const line = [it.name, joinMeta([it.issuer, it.year])]
      .filter(Boolean)
      .join(" \u2014 ");
    for (const ln of p.wrap(line, g.w, g.body)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.body);
      p.y -= g.lh;
    }
    p.y -= 1;
  }
}

function drawLanguages(
  p: Painter,
  s: Extract<ResumeSection, { kind: "languages" }>
): void {
  const g = p.geo;
  for (const it of s.items) {
    const line = [it.name, it.level].filter(Boolean).join(" \u2014 ");
    for (const ln of p.wrap(line, g.w, g.body)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.body);
      p.y -= g.lh;
    }
    p.y -= 1;
  }
}

function drawCustom(
  p: Painter,
  s: Extract<ResumeSection, { kind: "custom" }>
): void {
  const g = p.geo;
  for (const it of s.items) {
    if (it.title) {
      p.ensure(g.lh);
      p.text(it.title, g.x, p.y, g.itemTitle, { bold: true });
      p.y -= g.lh;
    }
    for (const ln of p.wrap(it.text, g.w, g.body)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.body);
      p.y -= g.lh;
    }
    p.y -= g.gapItem;
  }
}

/** One section in the main column (skills skipped for modern). */
function drawSection(
  p: Painter,
  s: ResumeSection,
  ruleColor: RGB,
  linkColor: RGB,
  skipSkills: boolean
): void {
  if (skipSkills && s.kind === "skills") return;
  drawSectionTitle(p, s, ruleColor);
  switch (s.kind) {
    case "summary":
      drawSummary(p, s);
      break;
    case "experience":
      drawExperience(p, s);
      break;
    case "education":
      drawEducation(p, s);
      break;
    case "skills":
      drawSkills(p, s);
      break;
    case "projects":
      drawProjects(p, s, linkColor);
      break;
    case "certifications":
      drawCertifications(p, s);
      break;
    case "languages":
      drawLanguages(p, s);
      break;
    case "custom":
      drawCustom(p, s);
      break;
  }
  p.y -= p.geo.gapSection * 0.65;
}

/* ------------------------------------------------------------------ */
/* Photo — square frame, circle-cropped PNG (transparent corners)      */
/* ------------------------------------------------------------------ */

function drawPhoto(
  p: Painter,
  img: PDFImage,
  x: number,
  yTop: number,
  size: number,
  ring: RGB | null
): void {
  // Circle-cropped at the source (the surface paints the alpha), so the
  // frame here is the honest plain square draw + an ellipse ring.
  p.page.drawImage(img, { x, y: yTop - size, width: size, height: size });
  if (ring) {
    p.page.drawEllipse({
      x: x + size / 2,
      y: yTop - size / 2,
      xScale: size / 2,
      yScale: size / 2,
      borderColor: ring,
      borderWidth: 0.75,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Header (classic / compact — single column)                          */
/* ------------------------------------------------------------------ */

function drawColumnHeader(
  p: Painter,
  photo: PDFImage | null,
  centered: boolean,
  ruleColor: RGB
): void {
  const g = p.geo;
  const d = p.run.d;
  const photoW = photo ? g.photoMain + 16 : 0;
  const nameW = g.w - photoW;
  const cx: [number, number] = [g.x, g.x + nameW];

  if (photo) {
    drawPhoto(
      p,
      photo,
      g.x + g.w - g.photoMain,
      p.y - (g.name - g.photoMain) / 2,
      g.photoMain,
      COL_RULE
    );
  }

  const nameLines = p.wrap(d.header.fullName, nameW, g.name, true);
  for (const ln of nameLines) {
    p.text(ln, g.x, p.y, g.name, { bold: true, center: centered ? cx : undefined });
    p.y -= g.name * 1.25;
  }
  if (d.header.headline) {
    for (const ln of p.wrap(d.header.headline, nameW, g.headline)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.headline, {
        color: COL_MUTED,
        center: centered ? cx : undefined,
      });
      p.y -= g.lh;
    }
  }
  const contact = atsContactLine(d.header);
  if (contact) {
    for (const ln of p.wrap(contact, nameW, g.contact)) {
      p.ensure(g.lh);
      p.text(ln, g.x, p.y, g.contact, {
        center: centered ? cx : undefined,
      });
      p.y -= g.lh;
    }
  }
  p.y -= 8;
  p.line(g.x, p.y, g.x + g.w, ruleColor, 1);
  p.y -= g.gapHeader;
}

/* ------------------------------------------------------------------ */
/* Footer — "1 / 2" on every page                                      */
/* ------------------------------------------------------------------ */

function drawFooters(p: Painter, x0: number, x1: number): void {
  const total = p.pages.length;
  p.pages.forEach((page, i) => {
    const s = `${i + 1} / ${total}`;
    const w = p.w(s, 8);
    page.drawText(s, {
      x: (x0 + x1 - w) / 2,
      y: 22,
      size: 8,
      font: p.font,
      color: COL_FOOTER,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Modern sidebar — deterministic per-page slices                      */
/* ------------------------------------------------------------------ */

interface SideSpec {
  x: number;
  yTop: number;
  text: string;
  size: number;
  bold: boolean;
  color: RGB;
  /** modern rail labels — real Tc letter-spacing. */
  track?: boolean;
}

interface SideSlices {
  perPage: SideSpec[][];
  photo?: { pageIdx: number; x: number; yTop: number; size: number };
}

/**
 * Lays the rail content out (photo + CONTACT block + every skills
 * section) into per-page slices — the same wrap + heights the main flow
 * uses, so sidebar overflow honestly continues on the next page's rail
 * instead of being clipped.
 */
function layoutSidebar(
  p: Painter,
  photo: PDFImage | null
): SideSlices {
  const g = p.geo;
  const d = p.run.d;
  const ink = inkOn(p.accent);
  const perPage: SideSpec[][] = [[]];
  let pageIdx = 0;
  let y = g.pageH - g.margin;
  let slices: SideSlices = { perPage };

  const fit = (h: number): void => {
    if (y - h < g.margin) {
      pageIdx++;
      perPage.push([]);
      y = g.pageH - g.margin;
    }
  };
  const lineOut = (
    text: string,
    size: number,
    bold = false,
    color: RGB = ink,
    track = false
  ): void => {
    for (const ln of p.wrap(text, g.sideW, size, bold)) {
      if (ln === "") {
        y -= g.lh;
        continue;
      }
      fit(g.lh);
      perPage[pageIdx].push({
        x: g.sidePad,
        yTop: y,
        text: ln,
        size,
        bold,
        color,
        track,
      });
      y -= g.lh;
    }
  };

  if (photo) {
    fit(g.photoSide + 14);
    slices = {
      perPage,
      photo: {
        pageIdx,
        x: g.sidebarW / 2 - g.photoSide / 2,
        yTop: y,
        size: g.photoSide,
      },
    };
    y -= g.photoSide + 18;
  }

  // R4-c: the identity block (name + headline) lives in the rail.
  if (d.header.fullName) {
    lineOut(d.header.fullName, g.name, true);
    y -= 2;
  }
  if (d.header.headline) {
    lineOut(d.header.headline, g.headline);
    y -= 6;
  }

  const contactLabel = p.label("contact", "CONTACT").toUpperCase();
  if (contactLabel) {
    lineOut(contactLabel, g.small, true, ink, true);
    y -= 2;
  }
  for (const part of [
    d.header.email,
    d.header.phone,
    d.header.location,
    d.header.linkedin,
    d.header.website,
  ]) {
    if (part) lineOut(part, g.small);
  }
  y -= 10;

  for (const s of d.sections) {
    if (s.kind !== "skills") continue;
    fit(g.title * 1.3 + 4 + g.lh);
    lineOut(s.title.toUpperCase(), g.title - 1, true, ink, true);
    y -= 2;
    for (const grp of s.groups) {
      if (grp.name) lineOut(grp.name, g.body, true);
      lineOut(grp.items.join(" \u00b7 "), g.small);
      y -= 4;
    }
    y -= 6;
  }
  return slices;
}

function paintSidebarSlice(p: Painter, slice: SideSpec[], pageIndex: number): void {
  if (pageIndex >= p.pages.length) return;
  const page = p.pages[pageIndex];
  for (const spec of slice) {
    if (spec.track) {
      p.trackTextOn(page, spec.text, spec.x, spec.yTop, spec.size, spec.color, spec.bold);
    } else {
      page.drawText(spec.text, {
        x: spec.x,
        y: spec.yTop - spec.size,
        size: spec.size,
        font: p.fontFor(spec.bold),
        color: spec.color,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

async function drawClassicLike(
  p: Painter,
  centered: boolean,
  ruleColor: RGB,
  linkColor: RGB
): Promise<void> {
  const g = p.geo;
  const d = p.run.d;
  const photo = d.header.photo ? await embedPhoto(p.pdfDoc, d.header.photo) : null;
  drawColumnHeader(p, photo, centered, ruleColor);
  for (const s of d.sections) {
    drawSection(p, s, ruleColor, linkColor, false);
  }
  drawFooters(p, g.x, g.x + g.w);
}

async function drawModern(p: Painter): Promise<void> {
  const g = p.geo;
  const d = p.run.d;
  const ink = inkOn(p.accent);
  const photo = d.header.photo ? await embedPhoto(p.pdfDoc, d.header.photo) : null;

  // Phase A: deterministic rail slices (drawn onto the shared pages).
  const slices = layoutSidebar(p, photo);

  // Chrome on every page: the full-bleed accent rail (+ the photo on p1).
  const chrome = (page: PDFPage): void => {
    page.drawRectangle({
      x: 0,
      y: 0,
      width: g.sidebarW,
      height: g.pageH,
      color: p.accent,
    });
  };
  p.chrome = chrome;
  chrome(p.pages[0]);
  if (photo && slices.photo) {
    p.pages[0].drawImage(photo, {
      x: slices.photo.x,
      y: slices.photo.yTop - slices.photo.size,
      width: slices.photo.size,
      height: slices.photo.size,
    });
    p.pages[0].drawEllipse({
      x: slices.photo.x + slices.photo.size / 2,
      y: slices.photo.yTop - slices.photo.size / 2,
      xScale: slices.photo.size / 2,
      yScale: slices.photo.size / 2,
      borderColor: ink,
      borderWidth: 0.75,
    });
  }

  // Phase B: main flow (R4-c: identity moved into the rail — the main
  // column starts straight at the first section heading).
  for (const s of d.sections) {
    drawSection(p, s, p.accent, p.accent, true);
  }

  // Rail continuation pages (skills-heavy resumes overflow page 1).
  for (let i = 0; i < slices.perPage.length; i++) {
    while (p.pages.length <= i) p.newPage();
    paintSidebarSlice(p, slices.perPage[i], i);
  }

  drawFooters(p, g.x, g.x + g.w);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface ResumeRenderReport {
  pages: number;
  photo: boolean;
}

/**
 * Paint the whole resume into `pdfDoc` (pages added as needed).
 * `font` must already be embedded (Helvetica standard OR the Noto
 * subset); `boldFont` may be null — then bold text falls back to the
 * regular face (Noto ships Regular only).
 */
export async function drawResumePdf(
  pdfDoc: PDFDocument,
  font: PDFFont,
  run: ResumeRun,
  opts: { boldFont?: PDFFont | null } = {}
): Promise<ResumeRenderReport> {
  const d = run.d;
  const p = new Painter(
    pdfDoc,
    font,
    opts.boldFont ?? null,
    run,
    d.accentColor
  );
  if (d.template === "modern") {
    await drawModern(p);
  } else if (d.template === "compact") {
    // dense: left-aligned header, accent rules
    await drawClassicLike(p, false, p.accent, p.accent);
  } else {
    // classic: pure ATS — near-black only, the accent is ignored
    await drawClassicLike(p, true, rgb(0.2, 0.2, 0.2), COL_TEXT);
  }
  return { pages: p.pages.length, photo: d.header.photo !== "" };
}
