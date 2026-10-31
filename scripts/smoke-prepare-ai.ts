/**
 * PRE-BUILD smoke for prepare-pdf-for-ai (PHASE-2): the pure doc-building
 * logic + docInfo metadata reads. The pdf.js extraction itself is covered
 * by the browser E2E (pdfjs needs the worker DOM shim).
 *
 *  1. buildLlamaDocs per-page: array shape, id stability, metadata
 *     (file_path/page_id/total_pages/format/type + info fields),
 *     JSON round-trip, page-id sequence.
 *  2. buildLlamaDocs document mode: single doc, joined text, no page_id.
 *  3. includeMeta off: no info fields.
 *  4. docInfo: real fixture with Title/Author (pdf-lib), plain PDF, and
 *     a raw crafted /Info with a literal date string.
 *
 * Run: bun scripts/smoke-prepare-ai.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  buildLlamaDocs,
  docInfo,
  type LlamaDoc,
} from "../tools/prepare-pdf-for-ai/worker";

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

/* ------------------------------------------------------------------ */
console.log("1. buildLlamaDocs — per page");

{
  const info = {
    title: "Quarterly Report",
    author: "Deepak",
    subject: "Finance",
    creationDate: "D:20251102000000Z",
    modDate: "D:20251102120000Z",
  };
  const docs = buildLlamaDocs(
    "report.pdf",
    3,
    [
      { pageNumber: 1, text: "Cover page text" },
      { pageNumber: 2, text: "Body text here" },
      { pageNumber: 3, text: "The end" },
    ],
    info,
    { perPage: true, includeMeta: true }
  );

  check("array of 3", Array.isArray(docs) && docs.length === 3);
  check("id stable shape", docs[0]!.id_ === "report_pdf__page_0");
  check("page_id sequence 0,1,2", docs.map((d) => d.metadata.page_id).join(",") === "0,1,2");
  check("file_path", docs[0]!.metadata.file_path === "report.pdf");
  check("total_pages", docs[0]!.metadata.total_pages === 3);
  check("format/type", docs[0]!.metadata.format === "PDF" && docs[0]!.metadata.type === "text");
  check("title rides", docs[0]!.metadata.title === "Quarterly Report");
  check("author rides", docs[0]!.metadata.author === "Deepak");
  check("creation_date", docs[0]!.metadata.creation_date === "D:20251102000000Z");
  check("last_modified", docs[0]!.metadata.last_modified === "D:20251102120000Z");
  check("text carried", docs[1]!.text === "Body text here");

  const json = JSON.stringify(docs, null, 2);
  const parsed = JSON.parse(json) as LlamaDoc[];
  check("JSON round-trip", parsed.length === 3 && parsed[2]!.text === "The end");
}

/* ------------------------------------------------------------------ */
console.log("2. buildLlamaDocs — document mode");

{
  const docs = buildLlamaDocs(
    "doc.pdf",
    2,
    [
      { pageNumber: 1, text: "Part one" },
      { pageNumber: 2, text: "Part two" },
    ],
    { title: "T", author: "A" },
    { perPage: false, includeMeta: true }
  );
  check("single doc", docs.length === 1);
  check("text joined with blank line", docs[0]!.text === "Part one\n\nPart two");
  check("no page_id in doc mode", !("page_id" in docs[0]!.metadata));
  check("total_pages present", docs[0]!.metadata.total_pages === 2);
}

/* ------------------------------------------------------------------ */
console.log("3. includeMeta off");

{
  const docs = buildLlamaDocs(
    "x.pdf",
    1,
    [{ pageNumber: 1, text: "hi" }],
    { title: "Secret", author: "Hidden" },
    { perPage: true, includeMeta: false }
  );
  check("no title/author", !("title" in docs[0]!.metadata) && !("author" in docs[0]!.metadata));
  check("core fields kept", docs[0]!.metadata.file_path === "x.pdf" && docs[0]!.metadata.page_id === 0);
}

/* ------------------------------------------------------------------ */
console.log("4. docInfo — real fixtures");

{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 300]).drawText("P1", { x: 20, y: 150, size: 24, font });
  doc.setTitle("Info Title");
  doc.setAuthor("Info Author");
  const bytes = new Uint8Array(await doc.save());
  const info = docInfo(bytes);
  check("pdf-lib fixture: title", info.title === "Info Title", JSON.stringify(info));
  check("pdf-lib fixture: author", info.author === "Info Author");

  const plain = await PDFDocument.create();
  plain.addPage([200, 300]);
  const plainInfo = docInfo(new Uint8Array(await plain.save()));
  check("plain fixture: no info", plainInfo.title === undefined && plainInfo.author === undefined);

  // Raw crafted /Info with literal date.
  const parts: string[] = ["%PDF-1.7\n"];
  const offs: number[] = [];
  const bodies = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n`,
    `4 0 obj\n<< /Title (Crafted) /CreationDate (D:20250101000000Z) >>\nendobj\n`,
  ];
  for (let n = 1; n <= bodies.length; n += 1) {
    offs[n] = parts.reduce((a, p) => a + p.length, 0);
    parts.push(bodies[n - 1]!);
  }
  const xp = parts.reduce((a, p) => a + p.length, 0);
  parts.push(`xref\n0 5\n0000000000 65535 f \n`);
  for (let n = 1; n <= bodies.length; n += 1) {
    parts.push(`${String(offs[n]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xp}\n%%EOF\n`);
  const crafted = new TextEncoder().encode(parts.join(""));
  const craftedInfo = docInfo(crafted);
  check("crafted: literal title", craftedInfo.title === "Crafted");
  check("crafted: literal date", craftedInfo.creationDate === "D:20250101000000Z");
}

/* ------------------------------------------------------------------ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
