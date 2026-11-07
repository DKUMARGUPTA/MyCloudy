# DocoPDF — Tool-by-Tool Testing Plan (Master QA Doc)

> **Scope:** All **144 enabled tools** across **11 categories** — one-by-one testing, tracked in this doc.
> **Method:** Every tool gets the same 8-point checklist (below), executed via agent-browser against `localhost:3000`.
> **Cadence:** 8–12 tools per round. Status updated after every round. Bugs filed via the site's **Report a bug** flow (visible in Admin → Bugs tab).

---

## 1. Standard per-tool checklist (T1–T8)

| # | Check | What to verify |
|---|-------|----------------|
| T1 | **Route loads** | `/tool/{id}` returns 200; no error boundary; no console/runtime errors in dev.log |
| T2 | **i18n EN** | English page: title, description, buttons, options all in English — no raw keys (`tools.xxx`) |
| T3 | **i18n HI** | `/hi/tool/{id}` renders Hindi correctly (no missing translations, no broken Devanagari) |
| T4 | **Input accept** | Drop zone accepts the tool's `accepts` type (pdf/image/text/any); wrong type shows rejection message |
| T5 | **Options panel** | Tool options render; controls (sliders, selects, inputs) respond; defaults sensible |
| T6 | **Process → Output** | Sample file processes end-to-end; progress view shows; result view + download button appear; output file is valid |
| T7 | **Mobile (375px)** | Layout holds; touch targets ≥ 44px; no horizontal scroll; sticky footer correct |
| T8 | **Dark mode** | Theme toggle: colors, borders, contrast OK on tool page |

**Status legend:** ⬜ not tested · ✅ pass (all 8) · 🟡 partial (minor issue) · ❌ fail (bug filed)

---

## 2. Priority tiers (popularity-based)

| Tier | Rule | Count | Why first |
|------|------|-------|-----------|
| **A** | popularity ≥ 50 | 19 | Highest traffic — breakage hurts most |
| **B** | popularity 20–49 | 45 | Core long-tail |
| **C** | popularity < 20 | 80 | Niche; smoke-test level (T1–T3 + T7 always, T4–T6 sampled) |

---

## 3. Round schedule

| Round | Scope | Status |
|-------|-------|--------|
| R51 | **QR & Barcodes (all 3)** + mega-menu QR category + Tier-A spot-check (merge e2e, split, compress routes) | ✅ done |
| R52 | Tier A: edit-pdf, sign-pdf, word-to-pdf, pdf-to-jpg, pdf-to-word | ✅ done — 5/5 e2e PASS + 1 UX fix shipped |
| R53 | Tier A: lock-pdf, unlock-pdf, jpg-to-pdf, pdf-to-png, rotate-pdf-pages | ✅ done — 5/5 e2e PASS (security round-trip verified) |
| R54 | Tier A: pdf-to-txt, scan-pdf, view-pdf, convert-to-pdf, images-to-pdf, png-to-pdf | ✅ done — 6/6 e2e PASS + 1 critical bug fixed (scan→OCR chain) + layout-audit fixes |
| R55 | Tier A remainder + Tier B start (edit category: watermark, fill, page numbers, crop) | ✅ done — 4/4 e2e PASS + rG operator bug fixed + success-badge polish + Copy-text feature |
| R56–R62 | Tier B by category (organize → edit → convert-to → convert-from → security → optimize → create) | 🔄 R56 done — organize 4/4; R57 done — convert-to 4/4 PASS + vertical-mirror render bug fixed + duplicate options panel fixed; R58 done — convert-from 4/4 PASS + probe-cols bug fixed + mini-grid/outline/AI-chips features |
| R63–R66 | Tier C by category (incl. invoices, view, images) — smoke level | ⬜ |
| R67 | Full regression: home, /tools, all 11 category pages EN+HI, search palette, footer | ⬜ |

---

## 4. Category inventory & per-tool status

### QR & Barcodes — `/tools/qr` (3 tools) — R51 focus

| Tool | ID | Accepts | Status | Notes |
|------|----|---------|--------|-------|
| Generate QR code | `generate-qr-code` | any | ✅ | T1–T6 pass: preview live, PNG/SVG/PDF downloads valid, HI i18n full, decode round-trip OK (`https://docopdf.com`) |
| Generate barcode | `generate-barcode` | any | ✅ | T1–T3, T5 pass; EAN-13 check-digit auto-calc OK; SVG/PDF downloads OK; PNG export function verified directly (351×90 valid PNG) — agent-browser download-interception flake only, not a site bug |
| Scan QR code | `scan-qr-code` | image | ✅ | T1–T4, T6 pass: upload → decoded Link card + Copy/Open actions; **note:** description says "QR or barcode" but 1D barcode decode is not supported (documented honestly in page FAQ) |

**R51 round report (2026-11-03):**
- ✅ **Mega-menu fix:** `qr` category was missing from header navigation (`MORE_CATEGORIES`) — added; now all 11 categories surface in header.
- ✅ `/tools/qr` page: heading, 3-tool grid, SEO title, category intro, MORE CATEGORIES section all render.
- ✅ **End-to-end round-trip:** generate-qr-code (PNG) → scan-qr-code upload → decoded `https://docopdf.com/` — both tools verified in one flow.
- ✅ **merge-pdf e2e:** 2 × 2-page sample PDFs → merged 4-page output downloaded (valid PDF 1.7).
- ✅ Mobile 375px: no horizontal scroll; buttons wrap in 2-col grid.
- ✅ Dark mode: readable; minor contrast note — active "एक QR" tab teal-on-dark-teal slightly low contrast (cosmetic, not blocking).
- 🟡 Cookie consent banner covers download buttons until dismissed (expected; first-visit UX only).
- 🟡 scan-qr-code description wording: "read the QR or barcode inside" → soften to "read the QR inside" for accuracy (low priority).

