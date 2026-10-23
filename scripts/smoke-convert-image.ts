/**
 * PRE-BUILD smoke test for the WIRED image converter worker
 * (tools/convert-image/worker.ts — shared by webp-to-jpg, webp-to-png,
 * heic-to-jpg and heic-to-png; all four configs point here).
 *
 * Part 1 (wiring): the four tool configs really create THIS worker, the
 * registry entries are enabled, TOOL_CONFIGS routes them, the HEIC path
 * imports the live src/lib/heic/heic-decode decoder, and every error
 * code the worker can post exists in BOTH i18n catalogs.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker through the
 * self/postMessage shim + a sharp-backed OffscreenCanvas/createImageBitmap
 * pair (smoke-images-to-pdf recipe). Covers the core paths:
 *   - WEBP→JPG happy path (JPEG magic, dims, colour, progress, detail)
 *   - JPG flatten: transparency onto white / soft / black backgrounds
 *     (plus unknown-background → white fallback); PNG keeps alpha
 *   - quality clamp 0.4–1 at every boundary (default 0.85)
 *   - maxDim downscale (aspect kept, never upscales)
 *   - output-name sanitize + collision dedup (photo, photo-2, photo-3…)
 *   - magic-sniff refusals (wrong family, garbage, AVIF, JPEG) and the
 *     HEIC error mapping (ftyp brands accepted, decode failure →
 *     errorHeicDecode — under bun the /libheif/ bundle import fails
 *     deterministically, which exercises exactly the honest-refuse path)
 *   - unknown toolId → errorGeneric, empty run → errorNoImages
 *   - bitmaps are closed after each file (finally)
 *
 * Run: bun scripts/smoke-convert-image.ts
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";

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
/* Part 1 — wiring (configs, registry, decoder import, i18n)           */
/* ================================================================== */

function part1(): void {
  const tools = ["webp-to-jpg", "webp-to-png", "heic-to-jpg", "heic-to-png"];
  for (const tool of tools) {
    const configSrc = readFileSync(`tools/${tool}/config.ts`, "utf8");
    assert(
      configSrc.includes('new URL("../convert-image/worker.ts", import.meta.url)'),
      `config ${tool} wires the shared convert-image worker`
    );
  }

  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  for (const tool of tools) {
    const m = registrySrc.match(
      new RegExp(`id: "${tool}"[\\s\\S]*?enabled: (true|false)`)
    );
    assert(m?.[1] === "true", `registry ${tool} enabled: true`);
  }

  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  for (const camel of ["webpToJpg", "webpToPng", "heicToJpg", "heicToPng"]) {
    assert(
      new RegExp(`\\[${camel}\\.toolId\\]\\s*:\\s*${camel}`).test(configsSrc),
      `TOOL_CONFIGS routes ${camel}`
    );
  }

  const workerSrc = readFileSync("tools/convert-image/worker.ts", "utf8");
  assert(
    workerSrc.includes('from "@/lib/heic/heic-decode"'),
    "worker decodes HEIC through the live src/lib/heic decoder"
  );
  assert(
    /function sanitizeBase/.test(workerSrc) &&
      /usedNames\.has\(`\$\{base\}-\$\{n\}\.\$\{target\.ext\}`\)/.test(workerSrc),
    "worker owns its name sanitize + -2/-3 collision dedup (no dead-stack import)"
  );

  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool?: Record<string, unknown>;
  };
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    tool?: Record<string, unknown>;
  };
  for (const key of ["errorUnsupported", "errorGeneric", "errorCorrupt"]) {
    assert(
      typeof en.tool?.[key] === "string" && typeof hi.tool?.[key] === "string",
      `i18n tool.${key} present in en + hi`
    );
  }
  for (const key of ["errorHeicDecode", "errorDecode", "errorNoImages"]) {
    const enImages = en.tool?.images as Record<string, unknown> | undefined;
    const hiImages = hi.tool?.images as Record<string, unknown> | undefined;
    assert(
      typeof enImages?.[key] === "string" &&
        typeof hiImages?.[key] === "string",
      `i18n tool.images.${key} present in en + hi`
    );
  }
}

