/**
 * pki-common/x509 — read-only X.509 certificate support.
 *
 * Parses the TBSCertificate fields PDF signing/verification UIs actually
 * show (subject/issuer DNs, serial, validity, SPKI, key usages) and adds
 * real chain-linkage verification: cert A's signature checked against
 * candidate-issuer B's public key via WebCrypto. No revocation, no
 * system trust store — the UI reports that honestly.
 */

import {
  TAG,
  parseDer,
  parseChildren,
  parseDerAt,
  readOid,
  readBitString,
  readBool,
  readString,
  readTime,
  ecDerToRaw,
  toHex,
  tlv,
  type DerNode,
} from "./asn1";

export interface X509Name {
  CN?: string;
  O?: string;
  OU?: string;
  C?: string;
  L?: string;
  ST?: string;
  email?: string;
  /** "CN=…, O=…" display form (RFC 2253-ish, in stored order). */
  display: string;
}

export type PubKeyKind = "rsa" | "ecdsa-p256" | "ecdsa-p384" | "ed25519" | "other";

export interface X509Info {
  subject: X509Name;
  issuer: X509Name;
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
  /** Full SubjectPublicKeyInfo DER (ready for WebCrypto "spki" import). */
  spkiDer: Uint8Array;
  keyKind: PubKeyKind;
  /** Signature algorithm OID of the cert itself (display only). */
  sigAlgOid: string;
  isCA: boolean;
  keyUsage: string[];
  extKeyUsage: string[];
  hasSKI: boolean;
  hasAKI: boolean;
  /** Issuer Name DER (for CMS SignerIdentifier issuerAndSerialNumber). */
  issuerDer: Uint8Array;
  /** Serial bytes, DER INTEGER value form. */
  serialBytes: Uint8Array;
  /** Node kept for signature verification over tbsCertificate. */
  tbsNode: DerNode;
  tbsDer: Uint8Array;
  /** Signature BIT STRING (raw) of the cert. */
  signature: Uint8Array;
}

const DN_OIDS: Record<string, keyof X509Name> = {
  "2.5.4.3": "CN",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "1.2.840.113549.1.9.1": "email",
};

function parseName(node: DerNode): X509Name {
  const out: X509Name = { display: "" };
  const parts: string[] = [];
  for (const rdn of parseChildren(node)) {
    for (const atv of parseChildren(rdn)) {
      const kids = parseChildren(atv);
      if (kids.length !== 2) continue;
      let oid: string;
      try {
        oid = readOid(kids[0]);
      } catch {
        continue;
      }
      let value = "";
      try {
        value = readString(kids[1]);
      } catch {
        continue;
      }
      const key = DN_OIDS[oid];
      if (key && !(out[key] as string | undefined)) {
        (out as unknown as Record<string, string | undefined>)[key] = value;
        parts.push(`${key}=${value}`);
      }
    }
  }
  out.display = parts.join(", ");
  return out;
}

const KU_NAMES: Array<{ bit: number; name: string }> = [
  { bit: 0x80, name: "digitalSignature" },
  { bit: 0x40, name: "nonRepudiation" },
  { bit: 0x20, name: "keyEncipherment" },
  { bit: 0x10, name: "dataEncipherment" },
  { bit: 0x08, name: "keyAgreement" },
  { bit: 0x04, name: "keyCertSign" },
  { bit: 0x02, name: "cRLSign" },
];

const EKU_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.8": "timeStamping",
  "1.3.6.1.5.5.7.3.9": "OCSPSigning",
  "2.5.29.37.0": "anyExtendedKeyUsage",
  "1.2.840.113583.1.1.5": "adobeAuthenticDocumentsTrust",
};

