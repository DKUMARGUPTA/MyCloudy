/**
 * Smoke: digital-signature (RB6-FIN-a4 — the 94th tool, security) — the
 * honest on-device certificate-based PAdES signer.
 *
 * House conventions (smoke-request-signature / smoke-verify-pdf-signatures):
 * relative imports WITHOUT .ts, regenerator-runtime first (pdf.js),
 * plain check() helper, process.exit(0) at the end, count every check.
 *
 *  0. Wiring sanity (source-text checks — React files are not node-safe):
 *     configs/surfaces/registry entries, i18n parity + referenced keys.
 *  1. Model vectors — parseSignRun defensive coercion, names, the
 *     WinAnsi-vs-Noto rule, display geometry + block positions, dates,
 *     the byte surgeon on synthetic buffers (gap find, ByteRange values,
 *     digit patch incl. a pre-existing foreign /ByteRange, covered digest
 *     vs the node:crypto oracle, hex splice), estimateCmsLength == the
 *     real CMS length.
 *  2. Crypto round-trip — node:crypto RSA keypair → self-signed cert DER
 *     (the tool's own asn1.ts writer, createSign) + a CA-signed leaf →
 *     PKCS#12 packs (modern PBES2/AES-256 via WebCrypto, legacy 3DES +
 *     RC2-40 via node:crypto) → parsePkcs12 key/cert round-trips, wrong
 *     password / garbage / tamper honesty.
 *  3. REAL E2E through the worker (self-shimmed globalThis, fetch
 *     serving the self-hosted Noto TTF): a real 2-page pdf-lib input →
 *     the signed output reloaded with pdf-lib (real /FT /Sig field, /V
 *     dict, widget /Rect on the right page) and verified INDEPENDENTLY
 *     with node:crypto (ByteRange coverage, digest recompute ==
 *     messageDigest, createVerify over the 0xA0-retagged signedAttrs,
 *     embedded cert == the p12's cert) + the sibling verify tool
 *     (intact + cryptoVerified + CA-signed leaf green / self-signed
 *     amber); visible-block ink needles in the inflated content
 *     streams; invisible mode; Hindi reason → Noto FontFile2 +
 *     Identity-H + pdf.js Devanagari extraction; page picker + position
 *     presets; tamper vectors (covered-range flip → invalid, CMS hex
 *     flip → createVerify fails); rejection vectors (no asset, wrong
 *     password, garbage p12, empty file, garbage PDF, encrypted, no
 *     file); progress beats; parseRun/outputBaseName honesty.
 *
 * Run: bun scripts/smoke-digital-signature.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  createCipheriv,
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  BLOCK_H_PT,
  BLOCK_MARGIN_PT,
  BLOCK_POSITIONS,
  BLOCK_W_PT,
  DS_CODES,
  MAX_LOCATION_CHARS,
  MAX_REASON_CHARS,
  SIGN_KEYS,
  SIGN_LABELS_EN,
  byteRangeValues,
  clamp,
  coveredDigest,
  displayRectToUser,
  displaySize,
  estimateCmsLength,
  findContentsGap,
  formatSignDate,
  hasExistingSignature,
  isWinAnsiChar,
  labelOf,
  needsNoto,
  needsNotoChar,
  outputBaseName,
  parseSignRun,
  patchByteRangeDigits,
  pdfDateString,
  positionToDisplayRect,
  sanitizeText,
  sigFieldName,
  signedFileName,
  spliceContentsHex,
  splitTextRuns,
  type SignRun,
} from "../tools/digital-signature/model";
import { P12_CODES, parsePkcs12 } from "../tools/digital-signature/pkcs12";
import { buildDetachedSignedData } from "../tools/digital-signature/cms";
import { blockNeedsNoto, drawSignatureBlock, pdfTextStringValue } from "../tools/digital-signature/render";
import { analyzeSignatures } from "../tools/verify-pdf-signatures/model";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import toolI18n from "../tools/digital-signature/i18n.json";

/** Union-safe unwrapper — parseSignRun always answers ok:true (honest defaults). */
function runOf(r: ReturnType<typeof parseSignRun>): ReturnType<typeof parseSignRun> & { ok: true } {
  if (!r.ok) throw new Error("parseSignRun rejected: " + r.code);
  return r as ReturnType<typeof parseSignRun> & { ok: true };
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

const near = (a: number, b: number, eps = 0.01): boolean =>
  Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ */
/* House helpers                                                        */
/* ------------------------------------------------------------------ */

/** The house 3-way text needle (pdf-lib emits text as HEX TOKENS). */
function hasText(latin1: string, needle: string): boolean {
  if (latin1.includes(needle)) return true;
  const hex = Buffer.from(needle, "latin1").toString("hex").toUpperCase();
  if (hex.length < 8) return latin1.includes(needle);
  if (latin1.includes(`<${hex}>`)) return true;
  return latin1.toUpperCase().includes(hex);
}

/** All content streams of a reloaded page, inflated via node:zlib. */
function pageContentLatin1(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  const push = (s: unknown): void => {
    if (s instanceof PDFRawStream) streams.push(s);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) push(contents.lookup(i));
  } else push(contents);
  let out = "";
  for (const s of streams) {
    const filter = s.dict.get(PDFName.of("Filter"));
    const bytes = s.getContents();
    const inflated =
      filter !== undefined && filter.toString() === "/FlateDecode"
        ? inflateSync(bytes)
        : bytes;
    out += Buffer.from(inflated).toString("latin1");
  }
  return out;
}

function objDump(doc: PDFDocument): string {
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
}

interface ItemLike {
  str: string;
}

async function pdfjsFlatText(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const task = getDocument({ data, useSystemFonts: true });
  const pdf = await task.promise;
  const parts: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      parts.push((content.items as ItemLike[]).map((i) => i.str).join(" "));
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return parts.join("\n");
}

/** A minimal sign-run payload (surface serialization shape). */
function makeSign(overrides: {
  locale?: "en" | "hi";
  reason?: string;
  location?: string;
  page?: number;
  position?: string;
  visible?: boolean;
  labels?: Record<string, string>;
}): string {
  return JSON.stringify({
    locale: overrides.locale ?? "en",
    reason: overrides.reason ?? "",
    location: overrides.location ?? "",
    page: overrides.page ?? 0,
    position: overrides.position ?? "br",
    visible: overrides.visible ?? true,
    labels: overrides.labels ?? {},
  });
}

/* ================================================================== */
/* Fixture builders: keypair → cert → p12 (the tool's own asn1 writer)  */
/* ================================================================== */

import {
  derBitString,
  derCtx,
  derInt,
  derIntFromBytes,
  derNull,
  derOctets,
  derOid,
  derSeq,
  derSet,
  derTime,
  derTlv,
  intBytes,
  readChildren,
  readSingle,
  readTlv,
  oidText,
  octets,
} from "../tools/digital-signature/asn1";
import { pkcs12Kdf, pureHmac } from "../tools/digital-signature/sha";

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_RSA_ENC = "1.2.840.113549.1.1.1";
const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";
const OID_C = "2.5.4.6";

function printableRdn(oid: string, value: string): Uint8Array {
  return derSet(derSeq(derOid(oid), derTlv(0x13, new TextEncoder().encode(value))));
}

function nameRdn(cn: string, o: string): Uint8Array {
  return derSeq(
    printableRdn(OID_C, "IN"),
    printableRdn(OID_O, o),
    printableRdn(OID_CN, cn)
  );
}

interface KeyMat {
  pkcs8: Uint8Array;
  spki: Uint8Array;
}

function rsaKey(): KeyMat {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { pkcs8: new Uint8Array(privateKey as Buffer), spki: new Uint8Array(publicKey as Buffer) };
}

function spkiModulus(spki: Uint8Array): { n: Uint8Array; e: Uint8Array } {
  const seq = readChildren(readSingle(spki));
  const bits = seq[1]!;
  const pub = readTlv(bits.value.subarray(1), 0);
  const kids = readChildren(pub);
  return { n: intBytes(kids[0]!), e: intBytes(kids[1]!) };
}

interface CertMat {
  certDer: Uint8Array;
  key: KeyMat;
}

/**
 * A minimal X.509 v3 certificate: self-signed when signerKey/issuerName
 * are omitted, else signed by the given CA material.
 */
function buildCert(opts: {
  cn: string;
  o: string;
  key: KeyMat;
  notBefore: Date;
  notAfter: Date;
  signerKey?: KeyMat;
  issuerName?: Uint8Array;
}): CertMat {
  const serial = new Uint8Array(randomBytes(16));
  serial[0]! &= 0x7f;
  const sigAlg = derSeq(derOid(OID_SHA256_RSA), derNull());
  const subject = nameRdn(opts.cn, opts.o);
  const issuer = opts.issuerName ?? subject;
  const { n, e } = spkiModulus(opts.key.spki);
  const spkiBody = derSeq(
    derSeq(derOid(OID_RSA_ENC), derNull()),
    derBitString(derSeq(derIntFromBytes(n), derIntFromBytes(e)))
  );
  const tbs = derSeq(
    derCtx(0, derInt(2)),
    derIntFromBytes(serial),
    sigAlg,
    issuer,
    derSeq(derTime(opts.notBefore), derTime(opts.notAfter)),
    subject,
    spkiBody
  );
  const signer = createSign("RSA-SHA256");
  signer.update(Buffer.from(tbs));
  const sig = new Uint8Array(
    signer.sign({
      key: Buffer.from((opts.signerKey ?? opts.key).pkcs8),
      format: "der",
      type: "pkcs8",
    })
  );
  return { certDer: derSeq(tbs, sigAlg, derBitString(sig)), key: opts.key };
}

