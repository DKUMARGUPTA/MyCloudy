/**
 * PKCS#12 (.p12/.pfx) parser + decryptor and X.509 summary reader
 * (digital-signature, RB6-FIN-a2).
 *
 * 100% on-device (mode D): the certificate bytes never leave the worker.
 *
 * Supported containers (verified in the smoke against packs built with
 * the same DER writer + real OpenSSL-generated fixtures):
 *   - PFX → AuthenticatedSafe → ContentInfo {data | encryptedData} →
 *     SafeContents → SafeBags {pkcs8ShroudedKeyBag, certBag};
 *   - MAC integrity check BEFORE any decryption — the honest wrong-
 *     password signal (RFC 7292 §7 with the appendix B KDF);
 *   - PBES2 (PKCS#5 v2.1): PBKDF2-HMAC-SHA{1,256,512} + AES-128/256-CBC
 *     via WebCrypto (available in every worker and in bun/node smokes);
 *   - Legacy PKCS#12 PBE via the pure-JS ciphers (ciphers.ts):
 *     pbeWithSHAAnd3-KeyTripleDES-CBC (shrouded keybags) and
 *     pbeWithSHA1And40BitRC2-CBC / 128BitRC2-CBC (the outer EncryptedData
 *     layer + cert bags of every OpenSSL ≤2.x "legacy" export).
 *
 * The X.509 half reads the TBS of the signing certificate for the
 * surface/result card (CN, O, serial, validity window) and hands the
 * CMS builder the issuer DER + serial for IssuerAndSerialNumber.
 */

import {
  DerParseError,
  type DerTlv,
  asn1Time,
  derTlv,
  directoryString,
  intBytes,
  intValue,
  octets,
  oidText,
  readChildren,
  readSingle,
  readTlv,
  seqChildren,
} from "./asn1";
import { pureHmac, pkcs12Kdf, type ShaName } from "./sha";
import { des3CbcDecrypt, rc2CbcDecrypt, rc2Expand, stripPkcs7 } from "./ciphers";

/* ------------------------------------------------------------------ */
/* Error taxonomy (i18n keys, surfaced as toasts by the shell)          */
/* ------------------------------------------------------------------ */

export class P12Error extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "P12Error";
    this.code = code;
  }
}

export const P12_CODES = {
  notP12: "ds.errNotP12",
  password: "ds.errWrongPassword",
  unsupported: "ds.errUnsupported",
  noKey: "ds.errNoKey",
  notRsa: "ds.errNotRsa",
} as const;

/* ------------------------------------------------------------------ */
/* OIDs                                                                */
/* ------------------------------------------------------------------ */

const OID_DATA = "1.2.840.113549.1.7.1";
const OID_ENCRYPTED_DATA = "1.2.840.113549.1.7.6";
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_HMAC_SHA1 = "1.2.840.113549.2.7";
const OID_HMAC_SHA256 = "1.2.840.113549.2.9";
const OID_HMAC_SHA512 = "1.2.840.113549.2.11";
// OpenSSL (and most other packers) write the MAC DigestInfo algorithm as
// the PLAIN digest OID, not the hmacWithSHA* OID — both spellings map.
const OID_DIGEST_SHA1 = "1.3.14.3.2.26";
const OID_DIGEST_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_DIGEST_SHA512 = "2.16.840.1.101.3.4.2.3";
const OID_AES128_CBC = "2.16.840.1.101.3.4.1.2";
const OID_AES192_CBC = "2.16.840.1.101.3.4.1.22";
const OID_AES256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_PBE_3DES = "1.2.840.113549.1.12.1.3";
const OID_PBE_RC2_128 = "1.2.840.113549.1.12.1.5";
const OID_PBE_RC2_40 = "1.2.840.113549.1.12.1.6";
const OID_BAG_PKCS8_SHROUDED = "1.2.840.113549.1.12.10.1.2";
const OID_BAG_CERT = "1.2.840.113549.1.12.10.1.3";
const OID_CERT_X509 = "1.2.840.113549.1.9.22.1";
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";

/* ------------------------------------------------------------------ */
/* AlgorithmIdentifier reading                                          */
/* ------------------------------------------------------------------ */

interface Algo {
  oid: string;
  /** Raw parameter TLVs (NULL, OCTET STRING iv, PBE params SEQUENCE …). */
  params: DerTlv[];
}

