import { zipSync, type Zippable } from "@/lib/own/zip";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * PDFs to ZIP worker (R52, P1-c) — pure packager.
 *
 * No PDF parsing at all: locked/signed/corrupted-but-PDF files ride
 * through byte-identically. Own ZIP engine (src/lib/own/zip), STORE by
 * default (PDFs are already deflated inside), deflate for scans. On-device
 * only — nothing is uploaded, nothing is re-saved.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** "%PDF-" magic-byte guard (the DropZone already checks; the worker re-checks). */
function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** Base name without the .pdf extension, filesystem-hostile chars squashed. */
function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Archive-safe unique names: a.pdf, a.pdf, b.pdf → a.pdf, a-2.pdf, b.pdf. */
function uniqueArchiveNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((original) => {
    const base = safeBaseName(original);
    const taken = used.get(base) ?? 0;
    used.set(base, taken + 1);
    return taken === 0 ? `${base}.pdf` : `${base}-${taken + 1}.pdf`;
  });
}

interface ZipOptions {
  level: 0 | 6;
}

function resolveOptions(options: OptionValues): ZipOptions {
  return {
    level: options.compression === "deflate" ? 6 : 0,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length < 2) {
    post({ type: "error", runId, code: "tool.errorNeedTwoFiles" });
    return;
  }
  const opts = resolveOptions(options);

  /* Read every file up-front (progress per file, typed refusals). */
  const payloads: Uint8Array[] = [];
  const names: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(6 + (i / files.length) * 70),
      stage: "reading",
      detail: { page: i + 1, pages: files.length },
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikePdf(bytes)) {
      post({
        type: "error",
        runId,
        code: "tool.errorCorrupt",
        detail: file.name,
      });
      return;
    }
    payloads.push(bytes);
    names.push(file.name);
  }

  post({ type: "progress", runId, pct: 82, stage: "processing" });
  const archiveNames = uniqueArchiveNames(names);
  const entries: Zippable = {};
  for (let i = 0; i < payloads.length; i += 1) {
    entries[archiveNames[i]!] = payloads[i]!;
  }
  const zipped = zipSync(entries, { level: opts.level });

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const outName =
    files.length === 1
      ? `${safeBaseName(names[0]!)}.zip`
      : `${safeBaseName(names[0]!)}-batch.zip`;
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outName,
        mime: "application/zip",
        blob: new Blob([zipped as unknown as BlobPart], {
          type: "application/zip",
        }),
      },
    ],
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
  });
};
