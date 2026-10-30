/**
 * DocoPDF own PDF micro-engine — standard security handler (P6-w-b).
 *
 * ISO 32000-1/2 standard security handler on our own parser/rewriter:
 *
 *   WRITE (encryptDocument): AES-256 V5/R6 (default) or AES-128 V4/R4.
 *   Every in-use object's strings + streams are encrypted per-object
 *   (V4) or with the file key (V5), the /Encrypt dict rides as a fresh
 *   unencrypted object above the source numbering, the trailer gets a
 *   fresh random /ID + /Encrypt ref, the header is raised to 1.6/1.7 and
 *   V5 files carry the /Extensions /ADBE level-8 declaration. Classic
 *   xref output (object-stream-free) — the AESV2-inside-ObjStm resident
 *   subtlety never applies to what we write.
 *
 *   READ (openEncrypted): structural parse with `encryptedOk`, the
 *   /Encrypt dict + trailer /ID drive password validation (V1/R2,
 *   V2/R3, V4/R4 with AESV2/V2/None crypt filters, V5/R5+R6), then a
 *   decrypt walk produces a whole replacement object table — including
 *   ObjStm residents (container stream decrypted through the parser's
 *   decryptStream hook; resident strings use the CONTAINER's object
 *   number per spec). /Type /Metadata streams stay plain when
 *   EncryptMetadata is false. Feeding the replacements (+ deletions for
 *   the /Encrypt object) into rewriteDocument rebuilds a clean,
 *   unencrypted file — the "fresh context" guarantee without a second
 *   parser.
 *
 * Ported at parity from @cantoo/pdf-lib's PDFSecurity/CipherTransformFactory
 * (pdf.js lineage, Apache-2.0 via MIT fork) onto our object model; the
 * @cantoo reload path in scripts/smoke-lock.ts is the oracle both ways.
 */

import {
  arr,
  asDict,
  asName,
  asNum,
  dget,
  hstr,
  name,
  num,
  ref,
  type PdfObj,
} from "./objects";
import { listPages } from "./document";
import { parsePdf, type ParsedPdf } from "./parser";
import { rewriteDocument } from "./rewrite";
import {
  aesCbcDecryptNoPad,
  aesCbcEncryptNoPad,
  aesDecryptWithIv,
  aesEncryptWithIv,
  bytesEqual,
  concatBytes,
  md5,
  pdf20Hash,
  r6PasswordBytes,
  randomBytes,
  rc4,
  sha256,
} from "./secprims";

/* ------------------------------------------------------------------ */
/* Shared types                                                        */
/* ------------------------------------------------------------------ */

export interface SecurityPermissions {
  printing?: boolean | "lowResolution" | "highResolution";
  copying?: boolean;
  modifying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  contentAccessibility?: boolean;
  documentAssembly?: boolean;
}

export interface EncryptParams {
  userPassword: string;
  ownerPassword: string;
  algorithm: "AES-256" | "AES-128";
  permissions?: SecurityPermissions;
}

/** The parse result of an encrypted document, ready for rewriteDocument. */
export interface OpenedEncrypted {
  doc: ParsedPdf;
  /** Decrypted replacement for every written object (ready to feed
   * rewriteDocument.replacements — /Encrypt's number is NOT here). */
  replacements: Map<number, PdfObj>;
  pageCount: number;
  /** Object number of the source /Encrypt dict (pass to deletions). */
  encryptNum: number;
  /** Trailer /Info object number, when present. */
  infoNum: number | null;
  /** Next FREE object number above every in-use source object — the
   * caller may author fresh objects there (encryptNum is maxInUse + 1). */
  nextFreeNum: number;
}

export type OpenResult =
  | { kind: "ok"; opened: OpenedEncrypted }
  | { kind: "wrong-password" }
  | { kind: "not-encrypted" };

/* ------------------------------------------------------------------ */
/* R2-R4 password padding (Algorithm 2 step 1 / 3.5/3.6's fixed pad)    */
/* ------------------------------------------------------------------ */

const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Pad/truncate an R2-R4 password to 32 bytes (latin-1; throws > 0xff). */
function padPasswordR2R3R4(password: string): Uint8Array {
  const out = new Uint8Array(32);
  const length = password.length;
  let index = 0;
  while (index < length && index < 32) {
    const code = password.charCodeAt(index);
    if (code > 0xff) {
      throw new Error("Password contains one or more invalid characters.");
    }
    out[index] = code;
    index++;
  }
  while (index < 32) {
    out[index] = PASSWORD_PADDING[index - length]!;
    index++;
  }
  return out;
}

