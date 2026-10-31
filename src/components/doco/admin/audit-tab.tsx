"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/doco/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { fetchAudit, type AdminAuditDto } from "@/lib/admin-client";
import { fmtDateTime } from "@/components/doco/admin/shared";

/** Pretty-print the stored metaJson, tolerating null / invalid rows. */
function prettyMeta(metaJson: string | null): string {
  if (!metaJson) return "—";
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return metaJson;
  }
}

/**
 * AuditTab — the compliance trail (newest first, max 200). Every admin
 * mutation lands here via the server-side audit() helper.
 */
export function AuditTab() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AdminAuditDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchAudit().then((res) => {
      if (!active) return;
      if (res) setData(res);
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (failed) {
    return <EmptyState icon={<ScrollText />} title={t("admin.loadFailed")} />;
  }

  if (!data) {
    return <Skeleton className="h-64 rounded-card" />;
  }

  if (data.entries.length === 0) {
    return <EmptyState icon={<ScrollText />} title={t("admin.audit.empty")} />;
  }

  return (
    <div className="max-h-96 overflow-y-auto rounded-card border border-border">
      <Table>
        <TableHeader>
          <TableRow className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
            <TableHead>{t("admin.audit.when")}</TableHead>
            <TableHead>{t("admin.audit.actor")}</TableHead>
            <TableHead>{t("admin.audit.action")}</TableHead>
            <TableHead className="min-w-56">{t("admin.audit.meta")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                {fmtDateTime(e.createdAt, locale)}
              </TableCell>
              <TableCell className="max-w-44 truncate text-sm">{e.actor}</TableCell>
              <TableCell>
                <code className="rounded-chip bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                  {e.action}
                </code>
              </TableCell>
              <TableCell>
                <pre className="max-w-72 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                  {prettyMeta(e.metaJson)}
                </pre>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
