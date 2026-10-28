const { PDFDocument, StandardFonts } = require("pdf-lib");
(async () => {
  const libDoc = await PDFDocument.create();
  const helv = await libDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = libDoc.addPage([400, 500]);
    page.drawText(`BASE-PAGE-${i + 1}`, { x: 30, y: 250, font: helv, size: 16 });
  }
  const baseBytes = new Uint8Array(await libDoc.save());

  const g = globalThis;
  g.postMessage = (r) => { g.__responses.push(r); };
  g.__responses = [];
  g.self = globalThis;
  const mod = await import("/home/z/my-project/tools/add-watermark/worker.ts");
  console.log("worker loaded, onmessage:", typeof mod.onmessage ?? typeof g.onmessage);
  const handler = mod.onmessage ?? g.onmessage;
  handler({
    data: {
      type: "run", runId: 1, toolId: "add-watermark",
      options: { wmType: "text", text: "CONFIDENTIAL", position: "center", rotation: 45, opacity: 0.35, behind: true },
      files: [new File([baseBytes.buffer], "secret.pdf", { type: "application/pdf" })],
    },
  });
  const t = await new Promise((done) => {
    const tick = () => {
      const term = g.__responses.find((r) => r.type === "result" || r.type === "error");
      if (term) done(term); else setTimeout(tick, 25);
    };
    tick();
  });
  console.log("terminal:", t.type, t.code ?? "");
  if (t.type !== "result") process.exit(0);
  const out = new Uint8Array(await t.outputs[0].blob.arrayBuffer());
  console.log("output bytes:", out.length);
  const { parsePdf, listPages } = await import("/home/z/my-project/src/lib/own/pdf/index.ts");
  const doc = parsePdf(out);
  const page = listPages(doc)[0];
  const contents = page.dict.get("Contents");
  console.log("contents kind:", contents?.k, "items:", contents?.k === "arr" ? contents.items.length : 1);
  const zlib = require("zlib");
  for (let i = 0; i < (contents?.k === "arr" ? contents.items.length : 1); i++) {
    const item = contents?.k === "arr" ? contents.items[i] : contents;
    const st = item?.k === "ref" ? doc.getObject(item.num) : item;
    if (st?.k !== "stream") { console.log(i, "not stream:", st?.k); continue; }
    const filters = st.m.get("Filter");
    console.log(i, "filter:", filters?.k === "name" ? filters.v : filters?.k === "arr" ? "multi" : "none", "len:", st.raw.length);
    let text = new TextDecoder("latin1").decode(st.raw);
    if (filters?.k === "name" && filters.v === "FlateDecode") {
      text = new TextDecoder("latin1").decode(zlib.inflateSync(Buffer.from(st.raw)));
    }
    console.log(i, "text[0..100]:", JSON.stringify(text.slice(0, 100)));
  }
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
