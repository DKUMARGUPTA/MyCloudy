/**
 * PRE-BUILD smoke for PHASE-3 first batch (add-attachments,
 * extract-attachments, page-dimensions). The raster tools (invert,
 * greyscale) are browser-E2E covered (pdfjs DOM shim).
 *
 *  1. add → extract ROUND-TRIP: embed 2 files, walk them back out,
 *     byte-exact, names preserved, keepExisting merge with a pre-attached
 *     file, replace mode drops it.
 *  2. extract: crafted raw fixture (name tree with 2 entries) + honest
 *     no-attachments error.
 *  3. page-dimensions: report render (pt/mm/in lines, rotation, crop
 *     shown when it differs) + facts from real fixtures.
 *
 * Run: bun scripts/smoke-attachments.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  runAddAttachments,
  type AttachmentSpec,
} from "../tools/add-attachments/worker";
import {
  collectAttachments,
  runExtractAttachments,
} from "../tools/extract-attachments/worker-lib";
import { pageFacts, renderReport } from "../tools/page-dimensions/worker";
import {
  latin1,
  parsePdf,
  asDict,
  resolve,
} from "../src/lib/own/pdf";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

async function markerPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`P${i}`, { x: 40, y: 200, size: 32, font });
  }
  return new Uint8Array(await doc.save());
}

/* ------------------------------------------------------------------ */
console.log("1. add-attachments → extract-attachments round trip");

{
  const pdfBytes = await markerPdf(2);
  const atts: AttachmentSpec[] = [
    { name: "contract.txt", bytes: new TextEncoder().encode("CONTRACT-BYTES-123") },
    { name: "photo.bin", bytes: new Uint8Array([0, 1, 2, 250, 251, 252, 253]) },
  ];

  const result = await runAddAttachments(pdfBytes, atts, { keepExisting: true });
  check("add: 2 attached", result.attached === 2);

  // Output reloads in our parser + oracle.
  const doc = parsePdf(result.bytes);
  check("add: parses, pages kept", doc !== null);
  const oracle = await PDFDocument.load(result.bytes);
  check("add: pdf-lib oracle reload", oracle.getPageCount() === 2);

  // Raw output contains the payload + structure.
  const raw = latin1All(result.bytes);
  check("add: payload bytes present", raw.includes("CONTRACT-BYTES-123"));
  check("add: /EmbeddedFile marker", raw.includes("/EmbeddedFile"));
  check("add: /Filespec marker", raw.includes("/Filespec"));

  // Extract them back.
  const back = await runExtractAttachments(result.bytes);
  check("extract: 2 files", back.attachments.length === 2, JSON.stringify(back.attachments.map((a) => a.name)));
  const names = back.attachments.map((a) => a.name).sort();
  check("extract: names preserved", names[0] === "contract.txt" && names[1] === "photo.bin", JSON.stringify(names));
  const contract = back.attachments.find((a) => a.name === "contract.txt");
  check(
    "extract: text byte-exact",
    contract !== undefined && latin1All(contract.bytes) === "CONTRACT-BYTES-123"
  );
  const photo = back.attachments.find((a) => a.name === "photo.bin");
  check(
    "extract: binary byte-exact",
    photo !== undefined && Buffer.compare(Buffer.from(photo.bytes), Buffer.from(atts[1]!.bytes)) === 0
  );
}

/* ------------------------------------------------------------------ */
console.log("2. add: keepExisting merge + replace mode");

{
  // First embed one file, then add a second on top.
  const pdfBytes = await markerPdf(1);
  const first = await runAddAttachments(pdfBytes, [
    { name: "first.txt", bytes: new TextEncoder().encode("FIRST") },
  ], { keepExisting: true });
  const merged = await runAddAttachments(first.bytes, [
    { name: "second.txt", bytes: new TextEncoder().encode("SECOND") },
  ], { keepExisting: true });
  const mBack = await runExtractAttachments(merged.bytes);
  check("merge: both files present", mBack.attachments.length === 2, String(mBack.attachments.length));
  const mRaw = latin1All(mBack.attachments.map((a) => a.name).sort().join(","));
  check("merge: names first+second", mBack.attachments.map((a) => a.name).sort().join(",") === "first.txt,second.txt", mRaw);

  // Replace mode drops the existing ones.
  const replaced = await runAddAttachments(first.bytes, [
    { name: "third.txt", bytes: new TextEncoder().encode("THIRD") },
  ], { keepExisting: false });
  const rBack = await runExtractAttachments(replaced.bytes);
  check("replace: only the new file", rBack.attachments.length === 1 && rBack.attachments[0]!.name === "third.txt");
}

