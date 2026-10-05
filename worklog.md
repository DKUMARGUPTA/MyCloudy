# DocoPDF — Shared Worklog (Handover Document)

> Single source of truth for cross-agent continuity. Every agent MUST read this file fully before
> starting work, and MUST append a section after finishing a task (template at the bottom).
> The product PRD governs WHAT to build: `/home/z/my-project/upload/DocoPDF-PRD-v2.docx`

## 1. Current project status (assessment)

- **Phase: 0 COMPLETE (P0.1)** — scaffold shipped and QA-verified via agent-browser.
  Landing page live at `/` (hero, steps, categories+sheet, why, modes, footer, Pro modal).
  The interactive user remains the driver for formal phase prompts; the review loop
  continues with the next pending phase (1: layout + discovery) when stable.
- PRD fully parsed (v2.0, "detailed, all tools", dated 5 Oct 2026, Hindi/English mixed doc).
  Markdown extract for easy reading/grep:
  `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
  (regenerate with: `pandoc /home/z/my-project/upload/DocoPDF-PRD-v2.docx -t gfm --wrap=none -o /home/z/my-project/upload/DocoPDF-PRD-v2.md`)
- Environment verified: Next.js **16.1.3** (App Router, Turbopack) dev server running on **port 3000**
  (HTTP 200), `dev.log` clean (no errors, only `GET / 200`).
- Available stack (from package.json): TypeScript 5 (strict), Tailwind CSS 4 + full shadcn/ui set in
  `src/components/ui` (New York), Prisma 6 + SQLite (`db/custom.db`, client via `import { db } from '@/lib/db'`),
  next-intl, next-themes, zod, zustand, framer-motion, lucide-react, sonner, vaul, dnd-kit.
- PRD section map (line numbers in the .md extract): §1 Vision (18), §2 Architecture (68),
  §3 Design System (203), §4 Sitemap (255), §5 Global Elements (270), §6 Core Pages (314),
  §7 Tool Catalog (534), §8 Tool Specs (685), §9 Static Pages (1048), §10 Errors/Copy (1183),
  §11 Monetization (1201), §12 SEO/A11y/i18n/PWA (1222), §13 Analytics (1260), §14 NFR (1279),
  §15 Acceptance QA (1292), §16 Roadmap (1316), §17 Risks (1327).

## 2. Sandbox deviations from the PRD (every agent MUST know these)

| PRD says | Sandbox reality | How to handle |
|---|---|---|
| Monorepo: apps/web, services/worker, .github, docs (§2.6) | ONE Next.js app at `/home/z/my-project`; the user can only see the `/` route (`src/app/page.tsx`) | Mirror PRD layout as folders inside the app: `tools/<tool-id>/{config.ts,Panel.tsx,worker.ts}`, `lib/pdf/`, `lib/storage/`, `public/{pdfjs,wasm,tessdata,fonts}`. `services/worker` stays docs-only until its phase. |
| Turso (libSQL) + Drizzle (§2.1, §2.5) | No external DB reachable; Prisma + SQLite preinstalled | Use Prisma with a schema mirroring PRD §2.5 tables EXACTLY (names/columns). Metadata only — never PDF content or filenames. Mechanical swap to Drizzle/Turso at deploy. |
| Vercel + GitHub Actions CI | Not runnable here | Deliver CI config + deploy steps as files/README text only. NEVER run `bun run build` in this sandbox. |
| `/hi` path-based locales (§4) | Only `/` is user-visible | Locale switching = app state on `/` (i18n keys en/hi unchanged). Path-based `/hi` restored at Vercel deploy time. |
| Vitest unit tests (Phase 0/2) | This sandbox forbids writing test code | Document as deviation; rely on `bun run lint` + agent-browser QA. Manual test scripts from phase prompts still apply. |
| Self-hosted fonts (§3.2) | Need woff2 files locally | Phase 0: fetch Inter + Noto Sans Devanagari (+ JetBrains Mono) woff2 once, serve via `next/font/local` — no runtime CDN. |

## 3. Current goals / completed modifications / verification results

- Completed (P0.1): design tokens light+dark (PRD §3.1 exact colors + category colors),
  self-hosted fonts (Inter + Noto Sans Devanagari via next/font/local), i18n en/hi with
  LocaleProvider (useSyncExternalStore), theme system (next-themes, no-flash), base components
  (Badge private/server/new/pro/beta, Button cta/touch, Modal, BottomSheet, EmptyState, ThemeToggle,
  LanguageSwitch, Logo), landing page sections, Prisma schema (13 tables mirroring §2.5) + db push,
  CSP + security headers in next.config, .env.example, README, CI workflow, services/worker
  placeholder, docs/PRD-v2.md.
- Verified: agent-browser — page renders, a11y tree correct, dark-mode toggle applies `.dark`,
  Hindi switch sets `html[lang=hi]` + Devanagari hero, category sheet lists 12 tools with mode
  badges, Pro modal opens, 360px viewport has no horizontal scroll, mobile hamburger sheet works,
  console + page errors ZERO, CSP/headers served, fonts preload self-hosted. `bun run lint` clean.
- Goal now: execute the phase plan below in strict order, one phase (or sub-phase) per round.

## 4. Phase plan (user's chat phases → PRD mapping)

| # | Scope | PRD |
|---|---|---|
| 0 | Scaffold: design tokens (exact §3.1 colors) light+dark, fonts self-hosted, i18n en/hi skeleton, base components (Button, Badge Private/Server/New/Pro, Card, Modal, BottomSheet, Toast, Progress, Tabs, EmptyState), Prisma schema (§2.5), CSP + security headers in next.config, README | §2, §3 |
| 1 | Global layout + discovery: typed tool registry with EVERY §7 tool, header (mega-menu, Ctrl+K fuzzy search, lang + theme switch), footer, cookie banner (analytics OFF), home (§6.1 smart drop zone), all-tools (§6.2), category pages, 404/500/offline, SEO (sitemap, hreflang) | §5, 6.1, 6.2, 7 |
| 2 | PDF core + ToolShell + storage: OPFS helpers + IndexedDB fallback, recent files (max 20, 30 days), pdf.js self-hosted thumbnails + render queue, worker pool (progress/result/error/cancel protocol), ToolShell 4 states (Landing→Workspace→Processing→Result), DropZone/FileCard/PageThumbnail/OptionsPanel/sticky bar/Stepper, result page (download/share/rename/size delta/chain/ZIP/remove), demo tool: rotate all pages 90° | §2.3, 2.4, 6.3, 6.4, 6.6 |
| 3 | First tools ONE AT A TIME (order): Merge, Split, Rotate/Rearrange/Remove/Extract (PageGrid family), Images to PDF, PDF→JPG/PNG, PDF→Text, Watermark, Page numbers + Header/footer, Crop, Doc info + Remove metadata, Fill out, View, Compress (device), Generate password, Scan to PDF, HEIC/WEBP converters | §8.1, 8.2 partial |
| 4 | qpdf WASM: Protect PDF + Unlock PDF (AES-256, permissions, strength meter, no cracking) | §8.3, §2.3 |
| 5 | Sign PDF (draw/type/upload, saved signatures, placement, flatten) | §8.3 |
| 6 | Static pages (About, Contact, Help, Security, Privacy, Terms, Cookies, Refund, DMCA, Grievance, Accessibility, Request-a-tool + votes, Install App — legal pages marked DRAFT) + API routes (contact, feedback, tool-requests + vote) with zod, rate limit, honeypot | §9, §2.5 |
| 7 | PWA (manifest, service worker caching pdf.js/wasm, install prompt, offline indicator, share target) + performance pass (§2.8 targets) | §12, §14 |
| 8 | Editor in 6 sub-phases: shell, objects, text edit, forms, export pipeline, mobile mode | §8.2.1 |
| 9 | Advanced client tools: OCR (Tesseract + Hindi traineddata), Compress-to-size, N-up, Halve, Overlay, Page size, Bookmarks, Extract images, Copy from PDF, Assemble, Flatten, Rasterize, Search PDFs, Redact, Compare, Fill/Make fillable, QR, Write PDF, MD/Txt→PDF | §8.1–8.5 |
| 10 | Accounts + Pro: email/password auth, sessions, account page, delete account, Razorpay + webhook (idempotent), GST invoice, pricing page, server-side limits | §9, §11, §2.5 |
| 11 | services/worker (Docker): LibreOffice conversions, strong compress, ClamAV, sandbox, TTL sweeper — Dockerfile + compose + notes | §2.7, 7.8, 7.9, 8.6 |

## 5. Hard rules (from the user's master prompt + PRD — NEVER violate)

- **Zero third-party CDNs** — fonts (Inter, Noto Sans Devanagari), icons, pdf.js, qpdf WASM,
  Tesseract traineddata all self-hosted from `/public`.
- **Device-only (mode D) tools: ZERO network requests with file data.** Heavy work in Web Workers,
  never block the main thread. Mode S tools are Phase 3 (chat phase 11) only — do not build early.
- **No AGPL/GPL libraries** (no Ghostscript, no MuPDF). Unclear license → flag "VERIFY", don't use.
- **pdf-lib cannot encrypt** — Protect/Unlock must use qpdf WASM.
- **Config-driven tools**: one registry + one shared ToolShell; never copy-paste per-tool pages.
- **All UI strings via i18n keys** (en + real Hindi in Devanagari, short). Error copy per PRD §10 table.
- **Accessibility**: keyboard operable, visible focus, aria labels, 44px targets,
  prefers-reduced-motion, dark mode via §3 tokens. Mobile-first — mentally test at 360px first.
- **No placeholder code / TODO / pseudo-code.** Every file complete and runnable.
- **Pin exact package versions.** Unsure about an API → mark "VERIFY:" with the doc page; never guess.
- **Security**: validate by magic bytes (not extension), size limits (50MB mobile / 200MB desktop
  default per §2.4), CSP-friendly (no inline eval), NEVER log file names or contents.
- PRD §3.1 explicitly sets primary `#2563EB` (blue) — blue is the PRD-specified brand color here.
  Category colors: Organize=Blue, Edit=Purple, Convert=Green, Security=Red, Optimize=Orange,
  Create=Teal, Invoices=Amber, View=Slate. Dark mode day one.
