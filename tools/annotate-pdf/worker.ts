import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  PdfError,
  StampContext,
  arr,
  hstr,
  lstr,
  name,
  newDict,
  num,
  type PdfObj,
} from "@/lib/own/pdf";
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
 * original document with OUR own PDF engine (StampContext — the P6-f
 * stamp kernel) and appends REAL annotation objects to the page /Annots
 * arrays — they stay editable/comment-listable in Chrome, Firefox,
 * Acrobat and every standards-compliant reader:
 *
 *   highlight  → /Subtype /Highlight with /QuadPoints + /IC + /CA
 *   underline  → /Subtype /Underline with /QuadPoints + /C
 *   strikeout  → /Subtype /StrikeOut with /QuadPoints + /C
 *   scanned    → /Subtype /Square fallback (translucent fill, no border)
 *   note       → /Subtype /Text (sticky note icon) with /Contents
 *
 * QuadPoints use the Acrobat order (BL → BR → TR → TL per quad), the
 * exact geometry real files carry. /Contents rides a UTF-16BE hex string
 * (the pdf-lib PDFHexString.fromText form) so Hindi note text survives.
 * Device-only: the File arrives by structured clone and the result Blob
 * goes back the same way. Never touches the network.
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

/** PDFHexString.fromText parity — UTF-16BE bytes with the FEFF BOM. */
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c >> 8;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}

/** PDFString.of parity — Latin-1 bytes of the ASCII date strings. */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** numbers[] → a PDF array object. */
const numArr = (values: number[]): PdfObj => ({
  k: "arr",
  items: values.map((v) => num(v)),
});

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
  let ctx: StampContext;
  try {
    ctx = StampContext.load(data);
  } catch (error) {
    // Our parser REFUSES encrypted sources at load (typed "encrypted") —
    // the parity of the old ignoreEncryption + isEncrypted refusal:
    // appending plaintext annotations and re-saving an encrypted file
    // would emit a mixed-encryption document no reader can open, so the
    // engine refuses honestly (tool.errorEncrypted → "unlock it first,
    // then try again"). Everything else is a parse failure.
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("PDF_PASSWORD");
    }
    throw new Error("PDF_PARSE");
  }
  const annos = sanitizeAnnotations(blob?.annos, ctx.pageCount);

  post({ type: "progress", runId, pct: 12, stage: "processing" });

  let markups = 0;
  let notes = 0;
  const total = Math.max(annos.length, 1);
  let done = 0;

  for (let p = 0; p < ctx.pageCount; p += 1) {
    const pageAnnos = annos.filter((a) => a.page === p);
    if (pageAnnos.length === 0) {
      post({
        type: "progress",
        runId,
        pct: 12 + Math.min(76, Math.round((76 * (p + 1)) / ctx.pageCount)),
        stage: "processing",
        detail: { page: p + 1, pages: ctx.pageCount },
      });
      continue;
    }
    const crop = ctx.pages[p]!.cropBox;
    const box = {
      x: crop[0],
      y: crop[1],
      width: crop[2] - crop[0],
      height: crop[3] - crop[1],
    };

    for (const anno of pageAnnos) {
      const dict = annoDict(anno, box);
      if (dict) {
        ctx.appendAnnot(p, dict);
        if (anno.kind === "note") notes += 1;
        else markups += 1;
      }
      done += 1;
      post({
        type: "progress",
        runId,
        pct: 12 + Math.min(76, Math.round((76 * done) / total)),
        stage: "processing",
        detail: { page: p + 1, pages: ctx.pageCount },
      });
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = ctx.write();
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
      pages: ctx.pageCount,
      annotations: markups,
      notes,
    },
  });
}

/**
 * Builds the annotation dictionary for one annotation as OUR engine's
 * object model: strings → names, numbers → numbers, arrays → arrays;
 * /Contents rides a UTF-16BE hex string (hstr — the pdf-lib
 * PDFHexString.fromText form) so Devanagari note text survives; the /M
 * date rides a literal string (lstr — the pdf-lib PDFString.of form).
 */
function annoDict(
  anno: Annotation,
  box: { x: number; y: number; width: number; height: number }
): (PdfObj & { k: "dict" }) | null {
  const { r, g, b } = hexToRgb(anno.color);
  const date = lstr(latin1Bytes(pdfDate(anno.at)));

  if (anno.kind === "note") {
    const n = anno as NoteAnno;
    // Keep the icon inside the page even when clicked near an edge.
    const cx = Math.min(Math.max(n.x, box.x + NOTE_SIZE / 2), box.x + box.width - NOTE_SIZE / 2);
    const cy = Math.min(Math.max(n.y, box.y + NOTE_SIZE / 2), box.y + box.height - NOTE_SIZE / 2);
    return newDict([
      ["Type", name("Annot")],
      ["Subtype", name("Text")],
      [
        "Rect",
        arr(
          num(cx - NOTE_SIZE / 2),
          num(cy - NOTE_SIZE / 2),
          num(cx + NOTE_SIZE / 2),
          num(cy + NOTE_SIZE / 2),
        ),
      ],
      ["Contents", hstr(utf16be(n.text))],
      ["Name", name("Comment")],
      ["C", arr(num(r), num(g), num(b))],
      ["F", num(4)],
      ["M", date],
      ["Open", { k: "bool", b: false }],
    ]);
  }

  const m = anno as MarkupAnno;
  const rect = markupRect(m, box);
  if (rect === null) return null;

  if (m.fallback) {
    // Scanned page: a translucent filled square (no border).
    return newDict([
      ["Type", name("Annot")],
      ["Subtype", name("Square")],
      ["Rect", numArr(rect)],
      ["IC", numArr([r, g, b])],
      ["C", numArr([r, g, b])],
      ["CA", num(m.opacity)],
      ["BS", newDict([["Type", name("Border")], ["W", num(0)], ["S", name("S")]])],
      ["Border", numArr([0, 0, 0])],
      ["F", num(4)],
      ["M", date],
    ]);
  }

  if (m.kind === "highlight") {
    return newDict([
      ["Type", name("Annot")],
      ["Subtype", name("Highlight")],
      ["Rect", numArr(rect)],
      ["QuadPoints", numArr(quadNumbers(m))],
      ["C", numArr([r, g, b])],
      ["IC", numArr([r, g, b])],
      ["CA", num(m.opacity)],
      ["F", num(4)],
      ["M", date],
      ["Contents", hstr(utf16be(m.text))],
    ]);
  }

  // Underline / StrikeOut: full-strength stroke colour along the quads.
  return newDict([
    ["Type", name("Annot")],
    ["Subtype", name(m.kind === "underline" ? "Underline" : "StrikeOut")],
    ["Rect", numArr(rect)],
    ["QuadPoints", numArr(quadNumbers(m))],
    ["C", numArr([r, g, b])],
    ["F", num(4)],
    ["M", date],
    ["Contents", hstr(utf16be(m.text))],
  ]);
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
