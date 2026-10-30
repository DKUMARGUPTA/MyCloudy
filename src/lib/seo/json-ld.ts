/**
 * JSON-LD structured-data builders (P7-SEO) — server-rendered schema.org
 * markup for every crawlable route. Google reads these for rich results:
 *
 *  - Tool pages:    SoftwareApplication (free offer, features) + FAQPage
 *                   (from the tool's config.faq) + BreadcrumbList
 *                   (Home › Category › Tool).
 *  - Tools index:   CollectionPage + ItemList of the categories.
 *  - Category:      CollectionPage with the category's tool list.
 *
 * Honest-data rule: no fake aggregateRating / reviewCount (guideline
 * violation), no invented authorship — only facts the app really has.
 */

import { absoluteUrl } from "@/lib/seo/site";
import type { SeoLocale } from "@/lib/seo/metadata";
import { getToolSeo, getCategorySeo } from "@/lib/seo/tool-seo";
import { ALL_TOOLS, CATEGORIES } from "@/lib/tools/registry";
import { getToolConfig } from "@/lib/tools/configs";

export type Json = Record<string, unknown>;

const SCHEMA = "https://schema.org";

function pick(l10n: { en: string; hi: string }, locale: SeoLocale): string {
  return locale === "hi" ? l10n.hi : l10n.en;
}

/* ----------------------------- tool page ----------------------------- */

export function toolJsonLd(toolId: string, locale: SeoLocale = "en"): Json[] {
  const tool = ALL_TOOLS.find((t) => t.id === toolId && t.enabled);
  const seo = getToolSeo(toolId);
  if (!tool || !seo) return [];

  const url = absoluteUrl(locale === "hi" ? `/hi/tool/${toolId}` : `/tool/${toolId}`);
  const category = CATEGORIES.find((c) => c.id === tool.category);
  const config = getToolConfig(toolId);
  const description = locale === "hi" ? seo.descriptionHi : seo.description;
  const name = pick(tool.name, locale);

  const app: Json = {
    "@context": SCHEMA,
    "@type": "SoftwareApplication",
    name,
    url,
    description,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any (web browser)",
    browserRequirements: "Requires JavaScript",
    inLanguage: locale === "hi" ? "hi" : "en",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "DocoPDF", url: absoluteUrl("/") },
  };
  if (config?.features?.length) {
    app.featureList = config.features.map((f) => pick(f, locale));
  }

  const breadcrumb: Json = {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: locale === "hi" ? "होम" : "Home",
        item: absoluteUrl(locale === "hi" ? "/hi" : "/"),
      },
      ...(category
        ? [
            {
              "@type": "ListItem",
              position: 2,
              name: pick(category.name, locale),
              item: absoluteUrl(
                locale === "hi" ? `/hi/tools/${category.id}` : `/tools/${category.id}`
              ),
            },
          ]
        : []),
      { "@type": "ListItem", position: category ? 3 : 2, name, item: url },
    ],
  };

  const schema: Json[] = [app, breadcrumb];

  if (config?.faq?.length) {
    schema.push({
      "@context": SCHEMA,
      "@type": "FAQPage",
      mainEntity: config.faq.map((item) => ({
        "@type": "Question",
        name: pick(item.q, locale),
        acceptedAnswer: { "@type": "Answer", text: pick(item.a, locale) },
      })),
    });
  }

  return schema;
}

/* --------------------------- tools index ---------------------------- */

export function toolsIndexJsonLd(locale: SeoLocale = "en"): Json {
  const prefix = locale === "hi" ? "/hi" : "";
  return {
    "@context": SCHEMA,
    "@type": "CollectionPage",
    name: locale === "hi" ? "सभी PDF टूल्स" : "All PDF Tools",
    url: absoluteUrl(`${prefix}/tools`),
    inLanguage: locale === "hi" ? "hi" : "en",
    isPartOf: { "@type": "WebSite", name: "DocoPDF", url: absoluteUrl("/") },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: CATEGORIES.length,
      itemListElement: CATEGORIES.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: pick(c.name, locale),
        url: absoluteUrl(`${prefix}/tools/${c.id}`),
      })),
    },
  };
}

/* -------------------------- category page --------------------------- */

export function categoryJsonLd(categoryId: string, locale: SeoLocale = "en"): Json[] {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const seo = getCategorySeo(categoryId);
  if (!category || !seo) return [];

  const prefix = locale === "hi" ? "/hi" : "";
  const tools = ALL_TOOLS.filter((t) => t.category === categoryId && t.enabled);

  return [
    {
      "@context": SCHEMA,
      "@type": "CollectionPage",
      name: pick(category.name, locale),
      description: locale === "hi" ? seo.descriptionHi : seo.description,
      url: absoluteUrl(`${prefix}/tools/${categoryId}`),
      inLanguage: locale === "hi" ? "hi" : "en",
      isPartOf: { "@type": "WebSite", name: "DocoPDF", url: absoluteUrl("/") },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: tools.length,
        itemListElement: tools.map((t, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: pick(t.name, locale),
          url: absoluteUrl(`${prefix}/tool/${t.id}`),
        })),
      },
    },
  ];
}

/* ------------------------- static content --------------------------- */

export function staticPageJsonLd(pageId: string, locale: SeoLocale = "en"): Json[] {
  const prefix = locale === "hi" ? "/hi" : "";
  const isAbout = pageId === "about";
  return [
    {
      "@context": SCHEMA,
      "@type": isAbout ? "AboutPage" : "WebPage",
      name: pageId,
      url: absoluteUrl(`${prefix}/${pageId}`),
      inLanguage: locale === "hi" ? "hi" : "en",
      isPartOf: { "@type": "WebSite", name: "DocoPDF", url: absoluteUrl("/") },
    },
  ];
}

/* --------------------- server <script> serializer ------------------- */

/**
 * Render JSON-LD objects as React-ready script payloads.
 * (Server components pass these to a tiny JsonLd component.)
 */
export function jsonLdScripts(items: Json[]): { key: string; html: string }[] {
  return items.map((item, i) => ({
    key: `jsonld-${i}`,
    html: JSON.stringify(item).replace(/</g, "\\u003c"),
  }));
}
