/**
 * Chat with PDF (R8) — pure, deterministic model shared by the extraction
 * worker output, the chat surface and scripts/smoke-chat-pdf.ts. No DOM, no
 * workers, no network: everything here is plain data math the smoke can pin.
 *
 * Privacy shape (the honest contract, repeated in the tool's FAQ): the PDF
 * itself NEVER leaves the device. The browser extracts per-page text in a
 * Web Worker, buildDocExcerpt() trims it to a bounded page-marked string,
 * and ONLY that excerpt + the visible chat history ever POST to /api/chat.
 * No file bytes, no server storage, no logging — the excerpt exists in the
 * API route's memory for one request and is gone.
 */

export const CHAT_LIMITS = {
  /** Max chars of document text sent to the model (≈12k tokens). */
  excerptBudget: 48_000,
  /** Share of the budget spent from the front when trimming is needed. */
  headShare: 0.6,
  /** Hard per-page cap before a page is truncated with an honest marker. */
  pageCharCap: 20_000,
  /** Max visible chat messages (user+assistant) kept and sent. */
  historyMessages: 16,
  /** Per-message caps accepted by the API (mirrored by the zod schema). */
  userMessageChars: 2_000,
  assistantMessageChars: 4_000,
  /** Below this many extracted characters the doc counts as "no text". */
  scannedThresholdChars: 40,
} as const;

export interface ExtractedPage {
  /** 1-based page number as printed in the [[p N]] markers. */
  page: number;
  /** Raw extracted text of that page (normalized here, not in the worker). */
  text: string;
}

