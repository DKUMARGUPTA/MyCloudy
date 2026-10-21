/**
 * RTF to PDF (RB2-c — the 73rd tool) — pure model. No DOM, no pdf-lib,
 * no worker APIs: the same parseRtf feeds the surface's live file summary
 * AND the worker's render path, so the preview numbers can never disagree
 * with the output.
 *
 * RTF is PLAIN TEXT (not a zip): {\rtf1\ansi…{\fonttbl…}{\colortbl…} body…}
 *  - tokenizeRtf: byte scan → tokens: `{` (group push), `}` (group pop),
 *    `\word[num?]` (control word + optional signed numeric param),
 *    `\'hh` (hex escape → codepage byte), escaped literals `\\` `\{ `\}`,
 *    plain text runs. \binN's payload is skipped byte-count-wise (binary
 *    braces must never reach the group stack). CR/LF is ignored (RTF
 *    formatting lives in \par, not newlines); `\` + newline IS \par.
 *  - parseRtf: group STACK state machine (frame copies on `{`, pop on `}`)
 *    tracking bold/italic/underline, \fsN half-points, \fN fonttbl index,
 *    \cfN colortbl colour, \ql/\qc/\qr/\qj alignment, \plain / \pard
 *    resets, \par / \line / \tab / \page, \paperw/\paperh + \marg* (twips,
 *    1440/inch, defaults 12240×15840 = US Letter + 1800 margins),
 *    {\fonttbl…} (index → name), {\colortbl;…} (index 0 = auto),
 *    {\stylesheet…} (\sN style refs; \sN N≤3 approximates to heading
 *    sizing when no stylesheet entry exists). Destinations — fonttbl,
 *    colortbl, stylesheet are parsed; {\*\…} starred groups, info, pict,
 *    obj, headers/footers, list tables… are skipped with brace tracking.
 *    Unicode: \uN (16-bit signed → String.fromCharCode; the \ucN
 *    substitution chars after it are dropped). `\'hh` decodes via a
 *    WinAnsi (CP1252) table for 0x80-0xFF (\'e9 → é, \'95 → •).
 *
 * Honest limits (mirrored in config.ts): images are not carried, tables
 * flatten to text lines (\cell → tab, \row → paragraph), headers/footers
 * and footnotes are dropped, and Hindi bold renders regular (the Noto
 * face ships Regular only).
 */

/* ------------------------------------------------------------------ */
/* Hard caps (defensive — a tampered/pathological file can never hang)  */
/* ------------------------------------------------------------------ */

export const MAX_GROUP_DEPTH = 64;
export const MAX_TOKENS = 1_500_000;
export const MAX_PARAS = 5_000;
export const MAX_RUN_TEXT = 4_000;
export const MAX_PARA_TEXT = 20_000;
export const MAX_RUNS_PER_PARA = 400;
export const MAX_FONTS = 64;
export const MAX_COLORS = 64;
export const MAX_STYLES = 64;

/** RTF twips per inch is 1440; pt per inch is 72 → twips/20 = pt. */
const TWIPS_PER_PT = 20;
const DEFAULT_PAPERW_TW = 12240; // 612 pt — US Letter portrait
const DEFAULT_PAPERH_TW = 15840; // 792 pt
const DEFAULT_MARGIN_TW = 1800; // 90 pt — the RTF default on all sides

/* ------------------------------------------------------------------ */
/* Doc model (IR)                                                       */
/* ------------------------------------------------------------------ */

export type RtfAlign = "left" | "center" | "right" | "justify";

export interface RtfColor {
  /** 0-255 components as written in the \colortbl. */
  r: number;
  g: number;
  b: number;
}

export interface RtfRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** resolved \fsN size in pt (clamped 4-96; default 12). */
  sizePt: number;
  /** resolved \cfN colortbl colour; undefined = default ink. */
  color?: RtfColor;
}

export interface RtfPara {
  align: RtfAlign;
  runs: RtfRun[];
  /** \page landed before this paragraph → start it on a fresh page. */
  pageBreakBefore?: boolean;
}

