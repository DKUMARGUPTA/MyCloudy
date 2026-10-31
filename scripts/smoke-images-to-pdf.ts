/**
 * PRE-BUILD smoke test for Images → PDF (the tools/imagegrid/worker
 * shared by images/jpg/png/webp/heic/tiff/svg-to-pdf).
 *
 * Part 1 (pure): the JPEG EXIF orientation sniffer
 * (src/lib/images/jpeg-exif.ts) — real sharp-encoded fixtures for every
 * orientation 1-8 + hand-crafted adversarial TIFF payloads (big-endian
 * "MM", APP0-JFIF before APP1, non-Exif APP1 first, truncated segments,
 * out-of-bounds IFD offsets, wrong value types, values 0 and 9, marker
 * chain ending at SOS) — every doubt path must return 1.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim PLUS a sharp-backed OffscreenCanvas /
 * createImageBitmap shim whose decoder AUTO-APPLIES EXIF orientation
 * (`.rotate()`), exactly like a browser's default "from-image". The
 * FIX-1d regression: a JPEG with EXIF orientation 6 (raw 40×20
 * landscape pixels, displayed 20×40 portrait) must come out UPRIGHT —
 * page sized 20×40 AND the embedded XObject re-encoded 20×40 — while
 * orientation-1 / no-EXIF JPEGs keep the ORIGINAL bytes on the fast
 * path (byte-exact passthrough), PNG keeps its fast path, and the
 * manual rotation option still swaps axes.
 *
 * Part 3 (wiring): the R6-b scan→OCR→edit chain — images/jpg-to-pdf
 * chain to ocr-pdf, ocr-pdf chains to edit-pdf; every chain target must
 * be a registered tool and central i18n keeps the en==hi parity.
 *
 * Run: bun scripts/smoke-images-to-pdf.ts
 */
import sharp from "sharp";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

import {
  exifOrientationSwapsAxes,
  readJpegOrientation,
} from "../src/lib/images/jpeg-exif";
import { HEIC_MAX_PIXELS } from "../src/lib/heic/heic-decode";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string, detail?: unknown): void {
  failed += 1;
  console.log(`FAIL ${message}`);
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

function assert(condition: boolean, message: string, detail?: unknown): void {
  if (condition) pass(message);
  else fail(message, detail);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(message);
  else fail(message, { actual, expected });
}

/* ================================================================== */
/* Part 1 — the EXIF orientation sniffer (pure)                         */
/* ================================================================== */

const u16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number): number[] =>
  [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number): number[] =>
  [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

/** One 12-byte IFD entry; `value` is already endian-ordered, ≤ 4 bytes. */
function ifdEntry(
  tag: number,
  type: number,
  count: number,
  value: number[],
  le: boolean
): number[] {
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  return [
    ...u16(tag),
    ...u16(type),
    ...u32(count),
    ...value,
    ...Array(4 - value.length).fill(0),
  ];
}

/** TIFF header + a single-entry IFD0 carrying the orientation tag. */
function tiff(
  le: boolean,
  orientation: number,
  opts: { type?: number; count?: number; ifdOffset?: number } = {}
): number[] {
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  const type = opts.type ?? 3;
  const count = opts.count ?? 1;
  const ifdOffset = opts.ifdOffset ?? 8;
  const value = type === 3 ? u16(orientation) : u32(orientation);
  const entry = ifdEntry(0x0112, type, count, value.slice(0, 4), le);
  return [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(ifdOffset),
    ...u16(1),
    ...entry,
    ...u32(0),
  ];
}

/** SOI + APP1 "Exif\0\0" + the TIFF body (segment length honest). */
function jpegWithExif(tiffBody: number[]): Uint8Array {
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiffBody];
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...u16be(payload.length + 2),
    ...payload,
  ]);
}

/** APP0 JFIF segment (what real files carry before APP1). */
const APP0_JFIF: number[] = [
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
];

/** A non-Exif APP1 (XMP) segment — honest length, Adobe xap namespace. */
const APP1_XMP: number[] = [
  0xff,
  0xe1,
  ...u16be("http://ns.adobe.com/xap/1.0/\0".length + 2),
  ...Array.from("http://ns.adobe.com/xap/1.0/\0", (c) => c.charCodeAt(0)),
];

