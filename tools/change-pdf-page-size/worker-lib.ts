import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  parsePageSpec,
} from "@/lib/workers/protocol";
import {
  arr,
  cloneDict,
  materializeInheritable,
  name,
  newDict,
  newref,
  num,
  pageFormEmbed,
  pageHasContents,
  parseForOrganize,
  PdfError,
  pdfNumToString,
  writeDocument,
  type OrganizeSource,
  type PdfObj,
  type WritePage,
  type WriteSynthetic,
} from "@/lib/own/pdf";
import {
  type PageSizeOptions,
  type PageSizePageOutcome,
  buildPageSizeReport,
  pageDisplayDims,
  pageNeedsChange,
  resizePlacement,
  resolvePageSizeOptions,
  targetSizePt,
} from "./engine";

/**
 * Change PDF page size — the shared pipeline (worker + smoke import the
 * same function, so the test exercises exactly what ships; the overlay/cts
 * worker-lib precedent).
 *
 * Every SELECTED page lands on a fresh target-size page — A3/A4/A5/Letter/
 * Legal/custom mm, portrait / landscape / auto, content fit / fill /
 * unchanged — while pages that are already at the target are copied
 * byte-identically, so their links, form fields and comments survive
 * untouched. On-device, OWN ENGINE (P6-t), zero network.
 *
 * Pipeline (the n-up precedent, on the writer's native mixed plan): pages
 * needing a change are embedded as Form XObjects bounded by their CROP box
 * (pageFormEmbed — pdf-lib's embedPage does NOT apply /Rotate;
 * resizePlacement's corner-anchor math does), drawn centered with the
 * chosen scale mode through `q · translate · rotate · scale · /PgN Do · Q`
 * (the drawFormOps sequence smoke-nup pinned against pdf-lib's drawPage).
 * Unchanged runs are source-anchored copies (cloneDict + the full
 * materializeInheritable set — pdf-lib copyPages parity), so their
 * annotation graphs BFS-copy with /P back-refs remapped. Both page kinds
 * ride ONE writeDocument call: the writer numbers the embedded forms right
 * after the last page object (the WriteSynthetic contract), and the source
 * graphs of copied pages AND form /Resources share the copy map — a font
 * used by both is written once.
 *
 * Honest behavior kept from the pdf-lib era: resized pages drop their
 * annotations (embedPage parity — the report notes nothing, the smoke
 * asserts it), and a run where nothing would change hands the ORIGINAL
 * bytes back untouched.
 */

/** Typed run error — the worker message handler maps it to an i18n key 1:1. */
export class PageSizeRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "PageSizeRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface PageSizeProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface PageSizeRunResult {
  bytes: Uint8Array;
  report: string;
  pages: number;
  resized: number;
}

/** One embedded page form's handle (the ComposedForm shape + output num). */
interface EmbedForm {
  /** Resource name for `/… Do` on the authored target page. */
  key: string;
  /** The form's UNROTATED dims (the crop box). */
  width: number;
  height: number;
  /** The writer slot reserved for this form (3+pages objects + order). */
  num: number;
}

/**
 * pdf-lib drawPage operator parity (the smoke-nup-pinned drawFormOps):
 * q, translate, rotate, scale, /Form Do, Q. Scale operands are RATIOS
 * (target/form dims — pdf-lib's xScale = width / embeddedPage.width), not
 * absolute sizes: a Form XObject lives in the source page's point space.
 */
