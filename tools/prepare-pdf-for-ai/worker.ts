import {
  decodeTextString,
  parsePdf,
} from "@/lib/own/pdf";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { pageText } from "../pdf-to-txt/text-layout";

/**
 * Prepare PDF for AI worker (PHASE-2): extracts every selected page's
 * text with pdf.js (fake-worker mode, the pdf-to-txt pipeline's
 * flow-layout builder) and emits a LlamaIndex-ready JSON array —
 * { text, metadata } documents per page (or one for the whole file).
 * Document-level metadata (title/author/dates) rides our own parser.
 *
 * Device-only: the File arrives by structured clone, the JSON Blob goes
 * back. Never touches the network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** The LlamaIndex Document JSON shape (JSONReader-compatible). */
export interface LlamaDoc {
  id_: string;
  text: string;
  metadata: Record<string, string | number>;
}

/** Document-level metadata read on our own parser (fast, no pdf.js). */
export function docInfo(bytes: Uint8Array): {
  title?: string;
  author?: string;
  subject?: string;
  creationDate?: string;
  modDate?: string;
} {
  try {
    const doc = parsePdf(bytes);
    const infoRef = doc.trailer.get("Info");
    if (!infoRef || infoRef.k !== "ref") return {};
    const infoObj = doc.getObject(infoRef.num);
    if (!infoObj || (infoObj.k !== "dict" && infoObj.k !== "stream")) return {};
    const read = (key: string): string | undefined => {
      const value = infoObj.m.get(key);
      if (value === undefined || value.k !== "str" && value.k !== "lstr" && value.k !== "hstr") {
        return undefined;
      }
      const text = decodeTextString((value as { b: Uint8Array }).b).trim();
      return text.length > 0 ? text : undefined;
    };
    const asDate = (key: string): string | undefined => {
      const raw = read(key);
      return raw; // PDF date strings (D:YYYYMMDD…) pass through as-is
    };
    return {
      title: read("Title"),
      author: read("Author"),
      subject: read("Subject"),
      creationDate: asDate("CreationDate"),
      modDate: asDate("ModDate"),
    };
  } catch {
    return {};
  }
}

/** Stable document id from the file name + page. */
function docId(fileName: string, pageId: number): string {
  const base = fileName.replace(/[^\w-]/g, "_").slice(0, 60);
  return `${base}__page_${pageId}`;
}

export interface PageExtract {
  pageNumber: number;
  text: string;
}

/**
 * Build the LlamaIndex document array (pure — smoke-tested):
 * per-page granularity keeps one { text, metadata } doc per page;
 * document mode joins the texts into one doc with total-pages metadata.
 */
export function buildLlamaDocs(
  fileName: string,
  totalPages: number,
  pages: readonly PageExtract[],
  info: ReturnType<typeof docInfo>,
  opts: { perPage: boolean; includeMeta: boolean }
): LlamaDoc[] {
  const docs: LlamaDoc[] = [];
  if (opts.perPage) {
    for (const page of pages) {
      const metadata: Record<string, string | number> = {
        file_path: fileName,
        page_id: page.pageNumber - 1,
        total_pages: totalPages,
        format: "PDF",
        type: "text",
      };
      if (opts.includeMeta) {
        if (info.title !== undefined) metadata.title = info.title;
        if (info.author !== undefined) metadata.author = info.author;
        if (info.subject !== undefined) metadata.subject = info.subject;
        if (info.creationDate !== undefined) metadata.creation_date = info.creationDate;
        if (info.modDate !== undefined) metadata.last_modified = info.modDate;
      }
      docs.push({
        id_: docId(fileName, page.pageNumber - 1),
        text: page.text,
        metadata,
      });
    }
    return docs;
  }
  const metadata: Record<string, string | number> = {
    file_path: fileName,
    total_pages: totalPages,
    format: "PDF",
    type: "text",
  };
  if (opts.includeMeta) {
    if (info.title !== undefined) metadata.title = info.title;
    if (info.author !== undefined) metadata.author = info.author;
  }
  docs.push({
    id_: docId(fileName, -1),
    text: pages.map((p) => p.text).join("\n\n"),
    metadata,
  });
  return docs;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const perPage = options.granularity !== "document";
  const includeMeta = options.includeMetadata !== false;
  const pagesSpec = String(options.pages ?? "all");

  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let pageCount = 0;
  /* R58 honesty stats for the result summary: documents emitted and
   * the chars/4 token estimate of their combined text. */
  let aiDocs = 0;
  let aiChars = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    post({
      type: "progress",
      runId,
      pct: Math.round(6 * (fileIndex / files.length)),
      stage: "reading",
    });

    const data = new Uint8Array(await file.arrayBuffer());
    const info = includeMeta ? docInfo(data) : {};
    const doc = await pdfjs.getDocument({
      data,
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const pageNumbers = parsePageSpec(pagesSpec, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }
    pageCount += pageNumbers.length;

    const extracts: PageExtract[] = [];
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i]! + 1; // 1-based in pdf.js
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      extracts.push({
        pageNumber,
        text: pageText(content.items as RawTextItem[], "flow"),
      });
      page.cleanup();
      post({
        type: "progress",
        runId,
        pct: Math.round(
          6 + (88 * ((fileIndex + (i + 1) / pageNumbers.length)) / files.length)
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }
    doc.cleanup();

    const docs = buildLlamaDocs(file.name, doc.numPages, extracts, info, {
      perPage,
      includeMeta,
    });
    aiDocs += docs.length;
    for (const d of docs) aiChars += d.text.length;
    const json = JSON.stringify(docs, null, 2);
    outputs.push({
      name: `${base}_llm.json`,
      mime: "application/json",
      blob: new Blob([json], { type: "application/json" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: outputs.length,
      pages: pageCount,
      ...(aiDocs > 0
        ? { aiDocs, aiTokens: Math.max(1, Math.round(aiChars / 4)) }
        : {}),
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /Invalid PDF|structure|corrupt/i.test(message)
      ? "tool.errorCorrupt"
      : /encrypt|password/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code });
  });
};
