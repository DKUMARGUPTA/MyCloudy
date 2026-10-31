"use client";

import { useEffect, useState } from "react";
import { CheckCheck, Inbox, Loader2, MailOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/doco/empty-state";
import { Modal } from "@/components/doco/modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  fetchMessages,
  messageUpdate,
  type AdminMessageDto,
} from "@/lib/admin-client";
import { fmtDateTime } from "@/components/doco/admin/shared";

const STATUS_LABEL_KEY: Record<string, string> = {
  new: "admin.messages.stNew",
  read: "admin.messages.stRead",
  done: "admin.messages.stDone",
};

function statusVariant(status: string): "new" | "secondary" | "private" {
  if (status === "new") return "new";
  if (status === "done") return "private";
  return "secondary";
}

/**
 * MessagesTab — the contact-form inbox. Click a row to read the full
 * message; mark new → read → done right from the modal.
 */
export function MessagesTab({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [messages, setMessages] = useState<AdminMessageDto[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState<AdminMessageDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchMessages().then((res) => {
      if (!active) return;
      if (res) setMessages(res.messages);
      else {
        setMessages([]);
        toast({ title: t("admin.toast.failed"), variant: "destructive" });
      }
    });
    return () => {
      active = false;
    };
  }, [reloadKey, toast, t]);

  const mark = async (id: string, status: "new" | "read" | "done") => {
    setBusy(true);
    const updated = await messageUpdate(id, status);
    setBusy(false);
    if (!updated) {
      toast({ title: t("admin.toast.failed"), variant: "destructive" });
      return;
    }
    toast({ title: t("admin.toast.messageSaved") });
    setMessages((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, status } : m)) : prev
    );
    setOpen((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    onChanged();
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      {messages === null ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
      ) : messages && messages.length > 0 ? (
        <ul className="space-y-3">
          {messages.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setOpen(m)}
                className="w-full rounded-card border border-border bg-surface p-4 text-left outline-none transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {m.name}
                    </span>
                    <Badge variant={statusVariant(m.status)} className="rounded-chip">
                      {t(STATUS_LABEL_KEY[m.status] ?? "admin.messages.stNew")}
                    </Badge>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {fmtDateTime(m.createdAt, locale)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {m.email} · {m.category}
                </p>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                  {m.message}
                </p>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Inbox />} title={t("admin.messages.empty")} />
      )}

      {/* Read modal */}
      <Modal
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={open ? `${open.name} · ${open.category}` : ""}
        description={open ? `${open.email} · ${fmtDateTime(open.createdAt, locale)}` : undefined}
        contentClassName="sm:max-w-lg"
        footer={
          open ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="rounded-btn"
                onClick={() => void mark(open.id, "new")}
                disabled={busy || open.status === "new"}
              >
                <Inbox className="size-4" aria-hidden="true" />
                {t("admin.messages.markNew")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="rounded-btn"
                onClick={() => void mark(open.id, "read")}
                disabled={busy || open.status === "read"}
              >
                <MailOpen className="size-4" aria-hidden="true" />
                {t("admin.messages.markRead")}
              </Button>
              <Button
                type="button"
                size="touch"
                className="rounded-btn"
                onClick={() => void mark(open.id, "done")}
                disabled={busy || open.status === "done"}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCheck className="size-4" aria-hidden="true" />
                )}
                {t("admin.messages.markDone")}
              </Button>
            </>
          ) : null
        }
      >
        {open ? (
          <ScrollArea className="max-h-64 rounded-btn border border-border bg-muted/30 px-3 py-2">
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {open.message}
            </p>
          </ScrollArea>
        ) : null}
      </Modal>
    </div>
  );
}
