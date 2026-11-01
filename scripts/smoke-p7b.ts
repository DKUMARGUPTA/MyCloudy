/**
 * PRE-BUILD smoke for PHASE-7 R39 (extract-tables). The engine is pure
 * (GridTextItem[] in, blocks out) and the CSV writer is pure string
 * work — both bun-safe. The pdf.js read is browser-E2E turf
 * (pdf-to-excel precedent).
 *
 *  1. rowsFromItems — y-band rows, x-gap cell splits, touching joins.
 *  2. extractTables — segmentation: 2 tables + paragraph between →
 *     exactly 2 blocks; paragraph text never leaks in.
 *  3. gridForBlock — column anchors: jagged rows keep empty cells
 *     (no left-shift), values land in true columns.
 *  4. Block splits — paragraph row, vertical gap, anchor drift.
 *  5. csvCell / rowsToCsv — RFC-4180 quoting, 3 delimiters, CRLF.
 *  6. combineCsvs — blank-line separated combined document.
 *  7. Honest edges — no-tabular page → 0 tables; empty items.
 *  8. Registry 139 live + config + i18n keys.
 *
 * Run: bun scripts/smoke-p7b.ts
 */
import {
  ET_BLOCK_GAP_FACTOR,
  ET_MIN_TABLE_ROWS,
  extractTables,
  gridForBlock,
  rowsFromItems,
  type SegRow,
} from "../tools/extract-tables/engine";
import {
  combineCsvs,
  csvCell,
  resolveDelimiter,
  rowsToCsv,
  tableFileName,
} from "../tools/extract-tables/csv-emit";
import type { GridTextItem } from "../tools/pdf-to-excel/model";
import { liveToolCount } from "../src/lib/tools/registry";
import { config as etConfig } from "../tools/extract-tables/config";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { readFileSync } from "node:fs";

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

const mk = (str: string, x: number, y: number, w: number, size = 10): GridTextItem => ({
  str,
  x,
  y,
  w,
  size,
});

/** A classic 3-column table row (cells far apart). */
function tableRow(y: number, a: string, b: string, c: string): GridTextItem[] {
  return [
    mk(a, 50, y, a.length * 5.5),
    mk(b, 200, y, b.length * 5.5),
    mk(c, 350, y, c.length * 5.5),
  ];
}

/* ------------------------------------------------------------------ */
console.log("1. rowsFromItems — bands, gaps, joins");

const rowsA = rowsFromItems([
  ...tableRow(700, "Name", "Qty", "Price"),
  ...tableRow(670, "Mango", "12", "340"),
  mk("A plain paragraph that spans the whole width of the page", 50, 600, 300),
]);
check(
  "3 visual rows (two table rows + paragraph)",
  rowsA.length === 3,
  `${rowsA.length}`
);
check(
  "table rows split into 3 cells by x-gap",
  rowsA[0]!.cells.length === 3 && rowsA[1]!.cells.length === 3,
  `${rowsA[0]?.cells.length}/${rowsA[1]?.cells.length}`
);
check(
  "paragraph stays ONE cell",
  rowsA[2]!.cells.length === 1,
  `${rowsA[2]?.cells.length}`
);
check(
  "rows ordered top-first (y desc)",
  rowsA[0]!.y === 700 && rowsA[1]!.y === 670 && rowsA[2]!.y === 600,
);

const joined = rowsFromItems([
  mk("Hello ", 50, 700, 24),
  mk("World", 74.1, 700, 26),
]);
check(
  "touching pieces join into one cell",
  joined.length === 1 && joined[0]!.cells.length === 1 && joined[0]!.cells[0]!.text === "Hello World",
  JSON.stringify(joined[0]?.cells)
);

const nearMiss = rowsFromItems([
  mk("abc", 50, 700, 30),
  mk("def", 90, 700, 30),
]);
check(
  "moderate gap (< gapFactor·size) stays one cell",
  nearMiss[0]!.cells.length === 1 && nearMiss[0]!.cells[0]!.text === "abc def",
  JSON.stringify(nearMiss[0]?.cells.map((c) => c.text))
);

/* ------------------------------------------------------------------ */
console.log("2. extractTables — segmentation");

