# 08 · Plan (Roadmap & Current Priorities)

Status snapshot: R19 complete (audit + 5 phases shipped & prod-verified).
Update this file whenever a phase lands.

## ✅ Done (do not redo)

| Item | State |
|------|-------|
| 100/100 tools LIVE on own engine (P6-a…z + P6-END) | shipped |
| Editor family (edit/annotate/text+F&R/forms/mobile) | complete 6/6 |
| SEO layer P7: real-path routes, sitemap 116 URLs, JSON-LD, OG, /hi mirrors | shipped |
| GA4 go-live + taxonomy r2; GSC webmaster guide (`docs/seo/`) | shipped |
| PWA installable manifest + offline shell | shipped |
| R19 audit (0×P0) + Phases 1–5: i18n plurals, 404 rebrand, aria-labels, offline.html, SSRF/rate-limit/caps hardening, JSON 500 contract, dead-code purge, /hi FAQ JSON-LD, SSR locale links | shipped & prod-verified |
| Governance rules system (`AGENTS.md` + `docs/rules/`) | shipped |
| R21 production AI fix: env-first adapter (`src/lib/ai/zai-client.ts`), aiNotConfigured 503 + honest i18n, AbortSignal deadlines; sandbox golden paths re-verified | shipped (public provider key = owner action, see 13-INTEGRATIONS) |

## 🔜 Next (priority order)

1. **P7-c i18n VLM battery** — EN+HI screenshots → VLM skill visual
   verification of language rendering (extends `14-TESTING.md`).
2. **E-invoice browser QA rotation** — 5 LIVE e-inv tools; one golden-path
   E2E per session until all covered.
3. **R19 post-audit P3 backlog** — session-call placement sweep is done;
   remaining P3s: handleSign atomic-lock upstream, SDK abort signals,
   envelope-store scan cadence (tracked in worklog R19 entry).
4. **Phase-10 Accounts + Pro** — request-signature Pro gating, plan checks
   against `users.plan`, Razorpay/Stripe stubs per PRD §2.5.
5. **Turso production DB** — swap datasource; graceful-degrade already
   proven; keep table names identical.
6. **Phase-11 services/worker** — server-side LibreOffice (266-format gap,
   Filee comparison positioning).

## ⏸ Deferred (owner decisions pending)

- **AI features — chat/summarize/translate tools (owner order R23,
  2025-10-30: "ye wala features abhi nahi dena hai, future plan karenge").**
  The 3 AI tools are `enabled: false` (phase P3) + R22 warning UI removed;
  API routes retained (honest 503 `aiNotConfigured`), registry keeps
  `aiDependent` flags + `AI_DEPENDENT_TOOLS` for the re-enable round.
  **Re-enable plan (future):** (1) owner sets `AI_BASE_URL`+`AI_API_KEY`+
  `AI_MODEL` on Vercel (any OpenAI-compatible provider, see
  13-INTEGRATIONS §AI provider); (2) verify `/api/summarize` answers on
  prod; (3) flip `enabled: true` on the 3 tools (keep `aiDependent` so the
  warning UI can be restored from commit 049e7c6 while stabilising);
  (4) sitemap/SSR pages come back automatically; (5) re-submit sitemap in
  GSC (3 URLs dropped out when deferred).
- docopdf.com final-domain attach steps beyond current DNS (done), HSTS
  preload submission, Vercel SSO/protection review.
- Legal/pricing page copy sign-off (needs lawyer review per PRD).

## 🌐 Webmaster-side (owner actions, tracked in docs/seo/WEBMASTER-GUIDE.md)

GSC sitemap resubmit + index requests · Bing IndexNow · GA4 admin config ·
backlink seeding.

## Definition of "phase complete"

Code pushed + Vercel READY + prod spot-check green + worklog + CONTEXT-MEMORY
+ rules docs updated. Half-shipped phases must be recorded as in-progress.
