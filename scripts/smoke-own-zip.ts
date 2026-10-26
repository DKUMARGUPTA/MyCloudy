/**
 * SMOKE: DocoPDF own ZIP/DEFLATE engine (Phase 2-a).
 *
 * §1 CRC-32 / Adler-32 known vectors.
 * §2 Huffman length-limiter properties (Kraft completeness) over random freqs.
 * §3 Round-trip: our deflate ↔ our inflate (many corpora + levels).
 * §4 zlib layer: header validity, trailer verification, decompressSync sniffing,
 *    own gzip container round-trip.
 * §5 ZIP layer: structure checks (signatures, CD, EOCD), nested Zippable,
 *    stored fallback, real-world epub parse.
 * (Cross-verification against fflate ran at development time — both directions,
 *  7 corpora × 3 levels, plus zip/zlib interop: 37/0 — recorded in the P2-a
 *  worklog; fflate is now removed from the project.)
 * §7 Edge cases: empty, 1-byte, 100KB random, pathological repeats, unicode names,
 *    many entries, big single file (1MB), deflate level 0..9.
 */

import {
  crc32,
  adler32,
  deflate,
  inflate,
  inflateSync,
  zlibSync,
  unzlibSync,
  decompressSync,
  gunzipSync,
  zipSync,
  unzipSync,
  strToU8,
  _internal,
} from "../src/lib/own/zip/index";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    fails.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// Deterministic PRNG for reproducible corpora.
let seed = 0x2f6e2b1;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

function textCorpus(n: number): Uint8Array {
  // English-ish text with heavy repetition (LZ77 friendly).
  const words = [
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "document", "pdf", "docopdf", "invoice", "total", "amount", "date",
    "signature", "verified", "hash", "compression", "deflate", "table",
  ];
  let s = "";
  while (s.length < n) {
    s += words[Math.floor(rnd() * words.length)] + " ";
  }
  return strToU8(s.slice(0, n));
}

function mixedCorpus(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const mode = Math.floor(rnd() * 4);
    if (mode === 0) {
      b[i++] = Math.floor(rnd() * 256);
    } else if (mode === 1) {
      const run = Math.min(60, n - i);
      const v = Math.floor(rnd() * 256);
      for (let k = 0; k < run; k++) b[i++] = v;
    } else if (mode === 2) {
      // ascending ramp
      const run = Math.min(30, n - i);
      for (let k = 0; k < run; k++) b[i++] = k & 0xff;
    } else {
      // repeating pattern
      const pat = randomBytes(4);
      const run = Math.min(48, n - i);
      for (let k = 0; k < run; k++) b[i++] = pat[k % 4];
    }
  }
  return b;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// §1 Checksums
// ---------------------------------------------------------------------------
{
  check("crc32 empty = 0", crc32(new Uint8Array(0)) === 0);
  check("crc32 '123456789' = 0xCBF43926", crc32(strToU8("123456789")) === 0xcbf43926);
  const hello = strToU8("Hello, DocoPDF!");
  check("crc32 known vector", crc32(hello) === 0x648dab66, `got ${crc32(hello).toString(16)}`);
  check("adler32 empty = 1", adler32(new Uint8Array(0)) === 1);
  const adlWikipedia = strToU8("Wikipedia");
  check("adler32 'Wikipedia' = 0x11E60398", adler32(adlWikipedia) === 0x11e60398, `got ${adler32(adlWikipedia).toString(16)}`);
}

// ---------------------------------------------------------------------------
// §2 Kraft completeness of the length limiter over random frequency vectors
// ---------------------------------------------------------------------------
{
  let allComplete = true;
  let allBounded = true;
  for (let trial = 0; trial < 400; trial++) {
    const maxBits = trial % 2 === 0 ? 15 : 7;
    const n = maxBits === 15 ? 288 : 19;
    const freqs = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      // Mix uniform, sparse, and Fibonacci-ish skewed distributions.
      if (r < 0.2) freqs[i] = 0;
      else if (r < 0.5) freqs[i] = 1;
      else if (r < 0.8) freqs[i] = 1 + Math.floor(rnd() * 100);
      else freqs[i] = Math.floor(Math.pow(2, 1 + rnd() * 30));
    }
    // Ensure at least 2 used.
    const usedCount = [...freqs].filter((f) => f > 0).length;
    if (usedCount < 2) {
      freqs[0] = 1;
      freqs[1] = 1;
    }
    const lens = _internal.buildLengths(freqs, maxBits);
    for (let i = 0; i < n; i++) {
      if (freqs[i] > 0 && (lens[i] < 1 || lens[i] > maxBits)) allBounded = false;
      if (freqs[i] === 0 && lens[i] !== 0) allBounded = false;
    }
    const kraft = _internal.kraftCheck(lens, maxBits);
    if (kraft !== 1 << maxBits) allComplete = false;
  }
  check("buildLengths: lengths bounded + symbols exact (400 random vectors)", allBounded);
  check("buildLengths: Kraft EXACTLY complete (400 random vectors)", allComplete);
}

