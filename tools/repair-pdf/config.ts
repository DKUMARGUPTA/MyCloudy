import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Repair PDF (RB3-c): the raw-byte PDF salvager. Rebuilds broken
 * cross-reference tables, re-anchors a %PDF- header buried under email
 * junk, corrects wrong stream /Length entries, resolves duplicate
 * objects (last one wins) and rewrites a missing %%EOF — then verifies
 * the rebuilt file with a strict pdf-lib load and reports the honest
 * page count it can actually see.
 *
 * Honest limits (mirrored in the FAQ):
 *  - truncated page content is gone for good — the report says so via
 *    truncationDetected instead of inventing pages;
 *  - encrypted files are rejected (repair is not crack — unlock-pdf is
 *    the password tool);
 *  - a file with no recoverable catalog fails honestly (rep.errNoCatalog).
 */
export const config: ToolConfig = {
  toolId: "repair-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  howKeys: ["rep.how1", "rep.how2", "rep.how3"],
  chainToolIds: ["view-pdf", "compress-pdf", "web-optimize-pdf"],
  options: [
    {
      kind: "switch",
      id: "alsoRebuildValid",
      label: { en: "Rebuild even valid files", hi: "ठीक फ़ाइल भी दोबारा बनाएँ" },
      hint: {
        en: "When the structure check passes, the file is still rewritten with a fresh header, xref and trailer — turn this off to get a healthy file back byte-for-byte unchanged.",
        hi: "जब स्ट्रक्चर जाँच पास हो जाए, फ़ाइल फिर भी नए हेडर, xref और ट्रेलर से दोबारा लिखी जाती है — बंद करने पर स्वस्थ फ़ाइल बिल्कुल वैसी ही, बाइट-दर-बाइट लौटती है।",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "Common corruptions fixed: broken or missing xref/startxref tables, garbage bytes before the %PDF- header (email wrappers), wrong stream /Length entries, duplicate objects from concatenated files, and a missing %%EOF marker.",
      hi: "आम ख़राबियाँ ठीक होती हैं: टूटी या ग़ायब xref/startxref टेबल, %PDF- हेडर से पहले की कचरा बाइट्स (ईमेल रैपर), स्ट्रीम की ग़लत /Length, जुड़ी हुई फ़ाइलों के डुप्लिकेट ऑब्जेक्ट, और ग़ायब %%EOF चिह्न।",
    },
    {
      en: "The salvage is a raw byte scan: every \"N G obj\" object is recovered, duplicate object numbers are resolved last-wins (what viewers do), and a brand-new xref table plus trailer is rebuilt around the catalog that has the most reachable pages.",
      hi: "सैल्वेज एक रॉ बाइट स्कैन है: हर \"N G obj\" ऑब्जेक्ट वापस मिलता है, डुप्लिकेट ऑब्जेक्ट नंबर आख़िरी-जीत नियम से सुलझते हैं (वही जो व्यूअर करते हैं), और सबसे ज़्यादा पेज वाले कैटलॉग के चारों ओर नई xref टेबल और ट्रेलर बनती है।",
    },
    {
      en: "Every repair is verified before it ships: the rebuilt file must strict-load with correct object parsing, and the reported page count is what that verification actually sees — never a declared /Count.",
      hi: "हर मरम्मत भेजने से पहले जाँची जाती है: दोबारा बनी फ़ाइल सख़्त पार्सिंग से खुलनी चाहिए, और रिपोर्ट का पेज काउंट वही है जो जाँच सच में देखती है — कभी भी लिखा हुआ /Count नहीं।",
    },
    {
      en: "Honest about the limits: content that was cut off in a truncated download is lost — the report shows truncationDetected and the page count reflects what survived. Encrypted files are rejected (repair is not cracking — use Unlock PDF).",
      hi: "सीमाओं पर ईमानदार: कटी हुई डाउनलोड का जो हिस्सा गया, वह लौटता नहीं — रिपोर्ट truncationDetected दिखाती है और पेज काउंट बचे हिस्से के हिसाब से होता है। एन्क्रिप्टेड फ़ाइलें अस्वीकृत (मरम्मत क्रैकिंग नहीं — Unlock PDF इस्तेमाल करें)।",
    },
    {
      en: "Runs entirely on your device — the damaged PDF is never uploaded anywhere.",
      hi: "पूरा काम डिवाइस पर — ख़राब PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "My PDF won't open. Can this tool bring it back?",
        hi: "मेरी PDF खुल नहीं रही। क्या यह टूल उसे लौटा सकता है?",
      },
      a: {
        en: "Often, yes — when the damage is structural. The tool raw-scans the file for every object it can still find and rebuilds a fresh cross-reference table, header and trailer around them. That covers the classic cases: broken xref/startxref offsets, junk bytes glued before the header, wrong stream lengths, doubled-up objects from a bad merge, a missing %%EOF. What it cannot do is resurrect content that is no longer in the bytes: a download that stopped halfway simply does not contain the rest of the file, and the report tells you honestly when that is what it saw.",
        hi: "अक्सर हाँ — जब नुक़सान स्ट्रक्चर का हो। टूल फ़ाइल का रॉ स्कैन करके हर उस ऑब्जेक्ट को ढूँढता है जो अब भी मौजूद है और उनके चारों ओर नई क्रॉस-रेफ़रेंस टेबल, हेडर और ट्रेलर बनाता है। इससे आम केस आ जाते हैं: टूटे xref/startxref ऑफ़सेट, हेडर से पहले चिपकी कचरा बाइट्स, ग़लत स्ट्रीम लंबाई, बिगड़े मर्ज के दोहरे ऑब्जेक्ट, ग़ायब %%EOF। जो यह नहीं कर सकता: बाइट्स में ही न बची चीज़ लौटाना — बीच में रुकी डाउनलोड में फ़ाइल का बाक़ी हिस्सा होता ही नहीं, और रिपोर्ट ईमानदारी से बता देती है कि ऐसा ही देखा गया।",
      },
    },
    {
      q: {
        en: "What exactly is repaired, and what is lost forever?",
        hi: "ठीक-ठाक क्या ठीक होता है, और क्या हमेशा के लिए गया?",
      },
      a: {
        en: "Repaired: cross-reference tables and startxref offsets, the %PDF- header position, stream /Length values, duplicate object numbers (the last complete copy wins — the same rule viewers apply), the page tree's connections and the %%EOF marker. Lost forever: anything past a cut — if the file was truncated mid-object, that object's remaining content is not in the file and no tool can re-create it; the report flags truncationDetected and the page count reflects only what survived. Also note that heavily encrypted files are rejected with a clear message — repairing is not password cracking, and the Unlock PDF tool is the right place for that.",
        hi: "ठीक होता है: क्रॉस-रेफ़रेंस टेबल और startxref ऑफ़सेट, %PDF- हेडर की जगह, स्ट्रीम की /Length, डुप्लिकेट ऑब्जेक्ट नंबर (आख़िरी पूरी प्रति जीतती है — वही नियम जो व्यूअर लागू करते हैं), पेज-ट्री के कनेक्शन और %%EOF चिह्न। हमेशा के लिए गया: कटाव के आगे का सब कुछ — फ़ाइल किसी ऑब्जेक्ट के बीच में कटी है तो उसका बचा हुआ कंटेंट फ़ाइल में है ही नहीं, कोई टूल उसे दोबारा नहीं बना सकता; रिपोर्ट truncationDetected दिखाती है और पेज काउंट सिर्फ़ बचे हिस्से का होता है। साथ ही: एन्क्रिप्टेड फ़ाइलें साफ़ संदेश के साथ अस्वीकृत — मरम्मत पासवर्ड तोड़ना नहीं है, उसके लिए Unlock PDF टूल सही जगह है।",
      },
    },
    {
      q: {
        en: "Is my file safe? Where does this happen?",
        hi: "क्या मेरी फ़ाइल सुरक्षित है? यह सब कहाँ होता है?",
      },
      a: {
        en: "Entirely inside your browser — a Web Worker thread reads the bytes, scans them and writes the rebuilt PDF on this device. Nothing is uploaded, no account, no watermark, no queue. One file at a time, and the strict verification load happens on-device too, so even the check never leaves your machine.",
        hi: "पूरा काम आपके ब्राउज़र में — एक वर्कर थ्रेड बाइट्स पढ़ती है, स्कैन करती है और दोबारा बनी PDF इसी डिवाइस पर लिखती है। कुछ अपलोड नहीं, न खाता, न वॉटरमार्क, न क़तार। एक बार में एक फ़ाइल, और सख़्त जाँच-वाला लोड भी डिवाइस पर ही होता है — जाँच भी आपकी मशीन से बाहर नहीं जाती।",
      },
    },
  ],
};
