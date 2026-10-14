/**
 * Engine de-risk for lock-pdf/unlock-pdf (run BEFORE building the tools).
 * Proves the FULL corrected pipeline works:
 *
 * LOCK:  stock pdf-lib fixture -> cantoo load -> encrypt(AES-256+perms) ->
 *        STRING WALK (cantoo only encrypts streams; every PDFString/PDFHexString
 *        in every indirect object must be encrypted with its owner's object
 *        key, else Info/outlines/forms leak in plaintext) ->
 *        save(useObjectStreams:false) (strings inside ObjStms must NOT be
 *        individually encrypted, so lock output is written unpacked).
 *
 * UNLOCK: load(locked, {password}) -> delete trailerInfo.Encrypt (the writer
 *        always copies it into the trailer) -> save -> plaintext file.
 *
 * Compatibility is verified with pdf.js (what our other tools + the user's
 * browser use): locked without password -> PasswordException; with password
 * -> opens, text + Info intact; decrypted opens with NO password.
 *
 * bun run scripts/smoke-cantoo.ts
 */
import {
  PDFDocument as CantooDoc,
  PDFHexString,
  PDFName,
  PDFString,
  PDFArray,
  PDFDict,
  PDFStream,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from "@cantoo/pdf-lib";

/** (not re-exported by the package index — mirror of the PDFSecurity type) */
type EncryptFn = (buffer: Uint8Array) => Uint8Array;
import { PDFDocument as StockDoc, StandardFonts, rgb } from "pdf-lib";
import * as fs from "node:fs";

const TMP = "/tmp/cantoo-smoke";
fs.mkdirSync(TMP, { recursive: true });

function check(label: string, cond: boolean, extra = "") {
  if (!cond) {
    console.error(`✗ ${label} ${extra}`);
    process.exit(1);
  }
  console.log(`✓ ${label} ${extra}`);
}

/**
 * Encrypt every string in every indirect object with its owner's key.
 * Skips the /Encrypt dict itself (its /O /U /UE strings must stay readable
 * pre-decryption). Stream dicts are walked; stream CONTENTS are left to
 * PDFWriter (it encrypts them at serialization time).
 */
function encryptAllStrings(doc: CantooDoc): void {
  const security = doc.context.security;
  if (!security) throw new Error("encrypt() must run before encryptAllStrings");
  const encryptRef = doc.context.trailerInfo.Encrypt;
  const seen = new Set<PDFObject>();

  const encryptValue = (value: PDFObject, fn: EncryptFn): void => {
    if (value instanceof PDFString || value instanceof PDFHexString) {
      // Replacing in place is impossible on immutable-ish PDFObjects; the
      // containers below swap the encrypted copy in via set/push semantics.
      return;
    }
    if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (entry instanceof PDFString || entry instanceof PDFHexString) {
          value.set(key, PDFHexString.fromBytes(fn(entry.asBytes())));
        } else {
          encryptValue(entry, fn);
        }
      }
      return;
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i += 1) {
        const entry = value.get(i);
        if (entry instanceof PDFString || entry instanceof PDFHexString) {
          value.set(i, PDFHexString.fromBytes(fn(entry.asBytes())));
        } else {
          encryptValue(entry, fn);
        }
      }
    }
  };

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (encryptRef instanceof PDFRef && ref === encryptRef) continue;
    const fn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    if (object instanceof PDFStream) {
      // Walk the stream's DICTIONARY only (contents handled by the writer).
      encryptValue(object.dict, fn);
    } else if (object instanceof PDFDict || object instanceof PDFArray) {
      encryptValue(object, fn);
    }
  }
}

