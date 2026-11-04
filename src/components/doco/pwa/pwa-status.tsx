"use client";

import { useSyncExternalStore } from "react";
import { Download, WifiOff } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { usePwa } from "@/hooks/use-pwa";
import { promptInstall } from "@/components/doco/pwa/pwa-store";

/**
 * Footer PWA status (P7-PWA):
 *  - offline → amber pill (on-device tools keep working)
 *  - online + installable → "Install app" button (user-dismissable)
 * Renders null when neither applies, so the footer stays clean.
 */

const DISMISS_KEY = "docopdf:install-dismissed";
const DISMISS_EVENT = "docopdf:install-dismiss";

/* localStorage as an external store (same pattern as the locale provider). */
function subscribeDismiss(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(DISMISS_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(DISMISS_EVENT, callback);
  };
}

function getDismissedSnapshot(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function getDismissedServerSnapshot(): boolean {
  return false;
}

export function PwaStatus() {
  const { t } = useI18n();
  const { online, installPrompt, installing, installed } = usePwa();
  const dismissed = useSyncExternalStore(
    subscribeDismiss,
    getDismissedSnapshot,
    getDismissedServerSnapshot
  );

  function persistDismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — no persistence */
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }

  if (!online) {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <span className="inline-flex items-center gap-1.5 rounded-chip border border-amber-300/70 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <WifiOff className="size-3.5" aria-hidden="true" />
          {t("pwa.offlineTitle")}
        </span>
        {t("pwa.offlineShort")}
      </p>
    );
  }

  if (!installPrompt || dismissed || installed) return null;

  const onInstallClick = async () => {
    const outcome = await promptInstall();
    if (outcome === "dismissed") {
      persistDismiss();
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onInstallClick}
        disabled={installing}
        className="inline-flex min-h-11 items-center gap-2 rounded-btn bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <Download className="size-4" aria-hidden="true" />
        {installing ? t("pwa.installing") : t("pwa.install")}
      </button>
      <p className="text-xs text-muted-foreground">{t("pwa.installHint")}</p>
    </div>
  );
}
