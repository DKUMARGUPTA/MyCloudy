/**
 * R44 verification — rebuild the user's 217148.pdf scenario (900×1600 phone
 * photo on A4) with the REAL own-engine, in contain vs fill, and measure
 * the blank side bands in both. Pure CreateContext (no browser needed).
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { CreateContext } from "../src/lib/own/pdf";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 18;

function fitInto(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.min(cw / iw, ch / ih);
  return { w: iw * s, h: ih * s };
}
function coverInto(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.max(cw / iw, ch / ih);
  return { w: iw * s, h: ih * s };
}

async function build(mode: "contain" | "fill"): Promise<Uint8Array> {
  // A 900×1600 gradient photo (the user's page-1 shape).
  const jpeg = new Uint8Array(
    await sharp({
      create: { width: 900, height: 1600, channels: 3, background: "#7aa" },
    })
      .jpeg()
      .toBuffer()
  );

  const ctx = CreateContext.create();
  const page = ctx.addPage(A4[0], A4[1]);
  page.drawRectangle({
    x: 0, y: 0, width: A4[0], height: A4[1],
    color: { r: 1, g: 1, b: 1 },
  });
  const img = ctx.embedJpeg(jpeg);
  const cw = A4[0] - MARGIN * 2;
  const ch = A4[1] - MARGIN * 2;
  const box =
    mode === "fill"
      ? coverInto(900, 1600, cw, ch)
      : fitInto(900, 1600, cw, ch);
  const x = MARGIN + (cw - box.w) / 2;
  const y = MARGIN + (ch - box.h) / 2;
  page.drawImage(img, {
    x, y, width: box.w, height: box.h,
    ...(mode === "fill"
      ? { clip: { x: MARGIN, y: MARGIN, width: cw, height: ch } }
      : {}),
  });
  ctx.setProducer("DocoPDF");
  ctx.setCreator("DocoPDF");
  ctx.setTitle("r44-verify");
  return ctx.write();
}

const contain = await build("contain");
const fill = await build("fill");
writeFileSync("download/r44-contain.pdf", contain);
writeFileSync("download/r44-fill.pdf", fill);
console.log("contain bytes:", contain.length, "| fill bytes:", fill.length);
