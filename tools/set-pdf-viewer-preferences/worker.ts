import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  PdfError,
  arr,
  listPages,
  name,
  num,
  parsePdf,
  ref,
  rewriteDocument,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";
import { hasExistingSignature } from "../digital-signature/model";
import { fileBaseName } from "../stamp-common/layout";

/**
 * Set viewer preferences — device-only worker (PRD §8.5 "Viewer
 * preferences": initial page layout, zoom, window title show, hide
 * toolbars, fullscreen) — OWN ENGINE (P6-s).
 *
 * Everything is written into the document catalog (mutated on the parsed
 * graph, re-serialized by the preserve-numbers rewriter):
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
  "UseNone",
  "UseThumbs",
  "UseOutlines",
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

/** The catalog's dict map (null when the trailer /Root is unusable). */
function catalogMap(doc: ParsedPdf): Map<string, PdfObj> | null {
  const root = doc.trailer.get("Root");
  if (!root || root.k !== "ref") return null;
  const catalog = doc.getObject(root.num);
  if (!catalog || (catalog.k !== "dict" && catalog.k !== "stream")) return null;
  return catalog.m;
}

/** The live ViewerPreferences map, created (direct in the catalog) if absent. */
function viewerPreferencesMap(doc: ParsedPdf): Map<string, PdfObj> | null {
  const catalog = catalogMap(doc);
  if (catalog === null) return null;
  const existing = catalog.get("ViewerPreferences");
  if (existing !== undefined) {
    const obj = existing.k === "ref" ? doc.getObject(existing.num) : existing;
    if (obj && (obj.k === "dict" || obj.k === "stream")) return obj.m;
    // A malformed entry is replaced (tri-state edits still apply).
  }
  const fresh: PdfObj & { k: "dict" } = { k: "dict", m: new Map() };
  catalog.set("ViewerPreferences", fresh);
  return fresh.m;
}

function applyViewerPreferences(
  doc: ParsedPdf,
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

  const vp = viewerPreferencesMap(doc);
  if (vp === null) return;
  const setBool = (value: boolean | null, key: string): void => {
    if (value !== null) vp.set(key, { k: "bool", b: value });
  };
  setBool(booleans[0], "DisplayDocTitle");
  setBool(booleans[1], "HideToolbar");
  setBool(booleans[2], "HideMenubar");
  setBool(booleans[3], "HideWindowUI");
  setBool(booleans[4], "FitWindow");
  setBool(booleans[5], "CenterWindow");

  // Fullscreen needs a plan for what shows once the user LEAVES it —
  // otherwise readers fall back to whatever they feel like.
  if (pageMode === "FullScreen") {
    const exit = pickString(options, "exitFsMode", EXIT_FS_MODES);
    vp.set("NonFullScreenPageMode", name(exit ?? "UseNone"));
  }
}

/**
 * The opening view: [page /XYZ left top zoom] keeps the reader's own
 * position (nulls) but forces the magnification; /Fit shows the whole
 * page; /FitH fills the width. A start page after the first works with
 * any of these (including "keep" zoom — null zoom, page jump only).
 */
function applyOpenAction(
  doc: ParsedPdf,
  zoom: Zoom | null,
  startPage: number
): void {
  if (zoom === null && startPage <= 1) return;

  const pages = listPages(doc);
  if (pages.length < 1) return;
  const pageIndex =
    Math.min(Math.max(1, Math.floor(startPage)), pages.length) - 1;
  const pageRef = ref(pages[pageIndex]!.ref.num, 0);

  const nullObj: PdfObj = { k: "null" };
  let destination: PdfObj;
  if (zoom === "fitPage") {
    destination = arr(pageRef, name("Fit"));
  } else if (zoom === "fitWidth") {
    destination = arr(pageRef, name("FitH"), nullObj);
  } else {
    const factor = zoom === null ? nullObj : num(Number(zoom) / 100);
    destination = arr(pageRef, name("XYZ"), nullObj, nullObj, factor);
  }

  const catalog = catalogMap(doc);
  catalog?.set("OpenAction", destination);
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
  let doc: ParsedPdf;
  try {
    doc = parsePdf(bytes);
  } catch (error: unknown) {
    if (error instanceof PdfError && error.code === "encrypted") {
      post({ type: "error", runId, code: "tool.errorEncrypted" });
      return;
    }
    throw error;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  const catalog = catalogMap(doc);
  if (layout !== null) catalog?.set("PageLayout", name(layout));
  if (pageMode !== null) catalog?.set("PageMode", name(pageMode));
  applyViewerPreferences(doc, options, pageMode);
  applyOpenAction(doc, zoom, startPage);

  post({ type: "progress", runId, pct: 88, stage: "saving" });
  const saved = rewriteDocument(doc, { objectStreams: true });
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
    detail: { files: 1, pages: listPages(doc).length },
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
