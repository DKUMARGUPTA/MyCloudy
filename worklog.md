# DocoPDF — Shared Worklog (Handover Document)

> Single source of truth for cross-agent continuity. Every agent MUST read this file fully before
> starting work, and MUST append a section after finishing a task (template at the bottom).
> The product PRD governs WHAT to build: `/home/z/my-project/upload/DocoPDF-PRD-v2.docx`

## 1. Current project status (assessment)

- **Phase: 3 IN PROGRESS (P3.10)** — FILL OUT PDF FORMS shipped.
  Baseline was healthy (merge golden path green, 0 console errors), so
  this round delivered the next PRD §8.2 item: **Fill out PDF forms**
  (id `fill-out-pdf`, edit, D, P1) — pdf-lib AcroForm scan (kinds,
  labels, flags, options, current values, widget rects with /Rotate-aware
  display mapping), live page preview with % -positioned highlight boxes
  that click-to-focus their field, a reading-order field form (natural
  Tab order; text/multiline/maxLength/checkbox/radio/dropdown/optionlist
  + a native date picker for date-ish fields), a localStorage auto-fill
  profile (name/email/phone/organization/address, label-exact Latin+
  Hindi matching), required/read-only/filled states, and a flatten-after-
  fill switch. Worker uses "f:<fileId>::<name>" epoch keys (answers can
  never leak into a replaced file), truncates to maxLength, pre-renders
  non-WinAnsi answers with the embedded Devanagari subset before
  save() would throw, and falls back to NeedAppearances. Live tools now:
  **20**, all 100% on-device. Next per the plan: View, Compress,
  Generate password, Scan to PDF, HEIC/WEBP — one per round.
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
- Completed (P3.7): Page numbers + Header & footer tools on the new
  `tools/stamp-common/` shared architecture — ONE spec interface
  (resolve/targets/marks/runBlocked/chips) drives BOTH the live preview
  canvas (StampSurface, canvas-measured) and the pdf-lib workers
  (font-measured), so what you see is what you get. Includes the
  Devanagari embedding pipeline (public/fonts TTF + @pdf-lib/fontkit +
  regenerator-runtime, subset:true), 8 number formats (1 / Page 1 / 1 of N
  / Page 1 of N / i / I / a / A), start number, 9-grid + margin, full
  layout targeting (all/odd/even/skipFirst/range), Hindi digits; HF has 6
  slots (L/C/R × header/footer) with {page} {pages} {date} {filename}
  {title} variables (case-insensitive, unknown braces left visible), date
  shape dmy/mdy/ymd, non-ASCII text auto-upgrades to the embedded
  Devanagari font. Verified end-to-end by agent-browser + structural PDF
  checks (see the P3.7 entry at the bottom).
- Completed (P3.8): Crop PDF tool (tools/crop-pdf/: crop-options.ts pure
  module + crop-surface.tsx drag surface + panel.tsx + worker.ts + config),
  with the display→user-space geometry (pdf.js viewport transforms,
  /Rotate-aware) locked by scripts/smoke-crop.ts BEFORE the UI was built,
  and the shared preview chrome extracted to tools/stamp-common/
  preview-parts.tsx (PreviewFileHeader / PreviewPageStrip /
  PreviewZoomControl) now reused by stamp + crop surfaces. Verified
  end-to-end by agent-browser including a rotated-page PDF (see the P3.8
  entry at the bottom).

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

1. **NEXT: Phase 3 continues — View, then Compress (device), Generate
   password, Scan to PDF, HEIC/WEBP** — one per round (PRD §8.2/§8.4).
   **Engine insight for future form work (P3.10):** pdf-lib doc.save()
   regenerates dirty field appearances with WinAnsi Helvetica and THROWS
   for non-Latin values — the Devanagari pre-render + NeedAppearances
   fallback pattern lives in tools/fill-out-pdf/worker.ts; reuse it for
   anything that touches AcroForm values.
   Fill-tool follow-ups (deferred, noted): dropdown/optionlist values
   with non-WinAnsi OPTION strings fall back to NeedAppearances (values
   always stored; rendering is reader-side) — could embed Devanagari for
   Ch-field appearances later; no per-field font picker in the fill UI
   (by design).
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

---
Task ID: P3.5
Agent: main (Z.ai Code session — webDevReview cron round: fixed broken build, finished interrupted features, shipped PDF→Text)

Task: 1) Recover the 500-on-/ broken build (missing @/lib/storage/local-snapshot
module from an interrupted prior round); 2) QA every in-flight feature that was
left half-shipped; 3) continue the phase plan with PDF→Text (PRD §8.6);
4) mandatory styling detail pass; 5) this worklog record.

Work Log:
- Diagnosis: dev.log showed GET / 500 — Turbopack module-not-found for
  `@/lib/storage/local-snapshot`, imported by cookie-banner.tsx,
  request-tool-modal.tsx and lib/tools/favorites.ts (all already committed).
  tsc confirmed exactly 3 errors, all the same missing module — nothing else
  was broken. The prior round had been cut off right before creating it.
- FIX: created src/lib/storage/local-snapshot.ts — createLocalSnapshot<T>(
  key, parse, empty) returns a memoized () => T getter for useSyncExternalStore:
  caches on the RAW localStorage string, so the parsed value keeps a stable
  reference until the raw string actually changes (the useSyncExternalStore
  contract). SSR-safe (returns empty pre-mount), storage-failure-safe
  (try/catch → treats as absent). 63 lines incl. docs.
- QA of the recovered in-flight features (agent-browser, fresh contexts,
  0 page errors, 0 console errors throughout):
  - Cookie banner (PRD §5.3): renders on fresh context (dialog "Your choice,
    your data"), Customize → analytics switch + save → `docopdf-consent`
    persisted + banner hidden; footer "Privacy settings" re-opens it directly
    in expanded mode.
  - Request-a-tool (PRD §6.2/§9): search nonsense → empty state → "Request a
    tool" modal; submit → `docopdf-tool-requests` persisted; queued list w/
    Remove works.
  - Favorites + Last used (PRD §6.2): star on a tool card →
    `docopdf-favorites` + "Favorites · 1" tab appears and filters to exactly
    that tool; ran merge (2 files) → `docopdf-last-used` = ["merge-pdf"] +
    "Last used" tab appears. Hindi tab labels verified (पसंदीदा · 1,
    हाल में इस्तेमाल). Mobile 375px no h-scroll.
- NEW TOOL: PDF to Text (tools/pdf-to-txt/):
  - worker.ts — pdf.js inside the tool worker (fake-worker mode +
    document.baseURI shim, same proven recipe as pdf-to-images). Text
    reconstruction: pieces → y-clustered visual lines (tolerance 0.5× font
    height) → x-sorted with quarter-font gap spaces → Flow mode joins lines
    into paragraphs (baseline gap > 1.7× line height = paragraph break;
    trailing hyphen before a lowercase letter merges: "demon-stration" →
    "demonstration") / Lines mode keeps visual lines verbatim. Page range via
    parsePageSpec; optional ───── Page N ───── markers when > 1 page; per-file
    UTF-8 .txt; honest tool.errorNoText when a file yields zero selectable
    text (scans — OCR is a later phase, PRD copy).
  - config.ts — layout select (flow/lines) + pages + pageMarks switch;
    chainToolIds txt-to-pdf/markdown-to-pdf; features/FAQ in en+hi.
  - panel.tsx — LIVE page-1 text preview (getPdfPageTextPreview in
    lib/pdf/thumbnails.ts, doc-cached, text-content only): monospace pre with
    gradient fade + truncation note, word-count chip, amber TriangleAlert
    block when no selectable text (scan hint), footer privacy line. Stale
    preview guarded by file-identity comparison (lint-safe, no setState-in-
    effect).
- Infra (shared):
  - src/lib/files/text-thumbnail.ts (NEW) — renderTextThumbnail draws the
    first ~9 non-empty lines onto a 3:4 canvas (paper-white bg, ink-gray
    monospace, measured ellipsis) → .txt outputs get a REAL document
    thumbnail. Wired into makeFileThumbnail (text/ branch) AND useThumbnail
    (fast path before the pdf.js attempt — previously text blobs fell to the
    ⚠ error icon).
  - config-types.ts outputKind union += "text".
  - registry.ts pdf-to-txt enabled: true; configs.ts + panels.tsx registered.
  - result-view.tsx rename regex now strips .txt too.
  - i18n: pdftxt.* (7 keys) + tool.errorNoText, en + hi (python JSON
    round-trip, real Devanagari).
- QA of the new tool (fresh contexts, 0 errors):
  - reportlab 2-page test PDF: Flow output = clean paragraphs, hyphenation
    rejoined, numbers/symbols intact, page 2 included ("1 files, 2 pages"
    summary); page marks ON → ───── Page 1/2 ───── separators present; Lines
    mode → visual line breaks verbatim (demon-/stration kept).
  - Image-only "scan" PDF: panel shows amber "No selectable text on page 1"
    BEFORE running; run → error toast (errorNoText) → back to workspace.
  - Result view: .txt output card renders the canvas text thumbnail
    (img loaded, 200px); rename preset strips .txt.
  - Hindi end-to-end: पेज 1 टेक्स्ट प्रीव्यू panel, लेआउट combobox
    (Flow — साफ़ पैराग्राफ़), पेज-ब्रेक चिह्नित करें switch, scan copy.
  - Mobile 375px: no h-scroll; consent banner + bottom CTA co-exist.
  - Regressions: home hero, all-tools page (PDF to Text listed w/o Soon
    chip), merge landing — all clean; tsc + eslint fully clean; dev.log
    clean (only expected Fast-Refresh reloads from the i18n edits).
- Styling pass (mandatory): text thumbnails as real visual previews;
  preview panel chrome (header row w/ word-count chip, gradient-fade
  monospace body, scan-warning block, privacy footer); page-mark separator
  design; existing detail polish untouched.
- Test assets: download/qa-text-sample.pdf (reportlab, 2 pages, hyphenation
  case), download/qa-scan-sample.pdf (PIL image-only), qa-p35-*.png
  screenshots (3).

Stage Summary:
- Build RECOVERED: the only blocker was one missing file; all three half-
  shipped features (consent banner, request-a-tool, favorites/last-used)
  verified working end-to-end, both locales.
- Live tools: 14 — merge, split, rotate, rearrange, remove, extract,
  images-to-pdf, jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt.
  PRD §8.6 text extraction COMPLETE for selectable text (OCR deferred to
  Phase 9 as planned; honest error meanwhile).
- Text-thumbnail renderer benefits every future text-output tool
  (PDF→Text/Markdown/HTML, txt-to-pdf previews of inputs are image-side only).
- Next per the phase plan: Watermark (§8.3), then Page numbers, Crop, Doc
  info, Fill, View, Compress, Generate password, Scan, HEIC/WEBP — one per
  round. Merge "images also allowed" still unblocked (reuse imagegrid engine).
- Deferred notes: switch toggle in the options panel sits under the sticky
  bottom CTA bar on short desktop viewports — scrollintoview was needed in
  QA (pre-existing layout trait, not a regression from this round; consider
  scroll-margin-bottom on option rows if it resurfaces).
- Suggested commit: "fix: create missing local-snapshot module (500 on /);
  feat: PDF to Text tool with flow/lines layouts, page marks, live preview,
  scan detection; text thumbnails for .txt outputs"

---
Task ID: P3.6
Agent: main (Z.ai Code session — webDevReview cron round: recovered broken build, shipped Watermark)

Task: 1) Baseline QA found `/` 500 — the P3.5 `local-snapshot.ts` fix file
had been lost (dependents committed, module never committed); recreate +
re-verify. 2) Continue the phase plan with Add Watermark (PRD §8.2):
text/logo stamp, font/size/color/opacity/rotation, 9-grid position, tile,
behind-content, layout all/odd/even/range/first-page-excluded, live canvas
preview + thumbnails strip. 3) Mandatory styling detail pass. 4) This log.

