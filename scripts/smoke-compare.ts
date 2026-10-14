/**
 * PRE-BUILD smoke test for Compare PDFs (P4.8, PRD §8.5).
 * Locks the engine + the real pdf.js diff path BEFORE browser QA:
 *
 *  1. resolveCompareOptions: defaults + every field honored.
 *  2. prepareText: whitespace collapse, case folding, İ no-fold fallback.
 *  3. bigramSimilarity: identical / disjoint / partial.
 *  4. pairPages "position": surplus becomes added/removed.
 *  5. pairPages "smart": a page inserted mid-document shifts the
 *     alignment (A3..A5 snap to B4..B6, B3 alone added), and the
 *     cell-budget fallback degrades honestly.
 *  6. classifyPair: sensitivity thresholds + added/removed passthrough.
 *  7. wordDiff: prefix/suffix trims, pure add/del, ignoreCase (display
 *     casing preserved), and the LCS cell cap degrading to one big
 *     replace hunk (exact === false).
 *  8. groupHunks: context words, merge gap, kinds, honest cap.
 *  9. diffWordStats: true counts.
 * 10. pixelDiff: white/red/green/purple classes, threshold, mismatch
 *     throw, ratio math.
 * 11. buildReportLines: summary, pair table, change list, cap notes.
 * 12. classifyCompareError: password vs corrupt.
 * 13. REAL E2E (bun + @napi-rs/canvas + pdf.js): the two QA fixtures —
 *     extract texts, pair smartly (B p3 detected as the added page),
 *     word-diff p1, and render+pdiff p1 (changed) vs p2 (identical →
 *     exactly 0 changed pixels).
 *
 * Run: bun scripts/smoke-compare.ts   (exit code = failures)
 */
