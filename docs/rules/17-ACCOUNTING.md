# 17 · Accounting Module (R27 — shipped)

Owner directive (2026-02): "accounting ek bada module hai — ispar pehle
kaam karo, research karo phir implement." Researched (double-entry
standards, India GST/OIDAR rules for SaaS) then implemented as an
admin-only console at **/accounting**.

## What it is

Double-entry books for the **DocoPDF business itself** — not a user tool:
- **Journal** (`journal_entries` + `journal_lines`): immutable entries,
  Σdebits == Σcredits enforced in `src/lib/accounting/post.ts` BEFORE
  insert. Corrections are reversing entries, never edits.
- **Chart of accounts** (`accounts`): seeded, idempotent
  (`ensureChartSeeded`), stable codes 1200/2100/2200/3100/4100/…5000s.
- **Invoices** (`invoices`): one GST tax invoice per paid payment,
  sequential `DP-INV-000001…`, INR domestic (CGST+SGST or IGST,
  tax-inclusive split) and USD exports (zero-rated).
- **Reports**: trial balance, P&L, balance sheet (all journal-derived),
  GST summary (invoice-derived, GSTR-1 style), CSV exports
  (Tally-friendly column order).

## Posting rules (the core model)

```
Payment paid (INR, tax-inclusive 18%):     Payment paid (USD, export):
  Dr 1200 Gateway Clearing  total            Dr 1200 Gateway Clearing  ₹conv
  Cr 2200 Deferred Revenue  taxable          Cr 2200 Deferred Revenue  ₹conv
  Cr 2100 GST Payable       tax

Monthly plan → recognize ALL immediately:  Yearly plan → 1/12 per month:
  Dr 2200 Deferred Revenue                   Dr 2200 Deferred Revenue
  Cr 4100 Subscription Revenue               Cr 4100 Subscription Revenue

Refund → mirror-reverse receipt + recognition entries, invoice → refunded
```

Books base currency: **INR paise**. USD converts at SiteSetting
`acct.usdToInr` (default 83.00) with the USD amount kept in the memo.

## Revenue recognition (accrual, catch-up safe)

`recognizeForPayment` computes the target = taxable × monthsElapsed/12
(whole calendar months; monthly plans = 12/12 at once), subtracts what was
already recognized (sum of recognition debits for that payment), and posts
only the delta. Lapsed sweep runs catch up; re-runs never double-post.

## Sync sweep (`runAccountingSync`)

Idempotent, admin-triggered (`POST /api/admin/accounting/sync`) and
webhook-ready: seeds chart → posts receipts for unposted paid payments →
issues missing invoices (backfills `Payment.invoiceNo`) → recognition →
refund reversals. All lookups keyed on `source`+`sourceRef`.

**R28 fix — payment → its OWN subscription:** recognition maps each
payment to the latest subscription of that user created **at-or-before the
payment** (checkout writes sub→payment; QA seeds use equal timestamps) —
NOT a user-level "latest plan" map, which mis-treated a yearly payment as
a 7-day pass (full recognition instead of 1/12) when one user holds
multiple subscription rows (yearly then week pass). The 7-day pass SKU
(R28) recognizes fully at payment time, like monthly — a pass never spans
a month boundary.

## Config (SiteSetting keys, defaults in parens)

- `acct.gstRatePercent` (18) — SaaS GST rate
- `acct.taxInclusive` (1) — INR B2C display convention
- `acct.inrTaxType` (cgst_sgst) — domestic split
- `acct.usdToInr` (83) — export conversion rate

## API surface (all `gateAdmin` JSON)

`GET/POST /api/admin/accounting/journal` · `GET …/accounts` ·
`GET …/invoices` · `GET …/overview` · `GET …/reports?type=` ·
`POST …/sync` · `GET …/export?type=journal|invoices|trial_balance|gst` (CSV)

## UI

SPA route `accounting` (real path /accounting, noindex SSR shell
`src/app/accounting/page.tsx`), entry points: account-menu item (admins)
+ account-page shortcut. Tabs: Overview (stat cards + recent entries +
sync), Journal (paginated + balanced manual-entry dialog), Accounts,
Invoices, Reports (4 reports + date range + CSV). i18n: `accounting.*`
EN/हिंदी.

## Privacy rule compliance

Money metadata only — amounts, invoice numbers, emails already in the
billing tables. No file names, no file contents, ever.

## Future (not built)

Razorpay/Stripe webhook auto-sync (owner keys), Tally XML export,
e-invoice (IRN) integration, expense receipts attachment, accounting
periods lock. All tracked in 08-PLAN.
