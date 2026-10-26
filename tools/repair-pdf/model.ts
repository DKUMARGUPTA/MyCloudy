import { PDFDocument } from "pdf-lib";
import { unzlibSync } from "@/lib/own/zip";

import type { RunDetail } from "@/lib/workers/protocol";

/**
 * Repair PDF model (RB3-c — the 75th tool) — a raw-byte PDF salvager that
 * runs 100% on-device in a Web Worker (or headless in the smoke; no DOM).
 *
 * HONEST ARCHITECTURE (why two stages):
 *
 * pdf-lib's parser is deliberately lenient — it scans objects linearly and
 * can "load" a PDF whose xref/startxref/trailer are entirely missing. A
 * repair tool that trusts that load alone would call stripped files
 * "valid". The structure check is therefore two-part:
 *
 *  Stage 1 (structure check):
 *   a. A raw damage scan (this file): %PDF- header at offset 0, startxref
 *      present and pointing at a real xref whose sampled entry offsets
 *      actually hit "N G obj" headers, %%EOF near the tail, plus the object
 *      scan's findings (duplicate object numbers, wrong/missing stream
 *      /Length entries, an unterminated final object).
 *   b. pdf-lib load with throwOnInvalidObject: true.
 *   Only when BOTH are clean is the file "valid": it is still rebuilt
 *   (fresh header + xref via pdf-lib save, object streams off for maximum
 *   viewer compatibility) and reported honestly as such — or, with the
 *   rebuild switch off, returned byte-for-byte unchanged.
 *
 *  Stage 2 (raw salvage — the real work), whenever the structure check
 *   finds ANY damage:
 *   a. Regex-scan the raw bytes for every "N G obj" header (%PDF- is
 *      located anywhere — email wrappers and garbage prefixes included;
 *      a missing %PDF- is reported via headerFixed).
 *   a2. Xref-STREAM salvage (R4-b): when the scan finds a stream whose
 *      dict says /Type /XRef, its /Index + /W rows give every object's
 *      exact offset — each entry is verified against the bytes at that
 *      offset (object number must match) before it is trusted, and the
 *      shared extents logic extracts the object. Objects the xref does
 *      not cover are merged from the object scan; if no xref stream
 *      parses, the scan alone rebuilds the table (the fallback stays
 *      honest). Reported via xrefStreamSalvaged/xrefStreamEntries.
 *      Un-parseable /Type /XRef streams (junk navigation for the OLD
 *      layout — pdf-lib and other consumers eagerly decode /Type /XRef
 *      streams and choke on garbage rows) are excluded from the
 *      rebuild and honestly not counted; the output ships a fresh
 *      classic table anyway. Stale-but-parseable xref streams are kept
 *      byte-faithfully — they are part of what survived.
 *   b. Extract each object's bytes up to its endobj / the next header /
 *      EOF — truncated files still yield the objects that survived.
 *   c. Streams: a DIRECT /Length is trusted only when "endstream" really
 *      follows at that offset (and inflates, for FlateDecode); otherwise
 *      the endstream-scan extent is used. Missing/indirect/wrong /Length
 *      values are rewritten as the true direct number and counted.
 *      Non-inflating extents are kept anyway — viewers are lenient.
 *   d. Duplicate object numbers (concatenated files): the LAST complete
 *      occurrence wins, matching what viewers do when the xref points
 *      late. The duplicate count is reported.
 *   e. Rebuild: fresh %PDF-1.7 header + objects in ascending object-number
 *      order + a correct xref table + a minimal trailer whose /Root is
 *      found by scanning the objects for /Type /Catalog (the catalog with
 *      the most reachable /Pages leaves wins); /Size from max objnum+1;
 *      a surviving trailer /Info is carried over; %%EOF is always written.
 *   f. No catalog / no reachable page → honest failure (errNoCatalog /
 *      errNoPages) — pages are never fabricated.
 *
 * Verification (always, both stages): pdf-lib strict load of the OUTPUT
 * (throwOnInvalidObject: true) — the reported page count is what that
 * verification sees, never a declared /Count.
 *
 * Encrypted PDFs are rejected up front (repair ≠ crack — use unlock-pdf):
 * the raw bytes are checked for the trailer "/Encrypt N G R" reference and
 * the "/Filter /Standard" encryption-dict signature, and a pdf-lib
 * encryption error is mapped the same way.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type RepairErrorCode =
  | "errEncrypted"
  | "errNoObjects"
  | "errNoCatalog"
  | "errNoPages"
  | "errVerify";

/** Typed model error — the worker maps `code` onto an i18n key. */
export class RepairError extends Error {
  readonly code: RepairErrorCode;
  constructor(code: RepairErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "RepairError";
  }
}

/** Worker-boundary options, coerced by parseRun. */
export interface RepairOptions {
  /** Rebuild even when the structure check passes (surface switch). */
  alsoRebuildValid: boolean;
  locale: "en" | "hi";
  /** Localized fallback word for a nameless file ("document"/"दस्तावेज़"). */
  fileWord: string;
}