export interface DocExcerpt {
  /** The page-marked string actually sent to the model. */
  excerpt: string;
  /** Total characters across all extracted pages (after normalize). */
  totalChars: number;
  /** Characters actually present in the excerpt. */
  sentChars: number;
  pagesTotal: number;
  pagesIncluded: number;
  /** Pages dropped to fit the budget (head+tail strategy). */
  omittedPages: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Page marker the model is instructed to cite back as "(p. N)". */
export function pageMarker(page: number): string {
  return `[[p ${page}]]`;
}

/** Normalize one page's text: trim, collapse 3+ newlines, hard cap. */
export function normalizePageText(
  text: string,
  cap: number = CHAT_LIMITS.pageCharCap,
): string {
  const flat = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap)}\n…[page truncated]…`;
}

/** Clean free-typed text: strip control chars, collapse blank runs, cap. */
export function cleanUserText(
  input: string,
  cap: number = CHAT_LIMITS.userMessageChars,
): string {
  const flat = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return flat.length > cap ? flat.slice(0, cap) : flat;
}

/**
 * Page-granular head+tail trim. Whole document under budget → everything,
 * in order. Over budget → leading pages up to headShare of the budget, then
 * trailing pages for the rest, with an honest omitted-count marker between
 * (keeping citations truthful: a page is either fully present or fully gone).
 */
export function buildDocExcerpt(
  pages: ExtractedPage[],
  budget: number = CHAT_LIMITS.excerptBudget,
): DocExcerpt {
  const norm = (Array.isArray(pages) ? pages : [])
    .filter(
      (p): p is ExtractedPage =>
        !!p &&
        typeof p.page === "number" &&
        Number.isFinite(p.page) &&
        typeof p.text === "string",
    )
    .map((p) => ({
      page: Math.max(1, Math.round(p.page)),
      text: normalizePageText(p.text),
    }));

  const totalChars = norm.reduce((n, p) => n + p.text.length, 0);
  if (norm.length === 0) {
    return {
      excerpt: "",
      totalChars: 0,
      sentChars: 0,
      pagesTotal: 0,
      pagesIncluded: 0,
      omittedPages: 0,
    };
  }

  const cost = (p: { page: number; text: string }): number =>
    pageMarker(p.page).length + 1 + p.text.length + 1;
  const stitch = (p: { page: number; text: string }): string =>
    `${pageMarker(p.page)}\n${p.text}`;

  const fullLen = norm.reduce((n, p) => n + cost(p), 0);
  if (fullLen <= budget) {
    return {
      excerpt: norm.map(stitch).join("\n"),
      totalChars,
      sentChars: fullLen,
      pagesTotal: norm.length,
      pagesIncluded: norm.length,
      omittedPages: 0,
    };
  }

  // Head fill: leading pages while they fit headShare of the budget.
  const headBudget = Math.max(
    pageMarker(norm[0].page).length + 8,
    Math.floor(budget * CHAT_LIMITS.headShare),
  );
  const included: Array<{ page: number; text: string }> = [];
  let used = 0;
  for (const p of norm) {
    if (used + cost(p) > headBudget) break;
    included.push(p);
    used += cost(p);
  }
  if (included.length === 0) {
    // Defensive: a single over-budget first page is truncated to fit.
    const p = norm[0];
    const room = headBudget - pageMarker(p.page).length - 2;
    included.push({
      page: p.page,
      text: p.text.slice(0, Math.max(0, room)) + "\n…[page truncated]…",
    });
    used = headBudget;
  }
  const headCount = included.length;

  // Tail fill: trailing pages for whatever budget remains.
  const tailBudget = budget - used;
  const tail: Array<{ page: number; text: string }> = [];
  let tailUsed = 0;
  for (let i = norm.length - 1; i > headCount - 1; i -= 1) {
    const p = norm[i];
    if (tailUsed + cost(p) > tailBudget) break;
    tail.unshift(p);
    tailUsed += cost(p);
  }

  const mid = norm.length - included.length - tail.length;
  const parts: string[] = [included.map(stitch).join("\n")];
  if (mid > 0) {
    parts.push(
      `[[omitted]] … ${mid} middle page${mid === 1 ? "" : "s"} left out to fit the context window …`,
    );
  }
  if (tail.length > 0) parts.push(tail.map(stitch).join("\n"));

  const excerpt = parts.join("\n");
  return {
    excerpt,
    totalChars,
    sentChars: excerpt.length,
    pagesTotal: norm.length,
    pagesIncluded: included.length + tail.length,
    omittedPages: mid,
  };
}

/**
 * Trust-nothing sanitizer for the message history the client posts (the API
 * re-validates with zod; this is the same contract client-side so honest
 * users never hit a 400 by accident, and crafted payloads get clamped twice).
 */
export function sanitizeChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const cap =
      role === "user"
        ? CHAT_LIMITS.userMessageChars
        : CHAT_LIMITS.assistantMessageChars;
    const cleaned = cleanUserText(content, cap);
    if (cleaned.length === 0) continue;
    out.push({ role, content: cleaned });
  }
  return out.slice(-CHAT_LIMITS.historyMessages);
}

/** A scanned PDF has (almost) no extractable text — honest OCR hand-off. */
export function isLikelyScanned(pages: ExtractedPage[]): boolean {
  if (!Array.isArray(pages) || pages.length === 0) return true;
  const total = pages.reduce(
    (n, p) => n + (typeof p?.text === "string" ? p.text.trim().length : 0),
    0,
  );
  return total < CHAT_LIMITS.scannedThresholdChars;
}

/* --------------------- R9-a: conversation export --------------------- */

export type ChatExportFormat = "markdown" | "txt";

/**
 * Localized labels the surface passes in — the model stays i18n-free so the
 * smoke can pin the structure without touching the catalog.
 */
export interface ChatExportLabels {
  title: string;
  document: string;
  generated: string;
  you: string;
  ai: string;
}

/** Display-safe header name for one document in an export / prompt section. */
export function cleanDocName(raw: string | undefined, cap = 80): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, cap) : "document";
}

/** Download-safe base name for the exported conversation file. */
export function chatExportBaseName(docNames: string[]): string {
  const base = docNames
    .map((n) => String(n ?? "").replace(/\.(pdf)$/i, ""))
    .join(" + ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base.slice(0, 100) : "document";
}

/** ISO-like local timestamp — deterministic, no locale drift in tests. */
export function exportStamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Formats the visible conversation for download. Markdown keeps **bold** and
 * (p. N) citations verbatim (they ARE markdown-ish); txt is plain and
 * readable anywhere. Returns "" when there is nothing worth exporting.
 */
export function buildChatExport(
  messages: ChatMessage[],
  docNames: string[],
  labels: ChatExportLabels,
  format: ChatExportFormat,
  date: Date = new Date(),
): string {
  const clean = sanitizeChatMessages(messages);
  if (clean.length === 0) return "";
  const names = (Array.isArray(docNames) ? docNames : [])
    .map((n) => cleanDocName(n))
    .filter((n) => n.length > 0);
  const docLine =
    names.length > 0 ? names.join(" + ") : "document";
  const stamp = exportStamp(date);

  if (format === "markdown") {
    const parts: string[] = [
      `# ${labels.title}`,
      "",
      `- **${labels.document}:** ${docLine}`,
      `- **${labels.generated}:** ${stamp}`,
      "",
      "---",
      "",
    ];
    for (const m of clean) {
      parts.push(`**${m.role === "user" ? labels.you : labels.ai}:**`);
      parts.push("");
      parts.push(m.content);
      parts.push("");
      parts.push("---");
      parts.push("");
    }
    parts.pop(); // trailing "---"
    parts.pop(); // trailing blank
    return parts.join("\n").replace(/\n+$/, "\n");
  }

  const parts: string[] = [
    labels.title,
    `${labels.document}: ${docLine}`,
    `${labels.generated}: ${stamp}`,
    "",
    "========================================",
    "",
  ];
  for (const m of clean) {
    parts.push(`[${m.role === "user" ? labels.you : labels.ai}]`);
    parts.push(m.content);
    parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/* ------------------- R9-b: multi-file excerpts ----------------------- */

export interface ChatDoc {
  name: string;
  pages: ExtractedPage[];
}

export interface MultiDocEntry extends DocExcerpt {
  name: string;
}

export interface MultiDocExcerpt {
  excerpt: string;
  docs: MultiDocEntry[];
  totalChars: number;
  sentChars: number;
  pagesIncluded: number;
  pagesOmitted: number;
}

/** Section header wrapping one document inside a multi-file excerpt. */
export function fileSectionHeader(name: string): string {
  return `=== FILE "${cleanDocName(name)}" ===`;
}

const FILE_SECTION_END = "=== END FILE ===";

/**
 * Multi-document excerpt with an even budget split and one honest
 * redistribution pass: every document gets an equal share of the context
 * window first; whatever the small documents leave unused is offered to the
 * trimmed documents in file order (each absorbs what it can).
 *
 * One document → EXACTLY buildDocExcerpt's output (no section headers), so
 * the single-file prompt path stays byte-identical. Returns null for an empty
 * or wholly invalid input.
 */
export function buildMultiDocExcerpt(
  docs: ChatDoc[],
  budget: number = CHAT_LIMITS.excerptBudget,
): MultiDocExcerpt | null {
  const valid = (Array.isArray(docs) ? docs : []).filter(
    (d): d is ChatDoc =>
      !!d && typeof d.name === "string" && Array.isArray(d.pages),
  );
  if (valid.length === 0) return null;

  const share = Math.max(
    pageMarker(1).length + 8,
    Math.floor(budget / valid.length),
  );

  const entries: MultiDocEntry[] = valid.map((d) => ({
    name: cleanDocName(d.name),
    ...buildDocExcerpt(d.pages, share),
  }));

  // Redistribution: leftover budget flows to trimmed docs in file order.
  const used = (): number =>
    entries.reduce((n, e) => n + e.sentChars, 0);
  for (let i = 0; i < entries.length; i += 1) {
    const extra = budget - used();
    if (extra <= 0) break;
    const e = entries[i];
    if (e.omittedPages === 0) continue;
    const retry = buildDocExcerpt(valid[i].pages, share + extra);
    entries[i] = { name: e.name, ...retry };
  }

  if (entries.length === 1) {
    const only = entries[0];
    return {
      excerpt: only.excerpt,
      docs: entries,
      totalChars: only.totalChars,
      sentChars: only.sentChars,
      pagesIncluded: only.pagesIncluded,
      pagesOmitted: only.omittedPages,
    };
  }

  const sections = entries.map(
    (e) => `${fileSectionHeader(e.name)}\n${e.excerpt}\n${FILE_SECTION_END}`,
  );
  const excerpt = sections.join("\n");
  return {
    excerpt,
    docs: entries,
    totalChars: entries.reduce((n, e) => n + e.totalChars, 0),
    sentChars: excerpt.length,
    pagesIncluded: entries.reduce((n, e) => n + e.pagesIncluded, 0),
    pagesOmitted: entries.reduce((n, e) => n + e.omittedPages, 0),
  };
}
