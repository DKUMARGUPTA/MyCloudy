/** Quick probe: verify the excel-to-pdf output content-stream op format. */
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";

import type { OptionValues } from "../src/lib/tools/config-types";
import { buildXlsxBytes } from "../tools/pdf-to-excel/xlsx-emit";
import {
  runExcelToPdf,
  type LoadExcelFonts,
  type ExcelFontSet,
} from "../tools/excel-to-pdf/worker";
import {
  parseXlsxBytes,
} from "../tools/excel-to-pdf/xlsx-parse";

const ttfBytes = new Uint8Array(
  await readFile("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf")
);

const loadSmokeFonts: LoadExcelFonts = async (doc, needNoto) => {
  if (needNoto) doc.registerFontkit(fontkit);
  const helv = doc.embedStandardFont(StandardFonts.Helvetica);
  const helvBold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const noto = needNoto ? await doc.embedFont(ttfBytes, { subset: true }) : null;
  const fontFor = (spec: { bold: boolean }, script: string) => {
    if (script === "noto" && noto) return noto;
    return spec.bold ? helvBold : helv;
  };
  const set: ExcelFontSet = {
    helv,
    helvBold,
    noto,
    fontFor: fontFor as ExcelFontSet["fontFor"],
    measure: (text, spec, size, script) =>
      fontFor(spec, script).widthOfTextAtSize(text, size),
  };
  return set;
};

const rows = [
  ["Name", "Quantity", "Price"],
  ["Widget", "12", "99.50"],
  ["Gadget", "5", "249.00"],
];
const xlsx = buildXlsxBytes(rows, true);
const parsed = parseXlsxBytes(xlsx);
console.log("sheets:", parsed.sheets.map((s) => s.name));
console.log("rows:", JSON.stringify(parsed.sheets[0]?.rows));
console.log("charCount:", parsed.charCount);

const doc = await PDFDocument.create();
const result = await runExcelToPdf(xlsx, {} as OptionValues, loadSmokeFonts);
console.log("pages:", result.pages, "bytes:", result.bytes.length);

const buf = Buffer.from(result.bytes);
const latin = buf.toString("latin1");
let idx = 0;
let count = 0;
while (count < 3) {
  const st = latin.indexOf("stream", idx);
  if (st === -1) break;
  const en = latin.indexOf("endstream", st);
  if (en === -1) break;
  let start = st + 6;
  while (start < en && (buf[start] === 13 || buf[start] === 10)) start += 1;
  let end = en;
  while (end > start && (buf[end - 1] === 13 || buf[end - 1] === 10)) end -= 1;
  try {
    const out = inflateSync(buf.subarray(start, end)).toString("latin1");
    console.log(`--- stream at ${st} (inflated ${out.length} chars) ---`);
    console.log(out.slice(0, 1200));
  } catch {
    console.log(`--- stream at ${st} NOT ZLIB (${end - start} bytes) ---`);
  }
  idx = en + 9;
  count += 1;
}
console.log("raw contains Helvetica-Bold:", latin.includes("Helvetica-Bold"));
console.log("raw contains FontFile:", latin.includes("FontFile"));
process.exit(0);