import { readFileSync } from "node:fs";
import type { Canvas } from "@napi-rs/canvas";
import "regenerator-runtime/runtime";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  MAX_HUNKS,
  PIXEL_THRESHOLD,
  SMART_PAIR_CELLS,
  bigramSimilarity,
  buildPairSims,
  buildReportLines,
  classifyCompareError,
  classifyPair,
  diffWordStats,
  groupHunks,
  joinPageText,
  pairPages,
  pixelDiff,
  prepareText,
  resolveCompareOptions,
  wordDiff,
  type ReportContext,
  type TextHunk,
} from "../tools/compare-pdf/engine";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    console.error(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. resolveCompareOptions                                            */
/* ------------------------------------------------------------------ */
{
  console.log("1. resolveCompareOptions");
  const d = resolveCompareOptions({});
  check(
    "defaults: medium / case / ws / smart",
    d.sensitivity === "medium" &&
      d.ignoreCase === true &&
      d.ignoreWhitespace === true &&
      d.mapping === "smart",
  );
  const full = resolveCompareOptions({
    sensitivity: "high",
    ignoreCase: false,
    ignoreWhitespace: false,
    pageMapping: "position",
  });
  check(
    "every field honored",
    full.sensitivity === "high" &&
      full.ignoreCase === false &&
      full.ignoreWhitespace === false &&
      full.mapping === "position",
  );
  const junk = resolveCompareOptions({
    sensitivity: "wild",
    pageMapping: "diagonal",
  });
  check(
    "unknown values fall back honestly",
    junk.sensitivity === "medium" && junk.mapping === "smart",
  );
}

/* ------------------------------------------------------------------ */
/* 2. prepareText                                                      */
/* ------------------------------------------------------------------ */
{
  console.log("2. prepareText");
  check(
    "whitespace collapse + trim",
    prepareText("  a   b\n\nc  ", {
      ignoreCase: false,
      ignoreWhitespace: true,
    }) === "a b c",
  );
  check(
    "whitespace kept when off",
    prepareText("  a   b  ", {
      ignoreCase: false,
      ignoreWhitespace: false,
    }) === "  a   b  ",
  );
  check(
    "case folding",
    prepareText("Hello World", { ignoreCase: true, ignoreWhitespace: true }) ===
      "hello world",
  );
  check(
    "İ expansion skips folding (honest)",
    prepareText("İstanbul", { ignoreCase: true, ignoreWhitespace: true }) ===
      "İstanbul",
  );
}

/* ------------------------------------------------------------------ */
/* 3. bigramSimilarity                                                 */
/* ------------------------------------------------------------------ */
{
  console.log("3. bigramSimilarity");
  check("identical → 1", bigramSimilarity("hello world", "hello world") === 1);
  check("empty vs empty → 1", bigramSimilarity("", "") === 1);
  check("empty vs text → 0", bigramSimilarity("", "abc") === 0);
  const disjoint = bigramSimilarity("abcd", "wxyz");
  check("disjoint → 0", disjoint === 0, `got ${disjoint}`);
  const partial = bigramSimilarity("hello world", "hello there");
  check(
    "partial in (0,1)",
    partial > 0.3 && partial < 0.9,
    `got ${partial.toFixed(3)}`,
  );
}

/* ------------------------------------------------------------------ */
/* 4. pairPages position                                               */
/* ------------------------------------------------------------------ */
{
  console.log("4. pairPages position");
  const same = pairPages(3, 3, () => 0, "position");
  check(
    "equal counts pair 1:1",
    same.pairs.length === 3 &&
      same.pairs.every((p, i) => p.a === i + 1 && p.b === i + 1),
  );
  const more = pairPages(2, 4, () => 0, "position");
  check(
    "surplus B → added tail",
    more.pairs.length === 4 &&
      more.pairs[2].a === null &&
      more.pairs[2].b === 3 &&
      more.pairs[2].kind === "added" &&
      more.pairs[3].b === 4,
  );
  const fewer = pairPages(4, 2, () => 0, "position");
  check(
    "surplus A → removed tail",
    fewer.pairs.length === 4 &&
      fewer.pairs[2].kind === "removed" &&
      fewer.pairs[2].a === 3 &&
      fewer.pairs[2].b === null,
  );
  check("position never reports smartFallback", !more.smartFallback);
}

/* ------------------------------------------------------------------ */
/* 5. pairPages smart                                                  */
/* ------------------------------------------------------------------ */
{
  console.log("5. pairPages smart");
  // A: 5 pages, B: 6 pages, B p3 inserted (unique), A3..A5 == B4..B6.
  const textsA = [
    "alpha page one with some words",
    "beta page two static content here",
    "gamma page three static annex",
    "delta page four schedule A",
    "epsilon page five signature block",
  ];
  const textsB = [
    "alpha page one with some words",
    "beta page two static content here",
    "zeta brand new inserted page content",
    "gamma page three static annex",
    "delta page four schedule A",
    "epsilon page five signature block",
  ];
  const sims = buildPairSims(textsA, textsB, {
    ignoreCase: true,
    ignoreWhitespace: true,
  });
  const plan = pairPages(textsA.length, textsB.length, (i, j) => sims[i][j], "smart");
  check("smart plan has 6 pairs (5 matches + 1 added)", plan.pairs.length === 6);
  const added = plan.pairs.filter((p) => p.kind === "added");
  check(
    "the inserted page is the ONLY added pair (b=3)",
    added.length === 1 && added[0].b === 3 && added[0].a === null,
  );
  const byA = new Map(plan.pairs.filter((p) => p.a !== null).map((p) => [p.a as number, p.b]));
  check(
    "A3..A5 snap to B4..B6 (the shift)",
    byA.get(3) === 4 && byA.get(4) === 5 && byA.get(5) === 6,
  );
  check("no removed pairs", plan.pairs.every((p) => p.kind !== "removed"));
  check("no smart fallback", !plan.smartFallback);

  // Cell budget: 300×300 > SMART_PAIR_CELLS → honest position fallback.
  const big = pairPages(300, 300, () => 1, "smart");
  check(
    "cell budget exceeded → position fallback flagged",
    big.smartFallback && big.pairs.length === 300,
  );
  const edge = pairPages(200, 200, () => 1, "smart");
  check(
    "cell budget edge (200×200 = budget) stays smart",
    !edge.smartFallback && SMART_PAIR_CELLS === 40_000,
  );
}

/* ------------------------------------------------------------------ */
/* 6. classifyPair                                                     */
/* ------------------------------------------------------------------ */
{
  console.log("6. classifyPair");
  const both = { a: 1, b: 1, kind: "both" as const };
  check("sim 1 → equal", classifyPair(both, 1, "medium") === "equal");
  check(
    "sim 0.996 at medium → equal",
    classifyPair(both, 0.996, "medium") === "equal",
  );
  check(
    "sim 0.996 at high → similar (stricter)",
    classifyPair(both, 0.996, "high") === "similar",
  );
  check(
    "sim 0.86 at medium → similar",
    classifyPair(both, 0.86, "medium") === "similar",
  );
  check(
    "sim 0.5 → different",
    classifyPair(both, 0.5, "medium") === "different",
  );
  check(
    "added/removed pass through",
    classifyPair({ a: null, b: 2, kind: "added" }, 0, "medium") === "added" &&
      classifyPair({ a: 2, b: null, kind: "removed" }, 0, "medium") ===
        "removed",
  );
}

/* ------------------------------------------------------------------ */
/* 7. wordDiff                                                         */
/* ------------------------------------------------------------------ */
{
  console.log("7. wordDiff");
  const prep = { ignoreCase: true, ignoreWhitespace: true };
  const identical = wordDiff("a b c", "a b c", prep);
  check(
    "identical → only same ops",
    identical.ops.length === 1 &&
      identical.ops[0].type === "same" &&
      identical.ops[0].tokens.join(" ") === "a b c",
  );

  const pureAdd = wordDiff("a c", "a b c", prep);
  check(
    "pure add",
    pureAdd.ops.length === 3 &&
      pureAdd.ops[0].type === "same" &&
      pureAdd.ops[1].type === "add" &&
      pureAdd.ops[1].tokens.join(" ") === "b" &&
      pureAdd.ops[2].type === "same",
  );

  const pureDel = wordDiff("a b c", "a c", prep);
  check(
    "pure del",
    pureDel.ops.length === 3 &&
      pureDel.ops[1].type === "del" &&
      pureDel.ops[1].tokens.join(" ") === "b",
  );

  const mid = wordDiff("the quick brown fox jumps", "the slow brown fox leaps", prep);
  const midStats = diffWordStats(mid.ops);
  check(
    "middle change counts",
    midStats.removed === 2 && midStats.added === 2 && mid.exact,
  );

  const cased = wordDiff("Hello World", "hello world", prep);
  check(
    "ignoreCase: no changes, display casing kept",
    cased.ops.length === 1 &&
      cased.ops[0].type === "same" &&
      cased.ops[0].tokens.join(" ") === "Hello World",
  );
  const casedStrict = wordDiff("Hello World", "hello world", {
    ignoreCase: false,
    ignoreWhitespace: true,
  });
  check(
    "case-sensitive difference caught",
    diffWordStats(casedStrict.ops).removed === 2 &&
      diffWordStats(casedStrict.ops).added === 2,
  );

  // LCS cell cap: two 2600-word disjoint middles → 6.76M cells > cap.
  const bigA = Array.from({ length: 2600 }, (_, i) => `a${i}`).join(" ");
  const bigB = Array.from({ length: 2600 }, (_, i) => `b${i}`).join(" ");
  const big = wordDiff(bigA, bigB, prep);
  check(
    "oversized middle → one big replace, exact=false",
    !big.exact &&
      big.ops.length === 2 &&
      big.ops[0].type === "del" &&
      big.ops[1].type === "add",
  );
  const within = wordDiff(
    Array.from({ length: 1500 }, (_, i) => `a${i}`).join(" "),
    Array.from({ length: 1500 }, (_, i) => `b${i}`).join(" "),
    prep,
  );
  check("1500×1500 middle stays exact (≤ cell budget)", within.exact);
}

/* ------------------------------------------------------------------ */
/* 8. groupHunks                                                       */
/* ------------------------------------------------------------------ */
{
  console.log("8. groupHunks");
  const ops = [
    { type: "same" as const, tokens: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] },
    { type: "del" as const, tokens: ["old"] },
    { type: "add" as const, tokens: ["new"] },
    { type: "same" as const, tokens: ["then", "more", "words", "here", "and", "here"] },
  ];
  const hunks = groupHunks(ops);
  check("one change hunk", hunks.length === 1);
  check(
    "kind change with context",
    hunks[0].kind === "change" &&
      hunks[0].before.includes("old") &&
      hunks[0].after.includes("new") &&
      hunks[0].before.includes("seven") &&
      hunks[0].after.includes("then"),
  );

  const apart = groupHunks([
    { type: "same" as const, tokens: Array.from({ length: 20 }, (_, i) => `w${i}`) },
    { type: "add" as const, tokens: ["x"] },
    { type: "same" as const, tokens: Array.from({ length: 20 }, (_, i) => `y${i}`) },
    { type: "del" as const, tokens: ["z"] },
  ]);
  check(
    "distant changes stay separate",
    apart.length === 2 && apart[0].kind === "add" && apart[1].kind === "del",
  );

  const pure = groupHunks([
    { type: "same" as const, tokens: ["ctx"] },
    { type: "add" as const, tokens: ["only", "added"] },
    { type: "same" as const, tokens: ["tail"] },
  ]);
  check(
    "pure addition hunk: kind add, before empty, after carries context",
    pure.length === 1 &&
      pure[0].kind === "add" &&
      pure[0].before === "" &&
      pure[0].after.includes("only added"),
  );

  const manyOps = [
    { type: "add" as const, tokens: ["a"] },
  ];
  const capped = groupHunks(manyOps, 4, 0);
  check("maxHunks=0 caps to zero hunks", capped.length === 0);

  let hunkBudgetCheck = true;
  const bigHunks = groupHunks(
    Array.from({ length: MAX_HUNKS + 5 }, (_, i) => ({
      type: (i % 2 === 0 ? "same" : "add") as "same" | "add",
      tokens: [String(i)],
    })),
    0,
  );
  if (bigHunks.length > MAX_HUNKS) hunkBudgetCheck = false;
  check("engine cap constant is 400 and respected", hunkBudgetCheck && MAX_HUNKS === 400);
}

