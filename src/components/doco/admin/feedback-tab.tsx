"use client";

import { useEffect, useState } from "react";
import { MessageSquareHeart, ThumbsDown, ThumbsUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import { fetchFeedback, type AdminFeedbackDto } from "@/lib/admin-client";
import { fmtDateTime } from "@/components/doco/admin/shared";

const REASON_LABEL_KEY: Record<string, string> = {
  slow: "admin.feedback.reasonSlow",
  wrong: "admin.feedback.reasonWrong",
  confusing: "admin.feedback.reasonConfusing",
  other: "admin.feedback.reasonOther",
};

/**
 * FeedbackTab — thumbs browser: up/down totals + the latest 200 items with
 * the reason badge the public form stored.
 */
export function FeedbackTab() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AdminFeedbackDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchFeedback().then((res) => {
      if (!active) return;
      if (res) setData(res);
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (failed) {
    return <EmptyState icon={<MessageSquareHeart />} title={t("admin.loadFailed")} />;
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-20 rounded-card" />
        </div>
        <Skeleton className="h-48 rounded-card" />
      </div>
    );
  }

  const total = data.upCount + data.downCount;
  const upPct = total > 0 ? Math.round((data.upCount / total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="border-success/25 bg-success/5">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("admin.feedback.up")}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-success">
                {data.upCount.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{upPct}%</p>
            </div>
            <ThumbsUp className="size-8 text-success" aria-hidden="true" />
          </CardContent>
        </Card>
        <Card className="border-destructive/25 bg-destructive/5">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("admin.feedback.down")}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-destructive">
                {data.downCount.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{100 - upPct}%</p>
            </div>
            <ThumbsDown className="size-8 text-destructive" aria-hidden="true" />
          </CardContent>
        </Card>
      </div>

      {/* Items */}
      {data.items.length === 0 ? (
        <EmptyState icon={<MessageSquareHeart />} title={t("admin.feedback.empty")} />
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-card border border-border">
          <Table>
            <TableHeader>
              <TableRow className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <TableHead>{t("admin.bugs.tool")}</TableHead>
                <TableHead className="w-20 text-center">±</TableHead>
                <TableHead>{t("admin.feedback.note")}</TableHead>
                <TableHead className="w-32">{t("admin.audit.when")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-sm font-medium">{item.toolId}</TableCell>
                  <TableCell className="text-center">
                    {item.rating > 0 ? (
                      <ThumbsUp className="mx-auto size-4 text-success" aria-label={t("admin.feedback.up")} />
                    ) : (
                      <ThumbsDown className="mx-auto size-4 text-destructive" aria-label={t("admin.feedback.down")} />
                    )}
                  </TableCell>
                  <TableCell className="max-w-64">
                    {item.reason ? (
                      <Badge variant="secondary" className="mr-2 rounded-chip">
                        {t(REASON_LABEL_KEY[item.reason] ?? "admin.feedback.reasonOther")}
                      </Badge>
                    ) : null}
                    {item.message ? (
                      <span className="text-sm text-muted-foreground">{item.message}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {fmtDateTime(item.createdAt, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
