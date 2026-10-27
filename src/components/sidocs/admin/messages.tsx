"use client";

import { useEffect, useState } from "react";
import { CheckCheck, MailOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import {
  adminErrorCode,
  fetchAdminMessages,
  patchAdminMessage,
  type AdminMessage,
  type AdminMessageStatus,
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
 * Contact messages (#/admin/messages): cards with sender, category, body
 * and new/read/done status; mark read / mark done actions PATCH and
 * update the row in place from the returned message.
 */

const STATUS_BADGE_VARIANT: Record<
  AdminMessageStatus,
  "new" | "secondary" | "private"
> = {
  new: "new",
  read: "secondary",
  done: "private",
};

export function MessagesPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [load, setLoad] = useState<AdminLoad<AdminMessage[]>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminMessages(controller.signal)
      .then((data) => {
        if (active) setLoad({ data: data.messages, error: null });
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

  async function setStatus(
    message: AdminMessage,
    status: AdminMessageStatus
  ): Promise<void> {
    setBusyId(message.id);
    try {
      const { message: updated } = await patchAdminMessage(message.id, status);
      setLoad((prev) =>
        prev.data
          ? {
              data: prev.data.map((item) =>
                item.id === updated.id ? updated : item
              ),
              error: null,
            }
          : prev
      );
      toast({ title: t(`admin.msg.status.${status}`) });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") onForbidden();
      else toast({ title: adminErrorText(t, code), variant: "destructive" });
    } finally {
      setBusyId(null);
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

  const messages = load.data ?? [];

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.messages")}
      </h2>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <AdminRowsSkeleton rows={4} />
        ) : messages.length === 0 ? (
          <AdminEmpty />
        ) : (
          <ul className="space-y-3">
            {messages.map((message) => (
              <li key={message.id}>
                <Card className="gap-0 rounded-xl py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2 px-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{message.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {message.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={STATUS_BADGE_VARIANT[message.status]}
                        className="font-normal"
                      >
                        {t(`admin.msg.status.${message.status}`)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatAdminDate(message.createdAt, locale)}
                      </span>
                    </div>
                  </div>
                  <div className="px-4">
                    <p className="whitespace-pre-wrap text-sm">
                      {message.message}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <Badge variant="outline" className="font-normal">
                        {message.category}
                      </Badge>
                      <div className="flex flex-wrap gap-2">
                        {message.status === "new" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === message.id}
                            onClick={() => void setStatus(message, "read")}
                          >
                            <MailOpen
                              className="size-4"
                              aria-hidden="true"
                            />
                            {t("admin.msg.markRead")}
                          </Button>
                        ) : null}
                        {message.status !== "done" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === message.id}
                            onClick={() => void setStatus(message, "done")}
                          >
                            <CheckCheck className="size-4" aria-hidden="true" />
                            {t("admin.msg.markDone")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
