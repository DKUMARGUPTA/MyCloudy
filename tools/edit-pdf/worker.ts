import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  PdfError,
  StampContext,
  arr as pdfArr,
  num as pdfNum,
  stdFontAscent,
  type StampFontKey,
  type StampImage,
  type StampRgb,
  type StampSlot,
  type StampTtfFont,
} from "@/lib/own/pdf";
import { loadDevanagariBytes } from "../stamp-common/deva";
import {
  applySlotSets,
  planSrc,
  MAX_WORKSPACE_PAGES,
} from "./page-plan";
import {
  FIELD_CHECKED,
  LINE_HEIGHT,
  TEXT_PAD,
  displayToPdfPoint,
  effectiveView,
  hexToRgb,
  isIdentityOrder,
  lineEndpoints,
  pdfRectToDisplay,
  rotateDisplayPoint,
  rotationAnchor,
  sanitizeCrop,
  sanitizeObjects,
  validCropShape,
  wrapText,
  type DrawObj,
  type EditorObject,
  type ImageObj,
  type ObjRect,
  type PageView,
  type ShapeObj,
  type TextObj,
} from "./model";

/**
 * Edit PDF — export worker (PRD §8.2.1 sub-phase 8.5 "Export").
 *
 * The surface owns every interaction; this worker bakes the final PDF on
 * the OWN engine (P6-o): original document (StampContext) + the objects
 * blob ("e:<fileId>" — the redact epoch-key pattern) + image assets riding
 * the run message (config.collectAssets ↔ assetOrder pairing).
 *
 * Object coords are PDF user-space points (y from the bottom) — the same
 * space the engine draws in, so unrotated pages map 1:1. Rotated pages
 * (/Rotate 90/180/270) get rotation-compensated TEXT (stampText rotate =
 * the /Rotate degrees) so words read upright the way the user typed them;
 * everything else (rects, ellipses, lines, freehand) is placed through
 * display-space endpoints mapped point-by-point, which is correct for
 * every rotation because the mapping is an isometry.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

interface WireBlob {
  objects: unknown;
  pageViews: PageView[];
  assetOrder: string[];
  /** R12: >500-page source — an identity-prefix plan means the workspace
   * is capped, not that tail pages were deleted. */
  truncated?: boolean;
}

function parseBlob(raw: unknown): WireBlob | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WireBlob>;
    const views = Array.isArray(parsed.pageViews) ? parsed.pageViews : [];
    const order = Array.isArray(parsed.assetOrder)
      ? parsed.assetOrder.filter((k): k is string => typeof k === "string")
      : [];
    return {
      objects: parsed.objects,
      pageViews: views,
      truncated: parsed.truncated === true,
      assetOrder: order,
    };
  } catch {
    return null;
  }
}

