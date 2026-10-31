# 16 · Billing Research & Pricing Strategy (DECIDED — R28)

> Status: **DECIDED + implemented (R28, 2026-10-31).** Owner directive (R27):
> "market ke jitne bhi competitor hai un sab se hum 50% niche rahenge price
> mai. Abhi implement nahi karna hai — pehle discuss karte hain."
> R28 follow-up: "tum hi in sabhi sawal ka jawab deep research kar ke do,
> mai fresher hun — Aapke 7 decisions chahiye." Decisions below are the
> answer; what shipped in R28 is marked ✅. Checkout still answers the
> honest 503 `billingNotConfigured` until real provider keys land (D6).

## 1. Competitor price landscape (re-verified live, R28)

Anchor rule unchanged: our reference is the **cheapest credible competitor**,
because "50% below ALL competitors" is only meaningful against the market floor.

| Competitor | Free tier reality | Pro monthly | Pro yearly | Verified |
|---|---|---|---|---|
| **iLovePDF** (price floor) | limited tasks, limited file size | **$4** (₹399 India store) | **$47** (~₹3,000 India-visible / ~₹4,000 FX) | ✅ live (R28) |
| **PDF Candy** | page/hourly restrictions, limited size | $6 web | $48 ($4/mo yearly + $99 lifetime SKU) | ✅ live (R28) |
| **Sejda** | 3 tasks/day, 50MB, 200 pages | $7.50 (**week pass $5/7d**) | ~$60 | snapshot Feb 2026 (ASN-blocked R28) |
| **Soda PDF** | limited free | $6.75+ | ~$81 | snapshot Feb 2026 |
| **pdfFiller** | trial only | $8+ | ~$96 | snapshot Feb 2026 |
| **Smallpdf** | daily download limit (~2/day) | $9 | $108 | ✅ live (R28) |
| **Adobe Acrobat** | token online free | $14.99–19.99 | $179–239 | snapshot Feb 2026 |

Key reads (unchanged): competitors' free tiers are tight (2–3 tasks/day);
our client-side processing (97/100 tools on-device) makes our marginal cost
per free task ≈ zero, so the most generous free tier in the market is
affordable — the upgrade argument is won on limits, not tool gating.

## 2. Our prices under the "50% below everyone" rule (DECIDED)

| Plan | iLovePDF floor | Our DECIDED price | vs floor | Shipped R28 |
|---|---|---|---|---|
| Pro Monthly INR | ₹399 (India store) | **₹199** | 49.9% | ✅ (unchanged) |
| Pro Yearly INR | ~₹3,000 India-visible | **₹1,499** (₹125/mo) | 50.0% | ✅ (was ₹1,999 stub) |
| Pro Monthly USD | $4 | **$1.99** | 49.75% | ✅ (was $2.49) |
| Pro Yearly USD | $47 | **$22.99** ($1.92/mo) | 48.9% | ✅ (was $23.99) |
| 7-day pass INR | Sejda $5 (~₹420) | **₹49** one-time | 11.7% | ✅ NEW SKU |
| 7-day pass USD | Sejda $5 | **$0.99** one-time | 19.8% | ✅ NEW SKU |

Every number is ≤50% of the cheapest price an Indian user can see for that
SKU (India-store INR and web USD both) — the "half the price of iLovePDF"
claim is now literally true in every currency.

## 3. Free vs Pro feature matrix (DECIDED)

Principle: free stays genuinely useful; Pro sells *scale*, not basics.

| Capability | FREE | PRO (₹199/mo · ₹1,499/yr · ₹49/7d) |
|---|---|---|
| Tools available | all 97 (no tool is Pro-locked) | all + new server tools first |
| Tasks per day | **25** (market: 2–3) — *shadow mode until payments launch* | unlimited (fair-use 1,000/day) |
| Max file size | **50MB mobile / 200MB desktop** (current caps KEPT — see D4) | 2GB when server tools land (Phase-11) |
| Batch files per run | 5 | 100 |
| Watermark on output | none (never) | none |
| Cloud history | 7 days | 90 days (future) |

## 4. Limit-check system (as built, R28)

Three enforcement layers, cost-proportional:

1. **UX pre-check (client, all tools)** — `GET /api/limits?anonId=<localStorage
   id>` returns `{ plan, usedToday, maxToday, remaining, hard }`.
   Counters: `AnonUsage` (per anonId+day, **successful runs only** — the
   /api/usage route now skips the quota upsert on failed runs). At ≥80%
   (20/25): one-time-per-day soft nudge toast → pricing modal. At 100% with
   `hard:true`: run is blocked with an upsell (dormant until keys land).
2. **Server hard-check (server-cost tools only, future)** — OCR/office-convert/
   e-sign/AI routes will enforce limits authoritatively when they gain
   server-side quota needs (Phase-11 wiring).
