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

/**
 * Inline, blocking, pre-hydration: set <html lang="hi"> as soon as the HTML
 * parses (Google's renderer + assistive tech see the correct document
 * language before React commits; <html suppressHydrationWarning> in the root
 * layout keeps the attribute flip mismatch-silent — the same contract
 * next-themes relies on for the class attribute).
 */
const HINDI_LANG_SCRIPT = "document.documentElement.lang='hi'";

/*
 * Home-only FAQPage JSON-LD, Hindi mirror (R19 Phase 5 — the EN home in
 * src/app/page.tsx carried the only FAQ schema; /hi had none, so Hindi
 * rich results had nothing to read). Mirrors the six questions of the
 * home FAQ section (src/components/doco/home/faq.tsx renders the "faq.*"
 * keys of src/i18n/hi.json) — keep all three in sync when editing copy.
 */
const faqJsonLdHi = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  inLanguage: "hi",
  mainEntity: [
    {
      "@type": "Question",
      name: "क्या DocoPDF सच में फ़्री है?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "हाँ। हर टूल फ़्री है — कोई साइनअप नहीं, कोई वॉटरमार्क नहीं, कोई डेली लिमिट नहीं। ज़्यादातर टूल्स पूरे ब्राउज़र में ही चलते हैं, इसलिए तेज़ भी हैं — आपकी फ़ाइलें आपके ही डिवाइस पर प्रोसेस होती हैं, किसी दूर के सर्वर पर नहीं।",
      },
    },
    {
      "@type": "Question",
      name: "JPG को PDF में मुफ़्त कैसे बदलें?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "JPG to PDF टूल खोलिए, फ़ोटो ड्रॉप कर दीजिए (JPG, PNG, WEBP, HEIC और TIFF सब चलते हैं), क्रम बदल लीजिए और Create PDF दबा दीजिए। दस्तावेज़ आपके डिवाइस पर ही बनता है — कुछ भी अपलोड नहीं होता।",
      },
    },
    {
      "@type": "Question",
      name: "PDF को Word या टेक्स्ट में कैसे बदलें?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "टेक्स्ट के लिए PDF to Text इस्तेमाल करें — यह सब कुछ आपके डिवाइस पर निकालता है और स्कैन किए पेज भी OCR से पढ़ लेता है (अंग्रेज़ी या हिंदी)। फ़ॉर्मैटिंग बचाने वाला पूरा PDF to Word कन्वर्टर हमारी रोडमैप पर है।",
      },
    },
    {
      "@type": "Question",
      name: "क्या मेरी PDF फ़ाइलें किसी सर्वर पर अपलोड होती हैं?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "नहीं। लगभग हर टूल आपके ब्राउज़र में, आपके डिवाइस पर ही चलता है — फ़ाइलें आपके कंप्यूटर या फ़ोन से बाहर नहीं जातीं, और साइट एक बार लोड होने के बाद ज़्यादातर टूल्स ऑफ़लाइन भी चलते रहते हैं।",
      },
    },
    {
      "@type": "Question",
      name: "Adobe Acrobat के बिना PDF एडिट कर सकते हैं?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "हाँ। Edit PDF आपको वर्ड जैसा एडिटर देता है — मौजूदा टेक्स्ट पर क्लिक करके बदलें, तस्वीरें, आकृतियाँ और सिग्नेचर जोड़ें, हाइलाइट और एनोटेट करें — मुफ़्त और आपके डिवाइस पर। Annotate PDF और Write PDF भी साथ हैं।",
      },
    },
    {
      "@type": "Question",
      name: "क्या DocoPDF हिंदी में काम करता है?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "हाँ! पूरा इंटरफ़ेस हिंदी में है — देवनागरी में PDF लिखें, हिंदी फ़ॉर्म भरें और स्कैन किए दस्तावेज़ों का हिंदी OCR करें, पूरी तरह सर्च करने लायक आउटपुट के साथ।",
      },
    },
  ],
};

export default async function HindiPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  const info = resolvePath(path);
  if (!info) notFound();

  let content: React.ReactNode;
  switch (info.kind) {
    case "home":
      content = (
        <>
          <JsonLd items={[toolsIndexJsonLd("hi"), faqJsonLdHi]} />
          <AppShell initialRoute={{ view: "home" }} initialLocale="hi" />
        </>
      );
      break;
    case "tools":
      content = (
        <>
          <JsonLd items={[toolsIndexJsonLd("hi")]} />
          <AppShell initialRoute={{ view: "tools" }} initialLocale="hi" />
        </>
      );
      break;
    case "category":
      content = (
        <>
          <JsonLd items={categoryJsonLd(info.category, "hi")} />
          <AppShell initialRoute={{ view: "tools", category: info.category }} initialLocale="hi" />
        </>
      );
      break;
    case "tool":
      content = (
        <>
          <JsonLd items={toolJsonLd(info.id, "hi")} />
          <AppShell initialRoute={{ view: "tool", toolId: info.id }} initialLocale="hi" />
        </>
      );
      break;
    case "page":
      content = (
        <>
          <JsonLd items={staticPageJsonLd(info.pageId, "hi")} />
          <AppShell initialRoute={{ view: "page", pageId: info.pageId }} initialLocale="hi" />
        </>
      );
      break;
  }

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: HINDI_LANG_SCRIPT }} />
      {content}
    </>
  );
}
