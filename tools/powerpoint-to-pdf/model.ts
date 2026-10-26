/**
 * PowerPoint to PDF (RB2-a — the 71st tool) — pure model. No DOM, no
 * pdf-lib, no worker APIs: the same parsePptx feeds the surface's live
 * deck summary AND the worker's render path, so the preview numbers can
 * never disagree with the output.
 *
 *  - parsePptx: fflate unzipSync of the OOXML ZIP →
 *    ppt/presentation.xml (sldSz cx/cy EMU + sldIdLst r:id order) →
 *    ppt/_rels/presentation.xml.rels (rId → slide part) → each
 *    ppt/slides/slideN.xml parsed with a dependency-free SAX-ish
 *    tokenizer (no DOMParser — workers). Shapes (p:sp) carry their box
 *    (a:xfrm a:off/a:ext, EMU → pt via /12700) and paragraphs/runs with
 *    a:rPr attrs (sz hundredths of a point, b, i, solidFill/srgbClr
 *    hex). Groups (p:grpSp) recurse with the chOff/chExt child-space
 *    transform composed inner→outer. Title placeholders (p:ph
 *    type="title"/"ctrTitle") are marked so the renderer can bold them.
 *    Speaker notes come from ppt/notesSlides/notesSlideN.xml via each
 *    slide's .rels (plain text runs, optional include).
 *  - parsePptxRun: the worker-boundary coercion (parseWordRun pattern)
 *    — clamp arrays, strip control chars, cap every length. A tampered
 *    payload can never reach the renderer as a wrong type.
 *  - needsNoto / isWinAnsiText: pure-WinAnsi decks → non-embedded
 *    base-14 Helvetica; ANY non-WinAnsi char (Devanagari, ₹ …) → the
 *    self-hosted Noto Sans Devanagari subset (fontkit).
 *  - buildSamplePptx: a REAL minimal 2-slide deck (master/layout/theme
 *    chain, 1 notes slide) used by the smoke script.
 *
 * Honest limits (mirrored in config.ts): .pptx only — the legacy
 * binary .ppt is an OLE2 compound file, not a ZIP, and is rejected
 * up front; pictures, charts, SmartArt and graphicFrame tables are
 * not carried over.
 */

import { strToU8, unzipSync, zipSync, type Unzipped } from "@/lib/own/zip";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the boundary parser)                          */
/* ------------------------------------------------------------------ */

export const MAX_SLIDES = 100;
export const MAX_SHAPES_PER_SLIDE = 300;
export const MAX_PARAS_PER_SHAPE = 200;
export const MAX_RUNS_PER_PARA = 100;
export const MAX_RUN_TEXT = 2_000;
export const MAX_NOTES_CHARS = 4_000;
/** hard byte ceiling (the surface shows 50 MB on coarse-pointer devices) */
export const MAX_PPTX_BYTES = 200 * 1024 * 1024;

const EMU_PER_PT = 12700;
/** PowerPoint defaults when sldSz is missing/invalid (16:9). */
const DEFAULT_SLIDE_CX = 12192000;
const DEFAULT_SLIDE_CY = 6858000;

/* ------------------------------------------------------------------ */
/* Slide IR                                                             */
/* ------------------------------------------------------------------ */

export interface PptRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** explicit a:rPr @sz (hundredths of a pt) → pt, clamped 4–144. */
  sizePt?: number;
  /** a:rPr solidFill/srgbClr @val hex (RRGGBB, uppercase). */
  color?: string;
}

export interface PptPara {
  runs: PptRun[];
  /** a:pPr @algn (justify flattens to left — honest). */
  align?: "left" | "center" | "right";
  /** true when the paragraph carries a:buChar/a:buAutoNum (numbers print as bullets). */
  bullet?: boolean;
}

export interface PptShape {
  /** box in pt (EMU / 12700), after the group transform composition. */
  x: number;
  y: number;
  w: number;
  h: number;
  paras: PptPara[];
  /** title placeholder (ph type="title"/"ctrTitle") → renderer bolds it. */
  isTitle: boolean;
}

export interface PptSlide {
  shapes: PptShape[];
  /** speaker-notes text ("" when the slide has no notes part). */
  notes: string;
}

export interface ParsedPptx {
  slides: PptSlide[];
  /** slide size in pt (sldSz / 12700; 16:9 default 960 × 540). */
  slideW: number;
  slideH: number;
  /** true when a hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

export interface PptStats {
  slides: number;
  shapes: number;
  words: number;
  chars: number;
  /** slides that carry non-empty speaker notes. */
  notesSlides: number;
}

/** Honest stats derived from the slides alone (parse + coercion agree). */
export function statsSlides(slides: PptSlide[]): PptStats {
  let shapes = 0;
  let words = 0;
  let chars = 0;
  let notesSlides = 0;
  const count = (s: string): void => {
    chars += s.length;
    words += s.split(/\s+/).filter(Boolean).length;
  };
  for (const slide of slides) {
    if (slide.notes.trim()) {
      notesSlides += 1;
      count(slide.notes);
    }
    for (const sh of slide.shapes) {
      shapes += 1;
      for (const para of sh.paras) {
        for (const r of para.runs) count(r.text);
      }
    }
  }
  return { slides: slides.length, shapes, words, chars, notesSlides };
}

/** Estimated output pages: one per slide, plus one notes page per slide. */
export function estimatePages(slides: PptSlide[], withNotes: boolean): number {
  return slides.length * (withNotes ? 2 : 1);
}

/* ------------------------------------------------------------------ */
/* Error codes thrown by parsePptx (mapped to i18n keys in the worker)  */
/* ------------------------------------------------------------------ */

export type PptxErrorCode =
  | "pptx-legacy"
  | "pptx-not-zip"
  | "pptx-corrupt"
  | "pptx-empty"
  | "pptx-too-large";

