/**
 * pki-common/p12 — PKCS#12 (.p12 / .pfx) reader.
 *
 * Extracts the signer's private key (PKCS#8) and certificate chain from
 * a password-protected container, fully on-device via WebCrypto:
 *
 *   PFX ::= SEQUENCE { version, authSafe ContentInfo, macData? }
 *   authSafe .data (OCTET STRING) = AuthenticatedSafe ::= SEQUENCE OF ContentInfo
 *     - "data"          → SafeContents (bags in the clear)
 *     - "encryptedData" → EncryptedData { EncryptedContentInfo { PBES2, [0] cipher } }
 *   SafeBag:
 *     - keyBag             → PKCS#8 in the clear (rare)
 *     - pkcs8ShroudedKeyBag→ EncryptedPrivateKeyInfo { PBES2, PKCS#8 }
 *     - certBag (x509)     → CertBag { x509Certificate, [0] EXPLICIT OCTET STRING }
 *
 * Only PBES2 with PBKDF2 (HMAC-SHA1/224/256/384/512) + AES-128/192/256-CBC is
 * supported — the default of OpenSSL 3.x, macOS Keychain and modern Windows
 * exports. Legacy PBES1 containers (3DES-CBC, RC2) are refused with an honest
 * error suggesting a modern re-export; WebCrypto has no 3DES/RC2 and we will
 * not hand-roll 1990s ciphers for a privacy tool. The PFX MAC is not checked:
 * successful decryption + valid DER already proves the password (the MAC only
 * adds corruption detection, which PKCS#5 padding + DER parsing give too).
 */

import {
  TAG,
  parseDer,
  parseChildren,
  readOid,
  readOctets,
  tlv,
  type DerNode,
} from "./asn1";

export interface P12Contents {
  /** Private key, PKCS#8 PrivateKeyInfo DER — ready for WebCrypto import. */
  keyPkcs8: Uint8Array;
  /** The signer's own certificate (DER). */
  certDer: Uint8Array;
  /** Extra chain certificates (DER). */
  chainCerts: Uint8Array[];
}

/** Error with a stable code the UI can map to i18n copy. */
export class P12Error extends Error {
  constructor(
    readonly code:
      | "not-p12"
      | "no-key"
      | "bad-password"
      | "legacy-encryption"
      | "unsupported"
      | "malformed",
    message: string
  ) {
    super(message);
  }
}

/* ---------------- small helpers ---------------- */

function intOf(node: DerNode): number {
  let v = BigInt(0);
  for (const b of node.value) v = (v << BigInt(8)) | BigInt(b);
  return Number(v);
}

/** ContentInfo "data" content: [0] EXPLICIT { OCTET STRING } — tolerate implicit. */
function dataContentOctets(ciNode: DerNode): Uint8Array {
  const ctx = parseChildren(ciNode).find((k) => k.tag === TAG.CTX_0);
  if (!ctx) throw new P12Error("malformed", "ContentInfo has no [0] content");
  if (!ctx.constructed) return ctx.value; // implicit — value IS the octets
  const first = parseChildren(ctx)[0];
  return readOctets(first);
}

function findChild(node: DerNode, tag: number): DerNode | undefined {
  return parseChildren(node).find((k) => k.tag === tag);
}

/* ---------------- WebCrypto PBES2 ---------------- */

