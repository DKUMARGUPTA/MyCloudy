import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { gateAdmin } from "@/lib/api-auth";

/**
 * /api/admin/users/[id] — admin moderation actions on a single user.
 *
 * PATCH  { action: "ban" | "unban" | "role", role? } — ban kicks all the
 *        target's sessions (tokenVersion+1); role change is blocked on the
 *        admin's own account (self-lockout guard).
 * DELETE — soft delete (deletedAt=now + tokenVersion+1). Email is kept for
 *        referential integrity (GDPR-lite); self-delete is blocked here —
 *        that lives at /api/auth/delete behind the account owner's password.
 *
 * Audits: admin.user_ban / admin.user_unban / admin.user_role /
 * admin.user_delete, meta {targetId}.
 */

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    action: z.enum(["ban", "unban", "role"]),
    role: z.enum(["user", "admin"]).optional(),
  })
  .refine((v) => v.action !== "role" || v.role !== undefined, {
    message: "role required for action=role",
  });

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  const { id } = await ctx.params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const target = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { action, role } = parsed.data;

    if (action === "role" && target.id === admin.id) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (action === "ban") {
      await db.user.update({
        where: { id: target.id },
        data: { bannedAt: new Date(), tokenVersion: { increment: 1 } },
      });
      await audit(admin.email, "admin.user_ban", { targetId: target.id });
    } else if (action === "unban") {
      await db.user.update({
        where: { id: target.id },
        data: { bannedAt: null },
      });
      await audit(admin.email, "admin.user_unban", { targetId: target.id });
    } else {
      await db.user.update({
        where: { id: target.id },
        data: { role: role ?? "user" },
      });
      await audit(admin.email, "admin.user_role", {
        targetId: target.id,
        role: role ?? "user",
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/admin/users/[id]] PATCH failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  const { id } = await ctx.params;

  if (id === admin.id) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const target = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    await db.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date(), tokenVersion: { increment: 1 } },
    });

    await audit(admin.email, "admin.user_delete", { targetId: target.id });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/admin/users/[id]] DELETE failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
