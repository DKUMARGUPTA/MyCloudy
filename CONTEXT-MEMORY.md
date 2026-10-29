# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> Detailed technical handover = `/home/z/my-project/worklog.md` (har round ka full entry wahan append hota hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** P6-u COMPLETE (create-fillable-pdf-form render+worker onto the own engine — the AcroForm AUTHORING family is done: builder P6-o + reader P6-p + renderer P6-u) — 100 tools LIVE (0 disabled), Vercel LIVE, battery 109/109, fillable smoke 156/156. Engine now: /MaxLen, /AA {C,F,K} JS actions, /CO calc order, builder NeedAppearances, authored Info (StampContext seam). lstr writer bug FIXED (pdf-lib paren-nesting parity). Remaining pdf-lib importers: ~34 files.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Registry | **100 tools — SAB LIVE ✅** (verified brace-aware count; e-invoice family included) |
| **LIVE tools** | **100** ✅ (registry `enabled: true`, 0 disabled) |
| Own PDF engine (P6) | **P6-a..u COMPLETE** — 42 families pdf-lib-free; **~34 runtime files** abhi bhi pdf-lib import karte hain (P6-v queue: pdf-to-X extractors → crypto → fonts/OCR → e-invoice workers → misc tail) |
| Master plan | **MASTER-PLAN-1** worklog mein recorded (P6-t..z → P7 → LAUNCH-OPS → P10 → P11) + discipline contract (worklog+memory+push+Vercel per phase; battery on EXACT commit tree) |
| Editor (Phase 8) | COMPLETE 6/6 (edit/annotate/text-edit+F&R/form fields/mobile polish) |
| Static pages (PRD §9) | **LIVE** — about/contact/privacy/terms wired end-to-end (footer + `#/page/<id>` + i18n 166×2) |
| Server | Next.js 16.1.3, port 3000 (daemon: `python3 scripts/dev-daemon.py`), dev.log clean |
| **Production** | **https://mycloudy-beta.vercel.app** LIVE (Vercel; DB endpoints degrade gracefully — Turso future) |
| GitHub | `DKUMARGUPTA/MyCloudy` — main fully pushed + 26 tags; zero unpushed |
| Quality gates | tsc **0** errors · eslint 0 · battery **109/109 ALL PASS** (16 pre-existing failures FIXED in FIX-ALL round) |
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

### 1. P6-v+ — Own engine migration ka bacha hua hissa (**~34 pdf-lib importer files** — P6-u ne fillable render khatam kiya; AcroForm authoring family COMPLETE)
- **NEXT (MASTER-PLAN-1 order):** P6-v pdf-to-X extractors (word/odt/html/markdown/pdfa on decodeStreamBytes) → P6-w crypto family (sign/digital-sig/pki/request-sig/lock) → P6-x font users (translate CJK/Arabic, ocr text-layer GlyphLessFont, passport, scan, redact) → P6-y e-invoice workers (NOTE: tools ALREADY enabled+LIVE — sirf pdf-lib imports port karne hain) → P6-z misc (compare, stamp-common, rasterize, request-signature, web-optimize, bookmark, repair)
- Engine seams available: rewriteDocument (preserve-numbers whole-doc + ObjStm) · decodeStreamBytes (Flate/LZW/A85/AHx/RLE + predictors) · organize/stamp/create contexts. pdf-lib = DEV-TIME ORACLE only (smokes mein cross-verify)

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

### 4. E-invoice family browser QA
5 tools LIVE hain (P3-era se) — smokes pass (cei 147 + peinv 170 + xinv 492 + vei 309). Browser E2E spot-check har session mein ek tool pe kar lena chahiye.

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
- **⚠️ ObjStm pair table:** (num, BODY-OFFSET) hai — (num, gen) NAHI. Writer banana ho to pehle pdf-lib ka apna output bytes se oracle-probe karo. XRef stream ki APNI row ka offset rows build karne SE PEHLE record karo — warna offset 0 → parser ka bruteRecover live iteration ke beech entries CLEAR kar deta hai (nested laziness hazard).
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

