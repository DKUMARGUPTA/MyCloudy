import type { OptionValues } from "./config-types";

/**
 * Custom per-tool options panel contract (PRD §2.6: tools/<id>/Panel.tsx).
 *
 * Rendered by the shared ToolShell above the schema-driven OptionsPanel,
 * in both the desktop sidebar and the mobile bottom sheet. Panels receive
 * the live workspace state (files, option values) and can mutate it
 * through the provided callbacks — nothing else, so every tool stays a
 * config + worker + optional panel triple.
 */

export interface ToolFileRef {
  id: string;
  file: File;
}

export interface ToolPanelProps {
  /** Current workspace files, in merge/display order. */
  files: ToolFileRef[];
  /** Live option values (shared with the schema-driven panel). */
  values: OptionValues;
  /** Set one option value (same keys the worker receives). */
  onChange: (id: string, value: string | number | boolean) => void;
  /** Replace the whole file order (sort buttons, etc.). */
  setFileOrder: (items: ToolFileRef[]) => void;
}

/**
 * Workspace surface contract (PageGrid family): like a panel, but rendered
 * in the MAIN column (full width, mobile included) instead of the options
 * aside. Surfaces own the file presentation — the ToolShell skips the
 * FileList when one is registered. `setRunBlocked` lets a surface gate the
 * sticky CTA (PRD §8.1 safety: "sab pages delete ho to Apply disabled").
 */
export interface ToolSurfaceProps extends ToolPanelProps {
  /** Block the run with an i18n reason key, or null to clear. */
  setRunBlocked: (reasonKey: string | null) => void;
}
