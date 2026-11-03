import { encodeBarcode, barcodeToSvg } from "../../src/lib/own/barcode/index";
const r = encodeBarcode("code128", "DocoPDF-2025");
if (!r.ok) { console.log("ENCODE FAIL"); process.exit(1); }
const svg = barcodeToSvg(r, { height: 90, modulePx: 3, showText: true });
console.log(svg.slice(0, 400));
console.log("...");
console.log("len:", svg.length);
// XML well-formedness quick check
const open = (svg.match(/</g) || []).length;
const close = (svg.match(/>/g) || []).length;
console.log("tags:", open, close);
