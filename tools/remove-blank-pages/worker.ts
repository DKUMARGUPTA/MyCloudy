import {
  decodeStreamBytes,
  latin1,
  listPages,
  organizePages,
  parseForOrganize,
  PdfError,
  resolve,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  planRemoveBlank,
  resolveRemoveBlankOptions,
} from "./engine";

/**
 * Remove blank pages worker (PHASE-1 Batch B): sniffs every page's
 * content streams (decode → tokenize → marking-operator check) and
 * rebuilds the document without the blanks, on OUR OWN engine.
 * Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface RemoveBlankRunResult {
  bytes: Uint8Array;
  pages: number;
  removed: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runRemoveBlank(
  bytes: Uint8Array,
  options: OptionValues
): Promise<RemoveBlankRunResult> {
  const opts = resolveRemoveBlankOptions(options);

  let parsed: ReturnType<typeof parseForOrganize>;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  const pageCount = parsed.pages.length;
  if (pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  const findings = planRemoveBlank(
    pageCount,
    (i) => parsed.pages[i]?.dict as unknown as Map<string, unknown> | undefined,
    (i) => {
      const page = parsed.pages[i]!;
      const contents = resolve(parsed.doc, page.dict.get("Contents"));
      if (contents === undefined) return null;
      const parts: string[] = [];
      const collect = (o: typeof contents): void => {
        if (o?.k === "stream") {
          try {
            const dec = decodeStreamBytes(o.raw, o.m);
            parts.push(latin1(dec, 0, dec.length));
          } catch {
            // Undecodable → keep page (conservative).
          }
        } else if (o?.k === "arr") {
          for (const item of o.items) {
            const resolved = resolve(parsed.doc, item);
            if (resolved !== undefined) collect(resolved);
          }
        }
      };
      collect(contents);
      return parts.join("\n");
    },
    opts
  );

  if (findings.blanks.length >= pageCount) {
    throw new Error("rb.errorAllBlank");
  }

  const blankSet = new Set(findings.blanks);
  const plan: PlanEntry[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    if (!blankSet.has(i)) {
      plan.push({ kind: "page", src: i });
    }
  }

  try {
    const saved = organizePages(parsed, plan);
    return {
      bytes: saved,
      pages: plan.length,
      removed: findings.blanks.length,
    };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
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
  let result: RemoveBlankRunResult;
  try {
    result = await runRemoveBlank(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^rb\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-blanks-removed.pdf`,
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
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
