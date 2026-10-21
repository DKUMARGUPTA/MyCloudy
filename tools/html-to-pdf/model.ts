/**
 * HTML to PDF (RB2-d — the 74th tool) — pure model. No DOM, no
 * DOMParser (workers have none), no pdf-lib: the same parseHtml feeds
 * the surface's live summary AND the worker's render path, so the
 * preview numbers can never disagree with the output.
 *
 *  - tokenizeHtml: a hand-rolled linear tokenizer — tags (`<tag
 *    attr="v">`, `</tag>`, `<br/>`), `<!-- comments -->` and
 *    `<!doctype …>` / `<?…?>` skipped wholesale, and `<script>…</script>`
 *    plus `<style>…</style>` dropped CONTENT AND ALL (case-insensitive
 *    close scan). Text runs get entity decoding (a small named table +
 *    `&#2361;` / `&#x0939;` numeric forms).
 *  - HtmlAssembler: a tolerant tag-stack parser (never throws): void
 *    elements auto-close (br, hr, img, input, meta, link…), `<p>text<p>
 *    next` auto-closes, stray close tags are ignored, skipped subtrees
 *    (svg, form controls, buttons, iframes, templates) drop text.
 *    Produces the typed IR: heading/para/list-item/quote/rule/pre/table
 *    blocks with inline runs {bold, italic, underline, mono, link}.
 *  - parseHtmlRun: the worker-boundary coercion (parseWordRun pattern)
 *    — clamp arrays, strip control chars, cap every length. A tampered
 *    payload can never reach the renderer as a wrong type.
 *  - needsNoto / isWinAnsiText: pure-WinAnsi content → non-embedded
 *    base-14 Helvetica; ANY non-WinAnsi char (Devanagari, ₹ …) → the
 *    self-hosted Noto Sans Devanagari subset (fontkit).
 *  - decodeHtmlBytes / detectCharsetLabel: UTF-8 default, BOM + <meta
 *    charset> aware (windows-1252 and friends via TextDecoder labels).
 *
 * Honest limits (mirrored in config.ts): CSS layout/styling is NOT
 * applied — this is content extraction, not a browser engine; scripts,
 * SVG and images are not carried beyond alt text in brackets; complex
 * nested tables approximate (inner tables hoist as their own grid);
 * Hindi bold renders regular (the Noto OFL face ships Regular only).
 */

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the boundary parser)                          */
/* ------------------------------------------------------------------ */

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_BLOCKS = 20_000;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLS = 200;
export const MAX_RUN_TEXT = 4_000;
export const MAX_PARA_TEXT = 20_000;
export const MAX_CELL_TEXT = 1_000;
export const MAX_RUNS_PER_PARA = 500;
export const MAX_PRE_TEXT = 60_000;
export const MAX_TITLE_TEXT = 300;

/** Worker/surface input gate: 20 MB of source HTML. */
export function inputTooLarge(byteLength: number): boolean {
  return byteLength > MAX_INPUT_BYTES;
}

/* ------------------------------------------------------------------ */
/* Typed IR                                                             */
/* ------------------------------------------------------------------ */

export interface HtmlRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** inline code (<code>/<kbd>/<samp>) → Courier family. */
  mono: boolean;
  /** href when the run sits inside <a href="…"> (render decides). */
  link?: string;
}

export type HtmlBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: HtmlRun[] }
  | { kind: "para"; runs: HtmlRun[] }
  | {
      kind: "list-item";
      depth: number;
      ordered: boolean;
      number: number;
      runs: HtmlRun[];
    }
  | { kind: "quote"; runs: HtmlRun[] }
  | { kind: "rule" }
  | { kind: "pre"; text: string }
  | { kind: "table"; grid: string[][]; headerRow?: boolean };

export interface HtmlDocStats {
  blockCount: number;
  headings: number;
  paras: number;
  listItems: number;
  quotes: number;
  preBlocks: number;
  tables: number;
  wordCount: number;
  charCount: number;
}

