/**
 * pki-common/cms — CMS (PKCS#7) SignedData, detached variant.
 *
 * Builder produces an Adobe-compatible "adbe.pkcs7.detached" payload:
 *
 *   SignedData ::= SEQUENCE {
 *     version INTEGER(1),
 *     digestAlgorithms SET OF AlgorithmIdentifier,
 *     encapContentInfo SEQUENCE { OID id-data },          -- detached: no eContent
 *     certificates [0] IMPLICIT CertificateSet,           -- signer + chain
 *     signerInfos SET OF SignerInfo }
 *
 *   SignerInfo ::= SEQUENCE {
 *     version INTEGER(1),
 *     sid IssuerAndSerialNumber,
 *     digestAlgorithm AlgorithmIdentifier,
 *     signedAttrs [0] IMPLICIT SignedAttributes,
 *     signatureAlgorithm AlgorithmIdentifier,
 *     signature OCTET STRING }
 *
 * signedAttrs = contentType + signingTime + messageDigest +
 * signingCertificateV2 (ESSCertIDv2, SHA-256) — the set Adobe Reader and
 * every EU e-signature validator expects. The signature is computed over
 * the SET-OF encoding (tag 0x31) while embedding uses the context tag
 * 0xA0 — THE classic CMS gotcha, handled exactly once here.
 *
 * Parser returns the same structure back for the verifier side.
 */

import {
  TAG,
  parseDer,
  parseDerAt,
  parseChildren,
  readOid,
  readOctets,
  readBigInt,
  readTime,
  derSeq,
  derSet,
  derCtx,
  derInt,
  derIntBytes,
  derNull,
  derOctets,
  derOid,
  derUtctime,
  ecRawToDer,
  sha,
  tlv,
  toHex,
  type DerNode,
} from "./asn1";
import { parseCertificate, type X509Info } from "./x509";
import type { P12Contents } from "./p12";

export const OID_DATA = "1.2.840.113549.1.7.1";
export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
export const OID_SHA512 = "2.16.840.1.101.3.4.2.3";
export const OID_SHA1 = "1.3.14.3.2.26";
export const OID_RSA_ENC = "1.2.840.113549.1.1.1";
export const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
export const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";
export const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
export const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
export const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
export const OID_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47";

