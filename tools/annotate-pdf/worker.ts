import {
  PDFDocument,
  PDFHexString,
  PDFString,
  type PDFObject,
} from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  NOTE_SIZE,
  hexToRgb,
  sanitizeAnnotations,
  type Annotation,
  type MarkupAnno,
  type NoteAnno,
} from "./model";

/**
 * Annotate PDF — device-only export worker (PRD §8.2 "Highlight /
 * Underline / Strike … real PDF annotations (editable in other readers)"
 * + "Sticky note / Comment").
 *
 * The surface owns every interaction and sends the annotations blob under
 * "a:<fileId>" (the redact epoch-key pattern). This worker re-opens the
 * original document with pdf-lib and appends REAL annotation objects to
 * the page /Annots arrays — they stay editable/comment-listable in
 * Chrome, Firefox, Acrobat and every standards-compliant reader:
 *
 *   highlight  → /Subtype /Highlight with /QuadPoints + /IC + /CA
 *   underline  → /Subtype /Underline with /QuadPoints + /C
 *   strikeout  → /Subtype /StrikeOut with /QuadPoints + /C
 *   scanned    → /Subtype /Square fallback (translucent fill, no border)
 *   note       → /Subtype /Text (sticky note icon) with /Contents
 *
 * QuadPoints use the Acrobat order (BL → BR → TR → TL per quad), the
 * exact geometry real files carry. /Contents rides PDFHexString so Hindi
 * note text survives. Device-only: the File arrives by structured clone
 * and the result Blob goes back the same way. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** PDF date string ("D:YYYYMMDDHHmmSSZ"). */
function pdfDate(at: number): string {
  const d = new Date(at > 0 ? at : Date.now());
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

interface WireBlob {
  annos: unknown;
}

/** Structural subset of pdf-lib's LiteralObject (obj() input typing). */
interface AnnoDictLiteral {
  [key: string]: AnnoDictValue;
}

type AnnoDictValue =
  | string
  | number
  | boolean
  | PDFObject
  | AnnoDictValue[]
  | AnnoDictLiteral;

function parseBlob(raw: unknown): WireBlob | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WireBlob>;
    return { annos: parsed.annos };
  } catch {
    return null;
  }
}

/** /Rect for a markup — its stored union rect, clamped into the page. */
function markupRect(
  anno: MarkupAnno,
  box: { x: number; y: number; width: number; height: number }
): number[] | null {
  const x0 = Math.max(anno.rect.x, box.x);
  const y0 = Math.max(anno.rect.y, box.y);
  const x1 = Math.min(anno.rect.x + anno.rect.w, box.x + box.width);
  const y1 = Math.min(anno.rect.y + anno.rect.h, box.y + box.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return [x0, y0, x1, y1];
}

function quadNumbers(anno: MarkupAnno): number[] {
  const out: number[] = [];
  for (const q of anno.quads) {
    out.push(q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  const opts = options as OptionValues & Record<string, string>;

  const akey = typeof opts.akey === "string" ? opts.akey : "";
  const blob = parseBlob(opts[`a:${akey}`]);

  post({ type: "progress", runId, pct: 4, stage: "reading" });

  const data = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /password|encrypt/i.test(message) ? "PDF_PASSWORD" : "PDF_PARSE"
    );
  }
  const pages = doc.getPages();
  const annos = sanitizeAnnotations(blob?.annos, pages.length);

  post({ type: "progress", runId, pct: 12, stage: "processing" });

  let markups = 0;
  let notes = 0;
  const total = Math.max(annos.length, 1);
  let done = 0;

  for (let p = 0; p < pages.length; p += 1) {
    const pageAnnos = annos.filter((a) => a.page === p);
    if (pageAnnos.length === 0) {
      post({
        type: "progress",
        runId,
        pct: 12 + Math.min(76, Math.round((76 * (p + 1)) / pages.length)),
        stage: "processing",
        detail: { page: p + 1, pages: pages.length },
      });
      continue;
    }
    const page = pages[p];
    let box = { x: 0, y: 0, width: 612, height: 792 };
    try {
      const crop = page.getCropBox();
      box = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    } catch {
      /* keep the default */
    }

    for (const anno of pageAnnos) {
      const dict = annoDict(anno, box);
      if (dict) {
        // register() stores what it is given — convert the plain literal
        // through context.obj (names, numbers, nested /BS dict) first.
        page.node.addAnnot(
          doc.context.register(doc.context.obj(dict))
        );
        if (anno.kind === "note") notes += 1;
        else markups += 1;
      }
      done += 1;
      post({
        type: "progress",
        runId,
        pct: 12 + Math.min(76, Math.round((76 * done) / total)),
        stage: "processing",
        detail: { page: p + 1, pages: pages.length },
      });
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = await doc.save({ useObjectStreams: true });
  const outputName = `${safeBaseName(file.name)}-annotated.pdf`;

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: pages.length,
      annotations: markups,
      notes,
    },
  });
}

