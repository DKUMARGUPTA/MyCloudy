"use client";

/**
 * GA4 boot (P7-SEO Phase 6) — mounts once in the root layout and starts the
 * consent-gated analytics layer. Renders nothing.
 *
 * With NEXT_PUBLIC_GA_ID unset this is a complete no-op (no dataLayer, no
 * script, zero network) — safe on every environment.
 */

import { useEffect } from "react";

import { initGa4 } from "@/lib/analytics/ga4";

export function Ga4Boot() {
  useEffect(() => {
    void initGa4();
  }, []);

  return null;
}
