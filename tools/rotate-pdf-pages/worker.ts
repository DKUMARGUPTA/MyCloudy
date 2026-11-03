import { PDFDocument, degrees } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Rotate PDF pages — device-only worker (PRD §2.3: pdf-lib, MIT).
 *
 * Loads each PDF, sets /Rotate on the selected pages, saves, and posts
 * real progress (reading → processing → saving) per file and per page.
 * Never touches the network; receives/sends File and Blob objects only.
 */

const DEGREES: Record<string, number> = {
  left: -90,
  right: 90,
  "180": 180,
};

/** Strips path separators + unsafe chars from a download display name. */
function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const direction = typeof options.direction === "string" ? options.direction : "right";
  const pagesSpec = typeof options.pages === "string" ? options.pages : "all";
  const delta = DEGREES[direction] ?? 90;

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const totalFiles = files.length;

  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
    const file = files[fileIndex];
    const fileBase = ((totalFiles - 1) / totalFiles) * 100; // per-file span

    post({
      type: "progress",
      runId,
      pct: Math.round(fileIndex * fileBase),
      stage: "reading",
      detail: { page: fileIndex + 1, pages: totalFiles },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    const pageCount = doc.getPageCount();

    const selected = parsePageSpec(pagesSpec, pageCount);
    if (selected === null) {
      post({ type: "error", runId, code: "tool.errorInvalidPages", detail: pagesSpec });
      return;
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(fileIndex * fileBase + fileBase * 0.15),
      stage: "processing",
      detail: { pages: selected.length },
    });

    const pages = doc.getPages();
    for (let i = 0; i < selected.length; i += 1) {
      const page = pages[selected[i]];
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
      // Real per-page progress (PRD §6.3: "Page x of y").
      post({
        type: "progress",
        runId,
        pct: Math.round(
          fileIndex * fileBase +
            fileBase * (0.15 + 0.7 * ((i + 1) / selected.length))
        ),
        stage: "processing",
        detail: { page: i + 1, pages: selected.length },
      });
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(fileIndex * fileBase + fileBase * 0.85),
      stage: "saving",
    });

    const saved = await doc.save({ useObjectStreams: true });
    const suffix = totalFiles > 1 ? `-${fileIndex + 1}` : "";
    const name = `${safeBaseName(file.name)}-rotated${suffix}.pdf`;
    outputs.push({
      name,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

  post({ type: "result", runId, outputs });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // pdf-lib's encrypted-PDF error is surfaced as a typed code for i18n.
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
