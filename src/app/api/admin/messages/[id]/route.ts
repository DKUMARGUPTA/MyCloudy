import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit, getAdminUser } from "@/lib/auth";

/**
 * PATCH /api/admin/messages/[id] — mark a contact message (new | read |
 * done). Audit: "admin.message_update". Returns the updated message.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["new", "read", "done"]),
});

function toMessage(m: {
  id: string;
  name: string;
  email: string;
  category: string;
  message: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    category: m.category,
    message: m.message,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
  };
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

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

  try {
    const existing = await db.contactMessage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const updated = await db.contactMessage.update({
      where: { id },
      data: { status: parsed.data.status },
    });

    await audit(admin.email, "admin.message_update", {
      id,
      status: parsed.data.status,
    });

    return NextResponse.json({ message: toMessage(updated) });
  } catch (err) {
    console.error("[api/admin/messages/[id]] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
