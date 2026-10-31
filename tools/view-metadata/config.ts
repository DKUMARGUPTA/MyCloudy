import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * View PDF metadata (P1-c) — the read-only inspector. Everything a PDF
 * says about itself — document info (title, author, dates…), page sizes
 * and rotations, XMP packet, PDF version, encryption state — read with
 * the own engine and exported as a clean TXT or JSON report. Nothing is
 * modified, nothing is uploaded.
 */
export const config: ToolConfig = {
  toolId: "view-metadata",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Report format", hi: "रिपोर्ट फ़ॉर्मैट" },
      hint: {
        en: "TXT reads like a clean spec sheet; JSON is for scripts and pipelines.",
        hi: "TXT साफ़ स्पेक-शीट जैसा; JSON स्क्रिप्ट और पाइपलाइन के लिए।",
      },
      choices: [
        { value: "txt", label: { en: "TXT — readable", hi: "TXT — पढ़ने लायक़" } },
        { value: "json", label: { en: "JSON — for scripts", hi: "JSON — स्क्रिप्ट के लिए" } },
      ],
      default: "txt",
    },
    {
      kind: "switch",
      id: "includePages",
      label: { en: "List every page", hi: "हर पेज की पंक्ति" },
      hint: {
        en: "Adds a per-page section: size in points/mm and rotation. Off shows just the size summary.",
        hi: "हर पेज का साइज़ (पॉइंट/मिमी) और रोटेशन जोड़ता है। बंद होने पर सिर्फ़ सारांश।",
      },
      default: true,
    },
  ],
  chainToolIds: ["remove-pdf-metadata", "change-pdf-doc-info"],
  features: [
    {
      en: "See everything the PDF says about itself — title, author, subject, keywords, creator, dates.",
      hi: "PDF की अपनी सारी जानकारी देखें — टाइटल, लेखक, विषय, कीवर्ड, निर्माता, तारीख़ें।",
    },
    {
      en: "Document facts: page count, every page size (points + mm) and rotation, PDF version, file size.",
      hi: "दस्तावेज़ तथ्य: पेज संख्या, हर पेज का साइज़ (पॉइंट + मिमी) और रोटेशन, PDF वर्ज़न, फ़ाइल साइज़।",
    },
    {
      en: "Flags XMP packets presence and whether the file is password-protected — before you share it.",
      hi: "XMP पैकेट और पासवर्ड-लॉक की स्थिति बताता है — शेयर करने से पहले।",
    },
    {
      en: "Export as a clean TXT sheet or JSON for scripts — custom Info keys ride along too.",
      hi: "साफ़ TXT शीट या स्क्रिप्ट के लिए JSON — कस्टम Info कुंजियाँ भी साथ चलती हैं।",
    },
    {
      en: "Strictly read-only — the PDF is never modified, and never leaves your device.",
      hi: "पूरी तरह सिर्फ़ पढ़ने लायक़ — PDF में कुछ नहीं बदलता, और डिवाइस से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between this and Remove metadata?",
        hi: "इसमें और Remove metadata में क्या फ़र्क़ है?",
      },
      a: {
        en: "This tool only LOOKS — it builds a report of every hidden field. Remove metadata shows the same fields but then strips the ones you pick. Inspect first, clean second.",
        hi: "यह टूल सिर्फ़ देखता है — हर छुपे फ़ील्ड की रिपोर्ट बनाता है। Remove metadata वही फ़ील्ड दिखाकर चुने हुए मिटा देता है। पहले जाँचें, फिर साफ़ करें।",
      },
    },
    {
      q: {
        en: "Can it read a password-protected PDF?",
        hi: "क्या पासवर्ड वाली PDF पढ़ सकता है?",
      },
      a: {
        en: "The report honestly states that the file is encrypted and shows what is visible without the password (name, size). Unlock it first if you need the full inspection.",
        hi: "रिपोर्ट ईमानदारी से बताती है कि फ़ाइल एन्क्रिप्टेड है और बिना पासवर्ड जो दिखता है वह दिखाती है (नाम, साइज़)। पूरी जाँच के लिए पहले अनलॉक करें।",
      },
    },
    {
      q: {
        en: "Why do some fields show as empty?",
        hi: "कुछ फ़ील्ड ख़ाली क्यों दिखते हैं?",
      },
      a: {
        en: "Because the PDF never had them — most files only carry a Producer tag from the tool that made them. An empty field is the honest truth, not a bug.",
        hi: "क्योंकि PDF में वे पहले से नहीं थे — ज़्यादातर फ़ाइलों में सिर्फ़ Producer होता है, बनाने वाले टूल का। ख़ाली फ़ील्ड सच है, बग नहीं।",
      },
    },
  ],
};
