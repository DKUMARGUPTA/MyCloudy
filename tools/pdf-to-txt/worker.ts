import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";

/**
 * PDF → text worker (PRD §8.6): extracts selectable text with pdf.js
 * running INSIDE this worker (fake-worker mode, same recipe as
 * pdf-to-images). Two layouts:
 *  - "flow":  lines merged into paragraphs (gap heuristics + dehyphenation)
 *  - "lines": one output line per visual line on the page
 * Optional `───── Page N ─────` separators between pages.
 *
 * Scanned PDFs (no selectable text at all) end with an honest error instead
 * of an empty file — OCR ships in a later phase. Device-only, as everywhere.
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface TextPiece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

interface TextLine {
  text: string;
  y: number;
  size: number;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/** Collects the page's text pieces, filtered and position-tagged. */
function collectPieces(items: RawTextItem[]): TextPiece[] {
  const pieces: TextPiece[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Font height (vertical scale of the text matrix) drives every spacing
    // tolerance below — one number adapts the heuristics to any font size.
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const w = Number(item.width) || 0;
    pieces.push({ str: item.str, x, y, w, size: size > 0 ? size : 10 });
  }
  return pieces;
}

/**
 * Groups pieces into visual lines: same line while the baseline stays within
 * half a font height (absorbs sub/superscripts and rounding). Inside a line
 * a space is inserted wherever the horizontal gap exceeds a quarter font —
 * pdf.js emits separate items per Tj operator without carrying spaces.
 */
function buildLines(pieces: TextPiece[]): TextLine[] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * 0.5);
    }
  }
  groups.push(current);

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const size = group[0].size;
    let text = "";
    let endX: number | null = null;
    for (const piece of ordered) {
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
    return { text: text.replace(/\s+$/, ""), y: group[0].y, size };
  });
}

/** Letter class that keeps its script intact across a line break. */
const SCRIPT = "A-Za-z\\u0900-\\u097F\\u00C0-\\u024F";

/**
 * Flow layout: joins lines into paragraphs. A baseline gap noticeably larger
 * than one line height starts a new paragraph; hyphenated line endings merge
 * with the next line (the hyphen is dropped only before a lowercase letter,
 * so a genuine "e-Mail" at line end stays intact before a capital).
 */
function joinFlow(lines: TextLine[]): string {
  const paragraphs: string[] = [];
  let buf = "";
  let prevY: number | null = null;
  let prevSize = 10;

  for (const line of lines) {
    const text = line.text;
    if (text.length === 0) continue;

    if (buf.length === 0) {
      buf = text;
    } else if (prevY !== null && prevY - line.y > prevSize * 1.7) {
      // Clear vertical gap → paragraph break.
      paragraphs.push(buf);
      buf = text;
    } else if (
      new RegExp(`[${SCRIPT}]-$`).test(buf) &&
      new RegExp(`^[a-z\\u0900-\\u097F\\u00DF-\\u00FF]`).test(text)
    ) {
      // Dehyphenate: "exam-" + "ple" → "example".
      buf = buf.slice(0, -1) + text;
    } else {
      buf += " " + text;
    }
    prevY = line.y;
    prevSize = line.size;
  }
  if (buf.length > 0) paragraphs.push(buf);

  return paragraphs.join("\n\n");
}

/** Lines layout: every visual line verbatim, one per row. */
function joinLines(lines: TextLine[]): string {
  return lines
    .filter((line) => line.text.length > 0)
    .map((line) => line.text)
    .join("\n");
}

function pageText(items: RawTextItem[], layout: string): string {
  const lines = buildLines(collectPieces(items));
  return layout === "lines" ? joinLines(lines) : joinFlow(lines);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const layout = options.layout === "lines" ? "lines" : "flow";
  const pageMarks = options.pageMarks === true;

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      // Worker-safe canvas factory — image pages need createElement
      // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const pageNumbers = parsePageSpec(
      String(options.pages ?? "all"),
      doc.numPages
    );
    if (pageNumbers === null || pageNumbers.length === 0) {
      doc.cleanup();
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    const chunks: string[] = [];
    let fileChars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      page.cleanup();

      const text = pageText(content.items as RawTextItem[], layout);
      chunks.push(text);
      totalPages += 1;
      fileChars += text.replace(/\s/g, "").length;

      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (i + 1) / pageNumbers.length) / files.length) * 95
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }
    doc.cleanup();

    // Scans have zero selectable text — fail honestly instead of shipping
    // an empty file (the PRD's OCR fallback is a later phase).
    if (fileChars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const markPages = pageMarks && pageNumbers.length > 1;
    const body = chunks
      .map((text, i) =>
        markPages
          ? `${i === 0 ? "" : "\n\n"}───── Page ${pageNumbers[i] + 1} ─────\n${text}`
          : text
      )
      .join(markPages ? "" : "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim();

    outputs.push({
      name: `${base}.txt`,
      mime: "text/plain;charset=utf-8",
      blob: new Blob([body + "\n"], { type: "text/plain;charset=utf-8" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
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
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
