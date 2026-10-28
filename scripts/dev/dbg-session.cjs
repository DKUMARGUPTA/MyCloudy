const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const { shapeText } = require("/home/z/my-project/src/lib/own/pdf/shape-deva.ts");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);
(async () => {
  const fk = await fontkit.create(bytes);
  const session = new Map();
  for (const text of ["½", "Привет"]) {
    const want = fk.layout(text).glyphs.map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`);
    const got = shapeText(font, text, session).map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`);
    console.log(JSON.stringify(text), "\n  want:", want.join(" "), "\n  got :", got.join(" "));
  }
  console.log("my glyphForCodePoint(0xbd):", font.glyphForCodePoint(0xbd), "(0x41f):", font.glyphForCodePoint(0x41f));
})();
