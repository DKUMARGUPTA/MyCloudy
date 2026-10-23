import type { RunDetail } from "@/lib/workers/protocol";

/**
 * Verify PDF signatures (RB6) — types only, no logic.
 *
 * The honest contract (mirrored in the FAQ + the report footer): this tool
 * reads the RAW PDF bytes, walks xref/trailer (with a linear object-scan
 * recovery for slightly broken files — repair-pdf precedent), finds
 * /AcroForm fields with /FT /Sig, parses their /V signature dictionaries
 * and the CMS (PKCS#7 SignedData) inside /Contents with a minimal DER/ASN.1
 * reader, then:
 *
 *  - recomputes the digest over the exact /ByteRange bytes and compares it
 *    with the signedAttrs messageDigest  → intact / tampered;
 *  - verifies the SignerInfo signature (over the 0xA0-IMPLICIT re-tagged
 *    signedAttrs DER, or the covered content when no signedAttrs) against
 *    the signer certificate's SPKI via WebCrypto RSASSA-PKCS1-v1_5;
 *  - compares the /ByteRange coverage with the actual file length →
 *    "modified after signing" (incremental-update detection);
 *  - reports signer CN/O, serial, validity window, signing time,
 *    reason/location, digest algorithm — per signature.
 *
 * It does NOT do: CRL/OCSP/chain-of-trust validation, timestamp (TSA)
 * verification, or PAdES long-term-validation. A self-signed certificate
 * is reported as exactly that: cryptographically sound but untrusted
 * (no trust decision is made — there is no trust store to check against).
 *
 * Pipeline split (bun-testable model, worker does I/O only):
 *   worker: read file → sniff %PDF- → encryption gate → analyze(bytes, now)
 *   model:  everything else — DER, CMS, X.509, raw PDF walk, digest,
 *           crypto verify (crypto.subtle), report text. Pure except for
 *           the injected `now` clock and WebCrypto itself.
 */

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Per-signature verdict.
 *  - "valid"     green — crypto PASS + digest INTACT + coverage complete
 *  - "attention" amber — sound, but something needs a look (bytes
 *                         appended after signing, expired cert,
 *                         self-signed, weak digest, minor anomalies)
 *  - "invalid"   red   — digest MISMATCH (tampered), crypto FAIL, or the
 *                         CMS/ByteRange could not be parsed at all
 *  - "unsigned"        — /FT /Sig field with no /V (never signed)
 */
export type SignatureStatus = "valid" | "attention" | "invalid" | "unsigned";

/** Chip colour for the three reportable tones (validate-e-invoice style). */
export type SignatureTone = "green" | "amber" | "red";

/* ------------------------------------------------------------------ */
/* X.509 certificate summary (what the cards show)                      */
/* ------------------------------------------------------------------ */

export interface CertSummary {
  commonName: string | null;
  organization: string | null;
  organizationalUnit: string | null;
  country: string | null;
  email: string | null;
  /** Serial as hex (as parsed, with an odd leading zero kept). */
  serialHex: string | null;
  /** Issuer RDN CN (self-signed check displays issuer == subject). */
  issuerCommonName: string | null;
  /** ISO-ish "YYYY-MM-DD HH:mm UTC" (null when unreadable). */
  notBeforeIso: string | null;
  notAfterIso: string | null;
  /** Validity evaluated at the injected `now` clock. */
  validityNow: "valid" | "expired" | "not-yet-valid" | null;
  selfSigned: boolean | null;
}

/* ------------------------------------------------------------------ */
/* Per-signer analysis (one SignerInfo inside the CMS)                  */
/* ------------------------------------------------------------------ */

export interface SignerAnalysis {
  /** Display name of the digest algorithm ("SHA-256") or null. */
  digestAlgo: string | null;
  /** WebCrypto hash name for the digest ("SHA-256") or null. */
  digestHashName: string | null;
  /** Display name of the signature algorithm ("RSA-PKCS1v1_5"). */
  signatureAlgo: string | null;
  /**
   * Signature verification result. null = could not verify (no usable
   * signer certificate, unsupported algorithm, WebCrypto error) — the
   * surface then shows an honest "not verified" with the reason.
   */
  cryptoVerified: boolean | null;
  /** i18n key explaining why cryptoVerified is null (vps.nXxx). */
  cryptoNoteKey: string | null;
  /** messageDigest from signedAttrs, lowercase hex (null when absent). */
  messageDigestHex: string | null;
  /** Recomputed digest over the ByteRange bytes, lowercase hex. */
  computedDigestHex: string | null;
  /**
   * Document integrity: "intact" (digests match), "tampered" (mismatch),
   * "unknown" (no signedAttrs messageDigest to compare against).
   */
  integrity: "intact" | "tampered" | "unknown" | null;
  /** signingTime from signedAttrs, ISO-ish (null when absent). */
  signingTimeIso: string | null;
  /** signedAttrs contentType OID (null when no signedAttrs). */
  contentTypeOid: string | null;
  /** The certificate matched via sid (issuerAndSerialNumber). */
  cert: CertSummary | null;
  /** sid matched a certificate in the CMS (null = no sid at all). */
  sidMatched: boolean | null;
}