export interface RtfMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface RtfDoc {
  pageW: number; // pt
  pageH: number; // pt
  margins: RtfMargins; // pt
  paras: RtfPara[];
  /** fonttbl index → font name ("" for gaps). */
  fontNames: string[];
  /** true when any hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

function clampSizePt(fsHalf: number): number {
  const pt = fsHalf / 2;
  if (!Number.isFinite(pt)) return 12;
  return Math.min(96, Math.max(4, pt));
}

/* ------------------------------------------------------------------ */
/* WinAnsi (CP1252) table for \'hh and stray high bytes                  */
/* ------------------------------------------------------------------ */

/** 0x80-0x9F are the CP1252 specials; 0xA0-0xFF are Latin-1 identity. */
const CP1252_80_9F: number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

/** One codepage byte (0x00-0xFF) → the CP1252 character. */
export function winAnsiChar(byte: number): string {
  if (byte >= 0x80 && byte < 0xa0) {
    return String.fromCharCode(CP1252_80_9F[byte - 0x80] ?? 0xfffd);
  }
  return String.fromCharCode(byte & 0xff);
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (word-to-pdf copy)    */
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

/** true when any drawn run needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(doc: RtfDoc): boolean {
  for (const para of doc.paras) {
    for (const run of para.runs) {
      if (!isWinAnsiText(run.text)) return true;
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
/* Tokenizer                                                            */
/* ------------------------------------------------------------------ */

export type RtfToken =
  | { t: "{" }
  | { t: "}" }
  | { t: "c"; w: string; p?: number } // control word + optional signed param
  | { t: "x"; b: number } // \'hh hex escape byte
  | { t: "s"; s: string }; // plain text (escapes already resolved)

function isAlphaByte(b: number): boolean {
  return (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
}
function isDigitByte(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}
function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  return -1;
}

export interface TokenizedRtf {
  tokens: RtfToken[];
  truncated: boolean;
}

/**
 * Linear byte scan. \binN's payload is skipped byte-count-wise (binary
 * braces must never become group tokens); \r/\n are dropped (RTF ignores
 * them; `\` + newline is \par); stray ≥0x80 bytes decode as CP1252.
 */
export function tokenizeRtf(bytes: Uint8Array): TokenizedRtf {
  const tokens: RtfToken[] = [];
  let truncated = false;
  const n = bytes.length;
  let i = 0;
  let text = "";

  const flushText = (): void => {
    if (text !== "") {
      tokens.push({ t: "s", s: text });
      text = "";
    }
  };

  while (i < n) {
    if (tokens.length >= MAX_TOKENS) {
      truncated = true;
      break;
    }
    const b = bytes[i];

    if (b === 0x7b /* { */) {
      flushText();
      tokens.push({ t: "{" });
      i += 1;
      continue;
    }
    if (b === 0x7d /* } */) {
      flushText();
      tokens.push({ t: "}" });
      i += 1;
      continue;
    }

    if (b === 0x5c /* \ */) {
      const c = i + 1 < n ? bytes[i + 1] : -1;
      if (c < 0) break; // trailing lone backslash
      if (isAlphaByte(c)) {
        // ---- control word: \word[-]digits? ----
        let j = i + 1;
        let word = "";
        while (j < n && isAlphaByte(bytes[j])) {
          word += String.fromCharCode(bytes[j]);
          j += 1;
        }
        let param: number | undefined;
        if (j < n && (bytes[j] === 0x2d || bytes[j] === 0x2b)) {
          const neg = bytes[j] === 0x2d;
          j += 1;
          let digits = "";
          while (j < n && isDigitByte(bytes[j])) {
            digits += String.fromCharCode(bytes[j]);
            j += 1;
          }
          if (digits !== "") {
            const v = Number.parseInt(digits, 10);
            if (Number.isFinite(v)) param = neg ? -v : v;
          }
        } else {
          let digits = "";
          while (j < n && isDigitByte(bytes[j])) {
            digits += String.fromCharCode(bytes[j]);
            j += 1;
          }
          if (digits !== "") {
            const v = Number.parseInt(digits, 10);
            if (Number.isFinite(v)) param = v;
          }
        }
        // one space after a control word is consumed as its delimiter
        if (j < n && bytes[j] === 0x20) j += 1;
        flushText();
        tokens.push({ t: "c", w: word, p: param });
        i = j;
        // \binN: the next N bytes are raw binary (may contain braces) —
        // the tokenizer skips them so the group stack stays truthful.
        if (word === "bin" && param !== undefined && param > 0) {
          i += param;
        }
        continue;
      }
      if (c === 0x27 /* ' */) {
        // ---- \'hh hex escape ----
        const hi = i + 2 < n ? hexVal(bytes[i + 2]) : -1;
        const lo = i + 3 < n ? hexVal(bytes[i + 3]) : -1;
        if (hi >= 0 && lo >= 0) {
          flushText();
          tokens.push({ t: "x", b: hi * 16 + lo });
          i += 4;
          continue;
        }
        i += 2; // malformed — drop the backslash + quote
        continue;
      }
      if (c === 0x2a /* * */) {
        flushText(); // destination flag — never text
        tokens.push({ t: "c", w: "*", p: undefined });
        i += 2;
        continue;
      }
      if (c === 0x7e /* ~ */) {
        text += "\u00a0"; // non-breaking space
        i += 2;
        continue;
      }
      if (c === 0x5f /* _ */) {
        text += "\u2011"; // non-breaking hyphen
        i += 2;
        continue;
      }
      if (c === 0x2d /* - */) {
        i += 2; // optional hyphen — dropped
        continue;
      }
      if (c === 0x5c) {
        text += "\\";
        i += 2;
        continue;
      }
      if (c === 0x7b) {
        text += "{";
        i += 2;
        continue;
      }
      if (c === 0x7d) {
        text += "}";
        i += 2;
        continue;
      }
      if (c === 0x0d || c === 0x0a) {
        // `\` + newline == \par (Word writes this for soft wrapping)
        flushText();
        tokens.push({ t: "c", w: "par", p: undefined });
        i += 2;
        if (c === 0x0d && i < n && bytes[i] === 0x0a) i += 1;
        continue;
      }
      i += 2; // any other control symbol — dropped
      continue;
    }

    if (b === 0x0d || b === 0x0a) {
      i += 1; // raw CRLF is ignored inside RTF text
      continue;
    }
    if (b === 0x09) {
      text += "\t"; // stray raw tab — treat as \tab
      i += 1;
      continue;
    }
    if (b < 0x20) {
      i += 1; // other control bytes — dropped
      continue;
    }
    text += winAnsiChar(b);
    i += 1;
  }
  flushText();
  return { tokens, truncated };
}

/* ------------------------------------------------------------------ */
/* Destination sets                                                     */
/* ------------------------------------------------------------------ */

/** Whole groups we skip (brace-tracked, so they can never unbalance us). */
const SKIP_DESTS = new Set([
  "info", "pict", "obj", "generator", "footnote", "footnotecontinued",
  "footer", "footerl", "footerr", "footerf", "header", "headerl",
  "headerr", "headerf", "listtable", "listoverridetable", "list",
  "listlevel", "revtbl", "rsidtbl", "filetbl", "themedata",
  "colorschememapping", "datastore", "latentstyles", "xmlnstbl",
  "mmathPr", "wgrffmtfilter", "pnsec", "pnsect", "ftnsep", "ftnsepc",
  "ftncn", "aftnsep", "aftnsepc", "aftncn", "private",
]);

const DEFAULT_FS_HALF = 24; // 12 pt

interface Frame {
  dest: "body" | "fonttbl" | "colortbl" | "stylesheet" | "skip";
  /* char state (group-scoped) */
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fsHalf: number;
  font: number;
  cf: number;
  uc: number;
  /* para state (group-scoped) */
  align: RtfAlign;
  styleNum: number;
  /* colortbl accumulator */
  cbR: number;
  cbG: number;
  cbB: number;
  /* fonttbl sub-group accumulator */
  ftNum: number;
  ftName: string;
  /* stylesheet sub-group accumulator */
  stNum: number;
  stFsHalf: number;
  stBold: boolean;
  stItalic: boolean;
  stName: string;
}

interface StyleEntry {
  fsHalf?: number;
  bold?: boolean;
  italic?: boolean;
}

interface StyleKey {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  sizePt: number;
  color?: RtfColor;
}

function sameColor(a: RtfColor | undefined, b: RtfColor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/* ------------------------------------------------------------------ */
/* Parser                                                               */
/* ------------------------------------------------------------------ */

/** Skips a UTF-8 BOM and validates the {\rtf magic; null when not RTF. */
function rtfMagicOk(bytes: Uint8Array): number | null {
  let off = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  ) {
    off = 3;
  }
  if (
    bytes.length >= off + 5 &&
    bytes[off] === 0x7b && bytes[off + 1] === 0x5c &&
    bytes[off + 2] === 0x72 && bytes[off + 3] === 0x74 &&
    bytes[off + 4] === 0x66
  ) {
    return off;
  }
  return null;
}

function emptyDoc(): RtfDoc {
  return {
    pageW: DEFAULT_PAPERW_TW / TWIPS_PER_PT,
    pageH: DEFAULT_PAPERH_TW / TWIPS_PER_PT,
    margins: {
      left: DEFAULT_MARGIN_TW / TWIPS_PER_PT,
      right: DEFAULT_MARGIN_TW / TWIPS_PER_PT,
      top: DEFAULT_MARGIN_TW / TWIPS_PER_PT,
      bottom: DEFAULT_MARGIN_TW / TWIPS_PER_PT,
    },
    paras: [],
    fontNames: [],
    truncated: false,
  };
}

/** Approximate heading sizing when \sN has no stylesheet entry. */
function approxStyleFsHalf(styleNum: number): number | undefined {
  if (styleNum === 1) return 32; // Heading 1 ≈ 16 pt
  if (styleNum === 2) return 26; // Heading 2 ≈ 13 pt
  if (styleNum === 3) return 23; // Heading 3 ≈ 11.5 pt
  return undefined;
}

class RtfAssembler {
  readonly doc: RtfDoc = emptyDoc();
  private readonly stack: Frame[] = [];
  private readonly colors: (RtfColor | undefined)[] = [];
  private readonly styles = new Map<number, StyleEntry>();
  private defaultFont = 0;

  /* body accumulation */
  private curText = "";
  private curKey: StyleKey | null = null;
  private curRuns: RtfRun[] = [];
  private curParaTextLen = 0;
  private pendingBreak = false;
  private pendingSkip = 0; // \ucN substitution chars to drop
  private starFlag = false;

  truncated = false;
  private paperwTw = DEFAULT_PAPERW_TW;
  private paperhTw = DEFAULT_PAPERH_TW;
  private margTw = {
    l: DEFAULT_MARGIN_TW,
    r: DEFAULT_MARGIN_TW,
    t: DEFAULT_MARGIN_TW,
    b: DEFAULT_MARGIN_TW,
  };

  constructor() {
    this.stack.push(this.newFrame());
  }

  private newFrame(): Frame {
    return {
      dest: "body",
      bold: false,
      italic: false,
      underline: false,
      fsHalf: DEFAULT_FS_HALF,
      font: this.defaultFont,
      cf: 0,
      uc: 1,
      align: "left",
      styleNum: 0,
      cbR: 0,
      cbG: 0,
      cbB: 0,
      ftNum: -1,
      ftName: "",
      stNum: -1,
      stFsHalf: 0,
      stBold: false,
      stItalic: false,
      stName: "",
    };
  }

  private frame(): Frame {
    return this.stack[this.stack.length - 1];
  }

  /* ---------------- body text accumulation ---------------- */

  private resolveColor(cf: number): RtfColor | undefined {
    if (cf <= 0) return undefined; // 0 = auto
    return this.colors[cf];
  }

  private appendText(s: string): void {
    const f = this.frame();
    if (s === "") return;
    const key: StyleKey = {
      bold: f.bold,
      italic: f.italic,
      underline: f.underline,
      sizePt: clampSizePt(f.fsHalf),
      color: this.resolveColor(f.cf),
    };
    const k = this.curKey;
    const same =
      k !== null &&
      k.bold === key.bold &&
      k.italic === key.italic &&
      k.underline === key.underline &&
      k.sizePt === key.sizePt &&
      sameColor(k.color, key.color);
    if (this.curText !== "" && same) {
      this.curText += s;
      if (this.curText.length > MAX_RUN_TEXT) {
        this.pushRun();
      }
      return;
    }
    this.pushRun();
    this.curKey = key;
    this.curText = s;
  }

  private pushRun(): void {
    if (this.curText === "" || this.curKey === null) return;
    if (this.curRuns.length >= MAX_RUNS_PER_PARA) {
      this.truncated = true;
      this.curText = "";
      return;
    }
    const text = hindiNorm(this.curText.slice(0, MAX_RUN_TEXT));
    this.curText = "";
    if (text === "") return;
    this.curParaTextLen += text.length;
    this.curRuns.push({
      text,
      bold: this.curKey.bold,
      italic: this.curKey.italic,
      underline: this.curKey.underline,
      sizePt: this.curKey.sizePt,
      color: this.curKey.color,
    });
  }

  private flushPara(force: boolean): void {
    this.pushRun();
    const runs = this.curRuns;
    this.curRuns = [];
    this.curParaTextLen = 0;
    // An empty paragraph keeps a pending \page for the next real content
    // (no blank line at the top of the fresh page).
    if (runs.length === 0 && this.pendingBreak) return;
    if (runs.length === 0 && !force) return;
    if (this.doc.paras.length >= MAX_PARAS) {
      this.truncated = true;
      return;
    }
    const para: RtfPara = {
      align: this.frame().align,
      runs,
    };
    if (this.pendingBreak) {
      para.pageBreakBefore = true;
      this.pendingBreak = false;
    }
    this.doc.paras.push(para);
  }

  /* ---------------- destination-table finals ---------------- */

  private finalizeFontEntry(f: Frame): void {
    if (f.ftNum < 0 || f.ftNum >= MAX_FONTS) return;
    const name = f.ftName.replace(/;.*$/, "").trim();
    if (name !== "") this.doc.fontNames[f.ftNum] = name;
    f.ftName = "";
  }

  private finalizeColorEntry(f: Frame): void {
    if (this.colors.length >= MAX_COLORS) return;
    this.colors.push({ r: f.cbR & 0xff, g: f.cbG & 0xff, b: f.cbB & 0xff });
  }

  private finalizeStyleEntry(f: Frame): void {
    if (f.stNum < 1 || f.stNum > MAX_STYLES) return;
    this.styles.set(f.stNum, {
      fsHalf: f.stFsHalf > 0 ? f.stFsHalf : undefined,
      bold: f.stBold || undefined,
      italic: f.stItalic || undefined,
    });
  }

  /* ---------------- token application ---------------- */

  private applyControl(w: string, p: number | undefined): void {
    const f = this.frame();

    // starred destination: {\*\word …} — skip the whole group whatever
    // the word is (unknown optional destinations included).
    if (w === "*") {
      this.starFlag = true;
      return;
    }
    if (this.starFlag) {
      this.starFlag = false;
      f.dest = "skip";
      return;
    }

    // document-level geometry (any group)
    if (p !== undefined) {
      switch (w) {
        case "paperw":
          if (p > 0) this.paperwTw = p;
          return;
        case "paperh":
          if (p > 0) this.paperhTw = p;
          return;
        case "margl":
          if (p >= 0) this.margTw.l = p;
          return;
        case "margr":
          if (p >= 0) this.margTw.r = p;
          return;
        case "margt":
          if (p >= 0) this.margTw.t = p;
          return;
        case "margb":
          if (p >= 0) this.margTw.b = p;
          return;
        default:
          break;
      }
    }

    switch (f.dest) {
      case "skip":
        return;
      case "fonttbl": {
        if (w === "f" && p !== undefined) {
          this.finalizeFontEntry(f);
          f.ftNum = p;
          return;
        }
        return; // \fswiss, \fcharset… — ignored
      }
      case "colortbl": {
        if (w === "red" && p !== undefined) f.cbR = p;
        else if (w === "green" && p !== undefined) f.cbG = p;
        else if (w === "blue" && p !== undefined) f.cbB = p;
        return;
      }
      case "stylesheet": {
        if (w === "s" && p !== undefined && p > 0) f.stNum = p;
        else if (w === "fs" && p !== undefined) f.stFsHalf = p;
        else if (w === "b" && (p === undefined || p !== 0)) f.stBold = true;
        else if (w === "i" && (p === undefined || p !== 0)) f.stItalic = true;
        return;
      }
      default:
        break;
    }

    /* ---- body destination ---- */
    switch (w) {
      case "fonttbl":
      case "colortbl":
      case "stylesheet":
        f.dest = w;
        return;
      default:
        break;
    }
    if (SKIP_DESTS.has(w)) {
      f.dest = "skip";
      return;
    }

    switch (w) {
      case "par":
      case "row": // table row end → flatten to a text line
      case "sect": // section end — honest paragraph break
        this.flushPara(true);
        return;
      case "line":
        this.appendText("\n");
        return;
      case "tab":
      case "cell": // cell boundary → tab-separated flattened row
        this.appendText("\t");
        return;
      case "page":
        if (this.curText !== "" || this.curRuns.length > 0) {
          this.flushPara(true);
        }
        this.pendingBreak = true;
        return;
      case "pard":
        f.align = "left";
        f.styleNum = 0;
        return;
      case "plain":
        f.bold = false;
        f.italic = false;
        f.underline = false;
        f.fsHalf = DEFAULT_FS_HALF;
        f.font = this.defaultFont;
        f.cf = 0;
        return;
      case "b":
        f.bold = p === undefined || p !== 0;
        return;
      case "i":
        f.italic = p === undefined || p !== 0;
        return;
      case "ulnone":
        f.underline = false;
        return;
      case "ul":
        f.underline = p === undefined || p !== 0;
        return;
      case "fs":
        if (p !== undefined && p >= 0) f.fsHalf = p;
        return;
      case "f":
        if (p !== undefined && p >= 0) f.font = p;
        return;
      case "cf":
        if (p !== undefined && p >= 0) f.cf = p;
        return;
      case "cb": // background colour — parsed, not carried
      case "highlight":
        return;
      case "ql":
        f.align = "left";
        return;
      case "qc":
        f.align = "center";
        return;
      case "qr":
        f.align = "right";
        return;
      case "qj":
      case "qd":
        f.align = "justify";
        return;
      case "deff":
        if (p !== undefined && p >= 0) this.defaultFont = p;
        return;
      case "uc":
        f.uc = p !== undefined ? Math.min(10, Math.max(0, p)) : 1;
        return;
      case "u": {
        if (p === undefined) return;
        const v = p < 0 ? p + 65536 : p;
        this.appendText(String.fromCharCode(v & 0xffff));
        this.pendingSkip = f.uc;
        return;
      }
      case "s": {
        if (p === undefined || p < 0) return;
        f.styleNum = p;
        const entry = this.styles.get(p);
        if (entry) {
          if (entry.fsHalf !== undefined) f.fsHalf = entry.fsHalf;
          if (entry.bold === true) f.bold = true;
          if (entry.italic === true) f.italic = true;
        } else {
          const approx = approxStyleFsHalf(p);
          if (approx !== undefined) {
            f.fsHalf = approx;
            f.bold = true;
          }
        }
        return;
      }
      default:
        return; // unknown control word — params ignored
    }
  }

  private applyText(s: string): void {
    const f = this.frame();
    switch (f.dest) {
      case "skip":
        return;
      case "fonttbl": {
        for (const ch of s) {
          if (ch === ";") {
            this.finalizeFontEntry(f);
            f.ftName = "";
          } else {
            f.ftName += ch;
          }
        }
        return;
      }
      case "colortbl": {
        for (const ch of s) {
          if (ch === ";") this.finalizeColorEntry(f);
        }
        return;
      }
      case "stylesheet": {
        for (const ch of s) {
          if (ch === ";") {
            this.finalizeStyleEntry(f);
            f.stName = "";
          } else {
            f.stName += ch;
          }
        }
        return;
      }
      default:
        break;
    }
    if (this.curParaTextLen >= MAX_PARA_TEXT) {
      this.truncated = true;
      return;
    }
    this.appendText(s);
  }

  private applyHex(b: number): void {
    const f = this.frame();
    if (f.dest === "fonttbl") {
      f.ftName += winAnsiChar(b);
      return;
    }
    if (f.dest !== "body") return;
    if (this.pendingSkip > 0) {
      this.pendingSkip -= 1; // a \'hh substitution char after \uN
      return;
    }
    if (this.curParaTextLen >= MAX_PARA_TEXT) {
      this.truncated = true;
      return;
    }
    this.appendText(winAnsiChar(b));
  }

  /** main loop — returns false when parsing must stop (hard cap hit). */
  push(tok: RtfToken): boolean {
    // \ucN substitution chars are consumed from TEXT tokens only; any
    // structural token cancels the remainder.
    if (tok.t === "s") {
      if (this.pendingSkip > 0) {
        const take = Math.min(this.pendingSkip, tok.s.length);
        if (take >= tok.s.length) {
          this.pendingSkip -= take;
          return true;
        }
        this.pendingSkip = 0;
        this.applyText(tok.s.slice(take));
        return true;
      }
      this.applyText(tok.s);
      return true;
    }
    this.pendingSkip = 0;

    if (tok.t === "c") {
      this.applyControl(tok.w, tok.p);
      return true;
    }
    if (tok.t === "x") {
      this.applyHex(tok.b);
      return true;
    }
    if (tok.t === "{") {
      const parent = this.frame();
      const f = this.newFrame();
      f.dest = parent.dest;
      // inherit char/para state (RTF group semantics)
      f.bold = parent.bold;
      f.italic = parent.italic;
      f.underline = parent.underline;
      f.fsHalf = parent.fsHalf;
      f.font = parent.font;
      f.cf = parent.cf;
      f.uc = parent.uc;
      f.align = parent.align;
      f.styleNum = parent.styleNum;
      this.stack.push(f);
      if (this.stack.length > MAX_GROUP_DEPTH) {
        this.truncated = true;
        return false;
      }
      return true;
    }
    /* tok.t === "}" */
    const f = this.stack.pop();
    if (this.stack.length === 0) this.stack.push(this.newFrame());
    if (!f) return true;
    switch (f.dest) {
      case "fonttbl":
        this.finalizeFontEntry(f);
        break;
      case "stylesheet":
        this.finalizeStyleEntry(f);
        break;
      default:
        break;
    }
    return true;
  }

  finish(): RtfDoc {
    // flush any trailing paragraph the file didn't \par-terminate
    if (this.curText !== "" || this.curRuns.length > 0) {
      this.flushPara(true);
    }
    const doc = this.doc;
    doc.pageW = this.paperwTw / TWIPS_PER_PT;
    doc.pageH = this.paperhTw / TWIPS_PER_PT;
    doc.margins = {
      left: this.margTw.l / TWIPS_PER_PT,
      right: this.margTw.r / TWIPS_PER_PT,
      top: this.margTw.t / TWIPS_PER_PT,
      bottom: this.margTw.b / TWIPS_PER_PT,
    };
    doc.truncated = doc.truncated || this.truncated;
    return doc;
  }
}

/**
 * Parses raw RTF bytes into the IR. Returns null when the file does not
 * carry the {\rtf magic (the caller decides how to reject it). Never
 * throws — malformed input degrades with the `truncated` flag.
 */
export function parseRtf(bytes: Uint8Array): RtfDoc | null {
  const off = rtfMagicOk(bytes);
  if (off === null) return null;
  const sliced = off > 0 ? bytes.slice(off) : bytes;
  const { tokens, truncated } = tokenizeRtf(sliced);
  const asm = new RtfAssembler();
  asm.truncated = asm.truncated || truncated;
  for (const tok of tokens) {
    if (!asm.push(tok)) break;
  }
  return asm.finish();
}

/* ------------------------------------------------------------------ */
/* stats / estimatePages                                                */
/* ------------------------------------------------------------------ */

export interface RtfStats {
  paraCount: number;
  wordCount: number;
  charCount: number;
  truncated: boolean;
}

/** Honest stats derived from the paras alone (summary + worker agree). */
export function stats(doc: RtfDoc): RtfStats {
  let words = 0;
  let chars = 0;
  for (const para of doc.paras) {
    for (const run of para.runs) {
      chars += run.text.length;
      words += run.text.split(/\s+/).filter(Boolean).length;
    }
  }
  return {
    paraCount: doc.paras.length,
    wordCount: words,
    charCount: chars,
    truncated: doc.truncated,
  };
}

/**
 * Rough page estimate for the summary badge: average glyph width ≈ half
 * the font size, leading ≈ 1.35×, forced breaks align to page bounds.
 */
export function estimatePages(doc: RtfDoc): number {
  const contentW = Math.max(72, doc.pageW - doc.margins.left - doc.margins.right);
  const contentH = Math.max(72, doc.pageH - doc.margins.top - doc.margins.bottom);
  let totalH = 0;
  for (const para of doc.paras) {
    if (para.pageBreakBefore) {
      // align to the START of the next page BEFORE this para's height
      const pages = Math.max(1, Math.ceil(totalH / contentH));
      totalH = pages * contentH;
    }
    let len = 0;
    let maxSize = 12;
    for (const run of para.runs) {
      len += run.text.length;
      if (run.sizePt > maxSize) maxSize = run.sizePt;
    }
    const charsPerLine = Math.max(8, Math.floor(contentW / (maxSize * 0.5)));
    const lines = len === 0 ? 1 : Math.ceil(len / charsPerLine);
    totalH += lines * maxSize * 1.35;
  }
  return Math.max(1, Math.ceil(totalH / contentH));
}

/* ------------------------------------------------------------------ */
/* Output file name (house pdf-to-txt convention + localized fallback)  */
/* ------------------------------------------------------------------ */

/**
 * "Report v2.rtf" → "Report v2"; a nameless file falls back to the
 * localized word ("Document" / "दस्तावेज़"). Unicode survives; path
 * separators and unsafe chars do not.
 */
export function outputBaseName(
  fileName: string,
  lang: "en" | "hi"
): string {
  const base = fileName
    .replace(/\.(rtf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  const fallback = lang === "hi" ? "दस्तावेज़" : "Document";
  return base !== "" ? base : fallback;
}

/* ------------------------------------------------------------------ */
/* Sample document (the smoke fixture + a real multi-paragraph demo)   */
/* ------------------------------------------------------------------ */

/**
 * A REAL hand-written RTF: fonttbl + colortbl + stylesheet headers,
 * \fs32\b heading, tabs, \qc/\qr/\qj alignment, WinAnsi \'hh escapes,
 * \uNNNN? Hindi, a coloured run and a forced \page — everything the
 * smoke asserts against.
 */
export function buildSampleRtf(): string {
  // "नमस्ते" = न(2344) म(2350) स(2360) ्(2381) त(2340) े(2375)
  const namaste =
    "\\u2344?\\u2350?\\u2360?\\u2381?\\u2340?\\u2375?";
  // "दस्तावेज़" = द(2342) स(2360) ्(2381) त(2340) ा(2366) व(2357) े(2375) ज़(2332 2364)
  const dastavez =
    "\\u2342?\\u2360?\\u2381?\\u2340?\\u2366?\\u2357?\\u2375?\\u2332?\\u2364?";
  return [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033",
    "{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\froman Times New Roman;}{\\f2\\fnil Noto Sans Devanagari;}}",
    "{\\colortbl;\\red0\\green0\\blue0;\\red178\\green34\\blue52;\\red96\\green96\\blue96;}",
    "{\\stylesheet{\\s1\\fs32\\b Heading 1;}{\\s2\\fs24 Normal;}}",
    "\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440",
    "\\pard\\qc\\fs32\\b Quarterly Report\\b0\\fs20\\par",
    "\\pard\\ql\\fs20 Prepared by\\tab Ananya Verma\\tab\\tab Board Meeting\\par",
    "\\pard\\qr\\fs20\\b Confidential\\b0\\par",
    "\\pard\\qj\\fs20 This paragraph is justified in the source; it renders left honestly. \\'93Quotes\\'94 and caf\\'e9 test WinAnsi escapes.\\par",
    `\\pard\\ql\\fs20 Hindi greeting: ${namaste} ${dastavez}\\par`,
    "\\pard\\ql\\fs20 Coloured text in \\cf2 crimson\\cf0  and back to ink.\\par",
    "\\pard\\ql\\fs20 Underlined phrase\\ul  stays underlined\\ulnone  then not.\\par",
    "\\pard\\qc\\fs24\\b\\u2361?\\u2367?\\b0\\fs20\\par",
    "\\pard\\ql\\fs20 Plain body paragraph with enough words to wrap across a couple of lines when rendered at twelve point on a US Letter page.\\par",
    "\\pard\\ql\\fs20 Before the break\\page\\par",
    "\\pard\\ql\\fs20 After the forced page break\\par",
    "}",
  ].join("\n");
}
