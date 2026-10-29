# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> Detailed technical handover = `/home/z/my-project/worklog.md` (har round ka full entry wahan append hota hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** STATE-SYNC round (P6-q ke baad) — 100 tools LIVE, Vercel LIVE, GitHub fully pushed, own-engine P6-a..q complete. Stale P3-era numbers replace kar diye.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Registry | **105 tools** (100 LIVE ✅ + 5 built-but-disabled ⏳) |
| **LIVE tools** | **100** ✅ (registry `enabled: true`) |
| Pending (built, not enabled) | 5 — e-invoice family: `create-electronic-invoice`, `create-invoice-visually`, `pdf-to-e-invoice`, `validate-e-invoice`, `xml-invoice-to-pdf` (code + smokes exist, enable round baki) |
| Own PDF engine (P6) | **P6-a..q COMPLETE** — 35 families pdf-lib-free; ~46 runtime files abhi bhi pdf-lib import karte hain (P6-r candidates) |
| Editor (Phase 8) | COMPLETE 6/6 (edit/annotate/text-edit+F&R/form fields/mobile polish) |
| Static pages (PRD §9) | **LIVE** — about/contact/privacy/terms wired end-to-end (footer + `#/page/<id>` + i18n 166×2) |
| Server | Next.js 16.1.3, port 3000 (daemon: `python3 scripts/dev-daemon.py`), dev.log clean |
| **Production** | **https://mycloudy-beta.vercel.app** LIVE (Vercel; DB endpoints degrade gracefully — Turso future) |
| GitHub | `DKUMARGUPTA/MyCloudy` — main @ `64ee3d7` FULLY PUSHED + 26 tags; zero unpushed |
| Quality gates | tsc **0** errors · eslint 0 · battery **107/17** (17 = pre-existing cron-agent fails) |
| Privacy | 100% on-device (Mode D) — zero external requests |
| i18n | English + हिंदी — **4791 = 4791** flat-leaf keys parity |
| Mini-services | convert (port 3031), request-sign (3032) — double-fork daemonizer se start |
| Tokens | `/home/z/.tokens/docopdf.env` + `.env.credentials` (repo root, gitignored) — chmod 600, repo ke BAHAR kabhi nahi |

---

## 🚀 Ops Quick Commands (naya session = ye sabse pehle)

```bash
# PUSH (har kaam ke baad — disk ephemeral hai, push = durable):
cd /home/z/my-project && set -a && source .env.credentials && set +a && bash scripts/push-github.sh
# OPS DASHBOARD (GitHub quota + Vercel deploys + disk/mem + git hygiene):
bash scripts/ops/status.sh
# DEV SERVER (agar :3000 down):
python3 scripts/dev-daemon.py
# LINT: bun run lint   |   TSC: bunx tsc --noEmit
# Cron QA job agar "Disabled due to exec limits" ho → delete karke FIR SE create karo (webDevReview, fixed_rate 900s, priority 1, Asia/Calcutta)
```

**Vercel deploy = automatic on push.** Live URL: `https://mycloudy-beta.vercel.app`
⚠️ `mycloudy.vercel.app` → OLD account hai (user ka purana Nuxt app `mycloudy.iamsdr.in` pe redirect) — use mat chhedo.
**Final production domain (user decision): DocoPDF.com** — attach SIRF sab phases complete hone ke baad.

---

## ⏳ KYA PENDING HAI (priority order)

### 1. P6-r+ — Own engine migration ka bacha hua hissa (~46 pdf-lib importer files)
- **compress family** — compress-pdf (engine/recompress/worker) + compress-common + compress-pdf-to-size (the qpdf-shaped consumer)
- **create-fillable-pdf-form** — render.ts + worker.ts (last big form authoring surface)
- **pdf-to-X extractors** — pdf-to-word, pdf-to-odt, pdf-to-html, pdf-to-markdown, pdf-to-pdfa
- **crypto family** — sign-pdf, digital-signature, pki-common/pdfsign, verify-pdf-signatures (RC4/AES wiring baad mein)
- **font users** — translate-pdf worker (CJK/Arabic embed), ocr family (text-layer GlyphLessFont), passport-photo, scan-pdf, redact-pdf
- **e-invoice family** — create-electronic-invoice (facturx-attach/cii-build), xml-invoice-to-pdf (worker/render)
- **misc** — compare-pdf, meta-common/worker-lib, set-pdf-viewer-preferences, remove-pdf-metadata, change-pdf-page-size/worker-lib, stamp-common/worker-lib, rasterize-pdf, request-signature, web-optimize-pdf (engine+worker), repair-pdf/model, crop-pdf/worker
- Engine seam pattern: parse → mutate plan → write; pdf-lib = DEV-TIME ORACLE only (smokes mein cross-verify)

### 2. P7 — Quality moat
- a11y-name smoke (har interactive element ka accessible name)
- magic-byte detection everywhere (har input surface pe)
- i18n VLM battery (screenshots → visual language verification)

### 3. PRD phases 7–11
- **Phase 7: PWA** (manifest, service worker, offline)
- Phase 8: Editor — ✅ COMPLETE (6/6)
- **Phase 9: Advanced tools** (bache hue)
- **Phase 10: Accounts + Pro** (auth, request-signature Pro gating)
- **Phase 11: services/worker** (server-side LibreOffice — Filee ka 266-format gap yahi band hota hai)

