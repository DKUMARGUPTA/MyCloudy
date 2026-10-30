/**
 * DocoPDF own PDF micro-engine — whole-document rewriter (P6-r).
 *
 * The organize writer is page-surgery: it rebuilds a FRESH catalog and
 * renumbers everything reachable from the page tree. Compress-family
 * tools need the opposite — keep the document EXACTLY as parsed, only:
 *   - swap some indirect objects (re-encoded image streams),
 *   - omit some (deduped duplicates, stripped metadata),
 *   - optionally drop the trailer /Info,
 *   - re-serialize the WHOLE object table (pdf-lib save semantics).
 *
 * So this writer PRESERVES object numbers: every ref in every content
 * stream and dict stays valid with zero remapping. Source ObjStm/XRef
 * container streams are consumed by the parse and re-emitted as plain
 * objects — their residents are listed individually (exactly like
 * pdf-lib's load→save).
 *
 * `objectStreams: true` packs every non-stream object into Flate'd
 * ObjStm containers + an XRef stream (PDF 1.5+), reproducing pdf-lib's
 * `save({ useObjectStreams: true })` byte-shrinking structural pass —
 * text-heavy files land at roughly half their classic size.
 *
 * Classic mode writes subsection xref tables (one per run of consecutive
 * numbers) + a classic trailer.
 *
 * Encrypted documents must be refused by the CALLER before this runs
 * (the parser already refuses them).
 */

import { zlibSync } from "@/lib/own/zip";
import { type PdfObj, asName, asArr, dget } from "./objects";
import { type ParsedPdf, PdfError } from "./parser";
import { serializePreserve } from "./writer";

export interface RewriteOptions {
  /** Object number → replacement (e.g. the re-encoded image stream). */
  replacements?: Map<number, PdfObj>;
  /** Object numbers to omit entirely (deduped duplicates, stripped XMP…). */
  deletions?: Set<number>;
  /** Pack non-stream objects into ObjStm containers + an XRef stream. */
  objectStreams?: boolean;
  /** Omit the trailer /Info (metadata strip). */
  dropInfo?: boolean;
  /**
   * Install a brand-new Info dict (P6-s): writes the object at its given
   * number and points trailer /Info at it. Wins over dropInfo; the number
   * must be ABOVE every existing object number (container numbering in
   * the ObjStm path accounts for it via the object table).
   */
  infoOverride?: { num: number; obj: PdfObj };
  /**
   * Brand-new objects written ABOVE the source numbering (P6-w-b): the
   * security handler's /Encrypt dict rides here, unencrypted, while every
   * source object goes through `replacements`. Classic output in BOTH
   * modes (an unencrypted dict must never be packed into an ObjStm whose
   * residents share the container's key). Numbers must be above every
   * existing object number.
   */
  extraObjects?: Array<{ num: number; obj: PdfObj }>;
  /** Raise the %PDF- header to at least this version (e.g. "1.6"/"1.7"). */
  minVersion?: string;
  /** Extra trailer pairs (serialized inline; refs keep their numbers). */
  extraTrailer?: Array<[string, PdfObj]>;
  /** (done, total) — coarse progress for the worker's progress bar. */
  onProgress?: (done: number, total: number) => void;
}

/** Max objects per ObjStm container (qpdf-style chunking). */
const OBJSTM_MAX_OBJECTS = 100;
/** Max serialized body bytes per ObjStm before starting a new one. */
const OBJSTM_MAX_BODY = 96 * 1024;

