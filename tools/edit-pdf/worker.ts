import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import type { StampFontId } from "../stamp-common/layout";
import {
  FIELD_CHECKED,
  LINE_HEIGHT,
  TEXT_PAD,
  displayToPdfPoint,
  hexToRgb,
  pdfRectToDisplay,
  sanitizeObjects,
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
 * The surface owns every interaction; this worker bakes the final PDF:
 * original document (pdf-lib) + the objects blob ("e:<fileId>" — the
 * redact epoch-key pattern) + image assets riding the run message
 * (config.collectAssets ↔ assetOrder pairing).
 *
 * Object coords are PDF user-space points (y from the bottom) — the same
 * space pdf-lib draws in, so unrotated pages map 1:1. Rotated pages
 * (/Rotate 90/180/270) get rotation-compensated TEXT (drawText rotate =
 * degrees(/Rotate)) so words read upright the way the user typed them;
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
}

function parseBlob(raw: unknown): WireBlob | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WireBlob>;
    const views = Array.isArray(parsed.pageViews) ? parsed.pageViews : [];
    const order = Array.isArray(parsed.assetOrder)
      ? parsed.assetOrder.filter((k): k is string => typeof k === "string")
      : [];
    return { objects: parsed.objects, pageViews: views, assetOrder: order };
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
    }));
}

// ---------------------------------------------------------------------------
// Font resolution (standard 14 + italic variants + self-hosted Devanagari)
// ---------------------------------------------------------------------------

const DEVA_RE = /[\u0900-\u097F]/;

const ITALIC_MAP: Record<string, StandardFonts> = {
  helvetica: StandardFonts.HelveticaOblique,
  "helvetica-b": StandardFonts.HelveticaBoldOblique,
  times: StandardFonts.TimesRomanItalic,
  "times-b": StandardFonts.TimesRomanBoldItalic,
  courier: StandardFonts.CourierOblique,
  "courier-b": StandardFonts.CourierBoldOblique,
};

function baseStampFont(o: TextObj): StampFontId {
  if (o.font === "devanagari" || DEVA_RE.test(o.text)) return "devanagari";
  return o.bold ? (`${o.font}Bold` as StampFontId) : (o.font as StampFontId);
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

function rgbOf(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return rgb(r, g, b);
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
  page: PDFPage;
  view: PageView;
  fonts: FontBag;
  imageFor: (key: string) => PDFImage | null;
}

interface FontBag {
  base: (id: StampFontId) => PDFFont;
  italic: (id: string) => PDFFont | null;
}

function drawTextObject(o: TextObj, ctx: DrawCtx): void {
  if (o.text.trim().length === 0) return;
  const font = resolveFont(o, ctx);
  const size = o.size;
  const disp = pdfRectToDisplay(o, ctx.view);
  const pad = TEXT_PAD;
  const availW = Math.max(4, disp.w - 2 * pad);
  const lines = wrapText(o.text, availW, (s) =>
    font.widthOfTextAtSize(s, size)
  );
  const ascent = font.heightAtSize(size, { descender: false });
  const lh = LINE_HEIGHT * size;
  const rotate = degrees(ctx.view.rotate || 0);

  if (o.bg !== null) {
    const rect = clampToPage(o, ctx.view);
    if (rect) {
      ctx.page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: rgbOf(o.bg),
        opacity: o.opacity,
      });
    }
  }

  const color = rgbOf(o.color);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineW = font.widthOfTextAtSize(line, size);
    const startX =
      o.align === "center"
        ? disp.x + pad + Math.max(0, (availW - lineW) / 2)
        : o.align === "right"
          ? disp.x + disp.w - pad - lineW
          : disp.x + pad;
    const baselineY = disp.y + pad + ascent + i * lh;
    const anchor = displayToPdfPoint(startX, baselineY, ctx.view);
    ctx.page.drawText(line, {
      x: anchor.x,
      y: anchor.y,
      size,
      font,
      color,
      opacity: o.opacity,
      rotate,
    });
    if (o.underline && line.length > 0) {
      const uy = baselineY + Math.max(1.2, size * 0.1);
      const p1 = displayToPdfPoint(startX, uy, ctx.view);
      const p2 = displayToPdfPoint(startX + lineW, uy, ctx.view);
      ctx.page.drawLine({
        start: p1,
        end: p2,
        thickness: Math.max(0.4, size * 0.045),
        color,
        opacity: o.opacity,
      });
    }
  }
}

function resolveFont(o: TextObj, ctx: DrawCtx): PDFFont {
  const base = baseStampFont(o);
  if (base === "devanagari") return ctx.fonts.base("devanagari");
  if (o.italic) {
    const key = o.bold ? `${o.font}-b` : o.font;
    const italic = ctx.fonts.italic(key);
    if (italic) return italic;
  }
  return ctx.fonts.base(base);
}