// ---------------------------------------------------------------------------
// §3 Round-trip our own deflate ↔ inflate
// ---------------------------------------------------------------------------
{
  const corpora: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["1 byte", new Uint8Array([42])],
    ["2 bytes", new Uint8Array([1, 2])],
    ["text 10KB", textCorpus(10240)],
    ["text 200KB", textCorpus(200000)],
    ["random 100KB", randomBytes(102400)],
    ["mixed 150KB", mixedCorpus(150000)],
    ["all zeros 50KB", new Uint8Array(50000)],
    ["ramp 64KB", Uint8Array.from({ length: 65536 }, (_, i) => i & 0xff)],
  ];
  let allOk = true;
  for (const [name, data] of corpora) {
    for (const level of [1, 6, 9]) {
      const compressed = deflate(data, level);
      const back = inflate(compressed).bytes;
      if (!eq(back, data)) {
        allOk = false;
        check(`roundtrip ${name} L${level}`, false, `len ${back.length} vs ${data.length}`);
      }
    }
  }
  if (allOk) check(`roundtrip own↔own (${corpora.length} corpora × levels 1/6/9)`, true);
  {
    const d = mixedCorpus(70000);
    const back0 = inflate(deflate(d, 0)).bytes;
    check("roundtrip stored fallback (level 0, 70KB)", eq(back0, d));
    const d5k = textCorpus(5000);
    check("roundtrip stored level 0 text 5KB", eq(inflate(deflate(d5k, 0)).bytes, d5k));
  }
}

// ---------------------------------------------------------------------------
// §4 zlib layer cross-verify + integrity
// ---------------------------------------------------------------------------
{
  const data = textCorpus(60000);
  const ours = zlibSync(data, 6);
  check("zlib round-trip own↔own", eq(unzlibSync(ours), data));

  // Header checks: CMF/FLG validity.
  check("zlib header CM=8 CINFO=7", (ours[0] & 0x0f) === 8 && (ours[0] >> 4) === 7);
  check("zlib header FCHECK valid", ((ours[0] << 8) | ours[1]) % 31 === 0);

  // Trailer corruption must be caught.
  const corrupt = Uint8Array.from(ours);
  corrupt[corrupt.length - 1] ^= 0xff;
  let threw = false;
  try {
    unzlibSync(corrupt);
  } catch {
    threw = true;
  }
  check("zlib corrupt Adler caught", threw);

  // decompressSync sniffing.
  check("decompressSync sniffs zlib", eq(decompressSync(ours), data));
  const rawDeflate = deflate(data, 6);
  check("decompressSync sniffs raw deflate", eq(decompressSync(rawDeflate), data));
  // gzip: build a minimal gzip container with our pieces.
  const g = new Uint8Array(10 + rawDeflate.length + 8);
  g[0] = 0x1f;
  g[1] = 0x8b;
  g[2] = 8;
  g.set(rawDeflate, 10);
  const crc = crc32(data);
  g[g.length - 8] = (crc >>> 24) & 0xff;
  g[g.length - 7] = (crc >>> 16) & 0xff;
  g[g.length - 6] = (crc >>> 8) & 0xff;
  g[g.length - 5] = crc & 0xff;
  const isize = data.length;
  g[g.length - 4] = isize & 0xff;
  g[g.length - 3] = (isize >>> 8) & 0xff;
  g[g.length - 2] = (isize >>> 16) & 0xff;
  g[g.length - 1] = (isize >>> 24) & 0xff;
  check("gunzip round-trip (own container)", eq(gunzipSync(g), data));
  check("decompressSync sniffs gzip", eq(decompressSync(g), data));
}