/** The honest repair report the surface shows after a run. */
export interface RepairReport {
  /** Stage-1 path taken: the structure check fully passed. */
  structureWasValid: boolean;
  /** Valid file returned byte-for-byte unchanged (switch off). */
  unchanged: boolean;
  /** pdf-lib's structure check threw on the input (the "before" state). */
  loadFailed: boolean;
  /** Original xref/startxref missing or not pointing at a real xref. */
  xrefRebuilt: boolean;
  /** %PDF- header missing or not at offset 0 (garbage prefix). */
  headerFixed: boolean;
  /** %%EOF marker absent in the input. */
  eofMissing: boolean;
  /** File tail cut mid-object — content after the cut is gone. */
  truncationDetected: boolean;
  /** Objects in the rebuilt output. */
  objectsRecovered: number;
  /** Object numbers that appeared more than once (last kept). */
  duplicatesResolved: number;
  /** Stream /Length entries corrected. */
  streamLengthsFixed: number;
  /** Objects rebuilt via a surviving xref STREAM (/Index + /W) rather
   *  than the regex object scan (R4-b). */
  xrefStreamSalvaged: boolean;
  /** Type-1 entries materialized from that xref stream. */
  xrefStreamEntries: number;
  /** Page count from the strict verification load. */
  pages: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Run summary the worker posts — now fully covered by the shared protocol
 * detail (RB3-c extended RunDetail additively, the RB1/RB3-b precedent):
 * the report's bytesIn/bytesOut map onto the protocol's beforeBytes/
 * afterBytes so the standard result view's size accounting just works.
 */
export interface RepairDetail extends RunDetail {
  structureWasValid?: boolean;
  unchanged?: boolean;
  loadFailed?: boolean;
  xrefRebuilt?: boolean;
  headerFixed?: boolean;
  eofMissing?: boolean;
  truncationDetected?: boolean;
  objectsRecovered?: number;
  duplicatesResolved?: number;
  streamLengthsFixed?: number;
  xrefStreamSalvaged?: boolean;
  xrefStreamEntries?: number;
  beforeBytes?: number;
  afterBytes?: number;
}

export interface RepairOutcome {
  bytes: Uint8Array;
  report: RepairReport;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Sanity caps — a garbage header match must not blow up the xref. */
export const MAX_OBJNUM = 1_000_000;
export const MAX_OBJECTS = 200_000;
/** Depth/leaf caps for the page-tree walk. */
const MAX_TREE_DEPTH = 32;
const MAX_TREE_LEAVES = 20_000;

/** PDF whitespace incl. NUL (no lookbehind — the house iOS-safe rule). */
const WS_CHARS = " \t\r\n\f\x00";
const WS_CLASS_PLUS = "[ \\t\\r\\n\\f\\x00]+";

const OBJ_HEADER_RE = new RegExp(
  `([0-9]{1,9})${WS_CLASS_PLUS}([0-9]{1,3})${WS_CLASS_PLUS}obj(?=[ \\t\\r\\n\\f\\x00])`,
  "g"
);
/** Trailer encryption reference: "/Encrypt 26 0 R". */
const ENCRYPT_TRAILER_RE = new RegExp(
  `\\/Encrypt${WS_CLASS_PLUS}[0-9]{1,9}${WS_CLASS_PLUS}[0-9]{1,3}${WS_CLASS_PLUS}R`
);
/** Encryption-dictionary signature: "/Filter /Standard". */
const ENCRYPT_DICT_RE = /\/Filter[ \t\r\n\f\x00]*\/Standard(?![a-zA-Z])/;
const CATALOG_RE = new RegExp(`\\/Type${WS_CLASS_PLUS}\\/Catalog(?![a-zA-Z])`);
const PAGE_LEAF_RE = new RegExp(`\\/Type${WS_CLASS_PLUS}\\/Page(?![a-zA-Z])`);
const PAGE_TREE_RE = new RegExp(`\\/Type${WS_CLASS_PLUS}\\/Pages(?![a-zA-Z])`);
/**
 * Kids-array member references — GLOBAL flag required: extractKidsRefs
 * runs it through a while-exec loop, and a non-global exec keeps
 * returning the first match forever (the OOM the smoke caught on its
 * very first salvage — refs grew unboundedly, the process was killed).
 */
const REF_RE = new RegExp(
  `([0-9]{1,9})${WS_CLASS_PLUS}([0-9]{1,3})${WS_CLASS_PLUS}R`,
  "g"
);
const FLATE_RE = new RegExp(`\\/Filter${WS_CLASS_PLUS}\\/FlateDecode`);

/** Ends that close a non-dict object body (numbers, refs, arrays…). */
const PLAIN_BODY_END_CHARS = new Set("])>0123456789Relnst".split(""));

/* ------------------------------------------------------------------ */
/* Byte-faithful latin1 (TextDecoder("latin1") is windows-1252 in the  */
/* browser — 0x80–0x9F would round-trip to the wrong bytes)            */
/* ------------------------------------------------------------------ */

/** Lossless byte→string (one char per byte, codepoints 0x00–0xFF). */
function toLatin(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(bytes.subarray(i, i + CHUNK)) as number[]
    );
  }
  return out;
}

/** Inverse of toLatin for chars ≤ 0xFF (exactly what toLatin produces). */
function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function skipWs(s: string, pos: number, limit: number): number {
  let i = pos;
  while (i < limit && WS_CHARS.indexOf(s[i]) >= 0) i += 1;
  return i;
}

/** Strips trailing PDF whitespace (incl. NUL). */
function trimPdfWs(s: string): string {
  let end = s.length;
  while (end > 0 && WS_CHARS.indexOf(s[end - 1]) >= 0) end -= 1;
  return s.slice(0, end);
}

/* ------------------------------------------------------------------ */
/* Dict walker (string / hex-string / comment aware)                   */
/* ------------------------------------------------------------------ */

/**
 * Index just past the ">>" matching the "<<" at `start`, or -1 when the
 * dict is unbalanced before `limit` (an incomplete object).
 */
function findDictEnd(s: string, start: number, limit: number): number {
  let depth = 0;
  let state: "n" | "s" | "h" | "c" = "n";
  let i = start;
  while (i < limit) {
    const ch = s[i];
    if (state === "s") {
      if (ch === "\\") i += 1;
      else if (ch === ")") state = "n";
    } else if (state === "h") {
      if (ch === ">") state = "n";
    } else if (state === "c") {
      if (ch === "\n" || ch === "\r") state = "n";
    } else {
      if (ch === "%") state = "c";
      else if (ch === "(") state = "s";
      else if (ch === "<" && s[i + 1] === "<") {
        depth += 1;
        i += 1;
      } else if (ch === ">" && s[i + 1] === ">") {
        depth -= 1;
        i += 1;
        if (depth === 0) return i + 1;
      } else if (ch === "<") {
        state = "h";
      }
    }
    i += 1;
  }
  return -1;
}

