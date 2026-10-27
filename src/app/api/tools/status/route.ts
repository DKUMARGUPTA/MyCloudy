import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * GET /api/tools/status — public per-tool enable overrides.
 *
 * Reads SiteSetting "tool_overrides" = `{ [toolId]: { enabled, note? } }`.
 * Missing row / unparseable JSON → `{}` (all tools enabled, no notes).
 * The client merges this over the static 97-tool registry.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const row = await db.siteSetting.findUnique({
      where: { key: "tool_overrides" },
    });
    if (row) {
      const parsed = JSON.parse(row.valueJson) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return NextResponse.json(
          { overrides: parsed },
          { headers: { "cache-control": "no-store" } }
        );
      }
    }
  } catch (err) {
    console.error("[api/tools/status] failed", err);
  }
  return NextResponse.json(
    { overrides: {} },
    { headers: { "cache-control": "no-store" } }
  );
}
