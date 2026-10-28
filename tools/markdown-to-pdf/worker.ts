import {
  CreateContext,
  type CreateImage,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { embedDocumentImageOwn, sniffEmbedKind } from "@/lib/pdf/embed-image-own";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { faceOpts, faceWidth, rgb, type ConvertFace } from "../convert-common/face";
import { readTextFile } from "../txt-to-pdf/engine";
import {
  PAGE_SIZES,
  blockScript,
  outputBaseName,
  type FontSpec,
  type MeasureRun,
  type ScriptFont,
} from "../txt-to-pdf/text-layout";
import {
  collectImageUrls,
  layoutMd,
  matchImageAsset,
  parseMarkdown,
  resolveMdOptions,
  type MdImageDims,
} from "./engine";

/**
 * Markdown → PDF worker (PRD §8.6). Parses with mdast-util-from-markdown
 * INSIDE this worker and lays the document out with the shared
 * text-layout engine (see ../txt-to-pdf/text-layout.ts), then paints with
 * OUR CreateContext engine (P6-n): headings in Helvetica bold, body
 * 10-12pt, Courier code blocks with gray backgrounds, quote bars,
 * footnote-style links + a Links section, optional warm-paper theme.
 * Devanagari (any non-WinAnsi block) renders through the embedded Noto
 * font — OUR Type0/CIDFontType2 subsetter + Indic shaper (embedTtf), the
 * same create-side recipe as every converted family here. Each file
 * becomes its own <base>.pdf. Device-only, zero pdf-lib in the shipped
 * path.
 *
 * IMAGES (audit R4-a): the drop accepts PNG/JPEG files alongside the
 * markdown (≤ MAX_MD_FILES files, ≤ MAX_MD_TOTAL_BYTES total — honest
 * error beyond). Block-level `![alt](photo.png)` references resolve
 * against the dropped files BY BASENAME (subdirs, %20 and query strings
 * stripped) and embed at their spot via the shared embed helper —
 * original bytes, downscale only for oversized images. Inline images,
 * remote http(s) URLs and unmatched files keep the honest "[alt]"
 * text (no network — the on-device promise), counted in the result.
 *
 * PARSER LOADING (P4.1 QA finding): Turbopack's dev worker loader compiles
 * this worker to a CLASSIC blob script that loads chunks via importScripts
 * — ESM-only packages (mdast-util-from-markdown/micromark) die there with a
 * silent SyntaxError, so the parser ships precompiled as the self-hosted
 * classic bundle /md/md-parser.js (worker-safe: built with
 * --conditions=worker so decode-named-character-reference avoids its
 * browser DOM variant). Production module workers get the same bundle via
 * fetch + indirect eval (the CSP ships unsafe-eval). The parser is cached
 * after the first load; zero network beyond the same-origin static asset.
 */

/** Files accepted per drop (markdown + image assets together). */
const MAX_MD_FILES = 20;
/** Total drop size cap (markdown + images). */
const MAX_MD_TOTAL_BYTES = 50 * 1024 * 1024;

type MdParseFn = (source: string) => import("mdast").Root;

let mdParseCache: MdParseFn | null = null;

/** Absolute URL for the parser bundle — blob workers (Turbopack dev) cannot
 * resolve root-relative importScripts paths ("URL is invalid"), so the origin
 * is recovered from the blob URL (the stamp-common font recipe). */
function mdParserUrl(): string {
  const blobMatch = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobMatch) return `${blobMatch[1]}/md/md-parser.js`;
  return new URL("/md/md-parser.js", self.location.href).toString();
}