async function part1(): Promise<void> {
  /* ---- real sharp-encoded fixtures: every orientation round-trips ---- */
  const svg = Buffer.from(
    `<svg width="40" height="20" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="20" fill="red"/></svg>`
  );
  for (const orientation of [undefined, 1, 2, 3, 4, 5, 6, 7, 8]) {
    let encoder = sharp(svg).jpeg();
    if (orientation !== undefined) {
      encoder = encoder.withMetadata({ orientation });
    }
    const bytes = new Uint8Array(await encoder.toBuffer());
    assertEqual(
      readJpegOrientation(bytes),
      orientation ?? 1,
      `sharp JPEG orientation ${orientation ?? "(no EXIF)"} → sniffed`
    );
  }

  /* ---- axis-swap helper ---- */
  for (let v = 1; v <= 8; v += 1) {
    assertEqual(
      exifOrientationSwapsAxes(v),
      v >= 5 && v <= 8,
      `exifOrientationSwapsAxes(${v})`
    );
  }

  /* ---- big-endian "MM" TIFF ---- */
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(false, 8))),
    8,
    "hand-crafted MM (big-endian) orientation 8"
  );
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(false, 6))),
    6,
    "hand-crafted MM orientation 6"
  );

  /* ---- APP0 JFIF + fill bytes before the APP1 ---- */
  const withJfif = new Uint8Array([
    0xff,
    0xd8,
    0xff, // stray fill byte after SOI
    ...APP0_JFIF,
    ...jpegWithExif(tiff(true, 7)).subarray(2),
  ]);
  assertEqual(
    readJpegOrientation(withJfif),
    7,
    "APP0-JFIF + fill byte + APP1-Exif → 7"
  );

  /* ---- non-Exif APP1 first, real Exif APP1 after ---- */
  const xmpFirst = new Uint8Array([
    0xff,
    0xd8,
    ...APP1_XMP,
    ...jpegWithExif(tiff(true, 6)).subarray(2),
  ]);
  assertEqual(
    readJpegOrientation(xmpFirst),
    6,
    "XMP APP1 skipped, Exif APP1 parsed → 6"
  );

  /* ---- doubt paths: every one must return 1 ---- */
  // SOS (scan data) before the Exif APP1 → stop scanning.
  const sosFirst = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xda,
    0x00,
    0x0c,
    ...jpegWithExif(tiff(true, 6)).subarray(2),
  ]);
  assertEqual(
    readJpegOrientation(sosFirst),
    1,
    "Exif APP1 after SOS → 1 (scan already started)"
  );
  // Truncated APP1: segment length runs past the buffer.
  const truncated = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0xff,
    0xff, // claims 65535 bytes
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x49,
    0x49,
    0x2a,
  ]);
  assertEqual(readJpegOrientation(truncated), 1, "truncated APP1 → 1");
  // IFD0 offset outside the segment.
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(true, 6, { ifdOffset: 0x1000 }))),
    1,
    "IFD offset out of bounds → 1"
  );
  // Wrong value type (LONG instead of SHORT) / count ≠ 1.
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(true, 6, { type: 4 }))),
    1,
    "orientation stored as LONG → 1"
  );
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(true, 6, { count: 2 }))),
    1,
    "orientation count = 2 → 1"
  );
  // Reserved/invalid values 0 and 9.
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(true, 0))),
    1,
    "orientation value 0 → 1"
  );
  assertEqual(
    readJpegOrientation(jpegWithExif(tiff(true, 9))),
    1,
    "orientation value 9 → 1"
  );
  // Bad TIFF magic / byte order.
  assertEqual(
    readJpegOrientation(
      jpegWithExif([0x49, 0x49, 0x00, 0x2b, 0x00, 0x00, 0x00, 0x08])
    ),
    1,
    "TIFF magic ≠ 42 → 1"
  );
  assertEqual(
    readJpegOrientation(jpegWithExif([0x58, 0x58, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])),
    1,
    "byte order ≠ II/MM → 1"
  );
  // Not a JPEG at all.
  assertEqual(
    readJpegOrientation(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
    1,
    "PNG magic → 1"
  );
  assertEqual(
    readJpegOrientation(new Uint8Array(37).fill(0x5a)),
    1,
    "garbage bytes → 1"
  );
  assertEqual(
    readJpegOrientation(new Uint8Array(2)),
    1,
    "too short → 1"
  );

  /* ---- heic decode guard policy (FIX-1d, src/lib/heic/heic-decode) ---- */
  assertEqual(
    HEIC_MAX_PIXELS,
    80_000_000,
    "heic pixel cap = 80 MP (same policy as imgconv HEIF_MAX_PIXELS)"
  );
  assert(
    20000 * 50 <= HEIC_MAX_PIXELS,
    "heic guard: 20000×50 panorama passes the width*height cap"
  );
  assert(
    16000 * 16000 > HEIC_MAX_PIXELS,
    "heic guard: 16000×16000 (256 MP ≈ 1 GB RGBA) refused"
  );
}

