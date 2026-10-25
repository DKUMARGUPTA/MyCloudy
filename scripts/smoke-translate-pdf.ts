/**
 * Smoke test: Translate PDF (R9-c).
 *
 * Locks the deterministic core of the second server-backed DocoPDF tool —
 * the LLM round-trip itself is covered by browser E2E, everything that CAN
 * be pinned statically or vectorially is pinned here:
 *
 *   1. model vectors — language catalog shape, batching (packing, page
 *      tagging, monster-line splitting, caps), winAnsiSafe (latin-1 pass,
 *      CJK → '?', Devanagari untouched), output naming, scanned detection
 *   2. api-model — zod schema accepts valid batches, rejects every honest
 *      limit violation; TRANSLATE_API mirrors TRANSLATE_LIMITS; the prompt
 *      carries the only-the-translation + line-structure contract
 *   3. wiring — registry/configs entries, worker protocol events, the
 *      /api/translate route (stateless, zod-gated, deadline + attempts),
 *      fonts fetched from origin, error-code mapping
 *   4. i18n — the new tool.errorTranslate* keys exist in en+hi with real
 *      Devanagari; result chips params
 *
 * Run: bun scripts/smoke-translate-pdf.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TRANSLATE_LIMITS,
  TARGET_LANGUAGES,
  batchText,
  batchesChars,
  buildBatches,
  hasDevanagari,
  isLikelyScanned,
  isTargetLang,
  isTranslateMode,
  normalizePageText,
  targetLang,
  translateOutputName,
  winAnsiSafe,
} from "../tools/translate-pdf/model";
import {
  TRANSLATE_API,
  buildTranslatePrompt,
  promptLanguageName,
  stripWrappingQuotes,
  translateBodySchema,
} from "../tools/translate-pdf/api-model";

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

console.log("\n§1 model — catalog, batching, sanitizer, naming");

check(
  "catalog: 9 languages, unique codes, native labels present",
  TARGET_LANGUAGES.length === 9 &&
    new Set(TARGET_LANGUAGES.map((l) => l.code)).size === 9 &&
    TARGET_LANGUAGES.every((l) => l.native.length > 0 && l.english.length > 0),
  TARGET_LANGUAGES.map((l) => l.code).join(","),
);
check(
  "catalog: scripts are latin|devanagari only",
  TARGET_LANGUAGES.every(
    (l) => l.script === "latin" || l.script === "devanagari",
  ) &&
    targetLang("hi").script === "devanagari" &&
    targetLang("mr").script === "devanagari" &&
    targetLang("en").script === "latin",
);
check(
  "isTargetLang: accepts catalog codes, rejects junk",
  isTargetLang("hi") && isTargetLang("nl") && !isTargetLang("zh") && !isTargetLang(5) && !isTargetLang(null),
);
check(
  "hasDevanagari: range detection",
  hasDevanagari("नमस्ते") && !hasDevanagari("hello") && hasDevanagari("mixed देव text"),
);

{
  const pages = [
    { page: 1, text: "Line one on page one.\nLine two." },
    { page: 2, text: "\n\nPage two line.\n\n\n" },
  ];
  const batches = buildBatches(pages, 100);
  check(
    "batches: empty lines dropped, page tags carried",
    batches.length >= 1 &&
      batches.filter((b) => b.page === 1).reduce((n, b) => n + b.lines.length, 0) === 2 &&
      batches.filter((b) => b.page === 2).reduce((n, b) => n + b.lines.length, 0) === 1,
  );
  check(
    "batches: batchText joins with newlines, batchesChars counts exactly",
    batches.every((b) => batchText(b) === b.lines.join("\n")) &&
      batchesChars(batches) ===
        batches.reduce((n, b) => n + batchText(b).length, 0),
  );
}

{
  // Packing: many small lines fill batches up to the limit (≥ the 64-char
  // floor buildBatches enforces), no straddling.
  const lines = Array.from({ length: 40 }, (_, i) => `word${i}`);
  const pages = [{ page: 1, text: lines.join("\n") }];
  const batches = buildBatches(pages, 80);
  check(
    "batches: respects the char limit (never over-stuffed)",
    batches.every((b) => batchText(b).length <= 80),
    `${batches.length} batches`,
  );
  check(
    "batches: order preserved (all 40 lines survive, in order)",
    batches.flatMap((b) => b.lines).join("|") === lines.join("|"),
  );
  check(
    "batches: batches fill before new ones start",
    batches.slice(0, -1).every((b) => batchText(b).length > 80 - 12),
  );
  check(
    "batches: tiny limits floor at 64 (degenerate batching refused)",
    buildBatches([{ page: 1, text: lines.join("\n") }], 10).every(
      (b) => batchText(b).length <= 64,
    ),
  );
}

{
  // Monster line: hard-split at word boundaries.
  const monster = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const batches = buildBatches([{ page: 3, text: monster }], 80);
  check(
    "batches: monster line split at word boundaries, never mid-word",
    batches.length > 1 &&
      batches.every((b) => b.page === 3) &&
      batches.every((b) => b.lines.every((l) => l.length <= 80)) &&
      batches.flatMap((b) => b.lines).join(" ") === monster,
  );
}

{
  // A single unbreakable word longer than the batch: hard cut, no hang.
  const unbreakable = "x".repeat(300);
  const batches = buildBatches([{ page: 1, text: unbreakable }], 80);
  check(
    "batches: unbreakable monster word hard-cut (no infinite loop)",
    batches.length === 4 &&
      batches.flatMap((b) => b.lines).join("") === unbreakable,
    `${batches.length} chunks`,
  );
}

check(
  "batches: defensive against junk pages",
  buildBatches(null as unknown as []).length === 0 &&
    buildBatches([{ page: 1 } as { page: number; text: string }]).length === 0,
);
check(
  "normalizePageText: control chars stripped, cap with honest marker",
  normalizePageText("a\u0000b", 100) === "ab" &&
    normalizePageText("x".repeat(50), 10) ===
      "xxxxxxxxxx\n…[page truncated]…",
);
check(
  "isLikelyScanned: threshold detection",
  isLikelyScanned([]) &&
    isLikelyScanned([{ page: 1, text: "tiny" }]) &&
    !isLikelyScanned([{ page: 1, text: "x".repeat(60) }]) &&
    !isLikelyScanned([
      { page: 1, text: "a" },
      { page: 2, text: "x".repeat(60) },
    ]),
);

check(
  "winAnsiSafe: latin-1 + specials pass byte-exact",
  winAnsiSafe("Héllo — wörld…") === "Héllo — wörld…" &&
    winAnsiSafe("français À côté") === "français À côté" &&
    winAnsiSafe("tab\tand\nnewline") === "tab\tand\nnewline",
);
check(
  "winAnsiSafe: CJK + Devanagari + emoji become '?' per codepoint",
  winAnsiSafe("日本語") === "???" &&
    winAnsiSafe("नमस्ते") === "??????" &&
    winAnsiSafe("🎉") === "?",
);
check(
  "winAnsiSafe: empty + garbage never throw",
  winAnsiSafe("") === "" && winAnsiSafe(String.fromCodePoint(0x10ffff)).includes("?"),
);

check(
  "output name: base + target code, unsafe chars stripped",
  translateOutputName("My Report.pdf", "hi") === "My Report-hi.pdf" &&
    translateOutputName("q3/v2.pdf", "es") === "q3_v2-es.pdf" &&
    translateOutputName("", "fr") === "document-fr.pdf" &&
    translateOutputName(".".repeat(200) + ".pdf", "de").length < 120,
);
check(
  "modes: translated | bilingual only",
  isTranslateMode("translated") && isTranslateMode("bilingual") && !isTranslateMode("both") && !isTranslateMode(1),
);

/* ---------------- 2. api-model ---------------- */

