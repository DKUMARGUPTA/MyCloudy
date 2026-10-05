"use client";

import type { ComponentType } from "react";

import type { ToolSurfaceProps } from "./panel-types";
import { GridSurface } from "../../../tools/pagegrid/grid-surface";

/**
 * Workspace surface registry (PageGrid family, PRD §8.1).
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

export const TOOL_SURFACES: Record<string, ComponentType<ToolSurfaceProps>> = {
  "rotate-pdf-pages": RotateGridSurface,
  "rearrange-pdf-pages": RearrangeGridSurface,
  "remove-pdf-pages": RemoveGridSurface,
  "extract-pdf-pages": ExtractGridSurface,
};

export function getToolSurface(
  toolId: string
): ComponentType<ToolSurfaceProps> | undefined {
  return TOOL_SURFACES[toolId];
}