- Sandbox extras: only `/` is user-visible; use API routes (`src/app/api`) not server actions;
  never `bun run build`; check `dev.log` after coding; verify with agent-browser before reporting done.

## 6. Unresolved issues / risks / next-phase priorities

1. **NEXT: Phase 1 discovery** — typed tool registry with EVERY §7 tool (id, slug, category, mode,
   phase, icon, i18n name/desc keys, Hindi names, tags), header mega-menu + Ctrl+K fuzzy search,
   cookie banner (analytics OFF), full home (§6.1 smart drop zone), All Tools page (§6.2 favorites/
   last-used from localStorage), category pages, 404/500/offline, SEO (sitemap, hreflang).
2. qpdf WASM build source + exact version + license must be verified before Phase 4
   (VERIFY: npm `qpdf-wasm` availability; PRD §2.3 expects Apache-2.0 qpdf).
3. HEIC decoder WASM license flagged "verify" in PRD §2.3 — confirm before HEIC tools.
4. Fabric.js vs Konva decision at editor phase (both MIT; PRD allows either).
5. Turso/Drizzle/Vercel deliverables = config + README text in this sandbox (no external services).
6. PRD §17.2 open questions (trademark, pricing, worker host) are business decisions — do not invent.

## Append template (copy for every new entry)

