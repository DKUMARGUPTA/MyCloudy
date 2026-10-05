"use client";

import { ArrowRight, BadgeCheck, Lock, UserX, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { totalToolCount } from "@/lib/tools/registry";
import { ROUTES } from "@/hooks/use-hash-route";

/**
 * Home hero (PRD §6.1).
 * The interactive Smart Drop Zone arrives with Phase 2 (it needs OPFS +
 * the ToolShell to route a dropped file) — until then the hero carries the
 * honest value proposition + trust badges and links into the discovery views.
 */
export function Hero() {
  const { t } = useI18n();

  const trustBadges = [
    { icon: Lock, label: t("hero.badgePrivate"), variant: "private" as const },
    {
      icon: UserX,
      label: t("hero.badgeNoSignup"),
      variant: "outline" as const,
    },
    {
      icon: BadgeCheck,
      label: t("hero.badgeFree"),
      variant: "outline" as const,
    },
    {
      icon: WifiOff,
      label: t("hero.badgeOffline"),
      variant: "outline" as const,
    },
  ];

  return (
    <section id="top" className="relative overflow-hidden">
      <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-14 text-center sm:pb-20 sm:pt-20">
        <Badge
          variant="outline"
          className="rounded-chip border-primary/25 bg-primary/5 px-3 py-1 text-xs text-primary sm:text-sm"
        >
          <Lock className="size-3.5" aria-hidden="true" />
          {t("hero.eyebrowBadge")}
        </Badge>

        <h1 className="mx-auto mt-6 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
          {t("hero.title1")}{" "}
          <span className="text-gradient-brand">{t("hero.title2")}</span>
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
          {t("hero.subtitle")}
        </p>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            size="touch"
            variant="default"
            className="w-full px-8 text-base sm:w-auto"
          >
            <a href={ROUTES.tools}>
              {t("hero.primaryCta")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </Button>
          <Button
            asChild
            size="touch"
            variant="outline"
            className="w-full px-8 text-base sm:w-auto"
          >
            <a href="#how">{t("hero.secondaryCta")}</a>
          </Button>
        </div>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {trustBadges.map(({ icon: Icon, label, variant }) => (
            <li key={label}>
              <Badge
                variant={variant}
                className="rounded-chip px-3 py-1 text-xs sm:text-sm"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </Badge>
            </li>
          ))}
        </ul>

        <p className="mt-6 text-xs text-muted-foreground">
          {t("hero.toolsPlanned", { count: totalToolCount })} ·{" "}
          {t("hero.bilingual")}
        </p>
      </div>
    </section>
  );
}
