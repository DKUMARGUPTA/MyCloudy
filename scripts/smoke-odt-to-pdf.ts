/**
 * Smoke: odt-to-pdf (RB2-b — the 72nd tool) — OpenDocument → PDF,
 * 100% on-device.
 *
 * House conventions: REAL fixtures built by the tool's own sample
 * builders (fflate zipSync, mimetype first + stored), node:zlib as the
 * UNZIP oracle (NOT fflate — inflateRawSync for the raw-deflate entries
 * fflate writes), real renders through the worker's exact render.ts,
 * parse-level font asserts on reload, relative imports without .ts,
 * process.exit at the end.
 *
 * Run: bun scripts/smoke-odt-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8 } from "fflate";

import {
  buildSampleOds,
  buildSampleOdt,
  estimatePages,
  MAX_PARAGRAPHS,
  needsNoto,
  OdfParseError,
  outputBaseName,
  parseOdt,
  stats,
} from "../tools/odt-to-pdf/model";
import { drawOdfPdf } from "../tools/odt-to-pdf/render";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const OD_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
}

/**
 * node:zlib ZIP oracle — walks the local file headers and inflates
 * every entry itself (fflate writes RAW deflate, hence inflateRawSync).
 */
function readZipWithZlib(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes);
  const out: ZipEntry[] = [];
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      out.push({ name, method, data: raw });
    } else if (method === 8) {
      out.push({ name, method, data: inflateRawSync(raw) });
    } else {
      throw new Error(`unsupported zip method ${method}`);
    }
    off = dataStart + compSize;
  }
  if (out.length === 0) throw new Error("no zip entries parsed");
  return out;
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

import { inflateSync } from "node:zlib";

/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function render(
  odfBytes: Uint8Array,
  noto: boolean,
  opts: { letter?: boolean; narrow?: boolean } = {}
): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = parseOdt(odfBytes);
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
  drawOdfPdf(pdfDoc, font, boldFont, doc, {
    pageSize: opts.letter ? "letter" : "a4",
    margin: opts.narrow ? "narrow" : "normal",
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount() };
}

/** Custom ODT body wrapper (long-doc + rejection vectors). */
function makeOdt(bodyXml: string, mediaType = "application/vnd.oasis.opendocument.text"): Uint8Array {
  return zipSync({
    mimetype: [strToU8(mediaType), { level: 0 }],
    "content.xml": strToU8(
      XML_DECL +
        `<office:document-content ${OD_NS} office:version="1.3">` +
        "<office:body><office:text>" +
        bodyXml +
        "</office:text></office:body>" +
        "</office:document-content>"
    ),
  });
}

/** Custom ODS body wrapper. */
function makeOds(bodyXml: string, mediaType = "application/vnd.oasis.opendocument.spreadsheet"): Uint8Array {
  return zipSync({
    mimetype: [strToU8(mediaType), { level: 0 }],
    "content.xml": strToU8(
      XML_DECL +
        `<office:document-content ${OD_NS} office:version="1.3">` +
        "<office:body><office:spreadsheet>" +
        bodyXml +
        "</office:spreadsheet></office:body>" +
        "</office:document-content>"
    ),
  });
}

function expectCode(label: string, bytes: Uint8Array, code: string): void {
  try {
    parseOdt(bytes);
    check(label, false, "no throw");
  } catch (error) {
    check(
      label,
      error instanceof OdfParseError && error.code === code,
      error instanceof Error ? error.message : error
    );
  }
}