/** 32-bit integer → 4 bytes, low order first (Algorithm 3.3/3.10). */
function lsbFirstBytes(data: number): Uint8Array {
  return new Uint8Array([
    data & 0xff,
    (data >> 8) & 0xff,
    (data >> 16) & 0xff,
    (data >> 24) & 0xff,
  ]);
}

/** Permission flags (Table 22) — signed 32-bit like every writer emits. */
export function permissionsR3(p: SecurityPermissions = {}): number {
  let flags = 0xfffff0c0 | 0;
  if (p.printing === "lowResolution" || p.printing === true) {
    flags |= 0b000000000100;
  }
  if (p.printing === "highResolution") {
    flags |= 0b100000000100;
  }
  if (p.modifying) flags |= 0b000000001000;
  if (p.copying) flags |= 0b000000010000;
  if (p.annotating) flags |= 0b000000100000;
  if (p.fillingForms) flags |= 0b000100000000;
  if (p.contentAccessibility) flags |= 0b001000000000;
  if (p.documentAssembly) flags |= 0b010000000000;
  return flags | 0;
}

/* ------------------------------------------------------------------ */
/* Write side — the V4/V5 recipes (@cantoo PDFSecurity parity)          */
/* ------------------------------------------------------------------ */

const ZERO_IV = new Uint8Array(16);
const EMPTY_BYTES = new Uint8Array(0);
/** 'sAlT' — appended to the per-object digest by the AESV2 crypt filter. */
const AESV2_SALT = new Uint8Array([0x73, 0x41, 0x6c, 0x54]);
/** 0xffffffff + 'Tadb' — the Perms entry tail (Algorithm 3.10). */
const PERMS_SUFFIX = new Uint8Array([
  0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62,
]);

/** Algorithm 8/9 password entry: hash || validationSalt || keySalt. */
function r6PasswordEntry(
  password: Uint8Array,
  userBytes: Uint8Array
): Uint8Array {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  return concatBytes(
    pdf20Hash(
      password,
      concatBytes(password, validationSalt, userBytes),
      userBytes
    ),
    validationSalt,
    keySalt
  );
}

/** Algorithm 8/9 key wrap: AES-256-CBC, zero IV, exact 32 bytes. */
function r6WrappedKey(
  password: Uint8Array,
  keySalt: Uint8Array,
  userBytes: Uint8Array,
  encryptionKey: Uint8Array
): Uint8Array {
  const key = pdf20Hash(
    password,
    concatBytes(password, keySalt, userBytes),
    userBytes
  );
  return aesCbcEncryptNoPad(key, ZERO_IV, encryptionKey);
}

/** R3/R4 U entry (Algorithm 3.5): MD5(pad+id) then 20 keyed RC4 rounds. */
function userPasswordR3R4(
  documentId: Uint8Array,
  encryptionKey: Uint8Array
): Uint8Array {
  let cipher = md5(concatBytes(PASSWORD_PADDING, documentId));
  const key = new Uint8Array(encryptionKey.length);
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < key.length; j++) key[j] = encryptionKey[j]! ^ i;
    cipher = rc4(key, cipher);
  }
  return concatBytes(cipher, new Uint8Array(16));
}

/** R2-R4 O entry (Algorithm 3.3): 51×MD5 owner pad then 20 keyed RC4. */
function ownerPasswordR2R3R4(
  r: number,
  keyBits: number,
  paddedUserPassword: Uint8Array,
  paddedOwnerPassword: Uint8Array
): Uint8Array {
  let digest = paddedOwnerPassword;
  let round = r >= 3 ? 51 : 1;
  for (let i = 0; i < round; i++) digest = md5(digest);
  const key = new Uint8Array(keyBits / 8);
  let cipher = paddedUserPassword;
  round = r >= 3 ? 20 : 1;
  for (let i = 0; i < round; i++) {
    for (let j = 0; j < key.length; j++) key[j] = digest[j]! ^ i;
    cipher = rc4(key, cipher);
  }
  return cipher;
}

