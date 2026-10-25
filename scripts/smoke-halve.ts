/**
 * PRE-BUILD smoke test for the Halve PDF pages tool (P4.1). Proves the
 * engine math BEFORE any UI is written (the P3.3 lesson — pin the engine,
 * then build on it), then drives the REAL worker code end-to-end:
 *
 *  1. display→user-space mapping for /Rotate 0/90/180/270 (worked corners).
 *  2. halveBoxes: halves in DISPLAY space mapped to user-space boxes —
 *     the /Rotate 90 + 270 proof that a VERTICAL display cut slices the
 *     unrotated box on the OTHER axis (and horizontal likewise).
 *  3. Order options (left/right, top/bottom first), cut position 40-60,
 *     clamping, resolve defaults.
 *  4. planHalves output sequences (normal, swapped halves, reversed).
 *  5. E2E with the real worker: fixture with a plain page + /Rotate 90 +
 *     /Rotate 270 + Bleed/Trim/Art boxes + a CropBox-view page; verified
 *     STRUCTURALLY with pdf-lib (page count, MediaBox/CropBox, rotation
 *     kept, optional boxes clamped) and with pdf.js PIXEL samples (each
 *     output half shows exactly its part of the page).
 *  6. Error codes (encrypted / corrupt / invalid range).
 *
 * Run: bun scripts/smoke-halve.ts
 */
import { writeFile } from "node:fs/promises";

import { PDFDocument, degrees, rgb } from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  HALVE_DEFAULTS,
  HALVE_IDS,
  HALVE_POSITION_MAX,
  HALVE_POSITION_MIN,
  type DisplayRect,
  type PageBox,
  displayRectToUserBox,
  displayToUser,
  halveBoxes,
  planHalves,
  resolveHalveOptions,
} from "../tools/halve-pdf-pages/engine";
import { HalveRunError, runHalve } from "../tools/halve-pdf-pages/worker";

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

function boxNear(
  a: PageBox,
  b: { x: number; y: number; width: number; height: number },
  eps = 0.01
): boolean {
  return (
    near(a.x, b.x, eps) &&
    near(a.y, b.y, eps) &&
    near(a.width, b.width, eps) &&
    near(a.height, b.height, eps)
  );
}

function boxStr(a: PageBox): string {
  return `{x:${a.x.toFixed(2)} y:${a.y.toFixed(2)} w:${a.width.toFixed(2)} h:${a.height.toFixed(2)}}`;
}

/** Renders an output page with pdf.js + @napi-rs/canvas and samples pixels. */
async function openWithPdfjs(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist");
  return getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

async function renderPage(
  bytes: Uint8Array,
  pageNumber: number
): Promise<{ width: number; height: number; darkAt: (x: number, y: number) => boolean }> {
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
  };
}

/** True when every sampled point of the page is dark. */
function allDark(
  page: { width: number; height: number; darkAt: (x: number, y: number) => boolean },
  samples = 9
): boolean {
  for (let i = 0; i < samples; i += 1) {
    const fx = ((i % 3) + 0.5) / 3;
    const fy = (Math.floor(i / 3) + 0.5) / 3;
    if (!page.darkAt(fx * page.width, fy * page.height)) return false;
  }
  return true;
}

/** True when no sampled point of the page is dark. */
function allWhite(
  page: { width: number; height: number; darkAt: (x: number, y: number) => boolean },
  samples = 9
): boolean {
  for (let i = 0; i < samples; i += 1) {
    const fx = ((i % 3) + 0.5) / 3;
    const fy = (Math.floor(i / 3) + 0.5) / 3;
    if (page.darkAt(fx * page.width, fy * page.height)) return false;
  }
  return true;
}

function values(overrides: Record<string, string | number | boolean>): OptionValues {
  return {
    [HALVE_IDS.cut]: HALVE_DEFAULTS.cut,
    [HALVE_IDS.verticalOrder]: HALVE_DEFAULTS.verticalOrder,
    [HALVE_IDS.horizontalOrder]: HALVE_DEFAULTS.horizontalOrder,
    [HALVE_IDS.position]: HALVE_DEFAULTS.positionPct,
    [HALVE_IDS.reverse]: HALVE_DEFAULTS.reverse,
    [HALVE_IDS.pages]: HALVE_DEFAULTS.pages,
    ...overrides,
  };
}