/* ------------------------------------------------------------------ */
console.log("── 1. sample builders + node:zlib ZIP oracle ────────────");
{
  const odt = buildSampleOdt();
  const ods = buildSampleOds();
  check("odt fixture is a zip (PK\\x03\\x04)", odt[0] === 0x50 && odt[1] === 0x4b && odt[2] === 0x03 && odt[3] === 0x04);
  check("ods fixture is a zip (PK\\x03\\x04)", ods[0] === 0x50 && ods[1] === 0x4b && ods[2] === 0x03 && ods[3] === 0x04);

  const odtEntries = readZipWithZlib(odt);
  const first = odtEntries[0];
  check("odt: mimetype is the FIRST entry", first?.name === "mimetype", odtEntries.map((e) => e.name));
  check("odt: mimetype is STORED (method 0)", first?.method === 0, first?.method);
  check(
    "odt: mimetype content",
    first?.data.toString("utf8") === "application/vnd.oasis.opendocument.text",
    first?.data.toString("utf8")
  );
  const odtContent = odtEntries.find((e) => e.name === "content.xml");
  const odtStyles = odtEntries.find((e) => e.name === "styles.xml");
  check(
    "odt: content.xml inflates to office:document-content",
    odtContent !== undefined && odtContent.data.toString("utf8").includes("office:document-content")
  );
  check(
    "odt: styles.xml inflates to office:document-styles",
    odtStyles !== undefined && odtStyles.data.toString("utf8").includes("office:document-styles")
  );
  check(
    "odt: styles.xml carries the bold/italic declarations",
    odtStyles !== undefined &&
      odtStyles.data.toString("utf8").includes('style:name="Bold_20_Span"') &&
      odtStyles.data.toString("utf8").includes('style:name="Italic_20_Span"')
  );

  const odsEntries = readZipWithZlib(ods);
  check(
    "ods: mimetype first + stored + spreadsheet",
    odsEntries[0]?.name === "mimetype" &&
      odsEntries[0]?.method === 0 &&
      odsEntries[0]?.data.toString("utf8") === "application/vnd.oasis.opendocument.spreadsheet",
    odsEntries[0]?.name
  );
  const odsContent = odsEntries.find((e) => e.name === "content.xml");
  check(
    "ods: content.xml inflates with office:spreadsheet body",
    odsContent !== undefined &&
      odsContent.data.toString("utf8").includes("<office:spreadsheet>")
  );
}

console.log("── 2. parseOdt: ODT text fixture ─────────────────────────");
{
  const doc = parseOdt(buildSampleOdt());
  check("kind text", doc.kind === "text");
  if (doc.kind === "text") {
    const blocks = doc.blocks;
    check("first block = heading level 1", blocks[0]?.kind === "heading" && blocks[0].level === 1, blocks[0]);
    check(
      "heading text",
      blocks[0]?.kind === "heading" && blocks[0].runs[0]?.text === "Quarterly Report"
    );
    check("second block = heading level 2", blocks[1]?.kind === "heading" && blocks[1].level === 2, blocks[1]);

    const para = blocks.find((b) => b.kind === "para" && b.runs.some((r) => r.bold));
    check("styled para found", para !== undefined);
    if (para && para.kind === "para") {
      check("bold span run", para.runs.some((r) => r.bold && r.text === "bold middle"), para.runs);
      check("italic span run", para.runs.some((r) => r.italic && r.text === "italic tail"));
      const joined = para.runs.map((r) => r.text).join("");
      check("text:s repeats survive (3 spaces)", joined.includes("plus   gaps"), joined);
      check("text:tab survives", joined.includes("a\ttab."));
    }
    const parented = blocks.find(
      (b) => b.kind === "para" && b.runs.some((r) => r.text === "Parented bold span")
    );
    check(
      "parent-style chain resolves bold",
      parented !== undefined &&
        parented.kind === "para" &&
        parented.runs.some((r) => r.text === "Parented bold span" && r.bold),
      parented && parented.kind === "para" ? parented.runs : null
    );

    const bullets = blocks.filter((b) => b.kind === "list-item");
    check("three list items", bullets.length === 3, bullets.length);
    check(
      "list nesting levels",
      bullets.length === 3 &&
        bullets[0]?.kind === "list-item" && bullets[0].level === 0 &&
        bullets[1]?.kind === "list-item" && bullets[1].level === 1 &&
        bullets[2]?.kind === "list-item" && bullets[2].level === 0,
      bullets.map((b) => (b.kind === "list-item" ? b.level : null))
    );
    check(
      "list item texts",
      bullets[0]?.kind === "list-item" && bullets[0].runs[0]?.text === "Bullet one" &&
        bullets[1]?.kind === "list-item" && bullets[1].runs[0]?.text === "Nested bullet"
    );

    check(
      "section text flows through",
      blocks.some((b) => b.kind === "para" && b.runs.some((r) => r.text === "Section text flows through."))
    );
    check(
      "office:annotation skipped",
      JSON.stringify(blocks).indexOf("secret comment") < 0
    );

    const table = blocks.find((b) => b.kind === "table");
    check("table detected with name", table !== undefined, blocks.map((b) => b.kind));
    if (table && table.kind === "table") {
      check("table header row", table.rows[0]?.[0] === "Region" && table.rows[0]?.[1] === "Sales" && table.rows[0]?.[2] === "Growth", table.rows);
      check(
        "number-columns-repeated expands empty cells",
        table.rows[1]?.length === 4 && table.rows[1]?.[0] === "North" && table.rows[1]?.[1] === "" && table.rows[1]?.[2] === "" && table.rows[1]?.[3] === "120",
        table.rows[1]
      );
    }

    const st = stats(doc);
    check("stats: words counted", st.words > 20, st.words);
    check("stats: not truncated", st.truncated === false);
    check("estimatePages >= 1", estimatePages(doc) >= 1);
    check("needsNoto false for EN", needsNoto(doc) === false);
  }
}

