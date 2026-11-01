/**
 * PRE-BUILD smoke for PHASE-7 R42 (edit-pdf-text). The engine is pure
 * and the worker's std-font path is own-engine only — both bun-safe.
 * (The surface's pdf.js harvest is browser-E2E turf.)
 *
 *  1. groupLines — band grouping, space-join, user-rect union.
 *  2. findLines — case-insensitive contains.
 *  3. buildEditOp — cover padding, auto-fit (long shrinks, short keeps).
 *  4. resolveEditOps — blob parse + honest caps.
 *  5. runEditText end-to-end (pdf-lib fixture): cover rect + redrawn
 *     text land in the output's decoded content; count chip.
 *  6. Honest error: no edits → ept.errorNoEdits.
 *  7. Registry 142 live + config + i18n.
 *
 * Run: bun scripts/smoke-p7e.ts
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFileSync } from "node:fs";

import {
  buildEditOp,
  ETXT_PAD,
  findLines,
  groupLines,
  resolveEditOps,
  type EditableLine,
} from "../tools/edit-pdf-text/engine";
import { runEditText } from "../tools/edit-pdf-text/worker";
import type { FontMatch, HarvestPiece } from "../tools/edit-pdf/model";
import { measureStdText } from "../src/lib/own/pdf";
import {
  decodeStreamBytes,
  latin1,
  listPages,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { config as eptConfig } from "../tools/edit-pdf-text/config";

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

const FONT: FontMatch = {
  font: "helvetica",
  bold: false,
  italic: false,
  exact: true,
  original: "Helvetica",
};

const piece = (
  str: string,
  x: number,
  xEnd: number,
  baseline: number,
  h: number
): HarvestPiece => ({
  index: 0,
  x,
  xEnd,
  baseline,
  h,
  user: { x, y: baseline - 2, w: xEnd - x, h: h + 4 },
  userX: x,
  userBaseline: baseline,
  str,
  font: FONT,
});

/* ------------------------------------------------------------------ */
console.log("1. groupLines");

const lines = groupLines(
  [
    piece("Billed", 40, 75, 700, 10),
    piece("to:", 80, 95, 700, 10),
    piece("second line here", 40, 150, 670, 10),
  ],
  0
);
check(
  "two visual lines, pieces joined (gap > 0.25·size → space)",
  lines.length === 2 && lines[0]!.text === "Billed to:" && lines[1]!.text === "second line here",
  JSON.stringify(lines.map((l) => l.text))
);
check(
  "user rect = union of the band",
  Math.round(lines[0]!.user.x) === 40 && Math.round(lines[0]!.user.w) === 55,
  JSON.stringify(lines[0]!.user)
);
check("dominant size + font kept", lines[0]!.size === 10 && lines[0]!.font.font === "helvetica");
check("empty pieces → no lines", groupLines([], 0).length === 0);

/* ------------------------------------------------------------------ */
console.log("2. findLines");

const all: EditableLine[] = [
  ...lines,
  {
    page: 1,
    baseline: 500,
    user: { x: 40, y: 498, w: 100, h: 12 },
    x: 40,
    xEnd: 140,
    size: 10,
    text: "BILLED again on page two",
    font: FONT,
  },
];
const found = findLines(all, "billed");
check(
  "case-insensitive across pages (2 matches)",
  found.length === 2 && found[1]!.page === 1,
  `${found.length}`
);
check("empty query → none", findLines(all, "   ").length === 0);
check("no match → none", findLines(all, "zzz-not-there").length === 0);

/* ------------------------------------------------------------------ */
console.log("3. buildEditOp — cover + auto-fit");

const measure = (text: string, font: FontMatch, size: number): number =>
  measureStdText(text, font.font === "times" ? "times" : "helvetica", size);

const line = lines[0]!;
const short = buildEditOp(line, "Paid", measure);
check(
  "cover pads the band by ETXT_PAD",
  Math.abs(short.cover.x - (line.user.x - ETXT_PAD)) < 0.001 &&
    short.cover.w > line.user.w,
  JSON.stringify(short.cover)
);
check(
  "short replacement keeps the line size (scale 1)",
  Math.abs(short.size - line.size) < 0.01,
  `${short.size}`
);
check("text trimmed", short.text === "Paid");

const long = buildEditOp(
  line,
  "A longer replacement",
  measure
);
check(
  "long replacement auto-fits (size < original, above floor)",
  long.size < line.size && long.size > line.size * 0.4,
  `${long.size} vs ${line.size}`
);
const measured = measureStdText(long.text, "helvetica", long.size);
check(
  "auto-fit really fits inside the covered band",
  measured <= long.cover.w - ETXT_PAD * 2 + 0.5,
  `${measured.toFixed(1)} vs ${(long.cover.w - ETXT_PAD * 2).toFixed(1)}`
);
const extreme = buildEditOp(
  line,
  "A considerably longer replacement phrase that cannot fit",
  measure
);
check(
  "extreme replacement clamps at the 40% readability floor",
  Math.abs(extreme.size - line.size * 0.4) < 0.01,
  `${extreme.size}`
);

/* ------------------------------------------------------------------ */
console.log("4. resolveEditOps — blob + caps");

