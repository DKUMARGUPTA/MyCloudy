/**
 * Sign PDF — client-side raster helpers (canvas only, no DOM tree).
 *
 * Everything a signature needs to become a transparent PNG data URL:
 * the self-hosted script fonts (Great Vibes / Dancing Script / Caveat /
 * Homemade Apple / Kalam incl. Devanagari), typed-text rendering with
 * tight ink-box trimming, the checkmark stamp, ink trimming for the draw
 * pad, and white-background removal for uploads. All of it runs on the
 * main thread (small, instant) and never touches the network — the font
 * files ship from /public/fonts/sign (OFL-licensed, same policy as the
 * Devanagari stamp font).
 */

export interface SignatureFont {
  id: string;
  css: string;
  label: string;
  hindi: boolean;
}

export const SIGN_FONTS: readonly SignatureFont[] = [
  { id: "greatvibes", css: "Great Vibes", label: "Great Vibes", hindi: false },
  { id: "dancingscript", css: "Dancing Script", label: "Dancing Script", hindi: false },
  { id: "caveat", css: "Caveat", label: "Caveat", hindi: false },
  { id: "homemadeapple", css: "Homemade Apple", label: "Homemade Apple", hindi: false },
  { id: "kalam", css: "Kalam", label: "Kalam (हिंदी)", hindi: true },
];

/** Ink colors offered in draw + type + stamp editors. */
export const SIGN_INKS: readonly string[] = ["#111827", "#1e3a5f", "#1d4ed8"];

interface FontDef {
  family: string;
  url: string;
  unicodeRange?: string;
}

const FONT_DEFS: readonly FontDef[] = [
  {
    family: "Great Vibes",
    url: "/fonts/sign/greatvibes-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    family: "Dancing Script",
    url: "/fonts/sign/dancingscript-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    family: "Caveat",
    url: "/fonts/sign/caveat-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    family: "Homemade Apple",
    url: "/fonts/sign/homemadeapple-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    family: "Kalam",
    url: "/fonts/sign/kalam-devanagari.woff2",
    unicodeRange:
      "U+0900-097F, U+1CD0-1CF4, U+1CF7-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B0A",
  },
  {
    family: "Kalam",
    url: "/fonts/sign/kalam-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
];

let fontsPromise: Promise<void> | null = null;

/**
 * Lazily registers the signature fonts (once per page load, only when the
 * sign tool actually needs them — the ~295 KB never load otherwise).
 */
export function loadSignFonts(): Promise<void> {
  if (fontsPromise !== null) return fontsPromise;
  fontsPromise = (async () => {
    await Promise.all(
      FONT_DEFS.map(async (def) => {
        try {
          const face = new FontFace(
            def.family,
            `url(${def.url})`,
            def.unicodeRange !== undefined ? { unicodeRange: def.unicodeRange } : {}
          );
          await face.load();
          document.fonts.add(face);
        } catch {
          // A missing font file degrades to the next family — never fatal.
        }
      })
    );
  })();
  return fontsPromise;
}

/** Is the font family ready for canvas measure/draw right now? */
export async function ensureSignFont(css: string): Promise<void> {
  try {
    await document.fonts.load(`64px "${css}"`);
  } catch {
    // Ignore — measureText falls back to the generic cursive/serif.
  }
}

/**
 * Renders text into a tightly trimmed transparent PNG (typed signatures
 * and quick text stamps share this). Returns the data URL + pixel size.
 */
export async function renderTextSignature(
  text: string,
  fontFamily: string,
  color: string,
  fontSize = 96
): Promise<{ dataUrl: string; w: number; h: number }> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 60);
  await ensureSignFont(fontFamily);
  const probe = document.createElement("canvas").getContext("2d");
  if (probe === null || clean.length === 0) {
    return { dataUrl: transparentPng(), w: 1, h: 1 };
  }
  probe.font = `${fontSize}px "${fontFamily}", cursive`;
  const m = probe.measureText(clean);
  const ascent =
    typeof m.actualBoundingBoxAscent === "number" && m.actualBoundingBoxAscent > 0
      ? m.actualBoundingBoxAscent
      : fontSize * 0.9;
  const descent =
    typeof m.actualBoundingBoxDescent === "number" && m.actualBoundingBoxDescent > 0
      ? m.actualBoundingBoxDescent
      : fontSize * 0.35;
  const width = m.width > 0 ? m.width : fontSize * clean.length * 0.4;
  const pad = Math.round(fontSize * 0.18);
  const w = Math.ceil(width) + pad * 2;
  const h = Math.ceil(ascent + descent) + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.min(w, 2400);
  canvas.height = Math.min(h, 800);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return { dataUrl: transparentPng(), w: 1, h: 1 };
  ctx.font = `${fontSize}px "${fontFamily}", cursive`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(clean, pad, pad + ascent);
  return { dataUrl: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height };
}

