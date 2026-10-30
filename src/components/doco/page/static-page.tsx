"use client";

import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/doco/empty-state";
import { AboutPage } from "@/components/doco/page/about-page";
import { ContactPage } from "@/components/doco/page/contact-page";
import { PrivacyPage } from "@/components/doco/page/privacy-page";
import { TermsPage } from "@/components/doco/page/terms-page";
import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";

/**
 * Static page view entry (Phase 6): resolves the routed "#/page/<id>"
 * against the page registry. Unknown ids get the honest empty state —
 * same pattern as ToolView.
 */

export type StaticPageId = "about" | "contact" | "privacy" | "terms";

const PAGE_IDS: StaticPageId[] = ["about", "contact", "privacy", "terms"];

export function isStaticPageId(id: string): id is StaticPageId {
  return (PAGE_IDS as string[]).includes(id);
}

export function StaticPageView({ pageId }: { pageId: string }) {
  const { t } = useI18n();
  const routes = useLocalizedRoutes();

  if (!isStaticPageId(pageId)) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<FileQuestion />}
          title={t("pages.notFoundTitle")}
          description={t("pages.notFoundDesc")}
          action={
            <Button asChild size="touch" className="rounded-btn">
              <a href={routes.home}>{t("pages.notFoundAction")}</a>
            </Button>
          }
        />
      </div>
    );
  }

  switch (pageId) {
    case "about":
      return <AboutPage />;
    case "contact":
      return <ContactPage />;
    case "privacy":
      return <PrivacyPage />;
    case "terms":
      return <TermsPage />;
  }
}
