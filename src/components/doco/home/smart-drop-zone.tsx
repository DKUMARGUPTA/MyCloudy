"use client";

import { useCallback, useState } from "react";
import {
  ArrowRight,
  FileText,
  Image as ImageIcon,
  RotateCw,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";
import { setChainHandoff } from "@/lib/tools/chain";
import { getTool, type ToolDef } from "@/lib/tools/registry";
import { sniffIsPdf } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { cn } from "@/lib/utils";

/**
 * Smart Drop Zone (PRD §6.1 hero): drop a file, its type is detected by
 * magic bytes and relevant tools are suggested. The file is kept in memory
 * and handed to the chosen tool via the chain module (OPFS working copies
 * are written by the tool itself) — no re-selection, no upload.
 *
 * Honest suggestions: only ENABLED tools offer a direct action; others
 * route to their category with a clear "coming in phase X" toast.
 */

type DetectedKind = "pdf" | "image" | "other";

const PDF_CATEGORY_SUGGESTIONS = [
  { id: "organize", key: "smartDrop.catOrganize" },
  { id: "edit", key: "smartDrop.catEdit" },
  { id: "optimize", key: "smartDrop.catOptimize" },
  { id: "security", key: "smartDrop.catSecurity" },
  { id: "convert-to", key: "smartDrop.catConvert" },
] as const;

let smartSeq = 0;

export function SmartDropZone() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [picked, setPicked] = useState<File | null>(null);
  const [kind, setKind] = useState<DetectedKind>("pdf");

  const handleAccept = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      const isPdf = await sniffIsPdf(file);
      const isImage =
        !isPdf && (file.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|gif)$/i.test(file.name));
      setKind(isPdf ? "pdf" : isImage ? "image" : "other");
      setPicked(file);
    },
    []
  );

  const reset = () => {
    setPicked(null);
  };

  const handoffTo = (tool: ToolDef) => {
    if (!picked) return;
    smartSeq += 1;
    setChainHandoff({
      fromToolId: "",
      items: [{ id: `smart-${Date.now().toString(36)}-${smartSeq}`, file: picked }],
    });
    navigateToHash(ROUTES.tool(tool.id));
  };

  const openComing = (toolId: string, categoryId: string) => {
    const tool = getTool(toolId);
    if (tool) {
      toast({
        title: t("tools.comingToastTitle", { tool: tool.name[locale] }),
        description: t("tools.comingToastDesc", { phase: tool.phase }),
      });
    }
    navigateToHash(ROUTES.category(categoryId));
  };

  const rotateTool = getTool("rotate-pdf-pages");

  if (picked) {
    return (
      <div
        className={cn(
          "mx-auto mt-8 w-full max-w-2xl rounded-card border border-border bg-card p-5 text-left shadow-sm"
        )}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
          >
            {kind === "image" ? (
              <ImageIcon className="size-5" />
            ) : (
              <FileText className="size-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground" title={picked.name}>
              {picked.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(picked.size)}
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            aria-label={t("smartDrop.chooseDifferent")}
            className="flex size-9 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mt-4 text-sm font-semibold text-foreground">
          {t("smartDrop.whatNext")}
        </p>

        {kind === "pdf" ? (
          <div className="mt-3 flex flex-col gap-2">
            {rotateTool?.enabled ? (
              <Button
                type="button"
                size="touch"
                className="w-full justify-between rounded-btn font-semibold sm:w-auto sm:min-w-64"
                onClick={() => handoffTo(rotateTool)}
              >
                <span className="flex items-center gap-2">
                  <RotateCw className="size-4" aria-hidden="true" />
                  {rotateTool.name[locale]}
                </span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {PDF_CATEGORY_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => navigateToHash(ROUTES.category(suggestion.id))}
                  className="min-h-11 rounded-chip border border-border bg-background px-3.5 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {t(suggestion.key)}
                </button>
              ))}
            </div>
          </div>
        ) : kind === "image" ? (
          <div className="mt-3 flex flex-col gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="w-full justify-between rounded-btn sm:w-auto sm:min-w-64"
              onClick={() => openComing("jpg-to-pdf", "convert-to")}
            >
              <span className="flex items-center gap-2">
                <ImageIcon className="size-4" aria-hidden="true" />
                {t("smartDrop.imagesToPdf")}
              </span>
              <Badge variant="outline" className="rounded-chip text-[10px]">
                {t("tools.soonBadge")}
              </Badge>
            </Button>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => navigateToHash(ROUTES.category("images"))}
                className="min-h-11 rounded-chip border border-border bg-background px-3.5 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("smartDrop.catImages")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="w-full justify-between rounded-btn sm:w-auto sm:min-w-64"
              onClick={() => openComing("word-to-pdf", "convert-to")}
            >
              <span className="flex items-center gap-2">
                <FileText className="size-4" aria-hidden="true" />
                {t("smartDrop.wordToPdf")}
              </span>
              <Badge variant="outline" className="rounded-chip text-[10px]">
                {t("tools.soonBadge")}
              </Badge>
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("smartDrop.officeNote")}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <DropZone
      labelKey="smartDrop.selectLabel"
      multiple={false}
      maxFiles={1}
      acceptKind="any"
      onAccept={(files) => void handleAccept(files)}
      className="mx-auto mt-8 w-full max-w-2xl"
    />
  );
}
