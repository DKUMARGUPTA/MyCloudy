# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> Detailed technical handover = `/home/z/my-project/worklog.md` (ye file uska quick summary hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** P4.5 ke baad — Assemble PDF (multi-doc columns workspace) shipped — **55 tools live**.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Total tools in registry | **97** |
| **Ready to use (LIVE)** | **55** ✅ |
| Pending (Coming Soon) | **42** ⏳ |
| Phase | 3/4 (tools one-by-one) IN PROGRESS |
| Server | Next.js 16.1.3, port 3000, HTTP 200, dev.log clean |
| Privacy | 100% on-device (Mode D) — zero external requests |
| i18n | English + हिंदी (1520 = 1520 keys parity) |
| HEIC decode | Self-hosted libheif WASM — har browser mein (Safari native fallback) |
| OCR (P3.19) | Self-hosted Tesseract 7 LSTM — eng + hin, searchable PDF + TXT |

---

## ✅ 55 LIVE TOOLS (Ready to use — sab tested & QA-passed)

### 🗂️ Organize (12/12) — CATEGORY COMPLETE
- ✅ Merge PDF (`merge-pdf`) — 50 tak PDFs jodo, reorder, page ranges
- ✅ Assemble PDF (`assemble-pdf`) — P4.5: multi-doc COLUMNS, pages drag karke dusre doc me, new-doc columns, zipper merge (front/back scans), reverse, per-column rename/reverse/clear/delete, undo/redo, separate+ZIP
- ✅ Split PDF (`split-pdf`) — ranges / every-N / size / visually
- ✅ Rotate PDF pages (`rotate-pdf-pages`)
- ✅ Rearrange PDF pages (`rearrange-pdf-pages`) — drag + keyboard
- ✅ Remove PDF pages (`remove-pdf-pages`) — selection/blank-detect
- ✅ Extract PDF pages (`extract-pdf-pages`) — new PDF ya one-per-page
- ✅ Pages per sheet N-up (`pages-per-sheet`) — 2/4/6/9/16, live canvas preview, /Rotate-aware placement
- ✅ Halve PDF pages (`halve-pdf-pages`) — book spreads left/right ya top/bottom, lossless windowing
- ✅ Bookmark PDF (`bookmark-pdf`) — outline tree builder, "One per page" autofill
- ✅ Extract images (`extract-images`) — embedded PNG/JPG, dedupe, min-size filter, ZIP/PNG/JPG
- ✅ Copy from PDF (`copy-from-pdf`) — P4.3: click-to-select paragraphs (columns/tables split, headings+bullets), clipboard copy Text/Markdown/CSV, run exports .txt/.md with auto-OCR (P4.4: image-scan OCR bhi fixed — niche pdfjs-common insight dekho)

### ✏️ Edit (9/11)
- ✅ Fill out PDF forms (`fill-out-pdf`) — AcroForm scan, auto-fill profile (name/email/phone/address), Hindi Devanagari support, flatten switch
- ✅ Make PDF fillable (`make-pdf-fillable`) — P4.2: auto-detect (underlines/boxes/checkbox squares) + manual drag-draw + rename/type-edit + AcroForm export
- ✅ Add watermark (`add-watermark`) — text/logo, opacity, tiling
- ✅ Add page numbers (`add-page-numbers`) — 8 formats, Roman/Hindi digits, 9-grid
- ✅ Header & footer (`add-header-footer`) — {page} {date} {filename} variables
- ✅ Crop PDF (`crop-pdf`) — visual crop box + auto-detect
- ✅ Change document info (`change-pdf-doc-info`)
- ✅ Overlay PDF (`overlay-pdf`) — base+stamp merge, page mapping, position/opacity
- ✅ Change page size (`change-pdf-page-size`) — A3/A4/A5/Letter/custom mm, fit/fill/none

### 📷 Create (3/10)
- ✅ Scan to PDF (`scan-pdf`) — camera + edge detection + Magic/B&W filters + perspective correction
- ✅ Images to PDF (`images-to-pdf`) — JPG/PNG/WEBP/HEIC/TIFF/SVG
- ✅ Generate QR code (`generate-qr-code`) — link/text/WiFi/UPI/vCard/email/phone/WhatsApp, colors+logo, PNG/SVG/PDF

### 🔒 Security (6/8)
- ✅ Protect PDF (`lock-pdf`) — AES-256 qpdf WASM
- ✅ Unlock PDF (`unlock-pdf`)
- ✅ Sign PDF (`sign-pdf`) — draw/type/upload signature
- ✅ Redact PDF (`redact-pdf`) — permanent hide, verified gone
- ✅ Remove PDF metadata (`remove-pdf-metadata`)
- ✅ Generate password (`generate-password`)

### ⚡ Optimize (5/8)
- ✅ Compress PDF (`compress-pdf`) — quality presets / custom DPI
- ✅ PDF OCR (`ocr-pdf`) — P3.19: Tesseract LSTM, English + हिंदी, searchable PDF (GlyphLessFont invisible layer) ya TXT, 150/300 DPI, mixed-docs smart skip, per-page confidence chip
- ✅ Compress to target size (`compress-pdf-to-size`) — P3.20: India forms — 100/200/500 KB/1 MB/custom target, iterative ladder (structural → image q/dim/gray → raster dpi/q), honest amber miss chip
- ✅ Flatten PDF (`flatten-pdf`) — forms+annotations ya scoped, AcroForm bake, honest errorNothing
- ✅ Rasterize PDF (`rasterize-pdf`) — P4.2: har page flat image — 72–300 DPI, JPEG/PNG + quality, pages range, 40MP clamp; output mein fonts/AcroForm/text-ops ZERO

