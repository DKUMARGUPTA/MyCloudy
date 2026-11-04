/**
 * PRE-BUILD smoke test for the verify-pdf-signatures engine.
 *
 * Runs the REAL analysis (pdf-lib field walk + pkijs CMS parse + WebCrypto
 * hashing + pkijs signature verify — bun has WebCrypto) against the openssl
 * fixtures from scripts/make-verify-fixtures.ts:
 *
 *   signed.pdf    → 1 signature, integrity VERIFIED, signer CN, SHA-256,
 *                   RSA 2048, signing time parsed, no trailing bytes.
 *   tampered.pdf  → integrity MODIFIED (MediaBox widened after signing).
 *   trailing.pdf  → integrity VERIFIED + trailingBytes > 0.
 *   unsigned.pdf  → 0 signatures, 1 unsigned field.
 *   plain pdf-lib doc → 0 signatures, 0 unsigned fields.
 *
 * Plus unit checks: PDF date parser (offsets, partial dates, junk).
 *
 * Run: bun scripts/smoke-verify-signatures.ts
 */
import fs from "node:fs";
import { PDFDocument } from "@cantoo/pdf-lib";

import {
  analyzeSignatures,
  buildVerifyReport,
  parsePdfDate,
} from "../tools/verify-pdf-signatures/engine";

let passed = 0;
let failed = 0;
let checkNo = 0;

