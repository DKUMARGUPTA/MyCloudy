import {
  PDFBool,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { isWinAnsiText } from "./scan";

/**
 * Fill out PDF forms worker (PRD §8.2): applies the entered values to the
 * AcroForm fields with pdf-lib and optionally flattens the form — fully
 * on-device, zero network. Values arrive as flat option keys:
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
 * Appearance strategy (the subtle part): doc.save() regenerates the
 * appearance streams of dirty fields with the form's DEFAULT font
 * (Helvetica, WinAnsi) — which THROWS for e.g. Hindi answers and would
 * kill the whole run. Non-WinAnsi text fields are therefore re-rendered
 * FIRST with the embedded self-hosted Devanagari subset (the exact
 * pipeline the stamp tools use). If anything still can't be encoded, the
 * run falls back to NeedAppearances + save without regeneration: the
 * values are always in the file, honest readers render them.
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
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  const form = doc.getForm();
  const byName = new Map(form.getFields().map((f) => [f.getName(), f]));
  const fkey = typeof options.fkey === "string" ? options.fkey : "";
  const prefix = `f:${fkey}::`;
  const nonWinAnsiFields: PDFTextField[] = [];

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  for (const [key, value] of Object.entries(options)) {
    if (!key.startsWith(prefix)) continue;
    const field = byName.get(key.slice(prefix.length));
    if (!field) continue;
    try {
      if (field instanceof PDFOptionList) {
        if (typeof value === "string" && value !== "") {
          const parts = value.split("\n").filter((part) => part !== "");
          if (parts.length > 0) field.select(parts);
        }
      } else if (field instanceof PDFDropdown) {
        if (typeof value === "string" && value !== "") field.select(value);
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === "string" && value !== "") field.select(value);
      } else if (field instanceof PDFCheckBox) {
        if (typeof value === "boolean") {
          if (value) field.check();
          else field.uncheck();
        }
      } else if (field instanceof PDFTextField) {
        if (typeof value === "string") {
          const max = field.getMaxLength();
          const text =
            typeof max === "number" && max >= 0 ? value.slice(0, max) : value;
          field.setText(text);
          if (!isWinAnsiText(text)) nonWinAnsiFields.push(field);
        }
      }
    } catch {
      // One stubborn field never kills the run — the values around it
      // still apply and the document still saves honestly.
    }
  }

  // Non-WinAnsi answers (e.g. Hindi): re-render those text fields with
  // the embedded self-hosted Devanagari subset BEFORE save() tries the
  // default-font regeneration (which would throw). Same pipeline as the
  // stamp tools — fetched from this origin, subset-embedded, never uploaded.
  if (nonWinAnsiFields.length > 0) {
    post({ type: "progress", runId, pct: 70, stage: "processing" });
    try {
      const fonts = await loadStampFonts(doc, true);
      const deva = fonts.fontFor("devanagari");
      for (const field of nonWinAnsiFields) {
        try {
          field.defaultUpdateAppearances(deva);
        } catch {
          // Individual render failures fall through to the save() path.
        }
      }
    } catch {
      // Font fetch/embed failed (offline first-run edge) — the save()
      // fallback below handles it via NeedAppearances.
    }
  }

  // Flatten AFTER the values are set (PRD §8.2 "Flatten after fill
  // option"): answers become permanent page content. Damaged forms can
  // fail to flatten — the filled (still editable) file is the honest
  // fallback; the FAQ documents this.
  if (options.flatten === true) {
    post({ type: "progress", runId, pct: 82, stage: "processing" });
    try {
      form.flatten();
    } catch {
      // Keep the unflattened result — values are already applied.
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  let saved: Uint8Array;
  try {
    saved = await doc.save({ useObjectStreams: true });
  } catch {
    // Regeneration with the form's default font still fails (exotic
    // scripts, damaged fields): store the values (they ARE in the file),
    // flag NeedAppearances and save WITHOUT regeneration — real PDF
    // readers then render the values with their own font handling.
    try {
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
    } catch {
      // Very damaged AcroForm — nothing more we can honestly do.
    }
    saved = await doc.save({
      useObjectStreams: true,
      updateFieldAppearances: false,
    });
  }

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
    detail: { files: 1, pages: doc.getPageCount() },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
