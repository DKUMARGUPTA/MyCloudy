/**
 * SHARED text→PDF layout library — lives in tools/txt-to-pdf/ and is imported
 * by tools/markdown-to-pdf/ (file ownership keeps it here; the header comment
 * in the markdown engine points back to this file).
 *
 * Everything here is PURE: geometry constants, the script/font classification
 * (Helvetica ⇄ the embedded Noto Sans Devanagari), the word-wrap tokenizer
 * (space + danda aware, Devanagari cluster-safe hard-split) and the page-flow
 * cursor with orphan/widow protection. Callers inject a `MeasureRun`
 * (pdf-lib fonts in the worker, pdf-lib fonts in bun smokes) so the same
 * layout math is verifiable headlessly (P3.3 lesson: prove the engine).
 *
 * Font strategy (v1, documented): the script decision is made per BLOCK
 * (paragraph / heading / list item / code line). Any character the 14
 * standard fonts cannot encode (WinAnsi) upgrades the WHOLE block to the
 * embedded Noto font — Noto Sans Devanagari ships Latin glyphs too, so a
 * mixed Hindi/English paragraph renders consistently instead of mixing two
 * typefaces mid-line. See `blockScript`.
 */

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export type PageSizeId = "a4" | "letter";

export const PAGE_SIZES: Record<PageSizeId, { width: number; height: number }> =
  {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
  };

/** Millimetres → PDF points (1 pt = 1/72 in, 1 in = 25.4 mm). */
export const MM_TO_PT = 72 / 25.4;

/**
 * Where the baseline sits inside a glyph box, as a fraction of the font
 * size. Helvetica's ascender is ~0.905 em, but with accents/devanagari
 * shirorekha a practical 0.8 centers text visually in the line box. One
 * constant for every font keeps mixed-font lines aligned.
 */
export const BASELINE_RATIO = 0.8;

/** Tolerance for floating-point page-cap comparisons (pt). */
const EPS = 1e-6;

export interface PageGeometry {
  pageW: number;
  pageH: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
}

/* ------------------------------------------------------------------ */
/* Fonts & script classification                                       */
/* ------------------------------------------------------------------ */

/**
 * "std"  → the 14 built-in PDF fonts (Helvetica/Courier families here).
 * "noto" → the self-hosted embedded Noto Sans Devanagari (subset:true),
 *          fetched same-origin from /fonts (the stamp-common pipeline).
 */
export type ScriptFont = "std" | "noto";

/** One renderable style of text. */
export interface FontSpec {
  /** sans = Helvetica / Noto, serif = Times, mono = Courier (code). */
  family: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
}

/**
 * Width of `text` in PDF points at `size`, for the given style/script —
 * backed by real pdf-lib fonts on the caller's side.
 */
export type MeasureRun = (
  text: string,
  spec: FontSpec,
  size: number,
  script: ScriptFont
) => number;

/**
 * The non-Latin-1 characters WinAnsi (pdf-lib's standard-font encoding)
 * CAN encode. Verified against pdf-lib@1.17.1's WinAnsi table; Noto covers
 * all of these EXCEPT ƒ † ‡ ‰ (0x192, 0x2020, 0x2021, 0x2030) — a block
 * mixing Devanagari with one of those four renders the rare symbol as
 * .notdef (known v1 limitation, documented).
 */
const WINANSI_SPECIALS = new Set<number>([
  0x0152, 0x0153, // Œ œ
  0x0160, 0x0161, // Š š
  0x0178, // Ÿ
  0x017d, 0x017e, // Ž ž
  0x0192, // ƒ (WinAnsi only)
  0x02c6, 0x02dc, // ˆ ˜
  0x2013, 0x2014, // – —
  0x2018, 0x2019, 0x201a, // ‘ ’ ‚
  0x201c, 0x201d, 0x201e, // “ ” „
  0x2020, 0x2021, // † ‡ (WinAnsi only)
  0x2022, // •
  0x2026, // …
  0x2030, // ‰ (WinAnsi only)
  0x2039, 0x203a, // ‹ ›
  0x20ac, // €
  0x2122, // ™
]);

