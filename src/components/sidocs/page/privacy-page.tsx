"use client";

import {
  Baby,
  CalendarClock,
  Database,
  FileX2,
  Globe2,
  Lock,
  Mail,
  ScrollText,
  Share2,
  ShieldCheck,
  UserCheck,
} from "lucide-react";

import {
  KeyValueList,
  PageSection,
  PageShell,
  PrivacyCallout,
} from "@/components/sidocs/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";

/**
 * Privacy Policy page (PRD §5.4): what we collect, what we NEVER collect,
 * purposes, retention, sharing, user rights, DPDP Act 2023 + GDPR notes,
 * children, and the change log — bilingual via i18n.
 */
export function PrivacyPage() {
  const { t } = useI18n();

  return (
    <PageShell
      icon={Lock}
      badge={t("privacy.badge")}
      title={t("privacy.title")}
      lede={t("privacy.lede")}
      updated={t("privacy.updated")}
    >
      <PrivacyCallout
        title={t("privacy.neverTitle")}
        body={t("privacy.neverBody")}
      />

      <PageSection icon={Database} title={t("privacy.collectTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.collectIntro")}
        </p>
        <KeyValueList
          rows={[
            {
              label: t("privacy.collectDeviceLabel"),
              value: t("privacy.collectDeviceValue"),
            },
            {
              label: t("privacy.collectUsageLabel"),
              value: t("privacy.collectUsageValue"),
            },
            {
              label: t("privacy.collectContactLabel"),
              value: t("privacy.collectContactValue"),
            },
            {
              label: t("privacy.collectPaymentLabel"),
              value: t("privacy.collectPaymentValue"),
            },
            {
              label: t("privacy.collectPrefsLabel"),
              value: t("privacy.collectPrefsValue"),
            },
          ]}
        />
      </PageSection>

      <PageSection icon={FileX2} title={t("privacy.notCollectedTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.notCollectedBody")}
        </p>
        <ul className="space-y-2">
          {[1, 2, 3, 4].map((index) => (
            <li key={index} className="flex items-start gap-2.5">
              <ShieldCheck
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t(`privacy.notCollected${index}`)}
              </p>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection icon={ScrollText} title={t("privacy.purposeTitle")}>
        <ul className="space-y-2.5">
          {[1, 2, 3, 4].map((index) => (
            <li
              key={index}
              className="rounded-card border border-border bg-surface px-4 py-3 text-sm text-muted-foreground"
            >
              {t(`privacy.purpose${index}`)}
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection icon={CalendarClock} title={t("privacy.retentionTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.retentionBody")}
        </p>
      </PageSection>

      <PageSection icon={Share2} title={t("privacy.sharingTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.sharingBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.sharingBody2")}
        </p>
      </PageSection>

      <PageSection icon={UserCheck} title={t("privacy.rightsTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.rightsIntro")}
        </p>
        <ul className="space-y-2">
          {[1, 2, 3, 4, 5].map((index) => (
            <li key={index} className="flex items-start gap-2.5">
              <UserCheck
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t(`privacy.right${index}`)}
              </p>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection icon={Globe2} title={t("privacy.lawTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.lawBody")}
        </p>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.lawBody2")}
        </p>
      </PageSection>

      <PageSection icon={Baby} title={t("privacy.childrenTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.childrenBody")}
        </p>
      </PageSection>

      <PageSection icon={Mail} title={t("privacy.contactTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.contactBody")}
        </p>
        <p>
          <a
            href={ROUTES.page("contact")}
            className="inline-flex min-h-11 items-center rounded-btn text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("privacy.contactLink")}
          </a>
        </p>
      </PageSection>

      <PageSection icon={ScrollText} title={t("privacy.changesTitle")}>
        <p className="text-pretty text-muted-foreground">
          {t("privacy.changesBody")}
        </p>
      </PageSection>
    </PageShell>
  );
}
