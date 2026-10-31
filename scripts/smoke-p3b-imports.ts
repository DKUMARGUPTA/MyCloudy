/**
 * Smoke: P3-b import pack (R56) — csv-to-pdf, json-to-pdf, xml-to-pdf.
 *
 *   0. Wiring: registry counts 130 total / 129 live / 1 deferred AI
 *      (translate only); the three new defs are enabled convert-to
 *      (accepts text); configs + seo entries present; error keys used
 *      by the workers all exist in BOTH catalogs (no new i18n keys).
 *   1. CSV engine (PURE, tools/csv-to-pdf/worker-lib): full RFC 4180
 *      parse (quoted commas, embedded line breaks, doubled quotes,
 *      CRLF/LF/CR ends, no trailing newline, no phantom last row),
 *      delimiter sniffing (comma vs semicolon vs tab + single-column
 *      fallback), honest clamps (100 cols / 2000 rows, reported).
 *   2. JSON engine (PURE, tools/json-to-pdf/worker-lib): six shapes
 *      (records union keys, matrix, values, object kv, scalar, mixed),
 *      cell conventions (null → "", nested → compact JSON), NDJSON
 *      fallback (≥2 lines) and honest corrupt refusal.
 *   3. XML engine (PURE, tools/xml-to-pdf/worker-lib): record-parent
 *      detection (root repetition, deeper nesting wins, sitemap/RSS
 *      cases), @attribute columns, text-only records, compact XML
 *      serialization (escaping), leaf-path fallback, namespaces via
 *      the e-invoice parser, honest clamps.
 *   4. Render integration: drawDataTablesPdf on the OWN engine —
 *      pdf-lib reload oracle (page count), page-break + repeated
 *      header on a long table, two tables → one page each, Devanagari
 *      content through the embedded Noto subset, zebra + landscape.
 *   5. Worker sources: no network calls, honest refusals present
 *      (errorNoFile / errorCorrupt / errorGeneric), RFC parse imports.
 *
 * Run: bun scripts/smoke-p3b-imports.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { ALL_TOOLS } from "../src/lib/tools/registry";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { getToolSeo } from "../src/lib/seo/tool-seo";
import { CreateContext, type StampFontKey } from "../src/lib/own/pdf";
import type { ConvertFace } from "../tools/convert-common/face";
import {
  drawDataTablesPdf,
  tablesNeedNoto,
  type DataTable,
} from "../tools/data-table-common/render";
import {
  CSV_MAX_COLS,
  CSV_MAX_ROWS,
  csvBaseName,
  csvGrid,
  parseCsvDocument,
  sniffDelimiter,
} from "../tools/csv-to-pdf/worker-lib";
import {
  jsonBaseName,
  jsonCell,
  jsonToTable,
  parseJsonDocument,
  parseNdjson,
} from "../tools/json-to-pdf/worker-lib";
import { parseXml } from "../tools/xml-invoice-to-pdf/xml";
import {
  XML_MAX_COLS,
  XML_MAX_ROWS,
  findRecordParent,
  nodeToCompactXml,
  xmlBaseName,
  xmlToTable,
} from "../tools/xml-to-pdf/worker-lib";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const enc = new TextEncoder();

console.log("── 0. Wiring ────────────────────────────────────────────");
{
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 130 total / 129 live / 1 deferred AI (translate)",
    ALL_TOOLS.length === 130 && live === 129 && deferred.join(",") === "translate-pdf",
    { total: ALL_TOOLS.length, live, deferred },
  );

  for (const id of ["csv-to-pdf", "json-to-pdf", "xml-to-pdf"]) {
    const def = ALL_TOOLS.find((t) => t.id === id);
    check(`${id}: registry def enabled convert-to accepts text`,
      def !== undefined && def.enabled && def.category === "convert-to" && def.accepts === "text");
    check(`${id}: config wired`, (TOOL_CONFIGS as Record<string, unknown>)[id] !== undefined);
    check(`${id}: seo entry`, getToolSeo(id) !== undefined);
    check(`${id}: worker file exists`, readFileSync(join(root, "tools", id, "worker.ts"), "utf8").length > 0);
  }

  // Error keys used by the workers must already exist in both catalogs.
  const en = JSON.parse(read("src/i18n/en.json")) as { tool?: Record<string, unknown> };
  const hi = JSON.parse(read("src/i18n/hi.json")) as { tool?: Record<string, unknown> };
  for (const key of ["errorNoFile", "errorCorrupt", "errorGeneric"]) {
    check(`i18n tool.${key} en+hi`, en.tool?.[key] !== undefined && hi.tool?.[key] !== undefined);
  }
}

console.log("── 1. CSV engine ────────────────────────────────────────");
{
  // RFC 4180: quoted comma, embedded newline, doubled quote
  const doc = 'name,note\r\n"Sharma, R","line one\nline two"\r\nPriya,"say ""hi"""';
  const rows = parseCsvDocument(doc, ",");
  check("quoted comma stays one field", rows[1]?.[0] === "Sharma, R", JSON.stringify(rows[1]));
  check("embedded newline stays in the cell", rows[1]?.[1] === "line one\nline two");
  check("doubled quote decodes to one", rows[2]?.[1] === 'say "hi"', JSON.stringify(rows[2]));
  check("three rows total", rows.length === 3, String(rows.length));

  // line ends: CRLF, LF, CR, no trailing newline
  check("LF ends", parseCsvDocument("a,b\nc,d", ",").length === 2);
  check("lone CR ends", parseCsvDocument("a,b\rc,d", ",").length === 2);
  check("no trailing newline", parseCsvDocument("a,b", ",")[0]?.length === 2);
  check("empty document → zero rows", parseCsvDocument("", ",").length === 0);
  check("trailing CRLF spawns no phantom row", parseCsvDocument("a,b\r\n", ",").length === 1);
  check("blank line INSIDE is kept", parseCsvDocument("a,b\r\n\r\nc,d", ",").length === 3);

  // ragged grids survive
  const ragged = parseCsvDocument("a,b,c\n1\nx,y", ",");
  check("ragged rows survive", ragged.length === 3 && ragged[1]?.length === 1 && ragged[2]?.length === 2);

  // sniffing
  check("sniff comma", sniffDelimiter("a,b,c\n1,2,3\n4,5,6") === ",");
  check("sniff semicolon", sniffDelimiter("a;b;c\n1;2;3\n4;5;6") === ";");
  check("sniff tab", sniffDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6") === "\t");
  check("sniff single column → comma fallback", sniffDelimiter("just one column of text") === ",");
  check("sniff ignores quoted delimiters", sniffDelimiter('"a,b",c\n"x;y",z') === ",");

  // clamps
  const wide = Array.from({ length: CSV_MAX_COLS + 7 }, (_, i) => `c${i}`).join(",");
  const gridWide = csvGrid(`h\n${wide}`, ",", false);
  check("column clamp reported", gridWide.colsDropped === 7 && gridWide.rows[1]?.length === CSV_MAX_COLS, `dropped=${gridWide.colsDropped} kept=${gridWide.rows[1]?.length}`);
  const longBody = Array.from({ length: CSV_MAX_ROWS + 3 }, (_, i) => `r${i}`).join("\n");
  const gridLong = csvGrid(longBody, ",", false);
  check("row clamp reported", gridLong.rowsDropped === 3 && gridLong.rows.length === CSV_MAX_ROWS);

  // header split
  const gridHead = csvGrid("Region,Sales\nNorth,120\nSouth,80", ",", true);
  check("header row split", gridHead.header.join("|") === "Region|Sales" && gridHead.rows.length === 2);
  const gridNoHead = csvGrid("a,b\nc,d", ",", false);
  check("header-less keeps all rows", gridNoHead.header.length === 0 && gridNoHead.rows.length === 2);

  // naming
  check("csvBaseName strips path + ext", csvBaseName("/tmp/sales-report.csv") === "sales-report");
  check("csvBaseName fallback", csvBaseName("") === "csv-data");
}

console.log("── 2. JSON engine ───────────────────────────────────────");
{
  // records: union of keys in first-seen order, missing → empty
  const records = [
    { id: 1, name: "Anaya", city: "Pune" },
    { id: 2, name: "Vikram" },
    { id: 3, name: "Zoya", city: "Delhi", vip: true },
  ];
  const rec = jsonToTable(records, "users");
  check("records shape detected", rec.shape === "records");
  check("union keys first-seen order", rec.table.header.join("|") === "id|name|city|vip", rec.table.header.join("|"));
  check("missing field → empty cell", rec.table.rows[1]?.[2] === "" && rec.table.rows[1]?.[3] === "");
  check("boolean cell text", rec.table.rows[2]?.[3] === "true");
  check("all rows present", rec.table.rows.length === 3);

  // matrix
  const mat = jsonToTable([[1, 2], [3, 4, 5]], "grid");
  check("matrix shape", mat.shape === "matrix" && mat.table.rows[1]?.join("|") === "3|4|5");

  // values
  const vals = jsonToTable(["alpha", "beta", "gamma"], "list");
  check("values shape single column", vals.shape === "values" && vals.table.rows.every((r) => r.length === 1) && vals.table.rows.length === 3);

  // object kv
  const kv = jsonToTable({ host: "localhost", port: 5432, debug: false }, "cfg");
  check("object shape Key/Value", kv.shape === "object" && kv.table.header.join("|") === "Key|Value" && kv.table.rows[1]?.[1] === "5432");

  // scalar
  const sc = jsonToTable(42, "answer");
  check("scalar shape single cell", sc.shape === "scalar" && sc.table.rows[0]?.[0] === "42");

  // mixed array → values
  const mixed = jsonToTable([1, "two", { three: 3 }], "mixed");
  check("mixed array falls to values", mixed.shape === "values" && mixed.table.rows[2]?.[0] === '{"three":3}');

  // cell conventions
  check("null cell → empty", jsonCell(null) === "");
  check("nested object → compact JSON", jsonCell({ a: [1, 2] }) === '{"a":[1,2]}');
  check("nested array → compact JSON", jsonCell([1, "x"]) === '[1,"x"]');

  // NDJSON
  const nd = parseNdjson('{"id":1}\n{"id":2}\n\n{"id":3}');
  check("ndjson parses with blanks skipped", nd !== null && nd.length === 3);
  check("ndjson single line → 1-value array (doc-level needs ≥2)", (() => {
    const one = parseNdjson('{"id":1}');
    return Array.isArray(one) && one.length === 1;
  })());
  check("ndjson broken line rejected", parseNdjson('{"id":1}\n{oops}') === null);

  // whole-document parse
  const strict = parseJsonDocument('{"a":1}');
  check("strict JSON parse", strict !== null && !strict.ndjson && (strict.value as { a: number }).a === 1);
  const ndDoc = parseJsonDocument('{"id":1}\n{"id":2}');
  check("document falls back to NDJSON", ndDoc !== null && ndDoc.ndjson && Array.isArray(ndDoc.value) && ndDoc.value.length === 2);
  check("corrupt document → null", parseJsonDocument("{oops}") === null);
  check("one broken ndjson line → null (honest)", parseJsonDocument('{"id":1}\n{"id":2}\n{oops}') === null);

  // clamps
  const big = Array.from({ length: 2005 }, (_, i) => ({ n: i }));
  const bigTable = jsonToTable(big, "big");
  check("json row clamp reported", bigTable.rowsDropped === 5 && bigTable.table.rows.length === 2000);

  check("jsonBaseName strips path + ext", jsonBaseName("/x/api-export.json") === "api-export");
}

console.log("── 3. XML engine ───────────────────────────────────────");
{
  // records at root + @attr columns + child columns
  const feedXml =
    `<catalog>` +
    `<product sku="P1" stock="12"><name>Chai</name><price>42.50</price></product>` +
    `<product sku="P2"><name>Biroti</name><price>20</price><tag>new</tag></product>` +
    `<product sku="P3" stock="0"><name>Haldi</name></product>` +
    `</catalog>`;
  const root3 = parseXml(enc.encode(feedXml));
  const found = findRecordParent(root3);
  check("record parent found at root", found !== null && found.name === "product" && found.records.length === 3);

  const table = xmlToTable(root3, "catalog", true);
  check("records mode", table.mode === "records" && table.recordName === "product");
  check(
    "columns: @attrs first then children (first-seen union)",
    table.table.header.join("|") === "@sku|@stock|name|price|tag",
    table.table.header.join("|"),
  );
  check("attr cell values", table.table.rows[0]?.[0] === "P1" && table.table.rows[0]?.[1] === "12");
  check("missing attr → empty", table.table.rows[1]?.[1] === "");
  check("missing child → empty", table.table.rows[2]?.[3] === "");
  check("three rows", table.table.rows.length === 3);

  // attributes off → only child columns
  const noAttrs = xmlToTable(root3, "catalog", false);
  check("attributes off drops @cols", noAttrs.table.header.every((h) => !h.startsWith("@")) && noAttrs.table.header.includes("name"));

  // deeper nesting wins (RSS shape)
  const rssXml =
    `<rss><channel><title>News</title><link>https://x</link>` +
    `<item><title>One</title><pubDate>Mon</pubDate></item>` +
    `<item><title>Two</title></item>` +
    `</channel></rss>`;
  const rss = xmlToTable(parseXml(enc.encode(rssXml)), "feed", false);
  check("RSS: records are the repeated items", rss.mode === "records" && rss.recordName === "item");
  check("RSS: title column from children", rss.table.header.includes("title") && rss.table.rows[0]?.[0] === "One");

  // sitemap shape (namespaced)
  const smXml =
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<url><loc>https://a</loc><lastmod>2026-01-01</lastmod></url>` +
    `<url><loc>https://b</loc></url>` +
    `</urlset>`;
  const sm = xmlToTable(parseXml(enc.encode(smXml)), "sitemap", false);
  check("sitemap: url records despite default namespace", sm.mode === "records" && sm.recordName === "url");
  check("sitemap: loc column values", sm.table.rows[1]?.[0] === "https://b");

  // text-only records → own name as single column
  const tagsXml = `<tags><t>alpha</t><t>beta</t></tags>`;
  const tags = xmlToTable(parseXml(enc.encode(tagsXml)), "tags", false);
  check("text-only records use element name", tags.table.header.join("|") === "t" && tags.table.rows[0]?.[0] === "alpha");

  // no repetition → leaf fallback
  const cfgXml = `<settings><server><host>localhost</host><port>8080</port></server><debug>true</debug></settings>`;
  const cfg = xmlToTable(parseXml(enc.encode(cfgXml)), "settings", false);
  check("config: leaves fallback", cfg.mode === "leaves" && cfg.table.header.join("|") === "Path|Value");
  check(
    "config: leaf paths",
    cfg.table.rows.some((r) => r[0] === "settings/server/host" && r[1] === "localhost") &&
      cfg.table.rows.some((r) => r[0] === "settings/debug" && r[1] === "true"),
    JSON.stringify(cfg.table.rows),
  );

  // compact XML serialization + entity decoding
  const nestedRoot = parseXml(enc.encode(`<n a="1">&lt;x&gt;</n>`));
  const nested = nestedRoot.children.length === 0 ? nestedRoot : nestedRoot;
  check("entity decoded text", nested.text === "<x>");
  const compactNode = parseXml(enc.encode(`<wrap a="1"><k>v</k></wrap>`));
  check("compact XML serialization", nodeToCompactXml(compactNode) === `<wrap a="1"><k>v</k></wrap>`, nodeToCompactXml(compactNode));
  const escNode = parseXml(enc.encode(`<w q='say "hi"'>&amp;</w>`));
  check("compact XML escapes attrs", nodeToCompactXml(escNode) === `<w q="say &quot;hi&quot;">&amp;</w>`, nodeToCompactXml(escNode));

  // CDATA + comments + prolog tolerated
  const messy = `<?xml version="1.0"?><!-- hi --><r><v><![CDATA[a<b]]></v></r>`;
  check("prolog + comment + CDATA parse", (() => {
    const r = parseXml(enc.encode(messy));
    return r.name === "r" && r.children[0]?.text === "a<b";
  })());

  // malformed → honest throw
  let threw = false;
  try {
    parseXml(enc.encode("<a><b></a>"));
  } catch {
    threw = true;
  }
  check("malformed XML throws", threw);

  // clamps
  const many = `<r>${Array.from({ length: XML_MAX_ROWS + 2 }, (_, i) => `<e>v${i}</e>`).join("")}</r>`;
  const manyTable = xmlToTable(parseXml(enc.encode(many)), "many", false);
  check("xml row clamp reported", manyTable.rowsDropped === 2 && manyTable.table.rows.length === XML_MAX_ROWS);
  check("clamp constants aligned", XML_MAX_COLS === 100 && XML_MAX_ROWS === 2000);

  check("xmlBaseName strips path + ext", xmlBaseName("/tmp/feed.xml") === "feed");
}

console.log("── 4. Render integration (OWN engine + pdf-lib oracle) ──");
{
  const notoBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );

  const render = async (
    tables: DataTable[],
    noto: boolean,
    landscape = false
  ): Promise<{ bytes: Uint8Array; pages: number }> => {
    const pdfDoc = CreateContext.create();
    let font: ConvertFace;
    let boldKey: StampFontKey | null = null;
    if (noto) {
      font = { ttf: pdfDoc.embedTtf(notoBytes) };
    } else {
      font = { std: "helvetica" };
      boldKey = "helveticaBold";
    }
    drawDataTablesPdf(pdfDoc, font, boldKey, tables, {
      pageSize: "a4",
      orientation: landscape ? "landscape" : "portrait",
      fit: true,
      zebra: true,
    });
    const bytes = pdfDoc.write();
    const reloaded = await PDFDocument.load(bytes);
    return { bytes, pages: reloaded.getPageCount() };
  };

  // small table → one page, valid PDF
  const small: DataTable[] = [
    { title: "sales", header: ["Region", "Sales"], rows: [["North", "120"], ["South", "80"]] },
  ];
  const smallOut = await render(small, false);
  check("small table → 1 valid PDF page", smallOut.pages === 1 && smallOut.bytes[0] === 0x25 /* % */);

  // font detection
  check("WinAnsi table needs no Noto", tablesNeedNoto(small) === false);
  check("Devanagari cell flips to Noto", tablesNeedNoto([
    { title: "बिक्री", header: [], rows: [["हिन्दी"]] },
  ]) === true);

  // long table → page breaks + repeated header, still valid
  const long: DataTable[] = [
    {
      title: "big",
      header: ["#", "Value"],
      rows: Array.from({ length: 120 }, (_, i) => [String(i + 1), `row ${i + 1}`]),
    },
  ];
  const longOut = await render(long, false);
  check("120 rows break across pages (≥2)", longOut.pages >= 2, `${longOut.pages} pages`);
  const reloaded = await PDFDocument.load(longOut.bytes);
  check("every page is A4 portrait", reloaded.getPages().every((p) => Math.round(p.getWidth()) === 595));

  // two tables → one fresh page each
  const two: DataTable[] = [
    { title: "a", header: ["X"], rows: [["1"]] },
    { title: "b", header: ["Y"], rows: [["2"]] },
  ];
  const twoOut = await render(two, false);
  check("two tables → 2 pages (fresh page each)", twoOut.pages === 2);

  // Devanagari through the Noto subset — valid PDF, page present
  const deva: DataTable[] = [
    {
      title: "बिक्री रिपोर्ट",
      header: ["क्षेत्र", "बिक्री"],
      rows: [["उत्तर", "१२०"], ["दक्षिण", "८०"]],
    },
  ];
  const devaOut = await render(deva, true);
  check("Devanagari table renders via Noto (1 page)", devaOut.pages === 1);

  // landscape geometry
  const landOut = await render(small, false, true);
  const landReload = await PDFDocument.load(landOut.bytes);
  check("landscape page is A4-wide", Math.round(landReload.getPages()[0]?.getWidth() ?? 0) === 842);

  // header-less grid renders
  const noHead: DataTable[] = [{ title: "raw", header: [], rows: [["a", "b"], ["c", "d"]] }];
  const noHeadOut = await render(noHead, false);
  check("header-less table renders", noHeadOut.pages === 1);

  // empty rows defensive
  const emptyOut = await render([], false);
  check("empty table list → defensive 1 page", emptyOut.pages === 1);
}

