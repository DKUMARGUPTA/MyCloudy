import { encodeBarcode } from "../../src/lib/own/barcode/index";
const r = encodeBarcode("code39", "DOCOPDF-42");
if (!r.ok) { console.log("FAIL"); process.exit(1); }
let bin = "";
r.elements.forEach((w: number, i: number) => { bin += (i % 2 === 0 ? "1" : "0").repeat(w); });
console.log(bin);
