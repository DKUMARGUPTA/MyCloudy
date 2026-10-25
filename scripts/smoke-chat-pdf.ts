/**
 * Smoke test: Chat with PDF (R8).
 *
 * Locks the deterministic core of the first (and only) server-backed
 * DocoPDF tool — the LLM round-trip itself is covered by browser E2E,
 * everything that CAN be pinned statically is pinned here:
 *
 *   1. model vectors — buildDocExcerpt (fits-all / head+tail trim with the
 *      honest [[omitted]] marker / per-page truncation cap / defensive
 *      single-huge-page), sanitizeChatMessages (roles, control chars,
 *      clamps, last-N), cleanUserText, isLikelyScanned, CHAT_LIMITS shape
 *   2. api-model — zod schema accepts valid bodies, rejects every honest
 *      limit violation; CHAT_API mirrors CHAT_LIMITS (they can never
 *      drift); the system prompt carries the citation + no-invention
 *      contract; buildDocMessage wraps the excerpt
 *   3. wiring — registry/configs/surfaces all reference chat-with-pdf;
 *      config is viewerOnly (no run step); route.ts is stateless, zod-
 *      gated and retries; the worker uses the pdf.js shim + posts progress
 *   4. i18n — chat.* key sets identical in en/hi, all 5 quick prompts ×
 *      label+prompt present, and every {param} the surface passes exists
 *
 * Run: bun scripts/smoke-chat-pdf.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHAT_LIMITS,
  buildDocExcerpt,
  cleanUserText,
  isLikelyScanned,
  pageMarker,
  sanitizeChatMessages,
} from "../tools/chat-with-pdf/model";
import {
  CHAT_API,
  buildDocMessage,
  buildSystemPrompt,
  chatBodySchema,
  DOC_ACK_MESSAGE,
} from "../tools/chat-with-pdf/api-model";

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

const ROOT = "/home/z/my-project";

/* ---------------- 1. model vectors ---------------- */

console.log("\n§1 model — excerpt builder, sanitizer, limits");

/* Literal format pins — the system prompt PROMISES "[[p N]]" markers, so
   pageMarker must emit exactly that shape (a self-referential check that
   rebuilds expectations through pageMarker() would mutate along with it). */
check(
  "pageMarker emits the literal [[p N]] shape the prompt promises",
  pageMarker(3) === "[[p 3]]" && pageMarker(12) === "[[p 12]]",
);

check(
  "CHAT_LIMITS budget is sane (24k..96k, cap ≤ budget)",
  CHAT_LIMITS.excerptBudget >= 24_000 &&
    CHAT_LIMITS.excerptBudget <= 96_000 &&
    CHAT_LIMITS.pageCharCap <= CHAT_LIMITS.excerptBudget,
);

const smallPages = [
  { page: 1, text: "Alpha document intro. " + "x".repeat(50) },
  { page: 2, text: "Beta middle content. " + "y".repeat(50) },
  { page: 3, text: "Gamma conclusion. " + "z".repeat(50) },
];
const small = buildDocExcerpt(smallPages);
check(
  "small doc fits whole: 3 pages included, 0 omitted",
  small.pagesTotal === 3 &&
    small.pagesIncluded === 3 &&
    small.omittedPages === 0,
);
check(
  "fits-whole excerpt carries all three [[p N]] markers in order",
  small.excerpt.includes(pageMarker(1)) &&
    small.excerpt.includes(pageMarker(2)) &&
    small.excerpt.includes(pageMarker(3)) &&
    small.excerpt.indexOf(pageMarker(1)) <
      small.excerpt.indexOf(pageMarker(2)) &&
    small.excerpt.indexOf(pageMarker(2)) <
      small.excerpt.indexOf(pageMarker(3)),
);
check(
  "fits-whole excerpt is exactly the stitched pages",
  small.excerpt ===
    smallPages.map((p) => `${pageMarker(p.page)}\n${p.text.trim()}`).join("\n"),
);

