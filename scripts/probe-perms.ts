/**
 * Scratch: pdf.js getPermissions behavior for the unlock surface design.
 */
import { getDocument } from "pdfjs-dist";
import { PDFDocument as CantooDoc } from "@cantoo/pdf-lib";
import { PDFDocument as StockDoc, StandardFonts } from "pdf-lib";
import * as fs from "node:fs";

async function probe(label: string, bytes: Uint8Array): Promise<void> {
  try {
    const doc = await getDocument({ data: bytes.slice() }).promise;
    const perms = await doc.getPermissions().catch((e: unknown) => `ERR:${(e as Error).message}`);
    console.log(`OK   ${label}: pages=${doc.numPages} perms=${JSON.stringify(perms)}`);
    await doc.destroy();
  } catch (error) {
    console.log(`THROW ${label}: ${(error as Error).name}: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  // unencrypted
  const stock = await StockDoc.create();
  const font = await stock.embedFont(StandardFonts.Helvetica);
  const page = stock.addPage([595, 842]);
  page.drawText("hello", { x: 50, y: 700, size: 20, font });
  const plain = await stock.save();
  await probe("plain", plain);

  // owner-only (empty user password)
  const ownerOnly = await CantooDoc.load(plain);
  ownerOnly.encrypt({
    ownerPassword: "owner-master",
    algorithm: "AES-256",
    permissions: { printing: "lowResolution", copying: false },
  });
  const ownerBytes = await ownerOnly.save({ useObjectStreams: false });
  await probe("owner-only AES-256", ownerBytes);

  // owner-only AES-128
  const owner128 = await CantooDoc.load(plain);
  owner128.encrypt({
    ownerPassword: "owner-master",
    algorithm: "AES-128",
    permissions: { printing: "lowResolution", copying: false },
  });
  await probe("owner-only AES-128", await owner128.save({ useObjectStreams: false }));

  // user-password fixture
  const fixture = new Uint8Array(
    fs.readFileSync("/home/z/my-project/download/qa-p315-locked-fixture.pdf")
  );
  await probe("user-password fixture", fixture);
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
