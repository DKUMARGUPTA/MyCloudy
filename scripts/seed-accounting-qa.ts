/**
 * QA seed for the accounting console (R27) — sandbox/demo data ONLY.
 *
 * Creates:
 *   - the admin account (araj.dkg@gmail.com / Docopdf@2026) if missing
 *   - three customers with paid payments across INR/USD, monthly/yearly,
 *     spread over the past months (exercises the recognition sweep)
 *   - one refunded payment
 *   - active subscriptions for MRR
 *
 * Idempotent: re-running keeps existing rows and only adds what's missing.
 * The accounting sync itself is NOT run here — run it from the console
 * (Sync button) or POST /api/admin/accounting/sync to exercise that path.
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { PRO_PLANS } from "../src/lib/billing/plans";

const DAYS = 86_400_000;

async function upsertUser(email: string, name: string, opts: { admin?: boolean; plan?: string } = {}) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({
    data: {
      email,
      name,
      passwordHash: hashPassword("Docopdf@2026"),
      role: opts.admin ? "admin" : "user",
      plan: opts.plan ?? "free",
    },
  });
}

async function seed() {
  const admin = await upsertUser("araj.dkg@gmail.com", "DocoPDF Owner", { admin: true });
  console.log("admin ready:", admin.email, admin.role);

  const customerA = await upsertUser("asha@example.com", "Asha Verma", { plan: "pro" });
  const customerB = await upsertUser("bharat@example.com", "Bharat Singh", { plan: "pro" });
  const customerC = await upsertUser("carol@example.com", "Carol Diaz", { plan: "pro" });
  const customerD = await upsertUser("dev@example.com", "Dev Patel");

  /* Paid payments — only when the user has none yet. */
  const paymentCount = await db.payment.count();
  if (paymentCount === 0) {
    const rows: Array<{
      userId: string; amount: number; currency: string; plan: "pro_monthly" | "pro_yearly";
      daysAgo: number; status?: string;
    }> = [
      { userId: customerA.id, amount: PRO_PLANS.pro_monthly.amountInrMinor, currency: "INR", plan: "pro_monthly", daysAgo: 95 },
      { userId: customerA.id, amount: PRO_PLANS.pro_monthly.amountInrMinor, currency: "INR", plan: "pro_monthly", daysAgo: 65 },
      { userId: customerA.id, amount: PRO_PLANS.pro_monthly.amountInrMinor, currency: "INR", plan: "pro_monthly", daysAgo: 35 },
      { userId: customerA.id, amount: PRO_PLANS.pro_monthly.amountInrMinor, currency: "INR", plan: "pro_monthly", daysAgo: 5 },
      { userId: customerB.id, amount: PRO_PLANS.pro_yearly.amountInrMinor, currency: "INR", plan: "pro_yearly", daysAgo: 150 },
      { userId: customerB.id, amount: PRO_PLANS.pro_yearly.amountInrMinor, currency: "INR", plan: "pro_yearly", daysAgo: 20 },
      { userId: customerC.id, amount: PRO_PLANS.pro_yearly.amountUsdMinor, currency: "USD", plan: "pro_yearly", daysAgo: 70 },
      { userId: customerD.id, amount: PRO_PLANS.pro_monthly.amountInrMinor, currency: "INR", plan: "pro_monthly", daysAgo: 12, status: "refunded" },
    ];

    for (const row of rows) {
      const createdAt = new Date(Date.now() - row.daysAgo * DAYS);
      const payment = await db.payment.create({
        data: {
          userId: row.userId,
          amount: row.amount,
          currency: row.currency,
          status: row.status ?? "paid",
          createdAt,
        },
      });
      await db.subscription.create({
        data: {
          userId: row.userId,
          provider: "razorpay",
          plan: row.plan,
          status: row.status === "refunded" ? "cancelled" : "active",
          periodEnd: row.status === "refunded" ? null : new Date(createdAt.getTime() + PRO_PLANS[row.plan].periodDays * DAYS),
          createdAt,
        },
      });
      console.log("seeded", row.plan, row.currency, row.status ?? "paid", row.daysAgo + "d ago");
    }
  } else {
    console.log("payments already present:", paymentCount);
  }

  /* Sanity read-back. */
  console.log("users:", await db.user.count());
  console.log("payments:", await db.payment.count());
  console.log("subscriptions:", await db.subscription.count());
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
