import type { MetadataRoute } from "next";

import { absoluteUrl, hindiPath } from "@/lib/seo/site";
import { ALL_TOOLS, CATEGORIES } from "@/lib/tools/registry";

/**
 * Dynamic sitemap (P7-SEO) — generated from the tool registry, so every
 * new tool is listed automatically on the next deploy. Hindi mirrors are
 * wired through xhtml:link alternates (en + hi + x-default → en), which
 * Google pairs with the per-page hreflang <link>s.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  const entry = (
    path: string,
    priority: number,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] = "weekly"
  ): MetadataRoute.Sitemap[number] => ({
    url: absoluteUrl(path),
    lastModified,
    changeFrequency,
    priority,
    alternates: {
      languages: {
        en: absoluteUrl(path),
        hi: absoluteUrl(hindiPath(path)),
        "x-default": absoluteUrl(path),
      },
    },
  });

  return [
    entry("/", 1.0),
    entry("/tools", 0.9),
    ...CATEGORIES.map((c) => entry(`/tools/${c.id}`, 0.8)),
    ...ALL_TOOLS.filter((t) => t.enabled).map((t) =>
      entry(`/tool/${t.id}`, t.popularity >= 40 ? 0.8 : 0.7)
    ),
    entry("/about", 0.4, "monthly"),
    entry("/contact", 0.4, "monthly"),
    entry("/privacy", 0.3, "yearly"),
    entry("/terms", 0.3, "yearly"),
  ];
}
