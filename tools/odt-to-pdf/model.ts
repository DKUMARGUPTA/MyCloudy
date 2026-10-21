/**
 * OpenDocument to PDF (RB2-b — the 72nd MyCloudy tool) — pure model.
 * No DOM, no pdf-lib, no worker APIs: the same parseOdt feeds the
 * surface's live file summary AND the worker's render path, so the
 * preview numbers can never disagree with the output.
 *
 *  - parseOdt(bytes): ODT/ODS are ZIPs (mimetype + content.xml +
 *    styles.xml — mimetype must be the first STORED entry, honoured by
 *    the sample builders). fflate unzipSync → content.xml scanned by a
 *    dependency-free tokenizer (no DOMParser — workers) → typed IR:
 *      {kind:"text",   blocks: heading(1-6) | para | list-item | table}
 *      {kind:"sheets", sheets: {name, grid: string[][]}}
 *    The document kind is decided by the BODY element (office:text vs
 *    office:spreadsheet); office:presentation / office:drawing are
 *    rejected honestly (.odp/.odg exist in the wild but are rare).
 *  - Styles: style:style (family text|paragraph) in styles.xml AND
 *    content.xml automatic-styles → fo:font-weight, font-style,
 *    fo:font-size ("12pt" and "0.3528cm" forms) with
 *    style:parent-style-name chains.
 *  - Text body: text:h (outline-level 1-6), text:p, text:list →
 *    text:list-item → text:p (nesting depth), text:section (transparent),
 *    text:span (inline runs, bold/italic/size from styles),
 *    office:annotation + draw:frame + text:note skipped honestly,
 *    text:s (space repeat), text:tab, text:line-break.
 *  - Tables (ODT) and sheets (ODS): table:table → table:table-row →
 *    table:table-cell with office:value-type (string/float/currency/
 *    percentage/boolean/date/time — text:p content preferred,
 *    office:value formatted as fallback), table:number-columns-repeated
 *    and table:number-rows-repeated expansions (LibreOffice pads empty
 *    grid runs — expansions are capped, trailing blanks trimmed).
 *  - Hard caps with an honest truncated flag: 500 paragraphs,
 *    800 blocks, 50 × 30 text-table cells, 10 sheets, 500 × 100 sheet
 *    cells (documented in the FAQ + surfaced as a note).
 *  - needsNoto / isWinAnsiText: pure-WinAnsi content → non-embedded
 *    base-14 Helvetica; ANY non-WinAnsi char (Devanagari, ₹ …) → the
 *    self-hosted Noto Sans Devanagari subset (fontkit).
 *  - buildSampleOdt / buildSampleOds: REAL minimal ODF packages via
 *    fflate zipSync (mimetype first + stored, content.xml, styles.xml,
 *    META-INF/manifest.xml) — used by the smoke as fixtures.
 */

import { unzipSync, zipSync, strToU8, type Unzipped } from "fflate";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the FAQ + the honest note)                    */
/* ------------------------------------------------------------------ */

export const MAX_PARAGRAPHS = 500; // para + heading + list-item blocks
export const MAX_BLOCKS = 800;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 30;
export const MAX_CELL_TEXT = 1_000;
export const MAX_RUN_TEXT = 2_000;
export const MAX_PARA_TEXT = 10_000;
export const MAX_RUNS_PER_PARA = 200;
export const MAX_SHEETS = 10;
export const MAX_SHEET_ROWS = 500;
export const MAX_SHEET_COLS = 100;
export const MAX_CELL_CHARS = 2_000;

/* ------------------------------------------------------------------ */
/* Doc model                                                            */
/* ------------------------------------------------------------------ */

export interface OdfRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** explicit fo:font-size from a style chain, in pt (4–72). */
  sizePt?: number;
}

export interface OdfHeadingBlock {
  kind: "heading";
  /** text:outline-level 1-6. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  runs: OdfRun[];
}

export interface OdfParaBlock {
  kind: "para";
  runs: OdfRun[];
}

export interface OdfListBlock {
  kind: "list-item";
  /** 0-based text:list nesting depth. */
  level: number;
  runs: OdfRun[];
}

export interface OdfTableBlock {
  kind: "table";
  /** table:name when present (ODT); sheets carry their own name. */
  name?: string;
  rows: string[][];
}

export type OdfTextBlock =
  | OdfHeadingBlock
  | OdfParaBlock
  | OdfListBlock
  | OdfTableBlock;

export interface OdfSheet {
  name: string;
  /** Dense grid; ragged rows allowed, trailing blanks trimmed. */
  grid: string[][];
}

export type ParsedOdf =
  | { kind: "text"; blocks: OdfTextBlock[]; truncated: boolean }
  | {
      kind: "sheets";
      sheets: OdfSheet[];
      truncated: boolean;
      sheetsTruncated: boolean;
    };

/* ------------------------------------------------------------------ */
/* Error codes (the worker maps them to i18n keys "odt.<code>")        */
/* ------------------------------------------------------------------ */

export type OdfErrorCode =
  | "errNotZip"
  | "errCorrupt"
  | "errOdp"
  | "errOdg"
  | "errNoContent"
  | "errEmpty";

