# 04 · Folder Structure Rules

Where things go. If you invent a new top-level folder without updating this
doc, the round is invalid.

## Map

```
src/app/               Next.js App Router
  page.tsx             app shell (only user-visible "/" in sandbox; SEO routes alongside)
  tool/[id]/           per-tool SEO pages (registry-driven, ×100)
  tools/[category]/    9 category pages
  hi/[[...path]]/      Hindi mirrors (SSR meta + locale boot)
  about|contact|privacy|terms/
  api/                 route handlers (see 06-API-RULES.md)
  sitemap.ts robots.ts not-found.tsx
src/components/ui/     shadcn/ui primitives (DO NOT hand-roll these)
src/components/doco/   DocoPDF wrappers (SiteHeader, SiteFooter, …)
src/i18n/              en.json + hi.json + translate()  (parity enforced)
src/lib/               shared libs: tools/(registry,router,configs), pdf/, own/,
                       seo/(metadata,json-ld,tool-seo,site), auth.ts, api-auth.ts,
                       rate-limit.ts, db.ts, analytics/
src/data/              catalog-summary.ts (categories + planned tools)
src/fonts/             self-hosted Inter + Noto Sans Devanagari woff2
tools/<tool-id>/       ONE folder per tool (anatomy below)
prisma/                schema.prisma (mirrors PRD §2.5)
db/                    SQLite file(s)
public/                vendored engines + static assets (pdfjs/, tesseract/,
                       qpdf-wasm/, libheif/, heic/, icc/, fonts via src)
scripts/               smoke-*.ts battery, make-*/probe-*/verify-* fixtures,
                       i18n-*.py merge scripts, dev-daemon.py, mini-daemon.py,
                       push-github.sh, ops/status.sh
mini-services/         convert/ (3031), request-sign/ (3032) — separate
                       package.json each; entry index.ts
services/worker/       reserved for Phase-11 LibreOffice worker
docs/                  PRD-v2.md, rules/, seo/WEBMASTER-GUIDE.md, archives
examples/websocket/    socket.io reference demo
```

## Tool folder anatomy (`tools/<tool-id>/`)

| File | Required? | Role |
|------|-----------|------|
| `config.ts` | always | registry payload: id, category, title/desc keys, routes, flags |
| `surface.tsx` | always | UI (ToolShell screens) |
| `worker.ts` | when processing | heavy work off main thread |
| `model.ts` / `types.ts` | complex tools | shared domain types |
| `engine.ts` | only if shared logic is PURE and worker-safe |
| `i18n.json` | new/changed strings | merged into en/hi catalogs via `scripts/merge-*-i18n.ts` |
| `panel.tsx` | editor-family panels |

Naming: kebab-case ids (`edit-pdf`, `pdf-to-word`); no new abbreviations.

## Rules

- New deps: `bun install` + justify in worklog (house rule: avoid new
  packages when stdlib/shadcn covers it; no AGPL/GPL).
- Vendored third-party assets live under `public/<vendor>/` WITH their
  `LICENSE`/`NOTICE` files. Never hotlink CDNs.
- QA screenshots/fixtures: `public/qa/` only (gitignored cleanup allowed).
- Test scripts are `scripts/smoke-<topic>.ts`, one topic per file.
- Anything in `scripts/dev/` is throwaway diagnostics — never imported by
  app code; keep them typecheck-clean anyway (Vercel builds scripts/**).