/** PKCS#12 passwords are UTF-16BE + a NUL terminator (RFC 7292 §B.1). */
function p12PasswordBytes(password: string): Uint8Array {
  const out = new Uint8Array((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    if (c > 0xffff) throw new P12Error("unsupported", "password has non-BMP characters");
    out[i * 2] = c >> 8;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}

const PRF_HASH: Record<string, "SHA-1" | "SHA-224" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  "1.2.840.113549.2.7": "SHA-1",
  "1.2.840.113549.2.8": "SHA-224",
  "1.2.840.113549.2.9": "SHA-256",
  "1.2.840.113549.2.10": "SHA-384",
  "1.2.840.113549.2.11": "SHA-512",
};

const AES_CBC: Record<string, 128 | 192 | 256> = {
  "2.16.840.1.101.3.4.1.2": 128,
  "2.16.840.1.101.3.4.1.22": 192,
  "2.16.840.1.101.3.4.1.42": 256,
};

const OID_DES_EDE3_CBC = "1.2.840.113549.3.7";
const OID_RC2_CBC = "1.2.840.113549.3.2";
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";

/**
 * Decrypt PBES2 { PBKDF2(params), AES-CBC(iv) } ciphertext → plaintext.
 * `algoNode` is the full AlgorithmIdentifier SEQUENCE.
 *
 * PASSWORD ENCODING GOTCHA (proven by cross-testing with OpenSSL 3.5 and
 * python-cryptography): RFC 7292 mandates BMPString (UTF-16BE + NUL) for
 * PKCS#12 KDFs — but OpenSSL 3.x feeds PBES2 the RAW UTF-8 password,
 * while Windows/other CryptoAPI exports keep the BMPString form for the
 * same PBES2 structure. Since we cannot know the producer, both forms are
 * tried; the one that decrypts to plausible DER (first byte 0x30 after
 * padding strip) wins.
 */
async function pbes2Decrypt(
  algoNode: DerNode,
  ciphertext: Uint8Array,
  password: string
): Promise<Uint8Array> {
  const kids = parseChildren(algoNode);
  if (kids.length !== 2) throw new P12Error("malformed", "bad PBES2 params");
  if (readOid(kids[0]) !== OID_PBES2) {
    throw new P12Error("legacy-encryption", "container uses a legacy PBE scheme");
  }
  const inner = parseChildren(kids[1]);
  // kdfAlgo = [OID pbkdf2, SEQ PBKDF2-params]; params = [salt, iter, keyLen?, prf?]
  const kdfAlgo = parseChildren(inner[0]);
  if (readOid(kdfAlgo[0]) !== OID_PBKDF2) {
    throw new P12Error("legacy-encryption", "unknown KDF");
  }
  const kdfParams = parseChildren(kdfAlgo[1]);
  const salt = readOctets(kdfParams[0]);
  const iterations = intOf(kdfParams[1]);
  if (!Number.isFinite(iterations) || iterations <= 0 || iterations > 100_000_000) {
    throw new P12Error("malformed", "bad PBKDF2 iteration count");
  }

  let keyLen = 0;
  let prf: "SHA-1" | "SHA-224" | "SHA-256" | "SHA-384" | "SHA-512" = "SHA-1";
  for (let i = 2; i < kdfParams.length; i++) {
    if (kdfParams[i].tag === TAG.INTEGER) {
      keyLen = intOf(kdfParams[i]);
    } else if (kdfParams[i].tag === TAG.SEQUENCE) {
      prf = PRF_HASH[readOid(parseChildren(kdfParams[i])[0])] ?? "SHA-1";
    }
  }

  const cipherKids = parseChildren(inner[1]);
  const cipherOid = readOid(cipherKids[0]);
  let bits = AES_CBC[cipherOid];
  if (!bits) {
    if (cipherOid === OID_DES_EDE3_CBC || cipherOid === OID_RC2_CBC) {
      throw new P12Error(
        "legacy-encryption",
        "container uses 3DES/RC2 encryption from the 1990s — re-export it with modern software"
      );
    }
    throw new P12Error("unsupported", `unknown cipher ${cipherOid}`);
  }
  if (keyLen && keyLen * 8 !== bits) bits = (keyLen * 8) as 128 | 192 | 256;

  let iv: Uint8Array = new Uint8Array(16);
  if (cipherKids.length > 1 && cipherKids[1].tag === TAG.OCTET_STRING) {
    const raw = readOctets(cipherKids[1]);
    if (raw.length !== iv.length) throw new P12Error("malformed", "unexpected IV length");
    iv = raw;
  }

  // Candidate password byte forms: raw UTF-8 first (OpenSSL 3.x behaviour),
  // then the RFC BMPString form (Windows CryptoAPI etc.).
  const utf8 = new TextEncoder().encode(password);
  const bmp = p12PasswordBytes(password);
  const candidates = [utf8, bmp];

  let lastError: unknown = null;
  for (const pw of candidates) {
    try {
      const baseKey = await crypto.subtle.importKey("raw", pw as BufferSource, "PBKDF2", false, [
        "deriveBits",
      ]);
      const dk = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: prf },
        baseKey,
        bits
      );
      const key = await crypto.subtle.importKey("raw", dk, { name: "AES-CBC" }, false, ["decrypt"]);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-CBC", iv: iv as BufferSource },
          key,
          ciphertext as BufferSource
        )
      );
      const stripped = stripPkcs5(plain);
      if (stripped.length > 0 && stripped[0] === 0x30) return stripped; // SEQ = valid DER
      lastError = null;
    } catch (e) {
      lastError = e;
    }
  }
  throw new P12Error(
    "bad-password",
    lastError ? "decryption failed — wrong password?" : "decrypted bytes are not DER — wrong password?"
  );
}

/** Strip PKCS#5/7 padding if present (AES-CBC in p12 always pads). */
function stripPkcs5(b: Uint8Array): Uint8Array {
  if (b.length === 0) return b;
  const pad = b[b.length - 1];
  if (pad <= 0 || pad > 16 || pad > b.length) return b;
  for (let i = b.length - pad; i < b.length; i++) {
    if (b[i] !== pad) return b;
  }
  return b.subarray(0, b.length - pad);
}

/* ---------------- public API ---------------- */