export class OdfParseError extends Error {
  readonly code: OdfErrorCode;
  constructor(code: OdfErrorCode) {
    super(code);
    this.code = code;
    this.name = "OdfParseError";
  }
}

/* ------------------------------------------------------------------ */
/* Magic sniffing (shared by the surface DropZone + the worker)        */
/* ------------------------------------------------------------------ */

/** ZIP local-file magic "PK\x03\x04" (spanned/empty zips rejected). */
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
 * Any ZIP signature: local-file (PK\x03\x04), spanning (PK\x07\x08) or
 * end-of-central-directory (PK\x05\x06 — an archive with zero entries
 * consists of the EOCD record alone; it IS a zip, just an empty one, so
 * the honest error is errNoContent, not errNotZip).
 */
function hasZipSignature(head: Uint8Array): boolean {
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return false;
  const kind = (head[2] << 8) | head[3];
  return kind === 0x0304 || kind === 0x0506 || kind === 0x0708;
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
    if (c === 0x09) continue; // tab — whitespace the renderer never draws
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** true when any drawn text needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(doc: ParsedOdf): boolean {
  if (doc.kind === "text") {
    for (const b of doc.blocks) {
      if (b.kind === "table") {
        for (const row of b.rows) {
          for (const cell of row) if (!isWinAnsiText(cell)) return true;
        }
      } else {
        for (const r of b.runs) if (!isWinAnsiText(r.text)) return true;
      }
    }
    return false;
  }
  for (const sheet of doc.sheets) {
    if (!isWinAnsiText(sheet.name)) return true;
    for (const row of sheet.grid) {
      for (const cell of row) if (!isWinAnsiText(cell)) return true;
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
/* XML tokenizer (dependency-free — no DOMParser in workers)           */
/* ------------------------------------------------------------------ */

export interface XmlAttrMap {
  [name: string]: string;
}

export type XmlEvent =
  | { kind: "open"; name: string; attrs: XmlAttrMap; selfClose: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decodes &amp; &lt; &gt; &quot; &apos; &#NN; &#xHH; (unknown pass through). */
export function decodeXmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, entity: string) => {
      if (entity.charCodeAt(0) === 35 /* # */) {
        const hex = entity[1] === "x" || entity[1] === "X";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return whole;
          }
        }
        return whole;
      }
      const named = NAMED_ENTITIES[entity];
      return named !== undefined ? named : whole;
    }
  );
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * Streams XML as open/close/text events (attribute names keep their
 * prefixes — "office:value-type"). Comments, PIs, DOCTYPE and CDATA are
 * handled; the close-bracket scan is quote-aware. Self-closing elements
 * emit ONLY the open event with selfClose=true.
 */
export function scanXml(
  xml: string,
  onEvent: (event: XmlEvent) => void
): void {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < n) {
        onEvent({ kind: "text", text: decodeXmlEntities(xml.slice(i)) });
      }
      return;
    }
    if (lt > i) {
      onEvent({ kind: "text", text: decodeXmlEntities(xml.slice(i, lt)) });
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("!--", lt + 1)) {
      const end = xml.indexOf("-->", lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("![CDATA[", lt + 1)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end < 0 ? n : end;
      onEvent({ kind: "text", text: xml.slice(lt + 9, stop) }); // raw
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 33 /* ! */) {
      const end = xml.indexOf(">", lt); // DOCTYPE etc.
      i = end < 0 ? n : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = 0;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 0x22 || ch === 0x27) {
        quote = ch;
      } else if (ch === 0x3e /* > */) {
        break;
      }
      j += 1;
    }
    if (j >= n) return; // malformed tail
    const inner = xml.slice(lt + 1, j);
    i = j + 1;
    if (inner.charCodeAt(0) === 0x2f /* / */) {
      onEvent({ kind: "close", name: inner.slice(1).trim() });
      continue;
    }
    const selfClose = inner.charCodeAt(inner.length - 1) === 0x2f;
    const body = selfClose ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const attrs: XmlAttrMap = {};
    const attrRe = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(body)) !== null) {
      const raw = am[2] !== undefined ? am[2] : am[3] ?? "";
      attrs[am[1]] = decodeXmlEntities(raw);
    }
    onEvent({ kind: "open", name: nameMatch[1], attrs, selfClose });
  }
}

/**
 * Attribute lookup that tolerates any prefix ("office:value-type" and
 * "x:value-type" both match local "value-type").
 */
function attrOf(attrs: XmlAttrMap, local: string): string {
  const direct = attrs[local];
  if (direct !== undefined) return direct;
  const suffix = ":" + local;
  for (const k in attrs) {
    if (
      k.length > suffix.length &&
      k.slice(k.length - suffix.length) === suffix
    ) {
      return attrs[k];
    }
  }
  return "";
}

function intAttr(attrs: XmlAttrMap, local: string): number {
  const v = Number.parseInt(attrOf(attrs, local), 10);
  return Number.isFinite(v) && v >= 1 ? v : 0;
}

/* ------------------------------------------------------------------ */
/* Styles (styles.xml + content.xml automatic-styles)                   */
/* ------------------------------------------------------------------ */