async function main() {
  // 1. Fixture built with the STOCK pdf-lib (what all existing tools use),
  //    with a secret string in the Info dict + object-stream compression on.
  const stock = await StockDoc.create();
  stock.setTitle("SecretTitleXYZ");
  stock.setAuthor("SecretAuthor");
  const font = await stock.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i += 1) {
    const page = stock.addPage([595.28, 841.89]);
    page.drawText(`Protect smoke page ${i}`, {
      x: 60,
      y: 700,
      size: 24,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
  const plain = await stock.save({ useObjectStreams: true });
  fs.writeFileSync(`${TMP}/plain.pdf`, plain);
  // ObjStm contents are Flate-compressed, so "plaintext" is verified via
  // pdf.js (the Title must be readable) rather than a raw byte grep.

  // 2. LOCK with cantoo: AES-256 + permissions + string walk.
  const toLock = await CantooDoc.load(plain);
  toLock.encrypt({
    userPassword: "open-sesame",
    ownerPassword: "owner-master",
    algorithm: "AES-256",
    permissions: {
      printing: "highResolution",
      copying: false,
      modifying: false,
      annotating: false,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: false,
    },
  });
  encryptAllStrings(toLock);
  const locked = await toLock.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/locked.pdf`, locked);
  const lockedStr = Buffer.from(locked).toString("latin1");
  check(
    "LOCK: no plaintext leak of Info strings",
    !lockedStr.includes("SecretTitleXYZ") && !lockedStr.includes("SecretAuthor")
  );
  check("LOCK: /Encrypt in output", lockedStr.includes("Encrypt"));
  check("LOCK: AESV3 marker", /AESV3/.test(lockedStr));
  check(
    "LOCK: page text content encrypted",
    !lockedStr.includes("Protect smoke page")
  );

  // 3. pdf.js compatibility (the reader our users' browsers + tools use).
  const { getDocument } = await import("pdfjs-dist");
  const plainDoc = await getDocument({
    data: new Uint8Array(fs.readFileSync(`${TMP}/plain.pdf`)),
  }).promise;
  const plainMeta = await plainDoc.getMetadata().catch(() => null);
  check(
    "sanity: fixture Title readable via pdf.js",
    (plainMeta?.info as { Title?: string } | undefined)?.Title === "SecretTitleXYZ"
  );
  await plainDoc.destroy();
  let blocked = false;
  try {
    await getDocument({ data: new Uint8Array(locked) }).promise;
  } catch (err) {
    blocked = (err as Error).name === "PasswordException";
  }
  check("pdf.js: locked file demands password", blocked);
  const opened = await getDocument({
    data: new Uint8Array(locked),
    password: "open-sesame",
  }).promise;
  check("pdf.js: opens with password, 3 pages", opened.numPages === 3);
  const meta = await opened.getMetadata().catch(() => null);
  const title = (meta?.info as { Title?: string } | undefined)?.Title;
  check("pdf.js: Info /Title decrypts correctly", title === "SecretTitleXYZ", `got=${title}`);
  const page1 = await opened.getPage(1);
  const text = await page1.getTextContent();
  const joined = text.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  check("pdf.js: page text readable after decrypt", joined.includes("Protect smoke page 1"));
  await opened.destroy();

  // 4. UNLOCK: load with password, drop the trailer /Encrypt, save.
  const unlocked = await CantooDoc.load(locked, { password: "open-sesame" });
  delete (unlocked.context.trailerInfo as { Encrypt?: unknown }).Encrypt;
  const decrypted = await unlocked.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/decrypted.pdf`, decrypted);
  const decStr = Buffer.from(decrypted).toString("latin1");
  check("UNLOCK: trailer /Encrypt gone", !/\bEncrypt\b/.test(decStr));
  // cantoo's decrypt parser re-encodes strings as UTF-16BE PDFHexStrings
  // (<FEFF...>) — legal PDF. Decode instead of a raw byte grep.
  const hexTitle = Buffer.from("SecretTitleXYZ", "utf16le").swap16().toString("hex").toUpperCase();
  check(
    "UNLOCK: Title string present (UTF-16 hex)",
    new RegExp(hexTitle.slice(0, 16)).test(decStr) ||
      new RegExp(hexTitle.slice(0, 16).toLowerCase()).test(decStr)
  );
  const decDoc = await getDocument({ data: new Uint8Array(decrypted) }).promise;
  check("pdf.js: decrypted opens with NO password", decDoc.numPages === 3);
  const decMeta = await decDoc.getMetadata().catch(() => null);
  check(
    "UNLOCK: Title survived",
    (decMeta?.info as { Title?: string } | undefined)?.Title === "SecretTitleXYZ"
  );
  await decDoc.destroy();

  // 5. Wrong password rejected; owner-only file opens freely.
  let wrongRejected = false;
  try {
    await CantooDoc.load(locked, { password: "nope" });
  } catch {
    wrongRejected = true;
  }
  check("wrong password rejected", wrongRejected);

  const ownerOnly = await CantooDoc.load(plain);
  ownerOnly.encrypt({
    ownerPassword: "owner-master",
    algorithm: "AES-256",
    permissions: { printing: "lowResolution", copying: false },
  });
  encryptAllStrings(ownerOnly);
  const ownerBytes = await ownerOnly.save({ useObjectStreams: false });
  fs.writeFileSync(`${TMP}/owner-only.pdf`, ownerBytes);
  const freeDoc = await getDocument({ data: new Uint8Array(ownerBytes) }).promise;
  check("owner-only opens WITHOUT password (empty user pw)", freeDoc.numPages === 3);
  await freeDoc.destroy();

  // 6. Load back with cantoo itself (chain: unlock -> lock again).
  const relock = await CantooDoc.load(locked, { password: "open-sesame" });
  delete (relock.context.trailerInfo as { Encrypt?: unknown }).Encrypt;
  const replain = await relock.save({ useObjectStreams: false });
  const relocked = await CantooDoc.load(replain);
  relocked.encrypt({ userPassword: "second", algorithm: "AES-256" });
  encryptAllStrings(relocked);
  const reBytes = await relocked.save({ useObjectStreams: false });
  const reDoc = await getDocument({
    data: new Uint8Array(reBytes),
    password: "second",
  }).promise;
  check("re-lock chain works (unlock -> lock)", reDoc.numPages === 3);
  await reDoc.destroy();

  console.log("\nALL CHECKS PASSED — cantoo engine + string walk is viable.");
  console.log("fixtures in /tmp/cantoo-smoke: plain.pdf locked.pdf decrypted.pdf owner-only.pdf");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
