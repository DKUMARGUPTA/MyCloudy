/**
 * QA fixtures for verify-pdf-signatures (and its browser QA).
 *
 * Builds REAL cryptographic signatures with openssl (sandbox tooling):
 *   1. A self-signed RSA-2048 cert ("DocoPDF QA Signer"), then
 *   2. a 2-page pdf-lib PDF carrying a /Sig field with a padded
 *      /Contents placeholder + "[ 0 0 0 0 ]" /ByteRange placeholder,
 *   3. byte-accurate patching of the saved PDF (fixed-width ByteRange
 *      digits, /Contents DER padded with zeros — the Adobe recipe), and
 *      `openssl cms -sign -binary -detached -md sha256` over the two
 *      covered ranges.
 *
 * Outputs (public/qa/sign-fixtures/):
 *   signed.pdf     — one valid SHA-256/RSA signature          (expected: VERIFIED)
 *   tampered.pdf    — signed.pdf with one byte flipped inside the signed range (MODIFIED)
 *   trailing.pdf    — signed.pdf + garbage after %%EOF         (VERIFIED + trailing bytes)
 *   unsigned.pdf    — /Sig field present, never signed         (unsigned field)
 *
 * Re-runnable: bun scripts/make-verify-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
} from "@cantoo/pdf-lib";

const OUT_DIR = "public/qa/sign-fixtures";

function sh(cmd: string): string {
  const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${cmd}): ${res.stderr ?? ""}${res.stdout ?? ""}`
    );
  }
  return res.stdout ?? "";
}

async function buildBasePdf(
  withValue: boolean,
  mStamp = "D:20250115093000+00'00'"
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([420, 300]);
  const page2 = doc.addPage([420, 300]);

  page1.drawText("QA SIGNED FIXTURE — page one", {
    x: 24,
    y: 260,
    size: 14,
    font,
  });
  page1.drawText("This file exists to test signature verification.", {
    x: 24,
    y: 236,
    size: 10,
    font,
  });
  page2.drawText("QA SIGNED FIXTURE — page two", {
    x: 24,
    y: 260,
    size: 14,
    font,
  });

  const ctx = doc.context;
  const widgetRef = ctx.register(
    ctx.obj(
      withValue
        ? {
            Type: "Annot",
            Subtype: "Widget",
            FT: "Sig",
            T: PDFString.of("Signature1"),
            Rect: ctx.obj([20, 20, 220, 60]),
            F: 4,
            V: ctx.obj({
              Type: "Sig",
              Filter: "Adobe.PPKLite",
              SubFilter: "adbe.pkcs7.detached",
              ByteRange: [0, 0, 0, 0],
              Contents: PDFHexString.of("A".repeat(8192)),
              Name: PDFString.of("DocoPDF QA Signer"),
              M: PDFString.of(mStamp),
              Reason: PDFString.of("QA fixture signature"),
            }),
          }
        : {
            Type: "Annot",
            Subtype: "Widget",
            FT: "Sig",
            T: PDFString.of("Signature1"),
            Rect: ctx.obj([20, 20, 220, 60]),
            F: 4,
          }
    )
  );
  const acro = ctx.obj({ Fields: ctx.obj([widgetRef]) });
  doc.catalog.set(PDFName.of("AcroForm"), acro);
  page1.node.set(PDFName.of("Annots"), ctx.obj([widgetRef]));

  // Plain layout — the sig field must be byte-addressable for patching.
  return doc.save({ useObjectStreams: false });
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Replace exactly `removeCount` chars at `index` (length may change). */
function splice(
  text: string,
  index: number,
  removeCount: number,
  replacement: string
): string {
  return text.slice(0, index) + replacement + text.slice(index + removeCount);
}