interface StyleProps {
  bold?: boolean;
  italic?: boolean;
  sizePt?: number;
  parent?: string;
}

/** "12pt" | "0.3528cm" | "10.5pt" | "14" … → pt (4–72), undefined when absent. */
function parseFontSize(val: string): number | undefined {
  const m = /^\s*(-?[\d.]+)\s*(pt|cm|mm|in|pc|px)?\s*$/.exec(val);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2] ?? "pt";
  const pt =
    unit === "pt"
      ? n
      : unit === "cm"
        ? n * 28.3465
        : unit === "mm"
          ? n * 2.83465
          : unit === "in"
            ? n * 72
            : unit === "pc"
              ? n * 12
              : n * 0.75; // px
  return pt >= 4 && pt <= 72 ? pt : undefined;
}

function parseWeight(val: string): boolean | undefined {
  const v = val.trim().toLowerCase();
  if (v === "bold" || v === "bolder") return true;
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && v !== "") return n >= 600;
  if (v === "normal" || v === "lighter" || v === "") return false;
  return undefined;
}

function parseStyleItalic(val: string): boolean | undefined {
  const v = val.trim().toLowerCase();
  if (v === "italic" || v === "oblique") return true;
  if (v === "normal" || v === "") return false;
  return undefined;
}

/**
 * Collects style:style declarations (text and paragraph families both
 * carry style:text-properties) from one XML part into `map`.
 */
function collectStyles(xml: string, map: Map<string, StyleProps>): void {
  let current: string | null = null;
  let props: StyleProps | null = null;
  const commit = (): void => {
    if (current !== null && props !== null) map.set(current, props);
    current = null;
    props = null;
  };
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      const local = localName(e.name);
      if (local === "style") {
        current = attrOf(e.attrs, "name") || null;
        props = { parent: attrOf(e.attrs, "parent-style-name") || undefined };
        // self-closing style declarations (<style:style .../>) never
        // emit a close event — commit immediately.
        if (e.selfClose) commit();
      } else if (current !== null && props !== null && local === "text-properties") {
        const w = parseWeight(attrOf(e.attrs, "font-weight"));
        if (w !== undefined) props.bold = w;
        const it = parseStyleItalic(attrOf(e.attrs, "font-style"));
        if (it !== undefined) props.italic = it;
        const size = parseFontSize(attrOf(e.attrs, "font-size"));
        if (size !== undefined) props.sizePt = size;
      }
      return;
    }
    if (e.kind === "close" && localName(e.name) === "style") {
      commit();
    }
  });
}

export interface ResolvedStyle {
  bold: boolean;
  italic: boolean;
  sizePt: number | undefined;
}

/** Resolves a style-name through parent chains (any bold/size in the chain wins). */
export function resolveStyle(
  map: Map<string, StyleProps>,
  name: string
): ResolvedStyle {
  const out: ResolvedStyle = { bold: false, italic: false, sizePt: undefined };
  let cur = name;
  for (let depth = 0; depth < 5 && cur !== ""; depth++) {
    const props = map.get(cur);
    if (!props) break;
    if (props.bold === true) out.bold = true;
    if (props.italic === true) out.italic = true;
    if (out.sizePt === undefined && props.sizePt !== undefined) {
      out.sizePt = props.sizePt;
    }
    cur = props.parent ?? "";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cell value formatting                                                */
/* ------------------------------------------------------------------ */

/** Rounds float noise (12.300000000000001 → 12.3) — the excel recipe. */
function fmtNumber(val: string): string {
  const n = Number.parseFloat(val);
  if (!Number.isFinite(n)) return val;
  return String(Math.round(n * 1e10) / 1e10);
}

function cleanCellText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // keep \n (multi-paragraph cells join with "\n"); tabs become
    // spaces (the grid wrap splits on spaces — a raw tab must never
    // reach drawText on the Helvetica path); strip other controls
    if (c === 0x09) out += " ";
    else if ((c >= 0x20 && c <= 0x7e) || c >= 0xa0 || c === 0x0a) {
      out += s[i];
    }
  }
  return out.length > MAX_CELL_TEXT ? out.slice(0, MAX_CELL_TEXT) : out;
}

/**
 * Display value of a table cell: the text:p content wins (apps write
 * the shown text there), otherwise office:value / office:boolean-value /
 * office:date-value are formatted honestly.
 */
function cellDisplayValue(paras: string[], attrs: XmlAttrMap): string {
  const text = paras.join("\n").trim();
  if (text !== "") return cleanCellText(text);
  const valueType = attrOf(attrs, "value-type");
  if (valueType === "boolean") {
    return attrOf(attrs, "boolean-value") === "true" ? "TRUE" : "FALSE";
  }
  const raw =
    attrOf(attrs, "value") ||
    attrOf(attrs, "date-value") ||
    attrOf(attrs, "time-value") ||
    attrOf(attrs, "string-value");
  if (raw === "") return "";
  if (
    valueType === "float" ||
    valueType === "currency" ||
    valueType === "percentage"
  ) {
    return cleanCellText(fmtNumber(raw));
  }
  return cleanCellText(raw);
}

