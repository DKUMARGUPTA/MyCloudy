import type { OptionValues } from "@/lib/tools/config-types";
import type { MdBlock, MdInlineRun } from "../markdown-to-pdf/engine";

/**
 * HTML → blocks parser (Task b3-d) — a pure TS tag-soup scanner. NO
 * DOMParser: workers and bun both need our own, and "tag-soup tolerant"
 * means we behave like a browser's error recovery, never throw on
 * malformed input, and auto-close everything at EOF.
 *
 * What the scanner understands (the exact HTML subset our own pdf-to-html
 * emitter produces — plus reasonable generic HTML):
 *
 *   h1/h2/h3 (+h4/h5/h6 → heading 3), p, br (hard break), ul/ol/li with
 *   nesting (depth) and ordinals, pre (verbatim whitespace + entities),
 *   strong/b (bold), em/i/cite/dfn/var (italic), code/kbd/samp/tt
 *   (monospace), blockquote (nested children), hr, and entities
 *   (&amp; &lt; &gt; &quot; &apos; &nbsp;→space, &#NNN;, &#xHH;).
 *
 *   head/script/style/title/textarea/template/svg/iframe/… are SKIPPED
 *   WITH their content (script/style bodies are scanned as raw text for
 *   their own close tag only, so a "</p>" inside a JS string can never
 *   leak into the document). Unknown tags are transparent — children
 *   still process. Void elements (meta/link/img/input/br/hr/…) never
 *   stack. Attributes are parsed (quote-aware, so ">" inside an attribute
 *   value is safe) and ignored — CSS classes/styles do not affect the
 *   render (documented honesty).
 *
 * Security/order note: tags are scanned on the RAW source and entities
 * are decoded only inside TEXT nodes — exactly how browsers do it — so
 * "&lt;b&gt;" renders as the text "<b>", never as a tag.
 *
 * iOS-safe (worklog lesson IOS-COMPAT): no String.prototype.matchAll /
 * replaceAll, no regex lookbehind, no Object.hasOwn / structuredClone —
 * split/join and plain exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Public model                                                        */
/* ------------------------------------------------------------------ */

/** One styled fragment of text inside a block. */
export interface HtmlRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** <code>/<kbd>/<samp>/<tt> → monospace family. */
  mono: boolean;
}

export type HtmlBlockType =
  | "heading1"
  | "heading2"
  | "heading3"
  | "para"
  | "li"
  | "pre"
  | "quote"
  | "hr";

/** One semantic block of the parsed document. */
export interface HtmlBlock {
  type: HtmlBlockType;
  /** Inline runs (hr: empty; quote: empty — see children). */
  runs: HtmlRun[];
  /** Convenience: all runs joined (the minimal {type, text} shape). */
  text: string;
  /** True when EVERY run is bold (whole-block <b> convenience). */
  bold: boolean;
  /** li: the enclosing list was an <ol>. */
  ordered?: boolean;
  /** li: list nesting depth (0 = top level). */
  depth?: number;
  /** li: 1-based ordinal inside its ordered list. */
  number?: number;
  /** quote: the blocks nested inside. */
  children?: HtmlBlock[];
}

/* ------------------------------------------------------------------ */
/* Entity decoding (text nodes only)                                   */
/* ------------------------------------------------------------------ */

/** Required set + a curated WinAnsi-safe extension (all encodable in the
 *  14 standard fonts, so decoding them can never force the Noto path). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bull: "\u2022",
  deg: "\u00B0",
  euro: "\u20AC",
  cent: "\u00A2",
  pound: "\u00A3",
  yen: "\u00A5",
  sect: "\u00A7",
  para: "\u00B6",
  dagger: "\u2020",
  Dagger: "\u2021",
  laquo: "\u00AB",
  raquo: "\u00BB",
  times: "\u00D7",
  divide: "\u00F7",
  plusmn: "\u00B1",
  sup2: "\u00B2",
  sup3: "\u00B3",
  frac12: "\u00BD",
  micro: "\u00B5",
  middot: "\u00B7",
  // legacy uppercase forms (HTML5 keeps these valid)
  AMP: "&",
  LT: "<",
  GT: ">",
  QUOT: '"',
  COPY: "\u00A9",
  REG: "\u00AE",
  TRADE: "\u2122",
  NBSP: " ",
};

/** Entities browsers accept WITHOUT the semicolon (HTML5 legacy set). */
const NO_SEMI_ENTITIES = new Set([
  "amp",
  "lt",
  "gt",
  "quot",
  "AMP",
  "LT",
  "GT",
  "QUOT",
]);