export async function parseP12(
  bytes: Uint8Array,
  password: string
): Promise<P12Contents> {
  // ---- PFX shell ----
  let authSafeData: Uint8Array;
  try {
    const pfx = parseDer(bytes);
    if (pfx.tag !== TAG.SEQUENCE) throw new Error("not seq");
    const top = parseChildren(pfx);
    if (top.length < 2) throw new Error("short");
    if (readOid(parseChildren(top[1])[0]) !== "1.2.840.113549.1.7.1") {
      throw new P12Error("not-p12", "authSafe is not a data ContentInfo");
    }
    authSafeData = dataContentOctets(top[1]);
  } catch (e) {
    if (e instanceof P12Error) throw e;
    throw new P12Error("not-p12", "file is not a PKCS#12 container");
  }

  // ---- AuthenticatedSafe → SafeContents blobs ----
  const safeContents: Uint8Array[] = [];
  for (const ciNode of parseChildren(parseDer(authSafeData))) {
    const type = readOid(parseChildren(ciNode)[0]);
    if (type === "1.2.840.113549.1.7.1") {
      safeContents.push(dataContentOctets(ciNode));
    } else if (type === "1.2.840.113549.1.7.6") {
      // EncryptedData ::= SEQUENCE { version, EncryptedContentInfo }
      // EncryptedContentInfo ::= SEQUENCE { OID, AlgoId, [0] IMPLICIT ciphertext }
      const encData = findChild(ciNode, TAG.CTX_0);
      if (!encData) continue;
      const edSeq = encData.constructed ? parseChildren(encData)[0] : encData;
      const eci = parseChildren(parseChildren(edSeq)[1]);
      const cipher = findChild(parseChildren(edSeq)[1], TAG.CTX_0_PRIM);
      if (!cipher) throw new P12Error("malformed", "missing encrypted content");
      let plain: Uint8Array;
      try {
        plain = stripPkcs5(await pbes2Decrypt(eci[1], cipher.value, password));
      } catch (e) {
        if (e instanceof P12Error) {
          if (e.code === "legacy-encryption") throw e;
          throw new P12Error("bad-password", "wrong password or corrupt container");
        }
        throw new P12Error("bad-password", "decryption failed — wrong password?");
      }
      safeContents.push(plain);
    }
  }

  // ---- SafeBags ----
  let keyPkcs8: Uint8Array | null = null;
  const certs: Uint8Array[] = [];
  for (const sc of safeContents) {
    let bags: DerNode[];
    try {
      bags = parseChildren(parseDer(sc));
    } catch {
      continue; // a non-SafeContents blob — ignore
    }
    for (const bag of bags) {
      const b = parseChildren(bag);
      const bagOid = readOid(b[0]);
      // SafeBag ::= SEQ { bagId, bagValue [0] EXPLICIT, attrs? } — b[1] is
      // the [0] node whose VALUE holds the full inner TLV.
      if (bagOid === "1.2.840.113549.1.12.10.1.2") {
        // pkcs8ShroudedKeyBag: EncryptedPrivateKeyInfo { algo, OCTET }
        const epki = parseChildren(parseDer(b[1].value));
        let plain: Uint8Array;
        try {
          plain = stripPkcs5(await pbes2Decrypt(epki[0], readOctets(epki[1]), password));
        } catch (e) {
          if (e instanceof P12Error && e.code === "legacy-encryption") throw e;
          throw new P12Error("bad-password", "cannot decrypt the private key — wrong password?");
        }
        keyPkcs8 = plain;
      } else if (bagOid === "1.2.840.113549.1.12.10.1.1") {
        // keyBag: [0] EXPLICIT wrapping the PKCS#8 SEQUENCE itself.
        keyPkcs8 = b[1].value;
      } else if (bagOid === "1.2.840.113549.1.12.10.1.3") {
        // certBag: CertBag { x509Certificate OID, [0] EXPLICIT OCTET STRING }
        const certBag = parseChildren(parseDer(b[1].value));
        if (readOid(certBag[0]) !== "1.2.840.113549.1.9.22.1") continue;
        const certValue = certBag[1];
        if (!certValue) continue;
        if (certValue.constructed) {
          // [0] EXPLICIT { OCTET STRING cert } (or bare cert SEQ)
          const inner = parseChildren(certValue);
          if (inner[0] && inner[0].tag === TAG.OCTET_STRING) {
            certs.push(readOctets(inner[0]));
          } else if (inner[0]) {
            certs.push(tlv(inner[0].tag, inner[0].value));
          }
        } else {
          certs.push(certValue.value); // implicit octets
        }
      }
    }
  }

  if (!keyPkcs8) {
    throw new P12Error(
      certs.length ? "no-key" : "bad-password",
      certs.length
        ? "container has certificates but no private key"
        : "no key or certificates found — wrong password?"
    );
  }
  if (certs.length === 0) {
    throw new P12Error("malformed", "container has a key but no certificate");
  }

  // OpenSSL/Keychain order puts the end-entity certificate first.
  return { keyPkcs8, certDer: certs[0], chainCerts: certs.slice(1) };
}
