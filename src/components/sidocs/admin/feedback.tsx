"use client";

import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import { getTool } from "@/lib/tools/registry";
import {
  adminErrorCode,
  fetchAdminFeedback,
  type AdminFeedback,
} from "./admin-api";
import {
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  formatAdminDate,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Tool feedback (#/admin/feedback): up/down totals as big number cards
 * plus the item list (rating icon, tool, reason/message, date).
 */
export function FeedbackPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t, locale } = useI18n();

  const [load, setLoad] = useState<AdminLoad<AdminFeedback>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminFeedback(controller.signal)
      .then((feedback) => {
        if (active) setLoad({ data: feedback, error: null });
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

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.feedback")}
      </h2>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 2 }, (_, index) => (
                <Card key={index} className="gap-0 rounded-xl py-6">
                  <CardContent className="flex items-center gap-4 px-4">
                    <Skeleton className="size-11 rounded-xl" />
                    <div className="space-y-2">
                      <Skeleton className="h-6 w-16" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="mt-6">
              <AdminRowsSkeleton rows={5} rowClassName="h-14" />
            </div>
          </>
        ) : load.data === null ? null : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <FeedbackTotalCard up count={load.data.upCount} />
              <FeedbackTotalCard count={load.data.downCount} />
            </div>

            <div className="mt-6">
              {load.data.items.length === 0 ? (
                <AdminEmpty />
              ) : (
                <ul className="divide-y">
                  {load.data.items.map((item) => {
                    const tool = getTool(item.toolId);
                    return (
                      <li key={item.id} className="flex gap-3 py-3">
                        <span
                          className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-lg",
                            item.rating > 0
                              ? "bg-primary/10 text-primary"
                              : "bg-destructive/10 text-destructive"
                          )}
                          aria-hidden="true"
                        >
                          {item.rating > 0 ? (
                            <ThumbsUp className="size-4" />
                          ) : (
                            <ThumbsDown className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-sm font-medium">
                              {tool ? tool.name[locale] : item.toolId}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {item.toolId}
                            </span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {formatAdminDate(item.createdAt, locale)}
                            </span>
                          </div>
                          {item.reason ? (
                            <p className="text-xs font-medium text-muted-foreground">
                              {item.reason}
                            </p>
                          ) : null}
                          {item.message ? (
                            <p className="mt-1 whitespace-pre-wrap text-sm">
                              {item.message}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function FeedbackTotalCard({ up, count }: { up?: boolean; count: number }) {
  const { t } = useI18n();
  return (
    <Card className="gap-0 rounded-xl py-6">
      <CardContent className="flex items-center gap-4 px-4">
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-xl",
            up
              ? "bg-primary/10 text-primary"
              : "bg-destructive/10 text-destructive"
          )}
          aria-hidden="true"
        >
          {up ? (
            <ThumbsUp className="size-5" />
          ) : (
            <ThumbsDown className="size-5" />
          )}
        </span>
        <span>
          <span className="block text-3xl font-semibold tabular-nums tracking-tight">
            {count}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t(up ? "admin.fb.up" : "admin.fb.down")}
          </span>
        </span>
      </CardContent>
    </Card>
  );
}
