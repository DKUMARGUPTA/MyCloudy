/**
 * Summarize PDF (P2 / R54) — the PURE TextRank engine, rebuilt
 * self-dependent: NO LLM, NO network, NO provider. Sentences are scored
 * by classic TextRank (Mihalcea–Tarau): word-overlap similarity graph +
 * power iteration, then the top sentences are returned VERBATIM in
 * original reading order with page citations. Extractive only — honest
 * copy says so; nothing is rewritten or invented.
 *
 * Bilingual from the ground up: sentence boundaries include the Devanagari
 * danda (।), tokenization is script-agnostic (\p{L}\p{N}), stopwords cover
 * English + Hindi. Deterministic — bun-testable pure functions only.
 */

import type { PageText } from "../prepare-pdf-for-ai/worker-lib";

export type { PageText };

export type SummaryLength = "brief" | "standard" | "detailed";

export const SUMMARY_LENGTHS: SummaryLength[] = [
  "brief",
  "standard",
  "detailed",
];

/** Word targets per length — same bands the old provider tool used. */
export const SUMMARY_TARGET_WORDS: Record<SummaryLength, [number, number]> = {
  brief: [120, 180],
  standard: [280, 420],
  detailed: [500, 700],
};

/** Sentences shorter/longer than this are excluded from ranking. */
const MIN_WORDS = 4;
const MAX_WORDS = 80;

const EN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
  "with", "as", "by", "at", "from", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "he", "she", "they",
  "we", "you", "i", "his", "her", "their", "our", "your", "my", "me", "him",
  "them", "us", "not", "no", "nor", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "than", "then", "so", "such", "only", "own", "same", "too", "very", "just",
  "also", "more", "most", "other", "some", "any", "each", "few", "all", "both",
  "what", "which", "who", "whom", "when", "where", "why", "how", "there",
  "here", "about", "into", "over", "after", "before", "between", "under",
  "above", "out", "off", "up", "down", "again", "further", "once",
]);

const HI_STOPWORDS = new Set([
  "और", "या", "लेकिन", "का", "की", "के", "को", "में", "पर", "से", "भी", "यह",
  "वह", "ये", "वे", "है", "हैं", "था", "थे", "थी", "हो", "होता", "होती",
  "होते", "कर", "करना", "किया", "करते", "करती", "नहीं", "एक", "कोई", "सब",
  "कुछ", "जो", "तो", "ही", "तक", "अपने", "अपनी", "हम", "आप", "मैं", "मेरा",
  "मेरी", "तुम", "उस", "इस", "उन", "इन", "क्या", "कैसे", "कब", "कहाँ",
  "अथवा", "तथा", "एवं", "यदि", "तत्पश्चात", "द्वारा", "साथ", "सभी", "होगा",
  "होगी", "रहा", "रही", "रहे", "गया", "गयी", "गए", "लिए", "वाले", "वाली",
]);

export interface RankedSentence {
  /** Verbatim sentence text from the document. */
  text: string;
  /** 1-based source page. */
  page: number;
  /** Global position across the document (for reading-order restore). */
  index: number;
  /** TextRank score (higher = more central). */
  score: number;
  words: number;
}

export interface ExtractiveSummary {
  /** The TL;DR sentence(s) — highest-ranked, reading order. */
  tldr: RankedSentence[];
  /** Supporting key points, reading order. */
  keyPoints: RankedSentence[];
  stats: {
    pages: number;
    sentencesConsidered: number;
    wordsTotal: number;
    wordsSelected: number;
  };
}

/** Abbreviations that must not end a sentence when followed by a period. */
const ABBREV = /^(mr|mrs|ms|dr|sr|jr|st|vs|etc|e\.g|i\.e|fig|no|vol|approx|dept|est|inc|ltd|govt|prof)$/i;

/**
 * Bilingual sentence split: ASCII period, ?, ! and the Devanagari danda ।
 * end a sentence when followed by whitespace/end — except protected
 * abbreviations (Mr. Smith) and decimals (3.14). Returns sentences with
 * their 1-based source page.
 */
