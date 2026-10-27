const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
try {
  const font = ParsedTtfFont.parse(bytes);
  console.log("OK:", font.unitsPerEm, font.numGlyphs, font.postscriptName);
} catch (e) {
  console.log("FAIL:", e.message, e.code);
  // peek at internals via a manual directory
  const u16 = (b,p)=>(b[p]<<8)|b[p+1];
  const u32 = (b,p)=>((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0;
  console.log("sfnt:", u32(bytes,0).toString(16), "numTables:", u16(bytes,4));
}
