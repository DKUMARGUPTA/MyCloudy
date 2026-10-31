/**
 * Ask PDF (chat-with-pdf, P2 / R54) — the PURE BM25 retrieval engine,
 * rebuilt self-dependent: NO LLM, NO network, NO provider. The document's
 * paragraphs become a passage index; queries run classic Okapi BM25 and
 * return ranked snippets with page numbers. Search-grade, honestly named —
 * the surface never claims conversation.
 *
 * Bilingual: tokenization is script-agnostic (\p{L}\p{N}), stopwords cover
 * English + Hindi, snippets highlight matched terms in either script.
 * Deterministic — bun-testable pure functions only.
 */

import type { PageText } from "../prepare-pdf-for-ai/worker-lib";

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/** Max characters of one passage — longer paragraphs split at sentences. */
export const MAX_PASSAGE_CHARS = 1600;

export interface Passage {
  /** 0-based passage id within the index. */
  id: number;
  /** 1-based source page. */
  page: number;
  text: string;
}

export interface Bm25Index {
  passages: Passage[];
  /** Per-passage term frequencies. */
  termFreqs: Map<string, number>[];
  lengths: number[];
  avgLength: number;
  /** Term → number of passages containing it. */
  docFreq: Map<string, number>;
}

export interface SearchHit {
  passageId: number;
  page: number;
  text: string;
  score: number;
}

const EN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
  "with", "as", "by", "at", "from", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "he", "she", "they",
  "we", "you", "i", "his", "her", "their", "our", "your", "my", "me", "him",
  "them", "us", "not", "no", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "what",
  "which", "who", "whom", "when", "where", "why", "how",
]);

const HI_STOPWORDS = new Set([
  "और", "या", "लेकिन", "का", "की", "के", "को", "में", "पर", "से", "भी", "यह",
  "वह", "ये", "वे", "है", "हैं", "था", "थे", "थी", "हो", "होता", "होती",
  "होते", "कर", "करना", "किया", "नहीं", "एक", "कोई", "सब", "कुछ", "जो",
  "तो", "ही", "तक", "हम", "आप", "मैं", "क्या", "कैसे", "कब", "कहाँ",
]);

/** Script-agnostic word tokens (Latin + Devanagari + digits + combining
 * marks — \p{M} keeps matras inside the word: "लाख" stays one token). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Query tokens: stopword-filtered, with a raw fallback for tiny queries. */
export function queryTokens(query: string): string[] {
  const raw = tokenize(query);
  const kept = raw.filter(
    (w) => !EN_STOPWORDS.has(w) && !HI_STOPWORDS.has(w) && w.length > 1,
  );
  return kept.length > 0 ? kept : raw;
}

const SENTENCE_END = /([।.!?])(?=\s|$)/;

function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE_END);
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
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
 * Pages → passages: each paragraph is one retrieval unit; paragraphs longer
 * than MAX_PASSAGE_CHARS split at sentence boundaries (every piece keeps
 * its page). Deterministic order (page, then document order).
 */
export function buildPassages(pages: PageText[]): Passage[] {
  const out: Passage[] = [];
  let id = 0;
  for (const p of pages) {
    for (const raw of p.text.split(/\n{2,}/)) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;
      if (text.length <= MAX_PASSAGE_CHARS) {
        out.push({ id: id++, page: p.page, text });
        continue;
      }
      let buf = "";
      for (const sentence of splitSentences(text)) {
        const candidate = buf.length === 0 ? sentence : `${buf} ${sentence}`;
        if (buf.length > 0 && candidate.length > MAX_PASSAGE_CHARS) {
          out.push({ id: id++, page: p.page, text: buf });
          buf = sentence;
        } else {
          buf = candidate;
        }
      }
      if (buf.length > 0) out.push({ id: id++, page: p.page, text: buf });
    }
  }
  return out;
}

/** Builds the BM25 index over the document's passages. */
export function buildIndex(pages: PageText[]): Bm25Index {
  const passages = buildPassages(pages);
  const termFreqs: Map<string, number>[] = [];
  const lengths: number[] = [];
  const docFreq = new Map<string, number>();

  for (const passage of passages) {
    const tf = new Map<string, number>();
    for (const token of tokenize(passage.text)) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    termFreqs.push(tf);
    lengths.push(tf.size);
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const total = lengths.reduce((a, b) => a + b, 0);
  const avgLength = lengths.length > 0 ? total / lengths.length : 0;

  return { passages, termFreqs, lengths, avgLength, docFreq };
}

/** Okapi IDF: ln(1 + (N - df + 0.5) / (df + 0.5)) — always positive. */
function idf(index: Bm25Index, term: string): number {
  const n = index.passages.length;
  const df = index.docFreq.get(term) ?? 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export interface SearchOptions {
  limit?: number;
}

/**
 * Classic Okapi BM25 over the passage index. Returns hits sorted by score
 * (desc), then passage id (asc) for determinism. Empty/no-match queries
 * return an empty array — the surface shows the honest "no matches" state.
 */
export function bm25Search(
  index: Bm25Index,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = Math.max(1, Math.min(20, options.limit ?? 8));
  const terms = queryTokens(query);
  if (terms.length === 0 || index.passages.length === 0) return [];

  const hits: SearchHit[] = [];
  for (let i = 0; i < index.passages.length; i += 1) {
    const tf = index.termFreqs[i]!;
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      matched += 1;
      const len = index.lengths[i]!;
      const denom =
        f + BM25_K1 * (1 - BM25_B + BM25_B * (len / (index.avgLength || 1)));
      score += idf(index, term) * ((f * (BM25_K1 + 1)) / denom);
    }
    if (matched > 0) {
      hits.push({
        passageId: i,
        page: index.passages[i]!.page,
        text: index.passages[i]!.text,
        score,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.passageId - b.passageId);
  return hits.slice(0, limit);
}

/** One highlighted run inside a snippet. */
export interface SnippetRun {
  text: string;
  hit: boolean;
}

/**
 * Builds a windowed snippet around the query's terms: every matched term
 * becomes a hit run, and the window starts at the first match with
 * head/tail ellipses. Pure — the surface just renders the runs.
 */
export function buildSnippet(
  passageText: string,
  query: string,
  maxChars = 320,
): SnippetRun[] {
  const terms = new Set(queryTokens(query));
  if (terms.size === 0) {
    return [{ text: passageText.slice(0, maxChars), hit: false }];
  }

  const words = passageText.split(/(\s+)/); // keep whitespace tokens
  const isMatch = (word: string): boolean => {
    const cleaned = word.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
    return cleaned.length > 0 && terms.has(cleaned);
  };

  const firstMatch = words.findIndex(isMatch);
  const start = firstMatch < 0 ? 0 : Math.max(0, firstMatch - 24);

  const runs: SnippetRun[] = [];
  let used = 0;
  let buf = "";
  let bufHit = false;
  let lastIdx = start - 1;
  const flush = (): void => {
    if (buf.length > 0) runs.push({ text: buf, hit: bufHit });
    buf = "";
  };

  for (let i = start; i < words.length && used < maxChars; i += 1) {
    const word = words[i]!;
    const hit = isMatch(word);
    if (buf.length > 0 && hit !== bufHit) {
      flush();
      bufHit = hit;
    } else {
      bufHit = hit;
    }
    buf += word;
    used += word.length;
    lastIdx = i;
  }
  flush();

  if (runs.length === 0) return [{ text: passageText.slice(0, maxChars), hit: false }];
  if (start > 0) runs.unshift({ text: "…", hit: false });
  if (lastIdx < words.length - 1) runs.push({ text: "…", hit: false });
  return runs;
}
