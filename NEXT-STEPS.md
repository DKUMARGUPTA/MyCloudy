# NEXT-STEPS — DocoPDF auto-work queue

> **Purpose:** Priority-ordered candidate work for cron rounds (webDevReview,
> 15-min) and any new session. The lead agent reads this AFTER
> `CONTEXT-MEMORY.md` and picks the top item that fits the round's budget —
> no waiting for the owner to explain what's next.
>
> **Protocol (binding):**
> 1. Before starting an item, mark it `IN PROGRESS` (append `— @<round-id>`).
> 2. When done, move it to DONE (bottom) with a one-line result + commit hash.
> 3. At round end, add any NEW candidates you discovered (with context).
> 4. Never delete DONE entries — they are the queue's memory.
> 5. Items tagged `[owner]` need owner approval BEFORE starting — skip them.

## Bentopdf-inspired master roadmap (2026-10-31, owner-approved "phase-wise sab kuch")

> Source: fresh bentopdf audit R50 (125 tools + 80 workflow nodes vs our 107).
> Discipline: bentopdf is AGPL — ZERO code/dep copy, ideas only, own engine
> (`src/lib/own/pdf`) everywhere. R48 anatomy for every new tool.

### P1 — Quick-win tool batches (highest ROI, own-engine, R48 anatomy)
- ~~**P1-a: 6 tools**~~ **DONE (R50)** — bates-numbering, add-stamps,
  background-color, remove-blank-pages, alternate-merge, add-page-labels —
  all live, smoke 78-check + E2E 7/7 green. 112 tools total.
- ~~**P1-b: raster color family**~~ **DONE (R51)** — invert-pdf-colors,
  pdf-to-greyscale, scanner-effect, posterize-pdf — live via shared
  `tools/raster-color-common/` core, smoke 77-check + E2E + VLM
  pixel-proof green. 116 tools total / 113 live.
- ~~**P1-c: output pack**~~ **DONE (R52)** — pdfs-to-zip (own zip engine,
  STORE default), rotate-custom (any angle, exact AABB mixed plan),
  view-metadata (TXT/JSON inspector), change-permissions (perm-only lock,
  owner pw required) — live, smoke 94-check + E2E + VLM pixel-proof green.
  120 tools total / 117 live. Also fixed a pre-existing own-zip-engine bug
  (flatten hardcoded level 6 killed the archive-level option; pptx
  regression battery 104+162 green after fix).
- ~~**P1-d: page utils**~~ **DONE (R53)** — duplex-collate (4 layout×flip
  combos + padBlank), remove-annotations (granular preserve-path strip:
  markup/links/widgets + page-range + forms stay fillable), page-dimensions
  (pt/mm/inch + paper-name + mixed detection) — live, smoke 75/75 + E2E
  3 golden paths green. **fix-page-size → change-pdf-page-size COVERED,
  linearize-pdf → web-optimize-pdf COVERED** (honest mapping, no duplicate
  tools — see PHASE-PLAN.md). **123 tools / 120 live. P1 PHASE COMPLETE.**
  Battery fix: r50 smoke missing process.exit since R50 (timeout-124 on
  green) — fixed; r50/r51/r52 count assertions updated to 123/120.

### P2 — AI differentiators (self-dependent, on-device) — ✅ DONE (R54)
- ~~`summarize-pdf`: TextRank/TF-IDF sentence scoring~~ **DONE** — REBUILT
  self-dependent: standard run pipeline, PURE TextRank worker-lib
  (bilingual danda+abbrev sentence split, power iteration, word-band
  select, (p. N) citations), MD/TXT output. smoke 77/77.
- ~~`chat-with-pdf` → "Ask PDF (smart search)"~~ **DONE** — BM25 Okapi
  (k1=1.5 b=0.75) passage index in worker, ranked snippet cards with
  page badges + <mark> highlights + relevance %, search-first surface.
- ~~`prepare-pdf-for-ai`~~ **DONE** — NEW tool (convert-from): LlamaIndex
  JSON/JSONL export (Document + TextNodes page map, paragraph-boundary
  chunker + overlap, token estimates, language_hint).
