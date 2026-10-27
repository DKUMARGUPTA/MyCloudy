/**
 * RTF parser (Task b4-d) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * Rich Text Format is PLAINTEXT markup — no zip, no XML. A document is a
 * stream of control words (\b, \i, \par, \fs32, \uNNNN), groups ({ ... })
 * and raw text. This module walks that stream with an explicit stack and
 * produces render blocks:
 *
 *   blocks: {type:"para", runs:[{text, bold, italic, size}]}  the body text
 *           {type:"spacer"}                                    empty paragraph
 *           {type:"pagebreak"}                                 explicit \page
 *
 * Handled (the word-processor subset that can be rendered honestly):
 *   - Groups with a state stack (bold/italic/font-size/uc are group-scoped
 *     per the RTF spec — a closing brace restores the outer state).
 *   - Destinations skipped WITH their whole group: \fonttbl, \colortbl,
 *     \stylesheet, \info, \pict, \object, header/footer family, \footnote,
 *     \listtable, \listoverridetable, \rsidtbl, \xmlnstbl, \filetbl,
 *     \themedata, \datastore, \latentstyles, \colorschememapping,
 *     \generator — plus \*\anything (the ignore-destination marker starts
 *     the same skip for the NEXT control word, whatever it is).
 *   - \b/\b0, \i/\i0, \fsN (half-points → pt), \pard (paragraph reset),
 *     \plain (character reset), \sN (style number — IGNORED in v1, stated
 *     in the tool FAQ), \tab (4 spaces), \line (hard "\n"), \par.
 *   - Text: ASCII literally; \'hh (CP1252 byte → Unicode, full 0x80–0xFF
 *     table: smart quotes, dashes, é, € …); \uNNNN with its fallback char
 *     skipped (\ucN, default 1) — NNNN may be NEGATIVE (16-bit signed,
 *     surrogate halves arrive that way) and is converted properly;
 *     escapes \{ \} \\ and other backslash symbols (\~ nbsp, \_ hyphen,
 *     \- optional hyphen dropped).
 *   - \binN: N raw bytes skipped (embedded binary blobs must never leak
 *     into the text).
 *
 * Tag-soup tolerance (never throws on structure): unbalanced braces
 * auto-close at EOF, stray '}' at depth 0 is ignored, unknown control
 * words are skipped together with their numeric parameter, missing hex
 * digits degrade to a literal '?'. Structural problems (no {\rtf header,
 * NUL bytes, a high control-character ratio) throw RtfParseError, which
 * the worker maps to the honest tool.errorCorrupt.
 *
 * V1 honesty (stated in the tool FAQ): RTF has NO heading markup, so no
 * headings are synthesized — paragraphs only, in the sizes the file itself
 * carries. Tables keep their cell text (rendered as paragraphs) but their
 * grid, colors and fonts are not rebuilt; images/headers/footers/
 * footnotes/styles are skipped.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone.
 */

/* ------------------------------------------------------------------ */
/* CP1252 (\'hh and raw high bytes) → Unicode                          */
/* ------------------------------------------------------------------ */

/**
 * Windows-1252 bytes 0x80–0xFF as Unicode strings. The five undefined
 * positions (0x81 0x8D 0x8F 0x90 0x9D) are dropped — they are never valid
 * CP1252 text (binary junk or an encoding mistake), and mapping them to
 * U+FFFD would trip the renderable-script guard for one stray byte.
 */
const CP1252_HIGH: string[] = (() => {
  const table: string[] = new Array(128);
  const named = [
    "\u20ac", "", "\u201a", "\u0192", "\u201e", "\u2026", "\u2020", "\u2021", // 80-87
    "\u02c6", "\u2030", "\u0160", "\u2039", "\u0152", "", "\u017d", "", // 88-8F
    "", "\u2018", "\u2019", "\u201c", "\u201d", "\u2022", "\u2013", "\u2014", // 90-97
    "\u02dc", "\u2122", "\u0161", "\u203a", "\u0153", "", "\u017e", "\u0178", // 98-9F
  ];
  for (let i = 0; i < 32; i += 1) table[i] = named[i] ?? "";
  for (let i = 0xa0; i <= 0xff; i += 1) {
    // 0xA0–0xFF are identical to Latin-1 (é è ü …, incl. NBSP at 0xA0)
    table[i - 0x80] = String.fromCharCode(i);
  }
  return table;
})();

