/**
 * Smoke: verify-pdf-signatures (RB6-FIN-c2 — the 95th tool, view category) —
 * the honest on-device PDF signature analyzer.
 *
 * House conventions (smoke-request-signature / smoke-validate-e-invoice /
 * smoke-pdf-to-e-invoice): relative imports WITHOUT .ts, plain check()
 * helper, every check counted, process.exit(0) when 0 failed.
 *
 *  1. DER/ASN.1 reader units — readTlv short/long/indefinite/truncated/
 *     high-tag forms, tlvChildren, readOid (all three first-arc cases),
 *     intBytes, tlvBytes, readAsn1Time (UTCTime/GeneralizedTime/zones),
 *     formatUtc, decodeHexStrict, bytesToHex, toLatin, sniffPdfBytes,
 *     digestInfoFor/sigAlgoInfoFor, verifyRsaPkcs1 (true/false/null).
 *  2. PDF value parser + date + ByteRange units — parsePdfValue (dicts,
 *     arrays, refs vs numbers, literal escapes, hex strings, names),
 *     decodePdfDate (zones/minimal/junk), readByteRange (ok/missing/3
 *     entries/non-integer), coveredBytes (ok + out-of-bounds).
 *  3. REAL signed fixtures, built entirely in this smoke with node:crypto:
 *     a hand-rolled minimal self-signed CA certificate + a CA-issued signer
 *     certificate (TBS DER built by hand, signed via createSign), then a
 *     pdf-lib document with an appended incremental update carrying a real
 *     CMS SignedData (signedAttrs messageDigest over the exact /ByteRange
 *     covered bytes, signature over the 0xA0→0x31 re-tagged attrs DER) —
 *     the model must report the right signer CN/O/OU/C/email, serial,
 *     digest MATCH, crypto PASS, intact, coverage complete, no notes.
 *  4. Certificate variants — self-signed (amber + nSelfSigned), expired
 *     (nExpired + nSignTimeOutside), not-yet-valid, SHA-1 (nWeakDigest,
 *     still intact), no-sid-certificate (crypto NOT VERIFIED, honest amber
 *     — pinned the fixed verdict), a second never-signed /FT /Sig field.
 *  5. Tamper vectors — a byte flipped inside the covered range → digest
 *     MISMATCH → TAMPERED red; bytes appended after the covered ranges →
 *     "modified after signing" amber; ≤16 whitespace bytes tolerated;
 *     the CMS signature bytes corrupted → crypto FAIL red (integrity still
 *     intact); malformed /Contents hex → honest nContentsBad; a corrupted
 *     /ByteRange entry → nRangeBounds.
 *  6. Edge vectors — plain unsigned document (EMPTY report, not an error),
 *     no /AcroForm, AcroForm with a /Tx field, /FT /Sig with an empty /V
 *     (reported unsigned, page included), /V null, /V with only /ByteRange,
 *     a broken base xref (linear-scan recovery still verifies green),
 *     trailer /Encrypt → errEncrypted, non-PDF → errNotPdf, >64 MB →
 *     errTooBig.
 *  7. buildReportText — English fallback labels, Hindi labels from the
 *     tool catalog, tampered/unsigned/unsigned-field report sections.
 *  8. The REAL worker (self-shimmed globalThis, the request-signature
 *     recipe): green run (output name/mime, detail counts, progress beats,
 *     report text), tampered run, unsigned run, non-PDF error, encrypted
 *     error, no-file error, garbage options.run, non-run messages ignored.
 *  9. i18n parity + key resolution (NOTE the prefix length: "vps." is 4
 *     characters — slice(4)) + REPORT_KEYS extraction from the surface +
 *     model-EN-label drift check + wiring (configs/surfaces/registry).
 *
 * Run: bun scripts/smoke-verify-pdf-signatures.ts
 */
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  MAX_INPUT_BYTES,
  OID_ATTR_CONTENT_TYPE,
  OID_ATTR_MESSAGE_DIGEST,
  OID_ATTR_SIGNING_TIME,
  OID_C,
  OID_CN,
  OID_DATA,
  OID_EMAIL,
  OID_O,
  OID_OU,
  OID_SHA1,
  OID_SHA1_RSA,
  OID_SHA256,
  OID_SHA256_RSA,
  OID_SIGNED_DATA,
  REPORT_LABELS_EN,
  VerifyError,
  analyzeSignatures,
  buildReportText,
  bytesToHex,
  coveredBytes,
  decodeHexStrict,
  decodePdfDate,
  digestInfoFor,
  formatUtc,
  intBytes,
  outputBaseName,
  parseCertificate,
  parseCms,
  parsePdfValue,
  parseRun,
  readAsn1Time,
  readByteRange,
  readOid,
  readTlv,
  sigAlgoInfoFor,
  sniffPdfBytes,
  toLatin,
  tlvBytes,
  tlvChildren,
  verifyRsaPkcs1,
  walkPdf,
} from "../tools/verify-pdf-signatures/model";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import toolI18n from "../tools/verify-pdf-signatures/i18n.json";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* small helpers                                                        */
/* ------------------------------------------------------------------ */

/** Fixed-width 10-digit numbers keep every fixture byte position stable. */
function pad10(n: number): string {
  return String(n).padStart(10, "0");
}

/** latin1 string span → bytes (charCodeAt & 0xff — byte-faithful). */
function latin1BytesOf(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ------------------------------------------------------------------ */
/* DER builders (hand-rolled, node:crypto signed)                       */
/* ------------------------------------------------------------------ */

function derLenBytes(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: Buffer | number[]): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag, ...derLenBytes(body.length)]), body]);
}

function derOid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const body: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i]!;
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return tlv(0x06, body);
}

function derInt(big: bigint): Buffer {
  let hex = big.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const body = Buffer.from(hex, "hex");
  if (body[0]! >= 0x80) return tlv(0x02, Buffer.concat([Buffer.from([0x00]), body]));
  return tlv(0x02, body);
}

