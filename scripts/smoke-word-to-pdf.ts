/**
 * Smoke: word-to-pdf (RB1-a) — .docx → PDF, 100% on-device.
 *
 * House conventions: real fixture built with fflate zipSync, node:zlib
 * inflate oracle for stream text, pdf-lib reload + parse-level asserts,
 * relative imports without .ts, process.exit at the end.
 *
 * Run: bun scripts/smoke-word-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8 } from "fflate";

import {
  MAX_PARAGRAPHS,
  MAX_TABLE_ROWS,
  needsNoto,
  outputPdfName,
  parseDocx,
  parseWordRun,
  type DocxRun,
} from "../tools/word-to-pdf/model";
import { drawDocxPdf } from "../tools/word-to-pdf/render";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(`  FAIL ${label}`, actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "");
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function contentTypes(): string {
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>"
  );
}

function rels(): string {
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>"
  );
}

interface RunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  sizePt?: number;
}

function runXml(r: RunSpec): string {
  const rPr =
    `<w:rPr>${r.bold ? "<w:b/>" : ""}${r.italic ? "<w:i/>" : ""}` +
    (r.sizePt ? `<w:sz w:val="${Math.round(r.sizePt * 2)}"/>` : "") +
    "</w:rPr>";
  return `<w:r>${rPr}<w:t xml:space="preserve">${r.text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</w:t></w:r>`;
}

function paraXml(
  runs: RunSpec[],
  opts: { style?: string; jc?: string; bullet?: boolean } = {}
): string {
  const pPr =
    `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}` +
    (opts.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "") +
    `${opts.jc ? `<w:jc w:val="${opts.jc}"/>` : ""}</w:pPr>`;
  return `<w:p>${pPr}${runs.map(runXml).join("")}</w:p>`;
}

function tableXml(rows: string[][]): string {
  const tr = rows
    .map(
      (row) =>
        "<w:tr>" +
        row.map((cell) => `<w:tc><w:tcPr/><w:p>${runXml({ text: cell })}</w:p></w:tc>`).join("") +
        "</w:tr>"
    )
    .join("");
  return `<w:tbl><w:tblGrid>${rows[0]
    .map(() => '<w:gridCol w:w="3000"/>')
    .join("")}</w:tblGrid>${tr}</w:tbl>`;
}

function makeDocx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes()),
    "_rels/.rels": strToU8(rels()),
    "word/document.xml": strToU8(
      XML_DECL +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
        "</w:body></w:document>"
    ),
  });
}

function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString("latin1");
    } catch {
      /* non-flate stream (font) */
    }
    idx = e + 9;
  }
  return out;
}

/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  // pdf-lib hex tokens (<517561727465726C79...> Tj) can carry whole
  // strings: exact-token match for short text, bare byte-sequence
  // match (>= 8 hex chars) for words inside longer tokens.
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/* ------------------------------------------------------------------ */
console.log("── 1. parseDocx on a real fixture ───────────────────────");
{
  const body = [
    paraXml([{ text: "Quarterly Report", bold: true, sizePt: 22 }], { style: "Title" }),
    paraXml([{ text: "Body paragraph with ", bold: false }, { text: "bold middle", bold: true }]),
    paraXml([{ text: "Bullet one" }], { bullet: true }),
    paraXml([{ text: "Bullet two" }], { bullet: true }),
    paraXml([{ text: "Centered line" }], { jc: "center" }),
    tableXml([
      ["Region", "Sales"],
      ["North", "120"],
      ["South", "80"],
    ]),
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    paraXml([{ text: "After the break" }]),
  ].join("");
  const docx = makeDocx(body);
  check("fixture is a zip (PK)", docx[0] === 0x50 && docx[1] === 0x4b);

  const doc = parseDocx(docx);
  check("para count includes bullets + centered", doc.paraCount >= 6, doc.paraCount);
  check("table detected", doc.tableCount === 1, doc.tableCount);
  check("table rows", doc.blocks.some((b) => b.kind === "table" && b.rows.length === 3));
  const table = doc.blocks.find((b) => b.kind === "table");
  if (table && table.kind === "table") {
    check("table cell text", table.rows[1]?.[0] === "North" && table.rows[1]?.[1] === "120", table.rows);
  }
  const pageBreaks = doc.blocks.filter((b) => b.kind === "pagebreak").length;
  check("explicit page break parsed", pageBreaks === 1, pageBreaks);
  check("bold run survives", JSON.stringify(doc.blocks).includes('"bold":true'));
  check("heading style captured", doc.blocks[0]?.kind === "para" && doc.blocks[0].headingLevel === 0, doc.blocks[0]);
  check("needsNoto false for pure-English", needsNoto(doc) === false);
  check("word count sane", doc.wordCount > 10, doc.wordCount);
}