/* ------------------------------------------------------------------ */
/* 9. diffWordStats                                                    */
/* ------------------------------------------------------------------ */
{
  console.log("9. diffWordStats");
  const stats = diffWordStats([
    { type: "same", tokens: ["a", "b"] },
    { type: "del", tokens: ["x", "y", "z"] },
    { type: "add", tokens: ["p"] },
  ]);
  check("counts only del/add", stats.removed === 3 && stats.added === 1);
}

/* ------------------------------------------------------------------ */
/* 10. pixelDiff                                                       */
/* ------------------------------------------------------------------ */
{
  console.log("10. pixelDiff");
  const px = (
    r: number,
    g: number,
    b: number,
  ): Uint8ClampedArray => new Uint8ClampedArray([r, g, b, 255]);

  const sameA = new Uint8ClampedArray([...px(0, 0, 0), ...px(255, 255, 255)]);
  const sameB = new Uint8ClampedArray([...px(0, 0, 0), ...px(255, 255, 255)]);
  const sameOut = pixelDiff(sameA, sameB, PIXEL_THRESHOLD.medium);
  check(
    "identical → all white, 0 changed",
    sameOut.changedRatio === 0 &&
      sameOut.out[0] === 255 &&
      sameOut.out[1] === 255 &&
      sameOut.out[2] === 255,
  );

  const removedInk = pixelDiff(px(0, 0, 0), px(255, 255, 255), PIXEL_THRESHOLD.medium);
  check(
    "ink only in A → red, removedRatio 1",
    removedInk.out[0] === 222 &&
      removedInk.out[1] === 52 &&
      removedInk.out[2] === 52 &&
      removedInk.removedRatio === 1 &&
      removedInk.changedRatio === 1,
  );

  const addedInk = pixelDiff(px(255, 255, 255), px(0, 0, 0), PIXEL_THRESHOLD.medium);
  check(
    "ink only in B → green",
    addedInk.out[0] === 40 && addedInk.out[1] === 160 && addedInk.out[2] === 80,
  );

  const modified = pixelDiff(px(0, 0, 0), px(10, 200, 30), PIXEL_THRESHOLD.medium);
  check(
    "ink in both, different → purple",
    modified.out[0] === 148 && modified.out[1] === 84 && modified.out[2] === 200,
  );

  const subtle = pixelDiff(px(100, 100, 100), px(104, 104, 104), PIXEL_THRESHOLD.medium);
  check(
    "delta 12 under medium threshold → white",
    subtle.changedRatio === 0,
  );
  const subtleHigh = pixelDiff(px(100, 100, 100), px(112, 112, 112), PIXEL_THRESHOLD.high);
  check(
    "delta 36 flagged at high sensitivity",
    subtleHigh.changedRatio === 1,
  );
  const subtleMed = pixelDiff(px(100, 100, 100), px(112, 112, 112), PIXEL_THRESHOLD.medium);
  check(
    "the same delta stays white at medium",
    subtleMed.changedRatio === 0,
  );

  const half = pixelDiff(
    new Uint8ClampedArray([...px(0, 0, 0), ...px(255, 255, 255)]),
    new Uint8ClampedArray([...px(255, 255, 255), ...px(255, 255, 255)]),
    PIXEL_THRESHOLD.medium,
  );
  check("ratio math over two pixels", Math.abs(half.changedRatio - 0.5) < 1e-9);

  let threw = false;
  try {
    pixelDiff(new Uint8ClampedArray(4), new Uint8ClampedArray(8), 10);
  } catch {
    threw = true;
  }
  check("length mismatch throws", threw);
}