interface LengthSpan {
  /** Index of the first value char (a digit). */
  valueStart: number;
  /** Index just past the value (digits, or "N G R" for an indirect ref). */
  valueEnd: number;
  /** Parsed direct number (null for indirect refs). */
  direct: number | null;
}

/** Locates the top-level /Length value inside a dict string. */
function findLengthSpan(dict: string): LengthSpan | null {
  let depth = 0;
  let state: "n" | "s" | "h" | "c" = "n";
  let i = 0;
  while (i < dict.length) {
    const ch = dict[i];
    if (state === "s") {
      if (ch === "\\") i += 1;
      else if (ch === ")") state = "n";
    } else if (state === "h") {
      if (ch === ">") state = "n";
    } else if (state === "c") {
      if (ch === "\n" || ch === "\r") state = "n";
    } else {
      if (ch === "%") state = "c";
      else if (ch === "(") state = "s";
      else if (ch === "<" && dict[i + 1] === "<") {
        depth += 1;
        i += 1;
      } else if (ch === ">" && dict[i + 1] === ">") {
        depth -= 1;
        i += 1;
      } else if (ch === "<") {
        state = "h";
      } else if (ch === "/" && dict.startsWith("/Length", i) && depth === 1) {
        const afterName = i + 7;
        const next = dict[afterName];
        if (next === undefined || WS_CHARS.indexOf(next) >= 0 || next === "/") {
          const valueStart = skipWs(dict, afterName, dict.length);
          const digits = /^[0-9]+/.exec(dict.slice(valueStart, valueStart + 12));
          if (digits) {
            let valueEnd = valueStart + digits[0].length;
            const rest = new RegExp(
              `${WS_CLASS_PLUS}([0-9]{1,9})${WS_CLASS_PLUS}R`
            ).exec(dict.slice(valueEnd, valueEnd + 32));
            if (rest) {
              // Indirect reference value "N G R".
              valueEnd += rest[0].length;
              return { valueStart, valueEnd, direct: null };
            }
            return {
              valueStart,
              valueEnd,
              direct: Number.parseInt(digits[0], 10),
            };
          }
        }
        i = afterName - 1;
      }
    }
    i += 1;
  }
  return null;
}

/** Rewrites the dict's /Length to the true direct number. */
function spliceLength(
  dict: string,
  actualLen: number
): { dict: string; fixed: boolean } {
  const span = findLengthSpan(dict);
  if (span === null) {
    // No /Length at all — insert one before the dict's final ">>".
    const close = dict.lastIndexOf(">>");
    if (close < 0) return { dict, fixed: false };
    return {
      dict: `${dict.slice(0, close)} /Length ${actualLen} ${dict.slice(close)}`,
      fixed: true,
    };
  }
  if (span.direct !== null && span.direct === actualLen) {
    return { dict, fixed: false };
  }
  return {
    dict:
      dict.slice(0, span.valueStart) +
      String(actualLen) +
      dict.slice(span.valueEnd),
    fixed: true,
  };
}

