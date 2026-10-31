"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Megaphone,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
  UsersRound,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/doco/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  fetchSettings,
  settingsSave,
  type AdminSettingsDto,
  type AnnouncementDto,
} from "@/lib/admin-client";
import { ALL_TOOLS } from "@/lib/tools/registry";

const VARIANTS: Array<AnnouncementDto["variant"]> = ["info", "success", "warning"];

/**
 * SettingsTab — the three site settings rows in one editor:
 * registration flag, announcement banners (max 5) and per-tool enable
 * overrides. Saving PUTs the whole payload (the API upserts each row).
 */
export function SettingsTab() {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<AdminSettingsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toolFilter, setToolFilter] = useState("");

  /* Live tools only — registry-enabled ones can be disabled via override. */
  const liveTools = useMemo(
    () => ALL_TOOLS.filter((tool) => tool.enabled),
    []
  );

  useEffect(() => {
    let active = true;
    void fetchSettings().then((res) => {
      if (!active) return;
      if (res) setSettings(res);
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const mutate = (next: AdminSettingsDto) => {
    setSettings(next);
    setDirty(true);
  };

  /* ------------------------- registration ------------------------- */

  const setRegistration = (open: boolean) => {
    if (!settings) return;
    mutate({
      ...settings,
      siteFlags: { registrationOpen: open },
    });
  };

  /* ------------------------- announcements ------------------------- */

  const addAnnouncement = () => {
    if (!settings || settings.announcements.length >= 5) return;
    mutate({
      ...settings,
      announcements: [
        ...settings.announcements,
        {
          id: `ann-${Date.now().toString(36)}`,
          textEn: "",
          textHi: "",
          variant: "info",
        },
      ],
    });
  };

  const updateAnnouncement = (
    id: string,
    patch: Partial<Omit<AnnouncementDto, "id">>
  ) => {
    if (!settings) return;
    mutate({
      ...settings,
      announcements: settings.announcements.map((a) =>
        a.id === id ? { ...a, ...patch } : a
      ),
    });
  };

  const removeAnnouncement = (id: string) => {
    if (!settings) return;
    mutate({
      ...settings,
      announcements: settings.announcements.filter((a) => a.id !== id),
    });
  };

  /* ------------------------- tool overrides ------------------------- */

  const isToolEnabled = (toolId: string): boolean => {
    if (!settings) return true;
    const override = settings.toolOverrides[toolId];
    return override ? override.enabled !== false : true;
  };

  const toggleTool = (toolId: string, enabled: boolean) => {
    if (!settings) return;
    const nextOverrides = { ...settings.toolOverrides };
    if (enabled) {
      delete nextOverrides[toolId];
    } else {
      nextOverrides[toolId] = { enabled: false };
    }
    mutate({ ...settings, toolOverrides: nextOverrides });
  };

  const disabledCount = liveTools.filter((tool) => !isToolEnabled(tool.id)).length;

  /* ------------------------------ save ------------------------------ */

  const save = async () => {
    if (!settings || saving) return;

    /* Trim announcements: drop rows that still have no English text. */
    const announcements = settings.announcements.filter(
      (a) => a.textEn.trim().length > 0
    );

    setSaving(true);
    const res = await settingsSave({
      ...settings,
      announcements: announcements.map((a) => ({
        ...a,
        textEn: a.textEn.trim(),
        textHi: a.textHi.trim() || a.textEn.trim(),
        until: a.until || undefined,
      })),
    });
    setSaving(false);
    if (!res.ok) {
      toast({ title: t("admin.toast.failed"), variant: "destructive" });
      return;
    }
    setDirty(false);
    /* Re-fetch so server-sanitized values (dropped junk, etc.) show. */
    const fresh = await fetchSettings();
    if (fresh) setSettings(fresh);
    toast({ title: t("admin.toast.saved") });
  };

  /* Warn before leaving with unsaved changes (best effort). */
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (failed) {
    return <EmptyState icon={<Settings2 />} title={t("admin.loadFailed")} />;
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-48 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }

  const filteredTools = liveTools.filter((tool) =>
    toolFilter
      ? (tool.id + tool.name.en + tool.name.hi)
          .toLowerCase()
          .includes(toolFilter.toLowerCase())
      : true
  );

  return (
    <div className="space-y-6">
      {/* Registration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersRound className="size-4 text-primary" aria-hidden="true" />
            {t("admin.settings.registrationTitle")}
          </CardTitle>
          <CardDescription>{t("admin.settings.registrationDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <Badge
            variant={settings.siteFlags.registrationOpen ? "private" : "destructive"}
            className="rounded-chip"
          >
            {settings.siteFlags.registrationOpen
              ? t("admin.settings.on")
              : t("admin.settings.off")}
          </Badge>
          <Switch
            checked={settings.siteFlags.registrationOpen}
            onCheckedChange={setRegistration}
            aria-label={t("admin.settings.registrationTitle")}
          />
        </CardContent>
      </Card>

      {/* Announcements */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="size-4 text-primary" aria-hidden="true" />
              {t("admin.settings.annTitle")}
            </CardTitle>
            <CardDescription>{t("admin.settings.annDesc")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="shrink-0 rounded-btn"
            onClick={addAnnouncement}
            disabled={settings.announcements.length >= 5}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("admin.settings.annAdd")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.announcements.length === 0 ? (
            <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              {t("admin.settings.annEmpty")}
            </p>
          ) : (
            settings.announcements.map((a) => (
              <div
                key={a.id}
                className="space-y-3 rounded-card border border-border bg-background p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="rounded-chip">
                    #{settings.announcements.indexOf(a) + 1}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 rounded-btn text-destructive hover:text-destructive"
                    aria-label={t("admin.settings.annRemove")}
                    onClick={() => removeAnnouncement(a.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`ann-en-${a.id}`}>{t("admin.settings.annTextEn")}</Label>
                    <Input
                      id={`ann-en-${a.id}`}
                      value={a.textEn}
                      onChange={(e) => updateAnnouncement(a.id, { textEn: e.target.value })}
                      className="h-11 rounded-btn"
                      maxLength={200}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ann-hi-${a.id}`}>{t("admin.settings.annTextHi")}</Label>
                    <Input
                      id={`ann-hi-${a.id}`}
                      value={a.textHi}
                      onChange={(e) => updateAnnouncement(a.id, { textHi: e.target.value })}
                      className="h-11 rounded-btn"
                      maxLength={200}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ann-variant-${a.id}`}>{t("admin.settings.annVariant")}</Label>
                    <Select
                      value={a.variant}
                      onValueChange={(v) =>
                        updateAnnouncement(a.id, { variant: v as AnnouncementDto["variant"] })
                      }
                    >
                      <SelectTrigger id={`ann-variant-${a.id}`} className="h-11 w-full rounded-btn">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VARIANTS.map((v) => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ann-until-${a.id}`}>{t("admin.settings.annUntil")}</Label>
                    <Input
                      id={`ann-until-${a.id}`}
                      type="date"
                      value={a.until ? a.until.slice(0, 10) : ""}
                      onChange={(e) =>
                        updateAnnouncement(a.id, {
                          until: e.target.value
                            ? new Date(`${e.target.value}T23:59:59+05:30`).toISOString()
                            : undefined,
                        })
                      }
                      className="h-11 rounded-btn"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Tool overrides */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="size-4 text-primary" aria-hidden="true" />
            {t("admin.settings.overridesTitle")}
          </CardTitle>
          <CardDescription>{t("admin.settings.overridesDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={toolFilter}
                onChange={(e) => setToolFilter(e.target.value)}
                placeholder={t("admin.settings.overridesSearch")}
                className="h-11 rounded-btn pl-9"
                aria-label={t("admin.settings.overridesSearch")}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {disabledCount === 0
                ? t("admin.settings.overridesEmpty")
                : t("admin.settings.overridesCount", {
                    count: disabledCount,
                    total: liveTools.length,
                  })}
            </p>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-card border border-border">
            <ul className="divide-y divide-border">
              {filteredTools.map((tool) => {
                const enabled = isToolEnabled(tool.id);
                return (
                  <li
                    key={tool.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {tool.name[locale]}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{tool.id}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span
                        className={
                          enabled
                            ? "text-xs font-medium text-success"
                            : "text-xs font-medium text-destructive"
                        }
                      >
                        {enabled
                          ? t("admin.settings.enabled")
                          : t("admin.settings.disabled")}
                      </span>
                      <Switch
                        checked={enabled}
                        onCheckedChange={(next) => toggleTool(tool.id, next)}
                        aria-label={`${tool.name[locale]}: ${enabled ? t("admin.settings.enabled") : t("admin.settings.disabled")}`}
                      />
                    </div>
                  </li>
                );
              })}
              {filteredTools.length === 0 ? (
                <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("admin.users.empty")}
                </li>
              ) : null}
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-card border border-border bg-surface/95 p-3 shadow-lg backdrop-blur">
        {dirty ? (
          <p className="mr-auto pl-1 text-xs text-muted-foreground">●</p>
        ) : null}
        <Button
          type="button"
          size="touch"
          className="rounded-btn"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          {saving ? t("admin.settings.saving") : t("admin.settings.save")}
        </Button>
      </div>
    </div>
  );
}
