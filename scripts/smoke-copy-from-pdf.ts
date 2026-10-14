/**
 * PRE-BUILD smoke test for Copy from PDF (PRD §7.1).
 *
 * bun cannot run pdf.js, so this locks the PURE engine halves exactly
 * like the surface and the worker use them:
 *
 *  1. buildLines: baseline grouping, space insertion and CSV cell
 *     splitting from horizontal gaps.
 *  2. buildBlocks: paragraph grouping (vertical gap, column overlap,
 *     font-size jump), heading and bullet classification.
 *  3. Flow joins: dehyphenation rules (lowercase merges, capitals keep
 *     the hyphen), paragraph breaks on clear vertical gaps.
 *  4. Clipboard formats: text, Markdown (heading levels, bullets) and
 *     CSV (columns from gaps, RFC 4180 quoting, CRLF rows).
 *  5. harvestPieces: the pdf.js item → display-piece mapping through a
 *     mocked viewport (rotate-0 and flipped).
 *  6. textToLines: OCR text → synthetic lines feeding the same pipeline.
 *
 * Run: bun scripts/smoke-copy-from-pdf.ts
 */
import {
  type DisplayPiece,
  type PageViewportLike,
  blocksToCsv,
  blocksToMarkdown,
  blocksToText,
  buildBlocks,
  buildLines,
  bodySize,
  countChars,
  harvestPieces,
  joinFlowLines,
  linesToFlowText,
  linesToVerbatim,
  selectionToOutput,
  textToLines,
} from "../tools/copy-from-pdf/engine";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string): void {
  failed += 1;
  console.error(`FAIL ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message} (expected ${b}, got ${a})`);
}

/** Piece factory (11pt body default). */
function p(
  str: string,
  x: number,
  y: number,
  xEnd?: number,
  size = 11
): DisplayPiece {
  return { str, x, y, xEnd: xEnd ?? x + str.length * 5.5, size };
}

// ---------------------------------------------------------------------------
// 1. buildLines
// ---------------------------------------------------------------------------
{
  // Same baseline, no gaps → one line, one cell.
  const lines = buildLines([
    p("Hello ", 72, 100, 105),
    p("world", 105, 100, 132),
  ]);
  eq(lines.length, 1, "1.1 same-baseline pieces group into one line");
  eq(lines[0].text, "Hello world", "1.2 adjacent pieces join without extra space");
  eq(lines[0].cells.length, 1, "1.3 adjacent pieces stay one cell");

  // Small gap → space inside the cell.
  const gapped = buildLines([
    p("Hello", 72, 100, 100),
    p("world", 104, 100, 132), // 4pt gap > 0.25×11 = 2.75
  ]);
  eq(gapped[0].text, "Hello world", "1.4 small gap inserts a space");
  eq(gapped[0].cells.length, 1, "1.5 small gap stays one cell");

  // Wide gap → new cell (CSV column).
  const table = buildLines([
    p("Name", 72, 100, 94),
    p("Age", 104, 100, 120), // 10pt gap: 1.4×11=15.4 > 10 → same cell
  ]);
  eq(table[0].cells.length, 1, "1.6a medium gap stays one cell");
  eq(table[0].text, "Name Age", "1.6b medium gap inserts a space");

  // Column gap (≥ 3× size) → the line itself splits.
  const cols = buildLines([
    p("Left", 72, 100, 94),
    p("Right", 170, 100, 196), // 76pt gap > 3×11=33
  ]);
  eq(cols.length, 2, "1.7 column gap splits into two lines");
  eq(cols.map((l) => l.text), ["Left", "Right"], "1.8 split lines carry their own text");
  eq(cols[0].y, cols[1].y, "1.8b split lines share the baseline (CSV rows)");

  // Different baselines → two lines, top first (display y down).
  const two = buildLines([p("lower", 72, 130), p("upper", 72, 100)]);
  eq(two.map((l) => l.text), ["upper", "lower"], "1.9 lines sort top to bottom");

  // Sub/superscript tolerance: 4pt baseline offset < max(1.5, 0.5×size).
  const sub = buildLines([
    p("x", 72, 100, 77, 11),
    p("2", 77, 104, 82, 7), // baseline 4pt below, size 7 → tol 3.5... 4 > 3.5?
  ]);
  // tol = max(1.5, 7*0.5)=3.5 < 4 → separate line. Group tol comes from
  // the FIRST piece of the group (11pt → 5.5) — verify it groups.
  eq(sub.length, 1, "1.10 group tolerance uses the group's first size");

  // Empty input.
  eq(buildLines([]).length, 0, "1.11 no pieces → no lines");
}