export class PptxParseError extends Error {
  readonly code: PptxErrorCode;
  constructor(code: PptxErrorCode) {
    super(code);
    this.code = code;
    this.name = "PptxParseError";
  }
}

/* ------------------------------------------------------------------ */
/* Magic sniffing (shared by the surface drop zone + the worker)        */
/* ------------------------------------------------------------------ */

/** Legacy .ppt (OLE2 compound document) — the honest "convert first" case. */
export function isLegacyPptBytes(head: Uint8Array): boolean {
  return (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  );
}

/** ZIP magic: PK\x03\x04 (local file) or PK\x05\x06 (empty archive). */
export function isZipBytes(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) ||
      (head[2] === 0x05 && head[3] === 0x06) ||
      (head[2] === 0x07 && head[3] === 0x08))
  );
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (create-resume copy)  */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true when every char is encodable in WinAnsi (CP1252) minus controls.
 * \n and \t pass — the layout consumes them (hard breaks), they never
 * reach font encoding. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x09) continue;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/**
 * true → the renderer must embed the self-hosted Noto Sans Devanagari
 * (fontkit subset); false → pure-WinAnsi decks stay on base-14 Helvetica.
 * `extra` covers localized strings drawn by the renderer itself (the
 * notes-page heading template), which flip the font decision too.
 */
export function needsNoto(ppt: ParsedPptx, extra = ""): boolean {
  if (extra && !isWinAnsiText(extra)) return true;
  for (const slide of ppt.slides) {
    if (!isWinAnsiText(slide.notes)) return true;
    for (const sh of slide.shapes) {
      for (const para of sh.paras) {
        for (const r of para.runs) {
          if (!isWinAnsiText(r.text)) return true;
        }
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* hindiNorm — the pinned lost-session lesson                           */
/* ------------------------------------------------------------------ */

const DEVA_RE = /[\u0900-\u097F]/;

/**
 * Noto subset CMaps can inject stray ASCII quotes (") between Devanagari
 * words. Strip `"` — but ONLY from strings that actually contain
 * Devanagari; English quotes are left completely alone.
 */
export function hindiNorm(s: string): string {
  return DEVA_RE.test(s) ? s.split('"').join("") : s;
}

/* ------------------------------------------------------------------ */
/* XML entities                                                         */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  tab: "\t",
  newline: "\n",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY_RE, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/* ------------------------------------------------------------------ */
/* prefix / local-name helpers                                          */
/* ------------------------------------------------------------------ */

function prefixOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? "" : name.slice(0, colon);
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/* ------------------------------------------------------------------ */
/* Dependency-free XML tokenizer (SAX events; no DOMParser in workers)  */
/* ------------------------------------------------------------------ */

export interface SaxHandlers {
  open(name: string, attrs: Record<string, string>): void;
  text(value: string): void;
  close(name: string): void;
}

const WS_RE = /[\s]/;
const NAME_STOP_RE = /[\s/>]/;
const ATTR_NAME_STOP_RE = /[\s=/>]/;

/**
 * Tolerant linear tokenizer for well-formed Office XML: real elements
 * emit open/close (self-closing emits both), <?…?> / <!--…--> /
 * <![CDATA[…]]> are skipped (CDATA becomes raw text), everything else
 * between tags is text with entity decoding. Malformed input degrades
 * instead of throwing. (word-to-pdf tokenizer, verbatim.)
 */
export function parseXmlSax(xml: string, h: SaxHandlers): void {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < n) h.text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) h.text(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      h.text(xml.slice(lt + 9, end < 0 ? n : end)); // raw — no entities
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 33 /* ! */) {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    let j = lt + 1;
    let closing = false;
    if (xml.charCodeAt(j) === 47 /* / */) {
      closing = true;
      j += 1;
    }
    const nameStart = j;
    while (j < n && !NAME_STOP_RE.test(xml[j])) j += 1;
    const name = xml.slice(nameStart, j);
    if (name === "") {
      // "<" that isn't a tag at all — emit it as text and move on.
      h.text("<");
      i = lt + 1;
      continue;
    }

    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && WS_RE.test(xml[j])) j += 1;
      const c = xml.charCodeAt(j);
      if (c === 47 /* / */) {
        selfClosing = true;
        j += 1;
        continue;
      }
      if (c === 62 /* > */) {
        j += 1;
        break;
      }
      const aStart = j;
      while (j < n && !ATTR_NAME_STOP_RE.test(xml[j])) j += 1;
      const aName = xml.slice(aStart, j);
      while (j < n && WS_RE.test(xml[j])) j += 1;
      let aVal = "";
      if (xml.charCodeAt(j) === 61 /* = */) {
        j += 1;
        while (j < n && WS_RE.test(xml[j])) j += 1;
        const q = xml.charCodeAt(j);
        if (q === 34 /* " */ || q === 39 /* ' */) {
          j += 1;
          const vStart = j;
          while (j < n && xml.charCodeAt(j) !== q) j += 1;
          aVal = xml.slice(vStart, j);
          j += 1;
        } else {
          const vStart = j;
          while (j < n && !WS_RE.test(xml[j]) && xml.charCodeAt(j) !== 62) {
            j += 1;
          }
          aVal = xml.slice(vStart, j);
        }
      }
      if (aName) attrs[aName] = decodeEntities(aVal);
      if (j >= n) break;
    }

    if (closing) {
      h.close(name);
    } else {
      h.open(name, attrs);
      if (selfClosing) h.close(name);
    }
    i = j;
  }
}

/* ------------------------------------------------------------------ */
/* numeric helpers                                                      */
/* ------------------------------------------------------------------ */

function emuToPt(v: number): number {
  return v / EMU_PER_PT;
}

