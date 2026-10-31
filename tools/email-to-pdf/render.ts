/**
 * Email → PDF painter (P3-c, R57) — PURE layout on the OWN engine.
 *
 * Lives outside worker.ts so the smoke battery can drive it headlessly
 * (pdf-lib oracle): header block with labels on the value's first
 * baseline, hairline divider, word-wrapped body with pagination, and
 * the honest attachment list.
 */

import type { CreateContext, CreatePage, StampFontKey } from "@/lib/own/pdf";
import type { ConvertFace } from "../convert-common/face";
import { faceWidth } from "../convert-common/face";
import type { EmailDoc } from "./worker-lib";

export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export type EmailPageSize = keyof typeof PAGE_SIZES;

const MARGIN = 54;
const BODY_SIZE = 10.5;
const SUBJECT_SIZE = 14;
const HEADER_SIZE = 10.5;
const ATT_HEADING_SIZE = 11.5;
const LINE_GAP = 1.45; // × font size
const LABEL_INK = { r: 0.42, g: 0.45, b: 0.5 };
const INK = { r: 0.1, g: 0.12, b: 0.15 };
const RULE_INK = { r: 0.85, g: 0.86, b: 0.88 };

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── layout primitives ──────────────────────────────────────────────────── */

interface Cursor {
  page: CreatePage;
  y: number;
}

interface Renderer {
  doc: CreateContext;
  face: ConvertFace;
  boldKey: StampFontKey | null;
  pageSize: EmailPageSize;
  cursor: Cursor;
}

function newCursor(doc: CreateContext, pageSize: EmailPageSize): Cursor {
  const size = PAGE_SIZES[pageSize];
  return { page: doc.addPage(size.width, size.height), y: size.height - MARGIN };
}

function ensureRoom(r: Renderer, needed: number): void {
  if (r.cursor.y - needed < MARGIN) {
    r.cursor = newCursor(r.doc, r.pageSize);
  }
}

/** Word-wrap one logical line to a width; long words hard-split. */
export function wrapEmailLine(
  r: Pick<Renderer, "doc" | "face">,
  line: string,
  size: number,
  maxWidth: number,
): string[] {
  if (line === "") return [""];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(/\s+/)) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (faceWidth(r.doc, r.face, candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      out.push(current);
      current = "";
    }
    if (faceWidth(r.doc, r.face, word, size) <= maxWidth) {
      current = word;
    } else {
      let piece = "";
      for (const ch of word) {
        if (piece !== "" && faceWidth(r.doc, r.face, piece + ch, size) > maxWidth) {
          out.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      current = piece;
    }
  }
  if (current !== "" || out.length === 0) out.push(current);
  return out;
}

function drawText(
  r: Renderer,
  text: string,
  x: number,
  baseline: number,
  size: number,
  opts: { bold?: boolean; color?: { r: number; g: number; b: number } } = {},
): void {
  if (text === "") return;
  const face = r.face;
  const fontOpts =
    face.ttf !== undefined
      ? { ttf: face.ttf }
      : { font: opts.bold && r.boldKey ? r.boldKey : (face.std ?? "helvetica") };
  r.cursor.page.drawText({
    text,
    x,
    y: baseline,
    size,
    color: opts.color ?? INK,
    ...fontOpts,
  });
}

function drawLines(
  r: Renderer,
  lines: string[],
  size: number,
  x: number,
  opts: { bold?: boolean; color?: { r: number; g: number; b: number } } = {},
): void {
  for (const line of lines) {
    ensureRoom(r, size * LINE_GAP);
    r.cursor.y -= size * LINE_GAP;
    drawText(r, line, x, r.cursor.y, size, opts);
  }
}

function drawParagraph(
  r: Renderer,
  text: string,
  size: number,
  width: number,
  x = MARGIN,
): void {
  drawLines(r, wrapEmailLine(r, text, size, width), size, x);
}

/** Label + wrapped value sharing the FIRST line's baseline. */
function drawLabelValue(
  r: Renderer,
  label: string,
  value: string,
  size: number,
  contentW: number,
): void {
  const valueX = MARGIN + 52;
  const lines = wrapEmailLine(r, value, size, contentW - 52);
  ensureRoom(r, size * LINE_GAP);
  r.cursor.y -= size * LINE_GAP;
  drawText(r, label, MARGIN, r.cursor.y, size, { color: LABEL_INK });
  drawText(r, lines[0] ?? "", valueX, r.cursor.y, size);
  if (lines.length > 1) {
    drawLines(r, lines.slice(1), size, valueX);
  }
}

/* ─── the painter ────────────────────────────────────────────────────────── */

export function renderEmail(
  doc: CreateContext,
  email: EmailDoc,
  face: ConvertFace,
  boldKey: StampFontKey | null,
  pageSize: EmailPageSize,
  includeHeaders: boolean,
  includeAttachments: boolean,
): number {
  const size = PAGE_SIZES[pageSize];
  const contentW = size.width - MARGIN * 2;
  const pagesBefore = doc.pageCount;
  const r: Renderer = {
    doc,
    face,
    boldKey,
    pageSize,
    cursor: newCursor(doc, pageSize),
  };

  if (includeHeaders) {
    if (email.subject !== "") {
      drawParagraph(r, email.subject, SUBJECT_SIZE, contentW);
      r.cursor.y -= 6;
    }
    if (email.from !== "") drawLabelValue(r, "From:", email.from, HEADER_SIZE, contentW);
    if (email.to !== "") drawLabelValue(r, "To:", email.to, HEADER_SIZE, contentW);
    if (email.cc !== "") drawLabelValue(r, "Cc:", email.cc, HEADER_SIZE, contentW);
    if (email.date !== "") drawLabelValue(r, "Date:", email.date, HEADER_SIZE, contentW);
    r.cursor.y -= 10;
    r.cursor.page.drawLine({
      start: { x: MARGIN, y: r.cursor.y },
      end: { x: size.width - MARGIN, y: r.cursor.y },
      thickness: 0.75,
      color: RULE_INK,
    });
    r.cursor.y -= 8;
  }

  if (email.body !== "") {
    for (const para of email.body.split("\n")) {
      if (para.trim() === "") {
        r.cursor.y -= BODY_SIZE * 0.7;
        continue;
      }
      drawParagraph(r, para, BODY_SIZE, contentW);
    }
    if (email.bodyWasHtml) {
      r.cursor.y -= 8;
      drawParagraph(
        r,
        "(The original message only had an HTML body — converted to plain text.)",
        8.5,
        contentW,
      );
    }
  } else {
    drawParagraph(r, "(This message has no text body.)", BODY_SIZE, contentW);
  }

  if (includeAttachments && email.attachments.length > 0) {
    r.cursor.y -= 14;
    drawParagraph(r, `Attachments (${email.attachments.length})`, ATT_HEADING_SIZE, contentW);
    for (const att of email.attachments) {
      const lines = wrapEmailLine(
        r,
        `${att.filename} — ${formatAttachmentSize(att.size)}`,
        BODY_SIZE,
        contentW - 14,
      );
      ensureRoom(r, BODY_SIZE * LINE_GAP);
      r.cursor.y -= BODY_SIZE * LINE_GAP;
      drawText(r, "•", MARGIN, r.cursor.y, BODY_SIZE);
      drawText(r, lines[0] ?? "", MARGIN + 14, r.cursor.y, BODY_SIZE);
      if (lines.length > 1) {
        drawLines(r, lines.slice(1), BODY_SIZE, MARGIN + 14);
      }
    }
  }

  return doc.pageCount - pagesBefore;
}
