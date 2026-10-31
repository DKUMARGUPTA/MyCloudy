import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Email to PDF (P3-c / R57) — .eml message files → a clean, readable PDF,
 * 100% on-device (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone (accepts any file — the worker
 * validates the RFC 5322 structure itself), options (page size, header
 * block, attachment list), the worker parses the MIME tree with our OWN
 * pure parser (folded headers, RFC 2047 encoded words, quoted-printable
 * and base64 bodies, multipart alternative/mixed/related) and renders
 * the message on the OWN PDF engine.
 */
export const config: ToolConfig = {
  toolId: "email-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
      ],
      default: "a4",
    },
    {
      kind: "switch",
      id: "includeHeaders",
      label: { en: "Show the message header", hi: "मैसेज हेडर दिखाएँ" },
      hint: {
        en: "From, To, Cc, Date and Subject rendered at the top of the first page.",
        hi: "From, To, Cc, Date और Subject पहले पेज के ऊपर छपते हैं।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "includeAttachments",
      label: { en: "List attachments", hi: "अटैचमेंट की सूची" },
      hint: {
        en: "A section naming every attachment with its size — the files themselves are not embedded.",
        hi: "हर अटैचमेंट का नाम और आकार वाला हिस्सा — फ़ाइलें खुद PDF में नहीं जुड़तीं।",
      },
      default: true,
    },
  ],
  chainToolIds: ["compress-pdf", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Exported .eml messages become a clean, readable PDF — header block, the real text body, and an honest list of every attachment with its size.",
      hi: "एक्सपोर्ट किए .eml मैसेज साफ़, पढ़ने-योग्य PDF बनते हैं — हेडर ब्लॉक, असली टेक्स्ट बॉडी, और हर अटैचमेंट का नाम-आकार वाली ईमानदार सूची।",
    },
    {
      en: "The full MIME tree is honoured: quoted-printable and base64 bodies, multipart messages, RFC 2047 encoded subjects — Hindi subjects print properly.",
      hi: "पूरा MIME ट्री माना जाता है: quoted-printable और base64 बॉडी, मल्टीपार्ट मैसेज, RFC 2047 एनकोडेड विषय — हिन्दी विषय सही छपते हैं।",
    },
    {
      en: "When a message only has an HTML body, it is converted to tidy plain text — clearly noted, never silently mangled.",
      hi: "जब मैसेज में सिर्फ़ HTML बॉडी हो, तो उसे साफ़ प्लेन टेक्स्ट में बदला जाता है — साफ़ बताया जाता है, चुपचाप बिगाड़ा नहीं जाता।",
    },
    {
      en: "Parsing and rendering happen entirely in your browser — private emails never touch a server.",
      hi: "पार्सिंग और रेंडरिंग पूरी तरह ब्राउज़र में — निजी ईमेल कभी सर्वर तक नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where do I get an .eml file?",
        hi: ".eml फ़ाइल कहाँ से मिले?",
      },
      a: {
        en: "Every mail app can export one. Gmail: open the message → ⋮ → Show original → Download message. Outlook: drag the mail to the desktop or File → Save As. Apple Mail: File → Save As → Raw Message Source. Thunderbird: Save As → File.",
        hi: "हर मेल ऐप एक्सपोर्ट कर सकता है। Gmail: मैसेज खोलें → ⋮ → Show original → Download message। Outlook: मेल को डेस्कटॉप पर खींचें या File → Save As। Apple Mail: File → Save As → Raw Message Source। Thunderbird: Save As → File।",
      },
    },
    {
      q: {
        en: "Are attachments included in the PDF?",
        hi: "अटैचमेंट PDF में शामिल होते हैं?",
      },
      a: {
        en: "Listed, not embedded — the PDF names each attachment with its size so the record is complete. If you need an attachment's own contents (say a PDF invoice), save it from your mail app and convert it with the matching tool here.",
        hi: "सूची में हाँ, अंदर नहीं — PDF हर अटैचमेंट का नाम और आकार देता है ताकि रिकॉर्ड पूरा रहे। अटैचमेंट की असली चीज़ चाहिए (जैसे PDF इनवॉइस) तो मेल ऐप से सेव करें और यहाँ मिलते-जुलते टूल से बदलें।",
      },
    },
    {
      q: {
        en: "Why is the plain-text body preferred over the HTML one?",
        hi: "HTML बॉडी की जगह प्लेन-टेक्स्ट क्यों पसंद की जाती है?",
      },
      a: {
        en: "Messages with both parts offer the plain text as the exact words the sender typed — no styling engine needed, nothing approximated. When only HTML exists, it is converted to tidy text and the result notes that. Images-only newsletters may therefore render sparsely — that is the honest outcome.",
        hi: "जिन मैसेज में दोनों हिस्से हों, वे प्लेन टेक्स्ट को भेजने वाले के शब्दों की ज्यों-की-त्यों कहानी मानते हैं — न स्टाइलिंग इंजन चाहिए, न कुछ अंदाज़ा लगाया जाता। जब सिर्फ़ HTML हो, वह साफ़ टेक्स्ट में बदलता है और नतीजा यह बताता है। सिर्फ़-इमेज न्यूज़लेटर इसलिए थोड़े खाली दिख सकते हैं — यही ईमानदार नतीजा है।",
      },
    },
  ],
};