/**
 * Windows-1252 aliases for the C1 zone — browsers show &#151; as an em
 * dash, so numeric references in 0x80–0x9F map through this table
 * instead of producing an unprintable control character.
 */
const CP1252_C1: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g;

/** Decodes one numeric character reference body ("#2344" / "#x0928"). */
function decodeNumericRef(body: string): string {
  const hex = body.length > 1 && (body[1] === "x" || body[1] === "X");
  const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
  if (!Number.isFinite(cp)) return "";
  if (cp >= 0x80 && cp <= 0x9f) {
    const mapped = CP1252_C1[cp];
    return mapped !== undefined ? mapped : ""; // undefined slots → drop
  }
  if (cp === 0 || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) {
    return ""; // invalid control reference → dropped
  }
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return ""; // out of range / lone surrogate → dropped
  }
  return String.fromCodePoint(cp);
}

/**
 * Single-pass entity decoding (no double-unescape: "&amp;lt;" → "&lt;").
 * Unknown entities pass through literally — honest, like a browser.
 */
export function unescapeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole: string, body: string): string => {
    if (body.startsWith("#")) return decodeNumericRef(body);
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    const hasSemi = whole.charCodeAt(whole.length - 1) === 0x3b; // ";"
    if (!hasSemi && NO_SEMI_ENTITIES.has(body)) {
      const loose = NAMED_ENTITIES[body];
      return loose !== undefined ? loose : whole;
    }
    return whole;
  });
}

/** Removes C0 control chars (keeps \t \n \r) + DEL — invalid in HTML text. */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/* ------------------------------------------------------------------ */
/* File decode + binary sniff                                          */
/* ------------------------------------------------------------------ */

export type HtmlFileVerdict =
  | { kind: "ok"; text: string }
  | { kind: "binary" }
  | { kind: "empty" };

const SNIFF_WINDOW = 4096;

/**
 * UTF-8 decode + binary sniff for HTML input. The registry accepts "url"
 * (anything), so THIS is where honesty lives: a dropped .docx/.zip/.pdf
 * shows a high proportion of control bytes (or NULs / the %PDF- magic /
 * mojibake replacement storm) and is rejected as binary; a plain-text
 * file (HTML or otherwise) decodes fine. Any decodable text is treated
 * as HTML per browsers' tag-soup behavior — plain text simply parses to
 * one big paragraph.
 */
export function readHtmlFile(bytes: Uint8Array): HtmlFileVerdict {
  if (bytes.length >= 4) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic === "%PDF") return { kind: "binary" };
  }
  const windowEnd = Math.min(bytes.length, SNIFF_WINDOW);
  let controls = 0;
  for (let i = 0; i < windowEnd; i += 1) {
    const b = bytes[i];
    if (b === 0x00) return { kind: "binary" }; // NUL = never text
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      controls += 1;
    }
  }
  if (windowEnd > 0 && controls / windowEnd > 0.05) {
    return { kind: "binary" }; // high proportion of control chars
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const head = decoded.slice(0, SNIFF_WINDOW);
  let replacements = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head.charCodeAt(i) === 0xfffd) replacements += 1;
  }
  if (head.length > 0 && replacements / head.length > 0.1) {
    return { kind: "binary" };
  }
  const text = decoded.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  if (text.replace(/\s/g, "").length === 0) return { kind: "empty" };
  return { kind: "ok", text };
}

/* ------------------------------------------------------------------ */
/* Tag classification                                                  */
/* ------------------------------------------------------------------ */