/* --- PKCS#12 packers (the same writer, both families) ---------------- */

const OID_DATA = "1.2.840.113549.1.7.1";
const OID_ENC_DATA = "1.2.840.113549.1.7.6";
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_HMAC_SHA256 = "1.2.840.113549.2.9";
const OID_AES256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_PBE_3DES = "1.2.840.113549.1.12.1.3";
const OID_PBE_RC2_40 = "1.2.840.113549.1.12.1.6";
const OID_BAG_PKCS8_SHROUDED = "1.2.840.113549.1.12.10.1.2";
const OID_BAG_CERT = "1.2.840.113549.1.12.10.1.3";
const OID_CERT_X509 = "1.2.840.113549.1.9.22.1";

function pkcs7Pad(data: Uint8Array, block: number): Uint8Array {
  const n = block - (data.length % block);
  const out = new Uint8Array(data.length + n);
  out.set(data, 0);
  out.fill(n, data.length);
  return out;
}

function pbes2Algo(salt: Uint8Array, iterations: number, iv: Uint8Array): Uint8Array {
  return derSeq(
    derOid(OID_PBES2),
    derSeq(
      derSeq(
        derOid(OID_PBKDF2),
        derSeq(
          derOctets(salt),
          derInt(iterations),
          derInt(32),
          derSeq(derOid(OID_HMAC_SHA256), derNull())
        )
      ),
      derSeq(derOid(OID_AES256_CBC), derOctets(iv))
    )
  );
}

function legacyAlgo(oid: string, salt: Uint8Array, iterations: number): Uint8Array {
  return derSeq(derOid(oid), derSeq(derOctets(salt), derInt(iterations)));
}

async function aesCbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "AES-CBC", length: key.length * 8 },
    false,
    ["encrypt"]
  );
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: iv as unknown as ArrayBuffer },
      k,
      data as unknown as ArrayBuffer
    )
  );
}

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as unknown as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as ArrayBuffer, iterations },
      base,
      256
    )
  );
}

/** Modern pack: PBES2 + AES-256-CBC everywhere, HMAC-SHA256 MacData. */
async function packP12Modern(
  password: string,
  key: KeyMat,
  certDer: Uint8Array
): Promise<Uint8Array> {
  const salt = new Uint8Array(randomBytes(8));
  const iv = new Uint8Array(randomBytes(16));
  const keyBytes = await deriveAesKey(password, salt, 2048);
  const encKeyBag = await aesCbcEncrypt(keyBytes, iv, key.pkcs8);
  const keyBag = derSeq(
    derOid(OID_BAG_PKCS8_SHROUDED),
    derCtx(0, derSeq(pbes2Algo(salt, 2048, iv), derOctets(encKeyBag)))
  );
  const certBag = derSeq(
    derOid(OID_BAG_CERT),
    derCtx(0, derSeq(derOid(OID_CERT_X509), derCtx(0, derOctets(certDer))))
  );
  const safeContents = derSeq(keyBag, certBag);

  const encSalt = new Uint8Array(randomBytes(8));
  const encIv = new Uint8Array(randomBytes(16));
  const encKeyBytes = await deriveAesKey(password, encSalt, 2048);
  const encSafe = await aesCbcEncrypt(encKeyBytes, encIv, safeContents);
  const encryptedData = derSeq(
    derInt(0),
    derSeq(derOid(OID_DATA), pbes2Algo(encSalt, 2048, encIv), derCtx(0, derOctets(encSafe)))
  );
  const authSafe = derSeq(derSeq(derOid(OID_ENC_DATA), derCtx(0, encryptedData)));

  const macSalt = new Uint8Array(randomBytes(8));
  const macKey = pkcs12Kdf("sha256", password, macSalt, 3, 2048, 32);
  const mac = pureHmac("sha256", macKey, authSafe);
  const macData = derSeq(
    derSeq(derSeq(derOid("2.16.840.1.101.3.4.2.1"), derNull()), derOctets(mac)),
    derOctets(macSalt),
    derInt(2048)
  );
  return derSeq(
    derInt(3),
    derSeq(derOid(OID_DATA), derCtx(0, derOctets(authSafe))),
    macData
  );
}

/** Legacy pack (the OpenSSL ≤2.x / old-Windows shape): 3DES shrouded
 *  keybag inside an RC2-40 EncryptedData outer + 3DES certs. */
function packP12Legacy(
  password: string,
  key: KeyMat,
  certDer: Uint8Array
): Uint8Array {
  const iters = 2048;

  const kSalt = new Uint8Array(randomBytes(8));
  const kKey = pkcs12Kdf("sha1", password, kSalt, 1, iters, 24);
  const kIv = pkcs12Kdf("sha1", password, kSalt, 2, iters, 8);
  const kCipher = createCipheriv("des-ede3-cbc", Buffer.from(kKey), Buffer.from(kIv));
  kCipher.setAutoPadding(false);
  const encKeyBag = new Uint8Array(
    Buffer.concat([
      kCipher.update(Buffer.from(pkcs7Pad(key.pkcs8, 8))),
      kCipher.final(),
    ])
  );
  const keyBag = derSeq(
    derOid(OID_BAG_PKCS8_SHROUDED),
    derCtx(0, derSeq(legacyAlgo(OID_PBE_3DES, kSalt, iters), derOctets(encKeyBag)))
  );

  const cSalt = new Uint8Array(randomBytes(8));
  const cKey = pkcs12Kdf("sha1", password, cSalt, 1, iters, 24);
  const cIv = pkcs12Kdf("sha1", password, cSalt, 2, iters, 8);
  const cCipher = createCipheriv("des-ede3-cbc", Buffer.from(cKey), Buffer.from(cIv));
  cCipher.setAutoPadding(false);
  const certBag = derSeq(
    derOid(OID_BAG_CERT),
    derCtx(0, derSeq(derOid(OID_CERT_X509), derCtx(0, derOctets(certDer))))
  );
  const encCertSc = new Uint8Array(
    Buffer.concat([
      cCipher.update(Buffer.from(pkcs7Pad(derSeq(certBag), 8))),
      cCipher.final(),
    ])
  );

  const rSalt = new Uint8Array(randomBytes(8));
  const rKey = pkcs12Kdf("sha1", password, rSalt, 1, iters, 5);
  const rIv = pkcs12Kdf("sha1", password, rSalt, 2, iters, 8);
  const rCipher = createCipheriv("rc2-40-cbc", Buffer.from(rKey), Buffer.from(rIv));
  rCipher.setAutoPadding(false);
  const encKeySc = new Uint8Array(
    Buffer.concat([
      rCipher.update(Buffer.from(pkcs7Pad(derSeq(keyBag), 8))),
      rCipher.final(),
    ])
  );

  const authSafe = derSeq(
    derSeq(
      derOid(OID_ENC_DATA),
      derCtx(
        0,
        derSeq(
          derInt(0),
          derSeq(derOid(OID_DATA), legacyAlgo(OID_PBE_RC2_40, rSalt, iters), derCtx(0, derOctets(encKeySc)))
        )
      )
    ),
    derSeq(
      derOid(OID_ENC_DATA),
      derCtx(
        0,
        derSeq(
          derInt(0),
          derSeq(derOid(OID_DATA), legacyAlgo(OID_PBE_3DES, cSalt, iters), derCtx(0, derOctets(encCertSc)))
        )
      )
    )
  );

  const macSalt = new Uint8Array(randomBytes(8));
  const macKey = pkcs12Kdf("sha1", password, macSalt, 3, iters, 20);
  const mac = pureHmac("sha1", macKey, authSafe);
  const macData = derSeq(
    derSeq(derSeq(derOid("1.3.14.3.2.26"), derNull()), derOctets(mac)),
    derOctets(macSalt),
    derInt(iters)
  );
  return derSeq(
    derInt(3),
    derSeq(derOid(OID_DATA), derCtx(0, derOctets(authSafe))),
    macData
  );
}

