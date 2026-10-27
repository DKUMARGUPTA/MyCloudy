const fs = require("node:fs");
const { ParsedTtfFont } = require("/home/z/my-project/src/lib/own/pdf/font-ttf.ts");
const { shapeText } = require("/home/z/my-project/src/lib/own/pdf/shape-deva.ts");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const font = ParsedTtfFont.parse(bytes);

// Realistic corpus: common Hindi words + typical watermark/page-number texts
const WORDS = `नमस्ते भारत हिंदी अभ्यास कार्यक्रम प्रक्रिया विद्यालय शिक्षा छात्र शिक्षक पुस्तक लेखन पठन गणित विज्ञान इतिहास भूगोल अर्थशास्त्र समाजशास्त्र भौतिक रसायन जीव विज्ञान संगीत कला संस्कृति परंपरा आधुनिक तकनीक सूचना प्रौद्योगिकी संचार माध्यम समाचार पत्रिका प्रकाशन लेखक पाठक दर्शक श्रोता विचार अनुभव ज्ञान शिक्षा संस्था विश्वविद्यालय महाविद्यालय परीक्षा प्रमाणपत्र उत्तीर्ण प्रथम द्वितीय तृतीय समय निर्धारण योजना विकास प्रगति सफलता विफलता प्रयास अवसर समस्या समाधान उद्देश्य महत्व आवश्यकता संसाधन व्यवस्था नियम विधि अधिकार कर्तव्य उत्तरदायित्व स्वतंत्रता समानता बंधुता न्याय शांति सद्भाव सहयोग एकता अखंडता राष्ट्र देश समाज परिवार मित्र शत्रु संबंध स्नेह आदर सम्मान प्रेम विश्वास सत्य असत्य धर्म अधर्म पुण्य पाप कर्म फल सिद्धि योग ध्यान साधना आरोग्य स्वास्थ्य रोग चिकित्सा औषधि वैद्य रोगी सेवा देखभाल उपचार स्वस्थ शक्ति सामर्थ्य दुर्बलता बल क्षमता गति वेग दिशा मार्ग यात्रा पर्यटन अतिथि आगंतुक स्वागत अभिनंदन विदाई स्मृति अनुस्मरण इतिहास प्राचीन मध्यकालीन आधुनिक भविष्य वर्तमान अतीत घटना दुर्घटना उपलब्धि सफलता उन्नति प्रगति परिवर्तन क्रांति विद्रोह आंदोलन संघर्ष विजय पराजय संधि समझौता सहमति मतभेद विवाद टीका टिप्पणी समीक्षा आलोचना प्रशंसा सराहना गुण दोष लाभ हानि लाभांश नुकसान पूंजी लागत मूल्य कीमत बाजार व्यापार वाणिज्य उद्योग कारखाना उत्पादन आपूर्ति मांग ग्राहक विक्रेता सेवा व्यापारी व्यवसाय संगठन प्रबंधन नेतृत्व निर्णय योजना क्रियान्वयन परिणाम प्रभाव परिणाम सारांश निष्कर्ष उपसंहार प्रस्तावना विषय वस्तु सामग्री आधार स्रोत साक्ष्य प्रमाण तथ्य आंकड़े सांख्यिकी विश्लेषण अध्ययन अनुसंधान खोज आविष्कार तकनीक`
.split(/\s+/).filter(Boolean);
const TEXTS = [];
for (const w of WORDS) TEXTS.push(w);
for (let i = 0; i < 600; i++) {
  const n = 2 + (i % 6);
  const parts = [];
  for (let j = 0; j < n; j++) parts.push(WORDS[(i * 7 + j * 13) % WORDS.length]);
  TEXTS.push(parts.join(" "));
}
TEXTS.push("Page १ of ५", "गोपाल कृष्णा", "प्रधानमंत्री", "अंतर्राष्ट्रीय", "CONCEPTUAL ड्राफ्ट", "Report — प्रतिवेदन", "आवेदन संख्या 12345", "श्रीमती शर्मा जी");

(async () => {
  const fk = await fontkit.create(bytes);
  let pass = 0, fail = 0;
  const failures = [];
  for (const text of TEXTS) {
    const want = fk.layout(text).glyphs.map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`);
    const got = shapeText(font, text).map((g) => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`);
    const ok = want.length === got.length && want.every((w, i) => w === got[i]);
    if (ok) pass++;
    else { fail++; if (failures.length < 5) failures.push({ text, want, got }); }
  }
  for (const f of failures) {
    console.log(`✗ ${JSON.stringify(f.text)}`);
    for (let i = 0; i < Math.max(f.want.length, f.got.length); i++) {
      if (f.want[i] !== f.got[i]) { console.log(`   want: ${f.want[i]} got: ${f.got[i]}`); break; }
    }
  }
  console.log(`\nREAL-TEXT parity: ${pass}/${pass + fail}`);
})();
