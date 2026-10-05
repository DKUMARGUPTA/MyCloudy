"use client";

import { BadgeCheck, ShieldCheck, Zap } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";

/** Why DocoPDF — 3 cards (PRD §6.1). */
export function Why() {
  const { t } = useI18n();

  const cards = [
    {
      icon: ShieldCheck,
      chip: "bg-success/10 text-success",
      title: t("why.privateTitle"),
      description: t("why.privateDesc"),
    },
    {
      icon: Zap,
      chip: "bg-cta/10 text-cta",
      title: t("why.fastTitle"),
      description: t("why.fastDesc"),
    },
    {
      icon: BadgeCheck,
      chip: "bg-primary/10 text-primary",
      title: t("why.freeTitle"),
      description: t("why.freeDesc"),
    },
  ];

  return (
    <section id="why" aria-labelledby="why-title" className="scroll-mt-20">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="why-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("why.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">{t("why.subtitle")}</p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cards.map(({ icon: Icon, chip, title, description }) => (
            <article
              key={title}
              className="rounded-card border border-border bg-card p-6 shadow-xs"
            >
              <div
                className={cn(
                  "flex size-12 items-center justify-center rounded-btn",
                  chip
                )}
                aria-hidden="true"
              >
                <Icon className="size-6" />
              </div>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