/** fflate-based sanity check (zlib-wrapped = PDF FlateDecode). */
function inflates(data: string): boolean {
  try {
    unzlibSync(latin1Encode(data));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Raw scan                                                            */
/* ------------------------------------------------------------------ */

interface ScannedObject {
  num: number;
  gen: number;
  isStream: boolean;
  /** Dict region including << >> (stream objects). */
  dict: string;
  /** Stream data (latin1 slice — byte-faithful). */
  data: string;
  /** Plain (non-stream) body, trimmed — includes dict bodies. */
  body: string;
  /** Byte offset of the "N G obj" header (R4-b: xref-stream ordering). */
  at: number;
}

interface StructureInfo {
  headerAtStart: boolean;
  headerFound: boolean;
  eofOk: boolean;
  /** startxref present and pointing at a real xref (table or stream). */
  xrefOk: boolean;
  /** Surviving /Info ref from the last original trailer, if any. */
  infoRef: { num: number; gen: number } | null;
}

interface ScanResult {
  objects: ScannedObject[];
  dupObjNums: number;
  streamLengthsFixed: number;
  truncationDetected: boolean;
  structure: StructureInfo;
}

/** Verifies a classic xref table: sampled in-use entries must hit real
 *  "N G obj" headers at their recorded offsets. */
function verifyClassicXref(s: string, at: number): boolean {
  let pos = skipWs(s, at + 4, s.length);
  const head = /^([0-9]{1,9})[ \t]+([0-9]{1,9})/.exec(s.slice(pos, pos + 32));
  if (!head) return false;
  const first = Number.parseInt(head[1], 10);
  const count = Number.parseInt(head[2], 10);
  if (!Number.isFinite(first) || !Number.isFinite(count) || count <= 0) {
    return false;
  }
  pos += head[0].length;

  // Deterministic sample: first, middle, last entry.
  const samples = new Set<number>([0, Math.floor(count / 2), count - 1]);
  let parsed = 0;
  let checked = 0;
  let sawInUse = false;
  for (let k = 0; k < count && k < 100_000; k += 1) {
    pos = skipWs(s, pos, s.length);
    const entry = /^([0-9]{1,10})[ \t]+([0-9]{1,5})[ \t]*([nf])(?![0-9a-zA-Z])/.exec(
      s.slice(pos, pos + 24)
    );
    if (!entry) break;
    parsed += 1;
    if (entry[3] === "n") {
      sawInUse = true;
      if (samples.has(k)) {
        const off = Number.parseInt(entry[1], 10);
        const objnum = first + k;
        const atObj = /^([0-9]{1,9})[ \t\r\n\f\x00]+([0-9]{1,3})[ \t\r\n\f\x00]+obj/.exec(
          s.slice(off, off + 40)
        );
        if (!atObj || Number.parseInt(atObj[1], 10) !== objnum) return false;
        checked += 1;
      }
    }
    pos += entry[0].length;
  }
  return parsed > 0 && (!sawInUse || checked > 0);
}

function scanStructure(s: string, objects: ScannedObject[]): StructureInfo {
  const headerIdx = s.indexOf("%PDF-");
  const eofIdx = s.lastIndexOf("%%EOF");

  let xrefOk = false;
  const sxIdx = s.lastIndexOf("startxref");
  if (sxIdx >= 0) {
    const numAt = skipWs(s, sxIdx + 9, s.length);
    const num = /^[0-9]{1,10}/.exec(s.slice(numAt, numAt + 12));
    if (num) {
      const off = Number.parseInt(num[0], 10);
      if (s.startsWith("xref", off)) {
        xrefOk = verifyClassicXref(s, off);
      } else if (
        new RegExp(`^([0-9]{1,9})${WS_CLASS_PLUS}([0-9]{1,3})${WS_CLASS_PLUS}obj`).test(
          s.slice(off, off + 40)
        )
      ) {
        // xref stream — presence accepted (entries are compressed).
        xrefOk = true;
      }
    }
  }

  // /Info from the LAST original trailer, when its object survived.
  let infoRef: { num: number; gen: number } | null = null;
  const trIdx = s.lastIndexOf("trailer");
  if (trIdx >= 0) {
    const region = s.slice(trIdx, trIdx + 512);
    const m = new RegExp(
      `\\/Info${WS_CLASS_PLUS}([0-9]{1,9})${WS_CLASS_PLUS}([0-9]{1,3})${WS_CLASS_PLUS}R`
    ).exec(region);
    if (m) {
      const num = Number.parseInt(m[1], 10);
      const gen = Number.parseInt(m[2], 10);
      if (objects.some((o) => o.num === num)) {
        infoRef = { num, gen };
      }
    }
  }

  return {
    headerAtStart: headerIdx === 0,
    headerFound: headerIdx >= 0,
    eofOk: eofIdx >= 0 && eofIdx >= s.length - 64,
    xrefOk,
    infoRef,
  };
}

/** One raw "N G obj" match with its body-start position. */
interface HeaderMatch {
  num: number;
  gen: number;
  matchStart: number;
  bodyStart: number;
}

function collectHeaders(s: string): HeaderMatch[] {
  const matches: HeaderMatch[] = [];
  OBJ_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OBJ_HEADER_RE.exec(s)) !== null) {
    // The char before a real header is never a digit (a longer number's
    // tail would otherwise read as an object number).
    const prev = m.index > 0 ? s[m.index - 1] : "";
    if (prev >= "0" && prev <= "9") continue;
    matches.push({
      num: Number.parseInt(m[1], 10),
      gen: Number.parseInt(m[2], 10),
      matchStart: m.index,
      bodyStart: skipWs(s, m.index + m[0].length, s.length),
    });
  }
  return matches;
}

/**
 * Extracts every complete object between a header and the next header /
 * endobj / EOF. Stream extents honour a DIRECT /Length only when
 * "endstream" really follows it (and inflates); otherwise the
 * endstream-scan extent is used. An incomplete FINAL object sets the
 * truncation flag (mid-file incomplete objects are just dropped) — unless
 * `forXref` is true (R4-b: the xref-stream path drives the same extractor
 * with synthesized headers and must not touch the truncation flag, which
 * belongs to the whole-file scan).
 */