function readAlgo(children: DerTlv[], at: number): Algo {
  const seq = children[at];
  if (seq === undefined || seq.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "p12: expected AlgorithmIdentifier");
  }
  const kids = readChildren(seq);
  const oid = kids[0];
  if (oid === undefined || oid.tag !== 0x06) {
    throw new P12Error(P12_CODES.notP12, "p12: algorithm without OID");
  }
  return { oid: oidText(oid), params: kids.slice(1) };
}

/** An [0] EXPLICIT wrapper's inner TLV (data content / [0] around OCTET STRING). */
function explicitInner(wrapper: DerTlv): DerTlv {
  if (wrapper.tag !== 0xa0) {
    throw new P12Error(P12_CODES.notP12, "p12: expected [0] EXPLICIT");
  }
  return readTlv(wrapper.value, 0);
}

/**
 * An [0]-tagged content blob that may be implicit ciphertext (primitive
 * tag 0x80 — OpenSSL's spelling), a constructed [0] carrying raw bytes,
 * or a wrapped OCTET STRING — real files carry all spellings.
 */
function contentBytes(wrapper: DerTlv): Uint8Array {
  if (wrapper.tag === 0x80) return wrapper.value;
  if (wrapper.tag !== 0xa0) {
    throw new P12Error(P12_CODES.notP12, "p12: expected [0] content");
  }
  if (wrapper.value.length >= 2 && wrapper.value[0] === 0x04) {
    // Wrapped OCTET STRING (explicit spelling) — take its value when the
    // TLV spans the whole wrapper.
    const inner = readTlv(wrapper.value, 0);
    if (inner.end === wrapper.value.length) return inner.value;
  }
  return wrapper.value;
}

/* ------------------------------------------------------------------ */
/* Symmetric decryption dispatch                                        */
/* ------------------------------------------------------------------ */

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) {
    throw new P12Error(P12_CODES.unsupported, "p12: WebCrypto unavailable");
  }
  return s;
};

const PRF_HASH: Record<string, string> = {
  [OID_HMAC_SHA1]: "SHA-1",
  [OID_HMAC_SHA256]: "SHA-256",
  [OID_HMAC_SHA512]: "SHA-512",
};

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * PBES2 decrypt: PBKDF2 (any PRF subtle offers) + AES-{128,192,256}-CBC.
 * WebCrypto validates the PKCS#7 padding, so a wrong password throws —
 * mapped to the honest password error by the caller.
 */
async function pbes2Decrypt(
  algo: Algo,
  password: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  if (algo.params[0] === undefined) {
    throw new P12Error(P12_CODES.notP12, "p12: PBES2 without params");
  }
  const pbes2Params = readChildren(algo.params[0]!);
  if (pbes2Params.length < 2) {
    throw new P12Error(P12_CODES.notP12, "p12: PBES2 params");
  }
  const kdf = readChildren(pbes2Params[0]!);
  const scheme = readChildren(pbes2Params[1]!);
  if (kdf.length === 0 || scheme.length === 0) {
    throw new P12Error(P12_CODES.notP12, "p12: PBES2 empty");
  }
  const kdfOid = kdf[0]!.tag === 0x06 ? oidText(kdf[0]!) : "";
  if (kdfOid !== OID_PBKDF2) {
    throw new P12Error(P12_CODES.unsupported, `p12: kdf ${kdfOid}`);
  }
  const schemeOid = scheme[0]!.tag === 0x06 ? oidText(scheme[0]!) : "";
  const aesLen =
    schemeOid === OID_AES128_CBC
      ? 128
      : schemeOid === OID_AES192_CBC
        ? 192
        : schemeOid === OID_AES256_CBC
          ? 256
          : null;
  if (aesLen === null) {
    throw new P12Error(P12_CODES.unsupported, `p12: scheme ${schemeOid}`);
  }
  // IV: the encryptionScheme parameter OCTET STRING (both spellings).
  let iv: Uint8Array | null = null;
  if (scheme.length > 1 && scheme[1]!.tag === 0x04) {
    iv = octets(scheme[1]!);
  } else if (scheme.length > 1 && scheme[1]!.tag === 0x30) {
    const ivKids = readChildren(scheme[1]!);
    if (ivKids[0] !== undefined && ivKids[0]!.tag === 0x04) {
      iv = octets(ivKids[0]!);
    }
  }
  if (iv === null || iv.length !== 16) {
    throw new P12Error(P12_CODES.notP12, "p12: AES iv");
  }
  // PBKDF2 params: { salt OCTET STRING, iterationCount INTEGER,
  //                 keyLength INTEGER, prf [ AlgorithmIdentifier ] }
  if (
    kdf.length < 2 ||
    kdf[0]!.tag !== 0x06 ||
    kdf[1]!.tag !== 0x30
  ) {
    throw new P12Error(P12_CODES.notP12, "p12: PBKDF2 params");
  }
  const kdfParams = readChildren(kdf[1]!);
  if (
    kdfParams.length < 2 ||
    kdfParams[0]!.tag !== 0x04 ||
    kdfParams[1]!.tag !== 0x02
  ) {
    throw new P12Error(P12_CODES.notP12, "p12: PBKDF2 params");
  }
  const salt = octets(kdfParams[0]!);
  const iterations = intValue(kdfParams[1]!);
  let keyLen = aesLen / 8;
  let hash = "SHA-1";
  for (let i = 2; i < kdfParams.length; i += 1) {
    const p = kdfParams[i]!;
    if (p.tag === 0x02) {
      keyLen = intValue(p);
    } else if (p.tag === 0x30) {
      const prfKids = readChildren(p);
      if (prfKids[0] !== undefined && prfKids[0]!.tag === 0x06) {
        const prfOid = oidText(prfKids[0]!);
        hash = PRF_HASH[prfOid] ?? "";
        if (hash === "") {
          throw new P12Error(P12_CODES.unsupported, `p12: prf ${prfOid}`);
        }
      }
    }
  }
  if (keyLen !== aesLen / 8) {
    // keyLength must match the AES variant we are about to use.
    keyLen = aesLen / 8;
  }
  const api = subtle();
  const base = await api.importKey(
    "raw",
    utf8(password) as unknown as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const keyBytes = await api.deriveBits(
    { name: "PBKDF2", hash, salt: salt as unknown as ArrayBuffer, iterations },
    base,
    keyLen * 8
  );
  const key = await api.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "AES-CBC", length: aesLen },
    false,
    ["decrypt"]
  );
  try {
    const pt = await api.decrypt(
      { name: "AES-CBC", iv: iv as unknown as ArrayBuffer },
      key,
      ciphertext as unknown as ArrayBuffer
    );
    return new Uint8Array(pt);
  } catch {
    throw new P12Error(P12_CODES.password, "p12: pbes2 padding");
  }
}