/* ================================================================== */
console.log("── 0. wiring sanity (source text) ─────────────────────");
/* ================================================================== */
{
  const configsTs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const surfacesTs = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  const registryTs = readFileSync("src/lib/tools/registry.ts", "utf8");
  const workerSrc = readFileSync("tools/digital-signature/worker.ts", "utf8");

  check(
    "configs.ts: import + [digitalSignature.toolId] entry",
    configsTs.includes('import { config as digitalSignature } from "../../../tools/digital-signature/config"') &&
      configsTs.includes("[digitalSignature.toolId]: digitalSignature,")
  );
  check(
    "surfaces.tsx: import + digital-signature entry",
    surfacesTs.includes('import { DigitalSignatureSurface } from "../../../tools/digital-signature/surface"') &&
      surfacesTs.includes('"digital-signature": DigitalSignatureSurface,')
  );
  const defIdx = registryTs.indexOf('id: "digital-signature"');
  const defSlice = defIdx >= 0 ? registryTs.slice(defIdx, defIdx + 420) : "";
  check(
    "registry: def enabled + mode D + accepts pdf + honest PAdES description",
    defIdx >= 0 &&
      defSlice.includes("enabled: true") &&
      defSlice.includes('mode: "D"') &&
      defSlice.includes('accepts: "pdf"') &&
      defSlice.includes("PAdES") &&
      defSlice.includes(".pfx/.p12")
  );

  const configTs = readFileSync("tools/digital-signature/config.ts", "utf8");
  check(
    "config: split-tool shape (worker, pdf output, 1 file, no schema, collectAssets)",
    configTs.includes('toolId: "digital-signature"') &&
      configTs.includes("createWorker") &&
      configTs.includes('outputKind: "pdf"') &&
      configTs.includes("minFiles: 1") &&
      configTs.includes("maxFiles: 1") &&
      configTs.includes("options: []") &&
      configTs.includes("collectAssets: () => p12AssetFiles()")
  );
  check(
    "config: howKeys ds.how1-3 + verify chain",
    configTs.includes('howKeys: ["ds.how1", "ds.how2", "ds.how3"]') &&
      configTs.includes('"verify-pdf-signatures"')
  );
  check(
    "worker: browser-pure (no node: imports)",
    !/from "node:/.test(workerSrc) && !/require\("node:/.test(workerSrc)
  );
  check(
    "worker: object-stream-free save (the byte surgeon needs plain bytes)",
    workerSrc.includes("useObjectStreams: false")
  );
  check(
    "worker: the p12 rides request.assets (collectAssets bridge)",
    workerSrc.includes("assets") &&
      workerSrc.includes("assets.length > 0 ? assets[0]")
  );

  // i18n parity + referenced keys
  const en = toolI18n.en as Record<string, Record<string, string>>;
  const hi = toolI18n.hi as Record<string, Record<string, string>>;
  const enKeys = Object.keys(en.ds ?? {}).sort();
  const hiKeys = Object.keys(hi.ds ?? {}).sort();
  check("i18n: en/hi exact key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys), {
    missingInHi: enKeys.filter((k) => !hiKeys.includes(k)),
    missingInEn: hiKeys.filter((k) => !enKeys.includes(k)),
  });
  check(
    "i18n: no empty values in either locale",
    [...Object.values(en.ds ?? {}), ...Object.values(hi.ds ?? {})].every(
      (v) => typeof v === "string" && v.trim().length > 0
    )
  );
  const surfaceSrc = readFileSync("tools/digital-signature/surface.tsx", "utf8");
  const refs = new Set<string>();
  for (const m of surfaceSrc.matchAll(/t\("ds\.([A-Za-z0-9_]+)"/g)) refs.add(`ds.${m[1]}`);
  for (const m of surfaceSrc.matchAll(/t\(`ds\.(\$\{[^}]+\}|[A-Za-z0-9_]+)`/g)) {
    if (!m[1]!.includes("${")) refs.add(`ds.${m[1]}`);
  }
  // ds.pos_${pos} dynamic key → the 4 positions
  for (const pos of BLOCK_POSITIONS) refs.add(`ds.pos_${pos}`);
  for (const key of SIGN_KEYS) refs.add(`ds.${key}`);
  for (const key of Object.values(P12_CODES)) refs.add(key);
  for (const key of Object.values(DS_CODES)) refs.add(key);
  for (const key of ["how1", "how2", "how3"]) refs.add(`ds.${key}`);
  const missing = [...refs].filter(
    (k) => en.ds?.[k.slice(3)] === undefined || hi.ds?.[k.slice(3)] === undefined
  );
  check("i18n: every referenced ds.* key exists in BOTH catalogs", missing.length === 0, missing);

  const centralEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool?: Record<string, string>;
  };
  check(
    "i18n: shared tool.error* codes exist in the central catalog (worker fallbacks)",
    centralEn.tool?.errorEncrypted !== undefined &&
      centralEn.tool?.errorCorrupt !== undefined &&
      centralEn.tool?.errorGeneric !== undefined
  );
}

