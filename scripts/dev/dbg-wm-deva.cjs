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
  const g = globalThis;
  g.__responses = [];
  g.postMessage = (r) => { g.__responses.push(r); };
  g.self = globalThis;
  const mod = await import("/home/z/my-project/tools/add-watermark/worker.ts");
  const handler = mod.onmessage ?? g.onmessage;
  // patch: log the caught error details

    const origOnmessage = handler;
  (async () => {})();
  globalThis.__debugError = null;
  handler({
    data: {
      type: "run", runId: 1, toolId: "add-watermark",
      options: { wmType: "text", text: "हिंदी", position: "center", rotation: 0, opacity: 0.35, behind: false },
      files: [new File([baseBytes.buffer], "deva.pdf", { type: "application/pdf" })],
    },
  });
  const t = await new Promise((done) => {
    const tick = () => {
      const term = g.__responses.find((r) => r.type === "result" || r.type === "error");
      if (term) done(term); else setTimeout(tick, 25);
    };
    tick();
  });
  console.log("terminal:", JSON.stringify(t));
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
