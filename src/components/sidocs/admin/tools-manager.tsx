"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import {
  ALL_TOOLS,
  CATEGORIES,
  type ToolDef,
} from "@/lib/tools/registry";
import {
  adminErrorCode,
  fetchAdminSettings,
  putAdminSettings,
  type AdminSettings,
  type AdminToolOverride,
} from "./admin-api";
import {
  adminErrorText,
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Tools manager (#/admin/tools): search across all registry tools, flip
 * the enabled override per tool and keep an optional maintenance note.
 * Every change PUTs the full settings object (merged toolOverrides plus
 * the untouched announcements/siteFlags) and toasts admin.tools.saved.
 * Note edits are debounced by 600ms.
 */

const NOTE_DEBOUNCE_MS = 600;

export function ToolsManagerPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [load, setLoad] = useState<
    AdminLoad<Record<string, AdminToolOverride>>
  >({ data: null, error: null });
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");

  /** Latest full settings snapshot for PUT bodies (event-handler writes). */
  const settingsRef = useRef<AdminSettings | null>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOverridesRef = useRef<Record<string, AdminToolOverride> | null>(
    null
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminSettings(controller.signal)
      .then((data) => {
        if (active) {
          settingsRef.current = data;
          setSettings(data);
          setLoad({ data: data.toolOverrides, error: null });
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

  // Flush any pending debounced note save when the panel unmounts.
  useEffect(() => {
    return () => {
      if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current);
    };
  }, []);

  async function persistOverrides(
    next: Record<string, AdminToolOverride>
  ): Promise<void> {
    const base = settingsRef.current;
    if (base === null) return;
    try {
      await putAdminSettings({
        toolOverrides: next,
        announcements: base.announcements,
        siteFlags: base.siteFlags,
      });
      toast({ title: t("admin.tools.saved") });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") {
        onForbidden();
        return;
      }
      toast({
        title: adminErrorText(t, code),
        variant: "destructive",
      });
      // Revert to server truth.
      setReloadKey((key) => key + 1);
    }
  }

  function applyOverrides(next: Record<string, AdminToolOverride>): void {
    const base = settingsRef.current;
    if (base === null) return;
    const nextSettings: AdminSettings = { ...base, toolOverrides: next };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    setLoad({ data: next, error: null });
  }

  function toggleTool(tool: ToolDef, enabled: boolean): void {
    const current = settingsRef.current?.toolOverrides ?? {};
    const next: Record<string, AdminToolOverride> = {
      ...current,
      [tool.id]: { enabled, note: current[tool.id]?.note },
    };
    pendingOverridesRef.current = null;
    applyOverrides(next);
    void persistOverrides(next);
  }

  function setNote(toolId: string, note: string): void {
    const current = settingsRef.current?.toolOverrides ?? {};
    const previous = current[toolId];
    const next: Record<string, AdminToolOverride> = {
      ...current,
      [toolId]: { enabled: previous?.enabled ?? false, note },
    };
    pendingOverridesRef.current = next;
    applyOverrides(next);
    if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => {
      noteTimerRef.current = null;
      const pending = pendingOverridesRef.current;
      pendingOverridesRef.current = null;
      if (pending !== null) void persistOverrides(pending);
    }, NOTE_DEBOUNCE_MS);
  }

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  if (isAdminLoading(load) || settings === null) {
    return (
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {t("admin.nav.tools")}
        </h2>
        <AdminRowsSkeleton rows={8} rowClassName="h-14" />
      </div>
    );
  }

  const overrides = settings.toolOverrides;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? ALL_TOOLS.filter(
        (tool) =>
          tool.id.toLowerCase().includes(needle) ||
          tool.name.en.toLowerCase().includes(needle) ||
          tool.name.hi.includes(query.trim())
      )
    : ALL_TOOLS;

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.tools")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("admin.tools.hint")}
      </p>

      <div className="relative mt-4">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("admin.tools.search")}
          aria-label={t("common.search")}
          className="h-10 pl-9"
        />
      </div>

      {visible.length === 0 ? (
        <div className="mt-4">
          <AdminEmpty />
        </div>
      ) : (
        <ul className="mt-2 divide-y">
          {visible.map((tool) => {
            const override = overrides[tool.id];
            const enabled = override?.enabled ?? true;
            const category = CATEGORIES.find((c) => c.id === tool.category);
            const Icon = tool.icon;
            return (
              <li
                key={tool.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  aria-hidden="true"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">
                      {tool.name[locale]}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {tool.id}
                    </span>
                    <Badge
                      variant="secondary"
                      className="font-normal text-muted-foreground"
                    >
                      {category ? category.name[locale] : tool.category}
                    </Badge>
                  </div>
                  {enabled ? null : (
                    <Input
                      className="mt-2 h-8 max-w-md text-sm"
                      value={override?.note ?? ""}
                      placeholder={t("admin.tools.note")}
                      aria-label={`${tool.name[locale]} — ${t("admin.tools.note")}`}
                      onChange={(event) =>
                        setNote(tool.id, event.target.value)
                      }
                    />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={enabled ? "new" : "secondary"}>
                    {t(
                      enabled ? "admin.tools.enabled" : "admin.tools.disabled"
                    )}
                  </Badge>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(next) => toggleTool(tool, next)}
                    aria-label={`${tool.name[locale]} — ${t(
                      enabled ? "admin.tools.enabled" : "admin.tools.disabled"
                    )}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
