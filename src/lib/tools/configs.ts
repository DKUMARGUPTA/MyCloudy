import type { ToolConfig } from "@/lib/tools/config-types";
import { config as rotatePdfPages } from "../../../tools/rotate-pdf-pages/config";
import { config as mergePdf } from "../../../tools/merge-pdf/config";

/**
 * Live tool configs (PRD §2.6 "Tool config pattern").
 *
 * Maps tool id -> the config exported by tools/<tool-id>/config.ts.
 * A tool is routable (ToolShell) only when BOTH its registry entry has
 * `enabled: true` AND a config exists here.
 */
export const TOOL_CONFIGS: Record<string, ToolConfig> = {
  [rotatePdfPages.toolId]: rotatePdfPages,
  [mergePdf.toolId]: mergePdf,
};

export function getToolConfig(toolId: string): ToolConfig | undefined {
  return TOOL_CONFIGS[toolId];
}