function parseViews(raw: unknown): PageView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is PageView => typeof v === "object" && v !== null)
    .map((v) => ({
      x0: typeof v.x0 === "number" ? v.x0 : 0,
      y0: typeof v.y0 === "number" ? v.y0 : 0,
      x1: typeof v.x1 === "number" ? v.x1 : 612,
      y1: typeof v.y1 === "number" ? v.y1 : 792,
      rotate: v.rotate === 90 || v.rotate === 180 || v.rotate === 270 ? v.rotate : 0,
      // R12: src stays undefined for absent/garbage values — the run()
      // side decides defaults AFTER it knows the source page count
      // (stale pre-R12 blobs vs explicit duplicate plans differ there).
      src:
        typeof v.src === "number" && Number.isFinite(v.src) && v.src >= 0
          ? Math.trunc(v.src)
          : undefined,
      // R15: the crop rides the wire only when it is a well-shaped rect
      // (finite, positive). The box clamp + minimum size run in run()
      // where the view box is known; absent/garbage → undefined = identity
      // (the R13 rotate rule, applied to crop).
      ...(validCropShape(v.crop) ? { crop: v.crop } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Font resolution (standard 14 + italic variants + self-hosted Devanagari)
// ---------------------------------------------------------------------------

const DEVA_RE = /[\u0900-\u097F]/;

const ITALIC_MAP: Record<string, StampFontKey> = {
  helvetica: "helveticaOblique",
  "helvetica-b": "helveticaBoldOblique",
  times: "timesItalic",
  "times-b": "timesBoldItalic",
  courier: "courierOblique",
  "courier-b": "courierBoldOblique",
};

function baseStampFont(o: TextObj): StampFontKey | "devanagari" {
  if (o.font === "devanagari" || DEVA_RE.test(o.text)) return "devanagari";
  return o.bold ? (`${o.font}Bold` as StampFontKey) : (o.font as StampFontKey);
}

/** A resolved text font: a standard-14 key or the embedded Devanagari. */
type FontRef =
  | { key: StampFontKey; ttf?: undefined }
  | { key?: undefined; ttf: StampTtfFont };

interface FontBag {
  base: (id: StampFontKey | "devanagari") => FontRef | null;
  italic: (id: string) => FontRef | null;
}

// ---------------------------------------------------------------------------
// Point mapping (display fractions → user space, rotation-correct)
// ---------------------------------------------------------------------------

/**
 * Bilinear corner interpolation: maps a point at fractions (fx, fy) of the
 * object's DISPLAY rect into user space. Correct for every /Rotate because
 * each display bbox corner maps through displayToPdfPoint individually.
 */
function objPointToPdf(
  obj: ObjRect,
  view: PageView,
  fx: number,
  fy: number
): { x: number; y: number } {
  const disp = pdfRectToDisplay(obj, view);
  const a = displayToPdfPoint(disp.x, disp.y, view);
  const b = displayToPdfPoint(disp.x + disp.w, disp.y, view);
  const c = displayToPdfPoint(disp.x, disp.y + disp.h, view);
  return {
    x: a.x + fx * (b.x - a.x) + fy * (c.x - a.x),
    y: a.y + fx * (b.y - a.y) + fy * (c.y - a.y),
  };
}

/**
 * P8.6 rotation: rotates a DISPLAY point around the object's display
 * center when the object carries a visual rotation (identity otherwise).
 * Text anchors, underline endpoints and line/arrow endpoints all go
 * through this so the whole object turns around its CENTER.
 */
function rotDisp(
  obj: EditorObject,
  view: PageView,
  p: { x: number; y: number }
): { x: number; y: number } {
  if (obj.rotation % 360 === 0) return p;
  const disp = pdfRectToDisplay(obj, view);
  return rotateDisplayPoint(
    p,
    { x: disp.x + disp.w / 2, y: disp.y + disp.h / 2 },
    obj.rotation
  );
}

/**
 * P8.6 rotation: the (x, y, width, height) stamp call for a rect-like
 * object. At rotation 0 this is the object itself (byte-identical legacy
 * path — no rotate option is passed at all); at rotation ≠ 0 the anchor is
 * compensated so the engine's rotate-around-(x,y) turns the rect around its
 * CENTER (model.rotationAnchor math — pdf-lib drawRectangle parity).
 */
function rotatedRectDraw(o: ObjRect, rotation: number): {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
} {
  if (rotation % 360 === 0) {
    return { x: o.x, y: o.y, width: o.w, height: o.h };
  }
  const anchor = rotationAnchor(o, rotation);
  return {
    x: anchor.x,
    y: anchor.y,
    width: o.w,
    height: o.h,
    rotate: rotation,
  };
}

function rgbOf(hex: string): StampRgb {
  return hexToRgb(hex);
}

/** Clamps an object rect into the crop box; null when fully outside. */
function clampToPage(obj: ObjRect, view: PageView): ObjRect | null {
  const x0 = Math.max(obj.x, view.x0);
  const y0 = Math.max(obj.y, view.y0);
  const x1 = Math.min(obj.x + obj.w, view.x1);
  const y1 = Math.min(obj.y + obj.h, view.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Per-kind drawing
// ---------------------------------------------------------------------------

interface DrawCtx {
  slot: number;
  view: PageView;
  fonts: FontBag;
  /** pdf-lib-free width/height through the resolved font descriptor. */
  widthOf: (text: string, size: number, ref: FontRef) => number;
  ascentOf: (size: number, ref: FontRef) => number;
  ctx: StampContext;
  imageFor: (key: string) => StampImage | null;
}

function drawTextObject(o: TextObj, dc: DrawCtx): void {
  if (o.text.trim().length === 0) return;
  const ref = resolveFont(o, dc);
  if (!ref) return;
  const size = o.size;
  const view = dc.view;
  const disp = pdfRectToDisplay(o, view);
  const pad = TEXT_PAD;
  const availW = Math.max(4, disp.w - 2 * pad);
  const lines = wrapText(o.text, availW, (s) => dc.widthOf(s, size, ref));
  const ascent = dc.ascentOf(size, ref);
  const lh = LINE_HEIGHT * size;
  // P8.6: object rotation adds on top of the /Rotate compensation (the
  // page rotation keeps words upright; the object rotation turns them).
  const rotate = (view.rotate || 0) + (o.rotation || 0);

  if (o.bg !== null) {
    if (o.rotation % 360 === 0) {
      const rect = clampToPage(o, view);
      if (rect) {
        dc.ctx.stampRect(dc.slot, {
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
          color: rgbOf(o.bg),
          opacity: o.opacity,
        });
      }
    } else {
      // Rotated bg: rotate around the object's user-space center. The
      // visual may extend past the crop box — viewers clip at the MediaBox.
      dc.ctx.stampRect(dc.slot, {
        ...rotatedRectDraw(o, o.rotation),
        color: rgbOf(o.bg),
        opacity: o.opacity,
      });
    }
  }

  const color = rgbOf(o.color);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineW = dc.widthOf(line, size, ref);
    const startX =
      o.align === "center"
        ? disp.x + pad + Math.max(0, (availW - lineW) / 2)
        : o.align === "right"
          ? disp.x + disp.w - pad - lineW
          : disp.x + pad;
    const baselineY = disp.y + pad + ascent + i * lh;
    // P8.6: rotate the display-space anchor around the object's display
    // center so the text turns around its center, not its corner.
    const rotatedAnchor = rotDisp(o, view, { x: startX, y: baselineY });
    const anchor = displayToPdfPoint(rotatedAnchor.x, rotatedAnchor.y, view);
    dc.ctx.stampText(dc.slot, {
      x: anchor.x,
      y: anchor.y,
      text: line,
      size,
      ...(ref.ttf ? { ttf: ref.ttf } : { font: ref.key }),
      color,
      opacity: o.opacity,
      rotate,
    });
    if (o.underline && line.length > 0) {
      const uy = baselineY + Math.max(1.2, size * 0.1);
      const u1 = rotDisp(o, view, { x: startX, y: uy });
      const u2 = rotDisp(o, view, { x: startX + lineW, y: uy });
      const p1 = displayToPdfPoint(u1.x, u1.y, view);
      const p2 = displayToPdfPoint(u2.x, u2.y, view);
      dc.ctx.stampLine(dc.slot, {
        start: p1,
        end: p2,
        thickness: Math.max(0.4, size * 0.045),
        color,
        opacity: o.opacity,
      });
    }
  }
}

function resolveFont(o: TextObj, dc: DrawCtx): FontRef | null {
  const base = baseStampFont(o);
  if (base === "devanagari") return dc.fonts.base("devanagari");
  if (o.italic) {
    const key = o.bold ? `${o.font}-b` : o.font;
    const italic = dc.fonts.italic(key);
    if (italic) return italic;
  }
  return dc.fonts.base(base);
}

function drawImageObject(o: ImageObj, dc: DrawCtx): void {
  const image = dc.imageFor(o.assetKey);
  if (!image) return;
  // The engine scales by explicit width/height only (P4.4 pin).
  // P8.6: rotated images draw from the center-compensated anchor
  // (rotation 0 keeps the exact legacy call — byte-identical).
  if (o.rotation % 360 === 0) {
    dc.ctx.stampImage(dc.slot, image, {
      x: o.x,
      y: o.y,
      width: o.w,
      height: o.h,
      opacity: o.opacity,
    });
  } else {
    dc.ctx.stampImage(dc.slot, image, {
      ...rotatedRectDraw(o, o.rotation),
      opacity: o.opacity,
    });
  }
}

function drawShapeObject(o: ShapeObj, dc: DrawCtx): void {
  const stroke = o.stroke !== null ? rgbOf(o.stroke) : undefined;
  const fill = o.fill !== null ? rgbOf(o.fill) : undefined;
  const borderDash = o.dash ? [4, 3] : undefined;
  const rotation = o.rotation || 0;
  if (o.kind === "rect") {
    if (rotation % 360 === 0) {
      const rect = clampToPage(o, dc.view);
      if (!rect) return;
      dc.ctx.stampRect(dc.slot, {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: fill,
        opacity: fill !== undefined ? o.opacity : undefined,
        borderColor: stroke,
        borderWidth: stroke !== undefined ? o.strokeW : 0,
        borderOpacity: stroke !== undefined ? o.opacity : undefined,
        borderDashArray: stroke !== undefined ? borderDash : undefined,
      });
    } else {
      dc.ctx.stampRect(dc.slot, {
        ...rotatedRectDraw(o, rotation),
        color: fill,
        opacity: fill !== undefined ? o.opacity : undefined,
        borderColor: stroke,
        borderWidth: stroke !== undefined ? o.strokeW : 0,
        borderOpacity: stroke !== undefined ? o.opacity : undefined,
        borderDashArray: stroke !== undefined ? borderDash : undefined,
      });
    }
    return;
  }
  if (o.kind === "ellipse") {
    // Ellipses never rotate (pdf-lib drawEllipse has no rotate) — honest
    // disable in the UI; a stray rotation value is simply ignored.
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    dc.ctx.stampEllipse(dc.slot, {
      xScale: o.w / 2,
      yScale: o.h / 2,
      x: cx,
      y: cy,
      color: fill,
      opacity: fill !== undefined ? o.opacity : undefined,
      borderColor: stroke,
      borderWidth: stroke !== undefined ? o.strokeW : 0,
      borderOpacity: stroke !== undefined ? o.opacity : undefined,
      borderDashArray: stroke !== undefined ? borderDash : undefined,
    });
    return;
  }
  // line / arrow — display endpoints (flip-aware), rotated around the
  // object's display center, then mapped to user space.
  const disp = pdfRectToDisplay(o, dc.view);
  const ends = lineEndpoints(disp, o.flip);
  const e1 = rotDisp(o, dc.view, { x: ends.x1, y: ends.y1 });
  const e2 = rotDisp(o, dc.view, { x: ends.x2, y: ends.y2 });
  const p1 = displayToPdfPoint(e1.x, e1.y, dc.view);
  const p2 = displayToPdfPoint(e2.x, e2.y, dc.view);
  dc.ctx.stampLine(dc.slot, {
    start: p1,
    end: p2,
    thickness: o.strokeW,
    color: stroke ?? { r: 0, g: 0, b: 0 },
    opacity: o.opacity,
    dashArray: o.dash ? [4, 3] : undefined,
  });
  if (o.kind === "arrow") {
    // Open head: two short strokes at ±26° from the tip direction.
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;
    const head = Math.min(14, Math.max(6, len * 0.22));
    const ux = dx / len;
    const uy = dy / len;
    for (const sign of [1, -1]) {
      const wx = p2.x - head * (ux * Math.cos(0.45) - sign * uy * Math.sin(0.45));
      const wy = p2.y - head * (uy * Math.cos(0.45) + sign * ux * Math.sin(0.45));
      dc.ctx.stampLine(dc.slot, {
        start: { x: p2.x, y: p2.y },
        end: { x: wx, y: wy },
        thickness: o.strokeW,
        color: stroke ?? { r: 0, g: 0, b: 0 },
        opacity: o.opacity,
      });
    }
  }
}

function drawFreehand(o: DrawObj, dc: DrawCtx): void {
  const color = rgbOf(o.stroke);
  for (let i = 1; i < o.pts.length; i += 1) {
    const a = objPointToPdf(o, dc.view, o.pts[i - 1][0], o.pts[i - 1][1]);
    const b = objPointToPdf(o, dc.view, o.pts[i][0], o.pts[i][1]);
    dc.ctx.stampLine(dc.slot, {
      start: a,
      end: b,
      thickness: o.strokeW,
      color,
      opacity: o.opacity,
      lineCap: 1,
    });
  }
}

function drawWhiteout(o: EditorObject, dc: DrawCtx): void {
  if (o.kind !== "whiteout") return;
  if (o.rotation % 360 === 0) {
    const rect = clampToPage(o, dc.view);
    if (!rect) return;
    dc.ctx.stampRect(dc.slot, {
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color: rgbOf(o.fill),
      opacity: o.opacity,
    });
  } else {
    dc.ctx.stampRect(dc.slot, {
      ...rotatedRectDraw(o, o.rotation),
      color: rgbOf(o.fill),
      opacity: o.opacity,
    });
  }
}

// ---------------------------------------------------------------------------
// Form fields (P8.4) — real AcroForm widgets, not page content
// ---------------------------------------------------------------------------

/** Widget chrome shared by every field flavour (make-pdf-fillable's
 * light-grey visual language so placed fields read as interactive). */
const FIELD_BORDER: StampRgb = { r: 0.62, g: 0.65, b: 0.7 };
const CHECK_BORDER: StampRgb = { r: 0.45, g: 0.49, b: 0.55 };

interface FieldCounters {
  added: number;
  textFields: number;
  checkboxes: number;
  dropdowns: number;
  radios: number;
}

/** True when the Helvetica appearance stream can encode the string
 * (Devanagari and friends cannot — honest skip, field still created). */
function winAnsiSafe(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff) return false;
  }
  return true;
}

/** Creates the AcroForm widgets for every field object. Radio objects
 * that share one name become a single group (one circle each). */
function addFieldObjects(
  objects: EditorObject[],
  ctx: StampContext,
  counters: FieldCounters
): void {
  const taken = new Set<string>();
  for (const slotNum of sourceFieldNames(ctx)) {
    taken.add(slotNum);
  }
  const uniqueName = (base: string): string => {
    let clean = base.replace(/\s+/g, " ").trim().slice(0, 60) || "Field";
    if (!taken.has(clean)) {
      taken.add(clean);
      return clean;
    }
    for (let n = 2; n < 500; n += 1) {
      const candidate = `${clean} ${n}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
    clean = `${clean} ${Date.now()}`;
    taken.add(clean);
    return clean;
  };

  const radioGroups = new Map<string, ReturnType<StampContext["createRadioGroup"]>>();
  let radioFallback = 0;

  for (const obj of objects) {
    if (obj.kind !== "field") continue;
    const slot = obj.page;
    if (slot < 0 || slot >= ctx.slotCount) continue;

    if (obj.fieldType === "radio") {
      // One group per shared name; every object adds one circle widget.
      let group = radioGroups.get(obj.name);
      if (!group) {
        group = ctx.createRadioGroup(uniqueName(obj.name));
        radioGroups.set(obj.name, group);
        if (obj.required) group.enableRequired();
      }
      let option = obj.value.trim();
      if (option.length === 0 || !winAnsiSafe(option)) {
        radioFallback += 1;
        option = `Option ${radioFallback}`;
      }
      try {
        group.addOptionToSlot(slot, option, {
          x: obj.x,
          y: obj.y,
          width: obj.w,
          height: obj.h,
          borderWidth: 1,
          borderColor: CHECK_BORDER,
        });
        counters.added += 1;
        counters.radios += 1;
      } catch {
        /* widget add failed (rare geometry) — skip honestly */
      }
      continue;
    }

    const name = uniqueName(obj.name);
    try {
      if (obj.fieldType === "checkbox") {
        const box = ctx.createCheckBox(name);
        if (obj.required) box.enableRequired();
        if (obj.value === FIELD_CHECKED) box.check();
        const size = Math.min(obj.w, obj.h);
        box.addToSlot(slot, {
          x: obj.x + (obj.w - size) / 2,
          y: obj.y + (obj.h - size) / 2,
          width: size,
          height: size,
          borderWidth: 1,
          borderColor: CHECK_BORDER,
        });
        counters.checkboxes += 1;
      } else if (obj.fieldType === "dropdown") {
        const list = ctx.createDropdown(name);
        if (obj.required) list.enableRequired();
        for (const option of obj.options) {
          if (!winAnsiSafe(option)) continue;
          try {
            list.addOptions(option);
          } catch {
            /* unencodable choice — skipped honestly */
          }
        }
        if (obj.value && winAnsiSafe(obj.value) && obj.options.includes(obj.value)) {
          try {
            list.select(obj.value);
          } catch {
            /* default selection skipped honestly */
          }
        }
        list.addToSlot(slot, {
          x: obj.x,
          y: obj.y,
          width: obj.w,
          height: obj.h,
          borderWidth: 1,
          borderColor: FIELD_BORDER,
        });
        counters.dropdowns += 1;
      } else {
        const field = ctx.createTextField(name);
        if (obj.fieldType === "multiline") field.enableMultiline();
        if (obj.required) field.enableRequired();
        if (obj.value.length > 0 && winAnsiSafe(obj.value)) {
          try {
            field.setText(obj.value);
          } catch {
            /* unencodable default — field still created empty */
          }
        }
        field.addToSlot(slot, {
          x: obj.x,
          y: obj.y,
          width: obj.w,
          height: obj.h,
          borderWidth: 1,
          borderColor: FIELD_BORDER,
        });
        counters.textFields += 1;
      }
      counters.added += 1;
    } catch {
      /* field creation failed — skip this one honestly */
    }
  }
}

/** The source document's existing AcroForm field names (the dedupe seed —
 * pdf-lib's form.getFields().map(getName) on OUR parser). */
function sourceFieldNames(ctx: StampContext): string[] {
  const out: string[] = [];
  const walk = (fieldsVal: unknown): void => {
    const arr = fieldsVal as { k?: string; items?: unknown[] } | undefined;
    if (!arr || arr.k !== "arr" || !Array.isArray(arr.items)) return;
    for (const item of arr.items) {
      const ref = item as { k?: string; num?: number };
      if (!ref || ref.k !== "ref" || typeof ref.num !== "number") continue;
      const field = ctx.doc.getObject(ref.num);
      if (!field || field.k !== "dict") continue;
      const t = field.m.get("T");
      if (t && (t.k === "str" || t.k === "hstr") && t.b.length >= 4) {
        // UTF-16BE with the FEFF BOM (PDFHexString.fromText form).
        let name = "";
        for (let i = 2; i + 1 < t.b.length; i += 2) {
          name += String.fromCharCode((t.b[i]! << 8) | t.b[i + 1]!);
        }
        if (name.length > 0) out.push(name);
      }
    }
  };
  const rootObj = ctx.doc.trailer.get("Root");
  const root =
    rootObj && rootObj.k === "ref" ? ctx.doc.getObject(rootObj.num) : rootObj;
  if (!root || (root.k !== "dict" && root.k !== "stream")) return out;
  const afObj = root.k === "dict" ? root.m.get("AcroForm") : undefined;
  if (!afObj) return out;
  const af = afObj.k === "ref" ? ctx.doc.getObject(afObj.num) : afObj;
  if (!af || (af.k !== "dict" && af.k !== "stream")) return out;
  const fields = af.k === "dict" ? af.m.get("Fields") : undefined;
  if (fields && fields.k === "ref") {
    const resolved = ctx.doc.getObject(fields.num);
    walk(resolved);
  } else {
    walk(fields);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, assets } = request;
  const file = files[0];
  const opts = options as OptionValues & Record<string, string>;

  const ekey = typeof opts.ekey === "string" ? opts.ekey : "";
  const blob = parseBlob(opts[`e:${ekey}`]);
  const assetOrder = blob?.assetOrder ?? [];
  const pageViews = parseViews(blob?.pageViews);
  // Tampered-blob guard: the surface caps the workspace at 500 slots.
  if (pageViews.length > MAX_WORKSPACE_PAGES) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });

  const data = new Uint8Array(await file.arrayBuffer());
  let ctx: StampContext;
  try {
    ctx = StampContext.load(data);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("PDF_PASSWORD");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /password|encrypt/i.test(message) ? "PDF_PASSWORD" : "PDF_PARSE"
    );
  }
  // The engine refuses encrypted files at parse (mixed-encryption outputs
  // would be unreadable) — the surface gates the CTA today; the typed
  // refusal above keeps the worker honest for any future caller.
  const srcCount = ctx.pageCount;
  // R12: stale pre-R12 blobs carry NO src fields — views beyond the source
  // count are junk exactly like the old padded array ignored them, so they
  // truncate to the source count and read as identity. Explicit-src plans
  // (the only thing the surface sends) may legitimately exceed srcCount
  // (duplicates). Tamper-proofing: clamp every src into the document.
  const hasExplicitSrc = pageViews.some((v) => v.src !== undefined);
  const bounded = hasExplicitSrc
    ? pageViews
    : pageViews.slice(0, srcCount);
  const planViews = bounded.map((v, i) => ({
    ...v,
    src: Math.min(v.src ?? i, Math.max(0, srcCount - 1)),
  }));

  // R12 page ops: identity plans keep the identity slot mapping — every
  // original page, views padded with the first view / the default. Three
  // flavors of identity: stale/empty blobs, a full-length in-order plan,
  // and the >500-page truncated workspace (identity prefix + the truncated
  // flag — without the flag a shorter plan is a TAIL DELETE and gets
  // surgery). Non-identity plans become the SLOT plan (src duplicates +
  // removals + reorder — the engine gives every slot its own page dict).
  let views: PageView[];
  const identity =
    planViews.length === 0 ||
    (isIdentityOrder(planViews, srcCount) &&
      (planViews.length === srcCount || blob?.truncated === true));
  if (identity) {
    views = Array.from({ length: srcCount }, (_, i) =>
      planViews[i] ?? planViews[0] ?? {
        x0: 0,
        y0: 0,
        x1: 612,
        y1: 792,
        rotate: 0,
      }
    );
  } else {
    post({
      type: "progress",
      runId,
      pct: 10,
      stage: "processing",
      detail: { pages: planViews.length },
    });
    views = planViews;
  }

  // R13 page rotation: each slot's view carries the EFFECTIVE rotation
  // (source /Rotate + the user's offset). Slots that differ from the source
  // page's current /Rotate get it rewritten via the slot set override —
  // content, annotations and user-space objects all ride along (the honest
  // editor semantic: rotate the page, rotate everything on it).
  //
  // TRUST: only slots whose WIRE view carried an explicit quadrant rotate.
  // parseViews defaults absent/garbage rotate to 0 — rewriting /Rotate
  // from that default would FLATTEN a source page's own /Rotate on stale
  // or tampered blobs (the R12 src lesson, applied to rotate).
  const rotateExplicit = (
    Array.isArray(blob?.pageViews) ? blob.pageViews : []
  ).map(
    (v) =>
      typeof (v as PageView | undefined)?.rotate === "number" &&
      [0, 90, 180, 270].includes((v as PageView).rotate)
  );

  // R15 page crop: slots whose WIRE view carried a well-shaped crop get
  // the output page's /CropBox set to it (clamped into the view box + the
  // minimum size by sanitizeCrop — the same guard the surface's commit
  // path runs). Objects outside the final crop are clipped by every
  // reader's CropBox rule — the WYSIWYG semantic — and the drawing pass
  // below pivots through the EFFECTIVE (cropped) view, so text wrap and
  // bg clamps agree with what the user saw on the canvas.
  //
  // TRUST: only slots whose wire view carried an explicit, well-shaped
  // crop. A stale blob (pre-R15) carries none — rewriting /CropBox from a
  // defaulted view would RESIZE a page the user never cropped (the R13
  // rotate-flattening lesson, applied to crop). The loop is bounded by the
  // plan, so a truncated (>500-page) workspace leaves the untouched tail's
  // own /CropBox exactly as the document shipped it.
  const cropExplicit = (
    Array.isArray(blob?.pageViews) ? blob.pageViews : []
  ).map((v) => validCropShape((v as PageView | undefined)?.crop) !== undefined);
  // The SLOT plan: one {src, set} per output slot. Identity runs carry it
  // too (src = i) so the rotate/crop overrides have a uniform home.
  let croppedCount = 0;
  const slots: StampSlot[] = views.map((v, i) => {
    // Identity runs keep slot i on SOURCE page i — the padded views are
    // pure coordinate frames (their carry-over src is NOT page identity;
    // the R12 truncated-tail lesson). Surgery runs read the plan's src.
    const src = identity ? i : planSrc(v, i, srcCount);
    const set = applySlotSets(
      v,
      rotateExplicit[i] === true,
      ctx.pages[src].rotate,
      cropExplicit[i] === true
    );
    if (set !== undefined) {
      for (const [k] of set) {
        if (k === "CropBox") {
          croppedCount += 1;
          break;
        }
      }
    }
    return { src, set };
  });
  ctx.setSlotPlan(slots);
  const slotCount = ctx.slotCount;

  post({ type: "progress", runId, pct: 12, stage: "processing" });

  const knownAssets = new Set(assetOrder);
  const objects = sanitizeObjects(blob?.objects, slotCount, knownAssets);

  // Image assets (collectAssets order ↔ assetOrder pairing) — pre-embedded
  // below, before drawing starts; drawing reads the cache synchronously.
  const assetIndex = new Map<string, number>();
  assetOrder.forEach((key, i) => assetIndex.set(key, i));
  const imageCache = new Map<string, StampImage | null>();
  const imageFor = (key: string): StampImage | null =>
    imageCache.get(key) ?? null;

  // Pre-embed every referenced asset (once, SYNC on the own engine).
  const referenced = [
    ...new Set(
      objects
        .filter((o): o is ImageObj => o.kind === "image")
        .map((o) => o.assetKey)
    ),
  ];
  let embedded = 0;
  for (const key of referenced) {
    const idx = assetIndex.get(key);
    let image: StampImage | null = null;
    if (idx !== undefined && assets && idx < assets.length) {
      const asset = assets[idx];
      try {
        const bytes = new Uint8Array(await asset.arrayBuffer());
        const type = (asset.type || "").toLowerCase();
        image =
          type === "image/jpeg"
            ? ctx.embedJpeg(bytes)
            : ctx.embedPng(bytes);
        embedded += 1;
      } catch {
        image = null;
      }
    }
    imageCache.set(key, image);
  }

  // Fonts: standard base keys (the engine's 12-font bank) + the self-hosted
  // Devanagari TTF (shaped Type0 subset) + the italic key variants.
  const needDeva = objects.some(
    (o) => o.kind === "text" && baseStampFont(o) === "devanagari"
  );
  const deva = needDeva ? ctx.embedTtf(await loadDevanagariBytes()) : null;
  const italicCache = new Map<string, StampFontKey | null>();
  const fontBag: FontBag = {
    base: (id) =>
      id === "devanagari"
        ? deva
          ? { ttf: deva }
          : null
        : { key: id as StampFontKey },
    italic: (id) => {
      if (italicCache.has(id)) {
        const cached = italicCache.get(id) ?? null;
        return cached !== null ? { key: cached } : null;
      }
      const mapped: StampFontKey | null =
        Object.prototype.hasOwnProperty.call(ITALIC_MAP, id)
          ? ITALIC_MAP[id]!
          : null;
      italicCache.set(id, mapped);
      return mapped !== null ? { key: mapped } : null;
    },
  };
  const widthOf = (text: string, size: number, ref: FontRef): number =>
    ref.ttf ? ref.ttf.measure(text, size) : ctx.measure(text, ref.key, size);
  const ascentOf = (size: number, ref: FontRef): number =>
    ref.ttf
      ? ref.ttf.heightAtSize(size, { descender: false })
      : stdFontAscent(ref.key, size);

  post({ type: "progress", runId, pct: 30, stage: "processing" });

  // Group by page (array order = z-order), draw in order.
  // R15: the draw view is the EFFECTIVE (cropped) one — clampToPage, text
  // wrap and the display round-trips all pivot through the crop window,
  // byte-identical for uncropped slots (effectiveView is ref-stable).
  let drawn = 0;
  const total = Math.max(objects.length, 1);
  for (let p = 0; p < slotCount; p += 1) {
    const pageObjects = objects.filter((o) => o.page === p);
    const dc: DrawCtx = {
      slot: p,
      view: effectiveView(views[p]),
      fonts: fontBag,
      widthOf,
      ascentOf,
      ctx,
      imageFor,
    };
    for (const obj of pageObjects) {
      switch (obj.kind) {
        case "text":
          drawTextObject(obj, dc);
          break;
        case "image":
          drawImageObject(obj, dc);
          break;
        case "rect":
        case "ellipse":
        case "line":
        case "arrow":
          drawShapeObject(obj, dc);
          break;
        case "draw":
          drawFreehand(obj, dc);
          break;
        case "whiteout":
          drawWhiteout(obj, dc);
          break;
      }
      drawn += 1;
    }
    post({
      type: "progress",
      runId,
      pct: 30 + Math.min(58, Math.round((58 * drawn) / total)),
      stage: "processing",
      detail: { page: p + 1, pages: slotCount },
    });
  }

  // Form fields (P8.4) — AcroForm widgets AFTER page content so they sit
  // on top in every reader; array order = tab order (annotation order).
  // The engine only attaches /AcroForm when fields exist — passthrough
  // stays byte-clean (source forms ride through untouched).
  const counters: FieldCounters = {
    added: 0,
    textFields: 0,
    checkboxes: 0,
    dropdowns: 0,
    radios: 0,
  };
  if (objects.some((o) => o.kind === "field")) {
    try {
      addFieldObjects(objects, ctx, counters);
    } catch {
      /* AcroForm already broken in the source — fields skipped honestly */
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = ctx.write();
  const outputName = `${safeBaseName(file.name)}-edited.pdf`;

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: slotCount,
      objects: drawn,
      images: embedded,
      fields: counters.added,
      ...(croppedCount > 0 ? { cropped: croppedCount } : {}),
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let code = "editPdf.errorBuild";
    if (message === "PDF_PASSWORD") {
      code = "tool.errorEncrypted";
    } else if (message === "PDF_PARSE") {
      code = "tool.errorCorrupt";
    } else if (/cannot encode|WinAnsi|chars/i.test(message)) {
      code = "editPdf.errorFont";
    }
    post({
      type: "error",
      runId: data.runId,
      code,
      detail:
        code === "editPdf.errorBuild" || code === "editPdf.errorFont"
          ? message.slice(0, 200)
          : undefined,
    });
  });
};
