/**
 * Extract attachments worker-lib (P3-d → R59) — PURE pipeline:
 * naming helpers + the EmbeddedFiles tree walk + the /Filter chain
 * decode, smoke- AND surface-drivable without a Worker.
 *
 * R59: the surface's pre-run inventory probe runs THIS SAME code on
 * the main thread — the preview IS the output (probe/worker parity
 * by construction, not by imitation).
 */

import {
  PdfError,
  asDict,
  decodeStreamBytes,
  listPages,
  parsePdf,
  resolve,
  type PdfObj,
} from "@/lib/own/pdf";
import { sniffAttachmentMime } from "../attachments-common/mime";

/** Filesystem-safe output name (path parts stripped, fallback kept). */
export function sanitizeAttachmentName(raw: string, index: number): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  // Only underscores/dots left = no usable name — honest fallback.
  if (/^[_.\s]*$/.test(cleaned) || cleaned.length === 0) {
    return `attachment-${index + 1}.bin`;
  }
  return cleaned.slice(0, 180);
}

/**
 * Makes an output name unique against the taken set: same stem gets
 * " (2)", " (3)"… before the extension. Two PDFs carrying the same
 * attachment name must both survive on disk.
 */
export function uniqueOutputName(raw: string, taken: Set<string>): string {
  if (!taken.has(raw)) {
    taken.add(raw);
    return raw;
  }
  const dot = raw.lastIndexOf(".");
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem}-${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}

export interface ExtractedAttachment {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/**
 * Decodes a stream through its /Filter chain (FlateDecode etc.);
 * unsupported filters fall back to the raw bytes (for DCT the raw
 * stream IS the JPEG file — still a usable attachment).
 */
function decodeAttachmentStream(
  stream: PdfObj & { k: "stream" }
): Uint8Array {
  try {
    return decodeStreamBytes(stream.raw, stream.m);
  } catch {
    return stream.raw;
  }
}

/** Walk the EmbeddedFiles tree; collect (name, decoded bytes, mime) triples. */
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
      const bytes = decodeAttachmentStream(stream);
      out.push({
        name: keyText,
        bytes,
        mime: sniffAttachmentMime(keyText, bytes),
      });
    }
  };
  walk(efTree, 0);
  return out;
}

export interface ExtractResult {
  attachments: ExtractedAttachment[];
}

/** One file's pre-run inventory (the surface probe shape). */
export interface AttachmentsProbe {
  /** Page count of the host PDF (0 when unreadable — honest). */
  pageCount: number;
  attachments: ExtractedAttachment[];
}

/**
 * Pre-run probe for the surface: parse once, report the page count
 * AND the exact attachment list the worker would emit — the preview
 * IS the output (same walk, same /F preference, same filter decode).
 */
export function probeAttachments(pdfBytes: Uint8Array): AttachmentsProbe {
  const doc = parsePdf(pdfBytes);
  let pageCount = 0;
  try {
    pageCount = listPages(doc).length;
  } catch {
    pageCount = 0;
  }
  return { pageCount, attachments: collectAttachments(doc) };
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
