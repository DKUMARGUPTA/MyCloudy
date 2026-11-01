/**
 * Turso/libSQL schema DDL (LAUNCH-OPS R44) — generated from
 * prisma/schema.prisma via `prisma migrate diff --from-empty --script`,
 * then made idempotent (IF NOT EXISTS) so re-running the admin migrate
 * route is always safe.
 *
 * Applied to Turso ONLY through /api/admin/db-migrate (key-gated).
 * Local sandbox keeps using `bun run db:push` against SQLite — the two
 * stores share table/column names exactly (PRD §2.5 mirror).
 */
export const TURSO_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "name" TEXT,
    "passwordHash" TEXT,
    "oauthId" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "role" TEXT NOT NULL DEFAULT 'user',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "bannedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
)`,
  `CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "uaHash" TEXT,
    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "anon_usage" (
    "anonId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("anonId", "toolId", "day")
)`,
  `CREATE TABLE IF NOT EXISTS "usage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sizeBucket" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "message" TEXT,
    "emailOptional" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "tool_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "request_votes" (
    "requestId" TEXT NOT NULL,
    "voterHash" TEXT NOT NULL,

    PRIMARY KEY ("requestId", "voterHash"),
    CONSTRAINT "request_votes_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "tool_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "contact_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "blog_posts" (
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "bodyMd" TEXT NOT NULL,
    "tags" TEXT,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("slug", "locale")
)`,
  `CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubId" TEXT,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "periodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "invoiceNo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "errorCode" TEXT
)`,
  `CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "site_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "bug_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'new',
    "toolId" TEXT,
    "email" TEXT,
    "browserInfo" TEXT,
    "adminNote" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "bug_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email")`,
  `CREATE INDEX IF NOT EXISTS "sessions_userId_idx" ON "sessions"("userId")`,
  `CREATE INDEX IF NOT EXISTS "usage_events_toolId_day_idx" ON "usage_events"("toolId", "day")`,
  `CREATE INDEX IF NOT EXISTS "feedback_toolId_idx" ON "feedback"("toolId")`,
  `CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx" ON "subscriptions"("userId")`,
  `CREATE INDEX IF NOT EXISTS "payments_userId_idx" ON "payments"("userId")`,
  `CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs"("status")`,
  `CREATE INDEX IF NOT EXISTS "bug_reports_status_idx" ON "bug_reports"("status")`,
  `CREATE INDEX IF NOT EXISTS "bug_reports_userId_idx" ON "bug_reports"("userId")`,
] as const;

/** Total DDL statements (tables + indexes). */
export const TURSO_DDL_COUNT = TURSO_DDL_STATEMENTS.length;
