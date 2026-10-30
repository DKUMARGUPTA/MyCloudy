/**
 * Smoke: web-optimize-pdf (RB3-b) — structural PDF optimization for web
 * viewing, 100% on-device.
 *
 * House conventions: REAL fixtures built in-script with pdf-lib (a
 * text-heavy 3-page PDF whose content streams are deliberately level-1
 * flate bloat; a metadata-heavy PDF carrying a big XMP packet + producer
 * junk; a doc with planted unreferenced objects), node:zlib as the
 * INFLATE oracle (NOT fflate — the same container PDF streams use), the
 * full worker pipeline replicated step-for-step (load → garbage walk →
 * optional strip → recompress → save), parse-level asserts on reload,
 * relative imports without .ts, process.exit at the end.
 *
 * Run: bun scripts/smoke-web-optimize-pdf.ts
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
} from "pdf-lib";
import type { PDFRef } from "pdf-lib";
import { zlibSync } from "../src/lib/own/zip/index";
import { rewriteDocument } from "../src/lib/own/pdf/index";

import {
  classifyWebOptError,
  collectUnreferencedObjects,
  countObjectStreams,
  loadWebOpt,
  recompressFlateStreams,
  resolveParams,
  rewriteWebOpt,
  type WebOptParams,
} from "../tools/web-optimize-pdf/engine";

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

const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match (odt smoke's needle matcher). */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

/** The /Contents ref of a page (single ref or one-element array). */
function contentRef(page: PDFDict): PDFRef | null {
  const raw = page.get(PDFName.of("Contents"));
  if (isRef(raw)) return raw;
  if (raw instanceof PDFArray && raw.size() >= 1) {
    const first = raw.get(0);
    if (isRef(first)) return first;
  }
  return null;
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
      /* not zlib — skip */
    }
  }
  return out;
}

/** The raw /ObjStm count via latin1 split — the byte-scan oracle. */
function objStmOracle(bytes: Uint8Array): number {
  return Buffer.from(bytes).toString("latin1").split("/ObjStm").length - 1;
}

/* ------------------------------------------------------------------ */
/* The worker's exact pipeline (own engine — loadWebOpt + rewriteWebOpt) */
/* ------------------------------------------------------------------ */

interface RunDetailOut {
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  savedPct: number;
  streamsRecompressed: number;
  objectStreamsCount: number;
  metadataStripped: boolean;
  unreferencedObjects: number;
  pages: number;
}

function runWebOpt(
  input: Uint8Array,
  params: WebOptParams
): RunDetailOut {
  const doc = loadWebOpt(input);
  const out = rewriteWebOpt(doc, params);
  const objectStreamsCount = params.objectStreams
    ? countObjectStreams(out.bytes)
    : 0;
  const beforeBytes = input.length;
  const afterBytes = out.bytes.length;
  const savedPct =
    beforeBytes > 0 ? Math.round((1 - afterBytes / beforeBytes) * 1000) / 10 : 0;
  return {
    bytes: out.bytes,
    beforeBytes,
    afterBytes,
    savedPct,
    streamsRecompressed: out.recompress?.streamsRecompressed ?? 0,
    objectStreamsCount,
    metadataStripped: out.metadataStripped,
    unreferencedObjects: out.garbage.removed,
    pages: out.pageCount,
  };
}

const defaults = (): WebOptParams => ({
  objectStreams: true,
  recompress: true,
  stripMetadata: false,
});

/* ------------------------------------------------------------------ */
/* Fixture A: text-heavy 3-pager with level-1 bloaty content streams    */
/* ------------------------------------------------------------------ */