export interface ParsedHtml {
  title: string;
  blocks: HtmlBlock[];
  /** true when any hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

function emptyDoc(): ParsedHtml {
  return { title: "", blocks: [], truncated: false };
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (word-to-pdf copy)    */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true when every char is encodable in WinAnsi (CP1252) minus controls.
 * `\n` and `\t` are layout-consumed (the renderer splits on them before
 * drawText — the ppt tool's pinned lesson) so they pass even though they
 * are control codes. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a /* \n */ || c === 0x09 /* \t */) continue;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** true when any drawn text needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(doc: ParsedHtml): boolean {
  for (const b of doc.blocks) {
    if (b.kind === "pre") {
      if (!isWinAnsiText(b.text)) return true;
    } else if (b.kind === "table") {
      for (const row of b.grid) {
        for (const cell of row) if (!isWinAnsiText(cell)) return true;
      }
    } else if (b.kind !== "rule") {
      for (const r of b.runs) if (!isWinAnsiText(r.text)) return true;
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
/* HTML entities                                                         */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  bull: "\u2022",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  sect: "\u00a7",
  para: "\u00b6",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  frac12: "\u00bd",
  frac14: "\u00bc",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  dagger: "\u2020",
  prime: "\u2032",
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
/* Charset decoding (BOM + <meta charset> aware; UTF-8 default)          */
/* ------------------------------------------------------------------ */

function latin1Of(bytes: Uint8Array, max: number): string {
  let out = "";
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Reads `<meta charset=…>` / `content="text/html; charset=…"` from a head. */
export function detectCharsetLabel(headLatin1: string): string {
  const re = /<meta[^>]*?charset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]+)/i;
  const m = re.exec(headLatin1);
  const label = m ? m[1].toLowerCase() : "";
  if (!label) return "utf-8";
  try {
    new TextDecoder(label); // throws RangeError on unsupported labels
    return label;
  } catch {
    return "utf-8";
  }
}

/**
 * Bytes → HTML source: UTF-8/UTF-16 BOM honoured, `<meta charset>`
 * respected (windows-1252 and every other TextDecoder label), malformed
 * sequences tolerated. Pure string work — usable on any thread.
 */
export function decodeHtmlBytes(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2));
  }
  const label = detectCharsetLabel(latin1Of(bytes, 2048));
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * Honest sniff for the drop zone / worker gate: the source must contain
 * a real tag open (`</?[a-zA-Z]…`) or a doctype. A plain-text file
 * without any tag shape is rejected (documented choice) — the model
 * itself would still treat bare text as one paragraph.
 */
export function looksLikeHtml(source: string): boolean {
  const head = source.slice(0, 4096);
  if (/<!doctype/i.test(head)) return true;
  return /<\/?[a-zA-Z][a-zA-Z0-9:_-]*(\s|\/?>|>)/.test(head);
}

/* ------------------------------------------------------------------ */
/* Tokenizer events                                                     */
/* ------------------------------------------------------------------ */

export interface HtmlTokenHandlers {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  /** entities already decoded; raw (pre needs un-collapsed text). */
  text(value: string): void;
}

const TAG_NAME_STOP = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  "\f",
  "/",
  ">",
  "<",
  "=",
]);
const ATTR_NAME_STOP = new Set([" ", "\t", "\r", "\n", "\f", "/", ">", "="]);

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f";
}

/**
 * Case-insensitive "</name" scan at word boundary (the char after the
 * name must be whitespace, "/", or ">") — treats EOF as not found.
 */
