/**
 * PRE-BUILD smoke test for the Pages per sheet (N-up) tool (P4.1). Proves the
 * engine math BEFORE any UI is written (the P3.3 lesson — pin the engine,
 * then build on it), then drives the REAL worker code end-to-end:
 *
 *  1. Grid mapping for every layout + orientation (2 → 1×2 / 2×1, 6 → 2×3 /
 *     3×2, square layouts invariant).
 *  2. Cell geometry: margins/spacing in mm → exact pt cells (hand-computed).
 *  3. Sheet counts (7 pages @ 4-up = 2 sheets; 16 @ 16-up = 1).
 *  4. Row vs column order produces the mirrored cell sequence.
 *  5. Clamps: margin/spacing ≥ 0 and ≤ sheet/4, tiny "match" sheets keep a
 *     6pt minimum cell.
 *  6. embedPlacement /Rotate math (pdf-lib's embedPage does NOT apply
 *     /Rotate — the draw anchor shifts per angle; verified by hand and then
 *     by rendering the real output with pdf.js).
 *  7. E2E with the real worker: mixed-size fixture + /Rotate 90 page +
 *     non-zero MediaBox origin, pdf.js structural checks (page count, sheet
 *     size) + PIXEL samples (rotated content lands in the planned display
 *     box), border strokes in the decoded content stream, "match" sheets,
 *     error codes (encrypted / corrupt / invalid range).
 *
 * Run: bun scripts/smoke-nup.ts
 */
import { writeFile } from "node:fs/promises";

import { PDFDocument, degrees, rgb } from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  A4_PT,
  MM_TO_PT,
  NUP_DEFAULTS,
  NUP_IDS,
  embedPlacement,
  gridForLayout,
  planSheets,
  sheetMetrics,
  sheetSizePt,
} from "../tools/pages-per-sheet/engine";
import { NupRunError, runNup } from "../tools/pages-per-sheet/worker";

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

function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

/** Renders an output page with pdf.js + @napi-rs/canvas and samples pixels. */
async function openWithPdfjs(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist");
  return getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

async function renderPage(
  bytes: Uint8Array,
  pageNumber: number
): Promise<{ width: number; height: number; darkAt: (x: number, y: number) => boolean; luminance: (x: number, y: number) => number }> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await openWithPdfjs(bytes);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return {
    width: canvas.width,
    height: canvas.height,
    darkAt: (x: number, y: number) => {
      const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
      return data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90;
    },
    luminance: (x: number, y: number) => {
      const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
      return (data[i] + data[i + 1] + data[i + 2]) / 3;
    },
  };
}

/** Builds the mixed-size fixture: 2×(400×300, one /Rotate 90) + A4 + offset box. */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const black = rgb(0, 0, 0);

  // p0: 400x300, rot 0, black on the LEFT half of the display.
  const p0 = doc.addPage([400, 300]);
  p0.drawRectangle({ x: 0, y: 0, width: 200, height: 300, color: black });

  // p1: 400x300 with /Rotate 90 (displays 300x400). Black user band
  // y<150 = the DISPLAY left half (displayToUser(90): user y = dx).
  const p1 = doc.addPage([400, 300]);
  p1.setRotation(degrees(90));
  p1.drawRectangle({ x: 0, y: 0, width: 400, height: 150, color: black });

  // p2: plain A4, no content (an empty cell on the sheet).
  doc.addPage([A4_PT.w, A4_PT.h]);

  // p3: non-zero MediaBox origin [20,30,420,630] (400x600), black on the
  // display-left half (user x in [20,220]).
  const p3 = doc.addPage([400, 600]);
  p3.setMediaBox(20, 30, 420, 630);
  p3.drawRectangle({ x: 20, y: 30, width: 200, height: 600, color: black });

  return doc.save({ useObjectStreams: true });
}