console.log("── 3. parseOdt: ODS spreadsheet fixture ──────────────────");
{
  const doc = parseOdt(buildSampleOds());
  check("kind sheets", doc.kind === "sheets");
  if (doc.kind === "sheets") {
    const sheet = doc.sheets[0];
    check("sheet name", sheet?.name === "Data", doc.sheets.map((s) => s.name));
    check(
      "string + float cells",
      sheet?.grid[0]?.[0] === "Region" && sheet?.grid[1]?.[0] === "North" && sheet?.grid[1]?.[1] === "120.5",
      sheet?.grid[1]
    );
    check(
      "number-columns-repeated repeats content",
      sheet?.grid[1]?.[2] === "x" && sheet?.grid[1]?.[3] === "x",
      sheet?.grid[1]
    );
    check(
      "number-rows-repeated repeats the row",
      sheet?.grid.length === 4 && sheet?.grid[2]?.[0] === "South" && sheet?.grid[3]?.[0] === "South",
      sheet?.grid.length
    );
    const st = stats(doc);
    check("stats: one sheet, 4 rows", st.sheetCount === 1 && st.rowCount === 4, st);
    check("needsNoto false for EN sheets", needsNoto(doc) === false);
  }

  const hi = parseOdt(buildSampleOds({ hindi: true }));
  check("hindi ods: 2 sheets", hi.kind === "sheets" && hi.sheets.length === 2, hi.kind === "sheets" ? hi.sheets.map((s) => s.name) : hi);
  if (hi.kind === "sheets") {
    check("hindi sheet name parsed", hi.sheets[1]?.name === "हिन्दी", hi.sheets[1]?.name);
    check("hindi cell parsed", hi.sheets[1]?.grid[0]?.[0] === "क्षेत्र", hi.sheets[1]?.grid[0]);
  }
  check("needsNoto true for Devanagari sheets", needsNoto(hi) === true);
  check("needsNoto true for Devanagari text", needsNoto(parseOdt(buildSampleOdt({ hindi: true }))) === true);
}

console.log("── 4. caps + estimatePages ───────────────────────────────");
{
  const longBody = Array.from(
    { length: MAX_PARAGRAPHS + 120 },
    (_, i) => `<text:p>Paragraph number ${i} with several words of body text to fill the page.</text:p>`
  ).join("");
  const doc = parseOdt(makeOdt(longBody));
  check("long doc truncated flag", doc.kind === "text" && doc.truncated === true);
  if (doc.kind === "text") {
    check("block cap honoured", doc.blocks.length <= 800, doc.blocks.length);
    check(
      "para cap honoured (500)",
      doc.blocks.filter((b) => b.kind !== "table").length <= MAX_PARAGRAPHS,
      doc.blocks.filter((b) => b.kind !== "table").length
    );
  }
  check("estimatePages scales with length", estimatePages(doc) >= 8, estimatePages(doc));

  const longGrid = Array.from(
    { length: 80 },
    (_, i) => `<table:table-row><table:table-cell office:value-type="string"><text:p>Row ${i}</text:p></table:table-cell></table:table-row>`
  ).join("");
  const wb = parseOdt(makeOds(`<table:table table:name="Big">${longGrid}</table:table>`));
  check("sheet rows under cap", wb.kind === "sheets" && wb.sheets[0]?.grid.length === 80, wb.kind === "sheets" ? wb.sheets[0]?.grid.length : null);
  check("estimatePages for sheets", estimatePages(wb) >= 2, estimatePages(wb));
}