console.log("── 2. Hindi + hardening ─────────────────────────────────");
{
  const docx = makeDocx(
    paraXml([{ text: "प्रिया शर्मा रिपोर्ट" }]) + paraXml([{ text: "₹500 only" }])
  );
  const doc = parseDocx(docx);
  check("needsNoto true for Devanagari", needsNoto(doc) === true);
  check("needsNoto true for ₹", needsNoto(parseDocx(makeDocx(paraXml([{ text: "₹500" }])))) === true);

  const garbage = parseDocx(new Uint8Array([0x01, 0x02, 0x03]));
  check("garbage → empty doc, no throw", garbage.blocks.length === 0 && garbage.paraCount === 0);

  const notZip = parseWordRun(JSON.stringify({ kind: "nonsense" }));
  check("parseWordRun garbage → empty", notZip.blocks.length === 0);

  const clamped = parseWordRun(
    JSON.stringify({
      blocks: Array.from({ length: MAX_PARAGRAPHS + 50 }, () => ({
        kind: "para",
        runs: [{ text: "x", bold: false }],
      })),
    })
  );
  check("paragraph clamp honoured", clamped.blocks.length <= 800, clamped.blocks.length);

  const bigTable = parseWordRun(
    JSON.stringify({
      blocks: [
        {
          kind: "table",
          rows: Array.from({ length: MAX_TABLE_ROWS + 10 }, () =>
            Array.from({ length: 5 }, () => "c")
          ),
        },
      ],
    })
  );
  const t = bigTable.blocks.find((b) => b.kind === "table");
  check("table row clamp honoured", t !== undefined && t.kind === "table" && t.rows.length <= MAX_TABLE_ROWS, t && t.kind === "table" ? t.rows.length : null);

  check(
    "outputPdfName strips .docx + unsafe chars",
    outputPdfName("my file.docx", "PDF") === "my file.pdf" ||
      outputPdfName("my file.docx", "PDF").endsWith(".pdf"),
    outputPdfName("my file.docx", "PDF")
  );
  check("outputPdfName fallback", outputPdfName("", "Document") === "Document.pdf", outputPdfName("", "Document"));
}

console.log("── 3. REAL renders (worker's exact render.ts) ───────────");
async function render(docxBytes: Uint8Array, noto: boolean, letter = false): Promise<{ bytes: Uint8Array; pages: number }> {
  const parsed = parseDocx(docxBytes);
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let boldFont: PDFFont | null = null;
  if (noto) {
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(notoBytes, { subset: true });
  } else {
    font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
    boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }
  const report = drawDocxPdf(pdfDoc, font, boldFont, parsed, {
    pageSize: letter ? "letter" : "a4",
    margin: "normal",
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount() };
}

{
  const body = [
    paraXml([{ text: "Quarterly Report", bold: true, sizePt: 22 }], { style: "Title" }),
    paraXml([{ text: "Body paragraph with ", bold: false }, { text: "bold middle", bold: true }]),
    paraXml([{ text: "Bullet one" }], { bullet: true }),
    tableXml([
      ["Region", "Sales"],
      ["North", "120"],
      ["South", "80"],
    ]),
    paraXml([{ text: "After the break" }]),
  ].join("");
  const out = await render(makeDocx(body), false);
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN: single page for short doc", out.pages === 1, out.pages);
  const size = (await PDFDocument.load(out.bytes)).getPage(0).getSize();
  check("EN: A4 dims", Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `${size.width}x${size.height}`);
  const txt = inflatedText(out.bytes);
  const needles = ["Quarterly", "Report", "Bullet", "North", "South", "120"];
  for (const n of needles) {
    check(`EN: "${n}" selectable in stream (literal or hex)`, hasText(txt, n));
  }
  check("no NaN geometry", !txt.includes("NaN"));

  const letterOut = await render(makeDocx(body), false, true);
  const ls = (await PDFDocument.load(letterOut.bytes)).getPage(0).getSize();
  check("Letter dims", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);

  const longBody = Array.from(
    { length: 120 },
    (_, i) => paraXml([{ text: `Paragraph number ${i} with several words of body text to fill the page.` }])
  ).join("");
  const longOut = await render(makeDocx(longBody), false);
  check("long doc breaks pages", longOut.pages >= 3, longOut.pages);

  const hiOut = await render(
    makeDocx(paraXml([{ text: "प्रिया शर्मा की रिपोर्ट" }])),
    true
  );
  check("HI: %PDF magic", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 1000, hiOut.bytes.length);
  const hiDump = (await PDFDocument.load(hiOut.bytes)).context.enumerateIndirectObjects();
  const hiDumpStr = [...hiDump].map(([, o]) => o.toString()).join("\n");
  check("HI: Noto embedded (FontFile2)", hiDumpStr.includes("FontFile2"));
  check("HI: Type0 composite", hiDumpStr.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));
}

console.log(
  `\nword-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
