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
- Importers: csv/json/xml-to-pdf, bmp/psd, cbz (comics), email-to-pdf (EML),
  mobi, fb2, odg/odp/ods (LibreOffice family), wpd/wps, vsd, xps.
- Exporters: pdf-to-bmp, pdf-to-json, pdf-to-csv, pdf-to-cbz.
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
