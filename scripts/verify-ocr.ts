/**
 * P3.14 OCR PDF — machine-verify the browser outputs.
 *
 *   bun scripts/verify-ocr.ts            (scan fixture output)
 *   bun scripts/verify-ocr.ts <file>     (mixed fixture output)
 *
 * Checks the searchable-PDF contract:
 *  ① page count + A4 geometry at 150 DPI (PIL fixture),
 *  ② one full-page JPEG per OCR'd page,
 * ③ the `3 Tr` invisible-operator in each OCR'd page's content stream,
 * ④ embedded fonts: Helvetica for Latin, Type0 Devanagari + ToUnicode for
 *     Hindi,
 *  ⑤ pdftotext recovers the ENGLISH fixture words,
 *  ⑥ pdftotext recovers the HINDI fixture words,
 * ⑦ mixed fixture: page 1 text is copied through 1:1 and carries NO
 *     invisible operator, page 2 is the OCR rebuild.
 */
import "regenerator-runtime/runtime";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";
import { decodePDFRawStream } from "pdf-lib/cjs/core/streams/decode";

const file = process.argv[2] ?? "/home/z/my-project/download/qa-ocr-scan-searchable.pdf";
const mixed = file.includes("mixed");

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${label}${extra ? " — " + extra : ""}`);
}

function pageContents(doc: PDFDocument, index: number): string {
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const chunks: Uint8Array[] = [];
  const pushStream = (stream: PDFRawStream) => {
    chunks.push(decodePDFRawStream(stream).decode());
  };
  const resolved = doc.context.lookup(contents);
  if (resolved instanceof PDFRawStream) {
    pushStream(resolved);
  } else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i += 1) {
      const item = doc.context.lookup(resolved.get(i));
      if (item instanceof PDFRawStream) pushStream(item);
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return Buffer.from(merged).toString("latin1");
}

async function main(): Promise<void> {
  const bytes = await readFile(file);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  console.log(`file: ${file}`);

  // ① geometry
  check(`2 pages`, doc.getPageCount() === 2, String(doc.getPageCount()));
  const p1 = doc.getPage(0);
  const w = p1.getSize().width;
  const h = p1.getSize().height;
  check(
    `page 1 ≈ A4 @150DPI (595.2×841.9)`,
    Math.abs(w - 595.2) < 1.5 && Math.abs(h - 841.92) < 1.5,
    `${w.toFixed(1)}×${h.toFixed(1)}`
  );

  // ② images per page + ③ invisible operator
  const imageCounts: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    const page = doc.getPage(i);
    const resources = page.node.Resources();
    const xobjs = doc.context.lookup(
      resources?.lookup(PDFName.of("XObject"))
    ) as PDFDict | undefined;
    let images = 0;
    if (xobjs) {
      for (const [, value] of xobjs.entries()) {
        const stream = doc.context.lookup(value);
        if (stream instanceof PDFRawStream) {
          const subtype = stream.dict.lookup(PDFName.of("Subtype"));
          if (String(subtype) === "/Image") {
            images += 1;
            const filter = String(
              stream.dict.lookup(PDFName.of("Filter")) ?? PDFName.of("")
            );
            if (mixed && i === 0) continue; // page 1 of mixed = typed copy
            check(
              `page ${i + 1} image is JPEG (DCTDecode)`,
              filter.includes("DCTDecode"),
              filter
            );
            const iw = Number(
              String(stream.dict.lookup(PDFName.of("Width")))
            );
            const ih = Number(
              String(stream.dict.lookup(PDFName.of("Height")))
            );
            check(
              `page ${i + 1} image ≈ 1819×2573 px (220 DPI render of the 150 DPI fixture)`,
              Math.abs(iw - 1819) <= 2 && Math.abs(ih - 2573) <= 2,
              `${iw}×${ih}`
            );
          }
        }
      }
    }
    imageCounts.push(images);
  }

  if (!mixed) {
    check("both pages carry exactly one full-page image", imageCounts[0] === 1 && imageCounts[1] === 1, JSON.stringify(imageCounts));
    const c1 = pageContents(doc, 0);
    const c2 = pageContents(doc, 1);
    check("page 1 content has `3 Tr` invisible operator", /\n3 Tr/.test(c1) || /(^|\s)3 Tr/.test(c1));
    check("page 2 content has `3 Tr` invisible operator", /(^|\s)3 Tr/.test(c2));
  } else {
    check("mixed page 1 has NO image (typed copy)", imageCounts[0] === 0, String(imageCounts[0]));
    check("mixed page 2 has exactly one image", imageCounts[1] === 1, String(imageCounts[1]));
    const c1 = pageContents(doc, 0);
    const c2 = pageContents(doc, 1);
    check("mixed page 1 has NO `3 Tr` (untouched)", !/(^|\s)3 Tr/.test(c1));
    check("mixed page 2 has `3 Tr` (OCR rebuild)", /(^|\s)3 Tr/.test(c2));
    check(
      // pdf-lib writes its strings as hex (UTF-16BE) — the literal
      // "Mixed" never appears in the stream; Tj presence + the pdftotext
      // check below prove the original text object survived.
      "mixed page 1 keeps original Tj text operators",
      /Tj/.test(c1)
    );
  }

  // ④ fonts
  let sawType0Deva = false;
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    const page = doc.getPage(i);
    const resources = page.node.Resources();
    const fonts = doc.context.lookup(
      resources?.lookup(PDFName.of("Font"))
    ) as PDFDict | undefined;
    if (!fonts) continue;
    for (const [, value] of fonts.entries()) {
      const fd = doc.context.lookup(value) as PDFDict | undefined;
      if (!fd) continue;
      const subtype = String(fd.lookup(PDFName.of("Subtype")));
      const base = String(fd.lookup(PDFName.of("BaseFont")));
      if (subtype === "/Type0" && /Devanagari/i.test(base)) {
        const toUnicode = fd.lookup(PDFName.of("ToUnicode"));
        sawType0Deva = true;
        check("Devanagari Type0 font has ToUnicode", Boolean(toUnicode), base);
      }
    }
  }
  if (!mixed) {
    check("Devanagari Type0 font embedded", sawType0Deva);
  }

  // ⑤ + ⑥ + ⑦ text round-trip via pdftotext
  const extract = (args: string[]): string => {
    try {
      return execFileSync("pdftotext", [file, ...args, "-"], {
        encoding: "utf8",
      });
    } catch {
      return "";
    }
  };
  const all = extract([]);
  if (!mixed) {
    for (const word of ["INVOICE", "4721", "9350", "DocoPDF", "searchable"]) {
      check(`pdftotext: English "${word}"`, all.includes(word));
    }
    for (const word of ["नमस्ते", "खोजने", "योग्य", "दस्तावेज़"]) {
      check(`pdftotext: Hindi "${word}"`, all.includes(word));
    }
  } else {
    const page1 = extract(["-f", "1", "-l", "1"]);
    const page2 = extract(["-f", "2", "-l", "2"]);
    check(
      "mixed: page 1 original lines intact",
      page1.includes("Mixed fixture — typed page one.") &&
        page1.includes("This text layer must survive OCR unchanged.") &&
        page1.includes("Second line with total 9350 rupees.")
    );
    check(
      "mixed: page 2 OCR'd (INVOICE)",
      page2.includes("INVOICE") && page2.includes("4721")
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
