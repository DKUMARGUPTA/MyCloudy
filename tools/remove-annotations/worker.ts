import {
  PdfError,
  catalogDict,
  listPages,
  parsePdf,
  rewriteDocument,
} from "@/lib/own/pdf";
import type { PdfObj, ParsedPdf } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import { parsePageSpec } from "@/lib/workers/protocol";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  catalogHasAcroForm,
  countRemovable,
  filterAnnots,
  readPageAnnots,
  type AnnotationRemoval,
} from "./worker-lib";

/**
 * Remove annotations worker (P1-d / R53) — the GRANULAR markup strip.
 * Unlike the one-tap Sanitize (which rebuilds the document and drops
 * everything interactive), this tool PRESERVES the document through the
 * own-engine rewrite path: only the selected annotation groups are filtered
 * out of page /Annots arrays, links and form fields survive untouched when
 * their switches are off, and catalog /AcroForm stays when form fields are
 * kept. On-device, typed errors, byte-exact content streams.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files, options } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const removal: AnnotationRemoval = {
    markup: options.markup !== false,
    links: options.links === true,
    widgets: options.widgets === true,
  };
  const pageSpecRaw =
    typeof options.pages === "string" && options.pages.trim() !== ""
      ? options.pages
      : "all";

  if (!removal.markup && !removal.links && !removal.widgets) {
    post({
      type: "error",
      runId,
      code: "tool.errorNothingToDo",
      detail: undefined,
    });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc: ParsedPdf;
  try {
    doc = parsePdf(bytes);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  const pages = listPages(doc);
  if (pages.length === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorCorrupt",
      detail: file.name,
    });
    return;
  }

  const targets = parsePageSpec(pageSpecRaw, pages.length);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }
  const targetSet = new Set(targets);
  const wholeDoc = targets.length === pages.length;

  post({ type: "progress", runId, pct: 35, stage: "processing" });

  // Per-page replacements: only pages in the spec whose /Annots actually
  // change get a patched dict — everything else passes through untouched.
  const replacements = new Map<number, PdfObj>();
  let removedTotal = 0;
  for (let i = 0; i < pages.length; i += 1) {
    if (!targetSet.has(i)) continue;
    const page = pages[i];
    const items = readPageAnnots(doc, page.dict);
    if (items === undefined) continue;

    const { kept, removed } = filterAnnots(doc, items, removal);
    if (removed === 0) continue;
    removedTotal += removed;

    const patched = new Map<string, PdfObj>(page.dict);
    if (kept.length === 0) {
      // Spec-equivalent to absent.
      patched.set("Annots", { k: "null" });
    } else {
      // Inline array of the surviving refs — serializePreserve writes
      // them exactly as the source carried them.
      patched.set("Annots", { k: "arr", items: kept });
    }
    // Page objects are indirect by construction — the ref num is stable
    // through the preserve-path rewrite.
    replacements.set(page.ref.num, { k: "dict", m: patched });
  }

  // Form-field removal: page widgets gone + catalog /AcroForm dropped —
  // but only when EVERY page was processed (a partial strip keeps the form
  // alive for the pages that still carry their widgets).
  let acroFormDropped = false;
  const catalog = catalogDict(doc);
  const rootObj = doc.trailer.get("Root");
  if (
    removal.widgets &&
    wholeDoc &&
    catalog !== null &&
    rootObj !== undefined &&
    rootObj.k === "ref" &&
    catalogHasAcroForm(catalog)
  ) {
    const patchedCatalog = new Map<string, PdfObj>(catalog);
    patchedCatalog.set("AcroForm", { k: "null" });
    replacements.set(rootObj.num, { k: "dict", m: patchedCatalog });
    acroFormDropped = true;
  }

  if (removedTotal === 0 && !acroFormDropped) {
    // Nothing matched the selected groups — honest refusal.
    post({
      type: "error",
      runId,
      code: "tool.errorNothingToDo",
      detail: undefined,
    });
    return;
  }

  let saved: Uint8Array;
  try {
    saved = rewriteDocument(doc, { replacements });
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-no-annotations.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: pages.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
  });
};