async function buildBloatyFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Web Opt Fixture - page ${p}`, {
      x: 40,
      y: 780,
      size: 16,
      font,
    });
    page.drawText(`SELECTABLE NEEDLE ${p}`, {
      x: 40,
      y: 750,
      size: 11,
      font,
    });
  }
  const stage1 = await doc.save({ useObjectStreams: false });

  // Bloat: every content stream gets 400 repeated text ops, re-deflated at
  // the WEAKEST level (1) — exactly the slack real-world files carry when
  // a producer zips content with the fast preset.
  const loaded = await PDFDocument.load(stage1, { updateMetadata: false });
  const pages = loaded.catalog.lookup(PDFName.of("Pages"), PDFDict);
  const kids = pages.lookup(PDFName.of("Kids"), PDFArray);
  let bloatyStreams = 0;
  for (let i = 0; i < kids.size(); i += 1) {
    const page = kids.lookup(i, PDFDict);
    const ref = contentRef(page);
    if (!ref) continue;
    const stream = loaded.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const original = inflateSync(Buffer.from(stream.contents)).toString(
      "latin1"
    );
    let bloat = original;
    for (let k = 0; k < 400; k += 1) {
      const y = 700 - (k % 60) * 10;
      bloat +=
        `\nBT\n/F1 8 Tf\n1 0 0 1 40 ${y} Tm\n` +
        `(deliberately bloaty filler line number ${k} of the web optimize smoke payload) Tj\nET\n`;
    }
    const level1 = zlibSync(new Uint8Array(Buffer.from(bloat, "latin1")), {
      level: 1,
    });
    loaded.context.assign(ref, PDFRawStream.of(stream.dict, level1));
    bloatyStreams += 1;
  }
  if (bloatyStreams !== 3) throw new Error(`fixture build: ${bloatyStreams}`);
  return loaded.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ */
/* Fixture B: metadata-heavy (big XMP + producer/creator junk)          */
/* ------------------------------------------------------------------ */

const XMP_FILLER =
  "Monstrous Producer Suite Professional Edition with plugin pack " +
  "and telemetry block and long descriptive attribute strings ".repeat(24);

function xmpPacket(): string {
  return (
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
    `<xmp:CreatorTool>Monstrous Creator Engine Suite</xmp:CreatorTool>` +
    `<xmp:Producer>${XMP_FILLER}</xmp:Producer>` +
    `<dc:format>application/pdf</dc:format>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

async function buildMetaFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Meta fixture body", { x: 20, y: 150, size: 12, font });
  doc.setTitle("Web Opt QA Title");
  doc.setAuthor("QA Bot");
  doc.setProducer(
    "Monstrous Producer Suite Professional Edition 2026 with plugin pack"
  );
  doc.setCreator("Monstrous Creator Engine Suite");
  const stage1 = await doc.save({ useObjectStreams: false });

  // Attach a big XMP /Metadata packet to the catalog.
  const loaded = await PDFDocument.load(stage1, { updateMetadata: false });
  const dict = PDFDict.withContext(loaded.context);
  dict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  dict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const stream = PDFRawStream.of(
    dict,
    new Uint8Array(Buffer.from(xmpPacket(), "utf8"))
  );
  const ref = loaded.context.register(stream);
  loaded.catalog.set(PDFName.of("Metadata"), ref);
  return loaded.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ */
/* Fixture C: planted unreferenced objects                             */
/* ------------------------------------------------------------------ */

