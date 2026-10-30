# DocoPDF — Context Memory (याद — What happened / What's next)

> **Purpose:** Ye file har session mein sabse pehle padho — isme pura project ka short-term memory hai.
> **⚠️ GOVERNANCE (2025-10-30 se BINDING):** har round pehle `AGENTS.md` + `docs/rules/INDEX.md` padho — 16 rule docs (PRD/Design/Architecture/Folders/Relations/API/Agent/Plan/Steps/Features/Auth/MCP/Integration/Testing/Debugging) ab mandatory hain, contract change = rules doc update SAME commit mein.
> **⚠️ R21 (2025-10-30):** AI routes (chat/summarize/translate) ab `src/lib/ai/zai-client.ts` adapter use karte hain — SDK import routes me BANNED. Prod pe AI tab tak OFF hai jab tak owner Vercel pe `AI_BASE_URL`+`AI_API_KEY`+`AI_MODEL` set nahi karta (koi bhi OpenAI-compatible provider); tab tak honest `aiNotConfigured` 503. Sandbox file-fallback se sab local golden paths green.
> Detailed technical handover = `/home/z/my-project/worklog.md` (har round ka full entry wahan append hota hai).
> Product PRD (WHAT to build) = `/home/z/my-project/upload/DocoPDF-PRD-v2.md`
> **Updated:** **P7-SEO COMPLETE (2025-10-30)** — full SEO layer: real crawlable routes (/tool/<id> ×100, /tools + 10 categories, 4 static, /hi Hindi mirrors via catch-all) with SSR meta (unique title/desc/keywords + canonical + hreflang en/hi + OG/Twitter cards), JSON-LD (SoftwareApplication + FAQPage + Breadcrumb + Organization + WebSite SearchAction), dynamic registry-driven sitemap.ts (116 URLs) + robots.ts, 50 curated keyword-researched tool copies + generator, sharp OG image 1200×630. **FIXED: purana sitemap 404 URLs promise kar raha tha (hash-only app)**. Anchor-links hash-touch fix (tool pages pe skip-link home jump bug). Gates: tsc 0, eslint 0, battery 110/110, E2E clean. **PUSH PENDING (token wiped)**. User docopdf.com attach kar raha hai — sab canonical ready.

---

## 📊 Ek Nazar Mein (Quick Status)

| Metric | Value |
|---|---|
| Registry | **100 tools — SAB LIVE ✅** (verified brace-aware count; e-invoice family included) |
| **LIVE tools** | **100** ✅ (registry `enabled: true`, 0 disabled) |
| Own PDF engine (P6) | **P6-a..z + P6-v-b + P6-END — MIGRATION COMPLETE ✅** — ALL 60 tool families pdf-lib-free, **0 runtime importers** (pdf-lib = devDependency only: smoke fixtures + oracles) |
| Master plan | **MASTER-PLAN-1** worklog mein recorded (P6-t..z → P7 → LAUNCH-OPS → P10 → P11) + discipline contract (worklog+memory+push+Vercel per phase; battery on EXACT commit tree) |
| Editor (Phase 8) | COMPLETE 6/6 (edit/annotate/text-edit+F&R/form fields/mobile polish) |
| Static pages (PRD §9) | **LIVE** — about/contact/privacy/terms wired end-to-end (footer + `#/page/<id>` + i18n 166×2) |
| Server | Next.js 16.1.3, port 3000 (daemon: `python3 scripts/dev-daemon.py`), dev.log clean |
| **Production** | **https://mycloudy-beta.vercel.app** LIVE (Vercel; DB endpoints degrade gracefully — Turso future) |
| GitHub | `DKUMARGUPTA/MyCloudy` — main fully pushed + 26 tags; zero unpushed |
| Quality gates | tsc **0** errors · eslint 0 · battery **110/110 ALL PASS** (P7-a a11y-names + P7-b magic-bytes added; 108 tool smokes + 2 P7 gates) |
| Privacy | 100% on-device (Mode D) — zero external requests |
| i18n | English + हिंदी — **4791 = 4791** flat-leaf keys parity |
| Mini-services | convert (port 3031), request-sign (3032) — double-fork daemonizer se start |
| Tokens | ⚠️ **WIPED 2025-10-30 05:33** (`.env.credentials` + `/home/z/.tokens/` dono gaye — sandbox artifact; recovery impossible, values kabhi print nahi hue). **Push ke liye user se fresh PAT maango.** Jab mile: TURANT push ritual + tag push — disk files pe durability mat maano |