function derSeq(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function derSet(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function derNullAlg(oid: string): Buffer {
  return derSeq(derOid(oid), tlv(0x05, []));
}

function derPrintable(s: string): Buffer {
  return tlv(0x13, Buffer.from(s, "latin1"));
}

/** IA5String (tag 22) — what emailAddress RDNs use. */
function derIA5(s: string): Buffer {
  return tlv(0x16, Buffer.from(s, "latin1"));
}

function derUtc(d: Date): Buffer {
  const p = (x: number): string => String(x).padStart(2, "0");
  return tlv(
    0x17,
    Buffer.from(
      `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
    )
  );
}

function derOctet(b: Buffer): Buffer {
  return tlv(0x04, b);
}

function derBitString(b: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), b]));
}

/* ------------------------------------------------------------------ */
/* X.509 certificate factory                                            */
/* ------------------------------------------------------------------ */

interface NameSpec {
  commonName: string;
  org: string;
  orgUnit?: string;
  country: string;
  email?: string;
}

function buildName(spec: NameSpec): Buffer {
  const parts: Buffer[] = [
    derSet(derSeq(derOid(OID_CN), derPrintable(spec.commonName))),
    derSet(derSeq(derOid(OID_O), derPrintable(spec.org))),
  ];
  if (spec.orgUnit !== undefined) {
    parts.push(derSet(derSeq(derOid(OID_OU), derPrintable(spec.orgUnit))));
  }
  parts.push(derSet(derSeq(derOid(OID_C), derPrintable(spec.country))));
  if (spec.email !== undefined) {
    parts.push(derSet(derSeq(derOid(OID_EMAIL), derIA5(spec.email))));
  }
  return derSeq(...parts);
}

interface CertSpec extends NameSpec {
  serial: bigint;
  notBefore: Date;
  notAfter: Date;
  /** Subject SPKI DER (exported from node:crypto). */
  spki: Buffer;
  /** Issuer Name DER; null → self-signed (issuer = subject). */
  issuerName: Buffer | null;
  /** The issuer's private key (or the subject's own when self-signed). */
  signKey: KeyObject;
}

function buildCert(spec: CertSpec): { der: Buffer; name: Buffer } {
  const name = buildName(spec);
  const issuer = spec.issuerName ?? name;
  const tbs = derSeq(
    tlv(0xa0, derInt(BigInt(2))), // [0] EXPLICIT version: v3
    derInt(spec.serial),
    derNullAlg(OID_SHA256_RSA),
    issuer,
    derSeq(derUtc(spec.notBefore), derUtc(spec.notAfter)),
    name,
    spec.spki
  );
  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  return {
    der: derSeq(tbs, derNullAlg(OID_SHA256_RSA), derBitString(signer.sign(spec.signKey))),
    name,
  };
}

/* ------------------------------------------------------------------ */
/* CMS (PKCS#7 SignedData) factory                                      */
/* ------------------------------------------------------------------ */

interface CmsSpec {
  certs: Buffer[];
  sidIssuer: Buffer;
  sidSerial: bigint;
  messageDigest: Buffer;
  signingTime: Date;
  signerKey: KeyObject;
  digestOid: string;
  sigOid: string;
  nodeHash: "sha256" | "sha1";
  /** SignerIdentifier as [0] subjectKeyIdentifier instead of issuer+serial. */
  sidSki?: boolean;
  /** encapContentInfo [0] eContent (attached CMS) instead of detached. */
  eContent?: Buffer;
}

function buildCms(o: CmsSpec): Buffer {
  const contentType = derSeq(derOid(OID_ATTR_CONTENT_TYPE), derSet(derOid(OID_DATA)));
  const messageDigest = derSeq(derOid(OID_ATTR_MESSAGE_DIGEST), derSet(derOctet(o.messageDigest)));
  const signingTime = derSeq(derOid(OID_ATTR_SIGNING_TIME), derSet(derUtc(o.signingTime)));
  const attrsSet = derSet(contentType, messageDigest, signingTime);
  const attrsRetagged = Buffer.from(attrsSet);
  attrsRetagged[0] = 0xa0; // [0] IMPLICIT inside the SignerInfo
  const signer = createSign(o.nodeHash === "sha256" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(attrsSet); // the signature covers the 0x31 SET form
  const signature = signer.sign(o.signerKey);
  const sid = o.sidSki
    ? tlv(0x80, Buffer.from([0x01, 0x02, 0x03, 0x04]))
    : derSeq(o.sidIssuer, derInt(o.sidSerial));
  const signerInfo = derSeq(
    derInt(BigInt(1)),
    sid,
    derNullAlg(o.digestOid),
    attrsRetagged,
    derNullAlg(o.sigOid),
    derOctet(signature)
  );
  const encap =
    o.eContent !== undefined
      ? derSeq(derOid(OID_DATA), tlv(0xa0, o.eContent))
      : derSeq(derOid(OID_DATA));
  const signedData = derSeq(
    derInt(BigInt(1)),
    derSet(derNullAlg(o.digestOid)),
    encap,
    tlv(0xa0, Buffer.concat(o.certs)),
    derSet(signerInfo)
  );
  return derSeq(derOid(OID_SIGNED_DATA), tlv(0xa0, signedData));
}

/* ------------------------------------------------------------------ */
/* The signed-PDF fixture factory                                       */
/* ------------------------------------------------------------------ */

interface BasePdfInfo {
  latin1: string;
  pageObj: number;
  catalogObj: number;
  catalogRest: string;
  prevXref: number;
  maxObj: number;
}

async function makeBasePdf(): Promise<BasePdfInfo> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Base contract body text", { x: 50, y: 400, size: 12, font });
  const saved = await doc.save({ useObjectStreams: false });
  const latin1 = Buffer.from(saved).toString("latin1");
  const kids = /Kids \[ (\d+) 0 R \]/.exec(latin1);
  const cat = /(\d+) 0 obj\n<<\n\/Type \/Catalog\n([^]*?)>>\nendobj/.exec(latin1);
  const sx = /startxref\n(\d+)\n%%EOF\s*$/.exec(latin1);
  const maxObj = Math.max(
    ...[...latin1.matchAll(/(\d+) 0 obj/g)].map((m) => Number(m[1]))
  );
  if (kids === null || cat === null || sx === null) {
    throw new Error("fixture: unexpected pdf-lib base shape");
  }
  return {
    latin1,
    pageObj: Number(kids[1]),
    catalogObj: Number(cat[1]),
    catalogRest: cat[2]!,
    prevXref: Number(sx[1]),
    maxObj,
  };
}

interface FixtureOpts {
  label: string;
  certs: Buffer[];
  sidIssuer: Buffer;
  sidSerial: bigint;
  signerKey: KeyObject;
  hash: "sha256" | "sha1";
  signingTime: Date;
  mTime: string;
  /** Also add a never-signed /FT /Sig field (empty /V). */
  unsignedField?: boolean;
  /** Corrupt the base xref keyword BEFORE signing (recovery fixture). */
  brokenBaseXref?: boolean;
}

interface BuiltFixture {
  bytes: Uint8Array;
  fileName: string;
  byteRange: [number, number, number, number];
  contentsHexStart: number;
  contentsHexLen: number;
}

const FIELD_NAME = "Signature1";
const SIGN_NAME = "Test Signer";
const REASON = "I approve this document";
const LOCATION = "Mumbai, IN";
const M_TIME = "D:20260115093000+05'30'"; // == 2026-01-15 04:00 UTC
const SIGNING_TIME = new Date(Date.UTC(2026, 0, 15, 4, 0, 0));
/** The injected deterministic clock (inside every fixture's validity). */
const NOW = Date.UTC(2026, 2, 1, 12, 0, 0);

async function buildSignedPdf(o: FixtureOpts): Promise<BuiltFixture> {
  const base = await makeBasePdf();
  let baseStr = base.latin1;
  if (o.brokenBaseXref) {
    const xi = baseStr.indexOf("\nxref\n");
    if (xi < 0) throw new Error("fixture: base xref marker not found");
    baseStr = `${baseStr.slice(0, xi + 1)}xrez\n${baseStr.slice(xi + 6)}`;
  }
  const { pageObj, catalogObj, catalogRest, prevXref, maxObj } = base;
  const acroNum = maxObj + 1;
  const fieldNum = maxObj + 2;
  const vNum = maxObj + 3;
  const extraNum = maxObj + 4;
  const digestOid = o.hash === "sha256" ? OID_SHA256 : OID_SHA1;
  const sigOid = o.hash === "sha256" ? OID_SHA256_RSA : OID_SHA1_RSA;

  const buildOnce = (hexLen: number): { hex: string; bytes: Uint8Array; range: [number, number, number, number] } => {
    const parts: string[] = [];
    const offsets: Record<string, number> = {};
    let pos = baseStr.length;
    const put = (text: string, key?: string): void => {
      if (key !== undefined) offsets[key] = pos;
      parts.push(text);
      pos += text.length;
    };
    put("\n% DocoPDF verify smoke fixture signature seed xyzzy\n");
    put(
      `${catalogObj} 0 obj\n<<\n/Type /Catalog\n/AcroForm ${acroNum} 0 R\n${catalogRest}>>\nendobj\n\n`,
      "catalog"
    );
    put(
      `${acroNum} 0 obj\n<< /Fields [ ${fieldNum} 0 R${o.unsignedField ? ` ${extraNum} 0 R` : ""} ] /SigFlags 3 >>\nendobj\n\n`,
      "acro"
    );
    put(
      `${fieldNum} 0 obj\n<< /FT /Sig /T (${FIELD_NAME}) /P ${pageObj} 0 R /Rect [ 100 600 350 680 ] /V ${vNum} 0 R >>\nendobj\n\n`,
      "field"
    );
    if (o.unsignedField) {
      put(
        `${extraNum} 0 obj\n<< /FT /Sig /T (EmptySig) /P ${pageObj} 0 R /V << >> >>\nendobj\n\n`,
        "extra"
      );
    }
    const vTail = "> >>\nendobj\n\n";
    const headPrefix =
      `${vNum} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
      `/Name (${SIGN_NAME}) /Reason (${REASON}) /Location (${LOCATION}) /M (${M_TIME}) ` +
      `/ByteRange [ 0 `;
    const xrefText = (myXrefOffset: number): string =>
      `xref\n${catalogObj} 1\n${pad10(offsets.catalog ?? 0)} 00000 n \n` +
      `${acroNum} ${o.unsignedField ? 4 : 3}\n${pad10(offsets.acro ?? 0)} 00000 n \n` +
      `${pad10(offsets.field ?? 0)} 00000 n \n` +
      (o.unsignedField ? `${pad10(offsets.extra ?? 0)} 00000 n \n` : "") +
      `${pad10(offsets.v ?? 0)} 00000 n \n` +
      `trailer\n<< /Size ${maxObj + (o.unsignedField ? 5 : 4)} /Root ${catalogObj} 0 R /Prev ${pad10(prevXref)} >>\n` +
      `startxref\n${pad10(myXrefOffset)}\n%%EOF`;
    // Fixed-width probes: the head body and the xref keep their exact
    // lengths no matter the values, so every position is stable.
    const headProbe = `${headPrefix}${pad10(0)} ${pad10(0)} ${pad10(0)} ] /Contents `;
    const B = pos + headProbe.length; // the '<' lands exactly here
    const C = B + 2 + hexLen; // first byte AFTER '>'
    const xrefProbe = xrefText(0);
    // [C, C+D) starts right AFTER the '>' gap delimiter (vTail[0] is '>').
    const D = vTail.length - 1 + xrefProbe.length;
    const head =
      `${headPrefix}${pad10(B)} ${pad10(C)} ${pad10(D)} ] /Contents `;
    if (head.length !== headProbe.length) throw new Error("fixture: head probe drift");
    put(head, "v");
    // [0, B) — everything before the '<' (compute BEFORE pushing it).
    const beforeLt = baseStr + parts.join("");
    if (beforeLt.length !== B) throw new Error("fixture: beforeLt drift");
    parts.push("<");
    pos += 1;
    const myXrefOffset = B + 1 + hexLen + vTail.length;
    // covered bytes = [0, B) ++ [C, total)
    const suffix = vTail + xrefText(myXrefOffset);
    const covered = new Uint8Array(B + D);
    covered.set(latin1BytesOf(beforeLt), 0);
    covered.set(latin1BytesOf(suffix.slice(1)), B); // skip the '>' gap delimiter
    const messageDigest = createHash(o.hash).update(covered).digest();
    const cms = buildCms({
      certs: o.certs,
      sidIssuer: o.sidIssuer,
      sidSerial: o.sidSerial,
      messageDigest,
      signingTime: o.signingTime,
      signerKey: o.signerKey,
      digestOid,
      sigOid,
      nodeHash: o.hash,
    });
    const hex = cms.toString("hex");
    const finalStr = beforeLt + "<" + hex + suffix;
    return { hex, bytes: latin1BytesOf(finalStr), range: [0, B, C, D] };
  };

  let hexLen = 4096;
  for (let round = 0; round < 8; round += 1) {
    const attempt = buildOnce(hexLen);
    if (attempt.hex.length === hexLen) {
      return {
        bytes: attempt.bytes,
        fileName: `${o.label}.pdf`,
        byteRange: attempt.range,
        contentsHexStart: attempt.range[1] + 1,
        contentsHexLen: hexLen,
      };
    }
    hexLen = attempt.hex.length;
  }
  throw new Error(`fixture ${o.label} did not converge`);
}

/* ------------------------------------------------------------------ */
/* Minimal hand-built PDFs (edge vectors)                               */
/* ------------------------------------------------------------------ */

function buildMiniPdf(o: {
  acroForm?: string;
  extraObjects?: string[];
  trailerExtra?: string;
}): Uint8Array {
  const dict = (i: number, body: string): string => `${i} 0 obj\n<< ${body} >>\nendobj\n`;
  const objs: string[] = [
    dict(1, `/Type /Catalog /Pages 2 0 R${o.acroForm ?? ""}`),
    dict(2, `/Type /Pages /Kids [ 3 0 R ] /Count 1`),
    dict(3, `/Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ]`),
  ];
  let n = 4;
  for (const body of o.extraObjects ?? []) {
    objs.push(dict(n, body));
    n += 1;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const text of objs) {
    offsets.push(out.length);
    out += text;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${pad10(off)} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${o.trailerExtra ?? ""} >>\nstartxref\n${xrefAt}\n%%EOF`;
  return latin1BytesOf(out);
}

/* ================================================================== */
/** Mutable holder so later sections can use the §0 fixtures (declared
 * BEFORE the section-0 block that fills it — TDZ-safe). */
const FIXTURES: {
  green: BuiltFixture;
  selfSigned: BuiltFixture;
  expired: BuiltFixture;
  notYet: BuiltFixture;
  sha1Signed: BuiltFixture;
  noSid: BuiltFixture;
  withEmptyField: BuiltFixture;
  brokenXref: BuiltFixture;
  signerSpki: Uint8Array;
  signerKey: KeyObject;
  caCertName: Buffer;
  signerSerial: bigint;
  standaloneCms: Buffer;
  standaloneDigest: Buffer;
  signerKeysPub: Uint8Array;
} = {} as unknown as {
  green: BuiltFixture;
  selfSigned: BuiltFixture;
  expired: BuiltFixture;
  notYet: BuiltFixture;
  sha1Signed: BuiltFixture;
  noSid: BuiltFixture;
  withEmptyField: BuiltFixture;
  brokenXref: BuiltFixture;
  signerSpki: Uint8Array;
  signerKey: KeyObject;
  caCertName: Buffer;
  signerSerial: bigint;
  standaloneCms: Buffer;
  standaloneDigest: Buffer;
  signerKeysPub: Uint8Array;
};

/* ================================================================== */
console.log("── 0. fixtures (node:crypto keys, certs, signed PDFs) ───");
/* ================================================================== */
{
  const caKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const selfKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const caSpki = caKeys.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const signerSpki = signerKeys.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const selfSpki = selfKeys.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  check("keygen: three RSA-2048 keypairs", caSpki.length === 294 && signerSpki.length === 294 && selfSpki.length === 294);

  const NB = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
  const NA = new Date(Date.UTC(2028, 0, 1, 0, 0, 0));
  const caCert = buildCert({
    commonName: "DocoPDF Test CA",
    org: "DocoPDF",
    country: "IN",
    serial: BigInt(0x1001),
    notBefore: NB,
    notAfter: NA,
    spki: caSpki,
    issuerName: null,
    signKey: caKeys.privateKey,
  });
  const signerCert = buildCert({
    commonName: "Test Signer",
    org: "DocoPDF Labs",
    orgUnit: "Quality",
    country: "IN",
    email: "signer@mycloudy.test",
    serial: BigInt(0x1a2b3c4d5e6f),
    notBefore: NB,
    notAfter: NA,
    spki: signerSpki,
    issuerName: caCert.name,
    signKey: caKeys.privateKey,
  });
  const expiredCert = buildCert({
    commonName: "Test Signer",
    org: "DocoPDF Labs",
    orgUnit: "Quality",
    country: "IN",
    serial: BigInt(0x1a2b3c4d5e6f),
    notBefore: new Date(Date.UTC(2024, 0, 1)),
    notAfter: new Date(Date.UTC(2025, 5, 1)),
    spki: signerSpki,
    issuerName: caCert.name,
    signKey: caKeys.privateKey,
  });
  const notYetCert = buildCert({
    commonName: "Test Signer",
    org: "DocoPDF Labs",
    orgUnit: "Quality",
    country: "IN",
    serial: BigInt(0x1a2b3c4d5e6f),
    notBefore: new Date(Date.UTC(2027, 5, 1)),
    notAfter: new Date(Date.UTC(2029, 0, 1)),
    spki: signerSpki,
    issuerName: caCert.name,
    signKey: caKeys.privateKey,
  });
  const selfSignedCert = buildCert({
    commonName: "Self-Signed Tester",
    org: "Solo Shop",
    country: "IN",
    serial: BigInt(0xfeed),
    notBefore: NB,
    notAfter: NA,
    spki: selfSpki,
    issuerName: null,
    signKey: selfKeys.privateKey,
  });

  const caParsed = parseCertificate(caCert.der, readTlv(caCert.der, 0)!);
  const signerParsed = parseCertificate(signerCert.der, readTlv(signerCert.der, 0)!);
  check("cert: CA parses as self-signed", caParsed !== null && caParsed.selfSigned === true);
  check(
    "cert: signer parses with CA issuer, not self-signed",
    signerParsed !== null &&
      signerParsed.selfSigned === false &&
      signerParsed.issuerCn === "DocoPDF Test CA" &&
      signerParsed.subject.cn === "Test Signer" &&
      signerParsed.subject.o === "DocoPDF Labs" &&
      signerParsed.subject.ou === "Quality" &&
      signerParsed.subject.c === "IN" &&
      signerParsed.subject.email === "signer@mycloudy.test" &&
      signerParsed.serialHex === "1a2b3c4d5e6f"
  );
  check(
    "cert: validity window parsed",
    signerParsed!.notBefore.iso === "2025-01-01 00:00 UTC" &&
      signerParsed!.notAfter.iso === "2028-01-01 00:00 UTC"
  );
  check(
    "cert: SPKI is importKey-ready (WebCrypto round trip)",
    (await verifyRsaPkcs1(
      new Uint8Array(signerSpki),
      "SHA-256",
      (() => {
        const s = createSign("RSA-SHA256");
        s.update("probe");
        return s.sign(signerKeys.privateKey);
      })(),
      latin1BytesOf("probe")
    )) === true
  );

  const common = {
    sidSerial: BigInt(0x1a2b3c4d5e6f),
    hash: "sha256" as const,
    signingTime: SIGNING_TIME,
    mTime: M_TIME,
  };
  const green = await buildSignedPdf({
    ...common,
    label: "green-signed",
    certs: [signerCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
  });
  const selfSigned = await buildSignedPdf({
    ...common,
    label: "self-signed",
    sidSerial: BigInt(0xfeed),
    certs: [selfSignedCert.der],
    sidIssuer: selfSignedCert.name,
    signerKey: selfKeys.privateKey,
  });
  const expired = await buildSignedPdf({
    ...common,
    label: "expired-cert",
    certs: [expiredCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
  });
  const notYet = await buildSignedPdf({
    ...common,
    label: "notyet-cert",
    certs: [notYetCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
  });
  const sha1Signed = await buildSignedPdf({
    ...common,
    label: "sha1-signed",
    hash: "sha1",
    certs: [signerCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
  });
  const noSid = await buildSignedPdf({
    ...common,
    label: "nosid-signed",
    certs: [],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
  });
  const withEmptyField = await buildSignedPdf({
    ...common,
    label: "with-empty-field",
    certs: [signerCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
    unsignedField: true,
  });
  const brokenXref = await buildSignedPdf({
    ...common,
    label: "broken-xref",
    certs: [signerCert.der, caCert.der],
    sidIssuer: caCert.name,
    signerKey: signerKeys.privateKey,
    brokenBaseXref: true,
  });

  check(
    "fixture: green bytes are a PDF with an incremental update",
    sniffPdfBytes(green.bytes) &&
      toLatin(green.bytes).includes("%DocoPDF") === false &&
      toLatin(green.bytes).includes("adbe.pkcs7.detached")
  );
  check(
    "fixture: ByteRange excludes exactly the /Contents hex gap",
    (() => {
      const s = toLatin(green.bytes);
      return (
        s.charCodeAt(green.byteRange[1]) === 0x3c /* < */ &&
        s.charCodeAt(green.byteRange[2] - 1) === 0x3e /* > */ &&
        green.byteRange[2] - green.byteRange[1] - 2 === green.contentsHexLen
      );
    })()
  );
  check(
    "fixture: green digest is independently correct (node:crypto oracle)",
    bytesToHex(createHash("sha256").update(coveredBytes(green.bytes, green.byteRange)!).digest()) ===
      bytesToHex(parseCms(decodeHexStrict(toLatin(green.bytes).slice(green.contentsHexStart, green.contentsHexStart + green.contentsHexLen)).bytes!).signers[0]!.signedAttrs!.messageDigest!)
  );

  /* stash for later sections (module-scope via a mutable holder) */
  FIXTURES.green = green;
  FIXTURES.selfSigned = selfSigned;
  FIXTURES.expired = expired;
  FIXTURES.notYet = notYet;
  FIXTURES.sha1Signed = sha1Signed;
  FIXTURES.noSid = noSid;
  FIXTURES.withEmptyField = withEmptyField;
  FIXTURES.brokenXref = brokenXref;
  FIXTURES.signerSpki = new Uint8Array(signerSpki);
  FIXTURES.signerKey = signerKeys.privateKey;
  FIXTURES.caCertName = caCert.name;
  FIXTURES.signerSerial = common.sidSerial;

  // A standalone CMS (no PDF) for parseCms unit checks.
  const standaloneDigest = createHash("sha256").update(latin1BytesOf("standalone content")).digest();
  FIXTURES.standaloneCms = buildCms({
    certs: [signerCert.der, caCert.der],
    sidIssuer: caCert.name,
    sidSerial: common.sidSerial,
    messageDigest: standaloneDigest,
    signingTime: SIGNING_TIME,
    signerKey: signerKeys.privateKey,
    digestOid: OID_SHA256,
    sigOid: OID_SHA256_RSA,
    nodeHash: "sha256",
  });
  FIXTURES.standaloneDigest = standaloneDigest;
  FIXTURES.signerKeysPub = new Uint8Array(signerSpki);
  check("fixture: standalone CMS built", FIXTURES.standaloneCms.length > 1000);
}

/* ================================================================== */
console.log("── 1. DER reader + byte helpers (units) ─────────────────");
/* ================================================================== */
{
  // ---- readTlv: the four length forms --------------------------------
  const seqShort = tlv(0x30, Buffer.from([0x01, 0x02]));
  const t1 = readTlv(seqShort, 0);
  check(
    "readTlv: SEQUENCE short form",
    t1 !== null && t1.cls === 0 && t1.constructed && t1.tag === 0x10 && t1.len === 2 &&
      t1.valueStart === 2 && t1.end === 4
  );
  const longBody = Buffer.alloc(200, 0xab);
  const t2 = readTlv(tlv(0x04, longBody), 0);
  check("readTlv: 0x81 long form (200 bytes)", t2 !== null && t2.len === 200 && t2.end === 203);
  const t3 = readTlv(tlv(0x04, Buffer.alloc(300, 0xcd)), 0);
  check("readTlv: 0x82 long form (300 bytes)", t3 !== null && t3.len === 300);
  const t4 = readTlv(tlv(0x04, Buffer.alloc(70000, 0xee)), 0);
  check("readTlv: 0x83 long form (70000 bytes)", t4 !== null && t4.len === 70000);
  const t5 = readTlv(tlv(0x04, Buffer.alloc(0x11223, 0x11)), 0);
  check("readTlv: 0x84 long form", t5 !== null && t5.len === 0x11223);

  // ---- readTlv: rejections -------------------------------------------
  check("readTlv: truncated content → null", readTlv(Buffer.from([0x30, 0x05, 0x01]), 0) === null);
  check("readTlv: indefinite length (0x80) → null", readTlv(Buffer.from([0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00]), 0) === null);
  check("readTlv: >4 length bytes → null", readTlv(Buffer.from([0x30, 0x85, 0, 0, 0, 0, 1, 1]), 0) === null);
  check("readTlv: out-of-bounds offsets → null", readTlv(seqShort, -1) === null && readTlv(seqShort, 4) === null && readTlv(new Uint8Array(0), 0) === null);
  const setTlv = tlv(0x31, Buffer.from([0x01]));
  const ts = readTlv(setTlv, 0);
  check("readTlv: SET is constructed, tag number 0x11", ts !== null && ts.constructed && ts.tag === 0x11);
  const intTlv = tlv(0x02, Buffer.from([0x2a]));
  const ti = readTlv(intTlv, 0);
  check("readTlv: INTEGER is primitive, tag 0x02", ti !== null && !ti.constructed && ti.tag === 0x02);
  const oidTlv = derOid(OID_SHA256);
  const to = readTlv(oidTlv, 0);
  check("readTlv: OID tag 0x06", to !== null && to.tag === 0x06 && !to.constructed);
  const ctxTlv = tlv(0xa0, derSeq());
  const tc = readTlv(ctxTlv, 0);
  check("readTlv: context [0] constructed, cls 2", tc !== null && tc.cls === 2 && tc.tag === 0 && tc.constructed);
  const highTag = readTlv(Buffer.from([0x5f, 0x88, 0x02, 0x01, 0xab]), 0);
  check("readTlv: high-tag-number form decodes tag 1026", highTag !== null && highTag.cls === 1 && highTag.tag === 1026 && highTag.len === 1);
  check("readTlv: unterminated high-tag → null", readTlv(Buffer.from([0x5f, 0x88]), 0) === null);

  // ---- tlvChildren -----------------------------------------------------
  const parent = derSeq(tlv(0x02, Buffer.from([0x01])), derSeq(), tlv(0x06, Buffer.from([0x2a])));
  const kids = tlvChildren(parent, readTlv(parent, 0)!);
  check("tlvChildren: three children walked", kids.length === 3 && kids[0]!.tag === 0x02 && kids[1]!.tag === 0x10 && kids[2]!.tag === 0x06);
  check("tlvChildren: junk child stops the walk", tlvChildren(Buffer.from([0x30, 0x03, 0x30, 0x00, 0xff]), readTlv(Buffer.from([0x30, 0x03, 0x30, 0x00, 0xff]), 0)!).length === 1);

  // ---- readOid ---------------------------------------------------------
  check("readOid: 1.2.840.113549.1.7.2 (arc 1)", readOid(derOid(OID_SIGNED_DATA), readTlv(derOid(OID_SIGNED_DATA), 0)!) === "1.2.840.113549.1.7.2");
  check("readOid: 2.5.4.3 (arc 2)", readOid(derOid(OID_CN), readTlv(derOid(OID_CN), 0)!) === "2.5.4.3");
  check("readOid: 2.16.840.1.101.3.4.2.1 (multi-byte arcs)", readOid(derOid(OID_SHA256), readTlv(derOid(OID_SHA256), 0)!) === "2.16.840.1.101.3.4.2.1");
  check("readOid: empty content → null", readOid(Buffer.from([0x06, 0x00]), readTlv(Buffer.from([0x06, 0x00]), 0)!) === null);
  check("readOid: truncated base-128 → null", readOid(Buffer.from([0x06, 0x02, 0x2a, 0x86]), readTlv(Buffer.from([0x06, 0x02, 0x2a, 0x86]), 0)!) === null);
  check("readOid: non-OID TLV → null", readOid(intTlv, ti!) === null);

  // ---- intBytes / tlvBytes ----------------------------------------------
  check("intBytes: INTEGER content", Buffer.from(intBytes(intTlv, ti!)!).toString("hex") === "2a");
  check("intBytes: non-INTEGER → null", intBytes(setTlv, ts!) === null);
  const standalone = tlvBytes(parent, readTlv(parent, 0)!);
  const parentMut = Buffer.from(parent);
  parentMut[4] = 0xff;
  check("tlvBytes: standalone copy (mutation-safe)", standalone.length === parent.length && standalone[4] === parent[4] === false ? standalone[4] !== parentMut[4] : standalone[4] !== parentMut[4]);

  // ---- ASN.1 times -------------------------------------------------------
  const utGood = readAsn1Time(Buffer.concat([Buffer.from([0x17, 0x0d]), Buffer.from("260115040000Z")]), { cls: 0, constructed: false, tag: 23, start: 0, valueStart: 2, len: 13, end: 15 });
  check("readAsn1Time: UTCTime Z", utGood.iso === "2026-01-15 04:00 UTC" && utGood.ms === Date.UTC(2026, 0, 15, 4, 0, 0));
  const utZone = readAsn1Time(Buffer.concat([Buffer.from([0x17, 0x11]), Buffer.from("260115090000+0500")]), { cls: 0, constructed: false, tag: 23, start: 0, valueStart: 2, len: 17, end: 19 });
  check("readAsn1Time: UTCTime zone normalized to UTC", utZone.iso === "2026-01-15 04:00 UTC");
  const utYY = readAsn1Time(Buffer.concat([Buffer.from([0x17, 0x0d]), Buffer.from("990101000000Z")]), { cls: 0, constructed: false, tag: 23, start: 0, valueStart: 2, len: 13, end: 15 });
  check("readAsn1Time: YY < 50 means 20xx", utYY.iso === "1999-01-01 00:00 UTC");
  const gtGood = readAsn1Time(Buffer.concat([Buffer.from([0x18, 0x0f]), Buffer.from("20260115040000Z")]), { cls: 0, constructed: false, tag: 24, start: 0, valueStart: 2, len: 15, end: 17 });
  check("readAsn1Time: GeneralizedTime", gtGood.iso === "2026-01-15 04:00 UTC");
  const gtJunk = readAsn1Time(Buffer.concat([Buffer.from([0x18, 0x0f]), Buffer.from("2026011504000Z")]), { cls: 0, constructed: false, tag: 24, start: 0, valueStart: 2, len: 14, end: 16 });
  check("readAsn1Time: odd digit count → FAIL_TIME", gtJunk.iso === null && gtJunk.ms === null);
  check("formatUtc: padded", formatUtc(Date.UTC(2026, 0, 15, 4, 5, 0)) === "2026-01-15 04:05 UTC");

  // ---- hex / latin1 / sniff -----------------------------------------------
  check("decodeHexStrict: valid", Buffer.from(decodeHexStrict("5A3b").bytes!).toString("hex") === "5a3b");
  check("decodeHexStrict: PDF whitespace tolerated", Buffer.from(decodeHexStrict("5A 3b\t\r\n\f").bytes!).toString("hex") === "5a3b");
  check("decodeHexStrict: non-hex char → error", decodeHexStrict("5z").bytes === null && decodeHexStrict("5z").error !== null);
  check("decodeHexStrict: odd digit count → error", decodeHexStrict("5A3").bytes === null && (decodeHexStrict("5A3").error ?? "").includes("odd"));
  check("decodeHexStrict: empty → empty bytes, no error", decodeHexStrict("").bytes?.length === 0 && decodeHexStrict("").error === null);
  check("bytesToHex: lowercase padded", bytesToHex(new Uint8Array([0x0a, 0xbc])) === "0abc");
  check("toLatin: 0x80–0xFF round trip (byte-faithful)", (() => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0xfe]);
    const s = toLatin(bytes);
    return s.length === 5 && s.charCodeAt(3) === 0xff && latin1BytesOf(s)[2] === 0x80;
  })());
  check("sniffPdfBytes: header at 0", sniffPdfBytes(latin1BytesOf("%PDF-1.7\nrest")));
  check("sniffPdfBytes: garbage prefix still smells within 2 KB", sniffPdfBytes(concatBytes(latin1BytesOf("junk-prefix-".repeat(50)), latin1BytesOf("%PDF-1.4\n"))));
  check("sniffPdfBytes: no magic → false", !sniffPdfBytes(latin1BytesOf("hello world, no pdf here")));

  // ---- OID tables ---------------------------------------------------------
  check("digestInfoFor: SHA-256", digestInfoFor(OID_SHA256)?.name === "SHA-256" && digestInfoFor(OID_SHA256)?.hash === "SHA-256");
  check("digestInfoFor: unknown OID → null", digestInfoFor("1.2.3.4.5") === null && digestInfoFor(null) === null);
  check("sigAlgoInfoFor: sha256WithRSAEncryption", sigAlgoInfoFor(OID_SHA256_RSA)?.name === "RSA-PKCS1v1_5" && sigAlgoInfoFor(OID_SHA256_RSA)?.hash === "SHA-256");
  check("sigAlgoInfoFor: sha1WithRSAEncryption carries SHA-1", sigAlgoInfoFor(OID_SHA1_RSA)?.hash === "SHA-1");

  // ---- verifyRsaPkcs1 -------------------------------------------------------
  const probeData = latin1BytesOf("The quick brown fox jumps");
  const goodSig = createSign("RSA-SHA256");
  goodSig.update(probeData);
  const goodSigBuf = goodSig.sign(FIXTURES.signerKey);
  check("verifyRsaPkcs1: true for a real signature", (await verifyRsaPkcs1(FIXTURES.signerKeysPub, "SHA-256", goodSigBuf, probeData)) === true);
  const badSigBuf = Buffer.from(goodSigBuf);
  badSigBuf[100] = badSigBuf[100]! ^ 0xff;
  check("verifyRsaPkcs1: false for a corrupted signature", (await verifyRsaPkcs1(FIXTURES.signerKeysPub, "SHA-256", badSigBuf, probeData)) === false);
  check("verifyRsaPkcs1: garbage SPKI → null (not a boolean)", (await verifyRsaPkcs1(new Uint8Array([1, 2, 3, 4]), "SHA-256", goodSigBuf, probeData)) === null);
}

/* ================================================================== */
console.log("── 2. PDF value parser + dates + ByteRange (units) ──────");
/* ================================================================== */
{
  const d = parsePdfValue("<< /A 1 /B (x) /C /Name >>", 0);
  check("parsePdfValue: dict with 3 keys", d !== null && d.v.k === "dict" && d.v.map.size === 3);
  const a = parsePdfValue("[ 1 2.5 (s) <41> /N 3 0 R true null ]", 0);
  check(
    "parsePdfValue: array of every primitive",
    a !== null && a.v.k === "arr" && a.v.items.length === 8 &&
      a.v.items[0]!.k === "num" && a.v.items[1]!.k === "num" &&
      a.v.items[2]!.k === "str" && a.v.items[3]!.k === "str" &&
      a.v.items[4]!.k === "name" && a.v.items[5]!.k === "ref" &&
      a.v.items[6]!.k === "bool" && a.v.items[7]!.k === "null"
  );
  const ref = parsePdfValue("12 0 R", 0);
  check("parsePdfValue: reference parsed", ref !== null && ref.v.k === "ref" && ref.v.num === 12 && ref.v.gen === 0);
  const notRef = parsePdfValue("12 0 Rx", 0);
  check("parsePdfValue: 'R' followed by a letter is a plain number", notRef !== null && notRef.v.k === "num" && notRef.v.num === 12);
  const lit = parsePdfValue("(a\\(b\\)c\\104\\ne)", 0);
  check("parsePdfValue: literal escapes (parens, octal, n)", lit !== null && lit.v.k === "str" && lit.v.text === "a(b)cD\ne");
  const hex = parsePdfValue("<41 42>", 0);
  check("parsePdfValue: hex string keeps raw span + hex flag", hex !== null && hex.v.k === "str" && hex.v.hex && hex.v.text === "41 42" && hex.v.pos === 1 && hex.v.end === 6);
  const nm = parsePdfValue("/A#42c", 0);
  check("parsePdfValue: name #xx escape", nm !== null && nm.v.k === "name" && nm.v.name === "ABc");
  check("parsePdfValue: junk → null", parsePdfValue(">>", 0) === null && parsePdfValue("", 0) === null);
  const deep = parsePdfValue("[ [ [ [ (deep) ] ] ] ]", 0);
  check("parsePdfValue: nested containers (depth)", deep !== null && deep.v.k === "arr");

  // ---- decodePdfDate ----------------------------------------------------
  check(
    "decodePdfDate: zone +05'30 normalized",
    decodePdfDate("D:20260115093000+05'30'").iso === "2026-01-15 04:00 UTC"
  );
  check("decodePdfDate: Z zone", decodePdfDate("D:20260115040000Z").iso === "2026-01-15 04:00 UTC");
  check("decodePdfDate: year-only defaults", decodePdfDate("D:2026").iso === "2026-01-01 00:00 UTC");
  check("decodePdfDate: junk → null", decodePdfDate("not a date").iso === null && decodePdfDate("not a date").ms === null);
  check("decodePdfDate: month 13 → null", decodePdfDate("D:20261301").iso === null);

  // ---- readByteRange (via parsePdfValue dicts) -----------------------------
  const dictOf = (text: string): Parameters<typeof readByteRange>[0] =>
    parsePdfValue(text, 0)!.v as Parameters<typeof readByteRange>[0];
  const arrResolve: Parameters<typeof readByteRange>[1] = (v) =>
    v !== undefined && v.k === "arr" ? v : undefined;
  const okBr = readByteRange(dictOf("<< /ByteRange [0 10 20 30] >>"), arrResolve);
  check("readByteRange: healthy range", okBr.range !== null && JSON.stringify(okBr.range) === "[0,10,20,30]" && okBr.malformedReason === null);
  const missingBr = readByteRange(dictOf("<< /Type /Sig >>"), arrResolve);
  check("readByteRange: missing → honest reason", missingBr.range === null && missingBr.malformedReason === "/ByteRange missing");
  const shortBr = readByteRange(dictOf("<< /ByteRange [0 10 20] >>"), arrResolve);
  check("readByteRange: 3 entries → honest reason", shortBr.range === null && (shortBr.malformedReason ?? "").includes("expected 4"));
  const badBr = readByteRange(dictOf("<< /ByteRange [0 10.5 20 30] >>"), arrResolve);
  check("readByteRange: non-integer entry → honest reason", badBr.range === null && (badBr.malformedReason ?? "").includes("non-integer"));
  const negBr = readByteRange(dictOf("<< /ByteRange [0 10 20 -3] >>"), arrResolve);
  check("readByteRange: negative entry → honest reason", negBr.range === null && (negBr.malformedReason ?? "").includes("negative"));

  // ---- coveredBytes ---------------------------------------------------------
  const probe = latin1BytesOf("0123456789ABCDEFGH");
  const cov = coveredBytes(probe, [0, 4, 8, 10]);
  check("coveredBytes: two ranges concatenated", cov !== null && toLatin(cov) === "0123" + "89ABCDEFGH");
  check("coveredBytes: out of bounds → null", coveredBytes(probe, [0, 4, 8, 100]) === null);
  check("coveredBytes: overlapping gap → null", coveredBytes(probe, [0, 10, 5, 3]) === null);
}

/* ================================================================== */
console.log("── 3. parseCms (real CMS + broken variants) ─────────────");
/* ================================================================== */
{
  const cms = parseCms(new Uint8Array(FIXTURES.standaloneCms));
  check("parseCms: no parse error", cms.parseError === null);
  check("parseCms: both certificates", cms.certs.length === 2 && cms.certs[0]!.subject.cn === "Test Signer" && cms.certs[1]!.subject.cn === "DocoPDF Test CA");
  check("parseCms: digestAlgorithms SET", cms.digestAlgoOids.length === 1 && cms.digestAlgoOids[0] === OID_SHA256);
  check("parseCms: detached (no eContent)", cms.eContentPresent === false);
  const signer = cms.signers[0]!;
  check("parseCms: sidKind issuerAndSerial", signer.sidKind === "issuerAndSerial");
  check(
    "parseCms: sid issuer DER + serial",
    Buffer.from(signer.sidIssuerDer!).equals(FIXTURES.caCertName) &&
      Buffer.from(signer.sidSerialBytes!).toString("hex") === "1a2b3c4d5e6f"
  );
  check("parseCms: digest + signature OIDs", signer.digestOid === OID_SHA256 && signer.signatureOid === OID_SHA256_RSA);
  check("parseCms: signature is 256 bytes", signer.signature !== null && signer.signature.length === 256);
  const attrs = signer.signedAttrs!;
  check(
    "parseCms: signedAttrs (contentType, messageDigest, signingTime, count 3)",
    attrs.contentTypeOid === OID_DATA &&
      Buffer.from(attrs.messageDigest!).equals(FIXTURES.standaloneDigest) &&
      attrs.signingTime.iso === "2026-01-15 04:00 UTC" &&
      attrs.attrCount === 3
  );
  check(
    "parseCms: rawDer is [0]-tagged, retaggedDer is SET",
    attrs.rawDer[0] === 0xa0 && attrs.retaggedDer[0] === 0x31 && attrs.retaggedDer.length === attrs.rawDer.length
  );

  // ski sid variant
  const skiCms = buildCms({
    certs: [],
    sidIssuer: FIXTURES.caCertName,
    sidSerial: FIXTURES.signerSerial,
    messageDigest: FIXTURES.standaloneDigest,
    signingTime: SIGNING_TIME,
    signerKey: FIXTURES.signerKey,
    digestOid: OID_SHA256,
    sigOid: OID_SHA256_RSA,
    nodeHash: "sha256",
    sidSki: true,
  });
  const skiParsed = parseCms(skiCms);
  check("parseCms: subjectKeyIdentifier sid", skiParsed.signers[0]!.sidKind === "ski" && skiParsed.signers[0]!.sidSkiHex === "01020304");

  // attached variant
  const attachedCms = buildCms({
    certs: [],
    sidIssuer: FIXTURES.caCertName,
    sidSerial: FIXTURES.signerSerial,
    messageDigest: FIXTURES.standaloneDigest,
    signingTime: SIGNING_TIME,
    signerKey: FIXTURES.signerKey,
    digestOid: OID_SHA256,
    sigOid: OID_SHA256_RSA,
    nodeHash: "sha256",
    eContent: Buffer.from("attached", "latin1"),
  });
  check("parseCms: eContent [0] detected (attached CMS)", parseCms(attachedCms).eContentPresent === true);

  // broken variants
  check("parseCms: root not a SEQUENCE → honest error", parseCms(Buffer.from([0x05, 0x00])).parseError === "root is not a SEQUENCE (class 0 tag 5)");
  const wrongType = derSeq(derOid(OID_DATA), tlv(0xa0, derSeq(derInt(BigInt(1)))));
  check("parseCms: wrong contentType → honest error", (parseCms(wrongType).parseError ?? "").includes("expected signedData"));
  check("parseCms: empty input → honest error", parseCms(new Uint8Array(0)).parseError !== null);
}

/* ================================================================== */
console.log("── 4. green path E2E (CA-signed fixture) ─────────────────");
/* ================================================================== */
{
  const report = await analyzeSignatures(FIXTURES.green.bytes, NOW);
  check("green: pageCount 1", report.pageCount === 1, report.pageCount);
  check("green: exactly one signature", report.signatures.length === 1);
  check("green: no unsigned fields", report.unsignedFields.length === 0);
  check("green: no recovery (xref chain healthy)", report.recoveryUsed === false && report.recoveryReason === null);
  const card = report.signatures[0]!;
  check("green: status valid, tone green, no notes", card.status === "valid" && card.tone === "green" && card.noteKeys.length === 0);
  check("green: index + field name", card.index === 1 && card.fieldName === "Signature1");
  check("green: widget page 1 (via /P)", card.page === 1);
  check("green: widget rect", JSON.stringify(card.rect) === JSON.stringify([100, 600, 350, 680]));
  check("green: filter + subFilter", card.filter === "Adobe.PPKLite" && card.subFilter === "adbe.pkcs7.detached");
  check("green: /Name, /Reason, /Location", card.signerName === SIGN_NAME && card.reason === REASON && card.location === LOCATION);
  check("green: /M time parsed and equal to signing time", card.pdfMTimeIso === "2026-01-15 04:00 UTC");
  check("green: byteRange matches the fixture layout", JSON.stringify(card.byteRange) === JSON.stringify(FIXTURES.green.byteRange));
  check("green: cmsSize is the DER size", card.cmsSize === FIXTURES.green.contentsHexLen / 2);
  check("green: coverage complete (no trailing bytes)", card.trailingBytes === 0 && card.modifiedAfterSigning === false);
  const p = card.signers[0]!;
  check("green: digest algorithm reported", p.digestAlgo === "SHA-256" && p.digestHashName === "SHA-256");
  check("green: signature algorithm reported", p.signatureAlgo === "RSA-PKCS1v1_5");
  check("green: crypto PASS, no note", p.cryptoVerified === true && p.cryptoNoteKey === null);
  check("green: integrity intact", p.integrity === "intact");
  check(
    "green: messageDigest == computedDigest (32 hex bytes)",
    p.messageDigestHex !== null && p.messageDigestHex === p.computedDigestHex && p.messageDigestHex.length === 64
  );
  check("green: signingTime from signedAttrs", p.signingTimeIso === "2026-01-15 04:00 UTC");
  check("green: contentType attribute", p.contentTypeOid === OID_DATA);
  check("green: sid matched the signer certificate", p.sidMatched === true);
  const cert = p.cert!;
  check(
    "green: certificate subject (CN/O/OU/C/email)",
    cert.commonName === "Test Signer" && cert.organization === "DocoPDF Labs" &&
      cert.organizationalUnit === "Quality" && cert.country === "IN" &&
      cert.email === "signer@mycloudy.test"
  );
  check("green: certificate serial hex", cert.serialHex === "0x1a2b3c4d5e6f");
  check("green: issuer CN", cert.issuerCommonName === "DocoPDF Test CA");
  check(
    "green: validity window valid at the injected now",
    cert.notBeforeIso === "2025-01-01 00:00 UTC" && cert.notAfterIso === "2028-01-01 00:00 UTC" && cert.validityNow === "valid"
  );
  check("green: not self-signed", cert.selfSigned === false);

  const walk = walkPdf(toLatin(FIXTURES.green.bytes), FIXTURES.green.bytes);
  check("green: walkPdf — xref ok, root resolved", walk.xref.ok === true && walk.rootRef !== null && walk.catalog !== null && walk.recoveryUsed === false);
  check(
    "green: independent digest oracle matches the model's messageDigest",
    bytesToHex(createHash("sha256").update(coveredBytes(FIXTURES.green.bytes, FIXTURES.green.byteRange)!).digest()) === p.messageDigestHex
  );
}

/* ================================================================== */
console.log("── 5. certificate variants ────────────────────────────────");
/* ================================================================== */
{
  const ss = await analyzeSignatures(FIXTURES.selfSigned.bytes, NOW);
  const ssc = ss.signatures[0]!;
  check("self-signed: amber attention (not green)", ssc.status === "attention" && ssc.tone === "amber");
  check("self-signed: nSelfSigned note", ssc.noteKeys.includes("vps.nSelfSigned"));
  check("self-signed: cert flagged, issuer == subject CN", ssc.signers[0]!.cert!.selfSigned === true && ssc.signers[0]!.cert!.issuerCommonName === "Self-Signed Tester");
  check("self-signed: crypto PASS + integrity intact", ssc.signers[0]!.cryptoVerified === true && ssc.signers[0]!.integrity === "intact");

  const ex = await analyzeSignatures(FIXTURES.expired.bytes, NOW);
  const exc = ex.signatures[0]!;
  check("expired: amber with nExpired note", exc.status === "attention" && exc.noteKeys.includes("vps.nExpired"));
  check("expired: validityNow expired", exc.signers[0]!.cert!.validityNow === "expired");
  check("expired: signing time outside the window", exc.noteKeys.includes("vps.nSignTimeOutside"));

  const ny = await analyzeSignatures(FIXTURES.notYet.bytes, NOW);
  const nyc = ny.signatures[0]!;
  check("not-yet: amber with nNotYetValid note", nyc.status === "attention" && nyc.noteKeys.includes("vps.nNotYetValid"));
  check("not-yet: validityNow not-yet-valid", nyc.signers[0]!.cert!.validityNow === "not-yet-valid");

  const s1 = await analyzeSignatures(FIXTURES.sha1Signed.bytes, NOW);
  const s1c = s1.signatures[0]!;
  check("sha1: digest reported SHA-1", s1c.signers[0]!.digestAlgo === "SHA-1");
  check("sha1: nWeakDigest amber", s1c.status === "attention" && s1c.noteKeys.includes("vps.nWeakDigest"));
  check("sha1: SHA-1 digest path intact + crypto PASS", s1c.signers[0]!.integrity === "intact" && s1c.signers[0]!.cryptoVerified === true);

  const ns = await analyzeSignatures(FIXTURES.noSid.bytes, NOW);
  const nsc = ns.signatures[0]!;
  const nsp = nsc.signers[0]!;
  check("no-sid-cert: crypto NOT VERIFIED with the honest note key", nsp.cryptoVerified === null && nsp.cryptoNoteKey === "vps.nNoSidCert");
  check("no-sid-cert: integrity still intact (digest independent of certs)", nsp.integrity === "intact" && nsp.computedDigestHex === nsp.messageDigestHex);
  check("no-sid-cert: honest amber (never green — model fix pinned)", nsc.status === "attention" && nsc.tone === "amber");

  const wf = await analyzeSignatures(FIXTURES.withEmptyField.bytes, NOW);
  check(
    "empty-/V field: reported unsigned, signed one still valid",
    wf.signatures.length === 1 && wf.unsignedFields.length === 1 &&
      wf.unsignedFields[0]!.fieldName === "EmptySig" && wf.unsignedFields[0]!.page === 1 &&
      wf.signatures[0]!.status === "valid"
  );
}

/* ================================================================== */
console.log("── 6. tamper vectors ─────────────────────────────────────");
/* ================================================================== */
{
  // (a) a byte flipped INSIDE the covered range → digest mismatch
  const tampered = new Uint8Array(FIXTURES.green.bytes);
  const seedAt = toLatin(tampered).indexOf("xyzzy");
  tampered[seedAt] = 0x58; // 'X' — inside the signed comment, structure-safe
  const tr = await analyzeSignatures(tampered, NOW);
  const tc = tr.signatures[0]!;
  check("tamper: integrity TAMPERED", tc.signers[0]!.integrity === "tampered");
  check("tamper: red invalid verdict", tc.status === "invalid" && tc.tone === "red");
  check("tamper: digests differ", tc.signers[0]!.messageDigestHex !== tc.signers[0]!.computedDigestHex);
  check("tamper: crypto still PASS (signedAttrs untouched)", tc.signers[0]!.cryptoVerified === true);

  // (b) bytes appended after the covered ranges
  const appendedText = "\n% evil post-signing append - not covered by the signature\n%%EOF\n";
  const ar = await analyzeSignatures(concatBytes(FIXTURES.green.bytes, latin1BytesOf(appendedText)), NOW);
  const ac = ar.signatures[0]!;
  check("append: modified after signing flagged", ac.modifiedAfterSigning === true);
  check("append: trailing byte count exact", ac.trailingBytes === appendedText.length);
  check("append: nModified note + amber (signed content still intact)", ac.noteKeys.includes("vps.nModified") && ac.status === "attention" && ac.signers[0]!.integrity === "intact");

  // (c) ≤ 16 whitespace bytes are tolerated
  const wsText = "\n \n\t\n";
  const wr = await analyzeSignatures(concatBytes(FIXTURES.green.bytes, latin1BytesOf(wsText)), NOW);
  const wc = wr.signatures[0]!;
  check("ws-tail: tolerated (all-whitespace ≤ 16)", wc.modifiedAfterSigning === false && wc.trailingBytes === wsText.length);
  check("ws-tail: still a green valid verdict", wc.status === "valid");

  // (d) the CMS signature bytes corrupted → crypto FAIL (integrity intact)
  const cs = new Uint8Array(FIXTURES.green.bytes);
  const hexPos = FIXTURES.green.contentsHexStart + FIXTURES.green.contentsHexLen - 101;
  cs[hexPos] = String.fromCharCode(cs[hexPos]!) === "f" ? 0x30 : 0x66;
  const cr = await analyzeSignatures(cs, NOW);
  const cc = cr.signatures[0]!;
  check("corrupt-sig: crypto FAIL", cc.signers[0]!.cryptoVerified === false);
  check("corrupt-sig: red invalid verdict", cc.status === "invalid" && cc.tone === "red");
  check("corrupt-sig: document integrity still intact", cc.signers[0]!.integrity === "intact");

  // (e) malformed /Contents hex
  const mh = new Uint8Array(FIXTURES.green.bytes);
  mh[FIXTURES.green.contentsHexStart + 5] = 0x7a; // 'z'
  const mr = await analyzeSignatures(mh, NOW);
  const mc = mr.signatures[0]!;
  check("bad-hex: honest nContentsBad red card", mc.status === "invalid" && mc.noteKeys.includes("vps.nContentsBad"));
  check("bad-hex: technical reason mentions the non-hex character", mc.noteTech.some((t) => t.includes("non-hex character")));

  // (f) corrupted /ByteRange entry → out of bounds
  const rb = new Uint8Array(FIXTURES.green.bytes);
  const brAt = toLatin(rb).indexOf("/ByteRange [ 0 ");
  rb[brAt + 15 + 11] = 0x39; // FIRST digit of the C entry: '0' → '9' (far past EOF)
  const rbr = await analyzeSignatures(rb, NOW);
  check("range-bounds: honest nRangeBounds red card", rbr.signatures[0]!.status === "invalid" && rbr.signatures[0]!.noteKeys.includes("vps.nRangeBounds"));
}

/* ================================================================== */
console.log("── 7. edge vectors ────────────────────────────────────────");
/* ================================================================== */
{
  // plain unsigned pdf-lib document → EMPTY report, not an error
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([595.28, 841.89]);
  const plainBytes = new Uint8Array(await plainDoc.save({ useObjectStreams: false }));
  const pr = await analyzeSignatures(plainBytes, NOW);
  check("plain: no signatures, no unsigned fields (empty state, not an error)", pr.signatures.length === 0 && pr.unsignedFields.length === 0);
  check("plain: pageCount still reported", pr.pageCount === 1);
  check("plain: no recovery", pr.recoveryUsed === false);

  const noAcro = buildMiniPdf({});
  const nar = await analyzeSignatures(noAcro, NOW);
  check("no-acroform: empty scan", nar.signatures.length === 0 && nar.unsignedFields.length === 0);

  const txField = buildMiniPdf({
    acroForm: " /AcroForm 4 0 R",
    extraObjects: ["/Fields [ 5 0 R ]", "/FT /Tx /T (TextBox1) /V (hello)"],
  });
  const txr = await analyzeSignatures(txField, NOW);
  check("tx-field: not a signature field — empty scan", txr.signatures.length === 0 && txr.unsignedFields.length === 0);

  const emptyV = buildMiniPdf({
    acroForm: " /AcroForm 4 0 R",
    extraObjects: ["/Fields [ 5 0 R ]", "/FT /Sig /T (EmptySig) /P 3 0 R /V << >>"],
  });
  const evr = await analyzeSignatures(emptyV, NOW);
  check(
    "empty-/V: reported unsigned (not a failure)",
    evr.signatures.length === 0 && evr.unsignedFields.length === 1 &&
      evr.unsignedFields[0]!.fieldName === "EmptySig" && evr.unsignedFields[0]!.page === 1
  );

  const nullV = buildMiniPdf({
    acroForm: " /AcroForm 4 0 R",
    extraObjects: ["/Fields [ 5 0 R ]", "/FT /Sig /T (NullSig) /P 3 0 R /V null"],
  });
  const nvr = await analyzeSignatures(nullV, NOW);
  check("null-/V: reported unsigned", nvr.signatures.length === 0 && nvr.unsignedFields.length === 1 && nvr.unsignedFields[0]!.fieldName === "NullSig");

  const brOnly = buildMiniPdf({
    acroForm: " /AcroForm 4 0 R",
    extraObjects: ["/Fields [ 5 0 R ]", "/FT /Sig /T (BrSig) /P 3 0 R /V << /ByteRange [ 0 5 10 5 ] >>"],
  });
  const brr = await analyzeSignatures(brOnly, NOW);
  const brc = brr.signatures[0]!;
  check("byterange-only: signed path taken (has /ByteRange)", brr.signatures.length === 1);
  check("byterange-only: honest nContentsBad (no /Contents)", brc.status === "invalid" && brc.noteKeys.includes("vps.nContentsBad"));

  const brokenXrefReport = await analyzeSignatures(FIXTURES.brokenXref.bytes, NOW);
  check(
    "broken-xref: linear-scan recovery used with a reason",
    brokenXrefReport.recoveryUsed === true && typeof brokenXrefReport.recoveryReason === "string" && brokenXrefReport.recoveryReason!.length > 0
  );
  const bxc = brokenXrefReport.signatures[0]!;
  check(
    "broken-xref: signature still found + verified intact",
    brokenXrefReport.signatures.length === 1 && bxc.status === "valid" &&
      bxc.signers[0]!.integrity === "intact" && bxc.signers[0]!.cryptoVerified === true
  );

  const encrypted = buildMiniPdf({ trailerExtra: " /Encrypt << /Filter /Standard /V 2 >>" });
  let encCode = "";
  try {
    await analyzeSignatures(encrypted, NOW);
  } catch (error) {
    encCode = error instanceof VerifyError ? error.code : `unexpected:${String(error)}`;
  }
  check("encrypted: honest errEncrypted (verify ≠ crack)", encCode === "errEncrypted");

  let notPdfCode = "";
  try {
    await analyzeSignatures(latin1BytesOf("this is not a pdf at all"), NOW);
  } catch (error) {
    notPdfCode = error instanceof VerifyError ? error.code : `unexpected:${String(error)}`;
  }
  check("not-pdf: honest errNotPdf", notPdfCode === "errNotPdf");

  let tooBigCode = "";
  try {
    await analyzeSignatures(new Uint8Array(MAX_INPUT_BYTES + 1), NOW);
  } catch (error) {
    tooBigCode = error instanceof VerifyError ? error.code : `unexpected:${String(error)}`;
  }
  check("too-big: honest errTooBig at the 64 MB gate", tooBigCode === "errTooBig" && MAX_INPUT_BYTES === 64 * 1024 * 1024);
}

/* ================================================================== */
console.log("── 8. buildReportText (EN fallback + hi labels) ──────────");
/* ================================================================== */
{
  const greenReport = await analyzeSignatures(FIXTURES.green.bytes, NOW);
  const meta = { fileName: "green-signed.pdf", bytes: FIXTURES.green.bytes.length };
  const en = buildReportText(greenReport, meta, {});
  check("report: EN title + file line", en.includes("DocoPDF — PDF signature verification report") && en.includes("File: green-signed.pdf"));
  check("report: document line (1 page · fields)", en.includes("Document: 1 pages") && en.includes("signature fields (1 signed, 0 unsigned)"));
  check("report: xref ok line", en.includes("xref: ok"));
  check("report: summary counts", en.includes("SUMMARY: 1") && en.includes("1 valid, 0 attention, 0 invalid"));
  check("report: signer identity block", en.includes("Signer: Test Signer") && en.includes("Organization: DocoPDF Labs"));
  check("report: serial + issuer", en.includes("Certificate serial: 0x1a2b3c4d5e6f") && en.includes("Issuer: DocoPDF Test CA"));
  check("report: crypto PASS + integrity INTACT", en.includes("Cryptographic verification: PASS (RSA-PKCS1v1_5)") && en.includes("INTACT — computed digest matches messageDigest"));
  check("report: coverage line", en.includes("Modified after signing: no (0 trailing bytes)") && en.includes("/ByteRange: [0 "));
  check("report: honesty footer + generated-by", en.includes("NOT CHECKED (honesty)") && en.includes("No CRL/OCSP revocation check") && en.includes("Generated on-device by DocoPDF"));

  const hiLabels = Object.fromEntries(
    Object.entries((toolI18n as { hi: { vps: Record<string, string> } }).hi.vps).map(([k, v]) => [`vps.${k}`, v])
  );
  const hi = buildReportText(greenReport, meta, hiLabels);
  check(
    "report: Hindi labels end to end",
    hi.includes("DocoPDF — PDF हस्ताक्षर सत्यापन रिपोर्ट") &&
      hi.includes("हस्ताक्षरकर्ता: Test Signer") &&
      hi.includes("क्रिप्टोग्राफ़िक पुष्टि: पास") &&
      hi.includes("अछूता")
  );

  const tamperedBytes = new Uint8Array(FIXTURES.green.bytes);
  tamperedBytes[toLatin(tamperedBytes).indexOf("xyzzy")] = 0x58;
  const tamperedText = buildReportText(await analyzeSignatures(tamperedBytes, NOW), meta, {});
  check("report: tampered verdict wording", tamperedText.includes("Verdict: INVALID") && tamperedText.includes("TAMPERED"));

  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([595.28, 841.89]);
  const plainText = buildReportText(
    await analyzeSignatures(new Uint8Array(await plainDoc.save({ useObjectStreams: false })), NOW),
    { fileName: "plain.pdf", bytes: 900 },
    {}
  );
  check("report: unsigned document empty-state wording", plainText.includes("No signature fields found") && plainText.includes("SUMMARY: 0"));

  const emptyVReport = await analyzeSignatures(
    buildMiniPdf({ acroForm: " /AcroForm 4 0 R", extraObjects: ["/Fields [ 5 0 R ]", "/FT /Sig /T (EmptySig) /P 3 0 R /V << >>"] }),
    NOW
  );
  const evText = buildReportText(emptyVReport, { fileName: "mini.pdf", bytes: 400 }, {});
  check("report: unsigned-field section", evText.includes("UNSIGNED SIGNATURE FIELDS") && evText.includes("EmptySig") && evText.includes("never signed"));
}

/* ================================================================== */
console.log("── 9. REAL worker E2E (self-shimmed) ─────────────────────");
/* ================================================================== */
{
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  await import("../tools/verify-pdf-signatures/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "verify-pdf-signatures",
        options,
        files,
      } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  const enLabels = Object.fromEntries(
    Object.entries((toolI18n as { en: { vps: Record<string, string> } }).en.vps).map(([k, v]) => [`vps.${k}`, v])
  );
  const runPayload = JSON.stringify({ locale: "en", fileWord: "document", labels: enLabels });

  /* --- the green run --------------------------------------------------- */
  const greenRes = await drive(201, { run: runPayload }, [
    new File([FIXTURES.green.bytes as BlobPart], "green-signed.pdf"),
  ]);
  check("worker: green result", greenRes.type === "result", greenRes);
  if (greenRes.type === "result") {
    check(
      "worker: output name + mime",
      greenRes.outputs.length === 1 &&
        greenRes.outputs[0]!.name === "green-signed-verification-report.txt" &&
        greenRes.outputs[0]!.mime === "text/plain;charset=utf-8"
    );
    const d = greenRes.detail as {
      files?: number;
      signatureCount?: number;
      validCount?: number;
      attentionCount?: number;
      invalidCount?: number;
      unsignedFields?: number;
      recovered?: boolean;
    };
    check(
      "worker: detail counts",
      d.files === 1 && d.signatureCount === 1 && d.validCount === 1 &&
        d.attentionCount === 0 && d.invalidCount === 0 && d.unsignedFields === 0 && d.recovered === false
    );
    const text = await greenRes.outputs[0]!.blob.text();
    check(
      "worker: report text (PASS / INTACT / signer / honesty)",
      text.includes("PASS (RSA-PKCS1v1_5)") && text.includes("INTACT") &&
        text.includes("Test Signer") && text.includes("NOT CHECKED (honesty)")
    );
    const progresses = messages.filter(
      (m) => m.runId === 201 && m.type === "progress"
    ) as Extract<WorkerResponse, { type: "progress" }>[];
    const pcts = progresses.map((p) => p.pct);
    check("worker: progress beats 15/40/80/92 in order", JSON.stringify(pcts) === JSON.stringify([15, 40, 80, 92]), pcts);
    check(
      "worker: honest stages reading/processing/saving",
      new Set(progresses.map((p) => p.stage)).size === 2 ? false : ["reading", "processing", "saving"].every((s) => progresses.some((p) => p.stage === s))
    );
  }

  /* --- the tampered run ------------------------------------------------- */
  const tamperedBytes = new Uint8Array(FIXTURES.green.bytes);
  tamperedBytes[toLatin(tamperedBytes).indexOf("xyzzy")] = 0x58;
  const tamperedRes = await drive(202, { run: runPayload }, [
    new File([tamperedBytes], "tampered.pdf"),
  ]);
  check("worker: tampered result", tamperedRes.type === "result");
  if (tamperedRes.type === "result") {
    const d = tamperedRes.detail as { signatureCount?: number; invalidCount?: number };
    check("worker: tampered detail (1 signature, 1 invalid)", d.signatureCount === 1 && d.invalidCount === 1);
  }

  /* --- the unsigned run --------------------------------------------------- */
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([595.28, 841.89]);
  const plainBytes = new Uint8Array(await plainDoc.save({ useObjectStreams: false }));
  const plainRes = await drive(203, { run: runPayload }, [new File([plainBytes], "plain.pdf")]);
  check("worker: unsigned doc → result (not an error)", plainRes.type === "result");
  if (plainRes.type === "result") {
    const d = plainRes.detail as { signatureCount?: number };
    const text = await plainRes.outputs[0]!.blob.text();
    check("worker: unsigned detail + report empty state", d.signatureCount === 0 && text.includes("No signature fields found"));
  }

  /* --- rejection taxonomy --------------------------------------------------- */
  const notPdfRes = await drive(204, { run: runPayload }, [
    new File([latin1BytesOf("just some text, not a pdf") as BlobPart], "notes.txt"),
  ]);
  check(
    "worker: non-PDF → vps.errNotPdf",
    notPdfRes.type === "error" && notPdfRes.code === "vps.errNotPdf"
  );

  const encryptedBytes = buildMiniPdf({ trailerExtra: " /Encrypt << /Filter /Standard /V 2 >>" });
  const encRes = await drive(205, { run: runPayload }, [new File([encryptedBytes as BlobPart], "locked.pdf")]);
  check(
    "worker: encrypted → tool.errorEncrypted",
    encRes.type === "error" && encRes.code === "tool.errorEncrypted"
  );

  const noFileRes = await drive(206, { run: runPayload }, []);
  check(
    "worker: no file → tool.errorGeneric",
    noFileRes.type === "error" && noFileRes.code === "tool.errorGeneric"
  );

  /* --- garbage options.run → English fallback labels ------------------------- */
  const garbageRes = await drive(207, { run: "{not even json" }, [
    new File([FIXTURES.green.bytes as BlobPart], "green-signed.pdf"),
  ]);
  check("worker: garbage options.run still verifies", garbageRes.type === "result");
  if (garbageRes.type === "result") {
    const text = await garbageRes.outputs[0]!.blob.text();
    check("worker: fallback report is the model's English", text.includes("PDF signature verification report") && text.includes("PASS"));
  }

  /* --- Hindi labels through the worker ---------------------------------------- */
  const hiLabels = Object.fromEntries(
    Object.entries((toolI18n as { hi: { vps: Record<string, string> } }).hi.vps).map(([k, v]) => [`vps.${k}`, v])
  );
  const hiRes = await drive(
    208,
    { run: JSON.stringify({ locale: "hi", fileWord: "दस्तावेज़", labels: hiLabels }) },
    [new File([FIXTURES.selfSigned.bytes as BlobPart], "self-signed.pdf")]
  );
  check("worker: Hindi run result", hiRes.type === "result");
  if (hiRes.type === "result") {
    const d = hiRes.detail as { signatureCount?: number; attentionCount?: number };
    const text = await hiRes.outputs[0]!.blob.text();
    check(
      "worker: Hindi report + self-signed amber counts",
      d.signatureCount === 1 && d.attentionCount === 1 &&
        text.includes("हस्ताक्षर सत्यापन रिपोर्ट") && text.includes("सेल्फ़-साइन्ड")
    );
  }

  /* --- onmessage honesty -------------------------------------------------------- */
  const beforeCount = messages.length;
  workerGlobal.onmessage!({ data: { type: "definitely-not-run" } as never });
  await new Promise((r) => setTimeout(r, 150));
  check("worker: non-run messages ignored", messages.length === beforeCount);
}

/* ================================================================== */
console.log("── 10. i18n + config + wiring ─────────────────────────────");
/* ================================================================== */
{
  const enLeaves = (toolI18n as { en: { vps: Record<string, string> } }).en.vps;
  const hiLeaves = (toolI18n as { hi: { vps: Record<string, string> } }).hi.vps;
  const enKeys = Object.keys(enLeaves).sort();
  const hiKeys = Object.keys(hiLeaves).sort();
  check("i18n: tool catalog en/hi key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys), { en: enKeys.length, hi: hiKeys.length });
  check("i18n: the vps namespace is substantial", enKeys.length >= 100, enKeys.length);
  check(
    "i18n: no empty values in either language",
    [...Object.values(enLeaves), ...Object.values(hiLeaves)].every((v) => typeof v === "string" && v.trim().length > 0)
  );

  const surfaceSrc = readFileSync("tools/verify-pdf-signatures/surface.tsx", "utf8");
  const configSrc = readFileSync("tools/verify-pdf-signatures/config.ts", "utf8");
  const workerSrc = readFileSync("tools/verify-pdf-signatures/worker.ts", "utf8");
  const modelSrc = readFileSync("tools/verify-pdf-signatures/model.ts", "utf8");
  const sources = `${surfaceSrc}\n${configSrc}\n${workerSrc}\n${modelSrc}`;

  // every vps.* referenced from the four tool sources resolves…
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/vps\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  // …plus the REPORT_KEYS the surface serializes as `vps.${k}` template keys.
  const rkMatch = /const REPORT_KEYS = \[([^]*?)\] as const;/.exec(surfaceSrc);
  const reportKeys = rkMatch === null ? [] : [...rkMatch[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  for (const k of reportKeys) referenced.add(`vps.${k}`);
  // NOTE: the namespace prefix "vps." is exactly 4 characters — slice(4)
  // (the RB5 slice(6) lesson counted for THIS namespace).
  const missing = [...referenced].filter((k) => !(k.slice(4) in enLeaves) || !(k.slice(4) in hiLeaves));
  check(
    "i18n: every referenced vps.* key resolves in both catalogs",
    referenced.size >= 100 && missing.length === 0,
    { missing, referenced: referenced.size }
  );
  const unused = enKeys.filter((k) => !referenced.has(`vps.${k}`));
  check("i18n: no unused leaves (tight namespace)", unused.length === 0, unused);
  check("i18n: REPORT_KEYS extracted from the surface (78 keys)", reportKeys.length === 78, reportKeys.length);
  check(
    "i18n: worker error codes have leaves",
    "errNotPdf" in enLeaves && "errTooBig" in enLeaves && "errNotPdf" in hiLeaves && "errTooBig" in hiLeaves
  );
  check("i18n: how1–how3 present in both", ["how1", "how2", "how3"].every((k) => k in enLeaves && k in hiLeaves));
  const drift = Object.entries(REPORT_LABELS_EN).filter(([k, v]) => enLeaves[k.slice(4)] !== v);
  check("i18n: model REPORT_LABELS_EN == en catalog (no drift)", drift.length === 0, drift.map(([k]) => k));

  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as { tool: Record<string, string> };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as { tool: Record<string, string> };
  check(
    "i18n: shared tool.error* exist in the central catalog (worker fallbacks)",
    ["errorEncrypted", "errorCorrupt", "errorGeneric", "errorTitle"].every(
      (k) => k in catEn.tool && k in catHi.tool
    )
  );

  // ---- config.ts ------------------------------------------------------
  check("config: toolId", configSrc.includes('toolId: "verify-pdf-signatures"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind text", configSrc.includes('outputKind: "text"'));
  check("config: exactly one file", configSrc.includes("maxFiles: 1") && configSrc.includes("minFiles: 1"));
  check("config: howKeys are vps.*", configSrc.includes('"vps.how1"') && configSrc.includes('"vps.how3"'));
  check("config: no options (zero-option tool)", configSrc.includes("options: []"));
  check(
    "config: chain tools declared",
    configSrc.includes('"view-pdf"') && configSrc.includes('"sign-pdf"') && configSrc.includes('"request-signature"')
  );

  // ---- surface.tsx ------------------------------------------------------
  check("surface: ships the run payload with localized labels", surfaceSrc.includes('onChange("run"') && surfaceSrc.includes("REPORT_KEYS.map"));
  check("surface: fflate stays worker-only (no ./model import)", !/from "\.\/model"/.test(surfaceSrc));
  check("surface: CTA gating via setRunBlocked", surfaceSrc.includes("setRunBlocked"));
  check("surface: local %PDF- sniff (repair-pdf rule)", surfaceSrc.includes("localPdfSniff"));

  // ---- worker.ts --------------------------------------------------------
  check("worker: only reacts to type run", workerSrc.includes('data?.type !== "run"'));
  check("worker: maps errEncrypted to tool.errorEncrypted", workerSrc.includes('"tool.errorEncrypted"'));
  check("worker: on-device report suffix", workerSrc.includes("-verification-report.txt"));

  // ---- wiring (the orchestrator's batch step — asserted as done here) -----
  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "wiring: configs.ts imports + registers the tool config",
    configsSrc.includes('import { config as verifyPdfSignatures } from "../../../tools/verify-pdf-signatures/config"') &&
      configsSrc.includes("[verifyPdfSignatures.toolId]: verifyPdfSignatures")
  );
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "wiring: surfaces.tsx imports + registers the surface",
    surfacesSrc.includes('import { VerifyPdfSignaturesSurface } from "../../../tools/verify-pdf-signatures/surface"') &&
      surfacesSrc.includes('"verify-pdf-signatures": VerifyPdfSignaturesSurface')
  );
  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const at = registrySrc.indexOf('id: "verify-pdf-signatures"');
  const block = registrySrc.slice(at, at + 420);
  check(
    "wiring: registry def enabled + mode D + view category + accepts pdf",
    at >= 0 && block.includes("enabled: true") && block.includes('mode: "D"') &&
      block.includes('category: "view"') && block.includes('accepts: "pdf"')
  );
  check(
    "wiring: registry description honest",
    block.includes("Signer, time, certificate status and tamper detection.")
  );
}

/* ================================================================== */
console.log("── 11. parseRun + outputBaseName (worker boundary) ────────");
/* ================================================================== */
{
  const r1 = parseRun('{"locale":"hi","fileWord":"दस्तावेज़","labels":{"vps.title":"X"}}');
  check("parseRun: locale hi + fileWord + a label", r1.locale === "hi" && r1.fileWord === "दस्तावेज़" && r1.labels["vps.title"] === "X");
  check("parseRun: garbage JSON degrades to defaults", (() => {
    const r = parseRun("{not json");
    return r.locale === "en" && r.fileWord === "" && Object.keys(r.labels).length === 0;
  })());
  check(
    "parseRun: label keys filtered (vps.* alnum only)",
    (() => {
      const r = parseRun('{"labels":{"vps.ok":"yes","other.x":"no","vps.bad-key":"no","vps.ok2":"fine"}}');
      return r.labels["vps.ok"] === "yes" && r.labels["vps.ok2"] === "fine" && !("other.x" in r.labels) && !("vps.bad-key" in r.labels);
    })()
  );
  check(
    "parseRun: control characters scrubbed from fileWord",
    (() => {
      const r = parseRun('{"fileWord":"a\\u0007b\\n c\\t"}');
      // \x07, \n and \t are dropped; the kept space collapses to one
      return r.fileWord === "ab c";
    })()
  );
  check(
    "parseRun: non-string fileWord → empty",
    parseRun('{"fileWord":42}').fileWord === ""
  );
  check(
    "parseRun: label values capped + non-strings skipped",
    (() => {
      const r = parseRun('{"labels":{"vps.long":"' + "x".repeat(300) + '","vps.num":7}}');
      return r.labels["vps.long"]!.length === 240 && !("vps.num" in r.labels);
    })()
  );

  check("outputBaseName: strips .pdf + sanitizes", outputBaseName("My Doc v2.pdf", "en") === "My Doc v2" && outputBaseName("bad/name*.pdf", "en") === "bad_name_");
  check("outputBaseName: empty → localized file word", outputBaseName(" .pdf", "hi", "दस्तावेज़") === "दस्तावेज़");
  check("outputBaseName: no fileWord → per-locale fallback", outputBaseName(".pdf", "hi") === "दस्तावेज़" && outputBaseName(".pdf", "en") === "document");
  check("outputBaseName: long names capped at 120", outputBaseName(`${"a".repeat(200)}.pdf`, "en").length === 120);
}

console.log(
  `\nverify-pdf-signatures smoke: ${pass} passed, ${fail} failed` +
  (fail ? `\n  ${failures.join("\n  ")}` : "")
);
process.exit(fail === 0 ? 0 : 1);