export function splitSentences(pages: PageText[]): RankedSentence[] {
  const out: RankedSentence[] = [];
  let index = 0;
  for (const p of pages) {
    const text = p.text.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    let buf = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      buf += ch;
      if (ch !== "." && ch !== "?" && ch !== "!" && ch !== "।") continue;
      // Lookahead: boundary only when whitespace or end follows.
      const next = text[i + 1];
      if (next !== undefined && next !== " ") continue;
      // Period protections: abbreviation before, digit after previous char.
      if (ch === ".") {
        const lastWord = buf.slice(0, -1).split(" ").pop() ?? "";
        if (ABBREV.test(lastWord)) continue;
      }
      const sentence = buf.trim();
      buf = "";
      if (sentence.length > 0) {
        out.push({ text: sentence, page: p.page, index, score: 0, words: 0 });
        index += 1;
      }
    }
    const tail = buf.trim();
    if (tail.length > 0) {
      out.push({ text: tail, page: p.page, index, score: 0, words: 0 });
      index += 1;
    }
  }
  return out;
}

/** Script-agnostic word tokens (Latin + Devanagari + digits + combining marks —\n * \p{M} keeps matras inside the word: "लाख" stays one token). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function contentTokens(text: string): string[] {
  return tokenize(text).filter(
    (w) => !EN_STOPWORDS.has(w) && !HI_STOPWORDS.has(w) && w.length > 1,
  );
}

/**
 * TextRank similarity: word overlap normalized by sentence lengths
 * (Mihalcea–Tarau original): |S1 ∩ S2| / (log|S1| + log|S2|).
 */
function similarity(a: Set<string>, b: Set<string>, la: number, lb: number): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const w of a) if (b.has(w)) overlap += 1;
  if (overlap === 0) return 0;
  const denom = Math.log(la) + Math.log(lb);
  return denom > 0 ? overlap / denom : overlap;
}

export const TEXTRANK_ITERATIONS = 25;
export const TEXTRANK_DAMPING = 0.85;

/**
 * Power iteration over the similarity graph. Returns scores indexed to the
 * input array. Deterministic — uniform start vector, fixed iteration count.
 */
export function textRankScores(
  tokenSets: Set<string>[],
  wordCounts: number[],
): number[] {
  const n = tokenSets.length;
  if (n === 0) return [];
  const scores = new Array<number>(n).fill(1 / n);

  // Sparse edge list built once: [i, j, weight].
  const edges: [number, number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const w = similarity(tokenSets[i], tokenSets[j], wordCounts[i], wordCounts[j]);
      if (w > 0) {
        edges.push([i, j, w]);
        edges.push([j, i, w]);
      }
    }
  }
  // Edge weights per node + out-degree normalization denominator.
  const weightSum = new Array<number>(n).fill(0);
  for (const [, j, w] of edges) weightSum[j] += w;

  for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter += 1) {
    const next = new Array<number>(n).fill(1 - TEXTRANK_DAMPING);
    for (const [i, j, w] of edges) {
      if (weightSum[i] > 0) {
        next[j] += (TEXTRANK_DAMPING * w * scores[i]) / weightSum[i];
      }
    }
    scores.splice(0, n, ...next);
  }
  return scores;
}

