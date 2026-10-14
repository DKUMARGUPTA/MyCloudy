/**
 * PRE-BUILD smoke test for the security pair Protect PDF / Unlock PDF
 * (P3.15). Verifies the @cantoo/pdf-lib engine + pure helpers BEFORE the
 * browser E2E, with qpdf as the independent oracle:
 *
 *  A. Pure helpers (tools/sec-common): typedPasswordBits monotonicity and
 *     class math; toUserPermissions mapping incl. the accessibility
 *     guarantee; LOCK_DEFAULTS shape.
 *  B. LOCK: encrypt(user+owner+permissions) → /Encrypt trailer ref,
 *     V5/R6 AESv3, exact permission bits (qpdf --show-encryption),
 *     wrong password rejected, user AND owner both open.
 *  C. UNLOCK: load-with-password → save is a clean, qpdf-checkable,
 *     pdftotext-extractable PDF with no encryption — for fork-locked
 *     AES-256, qpdf-locked AES-256 AND legacy RC4-128 files, plus the
 *     owner-only (empty user password) case.
 *  D. WORKER PATHS: probe-load on a plain file succeeds (→ the
 *     "not encrypted" branch); re-locking an unlocked copy works.
 *
 * Run: bun scripts/smoke-security.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, PDFInvalidObject, StandardFonts, rgb } from "@cantoo/pdf-lib";

import {
  LOCK_DEFAULTS,
  toUserPermissions,
  typedPasswordBits,
} from "../tools/sec-common/sec";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL ${name}${extra ? " — " + extra : ""}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "doco-sec-"));
const run = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (error) {
    const err = error as { stdout?: string; message: string };
    return err.stdout ?? err.message;
  }
};

/** Mirror of the unlock worker's decrypt-artifact purge. */
function purgeInvalidObjects(doc: PDFDocument): void {
  const context = (
    doc as unknown as {
      context: {
        enumerateIndirectObjects(): [ref: unknown, object: unknown][];
        delete(ref: unknown): unknown;
      };
    }
  ).context;
  for (const entry of context.enumerateIndirectObjects()) {
    if (entry[1] instanceof PDFInvalidObject) {
      context.delete(entry[0]);
    }
  }
}

/** qpdf --check result class: "clean" | "warnings" | "errors". */
function qpdfCheckClass(path: string): string {
  const out = run("qpdf", ["--check", path]);
  if (/^ERROR/m.test(out)) return "errors";
  if (/^WARNING/m.test(out)) return "warnings";
  return "clean";
}

/** Full reload without password — the poison test (D2 lesson). */
async function reloadsClean(path: string): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
      updateMetadata: false,
    });
    return doc.getPageCount() > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
console.log("\nA. Pure helpers (sec-common)");
/* ------------------------------------------------------------------ */

ok("empty password = 0 bits", typedPasswordBits("") === 0);
ok(
  "lowercase-only scores pool 26",
  typedPasswordBits("abcdefgh") === Math.round(8 * Math.log2(26)),
  `${typedPasswordBits("abcdefgh")} bits`
);
ok(
  "mixed classes beat single class (same length)",
  typedPasswordBits("aB1!xY2?") > typedPasswordBits("abcdefgh"),
  `${typedPasswordBits("aB1!xY2?")} > ${typedPasswordBits("abcdefgh")}`
);
ok(
  "digits-only pool 10",
  typedPasswordBits("12345678") === Math.round(8 * Math.log2(10)),
  `${typedPasswordBits("12345678")} bits`
);

const permHigh = toUserPermissions({
  printQuality: "high",
  copy: true,
  modify: false,
  annotate: true,
  forms: true,
  assemble: false,
});
ok(
  "printing high → highResolution",
  permHigh.printing === "highResolution"
);
ok("accessibility always true", permHigh.contentAccessibility === true);
const permLow = toUserPermissions({
  printQuality: "low",
  copy: false,
  modify: true,
  annotate: false,
  forms: false,
  assemble: true,
});
ok("printing low → lowResolution", permLow.printing === "lowResolution");
ok(
  "printing none → false",
  toUserPermissions({ ...LOCK_DEFAULTS, printQuality: "none" }).printing ===
    false
);
ok("defaults: copy+forms on, modify off", LOCK_DEFAULTS.copy && LOCK_DEFAULTS.forms && !LOCK_DEFAULTS.modify);

