import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  classifyWebOptError,
  collectUnreferencedObjects,
  countObjectStreams,
  recompressFlateStreams,
  resolveParams,
  stripWebMetadata,
} from "./engine";

/**
 * Web optimize PDF worker (RB3-b, device mode).
 *
 * Structural web tune-up, honest end to end: unreferenced objects are
 * counted and dropped, optional XMP/producer metadata is stripped (Title/
 * Author survive), every FlateDecode stream is re-deflated at level 9
 * (replace-if-smaller only), and the save packs loose objects into
 * compressed /ObjStm containers when asked. No fake /Linearized flag is
 * ever written — the FAQ explains what real linearization is and why this
 * tool does not claim it.
 *
 * Device-only: the File arrives by structured clone, the PDF Blob goes
 * back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const params = resolveParams(options as Record<string, unknown>);
  const outputs: { name: string; mime: string; blob: Blob }[] = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    post({
      type: "progress",
      runId,
      pct: 8,
      stage: "reading",
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    const pageCount = doc.getPageCount();
    if (pageCount < 1) throw new Error("pdf has no pages");

    // 1. Unreferenced objects: reachability walk + safe removal.
    post({
      type: "progress",
      runId,
      pct: 24,
      stage: "processing",
    });
    const garbage = collectUnreferencedObjects(doc);

    // 2. Optional metadata strip (XMP + Info producer/creator).
    let metadataStripped = false;
    if (params.stripMetadata) {
      const strip = stripWebMetadata(doc);
      metadataStripped =
        strip.xmpRemoved || strip.producerRemoved || strip.creatorRemoved;
    }
    post({
      type: "progress",
      runId,
      pct: 38,
      stage: "processing",
    });

    // 3. Flate stream recompression (replace-if-smaller, level 9).
    let streamsRecompressed = 0;
    if (params.recompress) {
      streamsRecompressed = recompressFlateStreams(doc).streamsRecompressed;
    }
    post({
      type: "progress",
      runId,
      pct: 70,
      stage: "processing",
    });

    // 4. Save — object stream packing per the switch.
    const saved = await doc.save({
      useObjectStreams: params.objectStreams,
    });
    const objectStreamsCount = params.objectStreams
      ? countObjectStreams(saved)
      : 0;

    post({
      type: "progress",
      runId,
      pct: 94,
      stage: "saving",
    });
    outputs.push({
      name: `${fileBaseName(file.name)}-web.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    });

    const beforeBytes = bytes.length;
    const afterBytes = saved.length;
    const savedPct =
      beforeBytes > 0
        ? Math.round((1 - afterBytes / beforeBytes) * 1000) / 10
        : 0;
    post({
      type: "result",
      runId,
      outputs,
      detail: {
        files: outputs.length,
        pages: pageCount,
        beforeBytes,
        afterBytes,
        savedPct,
        streamsRecompressed,
        objectStreamsCount,
        metadataStripped,
        unreferencedObjects: garbage.removed,
      },
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: classifyWebOptError(error),
    });
  });
};
