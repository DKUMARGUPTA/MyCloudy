/**
 * Verify PDF signatures — pure engine (PRD §7.7 "Verify PDF signatures",
 * PRD line: pkijs, mode D).
 *
 * Everything on-device (Mode D, zero network): the file's raw bytes are
 * hashed with WebCrypto and the embedded PKCS#7/CMS structures are parsed
 * with pkijs. The engine deliberately NEVER contacts a CA, CRL or OCSP
 * responder — chain trust and revocation cannot be checked offline and the
 * report says so honestly instead of pretending.
 *
 * What IS checked (the checks that matter for tamper detection):
 *   1. Document integrity — digest over the signed ByteRange vs the CMS
 *      signed messageDigest attribute  →  "verified" | "modified".
 *   2. Signed-attributes integrity — the CMS signature over the DER of the
 *      signed attributes (signer identity, time, reason are inside it).
 *   3. Coverage — how much of the file the signature covers and how many
 *      bytes were appended after it (later incremental revisions).
 *   4. Certificate window — notBefore/notAfter vs the signing time and now.
 *
 * Used by the surface (live analysis on drop) and the worker (the report
 * run) — the same engine, so a preview verdict and a report verdict are the
 * same verdict.
 */
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFObject,
} from "@cantoo/pdf-lib";
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";

/* ------------------------------------------------------------------ types */

export type IntegrityStatus =
  /** Digest over the signed range matches the signed messageDigest. */
  | "verified"
  /** Digest mismatch — the bytes changed after signing. */
  | "modified"
  /** Could not be checked (unknown digest, malformed ByteRange, …). */
  | "unverified"
  /** Legacy/unknown SubFilter this engine cannot verify yet. */
  | "unsupported";

export interface CertInfo {
  /** Subject common name (CN) — the name shown to the user. */
  commonName: string | null;
  subjectOrg: string | null;
  subjectCountry: string | null;
  subjectEmail: string | null;
  issuerCommonName: string | null;
  issuerOrg: string | null;
  /** Serial number, lowercase hex, no separators. */
  serialHex: string | null;
  notBeforeIso: string | null;
  notAfterIso: string | null;
  /** Window vs the signing time (attr preferred, /M fallback). */
  validityAtSigning: "valid" | "notYetValid" | "expired" | "unknown";
  /** Window vs now. */
  currentlyValid: boolean | null;
  publicKey: { kind: string; bits?: number };
  /** SHA-256 fingerprint of the DER certificate, lowercase hex. */
  sha256Hex: string | null;
}

export interface SignatureFinding {
  /** AcroForm field name (/T) — null when the writer omitted it. */
  fieldName: string | null;
  /** /V present with actual contents (false = unsigned placeholder). */
  signed: boolean;
  subFilter: string | null;
  /** Display signer: /Name if present, else the certificate CN. */
  signerName: string | null;
  reason: string | null;
  location: string | null;
  /** ISO-8601 (UTC "Z") — signingTime attr first, /M as fallback. */
  signingTimeIso: string | null;
  integrity: IntegrityStatus;
  /** CMS signature over the signed attributes (null = not checked). */
  signatureOverAttrs: boolean | null;
  coverage: {
    signedBytes: number;
    fileBytes: number;
    /** Bytes after the signed range — appended after this signature. */
    trailingBytes: number;
  };
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  cert: CertInfo | null;
  /** Short machine note for the report (English; UI localizes codes). */
  note: string | null;
}

export interface SignaturesReport {
  pageCount: number;
  fileBytes: number;
  /** Signed signature fields, in document order (earliest revision first). */
  signatures: SignatureFinding[];
  /** Fields present but never signed (empty /V). */
  unsignedFields: number;
  /** Every signed signature has integrity === "verified". */
  allIntact: boolean;
  encrypted: boolean;
}

/* ----------------------------------------------------------- OID registry */

const DIGEST_OIDS: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};