/**
 * Legacy PKCS#12 PBE decrypt (3DES / RC2-40 / RC2-128) with the
 * RFC 7292 appendix B KDF (ids: 1 = key, 2 = iv).
 */
function legacyPbeDecrypt(
  algo: Algo,
  password: string,
  ciphertext: Uint8Array
): Uint8Array {
  if (algo.params[0] === undefined || algo.params[0]!.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "p12: legacy params");
  }
  const kids = readChildren(algo.params[0]!);
  if (kids.length < 2 || kids[0]!.tag !== 0x04 || kids[1]!.tag !== 0x02) {
    throw new P12Error(P12_CODES.notP12, "p12: legacy params shape");
  }
  const salt = octets(kids[0]!);
  const iterations = intValue(kids[1]!);
  let keyLen: number;
  const ivLen = 8;
  let run: (data: Uint8Array, iv: Uint8Array, key: Uint8Array) => Uint8Array;
  switch (algo.oid) {
    case OID_PBE_3DES:
      keyLen = 24;
      run = des3CbcDecrypt;
      break;
    case OID_PBE_RC2_40:
      keyLen = 5;
      run = (data, iv, key) => rc2CbcDecrypt(data, iv, rc2Expand(key, 40));
      break;
    case OID_PBE_RC2_128:
      keyLen = 16;
      run = (data, iv, key) => rc2CbcDecrypt(data, iv, rc2Expand(key, 128));
      break;
    default:
      throw new P12Error(P12_CODES.unsupported, `p12: legacy ${algo.oid}`);
  }
  // RFC 7292 §B.2 + OpenSSL's PKCS12_key_gen_uni: the key (id 1) and the
  // IV (id 2) are TWO SEPARATE derivations — never one concatenated run
  // (the id byte feeds the D seed, so a combined stream is a wrong key).
  const key = pkcs12Kdf("sha1", password, salt, 1, iterations, keyLen);
  const iv = pkcs12Kdf("sha1", password, salt, 2, iterations, ivLen);
  const pt = run(ciphertext, iv, key);
  const stripped = stripPkcs7(pt, 8);
  if (stripped === null) {
    throw new P12Error(P12_CODES.password, "p12: legacy padding");
  }
  return stripped;
}

