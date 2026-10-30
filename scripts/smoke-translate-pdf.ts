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
  SCRIPT_FONT,
  adjustCjkBreak,
  batchText,
  batchesChars,
  buildBatches,
  hasArabic,
  hasDevanagari,
  hasHangul,
  hasHan,
  hasKana,
  isLikelyScanned,
  isTargetLang,
  isTranslateMode,
  normalizePageText,
  scriptOfText,
  targetFontUrl,
  targetLang,
  translateOutputName,
  winAnsiSafe,
} from "../tools/translate-pdf/model";
import {
  bidiVisualLine,
  shapeArabic,
  shapeArabicLine,
} from "../tools/translate-pdf/arabic-shape";
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
  "catalog: 13 languages, unique codes, native labels present",
  TARGET_LANGUAGES.length === 13 &&
    new Set(TARGET_LANGUAGES.map((l) => l.code)).size === 13 &&
    TARGET_LANGUAGES.every((l) => l.native.length > 0 && l.english.length > 0),
  TARGET_LANGUAGES.map((l) => l.code).join(","),
);
check(
  "catalog: scripts span latin|devanagari|han|kana|hangul|arabic",
  new Set(TARGET_LANGUAGES.map((l) => l.script)).size === 6 &&
    targetLang("hi").script === "devanagari" &&
    targetLang("zh").script === "han" &&
    targetLang("ja").script === "kana" &&
    targetLang("ko").script === "hangul" &&
    targetLang("ar").script === "arabic" &&
    targetLang("en").script === "latin",
);
check(
  "catalog: every non-latin script maps to a self-hosted font URL",
  TARGET_LANGUAGES.every(
    (l) => (l.script === "latin" ? l.font === null : typeof l.font === "string" && l.font.startsWith("/fonts/")),
  ) &&
    targetFontUrl("zh") === "/fonts/NotoSansSC-Regular.ttf" &&
    targetFontUrl("ja") === "/fonts/NotoSansJP-Regular.ttf" &&
    targetFontUrl("ko") === "/fonts/NotoSansKR-Regular.ttf" &&
    targetFontUrl("ar") === "/fonts/NotoNaskhArabic-Regular.ttf" &&
    targetFontUrl("en") === null,
);
check(
  "font files: 4 new TTFs present on disk with TrueType magic bytes",
  (() => {
    for (const f of [
      "NotoSansSC-Regular.ttf",
      "NotoSansJP-Regular.ttf",
      "NotoSansKR-Regular.ttf",
      "NotoNaskhArabic-Regular.ttf",
    ]) {
      const b = readFileSync(join(process.cwd(), "public/fonts", f));
      if (b.length < 100_000) return false;
      if (!(b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return false;
    }
    return true;
  })(),
  "magic 00 01 00 00 + >100KB each",
);
check(
  "font files: OFL attribution text carried next to the TTFs",
  readFileSync(join(process.cwd(), "public/fonts/NotoCJK-Arabic-OFL.txt"), "utf-8").includes("SIL OPEN FONT LICENSE"),
);
check(
  "isTargetLang: accepts catalog codes incl zh/ja/ko/ar, rejects junk",
  isTargetLang("hi") && isTargetLang("zh") && isTargetLang("ja") && isTargetLang("ko") && isTargetLang("ar") && isTargetLang("nl") && !isTargetLang("xx") && !isTargetLang(5) && !isTargetLang(null),
);
check(
  "hasDevanagari: range detection",
  hasDevanagari("नमस्ते") && !hasDevanagari("hello") && hasDevanagari("mixed देव text"),
);
check(
  "hasHan/hasKana/hasHangul/hasArabic: detection vectors",
  hasHan("简体汉字") && !hasHan("ひらがな") &&
    hasKana("あいうカキク") && !hasKana("简体") &&
    hasHangul("한국어") && !hasHangul("日本語") &&
    hasArabic("مرحبا") && hasArabic("\u0660\u0661") && !hasArabic("hello"),
);
check(
  "scriptOfText: most-distinctive-first priority",
  scriptOfText("日本語のテキスト") === "kana" &&
    scriptOfText("한국어 텍스트") === "hangul" &&
    scriptOfText("你好世界") === "han" &&
    scriptOfText("مرحبا بالعالم") === "arabic" &&
    scriptOfText("नमस्ते दुनिया") === "devanagari" &&
    scriptOfText("hello world") === "latin" &&
    scriptOfText("日本語と 한국어 mixed") === "kana" &&
    scriptOfText("") === "latin",
);
check(
  "SCRIPT_FONT: covers every non-latin script with a real URL",
  Object.keys(SCRIPT_FONT).length === 5 &&
    SCRIPT_FONT.devanagari === "/fonts/NotoSansDevanagari-Regular.ttf" &&
    SCRIPT_FONT.kana === "/fonts/NotoSansJP-Regular.ttf" &&
    SCRIPT_FONT.han === "/fonts/NotoSansSC-Regular.ttf" &&
    SCRIPT_FONT.hangul === "/fonts/NotoSansKR-Regular.ttf" &&
    SCRIPT_FONT.arabic === "/fonts/NotoNaskhArabic-Regular.ttf",
);
check(
  "adjustCjkBreak: no line starts with a closer / ends with an opener",
  adjustCjkBreak("这是测试。再来", 4) === 3 &&
    adjustCjkBreak("这是（测试。再来", 3) === 2 &&
    adjustCjkBreak("hello world pad", 7) === 7 &&
    adjustCjkBreak("देवनागरी", 3) === 3 &&
    adjustCjkBreak("。", 1) === 1,
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
    translateOutputName("报告.pdf", "ar") === "报告-ar.pdf" &&
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
    !translateBodySchema.safeParse({ text: "x", target: "xx" }).success &&
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
  "promptLanguageName: distinct per target, CJK/Arabic honest",
  promptLanguageName("hi") !== promptLanguageName("en") &&
    promptLanguageName("mr").includes("Marathi") &&
    promptLanguageName("nl") === "Dutch" &&
    promptLanguageName("zh").includes("Simplified Chinese") &&
    promptLanguageName("ja").includes("Japanese") &&
    promptLanguageName("ko").includes("Korean") &&
    promptLanguageName("ar").includes("Arabic"),
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
const model = read("tools/translate-pdf/model.ts");
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
  "registry: tagline counts all 13 languages (copy drift guard)",
  registry.includes("13 languages") &&
    registry.includes("Chinese, Japanese, Korean, Arabic") &&
    registry.includes("13 भाषाओं"),
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
  "worker: all five script fonts fetched from origin (blob-safe) + engine auto-subset",
  worker.includes("absoluteUrl") &&
    worker.includes("doc.embedTtf") &&
    worker.includes("loadScriptFont") &&
    model.includes('devanagari: "/fonts/NotoSansDevanagari-Regular.ttf"') &&
    model.includes('arabic: "/fonts/NotoNaskhArabic-Regular.ttf"') &&
    worker.includes("SCRIPT_FONT") &&
    !worker.includes("pdf-lib"),
);
check(
  "worker: script-routed draws — latin sanitized, Arabic shaped+CJK kinsoku",
  worker.includes("latinSafe") &&
    worker.includes('lang.script === "latin"') &&
    worker.includes("shapeArabic(pageTranslated)") &&
    worker.includes("bidiVisualLine(text)") &&
    worker.includes("adjustCjkBreak(rest, take)") &&
    worker.includes("scriptOfText(p.text)"),
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

/* ---------------- 5. arabic shaper ---------------- */

console.log("\n§5 arabic-shape — joining, ligatures, display reorder");

const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0) ?? 0);
const hex = (s: string): string => cps(s).map((c) => c.toString(16)).join(" ");

check(
  "shape: باب joins initial+final+isolated",
  hex(shapeArabicLine("باب")) === "fe91 fe8e fe8f",
  hex(shapeArabicLine("باب")),
);
check(
  "shape: مرحبا classic joining (meem-initial … alef-final)",
  hex(shapeArabicLine("مرحبا")) === "fee3 feae fea3 fe92 fe8e",
  hex(shapeArabicLine("مرحبا")),
);
check(
  "shape: السلام definite article + lam-alef ligature fires mid-word",
  hex(shapeArabicLine("السلام")) === "fe8d fedf feb4 fefc fee1",
  hex(shapeArabicLine("السلام")),
);
check(
  "shape: lam-alef ligatures — isolated, final after beh, after meem",
  hex(shapeArabicLine("لا")) === "fefb" &&
    hex(shapeArabicLine("بلا")) === "fe91 fefc" &&
    hex(shapeArabicLine("ملا")) === "fee3 fefc",
);
check(
  "shape: transparent marks pass through and do not break joining",
  hex(shapeArabicLine("بُ")) === "fe8f 64f" &&
    hex(shapeArabicLine("بُب")) === "fe91 64f fe90",
);
check(
  "shape: ZWJ/ZWNJ controls stripped, non-Arabic runs untouched",
  hex(shapeArabicLine("hello 123")) === "68 65 6c 6c 6f 20 31 32 33" &&
    !shapeArabicLine("ب\u200dب").includes("\u200d") &&
    shapeArabicLine("") === "",
);
check(
  "shape: paragraph mode splits lines, preserves newlines",
  shapeArabic("لا\nباب").split("\n").length === 2 &&
    hex(shapeArabic("لا\nباب").split("\n")[0]) === "fefb",
);
check(
  "bidi: pure Arabic line fully reversed",
  hex(bidiVisualLine(shapeArabicLine("باب"))) === "fe8f fe8e fe91",
  hex(bidiVisualLine(shapeArabicLine("باب"))),
);
check(
  "bidi: Arabic + number + latin — 'دول 2024 hello' reads hello 2024 <ar>",
  (() => {
    const visual = bidiVisualLine(shapeArabicLine("دول 2024 hello"));
    return (
      visual.startsWith("hello 2024 ") &&
      hex(visual.slice("hello 2024 ".length)) === "fedd feed fea9"
    );
  })(),
  hex(bidiVisualLine(shapeArabicLine("دول 2024 hello"))),
);
check(
  "bidi: letter-bounded LTR words merge across spaces (hello world)",
  (() => {
    const shaped = shapeArabicLine("مرحبا hello world");
    const visual = bidiVisualLine(shaped);
    return visual.startsWith("hello world ");
  })(),
);
check(
  "bidi: digit-bounded neighbours never merge (UAX#9 honest)",
  (() => {
    const visual = bidiVisualLine(shapeArabicLine("مرحبا 2024 hello"));
    return visual.startsWith("hello 2024 ");
  })(),
  hex(bidiVisualLine(shapeArabicLine("مرحبا 2024 hello"))),
);
check(
  "bidi: brackets hug the number (mirror + reversal net effect)",
  (() => {
    const visual = bidiVisualLine(shapeArabicLine("دول (2024)"));
    return visual.startsWith("(2024)");
  })(),
  hex(bidiVisualLine(shapeArabicLine("دول (2024)"))),
);
check(
  "bidi: pure latin/digit/empty lines never throw",
  bidiVisualLine("hello") === "hello" &&
    bidiVisualLine("2024") === "2024" &&
    bidiVisualLine("") === "" &&
    bidiVisualLine("   ") === "   ",
);
check(
  "bidi: Arabic-Indic digits re-reverse as LTR tokens",
  (() => {
    const visual = bidiVisualLine(shapeArabicLine("دول ١٢٣٤ hello"));
    return visual.startsWith("hello ١٢٣٤ ");
  })(),
  hex(bidiVisualLine(shapeArabicLine("دول ١٢٣٤ hello"))),
);

/* ---------------- verdict ---------------- */

console.log(
  `\nSMOKE TRANSLATE-PDF: ${pass} passed, ${fail} failed${
    fail > 0 ? `\n  FAILURES:\n${failures.map((f) => `    - ${f}`).join("\n")}` : ""
  }`,
);
process.exit(fail > 0 ? 1 : 0);
