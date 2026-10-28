import {
  CreateContext,
  type StampFontKey,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { outputBaseName, parseResumeRun, resumeNeedsNoto } from "./model";
import { drawResumePdf, type ResumeFace } from "./render";

/**
 * Create resume worker (CR-66) — device-only, zero network beyond the
 * same-origin font. Mirrors the create-invoice worker protocol:
 *
 *  1. parseResumeRun — full defensive coercion at the boundary (clamp
 *     arrays, strip control chars, dedupe section ids, cap lengths);
 *  2. font pick — pure-WinAnsi content embeds NO font at all
 *     (base-14 Helvetica + HelveticaBold, the smallest ATS-clean PDF
 *     possible), while ANY Devanagari char switches to the self-hosted
 *     Noto Sans Devanagari (OUR Type0/CIDFontType2 subsetter, P6-l);
 *  3. drawResumePdf — the exact render.ts the smoke script drives;
 *  4. write with producer "DocoPDF" and the localized file name.
 *
 * All display labels arrive pre-resolved in `labels` (the surface's t()),
 * so the PDF text matches the UI language exactly.
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const resume = parseResumeRun(String(request.options.resume ?? ""));
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    const doc = CreateContext.create();
    let font: ResumeFace;
    let boldFont: StampFontKey | null = null;
    if (resumeNeedsNoto(resume)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: hierarchy comes from size and
      // rules, keeping text extraction single-copy for ATS.
      const bytes = await loadDevanagariBytes(); // throws typed marker
      const ttf: StampTtfFont = doc.embedTtf(bytes);
      font = { ttf };
    } else {
      font = { std: "helvetica" };
      boldFont = "helveticaBold";
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = await drawResumePdf(doc, font, resume, { boldFont });
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    doc.setProducer("DocoPDF");
    doc.setCreator("DocoPDF");
    doc.setTitle(
      (resume.d.header.fullName || "Resume").slice(0, 120)
    );
    if (resume.d.header.fullName) doc.setAuthor(resume.d.header.fullName);
    doc.setCreationDate(new Date());

    const bytes = doc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name:
            outputBaseName(resume.d, resume.labels.fileWord ?? "") + ".pdf",
          mime: "application/pdf",
          blob: new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { pages: report.pages },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