function indexOfCloseTag(s: string, tagName: string, from: number): number {
  const need = tagName.length + 2; // "</" + name
  outer: for (let i = from; i + need <= s.length; i++) {
    if (s.charCodeAt(i) !== 60 /* < */ || s.charCodeAt(i + 1) !== 47 /* / */) {
      continue;
    }
    for (let k = 0; k < tagName.length; k++) {
      let c = s.charCodeAt(i + 2 + k);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== tagName.charCodeAt(k)) continue outer;
    }
    const after = s[i + need];
    if (
      after === undefined ||
      after === ">" ||
      after === "/" ||
      isWs(after)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Tolerant linear tokenizer: real elements emit open/close (self-closing
 * non-void elements still emit open — the HTML5 rule, the slash is
 * ignored outside foreign content), comments / doctypes / processing
 * instructions are skipped, and `<script>` / `<style>` elements are
 * dropped WHOLESALE (content included). Everything else between tags is
 * text with entity decoding. Malformed input degrades instead of
 * throwing; script/style tokens are never emitted.
 */
export function tokenizeHtml(source: string, h: HtmlTokenHandlers): void {
  const n = source.length;
  let i = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      if (i < n) h.text(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) h.text(decodeEntities(source.slice(i, lt)));

    const c1 = source.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      if (source.startsWith("<!--", lt)) {
        const end = source.indexOf("-->", lt);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const end = source.indexOf(">", lt); // doctype / CDATA-ish
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c1 === 63 /* ? */) {
      const end = source.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c1 === 47 /* / */) {
      let j = lt + 2;
      const nameStart = j;
      while (j < n && !TAG_NAME_STOP.has(source[j])) j += 1;
      const name = source.slice(nameStart, j).toLowerCase();
      const end = source.indexOf(">", j);
      i = end < 0 ? n : end + 1;
      if (name) h.close(name);
      continue;
    }
    if (!(c1 >= 97 && c1 <= 122) && !(c1 >= 65 && c1 <= 90)) {
      // "<" that isn't a tag at all — emit it as text and move on.
      h.text("<");
      i = lt + 1;
      continue;
    }

    // open tag: scan the name
    let j = lt + 1;
    const nameStart = j;
    while (j < n && !TAG_NAME_STOP.has(source[j])) j += 1;
    const name = source.slice(nameStart, j).toLowerCase();

    // attributes until ">"
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let guard = 0;
    while (j < n && guard < 20_000) {
      guard += 1;
      while (j < n && isWs(source[j])) j += 1;
      const c = source.charCodeAt(j);
      if (c === 62 /* > */) {
        j += 1;
        break;
      }
      if (c === 47 /* / */) {
        if (source.charCodeAt(j + 1) === 62 /* > */) selfClosing = true;
        j += 1;
        continue;
      }
      if (j >= n) break;
      const aStart = j;
      while (j < n && !ATTR_NAME_STOP.has(source[j])) j += 1;
      const aName = source.slice(aStart, j).toLowerCase();
      while (j < n && isWs(source[j])) j += 1;
      let aVal = "";
      if (source.charCodeAt(j) === 61 /* = */) {
        j += 1;
        while (j < n && isWs(source[j])) j += 1;
        const q = source.charCodeAt(j);
        if (q === 34 /* " */ || q === 39 /* ' */) {
          j += 1;
          const vStart = j;
          while (j < n && source.charCodeAt(j) !== q) j += 1;
          aVal = source.slice(vStart, j);
          j += 1;
        } else {
          const vStart = j;
          while (j < n && !isWs(source[j]) && source.charCodeAt(j) !== 62) {
            j += 1;
          }
          aVal = source.slice(vStart, j);
        }
      }
      if (aName) attrs[aName] = decodeEntities(aVal);
    }

    if (name === "script" || name === "style") {
      // raw-text element: skip content AND the closing tag entirely
      const close = indexOfCloseTag(source, name, j);
      if (close < 0) break;
      const gt = source.indexOf(">", close);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    h.open(name, attrs, selfClosing);
    i = j;
  }
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                            */
/* ------------------------------------------------------------------ */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Subtrees dropped wholesale (no text survives them). */
const SKIP_ELEMENTS = new Set([
  "svg", "canvas", "iframe", "object", "picture", "video",
  "audio", "template", "noscript", "select", "datalist", "option",
  "input", "textarea", "button", "label", "fieldset", "legend",
  "output", "progress", "meter", "dialog", "map",
]);

/** Opening any of these closes an open paragraph (HTML implied ends). */
const BLOCK_ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl",
  "dt", "dd", "blockquote", "pre", "table", "tr", "td", "th", "thead",
  "tbody", "tfoot", "caption", "div", "section", "article", "aside",
  "header", "footer", "main", "nav", "figure", "figcaption", "address",
  "details", "summary", "form", "center", "hr", "title", "head", "body",
  "html",
]);

const HEADING_TAGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

/** HTML whitespace collapse — the explicit set, so &nbsp; (\u00A0) survives. */
function collapseWs(s: string): string {
  let out = "";
  let inWs = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f") {
      if (!inWs && out.length > 0) out += " ";
      inWs = true;
    } else {
      out += ch;
      inWs = false;
    }
  }
  return out;
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

interface RunStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
  link?: string | undefined;
}

function runMatchesStyle(r: HtmlRun, s: RunStyle): boolean {
  return (
    r.bold === s.bold &&
    r.italic === s.italic &&
    r.underline === s.underline &&
    r.mono === s.mono &&
    r.link === s.link
  );
}

interface Collector {
  kind: "para" | "heading" | "quote" | "list-item";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  depth: number;
  ordered: boolean;
  number: number;
  runs: HtmlRun[];
  /** 1-based stack depth of the frame that owns this collector. */
  owner: number;
  textLen: number;
}

interface TableFrame {
  rows: string[][];
  row: string[] | null;
  cell: string | null;
  inHeaderCell: boolean;
  headerRow: boolean;
  firstRow: boolean;
}

interface ListFrame {
  ordered: boolean;
  counter: number;
}

/* ------------------------------------------------------------------ */
/* Assembler                                                            */
/* ------------------------------------------------------------------ */

class HtmlAssembler {
  readonly blocks: HtmlBlock[] = [];
  title = "";
  truncated = false;

  /* --- walker state --- */
  private stack: string[] = [];
  private skipDepth = -1;
  private inHead = false;
  private quoteDepth = 0;
  private titleDepth = -1;
  private titleText = "";

  /* --- pre blocks --- */
  private preDepth = 0;
  private preText = "";

  /* --- inline style state --- */
  private boldDepth = 0;
  private italicDepth = 0;
  private underlineDepth = 0;
  private monoDepth = 0;
  private linkStack: string[] = [];

  /* --- collector / lists / tables --- */
  private collector: Collector | null = null;
  private listStack: ListFrame[] = [];
  private tableStack: TableFrame[] = [];

  private pushBlock(b: HtmlBlock): void {
    if (this.blocks.length >= MAX_BLOCKS) {
      this.truncated = true;
      return;
    }
    this.blocks.push(b);
  }

  private style(): RunStyle {
    const link = this.linkStack[this.linkStack.length - 1];
    return {
      bold: this.boldDepth > 0,
      italic: this.italicDepth > 0,
      underline: this.underlineDepth > 0,
      mono: this.monoDepth > 0,
      link: link === "" || link === undefined ? undefined : link,
    };
  }

  /** the open td/th frame, if any. */
  private openCell(): TableFrame | null {
    const top = this.tableStack[this.tableStack.length - 1];
    return top !== undefined && top.cell !== null ? top : null;
  }

