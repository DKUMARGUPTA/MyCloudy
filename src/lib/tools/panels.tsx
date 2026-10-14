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
import { CropPanel } from "../../../tools/crop-pdf/panel";
import { DocInfoPanel } from "../../../tools/change-pdf-doc-info/panel";
import { RemoveMetaPanel } from "../../../tools/remove-pdf-metadata/panel";
import { PagesPerSheetPanel } from "../../../tools/pages-per-sheet/panel";
import { HalvePanel } from "../../../tools/halve-pdf-pages/panel";
import { SearchPanel } from "../../../tools/search-pdf/panel";
import { BookmarkPanel } from "../../../tools/bookmark-pdf/panel";
import { OverlayPanel } from "../../../tools/overlay-pdf/panel";
import { PageSizePanel } from "../../../tools/change-pdf-page-size/panel";

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
  "crop-pdf": CropPanel,
  "change-pdf-doc-info": DocInfoPanel,
  "remove-pdf-metadata": RemoveMetaPanel,
  "pages-per-sheet": PagesPerSheetPanel,
  "halve-pdf-pages": HalvePanel,
  "search-pdf": SearchPanel,
  "bookmark-pdf": BookmarkPanel,
  "overlay-pdf": OverlayPanel,
  "change-pdf-page-size": PageSizePanel,
};

export function getToolPanel(
  toolId: string
): ComponentType<ToolPanelProps> | undefined {
  return TOOL_PANELS[toolId];
}
