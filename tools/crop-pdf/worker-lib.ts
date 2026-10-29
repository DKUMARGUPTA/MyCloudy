import {
  arr,
  listPages,
  num,
  parsePdf,
  rewriteDocument,
  PdfError,
  type ParsedPdf,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  cropBoxForPage,
  cropTargets,
  resolveCropOptions,
  sameBox,
} from "./crop-options";

/**
 * Crop PDF — the shared pipeline (worker + smoke import the same function,
 * so the test exercises exactly what ships; the page-size worker-lib
 * precedent, P6-t).
 *
 * Sets the /CropBox of the chosen pages on the PARSED graph and re-serializes
 * through the P6-r preserve-numbers rewriter — an IN-PLACE seam: catalog,
 * outlines, /AcroForm, metadata, annotations and untouched page dicts ride
 * through byte-for-byte; only the page dicts whose box actually changed
 * differ from the source. Inherited CropBoxes keep resolving (a leaf entry
 * wins, per spec); ObjStm-resident page objects re-emerge as individual
 * objects with the edit applied.
 *
 * The display-margins → user-space mapping (including /Rotate 90 / 180 /
 * 270 pages) comes from crop-options — the same pure module the live
 * preview uses, so what you dragged is what you get.
 */

/** Typed run error — the worker message handler maps it to an i18n key 1:1. */
export class CropRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "CropRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface CropProgress {
  pct: number;
  stage: "reading" | "processing" | "saving";
  detail?: { page?: number; pages?: number };
}

export interface CropRunResult {
  bytes: Uint8Array;
  /** Number of pages whose /CropBox actually changed. */
  changed: number;
  /** Number of pages the run targeted. */
  targets: number;
}

/**
 * The whole crop pipeline, smoke-testable without a Worker. `onProgress`
 * receives real per-page progress; errors throw CropRunError with the i18n
 * key the UI should show.
 */
export async function runCrop(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: CropProgress) => void
): Promise<CropRunResult> {
  const crop = resolveCropOptions(options);

  onProgress?.({ pct: 4, stage: "reading" });
  let doc: ParsedPdf;
  try {
    doc = parsePdf(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new CropRunError("tool.errorEncrypted");
    }
    throw new CropRunError("tool.errorCorrupt");
  }
  const pages = listPages(doc);
  const pageCount = pages.length;
  const targets = cropTargets(crop, pageCount);
  if (targets === null || targets.length === 0) {
    throw new CropRunError("crop.errorNoPages");
  }

  onProgress?.({ pct: 10, stage: "processing" });
  const total = targets.length;
  let done = 0;
  let changed = 0;
  for (const pageIndex of targets) {
    const page = pages[pageIndex];
    if (page) {
      // The page's current visible view (CropBox, falling back to MediaBox)
      // and its /Rotate value define the display space the user dragged in.
      const [x0, y0, x1, y1] = page.cropBox;
      const view = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const box = cropBoxForPage(crop, view, page.rotate);
      if (!sameBox(box, view)) {
        // Mutate the parsed page dict in place — the rewriter re-emits the
        // object with the new /CropBox. /BleedBox /TrimBox /ArtBox are left
        // exactly as the file had them (pdf-lib setCropBox parity).
        page.dict.set(
          "CropBox",
          arr(
            num(box.x),
            num(box.y),
            num(box.x + box.width),
            num(box.y + box.height)
          )
        );
        changed += 1;
      }
    }

    done += 1;
    onProgress?.({
      pct: Math.round(10 + (done / total) * 84),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  onProgress?.({ pct: 96, stage: "saving" });
  const saved = rewriteDocument(doc, { objectStreams: true });
  return { bytes: saved, changed, targets: total };
}