/* ------------------------------------------------------------------ */
/* Assembler (content.xml → typed IR)                                   */
/* ------------------------------------------------------------------ */

interface RawRun {
  text: string;
  bold: boolean;
  italic: boolean;
  sizePt: number | undefined;
}

interface ParaState {
  /** 0 = paragraph, 1-6 = heading outline level. */
  heading: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** -1 = not inside a list. */
  listLevel: number;
  runs: RawRun[];
  cur: RawRun | null;
  base: ResolvedStyle;
  spans: ResolvedStyle[];
  textLen: number;
}

interface TableFrame {
  name: string;
  rows: string[][];
  row: string[] | null; // open row accumulator
  paras: string[]; // open cell paragraph accumulator
  attrs: XmlAttrMap; // open cell attrs
}

class OdfAssembler {
  private readonly styles: Map<string, StyleProps>;
  readonly textBlocks: OdfTextBlock[] = [];
  readonly sheets: OdfSheet[] = [];
  truncated = false;
  sheetsTruncated = false;
  private paraBlocks = 0;

  /** office:body child local-name ("text" | "spreadsheet" | …). */
  bodyKind: string | null = null;

  private depth = 0;
  private inBody = false;
  private expectBodyChild = false;
  /** depth of the outermost skipped element (annotation/frame/note…). */
  private skipDepth = -1;
  private tableStack: TableFrame[] = [];
  private para: ParaState | null = null;
  private listDepth = 0;
  /** table:number-rows-repeated of the currently open row. */
  private pendingRowRepeat = 0;

  constructor(styles: Map<string, StyleProps>) {
    this.styles = styles;
  }

  /* ----- run assembly ----- */

  private effective(): {
    bold: boolean;
    italic: boolean;
    sizePt: number | undefined;
  } {
    const p = this.para;
    if (!p) return { bold: false, italic: false, sizePt: undefined };
    let bold = p.base.bold;
    let italic = p.base.italic;
    let sizePt = p.base.sizePt;
    for (const s of p.spans) {
      if (s.bold) bold = true;
      if (s.italic) italic = true;
      if (sizePt === undefined && s.sizePt !== undefined) sizePt = s.sizePt;
    }
    return { bold, italic, sizePt };
  }

  private appendText(text: string): void {
    const p = this.para;
    if (!p || text === "") return;
    const eff = this.effective();
    if (
      p.cur !== null &&
      (p.cur.bold !== eff.bold ||
        p.cur.italic !== eff.italic ||
        p.cur.sizePt !== eff.sizePt)
    ) {
      this.flushRun();
    }
    if (p.cur === null) {
      p.cur = {
        text: "",
        bold: eff.bold,
        italic: eff.italic,
        sizePt: eff.sizePt,
      };
    }
    p.cur.text += hindiNorm(text);
  }

  private flushRun(): void {
    const p = this.para;
    if (!p || !p.cur) return;
    const run = p.cur;
    p.cur = null;
    if (run.text === "") return;
    if (p.runs.length >= MAX_RUNS_PER_PARA || p.textLen >= MAX_PARA_TEXT) {
      this.truncated = true;
      return;
    }
    const text = run.text.slice(0, MAX_RUN_TEXT);
    if (text === "") return;
    p.textLen += text.length;
    p.runs.push({
      text,
      bold: run.bold,
      italic: run.italic,
      sizePt: run.sizePt,
    });
  }

  private pushTextBlock(b: OdfTextBlock): void {
    if (this.textBlocks.length >= MAX_BLOCKS) {
      this.truncated = true;
      return;
    }
    if (b.kind !== "table") {
      if (this.paraBlocks >= MAX_PARAGRAPHS) {
        this.truncated = true;
        return;
      }
      this.paraBlocks += 1;
    }
    this.textBlocks.push(b);
  }

  /** Row/column caps for the current table context (ODT table vs ODS sheet). */
  private get maxRows(): number {
    return this.bodyKind === "spreadsheet" && this.tableStack.length === 1
      ? MAX_SHEET_ROWS
      : MAX_TABLE_ROWS;
  }

  private get maxCols(): number {
    return this.bodyKind === "spreadsheet" && this.tableStack.length === 1
      ? MAX_SHEET_COLS
      : MAX_TABLE_COLS;
  }

  /* ----- tokenizer events (depth is balanced for self-closing tags) ----- */

  readonly onEvent = (e: XmlEvent): void => {
    if (e.kind === "open") {
      this.depth += 1;
      if (this.skipDepth !== -1) {
        if (e.selfClose) this.depth -= 1;
        return;
      }
      this.open(e.name, e.attrs);
      if (e.selfClose) {
        this.close(e.name);
        this.depth -= 1;
      }
      return;
    }
    if (e.kind === "close") {
      const closingDepth = this.depth;
      this.depth = Math.max(0, this.depth - 1);
      if (this.skipDepth !== -1) {
        if (closingDepth === this.skipDepth) this.skipDepth = -1;
        return;
      }
      this.close(e.name);
      return;
    }
    if (this.skipDepth === -1 && this.para !== null) this.appendText(e.text);
  };

