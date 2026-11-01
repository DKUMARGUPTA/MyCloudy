import { CreateContext } from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeBmp } from "../img-common/bmp";
import { encodePng } from "../img-common/png-encode";

/**
 * BMP → PDF worker (PHASE-3 batch 3): decodes every BMP with OUR OWN
 * reader (24/32-bit BI_RGB, 8-bit palettes, top-down and bottom-up),
 * re-encodes to PNG (own encoder — no canvas dependency) and lays each
 * image on its own page at 96-DPI scale. Up to 20 files per run.
 * Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function outputBaseName(name: string): string {
  return (
    name
      .replace(/\.(bmp|dib)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "image"
  );
}

const BMP_MAGIC = [0x42, 0x4d]; // 'BM'

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(4 + (88 * fileIndex) / files.length),
      stage: "reading",
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== BMP_MAGIC[0] || bytes[1] !== BMP_MAGIC[1]) {
      post({ type: "error", runId, code: "b2p.errorNotBmp", detail: file.name });
      return;
    }

    let image;
    try {
      image = decodeBmp(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        runId,
        code: /^b2p\./.test(message) ? message : "b2p.errorUnsupportedBmp",
        detail: file.name,
      });
      return;
    }

    const ctx = CreateContext.create();
    const png = encodePng(image.width, image.height, image.rgba);
    const embedded = ctx.embedPng(png);
    // 96-DPI assumption (the BMP writer's own 72-ppm header): px → points.
    const ptW = (image.width * 72) / 96;
    const ptH = (image.height * 72) / 96;
    ctx.addPage(ptW, ptH).drawImage(embedded, {
      x: 0,
      y: 0,
      width: ptW,
      height: ptH,
    });
    totalPages += 1;

    const saved = ctx.write();
    outputs.push({
      name: `${outputBaseName(file.name)}.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
