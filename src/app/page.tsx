import { AppShell } from "@/components/doco/app-shell";

/*
 * Home-only FAQPage JSON-LD (P7-SEO: moved out of the root layout so
 * tool pages don't carry the home FAQ). Mirrors the six questions of
 * the home FAQ section (src/components/doco/home/faq.tsx, "faq.*" i18n
 * keys) in English — keep both in sync when editing the copy.
 */
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Is DocoPDF really free to use?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Every tool is free, with no signup, no watermarks and no daily limits. Because most tools run entirely in your browser, they're fast too — your files are processed on your own device, not a distant server.",
      },
    },
    {
      "@type": "Question",
      name: "How do I convert JPG to PDF for free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Open the JPG to PDF tool, drop your photos (JPG, PNG, WEBP, HEIC and TIFF all work), drag them into the order you want, and click Create PDF. The document is built on your device — nothing is ever uploaded.",
      },
    },
    {
      "@type": "Question",
      name: "How can I convert a PDF to Word or text?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "For text, use PDF to Text — it extracts everything on your device and can even read scanned pages with OCR in English or Hindi. A full PDF to Word converter that keeps formatting is on our roadmap.",
      },
    },
    {
      "@type": "Question",
      name: "Are my PDF files uploaded to a server?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Almost every tool runs 100% on your device inside the browser — your files never leave your computer or phone, and once the site is loaded most tools keep working even offline.",
      },
    },
    {
      "@type": "Question",
      name: "Can I edit a PDF without Adobe Acrobat?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Edit PDF gives you a Word-style editor — click existing text to retype it, add images, shapes and signatures, highlight and annotate — free and on your device. Annotate PDF and Write PDF round out the set.",
      },
    },
    {
      "@type": "Question",
      name: "Does DocoPDF work in Hindi?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. The whole interface is available in Hindi, and you can write PDFs in Devanagari, fill Hindi forms and OCR scanned documents in Hindi with fully searchable output.",
      },
    },
  ],
};

function FaqJsonLdScript() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
    />
  );
}

/**
 * Home route "/" — the primary app entry (metadata comes from the root
 * layout's defaults). The shell itself is shared by every crawlable
 * route (P7-SEO: /tools, /tool/<id>, /hi/… render the same application
 * with their own server-rendered <head>).
 */
export default function Home() {
  return (
    <>
      <FaqJsonLdScript />
      <AppShell initialRoute={{ view: "home" }} />
    </>
  );
}