  private open(name: string, attrs: XmlAttrMap): void {
    const local = localName(name);

    if (!this.inBody) {
      if (local === "body") {
        this.inBody = true;
        this.expectBodyChild = true;
      }
      return;
    }
    if (this.bodyKind === null && this.expectBodyChild) {
      // the direct child of office:body decides the document kind
      this.expectBodyChild = false;
      this.bodyKind =
        local === "text" ||
        local === "spreadsheet" ||
        local === "presentation" ||
        local === "drawing"
          ? local
          : "other";
      return;
    }

    switch (local) {
      // ----- skipped wholesale (honest limits, see config FAQ) -----
      case "annotation": // office:annotation
      case "frame": // draw:frame (images + text boxes)
      case "note": // text:note (footnotes)
      case "deletion": // tracked-change deletions
      case "forms": // office:forms
      case "shape": // draw:shape
        this.skipDepth = this.depth;
        return;
      default:
        break;
    }

    // ----- text-level elements (shared: office:text flow AND
    // text:p / text:span inside ODS table cells) -----
    switch (local) {
      case "h":
      case "p": {
        const styleName = attrOf(attrs, "style-name");
        const level = intAttr(attrs, "outline-level");
        const heading = local === "h"
          ? ((level >= 1 && level <= 6 ? level : 1) as 1 | 2 | 3 | 4 | 5 | 6)
          : 0;
        this.para = {
          heading,
          listLevel: this.listDepth > 0 ? this.listDepth - 1 : -1,
          runs: [],
          cur: null,
          base: styleName
            ? resolveStyle(this.styles, styleName)
            : { bold: false, italic: false, sizePt: undefined },
          spans: [],
          textLen: 0,
        };
        return;
      }
      case "span": {
        const p = this.para;
        const styleName = attrOf(attrs, "style-name");
        if (p !== null) {
          p.spans.push(
            styleName
              ? resolveStyle(this.styles, styleName)
              : { bold: false, italic: false, sizePt: undefined }
          );
        }
        return;
      }
      case "s": {
        const c = intAttr(attrs, "c");
        this.appendText(" ".repeat(c >= 1 && c <= 200 ? c : 1));
        return;
      }
      case "tab":
        this.appendText("\t");
        return;
      case "line-break":
        this.appendText("\n");
        return;
      default:
        break;
    }

    // ----- structural elements (office:text flow AND spreadsheets) -----
    if (this.bodyKind === "text" || this.bodyKind === "spreadsheet") {
      switch (local) {
        case "list":
          this.listDepth = Math.min(this.listDepth + 1, 4);
          return;
        case "table":
          this.tableStack.push({
            name: attrOf(attrs, "name"),
            rows: [],
            row: null,
            paras: [],
            attrs: {},
          });
          return;
        case "table-row": {
          const t = this.tableStack[this.tableStack.length - 1];
          if (t) {
            t.row = [];
            this.pendingRowRepeat = intAttr(attrs, "number-rows-repeated");
          }
          return;
        }
        case "table-cell":
        case "covered-table-cell": {
          const t = this.tableStack[this.tableStack.length - 1];
          if (!t) return;
          // covered (merged continuation) behaves as one empty cell
          t.attrs = local === "table-cell" ? attrs : {};
          t.paras = [];
          return;
        }
        default:
          return; // text:section, text:a, tracked changes… transparent
      }
    }
  }

  private close(name: string): void {
    const local = localName(name);
    if (local === "body") {
      this.inBody = false;
      return;
    }
    switch (local) {
      case "span":
        this.para?.spans.pop();
        return;
      case "list":
        this.listDepth = Math.max(0, this.listDepth - 1);
        return;
      case "h":
      case "p":
        this.endPara(local === "h");
        return;
      case "table":
        this.endTable();
        return;
      case "table-row":
        this.endRow();
        return;
      case "table-cell":
      case "covered-table-cell":
        this.endCell();
        return;
      default:
        return;
    }
  }

  private endPara(isHeading: boolean): void {
    const p = this.para;
    if (!p) return;
    // flush BEFORE detaching this.para — flushRun reads this.para and
    // must still see the live paragraph to push the trailing run.
    this.flushRun();
    this.para = null;

    // inside a table cell → contribute the text to the cell
    const t = this.tableStack[this.tableStack.length - 1];
    if (t && t.row !== null) {
      const text = p.runs.map((r) => r.text).join("").trim();
      if (text !== "") t.paras.push(text.slice(0, MAX_CELL_TEXT));
      return;
    }
    if (!this.inBody) return;

    const isList = p.listLevel >= 0;
    const hasText = p.runs.length > 0;

    if (!hasText && !isList) {
      // ODT's blank spacing paragraph — keep one honest blank line.
      this.pushTextBlock({ kind: "para", runs: [] });
      return;
    }
    if (isHeading) {
      this.pushTextBlock({
        kind: "heading",
        level: p.heading === 0 ? 1 : p.heading,
        runs: p.runs,
      });
      return;
    }
    if (isList) {
      this.pushTextBlock({
        kind: "list-item",
        level: Math.min(3, p.listLevel),
        runs: p.runs,
      });
      return;
    }
    this.pushTextBlock({ kind: "para", runs: p.runs });
  }

