"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import {
  adminErrorCode,
  fetchAdminSettings,
  putAdminSettings,
  type AdminAnnouncement,
  type AdminAnnouncementVariant,
  type AdminSettings,
} from "./admin-api";
import {
  adminErrorText,
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  formatAdminDate,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Announcements (#/admin/announcements): active banner list (variant-
 * colored left border) with per-item remove, plus an add form
 * (EN + HI text, variant, optional until date). Every change PUTs the
 * full settings object (crypto.randomUUID() ids) and toasts. The `until`
 * value from the date input is sent as an end-of-day UTC timestamp.
 */

const VARIANTS: readonly AdminAnnouncementVariant[] = [
  "info",
  "success",
  "warning",
];

const VARIANT_BORDER: Record<AdminAnnouncementVariant, string> = {
  info: "border-l-cat-organize",
  success: "border-l-primary",
  warning: "border-l-amber-500",
};

const VARIANT_BADGE: Record<AdminAnnouncementVariant, string> = {
  info: "bg-cat-organize/10 text-cat-organize",
  success: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

export function AnnouncementsPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [load, setLoad] = useState<AdminLoad<AdminAnnouncement[]>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  /** Latest full settings snapshot for merged PUT bodies. */
  const settingsRef = useRef<AdminSettings | null>(null);

  // Add-form state.
  const [textEn, setTextEn] = useState("");
  const [textHi, setTextHi] = useState("");
  const [variant, setVariant] = useState<AdminAnnouncementVariant>("info");
  const [until, setUntil] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminSettings(controller.signal)
      .then((data) => {
        if (active) {
          settingsRef.current = data;
          setLoad({ data: data.announcements, error: null });
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

  async function persist(next: AdminAnnouncement[]): Promise<void> {
    const base = settingsRef.current;
    if (base === null || busy) return;
    setBusy(true);
    try {
      await putAdminSettings({
        toolOverrides: base.toolOverrides,
        announcements: next,
        siteFlags: base.siteFlags,
      });
      settingsRef.current = { ...base, announcements: next };
      setLoad({ data: next, error: null });
      toast({ title: t("admin.ann.saved") });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") onForbidden();
      else toast({ title: adminErrorText(t, code), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function addAnnouncement(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    const current = load.data ?? [];
    const next: AdminAnnouncement[] = [
      {
        id: crypto.randomUUID(),
        textEn: textEn.trim(),
        textHi: textHi.trim(),
        variant,
        // Date input gives YYYY-MM-DD — send end-of-day UTC so the banner
        // stays visible through the chosen date.
        ...(until ? { until: `${until}T23:59:59.000Z` } : {}),
      },
      ...current,
    ];
    await persist(next);
    setTextEn("");
    setTextHi("");
    setVariant("info");
    setUntil("");
  }

  function removeAnnouncement(target: AdminAnnouncement): void {
    const current = load.data ?? [];
    void persist(current.filter((item) => item.id !== target.id));
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
        {t("admin.nav.announcements")}
      </h2>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <AdminRowsSkeleton rows={3} />
        ) : (load.data?.length ?? 0) === 0 ? (
          <AdminEmpty />
        ) : (
          <ul className="space-y-3">
            {(load.data ?? []).map((announcement) => (
              <li key={announcement.id}>
                <Card
                  className={cn(
                    "gap-0 rounded-xl border-l-4 py-4",
                    VARIANT_BORDER[announcement.variant]
                  )}
                >
                  <div className="flex items-start justify-between gap-3 px-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {announcement.textEn}
                      </p>
                      <p
                        className="mt-0.5 text-sm text-muted-foreground"
                        lang="hi"
                      >
                        {announcement.textHi}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "border-transparent font-normal",
                            VARIANT_BADGE[announcement.variant]
                          )}
                        >
                          {t(`admin.ann.variant.${announcement.variant}`)}
                        </Badge>
                        {announcement.until ? (
                          <span className="text-xs text-muted-foreground">
                            {t("admin.ann.until")}:{" "}
                            {formatAdminDate(announcement.until, locale)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0 text-destructive hover:text-destructive"
                      aria-label={`${t("admin.ann.remove")} — ${announcement.textEn}`}
                      disabled={busy}
                      onClick={() => removeAnnouncement(announcement)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Card className="mt-6 rounded-xl">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t("admin.ann.add")}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <form
            className="grid gap-3"
            onSubmit={(event) => void addAnnouncement(event)}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ann-text-en">
                  {t("admin.ann.textEn")}
                </Label>
                <Input
                  id="ann-text-en"
                  value={textEn}
                  onChange={(event) => setTextEn(event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ann-text-hi">
                  {t("admin.ann.textHi")}
                </Label>
                <Input
                  id="ann-text-hi"
                  value={textHi}
                  onChange={(event) => setTextHi(event.target.value)}
                  required
                  lang="hi"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ann-variant">{t("admin.ann.variantLabel")}</Label>
                <Select
                  value={variant}
                  onValueChange={(value) =>
                    setVariant(value as AdminAnnouncementVariant)
                  }
                >
                  <SelectTrigger id="ann-variant" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VARIANTS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`admin.ann.variant.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ann-until">{t("admin.ann.until")}</Label>
                <Input
                  id="ann-until"
                  type="date"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>
                <Plus className="size-4" aria-hidden="true" />
                {t("admin.ann.add")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
