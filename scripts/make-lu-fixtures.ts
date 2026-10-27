/**
 * QA fixtures for the lock/unlock E2E round (P3.15; NOT shipped logic).
 * Generates into download/ (the browser's download dir) so agent-browser
 * can both upload them and receive outputs there.
 */
import { PDFDocument as CantooDoc, StandardFonts } from "@cantoo/pdf-lib";
import { PDFDocument as StockDoc } from "pdf-lib";
import { writeFile } from "node:fs/promises";

// qpdf console capture (same patch-through-init pattern as smoke-lock.ts)
const output: string[] = [];
const origLog = console.log;
const origWarn = console.warn;
console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
const { default: init } = await import("@jspawn/qpdf-wasm");
import { readFile } from "node:fs/promises";

const wasmPath = new URL("../node_modules/@jspawn/qpdf-wasm/qpdf.wasm", import.meta.url).pathname;
const wasmBytes = new Uint8Array(await readFile(wasmPath));
const qpdf: any = await init({
  instantiateWasm: (imports: unknown, cb: (inst: unknown) => void) => {
    WebAssembly.instantiate(wasmBytes, imports as WebAssembly.Imports).then(
      (r: { instance: unknown }) => cb(r.instance)
    );
    return {};
  },
});
console.log = origLog;
console.warn = origWarn;

async function makeDoc(): Promise<CantooDoc> {
  const doc = await CantooDoc.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Fixture page ${i}`, { x: 72, y: 700, size: 24, font });
  }
  return doc;
}

const OUT = "/home/z/my-project/download";

// 1. clean PDF
const cleanDoc = await makeDoc();
const cleanBytes = new Uint8Array(await cleanDoc.save());
await writeFile(`${OUT}/qa-lu-clean.pdf`, cleanBytes);

// 2. password-protected AES-256 (user pw test1234, owner pw owner-only-key)
const lockDoc = await makeDoc();
lockDoc.encrypt({
  userPassword: "test1234",
  ownerPassword: "owner-only-key",
  algorithm: "AES-256",
  permissions: {
    printing: "highResolution",
    copying: false,
    modifying: false,
    annotating: true,
    fillingForms: true,
    contentAccessibility: true,
    documentAssembly: false,
  },
});
const lockBytes = new Uint8Array(await lockDoc.save());
await writeFile(`${OUT}/qa-lu-locked.pdf`, lockBytes);

// 3. restrictions-only (EMPTY user password — opens without a password)
const restDoc = await makeDoc();
restDoc.encrypt({
  userPassword: "",
  ownerPassword: "owner-only-key",
  algorithm: "AES-256",
  permissions: {
    printing: "lowResolution",
    copying: false,
    modifying: false,
    annotating: false,
    fillingForms: false,
    contentAccessibility: true,
    documentAssembly: false,
  },
});
const restBytes = new Uint8Array(await restDoc.save());
await writeFile(`${OUT}/qa-lu-restricted.pdf`, restBytes);

// verify all three with the qpdf oracle
const checks: string[] = [];
qpdf.FS.writeFile("clean.pdf", cleanBytes);
output.length = 0;
qpdf.callMain(["--show-encryption", "clean.pdf"]);
checks.push(`clean: no-encryption-note=${/File is not encrypted/.test(output.join("\n"))}`);

qpdf.FS.writeFile("locked.pdf", lockBytes);
output.length = 0;
const rcL = qpdf.callMain(["--show-encryption", "--password=test1234", "locked.pdf"]);
const lockedInfo = output.join("\n");
checks.push(`locked: rc=${rcL}, userPw=${/Supplied password is user password/.test(lockedInfo)}, copyBlocked=${/extract for any purpose: not allowed/.test(lockedInfo)}`);

qpdf.FS.writeFile("rest.pdf", restBytes);
output.length = 0;
const rcR = qpdf.callMain(["--show-encryption", "rest.pdf"]);
const restInfo = output.join("\n");
checks.push(`restricted: rc=${rcR}, printLowOnly=${/print low resolution: allowed/.test(restInfo) && /print high resolution: not allowed/.test(restInfo)}, copyBlocked=${/extract for any purpose: not allowed/.test(restInfo)}`);

// restrictions-only must decrypt WITHOUT a password (the unlock flow's mode 2)
qpdf.FS.writeFile("rest2.pdf", restBytes);
const rcD = qpdf.callMain(["--decrypt", "rest2.pdf", "rest2-out.pdf"]);
const stripped = qpdf.FS.readFile("rest2-out.pdf") as Uint8Array;
const reopened = await StockDoc.load(stripped, { ignoreEncryption: false });
checks.push(`restricted no-pw decrypt: rc=${rcD}, pages=${reopened.getPageCount()}`);

console.log(checks.join("\n"));