  private ensureCollector(): Collector {
    if (this.collector === null) {
      // implicit paragraph: div/body text without a <p>
      this.collector = {
        kind: this.quoteDepth > 0 ? "quote" : "para",
        level: 1,
        depth: 0,
        ordered: false,
        number: 0,
        runs: [],
        owner: this.stack.length,
        textLen: 0,
      };
    }
    return this.collector;
  }

  private appendCellText(frame: TableFrame, raw: string): void {
    const t = collapseWs(raw);
    if (t === "") return;
    if (frame.cell === null) frame.cell = "";
    if (frame.cell === "") {
      frame.cell = t;
    } else if (frame.cell.endsWith(" ") || t.startsWith(" ")) {
      frame.cell += t;
    } else {
      frame.cell += " " + t;
    }
  }

  private appendRunText(raw: string): void {
    let t = hindiNorm(collapseWs(raw));
    if (t === "") return;
    const style = this.style();
    const col = this.ensureCollector();
    const last = col.runs[col.runs.length - 1];
    if (last && last.text.endsWith(" ") && t.startsWith(" ")) t = t.slice(1);
    if (col.textLen >= MAX_PARA_TEXT) {
      this.truncated = true;
      return;
    }
    if (t.length > MAX_RUN_TEXT) {
      t = t.slice(0, MAX_RUN_TEXT);
      this.truncated = true;
    }
    col.textLen += t.length;
    if (last && runMatchesStyle(last, style)) {
      last.text += t;
    } else if (col.runs.length < MAX_RUNS_PER_PARA) {
      col.runs.push({
        text: t,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        mono: style.mono,
        link: style.link,
      });
    } else {
      this.truncated = true;
    }
  }

  /** append a soft-break run (<br>) to the active collector. */
  private appendBreak(): void {
    const style = this.style();
    const col = this.ensureCollector();
    const last = col.runs[col.runs.length - 1];
    if (last && runMatchesStyle(last, style)) {
      last.text += "\n";
    } else if (col.runs.length < MAX_RUNS_PER_PARA) {
      col.runs.push({
        text: "\n",
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        mono: style.mono,
        link: style.link,
      });
    }
  }

  /** flush the active collector into the block list. */
  private flushCollector(): void {
    const col = this.collector;
    this.collector = null;
    if (!col) return;
    const runs = normalizeRuns(col.runs);
    if (runs.length === 0) return;
    switch (col.kind) {
      case "heading":
        this.pushBlock({ kind: "heading", level: col.level, runs });
        break;
      case "quote":
        this.pushBlock({ kind: "quote", runs });
        break;
      case "list-item":
        this.pushBlock({
          kind: "list-item",
          depth: Math.min(8, Math.max(0, col.depth)),
          ordered: col.ordered,
          number: col.number,
          runs,
        });
        break;
      default:
        this.pushBlock({ kind: "para", runs });
        break;
    }
  }

  /** flush when the collector's owning frame has been popped. */
  private flushIfOrphaned(): void {
    if (this.collector && this.collector.owner > this.stack.length) {
      this.flushCollector();
    }
  }

  private finalizeTitle(): void {
    if (this.titleDepth !== -1) {
      this.title = cleanText(this.titleText.trim(), MAX_TITLE_TEXT);
      this.titleDepth = -1;
      this.titleText = "";
    }
  }

