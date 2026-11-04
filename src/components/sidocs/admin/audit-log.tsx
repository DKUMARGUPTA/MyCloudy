"use client";

import { useEffect, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useI18n } from "@/components/providers/locale-provider";
import {
  adminErrorCode,
  fetchAdminAudit,
  type AdminAuditEntry,
} from "./admin-api";
import {
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  formatAdminDateTime,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Audit log (#/admin/audit): time, actor and action rows; metaJson is
 * pretty-printed (JSON.parse guarded) behind a small "details" toggle.
 */
export function AuditLogPanel({ refreshToken, onForbidden }: AdminModuleProps) {
  const { t, locale } = useI18n();

  const [load, setLoad] = useState<AdminLoad<AdminAuditEntry[]>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminAudit(controller.signal)
      .then((data) => {
        if (active) setLoad({ data: data.entries, error: null });
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

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const entries = load.data ?? [];

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.audit")}
      </h2>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <AdminRowsSkeleton rows={6} rowClassName="h-12" />
        ) : entries.length === 0 ? (
          <AdminEmpty />
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-44">
                      {t("admin.audit.time")}
                    </TableHead>
                    <TableHead>{t("admin.audit.actor")}</TableHead>
                    <TableHead>{t("admin.audit.action")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatAdminDateTime(entry.createdAt, locale)}
                      </TableCell>
                      <TableCell className="max-w-56 truncate font-medium">
                        {entry.actor}
                      </TableCell>
                      <TableCell>
                        <AuditActionCell entry={entry} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: card list */}
            <ul className="space-y-3 md:hidden">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-xl border bg-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {entry.actor}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatAdminDateTime(entry.createdAt, locale)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <AuditActionCell entry={entry} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function AuditActionCell({ entry }: { entry: AdminAuditEntry }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        {entry.action}
      </code>
      {entry.metaJson ? <AuditMeta metaJson={entry.metaJson} /> : null}
    </div>
  );
}

function AuditMeta({ metaJson }: { metaJson: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  let pretty = metaJson;
  try {
    const parsed: unknown = JSON.parse(metaJson);
    pretty = JSON.stringify(parsed, null, 2);
  } catch {
    // Not valid JSON — show the raw string.
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        {t("bugs.details")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-w-lg overflow-x-auto rounded-lg bg-muted p-2 font-mono text-xs">
          {pretty}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
