"use client";

import {
  ArrowRight,
  Cpu,
  Globe,
  Heart,
  Lightbulb,
  Lock,
  Mail,
  MapPin,
  Sparkles,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PageSection,
  PageShell,
  PrivacyCallout,
} from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import { CATEGORIES, liveToolCount, totalToolCount } from "@/lib/tools/registry";

/**
 * About page (PRD §5.4): mission, story, the privacy-first explanation with
 * real registry-driven numbers, tech principles and a contact CTA.
 * All counts come from the tool registry — never hardcoded.
 */
export function AboutPage() {
  const { t } = useI18n();

  const stats: { value: string; label: string }[] = [
    { value: t("about.statTools", { live: liveToolCount, total: totalToolCount }), label: t("about.statToolsLabel") },
    { value: String(CATEGORIES.length), label: t("about.statCategoriesLabel") },
    { value: String(2), label: t("about.statLanguagesLabel") },
    { value: "0", label: t("about.statUploadsLabel") },
  ];

  return (
    <PageShell
      icon={Heart}
      badge={t("about.badge")}
      title={t("about.title")}
      lede={t("about.lede")}
    >
      <PageSection icon={Target} title={t("about.missionTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("about.missionBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("about.missionBody2")}
        </p>
      </PageSection>

      <PageSection icon={Sparkles} title={t("about.statsTitle")}>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <li
              key={stat.label}
              className="rounded-card border border-border bg-surface p-4 text-center"
            >
              <p className="text-2xl font-bold tracking-tight text-primary sm:text-3xl">
                {stat.value}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {stat.label}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {t("about.statsNote")}
        </p>
      </PageSection>

      <PageSection icon={Heart} title={t("about.storyTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("about.storyBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("about.storyBody2")}
        </p>
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <MapPin className="size-4 shrink-0" aria-hidden="true" />
          {t("about.madeInIndia")}
        </p>
      </PageSection>

      <PageSection icon={Lock} title={t("about.privacyTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("about.privacyBody")}
        </p>
        <ol className="space-y-2.5">
          {[1, 2, 3].map((index) => (
            <li
              key={index}
              className="flex items-start gap-3 rounded-card border border-border bg-surface px-4 py-3"
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
                aria-hidden="true"
              >
                {index}
              </span>
              <p className="text-sm text-muted-foreground">
                {t(`about.flow${index}`)}
              </p>
            </li>
          ))}
        </ol>
        <PrivacyCallout
          title={t("about.calloutTitle")}
          body={t("about.calloutBody")}
        />
      </PageSection>

      <PageSection icon={Lightbulb} title={t("about.principlesTitle")}>
        <ul className="space-y-2.5">
          {[1, 2, 3, 4, 5].map((index) => (
            <li key={index} className="flex items-start gap-3">
              <Cpu
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="text-pretty text-sm text-muted-foreground">
                {t(`about.principle${index}`)}
              </p>
            </li>
          ))}
        </ul>
      </PageSection>

      <section className="rounded-card border border-primary/25 bg-primary/5 p-6 text-center sm:p-8">
        <Globe
          className="mx-auto size-6 text-primary"
          aria-hidden="true"
        />
        <h2 className="mt-3 text-lg font-semibold tracking-tight">
          {t("about.ctaTitle")}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {t("about.ctaBody")}
        </p>
        <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild variant="cta" size="touch" className="rounded-btn">
            <a href={ROUTES.tools}>
              {t("header.seeAllTools", { count: totalToolCount })}
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </Button>
          <Button asChild variant="outline" size="touch" className="rounded-btn">
            <a href={ROUTES.page("contact")}>
              <Mail className="size-4" aria-hidden="true" />
              {t("about.ctaContact")}
            </a>
          </Button>
        </div>
      </section>
    </PageShell>
  );
}