const SIG_OIDS: Record<string, string> = {
  "1.2.840.113549.1.1.5": "SHA-1 with RSA",
  "1.2.840.113549.1.1.11": "SHA-256 with RSA",
  "1.2.840.113549.1.1.12": "SHA-384 with RSA",
  "1.2.840.113549.1.1.13": "SHA-512 with RSA",
  "1.2.840.10045.4.3.2": "SHA-256 with ECDSA",
  "1.2.840.10045.4.3.4": "SHA-512 with ECDSA",
  "1.2.840.10045.4.1": "SHA-1 with ECDSA",
};

const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";

/* ------------------------------------------------------------- utilities */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function rdnValues(rdn: unknown, wanted: string): string | null {
  if (
    typeof rdn !== "object" ||
    rdn === null ||
    !("typesAndValues" in rdn) ||
    !Array.isArray((rdn as { typesAndValues: unknown }).typesAndValues)
  ) {
    return null;
  }
  for (const tv of (rdn as { typesAndValues: { type: string; value: unknown }[] })
    .typesAndValues) {
    if (tv.type === wanted) {
      // asn1js string blocks: { valueBlock: { value: "…" } }
      const block = tv.value as
        | { valueBlock?: { value?: unknown } }
        | null;
      const inner = block?.valueBlock?.value;
      if (typeof inner === "string") return inner;
    }
  }
  return null;
}

function asn1TimeString(value: unknown): string | null {
  // asn1js v3 UTCTime/GeneralizedTime keep the ASCII in valueHexView;
  // older shapes used { value: "YYMMDDHHMMSSZ" } or parsedValue fields.
  if (typeof value !== "object" || value === null) return null;
  const block = value as {
    valueHexView?: Uint8Array;
    value?: string;
    parsedValue?: {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second?: number;
    };
  };
  let raw: string | null = null;
  if (block.valueHexView && block.valueHexView.length > 0) {
    raw = new TextDecoder("latin1").decode(block.valueHexView);
  } else if (typeof block.value === "string" && block.value !== "") {
    raw = block.value;
  } else if (block.parsedValue && Number.isFinite(block.parsedValue.year)) {
    const p = block.parsedValue;
    const d = new Date(
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0)
    );
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (raw === null) return null;
  const m = /^(\d{4}|\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(raw);
  if (!m) return null;
  const year = m[1].length === 4 ? Number(m[1]) : 2000 + Number(m[1]);
  const d = new Date(
    Date.UTC(
      year,
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      m[6] ? Number(m[6]) : 0
    )
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse a PDF date string ("D:YYYYMMDDHHmmSSOHH'mm'") → ISO-8601 UTC. */
export function parsePdfDate(raw: string): string | null {
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Zz])(\d{2})?'?(\d{2})?'?)?/.exec(
      raw
    );
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) - 1 : 0;
  const day = m[3] ? Number(m[3]) : 1;
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;
  let ms = Date.UTC(year, month, day, hour, minute, second);
  const zone = m[7]?.toUpperCase();
  if (zone === "+" || zone === "-") {
    const oh = m[8] ? Number(m[8]) : 0;
    const om = m[9] ? Number(m[9]) : 0;
    const offsetMs = (oh * 60 + om) * 60_000;
    ms += zone === "+" ? -offsetMs : offsetMs;
  }
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto unavailable");
  return c.subtle;
}

async function digestOf(algo: string, bytes: Uint8Array): Promise<Uint8Array> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const buf = await subtle().digest(algo, view);
  return new Uint8Array(buf);
}

function asFreshBuffer(bytes: Uint8Array): ArrayBuffer {
  // slice() always allocates a new ArrayBuffer at runtime.
  return bytes.slice().buffer as ArrayBuffer;
}

function toIsoOrNull(date: Date | null): string | null {
  if (date === null) return null;
  const t = date.getTime();
  return Number.isNaN(t) ? null : date.toISOString();
}

// hexStringToBytes is no longer needed — pdf-lib's PDFHexString.asBytes()
// does the same job with the same tolerance for stray whitespace.


