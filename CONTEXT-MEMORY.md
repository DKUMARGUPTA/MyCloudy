# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> Detailed technical handover = `/home/z/my-project/worklog.md` (ye file uska quick summary hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** Task-3 + SEO round ke baad — Create PDF (61st tool) + keyword-research SEO injection shipped — **61 tools live**.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Total tools in registry | **97** |
| **Ready to use (LIVE)** | **61** ✅ |
| Pending (Coming Soon) | **36** ⏳ |
| Phase | 3/4 (tools one-by-one) + Phase 8 editor IN PROGRESS |
| Server | Next.js 16.1.3, port 3000, HTTP 200, dev.log clean |
| Privacy | 100% on-device (Mode D) — zero external requests |
| i18n | English + हिंदी (1840 = 1840 keys parity) |
| SEO (SEO round) | Title/description/keywords research se, JSON-LD (WebApplication + FAQPage), home Popular-Tools + FAQ sections, robots.txt + sitemap.xml |
| HEIC decode | Self-hosted libheif WASM — har browser mein (Safari native fallback) |
| OCR (P3.19) | Self-hosted Tesseract 7 LSTM — eng + hin, searchable PDF + TXT |

---

## ✅ 61 LIVE TOOLS (Ready to use — sab tested & QA-passed)

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

### ✏️ Edit (11/11) — CATEGORY COMPLETE
- ✅ **Edit PDF (`edit-pdf`) — P8.1: FLAGSHIP EDITOR v1 live!** Text (4 fonts + Devanagari, B/I/U, align, colors, bg), images (upload + aspect resize), shapes (rect/ellipse/line/arrow + fill/stroke/dash), freehand draw, whiteout, signature pad, select/move/resize, z-order + lock/hide, properties + layers panels, context menu, coalesced undo/redo, full keyboard, zoom, export worker (rotation-compensated text, embedded fonts, DCTDecode image passthrough); **P8.3: EXISTING TEXT EDIT** — click any line (pdf.js text pieces) → whiteout (bg-sampled cover) + retype same spot with matched font (standard-14 exact, name-table closest, Devanagari auto), ink colour picked from page pixels; **Find & Replace** (whole-doc scan, line-level replace-one/all, match case, done markers, same font rules)
- ✅ Fill out PDF forms (`fill-out-pdf`) — AcroForm scan, auto-fill profile (name/email/phone/address), Hindi Devanagari support, flatten switch
- ✅ Make PDF fillable (`make-pdf-fillable`) — P4.2: auto-detect (underlines/boxes/checkbox squares) + manual drag-draw + rename/type-edit + AcroForm export
- ✅ Annotate PDF (`annotate-pdf`) — P8.2: drag-to-highlight WORD-SNAPS to pdf.js text runs (per-line quads), underline/strikeout follow text lines, sticky notes (Devanagari-safe /Contents), scanned-page /Square fallback, comments rail; **REAL PDF annotations** (/Highlight /Underline /StrikeOut /Text + /QuadPoints Acrobat order) — Chrome/Acrobat mein editable
- ✅ Add watermark (`add-watermark`) — text/logo, opacity, tiling
- ✅ Add page numbers (`add-page-numbers`) — 8 formats, Roman/Hindi digits, 9-grid
- ✅ Header & footer (`add-header-footer`) — {page} {date} {filename} variables
- ✅ Crop PDF (`crop-pdf`) — visual crop box + auto-detect
- ✅ Change document info (`change-pdf-doc-info`)
- ✅ Overlay PDF (`overlay-pdf`) — base+stamp merge, page mapping, position/opacity
- ✅ Change page size (`change-pdf-page-size`) — A3/A4/A5/Letter/custom mm, fit/fill/none

### 📷 Create (5/10)
- ✅ Scan to PDF (`scan-pdf`) — camera + edge detection + Magic/B&W filters + perspective correction
- ✅ Images to PDF (`images-to-pdf`) — JPG/PNG/WEBP/HEIC/TIFF/SVG
- ✅ Generate QR code (`generate-qr-code`) — link/text/WiFi/UPI/vCard/email/phone/WhatsApp, colors+logo, PNG/SVG/PDF
- ✅ Write PDF (`write-pdf`) — P8.4: noFile word-processor — templates (blank/letter/हिंदी आवेदन/offer/report), uncontrolled contentEditable blocks (p/h1-h3/bullet/numbered/quote), B/I/U/colour via execCommand, tables + images + page breaks + dividers, page setup (4 sizes × portrait/landscape × 3 margins), header/footer with {date}/{page}/{pages}, page numbers, SAME pure layout engine for the live paginated preview (canvas metrics, metric-compatible faces) and the pdf-lib export worker (surface-driven run, progress → on-device download), Devanagari via embedded Noto (blockScript recipe), coalesced doc-wide undo/redo
- ✅ Create PDF (`create-pdf`) — Task-3: noFile ready-made paper — 6 templates (blank / lined college-wide-narrow + red margin rule / grid 5-2.5mm / dot 5mm / Cornell cue+summary+header / weekly planner Mon-Sun + notes), 4 paper sizes × portrait/landscape × 3 margins, pages 1-50 (planner 1-12), PURE model planPages → worker paints (drawLine / filled drawEllipse dots / helv+Noto labels), same-plan scaled live preview (CSS mini-previews on the cards), localized output names (साप्ताहिक-प्लानर-a4.pdf), smoke 86/86

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

### 👁️ View (4/6)
- ✅ View PDF (`view-pdf`) — thumbnails, search, outline, dark mode
- ✅ Compare PDF (`compare-pdf`) — side-by-side diff report, sensitivity, case/whitespace
- ✅ Search in PDFs (`search-pdf`) — live surface highlights + TXT report, text/regex, case/whole-word
- ✅ Set viewer preferences (`set-pdf-viewer-preferences`) — P4.6: PageLayout (6), PageMode (fullscreen/thumbnails/bookmarks), zoom 50–200%//Fit//FitH + start page, DisplayDocTitle, hide toolbar/menubar/window-UI, fit/center window — tri-state "keep" semantics

