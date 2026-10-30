import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { staticPageMetadata } from "@/lib/seo/metadata";
import { staticPageJsonLd } from "@/lib/seo/json-ld";

/** /about — crawlable static content page (EN). */
export const metadata: Metadata = staticPageMetadata("about", "en");

export default function StaticPage() {
  return (
    <>
      <JsonLd items={staticPageJsonLd("about", "en")} />
      <AppShell initialRoute={{ view: "page", pageId: "about" }} />
    </>
  );
}