/* ------------------------------------------------- certificate extraction */

function certInfoFrom(cert: pkijs.Certificate, atIso: string | null): CertInfo {
  const notBeforeIso = toIsoOrNull(cert.notBefore?.value ?? null);
  const notAfterIso = toIsoOrNull(cert.notAfter?.value ?? null);

  let validityAtSigning: CertInfo["validityAtSigning"] = "unknown";
  const at = atIso !== null ? Date.parse(atIso) : NaN;
  if (notBeforeIso !== null && notAfterIso !== null && Number.isFinite(at)) {
    if (at < Date.parse(notBeforeIso)) validityAtSigning = "notYetValid";
    else if (at > Date.parse(notAfterIso)) validityAtSigning = "expired";
    else validityAtSigning = "valid";
  }
  const now = Date.now();
  const currentlyValid =
    notBeforeIso !== null && notAfterIso !== null
      ? now >= Date.parse(notBeforeIso) && now <= Date.parse(notAfterIso)
      : null;

  // Public key kind + RSA size.
  let publicKey: CertInfo["publicKey"] = { kind: "unknown" };
  const spki = cert.subjectPublicKeyInfo;
  const keyOid = spki?.algorithm?.algorithmId ?? "";
  if (keyOid === "1.2.840.113549.1.1.1") {
    let bits = 0;
    try {
      const rsaParsed = asn1js.fromBER(
        spki.subjectPublicKey.valueBlock.valueHex
      );
      const rsa = new pkijs.RSAPublicKey({ schema: rsaParsed.result });
      const modulus = new Uint8Array(rsa.modulus.valueBlock.valueHex);
      let i = 0;
      while (i < modulus.length - 1 && modulus[i] === 0) i += 1;
      // Top byte's leading zero bits: 0xa0 -> 0, 0x01 -> 7.
      const lead = Math.clz32(modulus[i] || 1) - 24;
      bits = (modulus.length - i) * 8 - lead;
    } catch {
      bits = 0;
    }
    publicKey = { kind: "RSA", bits };
  } else if (keyOid === "1.2.840.10045.2.1") {
    publicKey = { kind: "EC" };
  } else if (keyOid !== "") {
    publicKey = { kind: keyOid };
  }

  let serialHex: string | null = null;
  try {
    serialHex = toHex(new Uint8Array(cert.serialNumber.valueBlock.valueHex));
  } catch {
    serialHex = null;
  }

  return {
    commonName: rdnValues(cert.subject, "2.5.4.3"),
    subjectOrg: rdnValues(cert.subject, "2.5.4.10"),
    subjectCountry: rdnValues(cert.subject, "2.5.4.6"),
    subjectEmail: rdnValues(cert.subject, "1.2.840.113549.1.9.1"),
    issuerCommonName: rdnValues(cert.issuer, "2.5.4.3"),
    issuerOrg: rdnValues(cert.issuer, "2.5.4.10"),
    serialHex,
    notBeforeIso,
    notAfterIso,
    validityAtSigning,
    currentlyValid,
    publicKey,
    // Filled asynchronously by the caller (WebCrypto digest).
    sha256Hex: null,
  };
}