// 12 pages × 6k chars = 72k > 48k budget → head+tail trim required.
const bigPages: Array<{ page: number; text: string }> = [];
for (let i = 1; i <= 12; i += 1) {
  bigPages.push({
    page: i,
    text: `Page ${i} unique-content ` + `p${i} `.repeat(1500),
  });
}
const big = buildDocExcerpt(bigPages);
check(
  "over-budget doc: some middle pages omitted (head+tail)",
  big.pagesTotal === 12 &&
    big.omittedPages > 0 &&
    big.pagesIncluded === 12 - big.omittedPages,
  `${big.pagesIncluded} in, ${big.omittedPages} out`,
);
check(
  "over-budget excerpt keeps page 1 and exactly one honest [[omitted]] marker",
  big.excerpt.includes(pageMarker(1)) &&
    (big.excerpt.match(/\[\[omitted\]\]/g)?.length ?? 0) === 1,
);
check(
  "over-budget excerpt keeps the LAST page (tail strategy)",
  big.excerpt.includes(pageMarker(12)),
);
check(
  "over-budget excerpt drops a strict middle page (say 6..(head end))",
  !big.excerpt.includes(pageMarker(6)) || big.omittedPages < 6,
);
check(
  "sentChars never exceeds the budget",
  big.sentChars <= CHAT_LIMITS.excerptBudget,
  `${big.sentChars} ≤ ${CHAT_LIMITS.excerptBudget}`,
);

const hugePage = [
  { page: 1, text: "A".repeat(CHAT_LIMITS.pageCharCap + 9_000) },
  { page: 2, text: "B".repeat(30) },
];
const capped = buildDocExcerpt(hugePage, 10_000);
check(
  "per-page cap: one giant page gets the …[page truncated]… marker",
  capped.excerpt.includes("…[page truncated]…") ||
    capped.excerpt.length <= 10_000 + 200,
  `excerpt ${capped.excerpt.length} chars`,
);

const empty = buildDocExcerpt([]);
check(
  "empty pages array → honest zero totals",
  empty.excerpt === "" &&
    empty.pagesTotal === 0 &&
    empty.pagesIncluded === 0 &&
    empty.omittedPages === 0,
);

const junk = buildDocExcerpt([
  { page: -3, text: "negative page clamps to 1" },
  { page: 2.4, text: "fractional page rounds" },
]);
check(
  "defensive: junk page numbers clamp to >= 1",
  junk.excerpt.includes(pageMarker(1)) && !junk.excerpt.includes("[[p 0]]") && !junk.excerpt.includes("[[p -"),
  junk.excerpt.slice(0, 40),
);

const nl = buildDocExcerpt([
  { page: 1, text: "para one\n\n\n\n\npara two   \n  " },
]);
check(
  "normalizePageText collapses 3+ newlines and trailing spaces",
  nl.excerpt.includes("para one\n\npara two") && !nl.excerpt.includes("   \n"),
);

/* sanitizer */

const dirty = [
  { role: "system", content: "sneaky system" },
  { role: "user", content: "hello\x00\x07world" },
  { role: "assistant", content: "  ok  " },
  { role: "user", content: "" },
  { role: "bogus", content: "???" },
  null,
  42,
];
const cleaned = sanitizeChatMessages(dirty);
check(
  "sanitizer keeps only user/assistant with real content",
  cleaned.length === 2 &&
    cleaned[0].role === "user" &&
    cleaned[0].content === "helloworld" &&
    cleaned[1].content === "ok",
);

const many = sanitizeChatMessages(
  Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `m${i}`,
  })),
);
check(
  `sanitizer trims to the last ${CHAT_LIMITS.historyMessages} messages`,
  many.length === CHAT_LIMITS.historyMessages &&
    many[many.length - 1].content === "m39",
  `first kept: ${many[0].content}`,
);

const longUser = cleanUserText("a".repeat(50_000));
check(
  `cleanUserText hard-caps at ${CHAT_LIMITS.userMessageChars}`,
  longUser.length === CHAT_LIMITS.userMessageChars,
);
check(
  "cleanUserText strips control chars but keeps newlines",
  cleanUserText("line1\r\nline2\x1fok").endsWith("line1\nline2ok"),
);
check("sanitizeChatMessages rejects non-array input", sanitizeChatMessages("nope").length === 0 && sanitizeChatMessages(null).length === 0);

