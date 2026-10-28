import {
  type OrganizeSource,
  type ParsedPdf,
  type PdfObj,
  StampContext,
  type StampForm,
  num,
  parseForOrganize,
  resolve,
} from "@/lib/own/pdf";

import {
  overlayPageFor,
  overlayPlacement,
  stampTargets,
  type OverlayOptions,
} from "./engine";

/**
 * Overlay PDF core pipeline (worker + smoke share this module so the test
 * exercises EXACTLY what ships) — 100% OUR OWN ENGINE (P6-j; was pdf-lib
 * embedPdf/drawPage):
 *
 *  1. `scaleOverlayAlpha` pre-scales every ExtGState (ca/CA) reachable from
 *     the OVERLAY page Resources by the chosen opacity. WHY: the draw-time
 *     ExtGState sets only the outer alpha — but any `gs` INSIDE the overlay
 *     REPLACES it (PDF graphics-state semantics), so alpha-bearing content
 *     would ignore the slider. Pre-scaling the inner states + the outer
 *     ca/CA gives true multiplicative globalAlpha semantics — the same math
 *     the preview canvas uses (`ctx.globalAlpha`). The walk mutates the
 *     parsed overlay graph BEFORE the write, so the embedded form's
 *     BFS-copied Resources carry the scaled values (mirrors how the pdf-lib
 *     worker mutated the overlay document before embedPdf copied it).
 *  2. Only the overlay pages actually needed are embedded (first / match /
 *     cycle resolved against the targets first) — as SOURCE-ANCHORED Form
 *     XObjects: BBox [0,0,mediaW,mediaH] (pdf-lib's default embed box, media
 *     origin discarded), identity Matrix, q/Q-wrapped decoded contents, the
 *     overlay's fonts/graphs BFS-copied exactly once per source object.
 *  3. `stampForm` draws each form with pdf-lib drawPage operator parity
 *     (translate/rotate/scale-RATIO cm triple) and a ca+CA ExtGState —
 *     pdf-lib injects `ca` only and the CA was patched onto it so stroke
 *     content dims identically.
 *
 * "Behind content" is native to the stamp kernel: our stream is PREPENDED
 * to the page's /Contents array.
 */

/** Resolve an object, accepting both dict and stream (pdf-lib's PDFStream
 *  extends PDFDict — XObjects/gs entries are often streams). */
function resolveDictish(doc: ParsedPdf, obj: PdfObj | undefined):
  Map<string, PdfObj> | undefined {
  const resolved = obj === undefined ? undefined : resolve(doc, obj);
  if (!resolved) return undefined;
  if (resolved.k === "dict" || resolved.k === "stream") return resolved.m;
  return undefined;
}

/** The recursive walk core, over an already-resolved Resources map. */
function scaleOverlayAlphaDict(
  doc: ParsedPdf,
  res: Map<string, PdfObj>,
  factor: number,
  depth: number
): number {
  if (depth > 8) return 0;
  let n = 0;
  const gsDict = resolveDictish(doc, res.get("ExtGState"));
  if (gsDict) {
    for (const [, value] of gsDict) {
      const gs = resolveDictish(doc, value);
      if (!gs) continue;
      for (const key of ["ca", "CA"] as const) {
        const cur = resolve(doc, gs.get(key));
        if (cur?.k === "num") {
          gs.set(key, num(Math.min(1, cur.n * factor)));
          n += 1;
        }
      }
    }
  }
  // Nested form XObjects carry their own Resources.
  const xoDict = resolveDictish(doc, res.get("XObject"));
  if (xoDict) {
    for (const [, value] of xoDict) {
      const xo = resolveDictish(doc, value);
      if (!xo) continue;
      const xoRes = resolveDictish(doc, xo.get("Resources"));
      if (xoRes) n += scaleOverlayAlphaDict(doc, xoRes, factor, depth + 1);
    }
  }
  return n;
}

/**
 * Multiplies ca/CA of every ExtGState reachable from a page's Resources.
 * Returns the number of scaled entries. Mirrors the pdf-lib walk: per
 * overlay PAGE (so an ExtGState object shared by two pages is scaled twice
 * — the multiplicative quirk of the shipped pipeline, kept for parity),
 * recursing into nested XObjects' Resources, depth-capped at 8.
 */
