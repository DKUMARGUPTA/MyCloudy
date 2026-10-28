/**
 * Probe: pdf-lib's EXACT content-stream operators for the html-to-pdf
 * surface we must mirror on the own engine (P6-n):
 *   1. drawSvgPath(roundedRectPath(483.28, 58, 6), {x:56, y:742, color, borderColor, borderWidth})
 *   2. drawSvgPath(path, {x, y, color})            — fill only
 *   3. drawLine({start, end, thickness, color, dashArray: [3, 2]})
 */
import { PDFDocument, rgb } from "pdf-lib";
import { inflateSync } from "node:zlib";

const DOC = await PDFDocument.create();
const PAGE = DOC.addPage([595.28, 841.89]);

function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  const W = String(Math.round(w * 1000) / 1000);
  const H = String(Math.round(h * 1000) / 1000);
  const R = String(Math.round(rr * 1000) / 1000);
  const WmR = String(Math.round((w - rr) * 1000) / 1000);
  const HmR = String(Math.round((h - rr) * 1000) / 1000);
  return [
    `M ${R} 0`,
    `L ${WmR} 0`,
    `A ${R} ${R} 0 0 1 ${W} ${R}`,
    `L ${W} ${HmR}`,
    `A ${R} ${R} 0 0 1 ${WmR} ${H}`,
    `L ${R} ${H}`,
    `A ${R} ${R} 0 0 1 0 ${HmR}`,
    `L 0 ${R}`,
    `A ${R} ${R} 0 0 1 ${R} 0`,
    "Z",
  ].join(" ");
}

PAGE.drawSvgPath(roundedRectPath(483.28, 58, 6), {
  x: 56,
  y: 742,
  color: rgb(1, 0.953, 0.804),
  borderColor: rgb(0.941, 0.678, 0.306),
  borderWidth: 1.5,
});
PAGE.drawSvgPath(roundedRectPath(100, 40, 5), { x: 56, y: 640, color: rgb(1, 0.953, 0.804) });
PAGE.drawLine({
  start: { x: 56, y: 620 },
  end: { x: 539, y: 620 },
  thickness: 3,
  color: rgb(0.2, 0.478, 0.722),
  dashArray: [3, 2],
});

const BYTES = await DOC.save({ useObjectStreams: false });
const RAW = Buffer.from(BYTES).toString("latin1");
// extract page 1 content stream raw
const S = RAW.indexOf("stream");
let start = S + 6;
if (RAW[start] === "\r") start++;
if (RAW[start] === "\n") start++;
const E = RAW.indexOf("endstream", start);
let stream = RAW.slice(start, E);
try {
  stream = inflateSync(Buffer.from(stream, "latin1")).toString("latin1");
} catch {
  /* raw */
}
console.log("=== PAGE OPS ===");
console.log(stream);
