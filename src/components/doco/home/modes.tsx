"use client";

import { Check, Lock, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/components/providers/locale-provider";

/**
 * Two honest processing modes (PRD §2.2) — the privacy promise explained.
 * Device-only tools never make network requests with file data; server
 * tools (Phase 3 of the roadmap) delete files right after processing.
 */
export function Modes() {
  const { t } = useI18n();

  const devicePoints = [
    t("modes.devicePoint1"),
    t("modes.devicePoint2"),
    t("modes.devicePoint3"),
  ];
  const serverPoints = [
    t("modes.serverPoint1"),
    t("modes.serverPoint2"),
    t("modes.serverPoint3"),
  ];

  return (
    <section aria-labelledby="modes-title" className="bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="modes-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("modes.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">{t("modes.subtitle")}</p>
        </div>

        <Tabs defaultValue="device" className="mx-auto mt-10 max-w-3xl">
          <TabsList className="grid h-auto w-full max-w-md grid-cols-2 gap-1 rounded-btn p-1">
            <TabsTrigger
              value="device"
              className="min-h-11 rounded-[calc(0.75rem-2px)] gap-1.5 text-xs sm:text-sm"
            >
              <Lock className="size-4" aria-hidden="true" />
              {t("modes.tabDevice")}
            </TabsTrigger>
            <TabsTrigger
              value="server"
              className="min-h-11 rounded-[calc(0.75rem-2px)] gap-1.5 text-xs sm:text-sm"
            >
              <Server className="size-4" aria-hidden="true" />
              {t("modes.tabServer")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="device" className="mt-4">
            <article className="rounded-card border border-border bg-card p-6 shadow-sm ring-1 ring-border/40 sm:p-8">
              <Badge
                variant="private"
                className="rounded-chip px-3 py-1 text-xs sm:text-sm"
              >
                {t("modes.deviceBadge")}
              </Badge>
              <p className="mt-4 text-sm text-muted-foreground sm:text-base">
                {t("modes.deviceDesc")}
              </p>
              <ul className="mt-5 space-y-3">
                {devicePoints.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm sm:text-base">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </article>
          </TabsContent>

          <TabsContent value="server" className="mt-4">
            <article className="rounded-card border border-border bg-card p-6 shadow-sm ring-1 ring-border/40 sm:p-8">
              <Badge
                variant="server"
                className="rounded-chip px-3 py-1 text-xs sm:text-sm"
              >
                {t("modes.serverBadge")}
              </Badge>
              <p className="mt-4 text-sm text-muted-foreground sm:text-base">
                {t("modes.serverDesc")}
              </p>
              <ul className="mt-5 space-y-3">
                {serverPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm sm:text-base">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </article>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