// ---------------------------------------------------------------------------
// 2. buildBlocks
// ---------------------------------------------------------------------------
{
  // Tight leading (14pt for 11pt text) → one paragraph block.
  const para = buildBlocks(
    buildLines([
      p("First line of the paragraph here.", 72, 100),
      p("Second line continues the thought.", 72, 114),
      p("Third line closes the paragraph.", 72, 128),
    ])
  );
  eq(para.length, 1, "2.1 tight leading keeps one block");
  eq(para[0].kind, "para", "2.2 plain text → para kind");
  eq(
    para[0].text,
    "First line of the paragraph here. Second line continues the thought. Third line closes the paragraph.",
    "2.3 block text is flow-joined"
  );
  near(para[0].x, 72, "2.4 block bbox x");
  near(para[0].h, 28 + 11, "2.5 block bbox height (last y + size − top)", 1e-9);

  // Clear vertical gap → paragraph break.
  const two = buildBlocks(
    buildLines([
      p("Para one.", 72, 100),
      p("Para two starts after a gap.", 72, 150), // 50pt gap > 1.75×11 ≈ 19
    ])
  );
  eq(two.length, 2, "2.6 vertical gap splits paragraphs");

  // Side-by-side columns: same rows, no x overlap → no merge.
  const cols = buildBlocks(
    buildLines([
      p("Left column line one", 72, 100, 170),
      p("Right column line one", 320, 100, 418),
      p("Left column line two", 72, 114, 170),
      p("Right column line two", 320, 114, 418),
    ])
  );
  assert(
    cols.length === 2,
    `2.7 side-by-side columns stay separate (got ${cols.length})`
  );
  assert(
    cols[0].text.includes("Left") && cols[1].text.includes("Right"),
    "2.8 column blocks group their own text"
  );

  // Heading: 22pt single line over an 11pt body → heading kind.
  const heading = buildBlocks(
    buildLines([
      p("Annual Report", 72, 100, 190, 22),
      p("Body text follows the heading", 72, 140),
      p("and continues on the next line", 72, 154),
    ])
  );
  eq(heading[0].kind, "heading", "2.9 big short line → heading");
  eq(heading[1].kind, "para", "2.10 following body lines → para");

  // Bullet: leading marker → bullet kind.
  const bullet = buildBlocks(
    buildLines([p("• First item in the list", 72, 100), p("• Second item", 72, 114)])
  );
  assert(bullet.every((b) => b.kind === "bullet"), "2.11 marker lines → bullet kind");

  // Empty.
  eq(buildBlocks([]).length, 0, "2.12 no lines → no blocks");
}

// ---------------------------------------------------------------------------
// 3. Flow joins
// ---------------------------------------------------------------------------
{
  // Dehyphenation: lowercase merges and drops the hyphen.
  eq(
    joinFlowLines([
      { text: "This is an exam-", x: 0, xEnd: 60, y: 0, size: 11, cells: [] },
      { text: "ple of joining.", x: 0, xEnd: 60, y: 14, size: 11, cells: [] },
    ]),
    "This is an example of joining.",
    "3.1 hyphen merges before lowercase"
  );

  // A capital after the hyphen keeps it (genuine compound).
  eq(
    joinFlowLines([
      { text: "We sent the e-", x: 0, xEnd: 60, y: 0, size: 11, cells: [] },
      { text: "Mail yesterday.", x: 0, xEnd: 60, y: 14, size: 11, cells: [] },
    ]),
    "We sent the e- Mail yesterday.",
    "3.2 hyphen stays before a capital (space-joined)"
  );

  // Hindi across a line break: no hyphen → honest space join (hyphen
  // merging is Latin-script only; Devanagari never hyphenates).
  eq(
    joinFlowLines([
      { text: "यह एक परी", x: 0, xEnd: 60, y: 0, size: 11, cells: [] },
      { text: "क्षा है", x: 0, xEnd: 60, y: 14, size: 11, cells: [] },
    ]),
    "यह एक परी क्षा है",
    "3.3 Devanagari space-joins across a break (no hyphen merge)"
  );

  // Page-level flow: vertical gap starts a new paragraph.
  const flowed = linesToFlowText(
    buildLines([
      p("Para one talks about something.", 72, 100),
      p("It has two lines of content.", 72, 114),
      p("Para two is after a gap.", 72, 160), // 46pt gap > 1.7×11
    ])
  );
  eq(flowed, "Para one talks about something. It has two lines of content.\n\nPara two is after a gap.", "3.4 flow paragraphs split on gap");

  // Verbatim keeps every line break.
  const verbatim = linesToVerbatim(
    buildLines([p("Line A", 72, 100), p("Line B", 72, 114)])
  );
  eq(verbatim, "Line A\nLine B", "3.5 verbatim layout keeps breaks");
}