/** Elements with no content/end tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Raw-text elements: everything until their OWN close tag is consumed
 * and discarded (a "</p>" inside a JS string can never close a real p).
 */
const RAW_SKIP_TAGS = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
]);

/** Parsed normally, but all output is discarded (their text is not
 *  document text). Their children stack-track and close honestly. */
const SKIP_TAGS = new Set([
  "head",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "applet",
  "canvas",
  "select",
  "datalist",
  "dialog",
  "video",
  "audio",
  "picture",
]);

/** Inline elements — skipped over by the implied-end-tag scans. */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "output",
  "q",
  "ruby",
  "rt",
  "rp",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);

/** Start tags that imply </p> (HTML5's list, trimmed to what we parse). */
const CLOSES_P = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
  "blockquote",
  "div",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "hr",
  "address",
  "article",
  "aside",
  "details",
  "dialog",
  "dir",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "main",
  "menu",
  "nav",
  "section",
  "summary",
  "center",
]);

/**
 * Transparent containers that end the current loose-text run on BOTH
 * open and close (div/section/td/…): their text still renders — as its
 * own paragraph — but they carry no block semantics of their own.
 */
const PARAGRAPH_BREAKERS = new Set([
  "html",
  "body",
  "main",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "figure",
  "figcaption",
  "form",
  "fieldset",
  "address",
  "details",
  "summary",
  "center",
  "dir",
  "menu",
  "hgroup",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "dialog",
  "marquee",
]);

const BOLD_TAGS = new Set(["b", "strong"]);
const ITALIC_TAGS = new Set(["i", "em", "cite", "dfn", "var"]);
const MONO_TAGS = new Set(["code", "kbd", "samp", "tt"]);

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 3,
  h5: 3,
  h6: 3,
};

/* ------------------------------------------------------------------ */
/* Stack machine                                                       */
/* ------------------------------------------------------------------ */

type ElementKind =
  | "heading"
  | "para"
  | "li"
  | "pre"
  | "quote"
  | "list"
  | "other";

interface OpenElement {
  name: string;
  kind: ElementKind;
  /** This element itself turns a style flag on. */
  bold: boolean;
  italic: boolean;
  mono: boolean;
  /** heading: 1-3. */
  level: number;
  /** list: <ol>? */
  ordered: boolean;
  /** list: nesting depth (a root list is 1). */
  depth: number;
  /** list: items opened so far (the ordinal source). */
  itemCount: number;
  /** li: ordinal (1-based). */
  number: number;
  /** li: already flushed early (nested-list ordering) — trailing text
   *  after a nested list emits a second bullet with the same number. */
  emitted: boolean;
  /** owner kinds: the accumulated inline runs. */
  runs: HtmlRun[];
}

function makeElement(name: string): OpenElement {
  const level = HEADING_LEVELS[name];
  return {
    name,
    kind:
      level !== undefined
        ? "heading"
        : name === "p"
          ? "para"
          : name === "li"
            ? "li"
            : name === "pre"
              ? "pre"
              : name === "blockquote"
                ? "quote"
                : name === "ul" || name === "ol"
                  ? "list"
                  : "other",
    bold: BOLD_TAGS.has(name),
    italic: ITALIC_TAGS.has(name),
    mono: MONO_TAGS.has(name),
    level: level ?? 0,
    ordered: name === "ol",
    depth: 0,
    itemCount: 0,
    number: 1,
    emitted: false,
    runs: [],
  };
}

/** Trims run edges + drops empties (keeps "\n" hard-break runs intact). */
function cleanRuns(runs: HtmlRun[]): HtmlRun[] {
  const out: HtmlRun[] = [];
  for (const run of runs) {
    let text = run.text;
    if (out.length === 0) text = text.replace(/^[\s]+/, "");
    if (text.length === 0) continue;
    out.push({ ...run, text });
  }
  // trailing trim on the LAST surviving run
  for (let i = out.length - 1; i >= 0; i -= 1) {
    out[i].text = out[i].text.replace(/[\s]+$/, "");
    if (out[i].text.length > 0) break;
    out.pop();
  }
  return out;
}

