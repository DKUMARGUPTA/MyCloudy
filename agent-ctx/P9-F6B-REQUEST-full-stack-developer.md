# P9-F6B-REQUEST — request-signature (tool #96, the only Mode S signature tool)

Agent: full-stack-developer (files only — orchestrator wires registry/configs/surfaces after)

## What was built

1. **mini-services/request-sign/** (port 3032, bun --hot, ZERO npm deps — node:crypto + node:fs/promises only)
   - `index.ts` (419) — envelope service: POST /requests (multipart: file ≤25MB + %PDF magic BEFORE write, hours 24|48|168, from ≤80, message ≤500 → two randomBytes(24) hex tokens → `{signUrl:"#/sign/<t>", viewUrl:"#/req/<t>", expiresAt}`), GET /requests/:token/meta (sign OR view token — never the tokens), GET :token/pdf (inline, RFC5987 Content-Disposition), POST :signToken/sign (≤30MB, 409 already-signed, 410 expired/cancelled), GET :viewToken/result (attachment <name>-signed.pdf, 404 until signed), DELETE :viewToken (bytes wiped NOW, meta kept as "cancelled" until sweep — idempotent). 60s expiry sweeper deletes past folders. Sanitized names, JSON {error, code} errors.
   - data/ gitignored. package.json: name + `dev: bun --hot index.ts`, no deps. Running in background (service.log), /health 200.

2. **tools/request-signature/api.ts** (106) — typed fetch wrappers, every call RELATIVE path + `?XTransformPort=3032` (gateway rule). createRequest/fetchMeta/fetchPdf/postSigned/fetchResult/cancelRequest + RequestSignError{status, code}.

3. **Hash routes (surgical)** — use-hash-route.ts: views "sign"/"req" (`#/sign/<token>` → signToken, `#/req/<token>` → viewToken; HashRoute + parseHash + ROUTES.sign/req). page.tsx: renders `<RecipientSignView token={route.signToken}/>` / `<RequestStatusView token={route.viewToken}/>` (relative imports — @/* maps to src only). BottomTabBar keeps rendering on both (home/tools tabs reachable).

4. **tools/request-signature/recipient-view.tsx** (705) — `RecipientSignView({token})`: loading/netError/ready/signing/done/already-signed/gone(missing|expired|cancelled) states, microtask-first effects throughout. Honest Mode S card (serverBadge + serverNote, max 7 days), file card (name/size/from/message + 1s-ticker countdown via rsignTimeLeft). Step 1: existing SignatureDialog (draw/type/upload). Step 2: page select (pdf.js getPdfPageCount on the fetched blob), size slider 80–240pt, position select (br/bl/cb), LIVE preview = renderPdfThumbnail(page, maxDim 620) + emerald dashed overlay box in pdf-lib percent space. Sign & submit: dynamic `import("pdf-lib")` (keeps main chunk lean), AWAITED embedPng (logo lesson), drawRectangle border rgb(0.55,0.57,0.60) 0.75pt behind drawImage, one postSigned upload, then local-blob download button.

5. **tools/request-signature/surface.tsx** (770) — `RequestSignatureSurface` (noFile, webpage-to-pdf pattern: dashed upload zone w/ drag-drop + %PDF magic sniff ≤25MB, from input, message textarea, expiry select 24h/48h/7d, create CTA disabled with inline reason + setRunBlocked("rsign.needFile"/"rsign.needName") via effect) + after-create link cards (origin-absolute sign/status links, Copy via clipboard+execCommand fallback + toasts, expiry datetime, no-email + server honesty notes) + `RequestStatusView({token})` for `#/req/<t>` — both reuse the shared StatusSection (10s poll while pending, pending amber/signed emerald+download/cancelled/expired/missing cards, inline two-step cancel confirm calling DELETE).

6. **i18n** — tools/request-signature/i18n.json (96 keys × en/hi, natural Devanagari) + scripts/merge-request-sign-i18n.ts (99, einvoice parity: clobber refusal, required needFile/needName, source-literal cross-check, whole-catalog leaf parity). Merged: **3187 → 3334 = 3334** (+192 mine; sibling F6A merged dsig/vsig +56 concurrently — 3187+56+192=3334).

## QA evidence

- **Service curl E2E (all statuses correct)**: health 200 `{ok:true}` → create (qa-structure-fixture.pdf, 24h) → tokens issued → meta via BOTH tokens (pending, no token leakage) → pdf 200 inline %PDF- → result-before-sign 404 → sign 200 `{ok:true,status:"signed"}` → meta shows signed → double-sign 409 alreadySigned → result 200 attachment qa-structure-fixture-signed.pdf → result with signToken 404 (role check) → DELETE 200 cancelled → meta "cancelled" → pdf 404 (wiped) → sign 410 rsign.cancelled → DELETE again 200 (idempotent) → bad hours 400 / non-PDF 415 (magic) / unknown token 404 / missing from 400 → sweeper verified live (meta expiresAt doctored to past → folder deleted ~16s later, meta 404). **Gateway E2E via :81 with XTransformPort=3032: create+meta+health+delete all work** (the real user path).
- tsc --noEmit → 0 (one transient sibling digital-signature error appeared mid-flight and was fixed by that agent; my files never errored). lint → 0 problems.
- dev.log clean, `/` compiles 200. Service still running + /health 200 at handoff.

## Deviations / notes for wiring

- Draft restore is SILENT (from/message prefilled from "dp_rsign") — no restore banner; two text fields, nothing to clobber, and these views only mount client-side (hash routes never SSR) so no hydration risk.
- Cancel keeps meta.json (status:"cancelled", bytes wiped immediately) so both sides see an honest cancelled state until the sweeper deletes the folder at expiry.
- pdf-lib is dynamically imported in the recipient submit handler (chunk hygiene); page-count/preview use the app's pdf.js thumbnail helpers (getPdfPageCount/renderPdfThumbnail/getPdfPagePixelSize) instead of pdf-lib.load — same engine the rest of the app uses, keeps parse cost at one doc.
- Wiring needed: registry + configs (mode "S", noFile, minFiles 0, howKeys NOT in my namespace — orchestrator's config copy) + surfaces (RequestSignatureSurface). Option keys: none. Registry i18n sections already merged (rsign).
- pki smoke scripts (smoke-p9-f6a/f6ui) and tools/digital-signature + tools/verify-pdf-signatures appeared DURING this task — sibling agent's concurrent work, untouched by me.
