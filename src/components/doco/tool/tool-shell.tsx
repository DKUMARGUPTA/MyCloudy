"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  FilePlus2,
  Home,
  ListChecks,
  Lock,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/doco/modal";
import { BottomSheet } from "@/components/doco/bottom-sheet";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";
import {
  getCategory,
  getTool,
  toolsByCategory,
  type ToolDef,
} from "@/lib/tools/registry";
import type { ToolConfig, OptionValues } from "@/lib/tools/config-types";
import { defaultOptionValues } from "@/lib/tools/config-types";
import {
  clearChainHandoff,
  peekChainHandoff,
  setChainHandoff,
} from "@/lib/tools/chain";
import { trackToolUse } from "@/lib/tools/favorites";
import {
  addRecentFile,
  removeRecentFilesByMeta,
} from "@/lib/storage/recent-files";
import {
  clearWorkingFiles,
  writeWorkingFile,
} from "@/lib/storage/opfs";
import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import {
  toolRunner,
  RunCancelledError,
  ToolRunError,
  type RunHandle,
  type RunProgress,
} from "@/lib/workers/pool";
import type { ToolOutput } from "@/lib/workers/protocol";
import { DropZone } from "./drop-zone";
import { FileCard, type WorkspaceFile } from "./file-card";
import { OptionsPanel } from "./options-panel";
import { ProcessingView } from "./processing-view";
import { ResultView } from "./result-view";
import { cn } from "@/lib/utils";

/**
 * ToolShell (PRD §6.3): the universal 4-state tool template.
 * Landing (upload + SEO copy) → Workspace (preview + options) →
 * Processing (real worker progress) → Result (download/share/chain).
 * Every enabled tool renders from its registry entry + config — this
 * component is the ONLY tool page in the app.
 */

type ShellPhase = "landing" | "workspace" | "processing" | "result";

let fileSeq = 0;
function nextFileId(): string {
  fileSeq += 1;
  return `wf-${Date.now().toString(36)}-${fileSeq}`;
}

