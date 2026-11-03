/**
 * DocoPDF own barcode engine — public API.
 *
 * encodeBarcode(format, input) → geometry; barcodeToSvg / barcodeToPngDataUrl
 * render it. Surface-compatible with the QR engine's module layout.
 */

export {
  BARCODE_FORMATS,
  BARCODE_LIMITS,
  DIGIT_ONLY_FORMATS,
  encodeBarcode,
  isBarcodeFormat,
  type BarcodeFormat,
  type BarcodeEncodeOk,
  type BarcodeEncodeErr,
  type BarcodeEncodeResult,
  type BarcodeTextAnchor,
} from "./encoder";
export {
  barcodeToSvg,
  barcodeToPngDataUrl,
  barGeometry,
  type BarcodeRenderOptions,
} from "./render";
