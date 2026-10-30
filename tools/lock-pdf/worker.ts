import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  LOCK_IDS,
  SecurityError,
  lockPdf,
  verifyLocked,
  type LockRequest,
} from "../lock-common/security";

/**
 * Lock PDF worker (PRD §8.4): encrypts with AES-256 (default) or
 * AES-128 via the OWN PDF engine (P6-w-b — the standard security
 * handler in src/lib/own/pdf/security.ts) — open password, owner
 * password and the permission set. On-device only. Post-save
 * verification: the output must open with the password and must NOT
 * open without it.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function parseRequest(options: WorkerRunRequest["options"]): LockRequest {
  const str = (id: string, fallback: string): string => {
    const v = options[id];
    return typeof v === "string" ? v : fallback;
  };
  const bool = (id: string, fallback: boolean): boolean => {
    const v = options[id];
    return typeof v === "boolean" ? v : fallback;
  };
  return {
    userPw: str(LOCK_IDS.userPw, ""),
    ownerPw: str(LOCK_IDS.ownerPw, ""),
    alg: str(LOCK_IDS.alg, "aes256") === "aes128" ? "aes128" : "aes256",
    permissions: {
      printing: bool(LOCK_IDS.print, true),
      copying: bool(LOCK_IDS.copy, false),
      modifying: bool(LOCK_IDS.modify, false),
      annotating: bool(LOCK_IDS.annotate, true),
      fillingForms: bool(LOCK_IDS.forms, true),
      contentAccessibility: bool(LOCK_IDS.access, true),
    },
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const req = parseRequest(options);

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  const { bytes: locked, pageCount } = await lockPdf(bytes, req);

  post({ type: "progress", runId, pct: 82, stage: "saving" });
  await verifyLocked(locked, req.userPw);

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-locked.pdf`,
      mime: "application/pdf",
      blob: new Blob([locked as BlobPart], { type: "application/pdf" }),
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
