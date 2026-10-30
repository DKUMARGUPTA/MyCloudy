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
import { useHashRoute, type HashRoute } from "@/hooks/use-hash-route";
import { anchorClickHandler } from "@/lib/anchor";
import { track } from "@/lib/analytics/ga4";
import { ALL_TOOLS } from "@/lib/tools/registry";
import { LOCALE_STORAGE_KEY } from "@/i18n";

/**
 * DocoPDF app shell — the single visible application, shared by every
 * route (/, /tools, /tool/<id>, /hi/…). On real crawlable paths the
 * server component passes `initialRoute`, which the hash router uses
 * until the first hash navigation; from then on the hash drives as
 * always. `initialLocale` ("hi" mirrors) applies when the visitor has
 * no stored preference — returning users keep their explicit choice.
 */
export function AppShell({
  initialRoute,
  initialLocale,
}: {
  initialRoute: HashRoute;
  initialLocale?: "en" | "hi";
}) {
  const { t, setLocale, locale } = useI18n();
  const { route } = useHashRoute(initialRoute);
  const [proOpen, setProOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const openPro = useCallback(() => setProOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  /*
   * GA4 tool_view (P7-SEO Phase 6): one event per tool landing, carrying
   * only registry metadata (slug/category/mode) + the active locale — no
   * PII, no file names. No-ops unless analytics consent is granted.
   */
  const toolId = route.view === "tool" ? route.toolId : undefined;
  useEffect(() => {
    if (!toolId) return;
    const tool = ALL_TOOLS.find((entry) => entry.id === toolId);
    if (!tool) return;
    track("tool_view", {
      tool_slug: tool.id,
      category: tool.category,
      mode: tool.mode,
      locale,
    });
  }, [toolId, locale]);

  /*
   * Boot marker for the iOS compatibility watchdog (boot-script.ts): once
   * the shell has mounted, the fallback screen must never appear, and
   * later errors route to the React error boundary instead.
   */
  useEffect(() => {
    (window as unknown as { __DP_BOOTED__?: boolean }).__DP_BOOTED__ = true;
  }, []);

  /*
   * Locale mirror boot: /hi/… paths default to Hindi for fresh visitors.
   * Deferred by one animation frame so the store update lands AFTER the
   * hydration commit — flipping the locale in the same task makes Radix
   * useIds regenerate and logs a hydration attribute mismatch.
   */
  useEffect(() => {
    if (!initialLocale) return;
    const frame = requestAnimationFrame(() => {
      try {
        if (!window.localStorage.getItem(LOCALE_STORAGE_KEY)) {
          setLocale(initialLocale);
        }
      } catch {
        /* private mode / storage blocked — default locale is fine */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [initialLocale, setLocale]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
        <a
          href="#main"
          onClick={anchorClickHandler("main", { focusTarget: true })}
          className="sr-only rounded-btn bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
        >
          {t("common.skipToContent")}
        </a>

        <AnnouncementBanner />
        <SiteHeader onGetPro={openPro} onOpenSearch={openSearch} route={route} />

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
            <ToolsView categoryId={route.category} query={route.query} />
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
