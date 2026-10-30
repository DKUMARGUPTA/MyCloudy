import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { staticPageMetadata } from "@/lib/seo/metadata";
import { staticPageJsonLd } from "@/lib/seo/json-ld";

/** /contact — crawlable static content page (EN). */
export const metadata: Metadata = staticPageMetadata("contact", "en");

export default function StaticPage() {
  return (
    <>
      <JsonLd items={staticPageJsonLd("contact", "en")} />
      <AppShell initialRoute={{ view: "page", pageId: "contact" }} />
    </>
  );
}