Work Log:
- Diagnosis: dev.log GET / 500 — Turbopack module-not-found for
  `@/lib/storage/local-snapshot`; `ls src/lib/storage/` confirmed the file
  absent while cookie-banner/request-tool-modal/favorites (committed) still
  imported it. git fsck dangling commit = duplicate of P3.4, no copy ever
  committed. Recreated the module from the P3.5 spec: createLocalSnapshot
  <T>(key, parse, empty) memoizes on the RAW localStorage string (stable
  references = the useSyncExternalStore contract), SSR-safe, storage- and
  parse-failure-safe. `/` → 200 immediately.
- Baseline QA after recovery (agent-browser): home renders, 0 non-local
  requests, rotate golden path upload→run→result with 0 page errors,
  all-tools 97 cards; tsc + eslint clean. NOTE: `agent-browser upload` went
  silently inert this round (files set, change handler never fired) — the
  reliable recipe is a programmatic DataTransfer + change event via eval
  (base64-embedded for real test files). Also learned: `[m` in tool output
  renders as an ANSI reset and SWALLOWS those two chars in terminal
  displays — configs.ts "looked" corrupted but was byte-perfect.
- Smoke test BEFORE building (P3.3 lesson, scripts/smoke-watermark.ts):
  drawText color/opacity/rotate ✓, widthOfTextAtSize ✓, Contents reorder
  (my stream → index 0) ✓, embedPng + drawImage opacity/rotate ✓, WinAnsi
  throws on Devanagari ✓, save/reload keeps order ✓ (verified by zlib-
  decoding each stream of the saved file: [watermark, q, original, Q]).
- NEW TOOL: Add watermark (tools/add-watermark/):
  - wm-options.ts — ONE shared pure module for panel + surface + worker:
    option ids, defaults, resolveWmOptions coercion/clamping, 6 standard
    fonts + CSS mapping (canvas preview mirrors the pdf font), 8 color
    presets, parseHexColor, 9-grid positionCenter (PDF y-up math),
    rotatedStartPoint (rotate-around-box-center solved by
    start = center − R·(w/2, h/2)), tileSteps, targetIndices
    (all/odd/even/skipFirst/range via parsePageSpec).
  - logo-store.ts — in-memory logo File store + custom event (panel pushes,
    surface subscribes); the logo NEVER touches OPFS/IndexedDB/network.
  - worker.ts — pdf-lib engine: embeds standard font (WinAnsi checked
    UPFRONT → honest tool.errorWatermarkChars for Devanagari), stamps text
    or logo per page (positioned 9-grid with margin, or tiled grid with
    spacing), behind mode = draw then moveDrawStreamFirst (Contents array
    reorder — the verified technique), logo via PNG/JPEG embed or
    createImageBitmap→OffscreenCanvas→PNG re-encode for webp/gif,
    real per-page progress, `-watermarked.pdf` naming, detail {files, pages}.
  - panel.tsx — the control station: Text|Logo segmented tabs, text input
    with 120-char counter, font select, size slider with value chip, 8
    swatches + custom hex input (validated, snaps back on blur), opacity
    slider, rotation quick buttons (−90/−45/0/45/90) + slider, 3×3 position
    grid with dot indicators (disabled while tiling) + edge-distance slider,
    tile switch + spacing slider, behind switch, layout select + range
    input, amber hint blocks for missing text/logo.
  - wm-surface.tsx — main-column LIVE PREVIEW: renders the selected page
    (pdf.js thumb 560px) then paints the watermark with the SAME math as
    the worker (what you see is what you get), page strip (12-window,
    72px thumbs, selected ring, marked-page dots + page numbers),
    file header chip, marked-count chip + over/behind chip + invalid-range
    chip, CTA gating via setRunBlocked (no text / no logo / invalid range),
    loading skeleton + identity-scoped failure state.
  - config.ts — empty schema (split pattern), maxFiles 1 (PRD: single
    PDF), collectAssets() feeds the logo, chain to pdf-to-jpg/png/merge;
    features + FAQ en/hi (incl. honest Hindi-font answer).
- Infra (additive, 3 small edits): protocol WorkerRunRequest.assets?:
  File[]; pool.run(..., assets?); config-types ToolConfig.collectAssets?;
  tool-shell startRun collects assets (with the React-Compiler-friendly
  destructured dep). globals.css += .bg-checker (transparency
  checkerboard for the logo preview).
- Registrations: registry add-watermark enabled:true; configs.ts, panels.tsx,
  surfaces.tsx entries. i18n: wm.* 66 keys + 5 tool.errorWatermark* codes,
  en + real Devanagari hi (python merge, scripts/i18n-watermark.py).
- QA (agent-browser + VLM visual checks + structural PDF checks, fresh
  contexts, 0 page errors, 0 console errors, 0 real non-local requests):
  landing state; upload → live preview shows red diagonal CONFIDENTIAL
  centered (VLM); 9-grid top-right + rotation 0° (VLM); tile → 12-15
  repeated marks (VLM); behind run → result thumbnail tiled diagonal
  (VLM) + DOWNLOADED OUTPUT structurally verified: page-1 /Contents =
  [watermark(906B, gs+rg ops, red 0.8627/0.149 = #DC2626 exact), q,
  original, Q] → watermark genuinely draws BEHIND; both pages marked;
  logo mode: upload → centered circular logo preview (VLM) + chip +
  30% scale; logo run → output contains image XObject; CTA gating:
  cleared text → disabled + amber "Type the watermark text first",
  invalid range "abc" → disabled + amber chip, fixed to "2" →
  "1 of 2 pages marked" → run "1 files, 1 pages"; Devanagari "गोपनीय" →
  honest error toast + back to workspace (no broken file); Hindi UI end-
  to-end (panel, chips, preview, strip aria); mobile 375px no h-scroll +
  sticky CTA + bottom sheet with full panel; regressions after protocol/
  pool changes: rotate golden path ✓, all-tools lists the tool ✓; tsc +
  eslint fully clean; dev.log clean.
- Styling pass (mandatory): swatch grid with selected ring + scale,
  3×3 position picker with active dot, slider value chips (tabular-nums),
  rotation quick-buttons, mode segmented tabs, checkerboard logo preview,
  page strip with selected ring + marked dots, preview header chips
  (marked-count / over-behind / invalid-range), amber warning blocks,
  .bg-checker utility. VLM final review: "high level of visual polish…
  no misalignments or cramped elements".

Stage Summary:
- Build RECOVERED again (same failure mode as P3.5 — file lost between
  write and commit; this time it IS committed with the round).
- Live tools: 14 — merge, split, rotate, rearrange, remove, extract,
  images/jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt,
  add-watermark. PRD §8.2 Watermark COMPLETE (text + logo + tiling +
  behind + layout + live preview); Devanagari watermark text honestly
  deferred (needs TTF embedding).
- Architecture wins: (1) the run-ASSET channel (collectAssets → protocol
  assets) lets any tool ship side-files to its worker without touching
  the storage layer; (2) the z-order Contents-reorder technique unlocks
  every future "under content" feature (page numbers under text etc.);
  (3) shared placement math between preview canvas and worker = the
  pattern for the upcoming Page numbers / Header-footer round.
- Screenshots: download/qa-p36-*.png (9) + qa-p36-wm-output.pdf /
  qa-p36-wm-logo-output.pdf (structurally verified outputs).
- Suggested commit: "fix: recreate lost local-snapshot module (500 on /);
  feat: Add watermark — text/logo stamps, 9-grid + tile + behind-content
  (Contents reorder), live canvas preview + page strip, run-asset channel;
  i18n wm.* en/hi"

---
Task ID: P3.7
Agent: main (Z.ai Code session — webDevReview cron round: Page numbers + Header & footer + Devanagari font embedding)

Task: 1) Baseline QA (server healthy, watermark golden path re-verified
green). 2) Ship the next two PRD §8.2 items: Add page numbers + Header &
footer, both with live canvas previews. 3) Mandatory styling detail pass.
4) This log.

Work Log:
- Baseline: dev.log clean, `/` 200; watermark upload → preview → run →
  result re-verified (P3.6 regression green) using the P3.6 recipe
  (base64-embedded PDF + programmatic DataTransfer + change event).
- PRE-BUILD SMOKE TEST (P3.3 lesson) scripts/smoke-pagenumbers.ts:
  @pdf-lib/fontkit@1.1.1 pinned + regenerator-runtime@0.14.1 (bun throws
  "regeneratorRuntime is not defined" without it); embedFont(ttf,
  {subset:true}) → widthOfTextAtSize works for "०१२३४५६७८९", "पृष्ठ" and
  mixed "Page ५ of १०"; save/reload round-trip fine; subset output 6.7KB
  = 0.03× the 243KB source. Noto Sans Devanagari TTF downloaded once
  (build-time fetch, OFL) → public/fonts/ + license file (no runtime CDN).
- NEW shared architecture tools/stamp-common/: layout.ts (StampMark,
  StampPageContext, StampToolSpec {resolve/targets/marks/runBlocked/
  chips}, toRoman/toAlpha/toHindiDigits/formatPageNumber,
  formatStampDate dmy/mdy/ymd, resolveStampVariables, needsUnicodeFont);
  worker-lib.ts (loadStampFonts: 6 standard + devanagari subset embed,
  drawStampMark center-anchored with the 0.25em baseline, safeBaseName);
  stamp-surface.tsx (ONE generic live-preview surface for both tools:
  pdf.js base render + marks painted with the SAME math the workers use,
  canvas measurer via cssFontFor + --font-noto-devanagari for Devanagari,
  page strip + marked dots, chips, CTA gating). getPdfMetadataTitle()
  added to lib/pdf/thumbnails.ts for the {title} variable preview.
