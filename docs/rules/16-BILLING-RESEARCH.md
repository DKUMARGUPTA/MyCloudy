# 16 · Billing Research & Pricing Strategy (DISCUSSION ONLY — NOT IMPLEMENTED)

> Status: **PROPOSAL — awaiting owner sign-off.** Owner directive (R27 session,
> 2026-02): "market ke jitne bhi competitor hai un sab se hum 50% niche rahenge
> price mai. Abhi implement nahi karna hai — pehle discuss karte hain: kaise
> kaam karega, limit check, free vs pro features."
>
> Nothing in this document has been wired into the running product. The
> billing surface that IS live (PricingModal v2, /api/billing/* stubs,
> BILLING_DEMO sandbox) remains untouched at its R26 prices until the owner
> approves a change.

## 1. Competitor price landscape (web-verified, Feb 2026)

Prices move; this is the snapshot the strategy is anchored on. The rule that
matters: **our anchor is the CHEAPEST credible competitor**, because "50%
below ALL competitors" is only meaningful against the floor of the market.

| Competitor | Free tier reality | Pro monthly | Pro yearly | Effective ₹/mo (yearly) |
|---|---|---|---|---|
| **iLovePDF** (price floor) | limited daily tasks, ~15MB files | ~$4–6 (₹399 INR store) | ~$48 (~₹3,000) | ~₹250 |
| **Sejda** | 3 tasks/day, 50MB, 200 pages | $7.50 (week pass $5/7d) | ~$60 | ~₹415 |
| **PDF Candy** | several free tasks | ~$6 | ~$72 | ~₹500 |
| **Soda PDF** | limited free | $6.75+ | ~$81 | ~₹560 |
| **pdfFiller** | trial only | $8+ | ~$96 | ~₹665 |
| **Smallpdf** | **2 tasks/day** | $12 ($9 annual) | $108 | ~₹750 |
| **Adobe Acrobat** | token online free | $14.99–19.99 | $179–239 | ~₹1,300+ |

Key reads:
- Competitors' free tiers are TIGHT (2–3 tasks/day). Our client-side
  processing (97/100 tools run on-device) means our marginal cost per free
  task is ≈ zero — we can afford the most generous free tier in the market
  and still win the upgrade argument on limits, not on tool gating.
- iLovePDF is the price floor AND the free-tier generosity benchmark.

## 2. Our prices under the "50% below everyone" rule

Anchor = iLovePDF. Being 50% below iLovePDF automatically puts us 50%+ below
everyone else in the table.

| Plan | iLovePDF today | Our 50% target | Current R26 stub | Delta |
|---|---|---|---|---|
| Pro Monthly INR | ₹399 | **₹199** | ₹199 | ✅ aligned |
| Pro Yearly INR | ~₹3,000 | **₹1,499** (₹125/mo) | ₹1,999 (₹167/mo) | ⚠ stub is 67% of anchor — recommend **drop to ₹1,499** |
| Pro Monthly USD | $4–5 | **$2.49** | $2.49 | ✅ aligned |
| Pro Yearly USD | $48 | **$23.99** ($2/mo) | $23.99 | ✅ aligned |

Optional SKU to discuss: **7-day pass at ₹49 / $0.99** (Sejda sells this at
$5) — captures one-time/occasional users who never subscribe.

### Why yearly at ₹1,499 matters
The 50% rule is our marketing identity ("half the price of iLovePDF"). The
current ₹1,999 stub is only 33% off the anchor. ₹1,499 keeps the story clean:
**every plan is exactly half the market floor.**

## 3. Free vs Pro feature matrix (proposal)

Principle: **free stays genuinely useful** (privacy-first, device-side), Pro
sells *scale*, not the basics. This mirrors how the best freemium products
convert: exhaustion, not frustration.

| Capability | FREE | PRO (₹199/mo · ₹1,499/yr) |
|---|---|---|
| Tools available | all 97 (no tool is Pro-locked) | all + new tools first |
| Tasks per day | **25** (market: 2–3!) | unlimited (fair-use 1,000/day) |
| Max file size | **100MB** (iLovePDF free: 15MB) | 2GB |
| Batch files per run | 5 | 100 |
| OCR (server cost) | 10 pages/day | 500 pages/day |
| E-sign envelopes | 3/month | 100/month |
| Office-convert service | 3 files/day | unlimited (fair-use) |
| AI features (when re-enabled) | 3/day | 50/day |
| Watermark on output | none (never) | none |
| Cloud history | 7 days | 90 days (future) |

## 4. Limit-check system (how it will actually work)

Three enforcement layers, cost-proportional:

1. **UX pre-check (client, all tools)** — on tool open, `GET /api/limits`
   returns `{ plan, usedToday, maxToday }`. When the free counter crosses
   ~80%, a soft one-time "you're near today's free limit — Pro is ₹199"
   nudge (PricingModal). At 100%: upsell sheet, not a dead end.
2. **Server hard-check (server-cost tools only)** — OCR pages, office-convert,
   e-sign envelopes, AI: these call our infra (worker/:3032), so the API
   routes enforce limits authoritatively against the UsageEvent counters
   (already collected today — needs a read-back path + anon cookie id).
3. **Anti-abuse (all)** — IP rate-limits (already live) + a Pro fair-use
   ceiling so a single account can't run an OCR farm on ₹199.

Counters: reuse `AnonUsage` (guests, anonId cookie) and `UsageEvent`
(signed-in) — add a lightweight `GET /api/limits` reader; no new tables.

## 5. Payment plumbing (already half-built, needs owner keys)

- Razorpay (INR + UPI) and Stripe (USD) — `PRO_PLANS` in
  `src/lib/billing/plans.ts` is the single price source; changing two
  numbers flips the whole funnel.
- Checkout stubs are honest-503 until keys land on Vercel (by design).
- Webhook → Payment row → **accounting auto-post** (the accounting module
  shipped alongside this doc records every payment as a double-entry
  journal + GST invoice — see `17-ACCOUNTING.md`).

## 6. GST note (India, primary market)

SaaS = 18% GST. B2C convention: **tax-inclusive display** (₹199 "incl. of
GST" — taxable ₹168.64 + GST ₹30.36). Exports (USD via Stripe) are
zero-rated. The accounting module already books this split.

## 7. Open questions for the owner (blockers for implementation)

1. Yearly INR: **₹1,499** (strict 50% rule) or keep ₹1,999?
2. Add the ₹49 7-day pass SKU?
3. Free daily limit 25 tasks — comfortable? (10x the market floor)
4. Free file cap 100MB — comfortable? (6.6x iLovePDF)
5. GST-inclusive display confirmed?
6. Razorpay/Stripe keys — when? (checkout stays 503 until then)
7. Grandfathering: existing demo-pro users keep pro or reset on launch?

**Nothing above goes live until each point is answered. This file is the
discussion artifact, not a spec for silent changes.**
