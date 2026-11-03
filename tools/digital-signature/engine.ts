/**
 * Digital signature engine (PRD §7.6 Security: `digital-signature`,
 * PAdES-style .pfx/.p12 signing, Mode D).
 *
 * Two halves:
 *
 *  1. READ a PKCS#12 (.pfx/.p12) file on-device — verify its MAC with
 *     the hand-rolled RFC 7292 KDF, decrypt the bags (PBES2 AES via
 *     WebCrypto; PBES1 3DES/RC2 via legacy-crypto.ts), collect the
 *     certificate chain and import the private key.
 *
 *  2. SIGN a PDF — append a proper incremental update (pdf-lib
 *     `forIncrementalUpdate`, so signatures already in the file stay
 *     byte-untouched), add an /FT /Sig widget with an optional visible
 *     appearance, then byte-patch the fixed-width /ByteRange and drop a
 *     CMS SignedData (SubFilter ETSI.CAdES.detached — the PAdES-B-B
 *     form) into /Contents with signed attributes: contentType,
 *     signingTime, messageDigest, signingCertificateV2.
 *
 * The worker self-verifies its own output with the verify-pdf-signatures
 * engine and refuses to emit a signature it cannot verify.
 *
 * Everything runs in the browser/worker. No network. No TSA — the
 * signing time is the local clock and the UI says so honestly.
 */

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setFillingRgbColor,
  setStrokingRgbColor,
  moveText,
  showText,
  rectangle,
  fill as fillPath,
  stroke as strokePath,
} from "@cantoo/pdf-lib";
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import {
  pbe1KindOf,
  pkcs12Kdf,
  decryptPbes1,
  tripleDesCbcDecrypt,
} from "./legacy-crypto";
import { xrefIntactBytes } from "../repair-pdf/engine";

/* --------------------------------------------------------------- OID table */

const OID_DATA = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_ENCRYPTED_DATA = "1.2.840.113549.1.7.6";
const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47";
const OID_RSA = "1.2.840.113549.1.1.1";
const OID_EC = "1.2.840.10045.2.1";
const OID_CERT_X509 = "1.2.840.113549.1.9.22.1";
const OID_FRIENDLY_NAME = "1.2.840.113549.1.9.20";

const CURVE_OIDS: Record<string, string> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
};

/** Curve names WebCrypto accepts (the VALUES of CURVE_OIDS). */
const SUPPORTED_CURVES: Record<string, true> = {
  "P-256": true,
  "P-384": true,
  "P-521": true,
};

/* ------------------------------------------------------------- small utils */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function asBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function sha(algo: string, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algo, asBuf(bytes)));
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Same-width overwrite. */
function patchAt(text: string, index: number, replacement: string): string {
  return (
    text.slice(0, index) + replacement + text.slice(index + replacement.length)
  );
}

/* ------------------------------------------------------ PKCS#12 structures */

export interface P12Summary {
  macVerified: boolean;
  /** DER certificates found in cert bags, order preserved. */
  certDers: Uint8Array[];
  /** PKCS#8 DER of the private key (readPkcs12 throws when absent). */
  keyDer: Uint8Array;
  keyKind: "RSA" | "EC";
  ecCurve: string | null;
  friendlyName: string | null;
}

/* --- ASN.1 helpers (asn1js result shapes are loosely typed) --- */

interface AsnBlock {
  idBlock: { tagClass: number; tagNumber: number; isConstructed: boolean };
  valueBlock: Record<string, unknown>;
  value?: AsnBlock[];
}

function children(node: unknown): AsnBlock[] {
  const b = node as AsnBlock | null;
  const v = (b?.valueBlock as { value?: unknown } | undefined)?.value;
  return Array.isArray(v) ? (v as AsnBlock[]) : [];
}

function octetsOf(node: AsnBlock | null | undefined): Uint8Array | null {
  if (!node) return null;
  const vh = (node.valueBlock as { valueHexView?: Uint8Array }).valueHexView;
  if (vh instanceof Uint8Array && vh.length > 0) return vh;
  const hx = (node.valueBlock as { valueHex?: ArrayBuffer }).valueHex;
  if (hx instanceof ArrayBuffer) return new Uint8Array(hx);
  return null;
}