/** R2-R4 file key (Algorithm 3.2): MD5 chain over pad+O+P+id. */
function encryptionKeyR2R3R4(
  r: number,
  keyBits: number,
  documentId: Uint8Array,
  paddedUserPassword: Uint8Array,
  ownerPasswordEntry: Uint8Array,
  permissions: number
): Uint8Array {
  let key = concatBytes(
    paddedUserPassword,
    ownerPasswordEntry,
    lsbFirstBytes(permissions),
    documentId
  );
  const round = r >= 3 ? 51 : 1;
  for (let i = 0; i < round; i++) {
    key = md5(key).subarray(0, keyBits / 8);
  }
  return key;
}

/** R4 per-object key (Algorithm 1) + AESV2 salt — full 16-byte MD5. */
function aesObjectKey(
  encryptionKey: Uint8Array,
  obj: number,
  gen: number
): Uint8Array {
  return md5(
    concatBytes(
      encryptionKey,
      new Uint8Array([
        obj & 0xff,
        (obj >> 8) & 0xff,
        (obj >> 16) & 0xff,
        gen & 0xff,
        (gen >> 8) & 0xff,
      ]),
      AESV2_SALT
    )
  );
}

/** V1/V2 per-object key (Algorithm 1, truncated). */
function rc4ObjectKey(
  encryptionKey: Uint8Array,
  obj: number,
  gen: number
): Uint8Array {
  const digest = concatBytes(
    encryptionKey,
    new Uint8Array([
      obj & 0xff,
      (obj >> 8) & 0xff,
      (obj >> 16) & 0xff,
      gen & 0xff,
      (gen >> 8) & 0xff,
    ])
  );
  return md5(digest).subarray(0, Math.min(encryptionKey.length + 5, 16));
}

/* ------------------------------------------------------------------ */
/* Write side — encryptDocument                                        */
/* ------------------------------------------------------------------ */

/** Is this parsed object an ObjStm / XRef CONTAINER (not real content)? */
function isStructuralContainer(obj: PdfObj | undefined): boolean {
  if (!obj || obj.k !== "stream") return false;
  return asName(dget(obj, "Type")) === "ObjStm" || asName(dget(obj, "Type")) === "XRef";
}

/** Deep-clone with every string/stream encrypted (strings → hex-safe). */
function encryptObj(
  o: PdfObj,
  crypt: (num: number, gen: number, data: Uint8Array) => Uint8Array,
  objNum: number,
  gen: number
): PdfObj {
  switch (o.k) {
    case "str":
    case "lstr":
    case "hstr":
      return hstr(crypt(objNum, gen, o.b));
    case "arr":
      return { k: "arr", items: o.items.map((v) => encryptObj(v, crypt, objNum, gen)) };
    case "dict": {
      const m = new Map<string, PdfObj>();
      for (const [key, value] of o.m) m.set(key, encryptObj(value, crypt, objNum, gen));
      return { k: "dict", m };
    }
    case "stream": {
      const m = new Map<string, PdfObj>();
      for (const [key, value] of o.m) m.set(key, encryptObj(value, crypt, objNum, gen));
      // serializePreserve rewrites /Length from the raw body — stays honest.
      return { k: "stream", m, raw: crypt(objNum, gen, o.raw) };
    }
    default:
      return o;
  }
}

/** Highest in-use object number of the parsed document. */
function maxInUseNum(doc: ParsedPdf): number {
  let max = 0;
  for (const [n, entry] of doc.entries) {
    if (entry.type !== 0 && n > max) max = n;
  }
  return max;
}

/** Bump a "1.7"-style version string when below the handler minimum. */
function raiseVersion(doc: ParsedPdf, min: string): string {
  const raw = doc.version;
  const ok = typeof raw === "string" && /^\d\.\d/.test(raw);
  const v = ok ? raw.slice(0, 3) : "1.7";
  const value = Number(v[0]) * 10 + Number(v[2]);
  const minValue = Number(min[0]) * 10 + Number(min[2]);
  return value >= minValue ? v : min;
}

/**
 * Encrypt a parsed (plain) document with the standard security handler.
 * Returns classic-xref AES-encrypted bytes. The input must be unencrypted
 * (the parser refuses encrypted input already).
 */
