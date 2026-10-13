"use client";

import type { ComponentType } from "react";

import type { ToolSurfaceProps } from "./panel-types";
import { GridSurface } from "../../../tools/pagegrid/grid-surface";
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
  "images-to-pdf": ImageGridSurface,
  "jpg-to-pdf": ImageGridSurface,
  "png-to-pdf": ImageGridSurface,
  "webp-to-pdf": ImageGridSurface,
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
};

export function getToolSurface(
  toolId: string
): ComponentType<ToolSurfaceProps> | undefined {
  return TOOL_SURFACES[toolId];
}