3. **Anti-abuse (all)** — IP rate-limits (live) + the Pro fair-use 1,000/day
   ceiling so a single account can't run an OCR farm on ₹199.

**Shadow mode:** `hard` flips true automatically the moment
`RAZORPAY_KEY_ID` or `STRIPE_SECRET_KEY` is present in the environment —
limits and payments go live together, never limits-before-payments.
Known limitation (accepted): counting is per-browser anonId, not per
account — the privacy-preserving choice per PRD §14 (no user id in usage
data).

## 5. Payment plumbing

- Razorpay (INR + UPI) and Stripe (USD). `PRO_PLANS` in
  `src/lib/billing/plans.ts` is the single price source — R28 flipped the
  yearly/USD numbers and added the 7-day pass; the whole funnel followed.
- Checkout stubs stay honest-503 until keys land on Vercel (by design).
- Webhook → Payment row → accounting auto-post (17-ACCOUNTING.md). The
  7-day pass posts like a monthly plan: **full immediate recognition** (a
  7-day pass never spans a month boundary), GST split as usual.

## 6. GST (India, primary market)

SaaS = 18% GST. B2C convention: **tax-inclusive display** (confirmed D5) —
"₹1,499 incl. of GST" (taxable ₹1,268.64 + GST ₹230.36). Same for ₹199
(₹168.64 + ₹30.36) and ₹49 (₹41.53 + ₹7.47). Exports (USD via Stripe) are
zero-rated. The pricing modal carries the inclusive note; the accounting
module books the split.

## 7. THE 7 DECISIONS (R28 — delegated by owner, research-backed)

**D1. Yearly INR: ₹1,499 — the ₹1,999 stub is dropped.**
₹1,999 is 50% of only the FX-converted web price (~₹4,000); it is 67% of the
~₹3,000 India-visible price, which breaks the "half the price" claim for
Indian users. ₹1,499 is exactly 50% of ₹3,000 and 37% of ₹4,000 — the only
number that keeps the marketing identity true at every price point a user
can see. ₹125/mo effective is a strong anchor and the 37% yearly discount
pushes the LTV plan. USD aligned to the same rule: $1.99/mo, $22.99/yr.

**D2. YES — 7-day pass at ₹49 / $0.99.**
Sejda's $5 week pass proves the SKU works for one-off users. ₹49 is
impulse-zone pricing that captures users who will never subscribe (4× ₹49/wk
≈ monthly price, so it cannibalizes nothing). Accounting recognizes it
immediately; invoices carry the GST split.

**D3. Free daily limit: 25 successful tasks/day — enforcement ships WITH
payment keys, not before.**
25/day is 10x the market floor and covers essentially every legitimate
user; the 26+ power user is exactly the Pro candidate. A hard cap with no
payment path (checkout is 503 today) is pure frustration, so the counter +
`/api/limits` + the 80% nudge run in **shadow mode** now (real usage data,
zero lockouts) and the hard gate auto-activates when provider keys land.
Pro fair-use ceiling 1,000/day.

**D4. Free file cap: KEEP the current 50MB mobile / 200MB desktop.**
The proposed 100MB would be a *regression* — current caps are already 13x
iLovePDF's free ~15MB, and Mode-D files never touch our servers (marginal
cost ≈ 0). File size is a weak upgrade lever (most PDFs < 50MB); Pro's 2GB
becomes the advertised perk when server-side tools (Phase-11) make it real.

**D5. GST-inclusive display: CONFIRMED.**
Indian B2C display convention: the price shown is the price charged.
"₹199 incl. 18% GST" and charging exactly ₹199 builds trust and avoids
checkout surprises. USD (Stripe) = zero-rated export, no GST.

**D6. Razorpay/Stripe keys: AT LAUNCH (DocoPDF.com attach), not before.**
Checkout stays honest-503 until then — zero fake payments, BILLING_DEMO
sandbox keeps the flow testable. Doing KYC once at launch beats maintaining
live payment mid-build with no traffic. Owner checklist (exact Vercel env):
`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` + `RAZORPAY_WEBHOOK_SECRET`
(INR/UPI) and `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (USD). The day
any key lands, free-tier limits activate automatically (D3).

**D7. Grandfathering: demo-pro users keep Pro until periodEnd, then Free.**
Beta testers earned their granted period (goodwill); nobody gets a lifetime
freebie (revenue leak). Every demo subscription already carries a periodEnd;
a sweep at provider-wiring flips expired demo subs to free. No harsh reset.

---
*Decision record: R28 session, delegated by owner ("tum hi jawab do, mai
fresher hun"). Live price verification: iLovePDF/PDF Candy/Smallpdf browsed
R28; Sejda/Soda/pdfFiller/Adobe from the Feb 2026 snapshot (Sejda ASN-blocks
the sandbox). Prices are a snapshot — re-verify before any future change.*
