/**
 * Prepare PDF for AI (P2 / R54) — the PURE chunk + export engine.
 *
 * Turns extracted per-page text into LlamaIndex-style JSON: one Document
 * (id_ + full text + metadata) plus TextNodes (id_ + chunk text + page
 * metadata) sized by a token estimate (~4 chars = 1 token — the common
 * OpenAI-style heuristic). Chunks respect paragraph boundaries so RAG
 * retrieval gets semantically whole units; a paragraph longer than 3× the
 * target is hard-split at sentence boundaries rather than shipped as one
 * monster node. Optional overlap carries the previous chunk's tail
 * paragraphs forward so answers spanning a boundary stay retrievable.
 *
 * 100% deterministic: the clock is injected (smoke passes a fixed value).
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

export interface PageText {
  /** 1-based page number in the source PDF. */
  page: number;
  text: string;
}

export type PrepareFormat = "json" | "jsonl";

export interface PrepareAiOptions {
  format: PrepareFormat;
  /** Target chunk size in estimated tokens (chars/4). */
  chunkTokens: number;
  /** Overlap carried between consecutive chunks, in estimated tokens. */
  overlapTokens: number;
  /** Original file name (goes into metadata). */
  fileName: string;
  /** ISO timestamp — injected so smoke runs stay byte-deterministic. */
  now: string;
}

/** LlamaIndex TextNode shape (the fields RAG pipelines actually read). */
export interface AiNode {
  id_: string;
  text: string;
  metadata: {
    page: number;
    page_label: string;
    file_name: string;
    start_page: number;
    end_page: number;
    char_count: number;
    word_count: number;
    token_estimate: number;
  };
}

export interface PreparedAiDoc {
  id_: string;
  text: string;
  metadata: {
    file_name: string;
    page_count: number;
    char_count: number;
    word_count: number;
    token_estimate: number;
    chunk_count: number;
    chunk_tokens: number;
    overlap_tokens: number;
    language_hint: string;
    prepared_by: string;
    prepared_at: string;
  };
  nodes: AiNode[];
}

export const PREPARE_AI_BY = "DocoPDF prepare-pdf-for-ai";

/** Token estimate — the ~4-chars-per-token heuristic everyone uses. */
export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function wordCount(text: string): number {
  const m = text.match(/[\p{L}\p{M}\p{N}]+/gu);
  return m ? m.length : 0;
}

/**
 * Language hint from script ratios: Devanagari-heavy → "hi", Latin-heavy →
 * "en", both meaningful → "mixed", nothing readable → "".
 */
export function languageHint(text: string): string {
  const sample = text.slice(0, 20_000);
  const letters = sample.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return "";
  let deva = 0;
  let latin = 0;
  for (const ch of letters) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097f) deva += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      latin += 1;
  }
  const total = letters.length;
  const devaRatio = deva / total;
  const latinRatio = latin / total;
  if (devaRatio >= 0.25 && latinRatio >= 0.25) return "mixed";
  if (devaRatio >= 0.25) return "hi";
  if (latinRatio >= 0.25) return "en";
  return "";
}

/** Safe id from a file name (LlamaIndex id_ forbids spaces/slashes vibes). */
export function aiDocId(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "");
  const cleaned = base
    .replace(/[\\/:*?"<>|()\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : "document";
}

interface Paragraph {
  page: number;
  text: string;
}

function toParagraphs(pages: PageText[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of pages) {
    for (const raw of p.text.split(/\n{2,}/)) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length > 0) out.push({ page: p.page, text });
    }
  }
  return out;
}

/** Sentence-boundary split (bilingual: danda, ?!, and ASCII period). */
const SENTENCE_END = /([।.!?])(?=\s|$)/;