function oidOf(node: AsnBlock | null | undefined): string | null {
  if (!node) return null;
  const v = (node.valueBlock as { value?: unknown }).value;
  if (typeof v === "string") return v;
  // asn1js v3 keeps ObjectIdentifier arcs as sidBlocks (valueDec each).
  if (Array.isArray(v)) {
    const parts: number[] = [];
    for (const sid of v as { valueDec?: number }[]) {
      if (typeof sid?.valueDec !== "number") return null;
      parts.push(sid.valueDec);
    }
    if (parts.length === 0) return null;
    // The first sid packs arcs 1+2 (arc1 * 40 + arc2) into one value.
    const first = parts[0];
    const arcs = [Math.floor(first / 40), first % 40, ...parts.slice(1)];
    return arcs.join(".");
  }
  return null;
}

function isSeq(node: unknown): node is AsnBlock {
  const b = node as AsnBlock | null;
  return (
    !!b &&
    b.idBlock.tagClass === 1 &&
    b.idBlock.tagNumber === 16 &&
    b.idBlock.isConstructed
  );
}

/** The original DER bytes of any parsed asn1js node. */
function rawOf(node: AsnBlock): Uint8Array {
  const vbd = (node as unknown as { valueBeforeDecodeView?: Uint8Array })
    .valueBeforeDecodeView;
  if (vbd instanceof Uint8Array && vbd.length > 0) {
    return new Uint8Array(vbd);
  }
  throw new Error("dsign.errorP12Parse");
}

/** BMPString (UTF-16BE) as in friendlyName attributes. */
function bmpText(node: AsnBlock | null | undefined): string | null {
  const vh = octetsOf(node);
  if (!vh || vh.length % 2 !== 0) return null;
  let out = "";
  for (let i = 0; i + 1 < vh.length; i += 2) {
    const code = (vh[i] << 8) | vh[i + 1];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/* --- PBE parameter decryption for one EncryptedContentInfo --- */

async function decryptPbes2(
  algNode: AsnBlock,
  ciphertext: Uint8Array,
  password: string
): Promise<Uint8Array> {
  // AlgorithmIdentifier ::= SEQUENCE { pbes2 OID, PBES2-params }
  // PBES2-params ::= SEQUENCE { keyDerivationFunc, encryptionScheme }
  const algKids = children(algNode);
  if (algKids.length < 2) throw new Error("dsign.errorP12Parse");
  const pbes2Params = children(algKids[1]);
  const kdf = pbes2Params[0];
  const scheme = pbes2Params[1];
  if (!kdf || !scheme) throw new Error("dsign.errorP12Parse");
  // keyDerivationFunc ::= SEQUENCE { PBKDF2 OID, PBKDF2-params }
  const kdfOid = oidOf(children(kdf)[0]);
  if (kdfOid !== "1.2.840.113549.1.5.12") {
    throw new Error("dsign.errorP12Unsupported");
  }
  // PBKDF2Params ::= SEQUENCE { salt OCTET, iterations INT, keyLength?, prf? }
  const kp = children(kdf)[1];
  if (!kp) throw new Error("dsign.errorP12Parse");
  const kpKids = children(kp);
  const salt = octetsOf(kpKids[0]);
  const iterBlock = kpKids[1]?.valueBlock as { valueDec?: number } | undefined;
  const iterations = iterBlock?.valueDec ?? 1;
  if (!salt || !Number.isFinite(iterations)) {
    throw new Error("dsign.errorP12Parse");
  }
  let prfHash = "SHA-1";
  for (const extra of kpKids.slice(2)) {
    // keyLength would be an INTEGER; the prf is a SEQUENCE.
    if (isSeq(extra)) {
      const prfOid = oidOf(children(extra)[0]);
      prfHash =
        prfOid === "1.2.840.113549.2.9"
          ? "SHA-256"
          : prfOid === "1.2.840.113549.2.10"
            ? "SHA-384"
            : prfOid === "1.2.840.113549.2.11"
              ? "SHA-512"
              : "SHA-1";
    }
  }
  // encryptionScheme: OID + IV octet string
  const encOid = oidOf(children(scheme)[0]);
  const iv = octetsOf(children(scheme)[1]);
  if (!encOid || !iv) throw new Error("dsign.errorP12Parse");

  const keyLen =
    encOid === "2.16.840.1.101.3.4.1.2"
      ? 16
      : encOid === "2.16.840.1.101.3.4.1.22"
        ? 24
        : encOid === "2.16.840.1.101.3.4.1.42"
          ? 32
          : encOid === "1.2.840.113549.3.7"
            ? 24 // des-ede3-cbc under PBES2
            : 0;
  if (keyLen === 0) throw new Error("dsign.errorP12Unsupported");

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: prfHash, salt: asBuf(salt), iterations },
    baseKey,
    keyLen * 8
  );

  if (encOid === "1.2.840.113549.3.7") {
    const plain = tripleDesCbcDecrypt(ciphertext, new Uint8Array(bits), iv);
    const pad = plain[plain.length - 1];
    if (pad < 1 || pad > 8) throw new Error("dsign.errorP12Password");
    return plain.subarray(0, plain.length - pad);
  }
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: asBuf(iv) },
      await crypto.subtle.importKey("raw", bits, { name: "AES-CBC" }, false, [
        "decrypt",
      ]),
      asBuf(ciphertext)
    )
  );
  return plain;
}

