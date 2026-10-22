import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * create-electronic-invoice (RB5-b, invoices family). Factur-X hybrid
 * invoice builder: ONE existing PDF + ONE CII XML (rsm:CrossIndustryInvoice)
 * → the XML is embedded as the factur-x.xml attachment (/AF +
 * /AFRelationship /Alternative) and an XMP block declares it with the
 * chosen conformance level. A small in-surface generator can build a
 * sample EN 16931 XML so the flow can be tested without having data.
 *
 * HONEST scope (the registry description says PDF/A-3 — that is the
 * aspirational PRD line; the truth is this tool does NOT convert to
 * PDF/A-3: no ICC profile, no output intent, no conformance validation.
 * It writes a standards-shaped attachment + XMP; for full Factur-X
 * compliance start from a PDF/A-3 file. The FAQ says this plainly.)
 *
 * create-invoice workspace pattern: landingSurface + fullWidthSurface,
 * minFiles/maxFiles 0 — the surface owns its two upload slots and the
 * run itself (surface-driven worker run, pdf-to-odt convert pattern).
 */
export const config: ToolConfig = {
  toolId: "create-electronic-invoice",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 0,
  landingSurface: true,
  fullWidthSurface: true,
  options: [],
  howKeys: ["cei.how1", "cei.how2", "cei.how3"],
  chainToolIds: ["view-pdf", "compress-pdf", "protect-pdf"],
  features: [
    {
      en: "Your invoice XML (rsm:CrossIndustryInvoice) is embedded as the factur-x.xml attachment exactly the way Factur-X / ZUGFeRD 2.x readers expect: an /AF entry with /AFRelationship /Alternative and the EmbeddedFile stream.",
      hi: "आपका इनवॉइस XML (rsm:CrossIndustryInvoice) factur-x.xml अटैचमेंट की तरह ठीक वैसे जुड़ता है जैसे Factur-X / ZUGFeRD 2.x रीडर चाहते हैं: /AF एंट्री, /AFRelationship /Alternative और EmbeddedFile स्ट्रीम।",
    },
    {
      en: "An XMP metadata block is written into the PDF with the Factur-X properties readers parse: fx:DocumentType INVOICE, fx:DocumentFileName, fx:Version 1.0 and the conformance level you choose (MINIMUM, BASIC or EN 16931).",
      hi: "PDF में XMP मेटाडेटा ब्लॉक लिखा जाता है Factur-X प्रॉपर्टीज़ के साथ जो रीडर पढ़ते हैं: fx:DocumentType INVOICE, fx:DocumentFileName, fx:Version 1.0 और आपकी चुनी कंफ़ॉर्मेंस लेवल (MINIMUM, BASIC या EN 16931)।",
    },
    {
      en: "No XML at hand? Fill a small form (seller, buyer, number, date, currency, 1-3 items, tax rate) and a well-formed EN 16931 sample document is generated for you — totals computed, ready to embed.",
      hi: "पास XML नहीं है? एक छोटा फ़ॉर्म भरें (विक्रेता, खरीदार, नंबर, तारीख़, मुद्रा, 1-3 आइटम, टैक्स दर) और एक सही-ढाँचे वाला EN 16931 सैंपल दस्तावेज़ बन जाता है — रकमें गिनी हुईं, जोड़ने को तैयार।",
    },
    {
      en: "Pages are preserved untouched — same page count, same rendering. The report shows the attachment size, the XMP level, the /AF entry and the XML's invoice number, currency and line count.",
      hi: "पेज बिना बदलाव के बने रहते हैं — उतने ही पेज, वैसा ही रेंडर। रिपोर्ट में अटैचमेंट साइज़, XMP लेवल, /AF एंट्री और XML का इनवॉइस नंबर, मुद्रा और लाइन गिनती दिखती है।",
    },
    {
      en: "Honest about PDF/A: this tool does NOT convert your PDF to PDF/A-3 — no ICC profile or output intent is added. For full Factur-X compliance, start from a PDF/A-3 file.",
      hi: "PDF/A पर ईमानदारी: यह टूल आपकी PDF को PDF/A-3 में नहीं बदलता — ना ICC प्रोफ़ाइल जुड़ती है ना आउटपुट इंटेंट। पूरी Factur-X कंप्लायंस के लिए PDF/A-3 फ़ाइल से शुरू करें।",
    },
    {
      en: "Runs entirely on your device — the PDF and the XML never leave the browser.",
      hi: "पूरा काम आपके डिवाइस पर — PDF और XML ब्राउज़र से बाहर कहीं नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does this make my PDF a PDF/A-3 Factur-X file?",
        hi: "क्या यह मेरी PDF को PDF/A-3 Factur-X फ़ाइल बना देता है?",
      },
      a: {
        en: "No — and we say so plainly. This tool embeds a standards-shaped Factur-X attachment and writes the Factur-X XMP metadata, which is what makes readers find and read your invoice data. It does NOT convert the PDF itself to PDF/A-3: no ICC colour profile is embedded, no output intent is added, and no full conformance validation is run. For a fully compliant Factur-X/ZUGFeRD file, start from a PDF that is already PDF/A-3 and add the attachment here.",
        hi: "नहीं — और हम इसे साफ़ कहते हैं। यह टूल एक स्टैंडर्ड-ढाँचे का Factur-X अटैचमेंट जोड़ता है और Factur-X XMP मेटाडेटा लिखता है — इसी से रीडर आपका इनवॉइस डेटा ढूँढकर पढ़ पाते हैं। यह PDF को ख़ुद PDF/A-3 में नहीं बदलता: ना ICC कलर प्रोफ़ाइल जुड़ती है, ना आउटपुट इंटेंट, ना कोई पूरी कंप्लायंस जाँच होती है। पूरी तरह कंप्लायंट Factur-X/ZUGFeRD फ़ाइल के लिए पहले से PDF/A-3 वाली PDF लें और यहीं अटैचमेंट जोड़ें।",
      },
    },
    {
      q: {
        en: "Which conformance level should I choose?",
        hi: "मुझे कौन सी कंफ़ॉर्मेंस लेवल चुननी चाहिए?",
      },
      a: {
        en: "Whichever level your XML actually is — we stamp exactly what you choose into the XMP (fx:ConformanceLevel), and a wrong stamp makes readers reject a file just as fast as missing data. This tool does not judge your XML's semantics: it only checks that the root is rsm:CrossIndustryInvoice. Semantic validation of the invoice content is the job of a dedicated validator (the validate e-invoice tool), not this one.",
        hi: "वही जो आपका XML सच में है — हम आपकी चुनी लेवल हूबहू XMP में लिखते हैं (fx:ConformanceLevel), और ग़लत स्टैम्प रीडर को उतनी ही तेज़ी से फ़ाइल नकारने पर मजबूर करता है जितना ग़ायब डेटा। यह टूल आपके XML के सेमैंटिक्स का फ़ैसला नहीं करता: वह सिर्फ़ इतना जाँचता है कि रूट rsm:CrossIndustryInvoice है। इनवॉइस कंटेंट की सेमैंटिक जाँच किसी ख़ास वैलिडेटर (validate e-invoice टूल) का काम है, इसका नहीं।",
      },
    },
    {
      q: {
        en: "What happens to my PDF's pages and content?",
        hi: "मेरी PDF के पेजों और कंटेंट का क्या होता है?",
      },
      a: {
        en: "Nothing on the visible surface: the same pages come out in the same order with the same rendering — only the attachment, the /AF entry and the XMP block are added. The file is saved without object streams (loose objects) because some Factur-X readers mishandle attachments inside compressed object streams. The report honestly notes whether the source PDF already carried PDF/A markers.",
        hi: "दिखने में कुछ नहीं: वही पेज, उसी क्रम में, वैसा ही रेंडर — सिर्फ़ अटैचमेंट, /AF एंट्री और XMP ब्लॉक जुड़ते हैं। फ़ाइल बिना ऑब्जेक्ट स्ट्रीम के सेव होती है (बिखरे ऑब्जेक्ट्स) क्योंकि कुछ Factur-X रीडर कंप्रेस्ड ऑब्जेक्ट स्ट्रीम के अंदर के अटैचमेंट सही से नहीं पढ़ते। रिपोर्ट ईमानदारी से बताती है कि सोर्स PDF में पहले से PDF/A के निशान थे या नहीं।",
      },
    },
  ],
};