// ---------------------------------------------------------------------------
// 4. Clipboard formats
// ---------------------------------------------------------------------------
{
  const blocks = buildBlocks(
    buildLines([
      p("Quarterly Summary", 72, 80, 210, 24),
      p("Revenue grew in every region.", 72, 120),
      p("Costs stayed flat overall.", 72, 134),
      p("• India revenue up 18%", 72, 170),
      p("• EU revenue up 9%", 72, 184),
    ])
  );

  eq(
    blocksToText(blocks),
    "Quarterly Summary\n\nRevenue grew in every region. Costs stayed flat overall.\n\n• India revenue up 18%\n\n• EU revenue up 9%",
    "4.1 plain text join"
  );

  eq(
    blocksToMarkdown(blocks),
    "# Quarterly Summary\n\nRevenue grew in every region. Costs stayed flat overall.\n\n- India revenue up 18%\n\n- EU revenue up 9%",
    "4.2 markdown heading + separate bullet blocks"
  );

  // Heading levels by absolute size.
  const levels = buildBlocks(
    buildLines([
      p("H1", 72, 60, 84, 26),
      p("H2", 72, 120, 84, 20),
      p("H3", 72, 180, 84, 15),
      p("Body text line", 72, 240),
    ])
  );
  const md = blocksToMarkdown(levels);
  assert(md.startsWith("# H1"), "4.3 26pt → h1");
  assert(md.includes("## H2"), "4.4 20pt → h2");
  assert(md.includes("### H3"), "4.5 15pt (≥1.22×11) → h3");

  // CSV: gaps split columns, quotes escape, CRLF endings.
  const csvBlocks = buildBlocks(
    buildLines([
      p("Name", 72, 100, 94),
      p("Age", 160, 100, 176),
      p(`"Ravi, K."`, 72, 114, 116),
      p("30", 160, 114, 168),
    ])
  );
  eq(
    blocksToCsv(csvBlocks),
    'Name,Age\r\n"""Ravi, K.""",30',
    "4.6 CSV columns + RFC 4180 quoting"
  );

  // selectionToOutput dispatches.
  eq(selectionToOutput(blocks, "text"), blocksToText(blocks), "4.7 text dispatch");
  eq(selectionToOutput(blocks, "markdown"), blocksToMarkdown(blocks), "4.8 markdown dispatch");
  eq(selectionToOutput(blocks, "csv"), blocksToCsv(blocks), "4.9 csv dispatch");
}

// ---------------------------------------------------------------------------
// 5. harvestPieces (mocked viewport)
// ---------------------------------------------------------------------------
{
  // Rotate-0 display transform: x stays, y flips (PDF y-up → display y-down).
  const identity: PageViewportLike = {
    width: 612,
    height: 792,
    transform: [1, 0, 0, -1, 0, 792],
  };

  const pieces = harvestPieces(identity, [
    {
      str: "Hi",
      transform: [11, 0, 0, 11, 72, 720],
      width: 12.2,
      height: 11,
    },
    { str: "", transform: [11, 0, 0, 11, 100, 720], width: 0, height: 11 },
    { str: "Bad", transform: "nope" },
  ]);

  eq(pieces.length, 1, "5.1 empty strings and bad transforms drop");
  near(pieces[0].x, 72, "5.2 piece x from transform[4]");
  near(pieces[0].y, 792 - 720, "5.3 piece y flips into display space");
  near(pieces[0].xEnd, 72 + 12.2, "5.4 piece xEnd = x + width");
  near(pieces[0].size, 11, "5.5 piece size = hypot(tr[1], tr[3])");

  // Rotated viewport (90°): user-space x maps to display y.
  const rotated: PageViewportLike = {
    width: 792,
    height: 612,
    transform: [0, -1, 1, 0, 0, 612],
  };
  const rot = harvestPieces(rotated, [
    { str: "Turn", transform: [0, 11, -11, 0, 72, 720], width: 22, height: 11 },
  ]);
  eq(rot.length, 1, "5.6 rotated page still harvests");
  near(rot[0].y, 612 - 72, "5.7 rotated baseline maps through the viewport");
  near(Math.min(rot[0].x, rot[0].xEnd), 709, "5.8 rotated run spans converted x (min corner)");
  near(Math.max(rot[0].x, rot[0].xEnd), 720, "5.8b rotated run spans converted x (max corner)");
}

// ---------------------------------------------------------------------------
// 6. textToLines (OCR fallback)
// ---------------------------------------------------------------------------
{
  const lines = textToLines("First line\nSecond line\n\nThird after blank");
  eq(lines.length, 3, "6.1 blank OCR lines drop");
  eq(lines.map((l) => l.text), ["First line", "Second line", "Third after blank"], "6.2 OCR line texts");
  assert(lines[1].y > lines[0].y, "6.3 synthetic y grows downward");
  eq(lines[0].cells.length, 1, "6.4 OCR lines carry one cell");

  const ocrBlocks = buildBlocks(lines);
  eq(ocrBlocks.length, 2, "6.5 consecutive OCR lines merge, blank line splits");
  eq(
    selectionToOutput(ocrBlocks, "text"),
    "First line Second line\n\nThird after blank",
    "6.6 OCR text round-trips through selection output"
  );

  eq(countChars("  a b \n c "), 3, "6.7 countChars ignores whitespace");
}

function near(a: number, b: number, message: string, tol = 1e-6): void {
  assert(Math.abs(a - b) < tol, `${message} (expected ${b}, got ${a})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
