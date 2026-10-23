"use client";

import type { ComponentType } from "react";

import type { ToolSurfaceProps } from "./panel-types";
import { GridSurface } from "../../../tools/pagegrid/grid-surface";
import { AssembleSurface } from "../../../tools/assemble-pdf/surface";
import { ImageGridSurface } from "../../../tools/imagegrid/image-grid-surface";
import { WatermarkSurface } from "../../../tools/add-watermark/wm-surface";
import { StampSurface } from "../../../tools/stamp-common/stamp-surface";
import { CropSurface } from "../../../tools/crop-pdf/crop-surface";
import { DocInfoSurface } from "../../../tools/change-pdf-doc-info/surface";
import { RemoveMetaSurface } from "../../../tools/remove-pdf-metadata/surface";
import { FillSurface } from "../../../tools/fill-out-pdf/surface";
import { ViewSurface } from "../../../tools/view-pdf/surface";
import { SignSurface } from "../../../tools/sign-pdf/surface";
import { RedactSurface } from "../../../tools/redact-pdf/surface";
import { PasswordSurface } from "../../../tools/generate-password/surface";
import { LockSurface } from "../../../tools/lock-pdf/surface";
import { UnlockSurface } from "../../../tools/unlock-pdf/surface";
import { ScanSurface } from "../../../tools/scan-pdf/surface";
import { ExtractImagesSurface } from "../../../tools/extract-images/surface";
import { SearchSurface } from "../../../tools/search-pdf/surface";
import { CopyFromPdfSurface } from "../../../tools/copy-from-pdf/surface";
import { BookmarkSurface } from "../../../tools/bookmark-pdf/surface";
import { OverlaySurface } from "../../../tools/overlay-pdf/surface";
import { CompareSurface } from "../../../tools/compare-pdf/surface";
import { GenerateQrSurface } from "../../../tools/generate-qr-code/surface";
import { ConvertToPdfSurface } from "../../../tools/convert-to-pdf/surface";
import { ConvertFromPdfSurface } from "../../../tools/convert-from-pdf/surface";
import { MakeFillableSurface } from "../../../tools/make-pdf-fillable/surface";
import { EditSurface } from "../../../tools/edit-pdf/surface";
import { AnnotateSurface } from "../../../tools/annotate-pdf/surface";
import { WriteSurface } from "../../../tools/write-pdf/surface";
import { CreateSurface } from "../../../tools/create-pdf/surface";
import { CollageSurface } from "../../../tools/create-photo-collage/surface";
import { CardSurface } from "../../../tools/create-card/surface";
import { InvoiceSurface } from "../../../tools/create-invoice/surface";
import { FormSurface } from "../../../tools/create-fillable-pdf-form/surface";
import { ResumeSurface } from "../../../tools/create-resume/surface";
import { WordToPdfSurface } from "../../../tools/word-to-pdf/surface";
import { PdfToWordSurface } from "../../../tools/pdf-to-word/surface";
import { ExcelToPdfSurface } from "../../../tools/excel-to-pdf/surface";
import { PdfToExcelSurface } from "../../../tools/pdf-to-excel/surface";
import { PowerpointToPdfSurface } from "../../../tools/powerpoint-to-pdf/surface";
import { RtfToPdfSurface } from "../../../tools/rtf-to-pdf/surface";
import { OdtToPdfSurface } from "../../../tools/odt-to-pdf/surface";
import { HtmlToPdfSurface } from "../../../tools/html-to-pdf/surface";
import { EpubToPdfSurface } from "../../../tools/epub-to-pdf/surface";
import { PdfToPowerpointSurface } from "../../../tools/pdf-to-powerpoint/surface";
import { WebOptimizeSurface } from "../../../tools/web-optimize-pdf/surface";
import { RepairSurface } from "../../../tools/repair-pdf/surface";
import { PdfToSvgSurface } from "../../../tools/pdf-to-svg/surface";
import { PdfToOdtSurface } from "../../../tools/pdf-to-odt/surface";
import { PdfToHtmlSurface } from "../../../tools/pdf-to-html/surface";
import { PdfToMarkdownSurface } from "../../../tools/pdf-to-markdown/surface";
import { PublisherToPdfSurface } from "../../../tools/publisher-to-pdf/surface";
import { WebpageToPdfSurface } from "../../../tools/webpage-to-pdf/surface";
import { CreateInvoiceVisuallySurface } from "../../../tools/create-invoice-visually/surface";
import { CreateElectronicInvoiceSurface } from "../../../tools/create-electronic-invoice/surface";
import { PdfToEInvoiceSurface } from "../../../tools/pdf-to-e-invoice/surface";
import { XmlInvoiceToPdfSurface } from "../../../tools/xml-invoice-to-pdf/surface";
import { ValidateEInvoiceSurface } from "../../../tools/validate-e-invoice/surface";
import { PassportPhotoSurface } from "../../../tools/passport-photo/surface";
import { RequestSignatureSurface } from "../../../tools/request-signature/surface";
import { DigitalSignatureSurface } from "../../../tools/digital-signature/surface";
import { VerifyPdfSignaturesSurface } from "../../../tools/verify-pdf-signatures/surface";
import { ValidatePdfaSurface } from "../../../tools/validate-pdfa/surface";
import { PdfToPdfaSurface } from "../../../tools/pdf-to-pdfa/surface";
import { PN_SPEC } from "../../../tools/add-page-numbers/pn-options";
import { HF_SPEC } from "../../../tools/add-header-footer/hf-options";

