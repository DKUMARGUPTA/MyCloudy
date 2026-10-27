"use client";

import { useEffect, useRef } from "react";

import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { ToastAction } from "@/components/ui/toast";
import { ensurePwaListeners } from "@/components/doco/pwa/pwa-store";

/**
 * Renderless PWA controller (P7-PWA) — mounts once from the root layout:
 *
 *  - registers /sw.js (app shell + runtime asset caching → offline tools)
 *  - shows an "Update ready → Reload" toast when a new service worker is
 *    waiting, and reloads on controllerchange ONLY after the user accepts
 *    (the first install's clients.claim() must not reload the page)
 *  - toasts offline ↔ online transitions
 */

export function ServiceWorkerRegister() {
  const { t } = useI18n();
  const { toast } = useToast();
  // Armed only when the user accepts the update toast — a controllerchange
  // fired by a first-install claim (or strict-mode remount) must not reload.
  const reloadOnControllerChange = useRef(false);
  const reloaded = useRef(false);

  useEffect(() => {
    ensurePwaListeners();

    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        // New version installed and waiting for activation.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              toast({
                title: t("pwa.updateTitle"),
                description: t("pwa.updateBody"),
                duration: 60000,
                action: (
                  <ToastAction
                    altText={t("pwa.reload")}
                    onClick={() => {
                      reloadOnControllerChange.current = true;
                      installing.postMessage({ type: "SKIP_WAITING" });
                    }}
                  >
                    {t("pwa.reload")}
                  </ToastAction>
                ),
              });
            }
          });
        });
      })
      .catch(() => {
        /* No service worker support or insecure context — the site works
           fine online-only; stay silent. */
      });

    const onControllerChange = () => {
      if (reloadOnControllerChange.current && !reloaded.current) {
        reloaded.current = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, []);

  // Offline ↔ online toasts (debounced mount so the toast portal is ready).
  useEffect(() => {
    const show = (online: boolean) => {
      toast({
        title: online ? t("pwa.onlineTitle") : t("pwa.offlineTitle"),
        description: online ? undefined : t("pwa.offlineBody"),
      });
    };

    let initialOnline = true;
    let armed = false;
    const armTimer = window.setTimeout(() => {
      armed = true;
      initialOnline = window.navigator.onLine;
      // Page was loaded while offline — announce it once the portal is up.
      if (!initialOnline) show(false);
    }, 1500);

    const onOffline = () => {
      if (armed) show(false);
    };
    const onOnline = () => {
      if (armed && !initialOnline) show(true);
      initialOnline = false;
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearTimeout(armTimer);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
