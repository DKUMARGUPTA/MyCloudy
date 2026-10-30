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

## Turso (planned production DB)

- Swap datasource provider to libSQL; table/column names already match
  (`05-DATA-RELATIONS.md`). Env: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
- All DB routes keep graceful degradation when DB env is absent.

## Vendored engines (self-hosted, /public)

pdf.js (+cmaps/standard_fonts) · qpdf WASM · Tesseract.js (+eng/hin
traineddata) · libheif · ICC sRGB — each with LICENSE/NOTICE in place;
CSP allows no external origins, so "vendored or nothing."
