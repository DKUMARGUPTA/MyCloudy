/**
 * Publisher to PDF model (RB4-e) — pure model. No DOM, no pdf-lib, no
 * worker APIs: the same parsePub feeds the surface's live file summary
 * AND the worker's render path, so the preview numbers can never
 * disagree with the output.
 *
 * HONEST REALITY (documented everywhere): Microsoft Publisher's .pub is
 * an UNDOCUMENTED OLE2 Compound File Binary container. No open-source
 * complete parser exists. This tool is therefore an honest TEXT SALVAGE:
 *
 *  1. A clean-room OLE2/CFB container reader (header signature
 *     D0 CF 11 E0 A1 B1 1A E1, 512-byte sectors for v3, DIFAT → FAT →
 *     sector chains, 128-byte directory entries with UTF-16LE names,
 *     mini-FAT + the root's mini stream for streams < 4096 bytes — both
 *     paths implemented, with a normal-FAT fallback for nonstandard
 *     writers).
 *  2. Stream triage: every stream is scanned for long printable
 *     UTF-16LE runs (the .pub convention stores story text as UTF-16);
 *     single-byte ASCII runs are the fallback. Paragraph breaks come
 *     from CR/LF inside runs and from NUL/non-text gaps between runs.
 *  3. Reflow: paragraphs → blocks with an HONEST heading heuristic —
 *     font/size/style data is not reliably extractable from the binary
 *     story records, so headings are guessed from ALL-CAPS / Title-Case
 *     short lines (and short Devanagari lines without a danda) at a
 *     chosen base size.
 *
 * What this means for the user: the TEXT of the publication is carried
 * over as clean, selectable, re-flowed PDF text; complex layouts,
 * images, shapes, columns and exact page composition are NOT (mirrored
 * in config.ts + the surface). For full fidelity the better path is
 * exporting a PDF from Publisher itself — the FAQ says so.
 */

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored in the worker + surface notes)                   */
/* ------------------------------------------------------------------ */

export const MAX_PARAGRAPHS = 800;
export const MAX_TOTAL_CHARS = 300_000;
export const MAX_PARA_TEXT = 10_000;
/** A text run shorter than this is noise (font names, dates, tags). */
const MIN_RUN_CHARS = 4;
/** A stream must yield at least this many characters to count as text. */
const MIN_STREAM_CHARS = 40;
/** Guard for the DIFAT/FAT walk (8192 FAT sectors ≈ 512 MB — plenty). */
const MAX_FAT_SECTORS = 8192;
const MAX_DIFAT_SECTORS = 4096;

/* ------------------------------------------------------------------ */
/* Errors — honest taxonomy                                             */
/* ------------------------------------------------------------------ */

export type PubErrorCode =
  /** No OLE2 signature — and not identifiable as anything else either. */
  | "errNotPub"
  /** ZIP signature — a modern Office/XML/zip file renamed .pub. */
  | "errZipFile"
  /** Plain printable text — a .txt (or similar) renamed .pub. */
  | "errTextFile"
  /** OLE2 signature but the container structure is unusable. */
  | "errCorrupt"
  /** Container parsed fine — zero usable text in every stream. */
  | "errNoText"
  /** Every text-candidate stream failed its sector-chain read. */
  | "errStreamRead";

/** Typed model error — the worker maps `code` onto an i18n key. */
export class PubError extends Error {
  readonly code: PubErrorCode;
  constructor(code: PubErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "PubError";
  }
}

/* ------------------------------------------------------------------ */
/* OLE2 / CFB constants                                                 */
/* ------------------------------------------------------------------ */

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const HEADER_LEN = 512;

