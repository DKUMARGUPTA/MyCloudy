/**
 * Word to PDF (RB1-a — the 67th tool, rebuild) — pure model. No DOM, no
 * pdf-lib, no worker APIs: the same parseDocx feeds the surface's live
 * file summary AND the worker's render path, so the preview numbers can
 * never disagree with the output.
 *
 *  - parseDocx: fflate unzipSync → word/document.xml (plus optional
 *    word/styles.xml for heading resolution) → a dependency-free SAX-ish
 *    tokenizer (no DOMParser — workers) → blocks:
 *      {kind:"para", runs:[{text,bold,italic,sizePt?,bullet?}], align?,
 *       headingLevel?, listLevel?}
 *      {kind:"table", rows: string[][]}
 *      {kind:"pagebreak"}            (w:br w:type="page")
 *  - parseWordRun: the worker-boundary coercion (parseResumeRun pattern)
 *    — clamp arrays, strip control chars, cap every length. A tampered
 *    payload can never reach the renderer as a wrong type.
 *  - needsNoto / isWinAnsiText: pure-WinAnsi content → non-embedded
 *    base-14 Helvetica; ANY non-WinAnsi char (Devanagari, ₹ …) → the
 *    self-hosted Noto Sans Devanagari subset (fontkit).
 *  - hindiNorm: the pinned lost-session lesson — Noto subset CMaps can
 *    inject stray ASCII quotes (") between Devanagari words; strip " from
 *    strings that contain Devanagari, ONLY those.
 *
 * Honest limits (mirrored in config.ts): headers/footers, footnotes,
 * text boxes and multi-column layouts are not carried over; numbered
 * lists print as bullets; the old binary .doc format is not a ZIP and is
 * rejected up front. IMAGES (audit R4-a): <a:blip>/<v:imagedata> runs
 * inside the paragraphs the parser already walks become "image" blocks
 * anchored to their paragraph — the worker resolves them through
 * word/_rels/document.xml.rels to the media/* zip parts and embeds
 * PNG/JPEG via the shared helper (original bytes, downscale only for
 * oversized). Missing media parts, unsupported formats and images inside
 * table cells are counted honestly, never silently dropped.
 */

import { unzipSync } from "fflate";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the boundary parser)                          */
/* ------------------------------------------------------------------ */

export const MAX_PARAGRAPHS = 500;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 30;
export const MAX_BLOCKS = 800; // paras + tables + explicit breaks
export const MAX_RUN_TEXT = 2_000;
export const MAX_PARA_TEXT = 10_000;
export const MAX_CELL_TEXT = 1_000;
export const MAX_RUNS_PER_PARA = 200;
/** Embedded images carried into the PDF (audit R4-a) — beyond is an
 * honest truncation, never a silent drop. */
export const MAX_IMAGES = 50;
/** relationship Id → Target pairs carried through the boundary. */
export const MAX_RELS = 200;

/* ------------------------------------------------------------------ */
/* Doc model                                                            */
/* ------------------------------------------------------------------ */

export type DocxAlign = "left" | "center" | "right" | "justify";

export interface DocxRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** explicit w:sz / w:szCs half-point size in pt (4–72). */
  sizePt?: number;
  /** true on the first run of a list-item paragraph (w:numPr). */
  bullet?: boolean;
}

export interface DocxParaBlock {
  kind: "para";
  runs: DocxRun[];
  align?: DocxAlign;
  /** 0 = Title, 1..3 = Heading1..3 (deeper Word levels flatten to 3). */
  headingLevel?: 0 | 1 | 2 | 3;
  /** present when the paragraph is a list item (w:numPr) — 0..3 nesting. */
  listLevel?: number;
}

export interface DocxTableBlock {
  kind: "table";
  rows: string[][];
}

export interface DocxPageBreakBlock {
  kind: "pagebreak";
}

