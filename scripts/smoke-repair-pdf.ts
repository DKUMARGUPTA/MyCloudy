/**
 * Smoke: repair-pdf (RB3-c) — the raw-byte PDF salvager, 100% on-device.
 *
 * House conventions: REAL fixtures built in-script with pdf-lib (a
 * 3-page needle PDF saved loose with a classic xref table), then
 * CORRUPTED deterministically — every cut position is derived from the
 * fixture's own bytes (the lastIndexOf("xref") trap is pinned: that
 * match lands INSIDE "startxref", so the classic table is located via
 * its real "xref\n0" header), node:zlib as the INFLATE oracle (NOT
 * fflate — the same container PDF streams use), model-level asserts
 * through the exact repairPdf the worker drives, strict reloads with
 * throwOnInvalidObject for every salvaged output, relative imports
 * without .ts, process.exit at the end.
 *
 * §12 (R4-b) adds the xref-STREAM salvage: a hand-assembled linearized
 * file whose ONLY xref is a /Type /XRef stream (/W [1 4 2] + /Index) —
 * the salvage path must exercise /Index+/W, verify every row against
 * the bytes at its offset, and equal a REFERENCE RECONSTRUCTION
 * assembled independently in this file from the known object parts;
 * stale offsets / un-inflatable rows fall back to the object scan
 * (byte-identically) and a healthy classic file carrying an xref
 * stream is never "salvaged".
 *
 * Run: bun scripts/smoke-repair-pdf.ts
 */
import { deflateSync, inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFName, PDFRawStream, PDFDict } from "pdf-lib";

import {
  outputBaseName,
  parseRun,
  repairPdf,
  RepairError,
  type RepairOptions,
} from "../tools/repair-pdf/model";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** pdf-lib emits text as literal OR <HEX> tokens — count both forms. */
function countText(stream: string, s: string): number {
  let n = 0;
  let idx = stream.indexOf(s);
  while (idx >= 0) {
    n += 1;
    idx = stream.indexOf(s, idx + s.length);
  }
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  const token = `<${hex}>`;
  idx = stream.indexOf(token);
  while (idx >= 0) {
    n += 1;
    idx = stream.indexOf(token, idx + token.length);
  }
  return n;
}

/** latin1 string -> bytes (fixture surgery happens in string space). */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

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

/** pdf-lib emits text as literal or hex tokens — the odt/wopt matcher. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

/** Inflated text of every FlateDecode stream in a LOADED doc (node:zlib). */
function flateTextOf(doc: PDFDocument): string {
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(PDFName.of("Filter"));
    if (!(filter instanceof PDFName) || filter !== PDFName.of("FlateDecode")) {
      continue;
    }
    try {
      out += inflateSync(Buffer.from(obj.contents)).toString("latin1");
      out += "\n";
    } catch {
      /* a truncated stream that cannot inflate is skipped — exactly
       * the honest-loss case fixture (e) asserts below */
    }
  }
  return out;
}

/** Strict reload (the model's own verification standard). */
async function strictLoad(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
}

const OPTIONS = (over: Partial<RepairOptions> = {}): RepairOptions => ({
  alsoRebuildValid: true,
  locale: "en",
  fileWord: "",
  ...over,
});