/** A CP1252 byte (0x80–0xFF) as its Unicode string ("" for undefined). */
export function cp1252Char(byte: number): string {
  return CP1252_HIGH[byte - 0x80] ?? "";
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One styled fragment of paragraph text. `size` is pt (half-points/2),
 *  or null when the file never set \fs in scope (render body size). */
export interface RtfRun {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number | null;
}

/** A renderable block of the document (paragraphs only — no faked
 *  headings; see the module doc for the v1 honesty). */
export type RtfBlock =
  | { type: "para"; runs: RtfRun[]; fontSize: number | null }
  | { type: "spacer" }
  | { type: "pagebreak" };

export interface ParsedRtf {
  blocks: RtfBlock[];
  /** Non-whitespace characters across all paragraphs (the empty guard). */
  charCount: number;
}

/** Why the bytes could not be read as RTF at all. */
export type RtfParseFailure = "not-rtf" | "binary";

export class RtfParseError extends Error {
  readonly failure: RtfParseFailure;

  constructor(failure: RtfParseFailure) {
    super(failure);
    this.name = "RtfParseError";
    this.failure = failure;
  }
}

/* ------------------------------------------------------------------ */
/* Destination groups whose whole content is skipped                    */
/* ------------------------------------------------------------------ */

/**
 * Destinations that never carry body text. \fonttbl/\colortbl/\stylesheet/
 * \info are the classic four; \pict/\object embed binary/hex blobs whose
 * LEAK would corrupt the text stream; the header/footer family is page
 * furniture (v1 renders body only); \footnote text lives at page bottoms
 * in real renderers, so skipping it is the honest v1; the rest are
 * metadata tables writers emit. \*\anything is handled separately.
 */
const SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "nonshppict",
  "object",
  "objdata",
  "objclass",
  "objname",
  "header",
  "headerl",
  "headerf",
  "headerr",
  "footer",
  "footerl",
  "footerf",
  "footerr",
  "footnote",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "rsidtable",
  "xmlnstbl",
  "filetbl",
  "themedata",
  "datastore",
  "latentstyles",
  "colorschememapping",
  "generator",
  "company",
  "title",
  "author",
  "subject",
  "keywords",
  "operator",
  "keyword",
]);

/* ------------------------------------------------------------------ */
/* The binary / header sniff (pure, bytes)                              */
/* ------------------------------------------------------------------ */

/**
 * Rejects binary blobs disguised as .rtf: a NUL byte anywhere, or a high
 * ratio of control characters (excluding the source-formatting \t \r \n).
 * A missing "{\rtf" header is "not-rtf" (an optional UTF-8 BOM tolerated).
 */
export function sniffRtfBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new RtfParseError("not-rtf");
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const header = "{\\rtf";
  for (let h = 0; h < header.length; h += 1) {
    if (bytes[start + h] !== header.charCodeAt(h)) {
      throw new RtfParseError("not-rtf");
    }
  }
  let controls = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0) throw new RtfParseError("binary"); // NUL — never text
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) controls += 1;
    else if (b === 0x7f) controls += 1;
  }
  if (controls >= 4 && controls * 100 > bytes.length) {
    throw new RtfParseError("binary");
  }
}

/* ------------------------------------------------------------------ */
/* The tokenizer / group walker                                        */
/* ------------------------------------------------------------------ */

interface RtfState {
  bold: boolean;
  italic: boolean;
  /** Font size in pt (half-points/2); null = no \fs seen (body default). */
  fontSize: number | null;
  /** Fallback chars to skip after \uNNNN (\ucN, default 1). */
  uc: number;
}

const LETTER_RE = /[a-zA-Z]/;
const DIGIT_RE = /[0-9]/;
const HEX_RE = /[0-9a-fA-F]/;

function isDanda(cp: number): boolean {
  return cp === 0x0964 || cp === 0x0965;
}

/** Joined run text of a paragraph (script decisions, empty checks). */
export function rtfBlockText(block: RtfBlock): string {
  if (block.type !== "para") return "";
  return block.runs.map((r) => r.text).join("");
}

/**
 * Parses the RTF source (latin1-decoded bytes, so charCodes ARE bytes).
 * Structural damage never throws here — sniffRtfBytes gates the file.
 */
