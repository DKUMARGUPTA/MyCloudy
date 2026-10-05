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