const HALVE_GEO: Pick<typeof HALVE_DEFAULTS, "cut" | "verticalOrder" | "horizontalOrder" | "positionPct"> = {
  cut: "vertical",
  verticalOrder: "left",
  horizontalOrder: "top",
  positionPct: 50,
};

/** view box (0,0,400,300) with /Rotate 0 — display-left is black. */
const VIEW: PageBox = { x: 0, y: 0, width: 400, height: 300 };

/**
 * Mixed fixture: p0 plain (display-left black), p1 /Rotate 90 (display-left
 * = user band y<150 black), p2 /Rotate 270 (display-left = user band y>150
 * black), p3 A4 with Bleed/Trim boxes that stick out of the left half.
 */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const black = rgb(0, 0, 0);

  const p0 = doc.addPage([400, 300]);
  p0.drawRectangle({ x: 0, y: 0, width: 200, height: 300, color: black });

  const p1 = doc.addPage([400, 300]);
  p1.setRotation(degrees(90));
  p1.drawRectangle({ x: 0, y: 0, width: 400, height: 150, color: black });

  const p2 = doc.addPage([400, 300]);
  p2.setRotation(degrees(270));
  p2.drawRectangle({ x: 0, y: 150, width: 400, height: 150, color: black });

  const p3 = doc.addPage([595.28, 841.89]);
  p3.setBleedBox(50, 60, 450, 640); // [50,60,500,700]
  p3.setTrimBox(0, 0, 500, 700);

  return doc.save({ useObjectStreams: true });
}

/** CropBox-view fixture: MediaBox 600x400, view [50,50,350,250], view-left black. */
async function buildCropViewFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const black = rgb(0, 0, 0);
  const page = doc.addPage([600, 400]);
  page.setCropBox(50, 50, 300, 200);
  page.drawRectangle({ x: 50, y: 50, width: 150, height: 200, color: black });
  return doc.save({ useObjectStreams: true });
}

