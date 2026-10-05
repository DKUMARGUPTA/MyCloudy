"use client";

import { useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileDown,
  HardDriveDownload,
  Pencil,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolDef } from "@/lib/tools/registry";
import type { ToolOutput } from "@/lib/workers/protocol";
import {
  canShareFiles,
  canUseSavePicker,
  downloadBlob,
  sanitizeFileName,
  saveBlobAs,
  shareBlobs,
  zipOutputs,
} from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import { PageThumbnail } from "./page-thumbnail";
import { cn } from "@/lib/utils";

/**
 * Result state (PRD §6.4): ready file(s) with rename, size delta,
 * download / save-to-files / share, ZIP for multi-output, chain
 * suggestions, one-click feedback, and the device-privacy line with
 * "Remove from device".
 */

const DOWN_REASONS = [
  { id: "slow", key: "feedback.reasonSlow" },
  { id: "wrong", key: "feedback.reasonWrong" },
  { id: "confusing", key: "feedback.reasonConfusing" },
  { id: "other", key: "feedback.reasonOther" },
] as const;

export function ResultView({
  tool,
  outputs,
  inputBytes,
  runSummary,
  chainFromName,
  chainTargets,
  onChain,
  onRemoveFromDevice,
}: {
  tool: ToolDef;
  outputs: ToolOutput[];
  inputBytes: number;
  /** Worker run summary (PRD §8.1: "5 files, 42 pages"). */
  runSummary?: { files?: number; pages?: number } | null;
  chainFromName?: string;
  chainTargets: ToolDef[];
  onChain: (nextTool: ToolDef, files: File[]) => void;
  onRemoveFromDevice: () => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [names, setNames] = useState<string[]>(() => outputs.map((o) => o.name));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  const totalOut = outputs.reduce((sum, output) => sum + output.blob.size, 0);
  const savedPct = inputBytes > 0 ? Math.round((1 - totalOut / inputBytes) * 100) : 0;
  const shrinkable = inputBytes > 0 && totalOut < inputBytes && savedPct >= 1;
  const shareable = useMemo(() => canShareFiles(outputs), [outputs]);
  const pickerAvailable = canUseSavePicker();

  const commitRename = (index: number) => {
    const ext = (outputs[index].name.split(".").pop() ?? "pdf").toLowerCase();
    const next = sanitizeFileName(draft, ext);
    setNames((prev) => prev.map((name, i) => (i === index ? next : name)));
    setEditingIndex(null);
    if (next !== outputs[index].name) {
      toast({ title: t("result.renamedToast", { name: next }) });
    }
  };

  const handleFeedback = async (value: 1 | -1) => {
    if (rating !== null) return;
    setRating(value);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolId: tool.id,
          rating: value,
          reason: value === -1 ? reason : undefined,
          message: undefined,
        }),
      });
    } catch {
      /* feedback is best-effort; never block the result flow */
    }
    if (value === 1) toast({ title: t("feedback.thanks") });
  };

  const pickReason = async (id: string) => {
    setReason(id);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolId: tool.id,
          rating: -1,
          reason: id,
          message: undefined,
        }),
      });
    } catch {
      /* best-effort */
    }
    toast({ title: t("feedback.thanks") });
  };

  const downloadZip = async () => {
    const { blob, name } = await zipOutputs(
      outputs.map((output, index) => ({
        name: names[index],
        blob: output.blob,
      })),
      "docopdf-results.zip"
    );
    downloadBlob(blob, name);
  };

  return (
    <section className="mx-auto w-full max-w-3xl px-4 pb-24 pt-8 sm:pt-10">
      {chainFromName ? (
        <div className="mx-auto mb-4 flex w-fit items-center gap-1.5 rounded-chip border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
          <span>{chainFromName}</span>
          <span aria-hidden="true">▸</span>
          <span className="font-semibold text-foreground">{tool.name[locale]}</span>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-2 text-center">
        <CheckCircle2
          className="size-11 animate-in fade-in-50 zoom-in-75 text-emerald-500 duration-300"
          aria-hidden="true"
        />
        <h2 className="text-xl font-bold text-foreground sm:text-2xl">
          {t("result.title")}
        </h2>
        {runSummary?.files ? (
          <p className="rounded-chip bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {t("result.summaryFilesPages", {
              files: runSummary.files,
              pages: runSummary.pages ?? 0,
            })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {shrinkable
            ? t("result.sizeDelta", {
                before: formatBytes(inputBytes),
                after: formatBytes(totalOut),
                percent: savedPct,
              })
            : inputBytes > 0
              ? t("result.sizeFlat", { after: formatBytes(totalOut) })
              : null}
        </p>
      </div>

      <ul className="mt-6 flex flex-col gap-3">
        {outputs.map((output, index) => (
          <li
            key={`${output.name}-${index}`}
            className="flex flex-col gap-3 rounded-card border border-border bg-card p-4 transition-all duration-200 hover:border-primary/25 hover:shadow-md sm:flex-row sm:items-center"
          >
            <div className="w-16 shrink-0 self-start sm:self-center">
              <button
                type="button"
                className="block w-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:rounded-lg"
                aria-label={t("result.openPreviewLabel")}
                onClick={() => {
                  const url = URL.createObjectURL(output.blob);
                  window.open(url, "_blank", "noopener,noreferrer");
                  setTimeout(() => URL.revokeObjectURL(url), 60_000);
                }}
              >
                <PageThumbnail file={output.blob} alt={names[index]} />
              </button>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {editingIndex === index ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    commitRename(index);
                  }}
                >
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(index)}
                    aria-label={t("result.renameLabel")}
                    className="h-10 rounded-btn"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    aria-label={t("result.renameConfirm")}
                    className="rounded-btn"
                  >
                    <Check className="size-4" aria-hidden="true" />
                  </Button>
                </form>
              ) : (
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span className="truncate" title={names[index]}>
                    {names[index]}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingIndex(index);
                      setDraft(names[index].replace(/\.(pdf|zip|png|jpe?g)$/i, ""));
                    }}
                    aria-label={t("result.renameLabel")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {formatBytes(output.blob.size)}
                {shrinkable ? (
                  <span className="ml-2 rounded-chip bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    {t("result.savedChip", { percent: savedPct })}
                  </span>
                ) : null}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                size="touch"
                className="rounded-btn"
                onClick={() => downloadBlob(output.blob, names[index])}
              >
                <Download className="size-4" aria-hidden="true" />
                {t("result.download")}
              </Button>
              {pickerAvailable ? (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  className="rounded-btn"
                  onClick={() => {
                    void saveBlobAs(output.blob, names[index], output.mime);
                  }}
                >
                  <HardDriveDownload className="size-4" aria-hidden="true" />
                  {t("result.saveToFiles")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-col items-center justify-center gap-2 sm:flex-row">
        {outputs.length > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            onClick={() => void downloadZip()}
          >
            <FileDown className="size-4" aria-hidden="true" />
            {t("result.downloadZip")}
          </Button>
        ) : null}
        {shareable ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            onClick={() => {
              void shareBlobs(
                outputs.map((output, index) => ({
                  name: names[index],
                  mime: output.mime,
                  blob: output.blob,
                }))
              );
            }}
          >
            <Share2 className="size-4" aria-hidden="true" />
            {t("result.share")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="w-full rounded-btn text-muted-foreground sm:w-auto"
          onClick={() => {
            const url = URL.createObjectURL(outputs[0].blob);
            window.open(url, "_blank", "noopener,noreferrer");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          {t("result.openPreview")}
        </Button>
      </div>

      {/* What next? chain (PRD §6.4) */}
      {chainTargets.length > 0 ? (
        <div className="mt-10 rounded-card border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground">
            {t("result.whatNext")}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {chainTargets.map((target) => (
              <button
                key={target.id}
                type="button"
                onClick={() =>
                  onChain(
                    target,
                    outputs.map((output, index) =>
                      new File([output.blob], names[index], {
                        type: output.mime,
                      })
                    )
                  )
                }
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-chip border border-border bg-background px-3.5 text-sm font-medium text-foreground outline-none transition-colors",
                  "hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                )}
              >
                <target.icon className="size-4 text-primary" aria-hidden="true" />
                {target.name[locale]}
                {!target.enabled ? (
                  <Badge variant="outline" className="rounded-chip px-1.5 py-0 text-[10px] text-muted-foreground">
                    {t("tools.soonBadge")}
                  </Badge>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Feedback + privacy (PRD §6.4) */}
      <div className="mt-6 flex flex-col items-center gap-4 border-t border-border pt-6 text-center">
        {rating === null ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">{t("feedback.prompt")}</p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                aria-label={t("feedback.upLabel")}
                className="rounded-full"
                onClick={() => void handleFeedback(1)}
              >
                <ThumbsUp className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                aria-label={t("feedback.downLabel")}
                className="rounded-full"
                onClick={() => void handleFeedback(-1)}
              >
                <ThumbsDown className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : rating === -1 && reason === null ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">{t("feedback.reasonPrompt")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {DOWN_REASONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void pickReason(item.id)}
                  className="min-h-11 rounded-chip border border-border bg-background px-3 text-xs font-medium text-foreground outline-none transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {t(item.key)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {t("feedback.thanks")}
          </p>
        )}

        <p className="text-xs text-muted-foreground">{t("result.privacyLine")}</p>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemoveFromDevice}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {t("result.removeFromDevice")}
        </Button>
      </div>
    </section>
  );
}