/** finite integer attribute → number, else null. */
function attrNum(attrs: Record<string, string>, key: string): number | null {
  const v = Number.parseInt(attrs[key] ?? "", 10);
  return Number.isFinite(v) ? v : null;
}

/** a:rPr @sz — hundredths of a point → pt (4–144). */
function szToPt(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const v = Number.parseInt(val, 10);
  if (!Number.isFinite(v)) return undefined;
  const pt = v / 100;
  return pt >= 4 && pt <= 144 ? pt : undefined;
}

function boolAttr(attrs: Record<string, string>, key: string): boolean {
  const v = attrs[key];
  return v !== undefined && v !== "0" && v !== "false" && v !== "none";
}

const COLOR_RE = /^[0-9A-Fa-f]{6}$/;

/* ------------------------------------------------------------------ */
/* presentation.xml + rels                                              */
/* ------------------------------------------------------------------ */

interface PresentationInfo {
  cx: number;
  cy: number;
  rIds: string[];
}

function parsePresentationXml(xml: string): PresentationInfo {
  let cx = DEFAULT_SLIDE_CX;
  let cy = DEFAULT_SLIDE_CY;
  const rIds: string[] = [];
  parseXmlSax(xml, {
    open(name, attrs) {
      if (prefixOf(name) !== "p") return;
      const local = localName(name);
      if (local === "sldSz") {
        const x = attrNum(attrs, "cx");
        const y = attrNum(attrs, "cy");
        if (x !== null && x >= 100000 && x <= 51206400) cx = x;
        if (y !== null && y >= 100000 && y <= 51206400) cy = y;
      } else if (local === "sldId") {
        const rid = attrs["r:id"] ?? "";
        if (rid) rIds.push(rid);
      }
    },
    text() {
      /* everything lives in attributes */
    },
    close() {
      /* nothing */
    },
  });
  return { cx, cy, rIds };
}

interface RelInfo {
  target: string;
  type: string;
}

function parseRelsXml(xml: string): Record<string, RelInfo> {
  const map: Record<string, RelInfo> = {};
  parseXmlSax(xml, {
    open(name, attrs) {
      if (localName(name) !== "Relationship") return;
      const id = attrs.Id ?? "";
      const target = attrs.Target ?? "";
      const type = attrs.Type ?? "";
      if (id && target) map[id] = { target, type };
    },
    text() {
      /* attributes only */
    },
    close() {
      /* nothing */
    },
  });
  return map;
}

/** Resolve an OPC part target against its owner's directory. */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack = baseDir === "" ? [] : baseDir.split("/");
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

/* ------------------------------------------------------------------ */
/* Slide assembler (flat SAX state machine)                             */
/* ------------------------------------------------------------------ */

interface XfrmData {
  offX: number;
  offY: number;
  extX: number;
  extY: number;
  chOffX: number;
  chOffY: number;
  chExtX: number;
  chExtY: number;
}

function newXfrm(): XfrmData {
  return {
    offX: 0,
    offY: 0,
    extX: 0,
    extY: 0,
    chOffX: 0,
    chOffY: 0,
    chExtX: 0,
    chExtY: 0,
  };
}

interface ParaState {
  runs: PptRun[];
  run: RunState | null;
  align: "left" | "center" | "right" | undefined;
  bullet: boolean;
  textLen: number;
}

interface RunState {
  text: string;
  bold: boolean;
  italic: boolean;
  sizePt: number | undefined;
  color: string | undefined;
}

interface SpFrame {
  kind: "sp";
  xfrm: XfrmData | null;
  isTitle: boolean;
  paras: PptPara[];
  para: ParaState | null;
  run: RunState | null;
  inRPr: boolean;
  inTxBody: boolean;
}

type Frame =
  | { kind: "grp"; xfrm: XfrmData; children: PptShape[] }
  | SpFrame
  | { kind: "skip" };

/**
 * Streams tokenizer events into one slide's shapes. Group transforms
 * compose inner→outer at shape-close time (every ancestor's raw xfrm
 * is complete by then — xfrm always precedes children in OOXML).
 */
class SlideAssembler {
  readonly shapes: PptShape[] = [];
  truncated = false;

  private stack: Frame[] = [];
  private xfrmData: XfrmData | null = null;
  private textTarget = false;
  private shapeCount = 0;
  /** flow cursor (pt) for shapes with no xfrm (rare, malformed decks). */
  private autoY = 36;

  constructor(
    private readonly slideW: number,
    private readonly slideH: number
  ) {}

  private topSp(): SpFrame | null {
    const f = this.stack[this.stack.length - 1];
    return f && f.kind === "sp" ? f : null;
  }

  private newPara(): ParaState {
    return {
      runs: [],
      run: null,
      align: undefined,
      bullet: false,
      textLen: 0,
    };
  }

  private endRun(): void {
    const sp = this.topSp();
    const para = sp?.para ?? null;
    if (!sp || !para) {
      if (sp) sp.run = null;
      return;
    }
    const run = sp.run;
    sp.run = null;
    sp.inRPr = false;
    if (!run || run.text === "") return;
    if (para.runs.length >= MAX_RUNS_PER_PARA || para.textLen >= MAX_RUN_TEXT) {
      this.truncated = true;
      return;
    }
    const text = run.text.slice(0, MAX_RUN_TEXT);
    para.textLen += text.length;
    para.runs.push({
      text,
      bold: run.bold,
      italic: run.italic,
      sizePt: run.sizePt,
      color: run.color,
    });
  }

  private endPara(): void {
    const sp = this.topSp();
    if (!sp) return;
    const para = sp.para;
    sp.para = null;
    sp.run = null;
    if (!para) return;
    if (sp.paras.length >= MAX_PARAS_PER_SHAPE) {
      this.truncated = true;
      return;
    }
    sp.paras.push({
      runs: para.runs,
      align: para.align,
      bullet: para.bullet || undefined,
    });
  }