```markdown
---
Task ID: P<phase>.<n>            (e.g. P0.1, P2.3)
Agent: <agent name>
Task: <what was asked / chosen focus>

Work Log:
- <concrete step 1>
- <concrete step 2>

Stage Summary:
- <key results / decisions / artifacts; update sections 1, 3 and 6 above if status changed>
```

---
Task ID: 0
Agent: Z.ai Code (main orchestrator)
Task: Master-prompt intake — parse PRD, map sandbox constraints, create this handover doc, arm review loop. No product code (user instructed: reply READY, wait for Phase 0 prompt).

Work Log:
- Extracted PRD: `pandoc upload/DocoPDF-PRD-v2.docx -t gfm --wrap=none -o upload/DocoPDF-PRD-v2.md`; read all 17 sections (1372 lines).
- Verified environment: Next.js 16.1.3 dev server on :3000 → HTTP 200; dev.log clean; shadcn/ui complete; Prisma 6 + SQLite present.
- Mapped PRD stack → sandbox deviations (section 2 above).
- Created this worklog and the 15-minute webDevReview cron (English description, fixed_rate 900s).

Stage Summary:
- Status: PRE-PHASE-0. No app code yet; `/` still shows the default scaffold page.
- Next: Phase 0 scaffold (tokens, fonts, i18n skeleton, base components, Prisma schema §2.5, CSP, README) — driven by the user's next prompt, or by the review loop if the site is stable and no user prompt is pending.

---
Task ID: P0.1
Agent: Z.ai Code (webDevReview cron round 1, job 437069)
Task: Scheduled review round — baseline QA passed (no bugs), so executed the next pending phase: PHASE 0 SCAFFOLD (PRD §2, §3) per the user's master-prompt phase plan.