export function encryptDocument(doc: ParsedPdf, params: EncryptParams): Uint8Array {
  if (params.userPassword.length === 0 && params.ownerPassword.length === 0) {
    throw new Error("Either an owner password or a user password must be specified.");
  }
  const id = randomBytes(16);
  const isV5 = params.algorithm === "AES-256";

  let encryptDictObj: PdfObj;
  let fileKey: Uint8Array;
  const crypt = (objNum: number, gen: number, data: Uint8Array): Uint8Array => {
    if (isV5) return aesEncryptWithIv(fileKey, data);
    return aesEncryptWithIv(aesObjectKey(fileKey, objNum, gen), data);
  };

  if (isV5) {
    // ── V5 / R6 (AES-256) ──
    fileKey = randomBytes(32);
    const userPassword = r6PasswordBytes(params.userPassword);
    const userPasswordEntry = r6PasswordEntry(userPassword, EMPTY_BYTES);
    const userEncryptionKeyEntry = r6WrappedKey(
      userPassword, userPasswordEntry.subarray(40, 48), EMPTY_BYTES, fileKey
    );
    const ownerPassword = params.ownerPassword
      ? r6PasswordBytes(params.ownerPassword)
      : userPassword;
    const ownerPasswordEntry = r6PasswordEntry(ownerPassword, userPasswordEntry);
    const ownerEncryptionKeyEntry = r6WrappedKey(
      ownerPassword, ownerPasswordEntry.subarray(40, 48), userPasswordEntry, fileKey
    );
    const permissions = permissionsR3(params.permissions);
    // One-block CBC with a zero IV is ECB — what Algorithm 3.10 asks for.
    const permissionsEntry = aesCbcEncryptNoPad(
      fileKey, ZERO_IV,
      concatBytes(lsbFirstBytes(permissions), PERMS_SUFFIX, randomBytes(4))
    );
    encryptDictObj = {
      k: "dict",
      m: new Map<string, PdfObj>([
        ["Filter", name("Standard")],
        ["V", num(5)],
        ["R", num(6)],
        ["Length", num(256)],
        ["CF", {
          k: "dict",
          m: new Map<string, PdfObj>([
            ["StdCF", {
              k: "dict",
              m: new Map<string, PdfObj>([
                ["AuthEvent", name("DocOpen")],
                ["CFM", name("AESV3")],
                ["Length", num(32)],
              ]),
            }],
          ]),
        }],
        ["StmF", name("StdCF")],
        ["StrF", name("StdCF")],
        ["O", hstr(ownerPasswordEntry)],
        ["OE", hstr(ownerEncryptionKeyEntry)],
        ["U", hstr(userPasswordEntry)],
        ["UE", hstr(userEncryptionKeyEntry)],
        ["P", num(permissions)],
        ["Perms", hstr(permissionsEntry)],
      ]),
    };
  } else {
    // ── V4 / R4 (AES-128) ──
    const permissions = permissionsR3(params.permissions);
    const paddedUserPassword = padPasswordR2R3R4(params.userPassword);
    const paddedOwnerPassword = params.ownerPassword
      ? padPasswordR2R3R4(params.ownerPassword)
      : paddedUserPassword;
    const ownerPasswordEntry = ownerPasswordR2R3R4(4, 128, paddedUserPassword, paddedOwnerPassword);
    fileKey = encryptionKeyR2R3R4(4, 128, id, paddedUserPassword, ownerPasswordEntry, permissions);
    const userPasswordEntry = userPasswordR3R4(id, fileKey);
    encryptDictObj = {
      k: "dict",
      m: new Map<string, PdfObj>([
        ["Filter", name("Standard")],
        ["V", num(4)],
        ["Length", num(128)],
        ["CF", {
          k: "dict",
          m: new Map<string, PdfObj>([
            ["StdCF", {
              k: "dict",
              m: new Map<string, PdfObj>([
                ["AuthEvent", name("DocOpen")],
                ["CFM", name("AESV2")],
                ["Length", num(16)],
              ]),
            }],
          ]),
        }],
        ["StmF", name("StdCF")],
        ["StrF", name("StdCF")],
        ["R", num(4)],
        ["O", hstr(ownerPasswordEntry)],
        ["U", hstr(userPasswordEntry)],
        ["P", num(permissions)],
      ]),
    };
  }

  // Header raise + /Extensions /ADBE level 8 for V5 on PDF < 2.0.
  const finalVersion = raiseVersion(doc, isV5 ? "1.7" : "1.6");
  if (isV5 && Number(finalVersion[0]) < 2) {
    const root = doc.trailer.get("Root");
    const catalog = root && root.k === "ref" ? doc.getObject(root.num) : root;
    const catM = catalog && (catalog.k === "dict" || catalog.k === "stream") ? catalog.m : undefined;
    if (catM) {
      const extM = asDict(catM.get("Extensions")) ?? new Map<string, PdfObj>();
      const adbeM = asDict(extM.get("ADBE")) ?? new Map<string, PdfObj>();
      const declared = asNum(adbeM.get("ExtensionLevel")) ?? 0;
      if (declared < 8) {
        adbeM.set("BaseVersion", name(finalVersion));
        adbeM.set("ExtensionLevel", num(8));
      }
      extM.set("ADBE", { k: "dict", m: adbeM });
      catM.set("Extensions", { k: "dict", m: extM });
    }
  }

  // Encrypt every written object; the /Encrypt dict rides above them.
  //    KEY-DERIVATION NOTE: the classic rewriter emits gen-0 xref rows
  //    AND gen-0 refs (`N 0 R`) for every object — the V4 per-object key
  //    must therefore derive with gen 0, regardless of source generations.
  const encryptNum = maxInUseNum(doc) + 1;
  const replacements = new Map<number, PdfObj>();
  for (const [n, entry] of doc.entries) {
    if (entry.type === 0) continue;
    const obj = doc.getObject(n);
    if (!obj) continue; // dangling entry — rewriter skips it too
    if (isStructuralContainer(obj)) continue; // consumed by the parse
    replacements.set(n, encryptObj(obj, crypt, n, 0));
  }

  // Fresh random /ID (both elements identical — pdf-lib convention).
  doc.trailer.set(
    "ID",
    arr({ k: "str", b: id }, { k: "str", b: id })
  );

  return rewriteDocument(doc, {
    replacements,
    extraObjects: [{ num: encryptNum, obj: encryptDictObj }],
    extraTrailer: [["Encrypt", ref(encryptNum)]],
    minVersion: finalVersion,
  });
}