/** Parse a DER certificate; throws on structural failure. */
export function parseCertificate(der: Uint8Array): X509Info {
  const cert = parseDer(der);
  if (cert.tag !== TAG.SEQUENCE) throw new Error("x509: not a SEQUENCE");
  const outer = parseChildren(cert);
  if (outer.length !== 3) throw new Error("x509: bad Certificate");
  const tbs = outer[0];
  const sigAlg = parseChildren(outer[1]);
  const signature = readBitString(outer[2]);

  const tbsKids = parseChildren(tbs);
  let idx = 0;
  if (tbsKids[idx].tag === TAG.CTX_0) {
    idx++; // version [0] EXPLICIT — skipped (v1 assumed otherwise)
  }
  const serialIdx = idx;
  const serialHex = toHex(tbsKids[idx].value).replace(/^0+(?=.)/, "");
  idx++; // serialNumber
  const sigAlgOid = readOid(parseChildren(tbsKids[idx])[0]);
  idx++; // signature algo
  const issuer = parseName(tbsKids[idx]);
  const issuerDer = tlv(TAG.SEQUENCE, tbsKids[idx].value);
  idx++;
  const validity = parseChildren(tbsKids[idx]);
  const notBefore = readTime(validity[0]);
  const notAfter = readTime(validity[1]);
  idx++;
  const subject = parseName(tbsKids[idx]);
  idx++;
  const spki = tbsKids[idx];
  // SubjectPublicKeyInfo ::= SEQ { AlgorithmIdentifier SEQ, BIT STRING }
  const spkiAlgSeq = parseChildren(spki)[0];
  const spkiAlgKids = parseChildren(spkiAlgSeq);
  const spkiAlg = readOid(spkiAlgKids[0]);
  idx++;
  let isCA = false;
  let keyUsage: string[] = [];
  let extKeyUsage: string[] = [];
  let hasSKI = false;
  let hasAKI = false;
  for (; idx < tbsKids.length; idx++) {
    const n = tbsKids[idx];
    if (n.tag === TAG.CTX_3) {
      // extensions [3] EXPLICIT
      const extSeq = parseChildren(n)[0];
      for (const ext of parseChildren(extSeq)) {
        try {
          const ek = parseChildren(ext);
          const extOid = readOid(ek[0]);
          const vIdx = ek.length - 1; // value is last (after optional BOOLEAN)
          const isBasic = extOid === "2.5.29.19";
          const isKU = extOid === "2.5.29.15";
          const isEKU = extOid === "2.5.29.37";
          const isSKI = extOid === "2.5.29.14";
          const isAKI = extOid === "2.5.29.35";
          if (isBasic && ek[vIdx].tag === TAG.OCTET_STRING) {
            const bc = parseChildren(parseDer(ek[vIdx].value));
            if (bc.length > 0 && bc[0].tag === TAG.BOOLEAN) isCA = readBool(bc[0]);
          } else if (isKU && ek[vIdx].tag === TAG.OCTET_STRING) {
            const ku = parseDer(ek[vIdx].value); // BIT STRING
            const bits = ku.value.length > 1 ? ku.value.subarray(1) : new Uint8Array();
            for (const entry of KU_NAMES) {
              if (bits.length > 0 && (bits[0] & entry.bit) !== 0) keyUsage.push(entry.name);
            }
          } else if (isEKU && ek[vIdx].tag === TAG.OCTET_STRING) {
            for (const oid of parseChildren(parseDer(ek[vIdx].value))) {
              try {
                extKeyUsage.push(EKU_NAMES[readOid(oid)] ?? readOid(oid));
              } catch {
                /* non-OID EKU entry — skip */
              }
            }
          } else if (isSKI) {
            hasSKI = true;
          } else if (isAKI) {
            hasAKI = true;
          }
        } catch {
          /* one unreadable extension never blocks the rest */
        }
      }
    }
  }

  // Public key kind from the SPKI algorithm OID.
  let keyKind: PubKeyKind = "other";
  if (spkiAlg === "1.2.840.113549.1.1.1") keyKind = "rsa";
  else if (spkiAlg === "1.2.840.10045.2.1") {
    // EC — the parameters hold the named-curve OID directly.
    try {
      const curve = readOid(spkiAlgKids[1]);
      if (curve === "1.2.840.10045.3.1.7") keyKind = "ecdsa-p256";
      else if (curve === "1.3.132.0.34") keyKind = "ecdsa-p384";
    } catch {
      /* curve OID missing — stay "other" */
    }
  } else if (spkiAlg === "1.3.101.112") keyKind = "ed25519";

  return {
    subject,
    issuer,
    serialHex,
    notBefore,
    notAfter,
    spkiDer: tlv(TAG.SEQUENCE, spki.value),
    keyKind,
    sigAlgOid,
    isCA,
    keyUsage,
    extKeyUsage,
    hasSKI,
    hasAKI,
    issuerDer,
    serialBytes: tbsKids[serialIdx].value,
    tbsNode: tbs,
    tbsDer: tlv(TAG.SEQUENCE, tbs.value),
    signature,
  };
}