/** Decrypts one EncryptedContentInfo-style blob by algorithm family. */
async function decryptByAlgo(
  algo: Algo,
  password: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  if (algo.oid === OID_PBES2) return pbes2Decrypt(algo, password, ciphertext);
  return legacyPbeDecrypt(algo, password, ciphertext);
}

/* ------------------------------------------------------------------ */
/* X.509 TBS summary                                                   */
/* ------------------------------------------------------------------ */

export interface X509Summary {
  subjectCn: string;
  subjectO: string;
  issuerCn: string;
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
}

/** Reads CN/O/serial/validity from a certificate's TBS. */
export function summarizeCert(certDer: Uint8Array): X509Summary {
  const cert = readSingle(certDer);
  if (cert.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "x509: not a SEQUENCE");
  }
  const certKids = readChildren(cert);
  if (certKids.length < 3 || certKids[0]!.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "x509: short cert");
  }
  const kids = readChildren(certKids[0]!);
  let idx = 0;
  if (kids[0]!.tag === 0xa0) idx = 1; // [0] EXPLICIT version
  const serial = intBytes(kids[idx]!);
  let serialHex = "";
  for (const b of serial) serialHex += b.toString(16).padStart(2, "0");
  if (serialHex.startsWith("00")) serialHex = serialHex.slice(2);
  const issuerTlv = kids[idx + 2]!;
  const validity = readChildren(kids[idx + 3]!);
  if (validity.length < 2) {
    throw new P12Error(P12_CODES.notP12, "x509: validity");
  }
  const subjectTlv = kids[idx + 4]!;
  return {
    subjectCn: nameAttr(subjectTlv, OID_CN),
    subjectO: nameAttr(subjectTlv, OID_O),
    issuerCn: nameAttr(issuerTlv, OID_CN),
    serialHex,
    notBefore: asn1Time(validity[0]!),
    notAfter: asn1Time(validity[1]!),
  };
}

