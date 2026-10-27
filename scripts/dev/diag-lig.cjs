const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const { GsubEngine } = require("/home/z/my-project/src/lib/own/pdf/gsub.ts");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);
const engine = new GsubEngine(font);
engine.selectScript("deva");
const g = (cp) => engine.glyph(font.glyphForCodePoint(cp), [cp]);
const pa = g(0x92a), hal = g(0x94d), ra = g(0x930), ta = g(0x924);
console.log("scripts offered:", font.gsub.scripts.get("deva")?.length, "features");
for (const tag of ["nukt","akhn","rphf","rkrf","pref","blwf","abvf","half","pstf","vatu","cjct","pres","abvs","blws","psts","haln","locl","ccmp","calt","clig","init","aalt","ss01"]) {
  if (!engine.hasFeature(tag)) continue;
  const r1 = engine.wouldSubstitute([pa, hal, ra], tag);
  const r2 = engine.wouldSubstitute([hal, ra], tag);
  const r3 = engine.wouldSubstitute([ta, hal, ra], tag);
  if (r1 || r2 || r3) console.log(tag, "C-H-Ra:", r1, "H-Ra:", r2, "त्र:", r3);
}
// also check feature presence
console.log("has rkrf:", engine.hasFeature("rkrf"), "blwf:", engine.hasFeature("blwf"), "cjct:", engine.hasFeature("cjct"), "pres:", engine.hasFeature("pres"));
// What does blwf do on [H, Ra]?
console.log("blwf [H,Ra]→", engine.wouldSubstitute([hal, ra], "blwf"));
console.log("blwf [Ra,H]→", engine.wouldSubstitute([ra, hal], "blwf"));
console.log("pstf [H,Ra]→", engine.wouldSubstitute([hal, ra], "pstf"));