/** ByteSink — tiny local clone of the writer's sink (module-private there). */
class Sink {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.length += b.length;
  }

  text(s: string): void {
    this.bytes(asciiBytes(s));
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function asciiBytes(s: string): Uint8Array {
  // Serialize output is ASCII (headers, dicts, hex strings); encoding a
  // latin1 edge byte through TextEncoder would mangle it — map manually.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function versionString(doc: ParsedPdf, min: string): string {
  const raw = doc.version;
  const ok = typeof raw === "string" && /^\d\.\d$/.test(raw);
  const v = ok ? raw! : "1.7";
  const value = Number(v[0]) * 10 + Number(v[2]);
  const minValue = Number(min[0]) * 10 + Number(min[2]);
  return value >= minValue ? v : min;
}

/** Is this parsed object an ObjStm / XRef CONTAINER (not real content)? */
function isStructuralContainer(obj: PdfObj | undefined): boolean {
  if (!obj || obj.k !== "stream") return false;
  const t = asName(obj.m.get("Type"));
  return t === "ObjStm" || t === "XRef";
}

/** Trailer refs that must survive: /Root, /Info, /ID. */
interface TrailerRefs {
  rootNum: number;
  infoNum: number | null;
  id: PdfObj | undefined;
}

function readTrailer(
  doc: ParsedPdf,
  dropInfo: boolean,
  infoOverride?: { num: number; obj: PdfObj },
): TrailerRefs {
  const root = dget({ k: "dict", m: doc.trailer }, "Root");
  if (!root || root.k !== "ref") {
    throw new PdfError("corrupt", "trailer has no /Root");
  }
  let infoNum: number | null = null;
  if (infoOverride !== undefined) infoNum = infoOverride.num;
  else if (!dropInfo) infoNum = infoRefNum(doc);
  const id = dget({ k: "dict", m: doc.trailer }, "ID");
  return { rootNum: root.num, infoNum, id: id && id.k === "arr" ? id : undefined };
}

/** The trailer /Info object number, when the doc carries one. */
function infoRefNum(doc: ParsedPdf): number | null {
  const info = dget({ k: "dict", m: doc.trailer }, "Info");
  return info && info.k === "ref" ? info.num : null;
}

/**
 * The object table to write: every in-use entry, replacements applied,
 * deletions and structural containers removed, sorted by number.
 */
export function collectRewriteObjects(
  doc: ParsedPdf,
  opts: RewriteOptions,
): Map<number, PdfObj> {
  const out = new Map<number, PdfObj>();
  if (opts.infoOverride !== undefined) {
    out.set(opts.infoOverride.num, opts.infoOverride.obj);
  }
  for (const extra of opts.extraObjects ?? []) {
    out.set(extra.num, extra.obj);
  }
  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    if (opts.deletions?.has(num)) continue;
    const replacement = opts.replacements?.get(num);
    if (replacement !== undefined) {
      out.set(num, replacement);
      continue;
    }
    const obj = doc.getObject(num);
    if (!obj) continue; // dangling entry — keep the table honest, skip
    if (isStructuralContainer(obj)) continue; // consumed by the parse
    out.set(num, obj);
  }
  return out;
}

/** Consecutive-number runs: [start, count] pairs. */
function runsOf(nums: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === n) last[1] += 1;
    else runs.push([n, 1]);
  }
  return runs;
}

function writeTrailerDict(
  sink: Sink,
  size: number,
  trailer: TrailerRefs,
  extra?: Array<[string, PdfObj]>,
): void {
  sink.text(` /Size ${size} /Root ${trailer.rootNum} 0 R`);
  if (trailer.infoNum !== null) sink.text(` /Info ${trailer.infoNum} 0 R`);
  if (trailer.id !== undefined) {
    sink.text(" /ID ");
    sink.bytes(serializePreserve(trailer.id));
  }
  if (extra !== undefined) {
    for (const [key, value] of extra) {
      sink.text(` /${key} `);
      sink.bytes(serializePreserve(value));
    }
  }
}

/* ── classic path ───────────────────────────────────────────────── */

