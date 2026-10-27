"use client";

import type { ReactNode } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Info,
  Mail,
  MessagesSquare,
  Scale,
  ShieldCheck,
  ThumbsUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContactForm } from "@/components/doco/pages/contact-form";
import { useI18n } from "@/components/providers/locale-provider";
import {
  enabledToolCount,
  totalToolCount,
} from "@/lib/tools/registry";
import { ROUTES, type StaticPageId } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Phase-6 static pages (privacy / terms / about / contact) on the single
 * visible route: the hash router serves them as "#/page/<id>" views. All
 * content is bilingual i18n (legal.* namespace); bodies are plain strings
 * where "\n\n" splits paragraphs and blocks made purely of "- " lines
 * render as bullet lists.
 */

const PAGE_ICONS: Record<StaticPageId, typeof ShieldCheck> = {
  privacy: ShieldCheck,
  terms: Scale,
  about: Info,
  contact: Mail,
};

const PAGE_CHIPS: Record<StaticPageId, string> = {
  privacy: "bg-success/10 text-success",
  terms: "bg-primary/10 text-primary",
  about: "bg-cta/10 text-cta",
  contact: "bg-chart-4/10 text-chart-4",
};

/** Section keys per page — must match the legal.* i18n namespace. */
const PAGE_SECTIONS: Record<
  Exclude<StaticPageId, "contact">,
  readonly string[]
> = {
  privacy: [
    "summary",
    "files",
    "stored",
    "local",
    "cookies",
    "thirdParty",
    "dpdp",
    "retention",
    "children",
    "changes",
    "contact",
  ],
  terms: [
    "acceptance",
    "service",
    "acceptableUse",
    "responsibility",
    "ip",
    "warranty",
    "liability",
    "changes",
    "law",
    "contact",
  ],
  about: [
    "what",
    "onDevice",
    "modes",
    "bilingual",
    "tech",
    "roadmap",
  ],
};

/** Render a legal body: \n\n paragraphs; "- "-only blocks become lists. */
function SectionBody({ text }: { text: string }) {
  const blocks = text.split("\n\n");
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (lines.every((line) => line.startsWith("- "))) {
          return (
            <ul
              key={index}
              className="mt-4 space-y-2 pl-1 [&>li]:relative [&>li]:pl-4"
            >
              {lines.map((line, lineIndex) => (
                <li
                  key={lineIndex}
                  className="text-sm leading-relaxed text-muted-foreground sm:text-base"
                >
                  <span
                    className="absolute left-0 top-[0.6em] size-1.5 rounded-full bg-cta"
                    aria-hidden="true"
                  />
                  {line.slice(2)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p
            key={index}
            className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base"
          >
            {block}
          </p>
        );
      })}
    </>
  );
}

function InfoCard({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: typeof ThumbsUp;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="rounded-card border border-border bg-card p-6 shadow-xs">
      <div
        className="flex size-10 items-center justify-center rounded-btn bg-cta/10 text-cta"
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </article>
  );
}

export function StaticPageView({ pageId }: { pageId: StaticPageId }) {
  const { t } = useI18n();
  const Icon = PAGE_ICONS[pageId];
  const isLegal = pageId === "privacy" || pageId === "terms";
  /** About bodies interpolate live registry counts ({tools}/{live}/{total}). */
  const aboutParams =
    pageId === "about"
      ? {
          tools: enabledToolCount,
          live: enabledToolCount,
          total: totalToolCount,
        }
      : undefined;

  return (
    <section
      aria-labelledby="static-page-title"
      className="min-w-0"
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-10 pb-16 sm:py-14">
        <a
          href={ROUTES.home}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-btn text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("legal.backHome")}
        </a>

        <header className="mt-6">
          <div
            className={cn(
              "flex size-14 items-center justify-center rounded-[1rem]",
              PAGE_CHIPS[pageId]
            )}
            aria-hidden="true"
          >
            <Icon className="size-7" />
          </div>
          <h1
            id="static-page-title"
            className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t(`legal.${pageId}.title`)}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {t(`legal.${pageId}.subtitle`)}
          </p>
          {isLegal ? (
            <p className="mt-4 inline-flex items-center gap-1.5 rounded-chip border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
              <CalendarDays className="size-3.5" aria-hidden="true" />
              {t("legal.lastUpdated", {
                date: t(`legal.${pageId}.updated`),
              })}
            </p>
          ) : null}
        </header>

        {pageId === "contact" ? (
          <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <ContactForm />
            </div>
            <aside className="flex min-w-0 flex-col gap-4">
              <InfoCard icon={MessagesSquare} title={t("legal.contact.nextTitle")}>
                {t("legal.contact.nextBody")}
              </InfoCard>
              <InfoCard icon={ThumbsUp} title={t("legal.contact.fasterTitle")}>
                {t("legal.contact.fasterBody")}
                <div className="mt-1">
                  <Button
                    asChild
                    variant="outline"
                    size="touch"
                    className="rounded-btn"
                  >
                    <a href={ROUTES.tools}>{t("legal.contact.fasterAction")}</a>
                  </Button>
                </div>
              </InfoCard>
            </aside>
          </div>
        ) : (
          <div className="mt-10 space-y-10">
            {PAGE_SECTIONS[pageId].map((section) => (
              <section
                key={section}
                aria-labelledby={`${pageId}-${section}`}
                className="border-t border-border pt-8 first:border-t-0 first:pt-0"
              >
                <h2
                  id={`${pageId}-${section}`}
                  className="text-lg font-semibold tracking-tight sm:text-xl"
                >
                  {t(`legal.${pageId}.sections.${section}.title`)}
                </h2>
                <SectionBody
                  text={t(
                    `legal.${pageId}.sections.${section}.body`,
                    aboutParams
                  )}
                />
              </section>
            ))}
          </div>
        )}

        <div className="mt-14 overflow-hidden rounded-card border border-border bg-gradient-to-br from-primary/8 via-transparent to-cta/10 p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight sm:text-xl">
            {t("legal.ctaTitle")}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
            {t("legal.ctaBody")}
          </p>
          <Button asChild variant="cta" size="touch" className="mt-6 rounded-btn">
            <a href={ROUTES.tools}>
              {t("legal.ctaAction")}
              <span className="sr-only">
                {" "}
                ({enabledToolCount}/{totalToolCount})
              </span>
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}