console.log("── 5. Worker discipline ─────────────────────────────────");
{
  for (const id of ["csv-to-pdf", "json-to-pdf", "xml-to-pdf"]) {
    const src = read(`tools/${id}/worker.ts`);
    check(`${id}: no network calls`, !/fetch\(|XMLHttpRequest|WebSocket|import\s*\(/.test(src));
    check(`${id}: honest error codes present`,
      src.includes("tool.errorNoFile") && src.includes("tool.errorCorrupt") && src.includes("tool.errorGeneric"));
    check(`${id}: own engine + shared painter`,
      src.includes("CreateContext") && src.includes("drawDataTablesPdf"));
    check(`${id}: Noto fallback path`, src.includes("loadDevanagariBytes"));
  }
  const xmlSrc = read("tools/xml-to-pdf/worker.ts");
  check("xml worker reuses the e-invoice parser", xmlSrc.includes("xml-invoice-to-pdf/xml"));
  const csvSrc = read("tools/csv-to-pdf/worker.ts");
  check("csv worker sniffs for auto delimiter", csvSrc.includes("sniffDelimiter"));
  const jsonSrc = read("tools/json-to-pdf/worker.ts");
  check("json worker parses with NDJSON fallback", jsonSrc.includes("parseJsonDocument"));
}

console.log("");
if (fail === 0) {
  console.log(`P3-b import pack: ALL ${pass} CHECKS GREEN ✅`);
} else {
  console.log(`P3-b import pack: ${fail} FAILURES (of ${pass + fail}) ❌`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