/* ------------------------------------------------------------------ */
/* Read side — openEncrypted                                           */
/* ------------------------------------------------------------------ */

interface ReadHandler {
  encryptMetadata: boolean;
  decryptString(num: number, gen: number, data: Uint8Array): Uint8Array;
  decryptStream(num: number, gen: number, data: Uint8Array): Uint8Array;
}

/** Extract the raw string bytes of a dict value (str/lstr/hstr forms). */
function stringBytes(o: PdfObj | undefined): Uint8Array | undefined {
  return o && (o.k === "str" || o.k === "lstr" || o.k === "hstr") ? o.b : undefined;
}

/** R5/R6 user/owner checks + key unwrap (pdf.js PDF17/PDF20 via @cantoo). */
function openV5(
  encDict: Map<string, PdfObj>,
  password: Uint8Array
): Uint8Array | null {
  const oBytes = stringBytes(encDict.get("O")) ?? new Uint8Array(0);
  const uBytes = stringBytes(encDict.get("U")) ?? new Uint8Array(0);
  const ownerPassword = oBytes.subarray(0, 32);
  const userPassword = uBytes.subarray(0, 32);
  const ownerValidationSalt = oBytes.subarray(32, 40);
  const ownerKeySalt = oBytes.subarray(40, 48);
  const userValidationSalt = uBytes.subarray(32, 40);
  const userKeySalt = uBytes.subarray(40, 48);
  const ownerEncryption = stringBytes(encDict.get("OE")) ?? new Uint8Array(0);
  const userEncryption = stringBytes(encDict.get("UE")) ?? new Uint8Array(0);
  const revision = asNum(encDict.get("R")) ?? 6;
  const isR6 = revision >= 6;

  // hash of (password + salt [+ userBytes]) — R6 chain or R5 plain SHA-256.
  const hash = (pw: Uint8Array, salt: Uint8Array, user: Uint8Array): Uint8Array => {
    const data = concatBytes(pw, salt, user);
    return isR6 ? pdf20Hash(pw, data, user) : sha256(data);
  };

  if (bytesEqual(hash(password, userValidationSalt, EMPTY_BYTES), userPassword)) {
    return aesCbcDecryptNoPad(
      hash(password, userKeySalt, EMPTY_BYTES),
      ZERO_IV,
      userEncryption
    );
  }
  if (
    password.length > 0 &&
    bytesEqual(hash(password, ownerValidationSalt, uBytes.subarray(0, 48)), ownerPassword)
  ) {
    return aesCbcDecryptNoPad(
      hash(password, ownerKeySalt, uBytes.subarray(0, 48)),
      ZERO_IV,
      ownerEncryption
    );
  }
  return null;
}

