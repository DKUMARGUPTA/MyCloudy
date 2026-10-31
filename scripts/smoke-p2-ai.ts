/**
 * Smoke: P2 AI differentiators (R54) — the self-dependent rebuild.
 *
 *   0. Wiring: registry counts 124 total / 123 live / 1 deferred AI
 *      (translate only); configs + seo entries; ask.* i18n keys en+hi
 *      parity with real Devanagari; ZERO provider fetches in the three
 *      tools; /api/chat + /api/summarize retired; old provider-era
 *      surfaces/models/api-models deleted.
 *   1. TextRank engine (PURE, summarize-pdf/worker-lib): bilingual
 *      sentence split (danda + abbreviation protection), script-agnostic
 *      tokenize, deterministic power iteration, ranking sanity (the
 *      central sentence beats boilerplate), citations + reading order,
 *      Markdown + TXT renders.
 *   2. BM25 engine (PURE, chat-with-pdf/worker-lib): passage building
 *      (paragraph boundaries + page tracking + oversized split), index,
 *      query ranking (relevant passage first), stopword handling,
 *      no-match → empty, snippet runs with highlights + ellipses,
 *      determinism.
 *   3. Chunker (PURE, prepare-pdf-for-ai/worker-lib): token estimates,
 *      target sizing, overlap carry, page map integrity, LlamaIndex JSON
 *      shape (id_ / text / metadata / nodes), language hints
 *      (en / hi / mixed), JSON + JSONL renders, oversized paragraph split.
 *   4. Worker sources: reference the pure engines, errorNoText honest
 *      refusals present, zero network calls in workers.
 *
 * Run: bun scripts/smoke-p2-ai.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildExtractiveSummary,
  renderSummaryMarkdown,
  renderSummaryPlainText,
  splitSentences,
  SUMMARY_TARGET_WORDS,
  tokenize,
  textRankScores,
  type PageText,
} from "../tools/summarize-pdf/worker-lib";
import {
  bm25Search,
  buildIndex,
  buildPassages,
  buildSnippet,
  queryTokens,
} from "../tools/chat-with-pdf/worker-lib";
import {
  aiDocId,
  buildPreparedDoc,
  chunkParagraphs,
  languageHint,
  renderPrepared,
  tokenEstimate,
  wordCount,
  type PageText as PrepPage,
} from "../tools/prepare-pdf-for-ai/worker-lib";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}
function read(p: string): string {
  return readFileSync(join(process.cwd(), p), "utf8");
}

/* --------------------------- fixtures ---------------------------- */

/** Bilingual multi-page document with a clear central topic. */
const DOC_PAGES: PageText[] = [
  {
    page: 1,
    text: `Quarterly Business Review — Q3 2026.

This report presents the quarterly business review for the third quarter of 2026. Revenue grew 18 percent year over year, driven mainly by the enterprise segment. The board met on 12 October to approve the plan.`,
  },
  {
    page: 2,
    text: `Financial highlights.

Revenue reached 42.7 million dollars, up from 36.1 million in the same quarter last year. Operating margin improved to 14 percent. The enterprise segment contributed 61 percent of total revenue, a record share. Customer churn fell to 2.1 percent, the lowest in eight quarters.`,
  },
  {
    page: 3,
    text: `Product and operations.

The new analytics platform shipped to general availability in August. Adoption reached 40 percent of eligible accounts within six weeks. Support response times improved by 23 percent after the staffing changes. हिन्दी अनुभाग: इस तिमाही में कंपनी का राजस्व 18 प्रतिशत बढ़ा। एंटरप्राइज़ खंड ने कुल आय का 61 प्रतिशत योगदान दिया।`,
  },
];

