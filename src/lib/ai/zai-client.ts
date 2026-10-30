import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * DocoPDF AI client adapter (R21) — server-side ONLY.
 *
 * WHY THIS EXISTS: z-ai-web-dev-sdk resolves its credentials from a
 * `.z-ai-config` FILE (cwd → home → /etc) that exists only inside the
 * dev sandbox, and the sandbox endpoint (`internal-api.z.ai`) resolves
 * to PRIVATE IPs (172.25.x.x). On Vercel the file is absent and the
 * endpoint is unreachable, so every AI route (chat / summarize /
 * translate) failed in production with a misleading "check your
 * connection" error.
 *
 * This adapter speaks the exact same HTTP contract as the SDK
 * (POST {baseUrl}/chat/completions + Bearer key + X-Z-AI-From: Z) but
 * resolves configuration in this order:
 *
 *   1. ENV (production): AI_BASE_URL + AI_API_KEY (required pair),
 *      optional AI_MODEL / AI_TOKEN / AI_CHAT_ID / AI_USER_ID.
 *      Any OpenAI-compatible public provider works (z.ai public API,
 *      OpenAI, Groq, OpenRouter, …) — set the vars on Vercel and the
 *      tools go live.
 *   2. FILE (sandbox): the same `.z-ai-config` paths the SDK reads,
 *      so local dev + smokes keep working unchanged.
 *   3. Neither → aiNotConfigured (routes answer 503 with an honest
 *      "not enabled on the server" message instead of a fake network
 *      error).
 *
 * Bonus over the SDK: chatComplete() accepts an AbortSignal, so the
 * route deadline races can actually CANCEL the underlying fetch
 * (closes the R19 P3 "SDK abort" backlog item).
 */

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  /** Public providers require a model; the internal sandbox one infers it. */
  model?: string;
  token?: string;
  chatId?: string;
  userId?: string;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("aiNotConfigured");
    this.name = "AiNotConfiguredError";
  }
}

/* --------------------------- resolution --------------------------- */

/** Pure: build a config from an env object (testable, no process touch). */
export function configFromEnv(
  env: Record<string, string | undefined>,
): AiConfig | null {
  const baseUrl = env.AI_BASE_URL?.trim();
  const apiKey = env.AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: env.AI_MODEL?.trim() || undefined,
    token: env.AI_TOKEN?.trim() || undefined,
    chatId: env.AI_CHAT_ID?.trim() || undefined,
    userId: env.AI_USER_ID?.trim() || undefined,
  };
}

const CONFIG_FILE_PATHS = (): string[] => [
  path.join(process.cwd(), ".z-ai-config"),
  path.join(os.homedir(), ".z-ai-config"),
  "/etc/.z-ai-config",
];

/** Pure: try to read one of the SDK's config files (sandbox path). */
export async function configFromFile(
  filePaths: string[],
): Promise<AiConfig | null> {
  for (const filePath of filePaths) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
        baseUrl?: unknown;
        apiKey?: unknown;
        model?: unknown;
        token?: unknown;
        chatId?: unknown;
        userId?: unknown;
      };
      if (typeof raw.baseUrl === "string" && typeof raw.apiKey === "string") {
        return {
          baseUrl: raw.baseUrl.replace(/\/+$/, ""),
          apiKey: raw.apiKey,
          model: typeof raw.model === "string" ? raw.model : undefined,
          token: typeof raw.token === "string" ? raw.token : undefined,
          chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
          userId: typeof raw.userId === "string" ? raw.userId : undefined,
        };
      }
    } catch {
      // Absent or invalid — try the next path.
    }
  }
  return null;
}

let cached: Promise<AiConfig | null> | undefined;

/**
 * Env first, then the SDK's config files. The result is cached for the
 * process lifetime (env vars only change on redeploy; the sandbox file
 * is static), so per-request cost is zero after the first call.
 */
export function getAiConfig(): Promise<AiConfig | null> {
  cached ??= (async () => {
    const fromEnv = configFromEnv(process.env);
    if (fromEnv) return fromEnv;
    return configFromFile(CONFIG_FILE_PATHS());
  })();
  return cached;
}

/** True when an AI backend is reachable (env vars or sandbox config). */
export function aiConfigured(): Promise<boolean> {
  return getAiConfig().then((config) => config !== null);
}

/* --------------------------- completion --------------------------- */

export type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiChatRequest = {
  messages: AiChatMessage[];
  /** Internal endpoint default: thinking off. Public providers: omitted. */
  thinking?: { type: "disabled" | "enabled" };
};

/** Minimal slice of the completion response the routes consume. */
export type AiCompletion = {
  choices?: { message?: { content?: unknown } }[];
};

/** Build the header set once per config (SDK contract, byte-identical). */
function headersFor(config: AiConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-Z-AI-From": "Z",
  };
  if (config.chatId) headers["X-Chat-Id"] = config.chatId;
  if (config.userId) headers["X-User-Id"] = config.userId;
  if (config.token) headers["X-Token"] = config.token;
  return headers;
}

/**
 * One chat completion. Throws AiNotConfiguredError when no backend is
 * configured; network/HTTP failures propagate to the caller's retry
 * loop exactly like the SDK's did.
 */
export async function chatComplete(
  request: AiChatRequest,
  options?: { config?: AiConfig | null; signal?: AbortSignal },
): Promise<AiCompletion> {
  // `config` is only resolved when NOT explicitly passed — an explicit
  // null means "force unconfigured" (testable honest-503 path).
  const config =
    options?.config === undefined ? await getAiConfig() : options.config;
  if (!config) throw new AiNotConfiguredError();

  // Public providers (model set) reject unknown body fields — send the
  // `thinking` switch only to the sandbox-style backend that supports it.
  const body: Record<string, unknown> = { messages: request.messages };
  if (config.model) body.model = config.model;
  else body.thinking = request.thinking ?? { type: "disabled" };

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headersFor(config),
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) {
    // Never leak the body to clients — routes log server-side only.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `ai-http-${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return (await response.json()) as AiCompletion;
}
