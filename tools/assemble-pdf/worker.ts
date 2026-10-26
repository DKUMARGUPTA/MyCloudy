import { degrees, PDFDocument } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  parseAssembleOption,
  planAssemble,
  type AsmDoc,
  type AsmOutputMode,
} from "./model";

/**
 * Assemble PDF — device-only worker (PRD §8.1; pdf-lib, MIT).
 *
 * Rebuilds the workspace columns the surface serialized into the
 * "assemble" option, then executes the plan the SAME pure model
 * computes (planAssemble) so preview and output can never disagree:
 *
 * - merge: one PDF from all columns — optionally zipper-interleaved
 *   (front/back scans) and/or reversed
 * - separate: one PDF per column (multi-output; the result view offers
 *   per-file downloads plus "Download all (ZIP)")
 *
 * Source files load lazily and ONCE (Map), pages copy one-by-one so
 * interleaved orders stay exact. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * Named refusal from a source-PDF load (R6-b honesty, merge-pdf standard):
 * the plan can pull pages from MANY source PDFs, so an encrypted/corrupt
 * refusal must NAME the file that stopped the run. Thrown by loadSource,
 * posted with the file name by the top-level catch.
 */
class AssembleRefusal extends Error {
  readonly code: string;
  readonly fileName: string;
  constructor(code: string, fileName: string) {
    super(`${code}: ${fileName}`);
    this.name = "AssembleRefusal";
    this.code = code;
    this.fileName = fileName;
  }
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

interface ResolvedOptions {
  mode: AsmOutputMode;
  zipper: boolean;
  reverse: boolean;
  outputName: string;
}

function resolveOptions(options: OptionValues): ResolvedOptions {
  const rawMode = String(options.outputMode ?? "merge");
  return {
    mode: rawMode === "separate" ? "separate" : "merge",
    zipper: options.zipper === true,
    reverse: options.reverse === true,
    outputName:
      typeof options.outputName === "string" ? options.outputName : "",
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, fileIds } = request;
  const resolved = resolveOptions(options);

  const parsed = parseAssembleOption(options.assemble);
  if (parsed === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  // Hydrate the wire format into the model shape so the SAME pure
  // planner decides both the surface preview and this worker output.
  const docs: AsmDoc[] = parsed.map((entry) => ({
    id: -1,
    name: entry.name,
    pages: entry.pages.map(([fileId, page, rotate]) => ({
      uid: -1,
      fileId,
      page,
      // R14 wire: only TURNED pages carry the third element — an absent
      // (or snapped-to-0) offset never writes /Rotate below.
      ...(rotate !== undefined && rotate !== 0 ? { rotate } : {}),
    })),
  }));

  const plan = planAssemble(docs, {
    mode: resolved.mode,
    zipper: resolved.zipper,
    reverse: resolved.reverse,
  });
  if (plan.length === 0) {
    // Safety net — the CTA is disabled before this can happen.
    post({ type: "error", runId, code: "asm.errorNoPages" });
    return;
  }

  // Resolve workspace file ids -> Files (positions can shift; ids don't).
  const fileById = new Map<string, File>();
  if (fileIds !== undefined) {
    for (let index = 0; index < fileIds.length; index += 1) {
      fileById.set(fileIds[index], files[index]);
    }
  } else {
    for (let index = 0; index < files.length; index += 1) {
      fileById.set(String(index), files[index]);
    }
  }
  for (const doc of plan) {
    for (const [fileId] of doc.pages) {
      if (!fileById.has(fileId)) {
        post({ type: "error", runId, code: "tool.errorCorrupt" });
        return;
      }
    }
  }

  const totalPages = plan.reduce(
    (sum, doc) => sum + doc.pages.length,
    0
  );
  const sources = new Map<string, PDFDocument>();

  const loadSource = async (fileId: string): Promise<PDFDocument> => {
    const cached = sources.get(fileId);
    if (cached !== undefined) return cached;
    const file = fileById.get(fileId);
    if (file === undefined) {
      throw new Error("missing-file");
    }
    post({
      type: "progress",
      runId,
      pct: 2,
      stage: "reading",
      detail: { pages: 1 },
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    // R6-b honesty: probe the trailer STRUCTURALLY (pdf-lib ignoreEncryption
    // load + isEncrypted — never a raw-bytes "/Encrypt" sniff), then the
    // plain load; both refusals name the exact source file.
    let probe: PDFDocument | null = null;
    try {
      probe = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch {
      // Not parseable at all — the plain load below keeps producing the
      // honest corrupt refusal for this file.
    }
    if (probe?.isEncrypted) {
      throw new AssembleRefusal("tool.errorEncrypted", file.name);
    }
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AssembleRefusal(
        /password|encrypt/i.test(message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
        file.name
      );
    }
    sources.set(fileId, doc);
    return doc;
  };

  let donePages = 0;
  const outputs: {
    name: string;
    mime: string;
    blob: Blob;
  }[] = [];
  const usedNames = new Set<string>();

  for (let docIndex = 0; docIndex < plan.length; docIndex += 1) {
    const doc = plan[docIndex];
    const out = await PDFDocument.create();

    for (let index = 0; index < doc.pages.length; index += 1) {
      const [fileId, pageIndex, rotate] = doc.pages[index];
      const source = await loadSource(fileId);
      if (pageIndex >= source.getPageCount()) {
        post({ type: "error", runId, code: "tool.errorInvalidPages" });
        return;
      }
      const [copied] = await out.copyPages(source, [pageIndex]);
      out.addPage(copied);

      // R14: the user's rotation offset ADDS to whatever /Rotate the
      // source page already shipped with — read from the COPIED node
      // (copyPages carries it, so base and content are in sync by
      // construction; the R13 stale-blob trust mask is unnecessary
      // here). Untouched refs (rotate 0/absent) skip the write entirely:
      // the page keeps its own /Rotate byte-for-byte — the zero-
      // regression path for legacy 2-tuple payloads.
      if (rotate !== undefined && rotate !== 0) {
        const norm = (n: number): number =>
          ((Math.trunc(n) % 360) + 360) % 360;
        const base = norm(copied.getRotation().angle);
        // Non-quadrant bases (damaged/tampered files) snap to 0 — the
        // R13 quadrantRotate rule — so a broken source still exports
        // instead of dying on pdf-lib's quadrant assert.
        const baseQ =
          base === 90 || base === 180 || base === 270 ? base : 0;
        const target = norm(baseQ + rotate);
        if (target !== base) copied.setRotation(degrees(target));
      }

      donePages += 1;
      post({
        type: "progress",
        runId,
        pct: Math.round(4 + (donePages / totalPages) * 90),
        stage: "processing",
        detail: { page: donePages, pages: totalPages },
      });
    }

    if (doc.pages.length > 0) {
      post({
        type: "progress",
        runId,
        pct: 95,
        stage: "saving",
        detail: { page: docIndex + 1, pages: plan.length },
      });
    }

    const saved = await out.save({ useObjectStreams: true });

    // Merge mode keeps the typed output name; columns keep their own.
    let name: string;
    if (resolved.mode === "merge") {
      const fallback = `${plan[0].name.slice(0, 100)}-assembled`;
      name = sanitizeName(resolved.outputName, fallback);
    } else {
      name = sanitizeName(doc.name, `document-${docIndex + 1}`);
    }
    if (usedNames.has(name)) {
      let counter = 2;
      let candidate = name.replace(/\.pdf$/i, "");
      while (usedNames.has(`${candidate} ${counter}.pdf`)) counter += 1;
      name = `${candidate} ${counter}.pdf`;
    }
    usedNames.add(name);

    outputs.push({
      name,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

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
    // R6-b: a named source refusal keeps its file name — the toast must
    // say WHICH source PDF to unlock/replace, never the bare sentence.
    if (error instanceof AssembleRefusal) {
      post({
        type: "error",
        runId: data.runId,
        code: error.code,
        detail: error.fileName,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