/** Loads + caches the precompiled markdown parser (classic bundle). */
async function loadMdParse(): Promise<MdParseFn> {
  if (mdParseCache !== null) return mdParseCache;
  const globalKey = "__DOCO_MD_PARSE__" as const;
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals[globalKey] === "function") {
    mdParseCache = globals[globalKey] as MdParseFn;
    return mdParseCache;
  }
  // Classic worker (Turbopack dev): the bundle is a plain script that
  // defines the global — one importScripts call, same-origin static file.
  const importScriptsFn = (globalThis as {
    importScripts?: (url: string) => void;
  }).importScripts;
  if (typeof importScriptsFn === "function") {
    importScriptsFn(mdParserUrl());
    const loaded = globals[globalKey];
    if (typeof loaded === "function") {
      mdParseCache = loaded as MdParseFn;
      return mdParseCache;
    }
  }
  // Module worker (production): fetch the classic script text and run it
  // in this scope via indirect eval — allowed by the shipped CSP
  // (script-src 'unsafe-eval') and still 100% same-origin + on-device.
  const response = await fetch("/md/md-parser.js");
  if (!response.ok) throw new Error("md-parser-missing");
  const code = await response.text();
  // Indirect eval (CSP 'unsafe-eval') — the bundle is a same-origin,
  // build-time-pinned asset, so this is as safe as importScripts.
  (0, eval)(code);
  const evalLoaded = globals[globalKey];
  if (typeof evalLoaded !== "function") {
    throw new Error("md-parser-unavailable");
  }
  mdParseCache = evalLoaded as MdParseFn;
  return mdParseCache;
}