export interface CmsSignOptions {
  /** Freeze the signing time (tests); default now. */
  signingTime?: Date;
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

function attr(oid: string, ...values: Uint8Array[]): Uint8Array {
  return derSeq(derOid(oid), derSet(...values));
}

/** SHA-256 over the whole buffer + serial BigInt comparison helper. */
export function certSerial(cert: X509Info): bigint {
  let v = BigInt(0);
  for (const b of cert.serialBytes) v = (v << BigInt(8)) | BigInt(b);
  return v;
}

/**
 * Build a detached SignedData over `content` (the covered PDF bytes) and
 * return its DER. SHA-256 digests only. RSA (PKCS#1 v1.5) and ECDSA
 * P-256/P-384 keys are signable via WebCrypto.
 */
export async function buildDetachedSignedData(
  content: Uint8Array,
  signer: P12Contents,
  opts: CmsSignOptions = {}
): Promise<Uint8Array> {
  const cert = parseCertificate(signer.certDer);
  const when = opts.signingTime ?? new Date();
  const digest = await sha("SHA-256", content);
  const certHash = await sha("SHA-256", signer.certDer);

  // --- signed attributes ---
  // signingCertificateV2 ::= SEQUENCE { SEQUENCE { ESSCertIDv2 } }
  // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm?, certHash, issuerSerial? }
  const essCertId = derSeq(
    derSeq(derOid(OID_SHA256), derNull()),
    derOctets(certHash),
    derSeq(derCtx(0x84, cert.issuerDer), derIntBytes(cert.serialBytes))
  );
  const signingCertV2 = derSeq(essCertId);

  // DER SET OF requires ascending order of the full encodings; comparing
  // the attribute OIDs gives: contentType (…9.3) < messageDigest (…9.4) <
  // signingTime (…9.5) < signingCertificateV2 (…9.16.2.47).
  const attrs = [
    attr(OID_CONTENT_TYPE, derOid(OID_DATA)),
    attr(OID_MESSAGE_DIGEST, derOctets(digest)),
    attr(OID_SIGNING_TIME, derUtctime(when)),
    attr(OID_SIGNING_CERT_V2, signingCertV2),
  ];

  // SET OF (0x31) encoding — this is the byte string the signature covers.
  const attrsAsSet = derSet(...attrs);
  // Embedded form: same attribute TLVs, tag [0] IMPLICIT (0xA0).
  const attrsEmbedded = tlv(TAG.CTX_0, ...attrs);

  // --- key import + signature ---
  const key = await importPkcs8(signer.keyPkcs8, cert.keyKind);
  let signature: Uint8Array;
  let sigAlgOid: string;
  if (cert.keyKind === "rsa") {
    sigAlgOid = OID_RSA_ENC;
    const raw = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      attrsAsSet as BufferSource
    );
    signature = new Uint8Array(raw);
  } else if (cert.keyKind === "ecdsa-p256" || cert.keyKind === "ecdsa-p384") {
    sigAlgOid = OID_ECDSA_SHA256;
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        key,
        attrsAsSet as BufferSource
      )
    );
    signature = ecRawToDer(raw);
  } else {
    throw new Error(`cms: cannot sign with key kind ${cert.keyKind}`);
  }

  // --- SignerInfo ---
  const signerInfo = derSeq(
    derInt(1),
    derSeq(cert.issuerDer, derIntBytes(cert.serialBytes)),
    derSeq(derOid(OID_SHA256), derNull()),
    attrsEmbedded,
    derSeq(derOid(sigAlgOid), ...(sigAlgOid === OID_RSA_ENC ? [derNull()] : [])),
    derOctets(signature)
  );

  // --- SignedData (detached) ---
  const allCerts = [signer.certDer, ...signer.chainCerts];
  const signedData = derSeq(
    derInt(1),
    derSet(derSeq(derOid(OID_SHA256), derNull())),
    derSeq(derOid(OID_DATA)),
    tlv(TAG.CTX_0, ...allCerts),
    derSet(signerInfo)
  );

  return signedData;
}

/** Wrap as ContentInfo (the bytes that go into /Contents). */
export async function buildDetachedContentInfo(
  content: Uint8Array,
  signer: P12Contents,
  opts: CmsSignOptions = {}
): Promise<Uint8Array> {
  const sd = await buildDetachedSignedData(content, signer, opts);
  return derSeq(derOid(OID_SIGNED_DATA), derCtx(TAG.CTX_0, sd));
}

async function importPkcs8(pkcs8: Uint8Array, kind: X509Info["keyKind"]): Promise<CryptoKey> {
  if (kind === "rsa") {
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      false,
      ["sign"]
    );
  }
  if (kind === "ecdsa-p256") {
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  }
  if (kind === "ecdsa-p384") {
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign"]
    );
  }
  throw new Error(`cms: unsupported private key kind ${kind}`);
}

/* ------------------------------------------------------------------ */
/* Parser (verify side)                                                */
/* ------------------------------------------------------------------ */

export interface ParsedSignerInfo {
  serial: bigint | null;
  issuerDer: Uint8Array | null;
  digestOid: string;
  signedAttrsDer: Uint8Array | null; // tag 0xA0 embedded form
  sigAlgOid: string;
  signature: Uint8Array;
  /** Flattened signed attribute values. */
  contentType?: string;
  signingTime?: Date;
  messageDigest?: Uint8Array;
}

export interface ParsedSignedData {
  /** Certificate DERs from the certificates [0] set. */
  certs: Uint8Array[];
  signerInfos: ParsedSignerInfo[];
}

