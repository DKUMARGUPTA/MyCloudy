/**
 * Redact PDF engine smoke (bun) — verifies the pure machinery the QA golden
 * path then confirms end-to-end in the browser:
 *
 *   1. pattern regexes: every accepted shape, and rejections for
 *      look-alikes (longer digit runs, lowercase PAN, non-Indian numbers)
 *   2. custom terms: case-insensitive, multiple hits, no blank-line hits
 *   3. buildPieces / buildLines: line grouping, synthetic-space joining
 *      with coverage-preserving offsets (the piece behind every char)
 *   4. piecesForRange maps a match range back to the right pieces
 *   5. pieceUserBox + userRectToDisplay for R0/R90/R180/R270 viewport
 *      transforms (pdf.js matrices, hand-derived)
 *   6. displayRectToFraction clamps and pads
 *   7. parseRedactMarks defensive behavior (hostile payloads)
 *
 * Run: bun scripts/smoke-redact.ts
 */

import {
  type TextLine,
  type TextPiece,
  type Transform6,
  activeMarks,
  buildLines,
  buildPieces,
  displayRectToFraction,
  markedPages,
  marksOnPage,
  parseRedactMarks,
  piecesForRange,
  pieceUserBox,
  regexMatches,
  termMatches,
  userRectToDisplay,
} from "../tools/redact-pdf/engine";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/* ---- 1. Patterns ------------------------------------------------- */

console.log("1 · Sensitive-text patterns");

check(
  "Aadhaar spaced",
  regexMatches("My Aadhaar is 1234 5678 9012 ok", "aadhaar").length === 1
);
check(
  "Aadhaar dashed",
  regexMatches("ID: 1234-5678-9012.", "aadhaar")[0]?.text === "1234-5678-9012"
);
check(
  "Aadhaar solid",
  regexMatches("no 123456789012 here", "aadhaar")[0]?.text === "123456789012"
);
check(
  "16-digit order id is NOT Aadhaar",
  regexMatches("order 1234567890123456 done", "aadhaar").length === 0,
  JSON.stringify(regexMatches("order 1234567890123456 done", "aadhaar"))
);
check(
  "5-digit group is NOT Aadhaar",
  regexMatches("pin 12345 67890", "aadhaar").length === 0
);

check(
  "PAN accepted",
  regexMatches("PAN: ABCDE1234F.", "pan")[0]?.text === "ABCDE1234F"
);
check(
  "lowercase is not a PAN",
  regexMatches("abcde1234f", "pan").length === 0
);
check(
  "PAN inside longer token rejected",
  regexMatches("XABCDE1234FY", "pan").length === 0
);

check(
  "Phone 10-digit",
  regexMatches("call 9876543210 now", "phone")[0]?.text === "9876543210"
);
check(
  "Phone spaced",
  regexMatches("call 98765 43210 now", "phone")[0]?.text === "98765 43210"
);
check(
  "Phone +91",
  regexMatches("call +91 9876543210 now", "phone")[0]?.text === "+91 9876543210"
);
check(
  "Phone 91- prefix",
  regexMatches("call 91-9876543210 now", "phone")[0]?.text === "91-9876543210"
);
check(
  "Landline starting 1 is not matched",
  regexMatches("call 1234567890 now", "phone").length === 0
);
check(
  "11+ digit run is not a phone",
  regexMatches("ref 98765432101 x", "phone").length === 0
);

check(
  "Email accepted",
  regexMatches("mail r.k.sharma@example.co.in end", "email")[0]?.text ===
    "r.k.sharma@example.co.in"
);
check(
  "Bare @word is not an email",
  regexMatches("a @ b", "email").length === 0
);

check(
  "Two Aadhaars on one line",
  regexMatches("a 1234 5678 9012 b 9876 5432 1098 c", "aadhaar").length === 2
);

/* ---- 2. Custom terms ---------------------------------------------- */

console.log("2 · Custom terms");

