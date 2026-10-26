import { PDFDocument } from "pdf-lib";
import { strToU8 } from "@/lib/own/zip";

import type { OptionValues } from "@/lib/tools/config-types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import { hasExistingSignature } from "../digital-signature/model";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { FlattenFormsError, flattenDocument } from "../flatten-pdf/engine";
import {
  buildRequestText,
  needsNoto,
  parseRequestRun,
  safeBaseName,
} from "./model";
import { buildNotePdf, drawSignHereBoxes, zipPack } from "./render";
import type { RequestPackRun } from "./types";

/**
 * Request signature worker (RB6-b, security — 100% on-device).
 *
 * The PREPARE half of "prepare & send": it never transmits anything.
 *
 *  1. load the PDF (encrypted → honest error, unreadable → corrupt);
 *  2. parse + coerce the request payload (details + spots + localized
 *     note labels the surface rendered with t()); zero usable spots is
 *     rejected — one spot is the honest minimum;
 *  3. optional "flatten existing form fields first" — the house
 *     flatten-pdf engine, forms-only scope (pdf-lib's own form flatten
 *     burns current values into the page and drops the widgets); runs
 *     BEFORE the signature fields are added so it can never eat them.
 *     "Nothing to flatten" is fine (most documents have no form);
 *  4. drawSignHereBoxes — visible numbered dashed "Sign here" boxes +
 *     REAL empty AcroForm /Sig fields over each spot (render.ts, the
 *     exact code the smoke drives);
 *  5. build the request-note PDF + the plain-text note;
 *  6. assemble the signing pack: a .zip (fflate, on-device — the office
 *     tools' recipe) holding the prepared PDF + the note PDF.
 *
 * Outputs (3):
 *   <base>-to-sign.pdf        the attach-ready document
 *   <base>-signing-pack.zip   pack: to-sign PDF + request-note PDF
 *   <base>-request.txt        paste-ready plain-text note
 *
 * The mail draft (mailto:) is built by the SURFACE with the same model
 * code — a worker cannot open the user's mail client anyway.
 *
 * Error mapping:
 *   reqsig.errNoSpots      no usable signature spot in the payload
 *   reqsig.errFlatten      the form could not be flattened (honest stop)
 *   tool.errorAlreadySigned input already carries a digital signature
 *   tool.errorEncrypted    password-protected input
 *   tool.errorCorrupt       unreadable / pageless PDF
 *   tool.errorGeneric       no file / unexpected failure
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function readBool(options: OptionValues, id: string, fallback: boolean): boolean {
  const v = options[id];
  return typeof v === "boolean" ? v : fallback;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 3, stage: "reading" });

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  // The prepared pack re-saves the whole input through pdf-lib — that
  // shifts every byte offset and silently invalidates an existing
  // cryptographic signature's /ByteRange. Honest refusal (the
  // digital-signature guard recipe): ask for signatures on the
  // unsigned original, never re-save a signed one.
  if (hasExistingSignature(bytes)) {
    post({ type: "error", runId, code: "tool.errorAlreadySigned" });
    return;
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt",
    });
    return;
  }

  const pageCount = doc.getPageCount();
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  const parsed = parseRequestRun(options.request, pageCount);
  if (!parsed.ok) {
    post({ type: "error", runId, code: parsed.code });
    return;
  }
  const runPack: RequestPackRun = parsed.run;

  post({ type: "progress", runId, pct: 12, stage: "processing" });

  // --- optional: flatten the EXISTING form first (house engine) -----
  // A document with no form never throws — flattenDocument reports
  // nothingToDo and the run simply proceeds (nothing to burn).
  if (readBool(options, "flattenFirst", false)) {
    try {
      flattenDocument(doc, { scope: "forms-only" });
    } catch (error) {
      if (error instanceof FlattenFormsError) {
        post({ type: "error", runId, code: "reqsig.errFlatten" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        runId,
        code: "tool.errorGeneric",
        detail: message.slice(0, 200),
      });
      return;
    }
  }

  post({ type: "progress", runId, pct: 26, stage: "processing" });

  // --- fonts: the split-run WinAnsi-vs-Noto decision ------------------
  const d = runPack.details;
  const labelBlob = Object.values(runPack.labels).join(" ");
  const needDeva =
    needsNoto(labelBlob) ||
    needsNoto(d.recipientName) ||
    needsNoto(d.senderName) ||
    needsNoto(d.subject) ||
    needsNoto(d.message);

  const stamp = await loadStampFonts(doc, needDeva);
  const fonts = {
    base: stamp.fontFor("helvetica"),
    bold: stamp.fontFor("helveticaBold"),
    deva: needDeva ? stamp.fontFor("devanagari") : null,
  };

  post({ type: "progress", runId, pct: 42, stage: "processing" });

  // --- the prepared PDF ------------------------------------------------
  const sigFields = readBool(options, "sigFields", true);
  const report = drawSignHereBoxes(doc, runPack, fonts, { sigFields });

  post({ type: "progress", runId, pct: 60, stage: "saving" });

  const base = safeBaseName(file.name);
  const pdfName = `${base}-to-sign.pdf`;
  const prepared = await doc.save({ useObjectStreams: true });

  post({ type: "progress", runId, pct: 72, stage: "processing" });

  // --- the request-note PDF ---------------------------------------------
  const noteDoc = await PDFDocument.create();
  const noteStamp = await loadStampFonts(noteDoc, needDeva);
  buildNotePdf(
    noteDoc,
    runPack,
    file.name,
    {
      base: noteStamp.fontFor("helvetica"),
      bold: noteStamp.fontFor("helveticaBold"),
      deva: needDeva ? noteStamp.fontFor("devanagari") : null,
    }
  );
  const noteName = `${base}-request-note.pdf`;
  const noteBytes = await noteDoc.save({ useObjectStreams: true });

  // --- the plain-text note + the zip pack --------------------------------
  const txt = buildRequestText(runPack, file.name);
  const pack = zipPack([
    { name: pdfName, data: prepared },
    { name: noteName, data: noteBytes },
  ]);

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: pdfName,
        mime: "application/pdf",
        blob: new Blob([prepared as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
      {
        name: `${base}-signing-pack.zip`,
        mime: "application/zip",
        blob: new Blob([pack as unknown as BlobPart], { type: "application/zip" }),
      },
      {
        name: `${base}-request.txt`,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([strToU8(txt) as unknown as BlobPart], {
          type: "text/plain;charset=utf-8",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: pageCount,
      fields: sigFields ? report.spots.length : 0,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
  });
};
