import { CreateContext, type CreateImage } from "@/lib/own/pdf";
import { unzipSync } from "@/lib/own/zip";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeBmp } from "../img-common/bmp";
import { encodePng } from "../img-common/png-encode";

/**
 * CBZ → PDF worker (PHASE-3 batch 3): unzips the comic archive with OUR
 * OWN unzipSync, sorts the pages naturally (page-2 before page-10), and
 * lays each image on its own page — JPEG/PNG embedded byte-direct (no
 * re-encode), other raster formats routed through our BMP decoder.
 * One comic → one PDF. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(cbz|zip)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "comic";
}

/** Natural sort: page-2 < page-10 (plain lexicographic would flip them). */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

const ZIP_MAGIC = [0x50, 0x4b]; // 'PK'

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 5, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== ZIP_MAGIC[0] || bytes[1] !== ZIP_MAGIC[1]) {
    post({ type: "error", runId, code: "c2d.errorNotArchive", detail: file.name });
    return;
  }

  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    post({ type: "error", runId, code: "c2d.errorBadArchive", detail: file.name });
    return;
  }

  // Page candidates, natural-sorted, Mac junk skipped.
  const pageNames = Object.keys(entries)
    .filter(
      (name) =>
        !name.startsWith("__MACOSX/") &&
        !name.endsWith("/") &&
        /\.(jpe?g|png|bmp|gif)$/i.test(name)
    )
    .sort(naturalCompare);

  if (pageNames.length === 0) {
    post({ type: "error", runId, code: "c2d.errorNoPages", detail: file.name });
    return;
  }
  if (pageNames.length > 2000) {
    post({ type: "error", runId, code: "c2d.errorTooManyPages" });
    return;
  }

  const ctx = CreateContext.create();
  let embeddedCount = 0;

  for (let i = 0; i < pageNames.length; i += 1) {
    const name = pageNames[i]!;
    const data = entries[name]!;

    // Detect the true type by magic (rename-proof), default by extension.
    const isPng =
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    const isJpeg = data[0] === 0xff && data[1] === 0xd8;
    const isBmp = data[0] === 0x42 && data[1] === 0x4d;
    const isGif = data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46;

    try {
      let image: CreateImage | null = null;
      let pxW = 0;
      let pxH = 0;

      if (isJpeg) {
        image = ctx.embedJpeg(data);
      } else if (isPng) {
        image = ctx.embedPng(data);
      } else if (isBmp) {
        const decoded = decodeBmp(data);
        image = ctx.embedPng(encodePng(decoded.width, decoded.height, decoded.rgba));
        pxW = decoded.width;
        pxH = decoded.height;
      } else if (isGif) {
        post({ type: "error", runId, code: "c2d.errorGif", detail: name });
        return;
      } else {
        post({ type: "error", runId, code: "c2d.errorUnknownImage", detail: name });
        return;
      }

      if (image !== null) {
        const w = image.width;
        const h = image.height;
        // 96-DPI assumption: comic scans are screen-resolution art.
        const ptW = pxW > 0 ? (pxW * 72) / 96 : w;
        const ptH = pxH > 0 ? (pxH * 72) / 96 : h;
        ctx.addPage(ptW, ptH).drawImage(image, {
          x: 0,
          y: 0,
          width: ptW,
          height: ptH,
        });
        embeddedCount += 1;
      }
    } catch {
      post({ type: "error", runId, code: "c2d.errorBadImage", detail: name });
      return;
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (84 * (i + 1)) / pageNames.length),
      stage: "processing",
      detail: { page: i + 1, pages: pageNames.length },
    });
  }

  post({ type: "progress", runId, pct: 93, stage: "saving" });
  const saved = ctx.write();
  const outputs = [
    {
      name: `${safeBaseName(file.name)}.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: embeddedCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