- NEW TOOL Add page numbers (tools/add-page-numbers/): pn-options.ts
  spec (8 formats, start, hindiDigits, font/size/color/opacity, 9-grid +
  margin, layout all/odd/even/skipFirst/range), worker.ts (spec.marks +
  drawStampMark per target, `-numbered.pdf`), panel.tsx (format select
  with live sample chip, start-number input with custom ▲▼ stepper,
  Hindi-digits switch with disabled state on roman/alpha formats + emerald
  "०१२३४५६७८९ embedded" pill, font select disabled+hint when Hindi forced,
  swatches + hex input, 9-grid picker with position label, margin slider,
  layout selector), config.ts (chain to add-header-footer/jpg/png/merge;
  6 features + 3 FAQ en/hi incl. honest "of N counts total pages").
- NEW TOOL Header & footer (tools/add-header-footer/): hf-options.ts
  spec (6 slots L/C/R × header/footer, shared font/size/color/opacity,
  margin, dateFormat, layout; {page}/{pages}/{date}/{filename}/{title}
  case-insensitive, unknown braces left visible; needsUnicodeFont →
  mark auto-upgrades to the embedded devanagari font incl. {filename}/
  {title} resolution), worker.ts (`-header-footer.pdf`), panel.tsx
  (variables legend with mono {token} chips, 6 labeled slot inputs with
  placeholders, date-shape select, amber empty-state gating), config.ts
  (chain to add-page-numbers; Hindi-header FAQ).
- BUG FOUND BY QA + FIXED: dev Turbopack builds module workers from
  blob: URLs → fetch("/fonts/…") inside the worker throws "Failed to
  parse URL from …" (opaque base). Diagnosed via a temporary DBG error
  detail routed through the toast. Fix in devaFontUrl(): resolve against
  self.location.href when http(s), else recover the origin from the
  blob: URL itself, else fall back to the relative path (prod workers
  are http-served). Verified: Hindi runs now succeed.
- REGISTRATION: registry add-page-numbers + add-header-footer
  enabled:true; configs.ts, panels.tsx, surfaces.tsx entries
  (StampSurface wrappers with PN_SPEC/HF_SPEC). i18n: pn.* 27 + hf.* 26
  keys + tool.errorPageNoPages/errorPageFont, en + real Devanagari hi
  (scripts/i18n-pagenumbers.py merge).
- STYLING PASS (mandatory): preview zoom control 1×/1.5×/2× (segmented,
  aria-pressed, ZoomIn icon, canvas px-scaled + shrink-0 + internal
  scroll container with scrollbar-thin); sample chip; start-number
  stepper; emerald Hindi-embedded pill; mono variable chips; position
  label under the 9-grid; amber gating blocks; header/footer on-chips.
  LAYOUT BUG FOUND + FIXED: zoomed canvas (792px) blew up the mobile grid
  track (auto max-content) → tool-shell workspace grid changed to
  `grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]` + zoom container
  max-w-full overflow-x-auto → 375px now scrolls INSIDE the preview,
  zero page-level h-scroll (verified by measuring every wide element).
- QA (agent-browser, fresh contexts, 0 page errors, 0 console errors,
  dev.log clean): PN landing + upload + live preview (format chip "Page
  1 of 12" + canvas pixel-verified stamp at bottom-right; 3×-zoomed crop
  VLM-read "Page 1 of 12"); skip-first → "11 of 12 pages marked" + page
  strip dots; RUN → RESULT; DOWNLOADED OUTPUT structurally verified:
  11 stamp streams = pages 2-12 with EXACT sequence "Page 1 of 12" →
  "Page 11 of 12" at Tm(497.33, 38.75) = margin 36 + 0.25×11 baseline
  math, page 1 untouched; Hindi digits RUN → output has
  NotoSansDevanagari-Regular-4824 subset (FontFile2 + Type0) + 12
  streams with GID <0001> = १; HF chained from the PN RESULT (what-next
  chain works); Hindi text "गोपनीय दस्तावेज़" run → RESULT + output
  verified (11+1 stamp streams, embedded subset font); Latin variables
  run → output texts "my report" ({filename} kept the space), "1 of
  12"…"12 of 12" ({page}/{pages}), "06/10/2026" ({date} dmy); Hindi UI
  end-to-end (पेज नंबर लगाएँ, ऐसा दिखेगा, chips); mobile 375px zoom 2×
  no page h-scroll + sticky CTA (VLM: "no overlapping or cramped UI");
  regressions: all-tools lists both new tools (97 cards), rotate golden
  path ✓, watermark golden path ✓; eslint + tsc fully clean.

Stage Summary:
- Live tools: 16 — merge, split, rotate, rearrange, remove, extract,
  images/jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt,
  add-watermark, add-page-numbers, add-header-footer. PRD §8.2 Page
  numbers + Header & footer COMPLETE (incl. Hindi digits via embedded
  font — the PRD's "Hindi digits optional" is now real, not deferred).
- Architecture wins: (1) the StampToolSpec interface = one shared
  live-preview surface + worker mark computation for any future
  "computed text on pages" tool; (2) the Devanagari embedding pipeline
  (public/fonts TTF + fontkit + subset) unblocks Hindi text in
  watermark and any text-drawing tool; (3) the blob-worker fetch fix
  documents how to fetch same-origin static assets from workers.
- Screenshots: download/qa-p37-*.png (workspace, zoom, hindi, mobile ×2,
  smoke pdf) + qa-p37-pn-output.pdf, qa-p37-pn-hindi-output.pdf,
  qa-p37-hf-hindi-output.pdf, qa-p37-hf-variables-output.pdf
  (all structurally verified outputs).
- Suggested commit: "feat: Add page numbers + Header & footer — 8 number
  formats, {page}/{pages}/{date}/{filename}/{title} variables, Hindi
  digits + Hindi text via embedded subset Devanagari font (blob-worker
  fetch fix), shared StampToolSpec preview architecture, preview zoom
  1×/1.5×/2×, mobile grid containment fix; i18n pn.*+hf.* en/hi"

---
Task ID: P3.8
Agent: main (Z.ai Code session — webDevReview cron round: Crop PDF + shared preview chrome)

Task: 1) Baseline QA (server healthy, page-numbers golden path re-verified
green, 0 console/page errors). 2) Ship the next PRD §8.2 item: Crop PDF —
visual crop box drag + numeric margins + apply to all/selected + auto-detect
+ before/after. 3) Mandatory styling detail pass. 4) This log.

Work Log:
- Baseline: dev.log clean, `/` 200; add-page-numbers upload → preview →
  run → "Your file is ready!" re-verified (P3.7 regression green).
- PRE-BUILD SMOKE TEST (P3.3 lesson) scripts/smoke-crop.ts: pdf-lib
  1.17.1 getCropBox() (MediaBox fallback verified), setCropBox save→load
  round trip with /Rotate intact, the display→user mapping for
  0/90/180/270 (incl. negative -90) against worked examples, per-page
  clamping (over-sized margins → 18pt min box), compounding from an
  existing CropBox, non-zero view origins. FIRST RUN CAUGHT A REAL BUG:
  y-up conversion was inverted in fitCropRect (height 0) — fixed, then
  11/11 PASS. Fixture download/qa-p38-smoke.pdf (612×792 framed page)
  + qa-p38-rotated.pdf (2 pages, page 2 /Rotate 90) written.
- GEOMETRY MODEL (tools/crop-pdf/crop-options.ts): crop = 4 margins in
  display-space points (the pdf.js orientation, rotation applied) — the
  SAME semantic for drag overlay, panel inputs and worker. Worker maps
  margins → user-space setCropBox per page via the page's own view box
  (getCropBox with MediaBox fallback) + /Rotate (mapping derived from
  pdf.js getViewport transforms, see displayToUser). MIN_CROP_PT=18,
  over-size margins clamp per page; sameBox() skips no-op pages so
  untargeted pages never grow a /CropBox entry.
- NEW TOOL Crop PDF (tools/crop-pdf/): crop-surface.tsx (pdf.js base
  render + overlay: 8 pointer handles + move, box-shadow dim outside,
  rule-of-thirds guides, live W×H chip while dragging, keyboard nudge
  arrows/Shift=10pt, Escape cancels; BEFORE/AFTER segmented view — after
  draws exactly the cropped region (canvas 306×398 == 433×563pt ×
  scale, pixel-exact); AUTO-DETECT button scans the rendered bitmap for
  content edges (non-white or semi-transparent px) + 6pt padding with
  done/empty flash chips; zoom 1×/1.5×/2× with internal-scroll
  containment; chips: cropped size (unit-aware) + marked pages; page
  strip with target dots), panel.tsx (unit segmented pt/mm/in, margins
  arranged around a mini-page diagram — MarginField keeps typing-safe
  local drafts and the group REMOUNTS via key on external change (drag/
  auto-detect/unit switch), reset, page targeting select + range),
  worker.ts (setCropBox per target, progress per page, `-cropped.pdf`),
  config.ts (chain to pdf-to-jpg/png/watermark/merge; 6 features + 3 FAQ
  en/hi incl. honest "content stays in the file" CropBox answer).
- SHARED PREVIEW CHROME extracted tools/stamp-common/preview-parts.tsx:
  PreviewFileHeader + PreviewPageStrip (12-window strip, target dots,
  URL lifecycle) + PreviewZoomControl (generic <T extends number>) —
  stamp-surface.tsx refactored to use them (~140 lines removed);
  page-numbers regression re-verified green after the refactor (upload →
  zoom 2× (792px) → strip switch → run → result).
- BUGS FOUND BY QA + FIXED: (1) canvas was missing max-h-[62vh]
  max-w-full → mobile 375px clipped the page (435px canvas > 343px
  available) — fixed with the stamp classes + the overlay now positions
  itself on a MEASURED canvas box (rAF after paint) so max-height
  clamping can never misalign the crop overlay (overlay:ALIGNED verified
  at 309px); (2) setPointerCapture wrapped in try/catch (synthetic
  pointer ids throw NotFoundError — real drags unaffected).
- REGISTRATION: registry crop-pdf enabled:true; configs.ts, panels.tsx,
  surfaces.tsx entries. i18n crop.* 30 keys + real Devanagari hi.