**R58 round report (2026-11-07, cron review) — Tier-B convert-from category 4, 4/4 e2e PASS + probe display bug fixed + 3 features shipped:**
- 🔧 **PROBE-COLS DISPLAY BUG FIXED (pdf-to-excel):** the "Page 1 grid" readout used `finalGrid[0].length` for its column count — a ruled table with prose above it (title line, 1 cell) reported "7 rows × 1 columns" for a 4-column table. The grid itself was always correct (the xlsx proved it); only the pre-run readout lied. **Fix:** cols = max row length across the grid (plus out-of-table rows now span like merged cells in the preview).
- ✅ `pdf-to-excel` e2e: bordered invoice fixture (4 cols × 5 rows + prose) → real .xlsx workbook — OOXML inlineStr cells, numbers as true numeric cells (`t="n"`: 3, 42.5, 127.5), bold header row, ruled lattice read cell-for-cell; per-page vs single-sheet modes present; JPG rejected by the %PDF sniff. Borderless fixture → "No borders — position clustering" badge path verified.
- ✅ `extract-tables` e2e: same fixture → "1 table found and exported", ZIP contains `tables-p1-t1.csv` with exact RFC-style rows (Item,Qty,Unit Price,Total + 4 data rows), prose above the table correctly excluded; Comma/ZIP options present.
- ✅ `pdf-to-powerpoint` e2e: 3-page text PDF → 3-slide .pptx, each slide 2 shapes (title + body), UNIQUE-R58 markers + em-dash intact in slide XML, 16:9 default (12192000×6858000 EMU), Calibri typeface refs; images-mode and Match-page options present; scan warning state verified with an image-only PDF.
- ✅ `prepare-pdf-for-ai` e2e: 3-page PDF → `_llm.json` with 3 LlamaIndex documents {text, metadata: page_id / total_pages / file_path / format / type / dates}; chunked granularity + JSONL rendering verified at worker-lib level (2 chunks, valid JSONL lines).
- ✨ **Feature: Live mini-grid preview (pdf-to-excel):** the "Detected layout" card now renders the actual detected page-1 grid as a mini spreadsheet — first 6 rows × 8 cols, short rows span like merged cells, header row highlighted, cell truncation with title tooltips, "+N more rows/cols" overflow notes (ICU-pluralized — "+1 more row" not "+1 more rows"). A detector badge names the winning path: emerald "Bordered table — exact cell grid" vs muted "No borders — position clustering". VLM-reviewed clean (merged-cell rendering confirmed).
- ✨ **Feature: Pre-run slide outline (pdf-to-powerpoint):** numbered pill chips (R57 powerpoint-to-pdf pattern) showing each page's prospective slide title — largest text item per page (height heuristic, tie-break by y), blank pages show italic "No text on this page", "+N more" fold after 8 chips, 30-page probe cap. Works in both text and images mode; EN + HI.
- ✨ **Feature: AI stat chips (prepare-pdf-for-ai result):** "3 AI-ready documents" + "~63 tokens of text (estimate)" (chars/4, Intl-compact formatted) on the result card — the honesty signal for the RAG use case; EN + HI verified.
- ✅ Cross-checks: Hindi workspace for all 3 surfaces (पेज 1 ग्रिड: 7 पंक्तियाँ × 4 कॉलम, बॉर्डर वाली टेबल — सटीक सेल-ग्रिड, स्लाइड आउटलाइन, इस पेज पर टेक्स्ट नहीं, +1 पंक्ति और, 3 AI-तैयार दस्तावेज़, ~63 टोकन); mobile 375px no-overflow on all 4 tools (outline chips wrap 2-per-row, VLM-verified); i18n parity 5364=5364; lint 0; dev log clean.
- 📝 Note: my first pptx test fixture was invalid (fonts embedded in doc A used in doc B — cross-document refs → "font resource is not a dictionary"), which initially looked like a tool bug; regenerated cleanly. Lesson: pdf-lib fixtures must embed fonts per document.

