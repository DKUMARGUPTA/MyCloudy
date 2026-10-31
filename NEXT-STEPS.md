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

## Queue (top = highest priority)

### 1. AI tools re-enable — Phase 1: zero-dependency NLP (summarize + chat)
**Context:** Owner (2026-10-31): "3 AI tools ke liye self-dependent banna hai,
koi AI par dependency nahi." Plan approved direction: classical on-device NLP.
**Work:**
- `summarize-pdf`: TextRank/TF-IDF sentence scoring in a Web Worker (own
  code), page citations from the existing page-marked extract; honest
  "extractive summary" UX copy (no LLM claims).
- `chat-with-pdf` → reposition "Ask PDF (smart search)": BM25 search +
  snippet + page-number answers, 100% on-device.
- Re-enable flow per 08-PLAN §Deferred (registry flips + SEO + i18n) —
  but WITHOUT any provider env (self-dependent).
**Done-when:** both tools live on prod, smoke script green, SEO pages 200.
**Est:** 2–3 cron rounds (split: summarize first, chat second).

### 2. BentoPDF Batch 2 — 4 low-risk own-engine tools
**Context:** R48 pattern is proven (registry+config+worker+seo+i18n+smoke).
**Candidates (in order):** `bates-numbering` (stamp family, legal use-case,
India angle) → `pdfs-to-zip` (fflate zip output, outputKind "zip") →
`invert-pdf-colors` + `pdf-to-greyscale` (raster family via existing
pdf.js render path) → `scanner-effect` (raster + noise/rotate — fun).
**Done-when:** each tool: smoke + E2E golden path + prod 200 (R48 anatomy).
**Est:** 1 round per 1–2 tools.

### 3. UX/UI polish continuation (owner dissatisfaction follow-through)
**Context:** R47 fixed owner-badge logic + card polish; owner's broader
"UX/UI/layout pasand nahi" needs a systematic pass, not one-off fixes.
**Work:** pick ONE surface per round: tool landing states → result view →
category pages → homepage hero. Details bar (R47 §7-8 pattern): hover
states, focus rings, spacing rhythm, empty states, mobile sheet.
**Done-when:** agent-browser before/after screenshots + console clean.
**Est:** continuous, 1 surface per round, low priority when queue busy.

### 4. Programmatic SEO landing pages (compress-to-100KB style)
**Context:** BentoPDF ranks on "compress pdf to 100kb" style queries via
static pages. We have `compress-pdf-to-size` — make curated landing
routes (`/tool/compress-pdf-to-100kb` etc.) that reuse the real tool.
**Watch:** Next.js route discipline (only `/` renders in sandbox — verify
via agent-browser + prod). Canonical links to the real tool.
**Est:** 1 round for 5 variants + SEO entries.

### 5. PWA / Service Worker offline shell
**Context:** BentoPDF ships SW offline; our engines are all self-hosted
already — an app-shell SW would make repeat visits instant.
**Watch:** CSP rules doc (02), no third-party origins; cache versioning.
**Est:** 1–2 rounds. `[owner]` — needs owner OK (storage/UX tradeoffs).

## Blocked / Waiting

- **translate-pdf re-enable** — `[owner]` needs decision: browser-local
  model (transformers.js, ~30-80MB per language download) vs stay deferred.
- **Real billing (Razorpay/Stripe)** — `[owner]` explicitly frozen
  (2026-10-31: "abhi nahi lagna hai"). Do NOT touch.
- **GA4** — optional, needs `NEXT_PUBLIC_GA_ID` from owner.
- **AI provider env keys** — superseded by item 1 (self-dependent path).

## DONE (append-only log)

- **R48 (2026-10-31):** 6 tools batch 1 (reverse/add-blank/divide/
  combine-single/booklet/sanitize) — prod live, 106 tools. `081ab67`
- **R48-pre (2026-10-31):** pre-batch push + bentopdf audit. `1883198`
- **R49 (2026-10-31):** agent system + auto-work queue shipped (Scout/Builder/Auditor + NEXT-STEPS + autopilot skill). Docs-only, dry-run verified. See worklog.
