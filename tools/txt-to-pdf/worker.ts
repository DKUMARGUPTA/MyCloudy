import {
  CreateContext,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { layoutTxt, readTextFile, resolveTxtOptions } from "./engine";
import {
  PAGE_SIZES,
  blockScript,
  outputBaseName,
  type FontSpec,
  type MeasureRun,
  type ScriptFont,
} from "./text-layout";

/**
 * Text → PDF worker (PRD §8.6). The registry's `accepts: "text"` makes the
 * DropZone accept anything, so THIS worker validates: UTF-8 decode with a
 * binary sniff (NUL byte / >10% replacement chars / %PDF- magic), an
 * honest unsupported-script check, and an empty-file check.
 *
 * Font pipeline = the create/write recipe on OUR engine (P6-i): pure-Latin
 * files measure/draw through the built-in Helvetica standard-14 (WinAnsi,
 * metrics exact); any file containing non-WinAnsi text embeds the
 * self-hosted /fonts/NotoSansDevanagari-Regular.ttf via our own
 * Type0/CIDFontType2 subsetter + HarfBuzz-grade Indic shaper (embedTtf) and
 * renders every block that needs it with real Devanagari glyphs. Each input
 * file becomes its own <base>.pdf — up to 10 per run. Device-only, zero
 * network with file data, zero pdf-lib in the shipped path.
 */

const TEXT_COLOR = { r: 0.1, g: 0.1, b: 0.12 } as const;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface DecodedFile {
  name: string;
  base: string;
  text: string;
  needNoto: boolean;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveTxtOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const decoded: DecodedFile[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const verdict = readTextFile(bytes);
    if (verdict.kind === "binary") {
      post({
        type: "error",
        runId,
        code: "txt2pdf.errorBinary",
        detail: file.name,
      });
      return;
    }
    if (verdict.kind === "empty") {
      post({
        type: "error",
        runId,
        code: "txt2pdf.errorEmpty",
        detail: file.name,
      });
      return;
    }
    if (verdict.kind === "unsupported") {
      post({
        type: "error",
        runId,
        code: "txt2pdf.errorUnsupportedScript",
        detail: file.name,
      });
      return;
    }
    decoded.push({
      name: file.name,
      base: outputBaseName(file.name),
      text: verdict.text,
      needNoto: blockScript(verdict.text) === "noto",
    });
  }

  const pageSize = PAGE_SIZES[opts.pageSize];
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < decoded.length; fileIndex += 1) {
    const file = decoded[fileIndex];
    const ctx = CreateContext.create();
    let noto: StampTtfFont | null = null;
    if (file.needNoto) {
      const bytes = await loadDevanagariBytes(); // throws "devanagari-font-fetch"
      noto = ctx.embedTtf(bytes);
    }
    // v1 rule: a "noto" block measures WHOLLY through the embedded TTF
    // (Noto carries Latin glyphs too — the whole-block font decision).
    const measure: MeasureRun = (
      text: string,
      _spec: FontSpec,
      size: number,
      script: ScriptFont
    ) =>
      script === "noto" && noto
        ? noto.measure(text, size)
        : ctx.measure(text, "helvetica", size);

    post({ type: "progress", runId, pct: 8, stage: "processing" });
    const result = layoutTxt(file.text, opts, measure);

    for (let p = 0; p < result.pages.length; p += 1) {
      const page = ctx.addPage(pageSize.width, pageSize.height);
      for (const line of result.pages[p].lines) {
        if (line.text.length === 0) continue;
        page.drawText({
          x: line.x,
          y: line.baseline,
          text: line.text,
          size: line.size,
          color: TEXT_COLOR,
          ...(line.script === "noto" && noto
            ? { ttf: noto }
            : { font: "helvetica" as const }),
        });
      }
      totalPages += 1;
      post({
        type: "progress",
        runId,
        pct: Math.round(
          8 +
            ((fileIndex + (p + 1) / result.pages.length) / decoded.length) * 86
        ),
        stage: "processing",
        detail: { page: p + 1, pages: result.pages.length },
      });
    }

    // R44 branding — metadata + filename only; the document stays clean.
    ctx.setProducer("DocoPDF");
    ctx.setCreator("DocoPDF");
    ctx.setTitle(file.base);
    ctx.setCreationDate(new Date());
    const saved = ctx.write();
    outputs.push({
      name: `${file.base}.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /font-fetch|devanagari|fontkit/i.test(message)
      ? "txt2pdf.errorFont"
      : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