/** One attribute (CN / O) out of an X.501 Name RDNSequence. */
function nameAttr(nameTlv: DerTlv, oid: string): string {
  if (nameTlv.tag !== 0x30) return "";
  for (const rdn of readChildren(nameTlv)) {
    if (rdn.tag !== 0x31) continue; // SET OF
    for (const atv of readChildren(rdn)) {
      if (atv.tag !== 0x30) continue;
      const kids = readChildren(atv);
      if (
        kids.length === 2 &&
        kids[0]!.tag === 0x06 &&
        oidText(kids[0]!) === oid
      ) {
        try {
          return directoryString(kids[1]!).trim();
        } catch {
          return "";
        }
      }
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* PKCS#8 key extraction                                               */
/* ------------------------------------------------------------------ */

/**
 * Accepts a decrypted PKCS#8 PrivateKeyInfo. RSA only (the RSA-PSS /
 * ECDSA variants would need different CMS signature algorithms —
 * honestly rejected instead of half-working). Returns the PKCS#8 DER
 * as-is for subtle.importKey("pkcs8", …).
 */
export function checkRsaPkcs8(pkcs8: Uint8Array): void {
  const info = readSingle(pkcs8);
  if (info.tag !== 0x30) {
    throw new P12Error(P12_CODES.password, "p12: pkcs8 shape");
  }
  const kids = readChildren(info);
  if (kids.length < 3) {
    throw new P12Error(P12_CODES.password, "p12: pkcs8 short");
  }
  const alg = kids[1]!;
  if (alg.tag !== 0x30) {
    throw new P12Error(P12_CODES.password, "p12: pkcs8 alg");
  }
  const algKids = readChildren(alg);
  if (
    algKids[0] === undefined ||
    algKids[0]!.tag !== 0x06 ||
    oidText(algKids[0]!) !== OID_RSA_ENCRYPTION
  ) {
    throw new P12Error(P12_CODES.notRsa, "p12: non-rsa key");
  }
}

/* ------------------------------------------------------------------ */
/* The main parse                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedP12 {
  /** Decrypted PKCS#8 RSA private key (ready for subtle.importKey). */
  pkcs8: Uint8Array;
  /** The DER of the certificate that matches the key (first x509 certBag). */
  certDer: Uint8Array;
  /** Every x509 cert found in the bags (signer first, then the rest). */
  allCerts: Uint8Array[];
  summary: X509Summary;
  /** The MAC algorithm that guarded the file (for the result card). */
  macAlgo: ShaName | null;
  /** True when the outer SafeContents layer was PBES2 (modern pack). */
  modern: boolean;
}

/**
 * Parses + decrypts a .p12/.pfx: MAC-verify, walk the AuthenticatedSafe,
 * decrypt every layer (PBES2 via WebCrypto, legacy PBE via ciphers.ts),
 * then decrypt the shrouded keybag into PKCS#8. Structural DER failures
 * surface as ds.errNotP12 (never a raw parse crash).
 */
export async function parsePkcs12(
  bytes: Uint8Array,
  password: string
): Promise<ParsedP12> {
  try {
    return await parsePkcs12Inner(bytes, password);
  } catch (error) {
    if (error instanceof P12Error) throw error;
    if (error instanceof DerParseError) {
      throw new P12Error(P12_CODES.notP12, `p12: der ${error.message}`);
    }
    throw error;
  }
}

async function parsePkcs12Inner(
  bytes: Uint8Array,
  password: string
): Promise<ParsedP12> {
  const pfx = readSingle(bytes);
  if (pfx.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "p12: not a SEQUENCE");
  }
  const top = readChildren(pfx);
  if (top.length < 2 || top[0]!.tag !== 0x02) {
    throw new P12Error(P12_CODES.notP12, "p12: version");
  }
  const authSafeInfo = top[1]!;
  if (authSafeInfo.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "p12: authSafe");
  }
  const infoKids = readChildren(authSafeInfo);
  if (
    infoKids.length < 2 ||
    infoKids[0]!.tag !== 0x06 ||
    oidText(infoKids[0]!) !== OID_DATA
  ) {
    throw new P12Error(P12_CODES.notP12, "p12: authSafe contentType");
  }
  const inner = explicitInner(infoKids[1]!);
  if (inner.tag !== 0x04) {
    throw new P12Error(P12_CODES.notP12, "p12: authSafe content");
  }
  const authSafeDer = octets(inner);

  // --- MAC integrity (the honest wrong-password check) ----------------
  let macAlgo: ShaName | null = null;
  if (top[2] !== undefined && top[2]!.tag === 0x30) {
    const macKids = readChildren(top[2]!);
    if (macKids.length >= 2) {
      const digestInfo = readChildren(macKids[0]!);
      if (digestInfo.length === 2 && digestInfo[0]!.tag === 0x30) {
        const alg = readChildren(digestInfo[0]!);
        const expected = digestInfo[1]!.tag === 0x04 ? octets(digestInfo[1]!) : null;
        const macSaltTlv = macKids[1]!;
        if (
          alg.length >= 1 &&
          alg[0]!.tag === 0x06 &&
          expected !== null &&
          macSaltTlv.tag === 0x04
        ) {
          const macOid = oidText(alg[0]!);
          const algo: ShaName | null =
            macOid === OID_HMAC_SHA1 || macOid === OID_DIGEST_SHA1
              ? "sha1"
              : macOid === OID_HMAC_SHA256 || macOid === OID_DIGEST_SHA256
                ? "sha256"
                : macOid === OID_HMAC_SHA512 || macOid === OID_DIGEST_SHA512
                  ? "sha512"
                  : null;
          if (algo === null) {
            throw new P12Error(P12_CODES.unsupported, `p12: mac ${macOid}`);
          }
          const macSalt = octets(macSaltTlv);
          let iterations = 1;
          if (macKids[2] !== undefined && macKids[2]!.tag === 0x02) {
            iterations = Math.max(1, intValue(macKids[2]!));
          }
          const hashLen = algo === "sha1" ? 20 : algo === "sha256" ? 32 : 64;
          const macKey = pkcs12Kdf(algo, password, macSalt, 3, iterations, hashLen);
          const digest = pureHmac(algo, macKey, authSafeDer);
          macAlgo = algo;
          if (!bytesEqual(digest, expected)) {
            throw new P12Error(P12_CODES.password, "p12: mac mismatch");
          }
        }
      }
    }
  }

  // --- AuthenticatedSafe → SafeContents --------------------------------
  const safeContentsList: Uint8Array[] = [];
  let sawModern = false;
  for (const ci of seqChildren(authSafeDer)) {
    const ciKids = readChildren(ci);
    if (ciKids.length < 2 || ciKids[0]!.tag !== 0x06) {
      throw new P12Error(P12_CODES.notP12, "p12: contentInfo shape");
    }
    const contentType = oidText(ciKids[0]!);
    if (contentType === OID_DATA) {
      const payload = explicitInner(ciKids[1]!);
      if (payload.tag !== 0x04) {
        throw new P12Error(P12_CODES.notP12, "p12: data content");
      }
      safeContentsList.push(octets(payload));
    } else if (contentType === OID_ENCRYPTED_DATA) {
      const encData = explicitInner(ciKids[1]!);
      if (encData.tag !== 0x30) {
        throw new P12Error(P12_CODES.notP12, "p12: EncryptedData");
      }
      const encKids = readChildren(encData);
      if (encKids.length < 2) {
        throw new P12Error(P12_CODES.notP12, "p12: EncryptedData short");
      }
      const encInfo = readChildren(encKids[1]!);
      if (
        encInfo.length < 3 ||
        encInfo[0]!.tag !== 0x06 ||
        oidText(encInfo[0]!) !== OID_DATA
      ) {
        throw new P12Error(P12_CODES.notP12, "p12: encInfo");
      }
      const algo = readAlgo(encInfo, 1);
      const ciphertext = contentBytes(encInfo[2]!);
      const plain = await decryptByAlgo(algo, password, ciphertext);
      if (algo.oid === OID_PBES2) sawModern = true;
      safeContentsList.push(plain);
    } else {
      throw new P12Error(P12_CODES.unsupported, `p12: layer ${contentType}`);
    }
  }
  if (safeContentsList.length === 0) {
    throw new P12Error(P12_CODES.notP12, "p12: no SafeContents");
  }

  // --- SafeBags ---------------------------------------------------------
  let pkcs8: Uint8Array | null = null;
  const certs: Uint8Array[] = [];
  for (const sc of safeContentsList) {
    for (const bag of seqChildren(sc)) {
      const bagKids = readChildren(bag);
      if (bagKids.length < 2 || bagKids[0]!.tag !== 0x06) {
        throw new P12Error(P12_CODES.notP12, "p12: bag shape");
      }
      const bagId = oidText(bagKids[0]!);
      if (bagKids[1]!.tag !== 0xa0) {
        throw new P12Error(P12_CODES.notP12, "p12: bagValue");
      }
      const value = explicitInner(bagKids[1]!);
      if (bagId === OID_BAG_PKCS8_SHROUDED && pkcs8 === null) {
        // EncryptedPrivateKeyInfo { encryptionAlgorithm, encryptedData }
        const epi = readChildren(value);
        if (epi.length < 2) {
          throw new P12Error(P12_CODES.notP12, "p12: EPI short");
        }
        const algo = readAlgo(epi, 0);
        if (epi[1]!.tag !== 0x04) {
          throw new P12Error(P12_CODES.notP12, "p12: EPI data");
        }
        const key = await decryptByAlgo(algo, password, octets(epi[1]!));
        checkRsaPkcs8(key);
        pkcs8 = key;
      } else if (bagId === OID_BAG_CERT) {
        const certBag = readChildren(value);
        if (
          certBag.length >= 2 &&
          certBag[0]!.tag === 0x06 &&
          oidText(certBag[0]!) === OID_CERT_X509
        ) {
          const cert = explicitInner(certBag[1]!);
          if (cert.tag === 0x04) certs.push(octets(cert));
        }
      }
      // keyBag / crlBag / secretBag / safeContentsBag — skipped.
    }
  }

  if (pkcs8 === null) {
    throw new P12Error(P12_CODES.noKey, "p12: no shrouded key bag");
  }
  if (certs.length === 0) {
    throw new P12Error(P12_CODES.notP12, "p12: no certificate");
  }
  return {
    pkcs8,
    certDer: certs[0]!,
    allCerts: certs,
    summary: summarizeCert(certs[0]!),
    macAlgo,
    modern: sawModern,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Cert helpers for the CMS builder                                     */
/* ------------------------------------------------------------------ */

/** IssuerAndSerialNumber DER for a certificate (byte-exact issuer copy). */
export function issuerAndSerial(certDer: Uint8Array): Uint8Array {
  const cert = readSingle(certDer);
  const kids = readChildren(cert);
  if (kids.length < 2 || kids[0]!.tag !== 0x30) {
    throw new P12Error(P12_CODES.notP12, "x509: tbs");
  }
  const tbs = readChildren(kids[0]!);
  if (tbs.length < 3) {
    throw new P12Error(P12_CODES.notP12, "x509: tbs short");
  }
  let idx = 0;
  if (tbs[0]!.tag === 0xa0) idx = 1; // [0] EXPLICIT version
  const issuerTlv = tbs[idx + 2]!;
  const issuer = derTlv(issuerTlv.tag, issuerTlv.value);
  const serial = derTlv(0x02, intBytes(tbs[idx]!));
  return derTlv(0x30, concat2(issuer, serial));
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
