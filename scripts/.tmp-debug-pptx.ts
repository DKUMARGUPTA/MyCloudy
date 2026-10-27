/** TEMP debug script — deleted after use. */
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  buildPptxBytes,
  type PptxPageImage,
} from "../tools/pdf-to-powerpoint/pptx-emit";
import { parsePptxBytes } from "../tools/powerpoint-to-pdf/pptx-parse";
import { runPptxToPdf } from "../tools/powerpoint-to-pdf/worker";
import type { FontSpec, ScriptFont } from "../tools/txt-to-pdf/text-layout";

const TTF_PATH = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf";
const ttfBytes = new Uint8Array(await readFile(TTF_PATH));

const loadSmokeFonts = async (doc: PDFDocument, needNoto: boolean) => {
  if (needNoto) doc.registerFontkit(fontkit);
  const helv = doc.embedStandardFont(StandardFonts.Helvetica);
  const helvBold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const noto = needNoto ? await doc.embedFont(ttfBytes, { subset: true }) : null;
  const fontFor = (spec: FontSpec, script: ScriptFont) => {
    if (script === "noto" && noto) return noto;
    return spec.bold ? helvBold : helv;
  };
  return {
    helv,
    helvBold,
    noto,
    fontFor,
    measure: (text: string, spec: FontSpec, size: number, script: ScriptFont) =>
      fontFor(spec, script).widthOfTextAtSize(text, size),
  };
};

const fixtureBytes = new Uint8Array(
  await readFile("/home/z/my-project/download/smoke-powerpoint-to-pdf-fixture.pptx")
);

/* 1. Parsed rects */
{
  const parsed = parsePptxBytes(fixtureBytes.slice());
  parsed.slides.forEach((slide, i) => {
    console.log(`--- slide ${i + 1} ---`);
    for (const s of slide.shapes) {
      console.log(
        s.kind,
        JSON.stringify({ x: s.x, y: s.y, w: s.width, h: s.height }),
        s.kind === "pic" ? `${s.mediaPath} ${s.mediaKind}` : ""
      );
      if (s.kind === "text") {
        for (const p of s.paragraphs) {
          console.log("   para:", JSON.stringify(p.runs));
        }
      }
    }
  });
}

const result = await runPptxToPdf(fixtureBytes.slice(), loadSmokeFonts);

/* 2. pdf.js items + image placements */
const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({ data: result.bytes.slice(), verbosity: 0 });
const doc = await task.promise;

for (const pageNum of [1, 2]) {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  console.log(`--- pdf.js page ${pageNum} items ---`);
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[] };
    if (!item.str || item.str.length === 0) continue;
    console.log(
      JSON.stringify(item.str),
      "size:", item.transform?.[3],
      "x:", item.transform?.[4],
      "y:", item.transform?.[5]
    );
  }
  const opList = await page.getOperatorList();
  let last: number[] | null = null;
  console.log(`--- pdf.js page ${pageNum} ops (transform/paint) ---`);
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];
    if (fn === OPS.transform) {
      last = opList.argsArray[i] as number[];
      console.log("  transform:", JSON.stringify(last));
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      console.log("  PAINT image; last transform:", JSON.stringify(last));
    } else if (fn === OPS.save || fn === OPS.restore) {
      console.log("  ", fn === OPS.save ? "save" : "restore");
    }
  }
  page.cleanup();
}

/* 3. roundtrip deck */
{
  const jpeg = (w: number, h: number, r: number, g: number, b: number) => {
    // minimal solid JPEG via canvas-free path: reuse sharp like the smoke
    return null as unknown as Uint8Array;
  };
  void jpeg;
  const sharp = (await import("sharp")).default;
  const make = async (w: number, h: number, r: number, g: number, b: number) =>
    new Uint8Array(
      await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
        .jpeg({ quality: 90 })
        .toBuffer()
    );
  const pages: PptxPageImage[] = [
    { jpeg: await make(420, 297, 51, 115, 204), widthPt: 420, heightPt: 297 },
    { jpeg: await make(596, 842, 178, 51, 77), widthPt: 595.28, heightPt: 841.89 },
  ];
  const bytes = buildPptxBytes(pages, { sourceName: "deck.pdf" });
  const parsed = parsePptxBytes(bytes.slice());
  parsed.slides.forEach((slide, i) => {
    for (const s of slide.shapes) {
      console.log(
        `rt slide ${i + 1}:`,
        s.kind,
        JSON.stringify({ x: s.x, y: s.y, w: s.width, h: s.height })
      );
    }
  });
  const rt = await runPptxToPdf(bytes.slice(), loadSmokeFonts);
  const task2 = getDocument({ data: rt.bytes.slice(), verbosity: 0 });
  const doc2 = await task2.promise;
  for (const pageNum of [1, 2]) {
    const page = await doc2.getPage(pageNum);
    const opList = await page.getOperatorList();
    let last: number[] | null = null;
    console.log(`--- rt pdf.js page ${pageNum} transforms ---`);
    for (let i = 0; i < opList.fnArray.length; i += 1) {
      const fn = opList.fnArray[i];
      if (fn === OPS.transform) {
        last = opList.argsArray[i] as number[];
        console.log("  transform:", JSON.stringify(last));
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject
      ) {
        console.log("  PAINT image; last transform:", JSON.stringify(last));
      }
    }
    page.cleanup();
  }
  await task2.destroy();
}

await task.destroy();
process.exit(0);
