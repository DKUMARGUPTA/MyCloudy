/**
 * PRE-BUILD smoke test for the Search PDFs tool (P4.1 part 2).
 *
 * Pure-engine verification of the matcher contract the panel, the live
 * surface and the worker all share (tools/search-pdf/engine.ts):
 *
 *  1. text / case / wholeWord modes (incl. Unicode + Devanagari "नमस्ते")
 *  2. regex mode (case folding, invalid-regex typed error, zero-length safety)
 *  3. overlap policy: non-overlapping, left-to-right (adjacent matches)
 *  4. boundary cases: start/end of text, fold-length fallback (Turkish İ)
 *  5. snippet generation: context window, word-boundary cuts, whitespace-run
 *     collapse, ellipses, verbatim hit
 *  6. option normalization (context clamp 10..80, defaults, garbage)
 *  7. page-text joining (the shared worker/surface recipe)
 *  8. error classification + i18n en↔hi parity for the "search" section
 *
 * Run: bun scripts/smoke-search-pdf.ts   (fast, exits 0 on green)
 */
import {
  BadRegexError,
  buildMatcher,
  classifySearchError,
  CONTEXT_DEFAULT,
  CONTEXT_MAX,
  CONTEXT_MIN,
  findMatches,
  joinPageText,
  makeSnippet,
  MAX_MATCHES_PER_FILE,
  MAX_PREVIEW_MATCHES,
  newMatchBudget,
  PatternTooComplexError,
  REGEX_STEP_BUDGET,
  REGEX_TIME_BUDGET_MS,
  resolveSearchOptions,
  SEARCH_IDS,
  type Matcher,
} from "../tools/search-pdf/engine";
import i18n from "../tools/search-pdf/i18n.json";

let passed = 0;
let failed = 0;
let checkNo = 0;