async function main(): Promise<void> {
  /* -------------------------------------------------------------- */
  console.log("\n1. Pure engine — display→user mapping");
  const d0 = displayToUser(0, 10, 20, 100, 50, 30, 5);
  check(
    "/Rotate 0: (dx,dyUp) offsets straight from the view origin",
    near(d0.x, 40) && near(d0.y, 25),
    `got (${d0.x},${d0.y})`
  );
  const d90 = displayToUser(90, 0, 0, 400, 300, 0, 0);
  const d90c = displayToUser(90, 0, 0, 400, 300, 300, 400);
  check(
    "/Rotate 90: display bottom-left ↔ user (400,0), top-right ↔ (0,300)",
    near(d90.x, 400) && near(d90.y, 0) && near(d90c.x, 0) && near(d90c.y, 300),
    `got (${d90.x},${d90.y}) (${d90c.x},${d90c.y})`
  );
  const d180 = displayToUser(180, 10, 20, 100, 50, 0, 0);
  check(
    "/Rotate 180: display origin maps to the view's top-right corner",
    near(d180.x, 110) && near(d180.y, 70),
    `got (${d180.x},${d180.y})`
  );
  const rect: DisplayRect = { x0: 10, x1: 60, yUp0: 20, yUp1: 70 };
  const rBox = displayRectToUserBox(rect, { x: 0, y: 0, width: 100, height: 100 }, 0);
  check(
    "displayRectToUserBox /Rotate 0: plain offset rect",
    boxNear(rBox, { x: 10, y: 20, width: 50, height: 50 }),
    boxStr(rBox)
  );

  /* -------------------------------------------------------------- */
  console.log("\n2. Pure engine — halveBoxes (the /Rotate axis proof)");
  const h0 = halveBoxes(VIEW, 0, HALVE_GEO);
  check(
    "/Rotate 0 vertical left 50%: left {0,0,200,300}, right {200,0,200,300}",
    boxNear(h0.primary, { x: 0, y: 0, width: 200, height: 300 }) &&
      boxNear(h0.secondary, { x: 200, y: 0, width: 200, height: 300 }),
    `p=${boxStr(h0.primary)} s=${boxStr(h0.secondary)}`
  );
  const h90 = halveBoxes(VIEW, 90, HALVE_GEO);
  check(
    "/Rotate 90 vertical 50%: display-left half = user band y<150 (cut on the OTHER axis)",
    boxNear(h90.primary, { x: 0, y: 0, width: 400, height: 150 }) &&
      boxNear(h90.secondary, { x: 0, y: 150, width: 400, height: 150 }),
    `p=${boxStr(h90.primary)} s=${boxStr(h90.secondary)}`
  );
  const h270 = halveBoxes(VIEW, 270, HALVE_GEO);
  check(
    "/Rotate 270 vertical 50%: display-left half = user band y>150",
    boxNear(h270.primary, { x: 0, y: 150, width: 400, height: 150 }) &&
      boxNear(h270.secondary, { x: 0, y: 0, width: 400, height: 150 }),
    `p=${boxStr(h270.primary)} s=${boxStr(h270.secondary)}`
  );
  const h180 = halveBoxes(VIEW, 180, HALVE_GEO);
  check(
    "/Rotate 180 vertical 50%: display-left half = user x>200",
    boxNear(h180.primary, { x: 200, y: 0, width: 200, height: 300 }) &&
      boxNear(h180.secondary, { x: 0, y: 0, width: 200, height: 300 }),
    `p=${boxStr(h180.primary)} s=${boxStr(h180.secondary)}`
  );
  const h90h = halveBoxes(VIEW, 90, { ...HALVE_GEO, cut: "horizontal" });
  check(
    "/Rotate 90 horizontal 50%: display-top half = user x<200 (other axis again)",
    boxNear(h90h.primary, { x: 0, y: 0, width: 200, height: 300 }),
    `p=${boxStr(h90h.primary)}`
  );
  const h0h = halveBoxes(VIEW, 0, { ...HALVE_GEO, cut: "horizontal" });
  check(
    "/Rotate 0 horizontal top-first 50%: top {0,150,400,150}, bottom {0,0,400,150}",
    boxNear(h0h.primary, { x: 0, y: 150, width: 400, height: 150 }) &&
      boxNear(h0h.secondary, { x: 0, y: 0, width: 400, height: 150 }),
    `p=${boxStr(h0h.primary)} s=${boxStr(h0h.secondary)}`
  );
  const hR = halveBoxes(VIEW, 0, { ...HALVE_GEO, verticalOrder: "right" });
  check(
    "right-first swaps the two halves (primary = right)",
    boxNear(hR.primary, { x: 200, y: 0, width: 200, height: 300 }) &&
      boxNear(hR.secondary, { x: 0, y: 0, width: 200, height: 300 }),
    `p=${boxStr(hR.primary)}`
  );
  const h40 = halveBoxes(VIEW, 0, { ...HALVE_GEO, positionPct: 40 });
  check(
    "cut position 40% lands at 40% of the display width",
    boxNear(h40.primary, { x: 0, y: 0, width: 160, height: 300 }) &&
      boxNear(h40.secondary, { x: 160, y: 0, width: 240, height: 300 }),
    `p=${boxStr(h40.primary)}`
  );
  const hPos = halveBoxes(VIEW, 0, { ...HALVE_GEO, positionPct: 95 });
  check(
    "out-of-range position clamps to 60% inside halveBoxes",
    boxNear(hPos.primary, { x: 0, y: 0, width: 240, height: 300 }),
    `p=${boxStr(hPos.primary)}`
  );
  const view50 = { x: 50, y: 40, width: 300, height: 200 };
  const hOff = halveBoxes(view50, 0, HALVE_GEO);
  check(
    "non-zero view origin: halves keep the view's own coordinates",
    boxNear(hOff.primary, { x: 50, y: 40, width: 150, height: 200 }) &&
      boxNear(hOff.secondary, { x: 200, y: 40, width: 150, height: 200 }),
    `p=${boxStr(hOff.primary)} s=${boxStr(hOff.secondary)}`
  );

  /* -------------------------------------------------------------- */
  console.log("\n3. Pure engine — option resolution");
  const defaults = resolveHalveOptions({});
  check(
    "empty values resolve to defaults (vertical / left / top / 50 / off / all)",
    defaults.cut === "vertical" &&
      defaults.verticalOrder === "left" &&
      defaults.horizontalOrder === "top" &&
      defaults.positionPct === 50 &&
      defaults.reverse === false &&
      defaults.pages === "all"
  );
  const resolved = resolveHalveOptions({
    [HALVE_IDS.cut]: "diagonal",
    [HALVE_IDS.verticalOrder]: "right",
    [HALVE_IDS.horizontalOrder]: "bottom",
    [HALVE_IDS.position]: 70,
    [HALVE_IDS.reverse]: true,
    [HALVE_IDS.pages]: "1-2",
  });
  check(
    "unknown enum values fall back; position clamps into 40-60; rest passes",
    resolved.cut === "vertical" &&
      resolved.verticalOrder === "right" &&
      resolved.horizontalOrder === "bottom" &&
      resolved.positionPct === HALVE_POSITION_MAX &&
      resolved.reverse === true &&
      resolved.pages === "1-2",
    `pos=${resolved.positionPct}`
  );
  check(
    "position bounds are 40 and 60",
    HALVE_POSITION_MIN === 40 && HALVE_POSITION_MAX === 60
  );

  /* -------------------------------------------------------------- */
  console.log("\n4. Pure engine — planHalves output order");
  const seq = planHalves([0, 5, 9], { reverse: false });
  check(
    "3 selected pages → 6 entries, primary then secondary per page",
    seq.length === 6 &&
      seq[0]?.sourceIndex === 0 && seq[0]?.half === "primary" &&
      seq[1]?.sourceIndex === 0 && seq[1]?.half === "secondary" &&
      seq[2]?.sourceIndex === 5 && seq[2]?.half === "primary" &&
      seq[3]?.sourceIndex === 5 && seq[3]?.half === "secondary" &&
      seq[4]?.sourceIndex === 9 && seq[4]?.half === "primary" &&
      seq[5]?.sourceIndex === 9 && seq[5]?.half === "secondary"
  );
  const rev = planHalves([0, 5, 9], { reverse: true });
  check(
    "reverse flips the WHOLE sequence (last half first)",
    rev.length === 6 &&
      rev[0]?.sourceIndex === 9 && rev[0]?.half === "secondary" &&
      rev[5]?.sourceIndex === 0 && rev[5]?.half === "primary",
    `[${rev.map((e) => `${e.sourceIndex}:${e.half}`).join(" ")}]`
  );
  check(
    "reverse output is the exact mirror of the normal output",
    rev.every((entry, i) => {
      const mirror = seq[seq.length - 1 - i];
      return (
        mirror !== undefined &&
        entry.sourceIndex === mirror.sourceIndex &&
        entry.half === mirror.half
      );
    })
  );

  /* -------------------------------------------------------------- */
  console.log("\n5. E2E — real worker, structural + pixel checks");
  const fixture = await buildFixture();

  const pcts: number[] = [];
  const out = await runHalve(fixture, values({}), (progress) => {
    pcts.push(progress.pct);
  });
  check(
    "4 pages → 8 output pages, progress monotonic",
    out.pages === 8 &&
      pcts.length > 0 &&
      pcts.every((p, i) => i === 0 || p >= (pcts[i - 1] ?? 0)) &&
      (pcts[pcts.length - 1] ?? 0) <= 100,
    `pages=${out.pages} pcts=${pcts.length}`
  );

  const reloaded = await PDFDocument.load(out.bytes);
  check("output re-opens with 8 pages", reloaded.getPageCount() === 8);
  const mb = (i: number) => reloaded.getPage(i).getMediaBox();
  const cb = (i: number) => reloaded.getPage(i).getCropBox();
  const rot = (i: number) => reloaded.getPage(i).getRotation().angle;
  check(
    "p1/p2: MediaBox AND CropBox are the plain halves {0,0,200,300} / {200,0,200,300}",
    boxNear(mb(0), { x: 0, y: 0, width: 200, height: 300 }) &&
      boxNear(cb(0), { x: 0, y: 0, width: 200, height: 300 }) &&
      boxNear(mb(1), { x: 200, y: 0, width: 200, height: 300 }) &&
      boxNear(cb(1), { x: 200, y: 0, width: 200, height: 300 })
  );
  check(
    "p3/p4 (/Rotate 90): halves are user bands y<150 / y≥150 — the other-axis cut",
    boxNear(mb(2), { x: 0, y: 0, width: 400, height: 150 }) &&
      boxNear(mb(3), { x: 0, y: 150, width: 400, height: 150 }) &&
      rot(2) === 90 &&
      rot(3) === 90
  );
  check(
    "p5/p6 (/Rotate 270): halves are user bands y≥150 / y<150, rotation kept",
    boxNear(mb(4), { x: 0, y: 150, width: 400, height: 150 }) &&
      boxNear(mb(5), { x: 0, y: 0, width: 400, height: 150 }) &&
      rot(4) === 270 &&
      rot(5) === 270
  );
  const a4Half = 595.28 / 2;
  check(
    "p7/p8 (A4): left {0,0,297.64,841.89} and right {297.64,0,297.64,841.89}",
    boxNear(mb(6), { x: 0, y: 0, width: a4Half, height: 841.89 }) &&
      boxNear(mb(7), { x: a4Half, y: 0, width: a4Half, height: 841.89 })
  );
  const bleed = reloaded.getPage(6).getBleedBox();
  const trim = reloaded.getPage(6).getTrimBox();
  check(
    "p7 optional boxes clamp INTO the half (Bleed ∩ half, Trim ∩ half)",
    boxNear(bleed, { x: 50, y: 60, width: a4Half - 50, height: 640 }) &&
      boxNear(trim, { x: 0, y: 0, width: a4Half, height: 700 }),
    `bleed=${boxStr(bleed)} trim=${boxStr(trim)}`
  );
  check(
    "p7 has no ArtBox entry (absent stays absent)",
    reloaded.getPage(6).node.ArtBox() === undefined
  );

  const r1 = await renderPage(out.bytes, 1);
  const r2 = await renderPage(out.bytes, 2);
  check(
    "pixels: output p1 (display-left of p0) is fully black, p2 fully white",
    allDark(r1) && allWhite(r2)
  );
  const r3 = await renderPage(out.bytes, 3);
  const r4 = await renderPage(out.bytes, 4);
  check(
    "pixels: /Rotate 90 left half fully black, right half fully white",
    allDark(r3) && allWhite(r4)
  );
  const r5 = await renderPage(out.bytes, 5);
  const r6 = await renderPage(out.bytes, 6);
  check(
    "pixels: /Rotate 270 left half fully black, right half fully white",
    allDark(r5) && allWhite(r6)
  );

  // QA fixture for the browser round (rotated pages + optional boxes).
  await writeFile("/home/z/my-project/download/qa-p41-halve.pdf", fixture);

  /* -------------------------------------------------------------- */
  console.log("\n6. E2E — order options, position, horizontal cut, ranges");
  const outRight = await runHalve(
    fixture,
    values({ [HALVE_IDS.verticalOrder]: "right" })
  );
  const rr1 = await renderPage(outRight.bytes, 1);
  const rr2 = await renderPage(outRight.bytes, 2);
  check(
    "right-first: output p1 is the white right half, p2 the black left half",
    allWhite(rr1) && allDark(rr2)
  );

  const outRev = await runHalve(fixture, values({ [HALVE_IDS.reverse]: true }));
  const rv1 = await renderPage(outRev.bytes, 1);
  const rv8 = await renderPage(outRev.bytes, 8);
  const rvReload = await PDFDocument.load(outRev.bytes);
  check(
    "reverse: first output = right half of the LAST page, last output = left half of page 1",
    outRev.pages === 8 &&
      allWhite(rv1) &&
      allDark(rv8) &&
      boxNear(rvReload.getPage(0).getMediaBox(), { x: a4Half, y: 0, width: a4Half, height: 841.89 })
  );

  const out40 = await runHalve(
    fixture,
    values({ [HALVE_IDS.position]: 40, [HALVE_IDS.pages]: "2" })
  );
  const r40 = await PDFDocument.load(out40.bytes);
  check(
    "position 40% on the /Rotate 90 page: left half shrinks to 120pt user band",
    out40.pages === 2 &&
      boxNear(r40.getPage(0).getMediaBox(), { x: 0, y: 0, width: 400, height: 120 }) &&
      boxNear(r40.getPage(1).getMediaBox(), { x: 0, y: 120, width: 400, height: 180 })
  );

  const outH = await runHalve(
    fixture,
    values({ [HALVE_IDS.cut]: "horizontal" })
  );
  const rhReload = await PDFDocument.load(outH.bytes);
  const rh1 = await renderPage(outH.bytes, 1);
  check(
    "horizontal top-first: p1 MediaBox {0,150,400,150}; top half shows the page's black left region",
    boxNear(rhReload.getPage(0).getMediaBox(), { x: 0, y: 150, width: 400, height: 150 }) &&
      rh1.darkAt(rh1.width * 0.25, rh1.height * 0.5) &&
      !rh1.darkAt(rh1.width * 0.75, rh1.height * 0.5)
  );

  const outRange = await runHalve(fixture, values({ [HALVE_IDS.pages]: "2" }));
  const rangeReload = await PDFDocument.load(outRange.bytes);
  check(
    "pages \"2\": only the /Rotate 90 page is halved (2 outputs)",
    outRange.pages === 2 &&
      rangeReload.getPageCount() === 2 &&
      rangeReload.getPage(0).getRotation().angle === 90
  );

  const cropFixture = await buildCropViewFixture();
  const outCrop = await runHalve(cropFixture, values({}));
  const cropReload = await PDFDocument.load(outCrop.bytes);
  const cp1 = await renderPage(outCrop.bytes, 1);
  const cp2 = await renderPage(outCrop.bytes, 2);
  check(
    "CropBox view: halves are cut out of the VIEW box {50,50,300,200}, not the MediaBox",
    outCrop.pages === 2 &&
      boxNear(cropReload.getPage(0).getMediaBox(), { x: 50, y: 50, width: 150, height: 200 }) &&
      boxNear(cropReload.getPage(1).getMediaBox(), { x: 200, y: 50, width: 150, height: 200 })
  );
  check(
    "CropBox view pixels: left half black, right half white",
    allDark(cp1) && allWhite(cp2)
  );

  /* -------------------------------------------------------------- */
  console.log("\n7. E2E — error codes");
  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const cantoo = await CantooDoc.create();
  cantoo.addPage([300, 200]);
  cantoo.encrypt({ userPassword: "pw" });
  const encrypted = await cantoo.save({ useObjectStreams: false });

  let code = "";
  try {
    await runHalve(encrypted, values({}));
  } catch (error) {
    code = error instanceof HalveRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("encrypted PDF → tool.errorEncrypted", code === "tool.errorEncrypted", code);

  code = "";
  try {
    await runHalve(new TextEncoder().encode("%PDF-1.7 not really"), values({}));
  } catch (error) {
    code = error instanceof HalveRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("corrupt PDF → tool.errorCorrupt", code === "tool.errorCorrupt", code);

  code = "";
  try {
    await runHalve(fixture, values({ [HALVE_IDS.pages]: "x" }));
  } catch (error) {
    code = error instanceof HalveRunError ? error.code : `unexpected:${String(error)}`;
  }
  check("invalid page range → tool.errorInvalidPages", code === "tool.errorInvalidPages", code);

  console.log(
    `\nsmoke-halve: ${pass} passed, ${fail} failed${fail === 0 ? " — ALL GREEN" : ""}`
  );
  // Unconditional exit — on success, dangling worker/sharp shims keep
  // bun’s event loop alive forever (completed-but-never-terminated hangs).
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("FAIL unhandled", error);
  process.exit(1);
});