/* ================================================================== */
/* Part 2 — the real worker (shimmed raster backend)                    */
/* ================================================================== */

type Posted = Record<string, unknown> & { type: string };
const inbox: Posted[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
  OffscreenCanvas: unknown;
  createImageBitmap: unknown;
};

interface ShimBitmap {
  width: number;
  height: number;
  close(): void;
  _raw: Buffer;
}

class ShimCanvas {
  width: number;
  height: number;
  #buf: Buffer;
  #ctx: ShimContext | null = null;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.#buf = Buffer.alloc(width * height * 4); // transparent black
  }
  getContext(_kind: "2d"): ShimContext | null {
    this.#ctx = this.#ctx ?? new ShimContext(this.width, this.height, this.#buf);
    return this.#ctx;
  }
  async convertToBlob(options: {
    type: string;
    quality?: number;
  }): Promise<Blob> {
    const pipeline = sharp(this.#buf, {
      raw: { width: this.width, height: this.height, channels: 4 },
    });
    const bytes =
      options.type === "image/png"
        ? await pipeline.png().toBuffer()
        : await pipeline
            .jpeg({ quality: Math.round((options.quality ?? 0.92) * 100) })
            .toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: options.type });
  }
}

class ShimContext {
  #width: number;
  #height: number;
  #buf: Buffer;
  #tx = 0;
  #ty = 0;
  #rot = 0;
  fillStyle = "rgba(0,0,0,0)";
  constructor(width: number, height: number, buf: Buffer) {
    this.#width = width;
    this.#height = height;
    this.#buf = buf;
  }
  translate(tx: number, ty: number): void {
    this.#tx += tx;
    this.#ty += ty;
  }
  rotate(rad: number): void {
    this.#rot += rad;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const color = parseColor(this.fillStyle);
    if (color.alpha <= 0) return;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.#width, Math.round(x + w));
    const y1 = Math.min(this.#height, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const at = (py * this.#width + px) * 4;
        for (let c = 0; c < 3; c += 1) {
          const channel = c === 0 ? color.r : c === 1 ? color.g : color.b;
          const old = this.#buf[at + c];
          this.#buf[at + c] = Math.round(
            channel * color.alpha + old * (1 - color.alpha)
          );
        }
        this.#buf[at + 3] = Math.min(
          255,
          Math.round(255 * color.alpha + this.#buf[at + 3] * (1 - color.alpha))
        );
      }
    }
  }
  async drawImage(bitmap: ShimBitmap, dx: number, dy: number): Promise<void> {
    const bw = bitmap.width;
    const bh = bitmap.height;
    const deg = Math.round((this.#rot * 180) / Math.PI) % 360;
    const rad = (deg * Math.PI) / 180;
    // The bitmap's local centre maps to translate + R(centre).
    const cx = dx + bw / 2;
    const cy = dy + bh / 2;
    const rcx = cx * Math.cos(rad) - cy * Math.sin(rad);
    const rcy = cx * Math.sin(rad) + cy * Math.cos(rad);
    const swap = deg % 180 === 90 || deg % 180 === -90;
    const rw = swap ? bh : bw;
    const rh = swap ? bw : bh;
    const left = Math.round(this.#tx + rcx - rw / 2);
    const top = Math.round(this.#ty + rcy - rh / 2);
    if (left < 0 || top < 0 || left + rw > this.#width || top + rh > this.#height) {
      throw new Error(
        `shim drawImage out of bounds: ${left},${top} ${rw}x${rh} in ${this.#width}x${this.#height}`
      );
    }
    const layer = await sharp(bitmap._raw, {
      raw: { width: bw, height: bh, channels: 4 },
    })
      .rotate(deg)
      .png()
      .toBuffer();
    await sharp(this.#buf, {
      raw: { width: this.#width, height: this.#height, channels: 4 },
    })
      .composite([{ input: layer, left, top }])
      .raw()
      .toBuffer({ resolveWithObject: false })
      .then((out: Buffer) => {
        this.#buf.set(out.subarray(0, this.#buf.length));
      });
  }
}

function parseColor(fill: string): {
  r: number;
  g: number;
  b: number;
  alpha: number;
} {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(fill.trim());
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }
  const rgba = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\)/.exec(
    fill
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return { r: 0, g: 0, b: 0, alpha: 1 };
}

class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "image/jpeg") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
  slice(start: number, end?: number): FakeFile {
    return new FakeFile(
      this.name,
      this.#bytes.slice(start, end ?? undefined),
      this.type
    );
  }
}

