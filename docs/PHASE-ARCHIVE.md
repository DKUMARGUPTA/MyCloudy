# DocoPDF — Phase Archive (P0–P8 COMPLETE RECORD)
> **Ye file PERMANENT hai — kabhi delete/edit mat karna.** 
> Isme P0 se P8 tak ka poora history + 66 live tools ka final locked record hai.
> Naya kaam yahan NAHI — naya kaam `worklog.md` (P9+) mein.
> Created: 20 Oct 2026, after R1-RESUME (66th tool) — user's "save completed tools" directive.
> History after this point → worklog.md only.

---

## 📜 PHASE TIMELINE (kya kab hua)

| Phase | Kya bana | Result |
|---|---|---|
| P0 (Phase 0) | Foundation: Next.js 16 app, design system (shadcn, emerald accent), hash router, i18n EN+HI, cookie consent, header/footer, landing page | Site skeleton live |
| P1 (MVP Tools) | Core 12 tools: merge, split, rotate, rearrange, remove/extract pages, compress, edit, sign, convert basics | ~12 tools live |
| P2 (Popular Tools) | QR generator, image converters, view-pdf, search, lock/unlock, flatten, doc-info | → ~30 tools |
| P3 (Create Suite) | Scan, images-to-pdf, collage, card, invoice (user's own app), fillable-form, resume + OCR + more | → 66 tools (resume = 66th, R1) |
| P4 (Power Features) | Assemble multi-doc, N-up, halve, copy-from-pdf (OCR), pdf-to-images family, rasterize, compress-to-size ladder, redact, compare, resize-kb | Categories complete |
| P6-STATIC | About/Contact/Privacy/Terms pages (#/page/*), footer 4-columns, /api/contact | Static pages live |
| P7-PWA | manifest, service worker, offline shell, install button, update toast | Installable offline app |
| P8 (Editor) | edit-pdf FLAGSHIP: v1 editor, existing-text edit, find&replace, annotate (real PDF annotations), form fields, write-pdf word processor | Editor complete (6/6) |

**Full P1–P8 ka asli session-by-session record → `docs/WORKLOG-ARCHIVE.md` (poora purana worklog).**

---

## ✅ 66 LIVE TOOLS — FINAL LOCKED STATE (sab smoke-tested + E2E QA-passed)

### 🗂️ Organize (12/12) — CATEGORY COMPLETE
merge-pdf, split-pdf, rotate-pdf-pages, rearrange-pdf-pages, remove-pdf-pages, extract-pdf-pages, assemble-pdf, pages-per-sheet, halve-pdf-pages, bookmark-pdf, extract-images, copy-from-pdf

### ✏️ Edit (11/11) — CATEGORY COMPLETE
edit-pdf (FLAGSHIP: text/images/shapes/draw/whiteout/signature/existing-text-edit/find-replace/form-fields), annotate-pdf (real /Highlight /Underline /StrikeOut /Text), fill-out-pdf, make-pdf-fillable, add-watermark, add-page-numbers, add-header-footer, overlay-pdf, crop-pdf, change-pdf-page-size, change-pdf-doc-info

### 📄 Convert to PDF (9/12)
txt-to-pdf, markdown-to-pdf, jpg-to-pdf, png-to-pdf, webp-to-pdf, heic-to-pdf, svg-to-pdf, tiff-to-pdf, convert-to-pdf
⏳ Pending: word-to-pdf, excel-to-pdf, powerpoint-to-pdf (LibreOffice server chahiye)

### ↔️ Convert from PDF (4/13)
pdf-to-jpg, pdf-to-png, pdf-to-txt, convert-from-pdf
⏳ Pending: pdf-to-word/excel/html/markdown/odt/powerpoint/svg/tiff/webp (server)

### 📷 Create (9/10)
create-pdf, write-pdf (word-processor), scan-pdf, images-to-pdf, create-photo-collage, create-card, create-fillable-pdf-form, create-resume, generate-qr-code
⏳ Pending: webpage-to-pdf (server-side rendering chahiye)

### 🖼️ Image (5/6)
heic-to-jpg, heic-to-png, webp-to-jpg, webp-to-png, resize-image-kb
⏳ Pending: passport-photo (NEXT IN QUEUE)

### 🔒 Security (6/9)
lock-pdf (AES-256 qpdf WASM), unlock-pdf, sign-pdf, redact-pdf, remove-pdf-metadata, generate-password
⏳ Pending: digital-signature, request-signature, verify-pdf-signatures (PAdES)

### ⚡ Optimize (5/8)
compress-pdf, compress-pdf-to-size, ocr-pdf (Tesseract 7 LSTM eng+hin), rasterize-pdf, flatten-pdf
⏳ Pending: pdf-to-pdfa, repair-pdf, web-optimize-pdf

### 👁️ View (4/6)
view-pdf, compare-pdf, search-pdf, set-pdf-viewer-preferences
⏳ Pending: validate-pdfa, verify-pdf-signatures

### 🧾 Invoices (1/7)
create-invoice (user's own app — 39 GST templates, paise-exact engine)
⏳ Pending: create-invoice-visually, create-electronic-invoice, pdf-to-e-invoice, validate-e-invoice, xml-invoice-to-pdf (+0 more)

---

## 🔑 GOLDEN TECHNICAL INSIGHTS (ye archive bhi rakhta hai — CONTEXT-MEMORY slim ho gaya)

Ye sab REAL bugs se seekhe gaye hain (puri detail ke saath WORKLOG-ARCHIVE.md mein):

1. **pdf-lib embeds ASYNC hain** — embedPng/embedJpg AWAIT karo, warna NaN matrix → image silently drop (INVOICE-LOGO-FIX).
2. **CANVAS-COMMIT RACE** — pdf.js render ke turant baad convertToBlob() blank de sakta hai; committedPngBlob() size-stability loop use karo (ocr-pdf pattern).
3. **Worker mein pdf.js** — hamesha `loadPdfjsInWorker` + `workerDocumentShim()` + ownerDocument param (pdfjs-common/worker-lib) — image-PDFs warna blank.
4. **pdf-lib drawImage w/h NAHI** — width/height explicitly likho, spread mat karo (imagegrid bug).
5. **Hindi PDF text-layer** — pdf-lib drawText matras reorders; Tesseract ka GlyphLessFont renderer use karo searchable Hindi ke liye.
6. **Devanagari font** — self-hosted Noto Sans Devanagari ek font = Latin+HI+₹ sab (stamp-common loadStampFonts pattern).
7. **Compressed object streams** — raw byte search JHOOTH bolti hai; parse-level asserts (reload → getForm/getPage).
8. **MODEL KIND COLLISIONS** — "text" jaisa string do kinds mein ho to structural discriminator (`"name" in el`).
9. **pdf.js v4 API** — convertToViewportPoint ARRAY return karta hai; viewport.transform matrix khud apply karo.
10. **useSyncExternalStore** — getSnapshot cached reference return kare, warna infinite-loop crash.
11. **agent-browser QA** — same URL open = no reload; Hindi dropzone label 'फ़ाइलें यहाँ'; Radix menus focus+Enter; eval .click() fallback.
12. **SVG workers mein impossible** — main-thread raster + collectAssets bridge (add-watermark pattern).
13. **Mobile grid overflow** — har grid item ko min-w-0 (P3-FORM create-invoice dono mein laga tha).
14. **Hindi nukta (फ़)** — agent-browser exact-match choke hota hai; eval innerText use karo.
15. **Session summaries CORRUPT ho sakti hain** — disk + git hi truth hai (P7-PWA + AUDIT-75-CLAIM lessons).

---


## 📂 ARCHIVE FILE MAP

| File | Size | Content |
|---|---|---|
| `docs/PHASE-ARCHIVE.md` | (ye file) | Phase timeline + 66 tools locked state + golden insights |
| `docs/WORKLOG-ARCHIVE.md` | ~345KB | POORA purana worklog (P0–P8, R1, AUDIT tak — har session ka detail) |
| `docs/CONTEXT-ARCHIVE.md` | ~90KB | PURANI detailed context-memory (66 tools ka full detail har tool ke saath) |
| `upload/DocoPDF-PRD-v2.md` + `.docx` | 128KB+57KB | Product PRD v2 (kabhi delete nahi hui, git-tracked) |
| `worklog.md` | (new slim) | Ab sirf naya kaam P9+ (rolling) |
| `CONTEXT-MEMORY.md` | (new compact) | Current state + P9 plan (har session pehle ye padho) |

**RULES:**
1. Ye files (docs/ARCHIVE*) READ-ONLY hain — history, kabhi edit nahi.
2. Har 3-4 phase baad worklog.md phir se archive karo (WORKLOG-ARCHIVE-P2.md banao).
3. CONTEXT-MEMORY hamesha <30KB rakhna — warna sessions phir corrupt hongi.


<!-- ================= P9 FINISH LINE (Jul–Oct 2026) — full worklog appended below ================= -->

# DocoPDF — Worklog (P9+ rolling log)

> **Ye file SIRF naya kaam (P9 phase se aage) rakhti hai — chhoti rakhna (<15KB).**
> Purana poora history: `docs/WORKLOG-ARCHIVE.md` (345KB, P0–P8+R1 sab kuch).
> Phase timeline + 66 locked tools + golden insights: `docs/PHASE-ARCHIVE.md`.
> Har 3-4 phase baad isse phir archive karke slim karna.
> **Naya agent? Pehle `CONTEXT-MEMORY.md` padho, phir ye file.**

---

## 📌 CURRENT STATE (20 Oct 2026, post R1-RESUME + AUDIT-75-CLAIM)

- **66 live / 31 pending / 97 total** (git + registry + live UI — teeno se verified)
- **i18n 2823 = 2823** | lint 0/0 | tsc 0 | dev server :3000 OK | PWA offline-capable
- Cron 468834 (15-min webDevReview) active
- User ne "75 tools ready" claim kiya tha — AUDIT-75-CLAIM ne 7 evidence layers se prove kiya: kal 65 the, aaj 66. Koi tool lost/delete nahi hua.
- User concern "files delete ho rahi hain" → verify kiya: PRD/worklog/memory SAB SAFE (git-tracked). Asli problem: worklog 345KB = session context overflow. Isliye ye restructure hua (archives created).

## 🚀 NEW PHASE: **P9 — FINISH LINE** (31 pending tools, 5 tracks)

| Track | Tools | Kaise |
|---|---|---|
| **P9-A DEVICE** (pehle karo) | passport-photo, (webpage-to-pdf*) | 100% client-side — India photo sizes (35×45mm passport, 20×25 stamp, 51×51 visa, US 2×2 etc), sheet layouts, print-ready PDF. *webpage-to-pdf CORS-limited, honest scope |
| **P9-B SERVER-CORE** | word/excel/powerpoint/odt/rtf/epub/publisher→pdf (7) + pdf→word/excel/html/markdown/odt/ppt/svg/tiff/webp (9) = 16 tools | **LibreOffice mini-service** (mini-services/ folder, bun + soffice headless) — Mode S tools, UI mein "Server" label + pricing honest |
| **P9-C OPTIMIZE-TRUST** | pdf-to-pdfa, validate-pdfa, repair-pdf, web-optimize-pdf | qpdf WASM (lock-pdf pattern reuse) — 100% device possible |
| **P9-D INVOICE-SUITE** | create-invoice-visually, create-electronic-invoice, pdf-to-e-invoice, validate-e-invoice, xml-invoice-to-pdf (5) | create-invoice engine reuse + e-invoice schemas (IRP/IRN) |
| **P9-E SIGNATURES** | digital-signature, request-signature, verify-pdf-signatures | PAdES/CAdES — sabse hard, last mein |

**Priority order: P9-A → P9-C → P9-B → P9-D → P9-E** (device pehle, server baad mein — infra decision user ka)

---

## 📝 RECENT ENTRIES (purani entries → WORKLOG-ARCHIVE.md)

---
Task ID: R1-RESUME
Agent: full-stack-developer ×2 (files) + orchestrator (wiring, QA, docs)
Task: Build create-resume as the 66th DocoPDF tool (PRD: "Step-by-step form, 8 templates, live preview, PDF export; no signup; data local"). Trigger: user reported "resume maker was working yesterday, today it shows coming soon" — investigation proved the tool had NEVER been built (no files, no git history, registry placeholder only); it was next in queue anyway.

Work Log:
- Root-cause of the user report: `create-resume` had no implementation since launch — no surface, no worker, one git commit ever touched it (the initial 97-tool catalog). NOT a regression; the user likely saw create-card/create-invoice/create-fillable-pdf-form (the same-category template makers) working.
- Subagent 1 wrote: tools/create-resume/{model.ts (1876 lines: ResumeDoc full schema, sanitizeResume clamps, 8 templates in RESUME_TEMPLATES with accent/HeadingStyle/twoColumn, layoutResume measure-injected flow engine with orphan-heading protection + Name—PageN repeated headers + honest cut warnings, wrapText, dateRange/displayDate, sampleResume/emptyResume, serializeResume/parseResumeRun garbage-safe round-trip, outputFileName), render.ts (297: drawResumePdf vector painter — REAL selectable ATS text, AWAITED embedPng/Jpg for the optional photo with photoDropped fallback — the INVOICE-LOGO-FIX lesson), worker.ts (117: standard WorkerRunRequest, options.resume JSON, progress 20/45/85, result detail {pages, warnings}), config.ts (99: landingSurface+fullWidthSurface, 4 features + 4 FAQ honest), i18n.json (155+1 keys ×2)} + scripts/merge-resume-i18n.ts. Hit its context deadline before surface.tsx.
- Subagent 2 wrote: surface.tsx (2504 lines: 7-step wizard Personal→Summary→Experience→Education→Skills→Extras→Design, repeatable item editors with ▲▼/remove/bullets, 8 template CSS mini-mocks, A4/Letter radio, canvas-measured LIVE PREVIEW sharing layoutResume math, localStorage draft autosave (debounced, photo-stripped >500 KB) with restore/discard banner, ≤10 named saved copies, Load sample/Clear/Export PDF actions, mobile Edit|Preview tabs, full EN+हिंदी) + scripts/smoke-create-resume.ts (666 lines). Model got a small fix (+73 bytes) and i18n +156 keys en/hi. Hit context deadline before wiring/QA.
- ORCHESTRATOR: wiring (registry enabled:true → 66 live; configs.ts TOOL_CONFIGS entry; surfaces.tsx ResumeSurface map entry), full QA, docs.
- QA ALL GREEN: smoke 111/111 (template registry 8 unique ids/accents/exactly-one twocolumn; wrapText/dateRange/sanitize/parseResumeRun vectors incl. garbage JSON; layout fake-measure page caps; REAL PDF builds: sample EN + Hindi "प्रिया शर्मा" + all 8 templates + broken-photo → photoDropped warning not a crash + valid photo XObject + reload pageCount === report + Type0 Noto embedded); tsc 0 errors; lint 0/0; i18n 2823 = 2823 (2667 + 156); agent-browser E2E: tool opens with 7-step rail, Next/Export correctly disabled until name, Load sample fills Priya Sharma + preview updates, Two column template switch live, EXPORT → "resume.pdf — 1 page" toast + byte-verified %PDF-…%%EOF download (EN and HI runs), Hindi UI fully native ("रिज़्यूमे बनाएँ", "चरण 7 में से 7", "सिर्फ़ नाम ज़रूरी है"), tools page Create category shows the card with NO Soon badge, mobile 390px overflowX=0, agent-browser errors 0; VLM: split-screen wizard+preview clean, draft-restore banner working (cookie banner = designed first-visit UX). Screenshots: public/qa/resume-{en-builder,hi-builder,mobile}.png.
- Dev server died during the i18n rewrite mid-QA — daemon relaunched, HTTP 200 (recurring pattern, daemon handles it).

Stage Summary:
- 66th TOOL live: create-resume — 7-step bilingual resume maker, 8 visually distinct templates (classic/modern/minimal/professional/compact/elegant/twocolumn/creative, no blue/indigo accents), A4+Letter, optional square photo (client-downscaled), live preview sharing the exact PDF layout math, honest overflow warnings at the page cap, ATS-real text, drafts + 10 saved copies, 100% on-device. PDF section labels localize with the UI (Hindi resume → "अनुभव" headings).
- Zero-mistake evidence: smoke 111/111 incl. reload-parity and embedded-font parse-level checks; live export byte-verified twice (EN+HI); VLM visual pass; mobile no-overflow.
- Honest limits: no true bold (Noto ships Regular only — size/colour contrast instead, FAQ-documented); preview is a CSS mirror of the layout math, not a raster of the PDF; photo embed is square (no circular clip in pdf-lib).
- Project state: 66 live / 97 total / 31 pending | i18n 2823 = 2823 | lint + tsc + smoke + dev.log clean. Next queue: passport-photo (India sizes, P3). Remaining backlog: ~20 Mode S tools (LibreOffice), 5 invoice tools, digital-signature/request-signature (PAdES), verify-pdf-signatures, web-optimize-pdf, repair-pdf.

---
Task ID: AUDIT-75-CLAIM
Agent: orchestrator (main session)
Task: Deep forensic audit — user claimed "75 tools were ready yesterday"; verify the true count and hunt for any unknown/lost ready tools.

Work Log:
- Evidence layer 1 (registry code): 66 `enabled: true` / 97 defs / 31 default-false pending.
- Evidence layer 2 (wiring): TOOL_CONFIGS has exactly 66 entries — 1:1 with enabled; TOOL_SURFACES 45 (PageGrid/ImageGrid families share surfaces).
- Evidence layer 3 (git history): Oct 19 commit 2cc5627 → 65 enabled; Oct 20 04:57 (0dc4864, P6-STATIC) → 65; Oct 20 06:56 (b389f29, R1-RESUME) → 66. The site NEVER had 75 ready tools — yesterday's truth was 65.
- Evidence layer 4 (lost-work hunt): `git fsck --lost-found` → 5 dangling commits, all Oct 7–18 QA-screenshot snapshots of the same lineage, no extra tools; no stash; single branch; `git status` clean except known working tree.
- Evidence layer 5 (hidden implementations): all 68 config.ts folders vs registry ids → "config.ts but NOT in registry: []" (nothing unregistered); no "gtools"/"pdftk" remnants anywhere.
- Evidence layer 6 (database): users/sessions/anon_usage/usage_events/tool_requests/audit_log all 0 rows — no trace of any other tool era.
- Evidence layer 7 (live UI, agent-browser): All Tools page → 97 phase chips, 31 "Soon" badges, 66 ready cards — matches registry exactly.
- Verified a mid-audit false alarm: my first regex over-matched across def blocks listing pending tools as enabled (pdf-to-word etc.) — re-parsed with proper def({ block splitting; final list below is confirmed.
- Correct final 66 by category: organize 12, edit 11, create 9, convert-to 9, security 6, images 5, optimize 5, view 4, convert-from 4, invoices 1. Pending 31: 8 office-family (word/excel/ppt/odt/rtf/epub/publisher/html→PDF), 9 pdf→office/web family, 6 invoice-suite, 3 optimize (pdfa/repair/web-optimize), 3 signature/verify, passport-photo, webpage-to-pdf, validate-pdfa.

Stage Summary:
- VERDICT: the claim "75 ready yesterday" is not supported by ANY layer. Truth: 65 ready yesterday → 66 today (create-resume). The corrupted first-session summary that claimed 67–68 live (gtools7/pdftk) also had nothing on disk — same conclusion as P7-PWA's STATE TRUTH CHECK. User likely misremembered the About page's "65 of 97" (65↔75) or counted some "Soon" cards.
- No unknown ready tools exist outside the registry; no lost work to restore.
- Project state: 66 live / 97 total / 31 pending | i18n 2823 = 2823 | lint + tsc clean. Next queue: passport-photo (P3). Cron 468834 (15-min webDevReview) active.

---
Task ID: P9A-PASSPORT
Agent: full-stack-developer (files, context-deadline ×1) + orchestrator (smoke script, ref-rule fixes, wiring, QA)
Task: Build passport-photo as the 67th live tool (P9-A device track) + fix subagent's lint violations.

Work Log:
- Subagent wrote 6 files before deadline: model.ts 728 (12 sizes with head/eye guides, crop math, sheet layouts, sanitize), render.ts 325 (drawPhotoCard/drawSheetPdfDoc/drawSheetPreview/bgReport), worker.ts 259, surface.tsx 1357, config.ts 99, i18n.json 190 + merge script. i18n merged by me: 2913=2913.
- Orchestrator wrote scripts/smoke-passport-photo.ts (83 checks: mm math, A4 35×45→5×6=30 grid exact, 4×6→6, stamp→90, pagination, cut segments, crop cover-fit/zoom/pan/quarter turns exact vectors, pt/px, recipe sanitizer clamps, REAL pdf-lib builds w/ sharp JPEG — 8 copies 1 page, 65→3 pages, 4×6, XObject resource entries share ONE image object, bgReport fake-ctx).
- Fixed subagent violations: PhotoPlus→ImagePlus (no such export), progress detail {files}→StageDetail, RunDetail extended with copies/sheets/bg/bgMinLuma, 3× react-hooks/refs (render-time ref writes→latest-value-ref effects; photoUrl ref-cache→derived photoUrls useMemo+revoke cleanup), set-state-in-effect (sheet-page reset→derived clamp).
- E2E (agent-browser): tool live, upload via input.files+change (pinned recipe; DropZone synthetic-drop FAILED), photo chip select gates CTA, PDF sheet export → passport-photos-sheet-35x45mm.pdf byte-verified, mobile overflowX=0, Hindi UI. Screenshots: public/qa/passport-{mobile,hi}.png.

Stage Summary:
- 67th tool live. KEY QA LESSONS: (1) PDF-sheet button = format toggle, real CTA = "Export PDF sheet"; (2) upload needs input.files+dispatchEvent (synthetic drop flaky per pinned insight); (3) turbopack watcher SLEEPS — after registry wiring, dev-server RESTART (pkill next + daemon) is the reliable trigger; browser also caches — fresh query param + SW unregister.

---
Task ID: P9BC-SERVER-CONVERT
Agent: orchestrator (main session)
Task: Build the convert mini-service (LibreOffice 25.2 + Ghostscript 10.5 + poppler + headless Chrome) and wire 14 Mode S office/PDF tools live (68th-81st).

Work Log:
- ENV AUDIT: soffice/gs/qpdf CLI/pdftoppm/pdftocairo/pdftotext/pandoc/puppeteer-chrome (chrome + chrome-headless-shell paths under ~/.cache/puppeteer/chrome*/linux-155.0.8059.39) all available; internet OK.
- mini-services/convert/ (bun --hot, port 3031): POST /convert multipart — actions: office2pdf (soffice, isolated -env:UserInstallation profiles, queue-of-1), pdf2office (writer/impress imports via --infilter; xlsx = pdftotext -layout → CSV → Calc because calc_pdf_import broken in LO 25.2 "no export filter"), pdf2svg (pdftocairo -svg page 1), pdf2pdfa (gs -dPDFA=2 -sColorConversionStrategy=RGB — UseDeviceIndependentColor REFUSES: "reverting to normal output"; OutputIntent optional at 2B; pdfaid XMP verified part='2' conformance='B'), webpage2pdf (chrome-headless-shell --print-to-pdf), html2pdf (chrome). 30MB cap, action whitelist, http/https URL allow-list, execFile-style argv (no shell), job-scoped temp dirs, per-action timeouts, CORS open, /health.
- BUGS FIXED: (1) pickOutput→readFile ENOENT race — soffice rename lands late on /tmp → 4×150ms retry in fileResponse; (2) pdf2office silently re-emitted input PDF — fixed via --infilter; (3) gs PDF/A flags corrected.
- tools/server-convert/worker.ts — shared proxy: toolId→action map, FormData via fetch, progress 15/→/90, service error JSON→ToolRunError mapping, X-Convert-Name passthrough.
- 14 tools (word/excel/powerpoint/odt/rtf/epub/publisher→pdf, html-to-pdf, pdf→word/excel/powerpoint/odt/svg/pdfa): generated configs via scripts/gen-p9-configs.py (bilingual features+FAQ with honest Server privacy notes; pdfaLevel select; landscape switch), per-tool 1-line worker re-export (tools/<id>/worker.ts), i18n how1-3 ×14 namespaces → 2955=2955 parity.
- Registry: 14× enabled:true (81 live / 16 pending). configs.ts: 81 entries. outputKind union extended: docx|xlsx|pptx|odt.
- E2E THROUGH CADDY (:81 — the real user path; port-3000 direct fetch 404s because /convert exists only on the gateway): word-to-pdf → "Your file is ready!" + in.pdf download %PDF-verified; pdf-to-pdfa → 8.7KB PDF/A; pdf-to-excel → table.xlsx 5.4KB. Service curl-tested for ALL 10 actions (docx→pdf, pdf→docx/xlsx/pptx/odt, svg, pdfa, webpage example.com, html, rtf; bad-url 400).
- CRITICAL LESSONS (pinned): (1) worker fetch CANNOT use relative URLs — "Failed to parse URL from /convert?XTransformPort=3031" — absolutize via new URL(path, self.location.origin); (2) cross-folder new URL("../server-convert/worker.ts") gets a broken turbopack HMR wrapper (document is not defined) — per-tool sibling worker.ts with side-effect import is the fix; (3) turbopack persistent cache serves STALE worker chunks even after restart — rm -rf .next was needed; (4) gateway-only routes mean E2E must run via :81.
- Output filename fix: service keeps sanitized ORIGINAL basename (in.pdf→my-report.pdf); pdf2pdfa still yields out.pdf (action-local name, minor).

Stage Summary:
- 81 live / 97 total / 16 pending. i18n 2955=2955. lint 0/0, tsc 0. Convert service + dev server both healthy. PWA still working (chunks changed — SW version bump advised at deploy).
- NEXT QUEUE (16): webpage-to-pdf (URL surface), repair-pdf + web-optimize-pdf (qpdf WASM client), pdf-to-webp/tiff (rasterize reuse + TIFF encoder), pdf-to-html + pdf-to-markdown (text extraction), validate-pdfa (client structural checker), e-invoice trio (S), signature trio (digital D + request S + verify D), create-invoice-visually (D).

---
Task ID: P9C-REPAIR-OPTIMIZE
Agent: orchestrator (main session)
Task: Build repair-pdf (#82) + web-optimize-pdf (#83) via self-hosted qpdf WASM (public/vendor/qpdf-wasm was bundled but NEVER used until now).

Work Log:
- tools/qpdf-common/qpdf-wasm.ts (131 lines) — Emscripten loader: new Function-eval of vendor qpdf.js with `var process;` mask (Bun/worker new-Function scope has no require/__dirname), locateFile → absolute wasm URL (worker: origin-absolutized; node smoke: dev server URL), FS writeFile/readFile/unlink + callMain. PINNED LESSONS: (1) this build has NO wasmBinary option — locateFile fetch is the only path; (2) callMain takes USER args only — a program-name argv[0] makes qpdf print usage; (3) this FS build lacks analyzePath — try/catch readFile instead; (4) node-vs-browser path: /vendor (URL) ≠ ./public/vendor (disk).
- tools/repair-pdf/worker.ts — TWO honest layers: (1) pdf-lib tolerant rebuild (load {ignoreEncryption, throwOnInvalidObject:false} + fresh doc + copyPages — fixes broken xref/startxref, PROVEN on corrupted test: digits-9 xref entries + 999999 startxref both recoverable by pdf-lib, qpdf strict fails those), (2) qpdf --object-streams=disable --compress-streams=y pass. Neither opens → honest error. detail {files, pages, layer}.
- tools/web-optimize-pdf/worker.ts — qpdf --linearize (+ optional --compress-streams=y), detail {files, linearized}.
- i18n repair.* + webopt.* how-keys ×3 each → parity 2961 = 2961. RunDetail += linearized. Registry enabled ×2 (83 live), configs wired ×2.
- E2E VIA CADDY (:81): repair-pdf with real damaged.pdf (startxref corrupted) → "damaged-repaired.pdf" ready + download %PDF-verified; web-optimize-pdf → site-web.pdf downloaded with /Linearized marker:1 + valid PDF. tsc 0, lint 0/0.
- Session-wide pinned lessons (added to memory): turbopack watcher SLEEPS between edits — after ANY registry/config wiring, dev-server restart (pkill next + daemon relaunch) + browser reload are REQUIRED for E2E.

Stage Summary:
- 83 live / 97 total / 14 pending. i18n 2961=2961. lint+tsc clean. Convert service healthy (:3031) + dev server (:3000) + Caddy (:81) all up.
- NEXT QUEUE (14): pdf-to-webp + pdf-to-tiff (rasterize/imgconv reuse + TIFF encoder), pdf-to-html + pdf-to-markdown (text extraction reuse), validate-pdfa (client structural checker), webpage-to-pdf (URL surface via service), e-invoice trio (S), signature trio (digital D, verify D, request S), create-invoice-visually (D).

---
Task ID: P9-F2-CONVERT-VALIDATE
Agent: orchestrator (main session)
Task: Batches 1-4 of the P9 finish line — 6 more tools live: pdf-to-webp (#84), pdf-to-tiff (#85), pdf-to-html (#86), pdf-to-markdown (#87), validate-pdfa (#88), webpage-to-pdf (#89).

Work Log:
- pdf-to-webp: shared pdf-to-images worker + new webp FORMAT entry. BUG FIXED en route: `quality: format.alpha ? undefined` was silently dropping quality for webp (alpha AND lossy coexist in webp) — replaced with explicit `lossy` flag on the FORMAT map. Honest browser guard: blob.type !== image/webp → loud error instead of a mislabeled PNG.
- pdf-to-tiff: NEW baseline TIFF encoder tools/pdf-to-tiff/tiff.ts (little-endian, 13-entry IFDs chained via next-IFD = REAL multi-page TIFF, uncompressed RGB, RGBA composited onto white, XRes/YRes rationals, 4-byte pixel padding). BUG FIXED: first draft wrote 13 entries with ENTRY_COUNT=12 — the 13th (ResolutionUnit) overflowed into the external-value block, corrupting BitsPerSample (caught by the smoke's reader-style parser). Memory guard: 600MB RGB budget, upfront viewport math, honest refuse message.
- pdf-to-html + pdf-to-markdown: NEW shared outline engine tools/pdf-to-htmlmd/outline.ts on top of pdf-to-txt's text-layout (median body size, heading buckets, bullet/roman/ordered list splitting, paragraph flow + dehyphenation, escapeHtml, escapeMarkdownLead, detectHindi, renderHtml/renderMarkdown). Retuned heading ratios to real Office defaults after E2E exposed h1-swallowing: h1 ≥ 2.0, h2 ≥ 1.42, h3 ≥ 1.15 (+1e-9 float epsilon). Panels reuse PdfToImagesPanel (webp/tiff pixel preview) + PdfToTxtPanel (html/md selectable-text preview).
- validate-pdfa: flipped registry Mode S → D (fully on-device). checks.ts: 7 checks (XMP packet, pdfaid marker with attribute+element forms, version vs part, encryption, output intent, embedded fonts, page tree) + ObjStm info note; honest 3-state statuses; .txt report with Hindi verdict section; RunDetail extended pdfa/failed/warnings + 3 new result chips.
- webpage-to-pdf: noFile surface (URL input + domain-named download + Server privacy note); non-http scheme rejection fixed en route (ftp: was being mangled into a hostname); service webpage2pdf action reused as-is.
- Wiring: registry enabled ×6 + honest description rewrite for pdf-to-html; configs ×6; panels ×4 (webp/tiff/html/md); surfaces ×1 (webpage). i18n: merge-p9-d2-i18n.py + merge-p9-d4-i18n.py → 2993 = 2993 (+32).
- QA: smoke-p9-d2.ts 71/71 (TIFF parse-back, outline vectors, renders) + smoke-p9-d4.ts 41/41 (validate-pdfa checks + web2pdf URL helpers); tsc 0; lint 0/0.
- E2E (agent-browser, THROUGH GATEWAY for web2pdf): webp → 2 pages RIFF/WEBP magic-verified; tiff → single 52MB multi-page II* file, IFD chain parsed in python (13 entries, terminates, W×H 2479×3508@300dpi); html → h1:1/h2:3/h3:2/li:9/sections:2 with title extracted from the first heading; markdown → perfect structure (#, ##, ###, bullets, renumbered 1./2./3., --- page break); validate-pdfa → "PDF/A-2B — browser-visible checks all passed" chip + full report + negative case "No PDF/A marker found"; webpage-to-pdf → example.com printed 34KB valid PDF (EN + हिंदी run both toast-verified). Mobile 390px overflowX=0 on 4 sampled tools; 0 browser errors; dev.log clean.
- PINNED LESSON (browser cache): after a worker-logic edit + dev restart, a fresh page load can STILL run the stale worker chunk from the browser's HTTP cache — close the browser entirely (fresh context) or hard-bust; cost us one confusing E2E round.

Stage Summary:
- 89 live / 97 total / 8 pending (5 invoice + 3 signature). i18n 2993=2993. lint + tsc + smoke clean.
- Fixtures added: public/qa/qa-structure-fixture.pdf (2-page heading/list doc) + qa-pdfa-sample.pdf.
- NEXT: Batch 5 invoice suite (create-invoice-visually, create-electronic-invoice, pdf-to-e-invoice, xml-invoice-to-pdf, validate-e-invoice — engine reuse from create-invoice), then Batch 6 signature trio.

---
Task ID: P9-F5B-EINVOICE
Agent: full-stack-developer (files only — no wiring; orchestrator next)
Task: Build create-electronic-invoice (91st) + pdf-to-e-invoice (92nd) + shared EInvoiceForm

Work Log:
- getPdfAllPagesText(file, maxPages=10) added to src/lib/pdf/thumbnails.ts (+42) — reads ALL pages with the exact getPdfPageTextPreview per-page recipe (str+hasEOL join, cleanup, page.cleanup), cached openDocument, "" per text-less page (surface turns all-empty into the honest scanned→OCR note).
- tools/einvoice-common/payload.ts (201, NEW pure module): EINV_MAX_ITEMS 25, profiles facturx/xrechnung + normalizeProfile, gstStateOf (GSTIN prefix → state code), emptyEInvoiceForm (today/+15/GST18/1 row), sampleEInvoiceState, buildInvOption/parseInvOption ({s} JSON ↔ parseInvoiceRun), mergeExtracted (prefill merge gated on actual extraction NOTES — heuristic defaults like tr="0" never count as findings), serializeDraft/parseDraft (tamper-safe). Everything bun-testable, no DOM.
- tools/einvoice-common/eiform.tsx (634): shared EInvoiceForm({state,setState,notes}) — biz/cli/invoice/items/adjustments sections, live summary strip via calc() (sub/tax/tot + disc/adv/bal), amber gstOK() checksum hint, GSTIN inputs uppercase/despace/15-cap deriving biz.state + cli.state+pos silently (correct CGST+SGST vs IGST split), item rows add/remove cap 25 with last-row clear, mobile one-field-per-row + min-w-0, all labels t("einv.*"). Event handlers only.
- tools/create-electronic-invoice/{worker.ts (6-line sibling re-export of einvoice-common/worker), config.ts (81: pdf, 1 file, howKeys einv.*, chains view-pdf+validate-e-invoice, options: [], 5+3 honest bilingual copy), surface.tsx (289: ElectronicInvoiceSurface — PDF status card w/ kept-as-is hint, profile select, form, run-summary card; options "inv" (debounced 250ms) + "profile" (event-context); setRunBlocked(files 0 || !biz.name → einv.needFile) via effect; draft dp_einv + restore banner on fresh visits only; Load sample)}.
- tools/pdf-to-e-invoice/{worker.ts (6), config.ts (80: howKeys p2e.*, chains create-electronic-invoice+validate-e-invoice), surface.tsx (479: PdfToEInvoiceSurface — extraction step: file DERIVED from props, effect→async promise (microtask-first, the search-pdf rule), getPdfAllPagesText→extractInvoiceFields→prefill merge + localized "Found on the PDF" chips + honest Nothing-recognised/scanned/error states + Re-read button; prefill-clobber guard = module WeakSet (once per File, remounts keep edits, new PDF still prefills); rest identical to tool 1, draft dp_p2e)}.
- i18n: tools/create-electronic-invoice/i18n.json (en+hi, einv 61 keys + p2e 13 keys, identical sets) + scripts/merge-einvoice-i18n.ts (117: both sections, parity, clobber refusal, required-key + source-literal cross-checks). Merged: 2993 → **3067 = 3067**.
- QA: scripts/smoke-p9-f5b.ts (211 lines) → **40/40** (payload round-trips incl. worker parseInvoiceRun path, garbage/null/typed payload safety, 2-page fake invoice (einvoice-common smoke text split) → merge vectors incl. state/pos derivation + parked total row + 9+9→18 hint + manual-field preservation + no-hint tr retention + scanned empty, profile values + both CII guidelines, draft round-trip + tamper vectors, cap 25). tsc 0, lint 0/0 (one react-hooks/set-state-in-effect fixed en route: !file reset behind microtask helper). dev.log clean (expected fast-reload after i18n rewrite).

Stage Summary:
- Both tool files COMPLETE, unwired by design (registry/configs/surfaces untouched — orchestrator wires 91+92). Surfaces to register: ElectronicInvoiceSurface + PdfToEInvoiceSurface; option keys exactly "inv" + "profile". Shared worker returns 2 outputs/run (e-invoice PDF + factur-x.xml), detail {files:2, pages, annotations}.
- NOTE for wiring: registry says mode "S" for both — the tools are 100% on-device (client worker); flip to "D" like validate-pdfa was. Browser E2E (pdf.js read + chips + 2-file run) still needed. Work records: agent-ctx/P9-F5B1 + P9-F5B2.
- Project state: i18n 3067=3067 | tsc 0 | lint 0/0 | smoke 40/40. Remaining P9: create-invoice-visually, xml-invoice-to-pdf, validate-e-invoice (files for validate already exist in einvoice-common), signature trio.

---
Task ID: P9-F6A-CRYPTO
Agent: orchestrator (main session)
Task: Build tools/pki-common — the pure-TS crypto core for the signature trio (#95-97): ASN.1 DER, PKCS#12, X.509, CMS SignedData, PAdES PDF signing + verification.

Work Log:
- tools/pki-common/asn1.ts (~400): DER TLV parser (multi-byte lengths, strict/lenient) + encoder (tlv/derSeq/derSet/derInt/derIntBytes/derOid/derUtf8/derUtctime), readers (OID/INT/bigint/octets/bitstring/times incl. BMPString), WebCrypto sha() helper, ECDSA raw↔DER converters. ES2017-safe (no bigint literals — BigInt(0)/BigInt(8) calls, tsconfig target is ES2017).
- tools/pki-common/p12.ts: PKCS#12 reader. PBES2/PBKDF2 (HMAC-SHA1..512) + AES-128/192/256-CBC via WebCrypto; legacy 3DES/RC2 refused honestly. **PINNED GOTCHA #1: OpenSSL 3.x feeds PBES2 the RAW UTF-8 password while Windows/CryptoAPI keeps the RFC BMPString (UTF-16BE+NUL) form — BOTH are tried, the one decrypting to plausible DER (first byte 0x30) wins.** Proven by cross-testing (openssl CLI + python-cryptography + manual openssl enc decrypt).
- tools/pki-common/x509.ts: cert parse (DNs, serial, validity, SPKI, keyUsage/EKU/basicConstraints, SKI/AKI presence, issuerDer for CMS sid) + chain linkage verifyCertIssuedBy (RSA PKCS1v1.5 SHA-256/384/512 + ECDSA P-256/384 via WebCrypto, DER sigs converted) + isSelfSigned.
- tools/pki-common/cms.ts: detached SignedData builder (adbe.pkcs7.detached: contentType+messageDigest+signingTime+signingCertificateV2 ESSCertIDv2 attrs, RSA + ECDSA) + parser (SignerInfo state machine: version→sid→digestAlgo→[0]attrs→sigAlgo→sig; certs [0] walk). **PINNED GOTCHA #2: signedAttrs signature covers the SET-OF (0x31) form while embedded as [0] (0xA0) — re-tag by flipping the first byte (length encodings identical). Attr order must be DER-sorted: contentType(9.3) < messageDigest(9.4) < signingTime(9.5) < signingCertV2(9.16.2.47).**
- tools/pki-common/pdfsign.ts: signPdf — pdf-lib load (+ optional visible stamp via stamp-common loadStampFonts, browser Devanagari / bun Helvetica fallback), Sig field with 8192-byte hex placeholder (marker d0d0c0ffee) + four 10-digit ByteRange markers, save {useObjectStreams:false}, byte surgery. **PINNED GOTCHA #3: rewrite the ByteRange markers BEFORE hashing — they sit inside the covered region (hashing first covers the placeholder digits = invalid signature).** **PINNED GOTCHA #4: zero-pad the /Contents hex with ASCII '0' (0x30), NOT NUL bytes.** **PINNED GOTCHA #5: ByteRange 4th number = length of part 2, not the file end.**
- tools/pki-common/verify.ts: extractSignatureSlots (regex over latin-1 view: /Contents <hex> + nearest /ByteRange within 4000 chars — hex charset can never contain "/ByteRange"), **PINNED GOTCHA #6: /Contents is zero-padded past the CMS DER — trim to the first complete TLV (padding is 0x30 here, 0x00 in Acrobat files)**, then verifyPdfSignatures: messageDigest vs hash(covered), sig over re-tagged SET form, cert period at signing time, chain/self-signed linkage, honest unknown statuses (no CRL/OCSP/trust store — UI must say so).
- Fixtures: public/qa/pki/ — test CA (RSA-2048 self-signed), RSA leaf (CN=Asha Verma, emailProtection + Adobe trust EKU), ECDSA P-256 leaf (CN=Rahul Sharma), signer-rsa.p12 + signer-ec.p12 (PBES2/AES-256/hmacSHA256, pass test1234, chain included).
- scripts/smoke-p9-f6a.ts → **50/50**: p12 parse (wrong-password → bad-password), x509 fields + chain crypto, CMS build/parse round trip, **openssl mutual cross-validation** (openssl smime verifies OUR CMS; our parser+verify validates openssl's CMS), full PDF sign→verify round trips (RSA + ECDSA), **openssl verifies the CMS embedded in our signed PDF**, tamper detection (single flipped byte → invalid), unsigned detection.
- tsc 0, lint 0/0. Debug files cleaned up.

Stage Summary:
- Crypto core COMPLETE and independently cross-validated against OpenSSL 3.5.7. signPdf + verifyPdfSignatures are the engines for tools #95 (digital-signature) and #97 (verify-pdf-signatures).
- 94 live / 97 total / 3 pending (the signature trio itself). i18n 3187=3187.
- NEXT: tool UIs (workers/configs/surfaces/i18n for digital-signature + verify-pdf-signatures), request-signature mini-service :3032 + recipient flow, 3-way wiring, E2E, worklog + commit.

---
Task ID: P9-F6B-REQUEST
Agent: full-stack-developer (files only — orchestrator wires next)
Task: Build request-signature (#96) — the only Mode S signature tool: envelope mini-service :3032 + recipient hash-route view + requester surface (+ wiring-ready files, registry/configs/surfaces untouched).

Work Log:
- mini-services/request-sign/ (bun --hot, ZERO npm deps): POST /requests (25MB cap + %PDF magic BEFORE write, hours 24|48|168, from/message limits → signToken+viewToken, responds RELATIVE hash URLs #/sign/<t> + #/req/<t>), GET :token/meta (either token, never the tokens; derived "expired" status for unswept pending), GET :token/pdf (inline, sanitized RFC5987 name), POST :signToken/sign (30MB cap, 409 signed / 410 expired), GET :viewToken/result (attachment -signed.pdf), DELETE :viewToken (bytes wiped NOW, meta kept "cancelled" until sweep, idempotent). 60s expiry sweeper, data/ gitignored, running + /health 200.
- tools/request-signature/api.ts — all fetches relative + ?XTransformPort=3032 (gateway rule).
- Hash routes: use-hash-route.ts += "sign"/"req" views (+ROUTES), page.tsx renders RecipientSignView/RequestStatusView (relative imports — @/* is src-only).
- recipient-view.tsx (705): honest Mode S card (serverBadge + max-7-days note), file card + 1s countdown, existing SignatureDialog for creation, placement = page select (pdf.js count) + size slider 80-240pt + position select (br/bl/cb) + LIVE preview (renderPdfThumbnail + emerald dashed overlay in pdf-lib percent space), submit = dynamic import("pdf-lib"), AWAITED embedPng (logo lesson), border rect rgb(0.55,0.57,0.60) 0.75pt behind drawImage, one postSigned upload, local-blob download. States: loading/netError/ready/signing/done/already/gone(missing|expired|cancelled), microtask-first effects.
- surface.tsx (770): RequestSignatureSurface (noFile pattern — dashed drop zone + magic sniff, from/message, expiry select, CTA with honest inline reason + setRunBlocked rsign.needFile/needName) → two link cards (copy via clipboard+execCommand fallback, expiry, no-email + server notes) + StatusSection (10s poll, signed→download result, two-step cancel confirm) shared with RequestStatusView for #/req/<t>.
- i18n: 96 keys ×2 natural Devanagari; merge script (einvoice parity, clobber refusal, literal cross-check). Merged 3187 → 3334 = 3334 (+192 mine; sibling F6A merged dsig/vsig +56 concurrently).
- QA: service curl E2E all-correct (create→meta both tokens→pdf→sign→409 double→result→409-role-check→cancel idempotent→410 post-cancel→400/415 negatives→sweeper verified live ~16s); gateway :81 XTransformPort=3032 create/meta/health/delete OK; tsc 0; lint 0/0; dev.log clean.

Stage Summary:
- Tool files COMPLETE, unwired by design. Wiring needs: registry enabled (mode S, noFile), configs entry (howKeys belong to the orchestrator's config — not in rsign namespace), surfaces → RequestSignatureSurface. Service :3032 healthy and running; i18n rsign section merged.
- Draft note: "dp_rsign" stores from/message only (silent restore — these hash-route/surface views are client-side-only mounts, no SSR hydration concern).
- 94 live / 97 total / 3 pending wiring: digital-signature, verify-pdf-signatures, request-signature (all three now have files — F6A built the other two).

---
Task ID: P9-F6A-UI
Agent: full-stack-developer (files only — no wiring; orchestrator next)
Task: Build the tool UI layer for digital-signature (#95) + verify-pdf-signatures (#97) on the P9-F6A crypto core.

Work Log:
- tools/digital-signature/p12-store.ts (80) — logo-store pattern (subscribe/get/set/clear + change-notify): entry { file, cert: P12CertSummary { cn, org?, validTo, keyKind, serial } }. SECURITY: password NEVER enters the store (surface state only, rides the run as the transient "pw" option); collectAssets ships the container File as request.assets[0].
- tools/digital-signature/config.ts (81) — validate-e-invoice structure; options: [] (surface owns everything), howKeys dsig.how1-3, chains [verify-pdf-signatures, lock-pdf, view-pdf], 5 honest bilingual features (real PAdES; Hindi names on the stamp; 100% on-device key; RSA+ECDSA P-256/384; honest limits: no TSA, no smartcards) + 3 bilingual FAQ (where to get a .p12; what Adobe shows; IT Act 2000 honesty).
- tools/digital-signature/worker.ts (179) — validate-e-invoice worker shape. Exported pure helpers (smoke-pinned): parseSignOptions (pw/reason≤200/location≤120/stamp==="1"/page≥1 floor/name≤60/locale hi-only) + p12ErrorDetail (6 honest P12Error codes → "sign: …" lines). Flow: assets[0] missing → honest no-certificate error; signPdf with visible stamp from options; output base+"-signed.pdf"; detail { files, pages, signer } via local RunDetail & { signer?: string } (UI chip lands with wiring).
- tools/digital-signature/surface.tsx (799) — e-invoice surface architecture: PDF status card, draft banner (dp_dsig: reason/location/name/stamp/page — password NEVER persisted), cert section (hidden file input .p12/.pfx + password Input w/ eye toggle + Unlock), unlock = microtask-first async effect over an "armed" (file,password) pair set ONLY from events (parseP12+parseCertificate client-side; auto-arm when a file is picked with a password typed); cert summary card (CN prominent + org/serial-shortened/valid-to/key badge, emerald valid / rose expired); any password or file edit clears the unlock so the shown summary always matches the current (file,password) at run time. Option sync: pw+stamp+page event-context, reason/location/name debounced 250ms, locale effect. setRunBlocked: files 0 → dsig.needFile; no p12/pw/cert → dsig.needCert. Visible stamp section: Switch + page input + live bottom-right box preview. Boot rehydrates p12+cert from the store (phase remounts), password from values.pw.
- tools/verify-pdf-signatures/{config.ts (76), worker.ts (197), i18n.json (18)} — no surface (plain shell flow), outputKind text; worker = validate-e-invoice report pattern: exported pure renderReport + summarize; per signature: signer CN/org, ISO time, VALID/INVALID verdict, INTACT/TAMPERED prominent, per-check [PASS]/[FAIL]/[??] lines (7 check ids), honest-scope footer (no CRL/OCSP, no trust store) + Hindi verdict section; unsigned PDF = plain finding, NOT an error. detail { files, signatures, valid, failed } via local RunDetail & { signatures?; valid? }.
- i18n: tools/digital-signature/i18n.json (dsig, 47 keys — spec's ~34 + draft/run-card/house-style labels) + tools/verify-pdf-signatures/i18n.json (vsig, 4 keys — deliberately minimal per spec: tool has no surface; report text lives in the worker EN+HI inline like validate-e-invoice; result-chip copy will be the orchestrator's "result.*" namespace when RunDetail gets wired). scripts/merge-signatures-i18n.ts (111) — merge-einvoice pattern: per-part parity, clobber refusal, required keys (how1-3 ×2 + needFile/needCert), surface dsig-literal cross-check, whole-catalog leaf parity. RUN: 3187 → **3238 = 3238** (+51 keys ×2).
- QA: scripts/smoke-p9-f6ui.ts (410) → **33/33**: p12-store cycle (EventTarget window polyfill in bun: set/identity/subscribe/notify/unsubscribe/clear), option transport (full shape, defaults, clamps/floors/junk, caps 200/120/60, stamp==="1" only, locale hi-only, 6 error codes + fallback), REAL fixtures round trips through the exact option shape (RSA CN=Asha Verma + ECDSA CN=Rahul Sharma sign→verify valid, visible stamp via options still verifies — Latin name in bun, Helvetica fallback: Devanagari is the browser E2E's job per engine note; wrong password → bad-password detail; tamper → invalid+TAMPERED), report renderer (valid/tampered/unsigned/multi + Hindi verdict + honest scope), i18n parity + required keys + literal coverage. `bunx tsc --noEmit` → 0 (2 "??/|| mixing" syntax fixes en route), `bun run lint` → 0/0. dev.log clean (no compile errors; server down at check time — system-managed, not touched).
- GOTCHAs pinned: (1) `a ?? b || c` needs parens (bun AND tsc both reject) — hit twice; (2) bun smoke imports worker files fine (self.onmessage assignment is inert) but the visible-stamp path fetches the Devanagari font from the dev server — can stall while turbopack is compiling; (3) tsconfig `@/` alias works in bun scripts via tsconfig paths.

Stage Summary:
- Tool files COMPLETE, unwired by design (registry/configs/surfaces/i18n untouched except via merge). For wiring: register DigitalSignatureSurface for digital-signature; option keys exactly pw/reason/location/name/stamp/page/locale; asset = p12-store getP12File; RunDetail chips wanted: signer (dsig) + signatures/valid (vsig); flip both registry modes to "D".
- Project state: i18n 3238=3238 | tsc 0 | lint 0/0 | smoke-p9-f6ui 33/33. Remaining P9: request-signature (#96) mini-service + recipient flow, 3-way wiring, E2E, worklog + commit.

---
Task ID: P9-F6-WIRING-E2E
Agent: orchestrator (main session)
Task: Wire the signature trio (#95-97), full browser E2E, and close P9 — 97/97 tools live.

Work Log:
- Configs: tools/request-signature/config.ts created (noFile tool — how1-3 + 5 features + 3 FAQ, honest Mode S copy); configs.ts +3 imports/entries (digital-signature, verify-pdf-signatures, request-signature).
- Registry: enabled:true ×3 (97/97). Phase P3→P9 + RoadmapPhase "P9" added with labels ("Phase 9 · Finish line" / "चरण 9 · फ़िनिश लाइन"). request-signature description de-Pro'd ("sign in their browser").
- Surfaces: digital-signature + request-signature registered (verify uses the standard text shell like validate-pdfa).
- protocol.ts RunDetail: +signer (dsig), +signatures, +valid (vsig).
- i18n: rsign how1-3 added + merge script upgraded to ADDITIVE mode (add keys freely, refuse to change existing values — clobber guard now edit-safe). 3337 = 3337 final.
- E2E (agent-browser, THROUGH GATEWAY :81 for service tools — direct :3000 fetches can't reach :3032):
  - digital-signature: p12+password injected via DataTransfer (agent-browser's native upload fails the app's async magic-check — PINNED for future E2E), Unlock → cert card "Organization | DocoPDF Test | Serial 5e3a75e5…053c6f5c | Valid until 2028-10-19 | Key RSA", Display name auto-filled "Asha Verma", visible stamp ON → run → "1 files, 2 pages · 24 KB" signed download.
  - verify-pdf-signatures: chained the signed file via "What next?" → report: "Signer: Asha Verma (DocoPDF Test) · Signed at 2026-10-20T13:33:23Z · Verdict: VALID — every hard check passed · Document: INTACT" + all 6 checks PASS + chain linkage + Hindi verdict + honest-scope footer.
  - request-signature: created link (48h) → recipient #/sign/<token> (Server badge, message, countdown) → SignatureDialog Type tab "Rahul Sharma" Dancing Script → placement (page/position/size + live preview) → Sign & submit → "Signed and submitted" → requester #/req/<token> shows "Signed" + Download signed PDF.
  - Hindi: डिजिटल हस्ताक्षर H1 renders. Mobile 390px: overflowX=0 on all three tools. 0 browser errors, 0 console failures.
  - VLM on the full-page screenshot: 9/10, "clean and professional, no visual defects".
- Full QA gate: tsc 0, lint 0/0, smoke-p9-f6a 50/50, smoke-p9-f6ui 33/33, i18n 3337=3337, dev server 200 (daemon relaunch after the known i18n-rewrite death), convert :3031 + request-sign :3032 healthy.
- Screenshots: public/qa/pki/p9-dsig-desktop.png + p9-dsig-full.png.

Stage Summary:
- **P9 FINISH LINE COMPLETE: 97/97 tools live.** All 5 tracks (A/B/C/D/E) done. i18n 3337=3337. Everything committed next.
- Services running: dev :3000 (daemon), convert :3031, request-sign :3032. Caddy gateway :81 required for Mode S tools (webpage-to-pdf, office converts, request-signature).
- Remaining housekeeping: CONTEXT-MEMORY status bump, git commit, cron re-create.