function writeClassic(
  doc: ParsedPdf,
  objects: Map<number, PdfObj>,
  opts: RewriteOptions,
): Uint8Array {
  const trailer = readTrailer(doc, opts.dropInfo === true, opts.infoOverride);
  const sink = new Sink();
  sink.text(`%PDF-${versionString(doc, opts.minVersion ?? "1.4")}\n`);
  sink.bytes(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const nums = [...objects.keys()].sort((a, b) => a - b);
  const offsets = new Map<number, number>();
  let done = 0;
  for (const n of nums) {
    offsets.set(n, sink.length);
    sink.text(`${n} 0 obj\n`);
    sink.bytes(serializePreserve(objects.get(n)!));
    sink.text("\nendobj\n");
    done += 1;
    opts.onProgress?.(done, nums.length);
  }

  const maxNum = nums.length > 0 ? nums[nums.length - 1]! : 0;
  const xrefPos = sink.length;
  sink.text(`xref\n`);
  for (const [start, count] of runsOf(nums)) {
    sink.text(`${start} ${count}\n`);
    for (let i = 0; i < count; i += 1) {
      const offset = offsets.get(start + i)!;
      sink.text(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }
  }
  const size = Math.max(maxNum + 1, trailer.rootNum + 1, (trailer.infoNum ?? 0) + 1);
  sink.text("trailer\n<<");
  writeTrailerDict(sink, size, trailer, opts.extraTrailer);
  sink.text(" >>\n");
  sink.text(`startxref\n${xrefPos}\n%%EOF\n`);
  return sink.toUint8Array();
}

/* ── object-stream path ─────────────────────────────────────────── */

function writeObjStm(
  doc: ParsedPdf,
  objects: Map<number, PdfObj>,
  opts: RewriteOptions,
): Uint8Array {
  const trailer = readTrailer(doc, opts.dropInfo === true, opts.infoOverride);
  const sink = new Sink();
  sink.text(`%PDF-${versionString(doc, opts.minVersion ?? "1.5")}\n`);
  sink.bytes(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const nums = [...objects.keys()].sort((a, b) => a - b);
  const maxNum = nums.length > 0 ? nums[nums.length - 1]! : 0;

  // Partition: streams stay classic; everything else is packable.
  //    P6-w-b: caller-authored extraObjects also stay classic — the
  //    security handler's /Encrypt dict must never ride an ObjStm.
  const classicNums: number[] = [];
  const packableNums: number[] = [];
  const extraNums = new Set((opts.extraObjects ?? []).map((e) => e.num));
  for (const n of nums) {
    if (objects.get(n)!.k === "stream" || extraNums.has(n)) classicNums.push(n);
    else packableNums.push(n);
  }

  // ── classic (stream) objects first — offsets recorded for type-1 rows.
  const offsets = new Map<number, number>();
  for (const n of classicNums) {
    offsets.set(n, sink.length);
    sink.text(`${n} 0 obj\n`);
    sink.bytes(serializePreserve(objects.get(n)!));
    sink.text("\nendobj\n");
  }

  // ── pack non-stream objects into ObjStm containers.
  //    Chunk by count AND serialized body size (qpdf-style).
  interface Chunk {
    nums: number[];
    bodies: Uint8Array[];
    offsets: number[]; // body offset of each object, relative to /First
    bodyLen: number;
  }
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;
  let done = 0;
  for (const n of packableNums) {
    const body = serializePreserve(objects.get(n)!);
    done += 1;
    if (
      current === null ||
      current.nums.length >= OBJSTM_MAX_OBJECTS ||
      current.bodyLen + body.length > OBJSTM_MAX_BODY
    ) {
      if (current !== null) chunks.push(current);
      current = { nums: [], bodies: [], offsets: [], bodyLen: 0 };
    }
    current.nums.push(n);
    current.offsets.push(current.bodyLen);
    current.bodies.push(body);
    current.bodyLen += body.length;
    opts.onProgress?.(classicNums.length + done, nums.length);
  }
  if (current !== null) chunks.push(current);

  // ObjStm container numbers start right after the source's max number.
  let nextNum = maxNum + 1;
  const objstmNums: number[] = [];
  const rows = new Map<number, [number, number]>(); // objNum → [objstmNum, index]
  for (const chunk of chunks) {
    const containerNum = nextNum;
    nextNum += 1;
    objstmNums.push(containerNum);
    // Pair table: object number + BYTE OFFSET of the body (spec 7.5.7 —
    // offsets are relative to the first byte of the stream's decoded data,
    // i.e. measured AFTER the /First-byte pair header).
    let header = "";
    for (let i = 0; i < chunk.nums.length; i += 1) {
      header += `${chunk.nums[i]} ${chunk.offsets[i]} `;
      rows.set(chunk.nums[i], [containerNum, i]);
    }
    const headerBytes = asciiBytes(header);
    const first = headerBytes.length;
    const body = new Uint8Array(first + chunk.bodyLen);
    body.set(headerBytes, 0);
    let at = first;
    for (const b of chunk.bodies) {
      body.set(b, at);
      at += b.length;
    }
    const compressed = zlibSync(body);
    offsets.set(containerNum, sink.length);
    sink.text(`${containerNum} 0 obj\n`);
    sink.text(
      `<< /Type /ObjStm /N ${chunk.nums.length} /First ${first} ` +
        `/Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    );
    sink.bytes(compressed);
    sink.text("\nendstream\nendobj\n");
  }

  // ── XRef stream (the last object).
  const xrefNum = nextNum;
  const allListed = [...nums, ...objstmNums, xrefNum].sort((a, b) => a - b);
  const size = allListed[allListed.length - 1]! + 1;

  const row = (objNum: number): Uint8Array => {
    const packed = rows.get(objNum);
    const out = new Uint8Array(7);
    if (packed !== undefined) {
      out[0] = 2;
      out[1] = (packed[0] >>> 24) & 0xff;
      out[2] = (packed[0] >>> 16) & 0xff;
      out[3] = (packed[0] >>> 8) & 0xff;
      out[4] = packed[0] & 0xff;
      out[5] = (packed[1] >>> 8) & 0xff;
      out[6] = packed[1] & 0xff;
    } else {
      const offset = offsets.get(objNum);
      if (offset === undefined) {
        throw new PdfError("corrupt", `xref row built for unwritten object ${objNum}`);
      }
      if (offset > 0xffffffff) {
        throw new PdfError("unsupported", "output exceeds the 4 GB xref field");
      }
      out[0] = 1;
      out[1] = (offset >>> 24) & 0xff;
      out[2] = (offset >>> 16) & 0xff;
      out[3] = (offset >>> 8) & 0xff;
      out[4] = offset & 0xff;
      out[5] = 0;
      out[6] = 0;
    }
    return out;
  };

  let index = "";
  for (const [start, count] of runsOf(allListed)) index += `${start} ${count} `;

  // The stream's own offset is known NOW (every earlier object is written;
  // rows must be built AFTER this so the xref row carries it).
  const xrefPos = sink.length;
  offsets.set(xrefNum, xrefPos);

  const xrefBody: Uint8Array[] = [];
  for (const n of allListed) xrefBody.push(row(n));
  let bodyLen = 0;
  for (const r of xrefBody) bodyLen += r.length;
  const body = new Uint8Array(bodyLen);
  let bodyAt = 0;
  for (const r of xrefBody) {
    body.set(r, bodyAt);
    bodyAt += r.length;
  }
  const compressed = zlibSync(body);

  sink.text(`${xrefNum} 0 obj\n`);
  sink.text(`<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index.trim()}] `);
  sink.text(`/Root ${trailer.rootNum} 0 R`);
  if (trailer.infoNum !== null) sink.text(` /Info ${trailer.infoNum} 0 R`);
  if (trailer.id !== undefined) {
    sink.text(" /ID ");
    sink.bytes(serializePreserve(trailer.id));
  }
  if (opts.extraTrailer !== undefined) {
    for (const [key, value] of opts.extraTrailer) {
      sink.text(` /${key} `);
      sink.bytes(serializePreserve(value));
    }
  }
  sink.text(` /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  sink.bytes(compressed);
  sink.text("\nendstream\nendobj\n");
  sink.text(`startxref\n${xrefPos}\n%%EOF\n`);
  return sink.toUint8Array();
}

/**
 * Whole-document rewrite preserving object numbers. Every in-use object
 * of the parsed source is written (replacements swapped in, deletions
 * omitted, source ObjStm/XRef containers consumed); refs stay valid
 * without remapping. `objectStreams` selects the PDF 1.5 compressed form.
 */
export function rewriteDocument(
  doc: ParsedPdf,
  opts: RewriteOptions = {},
): Uint8Array {
  const objects = collectRewriteObjects(doc, opts);
  if (opts.objectStreams === true) return writeObjStm(doc, objects, opts);
  return writeClassic(doc, objects, opts);
}

/** Resolve a trailer-level ref value to a direct object (null-safe). */
export function resolveTrailerRef(
  doc: ParsedPdf,
  value: PdfObj | undefined,
): PdfObj | undefined {
  if (!value) return undefined;
  if (value.k === "ref") return doc.getObject(value.num);
  return value;
}

/** Convenience: the catalog dict (mutable — callers may edit in place). */
export function catalogDict(doc: ParsedPdf): Map<string, PdfObj> | null {
  const root = resolveTrailerRef(doc, dget({ k: "dict", m: doc.trailer }, "Root"));
  if (!root || (root.k !== "dict" && root.k !== "stream")) return null;
  return root.m;
}

/** Array-object helper for annots-style traversal (null when absent). */
export function arrItems(o: PdfObj | undefined): PdfObj[] | null {
  return o && o.k === "arr" ? o.items : null;
}