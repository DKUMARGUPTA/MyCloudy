# 13 · Integrations

External systems, their rituals, and their hard limits.

## GitHub (`DKUMARGUPTA/MyCloudy`)

- Push ritual after EVERY batch: `source /home/z/.tokens/docopdf.env` →
  `MYCLOUDY_GH_TOKEN=$GITHUB_TOKEN VERCEL_TOKEN=$VERCEL_TOKEN bash scripts/push-github.sh`.
- Script leak-scans tracked files for token values before pushing; refuses
  on hit. Do not bypass.
- Fine-grained PAT, Contents: read+write, repo-scoped. Tokens rotate via
  owner; storage `/home/z/.tokens/docopdf.env` (mode 600) + backup
  `.ops/token-backup.env`. NEVER print/commit tokens.
- Sandbox disk is ephemeral (one rollback already destroyed work) —
  **pushed = durable**; tags `checkpoint-100-tools`, `v1.0.0-rc.1`.

## Vercel (hosting, auto-deploy on push)

- Prod: https://www.docopdf.com (domain attached) · beta:
  `https://mycloudy-beta.vercel.app`. `mycloudy.vercel.app` = OLD account
  (user's Nuxt app) — do not touch.
- `output: "standalone"`; build runs `tsc` over `scripts/**` too — dev-tree
  ghost imports break prod builds; committed tree MUST typecheck clean.
- Verify deploys via `bash scripts/ops/status.sh` (quota, deploys, disk,
  git hygiene) or Vercel dashboard READY state.

## Caddy gateway (sandbox)

- One external port; internal routing by `?XTransformPort=` query ONLY.
- **Hard allow-list {3031 convert, 3032 request-sign}**; any other port →
  403 (repo `Caddyfile` is source of truth; runtime `/app/Caddyfile` is
  root-managed — service-level hardening assumes the gateway can leak).
- Client code: relative URLs only; `io("/?XTransformPort=3030-style")`
  pattern for sockets (see `examples/websocket/`).

## GA4 + Search Console

- GA4 measurement wired in `src/lib/analytics/` + layout (standard install,
  no-tag-found fix landed R19 R4); taxonomy doc lives in worklog R19-Phase5.
- Sitemap: `src/app/sitemap.ts` (116 URLs, hreflang). Owner actions
  (GSC submit, Bing IndexNow) documented in `docs/seo/WEBMASTER-GUIDE.md`.

## AI provider (production) — the R21 contract

The three AI tools (chat / summarize / translate) run through
`src/lib/ai/zai-client.ts`, NOT the SDK import:

- **Sandbox**: falls back to `/etc/.z-ai-config` (internal endpoint, private
  IPs — unreachable outside the sandbox network).
- **Production (Vercel)**: set env vars → any OpenAI-compatible provider
  works (z.ai public API, OpenAI, Groq, OpenRouter, …):
  - `AI_BASE_URL` (e.g. `https://api.z.ai/api/paas/v4` or `https://api.openai.com/v1`) — required
  - `AI_API_KEY` — required
  - `AI_MODEL` — required by public providers (e.g. `glm-4.6`, `gpt-4o-mini`)
  - optional: `AI_TOKEN`, `AI_CHAT_ID`, `AI_USER_ID` (gateway-style headers)
- Neither env nor file → routes answer `aiNotConfigured` 503 with an
  honest localized "not enabled on the server" toast (never a fake
  network error). Public-provider mode omits the `thinking` body field
  (unknown-field rejection).
- The adapter accepts an AbortSignal — route deadlines CANCEL the
  in-flight fetch (R19 P3 "SDK abort" closed).

## Turso (LIVE production DB — R46, 2026-10-31)

- **Wired:** `src/lib/db.ts` branches on `TURSO_DATABASE_URL`
  (`libsql://…`) → Prisma + `@prisma/adapter-libsql` driver adapter
  (schema `previewFeatures = ["driverAdapters"]`). Sandbox keeps plain
  SQLite via `DATABASE_URL=file:…` — `prisma db push` unaffected.
- Env (Vercel, encrypted, production+preview): `TURSO_DATABASE_URL`,
  `TURSO_AUTH_TOKEN`, plus `AUTH_SECRET` (required in prod since R46 —
  JWT signing throws without it).
- DB: `docopdf-deepakkumar` @ aws-ap-south-1 (Mumbai). Table/column
  names match `05-DATA-RELATIONS.md` (`@@map`, snake_case) — no renames.
- Schema apply (no remote `prisma db push` with adapters):
  `bunx prisma migrate diff --from-empty --to-schema-datamodel
  prisma/schema.prisma --script --output /tmp/turso-init.sql` →
  `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/turso-init.ts`
  (idempotent — skips DDL when core tables exist).
- Admin bootstrap: no seed needed — signup auto-claims `role=admin` for
  `ADMIN_EMAILS` (src/lib/auth.ts). Sessions are stateless JWTs.
- All DB routes keep graceful degradation when DB env is absent.

## Vendored engines (self-hosted, /public)

pdf.js (+cmaps/standard_fonts) · qpdf WASM · Tesseract.js (+eng/hin
traineddata) · libheif · ICC sRGB — each with LICENSE/NOTICE in place;
CSP allows no external origins, so "vendored or nothing."
