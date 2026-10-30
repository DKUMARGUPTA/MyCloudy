import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { gateAdmin } from "@/lib/api-auth";

/**
 * /api/admin/settings — the three single-row JSON site settings.
 *
 * GET → { toolOverrides, announcements, siteFlags } (parsed, sanitized,
 *        never throws — defaults {} / [] / {registrationOpen:true}).
 * PUT → upserts each provided SiteSetting row. Audit: "admin.settings_update"
 *        with meta {keys}. Announcement `until` values are ISO strings.
 */

export const dynamic = "force-dynamic";

const announcementSchema = z.object({
  id: z.string().min(1).max(64),
  textEn: z.string().min(1).max(200),
  textHi: z.string().min(1).max(200),
  variant: z.enum(["info", "success", "warning"]),
  until: z.iso.datetime({ offset: true }).optional(),
});

const bodySchema = z.object({
  toolOverrides: z.record(
    z.string().min(1).max(64),
    z.object({
      enabled: z.boolean(),
      note: z.string().max(200).optional(),
    })
  ),
  announcements: z.array(announcementSchema).max(5),
  siteFlags: z.object({ registrationOpen: z.boolean() }),
});

/* ---------------------------- sanitizers (GET) ---------------------------- */

type Overrides = Record<string, { enabled: boolean; note?: string }>;

function sanitizeOverrides(raw: unknown): Overrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Overrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as { enabled?: unknown; note?: unknown };
    if (typeof v.enabled !== "boolean") continue;
    out[key] =
      typeof v.note === "string" && v.note ? { enabled: v.enabled, note: v.note } : { enabled: v.enabled };
  }
  return out;
}

interface AnnouncementRow {
  id: string;
  textEn: string;
  textHi: string;
  variant: "info" | "success" | "warning";
  until?: string;
}

function sanitizeAnnouncements(raw: unknown): AnnouncementRow[] {
  if (!Array.isArray(raw)) return [];
  const out: AnnouncementRow[] = [];
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
    const until = typeof a.until === "string" && a.until ? a.until : undefined;
    out.push(
      until !== undefined
        ? { id: a.id, textEn: a.textEn, textHi: a.textHi, variant, until }
        : { id: a.id, textEn: a.textEn, textHi: a.textHi, variant }
    );
  }
  return out;
}

function sanitizeSiteFlags(raw: unknown): { registrationOpen: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { registrationOpen: true };
  }
  const open = (raw as { registrationOpen?: unknown }).registrationOpen;
  return { registrationOpen: typeof open === "boolean" ? open : true };
}

async function readSetting(key: string): Promise<unknown> {
  const row = await db.siteSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.valueJson) as unknown;
  } catch {
    return null;
  }
}

/* -------------------------------- handlers -------------------------------- */

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  try {
    const [overridesRaw, announcementsRaw, flagsRaw] = await Promise.all([
      readSetting("tool_overrides"),
      readSetting("announcements"),
      readSetting("site_flags"),
    ]);
    return NextResponse.json({
      toolOverrides: sanitizeOverrides(overridesRaw),
      announcements: sanitizeAnnouncements(announcementsRaw),
      siteFlags: sanitizeSiteFlags(flagsRaw),
    });
  } catch (err) {
    console.error("[api/admin/settings] GET failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { toolOverrides, announcements, siteFlags } = parsed.data;
  const keys: string[] = [];

  try {
    if (toolOverrides !== undefined) {
      await db.siteSetting.upsert({
        where: { key: "tool_overrides" },
        update: { valueJson: JSON.stringify(toolOverrides) },
        create: { key: "tool_overrides", valueJson: JSON.stringify(toolOverrides) },
      });
      keys.push("tool_overrides");
    }
    if (announcements !== undefined) {
      await db.siteSetting.upsert({
        where: { key: "announcements" },
        update: { valueJson: JSON.stringify(announcements) },
        create: { key: "announcements", valueJson: JSON.stringify(announcements) },
      });
      keys.push("announcements");
    }
    if (siteFlags !== undefined) {
      await db.siteSetting.upsert({
        where: { key: "site_flags" },
        update: { valueJson: JSON.stringify(siteFlags) },
        create: { key: "site_flags", valueJson: JSON.stringify(siteFlags) },
      });
      keys.push("site_flags");
    }

    if (keys.length > 0) {
      await audit(admin.email, "admin.settings_update", { keys });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/admin/settings] PUT failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