**R57 round report (2026-11-07, cron review) — Tier-B convert-to category 4, 4/4 e2e PASS + 2 bugs fixed + slide-outline feature:**
- 🔧 **VERTICAL-MIRROR RENDER BUG FIXED — every PowerPoint slide's text was drawn upside-down:** pptx slide geometry is top-down (y from the slide's top edge) but PDF y grows upward from the bottom-left origin; the renderer passed `shape.y` straight through, so a title at y=30 rendered 94% DOWN the page (bottom-left) and body text stacked upward — the whole slide vertically mirrored. Content-level asserts (pdftotext, smoke 104-check) never caught it because the text was all there, just positioned wrong — a VLM e2e position check ("Cover Title at bottom-left?") exposed it. **Fix (tools/powerpoint-to-pdf/render.ts):** the slide loop now converts the shape's top edge to PDF space (`oy + (slideH − shape.y)·scale`) and `drawTextBox` walks paragraphs DOWN the page from it — the same PDF-space convention the speaker-notes path already used (which is why notes pages were correct while slides mirrored). Verified: "Cover Title" now at 7-11% down (was 95-99%), slide-native + A4-letterbox + fit + notes paths all pixel-checked. **Smoke guard added:** the first text draw (the title) must sit at PDF y ∈ (400, 530) on the 540pt page — the old bug lands it at ~0-5, so this class of regression can never pass silently again (105 checks now).
- 🔧 **Duplicate options panel fixed:** powerpoint-to-pdf rendered its custom "Layout" card (page size / margins / notes / fit) AND the generic "Options" aside — the same 4 controls twice on one page. Fix: `fullWidthSurface: true` in the config (excel-to-pdf precedent) — the inline card is the single source of truth.
- ✅ `powerpoint-to-pdf` e2e: deck summary (3 slides / 5 shapes / 20 words / 3 est. pages), EN + Hindi slides (Noto Sans Devanagari embedded + Indic shaped), slide order follows presentation.xml sldIdLst (not filename order), speaker-notes pages ("Slide 1 — notes" headings + notes text), A4-landscape + fit-to-width letterbox framing.
- ✅ `excel-to-pdf` e2e: sheet checkboxes (All/Sheet1), 3-row fixture → 1-page A4 portrait, "Sheet1" bold title + rule, gray header row, gridlines, zebra option, "Sheet 1 of 1" footer — VLM-verified clean table.
- ✅ `heic-to-pdf` e2e: real HEIF/HEVC fixture (`file`-verified) decoded in-browser by the self-hosted libheif WASM (Chrome), ImageGrid accepts + converts to 1-page A4 auto-landscape; corner-color round-trip vs ffmpeg decode (dark TL / pink TR / green BL / yellow BR) — faithful.
- ✅ `webp-to-pdf` e2e: VP8 WEBP → PNG transcode → 1-page A4 auto-landscape, "WEBP FIXTURE R57" text + orange circle + purple background survive (VLM).
- ✅ Dispatcher (convert-to-pdf): .pptx upload → "PowerPoint to PDF" recommendation card → click chains with file carried over; .xlsx → "Excel to PDF" card likewise.
- ✨ **Feature: Slide outline chips** (powerpoint-to-pdf workspace) — numbered pill chips showing each slide's title text (title shape preferred, first text fallback, "No text" for empty slides), a teal "notes" badge on slides carrying speaker notes, "+N more" overflow for decks > 8 slides; EN + HI labels.
- ✨ **Styling:** stat tiles upgraded — per-stat Lucide icons in teal circular badges (Presentation/Shapes/Type/Files), big tabular number + small uppercase label, hover border/bg states; VLM-reviewed clean.
- ✅ Mobile 375px: no horizontal overflow (scrollWidth == 375) with the new tiles + chips; Hindi workspace fully localized (सारांश, रूपरेखा, कोई टेक्स्ट नहीं, नोट्स). Lint 0, dev log clean.


**R56 round report (2026-11-07, cron review) — Tier-B organize category 4, 4/4 e2e PASS + PageGrid race bug fixed + Reverse feature:**
- ✅ `split-pdf` (full e2e, was spot-check only): By-ranges "1-2, 3-5" → 2 exact parts (pages 1-2 / 3-5, pdftotext-verified); Every-N (N=2) → 3 parts 1-2/3-4/5 with descriptive filenames (five-part-1-pages-1-2.pdf…); per-part downloads + Download-all-ZIP all verified.
- 🔧 **RACE BUG FIXED — PageGrid rapid-move data loss:** tapping "Move selection earlier/later" N times rapidly collapsed into 1 effective move — every click read the same stale React closure snapshot (pages + selection), so identical inputs no-op'd; worse, a late-resolving async page-count probe then re-installed the PRISTINE grid, silently discarding user edits made while detection was in flight (4 rapid clicks → output showed only 1 move). **Fix (tools/pagegrid/grid-surface.tsx, family-wide):** (1) eager `pagesRef`/`selectionRef` mirrors updated inside apply()/changeSelection()/install() so consecutive clicks always compute from the latest committed state; (2) moveSelected remaps the selection by page uid after the permutation (selection follows moved pages, not fixed indices); (3) install() preserves user edits when the probe resolves late (gridTouchedRef + same-file/same-count guard) instead of clobbering them. Verified: 4 rapid earlier-moves → page 5 slides to position 1, output order 5,1,2,3,4 exact; regression on rotate-pdf-pages rapid later-moves PASS.
- ✅ `rearrange-pdf-pages`: select + rapid moves (fixed), output order verified; dnd drag handles, undo/redo, duplicate/blank-page/delete actions present.
- ✅ `remove-pdf-pages`: range select "2-3" → deleted → output 1,4,5 exact.
- ✅ `extract-pdf-pages`: range select "1,3" → output pages 1,3 exact.
- ✅ New feature: **Reverse page order** — one-tap toolbar action (whole PageGrid family: rearrange/rotate/remove/extract/halve/divide/booklet/duplex-collate) for the classic "last page first" scan fix; toast confirmation; EN ("Reverse") + HI ("उलटें") labels verified.
- ✅ Styling: move earlier/later buttons now show visible labels on md+ ("Move up"/"Move down" — icon-only buttons were ambiguous in QA); disabled when no selection.
- ✅ Lint 0 errors. Dev log clean.

