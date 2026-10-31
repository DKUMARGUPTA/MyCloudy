import {
  encryptDocument,
  parsePdf,
  type SecurityPermissions,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Change PDF permissions worker (PHASE-1 Batch C): owner-only AES-256
 * encryption via the engine's security handler — the document opens
 * WITHOUT a password, but the chosen restrictions (printing/copying/
 * editing/annotating/forms) ride the standard security handler. An empty
 * owner password gets a strong random one (the restrictions cannot be
 * casually lifted).
 *
 * Runs 100% on OUR OWN engine. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Cryptographically-random owner password (browsers + workers). */
function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export interface PermissionsRunResult {
  bytes: Uint8Array;
  /** The owner password in effect (random when the user left it empty). */
  ownerPassword: string;
  permissions: SecurityPermissions;
}

/** Resolve the permission set from options (pure — smoke-tested). */
export function resolvePermissions(
  values: OptionValues
): SecurityPermissions {
  const printingRaw = values.printing;
  return {
    printing:
      printingRaw === "none"
        ? false
        : printingRaw === "low"
          ? "lowResolution"
          : "highResolution",
    copying: values.copying !== false,
    modifying: values.modifying === true,
    annotating: values.annotating !== false,
    fillingForms: values.fillingForms !== false,
    contentAccessibility: true,
    documentAssembly: values.modifying === true,
  };
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runChangePermissions(
  bytes: Uint8Array,
  options: OptionValues
): Promise<PermissionsRunResult> {
  const permissions = resolvePermissions(options);
  const userOwner =
    typeof options.ownerPassword === "string"
      ? (options.ownerPassword as string)
      : "";
  const ownerPassword = userOwner.length > 0 ? userOwner : randomPassword();

  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(bytes);
  } catch {
    throw new Error("tool.errorEncrypted");
  }

  try {
    const saved = encryptDocument(doc, {
      userPassword: "",
      ownerPassword,
      algorithm: "AES-256",
      permissions,
    });
    return { bytes: saved, ownerPassword, permissions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /encrypt|password/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  let result: PermissionsRunResult;
  try {
    result = await runChangePermissions(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^perm\.|^tool\./.test(message) ? message : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-restricted.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: 1 },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