function installShims(): void {
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Posted);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    ShimCanvas;
  // The browser default (and the explicit option the worker now passes)
  // is imageOrientation "from-image": EXIF orientation is applied by the
  // decoder — sharp `.rotate()` with no argument does exactly that.
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    async (source: FakeFile | Blob, _options?: unknown): Promise<ShimBitmap> => {
      const bytes = Buffer.from(await source.arrayBuffer());
      const { data, info } = await sharp(bytes)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        width: info.width,
        height: info.height,
        _raw: data,
        close(): void {
          /* no-op in the shim */
        },
      };
    };
}

interface RunOutcome {
  result: (Posted & { outputs?: { name: string; blob: Blob }[] }) | null;
  error: (Posted & { code?: string }) | null;
}

async function runWorker(
  files: FakeFile[],
  options: Record<string, unknown>
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId: 1,
      toolId: "images-to-pdf",
      options,
      files,
      assets: [],
    },
  });
  for (let i = 0; i < 600; i += 1) {
    const terminal = inbox.find((m) => m.type === "result" || m.type === "error");
    if (terminal) {
      await new Promise((r) => setTimeout(r, 0));
      return {
        result: (inbox.find((m) => m.type === "result") as RunOutcome["result"]) ?? null,
        error: (inbox.find((m) => m.type === "error") as RunOutcome["error"]) ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("worker never posted a terminal message");
}

interface EmbeddedImage {
  width: number;
  height: number;
  filter: string;
  contents: Uint8Array;
}

async function openAndInspect(
  outcome: RunOutcome
): Promise<{ pages: { w: number; h: number }[]; images: EmbeddedImage[] }> {
  if (!outcome.result || !outcome.result.outputs?.[0]) {
    throw new Error(`no result: ${JSON.stringify(outcome.error)}`);
  }
  const bytes = new Uint8Array(
    await outcome.result.outputs[0].blob.arrayBuffer()
  );
  assert(
    Buffer.from(bytes).subarray(0, 5).toString("latin1") === "%PDF-",
    "output is a PDF"
  );
  const doc = await PDFDocument.load(bytes);
  const images: EmbeddedImage[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const subtype = obj.dict.get(PDFName.of("Subtype"));
      if (String(subtype) !== "/Image") continue;
      const width = obj.dict.get(PDFName.of("Width"));
      const height = obj.dict.get(PDFName.of("Height"));
      const filter = obj.dict.get(PDFName.of("Filter"));
      images.push({
        width: width instanceof PDFNumber ? width.asNumber() : -1,
        height: height instanceof PDFNumber ? height.asNumber() : -1,
        filter: String(filter ?? ""),
        contents: obj.contents,
      });
    }
  }
  return {
    pages: doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight() })),
    images,
  };
}

/**
 * Decoded content-stream text of pdf-lib page `idx` (oracle-side reads for
 * the P6-k placement/label checks — our writer emits classic xref with
 * UNCOMPRESSED page streams, but inflate is attempted either way so the
 * helper stays honest for re-saved fixtures).
 */
async function libPageText(
  doc: PDFDocument,
  idx: number
): Promise<string[]> {
  const pg = doc.getPage(idx);
  const contents = pg.node.Contents();
  const streams: unknown[] = [];
  const c = contents as unknown as { constructor: { name: string } };
  if (c?.constructor?.name === "PDFArray") {
    const arr = contents as unknown as {
      size(): number;
      lookup(i: number): unknown;
    };
    for (let i = 0; i < arr.size(); i += 1) streams.push(arr.lookup(i));
  } else {
    streams.push(contents);
  }
  const out: string[] = [];
  for (const st of streams) {
    const raw = st as { contents?: Uint8Array };
    if (!raw?.contents) continue;
    let bytes = raw.contents;
    try {
      bytes = inflateSync(Buffer.from(bytes));
    } catch {
      // not flate — use as-is
    }
    out.push(Buffer.from(bytes).toString("latin1"));
  }
  return out;
}

