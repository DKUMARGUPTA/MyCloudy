"use client";

import { BadgeCheck, Languages, LayoutGrid, Lock, ShieldCheck, UserX, WifiOff, Wrench } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { SmartDropZone } from "@/components/sidocs/home/smart-drop-zone";
import { useI18n } from "@/components/providers/locale-provider";
import { CATEGORIES, totalToolCount } from "@/lib/tools/registry";
import { ROUTES } from "@/hooks/use-hash-route";

/**
 * Home hero (PRD §6.1, P11 visual overhaul): layered depth background
 * (brand glow + dot grid + floating orbs), staggered framer-motion
 * entrance, animated gradient headline and a registry-driven stats row.
 * Motion respects prefers-reduced-motion (static fall-back).
 */
export function Hero() {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();

  const enter = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.55, delay, ease: [0.21, 0.6, 0.35, 1] as const },
        };

  const trustBadges = [
    { icon: Lock, label: t("hero.badgePrivate"), variant: "private" as const },
    { icon: UserX, label: t("hero.badgeNoSignup"), variant: "outline" as const },
    { icon: BadgeCheck, label: t("hero.badgeFree"), variant: "outline" as const },
    { icon: WifiOff, label: t("hero.badgeOffline"), variant: "outline" as const },
  ];

  const stats = [
    {
      icon: Wrench,
      value: String(totalToolCount),
      label: t("hero.statTools"),
    },
    {
      icon: LayoutGrid,
      value: String(CATEGORIES.length),
      label: t("hero.statCategories"),
    },
    {
      icon: Languages,
      value: "2",
      label: t("hero.statLanguages"),
    },
    {
      icon: ShieldCheck,
      value: "100%",
      label: t("hero.statOnDevice"),
    },
  ];

  return (
    <section id="top" className="relative overflow-hidden">
      {/* Layered depth: brand glow → dot grid → floating orbs */}
      <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
      <div aria-hidden="true" className="hero-dots absolute inset-0 -z-10 opacity-60" />
      <div
        aria-hidden="true"
        className="animate-float-slow absolute -left-24 top-24 -z-10 size-56 rounded-full bg-primary/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="animate-float-slower absolute -right-20 top-40 -z-10 size-72 rounded-full bg-cta/10 blur-3xl"
      />

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-14 text-center sm:pb-20 sm:pt-20">
        <motion.div {...enter(0)}>
          <Badge
            variant="outline"
            className="rounded-chip border-primary/25 bg-primary/5 px-3 py-1 text-xs text-primary sm:text-sm"
          >
            <Lock className="size-3.5" aria-hidden="true" />
            {t("hero.eyebrowBadge")}
          </Badge>
        </motion.div>

        <motion.h1
          {...enter(0.08)}
          className="mx-auto mt-6 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl"
        >
          {t("hero.title1")}{" "}
          <span className="text-gradient-shine">{t("hero.title2")}</span>
        </motion.h1>

        <motion.p
          {...enter(0.16)}
          className="mx-auto mt-5 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg"
        >
          {t("hero.subtitle")}
        </motion.p>

        <motion.div {...enter(0.24)} className="mt-8">
          <SmartDropZone />
        </motion.div>

        <motion.p {...enter(0.3)} className="mt-4 text-xs text-muted-foreground">
          <a
            href={ROUTES.tools}
            className="rounded-btn font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("hero.browseAll", { count: totalToolCount })}
          </a>
        </motion.p>

        <motion.ul {...enter(0.36)} className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {trustBadges.map(({ icon: Icon, label, variant }, i) => (
            <motion.li
              key={label}
              {...(reduceMotion
                ? {}
                : {
                    initial: { opacity: 0, scale: 0.9 },
                    animate: { opacity: 1, scale: 1 },
                    transition: { duration: 0.35, delay: 0.42 + i * 0.07 },
                  })}
            >
              <Badge
                variant={variant}
                className="rounded-chip px-3 py-1 text-xs sm:text-sm"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </Badge>
            </motion.li>
          ))}
        </motion.ul>

        {/* Registry-driven stats row (P11) */}
        <motion.div
          {...enter(0.5)}
          aria-label={t("hero.statAriaLabel")}
          className="mx-auto mt-8 grid max-w-2xl grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3"
        >
          {stats.map(({ icon: Icon, value, label }) => (
            <div
              key={label}
              className="group flex items-center gap-2.5 rounded-card border border-border/70 bg-card/60 px-3.5 py-2.5 text-left shadow-xs backdrop-blur-sm transition-colors hover:border-primary/30"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary" aria-hidden="true">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-lg font-bold leading-none tabular-nums text-foreground">
                  {value}
                </span>
                <span className="mt-1 block truncate text-[11px] leading-none text-muted-foreground">
                  {label}
                </span>
              </span>
            </div>
          ))}
        </motion.div>

        <motion.p {...enter(0.56)} className="mt-6 text-xs text-muted-foreground">
          {t("hero.toolsPlanned", { count: totalToolCount })} ·{" "}
          {t("hero.bilingual")}
        </motion.p>
      </div>
    </section>
  );
}
