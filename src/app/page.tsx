"use client";

import { useCallback, useEffect, useState } from "react";

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
import { PopularTools } from "@/components/doco/home/popular-tools";
import { Faq } from "@/components/doco/home/faq";
import { RecentFiles } from "@/components/doco/home/recent-files";
import { ToolsView } from "@/components/doco/tools/tools-view";
import { ToolView } from "@/components/doco/tool/tool-view";
import { StaticPageView } from "@/components/doco/page/static-page";
import { SearchPalette } from "@/components/doco/search/search-palette";
import { CookieBanner } from "@/components/doco/cookie-banner";
import { BottomTabBar } from "@/components/doco/bottom-tab-bar";
import { useI18n } from "@/components/providers/locale-provider";
import { useHashRoute } from "@/hooks/use-hash-route";

/**
 * DocoPDF app shell on the single visible route "/" (sandbox note: path
 * routes are restored at deploy time). Hash router switches between the
 * home view and the tools discovery views, driven entirely by the registry.
 */
export default function Home() {
  const { t } = useI18n();
  const { route } = useHashRoute();
  const [proOpen, setProOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const openPro = useCallback(() => setProOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  /*
   * Boot marker for the iOS compatibility watchdog (boot-script.ts): once
   * the shell has mounted, the fallback screen must never appear, and
   * later errors route to the React error boundary instead.
   */
  useEffect(() => {
    (window as unknown as { __DP_BOOTED__?: boolean }).__DP_BOOTED__ = true;
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main"
        className="sr-only rounded-btn bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
      >
        {t("common.skipToContent")}
      </a>

      <AnnouncementBanner />
      <SiteHeader
        onGetPro={openPro}
        onOpenSearch={openSearch}
        route={route}
      />

      <main id="main" className="flex-1 pb-16 md:pb-0">
        {route.view === "home" ? (
          <>
            <Hero />
            <PopularTools />
            <Steps />
            <Categories />
            <Why />
            <RecentFiles />
            <Modes />
            <Faq />
          </>
        ) : route.view === "tool" ? (
          <ToolView toolId={route.toolId ?? ""} />
        ) : route.view === "page" ? (
          <StaticPageView pageId={route.pageId ?? ""} />
        ) : (
          <ToolsView
            categoryId={route.category}
            query={route.query}
          />
        )}
      </main>

      <SiteFooter />
      {route.view === "tool" ? null : (
        <BottomTabBar route={route} onOpenSearch={openSearch} />
      )}
      <CookieBanner />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />

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
