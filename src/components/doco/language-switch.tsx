"use client";

import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { locales, type Locale } from "@/i18n";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics/ga4";

/**
 * EN | हिं language switch (PRD §5.1).
 * Persists the choice in localStorage and updates <html lang>.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  const { toast } = useToast();

  const change = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
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
