/**
 * PRE-BUILD smoke test for the Rasterize PDF tool (P4.1, PRD §8.4:
 * "Pages ko images banakar naya PDF (non-editable); DPI choice").
 *
 * bun cannot run pdf.js's canvas renderer, so this smoke locks the PURE
 * parts of the pipeline — the same math the worker performs — plus the
 * pdf-lib rebuild step with a real (hardcoded) JPEG:
 *
 *  1. DPI → scale math (pdf.js convention: scale = dpi / 72, clamped to
 *     [0.5, 8] exactly like tools/pdf-to-images).
 *  2. Page-size/rotation mapping: the output page must use the VISIBLE
 *     point size (pdf.js viewport at scale 1 — /Rotate baked in, negative
 *     and ≥360 rotations normalized, non-multiples of 90 treated as 0 —
 *     mirroring pdf.js core Page.rotate + PageViewport).
 *  3. The 40MP per-page pixel cap clamp (aspect-preserving downscale,
 *     floor guarantees the product stays under the cap).
 *  4. The pdf-lib rebuild: build the output document exactly like the
 *     worker does (embedJpg + page at exact visible point size +
 *     drawImage full-bleed at margin 0) and verify it structurally:
 *     page count/sizes, full-bleed cm, image XObject dims, byte-identical
 *     DCT payload (no PDF-layer recompression), and a pristine image-only
 *     document (no AcroForm, no /Annots).
 *
 * Run: bun scripts/smoke-rasterize.ts
 */
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFDict,
} from "pdf-lib";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string): void {
  failed += 1;
  console.error(`FAIL ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message} (expected ${b}, got ${a})`);
}

function near(actual: number, expected: number, message: string): void {
  assert(
    Math.abs(actual - expected) < 1e-9,
    `${message} (expected ${expected}, got ${actual})`
  );
}

/* ------------------------------------------------------------------ */
/* Pure pipeline math (mirrors tools/rasterize-pdf/worker.ts)          */
/* ------------------------------------------------------------------ */

/** pdf.js render scale for a DPI choice, clamped like pdf-to-images. */
export function dpiToScale(dpi: number): number {
  return Math.max(0.5, Math.min(8, dpi / 72));
}

/**
 * Visible page size in points — what pdf.js's viewport at scale 1 reports
 * (rotation baked in). Normalization mirrors pdf.js core Page.rotate:
 * non-multiples of 90 → 0, then wrapped into [0, 360).
 */
export function visibleSize(
  widthPt: number,
  heightPt: number,
  rotate: number
): [number, number] {
  let r = rotate;
  if (r % 90 !== 0) {
    r = 0;
  } else if (r >= 360) {
    r %= 360;
  } else if (r < 0) {
    r = (r % 360) + 360;
  }
  return r === 90 || r === 270 ? [heightPt, widthPt] : [widthPt, heightPt];
}

/** Canvas pixel size at a scale, with the 40MP per-page cap clamp. */
export const MAX_PIXELS = 40_000_000;

export function clampPixels(
  widthPt: number,
  heightPt: number,
  scale: number
): { scale: number; pixelW: number; pixelH: number } {
  let pixelW = Math.round(widthPt * scale);
  let pixelH = Math.round(heightPt * scale);
  let effective = scale;
  if (pixelW * pixelH > MAX_PIXELS) {
    const factor = Math.sqrt(MAX_PIXELS / (pixelW * pixelH));
    const w = Math.floor(pixelW * factor);
    const h = Math.floor(pixelH * factor);
    effective = Math.min(w / widthPt, h / heightPt);
    pixelW = Math.round(widthPt * effective);
    pixelH = Math.round(heightPt * effective);
  }
  return { scale: effective, pixelW, pixelH };
}

/* ------------------------------------------------------------------ */
/* pdf-lib rebuild (exactly what the worker does after rendering)      */
/* ------------------------------------------------------------------ */

/** A 16×8 two-tone JPEG (red top, blue bottom), 792 bytes. */
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAYEAACAwAAAAAAAAAAAAAAAAAAFWSi4f/EABUBAQEAAAAAAAAAAAAAAAAAAAUH/8QAHREAAAUFAAAAAAAAAAAAAAAAAAIGVNIDFheio//aAAwDAQACEQMRAD8AkpkU0KZFNAKjYSeb7nkActrF5zpQH//Z";

