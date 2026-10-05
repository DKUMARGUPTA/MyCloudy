"use client";

import type { ComponentType } from "react";

import type { ToolPanelProps } from "./panel-types";
import { MergePanel } from "../../../tools/merge-pdf/panel";

/**
 * Custom tool panels (PRD §2.6 "Panel.tsx per tool").
 *
 * Tools whose options need richer UI than the schema fields (per-file
 * inputs, sort controls) register a panel component here. The ToolShell
 * renders it above the schema-driven OptionsPanel; tools without an entry
 * use the OptionsPanel alone.
 */
export const TOOL_PANELS: Record<string, ComponentType<ToolPanelProps>> = {
  "merge-pdf": MergePanel,
};

export function getToolPanel(toolId: string): ComponentType<ToolPanelProps> | undefined {
  return TOOL_PANELS[toolId];
}
