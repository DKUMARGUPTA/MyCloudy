import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  degrees,
  type PDFEmbeddedPage,
  type PDFPage,
} from "pdf-lib";

import {
  overlayPageFor,
  overlayPlacement,
  stampTargets,
  type OverlayOptions,
} from "./engine";

/**
 * Overlay PDF core pipeline (worker + smoke share this module so the test
 * exercises EXACTLY what ships):
 *
 *  1. `scaleOverlayAlpha` pre-scales every ExtGState (ca/CA) reachable from
 *     the overlay page Resources by the chosen opacity. WHY: pdf-lib's
 *     `drawPage(opacity)` sets only the outer `ca` — but any `gs` INSIDE the
 *     overlay REPLACES it (PDF graphics-state semantics), so alpha-bearing
 *     content would ignore the slider. Pre-scaling the inner states + the
 *     outer ca gives true multiplicative globalAlpha semantics — the same
 *     math the preview canvas uses (`ctx.globalAlpha`).
 *  2. `addStrokeAlpha` patches the ExtGState pdf-lib injects for the outer
 *     opacity (ca only) with CA as well — strokes must dim too.
 *  3. Only the overlay pages actually needed are embedded (first / match /
 *     cycle resolved against the targets first).
 *
 * "Behind content" reorders the page's /Contents array so the overlay stream
 * (pdf-lib appends it LAST) runs FIRST — the watermark-round technique.
 */

/** Multiplies ca/CA of every ExtGState reachable from a Resources dict. Returns the number of scaled entries. */
export function scaleOverlayAlpha(
  ctx: PDFContext,
  res: PDFDict | undefined,
  factor: number,
  depth = 0
): number {
  if (!res || depth > 8) return 0;
  let n = 0;
  const gsDict = res.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  if (gsDict) {
    for (const [, value] of gsDict.entries()) {
      const gs = ctx.lookupMaybe(value, PDFDict);
      if (!gs) continue;
      for (const key of [PDFName.of("ca"), PDFName.of("CA")]) {
        const cur = gs.lookupMaybe(key, PDFNumber);
        if (cur) {
          gs.set(key, ctx.obj(Math.min(1, cur.asNumber() * factor)));
          n += 1;
        }
      }
    }
  }
  // Nested form XObjects carry their own Resources.
  const xoDict = res.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (xoDict) {
    for (const [, value] of xoDict.entries()) {
      const xo = ctx.lookupMaybe(value, PDFDict);
      n += scaleOverlayAlpha(
        ctx,
        xo?.lookupMaybe(PDFName.of("Resources"), PDFDict),
        factor,
        depth + 1
      );
    }
  }
  return n;
}

/** Snapshot of a page's ExtGState resource keys (to diff after drawPage). */
function extGStateKeys(page: PDFPage): Set<string> {
  const keys = new Set<string>();
  const gsDict = page.node
    .Resources()
    ?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  if (gsDict) {
    for (const [key] of gsDict.entries()) keys.add(String(key));
  }
  return keys;
}

/**
 * pdf-lib's drawPage(opacity) injects an ExtGState with `ca` only — strokes
 * (borders, lines) would stay at full strength. This adds `CA` to the newly
 * injected state so stroke content dims identically.
 */
function addStrokeAlpha(
  ctx: PDFContext,
  page: PDFPage,
  opacity: number,
  before: ReadonlySet<string>
): void {
  const gsDict = page.node
    .Resources()
    ?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  if (!gsDict) return;
  for (const [key, value] of gsDict.entries()) {
    if (before.has(String(key))) continue;
    const gs = ctx.lookupMaybe(value, PDFDict);
    if (
      gs &&
      gs.lookupMaybe(PDFName.of("ca"), PDFNumber) !== undefined &&
      gs.get(PDFName.of("CA")) === undefined
    ) {
      gs.set(PDFName.of("CA"), ctx.obj(opacity));
    }
  }
}

/** Moves this page's pdf-lib draw stream (appended last) to the front — behind content. */
function moveDrawStreamFirst(page: PDFPage): void {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const size = contents.size();
  if (size < 2) return;
  const mine = contents.get(size - 1);
  contents.remove(size - 1);
  contents.insert(0, mine);
}

export interface OverlayProgress {
  pct: number;
  page: number;
  pages: number;
}

/**
 * The full pipeline: mutate overlay alpha (when dimmed), embed the needed
 * overlay pages, draw them onto the target base pages with the shared
 * placement math, honor behind-content, save. Returns the stamped count.
 */
export async function overlayPdfs(
  baseDoc: PDFDocument,
  overlayDoc: PDFDocument,
  opts: OverlayOptions,
  onProgress: (progress: OverlayProgress) => void
): Promise<number> {
  const baseCount = baseDoc.getPageCount();
  const overlayCount = overlayDoc.getPageCount();
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

  // Pre-scale alpha-bearing overlay content (multiplicative semantics).
  if (opts.opacity < 1) {
    for (const page of overlayDoc.getPages()) {
      scaleOverlayAlpha(overlayDoc.context, page.node.Resources(), opts.opacity);
    }
  }

  const indices = [...needed].sort((a, b) => a - b);
  const embedded = await baseDoc.embedPdf(overlayDoc, indices);
  const embByIndex = new Map<number, PDFEmbeddedPage>(
    indices.map((index, position) => [index, embedded[position]])
  );

  let done = 0;
  let stamped = 0;
  for (const pageIndex of targets) {
    const overlayIndex = overlayPageFor(opts.source, pageIndex, overlayCount);
    if (overlayIndex !== null) {
      const emb = embByIndex.get(overlayIndex);
      if (emb) {
        const page = baseDoc.getPage(pageIndex);
        const { boxW, boxH, sx, sy } = overlayPlacement(
          page.getWidth(),
          page.getHeight(),
          emb.width,
          emb.height,
          opts
        );
        const gsBefore = opts.opacity < 1 ? extGStateKeys(page) : null;
        page.drawPage(emb, {
          x: sx,
          y: sy,
          width: boxW,
          height: boxH,
          rotate: degrees(opts.rotation),
          opacity: opts.opacity,
        });
        if (gsBefore !== null) {
          addStrokeAlpha(baseDoc.context, page, opts.opacity, gsBefore);
        }
        if (opts.behind) moveDrawStreamFirst(page);
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

  return stamped;
}