/* ================================================================== */
/* Part 2 — the real worker (shimmed raster backend)                   */
/* ================================================================== */

type Posted = Record<string, unknown> & { type: string };
const inbox: Posted[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

/** Recorded per convertToBlob call — how the quality clamp is observed. */
let lastBlobOptions: { type?: string; quality?: number } | null = null;
let bitmapCloses = 0;

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
  /** Pending async draws — the browser's drawImage is synchronous, so
   * convertToBlob must not race ahead of a draw still landing. */
  #pending: Promise<void>[] = [];
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.#buf = Buffer.alloc(width * height * 4); // transparent black
  }
  getContext(_kind: "2d"): ShimContext | null {
    this.#ctx = this.#ctx ?? new ShimContext(this.width, this.height, this.#buf, this.#pending);
    return this.#ctx;
  }
  async convertToBlob(options: {
    type: string;
    quality?: number;
  }): Promise<Blob> {
    await Promise.all(this.#pending);
    lastBlobOptions = { ...options };
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
  #pending: Promise<void>[];
  fillStyle = "rgba(0,0,0,0)";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  constructor(width: number, height: number, buf: Buffer, pending: Promise<void>[]) {
    this.#width = width;
    this.#height = height;
    this.#buf = buf;
    this.#pending = pending;
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
  drawImage(
    bitmap: ShimBitmap,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number
  ): void {
    const bw = dw ?? bitmap.width;
    const bh = dh ?? bitmap.height;
    const left = Math.round(dx);
    const top = Math.round(dy);
    if (
      left < 0 ||
      top < 0 ||
      left + bw > this.#width ||
      top + bh > this.#height
    ) {
      throw new Error(
        `shim drawImage out of bounds: ${left},${top} ${bw}x${bh} in ${this.#width}x${this.#height}`
      );
    }
    // The browser's drawImage is SYNCHRONOUS: by the time any later canvas
    // operation (convertToBlob) observes the buffer, every draw must have
    // landed. The composite is sharp-async, so it is registered in the
    // canvas's pending-draws list NOW (synchronously) and every later
    // encode awaits the list first.
    this.#pending.push(
      (async () => {
        const layer = await sharp(bitmap._raw, {
          raw: { width: bitmap.width, height: bitmap.height, channels: 4 },
        })
          .resize(bw, bh, { fit: "fill" })
          .png()
          .toBuffer();
        const out = await sharp(this.#buf, {
          raw: { width: this.#width, height: this.#height, channels: 4 },
        })
          .composite([{ input: layer, left, top }])
          .raw()
          .toBuffer({ resolveWithObject: false });
        this.#buf.set(out.subarray(0, this.#buf.length));
      })()
    );
  }
}

function parseColor(fill: string): {
  r: number;
  g: number;
  b: number;
  alpha: number;
} {
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\)/.exec(
    fill
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  return { r: 0, g: 0, b: 0, alpha: 1 };
}

class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "image/webp") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
}

function installShims(): void {
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Posted);
  };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    ShimCanvas;
  // Browser default is imageOrientation "from-image" — sharp `.rotate()`
  // with no argument applies exactly that.
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
          bitmapCloses += 1;
        },
      };
    };
}

interface RunOutcome {
  result:
    | (Posted & {
        outputs?: { name: string; mime: string; blob: Blob }[];
        detail?: { files?: number; pages?: number };
      })
    | null;
  error: (Posted & { code?: string; detail?: string }) | null;
}

