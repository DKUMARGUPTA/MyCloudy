/**
 * SVG page emitter for pdf-to-svg (B5-b) — a standalone .svg per PDF page.
 *
 * Clean-room, pure TypeScript, zero dependencies — Bun-smokeable and
 * worker-safe (no DOM globals touched at module scope; btoa exists in
 * workers but not in Bun, so the base64 below is a byte-safe local
 * encoder that runs identically in both).
 *
 * What this deliberately IS (honest copy, mirrored in config.ts): each
 * page becomes a high-resolution PNG raster embedded in a scalable SVG
 * shell. The <svg> carries the PDF page size in POINTS — the viewport
 * at scale 1 — in width/height AND viewBox, while the embedded raster
 * carries the user's chosen DPI. So the file scales cleanly in any
 * design tool or browser and sits at true page dimensions, but the page
 * content itself is a raster: this is NOT a true vector-outline
 * conversion (no editable paths/text — the tool copy says so).
 *
 * Layout of the emitted document:
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <svg xmlns="http://www.w3.org/2000/svg"
 *        xmlns:xlink="http://www.w3.org/1999/xlink"
 *        width="{W}pt" height="{H}pt" viewBox="0 0 {W} {H}">
 *     <image width="{W}pt" height="{H}pt"
 *            xlink:href="data:image/png;base64,{payload}"
 *            preserveAspectRatio="none"/>
 *   </svg>
 *
 * - {W}/{H} are the page's point dimensions, trailing zeros trimmed
 *   ("612", "595.28") — the viewBox preserves the page geometry exactly,
 *   independent of the raster's DPI.
 * - preserveAspectRatio="none" lets the raster fill the shell exactly
 *   (they are the same page, so nothing distorts; the attribute only
 *   guards against decoder rounding in the raster's own pHYs).
 * - the payload is the browser-encoded PNG (convertToBlob), verified
 *   here by its magic signature before it is embedded — the family
 *   verifies what it ships (WebP checks the MIME, TIFF checks the
 *   magic, SVG checks the embedded PNG magic).
 */

/** PNG magic signature (8 bytes) — the only input contract encodeSvgPage makes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** RFC 4648 base64 alphabet (+ /), padding "=" — standard, no URL-safe variants. */
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Byte-safe base64 (RFC 4648) of a Uint8Array — works identically under
 * Bun and inside Web Workers (no btoa dependency). Full 3-byte groups
 * are emitted inline; the final 1-2 bytes get "=" / "==" padding.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * Format a point dimension for the SVG attributes: trim float noise to
 * 4 decimals, then let String() drop trailing zeros ("612" not "612.0",
 * "595.28" not "595.2800"). Non-finite or non-positive sizes are a
 * caller bug — refuse them loudly.
 */
function formatPt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("svg-bad-size");
  }
  return String(Math.round(value * 10000) / 10000);
}

/**
 * Wrap one PNG-encoded PDF page in its standalone SVG shell.
 *
 * @param pngBytes  the page raster as PNG bytes (browser: OffscreenCanvas
 *                 convertToBlob; must start with the PNG signature)
 * @param widthPt  the PDF page width in POINTS — `page.getViewport({
 *                 scale: 1 }).width`, NOT the DPI-scaled render viewport
 * @param heightPt the PDF page height in POINTS
 * @returns the complete .svg document as a UTF-8 string
 * @throws "svg-bad-png"  if the payload is not a PNG (magic mismatch)
 * @throws "svg-bad-size" if a point dimension is non-finite or ≤ 0
 */
export function encodeSvgPage(
  pngBytes: Uint8Array,
  widthPt: number,
  heightPt: number
): string {
  if (pngBytes.length < 8) {
    throw new Error("svg-bad-png");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("svg-bad-png");
    }
  }
  const w = formatPt(widthPt);
  const h = formatPt(heightPt);
  const payload = bytesToBase64(pngBytes);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">` +
    `<image width="${w}pt" height="${h}pt" ` +
    `xlink:href="data:image/png;base64,${payload}" ` +
    `preserveAspectRatio="none"/>` +
    `</svg>`
  );
}
