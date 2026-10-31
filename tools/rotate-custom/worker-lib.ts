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

/**
 * Rotate by custom angle — the shared pipeline (worker + smoke import the
 * same function, the change-pdf-page-size worker-lib precedent).
 *
 * Every SELECTED page is re-drawn on a fresh sheet: the page is embedded
 * as a crop-box Form XObject (pageFormEmbed — pdf-lib embedPage parity)
 * and drawn through `q · translate · rotate · /PgN Do · Q` with scale 1.
 * The sheet is the EXACT axis-aligned bounding box of the rotated crop
 * rect (computed from the four rotated corners), so no content is ever
 * cropped and nothing sticks out. The rotation angle composes with the
 * page's own /Rotate (a page already turned 90° plus a 5° nudge renders
 * at 95°) — the same corner math change-pdf-page-size uses.
 *
 * Unselected pages are source-anchored copies (cloneDict + the full
 * materializeInheritable set — pdf-lib copyPages parity): their links,
 * form fields and comments survive byte-identically. Both page kinds ride
 * ONE writeDocument call; the writer numbers the embedded forms right
 * after the last page object (the WriteSynthetic contract).
 */

/** Typed run error — the worker message handler maps it to an i18n key 1:1. */
export class RotateRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "RotateRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface RotateProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface RotateRunResult {
  bytes: Uint8Array;
  pages: number;
  rotated: number;
}

/** Wrap any angle into (−180, 180] — 270° becomes −90°, −190° becomes 170°. */
export function normalizeAngle(deg: number): number {
  let a = ((deg % 360) + 360) % 360; // [0, 360)
  if (a > 180) a -= 360; // (−180, 180]
  return a;
}

/** Resolve the angle option (defensive: strings, NaN, out-of-range). */
export function resolveAngle(value: unknown): number | null {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return null;
  return normalizeAngle(Math.min(Math.max(raw, -180), 180));
}

/**
 * The axis-aligned bounding box of a w×h rect rotated by φ degrees about
 * its origin, plus the (x, y) translation that keeps every corner ≥ 0.
 * Pure math — the smoke pins exact values for 45°/90°/95°.
 */
export function rotatedBounds(
  w: number,
  h: number,
  phiDeg: number
): { width: number; height: number; x: number; y: number } {
  const rad = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Corners (0,0), (w,0), (0,h), (w,h) through the rotation matrix.
  const xs = [0, w * cos, -h * sin, w * cos - h * sin];
  const ys = [0, w * sin, h * cos, w * sin + h * cos];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    width: maxX - minX,
    height: maxY - minY,
    x: -minX,
    y: -minY,
  };
}

/** The pinned draw sequence (change-pdf-page-size drawFormOps, scale 1). */
function drawRotatedFormOps(
  key: string,
  place: { x: number; y: number; rotate: number }
): string {
  const angle = (place.rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(place.x)} ${pdfNumToString(place.y)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `/${key} Do`,
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

/** PDF's user-space page limit (14,400 pt ≈ 200 in) — same cap as sheets. */
const MAX_PAGE_PT = 14_400;

export interface RotateOptions {
  angle: number;
  pages: string;
}

export function resolveRotateOptions(options: OptionValues): RotateOptions {
  const pages = typeof options.pages === "string" ? options.pages : "all";
  return {
    angle: resolveAngle(options.angle) ?? 0,
    pages,
  };
}

export async function runRotateCustom(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: RotateProgress) => void
): Promise<RotateRunResult> {
  const opts = resolveRotateOptions(options);

  // A zero angle is a no-op — refuse honestly instead of re-saving.
  if (Math.abs(opts.angle) < 0.05) {
    throw new RotateRunError("tool.errorNothingToDo");
  }

  let source: OrganizeSource;
  let pageCount: number;
  try {
    source = parseForOrganize(bytes);
    pageCount = source.pages.length;
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new RotateRunError("tool.errorEncrypted");
    }
    throw new RotateRunError("tool.errorCorrupt");
  }
  if (pageCount < 1) {
    throw new RotateRunError("tool.errorCorrupt");
  }
  const selected = new Set(parsePageSpec(opts.pages, pageCount) ?? []);
  if (selected.size === 0) {
    throw new RotateRunError("tool.errorInvalidPages", opts.pages);
  }

  /* ---------------- Plan + geometry up-front -------------------------- */

  interface Plan {
    rotate: boolean;
    /** The composed drawing angle for rotated pages (own /Rotate + angle). */
    phi: number;
    /** The exact bounding-box sheet size (rotated pages only). */
    width: number;
    height: number;
    /** The translate that keeps every rotated corner inside the sheet. */
    x: number;
    y: number;
  }
  const plans: Plan[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const page = source.pages[i]!;
    if (!selected.has(i)) {
      plans.push({ rotate: false, phi: 0, width: 0, height: 0, x: 0, y: 0 });
      continue;
    }
    const [x0, y0, x1, y1] = page.cropBox;
    const phi = page.rotate + opts.angle;
    const bounds = rotatedBounds(x1 - x0, y1 - y0, phi);
    if (
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
      bounds.width <= 0 || bounds.height <= 0 ||
      bounds.width > MAX_PAGE_PT || bounds.height > MAX_PAGE_PT
    ) {
      throw new RotateRunError("tool.errorPageTooLarge");
    }
    plans.push({
      rotate: true,
      phi,
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
    });
  }
  const rotatedCount = plans.filter((p) => p.rotate).length;

  /* ---------------- Embed the rotated pages once ---------------------- */

  // Writer numbering contract: 1 catalog, 2 pages tree, then each plan page
  // (copy = one object, authored = dict + content stream), THEN synthetics.
  let formBase = 3;
  for (const plan of plans) {
    formBase += plan.rotate ? 2 : 1;
  }

  interface EmbedForm {
    key: string;
    num: number;
  }
  const embeds = new Map<number, EmbedForm | null>();
  const synthetics: WriteSynthetic[] = [];
  let embedOrder = 0;
  for (let i = 0; i < pageCount; i += 1) {
    if (!plans[i]!.rotate) continue;
    const page = source.pages[i]!;
    let embed: EmbedForm | null = null;
    if (pageHasContents(source.doc, page)) {
      const [x0, y0, x1, y1] = page.cropBox;
      const form = pageFormEmbed(source.doc, page, {
        left: x0,
        bottom: y0,
        right: x1,
        top: y1,
      });
      embed = { key: `Pg${embedOrder + 1}`, num: formBase + embedOrder };
      synthetics.push({ sourceDoc: source.doc, obj: formXObject(form) });
      embedOrder += 1;
    }
    embeds.set(i, embed);
  }

  /* ---------------- Build the mixed write plan ------------------------ */

  const pages: WritePage[] = [];
  const progressSpan = 84 / pageCount;
  let done = 0;

  for (let i = 0; i < pageCount; i += 1) {
    const plan = plans[i]!;
    if (plan.rotate) {
      const embed = embeds.get(i) ?? null;
      let content = "";
      let resources: PdfObj | undefined;
      if (embed) {
        content = drawRotatedFormOps(embed.key, {
          x: plan.x,
          y: plan.y,
          rotate: plan.phi,
        });
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
        width: plan.width,
        height: plan.height,
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
    done += 1;
    onProgress?.({
      pct: Math.round(10 + progressSpan * done),
      stage: "processing",
      detail: { page: done, pages: pageCount },
    });
  }

  onProgress?.({ pct: 96, stage: "saving" });
  const saved = writeDocument(pages, source.doc.version, undefined, synthetics);
  return { bytes: saved, pages: pageCount, rotated: rotatedCount };
}