/* ------------------------------------------------------ PKCS#12 main read */

export async function readPkcs12(
  bytes: Uint8Array,
  password: string
): Promise<P12Summary> {
  const parsed = asn1js.fromBER(asBuf(bytes));
  if (parsed.offset === -1 || !isSeq(parsed.result)) {
    throw new Error("dsign.errorP12Parse");
  }
  const top = children(parsed.result);
  // PFX ::= SEQUENCE { version, authSafe ContentInfo, macData? }
  if (top.length < 2) throw new Error("dsign.errorP12Parse");
  const authSafe = top[1];
  const authKids = children(authSafe);
  const authType = authKids.length > 0 ? oidOf(authKids[0]) : null;
  if (authType !== OID_DATA) {
    // Public-key integrity mode (authSafe = signedData) — rare; honesty.
    throw new Error("dsign.errorP12Unsupported");
  }
  const contentNode = authKids.find(
    (n) => n.idBlock.tagClass === 3 && n.idBlock.tagNumber === 0
  );
  const authSafeContent = contentNode ? octetsOf(children(contentNode)[0]) : null;
  if (!authSafeContent) throw new Error("dsign.errorP12Parse");

  /* ---- MAC check (RFC 7292: HMAC over the authSafe content) ---- */
  let macVerified = false;
  const macNode = top[2];
  if (isSeq(macNode)) {
    // MacData ::= SEQUENCE { mac DigestInfo, macSalt, iterations? }
    const mk = children(macNode);
    const di = mk[0] ? children(mk[0]) : [];
    const macAlgOid = di[0] ? oidOf(children(di[0])[0]) : null;
    const digest = octetsOf(di[1]);
    const salt = octetsOf(mk[1]);
    const iterBlock = mk[2]?.valueBlock as { valueDec?: number } | undefined;
    const iterations = iterBlock?.valueDec ?? 1;
    const hash =
      macAlgOid === "2.16.840.1.101.3.4.2.1"
        ? "SHA-256"
        : macAlgOid === "2.16.840.1.101.3.4.2.2"
          ? "SHA-384"
          : macAlgOid === "2.16.840.1.101.3.4.2.3"
            ? "SHA-512"
            : "SHA-1";
    if (digest && salt) {
      try {
        const macKey = await pkcs12Kdf(
          hash,
          digest.length,
          password,
          salt,
          iterations,
          3
        );
        const key = await crypto.subtle.importKey(
          "raw",
          asBuf(macKey),
          { name: "HMAC", hash },
          false,
          ["verify"]
        );
        macVerified = await crypto.subtle.verify(
          "HMAC",
          key,
          asBuf(digest),
          asBuf(authSafeContent)
        );
      } catch {
        macVerified = false;
      }
    }
  }
  if (macNode !== undefined && !macVerified) {
    // A present-but-failing MAC is a wrong password (or corruption).
    throw new Error("dsign.errorP12Password");
  }

  /* ---- Walk the AuthenticatedSafe (SEQUENCE of ContentInfo) ---- */
  const safeParsed = asn1js.fromBER(asBuf(authSafeContent));
  if (safeParsed.offset === -1 || !isSeq(safeParsed.result)) {
    throw new Error("dsign.errorP12Parse");
  }

  const certDers: Uint8Array[] = [];
  let keyDer: Uint8Array | null = null;
  let friendlyName: string | null = null;

  for (const contentInfo of children(safeParsed.result)) {
    const ciKids = children(contentInfo);
    const typeOid = ciKids.length > 0 ? oidOf(ciKids[0]) : null;
    const inner = ciKids.find(
      (n) => n.idBlock.tagClass === 3 && n.idBlock.tagNumber === 0
    );

    let safeContentsDer: Uint8Array | null = null;

    if (typeOid === OID_DATA) {
      safeContentsDer = inner ? octetsOf(children(inner)[0]) : null;
    } else if (typeOid === OID_ENCRYPTED_DATA) {
      // [0] wraps EncryptedData ::= SEQUENCE { version, encryptedContentInfo }
      const encData = inner ? children(inner)[0] : null;
      const edParts = encData ? children(encData) : [];
      const encInfo = edParts[1];
      if (!encInfo) throw new Error("dsign.errorP12Parse");
      const eci = children(encInfo);
      const encAlg = eci[1];
      const encContentNode = eci[2];
      if (!encAlg || !encContentNode) throw new Error("dsign.errorP12Parse");
      // encryptedContent is [0] IMPLICIT OCTET STRING — bytes ride on the
      // node itself (primitive) or as its child octets (constructed form).
      const cipher =
        octetsOf(encContentNode) ?? octetsOf(children(encContentNode)[0]);
      if (!cipher) throw new Error("dsign.errorP12Parse");
      const algOid = oidOf(children(encAlg)[0]);
      if (!algOid) throw new Error("dsign.errorP12Parse");
      const pbe1 = pbe1KindOf(algOid);
      if (pbe1 !== null) {
        const pbeParams = children(children(encAlg)[1]);
        const salt = octetsOf(pbeParams[0]);
        const iterBlock = pbeParams[1]?.valueBlock as
          | { valueDec?: number }
          | undefined;
        const iterations = iterBlock?.valueDec ?? 1;
        if (!salt) throw new Error("dsign.errorP12Parse");
        safeContentsDer = await decryptPbes1(
          pbe1,
          password,
          salt,
          iterations,
          cipher
        );
      } else {
        safeContentsDer = await decryptPbes2(encAlg, cipher, password);
      }
    } else {
      continue;
    }

    if (!safeContentsDer) throw new Error("dsign.errorP12Parse");
    const scParsed = asn1js.fromBER(asBuf(safeContentsDer));
    if (scParsed.offset === -1 || !isSeq(scParsed.result)) {
      // Garbage after decryption = wrong password material.
      throw new Error("dsign.errorP12Password");
    }

    // SafeContents ::= SEQUENCE OF SafeBag
    for (const bag of children(scParsed.result)) {
      const bk = children(bag);
      if (bk.length < 2) continue;
      const bagOid = oidOf(bk[0]);
      const bagValue = bk[1];

      if (bagOid === "1.2.840.113549.1.12.10.1.3") {
        // certBag: [0] wraps CertBag ::= SEQUENCE { certId OID, certValue [0] }
        const cb = children(children(bagValue)[0]);
        const certId = cb.length > 0 ? oidOf(cb[0]) : null;
        const certValue = cb.find(
          (n) => n.idBlock.tagClass === 3 && n.idBlock.tagNumber === 0
        );
        const der = certValue ? octetsOf(children(certValue)[0]) : null;
        if (certId === OID_CERT_X509 && der) certDers.push(der);
      } else if (bagOid === "1.2.840.113549.1.12.10.1.2") {
        // pkcs8ShroudedKeyBag: [0] wraps EncryptedPrivateKeyInfo
        const epki = children(children(bagValue)[0]);
        const encAlg = epki[0];
        const cipher = octetsOf(epki[1]);
        if (!encAlg || !cipher) throw new Error("dsign.errorP12Parse");
        const algOid = oidOf(children(encAlg)[0]);
        if (!algOid) throw new Error("dsign.errorP12Parse");
        const pbe1 = pbe1KindOf(algOid);
        const pkcs8 =
          pbe1 !== null
            ? await (() => {
                const pbeParams = children(children(encAlg)[1]);
                const salt = octetsOf(pbeParams[0]);
                const iterBlock = pbeParams[1]?.valueBlock as
                  | { valueDec?: number }
                  | undefined;
                const iterations = iterBlock?.valueDec ?? 1;
                if (!salt) throw new Error("dsign.errorP12Parse");
                return decryptPbes1(
                  pbe1,
                  password,
                  salt,
                  iterations,
                  cipher
                );
              })()
            : await decryptPbes2(encAlg, cipher, password);
        if (keyDer === null) keyDer = pkcs8;
      } else if (bagOid === "1.2.840.113549.1.12.10.1.1") {
        // keyBag: plain (unencrypted) PrivateKeyInfo
        if (keyDer === null) keyDer = rawOf(bagValue);
      }

      // Bag attributes: friendlyName lives in a SET OF SEQUENCE { OID, SET }.
      for (const attrSet of bk.slice(2)) {
        for (const attrSeq of children(attrSet)) {
          const aParts = children(attrSeq);
          if (oidOf(aParts[0]) !== OID_FRIENDLY_NAME) continue;
          const nameVal = children(aParts[1])[0];
          friendlyName = bmpText(nameVal) ?? friendlyName;
        }
      }
    }
  }

  if (keyDer === null) throw new Error("dsign.errorP12NoKey");
  if (certDers.length === 0) throw new Error("dsign.errorP12NoCert");

  // Key kind + curve from the PKCS#8 structure.
  const kParsed = asn1js.fromBER(asBuf(keyDer));
  if (kParsed.offset === -1 || !isSeq(kParsed.result)) {
    throw new Error("dsign.errorP12Parse");
  }
  const kk = children(kParsed.result);
  let keyKind: "RSA" | "EC" | null = null;
  let ecCurve: string | null = null;
  const algSeq = kk[1];
  if (algSeq && isSeq(algSeq)) {
    const algKids = children(algSeq);
    const algOid = oidOf(algKids[0]);
    if (algOid === OID_RSA) keyKind = "RSA";
    else if (algOid === OID_EC) {
      keyKind = "EC";
      // Curve location differs by producer: modern openssl puts the
      // curve OID directly as the algorithm parameter; others keep it
      // inside the ECPrivateKey's [0] (both are valid PKCS#8 forms).
      const direct = oidOf(algKids[1]);
      if (direct !== null) {
        ecCurve = CURVE_OIDS[direct] ?? null;
      } else {
        const priv = kk[2] ? octetsOf(kk[2]) : null;
        if (priv) {
          const ecParsed = asn1js.fromBER(asBuf(priv));
          if (ecParsed.offset !== -1 && isSeq(ecParsed.result)) {
            const ek = children(ecParsed.result);
            const params = ek.find(
              (n) => n.idBlock.tagClass === 3 && n.idBlock.tagNumber === 0
            );
            if (params) {
              const curveOid = oidOf(children(params)[0]);
              ecCurve = curveOid ? (CURVE_OIDS[curveOid] ?? null) : null;
            }
          }
        }
      }
    }
  }
  if (keyKind === null) throw new Error("dsign.errorKeyUnsupported");

  return {
    macVerified,
    certDers,
    keyDer,
    keyKind,
    ecCurve,
    friendlyName,
  };
}