console.log("── 5. outputBaseName vectors ─────────────────────────────");
{
  check("strips .odt", outputBaseName("Report v2.odt", "en") === "Report v2", outputBaseName("Report v2.odt", "en"));
  check("strips .ods", outputBaseName("data.ods", "hi") === "data", outputBaseName("data.ods", "hi"));
  check("fallback EN", outputBaseName("", "en") === "Document", outputBaseName("", "en"));
  check("fallback HI", outputBaseName("", "hi") === "दस्तावेज़", outputBaseName("", "hi"));
  check(
    "unsafe chars sanitized",
    outputBaseName('bad/name?.odt', "en") === "bad_name_",
    outputBaseName('bad/name?.odt', "en")
  );
  check("nameless with extension only", outputBaseName(".odt", "en") === "Document", outputBaseName(".odt", "en"));
}

console.log("── 6. rejection vectors ──────────────────────────────────");
{
  expectCode("non-zip bytes → errNotZip", new Uint8Array([1, 2, 3, 4, 5]), "errNotZip");
  expectCode("plain text → errNotZip", strToU8("hello world, definitely not a zip"), "errNotZip");
  expectCode("empty zip → errNoContent", zipSync({}), "errNoContent");
  expectCode(
    "zip without content.xml → errNoContent",
    zipSync({ "styles.xml": strToU8("<x/>") }),
    "errNoContent"
  );
  expectCode(
    "truncated zip → errCorrupt",
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]),
    "errCorrupt"
  );
  // .odp: honest rejection via mimetype AND via the body element
  expectCode(
    ".odp mimetype → errOdp",
    makeOdt("<text:p>x</text:p>", "application/vnd.oasis.opendocument.presentation"),
    "errOdp"
  );
  expectCode(
    ".odg mimetype → errOdg",
    makeOdt("<text:p>x</text:p>", "application/vnd.oasis.opendocument.graphics"),
    "errOdg"
  );
  expectCode(
    "presentation BODY (text mimetype) → errOdp",
    zipSync({
      mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
      "content.xml": strToU8(
        XML_DECL +
          `<office:document-content ${OD_NS}><office:body><office:presentation><presentation:page/></office:presentation></office:body></office:document-content>`
      ),
    }),
    "errOdp"
  );
  expectCode(
    "drawing BODY (spreadsheet mimetype) → errOdg",
    zipSync({
      mimetype: [strToU8("application/vnd.oasis.opendocument.spreadsheet"), { level: 0 }],
      "content.xml": strToU8(
        XML_DECL +
          `<office:document-content ${OD_NS}><office:body><office:drawing/></office:body></office:document-content>`
      ),
    }),
    "errOdg"
  );
  expectCode(
    "chart body → errNoContent (unsupported kind)",
    zipSync({
      mimetype: [strToU8("application/vnd.oasis.opendocument.chart"), { level: 0 }],
      "content.xml": strToU8(
        XML_DECL +
          `<office:document-content ${OD_NS}><office:body><office:chart/></office:body></office:document-content>`
      ),
    }),
    "errNoContent"
  );
  expectCode("empty text body → errEmpty", makeOdt(""), "errEmpty");
  expectCode("empty spreadsheet body → errEmpty", makeOds(""), "errEmpty");
}