async function certSha256Hex(cert: pkijs.Certificate): Promise<string | null> {
  try {
    const derCert = cert.toSchema(true).toBER() as ArrayBuffer;
    return toHex(await digestOf("SHA-256", new Uint8Array(derCert)));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ CMS verify */

interface CmsFindings {
  integrity: IntegrityStatus;
  signatureOverAttrs: boolean | null;
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  signingTimeIso: string | null;
  cert: CertInfo | null;
  note: string | null;
}

const CMS_FAIL = (note: string, extra?: Partial<CmsFindings>): CmsFindings => ({
  integrity: "unverified",
  signatureOverAttrs: null,
  digestAlgorithm: null,
  signatureAlgorithm: null,
  signingTimeIso: null,
  cert: null,
  note,
  ...extra,
});

async function verifyAttrsOnly(
  cert: pkijs.Certificate,
  signer: pkijs.SignerInfo,
  digestAlgorithm: string | null
): Promise<boolean | null> {
  // The CMS signature over the signed attributes — INDEPENDENT of the
  // document digest: even on a tampered document this proves the signer
  // really produced the identity/time/reason metadata shown above.
  // Returns null when it cannot be checked (non-RSA or missing pieces).
  try {
    const encoded = (signer.signedAttrs as unknown as {
      encodedValue?: ArrayBuffer;
    }).encodedValue;
    if (encoded === undefined || encoded.byteLength === 0) return null;
    const keyOid = cert.subjectPublicKeyInfo?.algorithm?.algorithmId ?? "";
    if (keyOid !== "1.2.840.113549.1.1.1") return null; // RSA only (v1)
    const sigOid = signer.signatureAlgorithm?.algorithmId ?? "";
    const hashName =
      sigOid === "1.2.840.113549.1.1.5"
        ? "SHA-1"
        : sigOid === "1.2.840.113549.1.1.12"
          ? "SHA-384"
          : sigOid === "1.2.840.113549.1.1.13"
            ? "SHA-512"
            : sigOid === "1.2.840.113549.1.1.1" && digestAlgorithm !== null
              ? digestAlgorithm // raw rsaEncryption — hash from the digest
              : digestAlgorithm ?? "SHA-256";
    if (!/SHA-(1|256|384|512)/.test(hashName)) return null;
    const spki = cert.subjectPublicKeyInfo
      .toSchema()
      .toBER() as ArrayBuffer;
    const key = await subtle().importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: hashName },
      false,
      ["verify"]
    );
    const sig = new Uint8Array(signer.signature.valueBlock.valueHex);
    return await subtle().verify(
      "RSASSA-PKCS1-v1_5",
      key,
      asFreshBuffer(sig),
      encoded
    );
  } catch {
    return null;
  }
}

