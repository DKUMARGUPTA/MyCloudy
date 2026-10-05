"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/doco/modal";
import { SiteHeader } from "@/components/doco/site-header";
import { SiteFooter } from "@/components/doco/site-footer";
import { AnnouncementBanner } from "@/components/doco/home/announcement-banner";
import { Hero } from "@/components/doco/home/hero";
import { Steps } from "@/components/doco/home/steps";
import { Categories } from "@/components/doco/home/categories";
import { Why } from "@/components/doco/home/why";
import { Modes } from "@/components/doco/home/modes";
import { useI18n } from "@/components/providers/locale-provider";

/**
 * DocoPDF home (Phase 0 scope).
 * Live: design tokens, dark mode, EN/हिं i18n, base components,
 * category preview from the PRD §7 catalog.
 * Next phases add: Smart Drop Zone, tool registry pages, ToolShell.
 */
export default function Home() {
  const { t } = useI18n();
  const [proOpen, setProOpen] = useState(false);
  const openPro = useCallback(() => setProOpen(true), []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main"
        className="sr-only rounded-btn bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
      >
        {t("common.skipToContent")}
      </a>

      <AnnouncementBanner />
      <SiteHeader onGetPro={openPro} />

      <main id="main" className="flex-1">
        <Hero />
        <Steps />
        <Categories />
        <Why />
        <Modes />
      </main>

      <SiteFooter />

      <Modal
        open={proOpen}
        onOpenChange={setProOpen}
        title={t("pro.title")}
        footer={
          <Button
            type="button"
            variant="cta"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            onClick={() => setProOpen(false)}
          >
            {t("pro.action")}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t("pro.body")}</p>
      </Modal>
    </div>
  );
}
