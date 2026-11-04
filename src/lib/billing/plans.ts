/**
 * Pro plan catalog (Phase-10 R26) — the single source of truth shared by
 * the billing API routes (server: charge amounts, period days) and the
 * pricing modal (client: display). Pure data, no server imports, safe to
 * bundle client-side.
 *
 * PRD §Pricing: INR (UPI/cards via Razorpay) and USD (Stripe) side by
 * side. Amounts are MINOR UNITS (paise / cents) matching the Payment
 * model's `amount Int` contract. Prices are display-stub values until
 * the payment providers go live (Razorpay/Stripe keys on Vercel) —
 * checkout without configured providers stays honestly 503.
 */

export type ProPlanId = "pro_monthly" | "pro_yearly";

export interface ProPlanDef {
  id: ProPlanId;
  /** Billing period in days (used for the demo-mode periodEnd). */
  periodDays: number;
  /** Display price, major units — INR first (primary market). */
  priceInr: number;
  priceUsd: number;
  /** Minor units for the Payment row (paise / cents). */
  amountInrMinor: number;
  amountUsdMinor: number;
}

export const PRO_PLANS: Record<ProPlanId, ProPlanDef> = {
  pro_monthly: {
    id: "pro_monthly",
    periodDays: 30,
    priceInr: 199,
    priceUsd: 2.49,
    amountInrMinor: 19900,
    amountUsdMinor: 249,
  },
  pro_yearly: {
    id: "pro_yearly",
    periodDays: 365,
    priceInr: 1999,
    priceUsd: 23.99,
    amountInrMinor: 199900,
    amountUsdMinor: 2399,
  },
};

export function isProPlanId(id: string): id is ProPlanId {
  return id === "pro_monthly" || id === "pro_yearly";
}

/** Demo mode: checkout + confirm flow works end-to-end without real
 * payment providers (sandbox / review builds). Production leaves
 * BILLING_DEMO unset → /api/billing/checkout answers the honest
 * billingNotConfigured 503 instead. */
export function billingDemoMode(): boolean {
  return process.env.BILLING_DEMO === "1";
}

/* ─── Free-tier daily task limits (R28, billing-research D3) ─────────
 *
 * D3: 25 successful tasks/day for free (10× the market floor, covers
 * every legitimate user), 1,000/day Pro fair-use ceiling. The counter +
 * /api/limits + the 80% nudge run in SHADOW MODE while no payment
 * provider is configured — never a block before checkout exists. The
 * hard gate auto-activates the moment provider keys land. */

/** Free-tier daily limit of successful tool runs. */
export const FREE_DAILY_TASKS = 25;

/** Pro fair-use daily ceiling (D3). */
export const PRO_DAILY_TASKS = 1_000;

/** Hard enforcement is live only when a payment provider is configured —
 * limits and payments always ship together, never limits-first. */
export function billingLimitsActive(): boolean {
  return Boolean(
    process.env.RAZORPAY_KEY_ID || process.env.STRIPE_SECRET_KEY
  );
}
