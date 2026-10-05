import type { ToolDef } from "@/lib/tools/registry";
import { ALL_TOOLS, getCategory } from "@/lib/tools/registry";
import type { Locale } from "@/i18n";

/**
 * Client-side fuzzy search over the tool registry (PRD §5.1).
 * Self-written scorer — no external search library, no network.
 *
 * Per query term (AND across terms), against each field:
 *  1. Exact equality -> 1.0
 *  2. Full-text substring -> 0.95 (prefix) / 0.85 — handles partial
 *     words like "passw" or "comp".
 *  3. Word-level bigram Dice with a length-ratio guard (0.6..1.6) —
 *     typo tolerance ("merg" vs "merge" = 0.86) without cross-word noise
 *     ("password" vs "Word to PDF" scores 0 and is excluded).
 *
 * Fields weighted: name 3.0, tags 2.0, slug 1.6, description 1.0,
 * category name 1.0. Devanagari works natively via bigrams; Hindi tags
 * additionally carry Latin transliterations for Hinglish queries.
 */

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/** Unpadded bigrams — used per word to avoid cross-word noise. */
function bigrams(text: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    result.push(text.slice(i, i + 2));
  }
  return result;
}

function diceCoefficient(query: string, target: string): number {
  const queryBigrams = bigrams(query);
  const targetBigrams = bigrams(target);
  if (queryBigrams.length === 0 || targetBigrams.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of targetBigrams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of queryBigrams) {
    const available = counts.get(gram) ?? 0;
    if (available > 0) {
      overlap += 1;
      counts.set(gram, available - 1);
    }
  }
  return (2 * overlap) / (queryBigrams.length + targetBigrams.length);
}

const LENGTH_RATIO_MIN = 0.6;
const LENGTH_RATIO_MAX = 1.6;
const MIN_WORD_LENGTH = 3;

/** Score one query term against one field target (0..1). */
function termScore(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;

  if (t === q) return 1;

  // Word-boundary substring checks — so "word" does NOT match inside
  // "password", while "passw" still prefix-matches "password".
  for (const word of t.split(/\s+/)) {
    if (word === q) return 1;
    if (q.length >= 2 && word.startsWith(q)) return 0.95;
    if (word.includes(q) && q.length / word.length >= 0.6) return 0.85;
  }

  // Word-level fuzzy comparison with a length guard: a typo of a word has
  // a similar length, so wildly different lengths cannot be typos of each
  // other ("word" cannot be a typo of "password").
  let best = 0;
  for (const word of t.split(/\s+/)) {
    if (word.length < MIN_WORD_LENGTH) continue;
    const ratio = q.length / word.length;
    if (ratio < LENGTH_RATIO_MIN || ratio > LENGTH_RATIO_MAX) continue;
    best = Math.max(best, diceCoefficient(q, word));
  }
  return best;
}

interface SearchFields {
  name: string;
  tags: string;
  slug: string;
  description: string;
  category: string;
}

function fieldsFor(tool: ToolDef, locale: Locale): SearchFields {
  const category = getCategory(tool.category);
  return {
    name: tool.name[locale],
    tags: [...tool.tags.en, ...tool.tags.hi].join(" "),
    slug: tool.id.replace(/-/g, " "),
    description: tool.description[locale],
    category: category.name[locale],
  };
}

const WEIGHTS: Record<keyof SearchFields, number> = {
  name: 3,
  tags: 2,
  slug: 1.6,
  description: 1,
  category: 1,
};

export interface ToolMatch {
  tool: ToolDef;
  score: number;
}

/** Minimum per-term score required for a match (tunes precision/recall). */
const TERM_THRESHOLD = 0.35;

/** Fuzzy-search the registry; empty query returns [] (caller shows popular). */
export function searchTools(query: string, locale: Locale): ToolMatch[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const matches: ToolMatch[] = [];
  for (const tool of ALL_TOOLS) {
    const fields = fieldsFor(tool, locale);
    let total = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      let best = 0;
      let bestWeight = 0;
      for (const key of Object.keys(WEIGHTS) as (keyof SearchFields)[]) {
        const score = termScore(term, fields[key]);
        if (score > best) {
          best = score;
          bestWeight = WEIGHTS[key];
        }
      }
      if (best >= TERM_THRESHOLD) matchedTerms += 1;
      total += best * bestWeight;
    }
    if (matchedTerms === terms.length && total > 0) {
      matches.push({ tool, score: total + tool.popularity / 1000 });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}