**R55 round report (2026-11-07) — Tier-B edit category 4, 4/4 e2e PASS + 1 PDF-spec bug fixed:**
- ✅ `add-watermark`: live preview ("3 of 3 pages marked"), default CONFIDENTIAL red diagonal semi-transparent stamp VLM-verified on all pages; custom text "DRAFT R55" round-trips; options: font/size/color presets/opacity slider/rotation/tilt.
- 🔧 **PDF-SPEC BUG FIXED — invalid `rG` operator in checkbox appearance streams:** every colored checkbox/radio "on" mark written by our engine emitted `0 0 0 rG` (invalid mixed-case) instead of `0 0 0 RG` — Poppler: "Unknown operator 'rG'"; strict viewers could drop the checkmark. Root cause: `fillOpToStrokeOp()` regex order — `/g$/` matched `rg` endings before the `/rg$/` branch. Fix (src/lib/own/pdf/stamp.ts): longest-suffix-first matching (`rg` → `RG`, `scn` → `SCN`, `k` → `K`, `g` → `G`). Verified: fill-out-pdf output streams all emit valid `RG`; pdftotext clean.
- ✅ `fill-out-pdf`: custom form fixture (2 text fields + checkbox) — fields auto-detected (3/3), click-to-jump boxes, "Auto-fill my details", typed values + checked box all render in output (VLM 3/3 PASS); Flatten toggle present; FDF import option.
- ✅ `add-page-numbers`: live preview, 3 pages stamped 1/2/3 bottom-right (pdftotext + VLM verified), formats/fonts/positions/pages selectors present.
- ✅ `crop-pdf`: margins Top 80/Left 150/Right 60/Bottom 120 → exact 385×642 pt output (595−150−60 × 842−80−120), content intact; drag handles + auto-detect + Before/After + per-page picker. Note: margin spinbuttons commit on blur/Tab (by design; agent-browser typing needs explicit Tab).
- ✅ New feature: **Copy text button** on single text/plain outputs (pdf-to-txt, OCR .txt) — one-tap clipboard copy with Copied! state + toast; EN+HI verified ("टेक्स्ट कॉपी करें" → "कॉपी हो गया!"); NOT shown on PDF outputs (conditional verified).
- ✅ Styling: result success badge upgraded to draw-in animated SVG (circle traces → checkmark draws, soft emerald halo ping, reduced-motion safe).
- ✅ Lint 0 errors. Dev log clean.

**R54 round report (2026-11-07) — Tier-A convert/create 6, 6/6 e2e PASS + 1 critical bug fixed:**
- ✅ `pdf-to-txt`: 3-page fixture → flow layout output; every page extracted incl. UNIQUE-MARKER-XYZ-9981; page-preview shows live word count (21 words p.1); options (Layout flow/lines, Pages ranges, Mark page breaks) all present. Download `.txt` verified.
- ✅ `view-pdf`: full-featured viewer — page nav (→ p.2 with UNIQUE-MARKER), zoom in/out, fit width, **rotate cycle 0→90→180→270→360° all render correctly** (full-canvas pixel + VLM verified), text layer in a11y tree, thumbnails/outline, presentation mode, print, dark reading mode buttons.
- 🔧 **CRITICAL BUG FIXED — scan-pdf "Detect text" chain broken:** chaining raw JPG scans into `ocr-pdf` (accepts: pdf) failed with silent "This PDF couldn't be read — it may be damaged" toast and reverted to workspace. **Fix (tools/ocr-pdf/worker.ts):** image inputs (JPG/PNG by magic bytes) are now wrapped into a fit-to-image single-page PDF via our own engine (CreateContext embedJpeg/embedPng) before the pdf.js+OCR pipeline; non-PDF/non-image → clean `tool.errorNotPdf` error (EN+HI added); output base name strips .jpg/.jpeg/.png. **Verified:** chain now completes — 92% OCR confidence, `pdftotext` on the output extracts the full scan text (UNIQUE-MARKER-XYZ-9981 present). Regression: native PDF input still works (93%).
- ✅ `scan-pdf` main flow: JPG → "Scan to PDF →" → 1-page A4 PDF, visual render verified (title + text + teal rect).
- ✅ `convert-to-pdf`: smart dispatcher — JPG input correctly recommends "Images to PDF"; click chains ("Chained from Universal converter") → images-to-pdf → A4 output. Router logic verified.
- ✅ `images-to-pdf`: 2 PNGs (portrait + landscape) → 2-page **auto-landscape A4** PDF; per-image rotate/reorder controls present; both pages VLM-verified (green rect + text; orange + yellow circle).
- ✅ `png-to-pdf`: single PNG → 1-page A4 landscape PDF, image placed with margins, VLM-verified.
- ✅ Lint: 0 errors. Dev log: clean. Console: only pre-existing dev-only warnings (GA boot script tag, Next dev overlay).

