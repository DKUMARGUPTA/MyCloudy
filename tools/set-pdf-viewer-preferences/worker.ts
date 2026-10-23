import { NonFullScreenPageMode, PDFDocument, PDFName } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { hasExistingSignature } from "../digital-signature/model";
import { fileBaseName } from "../stamp-common/layout";

/**
 * Set viewer preferences — device-only worker (PRD §8.5 "Viewer
 * preferences": initial page layout, zoom, window title show, hide
 * toolbars, fullscreen).
 *
 * Everything is written with pdf-lib into the document catalog:
 *   PageLayout (how pages arrange) + PageMode (side panel / fullscreen)
 *   + the ViewerPreferences dict (toolbar/menubar/window UI/title/
 *   sizing) + an OpenAction destination (opening page + zoom).
 *
 * Every option is tri-state — "keep" means "don't touch that entry", so
 * a run that only picks a zoom leaves every other preference exactly as
 * the file had it. The file arrives by structured clone and the result
 * Blob goes back the same way. Never touches the network.
 *
 * A cryptographically signed input is refused honestly: the catalog
 * edits re-save the whole file, which would break the existing
 * signature (the digital-signature hasExistingSignature guard).
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

const LAYOUTS = [
  "SinglePage",
  "OneColumn",
  "TwoColumnLeft",
  "TwoColumnRight",
  "TwoPageLeft",
  "TwoPageRight",
] as const;

const PAGE_MODES = [
  "UseNone",
  "UseThumbs",
  "UseOutlines",
  "UseAttachments",
  "FullScreen",
] as const;

const EXIT_FS_MODES = [
  NonFullScreenPageMode.UseNone,
  NonFullScreenPageMode.UseThumbs,
  NonFullScreenPageMode.UseOutlines,
] as const;

const ZOOMS = ["50", "75", "100", "125", "150", "200", "fitPage", "fitWidth"] as const;

type Layout = (typeof LAYOUTS)[number];
type PageMode = (typeof PAGE_MODES)[number];
type Zoom = (typeof ZOOMS)[number];

function pickString(
  options: OptionValues,
  id: string,
  allowed: readonly string[]
): string | null {
  const value = options[id] === undefined || options[id] === null
    ? null
    : String(options[id]);
  return value !== null && (allowed as readonly string[]).includes(value)
    ? value
    : null;
}

/** "keep" → null (don't touch); otherwise the whitelisted value. */
function pickChoice(options: OptionValues, id: string, allowed: readonly string[]): string | null {
  const value = pickString(options, id, allowed);
  return value === "keep" ? null : value;
}

/** Tri-state boolean: null = keep, "on" = true, "off" = false. */
function pickTriState(options: OptionValues, id: string): boolean | null {
  const value = pickString(options, id, ["keep", "on", "off"]);
  if (value === "on") return true;
  if (value === "off") return false;
  return null;
}

function applyViewerPreferences(
  doc: PDFDocument,
  options: OptionValues,
  pageMode: PageMode | null
): void {
  const booleans = [
    "showTitle",
    "hideToolbar",
    "hideMenubar",
    "hideWindowUI",
    "fitWindow",
    "centerWindow",
  ].map((id) => pickTriState(options, id));

  // Nothing chosen and not fullscreen → leave the dict exactly as the
  // file has it (don't even create an empty one).
  const hasChoice = booleans.some((value) => value !== null);
  if (!hasChoice && pageMode !== "FullScreen") return;

  const vp = doc.catalog.getOrCreateViewerPreferences();
  if (booleans[0] !== null) vp.setDisplayDocTitle(booleans[0]);
  if (booleans[1] !== null) vp.setHideToolbar(booleans[1]);
  if (booleans[2] !== null) vp.setHideMenubar(booleans[2]);
  if (booleans[3] !== null) vp.setHideWindowUI(booleans[3]);
  if (booleans[4] !== null) vp.setFitWindow(booleans[4]);
  if (booleans[5] !== null) vp.setCenterWindow(booleans[5]);

  // Fullscreen needs a plan for what shows once the user LEAVES it —
  // otherwise readers fall back to whatever they feel like.
  if (pageMode === "FullScreen") {
    const exit = pickString(options, "exitFsMode", EXIT_FS_MODES);
    vp.setNonFullScreenPageMode(
      (exit as NonFullScreenPageMode | null) ?? NonFullScreenPageMode.UseNone
    );
  }
}

/**
 * The opening view: [page /XYZ left top zoom] keeps the reader's own
 * position (nulls) but forces the magnification; /Fit shows the whole
 * page; /FitH fills the width. A start page after the first works with
 * any of these (including "keep" zoom — null zoom, page jump only).
 */
function applyOpenAction(
  doc: PDFDocument,
  zoom: Zoom | null,
  startPage: number
): void {
  if (zoom === null && startPage <= 1) return;

  const pageCount = doc.getPageCount();
  if (pageCount < 1) return;
  const pageIndex = Math.min(Math.max(1, Math.floor(startPage)), pageCount) - 1;
  const pageRef = doc.getPage(pageIndex).ref;
  const ctx = doc.context;

  let destination;
  if (zoom === "fitPage") {
    destination = ctx.obj([pageRef, PDFName.of("Fit")]);
  } else if (zoom === "fitWidth") {
    destination = ctx.obj([pageRef, PDFName.of("FitH"), null]);
  } else {
    const factor = zoom === null ? null : Number(zoom) / 100;
    destination = ctx.obj([pageRef, PDFName.of("XYZ"), null, null, factor]);
  }

  doc.catalog.set(PDFName.of("OpenAction"), destination);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const layout = pickChoice(options, "layout", LAYOUTS) as Layout | null;
  const pageMode = pickChoice(options, "pageMode", PAGE_MODES) as PageMode | null;
  const zoom = pickChoice(options, "zoom", ZOOMS) as Zoom | null;
  const startPageRaw = Number(options.startPage ?? 1);
  const startPage = Number.isFinite(startPageRaw) ? startPageRaw : 1;

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (hasExistingSignature(bytes)) {
    post({ type: "error", runId, code: "tool.errorAlreadySigned" });
    return;
  }
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  if (layout !== null) {
    doc.catalog.set(PDFName.of("PageLayout"), PDFName.of(layout));
  }
  if (pageMode !== null) {
    doc.catalog.set(PDFName.of("PageMode"), PDFName.of(pageMode));
  }
  applyViewerPreferences(doc, options, pageMode);
  applyOpenAction(doc, zoom, startPage);

  post({ type: "progress", runId, pct: 88, stage: "saving" });
  const saved = await doc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-viewersettings.pdf`,
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