const page = [
  ...tableRow(700, "Name", "Qty", "Price"),
  ...tableRow(670, "Mango", "12", "340"),
  ...tableRow(640, "Apple", "8", "120"),
  mk("This paragraph sits between the two tables.", 50, 560, 240),
  mk("Item", 60, 480, 22),
  mk("Count", 260, 480, 30),
  mk("Bolts", 60, 450, 26),
  mk("90", 260, 450, 12),
];
const tables = extractTables(page);
check(
  "two tables found, paragraph excluded",
  tables.length === 2,
  `${tables.length} tables`
);
check(
  "table 1 grid: 3 rows × 3 cols, values in true columns",
  tables[0]!.grid.length === 3 &&
    tables[0]!.grid[0]!.join("|") === "Name|Qty|Price" &&
    tables[0]!.grid[1]!.join("|") === "Mango|12|340",
  JSON.stringify(tables[0]?.grid)
);
check(
  "table 2 grid: header + row",
  tables[1]!.grid.length === 2 &&
    tables[1]!.grid[0]!.join("|") === "Item|Count" &&
    tables[1]!.grid[1]!.join("|") === "Bolts|90",
  JSON.stringify(tables[1]?.grid)
);
check(
  "no paragraph text leaked into any grid",
  !JSON.stringify(tables).includes("paragraph"),
);

/* ------------------------------------------------------------------ */
console.log("3. gridForBlock — column anchors");

const jagged: SegRow[] = [
  { y: 700, size: 10, cells: [
    { text: "A", x0: 50, x1: 80 },
    { text: "B", x0: 200, x1: 230 },
    { text: "C", x0: 350, x1: 380 },
  ] },
  { y: 670, size: 10, cells: [
    { text: "only-A", x0: 52, x1: 110 },
    { text: "only-C", x0: 348, x1: 420 },
  ] },
];
const grid = gridForBlock(jagged);
check(
  "jagged row keeps the empty middle column (no left-shift)",
  grid[1]!.length === 3 && grid[1]![0] === "only-A" && grid[1]![1] === "" && grid[1]![2] === "only-C",
  JSON.stringify(grid[1])
);

/* ------------------------------------------------------------------ */
console.log("4. Block split rules");

const gapSplit = extractTables([
  ...tableRow(700, "T1a", "T1b", "T1c"),
  ...tableRow(670, "1", "2", "3"),
  // Paragraph-sized vertical gap (row height ~10pt, gap 10× factor ≫ 2.2)
  ...tableRow(400, "T2a", "T2b", "T2c"),
  ...tableRow(370, "4", "5", "6"),
]);
check(
  "vertical paragraph-gap splits stacked tables",
  gapSplit.length === 2,
  `${gapSplit.length}`
);

const driftSplit = extractTables([
  ...tableRow(700, "A", "B", "C"),
  ...tableRow(670, "1", "2", "3"),
  // same row band continues, but totally different columns AND count
  mk("x", 90, 640, 8),
  mk("y", 410, 640, 8),
  mk("x2", 90, 610, 10),
  mk("y2", 410, 610, 10),
]);
check(
  "zero shared anchors + different count splits tables",
  driftSplit.length === 2,
  `${driftSplit.length}`
);

const airyTable = extractTables([
  ...tableRow(700, "Airy", "Wide", "Rows"),
  ...tableRow(670, "a", "b", "c"),
  ...tableRow(640, "d", "e", "f"),
]);
check(
  "airy table (30pt pitch, 10pt font) stays ONE table",
  airyTable.length === 1 && airyTable[0]!.grid.length === 3,
  `${airyTable.length} blocks, ${airyTable[0]?.grid.length} rows`
);

const loneTabularRow = extractTables([
  ...tableRow(700, "only", "one", "row"),
]);
check(
  "a lone tabular row is not a table (MIN_TABLE_ROWS)",
  loneTabularRow.length === 0,
  `${loneTabularRow.length}`
);
check("ET_MIN_TABLE_ROWS = 2", ET_MIN_TABLE_ROWS === 2);
check(
  "ET_BLOCK_GAP_FACTOR = 2.2 (doc'd heuristic)",
  ET_BLOCK_GAP_FACTOR === 2.2
);

/* ------------------------------------------------------------------ */
console.log("5. csvCell / rowsToCsv — RFC-4180");

