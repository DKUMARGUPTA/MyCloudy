import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { gateAdmin } from "@/lib/api-auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { ensureChartSeeded } from "@/lib/accounting/chart";
import { postEntry, PostingError } from "@/lib/accounting/post";

/**
 * GET  /api/admin/accounting/journal?limit=&offset= — paginated journal
 *       with its lines (newest first).
 * POST /api/admin/accounting/journal — create a MANUAL double-entry
 *       (expenses, owner's capital, adjustments). The posting engine
 *       enforces balance; malformed bodies answer 400 with the reason.
 */

export const dynamic = "force-dynamic";

const MAX_PAGE = 50;

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    await ensureChartSeeded();
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 20, 1),
      MAX_PAGE
    );
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    const [total, entries] = await Promise.all([
      db.journalEntry.count(),
      db.journalEntry.findMany({
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
        include: {
          lines: {
            include: { account: { select: { code: true, name: true } } },
            orderBy: { debit: "desc" },
          },
        },
      }),
    ]);

    return NextResponse.json({
      total,
      entries: entries.map((entry) => ({
        id: entry.id,
        entryNo: entry.entryNo,
        date: entry.date.toISOString(),
        memo: entry.memo,
        source: entry.source,
        sourceRef: entry.sourceRef,
        createdBy: entry.createdBy,
        lines: entry.lines.map((line) => ({
          code: line.account.code,
          name: line.account.name,
          debit: line.debit,
          credit: line.credit,
          memo: line.memo,
        })),
      })),
    });
  } catch (err) {
    console.error("[api/admin/accounting/journal GET] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

const lineSchema = z.object({
  code: z.string().min(1).max(10),
  debit: z.number().int().min(0).max(1_000_000_000).optional(),
  credit: z.number().int().min(0).max(1_000_000_000).optional(),
  memo: z.string().max(200).optional(),
});

const bodySchema = z.object({
  date: z.string().min(8).max(40),
  memo: z.string().min(1).max(300),
  lines: z.array(lineSchema).min(2).max(30),
});

export async function POST(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  const limit = rateLimit(`acct-journal:${clientIp(request)}`, 20, 10 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } }
    );
  }

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
    await ensureChartSeeded();
    const date = new Date(parsed.data.date);
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const entry = await postEntry({
      date,
      memo: parsed.data.memo,
      source: "manual",
      createdBy: admin.email,
      lines: parsed.data.lines,
    });

    await audit(admin.email, "accounting.manual_entry", {
      entryNo: entry.entryNo,
      memo: entry.memo,
    });

    return NextResponse.json({ ok: true, entryNo: entry.entryNo });
  } catch (err) {
    if (err instanceof PostingError) {
      return NextResponse.json(
        { error: "unbalanced", message: err.message },
        { status: 400 }
      );
    }
    console.error("[api/admin/accounting/journal POST] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