/* ------------------------------------------------------------ key handling */

export interface LoadedKey {
  cryptoKey: CryptoKey;
  kind: "RSA" | "EC";
}

export async function importKey(
  keyDer: Uint8Array,
  kind: "RSA" | "EC",
  ecCurve: string | null
): Promise<LoadedKey> {
  if (kind === "RSA") {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      asBuf(keyDer),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return { cryptoKey, kind };
  }
  if (kind === "EC" && ecCurve !== null && ecCurve in SUPPORTED_CURVES) {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      asBuf(keyDer),
      { name: "ECDSA", namedCurve: ecCurve },
      false,
      ["sign"]
    );
    return { cryptoKey, kind };
  }
  throw new Error("dsign.errorKeyUnsupported");
}

/** The signer certificate: the one whose public key verifies this key. */
export async function findSignerCert(
  certDers: Uint8Array[],
  key: LoadedKey
): Promise<Uint8Array | null> {
  const probe = crypto.getRandomValues(new Uint8Array(48));
  let signature: Uint8Array;
  let signedData: Uint8Array = probe;
  if (key.kind === "RSA") {
    signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.cryptoKey, asBuf(probe))
    );
  } else {
    signedData = await sha("SHA-256", probe);
    signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.cryptoKey,
        asBuf(signedData)
      )
    );
  }

  for (const der of certDers) {
    try {
      const cert = new pkijs.Certificate({
        schema: asn1js.fromBER(asBuf(der)).result,
      });
      const spki = cert.subjectPublicKeyInfo.toSchema().toBER() as ArrayBuffer;
      const oid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
      if (key.kind === "RSA") {
        if (oid !== OID_RSA) continue;
        const pub = await crypto.subtle.importKey(
          "spki",
          spki,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"]
        );
        if (
          await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            pub,
            asBuf(signature),
            asBuf(signedData)
          )
        ) {
          return der;
        }
      } else {
        if (oid !== OID_EC) continue;
        for (const curve of ["P-256", "P-384", "P-521"]) {
          try {
            const pub = await crypto.subtle.importKey(
              "spki",
              spki,
              { name: "ECDSA", namedCurve: curve },
              false,
              ["verify"]
            );
            if (
              await crypto.subtle.verify(
                { name: "ECDSA", hash: "SHA-256" },
                pub,
                asBuf(signature),
                asBuf(signedData)
              )
            ) {
              return der;
            }
          } catch {
            /* wrong curve — try the next */
          }
        }
      }
    } catch {
      /* unreadable chain entry — try the next cert */
    }
  }
  return null;
}