  readonly handlers: HtmlTokenHandlers = {
    open: (name, attrs, selfClosing) => {
      const isVoid = VOID_ELEMENTS.has(name);
      if (isVoid) {
        if (selfClosing) {
          /* "<br/>" === "<br>" */
        }
      } else if (selfClosing && SKIP_ELEMENTS.has(name)) {
        // foreign-content self-closing ("<svg/>") — an empty element
        return;
      } else {
        // HTML5 rule: the slash on non-void elements is IGNORED
        this.stack.push(name);
      }
      const depth = this.stack.length;

      if (this.skipDepth !== -1) return;

      if (SKIP_ELEMENTS.has(name) && !isVoid) {
        this.skipDepth = depth;
        return;
      }

      switch (name) {
        case "html":
        case "body":
          this.inHead = false;
          break;
        case "head":
          this.inHead = true;
          break;
        case "title":
          this.titleDepth = depth;
          this.titleText = "";
          break;
        case "br":
          if (this.preDepth > 0) {
            this.preText += "\n";
          } else if (this.openCell()) {
            /* cell breaks collapse to the space the joiner adds */
          } else {
            this.appendBreak();
          }
          break;
        case "hr":
          this.flushCollector();
          this.pushBlock({ kind: "rule" });
          break;
        case "img": {
          const alt = typeof attrs.alt === "string" ? collapseWs(attrs.alt).trim() : "";
          if (alt && this.preDepth === 0 && !this.openCell()) {
            const col = this.ensureCollector();
            if (col.runs.length < MAX_RUNS_PER_PARA) {
              col.runs.push({
                text: `[${alt.slice(0, 200)}]`,
                bold: false,
                italic: true,
                underline: false,
                mono: false,
              });
            }
          }
          break;
        }
        case "a":
          this.linkStack.push(String(attrs.href ?? "").slice(0, 500));
          break;
        case "b":
        case "strong":
          this.boldDepth += 1;
          break;
        case "i":
        case "em":
        case "cite":
        case "var":
          this.italicDepth += 1;
          break;
        case "u":
        case "ins":
          this.underlineDepth += 1;
          break;
        case "code":
        case "kbd":
        case "samp":
        case "tt":
          this.monoDepth += 1;
          break;
        case "ul":
        case "ol": {
          this.flushCollector();
          const start = Number.parseInt(String(attrs.start ?? ""), 10);
          this.listStack.push({
            ordered: name === "ol",
            // first <li> increments to the printed number
            counter: Number.isFinite(start) && start > -999 ? start - 1 : 0,
          });
          break;
        }
        case "li": {
          const list = this.listStack[this.listStack.length - 1];
          if (list) list.counter += 1;
          this.flushCollector();
          this.collector = {
            kind: "list-item",
            level: 1,
            depth: Math.max(0, this.listStack.length - 1),
            ordered: list ? list.ordered : false,
            number: list ? list.counter : 1,
            runs: [],
            owner: depth,
            textLen: 0,
          };
          break;
        }
        case "dt":
        case "dd": {
          this.flushCollector();
          this.collector = {
            kind: "list-item",
            level: 1,
            depth: 0,
            ordered: false,
            number: 0,
            runs: [],
            owner: depth,
            textLen: 0,
          };
          break;
        }
        case "p":
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          if (this.openCell()) break; // paragraphs inside cells → cell text
          const col = this.collector;
          if (
            col &&
            col.kind === "list-item" &&
            this.stack.length >= col.owner &&
            name === "p"
          ) {
            // paragraph inside the list item that owns the collector —
            // merge (soft break between them, the markdown approach)
            const last = col.runs[col.runs.length - 1];
            if (last && !last.text.endsWith("\n")) last.text += "\n";
            break;
          }
          this.flushCollector();
          this.collector = {
            kind:
              HEADING_TAGS[name] !== undefined
                ? "heading"
                : this.quoteDepth > 0
                  ? "quote"
                  : "para",
            level: HEADING_TAGS[name] ?? 1,
            depth: 0,
            ordered: false,
            number: 0,
            runs: [],
            owner: depth,
            textLen: 0,
          };
          break;
        }
        case "blockquote":
          this.flushCollector();
          this.quoteDepth += 1;
          break;
        case "pre":
          this.flushCollector();
          this.preDepth += 1;
          if (this.preDepth === 1) this.preText = "";
          break;
        case "table":
          this.flushCollector();
          this.tableStack.push({
            rows: [],
            row: null,
            cell: null,
            inHeaderCell: false,
            headerRow: false,
            firstRow: true,
          });
          break;
        case "tr": {
          const top = this.tableStack[this.tableStack.length - 1];
          if (top) {
            top.row = [];
            top.inHeaderCell = false;
          }
          break;
        }
        case "td":
        case "th": {
          const top = this.tableStack[this.tableStack.length - 1];
          if (top) {
            if (top.row === null) top.row = []; // stray cell: implicit row
            top.cell = "";
            top.inHeaderCell = name === "th";
          }
          break;
        }
        default:
          if (BLOCK_ELEMENTS.has(name)) this.flushCollector();
          break;
      }
    },

    text: (value) => {
      if (value === "") return;
      if (this.skipDepth !== -1) return;

      if (this.titleDepth !== -1) {
        this.titleText += collapseWs(value);
        return;
      }
      if (this.inHead) return;
      if (this.preDepth > 0) {
        if (this.preText.length < MAX_PRE_TEXT) {
          this.preText = (this.preText + hindiNorm(value)).slice(0, MAX_PRE_TEXT);
        } else {
          this.truncated = true;
        }
        return;
      }
      const cellFrame = this.openCell();
      if (cellFrame) {
        this.appendCellText(cellFrame, value);
        return;
      }
      this.appendRunText(value);
    },

