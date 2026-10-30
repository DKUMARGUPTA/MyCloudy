"use client";

/**
 * GA4 boot (P7-SEO Phase 6) — mounts once in the root layout and starts the
 * consent-gated analytics layer. Renders nothing.
 *
 * Measurement ID G-ZP89M3KQDB is wired as the default (overridable via
 * NEXT_PUBLIC_GA_ID; set it to "0" to disable analytics in a build). Even
 * when enabled, nothing loads until the visitor grants consent — with
 * consent denied this remains a no-op (no script, no network).
 */

import { useEffect } from "react";

import { initGa4 } from "@/lib/analytics/ga4";

export function Ga4Boot() {
  useEffect(() => {
    void initGa4();
  }, []);

  return null;
}