function drawFormOps(
  form: { key: string; width: number; height: number },
  place: { x: number; y: number; width: number; height: number; rotate: number }
): string {
  const angle = (place.rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sx = form.width > 0 ? place.width / form.width : 0;
  const sy = form.height > 0 ? place.height / form.height : 0;
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(place.x)} ${pdfNumToString(place.y)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `${pdfNumToString(sx)} 0 0 ${pdfNumToString(sy)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

/** The Form XObject stream for one embedded page (ComposeContext parity). */
function formXObject(embed: ReturnType<typeof pageFormEmbed>): PdfObj {
  const [x0, y0, x1, y1] = embed.bbox;
  const dict = newDict([
    ["Type", name("XObject")],
    ["Subtype", name("Form")],
    ["FormType", num(1)],
    ["BBox", arr(num(x0), num(y0), num(x1), num(y1))],
    // boundingBoxAdjustedMatrix: position the box origin at (0,0).
    ["Matrix", arr(...embed.matrix.map(num))],
    ["Resources", embed.resources ?? { k: "dict", m: new Map() }],
    ["Filter", name("FlateDecode")],
  ]);
  return { k: "stream", m: dict.m, raw: embed.content };
}

const ENC = new TextEncoder();

/**
 * The whole page-size pipeline, smoke-testable without a Worker (the n-up
 * runNup precedent). `onProgress` receives real per-page progress; errors
 * throw PageSizeRunError with the i18n key the UI should show.
 */
export async function runPageSize(
  bytes: Uint8Array,
  fileName: string,
  options: OptionValues,
  onProgress?: (progress: PageSizeProgress) => void
): Promise<PageSizeRunResult> {
  const opts: PageSizeOptions = resolvePageSizeOptions(options);

  let source: OrganizeSource;
  let pageCount: number;
  try {
    source = parseForOrganize(bytes);
    pageCount = source.pages.length;
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new PageSizeRunError("tool.errorEncrypted");
    }
    throw new PageSizeRunError("tool.errorCorrupt");
  }
  // A "loaded" doc with no pages is just as unusable — corrupt.
  if (pageCount < 1) {
    throw new PageSizeRunError("tool.errorCorrupt");
  }
  const selected = new Set(parsePageSpec(opts.pages, pageCount) ?? []);
  if (selected.size === 0) {
    throw new PageSizeRunError("tool.errorInvalidPages", opts.pages);
  }

  /* ---------------- Plan: per-page display, target, verdict ---------- */

  const outcomes: PageSizePageOutcome[] = [];
  const resize: { index: number }[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const page = source.pages[i]!;
    const [vx0, vy0, vx1, vy1] = page.cropBox;
    const view = { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 };
    const rotation = page.rotate;
    const display = pageDisplayDims(view, rotation);
    const isSelected = selected.has(i);
    const target = targetSizePt(opts, display);
    const needs = isSelected && pageNeedsChange(display, target);
    const scale = needs
      ? resizePlacement(target, view.width, view.height, rotation, opts.scale)
          .scale
      : 1;
    outcomes.push({
      page: i + 1,
      fromW: display.w,
      fromH: display.h,
      toW: needs ? target.w : display.w,
      toH: needs ? target.h : display.h,
      method: needs ? "resized" : isSelected ? "kept-size" : "kept-unselected",
      scale,
    });
    if (needs) resize.push({ index: i });
  }

  const resizedCount = resize.length;
  const report = buildPageSizeReport(opts, outcomes, fileName);

  // Fast path: nothing would change — hand the original bytes back untouched.
  if (resizedCount === 0) {
    onProgress?.({ pct: 96, stage: "saving" });
    return { bytes, report, pages: pageCount, resized: 0 };
  }

  /* ---------------- Embed the resized pages once ---------------------- */

  // Writer numbering contract: 1 catalog, 2 pages tree, then each plan page
  // (copy = one object, authored = dict + content stream), THEN synthetics.
  let formBase = 3;
  for (const outcome of outcomes) {
    formBase += outcome.method === "resized" ? 2 : 1;
  }

  const embeds = new Map<number, EmbedForm | null>();
  const synthetics: WriteSynthetic[] = [];
  let embedOrder = 0;
  for (const { index } of resize) {
    const page = source.pages[index]!;
    const [x0, y0, x1, y1] = page.cropBox;
    let embed: EmbedForm | null = null;
    if (pageHasContents(source.doc, page)) {
      const form = pageFormEmbed(source.doc, page, {
        left: x0,
        bottom: y0,
        right: x1,
        top: y1,
      });
      embed = {
        key: `Pg${embedOrder + 1}`,
        width: x1 - x0,
        height: y1 - y0,
        num: formBase + embedOrder,
      };
      synthetics.push({ sourceDoc: source.doc, obj: formXObject(form) });
      embedOrder += 1;
    }
    embeds.set(index, embed);
  }

  /* ---------------- Build the mixed write plan ------------------------ */

  const pages: WritePage[] = [];
  const progressSpan = 84 / pageCount;
  let done = 0;

  const noteProgress = (): void => {
    done += 1;
    onProgress?.({
      pct: Math.round(10 + progressSpan * done),
      stage: "processing",
      detail: { page: done, pages: pageCount },
    });
  };

  for (let i = 0; i < pageCount; i += 1) {
    if (outcomes[i]!.method === "resized") {
      const page = source.pages[i]!;
      const [vx0, vy0, vx1, vy1] = page.cropBox;
      const view = { width: vx1 - vx0, height: vy1 - vy0 };
      const rotation = page.rotate;
      const display = pageDisplayDims(view, rotation);
      const target = targetSizePt(opts, display);
      const embed = embeds.get(i) ?? null;
      let content = "";
      let resources: PdfObj | undefined;
      if (embed) {
        const place = resizePlacement(
          target,
          embed.width,
          embed.height,
          rotation,
          opts.scale
        );
        content = drawFormOps(embed, place);
        resources = newDict([
          [
            "XObject",
            {
              k: "dict",
              m: new Map([[embed.key, newref(embed.num)]]),
            },
          ],
        ]);
      }
      pages.push({
        type: "new",
        width: target.w,
        height: target.h,
        content: ENC.encode(content),
        resources,
      });
    } else {
      // Source-anchored copy (pdf-lib copyPages parity): the cloned dict
      // loses /Parent, inheritable entries materialize onto the leaf, and
      // the writer BFS-copies the reachable graphs byte-exactly — links,
      // form widgets and comments survive.
      const page = source.pages[i]!;
      const dict = cloneDict(page.dict, { drop: ["Parent"] });
      materializeInheritable(dict, page);
      pages.push({ type: "copy", doc: source.doc, srcNum: page.ref.num, dict });
    }
    noteProgress();
  }

  onProgress?.({ pct: 96, stage: "saving" });
  const saved = writeDocument(pages, source.doc.version, undefined, synthetics);
  return {
    bytes: saved,
    report,
    pages: pageCount,
    resized: resizedCount,
  };
}