check(
  "isLikelyScanned: image-only doc (<40 chars) is flagged",
  isLikelyScanned([{ page: 1, text: "   " }, { page: 2, text: "" }]) &&
    !isLikelyScanned([
      { page: 1, text: "Real selectable text long enough to clear the 40-char threshold." },
    ]) &&
    isLikelyScanned([]),
);

/* ---------------- 2. api-model ---------------- */

console.log("\n§2 api-model — schema, prompt contract, mirrors");

const validBody = {
  messages: [{ role: "user", content: "What is on page 2?" }],
  docExcerpt: `${pageMarker(1)}\nhello`,
  docName: "report.pdf",
  locale: "en" as const,
};
check("zod accepts a valid body", chatBodySchema.safeParse(validBody).success);
check(
  "zod defaults locale to en when omitted",
  chatBodySchema.safeParse({
    messages: validBody.messages,
    docExcerpt: "x",
  }).success,
);

check(
  "zod rejects empty messages",
  !chatBodySchema.safeParse({ ...validBody, messages: [] }).success,
);
check(
  "zod rejects system role injection",
  !chatBodySchema.safeParse({
    ...validBody,
    messages: [{ role: "system", content: "no" }],
  }).success,
);
check(
  "zod rejects an over-long excerpt (budget + marker slack)",
  !chatBodySchema.safeParse({
    ...validBody,
    docExcerpt: "e".repeat(CHAT_API.maxExcerptChars + 1),
  }).success,
);
check(
  "zod rejects over-long history",
  !chatBodySchema.safeParse({
    ...validBody,
    messages: Array.from({ length: CHAT_API.maxMessages + 1 }, () => ({
      role: "user",
      content: "hi",
    })),
  }).success,
);
check(
  "zod rejects a message over the per-message cap",
  !chatBodySchema.safeParse({
    ...validBody,
    messages: [{ role: "user", content: "a".repeat(CHAT_API.maxMessageChars + 1) }],
  }).success,
);

check(
  "CHAT_API mirrors CHAT_LIMITS (never drift)",
  CHAT_API.maxMessages === CHAT_LIMITS.historyMessages &&
    CHAT_API.maxMessageChars === CHAT_LIMITS.assistantMessageChars &&
    CHAT_API.maxExcerptChars >= CHAT_LIMITS.excerptBudget,
);

const sys = buildSystemPrompt();
check(
  "system prompt: cite pages, refuse to invent, match language",
  sys.includes("[[p N]]") &&
    sys.includes("(p. 3)") &&
    /never invent/i.test(sys) &&
    /Hindi/i.test(sys),
);
const docMsg = buildDocMessage("EXCERPT-BODY", "my file.pdf");
check(
  "buildDocMessage wraps name + excerpt + end marker",
  docMsg.includes('"my file.pdf"') &&
    docMsg.includes("EXCERPT-BODY") &&
    /\(End of document excerpt\.\)/.test(docMsg),
);
check(
  "buildDocMessage survives an empty name honestly",
  buildDocMessage("x", "  ").includes('"document"') &&
    buildDocMessage("x").includes('"document"'),
);
check(
  "DOC_ACK_MESSAGE is short and honest",
  DOC_ACK_MESSAGE.length > 10 && DOC_ACK_MESSAGE.length < 200,
);

/* ---------------- 3. wiring locks ---------------- */

console.log("\n§3 wiring — registry, config, surface, route, worker");

const read = (p: string): string =>
  readFileSync(join(ROOT, p), "utf8") as string;

const registry = read("src/lib/tools/registry.ts");
const configs = read("src/lib/tools/configs.ts");
const surfaces = read("src/lib/tools/surfaces.tsx");
const route = read("src/app/api/chat/route.ts");
const worker = read("tools/chat-with-pdf/worker.ts");
const config = read("tools/chat-with-pdf/config.ts");
const surface = read("tools/chat-with-pdf/surface.tsx");