/** The checkmark quick stamp: a confident single-stroke ✓. */
export function renderCheckmark(color: string): { dataUrl: string; w: number; h: number } {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return { dataUrl: transparentPng(), w: 1, h: 1 };
  ctx.strokeStyle = color;
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(size * 0.18, size * 0.54);
  ctx.quadraticCurveTo(size * 0.4, size * 0.78, size * 0.44, size * 0.8);
  ctx.quadraticCurveTo(size * 0.6, size * 0.44, size * 0.86, size * 0.16);
  ctx.stroke();
  return { dataUrl: canvas.toDataURL("image/png"), w: size, h: size };
}

/**
 * Trims an alpha canvas to its ink bounding box (+ padding) and downsizes
 * very wide results — keeps stored signatures small and perfectly centered.
 */
export function trimCanvasToInk(
  canvas: HTMLCanvasElement,
  opts: { pad?: number; maxW?: number } = {}
): HTMLCanvasElement {
  const pad = opts.pad ?? 12;
  const maxW = opts.maxW ?? 720;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null || canvas.width === 0 || canvas.height === 0) return canvas;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return canvas; // blank — keep as-is
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const scale = Math.min(1, maxW / boxW);
  const outW = Math.max(1, Math.round((boxW + pad * 2) * scale));
  const outH = Math.max(1, Math.round((boxH + pad * 2) * scale));
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  if (octx === null) return canvas;
  octx.drawImage(
    canvas,
    minX - pad,
    minY - pad,
    boxW + pad * 2,
    boxH + pad * 2,
    0,
    0,
    outW,
    outH
  );
  return out;
}

/**
 * Removes a near-white background from an uploaded signature photo/scan:
 * pixels within `tolerance` of the sampled corner color get alpha-faded
 * (soft edges survive), everything else is kept as ink. Ink already
 * transparent stays transparent.
 */
export function removeWhiteBackground(
  canvas: HTMLCanvasElement,
  tolerance = 46
): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  if (width === 0 || height === 0) return;
  // Sample the four corners — the paper color.
  const idx = (x: number, y: number): number => (y * width + x) * 4;
  const corners = [
    idx(1, 1),
    idx(width - 2, 1),
    idx(1, height - 2),
    idx(width - 2, height - 2),
  ];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const c of corners) {
    br += data[c];
    bg += data[c + 1];
    bb += data[c + 2];
  }
  br /= 4;
  bg /= 4;
  bb /= 4;
  // Only proceed when the background is actually light (paper/scan).
  if (br < 170 || bg < 170 || bb < 170) return;
  const t2 = tolerance * tolerance;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    const dist2 = dr * dr + dg * dg + db * db;
    if (dist2 <= t2) {
      data[i + 3] = 0;
    } else if (dist2 < t2 * 4) {
      // Soft ramp for antialiased edges.
      const k = (dist2 - t2) / (t2 * 3);
      data[i + 3] = Math.round(data[i + 3] * Math.min(1, k * 1.6));
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Decodes an uploaded image → canvas (alpha preserved, downsized). */
export async function imageFileToCanvas(
  file: File,
  maxDim = 1200
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function transparentPng(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
}
