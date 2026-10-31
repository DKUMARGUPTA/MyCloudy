# DocoPDF — Phase Plan (Bentopdf Gap Closure)

> **Owner directive (2026-10-31):** "Phase wise plan banao, skill + discipline
> ka use kar ke sab kuch implement karo — zero mistake ke saath."
>
> **Source of gaps:** bentopdf fresh audit (R50) — 125 tools + 80 workflow
> nodes vs our 107 (then). This document is the FORMAL phase-wise plan that
> the NEXT-STEPS.md queue executes. Status updates happen per round in
> NEXT-STEPS.md (DONE log) — this file changes only when a phase's SCOPE
> changes (add/remove/reorder tools).
>
> **Legal red line:** bentopdf is AGPL. ZERO code copy, ZERO dependency —
> ideas only. Everything builds on our own engine (`src/lib/own/pdf`).

## Discipline contract (every phase, every batch)

1. **Check** — before coding: confirm the gap is real (no existing tool covers
   it), confirm the engine supports it, confirm the R48 anatomy applies.
2. **Verify** — smoke battery (own engine + pdf-lib as DEV ORACLE only),
   `bun run lint` + `bunx tsc --noEmit` zero errors, agent-browser E2E on the
   golden path (desktop + mobile 390px + Hindi locale + console errors = 0).
3. **Implement** — tools/<id>/{config,worker,worker-lib} + registry + configs
   + tool-seo + i18n error keys (merge script) + smoke file, ONE commit.
4. **Document** — worklog.md append + CONTEXT-MEMORY.md header + NEXT-STEPS.md
   DONE entry + `MYCLOUDY_GH_TOKEN=*** bash scripts/push-github.sh` (push =
   durable; disk is ephemeral).
5. **Never** copy competitor code, never fake a capability (honest refusals
   for nothing-to-do / unsupported inputs), never re-enable deferred AI tools.

## Honest coverage decisions (verified 2026-10-31, R53)

These bentopdf "tools" are ALREADY COVERED by an existing DocoPDF tool —
building a duplicate would split SEO and confuse users, so they are mapped,
not duplicated:

| bentopdf tool | Covered by (DocoPDF) | Note |
|---|---|---|
| fix-page-size | `change-pdf-page-size` | Unify mixed sizes + scale fit/fill/none + A3/A4/A5/Letter/Legal/custom mm — superset of "standardize to uniform size". |
| linearize-pdf | `web-optimize-pdf` | Object-stream packing + recompression + unreferenced-object removal = the practical "fast web viewing" benefit. True /Linearized hint tables = P5 big rock if ever needed. |
| delete-pages / extract-pages / insert-from-pdf / reorder | `extract-pdf-pages` + `organize-pages` + `merge-pdf` | Full set already live. |
| pdf-to-images (generic) | `pdf-to-jpg/png/webp` family | Live. |
| rotate-pdf | `rotate-pdf-pages` + `rotate-custom` | Live. |

## Phase status board

| Phase | Scope | Status |
|---|---|---|
| P1-a | Quick-win batch 1 (6 tools) | ✅ DONE (R50) |
| P1-b | Raster color family (4 tools) | ✅ DONE (R51) |
| P1-c | Output pack (4 tools) | ✅ DONE (R52) |
| **P1-d** | **Page utils (3 new + 2 covered-by)** | **✅ DONE (R53)** — duplex-collate, remove-annotations, page-dimensions; fix-page-size→change-pdf-page-size, linearize→web-optimize (mapped) |
| **P2** | **AI differentiators (self-dependent, on-device)** | **✅ DONE (R54)** — summarize TextRank, Ask PDF BM25, prepare-pdf-for-ai LlamaIndex JSON; 124 tools / 123 live / 1 deferred |
| P3 | Format expansion (import/export/attachments) | ⬜ |
| P4 | Programmatic SEO + traffic | ⬜ |
| P5 | Big rocks (multi-tool grid, workflow, deskew, tables, text edit) | ⬜ |
| P6 | Platform (PWA, config.json, more languages) | ⬜ `[owner]` gates |

---

## P1 — Quick-win tool batches (own engine, R48 anatomy)

**Acceptance criteria (every batch):** registry+configs+seo+i18n wired; smoke
battery green (own engine runs, pdf-lib only as oracle); lint+tsc zero;
browser E2E golden path + mobile + Hindi; worklog/memory/queue updated; pushed.

### P1-d — Page utils (R53) ✅
- `duplex-collate` — scanner's two-block output (all fronts, then all backs)
  → proper front/back interleaved order. Options: block layout (fronts/backs
  first) × flip edge (short/long) + odd-page blank pad. Refusal when the
  plan is identity (nothing to do). Engine: `organizePages` plan.
- `remove-annotations` — GRANULAR strip (distinct from one-tap sanitize):
  markup (comments/highlights/drawings/stamps) ON by default, links OFF,
  form widgets OFF; page-range targeting; whole-doc option. Engine:
  `rewriteDocument` replacements (page dicts patched, /AcroForm survives
  when form fields are KEPT — the preserve path, not the rebuild path).
- `page-dimensions` — dedicated analyzer: per-page w×h in pt/mm/inch,
  orientation, standard size-name detection (A4/Letter/Legal/A3/A5/B5/
  Tabloid/Statement/Executive ±2pt), mixed-size grouping, TXT/JSON report.
  Engine: `listPages` boxes (read-only).
