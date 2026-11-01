import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { applyLayerOps, type LayerOps } from "./engine";

/**
 * PDF layers worker (PHASE-3 batch 4): the surface probe lists the OCG
 * tree (own parser, no pdf.js), the user toggles visibility / adds /
 * deletes layers, and THIS worker is the authority — it re-reads the
 * document itself and applies the serialized ops (object-number keyed,
 * never trusting UI names) via /OCProperties surgery on OUR OWN engine.
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

/** Parse + validate the ops payload (bad entries dropped, not trusted). */
export function parseOps(raw: unknown): LayerOps {
  if (typeof raw !== "string" || raw.length === 0) {
    return { toggles: [], adds: [], deletes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { toggles: [], adds: [], deletes: [] };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { toggles: [], adds: [], deletes: [] };
  }
  const rec = parsed as {
    toggles?: unknown;
    adds?: unknown;
    deletes?: unknown;
  };
  const validNum = (v: unknown): v is number =>
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5_000_000;

  const toggles: NonNullable<LayerOps["toggles"]> = [];
  if (Array.isArray(rec.toggles)) {
    for (const item of rec.toggles) {
      if (item === null || typeof item !== "object") continue;
      const t = item as { num?: unknown; visible?: unknown };
      if (validNum(t.num)) {
        toggles.push({ num: t.num, visible: t.visible === true });
      }
    }
  }

  const adds: NonNullable<LayerOps["adds"]> = [];
  if (Array.isArray(rec.adds)) {
    for (const item of rec.adds) {
      if (item === null || typeof item !== "object") continue;
      const a = item as { name?: unknown; parent?: unknown };
      if (typeof a.name === "string" && a.name.trim().length > 0) {
        adds.push({
          name: a.name,
          parent: validNum(a.parent) ? a.parent : undefined,
        });
      }
    }
  }

  const deletes: number[] = [];
  if (Array.isArray(rec.deletes)) {
    for (const item of rec.deletes) {
      if (validNum(item)) deletes.push(item);
    }
  }

  return { toggles, adds, deletes };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 55, stage: "processing" });
  const ops = parseOps((options as OptionValues).ops);
  let result;
  try {
    result = applyLayerOps(bytes, ops);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^pl\.|^tool\./.test(message)
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
      name: `${safeBaseName(file.name)}-layers.pdf`,
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
    detail: {
      files: 1,
      pages: result.toggled + result.added + result.deleted,
      toggled: result.toggled,
      added: result.added,
      deleted: result.deleted,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