    close: (name) => {
      const k = this.stack.lastIndexOf(name);
      if (k < 0) return; // stray close — tolerate

      if (this.skipDepth !== -1) {
        if (k === this.skipDepth - 1) {
          // the skip root itself closes
          this.stack.length = k;
          this.skipDepth = -1;
          this.flushIfOrphaned();
          return;
        }
        if (k >= this.skipDepth) {
          // inner close inside the skipped subtree — no side effects
          this.stack.length = k;
          return;
        }
        // auto-close popped past the skip root (unclosed skip element)
        this.stack.length = k;
        this.skipDepth = -1;
        this.applyClose(name);
        this.flushIfOrphaned();
        return;
      }

      this.stack.length = k; // pop name + auto-close anything above it
      this.applyClose(name);
      this.flushIfOrphaned();
    },
  };

  /** close-tag effects (skip-aware callers only). */
  private applyClose(name: string): void {
    switch (name) {
      case "head":
        this.inHead = false;
        this.finalizeTitle();
        break;
      case "title":
        this.finalizeTitle();
        break;
      case "a":
        if (this.linkStack.length > 0) this.linkStack.pop();
        break;
      case "b":
      case "strong":
        this.boldDepth = Math.max(0, this.boldDepth - 1);
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
        this.italicDepth = Math.max(0, this.italicDepth - 1);
        break;
      case "u":
      case "ins":
        this.underlineDepth = Math.max(0, this.underlineDepth - 1);
        break;
      case "code":
      case "kbd":
      case "samp":
      case "tt":
        this.monoDepth = Math.max(0, this.monoDepth - 1);
        break;
      case "blockquote":
        this.quoteDepth = Math.max(0, this.quoteDepth - 1);
        break;
      case "pre":
        this.preDepth = Math.max(0, this.preDepth - 1);
        if (this.preDepth === 0) {
          let text = this.preText
            .replace(/\r\n?/g, "\n")
            .replace(/^\n/, "")
            .replace(/[ \t]+$/, "");
          if (text.length > MAX_PRE_TEXT) {
            text = text.slice(0, MAX_PRE_TEXT);
            this.truncated = true;
          }
          if (text.trim().length > 0) this.pushBlock({ kind: "pre", text });
          this.preText = "";
        }
        break;
      case "td":
      case "th": {
        const top = this.tableStack[this.tableStack.length - 1];
        if (top && top.cell !== null) {
          const cell = hindiNorm(cleanText(top.cell.trim(), MAX_CELL_TEXT));
          if (top.row && top.row.length < MAX_TABLE_COLS) {
            top.row.push(cell);
            if (top.inHeaderCell && top.firstRow) top.headerRow = true;
          } else if (top.row) {
            this.truncated = true;
          }
          top.cell = null;
          top.inHeaderCell = false;
        }
        break;
      }
      case "tr": {
        const top = this.tableStack[this.tableStack.length - 1];
        if (top && top.row !== null) {
          if (top.rows.length < MAX_TABLE_ROWS) {
            if (top.row.length > 0) top.rows.push(top.row);
          } else {
            this.truncated = true;
          }
          top.firstRow = false;
          top.row = null;
        }
        break;
      }
      case "table": {
        const top = this.tableStack.pop();
        if (!top) break;
        // A nested table (closed while an outer one is open) hoists as
        // its own grid before the outer table completes — approximate,
        // documented in the FAQ.
        if (top.rows.length > 0) {
          this.pushBlock({
            kind: "table",
            grid: top.rows,
            headerRow: top.headerRow || undefined,
          });
        }
        break;
      }
      case "ul":
      case "ol":
        if (this.listStack.length > 0) this.listStack.pop();
        break;
      default:
        break;
    }
  }

  finish(): ParsedHtml {
    this.finalizeTitle();
    this.flushCollector();
    return { title: this.title, blocks: this.blocks, truncated: this.truncated };
  }
}

/** merge same-style neighbours, trim paragraph edges, drop empties. */
function normalizeRuns(runs: HtmlRun[]): HtmlRun[] {
  const out: HtmlRun[] = [];
  for (const r of runs) {
    if (r.text === "") continue;
    const last = out[out.length - 1];
    if (last && runMatchesStyle(last, r)) {
      last.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  if (out.length > 0) {
    const first = out[0];
    first.text = first.text.replace(/^[ \t]+/, "");
    const last = out[out.length - 1];
    last.text = last.text
      .replace(/[ \t]+$/, "")
      .replace(/\n+$/, "");
  }
  return out.filter((r) => r.text !== "");
}

/* ------------------------------------------------------------------ */
/* parseHtml                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tolerant HTML → typed IR. Never throws: garbage degrades to fewer
 * blocks. The title comes from <title>; script/style/comments/doctype
 * never contribute text.
 */
export function parseHtml(source: string): ParsedHtml {
  const asm = new HtmlAssembler();
  try {
    tokenizeHtml(source, asm.handlers);
  } catch {
    return emptyDoc();
  }
  return asm.finish();
}

/* ------------------------------------------------------------------ */
/* stats / estimatePages                                                */
/* ------------------------------------------------------------------ */

/** Honest stats derived from the blocks alone (parse + coercion agree). */
export function stats(doc: ParsedHtml): HtmlDocStats & { title: string } {
  let headings = 0;
  let paras = 0;
  let listItems = 0;
  let quotes = 0;
  let preBlocks = 0;
  let tables = 0;
  let words = 0;
  let chars = 0;
  const count = (s: string): void => {
    chars += s.length;
    words += s.split(/\s+/).filter(Boolean).length;
  };
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "heading":
        headings += 1;
        for (const r of b.runs) count(r.text);
        break;
      case "para":
        paras += 1;
        for (const r of b.runs) count(r.text);
        break;
      case "list-item":
        listItems += 1;
        for (const r of b.runs) count(r.text);
        break;
      case "quote":
        quotes += 1;
        for (const r of b.runs) count(r.text);
        break;
      case "pre":
        preBlocks += 1;
        count(b.text);
        break;
      case "table":
        tables += 1;
        for (const row of b.grid) for (const cell of row) count(cell);
        break;
      default:
        break;
    }
  }
  return {
    title: doc.title,
    headings,
    paras,
    listItems,
    quotes,
    preBlocks,
    tables,
    blockCount: doc.blocks.length,
    wordCount: words,
    charCount: chars,
  };
}