async function analyzeCms(
  der: Uint8Array,
  covered: Uint8Array,
  /** adbe.pkcs7.sha1 signs a SHA-1 digest of the content, not the content. */
  contentIsSha1: boolean,
  signingTimeFromPdf: string | null
): Promise<CmsFindings> {
  const parsed = asn1js.fromBER(asFreshBuffer(der));
  if (parsed.offset === -1) {
    return CMS_FAIL("contents did not parse as ASN.1 DER");
  }
  let contentInfo: pkijs.ContentInfo;
  try {
    contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
  } catch {
    return CMS_FAIL("contents is not a CMS ContentInfo");
  }
  if (contentInfo.contentType !== OID_SIGNED_DATA) {
    return CMS_FAIL(`unexpected CMS type ${contentInfo.contentType}`);
  }
  let signedData: pkijs.SignedData;
  try {
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch {
    return CMS_FAIL("signedData structure did not parse");
  }

  const signer =
    signedData.signerInfos.length > 0 ? signedData.signerInfos[0] : null;
  if (signer === null) {
    return CMS_FAIL("no signerInfo in the signature");
  }

  const digestAlgorithm = DIGEST_OIDS[signer.digestAlgorithm?.algorithmId] ?? null;
  const sigOid = signer.signatureAlgorithm?.algorithmId ?? "";
  let signatureAlgorithm: string | null = SIG_OIDS[sigOid] ?? null;
  if (signatureAlgorithm === null && sigOid !== "") {
    // Raw "rsaEncryption" OID — combine with the digest for a readable name.
    signatureAlgorithm =
      sigOid === "1.2.840.113549.1.1.1" && digestAlgorithm !== null
        ? `${digestAlgorithm} with RSA`
        : sigOid;
  }

  // Signed attributes: messageDigest + signingTime.
  let signedMessageDigestHex: string | null = null;
  let signingTimeIso: string | null = null;
  const attrs = signer.signedAttrs?.attributes ?? [];
  for (const attr of attrs) {
    if (attr.type === OID_MESSAGE_DIGEST) {
      const v = attr.values[0] as { valueBlock?: { valueHex?: ArrayBuffer } };
      if (v?.valueBlock?.valueHex) {
        signedMessageDigestHex = toHex(new Uint8Array(v.valueBlock.valueHex));
      }
    } else if (attr.type === OID_SIGNING_TIME) {
      signingTimeIso = asn1TimeString(attr.values[0]);
    }
  }

  // Signer certificate — match SID (issuer+serial) when possible.
  const certs = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate
  );
  let cert: pkijs.Certificate | null = certs.length > 0 ? certs[0] : null;
  const sid = signer.sid as unknown as {
    issuer?: unknown;
    serialNumber?: { valueBlock?: { valueHex?: ArrayBuffer } };
  } | null;
  if (sid?.serialNumber?.valueBlock?.valueHex) {
    const sidSerial = toHex(new Uint8Array(sid.serialNumber.valueBlock.valueHex));
    const match = certs.find((c) => {
      try {
        return (
          toHex(new Uint8Array(c.serialNumber.valueBlock.valueHex)) === sidSerial
        );
      } catch {
        return false;
      }
    });
    if (match) cert = match;
  }
  if (cert === null) {
    return CMS_FAIL("no certificate embedded in the signature", {
      digestAlgorithm,
      signatureAlgorithm,
      signingTimeIso,
    });
  }

  const certInfo = certInfoFrom(cert, signingTimeIso ?? signingTimeFromPdf);
  certInfo.sha256Hex = await certSha256Hex(cert);

  // The bytes covered by the digest (adbe.pkcs7.sha1 hashes the SHA-1).
  let signedContent = covered;
  if (contentIsSha1) {
    signedContent = await digestOf("SHA-1", covered);
  }

  if (digestAlgorithm === null || signedMessageDigestHex === null) {
    // No messageDigest attribute: integrity via the bare CMS signature.
    let ok = false;
    try {
      ok = await signedData.verify({
        signer: 0,
        data: asFreshBuffer(signedContent),
      });
    } catch {
      ok = false;
    }
    return {
      integrity: ok ? "verified" : "modified",
      signatureOverAttrs: null,
      digestAlgorithm,
      signatureAlgorithm,
      signingTimeIso,
      cert: certInfo,
      note: ok
        ? "verified via the raw CMS signature (no signed attributes)"
        : "raw CMS signature check failed",
    };
  }

  // 1. Document integrity: re-hash the covered range ourselves.
  const computedHex = toHex(await digestOf(digestAlgorithm, signedContent));
  const integrity: IntegrityStatus =
    computedHex === signedMessageDigestHex.toLowerCase()
      ? "verified"
      : "modified";

  // 2. CMS signature over the signed attributes — independent of the
  //    document bytes (a tampered page does not make the signer's metadata
  //    a forgery, and vice versa).
  const signatureOverAttrs = await verifyAttrsOnly(
    cert,
    signer,
    digestAlgorithm
  );

  return {
    integrity,
    signatureOverAttrs,
    digestAlgorithm,
    signatureAlgorithm,
    signingTimeIso,
    cert: certInfo,
    note:
      integrity === "modified"
        ? "digest over the signed range does not match the signed digest"
        : null,
  };
}

/* --------------------------------------------------- signature field scan */

function pdfString(value: PDFObject | undefined): string | null {
  if (value instanceof PDFString) return value.asString();
  if (value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return null;
    }
  }
  return null;
}

