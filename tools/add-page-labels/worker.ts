import {
  PdfError,
  parsePdf,
  rewriteDocument,
  catalogDict,
} from "@/lib/own/pdf";
import type { PdfObj, ParsedPdf } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Add page labels worker (R50) — installs a /PageLabels number tree in
 * the catalog (PDF 32000-1 §12.4.2) so viewers show logical labels
 * (i, ii, iii / 1, 2, 3…) in the page box and thumbnails.
 *
 * Single scheme for the whole document, expressed as ONE Nums entry at
 * index 0 — the viewer auto-increments from there (/S style, /St start,
 * /P optional prefix). Nothing is stamped on any page; the catalog is
 * cloned with the extra key and the document is rewritten through the
 * own engine (byte-exact page passthrough).
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

function latinSafe(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e) return false;
  }
  return true;
}

const SCHEMES = new Set(["D", "r", "R", "a", "A"]);

interface LabelOptions {
  scheme: "D" | "r" | "R" | "a" | "A";
  prefix: string;
  startNumber: number;
}

function resolveOptions(options: OptionValues): LabelOptions {
  const rawScheme =
    typeof options.scheme === "string" ? options.scheme : "D";
  const scheme = (SCHEMES.has(rawScheme) ? rawScheme : "D") as LabelOptions["scheme"];
  const prefix =
    typeof options.prefix === "string" ? options.prefix.slice(0, 32) : "";
  const startRaw = Number(options.startNumber);
  const startNumber = Number.isFinite(startRaw)
    ? Math.min(Math.max(Math.floor(startRaw), 1), 1000)
    : 1;
  return { scheme, prefix, startNumber };
}

/** Trailer /Root as an object reference (null when inline — invalid PDF). */
function rootObjectNumber(doc: ParsedPdf): number | null {
  const root = doc.trailer.get("Root");
  if (root === undefined || root.k !== "ref") return null;
  return root.num;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const labels = resolveOptions(options);

  if (!latinSafe(labels.prefix)) {
    // Reuse: the message is generic ("embedded font can't carry this text").
    post({ type: "error", runId, code: "tool.errorWatermarkChars" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
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

  const rootNum = rootObjectNumber(doc);
  const catalog = catalogDict(doc);
  if (rootNum === null || catalog === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt", detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });

  // Label dict for page index 0: /S style, /St start, optional /P prefix.
  const labelDict = new Map<string, PdfObj>();
  labelDict.set("S", { k: "name", v: labels.scheme });
  labelDict.set("St", { k: "num", n: labels.startNumber });
  if (labels.prefix.length > 0) {
    labelDict.set("P", {
      k: "str",
      b: new Uint8Array(
        Array.from(labels.prefix, (ch) => ch.charCodeAt(0) & 0xff)
      ),
    });
  }

  const pageLabels: PdfObj = {
    k: "dict",
    m: new Map<string, PdfObj>([
      ["Nums", { k: "arr", items: [{ k: "num", n: 0 }, { k: "dict", m: labelDict }] }],
    ]),
  };

  const replacement: PdfObj = {
    k: "dict",
    m: new Map<string, PdfObj>(catalog),
  };
  replacement.m.set("PageLabels", pageLabels);

  let saved: Uint8Array;
  try {
    saved = rewriteDocument(doc, {
      replacements: new Map([[rootNum, replacement]]),
    });
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: undefined });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-labelled.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1 },
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