/* ------------------------------------------------------------------ */
/* Chain linkage                                                       */
/* ------------------------------------------------------------------ */

/**
 * Does `candidate` actually verify the signature over `cert`'s
 * TBSCertificate? Returns true/false, or null when the combination of
 * key/signature algorithms is one we cannot check with WebCrypto.
 */
export async function verifyCertIssuedBy(
  cert: X509Info,
  candidate: X509Info
): Promise<boolean | null> {
  const importable =
    (candidate.keyKind === "rsa" &&
      (cert.sigAlgOid === "1.2.840.113549.1.1.11" /* sha256WithRSA */ ||
        cert.sigAlgOid === "1.2.840.113549.1.1.12" /* sha384 */ ||
        cert.sigAlgOid === "1.2.840.113549.1.1.13" /* sha512 */)) ||
    (candidate.keyKind === "ecdsa-p256" && cert.sigAlgOid === "1.2.840.10045.4.3.2") ||
    (candidate.keyKind === "ecdsa-p384" && cert.sigAlgOid === "1.2.840.10045.4.3.3");
  if (!importable) return null;

  try {
    if (candidate.keyKind === "rsa") {
      const hash =
        cert.sigAlgOid === "1.2.840.113549.1.1.12"
          ? "SHA-384"
          : cert.sigAlgOid === "1.2.840.113549.1.1.13"
            ? "SHA-512"
            : "SHA-256";
      const key = await crypto.subtle.importKey(
        "spki",
        candidate.spkiDer as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: { name: hash } },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        cert.signature as BufferSource,
        cert.tbsDer as BufferSource
      );
    }
    const curve = candidate.keyKind === "ecdsa-p384" ? "P-384" : "P-256";
    const hash = candidate.keyKind === "ecdsa-p384" ? "SHA-384" : "SHA-256";
    const byteLen = candidate.keyKind === "ecdsa-p384" ? 48 : 32;
    const key = await crypto.subtle.importKey(
      "spki",
      candidate.spkiDer as BufferSource,
      { name: "ECDSA", namedCurve: curve },
      false,
      ["verify"]
    );
    // Cert signatures are DER SEQUENCE{r,s}; WebCrypto wants raw r||s.
    const rawSig = ecDerToRaw(cert.signature, byteLen);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: { name: hash } },
      key,
      rawSig as BufferSource,
      cert.tbsDer as BufferSource
    );
  } catch {
    return null;
  }
}

/** Self-signed check: subject == issuer AND the cert verifies against itself. */
export async function isSelfSigned(cert: X509Info): Promise<boolean | null> {
  if (cert.subject.display !== cert.issuer.display) return false;
  return verifyCertIssuedBy(cert, cert);
}

/** Serial as bigint (for matching CMS SignerIdentifier sid). */
export function serialBigInt(cert: X509Info): bigint {
  let v = BigInt(0);
  for (const b of cert.serialBytes) v = (v << BigInt(8)) | BigInt(b);
  return v;
}

/** Convenience re-parse used by verify flows (never throws on serials). */
export { parseDerAt };
