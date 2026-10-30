"use client";

import {
  AlertTriangle,
  Ban,
  FileText,
  Gavel,
  IndianRupee,
  Mail,
  Scale,
  ServerCrash,
  RefreshCw,
  Wrench,
} from "lucide-react";

import {
  PageSection,
  PageShell,
  PrivacyCallout,
} from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";

/**
 * Terms of Service page (PRD §5.4): acceptance, service description,
 * acceptable use, user content ownership, no-warranty on conversion
 * accuracy, liability limits, billing, termination, Indian governing
 * law and the change policy.
 */
export function TermsPage() {
  const { t } = useI18n();
  const routes = useLocalizedRoutes();

  return (
    <PageShell
      icon={Scale}
      badge={t("terms.badge")}
      title={t("terms.title")}
      lede={t("terms.lede")}
      updated={t("terms.updated")}
    >
      <PageSection icon={FileText} title={t("terms.acceptTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.acceptBody")}
        </p>
      </PageSection>

      <PageSection icon={Wrench} title={t("terms.serviceTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.serviceBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("terms.serviceBody2")}
        </p>
        <PrivacyCallout
          title={t("terms.serviceCalloutTitle")}
          body={t("terms.serviceCalloutBody")}
        />
      </PageSection>

      <PageSection icon={Ban} title={t("terms.useTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.useIntro")}
        </p>
        <ul className="space-y-2">
          {[1, 2, 3, 4, 5].map((index) => (
            <li key={index} className="flex items-start gap-2.5">
              <Ban
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t(`terms.use${index}`)}
              </p>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection icon={AlertTriangle} title={t("terms.warrantyTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.warrantyBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("terms.warrantyBody2")}
        </p>
      </PageSection>

      <PageSection icon={ServerCrash} title={t("terms.liabilityTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.liabilityBody")}
        </p>
      </PageSection>

      <PageSection icon={IndianRupee} title={t("terms.billingTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.billingBody")}
        </p>
      </PageSection>

      <PageSection icon={RefreshCw} title={t("terms.terminationTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.terminationBody")}
        </p>
      </PageSection>

      <PageSection icon={Gavel} title={t("terms.lawTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.lawBody")}
        </p>
      </PageSection>

      <PageSection icon={RefreshCw} title={t("terms.changesTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.changesBody")}
        </p>
      </PageSection>

      <PageSection icon={Mail} title={t("terms.contactTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("terms.contactBody")}
        </p>
        <p>
          <a
            href={routes.page("contact")}
            className="inline-flex min-h-11 items-center rounded-btn text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("terms.contactLink")}
          </a>
        </p>
      </PageSection>
    </PageShell>
  );
}
