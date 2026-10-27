/**
 * pki-common/pdfsign — client-side PAdES (adbe.pkcs7.detached) signer.
 *
 * Strategy (constant-length byte surgery):
 *  1. Load the PDF with pdf-lib, optionally draw a visible stamp.
 *  2. Attach a Sig field whose /Contents is a fixed 8192-byte hex
 *     placeholder starting with a unique marker, and whose /ByteRange
 *     holds four unique 10-digit marker numbers (9999999989..92).
 *  3. Save with object streams OFF (stable, searchable bytes).
 *  4. Byte surgery: hash everything except the /Contents hex blob,
 *     build the real CMS, splice its hex in (zero-padded to the reserved
 *     size) and rewrite the four ByteRange markers with real values
 *     zero-padded to the same 10 digits. Every splice keeps the file
 *     length constant → xref offsets written by pdf-lib stay valid.
 *
 * The reserved Contents size is 8192 bytes (16384 hex chars): an
 * RSA-2048 signature with a 3-cert chain and PAdES attributes is ~4.5 KB;
 * ECDSA much less. Larger CMS structures are refused honestly.
 */

import {
  PDFDocument,
  PDFArray,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  type PDFFont,
  rgb,
} from "pdf-lib";
import { parseP12, P12Error, type P12Contents } from "./p12";
import { buildDetachedContentInfo } from "./cms";
import { parseCertificate, type X509Info } from "./x509";
import { toHex } from "./asn1";
import { loadStampFonts } from "../stamp-common/worker-lib";

export interface VisibleStamp {
  /** 1-based page number (clamped to the document). */
  page: number;
  /** Display name (Hindi supported — Devanagari font is embedded). */
  name: string;
  reason?: string;
  location?: string;
  /** UI language for the fixed words. */
  locale?: "en" | "hi";
}

export interface SignPdfOptions {
  p12: Uint8Array;
  password: string;
  reason?: string;
  location?: string;
  visible?: VisibleStamp | null;
  signingTime?: Date;
}

export interface SignPdfResult {
  bytes: Uint8Array;
  /** Parsed signer certificate for the result card. */
  signer: X509Info;
  /** Exact CMS DER length written (before zero padding). */
  cmsLength: number;
  pages: number;
}

const CONTENTS_BYTES = 8192;
const MARKER_HEX = "d0d0c0ffee"; // 10 hex chars — searchable placeholder head
const BR_MARKERS = ["9999999989", "9999999990", "9999999991", "9999999992"];

