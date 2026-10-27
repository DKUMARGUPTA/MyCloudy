/**
 * TEMP probe 3 — verify model fixes end-to-end on the real planned fixture
 * (raw Hindi strings, repaired SVG output, rotated page, image transform).
 */
import "regenerator-runtime/runtime";
import { PDFDocument, StandardFonts, rgb, degrees, rectangle, fill, pushGraphicsState, popGraphicsState } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pngEncode } from "./tools/imgconv/png-encode";

import {
  buildPageSvg,
  opsTable,
  toFontInfo,
  type SvgImagePayload,
} from "./tools/pdf-to-svg/model";

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

  const p1 = doc.addPage([612, 792]);
  p1.drawText("Vector Export Fixture", { x: 72, y: 720, size: 22, font: bold });
  p1.drawText("Body text in a calm blue.", { x: 72, y: 690, size: 11, font: helv, color: rgb(0.2, 0.4, 0.6) });
  p1.drawText("Plain start, then", { x: 72, y: 660, size: 11, font: helv });
  p1.drawText("bold middle,", { x: 160, y: 660, size: 11, font: bold });
  p1.drawText("italic tail.", { x: 250, y: 660, size: 11, font: ital });
  p1.drawText("Escaped: a & b, 5 < 6, 7 > 3, \"quoted\".", { x: 72, y: 620, size: 11, font: helv });
  p1.drawRectangle({ x: 72, y: 500, width: 200, height: 80, color: rgb(0.9, 0.9, 0.95) });
  p1.drawLine({ start: { x: 72, y: 460 }, end: { x: 300, y: 460 }, thickness: 2 });
  p1.pushOperators(pushGraphicsState(), rectangle(400, 460, 120, 50), fill(), popGraphicsState());
  p1.drawText("Bottom label after shapes.", { x: 72, y: 100, size: 10, font: helv });

  const p2 = doc.addPage([612, 792]);
  p2.drawText("त्रैमासिक रिपोर्ट", { x: 72, y: 720, size: 22, font: noto });
  p2.drawText("प्रिया शर्मा की टीम", { x: 72, y: 680, size: 14, font: noto });
  p2.drawText("यह रिपोर्ट आपके डिवाइस पर बनती है।", { x: 72, y: 640, size: 11, font: noto });

  const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
  const png = new Uint8Array(await (await pngEncode({ width: 2, height: 2, data })).arrayBuffer());
  const img = await doc.embedPng(png);
  const p3 = doc.addPage([612, 792]);
  p3.drawText("Photo page", { x: 72, y: 700, size: 12, font: helv });
  p3.drawImage(img, { x: 72, y: 200, width: 120, height: 60 });

  const p4 = doc.addPage([612, 792]);
  p4.setRotation(degrees(90));
  p4.drawText("Rotated page text", { x: 72, y: 700, size: 12, font: helv });

  return new Uint8Array(await doc.save());
}

interface ObjsPool { get(objId: string, callback: (data: unknown) => void): null; }
function resolveObj(pool: ObjsPool, objId: string): Promise<unknown> {
  return new Promise((resolve) => { pool.get(objId, (d) => resolve(d)); });
}
function poolFor(page: { objs: ObjsPool; commonObjs: ObjsPool }, objId: string): ObjsPool {
  return objId.startsWith("g_") ? page.commonObjs : page.objs;
}

const fixture = await buildFixture();
const task = getDocument({ data: fixture.slice(), useSystemFonts: true });
const pdf = await task.promise;
const ops = opsTable(OPS as unknown as Record<string, unknown>);

for (let number = 1; number <= pdf.numPages; number += 1) {
  const page: any = await pdf.getPage(number);
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  // raw Hindi unicode from showText args
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    if (opList.fnArray[i] === OPS.showText) {
      const glyphs = opList.argsArray[i][0] as { unicode?: string }[];
      const joined = glyphs.map((g) => g.unicode ?? "").join("");
      if (/[\u0900-\u097F]/.test(joined)) console.log(`p${number} RAW:`, JSON.stringify(joined));
    }
  }
  const ctx = {
    width: viewport.width,
    height: viewport.height,
    baseTransform: viewport.transform,
    includeImages: true,
    resolveFont: (ref: unknown) =>
      typeof ref === "string" && ref !== ""
        ? resolveObj(poolFor(page, ref), ref).then(toFontInfo)
        : Promise.resolve(null),
    resolveImage: (objId: unknown): Promise<SvgImagePayload | null> => {
      if (typeof objId !== "string" || objId === "") return Promise.resolve(null);
      return resolveObj(poolFor(page, objId), objId).then((raw): SvgImagePayload | null => {
        if (raw === null || typeof raw !== "object") return null;
        const obj = raw as { width?: unknown; height?: unknown; kind?: unknown; data?: unknown };
        if (typeof obj.width !== "number" || typeof obj.height !== "number") return null;
        const d = obj.data;
        if (!(d instanceof Uint8Array) && !(d instanceof Uint8ClampedArray)) return null;
        return { width: obj.width, height: obj.height, kind: typeof obj.kind === "number" ? obj.kind : 0, data: d };
      });
    },
  };
  const { svg, stats } = await buildPageSvg(ops, opList, ctx);
  console.log(`\n=== PAGE ${number} (${viewport.width}x${viewport.height}) stats:`, JSON.stringify(stats));
  console.log(svg.split("\n").slice(0, 26).join("\n"));
  const m = svg.match(/<image[^>]*>/);
  if (m) console.log("IMAGE:", m[0].slice(0, 220));
  await page.cleanup();
}
await pdf.cleanup();
await task.destroy();