  /** Compose the ancestor group transforms (inner→outer) over the raw box. */
  private absoluteBox(
    raw: XfrmData
  ): { x: number; y: number; w: number; h: number } {
    let x = raw.offX;
    let y = raw.offY;
    let w = raw.extX;
    let h = raw.extY;
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const f = this.stack[i];
      if (f.kind !== "grp") continue;
      const g = f.xfrm;
      const sx = g.chExtX > 0 ? g.extX / g.chExtX : 1;
      const sy = g.chExtY > 0 ? g.extY / g.chExtY : 1;
      x = g.offX + (x - g.chOffX) * sx;
      y = g.offY + (y - g.chOffY) * sy;
      w *= sx;
      h *= sy;
    }
    return { x: emuToPt(x), y: emuToPt(y), w: emuToPt(w), h: emuToPt(h) };
  }

  private endShape(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.kind !== "sp") {
      this.stack.pop(); // skip frame or stray close — drop it
      return;
    }
    // finalize the pending paragraph while the sp frame is still on the
    // stack (endPara reads the stack top).
    if (top.para) this.endPara();
    const sp = this.stack.pop();
    if (!sp || sp.kind !== "sp") return;
    const shape: PptShape = sp.xfrm
      ? { ...this.absoluteBox(sp.xfrm), paras: sp.paras, isTitle: sp.isTitle }
      : {
          // honest flow fallback for shapes without a box: stack them
          // down the slide at full width minus a 36 pt gutter.
          x: 36,
          y: this.autoY,
          w: Math.max(72, this.slideW - 72),
          h: Math.max(48, 18 * Math.max(1, sp.paras.length)),
          paras: sp.paras,
          isTitle: sp.isTitle,
        };
    if (!sp.xfrm) {
      this.autoY += shape.h + 12;
    }
    const parent = this.stack[this.stack.length - 1];
    if (parent && parent.kind === "grp") {
      if (parent.children.length >= MAX_SHAPES_PER_SLIDE) {
        this.truncated = true;
        return;
      }
      parent.children.push(shape);
      return;
    }
    this.pushTop(shape);
  }

  private pushTop(shape: PptShape): void {
    if (this.shapes.length >= MAX_SHAPES_PER_SLIDE) {
      this.truncated = true;
      return;
    }
    this.shapeCount += 1;
    this.shapes.push(shape);
  }

  private endGroup(): void {
    const g = this.stack.pop();
    if (!g || g.kind !== "grp") return;
    const parent = this.stack[this.stack.length - 1];
    for (const child of g.children) {
      if (parent && parent.kind === "grp") {
        if (parent.children.length >= MAX_SHAPES_PER_SLIDE) {
          this.truncated = true;
          break;
        }
        parent.children.push(child);
      } else {
        this.pushTop(child);
      }
    }
  }

  readonly handlers: SaxHandlers = {
    open: (name, attrs) => {
      const pre = prefixOf(name);
      const local = localName(name);

      if (pre === "p") {
        switch (local) {
          case "sp":
            if (this.shapeCount >= MAX_SHAPES_PER_SLIDE) {
              this.truncated = true;
              this.stack.push({ kind: "skip" });
              return;
            }
            this.stack.push({
              kind: "sp",
              xfrm: null,
              isTitle: false,
              paras: [],
              para: null,
              run: null,
              inRPr: false,
              inTxBody: false,
            });
            return;
          case "grpSp":
          case "spTree": {
            // the tree itself is a (usually identity) group — its xfrm
            // events land on it while it is the stack top.
            const frame: Frame = { kind: "grp", xfrm: newXfrm(), children: [] };
            this.stack.push(frame);
            this.xfrmData = frame.xfrm;
            return;
          }
          case "pic":
          case "graphicFrame":
          case "contentPart":
            // pictures / charts / SmartArt / tables are not carried —
            // absorb their subtrees so their xfrm can't corrupt frames.
            this.stack.push({ kind: "skip" });
            return;
          case "ph": {
            const sp = this.topSp();
            if (sp) {
              const type = attrs.type ?? "";
              sp.isTitle = type === "title" || type === "ctrTitle";
            }
            return;
          }
          case "txBody": {
            // PresentationML puts the shape text body in the p: namespace
            // (<p:txBody>); DrawingML uses a:txBody — accept both.
            const sp = this.topSp();
            if (sp) sp.inTxBody = true;
            return;
          }
          default:
            return;
        }
      }

      if (pre !== "a") return;
      switch (local) {
        case "xfrm": {
          const top = this.stack[this.stack.length - 1];
          if (top && (top.kind === "sp" || top.kind === "grp")) {
            if (top.kind === "sp" && top.xfrm === null) top.xfrm = newXfrm();
            this.xfrmData = top.kind === "sp" ? (top.xfrm as XfrmData) : top.xfrm;
          }
          return;
        }
        case "off": {
          const d = this.xfrmData;
          if (d) {
            const x = attrNum(attrs, "x");
            const y = attrNum(attrs, "y");
            d.offX = x ?? 0;
            d.offY = y ?? 0;
          }
          return;
        }
        case "ext": {
          const d = this.xfrmData;
          if (d) {
            const cx = attrNum(attrs, "cx");
            const cy = attrNum(attrs, "cy");
            d.extX = cx ?? 0;
            d.extY = cy ?? 0;
          }
          return;
        }
        case "chOff": {
          const d = this.xfrmData;
          if (d) {
            const x = attrNum(attrs, "x");
            const y = attrNum(attrs, "y");
            d.chOffX = x ?? 0;
            d.chOffY = y ?? 0;
          }
          return;
        }
        case "chExt": {
          const d = this.xfrmData;
          if (d) {
            const cx = attrNum(attrs, "cx");
            const cy = attrNum(attrs, "cy");
            d.chExtX = cx ?? 0;
            d.chExtY = cy ?? 0;
          }
          return;
        }
        case "txBody": {
          const sp = this.topSp();
          if (sp) sp.inTxBody = true;
          return;
        }
        case "p": {
          const sp = this.topSp();
          if (sp && sp.inTxBody) sp.para = this.newPara();
          return;
        }
        case "pPr": {
          const para = this.topSp()?.para ?? null;
          if (para) {
            const algn = attrs.algn ?? "";
            if (algn === "ctr") para.align = "center";
            else if (algn === "r" || algn === "end") para.align = "right";
            else if (algn === "l" || algn === "start") para.align = "left";
          }
          return;
        }
        case "buChar":
        case "buAutoNum": {
          const para = this.topSp()?.para ?? null;
          if (para) para.bullet = true;
          return;
        }
        case "buNone": {
          const para = this.topSp()?.para ?? null;
          if (para) para.bullet = false;
          return;
        }
        case "r":
        case "fld": {
          const sp = this.topSp();
          if (sp && sp.para) {
            sp.run = {
              text: "",
              bold: false,
              italic: false,
              sizePt: undefined,
              color: undefined,
            };
          }
          return;
        }
        case "rPr": {
          const sp = this.topSp();
          const run = sp?.run ?? null;
          if (run) {
            if (sp) sp.inRPr = true;
            if (run.sizePt === undefined) run.sizePt = szToPt(attrs.sz);
            if (boolAttr(attrs, "b")) run.bold = true;
            if (boolAttr(attrs, "i")) run.italic = true;
          }
          return;
        }
        case "srgbClr": {
          const sp = this.topSp();
          const run = sp?.run ?? null;
          const val = attrs.val ?? "";
          if (sp && sp.inRPr && run && COLOR_RE.test(val)) {
            run.color = val.toUpperCase();
          }
          return;
        }
        case "br": {
          const sp = this.topSp();
          const para = sp?.para ?? null;
          if (sp && para) {
            if (sp.run) sp.run.text += "\n";
            else
              sp.run = {
                text: "\n",
                bold: false,
                italic: false,
                sizePt: undefined,
                color: undefined,
              };
          }
          return;
        }
        case "t": {
          const sp = this.topSp();
          if (sp && sp.run) this.textTarget = true;
          return;
        }
        default:
          return;
      }
    },

    text: (value) => {
      if (!this.textTarget) return;
      const run = this.topSp()?.run ?? null;
      if (run) run.text += hindiNorm(value);
    },

    close: (name) => {
      const pre = prefixOf(name);
      const local = localName(name);

      if (pre === "p") {
        if (local === "sp") {
          this.endShape();
        } else if (local === "grpSp" || local === "spTree") {
          this.endGroup();
        } else if (local === "txBody") {
          const sp = this.topSp();
          if (sp) {
            if (sp.para) this.endPara();
            sp.inTxBody = false;
          }
        } else if (
          local === "pic" ||
          local === "graphicFrame" ||
          local === "contentPart"
        ) {
          this.stack.pop();
        }
        return;
      }

      if (pre !== "a") return;
      switch (local) {
        case "xfrm":
          this.xfrmData = null;
          return;
        case "txBody": {
          const sp = this.topSp();
          if (sp) {
            if (sp.para) this.endPara();
            sp.inTxBody = false;
          }
          return;
        }
        case "p":
          this.endPara();
          return;
        case "r":
        case "fld":
          this.endRun();
          return;
        case "rPr": {
          const sp = this.topSp();
          if (sp) sp.inRPr = false;
          return;
        }
        case "t":
          this.textTarget = false;
          return;
        default:
          return;
      }
    },
  };

  finish(): PptSlide {
    return { shapes: this.shapes, notes: "" };
  }
}