export function parseRtfText(source: string): ParsedRtf {
  const blocks: RtfBlock[] = [];
  const stack: RtfState[] = [];
  let state: RtfState = { bold: false, italic: false, fontSize: null, uc: 1 };

  // Skip machinery: skipFrom !== null while inside a destination group.
  // The group was current when the destination word arrived
  // (stack.length === skipFrom); it closes when a '}' brings stack.length
  // back to skipFrom - 1.
  let skipFrom: number | null = null;
  // Set by \* — the NEXT control word starts a group skip (ignore
  // destination), whatever it is.
  let pendingIgnore = false;

  let runs: RtfRun[] = [];
  let run: RtfRun = { text: "", bold: state.bold, italic: state.italic, size: state.fontSize };
  /** Paragraph is open (text seen, no \par yet) — controls trailing flush. */
  let paraOpen = false;

  const startRun = (): void => {
    if (run.text.length > 0) runs.push(run);
    run = { text: "", bold: state.bold, italic: state.italic, size: state.fontSize };
  };

  const flushParagraph = (): void => {
    startRun();
    const joined = runs.map((r) => r.text).join("");
    if (joined.trim().length > 0) {
      const first = runs.find((r) => r.text.length > 0) ?? null;
      blocks.push({
        type: "para",
        runs,
        fontSize: first === null ? null : first.size,
      });
    } else {
      // Empty / whitespace-only paragraph — one blank line (render-side
      // gaps vanish at a page top, the word-to-pdf spacer rule).
      blocks.push({ type: "spacer" });
    }
    runs = [];
    run = { text: "", bold: state.bold, italic: state.italic, size: state.fontSize };
    paraOpen = false;
  };

  /** Table cells / rows / section ends flush only when a paragraph is
   *  open — an empty cell must not emit a blank-line spacer. */
  const flushIfOpen = (): void => {
    if (paraOpen || runs.length > 0 || run.text.length > 0) flushParagraph();
  };

  const pushPageBreak = (): void => {
    // Flush first so the break lands between paragraphs.
    flushIfOpen();
    blocks.push({ type: "pagebreak" });
  };

  const len = source.length;
  let i = 0;

  const appendText = (text: string): void => {
    if (skipFrom !== null || text.length === 0) return;
    run.text += text;
    paraOpen = true;
  };

  while (i < len) {
    const ch = source[i];

    if (ch === "{") {
      pendingIgnore = false; // \* must be followed by a control word
      stack.push(state);
      state = { ...state };
      i += 1;
      continue;
    }
    if (ch === "}") {
      pendingIgnore = false;
      if (stack.length > 0) {
        state = stack.pop() as RtfState;
        // Leaving a skipped group?
        if (skipFrom !== null && stack.length < skipFrom) skipFrom = null;
        // The restored character format must apply to the text that
        // FOLLOWS the brace: close the run accumulated under the inner
        // format so a fresh run starts with the outer bold/italic/size
        // (the RTF group stack restores character format at '}').
        startRun();
      }
      // Stray '}' at depth 0 — tag-soup tolerant: ignored.
      i += 1;
      continue;
    }

    if (ch === "\\") {
      const next = i + 1 < len ? source[i + 1] : "";

      if (next !== "" && LETTER_RE.test(next)) {
        // ---- control word: \word[-]digits? ----
        let j = i + 1;
        while (j < len && LETTER_RE.test(source[j])) j += 1;
        const word = source.slice(i + 1, j);
        let param: number | null = null;
        let neg = false;
        if (j < len && (source[j] === "-" || DIGIT_RE.test(source[j]))) {
          if (source[j] === "-") {
            neg = true;
            j += 1;
          }
          const digitsStart = j;
          while (j < len && DIGIT_RE.test(source[j])) j += 1;
          if (j > digitsStart) param = Number.parseInt(source.slice(digitsStart, j), 10);
        }
        // Delimiter: a space is consumed; any other non-alphanumeric
        // character stays in the stream (the RTF rule).
        if (j < len && source[j] === " ") j += 1;
        i = j;

        const numeric = (p: number | null): number | null =>
          p === null || !Number.isFinite(p) ? null : neg ? -p : p;

        if (pendingIgnore) {
          // \*\destination — skip this whole group, whatever the word.
          pendingIgnore = false;
          if (skipFrom === null) skipFrom = stack.length;
          continue;
        }
        if (skipFrom !== null) {
          // Inside a skipped destination the words still need parsing
          // for \bin (raw bytes follow) — but nothing is emitted.
          const n = word === "bin" ? numeric(param) : null;
          if (n !== null && n > 0) i += n;
          continue;
        }

        switch (word) {
          case "par":
            flushParagraph();
            break;
          case "line":
            appendText("\n");
            break;
          case "tab":
            appendText("    ");
            break;
          case "page":
            pushPageBreak();
            break;
          case "sect":
            // A section end starts a new page in word processors by
            // default — rendered as an honest page break.
            pushPageBreak();
            break;
          case "cell":
          case "row":
          case "nestcell":
          case "nestrow":
            // V1 tables: the grid is not rebuilt — each cell's text
            // flows out as its own paragraph (the word-to-pdf honesty).
            flushIfOpen();
            break;
          case "pard":
            // Paragraph-format reset — nothing tracked in v1 (alignment,
            // indents are not rendered; documented honestly).
            break;
          case "plain":
            state.bold = false;
            state.italic = false;
            state.fontSize = null;
            startRun();
            break;
          case "b":
            state.bold = numeric(param) !== 0;
            startRun();
            break;
          case "i":
            state.italic = numeric(param) !== 0;
            startRun();
            break;
          case "fs": {
            const n = numeric(param);
            if (n !== null && n > 0) {
              state.fontSize = n / 2;
              startRun();
            }
            break;
          }
          case "uc": {
            const n = numeric(param);
            state.uc = n !== null && n >= 0 ? n : 1;
            break;
          }
          case "u": {
            // Unicode escape — may be a NEGATIVE 16-bit signed value
            // (surrogate halves are written that way).
            const n = numeric(param);
            if (n === null) break;
            const unit = ((n % 65536) + 65536) % 65536;
            if (unit >= 0x20 && unit !== 0x7f) {
              appendText(String.fromCharCode(unit));
            } else if (unit === 0x09) {
              appendText("    "); // escaped tab — treated like \tab
            }
            // other control units (and DEL) are dropped — never text
            // Skip the fallback char(s) (\ucN, default 1). Tolerance: a
            // fallback is never a structural token — stop at \ { } so a
            // malformed file cannot eat control words.
            let toSkip = state.uc;
            while (toSkip > 0 && i < len) {
              const c = source[i];
              if (c === "\\" || c === "{" || c === "}") break;
              i += 1;
              toSkip -= 1;
            }
            break;
          }
          case "bin": {
            const n = numeric(param);
            if (n !== null && n > 0) i += n; // raw bytes — skip verbatim
            break;
          }
          case "s":
          case "cs":
          case "ds":
            // Style numbers are not resolved in v1 (no \stylesheet
            // parsing) — ignored, stated in the FAQ.
            break;
          default:
            // Unknown control word (with its numeric param) — skipped;
            // known non-body destinations swallow their whole group.
            if (SKIP_DESTINATIONS.has(word)) skipFrom = stack.length;
            break;
        }
        continue;
      }

      if (next === "'") {
        // ---- hex escape: \'hh (CP1252 byte) ----
        const h1 = i + 2 < len ? source[i + 2] : "";
        const h2 = i + 3 < len ? source[i + 3] : "";
        i += 4;
        if (HEX_RE.test(h1) && HEX_RE.test(h2)) {
          appendText(cp1252Char(Number.parseInt(h1 + h2, 16)));
        } else {
          appendText("?"); // missing digits — degrade, never crash
        }
        continue;
      }

      // ---- control symbol: backslash + one non-letter ----
      i += 2;
      if (next === "*") {
        pendingIgnore = true;
        continue;
      }
      if (skipFrom !== null) continue;
      switch (next) {
        case "":
          break; // trailing backslash at EOF
        case "~":
          appendText("\u00a0"); // non-breaking space (WinAnsi-safe)
          break;
        case "-":
          break; // optional hyphen — renders only at a break; dropped
        case "_":
          appendText("-"); // non-breaking hyphen → plain hyphen
          break;
        default:
          appendText(next); // \\ \{ \} and any other literal symbol
          break;
      }
      continue;
    }

    // ---- raw text character ----
    const cp = source.charCodeAt(i);
    i += 1;
    if (cp === 0x0a || cp === 0x0d) continue; // source line formatting
    if (cp === 0x09) {
      appendText("    "); // raw tab — treated like \tab
      continue;
    }
    if (cp < 0x20 || cp === 0x7f) continue; // stray control — drop
    if (cp >= 0x80 && cp <= 0xff) {
      // Raw high byte — non-conforming but common; CP1252.
      appendText(cp1252Char(cp));
      continue;
    }
    appendText(ch);
  }

  // Auto-close: flush a paragraph left open by a truncated tail.
  if (paraOpen || runs.length > 0 || run.text.length > 0) flushParagraph();

  let charCount = 0;
  for (const block of blocks) {
    if (block.type !== "para") continue;
    for (const r of block.runs) {
      charCount += r.text.replace(/\s/g, "").length;
    }
  }
  return { blocks, charCount };
}

/**
 * Bytes → blocks. Decodes the source as latin1 (RTF is defined as 7-bit
 * ASCII; byte↔charCode identity keeps \'hh and \u math exact), after the
 * binary/header sniff. Throws RtfParseError for non-RTF / binary input.
 */
export function parseRtfBytes(bytes: Uint8Array): ParsedRtf {
  sniffRtfBytes(bytes);
  let source = "";
  for (let i = 0; i < bytes.length; i += 1) source += String.fromCharCode(bytes[i]);
  return parseRtfText(source);
}
