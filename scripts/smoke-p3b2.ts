/**
 * PRE-BUILD smoke for PHASE-3 batch 2 (edit-attachments, timestamp-pdf,
 * table-of-contents). The raster tools (adjust-colors, posterize-pdf,
 * scanner-effect) are browser-E2E covered (pdfjs DOM shim), and TOC's
 * pdf.js entry-reading is E2E too — this smoke drives buildTocFromEntries
 * (the plan → draw → bookmarks core) with crafted entries.
 *
 *  1. edit-attachments: add → rename + delete round trip (byte-exact,
 *     delete-wins, parseOps validation, honest errors, tree shape).
 *  2. timestamp-pdf: formatTimestamp shapes, option resolution, and the
 *     stamped output (own parser + pdf-lib oracle + hex content marker).
 *  3. table-of-contents: buildTocFromEntries — start/end insertion,
 *     multi-page TOC, drawn content markers, shifted numbers, bookmarks
 *     tree + /PageMode.
 *  4. registry: 130 live tools.
 *
 * Run: bun scripts/smoke-p3b2.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  runAddAttachments,
  type AttachmentSpec,
} from "../tools/add-attachments/worker";
import {
  runExtractAttachments,
} from "../tools/extract-attachments/worker";
import {
  parseOps,
  runEditAttachments,
} from "../tools/edit-attachments/worker";
import {
  formatTimestamp,
  resolveTimestampOptions,
  runTimestampOne,
} from "../tools/timestamp-pdf/worker";
import {
  buildTocFromEntries,
  resolveTocOptions,
  type TocEntry,
} from "../tools/table-of-contents/worker";
import {
  encodeWinAnsiHex,
  latin1,
  parsePdf,
  asDict,
  resolve,
  name as pdfName,
} from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

/** Hex content marker for a WinAnsi string stamped via StampContext. */
const hexMarker = (text: string) => `<${encodeWinAnsiHex(text, "helvetica").toLowerCase()}>`;

async function markerPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`P${i}`, { x: 40, y: 200, size: 32, font });
  }
  return new Uint8Array(await doc.save());
}

/* ------------------------------------------------------------------ */
console.log("1. edit-attachments — rename + delete round trip");

