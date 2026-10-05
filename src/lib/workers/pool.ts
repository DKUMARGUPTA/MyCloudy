import { TOOL_CONFIGS } from "@/lib/tools/configs";
import type { OptionValues } from "@/lib/tools/config-types";
import { clearWorkingFiles } from "@/lib/storage/opfs";
import {
  isWorkerResponse,
  type RunStage,
  type StageDetail,
  type ToolOutput,
  type WorkerResponse,
} from "./protocol";

/**
 * Worker pool for device-only tools (PRD §2.6 "lib/pdf … worker pool").
 *
 * - One worker per tool run is acquired from an idle pool keyed by tool id;
 *   finished workers are returned and reused (warm pdf-lib instances).
 * - Caps concurrent workers at min(hardwareConcurrency - 1, 4); extra runs
 *   wait for a slot instead of starving low-end phones (§2.4).
 * - cancel() terminates the worker instantly (§6.3) and clears OPFS temps.
 * - Workers post progress/result/error via the protocol in protocol.ts.
 *
 * Slot accounting is one-shot per run: a run that never acquired a slot
 * (cancelled while queued) releases nothing, and a cancelled run's late
 * worker messages are ignored rather than double-releasing the slot.
 */

export class RunCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelledError";
  }
}

export class ToolRunError extends Error {
  constructor(
    public code: string,
    public detail?: string
  ) {
    super(code);
    this.name = "ToolRunError";
  }
}

export interface RunProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface RunHandle {
  cancel(): void;
  promise: Promise<ToolOutput[]>;
}

interface PendingRun {
  resolve: (outputs: ToolOutput[]) => void;
  reject: (error: unknown) => void;
  onProgress: (progress: RunProgress) => void;
}

function maxConcurrent(): number {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, cores - 1));
}

class ToolWorkerPool {
  private idle = new Map<string, Worker[]>();
  private pending = new Map<number, PendingRun>();
  private nextRunId = 1;
  private activeCount = 0;
  private waitQueue: (() => void)[] = [];

  run(
    toolId: string,
    options: OptionValues,
    files: File[],
    onProgress: (progress: RunProgress) => void
  ): RunHandle {
    const config = TOOL_CONFIGS[toolId];
    if (!config) {
      return {
        cancel: () => undefined,
        promise: Promise.reject(
          new ToolRunError("tool-not-configured", toolId)
        ),
      };
    }

    const runId = this.nextRunId;
    this.nextRunId += 1;

    let settled = false;
    let slotAcquired = false;
    let slotReleased = false;
    let worker: Worker | null = null;

    const releaseSlotOnce = () => {
      if (slotAcquired && !slotReleased) {
        slotReleased = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        const next = this.waitQueue.shift();
        if (next) next();
      }
    };

    const settleWith = (error: unknown) => {
      if (settled) return;
      settled = true;
      const pendingRun = this.pending.get(runId);
      this.pending.delete(runId);
      pendingRun?.reject(error);
    };

    const settleSuccess = (outputs: ToolOutput[]) => {
      if (settled) return;
      settled = true;
      const pendingRun = this.pending.get(runId);
      this.pending.delete(runId);
      pendingRun?.resolve(outputs);
    };

    const promise = new Promise<ToolOutput[]>((resolve, reject) => {
      this.pending.set(runId, { resolve, reject, onProgress });

      void (async () => {
        await this.acquireSlot();
        slotAcquired = true;
        if (settled) {
          releaseSlotOnce();
          return;
        }
        worker = this.acquireWorker(toolId);
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (!isWorkerResponse(event.data)) return;
          if (event.data.runId !== runId) return;
          if (settled) return; // cancelled mid-flight — worker is doomed
          const response = event.data;
          if (response.type === "progress") {
            this.pending
              .get(response.runId)
              ?.onProgress({
                pct: response.pct,
                stage: response.stage,
                detail: response.detail,
              });
            return;
          }
          if (worker) this.returnWorker(toolId, worker);
          releaseSlotOnce();
          if (response.type === "result") {
            settleSuccess(response.outputs);
          } else {
            settleWith(new ToolRunError(response.code, response.detail));
          }
        };
        worker.onerror = () => {
          if (settled) return;
          if (worker) this.discardWorker(worker);
          releaseSlotOnce();
          settleWith(new ToolRunError("worker-crash"));
        };
        worker.postMessage({ type: "run", runId, toolId, options, files });
      })();
    });

    return {
      cancel: () => {
        if (settled) return;
        settled = true;
        if (worker) this.discardWorker(worker);
        releaseSlotOnce();
        const pendingRun = this.pending.get(runId);
        this.pending.delete(runId);
        pendingRun?.reject(new RunCancelledError());
        void clearWorkingFiles().catch(() => undefined);
      },
      promise,
    };
  }

  private acquireSlot(): Promise<void> {
    if (this.activeCount < maxConcurrent()) {
      this.activeCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waitQueue.push(resolve)).then(
      () => {
        this.activeCount += 1;
      }
    );
  }

  private acquireWorker(toolId: string): Worker {
    const pool = this.idle.get(toolId);
    const reused = pool?.pop();
    if (reused) return reused;
    return TOOL_CONFIGS[toolId].createWorker();
  }

  private returnWorker(toolId: string, worker: Worker): void {
    const pool = this.idle.get(toolId) ?? [];
    pool.push(worker);
    this.idle.set(toolId, pool);
  }

  private discardWorker(worker: Worker): void {
    worker.terminate();
  }
}

/** Process-wide singleton pool. */
export const toolRunner = new ToolWorkerPool();