const CENTRAL_SENTENCE =
  "The enterprise segment contributed 61 percent of total revenue, a record share.";

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const registry = read("src/lib/tools/registry.ts");
  const configs = read("src/lib/tools/configs.ts");
  const seo = read("src/lib/seo/tool-seo.ts");
  const ids = ["summarize-pdf", "chat-with-pdf", "prepare-pdf-for-ai"];
  for (const id of ids) {
    check(`registry def: ${id}`, registry.includes(`id: "${id}"`));
    check(`configs map: ${id}`, configs.includes(id));
    check(`seo curated: ${id}`, seo.includes(`"${id}": {`));
  }
  check(
    "registry: no aiDependent on summarize + chat (self-dependent now)",
    !/id: "summarize-pdf",[\s\S]{0,400}?aiDependent/.test(registry) &&
      !/id: "chat-with-pdf",[\s\S]{0,400}?aiDependent/.test(registry),
  );
  check(
    "registry: translate-pdf still deferred aiDependent",
    /id: "translate-pdf",[\s\S]{0,400}?aiDependent: true/.test(registry),
  );

  const en = JSON.parse(read("src/i18n/en.json")) as Record<
    string,
    Record<string, string>
  >;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Record<
    string,
    Record<string, string>
  >;
  const enAsk = en.ask ?? {};
  const hiAsk = hi.ask ?? {};
  check(
    "i18n: ask.* key parity en=hi",
    Object.keys(enAsk).length === Object.keys(hiAsk).length &&
      Object.keys(enAsk).every((k) => k in hiAsk),
    `${Object.keys(enAsk).length} keys`,
  );
  check(
    "i18n: ask.hi is real Devanagari",
    /[\u0900-\u097F]/.test(hiAsk.heroTitle ?? "") &&
      /[\u0900-\u097F]/.test(hiAsk.noMatchesBody ?? ""),
  );
  check(
    "i18n: old chat.*/summarize.* groups retired",
    !("chat" in en) && !("summarize" in en) && !("chat" in hi) && !("summarize" in hi),
  );

  // Zero provider traffic in the three tools.
  for (const id of ids) {
    const dir = `tools/${id}`;
    let all = "";
    for (const f of ["config.ts", "worker.ts", "worker-lib.ts", "surface.tsx"]) {
      try {
        all += read(`${dir}/${f}`);
      } catch {
        /* optional file */
      }
    }
    check(
      `${id}: zero fetch/api calls (self-dependent)`,
      !/fetch\(|XMLHttpRequest|\/api\/(chat|summarize|translate)/.test(all),
    );
    check(
      `${id}: zero z-ai imports`,
      !/z-ai-web-dev-sdk|zai-client/.test(all),
    );
  }

  check(
    "routes: /api/chat + /api/summarize retired",
    !exists("src/app/api/chat/route.ts") &&
      !exists("src/app/api/summarize/route.ts"),
  );
  check(
    "cleanup: provider-era surfaces/models deleted",
    !exists("tools/summarize-pdf/surface.tsx") &&
      !exists("tools/summarize-pdf/model.ts") &&
      !exists("tools/chat-with-pdf/model.ts") &&
      !exists("tools/chat-with-pdf/api-model.ts"),
  );
  check(
    "translate route stays (still provider-backed, deferred)",
    exists("src/app/api/translate/route.ts"),
  );

  const { ALL_TOOLS } = await import("../src/lib/tools/registry");
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 124 total / 123 live / 1 deferred AI (translate)",
    ALL_TOOLS.length === 124 && live === 123 && deferred.join(",") === "translate-pdf",
    { total: ALL_TOOLS.length, live, deferred },
  );
  check(
    "chat-with-pdf renamed to Ask PDF (smart search)",
    ALL_TOOLS.find((t) => t.id === "chat-with-pdf")?.name.en.includes("Ask PDF") ===
      true,
  );
}