function dedupeByKey(sents: RankedSentence[]): RankedSentence[] {
  const seen = new Set<string>();
  const out: RankedSentence[] = [];
  for (const s of sents) {
    const key = tokenize(s.text).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Builds the extractive summary: rank all eligible sentences, pick until
 * the word target for the requested length is reached, restore reading
 * order. The single best sentence opens as TL;DR; the rest are key points.
 * Returns null when there is nothing to summarize.
 */
export function buildExtractiveSummary(
  pages: PageText[],
  length: SummaryLength,
): ExtractiveSummary | null {
  const withText = pages.filter((p) => p.text.trim().length > 0);
  if (withText.length === 0) return null;

  const all = splitSentences(withText);
  if (all.length === 0) return null;

  const wordsTotal = tokenize(
    withText.map((p) => p.text).join(" "),
  ).length;

  // Eligibility: sentence length sanity + no near-duplicates.
  const eligible = dedupeByKey(
    all.filter((s) => {
      s.words = tokenize(s.text).length;
      return s.words >= MIN_WORDS && s.words <= MAX_WORDS;
    }),
  );
  // Nothing eligible (e.g. a poster of one-word lines): fall back to all.
  const pool = eligible.length > 0 ? eligible : all;

  const tokenSets = pool.map((s) => new Set(contentTokens(s.text)));
  const wordCounts = pool.map((s) => Math.max(1, s.words));
  const scores = textRankScores(tokenSets, wordCounts);
  pool.forEach((s, i) => {
    s.score = scores[i] ?? 0;
  });

  const [minWords, maxWords] = SUMMARY_TARGET_WORDS[length];
  const ranked = [...pool].sort((a, b) => b.score - a.score);

  const selected: RankedSentence[] = [];
  let words = 0;
  for (const s of ranked) {
    if (selected.length > 0 && words + s.words > maxWords) continue;
    selected.push(s);
    words += s.words;
    if (words >= minWords) break;
  }
  if (selected.length === 0 && ranked.length > 0) selected.push(ranked[0]);

  // Reading order for both groups.
  selected.sort((a, b) => a.index - b.index);
  const tldr = selected.slice(0, selected.length === 1 ? 1 : 2);
  const keyPoints = selected.slice(tldr.length);

  return {
    tldr,
    keyPoints,
    stats: {
      pages: pages.length,
      sentencesConsidered: pool.length,
      wordsTotal,
      wordsSelected: words,
    },
  };
}

export interface SummaryRenderLabels {
  title: string;
  extractiveNote: string;
  tldr: string;
  keyPoints: string;
  stats: string;
  statsLine: (s: ExtractiveSummary["stats"]) => string;
  method: string;
}

export const SUMMARY_LABELS_EN: SummaryRenderLabels = {
  title: "Summary",
  extractiveNote:
    "Extractive summary — every sentence below is verbatim from your document, ranked by TextRank. Nothing is rewritten or invented.",
  tldr: "TL;DR",
  keyPoints: "Key points",
  stats: "Document stats",
  statsLine: (s) =>
    `Pages: ${s.pages} · Words in document: ${s.wordsTotal} · Sentences considered: ${s.sentencesConsidered} · Words selected: ${s.wordsSelected}`,
  method: "Method: TextRank (unsupervised graph ranking, 100% on-device)",
};

/** Markdown report — TL;DR + bullet key points with (p. N) citations. */
export function renderSummaryMarkdown(
  summary: ExtractiveSummary,
  fileName: string,
  labels: SummaryRenderLabels = SUMMARY_LABELS_EN,
): string {
  const lines: string[] = [];
  lines.push(`# ${labels.title} — ${fileName}`);
  lines.push("");
  lines.push(`> ${labels.extractiveNote}`);
  lines.push("");
  lines.push(`## ${labels.tldr}`);
  lines.push("");
  for (const s of summary.tldr) {
    lines.push(`${s.text} *(p. ${s.page})*`);
    lines.push("");
  }
  if (summary.keyPoints.length > 0) {
    lines.push(`## ${labels.keyPoints}`);
    lines.push("");
    for (const s of summary.keyPoints) {
      lines.push(`- ${s.text} *(p. ${s.page})*`);
    }
    lines.push("");
  }
  lines.push(`## ${labels.stats}`);
  lines.push("");
  lines.push(labels.statsLine(summary.stats));
  lines.push("");
  lines.push(labels.method);
  lines.push("");
  return lines.join("\n");
}

/** Plain-text report (same content, no markup). */
export function renderSummaryPlainText(
  summary: ExtractiveSummary,
  fileName: string,
  labels: SummaryRenderLabels = SUMMARY_LABELS_EN,
): string {
  const lines: string[] = [];
  lines.push(`${labels.title} — ${fileName}`);
  lines.push("");
  lines.push(labels.extractiveNote);
  lines.push("");
  lines.push(`${labels.tldr}:`);
  lines.push("");
  for (const s of summary.tldr) {
    lines.push(`${s.text} (p. ${s.page})`);
  }
  lines.push("");
  if (summary.keyPoints.length > 0) {
    lines.push(`${labels.keyPoints}:`);
    lines.push("");
    for (const s of summary.keyPoints) {
      lines.push(`- ${s.text} (p. ${s.page})`);
    }
    lines.push("");
  }
  lines.push(labels.statsLine(summary.stats));
  lines.push("");
  lines.push(labels.method);
  lines.push("");
  return lines.join("\n");
}