console.log("\n§2 api-model — schema, prompt contract, mirrors");

check(
  "schema: valid batch accepted",
  translateBodySchema.safeParse({
    text: "Hello world",
    target: "hi",
  }).success,
);
check(
  "schema: empty text rejected, over-limit rejected",
  !translateBodySchema.safeParse({ text: "", target: "hi" }).success &&
    !translateBodySchema.safeParse({
      text: "x".repeat(TRANSLATE_API.maxBatchChars + 1),
      target: "hi",
    }).success,
);
check(
  "schema: every catalog target accepted, junk targets rejected",
  TARGET_LANGUAGES.every((l) =>
    translateBodySchema.safeParse({ text: "x", target: l.code }).success,
  ) &&
    !translateBodySchema.safeParse({ text: "x", target: "zh" }).success &&
    !translateBodySchema.safeParse({ text: "x", target: 5 }).success,
);
check(
  "mirrors: TRANSLATE_API.batchChars ≥ TRANSLATE_LIMITS.batchChars (+ slack), < 2x",
  TRANSLATE_API.maxBatchChars >= TRANSLATE_LIMITS.batchChars &&
    TRANSLATE_API.maxBatchChars < TRANSLATE_LIMITS.batchChars * 2,
);
check(
  "api: timeout + attempts are sane for batch latency",
  TRANSLATE_API.timeoutMs === 60_000 && TRANSLATE_API.attempts === 2,
);

