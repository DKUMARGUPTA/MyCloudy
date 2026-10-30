/**
 * Shared analytics constants (isomorphic — imported by BOTH the server
 * layout, which server-renders the Google tag, and the client GA4 module).
 * No side effects, safe in server components and prerendering.
 */

/**
 * localStorage key of the cookie-banner consent record
 * ({ analytics: boolean, savedAt: number }).
 *
 * SINGLE SOURCE OF TRUTH: cookie-banner.tsx writes it, the SSR'd GA boot
 * script in layout.tsx reads it during parse (to restore a returning
 * visitor's grant BEFORE gtag.js executes), and ga4.ts subscribes to it.
 * Rename it here and every consumer follows.
 */
export const CONSENT_KEY = "docopdf-consent";

/**
 * GA4 measurement ID — production property wired as the compile-time
 * default. A GA id is a public identifier (visible in the HTML of every
 * GA-enabled site), so it is safe in git.
 *
 * Env overrides (Vercel → Settings → Environment Variables):
 *   NEXT_PUBLIC_GA_ID = "G-OtherId"  → swap the property without a code edit
 *   NEXT_PUBLIC_GA_ID = "0"          → disable analytics entirely
 */
export const GA_MEASUREMENT_ID: string | undefined =
  process.env.NEXT_PUBLIC_GA_ID === undefined ||
  process.env.NEXT_PUBLIC_GA_ID === ""
    ? "G-ZP89M3KQDB"
    : process.env.NEXT_PUBLIC_GA_ID === "0"
      ? undefined
      : process.env.NEXT_PUBLIC_GA_ID;