const terms = termMatches("Client Acme Pvt Ltd met client ACME today", ["acme"]);
check(
  "case-insensitive both hits",
  terms.length === 2 && terms[0].text === "Acme" && terms[1].text === "ACME"
);
check(
  "blank terms ignored",
  termMatches("anything", ["", "   "]).length === 0
);
check(
  "hit offsets slice the line",
  termMatches("keep this secret", ["secret"])[0]?.text === "secret"
);

/* ---- 3. Pieces and lines ------------------------------------------- */

console.log("3 · Pieces → lines (synthetic spaces, coverage)");

// Simulate pdf.js items: "Aadhaar: 1234 5678 9012" split into three items.
const items = [
  {
    str: "Aadhaar:",
    transform: [10, 0, 0, 10, 72, 700],
    width: 45,
  },
  {
    str: "1234",
    transform: [10, 0, 0, 10, 130, 700],
    width: 22,
  },
  {
    str: "5678",
    transform: [10, 0, 0, 10, 158, 700],
    width: 22,
  },
  {
    str: "9012",
    transform: [10, 0, 0, 10, 186, 700],
    width: 22,
  },
  // Different baseline → different line.
  {
    str: "next line",
    transform: [10, 0, 0, 10, 72, 660],
    width: 44,
  },
];

const pieces = buildPieces(items as unknown[]);
check("all usable items become pieces", pieces.length === 5);
check(
  "size from transform scale",
  near(pieces[0].size, 10) && near(pieces[0].dirX, 1) && near(pieces[0].dirY, 0)
);

const lines: TextLine[] = buildLines(pieces);
check("two visual lines", lines.length === 2);
check(
  "synthetic space joins the gap",
  lines[0].text.startsWith("Aadhaar: 1234") === true,
  lines[0].text
);
check(
  "gap threshold: tight items get no space",
  lines[0].text.includes("1234 5678") === true && lines[0].text.includes("12345678") === false
);
check(
  "coverage preserved: char count matches pieces",
  lines[0].text.length ===
    lines[0].segments.reduce((sum, s) => sum + s.text.length, 0)
);

/* ---- 4. Range → pieces --------------------------------------------- */

console.log("4 · Match range → pieces");

const line = lines[0];
const aadhaarHit = regexMatches(line.text, "aadhaar")[0];
check("aadhaar found in the joined line", aadhaarHit !== undefined);
const covered = piecesForRange(line, aadhaarHit.start, aadhaarHit.end);
check(
  "covers exactly the three digit pieces",
  covered.length === 3 && covered.every((p) => /^\d{4}$/.test(p.str)),
  `got ${covered.map((p) => p.str).join(",")}`
);
check(
  "prefix piece is not covered",
  piecesForRange(line, 0, 7).every((p) => p.str === "Aadhaar:")
);

/* ---- 5. Geometry: user box → display -------------------------------- */

console.log("5 · User-space box → display (4 rotations)");

const piece: TextPiece = {
  str: "hello",
  x: 100,
  y: 200,
  w: 50,
  size: 10,
  dirX: 1,
  dirY: 0,
};
const userBox = pieceUserBox(piece);
check(
  "upright glyph box",
  near(userBox.x0, 100) &&
    near(userBox.x1, 150) &&
    near(userBox.y0, 200 - 0.26 * 10) &&
    near(userBox.y1, 200 + 0.9 * 10)
);

// pdf.js viewport transforms for a 612×792 page, scale 1, y-down display.
const T_R0: Transform6 = [1, 0, 0, -1, 0, 792];
const T_R90: Transform6 = [0, 1, 1, 0, 0, 0];
const T_R180: Transform6 = [-1, 0, 0, 1, 612, 0];
const T_R270: Transform6 = [0, -1, -1, 0, 792, 612];