const promptHi = buildTranslatePrompt("hi");
check(
  "prompt: only-the-translation contract present",
  promptHi.includes("Output ONLY the translation") &&
    promptHi.includes("Hindi (Devanagari script)") &&
    promptHi.includes("same number of lines"),
);
check(
  "prompt: numbers/URLs untouched rule",
  promptHi.includes("numbers, dates, URLs, code and file names exactly"),
);
check(
  "promptLanguageName: distinct per target",
  promptLanguageName("hi") !== promptLanguageName("en") &&
    promptLanguageName("mr").includes("Marathi") &&
    promptLanguageName("nl") === "Dutch",
);
check(
  "stripWrappingQuotes: model quote-wrapping removed, inner quotes kept",
  stripWrappingQuotes('"नमस्ते दुनिया"') === "नमस्ते दुनिया" &&
    stripWrappingQuotes("“quoted”") === "quoted" &&
    stripWrappingQuotes("he said \"hi\" to me") === 'he said "hi" to me' &&
    stripWrappingQuotes("  padded  ") === "padded",
);

/* ---------------- 3. wiring locks ---------------- */

console.log("\n§3 wiring — registry, config, worker, route, protocol");

const registry = read("src/lib/tools/registry.ts");
const configs = read("src/lib/tools/configs.ts");
const config = read("tools/translate-pdf/config.ts");
const worker = read("tools/translate-pdf/worker.ts");
const route = read("src/app/api/translate/route.ts");
const protocol = read("src/lib/workers/protocol.ts");
const resultView = read("src/components/doco/tool/result-view.tsx");