/* ------------------------------------------------------------ PDF signing */

export interface SignPdfOptions {
  reason: string;
  location: string;
  contact: string;
  /** 1-based page carrying the field (visible card or invisible). */
  page: number;
  visible: boolean;
  fieldName: string;
}

export interface SignPdfResult {
  bytes: Uint8Array;
  detail: {
    pages: number;
    signerName: string | null;
    subFilter: string;
    coveragePct: number;
    existingSignatures: number;
    /** Field name of the signature this run added (worker self-check). */
    fieldName: string;
  };
}

/** Fixed-size /Contents hex gap (hex chars). 8192 hex = 4096 DER bytes. */
const CONTENTS_HEX = 8192;

export function countExistingSignatures(doc: PDFDocument): number {
  let existing = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("FT")) !== PDFName.of("Sig")) continue;
    if (obj.get(PDFName.of("V")) !== undefined) existing += 1;
  }
  return existing;
}

export async function signPdf(
  pdfBytes: Uint8Array,
  certDers: Uint8Array[],
  signerCertDer: Uint8Array,
  key: LoadedKey,
  signerName: string | null,
  options: SignPdfOptions
): Promise<SignPdfResult> {
  /* ---- pre-flights ---- */
  const head = latin1(pdfBytes.subarray(0, 1024));
  if (!head.startsWith("%PDF-")) throw new Error("dsign.errorNotPdf");
  if (xrefIntactBytes(pdfBytes) === null) {
    throw new Error("dsign.errorDamaged");
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, {
      forIncrementalUpdate: true,
      updateMetadata: false,
      ignoreEncryption: false,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/encrypt/i.test(message)) throw new Error("dsign.errorEncrypted");
    throw new Error("dsign.errorDamaged");
  }
  const existing = countExistingSignatures(doc);

  const pageCount = doc.getPageCount();
  const pageIndex = Math.min(Math.max(1, Math.floor(options.page || 1)), pageCount);
  const page = doc.getPage(pageIndex - 1);

  const stamp = new Date();
  const pdfDate = `D:${stamp.getUTCFullYear()}${String(
    stamp.getUTCMonth() + 1
  ).padStart(2, "0")}${String(stamp.getUTCDate()).padStart(2, "0")}${String(
    stamp.getUTCHours()
  ).padStart(2, "0")}${String(stamp.getUTCMinutes()).padStart(2, "0")}${String(
    stamp.getUTCSeconds()
  ).padStart(2, "0")}+00'00'`;

  const ctx = doc.context;
  const sigDict = ctx.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.CAdES.detached",
    // Sentinel values keep the placeholder UNIQUE in the committed bytes —
    // an invisible widget's /Rect [0 0 0 0] would otherwise collide with a
    // plain [0 0 0 0] search (a real double-signing bug caught in QA).
    ByteRange: ctx.obj([0, 999999999, 0, 0]),
    Contents: PDFHexString.of("A".repeat(CONTENTS_HEX)),
    Name: PDFString.of(signerName ?? "Signer"),
    Reason: PDFString.of(options.reason),
    Location: PDFString.of(options.location),
    ContactInfo: PDFString.of(options.contact),
    M: PDFString.of(pdfDate),
  });

  /* ---- visible appearance (a clean, quiet signature card) ---- */
  let apValue: unknown = undefined;
  if (options.visible) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ops = appearanceOps(options, signerName, stamp);
    const apStream = ctx.formXObject(ops, {
      BBox: ctx.obj([0, 0, 200, 60]),
      Resources: ctx.obj({ Font: ctx.obj({ F0: font.ref }) }),
    });
    apValue = ctx.obj({ N: ctx.register(apStream) });
  }

  const widgetDict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: PDFString.of(options.fieldName || "Signature1"),
    Rect: options.visible ? ctx.obj([36, 36, 236, 96]) : ctx.obj([0, 0, 0, 0]),
    F: 4,
    V: sigDict,
  };
  if (apValue !== undefined) widgetDict.AP = apValue;
  const widgetRef = ctx.register(
    ctx.obj(widgetDict as Parameters<typeof ctx.obj>[0])
  );

  /* ---- merge into the existing AcroForm (never clobber fields) ---- */
  let merged = false;
  const existingAcro = doc.catalog.get(PDFName.of("AcroForm"));
  if (existingAcro !== undefined) {
    const resolved = ctx.lookup(existingAcro);
    if (resolved instanceof PDFDict) {
      const fieldsObj = ctx.lookup(resolved.get(PDFName.of("Fields")));
      const fieldsArray = fieldsObj as unknown as
        | { push?: (r: unknown) => void }
        | null;
      if (fieldsObj !== undefined && typeof fieldsArray?.push === "function") {
        fieldsArray.push(widgetRef);
        merged = true;
      }
      resolved.set(PDFName.of("SigFlags"), ctx.obj(3));
    }
  }
  if (!merged) {
    doc.catalog.set(
      PDFName.of("AcroForm"),
      ctx.obj({ Fields: ctx.obj([widgetRef]), SigFlags: 3 })
    );
  }
  const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
  const annotsArray = annots as unknown as { push?: (r: unknown) => void } | null;
  if (annotsArray != null && typeof annotsArray.push === "function") {
    annotsArray.push(widgetRef);
  } else {
    page.node.set(PDFName.of("Annots"), ctx.obj([widgetRef]));
  }

  /* ---- commit as an incremental update, then patch in place ---- */
  const committed = await doc.commit({ useObjectStreams: false });
  let text = latin1(committed);

  const brSentinel = "[ 0 999999999 0 0 ]";
  const brIndex = text.indexOf(brSentinel);
  if (brIndex < 0) throw new Error("dsign.errorSignFailed");
  const brPadded = "[ 0000000000 0000000000 0000000000 0000000000 ]";
  text =
    text.slice(0, brIndex) +
    brPadded +
    text.slice(brIndex + brSentinel.length);

  const aRun = "A".repeat(CONTENTS_HEX);
  const contentsHexStart = text.indexOf(aRun);
  if (contentsHexStart < 0) throw new Error("dsign.errorSignFailed");
  const contentsHexEnd = contentsHexStart + aRun.length;

  const o1 = 0;
  const l1 = contentsHexStart;
  const o2 = contentsHexEnd;
  const l2 = text.length - o2;
  const pad10 = (n: number): string => String(n).padStart(10, "0");
  text = patchAt(
    text,
    brIndex + 2,
    `${pad10(o1)} ${pad10(l1)} ${pad10(o2)} ${pad10(l2)}`
  );

  const asBytes = toBytes(text);
  const covered = new Uint8Array(l1 + l2);
  covered.set(asBytes.subarray(0, l1), 0);
  covered.set(asBytes.subarray(o2, o2 + l2), l1);

  /* ---- CMS SignedData (ETSI.CAdES.detached / PAdES-B-B) ---- */
  const messageDigest = await sha("SHA-256", covered);
  const certHash = await sha("SHA-256", signerCertDer);

  const signerCert = new pkijs.Certificate({
    schema: asn1js.fromBER(asBuf(signerCertDer)).result,
  });

  // signingCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
  const essCertId = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: asBuf(certHash) })],
  });
  const signingCertV2 = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [essCertId] })],
  });

  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: OID_CONTENT_TYPE,
        values: [new asn1js.ObjectIdentifier({ value: OID_DATA })],
      }),
      new pkijs.Attribute({
        type: OID_SIGNING_TIME,
        values: [new asn1js.UTCTime({ valueDate: stamp })],
      }),
      new pkijs.Attribute({
        type: OID_MESSAGE_DIGEST,
        values: [new asn1js.OctetString({ valueHex: asBuf(messageDigest) })],
      }),
      new pkijs.Attribute({
        type: OID_SIGNING_CERT_V2,
        values: [signingCertV2],
      }),
    ],
  });

  const certsForCms: pkijs.Certificate[] = [];
  const seen = new Set<string>();
  for (const der of [signerCertDer, ...certDers]) {
    const hexKey = toHex(der);
    if (seen.has(hexKey)) continue;
    seen.add(hexKey);
    try {
      certsForCms.push(
        new pkijs.Certificate({ schema: asn1js.fromBER(asBuf(der)).result })
      );
    } catch {
      /* skip unreadable chain entries */
    }
  }

  const cmsSigned = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_DATA,
    }),
    certificates: certsForCms,
  });
  cmsSigned.signerInfos.push(
    new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({
        issuer: signerCert.issuer,
        serialNumber: signerCert.serialNumber,
      }),
      signedAttrs,
    })
  );
  await cmsSigned.sign(key.cryptoKey, 0, "SHA-256");

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID_SIGNED_DATA,
    content: cmsSigned.toSchema(true),
  });
  const der = new Uint8Array(contentInfo.toSchema().toBER(false));
  const derHex = toHex(der).toUpperCase();
  if (derHex.length > aRun.length) {
    throw new Error("dsign.errorTooLarge");
  }
  text = patchAt(
    text,
    contentsHexStart,
    derHex + "0".repeat(aRun.length - derHex.length)
  );

  return {
    bytes: toBytes(text),
    detail: {
      pages: pageCount,
      signerName,
      subFilter: "ETSI.CAdES.detached",
      coveragePct: Math.round(((l1 + l2) / (l1 + l2 + aRun.length)) * 100),
      existingSignatures: existing,
      fieldName: options.fieldName || "Signature1",
    },
  };
}

