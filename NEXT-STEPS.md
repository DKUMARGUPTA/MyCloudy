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
- **P1-b: raster color family** — `invert-pdf-colors`, `pdf-to-greyscale`,
  `scanner-effect`, `posterize-pdf` (pdf.js render → pixel transform →
  rebuild; reuse rasterize-pdf path).
- **P1-c: output pack** — `pdfs-to-zip` (own STORE-zip writer, zero deps)
  + `rotate-custom` (arbitrary angle, not just 90°) + `view-metadata`
  (read-only inspector) + `change-permissions` (perm-only lock).
- **P1-d: page utils** — `duplex-collate`, `fix-page-size`, `page-dimensions`,
  `remove-annotations`, `linearize-pdf`.

### P2 — AI differentiators (self-dependent, on-device)
- `summarize-pdf`: TextRank/TF-IDF sentence scoring in Web Worker, page
  citations, honest "extractive summary" copy (no LLM claims).
- `chat-with-pdf` → "Ask PDF (smart search)": BM25 + snippet + page numbers.
- `prepare-pdf-for-ai`: PDF → LlamaIndex-style JSON export for RAG pipelines
  (pdf.js text extraction + JSON formatter; AI-first positioning).
- Re-enable flow per 08-PLAN §Deferred (registry flips + SEO + i18n) —
  WITHOUT any provider env.

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
