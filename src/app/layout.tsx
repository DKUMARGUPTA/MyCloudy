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

export const metadata: Metadata = {
  metadataBase: new URL("https://docopdf.com"),
  title: {
    default: "DocoPDF — Every PDF tool, one place. Free, fast and private.",
    template: "%s · DocoPDF",
  },
  description:
    "Free, fast and private PDF tools. Most tools run right in your browser — your files stay on your device. English + हिंदी.",
  applicationName: "DocoPDF",
  keywords: [
    "PDF tools",
    "merge PDF",
    "split PDF",
    "compress PDF",
    "sign PDF",
    "PDF converter",
    "DocoPDF",
  ],
  icons: {
    icon: [{ url: "/logo.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    siteName: "DocoPDF",
    title: "DocoPDF — Every PDF tool, one place",
    description:
      "Free, fast and private PDF tools. Most tools run right in your browser.",
  },
  robots: {
    index: true,
    follow: true,
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
