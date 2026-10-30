import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { toolsIndexMetadata } from "@/lib/seo/metadata";
import { toolsIndexJsonLd } from "@/lib/seo/json-ld";

/** /tools — crawlable all-tools index (EN). */
export const metadata: Metadata = toolsIndexMetadata("en");

export default function ToolsPage() {
  return (
    <>
      <JsonLd items={[toolsIndexJsonLd("en")]} />
      <AppShell initialRoute={{ view: "tools" }} />
    </>
  );
}