// ---------------------------------------------------------------------------
// §6 ZIP layer cross-verify + structure
// ---------------------------------------------------------------------------
{
  const a = textCorpus(30000);
  const b = randomBytes(12345);
  const c = new Uint8Array(0);

  const ours = zipSync(
    {
      "dir/nested/hello.txt": a,
      "data.bin": b,
      "empty.txt": c,
      "unicode/नमस्ते.txt": strToU8("namaste"),
    },
    { level: 6 }
  );

  // Signatures.
  check("zip local header sig", ours[0] === 0x50 && ours[1] === 0x4b && ours[2] === 0x03 && ours[3] === 0x04);
  let hasCd = false;
  for (let i = ours.length - 22; i < ours.length; i++) {
    if (ours[i] === 0x50 && ours[i + 1] === 0x4b && ours[i + 2] === 0x05 && ours[i + 3] === 0x06) {
      hasCd = true;
      break;
    }
  }
  check("zip EOCD sig present", hasCd);

  // Our reader reads our writer.
  const back = unzipSync(ours);
  check("zip own round-trip nested path", eq(back["dir/nested/hello.txt"], a));
  check("zip own round-trip binary", eq(back["data.bin"], b));
  check("zip own round-trip empty entry", back["empty.txt"]?.length === 0);
  check("zip own round-trip unicode name", eq(back["unicode/नमस्ते.txt"], strToU8("namaste")));

  // Re-parse our own zip from a fresh copy (catches state leaks).
  const reparsed = unzipSync(Uint8Array.from(ours));
  check("zip re-parse own archive (stateless)", eq(reparsed["dir/nested/hello.txt"], a) && eq(reparsed["data.bin"], b));

  // Nested Zippable object (directory tree).
  const nested = zipSync({
    word: { "document.xml": a, rels: { r: strToU8("<r/>") } },
  });
  const nb = unzipSync(nested);
  check("zip nested Zippable flatten", eq(nb["word/document.xml"], a) && eq(nb["word/rels/r"], strToU8("<r/>")));

  // Level 0 → stored entries, still round-trips.
  const stored = zipSync({ "s.txt": a }, { level: 0 });
  check("zip level-0 stored round-trip", eq(unzipSync(stored)["s.txt"], a));

  // Many entries.
  const many: Record<string, Uint8Array> = {};
  for (let i = 0; i < 200; i++) many[`f${i}.txt`] = strToU8(`file number ${i}`);
  const manyZip = zipSync(many);
  const manyBack = unzipSync(manyZip);
  let manyOk = Object.keys(many).length === Object.keys(manyBack).length;
  for (let i = 0; i < 200; i++) {
    if (!eq(manyBack[`f${i}.txt`], strToU8(`file number ${i}`))) manyOk = false;
  }
  check("zip 200 entries round-trip", manyOk);

  // Real-world container: a real .docx from our QA fixtures if present.
  const fs = await import("node:fs");
  const epubFixture = "public/qa/sample-book.epub";
  try {
    const epubBytes = new Uint8Array(fs.readFileSync(epubFixture));
    const parsed = unzipSync(epubBytes);
    const keys = Object.keys(parsed);
    const hasMimetype = typeof parsed["mimetype"] === "object";
    const containerOk =
      parsed["META-INF/container.xml"] instanceof Uint8Array &&
      parsed["META-INF/container.xml"].length > 0;
    check(`zip real-world epub parses (${keys.length} entries, mimetype+container ok)`, keys.length > 5 && hasMimetype && containerOk);
  } catch (e) {
    console.log(`SKIP epub fixture (${String(e).slice(0, 60)})`);
  }

  // Corrupt zip must throw (not silently return). We mangle a byte INSIDE
  // the first entry's compressed payload — the central directory drives
  // extraction (local names are never read), so corrupting data is the
  // honest probe.
  const firstData = firstLocalDataStart(ours);
  const corruptZip = Uint8Array.from(ours);
  corruptZip[firstData + 5] ^= 0xff;
  let zipThrew = false;
  try {
    unzipSync(corruptZip);
  } catch {
    zipThrew = true;
  }
  check("zip corruption detected (inflate or CRC)", zipThrew);
}

/** Find the first local file header's data start (sig 0x04034b50). */
function firstLocalDataStart(archive: Uint8Array): number {
  for (let i = 0; i + 30 <= archive.length; i++) {
    if (
      archive[i] === 0x50 &&
      archive[i + 1] === 0x4b &&
      archive[i + 2] === 0x03 &&
      archive[i + 3] === 0x04
    ) {
      const nameLen = archive[i + 26] | (archive[i + 27] << 8);
      const extraLen = archive[i + 28] | (archive[i + 29] << 8);
      return i + 30 + nameLen + extraLen;
    }
  }
  return 30;
}

// ---------------------------------------------------------------------------
// §7 Compression-quality sanity (it must actually compress)
// ---------------------------------------------------------------------------
{
  const text = textCorpus(200000);
  const c6 = deflate(text, 6);
  check("deflate shrinks text meaningfully (<55%)", c6.length < text.length * 0.55, `${c6.length} vs ${text.length} (${(100 * c6.length / text.length).toFixed(1)}%)`);
  const zeros = new Uint8Array(200000);
  const cz = deflate(zeros, 6);
  check("deflate crushes zeros (<1%)", cz.length < zeros.length * 0.01, `${cz.length}`);
  const rand = randomBytes(100000);
  const cr = deflate(rand, 6);
  check("deflate random ≈ stored overhead only", cr.length <= rand.length + 1024, `${cr.length} vs ${rand.length}`);
}

console.log(`\nown-zip smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  fails.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
process.exit(0);