/** Heading pt sizes at the 11 pt default (h1 22 → h6 12, scaled by base). */
export const HEADING_SIZES: readonly number[] = [22, 17, 14.5, 13, 12.3, 12];

/**
 * Pure-math page estimate (the surface badge): the render geometry with
 * an average-glyph-width wrap model — honest "≈" numbers, never a lie.
 */
export function estimatePages(doc: ParsedHtml, baseFontSize = 11): number {
  const contentW = 595.28 - 112;
  const usable = 841.89 - 112;
  const cpl = Math.max(20, contentW / (baseFontSize * 0.5));
  const lh = baseFontSize * 1.36;
  let total = 0;
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "heading": {
        const size = HEADING_SIZES[b.level - 1] * (baseFontSize / 11);
        const len = b.runs.reduce((a, r) => a + r.text.length, 0);
        total += Math.max(1, Math.ceil(len / cpl)) * size * 1.3 + size * 0.8;
        break;
      }
      case "para":
      case "quote": {
        const len = b.runs.reduce(
          (a, r) => a + r.text.replace(/\n/g, " ").length,
          0
        );
        const breaks = b.runs.reduce((a, r) => a + (r.text.split("\n").length - 1), 0);
        total += Math.max(1 + breaks, Math.ceil(len / cpl)) * lh + 4;
        break;
      }
      case "list-item": {
        const len = b.runs.reduce((a, r) => a + r.text.length, 0);
        total += Math.max(1, Math.ceil(len / (cpl - 4))) * lh + 2;
        break;
      }
      case "rule":
        total += 14;
        break;
      case "pre": {
        const lines = b.text.split("\n").length;
        total += lines * (baseFontSize * 0.9 * 1.35) + 12;
        break;
      }
      case "table": {
        for (const row of b.grid) {
          let cellLines = 1;
          for (const cell of row) {
            cellLines = Math.max(cellLines, Math.ceil(cell.length / 14));
          }
          total += cellLines * (baseFontSize * 0.82 * 1.35) + 6;
        }
        total += 8;
        break;
      }
      default:
        break;
    }
  }
  return Math.max(1, Math.ceil(total / usable));
}

/* ------------------------------------------------------------------ */
/* parseHtmlRun — worker-boundary coercion (parseWordRun pattern)       */
/* ------------------------------------------------------------------ */

function coerceHeadingLevel(v: unknown): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return undefined;
  if (n >= 1 && n <= 6) return n as 1 | 2 | 3 | 4 | 5 | 6;
  return undefined;
}

function coerceDepth(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(8, Math.floor(n));
}

function coerceRuns(raw: unknown): HtmlRun[] {
  const list = Array.isArray(raw) ? raw : [];
  const runs: HtmlRun[] = [];
  let textLen = 0;
  for (const ro of list) {
    if (runs.length >= MAX_RUNS_PER_PARA) break;
    if (typeof ro !== "object" || ro === null) continue;
    const r = ro as Record<string, unknown>;
    let text = hindiNorm(cleanText(r.text, MAX_RUN_TEXT));
    if (textLen + text.length > MAX_PARA_TEXT) {
      text = text.slice(0, Math.max(0, MAX_PARA_TEXT - textLen));
    }
    if (text === "") continue;
    textLen += text.length;
    const link =
      typeof r.link === "string" && r.link !== "" ? r.link.slice(0, 500) : undefined;
    runs.push({
      text,
      bold: boolOf(r.bold),
      italic: boolOf(r.italic),
      underline: boolOf(r.underline),
      mono: boolOf(r.mono),
      link,
    });
  }
  return runs;
}

/** truthy coercion for JSON-ish boundaries: true, 1 and 1.0 count;
 * strings and everything else fall back to false. */
function boolOf(v: unknown): boolean {
  return v === true || (typeof v === "number" && Number.isFinite(v) && v !== 0);
}

/**
 * Full defensive coercion of a serialized ParsedHtml at the worker
 * boundary: garbage → empty doc, arrays clamped, every text capped,
 * unknown enum values dropped.
 */