function drawImageObject(o: ImageObj, ctx: DrawCtx): void {
  const image = ctx.imageFor(o.assetKey);
  if (!image) return;
  // pdf-lib drawImage ignores w/h — explicit width/height only (P4.4 pin).
  ctx.page.drawImage(image, {
    x: o.x,
    y: o.y,
    width: o.w,
    height: o.h,
    opacity: o.opacity,
  });
}

function drawShapeObject(o: ShapeObj, ctx: DrawCtx): void {
  const stroke = o.stroke !== null ? rgbOf(o.stroke) : undefined;
  const fill = o.fill !== null ? rgbOf(o.fill) : undefined;
  const borderDash = o.dash ? [4, 3] : undefined;
  if (o.kind === "rect") {
    const rect = clampToPage(o, ctx.view);
    if (!rect) return;
    ctx.page.drawRectangle({
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
    return;
  }
  if (o.kind === "ellipse") {
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    ctx.page.drawEllipse({
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
  // line / arrow — endpoints through the display mapping.
  const [f1, f2] = o.flip
    ? [{ fx: 0, fy: 1 }, { fx: 1, fy: 0 }]
    : [{ fx: 0, fy: 0 }, { fx: 1, fy: 1 }];
  const p1 = objPointToPdf(o, ctx.view, f1.fx, f1.fy);
  const p2 = objPointToPdf(o, ctx.view, f2.fx, f2.fy);
  ctx.page.drawLine({
    start: p1,
    end: p2,
    thickness: o.strokeW,
    color: stroke ?? rgb(0, 0, 0),
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
      ctx.page.drawLine({
        start: { x: p2.x, y: p2.y },
        end: { x: wx, y: wy },
        thickness: o.strokeW,
        color: stroke ?? rgb(0, 0, 0),
        opacity: o.opacity,
      });
    }
  }
}

function drawFreehand(o: DrawObj, ctx: DrawCtx): void {
  const color = rgbOf(o.stroke);
  for (let i = 1; i < o.pts.length; i += 1) {
    const a = objPointToPdf(o, ctx.view, o.pts[i - 1][0], o.pts[i - 1][1]);
    const b = objPointToPdf(o, ctx.view, o.pts[i][0], o.pts[i][1]);
    ctx.page.drawLine({
      start: a,
      end: b,
      thickness: o.strokeW,
      color,
      opacity: o.opacity,
      lineCap: 1,
    });
  }
}

function drawWhiteout(o: EditorObject, ctx: DrawCtx): void {
  if (o.kind !== "whiteout") return;
  const rect = clampToPage(o, ctx.view);
  if (!rect) return;
  ctx.page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    color: rgbOf(o.fill),
    opacity: o.opacity,
  });
}

// ---------------------------------------------------------------------------
// Form fields (P8.4) — real AcroForm widgets, not page content
// ---------------------------------------------------------------------------

/** Widget chrome shared by every field flavour (make-pdf-fillable's
 * light-grey visual language so placed fields read as interactive). */
const FIELD_BORDER = rgb(0.62, 0.65, 0.7);
const CHECK_BORDER = rgb(0.45, 0.49, 0.55);

interface FieldCounters {
  added: number;
  textFields: number;
  checkboxes: number;
  dropdowns: number;
  radios: number;
}

/** True when pdf-lib's Helvetica appearance stream can encode the string
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
  pages: PDFPage[],
  doc: PDFDocument,
  counters: FieldCounters
): void {
  const form = doc.getForm();
  const taken = new Set<string>();
  for (const existing of form.getFields()) {
    taken.add(existing.getName());
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

  const radioGroups = new Map<string, ReturnType<typeof form.createRadioGroup>>();
  let radioFallback = 0;

  for (const obj of objects) {
    if (obj.kind !== "field") continue;
    const page = pages[obj.page];
    if (!page) continue;

    if (obj.fieldType === "radio") {
      // One group per shared name; every object adds one circle widget.
      let group = radioGroups.get(obj.name);
      if (!group) {
        group = form.createRadioGroup(uniqueName(obj.name));
        radioGroups.set(obj.name, group);
        if (obj.required) group.enableRequired();
      }
      let option = obj.value.trim();
      if (option.length === 0 || !winAnsiSafe(option)) {
        radioFallback += 1;
        option = `Option ${radioFallback}`;
      }
      try {
        group.addOptionToPage(option, page, {
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
        const box = form.createCheckBox(name);
        if (obj.required) box.enableRequired();
        if (obj.value === FIELD_CHECKED) box.check();
        const size = Math.min(obj.w, obj.h);
        box.addToPage(page, {
          x: obj.x + (obj.w - size) / 2,
          y: obj.y + (obj.h - size) / 2,
          width: size,
          height: size,
          borderWidth: 1,
          borderColor: CHECK_BORDER,
        });
        counters.checkboxes += 1;
      } else if (obj.fieldType === "dropdown") {
        const list = form.createDropdown(name);
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
        list.addToPage(page, {
          x: obj.x,
          y: obj.y,
          width: obj.w,
          height: obj.h,
          borderWidth: 1,
          borderColor: FIELD_BORDER,
        });
        counters.dropdowns += 1;
      } else {
        const field = form.createTextField(name);
        if (obj.fieldType === "multiline") field.enableMultiline();
        if (obj.required) field.enableRequired();
        if (obj.value.length > 0 && winAnsiSafe(obj.value)) {
          try {
            field.setText(obj.value);
          } catch {
            /* unencodable default — field still created empty */
          }
        }
        field.addToPage(page, {
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

  post({ type: "progress", runId, pct: 4, stage: "reading" });

  const data = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /password|encrypt/i.test(message) ? "PDF_PASSWORD" : "PDF_PARSE"
    );
  }
  const pages = doc.getPages();
  const views: PageView[] = pages.map((_, i) => pageViews[i] ?? pageViews[0] ?? {
    x0: 0,
    y0: 0,
    x1: 612,
    y1: 792,
    rotate: 0,
  });

  post({ type: "progress", runId, pct: 12, stage: "processing" });

  const knownAssets = new Set(assetOrder);
  const objects = sanitizeObjects(blob?.objects, pages.length, knownAssets);

  // Image assets (collectAssets order ↔ assetOrder pairing) — pre-embedded
  // below, before drawing starts; drawing reads the cache synchronously.
  const assetIndex = new Map<string, number>();
  assetOrder.forEach((key, i) => assetIndex.set(key, i));
  const imageCache = new Map<string, PDFImage | null>();
  const imageFor = (key: string): PDFImage | null =>
    imageCache.get(key) ?? null;

  // Pre-embed every referenced asset (async, once).
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
    let image: PDFImage | null = null;
    if (idx !== undefined && assets && idx < assets.length) {
      const asset = assets[idx];
      try {
        const bytes = new Uint8Array(await asset.arrayBuffer());
        const type = (asset.type || "").toLowerCase();
        image =
          type === "image/jpeg"
            ? await doc.embedJpg(bytes)
            : await doc.embedPng(bytes);
        embedded += 1;
      } catch {
        image = null;
      }
    }
    imageCache.set(key, image);
  }

  // Fonts: standard base via stamp-common (Devanagari fetch included) +
  // lazily embedded italic variants.
  const needDeva = objects.some(
    (o) => o.kind === "text" && baseStampFont(o) === "devanagari"
  );
  const stamp = await loadStampFonts(doc, needDeva);
  const italicCache = new Map<string, PDFFont | null>();
  const fontBag: FontBag = {
    base: (id) => stamp.fontFor(id),
    italic: (id) => {
      const existing = italicCache.get(id);
      if (existing || italicCache.has(id)) return existing ?? null;
      const mapped = ITALIC_MAP[id];
      let font: PDFFont | null = null;
      if (mapped) {
        try {
          font = doc.embedStandardFont(mapped);
        } catch {
          font = null;
        }
      }
      italicCache.set(id, font);
      return font;
    },
  };

  post({ type: "progress", runId, pct: 30, stage: "processing" });

  // Group by page (array order = z-order), draw in order.
  let drawn = 0;
  const total = Math.max(objects.length, 1);
  for (let p = 0; p < pages.length; p += 1) {
    const pageObjects = objects.filter((o) => o.page === p);
    const ctx: DrawCtx = {
      page: pages[p],
      view: views[p],
      fonts: fontBag,
      imageFor,
    };
    for (const obj of pageObjects) {
      switch (obj.kind) {
        case "text":
          drawTextObject(obj, ctx);
          break;
        case "image":
          drawImageObject(obj, ctx);
          break;
        case "rect":
        case "ellipse":
        case "line":
        case "arrow":
          drawShapeObject(obj, ctx);
          break;
        case "draw":
          drawFreehand(obj, ctx);
          break;
        case "whiteout":
          drawWhiteout(obj, ctx);
          break;
      }
      drawn += 1;
    }
    post({
      type: "progress",
      runId,
      pct: 30 + Math.min(58, Math.round((58 * drawn) / total)),
      stage: "processing",
      detail: { page: p + 1, pages: pages.length },
    });
  }

  // Form fields (P8.4) — AcroForm widgets AFTER page content so they sit
  // on top in every reader; array order = tab order (annotation order).
  // doc.getForm() would CREATE an empty /AcroForm on a field-less run —
  // gate on actual fields so passthrough stays byte-clean.
  const counters: FieldCounters = {
    added: 0,
    textFields: 0,
    checkboxes: 0,
    dropdowns: 0,
    radios: 0,
  };
  if (objects.some((o) => o.kind === "field")) {
    try {
      addFieldObjects(objects, pages, doc, counters);
    } catch {
      /* AcroForm already broken in the source — fields skipped honestly */
    }
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = await doc.save({ useObjectStreams: true });
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
      pages: pages.length,
      objects: drawn,
      images: embedded,
      fields: counters.added,
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
    } else if (/cannot encode|WinAnsi/i.test(message)) {
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
