/**
 * Compress PDF fixture + PURE-ENGINE smoke (P3.12).
 *
 * Part 1 (needs PIL, run once): generate the source photos
 *   download/qa-p312-photo.jpg    2200x1500 noisy gradient  (DCTDecode)
 *   download/qa-p312-flat.png     1400x1000 flat RGB        (FlateDecode RGB)
 *   download/qa-p312-alpha.png    900x700  with alpha       (Flate + SMask)
 * Part 2 (bun): assemble download/qa-p312-fixture.pdf with pdf-lib —
 *   page 1: selectable text + the big JPEG photo
 *   page 2: selectable text + the flat PNG (Flate RGB)
 *   page 3: selectable text + the alpha PNG (Flate RGB + SMask)
 *   page 4: text only (nothing to compress)
 * Part 3: PURE ENGINE checks (no canvas):
 *   - resolveParams preset/custom clamping
 *   - collectImageCandidates finds 3 images, skips the SMask itself
 *   - classifyImage maps DCT→jpeg, Flate RGB→raw-rgb, SMask→excluded
 *   - targetSize never upscales; grayscale luminance math
 *   - replaceImageStream assigns a DCTDecode stream with carried /SMask
 *   - classify of Indexed/CMYK/JPX skip paths
 *
 * Run: python3 scripts/make-compress-images.py && bun scripts/smoke-compress.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import {
  classifyImage,
  collectImageCandidates,
  indexedPalette,
  replaceImageStream,
  resolveParams,
  targetSize,
  grayscaleImageData,
  COMPRESS_PRESETS,
} from "../tools/compress-pdf/engine";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  /* ---------- Part 2: assemble the fixture ---------- */
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const photoBytes = await readFile("download/qa-p312-photo.jpg");
  const flatBytes = await readFile("download/qa-p312-flat.png");
  const alphaBytes = await readFile("download/qa-p312-alpha.png");
  const photo = await doc.embedJpg(photoBytes);
  const flat = await doc.embedPng(flatBytes);
  const alpha = await doc.embedPng(alphaBytes);

  const text = (
    page: ReturnType<PDFDocument["addPage"]>,
    n: number,
    label: string
  ) => {
    page.drawText("Compress QA Fixture", {
      x: 40,
      y: 780,
      size: 22,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(
      `Page ${n} — ${label}. This line is selectable text and must survive compression.`,
      { x: 40, y: 750, size: 11, font, color: rgb(0.25, 0.25, 0.25) }
    );
  };

  const p1 = doc.addPage([612, 792]);
  text(p1, 1, "JPEG photo (DCTDecode)");
  p1.drawImage(photo, { x: 40, y: 250, width: 532, height: 363 });

  const p2 = doc.addPage([612, 792]);
  text(p2, 2, "flat PNG (FlateDecode RGB)");
  p2.drawImage(flat, { x: 40, y: 280, width: 480, height: 343 });

  const p3 = doc.addPage([612, 792]);
  text(p3, 3, "PNG with alpha (Flate RGB + SMask)");
  p3.drawImage(alpha, { x: 100, y: 300, width: 412, height: 321 });

  const p4 = doc.addPage([612, 792]);
  text(p4, 4, "text only");

  const fixture = await doc.save();
  await writeFile("download/qa-p312-fixture.pdf", fixture);
  console.log(`fixture: download/qa-p312-fixture.pdf (${fixture.length} bytes)`);

  /* ---------- Part 3: pure engine checks ---------- */
  console.log("\nresolveParams:");
  const rec = resolveParams({ preset: "recommended" });
  check(
    "recommended preset",
    rec.quality === COMPRESS_PRESETS.recommended.quality &&
      rec.maxDim === COMPRESS_PRESETS.recommended.maxDim
  );
  const strong = resolveParams({ preset: "strong", quality: 99 });
  check(
    "preset overrides custom fields",
    strong.quality === 0.45 && strong.maxDim === 1200
  );
  const custom = resolveParams({
    preset: "custom",
    quality: 250,
    maxDim: -5,
    grayscale: true,
    stripMetadata: true,
  });
  check(
    "custom clamps quality 0.2..0.97 + maxDim 200..8000",
    custom.quality === 0.97 && custom.maxDim === 200
  );
  check("custom flags pass through", custom.grayscale && custom.stripMetadata);

  console.log("\ncollectImageCandidates:");
  const reloaded = await PDFDocument.load(fixture, { updateMetadata: false });
  const candidates = collectImageCandidates(reloaded);
  check("found 3 images (photo, flat, alpha)", candidates.length === 3,
    `got ${candidates.length}`);
  const strategies = candidates
    .map((c) => `${c.strategy}@${c.width}x${c.height}`)
    .sort();
  console.log(`    ${strategies.join(", ")}`);
  check(
    "photo is jpeg 2200x1500",
    candidates.some(
      (c) => c.strategy === "jpeg" && c.width === 2200 && c.height === 1500
    )
  );
  check(
    "flat png is raw-rgb",
    candidates.some((c) => c.strategy === "raw-rgb")
  );
  check(
    "alpha png kept (SMask excluded separately)",
    candidates.some((c) => c.strategy === "raw-rgb" && c.width === 900)
  );

  // The SMask gray image (obj 17, 900x700 DeviceGray) must NOT be among the
  // candidates — its bytes are the alpha channel of the RGB image.
  const grayRefs: string[] = [];
  for (const [ref, obj] of reloaded.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const st = obj.dict.lookup(PDFName.of("Subtype"));
      const cs = obj.dict.lookup(PDFName.of("ColorSpace"));
      if (
        st instanceof PDFName &&
        st === PDFName.of("Image") &&
        cs instanceof PDFName &&
        cs === PDFName.of("DeviceGray")
      ) {
        grayRefs.push(ref.toString());
      }
    }
  }
  const grayCandidate = candidates.find((c) => c.strategy === "raw-gray");
  check(
    "SMask gray image exists in doc but is excluded from candidates",
    grayRefs.length === 1 && grayCandidate === undefined,
    grayRefs.join(",") || "none"
  );

  console.log("\ntargetSize + grayscale:");
  const t1 = targetSize(2200, 1500, 1600);
  check("scales down 2200→1600 wide", t1.width === 1600 && t1.height === Math.round(1500 * (1600 / 2200)));
  const t2 = targetSize(800, 600, 1600);
  check("never upscales", t2.width === 800 && t2.height === 600);
  const t3 = targetSize(1000, 1000, 0);
  check("maxDim 0 = no cap", t3.width === 1000);

  const lum = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  grayscaleImageData(lum);
  check(
    "luminance: red(255,0,0)→76, green(0,255,0)→150",
    lum[0] === 76 && lum[4] === 150
  );

  console.log("\nclassifyImage skip paths:");
  // context.obj() converts strings→PDFName, numbers→PDFNumber — the same
  // shape a parsed document produces.
  const mkDict = (entries: Record<string, unknown>): PDFDict =>
    reloaded.context.obj(entries as never) as unknown as PDFDict;
  const stream = () => PDFRawStream.of(mkDict({}), new Uint8Array(16));
  check(
    "JPXDecode → skip",
    classifyImage(
      mkDict({ Filter: "JPXDecode", Width: 10, Height: 10, BitsPerComponent: 8 }),
      stream()
    ) === "skip"
  );
  check(
    "ImageMask → skip",
    classifyImage(
      mkDict({ ImageMask: 1, Width: 10, Height: 10 }),
      stream()
    ) === "skip"
  );
  check(
    "DeviceCMYK Flate → raw-cmyk",
    classifyImage(
      mkDict({
        Filter: "FlateDecode",
        Width: 10,
        Height: 10,
        BitsPerComponent: 8,
        ColorSpace: "DeviceCMYK",
      }),
      stream()
    ) === "raw-cmyk"
  );
  // /Indexed arrays carry the palette lookup as PDFString in parsed files —
  // context.obj would turn a plain string into a PDFName, so build the
  // array explicitly like the parser does.
  const idxDict = mkDict({
    Filter: "FlateDecode",
    Width: 10,
    Height: 10,
    BitsPerComponent: 8,
  });
  const idxArray = PDFArray.withContext(reloaded.context);
  idxArray.push(PDFName.of("Indexed"));
  idxArray.push(PDFName.of("DeviceRGB"));
  idxArray.push(reloaded.context.obj(3));
  idxArray.push(PDFString.of("\u0001\u0002\u0003\u0004\u0005\u0006"));
  idxDict.set(PDFName.of("ColorSpace"), idxArray);
  check(
    "Indexed → indexed + palette inline",
    classifyImage(idxDict, stream()) === "indexed" &&
      indexedPalette(idxDict)?.baseComponents === 3
  );

  console.log("\nreplaceImageStream:");
  const target = candidates.find((c) => c.strategy === "jpeg")!;
  const fakeJpeg = new Uint8Array(2000).fill(0xff);
  replaceImageStream(reloaded.context, target, fakeJpeg, 1600, 1091);
  const after = reloaded.context.lookup(target.ref);
  check(
    "ref now a DCTDecode image 1600x1091 DeviceRGB",
    after instanceof PDFRawStream &&
      after.dict.lookup(PDFName.of("Filter"))?.toString() === "/DCTDecode" &&
      (after.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber() === 1600 &&
      (after.dict.lookup(PDFName.of("Height")) as PDFNumber).asNumber() === 1091 &&
      after.contents.length === 2000
  );
  check(
    "original refs for other images untouched",
    candidates
      .filter((c) => c !== target)
      .every((c) => c.stream.contents.length > 0)
  );

  const alphaImg = candidates.find((c) => c.width === 900)!;
  const smaskRef = alphaImg.stream.dict.get(PDFName.of("SMask"));
  replaceImageStream(reloaded.context, alphaImg, fakeJpeg, 900, 700);
  const afterAlpha = reloaded.context.lookup(alphaImg.ref) as PDFRawStream;
  check(
    "SMask ref carried into the replacement",
    String(afterAlpha.dict.get(PDFName.of("SMask"))) === String(smaskRef),
    String(smaskRef)
  );

  // ICCBased with N=3
  const iccDict = mkDict({
    Filter: "FlateDecode",
    Width: 10,
    Height: 10,
    BitsPerComponent: 8,
    ColorSpace: ["ICCBased", 3],
  });
  check(
    "ICCBased N=3 → raw-rgb",
    classifyImage(iccDict, stream()) === "raw-rgb"
  );

  const resaved = await reloaded.save({ useObjectStreams: true });
  const round = await PDFDocument.load(resaved, { updateMetadata: false });
  check(
    "replaced doc reloads with 4 pages + 4 image objects",
    round.getPageCount() === 4 &&
      collectImageCandidates(round).length === 3
  );

  console.log(
    `\n${passed} passed, ${failed} failed${failed === 0 ? " — ALL PASS" : ""}`
  );
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
