import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";

/**
 * Chat with PDF (R8) — extraction worker: pulls every page's selectable
 * text with pdf.js running INSIDE this worker (fake-worker mode, the
 * pdf-to-txt recipe). This is the ONLY thing that touches the file: the
 * PDF bytes stay on the device; just per-page text strings come out.
 *
 * Private protocol (no run-step, so not the shared WorkerRunRequest):
 *   → { type: "extract", file: ArrayBuffer }
 *   ← { type: "progress", page, total }
 *   ← { type: "pages", pages: { page, text }[] }
 *   ← { type: "error", code }   // "encrypted" | "corrupt"
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

function post(message: unknown): void {
  self.postMessage(message);
}

/**
 * Items → visual lines → text. Same grouping idea as pdf-to-txt's worker
 * (baseline within half a font height = same line; x-order inside a line;
 * space where the horizontal gap exceeds a quarter font), minus the flow /
 * dehyphenation pass — chat context does not need paragraph surgery, and
 * skipping it keeps this worker small and fast.
 */
function pageText(items: RawTextItem[]): string {
  const pieces: Piece[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0,
    );
    pieces.push({
      str: item.str,
      x,
      y,
      w: Number(item.width) || 0,
      size: size > 0 ? size : 10,
    });
  }
  if (pieces.length === 0) return "";

  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let current: Piece[] = [pieces[0]];
  let groupY = pieces[0].y;
  let tol = Math.max(1.5, pieces[0].size * 0.5);

  const flush = (): void => {
    current.sort((a, b) => a.x - b.x);
    const size = current[0].size;
    let text = "";
    let endX: number | null = null;
    for (const piece of current) {
      if (
        endX !== null &&
        piece.x - endX > size * 0.25 &&
        !text.endsWith(" ")
      ) {
        text += " ";
      }
      text += piece.str;
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    lines.push(text.replace(/\s+$/, ""));
  };

  for (let i = 1; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (Math.abs(piece.y - groupY) <= tol) {
      current.push(piece);
    } else {
      flush();
      current = [piece];
      groupY = piece.y;
      tol = Math.max(1.5, piece.size * 0.5);
    }
  }
  flush();
  return lines.join("\n");
}

async function extract(file: ArrayBuffer): Promise<void> {
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(file),
    // Worker-safe canvas factory — image pages need createElement
    // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  try {
    const total = doc.numPages;
    const pages: { page: number; text: string }[] = [];
    for (let n = 1; n <= total; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({ page: n, text: pageText(content.items as RawTextItem[]) });
      page.cleanup();
      post({ type: "progress", page: n, total });
    }
    post({ type: "pages", pages });
  } finally {
    doc.cleanup();
    await doc.destroy();
  }
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { type?: string; file?: ArrayBuffer } | null;
  if (data?.type !== "extract" || !(data.file instanceof ArrayBuffer)) return;
  extract(data.file).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    const code = /password/i.test(message) ? "encrypted" : "corrupt";
    post({ type: "error", code });
  });
};
