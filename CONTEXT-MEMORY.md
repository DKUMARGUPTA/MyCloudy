# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> Detailed technical handover = `/home/z/my-project/worklog.md` (ye file uska quick summary hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** Scan to PDF (P3.17) ke baad — 28 tools live.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Total tools in registry | **97** |
| **Ready to use (LIVE)** | **28** ✅ |
| Pending (Coming Soon) | **69** ⏳ |
| Phase | 3 (tools one-by-one) IN PROGRESS |
| Server | Next.js 16.1.3, port 3000, HTTP 200, dev.log clean |
| Privacy | 100% on-device (Mode D) — zero external requests |
| i18n | English + हिंदी (1073 = 1073 keys parity) |

---

## ✅ 28 LIVE TOOLS (Ready to use — sab tested & QA-passed)

### 🗂️ Organize (6/12)
- ✅ Merge PDF (`merge-pdf`) — 50 tak PDFs jodo, reorder, page ranges
- ✅ Split PDF (`split-pdf`) — ranges / every-N / size / visually
- ✅ Rotate PDF pages (`rotate-pdf-pages`)
- ✅ Rearrange PDF pages (`rearrange-pdf-pages`) — drag + keyboard
- ✅ Remove PDF pages (`remove-pdf-pages`) — selection/blank-detect
- ✅ Extract PDF pages (`extract-pdf-pages`) — new PDF ya one-per-page

### ✏️ Edit (6/11)
- ✅ Fill out PDF forms (`fill-out-pdf`) — AcroForm scan, auto-fill profile (name/email/phone/address), Hindi Devanagari support, flatten switch
- ✅ Add watermark (`add-watermark`) — text/logo, opacity, tiling
- ✅ Add page numbers (`add-page-numbers`) — 8 formats, Roman/Hindi digits, 9-grid
- ✅ Header & footer (`add-header-footer`) — {page} {date} {filename} variables
- ✅ Crop PDF (`crop-pdf`) — visual crop box + auto-detect
- ✅ Change document info (`change-pdf-doc-info`)

### 📷 Create (2/10)
- ✅ Scan to PDF (`scan-pdf`) — camera + edge detection + Magic/B&W filters + perspective correction
- ✅ Images to PDF (`images-to-pdf`) — JPG/PNG/WEBP/HEIC/TIFF/SVG

### 🔒 Security (6/8)
- ✅ Protect PDF (`lock-pdf`) — AES-256 qpdf WASM
- ✅ Unlock PDF (`unlock-pdf`)
- ✅ Sign PDF (`sign-pdf`) — draw/type/upload signature
- ✅ Redact PDF (`redact-pdf`) — permanent hide, verified gone
- ✅ Remove PDF metadata (`remove-pdf-metadata`)
- ✅ Generate password (`generate-password`)

### ⚡ Optimize (1/8)
- ✅ Compress PDF (`compress-pdf`) — quality presets / custom DPI

### 👁️ View (1/6)
- ✅ View PDF (`view-pdf`) — thumbnails, search, outline, dark mode

### 📥 Convert to PDF (3/17)
- ✅ JPG to PDF (`jpg-to-pdf`) · ✅ PNG to PDF (`png-to-pdf`) · ✅ WEBP to PDF (`webp-to-pdf`)

### 📤 Convert from PDF (3/13)
- ✅ PDF to JPG (`pdf-to-jpg`) · ✅ PDF to PNG (`pdf-to-png`) · ✅ PDF to Text (`pdf-to-txt`)

---

## ⏳ 69 PENDING TOOLS (Kaam baki hai)

