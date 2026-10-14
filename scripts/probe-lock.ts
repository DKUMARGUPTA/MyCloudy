/**
 * Scratch: verify cantoo load/decrypt semantics for the unlock engine design.
 */
import { PDFDocument as CantooDoc } from "@cantoo/pdf-lib";
import { PDFDocument as StockDoc, StandardFonts, rgb } from "pdf-lib";
import * as fs from "node:fs";

const TMP = "/tmp/lock-probe";
fs.mkdirSync(TMP, { recursive: true });

async function buildPlain(): Promise<Uint8Array> {
  const stock = await StockDoc.create();
  stock.setTitle("ProbeTitle");
  const font = await stock.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i += 1) {
    const page = stock.addPage([595.28, 841.89]);
    page.drawText(`Probe page ${i}`, { x: 60, y: 700, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return stock.save();
}

async function tryLoad(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn() as CantooDoc;
    const trailer = result.context.trailerInfo as { Encrypt?: unknown };
    console.log(
        `OK   ${label}: isEncrypted=${result.isEncrypted} trailerEncrypt=${trailer.Encrypt !== undefined ? "present" : "absent"}`
    );
  } catch (error) {
    console.log(
        `THROW ${label}: ${(error as Error).name}: ${(error as Error).message}`
    );
  }
}

async function main(): Promise<void> {
  const plain = await buildPlain();
  fs.writeFileSync(`${TMP}/plain.pdf`, plain);

  await tryLoad("plain, no password", () => CantooDoc.load(plain));

  // Owner-only AES-256 (empty user password).
  const ownerOnly = await CantooDoc.load(plain);
  ownerOnly.encrypt({
    ownerPassword: "owner-master",
    algorithm: "AES-256",
    permissions: { printing: "lowResolution", copying: false },
  });
  const ownerBytes = await ownerOnly.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/owner-only.pdf`, ownerBytes);

  await tryLoad("owner-only, no password", () => CantooDoc.load(ownerBytes));
  await tryLoad("owner-only, password ''", () => CantooDoc.load(ownerBytes, { password: "" }));
  await tryLoad("owner-only, password 'x'", () => CantooDoc.load(ownerBytes, { password: "x" }));

  // User-password file.
  const locked = await CantooDoc.load(plain);
  locked.encrypt({
    userPassword: "open-sesame",
    ownerPassword: "owner-master",
    algorithm: "AES-256",
  });
  const lockedBytes = await locked.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/locked.pdf`, lockedBytes);

  await tryLoad("locked, no password", () => CantooDoc.load(lockedBytes));
  await tryLoad("locked, wrong password", () => CantooDoc.load(lockedBytes, { password: "nope" }));
  await tryLoad("locked, user password", () => CantooDoc.load(lockedBytes, { password: "open-sesame" }));
  await tryLoad("locked, owner password", () => CantooDoc.load(lockedBytes, { password: "owner-master" }));
  await tryLoad("locked, password ''", () => CantooDoc.load(lockedBytes, { password: "" }));

  // AES-128 variant.
  const a128 = await CantooDoc.load(plain);
  a128.encrypt({
    userPassword: "open-sesame",
    algorithm: "AES-128",
  });
  const a128Bytes = await a128.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/locked128.pdf`, a128Bytes);
  await tryLoad("AES-128 locked, wrong pw", () => CantooDoc.load(a128Bytes, { password: "no" }));
  await tryLoad("AES-128 locked, right pw", () => CantooDoc.load(a128Bytes, { password: "open-sesame" }));

  // Existing fixtures from the task.
  const fixtureLocked = new Uint8Array(fs.readFileSync("/home/z/my-project/download/qa-p315-locked-fixture.pdf"));
  await tryLoad("fixture, user pw", () => CantooDoc.load(fixtureLocked, { password: "open-sesame" }));
  await tryLoad("fixture, owner pw", () => CantooDoc.load(fixtureLocked, { password: "owner-master" }));
  const fixturePlain = new Uint8Array(fs.readFileSync("/home/z/my-project/download/qa-p315-plain-fixture.pdf"));
  await tryLoad("fixture plain", () => CantooDoc.load(fixturePlain));
}

main().catch((error) => {
  console.error("PROBE FAILED:", error);
  process.exit(1);
});
