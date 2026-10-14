/**
 * Builds the browser-QA fixture pair for overlay-pdf:
 *   public/qa/qa-overlay-base.pdf — 3-page "base" document
 *   public/qa/qa-overlay-top.pdf  — 2-page "overlay" document
 *
 * Base pages: A4 portrait, dark text + a gray rule so the behind/over
 * layering is visible in the preview and testable by pixel sampling.
 *
 * Overlay pages (deliberately DIFFERENT so mapping is testable):
 *   top p1 — a full-page TRANSLUCENT red tint band across the middle +
 *            bold "OVERLAY PAGE ONE" — the letterhead case
 *   top p2 — a small green-bordered stamp block centered (content box
 *            ~40% of the page, page itself full-size) + "OVERLAY PAGE TWO"
 *
 * The red band uses opacity 0.45 — the overlay's OWN transparency must
 * survive embedding (drawPage composites the content stream as-is).
 *
 * Run: bun scripts/make-overlay-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PW = 595.28;
const PH = 841.89;

async function buildBase(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= 3; i += 1) {
    const page = doc.addPage([PW, PH]);
    page.drawText(`BASE DOCUMENT — PAGE ${i}`, {
      x: 46,
      y: PH - 90,
      size: 20,
      font: bold,
      color: rgb(0.1, 0.1, 0.12),
    });
    page.drawText(`Overlay QA fixture · base page ${i} of 3`, {
      x: 46,
      y: PH - 112,
      size: 11,
      font: helv,
      color: rgb(0.4, 0.4, 0.45),
    });
    // Gray rule under the heading.
    page.drawRectangle({
      x: 46,
      y: PH - 124,
      width: PW - 92,
      height: 1.5,
      color: rgb(0.78, 0.78, 0.8),
    });
    const lines = [
      "This page is the BASE layer of the overlay QA fixture.",
      "When the overlay lands on top, this text stays readable.",
      "When the overlay goes behind content, this text covers it.",
      "",
      "Base paragraph line A for pixel sampling.",
      "Base paragraph line B for pixel sampling.",
      "Base paragraph line C for pixel sampling.",
      "",
      `Base footer ${i} — unchanged by the overlay.`,
    ];
    let y = PH - 160;
    for (const line of lines) {
      if (line !== "") {
        page.drawText(line, {
          x: 46,
          y,
          size: 12,
          font: helv,
          color: rgb(0.12, 0.12, 0.15),
        });
      }
      y -= 22;
    }
    // A small solid dark square at a known spot (center) — the
    // behind-content test samples it: the overlay must NOT cover it.
    page.drawRectangle({
      x: PW / 2 - 15,
      y: PH / 2 - 15,
      width: 30,
      height: 30,
      color: rgb(0.08, 0.08, 0.1),
    });
  }
  return doc.save();
}

async function buildTop(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  {
    // Page 1 — the letterhead: translucent red band across the middle.
    const page = doc.addPage([PW, PH]);
    page.drawRectangle({
      x: 40,
      y: PH * 0.42,
      width: PW - 80,
      height: PH * 0.16,
      color: rgb(0.9, 0.15, 0.15),
      opacity: 0.45,
    });
    page.drawText("OVERLAY PAGE ONE", {
      x: 60,
      y: PH / 2 - 8,
      size: 30,
      font: bold,
      color: rgb(0.75, 0.05, 0.05),
      opacity: 0.9,
    });
    page.drawText("letterhead overlay · page 1", {
      x: 60,
      y: PH / 2 - 34,
      size: 11,
      font: bold,
      color: rgb(0.75, 0.05, 0.05),
      opacity: 0.8,
    });
  }
  {
    // Page 2 — the stamp: a small green-bordered block, centered.
    const page = doc.addPage([PW, PH]);
    const w = PW * 0.4;
    const h = PH * 0.18;
    page.drawRectangle({
      x: (PW - w) / 2,
      y: (PH - h) / 2,
      width: w,
      height: h,
      borderColor: rgb(0.05, 0.55, 0.25),
      borderWidth: 3,
      color: rgb(0.9, 0.99, 0.93),
      opacity: 0.9,
    });
    page.drawText("OVERLAY PAGE TWO", {
      x: (PW - w) / 2 + 22,
      y: (PH + h) / 2 - 40,
      size: 15,
      font: bold,
      color: rgb(0.05, 0.45, 0.2),
    });
    page.drawText("APPROVED · stamp overlay", {
      x: (PW - w) / 2 + 22,
      y: (PH + h) / 2 - 60,
      size: 11,
      font: bold,
      color: rgb(0.05, 0.45, 0.2),
    });
  }
  return doc.save();
}

const outDir = "public/qa";
writeFileSync(`${outDir}/qa-overlay-base.pdf`, await buildBase());
writeFileSync(`${outDir}/qa-overlay-top.pdf`, await buildTop());
console.log("wrote public/qa/qa-overlay-base.pdf (3 pages)");
console.log("wrote public/qa/qa-overlay-top.pdf (2 pages)");
