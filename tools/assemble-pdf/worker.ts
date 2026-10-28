import {
  asNum,
  organizeMerge,
  parseForOrganize,
  PdfError,
  type MergePlanEntry,
  type OrganizeSource,
  type PdfPageInfo,
} from "@/lib/own/pdf";

import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  parseAssembleOption,
  planAssemble,
  type AsmDoc,
  type AsmOutputMode,
} from "./model";

/**
 * Assemble PDF — device-only worker (PRD §8.1).
 *
 * P6-h: runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero
 * external code). Each source file is parsed ONCE (typed refusal for
 * encrypted inputs — the structural trailer probe, never a raw-bytes sniff —
 * and typed corrupt errors naming the exact file); every column is then
 * rebuilt through the shared multi-document reachable-set union with
 * byte-exact content passthrough and pdf-lib-copyPages-parity inheritance
 * materialization (inherited MediaBox/CropBox/Rotate/Resources move onto
 * the copied leaves instead of being lost).
 *
 * Rebuilds the workspace columns the surface serialized into the
 * "assemble" option, then executes the plan the SAME pure model computes
 * (planAssemble) so preview and output can never disagree:
 *
 * - merge: one PDF from all columns — optionally zipper-interleaved
 *   (front/back scans) and/or reversed
 * - separate: one PDF per column (multi-output; the result view offers
 *   per-file downloads plus "Download all (ZIP)")
 *
 * R14 rotation semantics preserved exactly: the user's offset ADDS to the
 * page's effective /Rotate; a non-quadrant base (damaged files) snaps to 0
 * before the addition (the R13 quadrantRotate rule) while untouched pages
 * keep their own /Rotate byte-for-byte. Never touches the network.
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

const norm360 = (n: number): number =>
  ((Math.trunc(n) % 360) + 360) % 360;

/**
 * R14 rotation offset → engine rotateDelta. The engine writes
 * /Rotate normalizeRotation(page.rotate + delta) — `page.rotate` is always a
 * quadrant — so `target − page.rotate` lands on the wanted angle, and a
 * delta of 360 forces the write when the page's OWN /Rotate is a damaged
 * non-quadrant that must normalize to the user's intended angle (pdf-lib's
 * `if (target !== base) setRotation(target)` parity).
 */
function rotateDeltaFor(page: PdfPageInfo, rotate: number): number | undefined {
  if (rotate === undefined || rotate === 0) return undefined;
  // Own /Rotate first (pdf-lib's copied leaf carries its own entry), the
  // inherited value otherwise (our parse resolves it — as does pdf-lib's
  // copyPDFPage materialization).
  const own = asNum(page.dict.get("Rotate"));
  const base = norm360(own !== undefined ? own : page.rotate);
  const baseQ = base === 90 || base === 180 || base === 270 ? base : 0;
  const target = norm360(baseQ + rotate);
  if (target === base) return undefined;
  let delta = target - page.rotate;
  if (delta === 0) delta = 360;
  return delta;
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
  /** fileId → parsed source + its index into the global sources array. */
  const sources = new Map<string, { source: OrganizeSource; docIndex: number }>();
  /** Global source array (docIndex = position). */
  const sourcesArr: OrganizeSource[] = [];

  const loadSource = async (fileId: string): Promise<{ source: OrganizeSource; docIndex: number }> => {
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
    // R6-b honesty: the typed parse refuses encrypted inputs structurally
    // (trailer /Encrypt — never a raw-bytes sniff); both refusals name the
    // exact source file.
    let source: OrganizeSource;
    try {
      source = parseForOrganize(bytes);
    } catch (error: unknown) {
      if (error instanceof PdfError && error.code === "encrypted") {
        throw new AssembleRefusal("tool.errorEncrypted", file.name);
      }
      throw new AssembleRefusal("tool.errorCorrupt", file.name);
    }
    const entry = { source, docIndex: sourcesArr.length };
    sourcesArr.push(source);
    sources.set(fileId, entry);
    return entry;
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

    // Per-column plan against the shared parsed sources. Page bounds are
    // pre-checked here so an out-of-range slot maps to the SAME
    // tool.errorInvalidPages refusal the pdf-lib era produced.
    const planEntries: MergePlanEntry[] = [];
    for (let index = 0; index < doc.pages.length; index += 1) {
      const [fileId, pageIndex, rotate] = doc.pages[index];
      const loaded = await loadSource(fileId);
      if (pageIndex >= loaded.source.pages.length) {
        post({ type: "error", runId, code: "tool.errorInvalidPages" });
        return;
      }
      const page = loaded.source.pages[pageIndex]!;
      const rotateDelta = rotateDeltaFor(page, rotate ?? 0);
      planEntries.push(
        rotateDelta === undefined
          ? { kind: "page", doc: loaded.docIndex, src: pageIndex }
          : { kind: "page", doc: loaded.docIndex, src: pageIndex, rotateDelta },
      );

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

    // One multi-document rebuild per output column — every source graph is
    // copied through the shared reachable-set union (a font shared by two
    // files is still written once per document it came from). Only the
    // files THIS column draws from join the rebuild, so the output header
    // version is the max of its own sources (never a sibling column's).
    const docOrder: number[] = [];
    const localIndexOf = new Map<number, number>();
    const remappedEntries: MergePlanEntry[] = planEntries.map((entry) => {
      if (entry.kind !== "page") return entry;
      let local = localIndexOf.get(entry.doc);
      if (local === undefined) {
        local = docOrder.length;
        localIndexOf.set(entry.doc, local);
        docOrder.push(entry.doc);
      }
      return { ...entry, doc: local };
    });
    const sourcesList = docOrder.map((globalIndex) => sourcesArr[globalIndex]!);
    let saved: Uint8Array;
    try {
      saved = organizeMerge(sourcesList, remappedEntries);
    } catch (error: unknown) {
      if (error instanceof PdfError && error.code === "encrypted") {
        throw new AssembleRefusal("tool.errorEncrypted", "");
      }
      throw error;
    }

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