function tinyJpegBytes(): Uint8Array {
  const binary = atob(TINY_JPEG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface RasterPage {
  /** Rendered image bytes (JPEG or PNG). */
  image: Uint8Array;
  /** Visible page size in points (rotation already baked in). */
  widthPt: number;
  heightPt: number;
}

/** Rebuild pass: one page per image, exact point size, full-bleed margin 0. */
export async function buildRasterizedDoc(
  pages: RasterPage[]
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const image = await doc.embedJpg(page.image);
    const out = doc.addPage([page.widthPt, page.heightPt]);
    out.drawImage(image, {
      x: 0,
      y: 0,
      width: page.widthPt,
      height: page.heightPt,
    });
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* 1. DPI → scale ---------------------------------------------------- */
  near(dpiToScale(72), 1, "dpiToScale: 72 dpi is scale 1");
  near(dpiToScale(96), 4 / 3, "dpiToScale: 96 dpi is 4/3");
  near(dpiToScale(150), 25 / 12, "dpiToScale: 150 dpi is 25/12");
  near(dpiToScale(300), 25 / 6, "dpiToScale: 300 dpi is 25/6");
  near(dpiToScale(1), 0.5, "dpiToScale: clamped at 0.5 minimum");
  near(dpiToScale(1200), 8, "dpiToScale: clamped at 8 maximum");

  /* 2. Pixel sizes ---------------------------------------------------- */
  // A4 595.28 × 841.89 pt at 96 dpi (scale 4/3).
  eq(
    [
      Math.round(595.28 * dpiToScale(96)),
      Math.round(841.89 * dpiToScale(96)),
    ],
    [794, 1123],
    "pixels: A4 at 96 dpi is 794×1123"
  );
  eq(
    [
      Math.round(612 * dpiToScale(72)),
      Math.round(792 * dpiToScale(72)),
    ],
    [612, 792],
    "pixels: US Letter at 72 dpi keeps its point size"
  );

  /* 3. Visible size (rotation baked in) ------------------------------- */
  eq(
    visibleSize(595.28, 841.89, 0),
    [595.28, 841.89],
    "visibleSize: /Rotate 0 keeps portrait"
  );
  eq(
    visibleSize(595.28, 841.89, 90),
    [841.89, 595.28],
    "visibleSize: /Rotate 90 swaps to landscape"
  );
  eq(
    visibleSize(595.28, 841.89, 180),
    [595.28, 841.89],
    "visibleSize: /Rotate 180 keeps the same box"
  );
  eq(
    visibleSize(595.28, 841.89, 270),
    [841.89, 595.28],
    "visibleSize: /Rotate 270 swaps to landscape"
  );
  eq(
    visibleSize(595.28, 841.89, -90),
    visibleSize(595.28, 841.89, 270),
    "visibleSize: -90 normalizes like pdf.js"
  );
  eq(
    visibleSize(595.28, 841.89, 450),
    visibleSize(595.28, 841.89, 90),
    "visibleSize: 450 wraps to 90"
  );
  eq(
    visibleSize(595.28, 841.89, 95),
    [595.28, 841.89],
    "visibleSize: non-multiple of 90 treated as 0"
  );

  /* 4. 40MP cap clamp -------------------------------------------------- */
  // A0 landscape 3370 × 2384 pt at 300 dpi → 14,023 × 9,934 ≈ 139.3MP.
  const huge = clampPixels(3370, 2384, dpiToScale(300));
  assert(
    huge.pixelW * huge.pixelH > 0 && huge.pixelW * huge.pixelH <= MAX_PIXELS,
    `clamp: A0 @300dpi clamped under 40MP (got ${huge.pixelW}×${huge.pixelH} = ${huge.pixelW * huge.pixelH})`
  );
  const hugeAspect = huge.pixelW / huge.pixelH;
  const rawAspect = 3370 / 2384;
  assert(
    Math.abs(hugeAspect - rawAspect) / rawAspect < 0.002,
    "clamp: aspect ratio preserved within 0.2%"
  );
  assert(
    huge.scale < dpiToScale(300),
    "clamp: effective scale reduced below the requested one"
  );
  // Below the cap nothing changes at all.
  const small = clampPixels(595.28, 841.89, dpiToScale(150));
  near(small.scale, dpiToScale(150), "clamp: under the cap scale is untouched");
  eq(
    [small.pixelW, small.pixelH],
    [Math.round(595.28 * (25 / 12)), Math.round(841.89 * (25 / 12))],
    "clamp: under the cap pixel size is untouched"
  );
  // Rounding can never push a clamped page back over the cap.
  let worstCase = true;
  for (const [w, h] of [
    [3370, 2384],
    [2384, 3370],
    [10000, 10000],
    [612, 100000],
  ]) {
    const c = clampPixels(w, h, dpiToScale(300));
    if (c.pixelW * c.pixelH > MAX_PIXELS) worstCase = false;
  }
  assert(worstCase, "clamp: floor math holds the cap for extreme page shapes");

  /* 5. pdf-lib rebuild -------------------------------------------------- */
  // Page 1: a portrait A4 page with /Rotate 0. Page 2: the same page
  // stored with /Rotate 90 — the output must use the VISIBLE orientation.
  const jpeg = tinyJpegBytes();
  const [w0, h0] = visibleSize(595.28, 841.89, 0);
  const [w90, h90] = visibleSize(595.28, 841.89, 90);
  const doc = await buildRasterizedDoc([
    { image: jpeg, widthPt: w0, heightPt: h0 },
    { image: jpeg, widthPt: w90, heightPt: h90 },
  ]);
  const saved = await doc.save();
  const reloaded = await PDFDocument.load(saved, { updateMetadata: false });

  eq(reloaded.getPageCount(), 2, "rebuild: one output page per rendered image");

  const pages = reloaded.getPages();
  near(
    pages[0].getSize().width,
    595.28,
    "rebuild: page 1 keeps the visible portrait width"
  );
  near(
    pages[0].getSize().height,
    841.89,
    "rebuild: page 1 keeps the visible portrait height"
  );
  near(
    pages[1].getSize().width,
    841.89,
    "rebuild: page 2 uses the rotated visible width"
  );
  near(
    pages[1].getSize().height,
    595.28,
    "rebuild: page 2 uses the rotated visible height"
  );

  // Full-bleed draw: the placement must cover the whole page. pdf-lib's
  // drawImage emits translate(x, y) + scale(w, h) + Do — at x=0, y=0 with
  // the page's own dimensions that is a margin-0 full-bleed.
  const { decodePDFRawStream, PDFArray } = await import("pdf-lib");
  let fullBleedOk = true;
  let imageCount = 0;
  let widthOk = true;
  let heightOk = true;
  let bytesIdentical = true;
  const pageContentText = (raw: unknown): string => {
    // /Contents may be a single stream ref or an array of refs — both
    // concatenate (PDF 32000-1 §7.7.3.3).
    if (raw instanceof PDFArray) {
      let text = "";
      for (let i = 0; i < raw.size(); i += 1) {
        text += pageContentText(raw.lookup(i));
      }
      return text;
    }
    if (raw instanceof PDFRawStream) {
      return new TextDecoder().decode(decodePDFRawStream(raw).decode());
    }
    return "";
  };
  for (const page of pages) {
    const text = pageContentText(page.node.Contents());
    const size = page.getSize();
    const w = Number(size.width.toFixed(2));
    const h = Number(size.height.toFixed(2));
    if (
      !text.includes("1 0 0 1 0 0 cm") ||
      (!text.includes(`${size.width} 0 0 ${size.height} 0 0 cm`) &&
        !text.includes(`${w} 0 0 ${h} 0 0 cm`))
    ) {
      fullBleedOk = false;
    }

    const xObjects = page.node
      .Resources()
      ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (xObjects === undefined || xObjects.keys().length !== 1) {
      fullBleedOk = false;
      continue;
    }
    const imageRef = xObjects.get(xObjects.keys()[0]);
    const image = reloaded.context.lookup(imageRef);
    if (image instanceof PDFRawStream) {
      const wNum = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
      const hNum = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
      if (wNum === undefined || wNum.asNumber() !== 16) widthOk = false;
      if (hNum === undefined || hNum.asNumber() !== 8) heightOk = false;
      const embedded = image.contents;
      if (
        embedded.length !== jpeg.length ||
        embedded.some((byte, i) => byte !== jpeg[i])
      ) {
        bytesIdentical = false;
      }
      const filter = image.dict.lookupMaybe(PDFName.of("Filter"), PDFName);
      if (filter !== undefined && filter.asString() === "/DCTDecode") {
        imageCount += 1;
      } else {
        fullBleedOk = false;
      }
    } else {
      fullBleedOk = false;
    }
    // pdf-lib's page normalize writes an empty /Annots [] when images are
    // drawn — that is zero annotations, not an interactive layer.
    const annots = page.node.Annots();
    if (annots !== undefined && annots.size() > 0) fullBleedOk = false;
  }
  assert(fullBleedOk, "rebuild: every page draws its image full-bleed at margin 0");
  assert(imageCount === 2, `rebuild: every page has exactly one image XObject (got ${imageCount})`);
  assert(widthOk, "rebuild: image XObject /Width matches the JPEG (16px)");
  assert(heightOk, "rebuild: image XObject /Height matches the JPEG (8px)");
  assert(
    bytesIdentical,
    "rebuild: embedded DCT payload is byte-identical (no recompression)"
  );
  assert(
    reloaded.catalog.getAcroForm() === undefined,
    "rebuild: rasterized output carries no AcroForm"
  );

  console.log(
    `\nsmoke-rasterize: ${passed}/${passed + failed} GREEN${failed > 0 ? ` (${failed} FAILED)` : ""}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("SMOKE CRASH", error);
  process.exit(1);
});