**Layout-audit round (2026-11-07, user-reported "layout issue"):** VLM-driven screenshot audit (home/tools/tool pages × 375px/1280px × light/dark) — 3 fixes shipped:
- 🔧 **Cookie consent banner → centered modal** (desktop) / **bottom-sheet** (mobile) with dimmed backdrop + slide/fade animation. Was a floating bottom-left card that awkwardly covered dropzones/cards (VLM: "blocking overlap"). Now role=dialog aria-modal, safe-area-aware, VLM-verified PASS both breakpoints.
- 🔧 **Next.js dev indicator ("N" floating button) disabled** (`devIndicators: false`) — was overlapping the mobile bottom-nav "Home" tab and the consent bottom-sheet.
- 🔧 **Category chip strip right-edge fade** (all-tools-view) — 40px white gradient signals horizontal scroll on mobile; VLM-verified ("Convert to PDF" chip fades out gradually).
- ✅ Horizontal-overflow JS check: scrollWidth == 375 on home + tools (no overflow).
- ℹ️ Toast z-index (z-100) correctly stacks above the consent modal (z-50) — no collision with centered modal/bottom-sheet.

**R53 round report (2026-11-04) — Tier-A security/convert/organize 5, 5/5 e2e PASS:**
- ✅ `lock-pdf`: sample.pdf + pw `r53secret` → qpdf confirms AESv3/R=6 encryption, `/Encrypt` present, no-password load rejected, password decrypts to 3 pages. Permission defaults sensible (print ✓, copy ✗). 26% size growth = encryption overhead, correctly shown.
- ✅ `unlock-pdf`: lock-pdf output → unlocked 2.7 KB PDF, opens without password, 3 pages intact. Wrong-password path shows "Something went wrong — That password is not correct." Full lock→unlock round-trip verified.
- ✅ `jpg-to-pdf`: 800×560 JPG → A4 **landscape** (Auto orientation smart pick), DCTDecode-embedded, VLM confirms text + shapes survive round-trip. Multi-file UI up to 50 images.
- ✅ `pdf-to-png`: live DPI preview ("Page 1 at 150 DPI → 875 × 583 px") matched output exactly; 3 RGBA PNGs + **Download all (ZIP)** verified; transparent-bg option present.
- ✅ `rotate-pdf-pages`: page-grid editor (thumbnails, range select, undo/redo, drag reorder, keyboard shortcuts). Verified: scope=All → all pages 180°; per-page button → page 2 only 90°; scope=Selected + page 2 → page 2 only 90°. Metadata (`/Rotate`) + visual render both correct.
- ℹ️ Investigated as suspected bug, confirmed **working-as-designed**: toolbar rotate uses an explicit "Apply to" scope (All/Selected/Odd/Even, default All) — selection alone doesn't scope toolbar actions; per-page buttons cover single-page cases.
- ✅ i18n: HI verified on lock ("पासवर्ड लगाएँ"), unlock ("लॉक हटाएँ"), jpg-to-pdf ("JPG से पीडीएफ़").
- ✅ Mobile 375px: lock result page + rotate **grid editor** both no horizontal scroll; 2-col thumbnail grid, toolbars wrap.
- ✅ Dark mode: VLM confirms crisp contrast; toast transiently overlaps "What next?" card (standard toast behavior, cosmetic).
- ℹ️ Footer tagline "Har PDF kaam, ek jagah." on EN pages = **intentional Hinglish branding** (hi.json uses Devanagari version) — not an i18n bug.
- ✅ Dev log + console: zero errors across all 5 tools.

**R52 round report (2026-11-04) — Tier-A top 5, 5/5 e2e PASS:**
- ✅ `edit-pdf`: full editor (11 toolbar tools, undo/redo, zoom, page thumbnails); text object added via real-mouse canvas interaction; 3-page edited PDF with embedded "R52 EDIT TEST" object.
- ✅ `sign-pdf`: date-stamp flow (create → place on page canvas → run); 3-page signed output. Hindi UI verified.
- ✅ `word-to-pdf`: DOCX fixture (own-zip) → valid PDF; text run decoded from content stream: "Second paragraph for conversion verification."
- ✅ `pdf-to-jpg`: 3 pages → 625×417 baseline JPEGs; VLM confirmed readable text on output.
- ✅ `pdf-to-word`: full text preservation (6 runs); auto-download design confirmed working.
- 🔧 **UX fix shipped:** pdf-to-word result card had NO re-download path (auto-download only) — a blocked/missed browser save left the user stranded. Added "Download again" button (EN+HI i18n) storing the blob in result state. Verified via re-run + click.
- ✅ Mobile 375px: no horizontal scroll on tool pages.
- ✅ Lint: 0 errors. Dev log: clean.

