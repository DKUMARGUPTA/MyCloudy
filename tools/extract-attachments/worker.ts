import {
  PdfError,
  asDict,
  parsePdf,
  resolve,
  type PdfObj,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Extract attachments worker (PHASE-3): walks the catalog's
 * /Names /EmbeddedFiles tree (Kids-aware), reads each Filespec's /EF
 * /F stream and writes the bytes out byte-exact — one output per
 * embedded file, on OUR OWN parser. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

export interface ExtractedAttachment {
  name: string;
  bytes: Uint8Array;
}

/** Walk the EmbeddedFiles tree; collect (name, stream bytes) pairs. */
export function collectAttachments(
  doc: ReturnType<typeof parsePdf>
): ExtractedAttachment[] {
  const out: ExtractedAttachment[] = [];
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const catalogDict = asDict(catalog);
  if (!catalogDict) return out;
  const namesDict = asDict(resolve(doc, catalogDict.get("Names")));
  if (!namesDict) return out;
  const efTree = resolve(doc, namesDict.get("EmbeddedFiles"));

  const seen = new Set<number>();
  const walk = (node: PdfObj | undefined, depth: number): void => {
    if (depth > 32 || node === undefined) return;
    const dict = asDict(node);
    if (!dict) return;
    const kids = dict.get("Kids");
    if (kids?.k === "arr") {
      for (const kid of kids.items) {
        const resolved = resolve(doc, kid);
        if (resolved !== undefined) walk(resolved, depth + 1);
      }
      return;
    }
    const namesArr = dict.get("Names");
    if (namesArr?.k !== "arr") return;
    for (let i = 0; i + 1 < namesArr.items.length; i += 2) {
      const key = namesArr.items[i];
      const specRef = namesArr.items[i + 1]!;
      let keyText = `attachment-${out.length + 1}`;
      if (key?.k === "str" || key?.k === "lstr" || key?.k === "hstr") {
        const decoded = new TextDecoder().decode(key.b).trim();
        if (decoded.length > 0) keyText = decoded;
      }
      const spec = resolve(doc, specRef);
      const specDict = asDict(spec);
      if (!specDict) continue;
      // /F filename overrides the tree key when present.
      const f = specDict.get("F");
      if (f && (f.k === "str" || f.k === "lstr" || f.k === "hstr")) {
        const decoded = new TextDecoder().decode(f.b).trim();
        if (decoded.length > 0) keyText = decoded;
      }
      const efDict = asDict(resolve(doc, specDict.get("EF")));
      const fRef = efDict?.get("F");
      if (!fRef) continue;
      const stream = resolve(doc, fRef);
      if (stream?.k !== "stream") continue;
      if (fRef.k === "ref") {
        if (seen.has(fRef.num)) continue;
        seen.add(fRef.num);
      }
      out.push({ name: keyText, bytes: stream.raw });
    }
  };
  walk(efTree, 0);
  return out;
}

export interface ExtractResult {
  attachments: ExtractedAttachment[];
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runExtractAttachments(
  pdfBytes: Uint8Array
): Promise<ExtractResult> {
  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(pdfBytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  return { attachments: collectAttachments(doc) };
}

function safeName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 150) : "attachment";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let total = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (86 * fileIndex) / files.length),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let result: ExtractResult;
    try {
      result = await runExtractAttachments(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^tool\./.test(message)
        ? message
        : /encrypt/i.test(message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt";
      post({ type: "error", runId, code });
      return;
    }
    if (result.attachments.length === 0) {
      post({ type: "error", runId, code: "et.errorNoAttachments" });
      return;
    }
    for (const att of result.attachments) {
      outputs.push({
        name: safeName(att.name),
        mime: "application/octet-stream",
        blob: new Blob([att.bytes as unknown as BlobPart], {
          type: "application/octet-stream",
        }),
      });
      total += 1;
    }
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
