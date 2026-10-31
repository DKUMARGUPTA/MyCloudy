import {
  PdfError,
  listPages,
  parsePdf,
  rewriteDocument,
  type PdfObj,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  type PageLabelOptions,
  resolvePageLabelOptions,
  styleName,
} from "./engine";

/**
 * Add page labels worker (PHASE-1 Batch B): installs a /PageLabels
 * /Nums tree INLINE into a catalog replacement (rewriteDocument
 * object surgery — same seam as sanitize). The tree covers every page
 * with one labeling range; a cover page gets a prefix-only range.
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

/** Encode a label prefix as a PDF literal-safe string object. */
function prefixObj(prefix: string): PdfObj {
  // WinAnsi-safe: escape backslashes and parens; non-latin1 chars are
  // dropped (labels are short ASCII in practice).
  let out = "";
  for (const ch of prefix) {
    const code = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") {
      out += `\\${ch}`;
    } else if (code >= 32 && code <= 126) {
      out += ch;
    }
    // else: skipped (non-ASCII)
  }
  const bytes = new TextEncoder().encode(out);
  return { k: "str", b: bytes };
}

/** One /Nums entry's page-label dict object. */
function labelRangeObj(
  opts: PageLabelOptions,
  withStyle: boolean
): PdfObj {
  const m = new Map<string, PdfObj>();
  const s = withStyle ? styleName(opts.style) : undefined;
  if (s !== undefined) {
    m.set("S", { k: "name", v: s });
    if (opts.start !== 1) {
      m.set("St", { k: "num", n: opts.start });
    }
  }
  if (opts.prefix.length > 0) {
    m.set("P", prefixObj(opts.prefix));
  }
  return { k: "dict", m };
}

export interface PageLabelRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runPageLabels(
  bytes: Uint8Array,
  options: OptionValues
): Promise<PageLabelRunResult> {
  const opts = resolvePageLabelOptions(options);

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

  // Build the /Nums array: [(firstIndex) labelRange …] — one range for
  // the whole document, plus a cover-only prefix range when requested.
  const nums: PdfObj[] = [];
  if (opts.coverUnlabeled && pages.length > 1) {
    nums.push({ k: "num", n: 0 });
    nums.push(labelRangeObj({ ...opts, style: "none", start: 1 }, false));
    nums.push({ k: "num", n: 1 });
    nums.push(labelRangeObj(opts, true));
  } else {
    nums.push({ k: "num", n: 0 });
    nums.push(labelRangeObj(opts, true));
  }

  const pageLabels: PdfObj = {
    k: "dict",
    m: new Map<string, PdfObj>([["Nums", { k: "arr", items: nums }]]),
  };

  // Catalog replacement: clone + set /PageLabels (inline dict).
  const rootObj = doc.trailer.get("Root");
  if (!rootObj || (rootObj.k !== "ref" && rootObj.k !== "dict" && rootObj.k !== "stream")) {
    throw new Error("tool.errorCorrupt");
  }
  const catalogRaw =
    rootObj.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  if (!catalogRaw || (catalogRaw.k !== "dict" && catalogRaw.k !== "stream")) {
    throw new Error("tool.errorCorrupt");
  }
  const catalog = new Map<string, PdfObj>(catalogRaw.m);
  catalog.set("PageLabels", pageLabels);

  const replacements = new Map<number, PdfObj>();
  if (rootObj.k === "ref") {
    replacements.set(rootObj.num, { k: "dict", m: catalog });
  } else {
    // Inline catalog (rare): rewriteDocument has no inline-catalog
    // replacement path — refuse rather than corrupt.
    throw new Error("tool.errorCorrupt");
  }

  try {
    const saved = rewriteDocument(doc, { replacements });
    return { bytes: saved, pages: pages.length };
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
  let result: PageLabelRunResult;
  try {
    result = await runPageLabels(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^pl\.|^tool\./.test(message)
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
      name: `${safeBaseName(file.name)}-labelled.pdf`,
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
