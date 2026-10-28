/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const { shapeText } = require("/home/z/my-project/src/lib/own/pdf/shape-deva.ts");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");

const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);

const TESTS = [
  "क", "हिंदी", "क्ष", "Page १२", "स्कूल", "प्रीति", "गोपाल कृष्णा", "A", "क़", "र्क", "योग",
  "हिन्दी", "आम्र", "स्टेशन", "विद्यालय", "ज्ञान", "श्री", "राष्ट्र", "अर्धचन्द्र", "डॉक्टर",
  "क्‍ष", "क्त", "द्वि", "त्र", "संयुक्त", "परीक्षा", "one दो three", "123४५६", "नमस्ते दुनिया",
  "ळ", "र्", "्", "ि", "कि", "की", "कु", "कू", "के", "कै", "को", "कौ", "कं", "कः", "कँ",
];

(async () => {
  const fk = await fontkit.create(bytes);
  let pass = 0, fail = 0;
  for (const text of TESTS) {
    const want = fk.layout(text).glyphs.map((g) => `${g.id}:${g.codePoints.map(c=>c.toString(16)).join(",")}`);
    const got = shapeText(font, text).map((g) => `${g.id}:${g.codePoints.map(c=>c.toString(16)).join(",")}`);
    const ok = want.length === got.length && want.every((w, i) => w === got[i]);
    if (ok) { pass++; }
    else {
      fail++;
      console.log(`✗ ${JSON.stringify(text)}`);
      console.log(`   want: ${want.join(" ")}`);
      console.log(`   got : ${got.join(" ")}`);
    }
  }
  console.log(`\n${pass}/${pass + fail} glyph-sequence parity`);
})();