/* ------------------------------------------------------------------ */
/* 11. buildReportLines                                                */
/* ------------------------------------------------------------------ */
{
  console.log("11. buildReportLines");
  const hunks: TextHunk[] = [
    { kind: "change", before: "total 1000", after: "total 1200" },
  ];
  const ctx: ReportContext = {
    aName: "original.pdf",
    bName: "revised.pdf",
    aPages: 2,
    bPages: 3,
    options: resolveCompareOptions({}),
    pairs: [
      { pairIndex: 0, a: 1, b: 1, status: "similar", sim: 0.91, removedWords: 1, addedWords: 1, changedRatio: 0.012 },
      { pairIndex: 1, a: null, b: 2, status: "added", sim: 0, removedWords: 0, addedWords: 12, changedRatio: null },
      { pairIndex: 2, a: 2, b: 3, status: "equal", sim: 1, removedWords: 0, addedWords: 0, changedRatio: null },
    ],
    hunks: [
      { a: 1, b: 1, hunk: hunks[0] },
      { a: null, b: 2, hunk: { kind: "add", before: "", after: "new page text" } },
    ],
    hunksCapped: false,
    imagesCapped: true,
  };
  const lines = buildReportLines(ctx).join("\n");
  check("summary names both files", lines.includes("original.pdf") && lines.includes("revised.pdf"));
  check(
    "pair counts line",
    lines.includes("1 same, 1 minor, 0 changed, 1 added, 0 removed"),
  );
  check("pair table row with words", lines.includes("words -1/+1"));
  check("pair table row with pixels", lines.includes("1.20% of pixels differ"));
  check("hunk − and + lines", lines.includes("- total 1000") && lines.includes("+ total 1200"));
  check("added page hunk line", lines.includes("+ new page text"));
  check("image cap note present", lines.includes("NOTES:") && lines.includes("capped"));
}