/** R2-R4 user check + file key (Algorithm 3.5/3.2 via prepareKeyData). */
function prepareKeyData(
  fileId: Uint8Array,
  password: Uint8Array | undefined,
  ownerPassword: Uint8Array,
  userPassword: Uint8Array,
  flags: number,
  revision: number,
  keyLength: number,
  encryptMetadata: boolean
): Uint8Array | null {
  const hashDataSize = 40 + ownerPassword.length + fileId.length;
  const hashData = new Uint8Array(hashDataSize);
  let i = 0, j, n;
  if (password) {
    n = Math.min(32, password.length);
    for (; i < n; ++i) hashData[i] = password[i]!;
  }
  j = 0;
  while (i < 32) hashData[i++] = PASSWORD_PADDING[j++]!;
  for (j = 0, n = ownerPassword.length; j < n; ++j) hashData[i++] = ownerPassword[j]!;
  hashData[i++] = flags & 0xff;
  hashData[i++] = (flags >> 8) & 0xff;
  hashData[i++] = (flags >> 16) & 0xff;
  hashData[i++] = (flags >>> 24) & 0xff;
  for (j = 0, n = fileId.length; j < n; ++j) hashData[i++] = fileId[j]!;
  if (revision >= 4 && !encryptMetadata) {
    hashData[i++] = 0xff;
    hashData[i++] = 0xff;
    hashData[i++] = 0xff;
    hashData[i++] = 0xff;
  }
  let hash = md5(hashData.subarray(0, i));
  const keyLengthInBytes = keyLength >> 3;
  if (revision >= 3) {
    for (j = 0; j < 50; ++j) {
      hash = md5(hash.subarray(0, keyLengthInBytes));
    }
  }
  const encryptionKey = hash.subarray(0, keyLengthInBytes);
  let cipher, checkData;
  if (revision >= 3) {
    for (i = 0; i < 32; ++i) hashData[i] = PASSWORD_PADDING[i]!;
    for (j = 0, n = fileId.length; j < n; ++j) hashData[i++] = fileId[j]!;
    cipher = rc4(encryptionKey, md5(hashData.subarray(0, i)));
    n = encryptionKey.length;
    const derivedKey = new Uint8Array(n);
    for (j = 1; j <= 19; ++j) {
      for (let k = 0; k < n; ++k) derivedKey[k] = encryptionKey[k]! ^ j;
      cipher = rc4(derivedKey, cipher);
    }
    for (j = 0, n = cipher.length; j < n; ++j) {
      if (userPassword[j] !== cipher[j]) return null;
    }
  } else {
    cipher = rc4(encryptionKey, PASSWORD_PADDING);
    for (j = 0, n = cipher.length; j < n; ++j) {
      if (userPassword[j] !== cipher[j]) return null;
    }
  }
  return encryptionKey;
}

/** Algorithm 3.7: recover the USER password from the owner password. */
function decodeUserPassword(
  password: Uint8Array,
  ownerPassword: Uint8Array,
  revision: number,
  keyLength: number
): Uint8Array {
  const hashData = new Uint8Array(32);
  let i = 0;
  const n = Math.min(32, password.length);
  for (; i < n; ++i) hashData[i] = password[i]!;
  let j = 0;
  while (i < 32) hashData[i++] = PASSWORD_PADDING[j++]!;
  let hash = md5(hashData);
  const keyLengthInBytes = keyLength >> 3;
  if (revision >= 3) {
    for (j = 0; j < 50; ++j) hash = md5(hash);
  }
  let userPassword: Uint8Array;
  if (revision >= 3) {
    userPassword = ownerPassword;
    const derivedKey = new Uint8Array(keyLengthInBytes);
    for (j = 19; j >= 0; j--) {
      for (let k = 0; k < keyLengthInBytes; ++k) derivedKey[k] = hash[k]! ^ j;
      userPassword = rc4(derivedKey, userPassword);
    }
  } else {
    userPassword = rc4(hash.subarray(0, keyLengthInBytes), ownerPassword);
  }
  return userPassword;
}

