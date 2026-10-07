import type { ToolConfig } from "@/lib/tools/config-types";
import { config as rotatePdfPages } from "../../../tools/rotate-pdf-pages/config";
import { config as mergePdf } from "../../../tools/merge-pdf/config";
import { config as splitPdf } from "../../../tools/split-pdf/config";
import { config as rearrangePdfPages } from "../../../tools/rearrange-pdf-pages/config";
import { config as removePdfPages } from "../../../tools/remove-pdf-pages/config";
import { config as extractPdfPages } from "../../../tools/extract-pdf-pages/config";
import { config as imagesToPdf } from "../../../tools/images-to-pdf/config";
import { config as jpgToPdf } from "../../../tools/jpg-to-pdf/config";
import { config as pngToPdf } from "../../../tools/png-to-pdf/config";
import { config as webpToPdf } from "../../../tools/webp-to-pdf/config";
import { config as pdfToJpg } from "../../../tools/pdf-to-jpg/config";
import { config as pdfToPng } from "../../../tools/pdf-to-png/config";
import { config as pdfToTxt } from "../../../tools/pdf-to-txt/config";
import { config as addWatermark } from "../../../tools/add-watermark/config";
import { config as addPageNumbers } from "../../../tools/add-page-numbers/config";
import { config as addHeaderFooter } from "../../../tools/add-header-footer/config";
import { config as cropPdf } from "../../../tools/crop-pdf/config";
import { config as changePdfDocInfo } from "../../../tools/change-pdf-doc-info/config";
import { config as removePdfMetadata } from "../../../tools/remove-pdf-metadata/config";
import { config as fillOutPdf } from "../../../tools/fill-out-pdf/config";
import { config as viewPdf } from "../../../tools/view-pdf/config";

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
  [splitPdf.toolId]: splitPdf,
  [rearrangePdfPages.toolId]: rearrangePdfPages,
  [removePdfPages.toolId]: removePdfPages,
  [extractPdfPages.toolId]: extractPdfPages,
  [imagesToPdf.toolId]: imagesToPdf,
  [jpgToPdf.toolId]: jpgToPdf,
  [pngToPdf.toolId]: pngToPdf,
  [webpToPdf.toolId]: webpToPdf,
  [pdfToJpg.toolId]: pdfToJpg,
  [pdfToPng.toolId]: pdfToPng,
  [pdfToTxt.toolId]: pdfToTxt,
  [addWatermark.toolId]: addWatermark,
  [addPageNumbers.toolId]: addPageNumbers,
  [addHeaderFooter.toolId]: addHeaderFooter,
  [cropPdf.toolId]: cropPdf,
  [changePdfDocInfo.toolId]: changePdfDocInfo,
  [removePdfMetadata.toolId]: removePdfMetadata,
  [fillOutPdf.toolId]: fillOutPdf,
  [viewPdf.toolId]: viewPdf,
};

export function getToolConfig(toolId: string): ToolConfig | undefined {
  return TOOL_CONFIGS[toolId];
}
