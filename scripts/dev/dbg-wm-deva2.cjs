const fs = require("node:fs");
const { PDFDocument, StandardFonts } = require("pdf-lib");
(async () => {
  const libDoc = await PDFDocument.create();
  const helv = await libDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = libDoc.addPage([400, 500]);
    page.drawText(`BASE-PAGE-${i + 1}`, { x: 30, y: 250, font: helv, size: 16 });
  }
  const baseBytes = new Uint8Array(await libDoc.save());
  const devaFont = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("NotoSansDevanagari")) {
      return Promise.resolve(new Response(devaFont.buffer, { status: 200 }));
    }
    return realFetch(input);
  };
  const { StampContext } = await import("/home/z/my-project/src/lib/own/pdf/index.ts");
  const ctx = StampContext.load(baseBytes);
  console.log("ctx loaded, pages:", ctx.pageCount);
  const deva = ctx.embedTtf(devaFont);
  console.log("embedded, measure:", deva.measure("हिंदी", 48));
  ctx.stampText(0, { x: 100, y: 250, text: "हिंदी", size: 48, ttf: deva, color: { r: 0.86, g: 0.15, b: 0.15 } });
  const out = ctx.write();
  console.log("wrote:", out.length);
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e && e.stack || e); process.exit(1); });