/** Resolve the crypt-filter method name for a StmF/StrF selection. */
function cryptFilterMethod(
  cf: Map<string, PdfObj> | undefined,
  filterName: string | undefined
): "AESV2" | "AESV3" | "V2" | "None" {
  if (!filterName || filterName === "Identity") return "None";
  const filter = cf?.get(filterName);
  const m = asDict(filter);
  if (!m) return "None";
  const cfm = asName(m.get("CFM"));
  if (!cfm || cfm === "None") return "None";
  if (cfm === "V2" || cfm === "AESV2" || cfm === "AESV3") return cfm;
  throw new Error(`Unknown crypto method: ${cfm}`);
}

/**
 * Open an ENCRYPTED document with a password. `data` must actually be
 * encrypted (the caller's plain parsePdf already refused it); returns
 * wrong-password when validation fails, or a fully decrypted replacement
 * table + the parsed doc (with its ObjStm decrypt hook installed).
 */
export function openEncrypted(data: Uint8Array, password: string): OpenResult {
  const doc = parsePdf(data, { encryptedOk: true });
  const encVal = doc.trailer.get("Encrypt");
  if (!encVal) return { kind: "not-encrypted" };

  const encObj = encVal.k === "ref" ? doc.getObject(encVal.num) : encVal;
  if (!encObj || (encObj.k !== "dict" && encObj.k !== "stream")) {
    throw new Error("encryption dictionary is unreadable");
  }
  const encDict = encObj.m;
  const encryptNum = encVal.k === "ref" ? encVal.num : -1;
  if (encryptNum < 0) {
    throw new Error("trailer-direct /Encrypt dictionaries are not supported");
  }

  // Trailer /ID — first element bytes (empty when absent).
  const idArr = doc.trailer.get("ID");
  const idFirst = idArr && idArr.k === "arr" ? stringBytes(idArr.items[0]) : undefined;
  const fileId = idFirst ?? new Uint8Array(0);

  const filter = asName(encDict.get("Filter"));
  if (filter !== "Standard") throw new Error("unknown encryption method");
  const algorithm = asNum(encDict.get("V")) ?? 0;
  if (![1, 2, 4, 5].includes(algorithm)) {
    throw new Error("unsupported encryption algorithm");
  }
  const revision = asNum(encDict.get("R")) ?? 3;

  let keyLength = asNum(encDict.get("Length"));
  if (keyLength === undefined || !Number.isInteger(keyLength) || keyLength < 40 || keyLength % 8 !== 0) {
    // Spec default + the CF-based recovery (some files omit /Length).
    if (algorithm <= 2) keyLength = 40;
    else {
      const cfM = asDict(encDict.get("CF"));
      const stmF = asName(encDict.get("StmF"));
      const handler = cfM && stmF ? asDict(cfM.get(stmF)) : undefined;
      keyLength = asNum(handler?.get("Length")) ?? 128;
      if (keyLength < 40) keyLength <<= 3;
    }
  }

  const oBytes = stringBytes(encDict.get("O")) ?? new Uint8Array(0);
  const uBytes = stringBytes(encDict.get("U")) ?? new Uint8Array(0);
  const ownerPassword = oBytes.subarray(0, 32);
  const userPassword = uBytes.subarray(0, 32);
  const flags = asNum(encDict.get("P")) ?? 0;
  // @cantoo parity: true when V4/V5 and /EncryptMetadata is not false.
  const emVal = encDict.get("EncryptMetadata");
  const encryptMetadata =
    (algorithm === 4 || algorithm === 5) &&
    !(emVal?.k === "bool" && emVal.b === false);

  const passwordBytes = password.length > 0
    ? revision >= 5
      ? r6PasswordBytes(password)
      : latin1Bytes(password)
    : undefined;

  let encryptionKey: Uint8Array | null;
  if (algorithm === 5) {
    // R6 chain (or R5's plain SHA-256) — user first, then owner.
    encryptionKey = openV5(encDict, passwordBytes ?? new Uint8Array(0));
  } else {
    encryptionKey = prepareKeyData(
      fileId, passwordBytes, ownerPassword, userPassword, flags, revision,
      keyLength, encryptMetadata
    );
    if (!encryptionKey && passwordBytes) {
      // Try the password as an OWNER password (Algorithm 3.7 + 3.2).
      const decoded = decodeUserPassword(passwordBytes, ownerPassword, revision, keyLength);
      encryptionKey = prepareKeyData(
        fileId, decoded, ownerPassword, userPassword, flags, revision,
        keyLength, encryptMetadata
      );
    }
  }
  if (!encryptionKey) {
    return { kind: "wrong-password" };
  }

  // ── per-domain crypt filter resolution ──
  let strMethod: "AESV2" | "AESV3" | "V2" | "None" = "None";
  let stmMethod: "AESV2" | "AESV3" | "V2" | "None" = "None";
  if (algorithm === 4) {
    const cfM = asDict(encDict.get("CF"));
    strMethod = cryptFilterMethod(cfM, asName(encDict.get("StrF")));
    stmMethod = cryptFilterMethod(cfM, asName(encDict.get("StmF")));
  } else if (algorithm === 5) {
    strMethod = "AESV3";
    stmMethod = "AESV3";
  } else {
    strMethod = "V2";
    stmMethod = "V2";
  }

  const decryptWith = (
    method: "AESV2" | "AESV3" | "V2" | "None",
    objNum: number,
    gen: number,
    data: Uint8Array
  ): Uint8Array => {
    switch (method) {
      case "AESV3":
        return aesDecryptWithIv(encryptionKey!, data);
      case "AESV2":
        return aesDecryptWithIv(aesObjectKey(encryptionKey!, objNum, gen), data);
      case "V2":
        return rc4(rc4ObjectKey(encryptionKey!, objNum, gen), data);
      default:
        return data; // Identity / None
    }
  };

  const handler: ReadHandler = {
    encryptMetadata,
    decryptString: (n, g, d) => decryptWith(strMethod, n, g, d),
    decryptStream: (n, g, d) => decryptWith(stmMethod, n, g, d),
  };

  // ObjStm containers must decrypt before the parser inflates them.
  doc.decryptStream = (num, gen, raw) => handler.decryptStream(num, gen, raw);

  const pageCount = listPages(doc).length;

  // ── the decrypt walk: a replacement for every written object ──
  const decryptObj = (
    o: PdfObj,
    objNum: number,
    gen: number
  ): PdfObj => {
    switch (o.k) {
      case "str":
      case "lstr":
      case "hstr":
        return { k: "str", b: handler.decryptString(objNum, gen, o.b) };
      case "arr":
        return { k: "arr", items: o.items.map((v) => decryptObj(v, objNum, gen)) };
      case "dict": {
        const m = new Map<string, PdfObj>();
        for (const [key, value] of o.m) m.set(key, decryptObj(value, objNum, gen));
        return { k: "dict", m };
      }
      case "stream": {
        const m = new Map<string, PdfObj>();
        for (const [key, value] of o.m) m.set(key, decryptObj(value, objNum, gen));
        const isMetadata = asName(m.get("Type")) === "Metadata";
        const raw = isMetadata && !handler.encryptMetadata
          ? o.raw // EncryptMetadata false → the XMP stream stays plain
          : handler.decryptStream(objNum, gen, o.raw);
        return { k: "stream", m, raw };
      }
      default:
        return o;
    }
  };

  const replacements = new Map<number, PdfObj>();
  for (const [n, entry] of doc.entries) {
    if (entry.type === 0) continue;
    if (n === encryptNum) continue; // the /Encrypt object is deleted
    const obj = doc.getObject(n);
    if (!obj) continue;
    if (isStructuralContainer(obj)) continue; // consumed by the parse
    if (entry.type === 2) {
      // ObjStm RESIDENTS ride PLAIN inside the encrypted container
      // (§7.6.2: the object stream is the unit of encryption — the
      // container was already decrypted through the parser hook, and
      // its residents' strings are stored unencrypted within it).
      // qpdf + pdf.js both write/read them this way.
      replacements.set(n, obj);
      continue;
    }
    replacements.set(n, decryptObj(obj, n, entry.b));
  }

  const infoRef = doc.trailer.get("Info");
  const infoNum = infoRef && infoRef.k === "ref" ? infoRef.num : null;

  return {
    kind: "ok",
    opened: {
      doc,
      replacements,
      pageCount,
      encryptNum,
      infoNum,
      nextFreeNum: maxInUseNum(doc) + 1, // the /Encrypt object is part of the source numbering
    },
  };
}

/** latin-1 single-byte encoding of a password (R2-R4 — throws > 0xff). */
function latin1Bytes(password: string): Uint8Array {
  const out = new Uint8Array(password.length);
  for (let i = 0; i < password.length; i += 1) {
    const code = password.charCodeAt(i);
    if (code > 0xff) {
      throw new Error("Password contains one or more invalid characters.");
    }
    out[i] = code;
  }
  return out;
}