/* ================================================================== */
console.log("── 1. model vectors ───────────────────────────────────");
/* ================================================================== */
{
  // ---- parseSignRun defensive coercion --------------------------------
  {
    const good = parseSignRun(
      makeSign({ reason: "Contract approval", location: "New Delhi", page: 1, position: "tl", visible: false }),
      2
    );
    check(
      "parseSignRun: full payload",
      good.ok &&
        good.run.reason === "Contract approval" &&
        good.run.location === "New Delhi" &&
        good.run.page === 1 &&
        good.run.position === "tl" &&
        good.run.visible === false,
      good
    );
    const defaults = parseSignRun(makeSign({}), 3);
    check(
      "parseSignRun: defaults (page 0, br, visible, en)",
      defaults.ok &&
        defaults.run.page === 0 &&
        defaults.run.position === "br" &&
        defaults.run.visible === true &&
        defaults.run.locale === "en",
      defaults
    );
    for (const [label, raw] of [
      ["garbage JSON", "{not json"],
      ["empty string", ""],
      ["null", null],
      ["number", 42],
    ] as const) {
      const r = parseSignRun(raw, 2);
      check(
        `parseSignRun: ${label} → honest defaults`,
        r.ok && r.run.position === "br" && r.run.reason === "" && r.run.visible === true,
        r
      );
    }
    check(
      "parseSignRun: page clamped to last page",
      runOf(parseSignRun(makeSign({ page: 99 }), 2)).run.page === 1
    );
    check(
      "parseSignRun: negative page clamps to 0",
      runOf(parseSignRun(makeSign({ page: -5 }), 2)).run.page === 0
    );
    const junk = parseSignRun(
      JSON.stringify({ page: "x", position: 7, visible: "yes", locale: "fr" }),
      2
    );
    check(
      "parseSignRun: junk types degrade honestly",
      junk.ok && junk.run.page === 0 && junk.run.position === "br" && junk.run.visible === true && junk.run.locale === "en",
      junk
    );
    const long = "R".repeat(400);
    const capped = runOf(parseSignRun(makeSign({ reason: long, location: long }), 1));
    check(
      `parseSignRun: reason/location caps (${MAX_REASON_CHARS}/${MAX_LOCATION_CHARS})`,
      capped.ok && capped.run.reason.length === MAX_REASON_CHARS && capped.run.location.length === MAX_LOCATION_CHARS,
      { r: capped.run?.reason.length, l: capped.run?.location.length }
    );
    const ctrl = runOf(parseSignRun(makeSign({ reason: "ab\u0007cd\nef" }), 1));
    check(
      "parseSignRun: control chars dropped, \\n kept",
      ctrl.ok && ctrl.run.reason === "abcd\nef",
      ctrl.run?.reason
    );
    const labels = runOf(parseSignRun(
      JSON.stringify({
        labels: {
          "ds.blockSignedBy": "हस्ताक्षरकर्ता",
          "ds.ok": "yes",
          "junk.junk.junk": "dropped",
          ["ds." + "x".repeat(60)]: "dropped (key cap)",
          "ds.numbers123": "kept",
        },
      }),
      1
    ));
    check(
      "parseSignRun: label filter (ds.* keys ≤ 58 chars, junk dropped)",
      labels.ok &&
        labels.run.labels["ds.blockSignedBy"] === "हस्ताक्षरकर्ता" &&
        labels.run.labels["ds.numbers123"] === "kept" &&
        labels.run.labels["ds.ok"] === "yes" &&
        labels.run.labels["junk.junk.junk"] === undefined &&
        Object.keys(labels.run.labels).length === 3,
      labels.run?.labels
    );
    const hi = runOf(parseSignRun(makeSign({ locale: "hi" }), 1));
    check("parseSignRun: locale hi rides", hi.ok && hi.run.locale === "hi");
  }

  // ---- names -----------------------------------------------------------
  check(
    "outputBaseName: strips .pdf, keeps case/spaces",
    outputBaseName("contract v2.pdf", "en") === "contract v2" &&
      outputBaseName("CONTRACT.PDF", "en") === "CONTRACT"
  );
  check(
    "outputBaseName: unsafe chars cleaned, empty → locale word",
    outputBaseName('a/b:c*d?"e<f>.pdf', "en") === "a_b_c_d__e_f_" &&
      outputBaseName(".pdf", "en") === "document" &&
      outputBaseName(".pdf", "hi") === "दस्तावेज़"
  );
  check(
    "signedFileName: en + hi vectors",
    signedFileName("contract v2.pdf", "en") === "contract v2-signed.pdf" &&
      signedFileName(".pdf", "en") === "document-signed.pdf" &&
      signedFileName(".pdf", "hi") === "दस्तावेज़-हस्ताक्षरित.pdf"
  );
  check(
    "sigFieldName: fresh → Signature1, collision suffixed",
    sigFieldName(new Set()) === "Signature1" &&
      sigFieldName(new Set(["Signature1"])) === "Signature1_2" &&
      sigFieldName(new Set(["Signature1", "Signature1_2"])) === "Signature1_3"
  );

  // ---- the WinAnsi-vs-Noto rule ----------------------------------------
  check(
    "isWinAnsiChar: ASCII + latin-1 + CP1252 punct",
    isWinAnsiChar(0x41) && isWinAnsiChar(0xe9) && isWinAnsiChar(0x20ac) && !isWinAnsiChar(0x0915)
  );
  check(
    "needsNotoChar: Devanagari block + ₹, not Latin",
    needsNotoChar(0x0915) && needsNotoChar(0x20b9) && !needsNotoChar(0x41)
  );
  check(
    "needsNoto: mixed string detected, Latin-only clean",
    needsNoto("अनुबंध") && needsNoto("price ₹500") && !needsNoto("plain latin éè")
  );
  check(
    "sanitizeText: keeps WinAnsi, keeps Deva with Noto, ? without",
    sanitizeText("abc ₹123", true) === "abc ₹123" &&
      sanitizeText("abc ₹123", false) === "abc ?123" &&
      sanitizeText("日本語", true) === "???"
  );
  check(
    "splitTextRuns: mixed line splits into faces",
    JSON.stringify(splitTextRuns("Sign करें now")) ===
      JSON.stringify([
        { text: "Sign ", deva: false },
        { text: "करें", deva: true },
        { text: " now", deva: false },
      ])
  );

  // ---- display geometry + block positions ------------------------------
  check(
    "displaySize: rotation swap",
    displaySize(0, 100, 200).w === 100 &&
      displaySize(90, 100, 200).w === 200 &&
      displaySize(90, 100, 200).h === 100
  );
  const r0 = displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 0, 100, 200);
  check(
    "displayRectToUser: /Rotate 0 hand vector",
    near(r0.x, 10) && near(r0.y, 140) && near(r0.w, 30) && near(r0.h, 40),
    r0
  );
  const r90 = displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 90, 100, 200);
  check(
    "displayRectToUser: /Rotate 90 hand vector (axes swap)",
    near(r90.x, 20) && near(r90.y, 10) && near(r90.w, 40) && near(r90.h, 30),
    r90
  );
  const r270 = displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 270, 100, 200);
  check(
    "displayRectToUser: /Rotate 270 hand vector",
    near(r270.x, 100 - 20 - 40) && near(r270.y, 200 - 10 - 30) && near(r270.w, 40) && near(r270.h, 30),
    r270
  );
  const roff = displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 0, 100, 200, 10, 10);
  check(
    "displayRectToUser: MediaBox origin offset",
    near(roff.x, 20) && near(roff.y, 150),
    roff
  );
  const a4w = 595.28;
  const a4h = 841.89;
  const br = positionToDisplayRect("br", a4w, a4h);
  check(
    "positionToDisplayRect: A4 bottom-right hand vector",
    near(br.left, a4w - BLOCK_MARGIN_PT - BLOCK_W_PT) &&
      near(br.top, a4h - BLOCK_MARGIN_PT - BLOCK_H_PT) &&
      near(br.w, BLOCK_W_PT) &&
      near(br.h, BLOCK_H_PT),
    br
  );
  const tl = positionToDisplayRect("tl", a4w, a4h);
  check(
    "positionToDisplayRect: A4 top-left hand vector",
    near(tl.left, BLOCK_MARGIN_PT) && near(tl.top, BLOCK_MARGIN_PT),
    tl
  );
  const tiny = positionToDisplayRect("br", 90, 110);
  check(
    "positionToDisplayRect: tiny page clamps inside",
    tiny.left >= 0 && tiny.top >= 0 && tiny.left + tiny.w <= 90 + 0.01 && tiny.top + tiny.h <= 110 + 0.01,
    tiny
  );

  // ---- dates ------------------------------------------------------------
  const d = new Date(Date.UTC(2026, 9, 22, 12, 0, 34));
  check(
    "formatSignDate: UTC stamp",
    formatSignDate(d) === "2026-10-22 12:00:34 UTC",
    formatSignDate(d)
  );
  check(
    "pdfDateString: D: format",
    pdfDateString(d) === "D:20261022120034Z",
    pdfDateString(d)
  );

  // ---- the byte surgeon on synthetic buffers ----------------------------
  {
    const hexLen = 40;
    const prefix = "x".repeat(50);
    const arrText = "/ByteRange [ 1111111111 1111111111 1111111111 1111111111 ]\n";
    const gapText = "<" + "0".repeat(hexLen) + ">";
    const tail = "\ntrailing tail bytes here";
    const file =
      prefix +
      "older /ByteRange [ 12 34 56 78 ] noise noise noise noise noise noise\n" +
      arrText +
      "/Contents " +
      gapText +
      tail;
    const bytes = new Uint8Array(Buffer.from(file, "latin1"));
    const gap = findContentsGap(bytes, hexLen);
    check(
      "findContentsGap: exact match, unique",
      gap !== null && gap.unique && gap.start === file.indexOf(gapText),
      gap
    );
    check(
      "findContentsGap: wrong length → null",
      findContentsGap(bytes, hexLen + 2) === null
    );
    const shortRun = new Uint8Array(Buffer.from("xx<0000>yy", "latin1"));
    check(
      "findContentsGap: short zero run does not match a long needle",
      findContentsGap(shortRun, 40) === null
    );
    const dupFile = "<" + "0".repeat(hexLen) + "><" + "0".repeat(hexLen) + ">";
    const dup = findContentsGap(new Uint8Array(Buffer.from(dupFile, "latin1")), hexLen);
    check("findContentsGap: duplicate gap → unique=false", dup !== null && !dup.unique, dup);

    const gapIdx = file.indexOf(gapText);
    const values = byteRangeValues(gapIdx, hexLen, bytes.length);
    check(
      "byteRangeValues: [0, B, C, D] with both delimiters in the gap",
      values !== null &&
        values[0] === 0 &&
        values[1] === gapIdx &&
        values[2] === gapIdx + hexLen + 2 &&
        values[3] === bytes.length - (gapIdx + hexLen + 2),
      values
    );
    check(
      "byteRangeValues: > 10 digits → null (honest refuse)",
      byteRangeValues(10 ** 10, 40, 10 ** 10 + 42) === null
    );

    const patched = patchByteRangeDigits(bytes, gapIdx, hexLen);
    check(
      "patchByteRangeDigits: sentinel array rewritten, values returned",
      patched !== null &&
        patched[1] === gapIdx &&
        patched[2] === gapIdx + hexLen + 2 &&
        patched[3] === bytes.length - patched[2],
      patched
    );
    const patchedText = Buffer.from(bytes).toString("latin1");
    const want = [0, gapIdx, gapIdx + hexLen + 2, bytes.length - (gapIdx + hexLen + 2)]
      .map((v) => String(v).padStart(10, "0"));
    check(
      "patchByteRangeDigits: zero-padded 10-digit entries in place (width kept)",
      patchedText.includes(`/ByteRange [ ${want.join(" ")} ]`) &&
        !patchedText.includes("1111111111"),
      patchedText.slice(file.indexOf("/ByteRange [", 60), 200)
    );
    check(
      "patchByteRangeDigits: the OLDER foreign ByteRange is untouched",
      patchedText.includes("/ByteRange [ 12 34 56 78 ]"),
      patchedText
    );
    check(
      "patchByteRangeDigits: no array in reach → null",
      patchByteRangeDigits(
        new Uint8Array(Buffer.from("no dict here <" + "0".repeat(40) + ">", "latin1")),
        14,
        40
      ) === null
    );

    // coveredDigest vs the node:crypto oracle
    const range = [0, gapIdx, gapIdx + hexLen + 2, bytes.length - (gapIdx + hexLen + 2)] as [
      number,
      number,
      number,
      number
    ];
    const oracle = createHash("sha256")
      .update(Buffer.from(bytes.subarray(0, range[1])))
      .update(Buffer.from(bytes.subarray(range[2], range[2] + range[3])))
      .digest();
    check(
      "coveredDigest: two-part update == node:crypto oracle",
      Buffer.from(coveredDigest(bytes, range)).equals(oracle)
    );

    // splice
    const spliceTarget = new Uint8Array(Buffer.from("xx<" + "0".repeat(8) + ">yy", "latin1"));
    spliceContentsHex(spliceTarget, 2, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    check(
      "spliceContentsHex: uppercase hex fills the gap exactly",
      Buffer.from(spliceTarget).toString("latin1") === "xx<DEADBEEF>yy",
      Buffer.from(spliceTarget).toString("latin1")
    );
  }

  // ---- labelOf fallback + blockNeedsNoto -------------------------------
  const runEn = runOf(parseSignRun(makeSign({}), 1)).run;
  check(
    "labelOf: EN fallbacks for every SIGN_KEY",
    SIGN_KEYS.every((k) => labelOf(runEn, k) === SIGN_LABELS_EN[k])
  );
  const runHi = runOf(parseSignRun(
    makeSign({
      locale: "hi",
      labels: {
        "ds.blockSignedBy": "द्वारा डिजिटल हस्ताक्षरित",
        "ds.blockDateLabel": "दिनांक:",
      },
    }),
    1
  )).run;
  check(
    "labelOf: localized hit, EN fallback for the rest",
    labelOf(runHi, "blockSignedBy") === "द्वारा डिजिटल हस्ताक्षरित" &&
      labelOf(runHi, "blockDateLabel") === "दिनांक:" &&
      labelOf(runHi, "blockReasonLabel") === "Reason:"
  );
  check(
    "blockNeedsNoto: Hindi reason/location/labels/CN trigger, Latin clean",
    blockNeedsNoto(runHi, { subjectCn: "Smoke", subjectO: "", issuerCn: "", serialHex: "", notBefore: new Date(), notAfter: new Date() }, "2026-10-22 12:00:34 UTC") &&
      !blockNeedsNoto(runEn, { subjectCn: "Smoke", subjectO: "QA", issuerCn: "", serialHex: "", notBefore: new Date(), notAfter: new Date() }, "2026-10-22 12:00:34 UTC")
  );

  // ---- clamp sanity -----------------------------------------------------
  check(
    "clamp: finite + bounds",
    clamp(5, 0, 1) === 1 && clamp(-5, 0, 1) === 0 && clamp(0.5, 0, 1) === 0.5 && clamp(Number.NaN, 0, 1) === 0
  );

  // ---- pdfTextStringValue encoding --------------------------------------
  check(
    "pdfTextStringValue: WinAnsi → literal PDF string",
    pdfTextStringValue("Contract approval").toString() === "(Contract approval)"
  );
  const hindi = pdfTextStringValue("अनुबंध");
  const hindiText = hindi.toString();
  check(
    "pdfTextStringValue: Devanagari → UTF-16BE hex string with BOM",
    hindiText.startsWith("<FEFF") &&
      Buffer.from(hindiText.slice(1, -1), "hex").subarray(0, 2).toString("latin1") === "\xfe\xff",
    hindiText.slice(0, 16)
  );
}

