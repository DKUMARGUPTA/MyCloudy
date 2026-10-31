import {
  PdfError,
  organizePages,
  parseForOrganize,
  resolve,
  decodeStreamBytes,
  type ParsedPdf,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { PdfObj } from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Remove blank pages worker (R50) — decodes each page's content
 * stream(s) and scans for MARKING operators (text show, path
 * fill/stroke, image/XObject draw, shading). Pages with no marks are
 * dropped; kept pages are rebuilt byte-exact through the own-engine
 * organize path.
 *
 * The scanner is a small own-code content-stream token walk: it skips
 * strings (…), <hex>, names /x, arrays and numbers, and only treats
 * bare keywords as operators — so the text "(Tj)" inside a string can
 * never fool it.
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

/** Keywords that actually leave a visible mark on the page. */
const MARKING_OPS = new Set([
  // Text showing
  "Tj", "TJ", "'", '"',
  // Path painting (fill / stroke / close variants)
  "f", "F", "f*", "B", "B*", "b", "b*", "S", "s",
  // Shading
  "sh",
  // XObjects (images, forms)
  "Do",
]);

/** True when the operator stream contains at least one marking op. */
function contentHasMarks(bytes: Uint8Array): boolean {
  const len = bytes.length;
  let i = 0;
  while (i < len) {
    const c = bytes[i]!;
    // Literal string ( … ) — nested parens respected.
    if (c === 0x28) {
      let depth = 1;
      i += 1;
      while (i < len && depth > 0) {
        const s = bytes[i]!;
        if (s === 0x5c) i += 1; // escape — skip next
        else if (s === 0x28) depth += 1;
        else if (s === 0x29) depth -= 1;
        i += 1;
      }
      continue;
    }
    // Hex string < … > or dict << … >> — skip to the closing >.
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        // dict: skip to matching >> (nested one level is enough —
        // content-stream inline dicts are shallow resources).
        let depth = 1;
        i += 2;
        while (i < len && depth > 0) {
          if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
            depth += 1;
            i += 2;
            continue;
          }
          if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
            depth -= 1;
            i += 2;
            continue;
          }
          i += 1;
        }
      } else {
        i += 1;
        while (i < len && bytes[i] !== 0x3e) i += 1;
        i += 1;
      }
      continue;
    }
    // Array [ … ] — contents are operands, never operators.
    if (c === 0x5b) {
      let depth = 1;
      i += 1;
      while (i < len && depth > 0) {
        const s = bytes[i]!;
        if (s === 0x5c) i += 1;
        else if (s === 0x5b) depth += 1;
        else if (s === 0x5d) depth -= 1;
        i += 1;
      }
      continue;
    }
    // Inline image BI … ID <binary> EI — always a mark, but the binary
    // may contain anything, so consume it properly.
    if (
      c === 0x42 &&
      bytes[i + 1] === 0x49 &&
      isDelim(bytes[i - 1])
    ) {
      return true; // inline image = definite mark
    }
    // Bare keyword — collect and test.
    if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2a ||
      c === 0x27 ||
      c === 0x22
    ) {
      let j = i;
      while (j < len) {
        const k = bytes[j]!;
        if (
          (k >= 0x41 && k <= 0x5a) ||
          (k >= 0x61 && k <= 0x7a) ||
          (k >= 0x30 && k <= 0x39) ||
          k === 0x2a ||
          k === 0x27 ||
          k === 0x22
        ) {
          j += 1;
        } else break;
      }
      const op = String.fromCharCode(...bytes.subarray(i, j));
      if (MARKING_OPS.has(op)) return true;
      i = j;
      continue;
    }
    i += 1;
  }
  return false;
}

function isDelim(byte: number | undefined): boolean {
  if (byte === undefined) return true;
  return (
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 ||
    byte === 0x28 || byte === 0x3c || byte === 0x5b || byte === 0x2f ||
    byte === 0x5d || byte === 0x3e
  );
}

/** Collect + decode the page's content stream(s) and test for marks. */
function pageIsBlank(
  doc: ParsedPdf,
  page: { dict: Map<string, PdfObj> }
): boolean {
  const contents = page.dict.get("Contents");
  if (contents === undefined) return true;
  const resolved = resolve(doc, contents);
  if (resolved === undefined || resolved.k === "null") return true;

  const streams: Array<{ m: Map<string, PdfObj>; raw: Uint8Array }> = [];
  if (resolved.k === "stream") {
    streams.push(resolved);
  } else if (resolved.k === "arr") {
    for (const item of resolved.items) {
      const r = resolve(doc, item);
      if (r !== undefined && r.k === "stream") {
        streams.push(r);
      }
    }
  }
  if (streams.length === 0) return true;

  for (const stream of streams) {
    try {
      const decoded = decodeStreamBytes(stream.raw, stream.m);
      if (contentHasMarks(decoded)) return false;
    } catch {
      // Undecodable content — assume NON-blank (never destroy data we
      // cannot read). Honest conservatism.
      return false;
    }
  }
  return true;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  let parsed;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  const pageCount = parsed.pages.length;
  if (pageCount === 0) {
    post({ type: "error", runId, code: "tool.errorNothingToDo" });
    return;
  }

  post({ type: "progress", runId, pct: 15, stage: "processing" });
  const keep: number[] = [];
  const blanks: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    if (pageIsBlank(parsed.doc, parsed.pages[i]!)) {
      blanks.push(i);
    } else {
      keep.push(i);
    }
    if (i % 5 === 0 || i === pageCount - 1) {
      post({
        type: "progress",
        runId,
        pct: Math.round(15 + ((i + 1) / pageCount) * 35),
        stage: "processing",
        detail: { page: i + 1, pages: pageCount },
      });
    }
  }

  if (blanks.length === 0) {
    // Honest refusal — no blank pages, nothing to remove.
    post({ type: "error", runId, code: "tool.errorNoBlankFound" });
    return;
  }
  if (keep.length === 0) {
    // EVERY page is blank — removing all would make an invalid PDF.
    post({ type: "error", runId, code: "tool.errorAllBlank" });
    return;
  }

  const plan: PlanEntry[] = keep.map((src) => ({ kind: "page", src }));
  post({ type: "progress", runId, pct: 55, stage: "processing" });
  let cleaned: Uint8Array;
  try {
    cleaned = organizePages(parsed, plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(55 + 40 * fraction),
        stage: "processing",
        detail: { page, pages: plan.length },
      });
    });
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: undefined });
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-cleaned.pdf`,
        mime: "application/pdf",
        blob: new Blob([cleaned as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: plan.length },
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
