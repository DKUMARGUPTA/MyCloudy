/**
 * Smoke test: AI client adapter (R21 — production AI-config fix).
 *
 * The summarize / chat / translate routes used to import
 * z-ai-web-dev-sdk directly, whose `.z-ai-config` FILE (cwd → home →
 * /etc) exists only in the dev sandbox — on Vercel every AI call died
 * with a misleading "check your connection" error. The
 * `src/lib/ai/zai-client.ts` adapter speaks the same HTTP contract but
 * resolves env vars FIRST (any OpenAI-compatible provider) and reports
 * an honest `aiNotConfigured` (503) when nothing is configured.
 *
 * This smoke pins, SDK-free:
 *   1. env resolution — valid pair, trailing-slash trim, optional
 *      fields, missing-key rejection
 *   2. file resolution — real sandbox paths resolve; bogus paths null
 *   3. getAiConfig() — resolves in this environment (sandbox file)
 *   4. chatComplete() — one REAL round-trip against the sandbox
 *      backend (proves the fetch contract matches the SDK's), an
 *      explicit-null config throws AiNotConfiguredError, and a dead
 *      endpoint fails with the ai-http- error prefix
 *   5. api-models — all three tools carry aiNotConfigured: 503
 *   6. surfaces/worker — the code paths map aiNotConfigured to the
 *      new i18n keys (en + hi, real Devanagari)
 *
 * Run: bun scripts/smoke-ai-config.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AiNotConfiguredError,
  aiConfigured,
  chatComplete,
  configFromEnv,
  configFromFile,
  getAiConfig,
} from "../src/lib/ai/zai-client";
import {
  CHAT_ERROR_STATUS,
} from "../tools/chat-with-pdf/api-model";
import {
  SUMMARIZE_ERROR_STATUS,
} from "../tools/summarize-pdf/api-model";
import {
  TRANSLATE_ERROR_STATUS,
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

async function main(): Promise<void> {
  console.log("\n== env resolution ==");

  const envCfg = configFromEnv({
    AI_BASE_URL: "https://api.example.com/v1/",
    AI_API_KEY: "sk-test",
    AI_MODEL: "test-model",
    AI_TOKEN: "tok",
    AI_CHAT_ID: "cid",
    AI_USER_ID: "uid",
  });
  check(
    "env: valid pair builds config (trailing slash trimmed, optionals carried)",
    envCfg !== null &&
      envCfg.baseUrl === "https://api.example.com/v1" &&
      envCfg.apiKey === "sk-test" &&
      envCfg.model === "test-model" &&
      envCfg.token === "tok" &&
      envCfg.chatId === "cid" &&
      envCfg.userId === "uid",
  );
  check(
    "env: blank strings treated as absent",
    configFromEnv({ AI_BASE_URL: "   ", AI_API_KEY: "sk" }) === null &&
      configFromEnv({ AI_BASE_URL: "https://x", AI_API_KEY: "" }) === null,
  );
  check(
    "env: neither var → null",
    configFromEnv({}) === null && configFromEnv({ AI_MODEL: "m" }) === null,
  );

  console.log("\n== file resolution (sandbox paths) ==");

  const fileCfg = await configFromFile([
    join(process.cwd(), ".z-ai-config"),
    join(process.env.HOME ?? "/home/z", ".z-ai-config"),
    "/etc/.z-ai-config",
  ]);
  check(
    "file: sandbox config resolves with baseUrl + apiKey",
    fileCfg !== null &&
      fileCfg.baseUrl.startsWith("https://") &&
      typeof fileCfg.apiKey === "string" &&
      fileCfg.apiKey.length > 0,
  );
  check(
    "file: bogus paths → null (the Vercel reality)",
    (await configFromFile(["/nonexistent/a", "/nonexistent/b"])) === null,
  );

  console.log("\n== getAiConfig / aiConfigured ==");

  const resolved = await getAiConfig();
  check(
    "getAiConfig: resolves in this environment",
    resolved !== null && resolved.baseUrl.startsWith("https://"),
  );
  check("aiConfigured: true in sandbox", (await aiConfigured()) === true);

  console.log("\n== chatComplete contract ==");

  // 1. Real round-trip against the sandbox backend (same HTTP contract
  //    the SDK used — this is the proof the adapter is not a lookalike).
  try {
    const completion = await chatComplete({
      messages: [
        { role: "user", content: "Reply with exactly: OK" },
      ],
    });
    const content = completion.choices?.[0]?.message?.content;
    check(
      "chatComplete: REAL round-trip returns non-empty content",
      typeof content === "string" && content.trim().length > 0,
      typeof content === "string" ? `"${content.trim().slice(0, 40)}"` : "",
    );
  } catch (error) {
    check(
      "chatComplete: REAL round-trip returns non-empty content",
      false,
      error instanceof Error ? error.message.slice(0, 120) : String(error),
    );
  }

  // 2. Explicit null config → AiNotConfiguredError (the honest 503 path).
  try {
    await chatComplete(
      { messages: [{ role: "user", content: "x" }] },
      { config: null },
    );
    check("chatComplete: null config throws AiNotConfiguredError", false);
  } catch (error) {
    check(
      "chatComplete: null config throws AiNotConfiguredError",
      error instanceof AiNotConfiguredError,
    );
  }

  // 3. Dead endpoint → ai-http-* / network error (retry loop's domain).
  try {
    await chatComplete(
      { messages: [{ role: "user", content: "x" }] },
      { config: { baseUrl: "http://127.0.0.1:1", apiKey: "k" } },
    );
    check("chatComplete: dead endpoint fails (refused/ai-http)", false);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "";
    check(
      "chatComplete: dead endpoint fails (refused/ai-http)",
      msg.length > 0 && !(error instanceof AiNotConfiguredError),
      msg.slice(0, 60),
    );
  }

  console.log("\n== api-models carry the new code ==");

  check(
    "api-models: aiNotConfigured → 503 in all three tools",
    SUMMARIZE_ERROR_STATUS.aiNotConfigured === 503 &&
      CHAT_ERROR_STATUS.aiNotConfigured === 503 &&
      TRANSLATE_ERROR_STATUS.aiNotConfigured === 503,
  );

  console.log("\n== surfaces + worker map the new code ==");

  const summarizeSurface = read("tools/summarize-pdf/surface.tsx");
  const chatSurface = read("tools/chat-with-pdf/surface.tsx");
  const translateWorker = read("tools/translate-pdf/worker.ts");
  check(
    "surfaces: summarize + chat map aiNotConfigured → errNotConfigured keys",
    summarizeSurface.includes('code === "aiNotConfigured"') &&
      summarizeSurface.includes("summarize.errNotConfigured") &&
      chatSurface.includes('code === "aiNotConfigured"') &&
      chatSurface.includes("chat.errNotConfigured"),
  );
  check(
    "worker: translate maps aiNotConfigured → tool.errorTranslateNotConfigured",
    translateWorker.includes("translate-aiNotConfigured") &&
      translateWorker.includes("tool.errorTranslateNotConfigured"),
  );

  console.log("\n== routes rewired (no SDK import) ==");

  const sumRoute = read("src/app/api/summarize/route.ts");
  const chatRoute = read("src/app/api/chat/route.ts");
  const trRoute = read("src/app/api/translate/route.ts");
  check(
    "routes: all three use the adapter, none import z-ai-web-dev-sdk",
    sumRoute.includes("@/lib/ai/zai-client") &&
      chatRoute.includes("@/lib/ai/zai-client") &&
      trRoute.includes("@/lib/ai/zai-client") &&
      !sumRoute.includes("z-ai-web-dev-sdk") &&
      !chatRoute.includes("z-ai-web-dev-sdk") &&
      !trRoute.includes("z-ai-web-dev-sdk"),
  );
  check(
    "routes: early aiNotConfigured gate before the retry loop",
    sumRoute.includes('fail("aiNotConfigured")') &&
      chatRoute.includes('fail("aiNotConfigured")') &&
      trRoute.includes('fail("aiNotConfigured")'),
  );

  console.log("\n== i18n keys (en + hi) ==");

  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, unknown>;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Record<string, unknown>;
  const enSum = en.summarize as Record<string, string>;
  const hiSum = hi.summarize as Record<string, string>;
  const enChat = en.chat as Record<string, string>;
  const hiChat = hi.chat as Record<string, string>;
  const enTool = en.tool as Record<string, string>;
  const hiTool = hi.tool as Record<string, string>;
  check(
    "i18n: errNotConfigured present with real copy",
    typeof enSum.errNotConfigured === "string" &&
      enSum.errNotConfigured.length > 20 &&
      typeof enChat.errNotConfigured === "string" &&
      typeof enTool.errorTranslateNotConfigured === "string",
  );
  check(
    "i18n: Hindi copy is real Devanagari",
    /[\u0900-\u097F]/.test(hiSum.errNotConfigured) &&
      /[\u0900-\u097F]/.test(hiChat.errNotConfigured) &&
      /[\u0900-\u097F]/.test(hiTool.errorTranslateNotConfigured),
  );

  /* ------------------------------ verdict ------------------------------ */
  console.log(
    `\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed${failures.length ? `\n  failures: ${failures.join(" | ")}` : ""}\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

void main();