export function parseHtmlRun(raw: string): ParsedHtml {
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
  const blocks: HtmlBlock[] = [];
  for (const bo of o.blocks) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    if (typeof bo !== "object" || bo === null) continue;
    const b = bo as Record<string, unknown>;
    const kind = b.kind;

    if (kind === "rule") {
      blocks.push({ kind: "rule" });
    } else if (kind === "pre") {
      blocks.push({ kind: "pre", text: hindiNorm(cleanText(b.text, MAX_PRE_TEXT)) });
    } else if (kind === "table") {
      const rawRows = Array.isArray(b.grid) ? b.grid : [];
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
      if (rows.length > 0) {
        blocks.push({
          kind: "table",
          grid: rows,
          headerRow: b.headerRow === true || undefined,
        });
      }
    } else if (
      kind === "heading" ||
      kind === "para" ||
      kind === "quote" ||
      kind === "list-item"
    ) {
      const runs = coerceRuns(b.runs);
      if (kind === "heading") {
        const level = coerceHeadingLevel(b.level);
        if (level !== undefined) blocks.push({ kind: "heading", level, runs });
        else blocks.push({ kind: "para", runs });
      } else if (kind === "para") {
        blocks.push({ kind: "para", runs });
      } else if (kind === "quote") {
        blocks.push({ kind: "quote", runs });
      } else {
        const numberRaw =
          typeof b.number === "number" ? b.number : Number.parseInt(String(b.number), 10);
        blocks.push({
          kind: "list-item",
          depth: coerceDepth(b.depth),
          ordered: b.ordered === true,
          number: Number.isFinite(numberRaw)
            ? Math.min(999_999, Math.max(0, numberRaw))
            : 1,
          runs,
        });
      }
    }
  }

  const title = cleanText(o.title, MAX_TITLE_TEXT);
  return { title, blocks, truncated };
}

/* ------------------------------------------------------------------ */
/* Output file name                                                     */
/* ------------------------------------------------------------------ */

/**
 * Base name for the download: the <title> when available, else the
 * input file's name; a blank result falls back to the localized word
 * ("Webpage" / "वेबपेज"). Unicode survives; path separators and unsafe
 * chars do not. No extension is appended here.
 */
export function outputBaseName(name: string, lang: "en" | "hi"): string {
  const fallback = lang === "hi" ? "वेबपेज" : "Webpage";
  const base = String(name)
    .replace(/\.[^.]{1,12}$/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base.length > 0 ? base : fallback;
}

/* ------------------------------------------------------------------ */
/* Realistic sample (the smoke fixture + surface preview)               */
/* ------------------------------------------------------------------ */

/**
 * REAL semantic HTML: doctype, head + title, a stylesheet and a script
 * that MUST be ignored, comments, h1–h3, bold/italic/underline runs,
 * a nested list, an ordered list with start, blockquote, hr, a pre
 * block with preserved whitespace, links with hrefs, a th/td table,
 * named + numeric entities (incl. Devanagari &#2361;) and an image alt.
 * Deliberately NOT pure-WinAnsi (&#2361;) — the parse asserts the
 * entity decodes; the EN render fixture in the smoke is separate.
 */
export function buildSampleHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quarterly Report — Project Falcon</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles/main.css">
<style>
body { font-family: sans-serif; color: #222; }
.hidden { display: none; }
</style>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
</script>
</head>
<body>
<!-- navigation placeholder — ignored by the converter -->
<header>
<h1>Project Falcon — Q3 Report</h1>
<p>Prepared by <b>Ananya Verma</b> &amp; the analytics team &mdash; reviewed by Priya Sharma &#2361;&#2367;&#2306;&#2342;&#2368;.</p>
</header>
<main>
<h2>Highlights</h2>
<p>The quarter closed <strong>12% above</strong> target, with revenue of &euro; 4.2M across <em>three regions</em>.</p>
<h3>Key numbers</h3>
<ul>
<li>Revenue: <b>&euro; 4.2M</b> (+12%)
<ul>
<li>North &euro; 1.9M</li>
<li>South &euro; 1.4M</li>
</ul>
</li>
<li>New users: 18,400</li>
<li>Churn: 2.1% (down from 3.0%)</li>
</ul>
<h3>Regional order</h3>
<ol start="2">
<li>South zone</li>
<li>North zone</li>
</ol>
<blockquote>
<p>Fastest growth quarter since launch &mdash; the team shipped 41 releases.</p>
</blockquote>
<hr>
<h2>Deployment log</h2>
<pre>
$ falcon deploy --env prod
build   6.2s  ok
upload  2 items  ok
Done in 8.4s
</pre>
<p>For details see the <a href="https://example.com/falcon/q3">Q3 dashboard</a> or contact <a href="mailto:team@example.com">the team</a>.</p>
<h2>Regional summary</h2>
<table>
<tr><th>Region</th><th>Revenue</th><th>Growth</th></tr>
<tr><td>North</td><td>&euro; 1.9M</td><td>+9%</td></tr>
<tr><td>South</td><td>&euro; 1.4M</td><td>+18%</td></tr>
<tr><td>East</td><td>&euro; 0.9M</td><td>+7%</td></tr>
</table>
<p><u>Note</u>: figures are unaudited &hellip; final numbers next week &copy; 2025 Falcon Ltd&reg;</p>
<form action="/subscribe">
<input type="email" name="email" placeholder="you@example.com">
<button type="submit">Subscribe</button>
</form>
<img src="chart.png" alt="Revenue chart">
<!-- footer -->
</main>
</body>
</html>
`;
}
