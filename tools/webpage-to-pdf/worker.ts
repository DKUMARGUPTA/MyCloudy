import { CreateContext, type StampTtfFont } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { type ConvertFace } from "../convert-common/face";
import {
  fetchErrorKey,
  looksLikeHtml,
  needsNoto,
  parseHtml,
  parseHtmlRun,
  pickBaseName,
  stats,
  type FetchPageResponse,
} from "./model";
import { validatePageUrl } from "./url-guard";
import { drawHtmlPdf, type HtmlFontSet } from "../html-to-pdf/render";

/**
 * Webpage to PDF worker (RB4-f) — URL in, PDF out, rendering 100% on the
 * user's device.
 *
 * The honest split (mirrored in the surface + FAQ): browsers cannot
 * fetch cross-origin pages (CORS), so step 1 POSTs the URL to OUR OWN
 * same-origin /api/fetch-page — a pass-through pipe that fetches the
 * HTML server-side, validates against SSRF targets, and hands the
 * string straight back (it is never stored anywhere). Steps 2-5 are the
 * html-to-pdf engine, verbatim:
 *
 *  1. validate the URL again on-device (http/https only) and fetch the
 *     page through the pipe;
 *  2. parseHtml → parseHtmlRun — the same tolerant tokenizer + boundary
 *     coercion the .html file tool uses;
 *  3. font pick — ONE decision per document: pure-WinAnsi content
 *     embeds nothing (base-14 Helvetica × Courier set as std keys),
 *     any non-WinAnsi char switches everything to the self-hosted Noto
 *     Devanagari subset (OUR Type0/CIDFontType2 subsetter + Indic
 *     shaper via embedTtf);
 *  4. drawHtmlPdf — the exact render.ts the smoke script drives;
 *  5. write with producer/creator "DocoPDF"; the name comes from the
 *     page's <title>, falling back to the hostname (dots → dashes,
 *     ASCII by URL construction).
 *
 * Options: url (the surface syncs its input through the shared option
 * values), pageSize ("a4"|"letter"), margin ("normal"|"narrow"),
 * baseFontSize ("small"|"normal"|"large"), showLinks (boolean), lang
 * ("en"|"hi" — the localized fallback word).
 */

const BASE_FONT_SIZES: Record<string, number> = {
  small: 10,
  normal: 11,
  large: 12.5,
};

/**
 * Same-origin API URL resolved against the worker's REAL base — the
 * stamp-common lesson: Turbopack dev serves workers from blob: URLs,
 * where a relative fetch("/api/…") throws "Failed to parse URL"; the
 * origin is recoverable from the blob URL itself.
 */
function apiUrl(): string {
  const path = "/api/fetch-page";
  try {
    const viaLocation = new URL(path, self.location.href);
    if (viaLocation.protocol === "http:" || viaLocation.protocol === "https:") {
      return viaLocation.href;
    }
  } catch {
    /* opaque base (blob: workers) — fall through */
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

/** the worker's EN font set — the 8 base-14 std keys as cheap face
 * consts (the create-side recipe: std faces embed nothing, so the old
 * pdf-lib embedStandardFont cache has no work left to dedupe). */
function enFontSet(): HtmlFontSet {
  const courier = { std: "courier" } as const;
  const courierBold = { std: "courierBold" } as const;
  const courierBoldOblique = { std: "courierBoldOblique" } as const;
  const courierOblique = { std: "courierOblique" } as const;
  const helvetica = { std: "helvetica" } as const;
  const helveticaBold = { std: "helveticaBold" } as const;
  const helveticaBoldOblique = { std: "helveticaBoldOblique" } as const;
  const helveticaOblique = { std: "helveticaOblique" } as const;
  return {
    isNoto: false,
    resolve(bold, italic, mono): ConvertFace {
      if (mono) {
        return bold && italic
          ? courierBoldOblique
          : bold
            ? courierBold
            : italic
              ? courierOblique
              : courier;
      }
      return bold && italic
        ? helveticaBoldOblique
        : bold
          ? helveticaBold
          : italic
            ? helveticaOblique
            : helvetica;
    },
  };
}

/** POST one URL through the pipe; never touches anything but the JSON. */
async function fetchPage(url: URL): Promise<
  { ok: true; html: string; finalUrl: string } | { ok: false; code: string }
> {
  let res: Response;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url.toString() }),
    });
  } catch {
    return { ok: false, code: "fetch-failed" };
  }
  let json: FetchPageResponse;
  try {
    json = (await res.json()) as FetchPageResponse;
  } catch {
    return { ok: false, code: "fetch-failed" };
  }
  if (!json || typeof json !== "object" || json.ok !== true) {
    const errorField =
      json && typeof json === "object"
        ? (json as { error?: unknown }).error
        : undefined;
    const code =
      typeof errorField === "string" && errorField !== ""
        ? errorField
        : "fetch-failed";
    return { ok: false, code };
  }
  return { ok: true, html: json.html, finalUrl: json.finalUrl };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    /* ---------- 1. URL gate + the pipe ---------- */
    const rawUrl = String(request.options.url ?? "");
    const entry = validatePageUrl(rawUrl);
    if (!entry.ok) {
      post({ type: "error", runId, code: "wpdf.errUrl" });
      return;
    }

    post({ type: "progress", runId, pct: 12, stage: "reading" });
    const page = await fetchPage(entry.url);
    if (!page.ok) {
      post({ type: "error", runId, code: fetchErrorKey(page.code) });
      return;
    }

    /* ---------- 2. parse + boundary coercion (engine) ---------- */
    // (the pipe already capped the body at 5 MB — under the engine's
    // 20 MB file gate — and parseHtmlRun clamps blocks/runs/cells)
    if (!looksLikeHtml(page.html)) {
      post({ type: "error", runId, code: "wpdf.errNotHtml" });
      return;
    }
    const doc = parseHtmlRun(JSON.stringify(parseHtml(page.html)));
    if (doc.blocks.length === 0) {
      // honest SPA/paywall case: the server HTML carried no readable text
      post({ type: "error", runId, code: "wpdf.errNoContent" });
      return;
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    /* ---------- 3. options ---------- */
    const opts = {
      pageSize: (String(request.options.pageSize) === "letter"
        ? "letter"
        : "a4") as "a4" | "letter",
      margin: (String(request.options.margin) === "narrow"
        ? "narrow"
        : "normal") as "normal" | "narrow",
      baseFontSize: BASE_FONT_SIZES[String(request.options.baseFontSize)] ?? 11,
      showLinks: request.options.showLinks === true,
    };
    const lang: "en" | "hi" = String(request.options.lang) === "hi" ? "hi" : "en";

    /* ---------- 4. fonts + render (the engine, verbatim) ---------- */
    const pdfDoc = CreateContext.create();
    let fonts: HtmlFontSet;
    if (needsNoto(doc)) {
      // loadDevanagariBytes throws the typed "devanagari-font-fetch".
      const noto: StampTtfFont = pdfDoc.embedTtf(await loadDevanagariBytes());
      fonts = { isNoto: true, resolve: () => ({ ttf: noto }) };
    } else {
      fonts = enFontSet();
    }
    post({ type: "progress", runId, pct: 65, stage: "processing" });

    const report = drawHtmlPdf(pdfDoc, fonts, doc, opts);
    post({ type: "progress", runId, pct: 88, stage: "saving" });

    /* ---------- 5. write + name ---------- */
    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    const baseName = pickBaseName(doc.title, page.finalUrl, lang);
    pdfDoc.setTitle(baseName);
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${baseName}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { pages: report.pages, words: stats(doc).wordCount },
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