### 👁️ View (3/6)
- ✅ View PDF (`view-pdf`) — thumbnails, search, outline, dark mode
- ✅ Compare PDF (`compare-pdf`) — side-by-side diff report, sensitivity, case/whitespace
- ✅ Search in PDFs (`search-pdf`) — live surface highlights + TXT report, text/regex, case/whole-word

### 📥 Convert to PDF (9/17)
- ✅ JPG to PDF (`jpg-to-pdf`) · ✅ PNG to PDF (`png-to-pdf`) · ✅ WEBP to PDF (`webp-to-pdf`) · ✅ HEIC to PDF (`heic-to-pdf`) — libheif WASM se har browser mein!
- ✅ TIFF to PDF (`tiff-to-pdf`) — P4.4: clean-room TIFF reader (LZW/PackBits/Deflate/G3/G4, multi-page IFD, DPI-aware fit), "N pages" chip + main-thread preview
- ✅ SVG to PDF (`svg-to-pdf`) — P4.4: main-thread raster (workers SVG decode NAHI kar sakte) + assets bridge (logo-store pattern), fit = graphic ka apna 96-DPI size
- ✅ Text to PDF (`txt-to-pdf`) + Markdown to PDF (`markdown-to-pdf`) — headings/lists/quotes/code, Devanagari
- ✅ Universal converter (`convert-to-pdf`) — smart routing surface, file detect → sahi tool

### 📤 Convert from PDF (4/13)
- ✅ PDF to JPG (`pdf-to-jpg`) · ✅ PDF to PNG (`pdf-to-png`) · ✅ PDF to Text (`pdf-to-txt`)
- ✅ Universal converter (`convert-from-pdf`) — smart routing surface

### 🖼️ Image Tools (4/6) — P3.18 NAYA!
- ✅ HEIC to JPG (`heic-to-jpg`) — iPhone photos, har browser mein
- ✅ HEIC to PNG (`heic-to-png`) — lossless
- ✅ WEBP to JPG (`webp-to-jpg`) — alpha flattening + quality
- ✅ WEBP to PNG (`webp-to-png`) — transparency preserved
- ⏳ resize-image-kb (P2), passport-photo (P3)

---

## ⏳ 43 PENDING TOOLS (Kaam baki hai)

### 🔜 Next Up — Priority Queue (Phase 2 tools, sabse pehle)
Ye PRD ke hisaab se agle banne hain (one per round):
1. **Set viewer preferences** (`set-pdf-viewer-preferences`)
2. **Resize image to KB** (`resize-image-kb`) — exam/govt forms ke liye under 100/200KB
3. **Edit PDF** (`edit-pdf`) — Word-style editor (Phase 8 mein 6 sub-phases, bada hai!)
4. **Annotate PDF** (`annotate-pdf`) — highlights, notes, sticky
5. **Write PDF** (`write-pdf`) — word-processor style + Hindi fonts
6. **Create PDF** (`create-pdf`) — blank/templates (letter, notes, planner, invoice, resume)

*(P4.1: 14 tools wired ✅ — P4.2: rasterize + make-fillable ✅ — P4.3: copy-from-pdf ✅ — P4.4: image-render FIX + TIFF/SVG ✅ — P4.5: assemble-pdf ✅)*

### 🌐 Server-based (Mode S) — Phase 3+ (sandbox mein backend docs only)
`word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf`, `pdf-to-word`, `pdf-to-excel`,
`pdf-to-powerpoint`, `odt-to-pdf`, `rtf-to-pdf`, `epub-to-pdf`, `html-to-pdf`,
`webpage-to-pdf`, `publisher-to-pdf`, `pdf-to-svg`, `pdf-to-odt`, `pdf-to-pdfa`,
`validate-pdfa`, `pdf-to-html` (D), `pdf-to-markdown` (D), `pdf-to-webp` (D), `pdf-to-tiff` (D)

### 💼 Invoices (6) — Phase 3
`create-invoice` (GST ready — CGST/SGST/IGST, UPI QR), `create-invoice-visually`,
`create-electronic-invoice` (Factur-X), `pdf-to-e-invoice`, `xml-invoice-to-pdf`, `validate-e-invoice`

### 🎨 Create (baaki) — Phase 3
`create-photo-collage`, `create-card` (Hindi festival templates), `create-fillable-pdf-form`,
`create-resume` (8 templates), `passport-photo` (India sizes)

### 🔐 Security (baaki)
`digital-signature` (PAdES .pfx/.p12), `request-signature` (expiring link, Pro)

### 🔍 View (baaki)
`verify-pdf-signatures`, `validate-pdfa` (S)

### ⚙️ Optimize (baaki)
`web-optimize-pdf` (linearize), `repair-pdf` (rebuild xref)

---

## 🏗️ Foundation — Kya-Kya BAN CHUKA hai (Phases 0–2 + naye modules)