async function runWorker(
  toolId: string,
  files: FakeFile[],
  options: Record<string, unknown>
): Promise<RunOutcome> {
  inbox.length = 0;
  lastBlobOptions = null;
  workerGlobal.onmessage!({
    data: { type: "run", runId: 1, toolId, options, files, assets: [] },
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

/** Decode a worker output blob back into RGBA for pixel assertions. */
async function decodeBlob(blob: Blob): Promise<{
  width: number;
  height: number;
  data: Buffer;
}> {
  const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function pixelAt(
  img: { width: number; data: Buffer },
  x: number,
  y: number
): [number, number, number, number] {
  const at = (y * img.width + x) * 4;
  return [img.data[at], img.data[at + 1], img.data[at + 2], img.data[at + 3]];
}

function near(
  actual: [number, number, number, number],
  target: [number, number, number, number],
  tol: number
): boolean {
  return actual.every((v, i) => Math.abs(v - target[i]) <= tol);
}

/** Minimal ISO-BMFF head with the given ftyp brand (undecodable body). */
function heicHead(brand: string): Uint8Array {
  const head = new Uint8Array(32);
  head.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70], 0); // size + "ftyp"
  head.set(
    [brand.charCodeAt(0), brand.charCodeAt(1), brand.charCodeAt(2), brand.charCodeAt(3)],
    8
  );
  return head;
}

async function part2(): Promise<void> {
  installShims();
  await import("../tools/convert-image/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const svgOpaque = Buffer.from(
    `<svg width="40" height="20" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="20" fill="#e02020"/></svg>`
  );
  // Left half transparent, right half red — the flatten battery.
  const svgHalfAlpha = Buffer.from(
    `<svg width="40" height="20" xmlns="http://www.w3.org/2000/svg"><rect x="20" width="20" height="20" fill="#e02020"/></svg>`
  );
  const svgPortrait = Buffer.from(
    `<svg width="40" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="100" fill="#2060e0"/></svg>`
  );
  const redWebp = new Uint8Array(await sharp(svgOpaque).webp().toBuffer());
  const halfAlphaWebp = new Uint8Array(
    await sharp(svgHalfAlpha).webp().toBuffer()
  );
  const portraitWebp = new Uint8Array(
    await sharp(svgPortrait).webp().toBuffer()
  );
  const wideWebp = new Uint8Array(
    await sharp(svgOpaque).resize(100, 40).webp().toBuffer()
  );

  /* ---- 1. webp-to-jpg happy path ---- */
  {
    bitmapCloses = 0;
    const run = await runWorker("webp-to-jpg", [new FakeFile("photo.webp", redWebp)], {});
    assert(run.error === null, "run 1 (webp→jpg): no error", run.error);
    const out = run.result?.outputs?.[0];
    assert(!!out, "run 1: one output", run.result);
    assertEqual(out?.name, "photo.jpg", "run 1: output name photo.jpg");
    assertEqual(out?.mime, "image/jpeg", "run 1: output mime image/jpeg");
    const head = new Uint8Array(await out!.blob.arrayBuffer());
    assert(head[0] === 0xff && head[1] === 0xd8, "run 1: JPEG magic FFD8");
    const img = await decodeBlob(out!.blob);
    assertEqual([img.width, img.height], [40, 20], "run 1: dims 40×20");
    assert(
      near(pixelAt(img, 10, 10), [224, 32, 32, 255], 25),
      "run 1: pixel stays red through the re-encode",
      pixelAt(img, 10, 10)
    );
    assertEqual(
      run.result?.detail,
      { files: 1, pages: 1 },
      "run 1: result detail files/pages"
    );
    const progresses = inbox.filter((m) => m.type === "progress");
    assert(
      progresses.some((m) => m.pct === 92 && m.stage === "processing") &&
        progresses.some((m) => m.pct === 97 && m.stage === "saving"),
      "run 1: progress 92 processing + 97 saving posted",
      progresses.map((m) => `${m.pct}:${m.stage}`)
    );
    assert(bitmapCloses === 1, "run 1: bitmap closed after use");
  }

  /* ---- 2. flatten battery (JPG has no alpha) ---- */
  {
    const cases: [string | undefined, [number, number, number]][] = [
      [undefined, [255, 255, 255]], // default background → white
      ["white", [255, 255, 255]],
      ["soft", [245, 244, 240]],
      ["black", [13, 13, 13]],
      ["chartreuse", [255, 255, 255]], // unknown value → white fallback
    ];
    for (const [background, expected] of cases) {
      const options: Record<string, unknown> = {};
      if (background !== undefined) options.background = background;
      const run = await runWorker(
        "webp-to-jpg",
        [new FakeFile("half.webp", halfAlphaWebp)],
        options
      );
      assert(run.error === null, `run 2 (flatten ${background ?? "default"}): no error`, run.error);
      const img = await decodeBlob(run.result!.outputs![0].blob);
      const transparentSide = pixelAt(img, 5, 10);
      assert(
        near(transparentSide, [expected[0], expected[1], expected[2], 255], 6),
        `run 2: transparent half flattened onto ${
          background ?? "default(white)"
        }`,
        transparentSide
      );
      assert(
        near(pixelAt(img, 30, 10), [224, 32, 32, 255], 25),
        `run 2 (${background ?? "default"}): opaque half stays red`,
        pixelAt(img, 30, 10)
      );
    }
  }

  /* ---- 3. webp-to-png keeps alpha ---- */
  {
    const run = await runWorker(
      "webp-to-png",
      [new FakeFile("half.webp", halfAlphaWebp)],
      {}
    );
    assert(run.error === null, "run 3 (webp→png): no error", run.error);
    const out = run.result?.outputs?.[0];
    assertEqual(out?.name, "half.png", "run 3: output name half.png");
    assertEqual(out?.mime, "image/png", "run 3: output mime image/png");
    const head = new Uint8Array(await out!.blob.arrayBuffer());
    assert(
      head[0] === 0x89 && head[1] === 0x50,
      "run 3: PNG magic 89 50"
    );
    const img = await decodeBlob(out!.blob);
    const transparentSide = pixelAt(img, 5, 10);
    assert(
      transparentSide[3] <= 10,
      "run 3: transparent half KEEPS its alpha (no flatten)",
      transparentSide
    );
    assert(
      pixelAt(img, 30, 10)[3] >= 245,
      "run 3: opaque half stays opaque"
    );
    assert(
      lastBlobOptions?.quality === undefined,
      "run 3: quality not applied to lossless PNG encode"
    );
  }

  /* ---- 4. quality clamp 0.4–1 ---- */
  {
    const cases: [unknown, number][] = [
      [undefined, 0.85], // config default 85
      [5, 0.4], // clamped up
      [39, 0.4],
      [40, 0.4],
      [70, 0.7],
      ["70", 0.7], // numeric strings coerce
      [100, 1],
      [300, 1], // clamped down
    ];
    for (const [quality, expected] of cases) {
      const options: Record<string, unknown> = {};
      if (quality !== undefined) options.quality = quality;
      const run = await runWorker(
        "webp-to-jpg",
        [new FakeFile("q.webp", redWebp)],
        options
      );
      assert(run.error === null, `run 4 (quality ${String(quality)}): no error`, run.error);
      assertEqual(
        lastBlobOptions?.quality,
        expected,
        `run 4: quality ${String(quality)} → ${expected}`
      );
    }
  }

  /* ---- 5. name sanitize + collision dedup ---- */
  {
    const longName = `${"x".repeat(130)}.webp`;
    const run = await runWorker(
      "webp-to-png",
      [
        new FakeFile("holiday.webp", redWebp),
        new FakeFile("holiday.webp", redWebp),
        new FakeFile("holiday.webp", redWebp),
        new FakeFile('we/ird:name*.webp', redWebp),
        new FakeFile(".webp", redWebp),
        new FakeFile(longName, redWebp),
      ],
      {}
    );
    assert(run.error === null, "run 5 (names): no error", run.error);
    const names = run.result?.outputs?.map((o) => o.name);
    assertEqual(
      names?.slice(0, 3),
      ["holiday.png", "holiday-2.png", "holiday-3.png"],
      "run 5: duplicates dedup to -2, -3"
    );
    assertEqual(names?.[3], "we_ird_name_.png", "run 5: hostile name sanitized");
    assertEqual(names?.[4], "image.png", "run 5: empty base falls back to image");
    assert(
      names?.[5].length === 124 && names?.[5].endsWith(".png"),
      "run 5: long base capped at 120 chars",
      { length: names?.[5].length }
    );
    assertEqual(run.result?.detail?.files, 6, "run 5: six outputs");
    assert(bitmapCloses >= 6, "run 5: every bitmap closed");
  }

  /* ---- 6. maxDim downscale (aspect kept, never upscaled) ---- */
  {
    const wide = await runWorker(
      "webp-to-png",
      [new FakeFile("wide.webp", wideWebp)],
      { maxDim: 50 }
    );
    assert(wide.error === null, "run 6 (wide): no error", wide.error);
    const wideImg = await decodeBlob(wide.result!.outputs![0].blob);
    assertEqual(
      [wideImg.width, wideImg.height],
      [50, 20],
      "run 6: 100×40 with maxDim 50 → 50×20"
    );

    const noUpscale = await runWorker(
      "webp-to-png",
      [new FakeFile("wide.webp", wideWebp)],
      { maxDim: 500 }
    );
    assert(noUpscale.error === null, "run 6 (no-upscale): no error", noUpscale.error);
    const bigImg = await decodeBlob(noUpscale.result!.outputs![0].blob);
    assertEqual(
      [bigImg.width, bigImg.height],
      [100, 40],
      "run 6: maxDim 500 never upscales"
    );

    const portrait = await runWorker(
      "webp-to-png",
      [new FakeFile("portrait.webp", portraitWebp)],
      { maxDim: 25 }
    );
    assert(portrait.error === null, "run 6 (portrait): no error", portrait.error);
    const portraitImg = await decodeBlob(portrait.result!.outputs![0].blob);
    assertEqual(
      [portraitImg.width, portraitImg.height],
      [10, 25],
      "run 6: 40×100 portrait with maxDim 25 → 10×25 (aspect kept)"
    );

    const original = await runWorker(
      "webp-to-png",
      [new FakeFile("wide.webp", wideWebp)],
      { maxDim: "0" }
    );
    assert(original.error === null, "run 6 (maxDim 0): no error", original.error);
    const origImg = await decodeBlob(original.result!.outputs![0].blob);
    assertEqual(
      [origImg.width, origImg.height],
      [100, 40],
      'run 6: maxDim "0" keeps original pixels'
    );
  }

  /* ---- 7. magic-sniff refusals ---- */
  {
    const webpOnHeic = await runWorker(
      "heic-to-jpg",
      [new FakeFile("sneaky.webp", redWebp, "image/webp")],
      {}
    );
    assert(webpOnHeic.error !== null, "run 7: webp on a HEIC tool refused");
    assertEqual(
      webpOnHeic.error?.code,
      "tool.errorUnsupported",
      "run 7: webp-on-heic code errorUnsupported"
    );
    assertEqual(webpOnHeic.error?.detail, "sneaky.webp", "run 7: detail names the file");

    const heicOnWebp = await runWorker(
      "webp-to-jpg",
      [new FakeFile("photo.heic", heicHead("heic"), "image/heic")],
      {}
    );
    assertEqual(
      heicOnWebp.error?.code,
      "tool.errorUnsupported",
      "run 7: heic-on-webp code errorUnsupported"
    );

    const garbage = await runWorker(
      "webp-to-jpg",
      [new FakeFile("garbage.bin", new Uint8Array(64).fill(0x37), "application/octet-stream")],
      {}
    );
    assertEqual(
      garbage.error?.code,
      "tool.errorUnsupported",
      "run 7: garbage code errorUnsupported"
    );

    const avif = await runWorker(
      "heic-to-jpg",
      [new FakeFile("av.avif", heicHead("avif"), "image/avif")],
      {}
    );
    assertEqual(
      avif.error?.code,
      "tool.errorUnsupported",
      "run 7: AVIF brand is NOT the HEIC family (sniff refuses)"
    );

    const jpegMagic = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1,
    ]);
    const jpeg = await runWorker(
      "webp-to-png",
      [new FakeFile("plain.jpg", jpegMagic, "image/jpeg")],
      {}
    );
    assertEqual(
      jpeg.error?.code,
      "tool.errorUnsupported",
      "run 7: JPEG magic refused by the webp tool"
    );

    const riffGarbage = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ...new Uint8Array(20).fill(0x5a),
    ]);
    const riff = await runWorker(
      "webp-to-jpg",
      [new FakeFile("broken.webp", riffGarbage, "image/webp")],
      {}
    );
    assertEqual(
      riff.error?.code,
      "tool.images.errorDecode",
      "run 7: RIFF/WEBP magic with broken payload → errorDecode"
    );
  }

  /* ---- 8. HEIC family brands reach the decoder, decode failure is honest ---- */
  {
    // Under bun the /libheif/ bundle URL import fails deterministically, so
    // the worker's decodeHeicToBitmap try/catch fires — exactly the honest
    // refusal a damaged file produces in the browser.
    for (const brand of ["heic", "hevc", "mif1", "msf1"]) {
      const run = await runWorker(
        "heic-to-jpg",
        [new FakeFile(`shot.${brand}`, heicHead(brand), "image/heic")],
        {}
      );
      assert(run.error !== null, `run 8 (${brand}): decode refused`);
      assertEqual(
        run.error?.code,
        "tool.images.errorHeicDecode",
        `run 8: brand ${brand} accepted by sniff, failed decode → errorHeicDecode`
      );
      assertEqual(
        run.error?.detail,
        `shot.${brand}`,
        "run 8: error names the file"
      );
    }
  }

  /* ---- 9. unknown toolId + empty run ---- */
  {
    const unknown = await runWorker(
      "no-such-tool",
      [new FakeFile("photo.webp", redWebp)],
      {}
    );
    assertEqual(
      unknown.error?.code,
      "tool.errorGeneric",
      "run 9: unknown toolId → errorGeneric"
    );

    const empty = await runWorker("webp-to-jpg", [], {});
    assertEqual(
      empty.error?.code,
      "tool.images.errorNoImages",
      "run 9: zero files → errorNoImages"
    );
  }

  /* ---- 10. multi-file run ---- */
  {
    bitmapCloses = 0;
    const run = await runWorker(
      "webp-to-jpg",
      [
        new FakeFile("a.webp", redWebp),
        new FakeFile("b.webp", portraitWebp),
      ],
      {}
    );
    assert(run.error === null, "run 10 (multi): no error", run.error);
    assertEqual(
      run.result?.outputs?.map((o) => o.name),
      ["a.jpg", "b.jpg"],
      "run 10: one output per input"
    );
    assertEqual(run.result?.detail, { files: 2, pages: 2 }, "run 10: detail 2/2");
    const progresses = inbox.filter((m) => m.type === "progress");
    assert(
      progresses.some((m) => m.pct === 46 && m.stage === "processing") &&
        progresses.some((m) => m.pct === 92 && m.stage === "processing"),
      "run 10: per-file progress 46 then 92",
      progresses.map((m) => m.pct)
    );
    const second = await decodeBlob(run.result!.outputs![1].blob);
    assertEqual([second.width, second.height], [40, 100], "run 10: second file dims");
    assert(bitmapCloses === 2, "run 10: both bitmaps closed");
  }
}

async function main(): Promise<void> {
  await part1();
  const part1Passed = passed;
  const part1Failed = failed;
  console.log(`\nPart 1 (wiring): ${part1Passed} passed, ${part1Failed} failed`);

  await part2();
  console.log(
    `\nPart 2 (real worker): ${passed - part1Passed} passed, ${failed - part1Failed} failed`
  );
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});