### 4. e-invoice family ENABLE round
5 tools built+smoked hain, registry mein `enabled: true` karna + E2E QA + i18n polish baki hai.

### 5. Ops / infra
- **Turso migration** (DB-backed API routes ab graceful-degrade pe hain)
- DocoPDF.com domain attach (deferred — user ne bola final ke baad)
- Vercel SSO/protection settings review (optional)

### 6. Filee lessons (own-implementation backlog)
Transactional output allocator · invisible waiting window · progress morph · undo-of-replace via trash · "only if smaller" copy-back · localized error KEYS.

---

## 📚 Pinned Lessons / Recipes (⚠️ = HAR agent ko yaad)

- **⚠️ agent-browser pointer events:** down → **150ms wait** → move(s) → up (same-tick dispatch = stale gesture state). Menus: `focus()` + Enter keydown. Toast DOM = `ol.fixed > li` (sonner selector kabhi nahi).
- **⚠️ pdf.js WORKER mein canvas:** `loadPdfjsInWorker` + `workerDocumentShim()` from `tools/pdfjs-common/worker-lib` + `ownerDocument` param — inline loader KABHI mat likho (image-PDFs blank milte hain).
- **⚠️ pdf-lib embeds ASYNC hain:** embedPng/embedJpg AWAIT karo (NaN matrix = silent drop). `drawImage` sirf width/height — w/h IGNORE. `getPage(0)` = FIRST page. Show-text ops HEX mein (`<...> Tj`) — raw search nahi, inflate + hex compare. Object-stream PDFs mein latin1 includes() JHOOTH — parse-level assert karo.
- **⚠️ useSyncExternalStore snapshot:** cached reference return karo (module-level, notify pe rebuild) — warna infinite loop crash.
- **⚠️ Compressed object streams:** /AcroForm, /CO sab compressed ke andar — reload karke parse karo.
- **⚠️ Model kind-name collisions:** `"name" in el` structural tie-break (P3-FORM).
- **⚠️ SVG workers mein impossible:** main-thread raster + collectAssets bridge (add-watermark logo-store pattern).
- **⚠️ execCommand styleWithCSS:** inline styles parse karne padte hain (B/I/U tags nahi milte).
- **⚠️ Worker bundle hygiene:** chhote helpers inline karo (transitive pdf-lib drag), PURE engine.ts shared rahe.
- **⚠️ KB-targeting ladder:** size-first quality-second, canvas-commit guard har encode pe.
- **⚠️ Devanagari matras:** Tesseract logical char order + GlyphLessFont = searchable Hindi.
- **⚠️ Vercel build:** scripts/** bhi typecheck hota hai — dev-time ghost imports (extraneous node_modules) clean CI ko maarte hain; tsconfig/eslint ab dev-trees exclude karte hain (committed tree MUST typecheck clean).
- **⚠️ Node-pdfjs + napi-canvas Arabic:** renderer gaps dikhata hai — real verification PDFium (Chrome) se karo.
- **⚠️ Cron agent + main session ek saath:** commit races (P6-n double-amend) — history REWRITE KABHI nahi (`--amend`/reset ban), naya commit hi.

---

## 📝 Recent Rounds (detail = worklog.md)

- **STATE-SYNC (ye wali):** Token recovery audit → /home/z/.tokens/docopdf.env zinda mila → 2 bache commits push (remote ab 64ee3d7) → CONTEXT-MEMORY stale-se-current → cron recreate.
- **P6-q (d9030a3):** Vercel build unblocked (tsc 0) + Prisma completion (BugReport + User.role) + **Phase-6 static pages LIVE** (about/contact/privacy/terms wired end-to-end) + stale-tree removal (~30 dead files).
- **64ee3d7:** postinstall prisma generate (Vercel fresh-install stub client fix) — bug-report API 201.
- **P6-p:** fill-out-pdf + flatten-pdf own engine pe (AcroForm reader + setters + AP regeneration + burn passes) — 35/… families pdf-lib-free.
- **P6-o:** edit-pdf + annotate + make-fillable own engine (StampContext family + 2 engine bugs fix).
- **P6-n/m/l/k/j/i/h/g/f/e/d/c/a:** markdown/html/webpage/epub → office converters (word/ppt/excel/odt/rtf/publisher) → card/collage/resume/invoice renderers → imagegrid+txt → overlay → create/write side (CreateContext) → Devanagari seam (own TTF parser/subsetter + GSUB + full Indic shaper) → finishing chain → assemble/halve/nup → merge/split → organize family → engine core.
- **COMPARE-FILEE:** 266-format desktop converter vs hum — positioning + roadmap delivered.
- **DEPLOY-OPS + P5-rest:** Vercel root-cause (ghost import), tokens secured, translate-pdf 13 langs (own Arabic shaper + kinsoku), pdf-to-excel ruled tables, ID-card duplex — **P5-rest COMPLETE**.
- Usse pehle: P4.7 resize-kb, P8.1–8.6 editor family, P3 create tools (collage/card/invoice/form), OCR, HEIC, TIFF/SVG, assemble, viewer-prefs, copy-from-pdf…

*Full detail har round ka `/home/z/my-project/worklog.md` mein hai (append template usi file ke bottom mein).*