check(
  'registry def: id "chat-with-pdf", category "view", enabled',
  /id: "chat-with-pdf",\s*category: "view",/.test(registry) &&
    /id: "chat-with-pdf"/.test(registry),
);
check(
  "configs.ts imports + maps the chat config",
  configs.includes('from "../../../tools/chat-with-pdf/config"') &&
    configs.includes("[chatWithPdf.toolId]: chatWithPdf"),
);
check(
  "surfaces.tsx imports + registers ChatSurface",
  surfaces.includes('from "../../../tools/chat-with-pdf/surface"') &&
    /"chat-with-pdf": ChatSurface,/.test(surfaces),
);
check(
  "config is viewerOnly + landingSurface (hero on landing, no run step)",
  /viewerOnly: true/.test(config) &&
    /landingSurface: true/.test(config) &&
    /maxFiles: 1/.test(config) &&
    /options: \[\]/.test(config),
);
check(
  "config pins its own howKeys (never view-pdf's fallback steps)",
  /howKeys: \["chat\.how1", "chat\.how2", "chat\.how3"\]/.test(config),
);
check(
  "config copy is honest about the excerpt-only upload",
  /never leave the device/i.test(config) ||
    /never leaves the device/i.test(config),
);
check(
  "route: zod schema gates the SDK, nodejs runtime",
  route.includes("chatBodySchema.safeParse") &&
    route.includes('runtime = "nodejs"'),
);
check(
  "route: retry loop + deadline + honest error codes",
  /CHAT_API\.attempts/.test(route) &&
    /withDeadline/.test(route) &&
    route.includes("emptyAnswer") &&
    route.includes("timeout"),
);
check(
  "route: no storage, no logging of user content",
  !/console\.(log|error|warn)\(/.test(route) &&
    !/prisma|localStorage|fs\.write/i.test(route),
);
check(
  "worker: pdf.js with the worker shim + progress posts",
  worker.includes("loadPdfjsInWorker") &&
    worker.includes("ownerDocument: workerDocumentShim()") &&
    /type: "progress"/.test(worker) &&
    /type: "pages"/.test(worker) &&
    /type: "error"/.test(worker),
);
check(
  "worker: password + corruption map to honest codes",
  /encrypted/.test(worker) && /corrupt/.test(worker),
);
check(
  "surface: posts ONLY excerpt+history to /api/chat",
  surface.includes('"/api/chat"') &&
    /docExcerpt: current\.doc\.excerpt/.test(surface) &&
    !/arrayBuffer\(\)[\s\S]{0,200}fetch/.test(surface),
);
check(
  "surface: OCR chain hand-off for scanned docs",
  surface.includes('onChain("ocr-pdf")') &&
    surface.includes("chat.scannedTitle"),
);

/* ---------------- 4. i18n parity + params ---------------- */

console.log("\n§4 i18n — chat.* parity in both locales");

type Dict = Record<string, unknown>;
const en = JSON.parse(read("src/i18n/en.json")) as Dict;
const hi = JSON.parse(read("src/i18n/hi.json")) as Dict;

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
  "catalog parity holds globally after the chat insertion",
  enKeys.size === hiKeys.size && [...enKeys].every((k) => hiKeys.has(k)),
  `${enKeys.size} = ${hiKeys.size}`,
);

const chatKeys = [...enKeys].filter((k) => k.startsWith("chat."));
const hiChatKeys = [...hiKeys].filter((k) => k.startsWith("chat."));
check(
  `chat.* key sets identical in en/hi (${chatKeys.length} keys)`,
  chatKeys.length === hiChatKeys.length &&
    chatKeys.every((k) => hiChatKeys.includes(k)),
);

const wantTop = [
  "heroTitle", "heroBody", "heroFree", "dropHere",
  "docPages", "docChars", "pagesOmitted", "removeFile",
  "extracting", "extractingPage", "deviceOnly",
  "errEncryptedTitle", "errEncryptedBody", "errCorruptTitle", "errCorruptBody",
  "retry", "chooseOther", "scannedTitle", "scannedBody", "openOcr",
  "askAnything", "aiLabel", "copy", "copied", "regenerate", "newChat",
  "thinking", "placeholder", "send", "messagesLabel", "disclaimer",
  "errTitle", "errSend", "errTimeout", "errBadRequest",
];
for (const k of wantTop) {
  if (!chatKeys.includes(`chat.${k}`)) {
    check(`chat.${k} present`, false);
  }
}
check(
  `all ${wantTop.length} top-level chat.* keys present`,
  wantTop.every((k) => chatKeys.includes(`chat.${k}`)),
);
check(
  "howKeys chat.how1..3 exist in the catalog (en + hi)",
  ["chat.how1", "chat.how2", "chat.how3"].every(
    (k) => enKeys.has(k) && hiKeys.has(k),
  ),
);

