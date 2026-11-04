"use client";

import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useMounted } from "@/hooks/use-mounted";

const ORDER = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof ORDER)[number];

const ICONS: Record<ThemeChoice, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * Theme toggle (PRD §5.4: system / light / dark).
 * Cycles light -> dark -> system; persists via next-themes (localStorage),
 * no flash on load (next-themes pre-hydration script + suppressHydrationWarning).
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const mounted = useMounted();

  const current: ThemeChoice = ORDER.includes(
    (theme ?? "system") as ThemeChoice
  )
    ? ((theme ?? "system") as ThemeChoice)
    : "system";
  const next: ThemeChoice = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = ICONS[current];

  const label = mounted
    ? t("theme.switchTo", { theme: t(`theme.${next}`) })
    : t("theme.label");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 rounded-btn"
      aria-label={label}
      title={label}
      disabled={!mounted}
      onClick={() => setTheme(next)}
    >
      {mounted ? (
        <Icon className="size-5" aria-hidden="true" />
      ) : (
        <Sun className="size-5 opacity-0" aria-hidden="true" />
      )}
    </Button>
  );
}
