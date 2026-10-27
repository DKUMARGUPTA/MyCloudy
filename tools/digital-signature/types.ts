/**
 * Digital signature (RB6-a) — types + honest error taxonomy.
 *
 * Certificate-based PAdES signing with the user's .pfx/.p12 file, 100%
 * on-device in a Web Worker: hand-rolled PKCS#12 parsing (the modern
 * OpenSSL 3 default: PBES2 + PBKDF2 + AES-CBC), a hand-rolled CMS
 * SignedData (adbe.pkcs7.detached) writer, and the @cantoo/pdf-lib
 * incremental-update placeholder pattern (README "signature
 * placeholder" example) with byte-identical post-save patching.
 *
 * HONEST SCOPE (stated in the FAQ, mirrored here so no layer drifts):
 * - RSA + SHA-256 + adbe.pkcs7.detached (the primary path).
 * - ECDSA keys also sign when WebCrypto supports the curve (P-256/384/521).
 * - NO RFC 3161 timestamp token (a TSA needs the network — this tool is
 *   offline by design), NO LTV/DSS/OCSP embedding, NO revocation checks.
 * - Validation depends on the reader's trust in the certificate.
 *   Self-signed certs show "validity unknown" in Acrobat — expected; the
 *   document-integrity protection is real (any byte change breaks the
 *   digest).
 */

/* ------------------------------------------------------------------ */
/* Run options (worker surface → worker)                                */
/* ------------------------------------------------------------------ */

/** Corner presets for the visible signature box (custom = offsets). */
export type DsigCorner = "tl" | "tr" | "bl" | "br";

/** PDF user-space rect (points, origin bottom-left). */
export interface DsigRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunOptions {
  /** /Reason + the CMS signing-context text ("" = omitted). */
  reason: string;
  /** /Location ("" = omitted). */
  location: string;
  /** 0-based page index the signature field lands on. */
  pageIndex: number;
  /** Draw the visible signature box (field + AP). */
  showVisual: boolean;
  /** Corner preset for the box. */
  corner: DsigCorner;
  /** Offset from the page edge, PDF points (x and y of the corner). */
  marginX: number;
  marginY: number;
  /** Visual box width in points (height derives from the line count). */
  visualWidth: number;
}

/* ------------------------------------------------------------------ */
/* Parsed PKCS#12 (model output, pre-decryption)                       */
/* ------------------------------------------------------------------ */

/** Modern OpenSSL 3 default encryption (the only one we decrypt). */
export interface Pbes2Scheme {
  kind: "pbes2";
  prf: "sha1" | "sha256";
  salt: Uint8Array;
  iterations: number;
  cipher: "aes128" | "aes192" | "aes256";
  iv: Uint8Array;
}

/** Legacy ciphers we refuse honestly (RC2/3DES/RC4/DES — or PBES1). */
export interface LegacyScheme {
  kind: "legacy";
  /** PBES2 wrapping a legacy cipher vs the PBES1 family directly. */
  insidePbes2: boolean;
  cipher: "rc2" | "rc4" | "des" | "desede3" | "pbes1" | "unknown";
}

export type EncryptionScheme = Pbes2Scheme | LegacyScheme;

export interface ShroudedKeyBag {
  kind: "shroudedKey";
  /** EncryptedPrivateKeyInfo algorithm. */
  scheme: EncryptionScheme;
  /** EncryptedPrivateKeyInfo's encryptedData (encrypted PKCS#8). */
  encrypted: Uint8Array;
  localKeyId: Uint8Array | null;
}

export interface PlainKeyBag {
  kind: "key";
  /** Unencrypted PKCS#8 PrivateKeyInfo DER. */
  pkcs8: Uint8Array;
  localKeyId: Uint8Array | null;
}

export interface CertBag {
  kind: "cert";
  /** X.509 Certificate DER. */
  certDer: Uint8Array;
  localKeyId: Uint8Array | null;
}

export interface OtherBag {
  kind: "other";
  bagOid: string;
}

export type SafeBag = ShroudedKeyBag | PlainKeyBag | CertBag | OtherBag;

/** One AuthenticatedSafe ContentInfo: plain or whole-layer encrypted. */
export type SafeContentsLayer =
  | { kind: "plain"; bags: SafeBag[] }
  | { kind: "encrypted"; scheme: EncryptionScheme; encrypted: Uint8Array };

export interface ParsedP12 {
  layers: SafeContentsLayer[];
}

/** Decrypted end state: the leaf cert + its private key. */
export interface DecryptedP12 {
  certDer: Uint8Array;
  keyPkcs8: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* Certificate metadata (pure DER walk — UI + CMS signer id)           */
/* ------------------------------------------------------------------ */

export interface CertInfo {
  subjectCn: string;
  issuerCn: string;
  serialHex: string;
  /** ISO yyyy-mm-ddThh:mm:ssZ (DER UTCTime/GeneralizedTime decoded). */
  notBefore: string;
  notAfter: string;
  keyType: "rsa" | "ec";
  /** EC curve OID (dotted) when keyType is ec. */
  curveOid: string | null;
  /** Raw issuer Name DER (feeds issuerAndSerialNumber verbatim). */
  issuerDer: Uint8Array;
  serialBytes: Uint8Array;
  /** SubjectPublicKeyInfo DER (WebCrypto import for verification). */
  spkiDer: Uint8Array;
  validNow: boolean;
}

/* ------------------------------------------------------------------ */
/* Sign result (worker output detail)                                   */
/* ------------------------------------------------------------------ */

export interface SignResult {
  /** Signer common name (from the certificate subject). */
  signerCn: string;
  issuerCn: string;
  certSerialHex: string;
  notBefore: string;
  notAfter: string;
  reason: string;
  location: string;
  /** Always adbe.pkcs7.detached in this tool. */
  subfilter: "adbe.pkcs7.detached";
  keyType: "rsa" | "ec";
  digestAlgo: "SHA-256";
  /** The final /ByteRange written into the signature dictionary. */
  byteRange: [number, number, number, number];
  /** SHA-256 hex of the covered byte ranges (== CMS messageDigest). */
  coveredDigestHex: string;
  /** ISO signing time (also the /M + CMS signingTime). */
  signedAt: string;
  /** CMS SignedData size in bytes (inside /Contents, before padding). */
  cmsLength: number;
  /** True when the signature was appended as an incremental update. */
  incremental: boolean;
  /** Honest: no RFC 3161 timestamp token is embedded. */
  hasTimestamp: false;
  pageCount: number;
  beforeBytes: number;
  afterBytes: number;
}

/* ------------------------------------------------------------------ */
/* Error taxonomy (codes are i18n keys)                                 */
/* ------------------------------------------------------------------ */

export const DSIG_ERRORS = {
  badPassword: "dsig.errBadPassword",
  legacyEncryption: "dsig.errLegacyEncryption",
  notP12: "dsig.errNotP12",
  corruptP12: "dsig.errCorruptP12",
  unsupportedKey: "dsig.errUnsupportedKey",
  encryptedPdf: "tool.errorEncrypted",
  corruptPdf: "tool.errorCorrupt",
  tooLarge: "dsig.errTooLarge",
  generic: "tool.errorGeneric",
} as const;

/** Parse/decrypt failures carry their honest code + optional detail. */
export class DsigError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DsigError";
    this.code = code;
    this.detail = detail;
  }
}
