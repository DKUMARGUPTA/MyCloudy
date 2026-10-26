/**
 * DocoPDF own QR engine — public API (surface-compatible with the parts
 * of the `qrcode` package this app uses): create / toDataURL / toString.
 * PNG encoding rides our own zlib; SVG is generated directly.
 */

export { createMatrix, type BitMatrix, type EccLevel } from "./encoder";
export { create, toDataURL, toSVGString, type QrRenderOptions } from "./render";

import { toSVGString, type QrRenderOptions } from "./render";

/** `qrcode`-compatible toString for type "svg". */
export async function toString(
  payload: string,
  opts: QrRenderOptions & { type?: string } = {}
): Promise<string> {
  if (opts.type && opts.type !== "svg") {
    throw new Error(`qr: unsupported toString type "${opts.type}"`);
  }
  const { type: _t, ...rest } = opts;
  void _t;
  return toSVGString(payload, rest);
}
