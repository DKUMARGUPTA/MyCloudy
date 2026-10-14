/**
 * Scan to PDF — camera plumbing (main thread only).
 *
 * getUserMedia is ONLY ever called from an explicit user click (the
 * "Start camera" / "Switch camera" buttons in the surface) — never on
 * mount, never in an effect. Every stream this module hands out is
 * tracked by the caller and stopped with stopCameraStream() on stop,
 * on unmount and before a restart, so no camera light is ever left on
 * behind a hidden element. Nothing here touches the network — the
 * camera stream and the grabbed frames stay in the page.
 */

export type FacingMode = "environment" | "user";

export type CameraErrorCode = "denied" | "notfound" | "generic";

/**
 * Opens the rear camera ("environment") with document-friendly
 * resolution ideals. `facingMode` is a soft constraint so a desktop
 * with a single front camera still works instead of throwing
 * OverconstrainedError.
 */
export async function openCameraStream(facing: FacingMode): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    // No getUserMedia at all (insecure context / unsupported browser).
    throw new DOMException("getUserMedia is not available", "NotSupportedError");
  }
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
  });
}

/** Stops every track of a stream (idempotent, null-safe). */
export function stopCameraStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Maps a getUserMedia rejection onto the three honest error messages
 * the surface can show:
 * - "denied": NotAllowedError / SecurityError → the user (or the
 *   browser settings) refused the permission.
 * - "notfound": NotFoundError / OverconstrainedError → no usable
 *   camera matched.
 * - anything else (NotReadableError, AbortError, …) → generic.
 */
export function classifyCameraError(error: unknown): CameraErrorCode {
  const name = (error as { name?: string } | null | undefined)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "denied";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError"
  ) {
    return "notfound";
  }
  return "generic";
}

/**
 * Grabs the current video frame at its NATIVE resolution as a JPEG
 * blob (quality 0.95 — the "original" the adjust dialog re-reads; the
 * final page is re-encoded at 0.92 after warp + filter).
 */
export async function grabVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) throw new Error("scan: video not ready");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("scan: no 2d context");
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.95)
  );
  if (!blob) throw new Error("scan: frame encode failed");
  return blob;
}

/** Video input count — powers the "Switch camera" affordance. */
export async function countVideoInputs(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput").length;
  } catch {
    return 0;
  }
}