- QA (agent-browser, 0 page errors, 0 console errors, dev.log clean):
  landing + card on all-tools (no "Soon" badge, click-through ✓);
  upload → overlay rect + "Cropped size 612 × 792 pt" chip + CTA blocked
  "crop box covers the whole page" (amber gating); AUTO-DETECT →
  margins [116/89/90/113] ≈ theoretical (90/90/116/114 ±1pt raster
  rounding), "Snapped to the content on page 1" chip, CTA unblocked;
  drag (synthetic pointer, async-gapped) → pure translation verified in
  margins (±59/±49pt matching px→pt scale), edge clamp verified;
  before/after toggle; RUN → RESULT → downloaded output CropBox
  (32.4,169.6,433.2,563.2) == committed 0.1pt margins exactly;
  ROTATED PAGE end-to-end: page 2 (/Rotate 90) renders 373×560
  (400×600pt display), margins 100/200/100/200 via panel Enter-commits
  → chip "200 × 200 pt" → range "2" → run → output p1 UNTOUCHED
  (no /CropBox added — sameBox guard) + p2 CropBox (200,100,200,200)
  EXACTLY the smoke-test worked example with rotation preserved;
  mobile 375px: no page h-scroll, canvas 309px fits, overlay ALIGNED,
  auto-detect + touch drag (directions + clamp correct), sheet inputs
  (unit switch → "0.0" mm formatting), zoom 2× overflow contained INSIDE
  the preview scroll area; Hindi UI end-to-end (क्रॉप, ऑटो-डिटेक्ट,
  मार्जिन); search palette finds Crop PDF; result chain shows
  pdf-to-jpg/png/watermark/merge; eslint + tsc fully clean.

Stage Summary:
- Live tools: 17 — merge, split, rotate, rearrange, remove, extract,
  images/jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt,
  add-watermark, add-page-numbers, add-header-footer, crop-pdf. PRD §8.2
  Crop COMPLETE (visual drag + numeric margins + auto-detect + all/
  selected + before/after — every clause of the spec row).
- Architecture wins: (1) the display-margins crop model + pdf.js
  viewport math = correct crops on rotated pages WITHOUT rasterizing;
  (2) tools/stamp-common/preview-parts.tsx = shared preview chrome for
  every future "canvas + page strip" tool; (3) the measured-overlay
  pattern (rAF canvas box measurement) documents how to keep an
  interactive overlay glued to a size-clamped canvas.
- Screenshots: download/qa-p38-*.png (workspace, autodetect, after,
  dragged, result, mobile ×3, zoom) + qa-p38-output.pdf,
  qa-p38-rotated-output.pdf (structurally verified outputs).
- Cron: webDevReview re-armed as job 440631 (15 min, priority=1) after
  440312 hit exec limits.
- Suggested commit: "feat: Crop PDF — visual 8-handle drag box with
  rule-of-thirds guides, margins in pt/mm/in, auto-detect content edges,
  before/after preview, /Rotate-aware worker (display→user geometry,
  smoke-locked), shared preview chrome extracted (PreviewFileHeader/
  PageStrip/ZoomControl, stamp surface refactored); i18n crop.* en/hi"

---
Task ID: P3.9
Agent: main (Z.ai Code session — webDevReview cron round: Doc info + Remove metadata RECOVERY + QA + Devanagari everywhere)

Task: 1) The previous round built change-pdf-doc-info + remove-pdf-metadata and
committed them (f8d06dd) but died BEFORE writing its worklog entry and before
any QA. 2) On arrival `/` was 500. 3) Recover, QA both tools end-to-end, fix
everything found, ship the deferred Devanagari watermark upgrade, styling pass,
this log.