export function scaleOverlayAlpha(
  doc: ParsedPdf,
  source: OrganizeSource,
  pageIndex: number,
  factor: number
): number {
  const entry = source.pages[pageIndex]!.resources;
  const res = resolveDictish(doc, entry);
  if (!res) return 0;
  return scaleOverlayAlphaDict(doc, res, factor, 0);
}

export interface OverlayProgress {
  pct: number;
  page: number;
  pages: number;
}

export interface OverlayOutcome {
  /** The written output bytes (fresh classic-xref PDF, our engine). */
  bytes: Uint8Array;
  /** How many base pages actually received the overlay. */
  stamped: number;
}

/**
 * The full pipeline: pre-scale overlay alpha (when dimmed), embed the needed
 * overlay pages as form XObjects, stamp them onto the target base pages with
 * the shared placement math, honor behind-content, write. Returns the output
 * bytes + the stamped count.
 *
 * Throws plain `Error` with the engine's legacy markers ("invalid page
 * range" / "no pages selected" / "no page match") for the worker's error
 * mapping, and typed `PdfError` (encrypted/corrupt) for load failures.
 */
export function overlayPdfs(
  base: StampContext,
  overlay: OrganizeSource,
  opts: OverlayOptions,
  onProgress: (progress: OverlayProgress) => void
): OverlayOutcome {
  const baseCount = base.pageCount;
  const overlayCount = overlay.pages.length;
  const targets = stampTargets(opts, baseCount);
  if (targets === null) throw new Error("overlay: invalid page range");
  if (targets.length === 0) throw new Error("overlay: no pages selected");

  // Which overlay pages does this mapping actually need?
  const needed = new Set<number>();
  for (const pageIndex of targets) {
    const overlayIndex = overlayPageFor(opts.source, pageIndex, overlayCount);
    if (overlayIndex !== null) needed.add(overlayIndex);
  }
  if (needed.size === 0) throw new Error("overlay: no page match");

  // Pre-scale alpha-bearing overlay content (multiplicative semantics), on
  // EVERY overlay page — exactly where the pdf-lib pipeline walked.
  if (opts.opacity < 1) {
    for (let i = 0; i < overlayCount; i += 1) {
      scaleOverlayAlpha(overlay.doc, overlay, i, opts.opacity);
    }
  }

  // Embed the needed overlay pages (ascending — stable form numbering).
  const indices = [...needed].sort((a, b) => a - b);
  const forms = new Map<number, StampForm>();
  for (const index of indices) {
    forms.set(index, base.embedForm(overlay, index));
  }

  let done = 0;
  let stamped = 0;
  for (const pageIndex of targets) {
    const overlayIndex = overlayPageFor(opts.source, pageIndex, overlayCount);
    if (overlayIndex !== null) {
      const form = forms.get(overlayIndex);
      if (form) {
        const page = base.pages[pageIndex]!;
        // pdf-lib placement math runs on the MediaBox dims (getWidth/
        // getHeight semantics), and the embedded form's dims are the
        // MediaBox dims too — a full-page overlay covers the media box.
        const pageW = page.mediaBox[2] - page.mediaBox[0];
        const pageH = page.mediaBox[3] - page.mediaBox[1];
        const { boxW, boxH, sx, sy } = overlayPlacement(
          pageW,
          pageH,
          form.width,
          form.height,
          opts
        );
        base.stampForm(pageIndex, form, {
          x: sx,
          y: sy,
          width: boxW,
          height: boxH,
          opacity: opts.opacity < 1 ? opts.opacity : undefined,
          rotate: opts.rotation,
          behind: opts.behind,
        });
        stamped += 1;
      }
    }
    done += 1;
    onProgress({
      pct: Math.round(10 + (done / targets.length) * 84),
      page: done,
      pages: targets.length,
    });
  }

  return { bytes: base.write(), stamped };
}

/** Parse an overlay PDF for `overlayPdfs` (typed encrypted/corrupt throws). */
export function loadOverlaySource(bytes: Uint8Array): OrganizeSource {
  return parseForOrganize(bytes);
}
