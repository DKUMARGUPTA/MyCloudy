import {
  PdfError,
  StampContext,
  WinAnsiError,
  type AcroFieldInfo,
  type StampTtfFont,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { loadDevanagariBytes } from "../stamp-common/deva";

/**
 * Fill out PDF forms worker (PRD §8.2): applies the entered values to the
 * AcroForm fields on OUR engine (P6-p — StampContext.setSource* + the
 * write-time appearance regeneration), optionally flattening the form —
 * fully on-device, zero network. Values arrive as flat option keys:
 *
 *   "f:<fileId>::<fully qualified field name>" -> string (text/radio/
 *   dropdown/optionlist, multi-select joined with "\n") | boolean
 *   (checkbox), plus "fkey": the current file's workspace id.
 *
 * Only keys carrying the CURRENT file id apply — replacing the file in
 * the workspace can never leak answers into a different form. Read-only
 * fields were already disabled in the UI, so they never send values.
 * Untouched fields keep whatever the file already had.
 *
 * Appearance strategy (the subtle part): the write-time regeneration uses
 * the form's DEFAULT font (Helvetica, WinAnsi) — which CANNOT render e.g.
 * Hindi answers. Non-WinAnsi text fields are therefore re-set with the
 * embedded self-hosted Devanagari subset (the exact pipeline the stamp
 * tools use). When even that fails (offline first-run edge), the run
 * falls back to /NeedAppearances: the values ARE in the file, honest
 * readers regenerate the appearances with their own font handling.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ctx = StampContext.load(bytes); // typed encrypted/corrupt refusal

  const fields = ctx.readSourceFields();
  const byName = new Map(fields.map((f) => [f.name, f]));
  const fkey = typeof options.fkey === "string" ? options.fkey : "";
  const prefix = `f:${fkey}::`;
  /** Fields whose text needs the Devanagari route (re-set with the TTF). */
  const nonWinAnsi: Array<{ field: AcroFieldInfo; text: string }> = [];
  let needAppearances = false;

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  for (const [key, value] of Object.entries(options)) {
    if (!key.startsWith(prefix)) continue;
    const field = byName.get(key.slice(prefix.length));
    if (!field) continue;
    try {
      if (field.kind === "optionlist") {
        if (typeof value === "string" && value !== "") {
          const parts = value.split("\n").filter((part) => part !== "");
          if (parts.length > 0) ctx.setSourceChoice(field, parts);
        }
      } else if (field.kind === "dropdown") {
        if (typeof value === "string" && value !== "") {
          ctx.setSourceChoice(field, [value]);
        }
      } else if (field.kind === "radio") {
        if (typeof value === "string" && value !== "") {
          ctx.setSourceRadio(field, value);
        }
      } else if (field.kind === "checkbox") {
        if (typeof value === "boolean") {
          ctx.setSourceCheckbox(field, value);
        }
      } else if (field.kind === "text") {
        if (typeof value === "string") {
          const max = field.maxLength;
          const text =
            max !== null && max >= 0 ? value.slice(0, max) : value;
          try {
            ctx.setSourceTextField(field, text);
          } catch (error) {
            // WinAnsiError: /V IS already written (the engine contract) —
            // queue for the Devanagari second pass below.
            if (error instanceof WinAnsiError) {
              nonWinAnsi.push({ field, text });
            } else {
              throw error;
            }
          }
        }
      }
    } catch {
      // One stubborn field never kills the run — the values around it
      // still apply and the document still saves honestly.
    }
  }

  // Non-WinAnsi answers (e.g. Hindi): re-set those text fields with the
  // embedded self-hosted Devanagari subset so the write-time appearance
  // regeneration shapes them properly. Same pipeline as the stamp tools —
  // fetched from this origin, subset-embedded, never uploaded.
  if (nonWinAnsi.length > 0) {
    post({ type: "progress", runId, pct: 70, stage: "processing" });
    let deva: StampTtfFont | null = null;
    try {
      deva = ctx.embedTtf(await loadDevanagariBytes());
    } catch {
      // Font fetch/embed failed (offline first-run edge) — the values are
      // already in the file; flag NeedAppearances for honest viewers.
      needAppearances = true;
    }
    if (deva !== null) {
      for (const { field, text } of nonWinAnsi) {
        try {
          ctx.setSourceTextField(field, text, deva);
        } catch {
          // Individual render failures fall through to NeedAppearances.
          needAppearances = true;
        }
      }
    }
  }
  if (needAppearances) {
    try {
      ctx.setNeedAppearances();
    } catch {
      // No AcroForm at all — nothing more we can honestly do.
    }
  }

  // Flatten AFTER the values are set (PRD §8.2 "Flatten after fill
  // option"): answers become permanent page content. Damaged forms can
  // fail to flatten — the filled (still editable) file is the honest
  // fallback; the FAQ documents this.
  if (options.flatten === true) {
    post({ type: "progress", runId, pct: 82, stage: "processing" });
    try {
      ctx.flattenSourceForm();
    } catch {
      // Keep the unflattened result — values are already applied.
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  const saved = ctx.write();

  const outputs = [
    {
      name: `${fileBaseName(file.name)}-filled.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    },
  ];

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: ctx.pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof PdfError) {
      post({
        type: "error",
        runId: data.runId,
        code: error.code === "encrypted" ? "tool.errorEncrypted" : "tool.errorCorrupt",
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