/* ------------------------------------------------------------------ */
/* 12. classifyCompareError                                             */
/* ------------------------------------------------------------------ */
{
  console.log("12. classifyCompareError");
  check("password → encrypted", classifyCompareError("PasswordException: bad") === "tool.errorEncrypted");
  check("other → corrupt", classifyCompareError("Invalid PDF structure") === "tool.errorCorrupt");
}

/* ------------------------------------------------------------------ */
/* 13. REAL E2E — the QA fixtures through pdf.js                       */
/* ------------------------------------------------------------------ */
{
  console.log("13. REAL E2E (fixtures + pdf.js)");
  const canvasMod = await import("@napi-rs/canvas");
  (globalThis as Record<string, unknown>).Path2D = canvasMod.Path2D;
  (globalThis as Record<string, unknown>).Image = canvasMod.Image;

  const pdfOpen = async (bytes: Uint8Array) =>
    getDocument({
      data: bytes,
      useSystemFonts: true,
      ownerDocument: {
        createElement: () => canvasMod.createCanvas(1, 1),
      } as unknown as HTMLDocument,
    }).promise;

  const bytesA = new Uint8Array(readFileSync("public/qa/qa-compare-a.pdf"));
  const bytesB = new Uint8Array(readFileSync("public/qa/qa-compare-b.pdf"));
  const docA = await pdfOpen(bytesA);
  const docB = await pdfOpen(bytesB);
  check("fixture A has 5 pages", docA.numPages === 5);
  check("fixture B has 6 pages", docB.numPages === 6);

  const textsOf = async (doc: typeof docA): Promise<string[]> => {
    const out: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      page.cleanup();
      out.push(joinPageText(content.items as never));
    }
    return out;
  };
  const textsA = await textsOf(docA);
  const textsB = await textsOf(docB);
  check(
    "Hindi extracts from the embedded Noto (pdf.js visual order)",
    textsA[0].includes("धन्यवाद") &&
      textsA[0].includes("1000") &&
      textsB[0].includes("1200") &&
      textsA[0].length > 60,
  );

  const sims = buildPairSims(textsA, textsB, {
    ignoreCase: true,
    ignoreWhitespace: true,
  });
  const plan = pairPages(5, 6, (i, j) => sims[i][j], "smart");
  const added = plan.pairs.filter((p) => p.kind === "added");
  check(
    "smart: B p3 is the single added page",
    added.length === 1 && added[0].b === 3,
    `pairs: ${plan.pairs.map((p) => `${p.a ?? "-"}:${p.b ?? "-"}`).join(" ")}`,
  );
  const byA = new Map(
    plan.pairs.filter((p) => p.a !== null).map((p) => [p.a as number, p.b]),
  );
  check(
    "smart: A3→B4, A4→B5, A5→B6",
    byA.get(3) === 4 && byA.get(4) === 5 && byA.get(5) === 6,
  );

  const simP1 = sims[0][0];
  check(
    "p1 similar (not equal)",
    simP1 >= 0.6 && simP1 < 0.995,
    `sim ${simP1.toFixed(3)}`,
  );
  check("p2 equal (sim 1)", sims[1][1] === 1);
  check("A3↔B4 equal (the shift target)", sims[2][3] === 1);

  const diff1 = wordDiff(textsA[0], textsB[0], {
    ignoreCase: true,
    ignoreWhitespace: true,
  });
  const stats1 = diffWordStats(diff1.ops);
  check(
    "p1 word diff finds both directions",
    stats1.removed >= 2 && stats1.added >= 2,
    `−${stats1.removed}/+${stats1.added}`,
  );
  const diff2 = wordDiff(textsA[1], textsB[1], {
    ignoreCase: true,
    ignoreWhitespace: true,
  });
  check("p2 word diff is empty", diffWordStats(diff2.ops).removed === 0 && diffWordStats(diff2.ops).added === 0);

  // Render + pixel diff — p1 changed, p2 identical.
  const renderPage = async (
    doc: typeof docA,
    page: number,
  ): Promise<{ w: number; h: number; data: Uint8ClampedArray }> => {
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 100 / 72 });
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const canvas = canvasMod.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    await pdfPage.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    pdfPage.cleanup();
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  };

  const imgA1 = await renderPage(docA, 1);
  const imgB1 = await renderPage(docB, 1);
  check("render grids match", imgA1.w === imgB1.w && imgA1.h === imgB1.h);
  const out1 = pixelDiff(imgA1.data, imgB1.data, PIXEL_THRESHOLD.medium);
  check(
    "p1 changed pixels in (0, 0.2)",
    out1.changedRatio > 0.0005 && out1.changedRatio < 0.2,
    `${(out1.changedRatio * 100).toFixed(2)}%`,
  );
  check(
    "p1 diff has removed AND added classes",
    out1.removedRatio > 0 && out1.addedRatio > 0,
  );

  const imgA2 = await renderPage(docA, 2);
  const imgB2 = await renderPage(docB, 2);
  const out2 = pixelDiff(imgA2.data, imgB2.data, PIXEL_THRESHOLD.medium);
  check(
    "identical pages → exactly 0 changed pixels",
    out2.changedRatio === 0,
    `${(out2.changedRatio * 100).toFixed(3)}%`,
  );

  const out2High = pixelDiff(imgA2.data, imgB2.data, PIXEL_THRESHOLD.high);
  check(
    "identical pages stay 0 even at high sensitivity",
    out2High.changedRatio === 0,
  );

  await docA.destroy();
  await docB.destroy();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
