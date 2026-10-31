import {
  PdfError,
  decodeTextString,
  listPages,
  parsePdf,
} from "@/lib/own/pdf";
import type { PdfObj } from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * View PDF metadata worker (PHASE-1 Batch B): parses each file on OUR
 * OWN engine (read-only — nothing is rewritten) and emits a plain-text
 * report per file. Batch up to 20.
 *
 * Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const INFO_KEYS: Array<[string, string]> = [
  ["Title", "Title"],
  ["Author", "Author"],
  ["Subject", "Subject"],
  ["Keywords", "Keywords"],
  ["Creator", "Creator"],
  ["Producer", "Producer"],
  ["CreationDate", "Created"],
  ["ModDate", "Modified"],
];

/** Render one PDF's metadata report (pure — smoke-tested directly). */
export function renderReport(
  fileName: string,
  bytes: Uint8Array,
  facts: {
    pageCount: number;
    version: string;
    encrypted: boolean;
    hasInfo: boolean;
    infoEntries: Array<[string, string]>;
    hasXmp: boolean;
  }
): string {
  const lines: string[] = [];
  lines.push(`PDF metadata report`);
  lines.push(`=================`);
  lines.push(`File:         ${fileName}`);
  lines.push(`Size:         ${fmtBytes(bytes.length)}`);
  lines.push(`Pages:        ${facts.pageCount}`);
  lines.push(`PDF version:  ${facts.version}`);
  lines.push(`Encrypted:    ${facts.encrypted ? "yes" : "no"}`);
  lines.push("");
  lines.push(`Document info (/Info)`);
  lines.push(`---------------------`);
  if (facts.infoEntries.length === 0) {
    lines.push(`(no /Info dictionary fields)`);
  } else {
    for (const [key, value] of facts.infoEntries) {
      lines.push(`${key.padEnd(13)}${value}`);
    }
  }
  lines.push("");
  lines.push(`XMP metadata`);
  lines.push(`------------`);
  lines.push(facts.hasXmp ? "present (XML block in the catalog)" : "absent");
  lines.push("");
  lines.push(`Generated on-device by DocoPDF — the PDF was not modified.`);
  return lines.join("\n");
}

/** Extract report facts from parsed bytes (pure-ish; parse + read only). */
export function reportFacts(
  bytes: Uint8Array
): {
  pageCount: number;
  version: string;
  encrypted: boolean;
  hasInfo: boolean;
  infoEntries: Array<[string, string]>;
  hasXmp: boolean;
} {
  // Encrypted detection: the strict parser refuses, so probe first.
  try {
    const doc = parsePdf(bytes);
    const pages = listPages(doc);
    const infoEntries: Array<[string, string]> = [];
    const infoRef = doc.trailer.get("Info");
    if (infoRef && infoRef.k === "ref") {
      const infoObj = doc.getObject(infoRef.num);
      if (infoObj && (infoObj.k === "dict" || infoObj.k === "stream")) {
        for (const [key, label] of INFO_KEYS) {
          const value = infoObj.m.get(key);
          if (value === undefined) continue;
          if (value.k === "str" || value.k === "lstr" || value.k === "hstr") {
            infoEntries.push([label, decodeTextString(value.b)]);
          }
        }
      }
    }
    const rootObj = doc.trailer.get("Root");
    const root = rootObj && rootObj.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
    const hasXmp = !!(root && (root.k === "dict" || root.k === "stream") && root.m.has("Metadata"));
    return {
      pageCount: pages.length,
      version: doc.version,
      encrypted: false,
      hasInfo: infoEntries.length > 0,
      infoEntries,
      hasXmp,
    };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      return {
        pageCount: 0,
        version: "?",
        encrypted: true,
        hasInfo: false,
        infoEntries: [],
        hasXmp: false,
      };
    }
    throw error;
  }
}

export interface ViewMetaResult {
  bytes: Uint8Array;
  pages: number;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let done = 0;
  let pageCount = 0;
  for (const file of files) {
    post({
      type: "progress",
      runId,
      pct: Math.max(4, Math.round((done / files.length) * 100)),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let text: string;
    try {
      const facts = reportFacts(bytes);
      pageCount = facts.pageCount;
      text = renderReport(file.name, bytes, facts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
      post({ type: "error", runId, code });
      return;
    }
    outputs.push({
      name: `${safeBaseName(file.name)}-metadata.txt`,
      mime: "text/plain",
      blob: new Blob([text], { type: "text/plain" }),
    });
    done += 1;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
