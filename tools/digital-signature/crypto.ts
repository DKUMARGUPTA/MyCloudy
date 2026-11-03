/**
 * Digital signature (RB6-a) — the WebCrypto bridge.
 *
 * Everything that touches cryptography lives here so the pure model
 * stays bun-testable and the surface can verify a certificate on the
 * main thread with the exact same code path the worker signs with:
 *
 * - p12Decrypt(model-parsed layers, password): PBKDF2 deriveBits →
 *   AES-CBC decrypt (WebCrypto both strips and validates the PKCS#7
 *   padding — a wrong password fails here, honestly) → decrypted
 *   SafeContents re-parsed by the model → { certDer, keyPkcs8 }.
 * - importSigningKey(pkcs8): RSASSA-PKCS1-v1_5/SHA-256 first, ECDSA
 *   (P-256/384/521, curve read from the PKCS#8 itself) second.
 * - signAttrs(key, attrsDer): the CMS signature over the DER of the
 *   signed attributes SET (ECDSA raw r||s → DER SEQUENCE conversion,
 *   because WebCrypto returns the IEEE 1363 form while CMS wants X.509).
 *
 * The password never leaves the tab: it rides the in-memory worker
 * message (structured clone) and is dropped when the run ends.
 */

import {
  OIDS,
  children,
  parseSafeContents,
  readNode,
  readOid,
} from "./model";
import {
  DSIG_ERRORS,
  DsigError,
  type DecryptedP12,
  type Pbes2Scheme,
  type ParsedP12,
} from "./types";

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new DsigError(DSIG_ERRORS.generic, "WebCrypto unavailable");
  }
  return c.subtle;
};

/* ------------------------------------------------------------------ */
/* PBES2 decryption                                                    */
/* ------------------------------------------------------------------ */

const AES_BITS: Record<Pbes2Scheme["cipher"], number> = {
  aes128: 128,
  aes192: 192,
  aes256: 256,
};

/** PBKDF2 (per the parsed prf) → AES-CBC key bytes. */
async function deriveAesKey(
  scheme: Pbes2Scheme,
  password: string
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      salt: scheme.salt as unknown as BufferSource,
      iterations: scheme.iterations,
      hash: scheme.prf === "sha256" ? "SHA-256" : "SHA-1",
    },
    material,
    AES_BITS[scheme.cipher]
  );
  return subtle().importKey(
    "raw",
    bits,
    { name: "AES-CBC", length: AES_BITS[scheme.cipher] },
    false,
    ["decrypt"]
  );
}

/**
 * AES-CBC decrypt with WebCrypto's built-in PKCS#7 validation: a wrong
 * password makes the padding check (or the DER re-parse) fail → the
 * honest errBadPassword.
 */
export async function aesCbcDecrypt(
  scheme: Pbes2Scheme,
  password: string,
  data: Uint8Array
): Promise<Uint8Array> {
  const key = await deriveAesKey(scheme, password);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-CBC", iv: scheme.iv as unknown as BufferSource },
      key,
      data as unknown as BufferSource
    );
    return new Uint8Array(plain);
  } catch {
    throw new DsigError(DSIG_ERRORS.badPassword);
  }
}

/* ------------------------------------------------------------------ */
/* p12 → { certDer, keyPkcs8 }                                        */
/* ------------------------------------------------------------------ */

/** Decrypts every modern layer; legacy layers fail honestly. */
export async function p12Decrypt(
  parsed: ParsedP12,
  password: string
): Promise<DecryptedP12> {
  const certDers: { certDer: Uint8Array; localKeyId: Uint8Array | null }[] = [];
  let keyPkcs8: Uint8Array | null = null;
  let keyId: Uint8Array | null = null;

  for (const layer of parsed.layers) {
    let bags;
    if (layer.kind === "plain") {
      bags = layer.bags;
    } else {
      if (layer.scheme.kind !== "pbes2") {
        throw new DsigError(
          DSIG_ERRORS.legacyEncryption,
          layer.scheme.cipher
        );
      }
      const plain = await aesCbcDecrypt(layer.scheme, password, layer.encrypted);
      try {
        bags = parseSafeContents(plain);
      } catch (error) {
        if (error instanceof DsigError && error.code === DSIG_ERRORS.badPassword) {
          throw error;
        }
        // decrypted-but-not-DER: the password was wrong (AES padding can
        // pass by luck once in 2^128 — the structure check catches it)
        throw new DsigError(DSIG_ERRORS.badPassword);
      }
    }

    for (const bag of bags) {
      if (bag.kind === "cert") {
        certDers.push({ certDer: bag.certDer, localKeyId: bag.localKeyId });
      } else if (bag.kind === "shroudedKey") {
        if (bag.scheme.kind !== "pbes2") {
          throw new DsigError(
            DSIG_ERRORS.legacyEncryption,
            bag.scheme.cipher
          );
        }
        const pkcs8 = await aesCbcDecrypt(bag.scheme, password, bag.encrypted);
        const shape = readNode(pkcs8, 0);
        if (shape === null || shape.num !== 0x10 || shape.cls !== 0) {
          // decrypted-but-not-PKCS#8: wrong password (padding passed by luck)
          throw new DsigError(DSIG_ERRORS.badPassword);
        }
        keyPkcs8 = pkcs8;
        keyId = bag.localKeyId;
      } else if (bag.kind === "key") {
        keyPkcs8 = bag.pkcs8;
        keyId = bag.localKeyId;
      }
    }
  }

  if (certDers.length === 0) {
    throw new DsigError(DSIG_ERRORS.corruptP12, "no certificate bag");
  }
  if (keyPkcs8 === null) {
    throw new DsigError(DSIG_ERRORS.corruptP12, "no private key bag");
  }

  // localKeyId match (leaf vs chain) — fall back to the first cert bag.
  let certDer = certDers[0].certDer;
  if (keyId !== null) {
    const match = certDers.find(
      (c) =>
        c.localKeyId !== null &&
        c.localKeyId.length === keyId!.length &&
        c.localKeyId.every((b, i) => b === keyId![i])
    );
    if (match) certDer = match.certDer;
  }

  return { certDer, keyPkcs8 };
}

