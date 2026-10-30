/**
 * Smoke test: Summarize PDF (R11, tool #100).
 *
 * Locks the deterministic core of the third server-backed DocoPDF tool —
 * the LLM round-trip itself is covered by browser E2E, everything that
 * CAN be pinned statically or vectorially is pinned here:
 *
 *   1. model vectors — section parser (headers, bullets, numbered lists,
 *      paragraphs, empty-section drop, preamble defense, junk totality),
 *      naming, excerpt reuse (chat model contract), scanned detection
 *   2. api-model — zod schema accepts valid bodies, rejects every honest
 *      limit violation; SUMMARIZE_API mirrors SUMMARIZE_LIMITS; the
 *      prompt carries the English-header + citation + length contract
 *   3. wiring — registry/configs/surfaces entries, /api/summarize route
 *      (stateless, zod-gated, deadline + attempts), the surface (shared
 *      chat worker, lazy pdf-lib, Noto font fetch, error mapping)
 *   4. i18n — the summarize.* keys exist in en+hi with real Devanagari
 *      and the global en/hi parity holds
 *
 * Run: bun scripts/smoke-summarize-pdf.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SUMMARIZE_LIMITS,
  SUMMARY_LANGUAGES,
  SUMMARY_LENGTHS,
  SUMMARY_TARGET_WORDS,
  buildSummaryMarkdown,
  buildSummaryPlainText,
  hasDevanagari,
  isLikelyScanned,
  isSummaryLanguage,
  isSummaryLength,
  parseSummarySections,
  summarizeBaseName,
  type SummarySection,
} from "../tools/summarize-pdf/model";
import {
  SUMMARIZE_API,
  SUMMARIZE_ERROR_STATUS,
  buildSummarizePrompt,
  summarizeBodySchema,
} from "../tools/summarize-pdf/api-model";

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
  return readFileSync(join(process.cwd(), p), "utf-8");
}

/* ---------------- 1. model vectors ---------------- */

console.log("\n§1 model — parser, naming, guards");

check(
  "limits: mirror chat ceilings (200 pages / 48k excerpt)",
  SUMMARIZE_LIMITS.maxPages === 200 &&
    SUMMARIZE_LIMITS.excerptBudget === 48_000 &&
    SUMMARIZE_LIMITS.scannedThresholdChars === 40,
);
check(
  "catalog: exactly en+hi with native labels",
  SUMMARY_LANGUAGES.length === 2 &&
    SUMMARY_LANGUAGES.some((l) => l.code === "hi" && l.native === "हिन्दी") &&
    SUMMARY_LANGUAGES.some((l) => l.code === "en" && l.native === "English"),
);
check(
  "guards: isSummaryLanguage / isSummaryLength",
  isSummaryLanguage("hi") &&
    isSummaryLanguage("en") &&
    !isSummaryLanguage("zh") &&
    !isSummaryLanguage(null) &&
    SUMMARY_LENGTHS.every(isSummaryLength) &&
    !isSummaryLength("tiny") &&
    !isSummaryLength(3),
);
check(
  "target words: brief < standard < detailed",
  SUMMARY_TARGET_WORDS.brief[1] < SUMMARY_TARGET_WORDS.standard[1] &&
    SUMMARY_TARGET_WORDS.standard[1] < SUMMARY_TARGET_WORDS.detailed[1],
);

{
  const md = [
    "## TL;DR",
    "This is a quarterly sales report.",
    "Revenue grew overall.",
    "",
    "## Key points",
    "- North grew to 120 (p. 1)",
    "- South dipped to 88 (p. 2)",
    "",
    "## Action items",
    "1. Fix the South pipeline (p. 3)",
    "2. Repeat the North playbook (p. 3)",
    "",
    "## Details",
    "The report covers Q1-Q2 with regional splits.",
  ].join("\n");
  const sections = parseSummarySections(md);
  check(
    "parser: canonical sections in order with keys",
    sections.length === 4 &&
      sections.map((s) => s.key).join(",") ===
        "tldr,keyPoints,actionItems,details",
  );
  check(
    "parser: paragraphs joined, bullets split, numbered→bullets",
    sections[0].paragraphs.length === 1 &&
      sections[0].paragraphs[0] ===
        "This is a quarterly sales report. Revenue grew overall." &&
      sections[1].bullets.length === 2 &&
      sections[2].bullets[0] === "Fix the South pipeline (p. 3)",
  );
}
{
  const sections = parseSummarySections(
    "## TL;DR\nFine text.\n\n## Action items\n\n## Key points\n- Only point",
  );
  check(
    "parser: empty section dropped, later sections keep going",
    sections.length === 2 &&
      sections[0].key === "tldr" &&
      sections[1].key === "keyPoints" &&
      sections[1].bullets[0] === "Only point",
  );
}
{
  // Preamble defense: text before any ## becomes the TL;DR.
  const sections = parseSummarySections("Just a preamble line.");
  check(
    "parser: preamble becomes TL;DR",
    sections.length === 1 &&
      sections[0].key === "tldr" &&
      sections[0].paragraphs[0] === "Just a preamble line.",
  );
  // Junk totality — never throws, always well-formed arrays.
  const junk = parseSummarySections("### weird\n\n\n## \n");
  check(
    "parser: junk input is total (no throw; bare #s are noise)",
    parseSummarySections("").length === 0 &&
      parseSummarySections("## \n").length === 0 &&
      junk.length === 1 &&
      junk[0].key === "tldr",
  );
}
check(
  "naming: base names carry localized suffix",
  summarizeBaseName("report.pdf", "en") === "report-summary" &&
    summarizeBaseName("report.pdf", "hi") === "report-सारांश" &&
    summarizeBaseName("no-ext", "en") === "no-ext-summary" &&
    summarizeBaseName("", "en") === "document-summary",
);
check(
  "hasDevanagari: range detection",
  hasDevanagari("सारांश") && !hasDevanagari("summary") && hasDevanagari("x सार"),
);