### Organize (26)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Merge PDF | `merge-pdf` | 100 | ✅ R51: e2e pass (2+2 → 4-page merged download) |
| Split PDF | `split-pdf` | 95 | ✅ R56: e2e — By-ranges (1-2,3-5 → exact 2 parts) + Every-N (N=2 → 1-2/3-4/5), ZIP + per-part downloads |
| Rotate PDF pages | `rotate-pdf-pages` | 68 | ✅ R53: e2e — full feature matrix verified (scope=All rotates all, scope=Selected rotates only selection, per-page buttons work); 180° metadata + visual render both correct |
| Rearrange PDF pages | `rearrange-pdf-pages` | 45 | ✅ R56: e2e — rapid-move race FIXED family-wide, output order exact; new Reverse action |
| Remove PDF pages | `remove-pdf-pages` | 42 | ✅ R56: e2e — range 2-3 removed → output 1,4,5 exact |
| Extract PDF pages | `extract-pdf-pages` | 40 | ✅ R56: e2e — pages 1,3 extracted exact |
| Workflow builder | `workflow-builder` | 34 | ⬜ |
| Multi-tool PDF | `multi-tool-pdf` | 30 | ⬜ |
| Copy from PDF | `copy-from-pdf` | 24 | ⬜ |
| Extract images | `extract-images` | 22 | ⬜ |
| Assemble PDF | `assemble-pdf` | 20 | ⬜ |
| Pages per sheet | `pages-per-sheet` | 18 | ⬜ |
| Table of contents | `table-of-contents` | 18 | ⬜ |
| Add blank page | `add-blank-page` | 16 | ⬜ |
| Halve PDF pages | `halve-pdf-pages` | 14 | ⬜ |
| Divide pages | `divide-pages` | 14 | ⬜ |
| PDF booklet | `pdf-booklet` | 14 | ⬜ |
| Alternate merge | `alternate-merge` | 14 | ⬜ |
| Duplex collate | `duplex-collate` | 14 | ⬜ |
| Add attachments | `add-attachments` | 14 | ⬜ |
| Bookmark PDF | `bookmark-pdf` | 14 | ⬜ |
| Reverse pages | `reverse-pages` | 12 | ⬜ |
| Combine single page | `combine-single-page` | 12 | ⬜ |
| Rotate custom | `rotate-custom` | 12 | ⬜ |
| Deskew PDF | `deskew-pdf` | 12 | ⬜ |
| Edit attachments | `edit-attachments` | 12 | ⬜ |

### Edit (25)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Edit PDF | `edit-pdf` | 90 | ✅ R52: e2e — editor loads (11 tools, undo/redo, zoom, thumbnails), text object added via real-mouse canvas click, "R52 EDIT TEST" embedded, 3-page edited PDF downloaded |
| Add watermark | `add-watermark` | 55 | ✅ R55: e2e — default + custom text stamps, all 3 pages, VLM-verified semi-transparent diagonal |
| Fill out PDF | `fill-out-pdf` | 50 | ✅ R55: e2e — 3/3 fields detected+filled+checked (VLM); rG appearance-stream bug FIXED |
| Add page numbers | `add-page-numbers` | 38 | ✅ R55: e2e — 3 pages stamped bottom-right, pdftotext+VLM verified |
| Crop PDF | `crop-pdf` | 34 | ✅ R55: e2e — margins exact (385×642 pt), content intact, auto-detect + drag handles |
| Add header & footer | `add-header-footer` | 30 | ⬜ |
| Annotate PDF | `annotate-pdf` | 25 | ⬜ |
| Edit PDF text | `edit-pdf-text` | 20 | ⬜ |
| Change PDF document info | `change-pdf-doc-info` | 20 | ⬜ |
| Bates numbering | `bates-numbering` | 16 | ⬜ |
| Add stamps | `add-stamps` | 16 | ⬜ |
| Remove annotations | `remove-annotations` | 16 | ⬜ |
| Timestamp PDF | `timestamp-pdf` | 16 | ⬜ |
| Make PDF fillable | `make-pdf-fillable` | 16 | ⬜ |
| Change page size | `change-pdf-page-size` | 16 | ⬜ |
| Background color | `background-color` | 14 | ⬜ |
| Text color | `text-color` | 14 | ⬜ |
| Adjust colors | `adjust-colors` | 14 | ⬜ |
| Overlay PDF | `overlay-pdf` | 14 | ⬜ |
| Add page labels | `add-page-labels` | 12 | ⬜ |
| Invert colors | `invert-colors` | 12 | ⬜ |
| Scanner effect | `scanner-effect` | 12 | ⬜ |
| Font to outline | `font-to-outline` | 10 | ⬜ |
| Posterize PDF | `posterize-pdf` | 10 | ⬜ |
| PDF layers | `pdf-layers` | 10 | ⬜ |

