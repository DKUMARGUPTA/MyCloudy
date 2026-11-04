"use client";

import { useCallback, useState } from "react";
import { LogIn, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/components/providers/locale-provider";
import { openAuthModal, useAuth } from "@/lib/auth-client";
import { AdminShell } from "./admin-shell";

/**
 * P12 admin console (#/admin) — role gate + shell (task 12-c).
 *
 * Gate order: auth loading → skeleton; signed out → sign-in prompt;
 * signed in but not admin (or a 403 from any admin API call) → locked
 * card; admin → the console shell with 9 modules.
 */

const ADMIN_TABS = [
  "dashboard",
  "tools",
  "users",
  "bugs",
  "messages",
  "feedback",
  "announcements",
  "audit",
  "settings",
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

function resolveTab(tab: string | undefined): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(tab ?? "")
    ? (tab as AdminTab)
    : "dashboard";
}

export function AdminView({ tab }: { tab?: string }) {
  const { t } = useI18n();
  const { user, status } = useAuth();
  const [forbidden, setForbidden] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const handleForbidden = useCallback(() => setForbidden(true), []);
  const handleRefresh = useCallback(
    () => setRefreshToken((token) => token + 1),
    []
  );

  if (status === "loading") {
    return <AdminBootSkeleton />;
  }

  if (!user || user.role !== "admin" || forbidden) {
    return (
      <section className="mx-auto w-full max-w-2xl px-4 py-16">
        <div className="rounded-card border bg-card p-8 text-center shadow-sm">
          <div
            className="mx-auto flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            aria-hidden="true"
          >
            <ShieldAlert className="size-7" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("admin.notAdmin")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("admin.notAdminHint")}
          </p>
          {!user ? (
            <Button className="mt-6" onClick={() => openAuthModal("login")}>
              <LogIn className="size-4" aria-hidden="true" />
              {t("auth.loginCta")}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <AdminShell
      tab={resolveTab(tab)}
      refreshToken={refreshToken}
      onRefresh={handleRefresh}
      onForbidden={handleForbidden}
    />
  );
}

/** Full-console skeleton while the auth bootstrap resolves. */
function AdminBootSkeleton() {
  return (
    <div aria-busy="true">
      <div className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-4">
          <Skeleton className="h-6 w-40" />
        </div>
      </div>
      <div className="mx-auto mt-6 w-full max-w-6xl px-4">
        <div className="grid gap-8 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="hidden flex-col gap-2 md:flex">
            {Array.from({ length: 9 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
          <div>
            <Skeleton className="h-8 w-48" />
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-24 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