/* ------------------------------------------------------------------ */
console.log("\nB. Lock — AES-256 with permissions (qpdf oracle)");
/* ------------------------------------------------------------------ */

const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
const page = src.addPage([420, 300]);
page.drawText("DocoPdf security smoke", { x: 40, y: 200, size: 18, font, color: rgb(0.1, 0.2, 0.4) });
src.setTitle("Security smoke source");
const srcBytes = new Uint8Array(await src.save());
const plainPath = join(dir, "plain.pdf");
writeFileSync(plainPath, srcBytes);

// Exactly what the lock worker does.
const lock = await PDFDocument.load(srcBytes, { updateMetadata: false });
lock.encrypt({
  userPassword: "open123",
  ownerPassword: "master9",
  algorithm: "AES-256",
  permissions: toUserPermissions({
    printQuality: "low",
    copy: false,
    modify: false,
    annotate: false,
    forms: true,
    assemble: false,
  }),
});
const encBytes = new Uint8Array(await lock.save({ useObjectStreams: true }));
const encPath = join(dir, "locked.pdf");
writeFileSync(encPath, encBytes);

const encLatin = Buffer.from(encBytes).toString("latin1");
ok(
  "trailer carries /Encrypt ref",
  /\/Encrypt\s+\d+\s+\d+\s+R/.test(encLatin)
);
const showEnc = run("qpdf", ["--show-encryption", encPath]);
ok("qpdf: user password required", showEnc.includes("Incorrect password supplied") || showEnc.includes("has a user password"));
ok("qpdf: R6 (AES-256)", showEnc.includes("R = 6"));
ok("qpdf: AESv3 stream", showEnc.includes("AESv3"));
ok("qpdf: print low only", showEnc.includes("print low resolution: allowed") && showEnc.includes("print high resolution: not allowed"));
ok("qpdf: extract blocked", showEnc.includes("extract for any purpose: not allowed"));
ok("qpdf: forms allowed", showEnc.includes("modify forms: allowed"));
ok("qpdf: a11y stays allowed", showEnc.includes("extract for accessibility: allowed"));

const ownerOpen = run("qpdf", ["--password=master9", "--show-encryption", encPath]);
ok("qpdf: owner password opens", ownerOpen.includes("R = 6"));

try {
  await PDFDocument.load(encBytes, { password: "wrong-one" });
  ok("fork: wrong password rejected", false, "loaded without error!");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ok(
    "fork: wrong password rejected",
    /password incorrect/i.test(message),
    message.slice(0, 40)
  );
}

/* ------------------------------------------------------------------ */
console.log("\nC. Unlock — every path the worker takes");
/* ------------------------------------------------------------------ */

// C1: fork-locked AES-256.
const unlocked = await PDFDocument.load(encBytes, {
  updateMetadata: false,
  password: "open123",
});
purgeInvalidObjects(unlocked);
const ulBytes = new Uint8Array(await unlocked.save({ useObjectStreams: true }));
const ulPath = join(dir, "unlocked.pdf");
writeFileSync(ulPath, ulBytes);
const ulInfo = run("pdfinfo", [ulPath]);
ok("C1 pdfinfo: not encrypted", ulInfo.includes("Encrypted:       no") || ulInfo.includes("Encrypted: no"));
const ulText = run("pdftotext", [ulPath, "-"]);
ok("C1 pdftotext: text intact", ulText.includes("security smoke"));
ok("C1 qpdf check: clean", qpdfCheckClass(ulPath) === "clean");
ok("C1 fork reloads without password", await reloadsClean(ulPath));

// C2: legacy RC4-128 locked by qpdf itself (different producer path).
const legacyPath = join(dir, "legacy-rc4.pdf");
run("qpdf", [
  "--allow-weak-crypto",
  "--encrypt", "upw", "opw", "128", "--print=full", "--",
  plainPath, legacyPath,
]);
const legacyBytes = new Uint8Array(readFileSync(legacyPath));
const legacyDoc = await PDFDocument.load(legacyBytes, { updateMetadata: false, password: "upw" });
purgeInvalidObjects(legacyDoc);
const legacyOut = new Uint8Array(await legacyDoc.save({ useObjectStreams: true }));
const legacyOutPath = join(dir, "legacy-out.pdf");
writeFileSync(legacyOutPath, legacyOut);
ok("C2 legacy RC4-128 unlocks", run("pdfinfo", [legacyOutPath]).includes("Encrypted:       no") || run("pdfinfo", [legacyOutPath]).includes("Encrypted: no"));
ok("C2 text intact", run("pdftotext", [legacyOutPath, "-"]).includes("security smoke"));
ok("C2 fork reloads without password", await reloadsClean(legacyOutPath));

