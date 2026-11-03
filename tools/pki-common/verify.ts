/**
 * pki-common/verify — verify PAdES (adbe.pkcs7.detached) signatures.
 *
 * Reads the /ByteRange + /Contents pairs straight out of the PDF bytes
 * (no pdf-lib needed — works on any file, even slightly damaged ones),
 * re-extracts the covered bytes, parses the CMS and checks:
 *
 *   1. messageDigest attribute === hash(covered bytes)   — document integrity
 *   2. signature over signedAttrs (0x31 SET form)        — signature validity
 *   3. signer cert validity period at signing time
 *   4. chain linkage to any embedded/self-signed root (when present)
 *
 * Honest limits (reported, not hidden): no CRL/OCSP revocation checks,
 * no trusted-root anchoring — an embedded chain verifies cryptographically,
 * but "trusted" is a policy decision the UI states clearly.
 */

import {
  concat,
  ecDerToRaw,
  parseDerAt,
  sha,
  toHex,
} from "./asn1";
import {
  parseSignedDataDer,
  findSignerCert,
  certSerial,
  OID_SHA1,
  OID_SHA256,
  OID_SHA384,
  OID_SHA512,
  type ParsedSignedData,
  type ParsedSignerInfo,
} from "./cms";
import {
  parseCertificate,
  verifyCertIssuedBy,
  type X509Info,
} from "./x509";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CheckStatus = "pass" | "fail" | "unknown";

export interface VerifyCheck {
  id:
    | "cms"
    | "digest"
    | "signature"
    | "cert-found"
    | "cert-period"
    | "chain"
    | "self-signed";
  status: CheckStatus;
  detail?: string;
}

export interface SignatureReport {
  /** ByteRange of this signature. */
  byteRange: [number, number, number, number];
  /** Cryptographic verdict: every hard check passed. */
  valid: boolean;
  signer: X509Info | null;
  signingTime: Date | null;
  reason?: string;
  checks: VerifyCheck[];
  /** True when the covered region still hashes to the signed digest. */
  documentIntact: boolean;
}

export interface VerifyPdfResult {
  found: SignatureReport[];
  /** False = no adbe.pkcs7.detached signature at all. */
  hasSignature: boolean;
}

/* ------------------------------------------------------------------ */
/* PDF byte scanning                                                   */
/* ------------------------------------------------------------------ */

/** Latin-1 view of the bytes (preserves offsets for byte math). */
function latin1(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return s;
}

export interface RawSigSlot {
  byteRange: [number, number, number, number];
  contentsDer: Uint8Array;
  contentsStart: number; // offset of '<'
  contentsEnd: number; // offset just past '>'
}

/**
 * Find every Sig-dict /Contents paired with its nearest /ByteRange.
 * The Contents hex blob can never contain "/ByteRange" literally (its
 * charset is [0-9a-fA-F\s] only), so plain regex over the whole file
 * is safe. Slots are paired by proximity (same Sig dict ⇒ a few hundred
 * bytes apart).
 */