### 🔜 Next Up — Priority Queue (Phase 2 tools, sabse pehle)
Ye PRD ke hisaab se agle banne hain (one per round):
1. **HEIC converters** — `heic-to-jpg`, `heic-to-png`, `heic-to-pdf` (license verify karna hai: heic2any/libheif-js)
2. **WEBP converters** — `webp-to-jpg`, `webp-to-png`
3. **OCR PDF** (`ocr-pdf`) — Tesseract WASM + Hindi traineddata
4. **Compress to target size** (`compress-pdf-to-size`) — under 100KB/200KB/1MB
5. **Pages per sheet / N-up** (`pages-per-sheet`) — 2,4,6,9,16 with live preview
6. **Halve PDF pages** (`halve-pdf-pages`) — book spreads left/right
7. **Overlay PDF** (`overlay-pdf`) — stamp one PDF over another
8. **Bookmark PDF** (`bookmark-pdf`) — outline tree
9. **Extract images** (`extract-images`) — embedded images PNG/JPG ZIP
10. **Copy from PDF** (`copy-from-pdf`) — text/Markdown/CSV
11. **Search in PDFs** (`search-pdf`) — query/regex across files
12. **Flatten PDF** (`flatten-pdf`) — forms/annotations into content
13. **Rasterize PDF** (`rasterize-pdf`) — pages to flat images (redact worker ka raster path reuse karo)
14. **Make PDF fillable** (`make-pdf-fillable`) — auto-detect fields ya manual add
15. **Change PDF page size** (`change-pdf-page-size`) — A3/A4/A5/Letter/custom mm
16. **Edit PDF** (`edit-pdf`) — Word-style editor (Phase 8 mein 6 sub-phases, bada hai!)
17. **Annotate PDF** (`annotate-pdf`) — highlights, notes, sticky
18. **Write PDF** (`write-pdf`) — word-processor style + Hindi fonts
19. **Create PDF** (`create-pdf`) — blank/templates (letter, notes, planner, invoice, resume)
20. **Text to PDF** (`txt-to-pdf`) + **Markdown to PDF** (`markdown-to-pdf`) + **SVG to PDF** + **TIFF to PDF**
21. **Generate QR code** (`generate-qr-code`) — URL/UPI/WiFi/vCard + colors + logo
22. **Assemble PDF** (`assemble-pdf`) — multi-document drag workspace, zipper merge
23. **Set viewer preferences** (`set-pdf-viewer-preferences`)
24. **Resize image to KB** (`resize-image-kb`) — exam/govt forms ke liye under 100/200KB
25. **Universal converters** — `convert-to-pdf`, `convert-from-pdf` (smart routing)

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
`compare-pdf` (side-by-side diff), `verify-pdf-signatures`, `validate-pdfa` (S)

### ⚙️ Optimize (baaki)
`web-optimize-pdf` (linearize), `repair-pdf` (rebuild xref)

---

## 🏗️ Foundation — Kya-Kya BAN CHUKA hai (Phases 0–2)

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
6. **Sab UI strings i18n se** (en + real Devanagari Hindi, short)
7. **A11y** — keyboard, aria, 44px targets, 360px mobile-first, prefers-reduced-motion
8. **No placeholder/TODO code** — har file complete runnable
9. **Security** — magic bytes validation, 50MB mobile/200MB desktop, kabhi file names log mat karo
10. Sandbox: sirf `/` visible, API routes use karo (server actions NAHI), `bun run build` KABHI NAHI, har kaam ke baad dev.log check + agent-browser QA

---

## 🔑 Technical Insights (reuse karo, dobara mat dhundo)

- **Devanagari in PDFs:** pdf-lib `save()` non-Latin pe WinAnsi Helvetica ke saath THROW karta hai — pre-render with embedded fontkit subset ya NeedAppearances fallback (pattern: `tools/fill-out-pdf/worker.ts`)
- **Agent-browser upload flaky:** CDP setFileInputFiles wale Files DropZone clear hone ke baad UNREADABLE ho jate hain — recipe: public/ se fetch karke synthetic `DragEvent('drop')` + DataTransfer bhejo
- **agent-browser click flaky** re-rendered React buttons pe — `eval .click()` + delayed reads use karo; toasts ke liye MutationObserver lagao
- **Remount-detection-kicker:** effects jo `[files.length]` pe keyed hain mount pe fire hote hain
- **Cancel path:** worker pool instant terminate + OPFS cleanup — 600 DPI 400-page run pe 6% pe catch verified

---

## 📝 Session Log (naya kaam yahan append karo)

### P3.17 (latest) — Scan to PDF ✅
- Camera + live edge-detection overlay + torch, Otsu quad detection, homography perspective warp, Magic/B&W/Grayscale live preview filters, multi-page sessions, corner editor (pointer+keyboard), A4/Letter/fit output
- Smoke 54/54, EN+HI 1073=1073 keys, QA screenshots saved

### Pehle ke rounds (short)
- P3.16: rasterize-pdf, web-optimize-pdf
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
