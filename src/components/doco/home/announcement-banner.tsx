"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Sparkles, X } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { totalToolCount } from "@/lib/tools/registry";

const BANNER_STORAGE_KEY = "docopdf-banner-dismissed";
const BANNER_EVENT = "docopdf:banner-dismissed";

function subscribeToBanner(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(BANNER_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(BANNER_EVENT, callback);
  };
}

function getBannerSnapshot(): boolean {
  try {
    return window.localStorage.getItem(BANNER_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getBannerServerSnapshot(): boolean {
  return false;
}

/**
 * Thin announcement banner above the header (PRD §5.1).
 * Dismissible; the choice persists in localStorage (external store via
 * useSyncExternalStore — hydration-safe, no setState-in-effect).
 */
export function AnnouncementBanner() {
  const { t } = useI18n();
  const dismissed = useSyncExternalStore(
    subscribeToBanner,
    getBannerSnapshot,
    getBannerServerSnapshot
  );

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(BANNER_STORAGE_KEY, "1");
    } catch {
      /* storage unavailable — banner hides until the next render sync */
    }
    window.dispatchEvent(new Event(BANNER_EVENT));
  }, []);

  if (dismissed) return null;

  return (
    <div role="status" className="bg-primary text-primary-foreground">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-2 px-4 py-2">
        <Sparkles className="size-4 shrink-0" aria-hidden="true" />
        <p
          className="min-w-0 truncate text-center text-xs sm:text-sm"
          title={t("banner.phase0", { count: totalToolCount })}
        >
          {t("banner.phase0", { count: totalToolCount })}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("banner.dismiss")}
          className="ml-1 -my-2.5 flex size-11 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-white/15 focus-visible:ring-[3px] focus-visible:ring-white/60"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