/* ------------------------------------------------------------------ */
/* Signing key import                                                  */
/* ------------------------------------------------------------------ */

export interface SigningKey {
  key: CryptoKey;
  algorithm: "rsa" | "ec";
}

/** Curve OID → WebCrypto namedCurve (from the PKCS#8 parameters). */
function curveOfPkcs8(pkcs8: Uint8Array): string | null {
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER, alg AlgID, key OCTET }
  const root = readNode(pkcs8, 0);
  if (root === null || root.num !== 0x10) return null; // SEQUENCE tag number
  const kids = children(pkcs8, root);
  if (kids.length < 2 || kids[1].num !== 0x10) return null;
  const alg = children(pkcs8, kids[1]);
  if (alg.length < 1) return null;
  if (readOid(pkcs8, alg[0]) !== OIDS.ecPublicKey) return null;
  if (alg.length < 2 || alg[1].num !== 0x06) return null;
  const curve = readOid(pkcs8, alg[1]);
  if (curve === "1.2.840.10045.3.1.7") return "P-256";
  if (curve === "1.3.132.0.34") return "P-384";
  if (curve === "1.3.132.0.35") return "P-521";
  return null;
}

/** RSA (RSASSA-PKCS1-v1_5 + SHA-256) first, ECDSA second, honest error. */
export async function importSigningKey(
  pkcs8: Uint8Array
): Promise<SigningKey> {
  const data = pkcs8 as unknown as BufferSource;
  try {
    const key = await subtle().importKey(
      "pkcs8",
      data,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return { key, algorithm: "rsa" };
  } catch {
    /* fall through to ECDSA */
  }
  const namedCurve = curveOfPkcs8(pkcs8);
  if (namedCurve === null) {
    throw new DsigError(DSIG_ERRORS.unsupportedKey);
  }
  try {
    const key = await subtle().importKey(
      "pkcs8",
      data,
      { name: "ECDSA", namedCurve },
      false,
      ["sign"]
    );
    return { key, algorithm: "ec" };
  } catch {
    throw new DsigError(DSIG_ERRORS.unsupportedKey);
  }
}

/* ------------------------------------------------------------------ */
/* Signature over the signed attributes                               */
/* ------------------------------------------------------------------ */

/** Raw r||s → DER SEQUENCE { INTEGER r, INTEGER s } (RFC 5480). */
export function ecRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const rBytes = raw.slice(0, half);
  const sBytes = raw.slice(half);
  const intFrom = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let body = bytes.slice(start);
    if (body.length === 0 || body[0] >= 0x80) {
      body = new Uint8Array([0, ...body]);
    }
    const len = body.length;
    const lenBytes = len < 0x80 ? [len] : [0x81, len];
    return new Uint8Array([0x02, ...lenBytes, ...body]);
  };
  const r = intFrom(rBytes);
  const s = intFrom(sBytes);
  const body = [...r, ...s];
  const len = body.length;
  const lenBytes =
    len < 0x80 ? [len] : len < 0x100 ? [0x81, len] : [0x82, len >> 8, len & 0xff];
  return new Uint8Array([0x30, ...lenBytes, ...body]);
}

/**
 * Signs the DER-encoded signed-attributes SET (RFC 5652 §5.4: the
 * signature is computed over the complete DER of the SET OF Attribute).
 */
export async function signAttrs(
  signing: SigningKey,
  attrsDer: Uint8Array
): Promise<Uint8Array> {
  const data = attrsDer as unknown as BufferSource;
  if (signing.algorithm === "rsa") {
    const sig = await subtle().sign(
      "RSASSA-PKCS1-v1_5",
      signing.key,
      data
    );
    return new Uint8Array(sig);
  }
  const raw = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.key,
    data
  );
  return ecRawToDer(new Uint8Array(raw));
}

/* ------------------------------------------------------------------ */
/* Verification helper (smoke + surface preview card)                   */
/* ------------------------------------------------------------------ */

/**
 * Verifies a signature produced by this tool's own flow — the smoke's
 * cryptographic oracle (spki + SHA-256 digest + signature).
 */
export async function verifyRsaSha256(
  spkiDer: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      "spki",
      spkiDer as unknown as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return await subtle().verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as unknown as BufferSource,
      data as unknown as BufferSource
    );
  } catch {
    return false;
  }
}
