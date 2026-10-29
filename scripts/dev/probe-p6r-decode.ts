/**
 * P6-r-a probe: stream-decode parity vs the pdf-lib ORACLE.
 *
 * Fixture (pdf-lib authored, both engines parse the SAME bytes):
 *   - Flate gray (embedded L-mode PNG)      → decodeStreamBytes
 *   - Flate RGB  (embedded RGB PNG)         → decodeStreamBytes
 *   - LZW gray   (strip bytes from a PIL LZW TIFF — same algorithm as
 *     PDF LZW with EarlyChange 1)           → decodeStreamBytes
 *   - Indexed + stream-backed Flate palette → decodeStreamBytes on the
 *     palette stream AND the indices stream
 *   - CMYK DCT (embedded Adobe CMYK JPEG)   → both engines must REFUSE
 *
 * Every decodable stream must match pdf-lib's decodePDFRawStream
 * byte-for-byte. Run: python3 scripts/make-compress-images.py && bun <this>
 */
import { readFile } from "node:fs/promises";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFDocument,
  decodePDFRawStream,
} from "pdf-lib";
import { zlibSync } from "../../src/lib/own/zip";
import {
  parsePdf,
  decodeStreamBytes,
  type ParsedPdf,
  type PdfObj,
} from "../../src/lib/own/pdf";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ── fixture ─────────────────────────────────────────────────────── */

const oracle = await PDFDocument.create();
const page = oracle.addPage([300, 300]);

const png = async (path: string) => oracle.embedPng(await readFile(path));
const grayEmb = await png("download/qa-p312-gray.png");
const rgbEmb = await png("download/qa-p312-flat.png");
page.drawImage(grayEmb, { x: 0, y: 200, width: 100, height: 80 });
page.drawImage(rgbEmb, { x: 150, y: 200, width: 100, height: 80 });

// LZW image: raw strip bytes from PIL's LZW TIFF.
const lzwStrip = await readFile("download/qa-p312-lzw.bin");
{
  const d = PDFDict.withContext(oracle.context);
  d.set(PDFName.of("Type"), PDFName.of("XObject"));
  d.set(PDFName.of("Subtype"), PDFName.of("Image"));
  d.set(PDFName.of("Width"), PDFNumber.of(64));
  d.set(PDFName.of("Height"), PDFNumber.of(64));
  d.set(PDFName.of("ColorSpace"), PDFName.of("DeviceGray"));
  d.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  d.set(PDFName.of("Filter"), PDFName.of("LZWDecode"));
  const lzwRef = oracle.context.register(PDFRawStream.of(d, lzwStrip));
  page.node.setXObject(PDFName.of("ImLzw"), lzwRef);
}

// Indexed image: 64x64 indices (values 0..15) Flate'd + a Flate'd
// STREAM-backed 16×3 palette (the case indexedPalette can't read inline).
{
  const W = 64;
  const H = 64;
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) indices[y * W + x] = (x + y) & 0x0f;
  }
  const palette = new Uint8Array(16 * 3);
  for (let i = 0; i < 16; i += 1) {
    palette[i * 3] = i * 17;
    palette[i * 3 + 1] = 255 - i * 17;
    palette[i * 3 + 2] = (i * 37) & 0xff;
  }
  const palDict = PDFDict.withContext(oracle.context);
  palDict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  const palRef = oracle.context.register(
    PDFRawStream.of(palDict, zlibSync(palette)),
  );

  const idxDict = PDFDict.withContext(oracle.context);
  idxDict.set(PDFName.of("Type"), PDFName.of("XObject"));
  idxDict.set(PDFName.of("Subtype"), PDFName.of("Image"));
  idxDict.set(PDFName.of("Width"), PDFNumber.of(W));
  idxDict.set(PDFName.of("Height"), PDFNumber.of(H));
  const cs = PDFArray.withContext(oracle.context);
  cs.push(PDFName.of("Indexed"));
  cs.push(PDFName.of("DeviceRGB"));
  cs.push(PDFNumber.of(15));
  cs.push(palRef);
  idxDict.set(PDFName.of("ColorSpace"), cs);
  idxDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  idxDict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  const idxRef = oracle.context.register(
    PDFRawStream.of(idxDict, zlibSync(indices)),
  );
  page.node.setXObject(PDFName.of("ImIdx"), idxRef);
}

