import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { renderTextThumbnail } from "@/lib/files/text-thumbnail";

/**
 * Recent-file thumbnails for ANY accepted input kind (PRD §2.4: metadata +
 * a tiny preview only — never the file bytes).
 *
 * - images: decoded + downscaled to ≤ maxDim via createImageBitmap
 * - PDFs: first-page render through the shared queued renderer
 * - text:  first lines drawn onto a small canvas (a real preview for .txt
 *          outputs instead of the generic icon)
 * Returns null when no thumbnail could be produced (entry still lands,
 * the strip simply shows the generic icon for it).
 */
export async function makeFileThumbnail(
  file: File,
  maxDim = 160
): Promise<Blob | null> {
  if (file.type.startsWith("image/")) {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        if (typeof OffscreenCanvas !== "undefined") {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d");
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, width, height);
          return await canvas.convertToBlob({ type: "image/png" });
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        return await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png")
        );
      } finally {
        bitmap.close();
      }
    } catch {
      return null;
    }
  }
  if (file.type.startsWith("text/")) {
    try {
      return await renderTextThumbnail(file, maxDim);
    } catch {
      return null;
    }
  }
  try {
    const { blob } = await renderPdfThumbnail(file, { maxDim });
    return blob;
  } catch {
    return null;
  }
}