const COLORS = {
  text: rgb(0.1, 0.1, 0.12),
  muted: rgb(0.45, 0.45, 0.5),
  link: rgb(0.059, 0.463, 0.431), // #0F766E — DocoPDF ink teal
  codeBgClean: rgb(0.92, 0.92, 0.92),
  codeBgWarm: rgb(0.945, 0.925, 0.88),
  quoteBar: rgb(0.72, 0.72, 0.76),
  rule: rgb(0.8, 0.8, 0.84),
  warmPage: rgb(1, 0.984, 0.949), // #FFFBF2
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Font set one output document needs (P6-n faces: std keys + ttf). */
interface FontSet {
  helv: ConvertFace;
  helvBold: ConvertFace;
  helvOblique: ConvertFace;
  helvBoldOblique: ConvertFace;
  courier: ConvertFace;
  courierBold: ConvertFace;
  noto: StampTtfFont | null;
  measure: MeasureRun;
  fontFor: (spec: FontSpec, script: ScriptFont) => ConvertFace;
}

async function loadFonts(
  doc: CreateContext,
  needNoto: boolean
): Promise<FontSet> {
  // the create-side recipe: base-14 std keys (no embed) + the embedded
  // Devanagari TTF through OUR subsetter/shaper (embedTtf)
  let noto: StampTtfFont | null = null;
  if (needNoto) {
    const bytes = await loadDevanagariBytes(); // throws "devanagari-font-fetch"
    noto = doc.embedTtf(bytes);
  }
  const courier = { std: "courier" } as const;
  const courierBold = { std: "courierBold" } as const;
  const helvBoldOblique = { std: "helveticaBoldOblique" } as const;
  const helvBold = { std: "helveticaBold" } as const;
  const helvOblique = { std: "helveticaOblique" } as const;
  const helv = { std: "helvetica" } as const;

  const fontFor = (spec: FontSpec, script: ScriptFont): ConvertFace => {
    if (script === "noto" && noto) return { ttf: noto };
    if (spec.family === "mono") return spec.bold ? courierBold : courier;
    if (spec.bold && spec.italic) return helvBoldOblique;
    if (spec.bold) return helvBold;
    if (spec.italic) return helvOblique;
    return helv;
  };
  return {
    helv,
    helvBold,
    helvOblique,
    helvBoldOblique,
    courier,
    courierBold,
    noto,
    measure: (text: string, spec: FontSpec, size: number, script: ScriptFont) =>
      faceWidth(doc, fontFor(spec, script), text, size),
    fontFor,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  if (files.length > MAX_MD_FILES) {
    post({ type: "error", runId, code: "md2pdf.errorTooMany" });
    return;
  }
  let totalBytes = 0;
  for (const file of files) totalBytes += file.size;
  if (totalBytes > MAX_MD_TOTAL_BYTES) {
    post({ type: "error", runId, code: "md2pdf.errorTooLarge" });
    return;
  }
  const opts = resolveMdOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const decoded: { name: string; base: string; text: string }[] = [];
  const assets: { name: string; bytes: Uint8Array }[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // PNG/JPEG drops become image assets for block-level ![alt](path)
    // references (audit R4-a); everything else follows the text path.
    if (sniffEmbedKind(bytes.subarray(0, 16)) !== null) {
      assets.push({ name: file.name, bytes });
      continue;
    }
    const verdict = readTextFile(bytes);
    if (verdict.kind === "binary") {
      post({
        type: "error",
        runId,
        code: "md2pdf.errorBinary",
        detail: file.name,
      });
      return;
    }
    if (verdict.kind === "empty") {
      post({
        type: "error",
        runId,
        code: "md2pdf.errorEmpty",
        detail: file.name,
      });
      return;
    }
    if (verdict.kind === "unsupported") {
      post({
        type: "error",
        runId,
        code: "md2pdf.errorUnsupportedScript",
        detail: file.name,
      });
      return;
    }
    decoded.push({
      name: file.name,
      base: outputBaseName(file.name),
      text: verdict.text,
    });
  }

  if (decoded.length === 0) {
    // Only images were dropped — honest error, nothing to convert.
    post({ type: "error", runId, code: "md2pdf.errorNoMd" });
    return;
  }

  const pageSize = PAGE_SIZES[opts.pageSize];
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let totalEmbedded = 0;
  let totalSkipped = 0;

  // Parser first (throws typed errors before any per-file work).
  const mdParse = await loadMdParse();

  for (let fileIndex = 0; fileIndex < decoded.length; fileIndex += 1) {
    const file = decoded[fileIndex];
    const parsed = parseMarkdown(file.text, mdParse);
    const needNoto = blockScript(file.text) === "noto";
    const doc = CreateContext.create();
    const fonts = await loadFonts(doc, needNoto);

    post({ type: "progress", runId, pct: 8, stage: "processing" });

    // Images (audit R4-a): embed every referenced local file once per
    // document, original bytes first (downscale only for oversized),
    // then hand the dims map to the layout. Unmatched/remote/unsupported
    // references never reach the map — the layout degrades them to the
    // honest "[alt]" text and counts them for the result card.
    const dims: MdImageDims = new Map();
    const embeddedByUrl = new Map<string, CreateImage>();
    for (const url of collectImageUrls(parsed)) {
      const assetName = matchImageAsset(
        url,
        assets.map((a) => a.name)
      );
      if (assetName === null || dims.has(url)) continue;
      const asset = assets.find((a) => a.name === assetName);
      if (asset === undefined) continue;
      const embedded = await embedDocumentImageOwn(doc, asset.bytes);
      if (embedded === null) continue;
      dims.set(url, { width: embedded.width, height: embedded.height });
      embeddedByUrl.set(url, embedded.image);
    }

    const result = layoutMd(parsed, opts, fonts.measure, dims);

    for (let p = 0; p < result.pages.length; p += 1) {
      const page = doc.addPage(pageSize.width, pageSize.height);
      const draw = result.pages[p];
      if (draw.warm) {
        page.drawRectangle({
          x: 0,
          y: 0,
          width: pageSize.width,
          height: pageSize.height,
          color: COLORS.warmPage,
        });
      }
      for (const rect of draw.rects) {
        page.drawRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
          color:
            rect.kind === "codeBg"
              ? opts.theme === "warm"
                ? COLORS.codeBgWarm
                : COLORS.codeBgClean
              : rect.kind === "quoteBar"
                ? COLORS.quoteBar
                : COLORS.rule,
        });
      }
      for (const run of draw.runs) {
        if (run.text.length === 0) continue;
        page.drawText({
          x: run.x,
          y: run.baseline,
          text: run.text,
          size: run.size,
          ...faceOpts(fonts.fontFor(run.spec, run.script)),
          color:
            run.color === "link"
              ? COLORS.link
              : run.color === "muted"
                ? COLORS.muted
                : COLORS.text,
        });
      }
      for (const image of draw.images) {
        const embedded = embeddedByUrl.get(image.url);
        if (!embedded) continue;
        page.drawImage(embedded, {
          x: image.x,
          y: image.y,
          width: image.w,
          height: image.h,
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

    totalEmbedded += result.imageCount;
    totalSkipped += result.imagesSkipped;

    const saved = doc.write();
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
    detail: {
      files: outputs.length,
      pages: totalPages,
      imagesEmbedded: totalEmbedded,
      imagesSkipped: totalSkipped,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /font-fetch|devanagari|fontkit/i.test(message)
      ? "md2pdf.errorFont"
      : "tool.errorGeneric";
    post({
      type: "error",
      runId: data.runId,
      code,
      detail: code === "tool.errorGeneric" ? message.slice(0, 200) : undefined,
    });
  });
};