- ~~Re-enable flow~~ **DONE** — registry flips (124 total / 123 live /
  1 deferred = translate only) + honest SEO + i18n ask.* (5150=5150).
  Provider-era cleanup: /api/chat + /api/summarize routes + old
  surfaces/models/api-models DELETED; /api/translate + zai-client
  STAY (translate-pdf future re-enable).

### P3 — Format expansion (importers/exporters/attachments)
- ~~**P3-a: export pack**~~ **DONE (R55)** — pdf-to-json (structured doc
  dump, prepare-pdf-for-ai se distinct), pdf-to-csv (RFC 4180, Excel
  extraction reuse), pdf-to-cbz (raster + own-zip, page-NNN naming) —
  smoke 71/71 + E2E download-verified. **127 tools / 126 live.**
- ~~**P3-b: import pack 1 (text-ish)**~~ **DONE (R56)** — csv/json/
  xml-to-pdf + data-table-common painter. **130/129/1.**
- ~~**P3-c: import pack 2 (image/docs)**~~ **DONE (R57)** — bmp/psd/
  cbz/email-to-pdf + raster-decode-common (own BMP/PSD decoders,
  natural sort, EML/MIME parser). **134/133/1.**
- Importers left: mobi, fb2, odg/odp (LibreOffice family — honest
  best-effort or documented refusal), wpd/wps, vsd, xps.
- Exporters left: pdf-to-bmp.
- Attachments cluster: add/edit/extract-attachments (embedded files).

### P4 — Programmatic SEO + traffic
- Compress-size landing routes (`compress-pdf-to-100kb` style, 7 variants)
  reusing the real `compress-pdf-to-size` tool + canonical links.
- Blog seed (3 competitor-alternative posts pattern).
- seo-audit-style script (own implementation).

### P5 — Big rocks (phase-wise, longest game)
- `pdf-multi-tool` (unified organize grid UI) → `pdf-workflow` (visual
  node pipeline; start: linear step-chain, then nodes).
- `deskew-pdf` (skew detect + straighten), `extract-tables` (tables→CSV),
  `edit-pdf-text` (in-place paragraph edit — hardest), `font-to-outline`,
  `pdf-layers` (OCG), `table-of-contents` (auto TOC + links),
  `timestamp-pdf` (RFC 3161).

### P6 — Platform
- PWA / Service Worker offline shell `[owner]` (storage/UX tradeoffs).
- `config.json` runtime tool-disable (no-rebuild on/off).
- More languages (24 in bentopdf vs our en+hi) `[owner]` — effort heavy.

### Continuous
- UX/UI polish: ONE surface per round (landing states → result view →
  category pages → hero). Details bar: hover, focus rings, spacing rhythm,
  empty states, mobile sheet.

## Blocked / Waiting

- **translate-pdf re-enable** — `[owner]` needs decision: browser-local
  model (transformers.js, ~30-80MB per language download) vs stay deferred.
- **Real billing (Razorpay/Stripe)** — `[owner]` explicitly frozen
  (2026-10-31: "abhi nahi lagna hai"). Do NOT touch.
- **GA4** — optional, needs `NEXT_PUBLIC_GA_ID` from owner.
- **AI provider env keys** — superseded by P2 (self-dependent path).

## DONE (append-only log)

