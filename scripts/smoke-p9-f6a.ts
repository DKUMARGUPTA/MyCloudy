/**
 * P9-F6A smoke: the pki-common crypto core — p12 parsing, x509 reading,
 * CMS build/parse, full sign→verify round trips, tamper detection and
 * CROSS-VALIDATION against the system OpenSSL (both directions).
 * Run: bun scripts/smoke-p9-f6a.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

import { parseP12, P12Error } from "../tools/pki-common/p12";
import { parseCertificate } from "../tools/pki-common/x509";
import { verifyCertIssuedBy, isSelfSigned } from "../tools/pki-common/x509";
import {
  buildDetachedContentInfo,
  parseSignedDataDer,
  findSignerCert,
  certSerial,
} from "../tools/pki-common/cms";
import { signPdf } from "../tools/pki-common/pdfsign";
import { verifyPdfSignatures } from "../tools/pki-common/verify";
import { sha, toHex } from "../tools/pki-common/asn1";
import { PDFDocument } from "pdf-lib";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const PKI = "qa/pki";
const TMP = "/tmp/pki-smoke";
mkdirSync(TMP, { recursive: true });

/* ------------------------- p12 parsing ------------------------- */
console.log("p12 parsing");

const rsaP12 = new Uint8Array(readFileSync(`${PKI}/signer-rsa.p12`));
const ecP12 = new Uint8Array(readFileSync(`${PKI}/signer-ec.p12`));

const rsa = await parseP12(rsaP12, "test1234");
check("rsa p12 opens", rsa.keyPkcs8.length > 200, `pkcs8=${rsa.keyPkcs8.length}`);
check("rsa p12 has chain", rsa.chainCerts.length === 1);

let wrongPw = false;
try {
  await parseP12(rsaP12, "nope");
} catch (e) {
  wrongPw = e instanceof P12Error && (e as P12Error).code === "bad-password";
}
check("wrong password → bad-password", wrongPw);

const ec = await parseP12(ecP12, "test1234");
check("ecdsa p12 opens", ec.keyPkcs8.length > 100);

/* ------------------------- x509 reading ------------------------- */
console.log("x509 reading");

const rc = parseCertificate(rsa.certDer);
check("subject CN", rc.subject.CN === "Asha Verma", rc.subject.CN);
check("subject email", rc.subject.email === "asha@example.com");
check("issuer CN", rc.issuer.CN === "DocoPDF Test Root");
check("keyKind rsa", rc.keyKind === "rsa");
check("isCA false", rc.isCA === false);
check("keyUsage", rc.keyUsage.includes("digitalSignature") && rc.keyUsage.includes("nonRepudiation"));
check(
  "extKeyUsage has Adobe trust",
  rc.extKeyUsage.includes("adobeAuthenticDocumentsTrust") || rc.extKeyUsage.includes("1.2.840.113583.1.1.5")
);
check("validity span", rc.notBefore < rc.notAfter);

const caInfo = parseCertificate(rsa.chainCerts[0]);
check("CA isCA true", caInfo.isCA === true);
check("CA keyCertSign", caInfo.keyUsage.includes("keyCertSign"));

const chainLink = await verifyCertIssuedBy(rc, caInfo);
check("leaf issued by CA (crypto)", chainLink === true);
const selfSignedLeaf = await isSelfSigned(rc);
check("leaf not self-signed", selfSignedLeaf === false);
const selfSignedCA = await isSelfSigned(caInfo);
check("CA self-signed", selfSignedCA === true);

const ecc = parseCertificate(ec.certDer);
check("ecdsa keyKind", ecc.keyKind === "ecdsa-p256");
const ecChainLink = await verifyCertIssuedBy(ecc, caInfo);
check("ecdsa leaf issued by CA", ecChainLink === true);

/* ------------------------- CMS build + parse ------------------------- */
console.log("cms build + parse");

const content = new TextEncoder().encode(
  "The quick brown fox jumps over the lazy dog. त्वरित भूरी लोमड़ी 0123456789".repeat(3)
);
// A signing time safely inside the test certs validity (they are created
// moments before this smoke runs — a fixed earlier date would trip the
// period check, which is exactly what happened in the first draft).
const when = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000); // UTCTime = second precision
const cms = await buildDetachedContentInfo(content, rsa, { signingTime: when });
check("cms built", cms.length > 800 && cms.length < 8192, `len=${cms.length}`);

const parsed = parseSignedDataDer(cms);
check("one signerInfo", parsed.signerInfos.length === 1);
check("two certs embedded", parsed.certs.length === 2);
const si = parsed.signerInfos[0];
check("digest sha256", si.digestOid === "2.16.840.1.101.3.4.2.1");
check("contentType data", si.contentType === "1.2.840.113549.1.7.1");
check("signingTime", si.signingTime?.getTime() === when.getTime());
const contentHash = toHex(await sha("SHA-256", content));
check("messageDigest matches", toHex(si.messageDigest ?? new Uint8Array()) === contentHash);
check("serial matches cert", certSerial(rc) === si.serial);

const found = findSignerCert(parsed, si);
check("findSignerCert", found?.info.subject.CN === "Asha Verma");

/* ------------------------- openssl cross-validation ------------------------- */
console.log("openssl cross-validation (our CMS → openssl verify)");

