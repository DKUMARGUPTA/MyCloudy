/**
 * Pro plan catalog (Phase-10 R26; prices DECIDED R28 per
 * docs/rules/16-BILLING-RESEARCH.md §7) — the single source of truth shared
 * by the billing API routes (server: charge amounts, period days) and the
 * pricing modal (client: display). Pure data, no server imports, safe to
 * bundle client-side.
 *
 * Pricing identity: every SKU is ≤50% of the cheapest credible competitor
 * (anchor iLovePDF) at every price point a user can see — INR (India store
 * visible) and USD (web) alike:
 *   monthly ₹199 vs ₹399 · yearly ₹1,499 vs ~₹3,000 · pass ₹49 vs Sejda $5
 *   monthly $1.99 vs $4 · yearly $22.99 vs $47 · pass $0.99 vs $5
 *
 * Amounts are MINOR UNITS (paise / cents) matching the Payment model's
 * `amount Int` contract. Display prices are GST-INCLUSIVE (18%, India B2C
 * convention — decision D5); the accounting module books the tax split.
 * Checkout without configured providers stays honestly 503 (decision D6).
 */

export type ProPlanId = "pro_monthly" | "pro_yearly" | "pro_week";

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
    priceUsd: 1.99,
    amountInrMinor: 19900,
    amountUsdMinor: 199,
  },
  pro_yearly: {
    id: "pro_yearly",
    periodDays: 365,
    priceInr: 1499,
    priceUsd: 22.99,
    amountInrMinor: 149900,
    amountUsdMinor: 2299,
  },
  /* 7-day pass (decision D2): one-time entry SKU for occasional users —
   * Sejda sells this at $5; ₹49/$0.99 keeps the below-everyone rule. */
  pro_week: {
    id: "pro_week",
    periodDays: 7,
    priceInr: 49,
    priceUsd: 0.99,
    amountInrMinor: 4900,
    amountUsdMinor: 99,
  },
};

export function isProPlanId(id: string): id is ProPlanId {
  return id === "pro_monthly" || id === "pro_yearly" || id === "pro_week";
}

/* ------------------------------------------------------------------ */
/* Free-tier daily limits (decision D3) — shadow mode until keys land. */
/* ------------------------------------------------------------------ */

/** Successful tool runs per day on the Free plan (market floor: 2–3). */
export const FREE_DAILY_TASKS = 25;
/** Pro fair-use ceiling — anti-abuse, not a real user constraint. */
export const PRO_DAILY_TASKS = 1000;

/**
 * Hard limit enforcement is ACTIVE only when a real payment provider is
 * configured. Until then the counter runs in shadow mode (data + soft
 * nudges, never a block) — limits and payments go live together (D3+D6).
 */
export function billingLimitsActive(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID) || Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Demo mode: checkout + confirm flow works end-to-end without real
 * payment providers (sandbox / review builds). Production leaves
 * BILLING_DEMO unset → /api/billing/checkout answers the honest
 * billingNotConfigured 503 instead. */
export function billingDemoMode(): boolean {
  return process.env.BILLING_DEMO === "1";
}
