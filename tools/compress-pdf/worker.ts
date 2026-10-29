import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  PdfError,
  listPages,
  parsePdf,
  rewriteDocument,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";
import { fileBaseName } from "../stamp-common/layout";
import {
  collectImageCandidates,
  dedupeImageXObjects,
  imageReplacement,
  resolveParams,
  stripAllMetadataOwn,
} from "./engine";
import { recompressCandidate } from "../compress-common/recompress";

/**
 * Compress PDF worker (PRD §7.5, device mode) — OWN ENGINE (P6-r).
 *
 * Re-encodes embedded photos as JPEG (quality + max pixel size), keeps
 * text/fonts/vector art untouched — selectable text stays selectable.
 * DCTDecode images decode via the browser's native JPEG decoder
 * (createImageBitmap); Flate/LZW/… images decode via the engine's pure
 * decodeStreamBytes and are interpreted by colorspace into an ImageData.
 * Every replacement is size-guarded: unless the re-encoded JPEG is clearly
 * smaller, the original stream is kept — output can only shrink per
 * image, never regress.
 *
 * BEFORE the re-encode loop, byte-identical duplicate image XObjects are
 * merged onto one shared object (R4-b) — letterheads and stamped logos
 * embed one copy per page; all but the first are pure waste. Deduping
 * first also means each unique photo re-encodes exactly once, and the
 * merged result is what every reference then sees re-encoded.
 * The merge is verified byte-for-byte (signature + full compare) and
 * counted honestly in the result detail (dedupedImages/dedupeBytesSaved).
 *
 * Saving rides the engine's preserve-numbers rewriter with object
 * streams (pdf-lib `save({useObjectStreams: true})` parity — catalog,
 * names and every untouched object survive byte-comparable).
 *
 * Device-only: the File arrives by structured clone, the PDF Blob goes
 * back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * The structural load: encrypted files refuse with the honest code,
 * everything unreadable is corrupt. R6-b: the toast NAMES the file that
 * stopped the run (merge-pdf standard) — both refusals carry the name.
 */
function loadDocument(
  bytes: Uint8Array,
  runId: number,
  name: string,
): ParsedPdf | null {
  try {
    return parsePdf(bytes);
  } catch (error: unknown) {
    if (error instanceof PdfError && error.code === "encrypted") {
      post({
        type: "error",
        runId,
        code: "tool.errorEncrypted",
        detail: name,
      });
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /password|encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt",
      detail: name,
    });
    return null;
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const params = resolveParams(options as Record<string, unknown>);
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let dedupedImages = 0;
  let dedupeBytesSaved = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    post({
      type: "progress",
      runId,
      pct: Math.round(((fileIndex + 0.05) / files.length) * 100),
      stage: "reading",
      detail: { page: fileIndex + 1, pages: files.length },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = loadDocument(bytes, runId, file.name);
    if (doc === null) return;
    totalPages += listPages(doc).length;

    // R4-b: merge byte-identical image XObjects FIRST — every reference
    // then shares one object, and unique photos re-encode exactly once.
    const dedupe = dedupeImageXObjects(doc);
    dedupedImages += dedupe.mergedCount;
    dedupeBytesSaved += dedupe.bytesSaved;

    const candidates = collectImageCandidates(doc);
    const replacements = new Map<number, PdfObj>();
    const deletions = new Set<number>(dedupe.deletions);

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const result = await recompressCandidate(
        candidate,
        params.quality,
        params.maxDim,
        params.grayscale
      );
      if (result) {
        const [num, replacement] = imageReplacement(
          candidate,
          result.bytes,
          result.width,
          result.height
        );
        replacements.set(num, replacement);
      }
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (i + 1) / candidates.length) / files.length) * 88 + 5
        ),
        stage: "processing",
        detail: { page: i + 1, pages: candidates.length },
      });
    }

    let dropInfo = false;
    if (params.stripMetadata) {
      const strip = stripAllMetadataOwn(doc);
      for (const num of strip.deletions) deletions.add(num);
      dropInfo = strip.dropInfo;
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(((fileIndex + 0.94) / files.length) * 100),
      stage: "saving",
    });
    const saved = rewriteDocument(doc, {
      replacements,
      deletions,
      dropInfo,
      objectStreams: true,
    });
    outputs.push({
      name: `${fileBaseName(file.name)}-compressed.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: outputs.length,
      pages: totalPages,
      ...(dedupedImages > 0 ? { dedupedImages, dedupeBytesSaved } : {}),
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