check("plain cell unquoted", csvCell("hello", ",") === "hello");
check(
  "comma cell quoted",
  csvCell("a,b", ",") === '"a,b"',
  csvCell("a,b", ",")
);
check(
  "quote doubled inside quotes",
  csvCell('say "hi"', ",") === '"say ""hi"""',
  csvCell('say "hi"', ",")
);
check(
  "newline cell quoted",
  csvCell("l1\nl2", ",") === '"l1\nl2"',
  csvCell("l1\nl2", ",")
);
check(
  "semicolon cell unquoted under comma delimiter",
  csvCell("a;b", ",") === "a;b"
);
check(
  "semicolon cell quoted under semicolon delimiter",
  csvCell("a;b", ";") === '"a;b"'
);

const csv = rowsToCsv(
  [
    ["Name", "Qty"],
    ["Red, ripe", "12"],
  ],
  ","
);
check(
  "rowsToCsv: CRLF endings + trailing CRLF",
  csv === 'Name,Qty\r\n"Red, ripe",12\r\n',
  JSON.stringify(csv)
);
const tabCsv = rowsToCsv([["a", "b c"]], "\t");
check("tab delimiter join", tabCsv === "a\tb c\r\n", JSON.stringify(tabCsv));

check("resolveDelimiter defaults", resolveDelimiter(undefined) === "," && resolveDelimiter("junk") === ",");
check("resolveDelimiter semicolon/tab", resolveDelimiter("semicolon") === ";" && resolveDelimiter("tab") === "\t");
check(
  "tableFileName p1-t2",
  tableFileName("report", 1, 2) === "report-p1-t2.csv",
  tableFileName("report", 1, 2)
);

/* ------------------------------------------------------------------ */
console.log("6. combineCsvs — combined document");

const combined = combineCsvs(
  [
    [
      ["A", "B"],
      ["1", "2"],
    ],
    [
      ["C", "D"],
      ["3", "4"],
    ],
  ],
  ","
);
check(
  "tables separated by exactly one blank line",
  combined === "A,B\r\n1,2\r\n\r\nC,D\r\n3,4\r\n",
  JSON.stringify(combined)
);
check("empty input → empty doc", combineCsvs([], ",") === "");

/* ------------------------------------------------------------------ */
console.log("7. Honest edges");

const noTables = extractTables([mk("just a paragraph", 50, 700, 120)]);
check("non-tabular page → 0 tables", noTables.length === 0);
check("empty items → 0 tables", extractTables([]).length === 0);
const whitespace = extractTables([mk("   ", 50, 700, 30), mk("", 60, 670, 10)]);
check("whitespace-only items → 0 tables", whitespace.length === 0);

/* ------------------------------------------------------------------ */
console.log("8. Registry + config + i18n");

const live = liveToolCount;
check("live tool count = 139 (138 + extract-tables)", live === 139, `got ${live}`);
check(
  "config registered under extract-tables",
  TOOL_CONFIGS["extract-tables"]?.toolId === "extract-tables",
);
check(
  "config options: pages + delimiter + output",
  etConfig.options.length === 3 &&
    etConfig.options[0]!.kind === "pages" &&
    etConfig.options[1]!.kind === "select" &&
    etConfig.options[2]!.kind === "select",
);
check(
  "output text kind + single file",
  etConfig.outputKind === "text" && etConfig.minFiles === 1 && etConfig.maxFiles === 1,
);

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
const enTool = en["tool"] as Record<string, unknown>;
const hiTool = hi["tool"] as Record<string, unknown>;
const enResult = en["result"] as Record<string, unknown>;
const hiResult = hi["result"] as Record<string, unknown>;
check(
  "i18n tool.errorNoTables + tool.errorTooManyItems EN+HI",
  typeof enTool["errorNoTables"] === "string" &&
    typeof hiTool["errorNoTables"] === "string" &&
    typeof enTool["errorTooManyItems"] === "string" &&
    typeof hiTool["errorTooManyItems"] === "string",
);
check(
  "i18n result.tablesExtracted EN + HI",
  typeof enResult["tablesExtracted"] === "string" &&
    typeof hiResult["tablesExtracted"] === "string",
);

function leafCount(o: unknown): number {
  if (typeof o !== "object" || o === null) return 1;
  return Object.values(o).reduce((sum: number, v) => sum + leafCount(v), 0);
}
check(
  "i18n flat-leaf parity EN = HI",
  leafCount(en) === leafCount(hi),
  `EN ${leafCount(en)} vs HI ${leafCount(hi)}`
);

/* ------------------------------------------------------------------ */
console.log("");
console.log(`extract-tables smoke: ${pass} PASS, ${fail} FAIL (of ${pass + fail})`);
if (fail > 0) process.exit(1);
