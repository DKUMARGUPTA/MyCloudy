"use client";

import { useEffect, useRef, useState } from "react";

import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import {
  adminErrorCode,
  fetchAdminSettings,
  putAdminSettings,
  type AdminSettings,
} from "./admin-api";
import {
  adminErrorText,
  AdminErrorCard,
  AdminModuleProps,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Site settings (#/admin/settings): registration toggle. Optimistic flip
 * with rollback + toast; the PUT sends the full settings object (merged
 * with the fetched toolOverrides/announcements) and server truth is
 * re-read on refresh.
 */
export function SettingsPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [load, setLoad] = useState<AdminLoad<boolean>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);

  /** Latest full settings snapshot for merged PUT bodies. */
  const settingsRef = useRef<AdminSettings | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminSettings(controller.signal)
      .then((data) => {
        if (active) {
          settingsRef.current = data;
          setLoad({
            data: data.siteFlags.registrationOpen,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const code = adminErrorCode(error);
        if (code === "forbidden") onForbidden();
        else setLoad({ data: null, error: code });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshToken, reloadKey, onForbidden]);

  async function toggleRegistration(next: boolean): Promise<void> {
    const base = settingsRef.current;
    const previous = load.data;
    if (base === null || previous === null || saving) return;
    const siteFlags = { registrationOpen: next };
    setLoad({ data: next, error: null });
    setSaving(true);
    try {
      await putAdminSettings({
        toolOverrides: base.toolOverrides,
        announcements: base.announcements,
        siteFlags,
      });
      settingsRef.current = { ...base, siteFlags };
      toast({ title: t("admin.set.saved") });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") {
        onForbidden();
      } else {
        toast({
          title: adminErrorText(t, code),
          variant: "destructive",
        });
        setLoad({ data: previous, error: null });
      }
    } finally {
      setSaving(false);
    }
  }

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.settings")}
      </h2>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <Card className="gap-0 rounded-xl py-6">
            <CardHeader className="px-6">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
          </Card>
        ) : (
          <Card className="rounded-xl">
            <CardHeader className="px-6">
              <CardTitle className="text-sm">
                {t("admin.set.registration")}
              </CardTitle>
              <CardDescription>
                {t("admin.set.registrationHint")}
              </CardDescription>
              <CardAction>
                <Switch
                  checked={load.data === true}
                  disabled={saving || load.data === null}
                  onCheckedChange={(next) => void toggleRegistration(next)}
                  aria-label={t("admin.set.registration")}
                />
              </CardAction>
            </CardHeader>
          </Card>
        )}
      </div>
    </section>
  );
}