/**
 * Characters verified PRESENT in the self-hosted NotoSansDevanagari
 * Regular TTF but absent from WinAnsi: Ā ā Ē ē (Hindi transliteration),
 * ₹ (rupee) and the zero-width joiners Devanagari needs.
 */
const NOTO_ONLY_EXTRAS = new Set<number>([
  0x0100, 0x0101, // Ā ā
  0x0112, 0x0113, // Ē ē
  0x200b, 0x200c, 0x200d, // ZWSP ZWNJ ZWJ
  0x20b9, // ₹
]);

/** True for the Devanagari block proper (incl. danda । ॥ and ०-९). */
export function isDevanagariChar(cp: number): boolean {
  return cp >= 0x0900 && cp <= 0x097f;
}

/** True when pdf-lib's standard fonts (WinAnsi) can encode the character. */
export function isWinAnsiChar(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true; // printable ASCII
  if (cp >= 0xa0 && cp <= 0xff) return true; // Latin-1 supplement
  return WINANSI_SPECIALS.has(cp);
}

/**
 * True when our fonts can render the character at all. Whitespace and the
 * control chars the engines normalize away (\t \n \r) pass so they are
 * never reported as "unsupported script".
 */
export function isRenderableCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return true;
  if (isWinAnsiChar(cp)) return true;
  if (isDevanagariChar(cp)) return true;
  return NOTO_ONLY_EXTRAS.has(cp);
}

/** First codepoint neither font can render, or null when all are safe. */
export function findUnsupportedCodePoint(text: string): number | null {
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      // astral pair — outside every whitelist by construction
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) return cp;
    }
    if (!isRenderableCodePoint(cp)) return cp;
  }
  return null;
}

/**
 * Script decision for ONE block of text: any non-WinAnsi character upgrades
 * the whole block to the embedded Noto font (which also carries Latin).
 * Whitespace never forces the upgrade.
 */
export function blockScript(text: string): ScriptFont {
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.charCodeAt(i);
    if (cp <= 0x20) continue;
    if (!isWinAnsiChar(cp)) return "noto";
  }
  return "std";
}

/* ------------------------------------------------------------------ */
/* Word wrapping (space + danda aware, cluster-safe hard split)         */
/* ------------------------------------------------------------------ */

/** A styled fragment of text to wrap (markdown emits many per paragraph). */
export interface WrapRun {
  text: string;
  spec: FontSpec;
  color?: string;
  /** Superscript-ish (link markers): 72% size, raised baseline. */
  sup?: boolean;
  /** Word-processor underline (write-pdf rides this through the wrapper). */
  underline?: boolean;
}

export interface WrapOptions {
  maxWidth: number;
  size: number;
  script: ScriptFont;
  measure: MeasureRun;
}

interface Token {
  text: string;
  run: WrapRun;
  space: boolean;
}

/**
 * Danda (। ॥) is a full-stop-like boundary in Devanagari prose that often
 * appears WITHOUT a following space — a wrap opportunity must be offered
 * right after it.
 */
function isDanda(cp: number): boolean {
  return cp === 0x0964 || cp === 0x0965;
}

/** Combining marks that must never start a line after a hard split. */
function isCombiningForCut(cp: number): boolean {
  return (
    (cp >= 0x0900 && cp <= 0x0903) || // signs + anusvara/candrabindu
    (cp >= 0x093a && cp <= 0x094f) || // matras
    (cp >= 0x0951 && cp <= 0x0957) || // stress marks
    (cp >= 0x0962 && cp <= 0x0963) // extra marks
  );
}

function isZeroWidth(cp: number): boolean {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d;
}

