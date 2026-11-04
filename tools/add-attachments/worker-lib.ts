import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Add attachments worker-lib (P3-d) — PURE option resolution,
 * smoke-drivable without a Worker.
 */

export interface AddAttachmentsOptions {
  /** Optional filespec /Desc line ("" = none). */
  description: string;
  /** Flate-pack the embedded copies (default true). */
  compress: boolean;
  /** PDF 2.0 /AFRelationship ("" = omit the key). */
  relationship: string;
}

const RELATIONSHIPS = new Set([
  "Data",
  "Source",
  "Alternative",
  "Supplement",
]);

export function resolveAddOptions(options: OptionValues): AddAttachmentsOptions {
  const description =
    typeof options.description === "string" ? options.description.trim() : "";
  const compress = options.compress !== false;
  const rawRelationship =
    typeof options.relationship === "string" ? options.relationship : "none";
  const relationship = RELATIONSHIPS.has(rawRelationship)
    ? rawRelationship
    : "";
  return { description, compress, relationship };
}
