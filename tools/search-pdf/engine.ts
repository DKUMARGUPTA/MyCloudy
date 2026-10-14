import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Search PDFs — pure engine (PRD §8.5: "Query or regex across many PDFs;
 * jump to each match's page").
 *
 * Zero runtime imports — the custom panel (validity echo), the interactive
 * surface (live first-file preview), the pool worker (full report) and the
 * bun smoke script all share this module, so the matcher semantics, the
 * snippet shape and the page-text joining are pinned BEFORE any UI exists.
 *
 * Option contract (the panel owns every input — split-pdf precedent; the
 * schema options array stays empty and the worker defaults defensively):
 *   query         string      what to look for ("" blocks the run)
 *   mode          "text" | "regex"
 *   caseSensitive boolean
 *   wholeWord     boolean     (text mode only; ignored for regex)
 *   context       number      snippet context chars per side, clamped 10..80
 *
 * Match policy: non-overlapping, left-to-right — both modes. Case folding
 * uses String.prototype.toLowerCase only (honest: that is Latin/Greek/
 * Cyrillic-correct and a no-op for Devanagari, which has no case); when a
 * page's text changes LENGTH while folding (the Turkish "İ" family), the
 * case-insensitive pass falls back to case-sensitive matching on that text
 * so reported indexes always address the original code units.
 */

export const SEARCH_IDS = {
  query: "query",
  mode: "mode",
  caseSensitive: "caseSensitive",
  wholeWord: "wholeWord",
  context: "context",
} as const;

export type SearchMode = "text" | "regex";

/** Snippet context bounds (chars per side of the hit). */
export const CONTEXT_MIN = 10;
export const CONTEXT_MAX = 80;
export const CONTEXT_DEFAULT = 40;

/** Honest per-file report cap (the worker notes the truncation). */
export const MAX_MATCHES_PER_FILE = 500;
/** Live-preview cap in the surface (first file only). */
export const MAX_PREVIEW_MATCHES = 50;

export interface SearchOptions {
  query: string;
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  context: number;
}

/** Normalize panel/worker options (unknown values fall back honestly). */
export function resolveSearchOptions(options: OptionValues): SearchOptions {
  const rawQuery = options[SEARCH_IDS.query];
  const rawMode = options[SEARCH_IDS.mode];
  const rawContext = Number(options[SEARCH_IDS.context]);
  return {
    query: typeof rawQuery === "string" ? rawQuery : "",
    mode: rawMode === "regex" ? "regex" : "text",
    caseSensitive: options[SEARCH_IDS.caseSensitive] === true,
    wholeWord: options[SEARCH_IDS.wholeWord] === true,
    context:
      Number.isFinite(rawContext) && rawContext > 0
        ? Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(rawContext)))
        : CONTEXT_DEFAULT,
  };
}

/* ------------------------------------------------------------------ */
/* Matcher                                                            */
/* ------------------------------------------------------------------ */

/** One match as a [index, index+length) range in the page's text. */
export interface MatchRange {
  index: number;
  length: number;
}

export interface MatcherInit {
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Thrown by buildMatcher for a regex query that fails to compile. */
export class BadRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRegexError";
  }
}

export interface Matcher {
  mode: SearchMode;
  caseSensitive: boolean;
  /** wholeWord only applies in text mode (regex authors write their own \b). */
  wholeWord: boolean;
  /** Raw query (text mode matches it literally — never as a pattern). */
  needle: string;
  /** Compiled pattern (regex mode only). */
  regex: RegExp | null;
}

export function buildMatcher(query: string, init: MatcherInit): Matcher {
  if (init.mode === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(query, init.caseSensitive ? "g" : "gi");
    } catch (cause) {
      throw new BadRegexError(
        cause instanceof Error ? cause.message : String(cause)
      );
    }
    return {
      mode: "regex",
      caseSensitive: init.caseSensitive,
      wholeWord: false,
      needle: query,
      regex,
    };
  }
  return {
    mode: "text",
    caseSensitive: init.caseSensitive,
    wholeWord: init.wholeWord,
    needle: query,
    regex: null,
  };
}

/** True for a character that participates in a word (Unicode letters/digits/_). */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** Both neighbors must be non-word characters for a whole-word hit. */
function wholeWordBoundary(
  text: string,
  index: number,
  length: number
): boolean {
  return (
    !isWordChar(text[index - 1]) &&
    !isWordChar(text[index + length])
  );
}

