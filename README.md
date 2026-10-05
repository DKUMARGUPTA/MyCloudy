# DocoPDF.com

*Har PDF kaam, ek jagah. Fast, free, private.*

Online PDF tools website (English + हिंदी) built from the PRD
(`docs/PRD-v2.md` / `upload/DocoPDF-PRD-v2.docx`). Most tools run **entirely
in the browser** — files stay on the user's device.

## Stack

| Layer     | Choice |
|-----------|--------|
| Framework | Next.js 16 (App Router) + TypeScript strict + Tailwind CSS 4 |
| UI        | shadcn/ui (New York) + Lucide icons + custom DocoPDF tokens |
| Database  | Sandbox: Prisma + SQLite. Production: Turso (libSQL) — metadata only |
| Files     | User device only: OPFS / IndexedDB / File System Access / Web Share |
| Fonts     | Self-hosted Inter + Noto Sans Devanagari (`src/fonts/`, `next/font/local`) |
| Engines (planned) | pdf.js, pdf-lib, qpdf WASM, Tesseract.js, fflate — all self-hosted in `/public` |

**Hard rules** (from the PRD): no third-party CDNs; device-only tools make
zero network requests with file data (Web Workers only); no AGPL/GPL
libraries; qpdf WASM handles encrypt/decrypt; every tool is config-driven and
rendered by a shared ToolShell; all UI strings go through i18n keys (en + hi).

## Local development

```bash
bun install
cp .env.example .env        # DATABASE_URL points at db/custom.db
bun run db:push             # create/sync the 13 PRD §2.5 tables
bun run dev                 # http://localhost:3000
```

Useful scripts: `bun run lint`, `bun run db:generate`, `bun run db:push`.

## Project structure

```
src/app/            routes (only "/" is user-visible in this sandbox)
src/components/ui/  shadcn/ui primitives (Button, Badge, Dialog, Drawer, Tabs…)
src/components/doco/  DocoPDF components (Logo, SiteHeader, SiteFooter, Modal,
                      BottomSheet, EmptyState, ThemeToggle, LanguageSwitch)
src/i18n/           en.json + hi.json catalogs + translate()
src/data/           catalog summary (PRD §7 categories + planned tools)
src/fonts/          self-hosted woff2 (Inter, Noto Sans Devanagari)
prisma/             schema mirroring PRD §2.5 (metadata only)
public/             logo.svg (pdf.js/wasm/tessdata arrive in later phases)
docs/               PRD + future tool specs/runbooks
services/worker/    placeholder for the Phase-11 Docker worker
.github/workflows/  CI: lint, typecheck, build
```

## Deploying to Vercel + Turso

1. **GitHub**: push this repo; in the production monorepo the app lives at
   `apps/web` (adjust CI `working-directory` accordingly).
2. **Turso** (production database):
   ```bash
   turso db create docopdf
   turso db show docopdf --url      # -> TURSO_DATABASE_URL
   turso db tokens create docopdf   # -> TURSO_AUTH_TOKEN
   ```
   Create a **separate** database for dev. Keep tokens in environment
   variables only (PRD §2.5).
3. **Vercel**: import the repo, set env vars `TURSO_DATABASE_URL` and
   `TURSO_AUTH_TOKEN`, deploy. Locales become path-based (`/` = en,
   `/hi` = Hindi) via next-intl routing at deploy time; the DB layer swaps
   from Prisma/SQLite to Drizzle/Turso — table and column names already
   match PRD §2.5 exactly.
4. **Domain**: point docopdf.com at Vercel; HSTS + CSP headers ship from
   `next.config.ts`.

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Design tokens (light/dark), self-hosted fonts, i18n en/hi, base components, Prisma schema (PRD §2.5), CSP + security headers, CI, README | ✅ done |
| 1 | Tool registry, header search (Ctrl+K), All Tools page, category pages, 404/500/offline, SEO | next |
| 2 | ToolShell engine: OPFS storage, pdf.js thumbnails, worker pool, result page, demo tool | planned |
| 3+ | Tools one-by-one, qpdf WASM (Protect/Unlock), Sign, static pages + APIs, PWA, editor, advanced tools, accounts, worker | planned |

See `worklog.md` (repo root) for the live handover state.