const d0 = userRectToDisplay(userBox, T_R0);
check(
  "R0: display y flips",
  near(d0.x0, userBox.x0) && near(d0.y0, 792 - userBox.y1)
);
const d90 = userRectToDisplay(userBox, T_R90);
check(
  "R90: (x,y) → (y,x) swap",
  near(d90.x0, userBox.y0) && near(d90.y0, userBox.x0)
);
const d180 = userRectToDisplay(userBox, T_R180);
check(
  "R180: x mirrors",
  near(d180.x1, 612 - userBox.x0)
);
const d270 = userRectToDisplay(userBox, T_R270);
check(
  "R270: (x,y) → (792−y, 612−x)",
  near(d270.x0, 792 - userBox.y1) && near(d270.y0, 612 - userBox.x1)
);

// Rotated glyph run: advance direction up (90° text).
const vertPiece: TextPiece = {
  str: "vert",
  x: 300,
  y: 400,
  w: 40,
  size: 12,
  dirX: 0,
  dirY: 1,
};
const vertBox = pieceUserBox(vertPiece);
check(
  "vertical run box spans up",
  near(vertBox.x1 - vertBox.x0, 0.26 * 12 + 0.9 * 12) &&
    near(vertBox.y1 - vertBox.y0, 40)
);

/* ---- 6. Display → fractions ----------------------------------------- */

console.log("6 · Display rect → clamped fractions");

const frac = displayRectToFraction(
  { x0: -10, y0: 20, x1: 100, y1: 60 },
  612,
  792,
  2
);
check("negative left clamps to 0", near(frac.x, 0));
check("padding applied on top", near(frac.y, 18 / 792));
check("width + pad right only (left clamped)", near(frac.w, 102 / 612));

const fracBig = displayRectToFraction(
  { x0: 0, y0: 0, x1: 612, y1: 792 },
  612,
  792,
  5
);
check(
  "over-sized padding still clamps inside the page",
  fracBig.x === 0 && fracBig.y === 0 && near(fracBig.w, 1) && near(fracBig.h, 1)
);

/* ---- 7. parseRedactMarks -------------------------------------------- */

console.log("7 · Defensive mark parsing");

check("null → empty", parseRedactMarks(null).length === 0);
check("garbage JSON → empty", parseRedactMarks("not json{{").length === 0);
check("array-less → empty", parseRedactMarks('{"a":1}').length === 0);

const marks = parseRedactMarks(
  JSON.stringify([
    { id: "a", page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.05, kind: "aadhaar", label: "1234 5678 9012", enabled: true },
    { id: "b", page: 1, x: -3, y: 0.5, w: 99, h: 0.5, kind: "manual", label: "", enabled: false },
    { id: "c", page: -1, x: 0, y: 0, w: 0.1, h: 0.1, kind: "pan", label: "x", enabled: true },
    { id: "d", page: 2, x: 0, y: 0, w: 0.001, h: 0.1, kind: "text", label: "t", enabled: true },
    { id: "a", page: 3, x: 0, y: 0, w: 0.1, h: 0.1, kind: "text", label: "dup", enabled: true },
    { id: "e", page: 4, x: 0, y: 0, w: 0.1, h: 0.1, kind: "weird", label: "", enabled: true },
  ])
);
check("valid + clamped + dup + bad-kind survive filtering", marks.length === 2);
check(
  "out-of-page values clamped, not dropped",
  marks[1].x === 0 && marks[1].w <= 1.0 && marks[1].page === 1
);
check(
  "negative page dropped",
  marks.every((m) => m.page >= 0)
);
check(
  "activeMarks keeps only enabled + in-range",
  activeMarks(marks, 1).length === 1 && activeMarks(marks, 1)[0].id === "a"
);
check(
  "marksOnPage filters",
  marksOnPage(marks, 1).length === 1 && marksOnPage(marks, 5).length === 0
);
check(
  "markedPages only counts enabled",
  markedPages(marks).size === 1 && markedPages(marks).has(0)
);

const flood = parseRedactMarks(
  JSON.stringify(
    Array.from({ length: 5000 }, (_, i) => ({
      id: `f${i}`,
      page: 0,
      x: 0,
      y: 0,
      w: 0.05,
      h: 0.05,
      kind: "text",
      label: "",
      enabled: true,
    }))
  )
);
check("flood capped at MAX_MARKS", flood.length === 600);

/* ---- Done ------------------------------------------------------------ */

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