async function expectRepairError(
  bytes: Uint8Array,
  code: string
): Promise<void> {
  try {
    await repairPdf(bytes, OPTIONS());
    check(`error ${code}: must throw`, false, "no throw");
  } catch (error) {
    const got =
      error instanceof RepairError ? error.code : `unexpected:${String(error)}`;
    check(`honest error ${code}`, got === code, got);
  }
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** 3 pages, 2 ASCII needles per page (house rule: ASCII needles). */
async function buildValidPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Repair Fixture - page ${p}`, {
      x: 40,
      y: 780,
      size: 16,
      font,
    });
    page.drawText(`REPAIR NEEDLE ${p}`, { x: 40, y: 750, size: 11, font });
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * (a) Strip xref + trailer + startxref + %%EOF in one deterministic cut.
 * The classic table is located by its real "xref\n0" header — a naive
 * lastIndexOf("xref") lands INSIDE the trailing "startxref" keyword.
 */
function stripXrefBlock(bytes: Uint8Array): Uint8Array {
  const s = toLatin(bytes);
  const at = s.indexOf("xref\n0");
  if (at < 0) throw new Error("fixture build: no classic xref table");
  return latin1(s.slice(0, at));
}

/** (b) Email-style junk glued before the %PDF- header. */
function withGarbagePrefix(bytes: Uint8Array): Uint8Array {
  const junk =
    "Received: from mx.example.com by relay.local\r\n" +
    "Content-Type: multipart/mixed; boundary=BOUND\r\n" +
    "This MIME part carries an attached PDF document.\r\n\r\n";
  return latin1(junk + toLatin(bytes));
}

/** (c) The FIRST stream /Length is bumped out of truth by +40 (same
 *  digit count, so the fixture shifts nothing else — the damage is the
 *  length value alone). */
function bumpFirstLength(bytes: Uint8Array, delta: number): Uint8Array {
  const s = toLatin(bytes);
  const m = /\/Length[ ]+([0-9]+)/.exec(s);
  if (!m) throw new Error("fixture build: no /Length found");
  const bumped = `/Length ${Number(m[1]) + delta}`;
  const out = s.slice(0, m.index) + bumped + s.slice(m.index + m[0].length);
  return latin1(out);
}

/** (d) The file physically concatenated with a full copy of itself. */
function concatSelf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  out.set(bytes, 0);
  out.set(bytes, bytes.length);
  return out;
}

/**
 * (e) Truncated mid-file: cut `back` bytes before the LAST endstream —
 * the final object's data is cut, its endstream/xref/trailer/EOF are
 * gone with it.
 */
function truncateBeforeLastEndstream(
  bytes: Uint8Array,
  back: number
): Uint8Array {
  const s = toLatin(bytes);
  const at = s.lastIndexOf("endstream");
  if (at < 0) throw new Error("fixture build: no endstream");
  return latin1(s.slice(0, at - back));
}

/** (f) Just the %%EOF marker is stripped. */
function stripEof(bytes: Uint8Array): Uint8Array {
  const s = toLatin(bytes);
  const at = s.lastIndexOf("%%EOF");
  if (at < 0) throw new Error("fixture build: no %%EOF");
  return latin1(s.slice(0, at));
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("── 1. parseRun coercion ──────────────────────────────────");
  {
    const d = parseRun("");
    check("defaults: rebuild-valid on, en, empty file word", d.alsoRebuildValid && d.locale === "en" && d.fileWord === "", d);
    const off = parseRun(
      '{"alsoRebuildValid":false,"locale":"hi","fileWord":"  bad\\u0007 word  "}'
    );
    check("explicit false respected", off.alsoRebuildValid === false, off);
    check("locale must be exactly hi", off.locale === "hi", off.locale);
    check("fileWord sanitized (controls stripped, ws collapsed)", off.fileWord === "bad word", off.fileWord);
    const garbage = parseRun("not json at all");
    check("garbage JSON degrades to defaults", garbage.alsoRebuildValid && garbage.locale === "en", garbage);
  }

  console.log("\n── 2. outputBaseName ─────────────────────────────────────");
  {
    check("strips .pdf", outputBaseName("My Doc.PDF", "en") === "My Doc");
    check("keeps other extension text", outputBaseName("archive.tar", "en") === "archive.tar");
    check("filesystem-unsafe chars replaced", !/[\\/:*?"<>|]/.test(outputBaseName('weird<>:"/\\|?*name.pdf', "en")));
    check("nameless falls back to localized word (en)", outputBaseName(".pdf", "en") === "document");
    check("nameless falls back to localized word (hi)", outputBaseName(".pdf", "hi") === "दस्तावेज़");
    check("fileWord overrides the fallback", outputBaseName(".pdf", "en", "report") === "report");
    check("long names capped at 120", outputBaseName("x".repeat(300) + ".pdf", "en").length === 120);
  }

  console.log("\n── 3. valid file: honest unchanged / rebuild paths ────────");
  const valid = await buildValidPdf();
  {
    check("fixture: %%EOF at tail", toLatin(valid).endsWith("%%EOF"));
    const out = await repairPdf(valid, OPTIONS({ alsoRebuildValid: false }));
    check("structure reported valid", out.report.structureWasValid === true, out.report);
    check("unchanged flag set", out.report.unchanged === true);
    check("bytes returned byte-for-byte identical", Buffer.compare(Buffer.from(out.bytes), Buffer.from(valid)) === 0);
    check("no damage flags claimed", !out.report.xrefRebuilt && !out.report.headerFixed && !out.report.eofMissing && !out.report.truncationDetected && out.report.duplicatesResolved === 0 && out.report.streamLengthsFixed === 0);
    check("bytesIn/bytesOut consistent", out.report.bytesIn === valid.length && out.report.bytesOut === valid.length);

    const rebuilt = await repairPdf(valid, OPTIONS({ alsoRebuildValid: true }));
    check("rebuild path: still marked valid structure", rebuilt.report.structureWasValid === true);
    check("rebuild path: not unchanged", rebuilt.report.unchanged === false);
    const re = await strictLoad(rebuilt.bytes);
    check("rebuild path: strict reload, 3 pages", re.getPageCount() === 3 && rebuilt.report.pages === 3);
    check("rebuild path: needles survive", hasText(flateTextOf(re), "REPAIR NEEDLE 2"));
  }

  console.log("\n── 4. (a) xref + startxref + trailer stripped ────────────");
  const stripped = stripXrefBlock(valid);
  {
    const s = toLatin(stripped);
    check("cut verified: no startxref, no trailer, no xref table, no %%EOF", !s.includes("startxref") && !s.includes("trailer") && !s.includes("xref") && !s.includes("%%EOF"));
    const out = await repairPdf(stripped, OPTIONS());
    check("salvage: xref reported rebuilt", out.report.xrefRebuilt === true, out.report);
    check("salvage: eof reported missing", out.report.eofMissing === true);
    check("salvage: no header/truncation/dup/length claims", !out.report.headerFixed && !out.report.truncationDetected && out.report.duplicatesResolved === 0 && out.report.streamLengthsFixed === 0);
    check("salvage: all 10 objects recovered", out.report.objectsRecovered === 10, out.report.objectsRecovered);
    check("salvage: bytesIn is the damaged size", out.report.bytesIn === stripped.length);
    const re = await strictLoad(out.bytes);
    check("strict reload: 3 pages, report agrees", re.getPageCount() === 3 && out.report.pages === 3);
    const text = flateTextOf(re);
    check("all three page needles survive (inflated, node:zlib)", hasText(text, "REPAIR NEEDLE 1") && hasText(text, "REPAIR NEEDLE 2") && hasText(text, "REPAIR NEEDLE 3"));
    check("output carries a fresh xref + trailer + startxref + %%EOF", (() => {
      const o = toLatin(out.bytes);
      return o.includes("xref\n0 11\n") && o.includes("trailer") && o.includes("startxref") && o.trimEnd().endsWith("%%EOF");
    })());
    const again = await repairPdf(stripped, OPTIONS());
    check("deterministic: same input twice -> identical output", Buffer.compare(Buffer.from(out.bytes), Buffer.from(again.bytes)) === 0);
    // Two-stage honesty: this file has NO xref stream — none claimed.
    check(
      "two-stage honest: no xref stream in the input → none claimed",
      out.report.xrefStreamSalvaged === false && out.report.xrefStreamEntries === 0,
      { salvaged: out.report.xrefStreamSalvaged, entries: out.report.xrefStreamEntries },
    );
    // Salvage of the SALVAGED output (now valid) is the unchanged path.
    const round2 = await repairPdf(out.bytes, OPTIONS({ alsoRebuildValid: false }));
    check("salvaged output is now structure-valid (round trip)", round2.report.structureWasValid === true && round2.report.unchanged === true, round2.report);
  }

  console.log("\n── 5. (b) garbage bytes before the %PDF- header ──────────");
  const prefixed = withGarbagePrefix(valid);
  {
    const out = await repairPdf(prefixed, OPTIONS());
    check("header reported re-anchored", out.report.headerFixed === true, out.report);
    check("xref also rebuilt (offsets shifted by the prefix)", out.report.xrefRebuilt === true);
    const re = await strictLoad(out.bytes);
    check("strict reload: 3 pages", re.getPageCount() === 3 && out.report.pages === 3);
    check("needle survives under the junk", hasText(flateTextOf(re), "REPAIR NEEDLE 1"));
    check("rebuilt output starts with %PDF- at offset 0", toLatin(out.bytes).startsWith("%PDF-"));
  }

  console.log("\n── 6. (c) wrong /Length on a stream ───────────────────────");
  const badLength = bumpFirstLength(valid, 40);
  {
    const out = await repairPdf(badLength, OPTIONS());
    check("stream length fixed: exactly 1", out.report.streamLengthsFixed === 1, out.report.streamLengthsFixed);
    check("xref itself was fine (honest: not claimed)", out.report.xrefRebuilt === false);
    const re = await strictLoad(out.bytes);
    check("strict reload: 3 pages", re.getPageCount() === 3 && out.report.pages === 3);
    const text = flateTextOf(re);
    check("the stream whose length was wrong still inflates with its needle", hasText(text, "REPAIR NEEDLE 1"));
    check("untouched streams keep their needles", hasText(text, "REPAIR NEEDLE 3"));
  }

  console.log("\n── 7. (d) duplicate objects (file concatenated with itself)");
  const doubled = concatSelf(valid);
  {
    const out = await repairPdf(doubled, OPTIONS());
    check("all 10 object numbers reported duplicated", out.report.duplicatesResolved === 10, out.report.duplicatesResolved);
    check("last-wins keeps exactly 10 objects", out.report.objectsRecovered === 10, out.report.objectsRecovered);
    const re = await strictLoad(out.bytes);
    check("strict reload: 3 pages, report agrees", re.getPageCount() === 3 && out.report.pages === 3);
    const text = flateTextOf(re);
    check("needles survive exactly once per page", (() => {
      const one = countText(text, "REPAIR NEEDLE 1");
      const two = countText(text, "REPAIR NEEDLE 2");
      const three = countText(text, "REPAIR NEEDLE 3");
      return one === 1 && two === 1 && three === 1;
    })(), {
      one: countText(text, "REPAIR NEEDLE 1"),
      two: countText(text, "REPAIR NEEDLE 2"),
      three: countText(text, "REPAIR NEEDLE 3"),
    });
    const out2 = await repairPdf(doubled, OPTIONS());
    check("consistent output: same run twice", Buffer.compare(Buffer.from(out.bytes), Buffer.from(out2.bytes)) === 0);
  }

  console.log("\n── 8. (e) truncated mid-file (cut inside the last stream) ─");
  const truncated = truncateBeforeLastEndstream(valid, 20);
  {
    const s = toLatin(truncated);
    check(
      "cut verified: xref/trailer/startxref/%%EOF all gone with the tail",
      !s.includes("xref") && !s.includes("trailer") && !s.includes("%%EOF")
    );
    check(
      "cut verified: the final object never closes",
      !s.slice(s.lastIndexOf("10 0 obj")).includes("endobj")
    );
    const out = await repairPdf(truncated, OPTIONS());
    check("truncation honestly detected", out.report.truncationDetected === true, out.report);
    check("eof + xref also gone with the cut", out.report.eofMissing === true && out.report.xrefRebuilt === true);
    const re = await strictLoad(out.bytes);
    check("strict reload: page count == report (all leaves survived)", re.getPageCount() === out.report.pages && out.report.pages >= 1, { reloaded: re.getPageCount(), report: out.report.pages });
    const text = flateTextOf(re);
    check("surviving pages keep their needles", hasText(text, "REPAIR NEEDLE 1") && hasText(text, "REPAIR NEEDLE 2"));
    check("cut content is honestly gone (needle 3 absent)", !hasText(text, "REPAIR NEEDLE 3"));
  }

  console.log("\n── 9. (f) missing %%EOF only ─────────────────────────────");
  const noEof = stripEof(valid);
  {
    const out = await repairPdf(noEof, OPTIONS());
    check("eof reported missing", out.report.eofMissing === true, out.report);
    check("xref was fine (honest: not claimed rebuilt)", out.report.xrefRebuilt === false);
    check("output ends with %%EOF", toLatin(out.bytes).trimEnd().endsWith("%%EOF"));
    const re = await strictLoad(out.bytes);
    check("strict reload: 3 pages", re.getPageCount() === 3 && out.report.pages === 3);
    check("needle survives", hasText(flateTextOf(re), "REPAIR NEEDLE 2"));
  }

  console.log("\n── 10. honest rejections ──────────────────────────────────");
  {
    // Encrypted (@cantoo AES-256): repair is NOT crack.
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const enc = await CantooDoc.create();
    enc.addPage([300, 300]);
    enc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    const encrypted = await enc.save({ useObjectStreams: false });
    await expectRepairError(encrypted, "errEncrypted");

    // Pure garbage with a PDF-ish header: no obj patterns at all.
    await expectRepairError(
      latin1("%PDF-1.7\nnot really a pdf, just bytes that look like one\n"),
      "errNoObjects"
    );
    // Plain non-PDF bytes.
    await expectRepairError(latin1("This is a plain text file."), "errNoObjects");

    // Catalog-less object soup: objects survive, no /Type /Catalog.
    await expectRepairError(
      latin1(
        "%PDF-1.4\n" +
          "1 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 >>\nendobj\n" +
          "2 0 obj\n[1 2 3]\nendobj\n" +
          "3 0 obj\n<< /Foo (bar) >>\nendobj\n"
      ),
      "errNoCatalog"
    );

    // Catalog present but zero reachable pages.
    await expectRepairError(
      latin1(
        "%PDF-1.4\n" +
          "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"
      ),
      "errNoPages"
    );
  }

  console.log("\n── 11. salvaged outputs behave in later stages ────────────");
  {
    // A repaired file must work as an INPUT again: pages read, page tree
    // resolvable, and the objects the pages need (fonts) still there.
    const out = await repairPdf(stripXrefBlock(valid), OPTIONS());
    const re = await strictLoad(out.bytes);
    const pages = re.getPages();
    check("3 page objects resolve", pages.length === 3);
    let fontOk = false;
    for (const page of pages) {
      const res = page.node.get(PDFName.of("Resources"));
      if (res instanceof PDFDict && res.get(PDFName.of("Font")) !== undefined) {
        fontOk = true;
      }
    }
    check("page /Resources /Font chain survives", fontOk);
  }

  console.log("\n── 12. xref-STREAM salvage (R4-b: /Index + /W rows) ───────");
  {
    interface XRefPart {
      num: number;
      gen: number;
      stream: boolean;
      dict: string;
      data: string;
      body: string;
    }

    /** Mirrors the documented rebuild contract: fresh %PDF- header,
     *  objects ascending, a correct classic xref table, a minimal
     *  trailer with the scanned /Root, startxref + %%EOF. The smoke
     *  knows every object's exact bytes (it built them), so this is
     *  an INDEPENDENT reference the tool's output must equal. */
    const referenceRebuild = (
      parts: Map<number, XRefPart>,
      root: { num: number; gen: number }
    ): Uint8Array => {
      const nums = [...parts.keys()].sort((a, b) => a - b);
      const maxNum = nums[nums.length - 1];
      let s = "%PDF-1.7\n";
      const offsets = new Map<number, number>();
      for (const n of nums) {
        const p = parts.get(n)!;
        offsets.set(n, s.length);
        s += p.stream
          ? `${n} ${p.gen} obj\n${p.dict}\nstream\n${p.data}\nendstream\nendobj\n`
          : `${n} ${p.gen} obj\n${p.body}\nendobj\n`;
      }
      const xrefOffset = s.length;
      const size = maxNum + 1;
      s += `xref\n0 ${size}\n0000000000 65535 f \n`;
      for (let n = 1; n <= maxNum; n += 1) {
        const p = parts.get(n)!;
        s += `${String(offsets.get(n)).padStart(10, "0")} ${String(p.gen).padStart(5, "0")} n \n`;
      }
      s += `trailer\n<< /Size ${size} /Root ${root.num} ${root.gen} R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      return latin1(s);
    };

    /** Hand-assembled 3-page PDF (objects 1..10) whose ONLY cross-
     *  reference is a /Type /XRef stream (object 10: /W [1 4 2],
     *  /Index [0 10] — the linearized-file shape). No classic xref,
     *  no startxref, no trailer, no %%EOF, so the structure check
     *  fails and stage 2 runs. rowDelta shifts every recorded offset
     *  (a STALE xref stream); corruptXrefData swaps the compressed
     *  rows for same-length junk (un-inflatable); classicTrailer
     *  appends a VALID classic xref + trailer instead (a healthy file
     *  that merely happens to carry an xref stream object). */
    const buildXrefStreamFixture = (opts: {
      rowDelta?: number;
      corruptXrefData?: boolean;
      classicTrailer?: boolean;
    }): { bytes: Uint8Array; parts: Map<number, XRefPart> } => {
      const parts = new Map<number, XRefPart>();
      const plain = (num: number, body: string): XRefPart => ({
        num,
        gen: 0,
        stream: false,
        dict: "",
        data: "",
        body,
      });
      const streamPart = (
        num: number,
        dict: string,
        data: string
      ): XRefPart => ({
        num,
        gen: 0,
        stream: true,
        dict,
        data,
        body: "",
      });

      parts.set(1, plain(1, "<< /Type /Catalog /Pages 2 0 R >>"));
      parts.set(
        2,
        plain(2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>")
      );
      for (let p = 1; p <= 3; p += 1) {
        parts.set(
          2 + p,
          plain(
            2 + p,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${5 + p} 0 R >>`
          )
        );
      }
      for (let p = 1; p <= 3; p += 1) {
        const content = `BT /F1 24 Tf 72 720 Td (XREFSTREAM NEEDLE ${p}) Tj ET`;
        const z = toLatin(deflateSync(Buffer.from(content, "latin1")));
        parts.set(
          5 + p,
          streamPart(5 + p, `<< /Length ${z.length} /Filter /FlateDecode >>`, z)
        );
      }
      parts.set(
        9,
        plain(9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
      );

      // Lay out objects 1..9 first — their offsets feed the rows.
      const offsets = new Map<number, number>();
      let s = "%PDF-1.5\n";
      for (let n = 1; n <= 9; n += 1) {
        const p = parts.get(n)!;
        offsets.set(n, s.length);
        s += p.stream
          ? `${n} ${p.gen} obj\n${p.dict}\nstream\n${p.data}\nendstream\nendobj\n`
          : `${n} ${p.gen} obj\n${p.body}\nendobj\n`;
      }

      // One 7-byte row per object per /W [1 4 2]: type, 4-byte BE
      // offset, 2-byte BE gen. Row 0 is the free entry.
      const row = (type: number, f2: number, f3: number): string =>
        toLatin(
          new Uint8Array([
            type & 0xff,
            (f2 >>> 24) & 0xff,
            (f2 >>> 16) & 0xff,
            (f2 >>> 8) & 0xff,
            f2 & 0xff,
            (f3 >>> 8) & 0xff,
            f3 & 0xff,
          ])
        );
      const delta = opts.rowDelta ?? 0;
      let rows = row(0, 0, 65535);
      for (let n = 1; n <= 9; n += 1) {
        rows += row(1, (offsets.get(n) ?? 0) + delta, 0);
      }
      const z = toLatin(deflateSync(Buffer.from(rows, "latin1")));
      const dict = `<< /Type /XRef /Size 11 /W [1 4 2] /Index [0 10] /Root 1 0 R /Filter /FlateDecode /Length ${z.length} >>`;
      offsets.set(10, s.length);
      parts.set(10, streamPart(10, dict, z));
      s += `10 0 obj\n${dict}\nstream\n${z}\nendstream\nendobj\n`;

      if (opts.corruptXrefData) {
        // Same-length junk at the exact data extent: extraction is
        // identical, the stream just no longer inflates — the object
        // scan must take over.
        const at =
          offsets.get(10)! +
          "10 0 obj\n".length +
          dict.length +
          "\nstream\n".length;
        const junk = "X".repeat(z.length);
        s = s.slice(0, at) + junk + s.slice(at + junk.length);
      }

      if (opts.classicTrailer) {
        const xrefOffset = s.length;
        let table = "xref\n0 11\n0000000000 65535 f \n";
        for (let n = 1; n <= 10; n += 1) {
          table += `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`;
        }
        s += `${table}trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      }
      return { bytes: latin1(s), parts };
    };

    // (i) The salvage path itself.
    const good = buildXrefStreamFixture({});
    check(
      "fixture verified: no classic xref/startxref/trailer/%%EOF, /Type /XRef present",
      (() => {
        const s = toLatin(good.bytes);
        return (
          !s.includes("startxref") &&
          !s.includes("trailer") &&
          !s.includes("%%EOF") &&
          /\/Type \/XRef /.test(s)
        );
      })(),
    );
    const salvaged = await repairPdf(good.bytes, OPTIONS());
    check(
      "xref stream found → salvage path exercised",
      salvaged.report.xrefStreamSalvaged === true,
      salvaged.report,
    );
    check(
      "9 objects materialized from the /Index+/W rows",
      salvaged.report.xrefStreamEntries === 9,
      salvaged.report.xrefStreamEntries,
    );
    check(
      "all 10 objects recovered (9 via rows + the xref stream object via the scan merge)",
      salvaged.report.objectsRecovered === 10,
      salvaged.report.objectsRecovered,
    );
    check(
      "honest damage flags (xref + eof gone, no length/dup/truncation claims)",
      salvaged.report.xrefRebuilt === true &&
        salvaged.report.eofMissing === true &&
        salvaged.report.streamLengthsFixed === 0 &&
        salvaged.report.duplicatesResolved === 0 &&
        salvaged.report.truncationDetected === false &&
        salvaged.report.headerFixed === false,
      salvaged.report,
    );
    const reGood = await strictLoad(salvaged.bytes);
    check(
      "strict reload: 3 pages, report agrees",
      reGood.getPageCount() === 3 && salvaged.report.pages === 3,
      { reloaded: reGood.getPageCount(), report: salvaged.report.pages },
    );
    const goodText = flateTextOf(reGood);
    check(
      "all three page needles survive (inflated, node:zlib)",
      hasText(goodText, "XREFSTREAM NEEDLE 1") &&
        hasText(goodText, "XREFSTREAM NEEDLE 2") &&
        hasText(goodText, "XREFSTREAM NEEDLE 3"),
    );
    check(
      "output carries a fresh classic xref + trailer + startxref + %%EOF",
      (() => {
        const o = toLatin(salvaged.bytes);
        return (
          o.includes("xref\n0 11\n") &&
          o.includes("trailer\n<< /Size 11 /Root 1 0 R >>") &&
          o.includes("startxref") &&
          o.trimEnd().endsWith("%%EOF")
        );
      })(),
    );
    check(
      "OUTPUT EQUALS THE REFERENCE RECONSTRUCTION (byte-for-byte)",
      Buffer.compare(
        Buffer.from(salvaged.bytes),
        Buffer.from(referenceRebuild(good.parts, { num: 1, gen: 0 }))
      ) === 0,
    );

    // (ii) A STALE xref stream — every offset shifted by 1 so the
    // byte-verification drops all rows — must NOT be trusted; the
    // object-scan fallback reconstructs the SAME document.
    const stale = buildXrefStreamFixture({ rowDelta: 1 });
    const viaStale = await repairPdf(stale.bytes, OPTIONS());
    check(
      "stale rows (bytes disagree) → xref stream honestly NOT used",
      viaStale.report.xrefStreamSalvaged === false &&
        viaStale.report.xrefStreamEntries === 0,
      {
        salvaged: viaStale.report.xrefStreamSalvaged,
        entries: viaStale.report.xrefStreamEntries,
      },
    );
    check(
      "stale fallback: same 10 objects, 3 pages, needles survive",
      viaStale.report.objectsRecovered === 10 &&
        viaStale.report.pages === 3 &&
        hasText(
          flateTextOf(await strictLoad(viaStale.bytes)),
          "XREFSTREAM NEEDLE 2"
        ),
    );
    check(
      "stale fallback: objects 1..9 byte-identical to the salvage output" +
        " (the stale stream's own bytes differ only as the file has them)",
      (() => {
        const goodS = toLatin(salvaged.bytes);
        const staleS = toLatin(viaStale.bytes);
        const p10 = goodS.indexOf("10 0 obj\n");
        return (
          p10 > 0 &&
          staleS.indexOf("10 0 obj\n") === p10 &&
          goodS.slice(0, p10) === staleS.slice(0, p10)
        );
      })(),
    );

    // (iii) An UN-INFLATABLE xref stream (corrupted rows, same length):
    // parse fails → fallback, and the junk navigation stream is
    // EXCLUDED from the rebuild — pdf-lib eagerly decodes /Type /XRef
    // streams and garbage rows would make the whole output unloadable;
    // the fresh classic table replaces it. Excluded = honestly not
    // counted.
    const corrupt = buildXrefStreamFixture({ corruptXrefData: true });
    const viaCorrupt = await repairPdf(corrupt.bytes, OPTIONS());
    check(
      "un-inflatable rows → xref stream honestly NOT used",
      viaCorrupt.report.xrefStreamSalvaged === false &&
        viaCorrupt.report.xrefStreamEntries === 0,
      viaCorrupt.report,
    );
    check(
      "junk xref stream excluded from the rebuild (9 objects, honestly not counted)",
      viaCorrupt.report.objectsRecovered === 9,
      viaCorrupt.report.objectsRecovered,
    );
    const reCorrupt = await strictLoad(viaCorrupt.bytes);
    check(
      "corrupt-rows fallback: 3 pages + needles survive",
      reCorrupt.getPageCount() === 3 &&
        hasText(flateTextOf(reCorrupt), "XREFSTREAM NEEDLE 1") &&
        hasText(flateTextOf(reCorrupt), "XREFSTREAM NEEDLE 3"),
    );
    check(
      "output carries no /Type /XRef object (fresh classic table only)",
      !toLatin(viaCorrupt.bytes).includes("/XRef"),
    );

    // (iv) A HEALTHY file that merely carries an xref stream object:
    // stage 1 keeps it byte-identical — salvage never hijacks valid
    // files.
    const healthy = buildXrefStreamFixture({ classicTrailer: true });
    const untouched = await repairPdf(
      healthy.bytes,
      OPTIONS({ alsoRebuildValid: false })
    );
    check(
      "valid file + xref stream: structure valid, byte-identical, no salvage claim",
      untouched.report.structureWasValid === true &&
        untouched.report.unchanged === true &&
        untouched.report.xrefStreamSalvaged === false &&
        Buffer.compare(
          Buffer.from(untouched.bytes),
          Buffer.from(healthy.bytes)
        ) === 0,
      untouched.report,
    );
  }

  console.log(
    `\nrepair-pdf smoke: ${pass} passed, ${fail} failed` +
      (fail ? "\n  " + failures.join("\n  ") : " — ALL GREEN")
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
