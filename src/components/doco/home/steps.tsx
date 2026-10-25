"use client";

import { Download, FileUp, Settings2 } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";

/** "How it works" — Select > Choose > Download (PRD §6.1). */
export function Steps() {
  const { t } = useI18n();

  const steps = [
    {
      icon: FileUp,
      title: t("steps.s1title"),
      description: t("steps.s1desc"),
    },
    {
      icon: Settings2,
      title: t("steps.s2title"),
      description: t("steps.s2desc"),
    },
    {
      icon: Download,
      title: t("steps.s3title"),
      description: t("steps.s3desc"),
    },
  ];

  return (
    <section id="how" aria-labelledby="steps-title" className="scroll-mt-20">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="steps-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("steps.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t("steps.subtitle")}
          </p>
        </div>

        <ol className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {steps.map(({ icon: Icon, title, description }, index) => (
            <li
              key={title}
              className="group relative overflow-hidden rounded-card border border-border bg-card p-6 shadow-xs transition-shadow hover:shadow-md"
            >
              <span
                aria-hidden="true"
                className="text-gradient-brand pointer-events-none absolute -top-2 right-4 select-none text-6xl font-bold leading-none tabular-nums opacity-15 transition-opacity group-hover:opacity-25"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="flex size-12 items-center justify-center rounded-btn bg-primary/10 text-primary">
                <Icon className="size-6" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
