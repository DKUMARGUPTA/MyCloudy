import { zipSync, type Zippable } from "@/lib/own/zip";

/**
 * Result saving helpers (PRD §6.4).
 *
 * - Download: anchor download (user click — never auto-download).
 * - "Save to Files": File System Access API save-picker when available,
 *   otherwise the plain download fallback.
 * - Share: navigator.share({ files }) on mobile; hidden on desktop.
 * - ZIP: fflate (MIT, PRD §2.3) for multi-output tools.
 */

interface SaveFilePicker {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    name: string;
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

/** True when the File System Access API save picker is usable. */
export function canUseSavePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as SaveFilePicker).showSaveFilePicker === "function"
  );
}

/** True when navigator.share can carry files (mobile mostly). */
export function canShareFiles(
  outputs: { name: string; mime: string; blob: Blob }[]
): boolean {
  if (typeof navigator === "undefined" || !navigator.canShare) return false;
  try {
    const files = outputs.map((output) => new File([output.blob], output.name, { type: output.mime }));
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Plain browser download via a temporary anchor (requires a user gesture). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save-as dialog via the File System Access API (falls back to download). */
export async function saveBlobAs(blob: Blob, name: string, mime: string): Promise<"picker" | "download" | "failed"> {
  const picker = (window as unknown as SaveFilePicker).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ accept: { [mime]: [name.split(".").pop() ?? ""] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "picker";
    } catch (error) {
      // AbortError = the user closed the picker; anything else falls back.
      if (error instanceof DOMException && error.name === "AbortError") {
        return "failed";
      }
    }
  }
  downloadBlob(blob, name);
  return "download";
}

/** Web Share sheet with the output files (mobile). */
export async function shareBlobs(
  outputs: { name: string; mime: string; blob: Blob }[]
): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.share) return false;
  try {
    const files = outputs.map(
      (output) => new File([output.blob], output.name, { type: output.mime })
    );
    await navigator.share({ files });
    return true;
  } catch {
    return false;
  }
}

/** Bundles outputs into a single ZIP via fflate. */
export async function zipOutputs(
  outputs: { name: string; blob: Blob }[],
  zipName: string
): Promise<{ blob: Blob; name: string }> {
  const entries: Zippable = {};
  const used = new Set<string>();
  for (const output of outputs) {
    let name = output.name;
    if (used.has(name)) {
      // Collision: -2, -3, … always counting from the ORIGINAL base —
      // never the -2-3 chains the naive retry loop used to produce.
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let counter = 2;
      while (used.has(`${base}-${counter}${ext}`)) counter += 1;
      name = `${base}-${counter}${ext}`;
    }
    used.add(name);
    entries[name] = new Uint8Array(await output.blob.arrayBuffer());
  }
  const zipped = zipSync(entries, { level: 6 });
  return { blob: new Blob([zipped as unknown as BlobPart], { type: "application/zip" }), name: zipName };
}

/**
 * Rename guard (PRD §6.4): block invalid characters, keep the extension.
 */
export function sanitizeFileName(raw: string, extension: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const withExt = cleaned.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? cleaned
    : `${cleaned}.${extension}`;
  return withExt.slice(0, 150);
}
