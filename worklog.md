# DocoPDF — Shared Worklog (Handover Document)

> Single source of truth for cross-agent continuity. Every agent MUST read this file fully before
> starting work, and MUST append a section after finishing a task (template at the bottom).
> The product PRD governs WHAT to build: `/home/z/my-project/upload/DocoPDF-PRD-v2.docx`

## 1. Current project status (assessment)

- **Phase: 2 COMPLETE (P2.1)** — PDF core + ToolShell engine shipped and QA-verified.
  The first live tool (rotate-pdf-pages) runs 100% on-device through the shared
  ToolShell (Landing → Workspace → Processing → Result), with OPFS working copies,
  IndexedDB recent files (metadata + thumbnails only), self-hosted pdf.js
  thumbnails, a real worker pool (progress/cancel), chain mode, and the home
  Smart Drop Zone. Next: Phase 3 (first tool batch, one at a time, starting with Merge).
- PRD fully parsed (v2.0, "detailed, all tools", dated 5 Oct 2026, Hindi/English mixed doc).
  Markdown extract for easy reading/grep:
  `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
  (regenerate with: `pandoc /home/z/my-project/upload/DocoPDF-PRD-v2.docx -t gfm --wrap=none -o /home/z/my-project/upload/DocoPDF-PRD-v2.md`)
- Environment verified: Next.js **16.1.3** (App Router, Turbopack) dev server running on **port 3000**
  (HTTP 200), `dev.log` clean (only 200s + expected 400s from API validation tests).
- Available stack (from package.json): TypeScript 5 (strict), Tailwind CSS 4 + full shadcn/ui set in
  `src/components/ui` (New York), Prisma 6 + SQLite (`db/custom.db`, client via `import { db } from '@/lib/db'`),
  next-intl, next-themes, zod, zustand, framer-motion, lucide-react, sonner, vaul, dnd-kit.
  **Phase 2 additions (exact pins):** `pdf-lib@1.17.1`, `pdfjs-dist@4.10.38`, `fflate@0.8.2`.
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

- Completed (P2.1): pinned deps (pdf-lib/pdfjs-dist/fflate) + pdf.js assets
  self-hosted in /public/pdfjs (lib+worker+cmaps+standard_fonts, 4.1MB);
  storage layer (idb.ts wrapper, opfs.ts with IDB-Blob fallback + storage
  estimate, recent-files.ts with 20/30-day cap + serialized write queue +
  removeRecentFilesByMeta); pdf layer (lazy self-hosted pdf.js loader via
  non-literal dynamic import + turbopackIgnore, thumbnail render queue max 2
  with OffscreenCanvas + DOM-canvas fallback, magic-byte %PDF- sniff);
  worker protocol (run/progress/result/error + parsePageSpec) + ToolWorkerPool
  (idle reuse per tool, hardware-concurrency cap 2-4, one-shot slot
  accounting, instant terminate on cancel + OPFS cleanup); config-driven
  tool system (config-types, configs aggregator, tools/rotate-pdf-pages
  config+worker); ToolShell 4 states with DropZone (magic bytes, 50MB
  mobile/200MB desktop, count limits, paste, low-storage warn), FileCard
  (thumbnail/pages/reorder/remove), OptionsPanel (select/number/text/switch/
  pages from schema), StageStepper, ProcessingView (real % + page x/y +
  cancel), ResultView (download/FSA save-picker/share/ZIP/rename w/ locked
  extension/size delta/what-next chain/feedback thumbs+reasons/remove from
  device/privacy line); #/tool/<id> hash routing + ToolCard/palette/mega-menu
  navigation to live tools; Hero Smart Drop Zone (type detect → suggestions,
  handoff to tool); home Recent files strip (thumbnails from IDB, Clear,
  hidden when empty); /api/feedback (zod, honeypot, in-memory rate limit
  10/min, Prisma insert, best-effort); i18n +~130 keys en/hi; tsconfig now
  excludes examples/skills/tests scaffold dirs.
- Verified via agent-browser: full golden path (home smart-drop upload →
  suggestion → #/tool/rotate-pdf-pages workspace with chain handoff → options
  (direction + pages "1-2") → run → result "Your file is ready!" + renamed
  "my rotated doc.pdf" + toast); direct landing state (dropzone/how/FAQ/
  features/related); 400-page PDF (346KB→338KB output, <1s); feedback click →
  POST /api/feedback 200 → SQLite row; disabled chain targets toast "coming
  soon" w/o navigation; Hindi full tool UI + Devanagari result; mobile 360px
  no h-scroll + bottom-sheet options + sticky CTA + tab bar hidden in tool
  view; recent strip (thumbnail blob from IDB, "Clear", honest reselect
  toast); remove-from-device → OPFS work dir [] + recent 0 + toast; StrictMode
  single-recent-entry regression test (1 upload = 1 entry); network filter =
  ZERO non-local requests across the whole session (privacy §2.2 rule);
  fresh-context page errors = 0; eslint src+tools clean; tsc --noEmit clean;
  dev.log clean. Cancel path code-verified (terminate+reject+cleanup) — the
  400-page file completes in <600ms so the browser can't catch mid-flight
  state; retest with a multi-MB scanned file when Merge ships.
- Fixed during QA: react-hooks/set-state-in-effect ×4 (thumbnail/objectURL
  effects now update inside promise callbacks; chain handoff consumed via
  lazy useState initializer + key-remount); react-hooks/refs (removed
  phaseRef); react-hooks/immutability (replaced recentIdsRef with
  removeRecentFilesByMeta label+size matching); StrictMode duplicate
  setFiles-updater side effects (moved out of updater — React double-invokes
  updaters); getSnapshot unstable empty array (EMPTY_ENTRIES const); recent
  add/remove race (serialized write queue); TDZ ordering (chainIn before
  use); hero browseAll {count} interpolation; tsc ClipboardEvent DOM vs
  React type; tsconfig scaffold-dir exclusions.
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

1. **NEXT: Phase 3 — first tools ONE AT A TIME** (order per plan §4): Merge
   → Split → PageGrid family (Rotate/Rearrange/Remove/Extract with drag grid)
   → Images to PDF → PDF→JPG/PNG → PDF→Text → Watermark → Page numbers +
   Header/footer → Crop → Doc info + Remove metadata → Fill out → View →
   Compress (device) → Generate password → Scan → HEIC/WEBP. Each = config +
   worker under tools/<id>/ + registry `enabled: true` + i18n. Merge needs a
   dnd-kit reorder FileCard list (registry maxFiles=50).
2. Cancel path not yet caught mid-flight in browser (tool <600ms even on 400
   pages) — retest with a multi-MB scanned file in Phase 3.
3. qpdf WASM build source + exact version + license must be verified before Phase 4
   (VERIFY: npm `qpdf-wasm` availability; PRD §2.3 expects Apache-2.0 qpdf).
4. HEIC decoder WASM license flagged "verify" in PRD §2.3 — confirm before HEIC tools.
5. Fabric.js vs Konva decision at editor phase (both MIT; PRD allows either).
6. Turso/Drizzle/Vercel deliverables = config + README text in this sandbox (no external services).
7. PRD §17.2 open questions (trademark, pricing, worker host) are business decisions — do not invent.
8. cron webDevReview re-armed 5 Oct as job **437196** with priority=1 (low) after
   job 437069 failed twice with "model glm-5.3 concurrency limit exceeded";
   low-priority scheduling + 15-min retry self-heals transient failures.

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

---
Task ID: P1.1
Agent: Z.ai Code (webDevReview cron round 2, job 437069)
Task: Scheduled review round — baseline QA green (Phase 0 stable), so executed the next pending phase: PHASE 1 DISCOVERY LAYER (PRD §5, 6.1, 6.2, 7) per the master-prompt phase plan.

Work Log:
- Baseline QA: page rendered clean (Hindi persisted from localStorage — locale store working as designed).
- Registry: src/lib/tools/registry.ts — 97 tools from PRD §7 (10 categories incl. "images" for §7.10 utilities, noted as small deviation from §4's 9 URLs); each tool: id/slug, category, mode D/S, phase P1-P3, lucide icon (ALL 70+ icon names verified to exist via bun script before use), name/description as {en,hi} locale maps, tags {en[],hi[]} incl. Hinglish transliterations, accepts input type, popularity 0-100, enabled:false (flips per phase plan), pro:false. Lookups: getTool, getCategory, toolsByCategory, popularTools, PHASE_LABELS, category chip/hover classes. DELETED src/data/catalog-summary.ts (single source of truth now the registry).
- i18n: catalogs expanded with nav/tabs/tools/request/palette/consent keys (~150 new strings each); tool names/descs live in registry locale maps (type-safe, documented decision).
- Search: src/lib/search/fuzzy.ts — self-written scorer: exact → word-boundary substring ("word" no longer matches inside "password"; "passw" prefix-matches) → word-level bigram dice with length-ratio guard 0.6-1.6 (typo-tolerant: "merg"→merge 0.86; blocks cross-length noise). Fields weighted name 3/tags 2/slug 1.6/desc 1/category 1; multi-term AND; threshold 0.35. Verified: password→11 (password tools first), word→17 (Word tools first, password noise gone), जोड़→1 exact, jodein→14 top merge, photo 100kb→1 exact.
- Routing: src/hooks/use-hash-route.ts — hash as external store (useSyncExternalStore), routes #/, #/tools, #/tools/<cat>, ?q=; plain #anchors scroll on home; navigateToHash() module helper (location.hash assignment — router.push does NOT fire hashchange, found in QA); ROUTES constants.
- Stores: favorites + last-used (localStorage, createLocalSnapshot raw-keyed cache in src/lib/storage/local-snapshot.ts — unstable getSnapshot caused an infinite render loop, found + fixed in QA); lastUsed written by future ToolShell via trackToolUse().
- Views: AllToolsView (large search w/ desktop autofocus via pointer:fine matchMedia, sticky chips incl. Favorites/Last-used, mode/input Select filters, Popular/A–Z toggle, ToolCard grid 1-4 cols, EmptyState + RequestToolModal), CategoryView (colored header, registry intro, private/server counts, related chips), ToolsView switcher.
- ToolCard (PRD §3.3): 48px category-tinted icon, name, 2-line desc, Private/Server badge, Soon chip + roadmap phase, favorite star (aria-pressed, toast), hover lift + colored border, focus ring.
- SearchPalette (Ctrl+K + "/"): CommandDialog; groups Favorites/Popular (empty query) or Results+See-all; shouldFilter=false (our fuzzy filters; cmdk's built-in filter hid See-all, found in QA); Enter opens tool (coming toast + category nav) or See-all → #/tools?q=.
- Header: mega-menu via NavigationMenu (5 category columns top-6 tools + More column + See all 97), All-tools nav link, Ctrl+K trigger button w/ kbd hint, mobile sheet w/ all 10 categories; Footer: privacy-settings reopens consent banner, category chips, see-all link; CookieBanner: Accept all / Reject non-essential / Customize (Switch, default OFF) persisted, re-openable; BottomTabBar (mobile md:hidden): Home/Tools/Search (Recent+Account deferred to their phases, noted).
- page.tsx: hash router wiring (home view / ToolsView), BottomTabBar + CookieBanner + SearchPalette + ProModal mounted.
- SEO: public/sitemap.xml (home + tools + categories w/ hreflang en/hi), robots.txt (allow all, disallow /api/, sitemap ref).
- QA fixes during the round: Settings2 missing from registry imports (ReferenceError); getCategory(object) misuse in 3 components (CATEGORIES maps directly now); useSyncExternalStore unstable snapshots → createLocalSnapshot; palette navigation via navigateToHash; cmdk shouldFilter; search precision rework; Sheet a11y warning (aria-describedby={undefined}).
- Final QA: lint clean; zero page errors; console clean; dev.log clean; screenshots qa-p1-*.png (home, all-tools, favorited, category, palette, palette-search, see-all, hindi-tools, mobile-tools, mobile-home, megamenu, final-home).

Stage Summary:
- Phase 1 COMPLETE: full discovery layer driven by the 97-tool registry; bilingual search (typo + Hinglish + Devanagari); favorites; filters; request queue; consent; mobile tab bar; hash routing with back/forward support.
- Deviations: 10th "images" category for §7.10 (PRD §4 lists 9 category URLs); tool strings in registry locale maps (not JSON catalogs) for type safety; mega-menu shows top-6 per column (PRD says all tools — full list lives in All Tools view); tab bar has Home/Tools/Search only until Recent/Account exist; 404/500/offline pages skipped (sandbox single-route; noted for deploy); Smart Drop Zone deferred to Phase 2 (needs OPFS + ToolShell to be real).
- Next: PHASE 2 — ToolShell engine + OPFS + pdf.js + worker pool + demo rotate tool.
---
Task ID: P2.1
Agent: Z.ai Code (main session — user-directed continuation after 2 cron rounds failed with "model glm-5.3 concurrency limit exceeded")
Task: Fix the failed cron (re-arm webDevReview) and execute the pending PHASE 2: PDF CORE + TOOLSHELL + STORAGE (PRD §2.3, 2.4, 6.3, 6.4, 6.6) per the master-prompt phase plan.

Work Log:
- Fixed cron failure: deleted failed job 437069, recreated as 437196 (fixed_rate 900s, priority=1 low) so review rounds no longer collide with active sessions; any future failure self-heals next tick.
- Deps (exact pins): pdf-lib@1.17.1, pdfjs-dist@4.10.38, fflate@0.8.2 (PRD §2.3; fflate = PRD-specified ZIP lib). Copied pdf.js lib+worker+cmaps+standard_fonts (4.1MB) from node_modules into /public/pdfjs — zero runtime CDN.
- Storage (§2.4): src/lib/storage/idb.ts (promise wrapper, blobs+recent stores), opfs.ts (OPFS-first working copies w/ IDB-Blob fallback, clearWorkingFiles, storage.estimate low-space check), recent-files.ts (max 20 / 30 days, metadata+thumbnail only, external-store subscribe + serialized write queue + removeRecentFilesByMeta).
- PDF layer: src/lib/pdf/pdfjs.ts (lazy same-origin runtime import with webpack+turbopack ignore comments, workerSrc/cMaps/standardFonts self-hosted) + thumbnails.ts (WeakMap doc cache, 2-slot render queue, OffscreenCanvas w/ DOM fallback, %PDF- magic-byte sniff within first 1024 bytes).
- Workers: protocol.ts (run/progress/result/error messages, page-range parser) + pool.ts (ToolWorkerPool: per-tool idle reuse, min(hw-1,4) cap, one-shot slot accounting, cancel = instant terminate + OPFS clear).
- Tool system: config-types.ts + configs.ts aggregator + tools/rotate-pdf-pages/{config.ts,worker.ts} (pdf-lib /Rotate deltas, real per-page progress, sanitized output names, typed error codes for i18n).
- ToolShell family (§6.3/6.4): tool-view + tool-shell (4 states, chain via lazy-initializer peek + key remount, working-copy lifecycle) + drop-zone (magic bytes/limits/paste/low-storage) + file-card + page-thumbnail + options-panel (schema-driven) + stepper + processing-view + result-view (download/FSA save-as/share/ZIP/rename/size delta/what-next chain/feedback/remove-from-device).
- Discovery wiring: hash route #/tool/<id> (+ROUTES.tool), ToolCard/palette/mega-menu navigate to live tools, registry rotate-pdf-pages enabled:true.
- Home (§6.1): Hero Smart Drop Zone (type detect -> suggestions; honest "coming soon" for future tools; handoff to enabled tool via chain store) + Recent files strip (IDB thumbnails, Clear, hidden when empty, honest reselect toast).
- API (§2.5): POST /api/feedback — zod (toolId/rating/reason enum/honeypot), in-memory 10/min rate limit, Prisma insert, no PII.
- i18n: +~130 keys (dropzone/tool/result/feedback/recent/smartDrop/nav) in en + real Hindi.
- QA (agent-browser): golden path smart-drop -> tool -> options -> run -> result + rename + toast; direct landing; page-range 1-2; 400-page 346KB file <1s; feedback 200 -> SQLite row; disabled chain = toast, no nav; Hindi UI; mobile 360px (no h-scroll, bottom-sheet options, sticky CTA, tab bar hidden); recent strip + Clear; remove-from-device = OPFS [] + recent 0; StrictMode race regression test (1 upload = 1 entry); network filter ZERO non-local requests; fresh-context errors 0; eslint+tsc clean; dev.log clean.
- Fixes during QA: set-state-in-effect x4 (promise-callback pattern; chain handoff via lazy useState + key remount), phaseRef removed, recentIdsRef replaced by removeRecentFilesByMeta (react-hooks/immutability), setFiles-updater side effects moved out (StrictMode double-invoke), EMPTY_ENTRIES stable snapshot, serialized recent writes, TDZ chainIn ordering, hero {count} params, DOM ClipboardEvent type, tsconfig excludes examples/skills/tests.
- Regenerated bilingual catalogs via node scripts after a MultiEdit anchor mismatch on the "•" bullet produced a non-atomic partial apply (en.json a11y group was clobbered and restored; verified JSON validity + all key groups present in both locales).

Stage Summary:
- Phase 2 COMPLETE: full on-device tool pipeline live; only enabled tool = rotate-pdf-pages (the phase plan's demo tool). Screenshot evidence: download/qa-p2-*.png (13 files).
- Deviations: none new beyond the documented sandbox set (tools/ at app root mirrors PRD monorepo layout; result preview opens a blob tab until the §6.5 viewer phase; cancel is terminate-based per PRD).
- Next: Phase 3 first tools one at a time, starting with Merge PDF (needs dnd-kit reorder list, maxFiles=50).
