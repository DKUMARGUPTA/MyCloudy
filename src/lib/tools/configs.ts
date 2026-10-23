import type { ToolConfig } from "@/lib/tools/config-types";
import { config as rotatePdfPages } from "../../../tools/rotate-pdf-pages/config";
import { config as mergePdf } from "../../../tools/merge-pdf/config";
import { config as assemblePdf } from "../../../tools/assemble-pdf/config";
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
import { config as pdfToWebp } from "../../../tools/pdf-to-webp/config";
import { config as pdfToTiff } from "../../../tools/pdf-to-tiff/config";
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
import { config as tiffToPdf } from "../../../tools/tiff-to-pdf/config";
import { config as svgToPdf } from "../../../tools/svg-to-pdf/config";
import { config as ocrPdf } from "../../../tools/ocr-pdf/config";
import { config as compressPdfToSize } from "../../../tools/compress-pdf-to-size/config";
import { config as pagesPerSheet } from "../../../tools/pages-per-sheet/config";
import { config as halvePdfPages } from "../../../tools/halve-pdf-pages/config";
import { config as flattenPdf } from "../../../tools/flatten-pdf/config";
import { config as extractImages } from "../../../tools/extract-images/config";
import { config as searchPdf } from "../../../tools/search-pdf/config";
import { config as copyFromPdf } from "../../../tools/copy-from-pdf/config";
import { config as txtToPdf } from "../../../tools/txt-to-pdf/config";
import { config as markdownToPdf } from "../../../tools/markdown-to-pdf/config";
import { config as bookmarkPdf } from "../../../tools/bookmark-pdf/config";
import { config as generateQrCode } from "../../../tools/generate-qr-code/config";
import { config as comparePdf } from "../../../tools/compare-pdf/config";
import { config as overlayPdf } from "../../../tools/overlay-pdf/config";
import { config as changePdfPageSize } from "../../../tools/change-pdf-page-size/config";
import { config as convertToPdf } from "../../../tools/convert-to-pdf/config";
import { config as convertFromPdf } from "../../../tools/convert-from-pdf/config";
import { config as rasterizePdf } from "../../../tools/rasterize-pdf/config";
import { config as makePdfFillable } from "../../../tools/make-pdf-fillable/config";
import { config as setPdfViewerPreferences } from "../../../tools/set-pdf-viewer-preferences/config";
import { config as resizeImageKb } from "../../../tools/resize-image-kb/config";
import { config as editPdf } from "../../../tools/edit-pdf/config";
import { config as annotatePdf } from "../../../tools/annotate-pdf/config";
import { config as writePdf } from "../../../tools/write-pdf/config";
import { config as createPdf } from "../../../tools/create-pdf/config";
import { config as createPhotoCollage } from "../../../tools/create-photo-collage/config";
import { config as createCard } from "../../../tools/create-card/config";
import { config as createInvoice } from "../../../tools/create-invoice/config";
import { config as createFillableForm } from "../../../tools/create-fillable-pdf-form/config";
import { config as createResume } from "../../../tools/create-resume/config";
import { config as wordToPdf } from "../../../tools/word-to-pdf/config";
import { config as pdfToWord } from "../../../tools/pdf-to-word/config";
import { config as excelToPdf } from "../../../tools/excel-to-pdf/config";
import { config as pdfToExcel } from "../../../tools/pdf-to-excel/config";
import { config as powerpointToPdf } from "../../../tools/powerpoint-to-pdf/config";
import { config as rtfToPdf } from "../../../tools/rtf-to-pdf/config";
import { config as odtToPdf } from "../../../tools/odt-to-pdf/config";
import { config as htmlToPdf } from "../../../tools/html-to-pdf/config";
import { config as epubToPdf } from "../../../tools/epub-to-pdf/config";
import { config as pdfToPowerpoint } from "../../../tools/pdf-to-powerpoint/config";
import { config as webOptimizePdf } from "../../../tools/web-optimize-pdf/config";
import { config as repairPdf } from "../../../tools/repair-pdf/config";
import { config as pdfToSvg } from "../../../tools/pdf-to-svg/config";
import { config as pdfToMarkdown } from "../../../tools/pdf-to-markdown/config";
import { config as pdfToHtml } from "../../../tools/pdf-to-html/config";
import { config as pdfToOdt } from "../../../tools/pdf-to-odt/config";
import { config as publisherToPdf } from "../../../tools/publisher-to-pdf/config";
import { config as webpageToPdf } from "../../../tools/webpage-to-pdf/config";
import { config as createInvoiceVisually } from "../../../tools/create-invoice-visually/config";
import { config as createElectronicInvoice } from "../../../tools/create-electronic-invoice/config";
import { config as pdfToEInvoice } from "../../../tools/pdf-to-e-invoice/config";
import { config as xmlInvoiceToPdf } from "../../../tools/xml-invoice-to-pdf/config";
import { config as validateEInvoice } from "../../../tools/validate-e-invoice/config";
import { config as passportPhoto } from "../../../tools/passport-photo/config";
import { config as requestSignature } from "../../../tools/request-signature/config";
import { config as digitalSignature } from "../../../tools/digital-signature/config";
import { config as verifyPdfSignatures } from "../../../tools/verify-pdf-signatures/config";


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
  [assemblePdf.toolId]: assemblePdf,
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
  [pdfToWebp.toolId]: pdfToWebp,
  [pdfToTiff.toolId]: pdfToTiff,
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
  [tiffToPdf.toolId]: tiffToPdf,
  [svgToPdf.toolId]: svgToPdf,
  [ocrPdf.toolId]: ocrPdf,
  [compressPdfToSize.toolId]: compressPdfToSize,
  [pagesPerSheet.toolId]: pagesPerSheet,
  [halvePdfPages.toolId]: halvePdfPages,
  [flattenPdf.toolId]: flattenPdf,
  [extractImages.toolId]: extractImages,
  [searchPdf.toolId]: searchPdf,
  [copyFromPdf.toolId]: copyFromPdf,
  [txtToPdf.toolId]: txtToPdf,
  [markdownToPdf.toolId]: markdownToPdf,
  [bookmarkPdf.toolId]: bookmarkPdf,
  [generateQrCode.toolId]: generateQrCode,
  [comparePdf.toolId]: comparePdf,
  [overlayPdf.toolId]: overlayPdf,
  [changePdfPageSize.toolId]: changePdfPageSize,
  [convertToPdf.toolId]: convertToPdf,
  [convertFromPdf.toolId]: convertFromPdf,
  [rasterizePdf.toolId]: rasterizePdf,
  [makePdfFillable.toolId]: makePdfFillable,
  [setPdfViewerPreferences.toolId]: setPdfViewerPreferences,
  [resizeImageKb.toolId]: resizeImageKb,
  [editPdf.toolId]: editPdf,
  [annotatePdf.toolId]: annotatePdf,
  [writePdf.toolId]: writePdf,
  [createPdf.toolId]: createPdf,
  [createPhotoCollage.toolId]: createPhotoCollage,
  [createCard.toolId]: createCard,
  [createInvoice.toolId]: createInvoice,
  [createFillableForm.toolId]: createFillableForm,
  [createResume.toolId]: createResume,
  [wordToPdf.toolId]: wordToPdf,
  [pdfToWord.toolId]: pdfToWord,
  [excelToPdf.toolId]: excelToPdf,
  [pdfToExcel.toolId]: pdfToExcel,
  [powerpointToPdf.toolId]: powerpointToPdf,
  [rtfToPdf.toolId]: rtfToPdf,
  [odtToPdf.toolId]: odtToPdf,
  [htmlToPdf.toolId]: htmlToPdf,
  [epubToPdf.toolId]: epubToPdf,
  [pdfToPowerpoint.toolId]: pdfToPowerpoint,
  [webOptimizePdf.toolId]: webOptimizePdf,
  [repairPdf.toolId]: repairPdf,
  [pdfToSvg.toolId]: pdfToSvg,
  [pdfToOdt.toolId]: pdfToOdt,
  [publisherToPdf.toolId]: publisherToPdf,
  [pdfToHtml.toolId]: pdfToHtml,
  [pdfToMarkdown.toolId]: pdfToMarkdown,
  [webpageToPdf.toolId]: webpageToPdf,
  [createInvoiceVisually.toolId]: createInvoiceVisually,
  [createElectronicInvoice.toolId]: createElectronicInvoice,
  [pdfToEInvoice.toolId]: pdfToEInvoice,
  [xmlInvoiceToPdf.toolId]: xmlInvoiceToPdf,
  [validateEInvoice.toolId]: validateEInvoice,
  [passportPhoto.toolId]: passportPhoto,
  [requestSignature.toolId]: requestSignature,
  [digitalSignature.toolId]: digitalSignature,
  [verifyPdfSignatures.toolId]: verifyPdfSignatures,
};

export function getToolConfig(toolId: string): ToolConfig | undefined {
  return TOOL_CONFIGS[toolId];
}
