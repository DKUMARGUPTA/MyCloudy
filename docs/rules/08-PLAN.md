# 08 · Plan (Roadmap & Current Priorities)

Status snapshot: R27 shipped the accounting module (double-entry books,
GST invoicing, reports, admin console /accounting) + billing research
doc (16-BILLING-RESEARCH.md — PROPOSAL, awaiting owner decisions).
R26 complete: account + billing surface. R25: e-invoice rotation 5/5.
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
| R24 /hi URL-wins + P7-c i18n VLM battery (8 screenshots + 5 VLM checks) | shipped |
| R25 e-invoice browser QA rotation COMPLETE 5/5 (create-electronic-invoice, xml-invoice-to-pdf, validate-e-invoice, pdf-to-e-invoice Path A+B, +5th spot-check) | shipped |
| R25 R19 P3 backlog CLOSED with live evidence: handleSign O_EXCL lock (parallel sign race → one 200 + one 409), envelope sweeper (expired + 6h orphan both swept), SDK abort (R21, smoke-ai-config 17/17) | verified |
| R26 Phase-10 account + billing surface: /account view (profile, plan, billing history, password change, self-delete), PricingModal v2 (Free vs Pro, monthly/yearly, INR+USD), /api/billing stub APIs (checkout/confirm/cancel/status) with honest billingNotConfigured 503 + BILLING_DEMO sandbox mode, bottom-tab Account tab, account-menu settings item; smoke-billing 125/125 | shipped |
| R27 accounting module: double-entry books for the business (Account/JournalEntry/JournalLine/Invoice models, posting engine with balance validation, accrual recognition 1/12-per-month catch-up safe, refund reversals, GST 18% tax-inclusive split CGST+SGST/IGST, USD exports zero-rated, sequential DP-INV invoices backfilling Payment.invoiceNo), idempotent sync sweep, admin console /accounting (5 tabs EN/हिंदी: overview stats + journal with expandable rows + manual-entry dialog + chart + invoices + 4 reports + CSV exports), audit-logged, browser-verified (TB/BS balanced, sync idempotent, refund reversal, 403 gating) | shipped |
| R27 billing research: competitor pricing landscape (iLovePDF/Smallpdf/Sejda/Adobe/Soda/pdfFiller), 50%-below rule analysis, free-vs-pro feature matrix proposal, limit-check system design (3 enforcement layers) — docs/rules/16-BILLING-RESEARCH.md, DISCUSSION ONLY (owner: "abhi implement nahi karna") | delivered for review |

## 🔜 Next (priority order)

1. **Phase-10 Accounts + Pro — continue** — R26 shipped the account
   surface + billing stubs (checkout honest 503 until providers are
   configured). Remaining: owner decisions on 16-BILLING-RESEARCH.md
   (prices, free limits, SKUs), real Razorpay/Stripe wiring (owner keys),
   account polish (name edit), Turso, then Phase-11.
2. **Billing decisions (owner)** — answer the 7 open questions in
   16-BILLING-RESEARCH.md §7 (yearly ₹1,499 vs ₹1,999, 7-day pass,
   free limits 25 tasks/100MB, GST-inclusive display, provider keys,
   grandfathering). NOTHING ships until then.
3. **Turso production DB** — swap datasource; graceful-degrade already
   proven; keep table names identical.
4. **Phase-11 services/worker** — server-side LibreOffice (266-format gap,
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
