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

/**
 * Show this field only while another field holds `equals` (string compare
 * against the option value). Used for "Custom" reveals — e.g. quality/maxDim
 * fields appear only when the preset select is on "custom". Hidden fields
 * keep their values; workers simply don't read them.
 */
export interface ShowWhen {
  id: string;
  equals: string | boolean;
}

/** One renderable option field in the OptionsPanel (workspace state). */
export type OptionField =
  | {
      kind: "select";
      id: string;
      label: L10n;
      hint?: L10n;
      choices: { value: string; label: L10n }[];
      default: string;
      showWhen?: ShowWhen;
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
      showWhen?: ShowWhen;
    }
  | {
      kind: "text";
      id: string;
      label: L10n;
      hint?: L10n;
      placeholder?: L10n;
      default: string;
      showWhen?: ShowWhen;
    }
  | {
      kind: "switch";
      id: string;
      label: L10n;
      hint?: L10n;
      default: boolean;
      showWhen?: ShowWhen;
    }
  | {
      /** Page-range text ("all", "1-3, 5, 8-") parsed + validated in the worker. */
      kind: "pages";
      id: string;
      label: L10n;
      hint?: L10n;
      placeholder?: L10n;
      default: string;
      showWhen?: ShowWhen;
    };

/** A field is visible unless its `showWhen` dependency mismatches. */
export function fieldVisible(
  field: OptionField,
  values: OptionValues
): boolean {
  if (!field.showWhen) return true;
  const dep = values[field.showWhen.id];
  return String(dep ?? "") === String(field.showWhen.equals);
}

/** Values the OptionsPanel produces; plain data so the worker can consume it. */
export type OptionValues = Record<string, string | number | boolean>;

export interface ToolFaqItem {
  q: L10n;
  a: L10n;
}

export interface ToolConfig {
  /** Matches the registry tool id (== URL slug). */
  toolId: string;
  /**
   * Factory for this tool's dedicated Web Worker (Turbopack bundles it).
   * Optional ONLY for viewer tools (`viewerOnly: true`) — they never run.
   */
  createWorker?: () => Worker;
  /** Options schema rendered by the shared OptionsPanel. */
  options: OptionField[];
  /** Landing-state feature bullets (4-6, PRD §6.3). */
  features: L10n[];
  /** Landing-state FAQ (3 items, PRD §6.3). */
  faq: ToolFaqItem[];
  /**
   * Primary output kind — drives naming, preview and chain suggestions.
   * Required for runnable tools; unused by viewer tools.
   */
  outputKind?: "pdf" | "image" | "text" | "zip";
  /**
   * Viewer tools (PRD §6.5, e.g. View PDF) have no processing step at all:
   * the ToolShell hides the sticky run CTA and never enters the
   * processing/result phases — the workspace surface IS the product
   * (print, download and continue-with chains live inside it).
   */
  viewerOnly?: boolean;
  /**
   * No-file tools (e.g. Generate Password) never touch a document: the
   * surface is the whole product and renders directly on the LANDING
   * page in place of the DropZone — no upload, no run CTA, no options
   * aside, no processing/result phases. Surfaces for such tools must
   * tolerate an empty file list (they ignore files entirely).
   */
  noFile?: boolean;
  /**
   * Camera-first tools (e.g. Scan to PDF) keep the full run pipeline but
   * render their surface on the LANDING page in place of the DropZone —
   * the surface embeds its own inputs (camera capture + gallery picker
   * via addFiles) so the primary flow needs no upload first. minFiles 0
   * is expected; the surface gates the CTA via setRunBlocked.
   */
  landingSurface?: boolean;
  /**
   * Landing "How it works" step keys (exactly 3, i18n). Defaults:
   * viewer tools → view.how1-3, everything else → tool.how1-3. No-file
   * tools usually need their own steps (there is no file to select).
   */
  howKeys?: string[];
  /** File count limits for the DropZone (PRD §6.3 "up to N files"). */
  minFiles: number;
  maxFiles: number;
  /**
   * Curated "what next?" chain tool ids (PRD §6.4). Omit to use the
   * default PDF-result suggestions; image-output tools MUST point at
   * image-accepting tools so chains never hand a JPG to a PDF-only tool.
   */
  chainToolIds?: string[];
  /**
   * Extra in-memory run assets beside the workspace files (e.g. the
   * watermark logo image). Called by the shell when a run starts; the
   * files ride the worker message — never the network.
   */
  collectAssets?: () => File[];
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
