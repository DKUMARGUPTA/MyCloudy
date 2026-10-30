/**
 * Next.js Metadata builders (P7-SEO) — one function per route family,
 * producing unique title / description / keywords / canonical / hreflang
 * alternates / Open Graph / Twitter cards for every crawlable URL.
 *
 * metadataBase (https://docopdf.com) lives in the root layout, so all
 * relative canonical + OG URLs resolve to the production domain.
 */

import type { Metadata } from "next";

import { SITE, hindiPath, type StaticPageId } from "@/lib/seo/site";
import { getCategorySeo, getToolSeo, STATIC_PAGE_SEO } from "@/lib/seo/tool-seo";
import { CATEGORIES } from "@/lib/tools/registry";

export type SeoLocale = "en" | "hi";

/** Prefix for Hindi-mirror paths ("" for en, "/hi" for hi). */
function localePrefix(locale: SeoLocale): string {
  return locale === "hi" ? "/hi" : "";
}

/**
 * Shared metadata skeleton: canonical (self, locale-aware), hreflang pair
 * (en + hi + x-default → en), OG + Twitter cards with the branded image.
 */
function baseMetadata(
  path: string,
  locale: SeoLocale,
  title: string,
  description: string,
  keywords: string[]
): Metadata {
  const selfPath = locale === "hi" ? hindiPath(path) : path;
  const ogLocale = locale === "hi" ? SITE.localeTags.hi : SITE.localeTags.en;
  return {
    title: { absolute: `${title}${SITE.titleSuffix}` },
    description,
    keywords,
    alternates: {
      canonical: selfPath,
      languages: {
        en: path,
        hi: hindiPath(path),
        "x-default": path,
      },
    },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      url: selfPath,
      title: `${title}${SITE.titleSuffix}`,
      description,
      locale: ogLocale,
      images: [{ url: SITE.ogImage, width: 1200, height: 630, alt: SITE.name }],
    },
    twitter: {
      card: "summary_large_image",
      site: SITE.twitterSite,
      title: `${title}${SITE.titleSuffix}`,
      description,
      images: [SITE.ogImage],
    },
  };
}

/* ---------------------------- tool page ---------------------------- */

export function toolMetadata(toolId: string, locale: SeoLocale = "en"): Metadata | undefined {
  const seo = getToolSeo(toolId);
  if (!seo) return undefined;
  const title = locale === "hi" ? seo.titleHi : seo.title;
  const description = locale === "hi" ? seo.descriptionHi : seo.description;
  const keywords = locale === "hi" ? seo.keywordsHi : seo.keywords;
  return baseMetadata(`/tool/${toolId}`, locale, title, description, keywords);
}

/* -------------------------- tools index ---------------------------- */

export function toolsIndexMetadata(locale: SeoLocale = "en"): Metadata {
  const title =
    locale === "hi"
      ? "सभी PDF टूल्स — 100 मुफ़्त ऑनलाइन टूल"
      : "All 100 PDF Tools — Free Online, No Signup";
  const description =
    locale === "hi"
      ? "DocoPDF के 100 मुफ़्त PDF टूल एक जगह — कन्वर्ट, मर्ज, कंप्रेस, एडिट, साइन, OCR। सब आपके डिवाइस पर, बिना साइनअप।"
      : "Browse all 100 free DocoPDF tools — converters, merger, compressor, editor, e-sign, OCR, redaction and more. On-device, no signup, no watermarks.";
  const keywords =
    locale === "hi"
      ? ["pdf tools hindi", "पीडीएफ़ टूल्स", "मुफ़्त pdf टूल"]
      : ["pdf tools", "free pdf tools online", "pdf converter", "pdf editor", "no signup pdf tools"];
  return baseMetadata("/tools", locale, title, description, keywords);
}

/* -------------------------- category page -------------------------- */

export function categoryMetadata(categoryId: string, locale: SeoLocale = "en"): Metadata | undefined {
  const seo = getCategorySeo(categoryId);
  if (!seo) return undefined;
  const title = locale === "hi" ? seo.titleHi : seo.title;
  const description = locale === "hi" ? seo.descriptionHi : seo.description;
  const keywords = locale === "hi" ? ["pdf टूल"] : seo.keywords;
  return baseMetadata(`/tools/${categoryId}`, locale, title, description, keywords);
}

/** Category ids that exist (for generateStaticParams + validation). */
export const CATEGORY_IDS: string[] = CATEGORIES.map((c) => c.id);

/* ------------------------- static pages ---------------------------- */

export function staticPageMetadata(pageId: StaticPageId, locale: SeoLocale = "en"): Metadata {
  const seo = STATIC_PAGE_SEO[pageId];
  const title = locale === "hi" ? seo.titleHi : seo.title;
  const description = locale === "hi" ? seo.descriptionHi : seo.description;
  return baseMetadata(`/${pageId}`, locale, title, description, []);
}
