/**
 * Request signature (RB6-b, 92nd tool — security) — shared types.
 *
 * The whole run is honest on-device: this tool PREPARES a signing pack
 * (numbered sign-here boxes + real /Sig fields + a request note) and hands
 * the user a mail draft — it never sends anything anywhere itself (no
 * server, no upload, no expiring link).
 */

/** One signature spot, placed by the user on the RENDERED page (pdf.js
 * display space: y grows down, top-left origin, /Rotate applied). */
export interface SignatureSpot {
  /** 0-based page index. */
  page: number;
  /** Box CENTER, 0..1 of the displayed page width. */
  x: number;
  /** Box CENTER, 0..1 of the displayed page height. */
  y: number;
}

/** The request form the user fills in step 1. */
export interface RequestDetails {
  recipientName: string;
  senderName: string;
  recipientEmail: string;
  subject: string;
  message: string;
  /** yyyy-mm-dd from the native date picker, or "". */
  dueDate: string;
}

/** The complete parsed run payload the worker consumes. */
export interface RequestPackRun {
  locale: "en" | "hi";
  details: RequestDetails;
  spots: SignatureSpot[];
  /** Localized note/box labels (reqsig.* keys, surface-rendered via t()). */
  labels: Record<string, string>;
}