console.log("── 7. REAL renders (worker's exact render.ts) ───────────");
{
  const out = await render(buildSampleOdt(), false);
  check("EN ODT: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN ODT: single page for the sample", out.pages === 1, out.pages);
  const reloaded = await PDFDocument.load(out.bytes);
  const size = reloaded.getPage(0).getSize();
  check("EN ODT: A4 dims", Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `${size.width}x${size.height}`);
  const dump = [...reloaded.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("EN ODT: Helvetica, no embedded font", dump.includes("Helvetica") && !dump.includes("FontFile2"));
  const txt = inflatedText(out.bytes);
  const needles = [
    "Quarterly Report",
    "Summary",
    "bold middle",
    "italic tail",
    "Parented bold span",
    "Bullet one",
    "Nested bullet",
    "Section text",
    "Region",
    "North",
    "120",
    "After the table",
  ];
  for (const n of needles) {
    check(`EN ODT: "${n}" selectable in stream (literal or hex)`, hasText(txt, n));
  }
  check("EN ODT: annotation text never drawn", !hasText(txt, "secret comment"));
  check("EN ODT: no NaN geometry", !txt.includes("NaN"));

  const letterOut = await render(buildSampleOdt(), false, { letter: true });
  const ls = (await PDFDocument.load(letterOut.bytes)).getPage(0).getSize();
  check("EN ODT: Letter dims 612x792", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);

  const narrowOut = await render(buildSampleOdt(), false, { narrow: true });
  check("EN ODT: narrow margins render", narrowOut.pages === 1 && narrowOut.bytes[0] === 0x25);

  const longBody = Array.from(
    { length: 150 },
    (_, i) => `<text:p>Paragraph number ${i} with several words of body text to fill the page and force real pagination.</text:p>`
  ).join("");
  const longOut = await render(makeOdt(longBody), false);
  check("EN ODT: long doc breaks pages", longOut.pages >= 4, longOut.pages);

  const hiOut = await render(buildSampleOdt({ hindi: true }), true);
  check("HI ODT: %PDF magic", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 1000, hiOut.bytes.length);
  const hiReloaded = await PDFDocument.load(hiOut.bytes);
  const hiDump = [...hiReloaded.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("HI ODT: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI ODT: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI ODT: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));

  const odsOut = await render(buildSampleOds(), false);
  check("EN ODS: %PDF magic + size", odsOut.bytes[0] === 0x25 && odsOut.bytes.length > 1000, odsOut.bytes.length);
  check("EN ODS: single page for the sample grid", odsOut.pages === 1, odsOut.pages);
  const odsReloaded = await PDFDocument.load(odsOut.bytes);
  const odsDump = [...odsReloaded.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("EN ODS: Helvetica, no embedded font", odsDump.includes("Helvetica") && !odsDump.includes("FontFile2"));
  const odsTxt = inflatedText(odsOut.bytes);
  for (const n of ["Data", "Region", "Sales", "North", "120.5", "South", "row copy"]) {
    check(`EN ODS: "${n}" selectable in stream`, hasText(odsTxt, n));
  }
  check("EN ODS: no NaN", !odsTxt.includes("NaN"));

  const hiOds = await render(buildSampleOds({ hindi: true }), true);
  const hiOdsReloaded = await PDFDocument.load(hiOds.bytes);
  const hiOdsDump = [...hiOdsReloaded.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("HI ODS: Noto embedded (FontFile2)", hiOdsDump.includes("FontFile2"));
  check("HI ODS: Identity-H", hiOdsDump.includes("Identity-H"));
  check("HI ODS: grid page renders", hiOds.pages === 2, hiOds.pages);

  const gridBody =
    "<table:table-row>" +
    '<table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>' +
    '<table:table-cell office:value-type="string"><text:p>Value</text:p></table:table-cell>' +
    "</table:table-row>" +
    Array.from(
      { length: 60 },
      (_, i) =>
        "<table:table-row>" +
        `<table:table-cell office:value-type="string"><text:p>North ${i}</text:p></table:table-cell>` +
        `<table:table-cell office:value-type="float" office:value="${(i + 1) * 7}"><text:p>${(i + 1) * 7}</text:p></table:table-cell>` +
        "</table:table-row>"
    ).join("");
  const bigOds = await render(makeOds(`<table:table table:name="Big">${gridBody}</table:table>`), false);
  check("EN ODS: 61 rows break pages", bigOds.pages >= 2, bigOds.pages);
  check("EN ODS: big grid no NaN", !inflatedText(bigOds.bytes).includes("NaN"));
}

console.log(
  `\nodt-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
