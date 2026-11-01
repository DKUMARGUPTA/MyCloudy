# DocoPDF — Parity & Moat Roadmap (bentopdf audit se, 2025-11-02)

> **Source of truth for the pending phase execution.** Har phase: check → verify → implement →
> tsc+lint+smoke → worklog+CONTEXT-MEMORY → git push. Koi phase-approval gate nahi — continuous.
>
> **Audit basis:** bentopdf (alam00000/bentopdf) 125 tool pages vs DocoPDF 100 registry tools
> (97 live + 3 AI deferred). Audit sirf BEHAVIOR reference ke liye —
> **AGPL RED LINE: zero code copy, zero dependency, zero port. Sab khud, apne engine pe.**

## Skip (already ahead ya deliberately out)

e-invoice suite (create/validate/xml/pdf-to) · request-signature · passport-photo · photo-collage ·
create-card / create-resume / create-invoice · password+QR generators · halve-pdf-pages · scan-pdf ·
web-optimize-pdf (linearize) · validate-pdfa · verify-signatures · edit/annotate suite ·
form-filler/form-creator · redact · ocr · compare · repair · AI suite (deferred R23) ·
odg/odp/ods/vsd/wpd/wps/xps/psd/email-to-pdf (LibreOffice server-side — Phase-11 worker turf).

## Phase 1 — Page-ops quick wins (18 tools, 3 batches × 6)

Sab apne **own engine** (`src/lib/own/pdf/`) pe. Har tool: registry entry + render + worker + smoke.

| Batch | Tools |
|---|---|
| **A** | reverse-pages · add-blank-page · divide-pages · combine-single-page · pdf-booklet · sanitize-pdf |
| **B** | bates-numbering · remove-blank-pages · alternate-merge · add-page-labels · rotate-custom · view-metadata |
| **C** | background-color · add-stamps · change-permissions · duplex-collate · pdf-to-zip · remove-annotations |

**Acceptance:** har tool ka smoke PASS + registry live + E2E golden path (agent-browser) + i18n EN/HI.
**Risk:** page-labels number-tree (own writer se /PageLabels); sanitize (object-graph surgery —
rewriteDocument seams); remove-blank-pages (content-analysis false positives — conservative sniff).

## Phase 2 — prepare-pdf-for-ai (LlamaIndex JSON export)

Bentopdf ka flagship AI-prep tool: PDF → structured JSON (pages, text blocks, tables, images,
metadata) LlamaIndex-ready. Humara pdf.js worker pipeline reuse + apna schema.
**Acceptance:** JSON schema smoke + real PDF E2E + AI-routes integration docs.

## Phase 3 — Chhote tools (~20)

add-attachments · extract-attachments · edit-attachments · page-dimensions · invert-colors ·
pdf-to-greyscale · pdf-to-bmp · bmp-to-pdf · csv-to-pdf · json-to-pdf · xml-to-pdf ·
table-of-contents · timestamp-pdf · scanner-effect · posterize-pdf · font-to-outline ·
adjust-colors · text-color (agar feasible) · pdf-layers · pdf-to-cbz / cbz-to-pdf.
**Batches:** attachments×3 → colors×4 → converters×6 → finishing×7.

## Phase 4 — Programmatic SEO (compress-size landing pages)

7 landing routes: compress-pdf-for-email + to-100kb / 200kb / 500kb / 1mb / 2mb (+ existing
compress-pdf-to-size anchor). Har page: unique copy + FAQ JSON-LD + hreflang + sitemap.
**Acceptance:** sitemap me naye URLs, SSR head verified, 0 console errors.

## Phase 5 — Multi-tool grid UI

Bentopdf ka pdf-multi-tool: merge/split/organize/delete/rotate/blank/extract/duplicate ek unified
page-grid interface me. Humare organize surfaces ka upgrade — naya standalone surface.
**Acceptance:** page-grid CRUD E2E + undo stack + mobile 390 clean.

## Phase 6 — Workflow builder (visual pipeline)

Node-based pipeline editor (add-node → chain tools → run end-to-end). Ye sabse bada UI investment
hai — 80-node library Phase 1+3 ke tools se auto-build hogi.
**Acceptance:** 3-tool pipeline E2E (compress → watermark → page-numbers) + save/load JSON.

## Phase 7 — Hardest (engine-level, last)

font-to-outline (text→bezier content-stream surgery) · text-color (existing text recolor) · edit-pdf-text (in-place text editing with reflow) · extract-tables (structure detection) ·
deskew-pdf (raster rotation detection + content transform) · text-color (existing text recolor).
**Risk:** highest — inse hi matlab hai ki ye LAST rakha gaya. Har ek ka dedicated round.

## RituaI (har batch — BINDING)

1. `bunx tsc --noEmit` = 0 · `bun run lint` = 0
2. Batch smoke `bunx tsx scripts/smoke-<family>.ts` = ALL PASS
3. `worklog.md` entry + `CONTEXT-MEMORY.md` header/recent update
4. `MYCLOUDY_GH_TOKEN=*** bash scripts/push-github.sh`
5. agent-browser E2E golden path (kam se kam batch ke 1 tool ka + regression spot)

## Status

- [x] Phase 0 — PHASE-PLAN.md (ye file)
- [x] Phase 1 — 18 tools (A / B / C) — COMPLETE 2025-11-02 (smokes 80+60+42, live count 118)
- [x] Phase 2 — prepare-pdf-for-ai — COMPLETE 2025-11-02 (smoke 23/23 + E2E JSON verified)
- [x] Phase 3 — chhote tools — **COMPLETE 2025-11-02: 19 tools (b1:5 + b2:6 + b3:7 + b4:1), live 135/138**
  - [x] Batch 1 — add/extract-attachments · invert-colors · pdf-to-greyscale · page-dimensions (R31, smoke 25/25)
  - [x] Batch 2 — edit-attachments · adjust-colors · posterize-pdf · scanner-effect · timestamp-pdf · table-of-contents (R32, smoke 41/41 + 5 E2E goldens; ⚠️ pdfjs data-detach → .slice() fix)
  - [x] Batch 3 — converters: csv/json/xml-to-pdf · pdf-to-bmp · bmp-to-pdf · pdf-to-cbz · cbz-to-pdf (R33, smoke 50/50; ⚠️ PNG IDAT zlib + BMP palette R/B engine bugs FIXED; own BMP/PNG codecs shipped)
  - [x] Batch 4 — pdf-layers (R34, smoke 34/34 + E2E; font-to-outline + text-color Phase 7 mein MOVE — engine-level surgery, honest split).
- [x] Phase 4 — SEO landing pages — COMPLETE 2025-11-02 (6 compress landings × EN+HI, toolPreset chain, R35)
- [ ] Phase 5 — multi-tool grid
- [ ] Phase 6 — workflow builder
- [ ] Phase 7 — hardest trio
