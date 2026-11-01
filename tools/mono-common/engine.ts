import { CreateContext } from "@/lib/own/pdf";

/**
 * Mono-text → PDF layout (PHASE-3 batch 3): the shared pretty-print
 * renderer behind json-to-pdf and xml-to-pdf — Courier lines wrapped to
 * the page width, optional syntax colouring (keys vs strings vs
 * punctuation), page footer with continuation. Pure logic so the smokes
 * can drive it in Node.
 */

export interface MonoStyle {
  /** Base text colour (JSON keys / XML tags). */
  ink: { r: number; g: number; b: number };
  /** String literal colour. */
  string: { r: number; g: number; b: number };
  /** Number / punctuation colour. */
  plain: { r: number; g: number; b: number };
}

export const MONO_STYLE: MonoStyle = {
  ink: { r: 0.1, g: 0.26, b: 0.46 },
  string: { r: 0.16, g: 0.36, b: 0.14 },
  plain: { r: 0.2, g: 0.21, b: 0.24 },
};

export interface MonoLayoutOptions {
  pageSize: { width: number; height: number };
  orientation: "portrait" | "landscape";
  fontSize: number;
  /** Hard cap on rendered pages (honest errors instead of runaway runs). */
  maxPages: number;
  /** JSON-style colouring when true (keys vs strings). */
  colorize: boolean;
}

export interface MonoLine {
  text: string;
  /** Style key decided by the tokenizer (ink | string | plain). */
  style: "ink" | "string" | "plain";
}

export interface MonoLayoutResult {
  pages: number;
  lines: number;
  truncated: boolean;
}

const MARGIN = 42;
const LEADING = 1.45;

/** Tokenize a pretty-printed JSON/XML line into styled runs. */
function styleRuns(line: string, colorize: boolean): MonoLine[] {
  if (!colorize) {
    return [{ text: line, style: "plain" }];
  }
  const runs: MonoLine[] = [];
  // JSON: "key": "value" | number | bool; XML: <tag>text</tag>
  const re = /("[^"]*"\s*:)|("(?:[^"\\]|\\.)*")|(<\/?[A-Za-z][^\s>]*>)|([<>])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) {
      runs.push({ text: line.slice(last, match.index), style: "plain" });
    }
    if (match[1] !== undefined) {
      runs.push({ text: match[1], style: "ink" });
    } else if (match[2] !== undefined) {
      runs.push({ text: match[2], style: "string" });
    } else {
      runs.push({ text: match[0], style: "ink" });
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) {
    runs.push({ text: line.slice(last), style: "plain" });
  }
  return runs.length > 0 ? runs : [{ text: line, style: "plain" }];
}

/** Render lines through CreateContext with wrapping + page breaks. */
export function renderMonoLines(
  ctx: CreateContext,
  lines: readonly string[],
  opts: MonoLayoutOptions
): MonoLayoutResult {
  const pageW =
    opts.orientation === "landscape" ? opts.pageSize.height : opts.pageSize.width;
  const pageH =
    opts.orientation === "landscape" ? opts.pageSize.width : opts.pageSize.height;

  const charW = ctx.measure("0", "courier", opts.fontSize);
  const maxChars = Math.max(20, Math.floor((pageW - MARGIN * 2) / charW));
  const lineHeight = opts.fontSize * LEADING;
  const linesPerPage = Math.max(
    1,
    Math.floor((pageH - MARGIN * 2) / lineHeight)
  );

  // Wrap long lines (visual width in chars), then paginate.
  const wrapped: string[] = [];
  for (const line of lines) {
    if (line.length <= maxChars) {
      wrapped.push(line);
      continue;
    }
    let at = 0;
    while (at < line.length) {
      wrapped.push(line.slice(at, at + maxChars));
      at += maxChars;
    }
  }

  const totalLines = wrapped.length;
  const maxLines = linesPerPage * opts.maxPages;
  const truncated = totalLines > maxLines;
  const renderLines = truncated ? wrapped.slice(0, maxLines) : wrapped;

  let page: ReturnType<CreateContext["addPage"]> | null = null;
  let pages = 0;
  for (let i = 0; i < renderLines.length; i += 1) {
    const slot = i % linesPerPage;
    if (slot === 0) {
      page = ctx.addPage(pageW, pageH);
      pages += 1;
    }
    const line = renderLines[i]!;
    if (line.length === 0) continue;
    const y = pageH - MARGIN - slot * lineHeight - opts.fontSize;
    let x = MARGIN;
    for (const run of styleRuns(line, opts.colorize)) {
      if (run.text.length === 0) continue;
      page!.drawText({
        x,
        y,
        text: run.text,
        size: opts.fontSize,
        font: "courier",
        color:
          run.style === "ink"
            ? MONO_STYLE.ink
            : run.style === "string"
              ? MONO_STYLE.string
              : MONO_STYLE.plain,
      });
      x += ctx.measure(run.text, "courier", opts.fontSize);
    }
  }

  if (renderLines.length === 0) {
    // Empty input still gets one honest page.
    ctx.addPage(pageW, pageH);
    pages = 1;
  }

  return { pages, lines: totalLines, truncated };
}

/* ------------------------------------------------------------------ */
/* Prettifiers                                                         */
/* ------------------------------------------------------------------ */

/** Pretty-print JSON (throws on invalid JSON — the worker maps it). */
export function prettyJson(text: string): string {
  const parsed: unknown = JSON.parse(text);
  return JSON.stringify(parsed, null, 2);
}

/**
 * Lightweight XML pretty-printer: tokenizes tags, indents by nesting
 * depth, keeps text nodes on their own lines. No tree is built — honest
 * formatting for well-formed-ish input, best-effort for the rest.
 */
export function prettyXml(text: string): string {
  const src = text.replace(/\r\n/g, "\n").trim();
  const out: string[] = [];
  let depth = 0;
  const INDENT = "  ";

  const tokens = src.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<")) {
      const isDecl = /^<[!?]/.test(token);
      const isClose = /^<\//.test(token);
      const selfClose = /\/>$/.test(token);
      if (isClose) {
        depth = Math.max(0, depth - 1);
        out.push(`${INDENT.repeat(depth)}${token}`);
      } else if (isDecl) {
        out.push(token);
      } else if (selfClose) {
        out.push(`${INDENT.repeat(depth)}${token}`);
      } else {
        out.push(`${INDENT.repeat(depth)}${token}`);
        depth += 1;
      }
    } else {
      const trimmed = token.trim();
      if (trimmed.length > 0) {
        out.push(`${INDENT.repeat(Math.min(depth, 40))}${trimmed}`);
      }
    }
  }
  return out.join("\n");
}

/** Is this plausibly XML at all? (starts with '<') */
export function looksLikeXml(text: string): boolean {
  return /^\s*</.test(text);
}