### 📥 Convert to PDF (9/17)
- ✅ JPG to PDF (`jpg-to-pdf`) · ✅ PNG to PDF (`png-to-pdf`) · ✅ WEBP to PDF (`webp-to-pdf`) · ✅ HEIC to PDF (`heic-to-pdf`) — libheif WASM se har browser mein!
- ✅ TIFF to PDF (`tiff-to-pdf`) — P4.4: clean-room TIFF reader (LZW/PackBits/Deflate/G3/G4, multi-page IFD, DPI-aware fit), "N pages" chip + main-thread preview
- ✅ SVG to PDF (`svg-to-pdf`) — P4.4: main-thread raster (workers SVG decode NAHI kar sakte) + assets bridge (logo-store pattern), fit = graphic ka apna 96-DPI size
- ✅ Text to PDF (`txt-to-pdf`) + Markdown to PDF (`markdown-to-pdf`) — headings/lists/quotes/code, Devanagari
- ✅ Universal converter (`convert-to-pdf`) — smart routing surface, file detect → sahi tool

### 📤 Convert from PDF (4/13)
- ✅ PDF to JPG (`pdf-to-jpg`) · ✅ PDF to PNG (`pdf-to-png`) · ✅ PDF to Text (`pdf-to-txt`)
- ✅ Universal converter (`convert-from-pdf`) — smart routing surface

### 🖼️ Image Tools (5/6) — P3.18 NAYA!
- ✅ HEIC to JPG (`heic-to-jpg`) — iPhone photos, har browser mein
- ✅ HEIC to PNG (`heic-to-png`) — lossless
- ✅ WEBP to JPG (`webp-to-jpg`) — alpha flattening + quality
- ✅ WEBP to PNG (`webp-to-png`) — transparency preserved
- ✅ Resize image to KB (`resize-image-kb`) — P4.7: exam/govt forms — 20/50/100/200/500 KB/custom target, JPEG quality binary-search + ×0.8 dim ladder (120px floor), PNG dim ladder, passthrough, honest amber miss chip, JPG/PNG/WEBP/HEIC/GIF/BMP input
- ⏳ passport-photo (P3)

---

## ⏳ 36 PENDING TOOLS (Kaam baki hai)

### 🔜 Next Up — Priority Queue (Phase 2 tools, sabse pehle)
Ye PRD ke hisaab se agle banne hain (one per round):
1. **Edit PDF sub-phase 8.4** (form fields in editor) / **8.6 mobile polish** — write/create dono ho gaye
2. Phase-3 ke bade tools: `word-to-pdf` (S), `create-resume`, `create-photo-collage`… (create category baaki: photo-collage, card, fillable-form, resume, passport-photo)