export function extractSignatureSlots(bytes: Uint8Array): RawSigSlot[] {
  const text = latin1(bytes);
  const slots: RawSigSlot[] = [];

  interface Br {
    pos: number;
    range: [number, number, number, number];
  }
  const brs: Br[] = [];
  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = brRe.exec(text)) !== null) {
    brs.push({
      pos: m.index,
      range: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
    });
  }

  const crRe = /\/Contents\s*<([0-9a-fA-F\s]*)>/g;
  while ((m = crRe.exec(text)) !== null) {
    const hexRaw = m[1];
    if (hexRaw.length < 16) continue; // not a CMS blob
    // Nearest ByteRange within 4000 chars.
    let best: Br | null = null;
    let bestDist = Infinity;
    const crPos = m.index;
    for (const br of brs) {
      const dist = Math.abs(br.pos - crPos);
      if (dist < bestDist) {
        bestDist = dist;
        best = br;
      }
    }
    if (!best || bestDist > 4000) continue;

    const hexStart = m.index + m[0].length - m[1].length - 1; // at '<'
    const hex = hexRaw.replace(/\s+/g, "");
    if (hex.length % 2 !== 0) continue;
    const derFull = new Uint8Array(hex.length / 2);
    for (let i = 0; i < derFull.length; i++) {
      derFull[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    // /Contents is zero-padded past the CMS DER (we pad with ASCII '0'
    // = 0x30; Acrobat and others typically pad with 0x00) — trim to the
    // first complete TLV so strict DER parsing succeeds.
    let der = derFull;
    try {
      const node = parseDerAt(derFull, 0);
      const rest = derFull.subarray(node.end);
      if (rest.length > 0 && rest.every((b) => b === 0x00 || b === 0x30)) {
        der = derFull.subarray(0, node.end);
      }
    } catch {
      /* keep the full blob — the parser will report the error */
    }
    slots.push({
      byteRange: best.range,
      contentsDer: der,
      contentsStart: hexStart,
      contentsEnd: hexStart + 1 + hexRaw.length + 1,
    });
  }
  return slots;
}

/* ------------------------------------------------------------------ */
/* CMS checks                                                          */
/* ------------------------------------------------------------------ */

function hashOf(oid: string): "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512" | null {
  if (oid === OID_SHA256) return "SHA-256";
  if (oid === OID_SHA384) return "SHA-384";
  if (oid === OID_SHA512) return "SHA-512";
  if (oid === OID_SHA1) return "SHA-1";
  return null;
}

async function verifyOneSigner(
  parsed: ParsedSignedData,
  si: ParsedSignerInfo,
  covered: Uint8Array,
  slot: RawSigSlot
): Promise<SignatureReport> {
  const checks: VerifyCheck[] = [];
  const report: SignatureReport = {
    byteRange: slot.byteRange,
    valid: false,
    signer: null,
    signingTime: si.signingTime ?? null,
    checks,
    documentIntact: false,
  };

  const hashName = hashOf(si.digestOid);
  if (!hashName) {
    checks.push({ id: "cms", status: "unknown", detail: `digest ${si.digestOid}` });
    return report;
  }
  checks.push({ id: "cms", status: "pass" });

  // 1. Document integrity: messageDigest === hash(covered).
  const coveredHash = await sha(hashName, covered);
  if (!si.messageDigest) {
    checks.push({ id: "digest", status: "fail", detail: "no messageDigest attribute" });
    return report;
  }
  const intact = toHex(coveredHash) === toHex(si.messageDigest);
  checks.push({ id: "digest", status: intact ? "pass" : "fail" });
  report.documentIntact = intact;
  if (!intact) return report;

  // 2. Signer cert.
  const signer = findSignerCert(parsed, si);
  if (!signer) {
    checks.push({ id: "cert-found", status: "fail", detail: "signer certificate not embedded" });
    return report;
  }
  report.signer = signer.info;
  checks.push({ id: "cert-found", status: "pass" });

  // 3. Signature over signedAttrs — re-tagged to SET (0x31).
  if (!si.signedAttrsDer) {
    checks.push({ id: "signature", status: "fail", detail: "no signed attributes" });
    return report;
  }
  // signedAttrsDer is the full [0] TLV; flipping the first byte to 0x31
  // turns it into the SET-OF form the signature actually covers (same
  // length encoding — only the tag differs).
  const setForm = new Uint8Array(si.signedAttrsDer);
  setForm[0] = 0x31;
  let sigOk = false;
  try {
    if (signer.info.keyKind === "rsa") {
      if (si.sigAlgOid !== "1.2.840.113549.1.1.1") {
        checks.push({ id: "signature", status: "unknown", detail: `alg ${si.sigAlgOid}` });
        return report;
      }
      const key = await crypto.subtle.importKey(
        "spki",
        signer.info.spkiDer as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: { name: hashName } },
        false,
        ["verify"]
      );
      sigOk = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        si.signature as BufferSource,
        setForm as BufferSource
      );
    } else if (signer.info.keyKind === "ecdsa-p256" || signer.info.keyKind === "ecdsa-p384") {
      const byteLen = signer.info.keyKind === "ecdsa-p384" ? 48 : 32;
      const curve = signer.info.keyKind === "ecdsa-p384" ? "P-384" : "P-256";
      const key = await crypto.subtle.importKey(
        "spki",
        signer.info.spkiDer as BufferSource,
        { name: "ECDSA", namedCurve: curve },
        false,
        ["verify"]
      );
      const raw = ecDerToRaw(si.signature, byteLen);
      sigOk = await crypto.subtle.verify(
        { name: "ECDSA", hash: { name: hashName } },
        key,
        raw as BufferSource,
        setForm as BufferSource
      );
    } else {
      checks.push({ id: "signature", status: "unknown", detail: signer.info.keyKind });
      return report;
    }
  } catch {
    checks.push({ id: "signature", status: "fail", detail: "verify threw" });
    return report;
  }
  checks.push({ id: "signature", status: sigOk ? "pass" : "fail" });
  if (!sigOk) return report;

  // 4. Cert validity at signing time (fallback: now).
  const at = si.signingTime ?? new Date();
  const inPeriod = at >= signer.info.notBefore && at <= signer.info.notAfter;
  checks.push({
    id: "cert-period",
    status: inPeriod ? "pass" : "fail",
    detail: inPeriod
      ? undefined
      : `valid ${signer.info.notBefore.toISOString().slice(0, 10)}–${signer.info.notAfter
          .toISOString()
          .slice(0, 10)}`,
  });

  // 5. Chain linkage through the embedded certificates.
  const others = parsed.certs
    .map((der) => {
      try {
        return parseCertificate(der);
      } catch {
        return null;
      }
    })
    .filter((c): c is X509Info => c !== null);
  const selfSigned = await (async () => {
    try {
      const r = await verifyCertIssuedBy(signer.info, signer.info);
      return r === true;
    } catch {
      return false;
    }
  })();
  if (selfSigned) {
    checks.push({ id: "self-signed", status: "pass", detail: "self-signed certificate" });
    checks.push({ id: "chain", status: "unknown", detail: "self-signed (no chain)" });
  } else if (others.length > 1) {
    let linked = false;
    for (const cand of others) {
      if (cand === signer.info) continue;
      const r = await verifyCertIssuedBy(signer.info, cand);
      if (r === true) {
        linked = true;
        break;
      }
    }
    checks.push({
      id: "chain",
      status: linked ? "pass" : "unknown",
      detail: linked ? "issued by an embedded certificate" : "issuer not embedded",
    });
  } else {
    checks.push({ id: "chain", status: "unknown", detail: "issuer certificate not embedded" });
  }

  report.valid =
    checks.every((c) => c.status !== "fail") &&
    checks.some((c) => c.id === "signature" && c.status === "pass");
  return report;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function verifyPdfSignatures(bytes: Uint8Array): Promise<VerifyPdfResult> {
  const slots = extractSignatureSlots(bytes);
  if (slots.length === 0) {
    return { found: [], hasSignature: false };
  }
  const found: SignatureReport[] = [];
  for (const slot of slots) {
    // Covered bytes per ByteRange: [0, o1) ++ [o2, o2 + l2).
    const [o1, l1, o2, l2] = slot.byteRange;
    if (o1 + l1 > bytes.length || o2 + l2 > bytes.length || o2 < o1 + l1) {
      found.push({
        byteRange: slot.byteRange,
        valid: false,
        signer: null,
        signingTime: null,
        checks: [{ id: "cms", status: "fail", detail: "ByteRange outside the file" }],
        documentIntact: false,
      });
      continue;
    }
    const covered = concat(
      bytes.subarray(o1, o1 + l1),
      bytes.subarray(o2, o2 + l2)
    );
    try {
      const parsed = parseSignedDataDer(slot.contentsDer);
      for (const si of parsed.signerInfos) {
        found.push(await verifyOneSigner(parsed, si, covered, slot));
      }
    } catch {
      found.push({
        byteRange: slot.byteRange,
        valid: false,
        signer: null,
        signingTime: null,
        checks: [{ id: "cms", status: "fail", detail: "CMS parse error" }],
        documentIntact: false,
      });
    }
  }
  return { found, hasSignature: found.length > 0 };
}

/** Re-exported for the verify worker's cert-details card. */
export { parseCertificate, certSerial };