function values(overrides: Record<string, string | number | boolean>): OptionValues {
  return {
    [NUP_IDS.layout]: NUP_DEFAULTS.layout,
    [NUP_IDS.sheetSize]: NUP_DEFAULTS.sheetSize,
    [NUP_IDS.orientation]: NUP_DEFAULTS.orientation,
    [NUP_IDS.order]: NUP_DEFAULTS.order,
    [NUP_IDS.margin]: NUP_DEFAULTS.marginMM,
    [NUP_IDS.spacing]: NUP_DEFAULTS.spacingMM,
    [NUP_IDS.borders]: NUP_DEFAULTS.borders,
    [NUP_IDS.pages]: NUP_DEFAULTS.pages,
    ...overrides,
  };
}

async function main(): Promise<void> {
  /* -------------------------------------------------------------- */
  console.log("\n1. Pure engine — grid mapping");
  check(
    "layout 2: portrait 1x2 / landscape 2x1",
    gridForLayout(2, "portrait").cols === 1 &&
      gridForLayout(2, "portrait").rows === 2 &&
      gridForLayout(2, "landscape").cols === 2 &&
      gridForLayout(2, "landscape").rows === 1
  );
  check(
    "layout 6: portrait 2x3 / landscape 3x2",
    gridForLayout(6, "portrait").cols === 2 &&
      gridForLayout(6, "portrait").rows === 3 &&
      gridForLayout(6, "landscape").cols === 3 &&
      gridForLayout(6, "landscape").rows === 2
  );
  const square =
    gridForLayout(4, "portrait").cols === 2 &&
    gridForLayout(4, "landscape").rows === 2 &&
    gridForLayout(9, "portrait").cols === 3 &&
    gridForLayout(9, "landscape").rows === 3 &&
    gridForLayout(16, "portrait").cols === 4 &&
    gridForLayout(16, "landscape").rows === 4;
  check("layouts 4/9/16 are 2x2 / 3x3 / 4x4 in both orientations", square);

  /* -------------------------------------------------------------- */
  console.log("\n2. Pure engine — cell geometry (A4, 8mm margin, 4mm spacing)");
  const margin8 = 8 * MM_TO_PT;
  const spacing4 = 4 * MM_TO_PT;
  const m4 = sheetMetrics(A4_PT.w, A4_PT.h, 2, 2, 8, 4);
  const cellW4 = (A4_PT.w - 2 * margin8 - spacing4) / 2;
  const cellH4 = (A4_PT.h - 2 * margin8 - spacing4) / 2;
  check(
    "4-up A4 metrics: margin/spacing/cellW/cellH exact",
    near(m4.margin, margin8) &&
      near(m4.spacing, spacing4) &&
      near(m4.cellW, cellW4) &&
      near(m4.cellH, cellH4),
    `got margin=${m4.margin} spacing=${m4.spacing} cellW=${m4.cellW} cellH=${m4.cellH}`
  );
  const plan4 = planSheets(
    4,
    { ...NUP_DEFAULTS, layout: 4 },
    null
  );
  const bottomLeft = plan4.sheets[0].cells.find((c) => c.col === 0 && c.row === 1);
  const topRight = plan4.sheets[0].cells.find((c) => c.col === 1 && c.row === 0);
  check(
    "cell anchors: bottom-left at (m,m), top-right at (m+cw+s, m+ch+s)",
    bottomLeft !== undefined &&
      topRight !== undefined &&
      near(bottomLeft.x, margin8) &&
      near(bottomLeft.y, margin8) &&
      near(topRight.x, margin8 + cellW4 + spacing4) &&
      near(topRight.y, margin8 + cellH4 + spacing4),
    `bottomLeft=(${bottomLeft?.x},${bottomLeft?.y}) topRight=(${topRight?.x},${topRight?.y})`
  );
  check(
    "portrait sheet size 595.28x841.89 / landscape swapped",
    near(sheetSizePt("a4", "portrait", null).w, A4_PT.w) &&
      near(sheetSizePt("letter", "portrait", null).h, 792) &&
      near(sheetSizePt("a4", "landscape", null).w, A4_PT.h) &&
      near(sheetSizePt("match", "landscape", { w: 300, h: 400 }).w, 400)
  );

  /* -------------------------------------------------------------- */
  console.log("\n3. Pure engine — sheet counts");
  check(
    "7 pages @ 4-up = 2 sheets (4+3 cells)",
    planSheets(7, { ...NUP_DEFAULTS, layout: 4 }, null).sheets.length === 2 &&
      planSheets(7, { ...NUP_DEFAULTS, layout: 4 }, null).sheets[1].cells.length === 3
  );
  check(
    "16 @ 16-up = 1 sheet, 17 = 2",
    planSheets(16, { ...NUP_DEFAULTS, layout: 16 }, null).sheets.length === 1 &&
      planSheets(17, { ...NUP_DEFAULTS, layout: 16 }, null).sheets.length === 2
  );

  /* -------------------------------------------------------------- */
  console.log("\n4. Pure engine — row vs column order");
  const rowPlan = planSheets(6, { ...NUP_DEFAULTS, layout: 6 }, null);
  const colPlan = planSheets(6, { ...NUP_DEFAULTS, layout: 6, order: "column" }, null);
  const rowSeq = rowPlan.sheets[0].cells.map((c) => `${c.col},${c.row}`).join(" ");
  const colSeq = colPlan.sheets[0].cells.map((c) => `${c.col},${c.row}`).join(" ");
  check(
    "row-major reads across, column-major reads down (mirrored sequence)",
    rowSeq === "0,0 1,0 0,1 1,1 0,2 1,2" && colSeq === "0,0 0,1 0,2 1,0 1,1 1,2",
    `row=[${rowSeq}] col=[${colSeq}]`
  );
  check(
    "page order preserved: cell.slot i covers selected page i",
    rowPlan.sheets[0].cells.every((c) => c.pageIndex === c.slot)
  );

  /* -------------------------------------------------------------- */
  console.log("\n5. Pure engine — clamps");
  const fatMargin = sheetMetrics(A4_PT.w, A4_PT.h, 2, 2, 100, 4);
  check(
    "margin clamps to sheet/4 (100mm → 148.82pt on A4)",
    near(fatMargin.margin, A4_PT.w / 4) && fatMargin.cellW > 0,
    `margin=${fatMargin.margin}`
  );
  const tiny = sheetMetrics(100, 100, 4, 4, 30, 30);
  check(
    "tiny match sheet: cells keep a 6pt minimum after clamps",
    tiny.cellW >= 6 - 0.01 && tiny.cellH >= 6 - 0.01 && tiny.spacing >= 0,
    `cellW=${tiny.cellW} cellH=${tiny.cellH} spacing=${tiny.spacing}`
  );

  /* -------------------------------------------------------------- */
  console.log("\n6. Pure engine — embedPlacement /Rotate anchors");
  const cell = { x: 10, y: 20, w: 200, h: 200 };
  const pl90 = embedPlacement(cell, 400, 300, 90);
  check(
    "/Rotate 90: visible 150x200 at (35,20), anchor top-left (35,220), draw rotate 270",
    near(pl90.visX, 35) &&
      near(pl90.visY, 20) &&
      near(pl90.visW, 150) &&
      near(pl90.visH, 200) &&
      near(pl90.x, 35) &&
      near(pl90.y, 220) &&
      near(pl90.width, 200) &&
      near(pl90.height, 150) &&
      pl90.rotate === 270,
    `vis=(${pl90.visX},${pl90.visY},${pl90.visW},${pl90.visH}) anchor=(${pl90.x},${pl90.y}) draw=${pl90.width}x${pl90.height} rot=${pl90.rotate}`
  );
  const pl180 = embedPlacement(cell, 400, 300, 180);
  check(
    "/Rotate 180: anchor = top-right of the visible box",
    near(pl180.x, 210) && near(pl180.y, 195) && pl180.rotate === 180,
    `anchor=(${pl180.x},${pl180.y})`
  );
  const pl270 = embedPlacement(cell, 400, 300, 270);
  check(
    "/Rotate 270: anchor = bottom-right of the visible box, draw rotate 90",
    near(pl270.x, 185) && near(pl270.y, 20) && pl270.rotate === 90,
    `anchor=(${pl270.x},${pl270.y})`
  );
  const pl0 = embedPlacement(cell, 400, 300, 0);
  check(
    "/Rotate 0: anchor = bottom-left of the visible box, scale min(200/400,200/300)",
    near(pl0.x, 10) && near(pl0.y, 45) && near(pl0.scale, 0.5),
    `anchor=(${pl0.x},${pl0.y}) scale=${pl0.scale}`
  );

  /* -------------------------------------------------------------- */
  console.log("\n7. E2E — real worker, pdf.js structure + pixels");
  const fixture = await buildFixture();

  // 2-up landscape A4: sheet 1 = [p0 (rot 0), p1 (rot 90)] side by side.
  const out2 = await runNup(
    fixture,
    values({ layout: 2, sheetOrientation: "landscape" })
  );
  check("2-up on 4 pages → 2 sheets", out2.sheets === 2, `sheets=${out2.sheets}`);

  const doc2 = await openWithPdfjs(out2.bytes);
  const sheet1 = await doc2.getPage(1);
  const vp1 = sheet1.getViewport({ scale: 1 });
  check(
    "output sheet is landscape A4 (841.89 x 595.28)",
    near(vp1.width, 841.89, 0.5) && near(vp1.height, 595.89, 1.5),
    `viewport=${vp1.width}x${vp1.height}`
  );

  // Planned placement for both cells of sheet 1 (engine numbers, pure).
  const landscapePlan = planSheets(4, { ...NUP_DEFAULTS, layout: 2, orientation: "landscape" }, null);
  const cell0 = landscapePlan.sheets[0].cells[0];
  const cell1 = landscapePlan.sheets[0].cells[1];
  const place0 = embedPlacement(cell0, 400, 300, 0);
  const place1 = embedPlacement(cell1, 400, 300, 90);

  const render1 = await renderPage(out2.bytes, 1);
  check(
    "pdf.js sheet pixels: p0 (rot 0) display-left is black where planned",
    render1.darkAt(place0.visX + place0.visW * 0.2, place0.visY + place0.visH * 0.5) &&
      !render1.darkAt(place0.visX + place0.visW * 0.8, place0.visY + place0.visH * 0.5),
    "p0 placement mismatch"
  );
  check(
    "pdf.js sheet pixels: p1 (/Rotate 90) display-left is black where planned",
    render1.darkAt(place1.visX + place1.visW * 0.2, place1.visY + place1.visH * 0.5) &&
      !render1.darkAt(place1.visX + place1.visW * 0.8, place1.visY + place1.visH * 0.5),
    "p1 placement mismatch"
  );

  // Sheet 2 = [p2 (empty A4), p3 (offset MediaBox, black display-left)].
  const place3 = embedPlacement(landscapePlan.sheets[1].cells[1], 400, 600, 0);
  const render2 = await renderPage(out2.bytes, 2);
  check(
    "sheet 2: p3 (MediaBox origin 20,30) black half lands inside its cell",
    render2.darkAt(place3.visX + place3.visW * 0.2, place3.visY + place3.visH * 0.5) &&
      !render2.darkAt(place3.visX + place3.visW * 0.8, place3.visY + place3.visH * 0.5),
    "p3 placement mismatch"
  );

  // Border strokes: decode sheet 1's content stream.
  const reloaded = await PDFDocument.load(out2.bytes);
  const pageObj = reloaded.getPage(0);
  const rawContents = pageObj.node.Contents();
  let streamText = "";
  const { PDFArray, PDFRawStream, PDFContentStream, decodePDFRawStream } =
    await import("pdf-lib");
  const collectStreams = async (node: unknown): Promise<void> => {
    if (node instanceof PDFRawStream) {
      streamText += Buffer.from(decodePDFRawStream(node).decode()).toString("latin1");
    } else if (node instanceof PDFContentStream) {
      streamText += Buffer.from(node.getUnencodedContents()).toString("latin1");
    } else if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i += 1) {
        await collectStreams(node.lookup(i));
      }
    }
  };
  await collectStreams(rawContents);
  const strokes = (streamText.match(/h\nS\n/g) ?? []).length;
  check(
    "borders: 2 cell strokes with 0.5 w in the content stream",
    streamText.includes("0.5 w") && strokes === 2,
    `strokes=${strokes} has0.5w=${streamText.includes("0.5 w")}`
  );

  const outNoBorders = await runNup(
    fixture,
    values({ layout: 2, sheetOrientation: "landscape", borders: false })
  );
  check(
    "borders off produces different bytes (strokes are optional)",
    Buffer.compare(
      Buffer.from(outNoBorders.bytes),
      Buffer.from(out2.bytes)
    ) !== 0
  );

  /* -------------------------------------------------------------- */
  console.log("\n8. E2E — ranges, match size, 6-up");
  // pages "2": only the /Rotate 90 page is placed — in CELL 0 (slot 0), the
  // second cell stays empty.
  const outOne = await runNup(fixture, values({ layout: 2, sheetOrientation: "landscape", pages: "2" }));
  const renderOne = await renderPage(outOne.bytes, 1);
  const placeOne = embedPlacement(cell0, 400, 300, 90);
  check(
    "pages \"2\": single rotated page in cell 0, cell 1 stays empty",
    renderOne.darkAt(placeOne.visX + placeOne.visW * 0.2, placeOne.visY + placeOne.visH * 0.5) &&
      !renderOne.darkAt(placeOne.visX + placeOne.visW * 0.8, placeOne.visY + placeOne.visH * 0.5) &&
      !renderOne.darkAt(cell1.x + cell1.w * 0.5, cell1.y + cell1.h * 0.5),
    "one-page placement mismatch"
  );

  // "match": sheet takes the first selected page's display size (p1 → 300x400
  // portrait, so a 4-up match sheet is 300x400 with a 2x2 grid).
  const outMatch = await runNup(
    fixture,
    values({ layout: 4, sheetSize: "match", pages: "2,4" })
  );
  const docMatch = await openWithPdfjs(outMatch.bytes);
  const matchVp = (await docMatch.getPage(1)).getViewport({ scale: 1 });
  check(
    "match sheet size: first selected page display dims (300x400)",
    near(matchVp.width, 300, 0.5) && near(matchVp.height, 400, 0.5),
    `viewport=${matchVp.width}x${matchVp.height}`
  );

  const out6 = await runNup(fixture, values({ layout: 6, sheetOrientation: "portrait" }));
  check(
    "6-up portrait on 4 pages → 1 sheet (2x3 grid, 4 of 6 cells used)",
    out6.sheets === 1 && out6.bytes.length > 0
  );

  // QA fixture for the browser round (rotated page visible in the preview).
  await writeFile("/home/z/my-project/download/qa-p41-nup.pdf", fixture);

  /* -------------------------------------------------------------- */
  console.log("\n9. E2E — error codes");
  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const cantoo = await CantooDoc.create();
  cantoo.addPage([300, 200]);
  cantoo.encrypt({ userPassword: "pw" });
  const encrypted = await cantoo.save({ useObjectStreams: false });

  let code = "";
  try {
    await runNup(encrypted, values({}));
  } catch (error) {
    code = error instanceof NupRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("encrypted PDF → tool.errorEncrypted", code === "tool.errorEncrypted", code);

  code = "";
  try {
    await runNup(new TextEncoder().encode("%PDF-1.7 not really"), values({}));
  } catch (error) {
    code = error instanceof NupRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("corrupt PDF → tool.errorCorrupt", code === "tool.errorCorrupt", code);

  code = "";
  try {
    await runNup(fixture, values({ pages: "x" }));
  } catch (error) {
    code = error instanceof NupRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("invalid page range → tool.errorInvalidPages", code === "tool.errorInvalidPages", code);

  console.log(
    `\nsmoke-nup: ${pass} passed, ${fail} failed${fail === 0 ? " — ALL GREEN" : ""}`
  );
  if (fail > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error("FAIL unhandled", error);
  process.exit(1);
});