### Convert to PDF (22)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Word to PDF | `word-to-pdf` | 85 | ✅ R52: e2e — DOCX (own-zip fixture) → 1-page PDF, text run verified ("Second paragraph for conversion verification."), Helvetica embedded |
| JPG to PDF | `jpg-to-pdf` | 72 | ✅ R53: e2e — text-bearing JPG → PDF round-trip (VLM: text readable), A4 **auto-landscape** for 800×560 image, JPEG embedded via DCTDecode, centered with margins |
| Convert to PDF | `convert-to-pdf` | 58 | ✅ R54: e2e — smart dispatcher routes JPG → Images to PDF chain, A4 output |
| PNG to PDF | `png-to-pdf` | 56 | ✅ R54: e2e — PNG → 1-page A4 landscape, image placed with margins, VLM-verified |
| PowerPoint to PDF | `powerpoint-to-pdf` | 30 | ✅ R57: e2e — 3-slide deck → 3-page 960×540 PDF, Hindi slide text (Noto embedded), speaker-notes pages verified; 🔧 vertical-mirror render bug + duplicate options panel FIXED (see R57 report) |
| Excel to PDF | `excel-to-pdf` | 28 | ✅ R57: e2e — 3-row sheet → 1-page A4 portrait, gray header + gridlines + "Sheet 1 of 1" footer, VLM-verified table |
| HEIC to PDF | `heic-to-pdf` | 26 | ✅ R57: e2e — real HEIF/HEVC fixture decoded by libheif WASM in Chromium, A4 auto-landscape, corner-color round-trip verified (dark/pink/green/yellow quadrants) |
| WEBP to PDF | `webp-to-pdf` | 22 | ✅ R57: e2e — VP8 WEBP → 1-page A4 auto-landscape, text + circle survive (VLM), PNG transcode path |
| TXT to PDF | `txt-to-pdf` | 18 | ⬜ |
| CSV to PDF | `csv-to-pdf` | 14 | ⬜ |
| Markdown to PDF | `markdown-to-pdf` | 14 | ⬜ |
| CBZ to PDF | `cbz-to-pdf` | 12 | ⬜ |
| HTML to PDF | `html-to-pdf` | 12 | ⬜ |
| SVG to PDF | `svg-to-pdf` | 12 | ⬜ |
| JSON to PDF | `json-to-pdf` | 10 | ⬜ |
| XML to PDF | `xml-to-pdf` | 10 | ⬜ |
| EPUB to PDF | `epub-to-pdf` | 10 | ⬜ |
| TIFF to PDF | `tiff-to-pdf` | 10 | ⬜ |
| BMP to PDF | `bmp-to-pdf` | 8 | ⬜ |
| ODT to PDF | `odt-to-pdf` | 8 | ⬜ |
| Publisher to PDF | `publisher-to-pdf` | 6 | ⬜ |
| RTF to PDF | `rtf-to-pdf` | 6 | ⬜ |

### Convert from PDF (20)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| PDF to JPG | `pdf-to-jpg` | 84 | ✅ R52: e2e — 3 pages → 625×417 JPEGs, VLM-verified text ("R52 Test Page 1" readable), DPI info shown pre-run |
| PDF to Word | `pdf-to-word` | 83 | ✅ R52: e2e — 3-page PDF → DOCX, all 6 text runs preserved (R52 Test Page 1/2/3 + subtitles), auto-download works; **UX fix shipped:** re-download button on result card (blocked/missed saves ke liye) |
| PDF to PNG | `pdf-to-png` | 70 | ✅ R53: e2e — 3 pages → 875×583 RGBA PNGs (exactly as DPI preview promised), ZIP download + per-file downloads work, VLM-verified content |
| PDF to TXT | `pdf-to-txt` | 65 | ✅ R54: e2e — flow layout, all pages + UNIQUE-MARKER extracted, options (layout/pages/marks) present |
| Convert from PDF | `convert-from-pdf` | 44 | ⬜ |
| PDF to Excel | `pdf-to-excel` | 24 | ✅ R58: e2e — bordered invoice fixture → real .xlsx (OOXML inlineStr), numeric cells `t="n"` (3, 42.5, 127.5), bold header, 4-col ruled grid exact; probe-cols display bug fixed + live mini-grid preview + detector badge shipped (see R58 report) |
| Prepare PDF for AI | `prepare-pdf-for-ai` | 22 | ✅ R58: e2e — 3-page PDF → `_llm.json`, 3 LlamaIndex docs {text, metadata: page_id/total_pages/file_path/format/dates}, JSONL/chunked verified at lib level; NEW result chips: AI-ready documents + ~tokens estimate (EN+HI) |
| PDF to PowerPoint | `pdf-to-powerpoint` | 22 | ✅ R58: e2e — 3 slides, 2 shapes each (title + body), UNIQUE markers + em-dash intact, 16:9 default; NEW pre-run slide-outline chips (largest-text-item titles, blank-page "No text" state, +N more fold, EN+HI, mobile-clean) |
| Extract tables | `extract-tables` | 18 | ✅ R58: e2e — bordered invoice → "1 table found and exported", ZIP with `tables-p1-t1.csv` exact RFC-style rows, prose correctly excluded; comma/format options present |
| PDF to greyscale | `pdf-to-greyscale` | 16 | ⬜ |
| PDF to WEBP | `pdf-to-webp` | 16 | ⬜ |
| PDF to ZIP | `pdf-to-zip` | 12 | ⬜ |
| Extract attachments | `extract-attachments` | 12 | ⬜ |
| PDF to CBZ | `pdf-to-cbz` | 12 | ⬜ |
| PDF to SVG | `pdf-to-svg` | 10 | ⬜ |
| PDF to HTML | `pdf-to-html` | 10 | ⬜ |
| PDF to Markdown | `pdf-to-markdown` | 10 | ⬜ |
| PDF to BMP | `pdf-to-bmp` | 8 | ⬜ |
| PDF to TIFF | `pdf-to-tiff` | 8 | ⬜ |
| PDF to ODT | `pdf-to-odt` | 8 | ⬜ |

### Security (10)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Sign PDF | `sign-pdf` | 88 | ✅ R52: e2e — date-stamp created, placed on page via canvas click, 3-page signed PDF downloaded; HI UI tested |
| Lock PDF | `lock-pdf` | 78 | ✅ R53: e2e — qpdf-verified AES-256 (AESv3, R=6), user password round-trip works, permission bits set, 3 password fields + 6 permission toggles + strength selector |
| Unlock PDF | `unlock-pdf` | 75 | ✅ R53: e2e — round-trip with lock-pdf output; decrypted file opens without password (qpdf: "File is not encrypted"); wrong-password shows clear error ("That password is not correct.") |
| Redact PDF | `redact-pdf` | 28 | ⬜ |
| Generate password | `generate-password` | 26 | ⬜ |
| Remove PDF metadata | `remove-pdf-metadata` | 20 | ⬜ |
| Sanitize PDF | `sanitize-pdf` | 18 | ⬜ |
| Change permissions | `change-permissions` | 18 | ⬜ |
| Digital signature | `digital-signature` | 12 | ⬜ |
| Request signature | `request-signature` | 8 | ⬜ |

