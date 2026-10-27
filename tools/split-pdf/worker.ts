import {
  PdfError,
  organizePages,
  parseForOrganize,
  type OrganizeSource,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  computeSplitPlan,
  fileKey,
  parseNumberListOption,
  type SplitMode,
} from "./plan";

/**
 * Split PDF — device-only worker (PRD §8.1).
 *
 * P6-d: runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero
 * external code). The single input PDF is parsed ONCE (typed refusal for
 * encrypted inputs, typed corrupt errors); the authoritative split plan
 * (the same pure module the panel previews with) is then written part by
 * part through organizePages — every write reuses the ONE parse. Size
 * mode still verifies every part against REAL saved bytes and splits
 * oversized parts in half. Every output part is NAMED AFTER ITS CONTENT
 * — its actual page range ("pages-1-5", "part-2-pages-6-9") — with the
 * ZIP-style "-2" suffix on collisions. Never touches the network;
 * receives/sends File and Blob objects only.
 *
 * Options (all optional — the panel owns the interactive values):
 *   mode: "range" | "everyN" | "bookmarks" | "size" | "visual" | "oddEven" | "blanks"
 *   ranges: string ("1-5, 8, 10-end"), oneFilePerRange: boolean
 *   everyN: number, maxSizeMb: number
 *   cutAfter: JSON number[]        (visual mode, 1-based, cut AFTER page)
 *   bookmarkStatus/bookmarkFileKey + bookmarkCuts: JSON number[]
 *   blankStatus/blankFileKey + blankPages: JSON number[]
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

const MODES: SplitMode[] = [
  "range",
  "everyN",
  "bookmarks",
  "size",
  "visual",
  "oddEven",
  "blanks",
];

function readMode(options: OptionValues): SplitMode {
  const raw = options.mode;
  return typeof raw === "string" && (MODES as string[]).includes(raw)
    ? (raw as SplitMode)
    : "range";
}

/** Maps an own-engine failure to the worker's i18n error code. */
function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

/**
 * "3-7" for a contiguous ascending run (1-based, display form), "3" for a
 * single page, null when the pages are scattered (e.g. the merged union of
 * "1-3, 8" in one-file-per-range OFF mode — a range-shaped name would lie).
 */
function pageSpan(pages: number[]): string | null {
  if (pages.length === 0) return null;
  let prev = pages[0];
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i] !== prev + 1) return null;
    prev = pages[i];
  }
  const from = pages[0] + 1;
  const to = pages[pages.length - 1] + 1;
  return from === to ? `${from}` : `${from}-${to}`;
}

function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart], {
    type: "application/pdf",
  });
}

