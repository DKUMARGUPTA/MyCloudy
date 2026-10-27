import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * GET /api/announcements — active site-wide banner announcements.
 *
 * Reads SiteSetting "announcements" = `[{ id, textEn, textHi, variant,
 * until? }]`. Entries with an `until` timestamp in the past (or an
 * unparseable one) are filtered out. Unparseable stored JSON → `[]`.
 */

export const dynamic = "force-dynamic";

interface Announcement {
  id: string;
  textEn: string;
  textHi: string;
  variant: "info" | "success" | "warning";
  until?: string;
}

function sanitize(raw: unknown): Announcement[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out: Announcement[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;
    if (
      typeof a.id !== "string" ||
      !a.id ||
      typeof a.textEn !== "string" ||
      !a.textEn ||
      typeof a.textHi !== "string" ||
      !a.textHi
    ) {
      continue;
    }
    const variant =
      a.variant === "success" || a.variant === "warning" ? a.variant : "info";
    if (typeof a.until === "string" && a.until) {
      const ts = Date.parse(a.until);
      if (!Number.isFinite(ts) || ts < now) continue; // expired / broken
      out.push({ id: a.id, textEn: a.textEn, textHi: a.textHi, variant, until: a.until });
    } else {
      out.push({ id: a.id, textEn: a.textEn, textHi: a.textHi, variant });
    }
  }
  return out;
}

export async function GET() {
  try {
    const row = await db.siteSetting.findUnique({
      where: { key: "announcements" },
    });
    if (row) {
      return NextResponse.json(
        { announcements: sanitize(JSON.parse(row.valueJson)) },
        { headers: { "cache-control": "no-store" } }
      );
    }
  } catch (err) {
    console.error("[api/announcements] failed", err);
  }
  return NextResponse.json(
    { announcements: [] },
    { headers: { "cache-control": "no-store" } }
  );
}