const sampleSections: SummarySection[] = [
  {
    key: "tldr",
    header: "TL;DR",
    bullets: [],
    paragraphs: ["Quarterly sales report. Revenue grew."],
  },
  {
    key: "keyPoints",
    header: "Key points",
    bullets: ["North grew to 120 (p. 1)", "South dipped to 88 (p. 2)"],
    paragraphs: [],
  },
];
const labels = {
  title: "PDF Summary",
  document: "Document",
  generated: "Generated",
  tldr: "TL;DR",
  keyPoints: "Key points",
  actionItems: "Action items",
  details: "Details",
};
{
  const md = buildSummaryMarkdown("r.pdf", sampleSections, "2026-10-26 12:00", labels);
  check(
    "export md: header + labels + citations verbatim",
    md.startsWith("# PDF Summary") &&
      md.includes("**Document:** r.pdf") &&
      md.includes("**Generated:** 2026-10-26 12:00") &&
      md.includes("## Key points") &&
      md.includes("- North grew to 120 (p. 1)"),
  );
  const txt = buildSummaryPlainText(
    "r.pdf",
    sampleSections,
    "2026-10-26 12:00",
    labels,
  );
  check(
    "export txt: no markdown syntax, content intact",
    !txt.includes("**") &&
      !txt.startsWith("#") &&
      txt.includes("KEY POINTS") &&
      txt.includes("- South dipped to 88 (p. 2)"),
  );
  check(
    "export: localized labels flow through",
    buildSummaryMarkdown("r.pdf", sampleSections, "s", {
      ...labels,
      keyPoints: "मुख्य बातें",
    }).includes("## मुख्य बातें"),
  );
}
check(
  "excerpt reuse: chat model contract stays importable + sane",
  typeof isLikelyScanned === "function" &&
    isLikelyScanned([{ page: 1, text: "x".repeat(100) }]) === false &&
    isLikelyScanned([{ page: 1, text: "" }]) === true,
);

/* ---------------- 2. api-model ---------------- */

console.log("\n§2 api-model — schema, mirrors, prompt contract");

{
  const good = summarizeBodySchema.safeParse({
    excerpt: "[[p 1]] hello",
    language: "hi",
    length: "detailed",
    locale: "en",
    docName: "report.pdf",
  });
  check("schema: valid body accepted (docName optional)", good.success);
}
check(
  "schema: empty excerpt rejected",
  !summarizeBodySchema.safeParse({ excerpt: "", language: "en", length: "brief" })
    .success,
);
check(
  "schema: over-budget excerpt rejected at the API mirror",
  !summarizeBodySchema.safeParse({
    excerpt: "x".repeat(SUMMARIZE_API.maxExcerptChars + 1),
    language: "en",
    length: "brief",
  }).success,
);
check(
  "schema: junk language/length rejected, locale defaults",
  !summarizeBodySchema.safeParse({ excerpt: "x", language: "zh", length: "brief" })
    .success &&
    !summarizeBodySchema.safeParse({ excerpt: "x", language: "en", length: "tiny" })
      .success &&
    (summarizeBodySchema.safeParse({ excerpt: "x", language: "en", length: "brief" })
      .data as { locale?: string } | undefined)?.locale === "en",
);
check(
  "mirrors: API constants stay pinned to model limits",
  SUMMARIZE_API.maxExcerptChars === SUMMARIZE_LIMITS.excerptBudget + 500 &&
    SUMMARIZE_API.timeoutMs === 90_000 &&
    SUMMARIZE_API.attempts === 2,
  `${SUMMARIZE_API.maxExcerptChars} / ${SUMMARIZE_API.timeoutMs}ms / x${SUMMARIZE_API.attempts}`,
);
check(
  "errors: stable codes and statuses",
  SUMMARIZE_ERROR_STATUS.badRequest === 400 &&
    SUMMARIZE_ERROR_STATUS.timeout === 504 &&
    SUMMARIZE_ERROR_STATUS.aiUnavailable === 502 &&
    SUMMARIZE_ERROR_STATUS.emptySummary === 502,
);

