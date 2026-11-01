/**
 * PRE-BUILD smoke for PHASE-7 R41 (font-to-outline). The glyf decoder,
 * contour walk, string decoding and the whole document surgery are
 * pure own-engine work — bun-safe end to end.
 *
 *  1. walkContour — on/off walks: on-off-on, off+off runs, all-off
 *     contours, single-off degenerate.
 *  2. glyphToPathOps — quad→cubic 2/3 rule, h + f emission.
 *  3. decodeStringOperand — hex, literal with escapes.
 *  4. End-to-end (CreateContext + real Noto Devanagari TTF — OUR OWN
 *     Identity-H embedding): font resolves, text converts, paths land
 *     at the right coordinates, Tj ops of converted text are GONE,
 *     layout ops (BT/Tm/Tf) survive, output re-parses.
 *  5. Honest error: standard-font (non-embedded) PDF → error.
 *  6. Registry 141 live + i18n.
 *
 * Run: bun scripts/smoke-p7d.ts
 */
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  glyphContours,
  glyphToPathOps,
  walkContour,
  type GlyphPoint,
} from "../tools/font-to-outline/glyf";
import {
  decodeStringOperand,
  outlineContent,
  outlineFontsByResourceName,
} from "../tools/font-to-outline/engine";
import { runFontToOutline } from "../tools/font-to-outline/worker";
import { CreateContext } from "../src/lib/own/pdf";
import {
  decodeStreamBytes,
  latin1,
  listPages,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";
import { config as foConfig } from "../tools/font-to-outline/config";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";

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

const pt = (x: number, y: number, on: boolean): GlyphPoint => ({ x, y, on });

/* ------------------------------------------------------------------ */
console.log("1. walkContour — TrueType on/off walks");

const w1 = walkContour([pt(0, 0, true), pt(50, 40, false), pt(100, 0, true)]);
check(
  "on-off-on: one quad segment",
  w1 !== null && w1.segs.length === 1 && w1.segs[0]!.t === "Q" && w1.start.x === 0,
  JSON.stringify(w1)
);

const w2 = walkContour([
  pt(0, 0, true),
  pt(30, 50, false),
  pt(70, 50, false),
  pt(100, 0, true),
]);
check(
  "off+off run: two quads via implied midpoint (60? — mid(30..70)=50,50)",
  w2 !== null && w2.segs.length === 2 && w2.segs.every((s) => s.t === "Q"),
  JSON.stringify(w2?.segs)
);
const w2mid = w2?.segs[0] as { t: "Q"; c: GlyphPoint; p: GlyphPoint };
check(
  "first quad ends at the implied midpoint (50,50)",
  w2mid.p.x === 50 && w2mid.p.y === 50,
  JSON.stringify(w2mid.p)
);

const w3 = walkContour([pt(0, 50, false), pt(100, 50, false)]);
check(
  "all-off contour: start at implied midpoint (50,50), 2 quads, ends where it started",
  w3 !== null && w3.start.x === 50 && w3.start.y === 50 && w3.segs.length === 2 &&
    (w3.segs[1] as { p: GlyphPoint }).p.x === 50,
  JSON.stringify(w3)
);

const w4 = walkContour([pt(10, 10, false), pt(90, 10, true)]);
check(
  "off-then-single-on: start at the on point, quad wraps to start",
  w4 !== null && w4.start.x === 90 && w4.segs.length === 1 &&
    (w4.segs[0] as { p: GlyphPoint }).p.x === 90,
  JSON.stringify(w4)
);

check("empty contour → null", walkContour([]) === null);

/* ------------------------------------------------------------------ */
console.log("2. glyphToPathOps — quad→cubic, h + f");

const pathOps = glyphToPathOps(
  [[pt(0, 0, true), pt(50, 100, false), pt(100, 0, true)]],
  (x, y) => [String(x), String(y)]
);
check(
  "path: m … c … h f with 2/3 cubic controls",
  pathOps.startsWith("0 0 m") &&
    /\d c(\n|$)/.test(pathOps) &&
    pathOps.endsWith("h\nf"),
  pathOps
);
// Cubic control 1 = p0 + 2/3(cp−p0) = (33.33…, 66.66…)
check(
  "cubic control points follow the 2/3 rule",
  pathOps.includes("33.3333333333") && pathOps.includes("66.6666666666"),
  pathOps
);
check(
  "empty contours → no ops",
  glyphToPathOps([], (x, y) => [String(x), String(y)]) === ""
);

/* ------------------------------------------------------------------ */
console.log("3. decodeStringOperand");

const hex = decodeStringOperand("<00440046>");
check(
  "hex string → bytes [0,68,0,70]",
  hex !== null && hex.length === 4 && hex[0] === 0 && hex[1] === 68 && hex[2] === 0 && hex[3] === 70,
  JSON.stringify(Array.from(hex ?? []))
);
const lit = decodeStringOperand("(A\\102\\nC)");
check(
  "literal with octal + \\n escape",
  lit !== null && Array.from(lit).join(",") === "65,66,10,67",
  JSON.stringify(Array.from(lit ?? []))
);
const cont = decodeStringOperand("(AB\\\nCD)");
check(
  "line continuation dropped",
  cont !== null && Array.from(cont).join(",") === "65,66,67,68",
  JSON.stringify(Array.from(cont ?? []))
);
check("not a string → null", decodeStringOperand("123") === null);

/* ------------------------------------------------------------------ */
console.log("4. End-to-end — CreateContext Identity-H fixture (Noto Devanagari)");

const ttfBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);
const ctx = CreateContext.create();
const font = ctx.embedTtf(ttfBytes);
const page = ctx.addPage(400, 640);
page.drawText({ x: 40, y: 600, text: "नमस्ते", size: 24, ttf: font });
page.drawText({ x: 40, y: 540, text: "दस्तावेज़", size: 18, ttf: font });
const fixture = ctx.write();

