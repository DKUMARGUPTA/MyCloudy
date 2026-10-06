"use client";

import type { ComponentType } from "react";

import type { ToolPanelProps } from "./panel-types";
import { MergePanel } from "../../../tools/merge-pdf/panel";
import { SplitPanel } from "../../../tools/split-pdf/panel";
import { GridSummaryPanel } from "../../../tools/pagegrid/summary-panel";
import { PdfToImagesPanel } from "../../../tools/pdf-to-images/panel";
import { PdfToTxtPanel } from "../../../tools/pdf-to-txt/panel";
import { WatermarkPanel } from "../../../tools/add-watermark/panel";
import { PageNumbersPanel } from "../../../tools/add-page-numbers/panel";
import { HeaderFooterPanel } from "../../../tools/add-header-footer/panel";

/**
 * Custom tool panels (PRD §2.6 "Panel.tsx per tool").
 *
 * Tools whose options need richer UI than the schema fields (per-file
 * inputs, sort controls) register a panel component here. The ToolShell
 * renders it above the schema-driven OptionsPanel; tools without an entry
 * use the OptionsPanel alone.
 */

function RotateSummaryPanel(props: ToolPanelProps) {
  return <GridSummaryPanel {...props} preset="rotate" />;
}

function RearrangeSummaryPanel(props: ToolPanelProps) {
  return <GridSummaryPanel {...props} preset="rearrange" />;
}

function RemoveSummaryPanel(props: ToolPanelProps) {
  return <GridSummaryPanel {...props} preset="remove" />;
}

function ExtractSummaryPanel(props: ToolPanelProps) {
  return <GridSummaryPanel {...props} preset="extract" />;
}

export const TOOL_PANELS: Record<string, ComponentType<ToolPanelProps>> = {
  "merge-pdf": MergePanel,
  "split-pdf": SplitPanel,
  "rotate-pdf-pages": RotateSummaryPanel,
  "rearrange-pdf-pages": RearrangeSummaryPanel,
  "remove-pdf-pages": RemoveSummaryPanel,
  "extract-pdf-pages": ExtractSummaryPanel,
  "pdf-to-jpg": PdfToImagesPanel,
  "pdf-to-png": PdfToImagesPanel,
  "pdf-to-txt": PdfToTxtPanel,
  "add-watermark": WatermarkPanel,
  "add-page-numbers": PageNumbersPanel,
  "add-header-footer": HeaderFooterPanel,
};

export function getToolPanel(
  toolId: string
): ComponentType<ToolPanelProps> | undefined {
  return TOOL_PANELS[toolId];
}