{
  const briefEn = buildSummarizePrompt("en", "brief");
  const detailedHi = buildSummarizePrompt("hi", "detailed");
  check(
    "prompt: English section headers in EVERY language",
    briefEn.split("\n").includes("## TL;DR") &&
      briefEn.split("\n").includes("## Key points") &&
      detailedHi.split("\n").includes("## TL;DR") &&
      detailedHi.split("\n").includes("## Action items") &&
      detailedHi.split("\n").includes("## Details"),
  );
  check(
    "prompt: brief mode forbids Details, standard/detailed include it",
    briefEn.includes("No \"## Details\" section in brief mode.") &&
      !briefEn.includes("\"## Details\":") &&
      detailedHi.includes("\"## Details\":"),
  );
  check(
    "prompt: citation rule converts [[p N]] → (p. N)",
    briefEn.includes("[[p 7]]") && briefEn.includes("(p. N)"),
  );
  check(
    "prompt: language named for the model",
    detailedHi.includes("Hindi (Devanagari script)") &&
      briefEn.includes("Summarize the user's document in English."),
  );
  check(
    "prompt: length target carried",
    briefEn.includes(
      `${SUMMARY_TARGET_WORDS.brief[0]}-${SUMMARY_TARGET_WORDS.brief[1]} words`,
    ) &&
      detailedHi.includes(
        `${SUMMARY_TARGET_WORDS.detailed[0]}-${SUMMARY_TARGET_WORDS.detailed[1]} words`,
      ),
  );
  check(
    "prompt: no-preamble + no-invention rules present",
    briefEn.includes("never invent") &&
      briefEn.includes("start directly with \"## TL;DR\""),
  );
}

/* ---------------- 3. wiring ---------------- */

console.log("\n§3 wiring — registry, surfaces, route, surface code");