function parseByteRange(
  v: PDFObject | undefined,
  fileLen: number
): [number, number, number, number] | null {
  if (
    typeof v !== "object" ||
    v === null ||
    !("asArray" in v) ||
    typeof (v as { asArray?: unknown }).asArray !== "function"
  ) {
    return null;
  }
  const arr = (v as { asArray: () => PDFObject[] }).asArray();
  const nums = arr.map((item) =>
    item instanceof PDFNumber ? item.asNumber() : NaN
  );
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const [o1, l1, o2, l2] = nums;
  if (
    o1 < 0 ||
    l1 < 0 ||
    o2 < o1 + l1 ||
    o2 + l2 > fileLen + 1 // tolerate a 1-byte rounding quirk, no more
  ) {
    return null;
  }
  return [o1, l1, o2, l2];
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

/** The public analysis entry — one file, full report. */
export async function analyzeSignatures(
  bytes: Uint8Array
): Promise<SignaturesReport> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const encrypted = /encrypt/i.test(message);
    throw new Error(encrypted ? "verify.errorEncrypted" : "verify.errorBroken");
  }
  if (doc.isEncrypted) throw new Error("verify.errorEncrypted");

  const findings: SignatureFinding[] = [];
  let unsignedFields = 0;

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const ft = obj.get(PDFName.of("FT"));
    if (ft !== PDFName.of("Sig")) continue;

    const fieldName = pdfString(obj.get(PDFName.of("T")));

    const vRef = obj.get(PDFName.of("V"));
    let value: PDFDict | undefined;
    if (vRef instanceof PDFDict) {
      value = vRef;
    } else if (vRef !== undefined) {
      try {
        const resolved = doc.context.lookup(vRef);
        if (resolved instanceof PDFDict) value = resolved;
      } catch {
        value = undefined;
      }
    }

    if (value === undefined) {
      unsignedFields += 1;
      continue;
    }

    const subFilterObj = value.get(PDFName.of("SubFilter"));
    const subFilter =
      subFilterObj instanceof PDFName
        ? subFilterObj.asString().replace(/^\//, "")
        : null;

    const byteRange = parseByteRange(
      value.get(PDFName.of("ByteRange")),
      bytes.length
    );
    const contentsHex = value.get(PDFName.of("Contents"));
    const der =
      contentsHex instanceof PDFHexString ? contentsHex.asBytes() : null;

    const signerName = pdfString(value.get(PDFName.of("Name")));
    const reason = pdfString(value.get(PDFName.of("Reason")));
    const location = pdfString(value.get(PDFName.of("Location")));
    const mRaw = pdfString(value.get(PDFName.of("M")));
    const signingTimeFromPdf = mRaw !== null ? parsePdfDate(mRaw) : null;

    const coveredEnd = byteRange ? byteRange[2] + byteRange[3] : 0;
    const trailingBytes = byteRange
      ? Math.max(0, bytes.length - coveredEnd)
      : 0;

    // Unsigned placeholder: empty /V, zero DER, or a sentinel ByteRange.
    if (
      der === null ||
      der.length === 0 ||
      isAllZero(der) ||
      byteRange === null ||
      byteRange[1] >= 1_000_000_000
    ) {
      unsignedFields += 1;
      continue;
    }

    const covered = new Uint8Array(byteRange[1] + byteRange[3]);
    covered.set(bytes.subarray(byteRange[0], byteRange[0] + byteRange[1]), 0);
    covered.set(
      bytes.subarray(byteRange[2], byteRange[2] + byteRange[3]),
      byteRange[1]
    );

    let cms: CmsFindings;
    if (subFilter === "adbe.x509.rsa_sha1") {
      // Legacy: /Contents is the raw RSA signature; certs ride in /Cert.
      cms = await analyzeLegacyX509(value, der, covered, signingTimeFromPdf);
    } else if (
      subFilter === null ||
      subFilter === "adbe.pkcs7.detached" ||
      subFilter === "ETSI.CAdES.detached"
    ) {
      cms = await analyzeCms(der, covered, false, signingTimeFromPdf);
    } else if (subFilter === "adbe.pkcs7.sha1") {
      cms = await analyzeCms(der, covered, true, signingTimeFromPdf);
    } else {
      cms = {
        integrity: "unsupported",
        signatureOverAttrs: null,
        digestAlgorithm: null,
        signatureAlgorithm: null,
        signingTimeIso: signingTimeFromPdf,
        cert: null,
        note: `unsupported SubFilter ${subFilter}`,
      };
    }

    findings.push({
      fieldName,
      signed: true,
      subFilter,
      signerName: signerName ?? cms.cert?.commonName ?? null,
      reason,
      location,
      signingTimeIso: cms.signingTimeIso ?? signingTimeFromPdf,
      integrity: cms.integrity,
      signatureOverAttrs: cms.signatureOverAttrs,
      coverage: {
        signedBytes: byteRange[1] + byteRange[3],
        fileBytes: bytes.length,
        trailingBytes,
      },
      digestAlgorithm: cms.digestAlgorithm,
      signatureAlgorithm: cms.signatureAlgorithm,
      cert: cms.cert,
      note: cms.note,
    });
  }

  // Stable order: earliest revision first (smallest signed range).
  findings.sort((a, b) => a.coverage.signedBytes - b.coverage.signedBytes);

  return {
    pageCount: doc.getPageCount(),
    fileBytes: bytes.length,
    signatures: findings,
    unsignedFields,
    allIntact:
      findings.length > 0 && findings.every((f) => f.integrity === "verified"),
    encrypted: false,
  };
}

