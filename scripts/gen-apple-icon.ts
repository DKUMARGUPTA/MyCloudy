/**
 * Generate public/apple-touch-icon.png from public/logo.svg (iOS Safari
 * ignores SVG for the home-screen icon; it needs a 180x180 PNG, and
 * transparency renders as ugly black — so composite onto the light brand
 * surface color).
 *
 * Run: bun scripts/gen-apple-icon.ts
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const SIZE = 180;

const svg = readFileSync("public/logo.svg", "utf8");

const png = await sharp(Buffer.from(svg), { density: 400 })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: SIZE,
    height: SIZE,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite([{ input: png, gravity: "center" }])
  .png()
  .toFile("public/apple-touch-icon.png");

const meta = await sharp("public/apple-touch-icon.png").metadata();
console.log(
  `apple-touch-icon.png written: ${meta.width}x${meta.height} (${readFileSync("public/apple-touch-icon.png").byteLength} bytes)`
);