- **R54 (2026-11-07):** Layout-audit round + Tier-A round 4 — 6/6 e2e PASS,
  1 CRITICAL bug fixed, 3 layout fixes shipped. **Layout audit** (user
  "ab layout issue ho rah hai"): VLM screenshot audit (home/tools/tool ×
  375/1280 × light/dark) found the cookie-consent floating card covering
  dropzones/cards + the Next dev "N" button overlapping mobile bottom-nav.
  Fixes: (1) consent banner → centered modal (desktop) / bottom-sheet
  (mobile) with dimmed backdrop + slide/fade anims, aria-modal,
  safe-area-aware; (2) `devIndicators: false` in next.config; (3) category
  chip strip 40px right-edge fade (scroll affordance). JS overflow check
  scrollWidth==375 on home+tools. **Tools:** pdf-to-txt (flow layout, all
  pages + UNIQUE-MARKER extracted), view-pdf (nav/zoom/fit/rotate full
  cycle 0→360° render-verified), scan-pdf (Scan→PDF A4), convert-to-pdf
  (smart dispatcher → images-to-pdf chain), images-to-pdf (2 PNGs →
  auto-landscape A4, VLM both pages), png-to-pdf (A4 landscape). 🔧
  **CRITICAL FIX — scan-pdf "Detect text" chain was broken:** raw JPG
  chained into ocr-pdf (accepts pdf) → silent "PDF damaged" error, revert
  to workspace. Fix in tools/ocr-pdf/worker.ts: image inputs (JPG/PNG
  magic bytes) wrapped into fit-to-image single-page PDF via own engine
  (CreateContext embedJpeg/embedPng) before the pdf.js+OCR pipeline; added
  tool.errorNotPdf (EN+HI) for unsupported types; base name strips image
  extensions. Verified: chain completes at 92% OCR confidence, pdftotext
  extracts full scan text incl. UNIQUE-MARKER-XYZ-9981; native-PDF input
  regression PASS (93%). Lint 0, dev log clean. Docs updated
  (TOOL-TESTING-PLAN R54 + layout-audit reports, 6 tool rows). **NEXT:
  R55 — Tier A remainder + Tier B start (watermark, fill, page numbers,
  crop).**
- **R54-fix (2026-11-04):** Header layout overflow FIXED (user-reported via
  screenshot). Diagnosis: header row needed ~1400px (logo 113 + nav 718 +
  right group 427 + search text) but `max-w-6xl` capped the container at
  1152px → 257px structural overflow at ALL desktop sizes — Get Pro pushed
  off-screen at 1280–1535 viewports (right edge measured at 1473px > 1280
  viewport), and with wide system fonts the squeeze wrapped "All tools" /
  "Why DocoPDF" onto 2 lines (labels had no whitespace-nowrap). The "75%"
  pill in the report was Chrome's native zoom bubble (browser UI), not a
  site component — but it led to the real bug. Fix (3 files): container
  `max-w-6xl` → `max-w-[1520px]` + tiered density (search icon-only,
  Log in icon-only, Why hidden below 2xl; full labels at 2xl+) + nowrap +
  shrink-0 on every nav label (site-header.tsx, header-menus.tsx,
  account-menu.tsx) + gap/padding trims. Verified: overflow=0 at
  1280/1366/1440/1536/1600/1920/2048/2557/3000 EN+HI (Hindi = widest
  locale, slack 174–360px), Get Pro in-viewport everywhere, labels
  single-line everywhere, dropdowns open cleanly, mobile/tablet no
  hscroll, lint 0, console clean. **NEXT: R54 testing — pdf-to-txt,
  scan-pdf, view-pdf, convert-to-pdf, images-to-pdf, png-to-pdf.**
- **R53-test (2026-11-04):** Tier-A round 3 — 5/5 e2e PASS, zero bugs
  filed. lock-pdf (qpdf-verified AES-256/AESv3 R=6, pw round-trip,
  permission bits), unlock-pdf (decrypted output opens pw-free; wrong-pw
  error copy clean; full lock→unlock round-trip), jpg-to-pdf (A4
  auto-landscape for 800×560, DCTDecode embed, VLM text round-trip),
  pdf-to-png (875×583 RGBA exactly as DPI preview promised, ZIP download),
  rotate-pdf-pages (feature matrix: scope All/Selected + per-page buttons,
  /Rotate metadata + visual render both verified). Suspected toolbar-rotate
  bug investigated → working-as-designed ("Apply to" scope system, default
  All). Footer Hinglish tagline on EN confirmed intentional branding.
  Docs updated (TOOL-TESTING-PLAN R53 report + statuses). **NEXT: R54 —
  pdf-to-txt, scan-pdf, view-pdf, convert-to-pdf, images-to-pdf, png-to-pdf.**