writeFileSync(`${TMP}/covered.bin`, content);
writeFileSync(`${TMP}/ours.der`, cms);
let opensslOk = false;
let opensslOut = "";
try {
  opensslOut = execFileSync(
    "openssl",
    ["smime", "-verify", "-inform", "DER", "-in", `${TMP}/ours.der`, "-content", `${TMP}/covered.bin`, "-noverify", "-purpose", "any"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  opensslOk = true;
} catch (e) {
  opensslOut = String((e as { stderr?: Buffer }).stderr ?? e);
}
check("openssl verifies OUR cms", opensslOk, opensslOut.slice(0, 120));

console.log("openssl cross-validation (openssl CMS → our parser)");
execFileSync("openssl", ["smime", "-sign", "-binary", "-md", "sha256", "-signer", `${PKI}/leaf-rsa.pem`, "-inkey", `${PKI}/leaf-rsa.key`, "-outform", "DER", "-in", `${TMP}/covered.bin`, "-out", `${TMP}/openssl.der`]);
const theirs = new Uint8Array(readFileSync(`${TMP}/openssl.der`));
const parsedTheirs = parseSignedDataDer(theirs);
check("our parser reads openssl cms", parsedTheirs.signerInfos.length === 1);
check("openssl cms serial matches", certSerial(rc) === parsedTheirs.signerInfos[0].serial);

// Verify openssl's signature ourselves over their signedAttrs.
{
  const si2 = parsedTheirs.signerInfos[0];
  const signer2 = findSignerCert(parsedTheirs, si2);
  check("openssl signer cert found", !!signer2);
  if (signer2 && si2.signedAttrsDer) {
    const setForm = new Uint8Array(si2.signedAttrsDer);
    setForm[0] = 0x31; // [0] IMPLICIT → SET OF for verification
    const key = await crypto.subtle.importKey(
      "spki",
      signer2.info.spkiDer as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      si2.signature as BufferSource,
      setForm as BufferSource
    );
    check("we verify openssl's signature", ok === true);
  }
}

/* ------------------------- PDF sign → verify round trip ------------------------- */
console.log("pdf sign → verify round trip");

async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Signature smoke test document", { x: 60, y: 760, size: 16 });
  page.drawText("Line two for content weight.", { x: 60, y: 730, size: 12 });
  return new Uint8Array(await doc.save());
}

const samplePdf = await makeSamplePdf();
const signed = await signPdf(samplePdf, {
  p12: rsaP12,
  password: "test1234",
  reason: "Smoke test",
  visible: { page: 1, name: "Asha Verma", reason: "Smoke test", locale: "en" },
  signingTime: when,
});
check("signed pdf produced", signed.bytes.length > samplePdf.length + 800);
check("signer reported", signed.signer.subject.CN === "Asha Verma");

const report = await verifyPdfSignatures(signed.bytes);
check("verify finds signature", report.hasSignature && report.found.length === 1);
const r0 = report.found[0];
check("document intact", r0.documentIntact === true);
check("signature valid", r0.valid === true);
check("signer cert matches", r0.signer?.subject.CN === "Asha Verma");
check("signing time round-trips", r0.signingTime?.getTime() === when.getTime());
const periodOk = r0.checks.find((c) => c.id === "cert-period");
check("cert period pass", periodOk?.status === "pass");

// The signed PDF still opens in pdf-lib.
{
  const reopen = await PDFDocument.load(signed.bytes, { ignoreEncryption: true });
  check("signed pdf reopens", reopen.getPageCount() === 1);
}

// Cross-check the PDF's embedded CMS with openssl too.
{
  const { extractSignatureSlots } = await import("../tools/pki-common/verify");
  const slots = extractSignatureSlots(signed.bytes);
  check("slot extraction", slots.length === 1);
  const [o1, l1, o2, l2] = slots[0].byteRange;
  const coveredPdf = new Uint8Array(l1 + l2);
  coveredPdf.set(signed.bytes.subarray(o1, o1 + l1), 0);
  coveredPdf.set(signed.bytes.subarray(o2, o2 + l2), l1);
  writeFileSync(`${TMP}/pdf-covered.bin`, coveredPdf);
  writeFileSync(`${TMP}/pdf-sig.der`, slots[0].contentsDer);
  let ok = false;
  try {
    execFileSync(
      "openssl",
      ["smime", "-verify", "-inform", "DER", "-in", `${TMP}/pdf-sig.der`, "-content", `${TMP}/pdf-covered.bin`, "-noverify", "-purpose", "any"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    ok = true;
  } catch {
    ok = false;
  }
  check("openssl verifies the PDF's cms", ok);
}

/* ------------------------- tamper detection ------------------------- */
console.log("tamper detection");

const tampered = new Uint8Array(signed.bytes);
// Flip a byte inside the first covered range (well before /Contents).
tampered[Math.floor(r0.byteRange[1] / 2)] ^= 0x01;
const tamperedReport = await verifyPdfSignatures(tampered);
check("tamper detected", tamperedReport.found[0].documentIntact === false);
check("tamper invalid", tamperedReport.found[0].valid === false);

/* ------------------------- ECDSA pdf round trip ------------------------- */
console.log("ecdsa pdf round trip");

const signedEc = await signPdf(samplePdf, {
  p12: ecP12,
  password: "test1234",
  signingTime: when,
});
const reportEc = await verifyPdfSignatures(signedEc.bytes);
check("ecdsa verify finds signature", reportEc.hasSignature);
check("ecdsa signature valid", reportEc.found[0]?.valid === true,
  JSON.stringify(reportEc.found[0]?.checks));
check("ecdsa signer", reportEc.found[0]?.signer?.subject.CN === "Rahul Sharma");

/* ------------------------- unsigned pdf ------------------------- */
console.log("unsigned pdf");

const unsigned = await verifyPdfSignatures(samplePdf);
check("unsigned → hasSignature false", unsigned.hasSignature === false);

/* ------------------------- verdict ------------------------- */
console.log(`\n${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
