import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Remove blank pages planning (PHASE-1 Batch B): decide which pages are
 * blank by sniffing their content streams — conservative, never removes
 * a page that draws anything.
 *
 * Two levels:
 *   - empty: the page has NO /Contents (or an empty/whitespace-only
 *     stream) — unambiguously blank.
 *   - strict (also remove "draws nothing" pages): the content decodes to
 *     operators, but none of them MARK the page — only graphics-state
 *     noise (q/Q/cm/w/gs/rg/g/k/cs/sc/scn/re WITHOUT fill/stroke,
 *     BT…ET with no show-text). A page that shows text, draws a path,
 *     paints an image or XObject is NEVER blank.
 *
 * Pure planning over a parsed doc — fully smoke-testable.
 */

export const RB_IDS = {
  strict: "strict",
} as const;

export interface RemoveBlankOptions {
  strict: boolean;
}

export const REMOVE_BLANK_DEFAULTS: RemoveBlankOptions = {
  strict: true,
};

export function resolveRemoveBlankOptions(
  values: OptionValues
): RemoveBlankOptions {
  return {
    strict: values[RB_IDS.strict] !== false,
  };
}

/** Operators that actually MARK the page (show text / paint / stroke / fill). */
const MARKING_OPS = new Set([
  "Tj", "TJ", "'", "\"",       // show text
  "S", "s", "f", "F", "f*",    // stroke / fill paths
  "B", "B*", "b", "b*",        // fill + stroke
  "Do",                         // XObject (image / form)
  "BI",                         // inline image
  "sh",                         // shading
]);

/**
 * Tokenize a decoded content stream into operator names (best-effort,
 * string/hex/comment aware). Returns null when the content cannot be
 * tokenized (caller keeps the page — conservative).
 */
export function contentOperators(content: string): string[] | null {
  const ops: string[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i]!;
    if (ch === "%") {
      // Comment to end of line.
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "(") {
      // Literal string — skip with nesting + escapes.
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const c = content[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "(") depth += 1;
        if (c === ")") depth -= 1;
        i += 1;
      }
      if (depth > 0) return null;
      continue;
    }
    if (ch === "<" && content[i + 1] === "<") {
      // Dict — skip to matching >>.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (content[i] === "<" && content[i + 1] === "<") {
          depth += 1;
          i += 2;
          continue;
        }
        if (content[i] === ">" && content[i + 1] === ">") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (depth > 0) return null;
      continue;
    }
    if (ch === "<") {
      // Hex string.
      i += 1;
      while (i < n && content[i] !== ">") i += 1;
      if (i >= n) return null;
      i += 1;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      // Operator or keyword — collect the run.
      let j = i;
      while (j < n && /[A-Za-z0-9'"*]/.test(content[j]!)) j += 1;
      ops.push(content.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return ops;
}

/** True when the operator list marks the page. */
export function operatorsMark(ops: readonly string[]): boolean {
  return ops.some((op) => MARKING_OPS.has(op));
}

export interface BlankFindings {
  /** 0-based indices of pages classified blank. */
  blanks: number[];
  pageCount: number;
}

/**
 * Decide the blank set for a parsed document. `decodePage` decodes one
 * page's content to a string (worker supplies the engine decoder).
 */
export function planRemoveBlank(
  pageCount: number,
  pageDictAt: (index: number) => Map<string, unknown> | undefined,
  decodePage: (index: number) => string | null,
  opts: RemoveBlankOptions
): BlankFindings {
  const blanks: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const dict = pageDictAt(i);
    if (!dict) continue;
    const contentsRaw = dict.get("Contents");
    const contents = contentsRaw === undefined ? undefined : contentsRaw;
    if (contents === undefined) {
      // No /Contents at all → blank by definition.
      blanks.push(i);
      continue;
    }
    const decoded = decodePage(i);
    if (decoded === null) continue; // undecodable → keep (conservative)
    if (decoded.trim().length === 0) {
      // Whitespace-only content → blank.
      blanks.push(i);
      continue;
    }
    if (!opts.strict) continue;
    const ops = contentOperators(decoded);
    if (ops === null) continue; // untokenizable → keep
    if (!operatorsMark(ops)) {
      // Draws nothing → blank in strict mode.
      blanks.push(i);
    }
  }
  return { blanks, pageCount };
}