function runsHaveText(runs: HtmlRun[]): boolean {
  for (const run of runs) {
    if (run.text.trim().length > 0) return true;
  }
  return false;
}

function blockFromRuns(
  type: HtmlBlockType,
  runs: HtmlRun[]
): HtmlBlock | null {
  const cleaned = cleanRuns(runs);
  if (!runsHaveText(cleaned)) return null;
  const text = cleaned.map((run) => run.text).join("");
  let bold = true;
  for (const run of cleaned) {
    if (!run.bold) {
      bold = false;
      break;
    }
  }
  return { type, runs: cleaned, text, bold };
}

/* ------------------------------------------------------------------ */
/* The parser                                                          */
/* ------------------------------------------------------------------ */

/**
 * Tag-soup scan: source → block list. Never throws; malformed input
 * auto-closes at EOF the way browsers recover.
 */
export function parseHtml(source: string): HtmlBlock[] {
  const text = source.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const n = text.length;

  const stack: OpenElement[] = [];
  /** Root + one entry per open blockquote. */
  const scopes: HtmlBlock[][] = [[]];
  /** Loose (owner-less) text per scope — flushed as a para at boundaries. */
  const looseStack: HtmlRun[][] = [[]];
  /** SKIP_TAGS currently open (output discarded while > 0). */
  let skipCount = 0;

  const scopeBlocks = (): HtmlBlock[] => scopes[scopes.length - 1];
  const looseRuns = (): HtmlRun[] => looseStack[looseStack.length - 1];

  /** Nearest open un-emitted li, stopping at quote/owner boundaries. */
  const enclosingLi = (): OpenElement | null => {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const el = stack[s];
      if (el.name === "blockquote") return null;
      if (el.kind === "li") {
        if (!el.emitted) return el;
        continue; // already flushed — look outward
      }
      if (el.kind === "para" || el.kind === "pre") return null;
    }
    return null;
  };

  const pushBlock = (block: HtmlBlock): void => {
    scopeBlocks().push(block);
  };

  const liBlock = (li: OpenElement): HtmlBlock => {
    const cleaned = cleanRuns(li.runs);
    return {
      type: "li",
      runs: cleaned,
      text: cleaned.map((run) => run.text).join(""),
      bold: false,
      ordered: li.ordered,
      depth: li.depth,
      number: li.number,
    };
  };

  /** Emits the item's pending text and marks it flushed (used when a
   *  nested list or structured block must come AFTER the item text). */
  const flushLi = (li: OpenElement): void => {
    if (runsHaveText(li.runs)) pushBlock(liBlock(li));
    li.emitted = true;
    li.runs = [];
  };

  const emitBlock = (block: HtmlBlock): void => {
    if (skipCount > 0) return;
    const li = enclosingLi();
    if (li !== null) {
      if (block.type === "para") {
        // paragraph-ish content of an open list item merges into it
        if (runsHaveText(li.runs)) {
          li.runs.push({ text: "\n", bold: false, italic: false, mono: false });
        }
        for (const run of block.runs) li.runs.push(run);
        return;
      }
      // structured content (heading/pre/quote/hr/nested item) hoists out
      // of the item, after its text — the markdown engine's own rule.
      flushLi(li);
    }
    pushBlock(block);
  };

  const flushLoose = (): void => {
    if (skipCount > 0) return;
    const loose = looseRuns();
    if (loose.length === 0) return;
    const runs = loose.splice(0, loose.length);
    const block = blockFromRuns("para", runs);
    if (block !== null) emitBlock(block);
  };

  /** Nearest text owner above (or null → the scope's loose buffer). */
  const findOwner = (): OpenElement | null => {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const el = stack[s];
      if (
        el.kind === "heading" ||
        el.kind === "para" ||
        el.kind === "li" ||
        el.kind === "pre"
      ) {
        return el;
      }
      if (el.kind === "quote" || el.kind === "list") return null;
    }
    return null;
  };

  const styleFlags = (): { bold: boolean; italic: boolean; mono: boolean } => {
    let bold = false;
    let italic = false;
    let mono = false;
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      const el = stack[s];
      if (el.bold) bold = true;
      if (el.italic) italic = true;
      if (el.mono) mono = true;
    }
    return { bold, italic, mono };
  };

  const mergeInto = (runs: HtmlRun[], run: HtmlRun): void => {
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.text !== "\n" &&
      run.text !== "\n" &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.mono === run.mono
    ) {
      last.text += run.text;
    } else {
      runs.push(run);
    }
  };

  const appendBreak = (): void => {
    if (skipCount > 0) return;
    const run: HtmlRun = { text: "\n", ...styleFlags() };
    const owner = findOwner();
    if (owner !== null) owner.runs.push(run);
    else looseRuns().push(run);
  };

  const appendText = (raw: string): void => {
    if (skipCount > 0 || raw.length === 0) return;
    const decoded = stripControls(unescapeEntities(raw));
    if (decoded.length === 0) return;
    const owner = findOwner();
    if (owner !== null && owner.kind === "pre") {
      mergeInto(owner.runs, { text: decoded, ...styleFlags() });
      return;
    }
    // whitespace collapses across nodes (HTML rendering semantics)
    const norm = decoded.replace(/[\s\u00A0]+/g, " ");
    if (norm.length === 0) return;
    const runs = owner !== null ? owner.runs : looseRuns();
    if (norm === " ") {
      const last = runs[runs.length - 1];
      if (last === undefined || last.text === "\n") return;
      if (!last.text.endsWith(" ")) {
        mergeInto(runs, { text: " ", ...styleFlags() });
      }
      return;
    }
    let t = norm;
    const last = runs[runs.length - 1];
    if (last === undefined || last.text.endsWith(" ") || last.text === "\n") {
      t = t.replace(/^ +/, "");
    }
    if (t.length === 0) return;
    mergeInto(runs, { text: t, ...styleFlags() });
  };

  const finishElement = (el: OpenElement): void => {
    switch (el.kind) {
      case "heading":
      case "para": {
        const type =
          el.kind === "para"
            ? "para"
            : el.level === 1
              ? "heading1"
              : el.level === 2
                ? "heading2"
                : "heading3";
        const block = blockFromRuns(type, el.runs);
        if (block !== null) emitBlock(block);
        return;
      }
      case "li": {
        if (runsHaveText(el.runs)) {
          // through emitBlock: an outer open item flushes ITS pending
          // text first, so nested lists stay in document order
          emitBlock(liBlock(el));
        }
        return;
      }
      case "pre": {
        let content = el.runs.map((run) => run.text).join("");
        // HTML: a newline immediately after <pre> is ignored
        if (content.startsWith("\n")) content = content.slice(1);
        if (content.trim().length > 0) {
          emitBlock({
            type: "pre",
            runs: [{ text: content, bold: false, italic: false, mono: true }],
            text: content,
            bold: false,
          });
        }
        return;
      }
      case "quote": {
        // close the quote's scope first: loose text + children
        const quoteLoose = looseStack.pop();
        const children = scopes.pop();
        if (quoteLoose !== undefined && quoteLoose.length > 0) {
          const block = blockFromRuns("para", quoteLoose);
          if (block !== null && children !== undefined) children.push(block);
        }
        if (skipCount === 0 && children !== undefined && children.length > 0) {
          emitBlock({
            type: "quote",
            runs: [],
            text: "",
            bold: false,
            children,
          });
        }
        return;
      }
      default:
        return; // list / other — nothing to flush
    }
  };

  const closeElement = (name: string): void => {
    let idx = -1;
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].name === name) {
        idx = s;
        break;
      }
    }
    if (idx === -1) return; // stray close tag — ignored (tag-soup)
    while (stack.length > idx) {
      const el = stack.pop();
      if (el === undefined) break;
      popFinish(el);
    }
  };

  /** Pops-one helper: skip bookkeeping + finish + the loose-text flush
   *  every paragraph-breaker close owes (its text became its own para). */
  const popFinish = (el: OpenElement): void => {
    if (SKIP_TAGS.has(el.name)) skipCount -= 1;
    finishElement(el);
    if (PARAGRAPH_BREAKERS.has(el.name)) flushLoose();
  };

  /** HTML5 implied end tags: an open <p> closes before these opens; an
   *  open <li> closes before a sibling <li>; <body> closes <head>. A
   *  block opened inside an open heading also closes the heading —
   *  invalid soup, but keeping document order beats DOM fidelity there
   *  (otherwise the heading would emit at EOF, after everything inside
   *  it). */
  const impliedCloses = (name: string): void => {
    if (name === "body") {
      closeElement("head");
      return;
    }
    const firstStructural = (): OpenElement | null => {
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        const el = stack[s];
        if (INLINE_TAGS.has(el.name)) continue;
        return el;
      }
      return null;
    };
    if (name === "li") {
      const found = firstStructural();
      if (found !== null && found.name === "li") closeElement("li");
    }
    if (CLOSES_P.has(name) || PARAGRAPH_BREAKERS.has(name)) {
      const found = firstStructural();
      if (found !== null) {
        if (found.name === "p") closeElement("p");
        else if (found.kind === "heading") closeElement(found.name);
      }
    }
  };

  const openElement = (name: string): void => {
    impliedCloses(name);
    if (PARAGRAPH_BREAKERS.has(name) || CLOSES_P.has(name)) flushLoose();
    const el = makeElement(name);
    if (SKIP_TAGS.has(name)) skipCount += 1;
    if (el.kind === "list") {
      // nesting depth = open lists after this push
      let depth = 0;
      for (const open of stack) {
        if (open.kind === "list") depth += 1;
      }
      el.depth = depth + 1;
    } else if (el.kind === "li") {
      // nearest enclosing list supplies ordered/ordinal/depth
      let list: OpenElement | null = null;
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].kind === "list") {
          list = stack[s];
          break;
        }
      }
      if (list === null) {
        // stray <li> outside any list — behaves as a paragraph
        el.kind = "para";
        el.name = "p";
      } else {
        list.itemCount += 1;
        el.ordered = list.ordered;
        el.number = list.itemCount;
        el.depth = list.depth - 1;
      }
    }
    stack.push(el);
    if (el.kind === "quote") {
      scopes.push([]);
      looseStack.push([]);
    }
  };

  const handleVoid = (name: string): void => {
    if (name === "hr") {
      flushLoose();
      emitBlock({ type: "hr", runs: [], text: "", bold: false });
      return;
    }
    if (name === "br") {
      appendBreak();
      return;
    }
    // img/input/meta/link/... — nothing rendered, nothing stacked
  };

  /**
   * Raw-text skip: consume until this element's OWN close tag. Content
   * is discarded entirely (script/style bodies must never leak as text).
   */
  const skipRawElement = (name: string, from: number): number => {
    const closeRe = new RegExp(`</[ \\t\\r\\n]*${name}[ \\t\\r\\n]*>`, "i");
    const rest = text.slice(from);
    const match = closeRe.exec(rest);
    if (match === null) return n; // never closed — everything is content
    return from + match.index + match[0].length;
  };

  /* ---------------- the scan loop ---------------- */

  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      appendText(text.slice(i));
      break;
    }
    if (lt > i) appendText(text.slice(i, lt));

    // comments
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // doctype / CDATA / processing instructions → bogus comment
    if (text.startsWith("<!", lt) || text.startsWith("<?", lt)) {
      const end = text.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // close tag
    if (text.startsWith("</", lt)) {
      const gt = text.indexOf(">", lt + 2);
      const raw = gt === -1 ? text.slice(lt + 2) : text.slice(lt + 2, gt);
      const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(raw.trim());
      if (nameMatch !== null) closeElement(nameMatch[0].toLowerCase());
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    // an open tag must start with a letter — otherwise it is literal
    // text (tag-soup honesty: "1 < 2" renders as text)
    const after = lt + 1;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text.slice(after));
    if (nameMatch === null) {
      appendText("<");
      i = after;
      continue;
    }
    const name = nameMatch[0].toLowerCase();

    // find the tag end, quote-aware (">" inside an attribute is safe)
    let k = after + name.length;
    let quote = "";
    while (k < n) {
      const ch = text[k];
      if (quote !== "") {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      k += 1;
    }
    const tagEnd = k; // index of ">" or n
    const selfClose =
      tagEnd > after + 1 && text[tagEnd - 1] === "/" && text[tagEnd - 2] !== "=";
    const next = tagEnd < n ? tagEnd + 1 : n;

    if (RAW_SKIP_TAGS.has(name) && !selfClose) {
      i = skipRawElement(name, next);
      continue;
    }
    if (VOID_TAGS.has(name)) {
      handleVoid(name);
      i = next;
      continue;
    }
    openElement(name);
    if (selfClose) closeElement(name);
    i = next;
  }

  // EOF — auto-close everything, innermost first (browser recovery)
  while (stack.length > 0) {
    const el = stack.pop();
    if (el === undefined) break;
    popFinish(el);
  }
  flushLoose();
  return scopes[0];
}

