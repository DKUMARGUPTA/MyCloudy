/**
 * JSON-LD script renderer (P7-SEO) — server component that injects
 * schema.org payloads into the page <body>. Data is JSON.stringify'd and
 * "<"-escaped by the builders (json-ld.ts), keeping payloads inert.
 */

import type { Json } from "@/lib/seo/json-ld";

export function JsonLd({ items }: { items: Json[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((item, index) => (
        <script
          key={`jsonld-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(item).replace(/</g, "\\u003c"),
          }}
        />
      ))}
    </>
  );
}
