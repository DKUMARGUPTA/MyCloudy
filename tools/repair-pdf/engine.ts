/**
 * Repair PDF — pure salvage engine (PRD §7.5, registry: "Rebuild broken
 * cross-reference tables; report recovered pages").
 *
 * A broken-xref PDF still contains its objects as raw bytes — the scan
 * below recovers them and rebuilds a fresh cross-reference table:
 *
 *   1. Raw object scan   — every "N G obj … endobj" region is recovered
 *      byte-exact. Stream objects use /Length when it validates, else a
 *      guarded "endstream" search (must be followed by "endobj" shortly).
 *   2. Object streams    — modern PDFs compress objects inside ObjStm
 *      streams; they are inflated (native DecompressionStream) and each
 *      inner object is materialised as a plain top-level object.
 *   3. Page-tree repair  — /Kids referencing dropped objects are pruned
 *      and /Count recomputed from the surviving tree.
 *   4. Rebuild           — header + objects + a fresh xref table +
 *      trailer, then the result must load in pdf-lib (or the run fails
 *      honestly).
 *
 * Pure and dependency-free (pdf-lib only for final validation) — the
 * surface previews the same outcome the worker will write.
 */

export interface SalvageNote {
  /** Machine key — the UI localizes, the text report maps to English. */
  key: string;
  params?: Record<string, number | string>;
}

export interface SalvageStats {
  originalBytes: number;
  objectsKept: number;
  /** Candidates found in the scan but unusable (truncated / unparsable). */
  objectsDropped: number;
  objectStreamsRecovered: number;
  /** Objects materialised out of ObjStm streams. */
  objectsFromStreams: number;
  /** Pages reachable from the repaired page tree. */
  pagesRecovered: number;
  kidsPruned: number;
  notes: SalvageNote[];
}

export interface SalvageResult {
  status: "rebuilt" | "healthy";
  bytes: Uint8Array;
  stats: SalvageStats;
}

/* ------------------------------------------------------------- byte utils */

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

/** Find "keyword" as a PDF token (not inside a longer word). */
function findToken(text: string, keyword: string, from: number): number {
  let search = from;
  for (;;) {
    const idx = text.indexOf(keyword, search);
    if (idx < 0) return -1;
    const before = idx > 0 ? text[idx - 1] : " ";
    const after = text[idx + keyword.length] ?? " ";
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
      return idx;
    }
    search = idx + keyword.length;
  }
}

/* --------------------------------------------------------- object scanning */

interface ScannedObject {
  num: number;
  gen: number;
  /** Raw body between the "obj" keyword and "endobj" (exclusive both). */
  body: Uint8Array;
  hasStream: boolean;
}

interface ScanOutcome {
  objects: ScannedObject[];
  /** Unusable candidates (truncated / corrupt), counted honestly. */
  dropped: number;
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;
const STREAM_RE = /\bstream\r?\n?/;
const ENDSTREAM = "endstream";

/** First "endstream" followed by "endobj" within `slack` bytes. */
function findStreamEnd(text: string, from: number): number {
  let search = from;
  for (;;) {
    const idx = text.indexOf(ENDSTREAM, search);
    if (idx < 0) return -1;
    const tail = text.slice(idx + ENDSTREAM.length, idx + ENDSTREAM.length + 64);
    if (/^\s*endobj\b/.test(tail)) return idx;
    search = idx + ENDSTREAM.length;
  }
}

function scanObjects(text: string, bytes: Uint8Array): ScanOutcome {
  const objects: ScannedObject[] = [];
  let dropped = 0;
  OBJ_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OBJ_RE.exec(text)) !== null) {
    const num = Number(match[1]);
    const gen = Number(match[2]);
    const bodyStart = match.index + match[0].length;

    // Stream bodies may contain "endobj" bytes — extend hop by hop until
    // the body ends "… endstream" right before the real endobj (≤ 16 hops).
    // Plain dict bodies never hop: their FIRST endobj is the correct one.
    let endobj = findToken(text, "endobj", bodyStart);
    let hops = 0;
    while (endobj >= 0 && hops < 16) {
      const candidate = text.slice(bodyStart, endobj);
      const looksLikeStream = /\bstream\r?\n?/.test(candidate.slice(0, 2048));
      if (!looksLikeStream || bodyEndsCleanly(candidate)) break;
      endobj = findToken(text, "endobj", endobj + 6);
      hops += 1;
    }

    if (endobj < 0) {
      // Truncated tail — keep the object only with a complete stream.
      const endstream = findStreamEnd(text, bodyStart);
      if (endstream < 0) {
        dropped += 1;
        continue;
      }
      objects.push({
        num,
        gen,
        body: bytes.subarray(bodyStart, endstream),
        hasStream: true,
      });
      continue;
    }
    objects.push({
      num,
      gen,
      body: bytes.subarray(bodyStart, endobj),
      hasStream: /\bstream\r?\n?/.test(text.slice(bodyStart, bodyStart + 2048)),
    });
  }
  return { objects, dropped };
}

