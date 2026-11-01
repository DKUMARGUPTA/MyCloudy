import { PrismaClient } from '@prisma/client'
// `/web` subpath = pure-HTTP client, no native bindings → serverless-safe
// (Vercel functions) and harmless to import in the local sandbox, where the
// adapter is only constructed when Turso env vars are present.
import { PrismaLibSQL } from '@prisma/adapter-libsql/web'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// DocoPDF privacy rule (PRD §14): never log query payloads — only errors.
// The database stores metadata only; no file names, no file contents.
//
// ── DUAL MODE (LAUNCH-OPS R44) ─────────────────────────────────────────────
// Production (Vercel): TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set in the
// project env → Prisma runs through the official libSQL driver adapter
// (@prisma/adapter-libsql) on the pure-HTTP web client (serverless-safe,
// no native bindings). Vercel's serverless FS is read-only, so classic
// file-SQLite can never persist there — the adapter is what finally makes
// accounts/feedback/contact durable in prod.
//
// Local sandbox (and any env without Turso vars): classic PrismaClient on
// the local SQLite file (DATABASE_URL) — zero behavior change, every
// existing route/smoke keeps working exactly as before.
//
// Both modes are behind the same `db` singleton; routes never know which
// one is active. If Turso is unreachable the routes' existing try/catch
// degrade paths still apply (honest 503 / empty-state fallbacks).

const TURSO_URL = process.env.TURSO_DATABASE_URL?.trim()
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim()

function createDb(): PrismaClient {
  if (TURSO_URL && TURSO_TOKEN && TURSO_URL.startsWith('libsql://')) {
    // Adapter v6.19 API: pass a Config; it creates the HTTP client itself.
    const adapter = new PrismaLibSQL({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
      intMode: 'number',
    })
    return new PrismaClient({
      adapter,
      log: ['error', 'warn'],
    })
  }
  return new PrismaClient({
    log: ['error', 'warn'],
  })
}

export const db = globalForPrisma.prisma ?? createDb()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
