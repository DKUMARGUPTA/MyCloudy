import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Duplex collate (P1-d / R53) — the manual-duplex-scanner fix. Scanning a
 * double-sided stack without a duplex ADF produces two blocks: every front
 * (1, 3, 5…), then every back — in an order that depends on how the stack
 * was flipped. This tool interleaves them back into reading order, on our
 * own engine, byte-exact page copies, with an optional blank pad for odd
 * page counts.
 */
export const config: ToolConfig = {
  toolId: "duplex-collate",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "layout",
      label: { en: "Scan layout", hi: "स्कैन लेआउट" },
      hint: {
        en: "Which block came out of the scanner first.",
        hi: "स्कैनर से पहले कौन-सा हिस्सा निकला।",
      },
      choices: [
        {
          value: "fronts-first",
          label: { en: "Fronts first (1, 3, 5… then backs)", hi: "पहले अगले पेज (1, 3, 5… फिर पिछले)" },
        },
        {
          value: "backs-first",
          label: { en: "Backs first, then fronts", hi: "पहले पिछले पेज, फिर अगले" },
        },
      ],
      default: "fronts-first",
    },
    {
      kind: "select",
      id: "flip",
      label: { en: "How you flipped the stack", hi: "स्टैक कैसे पलटा था" },
      hint: {
        en: "Book-style (left edge) reverses the backs; calendar-style (top edge) keeps them in order.",
        hi: "किताब की तरह (बाएँ किनारे) पलटने पर पिछले पेज उल्टे आते हैं; कैलेंडर की तरह (ऊपर किनारे) पर क्रम वही रहता है।",
      },
      choices: [
        {
          value: "long-edge",
          label: { en: "Like a book — backs reversed (…6, 4, 2)", hi: "किताब की तरह — पिछले उल्टे (…6, 4, 2)" },
        },
        {
          value: "short-edge",
          label: { en: "Like a calendar — backs in order (2, 4, 6…)", hi: "कैलेंडर की तरह — पिछले क्रम में (2, 4, 6…)" },
        },
      ],
      default: "long-edge",
    },
    {
      kind: "switch",
      id: "padBlank",
      label: { en: "Pad the missing back with a blank page", hi: "ग़ायब पिछले पेज की जगह ख़ाली पेज" },
      hint: {
        en: "For odd page counts — keeps sheet pairs even for re-printing.",
        hi: "विषम पेज संख्या पर — दोबारा प्रिंट करते समय जोड़ी बरकरार रहे।",
      },
      default: false,
    },
  ],
  chainToolIds: ["merge-pdf", "rotate-pdf-pages", "extract-pdf-pages"],
  features: [
    {
      en: "Turns a two-block duplex scan — all fronts, then all backs — back into 1, 2, 3, 4 order.",
      hi: "दो-हिस्सों वाले डुप्लेक्स स्कैन — पहले सारे अगले, फिर सारे पिछले पेज — को वापस 1, 2, 3, 4 क्रम में लाता है।",
    },
    {
      en: "Both flip styles covered: book flip (backs reversed) and calendar flip (backs in order).",
      hi: "दोनों पलटने के तरीक़े: किताब जैसा (पिछले उल्टे) और कैलेंडर जैसा (पिछले क्रम में)।",
    },
    {
      en: "Odd page count? Optionally pad the missing back with a blank page sized like its front.",
      hi: "विषम पेज संख्या? ग़ायब पिछले पेज की जगह उसी साइज़़ का ख़ाली पेज जोड़ सकते हैं।",
    },
    {
      en: "Page content passes through byte-exact — nothing is re-rendered or re-compressed.",
      hi: "पेज कंटेंट बाइट-दर-बाइट वैसा ही रहता है — कुछ भी दोबारा रेंडर या कंप्रेस नहीं होता।",
    },
    {
      en: "Runs entirely on your device — the scan never leaves your browser.",
      hi: "पूरा काम आपके डिवाइस पर — स्कैन ब्राउज़र से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "My output order is still wrong — what do I do?",
        hi: "मेरा आउटपुट क्रम फिर भी ग़लत है — क्या करूँ?",
      },
      a: {
        en: "One of the two options is set for the opposite physical reality. If pages alternate but pairs look swapped (2 before 1), switch the scan layout; if the backs come out mirrored (5 before 2), switch the flip style. One retry with the other combination always lands right.",
        hi: "दो में से एक विकल्प उल्टी दिशा में है। अगर पेज बारी-बारी आते हैं पर जोड़ी उल्टी लगती है (2 पहले, 1 बाद) तो स्कैन लेआउट बदलें; अगर पिछले पेज शीशे की तरह उल्टे चले आएँ (5 पहले, 2 बाद) तो पलटने का तरीक़ा बदलें। दूसरे combination से एक कोशिश में सही हो जाएगा।",
      },
    },
    {
      q: {
        en: "Can it merge fronts and backs from two separate scans?",
        hi: "क्या दो अलग स्कैन के अगले-पिछले पेज जोड़ सकता है?",
      },
      a: {
        en: "Not yet — this tool expects ONE file where both blocks live. Merge the two scans first (our Merge PDF keeps page order), then collate the combined file.",
        hi: "अभी नहीं — यह टूल एक ही फ़ाइल मानता है जिसमें दोनों हिस्से हों। पहले दोनों स्कैन मर्ज करें (हमारा Merge PDF क्रम बनाए रखता है), फिर जुड़ी फ़ाइल को collate करें।",
      },
    },
    {
      q: {
        en: "Why does it refuse a 2-page file?",
        hi: "2 पेज की फ़ाइल पर मना क्यों करता है?",
      },
      a: {
        en: "With one front and one back, every option combination produces the exact same order — collation has nothing to do. Shipping an identical copy with a new name would be dishonest, so the tool says so instead.",
        hi: "एक अगला और एक पिछला पेज — हर विकल्प का नतीजा बिल्कुल वही क्रम देता है, करने जैसा कुछ बचता ही नहीं। नए नाम से वही फ़ाइल देना ईमानदारी नहीं होती, इसलिए टूल सच बता देता है।",
      },
    },
  ],
};