  private endCell(): void {
    const t = this.tableStack[this.tableStack.length - 1];
    if (!t || t.row === null) return;
    const value = cellDisplayValue(t.paras, t.attrs);
    const repeat = intAttr(t.attrs, "number-columns-repeated");
    const times = repeat >= 1 && repeat <= 1024 ? repeat : 1;
    const maxCols = this.maxCols;
    let pushed = 0;
    for (let i = 0; i < times && t.row.length < maxCols; i++) {
      t.row.push(value);
      pushed += 1;
    }
    // empty padding cells overflow silently; real content is flagged
    if (value !== "" && pushed < times) this.truncated = true;
    t.paras = [];
    t.attrs = {};
  }

  private endRow(): void {
    const t = this.tableStack[this.tableStack.length - 1];
    if (!t || t.row === null) return;
    const row = t.row;
    t.row = null;
    if (row.length === 0) return; // table-header-rows container close
    const times = this.pendingRowRepeat >= 1 ? this.pendingRowRepeat : 1;
    this.pendingRowRepeat = 0;
    const maxRows = this.maxRows;
    const isEmpty = row.every((c) => c === "");
    const room = maxRows - t.rows.length;
    // all-empty rows never expand past the cap (LibreOffice grid padding);
    // content rows always keep at least one copy when there is room
    const expand = isEmpty ? Math.min(times, Math.max(0, room)) : Math.min(times, Math.max(1, room));
    for (let i = 0; i < expand; i++) t.rows.push(row);
    if (!isEmpty && times > expand) this.truncated = true;
  }

  private endTable(): void {
    const t = this.tableStack.pop();
    if (!t) return;
    if (t.row !== null) this.endRow(); // malformed tail safety
    // trim trailing all-empty rows (LibreOffice pads grids massively)
    while (t.rows.length > 0 && t.rows[t.rows.length - 1].every((c) => c === "")) {
      t.rows.pop();
    }

    if (this.bodyKind === "spreadsheet") {
      if (this.sheets.length >= MAX_SHEETS) {
        this.sheetsTruncated = true;
        return;
      }
      this.sheets.push({
        name: t.name || `Sheet ${this.sheets.length + 1}`,
        grid: t.rows,
      });
      return;
    }

    const parent = this.tableStack[this.tableStack.length - 1];
    if (parent) {
      // nested table inside a cell — flatten its text honestly
      const flat = t.rows.map((r) => r.join(" ")).join(" ").trim();
      if (flat !== "") parent.paras.push(flat.slice(0, MAX_CELL_TEXT));
      return;
    }
    if (t.rows.length > 0) {
      this.pushTextBlock({
        kind: "table",
        name: t.name || undefined,
        rows: t.rows,
      });
    }
  }

  finish(): ParsedOdf {
    if (this.bodyKind === "spreadsheet") {
      return {
        kind: "sheets",
        sheets: this.sheets,
        truncated: this.truncated,
        sheetsTruncated: this.sheetsTruncated,
      };
    }
    return { kind: "text", blocks: this.textBlocks, truncated: this.truncated };
  }
}

/* ------------------------------------------------------------------ */
/* parseOdt                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parses an OpenDocument package (.odt text / .ods spreadsheet) from raw
 * bytes. Throws OdfParseError with an honest code for everything that is
 * not a readable text/spreadsheet document (non-ZIP, corrupt archive,
 * .odp presentations, .odg graphics, missing content.xml, empty body).
 */
export function parseOdt(bytes: Uint8Array): ParsedOdf {
  if (!hasZipSignature(bytes.subarray(0, 4))) {
    throw new OdfParseError("errNotZip");
  }
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new OdfParseError("errCorrupt");
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const mimeEntry = files["mimetype"];
  if (mimeEntry && mimeEntry.length > 0) {
    const mime = decoder.decode(mimeEntry).trim().toLowerCase();
    if (mime.includes("presentation")) throw new OdfParseError("errOdp");
    if (mime.includes("graphics")) throw new OdfParseError("errOdg");
  }

  const contentBytes = files["content.xml"];
  if (!contentBytes || contentBytes.length === 0) {
    throw new OdfParseError("errNoContent");
  }
  let content = decoder.decode(contentBytes);
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  // styles: named styles from styles.xml, then automatic styles from
  // content.xml (later same-name declarations win, matching ODF override)
  const styles = new Map<string, StyleProps>();
  const stylesBytes = files["styles.xml"];
  if (stylesBytes && stylesBytes.length > 0) {
    try {
      collectStyles(decoder.decode(stylesBytes), styles);
    } catch {
      /* optional part */
    }
  }
  try {
    collectStyles(content, styles);
  } catch {
    /* automatic styles are optional */
  }

  const asm = new OdfAssembler(styles);
  try {
    scanXml(content, asm.onEvent);
  } catch {
    throw new OdfParseError("errCorrupt");
  }

  if (asm.bodyKind === "presentation") throw new OdfParseError("errOdp");
  if (asm.bodyKind === "drawing") throw new OdfParseError("errOdg");
  if (asm.bodyKind !== "text" && asm.bodyKind !== "spreadsheet") {
    throw new OdfParseError("errNoContent");
  }
  if (asm.bodyKind === "text" && asm.textBlocks.length === 0) {
    throw new OdfParseError("errEmpty");
  }
  if (asm.bodyKind === "spreadsheet" && asm.sheets.length === 0) {
    throw new OdfParseError("errEmpty");
  }
  return asm.finish();
}

