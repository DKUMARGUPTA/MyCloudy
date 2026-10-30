import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import {
  CATEGORY_IDS,
  categoryMetadata,
  staticPageMetadata,
  toolMetadata,
  toolsIndexMetadata,
} from "@/lib/seo/metadata";
import {
  categoryJsonLd,
  staticPageJsonLd,
  toolJsonLd,
  toolsIndexJsonLd,
} from "@/lib/seo/json-ld";
import { ALL_TOOLS } from "@/lib/tools/registry";
import { SITE, type StaticPageId } from "@/lib/seo/site";

/**
 * Hindi mirror routes (P7-SEO): "/hi", "/hi/tools", "/hi/tools/<cat>",
 * "/hi/tool/<id>", "/hi/<about|contact|privacy|terms>" — the same app
 * shell with Hindi SSR metadata + JSON-LD and a Hindi locale boot for
 * visitors without a stored preference. hreflang alternates on every EN
 * page point here, so Google can serve Hindi results directly.
 */

type PathInfo =
  | { kind: "home" }
  | { kind: "tools" }
  | { kind: "category"; category: string }
  | { kind: "tool"; id: string }
  | { kind: "page"; pageId: string };

function resolvePath(segments: string[] | undefined): PathInfo | null {
  if (!segments || segments.length === 0) return { kind: "home" };
  if (segments.length === 1) {
    if (segments[0] === "tools") return { kind: "tools" };
    if ((SITE.staticPages as readonly string[]).includes(segments[0])) {
      return { kind: "page", pageId: segments[0] };
    }
    return null;
  }
  if (segments[0] === "tools" && segments.length === 2 && CATEGORY_IDS.includes(segments[1])) {
    return { kind: "category", category: segments[1] };
  }
  if (
    segments[0] === "tool" &&
    segments.length === 2 &&
    ALL_TOOLS.some((t) => t.id === segments[1] && t.enabled)
  ) {
    return { kind: "tool", id: segments[1] };
  }
  return null;
}

const ENABLED_TOOL_IDS = ALL_TOOLS.filter((t) => t.enabled).map((t) => t.id);

export function generateStaticParams() {
  return [
    { path: [] },
    { path: ["tools"] },
    ...CATEGORY_IDS.map((category) => ({ path: ["tools", category] })),
    ...ENABLED_TOOL_IDS.map((id) => ({ path: ["tool", id] })),
    ...SITE.staticPages.map((pageId) => ({ path: [pageId] })),
  ];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}): Promise<Metadata> {
  const { path } = await params;
  const info = resolvePath(path);
  switch (info?.kind) {
    case "home": {
      const meta = toolsIndexMetadata("hi");
      return {
        ...meta,
        title: {
          absolute: `मुफ़्त PDF टूल्स — कन्वर्टर, एडिटर, मर्जर और भारी सारे टूल${SITE.titleSuffix}`,
        },
        description:
          "DocoPDF — 100 मुफ़्त ऑनलाइन PDF टूल: फोटो से PDF, PDF से Word, मर्ज, कंप्रेस, एडिट, साइन और OCR। बिना साइनअप — फ़ाइलें आपके डिवाइस पर ही रहती हैं। अंग्रेज़ी + हिंदी",
        alternates: { canonical: "/hi", languages: { en: "/", hi: "/hi", "x-default": "/" } },
        openGraph: { ...meta.openGraph, url: "/hi" },
      };
    }
    case "tools":
      return toolsIndexMetadata("hi");
    case "category":
      return categoryMetadata(info.category, "hi") ?? {};
    case "tool":
      return toolMetadata(info.id, "hi") ?? {};
    case "page":
      return staticPageMetadata(info.pageId as StaticPageId, "hi");
    default:
      return {};
  }
}

export default async function HindiPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  const info = resolvePath(path);
  if (!info) notFound();

  switch (info.kind) {
    case "home":
      return (
        <>
          <JsonLd items={[toolsIndexJsonLd("hi")]} />
          <AppShell initialRoute={{ view: "home" }} initialLocale="hi" />
        </>
      );
    case "tools":
      return (
        <>
          <JsonLd items={[toolsIndexJsonLd("hi")]} />
          <AppShell initialRoute={{ view: "tools" }} initialLocale="hi" />
        </>
      );
    case "category":
      return (
        <>
          <JsonLd items={categoryJsonLd(info.category, "hi")} />
          <AppShell initialRoute={{ view: "tools", category: info.category }} initialLocale="hi" />
        </>
      );
    case "tool":
      return (
        <>
          <JsonLd items={toolJsonLd(info.id, "hi")} />
          <AppShell initialRoute={{ view: "tool", toolId: info.id }} initialLocale="hi" />
        </>
      );
    case "page":
      return (
        <>
          <JsonLd items={staticPageJsonLd(info.pageId, "hi")} />
          <AppShell initialRoute={{ view: "page", pageId: info.pageId }} initialLocale="hi" />
        </>
      );
  }
}
