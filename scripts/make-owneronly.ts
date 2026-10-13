import { PDFDocument } from "@cantoo/pdf-lib";
import * as fs from "node:fs";
async function main() {
  const plain = fs.readFileSync("download/qa-lock-fixture.pdf");
  const doc = await PDFDocument.load(plain);
  await doc.encrypt({
    userPassword: "",
    ownerPassword: "owner-secret-9",
    permissions: { printing: "highResolution", copying: false, modifying: false },
  });
  fs.writeFileSync("download/qa-owneronly.pdf", await doc.save());
  console.error("owner-only fixture written");
}
main();
