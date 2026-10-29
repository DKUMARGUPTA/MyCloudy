import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

import {
  type FieldSpec,
  type PageView,
  buildFieldPdf,
  sanitizeSpecs,
} from "./engine";

/**
 * Make PDF fillable — worker (PRD §8.2 "Make fillable": "Auto-detect likely
 * fields (underlines, boxes) + manual add; field properties; export as
 * AcroForm").
 *
 * The surface does the detection (pdf.js operator lists, main thread) and
 * hands the final FieldSpec list through the options blob under
 * "f:<fileId>" (the redact epoch-key pattern — swapped files can never
 * leak another document's fields). This worker only builds: sanitize →
 * OWN-engine AcroForm (StampContext, P6-o-a) → save — the entire pipeline
 * is smoke-locked pure code in tools/make-pdf-fillable/engine.ts.
 *
 * Options read (exact ids, matching tools/make-pdf-fillable/config.ts):
 *   fkey     the "f:<fileId>" options key that holds the specs JSON
 *   border   "outlined" | "invisible" (text-field borders)
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function parseSpecs(raw: unknown): FieldSpec[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is FieldSpec =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as FieldSpec).page === "number" &&
        typeof (s as FieldSpec).x === "number" &&
        typeof (s as FieldSpec).y === "number" &&
        typeof (s as FieldSpec).w === "number" &&
        typeof (s as FieldSpec).h === "number"
    );
  } catch {
    return [];
  }
}

/** The specs JSON carries its own pageViews (pdf.js crop/rotate) — the
 *  surface serialises {views, specs} in one blob. */
interface FieldsBlob {
  specs: FieldSpec[];
  pageViews: PageView[];
}

function parseBlob(raw: unknown): FieldsBlob | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FieldsBlob>;
    if (!Array.isArray(parsed.specs)) return null;
    const specs = parsed.specs.filter(
      (s): s is FieldSpec =>
        typeof s === "object" && s !== null && typeof s.page === "number"
    );
    const views = Array.isArray(parsed.pageViews) ? parsed.pageViews : [];
    return {
      specs,
      pageViews: views.map((v) => ({
        x0: typeof v.x0 === "number" ? v.x0 : 0,
        y0: typeof v.y0 === "number" ? v.y0 : 0,
        x1: typeof v.x1 === "number" ? v.x1 : 612,
        y1: typeof v.y1 === "number" ? v.y1 : 792,
        rotate: v.rotate === 90 || v.rotate === 180 || v.rotate === 270 ? v.rotate : 0,
      })),
    };
  } catch {
    return null;
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  const opts = options as OptionValues & Record<string, string>;

  const fkey = typeof opts.fkey === "string" ? opts.fkey : "";
  const blob = parseBlob(opts[`f:${fkey}`]);
  const specs = blob ? blob.specs : parseSpecs(opts[fkey]);
  const pageViews = blob ? blob.pageViews : [];
  const outlined = String(options.border ?? "invisible") === "outlined";

  post({
    type: "progress",
    runId,
    pct: 5,
    stage: "reading",
  });

  const data = new Uint8Array(await file.arrayBuffer());

  const usable = sanitizeSpecs(specs, pageViews);
  if (usable.length === 0) {
    post({ type: "error", runId, code: "makeFillable.errorNoFields" });
    return;
  }

  post({
    type: "progress",
    runId,
    pct: 55,
    stage: "processing",
  });

  const { bytes, report } = await buildFieldPdf(data, usable, {
    outlinedTextFields: outlined,
  });

  post({
    type: "progress",
    runId,
    pct: 90,
    stage: "saving",
  });

  const outputName = `${safeBaseName(file.name)}-fillable.pdf`;

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: report.pages,
      fields: report.fieldsAdded,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let code = "makeFillable.errorBuild";
    if (/password/i.test(message)) {
      code = "tool.errorEncrypted";
    } else if (/Failed to parse|Invalid PDF|structure/i.test(message)) {
      code = "tool.errorCorrupt";
    } else if (/already exists|duplicate/i.test(message)) {
      code = "makeFillable.errorBuild";
    }
    post({
      type: "error",
      runId: data.runId,
      code,
      detail:
        code === "makeFillable.errorBuild" ? message.slice(0, 200) : undefined,
    });
  });
};