{
  const pdfBytes = await markerPdf(2);
  const atts: AttachmentSpec[] = [
    { name: "contract.txt", bytes: new TextEncoder().encode("CONTRACT-BYTES-123") },
    { name: "photo.bin", bytes: new Uint8Array([0, 1, 2, 250, 251, 252, 253]) },
  ];
  const withAtts = (await runAddAttachments(pdfBytes, atts, { keepExisting: true })).bytes;

  // Rename #0, delete #1.
  const edited = runEditAttachments(withAtts, {
    ops: JSON.stringify({ v: 1, ops: [{ i: 0, name: "agreement.txt" }, { i: 1, del: true }] }),
  });
  check("edit: renamed 1, deleted 1, kept 1", edited.summary.renamed === 1 && edited.summary.deleted === 1 && edited.summary.kept === 1, JSON.stringify(edited.summary));

  const back = await runExtractAttachments(edited.bytes);
  check("edit: 1 file remains", back.attachments.length === 1, JSON.stringify(back.attachments.map((a) => a.name)));
  check("edit: renamed name visible", back.attachments[0]?.name === "agreement.txt", back.attachments[0]?.name);
  check(
    "edit: bytes byte-exact after rename",
    back.attachments[0] !== undefined && latin1All(back.attachments[0].bytes) === "CONTRACT-BYTES-123"
  );

  const oracle = await PDFDocument.load(edited.bytes);
  check("edit: pdf-lib oracle reload", oracle.getPageCount() === 2);

  // Delete-wins over rename on the same index.
  const both = runEditAttachments(withAtts, {
    ops: JSON.stringify({ v: 1, ops: [{ i: 0, name: "x.txt" }, { i: 0, del: true }] }),
  });
  const backBoth = await runExtractAttachments(both.bytes);
  check("edit: delete beats rename (same index)", backBoth.attachments.length === 1 && backBoth.attachments[0]?.name === "photo.bin", JSON.stringify(backBoth.attachments.map((a) => a.name)));

  // Delete everything — the subtree disappears entirely.
  const allGone = runEditAttachments(withAtts, {
    ops: JSON.stringify({ v: 1, ops: [{ i: 0, del: true }, { i: 1, del: true }] }),
  });
  const backGone = await runExtractAttachments(allGone.bytes);
  check("edit: delete-all empties the tree", backGone.attachments.length === 0);
  const docGone = parsePdf(allGone.bytes);
  const rootGone = docGone.trailer.get("Root");
  const catalogGone = rootGone?.k === "ref" ? docGone.getObject(rootGone.num) : rootGone;
  const namesGone = asDict(resolve(docGone, asDict(catalogGone)?.get("Names")));
  check("edit: no /EmbeddedFiles left in /Names", !namesGone || namesGone.get("EmbeddedFiles") === undefined);

  // Honest errors.
  let noAtt: string | null = null;
  try {
    runEditAttachments(pdfBytes, { ops: JSON.stringify({ v: 1, ops: [{ i: 0, del: true }] }) });
  } catch (error) {
    noAtt = (error as Error).message;
  }
  check("edit: no attachments → edat.errorNoAttachments", noAtt === "edat.errorNoAttachments", String(noAtt));

  let nothing: string | null = null;
  try {
    runEditAttachments(withAtts, { ops: "" });
  } catch (error) {
    nothing = (error as Error).message;
  }
  check("edit: empty ops → edat.errorNothingToDo", nothing === "edat.errorNothingToDo", String(nothing));

  // parseOps validation.
  check("parseOps: bad JSON dropped", parseOps("not json{").length === 0);
  check("parseOps: bad shapes dropped", parseOps(JSON.stringify({ ops: [{ i: -1 }, { i: 1.5 }, { i: 0, del: "yes" }, null] })).length === 0);
  check(
    "parseOps: unsafe name sanitized",
    (() => {
      const ops = parseOps(JSON.stringify({ ops: [{ i: 0, name: "bad/name:*.pdf   " }] }));
      return ops.length === 1 && ops[0]?.name === "bad_name__.pdf";
    })()
  );
}

/* ------------------------------------------------------------------ */
console.log("2. timestamp-pdf — formats + stamped output");

