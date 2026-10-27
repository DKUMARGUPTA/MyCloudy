# Task P9-F6A-UI — digital-signature (#95) + verify-pdf-signatures (#97) tool UI layer

Full detail lives in `/home/z/my-project/worklog.md` (P9-F6A-UI entry, appended last).
Crypto core: `tools/pki-common/` (P9-F6A-CRYPTO entry — read its pinned gotchas first).

## What was built (files + line counts)

| File | Lines | Notes |
|---|---|---|
| `tools/digital-signature/p12-store.ts` | 80 | logo-store pattern (subscribe/get/set/clear + change-notify). Entry `{ file: File \| null, cert: P12CertSummary \| null }`; P12CertSummary `{ cn, org?, validTo (ISO), keyKind ("RSA"/"ECDSA P-256"/"ECDSA P-384"/string), serial (hex) }`. SECURITY: the password NEVER enters the store — surface state only, rides the run as the transient "pw" option. `getP12File()` feeds `config.collectAssets`. |
| `tools/digital-signature/config.ts` | 81 | toolId `digital-signature`, `createWorker → ./worker.ts` (module), outputKind "pdf", 1/1 files, howKeys `dsig.how1-3`, chains `[verify-pdf-signatures, lock-pdf, view-pdf]`, `options: []` (surface owns everything), 5 bilingual honest features + 3 bilingual FAQ (p12 sources; what Adobe shows; IT Act 2000 honesty). |
| `tools/digital-signature/worker.ts` | 179 | validate-e-invoice shape. **Exported pure helpers (smoke-pinned)**: `parseSignOptions(options)` → `{ password, reason≤200, location≤120, visible (stamp==="1"), page≥1 floor, name≤60, locale ("hi" only) }`; `p12ErrorDetail(code)` → honest "sign: …" lines for all 6 P12Error codes. Asset `request.assets[0]` missing → honest error "choose a certificate (.pfx/.p12) first". Calls `signPdf` with the visible stamp from options. Output `base + "-signed.pdf"`; detail `{ files: 1, pages, signer }` via local `RunDetail & { signer?: string }`. |
| `tools/digital-signature/surface.tsx` | 799 | e-invoice surface architecture. Sections: PDF status card → draft banner (`dp_dsig`: reason/location/name/stamp/page ONLY — never the password) → certificate (hidden `.p12/.pfx` input + password Input with eye toggle + Unlock) → cert summary card (CN prominent, org/serial-shortened/valid-to/key-kind badge, emerald valid / rose expired) → signature details (reason/location/name, name defaults to cert CN) → visible stamp (Switch + page + live bottom-right box preview) → run summary. Unlock = microtask-first async effect over an "armed" `{ file, password }` set ONLY from events (Unlock button / file pick with password typed) — `parseP12` + `parseCertificate` client-side; any password or file edit clears the unlock so the shown summary always matches the current (file, password) at run time. Option sync: pw/stamp/page event-context, reason/location/name debounced 250ms, locale via effect. `setRunBlocked`: files 0 → `dsig.needFile`; no p12/pw/cert → `dsig.needCert`. Boot rehydrates file+cert from the p12-store and password from `values.pw` (phase remounts). |
| `tools/digital-signature/i18n.json` | 104 | `{ en: { dsig }, hi: { dsig } }` — 47 keys (spec's ~34 + draft/run-card house-style labels + placeholders). Natural Hindi, project terminology (फ़ाइल, हस्ताक्षर, प्रमाणपत्र, पासवर्ड). |
| `tools/verify-pdf-signatures/config.ts` | 76 | outputKind "text", 1/1, howKeys `vsig.how1-3`, chains `[digital-signature, sign-pdf, view-pdf]`, options: [], 5 bilingual honest features + 3 FAQ (valid = crypto-only; trust unknown; tampered meaning). |
| `tools/verify-pdf-signatures/worker.ts` | 197 | validate-e-invoice report pattern. **Exported pure**: `renderReport(fileName, result)` + `summarize(found)`. Per signature: signer CN/org, ISO time, VALID/INVALID verdict, INTACT/TAMPERED prominent, per-check [PASS]/[FAIL]/[??] lines (7 check ids), honest-scope footer (no CRL/OCSP, no trust store) + Hindi verdict section. Unsigned PDF = plain finding, NOT an error. detail `{ files: 1, signatures, valid, failed }` via local `RunDetail & { signatures?: number; valid?: number }`. |
| `tools/verify-pdf-signatures/i18n.json` | 18 | vsig namespace, 4 keys (how1-3 + needFile) — deliberately minimal per spec (no surface; report text inline EN+HI in the worker). |
| `scripts/merge-signatures-i18n.ts` | 111 | merge-einvoice pattern: per-part parity, clobber refusal, required keys (how1-3 ×2 + needFile/needCert), surface dsig-literal cross-check, whole-catalog leaf parity. RUN ✅ |
| `scripts/smoke-p9-f6ui.ts` | 410 | 33 checks / 33 passed (see below). |

## Option contract for wiring (digital-signature)

`pw` (string, memory only) · `reason` (≤200) · `location` (≤120) · `name` (≤60, stamp display name) · `stamp` ("1"/"0") · `page` (number ≥1, engine clamps to the doc) · `locale` ("hi"/"en"). Asset = `getP12File()` via `collectAssets` → `request.assets[0]`.

## QA (all green)

- `bun scripts/merge-signatures-i18n.ts` → 3187 → **3238 = 3238** (+51 keys ×2: 47 dsig + 4 vsig)
- `bun scripts/smoke-p9-f6ui.ts` → **33/33**: p12-store cycle (EventTarget window polyfill in bun), option transport (full shape/defaults/clamps/caps/stamp==="1"/locale/6 error codes), real-fixture round trips through the exact option shape (RSA CN=Asha Verma, ECDSA CN=Rahul Sharma sign→verify valid; visible stamp via options; wrong password → bad-password; tamper → TAMPERED), report renderer (valid/tampered/unsigned/multi + Hindi verdict + honest scope), i18n parity + required keys + literal coverage
- `bunx tsc --noEmit` → 0 · `bun run lint` → 0/0 · dev.log clean (no compile errors)
- NOT done by design: registry/configs/surfaces wiring (orchestrator), browser E2E, dev server touch

## Gotchas pinned

1. `a ?? b || c` needs parentheses (bun AND tsc both reject) — hit in both workers/surface.
2. Bun smoke CAN import worker files (`self.onmessage` assignment is inert) — but the visible-stamp path fetches the Devanagari font from the dev server and can stall while turbopack compiles; the smoke uses a Latin stamp name (browser E2E owns the Devanagari path, per the engine's own note).
3. `@/` alias resolves in bun scripts via tsconfig paths.
