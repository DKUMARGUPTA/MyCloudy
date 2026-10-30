import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/doco/app-shell";
import { JsonLd } from "@/components/doco/json-ld";
import { CATEGORY_IDS, categoryMetadata } from "@/lib/seo/metadata";
import { categoryJsonLd } from "@/lib/seo/json-ld";

/** /tools/<category> — crawlable category landing pages (EN). */

export function generateStaticParams() {
  return CATEGORY_IDS.map((category) => ({ category }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  return categoryMetadata(category, "en") ?? {};
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!CATEGORY_IDS.includes(category)) notFound();
  return (
    <>
      <JsonLd items={categoryJsonLd(category, "en")} />
      <AppShell initialRoute={{ view: "tools", category }} />
    </>
  );
}
