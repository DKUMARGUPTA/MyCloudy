require("regenerator-runtime/runtime");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("node:fs");
const bytes = fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf");
(async () => {
  const font = await fontkit.create(bytes);
  console.log("upem:", font.unitsPerEm, "numGlyphs:", font.numGlyphs, "psName:", font.postscriptName);
  console.log("ascent:", font.ascent, "descent:", font.descent, "capHeight:", font.capHeight, "xHeight:", font.xHeight, "italicAngle:", font.italicAngle);
  for (const text of ["क", "हिंदी", "क्ष", "Page १२", "स्कूल", "प्रीति", "गोपाल कृष्णा", "A", "क़", "र्क", "योग"]) {
    const run = font.layout(text);
    const glyphs = run.glyphs.map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`).join(" ");
    const w = run.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
    console.log(JSON.stringify(text), "->", glyphs, "Σaw:", w);
  }
})();
