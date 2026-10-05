"use client";

import { Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categoryChipClass,
  categoryHoverClass,
  getCategory,
  PHASE_LABELS,
  type ToolDef,
} from "@/lib/tools/registry";
import { toggleFavorite, useFavoriteIds } from "@/lib/tools/favorites";
import { cn } from "@/lib/utils";

interface ToolCardProps {
  tool: ToolDef;
  /** Suppress the toast when the card opens something else. */
  onOpen?: (tool: ToolDef) => void;
}

/**
 * Tool card (PRD §3.3): 48px icon, name, 1-line description, mode badge,
 * favorite star, hover lift, visible focus ring. Tools not yet live show an
 * honest "Soon" chip; clicking them explains the roadmap instead of failing.
 */
export function ToolCard({ tool, onOpen }: ToolCardProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const favoriteIds = useFavoriteIds();
  const category = getCategory(tool.category);
  const Icon = tool.icon;
  const isFavorite = favoriteIds.includes(tool.id);

  const handleOpen = () => {
    if (tool.enabled) {
      onOpen?.(tool);
      return;
    }
    toast({
      title: t("tools.comingToastTitle", { tool: tool.name[locale] }),
      description: t("tools.comingToastDesc", {
        phase: PHASE_LABELS[tool.phase][locale],
      }),
    });
    onOpen?.(tool);
  };

  const handleFavorite = () => {
    toggleFavorite(tool.id);
    toast({
      title: isFavorite
        ? t("tools.favoriteRemove", { tool: tool.name[locale] })
        : t("tools.favoriteAdd", { tool: tool.name[locale] }),
    });
  };

  return (
    <article
      className={cn(
        "group relative flex h-full flex-col rounded-card border border-border bg-card p-4 shadow-xs outline-none transition-all",
        "hover:-translate-y-0.5 hover:shadow-md focus-within:ring-[3px] focus-within:ring-ring/50",
        categoryHoverClass[category.color],
        !tool.enabled && "opacity-90"
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-btn",
            categoryChipClass[category.color]
          )}
          aria-hidden="true"
        >
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="pr-7 text-sm font-semibold leading-snug text-foreground">
            <button
              type="button"
              onClick={handleOpen}
              className="text-left outline-none focus-visible:underline before:absolute before:inset-0 before:content-[''] before:focus-visible:ring-[3px] before:focus-visible:rounded-card"
            >
              {tool.name[locale]}
            </button>
          </h3>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {tool.description[locale]}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge
          variant={tool.mode === "D" ? "private" : "server"}
          className="rounded-chip px-2 py-0.5 text-[11px]"
        >
          {tool.mode === "D" ? t("tools.privateBadge") : t("tools.serverBadge")}
        </Badge>
        {!tool.enabled ? (
          <Badge
            variant="outline"
            className="rounded-chip border-dashed px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {t("tools.soonBadge")}
          </Badge>
        ) : null}
        <span
          className="ml-auto text-[11px] text-muted-foreground/80"
          aria-hidden="true"
        >
          {PHASE_LABELS[tool.phase][locale]}
        </span>
      </div>

      <button
        type="button"
        onClick={handleFavorite}
        aria-label={
          isFavorite
            ? t("tools.unfavoriteLabel", { tool: tool.name[locale] })
            : t("tools.favoriteLabel", { tool: tool.name[locale] })
        }
        aria-pressed={isFavorite}
        className={cn(
          "absolute right-2.5 top-2.5 z-10 flex size-9 items-center justify-center rounded-btn outline-none transition-colors",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50",
          isFavorite
            ? "text-cat-invoices hover:bg-cat-invoices/10"
            : "text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground"
        )}
      >
        <Star
          className={cn("size-4", isFavorite && "fill-current")}
          aria-hidden="true"
        />
      </button>
    </article>
  );
}
