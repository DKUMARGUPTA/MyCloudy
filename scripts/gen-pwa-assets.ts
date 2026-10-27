/**
 * P7-PWA — one-shot PWA asset generator.
 *
 * Renders the exact Sidocs brand mark (src/components/sidocs/logo.tsx
 * LogoMark — blue→orange gradient rounded square + white document + "PDF")
 * into every icon format a PWA needs. Run with bun:
 *
 *   bun scripts/gen-pwa-assets.ts
 *
 * Outputs (all under public/):
 *   icons/icon-192.png            192×192  purpose "any"    (transparent corners)
 *   icons/icon-512.png            512×512  purpose "any"
 *   icons/maskable-192.png        192×192  purpose "maskable" (full-bleed, safe zone)
 *   icons/maskable-512.png        512×512  purpose "maskable"
 *   icons/apple-touch-icon.png    180×180  iOS home screen (full-bleed, no alpha)
 *   favicon.ico                   16+32 px PNG-in-ICO container
 *
 * Font note: the SVG <text> uses DejaVu Sans Bold — the only grotesque
 * sans available to fontconfig in this sandbox; at icon sizes it is
 * visually indistinguishable from Inter.
 */
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const OUT = "public/icons";

const GRADIENT = `
  <defs>
    <linearGradient id="g" x1="X1" y1="Y1" x2="X2" y2="Y2" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2563EB"/>
      <stop offset="1" stop-color="#F97316"/>
    </linearGradient>
  </defs>`;

/** The LogoMark document glyph (paths verbatim from logo.tsx). */
const DOC_GLYPH = `
  <path d="M11.5 7.5h6.3l4.7 4.7V23a1.8 1.8 0 0 1-1.8 1.8H11.5A1.8 1.8 0 0 1 9.7 23V9.3a1.8 1.8 0 0 1 1.8-1.8Z" fill="#FFFFFF"/>
  <path d="M17.8 7.5l4.7 4.7h-4.7Z" fill="#BFDBFE"/>
  <text x="16.1" y="20.6" text-anchor="middle" font-size="6.6" font-weight="700" fill="#1D4ED8" font-family="DejaVu Sans, sans-serif">PDF</text>`;

/** Regular "any" icon: rounded-square mark with transparent corners (2/32 inset). */
function regularSvg(size: number, withText = true): Buffer {
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  ${GRADIENT.replace(/X1/g, "2").replace(/Y1/g, "2").replace(/X2/g, "30").replace(/Y2/g, "30")}
  <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#g)"/>
  ${withText ? DOC_GLYPH : DOC_GLYPH.replace(/<text[\s\S]*?<\/text>/, "")}
</svg>`);
}

/**
 * Full-bleed icon (maskable / apple): gradient fills the whole canvas,
 * glyph scaled into the platform safe zone.
 */
function fullBleedSvg(size: number, scale: number): Buffer {
  const t = ((32 - 32 * scale) / 2).toFixed(2);
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  ${GRADIENT.replace(/X1/g, "0").replace(/Y1/g, "0").replace(/X2/g, "32").replace(/Y2/g, "32")}
  <rect x="0" y="0" width="32" height="32" fill="url(#g)"/>
  <g transform="translate(${t} ${t}) scale(${scale})">${DOC_GLYPH}</g>
</svg>`);
}

async function png(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg).resize(size, size).png().toBuffer();
}

/** Minimal ICO container holding PNG entries (supported by all modern browsers). */
function buildIco(entries: { width: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const base = i * 16;
    dir.writeUInt8(e.width, base);
    dir.writeUInt8(e.width, base + 1); // square
    dir.writeUInt8(0, base + 2); // colors
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(e.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const jobs: [string, Buffer][] = [
    ["icon-192.png", await png(regularSvg(192), 192)],
    ["icon-512.png", await png(regularSvg(512), 512)],
    ["icon-1024.png", await png(regularSvg(1024), 1024)],
    // Maskable: glyph at 68% (well inside the 80% safe-zone circle).
    ["maskable-192.png", await png(fullBleedSvg(192, 0.68), 192)],
    ["maskable-512.png", await png(fullBleedSvg(512, 0.68), 512)],
    // Apple: full-bleed, glyph at 72%.
    ["apple-touch-icon.png", await png(fullBleedSvg(180, 0.72), 180)],
  ];

  for (const [name, data] of jobs) {
    await writeFile(`${OUT}/${name}`, data);
    console.log(`✓ ${OUT}/${name} (${(data.length / 1024).toFixed(1)} KB)`);
  }

  const ico = buildIco([
    { width: 16, data: await png(regularSvg(32, false), 16) },
    { width: 32, data: await png(regularSvg(32), 32) },
  ]);
  await writeFile("public/favicon.ico", ico);
  console.log(`✓ public/favicon.ico (${(ico.length / 1024).toFixed(1)} KB)`);

  // Sanity: report real decoded dimensions.
  for (const name of ["icon-512.png", "maskable-512.png", "apple-touch-icon.png"]) {
    const meta = await sharp(`${OUT}/${name}`).metadata();
    console.log(`  ${name}: ${meta.width}×${meta.height} ${meta.format}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