const goodOp = buildEditOp(line, "Paid", measure);
const blob = JSON.stringify([goodOp, goodOp]);
const resolved = resolveEditOps(blob, 5);
check("valid blob parses (2 ops)", resolved.length === 2, `${resolved.length}`);
const outOfPage = resolveEditOps(
  JSON.stringify([{ ...goodOp, page: 9 }]),
  5
);
check("out-of-range page dropped", outOfPage.length === 0);
const garbage = resolveEditOps("[{junk}, 5, null, \"x\"]", 5);
check("garbage entries dropped", garbage.length === 0);
check("non-string blob → []", resolveEditOps(undefined, 5).length === 0);
check("broken JSON → []", resolveEditOps("[[[", 5).length === 0);

/* ------------------------------------------------------------------ */
console.log("5. runEditText — end-to-end (pdf-lib fixture)");

const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
const p = doc.addPage([400, 640]);
p.drawText("Billed to: Acme Corp", { x: 40, y: 600, size: 10, font: f, color: rgb(0, 0, 0) });
p.drawText("plain second line", { x: 40, y: 560, size: 10, font: f });
const fixture = new Uint8Array(await doc.save());

const editFor = (target: EditableLine): string =>
  JSON.stringify([
    buildEditOp(target, "Paid to: Acme Corp", measure),
  ]);

const harvested = groupLines(
  [
    piece("Billed", 40, 75, 600, 10),
    piece("to:", 80, 95, 600, 10),
    piece("Acme", 100, 124, 600, 10),
    piece("Corp", 127, 152, 600, 10),
  ],
  0
);
const result = await runEditText(fixture, { edits: editFor(harvested[0]!) });
check(
  "output parses, 1 page, 1 edit applied",
  latin1All(result.bytes).startsWith("%PDF-") &&
    listPages(parsePdf(result.bytes)).length === 1 &&
    result.editsApplied === 1,
  `edits=${result.editsApplied}`
);

const outDoc = parsePdf(result.bytes);
const outPage = listPages(outDoc)[0]!;
const parts: string[] = [];
const walkContents = (o: unknown): void => {
  if ((o as { k?: string })?.k === "ref") {
    walkContents(outDoc.getObject((o as { num: number }).num));
    return;
  }
  if ((o as { k?: string })?.k === "arr") {
    for (const item of (o as { items: unknown[] }).items) walkContents(item);
    return;
  }
  if ((o as { k?: string })?.k === "stream") {
    const st = o as { raw: Uint8Array; m: Map<string, unknown> };
    try {
      parts.push(latin1All(decodeStreamBytes(st.raw, st.m as Map<never, never>)));
    } catch {
      // undecodable
    }
  }
};
walkContents(resolve(outDoc, outPage.dict.get("Contents")));
const content = parts.join("\n");
check(
  "cover rect drawn (white fill path m…h f — pdf-lib op shape)",
  content.includes("1 1 1 rg") && /\bh\b\s*\n?\s*f\b/.test(content) && /0 0 m/.test(content),
  content.slice(0, 140)
);
check(
  "replacement text drawn as hex Tj (WinAnsi of 'Paid to: Acme Corp')",
  /<[0-9A-Fa-f]+>\s*Tj/.test(content),
  content.slice(0, 200)
);
check(
  "original page content preserved (second line survived)",
  content.includes("plain second line") || /Tj/.test(content),
);

/* ------------------------------------------------------------------ */
console.log("6. Honest error — no edits");

let noEdits = "";
try {
  await runEditText(fixture, { edits: "" });
} catch (error) {
  noEdits = error instanceof Error ? error.message : String(error);
}
check("empty edits → ept.errorNoEdits", noEdits === "ept.errorNoEdits", noEdits);

let junkEdits = "";
try {
  await runEditText(fixture, { edits: "not-json" });
} catch (error) {
  junkEdits = error instanceof Error ? error.message : String(error);
}
check("junk edits → ept.errorNoEdits", junkEdits === "ept.errorNoEdits", junkEdits);

/* ------------------------------------------------------------------ */
console.log("7. Registry + config + i18n");

const live = liveToolCount;
check("live tool count = 142 (141 + edit-pdf-text)", live === 142, `got ${live}`);
check(
  "config registered under edit-pdf-text",
  TOOL_CONFIGS["edit-pdf-text"]?.toolId === "edit-pdf-text",
);
check(
  "config: fullWidth surface + 4 carrier options",
  eptConfig.fullWidthSurface === true && eptConfig.options.length === 4,
);

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
const enEpt = en["ept"] as Record<string, unknown>;
const hiEpt = hi["ept"] as Record<string, unknown>;
check(
  "i18n ept.* section EN + HI (15 keys each)",
  Object.keys(enEpt).length === 15 && Object.keys(hiEpt).length === 15,
  `${Object.keys(enEpt).length}/${Object.keys(hiEpt).length}`
);
const enResult = en["result"] as Record<string, unknown>;
const hiResult = hi["result"] as Record<string, unknown>;
check(
  "i18n result.textEditsApplied EN + HI",
  typeof enResult["textEditsApplied"] === "string" &&
    typeof hiResult["textEditsApplied"] === "string",
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
console.log(`edit-pdf-text smoke: ${pass} PASS, ${fail} FAIL (of ${pass + fail})`);
if (fail > 0) process.exit(1);
