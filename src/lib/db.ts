import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
}

/**
 * Prisma client factory (R46 — Turso/libSQL production wiring).
 *
 * Two modes, same generated client (driver adapters preview feature):
 *  - Production (Vercel): `TURSO_DATABASE_URL` (libsql://…) +
 *    `TURSO_AUTH_TOKEN` set → PrismaLibSQL adapter (bundled
 *    @libsql/client). Env names follow docs/rules/13-INTEGRATIONS.md §Turso.
 *  - Sandbox (dev/QA): plain PrismaClient on `DATABASE_URL=file:…`
 *    SQLite — zero behavior change, prisma db push keeps working.
 *
 * DocoPDF privacy rule (PRD §14): never log query payloads — only errors.
 * The database stores metadata only; no file names, no file contents.
 */
function createDb(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL ?? "";
  if (tursoUrl.startsWith("libsql:")) {
    return new PrismaClient({
      adapter: new PrismaLibSQL({
        url: tursoUrl,
        authToken: process.env.TURSO_AUTH_TOKEN,
      }),
      log: ["error", "warn"],
    });
  }
  return new PrismaClient({
    log: ["error", "warn"],
  });
}

export const db = globalForPrisma.prisma ?? createDb();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db
