# DocoPDF (docopdf.com)

*Har PDF kaam, ek jagah. Fast, free, private.*

Production: **https://www.docopdf.com** · Beta: `mycloudy-beta.vercel.app`
· Repo: `DKUMARGUPTA/MyCloudy` (main → Vercel auto-deploy)

100 live PDF tools (organize · edit · convert-to · convert-from · security ·
optimize · create · invoices · view), English + हिंदी, files processed
**on the user's device** (Mode D) unless a job truly needs a server.

## ⚡ Governance — READ FIRST

| File | Purpose |
|------|---------|
| [`AGENTS.md`](AGENTS.md) | **Master protocol** — mandatory entry point for every agent/session/update |
| [`docs/rules/INDEX.md`](docs/rules/INDEX.md) | Catalog of 18 binding rule docs |
| `docs/rules/01…18` | PRD · Design · Architecture · Folders · Relations · API · Agent · Plan · Steps · Features · Auth · MCP · Integration · Testing · Debugging · Billing-research · Accounting · Sandbox-resilience |
| [`CONTEXT-MEMORY.md`](CONTEXT-MEMORY.md) | Live short-term memory (session start file) |
| [`worklog.md`](worklog.md) | Full round-by-round history |
| [`docs/PRD-v2.md`](docs/PRD-v2.md) | Product requirements (v2.0, canonical) |
| [`docs/seo/WEBMASTER-GUIDE.md`](docs/seo/WEBMASTER-GUIDE.md) | GSC/Bing/GA4 owner actions |

**Hard rules (short form):** metadata only in DB · no third-party origins
(CSP `connect-src 'self'`, everything vendored) · i18n en/hi key parity with
`=N`-only plurals · gates before push (tsc 0, lint 0, smokes, E2E) · push
after every batch · never rewrite git history · secrets never in repo ·
JSON error envelopes, no internals leaked · heavy work in Web Workers ·
rule docs updated with the change they describe.

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router) + TypeScript strict + Tailwind CSS 4 |
| UI | shadcn/ui (New York) + Lucide + Framer Motion + custom tokens |
| PDF engine | **In-house engine** (`src/lib/own`, P6) + pdf.js + qpdf WASM + Tesseract.js + libheif — all self-hosted under `/public`; pdf-lib is a dev-only smoke oracle |
| Database | Prisma + SQLite (sandbox) / **Turso/libSQL LIVE in production** (driver adapter, R46); metadata only |
| Files | OPFS / IndexedDB / File System Access / Web Share — device only |
| Fonts | Self-hosted Inter + Noto Sans Devanagari (`src/fonts/`) |
| Mini-services | `convert` :3031 (office/webpage→PDF) · `request-sign` :3032 (envelopes) — hardened: SSRF guard, per-IP rate limits, size caps, atomic locks |
| Gateway | Caddy — `?XTransformPort` hard allow-list {3031, 3032} |

## Local development

```bash
bun install
cp .env.example .env        # DATABASE_URL points at db/
bun run db:push             # create/sync PRD §2.5 tables
python3 scripts/dev-daemon.py          # dev server :3000 (idempotent)
python3 scripts/mini-daemon.py convert && python3 scripts/mini-daemon.py request-sign
bun run lint                # gate 1 · bunx tsc --noEmit  # gate 0
```

## Change loop (canonical)

plan → implement → **gates** (tsc · lint · smokes) → **agent-browser E2E**
(golden path + regression suite) → worklog + CONTEXT-MEMORY + rules docs →
push (`scripts/push-github.sh`) → production spot-check.
Details: `docs/rules/09-EXECUTION-STEPS.md`.

## Project structure (essentials)

```
src/app/             routes: /, /tool/[id] ×100, /tools + categories, /hi/*, /api/*
src/components/      ui/ (shadcn) + doco/ (DocoPDF wrappers)
src/lib/             tools registry/router, own PDF engine, seo/, auth, rate-limit
src/i18n/            en.json + hi.json (key-parity enforced)
tools/<id>/          one folder per tool: config.ts, surface.tsx, worker.ts, …
mini-services/       convert (3031), request-sign (3032)
prisma/ · db/        schema (PRD §2.5) + SQLite files
scripts/             smoke battery, fixtures, daemons, push-github.sh
docs/                PRD, rules/, seo/, archives
services/worker/     reserved for Phase-11 LibreOffice worker
```

## Phase status (detail: docs/rules/08-PLAN.md)

| Phase | Scope | Status |
|-------|-------|--------|
| 0–7 | Foundation, 100 tools, own engine, editor, statics, PWA, SEO/i18n hardening (P7-c VLM battery) | ✅ shipped |
| 8 | Editor family | ✅ complete |
| 9 | Advanced tools + R19 hardening (5 phases) | ✅ shipped |
| 10 | Accounts + Pro gating + billing surface (R25–R28) + admin console (R29) + analytics (R42) | 🟡 in progress |
| 11 | services/worker (LibreOffice formats) | planned |
