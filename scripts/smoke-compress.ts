/**
 * Compress PDF fixture + PURE-ENGINE smoke (P3.12) — OWN-ENGINE EDITION (P6-r).
 *
 * Part 1 (needs PIL, run once): generate the source photos
 *   download/qa-p312-photo.jpg    2200x1500 noisy gradient  (DCTDecode)
 *   download/qa-p312-flat.png     1400x1000 flat RGB        (FlateDecode RGB)
 *   download/qa-p312-alpha.png    900x700  with alpha       (Flate + SMask)
 *   download/qa-p312-gray.png     600x400 grayscale         (FlateDecode gray)
 * Part 2 (bun): assemble download/qa-p312-fixture.pdf with pdf-lib (the
 *   DEV-TIME ORACLE — fixtures only; runtime is 100% our engine):
 *   page 1: selectable text + the big JPEG photo
 *   page 2: selectable text + the flat PNG (Flate RGB)
 *   page 3: selectable text + the alpha PNG (Flate RGB + SMask)
 *   page 4: text only (nothing to compress)
 * Part 3: PURE ENGINE checks (no canvas):
 *   - resolveParams preset/custom clamping
 *   - image discovery + decode-strategy classification (own object model)
 *   - replacement dict building + rewriteDocument round-trips
 *   - R4-b: dedupeImageXObjects — byte-identical duplicate image
 *     XObjects merge onto ONE shared object (references retargeted,
 *     honest counts), signature/byte-compare guards keep distinct and
 *     SMask-differing images apart, real-worker E2E reports
 *     dedupedImages/dedupeBytesSaved and the output strict-reloads
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
  PDFRef,
  PDFString,
} from "pdf-lib";
import {
  parsePdf,
  rewriteDocument,
  type PdfObj,
} from "../src/lib/own/pdf";
import {
  classifyImage,
  collectImageCandidates,
  dedupeImageXObjects,
  imageReplacement,
  indexedPalette,
  resolveParams,
  targetSize,
  grayscaleImageData,
  COMPRESS_PRESETS,
} from "../tools/compress-pdf/engine";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

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

/** Own-engine dict literal: {k:"name",v} | {k:"num",n} | nested arrays. */
function ownDict(
  entries: Record<string, PdfObj | number | string>
): Map<string, PdfObj> {
  const m = new Map<string, PdfObj>();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "number") m.set(key, { k: "num", n: value });
    else if (typeof value === "string") m.set(key, { k: "name", v: value });
    else m.set(key, value);
  }
  return m;
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

  /* ---------- Part 3: pure engine checks (OWN) ---------- */
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

  console.log("\ncollectImageCandidates (own engine):");
  const own = parsePdf(fixture);
  const candidates = collectImageCandidates(own);
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

  // The SMask gray image (900x700 DeviceGray) must NOT be among the
  // candidates — its bytes are the alpha channel of the RGB image.
  // (Object numbers are shared: our parser and pdf-lib read the SAME file.)
  const grayNums: number[] = [];
  for (const [num, entry] of own.entries) {
    if (entry.type === 0) continue;
    const obj = own.getObject(num);
    if (
      obj &&
      obj.k === "stream" &&
      obj.m.get("Subtype")?.k === "name" &&
      (obj.m.get("Subtype") as { v: string }).v === "Image" &&
      obj.m.get("ColorSpace")?.k === "name" &&
      (obj.m.get("ColorSpace") as { v: string }).v === "DeviceGray"
    ) {
      grayNums.push(num);
    }
  }
  const grayCandidate = candidates.find((c) => c.strategy === "raw-gray");
  check(
    "SMask gray image exists in doc but is excluded from candidates",
    grayNums.length === 1 && grayCandidate === undefined,
    grayNums.join(",") || "none"
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

  console.log("\nclassifyImage skip paths (own dicts):");
  check(
    "JPXDecode → skip",
    classifyImage(ownDict({ Filter: "JPXDecode", Width: 10, Height: 10, BitsPerComponent: 8 })) === "skip"
  );
  check(
    "ImageMask → skip",
    classifyImage(ownDict({ ImageMask: 1, Width: 10, Height: 10 })) === "skip"
  );
  check(
    "DeviceCMYK Flate → raw-cmyk",
    classifyImage(
      ownDict({
        Filter: "FlateDecode",
        Width: 10,
        Height: 10,
        BitsPerComponent: 8,
        ColorSpace: "DeviceCMYK",
      })
    ) === "raw-cmyk"
  );
  // /Indexed arrays carry the palette lookup as a string in parsed files —
  // the own parser materializes it as a hex-string object.
  const idxDict = ownDict({
    Filter: "FlateDecode",
    Width: 10,
    Height: 10,
    BitsPerComponent: 8,
  });
  idxDict.set("ColorSpace", {
    k: "arr",
    items: [
      { k: "name", v: "Indexed" },
      { k: "name", v: "DeviceRGB" },
      { k: "num", n: 3 },
      { k: "hstr", b: Uint8Array.from([1, 2, 3, 4, 5, 6]) },
    ],
  });
  check(
    "Indexed → indexed + palette inline",
    classifyImage(idxDict) === "indexed" &&
      indexedPalette(own, idxDict)?.baseComponents === 3
  );
  const iccDict = ownDict({
    Filter: "FlateDecode",
    Width: 10,
    Height: 10,
    BitsPerComponent: 8,
    ColorSpace: {
      k: "arr",
      items: [{ k: "name", v: "ICCBased" }, { k: "num", n: 3 }],
    },
  });
  check(
    "ICCBased N=3 → raw-rgb",
    classifyImage(iccDict) === "raw-rgb"
  );

  console.log("\nimageReplacement + rewriteDocument:");
  const target = candidates.find((c) => c.strategy === "jpeg")!;
  const fakeJpeg = new Uint8Array(2000).fill(0xff);
  const [targetNum, replacement] = imageReplacement(target, fakeJpeg, 1600, 1091);
  const replacedBytes = rewriteDocument(own, {
    replacements: new Map([[targetNum, replacement]]),
    objectStreams: true,
  });
  const afterReload = await PDFDocument.load(replacedBytes, {
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  const after = afterReload.context.lookup(PDFRef.of(target.num));
  check(
    "ref now a DCTDecode image 1600x1091 DeviceRGB",
    after instanceof PDFRawStream &&
      after.dict.lookup(PDFName.of("Filter"))?.toString() === "/DCTDecode" &&
      (after.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber() === 1600 &&
      (after.dict.lookup(PDFName.of("Height")) as PDFNumber).asNumber() === 1091 &&
      after.contents.length === 2000
  );
  check(
    "original streams for other images untouched",
    candidates
      .filter((c) => c !== target)
      .every((c) => c.stream.raw.length > 0)
  );

  const alphaImg = candidates.find((c) => c.width === 900)!;
  const smaskRef = alphaImg.stream.m.get("SMask");
  const [, alphaReplacement] = imageReplacement(alphaImg, fakeJpeg, 900, 700);
  const alphaReplaced = rewriteDocument(own, {
    replacements: new Map([[alphaImg.num, alphaReplacement]]),
    objectStreams: true,
  });
  const afterAlphaReload = await PDFDocument.load(alphaReplaced, {
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  const afterAlpha = afterAlphaReload.context.lookup(
    PDFRef.of(alphaImg.num)
  ) as PDFRawStream;
  check(
    "SMask ref carried into the replacement",
    afterAlpha !== undefined &&
      afterAlpha.dict.get(PDFName.of("SMask")) !== undefined &&
      afterAlpha.dict.get(PDFName.of("SMask"))!.toString() ===
        (smaskRef ? `${(smaskRef as { num: number }).num} 0 R` : ""),
    String(afterAlpha?.dict.get(PDFName.of("SMask")))
  );

  const round = parsePdf(replacedBytes);
  check(
    "replaced doc reloads with 4 pages + 3 image candidates",
    (await PDFDocument.load(replacedBytes, { updateMetadata: false })).getPageCount() === 4 &&
      collectImageCandidates(round).length === 3
  );

  /* ---------- R4-b: dedupeImageXObjects (own engine) ---------- */
  console.log("\ndedupeImageXObjects (R4-b):");

  /** 30×30 RGB raw pixels, unfiltered → the re-encode must skip it. */
  const rawPixels = (seed: number, len = 30 * 30 * 3): Uint8Array => {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = (seed + i * 7) & 0xff;
    return bytes;
  };
  const imageDict = (
    doc_: PDFDocument,
    width: number,
    height: number
  ): PDFDict => {
    const dict = PDFDict.withContext(doc_.context);
    dict.set(PDFName.of("Type"), PDFName.of("XObject"));
    dict.set(PDFName.of("Subtype"), PDFName.of("Image"));
    dict.set(PDFName.of("Width"), PDFNumber.of(width));
    dict.set(PDFName.of("Height"), PDFNumber.of(height));
    dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    return dict;
  };
  const drawContent = (names: string[]): Uint8Array =>
    new TextEncoder().encode(
      names
        .map(
          (n, i) => `q 100 0 0 100 ${40 + i * 120} 100 cm /${n} Do Q`
        )
        .join("\n") + "\n"
    );

  /** DedupeResult as a printable string (check() takes string extras). */
  const showDedupe = (r: {
    mergedCount: number;
    mergedGroups: number;
    bytesSaved: number;
    keeperOf: Map<number, number>;
  }): string =>
    JSON.stringify({ ...r, keeperOf: [...r.keeperOf.entries()] });

  /** One page whose resources point at the given image refs. */
  const buildDupFixture = async (): Promise<{
    bytes: Uint8Array;
    refs: PDFRef[];
  }> => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const refA = doc.context.register(
      PDFRawStream.of(imageDict(doc, 30, 30), rawPixels(1))
    );
    const refB = doc.context.register(
      PDFRawStream.of(imageDict(doc, 30, 30), rawPixels(1)) // SAME bytes
    );
    const refC = doc.context.register(
      PDFRawStream.of(imageDict(doc, 30, 30), rawPixels(200)) // distinct bytes
    );
    page.node.setXObject(PDFName.of("Im0"), refA);
    page.node.setXObject(PDFName.of("Im1"), refB);
    page.node.setXObject(PDFName.of("Im2"), refC);
    const contentBytes = drawContent(["Im0", "Im1", "Im2"]);
    const contentDict = PDFDict.withContext(doc.context);
    contentDict.set(PDFName.of("Length"), PDFNumber.of(contentBytes.length));
    const realContent = doc.context.register(
      PDFRawStream.of(contentDict, contentBytes)
    );
    page.node.set(PDFName.of("Contents"), realContent);
    return { bytes: await doc.save({ useObjectStreams: false }), refs: [refA, refB, refC] };
  };

  {
    // Honest-zero control: a doc whose images all DIFFER (no fixture dup).
    const noDupDoc = await PDFDocument.create();
    const noDupPage = noDupDoc.addPage([300, 400]);
    const ndA = noDupDoc.context.register(
      PDFRawStream.of(imageDict(noDupDoc, 30, 30), rawPixels(1))
    );
    const ndB = noDupDoc.context.register(
      PDFRawStream.of(imageDict(noDupDoc, 30, 30), rawPixels(200))
    );
    noDupPage.node.setXObject(PDFName.of("Im0"), ndA);
    noDupPage.node.setXObject(PDFName.of("Im1"), ndB);
    const r0 = dedupeImageXObjects(
      parsePdf(await noDupDoc.save({ useObjectStreams: false }))
    );
    check(
      "no duplicates → honest zero merge (≥2 rule)",
      r0.mergedCount === 0 && r0.bytesSaved === 0 && r0.mergedGroups === 0,
      JSON.stringify({ ...r0, keeperOf: [...r0.keeperOf.entries()] })
    );

    const plain = await buildDupFixture();
    const before = plain.bytes.length;

    const doc2 = parsePdf(plain.bytes);
    const refs = plain.refs;
    const result = dedupeImageXObjects(doc2);
    check(
      "two byte-identical images → 1 merge, 1 group",
      result.mergedCount === 1 && result.mergedGroups === 1,
      showDedupe(result)
    );
    check(
      "bytes saved = the duplicate's raw stream (2700 bytes)",
      result.bytesSaved === 30 * 30 * 3,
      String(result.bytesSaved)
    );
    check(
      "keeper = lowest object number; dup remaps onto it",
      result.keeperOf.get(refs[1].objectNumber) === refs[0].objectNumber,
      JSON.stringify([...result.keeperOf.entries()])
    );
    const savedDedup = rewriteDocument(doc2, {
      deletions: result.deletions,
      objectStreams: false,
    });
    const reload = await PDFDocument.load(savedDedup, {
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    check(
      "distinct bytes with the SAME dict signature are NOT merged",
      reload.context.lookup(refs[2]) instanceof PDFRawStream,
    );
    check(
      "duplicate object deleted from the output",
      reload.context.lookup(refs[1]) === undefined,
    );
    const page = reload.getPages()[0];
    const im1 = page.node.normalizedEntries().XObject?.get(PDFName.of("Im1"));
    check(
      "page resource /Im1 retargeted onto the keeper",
      im1 instanceof PDFRef && im1.objectNumber === refs[0].objectNumber,
      String(im1)
    );
    check(
      "size reduction: deduped save < untouched save",
      savedDedup.length < before,
      `${savedDedup.length} vs ${before}`
    );
    check("deduped doc strict-reloads, 1 page", reload.getPageCount() === 1);
    check(
      "reloaded doc: exactly 2 image objects remain + 0 candidates (skip)",
      collectImageCandidates(parsePdf(savedDedup)).length === 0 &&
        [...reload.context.enumerateIndirectObjects()].filter(
          ([, o]) =>
            o instanceof PDFRawStream &&
            o.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image")
        ).length === 2,
    );

    // Idempotence: deduping again finds nothing.
    const again = dedupeImageXObjects(parsePdf(savedDedup));
    check("idempotent: second run merges 0", again.mergedCount === 0, showDedupe(again));

    // SMask guard: two identical images whose /SMask refs differ must NOT
    // merge — sharing would steal one image's alpha channel.
    const smaskDoc = await PDFDocument.create();
    const smaskA = smaskDoc.context.register(
      PDFRawStream.of(imageDict(smaskDoc, 8, 8), rawPixels(9, 8 * 8))
    );
    const smaskB = smaskDoc.context.register(
      PDFRawStream.of(imageDict(smaskDoc, 8, 8), rawPixels(77, 8 * 8))
    );
    const withMask = (mask: PDFRef): PDFRawStream => {
      const dict = imageDict(smaskDoc, 30, 30);
      dict.set(PDFName.of("SMask"), mask);
      return PDFRawStream.of(dict, rawPixels(1));
    };
    smaskDoc.context.register(withMask(smaskA));
    smaskDoc.context.register(withMask(smaskB));
    const smaskResult = dedupeImageXObjects(
      parsePdf(await smaskDoc.save({ useObjectStreams: false }))
    );
    check(
      "SMask-differing twins stay separate (no alpha theft)",
      smaskResult.mergedCount === 0,
      showDedupe(smaskResult)
    );
  }

  console.log("\nREAL worker E2E (shimmed self): dedupe detail + honest zero");
  {
    const workerGlobal = globalThis as unknown as {
      postMessage: (msg: unknown) => void;
      onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
      location: { href: string };
    };
    const messages: WorkerResponse[] = [];
    workerGlobal.postMessage = (msg: unknown): void => {
      messages.push(msg as WorkerResponse);
    };
    workerGlobal.location = { href: "http://localhost/" };
    (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
    await import("../tools/compress-pdf/worker");
    check(
      "worker: module loaded, onmessage registered",
      typeof workerGlobal.onmessage === "function"
    );

    const drive = async (
      runId: number,
      bytes: Uint8Array,
      name: string
    ): Promise<WorkerResponse> => {
      const before = messages.length;
      workerGlobal.onmessage!({
        data: {
          type: "run",
          runId,
          toolId: "compress-pdf",
          options: { preset: "recommended" },
          files: [new File([bytes as BlobPart], name)],
        } as WorkerRunRequest,
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          break;
        }
        if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return messages
        .slice(before)
        .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
    };

    const dupBytes = (await buildDupFixture()).bytes;
    const r1 = await drive(1, dupBytes, "dup.pdf");
    check(
      "worker E2E: dup fixture → result with dedupedImages 1 + honest bytes",
      r1.type === "result" &&
        (r1.detail as Record<string, unknown> | undefined)?.dedupedImages === 1 &&
        (r1.detail as Record<string, unknown> | undefined)?.dedupeBytesSaved ===
          30 * 30 * 3,
      r1.type === "result" ? JSON.stringify(r1.detail) : JSON.stringify(r1)
    );
    if (r1.type === "result") {
      const outBytes = new Uint8Array(await r1.outputs[0].blob.arrayBuffer());
      const reload = await PDFDocument.load(outBytes, {
        throwOnInvalidObject: true,
      });
      check(
        "worker E2E: output strict-reloads with 1 page",
        reload.getPageCount() === 1,
      );
    }

    const noDup = await PDFDocument.create();
    const lonePage = noDup.addPage([300, 300]);
    const lone = noDup.context.register(
      PDFRawStream.of(imageDict(noDup, 30, 30), rawPixels(5))
    );
    lonePage.node.setXObject(PDFName.of("Im0"), lone);
    const r2 = await drive(
      2,
      new Uint8Array(await noDup.save({ useObjectStreams: false })),
      "single.pdf"
    );
    check(
      "worker E2E: no duplicates → detail carries NO dedupe keys (honest zero)",
      r2.type === "result" &&
        r2.detail !== undefined &&
        !("dedupedImages" in r2.detail) &&
        !("dedupeBytesSaved" in r2.detail),
      r2.type === "result" ? JSON.stringify(r2.detail) : JSON.stringify(r2)
    );
    /* ---------- R6-b honesty: batch refusal names the locked file ---------- */
    {
      // compress-pdf takes up to 5 files, so the encrypted/corrupt toast must
      // NAME the file that stopped the run (merge-pdf standard). The worker
      // probes STRUCTURALLY (own parser: PdfError code "encrypted") and both
      // refusals carry the file name in detail.
      const workerSrc = await readFile("tools/compress-pdf/worker.ts", "utf8");
      check(
        "worker: structural encrypted probe via the own parser",
        workerSrc.includes("parsePdf(bytes)") &&
          workerSrc.includes('error.code === "encrypted"') &&
          workerSrc.includes('code: "tool.errorEncrypted"')
      );
      check(
        "worker: encrypted + corrupt refusals carry the file name",
        workerSrc.includes('code: "tool.errorEncrypted"') &&
          workerSrc.includes("/password|encrypt/i.test(message)") &&
          (workerSrc.match(/detail: name/g)?.length ?? 0) === 2
      );

      const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
      const encDoc = await CantooDoc.create();
      encDoc.addPage([300, 300]);
      encDoc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
      const encBytes = new Uint8Array(
        await encDoc.save({ useObjectStreams: false })
      );
      const fineDoc = await PDFDocument.create();
      fineDoc.addPage([300, 300]);
      const fine = new Uint8Array(await fineDoc.save({ useObjectStreams: false }));

      const before = messages.length;
      workerGlobal.onmessage!({
        data: {
          type: "run",
          runId: 3,
          toolId: "compress-pdf",
          options: { preset: "recommended" },
          files: [
            new File([fine as BlobPart], "annual-report.pdf"),
            new File([encBytes as BlobPart], "locked-scan.pdf"),
          ],
        } as WorkerRunRequest,
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === 3 && (m.type === "result" || m.type === "error"))
        ) {
          break;
        }
        if (Date.now() > deadline) throw new Error("run 3 did not finish");
        await new Promise((r) => setTimeout(r, 10));
      }
      const batch = messages.slice(before);
      const batchErrors = batch.filter(
        (m) => m.type === "error"
      ) as Extract<WorkerResponse, { type: "error" }>[];
      check("batch: exactly ONE error, no result", batchErrors.length === 1 && !batch.some((m) => m.type === "result"), JSON.stringify(batch.map((m) => m.type)));
      check("batch: code is tool.errorEncrypted", batchErrors[0]?.code === "tool.errorEncrypted", batchErrors[0]?.code);
      check(
        "batch: refusal NAMES the locked file (detail)",
        batchErrors[0]?.detail === "locked-scan.pdf",
        batchErrors[0]?.detail
      );
    }
  }

  /* ---------- R4-b browser-QA fixture: duplicate DCT photos ---------- */
  {
    // Two pages, each embedding the SAME JPEG as its own XObject — the
    // letterhead shape. The browser run dedupes (1 chip) AND re-encodes.
    const photo = await readFile("download/qa-p312-photo.jpg");
    const qaDoc = await PDFDocument.create();
    for (let p = 0; p < 2; p += 1) {
      const page = qaDoc.addPage([612, 792]);
      const ref = qaDoc.context.register(
        PDFRawStream.of(
          (() => {
            const d = PDFDict.withContext(qaDoc.context);
            d.set(PDFName.of("Type"), PDFName.of("XObject"));
            d.set(PDFName.of("Subtype"), PDFName.of("Image"));
            d.set(PDFName.of("Width"), PDFNumber.of(2200));
            d.set(PDFName.of("Height"), PDFNumber.of(1500));
            d.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
            d.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
            d.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
            return d;
          })(),
          photo
        )
      );
      page.node.setXObject(PDFName.of(`Im${p}`), ref);
      const content = new TextEncoder().encode(
        "q 532 0 0 363 40 250 cm /Im" + p + " Do Q\n"
      );
      page.node.set(
        PDFName.of("Contents"),
        qaDoc.context.register(
          PDFRawStream.of(
            (() => {
              const d = PDFDict.withContext(qaDoc.context);
              d.set(PDFName.of("Length"), PDFNumber.of(content.length));
              return d;
            })(),
            content
          )
        )
      );
    }
    const qaBytes = new Uint8Array(await qaDoc.save({ useObjectStreams: false }));
    await writeFile("public/qa/audit4-dedupe-fixture.pdf", qaBytes);
    const qaCheck = dedupeImageXObjects(parsePdf(qaBytes));
    check(
      "QA fixture: 2 duplicate DCT photos → merges to 1 shared object",
      qaCheck.mergedCount === 1,
      showDedupe(qaCheck)
    );
    console.log(
      `QA fixture: public/qa/audit4-dedupe-fixture.pdf (${qaBytes.length} bytes)`
    );
  }

  console.log(
    `\n${passed} passed, ${failed} failed${failed === 0 ? " — ALL PASS" : ""}`
  );
  // Unconditional exit: on success, dangling sharp/worker shims keep bun's
  // event loop alive forever (the smoke completed but never terminated —
  // battery timeouts). House pattern: exit with the verdict, always.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
