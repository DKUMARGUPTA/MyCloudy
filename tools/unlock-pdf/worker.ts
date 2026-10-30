import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  UNLOCK_IDS,
  SecurityError,
  parseUnlockMeta,
  unlockPdf,
  verifyUnlocked,
} from "../lock-common/security";

/**
 * Unlock PDF worker (PRD §8.4): removes encryption for documents you can
 * open — either the open password is known (mode 1) or the file opens
 * freely and only owner restrictions get stripped (mode 2). The output
 * is REBUILT through the OWN engine's whole-document rewriter (P6-w-b —
 * the decrypted replacement table + a deleted /Encrypt object) so no
 * "/Encrypt" trailer remnant can survive; verified post-save. Unknown-
 * password cracking is not offered (and not possible) — honest errors
 * otherwise.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const pwRaw = options[UNLOCK_IDS.pw];
  const password = typeof pwRaw === "string" ? pwRaw : "";
  const meta = parseUnlockMeta(options[UNLOCK_IDS.meta]);

  post({ type: "progress", runId, pct: 12, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  post({ type: "progress", runId, pct: 48, stage: "processing" });
  const { bytes: unlocked, pageCount } = await unlockPdf(bytes, password, meta);

  post({ type: "progress", runId, pct: 84, stage: "saving" });
  await verifyUnlocked(unlocked);

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-unlocked.pdf`,
      mime: "application/pdf",
      blob: new Blob([unlocked as BlobPart], { type: "application/pdf" }),
    },
  ];
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const code =
      error instanceof SecurityError
        ? error.code
        : (() => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (/password/i.test(message)) return "tool.errorWrongPassword";
            if (/encrypt/i.test(message)) return "tool.errorAlreadyEncrypted";
            return "tool.errorCorrupt";
          })();
    post({ type: "error", runId: data.runId, code });
  });
};
