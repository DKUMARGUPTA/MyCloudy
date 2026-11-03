import { encodeBarcode, barcodeToPngDataUrl, barcodeToSvg } from "../../src/lib/own/barcode/index";
const r = encodeBarcode("ean13", "400638133393");
if (!r.ok) { console.log("ENCODE FAIL"); process.exit(1); }
try {
  const url = barcodeToPngDataUrl(r, { height: 90, modulePx: 3 });
  console.log("PNG data URL ok, len:", url.length, "| prefix:", url.slice(0, 30));
  console.log("base64 head:", url.slice(22, 60));
} catch (e) {
  console.log("PNG FAIL:", (e as Error).message);
  console.log((e as Error).stack?.split("\n").slice(0, 5).join("\n"));
}
try {
  const svg = barcodeToSvg(r, { height: 90, modulePx: 3 });
  console.log("SVG ok, len:", svg.length);
} catch (e) {
  console.log("SVG FAIL:", (e as Error).message);
}
