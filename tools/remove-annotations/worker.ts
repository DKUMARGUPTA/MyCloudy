import {
  PdfError,
  listPages,
  parsePdf,
  rewriteDocument,
  type PdfObj,
  type PdfRef,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Remove annotations worker (PHASE-1 Batch C): object surgery via
 * rewriteDocument page replacements — each page's /Annots array is
 * filtered (keep form widgets when asked, keep internal links when
 * asked) or dropped entirely. Page content is untouched.
 *
 * Runs 100% on OUR OWN engine. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface RemoveAnnotsOptions {
  keepForms: boolean;
  keepLinks: boolean;
}

export function resolveRemoveAnnotsOptions(
  values: OptionValues
): RemoveAnnotsOptions {
  return {
    keepForms: values.keepForms !== false,
    keepLinks: values.keepLinks !== false,
  };
}

/** Is this annotation dict a form widget (/Subtype Widget)? */
function isWidget(doc: ReturnType<typeof parsePdf>, annot: PdfObj): boolean {
  const dict =
    annot.k === "ref" ? doc.getObject(annot.num) : annot;
  if (!dict || (dict.k !== "dict" && dict.k !== "stream")) return false;
  const subtype = dict.m.get("Subtype");
  return subtype?.k === "name" && subtype.v === "Widget";
}

/** Is this annotation a NON-external link (internal GoTo/Named)? */
function isInternalLink(doc: ReturnType<typeof parsePdf>, annot: PdfObj): boolean {
  const dict = annot.k === "ref" ? doc.getObject(annot.num) : annot;
  if (!dict || (dict.k !== "dict" && dict.k !== "stream")) return false;
  const subtype = dict.m.get("Subtype");
  if (!subtype || subtype.k !== "name" || subtype.v !== "Link") return false;
  // A link with /Dest is internal; a link with /A /S /GoTo is internal.
  if (dict.m.has("Dest")) return true;
  const action = dict.m.get("A");
  if (action === undefined) return false;
  const actionObj = action.k === "ref" ? doc.getObject(action.num) : action;
  if (!actionObj || (actionObj.k !== "dict" && actionObj.k !== "stream")) {
    return false;
  }
  const s = actionObj.m.get("S");
  return s?.k === "name" && (s.v === "GoTo" || s.v === "Named");
}

export interface RemoveAnnotsResult {
  bytes: Uint8Array;
  pages: number;
  removed: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runRemoveAnnotations(
  bytes: Uint8Array,
  options: OptionValues
): Promise<RemoveAnnotsResult> {
  const opts = resolveRemoveAnnotsOptions(options);

  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }

  const pages = listPages(doc);
  if (pages.length < 1) {
    throw new Error("tool.errorCorrupt");
  }

  const replacements = new Map<number, PdfObj>();
  let removed = 0;

  for (const page of pages) {
    const annots = page.dict.get("Annots");
    if (!annots || annots.k !== "arr" || annots.items.length === 0) continue;

    const kept: PdfObj[] = [];
    for (const annot of annots.items) {
      let keep = false;
      if (opts.keepForms && isWidget(doc, annot)) {
        keep = true;
      }
      if (!keep && opts.keepLinks && isInternalLink(doc, annot)) {
        keep = true;
      }
      if (keep) {
        kept.push(annot);
      } else {
        removed += 1;
      }
    }

    const pageMap = new Map<string, PdfObj>(page.dict);
    if (kept.length === 0) {
      pageMap.delete("Annots");
    } else {
      pageMap.set("Annots", { k: "arr", items: kept });
    }
    replacements.set((page.ref as PdfRef).num, { k: "dict", m: pageMap });
  }

  try {
    const saved = rewriteDocument(doc, { replacements });
    return { bytes: saved, pages: pages.length, removed };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  let result: RemoveAnnotsResult;
  try {
    result = await runRemoveAnnotations(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^ra\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-clean.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