- **Design system** — PRD §3 exact colors (primary #2563EB), light+dark, Inter + Noto Sans Devanagari self-hosted, no CDN
- **Global layout** — header mega-menu + Ctrl+K fuzzy search, footer, cookie banner (analytics OFF), 404/500/offline
- **Tool registry** — 97 tools typed config (id, category, mode D/S, phase, i18n name/desc, tags en+hi, popularity, enabled flag)
- **Storage** — OPFS + IndexedDB fallback, recent files (max 20, 30 din), thumbnails cache
- **PDF engine** — pdf.js self-hosted (4.1MB /public/pdfjs), render queue, magic-byte %PDF- sniff
- **Worker pool** — run/progress/result/error/cancel protocol, hardware-concurrency cap
- **ToolShell** — 4 states (Landing → Workspace → Processing → Result), DropZone, FileCard, OptionsPanel, result: download/share/rename/ZIP/chain
- **Hash routing** — `#/tool/<id>` (sirf `/` route visible hai sandbox mein)
- **API** — `/api/feedback` (zod + honeypot + rate limit + Prisma)
- **i18n engine** — ICU-lite plural support: `{n, plural, =1 {one page} other {# pages}}`
- **Devanagari PDF pipeline** — fontkit + subset:true, WinAnsi fallback pattern (`tools/fill-out-pdf/worker.ts` mein pinned)
- **camera landingSurface** — capture-style tools ke liye (`scan-pdf` se aaya)
- **HEIC engine (P3.18)** — `src/lib/heic/heic-decode.ts` (worker-side libheif WASM, lazy + cached) + `heic-preview.ts` (main-thread thumbnail queue + LRU 64) + `public/libheif/` (2MB self-hosted bundle + LGPL license). CSP mein `wasm-unsafe-eval` add hua. Safari pe native decode fast-path hai.
- **convert-image worker** — `tools/convert-image/worker.ts` 4-way converter (webp/heic × jpg/png), alpha flattening + maxDim downscale + deduped names
- **compress-common (P3.20)** — `tools/compress-common/recompress.ts`: shared impure image-recompression (recompressCandidate + rawPixelsToImageData + committedJpegBlob — canvas-commit guard JPEG variant). compress-pdf + compress-pdf-to-size dono isi se stream karte hain.
- **to-size ladder (P3.20)** — `tools/compress-pdf-to-size/`: engine (resolveTargetBytes + IMAGE_LADDER q0.8→0.32/dim2400→900/gray-tail + RASTER_LADDER 140→52 DPI) + worker (0: passthrough → 1: object-streams+meta-strip → 2: image ladder (text selectable) → 3: raster ladder (last resort) → honest amber miss chip). customKB clamp 30KB–10MB.
- **OCR engine (P3.19)** — `public/tesseract/` self-hosted Tesseract 7 (ESM lib + nested worker + 3 lstm cores + eng/hin traineddata.gz, Apache-2.0 licenses shipped). `tools/ocr-pdf/` worker: pdf.js render → **committedPngBlob** (canvas-commit race guard!) → tesseract `recognize(blob, {pdfTitle}, {text, pdf:true})` → **tesseract ka apna PDF renderer** (GlyphLessFont invisible layer, logical char order — Hindi ि/ी matras searchable!) → pdf-lib copyPages merge (native pages pass through as-is). Smart skip: pages with ≥150 selectable chars skip OCR. Warm singleton + reinitialize on language change; traineddata IndexedDB-cached by tesseract.

---

## 📋 Next Phases (bade kaam)

| Phase | Kya hai | Status |
|---|---|---|
| 3 | Tools one-by-one (upar ki queue) | 🔨 IN PROGRESS |
| 4 | Protect/Unlock (qpdf WASM) | ✅ DONE (P3.11-12) |
| 5 | Sign PDF | ✅ DONE (P3.13) |
| 6 | Static pages (Privacy, Terms, Contact, About...) + API routes | ⏳ Pending |
| 7 | PWA (manifest, service worker, offline) + performance | ⏳ Pending |
| 8 | Editor (6 sub-phases: shell, objects, text edit, forms, export, mobile) | ⏳ Pending |
| 9 | Advanced tools (OCR, N-up, Overlay, Redact...) | 🔨 Partial |
| 10 | Accounts + Pro (Razorpay, GST invoice, server limits) | ⏳ Pending |
| 11 | services/worker Docker (LibreOffice, ClamAV) | ⏳ Docs only |

---

## ⚠️ Hard Rules (KABHI mat todo)

1. **Zero third-party CDNs** — fonts/pdf.js/WASM sab self-hosted `/public` se
2. **Mode D tools: ZERO network requests with file data** — sab Web Workers mein
3. **No AGPL/GPL libs** (no Ghostscript, no MuPDF)
4. **pdf-lib encrypt nahi kar sakta** — Protect/Unlock = qpdf WASM only
5. **Config-driven tools** — ek registry + ek ToolShell, per-tool page copy-paste NAHI
4. **Sab UI strings i18n se** (en + real Devanagari Hindi, short)
5. **A11y** — keyboard, aria, 44px targets, 360px mobile-first, prefers-reduced-motion
6. **No placeholder/TODO code** — har file complete runnable
7. **Security** — magic bytes validation, 50MB mobile/200MB desktop, kabhi file names log mat karo
8. Sandbox: sirf `/` visible, API routes use karo (server actions NAHI), `bun run build` KABHI NAHI, har kaam ke baad dev.log check + agent-browser QA

---

## 🔑 Technical Insights (reuse karo, dobara mat dhundo)

- **⚠️ THE CANVAS-COMMIT RACE (P3.19, 4 ghante ka debugging!)**: Chrome accelerated OffscreenCanvas pe `page.render().promise` resolve hone par raster ops GPU pe PENDING reh sakte hain — us instant `convertToBlob()`/`getImageData()` **BLANK snapshot** de sakta hai (white ~49KB PNG jab committed ~87KB hona chahiye). Tesseract ko blank mila → conf 0 → errorOcrEmpty. **FIX: `committedPngBlob()`** (`tools/ocr-pdf/worker.ts`): convert → createImageBitmap(last) decode-yield → convert again → size-stability loop (deterministic PNG encoder = same bytes → same size). HAR tool jo render ke turant baad canvas padhta hai is guard se guzarna chahiye!
- **Hindi text layer in PDFs**: pdf-lib `drawText` + fontkit SHAPES Devanagari (visual glyph order) → extraction ि-matras rehint reorders → "दु िनया" (unsearchable). Char-by-char = dotted circles ◌. **SOLUTION: tesseract ka built-in PDF renderer** (`recognize(img, {pdfTitle}, {text:true, pdf:true})`) — GlyphLessFont + logical-order ToUnicode — "नमस्ते दुनिया" perfectly searchable. Page PDFs ko pdf-lib copyPages se merge karo.
- **Tesseract 7 self-host recipe**: `tesseract.esm.min.js` (default export = lib) + `worker.min.js` (nested classic worker, blob-wrapped importScripts) + 3× `-lstm.wasm.js` cores (SIMD variants auto-picked; single-file builds — no separate .wasm) + `langs/<lang>.traineddata.gz` from `@tesseract.js-data/<lang>/4.0.0_best_int/`. createWorker options: `{workerPath, corePath, langPath, gzip: true, workerBlobURL: true}` + `setParameters({user_defined_dpi, preserve_interword_spaces})`. OffscreenCanvas/Blob/dataURL sab loadImage handle karta hai — lekin committed blob best hai (upar wala race!).
- **QA harness pins (P3.19 naya)**: workspace state mein `main label` = OPTIONS ka label ho sakta hai — dropzone dhundo `textContent.includes('drop files here')` se (Hindi UI mein 'फ़ाइलें यहाँ')! Result ke baad drop karne se pehle "Start over" click karo. Toast errors dekhne ke liye MutationObserver lagao (auto-dismiss). `w.onmessage` pe addEventListener se progress/result capture karo.
- **HEIC decode recipe:** libheif-js@1.23.5 wasm-bundle.mjs (wasm EMBEDDED — single file, no separate .wasm) → copy to /public/libheif/, load via variable-URL dynamic import + turbopackIgnore (pdf.js pattern). Default export = FACTORY function — call it: `await factory()`. Then `new libheif.HeifDecoder().decode(bytes)` → image array → `image.display({data,width,height},cb)` fills RGBA. Empty array = corrupt/unsupported. Bun can smoke-test it directly!
- **QA harness pins (P3.18):** agent-browser `open` SAME URL = NO reload (stale state!) — use `reload`; fetch(blob:) BLOCKED by CSP connect-src 'self' — verify pixels via drawImage(liveImg) ya Worker.prototype.onmessage hook (defineProperty wrap) se blob capture (blob.arrayBuffer() CSP bypass karta hai); dropzone label input ka SIBLING hai — `main label` pe dispatch karo (bubble hota hai div.onDrop tak)
- **Devanagari in PDFs:** pdf-lib `save()` non-Latin pe WinAnsi Helvetica ke saath THROW karta hai — pre-render with embedded fontkit subset ya NeedAppearances fallback (pattern: `tools/fill-out-pdf/worker.ts`)
- **Agent-browser upload flaky:** CDP setFileInputFiles wale Files DropZone clear hone ke baad UNREADABLE ho jate hain — recipe: public/ se fetch karke synthetic `DragEvent('drop')` + DataTransfer bhejo. **Label matcher DONO languages ke liye rakho** — `l.textContent.includes('फ़ाइलें यहाँ') || l.toLowerCase().includes('drop files here')` — warna HI UI pe drop silently fail.
- **agent-browser click flaky** re-rendered React buttons pe — `eval .click()` + delayed reads use karo; toasts ke liye MutationObserver lagao
- **⚠️ pdf.js `convertToViewportPoint` returns ARRAY `[x, y]`, object NAHI (v4.10.38)!** `.x`/`.y` access = undefined = NaN geometry (P4.3 mein copy-from-pdf ke paragraphs isliye merge nahi ho rahe the). FIX: `viewport.transform` matrix `[a,b,c,d,e,f]` khud apply karo: `x' = a*x + c*y + e; y' = b*x + d*y + f`. Fully typed, no runtime shape guessing.
- **✅ RESOLVED (P4.4): WORKER-SIDE pdf.js IMAGE-PDF BLANK RENDER:** P4.3 mein discover hua tha — image-based PDFs (JPEG scans) worker mein render karne pe BLANK milta tha (ocr-pdf conf 0, pdf-to-jpg blank JPGs). **Root cause: pdf.js ka `DOMCanvasFactory._createCanvas` image pages pe `document.createElement("canvas")` call karta hai (pdf.min.mjs @174658 + CachedCanvases render path)** — purana worker shim sirf `{baseURI}` tha, `createElement` missing → pdf.js image draw silently skip → blank canvas. **Fix: `tools/pdfjs-common/worker-lib.ts`** — `workerDocumentShim()` (createElement → OffscreenCanvas + documentElement stub) + har `getDocument` mein `ownerDocument: workerDocumentShim()`. **P4.4 mein SAARE 10 pdf.js-using workers migrated**: rasterize, compare (pehle se), ocr-pdf, copy-from-pdf, pdf-to-images, compress-pdf-to-size, redact-pdf, pdf-to-txt, search-pdf, extract-images. **QA verified:** ocr-pdf scan → conf 95 + searchable text correct; pdf-to-jpg scan → 1240×1754 non-blank; rasterize scan → JPEG-embedded; copy-from-pdf scan → OCR .txt verbatim; compress-to-size raster ladder error-free + non-blank (logical proof: blank JPEGs tiny hote, structural jeet gaya = raster content real tha). Text-PDF passthrough regression bhi PASS. **Naya rule: koi bhi tool worker mein pdf.js use kare → `loadPdfjsInWorker` + `workerDocumentShim()` from `../pdfjs-common/worker-lib` + `ownerDocument` param — inline loader KABHI mat likho.**
- **⚠️ pdf-lib `drawImage` SILENTLY IGNORES `w`/`h` — sirf `width`/`height` accept karta hai (P4.4 bug):** imagegrid worker `page.drawImage(img, {...box})` spread kar raha tha jahan box = {x,y,w,h} — pdf-lib w/h ko IGNORE karta hai aur image ko NATIVE PIXEL SIZE pe draw karta hai (1697px SVG raster = 1697pt = 2.3 A4 pages, page ke bahar clip!). Chhote test images pe visually theek dikhta tha (300px photo = 300pt = page ke andar) isliye pakda nahi gaya. FIX: `{x: box.x, y: box.y, width: box.w, height: box.h}`. **RULE: pdf-lib draw calls mein kabhi spread mat karo — explicit width/height likho.** (rasterize/compress-to-size already sahi the — sirf imagegrid affected)
- **SVG in workers IMPOSSIBLE without WASM (P4.4):** Chrome/Firefox `createImageBitmap` SVG blobs reject karta hai ("The source image could not be decoded") — direct verify kiya. SOLUTION: **main-thread raster** — Image element + canvas drawImage (SVG vector ko DRAWN SIZE pe raster karta hai, crisp) + `collectAssets` bridge (add-watermark logo-store pattern): surface card preview ke dauraan rasterize → store (Map keyed name:size:mtime) → config ka collectAssets run-time pe File[] deta hai → worker k-th SVG file ↔ k-th asset pairing. Natural dims side-car `svg-dims.json` manifest (LAST asset) — "fit" pages graphic ke apne 96-DPI size pe, upscaled raster pe NAHI. Pending gate: useSyncExternalStore + pending counter → CTA blocked (igrid.svgRasterizing).
- **Streaming open-blocks algorithm (P4.3):** side-by-side columns wale pages pe paragraphs group karne ke liye — lines reading order mein aati hain, har line newest-open-block se match hoti hai (tight leading + x-overlap ≥25% + size ratio ≤1.35), bullet lines hamesha naya block, wrapped bullet continuation sirf indent-check se. Columns kabhi cross nahi hote, reading order banta rehta hai.
- **Remount-detection-kicker:** effects jo `[files.length]` pe keyed hain mount pe fire hote hain
- **Cancel path:** worker pool instant terminate + OPFS cleanup — 600 DPI 400-page run pe 6% pe catch verified

---

## 📝 Session Log (naya kaam yahan append karo)

### P4.5 — Assemble PDF ✅ 55th TOOL
- **PRD §8.1** "Multiple documents ek hi screen me, columns ki tarah; pages ek document se doosre me drag; new document column; sabko alag save ya merge; zipper merge (front/back scans), reverse, save all as ZIP" — complete from scratch.
- `model.ts` PURE (31/31 smoke): AsmDoc columns + AsmPageRef, transferPage/movePageWithinDoc/deletePages/reverseDocPages, **planAssemble** (merge concat / zipper round-robin / reverse / separate — surface + worker SAME planner), serializeAssemble wire format, dropFilePages (user-created empty columns ko bachata hai).
- `worker.ts` (22/22 bun smoke — page provenance via distinctive widths): sources lazily load ONCE per fileId, per-page copyPages exact interleave F1,B1,F2,B2,F3 real output bytes se verified; separate = multi-output (shell ZIP free); name dedupe.
- `surface.tsx`: files→columns (StrictMode-safe known-set), New-document column, per-column rename/reverse/clear/delete, lazy IO thumbnails (128px), undo/redo, a11y ←/→ cross-column buttons (44px), droppable empty bodies, options mirror effect + cta gating (ctaNoPages/ctaReading).
- Wiring: registry enabled (55 live) + configs + surfaces; i18n asm.* 26 keys ×2 — 1546=1546.
- QA: EN+HI, drags (cross-column page-on-page, empty-column native drag, within-column reorder, a11y buttons), undo, zipper bytes verified, separate 2 outputs + ZIP button, mobile 375px no-overflow, zero errors, tsc/lint clean.
- **⚠️ NEW dnd-kit INSIGHT (pin kiya): DragOverlay + closestCenter = cross-container drops ACTIVE item ke STATIC rect se resolve hote hain — overlay collision rect update NAHI karta. FIX: DragOverlay mat use karo; sortable khud pointer follow kare (grid-cell pattern, z-20 scale lift styling).**
- **dnd-kit transform gotcha: pehla pointermove distance-6 activation me CONSUME hota hai — transform tab tak 0 jab tak dusra move na aaye (QA instrumentation me ≥2 moves zaroori).**
- QA recipe: consent banner (fixed bottom) + short viewport page cells ko COVER kar sakte hain — drag QA se pehle banner dismiss + viewport bada karo; manual mouse-move drags flaky (stuck buttons) — `agent-browser drag @src @dst` (native) use karo. Fixtures public/ me rakhe: asm-fronts.pdf (3 pages) + asm-backs.pdf (2 pages).

### P4.4 — Worker image-render FIX + TIFF/SVG to PDF ✅ 2 TOOLS + pdf-lib bug FIX
- **P4.3 ka flagged risk resolve hua:** worker-side pdf.js image-based PDFs blank render — 5 tools affected the (ocr-pdf, pdf-to-jpg/png, rasterize, copy-from-pdf OCR, compress-to-size raster).
- **Root cause (minified source se verify):** `getDocument` transport `canvasFactory: new DOMCanvasFactory({ownerDocument})` banata hai (pdf.min.mjs @182608) → render task `CanvasGraphics` → `CachedCanvases.getCanvas()` → `_createCanvas` → `this._document.createElement("canvas")` (@174658). Purana worker shim sirf `{baseURI}` tha → image pages pe createElement missing → pdf.js image draw SILENTLY skip → blank canvas, koi error nahi.
- **Fix:** `tools/pdfjs-common/worker-lib.ts` — `workerDocumentShim()` (baseURI + createElement→OffscreenCanvas + documentElement stub) + har getDocument mein explicit `ownerDocument`.
- **10 workers migrated** (inline loaders deleted): ocr-pdf, copy-from-pdf, pdf-to-images (jpg+png), compress-pdf-to-size, redact-pdf, pdf-to-txt, search-pdf, extract-images + pehle se migrated rasterize-pdf, compare-pdf.
- **A/B proof:** rasterize (new shim) scan → 1743 dark px + /DCTDecode; ocr-pdf (old shim, us waqt) same scan → conf 0 errorNoText. Migration ke baad: ocr-pdf conf 95 + searchable text verbatim ("INVOICE #2026-789…TOTAL: 1645.50"), pdf-to-jpg 1240×1754 non-blank, copy-from-pdf OCR .txt verbatim, compress raster ladder error-free.
- **53rd TOOL — tiff-to-pdf:** config ready tha (P3 se) par worker mein TIFF support nahi tha. imagegrid/worker.ts mein TIFF branch: TiffFile.parse + on-demand decodePage (ek page memory mein), entries ko per-page expanded items mein phelaya (two-up + progress sahi), preferPng (bilevel/palette) vs JPEG 0.92, rotation encode ke saath ek hi pass mein, "fit" sizing scan ke apne DPI se (72/dpi pt-per-px). Surface: TIFF card preview main-thread reader se (page-1 PNG ≤512px) + "N pages" chip. Pages-range option per file.
- **54th TOOL — svg-to-pdf:** naya config + `svg-raster.ts` store (logo-store pattern). Worker SVG raster NAHI kar sakta (createImageBitmap reject — verify kiya) isliye surface card preview ke dauraan main-thread raster (2400px target, ≤30MP) → collectAssets → worker pairing (k-th SVG ↔ k-th asset) + svg-dims.json manifest (natural dims side-car) → "fit" page graphic ke apne size pe. CTA pending-gate (useSyncExternalStore).
- **PRE-EXISTING BUG FOUND & FIXED — pdf-lib drawImage w/h:** imagegrid worker `drawImage(img, {...box})` spread karta tha — pdf-lib w/h IGNORE karta hai, image NATIVE px size pe draw hoti thi (badi photos page se clip!). SVG test ne expose kiya (1697px raster = 2.3× A4). FIX: explicit width/height. images-to-pdf big-PNG regression PASS.
- **QA:** TIFF 3-page → 3×A4 + ellipse outline visible + pages "1,3" → 2; SVG A4 + fit 632×878 + red circle + mixed SVG+PNG 2 pages; EN + HI (3 पेज chip, फ़ाइलें यहाँ drop); mobile 375px no-overflow; zero console errors; sab localhost; tsc/lint clean; i18n 1520=1520 (+6 keys).
- Live: 52 → **54** | dev server ek baar OOM-restart (setsid pattern)

### P4.3 — Copy from PDF ✅ 52nd TOOL
- **copy-from-pdf** (PRD §747: "Click paragraph/table/list to select; copy as text, Markdown, CSV") full implementation:
  - `engine.ts` PURE (display-space, bun-testable): buildLines (baseline grouping + space/cell/column gap tiers: 0.25×/1.4×/3× font), buildBlocks **streaming open-blocks** (columns separate, bullets one-block-each, hanging-indent continuation), heading detect (size ≥1.22× body, ≤2 lines, ≤90 chars), joinFlowLines dehyphenation (SCRIPT regex Latin+Devanagari), blocksToText/Markdown (h1/h2/h3 by absolute pt)/Csv (cells from gaps, RFC 4180 quoting, **page+baseline row re-grouping** — column-split lines wapas table rows bante hain), textToLines (OCR fallback, blank-line paragraph gaps), harvestPieces (viewport.transform matrix — upar wala array gotcha!)
  - `extract.ts` main-thread pdf.js: per-page getTextContent → blocks (200-page guard), progress callbacks
  - `worker.ts` ocr-pdf recipe adapted: native lines per page → needsOcr (auto: <30 chars — copy ka promise "OCR only pages without text" isliye ocr-pdf ke 150 se low) → tesseract (warm singleton + committedPngBlob) → txt (flow/lines + page marks) ya md (blocksToMarkdown)
  - `surface.tsx`: file load pe extraction (spinner + page progress), page strip (marked pages = selected dots), canvas + block overlay (percent-positioned buttons, `height: max(h%, 44px)` touch targets, aria-pressed), toolbar (format select Text/Markdown/CSV + live selection summary with plurals + Select page/Clear/Download/Copy), clipboard writeText + execCommand fallback, scan-page amber notice, add-more dropzone
  - **QA verified:** 4 blocks on fixture (headings/paras merged, dehyphenated "demonstration"), click→copy exact text, markdown `##` heading + `-` bullets, CSV columns + quoting, Select page 4 blocks, cross-page selection, toast plurals, worker .txt export content verbatim, HI UI (सादा टेक्स्ट/कॉपी करें/चुनें:), mobile 375px no-overflow + VLM visual check (highlight paragraph pe EXACT aligned), zero console errors, all requests same-origin
- **P4.3 ka image-scan OCR regression P4.4 mein FIX ho gaya** (upar dekho) — worker.ts ab pdfjs-common use karta hai
- Registry enabled + configs.ts + surfaces.tsx + i18n 29 keys × 2 (1514=1514)
- Live: 52 | tsc clean | eslint clean | smoke 55/55 GREEN | dev.log clean (post-restart)

### P4.2 — Rasterize wired + Make PDF fillable ✅ 2 TOOLS
- **rasterize-pdf**: folder P3.16 se ready tha par kabhi wired nahi hua tha — registry enabled:true + configs.ts + i18n pehle se merged tha. Smoke 32/32. QA: 2.3KB text PDF → 88KB image-only PDF (fonts: 0, AcroForm: 0, 2 JPEGs, zero Tj/TJ ops — text completely unextractable), HI UI, mobile 375px, zero console errors. **50th tool milestone!**
- **make-pdf-fillable**: PRD §8.2 full implementation:
  - `engine.ts` PURE (pdf-lib): mergeLineSegments (dashed underline 14pt-gap merge, 30pt min), classifyRect (7–20pt square→checkbox, ≥50pt wide 10–46pt tall→textbox), labelForRect (left-label 240pt window text fields ke liye, above-label checkboxes ke liye; "Name:"→"Name" cleaning), uniqueName (Name, Name 2, Name 3...), all-4-rotation PDF↔display transforms (pdf.js PageViewport table mirrored, crop-box offsets), sanitizeSpecs clamp, buildFieldPdf (AcroForm: PDFTextField + multiline flag + PDFCheckBox square-centered + existing-name dedupe) — **68/68 smoke GREEN**
  - `detect.ts` main-thread pdf.js: operator-list walker (OPS.constructPath rectangles + horizontal moveTo→lineTo runs, |dy|<1.5pt), text-layer label naming, widget-annot existing count, 100-page guard, reading-order sort
  - `worker.ts` thin shim: fkey → `f:<fileId>` blob {specs, pageViews} (redact epoch-key pattern) — **BUG FOUND & FIXED: worker pehle opts[fkey] padh raha tha, redact pattern `m:${mkey}` prefix mangta hai → `f:${fkey}`**
  - `surface.tsx`: auto-detect on load (progress spinner), green boxes toggle (keep/skip), drag-move + corner-resize, draw-mode (text/checkbox), properties panel (rename + type switch), existing-fields amber notice, setRunBlocked 0 fields pe
  - QA: 4/4 underlines detected with names (Full Name/Email/Phone/Address), rename ✓, manual checkbox draw ✓ (PointerEvent 100ms delays ke saath — React state commit time), run → output PDF verified: 4 PDFTextField rects EXACT (140,679,420,695 = underline+2pt lift, 16pt h) + PDFCheckBox "चेकबॉक्स 1" Hindi नाम के साथ, HI UI, mobile 375px, zero console errors, 71 requests all-localhost
- i18n: 33 keys × 2 (1485=1485), protocol RunDetail.fields added
- **Fast Refresh trap (P4.2 naya insight):** QA ke दौरान worker.ts edit karne se full page reload hota hai → workspace state RESET — QA flow me pehla run click hamesha fail hoga jab tak worker pehli baar compile na ho. Fresh reload ke baad sab stable.
- Live: 51 | i18n: 1485=1485 | tsc clean | eslint clean | dev.log clean

### P4.1 — 14-Tool Wiring Mega-Batch ✅
- **Discovery:** Oct 12 ko parallel agents ne ~15 tools ki files (engine/worker/panel/surface/config/i18n + smokes) likhi thi, par orchestrator wiring kabhi nahi hui — registry flags, configs.ts, panels/surfaces maps, i18n merge sab pending tha. Ye session (Oct 14) ne sab verify karke live kiya.
- **Wired 14 tools:** pages-per-sheet, halve-pdf-pages, flatten-pdf, extract-images, search-pdf, txt-to-pdf, markdown-to-pdf, bookmark-pdf, generate-qr-code, compare-pdf, overlay-pdf, change-pdf-page-size, convert-to-pdf, convert-from-pdf
- **Config fixes:** howStepKeys→howKeys (7 configs), noInput→noFile (qr — generate-password pattern), qrcode pkg installed (MIT, bundled)
- **i18n:** 3 merge scripts + 5-section manual merge — 365 naye keys (nup, halve, flatten, rasterize, exi, search, txt2pdf, md2pdf, overlay, pgsz, bm, qr, compare, conv, convFrom) — 1452=1452 parity
- **Cleanup (dead code deleted):** tools/ocr/ (purana experiment), ocr-pdf/panel+surface (refactored engine ke against), redact/panel, scan/adjust-dialog (sab dangling + broken APIs), generate-password/gen.ts, 5 stale scripts (smoke-cts, smoke-generate-password, smoke-ocr, make-lu-fixtures, verify-lu-output)
- **smoke-gpw.ts REWRITTEN** against current engine API — 44/44 (purana smoke purani API pe tha)
- **QA:** nup (structure: 1 A4 sheet, 4 pages ka text searchable through XObjects), txt2pdf (verbatim text), md2pdf (headings/lists/quotes), QR (live preview + PNG/SVG/PDF downloads), search (4 live marks + TXT report), extract-images (PNG magic verified, min-size filter kaam karta hai), bookmark (One-per-page → 4-entry outline verified), halve (4→8), flatten (AcroForm gone, value baked in), overlay (dono texts merged), compare (5-page report), pagesize (A4→A4 passthrough), convert-to (JPG detect → images-to-pdf route). HI UI + mobile 375px + zero console errors + all-localhost requests.
- Live: 49 | i18n: 1452=1452 | tsc clean | eslint clean | dev.log clean

### P3.20 — Compress to target size ✅
- compress-pdf-to-size: iterative ladder (passthrough → structural → image q/dim/gray → raster dpi/q), green "Under your target size" + amber "Target not reached" honest chips, customKB 30KB–10MB clamp
- compress-pdf/worker.ts refactored → shared `tools/compress-common/recompress.ts` (verbatim extraction, regression PASS)
- committedJpegBlob (canvas-commit guard, JPEG variant) — raster path blank-snapshot se bachata hai
- QA: 1.5MB→78KB @100KB (text preserved — pdf.js extraction verified all 4 pages), 25KB extreme (raster path), miss chip @30-page/30KB, already-under passthrough, HI UI + Devanagari filename, mobile 375px, compress-pdf regression 148KB @Recommended, zero console errors, all localhost
- Live: 35 | i18n: 1087=1087 | lint+tsc clean | dev.log clean

### P3.19 — PDF OCR ✅ TESSERACT + HINDI
- ocr-pdf: self-hosted Tesseract 7 LSTM (3 cores + eng/hin models, ~15MB lazy), searchable PDF via tesseract's own GlyphLessFont renderer (Hindi logical order verified: "नमस्ते दुनिया" searchable!), TXT mode, 150/300 DPI, mixed-doc smart skip, per-page + result confidence chips
- **THE canvas-commit race** found & fixed (committedPngBlob) — 4h debugging, pinned in insights
- pdf-to-txt copy updated (OCR ab live), i18n 1085=1085, protocol StageDetail.conf + RunDetail.confidence added
- QA: eng scan conf 95 extraction verified, hin scan perfect logical text, text mode UTF-8, mixed pass-through, HI UI, mobile 375px, merge regression, 708 requests all-localhost, zero console errors
- Live: 34 | i18n: 1085=1085 | lint+tsc clean | dev.log clean

### P3.18 — HEIC/WEBP Converters ✅ 5 TOOLS
- webp-to-jpg, webp-to-png, heic-to-jpg, heic-to-png (shared convert-image worker) + heic-to-pdf (ImageGrid preset)
- libheif WASM self-hosted (LGPL, unmodified, license shipped) — HEIC ab HAR browser mein decode hota hai (Safari native fallback)
- images-to-pdf bhi upgrade hua (Chromium + HEIC pehle impossible tha, ab kaam karta hai)
- Alpha flattening, quality slider, maxDim downscale, kind-aware DropZone copy + honest error copy
- Pixel-verified QA: output colors exact, PDF structure + page content verified, Hindi, mobile 375px, 323 requests sab localhost
- Live: 33 | i18n: 1081=1081 | lint+tsc clean | dev.log clean

### P3.17 — Scan to PDF ✅
- Camera + live edge-detection overlay + torch, Otsu quad detection, homography perspective warp, Magic/B&W/Grayscale live preview filters, multi-page sessions, corner editor (pointer+keyboard), A4/Letter/fit output
- Smoke 54/54, EN+HI 1073=1073 keys, QA screenshots saved

### Pehle ke rounds (short)
- P3.16: lock-pdf + unlock-pdf (qpdf WASM) — *rasterize ab P4.2 mein wired ho gaya, web-optimize bana hi nahi (yaad rahe: P3.16 sirf lock/unlock tha)*
- P3.15: redact-pdf
- P3.14: generate-password
- P3.13: sign-pdf (Phase 5 done early)
- P3.11–12: lock-pdf + unlock-pdf (qpdf WASM — Phase 4 done early)
- P3.10: fill-out-pdf
- P3.9: view-pdf, compress-pdf
- P3.7–8: page numbers + header/footer (stamp-common architecture), crop-pdf
- P3.1–6: PageGrid family, images-to-pdf, pdf-to-jpg/png/txt, watermark
- P2: core engine sab (worker pool, storage, ToolShell)
- P0–1: design system, layout, registry, i18n

---

*Ye file update karna har bade kaam ke baad — "Session Log" mein append karo aur Quick Status numbers refresh karo.*
