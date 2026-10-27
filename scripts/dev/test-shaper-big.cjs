const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const { shapeText } = require("/home/z/my-project/src/lib/own/pdf/shape-deva.ts");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");

const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);

// Deterministic PRNG for reproducibility
let seed = 123456789;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const CONS = "कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसहऴकषकख".split("");
const MATRAS = ["", "\u093e", "\u093f", "\u0940", "\u0941", "\u0942", "\u0947", "\u0948", "\u094b", "\u094c", "\u093e\u0902", "\u0947\u0901"];
const VIRAMA = "\u094d";
const VOWELS = "अआइईउऊएऐओऔ".split("");
const SIGNS = ["", "\u0901", "\u0902", "\u0903", "\u0902\u0901"];
const JOINERS = ["", "\u200c", "\u200d"];

function randomWord() {
  const n = 1 + Math.floor(rnd() * 3); // consonant clusters 1-3
  let w = "";
  for (let i = 0; i < n; i++) {
    w += pick(CONS) + pick(JOINERS) + (rnd() < 0.25 ? "\u093c" : "");
    if (i < n - 1) w += VIRAMA + pick(JOINERS);
  }
  w += pick(MATRAS) + pick(SIGNS);
  return w;
}
function randomText() {
  const words = [];
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.72) words.push(randomWord());
    else if (r < 0.78) words.push(pick(VOWELS) + pick(MATRAS));
    else if (r < 0.84) words.push(String(Math.floor(rnd() * 1000)));
    else if (r < 0.9) words.push("abc".slice(0, 1 + Math.floor(rnd() * 3)) + Math.floor(rnd() * 10));
    else if (r < 0.94) words.push(pick(["।", "॥", "-", "(", ")", "%", "@"]));
    else words.push(pick(MATRAS) || "\u094d"); // broken clusters
  }
  return words.join(" ");
}

const TESTS = [];
// curated corner cases
TESTS.push(
  "क्रम", "प्रक्रिया", "अभ्यास", "स्वागतम्", "विश्वविद्यालय", "उत्कृष्ट", "मुख्यमंत्री",
  "अंतर्राष्ट्रीय", "प्रधानमंत्री", "संसदीय", "दृष्टिकोण", "सृष्टि", "व्यवस्थापन",
  "तत्त्व", "विद्यार्थी", "शिक्षणसंस्था", "पुनर्जन्म", "स्वातंत्र्य", "अन्तर्राष्ट्रीय",
  "कार्यक्रम", "विशेषज्ञ", "प्रतिनिधि", "अध्यक्ष", "संविधान", "उत्तराखण्ड",
  "भारतीय संविधान के अनुच्छेद ३७०", "पृथ्वी", "वृक्ष", "सृजन", "धृतराष्ट्र",
  "क्षत्रिय", "त्रुटि", "द्रव्य", "प्रकृति", "श्रुति", "स्मृति", "भ्रम", "ग्रहण",
  "\u0915\u094d\u200c\u0937", "\u0915\u094d\u200d\u0937", "र्\u200cक", "र्\u200dक",
  "क्", "िक", "्क", "क्ि", "ँ", "\u094d\u094d", "क\u094d\u094dक", "अा", "आॅ", "ऍ",
  "ज़", "फ़", "ख़", "ग़", "ड़", "ढ़", "य़", "ऱ",
  "०१२३४५६७८९", "पृष्ठ १२", "Chapter १", "एक-दो", "½", "\u00bd",
  "Hybrid मिश्रित", "Café", "\u041f\u0440\u0438\u0432\u0435\u0442", "Σ\u03b5\u03bb",
);
// random corpus
for (let i = 0; i < 4000; i++) TESTS.push(randomText());

(async () => {
  const fk = await fontkit.create(bytes);
  let pass = 0, fail = 0;
  const failures = [];
  for (const text of TESTS) {
    let want, got, wErr = null, gErr = null;
    try { want = fk.layout(text).glyphs.map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`); } catch (e) { wErr = e.message; }
    try { got = shapeText(font, text).map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`); } catch (e) { gErr = e.message; }
    const ok = wErr === gErr && (wErr !== null || (want.length === got.length && want.every((w, i) => w === got[i])));
    if (ok) { pass++; continue; }
    fail++;
    if (failures.length < 12) failures.push({ text, want, got, wErr, gErr });
  }
  for (const f of failures) {
    console.log(`✗ ${JSON.stringify(f.text)}`);
    if (f.wErr || f.gErr) { console.log(`   err: fontkit=${f.wErr} ours=${f.gErr}`); continue; }
    const w = f.want.join(" "), g = f.got.join(" ");
    // find first diff position
    let i = 0; while (i < w.length && i < g.length && w[i] === g[i]) i++;
    console.log(`   want: ...${w.slice(Math.max(0, i - 30), i + 30)}...`);
    console.log(`   got : ...${g.slice(Math.max(0, i - 30), i + 30)}...`);
  }
  console.log(`\n${pass}/${pass + fail} parity (${fail} failures)`);
})();