function tokenizeRun(run: WrapRun): Token[] {
  const tokens: Token[] = [];
  let word = "";
  const pushWord = (): void => {
    if (word.length > 0) {
      tokens.push({ text: word, run, space: false });
      word = "";
    }
  };
  for (let i = 0; i < run.text.length; i += 1) {
    const ch = run.text[i];
    const cp = run.text.charCodeAt(i);
    if (ch === " ") {
      pushWord();
      // consecutive spaces stay one token (width measured verbatim)
      let spaces = " ";
      while (run.text[i + 1] === " ") {
        i += 1;
        spaces += " ";
      }
      tokens.push({ text: spaces, run, space: true });
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      // soft break / tab inside a run → ONE space (hard breaks were already
      // extracted as standalone "\n" runs by splitRunsAtBreaks; dropping
      // these silently would glue words together — "foo\nbar" → "foobar")
      pushWord();
      const lastToken = tokens[tokens.length - 1];
      if (!lastToken || !lastToken.space) {
        tokens.push({ text: " ", run, space: true });
      }
      continue;
    }
    word += ch;
    if (isDanda(cp)) pushWord(); // break opportunity right after danda
  }
  pushWord();
  return tokens;
}

/** Splits a run list into hard-break separated groups (markdown breaks). */
export function splitRunsAtBreaks(runs: WrapRun[]): WrapRun[][] {
  const groups: WrapRun[][] = [[]];
  for (const run of runs) {
    if (run.text === "\n") {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(run);
  }
  return groups.filter(
    (group, index) => group.length > 0 || index === groups.length - 1
  );
}

/** Merges adjacent tokens with identical render props into fewer runs. */
function mergeLineRuns(tokens: Token[]): WrapRun[] {
  const runs: WrapRun[] = [];
  for (const token of tokens) {
    const last = runs[runs.length - 1];
    if (
      last &&
      last.spec.family === token.run.spec.family &&
      last.spec.bold === token.run.spec.bold &&
      last.spec.italic === token.run.spec.italic &&
      last.color === token.run.color &&
      last.sup === token.run.sup &&
      last.underline === token.run.underline
    ) {
      last.text += token.text;
    } else {
      runs.push({ ...token.run, text: token.text });
    }
  }
  return runs;
}

/**
 * Hard-splits a single overlong word at `maxWidth`. Cut points never leave a
 * Devanagari combining mark at the start of the next line and never cut
 * right after ZWJ/ZWNJ (cluster integrity). Returns [chunks..., remainder].
 */
function hardSplitWord(
  text: string,
  run: WrapRun,
  options: WrapOptions
): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 1) {
    const width = options.measure(
      rest,
      run.spec,
      run.sup ? options.size * 0.72 : options.size,
      options.script
    );
    if (width <= options.maxWidth) break;
    // binary search the largest fitting prefix
    let lo = 1;
    let hi = rest.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const w = options.measure(
        rest.slice(0, mid),
        run.spec,
        run.sup ? options.size * 0.72 : options.size,
        options.script
      );
      if (w <= options.maxWidth) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    while (
      cut > 1 &&
      (isCombiningForCut(rest.charCodeAt(cut)) ||
        isZeroWidth(rest.charCodeAt(cut - 1)) ||
        isZeroWidth(rest.charCodeAt(cut)))
    ) {
      cut -= 1;
    }
    if (cut < 1) cut = 1; // degenerate single-char fallback
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/**
 * Greedy word wrapper over styled runs. Spaces at wrap points vanish; the
 * first line never starts with a space token. Danda-attached words wrap
 * after the danda; overlong words hard-split (cluster-safe).
 */
export function wrapRuns(
  runs: WrapRun[],
  options: WrapOptions
): WrapRun[][] {
  const tokens: Token[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    tokens.push(...tokenizeRun(run));
  }
  if (tokens.length === 0) return [[]];

  const lines: Token[][] = [];
  let current: Token[] = [];
  let curWidth = 0;
  let pending: Token[] = [];
  let pendingWidth = 0;

  const flushLine = (): void => {
    lines.push(current);
    current = [];
    curWidth = 0;
    pending = [];
    pendingWidth = 0;
  };

  for (const token of tokens) {
    if (token.space) {
      if (current.length === 0) continue; // never lead a line with spaces
      pending.push(token);
      pendingWidth += options.measure(
        token.text,
        token.run.spec,
        token.run.sup ? options.size * 0.72 : options.size,
        options.script
      );
      continue;
    }
    const w = options.measure(
      token.text,
      token.run.spec,
      token.run.sup ? options.size * 0.72 : options.size,
      options.script
    );
    if (current.length === 0) {
      // first word of a line — hard-split when it alone overflows
      if (w > options.maxWidth && token.text.length > 1) {
        const chunks = hardSplitWord(token.text, token.run, options);
        for (const chunk of chunks) {
          if (current.length > 0) flushLine();
          current.push({ text: chunk, run: token.run, space: false });
          curWidth = options.measure(
            chunk,
            token.run.spec,
            token.run.sup ? options.size * 0.72 : options.size,
            options.script
          );
        }
      } else {
        current.push(token);
        curWidth = w;
      }
      continue;
    }
    if (curWidth + pendingWidth + w <= options.maxWidth) {
      current.push(...pending);
      curWidth += pendingWidth;
      pending = [];
      pendingWidth = 0;
      current.push(token);
      curWidth += w;
    } else {
      flushLine();
      current.push(token);
      curWidth = w;
    }
  }
  if (current.length > 0) flushLine();
  return lines.map(mergeLineRuns);
}

/* ------------------------------------------------------------------ */
/* Page flow (cursor + orphan/widow-aware line planner)                */
/* ------------------------------------------------------------------ */

/**
 * Vertical cursor over one document's pages. `used` is the pt consumed from
 * the content-area top of the CURRENT page; baselines are returned in
 * pdf-lib coordinates (y up from the page bottom).
 */
export class PageFlow {
  readonly contentWidth: number;
  readonly contentHeight: number;
  private readonly geo: PageGeometry;
  private page = 0;
  private used = 0;
  private hasContent = false;

  constructor(geometry: PageGeometry) {
    this.geo = geometry;
    this.contentWidth =
      geometry.pageW - geometry.marginLeft - geometry.marginRight;
    this.contentHeight =
      geometry.pageH - geometry.marginTop - geometry.marginBottom;
  }

  get pageIndex(): number {
    return this.page;
  }

  get pageCount(): number {
    return this.page + 1;
  }

  get spaceLeft(): number {
    return this.contentHeight - this.used;
  }

  get pageHasContent(): boolean {
    return this.hasContent;
  }

  /** Pt consumed on the current page from its content-area top. */
  get usedHeight(): number {
    return this.used;
  }

  breakPage(): void {
    this.page += 1;
    this.used = 0;
    this.hasContent = false;
  }

  fits(height: number): boolean {
    return this.used + height <= this.contentHeight + EPS;
  }

  /** Consumes vertical space for placed content (never call for gaps). */
  consume(height: number): void {
    this.used += height;
    if (height > 0) this.hasContent = true;
  }

  /** Gaps vanish at the very top of a page (standard typography). */
  consumeGap(height: number): void {
    if (!this.hasContent) return;
    this.used += height;
  }

  /** Pdf baseline for a line whose top sits at the CURRENT cursor. */
  lineBaseline(advance: number, fontSize: number): number {
    const glyphTop = this.used + Math.max(0, advance - fontSize) / 2;
    return (
      this.geo.pageH -
      this.geo.marginTop -
      glyphTop -
      fontSize * BASELINE_RATIO
    );
  }

  /** Pdf y (top edge, y-up) of the content currently at the cursor. */
  contentTopY(): number {
    return this.geo.pageH - this.geo.marginTop - this.used;
  }
}

export interface LinePlacement {
  pageIndex: number;
  /** Line top, measured from the page's content-area top (pt). */
  top: number;
  /** Pdf baseline (y-up from page bottom). */
  baseline: number;
}

/**
 * Plans the page placement of `count` uniform-advance lines with
 * orphan/widow protection:
 *
 * - R1 (avoidable orphan): when only ONE line fits and ≥2 remain, the whole
 *   remaining group moves to the next page — but only when it fits there
 *   (`strictSingle` forces the move regardless, for code blocks).
 * - R2 (widow): when a page break would strand exactly the group's LAST
 *   line alone at the next page top, one more line travels with it so the
 *   next page starts with ≥2 group lines.
 * - A fresh page always receives at least one line (loop safety).
 *
 * `bottomPad` reserves extra vertical space at the END of every fragment
 * (code blocks reserve their background padding so rects stay inside the
 * content area).
 */
export function planLineGroup(
  flow: PageFlow,
  count: number,
  advance: number,
  fontSize: number,
  strictSingle = false,
  bottomPad = 0
): LinePlacement[] {
  const out: LinePlacement[] = [];
  let i = 0;
  while (i < count) {
    const remaining = count - i;
    const cap = Math.floor((flow.spaceLeft - bottomPad + EPS) / advance);
    if (cap === 0) {
      if (!flow.pageHasContent && flow.usedHeight === 0) {
        // degenerate: even a FRESH page (any index, not just the first —
        // otherwise this loop would break pages forever) cannot hold one
        // line — place it anyway so layout always terminates
        out.push({
          pageIndex: flow.pageIndex,
          top: flow.usedHeight,
          baseline: flow.lineBaseline(advance, fontSize),
        });
        flow.consume(advance);
        i += 1;
        continue;
      }
      flow.breakPage();
      continue;
    }
    let take = Math.min(cap, remaining);
    if (take < remaining && remaining - cap === 1 && take >= 2) {
      take -= 1; // widow pull: ≥2 lines travel to the next page
    }
    if (take === 1 && remaining >= 2 && flow.pageHasContent) {
      const fitsFresh = remaining * advance <= flow.contentHeight + EPS;
      if (strictSingle || fitsFresh) {
        flow.breakPage();
        continue;
      }
      // unavoidable (group taller than a page) — place the single line
    }
    for (let j = 0; j < take; j += 1) {
      const top = flow.usedHeight;
      out.push({
        pageIndex: flow.pageIndex,
        top,
        baseline: flow.lineBaseline(advance, fontSize),
      });
      flow.consume(advance);
      i += 1;
    }
    if (i < count) flow.breakPage();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Run positioning                                                     */
/* ------------------------------------------------------------------ */

export interface PositionedTextRun {
  text: string;
  x: number;
  baseline: number;
  size: number;
  spec: FontSpec;
  script: ScriptFont;
  color?: string;
  sup?: boolean;
}

/** Positions one wrapped line's runs on a shared baseline. */
export function positionRuns(
  lineRuns: WrapRun[],
  startX: number,
  baseline: number,
  size: number,
  script: ScriptFont,
  measure: MeasureRun
): PositionedTextRun[] {
  const out: PositionedTextRun[] = [];
  let x = startX;
  for (const run of lineRuns) {
    if (run.text.length === 0) continue;
    const runSize = run.sup ? size * 0.72 : size;
    out.push({
      text: run.text,
      x,
      baseline: run.sup ? baseline + size * 0.3 : baseline,
      size: runSize,
      spec: run.spec,
      script,
      color: run.color,
      sup: run.sup,
    });
    x += measure(run.text, run.spec, runSize, script);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Output naming                                                       */
/* ------------------------------------------------------------------ */

/**
 * Text-tool output base name: strips the LAST extension (any kind), drops
 * path-unsafe characters, caps at 120 chars, falls back to "document".
 */
export function outputBaseName(name: string): string {
  const noExt = name.replace(/\.[^.]{1,12}$/, "");
  const cleaned = noExt
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}