---

## 🚀 Ops Quick Commands (naya session = ye sabse pehle)

```bash
# PUSH (har kaam ke baad — disk ephemeral hai, push = durable):
cd /home/z/my-project && set -a && source .env.credentials && set +a && bash scripts/push-github.sh
# OPS DASHBOARD (GitHub quota + Vercel deploys + disk/mem + git hygiene):
bash scripts/ops/status.sh
# DEV SERVER (agar :3000 down):
python3 scripts/dev-daemon.py
# MINI-SERVICES (agar :3031/:3032 down — plain nohup reaped hota hai):
python3 scripts/mini-daemon.py convert && python3 scripts/mini-daemon.py request-sign
# LINT: bun run lint   |   TSC: bunx tsc --noEmit
# Cron QA job agar "Disabled due to exec limits" ho → delete karke FIR SE create karo (webDevReview, fixed_rate 900s, priority 1, Asia/Calcutta)
```

**Vercel deploy = automatic on push.** Live URL: `https://mycloudy-beta.vercel.app`
⚠️ `mycloudy.vercel.app` → OLD account hai (user ka purana Nuxt app `mycloudy.iamsdr.in` pe redirect) — use mat chhedo.
**Final production domain (user decision): DocoPDF.com** — attach SIRF sab phases complete hone ke baad.

---

## ⏳ KYA PENDING HAI (priority order)

### 1. ~~P6 — Own engine migration~~ **COMPLETE ✅** (2025-10-30; P6-v-b pdfa mega-port + P6-END final surfaces; worklog retro appended)

### 2. P7 — Quality moat (P7-a + P7-b DONE ✅; P7-c NEXT)
- ~~a11y-name smoke~~ **DONE** — smoke-a11y-names.ts 9/9 (DOM audit: 110/110 pages clean; brace-aware source scanner)
- ~~magic-byte detection~~ **DONE** — smoke-magic-bytes.ts 18/18 (DropZone content sniffing + worker parse gates locked)
- **P7-c (NEXT): i18n VLM battery** — screenshots EN+HI → VLM skill se visual language verification

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
- **⚠️ Signature badlo to SAB smoke callers grep karo:** tool ka apna smoke hi nahi — view-outline jaise cross-smokes bhi writeOutline(doc,…) call kar rahe the (battery ne pakda, importer-scan ne nahi).
- **⚠️ newDict() wrapper return karta hai:** depth-first build ke baad `extras[last]` = last DESCENDANT, item nahi — recursion se {itemNum, itemDict, count} return karo, index archaeology mat karo. Outline /Count = TOTAL descendants (1+child.count), direct-children nahi.
- **⚠️ Cron agent + main session ek saath:** commit races (P6-n double-amend) — history REWRITE KABHI nahi (`--amend`/reset ban), naya commit hi.

---

## 📝 Recent Rounds (detail = worklog.md)

