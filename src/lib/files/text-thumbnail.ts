/**
 * Text-file thumbnails (PRD §2.8): .txt tool outputs get a real "document"
 * preview — the first lines rendered onto a small canvas — instead of the
 * generic fallback icon. Pure canvas drawing, no network, no DOM.
 */

const LINE_COUNT = 9;

export async function renderTextThumbnail(
  blob: Blob,
  maxDim = 160
): Promise<Blob | null> {
  let text: string;
  try {
    text = await blob.slice(0, 600).text();
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, LINE_COUNT);
  if (lines.length === 0) return null;

  // Portrait 3:4 like the PDF thumbnails, so strips stay visually even.
  const width = maxDim;
  const height = Math.round(maxDim * (4 / 3));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), {
          width,
          height });
  // The canvas union makes getContext return the bitmap-rendering union too;
  // a 2d context is guaranteed here — narrow once for the drawing code below.
  const context = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) return null;

  // Paper look: white page, soft hairline text in ink gray.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#3f3f46";

  const fontSize = Math.max(6, Math.round(maxDim / 16));
  const lineHeight = Math.round(fontSize * 1.55);
  context.font = `500 ${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;

  const padding = Math.round(maxDim / 12);
  const usable = width - padding * 2;
  let y = padding + fontSize;
  for (const line of lines) {
    // Measure + trim to the box, ellipsis on overflow.
    let text2 = line;
    while (text2.length > 1 && context.measureText(text2).width > usable) {
      text2 = text2.slice(0, -1);
    }
    if (text2 !== line && text2.length > 1) text2 = `${text2.slice(0, -1)}…`;
    context.fillText(text2, padding, y);
    y += lineHeight;
    if (y > height - padding) break;
  }

  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
}