/* ------------------------------------------------------------------ */
/* stats() + estimatePages() — honest numbers for the live summary      */
/* ------------------------------------------------------------------ */

export interface OdfStats {
  kind: "text" | "sheets";
  /** text: paragraphs + headings + list items. */
  blocks: number;
  tableCount: number;
  sheetCount: number;
  rowCount: number;
  cellCount: number;
  words: number;
  truncated: boolean;
  sheetsTruncated: boolean;
}

const countWords = (s: string): number =>
  s.split(/\s+/).filter(Boolean).length;

export function stats(doc: ParsedOdf): OdfStats {
  const out: OdfStats = {
    kind: doc.kind,
    blocks: 0,
    tableCount: 0,
    sheetCount: 0,
    rowCount: 0,
    cellCount: 0,
    words: 0,
    truncated: doc.truncated,
    sheetsTruncated: doc.kind === "sheets" ? doc.sheetsTruncated : false,
  };
  if (doc.kind === "text") {
    for (const b of doc.blocks) {
      if (b.kind === "table") {
        out.tableCount += 1;
        for (const row of b.rows) {
          out.rowCount += 1;
          out.cellCount += row.length;
          for (const cell of row) out.words += countWords(cell);
        }
      } else {
        out.blocks += 1;
        for (const r of b.runs) out.words += countWords(r.text);
      }
    }
    return out;
  }
  for (const sheet of doc.sheets) {
    out.sheetCount += 1;
    for (const row of sheet.grid) {
      out.rowCount += 1;
      out.cellCount += row.length;
      for (const cell of row) out.words += countWords(cell);
    }
  }
  return out;
}

/**
 * Cheap page estimate for the live summary (the renderer's true
 * pagination may differ by a line or two — honest ≈, never a promise).
 */
export function estimatePages(doc: ParsedOdf): number {
  if (doc.kind === "text") {
    let lines = 0;
    for (const b of doc.blocks) {
      if (b.kind === "table") {
        lines += b.rows.length * 1.6 + 1;
      } else if (b.kind === "heading") {
        lines += 2.4;
      } else if (b.kind === "list-item") {
        lines += 1.25;
      } else {
        const words = b.runs.reduce((sum, r) => sum + countWords(r.text), 0);
        lines += (words === 0 ? 1 : Math.max(1, Math.ceil(words / 9))) + 0.35;
      }
    }
    return Math.max(1, Math.ceil(lines / 44));
  }
  let pages = 0;
  for (const sheet of doc.sheets) {
    pages += Math.max(1, Math.ceil(sheet.grid.length / 55));
  }
  return Math.max(1, pages);
}

/* ------------------------------------------------------------------ */
/* Output name (house pdf-to-txt convention + localized fallback)      */
/* ------------------------------------------------------------------ */

/**
 * "Report v2.odt" → "Report v2"; a nameless file falls back to the
 * localized word ("Document" / "दस्तावेज़"). The worker appends ".pdf".
 * Unicode survives; path separators and unsafe chars do not.
 */
export function outputBaseName(fileName: string, lang: "en" | "hi"): string {
  const base = fileName
    .replace(/\.(odt|ods|ott|ots|odp|odg)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120);
  if (base !== "") return base;
  return lang === "hi" ? "दस्तावेज़" : "Document";
}

/* ------------------------------------------------------------------ */
/* Sample builders (smoke fixtures — REAL minimal ODF packages)         */
/* ------------------------------------------------------------------ */

const OD_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sampleStylesXml(): string {
  return (
    XML_DECL +
    `<office:document-styles ${OD_NS} office:version="1.3">` +
    "<office:styles>" +
    '<style:style style:name="Bold_20_Span" style:family="text">' +
    '<style:text-properties fo:font-weight="bold"/></style:style>' +
    '<style:style style:name="Italic_20_Span" style:family="text">' +
    '<style:text-properties fo:font-style="italic"/></style:style>' +
    '<style:style style:name="Cm_20_Size" style:family="text">' +
    '<style:text-properties fo:font-size="0.3528cm"/></style:style>' +
    "</office:styles>" +
    "</office:document-styles>"
  );
}

function sampleManifest(mediaType: string): string {
  return (
    XML_DECL +
    `<manifest:manifest ${OD_NS} manifest:version="1.3">` +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    "</manifest:manifest>"
  );
}

/** ODF requires mimetype to be the FIRST entry and STORED (level 0). */
function odfZip(mediaType: string, contentXml: string): Uint8Array {
  return zipSync({
    mimetype: [strToU8(mediaType), { level: 0 }],
    "META-INF/manifest.xml": strToU8(sampleManifest(mediaType)),
    "content.xml": strToU8(contentXml),
    "styles.xml": strToU8(sampleStylesXml()),
  });
}

