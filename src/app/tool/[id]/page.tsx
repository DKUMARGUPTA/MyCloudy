import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { toolMetadata } from "@/lib/seo/metadata";
import { toolJsonLd } from "@/lib/seo/json-ld";
import { ALL_TOOLS } from "@/lib/tools/registry";

/**
 * /tool/<id> — crawlable tool landing pages (EN): unique SSR title,
 * description, keywords, canonical + hreflang alternates, Open Graph /
 * Twitter card, and SoftwareApplication + FAQPage + BreadcrumbList
 * JSON-LD. The body boots the shared app shell directly into the tool
 * workspace (no redirect; the hash router takes over on navigation).
 */

const ENABLED_TOOL_IDS = ALL_TOOLS.filter((t) => t.enabled).map((t) => t.id);

export function generateStaticParams() {
  return ENABLED_TOOL_IDS.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return toolMetadata(id, "en") ?? {};
}

export default async function ToolPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ENABLED_TOOL_IDS.includes(id)) notFound();
  return (
    <>
      <JsonLd items={toolJsonLd(id, "en")} />
      <AppShell initialRoute={{ view: "tool", toolId: id }} />
    </>
  );
}
