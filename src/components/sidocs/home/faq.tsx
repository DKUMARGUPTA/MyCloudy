"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useI18n } from "@/components/providers/locale-provider";

/**
 * Home FAQ (SEO surface): the questions people actually search before
 * picking a PDF site — free?, JPG→PDF?, PDF→Word?, privacy?, "without
 * Adobe Acrobat"?, Hindi? — answered honestly with the live tools.
 * The FAQPage JSON-LD in src/app/layout.tsx mirrors these six in
 * English; keep both in sync when editing copy.
 */
const FAQ_KEYS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;

export function Faq() {
  const { t } = useI18n();

  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20">
      <div className="mx-auto w-full max-w-3xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="faq-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("faq.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">{t("faq.subtitle")}</p>
        </div>

        <Accordion
          type="single"
          collapsible
          className="mt-8 rounded-card border border-border bg-card px-4 shadow-xs sm:px-6"
        >
          {FAQ_KEYS.map((key, index) => (
            <AccordionItem key={key} value={key}>
              <AccordionTrigger className="text-base">
                {t(`faq.${key}`)}
              </AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                {t(`faq.a${index + 1}`)}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
