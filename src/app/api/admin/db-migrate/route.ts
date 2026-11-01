import { NextResponse } from "next/server";
import { createClient } from "@libsql/client/web";

import { TURSO_DDL_COUNT, TURSO_DDL_STATEMENTS } from "@/lib/db-turso-ddl";

/**
 * LAUNCH-OPS R44 — Turso schema apply + status (admin-only).
 *
 * Why this exists: the Turso JWT never lives in this sandbox (truncated
 * across sessions), but the REAL token is set in Vercel env. So the one
 * place that can both authenticate to Turso AND apply the Prisma DDL is
 * the production runtime itself. This route is that bootstrap:
 *
 *   GET  /api/admin/db-migrate   → connectivity + table presence report
 *   POST /api/admin/db-migrate   → apply the idempotent DDL (IF NOT EXISTS)
 *
 * Guard: header `x-admin-key` must equal env `DB_MIGRATE_KEY` (a temporary
 * one-time key the owner sets in Vercel before calling, then deletes).
 * Without the key — or when DB_MIGRATE_KEY is unset — the route answers
 * 404 so its very existence is not disclosed.
 *
 * Privacy (PRD §14): only schema metadata is touched. No user data, no
 * file names, no tokens in responses or logs (error text is sanitized).
 */

export const dynamic = "force-dynamic";

const TABLE_NAMES = TURSO_DDL_STATEMENTS.filter((s) =>
  s.toUpperCase().startsWith("CREATE TABLE"),
)
  .map((s) => {
    const m = s.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/i);
    return m ? m[1] : null;
  })
  .filter((n): n is string => n !== null);

/** Constant-ish time string compare (avoids trivial early-exit leaks). */
function keyMatches(provided: string | null): boolean {
  const expected = process.env.DB_MIGRATE_KEY;
  if (!expected || expected.length < 16) return false;
  if (provided === null || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function sanitize(msg: string): string {
  const url = process.env.TURSO_DATABASE_URL ?? "";
  let clean = msg;
  if (url) clean = clean.split(url).join("<turso-url>");
  const token = process.env.TURSO_AUTH_TOKEN ?? "";
  if (token) clean = clean.split(token).join("<turso-token>");
  return clean;
}

function tursoEnvOk(): boolean {
  const url = process.env.TURSO_DATABASE_URL?.trim() ?? "";
  const token = process.env.TURSO_AUTH_TOKEN?.trim() ?? "";
  return url.startsWith("libsql://") && token.length > 20;
}

type LibSqlClient = ReturnType<typeof createClient>;

async function listTables(client: LibSqlClient): Promise<string[]> {
  const rs = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  return rs.rows.map((r) => String(r.name));
}

export async function GET(request: Request) {
  if (!keyMatches(request.headers.get("x-admin-key"))) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  if (!tursoEnvOk()) {
    return NextResponse.json(
      { error: "tursoEnvMissing", connected: false },
      { status: 503 },
    );
  }
  try {
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL!.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
    });
    const tables = await listTables(client);
    const present = TABLE_NAMES.filter((t) => tables.includes(t));
    const missing = TABLE_NAMES.filter((t) => !tables.includes(t));
    return NextResponse.json({
      connected: true,
      totalExpected: TABLE_NAMES.length,
      presentCount: present.length,
      missing,
      ddlStatements: TURSO_DDL_COUNT,
    });
  } catch (err) {
    return NextResponse.json(
      { connected: false, error: sanitize(String(err)) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  if (!keyMatches(request.headers.get("x-admin-key"))) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  if (!tursoEnvOk()) {
    return NextResponse.json(
      { error: "tursoEnvMissing", connected: false },
      { status: 503 },
    );
  }
  try {
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL!.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
    });

    const applied: string[] = [];
    const failed: Array<{ index: number; error: string }> = [];
    for (let i = 0; i < TURSO_DDL_STATEMENTS.length; i += 1) {
      const stmt = TURSO_DDL_STATEMENTS[i];
      try {
        await client.execute(stmt);
        applied.push(`stmt-${i + 1}`);
      } catch (err) {
        // IF NOT EXISTS makes repeats safe; a genuine failure is recorded
        // but does not abort the rest (independent objects).
        failed.push({ index: i + 1, error: sanitize(String(err)) });
      }
    }

    const tables = await listTables(client);
    const present = TABLE_NAMES.filter((t) => tables.includes(t));
    return NextResponse.json({
      connected: true,
      appliedCount: applied.length,
      failed,
      tablesExpected: TABLE_NAMES.length,
      tablesPresent: present.length,
      complete: present.length === TABLE_NAMES.length && failed.length === 0,
    });
  } catch (err) {
    return NextResponse.json(
      { connected: false, error: sanitize(String(err)) },
      { status: 502 },
    );
  }
}