interface BuiltPart {
  pages: number[];
  bytes: Uint8Array;
  label?: string;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: undefined,
    });
    return;
  }

  const mode = readMode(options);
  const ranges = typeof options.ranges === "string" ? options.ranges : "";
  const oneFilePerRange = options.oneFilePerRange !== false; // default ON
  const everyN = typeof options.everyN === "number" ? options.everyN : 5;
  const maxSizeMb =
    typeof options.maxSizeMb === "number" && options.maxSizeMb > 0
      ? options.maxSizeMb
      : 5;
  const cutAfter = parseNumberListOption(options.cutAfter);
  const bookmarkCuts = parseNumberListOption(options.bookmarkCuts);
  const blankPages = parseNumberListOption(options.blankPages);
  const key = fileKey(file.name, file.size);

  post({ type: "progress", runId, pct: 2, stage: "reading" });

  // ── ONE typed parse for the whole run — every part write reuses it. ──
  const bytes = new Uint8Array(await file.arrayBuffer());
  let source: OrganizeSource;
  try {
    source = parseForOrganize(bytes);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }
  const pageCount = source.pages.length;
  const fileSize = file.size;

  post({
    type: "progress",
    runId,
    pct: 8,
    stage: "processing",
    detail: { pages: pageCount },
  });

  // Detection guards: split inputs detected on the main thread must be
  // finished AND belong to THIS file (stale lists from a previous file are
  // rejected instead of silently mis-splitting).
  if (mode === "bookmarks") {
    const ready = options.bookmarkStatus === "done" && options.bookmarkFileKey === key;
    if (!ready) {
      post({
        type: "error",
        runId,
        code: "tool.splitWaitingDetect",
        detail: undefined,
      });
      return;
    }
    if (bookmarkCuts.length === 0) {
      post({
        type: "error",
        runId,
        code: "tool.splitNoBookmarks",
        detail: undefined,
      });
      return;
    }
  }
  if (mode === "blanks") {
    const ready = options.blankStatus === "done" && options.blankFileKey === key;
    if (!ready) {
      post({
        type: "error",
        runId,
        code: "tool.splitWaitingDetect",
        detail: undefined,
      });
      return;
    }
    if (blankPages.length === 0) {
      post({
        type: "error",
        runId,
        code: "tool.splitNoBlanks",
        detail: undefined,
      });
      return;
    }
  }

  const plan = computeSplitPlan({
    mode,
    pageCount,
    fileSize,
    ranges,
    oneFilePerRange,
    everyN,
    maxSizeMb,
    cutAfter,
    bookmarkCuts,
    blankPages,
  });
  if (plan === null) {
    post({
      type: "error",
      runId,
      code: "tool.errorInvalidPages",
      detail: ranges,
    });
    return;
  }
  if (plan.parts.length === 0) {
    post({
      type: "error",
      runId,
      code: "tool.splitNoParts",
      detail: undefined,
    });
    return;
  }

  const base = safeBaseName(file.name);
  const maxBytes = maxSizeMb * 1024 * 1024;
  const totalPages = plan.parts.reduce(
    (sum, part) => sum + part.pages.length,
    0
  );
  const built: BuiltPart[] = [];
  let pagesDone = 0;

  /** Global per-page progress (PRD §6.3: "Page x of y" — across parts). */
  const postProgress = (): void => {
    post({
      type: "progress",
      runId,
      pct: Math.min(90, 10 + Math.round(80 * (pagesDone / totalPages))),
      stage: "processing",
      detail: { page: pagesDone, pages: totalPages },
    });
  };

  /** Writes ONE part on the own engine from the single parsed source. */
  const writePart = (pages: number[]): Uint8Array => {
    const entries: PlanEntry[] = pages.map((pageIndex) => ({
      kind: "page",
      src: pageIndex,
    }));
    let baseDone = pagesDone;
    return organizePages(source, entries, (_fraction, page) => {
      // Real per-page beats: the global counter advances with each page
      // serialized (1-based `page` within THIS part).
      pagesDone = baseDone + page;
      postProgress();
    });
  };

  if (mode === "size") {
    // Estimated chunks first; every finished part is checked against real
    // saved bytes and halved while it exceeds the limit (a single
    // over-limit page stays alone — it can't be divided further).
    const addSized = (pages: number[]): void => {
      if (pages.length === 0) return;
      const start = pagesDone;
      const partBytes = writePart(pages);
      if (partBytes.length > maxBytes && pages.length > 1) {
        // The oversized attempt is DISCARDED — restore the global page
        // counter so the halves don't double-count its pages.
        pagesDone = start;
        const mid = Math.ceil(pages.length / 2);
        addSized(pages.slice(0, mid));
        addSized(pages.slice(mid));
        return;
      }
      built.push({ pages, bytes: partBytes });
      pagesDone = start + pages.length;
      postProgress();
    };
    for (const part of plan.parts) {
      addSized(part.pages);
    }
  } else {
    for (const part of plan.parts) {
      const partBytes = writePart(part.pages);
      built.push({ pages: part.pages, bytes: partBytes, label: part.label });
    }
    postProgress();
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });

  // Naming pass — every part is named AFTER ITS CONTENT so "which file has
  // pages 8-12" is readable at download time:
  //   range mode        → "<base>-pages-1-5.pdf" (each user range = one file,
  //                       matching how extract names one-per-file outputs)
  //   chunk modes       → "<base>-part-2-pages-5-8.pdf" (every N / bookmarks /
  //                       size / visual / blanks — part number keeps order)
  //   odd/even          → keeps its semantic "_odd"/"_even" suffix
  //   lone scattered    → keeps the legacy "<base>-split.pdf"
  // Duplicate ranges ("1-5, 1-5") get the SAME "-2" disambiguation the
  // shared ZIP bundler (zipOutputs) applies before the extension.
  const used = new Set<string>();
  const outputs = built.map((part, index) => {
    const span = pageSpan(part.pages);
    let name: string;
    if (
      mode === "oddEven" &&
      (part.label === "odd" || part.label === "even")
    ) {
      name = `${base}_${part.label}.pdf`;
    } else if (span !== null && (built.length === 1 || mode === "range")) {
      name = `${base}-pages-${span}.pdf`;
    } else if (span !== null) {
      name = `${base}-part-${index + 1}-pages-${span}.pdf`;
    } else if (built.length === 1) {
      name = `${base}-split.pdf`;
    } else {
      name = `${base}_part${index + 1}.pdf`;
    }
    let unique = name;
    let counter = 2;
    while (used.has(unique)) {
      const dot = unique.lastIndexOf(".");
      unique =
        dot > 0
          ? `${unique.slice(0, dot)}-${counter}${unique.slice(dot)}`
          : `${unique}-${counter}`;
      counter += 1;
    }
    used.add(unique);
    return {
      name: unique,
      mime: "application/pdf",
      blob: toBlob(part.bytes),
    };
  });

  const resultPages = built.reduce((sum, part) => sum + part.pages.length, 0);
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: resultPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
  });
};