// C3: qpdf-produced AES-256 (interop across producers).
const aesPath = join(dir, "qpdf-aes256.pdf");
run("qpdf", [
  "--encrypt", "upw", "opw", "256", "--print=none", "--extract=n", "--",
  plainPath, aesPath,
]);
const aesBytes = new Uint8Array(readFileSync(aesPath));
const aesDoc = await PDFDocument.load(aesBytes, { updateMetadata: false, password: "upw" });
purgeInvalidObjects(aesDoc);
const aesOut = new Uint8Array(await aesDoc.save({ useObjectStreams: true }));
const aesOutPath = join(dir, "aes-out.pdf");
writeFileSync(aesOutPath, aesOut);
ok("C3 qpdf AES-256 unlocks", run("pdfinfo", [aesOutPath]).includes("Encrypted:       no") || run("pdfinfo", [aesOutPath]).includes("Encrypted: no"));
ok("C3 text intact", run("pdftotext", [aesOutPath, "-"]).includes("security smoke"));
ok("C3 fork reloads without password", await reloadsClean(aesOutPath));

// C4: owner-only restrictions, empty user password.
const oOnlyPath = join(dir, "oonly.pdf");
const oOnly = await PDFDocument.load(srcBytes, { updateMetadata: false });
oOnly.encrypt({
  ownerPassword: "own9",
  permissions: toUserPermissions({
    printQuality: "none",
    copy: false,
    modify: false,
    annotate: false,
    forms: false,
    assemble: false,
  }),
});
writeFileSync(oOnlyPath, new Uint8Array(await oOnly.save()));
const oDoc = await PDFDocument.load(new Uint8Array(readFileSync(oOnlyPath)), {
  updateMetadata: false,
  password: "",
});
purgeInvalidObjects(oDoc);
const oOutPath = join(dir, "oonly-out.pdf");
writeFileSync(oOutPath, new Uint8Array(await oDoc.save()));
const oShow = run("qpdf", ["--show-encryption", "--password=", oOnlyPath]);
ok("C4 qpdf sees the restrictions", oShow.includes("Supplied password is user password") && oShow.includes("print low resolution: not allowed"));
ok("C4 empty-password unlock cleans", run("pdfinfo", [oOutPath]).includes("Encrypted:       no") || run("pdfinfo", [oOutPath]).includes("Encrypted: no"));
ok("C4 text intact", run("pdftotext", [oOutPath, "-"]).includes("security smoke"));
ok("C4 fork reloads without password", await reloadsClean(oOutPath));

/* ------------------------------------------------------------------ */
console.log("\nD. Worker-path sanity");
/* ------------------------------------------------------------------ */

// Probe-load on a plain file must SUCCEED (worker: "not encrypted" branch).
const probe = await PDFDocument.load(srcBytes, { updateMetadata: false });
ok("D1 plain probe loads (notEncrypted branch)", probe.getPageCount() === 1);

// Re-lock the unlocked copy — round trip.
const relock = await PDFDocument.load(ulBytes, { updateMetadata: false });
relock.encrypt({ userPassword: "again1", algorithm: "AES-256" });
const relockPath = join(dir, "relocked.pdf");
writeFileSync(relockPath, new Uint8Array(await relock.save()));
ok(
  "D2 re-lock output is encrypted",
  run("qpdf", ["--show-encryption", relockPath]).includes("Incorrect password supplied") ||
  run("qpdf", ["--show-encryption", relockPath]).includes("R = 6")
);
const reunlock = await PDFDocument.load(new Uint8Array(readFileSync(relockPath)), {
  updateMetadata: false,
  password: "again1",
});
const reunlockSaved = new Uint8Array(await reunlock.save());
const reUnlockPath = join(dir, "re-unlocked.pdf");
writeFileSync(reUnlockPath, reunlockSaved);
ok(
  "D3 re-lock round-trips to clean",
  run("pdfinfo", [reUnlockPath]).includes("Encrypted:       no") ||
    run("pdfinfo", [reUnlockPath]).includes("Encrypted: no")
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