/* ================================================================== */
console.log("── 2. crypto round-trip (fixtures) ─────────────────────");
/* ================================================================== */
{
  const now = Date.now();
  const notBefore = new Date(now - 60_000);
  const notAfter = new Date(now + 365 * 24 * 3600 * 1000);

  const signerKey = rsaKey();
  const signerCert = buildCert({ cn: "Smoke Test Signer", o: "MyCloudy QA", key: signerKey, notBefore, notAfter });
  const caKey = rsaKey();
  const caCert = buildCert({ cn: "MyCloudy Test CA", o: "MyCloudy QA", key: caKey, notBefore, notAfter });
  const leafKey = rsaKey();
  const leafCert = buildCert({
    cn: "Priya Sharma",
    o: "MyCloudy QA",
    key: leafKey,
    notBefore,
    notAfter,
    signerKey: caKey,
    issuerName: nameRdn("MyCloudy Test CA", "MyCloudy QA"),
  });

  const password = "smoke-pw-42";
  const modern = await packP12Modern(password, signerKey, signerCert.certDer);
  const parsed = await parsePkcs12(modern, password);
  check(
    "p12 modern: pkcs8 + cert round-trip",
    Buffer.from(parsed.pkcs8).equals(Buffer.from(signerKey.pkcs8)) &&
      Buffer.from(parsed.certDer).equals(Buffer.from(signerCert.certDer))
  );
  check(
    "p12 modern: summary CN/O/serial/validity",
    parsed.summary.subjectCn === "Smoke Test Signer" &&
      parsed.summary.subjectO === "MyCloudy QA" &&
      parsed.summary.serialHex.length === 32 &&
      Math.abs(parsed.summary.notAfter.getTime() - notAfter.getTime()) < 1500,
    parsed.summary
  );
  check("p12 modern: mac sha256 + modern flag", parsed.macAlgo === "sha256" && parsed.modern === true);

  const legacy = packP12Legacy(password, signerKey, signerCert.certDer);
  const parsedLegacy = await parsePkcs12(legacy, password);
  check(
    "p12 legacy (3DES + RC2-40): key + cert round-trip",
    Buffer.from(parsedLegacy.pkcs8).equals(Buffer.from(signerKey.pkcs8)) &&
      Buffer.from(parsedLegacy.certDer).equals(Buffer.from(signerCert.certDer))
  );
  check("p12 legacy: mac sha1 + not modern", parsedLegacy.macAlgo === "sha1" && parsedLegacy.modern === false);

  try {
    await parsePkcs12(modern, "wrong-password");
    check("p12: wrong password rejected", false, "no throw");
  } catch (error) {
    check(
      "p12: wrong password → ds.errWrongPassword",
      (error as { code?: string }).code === P12_CODES.password
    );
  }
  try {
    await parsePkcs12(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), password);
    check("p12: garbage container rejected", false, "no throw");
  } catch (error) {
    check(
      "p12: garbage container → ds.errNotP12",
      (error as { code?: string }).code === P12_CODES.notP12
    );
  }
  const tampered = modern.slice();
  tampered[120]! ^= 0xff;
  try {
    await parsePkcs12(tampered, password);
    check("p12: tampered authSafe → MAC rejection", false, "no throw");
  } catch (error) {
    check(
      "p12: tampered authSafe → ds.errWrongPassword (MAC integrity)",
      (error as { code?: string }).code === P12_CODES.password
    );
  }

  // dry-run CMS length == real CMS length (the gap sizing contract)
  const signingTime = new Date(now + 5000);
  const dryLen = await estimateCmsLength({ pkcs8: signerKey.pkcs8, certDer: signerCert.certDer }, signingTime);
  const realCms = await buildDetachedSignedData({
    pkcs8: signerKey.pkcs8,
    certDer: signerCert.certDer,
    digest: new Uint8Array(32).fill(0xab),
    signingTime,
  });
  check(
    "estimateCmsLength == the real CMS length (deterministic gap sizing)",
    dryLen === realCms.der.length && dryLen > 800,
    { dryLen, real: realCms.der.length }
  );
  const another = await buildDetachedSignedData({
    pkcs8: signerKey.pkcs8,
    certDer: signerCert.certDer,
    digest: new Uint8Array(32).fill(0xcd),
    signingTime,
  });
  check(
    "CMS length is digest-independent (fixed 32-byte slot)",
    another.der.length === dryLen
  );

  // export the fixtures for part 3
  (globalThis as unknown as Record<string, unknown>).__dsFixtures = {
    signerKey,
    signerCert,
    caKey,
    caCert,
    leafKey,
    leafCert,
    password,
    modernP12: modern,
  };
}

const FX = (globalThis as unknown as {
  __dsFixtures: {
    signerKey: KeyMat;
    signerCert: CertMat;
    caKey: KeyMat;
    caCert: CertMat;
    leafKey: KeyMat;
    leafCert: CertMat;
    password: string;
    modernP12: Uint8Array;
  };
}).__dsFixtures;