/** Same-width overwrite (replacement.length === removeCount). */
function patchAt(text: string, index: number, replacement: string): string {
  return splice(text, index, replacement.length, replacement);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cert = path.join(OUT_DIR, "qa-cert.pem");
  const key = path.join(OUT_DIR, "qa-key.pem");
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    sh(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 3650 ` +
        `-subj "/CN=DocoPDF QA Signer/O=DocoPDF QA/C=IN"`
    );
    console.log("self-signed cert created");
  } else {
    console.log("self-signed cert reused");
  }

  /* ---------- 1. signed.pdf ---------- */
  // /M must fall inside the cert window — read notBefore from the cert and
  // sign "one day later" so validityAtSigning === "valid" regardless of when
  // the fixture is regenerated.
  const notBefore = sh(
    `openssl x509 -in "${cert}" -noout -startdate | cut -d= -f2`
  ).trim();
  const mDate = new Date(new Date(notBefore).getTime() + 86_400_000);
  const mStamp =
    `D:${mDate.getUTCFullYear()}${String(mDate.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(mDate.getUTCDate()).padStart(2, "0")}093000+00'00'`;
  fs.writeFileSync(path.join(OUT_DIR, ".mstamp.txt"), mStamp);

  const baseBytes = await buildBasePdf(true, mStamp);
  let text = latin1(baseBytes);

  // Fixed-width ByteRange: 4 x 10-digit numbers, spliced in place later.
  const brPlaceholder = "[ 0 0 0 0 ]";
  const brIndex = text.indexOf(brPlaceholder);
  if (brIndex < 0) throw new Error("ByteRange placeholder not found");
  const brPadded = "[ 0000000000 0000000000 0000000000 0000000000 ]";
  text = splice(text, brIndex, brPlaceholder.length, brPadded);

  // Locate the /Contents hex gap (the unique long 'A' run).
  const aRun = "A".repeat(8192);
  const contentsHexStart = text.indexOf(aRun);
  if (contentsHexStart < 0) throw new Error("Contents placeholder not found");
  const contentsHexEnd = contentsHexStart + aRun.length;

  // ByteRange: [0, hexStart, hexEnd, fileLen - hexEnd]
  const o1 = 0;
  const l1 = contentsHexStart;
  const o2 = contentsHexEnd;
  const l2 = text.length - o2;
  const pad = (n: number): string => String(n).padStart(10, "0");
  const brNumbers = `${pad(o1)} ${pad(l1)} ${pad(o2)} ${pad(l2)}`;
  // Splice over the four zero-groups (same width as brPadded numbers).
  const numbersIndex = brIndex + 2; // after "[ "
  text = patchAt(text, numbersIndex, brNumbers);

  // Covered = [0, l1) + [o2, o2 + l2) — ByteRange digits are final now.
  const asBytes = toBytes(text);
  const covered = new Uint8Array(l1 + l2);
  covered.set(asBytes.subarray(0, l1), 0);
  covered.set(asBytes.subarray(o2, o2 + l2), l1);

  const coveredFile = path.join(OUT_DIR, ".covered.bin");
  const derFile = path.join(OUT_DIR, ".sig.der");
  fs.writeFileSync(coveredFile, covered);
  sh(
    `openssl cms -sign -binary -outform DER -md sha256 ` +
      `-signer "${cert}" -inkey "${key}" -in "${coveredFile}" -out "${derFile}"`
  );
  const der = fs.readFileSync(derFile);
  const derHex = Buffer.from(der).toString("hex").toUpperCase();
  if (derHex.length > aRun.length) {
    throw new Error(
      `CMS too large (${derHex.length} hex chars > ${aRun.length}) — widen the gap`
    );
  }
  // Pad with zeros to the full gap (readers ignore the padding).
  text = patchAt(
    text,
    contentsHexStart,
    derHex + "0".repeat(aRun.length - derHex.length)
  );

  const signed = toBytes(text);
  fs.writeFileSync(path.join(OUT_DIR, "signed.pdf"), signed);
  console.log(`signed.pdf: ${signed.length} bytes, CMS ${der.length} bytes DER`);

  /* ---------- 2. tampered.pdf — change a byte inside the signed range ---------- */
  // Page content streams are Flate-compressed (a flipped byte there would
  // corrupt the stream, not represent an edit) — the page 1 MediaBox is
  // plain text INSIDE the signed range: widening it by 1 pt is exactly the
  // "edited after signing" case the digest check must catch.
  let tampered = latin1(signed);
  const mediaBox = "/MediaBox [ 0 0 420 300 ]";
  const mbIndex = tampered.indexOf(mediaBox);
  if (mbIndex < 0) throw new Error("MediaBox marker not found");
  tampered = patchAt(
    tampered,
    mbIndex,
    "/MediaBox [ 0 0 421 300 ]"
  );
  fs.writeFileSync(path.join(OUT_DIR, "tampered.pdf"), toBytes(tampered));
  console.log("tampered.pdf written (page 1 widened 420 -> 421 after signing)");

  /* ---------- 3. trailing.pdf — append after %%EOF ---------- */
  const trailing = toBytes(latin1(signed) + "\n% trailing bytes added after signing\n");
  // "\n" + 36 + "\n" = 38 appended bytes.
  fs.writeFileSync(path.join(OUT_DIR, "trailing.pdf"), trailing);
  console.log("trailing.pdf written");

  /* ---------- 4. unsigned.pdf — field, never signed ---------- */
  const unsigned = await buildBasePdf(false);
  fs.writeFileSync(path.join(OUT_DIR, "unsigned.pdf"), unsigned);
  console.log("unsigned.pdf written");

  // Temp artifacts out.
  fs.rmSync(coveredFile, { force: true });
  fs.rmSync(derFile, { force: true });
  console.log("done.");
}

void main();