function check(ok: boolean, label: string): void {
  checkNo += 1;
  if (ok) {
    passed += 1;
    console.log(`${checkNo}. PASS ${label}`);
  } else {
    failed += 1;
    console.error(`${checkNo}. FAIL ${label}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    ok,
    ok
      ? label
      : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

/** Build a text matcher with defaults, like the panel/worker do. */
function textMatcher(
  query: string,
  init?: { caseSensitive?: boolean; wholeWord?: boolean }
): Matcher {
  return buildMatcher(query, {
    mode: "text",
    caseSensitive: init?.caseSensitive === true,
    wholeWord: init?.wholeWord === true,
  });
}

function regexMatcher(
  query: string,
  init?: { caseSensitive?: boolean }
): Matcher {
  return buildMatcher(query, {
    mode: "regex",
    caseSensitive: init?.caseSensitive === true,
    wholeWord: true, // must be ignored by regex mode
  });
}

const LOREM = "The quick brown fox jumps over the lazy dog. The dog barks.";

/* ------------------------------------------------------------------ */
/* 1. Text + case + wholeWord                                         */
/* ------------------------------------------------------------------ */

eq(
  findMatches(LOREM, textMatcher("fox")),
  [{ index: 16, length: 3 }],
  "plain text match finds exact position"
);
eq(findMatches(LOREM, textMatcher("FOX")).length, 1, "case-insensitive by default");
eq(findMatches(LOREM, textMatcher("FOX", { caseSensitive: true })).length, 0, "caseSensitive rejects different case");
eq(findMatches(LOREM, textMatcher("fox", { caseSensitive: true })).length, 1, "caseSensitive accepts same case");
eq(
  findMatches(LOREM, textMatcher("the")).map((m) => m.index),
  [0, 31, 45],
  "case-insensitive across sentence starts"
);
eq(
  findMatches(LOREM, textMatcher("dog", { wholeWord: true })),
  [
    { index: 40, length: 3 },
    { index: 49, length: 3 },
  ],
  "wholeWord matches standalone words only"
);
eq(
  findMatches(LOREM, textMatcher("do", { wholeWord: true })).length,
  0,
  "wholeWord rejects prefix inside a word"
);
eq(
  findMatches(LOREM, textMatcher("do")).length,
  2,
  "without wholeWord, prefixes match"
);
eq(
  findMatches("cat, catalog", textMatcher("cat", { wholeWord: true })),
  [{ index: 0, length: 3 }],
  "wholeWord: punctuation is a boundary, letters are not"
);
eq(
  findMatches("cat1 cat", textMatcher("cat", { wholeWord: true })).map((m) => m.index),
  [5],
  "wholeWord: a following digit breaks the word"
);

/* ------------------------------------------------------------------ */
/* 2. Regex mode                                                      */
/* ------------------------------------------------------------------ */

eq(
  findMatches("abc 123 def 45", regexMatcher("\\d+")),
  [
    { index: 4, length: 3 },
    { index: 12, length: 2 },
  ],
  "regex \\d+ matches numbers"
);
eq(
  findMatches("hello WORLD", regexMatcher("HELLO|world")).length,
  2,
  "regex case-insensitive by default"
);
eq(
  findMatches("hello WORLD", regexMatcher("world", { caseSensitive: true })).length,
  0,
  "regex caseSensitive rejects"
);
eq(regexMatcher("x").wholeWord, false, "regex mode ignores wholeWord (matcher flag off)");
eq(
  findMatches("say hello and नमस्ते", regexMatcher("नमस्ते|hello")).map((m) => m.length),
  [5, 6],
  "regex alternation works with Devanagari"
);

// Invalid regex → the TYPED error the panel/worker surface as search.errorBadRegex.
{
  let caught: unknown = null;
  try {
    regexMatcher("(");
  } catch (error) {
    caught = error;
  }
  check(caught instanceof BadRegexError, "unbalanced ( throws BadRegexError");
  eq(caught instanceof Error && caught.name, "BadRegexError", "BadRegexError carries its name");
  check((caught as BadRegexError).message.length > 0, "BadRegexError carries the engine message");
}
{
  let caught = false;
  try {
    regexMatcher("a(?P<x>b)");
  } catch (error) {
    caught = error instanceof BadRegexError;
  }
  check(caught, "Python-style group (?P<…>) is rejected as BadRegexError");
}

// Zero-length regex matches are skipped — no hang, no phantom hits.
eq(findMatches("abc", regexMatcher("x*")).length, 0, "zero-length matches are skipped (no infinite loop)");
eq(findMatches("", regexMatcher("a+")).length, 0, "empty text matches nothing");
eq(findMatches("abc", textMatcher("")).length, 0, "empty text-mode query matches nothing");
eq(findMatches("abc", regexMatcher("")).length, 0, "empty regex query matches nothing");

/* ------------------------------------------------------------------ */
/* 3. Overlap policy: non-overlapping, left-to-right                  */
/* ------------------------------------------------------------------ */

eq(
  findMatches("aaaa", textMatcher("aa")),
  [
    { index: 0, length: 2 },
    { index: 2, length: 2 },
  ],
  "adjacent matches: aaaa/aa → two, non-overlapping"
);
eq(findMatches("aaa", textMatcher("aa")).length, 1, "aaa/aa → one (left-to-right wins)");
eq(
  findMatches("abab", textMatcher("ab")).map((m) => m.index),
  [0, 2],
  "alternating matches stay left-to-right"
);

/* ------------------------------------------------------------------ */
/* 4. Unicode + boundaries                                            */
/* ------------------------------------------------------------------ */

eq(
  findMatches("Café résumé", textMatcher("CAFÉ")),
  [{ index: 0, length: 4 }],
  "accented case folding (CAFÉ → café)"
);
eq(
  findMatches("यह नमस्ते है दोस्तों", textMatcher("नमस्ते")),
  [{ index: 3, length: 6 }],
  "Devanagari नमस्ते matches at the right code-unit index"
);
eq(
  findMatches("यह नमस्ते है", textMatcher("नमस्ते", { caseSensitive: true })).length,
  1,
  "Devanagari is caseless — caseSensitive is a no-op (honest)"
);
eq(
  findMatches("नमस्तेजी नमस्ते", textMatcher("नमस्ते", { wholeWord: true })),
  [{ index: 9, length: 6 }],
  "wholeWord respects Devanagari letter boundaries"
);
// Turkish dotted capital İ folds to TWO code units — the length-stable fold
// check degrades to case-sensitive matching instead of lying about indexes.
eq(
  findMatches("İstanbul", textMatcher("İstanbul")).length,
  1,
  "fold-length change (İ) falls back to case-sensitive, still finds"
);
eq(
  findMatches("İstanbul", textMatcher("i̇stanbul")).length,
  0,
  "pre-folded query misses İ via the case-sensitive fallback (documented limit)"
);

// Text mode is literal — regex metacharacters carry no meaning.
eq(
  findMatches("a.b axb", textMatcher("a.b")).map((m) => m.index),
  [0],
  "text mode treats . literally (no axb hit)"
);

/* ------------------------------------------------------------------ */
/* 5. Snippets                                                        */
/* ------------------------------------------------------------------ */

{
  const text = "aaaa bbbb cccc MATCH dddd eeee ffff";
  const snippet = makeSnippet(text, { index: 15, length: 5 }, 10);
  eq(snippet.before, "…bbbb cccc ", "snippet before: complete words kept + ellipsis");
  eq(snippet.hit, "MATCH", "snippet hit: verbatim");
  eq(snippet.after, " dddd eeee…", "snippet after: complete words kept + ellipsis");
}
{
  const text = "MATCH and then more words follow here";
  const snippet = makeSnippet(text, { index: 0, length: 5 }, 8);
  eq(snippet.before, "", "match at text start: no leading ellipsis");
  eq(snippet.after, " and…", "partial word at the right cut is dropped");
}
{
  const text = "the long tail ends with MATCH";
  const snippet = makeSnippet(text, { index: 24, length: 5 }, 80);
  eq(snippet.before, "the long tail ends with ", "big context keeps the whole left side");
  eq(snippet.after, "", "match at text end: no trailing ellipsis");
}
{
  const text = "a    b    MATCH    c    d";
  const snippet = makeSnippet(text, { index: 10, length: 5 }, 10);
  eq(snippet.before, "a b ", "whitespace runs >1 collapse to one space (before)");
  eq(snippet.after, " c d", "whitespace runs >1 collapse to one space (after)");
}
{
  const text = "line1\nline2 MATCH end";
  const snippet = makeSnippet(text, { index: 12, length: 5 }, 10);
  eq(snippet.before, "…line2 ", "partial word dropped at the newline cut");
}
{
  const text = "line1\nline2 MATCH";
  const snippet = makeSnippet(text, { index: 12, length: 5 }, 20);
  eq(snippet.before, "line1\nline2 ", "single newline survives when no left cut happens");
  check(!snippet.before.includes("  "), "no double spaces survive");
  eq(snippet.after, "", "text end reached: no ellipsis");
}
{
  const text = "supercalifragilistic MATCH";
  const snippet = makeSnippet(text, { index: 21, length: 5 }, 5);
  eq(snippet.before, "…", "mid-word cut with no boundary drops the partial word");
}
{
  const text = "aaaaaaaaaaMATCH end";
  const snippet = makeSnippet(text, { index: 10, length: 5 }, 3);
  eq(snippet.before, "…aaa", "no boundary available → keep the raw cut (honest)");
  eq(snippet.after, "…", "short right window ends mid-word → dropped");
}
{
  const snippet = makeSnippet("hit", { index: 0, length: 3 }, 40);
  eq(snippet, { before: "", hit: "hit", after: "" }, "whole-text hit: no ellipses at all");
}
{
  const snippet = makeSnippet("one MATCH two", { index: 4, length: 5 }, 0);
  eq(
    snippet,
    { before: "…", hit: "MATCH", after: "…" },
    "zero context still yields the hit + honest cut markers"
  );
}
{
  // A hit that itself contains spaces stays verbatim.
  const snippet = makeSnippet("prefix new york suffix", { index: 7, length: 8 }, 3);
  eq(snippet.hit, "new york", "multi-word hit stays verbatim");
  eq(snippet.before, "…", "partial prefix word dropped");
}

/* ------------------------------------------------------------------ */
/* 6. Option normalization                                            */
/* ------------------------------------------------------------------ */

eq(
  resolveSearchOptions({
    [SEARCH_IDS.query]: "invoice",
    [SEARCH_IDS.mode]: "regex",
    [SEARCH_IDS.caseSensitive]: true,
    [SEARCH_IDS.wholeWord]: true,
    [SEARCH_IDS.context]: 25,
  }),
  {
    query: "invoice",
    mode: "regex",
    caseSensitive: true,
    wholeWord: true,
    context: 25,
  },
  "resolveSearchOptions passes through valid values"
);
eq(resolveSearchOptions({}), {
  query: "",
  mode: "text",
  caseSensitive: false,
  wholeWord: false,
  context: CONTEXT_DEFAULT,
}, "resolveSearchOptions defaults");
eq(
  resolveSearchOptions({ [SEARCH_IDS.context]: 5 }).context,
  CONTEXT_MIN,
  "context clamps up to the minimum"
);
eq(
  resolveSearchOptions({ [SEARCH_IDS.context]: 500 }).context,
  CONTEXT_MAX,
  "context clamps down to the maximum"
);
eq(
  resolveSearchOptions({ [SEARCH_IDS.context]: "banana" }).context,
  CONTEXT_DEFAULT,
  "non-numeric context falls back to the default"
);
eq(
  resolveSearchOptions({ [SEARCH_IDS.mode]: "wildcard" }).mode,
  "text",
  "unknown mode falls back to text"
);
eq(
  resolveSearchOptions({ [SEARCH_IDS.caseSensitive]: "yes" }).caseSensitive,
  false,
  "non-boolean caseSensitive is false (strict)"
);
eq(MAX_MATCHES_PER_FILE, 500, "worker per-file cap is 500");
eq(MAX_PREVIEW_MATCHES, 50, "surface preview cap is 50");

/* ------------------------------------------------------------------ */
/* 7. Page-text joining                                               */
/* ------------------------------------------------------------------ */

eq(joinPageText([{ str: "Hello" }, { str: "world" }]), "Hello world", "items join with one space");
eq(
  joinPageText([{ str: "a  " }, { str: "b" }]),
  "a b",
  "double spaces from item seams collapse"
);
eq(
  joinPageText([{ str: "skip" }, { str: 7 }, { str: "" }, { str: "next" }]),
  "skip next",
  "non-string and empty items are skipped"
);
eq(joinPageText([]), "", "no items → empty string");
eq(joinPageText([{ str: "  padded  " }]), "padded", "leading/trailing whitespace is trimmed");
eq(
  joinPageText([{ str: "line", hasEOL: true }, { str: "two", hasEOL: false }]),
  "line two",
  "simplified join: hasEOL adds no newline (documented recipe)"
);

/* ------------------------------------------------------------------ */
/* 8. Error classification + i18n parity                              */
/* ------------------------------------------------------------------ */

eq(
  classifySearchError("PasswordException: No password given"),
  "tool.errorEncrypted",
  "password → encrypted"
);
eq(
  classifySearchError("Invalid PDF structure"),
  "tool.errorCorrupt",
  "parse → corrupt"
);

{
  const sections = i18n as {
    en: Record<string, Record<string, string>>;
    hi: Record<string, Record<string, string>>;
  };
  const enKeys = Object.keys(sections.en.search ?? {}).sort();
  const hiKeys = Object.keys(sections.hi.search ?? {}).sort();
  eq(enKeys.length > 0, true, "search.en section exists");
  eq(enKeys, hiKeys, "search en↔hi key parity");
  for (const key of ["errorEmptyQuery", "errorBadRegex", "errorPatternTooComplex", "openPage", "firstFileNote"]) {
    check(enKeys.includes(key), `search.${key} present`);
  }
}

/* ------------------------------------------------------------------ */
/* 9. ReDoS guard: per-page regex budget                              */
/* ------------------------------------------------------------------ */

{
  // A normal regex on a big page must NEVER trip the default budget
  // (no false positives — the cap is ~5× any realistic page text).
  const bigText = "a".repeat(50_000);
  const many = findMatches(bigText, regexMatcher("a"));
  eq(many.length, 50_000, "default budget: 50k one-char matches, no throw");
  eq(
    findMatches("needle in a haystack".repeat(2000), regexMatcher("haystack")).length,
    2000,
    "default budget: normal scan on ~42 KB text"
  );

  // Step budget exhaustion — deterministic, tiny custom budget.
  let threw: unknown = null;
  try {
    findMatches("a".repeat(100), regexMatcher("a"), {
      stepsLeft: 5,
      deadline: Date.now() + 10_000,
    });
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof PatternTooComplexError,
    "step budget exhaustion → PatternTooComplexError"
  );
  eq(threw instanceof Error && threw.name, "PatternTooComplexError", "typed error name");

  // Wall-clock deadline already in the past → fires on the first exec check.
  threw = null;
  try {
    findMatches("a".repeat(100), regexMatcher("a"), {
      stepsLeft: 1_000_000,
      deadline: Date.now() - 1,
    });
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof PatternTooComplexError,
    "expired deadline → PatternTooComplexError on the first check"
  );

  // A REAL slow (catastrophic-ish) pattern with a tiny injected deadline:
  // (a+)+b against 28 a's + 'c' backtracks ~2^27 ways inside exec #1
  // (hundreds of ms even on a fast engine — far past the 1 ms deadline),
  // so the check after that exec must refuse the rest of the page.
  threw = null;
  try {
    findMatches("a".repeat(28) + "c", regexMatcher("(a+)+b"), {
      stepsLeft: 1_000_000,
      deadline: Date.now() + 1,
    });
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof PatternTooComplexError,
    "slow backtracking pattern + tiny deadline → refused"
  );

  // Text mode is a linear indexOf scan — budget never applies.
  let textOk = true;
  try {
    findMatches(bigText, textMatcher("a"), {
      stepsLeft: 3,
      deadline: Date.now() - 1,
    });
  } catch {
    textOk = false;
  }
  check(textOk, "text mode ignores the budget (linear scan)");

  // Constants + error classification wiring.
  eq(REGEX_STEP_BUDGET, 2_000_000, "default step budget is 2M");
  eq(REGEX_TIME_BUDGET_MS, 2_000, "default time budget is 2s per page");
  const budget = newMatchBudget(77, 99);
  eq(
    budget.stepsLeft === 77 && budget.deadline > Date.now() + 50,
    true,
    "newMatchBudget carries the caps"
  );
  eq(
    classifySearchError("PatternTooComplexError: pattern too complex"),
    "search.errorPatternTooComplex",
    "classifySearchError maps the guard message"
  );
}

console.log(`\n${passed} passed, ${failed} failed (of ${checkNo})`);
if (failed > 0) process.exit(1);