function check(ok: boolean, label: string): void {
  checkNo += 1;
  if (ok) {
    passed += 1;
    console.log(`${checkNo}. PASS ${label}`);
  } else {
    failed += 1;
    console.error(`${checkNo}. FAIL ${label}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    ok,
    ok ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

function readFixture(name: string): Uint8Array {
  const bytes = fs.readFileSync(`public/qa/sign-fixtures/${name}`);
  return new Uint8Array(bytes);
}

/* ---------------------------- signed.pdf ---------------------------- */
{
  const report = await analyzeSignatures(readFixture("signed.pdf"));
  eq(report.signatures.length, 1, "signed: one signature found");
  eq(report.unsignedFields, 0, "signed: no unsigned fields");
  eq(report.pageCount, 2, "signed: 2 pages");
  eq(report.allIntact, true, "signed: allIntact");
  const sig = report.signatures[0];
  eq(sig.integrity, "verified", "signed: integrity verified");
  eq(sig.subFilter, "adbe.pkcs7.detached", "signed: subfilter");
  eq(sig.signerName, "DocoPDF QA Signer", "signed: signer from /Name");
  eq(sig.cert?.commonName, "DocoPDF QA Signer", "signed: cert CN");
  eq(sig.cert?.subjectOrg, "DocoPDF QA", "signed: cert O");
  eq(sig.cert?.publicKey.kind, "RSA", "signed: RSA key");
  eq(sig.cert?.publicKey.bits, 2048, "signed: RSA 2048 bits");
  eq(sig.cert?.validityAtSigning, "valid", "signed: cert valid at signing time");
  check(
    sig.signingTimeIso !== null &&
      /^\d{4}-\d{2}-\d{2}T09:30:00\.000Z$/.test(sig.signingTimeIso),
    `signed: signing time parsed (${sig.signingTimeIso})`
  );
  // /M is notBefore + 1 day — inside the cert window by construction.
  check(
    sig.cert?.notBeforeIso !== null &&
      sig.signingTimeIso !== null &&
      sig.signingTimeIso > sig.cert!.notBeforeIso!,
    "signed: signing time falls after cert notBefore"
  );
  eq(sig.digestAlgorithm, "SHA-256", "signed: SHA-256 digest");
  check(
    typeof sig.signatureAlgorithm === "string" &&
      sig.signatureAlgorithm.includes("SHA-256"),
    `signed: signature algorithm (${sig.signatureAlgorithm})`
  );
  eq(sig.coverage.trailingBytes, 0, "signed: no trailing bytes");
  check(
    typeof sig.cert?.sha256Hex === "string" && sig.cert.sha256Hex.length === 64,
    "signed: 32-byte cert fingerprint"
  );
  check(
    typeof sig.cert?.serialHex === "string" && sig.cert.serialHex.length > 8,
    "signed: serial number"
  );
  check(sig.signatureOverAttrs !== false, "signed: attrs signature ok");
}

/* --------------------------- tampered.pdf --------------------------- */
{
  const report = await analyzeSignatures(readFixture("tampered.pdf"));
  const sig = report.signatures[0];
  eq(sig.integrity, "modified", "tampered: integrity modified");
  eq(report.allIntact, false, "tampered: allIntact false");
  check(sig.note !== null && /digest/.test(sig.note), "tampered: mismatch note");
  // The tamper touched the PAGE, not the signature: the signer's own
  // metadata must still verify independently.
  eq(
    sig.signatureOverAttrs,
    true,
    "tampered: attrs signature still authentic"
  );
}

/* ---------------------------- trailing.pdf ------------------------- */
{
  const report = await analyzeSignatures(readFixture("trailing.pdf"));
  const sig = report.signatures[0];
  eq(sig.integrity, "verified", "trailing: integrity still verified");
  check(
    sig.coverage.trailingBytes === 38,
    `trailing: 38 trailing bytes (got ${sig.coverage.trailingBytes})`
  );
}

/* ---------------------------- unsigned.pdf ------------------------- */
{
  const report = await analyzeSignatures(readFixture("unsigned.pdf"));
  eq(report.signatures.length, 0, "unsigned: no signatures");
  eq(report.unsignedFields, 1, "unsigned: one unsigned field");
  eq(report.allIntact, false, "unsigned: allIntact false (nothing signed)");
}

/* ------------------------------ plain doc -------------------------- */
{
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  const bytes = await doc.save();
  const report = await analyzeSignatures(bytes);
  eq(report.signatures.length, 0, "plain: no signatures");
  eq(report.unsignedFields, 0, "plain: no fields at all");
  eq(report.pageCount, 2, "plain: page count");
}

/* ------------------------- PDF date parser ------------------------- */
eq(
  parsePdfDate("D:20250115093000+00'00'"),
  "2025-01-15T09:30:00.000Z",
  "date: +00'00' offset"
);
eq(
  parsePdfDate("D:20250115150000+05'30'"),
  "2025-01-15T09:30:00.000Z",
  "date: +05'30' IST offset"
);
eq(
  parsePdfDate("D:20250701"),
  "2025-07-01T00:00:00.000Z",
  "date: date-only"
);
eq(
  parsePdfDate("D:20250101123045Z"),
  "2025-01-01T12:30:45.000Z",
  "date: Z suffix"
);
eq(parsePdfDate("not a date"), null, "date: junk rejected");
eq(parsePdfDate("D:2025"), "2025-01-01T00:00:00.000Z", "date: year only");

/* ------------------------- report artifact ------------------------- */
{
  const report = await analyzeSignatures(readFixture("signed.pdf"));
  const text = buildVerifyReport("signed.pdf", report);
  check(
    text.includes("VERIFIED — the signed bytes are unchanged") &&
      text.includes("DocoPDF QA Signer") &&
      text.includes("SHA-256 fingerprint") &&
      text.includes("offline by design"),
    "report: verdict + signer + fingerprint + offline honesty present"
  );
  const empty = buildVerifyReport("x.pdf", {
    pageCount: 1,
    fileBytes: 10,
    signatures: [],
    unsignedFields: 0,
    allIntact: false,
    encrypted: false,
  });
  check(
    empty.includes("No signed signature found"),
    "report: empty case handled"
  );
}

console.log(
  `\n${passed} passed, ${failed} failed (${checkNo} checks)`
);
if (failed > 0) process.exit(1);
