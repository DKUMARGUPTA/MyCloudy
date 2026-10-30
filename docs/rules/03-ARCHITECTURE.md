# 03 · Architecture Rules

Next.js 16 App Router + TypeScript strict. One sandbox port (3000) exposed
through a Caddy gateway; heavy server jobs in two mini-services.

## Layers

```
Browser (user device)
 ├─ App shell: Next.js SSG pages (/, /tool/<id>, /tools, /hi/*, statics)
 ├─ ToolShell: config-driven UI per tool (tools/<id>/surface.tsx)
 ├─ Workers: ALL heavy file processing (tools/<id>/worker.ts)
 └─ Engines: own PDF engine (src/lib/pdf, src/lib/own) + pdf.js + qpdf WASM
              + Tesseract.js + libheif — all vendored under /public
        │
        ▼  (only for server-dependent features)
Caddy :81 gateway
 ├─ default → localhost:3000 (Next.js; API routes under /api/*)
 ├─ ?XTransformPort=3031 → mini-services/convert  (HARD allow-list)
 └─ ?XTransformPort=3032 → mini-services/request-sign (HARD allow-list)
        │
        ▼
Prisma + SQLite (metadata only; production plan = Turso/libSQL)
```

## Processing modes (PRD-critical)

- **Mode D (device-only, default):** file never leaves the browser. Web
  Workers only; zero network calls with file data; `connect-src 'self'`.
- **Mode S (server):** only for jobs browsers can't do (webpage→PDF via
  headless Chrome in `mini-services/convert`, page fetch in
  `/api/fetch-page`). Every Mode-S surface must state it in the UI and
  carry the same SSRF/size/rate defenses (`06-API-RULES.md`).

## Own PDF engine (P6)

All 60 tool families run on the **in-house engine** (`src/lib/own`, parser,
writer `rewriteDocument`, CreateContext/StampContext, Indic shaper, crypto
`secprims/security`). pdf-lib is a **devDependency only** (smoke oracles).
Rules: new PDF features extend the own engine — never re-import pdf-lib at
runtime; oracle-verify against `@cantoo/pdf-lib` in smokes.

## Mini-services (sandbox only)

| Service | Port | Job | Defenses |
|---------|------|-----|----------|
| convert | 3031 | office↔pdf, webpage2pdf (headless Chrome) | SSRF guard (DNS resolve + private/loopback refusal + `--host-resolver-rules` pinning), 30MB cap, per-IP 40/10min, concurrency 4, 64KB child-output cap, generic 500s |
| request-sign | 3032 | signature envelopes | per-IP 10 create/h + 30 sign/h, envelope disk cap, O_EXCL double-sign lock, write-then-rename atomicity |

Started ONLY via `python3 scripts/mini-daemon.py <name>` (plain nohup gets
reaped). Health: `/health` → `{"ok":true}`.

## Router reality

- Real-path routes exist for SEO: `/tool/<id>` (100), `/tools` +
  9 category pages, 4 static pages, `/hi/[[...path]]` Hindi mirrors.
- In-app navigation is hash-based (`#/...`) on top of the shell —
  `src/lib/tools/router.ts` + `src/lib/anchor.ts` keep both worlds honest.
  New pages must register in the router + sitemap (`src/app/sitemap.ts`).

## State & data

- Client state: Zustand stores (per-tool state files, e.g.
  `tools/*/unlock-state.ts`); server state: fetch + minimal caching.
- DB access only via `src/lib/db.ts` (`import { db } from "@/lib/db"`).
- In-memory rate limiting (`src/lib/rate-limit.ts`) is per-instance —
  swap for edge/Redis only if we ever scale out.
