# DocoPDF — Shared Worklog (Handover Document)

> Single source of truth for cross-agent continuity. Every agent MUST read this file fully before
> starting work, and MUST append a section after finishing a task (template at the bottom).
> The product PRD governs WHAT to build: `/home/z/my-project/upload/DocoPDF-PRD-v2.docx`

## 1. Current project status (assessment)

- **Phase: 3 IN PROGRESS (P3.4)** — Image conversion pair shipped: Images→PDF
  family (ONE shared interactive image-grid in tools/imagegrid/ powering
  images-to-pdf + jpg/png/webp-to-pdf presets: drag reorder, per-image 90°
  rotate w/ live CSS rotation, remove, A→Z sort, add-more zone, all-removed
  CTA gating) and PDF→images pair (pdf-to-jpg + pdf-to-png on ONE worker:
  pdf.js fake-worker mode INSIDE the tool worker — document.baseURI shim,
  DPI 72/150/300/600, page ranges, JPG quality, PNG transparent bg via
  render background:"rgba(0,0,0,0)", single/multi naming + ZIP). Verified
  byte-level: unrotated JPG/PNG embed ORIGINAL bytes, WEBP→PNG transcode,
  RGBA preserved, two-up + page numbers + dark bg correct page geometry.
  CANCEL PATH CAUGHT MID-FLIGHT (600 DPI × 400 pages at 6% → Cancel →
  workspace + toast) — closes the old deferred item.
  Live tools now: **13** (merge, split, rotate, rearrange, remove, extract,
  images-to-pdf, jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png), all 100%
  on-device. Infra: DropZone acceptKind driven by tool.accepts, image
  fast-path thumbnails (inputs + outputs + recent strip), chainToolIds
  (image outputs chain to image tools only), smart-drop image → direct
  images-to-pdf handoff.
  Next: PDF→Text, Watermark, Page numbers, Crop, Doc info, Fill, View,
  Compress, Generate password, Scan, HEIC/WEBP — one per round.
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

1. **NEXT: Phase 3 continues — PDF→Text** (§8.6: pdf.js text extraction,
   reading-order options, keep-layout toggle; device-only). Then Watermark,
   Page numbers, Crop, Doc info, Fill, View, Compress, Generate password,
   Scan, HEIC/WEBP — one per round.
   ImageGrid follow-ups (deferred, noted): per-image CROP UI (PRD §8.6 input
   row mentions "crop each" — needs a crop modal; rotate/reorder shipped);
   SVG/TIFF inputs unsupported (createImageBitmap cannot decode them in
   Chromium — honest error already shown; needs a WASM decoder later);
   images-in-merge auto-convert (PRD merge row) now UNBLOCKED — merge worker
   can reuse the imagegrid embed engine.
   PageGrid follow-ups (deferred, unchanged): virtualized drag stays off
   above 150 pages; selection indices after undo are clamped, not remapped.
   Split follow-ups (deferred, unchanged): per-part bookmark-title naming;
   blank detection 0.1% tolerance tuning.
   Merge follow-ups still deferred from P3.1: per-file bookmarks (pdf-lib
   outline — VERIFY API), per-file Unlock (qpdf round).
2. ~~Cancel path not yet caught mid-flight~~ **DONE in P3.4**: caught at 6%
   on a 600 DPI × 400-page pdf-to-jpg run; Cancel → workspace + toast ✓.
3. qpdf WASM build source + exact version + license must be verified before Phase 4
   (VERIFY: npm `qpdf-wasm` availability; PRD §2.3 expects Apache-2.0 qpdf).
