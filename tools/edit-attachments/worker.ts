import {
  PdfError,
  asDict,
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
 * Edit attachments worker (PHASE-3 batch 2): rename and delete the files
 * embedded inside a PDF. The surface probe lists them (pdf.js), the user
 * edits names / marks deletions, and THIS worker is the authority — it
 * re-walks the /Names /EmbeddedFiles tree itself, applies the requested
 * ops by position (never trusting names from the UI), rewrites renamed
 * Filespec /F + /UF dictionaries in place, drops deleted entries from a
 * rebuilt FLAT tree and keeps every other /Names subtree (Dests, JS…)
 * untouched. Own engine object surgery. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** A discovered attachment: tree key + resolved filespec (ref or inline). */
export interface AttachmentEntry {
  name: string;
  /** Raw tree slot object — usually a ref to a Filespec dict. */
  spec: PdfObj;
}

/**
 * Walk the catalog's EmbeddedFiles tree (Kids-aware, depth-capped) into a
 * flat ordered list — the same traversal add/extract-attachments use, kept
 * in sync so the surface's pdf.js listing and the worker agree on order.
 */
export function listAttachmentEntries(
  doc: ReturnType<typeof parsePdf>
): AttachmentEntry[] {
  const out: AttachmentEntry[] = [];
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const namesDict = asDict(resolve(doc, asDict(catalog)?.get("Names")));
  if (!namesDict) return out;
  const efTree = resolve(doc, namesDict.get("EmbeddedFiles"));
  const walk = (node: PdfObj | undefined, depth: number): void => {
    if (depth > 32 || node === undefined) return;
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
    if (namesArr?.k !== "arr") return;
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
  };
  walk(efTree, 0);
  return out;
}

/** One requested edit against the discovered list (surface → option JSON). */
export interface EditOp {
  /** 0-based index into the discovered attachment order. */
  i: number;
  /** New file name (rename) — omitted for pure deletes. */
  name?: string;
  /** Delete this entry entirely. */
  del?: boolean;
}

export interface EditSummary {
  renamed: number;
  deleted: number;
  kept: number;
}

export interface EditAttachmentsResult {
  bytes: Uint8Array;
  summary: EditSummary;
}

/** Sanitize a user-supplied attachment name (FS-safe, non-empty, ≤150). */
function cleanName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 150);
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse + validate the serialized ops payload (bad entries dropped). */
export function parseOps(raw: unknown): EditOp[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const list = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(list)) return [];
  const out: EditOp[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as { i?: unknown; name?: unknown; del?: unknown };
    const i = Number(rec.i);
    if (!Number.isInteger(i) || i < 0 || i > 100_000) continue;
    if (rec.del === true) {
      out.push({ i, del: true });
    } else if (typeof rec.name === "string") {
      const name = cleanName(rec.name);
      if (name !== null) out.push({ i, name });
    }
  }
  return out;
}

/** The whole pipeline, smoke-testable without a Worker. */
export function runEditAttachments(
  pdfBytes: Uint8Array,
  options: OptionValues
): EditAttachmentsResult {
  const ops = parseOps(options.ops);
  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(pdfBytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }

  const entries = listAttachmentEntries(doc);
  if (entries.length === 0) {
    throw new Error("edat.errorNoAttachments");
  }
  if (ops.length === 0) {
    throw new Error("edat.errorNothingToDo");
  }

  // Apply ops by index — last write wins, deletes dominate renames.
  const renameByIndex = new Map<number, string>();
  const deleteIndex = new Set<number>();
  for (const op of ops) {
    if (op.del === true) {
      deleteIndex.add(op.i);
    } else if (op.name !== undefined) {
      renameByIndex.set(op.i, op.name);
    }
  }
  let renamed = 0;
  let deleted = 0;
  let kept = 0;

  // Numbering above every existing object (rewriteDocument convention).
  let nextNum = 1;
  for (const n of doc.entries.keys()) {
    if (n >= nextNum) nextNum = n + 1;
  }

  const extraObjects: Array<{ num: number; obj: PdfObj }> = [];
  const replacements = new Map<number, PdfObj>();
  const namesArr: PdfObj[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (deleteIndex.has(index)) {
      deleted += 1;
      continue;
    }
    const newName = renameByIndex.get(index);
    let displayName = entry.name;
    if (newName !== undefined) {
      displayName = newName;
      renamed += 1;
    }

    // Renames rewrite the filespec's /F + /UF in place when the spec is a
    // ref (the normal shape); inline specs are kept as-is in the flat tree.
    const nameBytes = {
      k: "str" as const,
      b: new TextEncoder().encode(displayName),
    };
    if (newName !== undefined && entry.spec.k === "ref") {
      const specObj = doc.getObject(entry.spec.num);
      if (specObj && (specObj.k === "dict" || specObj.k === "stream")) {
        const updated = new Map<string, PdfObj>(specObj.m);
        updated.set("F", nameBytes);
        updated.set("UF", nameBytes);
        replacements.set(entry.spec.num, { k: "dict", m: updated });
      }
    }
    namesArr.push({ k: "str", b: new TextEncoder().encode(entry.name) });
    namesArr.push(entry.spec);
    kept += 1;
  }

  // Catalog surgery: replace ONLY the EmbeddedFiles subtree of /Names,
  // preserving sibling name trees (Dests, JavaScript, …).
  const rootObj = doc.trailer.get("Root");
  if (!rootObj || rootObj.k !== "ref") {
    throw new Error("tool.errorCorrupt");
  }
  const catalogRaw = doc.getObject(rootObj.num);
  if (!catalogRaw || (catalogRaw.k !== "dict" && catalogRaw.k !== "stream")) {
    throw new Error("tool.errorCorrupt");
  }
  const catalog = new Map<string, PdfObj>(catalogRaw.m);
  const existingNames = asDict(resolve(doc, catalog.get("Names")));
  const newNames = new Map<string, PdfObj>(
    existingNames ? Array.from(existingNames.entries()) : []
  );

  if (kept === 0) {
    // Everything deleted — remove the subtree entirely.
    newNames.delete("EmbeddedFiles");
  } else {
    const treeNum = nextNum++;
    extraObjects.push({
      num: treeNum,
      obj: {
        k: "dict",
        m: new Map<string, PdfObj>([
          ["Names", { k: "arr", items: namesArr }],
        ]),
      },
    });
    newNames.set("EmbeddedFiles", ref(treeNum));
  }

  if (newNames.size > 0) {
    const namesNum = nextNum++;
    extraObjects.push({
      num: namesNum,
      obj: { k: "dict", m: newNames },
    });
    catalog.set("Names", ref(namesNum));
  } else {
    catalog.delete("Names");
  }
  replacements.set(rootObj.num, { k: "dict", m: catalog });

  try {
    const saved = rewriteDocument(doc, { replacements, extraObjects });
    return {
      bytes: saved,
      summary: { renamed, deleted, kept },
    };
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

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 55, stage: "processing" });
  let result: EditAttachmentsResult;
  try {
    result = runEditAttachments(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^edat\.|^tool\./.test(message)
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
      name: `${safeBaseName(file.name)}-attachments-edited.pdf`,
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
    detail: {
      files: 1,
      pages: result.summary.kept,
      renamed: result.summary.renamed,
      deleted: result.summary.deleted,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
