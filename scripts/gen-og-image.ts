/**
 * P7-SEO — OG/social-card generator (1200×630).
 *
 * Renders the DocoPDF brand card with sharp: deep-navy backdrop, the
 * blue→orange brand gradient on the wordmark, and the three privacy
 * differentiators that make the product stand out in link previews
 * (WhatsApp/Twitter/LinkedIn all render this image).
 *
 * Run: bun scripts/gen-og-image.ts  →  public/og-image.png
 */
import { writeFile } from "node:fs/promises";

import sharp from "sharp";

const W = 1200;
const H = 630;

const SVG = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563EB"/>
      <stop offset="1" stop-color="#F97316"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563EB" stop-opacity="0.35"/>
      <stop offset="0.6" stop-color="#0B1220" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2563EB"/>
      <stop offset="1" stop-color="#F97316"/>
    </linearGradient>
  </defs>

  <!-- deep navy backdrop (matches the dark theme surface) -->
  <rect width="${W}" height="${H}" fill="#0B1220"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- gradient top edge -->
  <rect x="0" y="0" width="${W}" height="10" fill="url(#edge)"/>

  <!-- brand mark: rounded square + document glyph -->
  <g transform="translate(96,120)">
    <rect width="132" height="132" rx="30" fill="url(#brand)"/>
    <path d="M42 30 h34 l24 24 v54 a8 8 0 0 1 -8 8 h-50 a8 8 0 0 1 -8 -8 v-70 a8 8 0 0 1 8 -8 z"
          fill="#FFFFFF" fill-opacity="0.96"/>
    <path d="M76 30 l24 24 h-24 z" fill="#0B1220" fill-opacity="0.25"/>
    <text x="66" y="88" font-family="DejaVu Sans" font-weight="bold"
          font-size="30" fill="#2563EB" text-anchor="middle">PDF</text>
  </g>

  <!-- wordmark -->
  <text x="96" y="360" font-family="DejaVu Sans" font-weight="bold"
        font-size="104" fill="#FFFFFF" letter-spacing="-2">Doco<tspan fill="#F97316">PDF</tspan></text>

  <!-- tagline -->
  <text x="96" y="424" font-family="DejaVu Sans" font-weight="bold"
        font-size="42" fill="#E2E8F0">100 Free Online PDF Tools</text>

  <!-- differentiator chips -->
  <g font-family="DejaVu Sans" font-size="27" font-weight="bold">
    <rect x="96" y="466" width="252" height="52" rx="26" fill="#FFFFFF" fill-opacity="0.08"/>
    <text x="222" y="501" fill="#CBD5E1" text-anchor="middle">No Signup</text>
    <rect x="364" y="466" width="300" height="52" rx="26" fill="#FFFFFF" fill-opacity="0.08"/>
    <text x="514" y="501" fill="#CBD5E1" text-anchor="middle">No Watermark</text>
    <rect x="680" y="466" width="486" height="52" rx="26" fill="#FFFFFF" fill-opacity="0.08"/>
    <text x="923" y="501" fill="#CBD5E1" text-anchor="middle">Files Stay On Your Device</text>
  </g>

  <!-- domain -->
  <text x="96" y="580" font-family="DejaVu Sans" font-size="26" fill="#64748B">docopdf.com</text>
</svg>`;

const png = await sharp(Buffer.from(SVG)).png({ compressionLevel: 9 }).toBuffer();
await writeFile("public/og-image.png", png);
console.log(`✓ public/og-image.png (${(png.length / 1024).toFixed(1)} KB, ${W}×${H})`);