/**
 * One embedded image anchored to the paragraph that carried it (audit
 * R4-a). `relId` is the <a:blip r:embed>/<v:imagedata r:id> relationship
 * id — the worker maps it to the media/* zip part via ParsedDoc.media.
 */
export interface DocxImageBlock {
  kind: "image";
  relId: string;
}

export type DocxBlock = DocxParaBlock | DocxTableBlock | DocxPageBreakBlock | DocxImageBlock;

export interface ParsedDoc {
  blocks: DocxBlock[];
  paraCount: number;
  tableCount: number;
  wordCount: number;
  charCount: number;
  /** document.xml.rels Id → Target pairs (image resolution). */
  media: Record<string, string>;
  /** image blocks kept (≤ MAX_IMAGES — the honest parse-level count). */
  imageCount: number;
  /** images found but honestly not carried (table cells, over-cap). */
  imagesDropped: number;
  /** true when any hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

function emptyDoc(): ParsedDoc {
  return {
    blocks: [],
    paraCount: 0,
    tableCount: 0,
    wordCount: 0,
    charCount: 0,
    media: {},
    imageCount: 0,
    imagesDropped: 0,
    truncated: false,
  };
}

/** Honest stats derived from the blocks alone (parse + coercion agree). */
interface DocTextStats {
  paraCount: number;
  tableCount: number;
  wordCount: number;
  charCount: number;
}

function docStats(blocks: DocxBlock[]): DocTextStats {
  let paraCount = 0;
  let tableCount = 0;
  let words = 0;
  let chars = 0;
  const count = (s: string): void => {
    chars += s.length;
    words += s.split(/\s+/).filter(Boolean).length;
  };
  for (const b of blocks) {
    if (b.kind === "para") {
      paraCount += 1;
      for (const r of b.runs) count(r.text);
    } else if (b.kind === "table") {
      tableCount += 1;
      for (const row of b.rows) for (const cell of row) count(cell);
    }
  }
  return { paraCount, tableCount, wordCount: words, charCount: chars };
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (create-resume copy) */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true when every char is encodable in WinAnsi (CP1252) minus controls. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** true when any drawn text needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(doc: ParsedDoc): boolean {
  for (const b of doc.blocks) {
    if (b.kind === "para") {
      for (const r of b.runs) if (!isWinAnsiText(r.text)) return true;
    } else if (b.kind === "table") {
      for (const row of b.rows) {
        for (const cell of row) if (!isWinAnsiText(cell)) return true;
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
 * Tolerant linear tokenizer for well-formed Word XML: real elements emit
 * open/close (self-closing emits both), <?…?> / <!--…--> / <![CDATA[…]]>
 * are skipped (CDATA becomes raw text), everything else between tags is
 * text with entity decoding. Malformed input degrades instead of throwing.
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
/* styles.xml → styleId → heading level (0 = Title, 1..9)               */
/* ------------------------------------------------------------------ */

function parseStylesXml(xml: string): Map<string, number> {
  const map = new Map<string, number>();
  let styleId = ""; // active paragraph style id ("" = not tracking)
  let nameVal = ""; // its w:name val
  let outline: number | null = null; // its w:outlineLvl, 1-based
  parseXmlSax(xml, {
    open(name, attrs) {
      if (prefixOf(name) !== "w") return;
      const local = localName(name);
      if (local === "style") {
        const id = attrs["w:styleId"] ?? "";
        styleId =
          id && (attrs["w:type"] === undefined || attrs["w:type"] === "paragraph")
            ? id
            : "";
        nameVal = "";
        outline = null;
      } else if (local === "name" && styleId) {
        nameVal = attrs["w:val"] ?? "";
      } else if (local === "outlineLvl" && styleId) {
        const v = Number.parseInt(attrs["w:val"] ?? "", 10);
        outline = Number.isFinite(v) && v >= 0 && v <= 8 ? v + 1 : null;
      }
    },
    text() {
      /* style names/levels live in attributes, never text */
    },
    close(name) {
      if (prefixOf(name) !== "w" || localName(name) !== "style") return;
      if (styleId) {
        const trim = nameVal.trim();
        let level: number | undefined;
        if (/^title$/i.test(trim)) {
          level = 0;
        } else {
          const m = /^heading[ \-]?([1-9])$/i.exec(trim);
          if (m) level = Number.parseInt(m[1], 10);
          else if (outline !== null) level = outline;
        }
        if (level !== undefined) map.set(styleId, level);
      }
      styleId = "";
    },
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* document.xml assembler                                               */
/* ------------------------------------------------------------------ */

const ALIGN_MAP: Record<string, DocxAlign> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  justify: "justify",
};

/** "Heading1"/"Title" style ids map directly (English Word UI ids). */
function directHeadingLevel(styleId: string): number | undefined {
  const t = /^title$/i.exec(styleId);
  if (t) return 0;
  const m = /^heading([1-9])$/i.exec(styleId);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/** Half-point string → pt (4..72), undefined when absent/invalid. */
function halfPointsToPt(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const hp = Number.parseInt(val, 10);
  if (!Number.isFinite(hp)) return undefined;
  const pt = hp / 2;
  return pt >= 4 && pt <= 72 ? pt : undefined;
}

/** w:b / w:bCs toggles: absent = on, "0"/"false"/"none" = off. */
function toggleVal(attrs: Record<string, string>): boolean {
  const v = attrs["w:val"];
  return v === undefined || (v !== "0" && v !== "false" && v !== "none");
}

interface RunState {
  text: string;
  bold: boolean;
  italic: boolean;
  sizePt: number | undefined;
}

interface ParaState {
  runs: DocxRun[];
  run: RunState | null;
  styleId: string;
  align: DocxAlign | undefined;
  listLevel: number; // -1 = not a list item
  pageBreak: boolean;
  firstRunDone: boolean;
  textLen: number;
}

interface TableFrame {
  rows: string[][];
}

interface CellFrame {
  texts: string[];
}

/**
 * Streams the tokenizer events into blocks. All state is plain fields —
 * the class exists only to keep the handlers together; it is pure.
 */
class DocxAssembler {
  private readonly styles: Map<string, number>;
  readonly blocks: DocxBlock[] = [];
  private paraBlocks = 0;
  private imageBlocks = 0;
  imagesDropped = 0;
  truncated = false;

  /* --- walker state --- */
  private depth = 0;
  private inBody = false;
  /** depth of the outermost ignored element (drawing/pict/sectPr), -1 = off. */
  private skipDepth = -1;
  /** relationship ids of the images inside the paragraph being closed. */
  private pendingImages: string[] = [];
  private tableStack: TableFrame[] = [];
  private rowStack: string[][] = [];
  private cellStack: CellFrame[] = [];
  private para: ParaState | null = null;
  private inNumPr = false;
  private textTarget = false;

  constructor(styles: Map<string, number>) {
    this.styles = styles;
  }

  private pushBlock(b: DocxBlock): void {
    if (this.blocks.length >= MAX_BLOCKS) {
      this.truncated = true;
      return;
    }
    if (b.kind === "para") {
      if (this.paraBlocks >= MAX_PARAGRAPHS) {
        this.truncated = true;
        return;
      }
      this.paraBlocks += 1;
    }
    this.blocks.push(b);
  }

  readonly handlers: SaxHandlers = {
    open: (name, attrs) => {
      this.depth += 1;
      if (this.skipDepth !== -1) {
        // Inside a skipped drawing/pict the image blip is STILL the
        // honest signal we need (audit R4-a) — capture its relationship
        // id; everything else inside stays ignored.
        const skipped = localName(name);
        if (skipped === "blip") {
          const rel = attrs["r:embed"] ?? attrs["r:link"] ?? "";
          if (rel !== "" && this.para !== null) this.pendingImages.push(rel);
        } else if (skipped === "imagedata") {
          const rel = attrs["r:id"] ?? "";
          if (rel !== "" && this.para !== null) this.pendingImages.push(rel);
        }
        return;
      }
      const local = localName(name);
      if (local === "sectPr") {
        this.skipDepth = this.depth;
        return;
      }
      // drawings / VML pictures: their text/layout is still skipped
      // wholesale (text boxes, shapes), but a:blip / v:imagedata inside
      // them is captured above as an image anchor (audit R4-a).
      if (local === "drawing" || local === "pict") {
        this.skipDepth = this.depth;
        return;
      }
      if (prefixOf(name) !== "w") return;
      switch (local) {
        case "body":
          this.inBody = true;
          break;
        case "tbl":
          this.tableStack.push({ rows: [] });
          break;
        case "tr":
          this.rowStack.push([]);
          break;
        case "tc":
          this.cellStack.push({ texts: [] });
          break;
        case "p":
          this.para = {
            runs: [],
            run: null,
            styleId: "",
            align: undefined,
            listLevel: -1,
            pageBreak: false,
            firstRunDone: false,
            textLen: 0,
          };
          this.pendingImages = [];
          break;
        case "r": {
          const para = this.para;
          if (para !== null && para.run === null) {
            para.run = { text: "", bold: false, italic: false, sizePt: undefined };
          }
          break;
        }
        case "pStyle":
          if (this.para !== null) this.para.styleId = attrs["w:val"] ?? "";
          break;
        case "jc":
          if (this.para !== null) {
            this.para.align = ALIGN_MAP[attrs["w:val"] ?? ""] ?? undefined;
          }
          break;
        case "numPr":
          if (this.para !== null) {
            this.inNumPr = true;
            this.para.listLevel = 0;
          }
          break;
        case "ilvl":
          if (this.inNumPr && this.para !== null) {
            const v = Number.parseInt(attrs["w:val"] ?? "0", 10);
            this.para.listLevel = Number.isFinite(v) && v >= 0 ? Math.min(v, 3) : 0;
          }
          break;
        case "numId":
          // numId 0 explicitly CANCELS a list inherited from the style.
          if (this.inNumPr && this.para !== null && (attrs["w:val"] ?? "") === "0") {
            this.para.listLevel = -1;
          }
          break;
        case "b":
        case "bCs": {
          const run = this.para?.run;
          if (run) run.bold = run.bold || toggleVal(attrs);
          break;
        }
        case "i":
        case "iCs": {
          const run = this.para?.run;
          if (run) run.italic = run.italic || toggleVal(attrs);
          break;
        }
        case "sz": {
          const run = this.para?.run;
          if (run && run.sizePt === undefined) {
            run.sizePt = halfPointsToPt(attrs["w:val"]);
          }
          break;
        }
        case "szCs": {
          const run = this.para?.run;
          if (run && run.sizePt === undefined) {
            run.sizePt = halfPointsToPt(attrs["w:val"]);
          }
          break;
        }
        case "t":
          this.textTarget = true;
          break;
        case "tab": {
          const run = this.para?.run;
          if (run) run.text += "\t";
          break;
        }
        case "br": {
          if (attrs["w:type"] === "page") {
            if (this.para !== null) this.para.pageBreak = true;
          } else {
            const run = this.para?.run;
            if (run) run.text += "\n";
          }
          break;
        }
        default:
          break;
      }
    },

    text: (value) => {
      if (!this.textTarget) return;
      const run = this.para?.run;
      if (run) run.text += hindiNorm(value);
    },

    close: (name) => {
      const closingDepth = this.depth;
      this.depth = Math.max(0, this.depth - 1);
      if (this.skipDepth !== -1) {
        if (closingDepth === this.skipDepth) this.skipDepth = -1;
        return;
      }
      const local = localName(name);
      if (prefixOf(name) !== "w") return;
      switch (local) {
        case "body":
          this.inBody = false;
          break;
        case "t":
          this.textTarget = false;
          break;
        case "numPr":
          this.inNumPr = false;
          break;
        case "r":
          this.endRun();
          break;
        case "p":
          this.endPara();
          break;
        case "tc": {
          const cell = this.cellStack.pop();
          if (cell && this.rowStack.length > 0) {
            const row = this.rowStack[this.rowStack.length - 1];
            if (row.length < MAX_TABLE_COLS) {
              row.push(cell.texts.join("\n").slice(0, MAX_CELL_TEXT));
            } else {
              this.truncated = true;
            }
          }
          break;
        }
        case "tr": {
          const row = this.rowStack.pop();
          if (row && this.tableStack.length > 0) {
            const table = this.tableStack[this.tableStack.length - 1];
            if (table.rows.length < MAX_TABLE_ROWS) table.rows.push(row);
            else this.truncated = true;
          }
          break;
        }
        case "tbl": {
          const table = this.tableStack.pop();
          if (!table) break;
          if (this.tableStack.length === 0) {
            if (table.rows.length > 0) {
              this.pushBlock({ kind: "table", rows: table.rows });
            }
          } else if (this.cellStack.length > 0) {
            // nested table inside a cell — flatten its text honestly.
            const cell = this.cellStack[this.cellStack.length - 1];
            const flat = table.rows.map((r) => r.join(" ")).join(" ");
            if (flat) cell.texts.push(flat.slice(0, MAX_CELL_TEXT));
          }
          break;
        }
        default:
          break;
      }
    },
  };

  /** Non-empty text runs become blocks; the first one carries the bullet. */
  private endRun(): void {
    const para = this.para;
    if (!para || !para.run) return;
    const run = para.run;
    para.run = null;
    if (run.text === "") return;
    const text = run.text.slice(0, MAX_RUN_TEXT);
    if (text === "") return;
    if (para.runs.length >= MAX_RUNS_PER_PARA || para.textLen >= MAX_PARA_TEXT) {
      this.truncated = true;
      return;
    }
    para.textLen += text.length;
    para.runs.push({
      text,
      bold: run.bold,
      italic: run.italic,
      sizePt: run.sizePt,
      bullet: para.listLevel >= 0 && !para.firstRunDone ? true : undefined,
    });
    para.firstRunDone = true;
  }

  /** Image anchors become blocks right after their paragraph; caps are
   *  honest (truncated + counted), never silent. */
  private flushImages(): void {
    if (this.pendingImages.length === 0) return;
    const pending = this.pendingImages;
    this.pendingImages = [];
    if (!this.inBody) {
      this.imagesDropped += pending.length;
      return;
    }
    if (this.cellStack.length > 0) {
      // images inside table cells — honestly not carried (audit R4-a)
      this.imagesDropped += pending.length;
      return;
    }
    for (const rel of pending) {
      if (this.imageBlocks >= MAX_IMAGES) {
        this.truncated = true;
        this.imagesDropped += 1;
        continue;
      }
      const relId = rel.slice(0, 200);
      if (relId === "") {
        this.imagesDropped += 1;
        continue;
      }
      this.imageBlocks += 1;
      this.pushBlock({ kind: "image", relId });
    }
  }

  private endPara(): void {
    const para = this.para;
    this.para = null;
    this.inNumPr = false;
    if (!para) {
      this.pendingImages = [];
      return;
    }

    if (this.cellStack.length > 0) {
      // paragraph inside a table cell — contributes to the cell text;
      // its images are honestly not carried (audit R4-a)
      this.imagesDropped += this.pendingImages.length;
      this.pendingImages = [];
      const cell = this.cellStack[this.cellStack.length - 1];
      cell.texts.push(para.runs.map((r) => r.text).join("").slice(0, MAX_CELL_TEXT));
      return;
    }
    if (!this.inBody) {
      this.imagesDropped += this.pendingImages.length;
      this.pendingImages = [];
      return;
    }

    const text = para.runs.map((r) => r.text).join("");
    const isList = para.listLevel >= 0;
    const hasText = text.trim().length > 0;
    const hasImages = this.pendingImages.length > 0;

    if (!hasText && para.pageBreak) {
      this.pushBlock({ kind: "pagebreak" });
      this.flushImages();
      return;
    }
    if (!hasText && !isList) {
      if (!hasImages) {
        // Word's empty spacing paragraph — keep one honest blank line.
        this.pushBlock({ kind: "para", runs: [] });
        return;
      }
      // an image-only paragraph carries no blank line (audit R4-a)
      this.flushImages();
      return;
    }

    let headingLevel: 0 | 1 | 2 | 3 | undefined;
    const direct = directHeadingLevel(para.styleId);
    const viaStyles = direct === undefined ? this.styles.get(para.styleId) : direct;
    if (viaStyles !== undefined) {
      headingLevel = viaStyles === 0 ? 0 : (Math.min(3, viaStyles) as 1 | 2 | 3);
    }

    this.pushBlock({
      kind: "para",
      runs: para.runs,
      align: para.align,
      headingLevel,
      listLevel: isList ? para.listLevel : undefined,
    });
    if (para.pageBreak) this.pushBlock({ kind: "pagebreak" });
    this.flushImages();
  }

  finish(): ParsedDoc {
    return {
      blocks: this.blocks,
      ...docStats(this.blocks),
      media: {},
      imageCount: this.imageBlocks,
      imagesDropped: this.imagesDropped,
      truncated: this.truncated,
    };
  }
}

/* ------------------------------------------------------------------ */
/* document.xml.rels → media parts (audit R4-a)                          */
/* ------------------------------------------------------------------ */

/** Parses the document relationships: Id → Target (relative to word/). */
function parseDocumentRels(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  parseXmlSax(xml, {
    open(name, attrs) {
      if (localName(name) !== "Relationship") return;
      const id = attrs["Id"] ?? "";
      const target = attrs["Target"] ?? "";
      if (id !== "" && target !== "") map[id] = target;
    },
    text() {},
    close() {},
  });
  return map;
}

/**
 * Resolves a relationship Target to a zip path. word/_rels/document.xml.rels
 * Targets are relative to the word/ PART (OOPC §10.1.2): "media/image1.png"
 * → "word/media/image1.png", "/word/media/x.png" (package-absolute) →
 * "word/media/x.png", "../glossary/pic.png" climbs honestly out of word/
 * ("glossary/pic.png"). External schemes (http:, file:) return "" — never
 * fetched, on-device promise.
 */
export function resolveMediaPath(target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return "";
  let t = target.replace(/\\/g, "/");
  const q = t.indexOf("?");
  if (q >= 0) t = t.slice(0, q);
  const h = t.indexOf("#");
  if (h >= 0) t = t.slice(0, h);
  // Targets resolve against word/ (the rels' owning part); a leading
  // slash is package-absolute. ".." pops honestly (word/ → root).
  const out = t.startsWith("/") ? [] : ["word"];
  for (const part of t.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? "" : out.join("/");
}

/**
 * Zip member lookup for media parts: exact key first, then a
 * case-insensitive unique match (some writers differ in case).
 */
export function lookupMediaEntry(
  entries: Record<string, Uint8Array>,
  path: string
): Uint8Array | undefined {
  const direct = entries[path];
  if (direct !== undefined) return direct;
  const lower = path.toLowerCase();
  let hit: Uint8Array | undefined;
  for (const key of Object.keys(entries)) {
    if (key.toLowerCase() === lower) {
      if (hit !== undefined) return undefined; // ambiguous — treat as miss
      hit = entries[key];
    }
  }
  return hit;
}

/* ------------------------------------------------------------------ */
/* parseDocx                                                            */
/* ------------------------------------------------------------------ */

/**
 * Unzips a .docx (OOXML ZIP) and extracts the body flow. Any failure —
 * not a ZIP, no word/document.xml, empty body — returns an EMPTY doc
 * (the caller decides whether that is an error for the user).
 */
export function parseDocx(bytes: Uint8Array): ParsedDoc {
  let entries: Record<string, Uint8Array> | null = null;
  try {
    entries = unzipSync(bytes) as Record<string, Uint8Array>;
  } catch {
    return emptyDoc();
  }
  const docBytes = entries?.["word/document.xml"];
  if (!docBytes || docBytes.length === 0) return emptyDoc();

  const decode = (b: Uint8Array): string => {
    let s = new TextDecoder("utf-8", { fatal: false }).decode(b);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  };

  let styles = new Map<string, number>();
  const styleBytes = entries?.["word/styles.xml"];
  if (styleBytes && styleBytes.length > 0) {
    try {
      styles = parseStylesXml(decode(styleBytes));
    } catch {
      styles = new Map();
    }
  }

  const asm = new DocxAssembler(styles);
  try {
    parseXmlSax(decode(docBytes), asm.handlers);
  } catch {
    return emptyDoc();
  }
  const doc = asm.finish();
  // the image relationships (audit R4-a) — a missing/broken rels part
  // degrades to an empty map (the worker then skips images honestly)
  const relsBytes = entries?.["word/_rels/document.xml.rels"];
  if (relsBytes && relsBytes.length > 0) {
    try {
      doc.media = parseDocumentRels(decode(relsBytes));
    } catch {
      doc.media = {};
    }
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* parseWordRun — worker-boundary coercion (parseResumeRun pattern)     */
/* ------------------------------------------------------------------ */

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

function coerceAlign(v: unknown): DocxAlign | undefined {
  return v === "left" || v === "center" || v === "right" || v === "justify"
    ? v
    : undefined;
}

function coerceHeading(v: unknown): 0 | 1 | 2 | 3 | undefined {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return undefined;
  if (n === 0) return 0;
  if (n >= 1 && n <= 3) return n as 1 | 2 | 3;
  return undefined;
}

function coerceLevel(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(3, Math.floor(n));
}

function coerceSize(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return n >= 4 && n <= 72 ? n : undefined;
}

/**
 * Full defensive coercion of a serialized ParsedDoc at the worker
 * boundary: garbage → empty doc, arrays clamped, every text capped,
 * unknown enum values dropped. Also re-derives listLevel from run-level
 * bullet flags when the block forgot it.
 */
export function parseWordRun(raw: string): ParsedDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDoc();
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(o.blocks)) return emptyDoc();

  let truncated = o.truncated === true;
  const blocks: DocxBlock[] = [];
  let paraBlocks = 0;
  let imageBlocks = 0;
  const imagesDroppedRaw = Number(o.imagesDropped);
  let imagesDropped =
    Number.isFinite(imagesDroppedRaw) && imagesDroppedRaw > 0
      ? Math.min(10_000, Math.floor(imagesDroppedRaw))
      : 0;
  // relationship Id → Target map (audit R4-a) — sanitized at the boundary
  const media: Record<string, string> = {};
  if (typeof o.media === "object" && o.media !== null) {
    for (const [key, value] of Object.entries(o.media as Record<string, unknown>)) {
      if (Object.keys(media).length >= MAX_RELS) {
        truncated = true;
        break;
      }
      const safeKey = cleanText(key, 200);
      const safeTarget = cleanText(value, 300);
      if (safeKey !== "" && safeTarget !== "") media[safeKey] = safeTarget;
    }
  }

  outer: for (const bo of o.blocks) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    if (typeof bo !== "object" || bo === null) continue;
    const b = bo as Record<string, unknown>;
    const kind = b.kind;

    if (kind === "pagebreak") {
      blocks.push({ kind: "pagebreak" });
      continue;
    }

    if (kind === "image") {
      // image anchor (audit R4-a): the relId is the ONLY payload; caps
      // are honest (truncated + counted), garbage relIds are dropped.
      const rawRel = typeof b.relId === "string" ? b.relId : "";
      const relId = cleanText(rawRel, 200).replace(/[^A-Za-z0-9_.\-]/g, "");
      if (relId === "") {
        imagesDropped += 1;
        continue;
      }
      if (imageBlocks >= MAX_IMAGES) {
        truncated = true;
        imagesDropped += 1;
        continue;
      }
      imageBlocks += 1;
      blocks.push({ kind: "image", relId });
      continue;
    }

    if (kind === "table") {
      const rawRows = Array.isArray(b.rows) ? b.rows : [];
      const rows: string[][] = [];
      for (const ro of rawRows) {
        if (rows.length >= MAX_TABLE_ROWS) {
          truncated = true;
          break;
        }
        if (!Array.isArray(ro)) continue;
        const cells: string[] = [];
        for (const co of ro) {
          if (cells.length >= MAX_TABLE_COLS) {
            truncated = true;
            break;
          }
          cells.push(hindiNorm(cleanText(co, MAX_CELL_TEXT)));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }

    if (kind !== "para") continue;
    if (paraBlocks >= MAX_PARAGRAPHS) {
      truncated = true;
      break outer;
    }
    const rawRuns = Array.isArray(b.runs) ? b.runs : [];
    const runs: DocxRun[] = [];
    let textLen = 0;
    let bulletSeen = false;
    for (const ro of rawRuns) {
      if (runs.length >= MAX_RUNS_PER_PARA || textLen >= MAX_PARA_TEXT) {
        truncated = true;
        break;
      }
      if (typeof ro !== "object" || ro === null) continue;
      const r = ro as Record<string, unknown>;
      let text = hindiNorm(cleanText(r.text, MAX_RUN_TEXT));
      if (textLen + text.length > MAX_PARA_TEXT) {
        text = text.slice(0, Math.max(0, MAX_PARA_TEXT - textLen));
      }
      if (text === "") continue;
      textLen += text.length;
      const bullet = r.bullet === true;
      if (bullet) bulletSeen = true;
      runs.push({
        text,
        bold: r.bold === true,
        italic: r.italic === true,
        sizePt: coerceSize(r.sizePt),
        bullet: bullet || undefined,
      });
    }
    const headingLevel = coerceHeading(b.headingLevel);
    const align = coerceAlign(b.align);
    let listLevel = coerceLevel(b.listLevel);
    if (listLevel === undefined && bulletSeen) listLevel = 0;
    if (runs.length === 0 && listLevel === undefined && headingLevel === undefined && align === undefined) {
      // preserve honest blank lines, drop fully-empty husks
      blocks.push({ kind: "para", runs: [] });
      paraBlocks += 1;
      continue;
    }
    blocks.push({
      kind: "para",
      runs,
      align,
      headingLevel,
      listLevel,
    });
    paraBlocks += 1;
  }

  return {
    blocks,
    ...docStats(blocks),
    media,
    imageCount: imageBlocks,
    imagesDropped,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Output file name (house pdf-to-txt convention + localized fallback)  */
/* ------------------------------------------------------------------ */

/**
 * "Report v2.docx" → "Report v2.pdf"; a nameless file falls back to the
 * localized word ("document" / "दस्तावेज़"). Unicode survives; path
 * separators and unsafe chars do not.
 */
export function outputPdfName(fileName: string, fileWord: string): string {
  const base = fileName
    .replace(/\.(docx|doc)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  const fallback = cleanText(fileWord, 60).trim() || "document";
  return `${base || fallback}.pdf`;
}
