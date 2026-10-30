"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/doco/modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics/ga4";
import {
  confirmCheckout,
  openAuthModal,
  startCheckout,
  useAuth,
} from "@/lib/auth-client";
import { PRO_PLANS } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";

/**
 * PricingModal (Phase-10 R26) — the real "Get Pro" surface: Free vs Pro
 * comparison with a monthly/yearly toggle (INR first, USD alongside, per
 * the PRD pricing spec). The checkout button is HONEST by design:
 *
 *  - Guest → opens the signup modal (account needed to subscribe).
 *  - Signed-in, providers not configured (production today) → the
 *    billingNotConfigured notice: "Payments aren't live yet — nothing
 *    was charged."
 *  - BILLING_DEMO=1 (sandbox/review) → checkout + confirm complete the
 *    full activation so the plan surface is testable end-to-end.
 *
 * And the promise stays pinned: device-only tools are free forever.
 */

type Cycle = "monthly" | "yearly";

export function PricingModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("pricing.title")}
      description={t("pricing.desc")}
      contentClassName="sm:max-w-2xl"
    >
      {/* Body mounts fresh on every open — state resets naturally
       * (no setState-in-effect; the AuthModal pattern). */}
      {open ? <PricingBody onOpenChange={onOpenChange} /> : null}
    </Modal>
  );
}

function PricingBody({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();

  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [busy, setBusy] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    track("pro_open");
  }, []);

  const plan = cycle === "monthly" ? PRO_PLANS.pro_monthly : PRO_PLANS.pro_yearly;
  const isPro = user?.plan === "pro";

  const freeFeatures = [
    t("pricing.freeF1"),
    t("pricing.freeF2"),
    t("pricing.freeF3"),
    t("pricing.freeF4"),
  ];
  const proFeatures = [
    t("pricing.proF1"),
    t("pricing.proF2"),
    t("pricing.proF3"),
    t("pricing.proF4"),
    t("pricing.proF5"),
  ];

  const toastBillingError = (code: string | undefined) => {
    toast({
      title: t(`billing.err.${code ?? "server_error"}` as never),
      variant: "destructive",
    });
  };

  const handleUpgrade = async () => {
    if (busy || isPro) return;
    if (!user) {
      openAuthModal("signup");
      return;
    }
    setBusy(true);
    setNotConfigured(false);
    track("begin_checkout", { plan: plan.id });

    const checkout = await startCheckout(plan.id);
    if (!checkout.ok) {
      setBusy(false);
      if (checkout.code === "billingNotConfigured") {
        setNotConfigured(true);
        return;
      }
      toastBillingError(checkout.code);
      return;
    }

    /* Demo mode: complete the activation immediately. */
    if (checkout.mode === "demo" && checkout.subscriptionId) {
      const confirmed = await confirmCheckout(checkout.subscriptionId);
      setBusy(false);
      if (confirmed.ok) {
        track("upgrade_success", { plan: plan.id });
        onOpenChange(false);
        toast({ title: t("pricing.upgradedToast") });
        return;
      }
      toastBillingError(confirmed.code);
      return;
    }

    setBusy(false);
  };

  return (
    <>
      {/* Cycle toggle */}
      <div className="mt-2 inline-flex rounded-btn border border-border bg-muted p-1" role="group" aria-label={t("pricing.cycleLabel")}>
        {(["monthly", "yearly"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={cycle === option}
            onClick={() => setCycle(option)}
            className={cn(
              "flex min-h-9 items-center gap-2 rounded-btn px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              cycle === option
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(`pricing.${option}`)}
            {option === "yearly" ? (
              <Badge variant="pro" className="rounded-chip px-1.5 py-0 text-[10px]">
                {t("pricing.save")}
              </Badge>
            ) : null}
          </button>
        ))}
      </div>

      {/* Free vs Pro */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {/* Free */}
        <div className="rounded-card border border-border bg-background p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{t("pricing.freeName")}</p>
            <Badge variant="outline" className="rounded-chip">
              {isPro ? t("pricing.proIncludesFree") : t("pricing.currentPlan")}
            </Badge>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            ₹0
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {t("pricing.forever")}
            </span>
          </p>
          <ul className="mt-4 space-y-2">
            {freeFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
        </div>

        {/* Pro */}
        <div className="relative rounded-card border border-primary/40 bg-primary/[0.04] p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              {t("pricing.proName")}
            </p>
            {isPro ? (
              <Badge variant="pro" className="rounded-chip">
                {t("pricing.currentPlan")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            ₹{plan.priceInr.toLocaleString("en-IN")}
            <span className="text-base font-semibold text-muted-foreground"> / ${plan.priceUsd.toFixed(2)}</span>
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {cycle === "monthly" ? t("pricing.perMonth") : t("pricing.perYear")}
            </span>
          </p>
          <ul className="mt-4 space-y-2">
            {proFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>

          <Button
            type="button"
            variant="cta"
            size="touch"
            className="mt-5 w-full rounded-btn"
            disabled={busy || isPro}
            onClick={() => void handleUpgrade()}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {isPro
              ? t("pricing.proActive")
              : user
                ? t("pricing.upgradeCta")
                : t("pricing.signUpCta")}
          </Button>
          {!user ? (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {t("pricing.guestHint")}
            </p>
          ) : null}
        </div>
      </div>

      {/* Honest states */}
      {notConfigured ? (
        <div
          role="note"
          className="mt-4 flex items-start gap-3 rounded-card border border-cat-invoices/40 bg-cat-invoices/10 p-4"
        >
          <X className="mt-0.5 size-4 shrink-0 text-cat-invoices" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">
              {t("pricing.notConfiguredTitle")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("pricing.notConfiguredBody")}
            </p>
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-center text-xs text-muted-foreground">
        {t("pricing.promise")}
      </p>
    </>
  );
}
