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
import { config as compressPdf } from "../../../tools/compress-pdf/config";
import { config as signPdf } from "../../../tools/sign-pdf/config";
import { config as redactPdf } from "../../../tools/redact-pdf/config";
import { config as generatePassword } from "../../../tools/generate-password/config";
import { config as lockPdf } from "../../../tools/lock-pdf/config";
import { config as unlockPdf } from "../../../tools/unlock-pdf/config";
import { config as scanPdf } from "../../../tools/scan-pdf/config";
import { config as webpToJpg } from "../../../tools/webp-to-jpg/config";
import { config as webpToPng } from "../../../tools/webp-to-png/config";
import { config as heicToJpg } from "../../../tools/heic-to-jpg/config";
import { config as heicToPng } from "../../../tools/heic-to-png/config";
import { config as heicToPdf } from "../../../tools/heic-to-pdf/config";
import { config as ocrPdf } from "../../../tools/ocr-pdf/config";

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
  [compressPdf.toolId]: compressPdf,
  [signPdf.toolId]: signPdf,
  [redactPdf.toolId]: redactPdf,
  [generatePassword.toolId]: generatePassword,
  [lockPdf.toolId]: lockPdf,
  [unlockPdf.toolId]: unlockPdf,
  [scanPdf.toolId]: scanPdf,
  [webpToJpg.toolId]: webpToJpg,
  [webpToPng.toolId]: webpToPng,
  [heicToJpg.toolId]: heicToJpg,
  [heicToPng.toolId]: heicToPng,
  [heicToPdf.toolId]: heicToPdf,
  [ocrPdf.toolId]: ocrPdf,
};

export function getToolConfig(toolId: string): ToolConfig | undefined {
  return TOOL_CONFIGS[toolId];
}