/**
 * Builds the annotation dictionary for one annotation. `context.obj`
 * maps strings → names, numbers → numbers, arrays → arrays; /Contents
 * rides PDFHexString (UTF-16) so Devanagari note text survives.
 */
function annoDict(
  anno: Annotation,
  box: { x: number; y: number; width: number; height: number }
): AnnoDictLiteral | null {
  const { r, g, b } = hexToRgb(anno.color);
  const date = PDFString.of(pdfDate(anno.at));

  if (anno.kind === "note") {
    const n = anno as NoteAnno;
    // Keep the icon inside the page even when clicked near an edge.
    const cx = Math.min(Math.max(n.x, box.x + NOTE_SIZE / 2), box.x + box.width - NOTE_SIZE / 2);
    const cy = Math.min(Math.max(n.y, box.y + NOTE_SIZE / 2), box.y + box.height - NOTE_SIZE / 2);
    return {
      Type: "Annot",
      Subtype: "Text",
      Rect: [
        cx - NOTE_SIZE / 2,
        cy - NOTE_SIZE / 2,
        cx + NOTE_SIZE / 2,
        cy + NOTE_SIZE / 2,
      ],
      Contents: PDFHexString.fromText(n.text),
      Name: "Comment",
      C: [r, g, b],
      F: 4,
      M: date,
      Open: false,
    };
  }

  const m = anno as MarkupAnno;
  const rect = markupRect(m, box);
  if (rect === null) return null;

  if (m.fallback) {
    // Scanned page: a translucent filled square (no border).
    return {
      Type: "Annot",
      Subtype: "Square",
      Rect: rect,
      IC: [r, g, b],
      C: [r, g, b],
      CA: m.opacity,
      BS: { Type: "Border", W: 0, S: "S" },
      Border: [0, 0, 0],
      F: 4,
      M: date,
    };
  }

  if (m.kind === "highlight") {
    return {
      Type: "Annot",
      Subtype: "Highlight",
      Rect: rect,
      QuadPoints: quadNumbers(m),
      C: [r, g, b],
      IC: [r, g, b],
      CA: m.opacity,
      F: 4,
      M: date,
      Contents: PDFHexString.fromText(m.text),
    };
  }

  // Underline / StrikeOut: full-strength stroke colour along the quads.
  return {
    Type: "Annot",
    Subtype: m.kind === "underline" ? "Underline" : "StrikeOut",
    Rect: rect,
    QuadPoints: quadNumbers(m),
    C: [r, g, b],
    F: 4,
    M: date,
    Contents: PDFHexString.fromText(m.text),
  };
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      message === "PDF_PASSWORD"
        ? "tool.errorEncrypted"
        : message === "PDF_PARSE"
          ? "tool.errorCorrupt"
          : "ann.errorBuild";
    post({
      type: "error",
      runId: data.runId,
      code,
      detail: code === "ann.errorBuild" ? message.slice(0, 200) : undefined,
    });
  });
};