function extractObjects(
  s: string,
  headers: HeaderMatch[],
  forXref = false
): {
  objects: ScannedObject[];
  streamLengthsFixed: number;
  truncationDetected: boolean;
} {
  const objects: ScannedObject[] = [];
  let streamLengthsFixed = 0;
  let truncationDetected = false;

  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    const isLast = i === headers.length - 1;
    const extentEnd =
      i + 1 < headers.length ? headers[i + 1].matchStart : s.length;
    if (h.num === 0 || h.num > MAX_OBJNUM || h.gen > 65535) continue;

    let obj: ScannedObject | null = null;
    let incomplete = false;

    if (s[h.bodyStart] === "<" && s[h.bodyStart + 1] === "<") {
      const dictEnd = findDictEnd(s, h.bodyStart, extentEnd);
      if (dictEnd < 0) {
        incomplete = true; // dict never closes — the object was cut short
      } else {
        const afterDict = skipWs(s, dictEnd, extentEnd);
        const isStream =
          s.startsWith("stream", afterDict) &&
          (s[afterDict + 6] === "\r" || s[afterDict + 6] === "\n");
        if (isStream) {
          // ---- stream object: dict + stream + data + endstream ----
          let dataStart = afterDict + 6;
          if (s[dataStart] === "\r" && s[dataStart + 1] === "\n") dataStart += 2;
          else if (s[dataStart] === "\r" || s[dataStart] === "\n") dataStart += 1;

          const dictStr = s.slice(h.bodyStart, dictEnd);
          const span = findLengthSpan(dictStr);
          const isFlate = FLATE_RE.test(dictStr);

          let dataEnd = -1;
          if (span !== null && span.direct !== null) {
            // The declared extent is honored ONLY while it fits inside the
            // object's extent AND a real "endstream" follows it. A declared
            // length that runs PAST the extent is a mid-data cut (the
            // pre-fix `cand === extentEnd` clamp silently accepted the
            // truncated tail as complete — the smoke's cut-mid-file
            // fixture proved truncationDetected never fired); such an
            // object falls through to the endstream scan below and is
            // finally flagged incomplete with the partial data kept.
            const wanted = dataStart + span.direct;
            if (
              wanted < extentEnd &&
              s.startsWith("endstream", skipWs(s, wanted, extentEnd))
            ) {
              dataEnd = wanted;
            }
          }
          if (dataEnd >= 0 && isFlate && span !== null && span.direct !== null) {
            // The declared extent must actually inflate for FlateDecode;
            // when it doesn't but the FIRST endstream extent does, the
            // wrong length had landed on a later "endstream" — prefer the
            // inflating extent (the task's inflate verification).
            const scanEnd = s.indexOf("endstream", dataStart);
            if (
              scanEnd >= 0 &&
              scanEnd < dataEnd &&
              inflates(s.slice(dataStart, scanEnd)) &&
              !inflates(s.slice(dataStart, dataEnd))
            ) {
              dataEnd = scanEnd;
            }
          } else if (dataEnd < 0) {
            // Missing/indirect/wrong length — take the endstream extent.
            const scanEnd = s.indexOf("endstream", dataStart);
            if (scanEnd >= 0 && scanEnd < extentEnd) {
              dataEnd = scanEnd;
            }
          }
          if (dataEnd < 0) {
            // Stream runs to the extent end (a truncated tail).
            dataEnd = extentEnd;
            incomplete = true;
          }

          const data = s.slice(dataStart, dataEnd);
          const spliced = spliceLength(dictStr, dataEnd - dataStart);
          if (spliced.fixed) streamLengthsFixed += 1;
          obj = {
            num: h.num,
            gen: h.gen,
            isStream: true,
            dict: spliced.dict,
            data,
            body: "",
            at: h.matchStart,
          };
        } else {
          // ---- plain dict object ----
          const endobj = s.indexOf("endobj", dictEnd);
          const bodyEnd = endobj >= 0 && endobj < extentEnd ? endobj : extentEnd;
          obj = {
            num: h.num,
            gen: h.gen,
            isStream: false,
            dict: "",
            data: "",
            body: trimPdfWs(s.slice(h.bodyStart, bodyEnd)),
            at: h.matchStart,
          };
        }
      }
    } else if (h.bodyStart < extentEnd) {
      // ---- non-dict body (numbers, refs, arrays, strings) ----
      const endobj = s.indexOf("endobj", h.bodyStart);
      const bodyEnd = endobj >= 0 && endobj < extentEnd ? endobj : extentEnd;
      const body = trimPdfWs(s.slice(h.bodyStart, bodyEnd));
      const lastChar = body.length > 0 ? body[body.length - 1] : "";
      if (body.length > 0 && PLAIN_BODY_END_CHARS.has(lastChar)) {
        obj = {
          num: h.num,
          gen: h.gen,
          isStream: false,
          dict: "",
          data: "",
          body,
          at: h.matchStart,
        };
      } else {
        incomplete = true; // never closed — garbage or cut short
      }
    }

    if (obj !== null) objects.push(obj);
    if (isLast && incomplete && !forXref) truncationDetected = true;
  }

  return { objects, streamLengthsFixed, truncationDetected };
}

function scanRaw(s: string): ScanResult {
  const headers = collectHeaders(s);

  // Duplicate object numbers — count of nums seen more than once.
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const h of headers) {
    if (seen.has(h.num)) dup.add(h.num);
    else seen.add(h.num);
  }

  const extracted = extractObjects(s, headers);
  const structure = scanStructure(s, extracted.objects);

  return {
    objects: extracted.objects,
    dupObjNums: dup.size,
    streamLengthsFixed: extracted.streamLengthsFixed,
    truncationDetected: extracted.truncationDetected,
    structure,
  };
}

/* ------------------------------------------------------------------ */
/* Xref-stream salvage (R4-b)                                          */
/* ------------------------------------------------------------------ */

/** /Type /XRef in a stream dict — the xref-stream marker. */
const XREF_TYPE_RE = new RegExp(`\\/Type${WS_CLASS_PLUS}\\/XRef(?![a-zA-Z])`);
/** The classic-trailer shape this tool never trusted; xref streams only. */
const XREF_HEADER_AT_RE =
  /^([0-9]{1,9})[ \t\r\n\f\x00]+([0-9]{1,3})[ \t\r\n\f\x00]+obj/;

interface XrefRow {
  num: number;
  type: number;
  f2: number;
  f3: number;
}

/** Reads a big-endian field of `width` bytes (width 0 → 0). */
function readBE(raw: Uint8Array, at: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    value = value * 256 + (raw[at + i] ?? 0);
  }
  return value;
}

/**
 * Decodes one xref stream object into its rows: /W widths (type, field2,
 * field3) + /Index sections ([start count …], default [0 /Size]) over the
 * inflated stream bytes. Returns null for anything that does not fully
 * parse — the object-scan fallback stays the honest answer then.
 */
