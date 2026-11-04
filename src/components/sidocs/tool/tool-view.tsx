"use client";

import { useEffect, useState } from "react";
import { FileQuestion, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/sidocs/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { ToolShell } from "@/components/sidocs/tool/tool-shell";
import { getToolConfig } from "@/lib/tools/configs";
import { getTool } from "@/lib/tools/registry";

/**
 * Tool view entry: resolves the routed tool id against the registry +
 * configs and mounts the shared ToolShell. Unknown or not-yet-live ids
 * get an honest empty state instead of a broken page.
 *
 * P12: additionally honors admin tool overrides from /api/tools/status —
 * a tool switched OFF in the admin console shows a maintenance note here
 * instead of the workspace (registry `enabled` stays the code-level truth;
 * the DB override is the operations-level switch).
 */

interface ToolOverride {
  enabled: boolean;
  note?: string;
}

/* Module-level cache (60s TTL) — every tool navigation shares one fetch. */
let statusCache: {
  at: number;
  overrides: Record<string, ToolOverride>;
} | null = null;

async function fetchOverrides(): Promise<Record<string, ToolOverride>> {
  if (statusCache && Date.now() - statusCache.at < 60_000) {
    return statusCache.overrides;
  }
  const res = await fetch("/api/tools/status", { cache: "no-store" });
  if (!res.ok) throw new Error("status unavailable");
  const data = (await res.json()) as { overrides: Record<string, ToolOverride> };
  statusCache = { at: Date.now(), overrides: data.overrides ?? {} };
  return statusCache.overrides;
}

export function ToolView({ toolId }: { toolId: string }) {
  const { t } = useI18n();
  const tool = getTool(toolId);
  const config = tool ? getToolConfig(tool.id) : undefined;

  const [override, setOverride] = useState<ToolOverride | null>(null);
  const [overrideReady, setOverrideReady] = useState(false);

  useEffect(() => {
    let active = true;
    fetchOverrides()
      .then((overrides) => {
        if (active && tool) setOverride(overrides[tool.id] ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setOverrideReady(true);
      });
    return () => {
      active = false;
    };
  }, [tool]);

  if (!tool || !config || !tool.enabled) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<FileQuestion />}
          title={t("tool.notFoundTitle")}
          description={t("tool.notFoundDesc")}
          action={
            <Button asChild size="touch" className="rounded-btn">
              <a href="#/tools">{t("tool.notFoundAction")}</a>
            </Button>
          }
        />
      </div>
    );
  }

  // Admin-disabled tool: maintenance note instead of the workspace.
  if (overrideReady && override && !override.enabled) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<Wrench className="size-10" aria-hidden="true" />}
          title={override.note?.trim() || t("tool.maintenanceTitle")}
          description={t("tool.maintenanceDesc")}
          action={
            <Button asChild size="touch" className="rounded-btn">
              <a href="#/tools">{t("tool.notFoundAction")}</a>
            </Button>
          }
        />
      </div>
    );
  }

  // key: navigating between tools must remount the shell (fresh state +
  // a new chain-handoff peek per tool).
  return <ToolShell key={tool.id} tool={tool} config={config} />;
}
