/**
 * Smoke test: pdf-lib watermark primitives (P3.6, add-watermark).
 * Verifies BEFORE building the tool:
 *  1. drawText with color/opacity/rotate + widthOfTextAtSize
 *  2. "behind content" = draw, then reorder the Contents array (my stream first)
 *  3. embedPng + drawImage with opacity/rotate
 *  4. WinAnsi throws on Devanagari (honest-error path is required)
 *  5. save + reload keeps the reordered stream order
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFArray,
} from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const OK = (label: string) => console.log(`  ✓ ${label}`);
const FAIL = (label: string, err: unknown) => {
  console.error(`  ✗ ${label}:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
};

const input = readFileSync("download/qa-text-sample.pdf");
const doc = await PDFDocument.load(new Uint8Array(input), {
  updateMetadata: false,
});
const font = await doc.embedFont(StandardFonts.HelveticaBold);
const page = doc.getPage(0);
console.log(`pages=${doc.getPageCount()} size=${page.getWidth()}x${page.getHeight()}`);

// 1. text metrics + draw with all visual options
try {
  const w = font.widthOfTextAtSize("CONFIDENTIAL", 48);
  if (w > 0 && Number.isFinite(w)) OK(`widthOfTextAtSize=${w.toFixed(1)}`);
  else throw new Error(`bad width ${w}`);
  page.drawText("CONFIDENTIAL", {
    x: (page.getWidth() - w) / 2,
    y: page.getHeight() / 2,
    size: 48,
    font,
    color: rgb(0.86, 0.11, 0.17),
    opacity: 0.35,
    rotate: degrees(-45),
  });
  OK("drawText color+opacity+rotate");
} catch (err) {
  FAIL("drawText", err);
}

// 2. behind = reorder Contents (my stream was appended last by addContentStream)
try {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) throw new Error("Contents not array after draw");
  const size = contents.size();
  if (size < 2) throw new Error(`expected >=2 streams, got ${size}`);
  const mine = contents.get(size - 1);
  contents.remove(size - 1);
  contents.insert(0, mine);
  const first = contents.get(0);
  if (first !== mine) throw new Error("reorder failed — first !== mine");
  OK(`Contents reorder behind (array size ${size}, first=mine)`);
} catch (err) {
  FAIL("behind reorder", err);
}

// 3. image watermark: PNG embed + drawImage w/ opacity + rotate
try {
  const png = readFileSync("download/qa-img-alpha.png");
  const img = await doc.embedPng(new Uint8Array(png));
  const page2 = doc.getPage(1) ?? page;
  page2.drawImage(img, {
    x: 60,
    y: 400,
    width: img.width / 4,
    height: img.height / 4,
    opacity: 0.5,
    rotate: degrees(30),
  });
  OK(`embedPng+drawImage (${img.width}x${img.height})`);
} catch (err) {
  FAIL("image watermark", err);
}

// 4. WinAnsi vs Devanagari — must THROW so the worker can show the honest error
try {
  const t = "गोपनीय";
  font.encodeText(t);
  FAIL("WinAnsi Devanagari — did NOT throw (unexpected!)", "no error");
} catch {
  OK("WinAnsi Devanagari throws (honest-error path required)");
}

// 5. save + reload — output must parse + my stream first on page 1
try {
  const saved = await doc.save({ useObjectStreams: false });
  writeFileSync("download/qa-wm-smoke.pdf", saved);
  const reload = await PDFDocument.load(saved, { updateMetadata: false });
  const p1 = reload.getPage(0);
  const c = p1.node.Contents();
  if (!(c instanceof PDFArray)) throw new Error("reload Contents not array");
  const raw = (c.get(0) as { getContents?: () => Uint8Array }).getContents?.();
  const text = raw ? Buffer.from(raw).toString("latin1") : "";
  if (text.includes("CONFIDENTIAL")) OK("reload: first stream contains the watermark text (behind order kept)");
  else {
    console.log("   first stream head:", text.slice(0, 120));
    throw new Error("first stream does not contain watermark ops");
  }
} catch (err) {
  FAIL("save+reload", err);
}

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
