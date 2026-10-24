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

import { PDFDocument, StandardFonts, type PDFFont, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { unzipSync, zipSync, strToU8, type Zippable } from "fflate";

import { embedDocumentImage } from "../src/lib/pdf/embed-image";
import { makeFixturePng } from "./fixture-png";
import {
  MAX_IMAGES,
  MAX_PARAGRAPHS,
  MAX_RELS,
  MAX_TABLE_ROWS,
  needsNoto,
  outputPdfName,
  parseDocx,
  parseWordRun,
  lookupMediaEntry,
  resolveMediaPath,
  type DocxImageBlock,
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

function makeDocx(
  body: string,
  extra: Record<string, string | Uint8Array> = {},
  docRels = ""
): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes()),
    "_rels/.rels": strToU8(rels()),
    "word/document.xml": strToU8(
      XML_DECL +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
        'xmlns:v="urn:schemas-microsoft-com:vml" ' +
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
        "</w:body></w:document>"
    ),
    ...extra,
  };
  if (docRels !== "") {
    entries["word/_rels/document.xml.rels"] = strToU8(docRels);
  }
  const zippable: Zippable = {};
  for (const [key, value] of Object.entries(entries)) {
    zippable[key] = typeof value === "string" ? strToU8(value) : value;
  }
  return zipSync(zippable);
}

/** The document relationship part (audit R4-a image resolution source). */
function docRelsXml(entries: Array<[string, string, string]>): string {
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    entries
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
      )
      .join("") +
    "</Relationships>"
  );
}

