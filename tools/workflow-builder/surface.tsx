"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  Download,
  FileJson,
  FileOutput,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { OptionsPanel } from "@/components/doco/tool/options-panel";
import { trackToolUse } from "@/lib/tools/favorites";
import { CATEGORIES } from "@/lib/tools/registry";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  MAX_STEPS,
  WORKFLOW_PRESETS,
  buildWorkflowLibrary,
  deleteWorkflow,
  makeStep,
  makeWorkflow,
  parseWorkflowExport,
  presetToDoc,
  saveWorkflow,
  useSavedWorkflows,
  workflowFileName,
  workflowToJson,
  type LibraryTool,
  type WorkflowDoc,
  type WorkflowStep,
} from "./lib";
import {
  runPipeline,
  type PipelineResult,
  type PipelineUpdate,
  type StepLog,
} from "./runner";

/**
 * Workflow Builder surface (PHASE-6) — the visual pipeline editor.
 * Layout: [name + presets/saved/export/import toolbar] → [input card]
 * → [numbered step cards, expandable options, live per-step progress]
 * → [+ add step picker] → [output terminal card] → [run bar / results].
 * The whole flow lives on the tool landing page (noFile pattern).
 */

const LIBRARY = buildWorkflowLibrary();
const LIBRARY_BY_TOOL = new Map(LIBRARY.map((item) => [item.tool.id, item]));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** How many option values differ from the schema defaults. */
function changedSettings(step: WorkflowStep): number {
  const item = LIBRARY_BY_TOOL.get(step.toolId);
  if (!item) return 0;
  let count = 0;
  for (const field of item.config.options) {
    if (step.options[field.id] !== field.default) count += 1;
  }
  return count;
}