- **P7-SEO (2025-10-30):** "world-best SEO" round — sitemap-404 bug fix (hash-only app ke against real URLs promise ho rahi thi) → 11 naye files: seo libs (site/tool-seo/metadata/json-ld) + routes (tool/[id] ×100 static, tools + [category], 4 static, /hi/[[...path]] catch-all with Hindi SSR meta + locale boot) + DYNAMIC sitemap.ts (116 URLs hreflang) + robots.ts (public/sitemap.xml+robots.txt DELETED — stale) + app-shell extraction + useHashRoute(initial) + anchor.ts (plain-anchor scroll fix) + gen-og-image.ts (sharp 1200×630) + layout refresh (60+→100 copy, Organization/WebSite JSON-LD, home-FAQ moved to page). 50 curated keyword copies + generator. E2E: sab routes 200 + 404 unknown, SSR head verified per type, Hindi page lang=hi zero errors, battery 110/110. ⚠️ LESSONS: context consumer provider-same-component hota hai to value null milti hai (hook param better); /hi hydration error = Fast-Refresh artifact (clean restart = zero); setLocale hydration-commit me rAF-defer. **PUSH PENDING (token).**
- **VERSION-SAVE (2025-10-30 ~05:40):** audited version `cd89b6b` GitHub main pe **locked** (verified no-auth ls-remote; Vercel 200; audit record commit ke andar). Save-gates re-run green (tsc 0, lint 0). Local annotated tags `checkpoint-100-tools` + `v1.0.0-rc.1` → cd89b6b (verify via ^{commit}). ⚠️ INCIDENT: credential files ~05:33 pe wipe (root cause unknown — cron spawn correlate; recovery searched, zero). Push blocked until fresh PAT. Tags recreate one-liner worklog mein pinned.
- **FINAL AUDIT (2025-10-30):** user-requested deep audit — gates ALL GREEN on live tree (tsc 0, eslint 0, battery 110/110, 0 runtime pdf-lib importers, E2E merge golden path "5.1 KB → 4.2 KB 18% smaller" + console clean + Hindi + mobile 390 no-overflow, Vercel HTTP 200). 3 GAPS FIXED: (1) dev :3000 down → daemon restart; (2) mini-services reaped between sessions → **scripts/mini-daemon.py** NEW (double-fork; /health {"ok":true}); (3) cron exec-limit disabled → recreated. Metrics: 100/100 tools LIVE, 274,438 LOC, i18n 4791=4791, admin routes ALL getAdminUser-gated, sitemap 11 URLs (per-tool expansion pending). Verdict: **consumer-launch ~90% · enterprise ~68%** (SSO/audit-logs/RBAC/API-keys/SLA/billing missing).
- **P6-z (ye wali):** misc family COMPLETE — bookmark×2, web-optimize×2, rasterize, repair×2 OWN ENGINE pe; dead repair engine.ts DELETED (zero importers — strict import-scan ne 11 pakde, 8 ke bajaye: +engine.ts + generate-qr-code + request-signature surfaces untracked the). BOOKMARK: writeOutline(pdfBytes,tree) rewriteDocument{deletions=First/Next cycle-walk, extraObjects=tree above source max} + outlinePageCount pre-pass; /Count=TOTAL descendants (⚠️ pehle direct-children likha tha — review mein pakda); ⚠️ newDict wrapper: recursive build ke baad extras[last]=last DESCENDANT — buildItem {itemNum,itemDict,count} return karta hai. WEB-OPTIMIZE: engine own types pe FULL REWRITE — loadWebOpt seam + rewriteWebOpt ONE-PLACE pipeline (worker+smoke zero drift); garbage walk container-excluding totals (live+removed==total); recompress replacements Map (writer /Length recompute karta hai); strip dropInfo. RASTERIZE: CreateContext port — drawImage op chain pdf-lib-identical (smoke full-bleed asserts untouched). REPAIR: strictVerify = own parse + !recovered (brute rescue = errVerify) + listPages; Stage-1 rebuild rewriteDocument CLASSIC; Stage-2 byte-identical. ⚠️ view-outline cross-smoke bhi writeOutline call karta tha — signature change pe SAB smoke grep karo (battery ne pakda). Smokes: bookmark 62/62 (pdf.js Devanagari readback + FEFF092E0941 deletion hex oracle), web-opt 79/79, rasterize 33/33, repair 85/85, view-outline 31/31; battery 108/108; tsc 0; eslint 0. E2E dual-parser ×3: bookmark 4-item outline (pdf.js "Page 1..4"), web-opt 1,486→1,472 B (ObjStm+XRef stream; strip opt-in), repair xref-stripped input → fresh classic table + 3/3 needles; mobile 390 clean. Importers 11→4: P6-v-b pdf-to-pdfa → P6-END (embed-image type-only + 2 client surfaces) → **P6 COMPLETE**.
- **P6-y r2:** e-invoice family COMPLETE — facturx-attach ONE-PASS own-engine surgery (parsePdf strict + catalogDict in-place + rewriteDocument{extraObjects,deletions} CLASSIC; EmbeddedFile RAW + Filespec /AFRelationship /Alternative authored directly — the attach+reload+patch dance GONE; ⚠️ name writer "/"→"#2F" escape: caller passes DECODED "text/xml", pre-escaped form double-escapes); worker one-pass + xmpOverride; pdf-to-e-invoice afWalkAttachments own parser (encryptedOk parity, decodeStreamBytes, decodeTextString). REGISTRY TRUTH: "5 disabled" note stale — 100/100 enabled, 0 overrides. Smokes: CEI 146/146 (Subtype fix + /Filter-conditional decode + rewired honesty asserts), P2E 170/170; battery 108/108; tsc 0, eslint 0. E2E: create-electronic-invoice golden path blob-captured 3,078,740 B → own-parser (/AF 1, XMP EN 16931, Names 1 pair, no /Encrypt) + @cantoo ORACLE reload (factur-x.xml + /Alternative + XML decodes + 2p) — dual-parser verified; console clean. Importers 11→8 (P6-z: bookmark×2, rasterize, repair/model, web-optimize×2 → P6-v-b pdfa → embed-image.ts).
- **P6-y r1:** xml-invoice-to-pdf (render+worker) + stamp-common/worker-lib OWN edition + compare-pdf (P6-z early) — 5 files, importers 15→11. worker-lib API migration: loadStampFonts(StampFontEmbedder{measure,embedTtf}) → ConvertFace faces + face-aware measure (CreateContext + StampContext dono satisfy); drawStampMark(page, mark, face, widthOf); deva fetch deva.ts se re-export (fontkit+regenerator GONE). render.ts Sheet painter CreateContext pe (faceWidth split-run measure — std ctx.measure, Noto ttf.measure). compare-pdf: text+image-pair pages, embedJpeg sync, pair frames. battery 108/108 (xml 751/751, compare 77/77), tsc 0, eslint 0. E2E: UBL invoice (₹+Hindi) → Convert → 8,650 B blob-captured → own-parser verify (1p, CIDFontType2 Noto subset, 2 Helvetica, 47 Tj, DocoPDF producer/title UTF-16BE, zero pdf-lib); console clean. NEXT: P6-y r2 = create-electronic-invoice worker+facturx-attach (AF/EmbeddedFile/Filespec/XMP → rewriteDocument extraObjects) + pdf-to-e-invoice (extraction → own parser) → registry 5 disabled tools decision.
- **P6-x:** fonts/OCR family — 8 files OWN ENGINE pe pdf-lib-free (scan-pdf, passport-photo, summarize surface, ocr/text-layer, ocr/worker, ocr-pdf, redact-pdf, translate-pdf). ENGINE: CreateRectOptions.borderDashArray (pdf-lib borderDashArray parity). ocr/worker = StampContext slot-plan pass-through + stampText-per-SLOT invisible layer; ocr-pdf = parsePdf{encryptedOk} structural probe + organizeMerge (source 0 = original, 1 source per tesseract page); redact = writeDocument pages+synthetics (copy dicts cloneDict{drop Parent}+materializeInheritable; JPEG sheets = {type:"new"} + image XObject synthetics, numbering 3+keep+2*marked; **rewriteDocument REJECTED — collectRewriteObjects sab xref entries ride karta hai, reachability walk NahiN → redaction LEAK hota**); translate = CreateContext + ConvertFace + embedTtf auto-subset (fontkit+regenerator DEAD). Smokes: summarize 43/43 + translate 73/73 rewired; battery 108/108; tsc 0, eslint 0. E2E: passport golden path byte-verified (1 shared DCTDecode XObject 6 draws, 6× [2 2] 0 d cut guides, /Helvetica info, zero pdf-lib), console clean, mobile 390 no-overflow. ⚠️ DEV SERVER = scripts/dev-daemon.py ONLY (tool reaper + browser + Turbopack = 4GB OOM twice). Importers 24→15 (P6-y e-invoice 5 → P6-z misc 8 → P6-v-b pdfa 1 → embed-image 1).
- **P6-w-b:** crypto family round 2 — lock-common/security.ts OWN ENGINE pe (the last crypto file). NEW: secprims.ts (MD5/RC4/AES-128/256/SHA-2/Algorithm-2.B — FIPS-197 + node:crypto verified) + security.ts (encryptDocument V5/R6 + V4/R4 writer; openEncrypted V1-R6 reader with crypt filters); parser encryptedOk + ParsedPdf.decryptStream ObjStm hook; rewrite extraObjects + minVersion. 3 oracle bugs pakde: AES final-round offset (160/224 ≠ 176/240), ObjStm residents PLAIN (§7.6.2 — container hi unit hai), partial-block tolerance. @cantoo writer QUIRK documented (strings kabhi encrypt nahi karte; objStm=false unka OWN reader bhi corrupt karta hai). Smokes: lock 45→58 (§14 both-direction interop + qpdf R6), security 27/27, edit 53/53, annotate 92/92; battery 108/108. E2E: lock+unlock golden paths byte-verified (@cantoo no-pw refused + owner-only + wrong-pw honest; /Extensions /ADBE L8 + fresh /ID + signed /P). PUSH-PENDING resolved at session start (user ke fresh tokens se e518542..9feb2be push + Vercel READY).
- **P6-w-a:** crypto family round 1 — the production signer trio ported onto the own engine (digital-signature, request-signature, sign-pdf; StampContext.createSignatureField seam; verify /T-hex-name fix; ORPHANED P9 prototype pki-common DELETED — 30→23 importers).
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
