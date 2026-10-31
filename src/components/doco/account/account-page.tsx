"use client";

import { useEffect, useState } from "react";
import {
  BookOpenCheck,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Crown,
  KeyRound,
  Loader2,
  LogIn,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/doco/modal";
import { EmptyState } from "@/components/doco/empty-state";
import { PageShell } from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics/ga4";
import { navigateToHash, ROUTES } from "@/hooks/use-hash-route";
import {
  cancelPro,
  changePassword,
  deleteAccount,
  fetchBillingStatus,
  openAuthModal,
  useAuth,
  type AuthErrorCode,
  type BillingErrorCode,
  type BillingStatus,
} from "@/lib/auth-client";

/**
 * AccountPage (Phase-10 R26) — the /account view: profile, plan & billing
 * history, password change and self-service deletion, all on the P12 APIs
 * that were waiting for a frontend. Signed-out visitors get an honest
 * sign-in prompt (PRD: no signup wall — the tools never need this page).
 */

function initialsOf(source: string): string {
  const parts = source.split(/[\s._@-]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function AccountPage({ onGetPro }: { onGetPro: () => void }) {
  const { t, locale } = useI18n();
  const { user, status } = useAuth();

  useEffect(() => {
    if (user) track("account_view", { locale });
  }, [user, locale]);

  if (status === "loading") {
    return (
      <div className="mx-auto flex w-full max-w-3xl items-center justify-center gap-2 px-4 py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t("account.loading")}</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<LogIn />}
          title={t("account.signInTitle")}
          description={t("account.signInDesc")}
          action={
            <Button
              type="button"
              size="touch"
              className="rounded-btn"
              onClick={() => openAuthModal("login")}
            >
              {t("auth.tabLogin")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <PageShell
      icon={UserRound}
      badge={t("account.badge")}
      title={t("account.title")}
      lede={t("account.lede")}
    >
      <ProfileCard />
      <PlanCard onGetPro={onGetPro} />
      <BillingHistoryCard />
      <PasswordCard />
      <DangerCard />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

function ProfileCard() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  if (!user) return null;

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="text-base">{t("account.sectionProfile")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Avatar className="size-14 border border-border">
          <AvatarFallback className="bg-primary/10 text-base font-semibold text-primary">
            {initialsOf(user.name?.trim() || user.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {user.name?.trim() || user.email}
          </p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" aria-hidden="true" />
            {t("account.memberSince", { date: formatDate(user.createdAt, locale) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* R46 logical audit: the owner carries the Owner identity, never
           * a plan-ladder badge — the ladder is a customer concept. */}
          {user.role === "admin" ? (
            <Badge
              variant="default"
              className="rounded-chip border-primary/30 bg-primary/15 text-primary"
            >
              <Crown className="size-3" aria-hidden="true" />
              {t("auth.menuOwner")}
            </Badge>
          ) : user.plan === "pro" ? (
            <Badge variant="pro" className="rounded-chip">
              <Sparkles className="size-3" aria-hidden="true" />
              {t("auth.menuPlanPro")}
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-chip">
              {t("auth.menuPlanFree")}
            </Badge>
          )}
          {user.role === "admin" ? (
            <>
              <Badge variant="outline" className="rounded-chip text-muted-foreground">
                <ShieldCheck className="size-3" aria-hidden="true" />
                {t("admin.ownerAccessChip")}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="rounded-btn"
                onClick={() => navigateToHash(ROUTES.accounting)}
              >
                <BookOpenCheck className="size-4" aria-hidden="true" />
                {t("auth.menuAccounting")}
              </Button>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Plan & billing                                                      */
/* ------------------------------------------------------------------ */

function PlanCard({ onGetPro }: { onGetPro: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void fetchBillingStatus().then((data) => {
      if (active) setBilling(data);
    });
    return () => {
      active = false;
    };
  }, [user, user?.plan]);

  if (!user) return null;
  const isOwner = user.role === "admin";
  const isPro = user.plan === "pro";

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    const res = await cancelPro();
    setCancelling(false);
    setConfirmOpen(false);
    if (res.ok) {
      track("pro_cancel");
      toast({ title: t("account.cancelledToast") });
    } else {
      toast({
        title: t(`billing.err.${res.code ?? "server_error"}` as never),
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("account.sectionPlan")}
        </CardTitle>
        <CardDescription>
          {isOwner
            ? t("account.ownerPlanDesc")
            : isPro
              ? t("account.planProDesc")
              : t("account.planFreeDesc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isOwner ? (
          /* R46: the owner already has everything — no upgrade CTA, no
           * cancel flow. A quiet full-access confirmation is all that's
           * logically honest on this card. */
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="default"
                className="rounded-chip border-primary/30 bg-primary/15 text-primary"
              >
                <Crown className="size-3" aria-hidden="true" />
                {t("auth.menuOwner")}
              </Badge>
              <Badge variant="outline" className="rounded-chip text-muted-foreground">
                <CheckCircle2 className="size-3" aria-hidden="true" />
                {t("account.ownerPlanChip")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("account.ownerPlanNote")}
            </p>
          </>
        ) : isPro ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="pro" className="rounded-chip">
                <Sparkles className="size-3" aria-hidden="true" />
                {t("auth.menuPlanPro")}
              </Badge>
              {billing?.subscription?.periodEnd ? (
                <span className="text-sm text-muted-foreground">
                  {t("account.planPeriodEnd", {
                    date: formatDate(billing.subscription.periodEnd, locale),
                  })}
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="w-full rounded-btn sm:w-auto"
              onClick={() => setConfirmOpen(true)}
            >
              {t("account.manageCancel")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="cta"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            onClick={onGetPro}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            {t("account.upgradeCta")}
          </Button>
        )}
      </CardContent>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("account.cancelConfirmTitle")}
        description={t("account.cancelConfirmBody")}
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              disabled={cancelling}
              onClick={() => setConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="rounded-btn"
              disabled={cancelling}
              onClick={() => void handleCancel()}
            >
              {cancelling ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("account.cancelConfirmCta")}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">{t("account.cancelKeepTools")}</p>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Billing history                                                     */
/* ------------------------------------------------------------------ */

const PAYMENT_STATUS_KEYS: Record<string, string> = {
  paid: "account.statusPaid",
  created: "account.statusPending",
  failed: "account.statusFailed",
  refunded: "account.statusRefunded",
};

function BillingHistoryCard() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void fetchBillingStatus().then((data) => {
      if (active) {
        setBilling(data);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, [user, user?.plan]);

  if (!user) return null;

  const rows = billing?.payments ?? [];

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ReceiptText className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("account.sectionHistory")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {loaded ? t("account.historyEmpty") : t("account.loading")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {row.currency === "INR"
                      ? `₹${(row.amount / 100).toLocaleString("en-IN")}`
                      : `$${(row.amount / 100).toFixed(2)}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(row.createdAt, locale)}
                    {row.invoiceNo ? ` · ${row.invoiceNo}` : ""}
                  </p>
                </div>
                <Badge
                  variant={row.status === "paid" ? "default" : "outline"}
                  className="rounded-chip"
                >
                  {t((PAYMENT_STATUS_KEYS[row.status] ?? "account.statusPending") as never)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Security — change password                                          */
/* ------------------------------------------------------------------ */

function PasswordCard() {
  const { t } = useI18n();
  const { toast } = useToast();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [mismatch, setMismatch] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrorCode(null);
    setMismatch(false);

    if (current.length === 0 || next.length === 0 || confirm.length === 0) {
      setErrorCode("bad_request");
      return;
    }
    if (next.length < 8) {
      setErrorCode("weak_password");
      return;
    }
    if (next !== confirm) {
      setMismatch(true);
      return;
    }

    setBusy(true);
    const res = await changePassword(current, next);
    setBusy(false);

    if (res.ok) {
      track("password_change");
      setCurrent("");
      setNext("");
      setConfirm("");
      toast({ title: t("account.pwUpdated") });
      return;
    }
    setErrorCode(res.code ?? "server_error");
  };

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("account.sectionSecurity")}
        </CardTitle>
        <CardDescription>{t("account.pwHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pw-current">{t("account.pwCurrent")}</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              maxLength={200}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pw-new">{t("account.pwNew")}</Label>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pw-confirm">{t("account.pwConfirm")}</Label>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          {errorCode !== null ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t(`auth.err.${errorCode}` as never)}
            </p>
          ) : null}
          {mismatch ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t("account.pwMismatch")}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="outline"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {t("account.pwCta")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Danger zone — delete account                                        */
/* ------------------------------------------------------------------ */

function DangerCard() {
  const { t } = useI18n();
  const { toast } = useToast();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);

  const handleDelete = async () => {
    if (busy) return;
    if (password.length === 0) {
      setErrorCode("bad_request");
      return;
    }
    setBusy(true);
    const res = await deleteAccount(password);
    setBusy(false);
    if (res.ok) {
      track("account_delete");
      setConfirmOpen(false);
      toast({ title: t("account.deletedToast") });
      /* Head home — the account view is meaningless as a guest. */
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new Event("docopdf:route-change"));
      return;
    }
    setErrorCode(res.code ?? "server_error");
  };

  return (
    <Card className="rounded-card border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          {t("account.sectionDanger")}
        </CardTitle>
        <CardDescription>{t("account.delDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="destructive"
          size="touch"
          className="w-full rounded-btn sm:w-auto"
          onClick={() => {
            setPassword("");
            setErrorCode(null);
            setConfirmOpen(true);
          }}
        >
          {t("account.delCta")}
        </Button>
      </CardContent>

      <Modal
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) setConfirmOpen(open);
        }}
        title={t("account.delConfirmTitle")}
        description={t("account.delConfirmBody")}
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="rounded-btn"
              disabled={busy || password.length === 0}
              onClick={() => void handleDelete()}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("account.delConfirmCta")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="del-password">{t("auth.password")}</Label>
          <Input
            id="del-password"
            type="password"
            autoComplete="current-password"
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          {errorCode !== null ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t(`auth.err.${errorCode}` as never)}
            </p>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}