function parseXrefStream(obj: ScannedObject): XrefRow[] | null {
  if (!XREF_TYPE_RE.test(obj.dict)) return null;

  const wMatch = /\/W[ \t\r\n\f\x00]*\[((?:[^\]\\]|\\.)*)\]/.exec(obj.dict);
  if (!wMatch) return null;
  const widths = wMatch[1]
    .trim()
    .split(/[ \t\r\n\f\x00]+/)
    .filter((t) => t.length > 0)
    .map((t) => Number.parseInt(t, 10));
  if (
    widths.length !== 3 ||
    widths.some((n) => !Number.isInteger(n) || n < 0 || n > 8)
  ) {
    return null;
  }
  const [w1, w2, w3] = widths;
  const rowWidth = w1 + w2 + w3;
  if (rowWidth <= 0) return null;

  let sections: Array<{ start: number; count: number }> = [];
  const idxMatch = /\/Index[ \t\r\n\f\x00]*\[((?:[^\]\\]|\\.)*)\]/.exec(obj.dict);
  if (idxMatch) {
    const nums = idxMatch[1]
      .trim()
      .split(/[ \t\r\n\f\x00]+/)
      .filter((t) => t.length > 0)
      .map((t) => Number.parseInt(t, 10));
    if (nums.length === 0 || nums.length % 2 !== 0) return null;
    for (let i = 0; i < nums.length; i += 2) {
      const start = nums[i];
      const count = nums[i + 1];
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(count) ||
        start < 0 ||
        count < 0 ||
        start > MAX_OBJNUM ||
        count > MAX_OBJECTS
      ) {
        return null;
      }
      sections.push({ start, count });
    }
  } else {
    const sizeMatch = /\/Size[ \t\r\n\f\x00]+([0-9]{1,10})/.exec(obj.dict);
    if (!sizeMatch) return null;
    const size = Number.parseInt(sizeMatch[1], 10);
    if (!Number.isInteger(size) || size <= 0 || size > MAX_OBJNUM) return null;
    sections = [{ start: 0, count: size }];
  }

  let raw: Uint8Array;
  try {
    raw = unzlibSync(latin1Encode(obj.data));
  } catch {
    return null; // broken Flate — the fallback owns this file
  }
  const maxRows = Math.floor(raw.length / rowWidth);
  const declared = sections.reduce((sum, sec) => sum + sec.count, 0);
  if (maxRows <= 0) return null;

  const rows: XrefRow[] = [];
  let rowIdx = 0;
  for (const { start, count } of sections) {
    for (let k = 0; k < count && rowIdx < maxRows && rowIdx < declared; k += 1) {
      const base = rowIdx * rowWidth;
      rows.push({
        num: start + k,
        type: w1 === 0 ? 1 : readBE(raw, base, w1),
        f2: w2 === 0 ? 0 : readBE(raw, base + w1, w2),
        f3: w3 === 0 ? 0 : readBE(raw, base + w1 + w2, w3),
      });
      rowIdx += 1;
    }
  }
  return rows;
}

interface XrefStreamSalvage {
  /** Objects materialized from type-1 entries. */
  objects: ScannedObject[];
  /** The xref stream object the rows came from (newest that parses). */
  source: ScannedObject;
  /** Rows that are objects inside /ObjStm containers (kept with their
   *  container — a classic xref rebuild cannot address them directly). */
  objstmEntries: number;
}

/**
 * R4-b — xref-STREAM salvage. When the raw scan surfaced a stream whose
 * dict says /Type /XRef (linearized + object-stream files carry one
 * instead of a classic table), its /Index + /W rows hand us every
 * object's exact offset — no regex sweep needed, and objects survive even
 * when their header neighborhood is mangled. Type-1 rows are verified
 * against the bytes actually at their offset (object number must match —
 * a stale/overwritten entry is dropped, not trusted), then extracted by
 * the SAME extents logic the object scan uses. The NEWEST xref stream
 * (last in byte order) wins; if none parses cleanly, null → the object
 * scan remains the sole recovery path, exactly as before.
 */
