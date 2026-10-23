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
 * Run: bun scripts/smoke-repair-pdf.ts
 */
import { inflateSync } from "node:zlib";

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