### Optimize (9)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Compress PDF | `compress-pdf` | 92 | 🟡 R51: route loads (full e2e pending R52) |
| OCR PDF | `ocr-pdf` | 52 | ⬜ |
| Compress PDF to size | `compress-pdf-to-size` | 48 | ⬜ |
| Repair PDF | `repair-pdf` | 22 | ⬜ |
| Remove blank pages | `remove-blank-pages` | 20 | ⬜ |
| Flatten PDF | `flatten-pdf` | 18 | ⬜ |
| Rasterize PDF | `rasterize-pdf` | 14 | ⬜ |
| Web optimize PDF | `web-optimize-pdf` | 10 | ⬜ |
| PDF to PDF/A | `pdf-to-pdfa` | 10 | ⬜ |

### Create (9)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Images to PDF | `images-to-pdf` | 80 | ✅ R54: e2e — 2 PNGs → 2-page auto-landscape A4, per-image rotate/reorder, both pages VLM-verified |
| Scan PDF | `scan-pdf` | 62 | ✅ R54: e2e — Scan→PDF A4 verified; "Detect text" OCR chain FIXED (image-wrap in ocr-pdf worker, 92% conf, searchable text confirmed) |
| Create PDF | `create-pdf` | 28 | ⬜ |
| Write PDF | `write-pdf` | 26 | ⬜ |
| Webpage to PDF | `webpage-to-pdf` | 24 | ⬜ |
| Create resume | `create-resume` | 18 | ⬜ |
| Create photo collage | `create-photo-collage` | 12 | ⬜ |
| Create card | `create-card` | 12 | ⬜ |
| Create fillable PDF form | `create-fillable-pdf-form` | 12 | ⬜ |

### Invoices (6)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Create invoice | `create-invoice` | 32 | ⬜ |
| Create invoice visually | `create-invoice-visually` | 10 | ⬜ |
| Create electronic invoice | `create-electronic-invoice` | 8 | ⬜ |
| PDF to e-invoice | `pdf-to-e-invoice` | 8 | ⬜ |
| XML invoice to PDF | `xml-invoice-to-pdf` | 8 | ⬜ |
| Validate e-invoice | `validate-e-invoice` | 6 | ⬜ |

### View (8)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| View PDF | `view-pdf` | 60 | ✅ R54: e2e — page nav/zoom/fit/rotate-full-cycle/thumbnails/print/presentation all verified; text layer in a11y |
| Search PDF | `search-pdf` | 18 | ⬜ |
| Compare PDF | `compare-pdf` | 16 | ⬜ |
| View metadata | `view-metadata` | 14 | ⬜ |
| Page dimensions | `page-dimensions` | 12 | ⬜ |
| Verify PDF signatures | `verify-pdf-signatures` | 8 | ⬜ |
| Validate PDF/A | `validate-pdfa` | 6 | ⬜ |
| Set PDF viewer preferences | `set-pdf-viewer-preferences` | 6 | ⬜ |

### Images (6)

| Tool | ID | Pop | Status |
|------|----|-----|--------|
| Resize image to KB | `resize-image-kb` | 46 | ⬜ |
| HEIC to JPG | `heic-to-jpg` | 36 | ⬜ |
| WEBP to JPG | `webp-to-jpg` | 24 | ⬜ |
| HEIC to PNG | `heic-to-png` | 20 | ⬜ |
| Passport photo | `passport-photo` | 20 | ⬜ |
| WEBP to PNG | `webp-to-png` | 14 | ⬜ |

---

## 5. Cross-cutting checks (every round)

- [ ] Header mega-menu: all **11 categories** present (incl. **QR & Barcodes**), links correct
- [ ] Footer: category links work; sticky-bottom on short pages
- [ ] Home: category grid shows all 11; popular tools render
- [ ] Search palette (Ctrl+K): finds tools by EN + HI tags
- [ ] `/tools` page: category sections + counts match registry
- [ ] Language switch EN ↔ HI preserves route
- [ ] Dev server log: no new runtime/hydration errors

## 6. Bug filing process

1. Reproduce on `localhost:3000` (EN + HI).
2. Use site's **Report a bug** (footer) — lands in Admin → Bugs.
3. Severity: `critical` (tool unusable) / `medium` (works, wrong output) / `low` (cosmetic, i18n).
4. Link bug ID back into the per-tool **Notes** column above.

---

*Last updated: R58 (Tier-B convert-from: pdf-to-excel / pdf-to-powerpoint / extract-tables / prepare-pdf-for-ai — 4/4 pass, probe-cols bug fixed, mini-grid preview + slide outline + AI stat chips shipped). Next: R59 — Tier B convert-from remainder (pdf-to-webp, pdf-to-zip, extract-attachments, pdf-to-markdown, convert-from-pdf dispatcher).*