4. HEIC decoder WASM license flagged "verify" in PRD §2.3 — confirm before HEIC tools
   (browser-native HEIC decode works in Safari today; Chromium fails with the
   honest error copy — qa'd in P3.4).
5. Fabric.js vs Konva decision at editor phase (both MIT; PRD allows either).
6. Turso/Drizzle/Vercel deliverables = config + README text in this sandbox (no external services).
7. PRD §17.2 open questions (trademark, pricing, worker host) are business decisions — do not invent.
8. cron webDevReview re-armed 5 Oct as job **437196** with priority=1 (low) after
   job 437069 failed twice with "model glm-5.3 concurrency limit exceeded";
   low-priority scheduling + 15-min retry self-heals transient failures.
9. agent-browser lesson (P3.4): its `click` command is flaky on freshly
   re-rendered React buttons (hit-test lands pre-flush); use eval `.click()`
   + delayed reads for reliable automation. Toast capture needs a
   MutationObserver — toasts vanish before later evals.

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
---
Task ID: P3.1
Agent: Z.ai Code (webDevReview cron round, job 437196 — first successful round after the concurrency failures)
Task: Scheduled review — baseline QA passed (0 errors), so advanced the next pending phase item: PHASE 3 TOOL #1, MERGE PDF (PRD §8.1) per the worklog's next-step priority. Also fixed a UX bug found during QA.

Work Log:
- Baseline QA: home + tool pages 0 errors, dev.log clean → proceeded to Merge PDF.
- Protocol/pool (additive): run requests now carry `fileIds` (aligned per-file options); results carry optional `detail` {files, pages} for the PRD §8.1 summary; pool resolves ToolRunResult {outputs, detail}.
- tools/merge-pdf/worker.ts: pdf-lib copyPages per file with per-file ranges (JSON map in options.fileRanges keyed by workspace id), blank page between files, best-effort form flatten (pdf-lib 1.17.1 API verified at runtime: PDFForm.flatten() — NOT flattenFields), sanitized output name (custom or <first>-merged.pdf), real per-file/per-page progress, encrypted/corrupt/invalid-range typed error codes, detail {files, pages}.
- tools/merge-pdf/config.ts: minFiles 2, maxFiles 50, options (blankBetween, flatten w/ honest hint, outputName), features + FAQ (en/hi); bookmarks-per-file deferred (pdf-lib outline is low-level — VERIFY before building; documented in FAQ honestly).
- Custom panel system (PRD §2.6 Panel.tsx): src/lib/tools/panel-types.ts (ToolPanelProps) + panels.tsx registry + tools/merge-pdf/panel.tsx (sort A→Z/Z→A/date buttons + per-file range inputs with a11y labels); ToolShell renders CustomPanel above the schema OptionsPanel in BOTH the desktop aside and the mobile bottom sheet (direct TOOL_PANELS[tool.id] map lookup — react-hooks/static-components rejects function-call lookups).
- Drag-reorder (PRD §8.1 preview): src/components/doco/tool/file-list.tsx — dnd-kit DndContext (PointerSensor distance 6, TouchSensor 200ms long-press, KeyboardSensor with sortableKeyboardCoordinates), rectSortingStrategy, restrictToParentElement modifier; grip handle button (GripVertical, cursor-grab/grabbing, touch-none, focus ring); drag styles: z-20 + scale-[1.02] + shadow-lg on active, ring-primary/40 on drop target; up/down buttons retained as the always-available keyboard path.
- Styling polish: success check animate-in zoom-in (reduced-motion respected globally), result summary chip (bg-primary/10), sticky-CTA min-files hint in primary color, options aside now max-h-[calc(100vh-11.5rem)] + internal scrollbar + mb-20 (height budget: sticky header + CTA bar).
- QA fixes found in the round: (1) FileCard root was <li> → nested inside FileList's sortable <li> = invalid HTML li>li hydration errors → root changed to <div>; (2) sticky CTA bar overlapped the bottom of the options aside on short viewports (577px innerHeight) → aside max-h accounts for the bar + internal scroll; (3) pool RunDetail needed re-export; (4) panels.tsx relative path depth (../../../tools).
- Verified via agent-browser (fresh context, 0 page errors, 0 console errors): merge landing; 2-file upload → custom panel (FILES & PAGES + sort + ranges); A→Z and Z→A reorder the grid; dnd drag aaa↔test-input reorder works; per-file range "1-2" on test-input → result "2 files, 5 pages" (3+2) + aaa-merged.pdf naming; full merge no ranges → 8 pages; blank-page-between → 9 pages (3+5+1); range "1-3" → 6 pages; invalid range "abc" → error toast + stays in workspace; Download click 0 errors; Hindi full merge UI (फ़ाइलें और पेज, खींचकर क्रम बदलें); mobile 360px no h-scroll + bottom sheet renders custom panel; rotate tool regression after pool refactor → result OK; eslint src+tools clean; tsc clean; dev.log clean.
- bun add @dnd-kit/modifiers@9.0.0 (pinned; core/sortable/utilities were preinstalled).

Stage Summary:
- Merge PDF COMPLETE and live (#/tool/merge-pdf, registry enabled). Live tools: 2 (merge, rotate). Screenshots: download/qa-p3-*.png (7).
- Architecture win: custom-panel pattern proven — tools can now ship schema options AND rich per-tool panels without leaving the config-driven system.
- Deferred honestly: images-in-merge, per-file bookmarks (VERIFY pdf-lib outline), page-grid card expand, per-file unlock (qpdf phase).
- Next: Split PDF (§8.1) — 7 modes, ZIP output; reuses FileList + protocol detail.

---
Task ID: P3.2
Agent: main (Z.ai Code session)

Task: Ship Split PDF — 2nd Phase-3 tool, PRD §8.1 (7 modes + live preview + ZIP output).

Work Log:
- Read worklog + PRD §8.1 split spec + studied merge-pdf tool (config/worker/panel)
  as the architecture reference; confirmed ResultView already handles multi-output
  ZIP + individual downloads (fflate), so split only needs to emit N outputs.
- tools/split-pdf/plan.ts — NEW pure shared module: parseRangeList ("1-5, 8, 10-end",
  open "N-", case-insensitive "end", clamped + overlap-friendly), rangesOverlap,
  computeSplitPlan for all 7 modes (range w/ one-file-per-range union, everyN chunks,
  bookmark starts w/ leading part, size estimate 0.92 margin, visual cuts-after,
  oddEven labeled parts, blanks-as-removed-separators), parseNumberListOption,
  fileKey (name|size identity for detected lists).
- src/lib/pdf/thumbnails.ts — added getPdfTopLevelOutline (pdf.js getOutline +
  dest resolution to 1-based start pages; unresolvable/external bookmarks skipped)
  and detectBlankPages (text-content gate + 24px queued render, <0.1% dark pixels
  = blank; unreadable pages treated as content) with onProgress.
- tools/split-pdf/config.ts — ToolConfig, options schema EMPTY (panel owns all
  interactive values; worker defaults defensively), minFiles/maxFiles 1, features +
  FAQ per PRD copy, outputKind pdf.
- tools/split-pdf/worker.ts — pdf-lib worker: loads once, computes authoritative
  plan via shared plan.ts, builds each part (per-page progress posts), size mode
  re-saves real bytes and halves oversized parts recursively, guards: bookmarks/
  blanks detection must be "done" AND fileKey-matched (else tool.splitWaitingDetect),
  no bookmarks → tool.splitNoBookmarks, no blanks found → tool.splitNoBlanks;
  naming <base>_part1.pdf, <base>-split.pdf (single), <base>_odd/_even.pdf.
- tools/split-pdf/panel.tsx — custom panel: role=tablist with 7 mode tabs
  (arrow-key nav, bookmarks tab disabled when outline empty), per-mode inputs
  (ranges + one-file switch + overlap warning chip, N, MB, clear-cuts), live
  PREVIEW box with color-coded parts (blue/purple/emerald/amber cycle), dashed
  cut markers w/ Scissors icon, live count "N files will be created /
  फ़ाइलें बनेंगी", "≈ estimated" chip for size mode, visual mode = thumbnail strip
  (queued 112px renders) with 44px scissors toggle buttons, bookmarks list with
  titles + start pages, blanks detection with % progress + found chips (strikethrough).
  All detection results reach the worker as plain options (JSON + fileKey), never
  stale-across-files.
- Registered: registry split-pdf enabled:true, TOOL_CONFIGS, TOOL_PANELS.
- i18n: +49 keys ×2 locales (split.* section incl. rangePrompt; tool.split*
  error codes), real Devanagari throughout.
- QA (agent-browser, split-test.pdf = 12 pages w/ blanks @4,9 + bookmarks @1,5,10):
  range "1-3, 5-7"→2 files & "10-end" keyword & overlap warning & one-file union;
  everyN 4→3 files; bookmarks→3 parts (4/5/3 pages); size 0.002MB→preview "≈1 est" →
  real run refined to 4 parts each under limit; visual scissors toggle→cut count +
  clear; oddEven→_odd/_even (6+6); blanks→2 found/removed, 3 files 10 pages;
  result view "2 files, 6 pages" + ZIP button click clean; Hindi end-to-end incl.
  "2 फ़ाइलें बनेंगी"; mobile 360px no h-scroll, bottom sheet full panel + run from
  sheet CTA; network 148 req / 0 non-local; page errors 0; eslint src+tools clean;
  tsc --noEmit clean; dev.log only 200s.
- Fixed during QA: pdf-lib copyPages direction (src.copyPages(src)→dest.copyPages
  (src) — caught via captured "couldn't be read" toast, verified all 7 modes with a
  bun smoke script before browser re-test); empty-vs-invalid ranges preview copy
  (muted prompt vs red error); lucide icon name (Bookmark not Bookmarks); plan
  import path (./plan from inside the tool folder).
- Dev-server note: the sandbox reaps plain background processes between commands;
  use the python double-fork daemon (see git history of this entry) to keep
  `bun run dev` alive across tool calls.

Stage Summary:
- Live tools: merge-pdf, rotate-pdf-pages, split-pdf (all mode D, on-device).
- Split covers PRD §8.1 completely: 7 modes, thumbnail strip preview w/ cut
  markers + color-coded parts, live file count, validations (in-range, overlap
  warning, bookmarks tab disabled when none), naming + ZIP output.
- New shared assets for future tools: top-level outline reader, blank-page
  detector, pure split-plan module, VisualStrip thumbnail pattern.
- Screenshots: download/qa-p32-split-{landing,workspace,visual,visual-cut,
  result,result-final,hindi,mobile,mobile-visual,mobile-cut,mobile-sheet,
  mobile-result,final-desktop}.png
- Next: PageGrid family round (reuses VisualStrip thumbnails + plan patterns).

---
Task ID: P3.3
Agent: main (Z.ai Code session — webDevReview-style round: baseline QA passed, advanced the next pending phase item)

Task: Ship the PageGrid family (PRD §8.1 "Rotate / Rearrange / Remove / Extract") — one shared interactive
page-grid with select/drag/undo-redo/zoom/virtualization, 4 preset-tuned tools on top of it.

Work Log:
- Baseline QA first (per review protocol): home/tools/tool pages 0 errors; rotate + merge golden
  paths re-run clean; 0 non-local network requests; mobile 360px no h-scroll → no bugs → advanced.
- Verified the risky pdf-lib APIs with a bun smoke script BEFORE building: copyPages with
  DUPLICATE indices returns independent copies ✓, rotation delta on copied pages ✓, blank pages
  with explicit size ✓ (re-ran after wiring to verify full rebuild: 12 pages all 270°).
- tools/pagegrid/model.ts — pure shared model: GridPage {uid, source, rotation}, serializeGrid/
  parseGridOption (compact [[source,rotation]] tuples), parseNumberListOption, and ALL ops pure:
  rotateIndices, deleteIndices, duplicateIndices (each right after itself), insertBlankAfter,
  moveEntry (drag), moveSelectionByOne (block move), odd/evenIndices, parseGridRange (strict,
  in-range only), gridStats. VIRTUALIZE_ABOVE = 150. Same module feeds panel AND worker.
- tools/pagegrid/worker.ts — ONE shared worker for all 4 tools: loads pdf-lib, resolves entries
  (whole grid, or extract's selection), copyPages in bulk, applies rotation deltas, inserts real
  blank pages sized from the first real page (A4 fallback), posts real per-page progress, naming
  per toolId (-rotated/-rearranged/-pages-removed/-extracted, _pageN for one-per-file), detail
  {files, pages}. Defensive empty-grid error (safety net behind the CTA gate).
- tools/pagegrid/use-grid-history.ts — undo/redo as a pure useReducer (100-deep snapshot stack);
  wrappers compute the next state through the SAME reducer so callers can serialize for options
  immediately. Rewritten after react-hooks/refs flagged ref-during-render in the first draft.
- tools/pagegrid/grid-surface.tsx — the surface: file header (name/size/pages/remove), toolbar
  (selection chip + range input + Select all/Clear; scope segmented All|Selected|Odd|Even —
  odd/even rotate-preset only; rotate L/R; duplicate/insert-blank/delete; remove-blanks w/
  detection progress (remove preset); move earlier/later; undo/redo; zoom slider 88-168 step 16),
  hint line, and the grid itself. Selection: click (single), ctrl+click (toggle), shift+click
  (range from anchor), Ctrl+A, Esc, Del/Backspace, arrow-key cell focus (roving tabindex).
  Virtualization above 150 pages: row windowing from scrollTop/viewportH/ResizeObserver, spacer
  div with computed height, translateY window (400 pages → ~30 mounted cells); drag disabled
  there with an honest amber hint + move buttons remain. All mutations flow through apply() →
  history.commit + onChange("grid"/"selected") + CTA-blocked sync — event-context only, zero
  setState-in-effect.
- tools/pagegrid/grid-cell.tsx — cell: aspect-ratio letterbox thumb with LIVE CSS rotation,
  lazy render via per-cell IntersectionObserver (300px rootMargin) + revoke on unmount, position
  badge with "from page N" provenance tooltip once reordered, amber rotation badge, selected
  check (zoom-in anim), per-cell rotate L/R + delete actions on selected cells, dnd grip
  (Pointer/Touch/Keyboard sensors) when fully mounted. Blank pages render as dashed emerald
  placeholder.
- tools/pagegrid/summary-panel.tsx — aside/mobile-sheet panel: live stats (pages out / removed /
  rotated / blanks / selected) parsed from the same serialized grid + keyboard cheat sheet.
- Surface registry concept: src/lib/tools/surfaces.tsx (TOOL_SURFACES, named wrapper components)
  + ToolSurfaceProps in panel-types.ts (setRunBlocked). ToolShell renders the surface in the
  MAIN column instead of FileList+DropZone when registered; CTA gating via runBlockedKey (amber
  TriangleAlert + reason text in the sticky bar; disabled on both desktop CTA and sheet CTA).
- Tool configs: rotate-pdf-pages REWRITTEN (empty schema, shared worker, preset features/FAQ,
  old per-file worker.ts deleted); rearrange/remove/extract NEW (extract carries the
  onePerPage schema switch). Registry: 3 new tools enabled. configs.ts/panels.tsx updated.
- i18n: +71 keys ×2 (grid.* section incl. fromPage) via python JSON round-trip (P2 lesson:
  never MultiEdit the catalogs); real Devanagari throughout.
- getPdfPageAspect() added to lib/pdf/thumbnails.ts (viewport-only, no render).
- eslint config: public/** added to ignores — the vendored pdf.js minified assets were throwing
  ~1500 pre-existing warnings/8 errors into `bun run lint` (they predate this round; src+tools
  were always clean).
- QA (agent-browser, fresh context, 0 page errors, 0 console errors, 0 non-local requests):
  rotate: 12-cell grid, thumbs lazy, select/check/actions, rotate-all → 12 amber badges + live
  img transform rotate(270deg), undo clears, run → result + summary; remove: range "2,5-7" → 4
  selected, delete → 8 cells, insert blank → renders, remove-blanks → "Removed 2 blank pages"
  toast + correct math (12-4-2+1=7), run → -pages-removed.pdf; extract: CTA blocked + hint with
  no selection, shift-click → 4 selected, run → "1 files, 4 pages" -extracted.pdf, Ctrl+A +
  one-per-file → 12 outputs + ZIP button; rearrange: pointer drag p1→p3 = [p2,p3,p1,p4,p5]
  PROVEN by "from page" labels, undo restores, move-earlier moves selection with the page;
  virtualization: 400-page file → 30 cells, scroll to 7000px → window at Page 181 + 20 lazy
  thumbs, range "200-202" + scope Selected → exactly 3 rotated, run → 400 pages; safety:
  delete-all → CTA disabled + amber warning; Hindi end-to-end (aria labels, blank-detect toast
  in Devanagari); mobile 360px no h-scroll + bottom sheet (stats + shortcuts + CTA); zoom
  slider 120→152 with cells growing; regressions: merge Hindi golden path + split landing +
  home + all-tools card navigation all clean; tsc + eslint fully clean; dev.log clean after
  compile (one transient Fast-Refresh reload during mid-edit states, resolved).

Stage Summary:
- Live tools: 6 (merge, split, rotate [REBASED on the grid], rearrange, remove, extract) — all
  mode D, on-device. The PRD §8.1 PageGrid family is COMPLETE: common actions (select
  click/shift/Ctrl+A/range, drag reorder, rotate per page or scope, delete, duplicate, insert
  blank, undo/redo, zoom), preset extras (odd/even scope, blank auto-detect, one-page-per-file),
  large-doc virtualization + lazy thumbnails, and the all-deleted Apply safety.
- Architecture: shared pure model + ONE worker + ONE surface + per-tool thin configs — the
  pattern for every future grid-based tool. Surface registry extends the config-driven system
  without breaking panels (merge/split untouched).
- Cell provenance labels ("Page 3, from page 1") double as UX polish and QA ground truth.
- Screenshots: download/qa-p33-*.png (13).
- Dev-server note repeated: the sandbox reaps plain background processes; the python double-fork
  daemon (see P3.2 entry) keeps `bun run dev` alive across tool calls.
- Next per the phase plan: Images to PDF (needs an image-handling DropZone path + jpeg/png
  embedding worker), then PDF→JPG/PNG, PDF→Text, Watermark, Page numbers, Crop, Doc info,
  Fill, View, Compress, Generate password, Scan, HEIC/WEBP — one per round. Split/merge
  deferred follow-ups unchanged (see section 6).

---
Task ID: P3.4
Agent: main (Z.ai Code session — webDevReview cron round: baseline QA passed, advanced the next pending phase item)

Task: Ship the Images↔PDF conversion pair (PRD §8.6): the ImageGrid family
(images-to-pdf + jpg/png/webp-to-pdf presets) and the PDF→images pair
(pdf-to-jpg + pdf-to-png), plus the shared infra those need (image-aware
thumbnails, accept-kind routing, output-kind chains). Mandatory styling pass
included.

Work Log:
- Baseline QA first (review protocol): home + rotate golden path + network
  filter (0 non-local) + mobile 375px no h-scroll + 0 console/page errors
  → stable → advanced. One transient finding: grid toolbar button click
  intercepted during async thumbnail layout shift (not reproducible in
  steady state; noted, not a bug).
- Infra (shared):
  - DropZone acceptKind now driven by tool.accepts (image → image/* sniff,
    pdf → %PDF- sniff); per-kind labels (tool.selectImageFiles/addMoreImages).
  - makeFileThumbnail (lib/files/thumbnail.ts): images → createImageBitmap
    downscale ≤160px; PDFs → existing queued render. Recent entries carry
    kind image/pdf correctly; home strip shows image thumbs (lazy-verified).
  - useThumbnail image fast path: image blobs are their own preview (object
    URL direct) — fixes FileCard for image inputs AND ResultView for image
    outputs (jpg/png pages render as thumbs, no pdf.js attempt).
  - ToolConfig.chainToolIds + ToolShell support: pdf-to-jpg/png chain to
    image-accepting tools only (images-to-pdf, webp/heic-to-pdf w/ Soon
    badge) — never hand a JPG to a PDF-only tool.
  - ToolSurfaceProps.addFiles: surfaces can embed their own add-more drop
    zone reusing the shell pipeline (limits, OPFS copy, recent entries).
  - Smart Drop Zone: image branch now hands off DIRECTLY to the enabled
    images-to-pdf tool (was "coming soon" toast).
  - getPdfPagePixelSize (viewport-only) for the live DPI preview panel.
- tools/imagegrid/ (NEW shared module):
  - model.ts — pure ops (rotate/delete/move/sortAz-by-name numeric-aware/
    reconcile-vs-files/serialize [[source,rotation] tuples]) feeding BOTH
    the surface and the worker (pagegrid pattern).
  - image-grid-surface.tsx — dnd-kit sortable card grid (Pointer/Touch/
    Keyboard), per-card rotate 90° L/R with LIVE CSS rotation + amber badge,
    move buttons, remove, A→Z sort (the IMG_101/IMG_100 fixer), stats chip
    row (count/size/rotated), compact add-more DropZone, all-removed safety
    (setRunBlocked + amber hint; CTA disabled), hover lift + thumbnail zoom
    (rotate+scale via CSS var), grip always visible on touch (max-lg).
  - worker.ts — magic-byte sniff (jpeg/png/webp/gif/heic), unrotated JPG/PNG
    embed ORIGINAL bytes (no re-compression), PNG dims via IHDR parse (no
    decode), rotated/other formats → createImageBitmap → OffscreenCanvas
    (rotated) → JPEG 0.92 (photos) / PNG (alpha-capable) → embed; page
    assembly: a4/letter/fit + auto/portrait/landscape + margins none/small/
    big + one/two-up (2-col grid) + white/soft/dark background + page
    numbers "n / total" (Helvetica 9pt gray); honest per-file error codes
    (unsupported/decode w/ file name detail — client-side only).
- tools/pdf-to-images/ (NEW shared worker for pdf-to-jpg + pdf-to-png):
  - pdf.js runs INSIDE the tool worker: pre-import /pdfjs/pdf.worker.min.mjs
    sets globalThis.pdfjsWorker → pdf.js detects it (#Ts) → fake-worker mode
    on our own thread (no nested worker, no window access). CRITICAL FIX
    found by QA: pdf.js's default CMap/StandardFont factories resolve URLs
    against document.baseURI (absent in workers → "document is not defined")
    — fixed with a one-property globalThis.document = { baseURI:
    self.location.href } shim, verified by a raw-worker probe BEFORE the
    fix failed identically and after it rendered 1240×1754 JPEGs.
  - Transparent PNG: pdf.js beginDrawing ALWAYS fills background||"#ffffff"
    → pass render background:"rgba(0,0,0,0)" when transparent (verified
    alpha (0,255) on a no-background circle PDF).
  - Sequential page render, one canvas at a time (memory-safe), real
    per-page progress, DPI 72/150/300/600 (scale=dpi/72), page range via
    parsePageSpec, JPG quality 40-100, naming: single page → base.ext,
    multi → base_pageN.ext, ZIP via ResultView.
  - panel.tsx — live "Page 1 at N DPI → W×H px" preview (viewport math
    only, no render) + note that all pages keep this sharpness.
- Tool configs: images-to-pdf (full 6-option schema), jpg/png/webp-to-pdf
  (thin presets, tuned copy), pdf-to-jpg (dpi/pages/quality), pdf-to-png
  (dpi/pages/transparent). Registry: 6 tools flipped enabled:true →
  13 live. configs.ts/panels.tsx/surfaces.tsx registrations.
- i18n: +30 keys ×2 locales (tool.images.* errors, igrid.* surface,
  pdfimg.* panel) via python JSON round-trip; real Devanagari throughout.
- QA (agent-browser, fresh contexts, 0 page errors, 0 console errors,
  0 non-local requests across all runs):
  images-to-pdf: 3 mixed images (jpg+png-alpha+webp) → cards w/ thumbs+dims,
  rotate 180° (badge + live transform), sort A→Z, move buttons, pageNumbers
  on → run → "1 files, 3 pages" → pypdf-inspected output: correct order,
  alpha PNG embedded RGBA, WEBP transcoded PNG, photo ORIGINAL JPEG bytes,
  "1 / 3" texts, page sizes match orientation logic (square→portrait, wide
  →landscape); two-up + dark bg: 4 images → 2 landscape pages × 2 images
  verified; jpg-to-pdf alias golden path + add-more inside workspace (2→3
  cards) + all-removed → CTA disabled + amber reason; smart-drop image →
  direct handoff (file lands in workspace); pdf-to-jpg: preview panel
  "1240 × 1754 px" at 150 DPI, range "1-3" → 3 JPGs 21-22 KB + ZIP,
  downloaded page1 = 1240×1754 RGB; pdf-to-png: single page "5" →
  split-test.png (no suffix), transparent → alpha (0,255) verified;
  12-page full run "12 files"; CANCEL: 600 DPI × 400-page file at 6% →
  Cancel → workspace + toast (deferred item closed); Hindi end-to-end
  (chip "2 तस्वीरें", sort "A→Z क्रम", hint, result "1 फ़ाइलें, 2 पेज");
  mobile 375px no h-scroll + bottom sheet w/ Hindi options; regressions:
  rotate grid (12 cells), split + merge landings, all-tools page (6 new
  tools listed), home; eslint + tsc clean; dev.log clean.
- Styling pass (mandatory): image cards hover lift + shadow + thumbnail
  zoom (rotate+scale composed via CSS var), grip visible on touch, position
  + rotation badges w/ shadow; DropZone drag-over ring-4 glow + scale +
  animated icon; ResultView output cards hover elevation; recent-strip
  lazy-load verified.
- Test assets added to download/: qa-img-photo.jpg / qa-img-alpha.png /
  qa-img-stripes.webp / qa-img-portrait.jpg (PIL-generated), qa-transparent.pdf
  (pdf-lib circle-only), qa-p34-*.png screenshots (16).

Stage Summary:
- Live tools: 13 — merge, split, rotate, rearrange, remove, extract,
  images-to-pdf, jpg-to-pdf, png-to-pdf, webp-to-pdf, pdf-to-jpg,
  pdf-to-png. PRD §8.6 image conversion pair COMPLETE for browser-decodable
  formats (SVG/TIFF deferred — needs WASM decoders; HEIC works where the
  browser can decode, honest error otherwise).
- Architecture win: pdf.js-in-tool-worker recipe (fake-worker mode +
  document.baseURI shim + transparent-background render param) is the
  foundation for OCR (Phase 9) and every future rasterizing tool.
- ImageGrid = the second reusable surface family (after PageGrid); future
  image-input tools (scan-to-pdf, heic-to-pdf) reuse it via preset configs.
- Cancel-mid-flight finally PROVEN (the P2-era deferred risk item).
- Next per the phase plan: PDF→Text (§8.6), then Watermark, Page numbers,
  Crop, Doc info, Fill, View, Compress, Generate password, Scan, HEIC/WEBP
  — one per round. Merge "images also allowed" is now unblocked (reuse the
  imagegrid embed engine).