/** Parse a ContentInfo-wrapped or bare SignedData DER. */
export function parseSignedDataDer(der: Uint8Array): ParsedSignedData {
  const top = parseDer(der);
  let sd: DerNode;
  if (top.tag === TAG.SEQUENCE) {
    const kids = parseChildren(top);
    if (kids.length === 2 && kids[0].tag === TAG.OID && readOid(kids[0]) === OID_SIGNED_DATA) {
      sd = parseChildren(kids[1])[0];
    } else {
      sd = top; // bare SignedData
    }
  } else {
    throw new Error("cms: not a SignedData");
  }

  const sdKids = parseChildren(sd);
  const certs: Uint8Array[] = [];
  const signerInfos: ParsedSignerInfo[] = [];
  for (const kid of sdKids) {
    if (kid.tag === TAG.CTX_0 && kid !== sdKids[sdKids.length - 1]) {
      // certificates [0] IMPLICIT CertificateSet — certs concatenated
      let pos = 0;
      while (pos < kid.value.length) {
        const n = parseDerAt(kid.value, pos);
        certs.push(tlv(n.tag, n.value));
        pos = n.end;
      }
    }
  }
  const last = sdKids[sdKids.length - 1];
  if (last.tag === TAG.SET) {
    for (const siNode of parseChildren(last)) {
      signerInfos.push(parseSignerInfo(siNode));
    }
  }
  return { certs, signerInfos };
}

function parseSignerInfo(node: DerNode): ParsedSignerInfo {
  const kids = parseChildren(node);
  const info: ParsedSignerInfo = {
    serial: null,
    issuerDer: null,
    digestOid: "",
    signedAttrsDer: null,
    sigAlgOid: "",
    signature: new Uint8Array(0),
  };

  let i = 1; // skip version
  // sid: IssuerAndSerialNumber (SEQ) or [0] subjectKeyIdentifier (prim).
  const sid = kids[i];
  if (sid.tag === TAG.SEQUENCE) {
    const s = parseChildren(sid);
    if (s.length === 2 && s[1].tag === TAG.INTEGER) {
      info.issuerDer = tlv(TAG.SEQUENCE, s[0].value);
      info.serial = readBigInt(s[1]);
    }
  } else if (sid.tag === TAG.CTX_0_PRIM) {
    info.serial = null; // SKI variant — cert matched by position
  }
  i++;

  // digestAlgorithm
  info.digestOid = readOid(parseChildren(kids[i])[0]);
  i++;

  // optional signedAttrs [0] IMPLICIT (0xA0)
  if (i < kids.length && kids[i].tag === TAG.CTX_0) {
    const ctx = kids[i];
    info.signedAttrsDer = tlv(TAG.CTX_0, ctx.value);
    let pos = 0;
    while (pos < ctx.value.length) {
      try {
        const attrNode = parseDerAt(ctx.value, pos);
        const ak = parseChildren(attrNode);
        const oid = readOid(ak[0]);
        const vals = parseChildren(ak[1]);
        if (oid === OID_CONTENT_TYPE && vals[0]?.tag === TAG.OID) {
          info.contentType = readOid(vals[0]);
        } else if (oid === OID_SIGNING_TIME && vals[0]) {
          try {
            info.signingTime = readTime(vals[0]);
          } catch {
            /* non-standard time value */
          }
        } else if (oid === OID_MESSAGE_DIGEST && vals[0]?.tag === TAG.OCTET_STRING) {
          info.messageDigest = readOctets(vals[0]);
        }
        pos = attrNode.end;
      } catch {
        break;
      }
    }
    i++;
  }

  // signatureAlgorithm
  info.sigAlgOid = readOid(parseChildren(kids[i])[0]);
  i++;

  // signature OCTET STRING
  if (i < kids.length && kids[i].tag === TAG.OCTET_STRING) {
    info.signature = kids[i].value;
  }
  return info;
}

/** Find the signer's cert by issuer+serial among parsed certs. */
export function findSignerCert(
  parsed: ParsedSignedData,
  si: ParsedSignerInfo
): { der: Uint8Array; info: X509Info } | null {
  if (si.serial === null) return null;
  for (const der of parsed.certs) {
    try {
      const info = parseCertificate(der);
      if (certSerial(info) === si.serial) {
        return { der, info };
      }
    } catch {
      /* unparsable cert — skip */
    }
  }
  return null;
}