async function buildDeadFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Dead objects fixture", { x: 20, y: 150, size: 12, font });

  // Two objects nothing points at: a dict and a raw stream.
  const deadDict = PDFDict.withContext(doc.context);
  deadDict.set(PDFName.of("DeadMarker"), PDFString.of("DEADOBJECT"));
  doc.context.register(deadDict);
  const deadStreamDict = PDFDict.withContext(doc.context);
  deadStreamDict.set(PDFName.of("DeadMarker2"), PDFString.of("DEADSTREAM"));
  doc.context.register(
    PDFRawStream.of(deadStreamDict, new Uint8Array([1, 2, 3, 4, 5]))
  );
  return doc.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("── 0. own-engine no-pdf-lib guard ───────────────────────");
  {
    const root = join(import.meta.dir, "../tools/web-optimize-pdf");
    for (const file of ["engine.ts", "worker.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      check(
        `${file} imports no pdf-lib`,
        !/(from\s+["'](?:@cantoo\/)?pdf-lib["']|import\(["'](?:@cantoo\/)?pdf-lib["']\))/.test(src),
      );
    }
  }

  console.log("── 1. resolveParams ─────────────────────────────────────");
  {
    const d = resolveParams({});
    check("defaults: object streams + recompress on, strip off", d.objectStreams && d.recompress && !d.stripMetadata, d);
    const off = resolveParams({
      objectStreams: false,
      recompress: false,
      stripMetadata: true,
    });
    check("explicit switches respected", !off.objectStreams && !off.recompress && off.stripMetadata, off);
  }

  console.log("\n── 2. bloaty fixture: build + oracle ─────────────────────");
  const bloaty = await buildBloatyFixture();
  {
    check("%PDF magic", bloaty[0] === 0x25 && bloaty[1] === 0x50 && bloaty[2] === 0x44 && bloaty[3] === 0x46);
    check("built WITHOUT object streams", objStmOracle(bloaty) === 0, objStmOracle(bloaty));
    const raw = Buffer.from(bloaty).toString("latin1");
    // The bloat is COMPRESSED into the flate streams — the literal filler
    // must NOT be visible raw, and every page dict must carry /FlateDecode.
    check(
      "filler hidden in flate streams (compression real)",
      !raw.includes("deliberately bloaty filler line number") &&
        (raw.match(/\/FlateDecode/g) ?? []).length >= 3
    );
    const loaded = await PDFDocument.load(bloaty, { updateMetadata: false });
    const text = flateTextOf(loaded);
    check("3 flate content streams inflate via node:zlib", (text.match(/bloaty filler line number/g) ?? []).length >= 400 * 3);
    check("needle text present pre-run", hasText(text, "SELECTABLE NEEDLE 2"));
    // level-1 vs level-9 must differ for the engine to have something to win
    const probe = zlibSync(
      new Uint8Array(Buffer.from(text.slice(0, 60000), "latin1")),
      { level: 9 }
    );
    check("level-9 re-deflate of the bloat is much smaller (win exists)", probe.length < 60000 * 0.5, probe.length);
  }

  console.log("\n── 3. recompressFlateStreams (engine, isolated) ──────────");
  {
    const loaded = loadWebOpt(bloaty);
    const { report, replacements } = recompressFlateStreams(loaded);
    check("found the 3 bloaty flate streams", report.streamsFound === 3, report);
    check("all 3 replaced (level 9 < level 1)", report.streamsRecompressed === 3, report);
    check("bytesAfter < bytesBefore", report.bytesAfter < report.bytesBefore, report);
    const saved = rewriteDocument(loaded, { replacements });
    const reloaded = await PDFDocument.load(saved, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("recompressed doc reloads with 3 pages", reloaded.getPageCount() === 3);
    const text = flateTextOf(reloaded);
    check("needles survive recompression", hasText(text, "SELECTABLE NEEDLE 1") && hasText(text, "SELECTABLE NEEDLE 3"));
    check("filler survives recompression (lossless round trip)", hasText(text, "deliberately bloaty filler line number 399"));

    // Honest replace-if-smaller: a pdf-lib-native fixture is already at
    // max compression — nothing must be replaced.
    const native = await PDFDocument.create();
    const p = native.addPage([300, 300]);
    const f = await native.embedFont(StandardFonts.Helvetica);
    p.drawText("native compression reference", { x: 10, y: 150, size: 10, font: f });
    const nativeBytes = await native.save({ useObjectStreams: false });
    const nativeLoaded = loadWebOpt(nativeBytes);
    const nativeReport = recompressFlateStreams(nativeLoaded).report;
    check(
      "already-max stream is kept, never grown (honest)",
      nativeReport.streamsFound >= 1 &&
        nativeReport.bytesAfter <= nativeReport.bytesBefore,
      nativeReport
    );
  }

  console.log("\n── 4. metadata fixture: strip + keep ──────────────────────");
  const meta = await buildMetaFixture();
  {
    const raw = Buffer.from(meta).toString("latin1");
    check("fixture carries /Metadata", raw.includes("/Metadata"));
    check("fixture XMP is big + uncompressed in raw", raw.includes("<x:xmpmeta") && raw.includes("Monstrous Creator Engine Suite"));

    // NOT stripped → XMP + producer/creator all survive
    const kept = await runWebOpt(meta, { ...defaults(), stripMetadata: false });
    const keptRaw = Buffer.from(kept.bytes).toString("latin1");
    check("not stripped: /Metadata survives", keptRaw.includes("/Metadata"));
    check("not stripped: XMP content survives", keptRaw.includes("x:xmpmeta"));
    check("not stripped: metadataStripped flag false", kept.metadataStripped === false);

    // Stripped → XMP + producer/creator gone, Title/Author survive
    const stripped = await runWebOpt(meta, { ...defaults(), stripMetadata: true });
    check("stripped run reports it", stripped.metadataStripped === true);
    const strippedRaw = Buffer.from(stripped.bytes).toString("latin1");
    check("stripped: /Metadata entry gone from catalog", !strippedRaw.includes("/Metadata"));
    check("stripped: XMP bytes gone", !strippedRaw.includes("x:xmpmeta"));
    const re = await PDFDocument.load(stripped.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("stripped: catalog has no /Metadata object", re.catalog.get(PDFName.of("Metadata")) === undefined);
    const info = re.context.lookupMaybe(re.context.trailerInfo.Info as never, PDFDict);
    const producer = info?.get(PDFName.of("Producer"));
    const creator = info?.get(PDFName.of("Creator"));
    const title = info?.get(PDFName.of("Title"));
    const author = info?.get(PDFName.of("Author"));
    check("stripped: Producer gone", producer === undefined);
    check("stripped: Creator gone", creator === undefined);
    const titleText =
      title instanceof PDFHexString || title instanceof PDFString
        ? title.decodeText()
        : "";
    const authorText =
      author instanceof PDFHexString || author instanceof PDFString
        ? author.decodeText()
        : "";
    check("stripped: Title survives (user data)", titleText.includes("Web Opt QA Title"), titleText);
    check("stripped: Author survives (user data)", authorText.includes("QA Bot"), authorText);
    check("stripped: page still renders needle", hasText(flateTextOf(re), "Meta fixture body"));
  }

  console.log("\n── 5. empty-Info drop (producer-only document) ───────────");
  {
    // A document whose Info holds ONLY Producer — strip empties it, so the
    // whole /Info object must be dropped, not left dangling.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("producer only", { x: 20, y: 150, size: 12, font });
    const stage1 = await doc.save({ useObjectStreams: false });
    const loaded = await PDFDocument.load(stage1, { updateMetadata: false });
    const info = loaded.context.lookupMaybe(
      loaded.context.trailerInfo.Info as never,
      PDFDict
    );
    check("producer-only info exists pre-strip", info !== undefined && info.get(PDFName.of("Producer")) !== undefined);
    if (info) {
      for (const key of ["Title", "Author", "Subject", "Keywords", "CreationDate", "ModDate"]) {
        info.delete(PDFName.of(key));
      }
    }
    const fixture = await loaded.save({ useObjectStreams: false });
    const out = await runWebOpt(fixture, { ...defaults(), stripMetadata: true });
    const re = await PDFDocument.load(out.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("empty Info dict dropped entirely", re.context.trailerInfo.Info === undefined, String(re.context.trailerInfo.Info));
    const outRaw = Buffer.from(out.bytes).toString("latin1");
    check("no dangling /Info in trailer", !outRaw.includes("/Info"));
  }

  console.log("\n── 6. unreferenced objects (garbage walk) ─────────────────");
  const dead = await buildDeadFixture();
  {
    const loaded = loadWebOpt(dead);
    const report = collectUnreferencedObjects(loaded);
    check("finds exactly the 2 planted dead objects", report.removed === 2, report);
    check("live + removed == total", report.liveObjects + report.removed === report.totalObjects, report);
    const saved = rewriteDocument(loaded, {
      deletions: report.deletions,
      objectStreams: true,
    });
    const re = await PDFDocument.load(saved, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("post-removal doc reloads, 1 page", re.getPageCount() === 1);
    let deadMarkerFound = false;
    for (const [, obj] of re.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream) continue; // stream contents may hold anything
      if (obj.toString().includes("DEADOBJECT")) deadMarkerFound = true;
    }
    check("dead dict marker absent from output", !deadMarkerFound);
    check("output has fewer objects than the fixture carried", [...re.context.enumerateIndirectObjects()].length < report.totalObjects);
    check("live needle survives", hasText(flateTextOf(re), "Dead objects fixture"));

    // Clean file: nothing dead, nothing removed.
    const cleanReport = collectUnreferencedObjects(loadWebOpt(bloaty));
    check("clean fixture: 0 unreferenced", cleanReport.removed === 0, cleanReport);
  }

  console.log("\n── 7. countObjectStreams + save toggles ──────────────────");
  {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const packed = await doc.save({ useObjectStreams: true });
    const loose = await doc.save({ useObjectStreams: false });
    check("packed save has /ObjStm ≥ 1", countObjectStreams(packed) >= 1, countObjectStreams(packed));
    check("loose save has none", countObjectStreams(loose) === 0);
    check(
      "engine count == latin1-split oracle (packed)",
      countObjectStreams(packed) === objStmOracle(packed)
    );
    check(
      "engine count == latin1-split oracle (loose)",
      countObjectStreams(loose) === objStmOracle(loose)
    );
    check("raw scan: /Type /ObjStm text present when on", Buffer.from(packed).toString("latin1").includes("/ObjStm"));
  }

  console.log("\n── 8. E2E full pipeline — bloaty fixture ─────────────────");
  {
    const out = await runWebOpt(bloaty, defaults());
    check("size actually shrinks on the bloaty fixture", out.afterBytes < out.beforeBytes, `${out.beforeBytes} → ${out.afterBytes}`);
    check("savedPct > 0", out.savedPct > 0, out.savedPct);
    check("3 streams recompressed", out.streamsRecompressed === 3, out.streamsRecompressed);
    check("object streams present when on", out.objectStreamsCount >= 1, out.objectStreamsCount);
    check("detail before/after consistent with real bytes", out.beforeBytes === bloaty.length && out.afterBytes === out.bytes.length);
    const expectPct = Math.round((1 - out.bytes.length / bloaty.length) * 1000) / 10;
    check("savedPct formula exact", Math.abs(out.savedPct - expectPct) < 1e-9, `${out.savedPct} vs ${expectPct}`);

    const re = await PDFDocument.load(out.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("strict reload: page count preserved", re.getPageCount() === 3 && out.pages === 3);
    const text = flateTextOf(re);
    for (const needle of [
      "Web Opt Fixture - page 1",
      "Web Opt Fixture - page 2",
      "SELECTABLE NEEDLE 1",
      "SELECTABLE NEEDLE 2",
      "SELECTABLE NEEDLE 3",
      "deliberately bloaty filler line number 399",
    ]) {
      check(`needle "${needle}" survives in output streams`, hasText(text, needle));
    }

    // object streams OFF — same doc, loose structure
    const offOut = await runWebOpt(bloaty, {
      ...defaults(),
      objectStreams: false,
    });
    check("object streams absent when off", offOut.objectStreamsCount === 0);
    check("loose output still shrinks via recompression", offOut.afterBytes < offOut.beforeBytes, `${offOut.beforeBytes} → ${offOut.afterBytes}`);
    const offRaw = Buffer.from(offOut.bytes).toString("latin1");
    check("raw scan: no /ObjStm when off", !offRaw.includes("/ObjStm"));
    const offRe = await PDFDocument.load(offOut.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("loose output reloads, 3 pages", offRe.getPageCount() === 3);
  }

  console.log("\n── 9. E2E — everything on (bloaty + strip) ───────────────");
  {
    const out = await runWebOpt(bloaty, { ...defaults(), stripMetadata: true });
    check("strip on a pdf-lib file: producer junk reported stripped", out.metadataStripped === true, out.metadataStripped);
    const re = await PDFDocument.load(out.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    check("all-on output reloads, 3 pages", re.getPageCount() === 3);
    const raw = Buffer.from(out.bytes).toString("latin1");
    check("all-on: object streams present", out.objectStreamsCount >= 1 && raw.includes("/ObjStm"));
  }

  console.log("\n── 10. honest errors ─────────────────────────────────────");
  {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const enc = await CantooDoc.create();
    enc.addPage([300, 300]);
    enc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    const encrypted = await enc.save({ useObjectStreams: false });
    let code = "";
    try {
      await PDFDocument.load(encrypted, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      check("encrypted: stock pdf-lib must refuse", false, "no throw");
    } catch {
      // fixture oracle: a genuinely encrypted file refuses everywhere
    }
    try {
      loadWebOpt(encrypted);
      check("own engine: encrypted must refuse", false, "no throw");
    } catch (error) {
      code = classifyWebOptError(error);
    }
    check("encrypted input → tool.errorEncrypted", code === "tool.errorEncrypted", code);

    code = "";
    try {
      loadWebOpt(new TextEncoder().encode("%PDF-1.7 not really a pdf"));
      check("garbage: must fail", false, "no throw");
    } catch (error) {
      code = classifyWebOptError(error);
    }
    check("garbage input → tool.errorCorrupt", code === "tool.errorCorrupt", code);

    code = "";
    try {
      loadWebOpt(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      check("non-PDF bytes: load must fail", false, "no throw");
    } catch (error) {
      code = classifyWebOptError(error);
    }
    check("non-PDF bytes → tool.errorCorrupt", code === "tool.errorCorrupt", code);
  }

  console.log("\n── 11. worker drive: ONE result per run ─────────────────");
  {
    // FIX-3 regression: the worker used to post {type:"result"} INSIDE the
    // per-file loop with an ACCUMULATING outputs array — duplicate result
    // messages the moment maxFiles grows past 1. Drive the REAL worker
    // (self/postMessage shim, sign-pdf recipe) with TWO files and pin:
    // exactly one result, both outputs on it, aggregated detail.
    const workerGlobal = globalThis as unknown as {
      postMessage: (msg: unknown) => void;
      onmessage: ((event: { data: unknown }) => void) | null;
    };
    const inbox: (Record<string, unknown> & { type: string })[] = [];
    workerGlobal.postMessage = (msg: unknown): void => {
      inbox.push(msg as Record<string, unknown> & { type: string });
    };
    (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
    await import("../tools/web-optimize-pdf/worker");
    check(
      "worker: module loaded, onmessage registered",
      typeof workerGlobal.onmessage === "function"
    );

    const drive = async (runId: number, files: File[]): Promise<void> => {
      const before = inbox.length;
      workerGlobal.onmessage!({
        data: { type: "run", runId, toolId: "web-optimize-pdf", options: {}, files },
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const terminal = inbox
          .slice(before)
          .some((m) => m.type === "result" || m.type === "error");
        if (terminal) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`worker run ${runId} did not finish`);
    };

    const fileA = new File([bloaty as BlobPart], "a.pdf");
    const docB = await PDFDocument.create();
    docB.addPage([300, 300]);
    docB.addPage([300, 300]);
    const bytesB = await docB.save({ useObjectStreams: false });
    const fileB = new File([bytesB as BlobPart], "b.pdf");

    await drive(9101, [fileA, fileB]);
    const msgs = inbox.filter((m) => m.type !== "progress");
    const results = msgs.filter((m) => m.type === "result");
    check("two-file run: exactly ONE result message", results.length === 1, results.length);
    check("two-file run: no error messages", msgs.every((m) => m.type !== "error"));
    const result = results[0] as {
      outputs?: { name?: string }[];
      detail?: Record<string, unknown>;
    };
    check(
      "result carries BOTH outputs",
      result.outputs?.length === 2 &&
        result.outputs[0]?.name === "a-web.pdf" &&
        result.outputs[1]?.name === "b-web.pdf",
      JSON.stringify(result.outputs?.map((o) => o.name))
    );
    check("detail.files === 2", result.detail?.files === 2, result.detail?.files);
    check("detail.pages aggregated (3 + 2)", result.detail?.pages === 5, result.detail?.pages);
    check(
      "detail.beforeBytes is the SUM of both inputs",
      result.detail?.beforeBytes === bloaty.length + bytesB.length,
      `${result.detail?.beforeBytes} vs ${bloaty.length + bytesB.length}`
    );
    check(
      "detail.afterBytes equals the sum of real output blob sizes",
      result.detail?.afterBytes ===
        (result.outputs as unknown as { blob: Blob }[]).reduce(
          (sum, o) => sum + o.blob.size,
          0
        ),
      `${result.detail?.afterBytes}`
    );

    // Single-file control: the common path still posts one result, one output.
    await drive(9102, [fileA]);
    const single = inbox
      .filter((m) => m.type === "result" && m.runId === 9102);
    check("single-file control: exactly ONE result", single.length === 1, single.length);
    const singleOut = single[0] as { outputs?: { name?: string }[] };
    check(
      "single-file control: ONE output named after the file",
      singleOut.outputs?.length === 1 && singleOut.outputs[0]?.name === "a-web.pdf",
      JSON.stringify(singleOut.outputs?.map((o) => o.name))
    );
  }

  console.log(
    `\nweb-optimize-pdf smoke: ${pass} passed, ${fail} failed` +
      (fail ? "\n  " + failures.join("\n  ") : " — ALL GREEN")
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