async function part2(): Promise<void> {
  installShims();
  await import("../tools/imagegrid/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const svg = Buffer.from(
    `<svg width="40" height="20" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="20" fill="red"/></svg>`
  );
  const plainJpeg = new Uint8Array(await sharp(svg).jpeg().toBuffer());
  const o1Jpeg = new Uint8Array(
    await sharp(svg).withMetadata({ orientation: 1 }).jpeg().toBuffer()
  );
  const o6Jpeg = new Uint8Array(
    await sharp(svg).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  );
  const png30x10 = new Uint8Array(
    await sharp(svg)
      .resize(30, 10)
      .png()
      .toBuffer()
  );

  /* ---- 1. THE FIX-1d REGRESSION: EXIF orientation 6 ---- */
  {
    const run = await runWorker(
      [new FakeFile("portrait-o6.jpg", o6Jpeg)],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 1 (orientation 6): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assertEqual(pages.length, 1, "run 1: one page");
    // The page must be sized by the ORIENTED (swapped) dimensions…
    assert(
      Math.abs(pages[0].w - 20) < 0.01 && Math.abs(pages[0].h - 40) < 0.01,
      "run 1: fit page = ORIENTED 20×40 (portrait)",
      pages[0]
    );
    // …AND the embedded pixels must actually BE upright (the old bug kept
    // the raw 40×20 bytes and stretched them into the portrait page).
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [20, 40],
      "run 1: embedded XObject re-encoded upright 20×40"
    );
    assert(
      images[0]?.filter.includes("DCTDecode"),
      "run 1: embedded XObject is JPEG",
      images[0]?.filter
    );
    assert(
      !Buffer.from(images[0].contents).equals(Buffer.from(o6Jpeg)),
      "run 1: rotated image is re-encoded (not the original bytes)"
    );
    const decoded = await sharp(Buffer.from(images[0].contents))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assertEqual(
      [decoded.info.width, decoded.info.height],
      [20, 40],
      "run 1: embedded JPEG decodes upright"
    );
  }

  /* ---- 2. orientation 1: fast path, ORIGINAL bytes ---- */
  {
    const run = await runWorker(
      [new FakeFile("upright-o1.jpg", o1Jpeg)],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 2 (orientation 1): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 40) < 0.01 && Math.abs(pages[0].h - 20) < 0.01,
      "run 2: fit page = 40×20",
      pages[0]
    );
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [40, 20],
      "run 2: XObject dims = raw 40×20"
    );
    assert(
      Buffer.from(images[0].contents).equals(Buffer.from(o1Jpeg)),
      "run 2: fast path embeds ORIGINAL bytes (byte-exact)"
    );
  }

  /* ---- 3. no EXIF at all: fast path unchanged ---- */
  {
    const run = await runWorker(
      [new FakeFile("plain.jpg", plainJpeg)],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 3 (no EXIF): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 40) < 0.01 && Math.abs(pages[0].h - 20) < 0.01,
      "run 3: fit page = 40×20",
      pages[0]
    );
    assert(
      Buffer.from(images[0].contents).equals(Buffer.from(plainJpeg)),
      "run 3: fast path embeds ORIGINAL bytes (no re-compression)"
    );
  }

  /* ---- 4. PNG fast path untouched ---- */
  {
    const run = await runWorker(
      [new FakeFile("flat.png", png30x10, "image/png")],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 4 (png): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 30) < 0.01 && Math.abs(pages[0].h - 10) < 0.01,
      "run 4: fit page = 30×10",
      pages[0]
    );
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [30, 10],
      "run 4: PNG XObject dims"
    );
    assert(
      images[0]?.filter.includes("FlateDecode"),
      "run 4: PNG XObject is a (re-deflated) Flate image — pdf-lib's embedPng",
      images[0]?.filter
    );
  }

  /* ---- 5. manual rotation option still swaps axes ---- */
  {
    const run = await runWorker(
      [new FakeFile("plain.jpg", plainJpeg)],
      { pageSize: "fit", margin: "none", images: "[[0,90]]" }
    );
    assert(run.error === null, "run 5 (rotate 90): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 20) < 0.01 && Math.abs(pages[0].h - 40) < 0.01,
      "run 5: rotated fit page = 20×40",
      pages[0]
    );
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [20, 40],
      "run 5: rotated XObject dims 20×40"
    );
  }

  /* ---- 6. multi-file: mixed orientation-6 + plain, one page each ---- */
  {
    const run = await runWorker(
      [
        new FakeFile("portrait-o6.jpg", o6Jpeg),
        new FakeFile("plain.jpg", plainJpeg),
      ],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 6 (multi): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assertEqual(pages.length, 2, "run 6: one page per image");
    assert(
      Math.abs(pages[0].w - 20) < 0.01 && Math.abs(pages[0].h - 40) < 0.01,
      "run 6: page 1 = oriented 20×40",
      pages[0]
    );
    assert(
      Math.abs(pages[1].w - 40) < 0.01 && Math.abs(pages[1].h - 20) < 0.01,
      "run 6: page 2 = 40×20",
      pages[1]
    );
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [20, 40],
      "run 6: XObject 1 upright"
    );
    assertEqual(
      [images[1]?.width, images[1]?.height],
      [40, 20],
      "run 6: XObject 2 raw fast path"
    );
  }

  /* ---- 7. fixed A4 page + default margin still works ---- */
  {
    const run = await runWorker(
      [new FakeFile("portrait-o6.jpg", o6Jpeg)],
      { pageSize: "a4" }
    );
    assert(run.error === null, "run 7 (a4): no error", run.error);
    const { pages } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 595.28) < 0.5 && Math.abs(pages[0].h - 841.89) < 0.5,
      "run 7: A4 portrait page (auto orientation from upright image)",
      pages[0]
    );
  }

  /* ---- 8. honest error: undecodable/unknown file ---- */
  {
    const run = await runWorker(
      [new FakeFile("garbage.bin", new Uint8Array(64).fill(0x37), "application/octet-stream")],
      { pageSize: "a4" }
    );
    assert(run.error !== null, "run 8: error posted");
    assertEqual(
      run.error?.code,
      "tool.images.errorUnsupported",
      "run 8: errorUnsupported code"
    );
  }

  /* ---- 9. P6-k: two-up grid — two images share ONE A4 landscape page ---- */
  {
    const run = await runWorker(
      [new FakeFile("a.jpg", plainJpeg), new FakeFile("b.png", png30x10, "image/png")],
      { pageSize: "a4", layout: "two", orientation: "landscape" }
    );
    assert(run.error === null, "run 9 (two-up): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assertEqual(pages.length, 1, "run 9: one page for two images");
    assert(
      Math.abs(pages[0].w - 841.89) < 0.5 && Math.abs(pages[0].h - 595.28) < 0.5,
      "run 9: A4 landscape page",
      pages[0]
    );
    assertEqual(images.length, 2, "run 9: two embedded XObjects");
    assertEqual(
      [images[0]?.width, images[0]?.height],
      [40, 20],
      "run 9: XObject 1 dims"
    );
    assertEqual(
      [images[1]?.width, images[1]?.height],
      [30, 10],
      "run 9: XObject 2 dims"
    );
    // 2/2 placement: the drawImage translate cms must sit in disjoint
    // x-halves (identity cms are all "0" — filtered out by > 1).
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    const content = (await libPageText(doc, 0)).join(" ");
    const cms = content.match(/(?:^|\s)((?:-?[\d.]+) (?:-?[\d.]+)) cm/g) ?? [];
    assert(cms.length >= 8, "run 9: two drawImage cm triplets present", cms);
    const txs = cms
      .map((pair) => Number(pair.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 1);
    assert(
      txs.length >= 2 && Math.max(...txs) - Math.min(...txs) > 300,
      "run 9: images placed in disjoint halves",
      txs
    );
  }

  /* ---- 10. P6-k: page numbers — the "1 / 2" Helvetica label on every page ---- */
  {
    const run = await runWorker(
      [new FakeFile("a.jpg", plainJpeg), new FakeFile("b.jpg", plainJpeg)],
      { pageSize: "fit", margin: "none", pageNumbers: true }
    );
    assert(run.error === null, "run 10 (numbers): no error", run.error);
    const { pages } = await openAndInspect(run);
    assertEqual(pages.length, 2, "run 10: two pages");
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    for (let i = 0; i < 2; i += 1) {
      const text = (await libPageText(doc, i)).join(" ");
      const label = i === 0 ? "1 / 2" : "2 / 2";
      // WinAnsi hex for the label (pdf-lib/our engine both emit <HEX> Tj)
      const hex = Buffer.from(label, "latin1").toString("hex").toUpperCase();
      assert(
        text.includes(`<${hex}> Tj`),
        `run 10: page ${i + 1} carries the "${label}" label`,
        { hex, text: text.slice(0, 400) }
      );
    }
    // Helvetica font resource present on the page
    const fonts = doc
      .getPage(0)
      .node.Resources()
      ?.lookup(PDFName.of("Font"));
    assert(
      fonts !== undefined,
      "run 10: /Font resource present (Helvetica)",
      String(fonts)
    );
  }

  /* ---- 11. P6-k: background — the full-page fill rect color ---- */
  {
    const run = await runWorker(
      [new FakeFile("a.jpg", plainJpeg)],
      { pageSize: "a4", background: "dark" }
    );
    assert(run.error === null, "run 11 (background): no error", run.error);
    assert(run.result !== null, "run 11: result posted");
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    const text = (await libPageText(doc, 0)).join(" ");
    // BG_RGB.dark = [0.09, 0.09, 0.11] — the first rg fill op
    assert(
      /0\.09 0\.09 0\.11 rg/.test(text),
      "run 11: dark background fill emitted first",
      text.slice(0, 120)
    );
  }

  /* ---- 12. R44: fill mode — cover-fit + page-space clip, no re-encode ---- */
  {
    // 40×20 image on A4 (auto → landscape 841.89×595.28, margin 18):
    // cell 805.89×559.28; cover scale = 559.28/20 → drawn width 1118.56
    // EXCEEDS the cell and must be clipped to it — the blank side bands die.
    const run = await runWorker(
      [new FakeFile("wide.jpg", plainJpeg)],
      { pageSize: "a4", fitMode: "fill" }
    );
    assert(run.error === null, "run 12 (fill): no error", run.error);
    const { pages, images } = await openAndInspect(run);
    assert(
      Math.abs(pages[0].w - 841.89) < 0.5 && Math.abs(pages[0].h - 595.28) < 0.5,
      "run 12: A4 landscape page",
      pages[0]
    );
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    const text = (await libPageText(doc, 0)).join(" ");
    assert(
      /18 18 805\.89 559\.28 re W n/.test(text),
      "run 12: clip rect on the exact cell (re W n)",
      text.slice(0, 300)
    );
    assert(
      /1118\.5\d* 0 0 559\.2\d* 0 0 cm/.test(text),
      "run 12: cover scale — drawn width exceeds the cell",
      text.slice(0, 300)
    );
    assert(
      Buffer.from(images[0].contents).equals(Buffer.from(plainJpeg)),
      "run 12: fill crops by CLIP — original bytes still embedded"
    );
  }

  /* ---- 12b. R44: default contain — NO clip op in the stream ---- */
  {
    const run = await runWorker(
      [new FakeFile("wide.jpg", plainJpeg)],
      { pageSize: "a4" }
    );
    assert(run.error === null, "run 12b (contain): no error", run.error);
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    const text = (await libPageText(doc, 0)).join(" ");
    assert(
      !/ re W n/.test(text),
      "run 12b: contain default emits no clip",
      text.slice(0, 300)
    );
  }

  /* ---- 13. R44: branding — metadata + output filename, no watermark ---- */
  {
    const run = await runWorker(
      [new FakeFile("holiday.jpg", plainJpeg)],
      { pageSize: "fit", margin: "none" }
    );
    assert(run.error === null, "run 13 (branding): no error", run.error);
    assert(
      run.result?.outputs?.[0]?.name === "holiday-docopdf.pdf",
      "run 13: output filename carries the -docopdf suffix",
      run.result?.outputs?.[0]?.name
    );
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer()),
      // updateMetadata:false — pdf-lib's load() otherwise clobbers Producer
      // with its own default before we can read OUR Info dict.
      { updateMetadata: false }
    );
    assertEqual(doc.getProducer(), "DocoPDF", "run 13: Producer");
    assertEqual(doc.getCreator(), "DocoPDF", "run 13: Creator");
    assertEqual(doc.getTitle(), "holiday", "run 13: Title = original base");
    assert(
      doc.getCreationDate() !== undefined,
      "run 13: CreationDate stamped"
    );
    // The document body itself stays watermark-free: only ONE image XObject
    // and no extra text draws beyond the page content already asserted.
    const text = (await libPageText(doc, 0)).join(" ");
    assert(
      !/ Tj/.test(text),
      "run 13: no text ops — zero watermark on the page",
      text.slice(0, 200)
    );
  }

  /* ---- 14. R44: page numbers on dark bg — light ink contrast ---- */
  {
    const run = await runWorker(
      [new FakeFile("a.jpg", plainJpeg)],
      { pageSize: "a4", background: "dark", pageNumbers: true }
    );
    assert(run.error === null, "run 14 (numbers on dark): no error", run.error);
    const doc = await PDFDocument.load(
      new Uint8Array(await run.result!.outputs![0].blob.arrayBuffer())
    );
    const text = (await libPageText(doc, 0)).join(" ");
    assert(
      /0\.72 0\.72 0\.78 rg/.test(text),
      "run 14: light number ink on the dark background",
      text.slice(0, 400)
    );
  }
}