const wantQp = [
  "summarize", "keyPoints", "actionItems", "explainSimple", "extractDates",
];
check(
  "5 quick prompts × label+prompt present in en",
  wantQp.every(
    (q) =>
      chatKeys.includes(`chat.qp.${q}.label`) &&
      chatKeys.includes(`chat.qp.${q}.prompt`),
  ),
);
check(
  "5 quick prompts × label+prompt present in hi",
  wantQp.every(
    (q) =>
      hiChatKeys.includes(`chat.qp.${q}.label`) &&
      hiChatKeys.includes(`chat.qp.${q}.prompt`),
  ),
);

/* every t("chat.<key>") the surface renders exists in the catalog;
   template keys (chat.qp.${id}.*) are expanded over the pinned ids. */
const QP_IDS = ["summarize", "keyPoints", "actionItems", "explainSimple", "extractDates"];
const usedKeys = new Set<string>();
const re = /t\(`chat\.([^`)]+)`\)/g;
let m: RegExpExecArray | null;
while ((m = re.exec(surface)) !== null) {
  const raw = m[1];
  if (raw.includes("${")) {
    if (raw === "qp.${id}.label" || raw === "qp.${id}.prompt") {
      for (const id of QP_IDS) usedKeys.add(`chat.qp.${id}.${raw.endsWith("prompt") ? "prompt" : "label"}`);
    }
  } else {
    usedKeys.add(`chat.${raw}`);
  }
}
const re2 = /t\("chat\.([a-zA-Z0-9.]+)"\)/g;
while ((m = re2.exec(surface)) !== null) {
  usedKeys.add(`chat.${m[1]}`);
}
const missing = [...usedKeys].filter((k) => !enKeys.has(k));
check(
  `every t("chat.*") key used by the surface exists (${usedKeys.size} keys)`,
  missing.length === 0,
  missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
);

/* the param-bearing keys keep their params in BOTH locales */
const paramKeys: Array<[string, string[]]> = [
  ["chat.docPages", ["count"]],
  ["chat.docChars", ["count"]],
  ["chat.pagesOmitted", ["count"]],
  ["chat.extractingPage", ["page", "total"]],
];
for (const [key, params] of paramKeys) {
  const enVal = String(
    (en.chat as Record<string, string>)[key.replace("chat.", "")] ?? "",
  );
  const hiVal = String(
    (hi.chat as Record<string, string>)[key.replace("chat.", "")] ?? "",
  );
  check(
    `${key}: params (${params.join(", ")}) present in en AND hi`,
    params.every((p) => enVal.includes(`{${p}`)) &&
      params.every((p) => hiVal.includes(`{${p}`)),
    `en="${enVal}" hi="${hiVal}"`,
  );
}

/* Devanagari really is in the Hindi catalog (not copied English) */
const hiChat = hi.chat as Record<string, unknown>;
check(
  "hi chat strings are real Devanagari, not English copies",
  /[\u0900-\u097F]/.test(String(hiChat.heroTitle ?? "")) &&
    /[\u0900-\u097F]/.test(String(hiChat.scannedBody ?? "")) &&
    /[\u0900-\u097F]/.test(
      String(
        (
          (hiChat.qp as Record<string, Record<string, string>>)
            .summarize as { prompt: string }
        ).prompt,
      ),
    ),
);

/* ---------------- verdict ---------------- */

console.log(
  `\nSMOKE CHAT-PDF: ${pass} passed, ${fail} failed${
    fail > 0 ? `\n  FAILURES:\n${failures.map((f) => `    - ${f}`).join("\n")}` : ""
  }`,
);
process.exit(fail > 0 ? 1 : 0);
