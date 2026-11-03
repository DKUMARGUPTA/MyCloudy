"use client";

import { useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  KeyRound,
  Loader2,
  LogOut,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MyFilesSection } from "./my-files-section";
import { BugReportForm } from "./bug-report-form";
import { MyReports } from "./my-reports";
import { PasswordInput } from "./password-input";
import { changePassword, deleteAccount } from "./api";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  logout,
  openAuthModal,
  refreshMe,
  useAuth,
  type AuthErrorCode,
  type SafeUser,
} from "@/lib/auth-client";
import { ROUTES } from "@/hooks/use-hash-route";

/**
 * Account view (#/account, P12 task 12-b). Works signed-out — that is the
 * brand promise ("optional account"): the sign-in card is an invitation,
 * never a wall. My files + the bug report form are useful without an
 * account; profile, my reports and the danger zone appear when signed in.
 */
export function AccountView() {
  const { t } = useI18n();
  const { user, status } = useAuth();

  return (
    <section className="mx-auto w-full max-w-4xl space-y-8 px-4 py-10 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("account.title")}
      </h1>

      {status === "loading" ? <ProfileSkeleton /> : null}
      {status === "ready" && !user ? <SignedOutCard /> : null}
      {user ? (
        <>
          <ProfileCard user={user} />
          {user.role === "admin" ? <AdminCard /> : null}
        </>
      ) : null}

      <MyFilesSection />
      <BugReportForm userEmail={user?.email ?? null} />
      {user ? <MyReports /> : null}
      {user ? <DangerZone /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Signed-out invitation (no wall — the site works without an account) */
/* ------------------------------------------------------------------ */

function SignedOutCard() {
  const { t } = useI18n();
  return (
    <section
      aria-labelledby="sign-in-heading"
      className="rounded-card border border-border bg-card p-6 text-center sm:p-10"
    >
      <span
        className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
        aria-hidden="true"
      >
        <UserRound className="size-6" />
      </span>
      <h2 id="sign-in-heading" className="sr-only">
        {t("account.signInCta")}
      </h2>
      <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
        {t("account.signInPrompt")}
      </p>
      <Button
        type="button"
        variant="cta"
        size="touch"
        className="mt-6 rounded-btn bg-gradient-to-r from-primary to-cta font-semibold text-white shadow-md hover:-translate-y-0.5 hover:shadow-lg hover:brightness-110"
        onClick={() => openAuthModal("login")}
      >
        {t("account.signInCta")}
      </Button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

function initialsFor(user: SafeUser): string {
  const name = (user.name ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
    if (parts.length > 0) {
      return parts.map((part) => part.charAt(0).toUpperCase()).join("");
    }
  }
  return user.email.charAt(0).toUpperCase();
}

function ProfileCard({ user }: { user: SafeUser }) {
  const { t, locale } = useI18n();
  const memberSince = new Date(user.createdAt).toLocaleDateString(
    locale === "hi" ? "hi-IN" : "en-IN",
    { day: "numeric", month: "long", year: "numeric" }
  );

  return (
    <section
      aria-labelledby="profile-heading"
      className="rounded-card border border-border bg-card p-5 sm:p-6"
    >
      <h2 id="profile-heading" className="sr-only">
        {t("account.profile")}
      </h2>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
        <Avatar className="size-14 shrink-0">
          <AvatarFallback className="bg-primary text-lg font-semibold text-primary-foreground">
            {initialsFor(user)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("account.profile")}
          </p>
          <p className="mt-1 truncate text-lg font-semibold text-foreground">
            {t("auth.welcome", { name: user.name ?? user.email })}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {user.email}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {t("account.plan")}
              </span>
              <Badge variant="secondary" className="rounded-full">
                {t("account.planFree")}
              </Badge>
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="size-3.5" aria-hidden="true" />
              {t("account.memberSince", { date: memberSince })}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-live="polite"
      className="rounded-card border border-border bg-card p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
        <Skeleton className="size-14 shrink-0 rounded-full" />
        <div className="w-full space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Admin shortcut                                                      */
/* ------------------------------------------------------------------ */

function AdminCard() {
  const { t } = useI18n();
  return (
    <a
      href={ROUTES.admin()}
      className="group flex items-center gap-4 rounded-card border border-primary/30 bg-primary/5 p-4 outline-none transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:p-5"
    >
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <ShieldCheck className="size-5" />
      </span>
      <span className="min-w-0 flex-1 text-base font-semibold text-foreground">
        {t("account.adminConsole")}
      </span>
      <ArrowRight
        className="size-5 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Danger zone (change password / log out everywhere / delete account)  */
/* ------------------------------------------------------------------ */

function DangerZone() {
  return (
    <div className="space-y-8">
      <ChangePasswordCard />
      <LogoutAllCard />
      <DeleteAccountCard />
    </div>
  );
}

function ChangePasswordCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (next.length < 8) {
      setError("weak_password");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await changePassword(current, next);
    setBusy(false);
    if (res.ok) {
      setCurrent("");
      setNext("");
      toast({ title: t("account.saved") });
      return;
    }
    setError(res.code ?? "server_error");
  };

  return (
    <section
      aria-labelledby="change-password-heading"
      className="rounded-card border border-border bg-card"
    >
      <div className="border-b border-border p-5 pb-4">
        <h2
          id="change-password-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <KeyRound className="size-4 text-primary" aria-hidden="true" />
          {t("account.changePassword")}
        </h2>
      </div>
      <form noValidate onSubmit={submit} className="space-y-4 p-5">
        <div className="space-y-2">
          <Label htmlFor="cp-current">{t("account.currentPassword")}</Label>
          <PasswordInput
            id="cp-current"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cp-new">{t("account.newPassword")}</Label>
          <PasswordInput
            id="cp-new"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            ariaInvalid={error !== null}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {t(`auth.err.${error}`)}
          </p>
        ) : null}
        <Button
          type="submit"
          size="touch"
          disabled={busy}
          className="rounded-btn font-semibold"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          {t("common.save")}
        </Button>
      </form>
    </section>
  );
}

function LogoutAllCard() {
  const { t } = useI18n();
  const { toast } = useToast();

  const handleLogoutAll = () => {
    void logout();
    toast({ title: t("auth.signedOut") });
  };

  return (
    <section
      aria-labelledby="logout-all-heading"
      className="flex flex-col gap-3 rounded-card border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <h2
          id="logout-all-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <LogOut className="size-4 text-primary" aria-hidden="true" />
          {t("account.logoutAll")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("account.logoutAllHint")}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="shrink-0 rounded-btn"
        onClick={handleLogoutAll}
      >
        <LogOut className="size-4" aria-hidden="true" />
        {t("account.logoutAll")}
      </Button>
    </section>
  );
}

function DeleteAccountCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const confirmDelete = async (event: React.MouseEvent) => {
    // Keep the dialog open until the request resolves (failures stay
    // visible instead of swallowing the error).
    event.preventDefault();
    if (busy) return;
    if (!password) {
      setError("bad_request");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await deleteAccount(password);
    setBusy(false);
    if (res.ok) {
      setPassword("");
      await refreshMe();
      toast({ title: t("auth.signedOut") });
      return;
    }
    setError(res.code ?? "server_error");
  };

  return (
    <section
      aria-labelledby="delete-account-heading"
      className="rounded-card border border-destructive/30 bg-card"
    >
      <div className="border-b border-destructive/20 p-5 pb-4">
        <h2
          id="delete-account-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <Trash2 className="size-4 text-destructive" aria-hidden="true" />
          {t("account.deleteAccount")}
        </h2>
      </div>
      <div className="space-y-4 p-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("account.deleteWarning")}
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="rounded-btn"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t("account.deleteAccount")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("account.deleteAccount")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("account.deleteWarning")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Label htmlFor="delete-password">{t("auth.password")}</Label>
              <PasswordInput
                id="delete-password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                ariaInvalid={error !== null}
              />
              {error ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {t(`auth.err.${error}`)}
                </p>
              ) : null}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={(event) => void confirmDelete(event)}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {t("common.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