/* ================================================================== */
console.log("── 1. TextRank engine (summarize-pdf) ────────────────");
/* ================================================================== */
{
  // Sentence split — bilingual + abbreviation protection.
  const sents = splitSentences([
    {
      page: 1,
      text: "Mr. Sharma opened the meeting. Revenue grew 18 percent! Was it a record? यह रिकॉर्ड था। Yes.",
    },
  ]);
  check(
    "splitSentences: abbreviation period does not split",
    sents.some((s) => s.text.startsWith("Mr. Sharma opened")),
    sents.map((s) => s.text).join(" | ").slice(0, 80),
  );
  check(
    "splitSentences: danda ends a sentence",
    sents.some((s) => s.text.endsWith("था।")),
  );
  check(
    "splitSentences: page carried on every sentence",
    sents.every((s) => s.page === 1),
  );

  // Tokenize — script-agnostic.
  const tokens = tokenize("Revenue 42.7 लाख grew");
  check(
    "tokenize: Latin + Devanagari + numbers together",
    tokens.includes("revenue") && tokens.includes("लाख") && tokens.includes("42"),
  );

  // Determinism.
  const sets = [
    new Set(["revenue", "grew", "enterprise"]),
    new Set(["enterprise", "revenue", "segment"]),
    new Set(["churn", "fell", "lowest"]),
  ];
  const s1 = textRankScores(sets, [3, 3, 3]);
  const s2 = textRankScores(sets, [3, 3, 3]);
  check(
    "textRankScores: deterministic across runs",
    s1.length === s2.length && s1.every((v, i) => v === s2[i]),
  );
  check(
    "textRankScores: connected sentence outranks the isolated one",
    s1[0]! > s1[2]! && s1[1]! > s1[2]!,
    s1.map((v) => v.toFixed(4)).join(","),
  );

  // The full summary build on the bilingual fixture.
  const summary = buildExtractiveSummary(DOC_PAGES, "standard");
  check("buildExtractiveSummary: builds on bilingual doc", summary !== null);
  if (summary) {
    const allSelected = [...summary.tldr, ...summary.keyPoints];
    check(
      "summary: every sentence is VERBATIM from the document",
      allSelected.every((s) =>
        DOC_PAGES.some((p) => p.text.includes(s.text)),
      ),
    );
    check(
      "summary: page citations are correct",
      allSelected.every((s) =>
        DOC_PAGES[s.page - 1]!.text.includes(s.text),
      ),
    );
    const idx = allSelected.map((s) => s.index);
    check(
      "summary: reading order restored",
      idx.every((v, i) => i === 0 || v > idx[i - 1]!),
      idx.join(","),
    );
    const brief = buildExtractiveSummary(DOC_PAGES, "brief");
    check(
      "summary: word target respected (brief band on a small doc)",
      brief !== null &&
        brief.stats.wordsSelected >= SUMMARY_TARGET_WORDS.brief[0] - 40,
      brief ? String(brief.stats.wordsSelected) : "null",
    );
    check(
      "summary: tldr has 1-2 sentences, keyPoints the rest",
      summary.tldr.length >= 1 && summary.tldr.length <= 2,
    );

    const md = renderSummaryMarkdown(summary, "report.pdf");
    check(
      "markdown: TL;DR + key points + citations + method note",
      md.includes("## TL;DR") &&
        md.includes("## Key points") &&
        md.includes("*(p. ") &&
        md.includes("TextRank"),
    );
    const txt = renderSummaryPlainText(summary, "report.pdf");
    check(
      "plaintext: same content, no markdown markup",
      txt.includes("(p. ") && !txt.includes("## "),
    );
  }

  // Empty document → honest null.
  check(
    "summary: empty pages → null (honest refusal)",
    buildExtractiveSummary([{ page: 1, text: "   " }], "brief") === null,
  );
}