*(P4.1: 14 tools wired ✅ — P4.2: rasterize + make-fillable ✅ — P4.3: copy-from-pdf ✅ — P4.4: image-render FIX + TIFF/SVG ✅ — P4.5: assemble-pdf ✅ — P4.6: set-pdf-viewer-preferences ✅ — P4.7: resize-image-kb ✅ — P8.1: edit-pdf v1 ✅ — P8.2: annotate-pdf ✅ — P8.3: edit-pdf existing-text + F&R ✅ — P8.4: write-pdf ✅ — Task-3: create-pdf ✅)*

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
- **⚠️ HMR DUAL-INSTANCE TRAP (P8.1): mid-QA edits se asset-store ka DUAL module instance ban sakta hai — surface NAYE instance mein setRunOrder karta hai, STALE config ke collectRunAssets PURANE (khaali) se padhta hai. Symptom: blob mein assetOrder sahi par run mein assets:0. FIX: full `reload` (production mein single instance — dev-only ghost). Mid-QA store→worker pairing edit ke baad hamesha fresh reload se re-verify karo.**
- **⚠️ agent-browser synthetic PointerEvents (P8.1): pointerdown + pointerup SAME TICK mein dispatch karne se gesture state stale rehti hai (move handler ka closure purana dekhta hai). RECIPE: down → 150ms wait → move(s) → up. Real users ko ye problem nahi (React events ke beech re-render flush hota hai).**
- **⚠️ pdf.js font metadata (P8.3): getDocument({fontExtraProperties: true}) karne pe BHI standard-14 fonts (Helvetica/Times/Courier non-embedded) commonObjs mein AA hi nahi aate (kuch load ho hi nahi) → real name sirf EMBEDDED fonts ka milta hai (`page.commonObjs.get(fontName).name` — subset prefix jaise "ABCDEF+ArialMT" ke saath). Standard-font PDFs ke liye `textContent.styles[fontName].fontFamily` ("sans-serif"/"serif"/"monospace") hi family drive karta hai — "closest" messaging ke saath honest. textLayer recipe: `tools/edit-pdf/text-layer.ts` (piecesFromPage viewport-matrix pattern + fontMetaFor defensive lookup).**
- **⚠️ Radix toast DOM selector (P8.3 QA): ye app sonner NAHI radix Toast use karta — toast DOM `ol.fixed > li` mein milta hai (`[data-sonner-toast]` hamesha null!). TOAST_LIMIT=1 + REMOVE_DELAY=1e6 → naya toast purane ko replace karta hai, kabhi auto-dismiss nahi hota — stale toast ke liye selector hi galat maan lo.**
- **⚠️ pdf-lib output byte-audit (P8.1): show-text ops HEX strings mein likhe jaate hain (`<45646974...> Tj`) + content streams Flate-compressed hain — raw string search kaam NAHI karta. RECIPE: node:zlib inflateSync(stream.contents) karke hex compare karo (`Buffer.from("text").toString("hex")`), image dict entries (/Subtype /Image, /DCTDecode) stream-dict plain hone se RAW bytes mein milte hain.**
- **⚠️ pdf-lib `getPage(index)` ZERO-BASED hai (P8.4 smoke lesson):** PDFDocument.getPage(0) = FIRST page. 1-based soch ke index likha to assertIs "index must be at least 0 and at most N-1" throw hota hai. Page ka content bhi ALWAYS array-of-streams hai (pdf-lib har draw call ka stream append karta hai) — inflate karke CONCATENATE karo, single stream assume mat karo. Type0 font /Subtype pe milta hai (/Type /Font dono simple+composite ke liye hai).
- **⚠️ useSyncExternalStore getSnapshot MUST return a cached reference (P8.4 client-side crash):** har call pe `[...store.values()]` naya array deta hai → React infinite-loop detect karke poora app crash ("Application error: a client-side exception"). FIX: module-level `snapshot` variable jo notify() pe rebuild hota hai (edit-pdf ka pattern tha — trimmed copy mein gir gaya). Naya store likhoge to snapshot caching kabhi mat bhoolein.
- **⚠️ document.execCommand + styleWithCSS (P8.4):** bold/italic/underline styleWithCSS=true ke saath `<span style="font-weight: bold">` jaise inline-style spans dete hain — B/I/U tags NAHI. DOM→runs parser ko inline styles (fontWeight ≥600/bold, fontStyle italic, textDecoration underline) + span color dono padhne padte hain, warna formatting model mein gum ho jaati hai (editor mein dikhta hai, PDF mein nahi jaata).
- **⚠️ Radix DropdownMenu + agent-browser (P8.4):** plain `.click()` menu ITEMS pe kaam NAHI karta — recipe: item pe `focus()` + Enter keydown, YA pointerdown → 150ms → pointerup sequence. Select (combobox) triggers wahi pointer-sequence maangte hain. QA scripts mein menus ke saath hamesha yeh sequence use karo.
- **✅ RESOLVED (P4.4): WORKER-SIDE pdf.js IMAGE-PDF BLANK RENDER:** P4.3 mein discover hua tha — image-based PDFs (JPEG scans) worker mein render karne pe BLANK milta tha (ocr-pdf conf 0, pdf-to-jpg blank JPGs). **Root cause: pdf.js ka `DOMCanvasFactory._createCanvas` image pages pe `document.createElement("canvas")` call karta hai (pdf.min.mjs @174658 + CachedCanvases render path)** — purana worker shim sirf `{baseURI}` tha, `createElement` missing → pdf.js image draw silently skip → blank canvas. **Fix: `tools/pdfjs-common/worker-lib.ts`** — `workerDocumentShim()` (createElement → OffscreenCanvas + documentElement stub) + har `getDocument` mein `ownerDocument: workerDocumentShim()`. **P4.4 mein SAARE 10 pdf.js-using workers migrated**: rasterize, compare (pehle se), ocr-pdf, copy-from-pdf, pdf-to-images, compress-pdf-to-size, redact-pdf, pdf-to-txt, search-pdf, extract-images. **QA verified:** ocr-pdf scan → conf 95 + searchable text correct; pdf-to-jpg scan → 1240×1754 non-blank; rasterize scan → JPEG-embedded; copy-from-pdf scan → OCR .txt verbatim; compress-to-size raster ladder error-free + non-blank (logical proof: blank JPEGs tiny hote, structural jeet gaya = raster content real tha). Text-PDF passthrough regression bhi PASS. **Naya rule: koi bhi tool worker mein pdf.js use kare → `loadPdfjsInWorker` + `workerDocumentShim()` from `../pdfjs-common/worker-lib` + `ownerDocument` param — inline loader KABHI mat likho.**
- **⚠️ pdf-lib `drawImage` SILENTLY IGNORES `w`/`h` — sirf `width`/`height` accept karta hai (P4.4 bug):** imagegrid worker `page.drawImage(img, {...box})` spread kar raha tha jahan box = {x,y,w,h} — pdf-lib w/h ko IGNORE karta hai aur image ko NATIVE PIXEL SIZE pe draw karta hai (1697px SVG raster = 1697pt = 2.3 A4 pages, page ke bahar clip!). Chhote test images pe visually theek dikhta tha (300px photo = 300pt = page ke andar) isliye pakda nahi gaya. FIX: `{x: box.x, y: box.y, width: box.w, height: box.h}`. **RULE: pdf-lib draw calls mein kabhi spread mat karo — explicit width/height likho.** (rasterize/compress-to-size already sahi the — sirf imagegrid affected)
- **SVG in workers IMPOSSIBLE without WASM (P4.4):** Chrome/Firefox `createImageBitmap` SVG blobs reject karta hai ("The source image could not be decoded") — direct verify kiya. SOLUTION: **main-thread raster** — Image element + canvas drawImage (SVG vector ko DRAWN SIZE pe raster karta hai, crisp) + `collectAssets` bridge (add-watermark logo-store pattern): surface card preview ke dauraan rasterize → store (Map keyed name:size:mtime) → config ka collectAssets run-time pe File[] deta hai → worker k-th SVG file ↔ k-th asset pairing. Natural dims side-car `svg-dims.json` manifest (LAST asset) — "fit" pages graphic ke apne 96-DPI size pe, upscaled raster pe NAHI. Pending gate: useSyncExternalStore + pending counter → CTA blocked (igrid.svgRasterizing).
- **Streaming open-blocks algorithm (P4.3):** side-by-side columns wale pages pe paragraphs group karne ke liye — lines reading order mein aati hain, har line newest-open-block se match hoti hai (tight leading + x-overlap ≥25% + size ratio ≤1.35), bullet lines hamesha naya block, wrapped bullet continuation sirf indent-check se. Columns kabhi cross nahi hote, reading order banta rehta hai.
- **Worker bundle hygiene (P4.7):** shared helper se sirf ek chhota function chahiye to TRANSITIVE DEPS check karo — `compress-common/recompress.ts` se `committedJpegBlob` import karna pdf-lib + engine graph worker bundle mein kheench lata. 20-line guard inline karna better hai jab function chhota ho. Lekin PURE logic (engine.ts) hamesha shared rahe — wo test hota hai.
- **KB-targeting ladder recipe (P4.7):** size-first, quality-second — har dim step pe quality binary search (monotone size(q)), hope-less steps sirf 1 probe se skip; canvas-commit guard HAR encode pe (blank JPEG budget mein "fit" ho ke silently jeet jata — corrupt output user ko milta); passthrough same-format already-under; floor miss = smallest + targetHit:false amber.
- **Remount-detection-kicker:** effects jo `[files.length]` pe keyed hain mount pe fire hote hain
- **Cancel path:** worker pool instant terminate + OPFS cleanup — 600 DPI 400-page run pe 6% pe catch verified