/** A stream body must end with the endstream token (trailing ws aside). */
function bodyEndsCleanly(bodyText: string): boolean {
  return bodyText.trimEnd().endsWith(ENDSTREAM);
}

/* ------------------------------------------------------- object streams */

function dictTextOf(obj: ScannedObject): string {
  const text = latin1(obj.body);
  const start = text.indexOf("<<");
  if (start < 0) return text;
  // Stream objects: dict is everything before the stream keyword.
  const streamMatch = STREAM_RE.exec(text);
  const end =
    streamMatch !== null && streamMatch.index > start
      ? streamMatch.index
      : text.indexOf(">>", start) + 2;
  return text.slice(start, end);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Response(
      new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(
        new DecompressionStream("deflate")
      )
    );
    const buf = await stream.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

interface InnerObject {
  num: number;
  body: Uint8Array;
}

async function recoverObjStm(
  obj: ScannedObject
): Promise<InnerObject[] | null> {
  const dict = dictTextOf(obj);
  if (!/\/Type\s*\/ObjStm\b/.test(dict)) return null;
  const nMatch = /\/N\s+(\d+)/.exec(dict);
  const firstMatch = /\/First\s+(\d+)/.exec(dict);
  if (nMatch === null || firstMatch === null) return null;
  const n = Number(nMatch[1]);
  const first = Number(firstMatch[1]);
  if (n <= 0 || n > 4096 || first <= 0) return null;

  const bodyText = latin1(obj.body);
  const streamMatch = STREAM_RE.exec(bodyText);
  if (streamMatch === null) return null;
  const streamStart = streamMatch.index + streamMatch[0].length;
  // Prefer the declared /Length when it lands on a clean endstream.
  let endIdx = -1;
  const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
  if (lengthMatch !== null) {
    const guess = streamStart + Number(lengthMatch[1]);
    if (guess <= obj.body.length && /^\s*endstream/.test(bodyText.slice(guess, guess + 32))) {
      endIdx = guess;
    }
  }
  if (endIdx < 0) {
    endIdx = findStreamEnd(bodyText, streamStart);
  }
  if (endIdx < streamStart) return null;
  const streamBytes = obj.body.subarray(streamStart, endIdx);

  // Skip non-Flate ObjStm (rare) — repair should not guess.
  const filterMatch = /\/Filter\s*(?:\/([\w#]+)|\[([^\]]*)\])/.exec(dict);
  const filter =
    filterMatch?.[1] ??
    filterMatch?.[2]?.replace(/[\/\[\]\s]/g, "") ??
    null;
  if (filter !== null && !/^FlateDecode$/.test(filter)) return null;

  const inflated = await inflate(streamBytes);
  if (inflated === null) return null;
  const inner = latin1(inflated);
  const numbers = inner.slice(0, first).trim().split(/\s+/).map(Number);
  if (numbers.length !== n * 2 || numbers.some((v) => !Number.isFinite(v))) {
    return null;
  }
  const out: InnerObject[] = [];
  for (let i = 0; i < n; i += 1) {
    const num = numbers[i * 2];
    // Generation is always 0 inside object streams (PDF 32000-1 §7.3.8.2).
    const offset = numbers[i * 2 + 1];
    if (num <= 0 || offset < first) continue;
    const end = i + 1 < n ? numbers[(i + 1) * 2 + 1] : inner.length;
    if (end < offset) continue;
    out.push({ num, body: inflated.subarray(offset, end) });
  }
  return out;
}

/* ------------------------------------------------------ page-tree repair */

interface ObjectEntry {
  num: number;
  gen: number;
  body: Uint8Array;
  bodyText: string;
  dictText: string;
}

const REF_RE = /(\d+)\s+(\d+)\s+R\b/g;

function extractRefs(segment: string): { num: number; gen: number }[] {
  const refs: { num: number; gen: number }[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(segment)) !== null) {
    refs.push({ num: Number(m[1]), gen: Number(m[2]) });
  }
  return refs;
}

/**
 * Prune /Kids of every /Pages node to objects that survive, recompute
 * /Count from the tree, and return the number of pruned kid refs.
 */
function repairPageTree(
  objects: Map<number, ObjectEntry>
): { kidsPruned: number } {
  const pagesNodes: ObjectEntry[] = [];
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Pages\b/.test(obj.dictText)) pagesNodes.push(obj);
  }
  if (pagesNodes.length === 0) return { kidsPruned: 0 };

  let kidsPruned = 0;
  for (const node of pagesNodes) {
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(node.dictText);
    if (kidsMatch === null) continue;
    const refs = extractRefs(kidsMatch[1]);
    const kept = refs.filter((ref) => objects.has(ref.num));
    kidsPruned += refs.length - kept.length;

    // Recompute the leaf count from surviving descendants.
    const count = countLeaves(node.num, objects, new Set());

    let text = node.bodyText;
    const kidsValue = kept.map((r) => `${r.num} ${r.gen} R`).join(" ");
    text = text.replace(/\/Kids\s*\[[^\]]*\]/, `/Kids [${kidsValue}]`);
    const countMatch = /\/Count\s+\d+/.exec(text);
    if (countMatch !== null) {
      text = text.replace(/\/Count\s+\d+/, `/Count ${count}`);
    } else {
      text = text.replace(
        /\/Kids\s*\[[^\]]*\]/,
        `/Count ${count}\n/Kids [${kidsValue}]`
      );
    }
    node.body = toBytes(text);
    node.bodyText = text;
    node.dictText = dictTextOfRaw(node);
  }
  return { kidsPruned };
}