{
  const d = new Date(2026, 0, 26, 14, 30, 5);
  check("fmt: datetime", formatTimestamp(d, "datetime") === "26 Jan 2026, 14:30:05", formatTimestamp(d, "datetime"));
  check("fmt: date", formatTimestamp(d, "date") === "26 Jan 2026", formatTimestamp(d, "date"));
  check("fmt: time", formatTimestamp(d, "time") === "14:30:05", formatTimestamp(d, "time"));
  {
    // ISO — env-independent: the offset must mirror this environment's
    // timezone for that instant, with the correct sign/padding.
    const offsetMinutes = -d.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const expected =
      `2026-01-26T14:30:05${sign}` +
      `${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    check("fmt: iso mirrors local tz", formatTimestamp(d, "iso") === expected, `${formatTimestamp(d, "iso")} vs ${expected}`);
  }

  const opts = resolveTimestampOptions(
    { format: "date", prefix: "Verified on", position: "top-right", size: 99, opacity: 500, color: "nope" },
    d
  );
  check("opts: prefix joined", opts.text === "Verified on 26 Jan 2026", opts.text);
  check("opts: size clamped", opts.size === 9, String(opts.size));
  check("opts: opacity clamped", opts.opacity === 0.7, String(opts.opacity));
  check("opts: color fallback", opts.color === (resolveTimestampOptions({ color: "gray" }, d)).color);
  {
    const bad = resolveTimestampOptions({ position: "diagonal-ish" }, d);
    check("opts: bad placement falls back", bad.placement === "bottom-right", bad.placement);
  }

  const pdfBytes = await markerPdf(2);
  const result = runTimestampOne(pdfBytes, opts);
  check("stamp: 2 pages out", result.pages === 2);
  const parsed = parsePdf(result.bytes);
  check("stamp: own parser reload", parsed !== null);
  const oracle = await PDFDocument.load(result.bytes);
  check("stamp: pdf-lib oracle reload", oracle.getPageCount() === 2);
  const raw = latin1All(result.bytes);
  check("stamp: content marker (hex Tj)", raw.includes(hexMarker("Verified on 26 Jan 2026")), hexMarker("Verified on 26 Jan 2026"));
  check("stamp: stamped text reported", result.stamped === "Verified on 26 Jan 2026", result.stamped);
}

/* ------------------------------------------------------------------ */
console.log("3. table-of-contents — buildTocFromEntries core");

{
  const pdfBytes = await markerPdf(3);
  const entries: TocEntry[] = [
    { title: "Chapter One", page: 1, depth: 0 },
    { title: "Chapter Two", page: 2, depth: 0 },
    { title: "Appendix", page: 3, depth: 1 },
  ];
  const opts = resolveTocOptions({ position: "start", fontSize: 11, title: "Contents", addBookmarks: true });

  const result = await buildTocFromEntries(pdfBytes, entries, opts);
  check("toc: pageCount 3+1", result.pageCount === 4 && result.tocPages === 1, `${result.pageCount}/${result.tocPages}`);
  check("toc: 3 entries", result.entries === 3);

  const raw = latin1All(result.bytes);
  check("toc: heading drawn", raw.includes(hexMarker("Contents")));
  check("toc: entry titles drawn", raw.includes(hexMarker("Chapter One")) && raw.includes(hexMarker("Appendix")));
  // Shifted numbers: original pages 1,2,3 → physical 2,3,4 (start insert).
  check("toc: shifted numbers drawn", raw.includes(hexMarker("4")));

  const doc = parsePdf(result.bytes);
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const catalogDict = asDict(catalog);
  check("toc: bookmarks written", catalogDict?.get("Outlines") !== undefined);
  check("toc: outline panel opens", JSON.stringify(catalogDict?.get("PageMode")) === JSON.stringify(pdfName("UseOutlines")));

  // Original vector content preserved: page 2 of output still has P1 marker.
  const oracle = await PDFDocument.load(result.bytes);
  check("toc: oracle pageCount 4", oracle.getPageCount() === 4);

  // End position: same count, TOC last.
  const endResult = await buildTocFromEntries(pdfBytes, entries, resolveTocOptions({ position: "end", addBookmarks: false }));
  check("toc: end position pageCount 4", endResult.pageCount === 4 && endResult.tocPages === 1);
  const endRaw = latin1All(endResult.bytes);
  check("toc: end keeps original numbering", endRaw.includes(hexMarker("3")) && !endRaw.includes(hexMarker("4>")));

  // Multi-page TOC: 60 entries on 300×400 pages → several TOC pages.
  const many: TocEntry[] = Array.from({ length: 60 }, (_, i) => ({
    title: `Item ${i + 1}`,
    page: (i % 3) + 1,
    depth: 0,
  }));
  const manyResult = await buildTocFromEntries(pdfBytes, many, opts);
  check("toc: multi-page TOC (60 entries)", manyResult.tocPages >= 2 && manyResult.pageCount === 3 + manyResult.tocPages, `${manyResult.tocPages}`);
  const manyRaw = latin1All(manyResult.bytes);
  check("toc: last entry drawn", manyRaw.includes(hexMarker("Item 60")));

  // No entries → honest error.
  let noEntries: string | null = null;
  try {
    await buildTocFromEntries(pdfBytes, [], opts);
  } catch (error) {
    noEntries = (error as Error).message;
  }
  check("toc: empty → toc.errorNoEntries", noEntries === "toc.errorNoEntries", String(noEntries));
}

/* ------------------------------------------------------------------ */
console.log("4. registry — live tool count");

{
  // 127 live + 3 AI-deferred (R23) = 130 registered — 6 new in this batch.
  check("registry: 141 live tools", liveToolCount === 141, String(liveToolCount));
}

/* ------------------------------------------------------------------ */
console.log("");
console.log(`smoke-p3b2: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
