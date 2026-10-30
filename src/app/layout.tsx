import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/toaster";
import { LocaleProvider } from "@/components/providers/locale-provider";
import { AppErrorBoundary } from "@/components/doco/error-boundary";
import { Ga4Boot } from "@/components/doco/analytics/ga4-boot";
import { BOOT_SCRIPT } from "@/lib/compat/boot-script";
import { SITE, absoluteUrl } from "@/lib/seo/site";

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
 * P7-SEO: tool/category/hi pages override this via src/lib/seo/metadata.ts.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    template: "%s | DocoPDF",
  },
  description:
    "100 free online PDF tools: convert JPG to PDF, PDF to JPG, Word or Excel, merge, compress, edit, sign and OCR PDF files. No signup — files stay on your device. English + हिंदी",
  applicationName: "DocoPDF",
  /* No <meta name="keywords"> — Google/Bing ignore it (master-plan Phase 3);
   * researched keywords live in src/lib/seo/tool-seo.ts and feed on-page
   * copy + the keyword-map CSV deliverable instead. */
  icons: {
    icon: [{ url: "/logo.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
  openGraph: {
    type: "website",
    siteName: "DocoPDF",
    url: "/",
    title: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    description:
      "100 free online PDF tools. Convert, merge, compress, edit, sign and OCR PDF files — no signup, files stay on your device. English + हिंदी",
    locale: "en_US",
    alternateLocale: ["hi_IN"],
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "DocoPDF — 100 free online PDF tools, private and on-device",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@docopdf",
    title: "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF",
    description:
      "100 free online PDF tools. No signup — files stay on your device.",
    images: ["/og-image.png"],
  },
  alternates: {
    canonical: "/",
  },
  /* iOS: standalone home-screen app + no telephone autolinking of text. */
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "DocoPDF",
  },
  formatDetection: { telephone: false },
  /*
   * Webmaster verification (P7-SEO Phase 6) — read from env so the tokens
   * never live in git. Set in Vercel → Settings → Environment Variables:
   *   NEXT_PUBLIC_GSC_VERIFICATION   — Google Search Console content= value
   *   NEXT_PUBLIC_BING_VERIFICATION  — Bing Webmaster msvalidate.01
   *   NEXT_PUBLIC_YANDEX_VERIFICATION — Yandex Webmaster
   */
  verification: {
    google: process.env.NEXT_PUBLIC_GSC_VERIFICATION,
    other: {
      ...(process.env.NEXT_PUBLIC_BING_VERIFICATION && {
        "msvalidate.01": process.env.NEXT_PUBLIC_BING_VERIFICATION,
      }),
      ...(process.env.NEXT_PUBLIC_YANDEX_VERIFICATION && {
        "yandex-verification": process.env.NEXT_PUBLIC_YANDEX_VERIFICATION,
      }),
    },
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

/*
 * iOS Safari hardening (viewport):
 * viewport-fit=cover lets the layout paint into the notch / home-indicator
 * area; fixed bars compensate with safe-area padding (globals.css).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1220" },
  ],
};

const appJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "DocoPDF",
  url: absoluteUrl("/"),
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Any",
  inLanguage: ["en", "hi"],
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  description:
    "100 free online PDF tools — convert JPG to PDF, PDF to JPG, Word or Excel, merge, compress, edit, sign and OCR PDF files right in your browser. No signup; files stay on your device.",
  featureList: [
    "PDF converter (JPG, PNG, WEBP, HEIC, TIFF, SVG, Word, Excel, Markdown to PDF)",
    "PDF to JPG, Word, Excel, PNG, text and more",
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

/* P7-SEO: Organization + WebSite (SearchAction) — knowledge-panel and
 * sitelinks-searchbox eligibility. */
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "DocoPDF",
  url: absoluteUrl("/"),
  logo: absoluteUrl("/icon-512.png"),
  description:
    "DocoPDF builds free, privacy-first online PDF tools that run entirely in the browser — 100 tools in English and Hindi, with no signup and no uploads.",
  sameAs: ["https://github.com/DKUMARGUPTA/MyCloudy"],
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "DocoPDF",
  url: absoluteUrl("/"),
  inLanguage: ["en", "hi"],
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: absoluteUrl("/tools?q={search_term_string}"),
    },
    "query-input": "required name=search_term_string",
  },
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
        {/*
         * iOS/Safari compatibility boot script — MUST be the first thing in
         * <body> so polyfills exist before every app chunk parses. See
         * src/lib/compat/boot-script.ts (error capture, polyfills, watchdog).
         */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
        {/* GA4 boot — consent-gated gtag.js (property G-ZP89M3KQDB by default;
         * NEXT_PUBLIC_GA_ID env can override or "0"-disable). Zero network
         * until the visitor accepts analytics in the cookie banner. */}
        <Ga4Boot />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(appJsonLd),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(orgJsonLd),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(websiteJsonLd),
          }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <LocaleProvider>
            <AppErrorBoundary>{children}</AppErrorBoundary>
            <Toaster />
          </LocaleProvider>
        </ThemeProvider>
        <noscript>
          <div
            style={{
              padding: "24px",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
              textAlign: "center",
              color: "#0f172a",
            }}
          >
            <strong>DocoPDF needs JavaScript to run.</strong>
            <br />
            DocoPDF को चलाने के लिए JavaScript ज़रूरी है — your browser has it
            turned off (or blocked).
          </div>
        </noscript>
      </body>
    </html>
  );
}