---

## 📝 Session Log (naya kaam yahan append karo)

### SEO Round — Keyword research injection ✅ (user-provided research)
- **User ne Semrush-style keyword research diya** (pdf converter 1.2M, jpg to pdf 450K, pdf to word 450K, pdf to jpg 301K, pdf editor 246K, free tool to edit pdf documents 3.6K, pdf tools 1.9K, pdf conversion tool 1.6K, pdf editing tools freeware...) — sab inject kiya:
- **`src/app/layout.tsx` metadata:** title "Free PDF Tools — Converter, Editor, Merger & More | DocoPDF" (~61 chars), description (~155 chars, jpg to pdf + pdf to word/to jpg + no signup + on-device + हिंदी), 19 keywords research se, OG (locale en_US + alternate hi_IN) + Twitter card + canonical "/" + googleBot max-snippet/image-preview directives.
- **JSON-LD (server-rendered, layout body mein 2 script tags):** WebApplication (UtilitiesApplication, free offer, 10-item featureList, inLanguage en+hi) + FAQPage (6 Q&A EN — home FAQ section ke saath SYNC MEIN rakhna, layout.tsx comment hai).
- **Home naye sections:** `src/components/doco/home/popular-tools.tsx` — 8 keyword-anchored cards (JPG to PDF, PDF to JPG, Merge, Compress, Edit, Sign, PDF OCR, Create PDF) — name/desc/icon REGISTRY se aate hain (auto-sync, zero i18n keys) + category color chips; `src/components/doco/home/faq.tsx` — 6 SEO Q&A (free?, jpg→pdf?, pdf→word?, upload?, "without Adobe Acrobat"?, Hindi?) Radix Accordion se. Page order: Hero → **PopularTools** → Steps → Categories → Why → RecentFiles → Modes → **Faq**.
- **hero.subtitle copy upgrade:** "Free PDF converter, editor, merger and more — everything runs right in your browser, no uploads, no signup." (hi: फ़्री पीडीएफ़ कन्वर्टर, एडिटर और मर्जर...).
- **i18n:** `scripts/merge-home-seo-i18n.ts` (self-contained patch + ALLOW_UPDATE whitelist sirf hero.subtitle ke liye) — popular.* 2 + faq.* 14 = +16 keys ×2 + 1 update → **1840=1840**.
- **QA (agent-browser):** title/subtitle live; Popular section 8 cards keyword anchors ke saath; FAQ accordion expand + answers; JSON-LD `["WebApplication","FAQPage"]` DOM mein, FAQPage 6 questions; Create PDF card → #/tool/create-pdf nav; HI full (लोकप्रिय पीडीएफ़ टूल्स / अक्सर पूछे जाने वाले सवाल / FAQ Hindi); mobile 375px overflowX=0 (popular 1-col, FAQ 56px buttons); console zero errors; network zero non-localhost. Screenshots: qa-seo-popular.png / qa-seo-faq.png / qa-createpdf-desktop.png.
- **Note:** sitemap.xml + robots.txt pehle se sahi the (P0 se) — keyword priorities already set.
- Live: 61 | i18n 1840=1840 | tsc + eslint + dev.log clean.

### Task-3 — Create PDF ✅ 61st TOOL (ready-made paper & planner, PRD §7.3)
- **PRD §7.3 "Create PDF"**: instant ready-made paper PDFs — koi document nahi, koi word-processor nahi. Task spec ke mutabik 6 templates: blank, lined (college 7.1mm / wide 8.7mm / narrow 6.35mm + optional red margin rule), grid (5mm / 2.5mm), dotted (5mm bullet-journal), Cornell (cue column ~2.5in + summary strip + optional header line), weekly planner (Mon-Sun localized labels + notes area, one week per page). Letter/offer/report write-pdf mein hain, invoice/resume alag Phase-3 tools — intentionally nahi banaye.
- **Architecture (write-pdf recipe exactly):** `noFile: true` + surface-driven worker run — `tools/create-pdf/model.ts` PURE (CSpec wire format + sanitizeCSpec + planPages → lines/dots/rects/labels plain data, PDF pt bottom-origin; grid/dot centered-offset trick se partial cells dono taraf split hote hain jabki spacing EXACT rehti hai; planner geometry + C_DAY_NAMES/C_NOTES_LABEL inline L10n + cOutputName localized base names), `worker.ts` (pdf-lib painter: drawLine rules / filled drawEllipse dots — pdf-lib ka drawCircle nahi hai, drawEllipse xScale=yScale=r ka filled dot hai / drawText labels helv + embedded Noto sirf hi-planner ke liye via loadStampFonts; progress per page), `surface.tsx` (6 template cards CSS mini-previews ke saath — pure CSS gradients/konkord divs, koi image nahi; options fieldset; SAME plan ka scaled live preview 560px cap ke saath; CTA spawns real Worker; downloadBlob + success chip).
- **Wiring:** registry `enabled: true` + description honest update ("Ready-made paper: blank, ruled, grid, dot grid, Cornell notes, weekly planner") + configs.ts + surfaces.tsx + i18n "create" section 49 keys ×2 (merge-create-pdf-i18n.ts) — 1824=1824 parity.
- **Smoke 86/86 GREEN** (`scripts/smoke-create-pdf.ts`): Part 1 model 54 (sanitizer defaults/clamps incl. planner 12 cap, A4/Letter/legal geometry + landscape swap, blank zero-ops, lined spacing exact + first-rule position + red margin rule, grid exact 5mm/2.5mm both axes + centered partial cells, dotted row pitch + uniform counts, cornell cue min(180, 35%) + 144pt summary cap + header line, planner 8 labels + 7 separators + notes-boundary math + hi needNoto + सोमवार labels, output names incl. रूल्ड-पेज-landscape) + Part 2 REAL worker 32 (hi planner → साप्ताहिक-प्लानर-a4.pdf + Type0 Noto subset + hex Tj + line ops; lined letter landscape ×3 pages; dot grid filled-ellipse curve ops >3000; cornell ×2; blank ×4; corrupt/empty → tool.errorGeneric; garbage spec sanitized).
- **QA (agent-browser):** EN landing (6 cards, template-specific options switch: cornell → 2 switches, grid → square size, planner → pages hint; how-it-works/FAQ/features/related) → CTA byte-verified (Worker subclass constructor tap → blob.arrayBuffer): lined-paper-a4.pdf %PDF- 1387B 1 page + success chip; Hindi full UI + planner preview सोमवार..रविवार on CreatePdfDeva FontFace + export byte-verified 4653B + app's own pdf.js read-back (visual labels correct; known documented i-matra extraction reorder limitation — stamp/write-pdf recipe v1); landscape select (Radix pointer-sequence recipe) → रूल्ड-पेज-a4-landscape.pdf; mobile 375×812 overflowX=0 EN+HI, cards 166px, CTA 44px; console errors 0; non-localhost requests 0.
- **2 bugs pakde & fix kiye:** (1) **write-pdf preview LINES vertically mirrored the** — LLine y PDF bottom-origin hai (empirically verified: underline y1 = baseline−1.76) lekin preview `top: line.y1 * previewScale` kar raha tha (rects/pieces sahi (pageH−y) use karte hain) → underlines/hr/table borders preview mein neeche dikh rahe the. Fix: (pageH − y) flip dono orientations ke liye. Regression smoke-write-pdf 95/95. (2) mobile overflowX=201 — preview figure grid-item ka min-width:auto fixed-width preview se expand ho raha tha → `min-w-0` + 560px preview cap.
- Live: **61 / 97** | i18n 1824=1824 | smoke 86/86 (+95/95 write-pdf regression) | tsc + eslint + dev.log clean.

