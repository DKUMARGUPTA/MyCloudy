import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/toaster";
import { LocaleProvider } from "@/components/providers/locale-provider";

import "./globals.css";

/*
 * Self-hosted fonts (PRD §3.2 / hard rule: no third-party CDNs).
 * Files: src/fonts/InterVariable.woff2 (official Inter variable, full charset)
 *        src/fonts/NotoSansDevanagari-Variable.woff2 (Devanagari subset,
 *        variable) — used as the fallback face for Hindi text.
 * Both are served from this origin via next/font/local with font-display swap.
 */
const inter = localFont({
  src: "../fonts/InterVariable.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-inter",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
});

const notoSansDevanagari = localFont({
  src: "../fonts/NotoSansDevanagari-Variable.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-noto-devanagari",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

/*
 * SEO metadata — copy follows the keyword research (search intent around
 * "free PDF tools / converter / editor", "jpg to pdf", "pdf to word",
 * "pdf to jpg", "edit pdf online free", privacy + Hindi differentiators).
 * Keep the title ≤ ~60 chars and the description ≤ ~160 chars.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://docopdf.com"),
  title: {
    default: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    template: "%s · DocoPDF",
  },
  description:
    "60+ free online PDF tools: convert JPG to PDF, PDF to JPG or text, merge, compress, edit, sign and OCR PDF files. No signup — files stay on your device. English + हिंदी",
  applicationName: "DocoPDF",
  keywords: [
    "free PDF tools",
    "PDF tools",
    "PDF converter",
    "free PDF editor",
    "edit PDF online free",
    "free tool to edit PDF documents",
    "PDF editing tools free",
    "JPG to PDF",
    "PDF to JPG",
    "PDF to Word",
    "convert PDF to Word",
    "PDF to text",
    "PDF conversion tool",
    "merge PDF",
    "compress PDF",
    "sign PDF",
    "online PDF tools",
    "Hindi PDF tools",
    "DocoPDF",
  ],
  icons: {
    icon: [{ url: "/logo.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    siteName: "DocoPDF",
    url: "/",
    title: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    description:
      "60+ free online PDF tools. Convert, merge, compress, edit, sign and OCR PDF files — no signup, files stay on your device. English + हिंदी",
    locale: "en_US",
    alternateLocale: ["hi_IN"],
  },
  twitter: {
    card: "summary",
    title: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    description:
      "60+ free online PDF tools. No signup — files stay on your device.",
  },
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1220" },
  ],
};

/*
 * JSON-LD structured data (SEO). The FAQPage mirrors the six questions of
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

const appJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "DocoPDF",
  url: "https://docopdf.com/",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Any",
  inLanguage: ["en", "hi"],
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  description:
    "Free online PDF tools — convert JPG to PDF, PDF to JPG or text, merge, compress, edit, sign and OCR PDF files right in your browser. No signup; files stay on your device.",
  featureList: [
    "PDF converter (JPG, PNG, WEBP, HEIC, TIFF, SVG, Text, Markdown to PDF)",
    "PDF to JPG and PDF to text",
    "Merge, split, rearrange and organize PDF pages",
    "Compress PDF with quality presets or a target file size",
    "Word-style PDF editor — edit existing text, add images and shapes",
    "Annotate, highlight and add sticky notes",
    "Sign PDF and password-protect PDF files",
    "PDF OCR in English and Hindi with searchable output",
    "Create PDFs: write, scan, QR codes, planners and note paper",
    "100% on-device processing — files never leave the browser",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${notoSansDevanagari.variable} font-sans antialiased bg-background text-foreground`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(appJsonLd),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(faqJsonLd),
          }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <LocaleProvider>
            {children}
            <Toaster />
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