/* --------------------------------------------- legacy adbe.x509.rsa_sha1 */

async function analyzeLegacyX509(
  value: PDFDict,
  signature: Uint8Array,
  covered: Uint8Array,
  signingTimeFromPdf: string | null
): Promise<CmsFindings> {
  const certsRaw: Uint8Array[] = [];
  const certObj = value.get(PDFName.of("Cert"));
  if (certObj !== undefined) {
    const items =
      typeof certObj === "object" &&
      certObj !== null &&
      "asArray" in certObj &&
      typeof (certObj as { asArray?: unknown }).asArray === "function"
        ? (certObj as { asArray: () => PDFObject[] }).asArray()
        : [certObj];
    for (const item of items) {
      if (item instanceof PDFHexString) {
        const b = item.asBytes();
        if (b.length > 0) certsRaw.push(b);
      } else if (item instanceof PDFString) {
        const s = item.asString();
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i) & 0xff;
        certsRaw.push(b);
      }
    }
  }
  for (const der of certsRaw) {
    try {
      const parsed = asn1js.fromBER(asFreshBuffer(der));
      const cert = new pkijs.Certificate({ schema: parsed.result });
      const spki = cert.subjectPublicKeyInfo
        .toSchema()
        .toBER() as ArrayBuffer;
      const key = await subtle().importKey(
        "spki",
        spki,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
        false,
        ["verify"]
      );
      const docSha1 = await digestOf("SHA-1", covered);
      const ok = await subtle().verify(
        "RSASSA-PKCS1-v1_5",
        key,
        asFreshBuffer(signature),
        asFreshBuffer(docSha1)
      );
      const info = certInfoFrom(cert, signingTimeFromPdf);
      info.sha256Hex = await certSha256Hex(cert);
      return {
        integrity: ok ? "verified" : "modified",
        signatureOverAttrs: null,
        digestAlgorithm: "SHA-1",
        signatureAlgorithm: "SHA-1 with RSA (legacy)",
        signingTimeIso: signingTimeFromPdf,
        cert: info,
        note: null,
      };
    } catch {
      // try the next certificate
    }
  }
  return {
    integrity: "unsupported",
    signatureOverAttrs: null,
    digestAlgorithm: "SHA-1",
    signatureAlgorithm: "SHA-1 with RSA (legacy)",
    signingTimeIso: signingTimeFromPdf,
    cert: null,
    note: "legacy signature without readable certificates",
  };
}

/* ------------------------------------------------------- report artifact */

