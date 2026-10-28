const { ParsedTtfFont, TtfSubsetter } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const fs = require("node:fs");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);
console.log("upem:", font.unitsPerEm, "glyphs:", font.numGlyphs, "psName:", font.postscriptName);
console.log("ascent:", font.ascent, "descent:", font.descent, "capHeight:", font.capHeight, "xHeight:", font.xHeight, "italic:", font.italicAngle);
console.log("bbox:", font.bbox, "familyClass:", font.os2FamilyClass, "fixed:", font.postIsFixedPitch, "italicStyle:", font.headMacStyleItalic);
// cmap: compare against fontkit for a battery of codepoints
require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
const cps = [];
for (let cp = 0x20; cp < 0x2000; cp++) cps.push(cp);
(async () => {
  const fk = await fontkit.create(bytes);
  let mismatches = 0;
  for (const cp of cps) {
    const want = fk.glyphForCodePoint(cp).id;
    const got = font.glyphForCodePoint(cp);
    if (want !== got) {
      if (mismatches < 10) console.log(`MISMATCH U+${cp.toString(16)}: fontkit=${want} ours=${got}`);
      mismatches++;
    }
  }
  console.log("cmap 0x20-0x2000:", mismatches === 0 ? "ALL MATCH" : `${mismatches} mismatches`);
  // advance widths for used glyphs
  let awMismatch = 0;
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    const g = fk.getGlyph(gid);
    if (g.advanceWidth !== font.advanceWidth(gid)) { awMismatch++; if (awMismatch < 5) console.log("aw mismatch gid", gid, g.advanceWidth, font.advanceWidth(gid)); }
  }
  console.log("advanceWidths:", awMismatch === 0 ? "ALL MATCH" : `${awMismatch} mismatches`);
  // composites
  let comps = 0;
  for (let gid = 0; gid < font.numGlyphs; gid++) if (font.compositeComponents(gid).length > 0) comps++;
  console.log("composite glyphs:", comps);
  // subset smoke: क ि ् A space
  const sub = new TtfSubsetter(font);
  const ids = [];
  for (const cp of [0x915, 0x93f, 0x94d, 0x41, 0x20, 0x967]) ids.push(sub.includeGlyph(font.glyphForCodePoint(cp)));
  console.log("subset ids:", ids);
  const out = sub.encode();
  fs.writeFileSync("/tmp/subset-test.ttf", out);
  console.log("subset bytes:", out.length);
  // The subset intentionally has no cmap (fontkit TTFSubset parity) — validate
  // it with the ORACLE instead: fontkit must load it and see the same glyphs.
  const subFont = await fontkit.create(out);
  console.log("fontkit loads subset:", subFont.numGlyphs, "glyphs, upem", subFont.unitsPerEm);
})();