/* ------------------------------------------------------------------ */
/* notesSlides → plain text                                             */
/* ------------------------------------------------------------------ */

function parseNotesText(xml: string): string {
  let out = "";
  let inT = false;
  parseXmlSax(xml, {
    open(name) {
      if (prefixOf(name) === "a" && localName(name) === "t") inT = true;
    },
    text(value) {
      if (inT) out += hindiNorm(value);
    },
    close(name) {
      if (prefixOf(name) === "a" && localName(name) === "t") inT = false;
      else if (prefixOf(name) === "a" && localName(name) === "p") out += "\n";
    },
  });
  return out
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES_CHARS);
}

/* ------------------------------------------------------------------ */
/* parsePptx                                                            */
/* ------------------------------------------------------------------ */

function decodeUtf8(b: Uint8Array): string {
  let s = new TextDecoder("utf-8", { fatal: false }).decode(b);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/**
 * Unzips a .pptx (OOXML ZIP) and extracts the slide IR. Throws
 * PptxParseError with an honest code for everything the renderer can't
 * consume (legacy .ppt, non-ZIP, no presentation part, no slides).
 */
export function parsePptx(bytes: Uint8Array): ParsedPptx {
  if (bytes.length > MAX_PPTX_BYTES) throw new PptxParseError("pptx-too-large");
  if (isLegacyPptBytes(bytes.slice(0, 8))) {
    throw new PptxParseError("pptx-legacy");
  }
  if (!isZipBytes(bytes.slice(0, 4))) throw new PptxParseError("pptx-not-zip");

  let entries: Unzipped;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new PptxParseError("pptx-not-zip");
  }

  const presBytes = entries["ppt/presentation.xml"];
  if (!presBytes || presBytes.length === 0) {
    throw new PptxParseError("pptx-corrupt");
  }
  const pres = parsePresentationXml(decodeUtf8(presBytes));

  const relsBytes = entries["ppt/_rels/presentation.xml.rels"];
  const rels = relsBytes ? parseRelsXml(decodeUtf8(relsBytes)) : {};

  const seen = new Set<string>();
  const slideParts: string[] = [];
  for (const rid of pres.rIds) {
    const rel = rels[rid];
    if (!rel || !rel.type.endsWith("/slide")) continue;
    const part = resolvePart("ppt", rel.target);
    const data = entries[part];
    if (!data || data.length === 0 || seen.has(part)) continue;
    seen.add(part);
    slideParts.push(part);
  }
  if (slideParts.length === 0) throw new PptxParseError("pptx-empty");

  const truncated = slideParts.length > MAX_SLIDES;
  const parts = slideParts.slice(0, MAX_SLIDES);
  const slideW = emuToPt(pres.cx);
  const slideH = emuToPt(pres.cy);

  const slides: PptSlide[] = [];
  for (const part of parts) {
    const asm = new SlideAssembler(slideW, slideH);
    try {
      parseXmlSax(decodeUtf8(entries[part] as Uint8Array), asm.handlers);
    } catch {
      /* a damaged slide degrades to empty — the deck keeps going */
    }
    asm.truncated = asm.truncated || truncated;
    const slide = asm.finish();

    // speaker notes: this slide's .rels → notesSlide part
    const slash = part.lastIndexOf("/");
    const dir = slash >= 0 ? part.slice(0, slash) : "";
    const file = slash >= 0 ? part.slice(slash + 1) : part;
    const notesRelsBytes = entries[`${dir}/_rels/${file}.rels`];
    if (notesRelsBytes) {
      const nrels = parseRelsXml(decodeUtf8(notesRelsBytes));
      for (const rel of Object.values(nrels)) {
        if (!rel.type.endsWith("/notesSlide")) continue;
        const notesPart = resolvePart(dir, rel.target);
        const notesBytes = entries[notesPart];
        if (notesBytes && notesBytes.length > 0) {
          try {
            slide.notes = parseNotesText(decodeUtf8(notesBytes));
          } catch {
            slide.notes = "";
          }
          break;
        }
      }
    }
    slides.push(slide);
  }

  return { slides, slideW, slideH, truncated };
}