/* --------------------------------------------------- visible appearance AP */

/** Latin-1-safe text for the Helvetica appearance card. */
function apText(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (code >= 32 && code <= 126) out += ch;
    if (out.length >= max) break;
  }
  return out;
}

function appearanceOps(
  options: SignPdfOptions,
  signerName: string | null,
  stamp: Date
): ReturnType<typeof pushGraphicsState>[] {
  const ops: ReturnType<typeof pushGraphicsState>[] = [];
  // Card: subtle fill + 1pt border, Helvetica text (no unicode — apText strips).
  ops.push(pushGraphicsState());
  ops.push(setFillingRgbColor(0.95, 0.96, 0.98));
  ops.push(setStrokingRgbColor(0.16, 0.33, 0.65));
  ops.push(rectangle(0, 0, 200, 60));
  ops.push(fillPath());
  ops.push(rectangle(0.5, 0.5, 199, 59));
  ops.push(strokePath());
  ops.push(popGraphicsState());

  const put = (text: string, size: number, gray: number, y: number): void => {
    ops.push(beginText());
    ops.push(setFontAndSize("F0", size));
    ops.push(setFillingRgbColor(gray, gray, gray));
    ops.push(moveText(10, y));
    ops.push(showText(PDFHexString.fromText(text)));
    ops.push(endText());
  };

  put(apText(signerName ?? "Signer", 48), 11, 0.1, 42);
  if (options.reason) put(apText(options.reason, 56), 8, 0.25, 29);
  put(
    apText(
      stamp.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") +
        " - SHA-256",
      56
    ),
    7,
    0.42,
    16
  );
  return ops;
}