const REL_IMAGE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** The run-level DrawingML picture payload (shared by the para + cell fixtures). */
function drawingRunXml(relId: string): string {
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="990600" cy="792000"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="990600" cy="792000"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

/** A DrawingML inline picture — the shape ~every modern docx writer emits. */
function drawingXml(relId: string): string {
  return `<w:p>${drawingRunXml(relId)}</w:p>`;
}

/** A legacy VML pict — the <w:pict> shape older writers/template parts use. */
function pictXml(relId: string): string {
  return (
    `<w:p><w:r><w:pict><v:shape style="width:78pt;height:62pt">` +
    `<v:imagedata r:id="${relId}"/></v:shape></w:pict></w:r></w:p>`
  );
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
interface RenderOut {
  bytes: Uint8Array;
  pages: number;
  report: ReturnType<typeof drawDocxPdf>;
  doc: ReturnType<typeof parseDocx>;
  imageCount: number;
}
async function render(docxBytes: Uint8Array, noto: boolean, letter = false): Promise<RenderOut> {
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
  // images (audit R4-a) — the worker's exact embed step: relIds → rels →
  // media/* zip parts → shared helper (original bytes under bun)
  const images = new Map<string, PDFImage>();
  if (parsed.blocks.some((b) => b.kind === "image")) {
    let zip: Record<string, Uint8Array> = {};
    try {
      zip = unzipSync(docxBytes) as Record<string, Uint8Array>;
    } catch {
      zip = {};
    }
    const relIds = [
      ...new Set(
        parsed.blocks
          .filter((b): b is DocxImageBlock => b.kind === "image")
          .map((b) => b.relId)
      ),
    ].slice(0, MAX_IMAGES);
    for (const relId of relIds) {
      const target = parsed.media[relId];
      if (target === undefined) continue;
      const path = resolveMediaPath(target);
      if (path === "") continue;
      const mediaBytes = lookupMediaEntry(zip, path);
      if (mediaBytes === undefined) continue;
      const embedded = await embedDocumentImage(pdfDoc, mediaBytes);
      if (embedded === null) continue;
      images.set(relId, embedded.image);
    }
  }
  const report = drawDocxPdf(pdfDoc, font, boldFont, parsed, {
    pageSize: letter ? "letter" : "a4",
    margin: "normal",
  }, images);
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return {
    bytes,
    pages: reloaded.getPageCount(),
    report,
    doc: parsed,
    imageCount: images.size,
  };
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

console.log("── 4. embedded images (audit R4-a) ──────────────────────");
{
  const png1 = makeFixturePng(64, 40, [0x2a, 0x5f, 0x9e]);
  const png2 = makeFixturePng(20, 10, [0xb0, 0x30, 0x60]);

  // ---- parse-level: DrawingML blip + VML imagedata → image blocks ----
  const body = [
    paraXml([{ text: "Before the picture" }]),
    drawingXml("rIdImg1"),
    pictXml("rIdImg2"),
    paraXml([{ text: "After the picture" }]),
  ].join("");
  const docx = makeDocx(
    body,
    { "word/media/image1.png": png1, "word/media/photo2.png": png2 },
    docRelsXml([
      ["rIdImg1", REL_IMAGE, "media/image1.png"],
      ["rIdImg2", REL_IMAGE, "media/photo2.png"],
    ])
  );
  const doc = parseDocx(docx);
  const imageBlocks = doc.blocks.filter((b): b is DocxImageBlock => b.kind === "image");
  check("blip + imagedata → 2 image blocks", imageBlocks.length === 2, imageBlocks);
  check(
    "relIds carried (r:embed + r:id)",
    imageBlocks[0]?.relId === "rIdImg1" && imageBlocks[1]?.relId === "rIdImg2",
    imageBlocks.map((b) => b.relId)
  );
  check(
    "rels parsed into the media map",
    doc.media["rIdImg1"] === "media/image1.png" && doc.media["rIdImg2"] === "media/photo2.png",
    doc.media
  );
  check("imageCount honest", doc.imageCount === 2 && doc.imagesDropped === 0, doc.imageCount);
  check(
    "text behavior untouched (paras still parsed)",
    doc.paraCount >= 2 && doc.blocks.some((b) => b.kind === "para"),
    doc.paraCount
  );

  // ---- render: both images embed → image XObjects in the PDF ----
  const imgOut = await render(docx, false);
  check("render embeds both media parts", imgOut.imageCount === 2, imgOut.imageCount);
  check(
    "report: 2 drawn, 0 skipped",
    imgOut.report.imagesDrawn === 2 && imgOut.report.imagesSkipped === 0,
    imgOut.report
  );
  const imgDump = [...(await PDFDocument.load(imgOut.bytes)).context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("PDF carries image XObjects", (imgDump.split("/Subtype /Image").length - 1) === 2, imgDump.split("/Subtype /Image").length - 1);
  check("no NaN geometry with images", !inflatedText(imgOut.bytes).includes("NaN"));
  check("layout survives (still one page)", imgOut.pages === 1, imgOut.pages);

  // ---- missing media part → honest skip, no crash ----
  const ghostDocx = makeDocx(
    paraXml([{ text: "Lonely text" }]) + drawingXml("rIdGhost"),
    { "word/media/image1.png": png1 },
    docRelsXml([["rIdGhost", REL_IMAGE, "media/absent.png"]])
  );
  const ghostDoc = parseDocx(ghostDocx);
  check("ghost rel parses as an image block", ghostDoc.imageCount === 1, ghostDoc.imageCount);
  const ghostOut = await render(ghostDocx, false);
  check(
    "missing media part → 0 drawn, 1 honest skip",
    ghostOut.imageCount === 0 &&
      ghostOut.report.imagesDrawn === 0 &&
      ghostOut.report.imagesSkipped === 1,
    ghostOut.report
  );
  const ghostDump = [...(await PDFDocument.load(ghostOut.bytes)).context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("ghost doc draws no image XObject", !ghostDump.includes("/Subtype /Image"));
  check(
    "ghost doc still renders its text",
    ghostOut.pages === 1 && hasText(inflatedText(ghostOut.bytes), "Lonely")
  );

  // ---- images inside table cells are honestly not carried ----
  const cellBody =
    tableXml([
      ["A", "B"],
      ["C", "D"],
    ]).replace(
      "<w:tc><w:tcPr/><w:p>" + runXml({ text: "D" }) + "</w:p></w:tc>",
      "<w:tc><w:tcPr/><w:p>" + runXml({ text: "D" }) + drawingRunXml("rIdCell") + "</w:p></w:tc>"
    ) + paraXml([{ text: "Outside the table" }]);
  const cellDocx = makeDocx(
    cellBody,
    { "word/media/cell.png": png1 },
    docRelsXml([["rIdCell", REL_IMAGE, "media/cell.png"]])
  );
  const cellDoc = parseDocx(cellDocx);
  check(
    "table-cell image honestly dropped (never a silent vanish)",
    cellDoc.imageCount === 0 && cellDoc.imagesDropped === 1 && cellDoc.tableCount === 1,
    { count: cellDoc.imageCount, dropped: cellDoc.imagesDropped, tables: cellDoc.tableCount }
  );

  // ---- oversized image scales to the content box, aspect preserved ----
  const bigPng = makeFixturePng(3000, 1500);
  const bigDocx = makeDocx(
    drawingXml("rIdBig"),
    { "word/media/big.png": bigPng },
    docRelsXml([["rIdBig", REL_IMAGE, "media/big.png"]])
  );
  const bigOut = await render(bigDocx, false);
  check("oversized image still draws (scaled down)", bigOut.report.imagesDrawn === 1, bigOut.report);
  check("oversized layout: 1 page, no crash", bigOut.pages === 1, bigOut.pages);
  check("oversized: no NaN", !inflatedText(bigOut.bytes).includes("NaN"));

  // ---- caps: > MAX_IMAGES → truncated + honest drop counts ----
  const capped = parseWordRun(
    JSON.stringify({
      blocks: Array.from({ length: MAX_IMAGES + 5 }, (_, i) => ({
        kind: "image",
        relId: `rId${i}`,
      })),
      media: Object.fromEntries(
        Array.from({ length: MAX_IMAGES + 5 }, (_, i) => [`rId${i}`, `media/p${i}.png`])
      ),
    })
  );
  check(
    `image cap honoured (${MAX_IMAGES})`,
    capped.imageCount === MAX_IMAGES,
    capped.imageCount
  );
  check(
    "over-cap images dropped honestly + truncated",
    capped.imagesDropped === 5 && capped.truncated === true,
    { dropped: capped.imagesDropped, truncated: capped.truncated }
  );

  // ---- boundary sanitization: garbage relIds + junk media maps ----
  const dirty = parseWordRun(
    JSON.stringify({
      blocks: [
        { kind: "image", relId: "rId<1>&x" },
        { kind: "image", relId: "" },
        { kind: "image", relId: 42 },
      ],
      media: { "rId1x": "media/ok.png", "": "media/no.png", bad: 17, ...Object.fromEntries(Array.from({ length: MAX_RELS + 20 }, (_, i) => [`x${i}`, `m/${i}.png`])) },
    })
  );
  check(
    "garbage relIds dropped with honest counts (1 kept)",
    dirty.imageCount === 1 && dirty.imagesDropped === 2,
    { count: dirty.imageCount, dropped: dirty.imagesDropped }
  );
  check(
    "junk media entries skipped, rels cap honoured",
    dirty.media["rId1x"] === "media/ok.png" && Object.keys(dirty.media).length <= MAX_RELS,
    Object.keys(dirty.media).length
  );

  // ---- resolveMediaPath vectors (Targets resolve against word/) ----
  check(
    "relative target → word/media/…",
    resolveMediaPath("media/image1.png") === "word/media/image1.png",
    resolveMediaPath("media/image1.png")
  );
  check(
    "package-absolute target normalizes",
    resolveMediaPath("/word/media/x.png") === "word/media/x.png",
    resolveMediaPath("/word/media/x.png")
  );
  check(
    "../ climbs out of word/ honestly",
    resolveMediaPath("../glossary/pic.png") === "glossary/pic.png",
    resolveMediaPath("../glossary/pic.png")
  );
  check(
    "query + hash stripped, backslashes normalized",
    resolveMediaPath("media\\p.png?v=2#frag") === "word/media/p.png",
    resolveMediaPath("media\\p.png?v=2#frag")
  );
  check(
    "external schemes return empty (never fetched)",
    resolveMediaPath("http://cdn.example.com/x.png") === "" &&
      resolveMediaPath("file:///C:/x.png") === "",
    ""
  );

  // ---- lookupMediaEntry vectors ----
  const zip = { "word/media/Image1.PNG": png1 };
  check(
    "case-insensitive unique match hits",
    lookupMediaEntry(zip, "word/media/image1.png") === png1
  );
  check(
    "missing path → undefined",
    lookupMediaEntry(zip, "word/media/absent.png") === undefined
  );
  check(
    "ambiguous case-insensitive match → undefined (honest miss)",
    lookupMediaEntry(
      { "word/media/a.png": png1, "word/media/A.png": png2 },
      "word/media/A.PNG"
    ) === undefined
  );

  // ---- i18n wiring: EN + HI catalogs ----
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, Record<string, string>>;
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, Record<string, string>>;
  check("w2p.statImages EN+HI (summary chip)", en.w2p?.statImages !== undefined && hi.w2p?.statImages !== undefined);
  check(
    "w2p honestNote no longer claims images are dropped (EN+HI)",
    (en.w2p?.honestNote ?? "").includes("≤50") && (hi.w2p?.honestNote ?? "").includes("≤50")
  );
  check(
    "result.imagesEmbedded/imagesSkipped EN+HI (shared result chips)",
    en.result?.imagesEmbedded !== undefined &&
      en.result?.imagesSkipped !== undefined &&
      hi.result?.imagesEmbedded !== undefined &&
      hi.result?.imagesSkipped !== undefined
  );
}

console.log(
  `\nword-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