/* ================================================================== */
console.log("── 2. BM25 engine (chat-with-pdf / Ask PDF) ───────────");
/* ================================================================== */
{
  const pages: PageText[] = [
    {
      page: 1,
      text: `Introduction.\n\nThis contract is between Acme Corporation and Beta Industries, effective from 1 March 2026.`,
    },
    {
      page: 2,
      text: `Payment terms.\n\nThe total contract value is 500,000 dollars, payable in four quarterly installments. Late payments attract interest at 12 percent per annum. The contract value was agreed after negotiation.`,
    },
    {
      page: 3,
      text: `Termination.\n\nEither party may terminate this agreement with 60 days written notice. Confidentiality obligations survive termination.`,
    },
  ];

  const passages = buildPassages(pages);
  check(
    "buildPassages: one passage per paragraph, pages tracked",
    passages.length === 6 && passages[0]!.page === 1 && passages[3]!.page === 2,
    `${passages.length} passages`,
  );

  const index = buildIndex(pages);
  check(
    "buildIndex: docFreq counts term presence (contract in 2 passages)",
    (index.docFreq.get("contract") ?? 0) === 2,
    String(index.docFreq.get("contract") ?? 0),
  );

  // Ranking: the payment passage must top a payment query.
  const hits = bm25Search(index, "contract value payment installments", { limit: 5 });
  check("bm25Search: finds matches", hits.length > 0);
  if (hits.length > 0) {
    check(
      "bm25Search: payment passage (p.2) ranks first",
      hits[0]!.page === 2 && /500,000/.test(hits[0]!.text),
      `top p.${hits[0]!.page} score ${hits[0]!.score.toFixed(2)}`,
    );
    check(
      "bm25Search: sorted desc by score",
      hits.every((h, i) => i === 0 || hits[i - 1]!.score >= h.score),
    );
  }

  // Stopword-only query falls back to raw tokens.
  const qt = queryTokens("the of and");
  check("queryTokens: stopword-only falls back to raw", qt.length === 3);
  check(
    "queryTokens: content words kept",
    queryTokens("the payment terms").join(",") === "payment,terms",
  );

  // No match → honest empty.
  check(
    "bm25Search: no match → empty array",
    bm25Search(index, "zebra quantum banana").length === 0,
  );
  check(
    "bm25Search: empty query → empty array",
    bm25Search(index, "   ").length === 0,
  );

  // Determinism.
  const h1 = bm25Search(index, "termination notice");
  const h2 = bm25Search(index, "termination notice");
  check(
    "bm25Search: deterministic",
    h1.length === h2.length &&
      h1.every((h, i) => h.passageId === h2[i]!.passageId && h.score === h2[i]!.score),
  );

  // Snippet runs.
  const longPassage =
    "The parties agree that the total contract value stated in this agreement covers all deliverables described in schedule A and schedule B, " +
    "including revisions, and that any additional work requested outside the agreed scope will be quoted separately in writing before commencement " +
    "of such work. The contract value is payable in four quarterly installments. Late payments attract interest at 12 percent per annum from the due date.";
  const runs = buildSnippet(longPassage, "contract value");
  const hitRuns = runs.filter((r) => r.hit);
  check(
    "buildSnippet: matched terms become hit runs (both terms, all occurrences)",
    hitRuns.length >= 2 &&
      hitRuns.some((r) => r.text.includes("contract")) &&
      hitRuns.some((r) => r.text.includes("value")),
    `${hitRuns.length} hit runs`,
  );
  check(
    "buildSnippet: windowed with ellipses when trimmed",
    runs[0]!.text === "…" || runs[runs.length - 1]!.text === "…",
  );
  const noMatchRuns = buildSnippet("some text here", "zebra");
  check(
    "buildSnippet: no-match → single plain run",
    noMatchRuns.length === 1 && noMatchRuns[0]!.hit === false,
  );

  // Devanagari search.
  const hiHits = bm25Search(
    buildIndex([
      {
        page: 1,
        text: `राजस्व विवरण।\n\nइस तिमाही में कंपनी का राजस्व 18 प्रतिशत बढ़ा। एंटरप्राइज़ खंड ने कुल आय का 61 प्रतिशत योगदान दिया।`,
      },
    ]),
    "राजस्व प्रतिशत",
  );
  check(
    "bm25Search: Devanagari query finds Devanagari passage",
    hiHits.length > 0 && hiHits[0]!.page === 1,
  );
}

