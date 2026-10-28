/**
 * P6-n engine verification: our drawRoundedRectangle + drawLine(dashArray)
 * vs the probed pdf-lib drawSvgPath/drawLine operator sequences.
 * (Companion probe: scripts/dev/probe-svgpath-ops.ts)
 */
import { CreateContext } from "../../src/lib/own/pdf";

const ctx = CreateContext.create();
const page = ctx.addPage(595.28, 841.89);

page.drawRoundedRectangle({
  x: 56,
  yTop: 742,
  width: 483.28,
  height: 58,
  radius: 6,
  color: { r: 1, g: 0.953, b: 0.804 },
  borderColor: { r: 0.941, g: 0.678, b: 0.306 },
  borderWidth: 1.5,
});
page.drawRoundedRectangle({
  x: 56,
  yTop: 640,
  width: 100,
  height: 40,
  radius: 5,
  color: { r: 1, g: 0.953, b: 0.804 },
});
page.drawLine({
  start: { x: 56, y: 620 },
  end: { x: 539, y: 620 },
  thickness: 3,
  color: { r: 0.2, g: 0.478, b: 0.722 },
  dashArray: [3, 2],
});
// insertPage + getPages smoke
const p2 = ctx.insertPage(1, 612, 792);
p2.drawText({ x: 10, y: 700, text: "inserted", size: 12, font: "helvetica" });
const pages = ctx.getPages();
console.log("pages after insert:", pages.length, "p[0] size:", pages[0].width, pages[0].height, "p[1] size:", pages[1].width, pages[1].height);

const bytes = ctx.write();
const raw = Buffer.from(bytes).toString("latin1");
const s = raw.indexOf("stream");
let start = s + 6;
if (raw[start] === "\r") start++;
if (raw[start] === "\n") start++;
const e = raw.indexOf("endstream", start);
console.log("=== OWN ENGINE PAGE 1 OPS ===");
console.log(raw.slice(start, e));