/* ------------------------------------------------------------------ */
/* One signature card (one /FT /Sig field WITH a /V dictionary)        */
/* ------------------------------------------------------------------ */

export interface SignatureCard {
  /** 1-based display index. */
  index: number;
  /** Field /T (name); null when the field is nameless. */
  fieldName: string | null;
  status: SignatureStatus;
  tone: SignatureTone;
  /** i18n keys for the notes shown under the verdict (vps.nXxx). */
  noteKeys: string[];
  /** Technical detail lines (already display-ready, raw strings). */
  noteTech: string[];
  /* ---- field / signature dictionary entries (raw, honest) ---- */
  /** /Filter (e.g. "Adobe.PPKLite"). */
  filter: string | null;
  /** /SubFilter (e.g. "adbe.pkcs7.detached"). */
  subFilter: string | null;
  /** /Name (the signer-provided display name). */
  signerName: string | null;
  /** /M parsed to ISO-ish (null when absent/unparseable). */
  pdfMTimeIso: string | null;
  reason: string | null;
  location: string | null;
  /** 1-based page of the widget (null when unknown). */
  page: number | null;
  /** /Rect of the widget [x1 y1 x2 y2] (null when unknown). */
  rect: number[] | null;
  /* ---- byte-level evidence ---- */
  /** /ByteRange as written (4 entries normally). */
  byteRange: number[] | null;
  /** Byte length of the /Contents CMS payload. */
  cmsSize: number | null;
  /** Bytes after the covered ranges end (coverage gap). */
  trailingBytes: number | null;
  modifiedAfterSigning: boolean | null;
  /** All SignerInfos in the CMS (usually exactly one). */
  signers: SignerAnalysis[];
}

/** A /FT /Sig field with no /V (present but never signed). */
export interface UnsignedFieldInfo {
  fieldName: string | null;
  page: number | null;
}

/* ------------------------------------------------------------------ */
/* The whole report                                                    */
/* ------------------------------------------------------------------ */

export interface SignatureReport {
  /** Page count from the page tree (null when the tree was unreadable). */
  pageCount: number | null;
  signatures: SignatureCard[];
  unsignedFields: UnsignedFieldInfo[];
  /** The linear object-scan recovery was used (xref unusable/streamed). */
  recoveryUsed: boolean;
  /** Technical reason for the recovery (raw, report-only). */
  recoveryReason: string | null;
}

/* ------------------------------------------------------------------ */
/* Worker boundary                                                     */
/* ------------------------------------------------------------------ */

/**
 * Pre-resolved display strings for the .txt report (validate-e-invoice
 * precedent: the surface passes its t() output through options.run so the
 * report matches the UI language; the model keeps an English fallback).
 */
export type ReportLabels = Record<string, string>;

/** Options payload the surface syncs (JSON in options.run). */
export interface RunOptions {
  locale: "en" | "hi";
  /** Localized fallback word for a nameless file. */
  fileWord: string;
  /** Resolved report strings (vps.* keys → text). */
  labels: ReportLabels;
}

/** Report header meta (file identity for the .txt). */
export interface ReportMeta {
  fileName: string;
  bytes: number;
}

/**
 * RunDetail extension for verify-pdf-signatures (the RB1/RB3-b additive
 * precedent): the local interface the worker posts and the surface reads.
 */
export interface VerifyDetail extends RunDetail {
  signatureCount?: number;
  validCount?: number;
  attentionCount?: number;
  invalidCount?: number;
  /** /FT /Sig fields present but never signed. */
  unsignedFields?: number;
  /** Linear object-scan recovery was used. */
  recovered?: boolean;
  /** The full report the surface renders. */
  report?: SignatureReport;
}
