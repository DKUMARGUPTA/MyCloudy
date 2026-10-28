const fs = require("node:fs");
const { PDFDocument, StandardFonts, PDFName } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
require("regenerator-runtime/runtime");
const pako = require("pako");
(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  doc.registerFontkit(fontkit);
  const devaBytes = fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf");
  const font = await doc.embedFont(devaBytes, { subset: true });
  page.drawText("हिंदी", { x: 100, y: 250, font, size: 48 });
  const out = await doc.save();
  fs.writeFileSync("/tmp/lib-deva-out.pdf", out);

  // reconstruct from the ORACLE's own ToUnicode
  const lib = await PDFDocument.load(out);
  const objs = [...lib.context.enumerateIndirectObjects()];
  const type0Entry = objs.find(([, o]) => o && o.get && String(o.get(PDFName.of("Subtype"))) === "/Type0");
  const type0 = type0Entry[1];
  const toUni = lib.context.lookup(type0.get(PDFName.of("ToUnicode")));
  const cmapText = Buffer.from(pako.inflate(toUni.contents)).toString("latin1");
  // find the page content hex
  const pageNode = lib.getPage(0).node;
  const contents = pageNode.Contents();
  let text = "";
  const zlib = require("node:zlib");
  const addStream = (st) => {
    let raw = Buffer.from(st.contents);
    const filter = st.dict && st.dict.get(PDFName.of("Filter"));
    if (filter && String(filter) === "/FlateDecode") raw = zlib.inflateSync(raw);
    text += raw.toString("latin1");
  };
  if (typeof contents.size === "function") {
    for (let i = 0; i < contents.size(); i++) addStream(lib.context.lookup(contents.get(i)));
  } else {
    addStream(lib.context.lookup(contents));
  }
  console.log("content stream:", JSON.stringify(text.slice(0, 200)));
  const hexM = /<([0-9a-fA-F]+)> Tj/.exec(text);
  if (!hexM) process.exit(0);
  const hex = hexM[1];
  const bfChars = [...cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)];
  let reconstructed = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const sidHex = hex.slice(i, i + 4).toLowerCase();
    const entry = bfChars.find(([, sid]) => sid.toLowerCase() === sidHex);
    const cpsHex = entry ? entry[2] : "";
    for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
      reconstructed += String.fromCharCode(parseInt(cpsHex.slice(j, j + 4), 16));
    }
  }
  console.log("pdf-lib's own reconstruction:", JSON.stringify(reconstructed), "(original: हिंदी)");
})();
