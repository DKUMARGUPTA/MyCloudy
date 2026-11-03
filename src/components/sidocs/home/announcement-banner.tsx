"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Megaphone, X } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";

const BANNER_STORAGE_KEY = "sidocs-banner-dismissed";
const BANNER_EVENT = "sidocs:banner-dismissed";

interface AdminAnnouncement {
  id: string;
  textEn: string;
  textHi: string;
  variant: "info" | "success" | "warning";
  until?: string;
}

function subscribeToBanner(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(BANNER_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(BANNER_EVENT, callback);
  };
}

function getDismissedId(): string | null {
  try {
    return window.localStorage.getItem(BANNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getBannerSnapshot(): string | null {
  return getDismissedId();
}

function getBannerServerSnapshot(): string | null {
  return null;
}

const VARIANT_CLASSES: Record<AdminAnnouncement["variant"], string> = {
  info: "bg-primary text-primary-foreground",
  success: "bg-emerald-700 text-white",
  warning: "bg-amber-500 text-amber-950",
};

/**
 * Announcement banner above the header. P12: DB-driven — the admin
 * console publishes announcements (EN+HI, variant, optional expiry) into
 * the site "announcements" setting; this fetches the active list once per
 * mount and shows the first one the user has not dismissed (dismissal is
 * per-announcement id, so publishing a new banner re-shows it). No active
 * announcement → nothing renders (the old static phase text is retired).
 */
export function AnnouncementBanner() {
  const { locale } = useI18n();
  const [current, setCurrent] = useState<AdminAnnouncement | null>(null);
  const [ready, setReady] = useState(false);
  const dismissedId = useSyncExternalStore(
    subscribeToBanner,
    getBannerSnapshot,
    getBannerServerSnapshot
  );

  useEffect(() => {
    let active = true;
    fetch("/api/announcements", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { announcements: [] }))
      .then((data: { announcements?: AdminAnnouncement[] }) => {
        if (active) setCurrent(data.announcements?.[0] ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    try {
      if (current) {
        window.localStorage.setItem(BANNER_STORAGE_KEY, current.id);
      }
    } catch {
      /* storage unavailable — banner hides until the next render sync */
    }
    window.dispatchEvent(new Event(BANNER_EVENT));
  }, [current]);

  if (!ready || !current || dismissedId === current.id) return null;

  const text = locale === "hi" ? current.textHi : current.textEn;

  return (
    <div
      role="status"
      className={VARIANT_CLASSES[current.variant] ?? VARIANT_CLASSES.info}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-2 px-4 py-2">
        <Megaphone className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 truncate text-center text-xs sm:text-sm">
          {text}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="ml-1 shrink-0 rounded-md p-1.5 outline-none transition-colors hover:bg-black/10 focus-visible:ring-[3px] focus-visible:ring-white/60"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