/** ASCII substring search over bytes (PDFs serialize these as ASCII). */
function asciiIndex(hay: Uint8Array, needle: string, from = 0): number {
  const n = needle.length;
  outer: for (let i = from; i + n <= hay.length; i++) {
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function pdfDateString(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(
    d.getUTCDate()
  )}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

/* ------------------------------------------------------------------ */
/* Visible stamp                                                       */
/* ------------------------------------------------------------------ */

async function drawVisibleStamp(
  doc: PDFDocument,
  stamp: VisibleStamp,
  when: Date
): Promise<void> {
  const pageCount = doc.getPageCount();
  const pageNo = Math.min(Math.max(1, Math.floor(stamp.page)), pageCount);
  const page = doc.getPage(pageNo - 1);
  const { width } = page.getSize();

  const hi = stamp.locale === "hi";
  const label = hi ? "डिजिटल हस्ताक्षर:" : "Digitally signed by";
  const onLabel = hi ? "दिनांक:" : "Date";
  const dateText = `${when.toISOString().slice(0, 10)} ${when
    .toISOString()
    .slice(11, 19)} UTC`;

  // Noto Sans Devanagari covers Latin + Hindi + ₹ in one font (browser
  // workers). Outside a browser (bun smoke) it falls back to Helvetica —
  // the browser E2E is the real judge of the Hindi path.
  let font: PDFFont;
  try {
    const fonts = await loadStampFonts(doc, true);
    font = fonts.fontFor("devanagari");
  } catch {
    font = doc.embedStandardFont(StandardFonts.Helvetica);
  }

  const boxW = Math.min(232, width - 24);
  const boxH = 58;
  const x = width - boxW - 18;
  const y = 18;

  // Bordered box only — no fill (a filled rect would hide page content).
  page.drawRectangle({
    x,
    y,
    width: boxW,
    height: boxH,
    borderColor: rgb(0.55, 0.57, 0.6),
    borderWidth: 0.75,
  });

  const clip = (s: string) => s.slice(0, 46);
  const entries: Array<{ s: string; size: number }> = [
    { s: `${label} ${stamp.name}`, size: 8.5 },
    ...(stamp.reason ? [{ s: clip(stamp.reason), size: 7 }] : []),
    ...(stamp.location ? [{ s: clip(stamp.location), size: 7 }] : []),
    { s: `${onLabel} ${dateText} (PAdES)`, size: 7 },
  ].slice(0, 4);
  let ty = y + boxH - 13;
  for (const t of entries) {
    page.drawText(t.s, { x: x + 9, y: ty, size: t.size, font });
    ty -= 12;
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

export async function signPdf(
  pdfBytes: Uint8Array,
  opts: SignPdfOptions
): Promise<SignPdfResult> {
  // 1. Open the key store first — password errors before any PDF work.
  let signer: P12Contents;
  try {
    signer = await parseP12(opts.p12, opts.password);
  } catch (e) {
    if (e instanceof P12Error) throw e;
    throw new P12Error("malformed", "cannot read the key container");
  }
  const signerCert = parseCertificate(signer.certDer);

  // 2. Load + optional visible stamp.
  const doc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: false,
    throwOnInvalidObject: false,
  });
  if (doc.isEncrypted) {
    throw new P12Error("unsupported", "remove the PDF password before signing");
  }
  const pages = doc.getPageCount();
  const when = opts.signingTime ?? new Date();
  if (opts.visible) {
    await drawVisibleStamp(doc, opts.visible, when);
  }

  // 3. The invisible Sig field with placeholders.
  const context = doc.context;
  const contentsHex = MARKER_HEX + "0".repeat(CONTENTS_BYTES * 2 - MARKER_HEX.length);

  const vDict = context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    ByteRange: [
      PDFNumber.of(Number(BR_MARKERS[0])),
      PDFNumber.of(Number(BR_MARKERS[1])),
      PDFNumber.of(Number(BR_MARKERS[2])),
      PDFNumber.of(Number(BR_MARKERS[3])),
    ],
    Contents: PDFHexString.of(contentsHex),
    ...(opts.reason ? { Reason: PDFString.of(opts.reason.slice(0, 200)) } : {}),
    M: PDFString.of(pdfDateString(when)),
  });
  const fieldDict = context.obj({
    FT: "Sig",
    T: "Signature1",
    Rect: [0, 0, 0, 0],
    V: vDict,
  });
  const vRef = context.register(vDict);
  const fieldRef = context.register(fieldDict);
  fieldDict.set(PDFName.of("V"), vRef);

  const acroForm = doc.catalog.getOrCreateAcroForm();
  if (!acroForm) throw new Error("sign: cannot create the AcroForm");
  const acroDict = acroForm.dict;
  let fields = acroDict.lookup(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    fields = context.obj([]) as PDFArray;
    acroDict.set(PDFName.of("Fields"), fields);
  }
  fields.push(fieldRef);
  acroDict.set(PDFName.of("SigFlags"), PDFNumber.of(3));

  // 4. Stable bytes (no object streams).
  const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false });

  // 5. Locate the Contents placeholder — must be unique.
  const hexStart = asciiIndex(saved, MARKER_HEX);
  if (hexStart < 0) throw new Error("sign: placeholder lost on save");
  if (asciiIndex(saved, MARKER_HEX, hexStart + 1) >= 0) {
    throw new Error("sign: placeholder collision");
  }
  const ltPos = hexStart - 1; // position of '<'
  const afterContents = hexStart + CONTENTS_BYTES * 2 + 1; // just past '>'

  // 6. Locate the four ByteRange markers (serialized in order, ~11 bytes apart).
  const brPositions: number[] = [];
  let cursor = 0;
  for (const m of BR_MARKERS) {
    const at = asciiIndex(saved, m, cursor);
    if (at < 0) throw new Error("sign: ByteRange marker lost on save");
    brPositions.push(at);
    cursor = at + m.length;
  }
  for (let i = 1; i < 4; i++) {
    const gap = brPositions[i] - brPositions[i - 1];
    if (gap > 40) throw new Error("sign: ByteRange markers scattered");
  }

  // 7. Rewrite the ByteRange markers to the REAL values BEFORE hashing —
  //    the markers sit inside the covered region, so hashing first would
  //    cover the placeholder digits (the classic signing race).
  //    [offset1, length1, offset2, length2] — length2 = fileEnd - part2Start.
  const realValues = [0, ltPos, afterContents, saved.length - afterContents];
  for (let i = 0; i < 4; i++) {
    const num = String(realValues[i]).padStart(10, "0");
    saved.set(new TextEncoder().encode(num), brPositions[i]);
  }

  // 8. Covered content = everything except the <hex> blob (brackets included).
  //    The ByteRange is now final, and the later hex splice only touches the
  //    excluded region — so this covered stays byte-identical to the final file.
  const covered = new Uint8Array(ltPos + (saved.length - afterContents));
  covered.set(saved.subarray(0, ltPos), 0);
  covered.set(saved.subarray(afterContents), ltPos);

  // 9. Real CMS over the covered bytes.
  const cms = await buildDetachedContentInfo(covered, signer, {
    signingTime: when,
  });
  if (cms.length > CONTENTS_BYTES) {
    throw new Error(
      `sign: certificate chain too large (${cms.length} bytes > ${CONTENTS_BYTES} reserved)`
    );
  }

  // 10. Splice CMS hex — zero-padded with ASCII '0' (0x30) chars to keep
  //     the length constant (NUL bytes would corrupt the hex string).
  const cmsHex = toHex(cms);
  const hexChars = new Uint8Array(CONTENTS_BYTES * 2).fill(0x30);
  for (let i = 0; i < cmsHex.length; i++) hexChars[i] = cmsHex.charCodeAt(i);
  saved.set(hexChars, hexStart);

  // Sanity: markers gone.
  if (asciiIndex(saved, MARKER_HEX) >= 0) throw new Error("sign: marker survived");

  return { bytes: saved, signer: signerCert, cmsLength: cms.length, pages };
}