### P8.4 — Write PDF ✅ 60th TOOL (word-processor, PRD §8)
- **PRD §8 "Write PDF"**: "Rich text editor: headings, bold/italic/underline, lists, tables, images, page breaks, header/footer, fonts (Hindi), page numbers; templates (letter, application, offer, report); live page preview; export PDF" — scratch se, text-layout engine reuse karke.
- **Architecture (noFile + surface-driven worker run):** `noFile: true` (qr-code pattern) — surface landing pe render hota hai (template picker), aur khud apna export Worker spawn karta hai (shared protocol: options.doc JSON + files[] images) — progress → downloadBlob + success chip. Zero ToolShell changes.
- `tools/write-pdf/model.ts` PURE (~1120 lines): WDoc wire format (title/setup/blocks: p/h1-h3/bullet/numbered/quote/table/image/hr/pagebreak), sanitizeWDoc clamps, layoutDoc — PageFlow/planLineGroup/wrapRuns/positionRuns REUSE from txt-to-pdf/text-layout (sirf WrapRun pe `underline?: boolean` additive flag + mergeLineRuns comparison + FontSpec `serif` add hua), keep-with-next headings, table rows atomic (top border sirf first-row/fresh-page pe — duplicates nahi), quote bars per page-fragment, image content-height clamp, header/footer/{page}/{pages}/{date} substitution + page numbers, LPiece/LLine/LRect/LImage output (worker paints, preview DOM-render karta hai).
- `worker.ts`: helv/times/courier ×4 variants + noto (blockScript recipe) — preview Helvetica/Arial, Times New Roman, Courier New browser faces metric-compatible hain isliye WYSIWYG ~exact; images magic-sniff embedJpg/embedPng + fallback swap.
- `templates.ts`: blank + Letter (serif EN) + आवेदन (classic Hindi format) + Offer + Report (table + pagebreak + quote) — inline L10n content.
- `surface.tsx` + `parts.tsx`: uncontrolled contentEditable (innerHTML sirf [version] bump pe re-sync — typing kabhi clobber nahi hoti), runsToHtml/parseEditableRuns DOM↔model, execCommand styleWithCSS B/I/U/foreColor + selectionchange queryCommandState toolbar, block rail (move/duplicate/delete + Enter→new block, Backspace-empty→delete+focus neighbour), table editor (+row/+col/−row/−col/header switch), image blocks (asset-store pattern, scale/align/replace), page setup panel, coalesced doc-wide undo/redo (800ms, 100 snapshots, ref-reads render se BAHAR — React Compiler refs rule), live paginated preview (SAME layoutDoc + canvas measureText, DocoWriteDeva FontFace /fonts TTF se, debounce 160ms, scale = container/pageW).
- **Wiring:** registry enabled:true + configs.ts + surfaces.tsx + i18n 89 keys ×2 (`write` section, merge-write-pdf-i18n.ts) — 1775=1775.
- **Smoke 95/95 GREEN** (`scripts/smoke-write-pdf.ts`): sanitizer clamps/drops, script detect, word count, asset order, naming, pagination (hard-split char preservation, no blank pages), lists (•, 1..3 consecutive), quote bar geometry, hr, underline stroke, keep-with-next, table (borders 4H+9V, header bg, split, all rows), images (aspect/clamp/centred/missing skip), hf substitution + baselines, landscape+narrow, templates shape + REAL worker e2e (self+fetch shim): battery output reload — pages/A4/Tj hex/image XObject/Type0/footers + honest errors (empty/corrupt/missing-asset) + process.exit(0) success pe (fontkit handles bun ko zinda rakhte the!)
- **QA (agent-browser):** EN landing (5 template cards + how + FAQ) → Report pick (18 blocks, table, page break) → type + bold (execCommand) → undo/redo → add-block menu (Radix pointer-sequence recipe) → bullet + table +row → page setup (header {date}, footer {page}/{pages}, page numbers center) → preview (2 pages, 44 pieces, 34 lines, hf + bare numbers rendered) → EXPORT BYTE-VERIFIED (Worker subclass tap → blob.arrayBuffer → app's pdf.js): "Quarterly Report.pdf", 2 pages, table text (+31.7%), image paintImageXObject page-2, typed text present; Hindi full flow: आवेदन template + typed "कृपया इसे मंज़ूर करें।" + "आवेदन.pdf" 1 page 9,113 dark px (real Devanagari rendering); mobile 375×812 overflowX=0 (edit + preview, toolbar wraps, paper 343px); console errors 0; resources sab localhost.
- **3 QA bugs pakde & fix kiye:** (1) trimmed asset-store ne cached snapshot chhod diya tha → useSyncExternalStore infinite loop + client-side exception → snapshot variable wapas; (2) execCommand('bold') styleWithCSS `<span style="font-weight: bold">` deta hai — parser sirf B/STRONG padhta tha → inline style (fontWeight/fontStyle/textDecoration) parse add; (3) formatState selectionchange pe new object → render-loop guard (values-diff check).

### P8.3 — Edit PDF: existing text edit + Find & Replace ✅ (edit-pdf upgrade)
- **PRD §8.2 "Edit existing text"** ("Text layer (pdf.js) detect karke click par text block edit mode; original text area whiteout + naya text same position par, font match; line-by-line, no reflow; UI me font mil gaya / nahi mila") + **"Find & Replace"** (same font rules) — dono scratch se, editor core reuse karke.
- `tools/edit-pdf/model.ts` PURE additions: `matchFont` (name table + subset-prefix strip + standard-14 EXACT_NAMES + class flags + cssFamily fallback + Devanagari-text override), `pieceRect` (ascent/descent band + pads — retype baseline original ke ~0.35pt ke andar), `buildReplacePieceObjects` / `buildReplaceLineObjects` (whiteout+text pair, dominant-font line builder), `groupPiecesIntoLines` (baseline bucket + 1.2×em gap join, x-order), `planLineReplacements` (literal, case toggle, occurrence offsets), `substituteOccurrences` (overlap-guarded ranges), ink/bg pixel pickers (`medianRgb`, `pickInkFromPixels` percentile clusters + contrast guard).
- `tools/edit-pdf/text-layer.ts` NAYA (main-thread pdf.js): `harvestPageText` + `scanPagesText` shared `piecesFromPage` (viewport-matrix mapping) — `getDocument({fontExtraProperties: true})` + defensive `commonObjs.get(fontName)` se real font name/bold/italic/mono/serif.
- `tools/edit-pdf/surface.tsx`: edittext tool ("E" shortcut, cursor text) + lazy per-page piece cache + `TextPieceButtons` overlay (pointer-events-none wrapper, buttons auto, 22pt min centered hit bands, hover/focus ring) + `pickPiece` (bitmap ink/bg sampling via OffscreenCanvas→DOM-canvas fallback scratch, whiteout+text ek history group mein, toast font matched/closest) + scanned-page amber notice + F&R state (bulk scan cached once per file, flattened lines memo, replace-one/all line-level with done-key marking, jump closes dialog) + per-file cache resets.
- `tools/edit-pdf/editor-parts.tsx`: toolbar "Edit existing text" button (TextCursorInput), CanvasHeader "Find & replace" button (Replace icon), `TextPieceButtons`, `FindReplaceDialog` (query/replace inputs, match-case switch, scanning progress, match list max-h-96 scroll with page chips + <mark> excerpts + done checks, plural count + honest wrap note).
- Worker: ZERO changes (whiteout+text existing objects hi replacement hain — z-order array order se cover pehle). Wire blob format unchanged.
- i18n +25 keys ×2 (fontMatched/fontClosest/noText*/piece*/fr* 20) + how2 copy update — **1686=1686** (scripts/merge-edit-text-i18n.ts patch-merge precedent: ALLOW_UPDATE whitelist for intentional copy changes).
- Smoke `scripts/smoke-edit-pdf-text.ts` **71/71 GREEN**: matchFont battery (17 cases: subset prefixes, standard-14 exact, flags-override-name, class fallbacks, Devanagari), pieceRect math, builders rot0+rot90 exact, sanitizer passthrough, line grouping, F&R planning + substitution (overlap/literal/metachar), ink pickers, REAL worker e2e (zlib-inflated content: cover `1 1 1 rg` BEFORE retype hex, retype Tm baseline 760.35 vs original 760, original text still present-but-covered). Regressions: smoke-edit-pdf 48/48, smoke-annotate 87/87.
- QA (agent-browser): EN landing (new feature + how2 copy) → drop edit-fixture → edittext tool → 3 pieces → click → whiteout+text pair + textarea prefilled+focused + toast "Closest font: Helvetica" → live typing → undo grouping (3 undos = 2 pairs + 1 text edit, exact) → F&R "page"→"SHEET" replace-all = 6 objects + "3 lines replaced" toast + 3 done-checks → ONE undo/redo step (6→0→6) → run → output 3220B: "SHEET 1 of 3" extractable (wrap: "3" second line — honest note), original text still in file (covered), **pixel-compare source vs output band: 2187/3052 old-ink px now light (71.6% covered) + 2064 new-ink px**; HI full flow (toolbar/notice/toast "सबसे करीबी फ़ॉन्ट: Helvetica (असली: पता नहीं चला)"/F&R dialog/"दस्तावेज़" replacement extractable + मोबाइल-टेस्ट-edited.pdf name/"3 लाइनें बदली गईं" plural) ; mobile 375×812 overflowX=0 + toolbar scroll + touch piece click + F&R dialog fits; scanned page (ocr fixture) → amber "No selectable text" + OCR suggestion + 0 pieces; console ZERO errors; 69 requests sab localhost.
- Live: 59 (edit-pdf upgrade, koi naya tool nahi) | Next queue: write-pdf, phir create-pdf

### P8.2 — Annotate PDF ✅ 59th TOOL (Edit category 11/11 COMPLETE)
- **PRD §8.2** "Highlight / Underline / Strike" (real PDF annotations!) + "Sticky note / Comment" — scratch se bana, edit-pdf core patterns reuse karke (epoch-key blob, page strip, history, keyboard).
- `tools/annotate-pdf/` — **model.ts** PURE (Quad Acrobat BL/BR/TR/TL order, mirrored PageView transforms ×4 rotations, piecesFromItems harvest (viewport matrix direct — P4.3 insight), piecesInDrag word-snapping (vertical ≥50% of the smaller band + horizontal: contained | ≥30% w | starts/ends inside — drag mid-word poora word lights up), groupRuns baseline-bucket + gap merge, buildMarkupFromDrag + scanned fallback square, makeNote, sanitizer (quads ≤64, annos ≤2000, page clamp, empty-note drop), history helpers) + **worker.ts** (pdf-lib REAL annotations: /Highlight +/QuadPoints +/IC +/CA, /Underline & /StrikeOut +/C full-strength, /Square fallback (/BS W 0 + /Border [0 0 0] + /IC + /CA), /Text sticky (/Name /Comment, 22×22 /Rect, /Open false); /Contents PDFHexString.fromText — Devanagari-safe; page.getCropBox() clamping) + **surface.tsx** (ek hi pdf.js doc session bhar khula — views + per-page text pieces cache; "a:<fileId>" blob {annos, pageViews}; toolbar 5 tools + 5 swatches + custom + opacity slider; markup bands % positioned (highlight fill / underline bottom line / strikeout mid line); note markers draggable (size-11 md:size-9, drag-vs-click suppression ref); NoteBubble textarea (stopPropagation onPointerDown!); comments rail page-grouped (max-h-96 scroll); setRunBlocked notReady + noAnnos; V/H/U/S/N shortcuts + Delete + Ctrl+Z/Y + +/- zoom; 500-page guard) + **parts.tsx** presentational chrome.
- **Wiring:** registry enabled:true (59 live / 38 pending) + configs.ts + surfaces.tsx + protocol RunDetail.annotations/notes + result-view chip (result.annotationCount) + i18n ann.* 52 keys ×2 + scripts/merge-annotate-pdf-i18n.ts (full-add + result-patch precedent) — **1661=1661**.
- **2 REAL BUGS QA se pakde:** (1) ⚠️ **ICU-lite plural SUBSET SIRF `=1 {..} other {..}` HAI** — teen-branch (=0/=1/other) keys RAW render hoti hain! Sabhi plural keys 2-branch hi likho. (2) worker `context.register()` ko plain object diya to save() pe "sizeInBytes is not a function" — **register(obj(dict)) hamesha, obj() khud nested dicts handle karta hai**.
- **Smoke 87/87 GREEN** (`scripts/smoke-annotate-pdf.ts`): model battery (harvest, drag rules, word-merge, rot0/rot90 quad math exact, fallback rect, sanitizer, history) + REAL worker (highlight 2 quads + underline + strikeout + square + Hindi note → pdf-lib RELOAD + parse-level asserts: subtypes, QuadPoints 16 numbers, /CA 0.45, /BS W 0, /IC channels, /M date, Hindi decodeText round trip, rect centre, page-99 clamp, corrupt → tool.errorCorrupt).
- **QA (agent-browser):** EN landing/workspace/flows (highlight band top exactly 12.93% = line-1 geometry; underline bottom-of-band, strikeout mid-band — teeno kinds verified), rail excerpts verbatim, undo/redo/rail-delete, sticky note bubble + Devanagari text, **output verified IN-BROWSER via app ka khud ka pdf.js** (`import('/pdfjs/pdf.min.mjs')` → getAnnotations(): subtypes + quads + contents + opacity + color sab correct; pdf.js 4.x NOTE: `contentsObj.str` hai, `contents` NAHI, quadPoints array-of-numbers) + Worker subclass constructor tap (addEventListener('message') — onmessage intercept kiye bina); HI full UI + HI export + "1 टिप्पणी जुड़ी" chip; touch-pointer flow; mobile 375px overflowX=0 (page/toolbar/canvas); zero page errors; zero non-local requests; tsc/eslint clean; dev.log clean (sirf 200s + JSON-edit Fast Refresh advisories).
- Live: 58 → **59** | Next queue: edit-pdf 8.3 (existing text edit), phir write-pdf

### P8.1 — Edit PDF flagship editor v1 ✅ 58th TOOL (sub-phases 8.1+8.2+8.5)
- **PRD §8.2.1** "Word-style editor" ka v1: shell + objects + export (scratch se — koi ready file nahi thi).
- `tools/edit-pdf/`: model.ts PURE (EditorObject union × 8 kinds, PageView transforms ×4 rotations, factories, normaliseDraw, resizeRect aspect, z-order, snapshot history, greedy wrapText hard-break ke saath, wire sanitizer) + asset-store.ts (JPG/PNG decode-probe passthrough, WEBP/HEIC→PNG re-encode, ≤4096px, setRunOrder↔collectRunAssets pairing) + worker.ts (pdf-lib export: rotation-compensated text via degrees(/Rotate) + bilinear corner interpolation, fonts stamp-common + italic variants, DCTDecode image passthrough, open arrowheads) + surface.tsx (pointer machinery, inline textarea editing, sign pad, properties/layers/context-menu, coalescing undo/redo 800ms, keyboard, 500-page guard) + editor-parts.tsx (presentational chrome).
- **NEW ToolConfig flag `fullWidthSurface`** — options aside skip karo par run CTA rakho (viewerOnly run maar deta hai; ye nahi). ToolShell mein 4-line additive change.
- i18n 88 keys ×2 (1634=1634). Smoke **48/48 GREEN** (`scripts/smoke-edit-pdf.ts` — REAL worker module bun self-shim + fetch shim for deva TTF).
- **4 bugs QA ne pakde & fix kiye:** (1) wrapText hard-break unconditional-accept; (2) move double-count (disp.x + (pos−grab) → pos−grab); (3) setRunOrder commit mein missing — assets worker tak pahunchte hi nahi the (end-to-end byte-verify ne pakda: images:0 despite objects); (4) corrupt image ab add-time pe hi honest toast.
- QA: EN+HI, text hex-verified exact position pe, green fill output mein, 2000×1500 JPG DCTDecode embedded, sign pad, whiteout/arrow ops, undo/redo, layers hide/show, keyboard (t/Delete/Ctrl+Z), context menu, passthrough, corrupt-image toast, mobile 375px overflowX=0 stacked layout, console clean, ZERO external requests.
- Registry: 97 total / **58 enabled** / 39 pending. tsc clean, eslint clean, dev.log clean.
- Live: 57 → **58** | Next queue: annotate-pdf (editor core reuse), ya edit-pdf 8.3 (existing text edit)

### P4.7 — Resize image to KB ✅ 57th TOOL
- **PRD §7.10** "Photo + signature under 100/200 KB for exam and government forms" — scratch se bana (P4.5/P4.6 pattern: engine PURE + worker + config).
- `tools/resize-image-kb/` — **engine.ts** PURE (resolveTargetBytes presets+custom clamp 10–5000KB, capDimensions maxDim+40MP floor, dimLadder ×0.8 steps + exact 120px floor landing, searchQuality monotone binary search q∈[0.30,0.92]) + **worker.ts** (JPG/PNG/WEBP/GIF/BMP native decode + HEIC libheif; JPEG ladder = per-dim-step quality binary search, PNG ladder = dims only; **canvas-commit guard HAR encode pe** (committedJpeg/committedPng inline — compress-common import pdf-lib kheenchta, isliye 20-line inline copy); passthrough same-format already-under; honest targetHit miss) + **config.ts** (target 20/50/100/200/500/custom + customKB showWhen + format jpeg/png + maxDim 0/1200/800/600/400/240).
- **ZERO new i18n keys** (inline L10n + existing imgc.how/result chips/tool.images errors) — parity 1546=1546.
- **Smoke 49/49 GREEN** (`scripts/smoke-resize-image-kb.ts`): target math, clamps, 40MP, ladder shape (240→192→154→123→120), tiny single-step, searchQuality edges (MAX/None/floor/no-reprobe), ladder contract (hopeless-step skip + honest miss).
- **QA (agent-browser)**: EN landing/workspace/result; **byte-verified downloads** — 1.07MB noisy photo → 47,589B ≤ 50KB (1280×960, stddev 30.5 = real content, JPEG magic) + exam combo custom-20KB+maxDim-240 → 6,321B @ exactly 240×180; PNG signature passthrough (2.3KB untouched); honest miss (photo+PNG+10KB → amber "Target not reached" + smallest 16KB); HEIC fixture decode → jpg; corrupt file → HI error toast + filename; HI full run (Devanagari filename फ़ोटो-टेस्ट-resized.jpg); mobile 375px overflowX=0; 90 requests sab localhost; zero console errors.
- **Shared a11y fix**: result-view rename button 32px → `size-11 md:size-8` (44px touch target mobile pe, har tool ke result screen pe).
- Registry: 97 total / **57 enabled** / 40 pending. tsc clean, eslint clean, dev.log clean.
- Live: 56 → **57** | Next queue: edit-pdf (Phase 8, big), phir annotate-pdf

### P4.6 — Set viewer preferences ✅ 56th TOOL
- **PRD §8.5** "Viewer preferences: Initial page layout, zoom, window title show, hide toolbars, fullscreen" — no ready files thi, scratch se bana (P4.5 assemble pattern).
- `tools/set-pdf-viewer-preferences/` — config (11 tri-state options) + worker (pure pdf-lib). **ZERO new i18n keys** (sab copy inline L10n) — parity 1546=1546.
- Options: layout (6 PDF PageLayout values), pageMode (UseNone/UseThumbs/UseOutlines/UseAttachments/FullScreen), exitFsMode (showWhen pageMode=FullScreen — exit ke baad kya dikhe), zoom (50–200% + fitPage/fitWidth), startPage (OpenAction destination), showTitle/hideToolbar/hideMenubar/hideWindowUI/fitWindow/centerWindow (keep/on/off tri-state).
- Worker: `catalog.set(PageLayout/PageMode)` + `getOrCreateViewerPreferences()` (pdf-lib setters — HideMenubar "keep" pe dict entry NAHI likhta) + `NonFullScreenPageMode` (pdf-lib ka TS ENUM — string literal se assign NAHI hota, import karke use karo!) + OpenAction `[pageRef /XYZ null null zoom|/Fit|/FitH null]` (zoom null + startPage>1 = sirf page jump). `updateMetadata: false` (ModDate/Producer ko touch nahi karta).
- **Smoke 50/50 GREEN** (`scripts/smoke-viewer-prefs.ts` — REAL worker module bun mein self-shim se import hota hai, logic copy NAHI): full battery, all-keeps (kuch bhi likha nahi jaata — empty ViewerPreferences dict tak nahi banti), zoom-only, fitPage, startPage-only, explicit off, clamp, fs-default, whitelist defense, garbage error, replace semantics.
- **QA (agent-browser)**: EN landing/FAQ/features; drop → 11 options panel; showWhen field appeared with Fullscreen; full battery run → output blob captured (Worker subclass constructor tap + base64) → pdf-lib se verify: PageLayout=/TwoColumnLeft, PageMode=/FullScreen, NonFullScreenPageMode=UseOutlines, HideToolbar/HideWindowUI/DisplayDocTitle=true, **HideMenubar/FitWindow/CenterWindow ABSENT (tri-state keep)**, OpenAction=[page2 /XYZ null null 1.5] (MediaBox 300×400 se page-2 confirm); result screen chain = view-pdf/change-doc-info/compress/lock (mere chainToolIds); HI UI full (साइड पैनल/फ़ुलस्क्रीन मोड/ज़ूम/विंडो की जगह + Devanagari dropdown options + Hindi filename output फ़्रंट्स-viewersettings.pdf) + HI run structurally verified (FullScreen + /Fit + UseNone); mobile 375px no-overflow + options sheet 11 fields; corrupt file magic-byte toast at drop; zero page errors; console clean; sab requests localhost.
- Registry: 97 total / **56 enabled** / 41 pending. tsc clean, eslint clean, dev.log clean.
- Live: 55 → **56** | Next queue: resize-image-kb (P2), phir edit-pdf (Phase 8, big)

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
