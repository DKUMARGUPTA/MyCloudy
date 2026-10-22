import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";

import {
  buildPageSvg,
  classifySvgError,
  opsTable,
  parseSvgOptions,
  type SvgImagePayload,
  sanitizeSvgBase,
  SVG_MIME,
  svgOutputName,
  toFontInfo,
} from "./model";

/**
 * PDF → SVG worker (RB4-a) — 100% on-device, vector-first.
 *
 * pdf.js runs IN THIS WORKER (fake-worker mode, the pdfjs-common recipe):
 * every selected page's operator list is walked by the pure model and
 * translated into one standalone .svg (viewBox = page points, text kept
 * as selectable <text>, shapes as <rect>/<path>, embedded images as
 * base64 <image>). Nothing is rasterized, nothing leaves the device.
 *
 * Multi-page exports become multiple outputs — the shared ResultView
 * offers per-file downloads plus "Download all (ZIP)" (the pdf-to-images
 * plumbing). Scanned pages are honest: they export their vector
 * container (usually near-empty) — the FAQ points at pdf-to-png for
 * pixel-perfect raster copies.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Minimal pool surface (pdf.js PDFObjects, callback form). */
interface ObjsPool {
  get(objId: string, callback: (data: unknown) => void): null;
}

/** Await a (possibly late) named object from its pool. */
function resolveObj(pool: ObjsPool, objId: string): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    pool.get(objId, (data: unknown) => resolve(data));
  });
}

function poolFor(
  page: { objs: ObjsPool; commonObjs: ObjsPool },
  objId: string
): ObjsPool {
  return objId.startsWith("g_") ? page.commonObjs : page.objs;
}

/**
 * ImageBitmap payloads (browsers hand pdf.js decoded bitmaps) are
 * converted to raw RGBA through an OffscreenCanvas so the shared
 * clean-room PNG encoder can embed them. NOTE: never close pdf.js-owned
 * bitmaps — closing them behind pdf.js's back breaks later objs
 * resolutions in the same document (the extract-images QA lesson).
 */
function bitmapToRgba(
  bitmap: ImageBitmap
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const width = bitmap.width;
  const height = bitmap.height;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    return null;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

interface RawImageObj {
  width?: unknown;
  height?: unknown;
  kind?: unknown;
  bitmap?: unknown;
  data?: unknown;
}

function isBytes(
  value: unknown
): value is Uint8Array | Uint8ClampedArray {
  return (
    value instanceof Uint8Array || value instanceof Uint8ClampedArray
  );
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const opts = parseSvgOptions(options);

  const pdfjs = await loadPdfjsInWorker();
  const ops = opsTable(pdfjs.OPS as unknown as Record<string, unknown>);

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let renderedPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = sanitizeSvgBase(file.name);

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      // Worker-safe canvas factory — bitmap image payloads need
      // createElement (DOMCanvasFactory._createCanvas).
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }
    const single = pageNumbers.length === 1;

    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
      const page = (await doc.getPage(pageNumber)) as unknown as {
        getViewport: (params: { scale: number }) => {
          width: number;
          height: number;
          transform: number[];
        };
        getOperatorList: () => Promise<{
          fnArray: number[];
          argsArray: unknown[][];
        }>;
        objs: ObjsPool;
        commonObjs: ObjsPool;
        cleanup: () => void;
      };
      const viewport = page.getViewport({ scale: 1 });
      const opList = await page.getOperatorList();

      const ctx = {
        width: viewport.width,
        height: viewport.height,
        baseTransform: viewport.transform as [
          number,
          number,
          number,
          number,
          number,
          number
        ],
        includeImages: opts.includeImages,
        resolveFont: (ref: unknown): Promise<ReturnType<typeof toFontInfo>> => {
          if (typeof ref !== "string" || ref === "") {
            return Promise.resolve(null);
          }
          return resolveObj(poolFor(page, ref), ref).then(toFontInfo);
        },
        resolveImage: (
          objId: unknown
        ): Promise<SvgImagePayload | null> => {
          if (typeof objId !== "string" || objId === "") {
            return Promise.resolve(null);
          }
          return resolveObj(poolFor(page, objId), objId).then(
            (raw): SvgImagePayload | null => {
              if (raw === null || typeof raw !== "object") return null;
              const obj = raw as RawImageObj;
              const width = obj.width;
              const height = obj.height;
              if (typeof width !== "number" || typeof height !== "number") {
                return null;
              }
              if (obj.bitmap instanceof ImageBitmap) {
                const rgba = bitmapToRgba(obj.bitmap);
                return rgba === null
                  ? null
                  : { width: rgba.width, height: rgba.height, kind: 3, data: rgba.data };
              }
              if (!isBytes(obj.data)) return null;
              return {
                width,
                height,
                kind: typeof obj.kind === "number" ? obj.kind : 0,
                data: obj.data,
              };
            }
          );
        },
      };

      const { svg } = await buildPageSvg(ops, opList, ctx);
      page.cleanup();

      outputs.push({
        name: svgOutputName(base, pageNumber, single),
        mime: SVG_MIME,
        blob: new Blob([svg], { type: SVG_MIME }),
      });
      renderedPages += 1;

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

    await doc.cleanup();
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: renderedPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: classifySvgError(message),
    });
  });
};
