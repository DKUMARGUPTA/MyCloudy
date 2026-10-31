/**
 * Turso schema initializer (R46) — applies the Prisma-generated DDL to the
 * production Turso/libSQL database. Idempotent-ish: run on an EMPTY db.
 *
 * Usage (env vars never committed):
 *   TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… \
 *     bun scripts/turso-init.ts /tmp/turso-init.sql
 *
 * DDL source:
 *   bunx prisma migrate diff --from-empty \
 *     --to-schema-datamodel prisma/schema.prisma --script \
 *     --output /tmp/turso-init.sql
 *
 * Why not `prisma db push`: driver-adapter clients cannot push remotely;
 * the documented Prisma+Turso flow is diff-to-SQL then apply (turso shell
 * or @libsql/client — we use the latter, already a dependency).
 */

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL ?? "";
const token = process.env.TURSO_AUTH_TOKEN ?? "";
const sqlPath = process.argv[2] ?? "/tmp/turso-init.sql";

if (!url.startsWith("libsql:")) {
  console.error("✗ TURSO_DATABASE_URL (libsql://…) is required");
  process.exit(1);
}
if (!token) {
  console.error("✗ TURSO_AUTH_TOKEN is required");
  process.exit(1);
}

const sql = await Bun.file(sqlPath).text();

const client = createClient({ url, authToken: token });

/* Idempotent: if the core tables already exist, skip DDL and verify only. */
const existing = await client.execute(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','anon_usage','page_views','site_settings','audit_log')"
);
const already = Number(existing.rows[0]?.n ?? 0);
if (already >= 5) {
  console.log(`→ ${already} core tables already present — skipping DDL (idempotent re-run)`);
} else {
  console.log(`→ applying DDL (${sql.split(";").filter((s) => s.trim()).length} statements) from ${sqlPath}…`);
  try {
    await client.executeMultiple(sql);
  } catch (err) {
    console.error("✗ DDL apply failed:", err);
    process.exit(1);
  }
}

/* Verify: count tables + show the ones we care about. */
const tables = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
);
console.log(`✓ tables created: ${tables.rows.length}`);
for (const row of tables.rows) {
  console.log("  -", String(row.name));
}

/* Smoke query per critical table (catches schema drift instantly).
 * Names are the @@map'd snake_case ones (PRD §2.5 / 05-DATA-RELATIONS). */
for (const t of ["users", "anon_usage", "usage_events", "page_views", "site_settings", "audit_log"]) {
  try {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM "${t}"`);
    console.log(`✓ ${t}: ${r.rows[0]?.n ?? 0} rows`);
  } catch (err) {
    console.error(`✗ ${t} unreadable:`, err);
    process.exit(1);
  }
}
console.log("✓ Turso init complete — schema live, DB reachable.");