/* ================================================================== */
console.log("── 3. Chunker (prepare-pdf-for-ai) ─────────────────────");
/* ================================================================== */
{
  check("tokenEstimate: 4 chars per token", tokenEstimate("abcd".repeat(10)) === 10);
  check("wordCount: unicode-aware (matras stay in the word)", wordCount("Revenue 42.7 लाख dollars") === 5);

  check(
    "languageHint: en / hi / mixed / empty",
    languageHint("The quick brown fox jumps") === "en" &&
      languageHint("यह एक हिन्दी दस्तावेज़ है") === "hi" &&
      languageHint("The quick राजस्व report बढ़ा here") === "mixed" &&
      languageHint("123 456 !!!") === "",
  );

  check(
    "aiDocId: unsafe characters sanitized",
    aiDocId("My Report (Final).pdf") === "My-Report-Final",
    aiDocId("My Report (Final).pdf"),
  );

  // Chunk sizing on a controlled fixture: 6 DISTINCT paragraphs of ~200 tokens.
  const mkPara = (n: number): string =>
    `Paragraph ${n} ` + `word${n} `.repeat(158).trim();
  const pages: PrepPage[] = [
    { page: 1, text: `${mkPara(1)}\n\n${mkPara(2)}\n\n${mkPara(3)}` },
    { page: 2, text: `${mkPara(4)}\n\n${mkPara(5)}\n\n${mkPara(6)}` },
  ];
  const chunks = chunkParagraphs(pages, 400, 80);
  check(
    "chunkParagraphs: multiple chunks for 6×200 tokens at target 400",
    chunks.length >= 3,
    `${chunks.length} chunks`,
  );
  const sizes = chunks.map((c) =>
    tokenEstimate(c.paragraphs.map((p) => p.text).join("\n\n")),
  );
  check(
    "chunkParagraphs: every chunk within a soft bound of the target",
    sizes.every((s) => s <= 400 + 200),
    sizes.join(","),
  );
  check(
    "chunkParagraphs: paragraphs never split across chunks",
    chunks.every((c) =>
      c.paragraphs.every((p) =>
        pages[p.page - 1]!.text.includes(p.text),
      ),
    ),
  );
  // Overlap: chunk N+1 starts with tail paragraphs of chunk N
  // (dedicated fixture: ~83-token paragraphs, overlap budget 100 → 1 carried).
  {
    const small = (n: number): string =>
      `Section ${n} ` + `alpha${n} `.repeat(40).trim();
    const opages: PrepPage[] = [
      { page: 1, text: [1, 2, 3, 4, 5, 6].map(small).join("\n\n") },
    ];
    const ochunks = chunkParagraphs(opages, 250, 100);
    check(
      "chunkParagraphs: overlap carries tail paragraphs forward",
      ochunks.length >= 2 &&
        ochunks[1]!.paragraphs.some((p) =>
          ochunks[0]!.paragraphs.some((q) => q.text === p.text),
        ),
      `${ochunks.length} chunks`,
    );
  }
  // Zero overlap → clean split.
  const clean = chunkParagraphs(pages, 400, 0);
  if (clean.length >= 2) {
    check(
      "chunkParagraphs: zero overlap → no shared paragraphs",
      !clean[1]!.paragraphs.some((p) =>
        clean[0]!.paragraphs.some((q) => q.text === p.text),
      ),
    );
  }

  // Oversized paragraph → sentence-boundary split.
  const huge = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i} carries useful content for the chunker.`,
  ).join(" ");
  const split = chunkParagraphs([{ page: 1, text: huge }], 100, 0);
  check(
    "chunkParagraphs: oversized paragraph split at sentences",
    split.length > 3 && split.every((c) => c.paragraphs.every((p) => p.text.includes("Sentence number"))),
    `${split.length} pieces`,
  );

  // Full doc build — LlamaIndex shape.
  const now = "2026-10-31T12:00:00.000Z";
  const doc = buildPreparedDoc(DOC_PAGES as PrepPage[], {
    format: "json",
    chunkTokens: 200,
    overlapTokens: 40,
    fileName: "Q3 Review.pdf",
    now,
  });
  check("buildPreparedDoc: builds", doc !== null);
  if (doc) {
    check(
      "doc shape: id_ + text + metadata + nodes (LlamaIndex)",
      doc.id_ === "Q3-Review" &&
        typeof doc.text === "string" &&
        doc.metadata.chunk_count === doc.nodes.length &&
        Array.isArray(doc.nodes),
    );
    check(
      "doc metadata: counts + language + provenance (English-dominant fixture)",
      doc.metadata.language_hint === "en" &&
        doc.metadata.file_name === "Q3 Review.pdf" &&
        doc.metadata.page_count === 3 &&
        doc.metadata.prepared_by.includes("DocoPDF") &&
        doc.metadata.prepared_at === now,
    );
    check(
      "nodes: id_ pattern + page map + page_label",
      doc.nodes.every(
        (n, i) =>
          n.id_ === `Q3-Review-chunk-${String(i).padStart(3, "0")}` &&
          n.metadata.page >= 1 &&
          n.metadata.page <= 3 &&
          n.metadata.page_label === String(n.metadata.page) &&
          n.metadata.file_name === "Q3 Review.pdf",
      ),
    );
    check(
      "nodes: start_page ≤ end_page and text is verbatim",
      doc.nodes.every(
        (n) =>
          n.metadata.start_page <= n.metadata.end_page &&
          n.text
            .split("\n\n")
            .every((t) => DOC_PAGES.some((p) => p.text.includes(t))),
      ),
    );
    check(
      "nodes: char/word/token counts consistent",
      doc.nodes.every(
        (n) =>
          n.metadata.char_count === n.text.length &&
          n.metadata.token_estimate === tokenEstimate(n.text),
      ),
    );

    const json = renderPrepared(doc, "json");
    const parsed = JSON.parse(json) as typeof doc;
    check(
      "renderPrepared: json round-trips",
      parsed.nodes.length === doc.nodes.length && parsed.id_ === doc.id_,
    );
    const jsonl = renderPrepared(doc, "jsonl");
    const lines = jsonl.trim().split("\n");
    check(
      "renderPrepared: jsonl = one node per line",
      lines.length === doc.nodes.length &&
        lines.every((l) => {
          const n = JSON.parse(l) as { id_: string };
          return n.id_.startsWith("Q3-Review-chunk-");
        }),
    );
  }

  // Empty document → honest null.
  check(
    "buildPreparedDoc: empty pages → null",
    buildPreparedDoc(
      [{ page: 1, text: " " }],
      { format: "json", chunkTokens: 200, overlapTokens: 0, fileName: "x.pdf", now },
    ) === null,
  );
}

/* ================================================================== */
console.log("── 4. Worker source discipline ─────────────────────────");
/* ================================================================== */
{
  const sumWorker = read("tools/summarize-pdf/worker.ts");
  check(
    "summarize worker: runs the pure engine + honest errorNoText",
    sumWorker.includes("buildExtractiveSummary") &&
      sumWorker.includes("tool.errorNoText"),
  );
  const askWorker = read("tools/chat-with-pdf/worker.ts");
  check(
    "ask worker: extract + search protocol, no network",
    askWorker.includes('type: "extract"') &&
      askWorker.includes('type: "search"') &&
      askWorker.includes("bm25Search") &&
      !/fetch\(|XMLHttpRequest/.test(askWorker),
  );
  const prepWorker = read("tools/prepare-pdf-for-ai/worker.ts");
  check(
    "prepare worker: chunk + render + honest errorNoText",
    prepWorker.includes("buildPreparedDoc") &&
      prepWorker.includes("renderPrepared") &&
      prepWorker.includes("tool.errorNoText"),
  );
  check(
    "ask surface: renders snippet highlights client-side (no AI claims)",
    read("tools/chat-with-pdf/surface.tsx").includes("HighlightRuns"),
  );
}

/* ------------------------------ verdict ------------------------------ */
console.log(
  `\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed${failures.length ? `\n  failures: ${failures.join(" | ")}` : ""}\n`,
);
process.exit(fail === 0 ? 0 : 1);

function exists(p: string): boolean {
  try {
    readFileSync(join(process.cwd(), p));
    return true;
  } catch {
    return false;
  }
}