/* ================================================================== */
/* Part 3 — scan→OCR→edit chain wiring (R6-b)                           */
/* ================================================================== */

/** The photo/scan loop: images→pdf chains to OCR, OCR chains to the
 * editor (whose edittext mode now hand-offs back to OCR for scans). */
async function part3(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const read = (p: string): string => readFileSync(p, "utf8");

  const imagesCfg = read("tools/images-to-pdf/config.ts");
  const jpgCfg = read("tools/jpg-to-pdf/config.ts");
  const ocrCfg = read("tools/ocr-pdf/config.ts");
  const registry = read("src/lib/tools/registry.ts");

  assert(
    /chainToolIds:\s*\["ocr-pdf",\s*"compress-pdf",\s*"merge-pdf",\s*"sign-pdf"\]/.test(
      imagesCfg
    ),
    "images-to-pdf chains to ocr-pdf first"
  );
  assert(
    /chainToolIds:\s*\["ocr-pdf",\s*"compress-pdf",\s*"merge-pdf",\s*"sign-pdf"\]/.test(
      jpgCfg
    ),
    "jpg-to-pdf chains to ocr-pdf first"
  );
  assert(
    /chainToolIds:\s*\["edit-pdf",\s*"pdf-to-txt",\s*"compress-pdf",\s*"lock-pdf"\]/.test(
      ocrCfg
    ),
    "ocr-pdf chains to edit-pdf first"
  );
  // R44 wiring: every imagegrid preset carries the shared fitMode option
  // (contain vs fill) and the worker actually reads it.
  const fitModeConfigs: Array<[string, string]> = [
    ["images-to-pdf", imagesCfg],
    ["jpg-to-pdf", jpgCfg],
    ["png-to-pdf", read("tools/png-to-pdf/config.ts")],
    ["webp-to-pdf", read("tools/webp-to-pdf/config.ts")],
    ["heic-to-pdf", read("tools/heic-to-pdf/config.ts")],
    ["tiff-to-pdf", read("tools/tiff-to-pdf/config.ts")],
    ["svg-to-pdf", read("tools/svg-to-pdf/config.ts")],
  ];
  for (const [slug, cfg] of fitModeConfigs) {
    assert(
      cfg.includes("FIT_MODE_OPTION,"),
      `${slug}: FIT_MODE_OPTION wired into options`
    );
  }
  const fitModeShared = read("tools/imagegrid/fit-mode-option.ts");
  assert(
    /id: "fitMode"/.test(fitModeShared),
    "fit-mode-option exports the fitMode id"
  );
  assert(
    /value: "fill"/.test(fitModeShared),
    "fit-mode-option offers the fill choice"
  );
  const imagegridWorker = read("tools/imagegrid/worker.ts");
  assert(
    imagegridWorker.includes("options.fitMode"),
    "imagegrid worker reads options.fitMode"
  );
  assert(
    imagegridWorker.includes('setProducer("DocoPDF")'),
    "imagegrid worker stamps the DocoPDF Producer"
  );
  // Every chain target must be a real registered tool id.
  for (const id of [
    "ocr-pdf",
    "edit-pdf",
    "pdf-to-txt",
    "compress-pdf",
    "merge-pdf",
    "sign-pdf",
  ]) {
    assert(
      registry.includes(`id: "${id}"`),
      `registry has chain target ${id}`
    );
  }

  // Central i18n parity invariant (R6-a pattern: en==hi, floored).
  const en = JSON.parse(read("src/i18n/en.json")) as unknown;
  const hi = JSON.parse(read("src/i18n/hi.json")) as unknown;
  const leaves = (node: unknown): number => {
    if (node !== null && typeof node === "object") {
      let n = 0;
      for (const value of Object.values(node as Record<string, unknown>)) {
        n += leaves(value);
      }
      return n;
    }
    return 1;
  };
  assertEqual(leaves(en), leaves(hi), "i18n leaf parity en==hi");
  assert(leaves(en) >= 4378, "i18n leaf floor 4378", leaves(en));
}

async function main(): Promise<void> {
  await part1();
  const part1Passed = passed;
  const part1Failed = failed;
  console.log(`\nPart 1 (exif sniffer): ${part1Passed} passed, ${part1Failed} failed`);

  await part2();
  const part2Passed = passed - part1Passed;
  const part2Failed = failed - part1Failed;
  console.log(
    `\nPart 2 (real worker): ${part2Passed} passed, ${part2Failed} failed`
  );

  await part3();
  console.log(
    `\nPart 3 (chain wiring): ${passed - part1Passed - part2Passed} passed, ${
      failed - part1Failed - part2Failed
    } failed`
  );
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});