export function ToolShell({ tool, config }: { tool: ToolDef; config: ToolConfig }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const category = getCategory(tool.category);

  // One-time chain handoff peek — set by a previous tool's result view or
  // the home Smart Drop Zone right before navigating here. Consumed via
  // the lazy initializer (pure read); cleared in the effect below.
  const [chainIn] = useState<{
    fromToolId: string;
    items: WorkspaceFile[];
  } | null>(() => {
    const handoff = peekChainHandoff();
    if (!handoff || handoff.items.length === 0) return null;
    return {
      fromToolId: handoff.fromToolId,
      items: handoff.items.map((item) => ({
        id: item.id,
        file: item.file,
      })),
    };
  });

  const [phase, setPhase] = useState<ShellPhase>(() => (chainIn ? "workspace" : "landing"));
  const [files, setFiles] = useState<WorkspaceFile[]>(() => chainIn?.items ?? []);
  const [options, setOptions] = useState<OptionValues>(() =>
    defaultOptionValues(config.options)
  );
  const [progress, setProgress] = useState<RunProgress>({
    pct: 0,
    stage: "reading",
  });
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [inputBytes, setInputBytes] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Chain handoff consumed once at mount (lazy initializer = pure read);
  // clearing the module store is an external-system sync in this effect.
  const chainFrom: ToolDef | null = chainIn
    ? (getTool(chainIn.fromToolId) ?? null)
    : null;
  useEffect(() => {
    if (chainIn) clearChainHandoff();
  }, [chainIn]);

  // Chain/SmartDrop files get the same treatment as dropped files (PRD
  // §6.1): OPFS working copy + a metadata-only recent entry with thumbnail.
  // External-system sync only — no React state is touched here.
  useEffect(() => {
    if (!chainIn) return;
    for (const item of chainIn.items) {
      void writeWorkingFile(item.id, item.file).catch(() => undefined);
      void renderPdfThumbnail(item.file, { maxDim: 160 })
        .then(({ blob }) =>
          addRecentFile({
            id: item.id,
            kind: "pdf",
            label: item.file.name,
            size: item.file.size,
            toolId: tool.id,
            thumbnail: blob,
          })
        )
        .catch(() => undefined);
    }
  }, [chainIn, tool.id]);

  const runHandleRef = useRef<RunHandle | null>(null);

  const relatedTools = useMemo(
    () =>
      toolsByCategory(tool.category)
        .filter((item) => item.id !== tool.id)
        .slice(0, 6),
    [tool.category, tool.id]
  );

  const chainTargets = useMemo(() => {
    // PRD §6.4 "Ab aage kya?" — the natural next steps for a PDF result.
    const suggestionIds = [
      "compress-pdf",
      "protect-pdf",
      "sign-pdf",
      "split-pdf",
      "edit-pdf",
    ];
    const resolved = suggestionIds
      .map((id) => getTool(id))
      .filter((item): item is ToolDef => item !== undefined && item.id !== tool.id);
    return resolved.slice(0, 5);
  }, [tool.id]);

  // Working copies are cleared when the tool session ends (PRD §2.4).
  useEffect(
    () => () => {
      void clearWorkingFiles().catch(() => undefined);
    },
    []
  );

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const room = config.maxFiles - files.length;
      if (room <= 0) {
        toast({
          title: t("dropzone.errTooManyTitle"),
          description: t("dropzone.errTooManyDesc", {
            count: config.maxFiles,
          }),
          variant: "destructive",
        });
        return;
      }
      const accepted = incoming.slice(0, room);
      const items = accepted.map((file) => ({ id: nextFileId(), file }));

      // Side effects run ONCE here — never inside the setFiles updater
      // (React StrictMode double-invokes updaters; they must stay pure).
      for (const item of items) {
        void writeWorkingFile(item.id, item.file).catch(() => undefined);
        // Recent entry: metadata + thumbnail only, never the bytes.
        void renderPdfThumbnail(item.file, { maxDim: 160 })
          .then(async ({ blob }) => {
            await addRecentFile({
              id: item.id,
              kind: "pdf" as const,
              label: item.file.name,
              size: item.file.size,
              toolId: tool.id,
              thumbnail: blob,
            });
          })
          .catch(() => undefined);
      }

      setFiles((prev) => [...prev, ...items]);
      setPhase("workspace");
    },
    [config.maxFiles, files.length, t, toast, tool.id]
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const moveFile = useCallback((from: number, to: number) => {
    setFiles((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setFiles([]);
    void clearWorkingFiles().catch(() => undefined);
    setPhase("landing");
  }, []);

  const startRun = useCallback(() => {
    if (files.length < config.minFiles) return;
    trackToolUse(tool.id);
    setInputBytes(files.reduce((sum, item) => sum + item.file.size, 0));
    setProgress({ pct: 0, stage: "reading" });
    setPhase("processing");
    runHandleRef.current = toolRunner.run(
      tool.id,
      options,
      files.map((item) => item.file),
      setProgress
    );
    runHandleRef.current.promise
      .then((result) => {
        runHandleRef.current = null;
        // Working copies of the INPUTS die with the run (PRD §2.4);
        // results live in memory + can chain into the next tool.
        setOutputs(result);
        setPhase("result");
        void clearWorkingFiles().catch(() => undefined);
      })
      .catch((error: unknown) => {
        runHandleRef.current = null;
        if (error instanceof RunCancelledError) {
          setPhase("workspace");
          toast({ title: t("tool.cancelledToast") });
          return;
        }
        setPhase("workspace");
        const code =
          error instanceof ToolRunError ? error.code : "tool.errorGeneric";
        toast({
          title: t("tool.errorTitle"),
          description: t(code, {
            detail: error instanceof ToolRunError ? error.detail ?? "" : "",
          }),
          variant: "destructive",
        });
      });
  }, [config.minFiles, files, options, t, toast, tool.id]);

  const cancelRun = useCallback(() => {
    runHandleRef.current?.cancel();
  }, []);

  const handleChain = useCallback(
    (target: ToolDef, resultFiles: File[]) => {
      if (!target.enabled) {
        toast({
          title: t("tools.comingToastTitle", { tool: target.name[locale] }),
          description: t("tools.comingToastDesc", {
            phase: target.phase,
          }),
        });
        return;
      }
      setChainHandoff({
        fromToolId: tool.id,
        items: resultFiles.map((file) => ({ id: nextFileId(), file })),
      });
      navigateToHash(ROUTES.tool(target.id));
    },
    [locale, t, toast, tool.id]
  );

  const removeFromDevice = useCallback(() => {
    void clearWorkingFiles().catch(() => undefined);
    // Remove this run's recent entries by their file metadata (label+size).
    void removeRecentFilesByMeta(
      files.map((item) => ({ label: item.file.name, size: item.file.size }))
    ).catch(() => undefined);
    setOutputs([]);
    setFiles([]);
    setPhase("landing");
    toast({ title: t("result.removedToast") });
  }, [files, t, toast]);

  const totalSize = files.reduce((sum, item) => sum + item.file.size, 0);
  const ctaLabel = `${tool.name[locale]} ${t("tool.ctaArrow")}`;
  const Icon = tool.icon;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-28 sm:pb-24">
      {/* Breadcrumb (PRD §6.3): Home > Category > Tool */}
      <nav aria-label={t("a11y.breadcrumb")} className="pt-4">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <li>
            <a
              href={ROUTES.home}
              className="inline-flex items-center gap-1 rounded-btn outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Home className="size-3" aria-hidden="true" />
              {t("nav.home")}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <a
              href={ROUTES.category(tool.category)}
              className="rounded-btn outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {category.name[locale]}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-medium text-foreground">
            {tool.name[locale]}
          </li>
        </ol>
      </nav>

      {phase === "landing" ? (
        <section className="flex flex-col gap-8 pt-6">
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-11 items-center justify-center rounded-btn",
                  "bg-cat-organize/10 text-cat-organize"
                )}
                aria-hidden="true"
              >
                <Icon className="size-5" />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {tool.name[locale]}
              </h1>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
              {tool.description[locale]}
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={tool.mode === "D" ? "private" : "server"} className="rounded-chip">
                <Lock className="size-3" aria-hidden="true" />
                {tool.mode === "D"
                  ? t("tools.privateBadge")
                  : t("tools.serverBadge")}
              </Badge>
              <Badge variant="outline" className="rounded-chip">
                {t("tool.freeBadge")}
              </Badge>
            </div>
          </header>

          <DropZone
            labelKey="tool.selectPdfFiles"
            multiple={config.maxFiles > 1}
            maxFiles={config.maxFiles}
            acceptKind="pdf"
            onAccept={addFiles}
            currentCount={files.length}
          />

          <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
            <div className="flex flex-col gap-8">
              {/* How it works */}
              <section aria-labelledby="how-heading">
                <h2 id="how-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ListChecks className="size-4 text-primary" aria-hidden="true" />
                  {t("tool.howTitle")}
                </h2>
                <ol className="mt-3 grid gap-3 sm:grid-cols-3">
                  {["tool.how1", "tool.how2", "tool.how3"].map((key, index) => (
                    <li
                      key={key}
                      className="rounded-card border border-border bg-card p-4"
                    >
                      <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {index + 1}
                      </span>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {t(key)}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>

              {/* FAQ */}
              <section aria-labelledby="faq-heading">
                <h2 id="faq-heading" className="text-sm font-semibold text-foreground">
                  {t("tool.faqTitle")}
                </h2>
                <Accordion type="single" collapsible className="mt-3">
                  {config.faq.map((item, index) => (
                    <AccordionItem key={index} value={`faq-${index}`}>
                      <AccordionTrigger className="text-left text-sm">
                        {item.q[locale]}
                      </AccordionTrigger>
                      <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                        {item.a[locale]}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </section>
            </div>

            <aside className="flex flex-col gap-8">
              {/* Features */}
              <section aria-labelledby="features-heading">
                <h2 id="features-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Sparkles className="size-4 text-primary" aria-hidden="true" />
                  {t("tool.featuresTitle")}
                </h2>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {config.features.map((feature, index) => (
                    <li
                      key={index}
                      className="flex gap-2 rounded-card border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 size-1.5 shrink-0 rounded-full bg-primary"
                      />
                      {feature[locale]}
                    </li>
                  ))}
                </ul>
              </section>

              {/* Related */}
              <section aria-labelledby="related-heading">
                <h2 id="related-heading" className="text-sm font-semibold text-foreground">
                  {t("tool.relatedTitle")}
                </h2>
                <ul className="mt-3 flex flex-col gap-1.5">
                  {relatedTools.map((item) => {
                    const RelatedIcon = item.icon;
                    return (
                      <li key={item.id}>
                        <a
                          href={item.enabled ? ROUTES.tool(item.id) : ROUTES.category(item.category)}
                          className="flex min-h-11 items-center gap-2.5 rounded-btn px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <RelatedIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate text-foreground">
                            {item.name[locale]}
                          </span>
                          {!item.enabled ? (
                            <Badge variant="outline" className="ml-auto rounded-chip text-[10px] text-muted-foreground">
                              {t("tools.soonBadge")}
                            </Badge>
                          ) : null}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </aside>
          </div>
        </section>
      ) : null}

      {phase === "workspace" ? (
        <section className="pt-6">
          {/* Workspace toolbar (PRD §6.3 state 2) */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPhase("landing")}
              className="rounded-btn"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              {t("tool.back")}
            </Button>
            <span className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-btn"
                onClick={() => setHelpOpen(true)}
                aria-label={t("tool.helpLabel")}
              >
                <CircleHelp className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t("tool.helpLabel")}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-btn"
                onClick={clearAll}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {t("tool.clearAll")}
              </Button>
            </span>
          </div>

          <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
            {/* Preview list */}
            <div className="flex flex-col gap-3">
              <ul className="grid gap-3 sm:grid-cols-2">
                {files.map((item, index) => (
                  <FileCard
                    key={item.id}
                    item={item}
                    index={index}
                    total={files.length}
                    onRemove={removeFile}
                    onMove={moveFile}
                  />
                ))}
              </ul>
              <DropZone
                labelKey="tool.addMoreFiles"
                multiple={config.maxFiles > 1}
                maxFiles={config.maxFiles}
                acceptKind="pdf"
                onAccept={addFiles}
                currentCount={files.length}
                className="border-dashed py-4"
              />
            </div>

            {/* Options: desktop side panel / mobile bottom sheet */}
            <aside className="hidden lg:block">
              <div className="sticky top-20 rounded-card border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("tool.optionsTitle")}
                </h2>
                <OptionsPanel
                  fields={config.options}
                  values={options}
                  onChange={(id, value) =>
                    setOptions((prev) => ({ ...prev, [id]: value }))
                  }
                  className="mt-4"
                />
                <p className="mt-5 border-t border-border pt-3 text-[11px] text-muted-foreground">
                  {t("tool.summary", {
                    count: files.length,
                    size: formatBytes(totalSize),
                  })}
                </p>
              </div>
            </aside>
          </div>

          {/* Sticky CTA (PRD §6.3): count + estimated size + action */}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-muted-foreground">
                  {t("tool.summary", {
                    count: files.length,
                    size: formatBytes(totalSize),
                  })}
                </p>
                {chainFrom ? (
                  <p className="truncate text-[11px] text-primary">
                    {t("tool.chainFrom", { tool: chainFrom.name[locale] })}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="rounded-btn lg:hidden"
                onClick={() => setOptionsOpen(true)}
              >
                {t("tool.optionsButton")}
              </Button>
              <Button
                type="button"
                size="touch"
                className="rounded-btn font-semibold"
                onClick={startRun}
                disabled={files.length < config.minFiles}
              >
                {ctaLabel}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <BottomSheet
            open={optionsOpen}
            onOpenChange={setOptionsOpen}
            title={t("tool.optionsTitle")}
            description={tool.description[locale]}
            footer={
              <Button
                type="button"
                size="touch"
                className="w-full rounded-btn font-semibold"
                onClick={() => {
                  setOptionsOpen(false);
                  startRun();
                }}
                disabled={files.length < config.minFiles}
              >
                {ctaLabel}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            }
          >
            <OptionsPanel
              fields={config.options}
              values={options}
              onChange={(id, value) =>
                setOptions((prev) => ({ ...prev, [id]: value }))
              }
            />
          </BottomSheet>
        </section>
      ) : null}

      {phase === "processing" ? (
        <ProcessingView
          toolName={tool.name[locale]}
          progress={progress}
          onCancel={cancelRun}
        />
      ) : null}

      {phase === "result" ? (
        <ResultView
          tool={tool}
          outputs={outputs}
          inputBytes={inputBytes}
          chainFromName={chainFrom ? chainFrom.name[locale] : undefined}
          chainTargets={chainTargets}
          onChain={handleChain}
          onRemoveFromDevice={removeFromDevice}
        />
      ) : null}

      {/* Help dialog */}
      <Modal
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title={t("tool.helpTitle")}
        footer={
          <Button
            type="button"
            variant="default"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            onClick={() => setHelpOpen(false)}
          >
            {t("pro.action")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p className="flex gap-2">
            <FilePlus2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            {t("tool.how2")}
          </p>
          <p>{t("tool.helpPrivacy")}</p>
        </div>
      </Modal>
    </div>
  );
}
