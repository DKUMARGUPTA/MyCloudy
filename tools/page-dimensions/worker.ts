import {
  PdfError,
  listPages,
  parsePdf,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Page dimensions worker (PHASE-3): reads every page's boxes + rotation
 * on OUR OWN parser (read-only) and emits a tidy text report per file.
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

const PT_PER_MM = 72 / 25.4;
const PT_PER_IN = 72;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function boxLine(
  label: string,
  box: readonly number[]
): string {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return `${label.padEnd(10)}${fmt(w)} × ${fmt(h)} pt   ${fmt(w / PT_PER_MM)} × ${fmt(h / PT_PER_MM)} mm   ${fmt(w / PT_PER_IN)} × ${fmt(h / PT_PER_IN)} in`;
}

/** Render one file's dimension report (pure — smoke-tested). */
export function renderReport(
  fileName: string,
  pages: Array<{
    mediaBox: [number, number, number, number];
    cropBox: [number, number, number, number];
    rotate: number;
  }>
): string {
  const lines: string[] = [];
  lines.push(`Page dimensions report`);
  lines.push(`=====================`);
  lines.push(`File: ${fileName}`);
  lines.push(`Pages: ${pages.length}`);
  lines.push("");
  const cropDiffers = pages.some(
    (p) =>
      Math.abs(p.cropBox[0] - p.mediaBox[0]) > 0.01 ||
      Math.abs(p.cropBox[1] - p.mediaBox[1]) > 0.01 ||
      Math.abs(p.cropBox[2] - p.mediaBox[2]) > 0.01 ||
      Math.abs(p.cropBox[3] - p.mediaBox[3]) > 0.01
  );
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]!;
    lines.push(`Page ${i + 1}${page.rotate !== 0 ? ` (rotated ${page.rotate}°)` : ""}`);
    lines.push(boxLine("MediaBox:", page.mediaBox));
    if (cropDiffers) {
      lines.push(boxLine("CropBox:", page.cropBox));
    }
    lines.push("");
  }
  lines.push(`Generated on-device by DocoPDF — the PDF was not modified.`);
  return lines.join("\n");
}

/** Page facts from parsed bytes. */
export function pageFacts(bytes: Uint8Array): Array<{
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotate: number;
}> {
  const doc = parsePdf(bytes);
  return listPages(doc).map((p) => ({
    mediaBox: p.mediaBox,
    cropBox: p.cropBox,
    rotate: p.rotate,
  }));
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let pages = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (86 * i) / files.length),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let text: string;
    try {
      const facts = pageFacts(bytes);
      pages = facts.length;
      text = renderReport(file.name, facts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
      post({ type: "error", runId, code });
      return;
    }
    outputs.push({
      name: `${safeBaseName(file.name)}-dimensions.txt`,
      mime: "text/plain",
      blob: new Blob([text], { type: "text/plain" }),
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
