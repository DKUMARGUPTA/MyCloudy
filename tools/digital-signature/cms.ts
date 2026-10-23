/**
 * CMS (RFC 5652) SignedData builder — detached, SHA-256, RSA PKCS#1 v1.5
 * (digital-signature, RB6-FIN-a3).
 *
 * This is exactly the structure PAdES / adbe.pkcs7.detached signatures
 * carry inside the /Contents of a PDF signature dictionary:
 *
 *   ContentInfo {
 *     contentType  id-signedData (1.2.840.113549.1.7.2),
 *     content     [0] SignedData {
 *       version           1,
 *       digestAlgorithms  { sha256 },
 *       encapContentInfo  { data }   (eContent ABSENT — the PDF bytes
 *                                     covered by /ByteRange are the
 *                                     content; detached by design),
 *       certificates      [0] { the DER of the signing certificate },
 *       signerInfos       { SignerInfo {
 *         version            1,
 *         sid                IssuerAndSerialNumber (pkcs12.ts, byte-exact
 *                            issuer copy so the cert chains to itself),
 *         digestAlgorithm   sha256,
 *         signedAttrs       [0] { contentType=data,
 *                                 messageDigest=<ByteRange digest>,
 *                                 signingTime=<now, UTCTime> },
 *         signatureAlgorithm rsaEncryption (NOT rsaSigning — the classic
 *                            PKCS#1 v1.5 with NULL params every verifier
 *                            and Acrobat accept),
 *         signature         OCTET STRING
 *       } }
 *     } }
 *   }
 *
 * The signature is computed over the signedAttrs DER with the [0] IMPLICIT
 * tag (0xA0) re-tagged to SET OF (0x31) — RFC 5652 §5.4 — via WebCrypto's
 * RSASSA-PKCS1-v1_5 (available in every worker AND in bun/node smokes).
 *
 * Pure TypeScript on the asn1.ts writer; no DOM, no network, worker-safe.
 */

import {
  concat,
  derCtx,
  derInt,
  derNull,
  derOctets,
  derOid,
  derSeq,
  derSet,
  derTime,
  derTlv,
  hexOf,
} from "./asn1";
import { issuerAndSerial } from "./pkcs12";

/* ------------------------------------------------------------------ */
/* OIDs                                                                */
/* ------------------------------------------------------------------ */

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_DATA = "1.2.840.113549.1.7.1";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_ATTR_SIGNING_TIME = "1.2.840.113549.1.9.5";

/* ------------------------------------------------------------------ */
/* The builder                                                          */
/* ------------------------------------------------------------------ */

export interface CmsSignInput {
  /** RSA PKCS#8 DER (parsePkcs12's output, checked RSA by checkRsaPkcs8). */
  pkcs8: Uint8Array;
  /** The signing certificate DER (parsePkcs12's certDer). */
  certDer: Uint8Array;
  /** SHA-256 digest of the PDF bytes the /ByteRange covers. */
  digest: Uint8Array;
  /** Signing time (CMS signingTime attribute + the result card). */
  signingTime: Date;
}

export interface CmsBuilt {
  /** The full ContentInfo DER (what lands inside /Contents). */
  der: Uint8Array;
  /** The signedAttrs DER exactly as signed (0xA0 tag) — verifiers re-tag
   * it to 0x31 before checking; exposed for the smoke + verify tools. */
  signedAttrsDer: Uint8Array;
  /** The same bytes with the SET-OF tag — the data the RSA key signed. */
  retaggedAttrsDer: Uint8Array;
}

/**
 * Builds the detached SignedData. Throws (honestly) when WebCrypto is
 * missing or the key rejects — the worker maps to ds.errSignFailed.
 */
export async function buildDetachedSignedData(
  input: CmsSignInput
): Promise<CmsBuilt> {
  const api = globalThis.crypto?.subtle;
  if (api === undefined) {
    throw new Error("cms: WebCrypto unavailable");
  }

  // signedAttrs: contentType, messageDigest, signingTime (RFC 5652 §11).
  const signedAttrs = derCtx(
    0,
    concat([
      derSeq(
        derOid(OID_ATTR_CONTENT_TYPE),
        derSet(derOid(OID_DATA))
      ),
      derSeq(
        derOid(OID_ATTR_MESSAGE_DIGEST),
        derSet(derOctets(input.digest))
      ),
      derSeq(
        derOid(OID_ATTR_SIGNING_TIME),
        derSet(derTime(input.signingTime))
      ),
    ])
  );
  // The DER the signature covers: same bytes, SET-OF (0x31) tag.
  const retagged = signedAttrs.slice();
  retagged[0] = 0x31;

  const key = await api.importKey(
    "pkcs8",
    input.pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await api.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      retagged as unknown as ArrayBuffer
    )
  );

  const signerInfo = derSeq(
    derInt(1), // version
    issuerAndSerial(input.certDer), // sid
    derSeq(derOid(OID_SHA256), derNull()), // digestAlgorithm
    signedAttrs, // [0] IMPLICIT SET OF — the 0xA0-tagged form
    derSeq(derOid(OID_RSA_ENCRYPTION), derNull()), // signatureAlgorithm
    derOctets(signature) // signature
  );

  const signedData = derSeq(
    derInt(1), // version
    derSet(derSeq(derOid(OID_SHA256))), // digestAlgorithms
    derSeq(derOid(OID_DATA)), // encapContentInfo (detached)
    derCtx(0, input.certDer), // certificates [0] IMPLICIT
    derSet(signerInfo) // signerInfos
  );

  const contentInfo = derSeq(
    derOid(OID_SIGNED_DATA),
    derCtx(0, signedData)
  );

  return {
    der: contentInfo,
    signedAttrsDer: signedAttrs,
    retaggedAttrsDer: retagged,
  };
}

/** Hex encoding for the /Contents splice (uppercase, PDF-conventional). */
export function cmsHex(der: Uint8Array): string {
  return hexOf(der).toUpperCase();
}

/** Minimal reader helpers for tests + the verify family (re-export). */
export { derTlv as cmsDerTlv };
