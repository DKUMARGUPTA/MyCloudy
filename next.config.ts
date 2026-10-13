import type { NextConfig } from "next";

/**
 * DocoPDF next.config (PRD §14: strict CSP, no third-party origins).
 *
 * CSP notes:
 * - `script-src 'unsafe-inline'` is required because pages are statically
 *   generated (SSG) and next-themes injects a tiny pre-hydration script to
 *   avoid a dark-mode flash. Nonce-based CSP does not work with SSG.
 *   No third-party script origins are allowed.
 * - `'unsafe-eval'` is only added in development (React Refresh requires it).
 *   In production, `'wasm-unsafe-eval'` alone allows WebAssembly compilation
 *   (self-hosted libheif for HEIC decode, /libheif) without full eval.
 * - `worker-src 'self' blob:` + `img-src ... blob:` enable the Phase 2
 *   Web Worker pool and OPFS/blob thumbnails, all same-origin.
 * - `connect-src 'self'`: device-only tools make zero external requests.
 */

const isDev = process.env.NODE_ENV === "development";

const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // camera=(self) for the future Scan-to-PDF tool; everything else locked
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Next 16 removed the `eslint` config key — linting runs via
  // `bun run lint` (eslint) in CI instead.
  // Allow the sandbox preview proxy origin to reach the dev server.
  allowedDevOrigins: [
    "https://preview-chat-1f1cf917-1c49-4677-81af-7bc31d9a4be1.space-z.ai",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