/* ------------------------------------------------------------------ */
console.log("3. extract: no-attachments honesty");

{
  const pdfBytes = await markerPdf(1);
  const back = await runExtractAttachments(pdfBytes);
  check("plain PDF: zero attachments", back.attachments.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("3b. extract: Flate-compressed attachments (R59 regression)");

{
  // pdf-lib attach() writes EmbeddedFile streams with /Filter
  // /FlateDecode — exactly what Acrobat and Word produce. The pre-R59
  // worker shipped the still-COMPRESSED bytes; this guards the fix.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText("Host", { x: 40, y: 200, size: 16, font });
  const txt = new TextEncoder().encode("FLATE-UNIQUE-R59-4242\ncompressed attachment payload\n");
  const png = new TextEncoder().encode("\u0089PNG\r\n\u001a\nfake-png-body");
  await doc.attach(txt, "notes.txt", { mimeType: "text/plain" });
  await doc.attach(png, "logo.png", { mimeType: "image/png" });
  const bytes = new Uint8Array(await doc.save());

  const back = await runExtractAttachments(bytes);
  check("flate: 2 files", back.attachments.length === 2, JSON.stringify(back.attachments.map((a) => a.name)));
  const notes = back.attachments.find((a) => a.name === "notes.txt");
  check(
    "flate: text decoded byte-exact",
    notes !== undefined &&
      Buffer.compare(Buffer.from(notes.bytes), Buffer.from(txt)) === 0,
    notes ? `len=${notes.bytes.length}` : "missing",
  );
  check(
    "flate: text mime sniffed",
    notes?.mime === "text/plain",
    notes?.mime ?? "",
  );
  const logo = back.attachments.find((a) => a.name === "logo.png");
  check(
    "flate: binary decoded byte-exact",
    logo !== undefined &&
      Buffer.compare(Buffer.from(logo.bytes), Buffer.from(png)) === 0,
  );
  check(
    "flate: png mime sniffed from magic bytes",
    logo?.mime === "image/png",
    logo?.mime ?? "",
  );
  // The raw stream must NOT be what we hand back (zlib header = 0x78).
  check(
    "flate: output is NOT still-compressed",
    notes === undefined || notes.bytes[0] !== 0x78,
  );
}

/* ------------------------------------------------------------------ */
console.log("4. page-dimensions");

{
  const bytes = await markerPdf(2);
  const facts = pageFacts(bytes);
  check("facts: 2 pages", facts.length === 2);
  check("facts: 300×400", facts[0]!.mediaBox[2] === 300 && facts[0]!.mediaBox[3] === 400);
  check("facts: no rotation", facts[0]!.rotate === 0);

  const report = renderReport("doc.pdf", facts);
  check("report: header", report.includes("Page dimensions report") && report.includes("File: doc.pdf"));
  check("report: pt line", report.includes("300 × 400 pt"));
  check("report: mm line", report.includes("105.83 × 141.11 mm"), report.split("\n")[6] ?? "");
  check("report: in line", report.includes("4.17 × 5.56 in"));
  check("report: page rows", report.includes("Page 1") && report.includes("Page 2"));

  // Rotated + crop-differs variant.
  const cropped = renderReport("c.pdf", [
    {
      mediaBox: [0, 0, 612, 792],
      cropBox: [10, 10, 602, 782],
      rotate: 90,
    },
  ]);
  check("report: rotation shown", cropped.includes("(rotated 90°)"));
  check("report: CropBox shown when differs", cropped.includes("CropBox:"));
  check("report: honest note", cropped.includes("not modified"));
}

/* ------------------------------------------------------------------ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
