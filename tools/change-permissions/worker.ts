import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  encryptDocument,
  listPages,
  openEncrypted,
  parsePdf,
  PdfError,
} from "@/lib/own/pdf";

/**
 * Change PDF permissions worker (R52, P1-c) — the restrictions-only lock.
 *
 * encryptDocument with an EMPTY user password: the output opens for
 * everyone but carries the chosen permission flags (enforced by
 * well-behaved readers). Talks to the own-engine standard security
 * handler directly (lockPdf would flatten the low-resolution printing
 * choice) with FULL SecurityPermissions fidelity. Post-save verification:
 * the output must open with NO password at all — the perm-only guarantee.
 * 100% on-device.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface PermOptions {
  ownerPw: string;
  alg: "aes256" | "aes128";
  printing: "highResolution" | "lowResolution" | false;
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  documentAssembly: boolean;
}

function resolveOptions(options: WorkerRunRequest["options"]): PermOptions {
  const str = (id: string, fallback: string): string => {
    const v = options[id];
    return typeof v === "string" ? v : fallback;
  };
  const bool = (id: string, fallback: boolean): boolean => {
    const v = options[id];
    return typeof v === "boolean" ? v : fallback;
  };
  const printing = str("permPrinting", "highResolution");
  return {
    ownerPw: str("ownerPassword", ""),
    alg: str("algorithm", "aes256") === "aes128" ? "aes128" : "aes256",
    printing:
      printing === "highResolution" || printing === "lowResolution"
        ? printing
        : false,
    copying: bool("permCopy", true),
    modifying: bool("permModify", false),
    annotating: bool("permAnnotate", true),
    fillingForms: bool("permForms", true),
    contentAccessibility: bool("permAccess", true),
    documentAssembly: bool("permAssemble", false),
  };
}

/** AES-128 (handler revision ≤ 4) pads passwords to Latin-1 bytes only. */
function latinSafe(password: string): boolean {
  for (let i = 0; i < password.length; i += 1) {
    if (password.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveOptions(options);

  // Owner password guards (the open password is intentionally empty; the
  // engine refuses BOTH-empty encryption — and restrictions nobody can
  // guard would be meaningless, so the owner password is required).
  if (opts.ownerPw.length === 0) {
    post({ type: "error", runId, code: "tool.errorNoPassword" });
    return;
  }
  if (opts.ownerPw.length < 6) {
    post({ type: "error", runId, code: "tool.errorOwnerPwShort" });
    return;
  }
  if (opts.alg === "aes128" && !latinSafe(opts.ownerPw)) {
    post({ type: "error", runId, code: "tool.errorPwChars" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  let saved: Uint8Array;
  let pageCount: number;
  try {
    const doc = parsePdf(bytes);
    pageCount = listPages(doc).length;
    saved = encryptDocument(doc, {
      userPassword: "",
      ownerPassword: opts.ownerPw,
      algorithm: opts.alg === "aes128" ? "AES-128" : "AES-256",
      permissions: {
        printing: opts.printing,
        copying: opts.copying,
        modifying: opts.modifying,
        annotating: opts.annotating,
        fillingForms: opts.fillingForms,
        contentAccessibility: opts.contentAccessibility,
        documentAssembly: opts.documentAssembly,
      },
    });
  } catch (error: unknown) {
    if (error instanceof PdfError && error.code === "encrypted") {
      post({ type: "error", runId, code: "tool.errorAlreadyEncrypted" });
      return;
    }
    if (error instanceof Error && /password/i.test(error.message)) {
      post({ type: "error", runId, code: "tool.errorPwChars" });
      return;
    }
    post({ type: "error", runId, code: "tool.errorCorrupt", detail: file.name });
    return;
  }

  // Perm-only guarantee: the output must open with NO password.
  post({ type: "progress", runId, pct: 82, stage: "saving" });
  const opened = openEncrypted(saved, "");
  if (opened.kind !== "ok") {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${fileBaseName(file.name)}-restricted.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
  });
};