/* ================================================================== */
console.log("── 3. REAL E2E through the worker ─────────────────────");
/* ================================================================== */
{
  const notoBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );

  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(notoBytes)) as typeof fetch;
  await import("../tools/digital-signature/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[],
    assets?: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "digital-signature",
        options,
        files,
        assets,
      } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  /* --- the real 2-page input ------------------------------------------- */
  const srcDoc = await PDFDocument.create();
  const srcFont = await srcDoc.embedFont(StandardFonts.Helvetica);
  const pageA = srcDoc.addPage([595.28, 841.89]);
  pageA.drawText("First page body text", { x: 50, y: 400, size: 12, font: srcFont });
  const pageB = srcDoc.addPage([595.28, 841.89]);
  pageB.drawText("Second page body text", { x: 50, y: 400, size: 12, font: srcFont });
  const inputBytes = await srcDoc.save({ useObjectStreams: false });

  const p12File = new File([FX.modernP12 as BlobPart], "signer.p12", {
    type: "application/x-pkcs12",
  });

  /* --- the EN visible run ---------------------------------------------- */
  const enRes = await drive(
    301,
    {
      password: FX.password,
      sign: makeSign({ reason: "Contract approval", location: "New Delhi", page: 1, position: "br" }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")],
    [p12File]
  );
  check("worker EN: result", enRes.type === "result", enRes);
  if (enRes.type !== "result") throw new Error("E2E run failed — aborting smoke");
  check(
    "worker EN: output name + mime",
    enRes.outputs.length === 1 &&
      enRes.outputs[0]!.name === "contract v2-signed.pdf" &&
      enRes.outputs[0]!.mime === "application/pdf",
    enRes.outputs.map((o) => o.name)
  );
  const detail = enRes.detail as { files?: number; pages?: number } | undefined;
  check("worker EN: detail files/pages", detail?.files === 1 && detail?.pages === 2, detail);
  const progress = messages.filter(
    (m) => m.runId === 301 && m.type === "progress"
  ) as Extract<WorkerResponse, { type: "progress" }>[];
  check(
    "worker EN: ≥ 5 progress beats, pct non-decreasing, honest stages",
    progress.length >= 5 &&
      progress.every((p) => ["reading", "processing", "saving"].includes(p.stage)) &&
      progress.every((p, i) => i === 0 || p.pct >= progress[i - 1]!.pct),
    progress.map((p) => `${p.pct}:${p.stage}`)
  );

  const signed = new Uint8Array(await enRes.outputs[0]!.blob.arrayBuffer());

  /* --- pdf-lib reload: the real field structure ------------------------ */
  const reloaded = await PDFDocument.load(signed, { updateMetadata: false });
  check("worker EN: reload keeps 2 pages", reloaded.getPageCount() === 2);
  const fields = reloaded.getForm().getFields();
  check("worker EN: exactly one /FT /Sig field", fields.length === 1, fields.length);
  const fieldDict = reloaded.context.lookup(
    (fields[0] as unknown as { ref: PDFRef }).ref
  ) as PDFDict;
  check(
    "worker EN: field /FT /Sig + /T Signature1",
    fieldDict.get(PDFName.of("FT"))?.toString() === "/Sig" &&
      fieldDict.get(PDFName.of("T"))?.toString() === "(Signature1)"
  );
  const annots = reloaded.getPage(1).node.Annots();
  check("worker EN: widget on page 2", annots !== undefined && annots.size() === 1, annots?.size());
  if (annots !== undefined) {
    const widget = annots.lookup(0);
    check(
      "worker EN: widget /Subtype /Widget + Print flag",
      widget instanceof PDFDict &&
        widget.get(PDFName.of("Subtype"))?.toString() === "/Widget" &&
        widget.get(PDFName.of("F")) !== undefined,
      widget?.toString().slice(0, 120)
    );
    const rect = widget instanceof PDFDict ? widget.get(PDFName.of("Rect")) : undefined;
    const nums =
      rect instanceof PDFArray
        ? [0, 1, 2, 3].map((i) => Number(rect.lookup(i)?.toString()))
        : null;
    check(
      "worker EN: widget /Rect == the br block geometry (355.28 40 555.28 104)",
      nums !== null &&
        near(nums[0]!, 595.28 - 40 - 200) &&
        near(nums[1]!, 40) &&
        near(nums[2]!, 595.28 - 40) &&
        near(nums[3]!, 104),
      nums
    );
  }
  check(
    "worker EN: page 1 carries no annotations (field on page 2 only)",
    (() => { const a0 = reloaded.getPage(0).node.Annots(); return a0 === undefined || a0.size() === 0; })()
  );

  /* --- INDEPENDENT byte-level verification (node:crypto) --------------- */
  const latin = Buffer.from(signed).toString("latin1");
  const brAt = latin.indexOf("/ByteRange");
  const arrS = latin.indexOf("[", brAt);
  const arrE = latin.indexOf("]", arrS);
  const nums = (latin.slice(arrS + 1, arrE).match(/\d+/g) ?? []).map(Number);
  check(
    "verify: /ByteRange parses to 4 zero-padded integers",
    nums.length === 4 && nums.every((n) => Number.isInteger(n) && n >= 0),
    nums
  );
  const [z, B, C, D] = nums as [number, number, number, number];
  check(
    "verify: ByteRange covers the whole file minus the Contents gap",
    z === 0 && C > B && C + D === signed.length,
    { B, C, D, len: signed.length }
  );
  check(
    "verify: the gap delimiters sit exactly at B and C-1",
    signed[B] === 0x3c && signed[C - 1] === 0x3e && C - B >= 64,
    { atB: signed[B], atCm1: signed[C - 1], gap: C - B }
  );

  const recompute = createHash("sha256")
    .update(Buffer.from(signed.subarray(0, B)))
    .update(Buffer.from(signed.subarray(C, C + D)))
    .digest();

  const contentHex = latin.slice(B + 1, C - 1).replace(/\s+/g, "");
  const cmsBytes = new Uint8Array(Buffer.from(contentHex, "hex"));
  check(
    "verify: /Contents hex decodes to one DER TLV",
    readTlv(cmsBytes, 0).end === cmsBytes.length && cmsBytes.length > 800,
    cmsBytes.length
  );
  const ci = readSingle(cmsBytes);
  check("verify: CMS contentType = id-signedData", oidText(readChildren(ci)[0]!) === "1.2.840.113549.1.7.2");
  const sd = readTlv(readChildren(ci)[1]!.value, 0);
  const sdKids = readChildren(sd);
  const si = readChildren(sdKids[sdKids.length - 1]!)[0]!;
  const siKids = readChildren(si);
  const attrsTlv = siKids.find((t) => t.tag === 0xa0)!;
  const retagged = derTlv(0x31, attrsTlv.value);
  const mdAttr = readChildren(attrsTlv).find((t) => {
    const kids = readChildren(t);
    return kids.length === 2 && kids[0]!.tag === 0x06 && oidText(kids[0]!) === "1.2.840.113549.1.9.4";
  })!;
  const messageDigest = octets(readChildren(readChildren(mdAttr)[1]!)[0]!);
  check(
    "verify: recomputed range digest == CMS messageDigest",
    Buffer.from(messageDigest).equals(recompute)
  );
  const ctAttr = readChildren(attrsTlv).find((t) => {
    const kids = readChildren(t);
    return kids.length === 2 && kids[0]!.tag === 0x06 && oidText(kids[0]!) === "1.2.840.113549.1.9.3";
  })!;
  check(
    "verify: signedAttrs contentType = id-data",
    oidText(readChildren(readChildren(ctAttr)[1]!)[0]!) === "1.2.840.113549.1.7.1"
  );
  const stAttr = readChildren(attrsTlv).find((t) => {
    const kids = readChildren(t);
    return kids.length === 2 && kids[0]!.tag === 0x06 && oidText(kids[0]!) === "1.2.840.113549.1.9.5";
  })!;
  check(
    "verify: signingTime attribute present + parses",
    readTlv(readChildren(stAttr)[1]!.value, 0) !== undefined
  );
  const sigOctets = siKids[siKids.length - 1]!;
  check("verify: signature is the trailing OCTET STRING", sigOctets.tag === 0x04 && sigOctets.value.length === 256);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(Buffer.from(retagged));
  check(
    "verify: node:crypto createVerify PASS over the retagged signedAttrs",
    verifier.verify(
      { key: Buffer.from(FX.signerKey.spki), format: "der", type: "spki" },
      Buffer.from(sigOctets.value)
    )
  );
  // the embedded certificate is the p12's cert
  const certsTlv = sdKids.find((t) => t.tag === 0xa0)!;
  const embedded = readTlv(certsTlv.value, 0);
  check(
    "verify: the CMS embeds the p12's certificate byte-for-byte",
    Buffer.from(certsTlv.value).includes(Buffer.from(FX.signerCert.certDer)) &&
      embedded.end === FX.signerCert.certDer.length,
    { embeddedEnd: embedded.end, certLen: FX.signerCert.certDer.length }
  );
  // /M date string present + near-now
  const mMatch = /\/M \(D:(\d{14})Z\)/.exec(latin);
  check(
    "verify: /M PDF date present (D:YYYYMMDDHHmmSSZ)",
    mMatch !== null && /^D:\d{14}Z$/.test(mMatch[0]!.slice(4, -1)),
    mMatch?.[0]
  );
  check(
    "verify: /Reason + /Location ride the sig dict",
    latin.includes("(Contract approval)") && latin.includes("(New Delhi)")
  );

  /* --- the visible block ink ------------------------------------------- */
  const page2Ink = pageContentLatin1(reloaded, 1);
  check(
    "block: 'Digitally signed by Smoke Test Signer' ink on page 2",
    hasText(page2Ink, "Digitally signed by Smoke Test Signer")
  );
  check("block: 'Date:' ink", hasText(page2Ink, "Date:"));
  check(
    "block: the date value ink (UTC stamp pattern)",
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.test(
      page2Ink.replace(/\)\s*Tj/g, ") Tj").replace(/<([0-9A-F]{4,})>\s*Tj/g, (_m, hex: string) =>
        Buffer.from(hex, "hex").toString("latin1")
      )
    )
  );
  check("block: 'Reason: Contract approval' ink", hasText(page2Ink, "Reason: Contract approval"));
  check("block: 'Location: New Delhi' ink", hasText(page2Ink, "Location: New Delhi"));
  check("block: no NaN coordinates in the ink", !page2Ink.includes("NaN"));
  const page1Ink = pageContentLatin1(reloaded, 0);
  check(
    "block: page 1 ink-free (block on page 2 only)",
    !hasText(page1Ink, "Digitally signed by")
  );
  check(
    "block: the frame is vector ink (re + dash-free rectangle op)",
    page2Ink.includes("h\nS"),
    page2Ink.slice(-80)
  );

  /* --- the sibling verify tool cross-check (self-signed → amber) -------- */
  const report = await analyzeSignatures(signed);
  const card = report.signatures[0]!;
  check("sibling verify: exactly 1 signature", report.signatures.length === 1);
  check(
    "sibling verify: digest intact + crypto verified",
    card.signers[0]?.integrity === "intact" && card.signers[0]?.cryptoVerified === true,
    card.signers[0]
  );
  check(
    "sibling verify: self-signed honesty (attention, not valid/invalid)",
    card.status === "attention" && card.noteKeys.includes("vps.nSelfSigned"),
    { status: card.status, noteKeys: card.noteKeys }
  );
  check(
    "sibling verify: field/reason/location/page round-trip",
    card.fieldName === "Signature1" &&
      card.reason === "Contract approval" &&
      card.location === "New Delhi" &&
      card.page === 2,
    { fieldName: card.fieldName, page: card.page }
  );
  check(
    "sibling verify: signer CN from the embedded cert",
    card.signers[0]?.cert?.commonName === "Smoke Test Signer",
    card.signers[0]?.cert?.commonName
  );
  check(
    "sibling verify: cmsSize matches the /Contents length",
    card.cmsSize === cmsBytes.length,
    { cmsSize: card.cmsSize, actual: cmsBytes.length }
  );

  /* --- tamper vectors ---------------------------------------------------- */
  const tampered = signed.slice();
  tampered[11]! ^= 0xff; // inside the binary comment — covered, parse-safe
  const tamperedReport = await analyzeSignatures(tampered);
  check(
    "tamper: covered-range flip → sibling verify says invalid",
    tamperedReport.signatures[0]?.status === "invalid",
    tamperedReport.signatures[0]?.status
  );
  const tamperedDigest = createHash("sha256")
    .update(Buffer.from(tampered.subarray(0, B)))
    .update(Buffer.from(tampered.subarray(C, C + D)))
    .digest();
  check(
    "tamper: digest recompute mismatch (the seal is real)",
    !Buffer.from(tamperedDigest).equals(recompute)
  );
  // Flip one hex digit INSIDE the SignerInfo's signature OCTET STRING (the
  // tail of the CMS can be certificates — flipping there derails the parse).
  // Keep it a valid hex digit so the tampered CMS still parses cleanly.
  // The model writes the /Contents hex UPPERCASE (hexOf().toUpperCase())
  // while Buffer.toString("hex") is lowercase — match case-insensitively.
  const sigHexNeedle = Buffer.from(sigOctets.value).toString("hex").slice(0, 24);
  const upperHex = contentHex.toUpperCase();
  const needleAt = upperHex.indexOf(sigHexNeedle.toUpperCase());
  const flipPos = B + 1 + needleAt + 24;
  if (needleAt < 0) throw new Error("signature hex needle not found in /Contents");
  const sigFlip = signed.slice();
  const wasDigit = String.fromCharCode(sigFlip[Math.floor(flipPos)]!);
  sigFlip[Math.floor(flipPos)] = wasDigit === "0" ? 0x31 : 0x30;
  const sigFlipLatin = Buffer.from(sigFlip).toString("latin1");
  const sigFlipHex = sigFlipLatin.slice(B + 1, C - 1).replace(/\s+/g, "");
  const sigFlipCms = new Uint8Array(Buffer.from(sigFlipHex, "hex"));
  const flipCi = readSingle(sigFlipCms);
  const flipSd = readTlv(readChildren(flipCi)[1]!.value, 0);
  const flipSi = readChildren(readChildren(flipSd)[readChildren(flipSd).length - 1]!)[0]!;
  const flipKids = readChildren(flipSi);
  const flipAttrs = derTlv(0x31, flipKids.find((t) => t.tag === 0xa0)!.value);
  const badVerify = createVerify("RSA-SHA256");
  badVerify.update(Buffer.from(flipAttrs));
  check(
    "tamper: CMS signature flip → node:crypto createVerify FAILS",
    !badVerify.verify(
      { key: Buffer.from(FX.signerKey.spki), format: "der", type: "spki" },
      Buffer.from(flipKids[flipKids.length - 1]!.value)
    )
  );

  /* --- the CA-signed leaf run (sibling verify → green) ------------------- */
  const leafP12 = await packP12Modern(FX.password, FX.leafKey, FX.leafCert.certDer);
  const leafRes = await drive(
    302,
    {
      password: FX.password,
      sign: makeSign({ reason: "Board resolution", location: "Mumbai", page: 0, position: "tr", visible: false }),
    },
    [new File([inputBytes as BlobPart], "board notes.pdf")],
    [new File([leafP12 as BlobPart], "leaf.p12", { type: "application/x-pkcs12" })]
  );
  check("worker CA: result", leafRes.type === "result", leafRes);
  if (leafRes.type === "result") {
    check("worker CA: output name", leafRes.outputs[0]!.name === "board notes-signed.pdf", leafRes.outputs[0]?.name);
    const leafSigned = new Uint8Array(await leafRes.outputs[0]!.blob.arrayBuffer());
    const leafReport = await analyzeSignatures(leafSigned);
    const leafCard = leafReport.signatures[0]!;
    check(
      "worker CA: sibling verify → green VALID (CA-signed leaf)",
      leafCard.status === "valid" &&
        leafCard.tone === "green" &&
        leafCard.noteKeys.length === 0,
      { status: leafCard.status, noteKeys: leafCard.noteKeys }
    );
    check(
      "worker CA: signer CN is the leaf's",
      leafCard.signers[0]?.cert?.commonName === "Priya Sharma",
      leafCard.signers[0]?.cert?.commonName
    );
    check("worker CA: invisible run — page 1, no reason card leak", leafCard.page === 1 && leafCard.reason === "Board resolution");
    // invisible: widget rect all-zero + no block ink
    const leafReload = await PDFDocument.load(leafSigned, { updateMetadata: false });
    const leafAnnots = leafReload.getPage(0).node.Annots();
    const leafWidget = leafAnnots?.lookup(0);
    const leafRect = leafWidget instanceof PDFDict ? leafWidget.get(PDFName.of("Rect")) : undefined;
    check(
      "worker CA: invisible widget /Rect [0 0 0 0]",
      leafRect instanceof PDFArray &&
        [0, 1, 2, 3].every((i) => Number(leafRect.lookup(i)?.toString()) === 0),
      leafRect?.toString()
    );
    check(
      "worker CA: no visible block ink in invisible mode",
      !hasText(pageContentLatin1(leafReload, 0), "Digitally signed by")
    );
    check(
      "worker CA: the signature still verifies (digest intact)",
      leafCard.signers[0]?.integrity === "intact" && leafCard.signers[0]?.cryptoVerified === true
    );
  }

  /* --- page picker + position presets ----------------------------------- */
  const tlRes = await drive(
    303,
    {
      password: FX.password,
      sign: makeSign({ page: 0, position: "tl" }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")],
    [p12File]
  );
  check("worker tl: result", tlRes.type === "result", tlRes);
  if (tlRes.type === "result") {
    const tlSigned = new Uint8Array(await tlRes.outputs[0]!.blob.arrayBuffer());
    const tlReload = await PDFDocument.load(tlSigned, { updateMetadata: false });
    check(
      "worker tl: field on page 1 (the picker honored)",
      (() => {
        const tlA0 = tlReload.getPage(0).node.Annots();
        const tlA1 = tlReload.getPage(1).node.Annots();
        return tlA0 !== undefined && tlA0.size() === 1 && (tlA1 === undefined || tlA1.size() === 0);
      })()
    );
    const tlWidget = tlReload.getPage(0).node.Annots()?.lookup(0);
    const tlRect = tlWidget instanceof PDFDict ? tlWidget.get(PDFName.of("Rect")) : undefined;
    const tlNums =
      tlRect instanceof PDFArray
        ? [0, 1, 2, 3].map((i) => Number(tlRect.lookup(i)?.toString()))
        : null;
    check(
      "worker tl: /Rect == the tl block geometry (40 737.89 240 801.89)",
      tlNums !== null &&
        near(tlNums[0]!, 40) &&
        near(tlNums[1]!, 841.89 - 40 - 64) &&
        near(tlNums[2]!, 240) &&
        near(tlNums[3]!, 841.89 - 40),
      tlNums
    );
    check(
      "worker tl: block ink on page 1",
      hasText(pageContentLatin1(tlReload, 0), "Digitally signed by")
    );
  }

  /* --- the Hindi run ----------------------------------------------------- */
  const hiRes = await drive(
    304,
    {
      password: FX.password,
      sign: makeSign({
        locale: "hi",
        reason: "अनुबंध अनुमोदन",
        location: "नई दिल्ली",
        page: 0,
        position: "br",
        labels: {
          "ds.blockSignedBy": "द्वारा डिजिटल हस्ताक्षरित",
          "ds.blockDateLabel": "दिनांक:",
          "ds.blockReasonLabel": "कारण:",
          "ds.blockLocationLabel": "स्थान:",
        },
      }),
    },
    [new File([inputBytes as BlobPart], "करार v2.pdf")],
    [p12File]
  );
  check("worker HI: result", hiRes.type === "result", hiRes);
  if (hiRes.type === "result") {
    check(
      "worker HI: localized output name",
      hiRes.outputs[0]!.name === "करार v2-हस्ताक्षरित.pdf",
      hiRes.outputs[0]?.name
    );
    const hiSigned = new Uint8Array(await hiRes.outputs[0]!.blob.arrayBuffer());
    const hiReload = await PDFDocument.load(hiSigned, { updateMetadata: false });
    const dump = objDump(hiReload);
    check(
      "worker HI: Noto FontFile2 + Identity-H embedded (the Devanagari rule)",
      dump.includes("/FontFile2") && dump.includes("/Identity-H"),
      dump.length
    );
    const hiInk = pageContentLatin1(hiReload, 0);
    check(
      "worker HI: the Hindi block rides the page (glyph-ID hex tokens)",
      /<[0-9A-Fa-f]{8,}>\s*Tj/.test(hiInk),
      "no hex glyph token on the page"
    );
    const extracted = await pdfjsFlatText(hiSigned);
    check(
      "worker HI: pdf.js extracts Devanagari (stable-substring honesty)",
      extracted.includes("द्वारा") ||
        extracted.includes("हस्ताक्षरित") ||
        extracted.includes("अनुबंध") ||
        extracted.includes("नई दिल्ली") ||
        extracted.includes("करें"),
      extracted.slice(0, 120)
    );
    check("worker HI: no NaN in the Hindi ink", !pageContentLatin1(hiReload, 0).includes("NaN"));
    const hiReport = await analyzeSignatures(hiSigned);
    check(
      "worker HI: the signature still verifies",
      hiReport.signatures[0]?.signers[0]?.cryptoVerified === true,
      hiReport.signatures[0]?.status
    );
  }

  /* --- rejection vectors -------------------------------------------------- */
  const noAsset = await drive(
    310,
    { password: FX.password, sign: makeSign({}) },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check(
    "worker reject: no certificate asset → ds.errNoP12File",
    noAsset.type === "error" && noAsset.code === DS_CODES.noP12,
    noAsset
  );
  const wrongPw = await drive(
    311,
    { password: "not-the-password", sign: makeSign({}) },
    [new File([inputBytes as BlobPart], "contract v2.pdf")],
    [p12File]
  );
  check(
    "worker reject: wrong password → ds.errWrongPassword",
    wrongPw.type === "error" && wrongPw.code === P12_CODES.password,
    wrongPw
  );
  const garbageP12 = await drive(
    312,
    { password: "x", sign: makeSign({}) },
    [new File([inputBytes as BlobPart], "contract v2.pdf")],
    [new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) as BlobPart], "junk.p12")]
  );
  check(
    "worker reject: garbage p12 → ds.errNotP12",
    garbageP12.type === "error" && garbageP12.code === P12_CODES.notP12,
    garbageP12
  );
  const emptyPdf = await drive(
    313,
    { password: FX.password, sign: makeSign({}) },
    [new File([new Uint8Array(0) as BlobPart], "empty.pdf")],
    [p12File]
  );
  check(
    "worker reject: empty PDF → ds.errEmptyFile",
    emptyPdf.type === "error" && emptyPdf.code === DS_CODES.emptyFile,
    emptyPdf
  );
  const garbagePdf = await drive(
    314,
    { password: FX.password, sign: makeSign({}) },
    [new File([new TextEncoder().encode("this is not a pdf") as BlobPart], "junk.pdf")],
    [p12File]
  );
  check(
    "worker reject: garbage PDF → tool.errorCorrupt",
    garbagePdf.type === "error" && garbagePdf.code === "tool.errorCorrupt",
    garbagePdf
  );
  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const enc = await CantooDoc.create();
  enc.addPage([300, 300]);
  enc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
  const encrypted = await enc.save({ useObjectStreams: false });
  const encRes = await drive(
    315,
    { password: FX.password, sign: makeSign({}) },
    [new File([encrypted as BlobPart], "locked.pdf")],
    [p12File]
  );
  check(
    "worker reject: encrypted PDF → tool.errorEncrypted",
    encRes.type === "error" && encRes.code === "tool.errorEncrypted",
    encRes
  );
  const noFile = await drive(316, { password: FX.password, sign: makeSign({}) }, [], [p12File]);
  check(
    "worker reject: no PDF → tool.errorGeneric",
    noFile.type === "error" && noFile.code === "tool.errorGeneric",
    noFile
  );

  /* --- onmessage honesty + the legacy p12 E2E --------------------------- */
  workerGlobal.onmessage!({ data: { type: "nonsense" } as unknown as WorkerRunRequest });
  const legacyP12 = packP12Legacy(FX.password, FX.signerKey, FX.signerCert.certDer);
  const legacyRes = await drive(
    317,
    {
      password: FX.password,
      sign: makeSign({ reason: "Legacy pack", page: 1 }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")],
    [new File([legacyP12 as BlobPart], "legacy.p12", { type: "application/x-pkcs12" })]
  );
  check(
    "worker legacy p12 (3DES/RC2): full sign works",
    legacyRes.type === "result" &&
      (legacyRes.type === "result" ? legacyRes.outputs[0]!.name === "contract v2-signed.pdf" : false),
    legacyRes
  );
  if (legacyRes.type === "result") {
    const legacySigned = new Uint8Array(await legacyRes.outputs[0]!.blob.arrayBuffer());
    const legacyReport = await analyzeSignatures(legacySigned);
    check(
      "worker legacy p12: the signature verifies through the sibling tool",
      legacyReport.signatures[0]?.signers[0]?.cryptoVerified === true &&
        legacyReport.signatures[0]?.signers[0]?.integrity === "intact",
      legacyReport.signatures[0]?.status
    );
  }
  check(
    "worker: non-run messages ignored (no crash, no stray result)",
    messages.filter((m) => m.runId === undefined).length === 0
  );

  /* --- already-signed input: a second signature becomes a new revision -- */
  const doubleRes = await drive(
    318,
    {
      password: FX.password,
      sign: makeSign({ reason: "Countersign", page: 0, position: "tl" }),
    },
    [new File([signed as BlobPart], "contract v2-signed.pdf")],
    [p12File]
  );
  check(
    "worker double-sign: an already-signed input is REJECTED honestly (a pdf-lib re-save would shift rev 1's /ByteRange and break it)",
    doubleRes.type === "error" && (doubleRes as { code?: string }).code === DS_CODES.alreadySigned,
    doubleRes
  );
  check(
    "worker double-sign: hasExistingSignature sees the smoke's own signed output",
    hasExistingSignature(signed) === true && hasExistingSignature(inputBytes) === false,
    { signedLen: signed.length, inputLen: inputBytes.length }
  );

  /* --- outputBaseName honesty through the worker ------------------------ */
  const weirdRes = await drive(
    319,
    { password: FX.password, sign: makeSign({ visible: false }) },
    [new File([inputBytes as BlobPart], 'we:ird*name?.PDF')],
    [p12File]
  );
  check(
    "worker weird name: sanitized output name",
    weirdRes.type === "result" &&
      (weirdRes.type === "result" ? weirdRes.outputs[0]!.name === "we_ird_name_-signed.pdf" : false),
    weirdRes.type === "result" ? weirdRes.outputs[0]!.name : weirdRes
  );
}

/* ================================================================== */
console.log("── 4. finalizeSignedPdf unit (the surgeon, end to end) ──");
/* ================================================================== */
{
  // A signed run built by hand through the exact model path: gap sizing,
  // placeholder write, save, finalize — with an INDEPENDENT digest oracle.
  const srcDoc = await PDFDocument.create();
  const srcPage = srcDoc.addPage([300, 400]);
  srcPage.drawText("plain", { x: 10, y: 200, size: 10, font: await srcDoc.embedFont(StandardFonts.Helvetica) });
  const baseBytes = await srcDoc.save({ useObjectStreams: false });

  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const signingTime = new Date(Date.now() + 1234);
  const L = await estimateCmsLength({ pkcs8: FX.signerKey.pkcs8, certDer: FX.signerCert.certDer }, signingTime);
  const { addSignatureField } = await import("../tools/digital-signature/render");
  addSignatureField(doc, doc.getPage(0), {
    placeholderHexLen: L * 2,
    reason: "Unit reason",
    location: "Unit city",
    signingTime,
    rect: { x: 60, y: 40, w: 200, h: 64 },
    fieldName: sigFieldName(new Set()),
    signerName: "Smoke Test Signer",
  });
  const saved = new Uint8Array(await doc.save({ useObjectStreams: false }));
  check(
    "finalize setup: placeholder gap present at 2L hex chars",
    findContentsGap(saved, L * 2) !== null
  );
  const { finalizeSignedPdf } = await import("../tools/digital-signature/model");
  const result = await finalizeSignedPdf(saved, {
    pkcs8: FX.signerKey.pkcs8,
    certDer: FX.signerCert.certDer,
    signingTime,
    placeholderHexLen: L * 2,
  });
  check(
    "finalize: byteRange covers [0,B) ∪ [C,C+D) exactly",
    result.byteRange[0] === 0 &&
      result.byteRange[2] + result.byteRange[3] === result.bytes.length &&
      result.byteRange[2] === result.byteRange[1] + L * 2 + 2,
    result.byteRange
  );
  const oracle = createHash("sha256")
    .update(Buffer.from(result.bytes.subarray(0, result.byteRange[1])))
    .update(Buffer.from(result.bytes.subarray(result.byteRange[2], result.byteRange[2] + result.byteRange[3])))
    .digest();
  check(
    "finalize: reported digest == the independent recomputation",
    Buffer.from(result.digest).equals(oracle)
  );
  check(
    "finalize: cmsLength == the dry-run length",
    result.cmsLength === L
  );
  check(
    "finalize: the placeholder zero run is gone from the output",
    findContentsGap(result.bytes, L * 2) === null
  );

  // wrong placeholder length → honest signFailed
  let wrongCode = "";
  try {
    await finalizeSignedPdf(saved, {
      pkcs8: FX.signerKey.pkcs8,
      certDer: FX.signerCert.certDer,
      signingTime,
      placeholderHexLen: (L + 4) * 2,
    });
  } catch (error) {
    wrongCode = (error as { code?: string }).code ?? "";
  }
  check(
    "finalize: wrong placeholder length → ds.errSignFailed (no half-signed file)",
    wrongCode === DS_CODES.signFailed,
    wrongCode
  );
}

/* ================================================================== */
console.log("── 5. parseRun honesty + final sweep ─────────────────────");
/* ================================================================== */
{
  // parseSignRun NEVER fails (defensive defaults) — verify across shapes.
  let allOk = true;
  for (const raw of [undefined, null, "", "{}", "[]", '"str"', "3", "{bad", '{"page":1e9}', '{"labels":5}']) {
    const r = parseSignRun(raw, 1);
    if (!r.ok || !BLOCK_POSITIONS.includes(r.run.position)) allOk = false;
  }
  check("parseSignRun: never rejects, always honest defaults", allOk);

  // drawSignatureBlock on a rotated page — text reads horizontally (Tm matrix)
  const rotDoc = await PDFDocument.create();
  const page = rotDoc.addPage([595.28, 841.89]);
  page.setRotation({ type: "degrees", angle: 90 } as never);
  const fonts = {
    base: await rotDoc.embedFont(StandardFonts.Helvetica),
    bold: await rotDoc.embedFont(StandardFonts.HelveticaBold),
    deva: null,
  };
  const run: SignRun = runOf(parseSignRun(makeSign({ reason: "Rotated", page: 0, position: "br" }), 1)).run;
  const plan = drawSignatureBlock(
    page,
    run,
    { subjectCn: "Smoke Test Signer", subjectO: "QA", issuerCn: "", serialHex: "", notBefore: new Date(), notAfter: new Date() },
    "2026-10-22 12:00:34 UTC",
    fonts
  );
  check(
    "drawSignatureBlock: rotated page plan maps br → user space (axes swap)",
    near(plan.rect.w, 64) && near(plan.rect.h, 200),
    plan.rect
  );
  const rotBytes = await rotDoc.save({ useObjectStreams: false });
  const rotReload = await PDFDocument.load(rotBytes, { updateMetadata: false });
  const rotInk = pageContentLatin1(rotReload, 0);
  check(
    "drawSignatureBlock: rotated ink carries the CN needle",
    hasText(rotInk, "Digitally signed by Smoke Test Signer")
  );
  check(
    "drawSignatureBlock: rotated text matrix pre-rotated (cos 90 in Tm)",
    /\S+ 1 -1 \S+ \S+ \S+ Tm/.test(rotInk),
    rotInk.slice(-160)
  );
}

console.log(`\nsmoke: ${pass} passed, ${fail} failed${fail > 0 ? ` — ${failures.join(" | ")}` : ""}`);
process.exit(fail > 0 ? 1 : 0);
