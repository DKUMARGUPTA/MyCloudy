"use client";

import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { locales, type Locale } from "@/i18n";
import { notifyRouteChanged } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics/ga4";

/**
 * EN | हिं language switch (PRD §5.1).
 * Persists the choice in localStorage and updates <html lang>.
 *
 * R17 real-path router: the visible URL is mirrored too ("/tool/x" ↔
 * "/hi/tool/x") via replaceState — no reload, no route-store event (the
 * view is unchanged); only the address bar (and future shares/links)
 * reflect the chosen locale. Locales only exist for app paths, so api/,
 * _next/ and friends are left untouched.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  const { toast } = useToast();

  const mirrorUrl = (next: Locale): void => {
    try {
      const { pathname, search } = window.location;
      const isHindiPath = pathname === "/hi" || pathname.startsWith("/hi/");
      const wantsHindiPath = next === "hi";
      if (isHindiPath === wantsHindiPath) return;
      let target: string;
      if (wantsHindiPath) {
        target = pathname === "/" ? "/hi" : `/hi${pathname}`;
      } else {
        target = pathname === "/hi" ? "/" : pathname.slice("/hi".length);
      }
      window.history.replaceState(null, "", target + search);
      /* Re-sync the route store (R19 Phase 5): every localized link href
       * derives from the URL's /hi-ness, so the replaceState flip must
       * wake the useSyncExternalStore subscribers — otherwise the DOM
       * hrefs keep the OLD locale's prefix until the next navigation. */
      notifyRouteChanged();
    } catch {
      /* history unavailable — the UI flip alone is fine */
    }
  };

  const change = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    mirrorUrl(next);
    track("language_switch", { from: locale, to: next });
    toast({ title: t("language.changedTo", { language: t(`language.${next}`) }) });
  };

  return (
    <div
      role="group"
      aria-label={t("language.label")}
      className={cn(
        "inline-flex items-center rounded-btn border border-border bg-background p-0.5",
        className
      )}
    >
      {locales.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => change(code)}
          aria-pressed={locale === code}
          aria-label={t("language.switchTo", { language: t(`language.${code}`) })}
          className={cn(
            "h-10 min-w-11 rounded-[calc(0.75rem-2px)] px-2.5 text-sm font-medium outline-none transition-colors",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            locale === code
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(`language.${code}`)}
        </button>
      ))}
    </div>
  );
}