- ~~fix-page-size~~ → covered by `change-pdf-page-size` (mapped above).
- ~~linearize-pdf~~ → covered by `web-optimize-pdf` (mapped above).

## P2 — AI differentiators (self-dependent, on-device, honest) — ✅ DONE (R54)

Delivered exactly as scoped (detail: worklog R54, smoke-p2-ai 77/77):
summarize-pdf TextRank extractive + Ask PDF BM25 smart search +
prepare-pdf-for-ai LlamaIndex JSON export; registry 124/123/1 (only
translate-pdf stays deferred — genuinely provider-backed); provider-era
/api/chat + /api/summarize routes and old surfaces retired; i18n ask.*
(5150=5150). Original scope (kept for the record):

1. **`summarize-pdf`** — TextRank/TF-IDF extractive sentence scoring in a
   Web Worker (pdf.js text extraction), page citations, honest copy
   ("extractive summary", no LLM claims).
2. **`chat-with-pdf` → "Ask PDF (smart search)"** — BM25 retrieval + ranked
   snippets + page numbers. Search-grade, not chat-grade — honest naming.
3. **`prepare-pdf-for-ai`** — PDF → LlamaIndex-style JSON export (text
   chunks + metadata + page map) for RAG pipelines. AI-first positioning.
4. Re-enable flow per 08-PLAN §Deferred: registry `enabled:true` flips +
   SEO + i18n — WITHOUT provider env keys (the tools are now self-dependent).

**Acceptance:** each tool works offline with 0 network requests; extractive/
BM25 quality sanity-checked on bilingual (en/hi) fixtures; smoke + E2E green;
GSC resubmission note in worklog.

## P3 — Format expansion (importers/exporters/attachments)

Batches (order = value/effort):
- **P3-a export pack:** `pdf-to-json`, `pdf-to-csv` (text → CSV heuristics),
  `pdf-to-cbz` (raster pages → comic archive, own zip engine STORE).
- **P3-b import pack 1 (text-ish):** `csv-to-pdf`, `json-to-pdf`,
  `xml-to-pdf` (data → tabular render, own create engine).
- **P3-c import pack 2 (image/docs):** `bmp-to-pdf`, `psd-to-pdf` (flatten
  composite), `cbz-to-pdf`, `email-to-pdf` (EML parse), `mobi/fb2/odg/odp/
  ods/wpd/wps/vsd/xps→pdf` (HONEST: those needing LibreOffice-class layout
  engines get either a best-effort text/image path or a documented refusal —
  never a fake).
- **P3-d attachments cluster:** `add-attachments` (embed files),
  `extract-attachments`, `remove-attachments` (embedded-files name tree).
- **P3-e toc:** `table-of-contents` (auto TOC page + outline + internal links).

**Acceptance:** every format roundtrip tested (fixture in → open in pdf-lib
oracle + Chrome via agent-browser); embedded-file spec compliance (names tree
+ /EF streams); honest refusals for unsupported sub-formats.

## P4 — Programmatic SEO + traffic

- Compress-size landing routes: `compress-pdf-to-100kb/200kb/500kb/1mb` +
  `compress-pdf-to-50kb` + `compress-pdf-high-quality` (7 variants) reusing
  the real `compress-pdf-to-size` tool with preset defaults + canonical
  links to the parent tool.
- Blog seed: 3 competitor-alternative posts (own words, own screenshots).
- `seo-audit`-style script (own implementation): meta/OG/canonical/h1 checks
  across all tool surfaces.

**Acceptance:** each landing route renders the tool with the preset applied,
canonical → parent, no duplicate-content footprint; blog posts bilingual.

## P5 — Big rocks (longest game, one per round minimum)

1. `pdf-multi-tool` — unified organize grid UI (select/reorder/rotate/delete
   pages of many files in one surface).
2. `pdf-workflow` — visual step-chain pipeline (start LINEAR: pick tools +
   order + run sequentially; nodes graph later).
3. `deskew-pdf` — skew detect (Hough/projection profile) + rotate-custom fix.
4. `extract-tables` — ruling/whitespace heuristics → CSV.
5. `edit-pdf-text` — in-place paragraph edit (hardest; honest scope TBD).
6. `font-to-outline`, `pdf-layers` (OCG), `timestamp-pdf` (RFC 3161 [owner]
   — needs TSA choice).

**Acceptance:** per-tool; multi-tool/workflow need full E2E drag-drop +
undo + mobile sheet QA.

## P6 — Platform

- PWA + Service Worker offline shell — `[owner]` (storage/UX tradeoffs).
- `config.json` runtime tool-disable (no-rebuild on/off).
- More languages — `[owner]` (24 in bentopdf vs our en+hi; effort heavy).

## Continuous (every round, parallel)

- UX/UI polish: ONE surface per round (hover, focus rings, spacing rhythm,
  empty states, mobile sheet). Details compound.
- Rotation QA duty: browser E2E spot-check of a random live tool family.

---

*Plan author: lead agent, R53 (2026-10-31). Executed via NEXT-STEPS.md
queue; every DONE entry carries its commit hash — the audit trail.*