/** All non-overlapping matches of `matcher` in `text`, left to right. */
export function findMatches(text: string, matcher: Matcher): MatchRange[] {
  if (text.length === 0) return [];
  if (matcher.mode === "regex" && matcher.regex !== null) {
    const out: MatchRange[] = [];
    const regex = matcher.regex;
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
      if (m[0].length === 0) {
        // Zero-length matches carry no hit text — skip forward, never loop.
        regex.lastIndex += 1;
        if (regex.lastIndex > text.length) break;
        continue;
      }
      out.push({ index: m.index, length: m[0].length });
    }
    return out;
  }
  const needle = matcher.needle;
  if (needle.length === 0) return [];
  if (matcher.caseSensitive) {
    return scanWith(text, needle, matcher.wholeWord);
  }
  const folded = text.toLowerCase();
  if (folded.length === text.length) {
    return scanWith(folded, needle.toLowerCase(), matcher.wholeWord);
  }
  // Folding changed the text's length (İ-style expansion): reported indexes
  // would not address the original string — degrade to case-sensitive.
  return scanWith(text, needle, matcher.wholeWord);
}

/** indexOf scan with the whole-word filter; non-overlapping left-to-right. */
function scanWith(
  haystack: string,
  needle: string,
  wholeWord: boolean
): MatchRange[] {
  const out: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    if (!wholeWord || wholeWordBoundary(haystack, index, needle.length)) {
      out.push({ index, length: needle.length });
      from = index + needle.length;
    } else {
      from = index + 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Snippets                                                           */
/* ------------------------------------------------------------------ */

export interface Snippet {
  before: string;
  hit: string;
  after: string;
}

/** Collapse whitespace runs longer than one char to a single space. */
function collapseRuns(text: string): string {
  return text.replace(/\s{2,}/g, " ");
}

/**
 * Context window around one match, cut at word boundaries:
 *  - if the window opens or closes in the MIDDLE of a word, that partial
 *    word is dropped (complete words are always kept);
 *  - `before` is prefixed with "…" when the page text continues on the
 *    left, `after` is suffixed with "…" when it continues on the right;
 *  - whitespace runs > 1 collapse to a single space; the hit stays verbatim.
 */
export function makeSnippet(
  pageText: string,
  match: MatchRange,
  contextChars: number
): Snippet {
  const ctx = Math.max(0, Math.floor(contextChars));
  const hitStart = match.index;
  const hitEnd = hitStart + match.length;
  const rawStart = Math.max(0, hitStart - ctx);
  const rawEnd = Math.min(pageText.length, hitEnd + ctx);

  let before = pageText.slice(rawStart, hitStart);
  if (rawStart > 0) {
    // Window opens mid-word → drop the partial word, keep complete ones.
    if (isWordChar(pageText[rawStart - 1]) && isWordChar(pageText[rawStart])) {
      const firstWs = before.search(/\s/);
      if (firstWs >= 0) before = before.slice(firstWs + 1);
    }
    before = collapseRuns(before).replace(/^\s+/, "");
    before = `…${before}`;
  } else {
    before = collapseRuns(before).replace(/^\s+/, "");
  }

  let after = pageText.slice(hitEnd, rawEnd);
  if (rawEnd < pageText.length) {
    // Window closes mid-word → drop the trailing partial word.
    if (isWordChar(pageText[rawEnd - 1]) && isWordChar(pageText[rawEnd])) {
      const lastWs = after.search(/\s[^\s]*$/);
      if (lastWs >= 0) after = after.slice(0, lastWs);
    }
    after = collapseRuns(after).replace(/\s+$/, "");
    after = `${after}…`;
  } else {
    after = collapseRuns(after).replace(/\s+$/, "");
  }

  return {
    before,
    hit: pageText.slice(hitStart, hitEnd),
    after,
  };
}

/* ------------------------------------------------------------------ */
/* Page text joining (worker + surface share one definition)           */
/* ------------------------------------------------------------------ */

/** Minimal pdf.js getTextContent item shape this joiner needs. */
export interface RawTextItem {
  str?: unknown;
  hasEOL?: unknown;
}

/**
 * Join a page's text items into one searchable string — the simplified
 * pdf-to-txt recipe: plain space join, no paragraph merging, horizontal
 * space runs collapsed, trimmed. Both the worker and the live surface use
 * it, so a preview match and a report match are the same match.
 */
export function joinPageText(items: RawTextItem[]): string {
  let out = "";
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    if (out.length > 0) out += " ";
    out += item.str;
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Run error classification                                           */
/* ------------------------------------------------------------------ */

/**
 * Map a thrown pdf.js error message to the i18n key the shell toast shows
 * (same families as pdf-to-txt): password → encrypted, otherwise corrupt.
 * Empty query / bad regex are caught earlier, before any file is read.
 */
export function classifySearchError(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}
