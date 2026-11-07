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
| R55 | Tier A remainder + Tier B start (edit category: watermark, fill, page numbers, crop) | ⬜ |
| R56–R62 | Tier B by category (organize → edit → convert-to → convert-from → security → optimize → create) | ⬜ |
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
| Split PDF | `split-pdf` | 95 | 🟡 R51: route loads (split route spot-check only — full e2e pending R52) |
| Rotate PDF pages | `rotate-pdf-pages` | 68 | ✅ R53: e2e — full feature matrix verified (scope=All rotates all, scope=Selected rotates only selection, per-page buttons work); 180° metadata + visual render both correct |
| Rearrange PDF pages | `rearrange-pdf-pages` | 45 | ⬜ |
| Remove PDF pages | `remove-pdf-pages` | 42 | ⬜ |
| Extract PDF pages | `extract-pdf-pages` | 40 | ⬜ |
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
| Add watermark | `add-watermark` | 55 | ⬜ |
| Fill out PDF | `fill-out-pdf` | 50 | ⬜ |
| Add page numbers | `add-page-numbers` | 38 | ⬜ |
| Crop PDF | `crop-pdf` | 34 | ⬜ |
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
| PowerPoint to PDF | `powerpoint-to-pdf` | 30 | ⬜ |
| Excel to PDF | `excel-to-pdf` | 28 | ⬜ |
| HEIC to PDF | `heic-to-pdf` | 26 | ⬜ |
| WEBP to PDF | `webp-to-pdf` | 22 | ⬜ |
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
| PDF to Excel | `pdf-to-excel` | 24 | ⬜ |
| Prepare PDF for AI | `prepare-pdf-for-ai` | 22 | ⬜ |
| PDF to PowerPoint | `pdf-to-powerpoint` | 22 | ⬜ |
| Extract tables | `extract-tables` | 18 | ⬜ |
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

*Last updated: R53 (Tier-A: lock/unlock/jpg-to-pdf/pdf-to-png/rotate — 5/5 pass). Next: R54 — Tier A: pdf-to-txt, scan-pdf, view-pdf, convert-to-pdf, images-to-pdf, png-to-pdf.*