function countLeaves(
  nodeNum: number,
  objects: Map<number, ObjectEntry>,
  visited: Set<number>
): number {
  if (visited.has(nodeNum)) return 0;
  visited.add(nodeNum);
  const node = objects.get(nodeNum);
  if (node === undefined) return 0;
  const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(node.dictText);
  if (kidsMatch === null) return 1;
  let total = 0;
  for (const ref of extractRefs(kidsMatch[1])) {
    if (/\/Type\s*\/Pages\b/.test(objects.get(ref.num)?.dictText ?? "")) {
      total += countLeaves(ref.num, objects, visited);
    } else {
      total += 1;
    }
  }
  return total === 0 ? 1 : total;
}

/* -------------------------------------------------------------- rebuild */

function findHeader(text: string): string {
  const m = /%PDF-\d\.\d/.exec(text.slice(0, 1024));
  return m !== null ? m[0] : "%PDF-1.7";
}

function rebuild(
  header: string,
  objects: Map<number, ObjectEntry>,
  rootNum: number
): Uint8Array {
  const nums = [...objects.keys()].sort((a, b) => a - b);
  const maxNum = nums.length > 0 ? nums[nums.length - 1] : 0;
  const size = maxNum + 1;

  const chunks: string[] = [header, "\n"];
  const offsets = new Map<number, number>();
  let pos = header.length + 1;
  for (const num of nums) {
    const obj = objects.get(num)!;
    offsets.set(num, pos);
    const body = obj.bodyText;
    const piece = `${num} ${obj.gen} obj\n${body}\nendobj\n`;
    chunks.push(piece);
    pos += piece.length;
  }

  const xrefPos = pos;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxNum; num += 1) {
    const off = offsets.get(num);
    xref +=
      off === undefined
        ? "0000000000 00000 f \n"
        : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(
    `trailer\n<< /Size ${size} /Root ${rootNum} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  );
  return toBytes(chunks.join(""));
}

/* ------------------------------------------------------------ public API */

/**
 * Is the cross-reference machinery readable (startxref → xref / xref
 * stream, classic-table entries actually pointing at their objects)?
 * This is the honest line between "healthy" and "needs a rebuild" — a
 * file whose table is intact is healthy even before pdf-lib agrees.
 *
 * Bytes-level convenience for other tools: web-optimize-pdf uses this as
 * a pre-flight refusal — qpdf's recovery can enter unbounded warning
 * loops on broken-xref inputs (observed: 2 GB OOM), so damaged files
 * must be repaired first instead (the honest path either way).
 */
export function xrefIntactBytes(bytes: Uint8Array): boolean {
  return structureIntact(latin1(bytes));
}

function structureIntact(text: string): boolean {
  const sx = text.lastIndexOf("startxref");
  if (sx < 0) return false;
  const m = /startxref\s+(\d+)/.exec(text.slice(sx));
  if (m === null) return false;
  const off = Number(m[1]);
  if (!(off >= 0) || off >= text.length) return false;
  const at = text.slice(off, off + 32);
  if (/^xref\b/.test(at)) {
    // Classic table: every in-use entry must point at "N G obj".
    return classicXrefValid(text, off);
  }
  // Xref stream object ("N 0 obj") or bust.
  return /^\d+\s+\d+\s+obj\b/.test(at);
}

function classicXrefValid(text: string, xrefAt: number): boolean {
  const head = /xref\s+(\d+)\s+(\d+)\s*/.exec(text.slice(xrefAt, xrefAt + 64));
  if (head === null) return false;
  let pos = xrefAt + head[0].length;
  const count = Number(head[2]);
  if (count > 1_000_000) return false;
  for (let i = 0; i < count; i += 1) {
    const entry = text.slice(pos, pos + 20);
    if (!/^\d{10}\s\d{5}\s([nf])/.test(entry)) return false;
    if (entry[17] === "n") {
      const off = Number(entry.slice(0, 10));
      const target = text.slice(off, off + 32);
      if (!/^\d+\s+\d+\s+obj\b/.test(target)) return false;
    }
    pos += 20;
  }
  return true;
}

/**
 * Full salvage pipeline (surface preview + worker run use this):
 *
 *   1. encrypted → honest refusal,
 *   2. primary: parse with pdf-lib's own recovery and re-serialize a
 *      CLEAN file (fresh xref, normalized objects),
 *   3. fallback: the raw deep-scan rebuild (rawSalvage) for damage that
 *      defeats pdf-lib's parser.
 *
 * The result must load — or the run fails honestly.
 */
export async function salvagePdf(bytes: Uint8Array): Promise<SalvageResult> {
  const text = latin1(bytes);
  const notes: SalvageNote[] = [];

  // Encrypted files cannot be rebuilt honestly — refuse.
  const trailerRegion = text.slice(Math.max(0, text.length - 8192));
  if (
    /\/Encrypt\b/.test(trailerRegion) ||
    /\/Encrypt\b/.test(text.slice(0, 4096))
  ) {
    throw new Error("repair.errorEncrypted");
  }

  const intact = structureIntact(text);
  const stats: SalvageStats = {
    originalBytes: bytes.length,
    objectsKept: 0,
    objectsDropped: 0,
    objectStreamsRecovered: 0,
    objectsFromStreams: 0,
    pagesRecovered: 0,
    kidsPruned: 0,
    notes,
  };

  const { PDFDocument } = await import("@cantoo/pdf-lib");

  /* ---------- primary: pdf-lib parse + clean re-serialize ---------- */
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const pages = doc.getPageCount();
    if (pages > 0) {
      const out = await doc.save({ useObjectStreams: false });
      // The rewrite must load on its own.
      await PDFDocument.load(out, { updateMetadata: false });
      stats.objectsKept = doc.context.enumerateIndirectObjects().length;
      stats.pagesRecovered = pages;
      if (!intact) {
        notes.push({ key: "repair.noteReparsed" });
        notes.push({ key: "repair.noteXrefRebuilt" });
      }
      return { status: intact ? "healthy" : "rebuilt", bytes: out, stats };
    }
  } catch {
    // fall through to the deep scan
  }

  /* ---------- fallback: raw deep-scan rebuild ---------- */
  return rawSalvage(text, bytes, intact);
}

/** Deep-scan rebuild — the belt-and-braces path (exported for smoke). */
export async function rawSalvage(
  text: string,
  bytes: Uint8Array,
  intactHint = false
): Promise<SalvageResult> {
  const notes: SalvageNote[] = [];
  const stats: SalvageStats = {
    originalBytes: bytes.length,
    objectsKept: 0,
    objectsDropped: 0,
    objectStreamsRecovered: 0,
    objectsFromStreams: 0,
    pagesRecovered: 0,
    kidsPruned: 0,
    notes,
  };

  const scan = scanObjects(text, bytes);
  stats.objectsDropped = scan.dropped;

  // Keep the LAST definition per number (later revisions win).
  const latest = new Map<number, ScannedObject>();
  for (const obj of scan.objects) latest.set(obj.num, obj);

  const objects = new Map<number, ObjectEntry>();
  for (const [num, obj] of latest) {
    objects.set(num, {
      num,
      gen: obj.gen,
      body: obj.body,
      bodyText: latin1(obj.body),
      dictText: "",
    });
  }
  for (const obj of objects.values()) obj.dictText = dictTextOfRaw(obj);

  // Object streams: inflate + materialise, then remove the container.
  const toRemove: number[] = [];
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dictText)) continue;
    const inner = await recoverObjStm({
      num,
      gen: obj.gen,
      body: obj.body,
      hasStream: true,
    });
    if (inner === null) {
      toRemove.push(num);
      stats.objectsDropped += 1;
      continue;
    }
    stats.objectStreamsRecovered += 1;
    for (const piece of inner) {
      objects.set(piece.num, {
        num: piece.num,
        gen: 0,
        body: piece.body,
        bodyText: latin1(piece.body),
        dictText: "",
      });
      stats.objectsFromStreams += 1;
    }
    toRemove.push(num);
  }
  for (const num of toRemove) objects.delete(num);
  // XRef streams are replaced by the fresh table — drop them.
  for (const [num, obj] of [...objects]) {
    if (/\/Type\s*\/XRef\b/.test(obj.dictText)) objects.delete(num);
  }

  stats.objectsKept = objects.size;

  // Catalog: prefer a trailer /Root, else any /Type /Catalog.
  let rootNum = -1;
  const trailerMatch = /trailer\s*<<[\s\S]{0,600}?\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
  if (trailerMatch !== null) {
    const n = Number(trailerMatch[1]);
    if (objects.has(n)) rootNum = n;
  }
  if (rootNum < 0) {
    for (const [num, obj] of objects) {
      if (/\/Type\s*\/Catalog\b/.test(obj.dictText)) {
        rootNum = num;
        break;
      }
    }
  }
  if (rootNum < 0) throw new Error("repair.errorNoCatalog");
  notes.push({ key: "repair.noteXrefRebuilt" });

  const { kidsPruned } = repairPageTree(objects);
  stats.kidsPruned = kidsPruned;
  if (kidsPruned > 0) {
    notes.push({ key: "repair.noteKidsPruned", params: { count: kidsPruned } });
  }
  if (stats.objectStreamsRecovered > 0) {
    notes.push({
      key: "repair.noteObjStm",
      params: { count: stats.objectStreamsRecovered },
    });
  }

  const header = findHeader(text);
  if (!/%PDF-\d\.\d/.test(text.slice(0, 1024))) {
    notes.push({ key: "repair.noteHeader" });
  }

  const out = rebuild(header, objects, rootNum);

  // The rebuilt file must load — otherwise the salvage failed honestly.
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  let pages = 0;
  try {
    const doc = await PDFDocument.load(out, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    pages = doc.getPageCount();
  } catch {
    throw new Error("repair.errorUnrecoverable");
  }
  if (pages === 0) throw new Error("repair.errorNoPages");
  stats.pagesRecovered = pages;

  return { status: intactHint ? "healthy" : "rebuilt", bytes: out, stats };
}

function dictTextOfRaw(obj: ObjectEntry): string {
  const text = obj.bodyText;
  const start = text.indexOf("<<");
  if (start < 0) return text;
  const streamMatch = STREAM_RE.exec(text);
  const end =
    streamMatch !== null && streamMatch.index > start
      ? streamMatch.index
      : text.indexOf(">>", start) + 2;
  return text.slice(start, end);
}

/* ------------------------------------------------------- report artifact */

const NOTE_EN: Record<string, (p: Record<string, number | string>) => string> = {
  "repair.noteXrefRebuilt": () =>
    "The cross-reference table was rebuilt from the objects found in the file.",
  "repair.noteReparsed": () =>
    "The file structure was damaged; every object that could be parsed was recovered and re-serialised cleanly.",
  "repair.noteKidsPruned": (p) =>
    `${p.count} page-tree reference(s) pointed at missing objects and were removed.`,
  "repair.noteObjStm": (p) =>
    `${p.count} compressed object stream(s) were inflated and their objects materialised.`,
  "repair.noteHeader": () =>
    "The PDF header was missing and has been reconstructed.",
};

/** Human-readable report body (English) — the worker's txt output. */
export function buildRepairReport(
  fileName: string,
  result: SalvageResult
): string {
  const s = result.stats;
  const lines: string[] = [];
  lines.push("PDF repair report");
  lines.push("=================");
  lines.push("");
  lines.push(`File: ${fileName}`);
  lines.push(`Original size: ${s.originalBytes.toLocaleString("en-US")} bytes`);
  lines.push(`Rebuilt size: ${result.bytes.length.toLocaleString("en-US")} bytes`);
  lines.push(`Objects recovered: ${s.objectsKept.toLocaleString("en-US")}`);
  if (s.objectsFromStreams > 0) {
    lines.push(
      `… from ${s.objectStreamsRecovered} compressed object stream(s): ${s.objectsFromStreams.toLocaleString("en-US")}`
    );
  }
  if (s.objectsDropped > 0) {
    lines.push(`Objects dropped as unusable: ${s.objectsDropped.toLocaleString("en-US")}`);
  }
  if (s.kidsPruned > 0) {
    lines.push(`Page-tree references pruned: ${s.kidsPruned.toLocaleString("en-US")}`);
  }
  lines.push(`Pages recovered: ${s.pagesRecovered.toLocaleString("en-US")}`);
  lines.push("");
  if (result.status === "healthy") {
    lines.push(
      "The original file was already readable — the rebuild is a clean rewrite, not a rescue."
    );
  }
  for (const note of s.notes) {
    const fmt = NOTE_EN[note.key];
    if (fmt) lines.push(`- ${fmt(note.params ?? {})}`);
  }
  lines.push("");
  lines.push("Everything above happened on your device.");
  return lines.join("\n");
}
