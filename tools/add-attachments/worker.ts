import {
  PdfError,
  asDict,
  asName,
  dget,
  name,
  num,
  parsePdf,
  ref,
  resolve,
  rewriteDocument,
  type PdfObj,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Add attachments worker (PHASE-3): embeds the extra input files inside
 * the first input PDF via rewriteDocument object surgery — a fresh
 * EmbeddedFile stream + Filespec per attachment (extraObjects, numbers
 * above the source max), a rebuilt FLAT /Names /EmbeddedFiles tree
 * (existing entries preserved when asked), and a catalog replacement.
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

export interface AttachmentSpec {
  name: string;
  bytes: Uint8Array;
}

/** Flatten the existing EmbeddedFiles tree into (name, filespecObj) pairs. */
function existingEntries(
  doc: ReturnType<typeof parsePdf>
): Array<{ name: string; spec: PdfObj }> {
  const out: Array<{ name: string; spec: PdfObj }> = [];
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const namesDict = asDict(resolve(doc, asDict(catalog)?.get("Names")));
  const efTree = namesDict ? resolve(doc, namesDict.get("EmbeddedFiles")) : undefined;
  const walk = (node: PdfObj | undefined, depth: number): void => {
    if (depth > 32) return;
    const dict = asDict(node);
    if (!dict) return;
    const kids = dict.get("Kids");
    if (kids?.k === "arr") {
      for (const kid of kids.items) {
        walk(resolve(doc, kid), depth + 1);
      }
      return;
    }
    const namesArr = dict.get("Names");
    if (namesArr?.k === "arr") {
      for (let i = 0; i + 1 < namesArr.items.length; i += 2) {
        const key = namesArr.items[i];
        const spec = namesArr.items[i + 1]!;
        let keyText: string | undefined;
        if (key?.k === "str" || key?.k === "lstr" || key?.k === "hstr") {
          keyText = new TextDecoder().decode(key.b);
        }
        if (keyText !== undefined) {
          out.push({ name: keyText, spec });
        }
      }
    }
  };
  walk(efTree, 0);
  return out;
}

export interface AddAttachmentsResult {
  bytes: Uint8Array;
  attached: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runAddAttachments(
  pdfBytes: Uint8Array,
  attachments: readonly AttachmentSpec[],
  options: OptionValues
): Promise<AddAttachmentsResult> {
  const keepExisting = options.keepExisting !== false;

  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(pdfBytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }

  // Numbering above every existing object.
  let nextNum = 1;
  for (const n of doc.entries.keys()) {
    if (n >= nextNum) nextNum = n + 1;
  }

  const extraObjects: Array<{ num: number; obj: PdfObj }> = [];
  const namesArr: PdfObj[] = [];

  // Preserve existing entries (their filespec objects stay in place —
  // the FLAT tree references them directly).
  if (keepExisting) {
    for (const entry of existingEntries(doc)) {
      namesArr.push({ k: "str", b: new TextEncoder().encode(entry.name) });
      namesArr.push(entry.spec);
    }
  }

  for (const att of attachments) {
    // EmbeddedFile stream (stored byte-exact, no filter).
    const efNum = nextNum++;
    const efDict = new Map<string, PdfObj>([
      ["Type", name("EmbeddedFile")],
      ["Params", { k: "dict", m: new Map<string, PdfObj>([["Size", num(att.bytes.length)]]) }],
    ]);
    extraObjects.push({
      num: efNum,
      obj: { k: "stream", m: efDict, raw: att.bytes },
    });
    // Filespec dict.
    const specNum = nextNum++;
    const nameBytes = new TextEncoder().encode(att.name);
    const specDict = new Map<string, PdfObj>([
      ["Type", name("Filespec")],
      ["F", { k: "str", b: nameBytes }],
      ["UF", { k: "str", b: nameBytes }],
      ["EF", { k: "dict", m: new Map<string, PdfObj>([["F", ref(efNum)], ["UF", ref(efNum)]]) }],
    ]);
    extraObjects.push({ num: specNum, obj: { k: "dict", m: specDict } });
    namesArr.push({ k: "str", b: nameBytes });
    namesArr.push(ref(specNum));
  }

  // Names dicts: tree (flat /Names array) inside the /Names container.
  const treeNum = nextNum++;
  extraObjects.push({
    num: treeNum,
    obj: {
      k: "dict",
      m: new Map<string, PdfObj>([["Names", { k: "arr", items: namesArr }]]),
    },
  });
  const namesNum = nextNum++;
  extraObjects.push({
    num: namesNum,
    obj: {
      k: "dict",
      m: new Map<string, PdfObj>([["EmbeddedFiles", ref(treeNum)]]),
    },
  });

  // Catalog replacement: /Names → new container (other name trees are
  // dropped — Dests rarely matters and Sanitize covers the rest).
  const rootObj = doc.trailer.get("Root");
  if (!rootObj || rootObj.k !== "ref") {
    throw new Error("tool.errorCorrupt");
  }
  const catalogRaw = doc.getObject(rootObj.num);
  if (!catalogRaw || (catalogRaw.k !== "dict" && catalogRaw.k !== "stream")) {
    throw new Error("tool.errorCorrupt");
  }
  const catalog = new Map<string, PdfObj>(catalogRaw.m);
  catalog.set("Names", ref(namesNum));

  const replacements = new Map<number, PdfObj>();
  replacements.set(rootObj.num, { k: "dict", m: catalog });

  try {
    const saved = rewriteDocument(doc, { replacements, extraObjects });
    return { bytes: saved, attached: attachments.length };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length < 2) {
    post({ type: "error", runId, code: "at.errorNeedAttachment" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const pdfFile = files[0]!;
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  // files[0] must be a PDF (magic sniff).
  if (!(pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50 && pdfBytes[2] === 0x44 && pdfBytes[3] === 0x46)) {
    post({ type: "error", runId, code: "at.errorFirstMustBePdf" });
    return;
  }

  const attachments: AttachmentSpec[] = [];
  for (let i = 1; i < files.length; i += 1) {
    const file = files[i]!;
    attachments.push({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (40 * i) / files.length),
      stage: "reading",
    });
  }

  post({ type: "progress", runId, pct: 55, stage: "processing" });
  let result: AddAttachmentsResult;
  try {
    result = await runAddAttachments(pdfBytes, attachments, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^at\.|^tool\./.test(message)
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
      name: `${safeBaseName(pdfFile.name)}-with-attachments.pdf`,
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
    detail: { files: 1, pages: result.attached },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
