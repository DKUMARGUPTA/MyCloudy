import type { LucideIcon } from "lucide-react";
import {
  Eye,
  FileInput,
  FileOutput,
  Gauge,
  Layers,
  PenLine,
  ReceiptText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

/**
 * Category + planned-tool summary for the Phase 0 landing page.
 * Source of truth: PRD §7 (Complete Tool Catalog) and §4 (Sitemap categories).
 * The full typed tool REGISTRY (slugs, options schemas, i18n name keys,
 * search tags) arrives in Phase 1 — this file intentionally stays a summary.
 *
 * Mode: "D" = Device-only (Private), "S" = Server-assisted (PRD §2.2).
 */

export type ToolMode = "D" | "S";

export interface PlannedTool {
  name: string;
  mode: ToolMode;
}

export type CategoryColor =
  | "organize"
  | "edit"
  | "convert"
  | "security"
  | "optimize"
  | "create"
  | "invoices"
  | "view";

export interface CategorySummary {
  id: string;
  /** i18n key for the localized category name. */
  nameKey: string;
  color: CategoryColor;
  icon: LucideIcon;
  tools: PlannedTool[];
}

const D = (name: string): PlannedTool => ({ name, mode: "D" });
const S = (name: string): PlannedTool => ({ name, mode: "S" });

export const categories: CategorySummary[] = [
  {
    id: "organize",
    nameKey: "categories.names.organize",
    color: "organize",
    icon: Layers,
    tools: [
      D("Merge PDF"),
      D("Assemble PDF"),
      D("Split PDF"),
      D("Rearrange PDF pages"),
      D("Remove PDF pages"),
      D("Extract PDF pages"),
      D("Rotate PDF pages"),
      D("Pages per sheet (N-up)"),
      D("Halve PDF pages"),
      D("Bookmark PDF"),
      D("Extract PDF images"),
      D("Copy from PDF"),
    ],
  },
  {
    id: "edit",
    nameKey: "categories.names.edit",
    color: "edit",
    icon: PenLine,
    tools: [
      D("Edit PDF"),
      D("Annotate PDF"),
      D("Fill out PDF forms"),
      D("Make PDF fillable"),
      D("Add watermark"),
      D("Add page numbers"),
      D("Header & footer"),
      D("Overlay PDF"),
      D("Crop PDF"),
      D("Change page size"),
      D("Change document information"),
    ],
  },
  {
    id: "convert-to",
    nameKey: "categories.names.convert-to",
    color: "convert",
    icon: FileInput,
    tools: [
      S("Word to PDF"),
      S("PowerPoint to PDF"),
      S("Excel to PDF"),
      S("Publisher to PDF"),
      S("OpenDocument to PDF"),
      S("RTF to PDF"),
      S("EPUB to PDF"),
      D("Text to PDF"),
      D("Markdown to PDF"),
      S("HTML to PDF"),
      D("JPG to PDF"),
      D("PNG to PDF"),
      D("WEBP to PDF"),
      D("HEIC to PDF"),
      D("SVG to PDF"),
      D("TIFF to PDF"),
      D("Universal converter"),
      D("HEIC to JPG / PNG"),
      D("WEBP to JPG / PNG"),
      D("Resize image to KB"),
      D("Passport photo maker"),
    ],
  },
  {
    id: "convert-from",
    nameKey: "categories.names.convert-from",
    color: "convert",
    icon: FileOutput,
    tools: [
      S("PDF to Word"),
      S("PDF to PowerPoint"),
      S("PDF to Excel"),
      D("PDF to JPG"),
      D("PDF to PNG"),
      D("PDF to WEBP / TIFF"),
      S("PDF to SVG"),
      D("PDF to Text"),
      D("PDF to HTML"),
      D("PDF to Markdown"),
      S("PDF to ODT / RTF / EPUB"),
      D("Universal converter"),
    ],
  },
  {
    id: "security",
    nameKey: "categories.names.security",
    color: "security",
    icon: ShieldCheck,
    tools: [
      D("Protect PDF"),
      D("Unlock PDF"),
      D("Sign PDF"),
      D("Digital signature"),
      D("Redact PDF"),
      D("Remove PDF metadata"),
      D("Generate password"),
      S("Request signature"),
    ],
  },
  {
    id: "optimize",
    nameKey: "categories.names.optimize",
    color: "optimize",
    icon: Gauge,
    tools: [
      D("Compress PDF"),
      D("Compress to target size"),
      D("Web optimize (linearize)"),
      D("PDF OCR"),
      D("Repair PDF"),
      D("Rasterize PDF"),
      D("Flatten PDF"),
      S("PDF to PDF/A"),
    ],
  },
  {
    id: "create",
    nameKey: "categories.names.create",
    color: "create",
    icon: Sparkles,
    tools: [
      D("Create PDF"),
      D("Write PDF"),
      D("Scan to PDF"),
      S("Webpage to PDF"),
      D("Images to PDF"),
      D("Photo collage"),
      D("Create card"),
      D("Create PDF form"),
      D("Create resume"),
      D("Generate QR code"),
    ],
  },
  {
    id: "invoices",
    nameKey: "categories.names.invoices",
    color: "invoices",
    icon: ReceiptText,
    tools: [
      D("Create invoice (GST ready)"),
      D("Create invoice visually"),
      S("Electronic invoice (Factur-X)"),
      S("PDF invoice to e-invoice"),
      D("XML e-invoice to PDF"),
      S("Validate e-invoice"),
    ],
  },
  {
    id: "view",
    nameKey: "categories.names.view",
    color: "view",
    icon: Eye,
    tools: [
      D("View PDF"),
      D("Compare PDFs"),
      D("Search in PDFs"),
      S("Check PDF/A & PDF/UA"),
      D("Verify PDF signatures"),
      D("Set viewer preferences"),
    ],
  },
];

export const totalPlannedTools: number = categories.reduce(
  (sum, category) => sum + category.tools.length,
  0
);

/** Tinted chip classes per category color (light + dark handled by tokens). */
export const categoryChipClass: Record<CategoryColor, string> = {
  organize: "bg-cat-organize/10 text-cat-organize",
  edit: "bg-cat-edit/10 text-cat-edit",
  convert: "bg-cat-convert/10 text-cat-convert",
  security: "bg-cat-security/10 text-cat-security",
  optimize: "bg-cat-optimize/10 text-cat-optimize",
  create: "bg-cat-create/10 text-cat-create",
  invoices: "bg-cat-invoices/10 text-cat-invoices",
  view: "bg-cat-view/10 text-cat-view",
};

/** Card hover border accent per category color. */
export const categoryHoverClass: Record<CategoryColor, string> = {
  organize: "hover:border-cat-organize/40",
  edit: "hover:border-cat-edit/40",
  convert: "hover:border-cat-convert/40",
  security: "hover:border-cat-security/40",
  optimize: "hover:border-cat-optimize/40",
  create: "hover:border-cat-create/40",
  invoices: "hover:border-cat-invoices/40",
  view: "hover:border-cat-view/40",
};
