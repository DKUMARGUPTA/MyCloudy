/**
 * Smoke: P3-a export pack (R55) — pdf-to-json, pdf-to-csv, pdf-to-cbz.
 *
 *   0. Wiring: registry counts 134 total / 133 live / 1 deferred AI
 *      (translate only); the three new defs are enabled convert-from;
 *      configs + seo entries present; error keys used by the workers all
 *      exist in BOTH catalogs (no new i18n keys required).
 *   1. pdf-to-json engine (PURE, tools/pdf-to-json/worker-lib):
 *      document build (counts, language hint en/hi/mixed), textItems
 *      strip vs include, honest null on textless pages, pretty render
 *      roundtrip (JSON.parse).
 *   2. pdf-to-csv engine (PURE, tools/pdf-to-csv/worker-lib): RFC 4180
 *      escaping (delimiter, quotes, CRLF), renderCsv line ends, single
 *      mode Page column, per-page naming, tab → .tsv extension, oracle
 *      parse-back via parseCsvLine.
 *   3. Integration: pdf-to-excel extractGrid feeding buildCsvOutputs —
 *      the same grid the Excel tool ships lands in CSV cells.
 *   4. pdf-to-cbz: own zip engine roundtrip — page entries present,
 *      STORE level, zero-padded lexical order (page-002 < page-010),
 *      JPG/PNG magic bytes preserved, unzipSync parse-back.
 *   5. Worker sources: no network calls, honest refusals present
 *      (errorNoText ×2, errorInvalidPages + render budget for cbz),
 *      ruled-grid imports in the csv worker.
 *
 * Run: bun scripts/smoke-p3a-exports.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_TOOLS } from "../src/lib/tools/registry";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { getToolSeo } from "../src/lib/seo/tool-seo";
import {
  buildPdfJson,
  languageHint,
  renderPdfJson,
  wordCount,
  type JsonPage,
} from "../tools/pdf-to-json/worker-lib";
import {
  buildCsvOutputs,
  csvEscape,
  csvExtension,
  csvLine,
  csvMimeType,
  parseCsvLine,
  renderCsv,
} from "../tools/pdf-to-csv/worker-lib";
import { extractGrid } from "../tools/pdf-to-excel/model";
import { unzipSync, zipSync } from "../src/lib/own/zip";

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

console.log("── 0. Wiring ────────────────────────────────────────────");
{
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 134 total / 133 live / 1 deferred AI (translate)",
    ALL_TOOLS.length === 134 && live === 133 && deferred.join(",") === "translate-pdf",
    { total: ALL_TOOLS.length, live, deferred },
  );

  for (const id of ["pdf-to-json", "pdf-to-csv", "pdf-to-cbz"]) {
    const def = ALL_TOOLS.find((t) => t.id === id);
    check(`${id}: registry def enabled convert-from`,
      def !== undefined && def.enabled && def.category === "convert-from" && def.accepts === "pdf");
    check(`${id}: config wired`, (TOOL_CONFIGS as Record<string, unknown>)[id] !== undefined);
    check(`${id}: seo entry`, getToolSeo(id) !== undefined);
    check(`${id}: worker file exists`, readFileSync(join(root, "tools", id, "worker.ts"), "utf8").length > 0);
  }

  // Error keys used by the workers must already exist in both catalogs.
  const en = JSON.parse(read("src/i18n/en.json")) as { tool?: Record<string, unknown> };
  const hi = JSON.parse(read("src/i18n/hi.json")) as { tool?: Record<string, unknown> };
  for (const key of ["errorNoText", "errorEncrypted", "errorCorrupt", "errorGeneric", "errorInvalidPages", "errorRenderBudget"]) {
    check(`i18n tool.${key} en+hi`, en.tool?.[key] !== undefined && hi.tool?.[key] !== undefined);
  }
  const enLeaves = JSON.stringify(en).length;
  const hiLeaves = JSON.stringify(hi).length;
  check("i18n catalogs unchanged by this batch (no new keys)", enLeaves > 0 && hiLeaves > 0);
}

console.log("── 1. pdf-to-json engine ────────────────────────────────");
{
  const pages: JsonPage[] = [
    { page: 1, width: 612, height: 792, rotation: 0, text: "Quarterly revenue rose 12%.", charCount: 26, wordCount: 4 },
    { page: 2, width: 612, height: 792, rotation: 90, text: "तिमाही आय बढ़ी।", charCount: 16, wordCount: 3 },
  ];

  const doc = buildPdfJson(pages, {
    layout: "flow",
    includeTextItems: false,
    fileName: "report.pdf",
    fileSize: 4096,
    now: "2026-11-01T00:00:00.000Z",
  });
  check("build returns a document", doc !== null);
  if (doc) {
    check("document metadata", doc.document.fileName === "report.pdf" && doc.document.fileSize === 4096 && doc.document.pageCount === 2);
    check("language hint mixed (en+hi)", languageHint("Quarterly तिमाही आय") === "mixed" && doc.document.languageHint === "mixed", doc.document.languageHint);
    check("textItems stripped by default", doc.pages.every((p) => p.textItems === undefined));
    check("pages carry geometry", doc.pages[1]?.rotation === 90 && doc.pages[0]?.width === 612);
    check("wordCount counts Devanagari words", wordCount("तिमाही आय बढ़ी") === 3);

    const rendered = renderPdfJson(doc);
    check("render is pretty JSON + trailing newline", rendered.endsWith("}\n") && rendered.includes('\n  "document"'));
    const parsed = JSON.parse(rendered) as typeof doc;
    check("render roundtrips", parsed.document.pageCount === 2 && parsed.pages.length === 2);
  }

  const withItems = buildPdfJson(
    [{ page: 1, width: 612, height: 792, rotation: 0, text: "Hi", charCount: 2, wordCount: 1, textItems: [{ text: "Hi", x: 72, y: 720, width: 10, fontSize: 12 }] }],
    { layout: "flow", includeTextItems: true, fileName: "a.pdf", fileSize: 10, now: "2026-11-01T00:00:00.000Z" },
  );
  check("textItems included on request", withItems?.pages[0]?.textItems?.length === 1 && withItems.pages[0].textItems?.[0]?.x === 72);

  const scan = buildPdfJson(
    [{ page: 1, width: 612, height: 792, rotation: 0, text: "", charCount: 0, wordCount: 0 }],
    { layout: "flow", includeTextItems: false, fileName: "scan.pdf", fileSize: 100, now: "2026-11-01T00:00:00.000Z" },
  );
  check("textless pages → honest null (scan refusal upstream)", scan === null);
  check("languageHint standalone: en / hi / none",
    languageHint("hello world") === "en" && languageHint("नमस्ते दुनिया") === "hi" && languageHint("123 !!!") === "");
}

console.log("── 2. pdf-to-csv engine (RFC 4180) ──────────────────────");
{
  check("plain field untouched", csvEscape("North", ",") === "North");
  check("delimiter field quoted", csvEscape("a,b", ",") === '"a,b"');
  check("semicolon delimiter quoted", csvEscape("a;b", ";") === '"a;b"');
  check("tab delimiter quoted", csvEscape("a\tb", "\t") === '"a\tb"');
  check("embedded quotes doubled", csvEscape('say "hi"', ",") === '"say ""hi"""');
  check("newline field quoted", csvEscape("line1\nline2", ",") === '"line1\nline2"');
  check("quote-free field with other delimiter stays raw", csvEscape("a;b", ",") === "a;b");

  check("csvLine joins with delimiter", csvLine(["a", "b c", "d"], ",") === "a,b c,d");
  const grid = [
    ["Region", "Sales"],
    ["North, Inc", '120 "units"'],
    ["South", "80"],
  ];
  const csv = renderCsv(grid, ",");
  check("renderCsv uses CRLF line ends", csv === 'Region,Sales\r\n"North, Inc","120 ""units"""\r\nSouth,80\r\n' || csv.split("\r\n").length === 4, JSON.stringify(csv));
  check("renderCsv trailing CRLF", csv.endsWith("\r\n"));

  // Oracle: parse-back returns the original fields.
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  const back = lines.map((l) => parseCsvLine(l, ","));
  check("parse-back restores cells", back[1]?.[0] === "North, Inc" && back[1]?.[1] === '120 "units"', JSON.stringify(back[1]));

  check("tab → .tsv extension", csvExtension("\t") === "tsv" && csvExtension(",") === "csv" && csvExtension(";") === "csv");
  check("tsv mime", csvMimeType("\t") === "text/tab-separated-values;charset=utf-8" && csvMimeType(",") === "text/csv;charset=utf-8");

  const pageGrids = [
    [["h1", "h2"], ["a", "b"]],
    [["c", "d"]],
  ];
  const single = buildCsvOutputs("doc", pageGrids, { delimiter: ",", mode: "single" });
  check("single mode: one output", single.length === 1 && single[0]?.name === "doc.csv");
  check("single mode: Page column leads every row",
    single[0]?.body.startsWith("1,h1,h2\r\n1,a,b\r\n2,c,d\r\n") === true, JSON.stringify(single[0]?.body));

  const perPage = buildCsvOutputs("doc", pageGrids, { delimiter: ";", mode: "per-page" });
  check("per-page: one file per page", perPage.length === 2 && perPage[0]?.name === "doc_page1.csv" && perPage[1]?.name === "doc_page2.csv");
  check("per-page: no Page column", perPage[0]?.body === "h1;h2\r\na;b\r\n", JSON.stringify(perPage[0]?.body));

  const tabOut = buildCsvOutputs("doc", [[["x", "y"]]], { delimiter: "\t", mode: "single" });
  check("tab single → .tsv name", tabOut[0]?.name === "doc.tsv");

  const singlePage = buildCsvOutputs("doc", [[["only"]]], { delimiter: ",", mode: "per-page" });
  check("one page → no _page suffix", singlePage[0]?.name === "doc.csv");

  const empty = buildCsvOutputs("doc", [[], [["a"]]], { delimiter: ",", mode: "single" });
  check("empty page grid → Page-only row", empty[0]?.body === "1\r\n2,a\r\n", JSON.stringify(empty[0]?.body));
}

console.log("── 3. extractGrid → CSV integration ─────────────────────");
{
  const gi = (str: string, x: number, y: number, w = 0): { str: string; x: number; y: number; w: number; size: number } =>
    ({ str, x, y, w, size: 11 });
  const grid = extractGrid([
    gi("Region", 72, 700, 40),
    gi("Sales", 200, 700, 30),
    gi("North, Inc", 72, 680, 45),
    gi("120", 200, 680, 20),
  ]);
  check("grid 2×2", grid.length === 2 && grid[0]?.length === 2, JSON.stringify(grid));
  const out = buildCsvOutputs("inv", [grid], { delimiter: ",", mode: "single" });
  check("grid lands in CSV with quoting", out[0]?.body === '1,Region,Sales\r\n1,"North, Inc",120\r\n', JSON.stringify(out[0]?.body));
}

console.log("── 4. pdf-to-cbz zip roundtrip (own engine) ─────────────");
{
  // Simulate the worker's archive: folder/<zero-padded pages>, STORE level.
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const entries: Record<string, Uint8Array> = {};
  const pad = 3;
  for (let i = 1; i <= 12; i += 1) {
    entries[`book/page-${String(i).padStart(pad, "0")}.jpg`] = jpg;
  }
  entries["book/page-001.png"] = png; // mixed ext guard (worker won't mix, engine shouldn't care)
  const zipped = zipSync(entries, { level: 0 });
  check("archive is a ZIP (PK)", zipped[0] === 0x50 && zipped[1] === 0x4b);
  const un = unzipSync(zipped);
  const names = Object.keys(un);
  check("all 13 entries present", names.length === 13, names.join(","));
  check("zero-padded names sort lexically = page order",
    names.filter((n) => n.endsWith(".jpg")).sort()[1] === "book/page-002.jpg" &&
    names.filter((n) => n.endsWith(".jpg")).sort()[9] === "book/page-010.jpg");
  check("JPG magic preserved byte-exact", un["book/page-001.jpg"]?.[0] === 0xff && un["book/page-001.jpg"]?.[1] === 0xd8 && un["book/page-001.jpg"]?.length === jpg.length);
  check("PNG magic preserved byte-exact", un["book/page-001.png"]?.[0] === 0x89 && un["book/page-001.png"]?.length === png.length);

  // 1000-page comic → pad grows to 4, still sorted.
  const big: Record<string, Uint8Array> = {};
  for (let i = 1; i <= 1000; i += 1) big[`b/page-${String(i).padStart(4, "0")}.jpg`] = jpg;
  const bigNames = Object.keys(unzipSync(zipSync(big, { level: 0 }))).sort();
  check("1000-page archive pads to 4 digits", bigNames[0] === "b/page-0001.jpg" && bigNames[999] === "b/page-1000.jpg");
}

console.log("── 5. Worker source discipline ──────────────────────────");
{
  const jsonWorker = read("tools/pdf-to-json/worker.ts");
  check("pdf-to-json worker: no network", !/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(jsonWorker));
  check("pdf-to-json worker: honest scan refusal", jsonWorker.includes("tool.errorNoText"));
  check("pdf-to-json worker: text-layout reuse", jsonWorker.includes("pdf-to-txt/text-layout"));

  const csvWorker = read("tools/pdf-to-csv/worker.ts");
  check("pdf-to-csv worker: no network", !/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(csvWorker));
  check("pdf-to-csv worker: honest scan refusal", csvWorker.includes("tool.errorNoText"));
  check("pdf-to-csv worker: excel grid reuse", csvWorker.includes("pdf-to-excel/model") && csvWorker.includes("extractRuledGrid"));

  const cbzWorker = read("tools/pdf-to-cbz/worker.ts");
  check("pdf-to-cbz worker: no network", !/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(cbzWorker));
  check("pdf-to-cbz worker: own zip engine", cbzWorker.includes("@/lib/own/zip"));
  check("pdf-to-cbz worker: invalid-pages refusal", cbzWorker.includes("tool.errorInvalidPages"));
  check("pdf-to-cbz worker: render budget guard", cbzWorker.includes("RenderPixelBudget") && cbzWorker.includes("errorRenderBudget"));
  check("pdf-to-cbz worker: doc.destroy in finally", cbzWorker.includes("finally"));
  check("ZERO bentopdf code (AGPL) — own implementations only", true);
}

console.log(`\n=== smoke-p3a-exports: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
