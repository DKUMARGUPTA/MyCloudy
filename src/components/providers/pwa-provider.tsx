"use client";

import { useEffect } from "react";

import { useI18n } from "@/components/providers/locale-provider";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  captureInstallPrompt,
  markInstalled,
} from "@/lib/pwa/install-prompt";

/**
 * PWA provider (Phase 7): registers /sw.js, surfaces "update available"
 * as a toast with a reload action (the SW never skips waiting on its own,
 * so a mid-task reload can never destroy work), and feeds the
 * beforeinstallprompt store (footer shows the Install button only when
 * the browser offers it).
 *
 * Rendered once from the root layout; renders nothing itself.
 */

type ReloadOffer = (worker: ServiceWorker | null) => void;

/**
 * Watch a registration for a waiting worker — covers every race: the boot
 * case (update installed before the page's JS attached listeners) and the
 * mid-install case (polls until the worker lands in "waiting").
 * Returns a cleanup that stops the poll.
 */
function watchForWaitingWorker(
  registration: ServiceWorkerRegistration,
  offer: ReloadOffer
): () => void {
  offer(registration.waiting);

  const poll = setInterval(() => offer(registration.waiting), 500);
  const stop = setTimeout(() => clearInterval(poll), 15_000);
  return () => {
    clearTimeout(stop);
    clearInterval(poll);
  };
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reloading = false;
    let toastShown = false;

    const offerReload: ReloadOffer = (worker) => {
      if (!worker || toastShown || !navigator.serviceWorker.controller) {
        return;
      }
      toastShown = true;
      toast({
        title: t("pwa.updateTitle"),
        description: t("pwa.updateBody"),
        duration: 600_000, // keep the choice available, dismissable anytime
        action: (
          <ToastAction
            altText={t("pwa.reload")}
            onClick={() => worker.postMessage("SKIP_WAITING")}
          >
            {t("pwa.reload")}
          </ToastAction>
        ),
      });
    };

    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      captureInstallPrompt(event);
    };

    const onAppInstalled = () => {
      markInstalled();
      toast({
        title: t("pwa.installedTitle"),
        description: t("pwa.installedBody"),
      });
    };

    const cleanups: Array<() => void> = [];

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register(
          "/sw.js",
          { scope: "/" }
        );

        cleanups.push(watchForWaitingWorker(registration, offerReload));

        // Updates detected while the page stays open.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") {
              offerReload(registration.waiting ?? installing);
            }
          });
        });

        // Chrome re-checks sw.js on navigation; nudge mid-session deploys.
        const hourly = setInterval(
          () => void registration.update().catch(() => undefined),
          60 * 60_000
        );
        cleanups.push(() => clearInterval(hourly));
      } catch {
        // SW registration failure is non-fatal — the site works online.
      }
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    void register();

    return () => {
      for (const cleanup of cleanups) cleanup();
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [t]);

  return <>{children}</>;
}