// CMYK DCT: the browser-classified strategy — decodeStreamBytes must
// refuse, exactly like pdf-lib's decodePDFRawStream.
let cmykJpg: Uint8Array | null = null;
try {
  cmykJpg = await readFile("download/qa-p312-cmyk.jpg");
} catch {
  console.log("  (no CMYK fixture — make-compress-images.py skipped)");
}
if (cmykJpg !== null) {
  const emb = await oracle.embedJpg(cmykJpg);
  page.drawImage(emb, { x: 0, y: 0, width: 200, height: 100 });
}

const bytes = await oracle.save({ useObjectStreams: false });
console.log(`fixture: ${bytes.length} bytes`);

/* ── compare BOTH engines, object by object ─────────────────────── */

const ours: ParsedPdf = parsePdf(bytes);
const theirs = await PDFDocument.load(bytes, { updateMetadata: false });

const imageNums: number[] = [];
for (const [num, entry] of ours.entries) {
  if (entry.type === 0) continue;
  const obj = ours.getObject(num);
  if (obj && obj.k === "stream" && obj.m.get("Subtype")?.k === "name" &&
      (obj.m.get("Subtype") as { v: string }).v === "Image") {
    imageNums.push(num);
  }
}
check("found image objects in the fixture", imageNums.length >= 4, String(imageNums));

let compared = 0;
for (const num of imageNums) {
  const ourObj = ours.getObject(num)!;
  if (ourObj.k !== "stream") continue;
  const ourDict: Map<string, PdfObj> = ourObj.m;
  const filterName = ourDict.get("Filter");
  const filter = filterName && filterName.k === "name" ? filterName.v : "?";

  let ourDecoded: Uint8Array | null = null;
  let ourThrew = false;
  try {
    ourDecoded = decodeStreamBytes((ourObj as { raw: Uint8Array }).raw, ourDict);
  } catch {
    ourThrew = true;
  }

  const theirStream = theirs.context.lookup(PDFRef.of(num));
  let theirDecoded: Uint8Array | null = null;
  let theirThrew = false;
  if (theirStream instanceof PDFRawStream) {
    try {
      theirDecoded = decodePDFRawStream(theirStream).decode();
    } catch {
      theirThrew = true;
    }
  }

  if (ourThrew || theirThrew) {
    check(
      `obj ${num} (${filter}): both engines refuse`,
      ourThrew && theirThrew,
      `ours=${ourThrew} theirs=${theirThrew}`,
    );
    continue;
  }
  compared += 1;
  check(
    `obj ${num} (${filter}): byte-identical decode (${ourDecoded?.length} B)`,
    ourDecoded !== null &&
      theirDecoded !== null &&
      bytesEqual(ourDecoded!, theirDecoded!),
    `ours=${ourDecoded?.length} theirs=${theirDecoded?.length}`,
  );
}

// The stream-backed palette itself (a NON-image stream): resolve through
// the Indexed colorspace array and decode.
for (const num of imageNums) {
  const obj = ours.getObject(num)!;
  if (obj.k !== "stream") continue;
  const cs = obj.m.get("ColorSpace");
  if (!cs || cs.k !== "arr") continue;
  const lookup = cs.items[3];
  if (lookup && lookup.k === "ref") {
    const palObj = ours.getObject(lookup.num);
    if (palObj && palObj.k === "stream") {
      const ourPal = decodeStreamBytes((palObj as { raw: Uint8Array }).raw, palObj.m);
      const theirPalObj = theirs.context.lookup(PDFRef.of(lookup.num));
      if (theirPalObj instanceof PDFRawStream) {
        const theirPal = decodePDFRawStream(theirPalObj).decode();
        check(
          "stream-backed Indexed palette: byte-identical",
          bytesEqual(ourPal, theirPal),
          `${ourPal.length} B`,
        );
      }
    }
  }
}

check("compared ≥ 4 decodable image streams", compared >= 4, String(compared));
console.log(`probe: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