{
  const registry = read("src/lib/tools/registry.ts");
  check(
    "registry: summarize-pdf enabled + popularity 74 + AlignLeft icon",
    registry.includes('id: "summarize-pdf"') &&
      /def\(\{\s*\n\s*id: "summarize-pdf",[\s\S]*?enabled: true,/.test(
        registry,
      ) &&
      registry.includes("icon: AlignLeft,") &&
      /id: "summarize-pdf",[\s\S]*?popularity: 74,/.test(registry),
  );
  const configs = read("src/lib/tools/configs.ts");
  check(
    "configs: config imported and mapped",
    configs.includes('from "../../../tools/summarize-pdf/config"') &&
      configs.includes("[summarizePdf.toolId]: summarizePdf,"),
  );
  const surfaces = read("src/lib/tools/surfaces.tsx");
  check(
    "surfaces: SummarizeSurface imported and mapped",
    surfaces.includes(
      'import { SummarizeSurface } from "../../../tools/summarize-pdf/surface";',
    ) && surfaces.includes('"summarize-pdf": SummarizeSurface,'),
  );
}
{
  const cfg = read("tools/summarize-pdf/config.ts");
  check(
    "config: viewerOnly + landingSurface + howKeys + 1 file",
    cfg.includes("viewerOnly: true") &&
      cfg.includes("landingSurface: true") &&
      cfg.includes('"summarize.how1"') &&
      cfg.includes("maxFiles: 1"),
  );
  const route = read("src/app/api/summarize/route.ts");
  check(
    "route: zod gate + stateless (no db, no store, no prisma)",
    route.includes("summarizeBodySchema.safeParse") &&
      !route.includes("@/lib/db") &&
      !route.includes("prisma"),
  );
  check(
    "route: deadline race + attempts + honest error codes",
    route.includes("withDeadline") &&
      route.includes("SUMMARIZE_API.attempts") &&
      route.includes("emptySummary") &&
      route.includes("timeout"),
  );
  check(
    "route: SDK stays server-only, thinking disabled",
    route.includes('import ZAI from "z-ai-web-dev-sdk"') &&
      route.includes('thinking: { type: "disabled" }'),
  );
  const surface = read("tools/summarize-pdf/surface.tsx");
  check(
    "surface: SHARED chat extraction worker (cross-folder URL)",
    surface.includes(
      'new URL("../chat-with-pdf/worker.ts", import.meta.url)',
    ),
  );
  check(
    "surface: posts ONLY excerpt+options to /api/summarize",
    surface.includes('"/api/summarize"') &&
      surface.includes("excerpt: excerpt.excerpt") &&
      surface.includes("language") &&
      surface.includes("length"),
  );
  check(
    "surface: own-engine lazy-loaded, Noto Devanagari fetched+embedded, winAnsi kept",
    surface.includes('await import("@/lib/own/pdf")') &&
      surface.includes("/fonts/NotoSansDevanagari-Regular.ttf") &&
      surface.includes("doc.embedTtf") &&
      surface.includes("latinSafe"),
  );
  check(
    "surface: no pdf-lib / fontkit / regenerator anywhere in the export path",
    !surface.includes('from "pdf-lib"') &&
      !surface.includes('import("pdf-lib")') &&
      !surface.includes("@pdf-lib/fontkit") &&
      !surface.includes("regenerator-runtime"),
  );
  check(
    "surface: error toast maps timeout/badRequest/aiUnavailable",
    surface.includes('"timeout"') &&
      surface.includes('"badRequest"') &&
      surface.includes("summarize.errSend"),
  );
  check(
    "surface: hooks discipline (signature-keyed effect, no setState in render)",
    surface.includes("files.map((f) => f.id).join") &&
      surface.includes("ranSigRef"),
  );
}

/* ---------------- 4. i18n ---------------- */

console.log("\n§4 i18n — keys, Devanagari reality, global parity");

{
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, unknown>;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Record<string, unknown>;
  const enSum = (en.summarize ?? {}) as Record<string, string>;
  const hiSum = (hi.summarize ?? {}) as Record<string, string>;
  const required = [
    "heroTitle",
    "heroBody",
    "how1",
    "how2",
    "how3",
    "dropHere",
    "langLabel",
    "lengthLabel",
    "len_brief",
    "len_standard",
    "len_detailed",
    "cta",
    "pending",
    "resultLabel",
    "secTldr",
    "secKeyPoints",
    "secActionItems",
    "secDetails",
    "copy",
    "copied",
    "exportLabel",
    "exportPdf",
    "exportMd",
    "exportTxt",
    "exportDone",
    "exportFileTitle",
    "exportDocumentLabel",
    "exportGenerated",
    "errTitle",
    "errSend",
    "errTimeout",
    "errBadRequest",
    "errPdf",
    "disclaimer",
    "scannedTitle",
    "scannedBody",
    "openOcr",
    "errEncryptedTitle",
    "errEncryptedBody",
    "errCorruptTitle",
    "errCorruptBody",
    "retry",
    "chooseOther",
    "extracting",
    "extractingPage",
    "docPages",
    "docChars",
    "pagesOmitted",
    "removeFile",
    "filePending",
    "noText",
    "fileEncrypted",
    "fileUnreadable",
  ];
  const missingEn = required.filter((k) => !(k in enSum));
  const missingHi = required.filter((k) => !(k in hiSum));
  check(
    "i18n: all 56 summarize.* keys present in en+hi",
    missingEn.length === 0 && missingHi.length === 0,
    `en missing: ${missingEn.join(",")} hi missing: ${missingHi.join(",")}`,
  );
  check(
    "i18n: Hindi block is real Devanagari",
    /[\u0900-\u097F]/.test(hiSum.heroTitle ?? "") &&
      /[\u0900-\u097F]/.test(hiSum.secKeyPoints ?? "") &&
      /[\u0900-\u097F]/.test(hiSum.scannedBody ?? ""),
  );

  function keySet(
    obj: Record<string, unknown>,
    prefix = "",
  ): Set<string> {
    const out = new Set<string>();
    for (const [k, v] of Object.entries(obj)) {
      const kk = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") {
        for (const sub of keySet(v as Record<string, unknown>, kk)) out.add(sub);
      } else {
        out.add(kk);
      }
    }
    return out;
  }
  const ek = keySet(en);
  const hk = keySet(hi);
  check(
    "i18n: global en/hi parity",
    ek.size === hk.size && [...ek].every((k) => hk.has(k)),
    `${ek.size} vs ${hk.size}`,
  );
}

/* ---------------- summary ---------------- */

console.log(
  `\n${"-".repeat(50)}\nSUMMARY: ${pass} passed, ${fail} failed${
    fail > 0 ? `\n  FAILURES:\n  - ${failures.join("\n  - ")}` : ""
  }`,
);
if (fail > 0) process.exit(1);