/* ------------------------------------------------------------------ */
/* parsePptxRun — worker-boundary coercion (parseWordRun pattern)       */
/* ------------------------------------------------------------------ */

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

function coercePt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}

function coerceSize(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return n >= 4 && n <= 144 ? n : undefined;
}

function coerceColor(v: unknown): string | undefined {
  return typeof v === "string" && COLOR_RE.test(v) ? v.toUpperCase() : undefined;
}

function coerceAlign(v: unknown): "left" | "center" | "right" | undefined {
  return v === "left" || v === "center" || v === "right" ? v : undefined;
}

function coerceNotes(v: unknown): string {
  return cleanText(hindiNorm(typeof v === "string" ? v : ""), MAX_NOTES_CHARS)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Full defensive coercion of a serialized ParsedPptx at the worker
 * boundary: garbage → empty deck, arrays clamped, every text capped,
 * unknown enum values dropped.
 */
export function parsePptxRun(raw: string): ParsedPptx {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { slides: [], slideW: 960, slideH: 540, truncated: false };
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const rawSlides = Array.isArray(o.slides) ? o.slides : [];
  // ECMA-376 caps a slide at 51206400 EMU = 4032 pt; ±20 in slack on x/y.
  const slideW = coercePt(o.slideW, 32, 4032) || 960;
  const slideH = coercePt(o.slideH, 32, 4032) || 540;
  let truncated = o.truncated === true || rawSlides.length > MAX_SLIDES;

  const slides: PptSlide[] = [];
  for (const so of rawSlides.slice(0, MAX_SLIDES)) {
    if (typeof so !== "object" || so === null) continue;
    const s = so as Record<string, unknown>;
    const rawShapes = Array.isArray(s.shapes) ? s.shapes : [];
    const shapes: PptShape[] = [];
    for (const ho of rawShapes.slice(0, MAX_SHAPES_PER_SLIDE)) {
      if (typeof ho !== "object" || ho === null) continue;
      const h = ho as Record<string, unknown>;
      const rawParas = Array.isArray(h.paras) ? h.paras : [];
      const paras: PptPara[] = [];
      for (const po of rawParas.slice(0, MAX_PARAS_PER_SHAPE)) {
        if (typeof po !== "object" || po === null) continue;
        const p = po as Record<string, unknown>;
        const rawRuns = Array.isArray(p.runs) ? p.runs : [];
        const runs: PptRun[] = [];
        for (const ro of rawRuns.slice(0, MAX_RUNS_PER_PARA)) {
          if (typeof ro !== "object" || ro === null) continue;
          const r = ro as Record<string, unknown>;
          const text = hindiNorm(cleanText(r.text, MAX_RUN_TEXT));
          if (text === "") continue;
          runs.push({
            text,
            bold: r.bold === true,
            italic: r.italic === true,
            sizePt: coerceSize(r.sizePt),
            color: coerceColor(r.color),
          });
        }
        paras.push({
          runs,
          align: coerceAlign(p.align),
          bullet: p.bullet === true || undefined,
        });
      }
      shapes.push({
        x: coercePt(h.x, -1440, 4032),
        y: coercePt(h.y, -1440, 4032),
        w: coercePt(h.w, 0, 4032),
        h: coercePt(h.h, 0, 4032),
        paras,
        isTitle: h.isTitle === true,
      });
    }
    if (rawShapes.length > MAX_SHAPES_PER_SLIDE) truncated = true;
    slides.push({ shapes, notes: coerceNotes(s.notes) });
  }

  return { slides, slideW, slideH, truncated };
}

/* ------------------------------------------------------------------ */
/* Output file name (localized fallback, house conventions)             */
/* ------------------------------------------------------------------ */

/**
 * "My Deck.pptx" → "My-Deck" (spaces collapse to hyphens, path-unsafe
 * chars stripped, Devanagari survives); a nameless file falls back to
 * the localized word ("Presentation" / "प्रेज़ेंटेशन"). The caller
 * appends the extension.
 */
export function outputBaseName(fileName: string, lang: string): string {
  const base = fileName
    .replace(/\.(pptx|pptm|ppt)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return base || (lang === "hi" ? "प्रेज़ेंटेशन" : "Presentation");
}

/* ------------------------------------------------------------------ */
/* Sample deck builder (smoke fixture — a REAL minimal OOXML chain)     */
/* ------------------------------------------------------------------ */

const XMLNS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const RT_SLIDE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RT_SLIDE_LAYOUT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const RT_SLIDE_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const RT_NOTES_SLIDE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const RT_NOTES_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const RT_THEME =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";
const RT_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

export interface SamplePptxOpts {
  /** Devanagari content (the Hindi smoke render). */
  hindi?: boolean;
  /** add a tiny overflowing text box to slide 1 (overflow honesty vector). */
  overflow?: boolean;
}

interface RunSpec {
  t: string;
  sz?: number;
  b?: boolean;
  i?: boolean;
  color?: string;
}

function sRun(r: RunSpec): string {
  const fill = r.color
    ? `<a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill>`
    : "";
  const rPr =
    `<a:rPr lang="en-US" dirty="0"${r.b ? ' b="1"' : ""}${r.i ? ' i="1"' : ""}` +
    (r.sz ? ` sz="${Math.round(r.sz * 100)}"` : "") +
    `>${fill}</a:rPr>`;
  const esc = r.t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<a:r>${rPr}<a:t>${esc}</a:t></a:r>`;
}

interface ParaSpec {
  runs: RunSpec[];
  bullet?: boolean;
  algn?: string;
}

function sPara(p: ParaSpec): string {
  const pPr =
    `<a:pPr${p.algn ? ` algn="${p.algn}"` : ""}>` +
    (p.bullet === true
      ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
      : "<a:buNone/>") +
    "</a:pPr>";
  return `<a:p>${pPr}${p.runs.map(sRun).join("")}</a:p>`;
}

interface SpSpec {
  name: string;
  ph?: string;
  idx?: number;
  off: [number, number];
  ext: [number, number];
  paras: ParaSpec[];
}

function sSp(s: SpSpec): string {
  const nv =
    `<p:nvSpPr><p:cNvPr id="0" name="${s.name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    (s.ph
      ? `<p:nvPr><p:ph type="${s.ph}"${s.idx !== undefined ? ` idx="${s.idx}"` : ""}/></p:nvPr>`
      : "<p:nvPr/>") +
    "</p:nvSpPr>";
  const spPr =
    `<p:spPr><a:xfrm><a:off x="${s.off[0]}" y="${s.off[1]}"/><a:ext cx="${s.ext[0]}" cy="${s.ext[1]}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>';
  return `<p:sp>${nv}${spPr}<p:txBody><a:bodyPr/><a:lstStyle/>${s.paras
    .map(sPara)
    .join("")}</p:txBody></p:sp>`;
}

/** Group with a 2× child coordinate space (chExt = ext/2) — transform proof. */
function sGroup(
  off: [number, number],
  ext: [number, number],
  children: string[]
): string {
  const nv =
    '<p:nvGrpSpPr><p:cNvPr id="0" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>';
  const chExt: [number, number] = [
    Math.round(ext[0] / 2),
    Math.round(ext[1] / 2),
  ];
  const grpSpPr =
    `<p:grpSpPr><a:xfrm><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${chExt[0]}" cy="${chExt[1]}"/></a:xfrm></p:grpSpPr>`;
  return `<p:grpSp>${nv}${grpSpPr}${children.join("")}</p:grpSp>`;
}

/**
 * Builds a REAL minimal 2-slide .pptx (16:9) with fflate zipSync:
 * master → layout → theme chain, a title + bullet body, a 2×-scaled
 * group on slide 2, and speaker notes on slide 1. Used by the smoke.
 */
export function buildSamplePptx(opts: SamplePptxOpts = {}): Uint8Array {
  const hi = opts.hindi === true;
  const title1 = hi ? "त्रैमासिक रिपोर्ट" : "Quarterly Report";
  const body1: ParaSpec[] = [
    {
      runs: hi
        ? [
            { t: "राजस्व ", sz: 20 },
            { t: "24% बढ़ा", sz: 20, b: true },
          ]
        : [
            { t: "Revenue ", sz: 20 },
            { t: "grew 24%", sz: 20, b: true },
            { t: " this quarter.", sz: 20 },
          ],
      bullet: true,
    },
    {
      runs: hi
        ? [{ t: "डिलीवरी अब समय पर है।", sz: 20, i: true, color: "C0392B" }]
        : [
            {
              t: "Delivery slipped — now back on schedule.",
              sz: 20,
              i: true,
              color: "C0392B",
            },
          ],
      bullet: true,
    },
    {
      runs: hi
        ? [{ t: "अगली तिमाही के लक्ष्य तय।", sz: 18 }]
        : [{ t: "Next quarter targets are set.", sz: 18 }],
    },
  ];
  const notes1 = hi
    ? "वक्ता नोट्स: राजस्व वृद्धि पर ज़ोर दें।"
    : "Speaker notes: highlight the 24% revenue growth.";

  const slide1Shapes: string[] = [
    sSp({
      name: "Title 1",
      ph: "title",
      off: [914400, 457200],
      ext: [10363200, 1371600],
      paras: [{ runs: [{ t: title1, sz: 44, b: true, color: "1F2937" }] }],
    }),
    sSp({
      name: "Content 2",
      ph: "body",
      idx: 1,
      off: [914400, 1828800],
      ext: [10363200, 4572000],
      paras: body1,
    }),
  ];
  if (opts.overflow) {
    const filler = hi
      ? "यह पाठ अपने बॉक्स से कहीं अधिक लंबा है और ईमानदारी से ओवरफ़्लो गिना जाएगा।"
      : "This long paragraph is far taller than its tiny box on purpose so the renderer must honestly count it as overflowing text.";
    slide1Shapes.push(
      sSp({
        name: "Tiny 3",
        off: [914400, 6400800],
        ext: [1828800, 254000],
        paras: [
          { runs: [{ t: filler, sz: 14 }] },
          { runs: [{ t: filler, sz: 14 }] },
          { runs: [{ t: filler, sz: 14 }] },
        ],
      })
    );
  }

  const slide1 =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:sld ${XMLNS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>' +
    slide1Shapes.join("") +
    "</p:spTree></p:cSld></p:sld>";

  // group: child space is HALF the real size (2× scale-up)
  const stepOne = hi ? "पहला कदम" : "Step one";
  const stepTwo = hi ? "दूसरा कदम" : "Step two";
  const slide2 =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:sld ${XMLNS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>' +
    sSp({
      name: "Title 1",
      ph: "title",
      off: [914400, 457200],
      ext: [10363200, 1371600],
      paras: [
        {
          runs: [
            { t: hi ? "आगे के कदम" : "Next Steps", sz: 44, b: true, color: "1F2937" },
          ],
        },
      ],
    }) +
    sGroup(
      [914400, 1828800],
      [9144000, 4572000],
      [
        sSp({
          name: "Step 1",
          off: [0, 0],
          ext: [4572000, 1143000],
          paras: [{ runs: [{ t: stepOne, sz: 20 }] }],
        }),
        sSp({
          name: "Step 2",
          off: [0, 1143000],
          ext: [4572000, 1143000],
          paras: [{ runs: [{ t: stepTwo, sz: 20 }] }],
        }),
      ]
    ) +
    "</p:spTree></p:cSld></p:sld>";

  const notes1Xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:notes ${XMLNS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    "<p:grpSpPr/>" +
    sSp({
      name: "Notes Placeholder 2",
      ph: "body",
      idx: 1,
      off: [685800, 914400],
      ext: [5486400, 5029200],
      paras: [
        { runs: [{ t: notes1, sz: 12 }] },
        {
          runs: hi
            ? [{ t: "समाप्त।", sz: 12 }]
            : [{ t: "Wrap up on time.", sz: 12 }],
        },
      ],
    }) +
    "</p:spTree></p:cSld></p:notes>";

  const theme =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="M">' +
    '<a:themeElements><a:clrScheme name="M"><a:dk1><a:sysClr val="windowText"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="M"><a:majorFont><a:latin typeface=""/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface=""/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';

  const spTreeEmpty =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
  const slideMaster =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:sldMaster ${XMLNS}><p:cSld>${spTreeEmpty}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  const slideLayout =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:sldLayout ${XMLNS}><p:cSld name="Blank">${spTreeEmpty}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const notesMaster =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:notesMaster ${XMLNS}><p:cSld>${spTreeEmpty}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    "</p:notesMaster>";

  const presentation =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:presentation ${XMLNS}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId3"/></p:sldMasterIdLst>' +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>";

  const ct =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>' +
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    "</Types>";

  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(ct),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_OFFICE_DOCUMENT, "ppt/presentation.xml") +
        "</Relationships>"
    ),
    "ppt/presentation.xml": strToU8(presentation),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_SLIDE, "slides/slide1.xml") +
        rel("rId2", RT_SLIDE, "slides/slide2.xml") +
        rel("rId3", RT_SLIDE_MASTER, "slideMasters/slideMaster1.xml") +
        rel("rId4", RT_NOTES_MASTER, "notesMasters/notesMaster1.xml") +
        "</Relationships>"
    ),
    "ppt/slides/slide1.xml": strToU8(slide1),
    "ppt/slides/slide2.xml": strToU8(slide2),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_NOTES_SLIDE, "../notesSlides/notesSlide1.xml") +
        rel("rId2", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml") +
        "</Relationships>"
    ),
    "ppt/slides/_rels/slide2.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml") +
        "</Relationships>"
    ),
    "ppt/notesSlides/notesSlide1.xml": strToU8(notes1Xml),
    "ppt/notesSlides/_rels/notesSlide1.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_NOTES_MASTER, "../notesMasters/notesMaster1.xml") +
        rel("rId2", RT_SLIDE, "../slides/slide1.xml") +
        "</Relationships>"
    ),
    "ppt/slideMasters/slideMaster1.xml": strToU8(slideMaster),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_SLIDE_LAYOUT, "../slideLayouts/slideLayout1.xml") +
        rel("rId2", RT_THEME, "../theme/theme1.xml") +
        "</Relationships>"
    ),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(slideLayout),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_SLIDE_MASTER, "../slideMasters/slideMaster1.xml") +
        "</Relationships>"
    ),
    "ppt/notesMasters/notesMaster1.xml": strToU8(notesMaster),
    "ppt/notesMasters/_rels/notesMaster1.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", RT_THEME, "../theme/theme1.xml") +
        "</Relationships>"
    ),
    "ppt/theme/theme1.xml": strToU8(theme),
  };

  return zipSync(files as Parameters<typeof zipSync>[0]);
}