/** true when the bytes start with the OLE2 compound-file signature. */
export function isOle2File(head: Uint8Array): boolean {
  if (head.length < 8) return false;
  for (let i = 0; i < 8; i += 1) {
    if (head[i] !== OLE_MAGIC[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (word-to-pdf recipe)  */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true when every char is encodable in WinAnsi (CP1252) minus controls. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Text-run scanning (UTF-16LE primary, ASCII fallback)                */
/* ------------------------------------------------------------------ */

/**
 * Code units that participate in a UTF-16LE text run: printable ASCII,
 * Latin-1 supplement, WinAnsi punctuation, Devanagari, space/tab and
 * CR/LF (paragraph breaks INSIDE a story — they are kept in the run and
 * split later). NUL never qualifies, so NUL-separated records break the
 * run exactly the way .pub story chunks do.
 */
function isTextCodeUnit(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return true;
  if (cp >= 0x21 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  if (cp >= 0x0900 && cp <= 0x097f) return true;
  if (WINANSI_EXTRA.has(cp)) return true;
  if (cp === 0x20b9 || cp === 0x200b || cp === 0x200c || cp === 0x200d) {
    return true; // ₹ + zero-width joiners Devanagari needs
  }
  return false;
}

function isTextAsciiByte(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true;
  return b >= 0x20 && b <= 0x7e;
}

interface TextRun {
  offset: number;
  text: string;
}

function unitsToString(units: number[]): string {
  let out = "";
  for (let i = 0; i < units.length; i += 1024) {
    out += String.fromCharCode(...units.slice(i, i + 1024));
  }
  return out;
}

/** Scans one byte alignment (0 or 1) for printable UTF-16LE runs. */
function scanUtf16Runs(bytes: Uint8Array, align: 0 | 1): TextRun[] {
  const runs: TextRun[] = [];
  const n = bytes.length;
  let i = align;
  while (i + 1 < n) {
    if (!isTextCodeUnit(bytes[i]! | (bytes[i + 1]! << 8))) {
      i += 2;
      continue;
    }
    const offset = i;
    const units: number[] = [];
    while (i + 1 < n) {
      const cp = bytes[i]! | (bytes[i + 1]! << 8);
      if (!isTextCodeUnit(cp)) break;
      units.push(cp);
      i += 2;
    }
    if (units.length >= MIN_RUN_CHARS) {
      runs.push({ offset, text: unitsToString(units) });
    }
  }
  return runs;
}

/** Scans for printable single-byte ASCII runs (the honest fallback). */
function scanAsciiRuns(bytes: Uint8Array): TextRun[] {
  const runs: TextRun[] = [];
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    if (!isTextAsciiByte(bytes[i]!)) {
      i += 1;
      continue;
    }
    const offset = i;
    let end = i;
    while (end < n && isTextAsciiByte(bytes[end]!)) end += 1;
    if (end - offset >= MIN_RUN_CHARS) {
      const units: number[] = [];
      for (let k = offset; k < end; k += 1) units.push(bytes[k]!);
      runs.push({ offset, text: unitsToString(units) });
    }
    i = end;
  }
  return runs;
}

/** CR/LF splits + whitespace normalization + empty-drop. */
function runsToParagraphs(runs: TextRun[]): string[] {
  const out: string[] = [];
  for (const run of runs) {
    for (const piece of run.text.split(/[\r\n]+/)) {
      const t = piece.replace(/[\t ]+/g, " ").trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

function runsCharCount(runs: TextRun[]): number {
  let n = 0;
  for (const r of runs) n += r.text.length;
  return n;
}

/** One stream's honest verdict: which encoding won, and its paragraphs. */
export interface StreamText {
  paragraphs: string[];
  chars: number;
  encoding: "utf16" | "ascii" | "none";
}

export function extractStreamText(data: Uint8Array): StreamText {
  const u16 = [...scanUtf16Runs(data, 0), ...scanUtf16Runs(data, 1)].sort(
    (a, b) => a.offset - b.offset
  );
  const u16Chars = runsCharCount(u16);
  if (u16Chars >= MIN_STREAM_CHARS) {
    return {
      paragraphs: runsToParagraphs(u16),
      chars: u16Chars,
      encoding: "utf16",
    };
  }
  const a8 = scanAsciiRuns(data);
  const a8Chars = runsCharCount(a8);
  if (a8Chars >= MIN_STREAM_CHARS) {
    return {
      paragraphs: runsToParagraphs(a8),
      chars: a8Chars,
      encoding: "ascii",
    };
  }
  return { paragraphs: [], chars: Math.max(u16Chars, a8Chars), encoding: "none" };
}

/* ------------------------------------------------------------------ */
/* CFB reader                                                          */
/* ------------------------------------------------------------------ */

/** One extracted stream, in directory-entry id order. */
export interface CfbStreamEntry {
  id: number;
  name: string;
  /** declared size (clamped to the file length — salvage, never crash). */
  size: number;
  /** extracted stream bytes (mini-FAT or normal FAT path). */
  data: Uint8Array;
  /** true when the full sector chain + size could be honoured. */
  complete: boolean;
  /** which chain path served the bytes (surface preview + smoke). */
  path: "mini" | "normal";
}

export interface CfbFile {
  sectorSize: number;
  miniSectorSize: number;
  rootName: string;
  streams: CfbStreamEntry[];
  /** streams whose chain broke before their declared size. */
  streamFailures: number;
}

interface ChainResult {
  sectors: number[];
  /** true when the walk ended on ENDOFCHAIN. */
  ended: boolean;
}

function chainSectors(
  fat: number[],
  start: number,
  totalSectors: number,
  limit: number
): ChainResult {
  const sectors: number[] = [];
  const seen = new Set<number>();
  let s = start;
  let guard = 0;
  while (guard <= limit + 1) {
    guard += 1;
    if (s === ENDOFCHAIN) return { sectors, ended: true };
    if (
      s === FREESECT ||
      s === FATSECT ||
      s === DIFSECT ||
      s < 0 ||
      s >= totalSectors ||
      seen.has(s)
    ) {
      return { sectors, ended: false };
    }
    seen.add(s);
    sectors.push(s);
    s = s < fat.length ? fat[s]! : FREESECT;
  }
  return { sectors, ended: false };
}

function concatSectors(
  bytes: Uint8Array,
  sectors: number[],
  sectorSize: number,
  size: number
): Uint8Array {
  const out = new Uint8Array(Math.min(size, sectors.length * sectorSize));
  let filled = 0;
  for (const s of sectors) {
    if (filled >= out.length) break;
    const off = HEADER_LEN + s * sectorSize;
    const avail = Math.max(0, Math.min(sectorSize, bytes.length - off));
    if (avail <= 0) break;
    const take = Math.min(avail, out.length - filled);
    out.set(bytes.subarray(off, off + take), filled);
    filled += take;
  }
  return out;
}

/** Throws the honest non-CFB classification (zip / text / generic). */
function throwNotCfb(bytes: Uint8Array): never {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  ) {
    throw new PubError("errZipFile", "zip signature");
  }
  if (bytes.length >= 16) {
    const window = Math.min(bytes.length, 2048);
    let texty = 0;
    let binaryish = 0;
    for (let i = 0; i < window; i += 1) {
      const b = bytes[i]!;
      if (
        b === 0x09 ||
        b === 0x0a ||
        b === 0x0d ||
        (b >= 0x20 && b <= 0x7e) ||
        b >= 0x80
      ) {
        texty += 1; // UTF-8 multibyte counts as text
      } else {
        binaryish += 1;
      }
    }
    if (binaryish === 0 && texty / window >= 0.7) {
      throw new PubError("errTextFile", "plain text");
    }
  }
  throw new PubError("errNotPub", "no OLE2 signature");
}

/**
 * Clean-room OLE2/CFB container reader: header → DIFAT → FAT → directory
 * (UTF-16LE names) → mini-FAT + root mini stream → stream bytes. Never
 * returns a half-parsed file without saying so (streamFailures); only
 * structural breakage (bad header, unreadable FAT, broken directory
 * chain, no root) throws errCorrupt.
 */
export function parseCfb(bytes: Uint8Array): CfbFile {
  if (bytes.length < HEADER_LEN || !isOle2File(bytes)) {
    throwNotCfb(bytes);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const major = dv.getUint16(0x1a, true);
  const byteOrder = dv.getUint16(0x1c, true);
  const sectorShift = dv.getUint16(0x1e, true);
  let miniShift = dv.getUint16(0x20, true);

  if (byteOrder !== 0xfffe) {
    throw new PubError("errCorrupt", "bad byte order");
  }
  if (major === 3 ? sectorShift !== 9 : major !== 4 || sectorShift !== 12) {
    throw new PubError("errCorrupt", `v${major} sector shift ${sectorShift}`);
  }
  if (miniShift < 6 || miniShift > sectorShift) miniShift = 6;
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniShift;
  const totalSectors = Math.floor((bytes.length - HEADER_LEN) / sectorSize);
  if (totalSectors < 1) {
    throw new PubError("errCorrupt", "no sectors after the header");
  }

  /* ---------- DIFAT (FAT sector list) ---------- */
  const fatSectorNums: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const v = dv.getUint32(0x4c + i * 4, true);
    if (v === FREESECT || v === ENDOFCHAIN) break;
    fatSectorNums.push(v);
    if (fatSectorNums.length > MAX_FAT_SECTORS) {
      throw new PubError("errCorrupt", "DIFAT overflow");
    }
  }
  let nextDifat = dv.getUint32(0x44, true);
  let difatGuard = 0;
  while (nextDifat !== ENDOFCHAIN && nextDifat !== FREESECT) {
    difatGuard += 1;
    if (
      difatGuard > MAX_DIFAT_SECTORS ||
      nextDifat < 0 ||
      nextDifat >= totalSectors
    ) {
      throw new PubError("errCorrupt", "DIFAT chain broken");
    }
    const off = HEADER_LEN + nextDifat * sectorSize;
    if (off + sectorSize > bytes.length) {
      throw new PubError("errCorrupt", "truncated DIFAT sector");
    }
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i += 1) {
      const v = dv.getUint32(off + i * 4, true);
      if (v === FREESECT || v === ENDOFCHAIN) continue;
      fatSectorNums.push(v);
      if (fatSectorNums.length > MAX_FAT_SECTORS) {
        throw new PubError("errCorrupt", "DIFAT overflow");
      }
    }
    nextDifat = dv.getUint32(off + per * 4, true);
  }

  /* ---------- FAT (flat next-sector table) ---------- */
  const fat: number[] = [];
  for (const fs of fatSectorNums) {
    if (fs < 0 || fs >= totalSectors) {
      throw new PubError("errCorrupt", "FAT sector out of range");
    }
    const off = HEADER_LEN + fs * sectorSize;
    const avail = Math.max(0, Math.min(sectorSize, bytes.length - off));
    const entries = Math.floor(avail / 4);
    for (let i = 0; i < entries; i += 1) {
      fat.push(dv.getUint32(off + i * 4, true));
    }
  }
  if (fat.length === 0) {
    throw new PubError("errCorrupt", "no FAT");
  }

  /* ---------- Directory chain ---------- */
  const firstDir = dv.getUint32(0x30, true);
  const dirWalk = chainSectors(fat, firstDir, totalSectors, totalSectors + 2);
  if (dirWalk.sectors.length === 0 || !dirWalk.ended) {
    throw new PubError("errCorrupt", "directory chain broken");
  }
  const dirBytes = concatSectors(
    bytes,
    dirWalk.sectors,
    sectorSize,
    dirWalk.sectors.length * sectorSize
  );
  const entryCount = Math.floor(dirBytes.length / 128);
  if (entryCount < 1) {
    throw new PubError("errCorrupt", "no directory entries");
  }

  /* ---------- Entry structs ---------- */
  interface RawEntry {
    id: number;
    type: number;
    name: string;
    start: number;
    size: number;
  }
  const raw: RawEntry[] = [];
  for (let id = 0; id < entryCount; id += 1) {
    const off = id * 128;
    const type = dirBytes[off + 0x42]!;
    if (type !== 1 && type !== 2 && type !== 5) continue; // 0/unallocated/reserved
    const nameLen = dirBytes[off + 0x40]! | (dirBytes[off + 0x41]! << 8);
    let name = "";
    if (nameLen >= 4 && nameLen <= 64) {
      const chars = Math.floor((nameLen - 2) / 2); // minus the null terminator
      for (let c = 0; c < chars; c += 1) {
        name += String.fromCharCode(
          dirBytes[off + c * 2]! | (dirBytes[off + c * 2 + 1]! << 8)
        );
      }
    }
    let size = 0;
    for (let b = 0; b < 8; b += 1) {
      size += dirBytes[off + 0x78 + b]! * 2 ** (8 * b);
    }
    raw.push({
      id,
      type,
      name,
      start:
        dirBytes[off + 0x74]! +
        dirBytes[off + 0x75]! * 0x100 +
        dirBytes[off + 0x76]! * 0x10000 +
        dirBytes[off + 0x77]! * 0x1000000,
      size,
    });
  }

  const root = raw.find((e) => e.type === 5);
  if (!root) {
    throw new PubError("errCorrupt", "no root entry");
  }

  /* ---------- Mini FAT + the root's mini stream ---------- */
  const miniCutoff = dv.getUint32(0x38, true) || 4096;
  const firstMiniFat = dv.getUint32(0x3c, true);
  const miniFat: number[] = [];
  if (firstMiniFat !== ENDOFCHAIN && firstMiniFat !== FREESECT) {
    const walk = chainSectors(fat, firstMiniFat, totalSectors, totalSectors + 2);
    for (const s of walk.sectors) {
      const off = HEADER_LEN + s * sectorSize;
      const avail = Math.max(0, Math.min(sectorSize, bytes.length - off));
      const entries = Math.floor(avail / 4);
      for (let i = 0; i < entries; i += 1) {
        miniFat.push(dv.getUint32(off + i * 4, true));
      }
    }
  }
  const rootSize = Math.min(root.size, bytes.length);
  let miniStream = new Uint8Array(0);
  if (rootSize > 0) {
    const walk = chainSectors(fat, root.start, totalSectors, totalSectors + 2);
    miniStream = concatSectors(bytes, walk.sectors, sectorSize, rootSize);
  }

  /** Mini-FAT read with the honest normal-FAT fallback for odd writers. */
  const readStreamBytes = (
    start: number,
    size: number
  ): { data: Uint8Array; complete: boolean; path: "mini" | "normal" } => {
    if (size <= 0) {
      return { data: new Uint8Array(0), complete: true, path: "normal" };
    }
    if (size < miniCutoff && miniStream.length > 0 && miniFat.length > 0) {
      const need = Math.ceil(size / miniSectorSize);
      const sectors: number[] = [];
      const seen = new Set<number>();
      let s = start;
      let complete = false;
      const cap = Math.min(need + 1, miniFat.length + 2);
      let guard = 0;
      while (guard <= cap + 1) {
        guard += 1;
        if (s === ENDOFCHAIN) {
          complete = sectors.length >= need;
          break;
        }
        if (s === FREESECT || s < 0 || seen.has(s)) break;
        const off = s * miniSectorSize;
        if (off + miniSectorSize > miniStream.length + miniSectorSize) break;
        seen.add(s);
        sectors.push(s);
        if (sectors.length >= need) {
          complete = true;
          break;
        }
        s = miniFat[s] ?? FREESECT;
      }
      if (sectors.length > 0) {
        const data = new Uint8Array(
          Math.min(size, sectors.length * miniSectorSize)
        );
        let filled = 0;
        for (const s2 of sectors) {
          if (filled >= data.length) break;
          const off = s2 * miniSectorSize;
          const avail = Math.max(
            0,
            Math.min(miniSectorSize, miniStream.length - off)
          );
          if (avail <= 0) break;
          const take = Math.min(avail, data.length - filled);
          data.set(miniStream.subarray(off, off + take), filled);
          filled += take;
        }
        return { data, complete, path: "mini" };
      }
      // zero mini sectors gathered — try the normal FAT (nonstandard but
      // seen in the wild); falls through to the normal read below.
    }
    const need = Math.ceil(size / sectorSize);
    const walk = chainSectors(
      fat,
      start,
      totalSectors,
      Math.min(need, totalSectors + 2)
    );
    const data = concatSectors(bytes, walk.sectors, sectorSize, size);
    return {
      data,
      complete: walk.sectors.length >= need,
      path: "normal",
    };
  };

  /* ---------- Streams (directory id order — see file header) ---------- */
  const streams: CfbStreamEntry[] = [];
  let streamFailures = 0;
  for (const e of raw) {
    if (e.type !== 2) continue;
    const size = Math.min(e.size, bytes.length);
    const { data, complete, path } = readStreamBytes(e.start, size);
    if (!complete && size > 0) streamFailures += 1;
    streams.push({
      id: e.id,
      name: e.name || `stream-${e.id}`,
      size,
      data,
      complete,
      path,
    });
  }

  return {
    sectorSize,
    miniSectorSize,
    rootName: root.name,
    streams,
    streamFailures,
  };
}

/* ------------------------------------------------------------------ */
/* Story extraction → reflow document                                   */
/* ------------------------------------------------------------------ */

/** One stream's text verdict, kept for the surface preview. */
export interface PubStoryStream {
  id: number;
  name: string;
  paragraphs: string[];
  chars: number;
  encoding: "utf16" | "ascii";
  /** which chain path served the bytes — the surface preview chip. */
  path: "mini" | "normal";
}

export interface PubStories {
  streams: PubStoryStream[];
  streamsScanned: number;
  streamsFailed: number;
}

/** Triage every stream; text-bearing ones keep their paragraphs. */
export function extractStories(cfb: CfbFile): PubStories {
  const streams: PubStoryStream[] = [];
  for (const s of cfb.streams) {
    const t = extractStreamText(s.data);
    if (t.paragraphs.length === 0) continue;
    streams.push({
      id: s.id,
      name: s.name,
      paragraphs: t.paragraphs,
      chars: t.chars,
      encoding: t.encoding,
      path: s.path,
    });
  }
  return {
    streams,
    streamsScanned: cfb.streams.length,
    streamsFailed: cfb.streamFailures,
  };
}

/* ------------------------------------------------------------------ */
/* hindiNorm — the pinned lost-session lesson                           */
/* ------------------------------------------------------------------ */

const DEVA_NORM_RE = /[\u0900-\u097F]/;

/**
 * Noto subset CMaps can inject stray ASCII quotes (") between
 * Devanagari words. Strip `"` — but ONLY from strings that actually
 * contain Devanagari; English quotes are left completely alone.
 */
export function hindiNorm(s: string): string {
  return DEVA_NORM_RE.test(s) ? s.split('"').join("") : s;
}

/* ------------------------------------------------------------------ */
/* Heading heuristic (honest: sizes are NOT reliably in the binary)     */
/* ------------------------------------------------------------------ */

const DEVA_RE = /[\u0900-\u097F]/;

/**
 * 1 = ALL-CAPS short line, 2 = Title-Case short line (or a short
 * Devanagari line without a danda — Hindi sentences end with ।).
 * undefined = body text. The first heading-like paragraph of the whole
 * document is upgraded to a title by the assembler.
 */
export function classifyHeading(text: string): 1 | 2 | undefined {
  const t = text.trim();
  if (t.length === 0 || t.length > 64) return undefined;
  if (t.endsWith(".")) return undefined; // a sentence, not a heading
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (/[A-Z]/.test(t) && t === t.toUpperCase()) return 1; // ALL CAPS
  const titleCased = words.every((w) => /^[A-Za-z]/.test(w) ? /^[A-Z]/.test(w) : true);
  if (titleCased && words.length >= 2 && !/^[a-z]/.test(t)) return 2;
  if (DEVA_RE.test(t) && !/[।?!]/.test(t) && words.length >= 2) return 2;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Document model                                                       */
/* ------------------------------------------------------------------ */

export interface PubPara {
  text: string;
  /** 0 = title (first heading-like para), 1 = ALL-CAPS, 2 = Title-Case. */
  heading?: 0 | 1 | 2;
}

export interface ParsedPub {
  paras: PubPara[];
  paraCount: number;
  wordCount: number;
  charCount: number;
  streamsScanned: number;
  streamsUsed: number;
  streamsFailed: number;
  /** text-bearing streams (name/chars/encoding/path) for the preview. */
  stories: PubStoryStream[];
  /** true when any hard cap was hit — the surface shows an honest note. */
  truncated: boolean;
}

/**
 * Full honest pipeline: container → stories → reflowed paragraphs.
 * Throws PubError for every non-CFB / structural case; a container
 * with no usable text returns an EMPTY document (the caller decides
 * errNoText vs errStreamRead from streamsFailed).
 */
export function parsePub(bytes: Uint8Array): ParsedPub {
  const cfb = parseCfb(bytes);
  const stories = extractStories(cfb);

  const paras: PubPara[] = [];
  let chars = 0;
  let truncated = false;
  outer: for (const st of stories.streams) {
    for (const text of st.paragraphs) {
      if (paras.length >= MAX_PARAGRAPHS || chars >= MAX_TOTAL_CHARS) {
        truncated = true;
        break outer;
      }
      const t = hindiNorm(text.slice(0, MAX_PARA_TEXT)).trim();
      if (t.length === 0) continue;
      // consecutive-identical noise (story thumbnails) collapses
      if (paras.length > 0 && paras[paras.length - 1]!.text === t) continue;
      paras.push({ text: t });
      chars += t.length;
    }
  }

  for (let i = 0; i < paras.length; i += 1) {
    const h = classifyHeading(paras[i]!.text);
    paras[i]!.heading = i === 0 && h !== undefined ? 0 : h;
  }

  let words = 0;
  for (const p of paras) {
    words += p.text.split(/\s+/).filter(Boolean).length;
  }
  return {
    paras,
    paraCount: paras.length,
    wordCount: words,
    charCount: chars,
    streamsScanned: stories.streamsScanned,
    streamsUsed: stories.streams.length,
    streamsFailed: stories.streamsFailed,
    stories: stories.streams,
    truncated,
  };
}

/** true when any drawn text needs the Devanagari (non-WinAnsi) font. */
export function needsNoto(doc: ParsedPub): boolean {
  for (const p of doc.paras) {
    if (!isWinAnsiText(p.text)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Page estimate (same geometry constants as render.ts)                  */
/* ------------------------------------------------------------------ */

export const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export const MARGIN_PT: Record<"normal" | "narrow", number> = {
  normal: 56,
  narrow: 28,
};

export interface PubEstimateOpts {
  pageSize: "a4" | "letter";
  margin: "normal" | "narrow";
  baseSize: number;
}

/** Heading size multipliers — MUST mirror render.ts exactly. */
export const HEADING_SCALE: Record<0 | 1 | 2, number> = {
  0: 1.9,
  1: 1.5,
  2: 1.22,
};

/** Honest ± page estimate from the same geometry the renderer uses. */
export function estimatePages(doc: ParsedPub, opts: PubEstimateOpts): number {
  if (doc.paras.length === 0) return 0;
  const [pw, ph] = PAGE_SIZES[opts.pageSize];
  const margin = MARGIN_PT[opts.margin];
  const contentW = pw - margin * 2;
  const contentH = ph - margin * 2;
  const lhFactor = 1.43;
  let totalHeight = 0;
  for (const p of doc.paras) {
    const size =
      p.heading !== undefined
        ? opts.baseSize * HEADING_SCALE[p.heading]
        : opts.baseSize;
    const lh = size * lhFactor;
    const avgCharW = size * 0.5;
    const charsPerLine = Math.max(20, Math.floor(contentW / avgCharW));
    const lines = Math.max(1, Math.ceil(p.text.length / charsPerLine));
    totalHeight += lines * lh + opts.baseSize * 0.3;
  }
  return Math.max(1, Math.ceil(totalHeight / contentH));
}

/* ------------------------------------------------------------------ */
/* Output file name (house convention + localized fallback)             */
/* ------------------------------------------------------------------ */

function cleanName(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 32;
    out += c >= 0x20 && c !== 0x7f ? ch : "_";
  }
  return out;
}

/**
 * "Newsletter.pub" → "Newsletter.pdf"; a nameless file falls back to
 * the localized word ("document" / "दस्तावेज़"). Unicode survives;
 * path separators and unsafe chars do not.
 */
export function outputPdfName(fileName: string, fileWord: string): string {
  const base = cleanName(fileName.replace(/\.(pub|publisher)$/i, ""))
    .trim()
    .slice(0, 120);
  const fallback = cleanName(fileWord).trim().slice(0, 60) || "document";
  return `${base || fallback}.pdf`;
}
