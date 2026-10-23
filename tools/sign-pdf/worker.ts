import { PDFDocument, degrees } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { hasExistingSignature } from "../digital-signature/model";
import { fileBaseName } from "../stamp-common/layout";
import {
  type PageGeom,
  parsePlacementsOption,
  placementTargets,
  placementToDrawBox,
} from "./engine";

/**
 * Sign PDF worker (PRD §7.6): flattens every placement into the page
 * content with pdf-lib — the signature becomes permanent page pixels,
 * exactly like a printed, signed document.
 *
 * Input contract:
 * - options.sigkey      the current file's workspace id
 * - options["p:<id>"]   JSON placements (engine.SignPlacement[])
 * - assets              PNG files named "sig-<signatureId>.png"
 *   (config.collectAssets ships the signature library)
 *
 * The draw geometry is the shared engine's placementToDrawBox(): display
 * fractions → user space with /Rotate-aware mapping, image anchored via
 * the watermark worker's rotated-start-point formula. One placement can
 * stamp many pages (this/all/odd/even/range).
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, assets } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const sigkey = typeof options.sigkey === "string" ? options.sigkey : "";
  const placements = parsePlacementsOption(options[`p:${sigkey}`]);
  if (placements.length === 0) {
    post({ type: "error", runId, code: "tool.errorSignNoPlacements" });
    return;
  }

  // Signature PNGs arrive as assets — never inside the options payload.
  const assetById = new Map<string, File>();
  for (const asset of assets ?? []) {
    const match = /^sig-(.+)\.png$/.exec(asset.name);
    if (match) assetById.set(match[1], asset);
  }
  for (const placement of placements) {
    if (!assetById.has(placement.sigId)) {
      post({ type: "error", runId, code: "tool.errorSignAssetMissing" });
      return;
    }
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  let doc: PDFDocument;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A visual countersign on an already-signed contract is the classic
    // trap: pdf-lib's full re-save shifts every byte offset and silently
    // invalidates the existing signature's /ByteRange. Honest refusal
    // (the digital-signature guard recipe) — a second cryptographic
    // signature must go through the Digital signature tool instead.
    if (hasExistingSignature(bytes)) {
      post({ type: "error", runId, code: "tool.errorAlreadySigned" });
      return;
    }
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code:
        error instanceof Error && /encrypt/i.test(error.message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
    });
    return;
  }

  const pageCount = doc.getPageCount();
  const geoms: PageGeom[] = doc.getPages().map((page) => ({
    rotation: page.getRotation().angle,
    width: page.getWidth(),
    height: page.getHeight(),
  }));

  // Resolve every placement's page targets once — invalid ranges abort
  // before any drawing happens (fail fast, no half-signed output).
  const resolved = placements.map((placement) => ({
    placement,
    targets: placementTargets(placement, pageCount),
  }));
  if (resolved.some((r) => r.targets === null || r.targets.length === 0)) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  // Embed each distinct signature exactly once.
  post({ type: "progress", runId, pct: 16, stage: "processing" });
  const embedded = new Map<string, { img: Awaited<ReturnType<PDFDocument["embedPng"]>>; aspect: number }>();
  for (const [id, asset] of assetById) {
    if (!placements.some((p) => p.sigId === id)) continue;
    try {
      const bytes = new Uint8Array(await asset.arrayBuffer());
      const img = await doc.embedPng(bytes);
      embedded.set(id, { img, aspect: img.height / img.width });
    } catch {
      post({ type: "error", runId, code: "tool.errorSignAssetBroken" });
      return;
    }
  }

  const totalStamps = resolved.reduce(
    (sum, r) => sum + (r.targets?.length ?? 0),
    0
  );
  let done = 0;
  for (const { placement, targets } of resolved) {
    const entry = embedded.get(placement.sigId);
    if (!entry || !targets) continue;
    for (const pageIndex of targets) {
      const page = doc.getPage(pageIndex);
      const geom = geoms[pageIndex];
      const box = placementToDrawBox(placement, geom, entry.aspect);
      page.drawImage(entry.img, {
        x: box.sx,
        y: box.sy,
        width: box.w,
        height: box.h,
        rotate: degrees(box.angle),
        opacity: box.op,
      });
      done += 1;
      post({
        type: "progress",
        runId,
        pct: 20 + Math.round((done / totalStamps) * 70),
        stage: "processing",
        detail: { page: pageIndex + 1, pages: pageCount },
      });
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  const outBytes = await doc.save({ useObjectStreams: true });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${fileBaseName(file.name)}-signed.pdf`,
        mime: "application/pdf",
        blob: new Blob([outBytes as unknown as BlobPart], { type: "application/pdf" }),
      },
    ],
    detail: { pages: pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data.type !== "run") return;
  void run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
