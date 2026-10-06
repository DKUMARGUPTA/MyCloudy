import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Change document information (PRD §8.2): edit Title, Author, Subject,
 * Keywords, Creator, Producer and the dates — or clear everything with the
 * "Remove all metadata" quick action. Custom surface (before/after preview)
 * + custom panel (the form) own every interactive value (split-tool
 * pattern — schema stays empty, the worker defaults defensively).
 */
export const config: ToolConfig = {
  toolId: "change-pdf-doc-info",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: [
    "remove-pdf-metadata",
    "compress-pdf",
    "add-watermark",
    "split-pdf",
  ],
  features: [
    {
      en: "Edit the title, author, subject, keywords, creator and producer — each field is optional.",
      hi: "टाइटल, लेखक, विषय, कीवर्ड, क्रिएटर और प्रोड्यूसर बदलें — हर फ़ील्ड वैकल्पिक है।",
    },
    {
      en: "Clear any field by leaving it empty — it is removed from the file.",
      hi: "कोई फ़ील्ड ख़ाली छोड़ने पर वह फ़ाइल से हट जाता है।",
    },
    {
      en: "One tap \"Remove all metadata\" clears every field, the dates and the XMP block.",
      hi: "एक टैप में \"सारा मेटाडेटा हटाएँ\" — हर फ़ील्ड, तारीख़ें और XMP ब्लॉक साफ़।",
    },
    {
      en: "Keep the original dates, set them to today, or remove them — your choice.",
      hi: "पुरानी तारीख़ें रखें, आज की करें या हटाएँ — आपकी मर्ज़ी।",
    },
    {
      en: "Before / after preview shows exactly what the file will say after applying.",
      hi: "पहले / बाद प्रीव्यू में दिखता है कि लागू करने पर फ़ाइल क्या कहेगी।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where do I see these fields?",
        hi: "ये फ़ील्ड कहाँ दिखते हैं?",
      },
      a: {
        en: "In any PDF reader: File → Properties. The title also shows in the browser tab or window bar of most viewers.",
        hi: "किसी भी PDF रीडर में: फ़ाइल → प्रॉपर्टीज़। टाइटल ज़्यादातर व्यूअर के टैब या विंडो बार में भी दिखता है।",
      },
    },
    {
      q: {
        en: "What happens when I empty a field?",
        hi: "फ़ील्ड ख़ाली करने पर क्या होता है?",
      },
      a: {
        en: "The entry is removed from the file's document information — readers then show nothing for it. Emptying every field removes the information dictionary entirely.",
        hi: "वह एंट्री फ़ाइल की जानकारी से हट जाती है — रीडर फिर उसके लिए कुछ नहीं दिखाते। सभी फ़ील्ड ख़ाली करने पर जानकारी डिक्शनरी पूरी हट जाती है।",
      },
    },
    {
      q: {
        en: "Why remove the XMP block too?",
        hi: "XMP ब्लॉक भी क्यों हटाएँ?",
      },
      a: {
        en: "Many files carry a second copy of this information in XMP. Some readers prefer it, so after editing we remove it by default — otherwise an old title could still show up.",
        hi: "कई फ़ाइलों में यह जानकारी XMP में दूसरी बार भी होती है। कुछ रीडर उसे पहले पढ़ते हैं, इसलिए एडिट के बाद वह डिफ़ॉल्ट रूप से हट जाता है — वरना पुराना टाइटल दिखता रह सकता है।",
      },
    },
  ],
};
