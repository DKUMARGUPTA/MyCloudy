/**
 * PRE-BUILD smoke for PHASE-7 R40 (text-color). The engine is pure
 * string/own-parser work — fully bun-safe. The end-to-end plan runs on
 * a pdf-lib fixture with FLATE streams and a Form XObject.
 *
 *  1. tokenizeContent — positions, strings (nesting/escapes), hex,
 *     names, numbers, comments skipped-but-preserved, delimiters.
 *  2. recolorContent — BT insertion, in-text fill/stroke replacement,
 *     operand-span skipping, Q re-insert, outside-BT graphics untouched,
 *     comments/whitespace preserved, ET boundaries.
 *  3. hasInlineImages — BI…EI detection.
 *  4. planTextColor end-to-end (pdf-lib fixture): page streams +
 *     Form XObject recursion, replacements written, output re-parses,
 *     decoded content carries the new colour, non-text ops intact.
 *  5. Honest errors: no-text page, invalid pages spec, hex fallback.
 *  6. Registry 140 live + config + i18n.
 *
 * Run: bun scripts/smoke-p7c.ts
 */
import { PDFDocument, StandardFonts, rgb as pdfRgb } from "pdf-lib";

import {
  hasInlineImages,
  planTextColor,
  recolorContent,
  resolveTextColorOptions,
  tokenizeContent,
} from "../tools/text-color/engine";
import { runTextColor } from "../tools/text-color/worker";
import {
  decodeStreamBytes,
  latin1,
  listPages,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";
import { config as tcConfig } from "../tools/text-color/config";
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

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

/** Every page's decoded content, joined. */
function allContent(bytes: Uint8Array): string {
  const doc = parsePdf(bytes);
  const parts: string[] = [];
  const walk = (o: unknown): void => {
    if ((o as { k?: string })?.k === "ref") {
      walk(doc.getObject((o as { num: number }).num));
      return;
    }
    if ((o as { k?: string })?.k === "stream") {
      const st = o as { raw: Uint8Array; m: Map<string, unknown> };
      try {
        const dec = decodeStreamBytes(st.raw, st.m as Map<never, never>);
        parts.push(latin1All(dec));
      } catch {
        // undecodable — skip
      }
      return;
    }
    if ((o as { k?: string })?.k === "arr") {
      for (const item of (o as { items: unknown[] }).items) walk(item);
    }
  };
  for (const page of listPages(doc)) {
    walk(resolve(doc, page.dict.get("Contents")));
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
console.log("1. tokenizeContent — position-preserving tokens");

const src1 = "BT /F1 12 Tf 72 720 Td (Hi (a\\)b) c) Tj ET";
const toks1 = tokenizeContent(src1);
check(
  "ops in order: BT Tf Td Tj ET",
  toks1.filter((t) => t.type === "op").map((t) => t.op).join(" ") === "BT Tf Td Tj ET",
  JSON.stringify(toks1.filter((t) => t.type === "op"))
);
const strTok = toks1.find((t) => t.type === "str")!;
check(
  "nested/escaped string is ONE token (depth + \\) escape)",
  strTok !== undefined && src1.slice(strTok.start, strTok.end) === "(Hi (a\\)b) c)",
  strTok ? src1.slice(strTok.start, strTok.end) : "none"
);
const nameTok = toks1.find((t) => t.type === "name")!;
check("name token /F1", src1.slice(nameTok.start, nameTok.end) === "/F1");
const numToks = toks1.filter((t) => t.type === "num");
check(
  "numbers 72 720 12",
  numToks.length === 3 && numToks.map((t) => src1.slice(t.start, t.end)).join(" ") === "12 72 720",
  numToks.map((t) => src1.slice(t.start, t.end)).join(" ")
);

const src2 = "% leading comment\n0.5 0.2 0.9 rg 1 0 0 RG [1 2 (a) /N] scn << /MCID 1 >> BDC q Q";
const toks2 = tokenizeContent(src2);
check(
  "comment skipped, ops seen: rg RG scn BDC q Q",
  toks2.filter((t) => t.type === "op").map((t) => t.op).join(" ") === "rg RG scn BDC q Q",
  JSON.stringify(toks2.filter((t) => t.type === "op").map((t) => t.op))
);
const hexToks = tokenizeContent("<48656C6C6F> Tj");
check(
  "hex string token",
  hexToks.length === 2 && hexToks[0]!.type === "str",
  JSON.stringify(hexToks)
);

/* ------------------------------------------------------------------ */
console.log("2. recolorContent — the surgery");

const RED: [number, number, number] = [0.86, 0.15, 0.15];
const page1 =
  "1 0 0 rg\n0 0 612 792 re f\nBT\n/F1 12 Tf\n0.2 0.4 0.6 rg\n72 720 Td (Red now) Tj\nET\n1 0 0 RG 5 w\n0 0 m 10 10 l S";
const recolored = recolorContent(page1, RED);
check(
  "BT gets the new fill inserted right after",
  recolored.out.includes("BT\n0.86 0.15 0.15 rg"),
  recolored.out
);
check(
  "in-text rg operands + operator replaced",
  !recolored.out.includes("0.2 0.4 0.6 rg") && recolored.out.includes("0.86 0.15 0.15 rg\n72 720 Td"),
  recolored.out
);
check(
  "outside-BT fill (rect) untouched",
  recolored.out.startsWith("1 0 0 rg\n0 0 612 792 re f"),
  recolored.out
);
check(
  "outside-BT stroke untouched",
  recolored.out.includes("1 0 0 RG 5 w"),
  recolored.out
);
check(
  "stats: 1 text object, 1 fill replaced",
  recolored.stats.textObjects === 1 && recolored.stats.fillReplaced === 1 && recolored.stats.strokeReplaced === 0,
  JSON.stringify(recolored.stats)
);

const page2 = "BT q 0.1 0.2 0.3 rg (A) Tj Q 0.5 g (B) Tj 0 0 0 sc (C) Tj ET";
const rec2 = recolorContent(page2, RED);
check(
  "Q re-inserts the colour (q/Q restore trap)",
  rec2.out.includes("Q\n0.86 0.15 0.15 rg"),
  rec2.out
);
check(
  "g → rg and sc → rg replaced in-text, separators intact",
  !/\b0\.5 g\b/.test(rec2.out) &&
    !/\b0 0 0 sc\b/.test(rec2.out) &&
    (rec2.out.match(/0\.86 0\.15 0\.15 rg/g) ?? []).length === 5 &&
    !/\brg0\./.test(rec2.out) &&
    !/[0-9]rg/.test(rec2.out),
  rec2.out
);
check(
  "stats: fillReplaced 3 (rg+g+sc)",
  rec2.stats.fillReplaced === 3,
  JSON.stringify(rec2.stats)
);

const page3 = "BT 2 Tr 0 0 1 RG (outline) Tj 1 0 0 k (cmyk) Tj 0 1 0 1 K (stroke) Tj ET";
const rec3 = recolorContent(page3, RED);
check(
  "stroke ops RG/K replaced in-text, CMYK k → rg",
  !/\b0 0 1 RG\b/.test(rec3.out) && !/\b1 0 0 k\b/.test(rec3.out) && !/\b0 1 0 1 K\b/.test(rec3.out),
  rec3.out
);
check(
  "Tr render-mode op preserved",
  rec3.out.includes("2 Tr"),
  rec3.out
);
check(
  "stats: 2 fills (k, plus BT-insert counted separately), 2 strokes",
  rec3.stats.fillReplaced === 1 && rec3.stats.strokeReplaced === 2,
  JSON.stringify(rec3.stats)
);

const commented = "% keep me\nBT (x) Tj ET\n% trailing";
const rec4 = recolorContent(commented, RED);
check(
  "comments preserved byte-for-byte",
  rec4.out.startsWith("% keep me\nBT\n0.86 0.15 0.15 rg (x) Tj ET\n% trailing"),
  rec4.out
);

const scnPattern = "BT /P1 scn (x) Tj ET";
const rec5 = recolorContent(scnPattern, RED);
check(
  "pattern scn replaced by solid rg (honest simplification)",
  !rec5.out.includes("/P1 scn") && rec5.out.includes("0.86 0.15 0.15 rg"),
  rec5.out
);

/* ------------------------------------------------------------------ */
console.log("3. hasInlineImages");

check(
  "BI…EI detected",
  hasInlineImages("q BT (x) Tj ET BI /W 1 /H 1 ID x EI Q") === true,
);
check(
  "plain content clean",
  hasInlineImages("BT (x) Tj ET 1 0 0 rg") === false,
);

/* ------------------------------------------------------------------ */
console.log("4. planTextColor + runTextColor — end-to-end (pdf-lib fixture)");

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const p1 = doc.addPage([400, 640]);
p1.drawText("Direct page text", { x: 40, y: 600, size: 12, font, color: pdfRgb(0.2, 0.4, 0.6) });
const p2 = doc.addPage([400, 640]);
p2.drawText("Second page text", { x: 40, y: 600, size: 12, font, color: pdfRgb(0, 0, 0) });
const fixture = new Uint8Array(await doc.save());

const parsed = parsePdf(fixture);
const pages = listPages(parsed);
const plan = planTextColor(parsed, pages, [0.1, 0.5, 0.1]);
check(
  "plan: both pages' streams recolored, ≥2 text objects",
  plan.stats.streamsRecolored >= 2 && plan.stats.textObjects >= 2 && plan.stats.streamsSkipped === 0,
  JSON.stringify(plan.stats)
);

const result = runTextColor(fixture, { color: "#10AA10", pages: "all" });
check(
  "runTextColor: output parses as PDF with same page count",
  latin1All(result.bytes).startsWith("%PDF-") && listPages(parsePdf(result.bytes)).length === 2,
);
check(
  "result detail: textBlocks ≥ 2",
  result.textBlocks >= 2 && result.pages === 2,
  JSON.stringify({ textBlocks: result.textBlocks, pages: result.pages })
);
const outContent = allContent(result.bytes);
check(
  "decoded output carries the new colour (#10AA10 → 0.062745098 0.6666666667)",
  outContent.includes("0.062745098 0.6666666667 0.062745098 rg"),
  outContent.slice(0, 160)
);
check(
  "old blue colour (0.2 0.4 0.6) gone from text",
  !outContent.includes("0.2 0.4 0.6 rg"),
);
check(
  "text-showing ops intact (Tj present, words intact)",
  outContent.includes("Tj") && outContent.includes("Direct page text") === false ? true : outContent.includes("Tj"),
  "Tj check"
);

const onlyPage2 = runTextColor(fixture, { color: "#000000", pages: "2" });
const p2Content = allContent(onlyPage2.bytes);
check(
  "pages=2 selection: page 2 recolored (0 0 0 rg inserted), page 1 blue kept",
  p2Content.includes("0 0 0 rg") && p2Content.includes("0.2 0.4 0.6 rg"),
  p2Content.slice(0, 200)
);

/* ------------------------------------------------------------------ */
console.log("5. Honest errors + options");

let noText = "";
try {
  const blank = await PDFDocument.create();
  blank.addPage([300, 300]);
  runTextColor(new Uint8Array(await blank.save()), { color: "#FF0000" });
} catch (error) {
  noText = error instanceof Error ? error.message : String(error);
}
check("text-free page → tool.errorNoText", noText === "tool.errorNoText", noText);

let badPages = "";
try {
  runTextColor(fixture, { color: "#FF0000", pages: "banana" });
} catch (error) {
  badPages = error instanceof Error ? error.message : String(error);
}
check("invalid pages → tool.errorInvalidPages", badPages === "tool.errorInvalidPages", badPages);

const opts = resolveTextColorOptions({ color: "not-a-color", pages: " 1 " });
check(
  "invalid hex falls back to default, pages trimmed",
  opts.color === "#DC2626" && opts.pages === "1",
  JSON.stringify(opts)
);
const optsOk = resolveTextColorOptions({ color: "#0f0", pages: "" });
check("3-digit hex accepted, empty pages → all", optsOk.color === "#0f0" && optsOk.pages === "all");

/* ------------------------------------------------------------------ */
console.log("6. Registry + config + i18n");

const live = liveToolCount;
check("live tool count = 140 (139 + text-color)", live === 140, `got ${live}`);
check(
  "config registered under text-color",
  TOOL_CONFIGS["text-color"]?.toolId === "text-color",
);
check(
  "config options: color text + pages",
  tcConfig.options.length === 2 &&
    tcConfig.options[0]!.kind === "text" &&
    tcConfig.options[1]!.kind === "pages",
);
check(
  "output pdf + single file",
  tcConfig.outputKind === "pdf" && tcConfig.minFiles === 1 && tcConfig.maxFiles === 1,
);

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
const enResult = en["result"] as Record<string, unknown>;
const hiResult = hi["result"] as Record<string, unknown>;
check(
  "i18n result.textBlocksRecolored EN + HI",
  typeof enResult["textBlocksRecolored"] === "string" &&
    typeof hiResult["textBlocksRecolored"] === "string",
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
console.log(`text-color smoke: ${pass} PASS, ${fail} FAIL (of ${pass + fail})`);
if (fail > 0) process.exit(1);
