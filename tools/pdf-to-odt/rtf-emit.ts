import { cp1252Char } from "../rtf-to-pdf/rtf-parse";

import type { ExtractedDoc, ExtractedRun } from "./extract";

/**
 * RTF emitter (Task b5-c) — PURE, bun-testable, no DOM, no zip.
 *
 * Rich Text Format is plaintext markup: control words, groups and raw
 * 7-bit text. This module writes the honest word-processor subset our
 * own reader (tools/rtf-to-pdf/rtf-parse) round-trips:
 *
 *   {\rtf1\ansi\ansicpg1252\deff0
 *   {\fonttbl{\f0 Helvetica;}}
 *   {\generator MyCloudy;}
 *   … body …
 *   }
 *
 * Body: one paragraph per extracted paragraph, joined with \par; bold /
 * italic / bold-italic runs as {\b …} / {\i …} / {\b\i …} groups (the
 * closing brace restores the outer state — the RTF group stack our
 * reader implements). RTF honestly carries no heading markup, so
 * heading paragraphs flatten to plain paragraphs (the rtf-to-pdf FAQ
 * contract — no faked hierarchy).
 *
 * Character encoding:
 *   - ASCII printable except \ { } → literal; the three specials are
 *     backslash-escaped;
 *   - characters in CP1252 (é “ ” — € …) → \'hh hex escapes (the
 *     inverse of our reader's cp1252Char table);
 *   - everything else → \uNNNN? escapes. RTF \u is SIGNED 16-bit:
 *     Devanagari े = U+0947 = 2375 decimal → \u2375?; astral code
 *     points split into their surrogate halves, each written signed
 *     (😀 = U+1F600 → \u-10179?\u-8704?). The `?` is the one-char
 *     fallback (\uc1 default) our reader skips.
 *   - control characters are not honest text: dropped at emit exactly
 *     like the reader drops them (round-trip stays exact); a tab maps
 *     to one space, a stray newline to \line.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone.
 */

/* ------------------------------------------------------------------ */
/* CP1252 reverse table (built from our own reader's forward table)     */
/* ------------------------------------------------------------------ */

/** Unicode → CP1252 byte (undefined positions absent — dropped there too). */
const CP1252_REVERSE: Map<string, number> = (() => {
  const table = new Map<string, number>();
  for (let b = 0x80; b <= 0xff; b += 1) {
    const ch = cp1252Char(b);
    if (ch !== undefined && ch.length === 1 && !table.has(ch)) {
      table.set(ch, b);
    }
  }
  return table;
})();

/* ------------------------------------------------------------------ */
/* Escaping                                                            */
/* ------------------------------------------------------------------ */

/** SIGNED 16-bit form of a UTF-16 unit — the RTF \u parameter. */
function signed16(unit: number): number {
  return unit > 0x7fff ? unit - 0x10000 : unit;
}

/**
 * One run's text → RTF-safe source. Non-ASCII rides \'hh (CP1252) or
 * \uNNNN? escapes; \ { } are backslash-escaped; control characters are
 * dropped (the reader drops them too — the round-trip stays exact);
 * tab becomes one space; a stray newline becomes \line (the reader's
 * hard break).
 */
export function escapeRtfText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const cp = text.charCodeAt(i);
    if (ch === "\\") {
      out += "\\\\";
      continue;
    }
    if (ch === "{") {
      out += "\\{";
      continue;
    }
    if (ch === "}") {
      out += "\\}";
      continue;
    }
    if (cp === 0x0a) {
      out += "\\line ";
      continue;
    }
    if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f) {
      if (cp === 0x09) out += " ";
      continue; // control characters are not honest text
    }
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // High surrogate: pair with the next unit when it matches.
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += `\\u${signed16(cp)}?\\u${signed16(lo)}?`;
        i += 1;
        continue;
      }
      continue; // a lone surrogate is not honest text — dropped
    }
    if (cp >= 0xdc00 && cp <= 0xdfff) {
      continue; // lone low surrogate — dropped
    }
    const cp1252 = CP1252_REVERSE.get(ch);
    if (cp1252 !== undefined) {
      out += `\\'${cp1252.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += `\\u${signed16(cp)}?`;
  }
  return out;
}

/** One run → its RTF fragment (a formatting group or bare text). */
export function rtfRunXml(run: ExtractedRun): string {
  const text = escapeRtfText(run.text);
  if (run.bold && run.italic) return `{\\b\\i ${text}}`;
  if (run.bold) return `{\\b ${text}}`;
  if (run.italic) return `{\\i ${text}}`;
  return text;
}

/* ------------------------------------------------------------------ */
/* The document source                                                 */
/* ------------------------------------------------------------------ */

const RTF_HEADER = [
  "{\\rtf1\\ansi\\ansicpg1252\\deff0",
  "{\\fonttbl{\\f0 Helvetica;}}",
  "{\\generator MyCloudy;}",
].join("\n");

/**
 * The extracted document → the complete RTF source. Headings flatten
 * to paragraphs (RTF carries no heading markup — the honest contract
 * our rtf-to-pdf reader documents); the run flags survive.
 */
export function buildRtfSource(doc: ExtractedDoc): string {
  const body: string[] = [];
  for (const page of doc.pages) {
    for (const paragraph of page.paragraphs) {
      const runs = paragraph.runs.filter((run) => run.text.length > 0);
      const text = runs.map((run) => run.text).join("");
      if (text.trim().length === 0) continue;
      body.push(runs.map((run) => rtfRunXml(run)).join(""));
    }
  }
  const joined =
    body.length === 0 ? RTF_HEADER : `${RTF_HEADER}\n${body.join("\n\\par\n")}`;
  return `${joined}\n\\par\n}\n`;
}

const utf8 = new TextEncoder();

/** The extracted document → the .rtf bytes (latin1-safe ASCII source). */
export function emitRtf(doc: ExtractedDoc): Uint8Array {
  // RTF source is 7-bit ASCII by construction (every non-ASCII char
  // is escaped), so UTF-8 encoding is byte-identical to ASCII here.
  return utf8.encode(buildRtfSource(doc));
}
