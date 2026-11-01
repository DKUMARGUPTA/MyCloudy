"use client";

import { toolRunner, RunCancelledError } from "@/lib/workers/pool";
import type { RunProgress } from "@/lib/workers/pool";
import type { ToolOutput } from "@/lib/workers/protocol";
import type { WorkflowDoc, WorkflowStep } from "./lib";

/**
 * Workflow runner (PHASE-6) — sequential orchestration over the shared
 * toolRunner worker pool. Each step runs the EXACT worker its standalone
 * tool uses (same options schema, same bytes-out contract); outputs are
 * wrapped back into Files and fed to the next step, so intermediate
 * results never leave memory.
 *
 * Cancel semantics: cancelling terminates only the in-flight step's
 * worker (pool handles that) and rejects the pipeline promise with
 * RunCancelledError — steps after the current one never start.
 */

export type StepState = "pending" | "running" | "done" | "error" | "cancelled";

export interface StepLog {
  stepId: string;
  toolId: string;
  state: StepState;
  /** 0–100 within this step (live from the worker). */
  pct: number;
  /** Worker stage key while running ("reading"|"processing"|"saving"). */
  stage?: string;
  /** Translated error code when state === "error". */
  errorCode?: string;
  errorDetail?: string;
  /** Output file names this step produced (filled when done). */
  outputNames: string[];
}

export interface PipelineUpdate {
  /** Index of the currently-running step (or steps.length when idle). */
  currentIndex: number;
  logs: StepLog[];
}

export interface PipelineResult {
  outputs: ToolOutput[];
  logs: StepLog[];
  /** Index of the step that failed (-1 when no step failed). */
  failedIndex: number;
  /** Whole-chain outcome. */
  status: "done" | "cancelled" | "error";
}

export interface PipelineHandle {
  cancel(): void;
  promise: Promise<PipelineResult>;
}

function initialLogs(steps: WorkflowStep[]): StepLog[] {
  return steps.map((step) => ({
    stepId: step.id,
    toolId: step.toolId,
    state: "pending" as StepState,
    pct: 0,
    outputNames: [],
  }));
}

/** Blob outputs → real Files (name + mime preserved for the next worker). */
export function outputsToFiles(outputs: ToolOutput[]): File[] {
  return outputs.map(
    (output) => new File([output.blob], output.name, { type: output.mime })
  );
}

export function runPipeline(
  doc: WorkflowDoc,
  inputFile: File,
  onUpdate: (update: PipelineUpdate) => void
): PipelineHandle {
  const logs = initialLogs(doc.steps);
  let cancelled = false;
  let activeCancel: (() => void) | null = null;

  const emit = (currentIndex: number) => onUpdate({ currentIndex, logs });

  const promise = (async (): Promise<PipelineResult> => {
    let current: File[] = [inputFile];
    let failedIndex = -1;
    let status: PipelineResult["status"] = "done";

    for (let index = 0; index < doc.steps.length; index += 1) {
      if (cancelled) break;
      const step = doc.steps[index];
      const log = logs[index];
      log.state = "running";
      log.pct = 0;
      emit(index);

      // Stable per-run file ids (page-grid tools are excluded from the
      // library, so no option references these — but the protocol likes
      // them present and merge-style tools keep them aligned with files).
      const fileIds = current.map((_, fileIndex) => `wf-${index}-${fileIndex}`);

      try {
        const handle = toolRunner.run(
          step.toolId,
          step.options,
          current,
          (progress: RunProgress) => {
            log.pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
            log.stage = progress.stage;
            emit(index);
          },
          fileIds
        );
        activeCancel = handle.cancel;
        const result = await handle.promise;
        activeCancel = null;

        log.state = "done";
        log.pct = 100;
        log.outputNames = result.outputs.map((output) => output.name);
        emit(index + 1);

        current = outputsToFiles(result.outputs);
        if (current.length === 0) {
          // A step that produces nothing cannot feed the next one.
          log.state = "error";
          log.errorCode = "tool.errorGeneric";
          log.errorDetail = "no output";
          failedIndex = index;
          status = "error";
          emit(index);
          break;
        }
      } catch (error) {
        activeCancel = null;
        if (cancelled || error instanceof RunCancelledError) {
          log.state = "cancelled";
          status = "cancelled";
          emit(index);
          break;
       }
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "tool.errorGeneric";
        const detail =
          error && typeof error === "object" && "detail" in error
            ? String((error as { detail: unknown }).detail ?? "")
            : "";
        log.state = "error";
        log.pct = 0;
        log.errorCode = code;
        log.errorDetail = detail;
        failedIndex = index;
        status = "error";
        emit(index);
        break;
      }
    }

    if (cancelled && status === "done") status = "cancelled";
    return { outputs: outputsFromFiles(current), logs, failedIndex, status };
  })();

  return {
    cancel: () => {
      cancelled = true;
      activeCancel?.();
    },
    promise,
  };
}

/** Files back to output shape for the result view (blob + name + mime). */
function outputsFromFiles(files: File[]): ToolOutput[] {
  return files.map((file) => ({
    name: file.name,
    mime: file.type || "application/pdf",
    blob: file.slice(0, file.size, file.type || "application/pdf"),
  }));
}