Work Log:
- CRITICAL RECOVERY: `/` was 500 — src/lib/storage/local-snapshot.ts gone
  AGAIN (3rd time). ROOT CAUSE FOUND THIS ROUND: .gitignore's `local-*` rule
  silently matched the file — it was NEVER in git (even the P3.6 "recreate +
  commit" 619af87 missed it because git add refused). Fixed .gitignore
  (negation `!src/lib/storage/local-snapshot.ts`), recreated the module
  (createLocalSnapshot: raw-string-keyed cache, SSR fallback, parse guarded),
  committed. This failure mode can now never recur.
- Reviewed the inherited P3.9 files (meta-common/{meta,worker-lib}, both
  tools' config/panel/surface/worker, scripts/smoke-metadata.ts 22/22 PASS,
  registry/configs/panels/surfaces already wired) — code was complete and
  correct; QA was missing.
- QA GOLDEN PATH change-pdf-doc-info (fresh contexts, 0 page/console errors):
  upload → BEFORE card shows pdf.js-read fields → form PRE-FILLS from the
  file (title/author/creator verified) → edit title + clear creator → AFTER
  card live-updates (dotted-underline changed values + "will be removed"
  chips) → CTA gated until changes → RUN → RESULT ("1 files, 1 pages",
  974→946 B) → DOWNLOADED OUTPUT structurally verified with pdf-lib +
  PDFName keys: Title edited to exact text, Creator REMOVED, Author/Subject/
  Keywords/Producer/CreationDate/ModDate all KEPT, XMP stripped (default
  switch), pages intact. Hindi UI end-to-end (जानकारी बदलें, टाइटल) + Hindi
  title "गोपनीय वार्षिक रिपोर्ट" written via PDFHexString → verified in output
  (UTF-16BE round trip). Mobile 375×812: no h-scroll, bottom sheet works,
  sticky CTA.
- QA GOLDEN PATH remove-pdf-metadata: upload → honest found-fields report
  (6 fields + dates + custom entries + XMP row, each with "will be removed"
  tag) → "already clean" empty state → XMP toggle OFF via native CDP click
  (synthetic .click() is IGNORED by Radix Switch — needs pointer events):
  Kept chip + row dims + summary count drops → RUN → output Info dict FULLY
  REMOVED + XMP kept when toggled (verified both ways). FIXTURE LESSON: pdf.js
  `get metadata()` only reads /Metadata when it is an INDIRECT Ref
  (streamRef instanceof Ref) — test fixtures must context.register() the
  stream; direct-object /Metadata is invisible to pdf.js (real PDFs always
  use refs, app behavior is correct).
- BUG FIXED (a11y, real): the ToolShell mounts every custom panel in BOTH
  the desktop aside AND the mobile bottom sheet → duplicate hardcoded ids.
  change-pdf-doc-info (`di-*`) and split-pdf (`split-ranges` etc.) broke
  label→input association + screen readers on mobile. Both now use useId()
  (the stamp-tool panels already did). Verified: 12 inputs / 12 unique ids
  with the sheet open, labels resolve. Benign remainder: LogoMark's identical
  SVG gradient id appears twice (renders correctly; noted, not fixed).
- BUG FIXED (P3.7 regression, found via glyph probing): the previous
  NotoSansDevanagari-Regular.ttf (GF devanagari subset) has NO Latin letters
  — "Page ५ of १२" mapped Latin to .notdef (INVISIBLE text in live
  page-numbers/HF mixed output!). Swapped public/fonts to the google/fonts
  variable build (642 KB, covers Basic Latin + Devanagari, charset 551):
  GID probes now 0 .notdef for mixed text; pdf-lib embeds the default
  instance; OFL note updated. VERIFIED LIVE: PN hindiDigits output "Page १
  of १" now fully visible (VLM-read on the browser-rendered PDF, zoomed).
- FEATURE (worklog priority #2): Add watermark Devanagari upgrade — non-
  WinAnsi text now embeds the self-hosted Noto Sans Devanagari subset via
  stamp-common/worker-lib (loadStampFonts) instead of erroring; preview
  canvas renders the same family via wmCssFontFor (new, unicode-aware);
  panel shows an emerald "हिंदी embedded" pill + hint when the text needs
  it; error copy updated (Latin+digits+Hindi supported; CJK still honest
  error). END-TO-END VERIFIED: "गोपनीय — Confidential" watermark → output
  embeds Type0 NotoSansDevanagari subset → VLM confirms BOTH the Devanagari
  and Latin parts visible.
- STYLING PASS (VLM-reviewed): "will be removed" chips unified + contrast
  bumped (amber-500/15 bg, amber-800/amber-300 text) in BOTH surfaces;
  remove-meta report rows extracted to one ReportRow component (5× dedup);
  doc-info form spacing gap-3→4 + label gap-1.5→2; XMP switch row gap-3→4
  + leading-relaxed hints. Final VLM verdict: "Production-ready (A-grade)".
- Final: eslint clean, tsc clean, dev.log clean, / = 200, all console
  captures 0 errors.

Stage Summary:
- Live tools: 19 — merge, split, rotate, rearrange, remove, extract,
  images/jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt,
  add-watermark, add-page-numbers, add-header-footer, crop-pdf,
  change-pdf-doc-info, remove-pdf-metadata. PRD §8.2 Doc info + §8.3
  Remove metadata COMPLETE (the inherited round is now truly done: built +
  QA'd + logged).
- The 3×-recurring local-snapshot 500 is dead (gitignore root cause fixed).
- The mixed Latin+Devanagari invisibility bug (P3.7+) is fixed for ALL
  stamp tools by the full-coverage font build.
- Watermark now stamps real Hindi text (PRD "Hindi optional" clause fully
  delivered across wm/pn/hf).
- Radix Switch lesson: synthetic .click() is ignored — use native CDP
  click (agent-browser click command) or pointer events in automation.
- Screenshots: download/qa-p39x-*.png (12) + structurally verified outputs
  qa-p39x-*-output.pdf / -edited / -clean / -xmpkept / -wm-deva-output /
  -pn-mixed-output.
- Suggested commit: "fix: .gitignore local-* root cause (3rd 500),
  useId for duplicate panel ids, full-coverage Devanagari font (invisible
  Latin in mixed stamps); feat: watermark Hindi stamping; P3.9 doc-info +
  remove-metadata QA'd (info-dict strip/keep XMP both verified)"
- Next per plan: Fill out, View, Compress (device), Generate password, Scan
  to PDF, HEIC/WEBP — one per round. imagegrid per-image CROP UI still
  deferred; images-in-merge still unblocked (reuse imagegrid engine).

---
Task ID: P3.10
Agent: main (Z.ai Code session — webDevReview round: Fill out PDF forms)

Task: Next PRD §8.2 item per the plan — "Fill out PDF forms" (id
fill-out-pdf, edit, D, P1): field highlight + Tab navigation +
checkbox/radio/dropdown + date picker + auto-fill from local profile +
flatten after fill. Build it, QA it end-to-end with agent-browser, fix
everything found, styling pass, this log.

Work Log:
- Read worklog, armed-state check: cron job 441340 (15-min webDevReview)
  alive, git tree clean at 31fbe5f (P3.9). Baseline QA: / 200, 0 console
  errors, hash-routing to merge-pdf workspace fine. configs.ts "corruption"
  was a terminal-render artifact ([m eaten as ANSI) — file verified clean
  by hexdump, NO fix needed.
- BUILT tools/fill-out-pdf/ (5 files): scan.ts (pdf-lib AcroForm scan:
  kind/label/flags/current value/options/widgets with page + user-space
  rect per widget via P()/getObjectRef + page-ref map; userRectToDisplay
  for /Rotate 0/90/180/270 — derived from pdf.js viewport transforms;
  isWinAnsiText CP1252 check), profile.ts (localStorage auto-fill
  profile name/email/phone/organization/address + matchProfileValue
  heuristics Latin+Hindi), worker.ts (epoch-scoped "f:<fileId>::<name>"
  flat option keys so answers can NEVER leak into a replaced file;
  per-kind application incl. maxLength pre-truncation; non-WinAnsi
  answers pre-rendered with the embedded Noto Devanagari subset via
  stamp-common loadStampFonts BEFORE save() would throw WinAnsi; last
  resort = NeedAppearances + save(updateFieldAppearances:false)),
  surface.tsx (page preview canvas + % -positioned highlight boxes that
  click-to-focus their field; field form in reading order = natural Tab
  order; page chips; required/read-only/type badges; date fields get a
  native date picker writing dd/mm/yyyy; radio clear; dropdown none;
  optionlist checkbox multi-select; auto-fill bar + collapsible profile
  editor; filled-count + required-left chips; CTA gating no-changes/
  no-fields/scanning), config.ts (flatten switch + features/faq en+hi).
  Wired: configs.ts, surfaces.tsx, registry enabled:true, i18n fill.* 48
  keys en/hi.
- ENGINE BUGS FOUND + FIXED (smoke script scripts/smoke-fill.ts, 40+ checks
  ALL PASS): ① pdf-lib setText THROWS ExceededMaxLengthError on overflow
  — worker pre-truncates (verified the throw exists + truncation
  round-trips). ② doc.save() auto-regenerates dirty field appearances
  with WinAnsi Helvetica and THROWS for non-WinAnsi values (would kill
  the whole run) — worker now pre-renders non-WinAnsi text fields with
  the embedded Devanagari font; structural verify: output widget AP
  stream references NotoSansDevanagari-Regular subset, and VLM-confirmed
  the Hindi text RENDERS on the browser canvas (feed output back into the
  tool). ③ fixture lesson: createTextField+addToPage regenerates the
  widget AP immediately (WinAnsi throw at FIXTURE time for ₹).
- UI BUG FOUND + FIXED (browser QA): auto-fill matched the FULLY
  QUALIFIED name ("applicant.essay" contains "applicant") — essay/pincode/
  dob got filled with the user's name. Fixed: label-only matching,
  generic-name = EXACT normalized label set {name, fullname,
  applicantname, yourname, applicant, नाम, पूरानाम}, fname/lname
  exact-only ("fullname" ⊅ lname), Devanagari kept in normalize().
  Matcher unit-probed: 15/15 cases incl. Hindi labels.
- QA GOLDEN PATHS (fresh contexts, 0 console errors each): ① full fill
  (text+checkbox+radio+dropdown+optionlist multi) → RUN → "Your file is
  ready!" → downloaded output structurally verified 9/9 (name/email/
  agree/city=Jaipur/gender=Male/languages=Hindi+Tamil/readonly total
  untouched/dob empty/form alive/2 pages). ② Hindi answer "अर्जुन मेहता"
  → output value round-trips + Devanagari appearance + VLM-visible. ③
  FLATTEN (native CDP click on Radix switch — synthetic events are
  ignored, P3.9 lesson) → output has 0 fields left, 2 pages, permanent
  ink. ④ Empty state (non-form PDF): honest "No fillable form fields
  found" + editor-phase note. ⑤ Auto-fill: saved profile → one click →
  name+email filled, ZERO false matches after the fix. ⑥ Hindi UI
  end-to-end (फ़ॉर्म भरें CTA run → ready). ⑦ Highlight-box click focuses
  the right input + scrolls; focusing an input highlights its page box.
  ⑧ Mobile 375×812: no h-scroll, stacked layout, VLM-verified clean.
  ⑨ Date picker: calendar affordance on date-ish fields writes
  dd/mm/yyyy into the (still free-text) input.
- STYLING PASS (VLM-reviewed): first VLM verdict flagged faint highlight
  boxes → bumped to border-2 + bg-primary/15 (unfilled), emerald fill
  state, ring on focus; second VLM pass: "clearly visible with good
  contrast". Rows keep Page chips + kind badges + required (red) +
  read-only (lock) + emerald "Filled" dots.
- Final: eslint clean, tsc clean, smoke-fill ALL PASS, dev.log clean
  (only transient 500s while the paren-broken regex was mid-edit — fixed
  immediately; last GETs all 200).

Stage Summary:
- Live tools: 20 — merge, split, rotate, rearrange, remove, extract,
  images/jpg/png/webp-to-pdf, pdf-to-jpg, pdf-to-png, pdf-to-txt,
  add-watermark, add-page-numbers, add-header-footer, crop-pdf,
  change-pdf-doc-info, remove-pdf-metadata, fill-out-pdf. PRD §8.2
  "Fill out PDF forms" COMPLETE (highlight/Tab/checkbox/radio/dropdown/
  date picker/auto-fill profile/flatten — every PRD clause delivered).
- The WinAnsi-save-crash engine insight applies to ANY future form
  work: pdf-lib save() regenerates dirty appearances with Helvetica and
  throws on non-Latin — the Devanagari pre-render + NeedAppearances
  fallback pattern lives in tools/fill-out-pdf/worker.ts.
- Automation lessons re-confirmed: Radix Switch/Checkbox need NATIVE
  CDP clicks (agent-browser click), not synthetic events; same-frame
  double toggles on one optionlist overwrite each other (stale props by
  design of the shared-values architecture) — space interactions ≥1
  frame in QA, humans are never affected.
- Screenshots: download/qa-p310-{workspace,empty-state,hindi-ui,hindi-
  render,highlights-fixed,mobile}.png + outputs qa-p310-fixture.pdf,
  -output.pdf, -output2.pdf, -hindi-output.pdf, -flat-output.pdf.
- Suggested commit: "feat: Fill out PDF forms (PRD §8.2) — AcroForm scan
  with widget rects + /Rotate display mapping, click-to-focus highlight
  boxes on live preview, reading-order field form (text/multiline/
  maxLength/checkbox/radio/dropdown/optionlist/date picker), local
  auto-fill profile (label-exact matching, Latin+Hindi), flatten switch;
  worker: file-id epoch keys (no cross-file leaks), maxLength truncate,
  Devanagari pre-render for non-WinAnsi answers + NeedAppearances
  fallback; smoke-fill 40+ checks; i18n fill.* en/hi"
- Next per plan: View, Compress (device), Generate password, Scan to
  PDF, HEIC/WEBP — one per round. Unblocked leftovers: images-in-merge
  auto-convert (reuse imagegrid engine), imagegrid per-image crop UI.

---
Task ID: P3.11
Agent: webDevReview (main agent, session web-3597fa1e)
Task: webDevReview cycle — QA the live site, then ship the next PRD §7.7 tool: View PDF (PRD §6.5 viewer), plus mandatory styling/features.

Work Log:
- Read worklog fully; baseline QA (agent-browser): home + category pages clean,
  0 console errors, footer natural. dev.log showed only HISTORICAL 500s from
  the P3.10 mid-edit regex (already fixed; all recent GETs 200).
- Designed + shipped **View PDF** (`view-pdf`, category view, D-mode, P1):
  - **New architecture: viewer-only tools.** `ToolConfig.viewerOnly: true`
    (createWorker/outputKind now optional; pool guards the missing factory).
    ToolShell hides the sticky run CTA + options aside + BottomSheet for such
    tools and renders the workspace surface FULL-WIDTH — the surface IS the
    product. Added `onChain` to ToolSurfaceProps; shell wires it to
    handleChain (enabled/coming-soon toasts preserved).
  - `tools/view-pdf/surface.tsx` (~1660 lines): full viewer with
    continuous/single/two-page-spread layouts, zoom 25-400% via steps +
    fit-width/fit-page (ResizeObserver-driven, DPR-capped rendering),
    90-degree view rotation, dark reading mode (canvas invert+hue filter),
    thumbnails/outline sidebar (lazy thumbnails, flattened bookmarks w/
    depth + resolved pages), full-text search (Ctrl+F) with per-item
    proportional highlight boxes + active-match ring + results drawer +
    Enter/Shift+Enter navigation + auto-jump to first match, selectable
    text layer via pdf.js TextLayer (+ `.pdf-textLayer` CSS in
    globals.css, --scale-factor var), go-to-page input + G shortcut,
    arrows/PageUp/PageDown move by page in every layout, +/- zoom,
    R rotate, Esc closes search. Print = hidden iframe w/ blob URL
    (native PDF print), Download = original bytes, Share via
    navigator.share when available. Continue-with strip chains into
    merge/split/rotate/fill-out-pdf.
  - Password flow (PRD §6.5): PasswordException → inline prompt (stays
    local), wrong-password note, same-password resubmit re-runs the open
    (pwTry epoch). qpdf-AES-256 fixture QA'd end to end.
- **Bugs found by QA + fixed:**
  1. Page slots had NO explicit size → collapsed to ~32px, breaking layout,
     lazy IO, scroll math, fit modes (root cause: slot must be the layout
     authority — now sized from pageSizes×scale).
  2. Native /Rotate was double-applied vs slot math — pageSizes now store
     UNROTATED media size + page.rotate; displaySize composes
     rot+viewRotation exactly like pdf.js viewports.
  3. Search highlights pointed at wrong items: geo items were compacted
     while search indexes the RAW content.items — geo now carries
     itemIndex (fixed 4px-wide / wrong-position boxes).
  4. Search didn't auto-jump to the first match; Enter now lands on match 1.
  5. Same-wrong-password resubmit gave no feedback (pwTry epoch).
  6. "Search in document (Ctrl+F) (Ctrl+F)" doubled title.
- React Compiler lint reworks (all green): geo ref→state + boxes useMemo;
  container-size ref→state (RO fires after observe); doc-effect sync
  resets → documented adjust-state-during-render pattern (openedFor);
  search early-reset → searchResult carries its query (pure derivation).
- **Styling/features passes (VLM-reviewed ×6):** mobile toolbar was 3 rows /
  133px tall → single scrollable row (49px, scrollbar-none, shrink-0 items,
  fit buttons hidden <sm); highlight box confirmed clearly visible (closeup
  PASS); dark+spread PASS after re-shoot; landing copy for viewerOnly
  tools (view.how1-3) + dropzone singular "1 file" (limitsOne) in en/hi;
  fixed share-button JSX mangled by a partial edit (tsc caught nothing —
  found by inspection).
- QA GOLDEN PATHS (fresh contexts, 0 console errors each): upload →
  viewer renders (6 pages, 180% fit-width, 2 lazily-rendered canvases) →
  zoom 200% ✓ → spread/single slots ✓ → rotate → landscape slot ✓ → dark
  filter ✓ → search "zoom"/"pineapple"/"fox" counts+highlight+drawer+ring ✓
  → page input goto 2 ✓ → thumbs 6 rendered + active thumb tracks page ✓ →
  outline 6 rows → click row 4 jumps to page 4 ✓ → arrows move by page ✓ →
  G focuses page input ✓ → password wrong→note, right "user123"→unlocked ✓,
  same-wrong resubmit retries ✓ → Hindi UI end-to-end (viewer, toolbar
  titles, continue strip) ✓ → mobile 375×812 single-row toolbar, no
  h-scroll, canvases render ✓ → category page shows View PDF live (5 Soon).
- tsc clean, eslint clean, dev.log clean (all 200s).

Stage Summary:
- Live tools: 21 (20 + view-pdf). PRD §6.5 viewer delivered except
  presentation mode + attachments/annotations lists (see risks).
- Key architecture additions: viewerOnly ToolConfig + full-width shell
  mode + surface onChain. Reusable for Compare PDFs (P3) later.
- Engine insights: page slots MUST be sized from pageSizes×scale (layout
  authority); geo itemIndex must align with RAW pdf.js items (never compact
  shared indices); pdf.js TextLayer needs --scale-factor + minimal CSS
  (added to globals.css); print via hidden iframe + blob URL works in
  Chromium; PasswordException retry needs an epoch (same-input resubmits).
- QA fixtures: download/qa-p311-fixture.pdf (6 pages, outline,
  searchable), qa-p311-locked.pdf (AES-256, user "user123").
  Screenshots: qa-p311-{landing,viewer-sidebar,viewer-search-fixed,
  highlight-closeup,dark-spread2,mobile-fixed,password,hindi-viewer}.png.
- Suggested commit: "feat: View PDF (PRD §6.5) — viewer-only tool
  architecture (no run step, full-width surface, surface chains), lazy
  page rendering ±2, text layer, search w/ on-page highlights + drawer,
  thumbnails/outline sidebar, zoom/fit/rotate/spread/dark mode, password
  prompt (local), print/download/share, keyboard shortcuts, EN+HI;
  shell: viewerOnly mode + singular dropzone limits copy"
- Next per plan (one per round): Compress (device), Generate password,
  Scan to PDF, HEIC/WEBP. Unblocked leftovers: images-in-merge
  auto-convert, imagegrid per-image crop UI.
- Risks/debt (small): (1) search is case-insensitive substring per text
  item — no regex/diacritic folding yet (PRD's search-pdf tool, P2, will
  supersede); (2) attachments/annotations sidebar lists + presentation
  (fullscreen) mode from §6.5 not built — candidates for a later polish
  round; (3) cross-item phrase matches (match spans two text items) not
  highlighted — item-level only; (4) huge page counts (>500) probe all
  sizes upfront — fine in QA, worth a progress bar someday; (5) print uses
  the browser's native PDF print UI (blob iframe) — consistent + zero
  re-render cost, but no page-range selection.

---
Task ID: P3.12
Agent: webDevReview (main agent, session web-3597fa1e)
Task: webDevReview cycle — baseline QA, then ship the next PRD §7.5 P1 tool: Compress PDF (device mode), plus mandatory styling/features.

Work Log:
- Read worklog fully; baseline QA (agent-browser): home + optimize category
  clean, 0 console errors, Compress PDF showed "Soon" badge. dev.log all 200s.
- ENGINE LESSON (cost 2 smoke failures — pin this for future pdf-lib work):
  ① PDFName.asString() returns the name WITH the leading slash ("/DeviceRGB")
    — comparing it to "DeviceRGB" silently fails. Compare POOLED PDFName
    objects by identity instead: cs === PDFName.of("DeviceRGB"). PDFName.of
    is a pool (same instance per name), so identity works everywhere.
  ② context.obj() maps plain strings to PDFName — a real /Indexed palette
    string arrives as PDFString/PDFHexString (both have .asBytes()), so
    fixtures must build those explicitly.
- Built tools/compress-pdf/ (3 files):
  - engine.ts (PURE, bun-testable): resolveParams (light .82/2400, rec
    .65/1600, strong .45/1200, custom clamps q .2-.97 / dim 200-8000),
    classifyImage (DCTDecode→jpeg; Flate/LZW/A85/AHex/RunLength + DeviceGray
    1c / DeviceRGB 3c / DeviceCMYK 4c / ICCBased N / Indexed palette; skips
    ImageMask, JPX/CCITT/JBIG2, DCT-in-nested-filter, bpc≠8), 
    collectImageCandidates (ALL image XObjects, EXCLUDES /SMask + /Mask
    alpha objects via protectedRefs — re-encoding alpha as lossy RGB would
    corrupt transparency; skips <8px images), replaceImageStream (new
    PDFRawStream DCTDecode w/ updated W/H/ColorSpace, carries /SMask /Mask
    /Name /Interpolate), targetSize (never upscales), grayscaleImageData
    (Rec.601), indexedPalette (PDFString+PDFHexString inline palettes).
  - worker.ts: DCT→createImageBitmap (browser JPEG decode); raw→
    decodePDFRawStream→ImageData by colorspace (gray/rgb/cmyk-naive/
    indexed w/ palette expansion incl. stream-backed palettes); Offscreen
    draw to target size + optional luminance grayscale → JPEG re-encode →
    size-guarded (≥2% win else keep original); replaceImageStream per
    candidate; optional stripAllMetadata (meta-common); progress per image.
  - config.ts: preset select (Light/Recommended/Strong/Custom) + Custom
    reveals quality 30-95% + maxDim 600-4000px via NEW showWhen schema;
    grayscale + stripMetadata switches; en+hi features/FAQ (6/3).
- SCHEMA EXTENSION: OptionField.showWhen {id, equals} + fieldVisible() in
  config-types.ts; OptionsPanel filters on it. Hidden fields keep values.
- Wired: configs.ts import + registry enabled:true. Result view already
  shows before→after size + % saved chip (no changes needed).
- QA (fresh contexts, 0 console errors each):
  ① GOLDEN PATH: upload 1.5MB fixture (PIL noisy gradient JPEG 2200x1500
    + flat Flate PNG + alpha PNG + text-only page, 4 pages) → Recommended →
    "1.5 MB → 148 KB — 90% smaller". Structural verify of output: 4 pages,
    photo is now jpeg 1600x1091 (DCTDecode), SMask 17 0 R preserved on the
    alpha image, flat/alpha originals kept (size guard), text layer INTACT
    (BT/Tj hex literal "Compress QA Fixture" decodes correctly on page 1).
  ② CUSTOM reveal: dropdown→Custom shows quality 65 + maxDim 1600 inputs;
    switch back to Recommended hides them (showWhen works both ways).
  ③ GRAYSCALE + STRIP: 146 KB; output has NO Info dict, NO /Metadata XMP.
  ④ HINDI UI end-to-end: पीडीएफ़ कंप्रेस करें → आपकी फ़ाइल तैयार है! →
    90% छोटी → डाउनलोड.
  ⑤ MOBILE 375×812: no h-scroll; VLM verdict: clean, no overlaps, delta
    prominently displayed.
  ⑥ ENCRYPTED PDF: password-protected fixture → toast "Something went
    wrong / This PDF is password-protected. Unlock it first, then try
    again." + return to workspace (caught via MutationObserver — toasts
    auto-dismiss, sleep() misses them).
  ⑦ Optimize category page: Compress PDF live (no Soon badge).
  ⑧ VLM desktop review: layout clean, hierarchy clear, size savings
    prominent; custom-reveal panel: fields clean, spacing professional.
- smoke-compress.ts: 22/22 PASS (params clamping, candidate discovery,
    SMask exclusion, targetSize, luminance math, classify skip paths,
    replaceImageStream dict + SMask carry, doc reload round-trip).
- eslint clean, tsc clean, dev.log clean (all 200s).

Stage Summary:
- Live tools: 22 (21 + compress-pdf). PRD §7.5 core delivered.
- Key architecture additions: showWhen conditional option fields (reusable
  for every future tool); pure-engine/impure-worker split for compress.
- Engine insights for any future image-touching tool (N-up, Rasterize,
  Images-in-merge): see ENGINE LESSON above — PDFName identity comparison,
  PDFString vs literal strings, SMask protection pattern, size-guard
  pattern (never regress), dimension change is safe because cm matrices
  stretch images into the same drawn box.
- QA fixtures: download/qa-p312-fixture.pdf (1.5MB, 3 image kinds + text
  page), qa-p311-locked.pdf reused for encrypted path. Outputs: -output
  (148KB), -compressed-gray (146KB, no Info/XMP). Screenshots: qa-p312-
  {baseline-optimize, custom-reveal, result, mobile-result}.png.
- Suggested commit: "feat: Compress PDF (PRD §7.5) — device-side image
  re-encode engine (DCT/Flate/LZW decode, colorspace-aware raw pixels,
  Indexed palettes incl. stream-backed), JPEG re-encode at preset/custom
  quality+maxDim, grayscale, optional metadata strip, per-image size
  guard (never regress), SMask/Mask protection; showWhen conditional
  option fields; smoke 22/22; QA 90% smaller w/ text layer verified"
- Next per plan (one per round): Generate password (PRD §7.4 qpdf-based),
  Scan to PDF, HEIC/WEBP converters. Unblocked leftovers: images-in-merge
  auto-convert, imagegrid per-image crop UI, view-pdf presentation mode.
- Risks/debt (small): ① no "compress to target size" loop yet (separate
  P2 tool compress-pdf-to-size — iterative quality ladder);
  ② JPEG2000/CCITT/JBIG2 images are skipped (rare in the wild — browsers
  can't decode JPX losslessly anyway); ③ 16-bit and non-8bpc raw images
  skipped; ④ large multi-image PDFs re-encode sequentially — fine in QA
  (4 images <2s), a 200-image file would want the existing per-page
  progress bar (already wired per-image).

---
Task ID: P3.13
Agent: webDevReview (main agent, session web-3597fa1e)
Task: webDevReview cycle — baseline QA, then ship the highest-popularity P1 gap: Sign PDF (PRD §7.6, pop 88), plus mandatory styling/features.

Work Log:
- Read worklog fully (disk state: 22 live tools, P3.12 was last entry — the
  previous session's "30 live / A1 audit" summary did NOT match disk; the
  registry is the source of truth: 22 live). Baseline QA clean (dev.log 200s).
  Pick: **sign-pdf** (pop 88, biggest P1 gap; P3.12 plan said "generate
  password" next but that tool is a simple password GENERATOR — Web Crypto,
  no PDF machinery — queued for a quick round later; sign-pdf is the flagship).
- INFRA FIX (critical for ALL future rounds): background processes spawned
  by tool invocations are REAPED at invocation end — `nohup`/`setsid`/`env -i`
  all die; only a TRUE DOUBLE-FORK daemon survives (verified: python
  double-fork sleep lived, single-fork died). Wrote scripts/dev-daemon.py
  (double-fork → exec `bun run dev`, log /tmp/docopdf-dev-daemon.log). The
  platform's original dev server had died mid-session; restarted via daemon.
- Shipped **tools/sign-pdf/** (7 files):
  - engine.ts (PURE, bun-tested): SignPlacement model stores cx/cy/w as
    fractions of the page DISPLAY box + on-screen rot; displayFracToUserPoint
    corner-walked for every /Rotate (R0/90/180/270); placementToDrawBox
    derives the pdf-lib draw (anchor via watermark's rotated-start-point
    formula, angle = R - rotCss — user→screen map is det<0 so display-CW is
    user-CCW); placementTargets (this/all/odd/even/range); defensive
    parsePlacementsOption (clamps, caps 60).
  - raster.ts: 5 script fonts self-hosted at /public/fonts/sign/ (Great
    Vibes, Dancing Script, Caveat, Homemade Apple, Kalam w/ Devanagari+
    Latin subsets, ~295KB total, LAZY FontFace load only inside the tool);
    renderTextSignature (tight ink-box trim), renderCheckmark (bezier ✓),
    trimCanvasToInk, removeWhiteBackground (corner-sampled paper color,
    tolerance + soft alpha ramp, only fires on light bg).
  - signature-store.ts: localStorage "docopdf.signatures" (cap 8, ~1.2MB
    guard, quota-safe); quick stamps are EPHEMERAL session entries (a shared
    computer never accumulates dates); event-bus like logo-store;
    signatureAssetFiles() → File[] "sig-<id>.png" rides collectAssets (no
    image data in options).
  - signature-dialog.tsx: Draw (smoothed quadratic strokes, undo/clear,
    ink swatches, pen width, DPR-aware canvas + ResizeObserver) | Type
    (5 font chips w/ live preview, ink, default = fill-profile name) |
    Upload (auto white-bg removal switch, trim, 12MB guard).
  - surface.tsx: page preview (fill-out-pdf skeleton + shared strip/zoom),
    click-to-place when armed, per-placement boxes with drag (pointer
    capture) / SE resize handle / rotate handle (atan2 + 15° snap + live
    angle chip) / delete button / keyboard (arrows nudge, Del removes, Esc
    deselects); right rail = signature tray (grid, kind icons, remove) +
    quick stamps (Date via toLocaleDateString en/hi, Name/Initials via
    Great Vibes from the fill profile, Checkmark) + selected-placement
    inspector (pages select + range reveal, size/rotation/opacity sliders).
    Placements live in options "p:<fileId>" (+ "sigkey") — replacing the
    file can never leak placements (fill-out-pdf's epoch-key pattern).
  - worker.ts: fails fast (no placements/missing asset/invalid range) →
    embeds each sig PNG once → placementToDrawBox per target page →
    drawImage(rotate, opacity) → save(useObjectStreams) → "<name>-signed.pdf".
  - config.ts: options [] (split-tool pattern), collectAssets, features/FAQ
    bilingual, chain → compress-pdf (live) + lock-pdf (soon) + view-pdf.
- SHARED PROTOCOL BUG FIXED: parsePageSpec("8-") documented as open range
  (8→last) but treated as single page 8 — dash-without-end now = open
  range (end=pageCount). Affects watermark/merge/pdf-to-txt/pdf-to-images/
  sign (5 tools) — docstring was right, code was wrong.
- i18n: full "sign" section (69 keys) en+hi with PERFECT key-tree parity;
  added missing tool.pagesPlaceholder (was rendering as a raw key in
  crop/wm/pn/hf/sign range inputs — pre-existing bug, one key fixes 5 tools);
  removed orphan tool.errorFont debug key (en-only; real key pn.errorFont).
- QA (fresh contexts; 0 console errors during scripted walk; toasts that
  auto-dismiss were the only thing needing MutationObserver-free checks):
  ① GOLDEN PATH: upload 4-page fixture (pages 2/3 have /Rotate 90/270) →
    Type "R. K. Sharma" (Great Vibes) → click-to-place → drag to 30%/40% →
    resize 25%→35% → rotate handle to 90° (snap) → inspector Home+arrows to
    -12° → run → 20KB output. STRUCTURAL: cm matrix decoded by hand —
    dw=208.348 (=0.35×A4 width), rotation matrix = cos/sin(12°) EXACT,
    anchor (81.602, 460.348) matches hand computation to 4 decimals.
  ② EVERY-PAGE mode: placement on the /Rotate 90 page → output has the
    image on all 4 pages; page 2 cm: translate(232.233, 416.736) + [0,1,-1,0]
    (=90° CCW) EXACT; page 3 (/Rotate 270): translate(363.047, 425.154) +
    [0,-1,1,0] EXACT — the display↔user mapping is provably correct.
  ③ Deterministic pixel check (threshold lum<35 on the app's own viewer
    canvases): signature bbox x 50.4–73.5% / y 33.7–36.4% on portrait page 1
    AND both rotated landscape pages — expected 49.5–74.5% / 33–37% ✓
    upright on rotated pages.
  ④ DRAW: 3 synthetic strokes on the pad → saved → placed → run → pdftoppm
    render + VLM confirm at 68%/62%, upright, clean.
  ⑤ UPLOAD: 640×240 white-bg PNG → bg removal verified at PIXEL level
    (4 corners alpha=0, 74,013 transparent px, 7,199 ink px kept, trimmed
    to 514×158) → placed + run OK.
  ⑥ QUICK STAMPS: date "9 Oct 2026" + checkmark placed + verified in
    rendered output at exact spots (VLM); Name with no profile → correct
    toast. Stamps are session-only (gone after reload — verified).
  ⑦ PERSISTENCE: signature library survives reload (localStorage).
  ⑧ HINDI UI end-to-end: switch locale → tray/hints/buttons Hindi; typed
    "राम कुमार शर्मा" with Kalam (हिंदी) font → placed → run → output
    renders Devanagari correctly (VLM: no tofu, upright, intact page).
  ⑨ ENCRYPTED PDF: getPdfPageCount rejects PasswordException → amber
    "password-protected. Unlock it first" card (was: infinite spinner +
    raw "wm.previewLoading" key — both bugs fixed this round).
  ⑩ MOBILE 375×812: no h-scroll, rail below preview, touch placement
    works, CTA visible (VLM 8.5/10 design review: "production-ready").
  ⑪ Deletion flows: box × button (2→1), keyboard Delete on focused box
    (1→0), tray remove (4→3 incl. placement cascade) all verified.
  ⑫ Security category: Sign PDF live, no Soon badge. Registry: 23 live.
- tsc clean, eslint clean, smoke-sign.ts 71/71 PASS (corner invariants for
  every rotation × rotation, center round-trips, targets, defensive parse).

Stage Summary:
- Live tools: 23 (22 + sign-pdf). The biggest P1 gap (pop 88) is closed.
  Remaining P1 gaps by pop: lock-pdf(78), unlock-pdf(75), scan-pdf(62),
  convert-to-pdf(58), convert-from-pdf(44), heic-to-jpg(36),
  generate-password(26), webp-to-jpg(24), heic-to-png(20), webp-to-png(14).
- ENGINE INSIGHTS (pin these): ① display fractions (what CSS positions)
  are the right placement model — the worker's displayFracToUserPoint is
  corner-walked per /Rotate and PROVEN exact on R0/90/270 outputs; total
  pdf-lib angle = pageRotation - cssRotation. ② pdf.js getDocument without
  onPassword REJECTS with PasswordException (tested) — surfaces that gate
  their preview on pageCount must catch it or they hang in "loading".
  ③ Radix Tabs/Select/Slider need NATIVE CDP clicks/keys (synthetic
  element.click() is ignored) — slider keyboard works (Home + arrows).
- INFRA: scripts/dev-daemon.py (double-fork) is THE way to run the dev
  server — plain background invocations get reaped. Documented in this log
  for every future round.
- Assets: /public/fonts/sign/*.woff2 (5 fonts, 295KB, lazy). QA fixtures:
  download/qa-sign-fixture.pdf (4 pages, /Rotate 90+270), qa-sign-upload.png,
  outputs qa-sign-signed-{page1,all,stamps}.pdf + qa-sign-hindi-output.pdf.
  Screenshots qa-sign-01…23-*.png.
- Suggested commit: "feat: Sign PDF (PRD §7.6) — draw/type/upload signature
  creation (5 script fonts incl. Kalam Devanagari, white-bg removal, ink
  trim), click-to-place with drag/resize/rotate handles + 15° snap, quick
  stamps (date/name/initials/checkmark, session-only), localStorage
  library, per-placement pages/size/rotation/opacity, /Rotate-exact
  placement engine (71 smoke assertions), encrypted-PDF card, EN+HI;
  fix: parsePageSpec open ranges '8-', missing tool.pagesPlaceholder key,
  orphan errorFont"
- Next per plan (one per round): generate-password (small, Web Crypto —
  no-file tool needs a viewerOnly-like config mode), then lock-pdf/unlock
  (need pdf encryption: @cantoo/pdf-lib or qpdf-wasm research), scan-pdf
  (camera), HEIC/WEBP converters (WASM decoders).
- Risks/debt (small): ① the aside Options card is near-empty for surface
  tools (options: []) — a real option (e.g. "signature line") would earn
  its space; ② a signature dragged to the very bottom edge may sit under
  the sticky CTA bar until scrolled (z-index stacking, VLM-noted);
  ③ only 5 of the PRD's 8 script fonts shipped (bundle-conscious);
  ④ "encrypted storage" for signatures is plain localStorage (PRD wording)
  — honest device-only copy instead; ⑤ view-pdf PasswordException prompt
  exists there, but the shared renderPdfThumbnail has no password path —
  other preview tools would need the same catch sign-pdf now has.

---
Task ID: P3.14
Agent: Z.ai Code (main orchestrator, session web-3597fa1e)
Task: Ship the Redact PDF tool (PRD §8.4, security category, pop 28) —
true redaction with search-based marking, manual boxes, verified-gone output.
Also recovered the lost ResultView "Start over" feature for ALL tools.

Work Log:
- STATE RECONCILIATION (important for every future round): the previous
  session's summary claimed "44 tools live, P4.5 Start-over complete" — the
  DISK disagrees: worklog ended at P3.13, registry had 23 enabled tools, and
  ResultView had NO start-over button. Disk is always the source of truth;
  this round shipped against the disk state (P3 plan: one tool per round).
- Dev server was DOWN at session start; restarted via scripts/dev-daemon.py
  (double-fork — the only way processes survive invocation reaping).
- Shipped tools/redact-pdf/ (5 files):
  - engine.ts (PURE, 49/49 smoke): RedactMark model (display fractions,
    sign's proven placement geometry); 4 Indian-pattern regexes with
    look-around guards (Aadhaar 12-digit grouped/solid, PAN, IN mobile
    incl. +91/91- and 5+5 split forms, email) — 16-digit order ids and
    landlines rejected; termMatches (case-insensitive); buildPieces/
    buildLines with synthetic-space joining whose segment offsets map
    every character back to its covering piece; pieceUserBox (rotated
    glyph runs via advance/up vectors); userRectToDisplay (pdf.js viewport
    transforms, R0/90/180/270 hand-verified); displayRectToFraction
    (clamped + padded); parseRedactMarks (defensive: clamps, dedupes,
    caps 600, drops bad kinds/pages).
  - search.ts: extractPageTexts (main-thread pdf.js via the shared
    loadPdfjs, WeakMap cache per File, failed parses don't poison the
    cache) + findSensitiveMarks (patterns+terms → enabled marks) +
    hasNoText (scan detection for the honest hint).
  - surface.tsx: sign-skeleton preview (header/strip/zoom/canvas +
    PasswordException card) with: found matches as translucent red
    switches (click = keep/skip, chip shows the kind), manual boxes drawn
    by dragging empty canvas (drag/resize/delete + keyboard nudge), a
    selected-mark inspector (kind/text/page/state + keep/redact/delete),
    Find rail (4 preset toggles + custom terms textarea + Find & mark +
    per-kind count chips + Clear found), how-it-works security card.
    Marks live in options "m:<fileId>" + "mkey" (epoch-key — replacing
    the file can never leak boxes). Live-drag state commits once on
    release (sign's pattern).
  - worker.ts (the security core): pdf.js renders each marked page at
    the chosen DPI (40MP pixel cap), paints OPAQUE boxes onto the raster
    BEFORE encoding, then rebuilds the output as a NEW PDFDocument —
    unmarked pages copied vector-perfect (copyPages), marked pages become
    JPEG-only addPage([displayDims]) draws. Because nothing from a marked
    page is ever copied, its content streams, annotations, widgets and
    form values never enter the file (in-place surgery would leave
    orphaned-but-serialized objects — pdf-lib writes orphans; the
    rebuild sidesteps the whole problem). VERIFICATION STEP: the saved
    bytes are re-opened with pdf.js and every marked page must extract
    ZERO text or the run fails honestly (tool.errorRedactVerify).
  - config.ts: schema options fill the shared aside (paying off P3.13's
    empty-options debt): Flatten quality 96/150/300 DPI + box colour
    black/white (both opaque); features + FAQ honestly explain the
    flatten model; chains → view/remove-metadata/compress/pdf-to-jpg.
- Wiring: registry redact-pdf enabled: true (24 live), configs.ts +
  surfaces.tsx entries.
- i18n: full "redact" section (44 keys) en+hi with PERFECT key-tree
  parity + tool.errorRedactNoMarks / tool.errorRedactVerify. Merge
  script scripts/i18n-redact.py (same pattern as i18n-watermark).
- RECOVERED LOST FEATURE (all tools): ResultView "Start over with a new
  file" — shell startOver() clears outputs, files, options (per-file
  marks/placements/ranges die so nothing leaks across documents) and
  returns to the landing state on the SAME tool page; button rendered
  under the What-next card (RotateCcw icon). i18n result.startOver en+hi.
- Fixed along the way: sign-pdf + redact grid class was mangled
  ("grid-cols-inmax" — actually correct on disk; the READ pipeline eats
  "[m" sequences — beware when grepping Tailwind arbitrary-value classes).
- QA (agent-browser, fresh contexts; ONE benign console warning the whole
  session — a pdf.js font-load race during cleanup, everything rendered):
  ① GOLDEN PATH: upload 3-page fixture (page 1 = Aadhaar/PAN/phone/
  email lines, page 2 = /Rotate 90 with phone+email, page 3 = clean
  text) → Find & mark → "6 matches marked on 2 pages" → run → output
  downloaded. STRUCTURAL VERIFY (bun + pdf-lib + zlib): zero text
  operators on ALL flattened pages, zero font programs, zero annotations,
  AcroForm absent, one JPEG XObject per page, and NO sensitive string at
  byte level (plain latin1 + UTF-16BE, decompressed streams included).
  ② PIXEL VERIFY (in-app pdf-to-jpg on the output, 1240×1754): all four
  match rows 65-77% solid BLACK at the exact expected fractions (x 10%,
  y 13/16/19/22%); clean areas <1% dark; VLM confirms 4 black rectangles,
  ORCHID line + heading + name still readable, text sharp.
  ③ ROTATED PAGE: page 2 rasterizes landscape (842×595, rotation
  normalized to 0); its phone+email matches paint as two VERTICAL bands at
  display x 84.6-88.7% = user y 712-747 — the head-tilted reading of a
  /Rotate 90 page is preserved and covered exactly; title (user y 780)
  stays readable.
  ④ SELECTIVE REDACTION: page-2 matches toggled OFF before run → output
  page 2 KEEPS /Rotate 90 + its vector text (phone/email strings found in
  the DECOMPRESSED stream — exactly the kept content), page 3 fully
  selectable, page 1 flattened + its strings gone everywhere.
  ⑤ CUSTOM TERM + TOGGLE: "orchid" term found + marked; toggled off →
  dashed muted box, run keeps the line (verified in output1: ORCHID
  readable). Manual box drag → box at EXACTLY the drawn fractions
  (30.05%, 19.79%, 31.87%, 26.93%) → 100% solid black in output page 3.
  ⑥ HINDI end-to-end: workspace + find + run + result + Start-over all
  Devanagari; 6 मैच चिह्नित; आपकी फ़ाइल तैयार है!
  ⑦ MOBILE 375×812: no h-scroll, clean vertical stack, red boxes + CTA
  visible (VLM: "well-optimized, no critical rendering errors").
  ⑧ ENCRYPTED: qa-p311-locked.pdf → amber "password-protected. Unlock it
  first" card (no spinner hang).
  ⑨ SCAN: image-only fixture → Find → "No matches found" + "no
  selectable text — looks like a scan. Draw boxes instead." hint.
  ⑩ START OVER (new): result → "नई फ़ाइल के साथ शुरू करें" → landing with
  fresh dropzone; options reset (marks can't leak to the next file).
  ⑪ Security category: Redact PDF live, no Soon badge.
  ⑫ Desktop VLM design review: 8.5/10 "production-ready" (hierarchy 9,
  color 9; notes: slight spacing under Find button, thumbnails floating).
- smoke-redact.ts 49/49 PASS; eslint clean; tsc clean (after prisma
  generate); dev.log clean (the @swc/helpers module-not-found noise at
  daemon startup predates this round — known Next16/bun quirk, app fine).

Stage Summary:
- Live tools: 24 (23 + redact-pdf). PRD §8.4 Redact delivered with a
  provably-secure flatten model — see the worker docstring for why
  rebuild-beats-surgery (orphan serialization).
- ENGINE INSIGHTS (pin these): ① pdf.js text items' transform is USER
  space; item.width is in user units; map glyph boxes through
  viewport.transform for display fractions — R0/90/180/270 verified by
  hand in smoke §5. ② pdf-lib serializes ORPHANED objects — deleting a
  dict entry does NOT remove data from the file; only rebuilding into a
  fresh context (copyPages/addPage) guarantees the data never existed.
  ③ pdf-lib normalize() sets empty Font/Annots placeholders on pages —
  presence ≠ leak; check entry counts. ④ The READ/grep pipeline eats
  "[m" — never trust greps over Tailwind arbitrary-value classes.
- RECOVERED: ResultView Start-over (was in the lost pre-P3.14 worklog
  summary as "P4.5, all tools" — disk had nothing; now real for all tools).
- Assets: QA fixtures download/qa-redact-fixture.pdf (3 pages: sensitive
  text, /Rotate 90, clean), qa-redact-scan.pdf (no text layer); outputs
  qa-redact-output.pdf (all-pages redact), qa-redact-output2.pdf
  (selective), qa-redact-page{1,2,3}.jpg (pixel-proof). Screenshots
  /tmp/redact-01…13 (landing, workspace, found, mobile, hindi, encrypted,
  scan, final-desktop).
- Suggested commit: "feat: Redact PDF (PRD §8.4) — find sensitive text
  (Aadhaar/PAN/phone/email patterns + custom terms, coverage-preserving
  line joining), review boxes + manual draw/drag/resize, flatten-rebuild
  output (marked pages → opaque-box JPEG pages in a fresh doc: text
  layers, annotations, form values never copied), post-save zero-text
  verification, DPI + colour options in shared panel; EN+HI 46 keys;
  smoke 49/49; feat: ResultView start-over for all tools (options+
  files+outputs reset); fix: none needed on disk (grep artifact)"
- Next per plan (one per round): generate-password (small, Web Crypto,
  needs a viewerOnly-like no-file mode), then lock-pdf/unlock-pdf
  (@cantoo/pdf-lib or qpdf-wasm research), scan-pdf (camera),
  HEIC/WEBP converters (WASM decoders).
- Risks/debt (small): ① redaction search cannot span line breaks (a
  12-digit Aadhaar split across two lines is missed — line-scoped by
  design; FAQ could mention it); ② marked pages flatten at JPEG q0.92 —
  photographic scans at 300 DPI produce large outputs (fine for KYC-style
  docs; a PNG path could be added for text-heavy pages); ③ the worker
  re-parses the output per verification page (one pdf.js doc per page —
  could reuse a single doc handle); ④ unreferenced XObjects with hidden
  text in the ORIGINAL are never copied anyway (rebuild model) — but the
  FAQ wording stays scoped to what we verify (no text on marked pages).
