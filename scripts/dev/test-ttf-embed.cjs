/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const { StampContext, PdfError } = require("/home/z/my-project/src/lib/own/pdf/index.ts");
const { parsePdf, resolve } = require("/home/z/my-project/src/lib/own/pdf/index.ts");
require("regenerator-runtime/runtime");
const { PDFDocument, PDFHexString } = require("pdf-lib");

const src = new Uint8Array(fs.readFileSync("/home/z/my-project/public/qa/bm-fixture.pdf"));
const ttfBytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));

(async () => {
  // 1. Stamp Devanagari through OUR engine
  const ctx = StampContext.load(src);
  const deva = ctx.embedTtf(ttfBytes);
  const text = "गोपाल कृष्णा";
  const w = deva.measure(text, 24);
  console.log("measure:", w.toFixed(6));
  const x = 72, y = 700;
  ctx.stampText(0, { x, y, text, size: 24, ttf: deva, color: { r: 0.86, g: 0.15, b: 0.15 } });
  ctx.stampText(1, { x, y, text: "हिंदी", size: 18, ttf: deva, opacity: 0.5 });
  const out = ctx.write();
  fs.writeFileSync("/tmp/deva-stamp-out.pdf", out);
  console.log("wrote", out.length, "bytes");

  // 2. OUR parser reloads it
  const doc = parsePdf(out);
  const root = resolve(doc, doc.trailer.get("Root"));
  const pagesRoot = resolve(doc, root.m.get("Pages"));
  console.log("own-parser pages:", pagesRoot.m.get("Count").n);

  // find our font: walk page 1 resources
  // 3. pdf-lib ORACLE reloads it
  const oracle = await PDFDocument.load(out);
  console.log("oracle pages:", oracle.getPageCount());

  // 4. Extract the embedded font from the oracle and verify with fontkit
  const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
  const fk = await fontkit.create(ttfBytes);
  const wantRun = fk.layout(text).glyphs;
  // 4a. decode the stamp hex back: find the content stream on page 1
  const { latin1 } = require("/home/z/my-project/src/lib/own/pdf/index.ts");
  // our page 0 object: writer emits pages in order after catalog+pages-tree; find via pdf-lib
  const oraclePage = oracle.getPage(0);
  const node = oraclePage.node;
  const contents = node.Contents();
  let streamText = "";
  const readStream = (s) => latin1(s.contents, 0, s.contents.length);
  if (contents.constructor.name === "PDFArray") {
    for (let i = 0; i < contents.size(); i++) {
      streamText += readStream(contents.lookup(i));
    }
  } else {
    streamText = readStream(contents);
  }
  const hexMatch = /<([0-9a-fA-F]+)> Tj/.exec(streamText);
  const hex = hexMatch[1];
  console.log("stamp hex:", hex);
  const sids = [];
  for (let i = 0; i < hex.length; i += 4) sids.push(parseInt(hex.slice(i, i + 4), 16));
  // verify each sid's source glyph matches the oracle run (subset ids in first-use order)
  let ok = true;
  if (sids.length !== wantRun.length) { ok = false; console.log("✗ sid count", sids.length, "vs glyphs", wantRun.length); }
  else {
    const sidToFirstGlyph = new Map();
    for (let i = 0; i < wantRun.length; i++) {
      const sid = sids[i];
      if (!sidToFirstGlyph.has(sid)) sidToFirstGlyph.set(sid, wantRun[i].id);
      if (sidToFirstGlyph.get(sid) !== wantRun[i].id) { ok = false; console.log(`✗ sid ${sid} maps to ${sidToFirstGlyph.get(sid)} but glyph ${i} is ${wantRun[i].id}`); break; }
    }
  }
  console.log(ok ? "✓ hex ↔ fontkit glyph sequence (id-consistent)" : "✗ hex mismatch");

  // 5. verify the embedded FontFile2: find the Type0 font in the oracle context
  const { PDFName, PDFDict, PDFArray } = require("pdf-lib");
  const pako = require("pako");
  let type0 = null;
  for (const [, obj] of oracle.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) {
      const st = obj.get(PDFName.of("Subtype"));
      if (st && String(st) === "/Type0") type0 = obj;
    }
  }
  if (!type0) throw new Error("no Type0 font found in oracle output");
  const cidList = oracle.context.lookup(type0.get(PDFName.of("DescendantFonts")));
  const cid = oracle.context.lookup(cidList.get(0));
  const fd = oracle.context.lookup(cid.get(PDFName.of("FontDescriptor")));
  const ff2 = oracle.context.lookup(fd.get(PDFName.of("FontFile2")));
  const ttfSubset = pako.inflate(ff2.contents);
  fs.writeFileSync("/tmp/embedded-subset.ttf", ttfSubset);
  const subFont = await fontkit.create(ttfSubset);
  console.log("✓ embedded subset loads in fontkit:", subFont.numGlyphs, "glyphs, upem", subFont.unitsPerEm);
  console.log("BaseFont:", String(type0.get(PDFName.of("BaseFont"))));
  console.log("Encoding:", String(type0.get(PDFName.of("Encoding"))));
  const wArr = cid.get(PDFName.of("W"));
  console.log("W:", wArr.toString().slice(0, 200));

  // 6. ToUnicode verification: inflate + parse the bfchar entries
  const toUni = oracle.context.lookup(type0.get(PDFName.of("ToUnicode")));
  const cmapText = Buffer.from(pako.inflate(toUni.contents)).toString("latin1");
  const bfChars = [...cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)];
  console.log("ToUnicode entries:", bfChars.length);
  // reconstruct the text from the stamp hex via ToUnicode
  let reconstructed = "";
  for (let i = 0; i < hex.length; i += 4) {
    const sidHex = hex.slice(i, i + 4);
    const entry = bfChars.find(([m, sid]) => sid.toLowerCase() === sidHex.toLowerCase());
    const cpsHex = entry ? entry[2] : "";
    for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
      reconstructed += String.fromCharCode(parseInt(cpsHex.slice(j, j + 4), 16));
    }
  }
  console.log("reconstructed:", JSON.stringify(reconstructed), "original:", JSON.stringify(text));
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
