import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add attachments (PHASE-3): embed any files INSIDE a PDF — contracts,
 * source sheets, evidence — the way mail attachments ride a message.
 * Recipients open them right from the PDF viewer's paperclip panel.
 */
export const config: ToolConfig = {
  toolId: "add-attachments",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "switch",
      id: "keepExisting",
      label: { en: "Keep existing attachments", hi: "मौजूदा अटैचमेंट रखें" },
      hint: {
        en: "Off replaces the document's attachment list",
        hi: "बंद रखने पर दस्तावेज़ की अटैचमेंट सूची बदल जाती है",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "Embed any files inside the PDF — contracts, sources, evidence.",
      hi: "कोई भी फ़ाइल PDF के अंदर जोड़ें — अनुबंध, स्रोत, सबूत।",
    },
    {
      en: "Recipients open them from the viewer's attachment panel — no zip needed.",
      hi: "पाने वाले व्यूअर के अटैचमेंट पैनल से खोलते हैं — ज़िप की ज़रूरत नहीं।",
    },
    {
      en: "Add to the existing list, or replace it entirely.",
      hi: "मौजूदा सूची में जोड़ें, या पूरी बदल दें।",
    },
    {
      en: "Files are stored byte-exact — no re-encoding, no size bloat tricks.",
      hi: "फ़ाइलें बिल्कुल वैसी ही सेव — न दोबारा एनकोड, न साइज़ के खेल।",
    },
    {
      en: "Runs entirely on your device — nothing is uploaded.",
      hi: "पूरा काम डिवाइस पर — कुछ भी अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where do recipients find the attachments?",
        hi: "पाने वालों को अटैचमेंट कहाँ मिलते हैं?",
      },
      a: {
        en: "In the attachments panel of any standard viewer — the paperclip in Acrobat, the sidebar in Firefox and Preview. They can save each file out from there.",
        hi: "किसी भी मानक व्यूअर के अटैचमेंट पैनल में — Acrobat का क्लिप आइकन, Firefox और Preview का साइडबार। वहाँ से हर फ़ाइल सेव की जा सकती है।",
      },
    },
    {
      q: {
        en: "Does embedding re-compress my files?",
        hi: "क्या जोड़ने पर मेरी फ़ाइलें दोबारा कंप्रेस होती हैं?",
      },
      a: {
        en: "No — the bytes are stored exactly as you provide them. The PDF just grows by roughly the size of the attachments.",
        hi: "नहीं — बाइट्स वैसे ही सेव होते हैं जैसे आपने दिए। PDF लगभग उतनी ही बड़ी होती है जितनी अटैचमेंट।",
      },
    },
    {
      q: {
        en: "Any file type limits?",
        hi: "कोई फ़ाइल-टाइप सीमा है?",
      },
      a: {
        en: "PDF, Office documents, images, text — anything. Some strict mail filters flag PDFs carrying embedded executables, so use the Sanitize tool in the other direction when needed.",
        hi: "PDF, ऑफ़िस दस्तावेज़, इमेज, टेक्स्ट — कुछ भी। कुछ सख़्त मेल फ़िल्टर वाली PDF को अटैच की गई एक्ज़ीक्यूटेबल पर रोक लगाते हैं, तब सैनिटाइज़ टूल उल्टी दिशा में काम आता है।",
      },
    },
  ],
};