function StepStateChip({ log }: { log: StepLog | undefined }) {
  const { t } = useI18n();
  if (!log) return null;
  if (log.state === "running") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {log.pct}%
        <span className="sr-only">{t("wf.stepRunning")}</span>
      </span>
    );
  }
  if (log.state === "done") {
    return (
      <span
        className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary"
        aria-label={t("wf.stepDone")}
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  if (log.state === "error") {
    return (
      <span
        className="flex size-6 items-center justify-center rounded-full bg-destructive/10 text-destructive"
        aria-label={t("wf.stepError")}
      >
        <X className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  if (log.state === "cancelled") {
    return (
      <span
        className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-label={t("wf.stepCancelled")}
      >
        <Ban className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  return null;
}

export function WorkflowSurface(_props: ToolSurfaceProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [doc, setDoc] = useState<WorkflowDoc>(() => makeWorkflow());
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [runUpdate, setRunUpdate] = useState<PipelineUpdate | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const runRef = useRef<{ cancel: () => void } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const savedWorkflows = useSavedWorkflows();

  const running = runUpdate !== null;
  const logsByStep = useMemo(() => {
    const map = new Map<string, StepLog>();
    if (runUpdate) for (const log of runUpdate.logs) map.set(log.stepId, log);
    if (result) for (const log of result.logs) map.set(log.stepId, log);
    return map;
  }, [runUpdate, result]);

  const categoryLabel = useCallback(
    (id: string): string => {
      const category = CATEGORIES.find((item) => item.id === id);
      return category ? category.name[locale] : id;
    },
    [locale]
  );

  /* ---------------- doc mutations (clear stale results) ---------------- */

  const mutate = useCallback(
    (fn: (draft: WorkflowDoc) => WorkflowDoc) => {
      setDoc((current) => fn(current));
      setResult(null);
    },
    []
  );

  const updateStepOptions = useCallback(
    (stepId: string, optionId: string, value: string | number | boolean) => {
      mutate((current) => ({
        ...current,
        steps: current.steps.map((step) =>
          step.id === stepId
            ? { ...step, options: { ...step.options, [optionId]: value } }
            : step
        ),
      }));
    },
    [mutate]
  );

  const moveStep = useCallback(
    (index: number, delta: number) => {
      mutate((current) => {
        const next = [...current.steps];
        const target = index + delta;
        if (target < 0 || target >= next.length) return current;
        [next[index], next[target]] = [next[target], next[index]];
        return { ...current, steps: next };
      });
    },
    [mutate]
  );

  const removeStep = useCallback(
    (stepId: string) => {
      mutate((current) => ({
        ...current,
        steps: current.steps.filter((step) => step.id !== stepId),
      }));
      setExpanded((current) => (current === stepId ? null : current));
    },
    [mutate]
  );

  const addStep = useCallback(
    (toolId: string) => {
      if (!LIBRARY_BY_TOOL.has(toolId)) return;
      setPickerOpen(false);
      if (doc.steps.length >= MAX_STEPS) {
        toast({
          title: t("wf.maxSteps", { max: MAX_STEPS }),
          variant: "destructive",
        });
        return;
      }
      // Step is created OUTSIDE the updater — updaters must stay pure
      // (StrictMode double-invokes them; tool-shell lesson).
      const step = makeStep(toolId);
      mutate((current) => ({ ...current, steps: [...current.steps, step] }));
      setExpanded(step.id);
    },
    [doc.steps.length, mutate, t, toast]
  );

  /* ---------------- toolbar actions ---------------- */

  const handleSave = useCallback(() => {
    const name = doc.name.trim() || t("wf.unnamed");
    saveWorkflow({ ...doc, name });
    toast({ title: t("wf.savedToast") });
  }, [doc, t, toast]);

  const handleLoad = useCallback(
    (loaded: WorkflowDoc) => {
      setSavedOpen(false);
      setDoc(loaded);
      setExpanded(null);
      setResult(null);
    },
    []
  );

  const handleDeleteSaved = useCallback(
    (id: string) => {
      deleteWorkflow(id);
      toast({ title: t("wf.deletedToast") });
    },
    [t, toast]
  );

  const handleExport = useCallback(() => {
    const json = workflowToJson({ ...doc, name: doc.name.trim() || t("wf.unnamed") });
    downloadBlob(
      new Blob([json], { type: "application/json" }),
      workflowFileName(doc)
    );
  }, [doc, t]);

  const handleImportFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = ""; // allow re-selecting the same file
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const parsed = parseWorkflowExport(text, LIBRARY);
          if (!parsed) {
            toast({
              title: t("wf.importFailedTitle"),
              description: t("wf.importFailedDesc"),
              variant: "destructive",
            });
            return;
          }
          setDoc(parsed);
          setExpanded(null);
          setResult(null);
          toast({ title: t("wf.importedToast") });
        })
        .catch(() => undefined);
    },
    [t, toast]
  );

  const handlePreset = useCallback(
    (presetIndex: number) => {
      const preset = WORKFLOW_PRESETS[presetIndex];
      if (!preset) return;
      // Keep a name the user already typed — only the steps are replaced.
      setDoc({ ...presetToDoc(preset), name: doc.name });
      setExpanded(null);
      setResult(null);
      toast({ title: t("wf.presetLoadedToast") });
    },
    [doc.name, t, toast]
  );

  /* ---------------- run ---------------- */

  const handleRun = useCallback(() => {
    if (!inputFile || doc.steps.length === 0 || running) return;
    setResult(null);
    setRunUpdate({ currentIndex: 0, logs: [] });
    const handle = runPipeline(doc, inputFile, setRunUpdate);
    runRef.current = handle;
    void handle.promise.then((outcome) => {
      runRef.current = null;
      setRunUpdate(null);
      if (outcome.status === "cancelled") {
        setResult(null);
        toast({ title: t("wf.runCancelledToast") });
        return;
      }
      setResult(outcome);
      if (outcome.status === "done") {
        for (const log of outcome.logs) {
          if (log.state === "done") trackToolUse(log.toolId);
        }
        toast({ title: t("wf.runDoneToast") });
      }
    });
  }, [doc, inputFile, running, t, toast]);

  const handleCancel = useCallback(() => {
    runRef.current?.cancel();
  }, []);

  const overallPct = useMemo(() => {
    const total = doc.steps.length;
    if (total === 0 || !runUpdate) return 0;
    const logs = runUpdate.logs;
    let done = 0;
    let partial = 0;
    for (const log of logs) {
      if (log.state === "done") done += 1;
      else if (log.state === "running") partial = log.pct / 100;
    }
    return Math.round(((done + partial) / total) * 100);
  }, [doc.steps.length, runUpdate]);

  const runBlockedReason = !inputFile
    ? "wf.runNeedsInput"
    : doc.steps.length === 0
      ? "wf.runNeedsSteps"
      : null;

  /* ---------------- render ---------------- */

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Name + toolbar */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            value={doc.name}
            onChange={(event) =>
              mutate((current) => ({ ...current, name: event.target.value }))
            }
            placeholder={t("wf.namePlaceholder")}
            maxLength={80}
            aria-label={t("wf.nameLabel")}
            disabled={running}
            className="h-9 border-transparent bg-transparent px-2 text-base font-semibold shadow-none focus-visible:border-border sm:text-lg"
          />
          <Badge variant="outline" className="shrink-0 rounded-chip text-xs">
            {doc.steps.length}/{MAX_STEPS}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={running || doc.steps.length === 0}
            title={doc.steps.length === 0 ? t("wf.runNeedsSteps") : undefined}
          >
            <Save className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t("wf.saveAction")}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={running}>
                <Sparkles className="size-4" aria-hidden="true" />
                {t("wf.presets")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>{t("wf.presets")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {WORKFLOW_PRESETS.map((preset, index) => {
                const preview = preset.toolIds
                  .map((id) => LIBRARY_BY_TOOL.get(id)?.tool.name[locale] ?? id)
                  .join(" → ");
                return (
                  <DropdownMenuItem
                    key={preset.key}
                    onClick={() => handlePreset(index)}
                    className="flex-col items-start gap-1"
                  >
                    <span className="text-sm font-medium">
                      {t(`wf.preset.${preset.key}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {preview}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover open={savedOpen} onOpenChange={setSavedOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" disabled={running}>
                <FolderOpen className="size-4" aria-hidden="true" />
                {t("wf.saved")}
                {savedWorkflows.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1 rounded-full px-1.5 text-[10px]"
                  >
                    {savedWorkflows.length}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              {savedWorkflows.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  {t("wf.noSaved")}
                </p>
              ) : (
                <ul className="max-h-72 overflow-y-auto" role="list">
                  {savedWorkflows.map((saved) => (
                    <li
                      key={saved.id}
                      className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {saved.name || t("wf.unnamed")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("wf.stepCount", { count: saved.steps.length })}
                          {" · "}
                          {new Date(saved.updatedAt).toLocaleDateString(
                            locale === "hi" ? "hi-IN" : "en-IN"
                          )}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleLoad(saved)}
                      >
                        {t("wf.load")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t("wf.delete")}
                        onClick={() => handleDeleteSaved(saved.id)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>

          <Separator orientation="vertical" className="hidden h-6 sm:block" />

          <Button variant="outline" size="sm" onClick={handleExport} disabled={running}>
            <FileJson className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t("wf.export")}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => importRef.current?.click()}
            disabled={running}
          >
            <Upload className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t("wf.import")}</span>
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      </div>

      {/* Input card */}
      <section
        aria-label={t("wf.inputTitle")}
        className="rounded-card border border-border bg-card p-4"
      >
        <div className="mb-3 flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">
            {t("wf.inputTitle")}
          </h3>
        </div>
        {inputFile ? (
          <div className="flex items-center gap-3 rounded-btn border border-border bg-background p-3">
            <FileText className="size-5 shrink-0 text-cat-organize" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {inputFile.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(inputFile.size)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("wf.removeInput")}
              onClick={() => {
                setInputFile(null);
                setResult(null);
              }}
              disabled={running}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <DropZone
            labelKey="wf.inputLabel"
            multiple={false}
            maxFiles={1}
            acceptKind="pdf"
            currentCount={0}
            onAccept={(files) => {
              const file = files[0];
              if (file) {
                setInputFile(file);
                setResult(null);
              }
            }}
          />
        )}
      </section>

      {/* Steps */}
      <section aria-label={t("wf.stepsTitle")} className="flex flex-col">
        {doc.steps.length === 0 ? (
          <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("wf.emptySteps")}
          </p>
        ) : (
          doc.steps.map((step, index) => {
            const item = LIBRARY_BY_TOOL.get(step.toolId);
            if (!item) return null;
            const Icon = item.tool.icon;
            const log = logsByStep.get(step.id);
            const isOpen = expanded === step.id;
            const changed = changedSettings(step);
            return (
              <div key={step.id}>
                <div
                  className={
                    "rounded-card border bg-card transition-colors " +
                    (log?.state === "running"
                      ? "border-primary/60 shadow-sm"
                      : log?.state === "error"
                        ? "border-destructive/60"
                        : "border-border")
                  }
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : step.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 p-4 text-left"
                    disabled={running}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {index + 1}
                    </span>
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-btn bg-muted text-foreground"
                      aria-hidden="true"
                    >
                      <Icon className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.tool.name[locale]}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {categoryLabel(item.tool.category)}
                        {changed > 0 &&
                          ` · ${t("wf.settingsChanged", { count: changed })}`}
                        {log?.state === "done" && log.outputNames.length > 1 &&
                          ` · ${t("wf.outputsCount", { count: log.outputNames.length })}`}
                      </span>
                    </span>
                    <StepStateChip log={log} />
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        isOpen && "rotate-180"
                      )}
                      aria-hidden="true"
                    />
                  </button>

                  {log?.state === "running" && (
                    <div className="flex items-center gap-3 px-4 pb-3">
                      <Progress value={log.pct} className="h-1.5 flex-1" />
                      <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                        {t(`tool.stage.${log.stage ?? "processing"}`)}
                      </span>
                    </div>
                  )}

                  {isOpen && (
                    <div className="border-t border-border p-4">
                      <p className="mb-3 text-xs text-muted-foreground">
                        {item.tool.description[locale]}
                      </p>
                      {item.config.options.length > 0 ? (
                        <OptionsPanel
                          fields={item.config.options}
                          values={step.options}
                          onChange={(optionId, value) =>
                            updateStepOptions(step.id, optionId, value)
                          }
                        />
                      ) : (
                        <p className="rounded-btn bg-muted/60 p-3 text-xs text-muted-foreground">
                          {t("wf.noOptions")}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => moveStep(index, -1)}
                          disabled={running || index === 0}
                          aria-label={t("wf.moveUp")}
                        >
                          <ArrowUp className="size-4" aria-hidden="true" />
                          {t("wf.moveUp")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => moveStep(index, 1)}
                          disabled={running || index === doc.steps.length - 1}
                          aria-label={t("wf.moveDown")}
                        >
                          <ArrowDown className="size-4" aria-hidden="true" />
                          {t("wf.moveDown")}
                        </Button>
                        <span className="flex-1" />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeStep(step.id)}
                          disabled={running}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          {t("wf.remove")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                {index < doc.steps.length - 1 && (
                  <div className="ml-8 h-4 w-px bg-border" aria-hidden="true" />
                )}
              </div>
            );
          })
        )}

        {/* Add step */}
        <div className={doc.steps.length > 0 ? "mt-1 ml-8 h-4 w-px bg-border" : ""} aria-hidden="true" />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={running || doc.steps.length >= MAX_STEPS}
          className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border p-4 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden="true" />
          {doc.steps.length >= MAX_STEPS
            ? t("wf.maxSteps", { max: MAX_STEPS })
            : t("wf.addStep")}
        </button>
      </section>

      {/* Output terminal */}
      <section
        aria-label={t("wf.outputTitle")}
        className="rounded-card border border-dashed border-border bg-card/60 p-4"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
            <FileOutput className="size-4" aria-hidden="true" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">
            {t("wf.outputTitle")}
          </h3>
          {result?.status === "done" && (
            <Badge variant="private" className="ml-auto rounded-chip">
              <Check className="size-3" aria-hidden="true" />
              {t("wf.outputReady", { count: result.outputs.length })}
            </Badge>
          )}
        </div>
      </section>

      {/* Error card */}
      {result?.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>
            {t("wf.stepFailed", {
              index: (result.failedIndex + 1).toString(),
            })}
          </AlertTitle>
          <AlertDescription>
            {t(result.logs[result.failedIndex]?.errorCode ?? "tool.errorGeneric", {
              detail: result.logs[result.failedIndex]?.errorDetail ?? "",
            })}
            {result.failedIndex > 0 && ` ${t("wf.partialHint")}`}
          </AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {result && result.outputs.length > 0 && (
        <section
          aria-label={t("wf.resultTitle")}
          className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
        >
          <h3 className="text-sm font-semibold text-foreground">
            {result.status === "done"
              ? t("wf.resultTitle")
              : t("wf.partialTitle")}
          </h3>
          <ul className="flex flex-col gap-2" role="list">
            {result.outputs.map((output, outputIndex) => (
              <li
                key={`${output.name}-${outputIndex}`}
                className="flex items-center gap-3 rounded-btn border border-border bg-background p-3"
              >
                <FileText className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {output.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(output.blob.size)}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => downloadBlob(output.blob, output.name)}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {t("wf.download")}
                </Button>
              </li>
            ))}
          </ul>
          {result.outputs.length > 1 && (
            <Button
              variant="outline"
              onClick={() =>
                result.outputs.forEach((output, outputIndex) =>
                  window.setTimeout(
                    () => downloadBlob(output.blob, output.name),
                    outputIndex * 350
                  )
                )
              }
            >
              <Download className="size-4" aria-hidden="true" />
              {t("wf.downloadAll")}
            </Button>
          )}
        </section>
      )}

      {/* Run bar */}
      <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-card border border-border bg-card/95 p-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:flex-row sm:items-center">
        {running ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Loader2
                className="size-5 shrink-0 animate-spin text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t("wf.runningTitle")} {overallPct}%
                </p>
                <Progress value={overallPct} className="mt-1.5 h-1.5" />
              </div>
            </div>
            <Button variant="outline" onClick={handleCancel}>
              <Ban className="size-4" aria-hidden="true" />
              {t("wf.cancel")}
            </Button>
          </>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                {runBlockedReason
                  ? t(runBlockedReason)
                  : t("wf.runHint", { count: doc.steps.length })}
              </p>
            </div>
            {result?.status === "done" && (
              <Button variant="outline" onClick={() => setResult(null)}>
                {t("wf.editPipeline")}
              </Button>
            )}
            <Button
              onClick={handleRun}
              disabled={runBlockedReason !== null}
              className="min-w-36"
            >
              <Play className="size-4" aria-hidden="true" />
              {t("wf.run")}
            </Button>
          </>
        )}
      </div>

      {/* Tool picker */}
      <CommandDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("wf.pickerTitle")}
        description={t("wf.pickerDesc", { count: LIBRARY.length })}
      >
        <CommandInput placeholder={t("wf.searchTools")} />
        <CommandList className="max-h-80">
          <CommandEmpty>{t("wf.noToolsFound")}</CommandEmpty>
          {(() => {
            const groups = new Map<string, LibraryTool[]>();
            for (const item of LIBRARY) {
              const list = groups.get(item.tool.category) ?? [];
              list.push(item);
              groups.set(item.tool.category, list);
            }
            return CATEGORIES.map((category) => {
              const tools = groups.get(category.id);
              if (!tools || tools.length === 0) return null;
              return (
                <CommandGroup
                  key={category.id}
                  heading={categoryLabel(category.id)}
                >
                  {tools.map((item) => {
                    const Icon = item.tool.icon;
                    return (
                      <CommandItem
                        key={item.tool.id}
                        value={`${item.tool.name.en} ${item.tool.name.hi} ${item.tool.tags.en.join(" ")} ${item.tool.tags.hi.join(" ")}`}
                        onSelect={() => addStep(item.tool.id)}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block truncate">
                            {item.tool.name[locale]}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.tool.description[locale]}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            });
          })()}
        </CommandList>
      </CommandDialog>
    </div>
  );
}
