import type { L10n } from "@/lib/tools/registry";

/**
 * Config-driven tool system (PRD §2.6 "Tool config pattern").
 *
 * Every live tool ships a config object next to its worker:
 *   tools/<tool-id>/config.ts   -> ToolConfig (options schema + copy)
 *   tools/<tool-id>/worker.ts   -> Web Worker entry (device-only heavy work)
 * The shared ToolShell renders any enabled tool from its registry entry +
 * this config — no per-tool pages are hand-written.
 */

/** One renderable option field in the OptionsPanel (workspace state). */
export type OptionField =
  | {
      kind: "select";
      id: string;
      label: L10n;
      hint?: L10n;
      choices: { value: string; label: L10n }[];
      default: string;
    }
  | {
      kind: "number";
      id: string;
      label: L10n;
      hint?: L10n;
      min: number;
      max: number;
      step?: number;
      suffix?: L10n;
      default: number;
    }
  | {
      kind: "text";
      id: string;
      label: L10n;
      hint?: L10n;
      placeholder?: L10n;
      default: string;
    }
  | {
      kind: "switch";
      id: string;
      label: L10n;
      hint?: L10n;
      default: boolean;
    }
  | {
      /** Page-range text ("all", "1-3, 5, 8-") parsed + validated in the worker. */
      kind: "pages";
      id: string;
      label: L10n;
      hint?: L10n;
      placeholder?: L10n;
      default: string;
    };

/** Values the OptionsPanel produces; plain data so the worker can consume it. */
export type OptionValues = Record<string, string | number | boolean>;

export interface ToolFaqItem {
  q: L10n;
  a: L10n;
}

export interface ToolConfig {
  /** Matches the registry tool id (== URL slug). */
  toolId: string;
  /** Factory for this tool's dedicated Web Worker (Turbopack bundles it). */
  createWorker: () => Worker;
  /** Options schema rendered by the shared OptionsPanel. */
  options: OptionField[];
  /** Landing-state feature bullets (4-6, PRD §6.3). */
  features: L10n[];
  /** Landing-state FAQ (3 items, PRD §6.3). */
  faq: ToolFaqItem[];
  /** Primary output kind — drives naming, preview and chain suggestions. */
  outputKind: "pdf" | "image" | "zip";
  /** File count limits for the DropZone (PRD §6.3 "up to N files"). */
  minFiles: number;
  maxFiles: number;
}

/** Default option values from a schema (used to initialize the workspace). */
export function defaultOptionValues(
  options: OptionField[]
): OptionValues {
  const values: OptionValues = {};
  for (const field of options) {
    values[field.id] = field.default;
  }
  return values;
}
