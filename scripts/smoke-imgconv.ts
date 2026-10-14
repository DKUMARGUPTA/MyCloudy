/**
 * Smoke tests for the imgconv group (P3.17): brand sniffing, HEIC decode
 * correctness against hand-verified probe pixels, error mapping, and the
 * pure naming helpers. Runs under Bun (no DOM needed — libheif is pure
 * wasm; the canvas ENCODE path is covered by agent-browser E2E).
 *
 * Usage: bun scripts/smoke-imgconv.ts
 */
import { readFileSync } from "node:fs";
import {
  isHeifBytes,
  isWebpBytes,
  decodeHeifRgba,
  HEIF_MAX_PIXELS,
  injectLibheifFactory,
} from "../tools/imgconv/libheif";
import {
  sanitizeBase,
  allocateOutputName,
} from "../tools/imgconv/naming";

// Run the decode tests against the VENDORED bundle (public/vendor), not
// the node_modules copy — proving exactly what the browser fetches.
type Factory = (options?: Record<string, unknown>) => unknown;
injectLibheifFactory(
  (await import("../public/vendor/libheif/libheif-bundle.mjs")).default as Factory
);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function heifOf(brand: string, size = 32): Uint8Array {
  // [size][ftyp][brand][minor 0000]
  const head = new Uint8Array(size);
  const brandBytes = [
    brand.charCodeAt(0),
    brand.charCodeAt(1),
    brand.charCodeAt(2),
    brand.charCodeAt(3),
  ];
  head.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70], 0);
  head.set(brandBytes, 8);
  return head;
}

async function main() {
  console.log("== brand sniff: isHeifBytes ==");
  for (const brand of [
    "heic",
    "heix",
    "hevc",
    "heim",
    "heis",
    "hevm",
    "hevs",
    "mif1",
    "mif2",
    "msf1",
    "avic",
  ]) {
    check(`accepts ${brand}`, isHeifBytes(heifOf(brand)));
  }
  // Real fixture heads
  const example = new Uint8Array(
    (readFileSync as unknown as (p: string) => Buffer)(
      "/home/z/my-project/download/qa-icv-example.heic"
    )
  );
  const autumn = new Uint8Array(
    (readFileSync as unknown as (p: string) => Buffer)(
      "/home/z/my-project/download/qa-icv-autumn.heic"
    )
  );
  check("example.heic (mif1) is heif", isHeifBytes(example.slice(0, 16)));
  check("autumn (mif1) is heif", isHeifBytes(autumn.slice(0, 16)));

  check("rejects jpeg", !isHeifBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70])));
  check("rejects png", !isHeifBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])));
  check("rejects short", !isHeifBytes(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79])));
  check("rejects ftyp+iso2 (not HEIF)", !isHeifBytes(heifOf("iso2")));
  check("rejects ftyp+isom (not HEIF)", !isHeifBytes(heifOf("isom")));
  check("rejects ftyp+mp42 (not HEIF)", !isHeifBytes(heifOf("mp42")));

  console.log("== brand sniff: isWebpBytes ==");
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  check("accepts RIFF....WEBP", isWebpBytes(webp));
  const wav = new Uint8Array(12);
  wav.set([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0], 0);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  check("rejects RIFF....WAVE (wav)", !isWebpBytes(wav));
  check("rejects heic as webp", !isWebpBytes(example.slice(0, 12)));
  check("rejects short webp", !isWebpBytes(webp.slice(0, 10)));

  console.log("== decodeHeifRgba: example.heic ==");
  const img1 = await decodeHeifRgba(example);
  check("dims 1280x854", img1.width === 1280 && img1.height === 854, `${img1.width}x${img1.height}`);
  check("no alpha", img1.hasAlpha === false);
  const px1 = (x: number, y: number) => {
    const i = (y * img1.width + x) * 4;
    return [img1.data[i], img1.data[i + 1], img1.data[i + 2], img1.data[i + 3]];
  };
  // Center pixel hand-verified by scripts/probe-heic2.ts on the raw channel.
  check(
    "center px 140,136,92,255",
    JSON.stringify(px1(640, 427)) === "[140,136,92,255]",
    JSON.stringify(px1(640, 427))
  );
  check(
    "corner px 76,82,126,255",
    JSON.stringify(px1(4, 4)) === "[76,82,126,255]",
    JSON.stringify(px1(4, 4))
  );
  check("buffer length", img1.data.length === 1280 * 854 * 4);

  console.log("== decodeHeifRgba: autumn_1440x960.heic ==");
  const img2 = await decodeHeifRgba(autumn);
  check("dims 1440x960", img2.width === 1440 && img2.height === 960, `${img2.width}x${img2.height}`);
  const i2 = (960 / 2) * img2.width * 4 + (1440 / 2) * 4;
  check(
    "center px 44,29,21",
    img2.data[i2] === 44 && img2.data[i2 + 1] === 29 && img2.data[i2 + 2] === 21,
    `${img2.data[i2]},${img2.data[i2 + 1]},${img2.data[i2 + 2]}`
  );

  console.log("== decodeHeifRgba: error mapping ==");
  try {
    await decodeHeifRgba(new Uint8Array(64).fill(0x41));
    check("garbage rejected", false);
  } catch (e) {
    check(
      "garbage → errorNotHeif",
      (e as Error).message === "imgconv\0tool.imgconv.errorNotHeif",
      (e as Error).message
    );
  }
  try {
    // A JPEG renamed .heic — extension lies, magic bytes don't.
    const jpg = readFileSync(
      "/home/z/my-project/download/qa-p34-jpg-page1.jpg"
    );
    await decodeHeifRgba(new Uint8Array(jpg));
    check("jpeg-renamed rejected", false);
  } catch (e) {
    check(
      "jpeg-renamed → errorNotHeif",
      (e as Error).message === "imgconv\0tool.imgconv.errorNotHeif",
      (e as Error).message
    );
  }
  try {
    await decodeHeifRgba(new Uint8Array(autumn.slice(0, 4096)));
    check("truncated rejected", false);
  } catch (e) {
    check(
      "truncated → errorCorrupt",
      (e as Error).message === "imgconv\0tool.imgconv.errorCorrupt",
      (e as Error).message
    );
  }
  check("pixel cap constant", HEIF_MAX_PIXELS === 80_000_000);

  console.log("== naming helpers ==");
  check(
    "sanitize strips any ext",
    sanitizeBase("photo.heic") === "photo" && sanitizeBase("scan.webp") === "scan"
  );
  check(
    "sanitize removes path chars",
    sanitizeBase('a/b:c*d?"e<f>g|.heic') === "a_b_c_d__e_f_g_"
  );
  check("sanitize empty → image", sanitizeBase(".heic") === "image");
  check(
    "sanitize long truncates",
    sanitizeBase("x".repeat(300) + ".heic").length === 120
  );
  const used = new Map<string, number>();
  check(
    "first name plain",
    allocateOutputName("photo", "jpg", used) === "photo.jpg"
  );
  check(
    "collision -2",
    allocateOutputName("photo", "jpg", used) === "photo-2.jpg"
  );
  check(
    "collision -3",
    allocateOutputName("photo", "jpg", used) === "photo-3.jpg"
  );
  check(
    "other base unaffected",
    allocateOutputName("other", "png", used) === "other.png"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