/** Human-readable report body (English) — the worker's txt output. */
export function buildVerifyReport(
  fileName: string,
  report: SignaturesReport
): string {
  const lines: string[] = [];
  lines.push("PDF signature verification report");
  lines.push("==================================");
  lines.push("");
  lines.push(`File: ${fileName}`);
  lines.push(`Size: ${report.fileBytes.toLocaleString("en-US")} bytes`);
  lines.push(`Pages: ${report.pageCount}`);
  lines.push(
    `Signatures: ${report.signatures.length} signed, ${report.unsignedFields} unsigned field(s)`
  );
  lines.push("");
  if (report.signatures.length === 0) {
    lines.push("No signed signature found in this document.");
    lines.push(
      "Unsigned signature fields count as forms to fill, not signatures."
    );
    return lines.join("\n");
  }
  report.signatures.forEach((sig, index) => {
    const n = index + 1;
    lines.push(`--- Signature ${n}${sig.fieldName ? ` (${sig.fieldName})` : ""} ---`);
    lines.push(`Signer: ${sig.signerName ?? "(unknown)"}`);
    if (sig.signingTimeIso) {
      lines.push(
        `Signing time: ${sig.signingTimeIso.replace("T", " ").replace("Z", " UTC")}`
      );
    }
    if (sig.reason) lines.push(`Reason: ${sig.reason}`);
    if (sig.location) lines.push(`Location: ${sig.location}`);
    const verdict =
      sig.integrity === "verified"
        ? "Document integrity: VERIFIED — the signed bytes are unchanged."
        : sig.integrity === "modified"
          ? "Document integrity: MODIFIED — the file changed after signing."
          : sig.integrity === "unsupported"
            ? "Document integrity: NOT CHECKED (unsupported signature format)."
            : "Document integrity: NOT CHECKED (verification failed).";
    lines.push(verdict);
    if (sig.signatureOverAttrs === false) {
      lines.push(
        "Signature over the signed attributes: FAILED — metadata may be altered."
      );
    }
    lines.push(
      `Coverage: ${sig.coverage.signedBytes.toLocaleString("en-US")} of ${sig.coverage.fileBytes.toLocaleString("en-US")} bytes signed` +
        (sig.coverage.trailingBytes > 0
          ? `; ${sig.coverage.trailingBytes.toLocaleString("en-US")} bytes appended after this signature`
          : "")
    );
    if (sig.digestAlgorithm) lines.push(`Digest: ${sig.digestAlgorithm}`);
    if (sig.signatureAlgorithm) {
      lines.push(`Signature algorithm: ${sig.signatureAlgorithm}`);
    }
    const cert = sig.cert;
    if (cert) {
      lines.push(
        `Certificate subject: ${[
          cert.commonName && `CN=${cert.commonName}`,
          cert.subjectOrg && `O=${cert.subjectOrg}`,
          cert.subjectCountry && `C=${cert.subjectCountry}`,
        ]
          .filter(Boolean)
          .join(", ")}`
      );
      lines.push(
        `Certificate issuer: ${cert.issuerCommonName ?? cert.issuerOrg ?? "(unknown)"}`
      );
      if (cert.serialHex) lines.push(`Serial: ${cert.serialHex}`);
      if (cert.notBeforeIso && cert.notAfterIso) {
        lines.push(
          `Valid: ${cert.notBeforeIso.slice(0, 10)} to ${cert.notAfterIso.slice(0, 10)}`
        );
        if (cert.validityAtSigning === "expired") {
          lines.push("Note: the certificate was EXPIRED at signing time.");
        } else if (cert.validityAtSigning === "notYetValid") {
          lines.push("Note: the certificate was not yet valid at signing time.");
        }
      }
      if (cert.publicKey.kind === "RSA" && (cert.publicKey.bits ?? 0) > 0) {
        lines.push(`Public key: RSA ${cert.publicKey.bits} bits`);
      } else if (cert.publicKey.kind === "EC") {
        lines.push("Public key: EC");
      }
      if (cert.sha256Hex) {
        lines.push(`SHA-256 fingerprint: ${cert.sha256Hex}`);
      }
    }
    if (sig.note) lines.push(`Note: ${sig.note}`);
    lines.push("");
  });
  lines.push(
    "Chain trust and revocation were NOT checked — this app is offline by design."
  );
  return lines.join("\n");
}