Work Log:
- Baseline QA via agent-browser: scaffold rendered, zero errors → proceeded to Phase 0.
- Downloaded + verified self-hosted fonts: src/fonts/InterVariable.woff2 (352 KB, official rsms build) and src/fonts/NotoSansDevanagari-Variable.woff2 (121 KB, GF devanagari subset); wired via next/font/local in layout.tsx (replaced next/font/google Geist — CDN rule).
- globals.css: full token rewrite — PRD §3.1 light/dark colors (primary #2563EB/#60A5FA, CTA #F97316/#FB923C, bg/surface, text, success, danger), 8 category color tokens, semantic radii (card 16px, btn 12px, chip 999px), font stack with Devanagari fallback, selection/scrollbar utilities, prefers-reduced-motion, scroll-padding for sticky header.
- i18n: src/i18n/{en,hi}.json catalogs (~90 keys each, real Hindi) + translate() with {param} interpolation; LocaleProvider with useSyncExternalStore (localStorage external store, hydration-safe); <html lang> synced.
- Base components: Badge variants private/server/new/pro/beta; Button variant cta + size touch (44px); Modal (Dialog wrapper); BottomSheet (vaul Drawer wrapper); EmptyState; ThemeToggle (cycle light→dark→system, next-themes, no flash); LanguageSwitch (EN|हिं segmented, toast on change); Logo/LogoMark + public/logo.svg (brand gradient mark).
- Landing page at /: AnnouncementBanner (dismissible, localStorage), sticky header w/ mobile sheet, Hero (trust badges, gradient title), Steps (3-step), Categories (9 PRD §7 categories, 94 planned tools, bottom sheet w/ Private/Server mode badges), Why (3 cards), Modes (Tabs: device vs server, PRD §2.2), Footer (trust line, category chips), Pro modal. Mobile-first, skip-to-content link, aria labels, focus rings.
- Data: src/data/catalog-summary.ts (all 9 categories + tool names + D/S modes from PRD §7).
- DB: prisma/schema.prisma rewritten to 13 models mirroring PRD §2.5 (users, sessions, anon_usage, usage_events, feedback, tool_requests, request_votes, contact_messages, blog_posts, subscriptions, payments, jobs, audit_log; @@map snake_case names); `bun run db:push` OK; db.ts logging reduced to error/warn (privacy rule).
- Security: next.config.ts — CSP (self-only, blob for workers/thumbnails, dev-only unsafe-eval), X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy (camera self for future Scan tool), HSTS; allowedDevOrigins for the sandbox preview proxy; REMOVED invalid `eslint` key (Next 16 dropped it — found via dev.log warning).
- Repo files: .env.example (DATABASE_URL + TURSO_* placeholders), README.md (stack, structure, Vercel+Turso deploy steps, phase status), services/worker/README.md (Phase-11 placeholder), .github/workflows/ci.yml (lint/typecheck/build; Vitest step deferred — sandbox forbids test code, documented), docs/PRD-v2.md (copy of extract).
- Fixed 3 lint errors (react-hooks/set-state-in-effect) by replacing setState-in-effect patterns with useSyncExternalStore (use-mounted hook, provider store, banner store).
- QA (agent-browser): renders; a11y tree correct; dark toggle applies .dark; Hindi → html lang=hi + Devanagari H1; category sheet 12 tools + badges; Pro modal; 360px no horizontal scroll; mobile menu works; console/page errors ZERO; CSP+headers verified via curl; lint clean; dev.log clean after config fix.

Stage Summary:
- Phase 0 COMPLETE. `/` now shows the branded DocoPDF landing with full token system, dark mode, EN/हिं switching, and the PRD §7 catalog preview (94 tools / 9 categories).
- Screenshots: download/qa-p0-desktop-light.png, -dark.png, -hindi.png, -sheet.png, -modal.png, -mobile.png, -mobile-menu.png, -final-full.png.
- Deviations handled: Prisma/SQLite stands in for Turso/Drizzle (names match §2.5); locale = app state on / (only / visible in sandbox); Vitest deferred (no test code in sandbox); fonts fetched at build time from official sources (rsms.me + Google Fonts) and served self-hosted (no runtime CDN).
- Next: Phase 1 (registry + header search + all-tools + category pages + 404/500/offline + SEO) — user prompt or next review round when stable.