function span(style: string, text: string): string {
  return `<text:span text:style-name="${style}">${esc(text)}</text:span>`;
}

function p(text: string): string {
  return `<text:p text:style-name="Standard">${esc(text)}</text:p>`;
}

/**
 * A real minimal .odt: headings (2 levels), mixed bold/italic spans, a
 * parent-style chain span, text:s + text:tab, a two-level list, a
 * section wrapper, an annotation (must be skipped) and a table with a
 * number-columns-repeated empty-cell run.
 */
export function buildSampleOdt(opts: { hindi?: boolean } = {}): Uint8Array {
  const body =
    '<text:h text:outline-level="1">Quarterly Report</text:h>' +
    '<text:h text:outline-level="2">Summary</text:h>' +
    "<text:p text:style-name=\"Standard\">Body paragraph with " +
    span("Bold_20_Span", "bold middle") +
    " and " +
    span("Italic_20_Span", "italic tail") +
    ', plus<text:s text:c="3"/>gaps and a<text:tab/>tab.</text:p>' +
    "<text:p text:style-name=\"Standard\">" +
    span("T1", "Parented bold span") +
    " resolves through the chain.</text:p>" +
    "<text:list>" +
    "<text:list-item>" +
    p("Bullet one") +
    "<text:list><text:list-item>" +
    p("Nested bullet") +
    "</text:list-item></text:list>" +
    "</text:list-item>" +
    "<text:list-item>" +
    p("Bullet two") +
    "</text:list-item>" +
    "</text:list>" +
    '<text:section text:name="wrapper">' +
    p("Section text flows through.") +
    "</text:section>" +
    "<office:annotation><text:p>secret comment</text:p></office:annotation>" +
    '<table:table table:name="Regions">' +
    '<table:table-column table:number-columns-repeated="3"/>' +
    "<table:table-row>" +
    '<table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>Sales</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>Growth</text:p></table:table-cell>' +
    "</table:table-row>" +
    "<table:table-row>" +
    '<table:table-cell office:value-type="string"><text:p>North</text:p></table:table-cell>' +
    '<table:table-cell table:number-columns-repeated="2"/>' +
    '<table:table-cell office:value-type="float" office:value="120"><text:p>120</text:p></table:table-cell>' +
    "</table:table-row>" +
    "</table:table>" +
    (opts.hindi
      ? '<text:p text:style-name="Standard">प्रिया शर्मा की रिपोर्ट</text:p>' +
        "<text:list><text:list-item>" +
        p("दस्तावेज़ की बुलेट रेखा") +
        "</text:list-item></text:list>"
      : p("After the table."));
  const content =
    XML_DECL +
    `<office:document-content ${OD_NS} office:version="1.3">` +
    "<office:automatic-styles>" +
    '<style:style style:name="T1" style:family="text" style:parent-style-name="Bold_20_Span"/>' +
    "</office:automatic-styles>" +
    "<office:body><office:text>" +
    body +
    "</office:text></office:body>" +
    "</office:document-content>";
  return odfZip("application/vnd.oasis.opendocument.text", content);
}

/**
 * A real minimal .ods: one sheet with string/float cells, a repeated
 * non-empty cell (number-columns-repeated) and a repeated row
 * (number-rows-repeated); the Hindi variant adds a Devanagari sheet.
 */
export function buildSampleOds(opts: { hindi?: boolean } = {}): Uint8Array {
  const body =
    '<table:table table:name="Data">' +
    '<table:table-column table:number-columns-repeated="3"/>' +
    "<table:table-row>" +
    '<table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>Sales</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>Note</text:p></table:table-cell>' +
    "</table:table-row>" +
    "<table:table-row>" +
    '<table:table-cell office:value-type="string"><text:p>North</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="float" office:value="120.5"><text:p>120.5</text:p></table:table-cell>' +
    '<table:table-cell table:number-columns-repeated="2" office:value-type="string"><text:p>x</text:p></table:table-cell>' +
    "</table:table-row>" +
    '<table:table-row table:number-rows-repeated="2">' +
    '<table:table-cell office:value-type="string"><text:p>South</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="float" office:value="80"><text:p>80</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>row copy</text:p></table:table-cell>' +
    "</table:table-row>" +
    "</table:table>" +
    (opts.hindi
      ? '<table:table table:name="हिन्दी">' +
        "<table:table-row>" +
        '<table:table-cell office:value-type="string"><text:p>क्षेत्र</text:p></table:table-cell>' +
        '<table:table-cell office:value-type="string"><text:p>बिक्री</text:p></table:table-cell>' +
        "</table:table-row></table:table>"
      : "");
  const content =
    XML_DECL +
    `<office:document-content ${OD_NS} office:version="1.3">` +
    "<office:automatic-styles/>" +
    "<office:body><office:spreadsheet>" +
    body +
    "</office:spreadsheet></office:body>" +
    "</office:document-content>";
  return odfZip("application/vnd.oasis.opendocument.spreadsheet", content);
}