check(
  "registry: translate-pdf def with Languages icon + convert-from category",
  registry.includes('id: "translate-pdf"') &&
    /icon: Languages/.test(registry) &&
    registry.includes("Languages,") &&
    registry.includes('id: "translate-pdf",\n    category: "convert-from"'),
);
check(
  "configs: config registered by toolId",
  configs.includes('from "../../../tools/translate-pdf/config"') &&
    configs.includes("[translatePdf.toolId]: translatePdf"),
);
check(
  "config: worker factory + pdf output + honest limits",
  /createWorker/.test(config) &&
    /outputKind: "pdf"/.test(config) &&
    config.includes("targetLang") &&
    config.includes('"translated"') &&
    config.includes('"bilingual"') &&
    /kind: "pages"/.test(config),
);
check(
  "config: privacy copy — file never leaves the device",
  /never the PDF bytes/i.test(config),
);
check(
  "worker: standard protocol + pdf.js + batching + api route",
  worker.includes("WorkerRunRequest") &&
    worker.includes("loadPdfjsInWorker") &&
    worker.includes("buildBatches") &&
    worker.includes('"/api/translate"') &&
    worker.includes("batchText"),
);
check(
  "worker: honest caps — maxPages + maxTotalChars refusals",
  worker.includes("TRANSLATE_LIMITS.maxPages") &&
    worker.includes("TRANSLATE_LIMITS.maxTotalChars") &&
    worker.includes("tool.errorTranslateTooLong"),
);
check(
  "worker: Devanagari font fetch from origin (blob-safe)",
  worker.includes("/fonts/NotoSansDevanagari-Regular.ttf") &&
    worker.includes("absoluteUrl") &&
    worker.includes("subset: true"),
);
check(
  "worker: latin draws sanitized, devanagari draws verbatim",
  worker.includes("latinSafe") &&
    /needDevaFont \? pageTranslated : latinSafe\(pageTranslated\)/.test(worker),
);
check(
  "worker: error mapping (timeout/ai/font/encrypted/corrupt)",
  worker.includes("tool.errorTranslateTimeout") &&
    worker.includes("tool.errorTranslateAi") &&
    worker.includes("tool.errorPageFont") &&
    worker.includes("tool.errorEncrypted") &&
    worker.includes("tool.errorNoText"),
);
check(
  "worker: bilingual mode renders original + translation",
  /mode === "bilingual"/.test(worker) &&
    /Page \$\{p\.page\}/.test(worker),
);
check(
  "route: zod gate before SDK, nodejs runtime, stateless",
  route.includes("translateBodySchema.safeParse") &&
    route.includes('runtime = "nodejs"') &&
    !/console\.(log|error|warn)\(/.test(route) &&
    !/prisma|localStorage|fs\.write/i.test(route),
);
check(
  "route: deadline race + honest attempts",
  route.includes("withDeadline") &&
    route.includes("TRANSLATE_API.attempts") &&
    route.includes("TRANSLATE_API.timeoutMs"),
);
check(
  "route: prompt built from the shared api-model (never inline)",
  route.includes("buildTranslatePrompt(body.target)") &&
    route.includes("thinking: { type: \"disabled\" }"),
);
check(
  "protocol: RunDetail gained translatedChars + translatedBatches",
  protocol.includes("translatedChars?: number") &&
    protocol.includes("translatedBatches?: number"),
);
check(
  "result-view: chips render the translate detail",
  resultView.includes("result.translatedChars") &&
    resultView.includes("result.translatedBatches"),
);

/* ---------------- 4. i18n ---------------- */

console.log("\n§4 i18n — error keys + result chips in both locales");

type Dict = Record<string, unknown>;
const en = JSON.parse(read("src/i18n/en.json")) as Dict;
const hi = JSON.parse(read("src/i18n/hi.json")) as Dict;

for (const key of [
  "errorTranslateTooLong",
  "errorTranslateTimeout",
  "errorTranslateAi",
  "errorNoFile",
]) {
  const e = (en.tool as Dict)[key];
  const h = (hi.tool as Dict)[key];
  check(
    `tool.${key}: en+hi present, real Hindi not a copy`,
    typeof e === "string" &&
      e.length > 10 &&
      typeof h === "string" &&
      h.length > 10 &&
      /[\u0900-\u097F]/.test(h),
  );
}
for (const key of ["translatedChars", "translatedBatches"]) {
  const e = (en.result as Dict)[key];
  const h = (hi.result as Dict)[key];
  check(
    `result.${key}: en+hi present with {n} plural`,
    typeof e === "string" &&
      e.includes("{n, plural,") &&
      typeof h === "string" &&
      h.includes("{n, plural,") &&
      /[\u0900-\u097F]/.test(h),
  );
}

function flat(d: Dict, p = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(d)) {
    const kk = `${p}${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const x of flat(v as Dict, `${kk}.`)) out.add(x);
    } else {
      out.add(kk);
    }
  }
  return out;
}
const enKeys = flat(en);
const hiKeys = flat(hi);
check(
  "catalog parity holds globally after the translate insertion",
  enKeys.size === hiKeys.size && [...enKeys].every((k) => hiKeys.has(k)),
  `${enKeys.size} = ${hiKeys.size}`,
);

/* ---------------- verdict ---------------- */

console.log(
  `\nSMOKE TRANSLATE-PDF: ${pass} passed, ${fail} failed${
    fail > 0 ? `\n  FAILURES:\n${failures.map((f) => `    - ${f}`).join("\n")}` : ""
  }`,
);
process.exit(fail > 0 ? 1 : 0);
