import { absoluteUrl, hindiPath } from "@/lib/seo/site";
import { ALL_TOOLS, CATEGORIES } from "@/lib/tools/registry";

import { buildSitemapHtml, type HtmlSitemapEntry } from "./html";

/**
 * Custom /sitemap.xml route (R18-SITEMAP-UX).
 *
 * Replaces the previous `app/sitemap.ts` metadata route. Chrome 156 removed
 * XSLTProcessor AND the built-in XML tree view, so a raw sitemap opened in
 * a browser renders as an unstyled wall of text. This route therefore
 * content-negotiates who gets what:
 *
 *   - Crawlers, CLI tools, validators, anything sending a wildcard Accept
 *     header (Googlebot, Bingbot, curl, wget, GSC, python-requests …) → the
 *     exact same valid sitemaps.org 0.9 XML as before (hreflang en/hi/
 *     x-default alternates preserved 1:1, registry-driven, pretty-printed,
 *     day precision lastmod).
 *   - Human browsers (UA has no bot tokens AND Accept prefers text/html
 *     over application/xml — every real browser does) → a branded,
 *     searchable, dark-mode-aware HTML page built from the same data.
 *   - `?raw=1` → force raw XML for humans who want it.
 *
 * Caching is deliberately browser-only (no s-maxage → no shared/edge cache)
 * plus `Vary: Accept, User-Agent`, so a cached HTML variant can never leak
 * to a crawler. The handler is trivial compute, so per-request execution
 * on Vercel is negligible.
 */

export const dynamic = "force-dynamic";

type Freq = "weekly" | "monthly" | "yearly";

interface SitemapEntry {
  path: string;
  priority: number;
  freq: Freq;
}

function buildEntries(): SitemapEntry[] {
  return [
    { path: "/", priority: 1.0, freq: "weekly" },
    { path: "/tools", priority: 0.9, freq: "weekly" },
    ...CATEGORIES.map((c) => ({
      path: `/tools/${c.id}`,
      priority: 0.8,
      freq: "weekly" as Freq,
    })),
    ...ALL_TOOLS.filter((t) => t.enabled).map((t) => ({
      path: `/tool/${t.id}`,
      priority: t.popularity >= 40 ? 0.8 : 0.7,
      freq: "weekly" as Freq,
    })),
    { path: "/about", priority: 0.4, freq: "monthly" },
    { path: "/contact", priority: 0.4, freq: "monthly" },
    { path: "/privacy", priority: 0.3, freq: "yearly" },
    { path: "/terms", priority: 0.3, freq: "yearly" },
  ];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Known crawler/tool user agents — always served raw XML. */
const BOT_UA =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|mediapartners|linkedinbot|semrush|ahrefs|mj12|dotbot|petalbot|yandex|baidu|sogou|exabot|wget|curl|python|okhttp|axios|node-fetch|scrapy|lighthouse|pagespeed|validator|xmllint/i;

/** q-value of a media type in an Accept header (0 when absent). */
function acceptQuality(accept: string, mediaType: string): number {
  for (const part of accept.split(",")) {
    const segments = part.trim().split(";");
    const media = segments[0]?.trim().toLowerCase();
    if (media !== mediaType) continue;
    let q = 1;
    for (const param of segments.slice(1)) {
      const [key, value] = param.trim().split("=");
      if (key?.toLowerCase() === "q") {
        const parsed = Number.parseFloat(value ?? "1");
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    return q;
  }
  return 0;
}

/** True when the client clearly prefers HTML over any XML type. */
function prefersHtml(accept: string | null): boolean {
  if (!accept) return false;
  const html = acceptQuality(accept, "text/html");
  if (html <= 0) return false;
  const appXml = acceptQuality(accept, "application/xml");
  const xhtml = acceptQuality(accept, "application/xhtml+xml");
  const any = acceptQuality(accept, "*/*");
  return html >= Math.max(appXml, xhtml, any);
}

function buildXml(entries: SitemapEntry[]): string {
  // Day precision — matches what Google documents first (YYYY-MM-DD).
  const lastmod = new Date().toISOString().slice(0, 10);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];

  for (const entry of entries) {
    const loc = xmlEscape(absoluteUrl(entry.path));
    const hi = xmlEscape(absoluteUrl(hindiPath(entry.path)));
    lines.push(
      "  <url>",
      `    <loc>${loc}</loc>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${loc}" />`,
      `    <xhtml:link rel="alternate" hreflang="hi" href="${hi}" />`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${loc}" />`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <changefreq>${entry.freq}</changefreq>`,
      `    <priority>${entry.priority.toFixed(1)}</priority>`,
      "  </url>",
    );
  }

  lines.push("</urlset>");
  return `${lines.join("\n")}\n`;
}

const VARY = "Accept, User-Agent";

export function GET(request: Request): Response {
  const entries = buildEntries();

  const forceRaw =
    new URL(request.url).searchParams.get("raw") === "1";
  const userAgent = request.headers.get("user-agent") ?? "";
  const accept = request.headers.get("accept");
  const isBot = BOT_UA.test(userAgent);
  const wantsHtml = !forceRaw && !isBot && prefersHtml(accept);

  if (wantsHtml) {
    return new Response(buildSitemapHtml(entries satisfies HtmlSitemapEntry[], new Date()), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        Vary: VARY,
        "X-Robots-Tag": "noindex",
      },
    });
  }

  return new Response(buildXml(entries), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Vary: VARY,
    },
  });
}