/* ------------------------------------------------------------------ */
/* Helpers over the block list                                         */
/* ------------------------------------------------------------------ */

/** All rendered text of the document (runs + quote children, in order). */
export function htmlBlocksText(blocks: HtmlBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "quote") {
      parts.push(htmlBlocksText(block.children ?? []));
      continue;
    }
    parts.push(block.text);
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Blocks → the markdown engine's model                                 */
/* ------------------------------------------------------------------ */

function toMdRuns(runs: HtmlRun[]): MdInlineRun[] {
  const out: MdInlineRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    out.push({
      text: run.text,
      bold: run.bold,
      italic: run.italic,
      code: run.mono,
      link: false,
      sup: false,
    });
  }
  return out;
}

/**
 * HtmlBlock[] → MdBlock[] (the markdown-to-pdf engine's native input —
 * imported type-only/read-only, the established cross-tool pattern). The
 * renderer then owns headings/paragraphs/lists/code/quotes/rules exactly
 * like it does for Markdown files.
 */
export function htmlBlocksToMdBlocks(blocks: HtmlBlock[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading1":
      case "heading2":
      case "heading3": {
        const level =
          block.type === "heading1" ? 1 : block.type === "heading2" ? 2 : 3;
        const runs = toMdRuns(block.runs);
        if (runs.length > 0) out.push({ kind: "heading", level, runs });
        break;
      }
      case "para": {
        const runs = toMdRuns(block.runs);
        if (runs.length > 0) out.push({ kind: "paragraph", runs });
        break;
      }
      case "li": {
        const runs = toMdRuns(block.runs);
        if (runs.length > 0) {
          out.push({
            kind: "listItem",
            depth: block.depth ?? 0,
            ordered: block.ordered === true,
            number: block.number ?? 1,
            runs,
          });
        }
        break;
      }
      case "pre": {
        // tabs → 4 spaces (the engine's own code normalization)
        const lines = block.text.replace(/\t/g, "    ").split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        if (lines.length > 0) out.push({ kind: "code", lines });
        break;
      }
      case "quote": {
        const children = htmlBlocksToMdBlocks(block.children ?? []);
        if (children.length > 0) out.push({ kind: "quote", children });
        break;
      }
      case "hr":
        out.push({ kind: "rule" });
        break;
    }
  }
  return out;
}

/** Option normalization for the worker (and the smoke). */
export function resolveHtmlToPdfOptions(values: OptionValues): {
  pageSize: "a4" | "letter";
  margin: number;
  bodySize: number;
  monoSize: number;
} {
  const num = (value: unknown, allowed: number[], fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return allowed.indexOf(parsed) >= 0 ? parsed : fallback;
  };
  const margin = Number(values.margin);
  return {
    pageSize: values.pageSize === "letter" ? "letter" : "a4",
    margin: Number.isFinite(margin)
      ? Math.min(40, Math.max(10, margin))
      : 20,
    bodySize: num(values.bodySize, [10, 11, 12], 11),
    monoSize: num(values.monoSize, [8, 9, 10], 9),
  };
}
