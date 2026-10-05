"use client";

import { useSyncExternalStore, useCallback, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "@/components/doco/modal";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { createLocalSnapshot } from "@/lib/storage/local-snapshot";

/**
 * Request-a-tool (PRD §6.2 empty state + §9 Request a Tool page).
 * Until the Phase 6 API + voting goes live, requests are queued on this
 * device only (localStorage) — stated honestly in the modal copy.
 */

const REQUESTS_KEY = "docopdf-tool-requests";
const CHANGE_EVENT = "docopdf:requests-change";

interface StoredRequest {
  title: string;
  description: string;
  createdAt: number;
}

const EMPTY_REQUESTS: StoredRequest[] = [];

function parseRequests(raw: string): StoredRequest[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_REQUESTS;
    const filtered = parsed.filter(
      (item): item is StoredRequest =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as StoredRequest).title === "string" &&
        typeof (item as StoredRequest).description === "string"
    );
    return filtered.length > 0 ? filtered : EMPTY_REQUESTS;
  } catch {
    return EMPTY_REQUESTS;
  }
}

function writeRequests(value: StoredRequest[]): void {
  try {
    window.localStorage.setItem(REQUESTS_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable — request list lives for this render */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/* Stable snapshot: same array reference until the raw value changes. */
const requestsSnapshot = createLocalSnapshot(
  REQUESTS_KEY,
  parseRequests,
  EMPTY_REQUESTS
);

function currentRequests(): StoredRequest[] {
  try {
    const raw = window.localStorage.getItem(REQUESTS_KEY);
    return raw === null ? EMPTY_REQUESTS : parseRequests(raw);
  } catch {
    return EMPTY_REQUESTS;
  }
}

export function RequestToolModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const requests = useSyncExternalStore(
    subscribe,
    requestsSnapshot,
    () => EMPTY_REQUESTS
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const submit = useCallback(() => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast({ title: t("request.emptyError") });
      return;
    }
    writeRequests([
      ...currentRequests(),
      {
        title: trimmedTitle.slice(0, 80),
        description: description.trim().slice(0, 500),
        createdAt: Date.now(),
      },
    ]);
    setTitle("");
    setDescription("");
    toast({ title: t("request.savedToast") });
  }, [title, description, t, toast]);

  const remove = useCallback((createdAt: number) => {
    writeRequests(
      currentRequests().filter((item) => item.createdAt !== createdAt)
    );
  }, []);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("request.title")}
      description={t("request.description")}
      contentClassName="sm:max-w-lg"
      footer={
        <Button type="button" variant="cta" size="touch" onClick={submit}>
          {t("request.submit")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="request-title">{t("request.titleLabel")}</Label>
          <Input
            id="request-title"
            value={title}
            maxLength={80}
            placeholder={t("request.titlePlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="request-desc">{t("request.descLabel")}</Label>
          <Textarea
            id="request-desc"
            value={description}
            maxLength={500}
            rows={3}
            placeholder={t("request.descPlaceholder")}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {requests.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("request.queuedTitle")}
            </p>
            <ul className="max-h-36 space-y-1 overflow-y-auto scrollbar-thin">
              {requests.map((item) => (
                <li
                  key={item.createdAt}
                  className="flex items-center justify-between gap-2 rounded-btn bg-muted px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-foreground">
                    {item.title}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={t("request.remove")}
                    onClick={() => remove(item.createdAt)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("request.queuedEmpty")}
          </p>
        )}
      </div>
    </Modal>
  );
}