- **P6-t (ye wali):** page-size + crop OWN ENGINE pe — crop = rewriteDocument in-place /CropBox surgery (inherited-box + ObjStm-resident parity); page-size = writer ki native MIXED plan (copied pages materializeInheritable ke saath + authored resize sheets pageFormEmbed forms ke saath, WriteSynthetic numbering contract) + pageHasContents standalone seam. smoke-crop REAL-pipeline section +23 asserts; smoke-pagesize 58/58 UNTOUCHED; PRE-EXISTING smoke-lock fail FIXED (P6-s ne MetaDoc port kiya tha, smoke nahi — battery claim galat tha). E2E: crop (40,40,495.28×761.89) byte-exact, page-size 3-resized/2-kept annot survival byte-verified, mobile + Hindi + 0 console errors. MASTER-PLAN-1 phase map recorded.
- **P6-s:** meta family OWN ENGINE pe — rewrite.ts infoOverride + meta-common full port (Info edits/strip/report byte-format oracle parity) + 3 workers. smoke-metadata rewired ALL PASS, smoke-viewer-prefs 53/53 ZERO rewire, E2E viewer-prefs golden path byte-verified (TwoColumnLeft + XYZ 1.5 OpenAction).
- **P6-r:** compress family OWN ENGINE pe — streams.ts (Flate/LZW/A85/AHx/RLE+predictors, 8/8 oracle parity) + rewrite.ts (preserve-numbers whole-doc rewriter + Flate'd ObjStm — 70,869 B vs pdf-lib 71,334, oracle ko BEAT kiya) + engine/workers port + dedupe/strip own-side + dead recompress files deleted. 2 engine bugs pakde (ObjStm pair-offset + xref self-row) — oracle probing ne bachaya. Smokes 44+19+43 rewired green; battery 109/109; E2E: 2.9MB→115KB dedupe chip byte-verified, to-size 1.5MB→78KB honest rung chip, mobile + Hindi + 0 console errors. compress family OWN ENGINE pe — streams.ts (Flate/LZW/A85/AHx/RLE+predictors, 8/8 oracle parity) + rewrite.ts (preserve-numbers whole-doc rewriter + Flate'd ObjStm — 70,869 B vs pdf-lib 71,334, oracle ko BEAT kiya) + engine/workers port + dedupe/strip own-side + dead recompress files deleted. 2 engine bugs pakde (ObjStm pair-offset + xref self-row) — oracle probing ne bachaya. Smokes 44+19+43 rewired green; battery 109/109; E2E: 2.9MB→115KB dedupe chip byte-verified, to-size 1.5MB→78KB honest rung chip, mobile + Hindi + 0 console errors.
- **FIX-ALL-1 (5ffccc4/aa9e33b/b217071):** disk rollback recovery + battery 109/109 (16 known failures root-caused: pki .pem fixtures gitignore ne khae the + 15 stale duplicate smokes deleted) + registry truth correction (brace-aware count — e-invoice was ALREADY live, 100/100).
- **STATE-SYNC (f03ad0f):** Token recovery audit → push verified → CONTEXT-MEMORY stale-se-current → cron recreate.
- **P6-q (d9030a3):** Vercel build unblocked (tsc 0) + Prisma completion (BugReport + User.role) + **Phase-6 static pages LIVE** (about/contact/privacy/terms wired end-to-end) + stale-tree removal (~30 dead files).
- **P6-p:** fill-out-pdf + flatten-pdf own engine pe (AcroForm reader + setters + AP regeneration + burn passes) — 35/… families pdf-lib-free.
- **P6-o:** edit-pdf + annotate + make-fillable own engine (StampContext family + 2 engine bugs fix).
- **P6-n/m/l/k/j/i/h/g/f/e/d/c/a:** markdown/html/webpage/epub → office converters (word/ppt/excel/odt/rtf/publisher) → card/collage/resume/invoice renderers → imagegrid+txt → overlay → create/write side (CreateContext) → Devanagari seam (own TTF parser/subsetter + GSUB + full Indic shaper) → finishing chain → assemble/halve/nup → merge/split → organize family → engine core.
- **COMPARE-FILEE:** 266-format desktop converter vs hum — positioning + roadmap delivered.
- **DEPLOY-OPS + P5-rest:** Vercel root-cause (ghost import), tokens secured, translate-pdf 13 langs (own Arabic shaper + kinsoku), pdf-to-excel ruled tables, ID-card duplex — **P5-rest COMPLETE**.
- Usse pehle: P4.7 resize-kb, P8.1–8.6 editor family, P3 create tools (collage/card/invoice/form), OCR, HEIC, TIFF/SVG, assemble, viewer-prefs, copy-from-pdf…

*Full detail har round ka `/home/z/my-project/worklog.md` mein hai (append template usi file ke bottom mein).*