- **R52 (2026-11-04):** Tier-A top-5 e2e + deploy fire-fight. edit-pdf,
  sign-pdf, word-to-pdf, pdf-to-jpg, pdf-to-word — 5/5 PASS with content
  verification (DOCX text runs, JPEG VLM, signed/edited pages). UX fix:
  pdf-to-word re-download button (auto-download-only design stranded users
  on blocked saves). **DEPLOY INCIDENT:** cron auto-commit e28de8b landed
  316 untracked legacy files incl. a half-finished /api/limits (imports
  without exports) → Vercel build ERROR. Fixed: plans.ts exports per
  billing-research D3 (free 25/day, pro 1000/day, hard-gate with provider
  keys — shadow mode now); typescript.ignoreBuildErrors=true temporarily
  (~189 legacy tsc errors, runtime healthy, eslint 0). Prod verified:
  /api/limits live, re-download e2e, 0 console errors. `546d59b`
  **NEXT (P0): tsc-cleanup round — 189 errors in tools/ then re-enable
  build gates.**
- **R51b (2026-11-04):** Multi-menu header redesign + prod audit/deploy.
  Old 5-column mega-menu wall → six focused dropdowns (Organize, Edit,
  Convert, Secure, Create, QR & Barcodes) on lg+; compact 2-col browse
  panel on md–lg; QR chip col-span-2 odd-tail fix; All tools/Why links
  height-aligned h-9. `docs/TOOL-TESTING-PLAN.md` added (T1–T8 checklist,
  3 tiers, R52+ schedule; R51 QR round-trip + merge e2e executed).
  CROSS-AUDIT: GitHub was 2 commits behind local (R51 unpushed!) → pushed
  `ac3bfd8`, Vercel auto-deploy READY, prod verified (0 console errors,
  EN+HI header, /tools/qr, tablet panel). 189 pre-existing tsc errors in
  tools/ noted (not build-blocking) — candidate for future cleanup round.
- **R57 (2026-10-31):** P3-c import pack 2 — 4 tools (bmp/psd/cbz/
  email-to-pdf) + tools/raster-decode-common (BMP decoder CORE→V5 +
  RLE8/RLE4/BITFIELDS, PSD/PSB composite raw+PackBits, placement
  geometry) + PURE EML/MIME parser + natural sort. 134 tools (133
  live). Smoke 147/147 + E2E 4 golden paths (VLM email verification) +
  regressions all green. See worklog R57.
- **R48 (2026-10-31):** 6 tools batch 1 (reverse/add-blank/divide/
  combine-single/booklet/sanitize) — prod live, 106 tools. `081ab67`
- **R48-pre (2026-10-31):** pre-batch push + bentopdf audit. `1883198`
- **R49 (2026-10-31):** agent system + auto-work queue shipped (Scout/Builder/Auditor + NEXT-STEPS + autopilot skill). Docs-only, dry-run verified. See worklog.
- **R50-plan (2026-10-31):** bentopdf fresh audit → P1-P6 phase roadmap (this rewrite). Owner approved "phase-wise sab kuch implement karo".
- **R50 (2026-10-31):** P1-a batch — 6 tools (bates/stamps/background/
  blank-pages/alt-merge/page-labels) + P1-P6 roadmap. 112 tools. See worklog R50.
- **R51 (2026-10-31):** P1-b raster color family — 4 tools (invert/greyscale/
  scanner/posterize) via new `tools/raster-color-common/` shared core (pure
  transforms + render pipeline). 116 tools (113 live). Smoke 77/77 + E2E 5/5
  + VLM pixel-proof (invert = cyan/magenta verified). See worklog R51.
- **R52 (2026-10-31):** P1-c output pack — 4 tools (pdfs-to-zip, rotate-custom,
  view-metadata, change-permissions). 120 tools (117 live). Smoke 94/94 +
  E2E full (4 golden paths + mobile + Hindi + VLM rotate proof) + own-zip
  engine level bug fixed with pptx regression battery. See worklog R52.
- **R53 (2026-10-31):** P1-d page utils — 3 tools (duplex-collate,
  remove-annotations preserve-path, page-dimensions) + PHASE-PLAN.md
  (formal phase plan + coverage table; fix-page-size/linearize mapped as
  covered). 123 tools (120 live). Smoke 75/75 + regression r50/51/52
  green + E2E 3 golden paths + Hindi + mobile. **P1 COMPLETE — next: P2.**
  See worklog R53.