function tryXrefStreamSalvage(
  s: string,
  objects: ScannedObject[]
): XrefStreamSalvage | null {
  const candidates = objects
    .filter((o) => o.isStream && XREF_TYPE_RE.test(o.dict))
    .sort((a, b) => b.at - a.at);

  for (const candidate of candidates) {
    const rows = parseXrefStream(candidate);
    if (rows === null) continue;

    const headers: HeaderMatch[] = [];
    let objstmEntries = 0;
    for (const row of rows) {
      if (row.type === 2) {
        objstmEntries += 1;
        continue;
      }
      if (row.type !== 1) continue; // 0 = free
      if (row.num <= 0 || row.num > MAX_OBJNUM) continue;
      const off = row.f2;
      if (off <= 0 || off >= s.length) continue;
      const m = XREF_HEADER_AT_RE.exec(s.slice(off, off + 40));
      if (!m) continue;
      const num = Number.parseInt(m[1], 10);
      if (num !== row.num) continue; // stale entry — the bytes disagree
      headers.push({
        num,
        gen: Number.parseInt(m[2], 10),
        matchStart: off,
        bodyStart: skipWs(s, off + m[0].length, s.length),
      });
    }
    if (headers.length === 0) continue;
    headers.sort((a, b) => a.matchStart - b.matchStart);
    const deduped: HeaderMatch[] = [];
    for (const h of headers) {
      if (deduped.length > 0 && deduped[deduped.length - 1].matchStart === h.matchStart) {
        continue;
      }
      deduped.push(h);
    }
    const extracted = extractObjects(s, deduped, true);
    if (extracted.objects.length === 0) continue;
    return {
      objects: extracted.objects,
      source: candidate,
      objstmEntries,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Catalog + page-tree walk                                            */
/* ------------------------------------------------------------------ */

function extractRefFrom(
  body: string,
  key: string
): { num: number; gen: number } | null {
  const m = new RegExp(
    `\\/${key}${WS_CLASS_PLUS}([0-9]{1,9})${WS_CLASS_PLUS}([0-9]{1,3})${WS_CLASS_PLUS}R`
  ).exec(body);
  if (!m) return null;
  return {
    num: Number.parseInt(m[1], 10),
    gen: Number.parseInt(m[2], 10),
  };
}

function extractKidsRefs(body: string): Array<{ num: number; gen: number }> {
  const kidsAt = new RegExp(`\\/Kids${WS_CLASS_PLUS}`).exec(body);
  if (!kidsAt) return [];
  const open = body.indexOf("[", kidsAt.index + kidsAt[0].length);
  if (open < 0) return [];
  const close = body.indexOf("]", open);
  if (close < 0) return [];
  const refs: Array<{ num: number; gen: number }> = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const region = body.slice(open, close);
  while ((m = REF_RE.exec(region)) !== null) {
    refs.push({
      num: Number.parseInt(m[1], 10),
      gen: Number.parseInt(m[2], 10),
    });
  }
  return refs;
}

/** Reachable /Type /Page leaves under a /Pages ref (missing kids skip). */
function countLeaves(
  byNum: ReadonlyMap<number, ScannedObject>,
  root: { num: number; gen: number }
): number {
  const visited = new Set<number>();
  const walk = (ref: { num: number; gen: number }, depth: number): number => {
    if (depth > MAX_TREE_DEPTH || visited.has(ref.num)) return 0;
    visited.add(ref.num);
    const node = byNum.get(ref.num);
    if (node === undefined || node.isStream) return 0;
    if (PAGE_LEAF_RE.test(node.body)) return 1;
    if (!PAGE_TREE_RE.test(node.body)) return 0;
    let leaves = 0;
    for (const kid of extractKidsRefs(node.body)) {
      leaves += walk(kid, depth + 1);
      if (leaves >= MAX_TREE_LEAVES) return MAX_TREE_LEAVES;
    }
    return leaves;
  };
  return walk(root, 0);
}

/**
 * Finds the catalog to anchor the rebuilt trailer: every recovered object
 * with /Type /Catalog is a candidate; the one with the most reachable
 * /Pages leaves wins (lowest object number breaks ties). No catalogs at
 * all → errNoCatalog; catalogs but zero reachable pages → errNoPages.
 */
function pickCatalog(
  byNum: ReadonlyMap<number, ScannedObject>
): { num: number; gen: number; leaves: number } {
  const catalogs = [...byNum.values()].filter(
    (o) => !o.isStream && CATALOG_RE.test(o.body)
  );
  if (catalogs.length === 0) {
    throw new RepairError("errNoCatalog");
  }
  let best: { num: number; gen: number; leaves: number } | null = null;
  for (const cat of catalogs) {
    const pagesRef = extractRefFrom(cat.body, "Pages");
    const leaves = pagesRef === null ? 0 : countLeaves(byNum, pagesRef);
    if (
      best === null ||
      leaves > best.leaves ||
      (leaves === best.leaves && cat.num < best.num)
    ) {
      best = { num: cat.num, gen: cat.gen, leaves };
    }
  }
  if (best === null || best.leaves <= 0) {
    throw new RepairError("errNoPages");
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Rebuild                                                            */
/* ------------------------------------------------------------------ */

/** Assembles header + objects + xref + trailer into a fresh PDF. */
function buildRebuilt(
  byNum: ReadonlyMap<number, ScannedObject>,
  root: { num: number; gen: number },
  info: { num: number; gen: number } | null
): Uint8Array {
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  const maxNum = nums[nums.length - 1];
  const parts: Array<string | Uint8Array> = [];
  let length = 0;
  const push = (part: string | Uint8Array): void => {
    parts.push(part);
    length += part.length;
  };

  push("%PDF-1.7\n");
  const offsets = new Map<number, number>();
  for (const num of nums) {
    const o = byNum.get(num);
    if (o === undefined) continue;
    offsets.set(num, length);
    if (o.isStream) {
      push(`${num} ${o.gen} obj\n`);
      push(o.dict);
      push("\nstream\n");
      push(latin1Encode(o.data));
      push("\nendstream\nendobj\n");
    } else {
      push(`${num} ${o.gen} obj\n`);
      push(o.body);
      push("\nendobj\n");
    }
  }

  const xrefOffset = length;
  const size = maxNum + 1;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n += 1) {
    const off = offsets.get(n);
    const o = off === undefined ? undefined : byNum.get(n);
    if (off === undefined || o === undefined) {
      table += "0000000000 00000 f \n";
    } else {
      table += `${String(off).padStart(10, "0")} ${String(o.gen).padStart(5, "0")} n \n`;
    }
  }
  push(table);
  push(
    `trailer\n<< /Size ${size} /Root ${root.num} ${root.gen} R` +
      (info !== null ? ` /Info ${info.num} ${info.gen} R` : "") +
      ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  const out = new Uint8Array(length);
  let pos = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      for (let i = 0; i < part.length; i += 1) {
        out[pos] = part.charCodeAt(i) & 0xff;
        pos += 1;
      }
    } else {
      out.set(part, pos);
      pos += part.length;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

async function strictVerify(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, {
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    return doc.getPageCount();
  } catch (error) {
    throw new RepairError(
      "errVerify",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

/**
 * repairPdf — the whole two-stage pipeline. Never touches the network,
 * is deterministic for a given input, and throws RepairError for the
 * honest failures (encrypted, no objects, no catalog, no pages, failed
 * verification).
 */
export async function repairPdf(
  bytes: Uint8Array,
  options: RepairOptions
): Promise<RepairOutcome> {
  const s = toLatin(bytes);

  // ---- Encryption first: repair is not crack. Both raw signatures are
  // checked so an encrypted file whose trailer was also damaged is still
  // rejected honestly instead of being "salvaged" into ciphertext soup.
  if (ENCRYPT_TRAILER_RE.test(s) || ENCRYPT_DICT_RE.test(s)) {
    throw new RepairError("errEncrypted");
  }

  // ---- Raw damage scan (ALWAYS — pdf-lib's lenient load alone cannot
  // tell a stripped file from a valid one).
  const scan = scanRaw(s);
  const damaged =
    !scan.structure.headerAtStart ||
    !scan.structure.xrefOk ||
    !scan.structure.eofOk ||
    scan.truncationDetected ||
    scan.streamLengthsFixed > 0 ||
    scan.dupObjNums > 0;

  // ---- pdf-lib structure check.
  let loaded: PDFDocument | null = null;
  let loadFailed = false;
  try {
    loaded = await PDFDocument.load(bytes, {
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } catch (error) {
    loadFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new RepairError("errEncrypted", message);
    }
  }

  /* ---------------- Stage 1: clean file ---------------------------- */
  if (loaded !== null && !damaged) {
    const objectCount = loaded.context.enumerateIndirectObjects().length;
    if (options.alsoRebuildValid) {
      // Honest rebuild of an already-valid file: fresh header + xref via
      // pdf-lib save; object streams OFF for maximum viewer compatibility.
      const out = await loaded.save({ useObjectStreams: false });
      const pages = await strictVerify(out);
      return {
        bytes: out,
        report: {
          structureWasValid: true,
          unchanged: false,
          loadFailed,
          xrefRebuilt: false,
          headerFixed: false,
          eofMissing: false,
          truncationDetected: false,
          objectsRecovered: objectCount,
          duplicatesResolved: 0,
          streamLengthsFixed: 0,
          xrefStreamSalvaged: false,
          xrefStreamEntries: 0,
          pages,
          bytesIn: bytes.length,
          bytesOut: out.length,
        },
      };
    }
    const pages = loaded.getPageCount();
    return {
      bytes,
      report: {
        structureWasValid: true,
        unchanged: true,
        loadFailed,
        xrefRebuilt: false,
        headerFixed: false,
        eofMissing: false,
        truncationDetected: false,
        objectsRecovered: objectCount,
        duplicatesResolved: 0,
        streamLengthsFixed: 0,
        xrefStreamSalvaged: false,
        xrefStreamEntries: 0,
        pages,
        bytesIn: bytes.length,
        bytesOut: bytes.length,
      },
    };
  }

  /* ---------------- Stage 2: raw salvage ---------------------------- */
  if (scan.objects.length === 0) {
    throw new RepairError("errNoObjects");
  }
  const salvage = scan.objects.slice(0, MAX_OBJECTS);

  // R4-b — two stages stay honest: the xref-STREAM path is tried first
  // (its /Index+/W offsets are exact and each one is verified against the
  // bytes actually at that offset); whatever it does not cover (appended
  // incremental updates, the xref stream object itself, hybrid
  // leftovers) is merged from the regex object scan. When no xref stream
  // parses, the scan alone rebuilds the table — the original behavior,
  // byte-for-byte.
  const byNum = new Map<number, ScannedObject>();
  let xrefStreamSalvaged = false;
  let xrefStreamEntries = 0;
  // A /Type /XRef stream whose rows cannot be parsed (un-inflatable
  // bytes, garbage /W//Index) is pure navigation junk for the OLD
  // layout: pdf-lib (and some viewers) eagerly decode /Type /XRef
  // streams and the garbage rows make the whole load fail. The rebuilt
  // file ships a fresh classic table anyway, so such streams are
  // excluded from the rebuild — and honestly not counted as recovered.
  // Stale-but-parseable xref streams stay (byte-faithful recovery).
  const isJunkXrefStream = (o: ScannedObject): boolean =>
    o.isStream && XREF_TYPE_RE.test(o.dict) && parseXrefStream(o) === null;
  const xrefSalvage = tryXrefStreamSalvage(s, scan.objects);
  if (xrefSalvage !== null) {
    for (const o of xrefSalvage.objects) {
      byNum.set(o.num, o);
    }
    xrefStreamEntries = xrefSalvage.objects.length;
    xrefStreamSalvaged = true;
    for (const o of salvage) {
      if (!byNum.has(o.num) && !isJunkXrefStream(o)) byNum.set(o.num, o);
    }
  } else {
    // Last complete occurrence wins for duplicate object numbers (an
    // earlier complete copy survives when the later one was cut short).
    for (const o of salvage) {
      if (!isJunkXrefStream(o)) byNum.set(o.num, o);
    }
  }

  const root = pickCatalog(byNum);
  const out = buildRebuilt(byNum, root, scan.structure.infoRef);
  const pages = await strictVerify(out);

  return {
    bytes: out,
    report: {
      structureWasValid: false,
      unchanged: false,
      loadFailed,
      xrefRebuilt: !scan.structure.xrefOk,
      headerFixed: !scan.structure.headerAtStart,
      eofMissing: !scan.structure.eofOk,
      truncationDetected: scan.truncationDetected,
      objectsRecovered: byNum.size,
      duplicatesResolved: scan.dupObjNums,
      streamLengthsFixed: scan.streamLengthsFixed,
      xrefStreamSalvaged,
      xrefStreamEntries,
      pages,
      bytesIn: bytes.length,
      bytesOut: out.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion + naming                                   */
/* ------------------------------------------------------------------ */

function sanitizeFileWord(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * parseRun — the options payload the surface sends as options.run.
 * Garbage JSON degrades to the defaults; only an explicit false disables
 * the rebuild switch; the locale must be exactly "hi".
 */
export function parseRun(raw: string): RepairOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    alsoRebuildValid: o.alsoRebuildValid !== false,
    locale: o.locale === "hi" ? "hi" : "en",
    fileWord: sanitizeFileWord(typeof o.fileWord === "string" ? o.fileWord : ""),
  };
}

/** Download base name: strips .pdf, sanitizes, localized fallback. */
export function outputBaseName(
  name: string,
  locale: "en" | "hi",
  fileWord = ""
): string {
  const base = name
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  if (base.length > 0) return base.slice(0, 120);
  const word = fileWord.trim() || (locale === "hi" ? "दस्तावेज़" : "document");
  return word.slice(0, 60);
}