/**
 * Workspace surface registry (PageGrid + ImageGrid families, PRD §8.1/§8.6).
 *
 * A surface renders in the ToolShell's MAIN column (full width, mobile
 * included) and owns the file presentation — the classic FileList is
 * skipped for these tools. Panels (aside / mobile sheet) stay separate
 * via TOOL_PANELS.
 *
 * Named module-level components (never created during render) keep the
 * react-hooks/static-components rule happy.
 */

function RotateGridSurface(props: ToolSurfaceProps) {
  return <GridSurface {...props} preset="rotate" />;
}

function RearrangeGridSurface(props: ToolSurfaceProps) {
  return <GridSurface {...props} preset="rearrange" />;
}

function RemoveGridSurface(props: ToolSurfaceProps) {
  return <GridSurface {...props} preset="remove" />;
}

function ExtractGridSurface(props: ToolSurfaceProps) {
  return <GridSurface {...props} preset="extract" />;
}

function PageNumbersStampSurface(props: ToolSurfaceProps) {
  return <StampSurface {...props} spec={PN_SPEC} previewTitleKey="pn.previewTitle" />;
}

function HeaderFooterStampSurface(props: ToolSurfaceProps) {
  return <StampSurface {...props} spec={HF_SPEC} previewTitleKey="hf.previewTitle" />;
}

export const TOOL_SURFACES: Record<string, ComponentType<ToolSurfaceProps>> = {
  "rotate-pdf-pages": RotateGridSurface,
  "rearrange-pdf-pages": RearrangeGridSurface,
  "remove-pdf-pages": RemoveGridSurface,
  "extract-pdf-pages": ExtractGridSurface,
  "assemble-pdf": AssembleSurface,
  "images-to-pdf": ImageGridSurface,
  "jpg-to-pdf": ImageGridSurface,
  "png-to-pdf": ImageGridSurface,
  "webp-to-pdf": ImageGridSurface,
  "heic-to-pdf": ImageGridSurface,
  "tiff-to-pdf": ImageGridSurface,
  "svg-to-pdf": ImageGridSurface,
  "add-watermark": WatermarkSurface,
  "add-page-numbers": PageNumbersStampSurface,
  "add-header-footer": HeaderFooterStampSurface,
  "crop-pdf": CropSurface,
  "change-pdf-doc-info": DocInfoSurface,
  "remove-pdf-metadata": RemoveMetaSurface,
  "fill-out-pdf": FillSurface,
  "view-pdf": ViewSurface,
  "sign-pdf": SignSurface,
  "redact-pdf": RedactSurface,
  "generate-password": PasswordSurface,
  "lock-pdf": LockSurface,
  "unlock-pdf": UnlockSurface,
  "scan-pdf": ScanSurface,
  "extract-images": ExtractImagesSurface,
  "search-pdf": SearchSurface,
  "copy-from-pdf": CopyFromPdfSurface,
  "bookmark-pdf": BookmarkSurface,
  "overlay-pdf": OverlaySurface,
  "compare-pdf": CompareSurface,
  "generate-qr-code": GenerateQrSurface,
  "convert-to-pdf": ConvertToPdfSurface,
  "convert-from-pdf": ConvertFromPdfSurface,
  "make-pdf-fillable": MakeFillableSurface,
  "edit-pdf": EditSurface,
  "annotate-pdf": AnnotateSurface,
  "write-pdf": WriteSurface,
  "create-pdf": CreateSurface,
  "create-photo-collage": CollageSurface,
  "create-card": CardSurface,
  "create-invoice": InvoiceSurface,
  "create-fillable-pdf-form": FormSurface,
  "create-resume": ResumeSurface,
  "word-to-pdf": WordToPdfSurface,
  "pdf-to-word": PdfToWordSurface,
  "excel-to-pdf": ExcelToPdfSurface,
  "pdf-to-excel": PdfToExcelSurface,
  "powerpoint-to-pdf": PowerpointToPdfSurface,
  "rtf-to-pdf": RtfToPdfSurface,
  "odt-to-pdf": OdtToPdfSurface,
  "html-to-pdf": HtmlToPdfSurface,
  "epub-to-pdf": EpubToPdfSurface,
  "pdf-to-powerpoint": PdfToPowerpointSurface,
  "web-optimize-pdf": WebOptimizeSurface,
  "repair-pdf": RepairSurface,
  "pdf-to-svg": PdfToSvgSurface,
  "pdf-to-odt": PdfToOdtSurface,
  "pdf-to-html": PdfToHtmlSurface,
  "pdf-to-markdown": PdfToMarkdownSurface,
  "publisher-to-pdf": PublisherToPdfSurface,
  "webpage-to-pdf": WebpageToPdfSurface,
  "create-invoice-visually": CreateInvoiceVisuallySurface,
  "create-electronic-invoice": CreateElectronicInvoiceSurface,
  "pdf-to-e-invoice": PdfToEInvoiceSurface,
  "xml-invoice-to-pdf": XmlInvoiceToPdfSurface,
  "validate-e-invoice": ValidateEInvoiceSurface,
  "passport-photo": PassportPhotoSurface,
  "request-signature": RequestSignatureSurface,
  "digital-signature": DigitalSignatureSurface,
  "verify-pdf-signatures": VerifyPdfSignaturesSurface,
  "validate-pdfa": ValidatePdfaSurface,
  "pdf-to-pdfa": PdfToPdfaSurface,
};

export function getToolSurface(
  toolId: string
): ComponentType<ToolSurfaceProps> | undefined {
  return TOOL_SURFACES[toolId];
}
