/**
 * QA fixtures for digital-signature (and its browser QA).
 *
 * Builds with openssl (sandbox tooling), re-runnable:
 *   - qa-rsa-key/cert.pem      RSA-2048 self-signed "DocoPDF Digital Signer"
 *   - qa-ec-key/cert.pem       EC P-256 self-signed "DocoPDF EC Signer"
 *   - qa-ca/user pair          mini CA + user cert signed by it (chain test)
 *   - modern-aes.p12           OpenSSL 3 defaults (AES-256-CBC + SHA-256 MAC)
 *   - legacy.p12               -legacy (3DES key + RC2-40 certs + SHA-1 MAC)
 *   - chain.p12                user + CA certs, PBES2
 *   - ec.p12                   EC P-256, PBES2
 *   - document.pdf             2-page pdf-lib PDF
 *
 * Password for every .p12: docopdf
 *
 * Re-runnable: bun scripts/make-dsign-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

const OUT_DIR = "public/qa/dsign-fixtures";

function sh(cmd: string): string {
  const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`command failed (${cmd}): ${res.stderr ?? ""}${res.stdout ?? ""}`);
  }
  return res.stdout ?? "";
}

async function buildDocument(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([420, 300]);
  const p2 = doc.addPage([420, 300]);
  p1.drawText("Digital signature QA document - page one", {
    x: 24, y: 260, size: 14, font,
  });
  p1.drawText("This file exists to test certificate-based signing.", {
    x: 24, y: 236, size: 10, font,
  });
  p2.drawText("Digital signature QA document - page two", {
    x: 24, y: 260, size: 14, font,
  });
  fs.writeFileSync(path.join(OUT_DIR, "document.pdf"), await doc.save());
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rsaKey = path.join(OUT_DIR, "qa-rsa-key.pem");
  const rsaCert = path.join(OUT_DIR, "qa-rsa-cert.pem");
  if (!fs.existsSync(rsaCert)) {
    sh(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${rsaKey}" -out "${rsaCert}" -days 3650 ` +
        `-subj "/CN=DocoPDF Digital Signer/O=DocoPDF QA/C=IN"`
    );
    console.log("rsa cert created");
  } else {
    console.log("rsa cert reused");
  }

  const ecKey = path.join(OUT_DIR, "qa-ec-key.pem");
  const ecCert = path.join(OUT_DIR, "qa-ec-cert.pem");
  if (!fs.existsSync(ecCert)) {
    sh(
      `openssl ecparam -name prime256v1 -genkey -noout -out "${ecKey}" && ` +
        `openssl req -x509 -new -key "${ecKey}" -out "${ecCert}" -days 3650 ` +
        `-subj "/CN=DocoPDF EC Signer/O=DocoPDF QA/C=IN"`
    );
    console.log("ec cert created");
  } else {
    console.log("ec cert reused");
  }

  // Mini CA + user cert for the chain case.
  const caKey = path.join(OUT_DIR, "qa-ca-key.pem");
  const caCert = path.join(OUT_DIR, "qa-ca-cert.pem");
  const userKey = path.join(OUT_DIR, "qa-user-key.pem");
  const userCert = path.join(OUT_DIR, "qa-user-cert.pem");
  if (!fs.existsSync(userCert)) {
    sh(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${caKey}" -out "${caCert}" -days 3650 ` +
        `-subj "/CN=DocoPDF QA CA/O=DocoPDF QA/C=IN" && ` +
        `openssl req -newkey rsa:2048 -nodes -keyout "${userKey}" -out "${path.join(OUT_DIR, "qa-user.csr")}" ` +
        `-subj "/CN=Chained User/O=DocoPDF QA/C=IN" && ` +
        `openssl x509 -req -in "${path.join(OUT_DIR, "qa-user.csr")}" -CA "${caCert}" -CAkey "${caKey}" ` +
        `-CAcreateserial -out "${userCert}" -days 3650 2>/dev/null`
    );
    fs.rmSync(path.join(OUT_DIR, "qa-user.csr"), { force: true });
    console.log("ca chain created");
  } else {
    console.log("ca chain reused");
  }

  // The .p12 files (regenerate every run so algorithm defaults stay fresh).
  const out = (name: string): string => path.join(OUT_DIR, name);

  sh(
    `openssl pkcs12 -export -out "${out("modern-aes.p12")}" -inkey "${rsaKey}" -in "${rsaCert}" ` +
      `-passout pass:docopdf -name "DocoPDF Digital Signer"`
  );
  console.log("modern-aes.p12 (OpenSSL 3 defaults)");

  sh(
    `openssl pkcs12 -export -out "${out("legacy.p12")}" -inkey "${rsaKey}" -in "${rsaCert}" ` +
      `-passout pass:docopdf -legacy -name "DocoPDF Digital Signer"`
  );
  console.log("legacy.p12 (3DES + RC2-40, SHA-1 MAC)");

  sh(
    `openssl pkcs12 -export -out "${out("chain.p12")}" -inkey "${userKey}" -in "${userCert}" ` +
      `-certfile "${caCert}" -passout pass:docopdf -name "Chained User"`
  );
  console.log("chain.p12 (user + CA, PBES2)");

  sh(
    `openssl pkcs12 -export -out "${out("ec.p12")}" -inkey "${ecKey}" -in "${ecCert}" ` +
      `-passout pass:docopdf -name "DocoPDF EC Signer"`
  );
  console.log("ec.p12 (P-256, PBES2)");

  await buildDocument();
  console.log("document.pdf written");
  console.log("done.");
}

void main();
