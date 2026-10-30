"use client";

/**
 * GA4 boot (P7-SEO) — mounts once in the root layout and starts the dynamic
 * half of the analytics layer (consent-store wiring + event buffering; see
 * src/lib/analytics/ga4.ts). The Google tag itself is SERVER-RENDERED in
 * layout.tsx (standard Consent Mode v2 placement). Renders nothing.
 *
 * With the measurement id unset (NEXT_PUBLIC_GA_ID=0) this is a complete
 * no-op — and even when enabled, nothing is measured until the visitor
 * grants consent (cookieless tag, denied by default).
 */

import { useEffect } from "react";

import { initGa4 } from "@/lib/analytics/ga4";

export function Ga4Boot() {
  useEffect(() => {
    void initGa4();
  }, []);

  return null;
}