function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE_END);
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "।" || part === "." || part === "!" || part === "?") {
      buf += part;
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = "";
    } else {
      buf += part;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Hard-splits one oversized paragraph at sentence boundaries into pieces
 * that each fit the token target. A single sentence longer than the target
 * is shipped whole — never mangled mid-sentence.
 */
function splitOversized(para: Paragraph, chunkTokens: number): Paragraph[] {
  const sentences = splitSentences(para.text);
  const out: Paragraph[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const candidate = buf.length === 0 ? sentence : `${buf} ${sentence}`;
    if (buf.length > 0 && tokenEstimate(candidate) > chunkTokens) {
      out.push({ page: para.page, text: buf });
      buf = sentence;
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) out.push({ page: para.page, text: buf });
  return out.length > 0 ? out : [{ page: para.page, text: para.text }];
}

interface RawChunk {
  paragraphs: Paragraph[];
}

/**
 * Paragraph-boundary chunking:
 *  - accumulate paragraphs while the estimated token total stays ≤ target
 *    (a lone paragraph always lands somewhere — the target is soft);
 *  - a paragraph > 3× target is pre-split at sentence boundaries;
 *  - overlap: the next chunk starts with the tail paragraphs of the
 *    previous one until the overlap budget is spent.
 */
export function chunkParagraphs(
  pages: PageText[],
  chunkTokens: number,
  overlapTokens: number,
): RawChunk[] {
  const paragraphs: Paragraph[] = [];
  const limit = Math.max(3, chunkTokens);
  for (const para of toParagraphs(pages)) {
    if (tokenEstimate(para.text) > limit * 3) {
      paragraphs.push(...splitOversized(para, limit));
    } else {
      paragraphs.push(para);
    }
  }
  if (paragraphs.length === 0) return [];

  const chunks: RawChunk[] = [];
  let current: Paragraph[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const cost = tokenEstimate(para.text);
    if (current.length > 0 && currentTokens + cost > limit) {
      chunks.push({ paragraphs: current });
      // Overlap tail: walk the finished chunk from the end.
      const tail: Paragraph[] = [];
      let tailTokens = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const t = tokenEstimate(current[i].text);
        if (tailTokens + t > Math.max(0, overlapTokens)) break;
        tail.unshift(current[i]);
        tailTokens += t;
      }
      current = [...tail];
      currentTokens = tailTokens;
    }
    current.push(para);
    currentTokens += cost;
  }
  if (current.length > 0) chunks.push({ paragraphs: current });
  return chunks;
}

function nodeFromChunk(
  docId: string,
  index: number,
  paragraphs: Paragraph[],
  fileName: string,
): AiNode {
  const text = paragraphs.map((p) => p.text).join("\n\n");
  const start = paragraphs[0].page;
  const end = paragraphs[paragraphs.length - 1].page;
  return {
    id_: `${docId}-chunk-${String(index).padStart(3, "0")}`,
    text,
    metadata: {
      page: start,
      page_label: String(start),
      file_name: fileName,
      start_page: start,
      end_page: end,
      char_count: text.length,
      word_count: wordCount(text),
      token_estimate: tokenEstimate(text),
    },
  };
}

/** Builds the full LlamaIndex-style document from extracted page texts. */
export function buildPreparedDoc(
  pages: PageText[],
  options: PrepareAiOptions,
): PreparedAiDoc | null {
  const withText = pages.filter((p) => p.text.trim().length > 0);
  if (withText.length === 0) return null;

  const docId = aiDocId(options.fileName);
  const fullText = withText.map((p) => p.text.trim()).join("\n\n");
  const rawChunks = chunkParagraphs(
    withText,
    options.chunkTokens,
    options.overlapTokens,
  );
  const nodes = rawChunks.map((c, i) =>
    nodeFromChunk(docId, i, c.paragraphs, options.fileName),
  );

  return {
    id_: docId,
    text: fullText,
    metadata: {
      file_name: options.fileName,
      page_count: pages.length,
      char_count: fullText.length,
      word_count: wordCount(fullText),
      token_estimate: tokenEstimate(fullText),
      chunk_count: nodes.length,
      chunk_tokens: options.chunkTokens,
      overlap_tokens: options.overlapTokens,
      language_hint: languageHint(fullText),
      prepared_by: PREPARE_AI_BY,
      prepared_at: options.now,
    },
    nodes,
  };
}

/** Renders the export: full JSON document, or JSONL (one node per line). */
export function renderPrepared(
  doc: PreparedAiDoc,
  format: PrepareFormat,
): string {
  if (format === "jsonl") {
    return doc.nodes.map((node) => JSON.stringify(node)).join("\n") + "\n";
  }
  return JSON.stringify(doc, null, 2) + "\n";
}
