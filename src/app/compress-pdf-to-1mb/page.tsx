import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { landingMetadata } from "@/lib/seo/metadata";
import { landingJsonLd } from "@/lib/seo/json-ld";
import { getLanding } from "@/lib/seo/landing-pages";

/**
 * /compress-pdf-to-1mb — programmatic SEO landing (PHASE-4): unique title, description,
 * keywords, canonical + hreflang, FAQ + Breadcrumb JSON-LD. The body boots
 * the app shell straight into compress-pdf-to-size with the page's target
 * preset applied.
 */

export async function generateMetadata(): Promise<Metadata> {
  return landingMetadata("compress-pdf-to-1mb", "en") ?? {};
}

export default function Page() {
  const landing = getLanding("compress-pdf-to-1mb");
  if (!landing) notFound();
  return (
    <>
      <JsonLd items={landingJsonLd("compress-pdf-to-1mb", "en")} />
      <AppShell
        initialRoute={{
          view: "tool",
          toolId: "compress-pdf-to-size",
          toolPreset: landing.preset,
        }}
      />
    </>
  );
}
