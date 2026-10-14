/**
 * QA fixture for change-pdf-page-size (P4.10). Builds:
 *
 *  public/qa/qa-pagesize.pdf  — a 5-page MIXED-SIZE document:
 *    p1: A4 portrait (595.28 x 841.89)  "PAGE ONE" + center dark square +
 *        a LINK annotation (kept-page annotation-survival probe).
 *    p2: US Letter portrait (612 x 792) "PAGE TWO - LETTER" + top dark band
 *        (fill-coverage probe) + right-edge straddling square (fit-vs-fill
 *        differential pixel probe).
 *    p3: A4 with /Rotate 90 (displays 841.89 x 595.28 landscape)
 *        "PAGE THREE ROTATED" + bottom-left dark square (rotation probe).
 *    p4: custom 300 x 400 pt "PAGE FOUR - SMALL" + centered dark square +
 *        full border rect (none-mode geometry probe).
 *    p5: A5 portrait (419.53 x 595.28) "PAGE FIVE - A5" + dark square.
 *
 *  public/qa/qa-pagesize-a4.pdf — 3 pages all A4 portrait (fast-path probe:
 *        every page already at target -> the tool hands the original bytes
 *        back untouched).
 *
 * Run: bun scripts/make-pagesize-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";

const OUT_DIR = "public/qa";
const DARK = rgb(0.06, 0.06, 0.08);

async function makeMixed(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  /* ---------------- p1: A4 portrait + link annotation ---------------- */
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("PAGE ONE - PORTRAIT A4", {
    x: 50,
    y: 770,
    size: 20,
    font,
    color: DARK,
  });
  p1.drawRectangle({
    x: 247.64,
    y: 370.95,
    width: 100,
    height: 100,
    color: DARK,
  });
  p1.drawRectangle({
    x: 40,
    y: 40,
    width: 515.28,
    height: 761.89,
    borderColor: rgb(0.6, 0.6, 0.62),
    borderWidth: 1,
  });
  // Link annotation — MUST survive on kept pages (copyPages path).
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [50, 740, 320, 780],
    Border: [0, 0, 1],
    C: [0, 0, 1],
    A: {
      Type: "Action",
      S: "URI",
      URI: "https://example.com/pagesize",
    },
  });
  const annotRef = doc.context.register(annot);
  p1.node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));

  /* ---------------- p2: US Letter portrait ---------------- */
  const p2 = doc.addPage([612, 792]);
  p2.drawText("PAGE TWO - LETTER", {
    x: 50,
    y: 700,
    size: 20,
    font,
    color: DARK,
  });
  // Full-width dark band at the very top (fill-coverage probe).
  p2.drawRectangle({ x: 0, y: 752, width: 612, height: 40, color: DARK });
  // Right-edge straddling square: visible x 562..612, y 300..400.
  p2.drawRectangle({ x: 562, y: 300, width: 110, height: 100, color: DARK });

  /* ---------------- p3: A4 with /Rotate 90 ---------------- */
  const p3 = doc.addPage([595.28, 841.89]);
  p3.drawText("PAGE THREE ROTATED", {
    x: 50,
    y: 700,
    size: 20,
    font,
    color: DARK,
  });
  // Unrotated bottom-left square — displays at TOP-left under /Rotate 90.
  p3.drawRectangle({ x: 30, y: 30, width: 100, height: 100, color: DARK });
  p3.setRotation(degrees(90));

  /* ---------------- p4: custom 300 x 400 ---------------- */
  const p4 = doc.addPage([300, 400]);
  p4.drawText("PAGE FOUR - SMALL", {
    x: 30,
    y: 350,
    size: 14,
    font,
    color: DARK,
  });
  p4.drawRectangle({
    x: 2,
    y: 2,
    width: 296,
    height: 396,
    borderColor: rgb(0.6, 0.6, 0.62),
    borderWidth: 1,
  });
  p4.drawRectangle({ x: 110, y: 160, width: 80, height: 80, color: DARK });

  /* ---------------- p5: A5 portrait ---------------- */
  const p5 = doc.addPage([419.53, 595.28]);
  p5.drawText("PAGE FIVE - A5", {
    x: 40,
    y: 540,
    size: 18,
    font,
    color: DARK,
  });
  p5.drawRectangle({ x: 60, y: 200, width: 100, height: 100, color: DARK });

  return doc.save();
}

async function makeAllA4(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`ALL A4 - PAGE ${i}`, {
      x: 50,
      y: 770,
      size: 20,
      font,
      color: DARK,
    });
    page.drawRectangle({
      x: 240,
      y: 360,
      width: 110,
      height: 110,
      color: DARK,
    });
  }
  return doc.save();
}

mkdirSync(OUT_DIR, { recursive: true });
const mixed = await makeMixed();
const allA4 = await makeAllA4();
writeFileSync(`${OUT_DIR}/qa-pagesize.pdf`, mixed);
writeFileSync(`${OUT_DIR}/qa-pagesize-a4.pdf`, allA4);
console.log(
  `wrote ${OUT_DIR}/qa-pagesize.pdf (${mixed.length} B), ${OUT_DIR}/qa-pagesize-a4.pdf (${allA4.length} B)`
);
