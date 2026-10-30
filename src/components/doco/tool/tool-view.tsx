"use client";

import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/doco/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { ToolShell } from "@/components/doco/tool/tool-shell";
import { getToolConfig } from "@/lib/tools/configs";
import { getTool } from "@/lib/tools/registry";

/**
 * Tool view entry: resolves the routed tool id against the registry +
 * configs and mounts the shared ToolShell. Unknown or not-yet-live ids
 * get an honest empty state instead of a broken page.
 */
export function ToolView({ toolId }: { toolId: string }) {
  const { t } = useI18n();
  const tool = getTool(toolId);
  const config = tool ? getToolConfig(tool.id) : undefined;

  if (!tool || !config || !tool.enabled) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<FileQuestion />}
          title={t("tool.notFoundTitle")}
          description={t("tool.notFoundDesc")}
          action={
            <Button asChild size="touch" className="rounded-btn">
              <a href="/tools">{t("tool.notFoundAction")}</a>
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