const parsed = parsePdf(fixture);
const pages = listPages(parsed);
const fontsMap = outlineFontsByResourceName(parsed, pages[0]!.resources);
check(
  "fixture font resolves as Type0/Identity-H outline source",
  fontsMap.size >= 1,
  `${fontsMap.size} fonts`
);
const of = [...fontsMap.values()][0]!;
check(
  "font facts: unitsPerEm + widths from /W",
  of.font.unitsPerEm >= 1000 && of.widths.size > 0,
  `upem=${of.font.unitsPerEm} widths=${of.widths.size}`
);

// Raw content surgery first (decoded stream).
const rawStream = resolve(parsed, pages[0]!.dict.get("Contents"));
if (rawStream?.k !== "stream") throw new Error("fixture contents missing");
const decodedContent = latin1All(
  decodeStreamBytes(rawStream.raw, rawStream.m as Map<never, never>)
);
const surgery = outlineContent(decodedContent, fontsMap);
check(
  "both Tj shows converted",
  surgery.stats.showsConverted === 2 && surgery.stats.showsSkipped === 0,
  JSON.stringify(surgery.stats)
);
check(
  "glyph paths drawn (≥ 6 glyphs)",
  surgery.stats.glyphPaths >= 6,
  `${surgery.stats.glyphPaths}`
);
check(
  "path ops present (m/c/f), text ops gone (no Tj)",
  /\d m\b/.test(surgery.out) && /\d c\b/.test(surgery.out) && surgery.out.includes("\nf") &&
    !/\bTj\b/.test(surgery.out),
  surgery.out.slice(0, 120)
);
check(
  "layout ops survive (BT/Tm/Tf)",
  surgery.out.includes("BT") && surgery.out.includes("Tm") && surgery.out.includes("Tf"),
);

// First move op near the draw position (40, 600).
const firstMove = surgery.out.match(/(-?[\d.]+) (-?[\d.]+) m/);
check(
  "first path point lands near (40, 600)",
  firstMove !== null &&
    Number(firstMove[1]) >= 38 && Number(firstMove[1]) <= 46 &&
    Number(firstMove[2]) >= 598 && Number(firstMove[2]) <= 640,
  firstMove ? `${firstMove[1]},${firstMove[2]}` : "no move found"
);

// Whole pipeline.
const result = runFontToOutline(fixture, { pages: "all" });
check(
  "pipeline: output parses, 1 page",
  latin1All(result.bytes).startsWith("%PDF-") && listPages(parsePdf(result.bytes)).length === 1,
);
check(
  "detail: 2 shows converted",
  result.showsConverted === 2 && result.glyphPaths >= 6,
  JSON.stringify({ s: result.showsConverted, g: result.glyphPaths })
);

const outDoc = parsePdf(result.bytes);
const outPages = listPages(outDoc);
const outStream = resolve(outDoc, outPages[0]!.dict.get("Contents"));
if (outStream?.k !== "stream") throw new Error("output contents missing");
const outContent = latin1All(
  decodeStreamBytes(outStream.raw, outStream.m as Map<never, never>)
);
check(
  "rewritten stream: bezier fills in, hex Tj out",
  /\bf\b/.test(outContent) && !/<[0-9A-Fa-f]+>\s*Tj/.test(outContent),
  outContent.slice(0, 120)
);

/* ------------------------------------------------------------------ */
console.log("5. Honest error — non-embedded standard font");

let noConv = "";
try {
  const doc2 = await PDFDocument.create();
  const f2 = await doc2.embedFont(StandardFonts.Helvetica);
  doc2.addPage([300, 300]).drawText("plain", { x: 20, y: 200, size: 12, font: f2 });
  runFontToOutline(new Uint8Array(await doc2.save()), { pages: "all" });
} catch (error) {
  noConv = error instanceof Error ? error.message : String(error);
}
check(
  "standard-font PDF → tool.errorNoConvertibleText",
  noConv === "tool.errorNoConvertibleText",
  noConv
);

/* ------------------------------------------------------------------ */
console.log("6. Registry + config + i18n");

const live = liveToolCount;
check("live tool count = 141 (140 + font-to-outline)", live === 141, `got ${live}`);
check(
  "config registered under font-to-outline",
  TOOL_CONFIGS["font-to-outline"]?.toolId === "font-to-outline",
);
check(
  "config: pages option, pdf output",
  foConfig.options.length === 1 && foConfig.options[0]!.kind === "pages" && foConfig.outputKind === "pdf",
);

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
const enTool = en["tool"] as Record<string, unknown>;
const hiTool = hi["tool"] as Record<string, unknown>;
const enResult = en["result"] as Record<string, unknown>;
const hiResult = hi["result"] as Record<string, unknown>;
check(
  "i18n tool.errorNoConvertibleText + result.textOutlined EN+HI",
  typeof enTool["errorNoConvertibleText"] === "string" &&
    typeof hiTool["errorNoConvertibleText"] === "string" &&
    typeof enResult["textOutlined"] === "string" &&
    typeof hiResult["textOutlined"] === "string",
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
console.log(`font-to-outline smoke: ${pass} PASS, ${fail} FAIL (of ${pass + fail})`);
if (fail > 0) process.exit(1);
